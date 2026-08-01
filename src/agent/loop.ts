import type { Item, Provider, StreamEvent, ToolSpec, Usage } from '../providers/types.ts';
import type { ApprovalMode } from '../config.ts';
import { CancelledError, FibonacciError } from '../errors.ts';
import { ToolArgError, type ApprovalRequest, type Tool, type ToolContext } from './tools/index.ts';

/**
 * The agent loop.
 *
 * Structurally simple — ask the model, run whatever tools it asked for, ask
 * again — but three details decide whether it behaves well in practice:
 *
 *   1. **A tool error is data, not a failure.** A bad path, a failing test, a
 *      malformed argument: all of these go back into the transcript as tool
 *      output so the model can correct itself. Only genuine faults (auth,
 *      transport, cancellation) escape as exceptions.
 *
 *   2. **The turn cap is a real bound.** Without one, a model that keeps
 *      re-reading the same file will spend the user's money until the process
 *      is killed. On hitting it we stop and say so plainly rather than
 *      pretending the task finished.
 *
 *   3. **Cancellation must not corrupt the transcript.** Ctrl-C aborts the
 *      in-flight request, but every item already completed stays, and any tool
 *      call left without a result gets a synthetic "cancelled" result. A
 *      Responses-API conversation with a dangling function_call and no
 *      function_call_output is rejected by the server on the next turn — this
 *      is the bug that makes some agents unusable after their first Ctrl-C.
 */

export interface AgentEvent {
  type:
    | 'turn_start'
    | 'text_delta'
    | 'reasoning_delta'
    | 'tool_start'
    | 'tool_end'
    | 'usage'
    | 'turn_end'
    | 'limit_reached';
  text?: string;
  turn?: number;
  tool?: { name: string; summary: string; ok?: boolean; detail?: string; display?: string };
  usage?: Usage;
}

export interface AgentOptions {
  provider: Provider;
  model: string;
  instructions: string;
  tools: Tool[];
  root: string;
  approval: ApprovalMode;
  maxTurns: number;
  commandTimeout: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  requestApproval(req: ApprovalRequest): Promise<boolean>;
}

