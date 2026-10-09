import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs, { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadGlobalInstructions, runStartupCommand } from '../src/integration.ts';

test('startup passes only fresh session metadata over stdin and suppresses output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fib-startup-'));
  try {
    const capture = join(root, 'payload.json');
    const script = `let input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => { require('node:fs').writeFileSync(process.argv[1], JSON.stringify({payload:JSON.parse(input), guard:process.env.FIBONACCI_STARTUP_ACTIVE, arg:process.argv[2]})); console.log('DO_NOT_EXPORT'); console.error('DO_NOT_EXPORT'); });`;
    assert.equal(await runStartupCommand([process.execPath, '-e', script, capture, '$(never-run)'], false), 'ok');
    const captured = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(Object.keys(captured.payload).sort(), ['headless', 'interactive', 'session_id']);
    assert.equal(captured.payload.interactive, false);
    assert.equal(captured.payload.headless, true);
    assert.match(captured.payload.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(captured.guard, '1');
    assert.equal(captured.arg, '$(never-run)');
    assert.equal(await runStartupCommand([process.execPath, '-e', script, capture, 'literal'], true), 'ok');
    const interactive = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(interactive.payload.interactive, true);
    assert.equal(interactive.payload.headless, false);
    assert.notEqual(interactive.payload.session_id, captured.payload.session_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup resolves failed on a synchronous E2BIG spawn exception', async (t) => {
  const spawnMock = t.mock.method(childProcess, 'spawn', () => {
    throw Object.assign(new Error('PRIVATE_ARGV_AND_ENV_SENTINEL'), { code: 'E2BIG' });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await runStartupCommand([process.execPath, '-e', 'process.exit(7)'], false), 'failed');
    assert.equal(spawnMock.mock.callCount(), 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('startup guards prevent recursion and allow opt-out; child failures are bounded', async () => {
  assert.equal(await runStartupCommand([], false), 'skipped');
  for (const key of ['FIBONACCI_STARTUP_ACTIVE', 'FIBONACCI_DISABLE_STARTUP']) {
    const prior = process.env[key];
    process.env[key] = '1';
    try {
      assert.equal(await runStartupCommand([process.execPath, '-e', 'process.exit(7)'], false), 'skipped');
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }
  assert.equal(await runStartupCommand([join(tmpdir(), 'nonexistent-fib-hook')], false), 'failed');
  assert.equal(await runStartupCommand([process.execPath, '-e', 'process.exit(7)'], false), 'failed');
  const start = performance.now();
  assert.equal(await runStartupCommand([process.execPath, '-e', 'setTimeout(() => {}, 4500)'], false), 'failed');
  assert.ok(performance.now() - start < 4000, 'startup timeout must be three seconds, not child lifetime');
});

for (const size of [37, 65_536, 65_537, 131_072]) {
  test(`global instructions handle eight-byte reads at ${size} bytes and close the descriptor`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'fib-short-read-'));
    const path = join(root, 'rules.md');
    const content = 'x'.repeat(size - 8) + 'SUFFIX_!';
    const realOpen = fs.open;
    let closed = false;
    let totalRead = 0;
    let calls = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const file = await realOpen(...args);
      const realRead = file.read.bind(file);
      const realClose = file.close.bind(file);
      t.mock.method(file, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        calls++;
        const result = await realRead(buffer, offset, Math.min(length, 8), position);
        totalRead += result.bytesRead;
        return result;
      });
      t.mock.method(file, 'close', async () => {
        await realClose();
        closed = true;
      });
      return file;
    });
    syncBuiltinESMExports();
    try {
      await writeFile(path, content);
      if (size > 65_536) {
        await assert.rejects(loadGlobalInstructions(path), /global instructions/i);
      } else {
        const actual = await loadGlobalInstructions(path);
        assert.equal(actual.length, content.length, 'must not truncate at the first short read');
        assert.equal(actual, content);
      }
      assert.ok(calls > 1);
      assert.equal(totalRead, Math.min(size, 65_537), 'never read beyond limit+1');
      assert.equal(closed, true, 'descriptor must close on success and rejection');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('global instruction loader follows the canonical symlink and fails visibly on invalid input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fib-global-'));
  try {
    const target = join(root, 'canonical.md');
    // Windows CI may not grant symlink privileges; POSIX exercises the link.
    const link = process.platform === 'win32' ? target : join(root, 'RULES.md');
    await writeFile(target, 'CANONICAL_RULES');
    if (link !== target) await symlink(target, link);
    assert.equal(await loadGlobalInstructions(link), 'CANONICAL_RULES');
    assert.equal(await loadGlobalInstructions(''), '');
    await assert.rejects(loadGlobalInstructions(join(root, 'missing')), /global instructions/i);
    await assert.rejects(loadGlobalInstructions(root), /global instructions/i);
    await writeFile(target, 'x'.repeat(65_537));
    await assert.rejects(loadGlobalInstructions(link), /global instructions/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
