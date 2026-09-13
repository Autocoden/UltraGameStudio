## 1. 数据层

- [x] 1.1 `app/src/lib/taskBoard.ts`：`TaskStatus` 改为六值（backlog/queue/in_progress/ai_review/human_review/done），`TASK_STATUSES` 对应列序；`STORAGE_VERSION` 升 2，读入 v1 数据映射 todo→backlog、doing→in_progress、done→done
- [x] 1.2 `app/src/lib/taskBoard.test.ts`：用例状态值更新；新增 v1→v2 迁移用例（三张旧卡片分别落位、无丢失）与 v2 未知状态丢弃用例

## 2. 视图层

- [x] 2.1 `app/src/panels/TaskBoardView.tsx`：布局改为 `flex overflow-x-auto`（列 `w-64 shrink-0 lg:flex-1`）；列头加阶段配色圆点与着色计数胶囊（backlog 中性/queue 蓝/in_progress 信息色/ai_review 琥珀/human_review 紫/done 绿）
- [x] 2.2 `app/src/panels/TaskBoardView.test.tsx`：六列渲染断言、新建输入 6 个、逐阶段按钮移动到「完成」并出现完成时间、其余场景标签同步
- [x] 2.3 `app/src/lib/i18n.ts`：`board.column.*` 替换为 6 个阶段键（zh 对齐 Autocode：待规划/队列/进行中/AI 审核/人工审核/完成；en：Planning/Queue/In Progress/AI Review/Human Review/Done），subtitle 文案更新

## 3. 集成

- [x] 3.1 `app/src/components/AppRail.tsx`：徽标统计 `status === 'doing'` 改为 `'in_progress'`

## 4. 验证

- [x] 4.1 `npm run test`：新增/更新的看板用例全绿，全量无新增失败
- [x] 4.2 `tsc -b` / `vite build` 通过
- [x] 4.3 `openspec validate expand-task-board-stages` 通过后归档
