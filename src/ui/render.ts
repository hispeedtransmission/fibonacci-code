/**
 * Rendering primitives built on top of `./ansi.ts`.
 *
 * The tension here: every one of these renderers has to work in three
 * environments at once — a full-width color terminal, a narrow SSH session
 * with 16 colours (or none), and a pipe with no TTY at all — without the
 * caller ever branching on which one it is. So the branching happens once,
 * in here: `supportsUnicode()`/`Style` pick glyphs and colour per call, box
 * layout is computed from `visibleWidth` instead of `.length` so ANSI codes
 * and wide characters never throw off alignment, and `Spinner` detects a
 * non-TTY stderr and goes fully silent rather than spraying escape codes
 * into a redirected file.
 */

import { homedir } from 'node:os';
import {
  Style,
  stripAnsi,
  styleCode,
  supportsUnicode,
  visibleWidth,
  hideCursor,
  showCursor,
  eraseLine,
} from './ansi.ts';

const BRAND_COLOR = '38;5;214'; // warm amber/gold; see ansi.ts module comment on why no 16-colour fallback is needed

const MIN_BOX_WIDTH = 24;
const MAX_BOX_WIDTH = 72;

/**
 * Usable terminal width.
 *
 * `process.stdout.columns` is `undefined` whenever stdout is not a TTY, and
 * Node never consults the `COLUMNS` environment variable itself. Checking
 * COLUMNS second means the banner still lays out correctly when stdout is
 * piped but stderr (where the banner actually goes) is a terminal, and it
 * gives tests and CI a way to exercise narrow layouts without a pty.
 */
