import { useState } from 'react';
import { ChevronDown, ChevronUp, FileCode2 } from 'lucide-react';
import { displayFileRefChipPath, displayFileRefPath, type FileRef } from './lib/filePath';
import type { OpenFileFn } from './FileChip';
import type { TurnFileChanges } from '@/lib/turnFileChanges';
import { t, type Locale } from '@/lib/i18n';

const STATUS_LABELS = {
  added: 'sessionFiles.statusAdded', modified: 'sessionFiles.statusModified',
  deleted: 'sessionFiles.statusDeleted', renamed: 'sessionFiles.statusRenamed',
} as const;

export default function EditedFilesCard({ changes, locale, cwd, onOpenFile }: {
  changes: TurnFileChanges;
  locale: Locale;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const [expanded, setExpanded] = useState(false);
  const files = changes.files;
  if (!files.length) return null;
  const allCountsKnown = files.every((file) => file.added != null && file.deleted != null);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  return (
    <section data-ugs-edited-files="true" aria-label={t(locale, 'sessionFiles.editedSummary')}
      className="mt-3 overflow-hidden rounded-xl border border-border bg-panel-2/60 text-xs">
      <div className="flex items-center gap-2.5 border-b border-border px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel text-accent">
          <FileCode2 size={18} />
        </span>
        <div className="min-w-0">
          <div className="font-medium text-fg">{t(locale, 'sessionFiles.editedCount').replace('{count}', String(files.length))}</div>
          {allCountsKnown && <div className="mt-1 flex gap-2 font-mono text-[10px] tabular-nums">
            <span className="text-emerald-400">+{added}</span><span className="text-red-400">-{deleted}</span>
          </div>}
        </div>
      </div>
      <div className={expanded ? 'max-h-72 overflow-y-auto' : ''}>
        {(expanded ? files : files.slice(0, 4)).map((file) => {
          const basename = file.path.replace(/\\/g, '/').split('/').pop() ?? file.path;
          const ref: FileRef = { path: file.path, basename };
          const root = changes.rootPath || cwd;
          return <button key={file.path} type="button" disabled={!onOpenFile || file.status === 'deleted'}
            data-file-preview-trigger="true"
            title={file.path} onClick={() => void onOpenFile?.({ ...ref, path: displayFileRefPath(ref, root) })}
            className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-fg-dim transition-colors hover:bg-panel disabled:cursor-default">
            <span className="min-w-0 flex-1 truncate">{displayFileRefChipPath(ref, root)}</span>
            {file.status && <span className="shrink-0 text-[10px] text-fg-faint">{t(locale, STATUS_LABELS[file.status])}</span>}
            {file.added != null && file.deleted != null && <span className="flex shrink-0 gap-2 font-mono text-[10px] tabular-nums">
              <span className="text-emerald-400">+{file.added}</span><span className="text-red-400">-{file.deleted}</span>
            </span>}
          </button>;
        })}
      </div>
      {files.length > 4 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 px-3 py-2 text-fg-dim hover:text-fg">
        {expanded ? t(locale, 'sessionFiles.collapseSummary') : t(locale, 'sessionFiles.allFiles').replace('{count}', String(files.length))}
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>}
      {(changes.source === 'snapshot' || changes.truncated) && <div className="border-t border-border px-3 py-2 text-[10px] text-fg-faint">
        {changes.truncated ? t(locale, 'sessionFiles.partialSummary') : t(locale, 'sessionFiles.snapshotSummary')}
      </div>}
    </section>
  );
}
