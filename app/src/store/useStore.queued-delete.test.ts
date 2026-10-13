// 运行中删除排队消息后，切换会话再切回不得复活（写盘必须发生在消息离开视图之后）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { refreshCliRuntime } from '@/lib/cliConfig';
import { defaultComposer } from './sampleSessions';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';

const gatewayMocks = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => ({
  aiEditViaCli: vi.fn(),
  aiCliSteerSupported: vi.fn(async () => true),
  cancelAiCli: vi.fn(),
  steerAiCli: vi.fn(async () => true),
  freeProxyEnsure: vi.fn(),
  isTauri: vi.fn(() => false),
  previewLocalFile: vi.fn(),
  tauriAvailable: vi.fn(() => false),
}));

vi.mock('@/lib/modelGateway/modelGateway', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/modelGateway/modelGateway')
  >('@/lib/modelGateway/modelGateway');
  return {
    ...actual,
    completeGatewayText: gatewayMocks.completeGatewayText,
    resolveDirectGatewayRoute: gatewayMocks.resolveDirectGatewayRoute,
    resolveCliGatewayRoute: gatewayMocks.resolveCliGatewayRoute,
  };
});

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>(
    '@/lib/tauri',
  );
  return {
    ...actual,
    aiEditViaCli: tauriMocks.aiEditViaCli,
    aiCliSteerSupported: tauriMocks.aiCliSteerSupported,
    cancelAiCli: tauriMocks.cancelAiCli,
    steerAiCli: tauriMocks.steerAiCli,
    freeProxyEnsure: tauriMocks.freeProxyEnsure,
    isTauri: tauriMocks.isTauri,
    previewLocalFile: tauriMocks.previewLocalFile,
    tauriAvailable: tauriMocks.tauriAvailable,
  };
});

import { useStore } from './useStore';
import { historyStore } from './history/store';

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function resetStore(workflow: IRGraph): void {
  window.localStorage.setItem('ugs_research_angles_max', '1');
  window.localStorage.setItem('ugs_nodegen_candidates_max', '1');
  useStore.setState({
    workflow: cloneGraph(workflow),
    selectedNodeId: null,
    mode: 'design',
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    queuedChatMessageIds: [],
    steerableQueuedChatMessageIds: [],
    editingQueuedChatMessageId: null,
    blockedSendTip: null,
    dirty: false,
    currentFilePath: null,
    messages: [],
    composer: defaultComposer,
    composerDraft: '',
    composerDrafts: {},
    activeSessionId: null,
    activeWorkspaceId: null,
    historyReady: false,
    sessions: [],
    sessionTree: {},
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
    personalInstructions: '',
    personalInstructionsByModel: {},
    gameExpertSettings: {
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabledExpertIds: [...DEFAULT_GAME_EXPERT_SETTINGS.enabledExpertIds],
      customExperts: [...DEFAULT_GAME_EXPERT_SETTINGS.customExperts],
      deletedExpertIds: [...DEFAULT_GAME_EXPERT_SETTINGS.deletedExpertIds],
    },
  });
}

function mockDirectRoute(): void {
  gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
    selection: { adapter: 'claude-code', modelClass: 'sonnet' },
    adapter: 'claude-code',
    modelClass: 'sonnet',
    apiKey: 'test-key',
    model: 'sonnet',
    transport: 'anthropic',
    mode: 'direct',
    label: 'sonnet',
    source: 'global',
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${description}\n` +
          `gatewayCalls=${gatewayMocks.completeGatewayText.mock.calls.length}\n` +
          `cliCalls=${tauriMocks.aiEditViaCli.mock.calls.length}\n` +
          `aiStreaming=${String(useStore.getState().aiStreaming)}\n` +
          `messages=${JSON.stringify(
            useStore.getState().messages.map((m) => [m.role, m.id, m.text.slice(0, 20)]),
          )}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(async () => {
  gatewayMocks.completeGatewayText.mockReset();
  gatewayMocks.resolveDirectGatewayRoute.mockReset();
  gatewayMocks.resolveCliGatewayRoute.mockReset();
  tauriMocks.aiEditViaCli.mockReset();
  tauriMocks.steerAiCli.mockReset();
  resetStore(simpleBlueprint('Current workflow'));
  window.localStorage.clear();
  resetSecureStorageForTests();
  await refreshCliRuntime();
});

describe('queued chat message deletion', () => {
  it('stays deleted after switching away and back while the turn is still running', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const recordA = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      workflow: simpleBlueprint('Chat A'),
      title: 'Chat A',
    });
    const recordB = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      workflow: simpleBlueprint('Chat B'),
      title: 'Chat B',
    });

    resetStore(simpleBlueprint('Chat A'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      activeSessionId: recordA.id,
      workspaces: [workspace],
      sessionTree: { [workspace.id]: [] },
      workflow: simpleBlueprint('Chat A'),
      locale: 'zh-CN',
    });
    mockDirectRoute();

    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some((m) => m.role === 'user' && m.text === '问题一'),
      'first user message',
    );

    useStore.getState().sendPrompt('要删掉的问题二');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'queued message id',
    );
    const queuedId = useStore.getState().queuedChatMessageIds[0];

    expect(useStore.getState().deleteQueuedChatMessage(queuedId)).toBe(true);
    expect(useStore.getState().queuedChatMessageIds).toEqual([]);

    // 会话 A 的磁盘记录
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterDelete = await historyStore.getSession(workspace.id, recordA.id);
    expect(
      (afterDelete?.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.text),
    ).toEqual(['问题一']);

    // 切到 B 再切回 A
    useStore.getState().selectSession(recordB.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === recordB.id,
      'session B activation',
    );
    useStore.getState().selectSession(recordA.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === recordA.id,
      'session A reactivation',
    );

    const users = useStore
      .getState()
      .messages.filter((m) => m.role === 'user')
      .map((m) => m.text);
    expect(users).toEqual(['问题一']);

    const disk = await historyStore.getSession(workspace.id, recordA.id);
    expect(
      (disk?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text),
    ).toEqual(['问题一']);

    resolvers.splice(0).forEach((resolve) => resolve('答一'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
