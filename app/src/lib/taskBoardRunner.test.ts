import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTaskBoardForTests,
  addTask,
  getBoardTasks,
  approveTask,
  updateTask,
  updateTaskExecution,
  requeueTask,
} from "./taskBoard";
import { __resetOpenSpecActionsForTests, runOpenSpecWorkspaceAction } from "./openSpecWorkspaceActions";
import { getTaskExecution } from "./taskExecution";
import {
  __resetRunnerForTests,
  getMaxParallel,
  getRunnerSnapshot,
  getTaskStream,
  parseTaskNeedsInput,
  standardPlanSubtasks,
  pumpBoard,
  setMaxParallel,
  steerTask,
  stopTask,
} from "./taskBoardRunner";
import {
  cancelAiCli,
  ensureWorkspaceChangesBaseline,
  getOpenSpecChangeStatus,
  prepareOpenSpecChange,
  pushWorkspaceBranch,
  previewLocalFile,
  setOpenSpecTaskStatus,
  steerAiCli,
  syncTaskArtifactFiles,
  tauriAvailable,
  validateOpenSpecChange,
} from "@/lib/tauri";
import {
  completeGatewayText,
  resolveCliGatewayRoute,
} from "@/lib/modelGateway/modelGateway";
import {
  ACTIVE_GATEWAY_SELECTION_STORAGE,
  GATEWAY_CONFIG_STORAGE,
} from "./gatewayConfig";

/**
 * Runner tests with the model gateway mocked: queued cards are picked up under
 * the parallel cap, each execution resolves the ACTIVE channel route (so the
 * run inherits the configured provider instead of raw CLI OAuth state), then
 * drives work → AI-audit status transitions and lands in human_review as
 * awaiting_human or failed.
 */

vi.mock("@/lib/tauri", () => ({
  syncTaskArtifactFiles: vi.fn(async () => ({ rootPath: "D:/ws/.ultragamestudio/tasks/test", filesWritten: 6 })),
  tauriAvailable: vi.fn(() => true),
  cancelAiCli: vi.fn(async () => {}),
  steerAiCli: vi.fn(async () => true),
  ensureWorkspaceChangesBaseline: vi.fn(async () => ({})),
  prepareIsolatedWorkspace: vi.fn(async () => ({
    path: "D:/isolated",
    kind: "worktree",
  })),
  pushWorkspaceBranch: vi.fn(async () => "ow/session-task"),
  prepareOpenSpecChange: vi.fn(async () => ({
    runtime: { available: true, version: "1.13.0" },
    initialized: false,
    created: true,
    status: {
      success: true,
      timedOut: false,
      stdout: "",
      stderr: "",
      json: { isComplete: true, artifacts: [] },
    },
  })),
  getOpenSpecChangeStatus: vi.fn(async () => ({
    success: true,
    timedOut: false,
    stdout: "",
    stderr: "",
    json: { isComplete: true, artifacts: [] },
  })),
  validateOpenSpecChange: vi.fn(async () => ({
    success: true,
    timedOut: false,
    stdout: "",
    stderr: "",
  })),
  previewLocalFile: vi.fn(async () => ({
    text: "- [ ] 1.1 Implement feature\n- [ ] 1.2 Add verification",
  })),
  setOpenSpecTaskStatus: vi.fn(async (_rootPath, _changeId, taskIndex) =>
    taskIndex === 0 ? "1.1 Implement feature" : "1.2 Add verification",
  ),
}));

