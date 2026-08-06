import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ReasoningEffort } from './providers/types.ts';
import { UsageError } from './errors.ts';
import { projectConfigCandidates, userConfigPath } from './paths.ts';

/**
 * How much rope the agent gets before asking permission.
 *
 * - `suggest`   read freely; every write and every command needs a yes.
 * - `auto-edit` write inside the workspace freely; shell commands need a yes.
 * - `full-auto` no prompts. Intended for sandboxes and CI, not a laptop.
 */
export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['suggest', 'auto-edit', 'full-auto'];

export interface ProfileConfig {
  /** Which provider implementation drives this profile. */
  provider: 'codex' | 'openai';
  /** Base URL for OpenAI-compatible providers. Ignored by `codex`. */
  baseUrl?: string;
  model?: string;
  /** Name of the env var holding the API key. Keys are never stored in config. */
  apiKeyEnv?: string;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer. */
  headers?: Record<string, string>;
}

export interface Config {
  defaultProfile: string;
  profiles: Record<string, ProfileConfig>;
  model?: string;
  reasoningEffort: ReasoningEffort;
  approval: ApprovalMode;
  /** Hard cap on model round-trips per user message. Stops runaway tool loops. */
  maxTurns: number;
  /** Seconds before a shell command is killed. */
  commandTimeout: number;
  /** Disable colour/ANSI. Also honours NO_COLOR. */
  noColor: boolean;
}

/**
 * Built-in profiles. `codex` is the default because it costs nothing extra for
 * anyone who already pays for ChatGPT — which is the whole pitch of this tool.
 */
export const BUILTIN_PROFILES: Record<string, ProfileConfig> = {
  codex: { provider: 'codex' },
  openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder' },
  lmstudio: { provider: 'openai', baseUrl: 'http://localhost:1234/v1' },
  groq: { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  together: { provider: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
  openrouter: {
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    headers: { 'HTTP-Referer': 'https://github.com/hispeedtransmission/fibonacci-code', 'X-Title': 'Fibonacci' },
  },
};

export const DEFAULT_CONFIG: Config = {
  defaultProfile: 'codex',
  profiles: BUILTIN_PROFILES,
  reasoningEffort: 'medium',
  approval: 'suggest',
  maxTurns: 40,
  commandTimeout: 120,
  noColor: false,
};

/** CLI flags, which outrank every file and env var. */
export interface ConfigOverrides {
  profile?: string;
  model?: string;
  baseUrl?: string;
  approval?: ApprovalMode;
  reasoningEffort?: ReasoningEffort;
  maxTurns?: number;
  noColor?: boolean;
}

export interface ResolvedConfig extends Config {
  /** The profile actually in use, after overrides. */
  profileName: string;
  profile: ProfileConfig;
  /** Files that contributed, nearest-wins order. Shown by `fib config`. */
  sources: string[];
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) throw invalidConfig(path, 'root must be a JSON object');
    validateConfigLayer(parsed, path);
    return parsed;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(
      `Config file is not valid JSON: ${path}`,
      `Fix the syntax error, or delete the file to fall back to defaults. (${(err as Error).message})`,
    );
  }
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidConfig(path: string, detail: string): UsageError {
  return new UsageError(`Invalid config in ${path}: ${detail}.`, 'Fix or remove the invalid value; unsafe values are never accepted.');
}

function requireNonemptyString(value: unknown, path: string, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidConfig(path, `${field} must be a non-empty string`);
}

function validateProfile(value: unknown, path: string, field: string, requireProvider = false): void {
  if (!isRecord(value)) throw invalidConfig(path, `${field} must be an object`);
  if (requireProvider && value['provider'] === undefined) throw invalidConfig(path, `${field}.provider is required`);
  if (value['provider'] !== undefined && value['provider'] !== 'codex' && value['provider'] !== 'openai') {
    throw invalidConfig(path, `${field}.provider must be "codex" or "openai"`);
  }
  for (const key of ['baseUrl', 'model', 'apiKeyEnv'] as const) {
    if (value[key] !== undefined) requireNonemptyString(value[key], path, `${field}.${key}`);
  }
  if (value['headers'] !== undefined) {
    if (!isRecord(value['headers'])) throw invalidConfig(path, `${field}.headers must be an object of strings`);
    for (const [name, header] of Object.entries(value['headers'])) {
      requireNonemptyString(name, path, `${field}.headers key`);
      requireNonemptyString(header, path, `${field}.headers.${name}`);
    }
  }
}

function validateConfigLayer(layer: Record<string, unknown>, path: string): void {
  if (layer['defaultProfile'] !== undefined) requireNonemptyString(layer['defaultProfile'], path, 'defaultProfile');
  if (layer['model'] !== undefined) requireNonemptyString(layer['model'], path, 'model');
  if (layer['approval'] !== undefined && !(APPROVAL_MODES as readonly unknown[]).includes(layer['approval'])) {
    throw invalidConfig(path, `approval must be one of ${APPROVAL_MODES.join(', ')}; got ${JSON.stringify(layer['approval'])}`);
  }
  if (layer['reasoningEffort'] !== undefined && !(REASONING_EFFORTS as readonly unknown[]).includes(layer['reasoningEffort'])) {
    throw invalidConfig(path, `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}`);
  }
  for (const key of ['maxTurns', 'commandTimeout'] as const) {
    const value = layer[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
      throw invalidConfig(path, `${key} must be a positive integer`);
    }
  }
  if (layer['noColor'] !== undefined && typeof layer['noColor'] !== 'boolean') {
    throw invalidConfig(path, 'noColor must be a boolean');
  }
  if (layer['profiles'] !== undefined) {
    if (!isRecord(layer['profiles'])) throw invalidConfig(path, 'profiles must be an object');
    for (const [name, profile] of Object.entries(layer['profiles'])) {
      requireNonemptyString(name, path, 'profile name');
      validateProfile(profile, path, `profiles.${name}`);
    }
  }
}

/**
 * Merge one config layer over another. Profiles merge per-key so a project can
 * add a profile without redeclaring the built-ins.
 */
function mergeLayer(base: Config, layer: Record<string, unknown>): Config {
  const out: Config = { ...base, profiles: { ...base.profiles } };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined || value === null) continue;
    if (key === 'profiles') {
      for (const [name, prof] of Object.entries(value as Record<string, ProfileConfig>)) {
        out.profiles[name] = { ...out.profiles[name], ...prof } as ProfileConfig;
      }
    } else if (key in base) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
    // Unknown keys are ignored rather than fatal: forward-compatibility with
    // configs written by a newer version.
  }
  return out;
}

