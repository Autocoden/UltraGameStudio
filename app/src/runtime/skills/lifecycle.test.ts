import { describe, expect, it } from 'vitest';
import { evaluateSkillLifecycle } from './lifecycle';
import type { SkillEntry } from './types';
const day = 86400000;
const entry = (overrides: Partial<SkillEntry> = {}): SkillEntry => ({
  skillId: 'a', rootId: 'p', name: 'testing-workflows', description: 'Use when testing.', scope: 'project', source: 'background',
  relativePath: 'testing-workflows', revision: 'r', hash: 'h', readOnly: false, autoEditable: true,
  contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'], ...overrides,
});
const config = { autoArchive: true, staleAfterDays: 30, archiveAfterDays: 90 };
describe('pure lifecycle governance', () => {
  it('protects pinned cron referenced external and user-created packages from auto archive', () => {
    for (const [skill, cronReferenced] of [
      [entry({ pinned: true }), false], [entry(), true],
      [entry({ scope: 'external', readOnly: true }), false], [entry({ source: 'user' }), false],
    ] as Array<[SkillEntry, boolean]>) {
      const decision = evaluateSkillLifecycle({ entry: skill, config, now: 100 * day, firstObservedAt: 0, cronReferenced });
      expect(decision.shouldArchive).toBe(false);
      expect(decision.state).toBe('stale');
    }
    expect(evaluateSkillLifecycle({ entry: entry({ contentLocked: true }), config,
      now: 100 * day, firstObservedAt: 0, backgroundCreated: true }).shouldArchive).toBe(true); // pin is distinct
  });

  it('uses recent actual interaction timestamps without mistaking views for adoption', () => {
    const decision = evaluateSkillLifecycle({ entry: entry({ usage: { viewed: 5, delivered: 2, usedWithEvidence: 0, lastActivityAt: 99 * day } }),
      config, now: 100 * day, firstObservedAt: 0 });
    expect(decision.state).toBe('active');
    expect(decision.shouldArchive).toBe(false);
    expect(decision.usedWithEvidence).toBe(false);
    expect(evaluateSkillLifecycle({ entry: entry({ state: 'archived' }), config,
      now: 100 * day, firstObservedAt: 0 })).toMatchObject({ state: 'archived', shouldArchive: false });
  });

  it('uses explicit trusted creation provenance when the catalog source names a managed root', () => {
    const managed = entry({ source: 'ugs-project' });
    expect(evaluateSkillLifecycle({ entry: managed, config, now: 100 * day, firstObservedAt: 0, backgroundCreated: true }).shouldArchive).toBe(true);
    expect(evaluateSkillLifecycle({ entry: managed, config, now: 100 * day, firstObservedAt: 0 }).shouldArchive).toBe(false);
  });

  it('never archives first-observed packages even if a caller supplies zero aging windows', () => {
    const decision = evaluateSkillLifecycle({ entry: entry(), config: { ...config, staleAfterDays: 0, archiveAfterDays: 0 }, now: 1 });
    expect(decision).toMatchObject({ state: 'active', shouldArchive: false });
  });

  it('does not infer background creation authority from any catalog source label', () => {
    for (const source of ['background', 'background-created', 'ugs-project', 'ugs-global']) {
      expect(evaluateSkillLifecycle({ entry: entry({ source }), config, now: 100 * day, firstObservedAt: 0 }).shouldArchive, source).toBe(false);
    }
  });

  it('starts an observation clock instead of archiving a skill on its first scan', () => {
    const decision = evaluateSkillLifecycle({ entry: entry(), config, now: 100 * day });
    expect(decision).toMatchObject({ state: 'active', shouldArchive: false, firstObservedAt: 100 * day });
    const stale = evaluateSkillLifecycle({ entry: entry(), config, now: 131 * day, firstObservedAt: 100 * day });
    expect(stale).toMatchObject({ state: 'stale', shouldArchive: false });
    expect(evaluateSkillLifecycle({ entry: entry(), config, now: 191 * day, firstObservedAt: 100 * day, backgroundCreated: true }).shouldArchive).toBe(true);
  });
});
