import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  banner,
  brandPrompt,
  diffLines,
  foldedFMark,
  labeledPanel,
  panel,
  spinnerLabel,
  supportsInteractiveControl,
  statusPanel,
  toolLine,
  wrapText,
} from '../src/ui/render.ts';
import { sanitizeInline, sanitizeMultiline, stripAnsi, supportsUnicode, visibleWidth } from '../src/ui/ansi.ts';

describe('responsive terminal rendering', () => {
  const bannerOptions = {
    cwd: '/Users/test/Developer/fibonacci-code',
    model: 'gpt-5.6-sol',
    provider: 'ChatGPT subscription',
    approval: 'suggest',
    version: '0.1.0',
  };

  test('branded banner carries the folded F, instrument identity, and sequence rail', () => {
    const rendered = stripAnsi(banner(bannerOptions, 80));

    assert.match(rendered, /FIBONACCI/);
    assert.match(rendered, /FBNC \/ AGENT INSTRUMENT/);
    assert.match(rendered, /01·01·02·03·05·08·13/);
    for (const line of foldedFMark().split('\n')) assert.ok(rendered.includes(line.trimEnd()), rendered);
    assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= 80), rendered);
  });

  test('brand chrome falls back cleanly on narrow terminals', () => {
    for (const columns of [8, 12, 19, 20, 23, 30]) {
      const rendered = stripAnsi(banner(bannerOptions, columns));
      assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= columns), `${columns}:\n${rendered}`);
    }
  });

  test('falls back to ASCII chrome for a dumb terminal', () => {
    const prior = process.env['TERM'];
    process.env['TERM'] = 'dumb';
    try {
      assert.equal(supportsUnicode(), false);
      const rendered = stripAnsi(banner(bannerOptions, 30));
      assert.match(rendered, /^\+-/);
      assert.equal(rendered.includes('╭'), false);
    } finally {
      if (prior === undefined) delete process.env['TERM'];
      else process.env['TERM'] = prior;
    }
  });

  test('hard-wraps a single long token instead of overflowing', () => {
    assert.equal(wrapText('abcdefghijkl', 5), 'abcde\nfghij\nkl');
  });

  test('wraps words and preserves explicit blank lines and indentation', () => {
    assert.equal(wrapText('alpha beta gamma\n\ndelta', 12, '  '), '  alpha beta\n  gamma\n  \n  delta');
  });

  test('panel wraps every row inside its borders at narrow widths', () => {
    const rendered = panel('Details', ['Model  qwen3-coder-30b-instruct', 'Path   /a/very/long/path/without/spaces'], 30);
    const lines = stripAnsi(rendered).split('\n');

    assert.ok(lines[0]?.includes('Details'));
    assert.ok(lines.every((line) => visibleWidth(line) <= 30), rendered);
    assert.ok(lines.slice(1, -1).every((line) => /^[│|].*[│|]$/.test(line)), rendered);
  });

  test('panels use a compact unboxed fallback below twenty columns', () => {
    for (const columns of [6, 10, 19]) {
      const rendered = stripAnsi(panel('FBNC / DETAILS', ['abcdefghijklmnop', 'second row'], columns));
      assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= columns), `${columns}:\n${rendered}`);
    }
  });

  test('labeled panels use hanging indentation for wrapped values', () => {
    const rendered = stripAnsi(
      labeledPanel('commands', [['/model [id]', 'Choose a model for all future turns in this session']], 36),
    );
    const body = rendered.split('\n').slice(1, -1);

    assert.match(body[0] ?? '', /\/model \[id\].*Choose a model/);
    assert.match(body[1] ?? '', /^[│|]\s{14}\S/, rendered);
    assert.ok(body.every((line) => visibleWidth(line) <= 36), rendered);
  });

  test('labeled panels use a compact unboxed layout when labels would starve values', () => {
    const rendered = stripAnsi(
      labeledPanel('FBNC / COMMAND INDEX', [['/approval <m>', 'suggest | auto-edit | full-auto']], 20),
    );
    assert.equal(rendered.includes('╭'), false);
    assert.match(rendered, /suggest \| auto-edit/);
    assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= 20), rendered);
  });

  test('status HUD exposes the expected session fields and remains responsive', () => {
    const rendered = statusPanel(
      {
        model: 'gpt-5.6-sol',
        provider: 'ChatGPT subscription',
        approval: 'suggest',
        cwd: '/Users/example/a-project-with-a-long-name',
        branch: 'feat/polished-terminal-user-experience',
        usage: '1.2k in · 340 out',
      },
      42,
    );

    assert.match(stripAnsi(rendered), /FBNC \/ SESSION/);
    for (const field of ['MODEL', 'PROVIDER', 'APPROVAL', 'WORKSPACE', 'BRANCH', 'USAGE']) {
      assert.match(stripAnsi(rendered), new RegExp(field));
    }
    assert.ok(stripAnsi(rendered).split('\n').every((line) => visibleWidth(line) <= 42), rendered);
  });

  test('interaction vocabulary uses the branded instrument labels', () => {
    assert.equal(stripAnsi(brandPrompt()), supportsUnicode() ? 'YOU › ' : 'YOU > ');
    assert.match(stripAnsi(toolLine({ summary: 'read source', status: 'running' })), /TRACE/);
    assert.match(stripAnsi(toolLine({ summary: 'read source', status: 'ok' })), /PASS/);
    assert.match(stripAnsi(toolLine({ summary: 'read source', status: 'error' })), /FAULT/);
  });

  test('disables interactive cursor controls for pipes and dumb terminals', () => {
    assert.equal(supportsInteractiveControl({ isTTY: false }, 'xterm-256color'), false);
    assert.equal(supportsInteractiveControl({ isTTY: true }, 'dumb'), false);
    assert.equal(supportsInteractiveControl({ isTTY: true }, 'xterm-256color'), true);
  });

  test('spinner labels are one sanitized row bounded to terminal width', () => {
    const label = spinnerLabel('run tests\n\x1b]52;c;payload\x07\x1b[31m' + 'x'.repeat(40), 20);

    assert.equal(label.includes('\n'), false);
    assert.equal(label.includes('\x1b'), false);
    assert.ok(visibleWidth(label) <= 16, label); // reserve frame + separator
  });

  test('terminal width handles emoji graphemes and strips modern escape sequences', () => {
    assert.equal(visibleWidth('😀'), 2);
    assert.equal(visibleWidth('👩‍💻'), 2);
    assert.equal(visibleWidth('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 4);
    assert.equal(stripAnsi('A\x1bPpayload\x1b\\B\x1b_apc\x1b\\C\x1bcD'), 'ABCD');
    assert.equal(visibleWidth('\x1b[?25ltext\x1b[?25h'), 4);
  });

  test('sanitizes terminal control injection from inline provider text', () => {
    const sanitized = sanitizeInline('model\nname\x1b]52;c;payload\x07\x1b[?25l');
    assert.equal(sanitized, 'model name');
    assert.equal(sanitized.includes('\x1b'), false);
  });

  test('sanitizes terminal commands without flattening multiline tool output', () => {
    const malicious = 'first\n\x1b]52;c;payload\x07second\n\x1b[31mthird\x1b[0m';
    assert.equal(sanitizeMultiline(malicious), 'first\nsecond\nthird');
    assert.equal(toolLine({ summary: 'done', status: 'ok', detail: malicious }).includes('\x1b]'), false);
    assert.equal(diffLines(`--- a\n+++ b\n+${malicious}`).includes('\x1b]'), false);
  });

  test('wrapping never leaks ANSI styles or splits joined emoji', () => {
    const styled = wrapText('\x1b[1mhello world again\x1b[0m', 7);
    assert.equal(styled.includes('\x1b'), false);
    assert.ok(styled.split('\n').every((line) => visibleWidth(line) <= 7));

    const emoji = wrapText('👩‍💻👩‍💻👩‍💻', 4);
    assert.equal(emoji.replaceAll('\n', ''), '👩‍💻👩‍💻👩‍💻');
    assert.ok(emoji.split('\n').every((line) => visibleWidth(line) <= 4));
  });
});
