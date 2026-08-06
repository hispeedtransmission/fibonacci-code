import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import type { CompletionRequest, Item, Provider, StreamEvent } from '../src/providers/types.ts';
import type { Tool } from '../src/agent/tools/types.ts';
import { CancelledError } from '../src/errors.ts';

/**
 * Loop tests, driven by a scripted provider so no network is involved.
 *
 * The cancellation test is the important one. A transcript containing a
 * `tool_call` with no matching `tool_result` is rejected by the Responses API on
 * the *following* request, which presents as "the tool broke after I pressed
 * Ctrl-C once" — a bug that is miserable to diagnose and trivial to prevent.
 */

/** A provider that replays a fixed script of turns. */
function scriptedProvider(turns: StreamEvent[][]): Provider & { requests: CompletionRequest[] } {
  let index = 0;
  const requests: CompletionRequest[] = [];
  return {
    id: 'fake',
    label: 'Fake',
    defaultModel: 'fake-1',
    isSubscription: false,
    requests,
    async listModels() {
      return [{ id: 'fake-1' }];
    },
    async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone({ ...req, items: req.items as Item[] }));
      const turn = turns[index++] ?? [{ type: 'done', stopReason: 'stop' }];
      for (const evt of turn) yield evt;
    },
  };
}

function echoTool(name = 'echo', impl?: (args: Record<string, unknown>) => Promise<string>): Tool {
  return {
    spec: { name, description: 'echo', parameters: { type: 'object', properties: {}, additionalProperties: true } },
    summarize: (args) => `${name} ${JSON.stringify(args)}`,
    needsApproval: () => false,
    async run(args) {
      return { output: impl ? await impl(args) : `echoed ${JSON.stringify(args)}` };
    },
  };
}

function baseOptions(provider: Provider, tools: Tool[]) {
  return {
    provider,
    model: 'fake-1',
    instructions: 'test',
    tools,
    root: process.cwd(),
    approval: 'full-auto' as const,
    maxTurns: 10,
    commandTimeout: 5,
    requestApproval: async () => true,
  };
}

async function drain(agent: Agent, msg: string, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of agent.send(msg, signal)) events.push(e);
  return events;
}

