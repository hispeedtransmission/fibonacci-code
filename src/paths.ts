import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where Fibonacci keeps state.
 *
 * `FIBONACCI_HOME` overrides the root, which is what the test suite uses so it
 * never touches the developer's real credentials.
 */
export function fibonacciHome(): string {
  const override = process.env['FIBONACCI_HOME'];
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.fibonacci');
}

/** Credential store. Written 0600, never logged. */
export function authPath(): string {
  return join(fibonacciHome(), 'auth.json');
}

/** User-level settings. */
export function userConfigPath(): string {
  return join(fibonacciHome(), 'config.json');
}

/** Saved conversations. */
export function sessionsDir(): string {
  return join(fibonacciHome(), 'sessions');
}

/** REPL input history. */
export function historyPath(): string {
  return join(fibonacciHome(), 'history');
}

/**
 * The Codex CLI's own credential file. We read this to import an existing
 * ChatGPT subscription login; we never write to it.
 */
export function codexAuthPath(): string {
  const override = process.env['CODEX_HOME'];
  const root = override && override.trim() !== '' ? resolve(override) : join(homedir(), '.codex');
  return join(root, 'auth.json');
}

/** Project-level config, checked before user-level. */
export function projectConfigCandidates(cwd: string): string[] {
  return [join(cwd, '.fibonacci', 'config.json'), join(cwd, 'fibonacci.json')];
}
