## 1. 数据层

- [x] 1.1 新建 `app/src/lib/taskBoard.ts`:`TaskCard`/`TaskStatus` 类型;`subscribeTasks`/`getTasksSnapshot`;`addTask`/`updateTask`/`moveTask`/`removeTask`/`clearDone`(按工作区键隔离,无需 setActiveBoard);localStorage 持久化(`ugs.taskboard.v1`)与损坏回退
- [x] 1.2 新建 `app/src/lib/taskBoard.test.ts`:增删改移、工作区隔离、持久化恢复、损坏 JSON 回退、完成时间写入/清除、监听通知

## 2. 视图层

- [x] 2.1 新建 `app/src/panels/TaskBoardView.tsx`:三列布局、空态、列内新建输入、卡片(标题/备注/完成时间/操作按钮)、拖拽与按钮移动、清空已完成、发送到智能终端
- [x] 2.2 新建 `app/src/panels/TaskBoardView.test.tsx`:渲染三列与空态、新建卡片、空白标题拒绝、按钮移动与完成时间、清空已完成、发送事件与草稿保留

## 3. 集成

- [x] 3.1 `AppRail.tsx`:`AppView` 加 `'board'`,nav 首位插入任务看板项(进行中数徽标)
- [x] 3.2 `App.tsx`:挂载 board 视图区块(保持挂载/隐藏模式);监听 `TASK_BOARD_SEND_EVENT` 切回智能终端
- [x] 3.3 `lib/i18n.ts`:新增 `rail.board` 与 `board.*` 键,补齐 11 个 locale,`node check-i18n.cjs` 键位对齐

## 4. 验证

- [x] 4.1 `npm run test`(vitest)全绿
- [x] 4.2 `tsc -b` / vite build 无类型错误
- [x] 4.3 `openspec validate add-task-kanban` 通过
