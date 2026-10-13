import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskBoardDialog from "./TaskBoardDialog";

const tauriMocks = vi.hoisted(() => ({
  getTaskGitOverview: vi.fn(),
  listWorkspaceDirectory: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  getTaskGitOverview: tauriMocks.getTaskGitOverview,
  listWorkspaceDirectory: tauriMocks.listWorkspaceDirectory,
}));

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    value,
  );
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskBoardDialog file mentions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    tauriMocks.getTaskGitOverview.mockReset();
    tauriMocks.listWorkspaceDirectory.mockReset();
    tauriMocks.getTaskGitOverview.mockResolvedValue({
      currentBranch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      remoteUrl: null,
      defaultBranch: "main",
      branches: ["main"],
    });
    tauriMocks.listWorkspaceDirectory.mockResolvedValue({
      rootPath: "D:\\project",
      relativePath: "src",
      entries: [
        {
          name: "main.ts",
          path: "D:\\project\\src\\main.ts",
          relativePath: "src/main.ts",
          kind: "file",
          hidden: false,
        },
      ],
      truncated: false,
      totalEntries: 1,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists and inserts a project file after typing @", async () => {
    await act(async () => {
      root.render(
        <TaskBoardDialog
          locale="zh-CN"
          request={{ mode: "create", status: "backlog" }}
          boardKey="default"
          cwd={"D:\\project"}
          onClose={vi.fn()}
          onSubmit={() => true}
        />,
      );
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#task-dialog-note",
    )!;

    await act(async () => {
      setTextareaValue(textarea, "检查 @src/ma");
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
      "D:\\project",
      "src",
    );
    const option = container.querySelector<HTMLButtonElement>(
      "#task-dialog-file-mention-0",
    );
    expect(option?.textContent).toContain("src/main.ts");

    await act(async () => {
      option!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      option!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(textarea.value).toBe("检查 @src/main.ts");
    expect(
      container.querySelector("#task-dialog-file-mention-suggestions"),
    ).toBeNull();
  });
});
