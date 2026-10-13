import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushGatewayConfigDiskWrites,
  getActiveGatewaySelection,
  initializeGatewayConfigStore,
  resetGatewayConfigStoreForTests,
  setActiveGatewaySelection,
} from './gatewayConfig';

const { disk, invoke } = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  invoke: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const selectionPath = 'settings/activeGatewaySelection.v1.json';
const initialSelection = {
  adapter: 'codex' as const,
  modelClass: 'gpt-6',
  providerId: 'provider-cli',
  channelId: 'default',
};

beforeEach(async () => {
  window.localStorage.clear();
  disk.clear();
  disk.set('settings/modelGateway.v1.json', JSON.stringify({
    version: 1,
    providers: [{
      id: initialSelection.providerId, kind: 'cli', name: 'CLI', adapter: initialSelection.adapter,
      channels: [{ id: initialSelection.channelId, name: 'Default', route: { transport: 'cli' } }],
    }],
  }));
  resetGatewayConfigStoreForTests();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'history_read_json') return disk.get(args.relPath) ?? null;
    if (command === 'history_write_json') disk.set(args.relPath, args.json);
    return null;
  });
  await initializeGatewayConfigStore();
});

afterEach(async () => {
  await flushGatewayConfigDiskWrites();
  resetGatewayConfigStoreForTests();
  window.localStorage.clear();
});

describe('gateway thinking level autosave on desktop', () => {
  it('keeps the latest thinking level on disk when an earlier write is slow', async () => {
    let releaseEarlierWrite!: () => void;
    const earlierWrite = new Promise<void>((resolve) => {
      releaseEarlierWrite = resolve;
    });
    let firstWrite = true;
    invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'history_read_json') return disk.get(args.relPath) ?? null;
      if (command === 'history_write_json') {
        if (args.relPath === selectionPath && firstWrite) {
          firstWrite = false;
          await earlierWrite;
        }
        disk.set(args.relPath, args.json);
      }
      return null;
    });

    // Provider synchronization writes a selection without thinkingLevel before
    // the settings action writes the user's full selection to the same file.
    setActiveGatewaySelection(initialSelection);
    await vi.waitFor(() => expect(firstWrite).toBe(false));
    setActiveGatewaySelection({ ...initialSelection, thinkingLevel: 'xhigh' });
    expect(getActiveGatewaySelection().thinkingLevel).toBe('xhigh');

    // Let any concurrent write finish before releasing the older write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseEarlierWrite();
    await flushGatewayConfigDiskWrites();

    expect(JSON.parse(disk.get(selectionPath)!)).toEqual({
      ...initialSelection,
      thinkingLevel: 'xhigh',
    });

    // A fresh boot must read the same value from disk, without localStorage.
    window.localStorage.clear();
    resetGatewayConfigStoreForTests();
    await initializeGatewayConfigStore();
    expect(getActiveGatewaySelection().thinkingLevel).toBe('xhigh');
  });

  it('autosaves thinking changes and reset even when localStorage is full', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    try {
      setActiveGatewaySelection({ ...initialSelection, thinkingLevel: 'high' });
      setActiveGatewaySelection({ ...initialSelection, thinkingLevel: 'xhigh' });
      await flushGatewayConfigDiskWrites();
      expect(JSON.parse(disk.get(selectionPath)!).thinkingLevel).toBe('xhigh');

      setActiveGatewaySelection(initialSelection);
      await flushGatewayConfigDiskWrites();
      window.localStorage.clear();
      resetGatewayConfigStoreForTests();
      await initializeGatewayConfigStore();
      expect(getActiveGatewaySelection().thinkingLevel).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
