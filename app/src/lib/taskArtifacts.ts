import type { TaskCard, TaskRunRecord } from "@/lib/taskBoard";
import type { RunnerTaskStream } from "@/lib/taskBoardRunner";
import { standardPlanDocuments } from "./standardPlan";
import {
  syncTaskArtifactFiles,
  tauriAvailable,
  type TaskArtifactFileInput,
} from "@/lib/tauri";

type TaskLogPhase = "planning" | "coding" | "validation";
type TaskLogStatus = "pending" | "active" | "completed" | "failed";

const TASK_PHASES: readonly TaskLogPhase[] = [
  "planning",
  "coding",
  "validation",
];

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function logPhase(phase: TaskRunRecord["phase"] | RunnerTaskStream["phase"]): TaskLogPhase {
  if (phase === "planning") return "planning";
  return phase === "reviewing" ? "validation" : "coding";
}

function phaseLabel(phase: TaskLogPhase): string {
  if (phase === "planning") return "Planning";
  if (phase === "validation") return "Validation";
  return "Coding";
}

function runOutput(run: TaskRunRecord): string {
  const streamed = run.streamText?.trim() || "";
  const finalText = run.text.trim();
  if (!streamed) return finalText;
  if (!finalText || streamed.includes(finalText)) return streamed;
  return `${streamed}\n\n${finalText}`;
}

function taskMode(card: TaskCard): string {
  return card.developmentMode || "standard";
}

function buildRequirements(card: TaskCard): string {
  return [
    `# ${card.title}`,
    "",
    card.note || card.title,
    "",
    "## Task configuration",
    "",
    `- Development mode: ${taskMode(card)}`,
    `- Status: ${card.status}`,
    `- Base branch: ${card.baseBranch || "project default"}`,
    `- Isolated worktree: ${card.useWorktree ? "yes" : "no"}`,
    `- Review before coding: ${card.requireReviewBeforeCoding ? "yes" : "no"}`,
    "",
  ].join("\n");
}

function buildImplementationPlan(card: TaskCard): string {
  if (card.developmentMode === "standard") {
    return ["# Implementation Plan", "", `Task: ${card.title}`, `Status: ${card.status}`, `Phase: ${card.phase || "idle"}`, "",
      ...(card.subtasks || []).flatMap(task => {
        const runs = (card.runs || []).filter(run => run.subtaskId === task.id);
        return [`## ${task.definitionId || task.id} ${task.title}`, `- Status: ${task.status}`,
          `- Source: tasks.md#${task.definitionId || task.id}`, `- Attempts: ${runs.length}`,
          ...runs.flatMap(run => [`- Started: ${iso(run.startedAt)}`, `- Completed: ${iso(run.completedAt)}`,
            `- Duration: ${Math.max(0, run.completedAt - run.startedAt)} ms`, ...(run.error ? [`- Failure: ${run.error}`] : [])]),
          "", task.summary || "", ""];
      }), ""].join("\n");
  }
  const workItems = card.subtasks?.length
    ? card.subtasks.map((subtask) => {
        const checked = subtask.status === "completed" ? "x" : " ";
        return `- [${checked}] ${subtask.title}`;
      })
    : [
        card.developmentMode === "direct"
          ? "- [ ] Complete the task directly in the selected workspace"
          : "- [ ] Implementation plan has not been generated",
      ];
  return [
    "# Implementation Plan",
    "",
    `**Task:** ${card.title}`,
    `**Status:** ${card.status}`,
    `**Execution phase:** ${card.phase || "idle"}`,
    "",
    "## Plan",
    "",
    card.plan?.trim() || "This task uses direct execution and does not require a generated plan.",
    "",
    "## Work items",
    "",
    ...workItems,
    "",
  ].join("\n");
}

function runModel(card: TaskCard, runPhase: TaskRunRecord["phase"]) {
  const selection =
    runPhase === "planning"
      ? card.planningModelSelection || card.modelSelection
      : runPhase === "reviewing"
        ? card.reviewModelSelection || card.modelSelection
        : card.modelSelection;
  const provider = selection?.providerId;
  const modelId = selection?.modelOverride || selection?.label || card.model;
  return provider || modelId
    ? {
        ...(provider ? { provider } : {}),
        ...(modelId ? { modelId } : {}),
      }
    : undefined;
}

