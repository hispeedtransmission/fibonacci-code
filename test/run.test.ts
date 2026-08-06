import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionOrEof } from '../src/commands/run.ts';

test('questionOrEof distinguishes input from a closed readline interface', async () => {
  assert.equal(await questionOrEof({ question: async () => 'answer' }, 'prompt'), 'answer');
  assert.equal(
    await questionOrEof(
      {
        question: async () => {
          throw new Error('Aborted with Ctrl+D');
        },
      },
      'prompt',
    ),
    undefined,
  );
});
