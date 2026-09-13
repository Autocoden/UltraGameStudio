## Why

看板目前直接在列底输入框创建卡片，与参考产品 Autocode 的交互不一致：Autocode 在列头放"+"按钮，点击后弹出**新建任务弹窗**（标题、描述、2×2 分类网格：分类/优先级/复杂度/影响），卡片按规则显示分类徽章。需要对齐这套交互与界面，让任务承载结构化元数据。

## What Changes

- 移除列底内联输入框；每列列头新增"+"按钮，点击弹出**新建任务弹窗**，提交后卡片落入该列末尾。
- 新建任务弹窗（对齐 Autocode TaskCreationWizard 的表单部分）：标题（必填）、描述（多行文本）、2×2 分类下拉网格——分类(feature/bug_fix/refactoring/documentation/security)、优先级(low/medium/high/urgent)、复杂度(trivial/small/medium/large/complex)、影响(low/medium/high/critical)，全部可选；取消/Esc 关闭不创建。
- 卡片编辑改为打开同一弹窗的编辑模式（预填全部字段），不再使用卡片内联编辑表单。
- 卡片显示分类徽章（Autocode 同款规则）：分类、复杂度——有值即显示；优先级——仅 high/urgent；影响——仅 high/critical。配色语义对齐 Autocode 常量表。
- 任务数据模型扩展 4 个可选元数据字段；存储保持 v2（可选字段，旧数据天然兼容）。
- 文案对齐 Autocode 官方中文翻译（功能/缺陷修复/重构/文档/安全；低/中/高/紧急；极低/小/中/大/复杂；低影响/中等影响/高影响/关键影响）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `task-board`: "卡片生命周期"需求改为经弹窗创建/编辑；"看板阶段"需求的卡片呈现部分增加分类徽章。另新增"新建任务弹窗"需求。其余需求不变。

## Impact

- 新增 `app/src/panels/TaskBoardDialog.tsx`（创建/编辑双模式弹窗）及测试。
- `app/src/lib/taskBoard.ts` — `TaskMeta` 元数据类型；`addTask`/`updateTask` 支持元数据；sanitize 透传合法枚举值。
- `app/src/panels/TaskBoardView.tsx` — 列头"+"按钮、弹窗接入、卡片徽章、移除内联输入与内联编辑。
- `app/src/lib/i18n.ts` — 新增弹窗与选项文案键（zh/en，选项文案对齐 Autocode）。
- 裁剪说明：Autocode 向导中的 git 分支/worktree、逐阶段模型选择、图片附件、文件引用、OpenSpec 预检均与看板无关，不纳入本次范围。
