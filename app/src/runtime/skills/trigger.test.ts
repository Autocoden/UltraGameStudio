import { describe, expect, it } from 'vitest';
import { shouldTriggerSkillReview, SkillReviewScheduler } from './trigger';
import type { SkillEvidence, SkillLearningConfig, SkillLearningJob, SkillOrigin } from './types';

const origin: SkillOrigin = { hostId: 'local', workspaceId: 'p', sessionId: 's', turnId: 't', runId: 'r' };
const config: SkillLearningConfig = {
  enabled: true, mode: 'auto-safe', activityThreshold: 10, cooldownMs: 60000,
  maxRounds: 6, maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 90000,
  autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90,
};
const activity = (index: number, overrides: Partial<SkillEvidence> = {}): SkillEvidence => ({
  evidenceId: `e${index}`, origin, occurredAt: index, kind: 'tool', provenance: 'native-tool',
  status: 'success', summary: 'real tool', toolCallId: `c${index}`, toolName: 'terminal', ...overrides,
});
const decide = (evidence: SkillEvidence[], overrides: Record<string, unknown> = {}) =>
  shouldTriggerSkillReview({ origin, evidence, config, terminal: 'completed', ...overrides });

const job = (evidence: SkillEvidence[], jobOrigin = origin): SkillLearningJob => ({
  origin: jobOrigin, userText: 'task', finalAnswer: 'done', evidence, loadedSkills: [], config,
});

