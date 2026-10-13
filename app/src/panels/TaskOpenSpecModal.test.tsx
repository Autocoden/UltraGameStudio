import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskCard } from "@/lib/taskBoard";
import TaskOpenSpecModal from "./TaskOpenSpecModal";
import { __resetTaskExecutionsForTests, reserveTaskExecution } from "@/lib/taskExecution";

const runnerMocks = vi.hoisted(() => ({
  steerTask: vi.fn(),
  stopTask: vi.fn(),
}));

vi.mock("@/lib/taskBoardRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/taskBoardRunner")>()),
  steerTask: runnerMocks.steerTask,
  stopTask: runnerMocks.stopTask,
}));

vi.mock("./TaskOpenSpecDetail", () => ({
  default: () => <div>OpenSpec detail</div>,
}));

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskOpenSpecModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetTaskExecutionsForTests();
    runnerMocks.steerTask.mockReset();
    runnerMocks.stopTask.mockReset();
    runnerMocks.steerTask.mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(["backlog", "human_review"] as const)("disables %s start or approval while a manual action holds the task", async (status) => {
    const card: TaskCard = { id: "manual-busy", title: "Manual action", note: "", status,
      phase: "awaiting_human", developmentMode: "spec", openSpecChange: "manual-busy",
      plan: "- [ ] Implement", planApproved: false, createdAt: 1, updatedAt: 1 };
    await act(async () => root.render(<TaskOpenSpecModal boardKey="default" cwd="D:/project"
      card={card} locale="zh-CN" onClose={vi.fn()} />));
    const label = status === "backlog" ? "开始" : "批准规范并构建";
    const button = () => [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(label))!;
    expect(button().disabled).toBe(false);
    let execution!: NonNullable<ReturnType<typeof reserveTaskExecution>>;
    act(() => { execution = reserveTaskExecution('default', card.id, 'openspec')!; });
    expect(button().disabled).toBe(true);
    act(() => execution.release());
    expect(button().disabled).toBe(false);
  });

  it("sends an extra instruction from an active OpenSpec task window", async () => {
    const card: TaskCard = {
      id: "openspec-running",
      title: "还原任务详情",
      note: "按规范实现",
      status: "in_progress",
      phase: "executing",
      developmentMode: "spec",
      openSpecChange: "restore-task-detail",
      createdAt: 1,
      updatedAt: 1,
    };
    await act(async () => {
      root.render(
        <TaskOpenSpecModal
          boardKey="default"
          cwd="D:\\project"
          card={card}
          locale="zh-CN"
          onClose={vi.fn()}
        />,
      );
    });

    const input = document.querySelector<HTMLInputElement>(
      "#task-live-instruction-openspec-running",
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input, "先对齐桌面版布局，再继续实现");
    });
    await act(async () => {
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(runnerMocks.steerTask).toHaveBeenCalledWith(
      "default",
      "openspec-running",
      "先对齐桌面版布局，再继续实现",
    );
    expect(document.body.textContent).toContain("当前模型会话已接收追加指令");
  });
});
