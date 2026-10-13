import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  state: {
    locale: 'en-US',
    assetCenterEnabled: true,
    workspaces: [],
    activeWorkspaceId: null,
    composer: { workspace: '' },
    initHistory: vi.fn(),
  },
  assets: [],
  tasks: [],
  cliUpdate: { hasUnseenUpdate: false },
  listCachedAssets: vi.fn(async () => []),
}));

vi.mock('@/store/useStore', () => ({
  useStore: <T,>(selector: (state: typeof fixtures.state) => T): T => selector(fixtures.state),
}));
vi.mock('@/lib/tauri', () => ({
  migrateLegacyBrandStorage: vi.fn(async () => ({ phase: 'skipped' })),
  onSingleInstanceWarning: vi.fn(async () => () => {}),
  tauriAvailable: () => true,
  listCachedAssets: fixtures.listCachedAssets,
}));
vi.mock('@/lib/cliConfig', () => ({ primeCliRuntime: vi.fn() }));
vi.mock('@/lib/cliUpdateStatus', () => ({
  primeCliUpdateStatus: vi.fn(),
  getCliUpdateSnapshot: () => fixtures.cliUpdate,
  subscribeCliUpdateStatus: () => () => {},
}));
vi.mock('@/lib/settingsProfile', () => ({
  setActiveSettingsProfile: vi.fn(),
  profileIdForWorkspacePath: () => 'local',
}));
vi.mock('@/lib/downloadRegistry', () => ({
  getAssets: () => fixtures.assets,
  subscribeAssets: () => () => {},
  mergeCachedAssetsFromDisk: vi.fn(),
  assetMatchesWorkspace: () => true,
}));
vi.mock('@/lib/taskBoard', () => ({
  boardKeyFor: () => 'local',
  getBoardTasks: () => fixtures.tasks,
  subscribeTasks: () => () => {},
}));
vi.mock('@/panels/DownloadsModal', () => ({ ASSET_SESSION_JUMP_EVENT: 'ugs:asset-session-jump' }));
vi.mock('@/panels/Sidebar', () => ({ default: () => null }));
vi.mock('@/panels/AIDock', () => ({ default: () => <div data-view="terminal" /> }));
vi.mock('@/panels/ProjectFileTree', () => ({ default: () => null }));
vi.mock('@/panels/AssetsView', () => ({ default: () => <div data-view="assets" /> }));
vi.mock('@/panels/TaskBoardView', () => ({ default: () => <div data-view="board" /> }));
vi.mock('@/panels/SettingsModal', () => ({ default: () => null }));
vi.mock('@/components/ProjectTopBar', () => ({ default: () => null }));
vi.mock('@/components/ScheduledTaskRunner', () => ({ default: () => null }));
vi.mock('@/components/BackgroundJobRunner', () => ({ default: () => null }));
vi.mock('@/components/SkillLearningRecovery', () => ({ default: () => null }));
vi.mock('@/components/StatusBar', () => ({ default: () => null }));

import App from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  fixtures.state.assetCenterEnabled = true;
  fixtures.listCachedAssets.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function renderApp() {
  await act(async () => root.render(<App />));
}

describe('asset center in the app rail', () => {
  it('keeps disabled assets unmounted and skips badge polling', async () => {
    fixtures.state.assetCenterEnabled = false;
    await renderApp();
    expect(container.querySelector('button[title="Assets"]')).toBeNull();
    expect(container.querySelector('[data-view="assets"]')).toBeNull();
    expect(container.querySelector('button[title="Task Board"]')).not.toBeNull();
    expect(container.querySelector('button[title="Smart Terminal"]')?.getAttribute('aria-current')).toBe('page');
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fixtures.listCachedAssets).not.toHaveBeenCalled();
  });

  it('returns an open asset view to the terminal and stops polling when disabled', async () => {
    await renderApp();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Assets"]')!.click());
    expect(container.querySelector('[data-view="assets"]')?.closest('section')?.classList.contains('hidden')).toBe(false);
    expect(fixtures.listCachedAssets).toHaveBeenCalledOnce();

    fixtures.state.assetCenterEnabled = false;
    await renderApp();
    expect(container.querySelector('[data-view="assets"]')).toBeNull();
    expect(container.querySelector('button[title="Assets"]')).toBeNull();
    expect(container.querySelector('button[title="Smart Terminal"]')?.getAttribute('aria-current')).toBe('page');
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fixtures.listCachedAssets).toHaveBeenCalledOnce();

    fixtures.state.assetCenterEnabled = true;
    await renderApp();
    expect(container.querySelector('button[title="Assets"]')).not.toBeNull();
    expect(container.querySelector('[data-view="assets"]')).not.toBeNull();
    expect(fixtures.listCachedAssets).toHaveBeenCalledTimes(2);
  });
});
