import { useMemo } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  FileCode2,
  Search,
  Terminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Locale } from "@/lib/i18n";
import type { TaskCard, TaskRunRecord } from "@/lib/taskBoard";
import type { RunnerTaskStream } from "@/lib/taskBoardRunner";

const TOOL_OPEN = "<<UGS_TOOL>>";
const TOOL_CLOSE = "<<UGS_TOOL_END>>";

type ToolStatus = "running" | "done" | "error";

export interface RuntimeToolActivity {
  id: string;
  name: string;
  subject?: string;
  status: ToolStatus;
  args?: unknown;
  result?: string;
  durationMs?: number;
  truncated?: boolean;
  ephemeral?: boolean;
}

export type RuntimeOutputEntry =
  | { type: "text"; content: string }
  | { type: "tool"; tool: RuntimeToolActivity };

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toolStatus(value: unknown): ToolStatus {
  return value === "done" || value === "error" ? value : "running";
}

function patchTool(
  previous: RuntimeToolActivity | undefined,
  patch: Record<string, unknown>,
  fallbackId: string,
): RuntimeToolActivity {
  const id = stringValue(patch.id) || previous?.id || fallbackId;
  return {
    id,
    name: stringValue(patch.name) || previous?.name || "Tool",
    status:
      patch.status === undefined
        ? previous?.status || "running"
        : toolStatus(patch.status),
    ...(stringValue(patch.subject) || previous?.subject
      ? { subject: stringValue(patch.subject) || previous?.subject }
      : {}),
    ...(patch.args !== undefined || previous?.args !== undefined
      ? { args: patch.args ?? previous?.args }
      : {}),
    ...(stringValue(patch.result) || previous?.result
      ? { result: stringValue(patch.result) || previous?.result }
      : {}),
    ...(numberValue(patch.durationMs) ?? previous?.durationMs) !== undefined
      ? { durationMs: numberValue(patch.durationMs) ?? previous?.durationMs }
      : {},
    ...(booleanValue(patch.truncated) ?? previous?.truncated) !== undefined
      ? { truncated: booleanValue(patch.truncated) ?? previous?.truncated }
      : {},
    ...(booleanValue(patch.ephemeral) ?? previous?.ephemeral) !== undefined
      ? { ephemeral: booleanValue(patch.ephemeral) ?? previous?.ephemeral }
      : {},
  };
}

/**
 * Convert the native CLI bridge's append-only text protocol into display
 * entries. Tool completion patches update the original row by id, so a tool
 * call never appears twice while it is streaming.
 */
export function parseTaskRuntimeOutput(source: string): RuntimeOutputEntry[] {
  const entries: RuntimeOutputEntry[] = [];
  const toolIndexes = new Map<string, number>();

  const appendText = (value: string) => {
    const content = value.trim();
    if (!content) return;
    const prior = entries.at(-1);
    if (prior?.type === "text") {
      prior.content = `${prior.content}\n${content}`;
    } else {
      entries.push({ type: "text", content });
    }
  };

  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(TOOL_OPEN, cursor);
    if (start < 0) {
      appendText(source.slice(cursor));
      break;
    }
    appendText(source.slice(cursor, start));
    const bodyStart = start + TOOL_OPEN.length;
    const end = source.indexOf(TOOL_CLOSE, bodyStart);
    if (end < 0) {
      appendText(source.slice(start));
      break;
    }

    const raw = source.slice(bodyStart, end);
    let patch: Record<string, unknown> | null = null;
    try {
      patch = objectRecord(JSON.parse(raw));
    } catch {
      patch = null;
    }
    if (!patch) {
      appendText(source.slice(start, end + TOOL_CLOSE.length));
      cursor = end + TOOL_CLOSE.length;
      continue;
    }

    const id = stringValue(patch.id) || `tool-${entries.length}`;
    const existingIndex = toolIndexes.get(id);
    if (existingIndex === undefined) {
      toolIndexes.set(id, entries.length);
      entries.push({ type: "tool", tool: patchTool(undefined, patch, id) });
    } else {
      const existing = entries[existingIndex];
      if (existing.type === "tool") {
        entries[existingIndex] = {
          type: "tool",
          tool: patchTool(existing.tool, patch, id),
        };
      }
    }
    cursor = end + TOOL_CLOSE.length;
  }

  return entries;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function toolIcon(name: string): LucideIcon {
  if (/bash|shell|command|terminal|powershell|exec/i.test(name)) return Terminal;
  if (/read|write|edit|file|patch/i.test(name)) return FileCode2;
  if (/search|grep|glob|find/i.test(name)) return Search;
  return Wrench;
}

