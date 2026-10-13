import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SkillReviewState } from '@/runtime/skills/types';
const seams = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; messages: unknown[] }>, live: new Set<string>(),
  history: vi.fn(), persist: vi.fn(), retry: vi.fn(), revoke: vi.fn(),
}));
vi.mock('@/store/useStore', () => ({
  useStore: (select: (state: { historyReady: boolean }) => unknown) => select({ historyReady: true }),
  persistSkillLearningStateForSource: seams.persist, retryPersistedSkillLearning: seams.retry,
}));
vi.mock('@/store/history/store', () => ({ historyStore: {
  listWorkspaces: async () => [{ id: 'workspace' }],
  listSessions: async () => seams.sessions,
  getSession: async (_: string, id: string) => seams.sessions.find((session) => session.id === id),
} }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@/lib/skills', () => ({ createSkillControlHost: () => ({ history: seams.history, revoke: seams.revoke }) }));
vi.mock('@/lib/skillLearningDesktop', () => ({ isSkillReviewLive: (id: string) => seams.live.has(id) }));
vi.mock('@/lib/skillLearningConfig', () => ({ loadSkillLearningConfig: () => ({ enabled: true, mode: 'auto-safe' }) }));
afterEach(() => { seams.live.clear(); vi.resetAllMocks(); });

it('reconciles orphan history, preserves live work and resumes only saved input', async () => {
  vi.resetModules();
  const origin = { hostId: 'local', workspaceId: 'workspace', sessionId: 'source', turnId: 'turn', runId: 'orphan' };
  const make = (runId: string, resume = false) => ({ id: runId, role: 'assistant', text: '', createdAt: 1,
    skillLearning: { origin: { ...origin, runId }, status: 'queued', mode: 'auto-safe',
      ...(resume ? { resume: { job: {}, selection: {} } } : {}) } });
  seams.sessions = [{ id: 'source', messages: [make('legacy'), make('resume', true), make('live', true), make('committed', true)] }];
  seams.live.add('live');
  seams.history.mockResolvedValue({ results: [{ origin: { ...origin, runId: 'committed' }, status: 'applied',
    batchId: 'saved', lesson: 'Existing committed result', operationsApplied: 1, changes: [], riskReasons: [] }] });
  seams.revoke.mockResolvedValue(undefined);
  seams.persist.mockResolvedValue(undefined);
  seams.retry.mockResolvedValue(undefined);
  const { default: Recovery } = await import('./SkillLearningRecovery');
  const container = document.createElement('div'); const root = createRoot(container);
  await act(async () => { root.render(<Recovery />); });
  await vi.waitFor(() => expect(seams.persist).toHaveBeenCalledTimes(3));
  expect(seams.persist.mock.calls.map((call) => { const state = call[1] as SkillReviewState; return [state.origin.runId, state.status]; }))
    .toEqual([['legacy', 'failed'], ['resume', 'failed'], ['committed', 'applied']]);
  expect(seams.retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origin: { ...origin, runId: 'resume' } }));
  expect(seams.persist.mock.calls.every(([source]) => source.workspaceId === 'workspace' && source.sessionId === 'source')).toBe(true);
  await act(async () => root.unmount());
});
