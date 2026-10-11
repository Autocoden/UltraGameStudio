import { describe, expect, it, vi } from 'vitest';
import { executeWorkflowDag } from '../dag';
import { invokeAgent } from '../gateway';
import type { RunCallbacks, RunContext, RunGateway } from '../types';
import type { IRGraph } from '../../core/ir';
import type { SkillEntry, SkillNativeToolEvent, SkillReadResult } from './types';
const origin = { hostId: 'local', workspaceId: 'p', sessionId: 's', turnId: 't', runId: 'r' };
const event: SkillNativeToolEvent = { runId: 'r', toolCallId: 'c', toolName: 'terminal', phase: 'end',
  provenance: 'native-tool', status: 'success', exitCode: 0, result: '2 tests passed', args: { command: 'npm test' } };
const callbacks: RunCallbacks = { onNodeStart() {}, onNodeSuccess() {}, onNodeFailure() {}, onLog() {},
  beginStream: () => ({ append() {}, finalize() {}, fail() {} }), isCancelled: () => false, promptInteraction: async () => null };
const graph: IRGraph = { version: 1, meta: { name: 'evidence', adapter: 'codex' },
  nodes: [{ id: 'a', type: 'agent', params: { prompt: 'run test' } }], edges: [], layout: {} };
const gateway = (direct = false): RunGateway => ({
  resolveDirectRoute: () => direct ? { adapter: 'openai' } : null,
  resolveCliRoute: async () => ({ adapter: 'codex', cliCommand: 'codex' }),
  completeText: async (opts) => { opts.onToolEvent?.(event); return { text: 'model says done', adapter: 'openai' }; },
  spawnCliAgent: async (_prompt, _adapter, opts) => {
    opts.onToolEvent?.({ ...event, phase: 'start' });
    opts.onToolEvent?.({ ...event, provenance: 'ui-synthetic' });
    opts.onToolEvent?.(event); opts.onToolEvent?.(event);
    return 'I verified everything';
  },
  applyOverride: (s) => s, nodeGatewayOverride: () => undefined, modelClassFromModelId: () => 'fast',
  recordCall() {}, timeoutPolicy: () => ({ timeoutSeconds: 60, idleTimeoutSeconds: 0 }),
  effectiveConcurrency: (n) => n, effectiveConsensusSamples: (n) => n,
});
const context = (direct = false): RunContext => ({ selection: { adapter: 'codex', modelClass: 'fast' },
  gateway: gateway(direct), concurrency: 1, maxRetries: 0, consensusSamples: 1, skillOrigin: origin });
describe('native DAG learning evidence seam', () => {
  it('passes direct model native events to the run sink without tool-card parsing', async () => {
    const sink = vi.fn(); const ctx = context(true); ctx.onToolEvent = sink;
    await invokeAgent(ctx, 'run', ctx.selection);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it('injects fresh complete skill context into the real outgoing gateway prompt', async () => {
    const ctx = context(true);
    const entry: SkillEntry = { skillId: 'testing', rootId: 'p', name: 'testing-workflows', description: 'testing', scope: 'project',
      source: 'background', relativePath: 'testing-workflows', revision: 'r2', hash: 'h2', readOnly: false,
      autoEditable: true, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'] };
    const read: SkillReadResult = { entry, relativePath: 'SKILL.md', content: 'ACTUAL NEW RULE', revision: 'r2', hash: 'h2',
      fullRead: true, readReceiptId: 'receipt', files: ['SKILL.md'] };
    const onLoaded = vi.fn();
    ctx.skills = { origin, explicitSkillIds: ['testing'], onLoaded, host: {
      list: async () => ({ revision: 'catalog2', entries: [entry] }), view: async () => read,
      manage: async () => { throw new Error('must not write'); },
    } };
    let sent = '';
    ctx.gateway.completeText = async ({ prompt }) => { sent = prompt; return { text: 'ok', adapter: 'openai' }; };
    await invokeAgent(ctx, 'OLD PREFIX', ctx.selection);
    expect(sent.startsWith('OLD PREFIX')).toBe(true);
    expect(sent).toContain('ACTUAL NEW RULE');
    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ catalogRevision: 'catalog2', loadedSkills: [
      { skillId: 'testing', revision: 'r2', hash: 'h2', files: ['SKILL.md'] },
    ] }));
  });

  it('restores the host native sink when DAG setup fails', async () => {
    const ctx = context();
    const sink = vi.fn(); ctx.onToolEvent = sink;
    ctx.gateway.effectiveConcurrency = () => { throw new Error('host unavailable'); };
    await expect(executeWorkflowDag(graph, callbacks, ctx)).rejects.toThrow('host unavailable');
    expect(ctx.onToolEvent).toBe(sink);
  });

  it('bounds the aggregated native evidence payload of a long multi-run workflow', async () => {
    const ctx = context();
    ctx.gateway.spawnCliAgent = async (_prompt, _adapter, opts) => {
      for (let run = 0; run < 40; run++) for (let call = 0; call < 16; call++) {
        opts.onToolEvent?.({ ...event, runId: `run-${run}`, toolCallId: `call-${call}`, occurredAt: run * 16 + call });
      }
      return 'done';
    };
    const result = await executeWorkflowDag(graph, callbacks, ctx);
    expect(result.skillEvidence!.length).toBeLessThanOrEqual(256);
    expect(result.evidence!.length).toBeLessThanOrEqual(256);
    expect(result.skillEvidence!.at(-1)?.origin.runId).toBe('run-39');
  });

  it('collects real native completion evidence from a gateway into the actual DAG result', async () => {
    const onToolEvent = vi.fn();
    const ctx = context(); ctx.onToolEvent = onToolEvent;
    const result = await executeWorkflowDag(graph, callbacks, ctx);
    expect(result.success).toBe(true);
    expect(result.skillEvidence).toHaveLength(1);
    expect(result.skillEvidence?.[0]).toMatchObject({ origin, status: 'success', exitCode: 0, result: '2 tests passed' });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence?.[0]).toMatchObject({ source: 'native-tool', snippet: '2 tests passed' });
    expect(onToolEvent).toHaveBeenCalled();
  });
});
