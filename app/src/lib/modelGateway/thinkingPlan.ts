/**
 * Direct（HTTP 直连）通道的思考深度解析入口。
 *
 * CLI / dsh 通道把计划交给 Rust 侧落地（见 `gatewayRouteEnv` 的
 * `UGS_THINKING_PLAN`），而 `anthropic` / `openai-compatible` 直连由各自的
 * HTTP 适配器组包，所以这里把同一份 `resolveThinkingPlan` 结果暴露给它俩，
 * 保证「同一个选择器档位在三条通道上语义一致」。
 */
import {
  declaredLevelsFor,
  parseThinkingLevelOverrides,
  resolveThinkingPlan,
  type ThinkingPlan,
} from '@/lib/thinkingLevels';
import { loadThinkingLevelOverrides } from '@/lib/composerStorage';
import type { GatewayTextRequest } from './types';

/** 本次请求的思考计划；渠道/模型不支持或未选档时返回 null。 */
export function thinkingPlanForRequest(
  request: Pick<GatewayTextRequest, 'route'>,
): ThinkingPlan | null {
  const { route } = request;
  return resolveThinkingPlan(
    {
      adapter: route.adapter,
      baseUrl: route.baseUrl,
      model: route.model,
      transport: route.transport,
      declaredLevels: declaredLevelsFor(
        route.model,
        parseThinkingLevelOverrides(loadThinkingLevelOverrides()),
      ),
    },
    route.selection?.thinkingLevel,
  );
}
