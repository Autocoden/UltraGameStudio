## 1. 数据层

- [x] 1.1 `app/src/lib/taskBoard.ts`：新增 `TaskMeta`（category/priority/complexity/impact 四个可选枚举字段）；`addTask` 增加 meta 参数；`updateTask` patch 支持 meta 浅合并；sanitizeCard 透传合法枚举、丢弃非法值
- [x] 1.2 `app/src/lib/taskBoard.test.ts`：meta 写入/编辑合并/非法值丢弃用例

## 2. 弹窗与视图

- [x] 2.1 新增 `app/src/panels/TaskBoardDialog.tsx`：创建/编辑双模式；标题（必填）+ 描述 + 2×2 分类下拉（分类/优先级/复杂度/影响，含占位、可置空）；取消/Esc 关闭；创建/保存按钮
- [x] 2.2 `app/src/panels/TaskBoardView.tsx`：列头"+"按钮打开弹窗（该列为初始阶段）；移除列底内联输入；卡片"编辑"改开弹窗（移除内联编辑表单）；卡片按 Autocode 规则渲染徽章
- [x] 2.3 `app/src/lib/i18n.ts`：弹窗、分类选项、列头加号等文案键（zh 对齐 Autocode 官方翻译；en 同步）
- [x] 2.4 `app/src/panels/TaskBoardView.test.tsx` + 新增 `TaskBoardDialog` 相关用例：弹窗创建、空白标题拒绝、取消不创建、编辑预填保存、徽章显示规则

## 3. 验证

- [x] 3.1 `npm run test`：看板用例全绿，全量无新增失败
- [x] 3.2 `tsc -b` / `vite build` 通过
- [x] 3.3 `openspec validate task-board-create-dialog` 通过后归档，并重打包启动应用
