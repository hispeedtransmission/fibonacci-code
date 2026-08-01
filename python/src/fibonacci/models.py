"""Typed value objects for conversation items, tools, usage, and stream events.

Two backends speak two different wire protocols — the OpenAI *Responses* API
(what a ChatGPT subscription exposes) and *Chat Completions* (what every
OpenAI-compatible server exposes). Rather than invent a lowest-common-
denominator format and lose information, the types here convert *outward* into
each wire shape (``to_responses_item`` / ``to_chat_message``) and carry the
provider's own item verbatim in ``raw`` when one exists.

That ``raw`` field matters more than it looks. The Responses API requires that
tool-call and reasoning items be echoed back byte-for-byte on the next turn;
re-serialising them from parsed fields drops ``encrypted_content`` and the
model loses its own chain of thought. So we keep the original mapping and hand
it back unmodified.

Note on ``slots=True``: this package supports Python 3.9, where
``@dataclass(slots=True)`` does not exist. Passing it conditionally
(``**kwargs`` into the decorator) would defeat mypy's dataclass plugin, which
requires literal arguments. The memory win is not worth losing type checking on
the core data model, so these are plain dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

__all__ = [
    "Completed",
    "Message",
    "ModelInfo",
    "ReasoningDelta",
    "ReasoningItem",
    "ResponseStarted",
    "StreamEvent",
    "StreamEventT",
    "TextDelta",
    "Tool",
    "ToolCall",
    "ToolCallEvent",
    "ToolResult",
    "Usage",
    "to_wire_items",
]

# The Responses API distinguishes text the user supplied from text the model
# produced; the field name is part of the contract, not a style choice.
_INPUT_TEXT = "input_text"
_OUTPUT_TEXT = "output_text"


@dataclass(frozen=True)
class Message:
    """A plain text turn in the conversation.

    ``role`` is one of ``user``, ``assistant``, or ``system``. System text is
    normally better placed in the request's ``instructions`` field, but a
    system message is accepted here for callers porting existing transcripts.
    """

    role: str
    content: str

    def to_responses_item(self) -> Dict[str, Any]:
        """Render as a Responses API ``input`` item."""
        part_type = _OUTPUT_TEXT if self.role == "assistant" else _INPUT_TEXT
        return {
            "type": "message",
            "role": self.role,
            "content": [{"type": part_type, "text": self.content}],
        }

    def to_chat_message(self) -> Dict[str, Any]:
        """Render as a Chat Completions ``messages`` entry."""
        return {"role": self.role, "content": self.content}


@dataclass(frozen=True)
class ToolCall:
    """A function call requested by the model.

    ``arguments`` is the raw JSON *string* the model emitted, not a parsed
    object. Models occasionally emit malformed JSON, and swallowing that here
    would hide the failure inside the SDK; callers decide whether to
    ``json.loads`` it, repair it, or reject the turn.
    """

    call_id: str
    name: str
    arguments: str
    raw: Optional[Mapping[str, Any]] = None

    def to_responses_item(self) -> Dict[str, Any]:
        """Render for echo-back, preferring the provider's verbatim item.

        See the module docstring: reconstructing this item loses fields the
        Responses API expects to see again (notably encrypted reasoning
        linkage), so the original is returned whenever we have it.
        """
        if self.raw is not None:
            return dict(self.raw)
        return {
            "type": "function_call",
            "call_id": self.call_id,
            "name": self.name,
            "arguments": self.arguments,
        }

    def to_chat_tool_call(self) -> Dict[str, Any]:
        """Render as a Chat Completions ``tool_calls`` entry."""
        return {
            "id": self.call_id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments},
        }


@dataclass(frozen=True)
class ToolResult:
    """The result of executing a :class:`ToolCall`, fed back to the model.

    ``output`` is a string because both wire protocols want a string here.
    Structured results should be JSON-encoded by the caller, which keeps the
    encoding decision (indentation, key order, truncation) where the caller can
    see it.
    """

    call_id: str
    output: str

    def to_responses_item(self) -> Dict[str, Any]:
        return {
            "type": "function_call_output",
            "call_id": self.call_id,
            "output": self.output,
        }

    def to_chat_message(self) -> Dict[str, Any]:
        return {"role": "tool", "tool_call_id": self.call_id, "output": self.output}


@dataclass(frozen=True)
class ReasoningItem:
    """An opaque reasoning item produced by a reasoning model.

    The payload is provider-owned and usually encrypted; ``summary`` holds only
    whatever human-readable summary text the provider chose to stream. Echo the
    whole item back on the next turn to preserve the model's chain of thought
    across a tool round-trip.
    """

    raw: Mapping[str, Any]
    summary: str = ""

    def to_responses_item(self) -> Dict[str, Any]:
        return dict(self.raw)


@dataclass(frozen=True)
class Tool:
    """A function the model may call.

    ``parameters`` is a JSON Schema object. It is passed through untouched: the
    SDK does not validate schemas, because providers disagree about which
    dialect subset they accept and a local validator would reject requests the
    server would have honoured.
    """

    name: str
    description: str
    parameters: Dict[str, Any] = field(default_factory=dict)
    strict: bool = False

    def to_responses_tool(self) -> Dict[str, Any]:
        """Responses API shape: function fields are flattened onto the tool."""
        return {
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "strict": self.strict,
        }

    def to_chat_tool(self) -> Dict[str, Any]:
        """Chat Completions shape: function fields are nested."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass(frozen=True)
