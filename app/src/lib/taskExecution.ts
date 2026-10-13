type TaskExecutionOwner = "runner" | "openspec";

const executions = new Map<string, TaskExecution>();
const listeners = new Set<(boardKey: string) => void>();

interface TaskExecution {
  owner: TaskExecutionOwner;
  controller: AbortController;
  release: () => void;
}

export function getTaskExecution(boardKey: string, cardId: string): TaskExecution | null {
  return executions.get(JSON.stringify([boardKey, cardId])) ?? null;
}

export function subscribeTaskExecutions(listener: (boardKey: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reserveTaskExecution(
  boardKey: string,
  cardId: string,
  owner: TaskExecutionOwner,
): TaskExecution | null {
  const key = JSON.stringify([boardKey, cardId]);
  if (executions.has(key)) return null;
  const execution: TaskExecution = {
    owner,
    controller: new AbortController(),
    release: () => {
      if (executions.get(key) !== execution) return;
      executions.delete(key);
      for (const listener of listeners) listener(boardKey);
    },
  };
  executions.set(key, execution);
  for (const listener of listeners) listener(boardKey);
  return execution;
}

export function __resetTaskExecutionsForTests(): void {
  executions.clear();
}
