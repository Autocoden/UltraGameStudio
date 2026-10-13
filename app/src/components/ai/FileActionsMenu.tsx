import type { ReactNode } from 'react';

export interface FileActionItem {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

/**
 * The right-click menu shared by every clickable file reference: the visible
 * chip, the folded chip that the per-message budget pushed out, and markdown
 * images. Keeping one implementation is what makes "打开所在目录" and
 * "在文件夹中显示" available no matter how a path happens to be decorated.
 *
 * Positioning and dismiss listeners live in `useFileActionsMenu`; this file
 * only paints the popup so React Fast Refresh keeps working.
 */
export function FileActionsMenu({
  x,
  y,
  items,
  onDismiss,
}: {
  x: number;
  y: number;
  items: FileActionItem[];
  onDismiss: () => void;
}) {
  return (
    <div
      role="menu"
      className="ai-file-chip-menu fixed z-[70] min-w-[176px] rounded-md border border-border bg-panel py-1 text-xs text-fg shadow-xl"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-file-action={item.key}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
            item.onSelect();
          }}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-border-soft"
        >
          {item.icon}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
