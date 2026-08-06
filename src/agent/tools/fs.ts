import { readFile, writeFile, mkdir, stat, readdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertNotSensitive, resolveInWorkspace } from '../../fsx/safe.ts';
import { unifiedDiff, diffStat } from '../../fsx/diff.ts';
import {
  argOptionalBoolean,
  argOptionalNumber,
  argString,
  ToolArgError,
  truncateForModel,
  type Tool,
  type ToolOutcome,
} from './types.ts';
import type { ApprovalMode } from '../../config.ts';
import { CancelledError } from '../../errors.ts';

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

/**
 * File tools.
 *
 * The `edit` tool deserves a note, because the choice here is the single
 * biggest determinant of whether an agent can actually modify code reliably.
 *
 * Line-number-based editing fails constantly: the model's view of the file is
 * from a previous turn, and any earlier edit shifts every line below it. So
 * `edit` is **exact string replacement** with a uniqueness requirement — the
 * model supplies enough surrounding context to identify one site, and we refuse
 * ambiguous matches rather than guessing. A refusal is a cheap retry; a wrong
 * guess silently corrupts the user's source.
 */

/** Refuse to load a file large enough to blow the context window. */
const MAX_READ_BYTES = 1_000_000;
const DEFAULT_READ_LIMIT = 2000;

/** Heuristic: a NUL byte in the first 8 KiB means binary. Same test `git` uses. */
async function looksBinary(path: string): Promise<boolean> {
  const handle = await readFile(path);
  const probe = handle.subarray(0, 8192);
  return probe.includes(0);
}

