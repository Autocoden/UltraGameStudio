import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listWorkspaceChangesMock,
  listWorkspaceDirectoryMock,
  openWorkspaceDirectoryMock,
  previewLocalFileMock,
} = vi.hoisted(() => ({
  listWorkspaceChangesMock: vi.fn(),
  listWorkspaceDirectoryMock: vi.fn(),
  openWorkspaceDirectoryMock: vi.fn(),
  previewLocalFileMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  listWorkspaceChanges: listWorkspaceChangesMock,
  listWorkspaceDirectory: listWorkspaceDirectoryMock,
  openWorkspaceDirectory: openWorkspaceDirectoryMock,
  previewLocalFile: previewLocalFileMock,
}));

import TaskWorkspaceFiles from "./TaskWorkspaceFiles";

function workspaceEntry(
  name: string,
  relativePath: string,
  kind: "directory" | "file",
) {
  return {
    name,
    path: `D:\\project\\${relativePath.replace(/\//g, "\\")}`,
    relativePath,
    kind,
    hidden: false,
  };
}

function click(element: Element) {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("TaskWorkspaceFiles", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    listWorkspaceChangesMock.mockReset();
    listWorkspaceDirectoryMock.mockReset();
    openWorkspaceDirectoryMock.mockReset();
    previewLocalFileMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("enters a directory and returns to its parent", async () => {
    listWorkspaceDirectoryMock.mockImplementation(
      async (_cwd: string, relativePath: string) => ({
        rootPath: "D:\\project",
        relativePath,
        entries:
          relativePath === "docs"
            ? [workspaceEntry("guide.md", "docs/guide.md", "file")]
            : [workspaceEntry("docs", "docs", "directory")],
      }),
    );

    await act(async () => {
      root.render(
        <TaskWorkspaceFiles cwd={"D:\\project"} cardId="card-1" />,
      );
    });
    await settle();

    await act(async () => click(buttonWithText(container, "docs")));
    await settle();
    expect(listWorkspaceDirectoryMock).toHaveBeenLastCalledWith(
      "D:\\project",
      "docs",
    );
    expect(container.textContent).toContain("guide.md");

    await act(async () => click(container.querySelector('[title="上级目录"]')!));
    await settle();
    expect(listWorkspaceDirectoryMock).toHaveBeenLastCalledWith(
      "D:\\project",
      "",
    );
    expect(container.textContent).toContain("docs");
  });

  it("renders Markdown for reading and exposes the original source", async () => {
    listWorkspaceDirectoryMock.mockResolvedValue({
      rootPath: "D:\\project",
      relativePath: "",
      entries: [workspaceEntry("README.md", "README.md", "file")],
    });
    const markdown = [
      "# Setup guide",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| TypeScript | Passed |",
    ].join("\n");
    previewLocalFileMock.mockResolvedValue({
      path: "D:\\project\\README.md",
      fileName: "README.md",
      kind: "text",
      mime: "text/markdown",
      sizeBytes: markdown.length,
      truncated: false,
      text: markdown,
    });

    await act(async () => {
      root.render(
        <TaskWorkspaceFiles cwd={"D:\\project"} cardId="card-1" />,
      );
    });
    await settle();
    await act(async () => click(buttonWithText(container, "README.md")));
    await settle();

    expect(container.querySelector("h1")?.textContent).toBe("Setup guide");
    expect(container.querySelector("table")?.textContent).toContain("Passed");
    expect(container.querySelector("pre")).toBeNull();

    await act(async () => click(buttonWithText(container, "源码")));
    expect(container.querySelector("pre")?.textContent).toBe(markdown);
    await act(async () => click(buttonWithText(container, "阅读")));
    expect(container.querySelector("table")?.textContent).toContain("TypeScript");
  });

  it("returns a relative file path when used as a task reference picker", async () => {
    listWorkspaceDirectoryMock.mockResolvedValue({
      rootPath: "D:\\project",
      relativePath: "docs",
      entries: [workspaceEntry("guide.md", "docs/guide.md", "file")],
    });
    const onReference = vi.fn();

    await act(async () => {
      root.render(
        <TaskWorkspaceFiles
          cwd={"D:\\project"}
          cardId="card-1"
          initialDirectory="docs"
          onReference={onReference}
        />,
      );
    });
    await settle();
    await act(async () => click(buttonWithText(container, "guide.md")));

    expect(onReference).toHaveBeenCalledWith("docs/guide.md");
    expect(previewLocalFileMock).not.toHaveBeenCalled();
  });

  it("shows only task artifacts and opens the requirements file first", async () => {
    listWorkspaceDirectoryMock.mockResolvedValue({
      rootPath: "D:\\project\\.ultragamestudio\\tasks\\card-1",
      relativePath: "",
      entries: [
        workspaceEntry("src", "src", "directory"),
        workspaceEntry("README.txt", "README.txt", "file"),
        workspaceEntry("task_logs.jsonl", "task_logs.jsonl", "file"),
        workspaceEntry("requirements.md", "requirements.md", "file"),
        workspaceEntry("implementation_plan.md", "implementation_plan.md", "file"),
      ],
    });
    previewLocalFileMock.mockResolvedValue({
      path: "D:\\project\\.ultragamestudio\\tasks\\card-1\\requirements.md",
      fileName: "requirements.md",
      kind: "text",
      mime: "text/markdown",
      sizeBytes: 16,
      truncated: false,
      text: "# Current task",
    });

    await act(async () => {
      root.render(
        <TaskWorkspaceFiles
          cwd={"D:\\project\\.ultragamestudio\\tasks\\card-1"}
          cardId="card-1"
          taskArtifacts
        />,
      );
    });
    await settle();
    await settle();

    expect(container.textContent).toContain("requirements.md");
    expect(container.textContent).toContain("implementation_plan.md");
    expect(container.textContent).toContain("task_logs.jsonl");
    expect(container.textContent).not.toContain("README.txt");
    expect(container.textContent).not.toContain("src");
    expect(previewLocalFileMock).toHaveBeenCalledWith(
      expect.stringContaining("requirements.md"),
      { cwd: "D:\\project\\.ultragamestudio\\tasks\\card-1" },
    );
    expect(container.querySelector("h1")?.textContent).toBe("Current task");
  });
});