function ToolActivity({ tool }: { tool: RuntimeToolActivity }) {
  const Icon = toolIcon(tool.name);
  const StatusIcon =
    tool.status === "done"
      ? CheckCircle2
      : tool.status === "error"
        ? XCircle
        : Circle;
  const hasDetail = tool.args !== undefined || !!tool.result;
  const row = (
    <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
      <Icon size={14} className="shrink-0 text-accent" />
      <span className="shrink-0 font-medium text-fg">{tool.name}</span>
      {tool.subject && (
        <span className="min-w-0 flex-1 truncate text-fg-dim" title={tool.subject}>
          {tool.subject}
        </span>
      )}
      {tool.durationMs !== undefined && (
        <span className="shrink-0 tabular-nums text-fg-dim">
          {formatDuration(tool.durationMs)}
        </span>
      )}
      <span
        className={`inline-flex shrink-0 items-center gap-1 ${
          tool.status === "error"
            ? "text-red-400"
            : tool.status === "done"
              ? "text-[#3fb950]"
              : "text-amber-300"
        }`}
      >
        <StatusIcon
          size={13}
          className={tool.status === "running" ? "animate-pulse fill-current/20" : ""}
        />
        {tool.status === "running"
          ? "运行中"
          : tool.status === "error"
            ? "失败"
            : ""}
      </span>
      {hasDetail && <ChevronRight size={13} className="shrink-0 text-fg-dim" />}
    </div>
  );

  if (!hasDetail) {
    return <div className="overflow-hidden rounded-md border border-border bg-panel-2/40">{row}</div>;
  }
  return (
    <details className="group overflow-hidden rounded-md border border-border bg-panel-2/40">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        {row}
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2">
        {tool.args !== undefined && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 text-[11px] text-fg-dim">
            {typeof tool.args === "string"
              ? tool.args
              : JSON.stringify(tool.args, null, 2)}
          </pre>
        )}
        {tool.result && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 text-[11px] text-fg-dim">
            {tool.result}
            {tool.truncated ? "\n…" : ""}
          </pre>
        )}
      </div>
    </details>
  );
}

function MarkdownOutput({ source }: { source: string }) {
  const parts = useMemo(() => {
    const result: Array<{ thinking: boolean; text: string }> = [];
    const expression = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
    let cursor = 0;
    for (const match of source.matchAll(expression)) {
      const index = match.index ?? cursor;
      if (index > cursor) {
        result.push({ thinking: false, text: source.slice(cursor, index) });
      }
      result.push({ thinking: true, text: match[1] || "" });
      cursor = index + match[0].length;
    }
    if (cursor < source.length) {
      result.push({ thinking: false, text: source.slice(cursor) });
    }
    return result.filter((part) => part.text.trim());
  }, [source]);

  return (
    <div className="space-y-2">
      {parts.map((part, index) =>
        part.thinking ? (
          <details
            key={index}
            className="rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs"
          >
            <summary className="cursor-pointer text-violet-300">思考过程</summary>
            <div className="mt-2 whitespace-pre-wrap break-words text-fg-dim">
              {part.text.trim()}
            </div>
          </details>
        ) : (
          <div
            key={index}
            className="break-words text-sm leading-relaxed text-fg [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1 [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-bg [&_pre]:p-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:p-1.5"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text.trim()}</ReactMarkdown>
          </div>
        ),
      )}
    </div>
  );
}

export function RuntimeOutput({ source }: { source: string }) {
  const entries = useMemo(() => parseTaskRuntimeOutput(source), [source]);
  return (
    <div className="space-y-2">
      {entries.map((entry, index) =>
        entry.type === "tool" ? (
          <ToolActivity key={`tool-${entry.tool.id}`} tool={entry.tool} />
        ) : (
          <MarkdownOutput key={`text-${index}`} source={entry.content} />
        ),
      )}
    </div>
  );
}

/**
 * Native adapters do not all mirror the final assistant message into their
 * incremental stream. Keep tool activity and also retain the canonical final
 * response so a completed Direct run can never render as an empty log.
 */
