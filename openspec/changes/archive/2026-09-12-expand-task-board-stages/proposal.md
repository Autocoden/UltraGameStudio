## Why

任务看板目前只有三个阶段（待办/进行中/已完成），与参考产品 Autocode 的看板不一致。经源码核对（D:\Dev\Autocode\apps\desktop\src\shared\constants\task.ts 的 `TASK_STATUS_COLUMNS` 与 locales 的 `columns.*` 文案），Autocode 的看板是六阶段流水线：backlog → queue → in_progress → ai_review → human_review → done。需要把看板阶段对齐到同一套，才能承载"AI 执行 + AI 评审 + 人工验收"的 agent 工作流。

## What Changes

- 看板阶段从 3 个扩展为 6 个（与 Autocode 完全同名列序）：待规划(backlog) → 队列(queue) → 进行中(in_progress) → AI 审核(ai_review) → 人工审核(human_review) → 完成(done)。
- 列头采用 Autocode 同款配色语义：backlog 中性、queue 蓝、in_progress 信息色、ai_review 琥珀、human_review 紫、done 绿。
- 看板布局从三等分栅格改为可横向滚动的多列布局（6 列）。
- localStorage 数据 v1 → v2 迁移：todo→backlog、doing→in_progress、done→done，卡片不丢失。
- rail 徽标语义保持"进行中列卡片数"不变（in_progress 列仍存在）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `task-board`: "三列看板"需求改为六阶段看板（Autocode 阶段集、列序、旧数据迁移）；"列间移动"需求的阶段表述随之更新。其余需求（导航入口徽标、卡片生命周期、清空已完成、工作区隔离持久化、发送到智能终端）不变。

## Impact

- `app/src/lib/taskBoard.ts` — `TaskStatus` 六值联合、`TASK_STATUSES` 列序、`STORAGE_VERSION` 2 + v1 迁移。
- `app/src/panels/TaskBoardView.tsx` — 6 列横向滚动布局、列配色。
- `app/src/components/AppRail.tsx` — 徽标统计列改为 `in_progress`。
- `app/src/lib/i18n.ts` — `board.column.*` 键替换为 6 个阶段键，subtitle 文案更新（zh/en）。
- 测试：`taskBoard.test.ts`、`TaskBoardView.test.tsx` 同步更新。
