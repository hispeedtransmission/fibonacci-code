import { readFile, writeFile, rename, chmod, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthError, NetworkError } from '../errors.ts';
import { codexAuthPath } from '../paths.ts';
import type { CodexTokens } from './store.ts';

/**
 * Interop with the Codex CLI's ChatGPT-subscription login.
 *
 * The public OAuth client id below is the Codex CLI's own; it is not a secret
 * (public PKCE clients have no secret) and is required for the refresh grant to
 * be accepted for tokens minted by that client.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

/** Refresh this many seconds before actual expiry, to survive clock skew. */
const REFRESH_SKEW_SECONDS = 300;

/** The on-disk shape of ~/.codex/auth.json. We preserve unknown keys on write. */
interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
  [k: string]: unknown;
}

export interface CodexAccount {
  email?: string;
  planType?: string;
  accountId: string;
  /** Access-token expiry, epoch ms. */
  expiresAt: number;
}

/** Decode a JWT payload without verifying it. We only read non-security claims. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function accessTokenExpiry(accessToken: string): number {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.['exp'];
  // A token we cannot read is treated as already expired, which forces a
  // refresh rather than a confusing 401 mid-stream.
  return typeof exp === 'number' ? exp * 1000 : 0;
}

export function describeAccount(tokens: CodexTokens): CodexAccount {
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  const authClaims = (claims?.['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const account: CodexAccount = {
    accountId: tokens.account_id,
    expiresAt: accessTokenExpiry(tokens.access_token),
  };
  const email = claims?.['email'];
  if (typeof email === 'string') account.email = email;
  const plan = authClaims['chatgpt_plan_type'];
  if (typeof plan === 'string') account.planType = plan;
  return account;
}

export async function readCodexAuth(path = codexAuthPath()): Promise<CodexAuthFile | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CodexAuthFile;
  } catch {
    return null;
  }
}

/**
 * Load the Codex CLI login, or explain precisely what to do about its absence.
 */
export async function requireCodexTokens(path = codexAuthPath()): Promise<CodexTokens> {
  const file = await readCodexAuth(path);
  if (!file) {
    throw new AuthError(
      `No Codex credentials found at ${path}.`,
      'Install the Codex CLI and run `codex login`, then re-run `fib auth login --codex`. ' +
        'Or use an API key instead: `fib auth login --api-key --profile openai`.',
    );
  }
  if (file.auth_mode && file.auth_mode !== 'chatgpt') {
    throw new AuthError(
      `Codex is configured for "${file.auth_mode}" auth, not a ChatGPT subscription.`,
      'Run `codex login` and choose "Sign in with ChatGPT", or point Fibonacci at an API key: ' +
        '`fib auth login --api-key --profile openai`.',
    );
  }
  const t = file.tokens;
  if (!t?.access_token || !t.refresh_token || !t.account_id) {
    throw new AuthError(
      `Codex credentials at ${path} are incomplete.`,
      'Run `codex login` to re-authenticate.',
    );
  }
  return t;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * OpenAI rotates the refresh token on use, so the caller MUST persist whatever
 * comes back. Dropping the new refresh token strands the login.
 */
export async function refreshCodexTokens(refreshToken: string, signal?: AbortSignal): Promise<CodexTokens> {
  let res: Response;
  try {
    res = await fetch(OPENAI_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email',
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new NetworkError('Could not reach the OpenAI token endpoint to refresh your login.', {
      cause: err,
      hint: 'Check your network connection, then retry.',
    });
  }

  if (!res.ok) {
    // The body may echo the token; never surface it.
    throw new AuthError(
      `Refreshing your ChatGPT login failed (HTTP ${res.status}).`,
      'Run `codex login` to sign in again, then re-run your command.',
    );
  }

  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!body.access_token) {
    throw new AuthError('The token endpoint returned no access token.', 'Run `codex login` to sign in again.');
  }

  return {
    access_token: body.access_token,
    // Rotation is not guaranteed on every call; keep the old one if unchanged.
    refresh_token: body.refresh_token ?? refreshToken,
    ...(body.id_token ? { id_token: body.id_token } : {}),
    account_id: '', // filled by caller, which knows the previous account_id
  };
}

/** Atomic 0600 write that preserves every key we did not set. */
async function writeCodexAuth(path: string, next: CodexAuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Return tokens guaranteed fresh for at least REFRESH_SKEW_SECONDS.
 *
 * In link mode we write rotated tokens straight back into the Codex CLI's own
 * file, in its own schema, preserving unknown keys. That keeps exactly one
 * source of truth: Fibonacci refreshing can never strand the Codex CLI, and
 * vice versa.
 */
export async function ensureFreshCodexTokens(
  opts: { path?: string; signal?: AbortSignal } = {},
): Promise<CodexTokens> {
  const path = opts.path ?? codexAuthPath();
  const tokens = await requireCodexTokens(path);
  const expiresAt = accessTokenExpiry(tokens.access_token);

  if (expiresAt - REFRESH_SKEW_SECONDS * 1000 > Date.now()) return tokens;

  const refreshed = await refreshCodexTokens(tokens.refresh_token, opts.signal);
  const merged: CodexTokens = { ...refreshed, account_id: tokens.account_id };

  const existing = (await readCodexAuth(path)) ?? {};
  await writeCodexAuth(path, {
    ...existing,
    auth_mode: existing.auth_mode ?? 'chatgpt',
    tokens: merged,
    last_refresh: new Date().toISOString(),
  });

  return merged;
}

/** Same freshness guarantee for a `--copy` snapshot, persisted to our own store. */
export async function refreshCopiedTokens(
  tokens: CodexTokens,
  persist: (t: CodexTokens) => Promise<void>,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  if (accessTokenExpiry(tokens.access_token) - REFRESH_SKEW_SECONDS * 1000 > Date.now()) return tokens;
  const refreshed = await refreshCodexTokens(tokens.refresh_token, signal);
  const merged: CodexTokens = { ...refreshed, account_id: tokens.account_id };
  await persist(merged);
  return merged;
}
