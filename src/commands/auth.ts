import { createInterface } from 'node:readline/promises';
import type { ResolvedConfig } from '../config.ts';
import { ExitCode, UsageError } from '../errors.ts';
import { Style } from '../ui/ansi.ts';
import { authPath, codexAuthPath } from '../paths.ts';
import { describeAccount, requireCodexTokens } from '../auth/codex.ts';
import { deleteCredential, listCredentialProfiles, redact, setCredential, getCredential } from '../auth/store.ts';
import { resolveAuth } from '../auth/index.ts';

/**
 * `fib auth`.
 *
 * The interesting decision is the default: `fib auth login` with no flags links
 * the existing Codex CLI login rather than asking for an API key. Most people
 * running this already pay for ChatGPT, and the fastest path to a working tool
 * is the one that spends nothing extra.
 */

const err = (s: string) => process.stderr.write(s);
const out = (s: string) => process.stdout.write(s);

export async function authCommand(
  args: string[],
  cfg: ResolvedConfig,
  flags: Record<string, string | boolean | undefined>,
): Promise<number> {
  const sub = args[0] ?? 'status';

  switch (sub) {
    case 'login':
      return await login(cfg, flags);
    case 'status':
      return await status(cfg);
    case 'logout':
      return await logout(cfg);
    default:
      throw new UsageError(`Unknown subcommand \`auth ${sub}\`.`, 'Valid subcommands: login, status, logout.');
  }
}

async function login(cfg: ResolvedConfig, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const wantsApiKey = flags['api-key'] === true;
  const wantsCodex = flags['codex'] === true || (!wantsApiKey && cfg.profile.provider === 'codex');

  if (wantsCodex) {
    const tokens = await requireCodexTokens();
    const account = describeAccount(tokens);

    if (flags['copy'] === true) {
      await setCredential('codex', {
        kind: 'codex-copy',
        tokens,
        lastRefresh: new Date().toISOString(),
      });
      err(`${Style.yellow('!')} Copied the tokens into ${authPath()}.\n`);
      err(
        `${Style.dim(
          '  Because OpenAI rotates refresh tokens, this copy and the Codex CLI will eventually diverge and one of\n' +
            '  them will need re-authenticating. Prefer the default link mode unless you specifically want isolation.',
        )}\n`,
      );
    } else {
      await setCredential('codex', {
        kind: 'codex-link',
        codexAuthFile: codexAuthPath(),
        linkedAt: new Date().toISOString(),
      });
      err(`${Style.green('✓')} Linked to your Codex CLI login.\n`);
      err(`${Style.dim(`  Reading through ${codexAuthPath()} — no second copy of your tokens is stored.`)}\n`);
    }

    err('\n');
    err(`  Account   ${account.email ?? account.accountId}\n`);
    if (account.planType) err(`  Plan      ${account.planType}\n`);
    err(`  Expires   ${new Date(account.expiresAt).toLocaleString()}\n\n`);
    err(`${Style.dim('Try it: ')}fib "what does this project do?"\n`);
    return ExitCode.OK;
  }

  // API-key path.
  const profileName = cfg.profileName === 'codex' ? 'openai' : cfg.profileName;
  const profile = cfg.profiles[profileName];
  if (!profile) {
    throw new UsageError(
      `No profile named "${profileName}".`,
      `Known profiles: ${Object.keys(cfg.profiles).sort().join(', ')}`,
    );
  }

  if (!process.stdin.isTTY) {
    throw new UsageError(
      'Cannot prompt for an API key because stdin is not a terminal.',
      `Set the key in the environment instead: export ${profile.apiKeyEnv ?? 'FIBONACCI_API_KEY'}=...`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  err(`Signing in to ${Style.bold(profileName)}${profile.baseUrl ? ` (${profile.baseUrl})` : ''}.\n`);
  err(
    `${Style.dim(
      `Tip: an environment variable is usually better — ${profile.apiKeyEnv ?? 'FIBONACCI_API_KEY'} is read automatically.`,
    )}\n\n`,
  );

  const key = (await rl.question('API key: ')).trim();
  rl.close();

  if (key === '') {
    err(`${Style.red('error')} No key entered.\n`);
    return ExitCode.AUTH;
  }

  await setCredential(profileName, {
    kind: 'apikey',
    profile: profileName,
    key,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    createdAt: new Date().toISOString(),
  });

  err(`\n${Style.green('✓')} Saved to ${authPath()} ${Style.dim('(0600)')}\n`);
  err(`${Style.dim(`  Use it with: fib -P ${profileName} "your prompt"`)}\n`);
  return ExitCode.OK;
}

async function status(cfg: ResolvedConfig): Promise<number> {
  out(`${Style.bold('Active profile')}  ${cfg.profileName}\n`);

  try {
    const auth = await resolveAuth(cfg.profileName, cfg.profile);
    out(`${Style.bold('Credential')}      ${Style.green('✓')} ${auth.description}\n`);

    if (cfg.profile.provider === 'codex') {
      const tokens = await requireCodexTokens();
      const account = describeAccount(tokens);
      const remaining = account.expiresAt - Date.now();
      const hours = Math.round(remaining / 3_600_000);
      out(`${Style.bold('Access token')}    valid for ~${hours}h ${Style.dim(`(refreshes automatically)`)}\n`);
    }
  } catch (e) {
    out(`${Style.bold('Credential')}      ${Style.red('✗')} ${(e as Error).message}\n`);
    const hint = (e as { hint?: string }).hint;
    if (hint) out(`${Style.dim(`                ${hint}`)}\n`);
  }

  const stored = await listCredentialProfiles();
  out(`\n${Style.bold('Stored credentials')} ${Style.dim(authPath())}\n`);
  if (stored.length === 0) {
    out(`  ${Style.dim('(none)')}\n`);
  } else {
    for (const name of stored) {
      const cred = await getCredential(name);
      const detail =
        cred?.kind === 'apikey'
          ? redact(cred.key)
          : cred?.kind === 'codex-link'
            ? `link → ${cred.codexAuthFile}`
            : cred?.kind === 'codex-copy'
              ? `copy, refreshed ${cred.lastRefresh}`
              : '';
      out(`  ${name.padEnd(12)} ${Style.dim(detail)}\n`);
    }
  }

  // Report the ambient env that would be picked up, since a stale exported key
  // silently overriding a stored one is a genuinely confusing failure.
  const envNames = ['OPENAI_API_KEY', 'FIBONACCI_API_KEY', cfg.profile.apiKeyEnv].filter(
    (n): n is string => typeof n === 'string',
  );
  const present = [...new Set(envNames)].filter((n) => (process.env[n] ?? '') !== '');
  if (present.length > 0) {
    out(`\n${Style.bold('Environment')}     ${present.map((n) => `${n}=${Style.dim('set')}`).join('  ')}\n`);
    out(`${Style.dim('                Environment variables take precedence over stored keys.')}\n`);
  }

  return ExitCode.OK;
}

async function logout(cfg: ResolvedConfig): Promise<number> {
  const removed = await deleteCredential(cfg.profileName);
  if (removed) {
    err(`${Style.green('✓')} Removed the stored credential for "${cfg.profileName}".\n`);
    if (cfg.profile.provider === 'codex') {
      err(`${Style.dim('  Your Codex CLI login is untouched — Fibonacci only stored a pointer to it.')}\n`);
    }
  } else {
    err(`${Style.dim(`No stored credential for "${cfg.profileName}".`)}\n`);
  }
  return ExitCode.OK;
}
