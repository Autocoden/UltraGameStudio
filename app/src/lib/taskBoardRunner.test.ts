import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTaskBoardForTests,
  addTask,
  getBoardTasks,
} from './taskBoard';
import {
  __resetRunnerForTests,
  getMaxParallel,
  pumpBoard,
  setMaxParallel,
  stopTask,
} from './taskBoardRunner';
import { cancelAiCli, tauriAvailable } from '@/lib/tauri';
import {
  completeGatewayText,
  resolveCliGatewayRoute,
} from '@/lib/modelGateway/modelGateway';

/**
 * Runner tests with the model gateway mocked: queued cards are picked up under
 * the parallel cap, each execution resolves the ACTIVE channel route (so the
 * run inherits the configured provider instead of raw CLI OAuth state), then
 * drives work → AI-audit status transitions and lands in human_review as
 * awaiting_human or failed.
 */

vi.mock('@/lib/tauri', () => ({
  tauriAvailable: vi.fn(() => true),
  cancelAiCli: vi.fn(async () => {}),
}));

vi.mock('@/lib/modelGateway/modelGateway', () => ({
  completeGatewayText: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

const ROUTE = {
  adapter: 'claude-code',
  model: 'sonnet',
  env: { ANTHROPIC_BASE_URL: 'https://relay.example' },
  cliCommand: 'claude',
} as never;

const CTX = { cwd: 'D:/ws', permission: 'full' };

const gatewayCallsForCard = (cardId: string) =>
  vi.mocked(completeGatewayText).mock.calls.filter(
    ([request]) => (request as { runId: string }).runId.includes(cardId),
  );

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  __resetTaskBoardForTests();
  __resetRunnerForTests();
  vi.mocked(completeGatewayText).mockReset();
  vi.mocked(resolveCliGatewayRoute).mockReset();
  vi.mocked(resolveCliGatewayRoute).mockResolvedValue(ROUTE);
  vi.mocked(completeGatewayText).mockResolvedValue('PASS: 已完成');
  vi.mocked(tauriAvailable).mockReturnValue(true);
  setMaxParallel(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('taskBoardRunner', () => {
  it('runs one queued task: work → audit → awaiting_human in human_review', async () => {
    const card = addTask('ws', 'queue', '生成主菜单 UI', '参考 3 个候选', { category: 'feature' })!;
    act(() => pumpBoard('ws', CTX));
    await settle();

    const stored = getBoardTasks('ws')[0];
    expect(stored.status).toBe('human_review');
    expect(stored.phase).toBe('awaiting_human');
    // two gateway calls: work + audit, both forced onto the CLI transport
    expect(gatewayCallsForCard(card.id)).toHaveLength(2);
    const [work, audit] = gatewayCallsForCard(card.id).map(([r]) => r) as [
      { system: string; userContent: string; cwd: string; forceCli: boolean; route: unknown },
      { system: string; userContent: string },
    ];
    expect(work.system).toContain('任务执行 agent');
    expect(work.userContent).toContain('生成主菜单 UI');
    expect(work.userContent).toContain('分类: 功能');
    expect(work.cwd).toBe('D:/ws');
    expect(work.forceCli).toBe(true);
    expect(work.route).toBe(ROUTE);
    expect(audit.system).toContain('验收审核员');
    expect(audit.userContent).toContain('报告');
  });

  it('respects the parallel cap', async () => {
    setMaxParallel(1);
    addTask('ws', 'queue', '任务一');
    addTask('ws', 'queue', '任务二');
    // hold the first work call open with a manual deferred
    let resolveWork!: (v: string) => void;
    vi.mocked(completeGatewayText).mockImplementationOnce(() => new Promise((r) => { resolveWork = r; }));
    act(() => pumpBoard('ws', CTX));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const byTitle = new Map(getBoardTasks('ws').map((c) => [c.title, c]));
    expect(byTitle.get('任务一')?.phase).toBe('executing');
    expect(byTitle.get('任务二')?.status).toBe('queue');
    expect(vi.mocked(completeGatewayText)).toHaveBeenCalledTimes(1);

    // finishing task one frees the slot; the queued card then runs through
    act(() => resolveWork('报告'));
    await settle();
    act(() => setMaxParallel(2));
    act(() => pumpBoard('ws', CTX));
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const titles = getBoardTasks('ws').map((c) => c.status);
    expect(titles.every((s) => s === 'human_review')).toBe(true);
  });

  it('failed audit lands in human_review with the failure reason', async () => {
    addTask('ws', 'queue', '未完成任务');
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce('我做了一半')
      .mockResolvedValueOnce('FAIL: 菜单文件不存在');
    act(() => pumpBoard('ws', CTX));
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stored = getBoardTasks('ws')[0];
    expect(stored.status).toBe('human_review');
    expect(stored.phase).toBe('failed');
    expect(stored.executionError).toBe('菜单文件不存在');
  });

  it('accepts a verbose audit whose PASS conclusion comes after narration', async () => {
    addTask('ws', 'queue', '正常任务');
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce('报告已生成。')
      .mockResolvedValueOnce(
        '所有抽查项全部吻合：端口表、Lua 计数与报告逐一相符。\n报告 Doc/项目分析报告.md 已存在且完整覆盖。\nPASS: 分析报告已存在且内容完整，任务已完成。',
      );
    act(() => pumpBoard('ws', CTX));
    await settle();
    const stored = getBoardTasks('ws')[0];
    expect(stored.status).toBe('human_review');
    expect(stored.phase).toBe('awaiting_human');
    expect(stored.executionError).toBeUndefined();
  });

  it('a later FAIL overrides an earlier PASS mention', async () => {
    addTask('ws', 'queue', '先扬后抑任务');
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce('部分通过。')
      .mockResolvedValueOnce('初看像 PASS，但复核发现入口函数缺失，结论 FAIL: 缺少入口。');
    act(() => pumpBoard('ws', CTX));
    await settle();
    const stored = getBoardTasks('ws')[0];
    expect(stored.phase).toBe('failed');
    expect(stored.executionError).toContain('缺少入口');
  });

  it('execution errors land in human_review as failed', async () => {
    addTask('ws', 'queue', '会抛错的任务');
    vi.mocked(completeGatewayText).mockRejectedValueOnce(new Error('cli boom'));
    act(() => pumpBoard('ws', CTX));
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stored = getBoardTasks('ws')[0];
    expect(stored.status).toBe('human_review');
    expect(stored.phase).toBe('failed');
    expect(stored.executionError).toContain('cli boom');
  });

  it('route resolution failures (e.g. expired auth) surface on the card', async () => {
    addTask('ws', 'queue', '鉴权失败任务');
    vi.mocked(resolveCliGatewayRoute).mockRejectedValueOnce(
      new Error('OAuth session expired and could not be refreshed'),
    );
    act(() => pumpBoard('ws', CTX));
    await settle();
    const stored = getBoardTasks('ws')[0];
    expect(stored.status).toBe('human_review');
    expect(stored.phase).toBe('failed');
    expect(stored.executionError).toContain('OAuth session expired');
  });

  it('stopTask cancels the run and marks the failure as manual', async () => {
    const card = addTask('ws', 'queue', '会被停止的任务')!;
    let rejectWork!: (e: Error) => void;
    vi.mocked(completeGatewayText).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectWork = reject; }),
    );
    act(() => pumpBoard('ws', CTX));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getBoardTasks('ws')[0].phase).toBe('executing');
    stopTask('ws', card.id);
    await act(async () => rejectWork(new Error('cancelled')));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stored = getBoardTasks('ws')[0];
    expect(stored.phase).toBe('failed');
    expect(stored.executionError).toBe('手动停止');
    expect(cancelAiCli).toHaveBeenCalledWith(`tbrun_ws_${card.id}`);
  });

  it('does nothing without a workspace or Tauri', () => {
    addTask('ws', 'queue', '不会执行');
    act(() => pumpBoard('ws', { cwd: '', permission: 'full' }));
    expect(vi.mocked(completeGatewayText)).not.toHaveBeenCalled();
    vi.mocked(tauriAvailable).mockReturnValue(false);
    act(() => pumpBoard('ws', CTX));
    expect(vi.mocked(completeGatewayText)).not.toHaveBeenCalled();
  });

  it('clamps the parallel setting and persists it', () => {
    act(() => setMaxParallel(99));
    expect(getMaxParallel()).toBe(4);
    act(() => setMaxParallel(0));
    expect(getMaxParallel()).toBe(1);
    act(() => setMaxParallel(3));
    expect(window.localStorage.getItem('ugs.taskboard.runner.v1')).toBe('3');
  });
});
