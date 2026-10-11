import type { SkillEntry, SkillLearningConfig } from './types';
export interface SkillLifecycleInput {
  entry: SkillEntry;
  config: Pick<SkillLearningConfig, 'autoArchive' | 'staleAfterDays' | 'archiveAfterDays'>;
  now: number;
  firstObservedAt?: number;
  cronReferenced?: boolean;
  /** Trusted metadata; managed root source alone does not prove ownership. */
  backgroundCreated?: boolean;
}
export interface SkillLifecycleDecision {
  state: SkillEntry['state'];
  shouldArchive: boolean;
  firstObservedAt: number;
  reason: string;
  usedWithEvidence: boolean;
}

/** A recommendation only; no file deletion, merge, archive or host mutation. */
export function evaluateSkillLifecycle(input: SkillLifecycleInput): SkillLifecycleDecision {
  const firstObservedAt = input.firstObservedAt ?? input.now;
  const usedWithEvidence = (input.entry.usage?.usedWithEvidence ?? 0) > 0;
  if (input.entry.state === 'archived') return { state: 'archived', shouldArchive: false, firstObservedAt,
    reason: 'already-archived', usedWithEvidence };
  if (input.firstObservedAt === undefined) return { state: 'active', shouldArchive: false, firstObservedAt,
    reason: 'first-observation', usedWithEvidence };
  const lastActivityAt = Math.max(firstObservedAt, input.entry.usage?.lastActivityAt ?? firstObservedAt);
  const idleDays = Math.max(0, input.now - lastActivityAt) / 86400000;
  const stale = idleDays >= input.config.staleAfterDays;
  const protectedPackage = input.entry.pinned || input.cronReferenced || input.entry.readOnly ||
    input.entry.scope === 'external' || input.backgroundCreated !== true;
  return { state: stale ? 'stale' : 'active', shouldArchive: !protectedPackage && input.config.autoArchive && idleDays >= input.config.archiveAfterDays,
    firstObservedAt, usedWithEvidence, reason: stale ? 'inactive-observation-window' : 'observing' };
}
