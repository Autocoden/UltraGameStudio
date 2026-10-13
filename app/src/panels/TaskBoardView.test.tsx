import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTaskBoardForTests,
  addTask,
  archiveTask,
  getBoardTasks,
  moveTask,
  setTaskPhase,
  updateTaskExecution,
} from '@/lib/taskBoard';
import {
  __publishTaskStreamForTests,
  __resetRunnerForTests,
} from '@/lib/taskBoardRunner';
import { useStore } from '@/store/useStore';
import TaskBoardView from './TaskBoardView';

const tauriMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  openExternal: tauriMocks.openExternal,
}));

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
    tauriMocks.openExternal.mockClear();
    __resetTaskBoardForTests();
    __resetRunnerForTests();
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
      if (label === '待规划') expect(addButtons(label)).not.toBeNull();
      else expect(addButtons(label)).toBeNull();
    }
    expect(container.textContent).toContain('没有待规划的任务');
    expect(byTitle('刷新任务')).not.toBeNull();
    // No inline composer: the old per-column title inputs must be gone.
    expect(container.querySelectorAll('input[placeholder^="输入任务标题"]')).toHaveLength(0);
  });

  it('opens the official confirmation for a Spec card instead of hiding it', async () => {
    const card = addTask('default', 'done', 'Spec archive entry', '', { developmentMode: 'spec', openSpecChange: 'spec-entry' })!;
    await render();
    const archive = container.querySelector('section[aria-label="完成"] button[aria-label="归档"]');
    expect(archive).not.toBeNull();
    await act(async () => click(archive!));
    const confirmation = document.querySelector('[aria-label="归档 OpenSpec 变更"]');
    expect(confirmation).not.toBeNull();
    expect(getBoardTasks('default').find(task => task.id === card.id)?.archived).not.toBe(true);
    const cancel = [...confirmation!.querySelectorAll('button')].find(button => button.textContent === '取消')!;
    await act(async () => click(cancel));
    expect(getBoardTasks('default').find(task => task.id === card.id)?.archived).not.toBe(true);
  });

  it('does not show unexecuted stages as complete while waiting for plan approval', async () => {
    const card = addTask('default', 'human_review', 'Awaiting implementation', 'Work', {
      developmentMode: 'standard', requireReviewBeforeCoding: true,
    })!;
    updateTaskExecution('default', card.id, {
      plan: '## Tasks\n- [ ] Implement', planApproved: false,
      subtasks: [{ id: 's1', title: 'Implement', status: 'pending' }],
      runs: [{ phase: 'planning', text: 'Plan ready', startedAt: 1, completedAt: 2 }],
    });
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();
    const stages = container.querySelector('[aria-label="任务阶段：计划、代码、质量保证"]')!;
    expect(stages.textContent).toContain('✓ 计划');
    expect(stages.textContent).not.toContain('✓ 代码');
    expect(stages.textContent).not.toContain('✓ 质量保证');
    expect(container.textContent).not.toContain('100%');
    const approve = container.querySelector('button[title="批准计划并开始执行"]')!;
    expect(approve).not.toBeNull();
    await act(async () => click(approve));
    expect(getBoardTasks('default')[0]).toMatchObject({ status: 'queue', planApproved: true });
  });

  it('creates a card via the column dialog with classification meta', async () => {
    await render();
    await act(async () => click(addButtons('待规划')!));
    expect(dialogTitleInput()).not.toBeNull();
    expect(container.textContent).toContain('创建新任务');

    await act(async () => {
      setControlledValue(dialogTitleInput(), '生成主菜单 UI');
      setControlledValue(container.querySelector<HTMLTextAreaElement>('#task-dialog-note')!, '创建包含开始、设置和退出按钮的主菜单');
      click(container.querySelector('button[aria-controls="task-dialog-classification"]')!);
    });
    await act(async () => {
      setControlledValue(
        container.querySelector<HTMLSelectElement>('#task-dialog-category')!,
        'feature',
      );
      setControlledValue(
        container.querySelector<HTMLSelectElement>('#task-dialog-priority')!,
        'urgent',
      );
    });
    await clickDialogButton('创建');

    const cards = getBoardTasks('default');
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('生成主菜单 UI');
    expect(cards[0].status).toBe('backlog');
    expect(cards[0].category).toBe('feature');
    expect(cards[0].priority).toBe('urgent');
    expect(container.textContent).toContain('功能');
    expect(container.textContent).toContain('紧急');
  });

  it('rejects a blank description and keeps the dialog open', async () => {
    await render();
    await act(async () => click(addButtons('待规划')!));
    setControlledValue(dialogTitleInput(), '   ');
    await clickDialogButton('创建');
    expect(getBoardTasks('default')).toHaveLength(0);
    expect(container.textContent).toContain('任务描述不能为空');
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

  it('creates and queues a description-only task with an automatically generated title', async () => {
    await render();
    await act(async () => click(addButtons('待规划')!));
    await act(async () => setControlledValue(container.querySelector<HTMLTextAreaElement>('#task-dialog-note')!, '实现菜单\n包含开始和退出按钮'));
    const start = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '创建并启动')!;
    await act(async () => click(start));
    expect(getBoardTasks('default')[0]).toMatchObject({ title: '实现菜单', note: '实现菜单\n包含开始和退出按钮', status: 'queue' });
    expect(window.localStorage.getItem('ugs.board.draft.default')).toBeNull();
  });

  it('moves a card from the actions menu and shows completed progress', async () => {
    addTask('default', 'backlog', '生成主菜单 UI', '参考 3 个候选方案');
    await render();
    expect(container.textContent).toContain('生成主菜单 UI');
    await act(async () => click(byTitle('移至队列')!));
    expect(getBoardTasks('default')[0].status).toBe('queue');
    for (const label of ['进行中', 'AI 审核', '人工审核', '完成']) {
      await act(async () => click(byTitle(`移至${label}`)!));
    }
    const card = getBoardTasks('default')[0];
    expect(card.status).toBe('done');
    expect(typeof card.completedAt).toBe('number');
    expect(container.textContent).toContain('100%');

    await act(async () => click(byTitle('移至人工审核')!));
    expect(getBoardTasks('default')[0].completedAt).toBeUndefined();
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
      const btn = byTitle('任务操作')!;
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

  it('renders the card delete confirmation outside the transformed task card', async () => {
    addTask('default', 'backlog', '待删除任务');
    await render();

    await act(async () => click(byTitle('删除')!));

    const dialog = document.body.querySelector<HTMLElement>(
      '[role="alertdialog"][aria-label="删除任务"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('[data-task-id]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();

    const cancel = Array.from(dialog!.querySelectorAll('button')).find(
      (button) => button.textContent === '取消',
    )!;
    await act(async () => click(cancel));
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('archives all done cards, keeps data and toggles visibility', async () => {
    addTask('default', 'backlog', '待办任务');
    const done = addTask('default', 'done', '已完成任务')!;
    moveTask('default', done.id, 'done');
    await render();

    // 全部归档:卡片从默认视图隐藏,但数据保留
    const archiveAll = byTitle('全部归档')!;
    expect(archiveAll).not.toBeNull();
    await act(async () => click(archiveAll));
    const stored = getBoardTasks('default');
    expect(stored.map((c) => c.title)).toEqual(['待办任务', '已完成任务']);
    expect(stored[1].archived).toBe(true);
    expect(container.textContent).not.toContain('已完成任务');

    // 显示已归档:置灰可见 + 已归档徽标,可恢复
    const show = byTitle('显示已归档')!;
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

  it('shows Standard planning as its own active stage', async () => {
    const card = addTask('default', 'in_progress', '正在计划的任务', '', {
      developmentMode: 'standard',
    })!;
    setTaskPhase('default', card.id, 'planning');
    await render();

    const taskCard = container.querySelector<HTMLElement>(
      `[data-task-id="${card.id}"]`,
    )!;
    expect(taskCard.textContent).toContain('计划中');
    expect(taskCard.textContent).toContain('● 计划');
    expect(taskCard.textContent).toContain('15%');
    expect(taskCard.querySelector('[role="log"]')).toBeNull();
    expect(byTitle('停止')).not.toBeNull();
  });

  it('keeps streamed task output out of the board card', async () => {
    const card = addTask('default', 'in_progress', '流式运行任务')!;
    setTaskPhase('default', card.id, 'executing');
    await render();

    const taskCard = container.querySelector<HTMLElement>(
      `[data-task-id="${card.id}"]`,
    )!;
    expect(taskCard.querySelector('[role="log"]')).toBeNull();

    await act(async () => {
      __publishTaskStreamForTests('default', card.id, {
        phase: 'executing',
        text: '正在读取任务文件\n正在生成修改',
        startedAt: 1,
      });
    });

    expect(taskCard.querySelector('[role="log"]')).toBeNull();
    expect(taskCard.textContent).not.toContain('正在读取任务文件');
  });

  it('opens spec tasks in the dedicated near-fullscreen OpenSpec workspace', async () => {
    addTask('default', 'backlog', '规范驱动任务', '从正式工件实施', {
      developmentMode: 'spec',
      openSpecChange: 'add-main-menu',
      openSpecSchema: 'spec-driven',
    });
    await render();

    const title = Array.from(container.querySelectorAll('h3')).find(
      (heading) => heading.textContent === '规范驱动任务',
    );
    expect(title).not.toBeNull();
    await act(async () => click(title!));

    const modal = document.body.querySelector<HTMLElement>(
      '[data-testid="openspec-task-detail"]',
    );
    expect(modal).not.toBeNull();
    expect(modal?.className).toContain('inset-3');
    expect(modal?.textContent).toContain('规范驱动任务');
    expect(modal?.textContent).toContain('OpenSpec');
    expect(modal?.querySelector('[role="tablist"]')).toBeNull();

    await act(async () =>
      click(modal!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!),
    );
    expect(
      document.body.querySelector('[data-testid="openspec-task-detail"]'),
    ).toBeNull();
  });

  it('keeps OpenSpec plan approval reachable in the dedicated workspace', async () => {
    const card = addTask('default', 'human_review', '待批准规范', '', {
      developmentMode: 'spec',
      useWorktree: true,
      openSpecChange: 'approve-spec-plan',
      openSpecSchema: 'spec-driven',
    })!;
    updateTaskExecution('default', card.id, {
      plan: '- [ ] 实施功能',
      planApproved: false,
      executionCwd: 'D:\\worktrees\\approve-spec-plan',
    });
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();
    const title = Array.from(container.querySelectorAll('h3')).find(
      (heading) => heading.textContent === '待批准规范',
    )!;
    await act(async () => click(title));

    const modal = document.body.querySelector<HTMLElement>(
      '[data-testid="openspec-task-detail"]',
    )!;
    const approve = Array.from(modal.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '批准规范并构建',
    );
    expect(approve).not.toBeUndefined();
    expect(modal.textContent).not.toContain('构建已就绪，等待人工验收');
    await act(async () => click(approve!));
    expect(getBoardTasks('default')[0].planApproved).toBe(true);
  });

  it('routes final OpenSpec worktree completion through the acceptance panel', async () => {
    const card = addTask('default', 'human_review', '待验收规范实现', '', {
      developmentMode: 'spec',
      useWorktree: true,
      openSpecChange: 'review-spec-build',
      openSpecSchema: 'spec-driven',
    })!;
    updateTaskExecution('default', card.id, {
      plan: '- [x] 实施功能',
      planApproved: true,
      executionCwd: 'D:\\worktrees\\review-spec-build',
    });
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();
    const title = Array.from(container.querySelectorAll('h3')).find(
      (heading) => heading.textContent === '待验收规范实现',
    )!;
    await act(async () => click(title));

    const modal = document.body.querySelector<HTMLElement>(
      '[data-testid="openspec-task-detail"]',
    )!;
    const review = Array.from(modal.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '验收改动',
    );
    expect(review).not.toBeUndefined();
    expect(
      Array.from(modal.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === '标记完成',
      ),
    ).toBe(false);
    await act(async () => click(review!));
    expect(modal.textContent).toContain('任务验收');
    expect(modal.textContent).toContain('构建已就绪，等待人工验收');
    expect(getBoardTasks('default')[0].status).toBe('human_review');
  });

  it('approves an awaiting-human card into done', async () => {
    const card = addTask('default', 'human_review', '待验收任务');
    setTaskPhase('default', card!.id, 'awaiting_human');
    await render();
    expect(container.textContent).toContain('需要审核');
    await act(async () => click(Array.from(container.querySelectorAll('h3')).find((h) => h.textContent === '待验收任务')!));
    const approve = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('标记完成'))!;
    await act(async () => click(approve));
    const stored = getBoardTasks('default')[0];
    expect(stored.status).toBe('done');
    expect(stored.phase).toBe('complete');
    expect(container.textContent).toContain('已完成');
  });

  it('completes a reviewed card directly without opening task details', async () => {
    const card = addTask('default', 'human_review', '完成入口测试')!;
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();
    const article = container.querySelector(`[data-task-id="${card.id}"]`)!;
    expect(article.querySelector('[title="确认完成"]')).toBeNull();
    await act(async () => click(article.querySelector('[title="移至完成"]')!));
    expect(getBoardTasks('default')[0]).toMatchObject({ status: 'done', phase: 'complete' });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('section[aria-label="完成"]')?.textContent).toContain('完成入口测试');
  });

  it('requires final worktree acceptance before the generic completion action', async () => {
    const card = addTask('default', 'human_review', '工作树验收任务', '', {
      developmentMode: 'standard',
      useWorktree: true,
    })!;
    updateTaskExecution('default', card.id, {
      plan: '1. 实现功能',
      planApproved: true,
      executionCwd: 'D:\\worktrees\\board-task',
    });
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();
    await act(async () => click(Array.from(container.querySelectorAll('h3')).find((h) => h.textContent === '工作树验收任务')!));

    expect(container.textContent).toContain('构建已就绪，等待人工验收');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === '标记完成',
      ),
    ).toBe(false);
    expect(container.textContent).toContain('合并到');
    expect(getBoardTasks('default')[0].status).toBe('human_review');
  });

  it('keeps plan approval available before a worktree build starts', async () => {
    const card = addTask('default', 'human_review', '待批准计划', '', {
      developmentMode: 'standard',
      requireReviewBeforeCoding: true,
      useWorktree: true,
    })!;
    updateTaskExecution('default', card.id, {
      plan: '1. 先实现主流程',
      planApproved: false,
      executionCwd: 'D:\\worktrees\\planning-task',
    });
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();
    await act(async () => click(Array.from(container.querySelectorAll('h3')).find((h) => h.textContent === '待批准计划')!));

    expect(container.textContent).toContain('批准计划并构建');
    expect(container.textContent).not.toContain('构建已就绪，等待人工验收');
  });

  it('shows the failure reason and re-queues a failed card', async () => {
    const card = addTask('default', 'human_review', '失败任务');
    setTaskPhase('default', card!.id, 'failed', '菜单文件不存在');
    await render();
    expect(container.textContent).toContain('失败');
    expect(container.textContent).toContain('菜单文件不存在');
    await act(async () => click(byTitle('继续')!));
    const stored = getBoardTasks('default')[0];
    expect(stored.status).toBe('queue');
    expect(stored.phase).toBe('idle');
  });

  it('renders the parallel-runs control', async () => {
    await render();
    await act(async () => click(byTitle('队列设置')!));
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.min).toBe('1');
    expect(input.max).toBe('10');
    await act(async () => setControlledValue(input, '7'));
    await clickDialogButton('保存');
    expect(window.localStorage.getItem('ugs.taskboard.runner.v1.default')).toBe('7');
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

  it('offers selection in every column and selects cards from different stages', async () => {
    addTask('default', 'backlog', '待规划选择');
    addTask('default', 'done', '完成选择');
    await render();

    for (const label of ['待规划', '队列', '进行中', 'AI 审核', '人工审核', '完成']) {
      expect(
        container.querySelector(
          `section[aria-label="${label}"] input[type="checkbox"]`,
        ),
      ).not.toBeNull();
    }

    await act(async () =>
      click(container.querySelector('input[aria-label="全选待规划任务"]')!),
    );
    await act(async () =>
      click(container.querySelector('input[aria-label="全选完成任务"]')!),
    );
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="选择任务：待规划选择"]',
      )?.checked,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="选择任务：完成选择"]',
      )?.checked,
    ).toBe(true);
    expect(container.textContent).toContain('已选择 2 个任务');
    expect(container.textContent).toContain('创建 PR');
    expect(container.textContent).toContain('删除所选');
    expect(container.textContent).toContain('清除选择');
  });

  it('bulk deletion skips active tasks and keeps them selected', async () => {
    addTask('default', 'backlog', '可以删除');
    const running = addTask('default', 'in_progress', '正在运行')!;
    setTaskPhase('default', running.id, 'executing');
    await render();

    await act(async () =>
      click(container.querySelector('input[aria-label="选择任务：可以删除"]')!),
    );
    await act(async () =>
      click(container.querySelector('input[aria-label="选择任务：正在运行"]')!),
    );
    await act(async () =>
      click(
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === '删除所选',
        )!,
      ),
    );
    expect(container.textContent).toContain('运行中，将跳过');
    await act(async () =>
      click(
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === '删除 1 个任务',
        )!,
      ),
    );

    expect(getBoardTasks('default').map((card) => card.title)).toEqual([
      '正在运行',
    ]);
    expect(container.textContent).toContain('已选择 1 个任务');
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="选择任务：正在运行"]',
      )?.checked,
    ).toBe(true);
  });

  it('opens the saved pull request from a completed card', async () => {
    const card = addTask('default', 'done', '已有 PR')!;
    updateTaskExecution('default', card.id, {
      pullRequestUrl: 'https://github.com/example/repo/pull/17',
    });
    await render();

    await act(async () => click(byTitle('查看 PR')!));
    expect(tauriMocks.openExternal).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/17',
    );
  });

  it('completes a worktree task through the existing menu without opening details or changing the worktree', async () => {
    const card = addTask('default', 'human_review', '需要工作树验收', '', {
      useWorktree: true,
    })!;
    updateTaskExecution('default', card.id, {
      executionCwd: 'D:\\worktrees\\manual-completion',
    });
    setTaskPhase('default', card.id, 'awaiting_human');
    await render();

    await act(async () => click(byTitle('移至完成')!));
    expect(getBoardTasks('default')[0]).toMatchObject({
      status: 'done', phase: 'complete',
      executionCwd: 'D:\\worktrees\\manual-completion', useWorktree: true,
    });
    expect(getBoardTasks('default')[0].worktreeCleaned).not.toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows expand-all only after three columns collapse and toggles lock state', async () => {
    await render();
    expect(byTitle('展开所有列')).toBeNull();
    expect(byTitle('锁定列宽')).not.toBeNull();
    await act(async () => click(byTitle('锁定列宽')!));
    expect(byTitle('解锁列宽')).not.toBeNull();

    for (const label of ['待规划', '队列', '进行中']) {
      await act(async () =>
        click(container.querySelector(`button[aria-label="折叠${label}"]`)!));
    }
    expect(byTitle('展开所有列')?.textContent).toContain('展开所有列');
    await act(async () => click(byTitle('展开所有列')!));
    expect(container.querySelector('button[aria-label="展开待规划"]')).toBeNull();
  });

  it('hides low-priority and low-impact badges (Autocode rule)', async () => {
    addTask('default', 'backlog', '低调任务', '', { priority: 'low', impact: 'low' });
    await render();
    expect(container.textContent).not.toContain('低影响');
    expect(container.textContent).not.toContain('优先级');
    expect(container.textContent).toContain('低调任务');
  });
});
