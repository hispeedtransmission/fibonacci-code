import type { ResolvedConfig } from '../config.ts';
import { ExitCode } from '../errors.ts';
import { createProvider } from '../providers/index.ts';
import { Style } from '../ui/ansi.ts';

/**
 * `fib models`.
 *
 * Deliberately answers a question the user actually has ("what can I type after
 * -m?") rather than dumping a raw API response. A static subscription catalog
 * offers suggestions, not an exhaustive gate on explicit model IDs.
 */
export async function modelsCommand(cfg: ResolvedConfig, asJson: boolean): Promise<number> {
  const { provider, model: current } = await createProvider(cfg);
  const models = await provider.listModels();

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ profile: cfg.profileName, current, models }, null, 2)}\n`);
    return ExitCode.OK;
  }

  const out = (s: string) => process.stdout.write(s);
  out(`${Style.bold(provider.label)} ${Style.dim(`· profile "${cfg.profileName}"`)}\n\n`);

  if (models.length === 0) {
    out(`${Style.dim('The endpoint returned no models.')}\n`);
    return ExitCode.OK;
  }

  const width = Math.max(...models.map((m) => m.id.length));
  for (const m of models) {
    const marker = m.id === current ? Style.green('●') : ' ';
    const ctx = m.contextWindow ? Style.dim(`  ${(m.contextWindow / 1000).toFixed(0)}k context`) : '';
    const label = m.label && m.label !== m.id ? Style.dim(`  ${m.label}`) : '';
    out(`  ${marker} ${m.id.padEnd(width)}${label}${ctx}\n`);
  }

  out('\n');
  if (provider.isSubscription) {
    out(
      `${Style.dim(
        'These are static suggestions, not an exhaustive list of subscription models.\n' +
          'Try an explicit ID with -m <id> or /model <id>; the service determines account availability.',
      )}\n`,
    );
  } else {
    out(`${Style.dim(`Select one with:  fib -P ${cfg.profileName} -m <id> "your prompt"`)}\n`);
  }
  return ExitCode.OK;
}
