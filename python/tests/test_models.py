"""Tests for the wire-format conversions and value objects."""

from __future__ import annotations

from fibonacci.models import (
    Message,
    ReasoningItem,
    Tool,
    ToolCall,
    ToolResult,
    Usage,
    to_wire_items,
)


def test_user_and_assistant_text_use_different_part_types() -> None:
    """The Responses API distinguishes input text from output text; getting
    this wrong makes an echoed transcript unparseable to the server."""
    user = Message("user", "hello").to_responses_item()
    assistant = Message("assistant", "hi").to_responses_item()
    assert user["content"][0]["type"] == "input_text"
    assert assistant["content"][0]["type"] == "output_text"
    assert user["role"] == "user"


def test_message_chat_shape() -> None:
    assert Message("user", "hello").to_chat_message() == {"role": "user", "content": "hello"}


def test_tool_call_echoes_the_provider_item_verbatim() -> None:
    """Reconstructing the item would drop provider-private fields the API
    expects to see again."""
    raw = {
        "type": "function_call",
        "id": "fc_123",
        "call_id": "call_abc",
        "name": "read_file",
        "arguments": '{"path": "x.py"}',
        "encrypted_content": "opaque-blob",
    }
    call = ToolCall(call_id="call_abc", name="read_file", arguments='{"path": "x.py"}', raw=raw)
    assert call.to_responses_item() == raw
    # A copy, not the same object: callers must not be able to mutate ours.
    assert call.to_responses_item() is not raw


def test_tool_call_without_raw_is_reconstructed() -> None:
    call = ToolCall(call_id="call_1", name="ls", arguments="{}")
    assert call.to_responses_item() == {
        "type": "function_call",
        "call_id": "call_1",
        "name": "ls",
        "arguments": "{}",
    }


def test_tool_call_chat_shape_nests_the_function() -> None:
    call = ToolCall(call_id="call_1", name="ls", arguments="{}")
    assert call.to_chat_tool_call() == {
        "id": "call_1",
        "type": "function",
        "function": {"name": "ls", "arguments": "{}"},
    }


def test_tool_result_shapes() -> None:
    result = ToolResult(call_id="call_1", output="done")
    assert result.to_responses_item() == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "done",
    }
    assert result.to_chat_message()["role"] == "tool"


def test_tool_definition_shapes_differ_between_protocols() -> None:
    tool = Tool(name="grep", description="search", parameters={"type": "object"})
    responses = tool.to_responses_tool()
    chat = tool.to_chat_tool()
    assert responses["name"] == "grep"  # flattened
    assert chat["function"]["name"] == "grep"  # nested
    assert responses["parameters"] is tool.parameters


def test_usage_from_responses_matches_the_observed_payload() -> None:
    usage = Usage.from_responses(
        {
            "input_tokens": 14,
            "input_tokens_details": {"cache_write_tokens": 2, "cached_tokens": 5},
            "output_tokens": 5,
            "output_tokens_details": {"reasoning_tokens": 3},
            "total_tokens": 19,
        }
    )
    assert usage == Usage(
        input_tokens=14,
        output_tokens=5,
        total_tokens=19,
        cached_tokens=5,
        cache_write_tokens=2,
        reasoning_tokens=3,
    )


def test_usage_from_chat_maps_prompt_and_completion_names() -> None:
    usage = Usage.from_chat({"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10})
    assert (usage.input_tokens, usage.output_tokens, usage.total_tokens) == (7, 3, 10)


def test_usage_tolerates_missing_and_malformed_counts() -> None:
    """Self-hosted servers send floats, strings, and nothing at all. A wrong
    token count is not worth raising over."""
    assert Usage.from_responses(None) == Usage()
    assert Usage.from_chat({"prompt_tokens": "12", "completion_tokens": 1.0}).input_tokens == 12
    assert Usage.from_chat({"prompt_tokens": "abc"}).input_tokens == 0


def test_to_wire_items_passes_raw_provider_dicts_through_untouched() -> None:
    """This is what makes a tool loop possible: hand `Completed.items` back in
    and only the parts you built yourself get converted."""
    raw = {"type": "reasoning", "id": "rs_1", "encrypted_content": "blob"}
    items = to_wire_items([raw, Message("user", "next")], responses=True)
    assert items[0] == raw
    assert items[1]["type"] == "message"


def test_reasoning_items_are_dropped_for_chat_completions() -> None:
    """A Chat Completions server would reject the unknown item outright."""
    reasoning = ReasoningItem(raw={"type": "reasoning", "id": "rs_1"}, summary="thinking")
    assert to_wire_items([reasoning], responses=True) == [{"type": "reasoning", "id": "rs_1"}]
    assert to_wire_items([reasoning], responses=False) == []


def test_tool_call_becomes_an_assistant_message_for_chat() -> None:
    call = ToolCall(call_id="c1", name="ls", arguments="{}")
    wire = to_wire_items([call], responses=False)
    assert wire[0]["role"] == "assistant"
    assert wire[0]["tool_calls"][0]["function"]["name"] == "ls"
