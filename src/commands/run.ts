import { createInterface, type Interface } from 'node:readline/promises';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ResolvedConfig } from '../config.ts';
import { ExitCode, CancelledError } from '../errors.ts';
import { createProvider } from '../providers/index.ts';
import { Agent } from '../agent/loop.ts';
import { ALL_TOOLS } from '../agent/tools/index.ts';
import { buildSystemPrompt, PROJECT_DOC_FILES } from '../agent/prompt.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';
import { VERSION } from '../version.ts';
import { fibonacciHome, historyPath } from '../paths.ts';
import { Style } from '../ui/ansi.ts';
import { banner, diffLines, formatUsage, Spinner, toolLine } from '../ui/render.ts';

/**
 * The run command: one-shot and interactive.
 *
 * Stream discipline is the thing to notice here. Assistant prose goes to
 * **stdout**; the banner, tool lines, spinner, approvals and token counts go to
 * **stderr**. That is what makes `fib "..." > notes.md` produce a clean file and
 * `git diff | fib "review" | pbcopy` do the obvious thing, while an interactive
 * user — whose terminal shows both streams — notices nothing.
 */

export interface RunOptions {
  cfg: ResolvedConfig;
  cwd: string;
  quiet: boolean;
  prompt?: string;
  interactive: boolean;
}

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

/** Load repo-specific instructions, first match wins. */
async function loadProjectDoc(cwd: string): Promise<string | undefined> {
  for (const name of PROJECT_DOC_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const text = await readFile(path, 'utf8');
      // A very long doc crowds out the conversation; take the head and say so.
      if (text.length > 12_000) {
        return `${text.slice(0, 12_000)}\n\n[… ${name} truncated at 12,000 characters]`;
      }
      return text;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function currentBranch(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined; // Not a repo, or no git. Neither is an error.
  }
}

export async function runCommand(opts: RunOptions): Promise<number> {
  const { cfg, cwd } = opts;
  const { provider, auth, model } = await createProvider(cfg);

  const projectDoc = await loadProjectDoc(cwd);
  const branch = currentBranch(cwd);
  const instructions = buildSystemPrompt({
    cwd,
    approval: cfg.approval,
    model,
    ...(projectDoc ? { projectDoc } : {}),
    ...(branch ? { gitBranch: branch } : {}),
  });

  let rl: Interface | undefined;
  const ensureReadline = (): Interface => {
    rl ??= createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    return rl;
  };

  const agent = new Agent({
    provider,
    model,
    instructions,
    tools: ALL_TOOLS,
    root: cwd,
    approval: cfg.approval,
    maxTurns: cfg.maxTurns,
    commandTimeout: cfg.commandTimeout,
    ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
    requestApproval: (req) => askApproval(ensureReadline(), req),
  });

  if (!opts.quiet && (opts.interactive || process.stderr.isTTY)) {
    err(
      banner({
        cwd,
        model,
        provider: auth.description,
        approval: cfg.approval,
        version: VERSION,
      }),
    );
    err('\n');
  }

  if (!opts.interactive) {
    const prompt = opts.prompt ?? '';
    if (prompt.trim() === '') {
      err(`${Style.red('error')} No prompt given and stdin is not a terminal.\n`);
      err(`${Style.dim('Try: fib "your question"   or   fib --help')}\n`);
      return ExitCode.USAGE;
    }
    const code = await runTurn(agent, prompt, opts.quiet);
    rl?.close();
    return code;
  }

  return await repl(agent, ensureReadline(), opts, model);
}

/**
 * Render one exchange.
 *
 * Ctrl-C during a turn aborts that turn only; the session survives. The handler
 * is installed per turn and removed after, so a Ctrl-C at the idle prompt still
 * does the normal readline thing.
 */
async function runTurn(agent: Agent, prompt: string, quiet: boolean): Promise<number> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);

  const spinner = new Spinner();

  /**
   * True when the cursor is parked mid-row because we streamed text without a
   * trailing newline. Anything that writes to the terminal next — a tool line,
   * a diff, the usage footer — must close the row first, or it lands on top of
   * the answer.
   */
  let midLine = false;
  const closeLine = () => {
    if (midLine) {
      out('\n');
      midLine = false;
    }
  };

  try {
    if (!quiet) spinner.start('thinking');

    for await (const event of agent.send(prompt, controller.signal)) {
      switch (event.type) {
        case 'text_delta': {
          const text = event.text ?? '';
          if (text === '') break;
          spinner.stop(); // no-op unless the spinner still owns the row
          out(text);
          midLine = !text.endsWith('\n');
          break;
        }

        case 'reasoning_delta':
          // Only meaningful while the spinner is live; once prose is streaming
          // the label has nowhere to go.
          if (!quiet) spinner.update(firstLine(event.text ?? '') || 'thinking');
          break;

        case 'tool_start':
          // Deliberately prints nothing. The line is emitted once, on
          // completion, with its real status — printing on start too would
          // double every entry in piped output, where there is no cursor to
          // overwrite.
          if (!quiet) spinner.update(event.tool?.summary ?? 'working');
          break;

        case 'tool_end':
          spinner.stop();
          closeLine();
          if (!quiet && event.tool) {
            err(`${toolLine({ summary: event.tool.summary, status: event.tool.ok ? 'ok' : 'error' })}\n`);
            if (event.tool.display) err(`${diffLines(event.tool.display)}\n`);
          }
          if (!quiet) spinner.start('thinking');
          break;

        case 'usage':
          break;

        case 'turn_end':
          spinner.stop();
          break;

        case 'limit_reached':
          spinner.stop();
          closeLine();
          err(
            `${Style.yellow('!')} Stopped after ${event.turn} turns without finishing. ` +
              `${Style.dim('Raise the cap with --max-turns, or narrow the request.')}\n`,
          );
          break;
      }
    }

    spinner.stop();
    closeLine();

    const usage = agent.usage;
    if (!quiet && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      err(`${Style.dim(formatUsage(usage))}\n`);
    }
    return ExitCode.OK;
  } catch (e) {
    spinner.stop();
    if (e instanceof CancelledError || controller.signal.aborted) {
      err(`\n${Style.dim('Cancelled.')}\n`);
      return ExitCode.CANCELLED;
    }
    throw e;
  } finally {
    spinner.stop();
    process.removeListener('SIGINT', onSigint);
  }
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The approval prompt. Defaults to "no" for anything flagged dangerous. */
async function askApproval(rl: Interface, req: ApprovalRequest): Promise<boolean> {
  err('\n');
  if (req.detail) {
    const looksLikeDiff = req.detail.startsWith('---') || req.detail.includes('\n@@');
    err(looksLikeDiff ? `${diffLines(req.detail)}\n` : `${Style.cyan('$')} ${req.detail}\n`);
  }

  if (req.dangerous) {
    err(`${Style.red('⚠  This looks destructive.')} ${Style.bold(req.summary)}\n`);
  } else {
    err(`${Style.bold(req.summary)}\n`);
  }

  const suffix = req.dangerous ? '[y/N]' : '[Y/n]';
  const answer = (await rl.question(`${Style.dim(`Allow? ${suffix} `)}`)).trim().toLowerCase();

  if (req.dangerous) return answer === 'y' || answer === 'yes';
  return answer === '' || answer === 'y' || answer === 'yes';
}

