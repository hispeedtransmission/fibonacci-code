import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { UsageError } from './errors.ts';

/**
 * User-owned integration, not repository executable policy. Rules fail visibly;
 * optional desktop startup must never export conversation data or block a run.
 * Hook programs are trusted local code with the user's environment/permissions.
 */

/** Launch only user-configured argv, once per run; output is never model context. */
export async function runStartupCommand(command: string[], interactive: boolean): Promise<'ok' | 'failed' | 'skipped'> {
  if (!command.length || process.env['FIBONACCI_STARTUP_ACTIVE'] === '1' || process.env['FIBONACCI_DISABLE_STARTUP'] === '1') return 'skipped';
  return await new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      shell: false,
      timeout: 3000,
      killSignal: 'SIGKILL',
      env: { ...process.env, FIBONACCI_STARTUP_ACTIVE: '1' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', () => resolve('failed'));
    child.once('close', (code) => resolve(code === 0 ? 'ok' : 'failed'));
    child.stdin.on('error', () => {}); // Early child exit must not crash the CLI.
    child.stdin.end(JSON.stringify({ session_id: randomUUID(), interactive, headless: !interactive }));
  });
}

export async function loadGlobalInstructions(path: string): Promise<string> {
  if (!path) return '';
  try {
    // Nonblocking open also prevents a misconfigured FIFO from hanging startup.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('not a regular file');
      const bytes = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65_536) throw new Error('over 64 KiB');
      return bytes.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    throw new UsageError('Cannot load global instructions.', 'Check globalInstructionsFile in your user config: it must name a readable regular file of at most 64 KiB.');
  }
}
