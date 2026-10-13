/**
 * CLI-side provider / gateway resolution. Replaces the GUI's localStorage-backed
 * `gatewayConfig` / `apiConfig` / `cliConfig` with environment variables + an
 * `~/.ugs/config.json` / `./.ugs/config.json` file (spec §10.2).
 *
 * Credentials only ever live in `process.env` or in-memory route objects — they
 * are NEVER written to disk or logged by this module. The config FILE carries
 * defaults + non-secret routing (adapter/model/baseUrl/transport); API keys are
 * read exclusively from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
 * `GEMINI_API_KEY` / `GOOGLE_API_KEY`).
 *
 * Pure Node: `node:fs` / `node:path` / `node:os` + `process.env`. No react /
 * zustand / tauri. Reuses the pure model-class helpers locally (mirrors
 * resolver.ts so the CLI need not import the browser-only resolver).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  GatewaySelection,
  NodeGatewayOverride,
} from '../../src/core/ir';
import { adapterProtocol } from '../io/which-cli';
import { SkillReviewUnavailableError } from '../io/skill-review-capability';
import { normalizeSkillLearningConfig } from '../../src/lib/skillLearningConfig';
import type { SkillLearningConfig } from '../../src/runtime/skills/types';

export type GatewayTransport = 'anthropic' | 'openai-compatible' | 'cli';

/** A resolved route: enough to do direct HTTP, or to spawn a CLI with env. */
export interface ResolvedRoute {
  selection: GatewaySelection;
  adapter: string;
  modelClass: string;
  model?: string;
  transport: GatewayTransport;
  mode: 'direct' | 'cli';
  apiKey?: string;
  baseUrl?: string;
  /** Per-spawn env overlay (credentials for CLI adapters). */
  env?: Record<string, string>;
}

const CLI_TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

const DEFAULT_SELECTION: GatewaySelection = {
  adapter: 'claude-code',
  modelClass: 'sonnet',
};

/** Mirror of resolver.ts#looksLikeClaudeModelId. */
function looksLikeClaudeModelId(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  const lower = model.trim().toLowerCase();
  if (!lower) return false;
  return lower.startsWith('claude') || CLI_TIER_ALIASES.has(lower);
}

/** Mirror of resolver.ts#modelClassFromModelId. */
export function modelClassFromModelId(model: unknown): string {
  if (typeof model !== 'string') return DEFAULT_SELECTION.modelClass;
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return DEFAULT_SELECTION.modelClass;
}

function normalizeAdapter(value: unknown): string {
  if (value === 'codex' || value === 'gemini' || value === 'grok') return value;
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  return typeof value === 'string' && value ? value : 'claude-code';
}

