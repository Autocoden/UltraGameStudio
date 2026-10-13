import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import GeneratedArtifactsCard from './GeneratedArtifactsCard';

describe('生成物卡片', () => {
  it('卡片打开文件，文件夹按钮定位文件，重建后仍能点击', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root = createRoot(container);
    const artifact = { ref: { path: 'reports/报告.docx', basename: '报告.docx' }, label: '下载完整 Word 报告' };
    const onOpenFile = vi.fn();
    try {
      await act(async () => root.render(<GeneratedArtifactsCard artifacts={[artifact]} cwd="E:/Game" onOpenFile={onOpenFile} />));
      expect(container.textContent).toContain('报告.docx');
      await act(async () => (container.querySelector('button[aria-label="打开生成物：报告.docx"]') as HTMLButtonElement).click());
      expect(onOpenFile).toHaveBeenLastCalledWith(artifact.ref);
      await act(async () => (container.querySelector('button[aria-label="在文件夹中显示：报告.docx"]') as HTMLButtonElement).click());
      expect(onOpenFile).toHaveBeenLastCalledWith(artifact.ref, { reveal: true });
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(<GeneratedArtifactsCard artifacts={JSON.parse(JSON.stringify([artifact]))} onOpenFile={onOpenFile} />));
      expect(container.querySelector('section[data-ugs-generated-artifacts]')).not.toBeNull();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
