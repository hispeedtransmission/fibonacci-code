import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// A loopback protocol fixture, not a real model/inference result.
test('native CLI loads global rules and invokes startup once, never for utility commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fib-cli-integration-'));
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const cli = resolve(process.env['FIBONACCI_TEST_CLI'] ?? 'src/cli.ts');
  const call = async (args: string[]) => await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', cli, ...args], {
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
  try {
    const globalFile = join(root, 'rules.md');
    const capture = join(root, 'hook.jsonl');
    const hook = `let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{require('node:fs').appendFileSync(process.argv[1],input+'\\n'); console.log('PRIVATE_HOOK_OUTPUT');});`;
    await writeFile(globalFile, 'GLOBAL_RULE_SENTINEL');
    await writeFile(join(root, 'AGENTS.md'), 'PROJECT_RULE_SENTINEL');
    await writeFile(join(root, 'config.json'), JSON.stringify({
      defaultProfile: 'fixture', profiles: { fixture: { provider: 'openai', model: 'fixture-model', baseUrl: `http://127.0.0.1:${address.port}/v1` } },
      globalInstructionsFile: globalFile,
      startupCommand: [process.execPath, '-e', hook, capture],
    }));
    for (const args of [['--help'], ['--version'], ['config', '--json'], ['models'], []]) {
      await call(args);
      await assert.rejects(readFile(capture), { code: 'ENOENT' });
    }
    const result = await call(['-p', 'PRIVATE_PROMPT_SENTINEL', '--quiet']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'FIXTURE_OK');
    const prompt = requests[0]?.messages[0]?.content ?? '';
    assert.ok(prompt.includes('GLOBAL_RULE_SENTINEL'), 'global rules must reach the real request');
    assert.ok(prompt.indexOf('GLOBAL_RULE_SENTINEL') < prompt.indexOf('PROJECT_RULE_SENTINEL'));
    assert.equal(prompt.split('GLOBAL_RULE_SENTINEL').length, 2);
    const lines = (await readFile(capture, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const payload = JSON.parse(lines[0]!);
    assert.deepEqual(Object.keys(payload).sort(), ['headless', 'interactive', 'session_id']);
    assert.equal(payload.headless, true);
    assert.equal(lines.join('').includes('PRIVATE_PROMPT_SENTINEL'), false);
    assert.equal(JSON.stringify(requests).includes('PRIVATE_HOOK_OUTPUT'), false);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'PROJECT_RULE_SENTINEL');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