function providerHost(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizeKnownProviderModel(
  baseUrl: string | undefined,
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const host = providerHost(baseUrl);
  const lower = trimmed.toLowerCase();
  if (host.includes('integrate.api.nvidia.com')) {
    if (!trimmed.includes('/') && lower.includes('nemotron')) {
      return `nvidia/${lower}`;
    }
  }
  if (host.includes('openrouter.ai')) {
    if (/^glm-\d/i.test(trimmed)) return `z-ai/${lower}`;
    if (lower.startsWith('z-ai/glm-')) return lower;
  }
  if (host.includes('fireworks.ai')) {
    if (!trimmed.includes('/') && lower.startsWith('llama-')) {
      return `accounts/fireworks/models/${lower}`;
    }
  }
  if (
    host.includes('opencode.ai') ||
    host.includes('z.ai') ||
    host.includes('bigmodel.cn')
  ) {
    if (/^glm-\d/i.test(trimmed)) return lower;
  }
  return trimmed;
}

/** Merge a per-node/spec override onto a selection (mirror of mergeGatewaySelection). */
export function applyOverride(
  selection: GatewaySelection,
  override?: NodeGatewayOverride,
): GatewaySelection {
  if (!override) return { ...selection };
  const hasProviderOverride =
    override.providerId !== undefined || override.channelId !== undefined;
  const providerId =
    override.providerId !== undefined
      ? override.providerId
      : override.channelId
        ? undefined
        : selection.providerId;
  return {
    adapter: selection.adapter,
    modelClass: override.modelClass ?? selection.modelClass,
    providerId,
    channelId: override.channelId ?? selection.channelId,
    ...(hasProviderOverride ? {} : selection.systemDefault ? { systemDefault: true } : {}),
  };
}

/** The CLI config-file shape (spec §10.2). All fields optional; secrets excluded. */
interface FucConfigFile {
  version?: number;
  defaults?: {
    adapter?: string;
    model?: string;
    modelClass?: string;
    concurrency?: number;
    maxRetries?: number;
    timeoutSeconds?: number;
  };
  /** Per-adapter direct-HTTP routing (baseUrl/transport/model). Keys are non-secret. */
  providers?: Record<
    string,
    {
      transport?: GatewayTransport;
      baseUrl?: string;
      model?: string;
      /** Per-tier model map for claude (litellm style). */
      models?: Record<string, string>;
    }
  >;
  /** Independent non-secret learning policy; omission inherits and null clears overrides. */
  skillLearning?: Partial<SkillLearningConfig>;
  /** Per-adapter CLI executable paths. */
  adapters?: Record<string, { path?: string }>;
}

let cachedConfig: FucConfigFile | null = null;
let cachedConfigLoaded = false;
let cachedSkillLearningLayers: unknown[] = [];

/**
 * Load + merge `~/.ugs/config.json` then `./.ugs/config.json` (project wins).
 * Pre-rebrand `.owf/` and `.owf.json` paths are read as lower-priority fallbacks.
 */
export function loadFucConfig(cwd: string = process.cwd()): FucConfigFile {
  if (cachedConfigLoaded) return cachedConfig ?? {};
  cachedConfigLoaded = true;
  const home = homedir();
  // `.owf` paths are the pre-rebrand locations, kept as lower-priority
  // fallbacks so existing configs keep working; `.ugs` paths override them.
  const candidates = [
    join(home, '.owf', 'config.json'),
    join(home, '.owf.json'),
    join(home, '.ugs', 'config.json'),
    join(home, '.ugs.json'),
    join(cwd, '.owf', 'config.json'),
    join(cwd, '.owf.json'),
    join(cwd, '.ugs', 'config.json'),
    join(cwd, '.ugs.json'),
  ];
  let merged: FucConfigFile = {};
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FucConfigFile;
      if (Object.prototype.hasOwnProperty.call(parsed, 'skillLearning')) cachedSkillLearningLayers.push(parsed.skillLearning);
      merged = {
        ...merged,
        ...parsed,
        defaults: { ...merged.defaults, ...parsed.defaults },
        providers: { ...merged.providers, ...parsed.providers },
        skillLearning: normalizeSkillLearningConfig(parsed.skillLearning, normalizeSkillLearningConfig(merged.skillLearning)),
        adapters: { ...merged.adapters, ...parsed.adapters },
      };
    } catch {
      /* ignore malformed config */
    }
  }
  cachedConfig = merged;
  return merged;
}

/** Reject invalid reviewer directives before shared normalization can discard them. */
function validateNodeSkillLearningOverrides(value: unknown): void {
  if (value === undefined) return;
  const reject = (): never => { throw new SkillReviewUnavailableError('config', 'Invalid independent reviewer configuration.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const raw = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewTransport') && raw.reviewTransport != null &&
    raw.reviewTransport !== 'anthropic' && raw.reviewTransport !== 'openai-compatible') return reject();
  if (!Object.prototype.hasOwnProperty.call(raw, 'reviewSelection') || raw.reviewSelection == null) return;
  const selected = raw.reviewSelection;
  if (typeof selected !== 'object' || Array.isArray(selected)) return reject();
  const route = selected as Record<string, unknown>;
  if (Object.keys(route).some((key) => !['adapter', 'modelClass', 'providerId', 'channelId', 'model'].includes(key))) return reject();
  for (const key of ['adapter', 'modelClass']) if (typeof route[key] !== 'string' || !(route[key] as string).trim()) return reject();
  // eslint-disable-next-line no-control-regex -- Reject control characters in reviewer routing tokens.
  for (const item of Object.values(route)) if (typeof item !== 'string' || !item.trim() || item.length > 256 || /[\u0000-\u001f\u007f]/.test(item)) return reject();
}

