/**
 * Zero-dependency ANSI layer.
 *
 * The tension this file resolves: every terminal library worth using (chalk,
 * ansi-styles, wcwidth) pulls in a package, and this CLI ships with zero
 * runtime dependencies. So we hand-roll the ~5% of each library that this
 * codebase actually needs: SGR wrapping, colour-support detection, and a
 * *visible* width that a real terminal would agree with.
 *
 * Two things make that last part hard without a dependency. First, ANSI
 * escapes have zero width but non-zero length, so `str.length` lies the
 * moment you colour anything — `stripAnsi` + `visibleWidth` exist so callers
 * never have to think about escapes when they lay out a box. Second, East
 * Asian wide characters (CJK, Hangul, fullwidth forms) occupy two terminal
 * columns for one JS string character — get that wrong and every boxed
 * banner containing a CJK path silently misaligns by one column per wide
 * character. `visibleWidth` accounts for both; it does not attempt full
 * Unicode grapheme clustering (combining marks beyond the common ranges,
 * ZWJ emoji sequences, etc. are out of scope) — see the comment on
 * `visibleWidth` for the documented approximation.
 *
 * Colour itself must be disableable *after* this module has already been
 * imported and its helpers captured by callers — `--no-color` is parsed by
 * the CLI's arg layer, which runs after modules load. Hence the module-level
 * mutable flag in `setColorEnabled` rather than baking the decision into
 * each `Style.*` function at creation time.
 */

let colorEnabled = supportsColor(process.stdout);

/** Runtime override for colour output — this is what `--no-color` and piped-output detection call into. */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

/**
 * Whether `stream` should receive ANSI colour codes.
 *
 * Precedence follows the de facto convention used by `supports-color` /
 * chalk: `FORCE_COLOR` is an explicit human override and wins outright, then
 * `NO_COLOR` (https://no-color.org — presence, any non-empty value, disables
 * regardless of content), then the `TERM=dumb` escape hatch some CI systems
 * set, and only then do we fall back to actually checking the stream.
 */
export function supportsColor(stream: NodeJS.WriteStream): boolean {
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0';

  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;

  if (process.env['TERM'] === 'dumb') return false;

  return stream.isTTY === true;
}

/**
 * Whether it's safe to emit Unicode box-drawing / braille / bullet glyphs.
 *
 * Windows terminals historically shipped fonts and code pages that mangle
 * these, so we default to ASCII fallbacks there — unless the process is
 * running inside a modern terminal known to render them correctly (Windows
 * Terminal sets `WT_SESSION`; anything reporting `TERM_PROGRAM` is a modern
 * emulator, e.g. VS Code's integrated terminal).
 */
export function supportsUnicode(): boolean {
  if (process.platform !== 'win32') return true;
  return process.env['WT_SESSION'] !== undefined || process.env['TERM_PROGRAM'] !== undefined;
}

/** Wrap `s` in the given SGR code(s) (e.g. `'1'`, `'38;5;214'`), honouring the global colour flag. */
export function styleCode(code: string, s: string): string {
  if (!colorEnabled || s === '') return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

function styler(code: string): (s: string) => string {
  return (s: string) => styleCode(code, s);
}

export const Style = {
  bold: styler('1'),
  dim: styler('2'),
  italic: styler('3'),
  underline: styler('4'),

  red: styler('31'),
  green: styler('32'),
  yellow: styler('33'),
  blue: styler('34'),
  magenta: styler('35'),
  cyan: styler('36'),
  white: styler('37'),
  gray: styler('90'),

  bgRed: styler('41'),
  bgGreen: styler('42'),
  bgYellow: styler('43'),
  bgBlue: styler('44'),
  bgMagenta: styler('45'),
  bgCyan: styler('46'),
} as const;

// Matches CSI sequences (`\x1b[...<final byte>`) and the simpler OSC/other
// escapes we might ever emit ourselves. We only ever *produce* CSI SGR
// sequences in this file, so that's the form this needs to strip reliably;
// broader coverage here is defensive, not load-bearing.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

// Zero-width or combining code points that occupy a terminal cell but no
// visible column: combining diacritics, variation selectors, and the
// zero-width space/joiner/non-joiner family. Not a full Unicode grapheme
// database — just the ranges that actually show up in tool output (accented
// paths, emoji variation selectors).
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x200b && code <= 0x200f) || // ZWSP, ZWNJ, ZWJ, LRM/RLM
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    code === 0xfeff // BOM / zero-width no-break space
  );
}

// East Asian Wide + Fullwidth ranges (Unicode UAX #11), the set that
// terminals actually render at two columns. Approximate, not exhaustive —
// covers CJK ideographs, Hangul, and fullwidth forms, which is what shows up
// in real paths and model output; obscure wide scripts are out of scope.
function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK Radicals .. Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)) // CJK Extension B and beyond
  );
}

/**
 * Terminal column width of `s`: strips ANSI first, then counts each
 * remaining code point as 0 (zero-width/combining), 1, or 2 (East Asian
 * wide) columns. See the module comment for what this approximation does
 * not cover.
 */
export function visibleWidth(s: string): number {
  const stripped = stripAnsi(s);
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (isZeroWidth(code)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

export function hideCursor(): string {
  return '\x1b[?25l';
}

export function showCursor(): string {
  return '\x1b[?25h';
}

export function eraseLine(): string {
  return '\x1b[2K';
}

export function cursorUp(n: number): string {
  return `\x1b[${n}A`;
}

export function clearScreen(): string {
  return '\x1b[2J\x1b[3J\x1b[H';
}
