import type { Provider } from './types.ts';
import type { ResolvedConfig } from '../config.ts';
import { resolveAuth, type AuthContext } from '../auth/index.ts';
import { ChatGptProvider, CHATGPT_DEFAULT_MODEL } from './chatgpt.ts';
import { OpenAiProvider } from './openai.ts';
import { UsageError } from '../errors.ts';

export * from './types.ts';
export { ChatGptProvider, CHATGPT_MODELS, CHATGPT_DEFAULT_MODEL } from './chatgpt.ts';
export { OpenAiProvider } from './openai.ts';

export interface ProviderHandle {
  provider: Provider;
  auth: AuthContext;
  /** The model actually selected, after config and flag precedence. */
  model: string;
}

/**
 * Build the provider for a resolved config. This is the only place that knows
 * how a profile maps to an implementation, so adding a backend touches exactly
 * this function and the config's built-in profile list.
 */
export async function createProvider(cfg: ResolvedConfig): Promise<ProviderHandle> {
  const auth = await resolveAuth(cfg.profileName, cfg.profile);

  if (cfg.profile.provider === 'codex') {
    const provider = new ChatGptProvider(auth);
    return { provider, auth, model: cfg.model ?? cfg.profile.model ?? CHATGPT_DEFAULT_MODEL };
  }

  const baseUrl = cfg.profile.baseUrl;
  if (!baseUrl) {
    throw new UsageError(
      `Profile "${cfg.profileName}" has no baseUrl.`,
      `Set one with \`fib config set profiles.${cfg.profileName}.baseUrl <url>\`, or pass --base-url.`,
    );
  }

  const opts: ConstructorParameters<typeof OpenAiProvider>[1] = { baseUrl };
  const model = cfg.model ?? cfg.profile.model;
  if (model) opts.model = model;
  if (cfg.profile.headers) opts.extraHeaders = cfg.profile.headers;

  const provider = new OpenAiProvider(auth, opts);
  return { provider, auth, model: model ?? provider.defaultModel };
}