function buildTaskLogs(card: TaskCard, stream: RunnerTaskStream | null): string {
  const now = Date.now();
  const updatedAt = stream ? now : card.updatedAt;
  const records: unknown[] = [
    {
      record_type: "meta",
      spec_id: card.id,
      created_at: iso(card.createdAt),
      updated_at: iso(updatedAt),
    },
  ];

  for (const phase of TASK_PHASES) {
    const runs = (card.runs || []).filter((run) => logPhase(run.phase) === phase);
    const live = stream && logPhase(stream.phase) === phase ? stream : null;
    const latest = runs.at(-1);
    const status: TaskLogStatus = live
      ? "active"
      : latest?.error
        ? "failed"
        : latest
          ? "completed"
          : "pending";
    const startedAt = runs[0]?.startedAt ?? live?.startedAt ?? null;
    const completedAt = status === "completed" || status === "failed"
      ? latest?.completedAt ?? null
      : null;
    records.push({
      record_type: "phase",
      timestamp: iso(completedAt ?? startedAt ?? updatedAt),
      phase,
      status,
      started_at: startedAt ? iso(startedAt) : null,
      completed_at: completedAt ? iso(completedAt) : null,
    });

    for (const run of runs) {
      const model = runModel(card, run.phase);
      records.push({
        record_type: "entry",
        entry: {
          timestamp: iso(run.startedAt),
          type: "phase_start",
          content: `${phaseLabel(phase)} started`,
          phase,
          ...(model ? { model } : {}),
          ...(run.subtaskId ? { subtask_id: run.subtaskId } : {}),
        },
      });
      const output = runOutput(run);
      if (output) {
        records.push({
          record_type: "entry",
          entry: {
            timestamp: iso(run.completedAt),
            type: "text",
            content: output,
            phase,
            ...(model ? { model } : {}),
            ...(run.subtaskId ? { subtask_id: run.subtaskId } : {}),
          },
        });
      }
      if (run.error) {
        records.push({
          record_type: "entry",
          entry: {
            timestamp: iso(run.completedAt),
            type: "error",
            content: run.error,
            phase,
            ...(run.subtaskId ? { subtask_id: run.subtaskId } : {}),
          },
        });
      }
      records.push({
        record_type: "entry",
        entry: {
          timestamp: iso(run.completedAt),
          type: "phase_end",
          content: run.error
            ? `${phaseLabel(phase)} failed`
            : `${phaseLabel(phase)} completed`,
          phase,
          ...(run.subtaskId ? { subtask_id: run.subtaskId } : {}),
        },
      });
    }

    if (live) {
      records.push({
        record_type: "entry",
        entry: {
          timestamp: iso(live.startedAt),
          type: "phase_start",
          content: `${phaseLabel(phase)} started`,
          phase,
        },
      });
      if (live.text.trim()) {
        records.push({
          record_type: "entry",
          entry: {
            timestamp: iso(now),
            type: "text",
            content: live.text,
            phase,
          },
        });
      }
    }
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function buildDirectSummary(card: TaskCard, stream: RunnerTaskStream | null): string {
  const latest = [...(card.runs || [])]
    .reverse()
    .find((run) => run.phase === "executing");
  const output = stream?.phase === "executing"
    ? stream.text
    : latest?.text || latest?.streamText || "";
  return [
    "# Direct Task Summary",
    "",
    `## ${card.title}`,
    "",
    output.trim() || "The direct task is waiting for model output.",
    "",
  ].join("\n");
}

/** Build the same task-scoped artifact family that Autocode exposes in TaskFiles. */
export function buildTaskArtifactFiles(
  card: TaskCard,
  stream: RunnerTaskStream | null,
): TaskArtifactFileInput[] {
  const metadata = {
    taskTitle: card.title,
    taskDescription: card.note,
    taskStatus: card.status,
    executionPhase: card.phase || "idle",
    developmentMode: taskMode(card),
    createdAt: iso(card.createdAt),
    updatedAt: iso(card.updatedAt),
    ...(card.baseBranch ? { baseBranch: card.baseBranch } : {}),
    ...(card.executionCwd ? { executionCwd: card.executionCwd } : {}),
  };
  const files: TaskArtifactFileInput[] = [
    { name: "requirements.md", content: buildRequirements(card) },
    { name: "implementation_plan.md", content: buildImplementationPlan(card) },
    { name: "task_logs.jsonl", content: buildTaskLogs(card, stream) },
    {
      name: "task_metadata.json",
      content: `${JSON.stringify(metadata, null, 2)}\n`,
    },
  ];
  if (card.developmentMode === "standard" && card.plan) {
    const documents = standardPlanDocuments(card.plan);
    for (const [name, source] of Object.entries(documents)) {
      // Definitions remain static; only implementation_plan.md contains runtime progress.
      const content = name === "tasks.md" ? source.replace(/\[[xX]\]/g, "[ ]") : source;
      const existing = files.find(file => file.name === name);
      if (existing) existing.content = content;
      else files.push({ name, content });
    }
  }
  const review = card.runs?.filter(run => run.phase === "reviewing").at(-1);
  if (review) files.push({ name: "qa_report.md", content: review.text });
  if (card.developmentMode === "direct") {
    files.push({
      name: "direct_summary.md",
      content: buildDirectSummary(card, stream),
    });
  }
  return files;
}

/** Persist and return this task's specsPath. Browser tests keep their in-memory fallback. */
export async function syncTaskArtifacts(
  projectRoot: string,
  card: TaskCard,
  stream: RunnerTaskStream | null,
): Promise<string | null> {
  if (!projectRoot.trim() || !tauriAvailable()) return card.specsPath || null;
  const result = await syncTaskArtifactFiles(
    projectRoot,
    card.id,
    buildTaskArtifactFiles(card, stream),
  );
  return result.rootPath;
}
