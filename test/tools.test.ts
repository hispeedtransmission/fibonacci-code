import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeTool } from '../src/agent/tools/fs.ts';
import { CancelledError } from '../src/errors.ts';

test('an approval followed by cancellation cannot perform the write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fibonacci-tool-cancel-'));
  const controller = new AbortController();
  try {
    const run = writeTool.run(
      { path: 'should-not-exist.txt', content: 'unsafe' },
      {
        root,
        approval: 'suggest',
        signal: controller.signal,
        commandTimeout: 5,
        requestApproval: async () => {
          controller.abort();
          return true;
        },
        emit: () => {},
      },
    );
    await assert.rejects(run, CancelledError);
    assert.equal(existsSync(join(root, 'should-not-exist.txt')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
