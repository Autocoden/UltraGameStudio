import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronRight, Circle, ListTodo, X } from 'lucide-react';
import type { BackgroundJobDetail, ChatTask, ChatTaskProgress as Progress, ChatTaskStatus } from '@/lib/chatTasks';
import type { Locale } from '@/lib/i18n';
import type { OpenFileFn } from './FileChip';
import FileChip from './FileChip';
import TerminalLog from './TerminalLog';
import './ChatTaskProgress.css';

const labels = {
  'zh-CN': { pending: '待开始', running: '进行中', done: '已完成', error: '失败', cancelled: '已中断' },
  en: { pending: 'Pending', running: 'Running', done: 'Completed', error: 'Failed', cancelled: 'Interrupted' },
};

function RunningDots({ label }: { label?: string }) {
  return <svg data-ugs-task-spinner className="ugs-task-running-dots shrink-0 text-status-running" width="14" height="14" viewBox="0 0 16 16"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {Array.from({ length: 8 }, (_, index) => <circle key={index} cx="8" cy="2" r="1"
      transform={`rotate(${index * 45} 8 8)`} style={{ animationDelay: `${index * 0.1 - 0.8}s` }} />)}
  </svg>;
}

function Glyph({ status }: { status: ChatTaskStatus }) {
  if (status === 'running') return <RunningDots />;
  if (status === 'done') return <Check size={13} className="shrink-0 text-status-success" aria-hidden />;
  if (status === 'error') return <X size={13} className="shrink-0 text-status-error" aria-hidden />;
  return <Circle size={12} className="shrink-0 text-fg-faint" aria-hidden />;
}

