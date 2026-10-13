import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import {
  aiEditViaCli,
  archiveOpenSpecChange,
  detectTaskDeveloperTools,
  executableExtensionOf,
  listOpenSpecChanges,
  openWorkspaceInIde,
  openWorkspaceInTerminal,
  saveTaskAttachment,
  tauriAvailable,
} from './tauri';

const tauriGlobalKeys = ['isTauri', '__TAURI_INTERNALS__', '__TAURI__'] as const;
const originalTauriGlobals = new Map(
  tauriGlobalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

function setTauriGlobal(key: (typeof tauriGlobalKeys)[number], value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  for (const key of tauriGlobalKeys) {
    const descriptor = originalTauriGlobals.get(key);
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

describe('tauriAvailable', () => {
  it('detects the Tauri v2 isTauri global', () => {
    setTauriGlobal('isTauri', true);

    expect(tauriAvailable()).toBe(true);
  });

  it('detects injected Tauri IPC globals', () => {
    setTauriGlobal('__TAURI_INTERNALS__', {});
    expect(tauriAvailable()).toBe(true);

    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    setTauriGlobal('__TAURI__', {});
    expect(tauriAvailable()).toBe(true);
  });
});

describe('executableExtensionOf', () => {
  it('detects Windows drive-letter executable paths', () => {
    expect(executableExtensionOf('C:\\Temp\\evil.exe')).toBe('exe');
    expect(executableExtensionOf('D:\\Tools\\shortcut.lnk')).toBe('lnk');
  });

  it('strips query/hash and editor line hints without cutting the drive prefix', () => {
    expect(executableExtensionOf('C:\\Temp\\evil.exe?download=1')).toBe('exe');
    expect(executableExtensionOf('C:\\Temp\\shortcut.lnk#L12')).toBe('lnk');
    expect(executableExtensionOf('C:\\Temp\\script.ps1:12:3')).toBe('ps1');
  });

  it('ignores non-executable paths', () => {
    expect(executableExtensionOf('C:\\Temp\\notes.txt')).toBeNull();
  });
});

describe('task workspace desktop actions', () => {
  it('routes editor and terminal requests through Tauri', async () => {
    setTauriGlobal('isTauri', true);
    invokeMock.mockResolvedValue(undefined);

    await openWorkspaceInIde('D:\\project-worktrees\\task-1', 'cursor');
    await openWorkspaceInTerminal('D:\\project-worktrees\\task-1');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'open_workspace_in_ide', {
      path: 'D:\\project-worktrees\\task-1',
      editor: 'cursor',
      customPath: null,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'open_workspace_in_terminal', {
      path: 'D:\\project-worktrees\\task-1',
      terminal: 'system',
      customPath: null,
    });
  });

  it('detects installed tools and forwards custom executable paths', async () => {
    setTauriGlobal('isTauri', true);
    const detected = {
      ides: [{ id: 'cursor', name: 'Cursor', path: 'C:\\Cursor.exe', installed: true }],
      terminals: [
        { id: 'system', name: 'System Terminal', path: 'cmd.exe', installed: true },
      ],
    };
    invokeMock.mockResolvedValueOnce(detected).mockResolvedValue(undefined);

    await expect(detectTaskDeveloperTools()).resolves.toEqual(detected);
    await openWorkspaceInIde(
      'D:\\project-worktrees\\task-1',
      'custom',
      'C:\\Tools\\editor.exe',
    );
    await openWorkspaceInTerminal(
      'D:\\project-worktrees\\task-1',
      'custom',
      'C:\\Tools\\terminal.exe',
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'task_detect_developer_tools');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'open_workspace_in_ide', {
      path: 'D:\\project-worktrees\\task-1',
      editor: 'custom',
      customPath: 'C:\\Tools\\editor.exe',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'open_workspace_in_terminal', {
      path: 'D:\\project-worktrees\\task-1',
      terminal: 'custom',
      customPath: 'C:\\Tools\\terminal.exe',
    });
  });
});

describe('OpenSpec archive desktop actions', () => {
  it('passes force options and lists active changes through Tauri', async () => {
    setTauriGlobal('isTauri', true);
    invokeMock.mockResolvedValue({
      success: true,
      timedOut: false,
      stdout: '',
      stderr: '',
      json: null,
    });

    await archiveOpenSpecChange('D:\\project', 'add-menu', {
      force: true,
      skipSpecs: true,
    });
    await listOpenSpecChanges('D:\\project');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'openspec_archive_change', {
      rootPath: 'D:\\project',
      changeId: 'add-menu',
      force: true,
      skipSpecs: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'openspec_list_changes', {
      rootPath: 'D:\\project',
    });
  });
});

describe('aiEditViaCli', () => {
  it('still invokes the CLI when progress event registration fails', async () => {
    setTauriGlobal('isTauri', true);
    listenMock.mockRejectedValue(new Error('event API unavailable'));
    invokeMock.mockResolvedValue({
      text: 'completed',
      usage: { totalTokens: 42 },
    });
    const onProgress = vi.fn();
    const onUsage = vi.fn();

    await expect(
      aiEditViaCli('implement the task', 'codex', {
        runId: 'board-card-1',
        onProgress,
        onUsage,
      }),
    ).resolves.toBe('completed');

    expect(invokeMock).toHaveBeenCalledWith(
      'ai_cli',
      expect.objectContaining({
        prompt: 'implement the task',
        adapter: 'codex',
        runId: 'board-card-1',
      }),
    );
    expect(onProgress).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith({ totalTokens: 42 });
  });
});

describe('saveTaskAttachment', () => {
  it('passes attachment bytes and workspace to the native command', async () => {
    setTauriGlobal('isTauri', true);
    invokeMock.mockResolvedValue('D:\\project\\.ugs\\task-attachments\\notes.txt');

    await expect(
      saveTaskAttachment({
        bytesBase64: 'bm90ZXM=',
        mime: 'text/plain',
        fileName: 'notes.txt',
        cwd: 'D:\\project',
      }),
    ).resolves.toContain('notes.txt');

    expect(invokeMock).toHaveBeenCalledWith('save_task_attachment', {
      bytesBase64: 'bm90ZXM=',
      mime: 'text/plain',
      fileName: 'notes.txt',
      cwd: 'D:\\project',
    });
  });
});