export function taskRunCapturedOutput(run: TaskRunRecord): string {
  const streamed = run.streamText?.trim() || "";
  const finalText = run.text.trim();
  if (!streamed) return finalText;
  if (!finalText || streamed.includes(finalText)) return streamed;
  return `${streamed}\n\n${finalText}`;
}

const PHASE_LABELS: Record<TaskRunRecord["phase"], string> = {
  planning: "生成计划",
  executing: "编写代码",
  reviewing: "QA 审核",
};

const THINKING_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
} as const;

function modelLabel(card: TaskCard, phase: TaskRunRecord["phase"]): string | null {
  const selection =
    phase === "planning"
      ? card.planningModelSelection || card.modelSelection
      : phase === "reviewing"
        ? card.reviewModelSelection || card.modelSelection
        : card.modelSelection;
  const model = selection?.label || selection?.modelOverride || card.model;
  const provider = selection?.providerId;
  return [provider, model].filter(Boolean).join(" · ") || null;
}

function RunLog({
  card,
  run,
  locale,
  initiallyOpen,
}: {
  card: TaskCard;
  run: TaskRunRecord;
  locale: Locale;
  initiallyOpen: boolean;
}) {
  const duration = Math.max(0, run.completedAt - run.startedAt);
  const captured = taskRunCapturedOutput(run);
  const runtimeModel = modelLabel(card, run.phase);
  return (
    <details
      open={initiallyOpen || undefined}
      className="overflow-hidden rounded-lg border border-border bg-[#ffffff]/[0.01]"
    >
      <summary className="cursor-pointer list-none px-3 py-2.5 text-xs text-fg-dim [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-fg">{PHASE_LABELS[run.phase]}</span>
        {run.subtaskTitle ? ` · ${run.subtaskTitle}` : ""} ·{" "}
        {new Date(run.startedAt).toLocaleString(locale)} · {formatDuration(duration)}
        {run.thinkingLevel ? ` · 思考${THINKING_LABELS[run.thinkingLevel]}` : ""}
        {run.totalTokens ? ` · ${run.totalTokens} Token` : ""}
        {runtimeModel ? ` · ${runtimeModel}` : ""}
      </summary>
      <div className="space-y-2 border-t border-border p-3">
        {captured ? <RuntimeOutput source={captured} /> : null}
        {run.error && (
          <p className="rounded-md border border-red-500/25 bg-red-500/10 p-2 text-xs text-red-300">
            {run.error}
          </p>
        )}
      </div>
    </details>
  );
}

export default function TaskRuntimeLogs({
  card,
  stream,
  active,
  locale,
  onClear,
}: {
  card: TaskCard;
  stream: RunnerTaskStream | null;
  active: boolean;
  locale: Locale;
  onClear: () => void;
}) {
  const livePhase: TaskRunRecord["phase"] =
    stream?.phase ??
    (card.phase === "planning"
      ? "planning"
      : card.phase === "reviewing"
        ? "reviewing"
        : "executing");
  const runtimeModel = modelLabel(card, livePhase);
  const runs = card.runs || [];

  return (
    <section aria-label="任务运行日志" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            大模型输出 {active && <span className="text-accent">· 实时</span>}
          </h3>
          {runtimeModel && (
            <p className="mt-0.5 truncate text-[11px] text-fg-dim">{runtimeModel}</p>
          )}
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs hover:bg-panel-2 disabled:opacity-40"
          disabled={active}
          onClick={onClear}
        >
          清空日志
        </button>
      </div>

      {runs.map((run, index) => (
        <RunLog
          key={`${run.startedAt}-${index}`}
          card={card}
          run={run}
          locale={locale}
          initiallyOpen={!stream && index === runs.length - 1}
        />
      ))}

      {active && (
        <div
          role="log"
          aria-live="polite"
          className="space-y-3 rounded-lg border border-[#58a6ff]/30 bg-[#58a6ff]/[0.03] p-4"
        >
          {stream?.text ? (
            <RuntimeOutput source={stream.text} />
          ) : (
            <div className="flex items-center gap-2 text-sm text-fg-dim">
              <Circle size={12} className="animate-pulse fill-accent text-accent" />
              大模型正在工作，开始回复后会在这里显示输出。
            </div>
          )}
        </div>
      )}

      {!active && !stream && runs.length === 0 && (
        <p className="py-12 text-center text-sm text-fg-dim">暂无大模型输出</p>
      )}
    </section>
  );
}
