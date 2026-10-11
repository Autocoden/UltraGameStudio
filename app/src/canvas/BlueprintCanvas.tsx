import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
  type OnConnect,
  type OnNodeDrag,
  type OnNodesDelete,
  type OnEdgesDelete,
  type Viewport,
} from '@xyflow/react';
import {
  selectActiveScopeId,
  useStore,
  workflowReadOnlyReason,
} from '@/store/useStore';
import type { CanvasViewport } from '@/store/types';
import { DATA, EXEC, type NodeType, type PinKind } from '@/core/ir';
import { filterScope, irToFlow, type FlowEdge, type FlowNodeData } from './irToFlow';
import AgentNode from './nodes/AgentNode';
import ParallelNode from './nodes/ParallelNode';
import PipelineNode from './nodes/PipelineNode';
import ConsensusNode from './nodes/ConsensusNode';
import CompositeNode from './nodes/CompositeNode';
import ContainerNode from './nodes/ContainerNode';
import ControlNode from './nodes/ControlNode';
import CanvasToolbar from './CanvasToolbar';
import EdgeDefs from './EdgeDefs';
import { t, type Locale } from '@/lib/i18n';

/**
 * CONTRACT: default export, no props. Renders the IRGraph from the store on a
 * React Flow canvas with grid background, zoom/pan controls, connections, and
 * full manual-edit affordances (connect / delete / drag-reposition / context
 * menu add-node). The runtime-mode toggle drives a read-only state.
 *
 * The IR is the single source of truth: whenever `store.workflow` or
 * `store.runState` changes, the canvas re-projects via {@link irToFlow}.
 * Crucially, `irToFlow` prefers `workflow.layout[id]` over its placeholder
 * grid — so positions written back by `setNodePosition` during a drag survive
 * the re-projection without flickering back to the default coordinates.
 * Semantic branch/loop children are rendered as independent nodes rather than
 * React Flow sub-flow children, so they can be inspected and dragged freely.
 *
 * Read-only policy:
 *   - editable when the workflow is idle.
 *   - read-only while running or while AI is producing a replacement blueprint:
 *     connections, deletions, drags, and add-actions are disabled (selection +
 *     pan/zoom remain available for inspection).
 */

const nodeTypes: NodeTypes = {
  agent: AgentNode,
  parallel: ParallelNode,
  pipeline: PipelineNode,
  consensus: ConsensusNode,
  composite: CompositeNode,
  container: ContainerNode,
  control: ControlNode,
};

const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/** Default port id picked when React Flow doesn't supply one on a connection. */
const DEFAULT_EXEC_OUT = 'exec_out';
const DEFAULT_EXEC_IN = 'exec_in';
const DEFAULT_DATA_OUT = 'data_out';
const DEFAULT_DATA_IN = 'data_in';

