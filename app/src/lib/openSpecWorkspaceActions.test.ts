import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeGatewayTextMock,
  resolveCliGatewayRouteMock,
  cancelAiCliMock,
  ensureWorkspaceChangesBaselineMock,
  listWorkspaceChangesMock,
  previewLocalFileMock,
  steerAiCliMock,
} = vi.hoisted(() => ({
  completeGatewayTextMock: vi.fn(),
  resolveCliGatewayRouteMock: vi.fn(),
  cancelAiCliMock: vi.fn(),
  ensureWorkspaceChangesBaselineMock: vi.fn(),
  listWorkspaceChangesMock: vi.fn(),
  previewLocalFileMock: vi.fn(),
  steerAiCliMock: vi.fn(),
}));

vi.mock("@/lib/modelGateway/modelGateway", () => ({
  completeGatewayText: completeGatewayTextMock,
  resolveCliGatewayRoute: resolveCliGatewayRouteMock,
}));

vi.mock("@/lib/gatewayConfig", () => ({
  getDefaultGatewaySelection: () => ({
    adapter: "codex",
    modelClass: "default",
  }),
  getExplicitActiveGatewaySelection: () => null,
}));

vi.mock("@/lib/tauri", () => ({
  getOpenSpecChangeStatus: vi.fn(),
  validateOpenSpecChange: vi.fn(),
  cancelAiCli: cancelAiCliMock,
  ensureWorkspaceChangesBaseline: ensureWorkspaceChangesBaselineMock,
  listWorkspaceChanges: listWorkspaceChangesMock,
  previewLocalFile: previewLocalFileMock,
  steerAiCli: steerAiCliMock,
}));

import {
  __resetOpenSpecActionsForTests,
  acknowledgeOpenSpecPlanningReview,
  buildOpenSpecActionPrompt,
  getOpenSpecActionSnapshot,
  resolveOpenSpecAutomaticAction,
  runOpenSpecWorkspaceAction,
} from "./openSpecWorkspaceActions";
import { getOpenSpecChangeStatus, validateOpenSpecChange } from "@/lib/tauri";
import {
  __resetTaskBoardForTests,
  addTask,
  getBoardTasks,
} from "./taskBoard";

const BOARD_KEY = "openspec-test";

beforeEach(() => {
  vi.mocked(getOpenSpecChangeStatus).mockReset().mockResolvedValue({ success: true, timedOut: false, stdout: "", stderr: "", json: { isComplete: true, artifacts: [] } });
  vi.mocked(validateOpenSpecChange).mockReset().mockResolvedValue({ success: true, timedOut: false, stdout: "", stderr: "" });
  window.localStorage.clear();
  __resetTaskBoardForTests();
  __resetOpenSpecActionsForTests();
  completeGatewayTextMock.mockReset();
  resolveCliGatewayRouteMock.mockReset();
  cancelAiCliMock.mockReset();
  ensureWorkspaceChangesBaselineMock.mockReset();
  listWorkspaceChangesMock.mockReset();
  previewLocalFileMock.mockReset();
  steerAiCliMock.mockReset();
  resolveCliGatewayRouteMock.mockResolvedValue({
    transport: "cli",
    adapter: "codex",
    model: "gpt-test",
  });
  previewLocalFileMock.mockResolvedValue({
    text: "- [x] 已完成\n- [ ] 待完成",
  });
  ensureWorkspaceChangesBaselineMock.mockResolvedValue({});
  listWorkspaceChangesMock.mockResolvedValue({
    rootPath: "D:/project",
    generatedAtMs: Date.now(),
    files: [],
    truncated: false,
  });
});

