import type { CSSProperties } from 'react';
import {
  Check,
  Circle,
  CircleAlert,
  LoaderCircle,
  Pause,
  Pencil,
  Sparkles,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export type StatusTone =
  | 'thinking'
  | 'unrun'
  | 'running'
  | 'waiting'
  | 'draft'
  | 'success'
  | 'successUnread'
  | 'interrupted'
  | 'failed';

interface StatusIndicatorProps {
  tone?: StatusTone | null;
  label?: string;
  className?: string;
}

function statusColorStyle(color: string): CSSProperties {
  return { '--ugs-status-color': color } as CSSProperties;
}

const TONE_STYLE: Record<StatusTone, CSSProperties> = {
  thinking: statusColorStyle('var(--status-ai-edit)'),
  unrun: statusColorStyle('var(--fg-faint)'),
  running: statusColorStyle('var(--status-ai-edit)'),
  waiting: statusColorStyle('var(--status-warning)'),
  draft: statusColorStyle('var(--status-draft)'),
  success: statusColorStyle('var(--status-success)'),
  successUnread: statusColorStyle('var(--status-success)'),
  interrupted: statusColorStyle('var(--fg-dim)'),
  failed: statusColorStyle('var(--status-error)'),
};

const TONE_ICON: Record<StatusTone, LucideIcon> = {
  thinking: Sparkles,
  unrun: Circle,
  running: LoaderCircle,
  waiting: Pause,
  draft: Pencil,
  success: Check,
  successUnread: Check,
  interrupted: Square,
  failed: CircleAlert,
};

export default function StatusIndicator({
  tone = null,
  label,
  className,
}: StatusIndicatorProps) {
  const active = tone != null;
  const completed = tone === 'success' || tone === 'successUnread';
  const Icon = tone ? TONE_ICON[tone] : null;

  return (
    <span
      aria-hidden={!active}
      aria-label={active ? label : undefined}
      className={cn('ugs-status-slot', className)}
      data-status={tone ?? 'none'}
      role={active ? 'img' : undefined}
      title={active ? label : undefined}
    >
      {tone && Icon ? (
        <span
          aria-hidden="true"
          className={cn(
            'ugs-status-indicator',
            completed && 'ugs-status-check',
          )}
          style={TONE_STYLE[tone]}
        >
          <Icon size={14} strokeWidth={completed ? 2 : 1.8} focusable="false" />
        </span>
      ) : null}
      {tone === 'successUnread' ? (
        <span aria-hidden="true" className="ugs-status-unread" />
      ) : null}
    </span>
  );
}
