"""Server-Sent Events parser for streaming HTTP responses.

There are two ways to get this wrong that only show up in production, and both
are avoided here deliberately:

1. **Decoding per chunk.** ``chunk.decode("utf-8")`` on each network chunk
   corrupts any multi-byte character that straddles a chunk boundary — em
   dashes, curly quotes, emoji, and every non-Latin script. A model streaming
   token-by-token hits this constantly. We drive a single incremental decoder
   across the whole stream instead.

2. **Splitting per chunk.** Chunk boundaries have nothing to do with line or
   event boundaries. A single ``data:`` payload routinely arrives in three
   pieces, and ``\\r\\n`` can straddle a boundary such that a naive splitter
   sees two line terminators where there is one. We buffer across chunks and
   hold back a trailing lone ``\\r`` until we know what follows it.

The parser follows the WHATWG SSE line grammar (``\\n``, ``\\r\\n``, and bare
``\\r`` all terminate a line; ``:`` prefixes a comment; one optional space is
stripped after the field colon), with one documented deviation noted on
:func:`iter_sse`.
"""

from __future__ import annotations

import codecs
import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, List, Optional, Tuple

__all__ = ["SSEEvent", "iter_sse"]

_BOM = "﻿"


@dataclass(frozen=True)
class SSEEvent:
    """One dispatched Server-Sent Event.

    :param event: The ``event:`` field, or ``None`` when the stream did not
        name one (consumers should then fall back to a ``type`` key inside the
        JSON payload, which is what the Responses API does).
    :param data: Concatenated ``data:`` lines, joined with newlines and with no
        trailing newline.
    """

    data: str
    event: Optional[str] = None

    def json(self) -> Any:
        """Parse :attr:`data` as JSON.

        Raises :class:`json.JSONDecodeError` for non-JSON payloads. Sentinel
        frames such as ``[DONE]`` are not JSON, so check for those before
        calling this.
        """
        return json.loads(self.data)


@dataclass
class _EventBuffer:
    """Accumulator for the fields of the event currently being assembled."""

    name: Optional[str] = None
    data: List[str] = field(default_factory=list)

    def reset(self) -> None:
        self.name = None
        self.data = []


async def iter_sse(chunks: AsyncIterator[bytes]) -> AsyncIterator[SSEEvent]:
    """Parse an async iterator of raw bytes into :class:`SSEEvent` objects.

    Deviation from the strict spec: if the stream ends with a pending event
    that was never terminated by a blank line, that event is still dispatched.
    Real servers — including OpenAI-compatible ones behind proxies — drop the
    final blank line when closing the connection, and silently discarding the
    last event would lose the terminal ``response.completed`` frame carrying
    token usage.

    :param chunks: Byte chunks, e.g. ``httpx.Response.aiter_bytes()``.
    """
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buffer = ""
    pending = _EventBuffer()
    at_stream_start = True

    async for chunk in chunks:
        text = decoder.decode(chunk)
        if not text:
            continue
        if at_stream_start:
            # A UTF-8 BOM is legal at the head of an event stream and must not
            # end up prefixed to the first field name.
            text = text.lstrip(_BOM)
            at_stream_start = False
        buffer += text

        lines, buffer = _take_lines(buffer, final=False)
        for line in lines:
            event = _feed(pending, line)
            if event is not None:
                yield event

    # Flush whatever the decoder was holding (a truncated multi-byte sequence
    # becomes a replacement character rather than vanishing), then drain.
    buffer += decoder.decode(b"", True)
    lines, remainder = _take_lines(buffer, final=True)
    for line in lines:
        event = _feed(pending, line)
        if event is not None:
            yield event
    if remainder:
        event = _feed(pending, remainder)
        if event is not None:
            yield event

    if pending.data:
        yield SSEEvent(data="\n".join(pending.data), event=pending.name)


def _take_lines(buffer: str, *, final: bool) -> Tuple[List[str], str]:
    """Split complete lines off the front of ``buffer``.

    Returns the complete lines and the unconsumed remainder. A trailing lone
    ``\\r`` is held back unless ``final`` is set, because the very next chunk
    may begin with ``\\n`` and the pair is a single terminator.
    """
    lines: List[str] = []
    start = 0
    index = 0
    length = len(buffer)

    while index < length:
        char = buffer[index]
        if char == "\n":
            lines.append(buffer[start:index])
            index += 1
            start = index
        elif char == "\r":
            if index + 1 == length and not final:
                break
            lines.append(buffer[start:index])
            index += 1
            if index < length and buffer[index] == "\n":
                index += 1
            start = index
        else:
            index += 1

    return lines, buffer[start:]


def _feed(pending: _EventBuffer, line: str) -> Optional[SSEEvent]:
    """Apply one line to the pending event; return an event when one dispatches."""
    if line == "":
        # Blank line dispatches. Per spec an event with no data is discarded
        # rather than dispatched, but the buffers still reset.
        if not pending.data:
            pending.reset()
            return None
        event = SSEEvent(data="\n".join(pending.data), event=pending.name)
        pending.reset()
        return event

    if line.startswith(":"):
        # Comment. Widely used as a keep-alive heartbeat; carries no payload.
        return None

    name, _, value = line.partition(":")
    if value.startswith(" "):
        value = value[1:]

    if name == "event":
        pending.name = value
    elif name == "data":
        pending.data.append(value)
    # `id` and `retry` are parsed and ignored on purpose: this SDK does not
    # reconnect a dropped stream (a resumed completion would interleave
    # duplicate tokens), so last-event-id and retry hints have no consumer.
    return None
