## Context

上一轮实现的看板是三列（todo/doing/done），任务状态为 `TaskStatus = 'todo' | 'doing' | 'done'`，持久化在 `ugs.taskboard.v1`。参考产品 Autocode 的源码就在本地 D:\Dev\Autocode，其看板列定义有权威出处。

## Autocode 阶段权威依据

- 列定义：`D:\Dev\Autocode\apps\desktop\src\shared\constants\task.ts` → `TASK_STATUS_COLUMNS = ['backlog','queue','in_progress','ai_review','human_review','done']`，注释标明 "Task status columns in Kanban board order"。
- 列文案：`apps/desktop/src/shared/i18n/locales/{en,zh-CN}/tasks.json` → `columns.*`：en `Planning/Queue/In Progress/AI Review/Human Review/Done`；zh-CN `待规划/队列/进行中/AI 审核/人工审核/完成`。
- 列配色：同 constants 文件 `TASK_STATUS_COLORS`：backlog=muted、queue=blue、in_progress=info、ai_review=warning、human_review=violet、done=success。
- 视觉映射（本变更不采用）：Autocode 把 `pr_created` 显示进 done 列、`error` 显示进 human_review 列——这两个是它的 git/PR 执行态，UltraGameStudio 看板无对应概念，留待后续接入执行状态时再议。

## Decisions

### D1. 内部状态 id 直接采用 Autocode 的六个英文 id
`TaskStatus = 'backlog' | 'queue' | 'in_progress' | 'ai_review' | 'human_review' | 'done'`，`TASK_STATUSES` 数组即列序，`columnStep`/上一阶段下一阶段按钮、拖拽逻辑零改动复用。中文文案对齐 Autocode zh-CN。

### D2. 持久化 v1 → v2 迁移（无感升级）
`STORAGE_VERSION` 升为 2。读入时接受 v1/v2：v1 的卡片状态映射 `todo→backlog、doing→in_progress、done→done` 后按 v2 校验；其余非法行照旧丢弃。不迁移的后果是 sanitize 拒载旧卡片，违反持久化需求的"不丢失"语义，故必须做。

### D3. 布局从三等分栅格改为横向滚动多列
容器 `flex gap-3 overflow-x-auto`，列 `w-64 shrink-0 lg:flex-1`（`flex:1 0 16rem`）：宽窗口六列等宽铺满，窄窗口横向滚动，不出现换行错乱的三列栅格。

### D4. 列配色用 Tailwind 默认调色板（项目 theme 为 extend，默认色可用）
列头加彩色圆点 + 计数胶囊着色：backlog 中性(panel-2/fg-dim)、queue `blue-500/10 text-blue-300`、in_progress `sky-500/10 text-sky-300`、ai_review `amber-500/10 text-amber-300`、human_review `violet-500/10 text-violet-300`、done `emerald-500/10 text-emerald-300`。语义与 Autocode `TASK_STATUS_COLORS` 一一对应。

### D5. rail 徽标语义不变
徽标 = 「进行中」(in_progress) 列卡片数。该列在六阶段中仍然存在，原需求无需改动；AppRail 只需把统计字段从 `doing` 改为 `in_progress`。

## Risks / Trade-offs

- 六列在窄窗口需要横向滚动 → 桌面应用主分辨率下六列可铺满；滚动是 kanban 常规交互，可接受。
- v1 迁移只映射状态字段，卡片其余字段不变 → 结构简单、可逆（v1 原始 JSON 在首次写盘前仍在 localStorage 中可手工恢复）。

## Migration Plan

随 D2。上线即自动迁移，无需用户操作。

## Open Questions

无。
