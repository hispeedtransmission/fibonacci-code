import { createInterface, type Interface } from 'node:readline/promises';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { APPROVAL_MODES, type ApprovalMode, type ResolvedConfig } from '../config.ts';
import { ExitCode, CancelledError } from '../errors.ts';
import { createProvider } from '../providers/index.ts';
import type { Provider } from '../providers/types.ts';
import { Agent } from '../agent/loop.ts';
import { ALL_TOOLS } from '../agent/tools/index.ts';
import { buildSystemPrompt, PROJECT_DOC_FILES } from '../agent/prompt.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';
import { VERSION } from '../version.ts';
import { fibonacciHome, historyPath } from '../paths.ts';
import { sanitizeInline, sanitizeMultiline, Style } from '../ui/ansi.ts';
import {
  banner,
  brandPrompt,
  diffLines,
  formatUsage,
  labeledPanel,
  Spinner,
  statusPanel,
  terminalWidth,
  toolLine,
  wrapText,
} from '../ui/render.ts';
import { modelMenu, resolveModelChoice, resolveRequestedModel } from '../ui/model-selector.ts';
import { completeRepl } from '../ui/completion.ts';

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

const err = (s: string) => process.stderr.write(s);
const out = (s: string) => process.stdout.write(s);

let activeTurnController: AbortController | undefined;
let activeIdleQuestionController: AbortController | undefined;
let cancelActiveQuestion: (() => void) | undefined;
let activeSpinner: Spinner | undefined;

export function routeInteractiveSigint(
  controller: AbortController | undefined,
  cancelQuestion: (() => void) | undefined,
  resetIdle: () => void,
): 'cancelled' | 'reset' {
  if (controller) controller.abort();
  if (controller || cancelQuestion) {
    cancelQuestion?.();
    return 'cancelled';
  }
  resetIdle();
  return 'reset';
}

export function slashArgumentError(cmd: string, args: string[]): string | undefined {
  if (['exit', 'quit', 'help', 'clear', 'usage', 'status'].includes(cmd) && args.length > 0) return `Usage: /${cmd}`;
  if (cmd === 'approval' && args.length > 1) return 'Usage: /approval <mode>';
  return undefined;
}

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
  const { provider, auth, model: requestedModel } = await createProvider(cfg);
  const model = await resolveRequestedModel(provider, requestedModel);

  const projectDoc = await loadProjectDoc(cwd);
  const instructions = (activeModel: string, activeApproval: ApprovalMode) => {
    const branch = currentBranch(cwd);
    return buildSystemPrompt({
      cwd,
      approval: activeApproval,
      model: activeModel,
      ...(projectDoc ? { projectDoc } : {}),
      ...(branch ? { gitBranch: branch } : {}),
    });
  };

  let rl: Interface | undefined;
  const ensureReadline = (): Interface => {
    if (!rl) {
      rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: process.stdin.isTTY === true,
        completer: completeRepl,
      });
      const created = rl;
      created.on('SIGINT', () =>
        routeInteractiveSigint(activeTurnController, cancelActiveQuestion, () => activeIdleQuestionController?.abort()),
      );
    }
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
    let code: number;
    try {
      code = await runTurn(agent, prompt, opts.quiet);
    } finally {
      rl?.close();
    }
    return code;
  }

  try {
    return await repl(agent, provider, ensureReadline(), opts);
  } finally {
    rl?.close();
  }
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
  activeTurnController = controller;
  let terminated = false;
  const onSigint = () => controller.abort();
  const onSigterm = () => {
    terminated = true;
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const spinner = new Spinner();
  if (!quiet) activeSpinner = spinner;

  /**
   * True when the cursor is parked mid-row because we streamed text without a
   * trailing newline. Anything that writes to the terminal next — a tool line,
   * a diff, the usage footer — must close the row first, or it lands on top of
   * the answer.
   */
  let midLine = false;
  let incomplete = false;
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
          const text = sanitizeMultiline(event.text ?? '');
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
          if (!quiet) spinner.start(event.tool?.summary ?? 'working');
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

        case 'incomplete':
          spinner.stop();
          closeLine();
          incomplete = true;
          err(
            event.text === 'refusal'
              ? `${Style.yellow('!')} The provider refused to complete this response.\n`
              : `${Style.yellow('!')} The response reached its output limit and may be incomplete.\n`,
          );
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

    if (controller.signal.aborted) {
      err(`${Style.dim('Cancelled.')}\n`);
      return terminated ? ExitCode.TERMINATED : ExitCode.CANCELLED;
    }

    const usage = agent.usage;
    if (!quiet && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      err(`${Style.dim(formatUsage(usage))}\n`);
    }
    return incomplete ? ExitCode.GENERIC : ExitCode.OK;
  } catch (e) {
    spinner.stop();
    if (e instanceof CancelledError || controller.signal.aborted) {
      err(`\n${Style.dim('Cancelled.')}\n`);
      return terminated ? ExitCode.TERMINATED : ExitCode.CANCELLED;
    }
    throw e;
  } finally {
    spinner.stop();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (activeTurnController === controller) activeTurnController = undefined;
    if (activeSpinner === spinner) activeSpinner = undefined;
  }
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function safeErrorMessage(error: unknown): string {
  return sanitizeInline(error instanceof Error ? error.message : String(error));
}