describe("OpenSpec workspace actions", () => {
  it("continues through all four artifacts before waiting for human approval", async () => {
    const card = addTask(BOARD_KEY, "backlog", "Four artifacts", "", { developmentMode: "spec", openSpecChange: "four" })!;
    completeGatewayTextMock.mockResolvedValue("one artifact generated");
    const response = (count: number) => ({ success: true, timedOut: false, stdout: "", stderr: "", json: {
      isComplete: true, artifacts: ["proposal", "specs", "design", "tasks"].map((id, index) => ({ id, status: index < count ? "done" : "ready" })),
    } });
    vi.mocked(getOpenSpecChangeStatus).mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(3)).mockResolvedValueOnce(response(4));
    await runOpenSpecWorkspaceAction({ boardKey: BOARD_KEY, cwd: "D:/project", card, action: "new" });
    expect(completeGatewayTextMock).toHaveBeenCalledTimes(4);
    expect(validateOpenSpecChange).toHaveBeenCalledOnce();
    expect(getBoardTasks(BOARD_KEY)[0]).toMatchObject({ status: "human_review", phase: "awaiting_human", planApproved: false });
    expect(completeGatewayTextMock.mock.calls.every(([request]) => request.system.includes("不实现产品代码"))).toBe(true);
  });

  it("does not report planning success when artifact generation makes no progress", async () => {
    const card = addTask(BOARD_KEY, "backlog", "Stalled", "", { developmentMode: "spec", openSpecChange: "stalled" })!;
    completeGatewayTextMock.mockResolvedValue("done");
    vi.mocked(getOpenSpecChangeStatus).mockResolvedValue({ success: true, timedOut: false, stdout: "", stderr: "", json: { artifacts: [{ id: "tasks", status: "ready" }] } });
    await expect(runOpenSpecWorkspaceAction({ boardKey: BOARD_KEY, cwd: "D:/project", card, action: "new" })).rejects.toThrow("未补齐");
    expect(getOpenSpecActionSnapshot(BOARD_KEY, card.id).history.at(-1)?.state).toBe("failed");
    expect(validateOpenSpecChange).not.toHaveBeenCalled();
  });
  it("builds action-specific prompts with the selected change and guidance", () => {
    const prompt = buildOpenSpecActionPrompt({
      action: "update",
      card: {
        title: "更新战斗系统",
        note: "补齐连招约束",
        openSpecChange: "combat-combos",
        openSpecSchema: "spec-driven",
      },
      arguments: "增加取消窗口",
      status: {
        isPlanningComplete: false,
        isComplete: false,
        artifacts: [{ status: "ready" }],
      },
    });

    expect(prompt.system).toContain("修订当前变更的规划工件");
    expect(prompt.userContent).toContain("combat-combos");
    expect(prompt.userContent).toContain("增加取消窗口");
  });

  it("chooses the next action from planning and implementation progress", () => {
    expect(resolveOpenSpecAutomaticAction(null)).toBe("new");
    expect(
      resolveOpenSpecAutomaticAction({
        isPlanningComplete: false,
        isComplete: false,
        artifacts: [{ status: "done" }],
      }),
    ).toBe("update");
    expect(
      resolveOpenSpecAutomaticAction(
        {
          isPlanningComplete: true,
          isComplete: false,
          artifacts: [],
        },
        [{ status: "pending" }],
      ),
    ).toBe("apply");
    expect(
      resolveOpenSpecAutomaticAction(
        {
          isPlanningComplete: true,
          isComplete: true,
          artifacts: [],
        },
        [{ status: "completed" }],
      ),
    ).toBe("verify");
  });

  it("streams an action, records its history, and synchronizes tasks.md", async () => {
    const card = addTask(
      BOARD_KEY,
      "backlog",
      "OpenSpec task",
      "Implement it",
      {
        developmentMode: "spec",
        openSpecChange: "combat-combos",
      },
    )!;
    completeGatewayTextMock.mockImplementation(async (request) => {
      request.onDelta?.("first");
      request.onDelta?.(" second");
      request.onUsage?.({ totalTokens: 12 });
      return "finished";
    });

    await runOpenSpecWorkspaceAction({
      boardKey: BOARD_KEY,
      cwd: "D:/project",
      card,
      action: "apply",
      status: {
        isPlanningComplete: true,
        isComplete: false,
        artifacts: [],
      },
    });

    const runtime = getOpenSpecActionSnapshot(BOARD_KEY, card.id);
    expect(runtime.activeRun).toBeNull();
    expect(runtime.history.at(-1)).toMatchObject({
      action: "apply",
      state: "succeeded",
    });
    expect(runtime.history.at(-1)?.output).toContain("first second");
    const restored = getBoardTasks(BOARD_KEY).find(
      (candidate) => candidate.id === card.id,
    )!;
    expect(restored.subtasks).toEqual([
      expect.objectContaining({ title: "已完成", status: "completed" }),
      expect.objectContaining({ title: "待完成", status: "pending" }),
    ]);
    expect(restored.runs?.at(-1)).toMatchObject({
      subtaskTitle: "OpenSpec · 执行实施",
      totalTokens: 12,
    });
  });

  it("captures planning diffs and gates implementation until review", async () => {
    const card = addTask(
      BOARD_KEY,
      "backlog",
      "Review planning changes",
      "Inspect the proposal diff",
      {
        developmentMode: "spec",
        openSpecChange: "planning-review",
      },
    )!;
    completeGatewayTextMock.mockResolvedValue("done");
    listWorkspaceChangesMock.mockResolvedValue({
      rootPath: "D:/project",
      generatedAtMs: Date.now(),
      truncated: false,
      files: [
        {
          path: "openspec/changes/planning-review/proposal.md",
          status: "modified",
          binary: false,
          truncated: false,
          lines: [
            {
              kind: "added",
              oldLine: null,
              newLine: 1,
              content: "# Updated proposal",
            },
          ],
        },
        {
          path: "src/unrelated.ts",
          status: "modified",
          binary: false,
          truncated: false,
          lines: [],
        },
      ],
    });

    await runOpenSpecWorkspaceAction({
      boardKey: BOARD_KEY,
      cwd: "D:/project",
      card,
      action: "update",
    });

    expect(
      getOpenSpecActionSnapshot(BOARD_KEY, card.id).planningReview,
    ).toMatchObject({
      action: "update",
      acknowledged: false,
      files: [{ path: "openspec/changes/planning-review/proposal.md" }],
    });
    await expect(
      runOpenSpecWorkspaceAction({
        boardKey: BOARD_KEY,
        cwd: "D:/project",
        card,
        action: "apply",
      }),
    ).rejects.toThrow(/审阅/);

    acknowledgeOpenSpecPlanningReview(BOARD_KEY, card.id);
    await expect(
      runOpenSpecWorkspaceAction({
        boardKey: BOARD_KEY,
        cwd: "D:/project",
        card,
        action: "apply",
      }),
    ).resolves.toMatchObject({ state: "succeeded" });
  });
});
