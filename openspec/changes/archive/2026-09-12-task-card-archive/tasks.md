## 1. 数据层

- [x] 1.1 `app/src/lib/taskBoard.ts`：`TaskCard.archived`；`archiveTask`/`restoreTask`/`archiveAllDone` 替代 `clearDone`；sanitize 透传布尔值
- [x] 1.2 `app/src/lib/taskBoard.test.ts`：归档/恢复/全部归档、仅完成卡可归档、持久化与非法值丢弃用例替换原 clearDone 用例

## 2. 视图层

- [x] 2.1 `app/src/panels/TaskBoardView.tsx`：完成列「全部归档」+「显示/隐藏已归档」切换；归档卡片置灰 +「已归档」徽标 +「恢复」；归档卡不可拖拽/移动；列计数排除归档
- [x] 2.2 `app/src/panels/TaskBoardView.test.tsx`：全部归档、单卡归档隐藏、显示切换与恢复、计数排除用例替换原清空用例
- [x] 2.3 `app/src/lib/i18n.ts`：新增 `board.archive.*` 与 `board.archived.tag`（zh/en），移除 `board.clearDone`

## 3. 验证

- [x] 3.1 `npm run test`：看板用例全绿，全量无新增失败
- [x] 3.2 `tsc -b` / `vite build` 通过
- [x] 3.3 `openspec validate task-card-archive` 通过后归档，重打包启动应用
