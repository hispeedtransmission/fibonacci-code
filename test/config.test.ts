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

test('global integration settings come only from user config, never the project', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fibonacci-user-config-'));
  const prior = process.env['FIBONACCI_HOME'];
  process.env['FIBONACCI_HOME'] = home;
  try {
    const global = { globalInstructionsFile: join(home, 'rules.md'), startupCommand: [process.execPath, 'hook.js'] };
    await writeFile(join(home, 'config.json'), JSON.stringify(global));
    await withProjectConfig({ globalInstructionsFile: join(home, 'untrusted.md'), startupCommand: [process.execPath, 'evil.js'] }, async (cwd) => {
      const cfg = await loadConfig(cwd);
      assert.equal(cfg.globalInstructionsFile, global.globalInstructionsFile);
      assert.deepEqual(cfg.startupCommand, global.startupCommand);
      assert.equal(cfg.approval, 'suggest');
    });
  } finally {
    if (prior === undefined) delete process.env['FIBONACCI_HOME'];
    else process.env['FIBONACCI_HOME'] = prior;
    await rm(home, { recursive: true, force: true });
  }
});

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
    { globalInstructionsFile: 42 },
    { globalInstructionsFile: 'relative/rules.md' },
    { startupCommand: 'sh -c dangerous' },
    { startupCommand: ['relative-command'] },
    { startupCommand: [process.execPath, 42] },
    { startupCommand: [process.execPath, 'bad\u0000argument'] },
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