describe('Agent loop', () => {
  test('completes a plain text turn', async () => {
    const provider = scriptedProvider([
      [
        { type: 'text_delta', text: 'Hello' },
        { type: 'item', item: { type: 'message', role: 'assistant', content: 'Hello' } },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const agent = new Agent(baseOptions(provider, []));
    const events = await drain(agent, 'hi');

    assert.equal(events.filter((e) => e.type === 'text_delta').length, 1);
    assert.equal(events.at(-1)?.type, 'turn_end');
    assert.equal(agent.transcript.length, 2); // user + assistant
  });

  test('runs a tool then continues to a second turn', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '{"x":1}' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        { type: 'item', item: { type: 'message', role: 'assistant', content: 'done' } },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    const events = await drain(agent, 'go');

    assert.ok(events.some((e) => e.type === 'tool_start'));
    const end = events.find((e) => e.type === 'tool_end');
    assert.equal(end?.tool?.ok, true);

    const result = agent.transcript.find((i) => i.type === 'tool_result');
    assert.equal(result?.type === 'tool_result' ? result.id : '', 'c1');

    // The second request must carry the full transcript including the result.
    assert.equal(provider.requests.length, 2);
    assert.ok(provider.requests[1]?.items.some((i) => i.type === 'tool_result'));
  });

  test('feeds an unknown tool name back as a recoverable error', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'nonexistent', args: '{}' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    await drain(agent, 'go');

    const result = agent.transcript.find((i) => i.type === 'tool_result');
    assert.ok(result?.type === 'tool_result' && result.isError);
    assert.match(result.output, /no such tool "nonexistent"/);
    // It must list what IS available, or the model just guesses again.
    assert.match(result.output, /echo/);
  });

  test('feeds malformed tool JSON back rather than crashing', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '{"x": ' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    await drain(agent, 'go');

    const result = agent.transcript.find((i) => i.type === 'tool_result');
    assert.ok(result?.type === 'tool_result' && result.isError);
    assert.match(result.output, /not valid JSON/);
  });

  test('rejects non-object tool arguments', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '[1,2]' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    await drain(agent, 'go');
    const result = agent.transcript.find((i) => i.type === 'tool_result');
    assert.match(result?.type === 'tool_result' ? result.output : '', /must be a JSON object, got array/);
  });

  test('treats empty arguments as {}', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    await drain(agent, 'go');
    const result = agent.transcript.find((i) => i.type === 'tool_result');
    assert.ok(result?.type === 'tool_result' && !result.isError);
  });

  test('converts a throwing tool into an error result, not a crash', async () => {
    const throwing = echoTool('boom', async () => {
      throw new Error('kaboom');
    });
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'boom', args: '{}' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent(baseOptions(provider, [throwing]));
    await drain(agent, 'go');
    const result = agent.transcript.find((i) => i.type === 'tool_result');
    assert.match(result?.type === 'tool_result' ? result.output : '', /kaboom/);
  });

  test('stops at maxTurns and reports it', async () => {
    // A provider that always asks for another tool call: the runaway case.
    const provider: Provider = {
      id: 'loop',
      label: 'Loop',
      defaultModel: 'x',
      isSubscription: false,
      async listModels() {
        return [];
      },
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'item', item: { type: 'tool_call', id: `c${Math.random()}`, name: 'echo', args: '{}' } };
        yield { type: 'done', stopReason: 'tool_calls' };
      },
    };
    const agent = new Agent({ ...baseOptions(provider, [echoTool()]), maxTurns: 3 });
    const events = await drain(agent, 'go');

    const limit = events.find((e) => e.type === 'limit_reached');
    assert.ok(limit, 'must announce the cap rather than pretending to finish');
    assert.equal(limit?.turn, 3);
    assert.equal(events.filter((e) => e.type === 'turn_start').length, 3);
  });

  test('accumulates usage across turns', async () => {
    const provider = scriptedProvider([
      [
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 } },
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '{}' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        { type: 'usage', usage: { inputTokens: 150, outputTokens: 25, cachedInputTokens: 80 } },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    await drain(agent, 'go');
    assert.equal(agent.usage.inputTokens, 250);
    assert.equal(agent.usage.outputTokens, 35);
    assert.equal(agent.usage.cachedInputTokens, 100);
  });

  test('cancellation leaves no tool call without a result', async () => {
    // The provider emits a tool call, then the caller aborts before it runs.
    const controller = new AbortController();
    const provider: Provider = {
      id: 'c',
      label: 'C',
      defaultModel: 'x',
      isSubscription: false,
      async listModels() {
        return [];
      },
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'item', item: { type: 'tool_call', id: 'orphan', name: 'echo', args: '{}' } };
        yield { type: 'done', stopReason: 'tool_calls' };
        controller.abort();
      },
    };
    const agent = new Agent(baseOptions(provider, [echoTool()]));

    await assert.rejects(async () => {
      for await (const _ of agent.send('go', controller.signal)) {
        void _;
      }
    }, CancelledError);

    const calls = agent.transcript.filter((i) => i.type === 'tool_call');
    const results = agent.transcript.filter((i) => i.type === 'tool_result');
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1, 'every tool call must be answered, even on cancel');
    assert.equal(results[0]?.type === 'tool_result' ? results[0].id : '', 'orphan');
  });

  test('setModel changes subsequent requests without dropping the transcript', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'message', role: 'assistant', content: 'first' } },
        { type: 'done', stopReason: 'stop' },
      ],
      [
        { type: 'item', item: { type: 'message', role: 'assistant', content: 'second' } },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const agent = new Agent(baseOptions(provider, []));

    await drain(agent, 'one');
    agent.setModel('fake-2');
    await drain(agent, 'two');

    assert.equal(agent.model, 'fake-2');
    assert.deepEqual(provider.requests.map((request) => request.model), ['fake-1', 'fake-2']);
    assert.equal(agent.transcript.length, 4);
  });

  test('setModel rejects an empty id atomically and trims valid ids', () => {
    const agent = new Agent(baseOptions(scriptedProvider([]), []));

    assert.throws(() => agent.setModel('   '), /Model id cannot be empty/);
    assert.throws(() => agent.setModel('fake 2'), /cannot contain whitespace/);
    assert.throws(() => agent.setModel('fake\x1b[31m'), /cannot contain control characters/);
    assert.equal(agent.model, 'fake-1');
    agent.setModel('  fake-2  ');
    assert.equal(agent.model, 'fake-2');
  });

  test('model changes during send affect the next user turn, not tool continuations', async () => {
    let agent!: Agent;
    const requests: CompletionRequest[] = [];
    let call = 0;
    const provider: Provider = {
      id: 'fake',
      label: 'Fake',
      defaultModel: 'fake-1',
      isSubscription: false,
      async listModels() {
        return [{ id: 'fake-1' }, { id: 'fake-2' }];
      },
      async *stream(req) {
        requests.push(structuredClone({ ...req, items: req.items as Item[] }));
        call++;
        if (call === 1) {
          agent.setModel('fake-2');
          yield { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '{}' } };
          yield { type: 'done', stopReason: 'tool_calls' };
        } else {
          yield { type: 'done', stopReason: 'stop' };
        }
      },
    };
    agent = new Agent(baseOptions(provider, [echoTool()]));

    await drain(agent, 'one');
    await drain(agent, 'two');

    assert.deepEqual(requests.map((request) => request.model), ['fake-1', 'fake-1', 'fake-2']);
  });

  test('instruction factories receive the model and approval snapshot for each user turn', async () => {
    const provider = scriptedProvider([
      [{ type: 'done', stopReason: 'stop' }],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent({
      ...baseOptions(provider, []),
      instructions: (model: string, approval: string) => `active: ${model} ${approval}`,
    });

    await drain(agent, 'one');
    agent.setModel('fake-2');
    agent.setApproval('auto-edit');
    await drain(agent, 'two');

    assert.deepEqual(provider.requests.map((request) => request.instructions), [
      'active: fake-1 full-auto',
      'active: fake-2 auto-edit',
    ]);
  });

  test('setApproval changes the mode used by subsequent tool calls', async () => {
    let observedApproval = '';
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'capture', args: '{}' } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const capture: Tool = {
      spec: { name: 'capture', description: 'capture', parameters: { type: 'object' } },
      summarize: () => 'capture approval',
      needsApproval: () => false,
      async run(_args, ctx) {
        observedApproval = ctx.approval;
        return { output: 'ok' };
      },
    };
    const agent = new Agent(baseOptions(provider, [capture]));

    agent.setApproval('auto-edit');
    await drain(agent, 'go');

    assert.equal(agent.approval, 'auto-edit');
    assert.equal(observedApproval, 'auto-edit');
  });

  test('reset() clears history and usage', async () => {
    const provider = scriptedProvider([
      [
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
        { type: 'item', item: { type: 'message', role: 'assistant', content: 'x' } },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const agent = new Agent(baseOptions(provider, []));
    await drain(agent, 'hi');
    assert.ok(agent.transcript.length > 0);
    agent.reset();
    assert.equal(agent.transcript.length, 0);
    assert.equal(agent.usage.inputTokens, 0);
  });

  test('stops after a length-truncated turn instead of resuming mid-thought', async () => {
    const provider = scriptedProvider([
      [
        { type: 'item', item: { type: 'tool_call', id: 'c1', name: 'echo', args: '{}' } },
        { type: 'done', stopReason: 'length' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ]);
    const agent = new Agent(baseOptions(provider, [echoTool()]));
    await drain(agent, 'go');
    assert.equal(provider.requests.length, 1, 'must not silently continue a truncated response');
  });
});
