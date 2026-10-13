import { useMemo, useState } from 'react';
import { Save, Trash2, X } from 'lucide-react';
import type {
  ScheduledTaskConfig,
  ScheduledTaskWeekday,
} from '@/store/types';
import { t, type Locale } from '@/lib/i18n';

interface ScheduledTaskDialogProps {
  locale: Locale;
  title: string;
  initialTask?: ScheduledTaskConfig;
  onSave: (task: ScheduledTaskConfig) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onClose: () => void;
}

const WEEKDAY_ORDER: ScheduledTaskWeekday[] = [1, 2, 3, 4, 5, 6, 0];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function defaultTask(title: string): ScheduledTaskConfig {
  const now = new Date();
  return {
    enabled: true,
    reminderText: title,
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: 0,
    weekdays: WEEKDAY_ORDER,
    repeat: true,
    remindOnRun: true,
    updatedAt: Date.now(),
  };
}

function weekdayLabel(locale: Locale, weekday: ScheduledTaskWeekday): string {
  if (weekday === 1) return t(locale, 'schedule.weekdayMon');
  if (weekday === 2) return t(locale, 'schedule.weekdayTue');
  if (weekday === 3) return t(locale, 'schedule.weekdayWed');
  if (weekday === 4) return t(locale, 'schedule.weekdayThu');
  if (weekday === 5) return t(locale, 'schedule.weekdayFri');
  if (weekday === 6) return t(locale, 'schedule.weekdaySat');
  return t(locale, 'schedule.weekdaySun');
}

export default function ScheduledTaskDialog({
  locale,
  title,
  initialTask,
  onSave,
  onDelete,
  onClose,
}: ScheduledTaskDialogProps) {
  const seed = useMemo(
    () => initialTask ?? defaultTask(title),
    [initialTask, title],
  );
  const [enabled, setEnabled] = useState(seed.enabled);
  const [reminderText, setReminderText] = useState(seed.reminderText);
  const [hour, setHour] = useState(seed.hour);
  const [minute, setMinute] = useState(seed.minute);
  const [second, setSecond] = useState(seed.second);
  const [weekdays, setWeekdays] = useState<ScheduledTaskWeekday[]>(
    seed.weekdays,
  );
  const [repeat, setRepeat] = useState(seed.repeat);
  const [remindOnRun, setRemindOnRun] = useState(seed.remindOnRun);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleWeekday = (weekday: ScheduledTaskWeekday) => {
    setWeekdays((current) =>
      current.includes(weekday)
        ? current.filter((item) => item !== weekday)
        : WEEKDAY_ORDER.filter((item) => [...current, weekday].includes(item)),
    );
    setError(null);
  };

  const save = async () => {
    const text = reminderText.trim();
    if (!text) {
      setError(t(locale, 'schedule.errorTextRequired'));
      return;
    }
    if (weekdays.length === 0) {
      setError(t(locale, 'schedule.errorWeekdayRequired'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        enabled,
        reminderText: text,
        hour: clampInt(hour, 0, 23),
        minute: clampInt(minute, 0, 59),
        second: clampInt(second, 0, 59),
        weekdays,
        repeat,
        remindOnRun,
        updatedAt: Date.now(),
        ...(seed.lastRunAt ? { lastRunAt: seed.lastRunAt } : {}),
      });
      onClose();
    } catch {
      setError(t(locale, 'schedule.errorSave'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch {
      setError(t(locale, 'schedule.errorSave'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <button
        type="button"
        aria-label={t(locale, 'common.close')}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <section className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-fg">
              {t(locale, 'schedule.title')}
            </h2>
            <p className="truncate text-xs text-fg-faint">{title}</p>
          </div>
          <button
            type="button"
            aria-label={t(locale, 'common.close')}
            onClick={onClose}
            className="rounded p-1.5 text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2">
            <span className="text-sm text-fg">{t(locale, 'schedule.enabledLabel')}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-fg-dim">
              {t(locale, 'schedule.reminderTextLabel')}
            </span>
            <textarea
              value={reminderText}
              onChange={(e) => {
                setReminderText(e.target.value);
                setError(null);
              }}
              rows={3}
              maxLength={500}
              placeholder={t(locale, 'schedule.reminderTextPlaceholder')}
              className="resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent"
            />
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-fg-dim">
              {t(locale, 'schedule.timeLabel')}
            </legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberField
                label={t(locale, 'schedule.hour')}
                max={23}
                value={hour}
                onChange={setHour}
              />
              <NumberField
                label={t(locale, 'schedule.minute')}
                max={59}
                value={minute}
                onChange={setMinute}
              />
              <NumberField
                label={t(locale, 'schedule.second')}
                max={59}
                value={second}
                onChange={setSecond}
              />
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-fg-dim">
              {t(locale, 'schedule.weekdaysLabel')}
            </legend>
            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAY_ORDER.map((weekday) => {
                const selected = weekdays.includes(weekday);
                return (
                  <button
                    key={weekday}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleWeekday(weekday)}
                    className={
                      'rounded-md border px-0 py-2 text-xs transition-colors ' +
                      (selected
                        ? 'border-accent bg-accent/20 text-accent'
                        : 'border-border bg-bg text-fg-faint hover:border-accent/70 hover:text-fg')
                    }
                  >
                    {weekdayLabel(locale, weekday)}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2">
            <span className="text-sm text-fg">{t(locale, 'schedule.repeatLabel')}</span>
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => setRepeat(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2">
            <span className="text-sm text-fg">
              {t(locale, 'schedule.remindOnRunLabel')}
            </span>
            <input
              type="checkbox"
              checked={remindOnRun}
              onChange={(e) => setRemindOnRun(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
          </label>

          {error && <p className="text-sm text-status-error">{error}</p>}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border-soft px-4 py-3">
          <button
            type="button"
            disabled={!initialTask || saving}
            onClick={remove}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg-dim transition-colors hover:border-status-error/70 hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={14} />
            <span>{t(locale, 'schedule.delete')}</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-md border border-border px-3 py-2 text-sm text-fg-dim transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
            >
              {t(locale, 'common.cancel')}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="inline-flex items-center gap-2 rounded-md border border-accent/50 bg-accent/15 px-3 py-2 text-sm text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-60"
            >
              <Save size={14} />
              <span>{t(locale, 'common.save')}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function NumberField({
  label,
  max,
  value,
  onChange,
}: {
  label: string;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg-faint">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clampInt(Number(e.target.value), 0, max))}
        className="rounded-md border border-border bg-bg px-2 py-2 text-center font-mono text-sm text-fg outline-none transition-colors focus:border-accent"
      />
    </label>
  );
}
