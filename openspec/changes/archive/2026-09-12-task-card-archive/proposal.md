## Why

「完成」列目前只有「清空已完成」= 直接删除，数据不可恢复；参考产品 Autocode 的看板是**归档模型**（archived 标记、归档区显示/隐藏切换、全部归档），完成后任务被保留归档而非删除。需要对齐这套交互。

## What Changes

- 「完成」列卡片新增**归档**操作：归档后卡片保留在「完成」列数据中但默认隐藏，样式置灰并标注「已归档」。
- 列头新增**全部归档**（一键归档所有未归档的已完成卡片，替代原「清空已完成」的删除语义）与**显示已归档 / 隐藏已归档**切换（有归档卡片时出现）。
- 已归档卡片可**恢复**回「完成」列普通状态；不拖拽、不计入列计数与徽标。
- 数据模型增加 `archived` 标记（持久化，旧数据天然兼容）；删除语义仍保留在单卡「删除」按钮上。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `task-board`: 「清空已完成」需求改为「完成归档」——归档替代删除，新增单卡归档/恢复、全部归档与显示切换。其余需求不变。

## Impact

- `app/src/lib/taskBoard.ts` — `TaskCard.archived`；`archiveTask`/`restoreTask`/`archiveAllDone` 替代 `clearDone`；sanitize 校验布尔值。
- `app/src/panels/TaskBoardView.tsx` — 完成列归档交互与置灰样式、显示切换。
- `app/src/lib/i18n.ts` — 新增归档文案键（zh/en），移除 `board.clearDone`。
- 测试：`taskBoard.test.ts`、`TaskBoardView.test.tsx` 同步更新。
