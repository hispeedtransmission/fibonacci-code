/**
 * Typed errors with exit codes and, where possible, the exact next command the
 * user should run. A CLI that says "401 Unauthorized" wasted the user's time;
 * one that says "run `fib auth login --codex`" did not.
 */

/** Exit codes. 1 is generic; the rest let scripts branch on failure kind. */
export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  NETWORK: 4,
  PROVIDER: 5,
  CANCELLED: 130, // 128 + SIGINT
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class FibonacciError extends Error {
  readonly exitCode: ExitCodeValue;
  /** A concrete next step, rendered under the error. */
  readonly hint?: string;

  constructor(message: string, opts: { exitCode?: ExitCodeValue; hint?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.exitCode = opts.exitCode ?? ExitCode.GENERIC;
    if (opts.hint) this.hint = opts.hint;
  }
}

export class UsageError extends FibonacciError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.USAGE, ...(hint ? { hint } : {}) });
  }
}

export class AuthError extends FibonacciError {
  constructor(message: string, hint = 'Run `fib auth login` to sign in.') {
    super(message, { exitCode: ExitCode.AUTH, hint });
  }
}

export class NetworkError extends FibonacciError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message, { exitCode: ExitCode.NETWORK, ...opts });
  }
}

/** A non-2xx from the model backend. Carries status so retry logic can branch. */
export class ProviderError extends FibonacciError {
  readonly status: number;
  readonly provider: string;
  /** Seconds the server asked us to wait, from Retry-After. */
  readonly retryAfter?: number;

  constructor(
    provider: string,
    status: number,
    message: string,
    opts: { hint?: string; retryAfter?: number } = {},
  ) {
    super(message, { exitCode: ExitCode.PROVIDER, ...(opts.hint ? { hint: opts.hint } : {}) });
    this.provider = provider;
    this.status = status;
    if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
  }
}

export class CancelledError extends FibonacciError {
  constructor(message = 'Cancelled.') {
    super(message, { exitCode: ExitCode.CANCELLED });
  }
}

/** True for errors worth retrying: transport faults, 408, 409, 429, and 5xx. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
  }
  if (err instanceof NetworkError) return true;
  // Undici transport failures surface as TypeError('fetch failed') with a cause.
  if (err instanceof TypeError && /fetch failed|terminated|other side closed/i.test(err.message)) return true;
  return false;
}
