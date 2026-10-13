import { describe, expect, it } from "vitest";
import type { TaskCard } from "@/lib/taskBoard";
import { buildTaskArtifactFiles } from "@/lib/taskArtifacts";

function directCard(): TaskCard {
  return {
    id: "task-123",
    title: "Fix task detail",
    note: "Show the current task artifacts and logs.",
    status: "human_review",
    developmentMode: "direct",
    phase: "awaiting_human",
    createdAt: Date.parse("2026-09-15T00:00:00.000Z"),
    updatedAt: Date.parse("2026-09-15T00:01:00.000Z"),
    runs: [
      {
        phase: "executing",
        text: "Implemented the requested change.",
        startedAt: Date.parse("2026-09-15T00:00:10.000Z"),
        completedAt: Date.parse("2026-09-15T00:00:50.000Z"),
      },
    ],
  };
}

describe("task artifacts", () => {
  it("builds task-scoped Autocode artifact files for a direct task", () => {
    const files = buildTaskArtifactFiles(directCard(), null);
    expect(files.map((file) => file.name)).toEqual([
      "requirements.md",
      "implementation_plan.md",
      "task_logs.jsonl",
      "task_metadata.json",
      "direct_summary.md",
    ]);
    expect(files.find((file) => file.name === "requirements.md")?.content)
      .toContain("Show the current task artifacts and logs.");
    expect(files.find((file) => file.name === "direct_summary.md")?.content)
      .toContain("Implemented the requested change.");
  });

  it("serializes phase and output records in Autocode JSONL form", () => {
    const logs = buildTaskArtifactFiles(directCard(), null)
      .find((file) => file.name === "task_logs.jsonl")!
      .content.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(logs[0]).toMatchObject({
      record_type: "meta",
      spec_id: "task-123",
    });
    expect(logs).toContainEqual(expect.objectContaining({
      record_type: "phase",
      phase: "coding",
      status: "completed",
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      record_type: "entry",
      entry: expect.objectContaining({
        phase: "coding",
        type: "text",
        content: "Implemented the requested change.",
      }),
    }));
  });
});
