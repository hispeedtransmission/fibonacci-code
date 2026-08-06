import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionOrEof, routeInteractiveSigint, slashArgumentError } from '../src/commands/run.ts';

test('questionOrEof distinguishes input from a closed readline interface', async () => {
  assert.equal(await questionOrEof({ question: async () => 'answer' }, 'prompt'), 'answer');
  assert.equal(
    await questionOrEof(
      {
        question: async () => {
          throw new Error('readline closed');
        },
      },
      'prompt',
    ),
    undefined,
  );
});

test('interactive Ctrl-C cancels an active turn but closes an idle REPL', () => {
  const controller = new AbortController();
  let questionCancelled = false;
  let closed = false;

  assert.equal(
    routeInteractiveSigint(controller, () => {
      questionCancelled = true;
    }, () => {
      closed = true;
    }),
    'cancelled',
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(questionCancelled, true);
  assert.equal(closed, false);

  assert.equal(routeInteractiveSigint(undefined, undefined, () => { closed = true; }), 'closed');
  assert.equal(closed, true);
});

test('slash commands reject accidental extra arguments before side effects', () => {
  assert.equal(slashArgumentError('clear', ['typo']), 'Usage: /clear');
  assert.equal(slashArgumentError('quit', ['now']), 'Usage: /quit');
  assert.equal(slashArgumentError('approval', ['suggest', 'extra']), 'Usage: /approval <mode>');
  assert.equal(slashArgumentError('model', ['gpt-5.6-sol']), undefined);
});
