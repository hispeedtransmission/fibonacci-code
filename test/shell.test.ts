import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool, runCommand } from '../src/agent/tools/shell.ts';
import { CancelledError } from '../src/errors.ts';

test('runCommand never spawns work when its signal is already aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fib-shell-abort-'));
  const marker = join(dir, 'ran');
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      () =>
        runCommand(`node -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}`, {
          cwd: dir,
          timeoutMs: 5_000,
          signal: controller.signal,
        }),
      CancelledError,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell termination by signal is reported as an error', { skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController();
  const outcome = await bashTool.run(
    { command: 'kill -TERM $$' },
    {
      root: process.cwd(),
      approval: 'full-auto',
      signal: controller.signal,
      commandTimeout: 5,
      requestApproval: async () => true,
      emit() {},
    },
  );

  assert.equal(outcome.isError, true);
  assert.match(outcome.output, /signal SIGTERM/);
});
