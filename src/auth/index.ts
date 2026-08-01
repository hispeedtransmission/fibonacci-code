import { AuthError } from '../errors.ts';
import type { ProfileConfig } from '../config.ts';
import { describeAccount, ensureFreshCodexTokens, refreshCopiedTokens } from './codex.ts';
import { getCredential, setCredential, type CodexCopyCredential, type Credential } from './store.ts';

/**
 * What a provider needs in order to make an authenticated request.
 *
 * `headers()` is called immediately before every request rather than once at
 * construction, which is what makes token refresh invisible to the transport
 * layer: a stream that starts at 09:59 with a token expiring at 10:00 gets a
 * fresh one, and nothing upstream has to know.
 */
export interface AuthContext {
  readonly kind: 'codex' | 'apikey' | 'none';
  /** Human summary for `fib auth status`. Never contains a secret. */
  readonly description: string;
  headers(signal?: AbortSignal): Promise<Record<string, string>>;
}

/** Resolution order for an API key, most explicit first. */
function findApiKey(profileName: string, profile: ProfileConfig, stored: Credential | undefined): string | undefined {
  // 1. The env var the profile names (e.g. OPENAI_API_KEY, GROQ_API_KEY).
  if (profile.apiKeyEnv) {
    const v = process.env[profile.apiKeyEnv];
    if (v && v.trim() !== '') return v.trim();
  }
  // 2. A profile-specific override, e.g. FIBONACCI_API_KEY_OPENROUTER.
  const scoped = process.env[`FIBONACCI_API_KEY_${profileName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (scoped && scoped.trim() !== '') return scoped.trim();
  // 3. A generic override.
  const generic = process.env['FIBONACCI_API_KEY'];
  if (generic && generic.trim() !== '') return generic.trim();
  // 4. Whatever `fib auth login --api-key` saved.
  if (stored?.kind === 'apikey') return stored.key;
  return undefined;
}

export async function resolveAuth(profileName: string, profile: ProfileConfig): Promise<AuthContext> {
  const stored = await getCredential(profileName);

  if (profile.provider === 'codex') {
    // Link mode (default): read Codex's file through on every call.
    if (!stored || stored.kind === 'codex-link') {
      const preview = await ensureFreshCodexTokens();
      const acct = describeAccount(preview);
      const who = acct.email ? `${acct.email}` : acct.accountId;
      const plan = acct.planType ? ` · ${acct.planType}` : '';
      return {
        kind: 'codex',
        description: `ChatGPT subscription (${who}${plan}) — linked to the Codex CLI login`,
        async headers(signal?: AbortSignal) {
          const t = await ensureFreshCodexTokens(signal ? { signal } : {});
          return {
            Authorization: `Bearer ${t.access_token}`,
            'chatgpt-account-id': t.account_id,
          };
        },
      };
    }

    // Copy mode: our own snapshot, refreshed into our own store.
    if (stored.kind === 'codex-copy') {
      const acct = describeAccount(stored.tokens);
      const who = acct.email ?? acct.accountId;
      return {
        kind: 'codex',
        description: `ChatGPT subscription (${who}${acct.planType ? ` · ${acct.planType}` : ''}) — local copy`,
        async headers(signal?: AbortSignal) {
          const current = (await getCredential(profileName)) as CodexCopyCredential | undefined;
          const tokens = current?.kind === 'codex-copy' ? current.tokens : stored.tokens;
          const fresh = await refreshCopiedTokens(
            tokens,
            async (t) =>
              setCredential(profileName, { kind: 'codex-copy', tokens: t, lastRefresh: new Date().toISOString() }),
            signal,
          );
          return {
            Authorization: `Bearer ${fresh.access_token}`,
            'chatgpt-account-id': fresh.account_id,
          };
        },
      };
    }
  }

  // Everything else is an OpenAI-compatible endpoint behind a bearer key.
  const key = findApiKey(profileName, profile, stored);
  if (!key) {
    const envName = profile.apiKeyEnv ?? 'FIBONACCI_API_KEY';
    // A local server on localhost usually needs no key at all — don't block it.
    if (isLocalEndpoint(profile.baseUrl)) {
      return {
        kind: 'none',
        description: `Local endpoint ${profile.baseUrl} (no key)`,
        async headers() {
          return {};
        },
      };
    }
    throw new AuthError(`No API key for profile "${profileName}".`, `Set ${envName}, or run \`fib auth login --api-key --profile ${profileName}\`.`);
  }

  return {
    kind: 'apikey',
    description: `API key for "${profileName}"${profile.baseUrl ? ` at ${profile.baseUrl}` : ''}`,
    async headers() {
      return { Authorization: `Bearer ${key}` };
    },
  };
}

export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
  } catch {
    return false;
  }
}

export { describeAccount } from './codex.ts';
export * from './store.ts';
