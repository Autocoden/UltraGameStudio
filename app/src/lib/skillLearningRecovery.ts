import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';

export const pendingSkillReview = (state: SkillReviewState): boolean =>
  ['queued', 'reading', 'proposing', 'applying'].includes(state.status);

/** Reconcile journal truth first: a crash after commit must never repeat a write. */
export function reconcileInterruptedSkillReview(state: SkillReviewState, history: SkillMutationResult[]): SkillReviewState {
  const sameOrigin = (result: SkillMutationResult) =>
    (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const)
      .every((key) => result.origin[key] === state.origin[key]);
  const saved = history.filter(sameOrigin).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  if (saved) return { ...state, status: saved.status, result: saved, error: saved.error, updatedAt: Date.now() };
  const lesson = state.resume
    ? '应用重启中断了复盘，已保留原始证据，可重新复盘。'
    : '旧版只保存了排队状态，没有复盘输入；任务已中断，未确认写入技能。';
  const result: SkillMutationResult = { origin: { ...state.origin }, status: 'failed',
    batchId: `review-${state.origin.runId}`, lesson, error: 'SKILL_REVIEW_INTERRUPTED',
    operationsApplied: 0, changes: [], riskReasons: [] };
  return { ...state, status: result.status, result, error: result.error, updatedAt: Date.now() };
}
