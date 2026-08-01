import type { ToolSpec } from '../../providers/types.ts';
import type { ApprovalMode } from '../../config.ts';
import { UsageError } from '../../errors.ts';

/**
 * The tool contract.
 *
 * A design point worth stating plainly: the JSON Schema we hand the model is
 * documentation, not enforcement. Models emit arguments that violate their own
 * schema — wrong types, missing required fields, a stringified number, an
 * object where an array belongs. Every tool therefore re-validates at the
 * boundary with the `arg*` helpers below and returns a *readable* error the
 * model can act on, because a tool error is not a crash: it goes back into the
 * transcript and the model gets to try again. "Expected `path` to be a string,
 * got number" is a recoverable turn. A TypeError stack trace is not.
 */

export interface ToolProgress {
  kind: 'start' | 'update' | 'end';
  text: string;
}

export interface ApprovalRequest {
  /** Tool name, for the prompt header. */
  tool: string;
  /** One-line description of what is about to happen. */
  summary: string;
  /** Optional detail — a unified diff, or the command text. */
  detail?: string;
  /** Escalated prompts are worded more strongly and default to "no". */
  dangerous?: boolean;
}

export interface ToolContext {
  /** Absolute workspace root. Nothing may be read or written outside it. */
  root: string;
  approval: ApprovalMode;
  signal: AbortSignal;
  commandTimeout: number;
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  emit(progress: ToolProgress): void;
}

export interface ToolOutcome {
  /** What the model sees. */
  output: string;
  isError?: boolean;
  /** What the user sees, when it differs (e.g. a colourized diff). */
  display?: string;
}

export interface Tool {
  readonly spec: ToolSpec;
  /** One-line summary for the UI, derived from arguments. Must not throw. */
  summarize(args: Record<string, unknown>): string;
  /** Whether this invocation needs a human yes under the given mode. */
  needsApproval(args: Record<string, unknown>, mode: ApprovalMode): boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Thrown for malformed tool arguments. Caught by the loop and fed back to the model. */
export class ToolArgError extends UsageError {}

export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new ToolArgError(`Expected \`${key}\` to be a string, got ${describeType(v)}.`);
  }
  return v;
}

export function argOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new ToolArgError(`Expected \`${key}\` to be a string, got ${describeType(v)}.`);
  }
  return v;
}

export function argOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  // Models frequently emit "10" where the schema says number. Accepting a
  // numeric string here converts a wasted round-trip into a successful call.
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ToolArgError(`Expected \`${key}\` to be a number, got ${describeType(v)}.`);
  }
  return v;
}

export function argOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (typeof v !== 'boolean') {
    throw new ToolArgError(`Expected \`${key}\` to be a boolean, got ${describeType(v)}.`);
  }
  return v;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Truncate tool output before it reaches the model.
 *
 * Unbounded output is the classic way an agent burns a context window: one
 * `grep` across a monorepo returns 400k characters and the conversation is
 * over. We keep the head and the tail, because the informative parts of
 * command output are usually at both ends and never in the middle.
 */
export function truncateForModel(text: string, limit = 24_000): string {
  if (text.length <= limit) return text;
  const keep = Math.floor(limit / 2) - 60;
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n… [${omitted.toLocaleString()} characters omitted] …\n\n${tail}`;
}