export function terminalWidth(): number {
  const fromTty = process.stderr.columns || process.stdout.columns;
  if (fromTty && fromTty > 0) return fromTty;
  const fromEnv = Number.parseInt(process.env['COLUMNS'] ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 80;
}

interface BoxChars {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

function boxChars(): BoxChars {
  return supportsUnicode()
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
}

/** Pad `s` to `width` visible columns. Never truncates — callers truncate first if needed. */
function padVisible(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * Truncate `s` to `width` visible columns, cutting from the LEFT with a
 * leading ellipsis. For a filesystem path the tail (the file itself) is the
 * informative part; the drive-by/project-root prefix is what a user can
 * afford to lose.
 */
/**
 * Truncate from the RIGHT, keeping the head.
 *
 * Direction is content-dependent, not stylistic. A path's tail identifies it
 * (`…/packages/backend`), so paths truncate from the left. A model name's head
 * identifies it — `qwen3-coder-30b…` is informative where `…3b-instruct` is
 * nearly useless — so names truncate from the right.
 */
function truncateRight(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;

  const ellipsis = supportsUnicode() ? '…' : '...';
  const budget = width - visibleWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, Math.max(0, width));

  let kept = '';
  let used = 0;
  for (const ch of s) {
    const w = visibleWidth(ch);
    if (used + w > budget) break;
    kept += ch;
    used += w;
  }
  return kept + ellipsis;
}

function truncateLeft(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;

  const ellipsis = supportsUnicode() ? '…' : '...';
  const budget = width - visibleWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, Math.max(0, width));

  // Walk code points from the end so a wide character never gets split, and
  // stop as soon as adding the next one would blow the column budget.
  const codePoints = Array.from(s);
  let kept = '';
  let width2 = 0;
  for (let i = codePoints.length - 1; i >= 0; i--) {
    const ch = codePoints[i];
    if (ch === undefined) break;
    const w = visibleWidth(ch);
    if (width2 + w > budget) break;
    kept = ch + kept;
    width2 += w;
  }
  return ellipsis + kept;
}

export function banner(opts: {
  cwd: string;
  model: string;
  provider: string;
  approval: string;
  version: string;
}): string {
  const chars = boxChars();
  const boxWidth = Math.max(MIN_BOX_WIDTH, Math.min(MAX_BOX_WIDTH, terminalWidth() - 2));
  const innerWidth = boxWidth - 4; // border + 1-space pad on each side

  // The name lives in the top border rather than on its own row. This is
  // chrome printed on every single invocation, so it earns its height: three
  // lines total, and every character in them is information the user needs.
  const label = ` fibonacci `;
  const titleRun = chars.h.repeat(1) + label + chars.h.repeat(Math.max(0, boxWidth - 3 - visibleWidth(label)));
  const top = chars.tl + colorizeTitleRun(titleRun, label) + chars.tr;
  const bottom = chars.bl + chars.h.repeat(boxWidth - 2) + chars.br;
  const rule = (content: string) => `${chars.v} ${padVisible(content, innerWidth)} ${chars.v}`;

  // Collapse $HOME to `~`: the informative part of a path is its tail, and the
  // home prefix is the same on every line the user will ever read.
  const home = homedir();
  const shownCwd = opts.cwd === home ? '~' : opts.cwd.startsWith(`${home}/`) ? `~${opts.cwd.slice(home.length)}` : opts.cwd;

  // Strip the parenthetical account detail; `fib auth status` is where that
  // belongs. Here we want the shortest phrase that says which account pays.
  const shortProvider = opts.provider.replace(/\s*\(.*?\)\s*/, ' ').replace(/\s+—.*$/, '').trim();

  const meta = [opts.model, shortProvider, opts.approval].filter((s) => s !== '').join(' · ');

  // Try one line. Only if the path and the metadata genuinely cannot share a
  // row do we stack — and once stacked, the path gets the whole width back
  // rather than keeping the cramped budget that failed.
  const shared = truncateLeft(shownCwd, Math.max(12, innerWidth - visibleWidth(meta) - 3));
  const lines =
    visibleWidth(`${shared}   ${meta}`) <= innerWidth && visibleWidth(shownCwd) === visibleWidth(shared)
      ? [top, rule(`${Style.bold(shared)}   ${Style.dim(meta)}`), bottom]
      : [
          top,
          rule(Style.bold(truncateLeft(shownCwd, innerWidth))),
          rule(Style.dim(truncateRight(meta, innerWidth))),
          bottom,
        ];

  return lines.join('\n');
}

/** A responsive bordered panel. Input rows are plain text; styling is applied here. */
export function panel(title: string, rows: string[], columns = terminalWidth()): string {
  const chars = boxChars();
  const boxWidth = Math.max(20, Math.min(MAX_BOX_WIDTH, columns));
  const innerWidth = boxWidth - 4;
  const label = ` ${title} `;
  const shownLabel = truncateRight(label, boxWidth - 4);
  const topRun = chars.h + shownLabel + chars.h.repeat(Math.max(0, boxWidth - 3 - visibleWidth(shownLabel)));
  const top = chars.tl + colorizeTitleRun(topRun, shownLabel) + chars.tr;
  const bottom = chars.bl + chars.h.repeat(boxWidth - 2) + chars.br;
  const body = rows.flatMap((row) =>
    row.split('\n').flatMap((line) => (visibleWidth(line) <= innerWidth ? [line] : wrapText(line, innerWidth).split('\n'))),
  );
  const rule = (content: string) => `${chars.v} ${padVisible(content, innerWidth)} ${chars.v}`;
  return [top, ...body.map(rule), bottom].join('\n');
}

export function labeledPanel(title: string, entries: ReadonlyArray<readonly [string, string]>, columns = terminalWidth()): string {
  const boxWidth = Math.max(20, Math.min(MAX_BOX_WIDTH, columns));
  const innerWidth = boxWidth - 4;
  const maxLabel = Math.max(0, ...entries.map(([label]) => visibleWidth(label)));
  const labelWidth = Math.min(maxLabel, Math.max(6, Math.floor(innerWidth / 2)));
  const valueWidth = Math.max(4, innerWidth - labelWidth - 2);
  const rows = entries.flatMap(([label, value]) => {
    const valueLines = wrapText(value, valueWidth).split('\n');
    return valueLines.map((line, index) => `${index === 0 ? label.padEnd(labelWidth) : ' '.repeat(labelWidth)}  ${line}`);
  });
  return panel(title, rows, boxWidth);
}

export function statusPanel(
  status: {
    model: string;
    provider: string;
    approval: string;
    cwd: string;
    branch?: string;
    usage: string;
  },
  columns = terminalWidth(),
): string {
  const entries: Array<readonly [string, string]> = [
    ['MODEL', status.model],
    ['PROVIDER', status.provider],
    ['APPROVAL', status.approval],
    ['WORKSPACE', status.cwd],
    ...(status.branch ? ([['BRANCH', status.branch]] as const) : []),
    ['USAGE', status.usage],
  ];
  return labeledPanel('session', entries, columns);
}

/** Brand-colour the word inside the top border, leave the rule itself dim. */
function colorizeTitleRun(run: string, label: string): string {
  const idx = run.indexOf(label);
  if (idx === -1) return Style.dim(run);
  return (
    Style.dim(run.slice(0, idx)) +
    styleCode(BRAND_COLOR, Style.bold(label)) +
    Style.dim(run.slice(idx + label.length))
  );
}

export function toolLine(opts: {
  /**
   * Optional. Tools' own `summarize()` already begins with a verb ("read
   * src/x.ts"), so passing the raw tool name as well renders it twice. Supply
   * it only when the summary does not already identify the operation.
   */
  name?: string;
  summary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
}): string {
  const glyph = supportsUnicode() ? '●' : '*';
  const bullet =
    opts.status === 'running' ? Style.cyan(glyph) : opts.status === 'ok' ? Style.green(glyph) : Style.red(glyph);

  const label = opts.name ? `${opts.name}  ${opts.summary}` : opts.summary;
  const base = `  ${bullet} ${label}`;
  return opts.detail ? `${base}\n    ${Style.dim(opts.detail)}` : base;
}

/** Colourize a unified diff. Purely additive styling — never re-wraps or otherwise touches line content. */
export function diffLines(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      // File headers start with +++/--- and would otherwise get caught by
      // the +/- checks below, so they're tested first.
      if (line.startsWith('+++') || line.startsWith('---')) return Style.bold(line);
      if (line.startsWith('@@')) return styleCode('36;2', line); // cyan + dim combined in one SGR, so the dim reset doesn't clobber the cyan
      if (line.startsWith('+')) return Style.green(line);
      if (line.startsWith('-')) return Style.red(line);
      return line;
    })
    .join('\n');
}

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];
const SPINNER_INTERVAL_MS = 80;

