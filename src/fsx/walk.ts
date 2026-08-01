/**
 * Gitignore-aware file walking, zero-dependency.
 *
 * The tension: a genuinely useful walker needs hierarchical `.gitignore`
 * support (a nested `.gitignore` only governs its own subtree, and rules
 * compose — later/deeper rules override earlier/shallower ones, negation can
 * re-include), which means carrying a stack of compiled rule sets down the
 * tree rather than a single flat ignore list. It also needs real loop
 * protection: a symlinked directory pointed at an ancestor is a classic way
 * to make a naive recursive walker hang forever.
 *
 * What this does NOT implement (documented rather than silently wrong):
 *   - `.git/info/exclude` or `core.excludesFile` — only per-directory
 *     `.gitignore` files under `root` are read.
 *   - Backslash-escaped literal slashes (`foo\/bar`) — the pattern is split
 *     on every literal `/` before escape processing runs, so an escaped
 *     slash can't be represented as part of one segment.
 *   - A `]` as the very first character of a `[...]` class being treated as
 *     a literal member (a POSIX glob nuance) — write the class in another
 *     order instead.
 *   - Mid-class backslash escapes (`[\]]`) — a `\` inside `[...]` is a
 *     literal backslash character, not an escape.
 *   - Collapsing redundant consecutive globstar segments (e.g. two `**`
 *     segments back to back) — write a single globstar between two
 *     segments, not several.
 *   - Trailing-whitespace preservation via a backslash escape — trailing
 *     spaces/tabs are always trimmed.
 *
 * `globMatch` is the raw pattern-vs-path matcher and is always anchored
 * (matches the whole `path` string against `pattern`, no implicit "any
 * depth" for a slash-less pattern) — that "no slash means match at any
 * depth" rule is a `.gitignore`-line convention, applied only when parsing ignore rules,
 * not a property of the matcher itself.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Dirent } from 'node:fs';

/** Skipped unconditionally, regardless of any `.gitignore` rule (including a `!` negation). */
export const ALWAYS_SKIP: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'target',
  '.DS_Store',
]);

const DEFAULT_MAX_ENTRIES = 20000;

export interface WalkOptions {
  /** Stop cleanly (no throw) after yielding this many entries. Default 20000. */
  maxEntries?: number;
  /** Caps how many directory levels are entered: 0 lists only root's direct entries, 1 also enters immediate subdirectories, etc. Default: unlimited. */
  maxDepth?: number;
  /** Also yield directory paths, not just files. Default false. */
  includeDirs?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Glob compilation, shared by the .gitignore engine and the exported globMatch.
// ---------------------------------------------------------------------------

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate one path segment (no `/`, no bare `**`) into a regex source fragment. */
function segmentToRegexSource(segment: string): string {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] as string;
    if (ch === '\\' && i + 1 < segment.length) {
      out += escapeRegexChar(segment[i + 1] as string);
      i += 2;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let body = segment.slice(i + 1, close);
      let negate = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true;
        body = body.slice(1);
      }
      // Neutralize characters special to a *JS* character class that aren't
      // special to a glob one; ranges (a-z) and plain members pass through.
      const safeBody = body.replace(/\\/g, '\\\\').replace(/\^/g, '\\^');
      out += `[${negate ? '^' : ''}${safeBody}]`;
      i = close + 1;
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

const GLOBSTAR = Symbol('globstar');
type Segment = string | typeof GLOBSTAR;

function segmentsOf(pattern: string): Segment[] {
  return pattern.split('/').map((s) => (s === '**' ? GLOBSTAR : s));
}

function buildRegexBody(segments: readonly Segment[]): string {
  if (segments.length === 1 && segments[0] === GLOBSTAR) return '.*';

  let body = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === GLOBSTAR) {
      if (i === segments.length - 1) {
        body += '(?:/.*)?'; // trailing /**: zero or more of "/anything"
      } else if (i === 0) {
        body += '(?:.*/)?'; // leading **/: zero or more full directories
      } else {
        body += '/(?:.*/)?'; // middle /**/: a slash, then zero or more full directories
      }
    } else {
      const prev = segments[i - 1];
      const needsSlash = i > 0 && prev !== GLOBSTAR;
      if (needsSlash) body += '/';
      body += segmentToRegexSource(seg as string);
    }
  }
  return body;
}

/**
 * Compile a glob pattern to a regex. `impliedAnyDepth` prepends an optional
 * "any number of leading directories" group — used for `.gitignore` lines
 * with no internal slash, which git matches at any depth.
 */
function compilePattern(pattern: string, impliedAnyDepth: boolean): RegExp {
  const body = buildRegexBody(segmentsOf(pattern));
  const prefix = impliedAnyDepth ? '(?:.*/)?' : '';
  return new RegExp(`^${prefix}${body}$`);
}

