import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelMenu, resolveModelChoice, resolveRequestedModel } from '../src/ui/model-selector.ts';
import type { Provider } from '../src/providers/types.ts';
import { stripAnsi, visibleWidth } from '../src/ui/ansi.ts';

const models = [
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', contextWindow: 200_000, supportsTools: true },
  { id: 'qwen3-coder-30b-instruct-super-long-model-name', label: 'Qwen Coder', contextWindow: 32_000 },
];

describe('model selector', () => {
  test('renders numbered choices, marks the current model, and stays within the terminal width', () => {
    const rendered = modelMenu(models, 'gpt-5.6-sol', 38);
    const lines = stripAnsi(rendered).split('\n');

    assert.match(lines[0] ?? '', /FBNC \/ MODEL INDEX.*Select a model/);
    assert.ok(lines.some((line) => /1.*gpt-5\.6-sol.*current/.test(line)));
    assert.ok(lines.some((line) => /2.*qwen3-coder/.test(line)));
    assert.ok(lines.every((line) => visibleWidth(line) <= 38), rendered);
  });

  test('stays width-safe in extremely narrow terminals', () => {
    const prior = process.env['TERM'];
    try {
      for (const term of ['xterm-256color', 'dumb']) {
        process.env['TERM'] = term;
        for (const columns of [1, 3, 6, 10, 19]) {
          const rendered = stripAnsi(modelMenu(models, 'gpt-5.6-sol', columns));
          assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= columns), `${term} ${columns}:\n${rendered}`);
        }
      }
    } finally {
      if (prior === undefined) delete process.env['TERM'];
      else process.env['TERM'] = prior;
    }
  });

  test('keeps cancellation discoverable in narrow selectors', () => {
    const rendered = stripAnsi(modelMenu(models, 'gpt-5.6-sol', 20));
    assert.match(rendered, /q cancel/i);
    assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= 20), rendered);
  });

  test('never truncates a model id inside a joined emoji grapheme', () => {
    const rendered = stripAnsi(modelMenu([{ id: '👩‍💻-model' }], 'other', 7));
    assert.equal(rendered.includes('👩‍…'), false, rendered);
    assert.match(rendered, /👩‍💻/u);
    assert.ok(rendered.split('\n').every((line) => visibleWidth(line) <= 7), rendered);
  });

  test('caps huge catalogs without hiding the current model or breaking catalog numbers', () => {
    const catalog = Array.from({ length: 80 }, (_, index) => ({ id: `model-${index + 1}` }));
    const rendered = stripAnsi(modelMenu(catalog, 'model-80', 50));
    assert.match(rendered, /80.*model-80.*current/);
    assert.match(rendered, /62 more.*exact model id/i);
    assert.ok(rendered.split('\n').length <= 20, rendered);
  });

  test('resolves a number, exact id, empty current selection, and cancel', () => {
    assert.equal(resolveModelChoice('2', models, 'gpt-5.6-sol'), models[1]?.id);
    assert.equal(resolveModelChoice('gpt-5.6-sol', models, 'other'), 'gpt-5.6-sol');
    assert.equal(resolveModelChoice('', models, 'gpt-5.6-sol'), 'gpt-5.6-sol');
    assert.equal(resolveModelChoice('q', models, 'gpt-5.6-sol'), undefined);
  });

  test('prefers an exact catalog id over cancellation aliases', () => {
    assert.equal(resolveModelChoice('q', [{ id: 'q' }], 'other'), 'q');
    assert.equal(resolveModelChoice('cancel', [{ id: 'cancel' }], 'other'), 'cancel');
  });

  test('rejects an out-of-range number or unknown id', () => {
    assert.throws(() => resolveModelChoice('3', models, 'gpt-5.6-sol'), /Unknown model selection/);
    assert.throws(() => resolveModelChoice('not-real', models, 'gpt-5.6-sol'), /Unknown model selection/);
  });

  test('authoritative catalogs reject unknown direct model ids while advisory catalogs accept them', async () => {
    const provider = (authoritative: boolean): Provider => ({
      id: 'fake',
      label: 'Fake',
      defaultModel: 'fake-1',
      isSubscription: authoritative,
      modelListIsAuthoritative: authoritative,
      async listModels() {
        return [{ id: 'fake-1' }];
      },
      async *stream() {},
    });

    await assert.rejects(() => resolveRequestedModel(provider(true), 'fake-2'), /not available/);
    assert.equal(await resolveRequestedModel(provider(false), 'fake-2'), 'fake-2');
  });
});
