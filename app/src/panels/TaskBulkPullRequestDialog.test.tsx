import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTaskBoardForTests,
  addTask,
  getBoardTasks,
  updateTaskExecution,
} from "@/lib/taskBoard";
import TaskBulkPullRequestDialog, {
  isValidGitBranchName,
} from "./TaskBulkPullRequestDialog";

const tauriMocks = vi.hoisted(() => ({
  createTaskPullRequest: vi.fn(),
  openExternal: vi.fn(async () => undefined),
}));

vi.mock("@/lib/tauri", () => ({
  createTaskPullRequest: tauriMocks.createTaskPullRequest,
  openExternal: tauriMocks.openExternal,
}));

function click(element: Element) {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

function setInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskBulkPullRequestDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    __resetTaskBoardForTests();
    tauriMocks.createTaskPullRequest.mockReset();
    tauriMocks.openExternal.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("validates common Git branch-name constraints", () => {
    expect(isValidGitBranchName("")).toBe(true);
    expect(isValidGitBranchName("release/2026-09")).toBe(true);
    expect(isValidGitBranchName("feature menu")).toBe(false);
    expect(isValidGitBranchName("feature..menu")).toBe(false);
    expect(isValidGitBranchName("topic.lock")).toBe(false);
  });

  it("reports success, skipped and failed tasks while persisting the PR URL", async () => {
    const success = addTask("default", "human_review", "创建成功", "PR body", {
      useWorktree: true,
    })!;
    const skipped = addTask("default", "human_review", "没有工作树", "", {
      useWorktree: true,
    })!;
    const failed = addTask("default", "human_review", "创建失败", "", {
      useWorktree: true,
    })!;
    updateTaskExecution("default", success.id, {
      executionCwd: "D:\\worktrees\\success",
    });
    updateTaskExecution("default", failed.id, {
      executionCwd: "D:\\worktrees\\failed",
    });

    tauriMocks.createTaskPullRequest.mockImplementation(
      async (_mainRoot: string, worktreeRoot: string) => {
        if (worktreeRoot.endsWith("success")) {
          return {
            success: true,
            url: "https://github.com/example/repo/pull/21",
            alreadyExists: false,
            branch: "task/success",
            targetBranch: "release",
            commitCreated: true,
            message: "created",
          };
        }
        throw new Error("GitHub API rejected the request");
      },
    );
    const onClose = vi.fn();
    const onComplete = vi.fn();

    await act(async () => {
      root.render(
        <TaskBulkPullRequestDialog
          boardKey="default"
          mainRoot={"D:\\repo"}
          tasks={getBoardTasks("default")}
          onClose={onClose}
          onComplete={onComplete}
        />,
      );
    });

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>("#bulk-pr-target")!,
        "release",
      );
      click(container.querySelector('input[type="checkbox"]')!);
    });
    await act(async () => {
      click(
        Array.from(container.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("创建 3 个 PR"),
        )!,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container.querySelectorAll('[data-bulk-pr-status="success"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-bulk-pr-status="skipped"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-bulk-pr-status="error"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("成功 1，跳过 1，失败 1");
    expect(tauriMocks.createTaskPullRequest).toHaveBeenCalledTimes(2);
    expect(tauriMocks.createTaskPullRequest).toHaveBeenCalledWith(
      "D:\\repo",
      "D:\\worktrees\\success",
      {
        targetBranch: "release",
        title: "创建成功",
        body: "PR body",
        draft: true,
      },
    );

    const stored = getBoardTasks("default");
    expect(stored.find((task) => task.id === success.id)).toMatchObject({
      status: "done",
      phase: "complete",
      pullRequestUrl: "https://github.com/example/repo/pull/21",
    });
    expect(stored.find((task) => task.id === skipped.id)?.status).toBe(
      "human_review",
    );
    expect(stored.find((task) => task.id === failed.id)?.status).toBe(
      "human_review",
    );

    await act(async () =>
      click(
        Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "关闭",
        )!,
      ),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
