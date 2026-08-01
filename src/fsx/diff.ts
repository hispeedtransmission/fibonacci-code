/**
 * Unified diff generation, LCS-based.
 *
 * The tension this module resolves: a correct diff needs an O(N*M) table (or
 * an implementation of Myers' O(ND) algorithm, which is a lot more code to
 * get right) to find the actual longest-common-subsequence alignment — a
 * greedy line-by-line comparison produces diffs that are technically valid
 * but visually nonsensical (every line after the first change shows as both
 * removed and added). We take the DP table. Two ~4000-line files means a
 * 16M-cell table, which is a multi-second stall for a diff nobody reads
 * hunk-by-hunk anyway — see NAIVE_REPLACE_THRESHOLD_LINES for the bailout.
 *
 * CRLF handling is deliberately not "detect the dominant line ending and
 * normalize to it": splitting only on `\n` (never `\r\n`) leaves any `\r` as
 * ordinary trailing content on its line. A file that's consistently CRLF
 * round-trips untouched with zero special-casing, and a mixed-EOL file
 * doesn't get silently rewritten to one style or the other.
 */

import { UsageError } from '../errors.ts';

export interface DiffOptions {
  /** Header label for the old side, e.g. `a/src/foo.ts`. Default: `a`. */
  oldLabel?: string;
  /** Header label for the new side, e.g. `b/src/foo.ts`. Default: `b`. */
  newLabel?: string;
  /** Lines of unchanged context to show around each change. Default: 3. */
  context?: number;
}

const DEFAULT_CONTEXT = 3;

/**
 * Above this line count on either side, we skip the O(N*M) LCS table and
 * emit a whole-file replace (every old line removed, every new line added).
 * The table is quadratic in both time and memory; ~4000 lines each way is
 * already a 16M-cell `Uint32Array` table and a visible pause. Diffs at that
 * size are already too large to review hunk-by-hunk, so the coarser output
 * costs nothing in practice.
 */
export const NAIVE_REPLACE_THRESHOLD_LINES = 4000;

type EditOp = { type: 'equal' | 'add' | 'del'; line: string };

interface SplitResult {
  lines: string[];
  trailingNewline: boolean;
}

/** Split on `\n` only (see module comment for why), tracking a missing final newline. */
function splitLines(text: string): SplitResult {
  if (text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

/** Longest-common-subsequence alignment of two line arrays, as an edit script. */
function computeEditScript(a: readonly string[], b: readonly string[]): EditOp[] {
  const n = a.length;
  const m = b.length;

  if (n > NAIVE_REPLACE_THRESHOLD_LINES || m > NAIVE_REPLACE_THRESHOLD_LINES) {
    return [
      ...a.map((line): EditOp => ({ type: 'del', line })),
      ...b.map((line): EditOp => ({ type: 'add', line })),
    ];
  }

  // dp[i][j] = length of the LCS of a[i:] and b[j:]. Filled bottom-up so the
  // forward backtrack below always knows the optimal next step.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    const cur = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, cur[j + 1]!);
    }
  }

  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i]!;
    const bj = b[j]!;
    if (ai === bj) {
      ops.push({ type: 'equal', line: ai });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: 'del', line: ai });
      i++;
    } else {
      ops.push({ type: 'add', line: bj });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j]! });
    j++;
  }
  return ops;
}

interface OpMeta {
  op: EditOp;
}

/** Maximal runs of non-`equal` ops, each padded by `context` lines and merged when overlapping. */
function buildHunks(meta: readonly OpMeta[], context: number): Array<{ lo: number; hi: number }> {
  const n = meta.length;
  const windows: Array<{ lo: number; hi: number }> = [];
  let k = 0;
  while (k < n) {
    if (meta[k]!.op.type === 'equal') {
      k++;
      continue;
    }
    let end = k;
    while (end < n && meta[end]!.op.type !== 'equal') end++;

    const lo = Math.max(0, k - context);
    const hi = Math.min(n, end + context);
    const last = windows[windows.length - 1];
    if (last && lo <= last.hi) {
      last.hi = Math.max(last.hi, hi);
    } else {
      windows.push({ lo, hi });
    }
    k = end;
  }
  return windows;
}

