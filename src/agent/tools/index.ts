import type { Tool } from './types.ts';
import { fileTools } from './fs.ts';
import { searchTools } from './search.ts';
import { bashTool } from './shell.ts';

export * from './types.ts';
export { fileTools, readTool, writeTool, editTool, listTool } from './fs.ts';
export { searchTools, globTool, grepTool } from './search.ts';
export { bashTool, classifyCommand, runCommand, DANGEROUS_PATTERNS } from './shell.ts';

/**
 * Tool order is not cosmetic. Models weight earlier tools slightly higher when
 * choosing, and the ordering here encodes the workflow we actually want:
 * orient (find/list), then read, then change, then verify by running something.
 */
export const ALL_TOOLS: Tool[] = [...searchTools, ...fileTools, bashTool];

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.spec.name === name);
}

/** Read-only subset, used by `fib ask` and any future review-only mode. */
export const READONLY_TOOLS: Tool[] = ALL_TOOLS.filter((t) => !t.needsApproval({}, 'suggest'));
