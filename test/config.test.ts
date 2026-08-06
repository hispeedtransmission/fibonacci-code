import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

async function withProjectConfig(config: unknown, fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'fibonacci-config-test-'));
  try {
    await writeFile(join(cwd, 'fibonacci.json'), JSON.stringify(config));
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('rejects an invalid file approval mode instead of failing open', async () => {
  await withProjectConfig({ approval: 'full-aut0' }, async (cwd) => {
    await assert.rejects(loadConfig(cwd), /Invalid config.*approval.*full-aut0/i);
  });
});

test('rejects malformed security-relevant scalar config values', async () => {
  for (const config of [
    { maxTurns: 0 },
    { commandTimeout: -1 },
    { noColor: 'false' },
    { reasoningEffort: 'extreme' },
  ]) {
    await withProjectConfig(config, async (cwd) => {
      await assert.rejects(loadConfig(cwd), /Invalid config/i);
    });
  }
});

test('rejects malformed profile definitions before merging them', async () => {
  for (const config of [
    { profiles: [] },
    { profiles: { unsafe: 'codex' } },
    { profiles: { unsafe: { provider: 'other' } } },
    { profiles: { unsafe: { provider: 'openai', headers: { Authorization: 42 } } } },
  ]) {
    await withProjectConfig(config, async (cwd) => {
      await assert.rejects(loadConfig(cwd), /Invalid config/i);
    });
  }
});
