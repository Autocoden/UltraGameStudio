import { describe, expect, it } from "vitest";
import {
  parseOpenSpecChangeList,
  parseOpenSpecStatus,
} from "./TaskOpenSpecDetail";

describe("parseOpenSpecStatus", () => {
  it("maps the official artifact graph and concrete output paths", () => {
    const snapshot = parseOpenSpecStatus({
      success: true,
      timedOut: false,
      stdout: "",
      stderr: "",
      json: {
        changeName: "add-menu",
        schemaName: "spec-driven",
        changeRoot: "D:/game/openspec/changes/add-menu",
        isPlanningComplete: true,
        isComplete: true,
        nextSteps: ["Apply the change"],
        artifacts: [
          {
            id: "proposal",
            outputPath: "proposal.md",
            status: "done",
            requires: [],
          },
          {
            id: "specs",
            outputPath: "specs/**/*.md",
            status: "blocked",
            requires: ["proposal"],
            missingDeps: ["proposal"],
          },
        ],
        artifactPaths: {
          proposal: {
            outputPath: "proposal.md",
            existingOutputPaths: [
              "D:/game/openspec/changes/add-menu/proposal.md",
            ],
          },
          specs: {
            outputPath: "specs/**/*.md",
            existingOutputPaths: [],
          },
        },
      },
    });

    expect(snapshot).toMatchObject({
      changeName: "add-menu",
      schemaName: "spec-driven",
      isPlanningComplete: true,
      nextSteps: ["Apply the change"],
      artifacts: [
        {
          id: "proposal",
          status: "done",
          documents: ["D:/game/openspec/changes/add-menu/proposal.md"],
        },
        {
          id: "specs",
          status: "blocked",
          requires: ["proposal"],
          missingDeps: ["proposal"],
        },
      ],
    });
  });

  it("rejects non-object command payloads and normalizes unknown states", () => {
    expect(
      parseOpenSpecStatus({
        success: true,
        timedOut: false,
        stdout: "",
        stderr: "",
        json: null,
      }),
    ).toBeNull();

    const snapshot = parseOpenSpecStatus({
      success: true,
      timedOut: false,
      stdout: "",
      stderr: "",
      json: {
        artifacts: [{ id: "custom", status: "future-status" }],
      },
    });
    expect(snapshot?.artifacts[0].status).toBe("unknown");
  });
});

describe("parseOpenSpecChangeList", () => {
  it("maps official list output and ignores malformed entries", () => {
    expect(
      parseOpenSpecChangeList({
        success: true,
        timedOut: false,
        stdout: "",
        stderr: "",
        json: {
          changes: [
            {
              name: "add-menu",
              completedTasks: 2,
              totalTasks: 3,
              lastModified: "2026-09-13T12:00:00.000Z",
              status: "in-progress",
            },
            { name: "empty-change" },
            { completedTasks: 1, totalTasks: 1 },
            null,
          ],
        },
      }),
    ).toEqual([
      {
        name: "add-menu",
        completedTasks: 2,
        totalTasks: 3,
        lastModified: "2026-09-13T12:00:00.000Z",
        status: "in-progress",
      },
      {
        name: "empty-change",
        completedTasks: 0,
        totalTasks: 0,
        status: "unknown",
      },
    ]);
  });
});
