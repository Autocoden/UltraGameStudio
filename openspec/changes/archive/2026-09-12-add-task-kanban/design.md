## Context

应用外壳为 Autocode 风格:`AppRail`(左侧 16 图标 rail)+ `ProjectTopBar` + 按视图切换的主区域(`App.tsx`)。现有视图 `terminal`(智能终端)/ `assets`(资产),由 `AppView` 联合类型驱动。资产中心已有「模块级外部 store + `useSyncExternalStore` + localStorage」的成熟先例(`lib/downloadRegistry.ts`),与 10k 行的 zustand 主 store 解耦。

## Goals / Non-Goals

- Goals:看板作为 rail 一等视图;零新依赖;不改动 zustand 主 store 结构;按工作区隔离;与智能终端双向打通(发送任务)。
- Non-Goals:不做多人协作/云端同步;不做任务与 agent 运行状态自动绑定(卡片状态由用户手动驱动);不做子任务/标签/截止日期等富字段。

## Decisions

### D1. 视图注册方式:扩展 `AppView` 而非新路由
`AppView = 'board' | 'terminal' | 'assets'`,board 排在 nav 项列表首位(满足「智能终端上方」)。App.tsx 用与 assets 相同的「保持挂载/`hidden` 隐藏」模式挂载看板,保证跨视图切换不丢状态。默认视图保持 `terminal` 不变(改变落地页超出本次范围)。

### D2. 状态管理:模块级外部 store(`lib/taskBoard.ts`),照搬 downloadRegistry 模式
- `Set<listener>` + `subscribeTasks`/`getTasksSnapshot`,组件侧 `useSyncExternalStore`。
- 持久化:单一 localStorage 键 `ugs.taskboard.v1`,结构 `{ version: 1, boards: Record<boardKey, TaskCard[]> }`;`boardKey = workspaceId || 'default'`。读入时 try/catch + 形状校验,损坏即回退空表(满足「存储损坏回退」场景)。
- 写路径全部经 `mutateBoard(boardKey, fn)` 统一:改内存 → 通知 → 落盘。
- 不放进 zustand 主 store:避免触碰 10k 行文件与它的持久化/迁移逻辑,且看板是自包含领域数据。

### D3. 卡片移动:原生 HTML5 DnD + 按钮兜底
拖拽用 `dragstart`/`dragover`/`drop`(dataTransfer 只放卡片 id,列容器为 drop target),不引入 dnd 库。每张卡片同时提供「上列/下列」按钮,覆盖键盘与无鼠标场景;「已完成」之后无下一列时按钮禁用。

### D4. 发送到智能终端:公开 action + 自定义事件切换视图
- 组装提示词:`标题\n· 备注`(有备注才加),经 `useStore.getState().setComposerDraft(text)` 写入。
- 草稿非空时追加:`原草稿\n\n<任务提示词>`,不覆盖(规格场景「保留已有草稿」)。
- 视图切换沿用 App.tsx 现有事件模式(参照 `ASSET_SESSION_JUMP_EVENT`):新增 `TASK_BOARD_SEND_EVENT` window 事件,App 监听后 `setActiveView('terminal')`。看板组件不 import App,避免反向依赖。

### D5. 完成时间
`TaskCard.completedAt?: number`,仅在 `status === 'done'` 时有意义;`moveTask` 里进入 done 写入、离开 done 清除。卡片以相对/本地时间展示(`board.card.doneAt` 文案)。

### D6. i18n
新增键:`rail.board`、`board.title/subtitle/empty`、`board.column.todo/doing/done`、`board.addPlaceholder/add`、`board.card.note/edit/delete/sendToTerminal/movePrev/moveNext/doneAt`、`board.clearDone/confirmClearDone`(约 18 键),补齐全部 11 个 locale,保持 check-i18n 键位对齐。文案与现有 UI 一致以中文为基准。

## Risks / Trade-offs

- 原生 DnD 在触摸屏不可用 → 已有按钮兜底,可接受(桌面应用为主)。
- 单键存储所有工作区看板,超大量卡片会整表重写 → 卡片量级为个人任务(几十),可接受;version 字段留了迁移口。
- `setComposerDraft` 直接写全局草稿,多会话草稿(`composerDrafts`)语义遵循该 action 的现有行为,不额外发明。

## Migration Plan

新功能,无存量数据迁移。localStorage 键带 `v1`,后续结构变更走版本分支。

## Open Questions

无(默认视图保持 terminal、清空已完成不做二次确认均已定;若验收后需要回收站/撤销,另开变更)。
