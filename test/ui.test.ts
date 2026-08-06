import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { labeledPanel, panel, spinnerLabel, statusPanel, wrapText } from '../src/ui/render.ts';
import { stripAnsi, visibleWidth } from '../src/ui/ansi.ts';

describe('responsive terminal rendering', () => {
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

  test('labeled panels use hanging indentation for wrapped values', () => {
    const rendered = stripAnsi(
      labeledPanel('commands', [['/model [id]', 'Choose a model for all future turns in this session']], 36),
    );
    const body = rendered.split('\n').slice(1, -1);

    assert.match(body[0] ?? '', /\/model \[id\].*Choose a model/);
    assert.match(body[1] ?? '', /^[│|]\s{14}\S/, rendered);
    assert.ok(body.every((line) => visibleWidth(line) <= 36), rendered);
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

    for (const field of ['MODEL', 'PROVIDER', 'APPROVAL', 'WORKSPACE', 'BRANCH', 'USAGE']) {
      assert.match(stripAnsi(rendered), new RegExp(field));
    }
    assert.ok(stripAnsi(rendered).split('\n').every((line) => visibleWidth(line) <= 42), rendered);
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
    assert.equal(visibleWidth('\x1b[?25ltext\x1b[?25h'), 4);
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