/** Match `pattern` (the subset documented at the top of this file) against `path`, full-string, anchored. */
export function globMatch(pattern: string, path: string): boolean {
  const posixPath = path.replace(/\\/g, '/');
  return compilePattern(pattern, false).test(posixPath);
}

// ---------------------------------------------------------------------------
// .gitignore parsing
// ---------------------------------------------------------------------------

interface IgnoreRule {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
}

function parseIgnoreLine(rawLine: string): IgnoreRule | null {
  let line = rawLine.replace(/[ \t]+$/, '');
  if (line === '') return null;

  if (line.startsWith('\\#')) {
    line = line.slice(1); // literal '#...' pattern, not a comment
  } else if (line.startsWith('#')) {
    return null;
  }

  let negate = false;
  if (line.startsWith('\\!')) {
    line = line.slice(1); // literal '!...' pattern, not a negation
  } else if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  if (line === '') return null;

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === '') return null;

  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  if (line === '') return null;

  return { negate, dirOnly, regex: compilePattern(line, !anchored) };
}

async function loadIgnoreRules(gitignorePath: string): Promise<IgnoreRule[]> {
  let content: string;
  try {
    content = await readFile(gitignorePath, 'utf8');
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r\n|\n/)) {
    const rule = parseIgnoreLine(rawLine);
    if (rule) rules.push(rule);
  }
  return rules;
}

interface IgnoreLevel {
  readonly dir: string; // absolute
  readonly rules: readonly IgnoreRule[];
}

function toPosixRelative(base: string, target: string): string {
  return relative(base, target).split(sep).join('/');
}

/** Last matching rule across every applicable level wins — same semantics as real git. */
function isIgnored(stack: readonly IgnoreLevel[], entryAbs: string, isDir: boolean): boolean {
  let ignored = false;
  for (const level of stack) {
    const relToLevel = toPosixRelative(level.dir, entryAbs);
    for (const rule of level.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(relToLevel)) ignored = !rule.negate;
    }
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * Walk `root`, yielding workspace-relative POSIX-style paths, honoring
 * hierarchical `.gitignore` rules plus the hardcoded {@link ALWAYS_SKIP} list.
 *
 * Symlinked directories are never entered (unconditional loop protection);
 * a non-symlink directory that resolves to an already-visited realpath
 * (hardlink / bind-mount aliasing) is also skipped, as a second, independent
 * guard against the same class of cycle.
 */
export async function* walk(root: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const rootAbs = resolve(root);
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? Infinity;
  const includeDirs = opts.includeDirs ?? false;
  const signal = opts.signal;

  let emitted = 0;
  const visitedRealDirs = new Set<string>();
  try {
    visitedRealDirs.add(await realpath(rootAbs));
  } catch {
    return; // root doesn't exist — nothing to walk
  }

  async function* visit(dirAbs: string, depth: number, ignoreStack: readonly IgnoreLevel[]): AsyncGenerator<string> {
    if (emitted >= maxEntries) return;
    signal?.throwIfAborted();

    const levelRules = await loadIgnoreRules(join(dirAbs, '.gitignore'));
    const stack = levelRules.length > 0 ? [...ignoreStack, { dir: dirAbs, rules: levelRules }] : ignoreStack;

    let entries: Dirent[];
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // e.g. permission denied — skip rather than fail the whole walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name)); // deterministic order

    for (const entry of entries) {
      if (emitted >= maxEntries) return;
      signal?.throwIfAborted();

      if (ALWAYS_SKIP.has(entry.name)) continue;

      const entryAbs = join(dirAbs, entry.name);
      let isDir = entry.isDirectory();

      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await stat(entryAbs);
        } catch {
          continue; // broken symlink
        }
        if (target.isDirectory()) continue; // never follow symlinked directories
        isDir = false;
      }

      const relPath = toPosixRelative(rootAbs, entryAbs);

      if (isDir) {
        let real: string;
        try {
          real = await realpath(entryAbs);
        } catch {
          continue;
        }
        if (visitedRealDirs.has(real)) continue; // hardlink/bind-mount cycle guard

        if (isIgnored(stack, entryAbs, true)) continue;

        if (includeDirs) {
          yield relPath;
          emitted++;
          if (emitted >= maxEntries) return;
        }

        if (depth + 1 <= maxDepth) {
          visitedRealDirs.add(real);
          yield* visit(entryAbs, depth + 1, stack);
        }
      } else {
        if (isIgnored(stack, entryAbs, false)) continue;
        yield relPath;
        emitted++;
      }
    }
  }

  yield* visit(rootAbs, 0, []);
}
