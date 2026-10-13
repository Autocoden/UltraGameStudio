import { listGatewayProviders } from '@/lib/gatewayConfig';
import { canUseProviderDirectTransport } from '@/lib/apiConfig';
import { tauriFetch } from '@/lib/tauri';
import { estimateGatewayUsage, usageReportFromAnthropic, usageReportFromOpenAI } from '@/lib/usageMeter';
import type { SkillModelRequest, SkillOrigin, SkillReviewModelPort } from '@/runtime/skills/types';
import type { GatewaySelection, ResolvedGatewayRoute } from './types';

export const SKILL_REVIEW_MAX_RESPONSE_BYTES = 1024 * 1024;
const ANTHROPIC_TIER_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/** Never use the general gateway: its direct-failure path can launch a full CLI. */
export function resolveSkillReviewGatewayRoute(
  selection: GatewaySelection,
  reviewTransport?: 'anthropic' | 'openai-compatible',
): ResolvedGatewayRoute | null {
  if (selection.systemDefault) return null;
  if (reviewTransport !== undefined &&
    (reviewTransport !== 'anthropic' && reviewTransport !== 'openai-compatible' ||
      !selection.providerId || !selection.channelId)) return null;
  const providers = listGatewayProviders().filter((provider) => provider.adapter === selection.adapter &&
    (!selection.providerId || provider.id === selection.providerId));
  const candidates = providers.flatMap((provider) => provider.channels
    .filter((channel) => (!selection.channelId || channel.id === selection.channelId) &&
      (channel.route.transport === 'anthropic' || channel.route.transport === 'openai-compatible' ||
        !!selection.providerId && !!selection.channelId && channel.route.transport === 'cli'))
    .map((channel) => ({ provider, channel })));
  if (candidates.length !== 1) return null;
  const { provider, channel } = candidates[0];
  // Review is a text-only API operation on the exact selected provider/model.
  // Foreground CLI execution and its tools/permissions are never inherited.
  const transport = reviewTransport ?? (channel.route.transport === 'cli'
    ? provider.kind === 'anthropic' ? 'anthropic' : 'openai-compatible'
    : channel.route.transport);
  const baseUrl = channel.route.baseUrl ?? channel.baseUrl;
  if (channel.route.transport === 'cli' && !baseUrl?.trim()) return null;
  if ((transport !== 'anthropic' && transport !== 'openai-compatible') ||
    !canUseProviderDirectTransport(channel.apiKey, baseUrl)) return null;
  const tierModel = Object.prototype.hasOwnProperty.call(ANTHROPIC_TIER_MODELS, selection.modelClass)
    ? ANTHROPIC_TIER_MODELS[selection.modelClass] : undefined;
  const concreteSelection = selection.modelClass !== 'default' && tierModel === undefined
    ? selection.modelClass : undefined;
  const mappedModel = (models: Record<string, string> | undefined) =>
    models && Object.prototype.hasOwnProperty.call(models, selection.modelClass) ? models[selection.modelClass] : undefined;
  const model = selection.modelOverride ?? mappedModel(channel.route.models) ?? mappedModel(channel.models) ??
    (transport === 'openai-compatible' ? concreteSelection : undefined) ??
    channel.route.model ?? channel.model ?? concreteSelection ?? (transport === 'anthropic' ? tierModel : undefined);
  if (typeof model !== 'string' || !model.trim()) return null;
  return {
    selection: { ...selection, providerId: provider.id, channelId: channel.id },
    adapter: provider.adapter, modelClass: selection.modelClass, model,
    providerId: provider.id, providerName: provider.name, channelId: channel.id, channelName: channel.name,
    transport, mode: 'direct', apiKey: channel.apiKey, baseUrl,
    label: `${provider.name} · ${channel.name}`, source: 'global',
  };
}

function assertReviewActive(request: SkillModelRequest, deadline: number): void {
  if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (performance.now() >= deadline) throw new DOMException('SKILL_REVIEW_TIMEOUT: hard budget exhausted', 'TimeoutError');
}

async function withinReviewBudget<T>(request: SkillModelRequest, deadline: number, run: () => Promise<T>): Promise<T> {
  assertReviewActive(request, deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new DOMException('SKILL_REVIEW_TIMEOUT: hard budget exhausted', 'TimeoutError')),
      Math.max(0, deadline - performance.now()));
  });
  try {
    const result = await Promise.race([cancelled, run()]);
    assertReviewActive(request, deadline);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener('abort', onAbort);
  }
}