/** Node categories surfaced in the right-click context menu. Mirrors the catalogue. */
const ADDABLE_NODES: {
  type: NodeType;
  label: string;
  accent: string;
  translations?: Partial<Record<Locale, { label: string }>>;
}[] = [
  {
    type: 'agent',
    label: 'Agent',
    accent: 'var(--accent)',
    translations: {
      'zh-CN': { label: '智能体' }, 'en-US': { label: 'Agent' },
      'es-ES': { label: 'Agente' }, 'fr-FR': { label: 'Agent' },
      'ru-RU': { label: 'Агент' }, 'ar-SA': { label: 'وكيل' },
      'hi-IN': { label: 'एजेंट' }, 'ja-JP': { label: 'エージェント' },
      'ko-KR': { label: '에이전트' }, 'pt-BR': { label: 'Agente' }, 'de-DE': { label: 'Agent' },
    },
  },
  {
    type: 'parallel',
    label: 'Parallel',
    accent: 'var(--accent-2)',
    translations: {
      'zh-CN': { label: '并行' }, 'en-US': { label: 'Parallel' },
      'es-ES': { label: 'Paralelo' }, 'fr-FR': { label: 'Parallèle' },
      'ru-RU': { label: 'Параллельно' }, 'ar-SA': { label: 'متوازي' },
      'hi-IN': { label: 'समानांतर' }, 'ja-JP': { label: '並列' },
      'ko-KR': { label: '병렬' }, 'pt-BR': { label: 'Paralelo' }, 'de-DE': { label: 'Parallel' },
    },
  },
  {
    type: 'pipeline',
    label: 'Pipeline',
    accent: 'var(--accent-2)',
    translations: {
      'zh-CN': { label: '流水线' }, 'en-US': { label: 'Pipeline' },
      'es-ES': { label: 'Pipeline' }, 'fr-FR': { label: 'Pipeline' },
      'ru-RU': { label: 'Конвейер' }, 'ar-SA': { label: 'خط أنابيب' },
      'hi-IN': { label: 'पाइपलाइन' }, 'ja-JP': { label: 'パイプライン' },
      'ko-KR': { label: '파이프라인' }, 'pt-BR': { label: 'Pipeline' }, 'de-DE': { label: 'Pipeline' },
    },
  },
  {
    type: 'consensus',
    label: 'Consensus',
    accent: 'var(--accent-2)',
    translations: {
      'zh-CN': { label: '共识投票' }, 'en-US': { label: 'Consensus' },
      'es-ES': { label: 'Consenso' }, 'fr-FR': { label: 'Consensus' },
      'ru-RU': { label: 'Консенсус' }, 'ar-SA': { label: 'إجماع' },
      'hi-IN': { label: 'आम सहमति' }, 'ja-JP': { label: '合意形成' },
      'ko-KR': { label: '합의' }, 'pt-BR': { label: 'Consenso' }, 'de-DE': { label: 'Konsens' },
    },
  },
  {
    type: 'composite',
    label: 'Composite',
    accent: 'var(--accent-3)',
    translations: {
      'zh-CN': { label: '复合节点' }, 'en-US': { label: 'Composite' },
      'es-ES': { label: 'Compuesto' }, 'fr-FR': { label: 'Composite' },
      'ru-RU': { label: 'Составной' }, 'ar-SA': { label: 'مركب' },
      'hi-IN': { label: 'संयुक्त' }, 'ja-JP': { label: '複合' },
      'ko-KR': { label: '복합' }, 'pt-BR': { label: 'Composto' }, 'de-DE': { label: 'Verbund' },
    },
  },
  {
    type: 'phase',
    label: 'Phase',
    accent: 'var(--accent-3)',
    translations: {
      'zh-CN': { label: '阶段' }, 'en-US': { label: 'Phase' },
      'es-ES': { label: 'Fase' }, 'fr-FR': { label: 'Phase' },
      'ru-RU': { label: 'Фаза' }, 'ar-SA': { label: 'مرحلة' },
      'hi-IN': { label: 'चरण' }, 'ja-JP': { label: 'フェーズ' },
      'ko-KR': { label: '단계' }, 'pt-BR': { label: 'Fase' }, 'de-DE': { label: 'Phase' },
    },
  },
  {
    type: 'branch',
    label: 'Branch',
    accent: 'var(--accent-3)',
    translations: {
      'zh-CN': { label: '分支' }, 'en-US': { label: 'Branch' },
      'es-ES': { label: 'Rama' }, 'fr-FR': { label: 'Branche' },
      'ru-RU': { label: 'Ветвление' }, 'ar-SA': { label: 'تفرع' },
      'hi-IN': { label: 'शाखा' }, 'ja-JP': { label: '分岐' },
      'ko-KR': { label: '분기' }, 'pt-BR': { label: 'Ramificação' }, 'de-DE': { label: 'Verzweigung' },
    },
  },
  {
    type: 'loop',
    label: 'Loop',
    accent: 'var(--accent-3)',
    translations: {
      'zh-CN': { label: '循环' }, 'en-US': { label: 'Loop' },
      'es-ES': { label: 'Bucle' }, 'fr-FR': { label: 'Boucle' },
      'ru-RU': { label: 'Цикл' }, 'ar-SA': { label: 'حلقة' },
      'hi-IN': { label: 'लूप' }, 'ja-JP': { label: 'ループ' },
      'ko-KR': { label: '반복' }, 'pt-BR': { label: 'Ciclo' }, 'de-DE': { label: 'Schleife' },
    },
  },
  {
    type: 'workflow',
    label: 'Sub-Workflow',
    accent: 'var(--accent)',
    translations: {
      'zh-CN': { label: '子工作流' }, 'en-US': { label: 'Sub-workflow' },
      'es-ES': { label: 'Subflujo' }, 'fr-FR': { label: 'Sous-flux' },
      'ru-RU': { label: 'Подпроцесс' }, 'ar-SA': { label: 'سير عمل فرعي' },
      'hi-IN': { label: 'उप-कार्यप्रवाह' }, 'ja-JP': { label: 'サブワークフロー' },
      'ko-KR': { label: '하위 워크플로우' }, 'pt-BR': { label: 'Subfluxo' }, 'de-DE': { label: 'Unterworkflow' },
    },
  },
  {
    type: 'log',
    label: 'Log',
    accent: 'var(--fg-dim)',
    translations: {
      'zh-CN': { label: '日志' }, 'en-US': { label: 'Log' },
      'es-ES': { label: 'Registro' }, 'fr-FR': { label: 'Journal' },
      'ru-RU': { label: 'Журнал' }, 'ar-SA': { label: 'سجل' },
      'hi-IN': { label: 'लॉग' }, 'ja-JP': { label: 'ログ' },
      'ko-KR': { label: '로그' }, 'pt-BR': { label: 'Registo' }, 'de-DE': { label: 'Protokoll' },
    },
  },
  {
    type: 'variable',
    label: 'Variable',
    accent: 'var(--fg-dim)',
    translations: {
      'zh-CN': { label: '变量' }, 'en-US': { label: 'Variable' },
      'es-ES': { label: 'Variable' }, 'fr-FR': { label: 'Variable' },
      'ru-RU': { label: 'Переменная' }, 'ar-SA': { label: 'متغير' },
      'hi-IN': { label: 'चर' }, 'ja-JP': { label: '変数' },
      'ko-KR': { label: '변수' }, 'pt-BR': { label: 'Variável' }, 'de-DE': { label: 'Variable' },
    },
  },
  {
    type: 'codeblock',
    label: 'Code Block',
    accent: 'var(--fg-dim)',
    translations: {
      'zh-CN': { label: '代码块' }, 'en-US': { label: 'Code block' },
      'es-ES': { label: 'Bloque de código' }, 'fr-FR': { label: 'Bloc de code' },
      'ru-RU': { label: 'Блок кода' }, 'ar-SA': { label: 'كتلة تعليمات برمجية' },
      'hi-IN': { label: 'कोड ब्लॉक' }, 'ja-JP': { label: 'コードブロック' },
      'ko-KR': { label: '코드 블록' }, 'pt-BR': { label: 'Bloco de código' }, 'de-DE': { label: 'Codeblock' },
    },
  },
  {
    type: 'start',
    label: 'Start',
    accent: 'var(--accent-3)',
    translations: {
      'zh-CN': { label: '开始' }, 'en-US': { label: 'Start' },
      'es-ES': { label: 'Inicio' }, 'fr-FR': { label: 'Début' },
      'ru-RU': { label: 'Начало' }, 'ar-SA': { label: 'بداية' },
      'hi-IN': { label: 'शुरू' }, 'ja-JP': { label: '開始' },
      'ko-KR': { label: '시작' }, 'pt-BR': { label: 'Início' }, 'de-DE': { label: 'Start' },
    },
  },
  {
    type: 'end',
    label: 'End',
    accent: 'var(--accent-4)',
    translations: {
      'zh-CN': { label: '结束' }, 'en-US': { label: 'End' },
      'es-ES': { label: 'Fin' }, 'fr-FR': { label: 'Fin' },
      'ru-RU': { label: 'Конец' }, 'ar-SA': { label: 'نهاية' },
      'hi-IN': { label: 'समाप्त' }, 'ja-JP': { label: '終了' },
      'ko-KR': { label: '종료' }, 'pt-BR': { label: 'Fim' }, 'de-DE': { label: 'Ende' },
    },
  },
];

