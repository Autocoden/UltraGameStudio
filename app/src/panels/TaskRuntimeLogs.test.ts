import { describe, expect, it } from "vitest";
import {
  parseTaskRuntimeOutput,
  taskRunCapturedOutput,
} from "./TaskRuntimeLogs";

describe("parseTaskRuntimeOutput", () => {
  it("folds start and completion patches into one tool activity", () => {
    const output = [
      "正在检查工作区。",
      '<<UGS_TOOL>>{"id":"tool-1","name":"Bash","subject":"npm test","status":"running","args":{"command":"npm test"}}<<UGS_TOOL_END>>',
      "测试执行完毕。",
      '<<UGS_TOOL>>{"id":"tool-1","status":"done","durationMs":1250,"result":"12 tests passed"}<<UGS_TOOL_END>>',
      "全部通过。",
    ].join("\n");

    const entries = parseTaskRuntimeOutput(output);
    const tools = entries.filter((entry) => entry.type === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "tool",
      tool: {
        id: "tool-1",
        name: "Bash",
        subject: "npm test",
        status: "done",
        args: { command: "npm test" },
        durationMs: 1250,
        result: "12 tests passed",
      },
    });
    expect(
      entries
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.content)
        .join("\n"),
    ).toContain("全部通过。");
  });
});

describe("taskRunCapturedOutput", () => {
  it("keeps the final Direct response when the adapter stream only contains activity", () => {
    expect(
      taskRunCapturedOutput({
        phase: "executing",
        streamText: "Reading files...",
        text: "Implemented the requested change.",
        startedAt: 1,
        completedAt: 2,
      }),
    ).toBe("Reading files...\n\nImplemented the requested change.");
  });
});