export class Agent {
  readonly #opts: AgentOptions;
  #items: Item[] = [];
  #totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(opts: AgentOptions) {
    this.#opts = opts;
  }

  get transcript(): readonly Item[] {
    return this.#items;
  }

  get usage(): Usage {
    return this.#totalUsage;
  }

  /** Drop all history. Backs `/clear`. */
  reset(): void {
    this.#items = [];
    this.#totalUsage = { inputTokens: 0, outputTokens: 0 };
  }

  /** Seed history, e.g. when resuming a saved session. */
  load(items: Item[]): void {
    this.#items = [...items];
  }

  #toolSpecs(): ToolSpec[] {
    return this.#opts.tools.map((t) => t.spec);
  }

  /**
   * Run one user message to completion, yielding events for the UI.
   *
   * The generator is the interface deliberately: it lets the caller render
   * progressively and stop consuming at any point, and it keeps every I/O
   * decision (colour, spinners, prompts) out of this file.
   */
  async *send(userMessage: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    this.#items.push({ type: 'message', role: 'user', content: userMessage });

    for (let turn = 1; turn <= this.#opts.maxTurns; turn++) {
      yield { type: 'turn_start', turn };

      const pendingToolCalls: { id: string; name: string; args: string }[] = [];
      let stopReason: StreamEvent extends never ? never : string = 'stop';

      try {
        const stream = this.#opts.provider.stream(
          {
            model: this.#opts.model,
            instructions: this.#opts.instructions,
            items: this.#items,
            tools: this.#toolSpecs(),
            ...(this.#opts.reasoningEffort ? { reasoningEffort: this.#opts.reasoningEffort } : {}),
          },
          signal,
        );

        for await (const event of stream) {
          switch (event.type) {
            case 'text_delta':
              yield { type: 'text_delta', text: event.text };
              break;
            case 'reasoning_delta':
              yield { type: 'reasoning_delta', text: event.text };
              break;
            case 'item':
              this.#items.push(event.item);
              if (event.item.type === 'tool_call') {
                pendingToolCalls.push({ id: event.item.id, name: event.item.name, args: event.item.args });
              }
              break;
            case 'usage':
              this.#accumulate(event.usage);
              yield { type: 'usage', usage: event.usage };
              break;
            case 'done':
              stopReason = event.stopReason;
              break;
          }
        }
      } catch (err) {
        if (signal.aborted || err instanceof CancelledError) {
          // Close the books on any tool call that never got an answer, or the
          // next request will be rejected for an unbalanced transcript.
          this.#settleDanglingToolCalls('Cancelled by the user.');
          throw new CancelledError();
        }
        throw err;
      }

      if (pendingToolCalls.length === 0) {
        yield { type: 'turn_end', turn };
        return;
      }

      for (const call of pendingToolCalls) {
        if (signal.aborted) {
          this.#settleDanglingToolCalls('Cancelled by the user.');
          throw new CancelledError();
        }

        const tool = this.#opts.tools.find((t) => t.spec.name === call.name);
        if (!tool) {
          const known = this.#opts.tools.map((t) => t.spec.name).join(', ');
          this.#items.push({
            type: 'tool_result',
            id: call.id,
            output: `Error: no such tool "${call.name}". Available tools: ${known}.`,
            isError: true,
          });
          continue;
        }

        let parsedArgs: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const raw = call.args.trim() === '' ? '{}' : call.args;
          const parsed: unknown = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            parseError = `Tool arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.`;
          } else {
            parsedArgs = parsed as Record<string, unknown>;
          }
        } catch (err) {
          // Truncated JSON is a real failure mode on long argument streams.
          parseError = `Tool arguments were not valid JSON: ${(err as Error).message}. Re-issue the call with valid JSON.`;
        }

        const summary = parseError ? call.name : safeSummarize(tool, parsedArgs);
        yield { type: 'tool_start', tool: { name: call.name, summary } };

        if (parseError) {
          this.#items.push({ type: 'tool_result', id: call.id, output: `Error: ${parseError}`, isError: true });
          yield { type: 'tool_end', tool: { name: call.name, summary, ok: false, detail: parseError } };
          continue;
        }

        const ctx: ToolContext = {
          root: this.#opts.root,
          approval: this.#opts.approval,
          signal,
          commandTimeout: this.#opts.commandTimeout,
          requestApproval: this.#opts.requestApproval,
          emit: () => {},
        };

        let outcome: { output: string; isError?: boolean; display?: string };
        try {
          outcome = await tool.run(parsedArgs, ctx);
        } catch (err) {
          if (signal.aborted || err instanceof CancelledError) {
            this.#settleDanglingToolCalls('Cancelled by the user.');
            throw new CancelledError();
          }
          // Argument and usage errors are recoverable: hand them to the model.
          if (err instanceof ToolArgError || err instanceof FibonacciError) {
            outcome = { output: `Error: ${(err as Error).message}`, isError: true };
          } else {
            outcome = { output: `Error: ${(err as Error).message ?? String(err)}`, isError: true };
          }
        }

        this.#items.push({
          type: 'tool_result',
          id: call.id,
          output: outcome.output,
          ...(outcome.isError ? { isError: true } : {}),
        });

        yield {
          type: 'tool_end',
          tool: {
            name: call.name,
            summary,
            ok: !outcome.isError,
            ...(outcome.display ? { display: outcome.display } : {}),
          },
        };
      }

      yield { type: 'turn_end', turn };

      if (stopReason === 'length') {
        // Another turn would resume mid-thought; better to stop and let the
        // user decide than to silently produce a truncated result.
        return;
      }
    }

    yield { type: 'limit_reached', turn: this.#opts.maxTurns };
  }

  #accumulate(usage: Usage): void {
    this.#totalUsage = {
      inputTokens: this.#totalUsage.inputTokens + usage.inputTokens,
      outputTokens: this.#totalUsage.outputTokens + usage.outputTokens,
      ...(usage.cachedInputTokens !== undefined
        ? { cachedInputTokens: (this.#totalUsage.cachedInputTokens ?? 0) + usage.cachedInputTokens }
        : {}),
      ...(usage.reasoningTokens !== undefined
        ? { reasoningTokens: (this.#totalUsage.reasoningTokens ?? 0) + usage.reasoningTokens }
        : {}),
    };
  }

  /**
   * Give every unanswered tool call a result. Required for transcript validity;
   * see the note at the top of this file.
   */
  #settleDanglingToolCalls(reason: string): void {
    const answered = new Set(
      this.#items.filter((i): i is Extract<Item, { type: 'tool_result' }> => i.type === 'tool_result').map((i) => i.id),
    );
    for (const item of this.#items) {
      if (item.type === 'tool_call' && !answered.has(item.id)) {
        this.#items.push({ type: 'tool_result', id: item.id, output: reason, isError: true });
        answered.add(item.id);
      }
    }
  }
}

/** `summarize` runs on unvalidated model output; never let it break rendering. */
function safeSummarize(tool: Tool, args: Record<string, unknown>): string {
  try {
    return tool.summarize(args);
  } catch {
    return tool.spec.name;
  }
}
