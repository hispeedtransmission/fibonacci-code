import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { completeRepl } from '../src/ui/completion.ts';

describe('REPL tab completion', () => {
  test('completes slash command names', () => {
    assert.deepEqual(completeRepl('/m'), [['/model'], '/m']);
    assert.deepEqual(completeRepl('/'), [
      ['/help', '/clear', '/model', '/status', '/usage', '/approval', '/exit', '/quit'],
      '/',
    ]);
  });

  test('completes approval modes', () => {
    assert.deepEqual(completeRepl('/approval a'), [['/approval auto-edit'], '/approval a']);
    assert.deepEqual(completeRepl('/approval '), [
      ['/approval suggest', '/approval auto-edit', '/approval full-auto'],
      '/approval ',
    ]);
  });

  test('does not interfere with ordinary prompts', () => {
    assert.deepEqual(completeRepl('explain this'), [[], 'explain this']);
  });
});
