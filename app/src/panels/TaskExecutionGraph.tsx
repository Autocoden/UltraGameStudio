import { useEffect, useId, useState } from "react";
import type { TaskCard } from "@/lib/taskBoard";
import { executionGraph, formatTaskDuration } from "@/lib/taskExecutionGraph";
import { cn } from "@/lib/cn";

export default function TaskExecutionGraph({ card, selectedId, onSelect, activeStartedAt }: {
  card: TaskCard; selectedId: string | null; onSelect: (id: string | null) => void; activeStartedAt?: number;
}) {
  const graph = executionGraph(card);
  const marker = useId().replace(/:/g, "");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!activeStartedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt]);
  const width = Math.max(420, 36 + graph.rounds * 148);
  const height = Math.max(118, 32 + graph.maxParallel * 56);
  const positions = new Map(graph.nodes.map(node => [node.id, { x: 18 + node.level * 148, y: 16 + node.row * 56 }]));
  return <section className="flex min-h-48 resize-y flex-col overflow-hidden border-b border-border bg-bg/25" style={{ height: 280 }} aria-label="子任务执行图" data-testid="subtask-execution-graph">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-xs">
      <h3 className="mr-auto text-sm font-semibold">子任务执行图</h3>
      <span>串行 {graph.nodes.length} 轮</span><span>依赖最短 {graph.rounds} 轮</span>
    </header>
    <div className="flex flex-wrap gap-3 px-4 py-2 text-[11px] text-fg-dim">
      <span>可并行上限 {graph.maxParallel}</span><span>理论节省 {Math.max(0, graph.nodes.length - graph.rounds)} 轮</span>
      <span>理论加速 {graph.rounds ? (graph.nodes.length / graph.rounds).toFixed(1) : "1.0"}×</span>
      <span>当前执行器：串行</span><span>连线表示真实任务依赖</span>
      {graph.error && <span role="alert" className="text-red-400">{graph.error}</span>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="relative rounded-md border border-border bg-bg" style={{ width, height }} onClick={() => onSelect(null)} data-testid="execution-graph-canvas">
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">
          <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor" /></marker></defs>
          {graph.edges.map(edge => {
            const from = positions.get(edge.from)!; const to = positions.get(edge.to)!;
            const selected = selectedId === edge.from || selectedId === edge.to;
            return <path key={`${edge.from}-${edge.to}`} data-edge-from={edge.from} data-edge-to={edge.to}
              d={`M ${from.x + 118} ${from.y + 21} C ${from.x + 134} ${from.y + 21}, ${to.x - 16} ${to.y + 21}, ${to.x} ${to.y + 21}`}
              fill="none" stroke={selected ? "#58a6ff" : "#6b7280"} strokeWidth={selected ? 2.3 : 1.5} markerEnd={`url(#${marker})`} />;
          })}
        </svg>
        {graph.nodes.map(node => {
          const duration = node.duration + (node.status === "in_progress" && activeStartedAt ? Math.max(0, now - activeStartedAt) : 0);
          const status = { pending: "待处理", in_progress: "进行中", completed: "已完成", failed: "失败" }[node.status];
          return <button key={node.id} type="button" aria-pressed={selectedId === node.id} aria-label={`查看子任务输出 ${node.definitionId || node.id} ${node.title}`}
            title={`${node.title}\n${status} · ${formatTaskDuration(duration)} · ${node.attempts} 次执行`}
            onClick={event => { event.stopPropagation(); onSelect(node.id); }}
            className={cn("absolute flex h-[42px] w-[118px] flex-col justify-center rounded-md border px-2 text-left text-[11px] shadow-sm",
              node.status === "completed" ? "border-emerald-500/50 bg-emerald-950 text-emerald-300" : node.status === "in_progress" ? "border-sky-500 bg-sky-950 text-sky-300" : node.status === "failed" ? "border-red-500 bg-red-950 text-red-300" : "border-border bg-panel text-fg-dim",
              selectedId === node.id && "ring-2 ring-sky-400")}
            style={{ left: positions.get(node.id)!.x, top: positions.get(node.id)!.y }}>
            <span className="w-full truncate font-semibold">{node.definitionId || `#${(card.subtasks || []).findIndex(task => task.id === node.id) + 1}`}</span>
            <span className="text-[10px] tabular-nums">{status}{duration > 0 || node.status === "in_progress" || node.attempts > 0 ? ` · ${formatTaskDuration(duration)}` : ""}</span>
          </button>;
        })}
      </div>
    </div>
  </section>;
}
