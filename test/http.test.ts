import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, parseRetryAfter, postWithRetry, toProviderError } from '../src/net/http.ts';
import { ProviderError, isRetryable, NetworkError } from '../src/errors.ts';

describe('parseRetryAfter', () => {
  test('parses delta-seconds', () => {
    assert.equal(parseRetryAfter('47'), 47);
  });

  test('parses an HTTP-date into remaining seconds', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30);
  });

  test('clamps a past date to zero rather than going negative', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now), 0);
  });

  test('returns undefined for absent or unparseable values', () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter('soon'), undefined);
  });
});

describe('backoffDelay', () => {
  test('is bounded by base * 2^attempt', () => {
    // rand() = 1 is the supremum of the full-jitter interval.
    assert.equal(backoffDelay(0, 500, 30_000, () => 1), 500);
    assert.equal(backoffDelay(1, 500, 30_000, () => 1), 1000);
    assert.equal(backoffDelay(3, 500, 30_000, () => 1), 4000);
  });

  test('respects the cap', () => {
    assert.equal(backoffDelay(20, 500, 30_000, () => 1), 30_000);
  });

  test('jitters across the whole interval, not a fixed fraction', () => {
    // Fixed backoff makes concurrent retries collide forever; this is the
    // property that decorrelates them.
    assert.equal(backoffDelay(2, 500, 30_000, () => 0), 0);
    assert.equal(backoffDelay(2, 500, 30_000, () => 0.5), 1000);
  });
});

describe('isRetryable', () => {
  test('retries 429, 408, 409 and 5xx', () => {
    for (const status of [408, 409, 429, 500, 502, 503]) {
      assert.equal(isRetryable(new ProviderError('p', status, 'x')), true, `status ${status}`);
    }
  });

  test('does not retry 400, 401, 403, 404', () => {
    for (const status of [400, 401, 403, 404]) {
      assert.equal(isRetryable(new ProviderError('p', status, 'x')), false, `status ${status}`);
    }
  });

  test('retries transport faults', () => {
    assert.equal(isRetryable(new NetworkError('down')), true);
    assert.equal(isRetryable(new TypeError('fetch failed')), true);
    assert.equal(isRetryable(new TypeError('something else')), false);
  });
});

describe('toProviderError', () => {
  test('extracts an OpenAI-shaped error message', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    const err = await toProviderError('openai', res);
    assert.equal(err.message, 'model not found');
    assert.equal(err.status, 404);
    assert.match(err.hint ?? '', /base URL/);
  });

  test('extracts the ChatGPT backend `detail` shape', async () => {
    // This is the exact body the subscription endpoint returns for a bad model.
    const res = new Response(
      JSON.stringify({ detail: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account." }),
      { status: 400 },
    );
    const err = await toProviderError('codex', res);
    assert.match(err.message, /not supported when using Codex/);
  });

  test('carries Retry-After through to the error', async () => {
    const res = new Response('{}', { status: 429, headers: { 'retry-after': '12' } });
    const err = await toProviderError('p', res);
    assert.equal(err.retryAfter, 12);
    assert.match(err.hint ?? '', /12s/);
  });

  test('falls back to raw text for a non-JSON body', async () => {
    const res = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const err = await toProviderError('p', res);
    assert.match(err.message, /502 Bad Gateway/);
  });

  test('gives 401 an actionable hint', async () => {
    const err = await toProviderError('p', new Response('{}', { status: 401 }));
    assert.match(err.hint ?? '', /fib auth/);
  });
});

describe('postWithRetry', () => {
  const noSleep = async () => {};

  test('returns immediately on success', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await postWithRetry('p', 'https://x.test/v1', {}, new AbortController().signal, { sleep: noSleep });
      assert.equal(res.status, 200);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('retries a 429 then succeeds', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? new Response('{}', { status: 429 }) : new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await postWithRetry('p', 'https://x.test/v1', {}, new AbortController().signal, { sleep: noSleep });
      assert.equal(res.status, 200);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('does not retry a 401 — a bad key will still be bad', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => postWithRetry('p', 'https://x.test/v1', {}, new AbortController().signal, { sleep: noSleep }),
        (e: unknown) => e instanceof ProviderError && e.status === 401,
      );
      assert.equal(calls, 1, 'must not burn attempts on an unauthorized request');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('prefers the server Retry-After over computed backoff', async () => {
    let calls = 0;
    const delays: number[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '5' } })
        : new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      await postWithRetry('p', 'https://x.test/v1', {}, new AbortController().signal, {
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      assert.deepEqual(delays, [5000], 'must honour the server, not guess');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('gives up after maxAttempts and throws the last error', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 503 });
    }) as typeof fetch;
    try {
      await assert.rejects(() =>
        postWithRetry('p', 'https://x.test/v1', {}, new AbortController().signal, {
          sleep: noSleep,
          maxAttempts: 3,
        }),
      );
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = original;
    }
  });
});
