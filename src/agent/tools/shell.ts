import { spawn } from 'node:child_process';
import { argOptionalNumber, argString, truncateForModel, type Tool, type ToolOutcome } from './types.ts';
import type { ApprovalMode } from '../../config.ts';

/**
 * Shell execution.
 *
 * There is no sandbox here, and pretending otherwise would be worse than being
 * clear about it: this runs commands as the user, with the user's permissions.
 * The defences are therefore procedural rather than technical, and there are
 * three of them:
 *
 *   1. **Approval by default.** Under `suggest` and `auto-edit`, every command
 *      needs an explicit yes.
 *   2. **An escalation list.** Commands matching the patterns below demand
 *      confirmation *even in `full-auto`*, and the prompt defaults to "no".
 *      `full-auto` is meant to remove friction from `npm test`, not to hand out
 *      an unsupervised `rm -rf`.
 *   3. **A timeout and a hard output cap**, so a runaway process cannot hang
 *      the CLI or eat the context window.
 *
 * The escalation list is deliberately a *blocklist of shapes*, not an attempt
 * at a safe-command allowlist. An allowlist for shell is unwinnable — `sh -c`,
 * `env`, `xargs`, backticks and a hundred other forms defeat it. This list
 * exists to catch the plausible accident, not the determined adversary, and the
 * README says exactly that.
 */

/** Patterns that force a confirmation prompt regardless of approval mode. */
export const DANGEROUS_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, why: 'recursive or forced delete' },
  { pattern: /\bsudo\b|\bdoas\b/, why: 'privilege escalation' },
  { pattern: /\b(mkfs|fdisk|diskutil\s+erase|dd\s+if=)/, why: 'disk-level operation' },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777/, why: 'world-writable permissions' },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/, why: 'force push — can destroy remote history' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, why: 'discards uncommitted work' },
  { pattern: /\bcurl\b[^|]*\|\s*(ba)?sh|\bwget\b[^|]*\|\s*(ba)?sh/, why: 'pipes a remote script straight into a shell' },
  { pattern: /\bnpm\s+publish\b|\bpoetry\s+publish\b|\btwine\s+upload\b/, why: 'publishes a package publicly' },
  { pattern: /\b(shutdown|reboot|halt)\b/, why: 'shuts the machine down' },
  { pattern: />\s*\/dev\/(sd|disk|nvme)/, why: 'writes directly to a block device' },
  { pattern: /\b(kill(all)?)\s+(-9\s+)?-1\b/, why: 'kills every process' },
];

export function classifyCommand(command: string): { dangerous: boolean; why?: string } {
  for (const { pattern, why } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return { dangerous: true, why };
  }
  return { dangerous: false };
}

const MAX_OUTPUT_BYTES = 200_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Run a command with a timeout, capping captured output.
 *
 * `detached: true` plus killing the negative pid matters: without a process
 * group, killing the shell leaves its children (a dev server, a test runner)
 * orphaned and still holding the port.
 */
export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env['SHELL'] ?? '/bin/sh');
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      // Escalate if it ignores SIGTERM.
      setTimeout(() => kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs);

    const onAbort = () => {
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 1000).unref();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (stdoutBytes > MAX_OUTPUT_BYTES) stdout += `\n… [stdout truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      if (stderrBytes > MAX_OUTPUT_BYTES) stderr += `\n… [stderr truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      resolve({ stdout, stderr, code, signal, timedOut });
    };

    child.on('close', finish);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

export const bashTool: Tool = {
  spec: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root. Use this for builds, tests, linters, git, and package managers. ' +
      'Prefer the dedicated file tools over `cat`/`sed`/`echo >` — they are safer and produce better diffs. ' +
      'Commands run without a sandbox, so destructive ones will be shown to the user for confirmation.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        description: {
          type: 'string',
          description: 'A short human-readable explanation of why, shown in the approval prompt.',
        },
        timeout: { type: 'number', description: 'Seconds before the command is killed.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },

  summarize: (args) => {
    const cmd = String(args['command'] ?? '?').replace(/\s+/g, ' ').trim();
    return `run   ${cmd.length > 72 ? `${cmd.slice(0, 71)}…` : cmd}`;
  },

  needsApproval(args, mode: ApprovalMode) {
    // The escalation list overrides full-auto; that is the whole point of it.
    if (classifyCommand(String(args['command'] ?? '')).dangerous) return true;
    return mode !== 'full-auto';
  },

  async run(args, ctx): Promise<ToolOutcome> {
    const command = argString(args, 'command');
    const why = (args['description'] as string | undefined)?.trim();
    const timeoutSec = argOptionalNumber(args, 'timeout') ?? ctx.commandTimeout;
    const { dangerous, why: dangerWhy } = classifyCommand(command);

    if (this.needsApproval(args, ctx.approval)) {
      const ok = await ctx.requestApproval({
        tool: 'run_command',
        summary: why ? `${why}` : 'Run a shell command',
        detail: command,
        ...(dangerous ? { dangerous: true } : {}),
      });
      if (!ok) {
        return {
          output: `The user declined to run this command${dangerWhy ? ` (flagged: ${dangerWhy})` : ''}. Suggest an alternative or ask what they want.`,
          isError: true,
        };
      }
    }

    let result: RunResult;
    try {
      result = await runCommand(command, {
        cwd: ctx.root,
        timeoutMs: Math.max(1, timeoutSec) * 1000,
        signal: ctx.signal,
      });
    } catch (err) {
      return { output: `Error: could not start the command: ${(err as Error).message}`, isError: true };
    }

    const parts: string[] = [];
    if (result.stdout.trim() !== '') parts.push(result.stdout.trimEnd());
    if (result.stderr.trim() !== '') parts.push(`[stderr]\n${result.stderr.trimEnd()}`);

    if (result.timedOut) {
      parts.push(`\n[timed out after ${timeoutSec}s and was killed]`);
    } else if (result.code !== 0) {
      parts.push(`\n[exit code ${result.code ?? `signal ${result.signal}`}]`);
    }

    const body = parts.join('\n') || '[no output]';
    return {
      output: truncateForModel(body),
      isError: result.timedOut || (result.code !== null && result.code !== 0),
    };
  },
};
