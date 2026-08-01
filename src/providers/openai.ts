import type {
  CompletionRequest,
  Item,
  ModelInfo,
  Provider,
  StopReason,
  StreamEvent,
  Usage,
} from './types.ts';
import type { AuthContext } from '../auth/index.ts';
import { parseSseJson } from '../net/sse.ts';
import { getJson, postWithRetry } from '../net/http.ts';
import { CancelledError, ProviderError } from '../errors.ts';
import { VERSION } from '../version.ts';

/**
 * The OpenAI-compatible Chat Completions backend.
 *
 * This is the lingua franca: OpenAI, Azure, Groq, Together, OpenRouter,
 * DeepSeek, Fireworks, vLLM, Ollama, LM Studio, llama.cpp and llamafile all
 * speak it. Pointing Fibonacci at any of them is a base-URL change.
 *
 * The fiddly part is streamed tool calls. They arrive as fragments keyed by
 * `index`, with the name usually in the first fragment and the JSON arguments
 * dribbled across many — so we accumulate per index and only emit a completed
 * `tool_call` item at end of stream. Some servers omit `index` entirely when
 * there is one call, so index defaults to 0.
 */

export interface OpenAiProviderOptions {
  baseUrl: string;
  model?: string;
  extraHeaders?: Record<string, string>;
  label?: string;
}

/** Normalized transcript -> Chat Completions `messages`. */
export function toChatMessages(instructions: string, items: Item[]): unknown[] {
  const messages: unknown[] = [];
  if (instructions.trim() !== '') messages.push({ role: 'system', content: instructions });

  // Consecutive tool calls must be attached to one assistant message, then
  // answered by one `tool` message each, in order.
  let pendingToolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    }
  };

  for (const item of items) {
    switch (item.type) {
      case 'message':
        flushToolCalls();
        messages.push({ role: item.role, content: item.content });
        break;
      case 'tool_call':
        pendingToolCalls.push({
          id: item.id,
          type: 'function',
          function: { name: item.name, arguments: item.args },
        });
        break;
      case 'tool_result':
        flushToolCalls();
        messages.push({ role: 'tool', tool_call_id: item.id, content: item.output });
        break;
      case 'reasoning':
        // Chat Completions has no reasoning item. Dropping it is correct: these
        // servers are stateless and reconstruct context from messages alone.
        break;
    }
  }
  flushToolCalls();
  return messages;
}

interface ChatChunk {
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      /** DeepSeek/Qwen-style reasoning stream. Not in the OpenAI spec but common. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Record<string, unknown> | null;
  error?: { message?: string };
}

function readUsage(raw: Record<string, unknown> | null | undefined): Usage | null {
  if (!raw) return null;
  const usage: Usage = {
    inputTokens: Number(raw['prompt_tokens'] ?? 0),
    outputTokens: Number(raw['completion_tokens'] ?? 0),
  };
  const promptDetails = (raw['prompt_tokens_details'] ?? {}) as Record<string, unknown>;
  const cached = promptDetails['cached_tokens'];
  if (typeof cached === 'number') usage.cachedInputTokens = cached;
  const completionDetails = (raw['completion_tokens_details'] ?? {}) as Record<string, unknown>;
  const reasoning = completionDetails['reasoning_tokens'];
  if (typeof reasoning === 'number') usage.reasoningTokens = reasoning;
  return usage;
}

function mapFinishReason(reason: string | null | undefined, sawToolCall: boolean): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'refusal';
    default:
      return sawToolCall ? 'tool_calls' : 'stop';
  }
}

export class OpenAiProvider implements Provider {
  readonly id = 'openai';
  readonly label: string;
  readonly defaultModel: string;
  readonly isSubscription = false;

  #auth: AuthContext;
  #baseUrl: string;
  #extraHeaders: Record<string, string>;

  constructor(auth: AuthContext, opts: OpenAiProviderOptions) {
    this.#auth = auth;
    // Tolerate a trailing slash so both forms of base URL work.
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#extraHeaders = opts.extraHeaders ?? {};
    this.defaultModel = opts.model ?? 'gpt-4o-mini';
    this.label = opts.label ?? `OpenAI-compatible (${new URL(this.#baseUrl).host})`;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const headers = { ...(await this.#auth.headers(signal)), ...this.#extraHeaders, Accept: 'application/json' };
    const body = await getJson<{ data?: { id?: string; context_length?: number }[] }>(
      this.id,
      `${this.#baseUrl}/models`,
      headers,
      signal,
    );
    const models = (body.data ?? [])
      .filter((m): m is { id: string; context_length?: number } => typeof m.id === 'string')
      .map((m) => {
        const info: ModelInfo = { id: m.id };
        if (typeof m.context_length === 'number') info.contextWindow = m.context_length;
        return info;
      });
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  async *stream(req: CompletionRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const auth = await this.#auth.headers(signal);

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toChatMessages(req.instructions, req.items),
      stream: true,
      // Ask for usage in the final chunk. Servers that don't know this option
      // ignore it; the ones that do give us real token accounting.
      stream_options: { include_usage: true },
    };
    if (req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.maxOutputTokens !== undefined) body['max_tokens'] = req.maxOutputTokens;
    // OpenAI reasoning models accept this; others ignore an unknown field.
    if (req.reasoningEffort && req.reasoningEffort !== 'none') {
      body['reasoning_effort'] = req.reasoningEffort === 'xhigh' ? 'high' : req.reasoningEffort;
    }

    const res = await postWithRetry(
      this.id,
      `${this.#baseUrl}/chat/completions`,
      {
        headers: {
          ...auth,
          ...this.#extraHeaders,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': `fibonacci-code/${VERSION}`,
        },
        body: JSON.stringify(body),
      },
      signal,
    );

    if (!res.body) throw new ProviderError(this.id, 502, 'The provider returned an empty response body.');

    // Accumulators. Tool-call fragments are keyed by their streamed index.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let assistantText = '';
    let finishReason: string | null = null;
    let usage: Usage | null = null;

    try {
      for await (const { json } of parseSseJson<ChatChunk>(res.body, signal)) {
        if (json.error?.message) {
          throw new ProviderError(this.id, 502, json.error.message);
        }
        const chunkUsage = readUsage(json.usage);
        if (chunkUsage) usage = chunkUsage;

        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (typeof delta.content === 'string' && delta.content !== '') {
          assistantText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningDelta === 'string' && reasoningDelta !== '') {
          yield { type: 'reasoning_delta', text: reasoningDelta };
        }

        for (const frag of delta.tool_calls ?? []) {
          const idx = frag.index ?? 0;
          const acc = toolCalls.get(idx) ?? { id: '', name: '', args: '' };
          if (frag.id) acc.id = frag.id;
          if (frag.function?.name) acc.name += frag.function.name;
          if (frag.function?.arguments) acc.args += frag.function.arguments;
          toolCalls.set(idx, acc);
        }
      }
    } catch (err) {
      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' };
        throw new CancelledError();
      }
      throw err;
    }

    if (assistantText !== '') {
      yield { type: 'item', item: { type: 'message', role: 'assistant', content: assistantText } };
    }

    const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);
    for (const [idx, call] of ordered) {
      yield {
        type: 'item',
        item: {
          type: 'tool_call',
          // Local servers sometimes omit ids entirely; synthesize a stable one
          // so the tool result can still be correlated.
          id: call.id !== '' ? call.id : `call_${idx}_${Date.now().toString(36)}`,
          name: call.name,
          args: call.args !== '' ? call.args : '{}',
        },
      };
    }

    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason: mapFinishReason(finishReason, ordered.length > 0) };
  }
}
