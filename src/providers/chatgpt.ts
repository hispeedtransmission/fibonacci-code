import { randomUUID } from 'node:crypto';
import type {
  CompletionRequest,
  Item,
  ModelInfo,
  Provider,
  ReasoningEffort,
  StopReason,
  StreamEvent,
  Usage,
} from './types.ts';
import type { AuthContext } from '../auth/index.ts';
import { parseSseJson } from '../net/sse.ts';
import { postWithRetry } from '../net/http.ts';
import { CancelledError, ProviderError } from '../errors.ts';
import { VERSION } from '../version.ts';

/**
 * The ChatGPT-subscription backend — the OpenAI Responses API as exposed to
 * Codex clients.
 *
 * Notable constraints, all verified against the live endpoint rather than
 * assumed from docs:
 *
 *   - `store: false` is mandatory; this endpoint does not persist responses.
 *   - Only subscription-eligible models are accepted. Asking for `gpt-5-codex`
 *     or `codex-mini-latest` returns a 400 explicitly naming the restriction.
 *   - The `originator` header is optional and unvalidated, so Fibonacci sends
 *     its own name rather than impersonating another client.
 *   - Reasoning items must be replayed verbatim on subsequent turns or the
 *     model loses its chain across tool calls.
 */
export const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Models available to a ChatGPT subscription, verified by probing the live
 * endpoint. This backend has no models-list endpoint, so the list is static and
 * `fib models` revalidates it on request.
 */
export const CHATGPT_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    contextWindow: 400_000,
    supportsTools: true,
    supportsReasoning: true,
  },
];

export const CHATGPT_DEFAULT_MODEL = 'gpt-5.6-sol';

/** This backend rejects 'none'; map it to the lowest real effort. */
function wireEffort(effort: ReasoningEffort | undefined): 'low' | 'medium' | 'high' | 'xhigh' {
  switch (effort) {
    case 'none':
    case 'low':
      return 'low';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    default:
      return 'medium';
  }
}

/** Normalized transcript -> Responses `input` array. */
export function toResponsesInput(items: Item[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    switch (item.type) {
      case 'message':
        out.push({
          type: 'message',
          role: item.role,
          content: [
            item.role === 'user'
              ? { type: 'input_text', text: item.content }
              : { type: 'output_text', text: item.content },
          ],
        });
        break;
      case 'tool_call':
        // Replay the original wire item when we kept it, so any fields we do
        // not model (ids, encrypted payloads) survive the round-trip.
        out.push(item.raw ?? { type: 'function_call', call_id: item.id, name: item.name, arguments: item.args });
        break;
      case 'tool_result':
        out.push({ type: 'function_call_output', call_id: item.id, output: item.output });
        break;
      case 'reasoning':
        if (item.raw) out.push(item.raw);
        break;
    }
  }
  return out;
}

interface ResponsesEvent {
  type: string;
  delta?: string;
  item?: Record<string, unknown>;
  response?: { usage?: Record<string, unknown>; status?: string; incomplete_details?: { reason?: string } };
  error?: { message?: string; code?: string };
  message?: string;
  code?: string;
}

function readUsage(raw: Record<string, unknown> | undefined): Usage | null {
  if (!raw) return null;
  const inputDetails = (raw['input_tokens_details'] ?? {}) as Record<string, unknown>;
  const outputDetails = (raw['output_tokens_details'] ?? {}) as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: Number(raw['input_tokens'] ?? 0),
    outputTokens: Number(raw['output_tokens'] ?? 0),
  };
  const cached = inputDetails['cached_tokens'];
  if (typeof cached === 'number') usage.cachedInputTokens = cached;
  const reasoning = outputDetails['reasoning_tokens'];
  if (typeof reasoning === 'number') usage.reasoningTokens = reasoning;
  return usage;
}

export class ChatGptProvider implements Provider {
  readonly id = 'codex';
  readonly label = 'ChatGPT subscription';
  readonly defaultModel = CHATGPT_DEFAULT_MODEL;
  readonly isSubscription = true;
  readonly modelListIsAuthoritative = true;

