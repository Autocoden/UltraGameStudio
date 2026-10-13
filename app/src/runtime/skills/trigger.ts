import { redactSkillText } from './evidence';
import { isCliVerificationEvent } from './cliHost';
import type { SkillEvidence, SkillLearningConfig, SkillLearningJob, SkillMutationStatus, SkillOrigin } from './types';

export interface SkillReviewReservation {
  id: string;
  job: SkillLearningJob;
  watermark: number;
}
interface PendingOrigin {
  job: SkillLearningJob;
  records: Array<{ sequence: number; evidence: SkillEvidence }>;
  keys: Map<string, { occurredAt: number; runId: string }>;
  discardedThrough: Map<string, number>;
  watermark: number;
  sequence: number;
  pending: boolean;
  terminal: SkillTriggerInput['terminal'];
  lastStartedAt?: number;
}

/** No timers or host calls: desktop/CLI own execution and foreground priority. */
export class SkillReviewScheduler {
  private readonly origins = new Map<string, PendingOrigin>();
  private active?: { id: string; watermark: number; state: PendingOrigin };
  private serial = 0;
  private readonly maxEvidence: number;
  private readonly maxOrigins: number;

  constructor(options: { maxEvidencePerOrigin?: number; maxOrigins?: number } = {}) {
    this.maxEvidence = Math.max(10, Math.min(1024, options.maxEvidencePerOrigin ?? 256));
    this.maxOrigins = Math.max(1, Math.min(128, options.maxOrigins ?? 32));
  }

  observe(job: SkillLearningJob, terminal: SkillTriggerInput['terminal'] = 'completed'): SkillTriggerDecision {
    const key = JSON.stringify([job.origin.hostId, job.origin.workspaceId, job.origin.sessionId]);
    let state = this.origins.get(key);
    if (!state) {
      state = { job, records: [], keys: new Map(), discardedThrough: new Map(), watermark: 0, sequence: 0, pending: false, terminal };
      if (this.origins.size >= this.maxOrigins) {
        const discard = [...this.origins].find(([, value]) => !value.pending && value !== this.active?.state);
        if (discard) this.origins.delete(discard[0]);
        else return { eligible: false, reason: 'scheduler-capacity', completedActivities: 0, strongSignal: false };
      }
      this.origins.set(key, state);
    }
    state.terminal = terminal;
    state.job = { ...job, origin: { ...job.origin }, evidence: [], config: { ...job.config,
      reviewSelection: job.config.reviewSelection ? { ...job.config.reviewSelection } : undefined },
      userText: redactSkillText(job.userText), finalAnswer: redactSkillText(job.finalAnswer),
      focus: job.focus === undefined ? undefined : redactSkillText(job.focus, 1024),
      loadedSkills: job.loadedSkills.slice(0, 32).map((s) => ({ ...s, files: s.files.slice(0, 128) })) };
    for (const item of trustedSkillEvidence(job.evidence, job.origin)) {
      const identity = item.toolCallId ? JSON.stringify([item.origin.runId, item.toolCallId]) : item.evidenceId;
      const discardedThrough = state.discardedThrough.get(item.origin.runId);
      if (state.keys.has(identity) || (discardedThrough !== undefined && item.occurredAt <= discardedThrough)) continue;
      state.keys.set(identity, { occurredAt: item.occurredAt, runId: item.origin.runId });
      state.records.push({ sequence: ++state.sequence, evidence: { ...item, origin: { ...item.origin },
        summary: redactSkillText(item.summary), result: item.result === undefined ? undefined : redactSkillText(item.result) } });
    }
    if (state.records.length > this.maxEvidence) state.records.splice(0, state.records.length - this.maxEvidence);
    while (state.keys.size > this.maxEvidence * 4) {
      const oldest = state.keys.keys().next().value!;
      const evicted = state.keys.get(oldest)!;
      state.discardedThrough.set(evicted.runId, Math.max(state.discardedThrough.get(evicted.runId) ?? -Infinity, evicted.occurredAt));
      state.keys.delete(oldest);
      while (state.discardedThrough.size > this.maxEvidence * 4) state.discardedThrough.delete(state.discardedThrough.keys().next().value!);
    }
    const evidence = state.records.filter((r) => r.sequence > state!.watermark).map((r) => r.evidence);
    const decision = shouldTriggerSkillReview({ origin: job.origin, evidence, config: job.config, terminal, explicit: job.explicit });
    state.pending = decision.eligible;
    return decision;
  }

  nextReadyAt(now = Date.now()): number | undefined {
    if (this.active) return undefined;
    const times = [...this.origins.values()].filter((state) => state.pending).map((state) =>
      state.job.explicit || state.lastStartedAt === undefined ? now : Math.max(now, state.lastStartedAt + state.job.config.cooldownMs));
    return times.length ? Math.min(...times) : undefined;
  }

