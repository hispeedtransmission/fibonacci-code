import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { panel, statusPanel, wrapText } from '../src/ui/render.ts';
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
});
