import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const cli = resolve(process.env['FIBONACCI_TEST_CLI'] ?? 'src/cli.ts');

async function callCli(root: string, args: string[], preload?: string) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      ...(preload ? ['--import', pathToFileURL(preload).href] : []), cli, ...args,
    ], {
      cwd: root,
      env: { PATH: process.env['PATH'], HOME: root, FIBONACCI_HOME: root, CODEX_HOME: root, TMPDIR: tmpdir(), NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

test('subscription models help describes advisory suggestions and explicit IDs without claiming availability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fib-models-help-'));
  try {
    // Deliberately fake copy-mode metadata: models must not refresh or call a service.
    await writeFile(join(root, 'auth.json'), JSON.stringify({
      version: 1, credentials: { codex: { kind: 'codex-copy', tokens: {
        access_token: 'not-a-real-token', refresh_token: 'not-a-real-token', account_id: 'fixture',
      } } },
    }));
    const preload = join(root, 'deny-fetch.mjs');
    await writeFile(preload, `globalThis.fetch = async () => { throw new Error('Unexpected service request in static catalog fixture'); };`);
    const result = await callCli(root, ['models'], preload);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /static suggestions, not an exhaustive list/i);
    assert.match(result.stdout, /-m <id>/);
    assert.match(result.stdout, /\/model <id>/);
    assert.match(result.stdout, /service determines.*availability/i);
    assert.doesNotMatch(result.stdout, /limited to the models above|API-only models.*rejected/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ['synchronous E2BIG', 'asynchronous ENOENT']) {
  test(`CLI continues to loopback provider after ${failure} with one private-data-free warning`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fib-cli-spawn-'));
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const server = createServer(async (req, res) => {
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'FIXTURE_OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const hook = join(root, 'PRIVATE_EXECUTABLE_SENTINEL'); // Absent: real async ENOENT.
      const preload = join(root, 'spawn-failure.mjs');
      // Fault injection only at process creation, after the CLI itself launches.
      // Keep the error detail deliberately sensitive-looking to detect disclosure.
      await writeFile(preload, `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const realSpawn = cp.spawn;
        cp.spawn = (file, ...args) => {
          if (file === ${JSON.stringify(hook)}) {
            throw Object.assign(new Error('PRIVATE_ARGV_AND_ENV_SENTINEL'), { code: 'E2BIG' });
          }
          return realSpawn(file, ...args);
        };
        syncBuiltinESMExports();
      `);
      await writeFile(join(root, 'config.json'), JSON.stringify({
        defaultProfile: 'fixture',
        profiles: { fixture: { provider: 'openai', model: 'fixture-model', baseUrl: `http://127.0.0.1:${address.port}/v1` } },
        startupCommand: [hook, 'PRIVATE_ARGV_SENTINEL'],
      }));
      const result = await callCli(root, ['-p', 'PRIVATE_PROMPT_SENTINEL', '--quiet'], failure.startsWith('synchronous') ? preload : undefined);
      assert.equal(result.code, 0, 'optional startup failure must not abort the CLI');
      assert.equal(result.stdout.trim(), 'FIXTURE_OK');
      assert.equal(result.stderr, 'warning: startupCommand failed or timed out; continuing without startup integration.\n');
      assert.equal(requests.length, 1, 'the real loopback provider must be reached exactly once');
      assert.ok(requests[0]!.messages.some(m => m.role === 'user' && m.content === 'PRIVATE_PROMPT_SENTINEL'));
      assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_(?:EXECUTABLE|ARGV|ARGV_AND_ENV)_SENTINEL/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
