import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionOrEof, routeInteractiveSigint, saveHistory, slashArgumentError } from '../src/commands/run.ts';

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

test('interactive Ctrl-C cancels an active turn and resets idle input', () => {
  const controller = new AbortController();
  let questionCancelled = false;
  let reset = false;

  assert.equal(
    routeInteractiveSigint(controller, () => {
      questionCancelled = true;
    }, () => {
      reset = true;
    }),
    'cancelled',
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(questionCancelled, true);
  assert.equal(reset, false);

  assert.equal(routeInteractiveSigint(undefined, undefined, () => { reset = true; }), 'reset');
  assert.equal(reset, true);

  let selectorCancelled = false;
  reset = false;
  assert.equal(
    routeInteractiveSigint(undefined, () => { selectorCancelled = true; }, () => { reset = true; }),
    'cancelled',
  );
  assert.equal(selectorCancelled, true);
  assert.equal(reset, false);
});

test('history files are created private on POSIX', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'fibonacci-history-test-'));
  const prior = process.env['FIBONACCI_HOME'];
  process.env['FIBONACCI_HOME'] = home;
  try {
    await saveHistory('sensitive prompt');
    assert.equal((await stat(join(home, 'history'))).mode & 0o777, 0o600);
  } finally {
    if (prior === undefined) delete process.env['FIBONACCI_HOME'];
    else process.env['FIBONACCI_HOME'] = prior;
    await rm(home, { recursive: true, force: true });
  }
});

test('slash commands reject accidental extra arguments before side effects', () => {
  assert.equal(slashArgumentError('clear', ['typo']), 'Usage: /clear');
  assert.equal(slashArgumentError('quit', ['now']), 'Usage: /quit');
  assert.equal(slashArgumentError('approval', ['suggest', 'extra']), 'Usage: /approval <mode>');
  assert.equal(slashArgumentError('model', ['gpt-5.6-sol']), undefined);
});
