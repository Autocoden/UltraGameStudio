## Context

Autocode 的归档交互（D:\Dev\Autocode，`renderer/components/KanbanBoard.tsx` 的 DroppableColumn props）：`onArchiveAll`（全部归档）、`archivedCount`（归档计数）、`showArchived`/`onToggleArchived`（列内显示/隐藏已归档切换）——归档是**保留数据**的标记，不是删除。本项目当前 `clearDone` 直接删除，需替换语义。

## Decisions

### D1. 数据模型：`TaskCard.archived?: boolean`
持久化在现有 v2 结构中（可选布尔字段，旧数据天然兼容）；sanitize 只接受布尔值。`getBoardTasks` 返回**含归档卡片**的全量数组——过滤是视图关注点，保持数据层单一职责。

### D2. 三个数据层助手替代 `clearDone`
- `archiveTask(boardKey, id)`：仅允许「完成」状态卡片归档（其他状态返回 false）；
- `restoreTask(boardKey, id)`：撤销归档；
- `archiveAllDone(boardKey)`：归档所有未归档的已完成卡片，返回张数。
均走 `replaceBoard` 不可变更新，通知与持久化复用现有 `emit`。

### D3. 视图过滤与切换
`showArchived` 状态提升到 `TaskBoardView`（仅「完成」列消费）。完成列展示集合 = `showArchived ? 全部 : 未归档`；计数胶囊按展示集合的未归档数。已归档卡片：置灰（opacity + 边框弱化）+「已归档」徽标，隐藏移动/归档操作，仅保留「恢复」与「删除」。全部归档按钮在无未归档完成卡时隐藏；显示切换仅在有归档卡片时出现（对齐 Autocode 的 archivedCount 条件渲染）。

### D4. 文案
`board.archive.one/all/show/hide/restore` + `board.archived.tag`（zh：归档/全部归档/显示已归档/隐藏已归档/恢复/已归档），移除 `board.clearDone`。

## Risks / Trade-offs

- 归档卡片长期堆积在同一 localStorage 键 → 个人任务量级可接受；与 Autocode 同策略，未来量大再考虑独立归档存储。
- 「删除」仍可物理删除归档卡片 → 有意保留（用户显式清理入口）。

## Migration Plan

无可迁移存量：`archived` 缺省即未归档。

## Open Questions

无。
