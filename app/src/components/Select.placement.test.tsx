import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Select from '@/components/Select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const OPTIONS = [
  { id: 'low', label: '低', hint: '低：简单任务' },
  { id: 'high', label: '高', hint: '高：复杂/易错任务' },
];

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

function rect(left: number, width: number, top: number, height: number): Rect {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
  });
}

/** 渲染一个 Select 并打开菜单，返回菜单节点；triggerRect 模拟触发器的视口位置。 */
async function openMenuWithTriggerRect(
  triggerRect: Rect,
): Promise<{ menu: HTMLElement; cleanup: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <Select options={OPTIONS} value="low" onChange={vi.fn()} title="思考深度" />,
    );
  });

  const trigger = container.querySelector<HTMLButtonElement>(
    'button[title="思考深度"]',
  );
  if (!trigger) throw new Error('trigger not found');
  // Select 根节点就是触发器的父元素，摆放计算读的正是它的视口坐标。
  const rootEl = trigger.parentElement as HTMLDivElement;
  rootEl.getBoundingClientRect = () => triggerRect as DOMRect;

  await act(async () => {
    trigger.click();
  });

  const menu = container.querySelector<HTMLElement>('[role="listbox"]')
    ?.parentElement as HTMLElement;
  return {
    menu,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  setViewport(1024, 768);
});

describe('Select 弹层摆放', () => {
  it('触发器贴右侧时改为右对齐，宽度夹在左侧可用空间内', async () => {
    setViewport(1000, 768);
    // 触发器右边缘距窗口只剩 92px，左侧有 972px：必须向左展开。
    const view = await openMenuWithTriggerRect(rect(900, 80, 600, 20));
    try {
      expect(view.menu.className).toContain('right-0');
      expect(view.menu.className).not.toContain('left-0');
      // 左侧可用 972px，被 520px 的宽度上限收住——不会被窗口/面板裁掉。
      expect(view.menu.style.maxWidth).toBe('520px');
      // 下限用触发器实测宽度，菜单不会窄于触发器、也不会被 min-w-full 撑成
      // 整条输入框宽。
      expect(view.menu.style.minWidth).toBe('80px');
      expect(view.menu.style.width).toBe('max-content');
      // 输入框在底部：仍向上弹。
      expect(view.menu.className).toContain('bottom-full');
    } finally {
      await view.cleanup();
    }
  });

  it('触发器靠左时保持左对齐', async () => {
    setViewport(1000, 768);
    const view = await openMenuWithTriggerRect(rect(20, 80, 600, 20));
    try {
      expect(view.menu.className).toContain('left-0');
      expect(view.menu.className).not.toContain('right-0');
      expect(view.menu.style.maxWidth).toBe('520px');
    } finally {
      await view.cleanup();
    }
  });

  it('上方空间不足时向下展开，并按剩余高度收紧列表', async () => {
    setViewport(1000, 768);
    const view = await openMenuWithTriggerRect(rect(20, 80, 30, 20));
    try {
      expect(view.menu.className).toContain('top-full');
      expect(view.menu.className).not.toContain('bottom-full');
      const list = view.menu.querySelector<HTMLElement>('[role="listbox"]');
      // 上方只剩 22px，改为向下后可用 710px，仍以 320px 上限收口。
      expect(view.menu.style.maxHeight).toBe('320px');
      expect(list?.style.maxHeight).toBe('286px');
    } finally {
      await view.cleanup();
    }
  });

  it('窗口很窄时菜单宽度不超过所在侧的可用空间', async () => {
    setViewport(420, 768);
    const view = await openMenuWithTriggerRect(rect(380, 30, 600, 20));
    try {
      // 右侧 32px、左侧 402px → 右对齐，最大宽度 = 左侧可用宽度。
      expect(view.menu.className).toContain('right-0');
      expect(view.menu.style.maxWidth).toBe('402px');
      expect(view.menu.style.minWidth).toBe('30px');
    } finally {
      await view.cleanup();
    }
  });
});
