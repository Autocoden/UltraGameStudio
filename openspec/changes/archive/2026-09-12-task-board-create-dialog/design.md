## Context

Autocode 参考实现（D:\Dev\Autocode）：
- `apps/desktop/src/renderer/components/TaskCreationWizard.tsx` — 新建弹窗（基于共享 `TaskModalLayout` + `TaskFormFields`）。
- `apps/desktop/src/renderer/components/task-form/ClassificationFields.tsx` — 2×2 分类下拉网格：分类(feature/bug_fix/refactoring/documentation/security)、优先级(low/medium/high/urgent)、复杂度(trivial/small/medium/large/complex)、影响(low/medium/high/critical)，全部可选，带"分类（可选）"分组标题。
- `locales/zh-CN/tasks.json` — 官方文案：功能/缺陷修复/重构/文档/安全；低/中/高/紧急；极低/小/中/大/复杂；低影响/中等影响/高影响/关键影响；描述占位「描述你想实现的功能、修复的缺陷或改进内容。…」。
- `components/TaskCard.tsx` — 徽章规则：category 有值即显示；complexity 有值即显示；priority 仅 urgent/high；impact 仅 high/critical。配色来自 `shared/constants/task.ts` 的 TASK_*_COLORS。
- 列头 `onAddClick`（KanbanBoard.tsx）— 每列"+"按钮触发新建。

## Goals / Non-Goals

- Goals: 列头"+"→ 弹窗创建；创建/编辑共用一个弹窗组件；卡片 Autocode 同款徽章；数据模型带元数据；文案对齐 Autocode 中文。
- Non-Goals: git 分支/worktree 选项、逐阶段模型/思考等级选择、图片附件、文件引用自动补全、OpenSpec 预检、草稿自动保存——这些属于 Autocode 的 agent 执行编排，与看板本身无关。

## Decisions

### D1. 单弹窗双模式组件 `panels/TaskBoardDialog.tsx`
`{ mode: 'create'; status: TaskStatus } | { mode: 'edit'; card: TaskCard } | null` 状态提升到 `TaskBoardView`。Autocode 的创建/编辑也是两个入口共享 `TaskFormFields`；我们规模小，合并为一个组件、`创建`/`保存` 按钮随模式切换。编辑按钮打开后预填 title/note/四个元数据。

### D2. 元数据进 `TaskCard` 可选字段
`category?/priority?/complexity?/impact?`（四个字符串字面量联合类型，导出为 `TaskMeta`）。`addTask(boardKey, status, title, note?, meta?)`、`updateTask` patch 增加 `meta?: Partial<TaskMeta>`（浅合并，仅覆盖显式提供的键）。sanitize 透传合法枚举、丢弃非法值；存储保持 version 2——可选字段对旧数据天然兼容，无需迁移。

### D3. 徽章规则与配色照搬 Autocode 语义
显示规则：category/complexity 有值即显示；priority 仅 high/urgent；impact 仅 high/critical。配色（Tailwind 默认调色板，语义对应 Autocode TASK_*_COLORS）：feature=sky、bug_fix=red、refactoring=cyan、documentation=amber、security=red、priority.medium=amber/high=orange/urgent=red、complexity=emerald/sky/amber/orange/red、impact.low=neutral/medium=sky/high=amber/critical=red。

### D4. 弹窗表单用原生 select + 设计令牌样式
项目没有现成 Select 组件可复用（AIDock 的下拉与业务耦合），引入 Radix 类组件属新依赖。用 `<select>` + bg-panel/border-border 令牌样式，外观与现有面板一致；2×2 网格布局复刻 ClassificationFields。

### D5. 列头"+"按钮
每列列头右侧放"+"图标按钮（`board.column.add` 作为 title/aria-label），done 列保留「清空已完成」文字按钮，两者并排（+ 在右）。列底内联输入框及其状态（draft/submitDraft）整体移除。

## Risks / Trade-offs

- 原生 select 的下拉列表外观随操作系统，不如 Autocode 的 Radix Select 精致 → 桌面端可接受，避免新依赖。
- 编辑模式不提供"清空元数据"的快捷方式（把下拉放回占位即清除该项）→ 已支持：选择空占位值即置空。

## Migration Plan

无可迁移存量（新字段全可选）。旧 v2 数据读入即兼容。

## Open Questions

无。