export default function ChatTaskProgress({ progress, jobs = [], active, locale, onOpenFile, cwd }: {
  progress: Progress;
  jobs?: BackgroundJobDetail[];
  active: boolean;
  locale: Locale;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const zh = locale === 'zh-CN';
  const text = zh ? labels['zh-CN'] : labels.en;
  const tasks: ChatTask[] = progress.hasPlan ? progress.tasks : [];
  const completed = tasks.filter((task) => task.status === 'done').length;
  const failed = tasks.filter((task) => task.status === 'error').length + jobs.filter((job) => job.status === 'failed').length;
  const runningJob = jobs.find((job) => job.status === 'running');
  const currentTask = active ? tasks.find((task) => task.status === 'running') : undefined;
  const running = active || !!runningJob;
  const current = currentTask?.activeTitle || currentTask?.title || runningJob?.manifest.label
    || (zh ? '正在处理…' : 'Working…');
  const startedAt = progress.startedAt || runningJob?.manifest.startedAt || 0;
  useEffect(() => {
    if (!running) {
      setOpen(false);
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  useEffect(() => {
    if (!open || !running) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, running]);
  if (!running || (!tasks.length && !jobs.length)) return null;
  const duration = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const elapsed = duration < 60 ? `${duration}${zh ? '秒' : 's'}` : `${Math.floor(duration / 60)}${zh ? '分' : 'm'}${duration % 60}${zh ? '秒' : 's'}`;
  const status = failed ? 'error' : 'running';
  const displayStatus = (value: ChatTaskStatus): ChatTaskStatus => value === 'running' && !active ? 'cancelled' : value;
  return (
    <div ref={rootRef} data-ugs-chat-tasks data-status={status} className="relative z-30 mb-1 shrink-0 rounded-md border border-border-soft bg-panel text-xs">
      <button type="button" data-ugs-chat-tasks-toggle aria-expanded={open} aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="ugs-control flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-fg-dim hover:bg-border-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <ChevronRight size={13} className={open ? 'shrink-0 rotate-90' : 'shrink-0'} aria-hidden />
        <ListTodo size={14} className="shrink-0" aria-hidden />
        <span className="shrink-0 tabular-nums">{tasks.length > 0 ? `${zh ? '任务' : 'Tasks'} ${completed}/${tasks.length}` : (zh ? '进行中' : 'Running')}</span>
        <RunningDots label={zh ? '任务进行中' : 'Tasks running'} />
        {jobs.length > 0 && <span className="shrink-0 text-fg-faint">{zh ? '后台' : 'Jobs'} {jobs.filter((job) => job.status === 'success').length}/{jobs.length}</span>}
        <span className="min-w-0 flex-1 truncate" title={current}>{current}</span>
        {failed > 0 && <span className="shrink-0 text-status-error">{failed} {zh ? '失败' : 'failed'}</span>}
        {running && <span className="shrink-0 tabular-nums text-fg-faint" aria-label={zh ? '已运行时间' : 'Elapsed time'}>{elapsed}</span>}
        {runningJob?.percent != null && <span className="shrink-0 tabular-nums text-status-running">{runningJob.percent}%</span>}
      </button>
      <div id={bodyId} hidden={!open} data-ugs-chat-tasks-body
        className="absolute bottom-[calc(100%+0.25rem)] left-0 right-0 max-h-[min(24rem,55vh)] overflow-y-auto overscroll-contain rounded-md border border-border bg-panel p-2 shadow-2xl">
        {tasks.length > 0 && <div role="progressbar" aria-label={zh ? '任务完成进度' : 'Task completion'} aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={completed}
          className="mb-2 h-1 overflow-hidden rounded bg-border-soft"><div className="h-full bg-accent transition-[width]" style={{ width: `${tasks.length ? completed / tasks.length * 100 : 0}%` }} /></div>}
        <ul className="space-y-1">
          {tasks.map((task) => {
            const state = displayStatus(task.status);
            return <li key={task.id} data-task-status={state}>
              {task.detail ? <details className="group rounded hover:bg-border-soft">
                  <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                    <Glyph status={state} /><span className={'min-w-0 flex-1 break-words ' + (state === 'done' ? 'text-fg-faint line-through' : 'text-fg')}>{state === 'running' ? task.activeTitle || task.title : task.title}</span>
                    <span className="shrink-0 text-[10px] text-fg-faint">{text[state]}</span><ChevronRight size={12} className="shrink-0 group-open:rotate-90" aria-hidden />
                  </summary>
                  <p className="whitespace-pre-wrap break-words px-7 py-1.5 text-fg-dim">{task.detail || task.title}</p>
                </details> : <div className="flex min-h-8 items-center gap-2 rounded px-2">
                  <Glyph status={state} /><span className={'min-w-0 flex-1 break-words ' + (state === 'done' ? 'text-fg-faint line-through' : 'text-fg')}>{state === 'running' ? task.activeTitle || task.title : task.title}</span>
                  <span className="shrink-0 text-[10px] text-fg-faint">{text[state]}</span>
                </div>}
            </li>;
          })}
        </ul>
        {jobs.map((job) => {
          const state = job.status === 'success' ? 'done' : job.status === 'failed' ? 'error' : 'running';
          const artifact = job.manifest.done.artifactPath;
          return <details key={`${job.manifest.workspaceId}:${job.manifest.id}`} data-ugs-background-task data-task-status={state} className="group mt-2 rounded border border-border-soft">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
              <Glyph status={state} /><span className="min-w-0 flex-1 break-words">{job.manifest.label}</span>
              <span className="shrink-0 tabular-nums text-fg-faint">{text[state]}{job.percent == null ? '' : ` · ${job.percent}%`}</span>
              <ChevronRight size={12} className="shrink-0 group-open:rotate-90" aria-hidden />
            </summary>
            {job.percent != null && <div role="progressbar" aria-label={job.manifest.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent} className="mx-2 h-1 overflow-hidden rounded bg-border-soft"><div className="h-full bg-accent" style={{ width: `${job.percent}%` }} /></div>}
            <div className="p-2">
              {artifact && <div className="mb-2 flex items-center gap-2 text-fg-dim"><span>{zh ? '产物' : 'Artifact'}</span><FileChip refData={{ path: artifact, basename: artifact.replace(/\\/g, '/').split('/').pop()! }} onOpenFile={onOpenFile} cwd={cwd} /></div>}
              <TerminalLog text={job.progressTail || (zh ? '等待任务输出日志…' : 'Waiting for task output…')} streaming={state === 'running'} />
            </div>
          </details>;
        })}
      </div>
    </div>
  );
}
