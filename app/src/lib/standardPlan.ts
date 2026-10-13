import type { TaskSubtask } from "./taskBoard";

export function standardPlanDocuments(report: string): Record<string, string> {
  const visible = report.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<<UGS_TOOL>>[\s\S]*?<<UGS_TOOL_END>>/g, "");
  const names: Record<string, string> = {
    requirements: "requirements.md", "需求": "requirements.md",
    spec: "spec.md", "规范": "spec.md", design: "design.md", "设计": "design.md",
    tasks: "tasks.md", "implementation tasks": "tasks.md", "任务": "tasks.md",
    "子任务": "tasks.md", "任务清单": "tasks.md", "实施任务": "tasks.md", "实施清单": "tasks.md",
  };
  const docs: Record<string, string> = {};
  let current: string | undefined;
  let fence = false;
  for (const line of visible.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; }
    const heading = !fence && line.match(/^#{1,2}\s+(?:\d+[.)、]?\s*)?(.+?)\s*[:：]?\s*$/);
    if (heading) {
      current = names[heading[1].replace(/\.md$/i, "").toLowerCase()];
      if (current) docs[current] = `# ${heading[1]}\n`;
    } else if (current) docs[current] += `${line}\n`;
  }
  return docs;
}

export function standardPlanIssues(report: string): string[] {
  const docs = standardPlanDocuments(report);
  return ["requirements.md", "spec.md", "design.md", "tasks.md"]
    .filter(name => !docs[name]?.replace(/^#.*\n/, "").trim())
    .map(name => `缺少 ${name} 正文`);
}

export function parseStandardSubtasks(cardId: string, report: string): TaskSubtask[] {
  const visible = report.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<<UGS_TOOL>>[\s\S]*?<<UGS_TOOL_END>>/g, "");
  const taskDoc = standardPlanDocuments(visible)["tasks.md"];
  const source = taskDoc || visible;
  const lines = source.split(/\r?\n/);
  const items: { indent: number; title: string; details: string[] }[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const match = line.match(/^(\s*)[-*+]\s+\[[ xX]\]\s+(.+)$/);
    if (match) items.push({ indent: match[1].length, title: match[2], details: [] });
    else items.at(-1)?.details.push(line);
  }
  if (!items.length && taskDoc) {
    for (const line of lines) {
      const match = line.match(/^\s*\d+[.)、]\s*(\S.*)$/);
      if (match) items.push({ indent: 0, title: match[1], details: [] });
    }
  }
  return items.filter((item, index) => !items[index + 1] || items[index + 1].indent <= item.indent)
    .map((item, index) => {
      const idMatch = item.title.match(/^((?:\d+\.)*\d+|[A-Z]+-\d+)[.)]?\s+(.+)$/);
      const definitionId = idMatch?.[1] || `T-${index + 1}`;
      const details = item.details.join("\n").trim();
      const deps = details.match(/(?:Depends on|依赖)\s*[:：]\s*([^\n]+)/i)?.[1].replace(/[_*`]/g, "").trim();
      return {
        id: `${cardId}-standard-${index}`, definitionId,
        title: idMatch?.[2] || item.title, description: details,
        dependsOn: deps ? deps.split(/[,，;；\s]+/).filter(id => id && !/^(none|无|无依赖)$/i.test(id)) : [],
        status: "pending" as const,
      };
    });
}

/** Stable topological order; missing references and cycles must block implementation. */
export function orderStandardSubtasks(tasks: TaskSubtask[]): TaskSubtask[] {
  const byId = new Map(tasks.map(task => [task.definitionId || task.id, task]));
  if (byId.size !== tasks.length) throw new Error("任务清单存在重复任务 ID");
  const ordered: TaskSubtask[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: TaskSubtask) => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error("任务清单存在循环依赖");
    visiting.add(task.id);
    for (const id of task.dependsOn || []) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error(`任务 ${task.definitionId || task.title} 的依赖 ${id} 不存在`);
      visit(dependency);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
}
