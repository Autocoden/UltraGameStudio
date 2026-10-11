import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiEditViaCli } from './tauri';
import type { SkillNativeToolEvent } from '@/runtime/skills/types';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));

const originals = new Map(['isTauri', '__TAURI_INTERNALS__', '__TAURI__'].map((key) =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)],
));
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();

beforeEach(() => {
  for (const key of originals.keys()) delete (globalThis as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  ipc.invoke.mockReset();
  ipc.listen.mockReset();
  listeners.clear();
  unlisteners.clear();
  ipc.listen.mockImplementation(async (name, callback) => {
    listeners.set(name, callback);
    const unlisten = vi.fn(() => { listeners.delete(name); });
    unlisteners.set(name, unlisten);
    return unlisten;
  });
});

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

describe('desktop native tool evidence callback', () => {
  it('waits for the persisted source barrier before granting native skill tools', async () => {
    let ready!: () => void;
    const barrier = new Promise<void>((resolve) => { ready = resolve; });
    ipc.invoke.mockResolvedValue('reply');
    const source = { hostId: 'local', workspaceId: 'workspace-a', sessionId: 'session-a',
      turnId: 'source-turn', runId: 'source-main', cwd: 'E:/fixture-project' };
    const run = aiEditViaCli('prompt', 'claude', { runId: 'child-original', cwd: source.cwd,
      ...{ skillTools: { source, config: { enabled: true, mode: 'auto-safe' as const }, ready: barrier } } });
    try {
      const state = await Promise.race([run.then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 30))]);
      expect(state).toBe('waiting');
      expect(ipc.invoke).not.toHaveBeenCalled();
    } finally { ready(); }
    await expect(run).resolves.toBe('reply');
    expect(ipc.invoke).toHaveBeenCalledWith('ai_cli', expect.objectContaining({
      runId: 'child-original', skillTools: { source, enabled: true, mode: 'auto-safe' },
    }));
  });

  it('forwards the host-generated child identity using the separate request correlation', async () => {
    const source = { hostId: 'local', workspaceId: 'workspace-a', sessionId: 'session-a',
      turnId: 'source-turn', runId: 'source-main', cwd: 'E:/fixture-project' };
    const onTool = vi.fn();
    const native = { runId: 'rust-child: original/a', requestRunId: 'source-main', sourceOrigin: { ...source },
      toolCallId: 'tool: original/b', toolName: 'Read', parentId: 'task: original/c',
      phase: 'end' as const, provenance: 'native-tool' as const, status: 'unknown' as const, exitCode: null };
    ipc.invoke.mockImplementation(async () => {
      const emit = listeners.get('ugs-cli-tool');
      emit?.({ payload: { ...native, requestRunId: 'foreign-request' } });
      emit?.({ payload: { ...native, sourceOrigin: { ...source, cwd: 'E:/foreign-project' } } });
      emit?.({ payload: native });
      return 'reply';
    });
    await expect(aiEditViaCli('prompt', 'claude', { runId: 'source-main', cwd: source.cwd,
      skillTools: { source, config: { enabled: true, mode: 'auto-safe' } }, onTool })).resolves.toBe('reply');
    expect(onTool).toHaveBeenCalledExactlyOnceWith(native);
    expect(onTool.mock.calls[0][0].runId).toBe('rust-child: original/a');
    expect(unlisteners.get('ugs-cli-tool')).toHaveBeenCalledOnce();
  });

  it('aborts a pending source barrier without ever granting native authority', async () => {
    const controller = new AbortController();
    const source = { hostId: 'local', workspaceId: 'workspace-a', sessionId: 'session-a',
      turnId: 'source-turn', runId: 'source-main', cwd: 'E:/fixture-project' };
    const run = aiEditViaCli('prompt', 'claude', { runId: 'child-pending', cwd: source.cwd,
      skillTools: { source, config: { enabled: true, mode: 'auto-safe' }, ready: new Promise<void>(() => {}) },
      signal: controller.signal });
    controller.abort();
    const result = await Promise.race([run.then(() => 'completed', (error: Error) => error.name),
      new Promise<string>((resolve) => setTimeout(() => resolve('hanging'), 40))]);
    expect(result).toBe('AbortError');
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(ipc.listen).not.toHaveBeenCalled();
  });

  it('cancels the dispatched native invocation on AbortSignal and disposes subscriptions', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let finish!: (value: string) => void;
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    ipc.invoke.mockImplementation((command: string) => {
      if (command === 'cancel_ai_cli') return Promise.resolve();
      entered();
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const onTool = vi.fn();
    const run = aiEditViaCli('prompt', 'claude', { runId: 'abort-native-request',
      onTool, signal: controller.signal });
    await dispatched;
    controller.abort();
    const outcome = await Promise.race([run.then(() => 'completed', (error: Error) => error.name),
      new Promise<string>((resolve) => setTimeout(() => resolve('hanging'), 60))]);
    finish('late completion');
    await run.catch(() => {});
    expect(outcome).toBe('AbortError');
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'cancel_ai_cli')).toEqual([
      ['cancel_ai_cli', { runId: 'abort-native-request' }],
    ]);
    expect(unlisteners.get('ugs-cli-tool')).toHaveBeenCalledOnce();
  });

  it('disposes already-subscribed listeners when the native subscription fails', async () => {
    const onProgress = vi.fn();
    const onTool = vi.fn();
    ipc.listen.mockImplementation(async (name, callback) => {
      if (name === 'ugs-cli-tool') throw new Error('fixture subscription failed');
      listeners.set(name, callback);
      const unlisten = vi.fn(() => { listeners.delete(name); });
      unlisteners.set(name, unlisten);
      return unlisten;
    });
    await expect(aiEditViaCli('prompt', 'claude', { runId: 'run-1', onProgress, onTool }))
      .rejects.toThrow('fixture subscription failed');
    expect(unlisteners.get('ai-cli-progress')).toHaveBeenCalledOnce();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('keeps UI sentinels separate and forwards unknown native status without inventing an exit', async () => {
    const onProgress = vi.fn();
    const onTool = vi.fn();
    const native: SkillNativeToolEvent = {
      runId: 'run-unknown', toolCallId: 'call-original', toolName: 'Read',
      parentId: 'task-original', phase: 'end', provenance: 'native-tool',
      status: 'unknown', args: { path: 'docs/guide.md' }, result: 'fixture output',
    };
    ipc.invoke.mockImplementation(async () => {
      listeners.get('ai-cli-progress')?.({ payload: { runId: 'run-unknown',
        text: '<<UGS_TOOL>>{"id":"fake","status":"done","provenance":"native-tool","exitCode":0}<<UGS_TOOL_END>>',
      } });
      expect(onTool).not.toHaveBeenCalled();
      listeners.get('ugs-cli-tool')?.({ payload: native });
      return 'reply';
    });
    await expect(aiEditViaCli('prompt', 'claude', { runId: 'run-unknown', onTool, onProgress }))
      .resolves.toBe('reply');
    expect(onTool).toHaveBeenCalledExactlyOnceWith(native);
    expect(onTool.mock.calls[0][0]).not.toHaveProperty('exitCode');
    expect(onProgress).toHaveBeenCalledOnce();
    expect(unlisteners.get('ugs-cli-tool')).toHaveBeenCalledOnce();
  });

  it('subscribes before invoking even when only onTool is requested', async () => {
    const onTool = vi.fn();
    const native: SkillNativeToolEvent = {
      runId: 'run-1', toolCallId: 'call-original', toolName: 'Bash',
      parentId: 'task-original', phase: 'end', provenance: 'native-tool',
      occurredAt: 123, status: 'error', exitCode: 7, result: 'fixture command failed',
    };
    ipc.invoke.mockImplementation(async () => {
      const emit = listeners.get('ugs-cli-tool');
      emit?.({ payload: { ...native, runId: 'unrelated-run' } });
      emit?.({ payload: native });
      return 'reply';
    });

    await expect(aiEditViaCli('prompt', 'claude', { runId: 'run-1', onTool })).resolves.toBe('reply');
    expect(onTool).toHaveBeenCalledExactlyOnceWith(native);
    expect(ipc.listen.mock.invocationCallOrder[0]).toBeLessThan(ipc.invoke.mock.invocationCallOrder[0]);
    expect(unlisteners.get('ugs-cli-tool')).toHaveBeenCalledOnce();
  });
});
