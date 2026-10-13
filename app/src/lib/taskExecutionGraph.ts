import type { TaskCard } from "./taskBoard";
import { orderStandardSubtasks } from "./standardPlan";

export function formatTaskDuration(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}

export function executionGraph(card: TaskCard) {
  const tasks = card.subtasks || [];
  let error = "";
  let ordered = tasks;
  try { ordered = orderStandardSubtasks(tasks); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const levels = new Map<string, number>();
  const rows = new Map<number, number>();
  const edges: { from: string; to: string }[] = [];
  const byDefinition = new Map(tasks.map(task => [task.definitionId || task.id, task.id]));
  const nodes = ordered.map(task => {
    const deps = (task.dependsOn || []).map(id => byDefinition.get(id)).filter((id): id is string => !!id);
    deps.forEach(id => edges.push({ from: id, to: task.id }));
    const level = error ? 0 : Math.max(0, ...deps.map(id => (levels.get(id) || 0) + 1));
    levels.set(task.id, level);
    const row = rows.get(level) || 0;
    rows.set(level, row + 1);
    const runs = (card.runs || []).filter(run => run.subtaskId === task.id);
    return { ...task, level, row, duration: runs.reduce((sum, run) => sum + Math.max(0, run.completedAt - run.startedAt), 0), attempts: runs.length };
  });
  return { nodes, edges, error, rounds: Math.max(0, ...nodes.map(node => node.level + 1)), maxParallel: Math.max(0, ...rows.values()) };
}

