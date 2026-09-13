import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTaskBoardForTests,
  addTask,
  approveTask,
  archiveAllDone,
  archiveTask,
  restoreTask,
  boardKeyFor,
  composeTaskPrompt,
  getBoardTasks,
  moveTask,
  newTaskId,
  requeueTask,
  removeTask,
  setTaskPhase,
  subscribeTasks,
  updateTask,
  type TaskCard,
} from './taskBoard';

const KEY = 'ws-1';

function titlesOf(cards: TaskCard[]): string[] {
  return cards.map((c) => c.title);
}

beforeEach(() => {
  window.localStorage.clear();
  __resetTaskBoardForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('boardKeyFor', () => {
  it('falls back to the default board when the workspace id is blank', () => {
    expect(boardKeyFor(null)).toBe('default');
    expect(boardKeyFor('   ')).toBe('default');
    expect(boardKeyFor('ws-a')).toBe('ws-a');
  });
});

describe('addTask', () => {
  it('appends a card to the requested column and trims fields', () => {
    const card = addTask(KEY, 'backlog', '  生成主菜单 UI  ', ' 参考 3 个候选 ');
    expect(card).not.toBeNull();
    const cards = getBoardTasks(KEY);
    expect(titlesOf(cards)).toEqual(['生成主菜单 UI']);
    expect(cards[0].status).toBe('backlog');
    expect(cards[0].note).toBe('参考 3 个候选');
    expect(cards[0].completedAt).toBeUndefined();
  });

  it('rejects blank titles without mutating the board', () => {
    expect(addTask(KEY, 'backlog', '   ')).toBeNull();
    expect(getBoardTasks(KEY)).toHaveLength(0);
  });

  it('notifies subscribers on every successful mutation', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTasks(listener);
    addTask(KEY, 'in_progress', '任务 A');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    addTask(KEY, 'in_progress', '任务 B');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('task metadata', () => {
  it('creates a card with classification meta and persists it', () => {
    const card = addTask(KEY, 'backlog', '带元数据', '备注', {
      category: 'feature',
      priority: 'urgent',
      complexity: 'complex',
    })!;
    const stored = getBoardTasks(KEY)[0];
    expect(stored.category).toBe('feature');
    expect(stored.priority).toBe('urgent');
    expect(stored.complexity).toBe('complex');
    expect(stored.impact).toBeUndefined();
    expect(card.id).toBe(stored.id);
  });

  it('shallow-merges meta and clears fields on explicit undefined', () => {
    const card = addTask(KEY, 'backlog', '任务', '', { category: 'feature', priority: 'low' })!;
    expect(updateTask(KEY, card.id, { meta: { category: 'bug_fix', priority: undefined } })).toBe(true);
    const stored = getBoardTasks(KEY)[0];
    expect(stored.category).toBe('bug_fix');
    expect(stored.priority).toBeUndefined();
  });

  it('drops unknown meta values when loading from storage', () => {
    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 2,
        boards: {
          ws: [{ id: 'm', title: '脏元数据', status: 'backlog', category: 'hacked', priority: 'urgent' }],
        },
      }),
    );
    __resetTaskBoardForTests();
    const stored = getBoardTasks('ws')[0];
    expect(stored.category).toBeUndefined();
    expect(stored.priority).toBe('urgent');
  });
});

describe('updateTask / removeTask', () => {
  it('edits title and note', () => {
    const card = addTask(KEY, 'backlog', '旧标题', '旧备注')!;
    expect(updateTask(KEY, card.id, { title: ' 新标题 ', note: ' 新备注 ' })).toBe(true);
    const [updated] = getBoardTasks(KEY);
    expect(updated.title).toBe('新标题');
    expect(updated.note).toBe('新备注');
  });

  it('rejects blanking the title and unknown ids', () => {
    const card = addTask(KEY, 'backlog', '标题')!;
    expect(updateTask(KEY, card.id, { title: '  ' })).toBe(false);
    expect(updateTask(KEY, 'missing', { title: 'x' })).toBe(false);
    expect(getBoardTasks(KEY)[0].title).toBe('标题');
  });

  it('deletes the card', () => {
    const card = addTask(KEY, 'backlog', '待删除')!;
    expect(removeTask(KEY, card.id)).toBe(true);
    expect(getBoardTasks(KEY)).toHaveLength(0);
    expect(removeTask(KEY, card.id)).toBe(false);
  });
});

describe('moveTask', () => {
  it('moves the card to the end of the target column', () => {
    const a = addTask(KEY, 'backlog', 'A')!;
    const b = addTask(KEY, 'backlog', 'B')!;
    const c = addTask(KEY, 'in_progress', 'C')!;
    moveTask(KEY, a.id, 'in_progress');
    expect(getBoardTasks(KEY).filter((t) => t.status === 'in_progress').map((t) => t.title)).toEqual([
      'C',
      'A',
    ]);
    expect(getBoardTasks(KEY).filter((t) => t.status === 'backlog').map((t) => t.title)).toEqual([
      'B',
    ]);
    expect(b.status).toBe('backlog');
    expect(c.status).toBe('in_progress');
  });

  it('stamps completedAt entering done and clears it leaving done', () => {
    const card = addTask(KEY, 'backlog', '任务')!;
    moveTask(KEY, card.id, 'done');
    const done = getBoardTasks(KEY)[0];
    expect(done.status).toBe('done');
    expect(typeof done.completedAt).toBe('number');
    moveTask(KEY, card.id, 'in_progress');
    const doing = getBoardTasks(KEY)[0];
    expect(doing.completedAt).toBeUndefined();
  });

  it('is a no-op for the same status and unknown ids', () => {
    const card = addTask(KEY, 'in_progress', '任务')!;
    const before = getBoardTasks(KEY).map((c) => c.id);
    expect(moveTask(KEY, card.id, 'in_progress')).toBe(true);
    expect(moveTask(KEY, 'missing', 'backlog')).toBe(false);
    expect(getBoardTasks(KEY).map((c) => c.id)).toEqual(before);
  });
});

describe('archive', () => {
  it('archiveAllDone archives only un-archived done cards and keeps them in storage', () => {
    addTask(KEY, 'backlog', 'T1');
    addTask(KEY, 'backlog', 'T2');
    addTask(KEY, 'done', 'D1');
    const d2 = addTask(KEY, 'done', 'D2')!;
    archiveTask(KEY, d2.id);
    expect(archiveAllDone(KEY)).toBe(1);
    const done = getBoardTasks(KEY).filter((c) => c.status === 'done');
    expect(done).toHaveLength(2);
    expect(done.every((c) => c.archived)).toBe(true);
    expect(titlesOf(getBoardTasks(KEY).filter((c) => c.status === 'backlog'))).toEqual([
      'T1',
      'T2',
    ]);
    expect(archiveAllDone(KEY)).toBe(0);
  });

  it('archiveTask allows only done cards and restoreTask undoes it', () => {
    const done = addTask(KEY, 'done', 'D1')!;
    const doing = addTask(KEY, 'in_progress', 'X')!;
    expect(archiveTask(KEY, doing.id)).toBe(false);
    expect(archiveTask(KEY, done.id)).toBe(true);
    expect(archiveTask(KEY, done.id)).toBe(false);
    expect(getBoardTasks(KEY).find((c) => c.id === done.id)?.archived).toBe(true);
    expect(restoreTask(KEY, done.id)).toBe(true);
    expect(getBoardTasks(KEY).find((c) => c.id === done.id)?.archived).toBe(false);
    expect(restoreTask(KEY, done.id)).toBe(false);
  });

  it('persists the archived flag and drops non-boolean values', () => {
    const card = addTask(KEY, 'done', 'D1')!;
    archiveTask(KEY, card.id);
    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 2,
        boards: {
          ws: [
            { id: 'a', title: 'A', status: 'done', archived: true },
            { id: 'b', title: 'B', status: 'done', archived: 'yes' },
          ],
        },
      }),
    );
    __resetTaskBoardForTests();
    const byId = new Map(getBoardTasks('ws').map((c) => [c.id, c]));
    expect(byId.get('a')?.archived).toBe(true);
    expect(byId.get('b')?.archived).toBeUndefined();
  });
});

