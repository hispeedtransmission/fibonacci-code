import type { ResolvedConfig } from '../config.ts';
import { ExitCode } from '../errors.ts';
import { Style } from '../ui/ansi.ts';
import { userConfigPath, fibonacciHome } from '../paths.ts';

/**
 * `fib config`.
 *
 * Shows the *resolved* configuration and, critically, which files produced it.
 * "Why is it using the wrong model?" is nearly always a forgotten project-level
 * config or an exported environment variable, and a settings dump that does not
 * name its sources cannot answer that question.
 */
export async function configCommand(cfg: ResolvedConfig, asJson: boolean): Promise<number> {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return ExitCode.OK;
  }

  const out = (s: string) => process.stdout.write(s);
  const row = (k: string, v: string, note = '') =>
    out(`  ${k.padEnd(16)} ${v}${note ? `  ${Style.dim(note)}` : ''}\n`);

  out(`${Style.bold('Resolved configuration')}\n\n`);
  row('profile', cfg.profileName);
  row('provider', cfg.profile.provider);
  if (cfg.profile.baseUrl) row('baseUrl', cfg.profile.baseUrl);
  row('model', cfg.model ?? cfg.profile.model ?? Style.dim('(provider default)'));
  row('approval', cfg.approval);
  row('effort', cfg.reasoningEffort);
  row('maxTurns', String(cfg.maxTurns));
  row('commandTimeout', `${cfg.commandTimeout}s`);

  out(`\n${Style.bold('Sources')} ${Style.dim('(later entries override earlier)')}\n`);
  out(`  ${Style.dim('built-in defaults')}\n`);
  for (const s of cfg.sources) out(`  ${s}\n`);

  const envKeys = Object.keys(process.env)
    .filter((k) => k.startsWith('FIBONACCI_') || k === 'OPENAI_BASE_URL' || k === 'NO_COLOR')
    .sort();
  if (envKeys.length > 0) {
    out(`  ${Style.dim(`environment: ${envKeys.join(', ')}`)}\n`);
  }
  if (cfg.sources.length === 0) {
    out(`\n${Style.dim(`No config file yet. Create one at ${userConfigPath()} to set defaults.`)}\n`);
  }

  out(`\n${Style.bold('Profiles')}\n`);
  for (const [name, p] of Object.entries(cfg.profiles).sort(([a], [b]) => a.localeCompare(b))) {
    const marker = name === cfg.profileName ? Style.green('●') : ' ';
    const detail = p.provider === 'codex' ? 'ChatGPT subscription' : (p.baseUrl ?? '');
    out(`  ${marker} ${name.padEnd(12)} ${Style.dim(detail)}\n`);
  }

  out(`\n${Style.dim(`State directory: ${fibonacciHome()}`)}\n`);
  return ExitCode.OK;
}
