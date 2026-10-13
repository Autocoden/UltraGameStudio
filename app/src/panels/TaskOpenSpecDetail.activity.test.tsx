import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import TaskOpenSpecDetail from "./TaskOpenSpecDetail";
import type { TaskCard } from "@/lib/taskBoard";
import { addTask, getBoardTasks, updateTaskExecution, __resetTaskBoardForTests } from "@/lib/taskBoard";
import { __resetOpenSpecActionsForTests } from "@/lib/openSpecWorkspaceActions";
import { __publishTaskStreamForTests, __resetRunnerForTests } from "@/lib/taskBoardRunner";

vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  getOpenSpecRuntimeStatus: vi.fn(async () => ({ available: true, version: "1.13.0" })),
  getOpenSpecChangeStatus: vi.fn(async () => ({ success: true, stdout: "", stderr: "", json: { artifacts: [], isComplete: false } })),
}));

it("queues the approved plan when confirming planning review", async () => {
  __resetTaskBoardForTests();
  __resetOpenSpecActionsForTests();
  const card = addTask("review", "human_review", "Review", "", { developmentMode: "spec", openSpecChange: "review" })!;
  updateTaskExecution("review", card.id, { plan: "- [ ] implement", planApproved: false });
  const key = "ugs.openspec.actions.v1." + encodeURIComponent("review\u0000" + card.id);
  localStorage.setItem(key, JSON.stringify({ activeRun: null, history: [], planningReview: {
    id: "review-id", action: "new", createdAt: 1, acknowledged: false, files: [],
  } }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TaskOpenSpecDetail boardKey="review" cwd="D:/project" card={getBoardTasks("review")[0]} active={false} />));
    const confirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "确认规划并继续")!;
    expect(confirm).toBeDefined();
    await act(async () => confirm.click());
    expect(getBoardTasks("review")[0]).toMatchObject({ status: "queue", planApproved: true, plan: "- [ ] implement" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem(key);
    __resetOpenSpecActionsForTests();
    __resetTaskBoardForTests();
  }
});

it("shows board-runner live output, keeps history selection during streaming, and retains final output", async () => {
  __resetRunnerForTests();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const card: TaskCard = { id: "spec-activity", title: "Spec", note: "", developmentMode: "spec", openSpecChange: "test",
    status: "in_progress", phase: "executing", createdAt: 1, updatedAt: 1,
    runs: [{ phase: "planning", text: "Planning final report", streamText: "Planning tool activity", startedAt: 1, completedAt: 2 }] };
  try {
    await act(async () => root.render(<TaskOpenSpecDetail boardKey="test" cwd="D:/project" card={card} active />));
    const output = () => container.querySelector('[data-testid="openspec-activity-output"]')!.textContent;
    expect(output()).toContain("Planning tool activity");
    expect(output()).toContain("Planning final report");
    await act(async () => __publishTaskStreamForTests("test", card.id, { phase: "executing", startedAt: 3, text: "Coding delta one" }));
    expect(output()).toContain("Coding delta one");
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="OpenSpec 活动历史"]')!;
    await act(async () => { select.value = "task-planning-1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => __publishTaskStreamForTests("test", card.id, { phase: "executing", startedAt: 3, text: "Coding delta two" }));
    expect(output()).toContain("Planning final report");
    await act(async () => {
      __publishTaskStreamForTests("test", card.id, null);
      root.render(<TaskOpenSpecDetail boardKey="test" cwd="D:/project" active={false} card={{ ...card, runs: [...card.runs!, {
        phase: "executing", text: "Coding final report", startedAt: 3, completedAt: 4, error: "Command failed",
      }] }} />);
    });
    expect(output()).toContain("Coding final report");
    expect(output()).toContain("Command failed");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    __resetRunnerForTests();
  }
});