describe('pure review reservations', () => {
  it('retains failed review evidence for explicit retry without creating a retry timer loop', () => {
    const scheduler = new SkillReviewScheduler();
    const source = job([activity(1, { kind: 'correction', provenance: 'user-input' })]);
    scheduler.observe(source);
    const first = scheduler.take(0)!;
    scheduler.finish(first.id, 'failed');
    expect(scheduler.nextReadyAt()).toBeUndefined();
    expect(scheduler.observe({ ...source, explicit: true }).eligible).toBe(true);
    expect(scheduler.take(1)?.job.evidence.map((item) => item.evidenceId)).toEqual(['e1']);
  });
  it('merges new evidence after a reserved watermark without clearing it on finish', () => {
    const scheduler = new SkillReviewScheduler();
    const ten = Array.from({ length: 10 }, (_, i) => activity(i));
    scheduler.observe(job(ten));
    const first = scheduler.take(0)!;
    const nextOrigin = { ...origin, runId: 'r2', turnId: 't2' };
    const correction = activity(11, { kind: 'correction', provenance: 'user-input', origin: nextOrigin });
    scheduler.observe(job([...ten, correction], nextOrigin));
    scheduler.finish(first.id, 'noop', 1);
    const second = scheduler.take(60000)!;
    expect(second.job.origin).toEqual(nextOrigin);
    expect(second.job.evidence.map((e) => e.evidenceId)).toEqual(['e11']);
    scheduler.finish(second.id, 'noop', 60001);
    expect(scheduler.take(120000)).toBeUndefined();
  });

  it('keeps one merged pending range through the sixty-second cooldown', () => {
    const scheduler = new SkillReviewScheduler();
    scheduler.observe(job([activity(1, { kind: 'correction', provenance: 'user-input' })]));
    const first = scheduler.take(0)!;
    scheduler.finish(first.id, 'noop', 1);
    const nextOrigin = { ...origin, turnId: 't2', runId: 'r2' };
    scheduler.observe(job([activity(2, { kind: 'correction', provenance: 'user-input', origin: nextOrigin })], nextOrigin));
    expect(scheduler.take(59999)).toBeUndefined();
    expect(scheduler.take(60000)?.job.evidence).toHaveLength(1);
  });

  it('retains cancelled evidence and does not spin an automatic retry loop', () => {
    const scheduler = new SkillReviewScheduler();
    const j = job([activity(1, { kind: 'correction', provenance: 'user-input' })]);
    scheduler.observe(j);
    const first = scheduler.take(0)!;
    scheduler.finish(first.id, 'cancelled', 1);
    expect(scheduler.take(60000)).toBeUndefined();
    scheduler.observe({ ...j, explicit: true });
    expect(scheduler.take(2)?.job.evidence).toHaveLength(1);
  });

  it('exposes the next cooldown wake time without scheduling a desktop timer', () => {
    const scheduler = new SkillReviewScheduler();
    scheduler.observe(job([activity(1, { kind: 'correction', provenance: 'user-input' })]));
    const first = scheduler.take(100)!;
    expect(scheduler.nextReadyAt(100)).toBeUndefined();
    scheduler.finish(first.id, 'noop', 101);
    const o2 = { ...origin, turnId: 't2', runId: 'r2' };
    scheduler.observe(job([activity(2, { kind: 'correction', provenance: 'user-input', origin: o2 })], o2));
    expect(scheduler.nextReadyAt(1000)).toBe(60100);
    scheduler.observe({ ...job([activity(2, { kind: 'correction', provenance: 'user-input', origin: o2 })], o2), explicit: true });
    expect(scheduler.nextReadyAt(1000)).toBe(1000);
    const second = scheduler.take(1000)!;
    scheduler.finish(second.id, 'noop', 1001);
    expect(scheduler.nextReadyAt(1001)).toBeUndefined();
  });

  it('bounds retained evidence for long sessions while preserving recent authentic events', () => {
    const scheduler = new SkillReviewScheduler({ maxEvidencePerOrigin: 32 });
    scheduler.observe(job(Array.from({ length: 200 }, (_, i) => activity(i))));
    const review = scheduler.take(0)!;
    expect(review.job.evidence).toHaveLength(32);
    expect(review.job.evidence.at(-1)?.evidenceId).toBe('e199');
  });

  it('preserves new eligible evidence arriving during a cancelled reservation', () => {
    const scheduler = new SkillReviewScheduler();
    const ten = Array.from({ length: 10 }, (_, i) => activity(i));
    scheduler.observe(job(ten)); const first = scheduler.take(0)!;
    const o2 = { ...origin, runId: 'r2', turnId: 't2' };
    scheduler.observe(job([activity(11, { kind: 'correction', provenance: 'user-input', origin: o2 })], o2));
    scheduler.finish(first.id, 'cancelled', 1);
    expect(scheduler.take(60000)?.job.evidence).toHaveLength(11);
  });

  it('freezes redacted evidence and config before retaining a scheduler snapshot', () => {
    const scheduler = new SkillReviewScheduler();
    const j = job([activity(1, { kind: 'correction', provenance: 'user-input', summary: 'password=unsafe-example' })]);
    scheduler.observe(j);
    j.config = { ...config, enabled: false };
    j.evidence[0].summary = 'late mutation';
    const review = scheduler.take(0)!;
    expect(review.job.evidence[0].summary).toContain('[REDACTED]');
    expect(review.job.evidence[0].summary).not.toContain('unsafe-example');
    expect(review.job.config.enabled).toBe(true);
  });

  it('does not schedule a newly observed nonterminal turn when the previous review finishes', () => {
    for (const terminal of ['running', 'failed', 'cancelled'] as const) {
      const scheduler = new SkillReviewScheduler();
      scheduler.observe(job([activity(1, { kind: 'correction', provenance: 'user-input' })]));
      const first = scheduler.take(0)!;
      const nextOrigin = { ...origin, runId: 'r2', turnId: 't2' };
      const next = job([activity(2, { kind: 'correction', provenance: 'user-input', origin: nextOrigin })], nextOrigin);
      expect(scheduler.observe({ ...next, explicit: true }, terminal).eligible).toBe(false);
      scheduler.finish(first.id, 'noop');
      expect(scheduler.nextReadyAt(60000)).toBeUndefined();
      expect(scheduler.take(60000)).toBeUndefined();
      scheduler.observe(next, 'completed');
      expect(scheduler.take(60000)?.job.evidence.map((item) => item.evidenceId)).toEqual(['e2']);
    }
  });

  it('consumes explicit eligibility once and never keeps an empty range pending', () => {
    const scheduler = new SkillReviewScheduler();
    const explicit = { ...job([activity(1)]), explicit: true };
    expect(scheduler.observe(explicit).reason).toBe('explicit');
    const review = scheduler.take(0)!;
    scheduler.finish(review.id, 'noop');
    expect(scheduler.nextReadyAt(1)).toBeUndefined();
    expect(scheduler.take(1)).toBeUndefined();
    expect(scheduler.observe(explicit).eligible).toBe(false);
    expect(scheduler.nextReadyAt(60000)).toBeUndefined();
  });

  it('explicit requests cannot bypass learning-off or lack of authentic completed evidence', () => {
    for (const evidence of [[], [activity(1, { status: 'unknown' })], [activity(1, { provenance: 'model-output' })]]) {
      const scheduler = new SkillReviewScheduler();
      expect(scheduler.observe({ ...job(evidence), explicit: true }).eligible).toBe(false);
      expect(scheduler.take(0)).toBeUndefined();
    }
    const scheduler = new SkillReviewScheduler();
    expect(scheduler.observe({ ...job([activity(1)]), explicit: true, config: { ...config, mode: 'off' } }).eligible).toBe(false);
    expect(scheduler.take(0)).toBeUndefined();
  });

  it('keeps the internal covered watermark independent of the returned reservation', () => {
    const scheduler = new SkillReviewScheduler();
    scheduler.observe(job(Array.from({ length: 10 }, (_, i) => activity(i))));
    const first = scheduler.take(0)!;
    first.watermark = 1000;
    const nextOrigin = { ...origin, runId: 'r2', turnId: 't2' };
    scheduler.observe(job([activity(11, { kind: 'correction', provenance: 'user-input', origin: nextOrigin })], nextOrigin));
    scheduler.finish(first.id, 'noop');
    expect(scheduler.take(60000)?.job.evidence.map((item) => item.evidenceId)).toEqual(['e11']);
  });

  it('detaches reservation origin config and loaded skills from retained scheduler state', () => {
    const scheduler = new SkillReviewScheduler();
    const j = job([activity(1, { kind: 'correction', provenance: 'user-input' })]);
    j.loadedSkills = [{ skillId: 'skill', revision: 'r', hash: 'h', files: ['SKILL.md'] }];
    scheduler.observe(j);
    const first = scheduler.take(0)!;
    first.job.origin.workspaceId = 'foreign';
    first.job.config.enabled = false;
    first.job.loadedSkills[0].files.push('references/invented.md');
    scheduler.finish(first.id, 'cancelled');
    scheduler.observe({ ...j, explicit: true });
    const next = scheduler.take(1)!;
    expect(next.job.origin).toEqual(origin);
    expect(next.job.config.enabled).toBe(true);
    expect(j.loadedSkills[0].files).toEqual(['SKILL.md']);
  });

  it('does not re-review an old terminal snapshot after bounded identity retention evicts its oldest keys', () => {
    const scheduler = new SkillReviewScheduler({ maxEvidencePerOrigin: 16 });
    const old = job(Array.from({ length: 100 }, (_, i) => activity(i)));
    scheduler.observe(old);
    scheduler.finish(scheduler.take(0)!.id, 'noop');
    expect(scheduler.observe(old).eligible).toBe(false);
    expect(scheduler.take(60000)).toBeUndefined();
    const fresh = activity(101, { kind: 'correction', provenance: 'user-input' });
    scheduler.observe(job([...old.evidence, fresh]));
    expect(scheduler.take(60000)?.job.evidence.map((item) => item.evidenceId)).toEqual(['e101']);
  });

  it('preserves fresh-run evidence even when its clock is earlier than an evicted old-run range', () => {
    const scheduler = new SkillReviewScheduler({ maxEvidencePerOrigin: 16 });
    scheduler.observe(job(Array.from({ length: 100 }, (_, i) => activity(i, { occurredAt: 1000 + i }))));
    scheduler.finish(scheduler.take(0)!.id, 'noop');
    const nextOrigin = { ...origin, runId: 'r2', turnId: 't2' };
    const correction = activity(101, { kind: 'correction', provenance: 'user-input', origin: nextOrigin, occurredAt: 1 });
    expect(scheduler.observe(job([correction], nextOrigin)).eligible).toBe(true);
    expect(scheduler.take(60000)?.job.evidence).toEqual([correction]);
  });

  it('freezes nested review selection against caller mutation before reservation', () => {
    const scheduler = new SkillReviewScheduler();
    const j = { ...job([activity(1, { kind: 'correction', provenance: 'user-input' })]),
      config: { ...config, reviewSelection: { adapter: 'openai', modelClass: 'fast', model: 'original' } } };
    scheduler.observe(j);
    j.config.reviewSelection.model = 'changed-after-observation';
    const reservation = scheduler.take(0)!;
    expect(reservation.job.config.reviewSelection?.model).toBe('original');
  });

  it('rejects capacity overflow instead of dropping a pending or active origin', () => {
    const scheduler = new SkillReviewScheduler({ maxOrigins: 1 });
    const firstJob = job([activity(1, { kind: 'correction', provenance: 'user-input' })]);
    scheduler.observe(firstJob);
    const secondOrigin = { ...origin, sessionId: 'second' };
    const secondJob = job([activity(2, { origin: secondOrigin, kind: 'correction', provenance: 'user-input' })], secondOrigin);
    expect(scheduler.observe(secondJob).reason).toBe('scheduler-capacity');
    const first = scheduler.take(0)!;
    expect(first.job.origin.sessionId).toBe(origin.sessionId);
    expect(scheduler.observe(secondJob).eligible).toBe(false);
    scheduler.finish(first.id, 'noop');
    expect(scheduler.observe(secondJob).eligible).toBe(true);
    expect(scheduler.take(1)?.job.origin.sessionId).toBe('second');
  });

  it('reserves one global review and deduplicates repeated terminal delivery', () => {
    const scheduler = new SkillReviewScheduler();
    const ten = Array.from({ length: 10 }, (_, i) => activity(i));
    expect(scheduler.observe(job(ten)).eligible).toBe(true);
    const review = scheduler.take(0)!;
    expect(review.job.evidence).toHaveLength(10);
    scheduler.observe(job(ten));
    expect(scheduler.take(0)).toBeUndefined();
    scheduler.finish(review.id, 'noop', 1);
    expect(scheduler.take(60001)).toBeUndefined();
  });
});

