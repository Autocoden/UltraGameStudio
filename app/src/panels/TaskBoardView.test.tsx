import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTaskBoardForTests,
  addTask,
  archiveTask,
  getBoardTasks,
  moveTask,
  setTaskPhase,
} from '@/lib/taskBoard';
import { useStore } from '@/store/useStore';
import TaskBoardView from './TaskBoardView';

/**
 * Component tests for the 任务看板 view (dialog-based creation, Autocode
 * alignment). Data-layer behavior is covered in lib/taskBoard.test.ts; here we
 * cover the spec scenarios that live at the interaction layer: six-column
 * rendering, create via the column-header "+" dialog (title required, cancel
 * safe), dialog editing with prefilled classification, badge display rules,
 * button moves + done stamps, clear-done, and send-to-terminal.
 */

/** Set a controlled input/textarea/select value the way React's tracker accepts. */
function setControlledValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('TaskBoardView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState({ locale: 'zh-CN' });
    window.localStorage.clear();
    __resetTaskBoardForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () =>
    act(async () => {
      root.render(<TaskBoardView />);
    });

  const byTitle = (title: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[title="${title}"]`);

  const addButtons = (columnLabel: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`button[aria-label="新建任务 · ${columnLabel}"]`);

  const dialogTitleInput = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('#task-dialog-title')!;

  const clickDialogButton = async (label: '创建' | '保存' | '取消') => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === label,
    );
    expect(button).not.toBeNull();
    await act(async () => click(button!));
  };

  it('renders the six stage columns with empty hints when the board is empty', async () => {
    await render();
    for (const label of ['待规划', '队列', '进行中', 'AI 审核', '人工审核', '完成']) {
      expect(container.querySelector(`section[aria-label="${label}"]`)).not.toBeNull();
      expect(addButtons(label)).not.toBeNull();
    }
    expect(container.textContent).toContain('暂无卡片');
    expect(container.textContent).toContain('任务看板');
    // No inline composer: the old per-column title inputs must be gone.
    expect(container.querySelectorAll('input[placeholder^="输入任务标题"]')).toHaveLength(0);
  });

  it('creates a card via the column dialog with classification meta', async () => {
    await render();
    await act(async () => click(addButtons('进行中')!));
    expect(dialogTitleInput()).not.toBeNull();
    expect(container.textContent).toContain('添加到「进行中」');

    setControlledValue(dialogTitleInput(), '生成主菜单 UI');
    setControlledValue(
      container.querySelector<HTMLSelectElement>('#task-dialog-category')!,
      'feature',
    );
    setControlledValue(
      container.querySelector<HTMLSelectElement>('#task-dialog-priority')!,
      'urgent',
    );
    await clickDialogButton('创建');

    const cards = getBoardTasks('default');
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('生成主菜单 UI');
    expect(cards[0].status).toBe('in_progress');
    expect(cards[0].category).toBe('feature');
    expect(cards[0].priority).toBe('urgent');
    expect(container.textContent).toContain('功能');
    expect(container.textContent).toContain('紧急');
  });

  it('rejects a blank title and keeps the dialog open', async () => {
    await render();
    await act(async () => click(addButtons('待规划')!));
    setControlledValue(dialogTitleInput(), '   ');
    await clickDialogButton('创建');
    expect(getBoardTasks('default')).toHaveLength(0);
    expect(container.textContent).toContain('标题不能为空');
    expect(dialogTitleInput()).not.toBeNull();
  });

  it('cancel closes the dialog without creating a card', async () => {
    await render();
    await act(async () => click(addButtons('待规划')!));
    setControlledValue(dialogTitleInput(), '不会存在的任务');
    await clickDialogButton('取消');
    expect(getBoardTasks('default')).toHaveLength(0);
    expect(dialogTitleInput()).toBeNull();
  });

  it('moves a card with the next-column button and shows the done stamp', async () => {
    addTask('default', 'backlog', '生成主菜单 UI', '参考 3 个候选方案');
    await render();
    expect(container.textContent).toContain('生成主菜单 UI');
    expect(container.textContent).not.toContain('完成于');

    const next = byTitle('下一列')!;
    expect(next).not.toBeNull();
    await act(async () => click(next));
    expect(getBoardTasks('default')[0].status).toBe('queue');

    for (let i = 0; i < 4; i += 1) {
      await act(async () => click(byTitle('下一列')!));
    }
    const card = getBoardTasks('default')[0];
    expect(card.status).toBe('done');
    expect(typeof card.completedAt).toBe('number');
    expect(container.textContent).toContain('完成于');

    // 移出已完成后清除完成时间
    await act(async () => click(byTitle('上一列')!));
    expect(getBoardTasks('default')[0].completedAt).toBeUndefined();
    expect(container.textContent).not.toContain('完成于');
  });

  it('moves a card by pointer drag to another column', async () => {
    addTask('default', 'backlog', '拖拽任务');
    await render();
    const title = Array.from(container.querySelectorAll('h3')).find(
      (h) => h.textContent === '拖拽任务',
    )!;
    const target = container.querySelector('section[aria-label="进行中"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      await act(async () => {
        title.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
        );
      });
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 300 }),
        );
      });
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, clientX: 400, clientY: 300 }),
        );
      });
    } finally {
      document.elementFromPoint = original;
    }
    expect(getBoardTasks('default')[0].status).toBe('in_progress');
  });

  it('does not drag when the pointerdown lands on a card action button', async () => {
    addTask('default', 'backlog', '按钮任务');
    await render();
    const target = container.querySelector('section[aria-label="进行中"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      const btn = byTitle('下一列')!;
      await act(async () => {
        btn.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
        );
        window.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 300 }),
        );
        window.dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, clientX: 400, clientY: 300 }),
        );
      });
    } finally {
      document.elementFromPoint = original;
    }
    expect(getBoardTasks('default')[0].status).toBe('backlog');
  });

  it('archives all done cards, keeps data and toggles visibility', async () => {
    addTask('default', 'backlog', '待办任务');
    const done = addTask('default', 'done', '已完成任务')!;
    moveTask('default', done.id, 'done');
    await render();

    // 全部归档:卡片从默认视图隐藏,但数据保留
    const archiveAll = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '全部归档',
    )!;
    expect(archiveAll).not.toBeNull();
    await act(async () => click(archiveAll));
    const stored = getBoardTasks('default');
    expect(stored.map((c) => c.title)).toEqual(['待办任务', '已完成任务']);
    expect(stored[1].archived).toBe(true);
    expect(container.textContent).not.toContain('已完成任务');

    // 显示已归档:置灰可见 + 已归档徽标,可恢复
    const show = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('显示已归档'),
    )!;
    await act(async () => click(show));
    expect(container.textContent).toContain('已完成任务');
    expect(container.textContent).toContain('已归档');
    await act(async () => click(byTitle('恢复')!));
    expect(getBoardTasks('default')[1].archived).toBe(false);
    expect(container.textContent).not.toContain('已归档');
  });

  it('excludes archived cards from the column counter', async () => {
    const done = addTask('default', 'done', 'D1')!;
    addTask('default', 'done', 'D2');
    archiveTask('default', done.id);
    await render();
    const doneHeader = container.querySelector('section[aria-label="完成"] h2')!;
    expect(doneHeader.textContent).toContain('1');
    expect(doneHeader.textContent).not.toContain('2');
  });

  it('shows the executing marker and stop action for a running card', async () => {
    addTask('default', 'in_progress', '正在执行的任务');
    setTaskPhase('default', getBoardTasks('default')[0].id, 'executing');
    await render();
    expect(container.textContent).toContain('执行中');
    expect(byTitle('停止')).not.toBeNull();
  });

  it('approves an awaiting-human card into done', async () => {
    const card = addTask('default', 'human_review', '待验收任务');
    setTaskPhase('default', card!.id, 'awaiting_human');
    await render();
    expect(container.textContent).toContain('待人工审核');
    await act(async () => click(byTitle('通过')!));
    const stored = getBoardTasks('default')[0];
    expect(stored.status).toBe('done');
    expect(stored.phase).toBe('complete');
    expect(container.textContent).toContain('已完成');
  });

  it('shows the failure reason and re-queues a failed card', async () => {
    const card = addTask('default', 'human_review', '失败任务');
    setTaskPhase('default', card!.id, 'failed', '菜单文件不存在');
    await render();
    expect(container.textContent).toContain('失败');
    expect(container.textContent).toContain('菜单文件不存在');
    await act(async () => click(byTitle('重新执行')!));
    const stored = getBoardTasks('default')[0];
    expect(stored.status).toBe('queue');
    expect(stored.phase).toBe('idle');
  });

  it('renders the parallel-runs control', async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>('header select');
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(['1', '2', '3', '4']);
  });

  it('edits a card through the dialog with prefilled values', async () => {
    addTask('default', 'backlog', '旧标题', '旧备注', { category: 'feature' });
    await render();
    await act(async () => click(byTitle('编辑')!));

    expect(container.querySelector('#task-dialog-title')).not.toBeNull();
    const titleInput = dialogTitleInput();
    const noteInput = container.querySelector<HTMLTextAreaElement>('#task-dialog-note')!;
    expect(titleInput.value).toBe('旧标题');
    expect(noteInput.value).toBe('旧备注');
    expect(
      (container.querySelector<HTMLSelectElement>('#task-dialog-category')! as HTMLSelectElement)
        .value,
    ).toBe('feature');

    setControlledValue(titleInput, '新标题');
    setControlledValue(noteInput, '新备注');
    setControlledValue(
      container.querySelector<HTMLSelectElement>('#task-dialog-category')!,
      'bug_fix',
    );
    await clickDialogButton('保存');

    const [card] = getBoardTasks('default');
    expect(card.title).toBe('新标题');
    expect(card.note).toBe('新备注');
    expect(card.category).toBe('bug_fix');
    expect(container.textContent).toContain('新标题');
    expect(container.textContent).toContain('缺陷修复');
  });

  it('hides low-priority and low-impact badges (Autocode rule)', async () => {
    addTask('default', 'backlog', '低调任务', '', { priority: 'low', impact: 'low' });
    await render();
    expect(container.textContent).not.toContain('低影响');
    expect(container.textContent).not.toContain('优先级');
    expect(container.textContent).toContain('低调任务');
  });
});
