/**
 * The provider contract.
 *
 * Fibonacci talks to two structurally different wire protocols:
 *
 *   1. The OpenAI *Responses* API (what a ChatGPT/Codex subscription speaks).
 *      Stateful item list; tool calls carry a `call_id`; reasoning items must be
 *      echoed back verbatim on the next turn or the model loses its chain.
 *
 *   2. The OpenAI *Chat Completions* API (what ~every OpenAI-compatible server
 *      speaks: vLLM, Ollama, LM Studio, Together, Groq, OpenRouter, llama.cpp).
 *      Stateless message array; tool calls live on the assistant message and are
 *      answered by a `tool` role message.
 *
 * Rather than let either shape leak upward, both are normalized to the `Item`
 * transcript and `StreamEvent` union below. The agent loop knows only these.
 *
 * The one concession to reality is `ReasoningItem.raw`: encrypted reasoning
 * payloads are opaque to us but MUST survive a round-trip, so we carry the
 * original wire object and hand it back untouched. Providers that have no
 * concept of reasoning simply drop those items when serializing.
 */

/** A user or assistant message. */
export interface MessageItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
}

/** A model request to invoke a tool. `id` correlates with ToolResultItem.id. */
export interface ToolCallItem {
  type: 'tool_call';
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model — parsed at execution time, not here. */
  args: string;
  /** Original wire item, replayed verbatim when the provider supports it. */
  raw?: unknown;
}

/** Our answer to a ToolCallItem. */
export interface ToolResultItem {
  type: 'tool_result';
  id: string;
  output: string;
  isError?: boolean;
}

/**
 * Model reasoning. `summary` is the human-readable part we render; `raw` is the
 * provider's original item (possibly containing encrypted content) which we
 * replay verbatim so the model keeps its chain of thought across tool turns.
 */
export interface ReasoningItem {
  type: 'reasoning';
  summary: string[];
  raw: unknown;
}

export type Item = MessageItem | ToolCallItem | ToolResultItem | ReasoningItem;

/** A tool exposed to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CompletionRequest {
  model: string;
  /** System prompt. Sent as `instructions` (Responses) or a system message (Chat). */
  instructions: string;
  items: Item[];
  tools: ToolSpec[];
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  maxOutputTokens?: number;
}

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'refusal';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type StreamEvent =
  /** Incremental assistant prose. */
  | { type: 'text_delta'; text: string }
  /** Incremental reasoning summary, when the provider streams one. */
  | { type: 'reasoning_delta'; text: string }
  /** A completed transcript item. The loop appends these in order. */
  | { type: 'item'; item: Item }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: StopReason };

export interface ModelInfo {
  id: string;
  /** Display name when the provider gives us one. */
  label?: string;
  /** Context window in tokens, when known. */
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

export interface Provider {
  /** Stable machine id, e.g. "codex" or "openai". */
  readonly id: string;
  /** Human label for the UI, e.g. "ChatGPT (Codex)". */
  readonly label: string;
  /** Model used when the user has not chosen one. */
  readonly defaultModel: string;
  /** True when this provider bills a subscription rather than per-token API credit. */
  readonly isSubscription: boolean;

  /** Enumerate models. May return a static list when the backend has no models endpoint. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  /** Stream one assistant turn. Must terminate with exactly one `done` event. */
  stream(req: CompletionRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
