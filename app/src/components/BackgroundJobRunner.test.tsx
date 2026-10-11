import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import BackgroundJobRunner from './BackgroundJobRunner';
import { useStore } from '@/store/useStore';

const probe = vi.hoisted(() => ({
  fileStem: 'job', workspaceCwd: 'E:/verify', manifestJson: JSON.stringify({ schema: 1, id: 'job',
    workspaceId: 'w', sessionId: 's', label: '后台构建', startedAt: 1, done: {} }),
  artifactExists: false, doneMarkerExists: false, failMarkerExists: true, pidAlive: false,
  progressTail: '37%\n错误：链接失败', probedAtMs: 10000,
}));
vi.mock('@/lib/tauri', async (original) => ({ ...await original<typeof import('@/lib/tauri')>(),
  listBackgroundJobs: vi.fn(async () => [probe]), removeBackgroundJob: vi.fn(),
}));

it('retains terminal logs for details while clearing the running session badge', async () => {
  const { removeBackgroundJob } = await import('@/lib/tauri');
  useStore.setState({ workspaces: [], activeWorkspaceId: 'w', jobDetails: [], jobSessions: [] });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<BackgroundJobRunner />));
    expect(useStore.getState().jobSessions).toEqual([]);
    expect(useStore.getState().jobDetails).toMatchObject([{ status: 'failed', percent: 37, progressTail: '37%\n错误：链接失败' }]);
    expect(removeBackgroundJob).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
