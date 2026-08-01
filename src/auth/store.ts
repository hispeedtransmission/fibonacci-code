import { mkdir, readFile, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { authPath, fibonacciHome } from '../paths.ts';

/**
 * Credential storage.
 *
 * Two rules govern everything in this file:
 *   1. The file is 0600 and written atomically (temp + rename), so a crash
 *      mid-write can never leave a truncated credential on disk.
 *   2. No value in here is ever passed to console.log, an Error message, or a
 *      thrown stack. Redaction happens at the boundary (see `redact`).
 */

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id: string;
}

/**
 * A live link to the Codex CLI's own credential file. We hold no tokens of our
 * own; `codexAuthFile` is read through on every request. This is the default
 * because refresh-token rotation makes snapshots unsafe.
 */
export interface CodexLinkCredential {
  kind: 'codex-link';
  codexAuthFile: string;
  linkedAt: string;
}

/**
 * A snapshot of Codex tokens taken with `--copy`. Isolated from the Codex CLI,
 * at the cost of the two copies diverging once either side refreshes.
 */
export interface CodexCopyCredential {
  kind: 'codex-copy';
  tokens: CodexTokens;
  lastRefresh: string;
}

/** An API key for an OpenAI-compatible endpoint, keyed by profile name. */
export interface ApiKeyCredential {
  kind: 'apikey';
  profile: string;
  key: string;
  baseUrl?: string;
  createdAt: string;
}

export type Credential = CodexLinkCredential | CodexCopyCredential | ApiKeyCredential;

export interface AuthFile {
  version: 1;
  /** Keyed by profile name; "codex" holds the Codex link or copy. */
  credentials: Record<string, Credential>;
}

const EMPTY: AuthFile = { version: 1, credentials: {} };

export async function readAuthFile(): Promise<AuthFile> {
  const path = authPath();
  if (!existsSync(path)) return { ...EMPTY, credentials: {} };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as AuthFile;
    if (parsed?.version !== 1 || typeof parsed.credentials !== 'object') {
      return { ...EMPTY, credentials: {} };
    }
    return parsed;
  } catch {
    // A corrupt credential store should not brick the CLI. Treat as empty; the
    // user will be told to log in again, which rewrites the file.
    return { ...EMPTY, credentials: {} };
  }
}

/**
 * Atomic 0600 write. The temp file is created in the same directory so the
 * rename stays on one filesystem and is therefore actually atomic.
 */
export async function writeAuthFile(file: AuthFile): Promise<void> {
  const path = authPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function setCredential(profile: string, cred: Credential): Promise<void> {
  const file = await readAuthFile();
  file.credentials[profile] = cred;
  await writeAuthFile(file);
}

export async function getCredential(profile: string): Promise<Credential | undefined> {
  const file = await readAuthFile();
  return file.credentials[profile];
}

export async function deleteCredential(profile: string): Promise<boolean> {
  const file = await readAuthFile();
  if (!(profile in file.credentials)) return false;
  delete file.credentials[profile];
  await writeAuthFile(file);
  return true;
}

export async function listCredentialProfiles(): Promise<string[]> {
  return Object.keys((await readAuthFile()).credentials).sort();
}

/**
 * Render a secret for human eyes: first 4 and last 4 characters only, and only
 * when the value is long enough that those 8 characters are not most of it.
 */
export function redact(secret: string | undefined): string {
  if (!secret) return '(none)';
  if (secret.length <= 12) return '••••••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

export function homeDirForDisplay(): string {
  return fibonacciHome();
}
