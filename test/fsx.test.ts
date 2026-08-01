import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInWorkspace, isWithin, assertNotSensitive } from '../src/fsx/safe.ts';
import { unifiedDiff, diffStat } from '../src/fsx/diff.ts';
import { walk, globMatch } from '../src/fsx/walk.ts';
import { UsageError } from '../src/errors.ts';

const scratch = mkdtempSync(join(tmpdir(), 'fibonacci-fsx-'));
const cleanupPaths: string[] = [scratch];

after(() => {
  for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// safe.ts — resolveInWorkspace / isWithin
// ---------------------------------------------------------------------------

test('resolveInWorkspace: allows a plain relative path inside root', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const result = resolveInWorkspace(root, 'foo.txt');
  assert.equal(result, join(root, 'foo.txt'));
});

test('resolveInWorkspace: allows a new file whose parent dir does not exist yet', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const result = resolveInWorkspace(root, 'a/b/new-file.txt');
  assert.equal(result, join(root, 'a', 'b', 'new-file.txt'));
});

test('resolveInWorkspace: rejects ../../etc/passwd', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  assert.throws(() => resolveInWorkspace(root, '../../etc/passwd'), UsageError);
});

test('resolveInWorkspace: rejects an absolute path outside root', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), UsageError);
});

test('resolveInWorkspace: rejects foo/../../../etc (lexically collapses out of root)', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  assert.throws(() => resolveInWorkspace(root, 'foo/../../../etc'), UsageError);
});

test('resolveInWorkspace: an absolute candidate that IS inside root is fine', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const inside = join(root, 'sub', 'inside.txt');
  assert.equal(resolveInWorkspace(root, inside), inside);
});

test('resolveInWorkspace: symlink escape — a symlink inside the workspace pointing outside it', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const outside = mkdtempSync(join(scratch, 'outside-'));
  symlinkSync(outside, join(root, 'link'));
  // The final component doesn't need to exist for the check to catch the escape.
  assert.throws(() => resolveInWorkspace(root, 'link/secret.txt'), UsageError);
});

test('resolveInWorkspace: symlink escape is caught even when the linked target has the file', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const outside = mkdtempSync(join(scratch, 'outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, join(root, 'link2'));
  assert.throws(() => resolveInWorkspace(root, 'link2/secret.txt'), UsageError);
});

test('resolveInWorkspace: a workspace rooted directly under /tmp is not falsely rejected (macOS /tmp -> /private/tmp)', {
  // The bug this guards against only exists where /tmp is itself a symlink,
  // which is a POSIX arrangement. Windows has no /tmp at all, so hardcoding
  // the path there fails with ENOENT and tests nothing.
  skip: !existsSync('/tmp') ? 'no /tmp on this platform' : false,
}, () => {
  // This reproduces the exact bug shape: comparing an unresolved root
  // against a resolved candidate rejects every path when root's own
  // symlink chain (e.g. /tmp -> /private/tmp) differs from the candidate's.
  const root = mkdtempSync('/tmp/fibonacci-fsx-tmp-');
  cleanupPaths.push(root);
  assert.doesNotThrow(() => resolveInWorkspace(root, 'file.txt'));
  assert.equal(resolveInWorkspace(root, 'file.txt'), join(root, 'file.txt'));
});

test('resolveInWorkspace: segment-aware prefix check — /work must not contain /workspace-other', () => {
  const parent = mkdtempSync(join(scratch, 'prefix-'));
  const work = join(parent, 'work');
  const workspaceOther = join(parent, 'workspace-other');
  mkdirSync(work);
  mkdirSync(workspaceOther);
  writeFileSync(join(workspaceOther, 'x.txt'), 'hi');

  assert.throws(() => resolveInWorkspace(work, '../workspace-other/x.txt'), UsageError);
  assert.equal(isWithin(work, join(workspaceOther, 'x.txt')), false);
});

test('resolveInWorkspace: is case-correct (never lowercases)', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  const result = resolveInWorkspace(root, 'MixedCase.TXT');
  assert.ok(result.endsWith('MixedCase.TXT'));
});

