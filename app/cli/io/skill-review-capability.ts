/** Fail-closed CLI review registry, deliberately separate from full coding. */
import type { SkillReviewModelPort } from '../../src/runtime/skills/types';
export interface CliSkillReviewCapability {
  adapter: string;
  capability: 'completion-only';
  status: 'unavailable';
  reason: string;
}

/** Help flags and read-only sandboxes are not proof of completion-only isolation. */
export function getCliSkillReviewCapability(adapter: string): CliSkillReviewCapability {
  return { adapter, capability: 'completion-only', status: 'unavailable',
    reason: 'CLI 技能复盘隔离未通过实际越权验证；当前通道不支持安全学习，请选择技能专用直连复盘模型。',
  };
}

/** No adapter has been adversarially verified. Do not advertise an unsafe path. */
export function listSupportedCliSkillReviewAdapters(): CliSkillReviewCapability[] {
  return [];
}

export class SkillReviewUnavailableError extends Error {
  readonly code = 'SKILL_REVIEW_UNAVAILABLE';
  constructor(readonly adapter: string, reason: string) {
    super(`SKILL_REVIEW_UNAVAILABLE: ${reason}`);
    this.name = 'SkillReviewUnavailableError';
  }
}

/** Reject before resolving a CLI, reading agent config, or starting any process. */
export function createCliSkillReviewModelPort(adapter: string): SkillReviewModelPort {
  const capability = getCliSkillReviewCapability(adapter);
  throw new SkillReviewUnavailableError(adapter, capability.reason);
}
