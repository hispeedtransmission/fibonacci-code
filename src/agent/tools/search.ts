import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { globMatch, walk } from '../../fsx/walk.ts';
import { resolveInWorkspace } from '../../fsx/safe.ts';
import {
  argOptionalNumber,
  argOptionalString,
  argString,
  ToolArgError,
  truncateForModel,
  type Tool,
  type ToolOutcome,
} from './types.ts';

/**
 * Search tools.
 *
 * These are implemented in-process rather than by shelling out to `rg`/`grep`,
 * for three reasons: ripgrep is not installed everywhere, shelling out would
 * route around the approval system that governs `run_command`, and an external
 * grep does not know about our workspace containment rules. The cost is that we
 * are slower than ripgrep on a huge tree — which is why both tools cap their
 * work and say so in the output rather than silently returning a partial list.
 */

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 2_000_000;

/**
 * NUL, constructed rather than written as a literal so that no invisible
 * control byte lives in this source file. A NUL anywhere in a file is the same
 * heuristic git uses to decide something is binary.
 */
const NUL = String.fromCharCode(0);

export const globTool: Tool = {
  spec: {
    name: 'find_files',
    description:
      'Find files by glob pattern, e.g. "src/**/*.ts" or "**/test_*.py". Respects .gitignore. ' +
      'Use this to discover the shape of a project before reading individual files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' },
        limit: { type: 'number', description: `Maximum paths to return. Default ${MAX_MATCHES}.` },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },

  summarize: (args) => `find  ${String(args['pattern'] ?? '?')}`,
  needsApproval: () => false,

  async run(args, ctx): Promise<ToolOutcome> {
    const pattern = argString(args, 'pattern');
    const limit = Math.min(1000, Math.max(1, argOptionalNumber(args, 'limit') ?? MAX_MATCHES));

    const matches: string[] = [];
    let scanned = 0;
    for await (const rel of walk(ctx.root, { signal: ctx.signal })) {
      scanned++;
      if (globMatch(pattern, rel)) {
        matches.push(rel);
        if (matches.length >= limit) break;
      }
    }

    if (matches.length === 0) {
      return {
        output:
          `No files matched "${pattern}" (scanned ${scanned} files). ` +
          'Try a broader pattern — patterns match against paths relative to the workspace root.',
      };
    }
    const capped = matches.length >= limit ? `\n\n[stopped at ${limit} matches]` : '';
    return { output: truncateForModel(`${matches.join('\n')}${capped}`) };
  },
};

export const grepTool: Tool = {
  spec: {
    name: 'search_text',
    description:
      'Search file contents with a regular expression. Returns matching lines with file path and line number. ' +
      'Narrow the search with `glob` (e.g. "src/**/*.ts") when you know the file type.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        path: { type: 'string', description: 'Subdirectory to search. Default is the workspace root.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
        limit: { type: 'number', description: `Maximum matching lines. Default ${MAX_MATCHES}.` },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },

  summarize: (args) => {
    const p = String(args['pattern'] ?? '?');
    const g = args['glob'] ? ` in ${String(args['glob'])}` : '';
    return `grep  ${p.length > 48 ? `${p.slice(0, 47)}…` : p}${g}`;
  },
  needsApproval: () => false,

  async run(args, ctx): Promise<ToolOutcome> {
    const pattern = argString(args, 'pattern');
    const glob = argOptionalString(args, 'glob');
    const sub = argOptionalString(args, 'path');
    const ignoreCase = args['ignore_case'] === true || args['ignore_case'] === 'true';
    const limit = Math.min(1000, Math.max(1, argOptionalNumber(args, 'limit') ?? MAX_MATCHES));

    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (err) {
      throw new ToolArgError(`\`pattern\` is not a valid regular expression: ${(err as Error).message}`);
    }

    const searchRoot = sub ? resolveInWorkspace(ctx.root, sub) : ctx.root;
    if (!existsSync(searchRoot)) return { output: `Error: no such directory: ${sub}`, isError: true };

    const lines: string[] = [];
    let filesSearched = 0;
    let filesWithMatches = 0;

    for await (const rel of walk(searchRoot, { signal: ctx.signal })) {
      if (ctx.signal.aborted) break;
      if (glob && !globMatch(glob, rel)) continue;

      const abs = resolveInWorkspace(searchRoot, rel);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      // Skip binaries cheaply rather than emitting mojibake matches.
      if (content.includes(NUL)) continue;

      filesSearched++;
      const displayPath = searchRoot === ctx.root ? rel : `${relative(ctx.root, searchRoot)}/${rel}`;
      let matchedHere = false;

      const fileLines = content.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i];
        if (line === undefined) continue;
        if (!re.test(line)) continue;
        matchedHere = true;
        const shown = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        lines.push(`${displayPath}:${i + 1}: ${shown.trimEnd()}`);
        if (lines.length >= limit) break;
      }
      if (matchedHere) filesWithMatches++;
      if (lines.length >= limit) break;
    }

    if (lines.length === 0) {
      return { output: `No matches for /${pattern}/${ignoreCase ? 'i' : ''} across ${filesSearched} files.` };
    }
    const capped = lines.length >= limit ? `\n\n[stopped at ${limit} matches]` : '';
    const summary = `\n\n${lines.length} match${lines.length === 1 ? '' : 'es'} in ${filesWithMatches} file${filesWithMatches === 1 ? '' : 's'}.`;
    return { output: truncateForModel(`${lines.join('\n')}${summary}${capped}`) };
  },
};

export const searchTools: Tool[] = [globTool, grepTool];
