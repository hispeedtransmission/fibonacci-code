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

import {
  Style,
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
  const termWidth = process.stdout.columns || 80;
  const boxWidth = Math.max(MIN_BOX_WIDTH, Math.min(MAX_BOX_WIDTH, termWidth - 2));
  const innerWidth = boxWidth - 4; // border + 1-space pad on each side

  const top = chars.tl + chars.h.repeat(boxWidth - 2) + chars.tr;
  const bottom = chars.bl + chars.h.repeat(boxWidth - 2) + chars.br;
  const rule = (content: string) => `${chars.v} ${padVisible(content, innerWidth)} ${chars.v}`;

  const title = styleCode(BRAND_COLOR, Style.bold(`fibonacci-code v${opts.version}`));
  const cwd = Style.dim(truncateLeft(opts.cwd, innerWidth));

  const labelWidth = Math.max('model'.length, 'provider'.length, 'approval'.length);
  const field = (label: string, value: string) => `${Style.dim(label.padEnd(labelWidth))} ${value}`;

  const lines = [
    top,
    rule(title),
    rule(cwd),
    rule(''),
    rule(field('model', opts.model)),
    rule(field('provider', opts.provider)),
    rule(field('approval', opts.approval)),
    bottom,
  ];
  return lines.join('\n');
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

    process.stderr.write(hideCursor());
    cursorHiddenByASpinner = true;
    this.draw();
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.draw();
    }, SPINNER_INTERVAL_MS);
    this.timer.unref();
  }

  update(text: string): void {
    this.text = text;
    if (this.enabled) this.draw();
  }

  stop(finalLine?: string): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.enabled) return;

    process.stderr.write(`${eraseLine()}\r`);
    process.stderr.write(showCursor());
    cursorHiddenByASpinner = false;
    if (finalLine !== undefined) process.stderr.write(`${finalLine}\n`);
  }

  private draw(): void {
    const frame = this.frames[this.frameIndex] ?? this.frames[0] ?? '';
    process.stderr.write(`${eraseLine()}\r${Style.cyan(frame)} ${this.text}`);
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

/**
 * Word wrap that never splits a word — and therefore never splits an ANSI
 * escape sequence, since an escape only ever appears glued to the text it
 * colours, never as its own whitespace-delimited token. The one thing this
 * does not do is hard-break a single word longer than `width` (e.g. a very
 * long path with no spaces); that's left to overflow its line rather than
 * risk cutting an escape sequence in half.
 */
export function wrapText(text: string, width: number, indent = ''): string {
  const indentWidth = visibleWidth(indent);
  const avail = Math.max(1, width - indentWidth);
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push(indent);
      continue;
    }

    let current = '';
    let currentWidth = 0;
    for (const word of paragraph.split(' ')) {
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
    lines.push(indent + current);
  }

  return lines.join('\n');
}
