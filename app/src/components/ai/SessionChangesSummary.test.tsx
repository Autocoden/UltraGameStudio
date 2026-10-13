import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import SessionChangesSummary from './SessionChangesSummary';
import type { TurnFileChanges } from '@/lib/turnFileChanges';

async function renderSummary(changes: TurnFileChanges, check: (container: HTMLDivElement, open: ReturnType<typeof vi.fn>) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const open = vi.fn();
  try {
    await act(async () => root.render(<SessionChangesSummary changes={changes} locale="zh-CN" onOpenSessionFiles={open} />));
    await check(container, open);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe('session changes summary', () => {
  it('opens the session-files panel without rendering a duplicate file popup', async () => {
    await renderSummary({ source: 'agent', rootPath: 'E:/Game', files: [{ path: 'E:/Game/src/app.ts', added: 7, deleted: 2 }] }, async (container, open) => {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(open).toHaveBeenCalledOnce();
      expect(container.querySelector('details')).toBeNull();
      expect(container.querySelectorAll('button')).toHaveLength(1);
      expect(container.querySelector('button')?.getAttribute('aria-controls')).toBe('ugs-project-file-panel');
      expect(container.textContent).toContain('已修改 1 个文件');
      expect(container.textContent).toContain('+7');
    });
  });
  it('does not present truncated counts as complete totals or per-file counts', async () => {
    await renderSummary({ source: 'snapshot', truncated: true, files: [{ path: 'app.ts', added: 7, deleted: 2, truncated: true }] }, async (container) => {
      expect(container.querySelector('button')?.textContent).toContain('+—');
      expect(container.querySelector('button')?.textContent).not.toContain('+7');
      expect(container.querySelector('button')?.title).toContain('部分文件行数未知');
    });
  });
  it('preserves unavailable binary line counts instead of showing zero', async () => {
    await renderSummary({ source: 'agent', files: [{ path: 'image.png', binary: true }] }, async (container) => {
      expect(container.querySelector('button')?.textContent).toContain('+—');
      expect(container.querySelector('button')?.textContent).toContain('−—');
    });
  });
});
