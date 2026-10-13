import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageContent from './MessageContent';
import { fileExists } from '@/lib/tauri';
import { useStore } from '@/store/useStore';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  fileExists: vi.fn(),
  previewLocalFile: vi.fn(),
}));

/**
 * 回归：`[描述](file:///E:/…/交付物.md)` 是模型交付本地文件时的标准写法。
 * react-markdown 的 defaultUrlTransform 只放行 http/https/irc/mailto/xmpp，
 * `file:` 会被清成空串，SmartLink 于是把整条链接降级成只有下划线的装饰性
 * <span>：看着像链接，点下去毫无反应——正是"交付物点不了"的根因。这些用例把
 * "AI 给出的本地交付物链接必须真的可点"这条契约锁住。
 *
 * 用例刻意走完整 markdown 管线（MessageContent → Markdown → SmartLink），
 * 因为丢链路的环节在 urlTransform，单独渲染 SmartLink 抓不到。
 */
describe('本地交付物链接（file:///）必须可点', () => {
  const HREF = (ext: string) =>
    'file:///E:/gdc/Strand_Hair_%E5%A4%BA%E5%AE%9D%E5%A5%87%E5%85%B5_%E5%8F%A4%E8%80%81%E4%B9%8B%E5%9C%88_%E7%9F%A5%E4%B9%8E%E5%AF%B9%E6%AF%94%E7%89%88.' +
    ext;
  const DECODED = 'E:/gdc/Strand_Hair_夺宝奇兵_古老之圈_知乎对比版';

  beforeEach(() => {
    useStore.setState({ locale: 'zh-CN' });
    vi.mocked(fileExists).mockReset();
    vi.mocked(fileExists).mockResolvedValue(true);
  });

  it('markdown md 链接渲染成可点文件 chip，而不是装饰性 accent span', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `主交付 md 在这里：\n\n- [知乎对比版 md（162 KB / 1757 行 / 113 张图引用）](${HREF('md')})`,
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).toMatch(/ai-file-chip--interactive/);
    expect(html).toMatch(/E:\/gdc\/Strand_Hair_夺宝奇兵_古老之圈_知乎对比版\.md/);
    // 旧行为：href 被清空 → 只剩这个带下划线、点不动的 span。
    expect(html).not.toMatch(/class="text-accent underline/);
  });

  it('HTML 交付物同理，且百分比编码的路径要解码成真实本地路径', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: `配套 HTML：\n\n- [知乎对比版 HTML（12 MB）](${HREF('html')})`,
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).toMatch(/ai-file-chip--interactive/);
    expect(html).toMatch(/E:\/gdc\/Strand_Hair_夺宝奇兵_古老之圈_知乎对比版\.html/);
    expect(html).not.toMatch(/%E5%A4%BA/);
  });

  it('真实失败样本：链接文字带「（162 KB / 1757 行 / 113 张图引用）」注解也要可点', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text:
          '主交付 md 在这里：\n\n' +
          `- [Strand_Hair_夺宝奇兵_古老之圈_知乎对比版.md（162 KB / 1757 行 / 113 张图引用）](${HREF('md')})\n\n` +
          '配套 HTML（图片内嵌 + 点击放大，离线可看）：\n\n' +
          `- [知乎对比版 HTML（12 MB）](${HREF('html')})`,
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    const interactive = html.match(/ai-file-chip--interactive/g) ?? [];
    expect(interactive).toHaveLength(2);
    expect(html).toMatch(/Strand_Hair_夺宝奇兵_古老之圈_知乎对比版\.md/);
    expect(html).not.toMatch(/class="text-accent underline/);
  });

  it('href 落在目录/不可解析时，按链接文字里的文件名救回可点性', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '- [report.md（162 KB / 1757 行）](E:\\gdc\\pdf-translations\\AVBOIT_SIG2025_MDROBOT)',
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).toMatch(/ai-file-chip--interactive/);
    expect(html).toMatch(/report\.md/);
  });

  it('真的没有本地文件可指时，不再渲染成「看着像链接、点不动」的 accent span', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        text: '- [某个东西](obsidian://open?vault=notes)',
        streaming: false,
        onOpenFile: () => {},
      }),
    );

    expect(html).not.toMatch(/ai-file-chip/);
    expect(html).not.toMatch(/class="text-accent underline/);
    expect(html).toMatch(/某个东西/);
  });

  it('点击交付物链接会真正触发 onOpenFile', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const opened: string[] = [];

    try {
      await act(async () => {
        root.render(
          createElement(MessageContent, {
            text: `主交付 md：\n\n- [主交付 md](${HREF('md')})`,
            streaming: false,
            onOpenFile: (ref) => {
              opened.push(ref.path);
            },
          }),
        );
      });

      const chip = container.querySelector<HTMLButtonElement>('button.ai-file-chip');
      expect(chip).not.toBeNull();
      expect(chip!.disabled).toBe(false);

      await act(async () => {
        chip!.click();
      });

      expect(opened).toEqual([`${DECODED}.md`]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