describe('persistence', () => {
  it('restores boards from localStorage', () => {
    addTask('ws-a', 'backlog', 'A 任务');
    addTask('ws-b', 'done', 'B 任务');
    const raw = JSON.parse(window.localStorage.getItem('ugs.taskboard.v1')!);
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.boards).sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('performs workspace isolation via board keys', () => {
    addTask('ws-a', 'backlog', 'A 任务');
    addTask('ws-b', 'backlog', 'B 任务');
    expect(titlesOf(getBoardTasks('ws-a'))).toEqual(['A 任务']);
    expect(titlesOf(getBoardTasks('ws-b'))).toEqual(['B 任务']);
  });

  it('falls back to an empty board on corrupted storage and keeps working', () => {
    window.localStorage.setItem('ugs.taskboard.v1', '{not json');
    __resetTaskBoardForTests();
    expect(getBoardTasks(KEY)).toHaveLength(0);
    const card = addTask(KEY, 'backlog', '恢复后新建');
    expect(titlesOf(getBoardTasks(KEY))).toEqual(['恢复后新建']);
    expect(card).not.toBeNull();
  });

  it('drops malformed rows when sanitizing stored boards', () => {
    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 2,
        boards: {
          ws: [
            { id: 'ok', title: '有效卡片', status: 'backlog' },
            { id: '', title: '缺 id' },
            { id: 'bad-status', title: 'x', status: 'nope' },
            { id: 'no-title', status: 'backlog' },
            'garbage',
          ],
        },
      }),
    );
    __resetTaskBoardForTests();
    const cards = getBoardTasks('ws');
    expect(titlesOf(cards)).toEqual(['有效卡片']);
    expect(cards[0].note).toBe('');
  });

  it('migrates v1 three-stage boards into the six-stage board without data loss', () => {
    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 1,
        boards: {
          ws: [
            { id: 'a', title: 'A', status: 'todo', createdAt: 1, updatedAt: 1 },
            { id: 'b', title: 'B', status: 'doing', createdAt: 1, updatedAt: 1 },
            { id: 'c', title: 'C', status: 'done', createdAt: 1, updatedAt: 1, completedAt: 5 },
          ],
        },
      }),
    );
    __resetTaskBoardForTests();
    const byId = new Map(getBoardTasks('ws').map((c) => [c.id, c]));
    expect(byId.size).toBe(3);
    expect(byId.get('a')?.status).toBe('backlog');
    expect(byId.get('b')?.status).toBe('in_progress');
    expect(byId.get('c')?.status).toBe('done');
    expect(byId.get('c')?.completedAt).toBe(5);
  });

  it('drops v2 rows carrying unknown statuses (only v1 rows migrate)', () => {
    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 2,
        boards: {
          ws: [{ id: 'x', title: '未知状态', status: 'todo', createdAt: 1, updatedAt: 1 }],
        },
      }),
    );
    __resetTaskBoardForTests();
    expect(getBoardTasks('ws')).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('mints unique ids', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newTaskId()));
    expect(seen.size).toBe(50);
  });

  it('composes the terminal prompt with an optional note block', () => {
    expect(composeTaskPrompt({ title: '生成主菜单 UI', note: ' 参考 3 个候选 ' })).toBe(
      '生成主菜单 UI\n\n参考 3 个候选',
    );
    expect(composeTaskPrompt({ title: '只读任务', note: '  ' })).toBe('只读任务');
  });

});

