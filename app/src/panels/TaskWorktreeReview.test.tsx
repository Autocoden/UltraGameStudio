import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@/lib/taskBoard";
import { TASK_DEVELOPER_TOOLS_STORAGE } from "@/lib/taskDeveloperTools";
import TaskWorktreeReview from "./TaskWorktreeReview";

const tauriMocks = vi.hoisted(() => ({
  cleanupTaskWorktree: vi.fn(),
  createTaskPullRequest: vi.fn(),
  getTaskWorktreeReview: vi.fn(),
  integrateTaskWorktree: vi.fn(),
  openWorkspaceInIde: vi.fn(),
  openWorkspaceInTerminal: vi.fn(),
  pushTaskWorktree: vi.fn(),
}));

vi.mock("@/lib/tauri", () => tauriMocks);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("TaskWorktreeReview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(tauriMocks).forEach((mock) => mock.mockReset());
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers cleanup instead of another merge when the task branch is already merged", async () => {
    tauriMocks.getTaskWorktreeReview.mockResolvedValue({
      exists: true,
      mainRoot: "D:\\project",
      worktreePath: "D:\\project-worktrees\\task-1",
      branch: "autocode/task-1",
      targetBranch: "main",
      files: ["src/main.ts"],
      filesChanged: 1,
      additions: 4,
      deletions: 1,
      commitCount: 1,
      commitsBehind: 0,
      worktreeDirty: false,
      worktreeDirtyFiles: [],
      mainDirty: false,
      mainDirtyFiles: [],
      potentialConflicts: [],
      remoteUrl: null,
      alreadyMerged: true,
      canIntegrate: false,
    });
    const card: TaskCard = {
      id: "task-1",
      title: "实现任务",
      note: "完成看板功能",
      status: "human_review",
      createdAt: 1,
      updatedAt: 1,
      useWorktree: true,
      baseBranch: "main",
      executionCwd: "D:\\project-worktrees\\task-1",
    };

    await act(async () => {
      root.render(
        <TaskWorktreeReview
          boardKey="default"
          mainRoot="D:\\project"
          card={card}
          onViewChanges={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("任务分支已合并到 main");
    expect(container.textContent).toContain("清理工作树并标记完成");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.trim().startsWith("合并到"),
      ),
    ).toBe(false);
  });

  it("opens the worktree and shows every potential conflict in a details dialog", async () => {
    localStorage.setItem(
      TASK_DEVELOPER_TOOLS_STORAGE,
      JSON.stringify({
        preferredIDE: "cursor",
        customIDEPath: "",
        preferredTerminal: "powershell",
        customTerminalPath: "",
      }),
    );
    tauriMocks.getTaskWorktreeReview.mockResolvedValue({
      exists: true,
      mainRoot: "D:\\project",
      worktreePath: "D:\\project-worktrees\\task-2",
      branch: "autocode/task-2",
      targetBranch: "main",
      files: ["src/main.ts", "src/styles.css"],
      filesChanged: 2,
      additions: 8,
      deletions: 2,
      commitCount: 1,
      commitsBehind: 1,
      worktreeDirty: false,
      worktreeDirtyFiles: [],
      mainDirty: false,
      mainDirtyFiles: [],
      potentialConflicts: ["src/main.ts", "src/styles.css"],
      remoteUrl: null,
      alreadyMerged: false,
      canIntegrate: true,
    });
    const card: TaskCard = {
      id: "task-2",
      title: "处理冲突",
      note: "检查任务改动",
      status: "human_review",
      createdAt: 1,
      updatedAt: 1,
      useWorktree: true,
      baseBranch: "main",
      executionCwd: "D:\\project-worktrees\\task-2",
    };

    await act(async () => {
      root.render(
        <TaskWorktreeReview
          boardKey="default"
          mainRoot="D:\\project"
          card={card}
          onViewChanges={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    const findButton = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(text),
      )!;

    await act(async () => findButton("在 Cursor 中打开").click());
    await act(async () => findButton("在 PowerShell 中打开").click());
    expect(tauriMocks.openWorkspaceInIde).toHaveBeenCalledWith(
      "D:\\project-worktrees\\task-2",
      "cursor",
      undefined,
    );
    expect(tauriMocks.openWorkspaceInTerminal).toHaveBeenCalledWith(
      "D:\\project-worktrees\\task-2",
      "powershell",
      undefined,
    );

    await act(async () => findButton("查看冲突详情").click());
    const dialog = container.querySelector('[aria-label="合并冲突预览"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("src/main.ts");
    expect(dialog.textContent).toContain("src/styles.css");
    expect(dialog.textContent).toContain("原因：");
    expect(dialog.textContent).toContain("策略：");
  });
});