/** Infer the pin kind from the React Flow handle id. */
function pinKindFromHandle(handle: string | null | undefined): PinKind {
  return handle && handle.startsWith('data') ? DATA : EXEC;
}

/** Normalize a React Flow Connection into IR endpoints + edge kind. */
function connectionToEdge(c: Connection): {
  from: { node: string; port: string };
  to: { node: string; port: string };
  kind: PinKind;
} | null {
  if (!c.source || !c.target) return null;
  const srcKind = pinKindFromHandle(c.sourceHandle);
  const tgtKind = pinKindFromHandle(c.targetHandle);
  // Mixed-kind connections (exec → data) are not meaningful; reject silently.
  if (srcKind !== tgtKind) return null;
  const isData = srcKind === DATA;
  return {
    from: {
      node: c.source,
      port: c.sourceHandle ?? (isData ? DEFAULT_DATA_OUT : DEFAULT_EXEC_OUT),
    },
    to: {
      node: c.target,
      port: c.targetHandle ?? (isData ? DEFAULT_DATA_IN : DEFAULT_EXEC_IN),
    },
    kind: srcKind,
  };
}

/** Context menu state: pixel position (relative to wrapper) + flow coords for placement. */
interface MenuState {
  screenX: number;
  screenY: number;
  flowX: number;
  flowY: number;
}