describe('execution lifecycle helpers', () => {
  it('approveTask moves the card to done and stamps the phase', () => {
    const card = addTask(KEY, 'human_review', '待验收', '', {})!;
    setTaskPhase(KEY, card.id, 'awaiting_human');
    expect(approveTask(KEY, card.id)).toBe(true);
    const stored = getBoardTasks(KEY)[0];
    expect(stored.status).toBe('done');
    expect(stored.phase).toBe('complete');
  });

  it('requeueTask sends the card back to the queue and clears failure info', () => {
    const card = addTask(KEY, 'human_review', '失败任务')!;
    setTaskPhase(KEY, card.id, 'failed', 'AI 审核未通过');
    expect(requeueTask(KEY, card.id)).toBe(true);
    const stored = getBoardTasks(KEY)[0];
    expect(stored.status).toBe('queue');
    expect(stored.phase).toBe('idle');
    expect(stored.executionError).toBeUndefined();
  });

  it('persists phase and executionError, dropping invalid phases', () => {
    const card = addTask(KEY, 'in_progress', '执行中')!;
    setTaskPhase(KEY, card.id, 'executing');
    expect(getBoardTasks(KEY)[0].phase).toBe('executing');
    setTaskPhase(KEY, card.id, 'failed', 'boom');
    expect(getBoardTasks(KEY)[0].executionError).toBe('boom');

    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 2,
        boards: { ws: [{ id: 'p', title: '坏阶段', status: 'queue', phase: 'nope' }] },
      }),
    );
    __resetTaskBoardForTests();
    expect(getBoardTasks('ws')[0].phase).toBeUndefined();
  });

  it('recovers stale executing/reviewing cards to the queue on load', () => {
    window.localStorage.setItem(
      'ugs.taskboard.v1',
      JSON.stringify({
        version: 2,
        boards: {
          ws: [
            { id: 'r1', title: '中断执行', status: 'in_progress', phase: 'executing' },
            { id: 'r2', title: '中断审核', status: 'ai_review', phase: 'reviewing' },
            { id: 'r3', title: '不受影响', status: 'queue', phase: 'idle' },
          ],
        },
      }),
    );
    __resetTaskBoardForTests();
    const byId = new Map(getBoardTasks('ws').map((c) => [c.id, c]));
    expect(byId.get('r1')?.status).toBe('queue');
    expect(byId.get('r1')?.phase).toBe('idle');
    expect(byId.get('r2')?.status).toBe('queue');
    expect(byId.get('r2')?.phase).toBe('idle');
    expect(byId.get('r3')?.status).toBe('queue');
  });
});
