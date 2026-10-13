import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TaskOpenSpecDetail from "./TaskOpenSpecDetail";
import { addTask, getBoardTasks, __resetTaskBoardForTests } from "@/lib/taskBoard";
import { archiveOpenSpecChange, getOpenSpecChangeStatus, listOpenSpecChanges } from "@/lib/tauri";

vi.mock("@/panels/TaskWorkspaceFiles", () => ({ default: ({ initialDirectory }: { initialDirectory: string }) => <div data-testid="archive-files">{initialDirectory}</div> }));
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  getOpenSpecRuntimeStatus: vi.fn(async () => ({ available: true })),
  getOpenSpecChangeStatus: vi.fn(async () => ({ success: true, json: { artifacts: [], isPlanningComplete: true } })),
  validateOpenSpecChange: vi.fn(async () => ({ success: true, stdout: "", stderr: "" })),
  archiveOpenSpecChange: vi.fn(),
  listOpenSpecChanges: vi.fn(),
}));

const success = (name: string) => ({ success: true, timedOut: false, stdout: "", stderr: "", json: {
  archive: { change: name, path: `D:/project/openspec/changes/archive/2026-09-19-${name}`, specsUpdated: false },
} });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetTaskBoardForTests();
  addTask("archive", "done", "Spec", "", { developmentMode: "spec", openSpecChange: "test-change" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetTaskBoardForTests();
});
const render = () => act(async () => root.render(<TaskOpenSpecDetail boardKey="archive" cwd="D:/project" card={getBoardTasks("archive")[0]} active={false} />));
const click = (label: string) => act(async () => {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  expect(button!.disabled).toBe(false);
  button!.click();
});

it("shows a CLI failure inside the archive dialog and preserves the active change", async () => {
  vi.mocked(archiveOpenSpecChange).mockResolvedValue({ ...success("test-change"), success: false, json: { archive: null, status: [{ message: "Archive target already exists" }] } });
  await render();
  await click("归档");
  await click("校验并归档");
  expect(container.querySelector('[aria-label="归档 OpenSpec 变更"] [role="alert"]')?.textContent).toContain("Archive target already exists");
  expect(getBoardTasks("archive")[0].openSpecArchive).toBeUndefined();
});

it("persists the official archive path and reopens documents without querying a removed active change", async () => {
  vi.mocked(archiveOpenSpecChange).mockResolvedValue(success("test-change"));
  await render();
  await click("归档");
  await click("校验并归档");
  expect(container.textContent).toContain("变更已归档，未更新主规范。");
  expect(getBoardTasks("archive")[0]).toMatchObject({ status: "done", phase: "complete", archived: true });
  expect(container.querySelector('[data-testid="archive-files"]')?.textContent).toBe(success("test-change").json.archive.path);
  await act(async () => root.unmount());
  __resetTaskBoardForTests();
  expect(getBoardTasks("archive")[0].openSpecArchive?.path).toBe(success("test-change").json.archive.path);
  vi.mocked(getOpenSpecChangeStatus).mockClear();
  root = createRoot(container);
  await render();
  expect(getOpenSpecChangeStatus).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="archive-files"]')).not.toBeNull();
});

it("rejects a successful process exit with no official archive receipt", async () => {
  vi.mocked(archiveOpenSpecChange).mockResolvedValue({ ...success("test-change"), json: { archive: null } });
  await render();
  await click("归档");
  await click("校验并归档");
  expect(container.querySelector('[aria-label="归档 OpenSpec 变更"] [role="alert"]')?.textContent).toContain("未返回有效的归档结果");
  expect(getBoardTasks("archive")[0].openSpecArchive).toBeUndefined();
});

it("keeps partial bulk successes and retries only the failed change", async () => {
  addTask("archive", "done", "Second", "", { developmentMode: "spec", openSpecChange: "second-change" });
  vi.mocked(listOpenSpecChanges).mockResolvedValue({ ...success("test-change"), json: { changes: ["test-change", "second-change"].map(name => ({ name, totalTasks: 1, completedTasks: 1 })) } });
  vi.mocked(archiveOpenSpecChange)
    .mockResolvedValueOnce(success("test-change"))
    .mockResolvedValueOnce({ ...success("second-change"), success: false, stderr: "Archive locked" })
    .mockResolvedValueOnce(success("second-change"));
  await render();
  await click("批量归档");
  await click("归档 2 个变更");
  expect(getBoardTasks("archive")[0].openSpecArchive).toBeDefined();
  expect(container.querySelector('[aria-label="批量归档 OpenSpec 变更"]')?.textContent).toContain("Archive locked");
  await click("归档 1 个变更");
  expect(vi.mocked(archiveOpenSpecChange).mock.calls.map(call => call[1])).toEqual(["test-change", "second-change", "second-change"]);
  expect(getBoardTasks("archive")[1].openSpecArchive).toBeDefined();
});
