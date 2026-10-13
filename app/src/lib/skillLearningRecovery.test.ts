import { expect, it } from 'vitest';
import { reconcileInterruptedSkillReview } from './skillLearningRecovery';
import type { SkillReviewState, SkillMutationResult } from '@/runtime/skills/types';
const state: SkillReviewState = { status: 'queued', origin: {
  hostId: 'local', workspaceId: 'project', sessionId: 'source', turnId: 'turn', runId: 'review',
} };
it('ends legacy orphan queues without inventing evidence or successful learning', () => {
  expect(reconcileInterruptedSkillReview(state, [])).toMatchObject({ status: 'failed',
    result: { operationsApplied: 0, error: 'SKILL_REVIEW_INTERRUPTED' } });
});
it('recovers a committed result instead of running the interrupted proposal again', () => {
  const committed: SkillMutationResult = { origin: state.origin, status: 'applied', batchId: 'committed',
    lesson: 'Real persisted rule.', operationsApplied: 1, changes: [], riskReasons: [] };
  expect(reconcileInterruptedSkillReview({ ...state, status: 'applying' }, [committed])).toMatchObject({
    status: 'applied', result: committed,
  });
  expect(reconcileInterruptedSkillReview(state, [{ ...committed, origin: { ...state.origin, sessionId: 'other' } }]).status).toBe('failed');
  const rollback = { ...committed, batchId: 'rollback', lesson: 'Reverted.', createdAt: 20 };
  expect(reconcileInterruptedSkillReview(state, [rollback, { ...committed, createdAt: 10 }]).result?.batchId).toBe('rollback');
});
