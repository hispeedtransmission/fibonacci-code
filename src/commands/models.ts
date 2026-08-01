import type { ResolvedConfig } from '../config.ts';
import { ExitCode } from '../errors.ts';
import { createProvider } from '../providers/index.ts';
import { Style } from '../ui/ansi.ts';

/**
 * `fib models`.
 *
 * Deliberately answers a question the user actually has ("what can I type after
 * -m?") rather than dumping a raw API response. For the subscription backend
 * that means being explicit that the list is short *because the subscription
 * restricts it*, not because Fibonacci is being conservative — otherwise the
 * one-entry list reads like a bug.
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
        'ChatGPT subscriptions are limited to the models above; API-only models such as gpt-5-codex are\n' +
          'rejected by this endpoint. To reach those, use an API key: fib -P openai -m <model>.',
      )}\n`,
    );
  } else {
    out(`${Style.dim(`Select one with:  fib -P ${cfg.profileName} -m <id> "your prompt"`)}\n`);
  }
  return ExitCode.OK;
}
