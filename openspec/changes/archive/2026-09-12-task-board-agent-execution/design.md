## Context

Autocode 的任务执行链（本地源码 D:\Dev\Autocode）：`main/agent/agent-queue.ts` 按 `maxParallelTasks`（项目设置，shared/types/project.ts:43）拾取队列任务；`agent-manager/agent-process` 驱动执行阶段（`EXECUTION_PHASE_LABELS`：idle/planning/coding/qa_review/complete/failed…）；任务状态沿 backlog→queue→in_progress→ai_review→human_review→done 流转，`error` 状态视觉上映射到 human_review 列（KanbanBoard.tsx `getVisualColumn`："errors need human attention"）。

本项目已有的一次性 agent 通道：`lib/tauri.ts` 的 `aiEditViaCli(prompt, adapter, opts)`（stream-json、进度回调、runId）与 `cancelAiCli(runId)`；会话权限在 `useStore.getState().composer.permission`。

## Goals / Non-Goals

- Goals: 队列自动拾取、有界并行、执行 → AI 审核 → 人工审核 → 完成的自动流转、失败落人工审核列、可停止、重启恢复。
- Non-Goals: git worktree/分支隔离（Autocode 的 worktree 协议）、逐阶段模型/思考等级路由、速率限制暂停（rate_limit_paused）、执行日志面板。

## Decisions

### D1. 运行器为渲染进程模块 `lib/taskBoardRunner.ts`
单例外部 store；`pumpBoard(boardKey, ctx)` 在看板任务集变化时被视图触发（subscribeTasks 订阅），执行结束的回调里也会再次 pump。运行集合以 `${boardKey}/${cardId}` 记账，超过 `maxParallel` 即等待。并行数持久化在独立键 `ugs.taskboard.runner.v1`（默认 1，1–4）。

### D2. 一次执行 = 两次 CLI 调用（工作 → AI 审核）
对齐 Autocode 的 coding → qa_review 两段：
1. **工作调用**：`aiEditViaCli(执行提示词, 'claude-code', { cwd: 活动工作区, permission: composer.permission || 'full', runId })`；提示词明确"直接修改文件完成任务，不要提问"。执行期间卡片 `phase='executing'`、状态 `in_progress`。
2. **审核调用**：再次 `aiEditViaCli`（只读核实），要求只输出 `PASS` 或 `FAIL: 原因`；期间 `phase='reviewing'`、状态 `ai_review`。
3. PASS → `phase='awaiting_human'`、状态 `human_review`；FAIL/异常/停止 → `phase='failed'` + `executionError`、状态 `human_review`（Autocode error 同样落 human_review 列）。

### D3. 状态流转只走既有 `moveTask`，新字段走新助手
`setTaskPhase(boardKey, id, phase, error?)`、`approveTask`（→ done + phase 'complete'）、`requeueTask`（→ queue + phase 'idle' 清错误）。`TaskCard` 新增 `phase?: TaskExecutionPhase`（'idle'|'executing'|'reviewing'|'awaiting_human'|'complete'|'failed'）与 `executionError?: string`；sanitize 校验枚举透传，存储保持 v2。

### D4. 取消与恢复
- 停止：`cancelAiCli(runId)`（runId = `tbrun_${boardKey}_${cardId}`），然后把任务按失败处理（"手动停止"）。
- 重启恢复：runner 模块初始化时把所有 `phase === 'executing' | 'reviewing'` 的卡片 `requeueTask`（进程已不存在，回队重跑幂等）；队列列的任务由首次 pump 自然拾取。

### D5. 执行通道固定 claude-code 适配器
本次固定 `'claude-code'`（应用的主适配器），permission 取会话设置；渠道/模型选择接入是网关层课题，记为后续变更。

### D6. 移除发送到智能终端
删 `TASK_BOARD_SEND_EVENT`、卡片发送按钮、`App.tsx` 监听、`board.card.sendToTerminal` 文案。`composeTaskPrompt` 保留，供运行器拼任务提示词复用。

## Risks / Trade-offs

- agent 执行无 worktree 隔离，直接改当前工作区（与用户在智能终端里让 agent 干活的风险一致；权限沿用会话设置）。
- AI 审核为模型自评，存在误判 → 兜底是人工审核列必经，用户不点「通过」任务不算完成。
- 双调用成本翻倍 → 审核调用是短只读核查；可接受。

## Migration Plan

新增字段全可选；旧数据读入 phase 缺省视为 idle。重启恢复逻辑覆盖升级瞬间的悬挂状态。

## Open Questions

无。
