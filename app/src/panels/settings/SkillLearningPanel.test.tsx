import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '@/store/useStore';
import { REMOTE_SKILL_HOST_ID, RunnerClient as ProtocolRunnerClient } from '@ugs/protocol';
import { RunnerClient } from '@/lib/remoteWorkspace';
import { DEFAULT_SKILL_LEARNING_CONFIG, loadSkillLearningConfig, saveSkillLearningConfig } from '@/lib/skillLearningConfig';
import type { SkillEntry, SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import { historyStore } from '@/store/history/store';
import type { GatewayRunOption } from '@/lib/modelGateway/types';
import SkillLearningPanel from './SkillLearningPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const desktop = vi.hoisted(() => ({ available: false }));
vi.mock('@/lib/tauri', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/tauri')>(), tauriAvailable: () => desktop.available }));
const host = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), history: vi.fn(), setPolicy: vi.fn(), archive: vi.fn(), restore: vi.fn() }));
vi.mock('@/lib/skills', () => ({ createSkillHost: host.create }));
const remote = vi.hoisted(() => ({ workspace: vi.fn(), client: vi.fn() }));
vi.mock('@/lib/remoteWorkspace', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/remoteWorkspace')>(), getRemoteWorkspace: remote.workspace,
  RunnerClient: class { static fromWorkspaceAsync = remote.client; },
}));
const gateway = vi.hoisted(() => ({ options: vi.fn(() => [] as GatewayRunOption[]), safeRoute: vi.fn() }));
vi.mock('@/lib/modelGateway/resolver', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/modelGateway/resolver')>(), listGatewayRunOptions: gateway.options }));
vi.mock('@/lib/modelGateway/skillReviewGateway', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/modelGateway/skillReviewGateway')>(), resolveSkillReviewGatewayRoute: gateway.safeRoute }));
let container: HTMLDivElement;
let root: Root;
const originalActions = {
  reviewSkillLearningAction: useStore.getState().reviewSkillLearningAction,
  updateSkillLearningState: useStore.getState().updateSkillLearningState,
} satisfies Partial<StoreState>;
beforeEach(() => {
  desktop.available = false;
  window.localStorage.clear();
  useStore.setState({ ...originalActions, locale: 'en-US', activeWorkspaceId: null, activeSessionId: null, workspaces: [], sessions: [], messages: [] } satisfies Partial<StoreState>);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.clearAllMocks();
  host.create.mockReturnValue({ list: host.list, history: host.history, setPolicy: host.setPolicy, archive: host.archive, restore: host.restore });
  gateway.options.mockReturnValue([]);
  gateway.safeRoute.mockReturnValue(null);
  remote.workspace.mockReturnValue(null);
  remote.client.mockResolvedValue(null);
  vi.spyOn(historyStore, 'getWorkspace').mockResolvedValue(null);
  vi.spyOn(historyStore, 'listSessions').mockResolvedValue([]);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useStore.setState(originalActions); vi.restoreAllMocks(); });

describe('SkillLearningPanel scope persistence', () => {
  it('loads and confirms remote server preferences without persisting a local or metadata override', async () => {
    const remoteConfig = { id: 'remote-config-a', label: 'Fixture remote', serverUrl: 'https://fixture.invalid', projectId: 'remote-project-a', adapter: 'codex' as const, useOwnModelKey: false, createdAt: 1, updatedAt: 1 };
    remote.workspace.mockReturnValue(remoteConfig);
    let actual = { ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'approve-all' as const };
    let finish!: (value: typeof actual) => void;
    const client = {
      getProject: vi.fn<RunnerClient['getProject']>(async () => ({ id: 'remote-project-a', label: 'Fixture remote', repoUrl: '', createdAt: 1, updatedAt: 1 })),
      getProjectSkillConfig: vi.fn<RunnerClient['getProjectSkillConfig']>(async () => actual),
      saveProjectSkillConfig: vi.fn<RunnerClient['saveProjectSkillConfig']>(() => new Promise((resolve) => { finish = resolve; })),
      skillRequest: vi.fn(async () => { throw new Error('No remote source in this fixture'); }),
    } satisfies Pick<RunnerClient, 'getProject' | 'getProjectSkillConfig' | 'saveProjectSkillConfig' | 'skillRequest'>;
    remote.client.mockResolvedValue(client);
    const onWorkspaceLearningChange = vi.fn();
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId="local-history-a" workspacePath="remote://remote-config-a" remote locale="en-US" onWorkspaceLearningChange={onWorkspaceLearningChange} />); });
    expect(remote.workspace).toHaveBeenCalledWith(remoteConfig.id);
    expect(remote.client).toHaveBeenCalledWith(remoteConfig.id);
    expect(client.getProjectSkillConfig).toHaveBeenCalledExactlyOnceWith(remoteConfig.projectId);
    const enabled = container.querySelector<HTMLInputElement>('input[aria-label="Enable automatic learning"]')!;
    expect(enabled).not.toBeNull();
    await act(async () => { enabled.click(); });
    expect(client.saveProjectSkillConfig).toHaveBeenCalledExactlyOnceWith(remoteConfig.projectId, { ...actual, enabled: false });
    expect(enabled.checked).toBe(true);
    expect(container.textContent).not.toContain('Saved');
    actual = { ...actual, enabled: false };
    await act(async () => { finish(actual); });
    expect(client.getProjectSkillConfig).toHaveBeenCalledTimes(2);
    expect(enabled.checked).toBe(false);
    expect(container.textContent).toContain('Saved on remote server');
    expect(window.localStorage.length).toBe(0);
    expect(onWorkspaceLearningChange).not.toHaveBeenCalled();
    expect(host.create).not.toHaveBeenCalled();
  });

  it('uses the canonical remote project and only persisted remote origins to load catalog and exact history', async () => {
    const project = { id: 'canonical-remote-project', label: 'Canonical', repoUrl: '', branch: 'main', createdAt: 1, updatedAt: 1 };
    remote.workspace.mockReturnValue({ id: 'remote-config-a', projectId: 'remote-project-alias' });
    const origin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: project.id, sessionId: 'remote-source-session', turnId: 'remote-source-turn', runId: 'remote-source-job' };
    const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'remote-batch', origin, lesson: 'Remote persisted review', operationsApplied: 0, changes: [], riskReasons: [] };
    const state = { status: pending.status, origin, mode: 'approve-all', result: pending, sourceSession: { workspaceId: 'local-remote-bucket', sessionId: origin.sessionId, serverUrl: 'https://fixture.invalid' } } satisfies SkillReviewState;
    const record = { id: origin.sessionId, workspaceId: 'local-remote-bucket', title: 'Remote source', isWorkflow: false, createdAt: 1, updatedAt: 1,
      messages: [{ id: 'remote-learning-message', role: 'assistant' as const, text: '', createdAt: 1, localOnly: true, skillLearning: state }] };
    useStore.setState({ activeWorkspaceId: record.workspaceId, activeSessionId: record.id } satisfies Partial<StoreState>);
    vi.spyOn(historyStore, 'listSessions').mockResolvedValue([]);
    const getSession = vi.spyOn(historyStore, 'getSession').mockResolvedValue(record);
    const requests: Array<{ projectId: string; request: unknown; options: unknown }> = [];
    const entry: SkillEntry = { skillId: 'remote-skill', rootId: 'ugs-project', name: 'remote-review', description: 'Remote skill', scope: 'project', source: 'Runner', relativePath: 'remote-review', revision: 'v1', hash: 'hash', readOnly: false, autoEditable: false, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'] };
    const client = new ProtocolRunnerClient('https://fixture.invalid', 'isolated-test-transport');
    vi.spyOn(client, 'getProject').mockResolvedValue(project);
    vi.spyOn(client, 'getProjectSkillConfig').mockResolvedValue({ ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'off' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push({ projectId: project.id, request, options: { ownerControl: new Headers(options?.headers).get('x-ugs-skill-control') === 'owner' } });
      return new Response(JSON.stringify({ ok: true, result: request.action === 'list' ? { revision: entry.revision, entries: [entry] }
        : { results: [pending, { ...pending, batchId: 'wrong-job', lesson: 'Wrong remote job must not render', origin: { ...origin, runId: 'wrong-job' } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    remote.client.mockResolvedValue(client);
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId={record.workspaceId} workspacePath="remote://remote-config-a" remote locale="en-US" />); });
    expect(client.getProject).toHaveBeenCalledExactlyOnceWith('remote-project-alias');
    expect(client.getProjectSkillConfig).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(getSession).toHaveBeenCalledWith(record.workspaceId, record.id);
    expect(requests).toEqual(['list', 'history'].map(action => ({ projectId: project.id, request: { action, origin, mode: 'approve-all' }, options: { ownerControl: true } })));
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Frozen task origin"]')?.value).toContain(origin.runId);
    expect(container.textContent).toContain(entry.name);
    expect(container.textContent).toContain(pending.lesson);
    expect(container.textContent).not.toContain('Wrong remote job must not render');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Approve changes"]')?.disabled).toBe(false);
    expect(host.create).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it('keeps a remote saved locator and frozen mode across approval, rejection and rollback after navigation', async () => {
    const projectId = 'canonical-actions';
    const origin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: projectId, sessionId: 'session-actions', turnId: 'turn-actions', runId: 'job-actions' };
    const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'batch-actions', origin, lesson: 'Saved remote action', operationsApplied: 0, changes: [], riskReasons: [] };
    const sourceSession = { workspaceId: 'local-actions-bucket', sessionId: origin.sessionId, serverUrl: 'https://fixture.invalid' };
    let state: SkillReviewState = { status: pending.status, origin, mode: 'approve-all', result: pending, sourceSession };
    const client = new ProtocolRunnerClient(sourceSession.serverUrl, 'isolated-test-transport');
    remote.workspace.mockReturnValue({ id: 'remote-actions', projectId }); remote.client.mockResolvedValue(client);
    vi.spyOn(client, 'getProject').mockResolvedValue({ id: projectId, label: 'Actions', repoUrl: '', createdAt: 1, updatedAt: 1 });
    vi.spyOn(client, 'getProjectSkillConfig').mockResolvedValue({ ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'off', enabled: false });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      expect(request).not.toHaveProperty('sourceSession');
      return new Response(JSON.stringify({ ok: true, result: request.action === 'list' ? { revision: 'empty', entries: [] } : { results: state.result ? [state.result] : [] } }), { status: 200 });
    });
    useStore.setState({ activeWorkspaceId: sourceSession.workspaceId, activeSessionId: origin.sessionId } satisfies Partial<StoreState>);
    vi.spyOn(historyStore, 'listSessions').mockResolvedValue([{ id: origin.sessionId, workspaceId: sourceSession.workspaceId, title: 'Saved actions', isWorkflow: false, createdAt: 1, updatedAt: 1, messageCount: 1 }]);
    const getSession = vi.spyOn(historyStore, 'getSession').mockImplementation(async (workspaceId, sessionId) => workspaceId === sourceSession.workspaceId && sessionId === origin.sessionId
      ? { id: sessionId, workspaceId, title: 'Saved actions', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [{ id: 'remote-exact-card', role: 'assistant', text: '', createdAt: 1, localOnly: true, skillLearning: state }] } : null);
    let complete!: (value: SkillMutationResult) => void;
    const review = vi.fn<StoreState['reviewSkillLearningAction']>(() => new Promise(resolve => { complete = resolve; }));
    const update = vi.fn<StoreState['updateSkillLearningState']>(async (messageId, next) => { expect(messageId).toBe('remote-exact-card'); state = next; });
    useStore.setState({ reviewSkillLearningAction: review, updateSkillLearningState: update } satisfies Partial<StoreState>);
    await act(async () => { root.render(<SkillLearningPanel remote scope="workspace" workspaceId={sourceSession.workspaceId} workspacePath="remote://remote-actions" locale="en-US" />); });
    for (const [action, label, id] of [['approve', 'Approve changes', pending.batchId], ['rollback', 'Roll back changes', 'undo-actions'], ['reject', 'Reject changes', pending.batchId]] as const) {
      if (action !== 'approve') {
        if (action === 'reject') state = { status: pending.status, origin, mode: 'approve-all', result: pending, sourceSession };
        await act(async () => { const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh catalog and history'); refresh!.click(); });
      }
      const frozen = structuredClone(state);
      await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); });
      expect(review).toHaveBeenLastCalledWith(frozen, action, id);
      expect(update).toHaveBeenCalledTimes(action === 'approve' ? 0 : action === 'rollback' ? 1 : 2);
      if (action === 'approve') await act(async () => { useStore.setState({ activeWorkspaceId: 'other-bucket', activeSessionId: 'other-session' }); });
      const result = { ...pending, status: action === 'reject' ? 'rejected' as const : 'applied' as const, operationsApplied: action === 'reject' ? 0 : 1, ...(action === 'rollback' ? { batchId: 'rollback-actions' } : { rollbackId: 'undo-actions' }) };
      await act(async () => { complete(result); });
      expect(update).toHaveBeenLastCalledWith('remote-exact-card', { ...frozen, status: result.status, action, result, error: undefined });
      expect(state.sourceSession).toEqual(sourceSession); expect(state.mode).toBe('approve-all');
      expect(getSession).toHaveBeenLastCalledWith(sourceSession.workspaceId, sourceSession.sessionId);
    }
    expect(review).toHaveBeenCalledTimes(3); expect(host.create).not.toHaveBeenCalled(); expect(window.localStorage.length).toBe(0);
  });

  it.each(['local-host', 'cwd', 'missing-locator', 'wrong-bucket', 'changed-server'] as const)('disables remote governance for %s without generating or rewriting a source', async (kind) => {
    const bucket = 'source-bucket'; const sessionId = 'source-session'; const projectId = 'canonical-project';
    const origin = { hostId: kind === 'local-host' ? 'local' : REMOTE_SKILL_HOST_ID, workspaceId: projectId, sessionId, turnId: 'source-turn', runId: 'source-job', ...(kind === 'cwd' ? { cwd: 'E:/Contaminated' } : {}) };
    const locator = { workspaceId: kind === 'wrong-bucket' ? 'other-bucket' : bucket, sessionId, serverUrl: kind === 'changed-server' ? 'https://original.invalid' : 'https://fixture.invalid' };
    const state: SkillReviewState = { status: 'noop', origin, mode: 'approve-all', ...(kind === 'missing-locator' ? {} : { sourceSession: locator }) };
    const client = new ProtocolRunnerClient('https://fixture.invalid', 'isolated-test-transport');
    remote.workspace.mockReturnValue({ id: 'remote-fixture', projectId }); remote.client.mockResolvedValue(client);
    vi.spyOn(client, 'getProject').mockResolvedValue({ id: projectId, label: 'Source', repoUrl: '', createdAt: 1, updatedAt: 1 });
    vi.spyOn(client, 'getProjectSkillConfig').mockResolvedValue(DEFAULT_SKILL_LEARNING_CONFIG);
    const request = vi.spyOn(globalThis, 'fetch');
    useStore.setState({ activeWorkspaceId: bucket, activeSessionId: sessionId } satisfies Partial<StoreState>);
    vi.spyOn(historyStore, 'getSession').mockResolvedValue({ id: sessionId, workspaceId: bucket, title: 'Source', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [{ id: 'source-card', role: 'assistant', text: '', createdAt: 1, localOnly: true, skillLearning: state }] });
    await act(async () => { root.render(<SkillLearningPanel remote scope="workspace" workspaceId={bucket} workspacePath="remote://remote-fixture" locale="en-US" />); });
    expect(container.textContent).toContain('Controls are disabled'); expect(container.querySelector('select[aria-label="Frozen task origin"]')).toBeNull();
    expect(request).not.toHaveBeenCalled(); expect(host.create).not.toHaveBeenCalled(); expect(window.localStorage.length).toBe(0);
  });

  it('reads remote policy and whole-package archive/restore back through the real remote control transport', async () => {
    const bucket = 'remote-govern-bucket'; const sessionId = 'remote-govern-session'; const projectId = 'remote-govern-project';
    const origin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: projectId, sessionId, turnId: 'govern-turn', runId: 'govern-job' };
    const state: SkillReviewState = { status: 'noop', origin, mode: 'approve-all', sourceSession: { workspaceId: bucket, sessionId, serverUrl: 'https://fixture.invalid' } };
    const client = new ProtocolRunnerClient('https://fixture.invalid', 'isolated-test-transport');
    remote.workspace.mockReturnValue({ id: 'remote-fixture', projectId }); remote.client.mockResolvedValue(client);
    vi.spyOn(client, 'getProject').mockResolvedValue({ id: projectId, label: 'Govern', repoUrl: '', createdAt: 1, updatedAt: 1 });
    vi.spyOn(client, 'getProjectSkillConfig').mockResolvedValue({ ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'off' });
    let actual: SkillEntry = { skillId: 'remote-govern-skill', rootId: 'ugs-project', name: 'remote-govern', description: 'Remote governance fixture', scope: 'project', source: 'Runner', relativePath: 'remote-govern', revision: 'v1', hash: 'hash', readOnly: false, autoEditable: false, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md', 'references/test.md'] };
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const request = JSON.parse(String(options?.body)); requests.push(request.action);
      expect(request.origin).toEqual(origin); expect(request.mode).toBe('approve-all'); expect(request).not.toHaveProperty('sourceSession');
      expect(new Headers(options?.headers).get('x-ugs-skill-control')).toBe('owner');
      if (request.action === 'set_policy') actual = { ...actual, ...request.policy, revision: 'v2' };
      if (request.action === 'archive') actual = { ...actual, state: 'archived', revision: 'v3' };
      if (request.action === 'restore') actual = { ...actual, state: 'active', revision: 'v4' };
      return new Response(JSON.stringify({ ok: true, result: request.action === 'list' ? { revision: actual.revision, entries: [actual] } : request.action === 'history' ? { results: [] } : actual }), { status: 200 });
    });
    useStore.setState({ activeWorkspaceId: bucket, activeSessionId: sessionId } satisfies Partial<StoreState>);
    vi.spyOn(historyStore, 'getSession').mockResolvedValue({ id: sessionId, workspaceId: bucket, title: 'Govern', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [{ id: 'govern-card', role: 'assistant', text: '', createdAt: 1, localOnly: true, skillLearning: state }] });
    await act(async () => { root.render(<SkillLearningPanel remote scope="workspace" workspaceId={bucket} workspacePath="remote://remote-fixture" locale="en-US" />); });
    for (const label of ['Allow automatic editing remote-govern', 'Archive skill remote-govern', 'Restore skill remote-govern']) {
      await act(async () => { container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click(); });
    }
    expect(requests).toEqual(['list', 'history', 'set_policy', 'list', 'archive', 'list', 'restore', 'list']);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Allow automatic editing remote-govern"]')?.checked).toBe(true);
    expect(container.querySelector('section[data-skill-id] [role="status"]')?.textContent).toBe('Active');
    expect(actual.files).toEqual(['SKILL.md', 'references/test.md']); expect(host.create).not.toHaveBeenCalled();
  });

  it('projects only model/channel identifiers, disables every CLI and permits only configured completion HTTP routes', async () => {
    const selection = { adapter: 'codex' as const, modelClass: 'default', providerId: 'review-provider', channelId: 'review-channel', modelOverride: 'review-model' };
    const options: GatewayRunOption[] = [
      { id: 'review-http', label: 'Completion HTTP', hint: 'Non-secret metadata', transport: 'openai-compatible', selection },
      { id: 'unsafe-cli', label: 'CLI unavailable', hint: 'System default', transport: 'cli', selection: { adapter: 'claude-code', modelClass: 'sonnet' } },
      { id: 'not-completion', label: 'Simulator unavailable', hint: 'Not HTTP', transport: 'simulator', selection },
    ];
    gateway.options.mockReturnValue(options);
    gateway.safeRoute.mockImplementation((candidate) => candidate === selection ? { transport: 'openai-compatible', model: 'review-model' } : null);
    await act(async () => { root.render(<SkillLearningPanel scope="global" locale="en-US" />); });
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Review model"]')!;
    expect(model.querySelector<HTMLOptionElement>('option[value="review-http"]')?.disabled).toBe(false);
    expect(model.querySelector<HTMLOptionElement>('option[value="unsafe-cli"]')?.disabled).toBe(true);
    expect(model.querySelector<HTMLOptionElement>('option[value="not-completion"]')?.disabled).toBe(true);
    await act(async () => { model.value = 'review-http'; model.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(loadSkillLearningConfig().reviewSelection).toEqual({ adapter: selection.adapter, modelClass: selection.modelClass, providerId: selection.providerId, channelId: selection.channelId, model: 'review-model' });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('Unsafe channels never fall back');
  });

  it('revalidates a configured CLI channel for explicit HTTP review without enabling system CLI or simulator choices', async () => {
    const selection = { adapter: 'codex' as const, modelClass: 'review-model', providerId: 'configured-provider', channelId: 'configured-cli' };
    const options: GatewayRunOption[] = [
      { id: 'configured-cli', label: 'Configured source CLI', hint: 'Safe metadata only', transport: 'cli', selection },
      { id: 'system-cli', label: 'System CLI', hint: 'No HTTP endpoint', transport: 'cli', selection: { adapter: 'codex', modelClass: 'default', systemDefault: true } },
      { id: 'simulator', label: 'Simulator', hint: 'Not a provider', transport: 'simulator', selection: { ...selection, channelId: 'simulator' } },
      { id: 'missing-endpoint', label: 'Unconfigured channel', hint: 'No usable HTTP route', transport: 'cli', selection: { ...selection, channelId: 'missing' } },
    ];
    const before = structuredClone(options);
    gateway.options.mockReturnValue(options);
    gateway.safeRoute.mockImplementation((candidate, protocol) => candidate.providerId === selection.providerId
      && candidate.channelId === selection.channelId && protocol === 'openai-compatible'
      ? { transport: 'openai-compatible', model: 'review-model' } : null);
    await act(async () => { root.render(<SkillLearningPanel scope="global" locale="en-US" />); });
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Review model"]')!;
    expect(model.querySelector<HTMLOptionElement>('option[value="configured-cli"]')?.disabled).toBe(true);
    const protocol = container.querySelector<HTMLSelectElement>('select[aria-label="Review HTTP protocol"]')!;
    await act(async () => { protocol.value = 'openai-compatible'; protocol.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(model.querySelector<HTMLOptionElement>('option[value="configured-cli"]')?.disabled).toBe(false);
    for (const id of ['system-cli', 'simulator', 'missing-endpoint']) {
      expect(model.querySelector<HTMLOptionElement>(`option[value="${id}"]`)?.disabled).toBe(true);
    }
    await act(async () => { model.value = 'configured-cli'; model.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(loadSkillLearningConfig()).toMatchObject({ reviewSelection: selection, reviewTransport: 'openai-compatible' });
    expect(container.textContent).not.toContain('The current channel does not support safe learning');
    expect(options).toEqual(before);
    await act(async () => { protocol.value = ''; protocol.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(model.querySelector<HTMLOptionElement>('option[value="configured-cli"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('The current channel does not support safe learning');
    expect(loadSkillLearningConfig().reviewSelection).toEqual(selection);
    expect(loadSkillLearningConfig().reviewTransport).toBeUndefined();
    expect(host.create).not.toHaveBeenCalled();
  });

  it('loads a real catalog and exact-origin history through a user-bound persisted source session', async () => {
    desktop.available = true;
    const origin = { hostId: 'local', workspaceId: 'ws-source', sessionId: 'session-source', turnId: 'turn-source', runId: 'run-source', cwd: 'E:/Source' };
    const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'batch-source', origin, lesson: 'Keep the source evidence.', operationsApplied: 0, changes: [], riskReasons: [] };
    const state: SkillReviewState = { status: pending.status, origin, result: pending };
    const message = { id: 'learning-source', role: 'assistant' as const, text: '', localOnly: true, createdAt: 1, skillLearning: state };
    const entry: SkillEntry = { skillId: 'source-skill', rootId: 'ugs-project', name: 'source-review', description: 'Source skill', scope: 'project', source: 'UGS', relativePath: 'source-review', revision: 'v1', hash: 'hash', readOnly: false, autoEditable: false, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'] };
    useStore.setState({ activeWorkspaceId: origin.workspaceId, activeSessionId: origin.sessionId, messages: [message] } satisfies Partial<StoreState>);
    vi.spyOn(historyStore, 'listSessions').mockResolvedValue([]);
    const getSession = vi.spyOn(historyStore, 'getSession').mockResolvedValue({ id: origin.sessionId, workspaceId: origin.workspaceId, title: 'Source', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [message] });
    host.list.mockResolvedValue({ revision: 'catalog-v1', entries: [entry] });
    host.history.mockResolvedValue({ results: [pending, { ...pending, batchId: 'wrong-origin', origin: { ...origin, turnId: 'another-turn' }, lesson: 'Must not render another origin.' }] });
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId={origin.workspaceId} locale="en-US" />); });
    expect(getSession).toHaveBeenCalledExactlyOnceWith(origin.workspaceId, origin.sessionId);
    expect(host.create).toHaveBeenCalledWith(expect.objectContaining({ origin, actor: 'user', evidence: [] }));
    expect(host.list).toHaveBeenCalledOnce();
    expect(host.history).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('source-review');
    expect(container.textContent).toContain('Keep the source evidence.');
    expect(container.textContent).not.toContain('Must not render another origin.');
  });

  it('applies policy and archive/restore through the bound host and reads the exact catalog back before success', async () => {
    desktop.available = true;
    const origin = { hostId: 'local', workspaceId: 'ws-govern', sessionId: 'session-govern', turnId: 'turn-govern', runId: 'run-govern' };
    const message = { id: 'learning-govern', role: 'assistant' as const, text: '', localOnly: true, createdAt: 1, skillLearning: { status: 'noop' as const, origin } };
    const entry: SkillEntry = { skillId: 'skill-govern', rootId: 'ugs-project', name: 'governed', description: 'Governed skill', scope: 'project', source: 'UGS', relativePath: 'governed', revision: 'v1', hash: 'hash', readOnly: false, autoEditable: false, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'] };
    let actual = entry;
    useStore.setState({ activeWorkspaceId: origin.workspaceId, activeSessionId: origin.sessionId });
    vi.spyOn(historyStore, 'listSessions').mockResolvedValue([]);
    vi.spyOn(historyStore, 'getSession').mockResolvedValue({ id: origin.sessionId, workspaceId: origin.workspaceId, title: 'Governed', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [message] });
    host.list.mockImplementation(async () => ({ revision: actual.revision, entries: [actual] }));
    host.history.mockResolvedValue({ results: [] });
    host.setPolicy.mockImplementation(async (_id, policy) => { actual = { ...actual, ...policy, revision: 'v2' }; return actual; });
    host.archive.mockImplementation(async () => { actual = { ...actual, state: 'archived', revision: 'v3' }; return actual; });
    host.restore.mockImplementation(async () => { actual = { ...actual, state: 'active', revision: 'v4' }; return actual; });
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId={origin.workspaceId} locale="en-US" />); });
    const editable = container.querySelector<HTMLInputElement>('input[aria-label="Allow automatic editing governed"]')!;
    expect(editable.disabled).toBe(false);
    await act(async () => { editable.click(); });
    expect(host.setPolicy).toHaveBeenCalledExactlyOnceWith(entry.skillId, { autoEditable: true });
    expect(host.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Allow automatic editing governed"]')?.checked).toBe(true);
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Archive skill governed"]')!.click(); });
    expect(host.archive).toHaveBeenCalledExactlyOnceWith(entry.skillId);
    expect(host.list).toHaveBeenCalledTimes(3);
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Restore skill governed"]')!.click(); });
    expect(host.restore).toHaveBeenCalledExactlyOnceWith(entry.skillId);
    expect(host.list).toHaveBeenCalledTimes(4);
    expect(container.querySelector('section[data-skill-id="skill-govern"]')?.textContent).toContain('Active');
  });

  it('persists approval against the source message even after the selected workspace changes', async () => {
    desktop.available = true;
    const origin = { hostId: 'local', workspaceId: 'ws-old', sessionId: 'session-old', turnId: 'turn-old', runId: 'run-old' };
    const result: SkillMutationResult = { status: 'awaiting_approval', batchId: 'batch-old', origin, lesson: 'Source approval', operationsApplied: 0, changes: [], riskReasons: [] };
    const state: SkillReviewState = { status: result.status, origin, result };
    const message = { id: 'learning-old', role: 'assistant' as const, text: '', localOnly: true, createdAt: 1, skillLearning: state };
    let savedMessage = message;
    let complete!: (value: SkillMutationResult) => void;
    const reviewSkillLearningAction = vi.fn<StoreState['reviewSkillLearningAction']>(() => new Promise<SkillMutationResult>((resolve) => { complete = resolve; }));
    const updateSkillLearningState = vi.fn<StoreState['updateSkillLearningState']>(async (_id, next) => { savedMessage = { ...message, skillLearning: next }; });
    useStore.setState({ activeWorkspaceId: origin.workspaceId, activeSessionId: origin.sessionId, reviewSkillLearningAction, updateSkillLearningState } satisfies Partial<StoreState>);
    vi.spyOn(historyStore, 'listSessions').mockResolvedValue([]);
    const getSession = vi.spyOn(historyStore, 'getSession').mockImplementation(async (workspaceId, sessionId) => workspaceId === origin.workspaceId && sessionId === origin.sessionId
      ? { id: origin.sessionId, workspaceId: origin.workspaceId, title: 'Old source', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [savedMessage] } : null);
    host.list.mockResolvedValue({ revision: 'old-catalog', entries: [] }); host.history.mockResolvedValue({ results: [result] });
    await act(async () => { root.render(<SkillLearningPanel scope="global" locale="en-US" />); });
    const approve = container.querySelector<HTMLButtonElement>('button[aria-label="Approve changes"]')!;
    expect(approve).not.toBeNull();
    await act(async () => { approve.click(); });
    expect(reviewSkillLearningAction).toHaveBeenCalledExactlyOnceWith(state, 'approve', 'batch-old');
    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-new', activeSessionId: 'session-new' }); });
    const applied = { ...result, status: 'applied' as const, operationsApplied: 1, rollbackId: 'undo-old' };
    await act(async () => { complete(applied); });
    expect(updateSkillLearningState).toHaveBeenCalledExactlyOnceWith(message.id, { ...state, status: applied.status, action: 'approve', result: applied, error: undefined });
    expect(getSession).toHaveBeenLastCalledWith(origin.workspaceId, origin.sessionId);
    expect(container.textContent).not.toContain('Learned');
  });

  it('selects the new workspace session after navigation rather than reusing a chosen session from the old workspace', async () => {
    desktop.available = true;
    const originA = { hostId: 'local', workspaceId: 'ws-pick-a', sessionId: 'session-pick-a', turnId: 'turn-pick-a', runId: 'run-pick-a' };
    const originB = { ...originA, workspaceId: 'ws-pick-b', sessionId: 'session-pick-b', turnId: 'turn-pick-b', runId: 'run-pick-b' };
    const record = (origin: typeof originA) => ({ id: origin.sessionId, workspaceId: origin.workspaceId, title: origin.workspaceId, isWorkflow: false, createdAt: 1, updatedAt: 1,
      messages: [{ id: `${origin.sessionId}-message`, role: 'assistant' as const, text: '', localOnly: true, createdAt: 1, skillLearning: { status: 'noop' as const, origin } }] });
    useStore.setState({ activeWorkspaceId: originA.workspaceId, activeSessionId: originA.sessionId });
    vi.spyOn(historyStore, 'listSessions').mockImplementation(async (workspaceId) => [{ id: workspaceId === originA.workspaceId ? originA.sessionId : originB.sessionId, workspaceId, title: workspaceId, isWorkflow: false, createdAt: 1, updatedAt: 1, messageCount: 1 }]);
    const getSession = vi.spyOn(historyStore, 'getSession').mockImplementation(async (workspaceId, sessionId) => workspaceId === originA.workspaceId && sessionId === originA.sessionId ? record(originA)
      : workspaceId === originB.workspaceId && sessionId === originB.sessionId ? record(originB) : null);
    host.list.mockResolvedValue({ revision: 'pick-catalog', entries: [] }); host.history.mockResolvedValue({ results: [] });
    await act(async () => { root.render(<SkillLearningPanel scope="global" locale="en-US" />); });
    const session = container.querySelector<HTMLSelectElement>('select[aria-label="Source session"]')!;
    await act(async () => { session.value = originA.sessionId; session.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { useStore.setState({ activeWorkspaceId: originB.workspaceId, activeSessionId: originB.sessionId }); });
    expect(getSession).toHaveBeenLastCalledWith(originB.workspaceId, originB.sessionId);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Source session"]')?.value).toBe(originB.sessionId);
    expect(host.create).toHaveBeenLastCalledWith(expect.objectContaining({ origin: originB, actor: 'user' }));
  });

  it('shows remote isolation instead of reading or writing the local learning scope', async () => {
    desktop.available = true;
    const onWorkspaceLearningChange = vi.fn();
    const getSession = vi.spyOn(historyStore, 'getSession');
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId="ws-remote" remote locale="en-US" onWorkspaceLearningChange={onWorkspaceLearningChange} />); });
    expect(container.textContent).toContain('Remote skill learning is not connected');
    expect(container.querySelector('input[aria-label="Enable automatic learning"]')).toBeNull();
    expect(host.create).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(onWorkspaceLearningChange).not.toHaveBeenCalled();
  });

  it('inherits a saved project learning preference when runtime has no override, without changing global values', async () => {
    const learning = { ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'approve-all' as const, enabled: false };
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId="ws-metadata" initialWorkspaceLearning={learning} locale="en-US" />); });
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Write mode"]')?.value).toBe('approve-all');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Enable automatic learning"]')?.checked).toBe(false);
    expect(loadSkillLearningConfig('ws-metadata')).toEqual(learning);
    expect(loadSkillLearningConfig().mode).toBe('auto-safe');
    const runtime = { ...learning, mode: 'off' as const };
    saveSkillLearningConfig(runtime, 'ws-metadata');
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId="ws-metadata" initialWorkspaceLearning={learning} locale="en-US" />); });
    expect(loadSkillLearningConfig('ws-metadata')).toEqual(runtime);
  });

  it('writes a workspace override and reports the same saved values to project metadata without changing global settings', async () => {
    const onWorkspaceLearningChange = vi.fn();
    saveSkillLearningConfig({ ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'off', activityThreshold: 22 });
    await act(async () => { root.render(<SkillLearningPanel scope="workspace" workspaceId="workspace:a/b" locale="en-US" onWorkspaceLearningChange={onWorkspaceLearningChange} />); });
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Write mode"]')!;
    await act(async () => { mode.value = 'approve-all'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(loadSkillLearningConfig().mode).toBe('off');
    expect(loadSkillLearningConfig('workspace:a/b')).toMatchObject({ mode: 'approve-all', activityThreshold: 22 });
    expect(onWorkspaceLearningChange).toHaveBeenCalledExactlyOnceWith(loadSkillLearningConfig('workspace:a/b'));
  });

  it('saves global preferences through the runtime loader without manufacturing a session', async () => {
    await act(async () => { root.render(<SkillLearningPanel scope="global" locale="en-US" />); });
    const enabled = container.querySelector<HTMLInputElement>('input[aria-label="Enable automatic learning"]');
    expect(enabled?.checked).toBe(true);
    await act(async () => { enabled!.click(); });
    expect(loadSkillLearningConfig().enabled).toBe(false);
    expect(container.textContent).toContain('Saved');
    expect(container.textContent).toContain('existing source session');
    expect(host.create).not.toHaveBeenCalled();
    expect(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))).toEqual(['ultragamestudio.skillLearningConfig.v1']);
  });
});