function BlueprintCanvasInner() {
  const workflow = useStore((s) => s.workflow);
  const locale = useStore((s) => s.locale);
  const runState = useStore((s) => s.runState);
  const readOnlyReason = useStore((s) => workflowReadOnlyReason(s));
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectNode = useStore((s) => s.selectNode);
  const setCanvasViewport = useStore((s) => s.setCanvasViewport);
  const graphPath = useStore((s) => s.graphPath);
  const activeScopeId = useStore(selectActiveScopeId);
  const enterComposite = useStore((s) => s.enterComposite);
  const exitComposite = useStore((s) => s.exitComposite);
  const popToGraph = useStore((s) => s.popToGraph);

  const addNode = useStore((s) => s.addNode);
  const addEdge = useStore((s) => s.addEdge);
  const removeNode = useStore((s) => s.removeNode);
  const removeEdge = useStore((s) => s.removeEdge);
  const setNodePosition = useStore((s) => s.setNodePosition);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [initialCanvasViewport] = useState<CanvasViewport | null>(() =>
    useStore.getState().canvasViewport,
  );

  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const isReadOnly = readOnlyReason !== null;

  // Restrict the projection to the subgraph currently being viewed (top level,
  // or the inside of a drilled-in composite). Memoized so the re-projection
  // effect below only re-runs when the scope or workflow actually changes.
  const scopedWorkflow = useMemo(
    () => filterScope(workflow, activeScopeId),
    [workflow, activeScopeId],
  );

  // Re-project the IR onto the canvas whenever the scoped workflow OR runState
  // changes. Layout coordinates are preserved by irToFlow, so a drag that wrote
  // back via setNodePosition will land at the same spot on re-projection.
  useEffect(() => {
    const { nodes: flowNodes, edges: flowEdges } = irToFlow(
      scopedWorkflow,
      runState,
      locale,
    );
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [scopedWorkflow, runState, locale, setNodes, setEdges]);

  // Mirror the store selection onto React Flow node `selected` flags.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        n.selected === (n.id === selectedNodeId)
          ? n
          : { ...n, selected: n.id === selectedNodeId },
      ),
    );
  }, [selectedNodeId, setNodes]);

  // ── Interaction handlers ─────────────────────────────────────────────────

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      selectNode(node.id);
    },
    [selectNode],
  );

  /** Double-clicking a composite node drills into its subgraph. */
  const onNodeDoubleClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const data = node.data as FlowNodeData | undefined;
      if (data?.irType !== 'composite') return;
      // Don't drill into the read-only boundary copy of the composite we're
      // already inside — only the composites listed within this scope.
      if (node.id === activeScopeId) return;
      enterComposite(node.id);
    },
    [activeScopeId, enterComposite],
  );

  const onPaneClick = useCallback(() => {
    selectNode(null);
    setMenu(null);
  }, [selectNode]);

  /** Create an IR edge whenever the user finishes drawing a connection. */
  const onConnect = useCallback<OnConnect>(
    (connection) => {
      if (isReadOnly) return;
      const ir = connectionToEdge(connection);
      if (!ir) return;
      addEdge(ir.from, ir.to, ir.kind);
    },
    [addEdge, isReadOnly],
  );

  /** Persist drag-stop positions back to the IR layout. */
  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_event, node) => {
      if (isReadOnly) return;
      setNodePosition(node.id, node.position.x, node.position.y);
    },
    [setNodePosition, isReadOnly],
  );

  /** Forward delete-key removals to the IR. */
  const onNodesDelete = useCallback<OnNodesDelete>(
    (deleted) => {
      if (isReadOnly) return;
      for (const n of deleted) removeNode(n.id);
    },
    [removeNode, isReadOnly],
  );

  const onEdgesDelete = useCallback<OnEdgesDelete>(
    (deleted: Edge[]) => {
      if (isReadOnly) return;
      for (const e of deleted) removeEdge(e.id);
    },
    [removeEdge, isReadOnly],
  );

  const onViewportChange = useCallback(
    (viewport: Viewport) => {
      setCanvasViewport(viewport);
    },
    [setCanvasViewport],
  );

  // ── Context menu (pane right-click → add node) ───────────────────────────

  const [menu, setMenu] = useState<MenuState | null>(null);

  /** Show the add-node menu at the right-click point on empty canvas. */
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      if (isReadOnly) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setMenu({ screenX, screenY, flowX: flow.x, flowY: flow.y });
    },
    [isReadOnly, screenToFlowPosition],
  );

  /** Add a node at the menu's flow-space coords, then close the menu. */
  const addNodeAtMenu = useCallback(
    (type: NodeType) => {
      if (isReadOnly) return;
      if (!menu) return;
      const id = addNode(type);
      if (!id) return;
      // Override the auto-placed coords with the right-click spot so the new
      // node materializes exactly where the user clicked. setNodePosition is
      // layout-only and doesn't dirty the workflow further.
      setNodePosition(id, menu.flowX, menu.flowY);
      selectNode(id);
      setMenu(null);
    },
    [addNode, isReadOnly, menu, selectNode, setNodePosition],
  );

  /** Close the context menu on Escape. */
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // ── Render ───────────────────────────────────────────────────────────────

  // `nodesDraggable` / `nodesConnectable` toggle React Flow's built-in
  // affordances; the per-handler `if (isReadOnly) return` guards are belt &
  // braces for any synthetic events that slip through.
  const interactive = !isReadOnly;
  const defaultViewport = initialCanvasViewport ?? DEFAULT_CANVAS_VIEWPORT;
  const fitInitialView = initialCanvasViewport == null;

  const readonlyBadge = useMemo(() => {
    if (!readOnlyReason) return null;
    const label =
      readOnlyReason === 'running'
        ? t(locale, 'canvas.runningReadonly')
        : t(locale, 'canvas.aiEditingReadonly');
    const style =
      readOnlyReason === 'running'
        ? {
            // Derived from the token instead of a literal rgba(): the old value was
            // a hardcoded sample of the default theme's success color and ignored
            // the active preset.
            background: 'color-mix(in oklab, var(--accent-2) 12%, transparent)',
            borderColor: 'var(--accent-2)',
            color: 'var(--accent-2)',
          }
        : {
            background:
              'color-mix(in oklab, var(--status-ai-edit) 12%, transparent)',
            borderColor: 'var(--status-ai-edit)',
            color: 'var(--status-ai-edit)',
          };
    return (
      <div
        className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]"
        style={style}
      >
        <span className="omc-pulse-dot" />
        <span>{label}</span>
      </div>
    );
  }, [readOnlyReason, locale]);

  const breadcrumb = useMemo(() => {
    if (graphPath.length === 0) return null;
    const rootLabel =
      workflow.meta.name?.trim() || t(locale, 'canvas.breadcrumbRoot');
    const crumbClass =
      'max-w-[160px] truncate rounded px-1.5 py-0.5 transition-colors hover:bg-panel-2 hover:text-fg';
    return (
      <div className="pointer-events-auto absolute left-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-panel/90 px-2 py-1 font-mono text-[11px] text-fg-dim shadow-lg backdrop-blur">
        <button
          type="button"
          className={crumbClass}
          onClick={() => popToGraph(0)}
          title={rootLabel}
        >
          {rootLabel}
        </button>
        {graphPath.map((crumb, index) => (
          <span key={crumb.nodeId} className="flex items-center gap-1">
            <span className="text-fg-faint" aria-hidden>
              ›
            </span>
            <button
              type="button"
              className={
                index === graphPath.length - 1
                  ? `${crumbClass} text-fg`
                  : crumbClass
              }
              onClick={() => popToGraph(index + 1)}
              title={crumb.label}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="ml-1 rounded border border-border-soft px-1.5 py-0.5 text-fg-dim transition-colors hover:border-accent hover:text-fg"
          onClick={() => exitComposite()}
          title={t(locale, 'canvas.exitComposite')}
        >
          ↩
        </button>
      </div>
    );
  }, [graphPath, workflow.meta.name, locale, popToGraph, exitComposite]);

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Local-scoped keyframes used by the running pulse + status badges. */}
      <style>{KEYFRAME_CSS}</style>

      <CanvasToolbar />

      <div className="relative min-h-0 flex-1" ref={wrapperRef}>
        {readonlyBadge}
        {breadcrumb}
        <EdgeDefs />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={onPaneClick}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          onViewportChange={onViewportChange}
          onPaneContextMenu={onPaneContextMenu}
          nodesDraggable={interactive}
          nodesConnectable={interactive}
          edgesFocusable={interactive}
          deleteKeyCode={interactive ? ['Delete', 'Backspace'] : null}
          defaultViewport={defaultViewport}
          fitView={fitInitialView}
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.25}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: 'default' }}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={22}
            lineWidth={1}
            color="var(--border-soft)"
          />
          <Controls showInteractive={false} style={{ color: 'var(--fg)' }} />
        </ReactFlow>

        {menu && (
          <AddNodeMenu
            x={menu.screenX}
            y={menu.screenY}
            locale={locale}
            onPick={addNodeAtMenu}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Right-click context menu for adding a node. Positioned at the click point
 * (relative to the canvas wrapper) so it stays under the cursor while the
 * flow viewport is panned/zoomed.
 */
function AddNodeMenu({
  x,
  y,
  locale,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  locale: Locale;
  onPick: (type: NodeType) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop catches the next click anywhere and dismisses the menu. */}
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="absolute z-40 min-w-[160px] overflow-hidden rounded-md border border-border bg-panel shadow-2xl"
        style={{ left: x, top: y }}
      >
        <div className="border-b border-border-soft px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
          {t(locale, 'canvas.addNode')}
        </div>
        <div className="flex max-h-[280px] flex-col overflow-y-auto py-1">
          {ADDABLE_NODES.map((n) => (
            <button
              key={n.type}
              type="button"
              onClick={() => onPick(n.type)}
              className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: n.accent }}
                aria-hidden
              />
              <span>{n.translations?.[locale]?.label ?? n.label}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-faint">
                {n.type}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Component-scoped keyframes for the running pulse on node borders and the
 * toolbar "running" badge. Kept inline (vs. global.css) so the canvas module
 * remains the sole owner of its visual chrome.
 */
const KEYFRAME_CSS = `
@keyframes omc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.omc-pulse-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: omc-pulse 1.1s ease-in-out infinite;
}
`;

export default function BlueprintCanvas() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const graphPath = useStore((s) => s.graphPath);
  // Append the drill-down path so React Flow's internal state (selection,
  // viewport) resets cleanly when entering/leaving a composite subgraph.
  const scopeKey = graphPath.map((crumb) => crumb.nodeId).join('>') || 'root';
  const providerKey = `${activeWorkspaceId ?? 'workspace'}:${activeSessionId ?? 'session'}:${scopeKey}`;
  return (
    <ReactFlowProvider key={providerKey}>
      <BlueprintCanvasInner />
    </ReactFlowProvider>
  );
}
