import { streamAnthropic } from '@/lib/anthropic';
import { thinkingPlanForRequest } from '../thinkingPlan';
import type { GatewayTextRequest } from '../types';

export async function completeAnthropic(
  request: GatewayTextRequest,
): Promise<string> {
  // 思考深度：Anthropic messages 走原生 `thinking` 字段（enabled + 预算 token，
  // 或 disabled 关闭）。档位 → 预算的映射由 `thinkingLevels` 的模型族表给出。
  const plan = thinkingPlanForRequest(request);
  return streamAnthropic({
    apiKey: request.route.apiKey,
    baseUrl: request.route.baseUrl,
    model: request.route.model,
    system: request.system,
    userContent: request.userContent,
    userImages: request.userImages,
    maxTokens: request.maxTokens,
    thinking: plan?.anthropicThinking ?? undefined,
    signal: request.signal,
    onDelta: request.onDelta,
    onUsage: request.onUsage,
  });
}