vi.mock("@/lib/modelGateway/modelGateway", () => ({
  completeGatewayText: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

const ROUTE = {
  adapter: "claude-code",
  model: "sonnet",
  env: { ANTHROPIC_BASE_URL: "https://relay.example" },
  cliCommand: "claude",
} as never;

const CTX = { cwd: "D:/ws", permission: "full" };

const gatewayCallsForCard = (cardId: string) =>
  vi
    .mocked(completeGatewayText)
    .mock.calls.filter(([request]) =>
      (request as { runId: string }).runId.includes(cardId),
    );

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.mocked(syncTaskArtifactFiles).mockClear();
  vi.mocked(pushWorkspaceBranch).mockClear();
  window.localStorage.clear();
  __resetTaskBoardForTests();
  __resetRunnerForTests();
  __resetOpenSpecActionsForTests();
  vi.mocked(completeGatewayText).mockReset();
  vi.mocked(resolveCliGatewayRoute).mockReset();
  vi.mocked(resolveCliGatewayRoute).mockResolvedValue(ROUTE);
  vi.mocked(completeGatewayText).mockResolvedValue("PASS: 已完成");
  vi.mocked(tauriAvailable).mockReturnValue(true);
  vi.mocked(steerAiCli).mockReset();
  vi.mocked(steerAiCli).mockResolvedValue(true);
  vi.mocked(prepareOpenSpecChange).mockClear();
  vi.mocked(getOpenSpecChangeStatus).mockClear();
  vi.mocked(validateOpenSpecChange).mockClear();
  vi.mocked(previewLocalFile).mockClear();
  vi.mocked(setOpenSpecTaskStatus).mockClear();
  setMaxParallel(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("taskBoardRunner", () => {
  it("does not launch a model after a stop during artifact persistence", async () => {
    const card = addTask("ws", "queue", "Cancel persistence", "", { developmentMode: "direct" })!;
    let resume!: (value: Awaited<ReturnType<typeof syncTaskArtifactFiles>>) => void;
    vi.mocked(syncTaskArtifactFiles).mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    pumpBoard("ws", CTX);
    await vi.waitFor(() => expect(syncTaskArtifactFiles).toHaveBeenCalledOnce());
    stopTask("ws", card.id);
    expect(getTaskExecution("ws", card.id)).not.toBeNull();
    resume({ rootPath: "D:/ws/task", filesWritten: 6 });
    await settle();
    expect(completeGatewayText).not.toHaveBeenCalled();
    expect(getBoardTasks("ws")[0]).toMatchObject({ phase: "failed", executionError: "手动停止" });
    expect(getTaskExecution("ws", card.id)).toBeNull();
  });

  it("does not push or complete a task stopped while persisting the model result", async () => {
    const card = addTask("ws", "queue", "Cancel result persistence", "", {
      developmentMode: "direct", useWorktree: true, pushNewBranches: true,
    })!;
    const artifacts = { rootPath: "D:/ws/task", filesWritten: 6 };
    let resume!: (value: Awaited<ReturnType<typeof syncTaskArtifactFiles>>) => void;
    vi.mocked(syncTaskArtifactFiles).mockResolvedValueOnce(artifacts)
      .mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    pumpBoard("ws", CTX);
    await vi.waitFor(() => expect(syncTaskArtifactFiles).toHaveBeenCalledTimes(2));
    expect(completeGatewayText).toHaveBeenCalledOnce();
    stopTask("ws", card.id);
    resume(artifacts);
    await settle();
    expect(pushWorkspaceBranch).not.toHaveBeenCalled();
    expect(getBoardTasks("ws")[0]).toMatchObject({
      status: "human_review", phase: "failed", executionError: "手动停止",
    });
    expect(getBoardTasks("ws")[0].runs).toHaveLength(1);
    expect(getTaskExecution("ws", card.id)).toBeNull();
  });

  it("does not push after a stop while persisting a completed subtask", async () => {
    const card = addTask("ws", "queue", "Cancel subtask persistence", "", {
      developmentMode: "spec", openSpecChange: "cancel-subtask", useWorktree: true, pushNewBranches: true,
    })!;
    updateTaskExecution("ws", card.id, { plan: "- [ ] Implement", planApproved: true });
    vi.mocked(previewLocalFile).mockResolvedValueOnce({ text: "- [ ] Implement" } as Awaited<ReturnType<typeof previewLocalFile>>);
    const artifacts = { rootPath: "D:/ws/task", filesWritten: 6 };
    let resume!: (value: Awaited<ReturnType<typeof syncTaskArtifactFiles>>) => void;
    vi.mocked(syncTaskArtifactFiles).mockResolvedValueOnce(artifacts).mockResolvedValueOnce(artifacts)
      .mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    pumpBoard("ws", CTX);
    await vi.waitFor(() => expect(syncTaskArtifactFiles).toHaveBeenCalledTimes(3));
    stopTask("ws", card.id);
    resume(artifacts);
    await settle();
    expect(pushWorkspaceBranch).not.toHaveBeenCalled();
    expect(completeGatewayText).toHaveBeenCalledOnce();
    expect(getBoardTasks("ws")[0]).toMatchObject({ phase: "failed", executionError: "手动停止" });
  });

  it("does not enter plan approval after a stop while reading OpenSpec tasks", async () => {
    const card = addTask("ws", "queue", "Cancel task read", "", {
      developmentMode: "spec", openSpecChange: "cancel-read",
    })!;
    updateTaskExecution("ws", card.id, { plan: "- [ ] Implement", planApproved: false });
    let resume!: (value: Awaited<ReturnType<typeof previewLocalFile>>) => void;
    vi.mocked(previewLocalFile).mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    pumpBoard("ws", CTX);
    await vi.waitFor(() => expect(previewLocalFile).toHaveBeenCalledOnce());
    stopTask("ws", card.id);
    resume({ text: "- [ ] Implement" } as Awaited<ReturnType<typeof previewLocalFile>>);
    await settle();
    expect(completeGatewayText).not.toHaveBeenCalled();
    expect(getBoardTasks("ws")[0]).toMatchObject({ phase: "failed", executionError: "手动停止" });
  });

  it("waits for a manual action and then automatically resumes the queued card", async () => {
    const card = addTask("ws", "backlog", "Shared task", "", { developmentMode: "direct", openSpecChange: "shared" })!;
    let finish!: (text: string) => void;
    vi.mocked(completeGatewayText).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const manual = runOpenSpecWorkspaceAction({ boardKey: "ws", cwd: CTX.cwd, card, action: "apply" });
    await vi.waitFor(() => expect(completeGatewayText).toHaveBeenCalledOnce());
    requeueTask("ws", card.id);
    pumpBoard("ws", CTX);
    await settle();
    expect(completeGatewayText).toHaveBeenCalledOnce();
    expect(getBoardTasks("ws")[0].status).toBe("queue");
    finish("manual complete");
    await manual;
    await settle();
    expect(completeGatewayText).toHaveBeenCalledTimes(2);
    expect(getBoardTasks("ws")[0].status).toBe("human_review");
    expect(getTaskExecution("ws", card.id)).toBeNull();
  });

  it("rejects manual actions while the runner is preparing or stopping, and permits a later retry", async () => {
    const card = addTask("ws", "queue", "Runner first", "", { developmentMode: "direct", openSpecChange: "runner-first" })!;
    let finish!: (text: string) => void;
    vi.mocked(completeGatewayText).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    pumpBoard("ws", CTX);
    const manualInput = { boardKey: "ws", cwd: CTX.cwd, card, action: "apply" as const };
    await expect(runOpenSpecWorkspaceAction(manualInput)).rejects.toThrow("已有动作正在执行");
    await vi.waitFor(() => expect(completeGatewayText).toHaveBeenCalledOnce());
    stopTask("ws", card.id);
    expect(vi.mocked(completeGatewayText).mock.calls[0][0]).toMatchObject({ signal: expect.objectContaining({ aborted: true }), waitForExitOnAbort: true });
    await expect(runOpenSpecWorkspaceAction(manualInput)).rejects.toThrow("已有动作正在执行");
    expect(completeGatewayText).toHaveBeenCalledOnce();
    finish("native exited");
    await settle();
    await expect(runOpenSpecWorkspaceAction(manualInput)).resolves.toMatchObject({ state: "succeeded" });
    expect(completeGatewayText).toHaveBeenCalledTimes(2);
  });

  it("persists compatible documents before approval and blocks coding on write failures", async () => {
    const plan = "## Requirements\nR1\n## Spec\nSCN-001\n## Design\nDES-001\n## Tasks\n- [ ] 1.1 Work";
    vi.mocked(completeGatewayText).mockResolvedValueOnce(plan);
    vi.mocked(syncTaskArtifactFiles).mockImplementation(async (_root, _id, files) => {
      if (files.some(file => file.name === "tasks.md")) throw new Error("disk full");
      return { rootPath: "D:/ws/task", filesWritten: files.length };
    });
    const card = addTask("ws", "queue", "Write failure", "Task", { developmentMode: "standard" })!;
    pumpBoard("ws", CTX);
    await settle();
    expect(getBoardTasks("ws")[0]).toMatchObject({ phase: "failed", executionError: expect.stringContaining("disk full") });
    expect(gatewayCallsForCard(card.id)).toHaveLength(1);
    vi.mocked(syncTaskArtifactFiles).mockResolvedValue({ rootPath: "D:/ws/task", filesWritten: 6 });
  });
  it("parses task sections without scheduling reasoning or unrelated numbered lists", () => {
    expect(standardPlanSubtasks("id", "<think>- [ ] Private draft</think>\n1. Finding")).toEqual([]);
    expect(standardPlanSubtasks("id", "## Requirements\n1. Goal\n## Tasks\n\n1. Write report\n2. Verify report\n\n## Risks\n1. Risk").map(x => x.title))
      .toEqual(["Write report", "Verify report"]);
    expect(standardPlanSubtasks("id", "## Tasks\n\n+ [ ] Write report\n- [x] Verify report").map(x => x.status))
      .toEqual(["pending", "pending"]);
  });

  it("repairs a planning summary once before executing Standard work", async () => {
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce("Research complete. The plan will be submitted through ExitPlanMode.")
      .mockResolvedValueOnce("## Requirements\nDeliver analysis\n## Spec\nSHALL provide evidence\n## Design\nInspect sources\n## Tasks\n- [ ] Write the requested analysis report");
    const card = addTask("ws", "queue", "Analysis", "Deliver a report", {
      developmentMode: "standard", requireReviewBeforeCoding: true,
    })!;
    pumpBoard("ws", CTX);
    await settle();
    expect(gatewayCallsForCard(card.id)).toHaveLength(2);
    expect(getBoardTasks("ws")[0]).toMatchObject({
      phase: "awaiting_human", subtasks: [{ title: "Write the requested analysis report" }],
    });
    expect(prepareOpenSpecChange).not.toHaveBeenCalled();
  });

  it("stops before coding if both planning responses lack tasks", async () => {
    const card = addTask("ws", "queue", "Analysis", "Deliver a report", {
      developmentMode: "standard",
    })!;
    pumpBoard("ws", CTX);
    await settle();
    expect(gatewayCallsForCard(card.id)).toHaveLength(2);
    expect(getBoardTasks("ws")[0].phase).toBe("failed");
    expect(gatewayCallsForCard(card.id).every(([request]) => request.permission === "readonly")).toBe(true);
  });

  it("parses structured and Markdown planning blockers", () => {
    const parsed = parseTaskNeedsInput(
      [
        "<<UGS_NEEDS_INPUT>>",
        '{"message":"选择数据源","decisions":[{"id":"Q1","question":"使用哪个数据源？","options":[{"id":"A","label":"本地文件","recommended":true},{"id":"B","label":"远程 API","recommended":false}]}]}',
        "<<UGS_NEEDS_INPUT_END>>",
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      blocked: true,
      message: "选择数据源",
      decisions: [
        {
          id: "Q1",
          question: "使用哪个数据源？",
        },
      ],
    });
    expect(parsed?.decisions[0].options).toEqual([
      { id: "A", label: "本地文件", recommended: true },
      { id: "B", label: "远程 API", recommended: false },
    ]);
    expect(
      parseTaskNeedsInput(
        "- [BLOCKS-IMPLEMENTATION] 是否允许覆盖现有配置？",
      )?.questions,
    ).toEqual(["是否允许覆盖现有配置？"]);
  });

  it("pauses planning when the model returns structured questions", async () => {
    vi.mocked(completeGatewayText).mockResolvedValueOnce(
      [
        "<<UGS_NEEDS_INPUT>>",
        '{"message":"需要确认存储方式","decisions":[{"id":"Q1","question":"选择哪种存储？","options":[{"id":"A","label":"SQLite","recommended":true},{"id":"B","label":"JSON","recommended":false}]}]}',
        "<<UGS_NEEDS_INPUT_END>>",
      ].join("\n"),
    );
    const card = addTask("ws", "queue", "需要决策", "设计存储层", {
      developmentMode: "standard",
      requireReviewBeforeCoding: true,
    })!;

    pumpBoard("ws", CTX);
    await settle();

    const stored = getBoardTasks("ws")[0];
    expect(gatewayCallsForCard(card.id)).toHaveLength(1);
    expect(gatewayCallsForCard(card.id)[0][0].system).toContain(
      "<<UGS_NEEDS_INPUT>>",
    );
    expect(stored).toMatchObject({
      status: "human_review",
      phase: "awaiting_human",
      needsInput: {
        blocked: true,
        message: "需要确认存储方式",
        decisions: [{ id: "Q1", question: "选择哪种存储？" }],
      },
    });
    expect(stored.plan).toBeUndefined();
  });

  it("publishes a distinct Standard planning phase before coding", async () => {
    let planningDelta: ((chunk: string) => void) | undefined;
    let resolvePlanning!: (value: string) => void;
    vi.mocked(completeGatewayText).mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          planningDelta = request.onDelta;
          resolvePlanning = resolve;
        }),
    );
    const card = addTask("ws", "queue", "标准计划阶段", "先计划再执行", {
      developmentMode: "standard",
      requireReviewBeforeCoding: true,
    })!;

    act(() => pumpBoard("ws", CTX));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getBoardTasks("ws")[0]).toMatchObject({
      status: "in_progress",
      phase: "planning",
    });
    expect(getTaskStream("ws", card.id)).toMatchObject({
      phase: "planning",
      text: "",
    });
    act(() => planningDelta?.("正在制定实施计划"));
    expect(getTaskStream("ws", card.id)?.text).toBe("正在制定实施计划");

    await act(async () => resolvePlanning("## Requirements\n实现功能\n## Spec\nSHALL 满足需求\n## Design\n复用组件\n## Tasks\n- [ ] 实现功能\n- [ ] 验证功能"));
    await settle();
    expect(getBoardTasks("ws")[0]).toMatchObject({
      status: "human_review",
      phase: "awaiting_human",
    });
    expect(getBoardTasks("ws")[0].runs?.[0].phase).toBe("planning");
  });

  it("approves and resumes the Standard custom plan without calling OpenSpec", async () => {
    vi.mocked(completeGatewayText).mockResolvedValueOnce(
      "## Requirements\n实现菜单\n## Spec\nSHALL 显示菜单\n## Design\n使用现有组件\n## Tasks\n- [ ] 实现菜单\n- [ ] 验证菜单",
    );
    const card = addTask("ws", "queue", "菜单", "实现菜单", {
      developmentMode: "standard",
      requireReviewBeforeCoding: true,
      agentProfile: "balanced",
      phaseThinking: {
        spec: "low",
        planning: "medium",
        coding: "high",
        qa: "xhigh",
      },
    })!;
    pumpBoard("ws", CTX);
    await settle();
    expect(gatewayCallsForCard(card.id)).toHaveLength(1);
    expect(gatewayCallsForCard(card.id)[0][0].permission).toBe("readonly");
    expect(gatewayCallsForCard(card.id)[0][0].system).toContain(
      "UGS 自定义流程",
    );
    expect(prepareOpenSpecChange).not.toHaveBeenCalled();
    expect(getBoardTasks("ws")[0]).toMatchObject({
      status: "human_review",
      phase: "awaiting_human",
      subtasks: [{ title: "实现菜单" }, { title: "验证菜单" }],
    });
    expect(getBoardTasks("ws")[0].openSpecChange).toBeUndefined();
    // Older UGS builds incorrectly assigned official change metadata to Standard.
    updateTask("ws", card.id, { meta: { openSpecChange: "legacy-standard-change" } });
    approveTask("ws", card.id);
    expect(getBoardTasks("ws")[0]).toMatchObject({
      status: "queue",
      planApproved: true,
    });
    pumpBoard("ws", CTX);
    await settle();
    expect(gatewayCallsForCard(card.id)).toHaveLength(4);
    expect(
      gatewayCallsForCard(card.id).map(([request]) => request.thinkingLevel),
    ).toEqual(["medium", "high", "high", "xhigh"]);
    expect(getBoardTasks("ws")[0].runs?.map((run) => run.phase)).toEqual([
      "planning",
      "executing",
      "executing",
      "reviewing",
    ]);
    expect(
      getBoardTasks("ws")[0].subtasks?.every(
        (subtask) => subtask.status === "completed",
      ),
    ).toBe(true);
    expect(setOpenSpecTaskStatus).not.toHaveBeenCalled();
    expect(getOpenSpecChangeStatus).not.toHaveBeenCalled();
    expect(previewLocalFile).not.toHaveBeenCalled();
    expect(validateOpenSpecChange).not.toHaveBeenCalled();
  });

  it("executes direct tasks in their isolated workspace with a baseline and no QA call", async () => {
    const card = addTask("ws", "queue", "直连", "实现菜单", {
      developmentMode: "direct",
      useWorktree: true,
      agentProfile: "custom",
      model: "task-model",
    })!;
    pumpBoard("ws", CTX);
    await settle();
    expect(gatewayCallsForCard(card.id)).toHaveLength(1);
    expect(gatewayCallsForCard(card.id)[0][0]).toMatchObject({
      cwd: "D:/isolated",
      route: { model: "task-model" },
    });
    expect(ensureWorkspaceChangesBaseline).toHaveBeenCalledWith(
      "D:/isolated",
      `board-${card.id}`,
    );
    expect(getBoardTasks("ws")[0]).toMatchObject({
      executionCwd: "D:/isolated",
      status: "human_review",
    });
  });

  it("prepares and validates an OpenSpec change, then executes tasks.md items", async () => {
    const card = addTask(
      "ws",
      "queue",
      "OpenSpec task",
      "Implement from the official artifacts",
      {
        developmentMode: "spec",
        openSpecChange: "official-change",
        openSpecSchema: "spec-driven",
        agentProfile: "complex",
        phaseThinking: {
          spec: "xhigh",
          planning: "medium",
          coding: "high",
          qa: "low",
        },
        specModelSelection: {
          adapter: "codex",
          modelClass: "opus",
          providerId: "provider-spec",
          channelId: "channel-spec",
          modelOverride: "gpt-5.6-sol",
        },
      },
    )!;

    act(() => pumpBoard("ws", CTX));
    for (let index = 0; index < 6; index += 1) await settle();

    expect(getBoardTasks("ws")[0]).toMatchObject({
      status: "human_review",
      phase: "awaiting_human",
      subtasks: [
        { title: "1.1 Implement feature", status: "pending" },
        { title: "1.2 Add verification", status: "pending" },
      ],
    });
    approveTask("ws", card.id);
    act(() => pumpBoard("ws", CTX));
    for (let index = 0; index < 6; index += 1) await settle();

    expect(prepareOpenSpecChange).toHaveBeenCalledWith(
      "D:/ws",
      "official-change",
      "spec-driven",
      "Implement from the official artifacts",
    );
    expect(prepareOpenSpecChange).toHaveBeenCalledTimes(2);
    expect(getOpenSpecChangeStatus).toHaveBeenCalledWith(
      "D:/ws",
      "official-change",
    );
    expect(previewLocalFile).toHaveBeenCalledWith(
      "openspec/changes/official-change/tasks.md",
      { cwd: "D:/ws" },
    );
    const stored = getBoardTasks("ws")[0];
    expect(stored).toMatchObject({
      status: "human_review",
      phase: "awaiting_human",
      plan: "- [ ] 1.1 Implement feature\n- [ ] 1.2 Add verification",
      subtasks: [
        { title: "1.1 Implement feature", status: "completed" },
        { title: "1.2 Add verification", status: "completed" },
      ],
    });
    expect(validateOpenSpecChange).toHaveBeenCalledTimes(2);
    expect(setOpenSpecTaskStatus).toHaveBeenNthCalledWith(
      1,
      "D:/ws",
      "official-change",
      0,
      true,
    );
    expect(setOpenSpecTaskStatus).toHaveBeenNthCalledWith(
      2,
      "D:/ws",
      "official-change",
      1,
      true,
    );
    expect(gatewayCallsForCard(card.id)).toHaveLength(4);
    expect(
      gatewayCallsForCard(card.id).map(([request]) => request.thinkingLevel),
    ).toEqual(["xhigh", "high", "high", "low"]);
    expect(resolveCliGatewayRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "provider-spec",
        channelId: "channel-spec",
      }),
    );
  });

  it("uses the task-specific channel, passes reference image paths, and persists usage", async () => {
    vi.mocked(completeGatewayText).mockImplementation(async (request) => {
      request.onUsage?.({
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        thinkingTokens: 12,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 8,
      });
      return "已完成";
    });
    const card = addTask("ws", "queue", "按图实现", "还原界面", {
      developmentMode: "direct",
      agentProfile: "custom",
      modelSelection: {
        adapter: "codex",
        modelClass: "sonnet",
        providerId: "provider-task",
        channelId: "channel-task",
        modelOverride: "gpt-5",
      },
      referenceImages: [
        {
          id: "shot",
          path: "D:/shots/reference.png",
          fileName: "reference.png",
          mime: "image/png",
        },
      ],
    })!;
    pumpBoard("ws", CTX);
    await settle();
    expect(resolveCliGatewayRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: "codex",
        providerId: "provider-task",
        channelId: "channel-task",
        modelOverride: "gpt-5",
      }),
    );
    expect(gatewayCallsForCard(card.id)[0][0].userContent).toContain(
      "D:/shots/reference.png",
    );
    expect(getBoardTasks("ws")[0].runs?.[0]).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      thinkingTokens: 12,
      cacheReadTokens: 80,
      cacheCreationTokens: 8,
    });
  });

  it("uses the active GLM channel for auto-profile tasks with stale Claude routing", async () => {
    const activeGlmSelection = {
      adapter: "zcode" as const,
      modelClass: "sonnet" as const,
      providerId: "provider-glm",
      channelId: "channel-glm",
      modelOverride: "glm-5.3",
    };
    const glmRoute = {
      adapter: "zcode",
      model: "glm-5.3",
      env: { ZCODE_MODEL: "glm-5.3" },
      cliCommand: "zcode",
    } as never;
    const staleClaudeSelection = {
      adapter: "claude-code" as const,
      modelClass: "sonnet" as const,
      providerId: "provider-claude",
      channelId: "channel-claude",
      modelOverride: "claude-sonnet-5",
    };
    window.localStorage.setItem(
      GATEWAY_CONFIG_STORAGE,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "provider-glm",
            kind: "zcode",
            name: "GLM",
            adapter: "zcode",
            channels: [
              {
                id: "channel-glm",
                name: "GLM",
                model: "glm-5.3",
                route: {
                  transport: "openai-compatible",
                  model: "glm-5.3",
                },
              },
            ],
          },
        ],
      }),
    );
    window.localStorage.setItem(
      ACTIVE_GATEWAY_SELECTION_STORAGE,
      JSON.stringify(activeGlmSelection),
    );
    vi.mocked(resolveCliGatewayRoute).mockResolvedValue(glmRoute);
    vi.mocked(completeGatewayText).mockResolvedValueOnce("- [ ] Implement feature");

    const card = addTask("ws", "queue", "跟随当前渠道", "使用当前 GLM", {
      developmentMode: "standard",
      agentProfile: "auto",
      modelSelection: staleClaudeSelection,
      planningModelSelection: staleClaudeSelection,
      specModelSelection: staleClaudeSelection,
      reviewModelSelection: staleClaudeSelection,
      model: "claude-sonnet-5",
      reviewModel: "claude-sonnet-5",
    })!;
    pumpBoard("ws", CTX);
    await settle();

    expect(resolveCliGatewayRoute).toHaveBeenCalledTimes(1);
    expect(resolveCliGatewayRoute).toHaveBeenCalledWith(activeGlmSelection);
    const requests = gatewayCallsForCard(card.id).map(([request]) => request);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.route === glmRoute)).toBe(true);
    expect(requests.every((request) => request.forceCli === true)).toBe(true);
  });

  it("runs one queued task: work → audit → awaiting_human in human_review", async () => {
    const card = addTask("ws", "queue", "生成主菜单 UI", "参考 3 个候选", {
      category: "feature",
    })!;
    act(() => pumpBoard("ws", CTX));
    await settle();

    const stored = getBoardTasks("ws")[0];
    expect(stored.status).toBe("human_review");
    expect(stored.phase).toBe("awaiting_human");
    // two gateway calls: work + audit, both forced onto the CLI transport
    expect(gatewayCallsForCard(card.id)).toHaveLength(2);
    const [work, audit] = gatewayCallsForCard(card.id).map(([r]) => r) as [
      {
        system: string;
        userContent: string;
        cwd: string;
        forceCli: boolean;
        route: unknown;
      },
      { system: string; userContent: string },
    ];
    expect(work.system).toContain("任务执行 agent");
    expect(work.userContent).toContain("生成主菜单 UI");
    expect(work.userContent).toContain("分类: 功能");
    expect(work.cwd).toBe("D:/ws");
    expect(work.forceCli).toBe(true);
    expect(work.route).toBe(ROUTE);
    expect(audit.system).toContain("验收审核员");
    expect(audit.userContent).toContain("报告");
  });

  it("publishes capped work and review deltas for the running card", async () => {
    const card = addTask("ws", "queue", "流式任务")!;
    let workDelta: ((chunk: string) => void) | undefined;
    let auditDelta: ((chunk: string) => void) | undefined;
    let resolveWork!: (value: string) => void;
    let resolveAudit!: (value: string) => void;
    vi.mocked(completeGatewayText)
      .mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            workDelta = request.onDelta;
            resolveWork = resolve;
          }),
      )
      .mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            auditDelta = request.onDelta;
            resolveAudit = resolve;
          }),
      );

    act(() => pumpBoard("ws", CTX));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getTaskStream("ws", card.id)).toMatchObject({
      phase: "executing",
      text: "",
    });

    const beforeDelta = getRunnerSnapshot();
    act(() => {
      workDelta?.("正在");
      workDelta?.("执行");
    });
    expect(getTaskStream("ws", card.id)).toMatchObject({
      phase: "executing",
      text: "正在执行",
    });
    expect(getRunnerSnapshot()).not.toBe(beforeDelta);
    expect(getRunnerSnapshot().streamRevision).toBeGreaterThan(
      beforeDelta.streamRevision,
    );

    const oversizedChunk = `${"x".repeat(30_000)}tail`;
    act(() => workDelta?.(oversizedChunk));
    const capped = getTaskStream("ws", card.id)!;
    expect(capped.text.length).toBeLessThanOrEqual(24_000);
    expect(capped.text.startsWith("…\n")).toBe(true);
    expect(capped.text.endsWith("tail")).toBe(true);

    await act(async () => {
      resolveWork("执行报告");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getTaskStream("ws", card.id)).toMatchObject({
      phase: "reviewing",
      text: "",
    });

    act(() => {
      auditDelta?.("PASS");
      auditDelta?.(": 已通过");
    });
    expect(getTaskStream("ws", card.id)).toMatchObject({
      phase: "reviewing",
      text: "PASS: 已通过",
    });

    await act(async () => resolveAudit("PASS: 已通过"));
    await settle();
    expect(getTaskStream("ws", card.id)).toBeNull();
    const completed = getBoardTasks("ws").find((item) => item.id === card.id)!;
    expect(completed.runs?.[0].text).toBe("执行报告");
    expect(completed.runs?.[0].streamText?.endsWith("tail")).toBe(true);
    expect(completed.runs?.[1].streamText).toBe("PASS: 已通过");
  });

  it("respects the parallel cap", async () => {
    setMaxParallel(1);
    addTask("ws", "queue", "任务一");
    addTask("ws", "queue", "任务二");
    // hold the first work call open with a manual deferred
    let resolveWork!: (v: string) => void;
    vi.mocked(completeGatewayText).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveWork = r;
        }),
    );
    act(() => pumpBoard("ws", CTX));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const byTitle = new Map(getBoardTasks("ws").map((c) => [c.title, c]));
    expect(byTitle.get("任务一")?.phase).toBe("executing");
    expect(byTitle.get("任务二")?.status).toBe("queue");
    expect(vi.mocked(completeGatewayText)).toHaveBeenCalledTimes(1);

    // finishing task one frees the slot; the queued card then runs through
    act(() => resolveWork("报告"));
    await settle();
    act(() => setMaxParallel(2));
    act(() => pumpBoard("ws", CTX));
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const titles = getBoardTasks("ws").map((c) => c.status);
    expect(titles.every((s) => s === "human_review")).toBe(true);
  });

  it("failed audit lands in human_review with the failure reason", async () => {
    addTask("ws", "queue", "未完成任务");
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce("我做了一半")
      .mockResolvedValueOnce("FAIL: 菜单文件不存在");
    act(() => pumpBoard("ws", CTX));
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stored = getBoardTasks("ws")[0];
    expect(stored.status).toBe("human_review");
    expect(stored.phase).toBe("failed");
    expect(stored.executionError).toBe("菜单文件不存在");
  });

  it("accepts a verbose audit whose PASS conclusion comes after narration", async () => {
    addTask("ws", "queue", "正常任务");
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce("报告已生成。")
      .mockResolvedValueOnce(
        "所有抽查项全部吻合：端口表、Lua 计数与报告逐一相符。\n报告 Doc/项目分析报告.md 已存在且完整覆盖。\nPASS: 分析报告已存在且内容完整，任务已完成。",
      );
    act(() => pumpBoard("ws", CTX));
    await settle();
    const stored = getBoardTasks("ws")[0];
    expect(stored.status).toBe("human_review");
    expect(stored.phase).toBe("awaiting_human");
    expect(stored.executionError).toBeUndefined();
  });

  it("a later FAIL overrides an earlier PASS mention", async () => {
    addTask("ws", "queue", "先扬后抑任务");
    vi.mocked(completeGatewayText)
      .mockResolvedValueOnce("部分通过。")
      .mockResolvedValueOnce(
        "初看像 PASS，但复核发现入口函数缺失，结论 FAIL: 缺少入口。",
      );
    act(() => pumpBoard("ws", CTX));
    await settle();
    const stored = getBoardTasks("ws")[0];
    expect(stored.phase).toBe("failed");
    expect(stored.executionError).toContain("缺少入口");
  });

  it("execution errors land in human_review as failed", async () => {
    addTask("ws", "queue", "会抛错的任务");
    vi.mocked(completeGatewayText).mockRejectedValueOnce(new Error("cli boom"));
    act(() => pumpBoard("ws", CTX));
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stored = getBoardTasks("ws")[0];
    expect(stored.status).toBe("human_review");
    expect(stored.phase).toBe("failed");
    expect(stored.executionError).toContain("cli boom");
  });

  it("route resolution failures (e.g. expired auth) surface on the card", async () => {
    addTask("ws", "queue", "鉴权失败任务");
    vi.mocked(resolveCliGatewayRoute).mockRejectedValueOnce(
      new Error("OAuth session expired and could not be refreshed"),
    );
    act(() => pumpBoard("ws", CTX));
    await settle();
    const stored = getBoardTasks("ws")[0];
    expect(stored.status).toBe("human_review");
    expect(stored.phase).toBe("failed");
    expect(stored.executionError).toContain("OAuth session expired");
  });

  it("stopTask cancels the run and marks the failure as manual", async () => {
    const card = addTask("ws", "queue", "会被停止的任务")!;
    let rejectWork!: (e: Error) => void;
    vi.mocked(completeGatewayText).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWork = reject;
        }),
    );
    act(() => pumpBoard("ws", CTX));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getBoardTasks("ws")[0].phase).toBe("executing");
    stopTask("ws", card.id);
    await act(async () => rejectWork(new Error("cancelled")));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const stored = getBoardTasks("ws")[0];
    expect(stored.phase).toBe("failed");
    expect(stored.executionError).toBe("手动停止");
    expect(cancelAiCli).toHaveBeenCalledWith(`tbrun_ws_${card.id}`);
  });

  it("steers the active CLI turn and mirrors the accepted instruction in the stream", async () => {
    const card = addTask("ws", "queue", "运行中追加指令")!;
    let resolveWork!: (value: string) => void;
    vi.mocked(completeGatewayText).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWork = resolve;
        }),
    );
    pumpBoard("ws", CTX);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await expect(
      steerTask("ws", card.id, "先运行聚焦测试再继续"),
    ).resolves.toBe(true);
    expect(steerAiCli).toHaveBeenCalledWith(
      `tbrun_ws_${card.id}`,
      "先运行聚焦测试再继续",
    );
    expect(getTaskStream("ws", card.id)?.text).toContain(
      "[追加指令] 先运行聚焦测试再继续",
    );

    resolveWork("实现完成");
    await settle();
  });

  it("does nothing without a workspace or Tauri", () => {
    addTask("ws", "queue", "不会执行");
    act(() => pumpBoard("ws", { cwd: "", permission: "full" }));
    expect(vi.mocked(completeGatewayText)).not.toHaveBeenCalled();
    vi.mocked(tauriAvailable).mockReturnValue(false);
    act(() => pumpBoard("ws", CTX));
    expect(vi.mocked(completeGatewayText)).not.toHaveBeenCalled();
  });

  it("clamps the parallel setting and persists it", () => {
    act(() => setMaxParallel(99));
    expect(getMaxParallel()).toBe(10);
    act(() => setMaxParallel(0));
    expect(getMaxParallel()).toBe(1);
    act(() => setMaxParallel(3));
    expect(window.localStorage.getItem("ugs.taskboard.runner.v1")).toBe("3");
  });

  it("keeps project concurrency limits independent and reloads their saved values", () => {
    setMaxParallel(2, "project-a");
    setMaxParallel(7, "project-b");
    expect(getMaxParallel("project-a")).toBe(2);
    expect(getMaxParallel("project-b")).toBe(7);
    __resetRunnerForTests();
    expect(getMaxParallel("project-a")).toBe(2);
    expect(getMaxParallel("project-b")).toBe(7);
  });
});
