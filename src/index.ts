/**
 * Library entry point.
 *
 * Fibonacci is a CLI first, but the pieces underneath it are genuinely reusable
 * — the provider abstraction, the agent loop, the tool contract — so they are
 * exported rather than hidden. Anything exported here is covered by semver;
 * anything reachable only by deep import is not.
 */

export { Agent, type AgentEvent, type AgentOptions } from './agent/loop.ts';
export { buildSystemPrompt, PROJECT_DOC_FILES, type PromptContext } from './agent/prompt.ts';
export {
  ALL_TOOLS,
  READONLY_TOOLS,
  toolByName,
  classifyCommand,
  type Tool,
  type ToolContext,
  type ToolOutcome,
  type ApprovalRequest,
} from './agent/tools/index.ts';

export {
  createProvider,
  ChatGptProvider,
  OpenAiProvider,
  CHATGPT_MODELS,
  CHATGPT_DEFAULT_MODEL,
  type Provider,
  type ProviderHandle,
  type CompletionRequest,
  type StreamEvent,
  type Item,
  type ToolSpec,
  type Usage,
  type ModelInfo,
} from './providers/index.ts';

export { resolveAuth, type AuthContext } from './auth/index.ts';
export { loadConfig, DEFAULT_CONFIG, BUILTIN_PROFILES, type Config, type ResolvedConfig, type ApprovalMode } from './config.ts';
export { parseSse, parseSseJson, parseEventBlock, type SseEvent } from './net/sse.ts';
export * from './errors.ts';
export { VERSION } from './version.ts';