describe('automatic review eligibility', () => {
  it('ignores duplicated unknown simulated auxiliary and nonterminal activity', () => {
    const ten = Array.from({ length: 10 }, (_, i) => activity(i));
    expect(decide([...Array(10)].map(() => activity(1))).eligible).toBe(false);
    expect(decide(ten.map((e) => ({ ...e, status: 'unknown' }))).eligible).toBe(false);
    expect(decide(ten.map((e) => ({ ...e, provenance: 'ui-synthetic' }))).eligible).toBe(false);
    expect(decide(ten.map((e) => ({ ...e, origin: { ...origin, workspaceId: 'other' } }))).eligible).toBe(false);
    expect(decide(ten, { terminal: 'running' }).eligible).toBe(false);
    expect(decide(ten, { terminal: 'cancelled' }).eligible).toBe(false);
    expect(decide(ten, { auxiliary: true }).eligible).toBe(false);
    expect(decide(ten, { config: { ...config, enabled: false } }).eligible).toBe(false);
    expect(decide(ten, { config: { ...config, mode: 'off' } }).eligible).toBe(false);
  });

  it('lets a real user correction bypass the activity threshold', () => {
    const correction = activity(0, { kind: 'correction', provenance: 'user-input', summary: '先运行测试再修改' });
    expect(decide([correction])).toMatchObject({ eligible: true, reason: 'strong-signal', strongSignal: true });
    expect(decide([{ ...correction, provenance: 'model-output' }]).eligible).toBe(false);
    expect(decide([], { explicit: true }).eligible).toBe(false);
  });

  it('recognizes failure then native repair then actual successful verification', () => {
    const fail = activity(1, { status: 'error', toolName: 'terminal', summary: 'npm test', exitCode: 1 });
    const fix = activity(2, { toolName: 'patch' });
    const verify = activity(3, { toolName: 'terminal', summary: 'npm test', exitCode: 0 });
    expect(decide([fail, fix, verify]).eligible).toBe(true);
    expect(decide([fail, fix]).eligible).toBe(false);
    expect(decide([verify, fix, fail]).eligible).toBe(true); // occurredAt, not delivery order
    expect(decide([fail, fix, { ...verify, status: 'unknown' }]).eligible).toBe(false);
    expect(decide([fail, fix, { ...verify, provenance: 'model-output' }]).eligible).toBe(false);
  });

  it('allows explicit review of one authentic activity without bypassing gates', () => {
    expect(decide([activity(1)], { explicit: true })).toMatchObject({ eligible: true, reason: 'explicit' });
    expect(decide([activity(1, { provenance: 'fixture' })], { explicit: true }).eligible).toBe(false);
    expect(decide([activity(1)], { explicit: true, terminal: 'cancelled' }).eligible).toBe(false);
  });

  it('does not join unrelated runs or read-only test mentions into a verified repair', () => {
    const fail = activity(1, { status: 'error', summary: 'npm test' });
    const fix = activity(2, { toolName: 'patch' });
    const readOnly = activity(3, { toolName: 'read_file', summary: 'README says npm test' });
    expect(decide([fail, fix, readOnly]).eligible).toBe(false);
    const foreignRun = activity(3, { origin: { ...origin, runId: 'other' }, toolName: 'terminal', summary: 'npm test' });
    expect(decide([fail, fix, foreignRun]).eligible).toBe(false);
  });

  it('does not treat echoed or failure-masked native test mentions as successful verification', () => {
    const fail = activity(1, { status: 'error', toolName: 'terminal', summary: 'npm test', exitCode: 1 });
    const fix = activity(2, { toolName: 'patch' });
    for (const command of ['echo npm test', 'npm test || true', 'cat README.md', 'npm test; exit 0']) {
      const mention = activity(3, { toolName: 'terminal', summary: JSON.stringify({ command }), exitCode: 0, result: 'tests passed' });
      expect(decide([fail, fix, mention]).eligible, command).toBe(false);
    }
    const verify = activity(4, { toolName: 'command_execution', summary: JSON.stringify({ command: 'npm test' }), exitCode: 0 });
    expect(decide([fail, fix, verify])).toMatchObject({ eligible: true, strongSignal: true });
  });

  it('accepts only success or error as known completed evidence statuses', () => {
    const invalid = activity(1, { status: 'cancelled' as SkillEvidence['status'] });
    expect(decide([invalid], { explicit: true })).toMatchObject({ eligible: false, completedActivities: 0 });
  });

  it('requires ten completed real activities at turn end', () => {
    expect(decide(Array.from({ length: 9 }, (_, i) => activity(i))).eligible).toBe(false);
    const result = decide(Array.from({ length: 10 }, (_, i) => activity(i)));
    expect(result).toMatchObject({ eligible: true, reason: 'activity-threshold', completedActivities: 10 });
  });
});