export interface NodeSkillReviewSelectionFlags {
  reviewAdapter?: string;
  reviewProvider?: string;
  reviewChannel?: string;
  reviewModel?: string;
  reviewTransport?: string;
}

/** Product config loading only; credentials remain env-only and are never persisted. */
export function loadNodeSkillLearningConfig(cwd?: string, overrides?: unknown, flags: NodeSkillReviewSelectionFlags = {}): SkillLearningConfig {
  const config = loadFucConfig(cwd);
  for (const layer of cachedSkillLearningLayers) validateNodeSkillLearningOverrides(layer);
  validateNodeSkillLearningOverrides(overrides);
  const base = normalizeSkillLearningConfig(overrides, normalizeSkillLearningConfig(config.skillLearning));
  const selectionFlags = [flags.reviewAdapter, flags.reviewProvider, flags.reviewChannel, flags.reviewModel].some((value) => value !== undefined);
  const selection = base.reviewSelection;
  if (selectionFlags && !selection && (!flags.reviewAdapter || !flags.reviewProvider || !flags.reviewModel)) {
    throw new SkillReviewUnavailableError('config', 'A new reviewer selection requires explicit adapter, provider and model.');
  }
  const next = {
    ...(flags.reviewTransport !== undefined ? { reviewTransport: flags.reviewTransport } : {}),
    ...(selectionFlags ? { reviewSelection: { ...selection,
      adapter: flags.reviewAdapter ?? selection!.adapter,
      modelClass: selection?.modelClass ?? flags.reviewModel,
      ...(flags.reviewProvider !== undefined ? { providerId: flags.reviewProvider } : {}),
      ...(flags.reviewChannel !== undefined ? { channelId: flags.reviewChannel } : {}),
      ...(flags.reviewModel !== undefined ? { model: flags.reviewModel } : {}),
    } } : {}),
  };
  validateNodeSkillLearningOverrides(next);
  return normalizeSkillLearningConfig(next, base);
}

/** Reset the memoised config (testing seam). */
export function resetFucConfigCache(): void {
  cachedConfig = null;
  cachedConfigLoaded = false;
  cachedSkillLearningLayers = [];
}

/** Read an API key from env for an adapter (never from the config file). */
function apiKeyForAdapter(adapter: string): string | undefined {
  const protocol = adapterProtocol(adapter);
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = process.env[n]?.trim();
      if (v) return v;
    }
    return undefined;
  };
  if (protocol === 'codex') return pick('OPENAI_API_KEY');
  if (protocol === 'gemini') return pick('GEMINI_API_KEY', 'GOOGLE_API_KEY');
  if (protocol === 'grok') return pick('XAI_API_KEY');
  return pick('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN');
}

