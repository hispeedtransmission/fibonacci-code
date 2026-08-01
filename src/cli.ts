#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExitCode, FibonacciError, UsageError, CancelledError } from './errors.ts';
import { loadConfig, APPROVAL_MODES, type ApprovalMode, type ConfigOverrides } from './config.ts';
import { VERSION, REPO_URL } from './version.ts';
import { setColorEnabled, Style, supportsColor } from './ui/ansi.ts';
import type { ReasoningEffort } from './providers/types.ts';

/**
 * Entry point.
 *
 * Argument parsing uses `node:util.parseArgs` rather than commander/yargs —
 * consistent with the zero-dependency rule, and adequate because this CLI has a
 * flat flag set and a handful of subcommands. What parseArgs does not give us
 * is good errors, so unknown flags and bad enum values are turned into
 * `UsageError`s with the valid alternatives listed, which is most of what an
 * arg-parsing library actually buys you.
 */

const HELP = `${Style.bold('fibonacci')} — a terminal coding agent on your own subscription

${Style.bold('USAGE')}
  fib                          Start an interactive session in the current directory
  fib "<prompt>"               Run one prompt and print the answer
  fib -p "<prompt>"            Same, explicit
  cat file | fib "<prompt>"    Pipe stdin in as context

${Style.bold('COMMANDS')}
  auth login                   Sign in (defaults to reusing your Codex/ChatGPT login)
  auth status                  Show who you are signed in as
  auth logout                  Remove stored credentials
  models                       List models available on the current profile
  config                       Show the resolved configuration and where it came from

${Style.bold('OPTIONS')}
  -p, --prompt <text>          One-shot prompt
  -P, --profile <name>         Profile to use (default: codex)
  -m, --model <id>             Model id
      --base-url <url>         Override the endpoint for OpenAI-compatible profiles
  -a, --approval <mode>        suggest | auto-edit | full-auto  (default: suggest)
  -y, --yes                    Shorthand for --approval full-auto
      --effort <level>         none | low | medium | high | xhigh
      --max-turns <n>          Cap model round-trips per message (default: 40)
  -C, --cwd <dir>              Workspace root (default: current directory)
  -q, --quiet                  Suppress the banner and progress chrome
      --no-color               Disable colour
  -v, --version                Print the version
  -h, --help                   Show this help

${Style.bold('EXAMPLES')}
  fib                                        Interactive session
  fib "why does the build fail?"             One-shot question
  fib -y "add tests for src/parser.ts"       Let it work unattended
  fib -P ollama -m qwen3-coder               Use a local model
  git diff | fib "review this change"        Pipe context in

${Style.dim(`Docs: ${REPO_URL}`)}
`;

interface ParsedCli {
  command: string[];
  overrides: ConfigOverrides;
  prompt?: string;
  cwd: string;
  quiet: boolean;
  help: boolean;
  version: boolean;
  /** Flags consumed by subcommands. */
  flags: Record<string, string | boolean | undefined>;
}

function parseCli(argv: string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        prompt: { type: 'string', short: 'p' },
        profile: { type: 'string', short: 'P' },
        model: { type: 'string', short: 'm' },
        'base-url': { type: 'string' },
        approval: { type: 'string', short: 'a' },
        yes: { type: 'boolean', short: 'y' },
        effort: { type: 'string' },
        'max-turns': { type: 'string' },
        cwd: { type: 'string', short: 'C' },
        quiet: { type: 'boolean', short: 'q' },
        'no-color': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        // Subcommand flags.
        codex: { type: 'boolean' },
        'api-key': { type: 'boolean' },
        copy: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    // parseArgs says "Unknown option '--fooo'". Add the fix.
    throw new UsageError(message, 'Run `fib --help` to see the available options.');
  }

  const { values, positionals } = parsed;

  const overrides: ConfigOverrides = {};
  if (values.profile) overrides.profile = values.profile;
  if (values.model) overrides.model = values.model;
  if (values['base-url']) overrides.baseUrl = values['base-url'];

  if (values.approval) {
    if (!(APPROVAL_MODES as readonly string[]).includes(values.approval)) {
      throw new UsageError(
        `Invalid --approval value "${values.approval}".`,
        `Valid modes: ${APPROVAL_MODES.join(', ')}.`,
      );
    }
    overrides.approval = values.approval as ApprovalMode;
  }
  // --yes is a shorthand, and loses to an explicit --approval.
  if (values.yes && !overrides.approval) overrides.approval = 'full-auto';

  if (values.effort) {
    const valid: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
    if (!valid.includes(values.effort as ReasoningEffort)) {
      throw new UsageError(`Invalid --effort value "${values.effort}".`, `Valid levels: ${valid.join(', ')}.`);
    }
    overrides.reasoningEffort = values.effort as ReasoningEffort;
  }

  if (values['max-turns']) {
    const n = Number.parseInt(values['max-turns'], 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new UsageError(`Invalid --max-turns value "${values['max-turns']}".`, 'Give a positive integer.');
    }
    overrides.maxTurns = n;
  }

  if (values['no-color']) overrides.noColor = true;

  const out: ParsedCli = {
    command: positionals,
    overrides,
    cwd: resolve(values.cwd ?? process.cwd()),
    quiet: values.quiet === true,
    help: values.help === true,
    version: values.version === true,
    flags: {
      codex: values.codex,
      'api-key': values['api-key'],
      copy: values.copy,
      json: values.json,
    },
  };
  if (values.prompt) out.prompt = values.prompt;
  return out;
}