/** Sanitize untrusted status text and bound it to the spinner's single owned row. */
export function spinnerLabel(text: string, columns = terminalWidth()): string {
  // OSC commands end with BEL or ST; CSI commands end with a final byte.
  const withoutOsc = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  const withoutEscapes = withoutOsc.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const oneLine = withoutEscapes.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return truncateRight(oneLine || 'working', Math.max(1, columns - 4));
}

// Shared across instances rather than per-Spinner: only ever one spinner is
// visible at a time in this CLI, and tracking "did *any* spinner hide the
// cursor" here means the exit handler doesn't need to reason about which
// instance is still alive when the process exits mid-tool-call.
let cursorHiddenByASpinner = false;
process.on('exit', () => {
  if (cursorHiddenByASpinner && process.stderr.isTTY) process.stderr.write(showCursor());
});

/**
 * A stderr spinner. Writing status to stderr (not stdout) is what keeps
 * `fib -p "..." > out.txt` producing clean, spinner-free output on stdout
 * while the user still sees progress on their screen.
 */
export class Spinner {
  private readonly enabled: boolean;
  private readonly frames: string[];
  private frameIndex = 0;
  private text = '';
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.enabled = process.stderr.isTTY === true;
    this.frames = supportsUnicode() ? BRAILLE_FRAMES : ASCII_FRAMES;
  }

  start(text: string): void {
    this.text = text;
    if (!this.enabled) return;

    if (this.timer !== undefined) clearInterval(this.timer);
    if (!cursorHiddenByASpinner) {
      process.stderr.write(hideCursor());
      cursorHiddenByASpinner = true;
    }
    this.draw();
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.draw();
    }, SPINNER_INTERVAL_MS);
    this.timer.unref();
  }

  /** True while the spinner owns the current terminal row. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Change the label. Same ownership rule as stop(): redrawing when the
   * spinner is not running would erase a row it does not own.
   */
  update(text: string): void {
    this.text = text;
    if (this.enabled && this.running) this.draw();
  }

  /**
   * Stop, and erase the spinner's line ONLY if the spinner still owns it.
   *
   * This guard is load-bearing. Callers legitimately invoke stop() more than
   * once — on the first text delta, at end of turn, and again in a `finally` —
   * and by the later calls the spinner is long dead while the cursor sits
   * mid-row inside text the caller has since written to stdout. An
   * unconditional `eraseLine()` there wipes the last visual row of the
   * assistant's answer, truncating it mid-word.
   *
   * Invisible off-TTY, because the spinner is a no-op there: piped output was
   * always intact, which is precisely what made this hard to catch in tests.
   */
  stop(finalLine?: string): void {
    const ownedTheLine = this.timer !== undefined;
    if (ownedTheLine) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.enabled) return;

    if (ownedTheLine) process.stderr.write(`${eraseLine()}\r`);
    if (cursorHiddenByASpinner) {
      process.stderr.write(showCursor());
      cursorHiddenByASpinner = false;
    }
    if (finalLine !== undefined) process.stderr.write(`${finalLine}\n`);
  }

  private draw(): void {
    const frame = this.frames[this.frameIndex] ?? this.frames[0] ?? '';
    process.stderr.write(`${eraseLine()}\r${Style.cyan(frame)} ${spinnerLabel(this.text)}`);
  }
}

