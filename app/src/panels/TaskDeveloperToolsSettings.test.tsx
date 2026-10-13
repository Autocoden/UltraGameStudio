import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_DEVELOPER_TOOLS_STORAGE,
  loadTaskDeveloperToolPreferences,
} from '@/lib/taskDeveloperTools';
import TaskDeveloperToolsSettings from './TaskDeveloperToolsSettings';

const tauriMocks = vi.hoisted(() => ({
  detectTaskDeveloperTools: vi.fn(),
  tauriAvailable: vi.fn(() => true),
}));

vi.mock('@/lib/tauri', () => tauriMocks);

describe('TaskDeveloperToolsSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    tauriMocks.tauriAvailable.mockReturnValue(true);
    tauriMocks.detectTaskDeveloperTools.mockReset().mockResolvedValue({
      ides: [
        {
          id: 'cursor',
          name: 'Cursor',
          path: 'C:\\Users\\tester\\Cursor.exe',
          installed: true,
        },
      ],
      terminals: [
        { id: 'system', name: 'System Terminal', path: 'cmd.exe', installed: true },
        {
          id: 'powershell',
          name: 'PowerShell',
          path: 'C:\\Windows\\powershell.exe',
          installed: true,
        },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('detects installed tools and persists the IDE, terminal, and custom path', async () => {
    await act(async () => {
      root.render(<TaskDeveloperToolsSettings locale="zh-CN" />);
      await Promise.resolve();
    });

    expect(tauriMocks.detectTaskDeveloperTools).toHaveBeenCalledTimes(1);
    const ide = container.querySelector<HTMLSelectElement>('#preferred-task-ide')!;
    const terminal = container.querySelector<HTMLSelectElement>(
      '#preferred-task-terminal',
    )!;
    expect(ide.options[1]?.textContent).toContain('Cursor');
    expect(ide.options[1]?.textContent).toContain('✓');

    await act(async () => {
      ide.value = 'custom';
      ide.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const customPath = container.querySelector<HTMLInputElement>(
      '#custom-task-ide-path',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        customPath,
        'C:\\Tools\\editor.exe',
      );
      customPath.dispatchEvent(new Event('input', { bubbles: true }));
      terminal.value = 'powershell';
      terminal.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(loadTaskDeveloperToolPreferences()).toEqual({
      preferredIDE: 'custom',
      customIDEPath: 'C:\\Tools\\editor.exe',
      preferredTerminal: 'powershell',
      customTerminalPath: '',
    });
    expect(localStorage.getItem(TASK_DEVELOPER_TOOLS_STORAGE)).toContain(
      'C:\\\\Tools\\\\editor.exe',
    );
  });
});
