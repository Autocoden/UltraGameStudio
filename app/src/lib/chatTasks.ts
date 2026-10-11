import { extractToolSentinels, mergeToolPatches, isChatTaskTool, type ToolEvent } from '@/components/ai/lib/toolEvent';
import type { Message } from '@/store/types';
import type { BackgroundJobManifest, BackgroundJobStatus } from './backgroundJobs';

export type ChatTaskStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface ChatTask {
  id: string;
  title: string;
  activeTitle?: string;
  status: ChatTaskStatus;
  detail?: string;
  event?: ToolEvent;
}

export interface BackgroundJobDetail {
  manifest: BackgroundJobManifest;
  status: BackgroundJobStatus;
  percent: number | null;
  progressTail: string;
  probedAt: number;
}

export interface ChatTaskProgress {
  tasks: ChatTask[];
  tools: ToolEvent[];
  startedAt: number;
  hasPlan: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return undefined; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function taskStatus(value: unknown): ChatTaskStatus {
  switch (String(value).replace(/[_-]/g, '').toLowerCase()) {
    case 'completed': case 'done': case 'success': return 'done';
    case 'inprogress': case 'running': return 'running';
    case 'failed': case 'error': return 'error';
    case 'deleted': case 'cancelled': case 'canceled': return 'cancelled';
    default: return 'pending';
  }
}

function toolName(name: string): string {
  return name.split(/[:./]/).at(-1)!.replace(/[_-]/g, '').toLowerCase();
}

function snapshotTasks(value: unknown, scope: string): ChatTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: ChatTask[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = object(value[index]);
    const title = entry?.step ?? entry?.content ?? entry?.text ?? entry?.subject ?? entry?.title;
    if (!entry || typeof title !== 'string' || !title.trim()) continue;
    tasks.push({
      id: `${scope}:${entry.id ?? index}`,
      title: title.trim(),
      activeTitle: typeof entry.activeForm === 'string' ? entry.activeForm : undefined,
      status: taskStatus(entry.status ?? (entry.completed === true ? 'completed' : 'pending')),
      detail: typeof entry.description === 'string' ? entry.description : undefined,
    });
  }
  // An explicit empty array clears the previous plan; malformed entries do not.
  return value.length === 0 || tasks.length > 0 ? tasks : undefined;
}

/** Read only this turn's native task events. Never infer a plan from assistant prose. */
export function collectChatTaskProgress(messages: Message[]): ChatTaskProgress {
  let turnStart = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user' && !messages[index].localOnly && !messages[index].interjected) {
      turnStart = index;
      break;
    }
  }
  const turn = messages.slice(turnStart + 1).filter((message) => message.role === 'assistant' && !message.localOnly);
  const patches = turn.flatMap((message) => extractToolSentinels(message.text, { streamingTail: true }).patches);
  const tools = mergeToolPatches(patches).filter((event) => !event.ephemeral && !event.parentId);
  const events = new Map(tools.map((event) => [event.id, event]));
  const plans = new Map<string, ChatTask[]>();
  const nativeTasks = new Map<string, ChatTask>();
  for (const patch of patches) {
    const event = events.get(patch.id);
    if (!event || event.status === 'error') continue;
    const args = object(patch.args) ?? {};
    const name = toolName(event.name);
    const scope = ['todowrite', 'todolist', 'todo'].includes(name) ? 'todos' : 'plan';
    if (['updateplan', 'todowrite', 'todolist', 'todo', 'plan'].includes(name)) {
      // A result is the authoritative full snapshot, including read-only calls and merge writes.
      const result = object(patch.result);
      const resultSnapshot = snapshotTasks(result?.plan ?? result?.todos ?? result?.items, scope);
      const values = args.plan ?? args.todos ?? args.items;
      if (resultSnapshot) plans.set(scope, resultSnapshot);
      else if (args.merge === true && Array.isArray(values)) {
        const merged = new Map((plans.get(scope) ?? []).map((task) => [task.id, task]));
        for (const value of values) {
          const entry = object(value);
          if (!entry || entry.id == null) continue;
          const id = `${scope}:${entry.id}`;
          const previous = merged.get(id);
          // Status-only writes retain the original title and position.
          const next = snapshotTasks([{ ...previous, ...entry }], scope)?.[0];
          if (next) merged.set(id, { ...previous, ...next,
            status: entry.status == null && previous ? previous.status : next.status });
        }
        plans.set(scope, [...merged.values()]);
      } else {
        const snapshot = snapshotTasks(values, scope);
        if (snapshot) plans.set(scope, snapshot);
      }
    } else if (name === 'taskcreate' && typeof args.subject === 'string') {
      const result = object(event.result);
      const id = String(result?.taskId ?? object(result?.task)?.id ?? result?.id
        ?? event.result?.match(/(?:Task\s*#|taskId["\s:]+)(\d+)/i)?.[1] ?? event.id);
      nativeTasks.set(id, { id: `task:${id}`, title: args.subject,
        activeTitle: typeof args.activeForm === 'string' ? args.activeForm : undefined,
        detail: typeof args.description === 'string' ? args.description : undefined,
        status: 'pending' });
    } else if (name === 'taskupdate') {
      const id = String(args.taskId ?? args.id ?? '');
      const previous = nativeTasks.get(id);
      if (!previous) continue;
      if (args.status === 'deleted') { nativeTasks.delete(id); continue; }
      nativeTasks.set(id, { ...previous,
        title: typeof args.subject === 'string' ? args.subject : previous.title,
        activeTitle: typeof args.activeForm === 'string' ? args.activeForm : previous.activeTitle,
        detail: typeof args.description === 'string' ? args.description : previous.detail,
        status: args.status == null ? previous.status : taskStatus(args.status) });
    }
  }
  const tasks = [...plans.values()].flat().concat([...nativeTasks.values()]);
  return { tasks, tools: tools.filter((event) => !isChatTaskTool(event.name)),
    startedAt: turnStart >= 0 ? messages[turnStart].createdAt : turn[0]?.createdAt ?? 0,
    hasPlan: plans.size > 0 || nativeTasks.size > 0 };
}
