import { TASK_STATUSES, type TaskStatus } from "./taskBoard";

export interface ColumnPreference {
  width: number;
  collapsed: boolean;
  locked: boolean;
}
export type BoardPreferences = Record<TaskStatus, ColumnPreference>;
export function loadBoardPreferences(boardKey: string): BoardPreferences {
  let saved: Partial<BoardPreferences> = {};
  try {
    saved = JSON.parse(
      localStorage.getItem(`ugs.board.columns.${boardKey}`) || "{}",
    );
  } catch {
    /* defaults */
  }
  return Object.fromEntries(
    TASK_STATUSES.map((status) => {
      const value = saved?.[status];
      return [
        status,
        {
          width: Number.isFinite(value?.width)
            ? Math.min(600, Math.max(180, value!.width))
            : 320,
          collapsed: value?.collapsed === true,
          locked: value?.locked === true,
        },
      ];
    }),
  ) as BoardPreferences;
}
export function saveBoardPreferences(
  boardKey: string,
  preferences: BoardPreferences,
): void {
  localStorage.setItem(
    `ugs.board.columns.${boardKey}`,
    JSON.stringify(preferences),
  );
}
