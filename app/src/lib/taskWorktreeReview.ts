import type { TaskCard } from "@/lib/taskBoard";

function normalizedPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Compare workspace paths without losing case sensitivity on POSIX paths. */
export function sameWorkspacePath(left: string, right: string): boolean {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  const windowsPath = /^(?:[a-z]:\/|\/\/)/i;
  return windowsPath.test(a) && windowsPath.test(b)
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export function taskAwaitsPlanApproval(card: TaskCard): boolean {
  return (
    card.status === "human_review" &&
    (card.developmentMode === "spec" || card.requireReviewBeforeCoding === true) &&
    card.planApproved !== true &&
    Boolean(card.plan)
  );
}

export function taskHasSeparateWorktree(
  card: TaskCard,
  mainRoot: string,
): boolean {
  return (
    card.useWorktree === true &&
    Boolean(card.executionCwd) &&
    !sameWorkspacePath(card.executionCwd || "", mainRoot) &&
    card.worktreeCleaned !== true
  );
}

export function taskRequiresWorktreeReview(
  card: TaskCard,
  mainRoot: string,
): boolean {
  return (
    card.status === "human_review" &&
    taskHasSeparateWorktree(card, mainRoot) &&
    !taskAwaitsPlanApproval(card)
  );
}
