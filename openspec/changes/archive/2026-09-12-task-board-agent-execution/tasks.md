## 1. 数据层

- [x] 1.1 `app/src/lib/taskBoard.ts`：`TaskExecutionPhase` 枚举；`TaskCard.phase/executionError`；`setTaskPhase`/`approveTask`/`requeueTask`；sanitize 校验新字段；删除 `TASK_BOARD_SEND_EVENT`
- [x] 1.2 `app/src/lib/taskBoard.test.ts`：新字段持久化/非法值丢弃、approve/requeue 流转用例

## 2. 运行器

- [x] 2.1 新增 `app/src/lib/taskBoardRunner.ts`：并行数设置（1–4，持久化）、`pumpBoard` 拾取、工作调用 → AI 审核调用 → 流转、`stopTask`（cancelAiCli + 失败处理）、启动恢复（executing/reviewing → requeue）
- [x] 2.2 新增 `app/src/lib/taskBoardRunner.test.ts`：mock `@/lib/tauri`——自动拾取与并行上限、PASS/FAIL 流转、停止、重启恢复

## 3. 视图与集成

- [x] 3.1 `app/src/panels/TaskBoardView.tsx`：移除发送按钮；执行中标记 + 停止、人工审核列「通过/重新执行」、失败原因行、阶段徽章；头部「并行执行」选择；挂载时接 runner（订阅 + 启动恢复）
- [x] 3.2 `app/src/App.tsx`：删除发送事件监听与导入
- [x] 3.3 `app/src/lib/i18n.ts`：删 `board.card.sendToTerminal`；新增 停止/通过/重新执行/阶段徽章/并行执行 文案（zh/en）
- [x] 3.4 `app/src/panels/TaskBoardView.test.tsx`：删除发送用例，新增 阶段标记/通过/重新执行 用例

## 4. 验证

- [x] 4.1 `npm run test`：看板用例全绿，全量无新增失败
- [x] 4.2 `tsc -b` / `vite build` 通过
- [x] 4.3 `openspec validate task-board-agent-execution` 通过后归档，重打包启动应用