function applyEnv(cfg: Config): Config {
  const out = { ...cfg, profiles: { ...cfg.profiles } };
  const env = process.env;

  if (env['FIBONACCI_PROFILE']) out.defaultProfile = env['FIBONACCI_PROFILE'];
  if (env['FIBONACCI_MODEL']) out.model = env['FIBONACCI_MODEL'];
  if (env['FIBONACCI_APPROVAL'] && (APPROVAL_MODES as string[]).includes(env['FIBONACCI_APPROVAL'])) {
    out.approval = env['FIBONACCI_APPROVAL'] as ApprovalMode;
  }
  if (env['FIBONACCI_MAX_TURNS']) {
    const n = Number.parseInt(env['FIBONACCI_MAX_TURNS'], 10);
    if (Number.isFinite(n) && n > 0) out.maxTurns = n;
  }
  // NO_COLOR is a cross-tool convention (https://no-color.org); honour it.
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') out.noColor = true;
  if (env['FIBONACCI_NO_COLOR']) out.noColor = true;

  // Respect the ambient OpenAI env the user may already have exported. If they
  // pointed OPENAI_BASE_URL at a local server, honour it on the openai profile.
  if (env['OPENAI_BASE_URL']) {
    out.profiles['openai'] = { ...out.profiles['openai'], provider: 'openai', baseUrl: env['OPENAI_BASE_URL'] };
  }
  return out;
}

export async function loadConfig(
  cwd: string = process.cwd(),
  overrides: ConfigOverrides = {},
): Promise<ResolvedConfig> {
  const sources: string[] = [];
  let cfg: Config = { ...DEFAULT_CONFIG, profiles: { ...BUILTIN_PROFILES } };

  const userPath = userConfigPath();
  const userLayer = await readJsonIfExists(userPath);
  if (userLayer) {
    cfg = mergeLayer(cfg, userLayer);
    sources.push(userPath);
  }

  for (const candidate of projectConfigCandidates(cwd)) {
    const layer = await readJsonIfExists(candidate);
    if (layer) {
      cfg = mergeLayer(cfg, layer);
      sources.push(candidate);
      break; // first match wins; don't merge both filenames
    }
  }

  cfg = applyEnv(cfg);
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    validateProfile(profile, sources.at(-1) ?? '<defaults and environment>', `profiles.${name}`, true);
  }

  // CLI flags last.
  if (overrides.approval) cfg.approval = overrides.approval;
  if (overrides.reasoningEffort) cfg.reasoningEffort = overrides.reasoningEffort;
  if (overrides.maxTurns !== undefined) cfg.maxTurns = overrides.maxTurns;
  if (overrides.noColor !== undefined) cfg.noColor = overrides.noColor;
  if (overrides.model) cfg.model = overrides.model;

  const profileName = overrides.profile ?? cfg.defaultProfile;
  const found = cfg.profiles[profileName];
  if (!found) {
    const known = Object.keys(cfg.profiles).sort().join(', ');
    throw new UsageError(`Unknown profile "${profileName}".`, `Known profiles: ${known}`);
  }

  const profile: ProfileConfig = { ...found };
  if (overrides.baseUrl) profile.baseUrl = overrides.baseUrl;
  if (overrides.model) profile.model = overrides.model;

  return { ...cfg, profileName, profile, sources };
}
