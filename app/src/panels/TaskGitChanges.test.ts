import { describe, expect, it } from "vitest";
import type { TaskGitCommit } from "@/lib/tauri";
import {
  buildTaskCommitGraphRows,
  isVisibleTaskGitFile,
  shouldHideTaskGitChangePath,
} from "./TaskGitChanges";

function commit(
  hash: string,
  parents: string[] = [],
  isMerge = false,
): TaskGitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: hash,
    author: "Dev",
    date: "2026-09-13T10:00:00+08:00",
    timestamp: 1,
    parents,
    refs: [],
    isMerge,
  };
}

describe("buildTaskCommitGraphRows", () => {
  it("keeps both visible parents of a merge in the graph", () => {
    const rows = buildTaskCommitGraphRows([
      commit("merge", ["left", "right"], true),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("base"),
    ]);

    expect(rows[0].commit.hash).toBe("merge");
    expect(rows[0].parentLaneIndexes).toHaveLength(2);
    expect(rows[0].laneCount).toBeGreaterThanOrEqual(2);
    expect(rows.map((row) => row.commit.hash)).toEqual([
      "merge",
      "left",
      "right",
      "base",
    ]);
  });
});

describe("task Git change visibility", () => {
  it("hides Autocode and UGS metadata directories at the workspace root", () => {
    for (const path of [
      ".git/index",
      ".claude/settings.json",
      ".codex/config.toml",
      ".cursor/rules/task.mdc",
      ".continue/config.json",
      ".windsurf/rules.md",
      ".aider/history",
      ".autocode/tasks/1.json",
      ".auto-claude/tasks/1.json",
      ".ugs/tasks/1.json",
      ".ultragamestudio/state.json",
      ".worktree/HEAD",
      ".worktrees/task/HEAD",
      ".\\.Codex\\config.toml",
    ]) {
      expect(shouldHideTaskGitChangePath(path), path).toBe(true);
    }

    expect(shouldHideTaskGitChangePath("src/.codex/example.ts")).toBe(false);
    expect(shouldHideTaskGitChangePath("src/main.ts")).toBe(false);
  });

  it("also hides a rename whose previous path belongs to metadata", () => {
    expect(
      isVisibleTaskGitFile({
        path: "src/generated.ts",
        previousPath: ".codex/generated.ts",
      }),
    ).toBe(false);
    expect(
      isVisibleTaskGitFile({
        path: "src/current.ts",
        previousPath: "src/previous.ts",
      }),
    ).toBe(true);
  });
});