// Origin is deliberately not sent to the provider; the host owns origin-scoped usage auditing.
export function createSkillReviewModelPort(
  selection: GatewaySelection,
  origin?: SkillOrigin,
  reviewTransport?: 'anthropic' | 'openai-compatible',
): SkillReviewModelPort {
  void origin;
  const route = resolveSkillReviewGatewayRoute(selection, reviewTransport);
  if (!route) throw new Error('SKILL_REVIEW_UNAVAILABLE: 复盘模型缺少明确的供应商、通道、模型或可用 API 地址/凭据，请在技能学习设置中选择复盘模型');
  return {
    capability: 'completion-only',
    async complete(request) {
      const startedAt = performance.now();
      const { system, userContent, maxOutputTokens, timeoutMs } = request;
      if (typeof system !== 'string' || typeof userContent !== 'string' ||
        !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1800000) {
        throw new Error('SKILL_REVIEW_INVALID_REQUEST: text and finite positive limits are required');
      }
      const deadline = startedAt + timeoutMs;
      if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const anthropic = route.transport === 'anthropic';
      const base = (route.baseUrl || (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com')).replace(/\/+$/, '');
      const resource = anthropic ? 'messages' : 'chat/completions';
      const endpoint = base.endsWith(`/${resource}`) ? base :
        /\/(?:v\d+(?:beta)?|openai)$/i.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (anthropic) {
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        if (route.apiKey) headers['x-api-key'] = route.apiKey;
      } else if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
      const init: RequestInit = {
        method: 'POST', headers, signal: request.signal,
        body: JSON.stringify({
          model: route.model, stream: false, max_tokens: maxOutputTokens,
          ...(anthropic ? { system, messages: [{ role: 'user', content: userContent }] } :
            { messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] }),
        }),
      };
      assertReviewActive(request, deadline);
      const response = await withinReviewBudget(request, deadline, () => tauriFetch(endpoint, init,
        { timeoutMs: deadline - performance.now(), maxResponseBytes: SKILL_REVIEW_MAX_RESPONSE_BYTES }));
      if (!response.ok) throw new Error(`SKILL_REVIEW_HTTP_ERROR: HTTP ${response.status}`);
      const payload = await withinReviewBudget(request, deadline, () => response.json());
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('SKILL_REVIEW_INVALID_RESPONSE');
      }
      const message = Array.isArray(payload.choices) ? payload.choices[0]?.message : undefined;
      if (anthropic ? (payload.stop_reason === 'tool_use' || !Array.isArray(payload.content) ||
        payload.content.some((part: unknown) => {
          if (typeof part !== 'object' || part === null || Array.isArray(part) || !('type' in part)) return true;
          if (part.type === 'text') return !('text' in part) || typeof part.text !== 'string';
          return part.type !== 'thinking' && part.type !== 'redacted_thinking';
        })) :
        (!Array.isArray(payload.choices) || payload.choices.length !== 1 ||
          payload.choices[0]?.finish_reason === 'tool_calls' || payload.choices[0]?.finish_reason === 'function_call' ||
          typeof message !== 'object' || message === null || Array.isArray(message) ||
          (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) ||
          message.function_call != null)) {
        throw new Error('SKILL_REVIEW_INVALID_RESPONSE');
      }
      const text = anthropic
        ? payload.content.filter((part: { type?: string; text?: unknown }) => part.type === 'text' && typeof part.text === 'string')
          .map((part: { text: string }) => part.text).join('')
        : message.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('SKILL_REVIEW_INVALID_RESPONSE');
      const reported = anthropic ? usageReportFromAnthropic(payload.usage) : usageReportFromOpenAI(payload.usage);
      const estimated = reported?.inputTokens === undefined || reported?.outputTokens === undefined;
      const estimate = estimateGatewayUsage(system, userContent, text);
      const inputTokens = reported?.inputTokens ?? estimate.inputTokens;
      const outputTokens = reported?.outputTokens ?? estimate.outputTokens;
      assertReviewActive(request, deadline);
      return {
        text,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: estimated ? (inputTokens ?? 0) + (outputTokens ?? 0) :
            reported?.totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
          estimated,
        },
      };
    },
  };
}