/** Build the per-spawn env overlay for a CLI route (mirror of gatewayRouteEnv, cli branch). */
export function cliRouteEnv(route: ResolvedRoute): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  const { adapter, apiKey, baseUrl, model } = route;
  const protocol = adapterProtocol(adapter);
  if (protocol === 'codex') {
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  } else if (protocol === 'gemini') {
    if (apiKey) {
      env.GEMINI_API_KEY = apiKey;
      env.GOOGLE_API_KEY = apiKey;
    }
    if (baseUrl) env.GOOGLE_GEMINI_BASE_URL = baseUrl;
  } else if (protocol === 'grok') {
    if (apiKey) env.XAI_API_KEY = apiKey;
  } else {
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (model) env.ANTHROPIC_MODEL = model;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Resolve the run's default {@link GatewaySelection} from flags + config + env.
 * `flags` come from `ugs run --adapter/--model/--provider`.
 */
export function resolveSelection(flags: {
  adapter?: string;
  model?: string;
  providerId?: string;
  cwd?: string;
} = {}): GatewaySelection {
  const config = loadFucConfig(flags.cwd);
  const adapter = normalizeAdapter(
    flags.adapter ?? config.defaults?.adapter ?? DEFAULT_SELECTION.adapter,
  );
  const modelHint =
    flags.model ?? config.defaults?.model ?? config.defaults?.modelClass;
  const modelClass = modelHint
    ? adapter === 'claude-code'
      ? modelClassFromModelId(modelHint)
      : modelHint
    : DEFAULT_SELECTION.modelClass;
  return {
    adapter,
    modelClass,
    providerId: flags.providerId,
  };
}

/**
 * Resolve a direct-HTTP route for a selection, or null when none is configured.
 * A direct route requires: an explicit `anthropic` / `openai-compatible`
 * transport for the adapter in config AND an API key in env. Otherwise the run
 * falls back to the CLI path.
 */
export function resolveDirectRoute(
  selection: GatewaySelection,
  cwd?: string,
): ResolvedRoute | null {
  const config = loadFucConfig(cwd);
  const adapter = normalizeAdapter(selection.adapter);
  const provider = providerForSelection(config, selection, adapter);
  const transport = provider?.transport;
  if (transport !== 'anthropic' && transport !== 'openai-compatible') return null;
  const apiKey = apiKeyForAdapter(adapter);
  if (!apiKey) return null;
  const model = resolveModel(adapter, selection.modelClass, provider, transport);
  return {
    selection,
    adapter,
    modelClass: selection.modelClass,
    model,
    transport,
    mode: 'direct',
    apiKey,
    baseUrl: provider?.baseUrl?.trim() || undefined,
  };
}

/** Preserve concrete provider model IDs literally; reject malformed tokens. */
export function validateNodeSkillReviewModel(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,255}$/.test(value) ||
    value === 'default' || CLI_TIER_ALIASES.has(value)) {
    throw new SkillReviewUnavailableError('http', 'A valid concrete reviewer model identifier is required.');
  }
  return value;
}

/** Validate literal reviewer endpoints without repairing credentials or paths. */
export function validateNodeSkillReviewBaseUrl(value: unknown): { baseUrl: string; local: boolean } {
  const reject = (): never => { throw new SkillReviewUnavailableError('http', 'Reviewer URL must be safe HTTP(S) without credentials, query, fragment or path normalization.'); };
  // eslint-disable-next-line no-control-regex -- Reject control characters before URL parsing can normalize them.
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//.test(value) || /[\s\\\u0000-\u001f\u007f?#]/.test(value)) return reject();
  let url: URL;
  try { url = new URL(value); } catch { return reject(); }
  if (!url.hostname || url.username || url.password) return reject();
  const path = value.replace(/^https?:\/\/[^/]+/, '');
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return reject(); }
  if (decoded.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)) return reject();
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(value);
  if (url.protocol !== 'https:' && !local) return reject();
  return { baseUrl: value, local };
}

/**
 * Dedicated reviewer resolution. A single-channel provider must be named exactly;
 * no adapter defaults, CLI spawning, model normalization or gateway fallback.
 */
