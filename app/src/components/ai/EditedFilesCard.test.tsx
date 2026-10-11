import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import EditedFilesCard from './EditedFilesCard';
import type { TurnFileChanges } from '@/lib/turnFileChanges';

describe('EditedFilesCard', () => {
  it('folds files, expands all, opens paths, and survives remount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const changes: TurnFileChanges = { source: 'agent', rootPath: 'E:/Game', files:
      Array.from({ length: 7 }, (_, i) => ({ path: `E:/Game/src/file${i}.ts`, added: i + 1, deleted: i })) };
    const onOpenFile = vi.fn();
    let root = createRoot(container);
    try {
      await act(async () => root.render(<EditedFilesCard changes={changes} locale="zh-CN" onOpenFile={onOpenFile} />));
      expect(container.textContent).toContain('已编辑 7 个文件');
      expect(container.querySelectorAll('button[title]')).toHaveLength(4);
      expect(container.textContent).toContain('+28');
      expect(container.textContent).not.toContain('E:/Game');
      await act(async () => (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
      expect(container.querySelectorAll('button[title]')).toHaveLength(7);
      await act(async () => (container.querySelector('button[title]') as HTMLButtonElement).click());
      expect(onOpenFile).toHaveBeenCalledWith({ path: 'E:/Game/src/file0.ts', basename: 'file0.ts' });
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(<EditedFilesCard changes={JSON.parse(JSON.stringify(changes))} locale="zh-CN" />));
      expect(container.textContent).toContain('已编辑 7 个文件');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
