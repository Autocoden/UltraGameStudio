import { FilePen, PanelRightOpen } from 'lucide-react';
import type { TurnFileChanges } from '@/lib/turnFileChanges';
import type { Locale } from '@/lib/i18n';

export default function SessionChangesSummary({ changes, locale, onOpenSessionFiles }: {
  changes?: TurnFileChanges;
  locale: Locale;
  onOpenSessionFiles: () => void;
}) {
  if (!changes?.files.length) return null;
  const zh = locale === 'zh-CN';
  const known = !changes.truncated && changes.files.every((file) => !file.binary && !file.truncated &&
    Number.isFinite(file.added) && Number.isFinite(file.deleted));
  const added = changes.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = changes.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  return (
    <div data-ugs-session-changes className="mb-2 shrink-0 text-xs">
      <button type="button" onClick={onOpenSessionFiles} aria-controls="ugs-project-file-panel"
        className="ugs-control flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-fg-dim hover:bg-border-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        title={(zh ? '打开右侧会话文件 · 当前会话累计改动' : 'Open session files · Cumulative session edits') +
          (!known ? (zh ? ' · 部分文件行数未知' : ' · Some line counts unavailable') : '')}>
        <FilePen size={14} className="shrink-0" />
        <span>{zh ? `已修改 ${changes.files.length} 个文件` : `${changes.files.length} edited files`}</span>
        <PanelRightOpen size={12} className="shrink-0" />
        <span className="ml-auto flex shrink-0 gap-3 font-mono tabular-nums">
          <span className="text-status-success" aria-label={zh ? '新增行数' : 'Added lines'}>+{known ? added : '—'}</span>
          <span className="text-status-error" aria-label={zh ? '删除行数' : 'Deleted lines'}>−{known ? deleted : '—'}</span>
        </span>
      </button>
    </div>
  );
}
