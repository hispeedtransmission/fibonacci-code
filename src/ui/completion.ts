import { APPROVAL_MODES } from '../config.ts';

const COMMANDS = ['/help', '/clear', '/model', '/status', '/usage', '/approval', '/exit', '/quit'] as const;

/** Readline completer for discoverable slash commands without touching normal prompts. */
export function completeRepl(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];

  if (line.startsWith('/approval ')) {
    const prefix = line.slice('/approval '.length);
    const matches = APPROVAL_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => `/approval ${mode}`);
    return [matches, line];
  }

  if (!line.includes(' ')) {
    return [COMMANDS.filter((command) => command.startsWith(line)), line];
  }

  return [[], line];
}
