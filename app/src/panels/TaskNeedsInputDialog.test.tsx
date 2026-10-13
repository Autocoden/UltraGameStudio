import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskNeedsInputDialog from "./TaskNeedsInputDialog";

function click(element: Element) {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

describe("TaskNeedsInputDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("preselects the recommended answer and submits structured decisions", async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <TaskNeedsInputDialog
          needsInput={{
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
          }}
          onClose={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
      await Promise.resolve();
    });

    const recommended = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="A"]',
    )!;
    expect(recommended.checked).toBe(true);
    const apply = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("应用并重新规划"),
    )!;
    await act(async () => click(apply));

    expect(onSubmit).toHaveBeenCalledWith([
      {
        questionId: "Q1",
        question: "选择哪种存储？",
        optionId: "A",
        answer: "SQLite",
      },
    ]);
  });
});