test('isWithin: non-throwing form mirrors resolveInWorkspace', () => {
  const root = mkdtempSync(join(scratch, 'ws-'));
  assert.equal(isWithin(root, 'ok.txt'), true);
  assert.equal(isWithin(root, '../../etc/passwd'), false);
});

// ---------------------------------------------------------------------------
// safe.ts — assertNotSensitive
// ---------------------------------------------------------------------------

test('assertNotSensitive: allows .env.example', () => {
  assert.doesNotThrow(() => assertNotSensitive('/workspace/.env.example'));
});

test('assertNotSensitive: rejects .env.local', () => {
  assert.throws(() => assertNotSensitive('/workspace/.env.local'), UsageError);
});

test('assertNotSensitive: rejects .env', () => {
  assert.throws(() => assertNotSensitive('/workspace/.env'), UsageError);
});

test('assertNotSensitive: rejects .git/config', () => {
  assert.throws(() => assertNotSensitive('/workspace/.git/config'), UsageError);
});

test('assertNotSensitive: rejects SSH keys and .pem/.key files', () => {
  assert.throws(() => assertNotSensitive('/workspace/.ssh/id_rsa'), UsageError);
  assert.throws(() => assertNotSensitive('/home/user/id_ed25519'), UsageError);
  assert.throws(() => assertNotSensitive('/workspace/certs/server.pem'), UsageError);
  assert.throws(() => assertNotSensitive('/workspace/keys/foo.key'), UsageError);
});

test('assertNotSensitive: rejects .npmrc, .pypirc, .aws/credentials', () => {
  assert.throws(() => assertNotSensitive('/workspace/.npmrc'), UsageError);
  assert.throws(() => assertNotSensitive('/workspace/.pypirc'), UsageError);
  assert.throws(() => assertNotSensitive('/home/user/.aws/credentials'), UsageError);
});

test('assertNotSensitive: rejects anything under .fibonacci/ or .codex/', () => {
  assert.throws(() => assertNotSensitive('/home/user/.fibonacci/auth.json'), UsageError);
  assert.throws(() => assertNotSensitive('/home/user/.codex/auth.json'), UsageError);
});

test('assertNotSensitive: allows ordinary source files', () => {
  assert.doesNotThrow(() => assertNotSensitive('/workspace/src/index.ts'));
});

// ---------------------------------------------------------------------------
// diff.ts
// ---------------------------------------------------------------------------

test('unifiedDiff: identical inputs produce an empty string', () => {
  assert.equal(unifiedDiff('a\nb\nc\n', 'a\nb\nc\n'), '');
});

test('unifiedDiff: new file (empty old side)', () => {
  const patch = unifiedDiff('', 'a\nb\n', { oldLabel: 'a/new.txt', newLabel: 'b/new.txt' });
  assert.match(patch, /^--- a\/new\.txt\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,2 @@\n\+a\n\+b\n$/);
});

test('unifiedDiff: deletion (empty new side)', () => {
  const patch = unifiedDiff('a\nb\n', '', { oldLabel: 'a/gone.txt', newLabel: 'b/gone.txt' });
  assert.match(patch, /^--- a\/gone\.txt\n\+\+\+ b\/gone\.txt\n@@ -1,2 \+0,0 @@\n-a\n-b\n$/);
});

test('unifiedDiff: missing trailing newline is marked', () => {
  const patch = unifiedDiff('a\nb', 'a\nb\n');
  assert.ok(patch.includes('-b\n\\ No newline at end of file\n+b'));
  const stat = diffStat(patch);
  assert.deepEqual(stat, { added: 1, removed: 1 });
});

test('unifiedDiff: CRLF line endings are preserved, not corrupted to LF', () => {
  const patch = unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n');
  assert.ok(patch.includes('-b\r\n'));
  assert.ok(patch.includes('+c\r\n'));
  assert.ok(!patch.includes('-b\n')); // the bare-LF form must not appear
});

