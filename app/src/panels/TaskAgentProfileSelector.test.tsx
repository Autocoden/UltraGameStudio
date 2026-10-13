import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta } from "@/lib/taskBoard";
import TaskAgentProfileSelector, {
  type TaskModelOption,
} from "./TaskAgentProfileSelector";

function click(element: Element) {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

const OPTIONS: TaskModelOption[] = [
  {
    key: "provider-a\u0000balanced",
    label: "Provider A · Balanced · sonnet",
    selection: {
      adapter: "claude-code",
      modelClass: "sonnet",
      providerId: "provider-a",
      channelId: "balanced",
      modelOverride: "sonnet",
    },
  },
  {
    key: "provider-a\u0000complex",
    label: "Provider A · Complex · opus",
    selection: {
      adapter: "claude-code",
      modelClass: "opus",
      providerId: "provider-a",
      channelId: "complex",
      modelOverride: "opus",
    },
  },
  {
    key: "provider-b\u0000quick",
    label: "Provider B · Quick · haiku",
    selection: {
      adapter: "claude-code",
      modelClass: "haiku",
      providerId: "provider-b",
      channelId: "quick",
      modelOverride: "haiku",
    },
  },
];

describe("TaskAgentProfileSelector", () => {
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

  it("applies the complex preset within the current provider and exposes four phase controls", async () => {
    const onChange = vi.fn();
    const value: TaskMeta = {
      agentProfile: "auto",
      modelSelection: OPTIONS[0].selection,
    };
    await act(async () => {
      root.render(
        <TaskAgentProfileSelector
          value={value}
          options={OPTIONS}
          onChange={onChange}
        />,
      );
    });

    const phaseButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("阶段配置"),
    )!;
    await act(async () => click(phaseButton));
    expect(container.querySelectorAll('select[id$="-thinking"]')).toHaveLength(
      4,
    );
    expect(container.querySelector("#task-spec-model")).not.toBeNull();

    const profileSelect = container.querySelector<HTMLButtonElement>(
      "#task-agent-profile",
    )!;
    await act(async () => click(profileSelect));
    const complexOption = container.querySelector<HTMLButtonElement>(
      '[role="option"][data-value="complex"]',
    )!;
    expect(complexOption).not.toBeNull();
    await act(async () => click(complexOption));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentProfile: "complex",
        thinkingLevel: "high",
        phaseThinking: {
          spec: "high",
          planning: "high",
          coding: "high",
          qa: "high",
        },
        modelSelection: expect.objectContaining({
          providerId: "provider-a",
          channelId: "complex",
        }),
        specModelSelection: expect.objectContaining({
          channelId: "complex",
        }),
      }),
    );
  });
});
