/**
 * Server-Sent Events parser.
 *
 * The bug this file exists to avoid: a naive implementation does
 * `chunk.toString().split('\n')` per chunk. TCP does not respect event
 * boundaries, so a single JSON payload routinely arrives split across two
 * chunks — sometimes mid-multi-byte-character. That produces intermittent
 * "Unexpected end of JSON input" that only shows up on slow networks or long
 * completions, which is the worst possible failure mode to debug.
 *
 * So: one persistent buffer, a streaming TextDecoder, and events emitted only
 * on a complete blank-line terminator.
 *
 * Implements the field parsing of the WHATWG event-stream spec that matters
 * here (data, event, id, retry, comments); ignores the reconnection state
 * machine, which is the caller's business.
 */

export interface SseEvent {
  /** The `event:` field, or 'message' when absent, per spec. */
  event: string;
  /** All `data:` lines joined with newline, with the single leading space stripped. */
  data: string;
  id?: string;
  retry?: number;
}

/** Parse one already-complete event block (no blank lines inside). */
export function parseEventBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let sawField = false;

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    // A line starting with ':' is a comment. Servers send these as keepalives.
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Spec: strip exactly one leading space from the value, not all whitespace.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        sawField = true;
        break;
      case 'event':
        event = value;
        sawField = true;
        break;
      case 'id':
        // Spec: ignore an id containing NUL.
        if (!value.includes('\0')) id = value;
        sawField = true;
        break;
      case 'retry': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && /^\d+$/.test(value)) retry = n;
        sawField = true;
        break;
      }
      default:
        // Unknown fields are ignored per spec.
        break;
    }
  }

  if (!sawField) return null;
  const out: SseEvent = { event, data: dataLines.join('\n') };
  if (id !== undefined) out.id = id;
  if (retry !== undefined) out.retry = retry;
  return out;
}

/**
 * Turn a byte stream into SSE events.
 *
 * `stream: true` on the decoder is what makes multi-byte characters split
 * across chunk boundaries decode correctly instead of becoming U+FFFD.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Handle \n\n and \r\n\r\n.
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const evt = parseEventBlock(block);
        if (evt) yield evt;
      }
    }

    // Flush any trailing bytes and emit a final unterminated block. Some
    // servers close without the final blank line.
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      const evt = parseEventBlock(buffer);
      if (evt) yield evt;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * Convenience wrapper: yield JSON-decoded `data` payloads, skipping the
 * `[DONE]` sentinel and any payload that is not valid JSON (which servers do
 * emit — Ollama and some proxies send bare keepalive text).
 */
export async function* parseSseJson<T = unknown>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; json: T }> {
  for await (const evt of parseSse(body, signal)) {
    const data = evt.data.trim();
    if (data === '' || data === '[DONE]') continue;
    let json: T;
    try {
      json = JSON.parse(data) as T;
    } catch {
      continue;
    }
    yield { event: evt.event, json };
  }
}