const SLASH_HELP = `${Style.bold('Slash commands')}
  /help            Show this
  /clear           Forget the conversation so far
  /model <id>      Not persisted — restart with -m to change model
  /usage           Token usage this session
  /approval <m>    suggest | auto-edit | full-auto
  /exit, /quit     Leave  (Ctrl-D also works)
`;

async function repl(agent: Agent, rl: Interface, opts: RunOptions, model: string): Promise<number> {
  const history = await loadHistory();
  err(`${Style.dim('Type your request. /help for commands, Ctrl-D to exit.')}\n\n`);

  // Seed readline's history so up-arrow works across sessions.
  const rlAny = rl as unknown as { history?: string[] };
  if (Array.isArray(rlAny.history)) rlAny.history = history.slice().reverse();

  for (;;) {
    let line: string;
    try {
      line = await rl.question(`${Style.bold(Style.yellow('❯ '))}`);
    } catch {
      break; // Ctrl-D closes the interface.
    }

    const input = line.trim();
    if (input === '') continue;

    if (input.startsWith('/')) {
      const [cmd] = input.slice(1).split(/\s+/);
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') {
        err(SLASH_HELP);
        continue;
      }
      if (cmd === 'clear') {
        agent.reset();
        err(`${Style.dim('Conversation cleared.')}\n`);
        continue;
      }
      if (cmd === 'usage') {
        err(`${Style.dim(formatUsage(agent.usage))}\n`);
        continue;
      }
      if (cmd === 'model') {
        err(
          `${Style.dim(`Current model: ${model}. Changing model mid-session is not supported — restart with -m <id>.`)}\n`,
        );
        continue;
      }
      if (cmd === 'approval') {
        err(`${Style.dim(`Approval mode is fixed for the session (${opts.cfg.approval}). Restart with -a <mode>.`)}\n`);
        continue;
      }
      err(`${Style.dim(`Unknown command /${cmd ?? ''}. Try /help.`)}\n`);
      continue;
    }

    await saveHistory(input);
    await runTurn(agent, input, opts.quiet);
    err('\n');
  }

  rl.close();
  err(`${Style.dim('Bye.')}\n`);
  return ExitCode.OK;
}

async function loadHistory(): Promise<string[]> {
  try {
    const text = await readFile(historyPath(), 'utf8');
    return text.split('\n').filter((l) => l.trim() !== '').slice(-500);
  } catch {
    return [];
  }
}

async function saveHistory(line: string): Promise<void> {
  try {
    await mkdir(fibonacciHome(), { recursive: true, mode: 0o700 });
    await appendFile(historyPath(), `${line}\n`, 'utf8');
  } catch {
    // History is a convenience; never fail a turn over it.
  }
}