test('unifiedDiff: overlapping changes merge into a single hunk', () => {
  const oldText = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
  const lines = oldText.split('\n');
  lines[1] = 'CHANGED-1';
  lines[4] = 'CHANGED-4'; // within 2*context (3) of the first change -> should merge
  const newText = lines.join('\n');
  const patch = unifiedDiff(oldText, newText, { context: 3 });
  const hunkHeaders = patch.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunkHeaders.length, 1);
});

test('diffStat: counts +/- lines, excluding the ---/+++ headers', () => {
  const patch = unifiedDiff('a\nb\nc\n', 'a\nX\nc\n');
  assert.deepEqual(diffStat(patch), { added: 1, removed: 1 });
});

// ---------------------------------------------------------------------------
// walk.ts
// ---------------------------------------------------------------------------

async function collect(root: string, opts?: Parameters<typeof walk>[1]): Promise<string[]> {
  const out: string[] = [];
  for await (const p of walk(root, opts)) out.push(p);
  return out.sort();
}

test('walk: respects a .gitignore negation', async () => {
  const root = mkdtempSync(join(scratch, 'walk-'));
  writeFileSync(join(root, '.gitignore'), '*.log\n!important.log\n');
  writeFileSync(join(root, 'a.log'), '');
  writeFileSync(join(root, 'important.log'), '');
  writeFileSync(join(root, 'b.txt'), '');

  const files = await collect(root);
  assert.deepEqual(files, ['.gitignore', 'b.txt', 'important.log']);
});

test('walk: hierarchical .gitignore — a nested rule only applies to its own subtree', async () => {
  const root = mkdtempSync(join(scratch, 'walk-'));
  writeFileSync(join(root, '.gitignore'), '*.tmp\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', '.gitignore'), '*.secret\n');
  mkdirSync(join(root, 'other'));

  writeFileSync(join(root, 'x.tmp'), ''); // ignored by root's *.tmp
  writeFileSync(join(root, 'sub', 'y.secret'), ''); // ignored by sub's *.secret
  writeFileSync(join(root, 'sub', 'z.tmp'), ''); // also ignored: root's *.tmp has no slash, applies at any depth
  writeFileSync(join(root, 'sub', 'keep.txt'), '');
  writeFileSync(join(root, 'other', 'w.secret'), ''); // NOT ignored: sub's rule doesn't reach other/

  const files = await collect(root);
  assert.deepEqual(files, ['.gitignore', 'other/w.secret', 'sub/.gitignore', 'sub/keep.txt']);
});

test('walk: never follows a symlinked directory, including one that loops back to root', async () => {
  const root = mkdtempSync(join(scratch, 'walk-'));
  mkdirSync(join(root, 'normal'));
  writeFileSync(join(root, 'normal', 'file.txt'), '');

  const outside = mkdtempSync(join(scratch, 'walk-outside-'));
  writeFileSync(join(outside, 'should-not-appear.txt'), '');

  symlinkSync(root, join(root, 'loop')); // symlinked dir pointing back at root
  symlinkSync(outside, join(root, 'escape')); // symlinked dir pointing outside root

  const files = await collect(root);
  assert.deepEqual(files, ['normal/file.txt']);
});

test('walk: always skips node_modules etc. regardless of .gitignore', async () => {
  const root = mkdtempSync(join(scratch, 'walk-'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '');
  writeFileSync(join(root, 'keep.txt'), '');

  const files = await collect(root);
  assert.deepEqual(files, ['keep.txt']);
});

test('walk: maxEntries stops cleanly without throwing', async () => {
  const root = mkdtempSync(join(scratch, 'walk-'));
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), '');

  const files = await collect(root, { maxEntries: 2 });
  assert.equal(files.length, 2);
});

test('globMatch: * does not cross directory boundaries, ** does', () => {
  assert.equal(globMatch('*.ts', 'foo.ts'), true);
  assert.equal(globMatch('*.ts', 'foo/bar.ts'), false);
  assert.equal(globMatch('**/*.ts', 'foo/bar.ts'), true);
  assert.equal(globMatch('a/**/b', 'a/b'), true);
  assert.equal(globMatch('a/**/b', 'a/x/y/b'), true);
});
