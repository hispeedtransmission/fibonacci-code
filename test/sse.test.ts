import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventBlock, parseSse, parseSseJson } from '../src/net/sse.ts';

/**
 * The point of these tests is the chunk-boundary cases. A naive SSE parser
 * passes every "one event, one chunk" test and then fails intermittently in
 * production, so most of what follows deliberately splits the byte stream in
 * hostile places.
 */

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('parseEventBlock', () => {
  test('joins multiple data lines with newline', () => {
    const evt = parseEventBlock('data: line one\ndata: line two');
    assert.equal(evt?.data, 'line one\nline two');
  });

  test('strips exactly one leading space, preserving further indentation', () => {
    // Per spec only ONE space is stripped. Getting this wrong corrupts any
    // payload whose JSON is pretty-printed with leading whitespace.
    const evt = parseEventBlock('data:  two-spaces');
    assert.equal(evt?.data, ' two-spaces');
  });

  test('ignores comment lines (keepalives)', () => {
    const evt = parseEventBlock(': ping\ndata: real');
    assert.equal(evt?.data, 'real');
  });

  test('returns null for a block with no recognised fields', () => {
    assert.equal(parseEventBlock(': just a comment'), null);
    assert.equal(parseEventBlock(''), null);
  });

  test('defaults the event name to "message"', () => {
    assert.equal(parseEventBlock('data: x')?.event, 'message');
    assert.equal(parseEventBlock('event: custom\ndata: x')?.event, 'custom');
  });

  test('handles a field with no colon', () => {
    const evt = parseEventBlock('data\ndata: x');
    assert.equal(evt?.data, '\nx');
  });

  test('ignores an id containing NUL, per spec', () => {
    const evt = parseEventBlock(`id: a${String.fromCharCode(0)}b\ndata: x`);
    assert.equal(evt?.id, undefined);
  });

  test('parses retry only when it is all digits', () => {
    assert.equal(parseEventBlock('retry: 3000\ndata: x')?.retry, 3000);
    assert.equal(parseEventBlock('retry: 30ms\ndata: x')?.retry, undefined);
  });
});

describe('parseSse — chunk boundaries', () => {
  test('reassembles an event split across chunks', async () => {
    const events = await collect(parseSse(streamOf('data: hel', 'lo world\n', '\n')));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data, 'hello world');
  });

  test('reassembles when the blank-line terminator itself is split', async () => {
    const events = await collect(parseSse(streamOf('data: a\n', '\ndata: b\n\n')));
    assert.deepEqual(events.map((e) => e.data), ['a', 'b']);
  });

  test('handles CRLF line endings', async () => {
    const events = await collect(parseSse(streamOf('data: a\r\n\r\ndata: b\r\n\r\n')));
    assert.deepEqual(events.map((e) => e.data), ['a', 'b']);
  });

  test('decodes a multi-byte character split across a chunk boundary', async () => {
    // The em-dash U+2014 is three bytes. Splitting it mid-character is exactly
    // what breaks a parser that calls toString() per chunk: it yields U+FFFD.
    const full = new TextEncoder().encode('data: a—b\n\n');
    const cut = 8; // lands inside the em-dash
    const events = await collect(parseSse(streamOf(full.slice(0, cut), full.slice(cut))));
    assert.equal(events[0]?.data, 'a—b');
    assert.ok(!events[0]?.data.includes('�'), 'must not produce a replacement character');
  });

  test('emits a trailing block when the server closes without a final blank line', async () => {
    const events = await collect(parseSse(streamOf('data: only')));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data, 'only');
  });

  test('yields nothing for an empty stream', async () => {
    assert.deepEqual(await collect(parseSse(streamOf())), []);
  });

  test('delivers many events arriving in one chunk', async () => {
    const body = Array.from({ length: 50 }, (_, i) => `data: ${i}\n\n`).join('');
    const events = await collect(parseSse(streamOf(body)));
    assert.equal(events.length, 50);
    assert.equal(events[49]?.data, '49');
  });
});

describe('parseSseJson', () => {
  test('skips the [DONE] sentinel', async () => {
    const events = await collect(parseSseJson(streamOf('data: {"a":1}\n\ndata: [DONE]\n\n')));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.json, { a: 1 });
  });

  test('skips non-JSON payloads rather than throwing', async () => {
    // Some proxies emit bare keepalive text. One of those must not kill a turn.
    const events = await collect(parseSseJson(streamOf('data: ping\n\ndata: {"ok":true}\n\n')));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.json, { ok: true });
  });

  test('preserves the event name alongside the payload', async () => {
    const events = await collect(parseSseJson(streamOf('event: response.completed\ndata: {"x":1}\n\n')));
    assert.equal(events[0]?.event, 'response.completed');
  });
});

describe('parseSse — cancellation', () => {
  test('stops immediately when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    assert.deepEqual(await collect(parseSse(stream, controller.signal)), []);
    assert.equal(cancelled, true);
  });

  test('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: first\n\n'));
        // Never closes: only the abort can end this.
      },
      cancel() {},
    });

    const received: string[] = [];
    await assert.doesNotReject(async () => {
      for await (const evt of parseSse(stream, controller.signal)) {
        received.push(evt.data);
        controller.abort();
      }
    });
    assert.deepEqual(received, ['first']);
  });
});