/** The approval prompt. Defaults to "no" for anything flagged dangerous. */
async function askApproval(rl: Interface, req: ApprovalRequest): Promise<boolean> {
  activeSpinner?.stop();
  err('\n');
  const safeSummary = sanitizeInline(req.summary);
  if (req.detail) {
    const safeDetail = sanitizeMultiline(req.detail);
    const looksLikeDiff = safeDetail.startsWith('---') || safeDetail.includes('\n@@');
    err(looksLikeDiff ? `${diffLines(safeDetail)}\n` : `${Style.cyan('$')} ${safeDetail}\n`);
  }

  if (req.dangerous) {
    err(`${Style.red('⚠  This looks destructive.')} ${Style.bold(safeSummary)}\n`);
  } else {
    err(`${Style.bold(safeSummary)}\n`);
  }

  const suffix = req.dangerous ? '[y/N]' : '[Y/n]';
  const cancelThisQuestion = () => rl.write('n\n');
  cancelActiveQuestion = cancelThisQuestion;
  const closeOnSignal = () => rl.close();
  process.once('SIGINT', closeOnSignal);
  process.once('SIGTERM', closeOnSignal);
  let rawAnswer: string | undefined;
  try {
    rawAnswer = await questionOrEof(rl, `${Style.dim(`Allow? ${suffix} `)}`);
  } finally {
    process.removeListener('SIGINT', closeOnSignal);
    process.removeListener('SIGTERM', closeOnSignal);
    if (cancelActiveQuestion === cancelThisQuestion) cancelActiveQuestion = undefined;
  }
  if (rawAnswer === undefined) throw new CancelledError('Input closed during approval');
  const answer = rawAnswer.trim().toLowerCase();

  const approved = req.dangerous ? answer === 'y' || answer === 'yes' : answer === '' || answer === 'y' || answer === 'yes';
  activeSpinner?.start(approved ? 'running approved tool' : 'recording denial');
  return approved;
}

function slashHelp(): string {
  return labeledPanel(
    'FBNC / COMMAND INDEX',
    [
      ['/help', 'Show this'],
      ['/clear', 'Forget the conversation so far'],
      ['/model [id]', 'Choose a model for future turns'],
      ['/status', 'Show the live session HUD'],
      ['/usage', 'Token usage this session'],
      ['/approval <m>', 'suggest | auto-edit | full-auto'],
      ['/exit, /quit', 'Leave (Ctrl-D also works)'],
    ],
    terminalWidth(),
  );
}

export async function questionOrEof(
  questioner: { question(prompt: string, options?: { signal?: AbortSignal }): Promise<string> },
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await questioner.question(prompt, signal ? { signal } : undefined);
  } catch {
    return undefined;
  }
}