class Usage:
    """Token accounting for one response.

    Every field defaults to zero so that a provider omitting the block (common
    on self-hosted servers) yields a usable object rather than ``None`` checks
    scattered through calling code.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0

    @classmethod
    def from_responses(cls, payload: Optional[Mapping[str, Any]]) -> Usage:
        """Parse the Responses API usage block, including nested detail counts."""
        if not payload:
            return cls()
        in_details = payload.get("input_tokens_details") or {}
        out_details = payload.get("output_tokens_details") or {}
        return cls(
            input_tokens=_as_int(payload.get("input_tokens")),
            output_tokens=_as_int(payload.get("output_tokens")),
            total_tokens=_as_int(payload.get("total_tokens")),
            cached_tokens=_as_int(in_details.get("cached_tokens")),
            cache_write_tokens=_as_int(in_details.get("cache_write_tokens")),
            reasoning_tokens=_as_int(out_details.get("reasoning_tokens")),
        )

    @classmethod
    def from_chat(cls, payload: Optional[Mapping[str, Any]]) -> Usage:
        """Parse the Chat Completions usage block.

        Field names differ from the Responses API (``prompt_tokens`` rather
        than ``input_tokens``), and the cached/reasoning detail blocks are
        optional extensions that only some servers emit.
        """
        if not payload:
            return cls()
        prompt_details = payload.get("prompt_tokens_details") or {}
        completion_details = payload.get("completion_tokens_details") or {}
        return cls(
            input_tokens=_as_int(payload.get("prompt_tokens")),
            output_tokens=_as_int(payload.get("completion_tokens")),
            total_tokens=_as_int(payload.get("total_tokens")),
            cached_tokens=_as_int(prompt_details.get("cached_tokens")),
            reasoning_tokens=_as_int(completion_details.get("reasoning_tokens")),
        )


@dataclass(frozen=True)
class ModelInfo:
    """A model the configured backend will accept."""

    id: str
    owned_by: Optional[str] = None
    created: Optional[int] = None


class StreamEvent:
    """Base class for everything :meth:`Fibonacci.stream` yields.

    Subclasses are compared and matched by type, which keeps consumer code
    readable (``isinstance(event, TextDelta)``) and lets new event kinds be
    added without breaking existing ``elif`` chains — an unknown event is
    simply not matched, rather than crashing a dispatch table.
    """

    __slots__ = ()


@dataclass(frozen=True)
class ResponseStarted(StreamEvent):
    """The provider accepted the request and opened a response."""

    response_id: Optional[str] = None


@dataclass(frozen=True)
class TextDelta(StreamEvent):
    """A fragment of assistant-visible output text."""

    text: str


@dataclass(frozen=True)
class ReasoningDelta(StreamEvent):
    """A fragment of reasoning summary text.

    Emitted for both the Responses API's ``reasoning_summary_text`` events and
    the ``delta.reasoning_content`` field used by DeepSeek/Qwen-style servers,
    so consumers can render "thinking" output without knowing the backend.
    """

    text: str


@dataclass(frozen=True)
class ToolCallEvent(StreamEvent):
    """The model finished requesting a tool call.

    Emitted once the call is complete, never per-argument-fragment: partial
    JSON arguments are not useful to a caller and inviting them to parse
    incomplete JSON would be a trap.
    """

    call: ToolCall


@dataclass(frozen=True)
class Completed(StreamEvent):
    """Terminal event: the response finished normally.

    ``items`` holds the backend's own output items in the backend's own wire
    format, ready to be appended to the next request. Feed them back to the
    *same* backend; the two protocols are not interchangeable.
    """

    usage: Usage = field(default_factory=Usage)
    items: Tuple[Dict[str, Any], ...] = ()


StreamEventT = Union[
    ResponseStarted,
    TextDelta,
    ReasoningDelta,
    ToolCallEvent,
    Completed,
]
"""Union alias for exhaustive matching over stream events."""

#: Anything accepted as a conversation item: an SDK object, or a raw provider
#: mapping that is passed through untouched.
InputItem = Union[Message, ToolCall, ToolResult, ReasoningItem, Mapping[str, Any]]


def to_wire_items(items: Sequence[InputItem], *, responses: bool) -> List[Dict[str, Any]]:
    """Convert mixed SDK objects and raw provider mappings into wire items.

    Raw mappings pass through unchanged. This is what makes a tool loop
    possible without the SDK needing to model every provider item type: hand
    ``Completed.items`` straight back in and only the parts you constructed
    yourself get converted.

    :param responses: ``True`` for the Responses API, ``False`` for Chat
        Completions.
    """
    wire: List[Dict[str, Any]] = []
    for item in items:
        if isinstance(item, (Message, ToolResult)):
            wire.append(item.to_responses_item() if responses else item.to_chat_message())
        elif isinstance(item, ToolCall):
            if responses:
                wire.append(item.to_responses_item())
            else:
                wire.append(
                    {"role": "assistant", "content": None, "tool_calls": [item.to_chat_tool_call()]}
                )
        elif isinstance(item, ReasoningItem):
            # Reasoning items exist only in the Responses protocol. Dropping
            # them for Chat Completions is correct: a chat server would reject
            # the unknown role outright.
            if responses:
                wire.append(item.to_responses_item())
        else:
            wire.append(dict(item))
    return wire


def _as_int(value: Any) -> int:
    """Coerce a possibly-missing, possibly-float token count to ``int``.

    Self-hosted servers have been observed sending floats and strings here.
    A wrong token count is not worth an exception, so anything uncoercible
    becomes zero.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
