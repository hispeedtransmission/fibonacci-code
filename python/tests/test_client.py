"""Tests for both backends, driven entirely through a mock transport."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest

from fibonacci import (
    CHATGPT_MODEL,
    AuthError,
    Completed,
    Fibonacci,
    FibonacciError,
    ProviderError,
    ReasoningDelta,
    ResponseStarted,
    TextDelta,
    Tool,
    ToolCallEvent,
)

from .conftest import ACCOUNT_ID, chat_body, mock_client, sse_body, write_auth_json

USAGE_PAYLOAD = {
    "input_tokens": 14,
    "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 0},
    "output_tokens": 5,
    "output_tokens_details": {"reasoning_tokens": 0},
    "total_tokens": 19,
}

TEXT_FRAMES = [
    ("response.created", {"type": "response.created", "response": {"id": "resp_1"}}),
    ("response.in_progress", {"type": "response.in_progress"}),
    ("response.output_text.delta", {"type": "response.output_text.delta", "delta": "Hello"}),
    ("response.output_text.delta", {"type": "response.output_text.delta", "delta": ", world"}),
    (
        "response.output_item.done",
        {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Hello, world"}],
            },
        },
    ),
    ("response.completed", {"type": "response.completed", "response": {"usage": USAGE_PAYLOAD}}),
]


def sse_response(frames: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status, content=sse_body(frames), headers={"content-type": "text/event-stream"}
    )


# -- Codex / Responses backend -----------------------------------------------


async def test_codex_stream_sends_the_verified_request_shape(tmp_path: Path) -> None:
    """Pins every field the endpoint requires. `store: false` and the
    `include` list are mandatory; `originator` identifies us honestly rather
    than impersonating the official Codex CLI."""
    write_auth_json(tmp_path)
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(TEXT_FRAMES)

    async with mock_client(handler, requests=captured) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            events = [event async for event in fib.stream("hi")]

    request = captured[0]
    assert str(request.url) == "https://chatgpt.com/backend-api/codex/responses"

    body = json.loads(request.content)
    assert body["model"] == CHATGPT_MODEL
    assert body["store"] is False
    assert body["stream"] is True
    assert body["parallel_tool_calls"] is False
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["reasoning"] == {"effort": "medium", "summary": "auto"}
    assert body["input"] == [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}
    ]

    assert request.headers["authorization"].startswith("Bearer ey")
    assert request.headers["chatgpt-account-id"] == ACCOUNT_ID
    assert request.headers["accept"] == "text/event-stream"
    assert request.headers["openai-beta"] == "responses=experimental"
    assert request.headers["originator"] == "fibonacci"
    assert len(request.headers["session_id"]) == 36

    assert isinstance(events[0], ResponseStarted)
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["Hello", ", world"]

    completed = events[-1]
    assert isinstance(completed, Completed)
    assert completed.usage.input_tokens == 14
    assert completed.usage.total_tokens == 19
    assert completed.items[0]["type"] == "message"


async def test_codex_reasoning_summary_becomes_a_reasoning_event(tmp_path: Path) -> None:
    write_auth_json(tmp_path)
    frames = [
        (
            "response.reasoning_summary_text.delta",
            {"type": "response.reasoning_summary_text.delta", "delta": "thinking..."},
        ),
        ("response.completed", {"type": "response.completed", "response": {}}),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(frames)

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            events = [event async for event in fib.stream("hi")]

    assert [e.text for e in events if isinstance(e, ReasoningDelta)] == ["thinking..."]


async def test_codex_tool_call_is_emitted_and_echoable(tmp_path: Path) -> None:
    """The raw item must survive the round trip: re-serialising it would drop
    fields the API expects to see again."""
    write_auth_json(tmp_path)
    raw_item = {
        "type": "function_call",
        "id": "fc_1",
        "call_id": "call_abc",
        "name": "read_file",
        "arguments": '{"path": "main.py"}',
    }
    frames = [
        ("response.output_item.done", {"type": "response.output_item.done", "item": raw_item}),
        ("response.completed", {"type": "response.completed", "response": {}}),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(frames)

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            events = [
                event
                async for event in fib.stream("read main.py", tools=[Tool("read_file", "read")])
            ]

    calls = [e.call for e in events if isinstance(e, ToolCallEvent)]
    assert len(calls) == 1
    assert calls[0].name == "read_file"
    assert calls[0].call_id == "call_abc"
    assert calls[0].to_responses_item() == raw_item

    completed = events[-1]
    assert isinstance(completed, Completed)
    assert completed.items == (raw_item,)


async def test_codex_declares_tools_in_the_flattened_shape(tmp_path: Path) -> None:
    write_auth_json(tmp_path)
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response([("response.completed", {"type": "response.completed"})])

    async with mock_client(handler, requests=captured) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            tool = Tool("grep", "search files", {"type": "object", "properties": {}})
            [event async for event in fib.stream("x", tools=[tool])]

    tools = json.loads(captured[0].content)["tools"]
    assert tools == [
        {
            "type": "function",
            "name": "grep",
            "description": "search files",
            "parameters": {"type": "object", "properties": {}},
            "strict": False,
        }
    ]


async def test_unsupported_model_error_names_the_one_that_works(tmp_path: Path) -> None:
    """The single most likely failure for a new user: a ChatGPT account may
    only drive gpt-5.6-sol, and the raw 400 does not say what to use instead."""
    write_auth_json(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "detail": "The 'gpt-5.2-codex' model is not supported when using "
                "Codex with a ChatGPT account."
            },
        )

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(
            codex_home=str(tmp_path), model="gpt-5.2-codex", http_client=http
        ) as fib:
            with pytest.raises(ProviderError) as excinfo:
                [event async for event in fib.stream("hi")]

    message = str(excinfo.value)
    assert "gpt-5.2-codex" in message
    assert CHATGPT_MODEL in message
    assert "from_openai" in message
    assert excinfo.value.status == 400
    assert excinfo.value.code == "model_not_supported"


async def test_codex_401_is_an_auth_error(tmp_path: Path) -> None:
    write_auth_json(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "unauthorized"})

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            with pytest.raises(AuthError, match="codex login"):
                [event async for event in fib.stream("hi")]


async def test_codex_429_points_at_the_alternative(tmp_path: Path) -> None:
    write_auth_json(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"detail": "too many requests"})

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            with pytest.raises(ProviderError, match="quota"):
                [event async for event in fib.stream("hi")]


async def test_in_stream_failure_raises_with_the_provider_message(tmp_path: Path) -> None:
    """A 200 response can still fail; the error arrives as an SSE frame."""
    write_auth_json(tmp_path)
    frames = [
        (
            "response.failed",
            {
                "type": "response.failed",
                "response": {"error": {"code": "server_error", "message": "upstream exploded"}},
            },
        )
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(frames)

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            with pytest.raises(ProviderError, match="upstream exploded"):
                [event async for event in fib.stream("hi")]


async def test_truncated_stream_still_ends_with_completed(tmp_path: Path) -> None:
    """A proxy closing the connection early must not hang a consumer that is
    waiting for a terminal event."""
    write_auth_json(tmp_path)
    frames = [("response.output_text.delta", {"type": "response.output_text.delta", "delta": "x"})]

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(frames)

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            events = [event async for event in fib.stream("hi")]

    assert isinstance(events[-1], Completed)


async def test_codex_models_reports_the_single_supported_id(tmp_path: Path) -> None:
    write_auth_json(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the subscription endpoint has no /models route")

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            models = await fib.models()

    assert [m.id for m in models] == [CHATGPT_MODEL]


async def test_complete_returns_only_assistant_text(tmp_path: Path) -> None:
    write_auth_json(tmp_path)
    frames = [
        (
            "response.reasoning_summary_text.delta",
            {"type": "response.reasoning_summary_text.delta", "delta": "SCRATCH"},
        ),
        ("response.output_text.delta", {"type": "response.output_text.delta", "delta": "PYTHON"}),
        ("response.output_text.delta", {"type": "response.output_text.delta", "delta": "-OK"}),
        ("response.completed", {"type": "response.completed", "response": {}}),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(frames)

    async with mock_client(handler) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            assert await fib.complete("say it") == "PYTHON-OK"


async def test_prior_items_are_echoed_back_untouched(tmp_path: Path) -> None:
    """Raw provider items pass through so a tool loop can hand `Completed.items`
    straight back in."""
    write_auth_json(tmp_path)
    reasoning_item = {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque"}
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response([("response.completed", {"type": "response.completed"})])

    async with mock_client(handler, requests=captured) as http:
        async with Fibonacci.from_codex(codex_home=str(tmp_path), http_client=http) as fib:
            [event async for event in fib.stream("next", items=[reasoning_item])]

    body = json.loads(captured[0].content)
    assert body["input"][0] == reasoning_item
    assert body["input"][1]["content"][0]["text"] == "next"


# -- OpenAI-compatible backend -----------------------------------------------


def openai_client(handler: Any, requests: Any = None) -> httpx.AsyncClient:
    return mock_client(handler, requests=requests)


async def test_openai_streams_text_and_usage_from_a_trailing_chunk() -> None:
    """Some servers send usage in a chunk *after* the one carrying
    finish_reason, so the parser must not stop at finish_reason."""
    chunks: List[Dict[str, Any]] = [
        {"id": "chatcmpl-1", "choices": [{"index": 0, "delta": {"content": "Hel"}}]},
        {"id": "chatcmpl-1", "choices": [{"index": 0, "delta": {"content": "lo"}}]},
        {"id": "chatcmpl-1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {
            "id": "chatcmpl-1",
            "choices": [],
            "usage": {"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11},
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body(chunks))

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="qwen3:8b", http_client=http
        ) as fib:
            events = [event async for event in fib.stream("hi")]

    assert [e.text for e in events if isinstance(e, TextDelta)] == ["Hel", "lo"]
    completed = events[-1]
    assert isinstance(completed, Completed)
    assert completed.usage.total_tokens == 11
    assert completed.items == ({"role": "assistant", "content": "Hello"},)


async def test_openai_assembles_tool_calls_from_fragments() -> None:
    """Name arrives once (or is echoed on every fragment by some proxies) and
    arguments dribble out across many fragments keyed by index."""
    chunks: List[Dict[str, Any]] = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "function": {"name": "get_weather", "arguments": ""},
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "function": {"name": "get_weather", "arguments": '{"ci'}}
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'ty": '}}]}}
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"Oslo"}'}}]}}
            ]
        },
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body(chunks))

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            events = [event async for event in fib.stream("weather?")]

    calls = [e.call for e in events if isinstance(e, ToolCallEvent)]
    assert len(calls) == 1
    # The repeated name must not concatenate into "get_weatherget_weather".
    assert calls[0].name == "get_weather"
    assert calls[0].arguments == '{"city": "Oslo"}'
    assert json.loads(calls[0].arguments) == {"city": "Oslo"}
    assert calls[0].call_id == "call_1"


async def test_openai_tool_call_without_an_index_defaults_to_zero() -> None:
    chunks: List[Dict[str, Any]] = [
        {
            "choices": [
                {"delta": {"tool_calls": [{"function": {"name": "ping", "arguments": "{"}}]}}
            ]
        },
        {"choices": [{"delta": {"tool_calls": [{"function": {"arguments": "}"}}]}}]},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body(chunks))

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            events = [event async for event in fib.stream("ping")]

    calls = [e.call for e in events if isinstance(e, ToolCallEvent)]
    assert len(calls) == 1
    assert calls[0].name == "ping"
    assert calls[0].arguments == "{}"
    # Servers that omit the id still need a stable handle for the result.
    assert calls[0].call_id == "call_0"


async def test_openai_parallel_tool_calls_stay_separate() -> None:
    chunks: List[Dict[str, Any]] = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "a", "function": {"name": "one", "arguments": "{}"}},
                            {"index": 1, "id": "b", "function": {"name": "two", "arguments": "{}"}},
                        ]
                    }
                }
            ]
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body(chunks))

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            events = [event async for event in fib.stream("go")]

    calls = [e.call for e in events if isinstance(e, ToolCallEvent)]
    assert [c.name for c in calls] == ["one", "two"]


async def test_openai_reasoning_content_is_surfaced() -> None:
    """DeepSeek/Qwen-derived servers stream chain-of-thought here."""
    chunks: List[Dict[str, Any]] = [
        {"choices": [{"delta": {"reasoning_content": "let me think"}}]},
        {"choices": [{"delta": {"content": "42"}}]},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body(chunks))

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            events = [event async for event in fib.stream("q")]

    assert [e.text for e in events if isinstance(e, ReasoningDelta)] == ["let me think"]
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["42"]


async def test_openai_sends_system_instructions_as_a_message() -> None:
    captured: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body([]))

    async with openai_client(handler, captured) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1",
            model="local",
            instructions="Be terse.",
            http_client=http,
        ) as fib:
            [event async for event in fib.stream("hi")]

    body = json.loads(captured[0].content)
    assert str(captured[0].url) == "http://localhost:11434/v1/chat/completions"
    assert body["messages"][0] == {"role": "system", "content": "Be terse."}
    assert body["messages"][1] == {"role": "user", "content": "hi"}
    assert body["stream"] is True


async def test_openai_lists_models() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "http://localhost:11434/v1/models"
        return httpx.Response(
            200,
            json={
                "object": "list",
                "data": [
                    {"id": "qwen3:8b", "owned_by": "library", "created": 1700000000},
                    {"id": "llama3:8b"},
                    {"not_a_model": True},
                ],
            },
        )

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", http_client=http
        ) as fib:
            models = await fib.models()

    # Server order is preserved, and the malformed entry is skipped rather
    # than crashing the listing.
    assert [m.id for m in models] == ["qwen3:8b", "llama3:8b"]
    assert models[0].owned_by == "library"
    assert models[0].created == 1700000000
    assert models[1].owned_by is None


async def test_openai_401_is_an_auth_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "Incorrect API key"}})

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="https://api.openai.com/v1",
            api_key="sk-wrong",
            model="gpt-4o-mini",
            http_client=http,
        ) as fib:
            with pytest.raises(AuthError, match="FIBONACCI_API_KEY"):
                [event async for event in fib.stream("hi")]


async def test_openai_error_body_message_is_surfaced() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"error": {"message": "context length exceeded"}})

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            with pytest.raises(ProviderError, match="context length exceeded") as excinfo:
                [event async for event in fib.stream("hi")]
    assert excinfo.value.status == 422


# -- client behaviour --------------------------------------------------------


async def test_streaming_without_a_model_is_actionable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not reach the network")

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", http_client=http
        ) as fib:
            with pytest.raises(FibonacciError, match="No model selected"):
                [event async for event in fib.stream("hi")]


async def test_streaming_with_neither_prompt_nor_items_is_a_value_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not reach the network")

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            with pytest.raises(ValueError):
                [event async for event in fib.stream()]


async def test_injected_http_client_is_not_closed_by_the_sdk() -> None:
    """Whoever created the client owns it."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body([]))

    async with openai_client(handler) as http:
        async with Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        ) as fib:
            await fib.aclose()
        assert not http.is_closed


async def test_aclose_is_idempotent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body([]))

    async with openai_client(handler) as http:
        fib = Fibonacci.from_openai(
            base_url="http://localhost:11434/v1", model="local", http_client=http
        )
        await fib.aclose()
        await fib.aclose()


async def test_repr_does_not_leak_credentials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=chat_body([]))

    async with openai_client(handler) as http:
        fib = Fibonacci.from_openai(
            base_url="https://api.openai.com/v1",
            api_key="sk-proj-topsecretvalue",
            model="gpt-4o-mini",
            http_client=http,
        )
        assert "topsecret" not in repr(fib)
