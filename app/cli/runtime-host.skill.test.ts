import { describe, expect, it, vi } from 'vitest';
import type { IRGraph } from '../src/core/ir';
import type { SkillNativeToolEvent } from '../src/runtime/skills/types';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('./io/cli-spawn', () => ({ spawnCliAgent: spawn }));
vi.mock('./config/providers', () => ({
  applyOverride: (selection: unknown) => selection,
  cliRouteEnv: () => undefined, loadFucConfig: () => ({}), modelClassFromModelId: () => 'sonnet',
  resolveSelection: () => ({ adapter: 'claude-code', modelClass: 'sonnet' }),
  resolveDirectRoute: () => null, resolveCliRoute: () => ({ adapter: 'claude-code', mode: 'cli' }),
}));
vi.mock('./io/which-cli', () => ({ whichCli: () => 'fake-cli' }));

describe('Node gateway skill seams', () => {
  it('forwards raw native callbacks with an independent host-assigned invocation run id', async () => {
    const { buildNodeGateway } = await import('./runtime-host');
    const native: SkillNativeToolEvent[] = [];
    spawn.mockImplementation(async (_prompt: string, opts: { runId?: string; onNativeToolEvent?: (e: SkillNativeToolEvent) => void }) => {
      opts.onNativeToolEvent?.({ runId: opts.runId!, toolCallId: 'native-a', toolName: 'Bash', phase: 'end', provenance: 'native-tool', exitCode: 0 });
      return 'DONE';
    });
    const gateway = buildNodeGateway({ runId: 'foreground-a', onNativeToolEvent: (event: SkillNativeToolEvent) => native.push(event) });
    expect(await gateway.spawnCliAgent('task', 'claude-code', { permission: 'full' })).toBe('DONE');
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({ toolCallId: 'native-a', phase: 'end', provenance: 'native-tool', exitCode: 0 });
    expect(native[0].runId).toMatch(/^foreground-a\/cli\//);
    await gateway.spawnCliAgent('task', 'claude-code', { permission: 'full' });
    expect(native[1].runId).not.toBe(native[0].runId);
  });

  it('delivers native events to the shared DAG sink even when the auxiliary observer throws', async () => {
    const { buildNodeGateway } = await import('./runtime-host');
    const events: SkillNativeToolEvent[] = [];
    spawn.mockImplementation(async (_prompt: string, opts: { runId: string; onNativeToolEvent?: (event: SkillNativeToolEvent) => void }) => {
      opts.onNativeToolEvent?.({ runId: opts.runId, toolCallId: 'check-a', toolName: 'Bash', phase: 'end',
        provenance: 'native-tool', status: 'success', exitCode: 0, parentId: 'parent-a' });
      return 'DONE';
    });
    const gateway = buildNodeGateway({ runId: 'dag-a', onNativeToolEvent: () => { throw new Error('observer-only'); } });
    await expect(gateway.spawnCliAgent('task', 'claude-code', { onToolEvent: (event) => events.push(event) })).resolves.toBe('DONE');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provenance: 'native-tool', exitCode: 0, parentId: 'parent-a' });
  });

  it('binds the default runBlueprint gateway to the injected frozen skill origin', async () => {
    const { runBlueprint } = await import('./runtime-host');
    const origin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'bound-blueprint' };
    const events: SkillNativeToolEvent[] = [];
    spawn.mockImplementation(async (_prompt: string, opts: { runId: string; onNativeToolEvent?: (event: SkillNativeToolEvent) => void }) => {
      opts.onNativeToolEvent?.({ runId: opts.runId, toolCallId: 'test-a', toolName: 'Bash', phase: 'end',
        provenance: 'native-tool', args: { command: 'npm test' }, result: 'PASS', status: 'success', exitCode: 0 });
      return 'DONE';
    });
    const graph: IRGraph = { version: 1 as const, meta: { name: 'bound-blueprint' }, nodes: [
      { id: 'work', type: 'agent', params: { prompt: 'verify work' } },
    ], edges: [] };
    const result = await runBlueprint(graph, { skillOrigin: origin, onToolEvent: (event) => events.push(event), nonInteractive: true });
    expect(result.success).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].runId).toMatch(/^bound-blueprint\/cli\//);
    expect(result.skillEvidence).toMatchObject([{ origin: { ...origin, runId: events[0].runId }, provenance: 'native-tool', exitCode: 0 }]);
  });

  it('forwards the trusted foreground skill tool host to the default gateway without exposing it as model authority', async () => {
    const { runBlueprint } = await import('./runtime-host');
    const origin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'tool-blueprint' };
    const request = vi.fn(async () => ({ revision: 'empty', entries: [] }));
    spawn.mockImplementation(async (_prompt: string, opts: { skillTools?: { origin: unknown; request: unknown } }) => {
      expect(opts.skillTools?.origin).toEqual(origin);
      expect(opts.skillTools?.request).toBe(request);
      return 'DONE';
    });
    const graph: IRGraph = { version: 1 as const, meta: { name: 'tool-blueprint' }, nodes: [
      { id: 'work', type: 'agent', params: { prompt: 'task' } },
    ], edges: [] };
    expect((await runBlueprint(graph, { skillOrigin: origin, skillTools: { origin, request }, nonInteractive: true } as Parameters<typeof runBlueprint>[1])).success).toBe(true);
    expect(spawn).toHaveBeenCalled();
  });

  it('uses the immutable foreground tool origin when a standalone gateway has no separate run id', async () => {
    const { buildNodeGateway } = await import('./runtime-host');
    const original = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'standalone-tools' };
    const mutable = { ...original };
    const request = vi.fn(async () => ({ entries: [] }));
    const gateway = buildNodeGateway({ skillTools: { origin: mutable, request } });
    mutable.runId = 'foreign-run'; mutable.workspaceId = 'foreign-workspace';
    spawn.mockImplementation(async (_prompt: string, options: { runId: string; skillTools?: { origin: unknown; request: unknown } }) => {
      expect(options.runId).toMatch(/^standalone-tools\/cli\//);
      expect(options.skillTools?.origin).toEqual(original);
      expect(options.skillTools?.request).toBe(request);
      return 'DONE';
    });
    await expect(gateway.spawnCliAgent('task', 'claude-code', {})).resolves.toBe('DONE');
  });

  it('does not reuse invocation identity across gateway instances of the same foreground run', async () => {
    const { buildNodeGateway } = await import('./runtime-host');
    const runIds: string[] = [];
    spawn.mockImplementation(async (_prompt: string, opts: { runId: string }) => { runIds.push(opts.runId); return 'DONE'; });
    await buildNodeGateway({ runId: 'same-foreground' }).spawnCliAgent('task', 'claude-code', {});
    await buildNodeGateway({ runId: 'same-foreground' }).spawnCliAgent('closing', 'claude-code', {});
    expect(new Set(runIds).size).toBe(2);
    expect(runIds.every((id) => id.startsWith('same-foreground/cli/'))).toBe(true);
  });
});
