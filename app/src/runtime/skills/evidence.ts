import type { SkillEvidence, SkillNativeToolEvent, SkillOrigin } from './types';

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|credential)/i;

/** Heuristic minimization, not a guarantee that arbitrary output is secret-free. */
export function redactSkillText(text: string, limit = 4096): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, (match) => match.split(':')[0] + ': [REDACTED]')
    .replace(/(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|credential)["']\s*:\s*)["'][^"'\r\n]*["']/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s"',;}]+/gi, (match) => match.split(/[:=]/)[0] + '=[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .slice(0, limit);
}

function summarizeArgs(args: unknown): string {
  try {
    return redactSkillText(typeof args === 'string' ? args : JSON.stringify(args ?? {},
      (key, value: unknown) => SECRET_KEY.test(key) ? '[REDACTED]' : value), 1024);
  } catch { return '[unserializable arguments]'; }
}

/** Capture native completion identity, not model narration or UI card identity. */
function normalizeEvents(
  origin: SkillOrigin,
  events: readonly SkillNativeToolEvent[],
): SkillEvidence[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.phase !== 'end' || !event.toolCallId || !event.toolName || event.runId !== origin.runId ||
      !['native-tool', 'host-check'].includes(event.provenance)) return false;
    const key = JSON.stringify([event.runId, event.toolCallId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((event) => ({
    evidenceId: JSON.stringify([event.runId, event.toolCallId]),
    origin: { ...origin }, occurredAt: event.occurredAt ?? Date.now(),
    kind: 'tool', provenance: event.provenance,
    toolCallId: event.toolCallId, toolName: event.toolName, parentId: event.parentId,
    status: typeof event.exitCode === 'number' && (!Number.isSafeInteger(event.exitCode))
      ? 'unknown' : typeof event.exitCode === 'number' && event.exitCode !== 0
        ? 'error' : event.status ?? (event.exitCode === 0 ? 'success' : 'unknown'),
    exitCode: event.exitCode,
    summary: summarizeArgs(event.args),
    result: event.result === undefined ? undefined : redactSkillText(event.result),
  }));
}

/** One collector per foreground origin. Raw args/results are never retained. */
export class SkillEvidenceCollector {
  private readonly evidence = new Map<string, SkillEvidence>();
  readonly origin: SkillOrigin;
  private completed = 0;
  private readonly maxEvidence: number;
  private readonly seen = new Map<string, number>();
  private discardedThrough?: number;

  constructor(origin: SkillOrigin, options: { maxEvidence?: number } = {}) {
    this.origin = Object.freeze({ ...origin });
    this.maxEvidence = Math.max(10, Math.min(1024, options.maxEvidence ?? 256));
  }

  collect(events: readonly SkillNativeToolEvent[], userText?: string): SkillEvidence[] {
    for (const item of normalizeEvents(this.origin, events)) {
      if (this.seen.has(item.evidenceId) || (this.discardedThrough !== undefined && item.occurredAt <= this.discardedThrough)) continue;
      this.seen.set(item.evidenceId, item.occurredAt);
      this.evidence.set(item.evidenceId, item);
      if (item.status !== 'unknown') this.completed++;
    }
    while (this.seen.size > this.maxEvidence * 4) {
      const oldest = this.seen.keys().next().value!;
      this.discardedThrough = Math.max(this.discardedThrough ?? -Infinity, this.seen.get(oldest)!);
      this.seen.delete(oldest);
    }
    if (userText && (/^\s*\/(?:learn|refine)\s+\S/i.test(userText) ||
      /(?:纠正|更正|不是[^。\n]{0,30}而是|以后.{0,30}(?:先|不要|必须)|你应该|请不要|\b(?:correction|instead of|you should|do not|don't)\b)/i.test(userText))) {
      const item: SkillEvidence = {
        evidenceId: JSON.stringify([this.origin.runId, 'user-correction', this.origin.turnId]),
        origin: { ...this.origin }, occurredAt: Date.now(), kind: 'correction',
        provenance: 'user-input', status: 'success', summary: redactSkillText(userText),
      };
      if (!this.evidence.has(item.evidenceId)) this.evidence.set(item.evidenceId, item);
    }
    while (this.evidence.size > this.maxEvidence) this.evidence.delete(this.evidence.keys().next().value!);
    return this.snapshot();
  }

  get completedActivities(): number {
    return this.completed;
  }

  snapshot(): SkillEvidence[] {
    return [...this.evidence.values()].map((item) => ({ ...item, origin: { ...item.origin } }));
  }
}

export function collectSkillEvidence(origin: SkillOrigin, events: readonly SkillNativeToolEvent[], userText?: string): SkillEvidence[] {
  return new SkillEvidenceCollector(origin).collect(events, userText);
}