  take(now = Date.now()): SkillReviewReservation | undefined {
    if (this.active) return undefined;
    for (const state of this.origins.values()) {
      if (!state.pending || (!state.job.explicit && state.lastStartedAt !== undefined &&
        now - state.lastStartedAt < state.job.config.cooldownMs)) continue;
      const reservation: SkillReviewReservation = {
        id: `skill-review-${++this.serial}`, watermark: state.sequence,
        job: { ...state.job, origin: { ...state.job.origin },
          config: { ...state.job.config, reviewSelection: state.job.config.reviewSelection ? { ...state.job.config.reviewSelection } : undefined },
          loadedSkills: state.job.loadedSkills.map((skill) => ({ ...skill, files: [...skill.files] })),
          evidence: state.records.filter((r) => r.sequence > state.watermark).map((r) => ({ ...r.evidence, origin: { ...r.evidence.origin } })) },
      };
      state.pending = false;
      state.job = { ...state.job, explicit: false };
      state.lastStartedAt = now;
      this.active = { id: reservation.id, watermark: reservation.watermark, state };
      return reservation;
    }
    return undefined;
  }

  finish(id: string, status: SkillMutationStatus, _now = Date.now()): void {
    void _now;
    if (this.active?.id !== id) return;
    if (status === 'failed' || status === 'conflicted' || status === 'needs_recovery') {
      // A failed attempt did not learn this evidence. Retain it for explicit retry,
      // without creating an automatic failure/retry loop.
      this.active.state.pending = false;
      this.active = undefined;
      return;
    }
    if (status === 'cancelled') {
      const { state, watermark } = this.active;
      // Retain cancelled coverage but avoid requeueing the same range on a timer.
      state.pending = shouldTriggerSkillReview({ origin: state.job.origin, config: state.job.config,
        evidence: state.records.filter((r) => r.sequence > watermark).map((r) => r.evidence),
        terminal: state.terminal, explicit: state.job.explicit }).eligible;
      this.active = undefined;
      return;
    }
    this.active.state.watermark = this.active.watermark;
    const state = this.active.state;
    state.pending = shouldTriggerSkillReview({
      origin: state.job.origin, evidence: state.records.filter((r) => r.sequence > state.watermark).map((r) => r.evidence),
      config: state.job.config, terminal: state.terminal, explicit: state.job.explicit,
    }).eligible;
    this.active = undefined;
  }
}

export interface SkillTriggerInput {
  origin: SkillOrigin;
  evidence: readonly SkillEvidence[];
  config: SkillLearningConfig;
  terminal: 'completed' | 'running' | 'cancelled' | 'failed';
  explicit?: boolean;
  auxiliary?: boolean;
}
export interface SkillTriggerDecision {
  eligible: boolean;
  reason: string;
  completedActivities: number;
  strongSignal: boolean;
}

export function sameSkillSession(a: SkillOrigin, b: SkillOrigin): boolean {
  return a.hostId === b.hostId && a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
}

export function trustedSkillEvidence(evidence: readonly SkillEvidence[], origin: SkillOrigin): SkillEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (!sameSkillSession(item.origin, origin) || !item.evidenceId || !Number.isFinite(item.occurredAt) ||
      !['success', 'error', 'unknown'].includes(item.status) ||
      !['native-tool', 'host-check', 'user-input'].includes(item.provenance)) return false;
    if (item.provenance === 'user-input' && item.kind !== 'correction') return false;
    const key = item.toolCallId ? JSON.stringify([item.origin.runId, item.toolCallId]) : item.evidenceId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNativeVerification(evidence: SkillEvidence): boolean {
  let args: unknown;
  try { args = JSON.parse(evidence.summary); } catch { args = { command: evidence.summary }; }
  return isCliVerificationEvent({ runId: evidence.origin.runId, toolCallId: evidence.toolCallId ?? '',
    toolName: evidence.toolName ?? '', phase: 'end', provenance: evidence.provenance,
    status: evidence.status, exitCode: evidence.exitCode, args });
}

export function shouldTriggerSkillReview(input: SkillTriggerInput): SkillTriggerDecision {
  const completedActivities = trustedSkillEvidence(input.evidence, input.origin)
    .filter((e) => (e.kind === 'tool' || e.kind === 'verification') && e.status !== 'unknown').length;
  if (!input.config.enabled || input.config.mode === 'off' || input.auxiliary || input.terminal !== 'completed') {
    return { eligible: false, reason: 'disabled-or-not-terminal', completedActivities, strongSignal: false };
  }
  const trusted = trustedSkillEvidence(input.evidence, input.origin).sort((a, b) => a.occurredAt - b.occurredAt);
  let failedRun: string | undefined;
  let repaired = false;
  let verifiedRepair = false;
  for (const item of trusted) {
    if (item.status === 'error' && (item.kind === 'tool' || item.kind === 'verification')) {
      failedRun = item.origin.runId;
      repaired = false;
    } else if (failedRun === item.origin.runId && item.status === 'success' && /(?:patch|write|edit|apply)/i.test(item.toolName ?? '')) {
      repaired = true;
    } else if (repaired && failedRun === item.origin.runId && item.status === 'success' &&
      (item.kind === 'verification' || isNativeVerification(item))) {
      verifiedRepair = true;
    }
  }
  if (input.explicit && trusted.some((item) => item.status !== 'unknown')) {
    return { eligible: true, reason: 'explicit', completedActivities, strongSignal: false };
  }
  const strongSignal = verifiedRepair || trusted
    .some((item) => item.kind === 'correction' && item.provenance === 'user-input' && item.status === 'success');
  if (strongSignal) return { eligible: true, reason: 'strong-signal', completedActivities, strongSignal };
  return {
    eligible: completedActivities >= input.config.activityThreshold,
    reason: completedActivities >= input.config.activityThreshold ? 'activity-threshold' : 'insufficient-evidence',
    completedActivities, strongSignal: false,
  };
}
