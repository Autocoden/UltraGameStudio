import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';

/** Low-frequency session options stay mounted so their values and menus survive. */
export default function ComposerOptions({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A nested selector gets the first Escape; a second closes these options.
      if (rootRef.current?.querySelector('[role="listbox"]')) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="ugs-composer-options relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-ugs-composer-options-trigger
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className="ugs-control flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-dim transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Settings2 size={15} strokeWidth={2} />
        <span>{label}</span>
      </button>
      <div
        id={id}
        hidden={!open}
        data-ugs-composer-options-panel
        role="region"
        aria-label={label}
        className="ugs-composer-options__panel absolute bottom-full left-0 z-50 mb-2 min-w-56 rounded-lg border border-border bg-panel p-3 shadow-xl"
      >
        <div className="mb-2 text-xs font-semibold text-fg-dim">{label}</div>
        <div className="flex flex-col items-start gap-2">{children}</div>
      </div>
    </div>
  );
}