async function repl(agent: Agent, provider: Provider, rl: Interface, opts: RunOptions): Promise<number> {
  const history = await loadHistory();
  err(`${Style.dim(wrapText('INSTRUMENT READY · /help commands · Ctrl-D exit', terminalWidth()))}\n\n`);

  // Seed readline's history so up-arrow works across sessions.
  const rlAny = rl as unknown as { history?: string[] };
  if (Array.isArray(rlAny.history)) rlAny.history = history.slice().reverse();

  for (;;) {
    const idleQuestion = new AbortController();
    activeIdleQuestionController = idleQuestion;
    let line: string | undefined;
    try {
      line = await questionOrEof(rl, brandPrompt(), idleQuestion.signal);
    } finally {
      if (activeIdleQuestionController === idleQuestion) activeIdleQuestionController = undefined;
    }
    if (line === undefined) {
      if (idleQuestion.signal.aborted) continue;
      break;
    }

    const input = line.trim();
    if (input === '') continue;

    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);
      const argumentError = slashArgumentError(cmd ?? '', args);
      if (argumentError) {
        err(`${Style.yellow('!')} ${argumentError}\n`);
        continue;
      }
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') {
        err(`${slashHelp()}\n`);
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
      if (cmd === 'status') {
        const branch = currentBranch(opts.cwd);
        err(
          `${statusPanel(
            {
              model: agent.model,
              provider: provider.label,
              approval: agent.approval,
              cwd: opts.cwd,
              ...(branch ? { branch } : {}),
              usage: formatUsage(agent.usage),
            },
            terminalWidth(),
          )}\n`,
        );
        continue;
      }
      if (cmd === 'model') {
        const requested = args.join(' ').trim();
        if (requested !== '') {
          try {
            agent.setModel(await resolveRequestedModel(provider, requested));
            err(`${Style.green('✓')} Model set to ${Style.bold(agent.model)} for future turns.\n`);
          } catch (error) {
            err(`${Style.yellow('!')} ${safeErrorMessage(error)} Current model: ${agent.model}.\n`);
          }
          continue;
        }

        let models;
        try {
          models = await provider.listModels();
        } catch (error) {
          err(`${Style.yellow('!')} Could not list models: ${safeErrorMessage(error)}. Current model: ${agent.model}.\n`);
          continue;
        }
        if (models.length === 0) {
          err(`${Style.dim(`No model list is available. Set one explicitly with /model <id>. Current: ${agent.model}`)}\n`);
          continue;
        }

        err(`${modelMenu(models, agent.model, terminalWidth())}\n`);
        const cancelModelQuestion = () => rl.write('q\n');
        cancelActiveQuestion = cancelModelQuestion;
        let answer: string | undefined;
        try {
          answer = await questionOrEof(rl, `${Style.dim(`Model [${agent.model}]: `)}`);
        } finally {
          if (cancelActiveQuestion === cancelModelQuestion) cancelActiveQuestion = undefined;
        }
        if (answer === undefined) break;
        try {
          const selected = resolveModelChoice(answer, models, agent.model);
          if (selected === undefined) {
            err(`${Style.dim('Model selection cancelled.')}\n`);
          } else {
            agent.setModel(selected);
            err(`${Style.green('✓')} Model set to ${Style.bold(agent.model)} for future turns.\n`);
          }
        } catch (error) {
          err(`${Style.yellow('!')} ${safeErrorMessage(error)}\n`);
        }
        continue;
      }
      if (cmd === 'approval') {
        const requested = args[0];
        if (requested === undefined || requested === '') {
          err(`${Style.dim(`Current approval mode: ${agent.approval}. Choose: ${APPROVAL_MODES.join(' | ')}`)}\n`);
          continue;
        }
        if (!APPROVAL_MODES.includes(requested as ApprovalMode)) {
          err(`${Style.yellow('!')} Unknown approval mode "${sanitizeInline(requested)}". Choose: ${APPROVAL_MODES.join(' | ')}\n`);
          continue;
        }
        agent.setApproval(requested as ApprovalMode);
        err(`${Style.green('✓')} Approval mode set to ${Style.bold(agent.approval)} for future tools.\n`);
        continue;
      }
      err(`${Style.dim(`Unknown command /${sanitizeInline(cmd ?? '')}. Try /help.`)}\n`);
      continue;
    }

    await saveHistory(input);
    const turnCode = await runTurn(agent, input, opts.quiet);
    if (turnCode === ExitCode.TERMINATED) {
      rl.close();
      return turnCode;
    }
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

export async function saveHistory(line: string): Promise<void> {
  try {
    await mkdir(fibonacciHome(), { recursive: true, mode: 0o700 });
    await appendFile(historyPath(), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // History is a convenience; never fail a turn over it.
  }
}
