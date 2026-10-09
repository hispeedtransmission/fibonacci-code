import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt } from '../src/agent/prompt.ts';

test('global instructions are additive and project instructions retain final priority', () => {
  const text = buildSystemPrompt({ cwd: '/repo', model: 'test', approval: 'suggest', globalInstructions: 'GLOBAL_SENTINEL', projectDoc: 'PROJECT_SENTINEL' });
  assert.ok(text.includes('GLOBAL_SENTINEL'));
  assert.ok(text.indexOf('GLOBAL_SENTINEL') < text.indexOf('# Project instructions'));
  assert.equal(text.split('GLOBAL_SENTINEL').length, 2);
  assert.match(text, /take precedence over the general guidance above/);
  assert.ok(text.endsWith('PROJECT_SENTINEL'));
  assert.match(text, /Every file write and every shell command is shown to the user/);
});