function formatWithLineNumbers(text: string, startLine: number): string {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width, ' ')}\t${line}`).join('\n');
}

export const readTool: Tool = {
  spec: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Returns the contents with line numbers. ' +
      'Use `offset` and `limit` for large files. Always read a file before editing it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'number', description: '1-based line to start from. Default 1.' },
        limit: { type: 'number', description: `Maximum lines to return. Default ${DEFAULT_READ_LIMIT}.` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  summarize: (args) => `read  ${String(args['path'] ?? '?')}`,
  needsApproval: () => false, // Reading inside the workspace is always allowed.

  async run(args, ctx): Promise<ToolOutcome> {
    const rel = argString(args, 'path');
    const abs = resolveInWorkspace(ctx.root, rel);
    assertNotSensitive(abs);

    if (!existsSync(abs)) {
      // Offer the nearest sibling names — a wrong path is usually a typo or a
      // stale memory of the tree, and listing the directory fixes both.
      const parent = dirname(abs);
      let hint = '';
      if (existsSync(parent)) {
        const siblings = (await readdir(parent)).slice(0, 20);
        if (siblings.length > 0) hint = ` Directory contains: ${siblings.join(', ')}`;
      }
      return { output: `Error: no such file: ${rel}.${hint}`, isError: true };
    }

    const info = await stat(abs);
    if (info.isDirectory()) {
      return { output: `Error: ${rel} is a directory. Use list_dir to see its contents.`, isError: true };
    }
    if (info.size > MAX_READ_BYTES) {
      return {
        output: `Error: ${rel} is ${(info.size / 1e6).toFixed(1)} MB, too large to read whole. Use offset/limit, or grep it.`,
        isError: true,
      };
    }
    if (await looksBinary(abs)) {
      return { output: `Error: ${rel} appears to be a binary file (${info.size} bytes).`, isError: true };
    }

    const content = await readFile(abs, 'utf8');
    const allLines = content.split('\n');
    const offset = Math.max(1, argOptionalNumber(args, 'offset') ?? 1);
    const limit = Math.max(1, argOptionalNumber(args, 'limit') ?? DEFAULT_READ_LIMIT);
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    if (slice.length === 0) {
      return { output: `Error: offset ${offset} is past the end of ${rel} (${allLines.length} lines).`, isError: true };
    }

    const body = formatWithLineNumbers(slice.join('\n'), offset);
    const shown = offset + slice.length - 1;
    const footer =
      shown < allLines.length
        ? `\n\n[showing lines ${offset}–${shown} of ${allLines.length}; call again with offset=${shown + 1} for more]`
        : '';
    return { output: truncateForModel(body + footer) };
  },
};

/** Atomic write: temp file in the same directory, then rename. */
async function atomicWrite(abs: string, content: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export const writeTool: Tool = {
  spec: {
    name: 'write_file',
    description:
      'Create a new file or replace an existing one entirely. Parent directories are created as needed. ' +
      'To change part of an existing file, prefer edit_file — it is safer and cheaper.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete new file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },

  summarize: (args) => `write ${String(args['path'] ?? '?')}`,
  needsApproval: (_args, mode: ApprovalMode) => mode === 'suggest',

  async run(args, ctx): Promise<ToolOutcome> {
    const rel = argString(args, 'path');
    const content = argString(args, 'content');
    const abs = resolveInWorkspace(ctx.root, rel);
    assertNotSensitive(abs);

    const existed = existsSync(abs);
    const before = existed ? await readFile(abs, 'utf8') : '';
    const patch = unifiedDiff(before, content, { oldLabel: existed ? rel : '/dev/null', newLabel: rel });

    if (existed && patch === '') {
      return { output: `No change: ${rel} already has these exact contents.` };
    }

    if (this.needsApproval(args, ctx.approval)) {
      const ok = await ctx.requestApproval({
        tool: 'write_file',
        summary: existed ? `Overwrite ${rel}` : `Create ${rel}`,
        detail: patch,
      });
      if (!ok) return { output: 'The user declined this write. Ask what they would prefer.', isError: true };
    }

    throwIfCancelled(ctx.signal);
    await atomicWrite(abs, content);
    const { added, removed } = diffStat(patch);
    return {
      output: `${existed ? 'Updated' : 'Created'} ${rel} (+${added} −${removed}, ${content.split('\n').length} lines).`,
      display: patch,
    };
  },
};

export const editTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. `old_string` must appear EXACTLY ONCE — include enough surrounding ' +
      'context (whole lines, correct indentation) to make it unique. Set replace_all to change every occurrence. ' +
      'Read the file first so the text you match is current.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        old_string: { type: 'string', description: 'Exact text to find, including whitespace.' },
        new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },

  summarize: (args) => `edit  ${String(args['path'] ?? '?')}`,
  needsApproval: (_args, mode: ApprovalMode) => mode === 'suggest',

  async run(args, ctx): Promise<ToolOutcome> {
    const rel = argString(args, 'path');
    const oldString = argString(args, 'old_string');
    const newString = argString(args, 'new_string');
    const replaceAll = argOptionalBoolean(args, 'replace_all') ?? false;

    if (oldString === newString) {
      throw new ToolArgError('`old_string` and `new_string` are identical; nothing to do.');
    }

    const abs = resolveInWorkspace(ctx.root, rel);
    assertNotSensitive(abs);
    if (!existsSync(abs)) return { output: `Error: no such file: ${rel}`, isError: true };

    const before = await readFile(abs, 'utf8');
    const occurrences = countOccurrences(before, oldString);

    if (occurrences === 0) {
      // The overwhelmingly common cause is whitespace drift, so say so rather
      // than leaving the model to guess why an obviously-present string missed.
      const collapsed = countOccurrences(before.replace(/[ \t]+/g, ' '), oldString.replace(/[ \t]+/g, ' '));
      const nudge =
        collapsed > 0
          ? ' The text is present but the whitespace differs — re-read the file and copy the indentation exactly.'
          : ' Re-read the file; it may have changed.';
      return { output: `Error: \`old_string\` not found in ${rel}.${nudge}`, isError: true };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        output:
          `Error: \`old_string\` appears ${occurrences} times in ${rel}. ` +
          'Add surrounding context to make it unique, or pass replace_all: true.',
        isError: true,
      };
    }

    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    const patch = unifiedDiff(before, after, { oldLabel: rel, newLabel: rel });

    if (this.needsApproval(args, ctx.approval)) {
      const ok = await ctx.requestApproval({
        tool: 'edit_file',
        summary: `Edit ${rel}${replaceAll ? ` (${occurrences} occurrences)` : ''}`,
        detail: patch,
      });
      if (!ok) return { output: 'The user declined this edit. Ask what they would prefer.', isError: true };
    }

    throwIfCancelled(ctx.signal);
    await atomicWrite(abs, after);
    const { added, removed } = diffStat(patch);
    return {
      output: `Edited ${rel} (+${added} −${removed}${replaceAll ? `, ${occurrences} occurrences` : ''}).`,
      display: patch,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const listTool: Tool = {
  spec: {
    name: 'list_dir',
    description: 'List the entries of a directory in the workspace. Directories are marked with a trailing slash.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root. Default is the root.' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  summarize: (args) => `list  ${String(args['path'] ?? '.')}`,
  needsApproval: () => false,

  async run(args, ctx): Promise<ToolOutcome> {
    const rel = (args['path'] as string | undefined) ?? '.';
    const abs = resolveInWorkspace(ctx.root, rel);
    if (!existsSync(abs)) return { output: `Error: no such directory: ${rel}`, isError: true };

    const info = await stat(abs);
    if (!info.isDirectory()) return { output: `Error: ${rel} is a file, not a directory.`, isError: true };

    const entries = await readdir(abs, { withFileTypes: true });
    const skip = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
    const rows = entries
      .filter((e) => !skip.has(e.name))
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

    const hidden = entries.length - rows.length;
    const suffix = hidden > 0 ? `\n\n[${hidden} entries hidden: build artefacts and VCS metadata]` : '';
    const display = relative(ctx.root, abs) || '.';
    return {
      output: truncateForModel(
        rows.length > 0 ? `${display}${sep}\n${rows.join('\n')}${suffix}` : `${display} is empty.${suffix}`,
      ),
    };
  },
};

export const fileTools: Tool[] = [readTool, writeTool, editTool, listTool];

/** Exported for tests that need a scratch workspace path helper. */
export function workspaceJoin(root: string, ...parts: string[]): string {
  return join(root, ...parts);
}
