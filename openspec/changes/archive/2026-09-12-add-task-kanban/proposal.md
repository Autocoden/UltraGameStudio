## Why

应用外壳已经是 Autocode 风格(左侧图标 rail + 顶部项目栏),但缺少 Autocode 的核心工作面之一:任务看板。用户在跑多任务(生成资产、改代码、跑工作流)时,任务只散落在会话流里,没有一个可以横览"待办 / 进行中 / 已完成"的入口。在左侧 rail 的智能终端入口上方加入任务看板,让任务成为与对话、资产并列的一等公民。

## What Changes

- 左侧 AppRail 顶部、智能终端入口上方新增「任务看板」导航项(带进行中任务数徽标),新增 `board` 视图。
- 新增任务看板视图:三列(待办 / 进行中 / 已完成),卡片支持新建、编辑标题与备注、删除、拖拽或按钮在列间移动、清空已完成列。
- 卡片可「发送到智能终端」:把任务标题+备注组装为提示词草稿写入会话输入框,并切回智能终端视图,打通"看板任务 → agent 执行"链路。
- 看板数据按工作区隔离,持久化到 localStorage,刷新/重启后保留。
- 新增 11 语言 i18n 文案。

## Capabilities

### New Capabilities

- `task-board`: 任务看板的导航入口、三列看板交互、卡片生命周期、工作区数据隔离与持久化、发送到智能终端的集成行为。

### Modified Capabilities

(无 — 现有能力没有规格级变更;AppRail 视图枚举扩展属于本能力的实现细节)

## Impact

- `app/src/components/AppRail.tsx` — `AppView` 增加 `'board'`,nav 项插入列首。
- `app/src/App.tsx` — 注册 board 视图区块,监听"发送到智能终端"事件切换视图。
- 新增 `app/src/lib/taskBoard.ts`(模块级 store,localStorage 持久化,参照 downloadRegistry 模式)及其测试。
- 新增 `app/src/panels/TaskBoardView.tsx` 看板视图组件及其测试。
- `app/src/lib/i18n.ts` — 新增 `rail.board` 与 `board.*` 文案键(全部 11 个 locale)。
- 复用 `useStore` 的 `setComposerDraft`(无 store 结构变更),零新依赖。
