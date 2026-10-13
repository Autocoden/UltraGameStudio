import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { FileActionsMenu, type FileActionItem } from './FileActionsMenu';

const MENU_WIDTH = 176;
const MENU_ITEM_HEIGHT = 30;
const MENU_VERTICAL_PADDING = 8;
const MENU_MARGIN = 8;

/** Estimated popup box — only used to keep the menu inside the viewport. */
function fileMenuHeight(itemCount: number): number {
  return itemCount * MENU_ITEM_HEIGHT + MENU_VERTICAL_PADDING;
}

function fileContextMenuPosition(
  event: ReactMouseEvent,
  itemCount: number,
): { x: number; y: number } {
  if (typeof window === 'undefined') {
    return { x: event.clientX, y: event.clientY };
  }
  return {
    x: Math.max(
      MENU_MARGIN,
      Math.min(event.clientX, window.innerWidth - MENU_WIDTH - MENU_MARGIN),
    ),
    y: Math.max(
      MENU_MARGIN,
      Math.min(
        event.clientY,
        window.innerHeight - fileMenuHeight(itemCount) - MENU_MARGIN,
      ),
    ),
  };
}

interface FileMenuState {
  x: number;
  y: number;
  items: FileActionItem[];
}

/**
 * Menu state for a file reference. `open` is meant to be called straight from an
 * `onContextMenu` handler; it positions the popup, clamps it into the viewport,
 * and installs the dismiss listeners (outside click, scroll, resize, Escape).
 *
 * Returns the menu element so callers can render `{element}` next to the chip —
 * one hook per file reference keeps the popup anchored to the element that was
 * actually right-clicked, including the thumbnail and folded variants.
 */
export function useFileActionsMenu() {
  const [menu, setMenu] = useState<FileMenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((event: ReactMouseEvent, items: FileActionItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ ...fileContextMenuPosition(event, items.length), items });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, close]);

  const element = menu ? (
    <FileActionsMenu
      x={menu.x}
      y={menu.y}
      items={menu.items}
      onDismiss={close}
    />
  ) : null;

  return { menu, open, close, element };
}
