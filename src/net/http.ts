import { CancelledError, NetworkError, ProviderError, isRetryable } from '../errors.ts';

/**
 * Retrying HTTP for model backends.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   1. **Retry-After wins over our backoff.** When a provider says "wait 47
 *      seconds", exponential backoff that retries in 2s just burns quota and
 *      earns a longer ban. We honour the header when present.
 *
 *   2. **Full jitter, not fixed backoff.** If a tool loop fires several
 *      requests that all get 429'd, identical backoff makes them retry in
 *      lockstep forever. Randomising across the whole interval decorrelates
 *      them. (AWS's "Exponential Backoff and Jitter", full-jitter variant.)
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so the suite does not actually sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 } as const;

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Full-jitter backoff: uniform in [0, min(cap, base * 2^attempt)]. */
export function backoffDelay(attempt: number, baseMs: number, capMs: number, rand = Math.random): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rand() * exponential);
}

/** Parse Retry-After, which is either delta-seconds or an HTTP-date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** Read an error body and pull out the most human message we can find. */
async function describeErrorBody(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const err = json['error'];
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>)['message'];
      if (typeof m === 'string') return m;
    }
    for (const key of ['detail', 'message']) {
      const v = json[key];
      if (typeof v === 'string') return v;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat || res.statusText || `HTTP ${res.status}`;
}

/** Turn a non-2xx into a ProviderError with an actionable hint. */
export async function toProviderError(provider: string, res: Response): Promise<ProviderError> {
  const message = await describeErrorBody(res);
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));

  let hint: string | undefined;
  switch (res.status) {
    case 401:
      hint = 'Your credentials were rejected. Run `fib auth status`, then `fib auth login`.';
      break;
    case 403:
      hint = 'Authenticated, but not permitted to use this model or endpoint. Try `fib models` to see what is available.';
      break;
    case 404:
      hint = 'Endpoint not found. Check the base URL with `fib config` — it should include the /v1 suffix for most servers.';
      break;
    case 429:
      hint = retryAfter
        ? `Rate limited. The server asked for ${retryAfter}s.`
        : 'Rate limited or out of quota. Retry shortly, or switch profiles with `--profile`.';
      break;
    case 400:
      hint = 'The request was rejected. If this mentions a model name, run `fib models` and pick a supported one.';
      break;
    default:
      if (res.status >= 500) hint = 'The provider had a server-side error. This is usually transient.';
  }

  return new ProviderError(provider, res.status, message, {
    ...(hint ? { hint } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

/**
 * POST with retries. Returns the successful Response with its body unread, so
 * the caller can stream it.
 */
export async function postWithRetry(
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw new CancelledError();

    let res: Response;
    try {
      res = await fetch(url, { ...init, method: 'POST', signal });
    } catch (err) {
      if (signal.aborted) throw new CancelledError();
      lastError = new NetworkError(`Could not reach ${new URL(url).host}.`, {
        cause: err,
        hint: 'Check your connection. If you are pointing at a local server, confirm it is running.',
      });
      if (attempt === maxAttempts - 1) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: 'network error' });
      await sleep(delay, signal);
      continue;
    }

    if (res.ok) return res;

    const err = await toProviderError(provider, res);
    lastError = err;
    if (!isRetryable(err) || attempt === maxAttempts - 1) break;

    // Server-specified wait beats our own guess.
    const delay =
      err.retryAfter !== undefined
        ? Math.min(err.retryAfter * 1000, maxDelayMs)
        : backoffDelay(attempt, baseDelayMs, maxDelayMs);
    options.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: `HTTP ${err.status}` });
    await sleep(delay, signal);
  }

  throw lastError ?? new NetworkError('Request failed.');
}

/** GET returning parsed JSON, with the same error mapping. */
export async function getJson<T>(
  provider: string,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (signal?.aborted) throw new CancelledError();
    throw new NetworkError(`Could not reach ${new URL(url).host}.`, { cause: err });
  }
  if (!res.ok) throw await toProviderError(provider, res);
  return (await res.json()) as T;
}
