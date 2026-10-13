import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTaskBoardForTests,
  addTask,
  archiveTask,
  getBoardTasks,
  setTaskPhase,
  updateTask,
  updateTaskExecution,
} from "@/lib/taskBoard";
import TaskBoardDetail from "./TaskBoardDetail";

const { openExternalMock, previewLocalFileMock, saveClipboardImageMock } =
  vi.hoisted(() => ({
  openExternalMock: vi.fn(),
    previewLocalFileMock: vi.fn(),
    saveClipboardImageMock: vi.fn(),
  }));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    getTaskGitOverview: vi.fn().mockResolvedValue(null),
    openExternal: openExternalMock,
    previewLocalFile: previewLocalFileMock,
    saveClipboardImage: saveClipboardImageMock,
  };
});

function click(element: Element) {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("TaskBoardDetail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    __resetTaskBoardForTests();
    openExternalMock.mockReset();
    previewLocalFileMock.mockReset();
    saveClipboardImageMock.mockReset();
    saveClipboardImageMock.mockResolvedValue(
      "D:\\project\\.ugs\\clipboard-images\\feedback.png",
    );
    previewLocalFileMock.mockResolvedValue({
      path: "D:\\project\\.ugs\\clipboard-images\\feedback.png",
      fileName: "feedback.png",
      kind: "image",
      mime: "image/png",
      sizeBytes: 2,
      truncated: false,
      base64: "aGk=",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows live subtask state and scoped model output in the execution graph", async () => {
    const card = addTask("default", "in_progress", "实现任务详情", "执行计划")!;
    updateTaskExecution("default", card.id, {
      subtasks: [
        {
          id: "step-1",
          title: "实现数据层",
          status: "completed",
          summary: "数据层已完成",
        },
        { id: "step-2", title: "实现界面", status: "in_progress", dependsOn: ["step-1"] },
      ],
      runs: [
        {
          phase: "executing",
          text: "已完成数据层修改",
          startedAt: 1000,
          completedAt: 3000,
          totalTokens: 42,
          thinkingLevel: "high",
          subtaskId: "step-1",
          subtaskTitle: "实现数据层",
        },
      ],
    });

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });
    const subtasksTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("子任务 (2)"),
    )!;
    await act(async () => click(subtasksTab));

    expect(container.textContent).toContain("已完成 1/2");
    const graph = container.querySelector('[aria-label="子任务执行图"]')!;
    expect(graph).not.toBeNull();
    expect(graph.querySelector('[data-edge-from="step-1"][data-edge-to="step-2"]')).not.toBeNull();
    await act(async () => click(graph.querySelector("button")!));
    expect(container.textContent).toContain("已完成数据层修改");
    expect(container.textContent).toContain("42 Token");
    expect(container.textContent).toContain("思考高");
    expect(container.textContent).toContain("进行中");
    await act(async () => click(graph.querySelector('[data-testid="execution-graph-canvas"]')!));
    expect(container.textContent).not.toContain("已完成数据层修改");
  });

  it("keeps the OpenSpec workspace out of Standard task details", async () => {
    const card = addTask("default", "human_review", "标准协议任务", "按规范实施", {
      developmentMode: "standard",
    })!;
    updateTask("default", card.id, {
      meta: {
        openSpecChange: "standard-protocol-task",
        openSpecSchema: "spec-driven",
      },
    });

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });

    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).some(
        (tab) => tab.textContent === "OpenSpec",
      ),
    ).toBe(false);
    expect(
      container.querySelector('[data-testid="openspec-task-detail"]'),
    ).toBeNull();
  });

  it("shows the live instruction composer while a task is executing", async () => {
    const card = addTask("default", "in_progress", "运行中的任务", "继续实现")!;
    setTaskPhase("default", card.id, "executing");

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd={"D:\\project"}
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });

    expect(
      container.querySelector('[aria-label="向当前执行会话追加指令"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("发送到当前会话");
    const logsTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (candidate) => candidate.textContent === "日志",
    );
    expect(logsTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[aria-label="任务运行日志"]')).not.toBeNull();
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      "大模型正在工作，开始回复后会在这里显示输出。",
    );
  });

  it("opens the pull request for a completed task", async () => {
    const card = addTask("default", "done", "已完成任务", "查看交付结果")!;
    updateTaskExecution("default", card.id, {
      pullRequestUrl: "https://example.com/pull/42",
    });

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });

    const openPullRequest = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("查看 PR"),
    )!;
    await act(async () => click(openPullRequest));

    expect(openExternalMock).toHaveBeenCalledWith(
      "https://example.com/pull/42",
    );
  });

  it("restores an archived completed task", async () => {
    const card = addTask("default", "done", "已归档任务", "恢复到完成列")!;
    archiveTask("default", card.id);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={onClose}
          onEdit={vi.fn()}
        />,
      );
    });

    const restore = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("恢复"),
    )!;
    await act(async () => click(restore));

    expect(getBoardTasks("default").find((item) => item.id === card.id)?.archived).toBe(
      false,
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("continues a failed task by returning it to the queue", async () => {
    const card = addTask("default", "in_progress", "失败任务", "修复后继续")!;
    setTaskPhase("default", card.id, "failed", "执行失败");

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });

    const resume = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("继续"),
    )!;
    await act(async () => click(resume));

    const updated = getBoardTasks("default").find((item) => item.id === card.id);
    expect(updated?.status).toBe("queue");
    expect(updated?.phase).toBe("idle");
  });

  it("approves the existing Standard plan when continuing from the detail footer", async () => {
    const card = addTask("default", "human_review", "待批准计划", "实现功能", {
      developmentMode: "standard", requireReviewBeforeCoding: true,
    })!;
    const plan = "## Tasks\n- [ ] 实现功能";
    updateTaskExecution("default", card.id, {
      plan, planApproved: false,
      subtasks: [{ id: "s1", title: "实现功能", status: "pending" }],
      runs: [{ phase: "planning", text: plan, startedAt: 1, completedAt: 2 }],
    });
    setTaskPhase("default", card.id, "awaiting_human");
    await act(async () => root.render(
      <TaskBoardDetail boardKey="default" cardId={card.id} cwd="D:\\project" locale="zh-CN" onClose={vi.fn()} onEdit={vi.fn()} />,
    ));
    const resume = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "继续")!;
    expect(resume).toBeDefined();
    await act(async () => click(resume));
    expect(getBoardTasks("default")[0]).toMatchObject({
      status: "queue", phase: "idle", planApproved: true, plan,
      subtasks: [{ id: "s1", status: "pending" }],
    });
  });

  it("submits pasted feedback attachments without requiring text", async () => {
    const card = addTask(
      "default",
      "human_review",
      "需要图片反馈的任务",
      "检查界面",
    )!;

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="修改反馈"]',
    )!;
    const file = new File([new Uint8Array([104, 105])], "feedback.png", {
      type: "image/png",
    });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [
          {
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    await act(async () => textarea.dispatchEvent(paste));
    await settle();
    const submit = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("提交反馈并继续"),
    )!;
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await act(async () => click(submit));

    const updated = getBoardTasks("default").find((item) => item.id === card.id);
    expect(updated?.referenceImages).toEqual([
      expect.objectContaining({
        path: "D:\\project\\.ugs\\clipboard-images\\feedback.png",
        fileName: "feedback.png",
      }),
    ]);
    expect(updated?.feedback).toContain("反馈附件：");
    expect(updated?.feedback).toContain(
      "D:\\project\\.ugs\\clipboard-images\\feedback.png",
    );
    expect(updated?.status).toBe("queue");
    expect(updated?.phase).toBe("idle");
  });

  it("applies the recommended structured answer and re-runs planning", async () => {
    const card = addTask(
      "default",
      "human_review",
      "等待用户决策",
      "设计存储层",
    )!;
    updateTaskExecution("default", card.id, {
      needsInput: {
        blocked: true,
        message: "需要确认存储方式",
        questions: ["选择哪种存储？"],
        decisions: [
          {
            id: "Q1",
            question: "选择哪种存储？",
            options: [
              { id: "A", label: "SQLite", recommended: true },
              { id: "B", label: "JSON", recommended: false },
            ],
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        <TaskBoardDetail
          boardKey="default"
          cardId={card.id}
          cwd="D:\\project"
          locale="zh-CN"
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="回答任务问题"]')).not.toBeNull();
    const apply = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("应用并重新规划"),
    )!;
    await act(async () => click(apply));

    const updated = getBoardTasks("default").find((item) => item.id === card.id);
    expect(updated?.needsInput).toBeUndefined();
    expect(updated?.feedback).toContain("选择哪种存储？ → SQLite");
    expect(updated?.status).toBe("queue");
    expect(updated?.phase).toBe("idle");
  });
});