  #auth: AuthContext;
  /** Stable per-process id; the backend uses it to group a conversation. */
  #sessionId = randomUUID();

  constructor(auth: AuthContext) {
    this.#auth = auth;
  }

  async listModels(): Promise<ModelInfo[]> {
    return CHATGPT_MODELS;
  }

  async *stream(req: CompletionRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const auth = await this.#auth.headers(signal);
    const body = {
      model: req.model,
      instructions: req.instructions,
      input: toResponsesInput(req.items),
      tools: req.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      })),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: wireEffort(req.reasoningEffort), summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    };

    const res = await postWithRetry(
      this.id,
      CHATGPT_RESPONSES_URL,
      {
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'OpenAI-Beta': 'responses=experimental',
          originator: 'fibonacci',
          session_id: this.#sessionId,
          'User-Agent': `fibonacci-code/${VERSION}`,
        },
        body: JSON.stringify(body),
      },
      signal,
    );

    if (!res.body) throw new ProviderError(this.id, 502, 'The provider returned an empty response body.');

    let stopReason: StopReason = 'stop';
    let sawToolCall = false;
    let emittedDone = false;

    try {
      for await (const { json } of parseSseJson<ResponsesEvent>(res.body, signal)) {
        switch (json.type) {
          case 'response.output_text.delta':
            if (json.delta) yield { type: 'text_delta', text: json.delta };
            break;

          case 'response.reasoning_summary_text.delta':
            if (json.delta) yield { type: 'reasoning_delta', text: json.delta };
            break;

          case 'response.output_item.done': {
            const item = json.item;
            if (!item) break;
            const normalized = normalizeOutputItem(item);
            if (normalized) {
              if (normalized.type === 'tool_call') sawToolCall = true;
              yield { type: 'item', item: normalized };
            }
            break;
          }

          case 'response.completed': {
            const usage = readUsage(json.response?.usage);
            if (usage) yield { type: 'usage', usage };
            stopReason = sawToolCall ? 'tool_calls' : 'stop';
            break;
          }

          case 'response.incomplete': {
            const usage = readUsage(json.response?.usage);
            if (usage) yield { type: 'usage', usage };
            stopReason = json.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop';
            break;
          }

          case 'response.failed':
          case 'error': {
            const msg = json.error?.message ?? json.message ?? 'The provider reported a stream error.';
            throw new ProviderError(this.id, 502, msg, {
              hint: 'This is usually transient. Retry, or lower --effort if the request was very large.',
            });
          }

          default:
            // response.created / in_progress / content_part.* / *.done carry no
            // information we need beyond what output_item.done already gives us.
            break;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' };
        emittedDone = true;
        throw new CancelledError();
      }
      throw err;
    }

    if (!emittedDone) yield { type: 'done', stopReason };
  }
}

/** Responses output item -> normalized transcript item. */
export function normalizeOutputItem(item: Record<string, unknown>): Item | null {
  const type = item['type'];

  if (type === 'function_call') {
    const callId = item['call_id'];
    const name = item['name'];
    if (typeof callId !== 'string' || typeof name !== 'string') return null;
    const args = item['arguments'];
    return {
      type: 'tool_call',
      id: callId,
      name,
      args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      raw: item,
    };
  }

  if (type === 'reasoning') {
    const summaryRaw = item['summary'];
    const summary = Array.isArray(summaryRaw)
      ? summaryRaw
          .map((s) => (typeof s === 'string' ? s : ((s as Record<string, unknown>)?.['text'] as string)))
          .filter((s): s is string => typeof s === 'string')
      : [];
    return { type: 'reasoning', summary, raw: item };
  }

  if (type === 'message') {
    const content = item['content'];
    if (!Array.isArray(content)) return null;
    const text = content
      .map((part) => {
        const p = part as Record<string, unknown>;
        return p['type'] === 'output_text' || p['type'] === 'text' ? (p['text'] as string) : '';
      })
      .join('');
    if (text === '') return null;
    return { type: 'message', role: 'assistant', content: text };
  }

  return null;
}
