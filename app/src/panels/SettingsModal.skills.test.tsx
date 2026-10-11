import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import { loadSkillLearningConfig } from '@/lib/skillLearningConfig';
import { historyStore } from '@/store/history/store';
import { projectSettingsFromMetadata, projectSettingsPatch } from '@/lib/projectSettings';
import type { WorkspaceRecord, WorkspaceSummary } from '@/store/history/types';
import SettingsModal from './SettingsModal';
import ProjectSettingsModal from './ProjectSettingsModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(), tauriAvailable: () => false, isTauri: () => false,
  scanProjectEnvironment: async (rootPath: string) => ({ rootPath, scannedAtMs: 1, engine: { engine: 'unknown', label: 'Unknown', confidence: 0, markers: [] }, skillRoots: [], suggestedMcpServers: [] }),
}));
vi.mock('@/lib/skills', () => ({ createSkillHost: vi.fn() }));
const workspace: WorkspaceSummary = { id: 'ws-ui-entry', path: 'E:/Source', name: 'Source', sessionCount: 0, updatedAt: 1 };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ locale: 'en-US', activeWorkspaceId: null, activeSessionId: null, messages: [], sessions: [], workspaces: [], workflow: defaultBlueprint('UI entry'), composer: defaultComposer });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

async function clickTab(text: string) {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent?.trim() === text)!;
  expect(tab).not.toBeUndefined();
  await act(async () => { tab.click(); });
}

describe('Skill learning product entries', () => {
  it('opens global learning preferences from Settings Skills even with no project selected', async () => {
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />); });
    await clickTab('Skills');
    expect(container.querySelector('[data-skill-learning-scope="global"]')).not.toBeNull();
    expect(container.textContent).toContain('Automatic skill learning');
    await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Enable automatic learning"]')!.click(); });
    expect(loadSkillLearningConfig().enabled).toBe(false);
  });

  it('bounds the long global navigation on narrow Skills views so the learning controls have a scrollable viewport', async () => {
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />); });
    const navigation = container.querySelector<HTMLElement>('nav[aria-label="Settings"]')!;
    expect(navigation.className).not.toContain('max-h-48');
    await clickTab('Skills');
    expect(navigation.className).toContain('max-h-48');
    expect(navigation.className).toContain('sm:max-h-none');
    expect(navigation.className).toContain('overflow-y-auto');
    expect(container.querySelector('select[aria-label="Write mode"]')).not.toBeNull();
  });

  it('provides a dedicated project learning entry and saves its effective preferences into runtime and project metadata', async () => {
    let persisted: WorkspaceRecord = { ...workspace, createdAt: 1, metadata: projectSettingsPatch(projectSettingsFromMetadata(undefined)) };
    vi.spyOn(historyStore, 'getWorkspace').mockImplementation(async () => persisted);
    const patchMetadata = vi.spyOn(historyStore, 'patchWorkspaceMetadata').mockImplementation(async (_id, patch) => { persisted = { ...persisted, metadata: { ...persisted.metadata, ...patch } }; return persisted; });
    useStore.setState({ activeWorkspaceId: workspace.id, workspaces: [workspace] });
    await act(async () => { root.render(<ProjectSettingsModal workspace={workspace} onClose={vi.fn()} />); });
    await clickTab('Skill learning');
    expect(container.querySelector('[data-skill-learning-scope="workspace"]')).not.toBeNull();
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Write mode"]')!;
    await act(async () => { mode.value = 'approve-all'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(loadSkillLearningConfig(workspace.id).mode).toBe('approve-all');
    expect(loadSkillLearningConfig().mode).toBe('auto-safe');
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Save')!;
    await act(async () => { save.click(); });
    expect(patchMetadata).toHaveBeenCalledWith(workspace.id, expect.any(Object));
    expect(projectSettingsFromMetadata(persisted.metadata).skills.learning).toEqual(loadSkillLearningConfig(workspace.id));
  });

  it('renders isolated unavailable remote preferences in the global entry without exposing local controls', async () => {
    useStore.setState({ activeWorkspaceId: 'ws-remote-entry', workspaces: [{ ...workspace, id: 'ws-remote-entry', path: 'remote://remote-entry' }] });
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />); });
    await clickTab('Skills');
    expect(container.textContent).toContain('Remote skill learning is not connected');
    expect(container.querySelector('input[aria-label="Enable automatic learning"]')).toBeNull();
    expect(window.localStorage.getItem('ultragamestudio.skillLearningConfig.v1')).toBeNull();
  });
});
