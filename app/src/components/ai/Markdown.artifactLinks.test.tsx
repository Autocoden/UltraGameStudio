import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageContent from './MessageContent';
import { parseFileRef } from './lib/filePath';
import { MESSAGE_FILE_CHIP_LIMIT } from './lib/fileChipBudget';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  fileExists: vi.fn().mockResolvedValue(true),
  readImageThumbnail: vi.fn().mockRejectedValue(new Error('缩略图不可用')),
  previewLocalFile: vi.fn().mockRejectedValue(new Error('缩略图不可用')),
}));

const cwd = 'E:/project_moon_ue5/MoonGame/Client/Game';
const image = `${cwd}/.ultragamestudio/temp/mdsc_foliage_height_20261009/before_after_comparison.png`;
const report = `${cwd}/.ultragamestudio/docs/dev/MDSC近景植被阴影高度修复_20261009.docx`;

describe('会话结束后的产物链接', () => {
  const roots: ReturnType<typeof createRoot>[] = [];
  const containers: HTMLDivElement[] = [];

  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    containers.splice(0).forEach((container) => container.remove());
  });

  it.each([
    ['盘符前斜杠', `/${image}`, `/${report}`],
    ['Windows 盘符', image, report],
    ['file 协议', `file:///${image}`, `file:///${report}`],
    ['带空格的路径', `/${image.replace('before_after', 'before after')}`, `/${report.replace('MDSC', 'MDSC report ')}`],
  ])('%s 保留入口标签，点击传入正确本地路径', async (_name, imageUrl, reportUrl) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const onOpenFile = vi.fn();
    await act(async () => {
      root.render(createElement(MessageContent, {
        text: `[查看截图对照](<${imageUrl}>) · [下载完整 Word 报告](<${reportUrl}>)`,
        streaming: false,
        cwd,
        onOpenFile,
      }));
    });
    for (const [label, url] of [['查看截图对照', imageUrl], ['下载完整 Word 报告', reportUrl]]) {
      const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);
      expect(button, `${label} 必须是可点击按钮`).toBeDefined();
      expect(button?.disabled).toBe(false);
      await act(async () => button!.click());
      expect(onOpenFile).toHaveBeenLastCalledWith(expect.objectContaining({
        path: url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:[\\/])/, '$1'),
      }));
    }
  });

  it('普通文档 file URL 不会退化成带下划线的纯文本', async () => {
    const container = document.createElement('div');
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(createElement(MessageContent, {
      text: '[打开报告](file:///E:/reports/report.docx)',
      onOpenFile: vi.fn(),
    })));
    expect(container.querySelector('button')?.textContent).toBe('打开报告');
  });

  it('报告位于文件折叠边界或其后时仍可点击', async () => {
    const container = document.createElement('div');
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const onOpenFile = vi.fn();
    await act(async () => root.render(createElement(MessageContent, {
      text: [
        ...Array.from({ length: MESSAGE_FILE_CHIP_LIMIT }, (_, i) => `[源文件 ${i}](src/file${i}.ts)`),
        `[下载完整 Word 报告](</${report}>)`,
        '[打开附加报告](reports/extra.docx)',
      ].join(' · '),
      onOpenFile,
    })));
    for (const label of ['下载完整 Word 报告', '打开附加报告']) {
      const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);
      expect(button?.disabled).toBe(false);
      await act(async () => button!.click());
    }
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it('盘符路径归一化保留源码行号，拒绝外部协议', () => {
    expect(parseFileRef('/E:/src/ShadowRendering.cpp:2016')?.path).toBe('E:/src/ShadowRendering.cpp');
    expect(parseFileRef('/E:/src/ShadowRendering.cpp:2016')?.startLine).toBe(2016);
    expect(parseFileRef('https://example.com/report.docx')).toBeNull();
    expect(parseFileRef('javascript:alert(1)')).toBeNull();
  });
});