/** Running count of old-consuming (equal/del) and new-consuming (equal/add) ops before each index. */
function buildPrefixCounts(meta: readonly OpMeta[]): { oldBefore: number[]; newBefore: number[] } {
  const oldBefore = new Array<number>(meta.length + 1).fill(0);
  const newBefore = new Array<number>(meta.length + 1).fill(0);
  for (let k = 0; k < meta.length; k++) {
    const t = meta[k]!.op.type;
    oldBefore[k + 1] = oldBefore[k]! + (t === 'equal' || t === 'del' ? 1 : 0);
    newBefore[k + 1] = newBefore[k]! + (t === 'equal' || t === 'add' ? 1 : 0);
  }
  return { oldBefore, newBefore };
}

/**
 * Build a unified diff between `oldText` and `newText`. Returns `''` for
 * identical inputs.
 */
export function unifiedDiff(oldText: string, newText: string, opts: DiffOptions = {}): string {
  if (oldText === newText) return '';

  const oldLabel = opts.oldLabel ?? 'a';
  const newLabel = opts.newLabel ?? 'b';
  const context = opts.context ?? DEFAULT_CONTEXT;
  if (context < 0) throw new UsageError(`context must be >= 0, got ${context}`);

  const { lines: oldLines, trailingNewline: oldTrailing } = splitLines(oldText);
  const { lines: newLines, trailingNewline: newTrailing } = splitLines(newText);

  const ops = computeEditScript(oldLines, newLines);

  // A line whose *content* matches between old and new still differs at the
  // byte level if only one side has a trailing newline. A single "equal"
  // hunk line can't carry two different no-newline markers, so when that's
  // the only difference on the last line, split it into a del/add pair —
  // same text, one line per side — matching what `diff -u` actually emits.
  if (oldTrailing !== newTrailing && oldLines.length > 0 && newLines.length > 0) {
    const lastIdx = ops.length - 1;
    const lastOp = ops[lastIdx];
    if (
      lastOp &&
      lastOp.type === 'equal' &&
      lastOp.line === oldLines[oldLines.length - 1] &&
      lastOp.line === newLines[newLines.length - 1]
    ) {
      ops.splice(lastIdx, 1, { type: 'del', line: lastOp.line }, { type: 'add', line: lastOp.line });
    }
  }

  if (ops.every((op) => op.type === 'equal')) return '';

  const meta: OpMeta[] = ops.map((op) => ({ op }));
  const windows = buildHunks(meta, context);
  const { oldBefore, newBefore } = buildPrefixCounts(meta);

  const lastOldOpIdx = meta.findLastIndex((m) => m.op.type === 'equal' || m.op.type === 'del');
  const lastNewOpIdx = meta.findLastIndex((m) => m.op.type === 'equal' || m.op.type === 'add');

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];

  for (const w of windows) {
    const oldCount = oldBefore[w.hi]! - oldBefore[w.lo]!;
    const newCount = newBefore[w.hi]! - newBefore[w.lo]!;
    // Per unified-diff convention, a zero-count side reports the line number
    // of the last old/new line before the gap (0 if the gap is at the very
    // start of the file), not the line after it.
    const oldStart = oldCount > 0 ? oldBefore[w.lo]! + 1 : oldBefore[w.lo]!;
    const newStart = newCount > 0 ? newBefore[w.lo]! + 1 : newBefore[w.lo]!;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

    for (let k = w.lo; k < w.hi; k++) {
      const op = meta[k]!.op;
      const marker = op.type === 'equal' ? ' ' : op.type === 'del' ? '-' : '+';
      out.push(`${marker}${op.line}`);

      const isOldEnd = (op.type === 'equal' || op.type === 'del') && k === lastOldOpIdx && !oldTrailing;
      const isNewEnd = (op.type === 'equal' || op.type === 'add') && k === lastNewOpIdx && !newTrailing;
      if (isOldEnd || isNewEnd) out.push('\\ No newline at end of file');
    }
  }

  return out.join('\n') + '\n';
}

/** Count added/removed content lines in a unified diff, excluding the `---`/`+++` headers. */
export function diffStat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
