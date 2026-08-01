import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesInput, normalizeOutputItem } from '../src/providers/chatgpt.ts';
import { toChatMessages } from '../src/providers/openai.ts';
import type { Item } from '../src/providers/types.ts';

/**
 * Serialization tests.
 *
 * These matter more than they look: an unbalanced transcript — a tool call with
 * no matching result, or a reasoning item dropped on replay — is rejected by the
 * server on the *next* turn, so the symptom appears one step away from the
 * cause. Pinning both directions here makes that class of bug a test failure
 * rather than a confusing 400.
 */

const transcript: Item[] = [
  { type: 'message', role: 'user', content: 'read the file' },
  { type: 'reasoning', summary: ['Checking the file'], raw: { type: 'reasoning', id: 'rs_1', encrypted_content: 'X' } },
  { type: 'tool_call', id: 'call_1', name: 'read_file', args: '{"path":"a.ts"}', raw: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
  { type: 'tool_result', id: 'call_1', output: 'file contents' },
  { type: 'message', role: 'assistant', content: 'Done.' },
];

describe('Responses API serialization', () => {
  test('replays the reasoning item verbatim', () => {
    const input = toResponsesInput(transcript) as Record<string, unknown>[];
    const reasoning = input.find((i) => i['type'] === 'reasoning');
    // Losing encrypted_content silently degrades multi-turn tool use.
    assert.deepEqual(reasoning, { type: 'reasoning', id: 'rs_1', encrypted_content: 'X' });
  });

  test('replays the original function_call wire item when present', () => {
    const input = toResponsesInput(transcript) as Record<string, unknown>[];
    const call = input.find((i) => i['type'] === 'function_call');
    assert.equal(call?.['call_id'], 'call_1');
    assert.equal(call?.['arguments'], '{"path":"a.ts"}');
  });

  test('synthesizes a function_call when no raw item was kept', () => {
    const input = toResponsesInput([
      { type: 'tool_call', id: 'c2', name: 'run_command', args: '{}' },
    ]) as Record<string, unknown>[];
    assert.deepEqual(input[0], { type: 'function_call', call_id: 'c2', name: 'run_command', arguments: '{}' });
  });

  test('maps tool results to function_call_output keyed by call_id', () => {
    const input = toResponsesInput(transcript) as Record<string, unknown>[];
    const out = input.find((i) => i['type'] === 'function_call_output');
    assert.equal(out?.['call_id'], 'call_1');
    assert.equal(out?.['output'], 'file contents');
  });

  test('uses input_text for user and output_text for assistant', () => {
    const input = toResponsesInput(transcript) as Record<string, unknown>[];
    const msgs = input.filter((i) => i['type'] === 'message');
    const user = msgs.find((m) => m['role'] === 'user');
    const asst = msgs.find((m) => m['role'] === 'assistant');
    assert.equal((user?.['content'] as Record<string, unknown>[])[0]?.['type'], 'input_text');
    assert.equal((asst?.['content'] as Record<string, unknown>[])[0]?.['type'], 'output_text');
  });

  test('drops a reasoning item that carries no raw payload', () => {
    const input = toResponsesInput([{ type: 'reasoning', summary: ['x'], raw: undefined }]);
    assert.equal(input.length, 0);
  });
});

describe('normalizeOutputItem', () => {
  test('normalizes a function_call and keeps the raw item', () => {
    const item = normalizeOutputItem({ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"a":1}' });
    assert.equal(item?.type, 'tool_call');
    assert.equal(item.type === 'tool_call' ? item.id : '', 'c1');
    assert.ok(item?.type === 'tool_call' && item.raw, 'raw must be preserved for verbatim replay');
  });

  test('stringifies non-string arguments', () => {
    const item = normalizeOutputItem({ type: 'function_call', call_id: 'c', name: 'n', arguments: { a: 1 } });
    assert.equal(item?.type === 'tool_call' ? item.args : '', '{"a":1}');
  });

  test('returns null for a function_call missing call_id', () => {
    assert.equal(normalizeOutputItem({ type: 'function_call', name: 'x', arguments: '{}' }), null);
  });

  test('extracts text from a message item', () => {
    const item = normalizeOutputItem({
      type: 'message',
      content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'world' }],
    });
    assert.equal(item?.type === 'message' ? item.content : '', 'hello world');
  });

  test('returns null for an empty message rather than an empty item', () => {
    assert.equal(normalizeOutputItem({ type: 'message', content: [] }), null);
  });

  test('reads reasoning summaries in both string and object form', () => {
    const a = normalizeOutputItem({ type: 'reasoning', summary: ['plain'] });
    const b = normalizeOutputItem({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'wrapped' }] });
    assert.deepEqual(a?.type === 'reasoning' ? a.summary : [], ['plain']);
    assert.deepEqual(b?.type === 'reasoning' ? b.summary : [], ['wrapped']);
  });

  test('ignores unknown item types', () => {
    assert.equal(normalizeOutputItem({ type: 'web_search_call' }), null);
  });
});

describe('Chat Completions serialization', () => {
  test('puts instructions in a leading system message', () => {
    const msgs = toChatMessages('be terse', transcript) as Record<string, unknown>[];
    assert.equal(msgs[0]?.['role'], 'system');
    assert.equal(msgs[0]?.['content'], 'be terse');
  });

  test('omits the system message when instructions are empty', () => {
    const msgs = toChatMessages('', transcript) as Record<string, unknown>[];
    assert.notEqual(msgs[0]?.['role'], 'system');
  });

  test('attaches tool calls to an assistant message and answers with a tool message', () => {
    const msgs = toChatMessages('', transcript) as Record<string, unknown>[];
    const assistantWithCalls = msgs.find((m) => m['role'] === 'assistant' && m['tool_calls']);
    assert.ok(assistantWithCalls, 'tool calls must hang off an assistant message');
    const calls = assistantWithCalls?.['tool_calls'] as Record<string, unknown>[];
    assert.equal(calls[0]?.['id'], 'call_1');

    const toolMsg = msgs.find((m) => m['role'] === 'tool');
    assert.equal(toolMsg?.['tool_call_id'], 'call_1');
    assert.equal(toolMsg?.['content'], 'file contents');
  });

  test('groups consecutive tool calls into a single assistant message', () => {
    const msgs = toChatMessages('', [
      { type: 'tool_call', id: 'a', name: 'x', args: '{}' },
      { type: 'tool_call', id: 'b', name: 'y', args: '{}' },
      { type: 'tool_result', id: 'a', output: '1' },
      { type: 'tool_result', id: 'b', output: '2' },
    ]) as Record<string, unknown>[];

    const assistants = msgs.filter((m) => m['role'] === 'assistant');
    assert.equal(assistants.length, 1, 'both calls belong to one assistant turn');
    assert.equal((assistants[0]?.['tool_calls'] as unknown[]).length, 2);
    assert.equal(msgs.filter((m) => m['role'] === 'tool').length, 2);
  });

  test('drops reasoning items, which this protocol has no slot for', () => {
    const msgs = toChatMessages('', transcript) as Record<string, unknown>[];
    assert.ok(!msgs.some((m) => m['role'] === 'reasoning' || m['type'] === 'reasoning'));
  });
});
