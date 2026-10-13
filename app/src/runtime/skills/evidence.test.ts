import { describe, expect, it } from 'vitest';
import { collectSkillEvidence, SkillEvidenceCollector } from './evidence';
import type { SkillNativeToolEvent, SkillOrigin } from './types';

const origin: SkillOrigin = {
  hostId: 'local', workspaceId: 'project-a', sessionId: 'session-a',
  turnId: 'turn-a', runId: 'run-a',
};
const end = (overrides: Partial<SkillNativeToolEvent> = {}): SkillNativeToolEvent => ({
  runId: origin.runId, toolCallId: 'call-a', toolName: 'terminal', phase: 'end',
  provenance: 'native-tool', occurredAt: 10, status: 'success', exitCode: 0,
  args: { command: 'npm test' }, result: '12 tests passed', ...overrides,
});

describe('learning evidence', () => {
  it('does not accept starts, simulated completions, or foreign runs as evidence', () => {
    const events = [
      end({ phase: 'start' }),
      end({ provenance: 'ui-synthetic' }),
      end({ provenance: 'fixture' }),
      end({ provenance: 'model-output' }),
      end({ runId: 'foreign-run' }),
      end(),
    ];
    expect(collectSkillEvidence(origin, events)).toHaveLength(1);
  });

  it('uses process failures over contradictory success labels', () => {
    const evidence = collectSkillEvidence(origin, [end({ exitCode: 1 })]);
    expect(evidence[0].status).toBe('error');
  });

  it('redacts before snapshotting and bounds native output', () => {
    const evidence = collectSkillEvidence(origin, [end({
      args: { command: 'curl', apiKey: 'never-retain-this', password: 'private-value' },
      result: 'Authorization: Bearer token-value\npassword=private-value\n' + 'x'.repeat(9000),
    })]);
    expect(JSON.stringify(evidence)).not.toContain('never-retain-this');
    expect(JSON.stringify(evidence)).not.toContain('private-value');
    expect(JSON.stringify(evidence)).not.toContain('token-value');
    expect(evidence[0].result!.length).toBeLessThanOrEqual(4096);
  });

  it('retains incremental evidence without counting unknown or duplicate ends', () => {
    const collector = new SkillEvidenceCollector(origin);
    collector.collect([end({ status: 'unknown', exitCode: null })]);
    expect(collector.completedActivities).toBe(0);
    collector.collect([end({ toolCallId: 'known' }), end({ toolCallId: 'known' })]);
    expect(collector.completedActivities).toBe(1);
    const snapshot = collector.snapshot();
    snapshot[0].summary = 'mutated';
    expect(collector.snapshot()[0].summary).not.toBe('mutated');
    expect(collector.snapshot()).toHaveLength(2);
  });

  it('captures correction only from an explicit real-user input argument', () => {
    const evidence = collectSkillEvidence(origin, [end({ result: '用户纠正：不要删文件' })], '纠正：以后先运行测试再修改');
    const correction = evidence.find((item) => item.kind === 'correction');
    expect(correction).toMatchObject({ provenance: 'user-input', origin, status: 'success' });
    expect(collectSkillEvidence(origin, [], '你好')).toEqual([]);
    expect(collectSkillEvidence(origin, [end({ result: '纠正：以后先运行测试' })])
      .filter((item) => item.kind === 'correction')).toEqual([]);
  });

  it('rejects missing native identity and bounds the collector without retaining raw arguments', () => {
    expect(collectSkillEvidence(origin, [end({ toolCallId: '' }), end({ toolName: '' })])).toEqual([]);
    const collector = new SkillEvidenceCollector(origin, { maxEvidence: 16 });
    collector.collect(Array.from({ length: 100 }, (_, i) => end({ toolCallId: `c${i}` })));
    expect(collector.snapshot()).toHaveLength(16);
    expect(collector.completedActivities).toBe(100);
  });

  it('captures explicit user-authored learning text while keeping repeat evidence immutable', () => {
    const collector = new SkillEvidenceCollector(origin);
    const first = collector.collect([], '/learn Run the actual regression suite before editing.');
    expect(first[0]).toMatchObject({ kind: 'correction', provenance: 'user-input' });
    expect(collector.collect([], '/learn changed text')[0]).toEqual(first[0]);
    expect(collectSkillEvidence(origin, [], '/learn')).toEqual([]);
  });

  it('redacts quoted JSON credentials and HTTP cookie/basic authentication values', () => {
    const evidence = collectSkillEvidence(origin, [end({ result: '{"apiKey":"quoted-example","password":"quoted-private"}\nCookie: session=example-cookie\nAuthorization: Basic example-auth' })]);
    const serialized = JSON.stringify(evidence);
    for (const secret of ['quoted-example', 'quoted-private', 'example-cookie', 'example-auth']) expect(serialized).not.toContain(secret);
  });

  it('does not recount replayed completions after the retained native identity window rolls over', () => {
    const collector = new SkillEvidenceCollector(origin, { maxEvidence: 16 });
    const events = Array.from({ length: 100 }, (_, i) => end({ toolCallId: `call-${i}`, occurredAt: i }));
    collector.collect(events);
    expect(collector.completedActivities).toBe(100);
    collector.collect(events);
    expect(collector.completedActivities).toBe(100);
    collector.collect([end({ toolCallId: 'fresh', occurredAt: 101 })]);
    expect(collector.completedActivities).toBe(101);
  });

  it('freezes the publicly exposed origin so consumers cannot rebind later native evidence', () => {
    const collector = new SkillEvidenceCollector(origin);
    expect(() => Object.assign(collector.origin, { workspaceId: 'foreign' })).toThrow();
    expect(collector.collect([end()])[0].origin).toEqual(origin);
  });

  it('keeps malformed native exit codes unknown rather than treating them as completed failures', () => {
    for (const exitCode of [Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const collector = new SkillEvidenceCollector(origin);
      const evidence = collector.collect([end({ exitCode })]);
      expect(evidence[0].status).toBe('unknown');
      expect(collector.completedActivities).toBe(0);
    }
  });

  it('deduplicates native completions by run and call identity', () => {
    const evidence = collectSkillEvidence(origin, [end(), end()]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      origin, toolCallId: 'call-a', toolName: 'terminal', status: 'success',
      exitCode: 0, provenance: 'native-tool', result: '12 tests passed',
    });
  });
});
