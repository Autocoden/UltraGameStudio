## Why

看板任务目前只能「发送到智能终端」由用户手动粘贴执行，与参考产品 Autocode 的核心流程不符：Autocode 的看板任务是**自主执行**的——任务进入队列后由 agent 按有界并行自动拾取执行（执行阶段：规划/编码），完成后 AI 审核，再落到人工审核列由用户验收。需要把看板升级为同样的自主执行流水线，去掉智能终端中转。

## What Changes

- **移除「发送到智能终端」**：卡片操作、跨视图事件、相关 i18n 键与规格一并删除。
- **新增任务执行队列**：运行器按顺序自动拾取「队列」列的任务执行；并行执行数可在看板头部调整（1–4，默认 1，持久化）；执行中卡片显示「执行中」标记与「停止」按钮（停止后按失败处理）。
- **新增执行阶段与自动流转**（对齐 Autocode 的执行阶段与错误落点）：
  1. 拾取 → 状态 流转为「进行中」，标记「执行中」；
  2. agent 在当前工作区直接执行任务（提示词 = 标题 + 描述 + 分类信息）；
  3. 执行完成 → 状态「AI 审核」，运行器自动发起一次 AI 审核（核对工作区中任务是否完成）；
  4. 审核通过 → 状态「人工审核」，标记「待人工审核」；审核失败或执行异常 → 状态「人工审核」并标注失败原因（Autocode 的 error 也落在 human_review 列）；
  5. 人工审核列的卡片提供「通过」（→ 完成）与「重新执行」（→ 回到队列重新排队）。
- 应用重启时，执行中的任务自动回退到「队列」重新排队（幂等重跑）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `task-board`: **REMOVED** 「发送到智能终端」需求；**ADDED** 「任务执行队列」「执行阶段与自动流转」两条需求。其余需求不变。

## Impact

- 新增 `app/src/lib/taskBoardRunner.ts`（队列运行器）及测试。
- `app/src/lib/taskBoard.ts` — `TaskExecutionPhase`、`TaskCard.phase/executionError` 字段与 `approveTask`/`requeueTask`/`setTaskPhase` 助手；删除 `TASK_BOARD_SEND_EVENT`。
- `app/src/panels/TaskBoardView.tsx` — 移除发送按钮；新增执行/停止/通过/重新执行操作、阶段徽章、头部并行数选择。
- `app/src/App.tsx` — 删除发送事件监听。
- `app/src/lib/i18n.ts` — 删除发送相关键，新增执行/阶段/并行文案。
- 执行通道：复用 Tauri `aiEditViaCli`（cwd = 活动工作区、permission 取会话设置）；裁剪说明——Autocode 的 git worktree 隔离、逐阶段模型路由、速率限制暂停不在本次范围。