function humanizeTokens(n: number): string {
  if (n < 1000) return String(n);
  const [divisor, suffix] = n < 1_000_000 ? [1000, 'k'] : [1_000_000, 'M'];
  return `${(n / divisor).toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

export function formatUsage(u: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}): string {
  const parts = [`${humanizeTokens(u.inputTokens)} in`, `${humanizeTokens(u.outputTokens)} out`];
  if (u.cachedInputTokens) parts.push(`${humanizeTokens(u.cachedInputTokens)} cached`);
  if (u.reasoningTokens) parts.push(`${humanizeTokens(u.reasoningTokens)} reasoning`);
  return Style.dim(parts.join(' · '));
}

const wrapSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Width-safe wrapping. Styling is dropped when wrapping to prevent SGR state leaking across rows. */
export function wrapText(text: string, width: number, indent = ''): string {
  const wrapInput = text.includes('\x1b') ? stripAnsi(text) : text;
  const indentWidth = visibleWidth(indent);
  const avail = Math.max(1, width - indentWidth);
  const lines: string[] = [];

  for (const paragraph of wrapInput.split('\n')) {
    if (paragraph === '') {
      lines.push(indent);
      continue;
    }

    let current = '';
    let currentWidth = 0;
    for (const originalWord of paragraph.split(' ')) {
      const chunks: string[] = [];
      if (visibleWidth(originalWord) > avail) {
        let chunk = '';
        let chunkWidth = 0;
        for (const { segment } of wrapSegmenter.segment(originalWord)) {
          const segmentWidth = visibleWidth(segment);
          if (chunk !== '' && chunkWidth + segmentWidth > avail) {
            chunks.push(chunk);
            chunk = '';
            chunkWidth = 0;
          }
          chunk += segment;
          chunkWidth += segmentWidth;
        }
        if (chunk !== '') chunks.push(chunk);
      } else {
        chunks.push(originalWord);
      }

      for (const word of chunks) {
        const wordWidth = visibleWidth(word);
        const sepWidth = current === '' ? 0 : 1;
        if (current !== '' && currentWidth + sepWidth + wordWidth > avail) {
          lines.push(indent + current);
          current = word;
          currentWidth = wordWidth;
        } else {
          current = current === '' ? word : `${current} ${word}`;
          currentWidth += sepWidth + wordWidth;
        }
      }
    }
    lines.push(indent + current);
  }

  return lines.join('\n');
}
