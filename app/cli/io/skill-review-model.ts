/** Node-only completion port: no agent spawn, tools, hooks, MCP or fallback. */
import { validateNodeSkillReviewBaseUrl, validateNodeSkillReviewModel, type ResolvedRoute } from '../config/providers';
import type { SkillReviewModelPort } from '../../src/runtime/skills/types';
import { SkillReviewUnavailableError } from './skill-review-capability';

/** HTTP transport support is not evidence of a safe coding-CLI capsule. */
export function listSupportedNodeSkillReviewHttpTransports() {
  return [
    { transport: 'anthropic', execution: 'http', capability: 'completion-only' },
    { transport: 'openai-compatible', execution: 'http', capability: 'completion-only' },
  ] as const;
}

export interface NodeSkillReviewModelOptions {
  /** The caller resolves this route; this module never opens credential files. */
  route: ResolvedRoute | null;
  maxResponseBytes?: number;
}

export function createNodeSkillReviewModelPort(options: NodeSkillReviewModelOptions): SkillReviewModelPort {
  const route = options.route;
  if (!route || route.mode !== 'direct' || !['anthropic', 'openai-compatible'].includes(route.transport) || !route.model) {
    throw new SkillReviewUnavailableError(route?.adapter ?? 'unknown', 'No completion-only HTTP route is configured.');
  }
  const { baseUrl } = validateNodeSkillReviewBaseUrl(route.baseUrl ??
    (route.transport === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'));
  const snapshot = { ...route, baseUrl, model: validateNodeSkillReviewModel(route.model) };
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 1024 * 1024) {
    throw new Error('SKILL_REVIEW_INVALID_RESPONSE_LIMIT');
  }
  return {
    capability: 'completion-only',
    async complete(request) {
      const startedAt = performance.now();
      if (request.signal.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 600000 ||
        !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > 100000) {
        throw new Error('SKILL_REVIEW_INVALID_BUDGET');
      }
      const deadline = startedAt + request.timeoutMs;
      const controller = new AbortController();
      let timedOut = false;
      const checkDeadline = () => {
        if (request.signal.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
        if (performance.now() >= deadline) { timedOut = true; throw new Error('SKILL_REVIEW_TIMEOUT'); }
      };
      const abort = () => controller.abort();
      request.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, deadline - performance.now()));
      try {
      const anthropic = snapshot.transport === 'anthropic';
      const resource = anthropic ? 'messages' : 'chat/completions';
      const base = (snapshot.baseUrl ?? (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com')).replace(/\/+$/, '');
      const endpoint = base.endsWith(`/${resource}`) ? base : /\/v\d+(?:beta)?$/.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`;
      const input = JSON.stringify({ model: snapshot.model, stream: false, max_tokens: request.maxOutputTokens,
        ...(anthropic ? { system: request.system, messages: [{ role: 'user', content: request.userContent }] }
          : { messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.userContent }] }),
      });
      checkDeadline();
      const response = await fetch(endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(anthropic ? {
          'anthropic-version': '2023-06-01', ...(snapshot.apiKey ? { 'x-api-key': snapshot.apiKey } : {}),
        } : snapshot.apiKey ? { authorization: `Bearer ${snapshot.apiKey}` } : {}) },
        body: input,
      });
      checkDeadline();
      if (!response.ok) throw new Error(`SKILL_REVIEW_HTTP_ERROR: HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        await response.body?.cancel();
        throw new Error('SKILL_REVIEW_RESPONSE_TOO_LARGE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SKILL_REVIEW_INVALID_RESPONSE');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let received = 0;
      let body = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          checkDeadline();
          if (done) break;
          received += value.byteLength;
          if (received > maxResponseBytes) {
            await reader.cancel();
            throw new Error('SKILL_REVIEW_RESPONSE_TOO_LARGE');
          }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
      const payload = JSON.parse(body);
      if (payload.choices?.some((choice: { finish_reason?: string; message?: { tool_calls?: unknown[]; function_call?: unknown } }) =>
        ['tool_calls', 'function_call'].includes(choice.finish_reason ?? '') ||
        (choice.message?.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0)) || choice.message?.function_call) ||
        payload.stop_reason === 'tool_use' ||
        payload.content?.some((block: { type?: string }) => block.type === 'tool_use' || block.type === 'server_tool_use')) {
        throw new Error('SKILL_REVIEW_TOOL_CALL_REJECTED');
      }
      const text = anthropic ? payload.content?.filter((block: { type: string }) => block.type === 'text')
        .map((block: { text: string }) => block.text).join('') : payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('SKILL_REVIEW_INVALID_RESPONSE');
      const usage = payload.usage;
      const result = { text, ...(usage ? { usage: { inputTokens: anthropic ? usage.input_tokens : usage.prompt_tokens,
        outputTokens: anthropic ? usage.output_tokens : usage.completion_tokens,
        totalTokens: usage.total_tokens, estimated: false } } : {}) };
      checkDeadline();
      return result;
      } catch (error) {
        // Cancel even header/status/parse failures: a cleared timer must not
        // leave an unread or never-ending provider response alive.
        controller.abort();
        if (timedOut || performance.now() >= deadline) throw new Error('SKILL_REVIEW_TIMEOUT');
        if (request.signal.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
        throw error;
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', abort);
      }
    },
  };
}
