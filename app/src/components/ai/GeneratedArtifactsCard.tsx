import { ChevronDown, FolderOpen } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { displayFileRefPath } from './lib/filePath';
import CopyButton from './CopyButton';
import { collectTurnArtifacts, type TurnArtifact } from '@/lib/turnArtifacts';
import type { OpenFileFn } from './FileChip';

export const MessageArtifacts = memo(function MessageArtifacts({ text, cwd, onOpenFile }: {
  text: string;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  const artifacts = useMemo(() => collectTurnArtifacts(text, cwd), [text, cwd]);
  return <GeneratedArtifactsCard artifacts={artifacts} cwd={cwd} onOpenFile={onOpenFile} />;
});

export default function GeneratedArtifactsCard({ artifacts, cwd, onOpenFile }: {
  artifacts: TurnArtifact[];
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  if (!artifacts.length) return null;
  return <section data-ugs-generated-artifacts="true" aria-label="生成物" className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
    {artifacts.map((artifact) => <ArtifactTile key={artifact.ref.path} artifact={artifact} cwd={cwd} onOpenFile={onOpenFile} />)}
  </section>;
}

function ArtifactTile({ artifact, cwd, onOpenFile }: { artifact: TurnArtifact; cwd?: string; onOpenFile?: OpenFileFn }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const path = displayFileRefPath(artifact.ref, cwd);
  const extension = artifact.ref.basename.split('.').pop()?.toUpperCase() ?? 'FILE';
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKeyDown); };
  }, [menuOpen]);
  return <div className="relative flex min-w-0 items-center gap-2 rounded-xl border border-border bg-panel-2/60 p-2.5">
    <button type="button" disabled={!onOpenFile} title={path} aria-label={`打开生成物：${artifact.ref.basename}`}
      data-file-preview-trigger="true"
      onClick={() => void onOpenFile?.(artifact.ref)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-panel font-mono text-[10px] font-bold text-accent">{extension}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-fg">{artifact.ref.basename}</span>
        <span className="mt-1 block truncate text-[10px] text-fg-dim">{artifact.label === artifact.ref.basename ? '点击预览文件' : artifact.label}</span>
      </span>
    </button>
    <span className="flex shrink-0 items-center rounded-md border border-border text-fg-dim">
      <button type="button" title="在文件夹中显示" aria-label={`在文件夹中显示：${artifact.ref.basename}`} disabled={!onOpenFile}
        onClick={() => void onOpenFile?.(artifact.ref, { reveal: true })} className="p-1.5 hover:text-fg"><FolderOpen size={13} /></button>
      <button type="button" title="文件操作" aria-label={`文件操作：${artifact.ref.basename}`} aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)} className="border-l border-border px-1 py-1.5 hover:text-fg"><ChevronDown size={11} /></button>
    </span>
    {menuOpen && <div role="menu" onPointerDown={(event) => event.stopPropagation()} className="absolute right-2 top-full z-20 mt-1 min-w-36 rounded-md border border-border bg-panel p-1 text-xs shadow-xl">
      <button type="button" role="menuitem" disabled={!onOpenFile} data-file-preview-trigger="true" onClick={() => { setMenuOpen(false); void onOpenFile?.(artifact.ref); }} className="block w-full rounded px-2 py-1.5 text-left text-fg-dim hover:bg-panel-2">预览文件</button>
      <CopyButton value={path} label="复制路径" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-fg-dim hover:bg-panel-2" />
    </div>}
  </div>;
}
