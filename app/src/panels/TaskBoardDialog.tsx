import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { t, type Locale } from '@/lib/i18n';
import {
  TASK_CATEGORIES,
  TASK_COMPLEXITIES,
  TASK_IMPACTS,
  TASK_PRIORITIES,
  type TaskCard,
  type TaskMeta,
  type TaskStatus,
} from '@/lib/taskBoard';

/**
 * CONTRACT: controlled create/edit dialog for the 任务看板, mirroring
 * Autocode's TaskCreationWizard form section: title (required), description,
 * and the 2×2 classification grid (category/priority/complexity/impact — all
 * optional, aligned with Autocode's ClassificationFields and zh labels).
 *
 * `mode: 'create'` starts a card in the given status; `mode: 'edit'` prefills
 * from the card. Cancel/Esc closes without side effects; blank titles keep the
 * dialog open.
 */
export interface TaskBoardDialogRequest {
  mode: 'create' | 'edit';
  status: TaskStatus;
  card?: TaskCard;
}

export default function TaskBoardDialog({
  locale,
  request,
  onClose,
  onSubmit,
}: {
  locale: Locale;
  request: TaskBoardDialogRequest;
  onClose: () => void;
  onSubmit: (values: { title: string; note: string; meta: TaskMeta }) => boolean;
}) {
  const editing = request.mode === 'edit' ? request.card : undefined;
  const [title, setTitle] = useState(editing?.title ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [meta, setMeta] = useState<TaskMeta>(() => ({
    category: editing?.category,
    priority: editing?.priority,
    complexity: editing?.complexity,
    impact: editing?.impact,
  }));
  const [error, setError] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const setMetaValue = (key: keyof TaskMeta, raw: string) => {
    setMeta((prev) => ({ ...prev, [key]: raw === '' ? undefined : (raw as never) }));
  };

  const submit = () => {
    if (!title.trim()) {
      setError(true);
      return;
    }
    if (onSubmit({ title, note, meta })) onClose();
  };

  const statusLabel = t(locale, `board.column.${request.status}`);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, editing ? 'board.dialog.editTitle' : 'board.dialog.createTitle')}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-panel shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">
            {t(locale, editing ? 'board.dialog.editTitle' : 'board.dialog.createTitle')}
            {editing ? null : (
              <span className="ml-2 text-xs font-normal text-fg-dim">
                {t(locale, 'board.dialog.intoStatus').replace('{status}', statusLabel)}
              </span>
            )}
          </h2>
          <button
            type="button"
            title={t(locale, 'board.edit.cancel')}
            aria-label={t(locale, 'board.edit.cancel')}
            onClick={onClose}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
          >
            <X size={15} aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="task-dialog-title" className="text-xs font-medium text-fg-dim">
              {t(locale, 'board.dialog.fieldTitle')}
            </label>
            <input
              id="task-dialog-title"
              ref={titleRef}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
              }}
              placeholder={t(locale, 'board.dialog.titlePlaceholder')}
              className={cn(
                'w-full rounded-md border bg-bg px-2.5 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none',
                error ? 'border-red-500' : 'border-border focus:border-accent',
              )}
            />
            {error && (
              <p className="text-[11px] text-red-400">{t(locale, 'board.dialog.titleRequired')}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="task-dialog-note" className="text-xs font-medium text-fg-dim">
              {t(locale, 'board.dialog.fieldDescription')}
            </label>
            <textarea
              id="task-dialog-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t(locale, 'board.dialog.descriptionPlaceholder')}
              rows={4}
              className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
            />
          </div>

          <div className="rounded-lg border border-border bg-panel-2/40 p-3">
            <p className="text-xs font-medium text-fg-dim">
              {t(locale, 'board.dialog.classification')}
            </p>
            <p className="mt-0.5 text-[11px] text-fg-faint">
              {t(locale, 'board.dialog.classificationHelp')}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ClassificationSelect
                id="task-dialog-category"
                label={t(locale, 'board.dialog.classificationLabel')}
                placeholder={t(locale, 'board.dialog.selectCategory')}
                value={meta.category ?? ''}
                options={TASK_CATEGORIES.map((value) => ({
                  value,
                  label: t(locale, `board.category.${value}`),
                }))}
                onChange={(raw) => setMetaValue('category', raw)}
              />
              <ClassificationSelect
                id="task-dialog-priority"
                label={t(locale, 'board.dialog.priorityLabel')}
                placeholder={t(locale, 'board.dialog.selectPriority')}
                value={meta.priority ?? ''}
                options={TASK_PRIORITIES.map((value) => ({
                  value,
                  label: t(locale, `board.priority.${value}`),
                }))}
                onChange={(raw) => setMetaValue('priority', raw)}
              />
              <ClassificationSelect
                id="task-dialog-complexity"
                label={t(locale, 'board.dialog.complexityLabel')}
                placeholder={t(locale, 'board.dialog.selectComplexity')}
                value={meta.complexity ?? ''}
                options={TASK_COMPLEXITIES.map((value) => ({
                  value,
                  label: t(locale, `board.complexity.${value}`),
                }))}
                onChange={(raw) => setMetaValue('complexity', raw)}
              />
              <ClassificationSelect
                id="task-dialog-impact"
                label={t(locale, 'board.dialog.impactLabel')}
                placeholder={t(locale, 'board.dialog.selectImpact')}
                value={meta.impact ?? ''}
                options={TASK_IMPACTS.map((value) => ({
                  value,
                  label: t(locale, `board.impact.${value}`),
                }))}
                onChange={(raw) => setMetaValue('impact', raw)}
              />
            </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
          >
            {t(locale, 'board.edit.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90"
          >
            {t(locale, editing ? 'board.edit.save' : 'board.dialog.create')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ClassificationSelect({
  id,
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (raw: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-medium text-fg-dim">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-border bg-bg px-1.5 text-xs text-fg focus:border-accent focus:outline-none"
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
