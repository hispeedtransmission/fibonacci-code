"""The async client: one public class over two very different wire protocols.

:class:`Fibonacci` is constructed through named constructors rather than a
polymorphic ``__init__``, because the two backends need genuinely different
inputs and a single constructor would be a pile of mutually exclusive
arguments:

* :meth:`Fibonacci.from_codex` — a ChatGPT/Codex subscription, speaking the
  OpenAI *Responses* protocol at ``chatgpt.com/backend-api/codex``.
* :meth:`Fibonacci.from_openai` — any OpenAI-compatible ``/chat/completions``
  endpoint: api.openai.com, a proxy, or a local llama.cpp/Ollama/vLLM server.

Both yield the same :class:`~fibonacci.models.StreamEvent` types, so consumer
code does not branch on backend.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Mapping, Optional, Sequence, Tuple

import httpx

from ._version import __version__
from .auth import Auth, resolve_auth
from .errors import AuthError, FibonacciError, NetworkError, ProviderError
from .models import (
    Completed,
    InputItem,
    Message,
    ModelInfo,
    ReasoningDelta,
    ResponseStarted,
    StreamEventT,
    TextDelta,
    Tool,
    ToolCall,
    ToolCallEvent,
    Usage,
    to_wire_items,
)
from .sse import iter_sse

__all__ = [
    "CHATGPT_MODEL",
    "CODEX_RESPONSES_URL",
    "DEFAULT_INSTRUCTIONS",
    "DEFAULT_OPENAI_BASE_URL",
    "Fibonacci",
]

#: The only model a ChatGPT account may drive through the Codex endpoint.
#: Every other Codex-family model id returns HTTP 400 for subscription auth,
#: so this is a hard constraint of the backend rather than a default we chose.
CHATGPT_MODEL = "gpt-5.6-sol"

CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"

DEFAULT_INSTRUCTIONS = (
    "You are Fibonacci, a precise coding assistant. Answer directly and keep "
    "explanations proportional to the question."
)

_UNSUPPORTED_MODEL_MARKER = "not supported when using Codex with a ChatGPT account"

# Reasoning models routinely think for minutes before the first token, so the
# read timeout has to be generous; a connect timeout stays short because a
# refused connection should fail fast.
_DEFAULT_TIMEOUT = httpx.Timeout(600.0, connect=15.0)

_MAX_ERROR_BODY = 2000


@dataclass
class _Request:
    """Everything one turn needs, normalised before it reaches a backend."""

    model: str
    items: List[Dict[str, Any]]
    instructions: Optional[str] = None
    tools: Sequence[Tool] = ()
    reasoning_effort: Optional[str] = None
    temperature: Optional[float] = None
    max_output_tokens: Optional[int] = None


class _Backend:
    """Protocol adapter. One per wire format."""

    name: str = "unknown"
    responses_protocol: bool = False

    def __init__(self, http: httpx.AsyncClient, auth: Auth) -> None:
        self._http = http
        self._auth = auth

    def stream(self, request: _Request) -> AsyncIterator[StreamEventT]:
        raise NotImplementedError

    async def models(self) -> List[ModelInfo]:
        raise NotImplementedError

    async def _base_headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"fibonacci-python/{__version__}",
        }
        headers.update(await self._auth.headers())
        return headers


class CodexBackend(_Backend):
    """ChatGPT-subscription backend speaking the Responses protocol."""

    name = "codex"
    responses_protocol = True

    async def stream(self, request: _Request) -> AsyncIterator[StreamEventT]:
        body: Dict[str, Any] = {
            "model": request.model,
            "instructions": request.instructions or DEFAULT_INSTRUCTIONS,
            "input": request.items,
            "tools": [tool.to_responses_tool() for tool in request.tools],
            "tool_choice": "auto",
            # One tool at a time: an agent loop that has to reconcile two
            # concurrent edits to the same file is a correctness problem, not a
            # throughput win.
            "parallel_tool_calls": False,
            # Mandatory for this endpoint. Server-side conversation storage is
            # not available to subscription auth and requesting it fails.
            "store": False,
            "stream": True,
            # Without this the model's reasoning is dropped between turns and
            # every tool round-trip restarts its chain of thought.
            "include": ["reasoning.encrypted_content"],
        }
        if request.reasoning_effort:
            body["reasoning"] = {"effort": request.reasoning_effort, "summary": "auto"}
        if request.max_output_tokens is not None:
            body["max_output_tokens"] = request.max_output_tokens

        headers = await self._base_headers()
        headers["Accept"] = "text/event-stream"
        headers["OpenAI-Beta"] = "responses=experimental"
        # `originator` is unvalidated by the server. We identify honestly as
        # this client rather than impersonating the official Codex CLI.
        headers["originator"] = "fibonacci"
        headers["session_id"] = str(uuid.uuid4())

        items: List[Dict[str, Any]] = []
        usage = Usage()

        try:
            async with self._http.stream(
                "POST", CODEX_RESPONSES_URL, json=body, headers=headers
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise self._http_error(response, request.model)

                async for frame in iter_sse(response.aiter_bytes()):
                    if frame.data == "[DONE]":
                        break
                    payload = _try_json(frame.data)
                    if payload is None:
                        continue
                    kind = payload.get("type") or frame.event

                    if kind == "response.created":
                        yield ResponseStarted((payload.get("response") or {}).get("id"))
                    elif kind == "response.output_text.delta":
                        delta = payload.get("delta")
                        if delta:
                            yield TextDelta(str(delta))
                    elif kind == "response.reasoning_summary_text.delta":
                        delta = payload.get("delta")
                        if delta:
                            yield ReasoningDelta(str(delta))
                    elif kind == "response.output_item.done":
                        item = payload.get("item")
                        if isinstance(item, dict):
                            items.append(item)
                            call = _tool_call_from_responses_item(item)
                            if call is not None:
                                yield ToolCallEvent(call)
                    elif kind == "response.completed":
                        usage = Usage.from_responses((payload.get("response") or {}).get("usage"))
                        break
                    elif kind in ("response.failed", "error"):
                        raise _failure_error(payload)
                    elif kind == "response.incomplete":
                        raise _incomplete_error(payload)
        except httpx.HTTPError as exc:
            raise NetworkError(f"Request to {CODEX_RESPONSES_URL} failed: {exc}") from exc

        # Always emit a terminal event, even if the stream ended early. A
        # consumer that waits for Completed should never hang because a proxy
        # closed the connection without a final frame.
        _ = saw_terminal
        yield Completed(usage=usage, items=tuple(items))

    async def models(self) -> List[ModelInfo]:
        """Report the single model this backend accepts.

        The subscription endpoint exposes no ``/models`` route, and the
        supported set is exactly one id — so returning it directly is both
        accurate and cheaper than a request that would 404.
        """
        return [ModelInfo(id=CHATGPT_MODEL, owned_by="openai")]

    def _http_error(self, response: httpx.Response, model: str) -> FibonacciError:
        payload = _try_json(response.text)
        detail = payload.get("detail") if isinstance(payload, dict) else None
        status = response.status_code

        if status == 400 and isinstance(detail, str) and _UNSUPPORTED_MODEL_MARKER in detail:
            return ProviderError(
                f"Model {model!r} is not available to a ChatGPT account. "
                f"The Codex subscription endpoint accepts only {CHATGPT_MODEL!r} — "
                f"pass model={CHATGPT_MODEL!r}, or use "
                "Fibonacci.from_openai(base_url=..., api_key=...) with an API key "
                "to reach the full model list.",
                status=status,
                code="model_not_supported",
                body=payload,
            )
        if status in (401, 403):
            return AuthError(
                f"The ChatGPT endpoint rejected these credentials (HTTP {status}). "
                "Run `codex login` to sign in again."
            )
        if status == 429:
            return ProviderError(
                "Rate limited or out of subscription quota (HTTP 429). "
                "Wait and retry, or switch to an API-key endpoint with "
                "Fibonacci.from_openai(...).",
                status=status,
                body=payload,
            )
        return ProviderError(
            _describe(payload, response.text),
            status=status,
            body=payload if payload is not None else response.text[:_MAX_ERROR_BODY],
        )


class OpenAIBackend(_Backend):
    """Backend for any server implementing OpenAI ``/chat/completions``."""

    name = "openai"
    responses_protocol = False

    def __init__(self, http: httpx.AsyncClient, auth: Auth, base_url: str) -> None:
        super().__init__(http, auth)
        self.base_url = base_url.rstrip("/")

    async def stream(self, request: _Request) -> AsyncIterator[StreamEventT]:
        messages: List[Dict[str, Any]] = []
        if request.instructions:
            messages.append({"role": "system", "content": request.instructions})
        messages.extend(request.items)

        body: Dict[str, Any] = {
            "model": request.model,
            "messages": messages,
            "stream": True,
        }
        if request.tools:
            body["tools"] = [tool.to_chat_tool() for tool in request.tools]
            body["tool_choice"] = "auto"
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            body["max_tokens"] = request.max_output_tokens

        headers = await self._base_headers()
        headers["Accept"] = "text/event-stream"

        url = f"{self.base_url}/chat/completions"
        assembler = _ToolCallAssembler()
        text_parts: List[str] = []
        usage = Usage()
        response_id: Optional[str] = None

        try:
            async with self._http.stream("POST", url, json=body, headers=headers) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise self._http_error(response, url)

                async for frame in iter_sse(response.aiter_bytes()):
                    if frame.data == "[DONE]":
                        break
                    payload = _try_json(frame.data)
                    if payload is None:
                        continue
                    if payload.get("error"):
                        raise _failure_error(payload)

                    if response_id is None and payload.get("id"):
                        response_id = str(payload["id"])
                        yield ResponseStarted(response_id)

                    # Some servers send a usage-only final chunk with no choices.
                    if payload.get("usage"):
                        usage = Usage.from_chat(payload["usage"])

                    choices = payload.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}

                    content = delta.get("content")
                    if content:
                        text_parts.append(str(content))
                        yield TextDelta(str(content))

                    # DeepSeek and Qwen-derived servers stream chain-of-thought
                    # in `reasoning_content`; some proxies use `reasoning`.
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                    if reasoning:
                        yield ReasoningDelta(str(reasoning))

                    for fragment in delta.get("tool_calls") or []:
                        assembler.feed(fragment)

                    if choices[0].get("finish_reason"):
                        break
        except httpx.HTTPError as exc:
            raise NetworkError(f"Request to {url} failed: {exc}") from exc

        for call in assembler.finish():
            yield ToolCallEvent(call)

        yield Completed(
            usage=usage,
            items=_chat_assistant_items("".join(text_parts), assembler.calls()),
        )

    async def models(self) -> List[ModelInfo]:
        url = f"{self.base_url}/models"
        try:
            response = await self._http.get(url, headers=await self._base_headers())
        except httpx.HTTPError as exc:
            raise NetworkError(f"Could not list models at {url}: {exc}") from exc
        if response.status_code >= 400:
            raise self._http_error(response, url)

        payload = _try_json(response.text) or {}
        entries = payload.get("data")
        if not isinstance(entries, list):
            raise ProviderError(
                f"{url} did not return an OpenAI-shaped model list.",
                status=response.status_code,
                body=response.text[:_MAX_ERROR_BODY],
            )
        models: List[ModelInfo] = []
        for entry in entries:
            if not isinstance(entry, dict) or not entry.get("id"):
                continue
            created = entry.get("created")
            models.append(
                ModelInfo(
                    id=str(entry["id"]),
                    owned_by=entry.get("owned_by"),
                    created=int(created) if isinstance(created, (int, float)) else None,
                )
            )
        return models

    def _http_error(self, response: httpx.Response, url: str) -> FibonacciError:
        payload = _try_json(response.text)
        status = response.status_code
        if status in (401, 403):
            return AuthError(
                f"{url} rejected the API key (HTTP {status}). "
                "Check FIBONACCI_API_KEY / OPENAI_API_KEY, or pass api_key=... explicitly."
            )
        return ProviderError(
            _describe(payload, response.text),
            status=status,
            body=payload if payload is not None else response.text[:_MAX_ERROR_BODY],
        )


class _ToolCallAssembler:
    """Reassembles Chat Completions tool calls from streamed fragments.

    The wire format is awkward: a tool call arrives as many ``delta.tool_calls``
    fragments correlated only by ``index``. The id and function name usually
    appear in the first fragment and the JSON arguments dribble out across the
    rest — but ``index`` is sometimes absent entirely (single-call servers), and
    some proxies repeat the full name on every fragment instead of sending it
    once.
    """

    def __init__(self) -> None:
        self._slots: Dict[int, Dict[str, str]] = {}
        self._order: List[int] = []

    def feed(self, fragment: Mapping[str, Any]) -> None:
        raw_index = fragment.get("index")
        index = raw_index if isinstance(raw_index, int) else 0
        if index not in self._slots:
            self._slots[index] = {"id": "", "name": "", "arguments": ""}
            self._order.append(index)
        slot = self._slots[index]

        if fragment.get("id"):
            slot["id"] = str(fragment["id"])

        function = fragment.get("function") or {}
        name = function.get("name")
        # Append genuine name chunks, but ignore a fragment that merely repeats
        # what we already have — otherwise a proxy that echoes the name on
        # every fragment produces "get_weatherget_weatherget_weather".
        if name and name != slot["name"]:
            slot["name"] += str(name)
        arguments = function.get("arguments")
        if arguments:
            slot["arguments"] += str(arguments)

    def calls(self) -> List[ToolCall]:
        calls: List[ToolCall] = []
        for position, index in enumerate(self._order):
            slot = self._slots[index]
            if not slot["name"]:
                continue
            calls.append(
                ToolCall(
                    # A server that omits the id still needs a stable handle to
                    # correlate the result on the next turn.
                    call_id=slot["id"] or f"call_{position}",
                    name=slot["name"],
                    arguments=slot["arguments"],
                )
            )
        return calls

    def finish(self) -> List[ToolCall]:
        return self.calls()


class Fibonacci:
    """Async client for streaming completions from a model backend.

    Use it as an async context manager so the underlying connection pool is
    closed deterministically::

        async with Fibonacci.from_codex() as fib:
            print(await fib.complete("Explain a Merkle tree in one sentence."))

    Instances are safe to share across concurrent tasks: httpx pools
    connections, and credential refresh is serialised by a lock.
    """

    def __init__(
        self,
        backend: _Backend,
        *,
        http: httpx.AsyncClient,
        auth: Auth,
        model: Optional[str],
        instructions: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        owns_http: bool = True,
    ) -> None:
        self._backend = backend
        self._http = http
        self._auth = auth
        self._owns_http = owns_http
        self.model = model
        self.instructions = instructions
        self.reasoning_effort = reasoning_effort
        self._closed = False

    # -- construction --------------------------------------------------------

    @classmethod
    def from_codex(
        cls,
        *,
        model: str = CHATGPT_MODEL,
        codex_home: Optional[str] = None,
        instructions: Optional[str] = None,
        reasoning_effort: str = "medium",
        http_client: Optional[httpx.AsyncClient] = None,
        timeout: Optional[httpx.Timeout] = None,
    ) -> "Fibonacci":
        """Build a client backed by an existing ChatGPT/Codex subscription.

        Credentials are read through to the Codex CLI's own ``auth.json`` on
        every request — see :mod:`fibonacci.auth` for why this SDK never keeps
        its own copy.

        :param model: Left configurable for forward compatibility, but a
            ChatGPT account currently only accepts :data:`CHATGPT_MODEL`;
            anything else produces an explanatory :class:`ProviderError`.
        :param reasoning_effort: ``low``, ``medium``, ``high``, or ``xhigh``.
        """
        http = http_client or httpx.AsyncClient(timeout=timeout or _DEFAULT_TIMEOUT)
        auth = resolve_auth(codex_home=codex_home, http=http)
        return cls(
            CodexBackend(http, auth),
            http=http,
            auth=auth,
            model=model,
            instructions=instructions,
            reasoning_effort=reasoning_effort,
            owns_http=http_client is None,
        )

    @classmethod
    def from_openai(
        cls,
        *,
        base_url: str = DEFAULT_OPENAI_BASE_URL,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        timeout: Optional[httpx.Timeout] = None,
    ) -> "Fibonacci":
        """Build a client for any OpenAI-compatible ``/chat/completions`` server.

        :param base_url: Root that ``/chat/completions`` and ``/models`` hang
            off, e.g. ``https://api.openai.com/v1`` or
            ``http://localhost:11434/v1``.
        :param api_key: Falls back to ``$FIBONACCI_API_KEY`` then
            ``$OPENAI_API_KEY``. A loopback ``base_url`` needs no key at all.
        :param model: Required before streaming, but optional here so that
            :meth:`models` can be called to discover what the endpoint offers.
        """
        http = http_client or httpx.AsyncClient(timeout=timeout or _DEFAULT_TIMEOUT)
        auth = resolve_auth(base_url=base_url, api_key=api_key, http=http)
        return cls(
            OpenAIBackend(http, auth, base_url),
            http=http,
            auth=auth,
            model=model,
            instructions=instructions,
            owns_http=http_client is None,
        )

    # -- inference -----------------------------------------------------------

    async def stream(
        self,
        prompt: Optional[str] = None,
        *,
        items: Optional[Sequence[InputItem]] = None,
        tools: Sequence[Tool] = (),
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        temperature: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
    ) -> AsyncIterator[StreamEventT]:
        """Stream one turn, yielding :class:`~fibonacci.models.StreamEvent` objects.

        ``items`` carries prior conversation state — SDK objects, or provider
        items echoed back verbatim from a previous :class:`Completed`. When
        both ``items`` and ``prompt`` are given, the prompt is appended as the
        final user message, which is the shape a tool loop wants.

        The iterator always ends with exactly one :class:`Completed` event,
        even if the connection closed without a terminal frame.
        """
        chosen_model = model or self.model
        if not chosen_model:
            raise FibonacciError(
                "No model selected. Pass model=... to stream() or to the constructor; "
                "call `await client.models()` to see what this endpoint offers."
            )
        if prompt is None and not items:
            raise ValueError("stream() needs either a prompt or items.")

        combined: List[InputItem] = list(items or [])
        if prompt is not None:
            combined.append(Message(role="user", content=prompt))

        request = _Request(
            model=chosen_model,
            items=to_wire_items(combined, responses=self._backend.responses_protocol),
            instructions=instructions if instructions is not None else self.instructions,
            tools=tools,
            reasoning_effort=(
                reasoning_effort if reasoning_effort is not None else self.reasoning_effort
            ),
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        async for event in self._backend.stream(request):
            yield event

    async def complete(
        self,
        prompt: Optional[str] = None,
        *,
        items: Optional[Sequence[InputItem]] = None,
        tools: Sequence[Tool] = (),
        model: Optional[str] = None,
        instructions: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        temperature: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
    ) -> str:
        """Run one turn and return the assistant's text.

        Reasoning summaries are excluded: they are the model's scratch work,
        not its answer, and callers who want them should use :meth:`stream`.
        """
        parts: List[str] = []
        async for event in self.stream(
            prompt,
            items=items,
            tools=tools,
            model=model,
            instructions=instructions,
            reasoning_effort=reasoning_effort,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        ):
            if isinstance(event, TextDelta):
                parts.append(event.text)
        return "".join(parts)

    async def models(self) -> List[ModelInfo]:
        """List the models this backend will accept."""
        return await self._backend.models()

    # -- lifecycle -----------------------------------------------------------

    async def aclose(self) -> None:
        """Close owned resources. Idempotent.

        An injected ``http_client`` is left open: whoever created it owns it.
        """
        if self._closed:
            return
        self._closed = True
        await self._auth.aclose()
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> "Fibonacci":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    def __repr__(self) -> str:
        return f"Fibonacci(backend={self._backend.name!r}, model={self.model!r}, auth={self._auth!r})"


# -- module helpers ----------------------------------------------------------


def _try_json(text: str) -> Optional[Dict[str, Any]]:
    """Parse a JSON object, returning ``None`` for anything else.

    Streams carry keep-alive comments, ``[DONE]`` sentinels, and occasional
    non-object frames from proxies. None of those should abort a response that
    is otherwise working, so unparseable frames are skipped rather than raised.
    """
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _tool_call_from_responses_item(item: Mapping[str, Any]) -> Optional[ToolCall]:
    if item.get("type") != "function_call":
        return None
    return ToolCall(
        call_id=str(item.get("call_id") or item.get("id") or ""),
        name=str(item.get("name") or ""),
        arguments=str(item.get("arguments") or ""),
        raw=item,
    )


def _chat_assistant_items(text: str, calls: Sequence[ToolCall]) -> Tuple[Dict[str, Any], ...]:
    """Build the assistant message to append to the next Chat Completions turn."""
    if not text and not calls:
        return ()
    item: Dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:
        item["tool_calls"] = [call.to_chat_tool_call() for call in calls]
    return (item,)


def _failure_error(payload: Mapping[str, Any]) -> ProviderError:
    """Build an error from an in-stream failure frame."""
    source = payload.get("response") if isinstance(payload.get("response"), dict) else payload
    error = source.get("error") if isinstance(source, dict) else None
    if isinstance(error, Mapping):
        message = str(error.get("message") or "The provider reported a failed response.")
        code = error.get("code")
        return ProviderError(message, code=str(code) if code else None, body=payload)
    return ProviderError("The provider reported a failed response.", body=payload)


def _incomplete_error(payload: Mapping[str, Any]) -> ProviderError:
    response = payload.get("response") or {}
    details = response.get("incomplete_details") or {}
    reason = details.get("reason") or "unknown"
    return ProviderError(
        f"The response stopped before finishing (reason: {reason}). "
        "Raise max_output_tokens or shorten the input.",
        code=str(reason),
        body=payload,
    )


def _describe(payload: Optional[Mapping[str, Any]], fallback: str) -> str:
    """Extract the most human-readable message an error body offers."""
    if isinstance(payload, Mapping):
        error = payload.get("error")
        if isinstance(error, Mapping) and error.get("message"):
            return str(error["message"])
        for key in ("detail", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
    text = fallback.strip()
    return text[:_MAX_ERROR_BODY] if text else "The provider returned an error with no message."