export function resolveNodeSkillReviewRoute(
  selection: GatewaySelection,
  cwd?: string,
  reviewTransport?: 'anthropic' | 'openai-compatible',
): ResolvedRoute {
  const unavailable = (reason: string): never => { throw new SkillReviewUnavailableError(selection.adapter, reason); };
  if (selection.systemDefault) unavailable('System-default execution is not a completion-only HTTP route.');
  if (selection.channelId !== undefined) unavailable('CLI provider config has one unnamed channel; channelId is unsupported.');
  const providers = loadFucConfig(cwd).providers;
  const providerId = selection.providerId;
  if (!providerId || !providers || !Object.prototype.hasOwnProperty.call(providers, providerId)) {
    return unavailable('An existing explicit reviewer providerId is required.');
  }
  const provider = providers[providerId];
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) ||
    (provider.transport !== 'anthropic' && provider.transport !== 'openai-compatible' && provider.transport !== 'cli')) {
    return unavailable('The reviewer must match an existing HTTP or explicitly overridden CLI provider.');
  }
  if (provider.transport === 'cli' && (!reviewTransport || !provider.baseUrl)) {
    return unavailable('CLI execution is not route proof; an explicit HTTP protocol and endpoint are required.');
  }
  const transport = reviewTransport ?? provider.transport;
  if (transport !== 'anthropic' && transport !== 'openai-compatible') {
    return unavailable('Only an explicit HTTP reviewer transport is supported.');
  }
  const concreteSelection = selection.modelClass !== 'default' && !CLI_TIER_ALIASES.has(selection.modelClass)
    ? selection.modelClass : undefined;
  const model = validateNodeSkillReviewModel(selection.modelOverride !== undefined ? selection.modelOverride :
    provider.models && Object.prototype.hasOwnProperty.call(provider.models, selection.modelClass)
      ? provider.models[selection.modelClass] : concreteSelection ?? provider.model);
  const apiKey = (transport === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN : process.env.OPENAI_API_KEY)?.trim() || undefined;
  const { baseUrl, local } = validateNodeSkillReviewBaseUrl(provider.baseUrl ??
    (transport === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'));
  if (!apiKey && !local) return unavailable('A reviewer HTTP credential or explicit loopback endpoint is required.');
  return { selection: { ...selection }, adapter: selection.adapter, modelClass: selection.modelClass,
    model, transport, mode: 'direct', baseUrl, apiKey,
  };
}

/**
 * Resolve a CLI route (executable + env). Always succeeds for a known adapter:
 * the CLI binary is located lazily at spawn time (which-cli). Injects any
 * configured channel credentials so an imported relay still targets the right
 * endpoint, exactly like the GUI's CLI-transport branch.
 */
export function resolveCliRoute(
  selection: GatewaySelection,
  cwd?: string,
): ResolvedRoute {
  const config = loadFucConfig(cwd);
  const adapter = normalizeAdapter(selection.adapter);
  const provider = providerForSelection(config, selection, adapter);
  const model = resolveModel(adapter, selection.modelClass, provider, 'cli');
  const apiKey = apiKeyForAdapter(adapter);
  const route: ResolvedRoute = {
    selection,
    adapter,
    modelClass: selection.modelClass,
    model,
    transport: 'cli',
    mode: 'cli',
    apiKey,
    baseUrl: provider?.baseUrl?.trim() || undefined,
  };
  const env = cliRouteEnv(route);
  return env ? { ...route, env } : route;
}

/** Resolve the concrete model id/flag for a route (mirror of resolveChannelModel + cliFallbackRoute). */
type ProviderEntry = NonNullable<FucConfigFile['providers']>[string];

function providerForSelection(
  config: FucConfigFile,
  selection: GatewaySelection,
  adapter: string,
): ProviderEntry | undefined {
  const providerId = selection.providerId?.trim();
  if (providerId) {
    const explicit = config.providers?.[providerId];
    if (explicit) return explicit;
  }
  return config.providers?.[adapter] ?? config.providers?.[selection.adapter];
}

function resolveModel(
  adapter: string,
  modelClass: string,
  provider: ProviderEntry | undefined,
  transport: GatewayTransport,
): string | undefined {
  const tierModel = provider?.models?.[modelClass];
  if (tierModel) return normalizeKnownProviderModel(provider?.baseUrl, tierModel);
  const channelModel = normalizeKnownProviderModel(
    provider?.baseUrl,
    provider?.model,
  );

  if (adapter === 'claude-code') {
    if (channelModel) return channelModel;
    if (modelClass === 'default') return undefined;
    // CLI: bare tier alias is mapped by the claude CLI. Direct: omit so the
    // SDK uses its concrete default rather than sending an invalid alias.
    return transport === 'cli' && looksLikeClaudeModelId(modelClass)
      ? modelClass
      : undefined;
  }
  // codex / gemini: real upstream ids pass through.
  return channelModel ?? (modelClass === 'default' ? undefined : modelClass);
}
