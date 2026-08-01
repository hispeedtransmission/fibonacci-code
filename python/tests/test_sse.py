"""Tests for the SSE parser.

The parser's whole reason to exist is surviving arbitrary chunk boundaries, so
most of these tests deliberately fragment the input in hostile ways rather than
feeding it one clean chunk.
"""

from __future__ import annotations

from typing import List, Sequence

import pytest

from fibonacci.sse import SSEEvent, iter_sse

from .conftest import aiter_chunks


async def parse(chunks: Sequence[bytes]) -> List[SSEEvent]:
    return [event async for event in iter_sse(aiter_chunks(chunks))]


async def test_parses_a_single_event() -> None:
    events = await parse([b"event: ping\ndata: {\"a\": 1}\n\n"])
    assert events == [SSEEvent(data='{"a": 1}', event="ping")]
    assert events[0].json() == {"a": 1}


async def test_payload_split_byte_by_byte_is_identical() -> None:
    """The most hostile chunking possible: one byte at a time."""
    raw = b'event: response.output_text.delta\ndata: {"delta": "hi"}\n\n'
    whole = await parse([raw])
    fragmented = await parse([raw[i : i + 1] for i in range(len(raw))])
    assert fragmented == whole


async def test_multibyte_characters_survive_every_split_point() -> None:
    """A naive per-chunk decode corrupts these; an incremental decoder does not.

    Splitting at *every* offset is the point: one of them is guaranteed to land
    inside a multi-byte sequence.
    """
    raw = 'data: café — 日本語 🎉\n\n'.encode("utf-8")
    for split in range(1, len(raw)):
        events = await parse([raw[:split], raw[split:]])
        assert [e.data for e in events] == ["café — 日本語 🎉"], f"split at {split}"


async def test_crlf_straddling_a_chunk_boundary_is_one_terminator() -> None:
    """`\\r` at the end of a chunk must be held back until `\\n` arrives."""
    events = await parse([b"data: a\r", b"\ndata: b\r\n\r\n"])
    assert events == [SSEEvent(data="a\nb", event=None)]


async def test_bare_cr_terminates_a_line() -> None:
    events = await parse([b"data: a\rdata: b\r\r"])
    assert events == [SSEEvent(data="a\nb", event=None)]


async def test_comments_and_heartbeats_are_ignored() -> None:
    events = await parse([b": keep-alive\n\ndata: real\n\n"])
    assert events == [SSEEvent(data="real", event=None)]


async def test_multiple_data_lines_join_with_newline() -> None:
    events = await parse([b"data: line one\ndata: line two\n\n"])
    assert events[0].data == "line one\nline two"


async def test_only_one_leading_space_is_stripped() -> None:
    events = await parse([b"data:  indented\n\n"])
    assert events[0].data == " indented"


async def test_field_without_colon_is_tolerated() -> None:
    events = await parse([b"data\ndata: x\n\n"])
    assert events[0].data == "\nx"


async def test_final_event_without_trailing_blank_line_is_dispatched() -> None:
    """Real servers drop the last blank line; losing `response.completed` here
    would cost the caller its token usage."""
    events = await parse([b'data: {"type": "response.completed"}\n'])
    assert [e.data for e in events] == ['{"type": "response.completed"}']


async def test_event_with_no_data_is_discarded_but_resets_state() -> None:
    events = await parse([b"event: lonely\n\ndata: payload\n\n"])
    assert events == [SSEEvent(data="payload", event=None)]


async def test_leading_bom_is_stripped() -> None:
    events = await parse(["﻿data: x\n\n".encode("utf-8")])
    assert events[0].data == "x"


async def test_empty_stream_yields_nothing() -> None:
    assert await parse([]) == []
    assert await parse([b"", b""]) == []


async def test_json_raises_on_non_json_payload() -> None:
    events = await parse([b"data: [DONE]\n\n"])
    assert events[0].data == "[DONE]"
    with pytest.raises(ValueError):
        events[0].json()