/** Read piped stdin, if any. Returns '' when stdin is a terminal. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function reportError(err: unknown): number {
  if (err instanceof CancelledError) {
    process.stderr.write(`\n${Style.dim('Cancelled.')}\n`);
    return ExitCode.CANCELLED;
  }
  if (err instanceof FibonacciError) {
    process.stderr.write(`\n${Style.red('error')} ${err.message}\n`);
    if (err.hint) process.stderr.write(`${Style.dim(err.hint)}\n`);
    return err.exitCode;
  }
  const e = err as Error;
  process.stderr.write(`\n${Style.red('error')} ${e?.message ?? String(err)}\n`);
  if (process.env['FIBONACCI_DEBUG'] && e?.stack) process.stderr.write(`${Style.dim(e.stack)}\n`);
  else process.stderr.write(`${Style.dim('Set FIBONACCI_DEBUG=1 for a stack trace.')}\n`);
  return ExitCode.GENERIC;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let cli: ParsedCli;
  try {
    cli = parseCli(argv);
  } catch (err) {
    return reportError(err);
  }

  // Colour must be settled before anything prints, including help.
  setColorEnabled(!cli.overrides.noColor && supportsColor(process.stdout));

  if (cli.version) {
    process.stdout.write(`fibonacci ${VERSION}\n`);
    return ExitCode.OK;
  }
  if (cli.help || cli.command[0] === 'help') {
    process.stdout.write(HELP);
    return ExitCode.OK;
  }

  try {
    const cfg = await loadConfig(cli.cwd, cli.overrides);
    const [command, ...rest] = cli.command;

    switch (command) {
      case 'auth': {
        const { authCommand } = await import('./commands/auth.ts');
        return await authCommand(rest, cfg, cli.flags);
      }
      case 'models': {
        const { modelsCommand } = await import('./commands/models.ts');
        return await modelsCommand(cfg, cli.flags['json'] === true);
      }
      case 'config': {
        const { configCommand } = await import('./commands/config.ts');
        return await configCommand(cfg, cli.flags['json'] === true);
      }
      default: {
        // Anything else is a prompt: `fib "fix the build"`.
        const stdin = await readStdin();
        const positionalPrompt = cli.command.join(' ').trim();
        const explicit = cli.prompt?.trim() ?? '';
        const promptParts = [explicit || positionalPrompt, stdin.trim()].filter((s) => s !== '');
        const prompt = promptParts.join('\n\n');

        const { runCommand } = await import('./commands/run.ts');
        return await runCommand({
          cfg,
          cwd: cli.cwd,
          quiet: cli.quiet,
          ...(prompt !== '' ? { prompt } : {}),
          // Interactive only when there is nothing to run and a terminal to run
          // it on. `fib < /dev/null` must not hang waiting at a prompt.
          interactive: prompt === '' && process.stdin.isTTY === true,
        });
      }
    }
  } catch (err) {
    return reportError(err);
  }
}

/**
 * Only run when invoked as a program, so the test suite can import `main`
 * without the CLI executing itself on import.
 *
 * Both sides MUST be realpath'd. `npm install -g` installs the package under
 * `lib/node_modules/...` and symlinks `bin/fib` at it, so `process.argv[1]` is
 * the symlink while `import.meta.url` is the resolved target. Comparing them
 * literally makes this false for every globally installed user — the binary
 * then exits 0 having done nothing at all, which is both catastrophic and
 * completely silent. `pnpm`, `yarn` and `bun` all symlink similarly.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.exitCode = reportError(err);
    });
}
