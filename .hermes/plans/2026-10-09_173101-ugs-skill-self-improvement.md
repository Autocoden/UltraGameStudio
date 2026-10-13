# UGS 技能自我改进 Implementation Plan

> **For Hermes:** Use the applicable implementation/delegation skills to execute this plan task-by-task. Follow test-driven-development. Do not implement, commit, push, or change unrelated files until the user authorizes implementation.

**Goal:** 让 UGS 能从真实任务中提炼可复用流程，优先修补已有技能，可靠保存后在后续相关任务中使用，并向用户展示可核验、可撤销的学习结果。

**Architecture:** 建立独立的 SKILL.md 技能库与统一的技能读写服务；前台学习、后台复盘和人工审批都经过这一个服务。模型负责提出经验与修改，宿主负责身份、权限、校验、事务和结果判定；学习不修改正在运行的会话系统提示，也不写入记忆模块。

**Tech Stack:** 现有 React / TypeScript / Zustand、Tauri 2 / Rust、模型网关；后续适配 Node 远程 Runner。第一版不增加向量数据库或新的模型训练服务。

---

## 1. 范围与交付边界

### 本计划包括

- `SKILL.md` 与 `references/`、`templates/`、`scripts/`、`assets/` 技能包。
- 技能发现、按需读取、复用、创建、定向修改。
- 用户主动 `/learn` 学习、`/refine` 复盘当前任务。
- 独立后台技能复盘、审批、来源、差异、事务、回滚。
- 后续使用统计、整理、归档、恢复及可选合并。

### 明确不包括

- 记忆功能扩建、记忆与技能合并、迁移 MEMORY/USER 数据。
- 模型参数训练，或仅靠修改提示词声称模型变强。
- 让模型自动改 UGS 产品源码、内置能力权限、凭据或系统配置。
- 自动执行新生成的 `scripts/` 文件、自动发布技能到外部平台。
- 首版建设技能市场、embedding 检索或跨设备双向同步。

**关键区分：** `app/src/lib/gameSkill.ts` 中的 GameSkill 是 UGS 内置命令/能力的编程定义，不是学习产物的存储。学习产物使用磁盘上的 SKILL.md；可以复用现有能力目录作为入口，但不能让后台模型重写 GameSkill 类、注册表或 capability manifest 来“学会”东西。

## 2. 已确认的基础与缺口

| 当前基础 | 已读接入点 | 本次需要补齐 |
|---|---|---|
| 本地技能扫描、安装、卸载、目录刷新 | `app/src-tauri/src/lib.rs:2403`、`:2527`、`:3021` | UGS 自管根、完整读取、统一变更事务与审批 |
| 项目技能根及启停设置 | `app/src/lib/projectSettings.ts:65`、`app/src-tauri/src/lib.rs:5263` | 自管技能的项目/全局作用域及学习策略 |
| slash 建议、技能摘要展示 | `app/src/lib/slashCommands.ts`、`app/src/panels/aidock/slashSuggestions.ts:122` | 从“摘要扩写”升级为按需读到完整技能与引用文件 |
| 项目设置已有 Skills 页面 | `app/src/panels/ProjectSettingsModal.tsx:5020` | 学习入口、待审批、来源、历史、恢复 |
| 主聊天及独立模型调用 | `app/src/store/useStore.ts:6293`、`app/src/lib/modelGateway/modelGateway.ts:25` | 技能上下文/复盘接入，安全的后台调用策略 |
| CLI 结构化工具事件 | `app/src/components/ai/lib/toolEvent.ts:19` | 有归属、去重、可追溯的任务证据和活动计数 |
| 远程项目技能扫描 | `backend/src/workspace-skills.mjs:312`、`backend/src/server.mjs:848` | 后续远程读写、审批和事务，不借用本地路径 |
| UGS 存储根 | `app/src-tauri/src/storage_paths.rs:6`、`:114` | 使用 UGS_HOME 解析，不能硬编码用户目录 |

**不能把现有扫描/安装等同于学习闭环。** 目前所读的 slash 扩展路径主要把技能名和摘要变成提示；后续必须验证模型实际读取并采用完整技能，不能以“菜单里出现了技能”作为复用完成。

**重要安全缺口：** `completeGatewayText` 可以从直连失败降级到 CLI，CLI 默认 `permission: 'full'`。后台复盘不能原样复用这条路径，否则所谓“只整理技能”可能变成能改整个项目的完整编码代理。

## 3. Hermes 参考与 UGS 的适配原则

官方说明：
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills

补充源码参考：本地 Hermes checkout `1744a19e0df568c647e4f3ff9c37f2a284a282fb`；本次检查涉及的核心参考文件没有 Git 未提交修改。官方文档优先解释产品语义，源码用于核对机制；两者有差异时记录差异，不把当前 checkout 当成永远不变的规格。

| Hermes 机制 | UGS 方案 | 对齐程度/差异 |
|---|---|---|
| skills_list → skill_view → 按需读引用文件 | 同样采用三级加载，不把整个技能库塞进每轮提示 | 对齐核心机制 |
| skill_manage 的 create / patch / supporting-file 操作 | 一个统一变更服务，优先 patch；模型不能绕过审批直接写文件 | 对齐核心机制 |
| 后台 review fork 与前台会话隔离 | 独立运行 ID、快照、取消控制、只允许技能读写服务 | 对齐隔离原则，不要求直接移植 Python AIAgent |
| 先读目标再修改 | 宿主签发读取回执与内容 hash，批准时再次检查 | 对齐并强化并发安全 |
| 多操作批次与失败恢复 | 保留批次，不拆成独立审批；事务日志、CAS、恢复 | 对齐原子批次意图 |
| 后台技能 nudge | 有活动阈值，正常任务结束后才复盘 | 默认阈值参考 10，但计量单位必须如实注明 |
| write_approval | 前台学习和后台复盘共用同一审批策略 | UGS 首版默认开启；Hermes 文档默认 false |
| usage / curator / archive / restore | 后续引入侧车统计、归档、恢复、可选合并 | 分期，不一次复制全部 |
| 从工具执行结果汇报变更 | UI 只认宿主提交结果，不认模型自述 | 对齐核心机制 |

### 必须保留的事实差异

1. 当前本地实现的 nudge 是 agent-loop iteration 累计，回合结束后检查，**不是每十条用户消息**。UGS 如果拿不到 harness iteration，只能用去重后的已完成工具活动作为代理指标，并在配置说明中写清楚。
2. 当前本地代码对后台内容修改要求先读目标；ownership/adopt 等保护集中在删除/归档，并非所有 patch 都必须先 adopt。UGS 可以选择更保守的自管库策略，但不能称其为 Hermes 的原样权限规则。
3. pin 的含义是防止删除/自动归档，不是冻结一切内容修改。UGS 保持该含义，不用一个开关承载互相矛盾的语义。
4. 官方 Curator 文档当前 `prune_builtins: true`，LLM consolidation 默认关闭。UGS 首版不自动整理内置或外部技能，这是 UGS 的安全选择。
5. 审批、安全扫描和隔离是不同机制。审批不能替代路径约束；危险模式扫描也不是“证明技能安全”。

## 4. 推荐的首版行为

- **自动复盘默认关闭；手动学习立即可用；所有技能变更默认待审批。** 这是 UGS 首版推荐策略，不是 Hermes 默认值。
- 优先更新已读过的现有技能，必要时新建；不因每次不同报错创建一个小技能。
- 项目特定经验默认保存在项目库；明确可跨项目复用的经验才提议进入全局库。
- 只有宿主记录的证据能标记“已验证”；模型写一句“测试通过”不算。
- 对未经验证的来源允许保存为显式待验证知识，但不得伪装为已跑通的操作流程；首版自动复盘只提交有实证的经验提案。
- 原始报错、临时任务进度、凭据、一次性文件名不要固化。将经验写为适用条件、流程、反例、停止条件、验证方法。
- 不自动改外部 CLI 技能库。可读它们；需要改进时提供“导入 UGS 自管副本后修改”的提案，保留原来源，不静默覆盖原库。
- 不支持安全学习调用的通道显示明确原因；不偷偷降级到全权限 CLI。

## 5. 技能库、身份和加载

### 5.1 存储布局（拟新增）

- 全局自管技能：`<resolved UGS_HOME>/skills/[category/]<name>/SKILL.md`
- 项目自管技能：`<project>/.ultragamestudio/skills/[category/]<name>/SKILL.md`
- 学习配置、待审批、运行结果：`<resolved UGS_HOME>/skill-learning/`
- 技能元信息/统计：技能根中的隐藏侧车文件；不写进 SKILL.md 正文。
- 事务临时目录：放在目标技能根同一文件系统的隐藏目录，保证 Windows 跨盘时不依赖跨盘 rename。
- 回滚内容：内容寻址备份与变更清单；保存位置由存储服务统一解析。

技能正文保持 Agent Skills 兼容。UGS 特有的来源、审批、hostId、ownership 等放在侧车记录，避免导出后把系统元数据当成技能指令。

### 5.2 身份

每个技能使用稳定 `skillId = hostId + rootId + relativeSkillPath`，显示名称与身份分离。每个操作必须指定 skillId/rootId，而不是仅用裸 name 定位。

建议查询优先级：项目自管 > 全局自管 > 外部只读目录。同级同名冲突必须让用户/模型使用限定身份，不能靠扫描顺序选一个；同一物理路径按 canonical path 去重。

不得自动“修复”非法名称后写入另一个技能。新建名称参考 Hermes 的小写安全标识、长度上限；另外拒绝 Windows 保留文件名、尾随点等无法可靠落盘的名称。

### 5.3 按需加载

- L0：名称、短描述、作用域、来源、可用性。新描述目标不超过 60 字符，触发信息在前。
- L1：用户显式 `/skill-name` 或模型选择后读取完整 SKILL.md。
- L2：按相对路径读取一个引用文件，不自动展开整个包。
- 读取支持现有 UTF-8 BOM/CRLF；新写文件统一 UTF-8、无 BOM。
- 会话起始技能索引可冻结；当前回合加载的内容放在新的回合上下文/工具结果中。保存新技能后不回写旧消息、不重建当前会话系统提示。
- 新会话取得最新目录；当前会话显式重新加载也能得到最新版本，并标记版本/hash。菜单刷新不等于把完整库重新注入系统提示。

## 6. 统一技能服务与协议（以下接口均为拟新增）

### 6.1 服务职责

| 接口/动作 | 约束 |
|---|---|
| list | 只返回当前 host/workspace 授权目录，带冲突与可用性信息 |
| view(skillId, relativeFile?) | 仅包内相对文件，返回内容、hash、宿主读取回执；回执不能由模型自填 |
| manage(operations[]) | 显式批次；默认先校验/暂存，不能直接解析任意聊天文本执行 |
| create | 完整 SKILL.md；已存在则 conflict，不隐式 overwrite |
| patch | exact old/new；默认唯一匹配，未匹配或多匹配返回冲突，不盲目模糊替换 |
| write_file / remove_file | 只允许 supporting-file 子目录，覆盖/移除须有对应读取回执 |
| approve / reject | 基于 proposalId 和原目标，保留批次；批准要重验 hash 和权限 |
| archive / restore / rollback | 后续受来源、pin、引用和当前 hash 约束，不自动硬删除 |

首版不暴露自动硬删除。未来如果提供 Hermes 兼容的 delete 名称，必须明确其 UGS 行为是可恢复归档；不要用相同名称隐藏不同语义。

### 6.2 提案记录

提案至少包含：schemaVersion、proposalId、batchId、hostId、workspaceId、canonicalProjectRoot、sourceSessionId、sourceTurnId、reviewRunId、origin、createdAt、rootId、operations、宿主保存的 beforeHashes/readReceipts、reason、evidenceRefs、reviewModel、status。

- origin 区分 user-directed / manual-review / background-review / curator，由宿主赋值。
- “作者是谁”“是否允许自动整理”“来自哪个会话”分别记录，不用 created_by 一个字段混为一谈。
- evidenceRefs 指向真实用户纠正、工具结果、退出码、验证产物；截断要标记。
- 保存提案和备份前脱敏，不读取 `.env` 或凭据文件作为学习素材。
- 拒绝记录保留去重键，避免同一经验反复打扰。

### 6.3 状态与真实结果

ReviewRun：queued → running → completed / cancelled / failed；completed 可以是 no_change 或 proposals_created。

Proposal：pending → applying → applied / rejected / conflict / failed。取消复盘不等于撤销已经 committed 的变更；提交前取消则不能再生成/应用过期结果。

变更响应至少包括 `status`、`operationsApplied`、目标 IDs、before/after hashes、changedFiles、receiptId、error。只有 commit 完成且目标内容核对通过才能返回 applied；staged、失败、已回滚均不能汇报“已学会/已保存”。

## 7. 安全、事务与证据

### 7.1 宿主强制的边界

- canonical root 校验、路径穿越和绝对路径拒绝、Windows symlink/junction/reparse point 防护。
- supporting files 必须在允许子目录；拒绝越界链接及 root 自身操作。
- YAML 必须真实解析，不能靠正则验证 mapping、必填字段和闭合。
- 参考 Hermes：SKILL.md 内容不超过 100,000 字符，单 supporting file 不超过 1 MiB；额外设置每批文件数、总字节与模型输出预算。
- 原引用链接/脚本迁移时检查不存在的文件；允许危险内容检测给出 warning/block，但不能宣称静态扫描无误即绝对安全。
- 后台工具白名单：技能 list/view/manage 和授权技能路径内的只读搜索。禁止终端、泛用 write/patch、网络发布、UGS_GEN、记忆工具和递归学习。
- 学习 runner 不进入主聊天的 sentinel/素材生成/交互解析链路；文档或工具结果中出现协议字样不能触发操作。
- 授权范围、origin、读取回执来自宿主；模型输出不能扩大 scope 或改变 policy。

### 7.2 写入与恢复

1. 对批次目标按稳定顺序加锁，读取当前内容并验证 CAS/hash。
2. 在目标卷内准备 staging 与 before-state 备份；先写可恢复的事务日志。
3. 对拟写完整包进行结构/安全/引用检查，任何错误整体拒绝。
4. 提交目标变更，核对 after-state，持久化 commit receipt，再发布目录/提案状态事件。
5. 中途失败恢复 before-state；如果恢复失败必须进入 recovery_required，禁止显示 applied。
6. 启动/读取服务发现未完成事务时先恢复，再对 UGS 读者暴露技能。

**原子性承诺：** UGS 服务的批次表现为逻辑上的全成或全败，并能从崩溃恢复。多文件/多目录不是一次操作系统级原子 rename；外部程序直接读文件时不能承诺绝不会看到切换中间态。因此外部同步只在成功提交后执行，内部读写使用同一事务锁/恢复协议。

恢复备份/事务日志是提交前提；使用次数等非关键 telemetry 失败不应破坏主任务。不要照搬“审计失败也照常修改”而同时承诺必定可回滚。

### 7.3 依赖注意

现有 Cargo.toml 有 sha2，但没有 YAML parser。候选 `yaml-rust2 = 0.11.1` 已在 crates.io 元数据确认未 yanked、MSRV 1.65，可兼容项目声明的 Rust 1.77.2；实施时核对 API 和安全维护情况后再选定/锁定。不要直接取目前 0.13.0，它声明 MSRV 1.85，不能无意提高产品工具链要求。

## 8. 分期开发与实施任务

所有产生代码的任务都按小行为切片执行：先写一个失败用例 → 运行并确认失败原因 → 实现最小路径 → 重跑通过 → 再覆盖下一个边界。不得先写完一大堆测试再统一填实现。下列新文件/接口是拟定落点，不是仓库现有符号；实施前再次追踪最新定义和调用。

### Task 0：锁定基线与接入边界

**目标：** 不把用户已有脏工作区当成本次变化；确认首版只实施本地手动学习。

**读取：** 本计划引用的现有文件、app/package.json、Cargo.toml、实际目录指导文件。

**步骤：**
1. 重新检查 Git status/branch 与当前目标文件；不 reset、stash 或批量格式化用户改动。
2. 捕获相关测试、typecheck、构建的当前基线；列出已有失败，必要时机器可读比较。
3. 固定 V1 范围和安全学习通道；若只有不受限 CLI，则先提供明确配置阻塞，不宣称已可安全自动学习。

**完成标准：** 已有失败与本次验收分开；不提交、不推送，除非用户另行要求。

### V1：完整的本地手动学习闭环（推荐先交付）

### Task 1：UGS 自管技能目录与稳定身份

**文件：**
- Create: `app/src-tauri/src/skills/mod.rs`、`types.rs`、`catalog.rs`
- Create: `app/src/lib/skills/types.ts`、`service.ts`
- Modify: `app/src-tauri/src/lib.rs`、`app/src/lib/tauri.ts`、`app/src/lib/projectSettings.ts`
- Test: Rust skills 模块内测试、`app/src/lib/skills/service.test.ts`、`app/src/lib/projectSettings.test.ts`

**切片：** 根路径解析 → 扫描一个自管技能 → 分类子目录 → 项目/全局优先级 → 同名冲突 → 外部目录只读。

**先失败用例：** 新 UGS 根无法被发现；两个同名技能不能稳定寻址；不同 workspace 的技能不能串库。

**验收：** 每个发现结果都有稳定 skillId/host/root；禁用目录不参与查询；已有 CLI 根不被迁移或覆盖。

### Task 2：完整读取与第一次实际复用

**文件：**
- Create: `app/src/lib/skills/context.ts`、`context.test.ts`
- Modify: `app/src-tauri/src/skills/catalog.rs`、`app/src/lib/skills/service.ts`
- Modify: `app/src/lib/slashCommands.ts`、`app/src/panels/aidock/slashSuggestions.ts`、`app/src/store/useStore.ts`
- Test: `app/src/lib/slashCommands.test.ts`、`app/src/store/useStore.simple-chat.test.ts`

**切片：** 显式技能命令获取真实 skillId → 宿主读取正文和 hash → 当前请求追加正文 → 按需单独读 reference。

**先失败用例：** slash 请求仅拿到摘要；引用越界；技能内容变更导致旧系统提示被重写。

**验收：** 用现有测试 fixture 验证请求确实含正文/目标引用；无关技能不加载；历史消息和已冻结系统前缀未变。先完成这一垂直切片再扩大管理功能。

### Task 3：新建技能的“暂存→批准→后续读取”路径

**文件：**
- Create: `app/src-tauri/src/skills/validation.rs`、`pending.rs`、`transactions.rs`
- Create: `app/src/lib/skills/pending.ts`、`pending.test.ts`
- Modify: `app/src-tauri/Cargo.toml`、`app/src-tauri/src/skills/mod.rs`、`app/src/lib/skills/service.ts`

**切片：** 合法 create 暂存 → 重启仍可读提案 → 人工批准 → 落盘核对 → 读取新技能。随后覆盖 YAML/name/path/容量错误。

**先失败用例：** 待审批内容被提前发现；切换项目后批准写错地方；create 同名覆盖已有内容。

**验收：** applied 只能来自宿主 receipt；pending 不进入活动技能目录；批准固定原 workspace/host，而不是点击时的活动项目。

### Task 4：定向 patch 与 supporting files 的原子批次

**文件：**
- Modify: `app/src-tauri/src/skills/validation.rs`、`transactions.rs`、`pending.rs`
- Modify: `app/src/lib/skills/types.ts`、`service.ts`
- Test: Rust mutation/transaction 测试、`app/src/lib/skills/service.test.ts`、`pending.test.ts`

**切片：** 唯一 exact patch → 覆盖 reference → 新 supporting file → remove supporting file → 一个 create 后写 supporting file 的批次。

**先失败用例：** 未读目标就改；old_string 多处命中；第二个操作失败但第一个已留下；批准前人工编辑产生 stale hash；Windows junction 跳出技能根。

**验收：** 一批一次批准、全成或全败；失败保留错误和原内容；模型不能伪造 read receipt；支持 BOM/CRLF 读取但不改错匹配。

### Task 5：变更日志与单次回滚

**文件：**
- Create: `app/src-tauri/src/skills/ledger.rs`
- Modify: `app/src-tauri/src/skills/transactions.rs`、`app/src/lib/skills/service.ts`
- Test: Rust journal/recovery/rollback 测试、`app/src/lib/skills/pending.test.ts`

**切片：** 单变更 before/after 清单 → 内容备份 → 回滚 → 回滚本身记录 → 崩溃恢复。

**先失败用例：** 没有备份仍宣称可撤销；回滚覆盖后来人工改动；提交中崩溃后展示半个包；磁盘满写日志失败。

**验收：** 回滚只影响目标变更触及的文件；当前 hash 不符时提示冲突；恢复失败有 recovery_required，不能继续假报保存成功。

### Task 6：安全、独立的技能学习 runner

**文件：**
- Create: `app/src/core/skillReview.ts`、`skillReview.test.ts`
- Create: `app/src/lib/skills/reviewRunner.ts`、`reviewRunner.test.ts`
- Modify: `app/src/lib/modelGateway/types.ts`、`modelGateway.ts`
- Test: `app/src/lib/modelGateway/skillReviewPolicy.test.ts`（新增）

**切片：** 直连学习路由 → 禁 CLI 降级 → 宿主收集技能索引/候选 → 读取当前目标 → 模型返回结构化提案 → 调用同一 manage 服务。

首版可以用宿主编排的文本/JSON 两阶段调用：先选 skillId，再用已经读取的内容提出 operations；这是网关现状下的兼容层，不宣称已有原生 tool calling。后续原生工具模式仍复用相同服务和结果类型。

**拟新增调用策略：** 学习请求明确 `allowCliFallback: false`；所有分支（forceCli、无直连路由、直连异常降级）必须执行该策略。复盘内容不送主聊天解析器。

**先失败用例：** 网络失败启动全权限 CLI；模型返回伪造 root/read hash；参考文件包含协议字样触发写入；取消后迟到结果仍入队。

**验收：** 未支持通道返回 UNSUPPORTED_SAFE_REVIEW_ROUTE；失败最多一次有界结构纠正，不无限重试；无终端/素材生成/记忆权限。

### Task 7：/learn 与 /refine，并优先更新已有技能

**文件：**
- Modify: `app/src/lib/capabilityCatalog.ts`、`app/src/lib/slashCommands.ts`、`app/src/panels/AIDock.tsx`
- Modify: `app/src/lib/skills/reviewRunner.ts`、`app/src/core/skillReview.ts`
- Test: `app/src/panels/AIDock.slash.test.tsx`、`app/src/core/skillReview.test.ts`

**/learn：** 明确把当前对话中的流程、用户粘贴材料或选定技能包导入/改进。首版不自动抓任意 URL；URL/大文档接入后续复用已有受控读取能力。

**/refine：** 对当前会话/任务快照复盘，允许结果为“没有值得保存的经验”。默认检查本任务实际加载的技能及同类候选。

**切片：** 一段已验证流程生成提案 → 用户纠正转为现有技能 patch → 现有 reference 追加同主题经验 → 无合适技能才 create。

**先失败用例：** 每次复盘都建新技能；单次猜测被写成已验证结论；把原始任务日志整段塞进正文；外部技能被静默覆盖。

**验收：** 提案包含修改理由与真实 evidenceRefs；模型解释为何更新/新建；用户有 pending diff 和后续复用路径。

### Task 8：学习结果与审批 UI

**文件：**
- Create: `app/src/components/ai/SkillLearningSummary.tsx`、`.test.tsx`
- Create: `app/src/panels/settings/SkillLearningSettings.tsx`、`.test.tsx`
- Modify: `app/src/panels/ProjectSettingsModal.tsx`、`app/src/panels/SettingsModal.tsx`、`app/src/panels/AIDock.tsx`
- 如需消息扩展：`app/src/store/types.ts` 与已有 history 序列化路径；实施前追踪完整读写，不只给 React 添加临时字段。

**布局：** 复用现有 Skills 页面，增加“学习”入口；聊天末尾仅一行可展开结果，不增加独立大面板和重复 toast。全局设置管理默认策略，项目页管理 override 与本项目提案。

**状态文案：** “发现可复用经验，待审批” / “已更新技能” / “无需更新” / “内容已变更，需重新复盘” / “保存失败”。不要把 pending 显示成已学会。

**切片：** pending 展示 → diff 展开 → 批准/拒绝 → applying 禁重复点击 → applied 可查看/回滚 → 重启恢复。

**先失败用例：** 后台结果出现在错误会话；实际写入失败 UI 仍成功；approve all 拆散一个批次；长路径/错误文案遮住动作。

**验收：** 后台结果作为独立学习记录关联原会话，不追加假 assistant/user 消息；支持键盘、窄宽、明暗主题；浏览器验收与 jsdom 语义测试分别记录。

**V1 发布门槛：** 一个真实任务 → /refine → 已有技能 patch 提案 → 查看 diff → 批准 → 重启/新会话 → 读取修订内容 → 完成同类任务 → 可回滚。新建技能路径另测。只有按钮和列表不算 V1 完成。

### V2：接近 Hermes 的自动复盘（V1 验收后）

### Task 9：原生技能工具适配与受限循环

**文件：**
- Create: `app/src/lib/skills/toolRunner.ts`、`toolRunner.test.ts`
- Create: `app/src/lib/modelGateway/skillTools.ts`、`skillTools.test.ts`
- Modify: 按实际实现需要扩展 `app/src/lib/modelGateway/adapters/anthropic.ts`、`openaiCompatible.ts`；不破坏既有 text API。

**切片：** skills_list → skill_view → skill_manage 的 provider-neutral 消息/结果 → Anthropic/OpenAI-compatible 各一个真实调用 → 不支持 tool calling 的通道走受限 JSON 兼容层。

**先失败用例：** 工具结果关联错 ID；模型调用非白名单工具；切换通道丢失消息顺序；索引每轮变化破坏前缀。

**验收：** 无论原生还是兼容层，调用同一 service；限制步数/输出/累计输入；主会话前缀和历史保持不变。若当前适配器无法提供循环隔离，明确保留手动模式，不假装完整 fork 已实现。

### Task 10：后台触发、快照与取消

**文件：**
- Create: `app/src/lib/skills/reviewScheduler.ts`、`reviewScheduler.test.ts`
- Modify: `app/src/store/useStore.ts`、`app/src/lib/skills/reviewRunner.ts`
- 后续 workflow 接入：`app/src/runtime/gateway.ts`；先追踪 RunContext/任务结束所有调用点。
- Test: `app/src/store/useStore.simple-chat.test.ts`

**切片：** 正常任务结束触发 → 活动累计达到阈值 → 去重/冷却 → 不可变快照 → 新前台任务抢占取消 → source session 被关闭/删除的处理。

**计量：** 若有 agent iteration 事件用它；否则归一化宿主完成事件并按 tool-call ID 去重。start/done 两个 patch 不算两次；不从普通聊天文字猜工具次数。直接闲聊默认不参与自动技能复盘。

**先失败用例：** 每个流式 delta 都触发；重启重复复盘同一 turn；后台自己触发后台；取消后迟到提案污染新任务；审批应用期间新任务被长时间阻塞。

**验收：** 同一来源只有一个有效 review；前台优先；取消发生在 commit 后不能误撤销既成事实；模型运行日志不写入主会话 transcript。

### Task 11：策略持久化、预算与通知

**文件：**
- Create: `app/src/lib/skills/config.ts`、`config.test.ts`
- Modify: `app/src/panels/settings/SkillLearningSettings.tsx`、`app/src/lib/usageMeter.ts`、`app/src/lib/skills/reviewScheduler.ts`
- Test: `app/src/panels/settings/SkillLearningSettings.test.tsx`、usage meter 相关现有测试

**首版推荐配置：** autoReview=false、writeApproval=true；启用自动复盘后活动阈值参考 10，计量单位显式展示。支持独立学习模型、冷却、每运行步数/输入/输出预算、通知级别和项目 override。

**注意：** 不根据 haiku/sonnet 等类别名称声称一定便宜；使用实际路由和真实 usage，无法得知价格时只显示 token/估算标记。学习调用与前台调用分组记录，避免后台流量混进某一条前台回答的使用量。

**先失败用例：** 设置只在 localStorage 中，重启或换项目丢失；单次请求受限但累计循环无限耗费；模型失败后反复即时重试。

**验收：** 关闭后不启动新的 review；策略变化不重写旧系统提示；审批开启覆盖所有学习写入口；主任务不因学习失败而失败。

### V3：技能库长期治理（可独立延期）

### Task 12：使用统计、pin、归档与恢复

**文件：**
- Create: `app/src/lib/skills/usage.ts`、`usage.test.ts`、`curator.ts`、`curator.test.ts`
- Modify: `app/src-tauri/src/skills/ledger.rs`、`catalog.rs`、`app/src/panels/settings/SkillLearningSettings.tsx`

**切片：** view/load/patch 单独计数 → 明确 autoMaintain/adopt 策略 → pin → stale 标记 → 可恢复 archive → restore。

**先失败用例：** 读过就算成功使用；人工创建/外部技能自动归档；pin 技能丢失；工作流/计划任务引用的技能被移走；恢复与当前同名技能冲突。

**验收：** 自动治理只针对明确交给 UGS 管理的技能；不自动硬删除；定期整理先给 dry-run；首次观察先建立时钟，不立即归档旧库。

### Task 13：可选的相近技能合并

**文件：**
- Modify: `app/src/lib/skills/curator.ts`、`app/src-tauri/src/skills/transactions.rs`、`ledger.rs`
- Test: `app/src/lib/skills/curator.test.ts` 与包迁移 Rust 测试

**切片：** 找到相近候选 → 生成合并提案 → 将完整 supporting files 重定位并重写链接 → 验证新包/引用 → 批准后归档旧包 → old→new 映射。

**先失败用例：** 只合并 SKILL.md 丢脚本/模板；归档后已有工作流找不到技能；失败留下半个 umbrella。

**验收：** LLM 合并默认关闭；先保存新包并核对所有引用，再归档旧包；包级备份和映射可恢复。不把“使用频率增加”当成解决任务质量变好的证明。

### V4：远程与更多适配器（不阻塞本地首版）

### Task 14：远程项目技能服务与 CLI 覆盖

**文件：**
- Modify: `backend/src/workspace-skills.mjs`、`backend/src/server.mjs`、`backend/test/workspace-skills.test.mjs`
- Create: `backend/src/skill-learning.mjs`、`backend/test/skill-learning.test.mjs`
- 修改前定位 remote client、CLI 命令分发和项目归属校验的真实文件，不凭计划猜路径。

**切片：** 远程完整读取 → 远程 pending/approve → host-bound CAS/事务 → 远程原会话结果 → CLI 命令映射到同一协议。

**先失败用例：** 远程提案批准写到本地；不同用户能读/批别人的提案；git-pull 后 stale patch 被强行应用；本地全局技能无意注入远程项目。

**验收：** 权限按登录用户/项目绑定；服务端解析 root，客户端不能传任意绝对路径；仅在目标 host 写入并读回核对。CLI 如需模型复盘必须验证 completion-only 或受限工具能力，不能依靠提示词充当 sandbox。

### Task 15：真实端到端验证与发布文档

**文件：**
- Create: `app/src/lib/skills/learning.integration.test.ts`
- Create: `app/doc/skill-self-improvement.md`
- Update only if needed: `app/doc/ultragamestudio-cli-skill-spec.md` 中与实际已实现 CLI 命令有关的章节。

**自动化验收：** 正常更新/新建；无值得保存经验；结构错误；重复/冲突；批次 rollback；重启 pending/recovery；源项目/会话切换；取消；预算；权限；上下文加载与前缀稳定性。

**真实验收：** 使用授权测试工作区和真实模型运行 /learn、/refine；查看原目标文件与 receipt；新会话执行同类任务，检查加载了正确技能版本；然后回滚并验证恢复。不能拿 fixture 或 mocked gateway 的输出冒充真实模型/后端成功。

**发布文档：** 明确这不是训练、默认审批、适用通道、作用域、失败/冲突处理、恢复，以及自动治理 opt-in。没有完成远程/某 CLI 时直接列“不支持”，不承诺所有适配器都可自动学习。

## 9. 验证命令与执行说明

以下是实施阶段的命令，不代表本轮已经执行或通过。新测试文件必须实际创建后才能运行对应命令。

在 `E:/UltraGameStudio/app`：

- `NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/lib/skills src/core/skillReview.test.ts src/lib/modelGateway/skillReviewPolicy.test.ts`
- `NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/lib/slashCommands.test.ts src/lib/projectSettings.test.ts src/store/useStore.simple-chat.test.ts src/panels/AIDock.slash.test.tsx`
- `npm run typecheck`
- `npm run check:prompt-lock`（输入框行为守护；不能代替系统提示前缀不变测试）
- `npm run build`
- `NODE_OPTIONS=--no-experimental-webstorage npm run test`，与 pre-edit 基线逐项比较。
- `npm run lint`；已有错误单列，只修本次引入或触及范围内的问题。

在 `E:/UltraGameStudio/app/src-tauri`：

- `cargo test --lib skills::`
- `cargo check`
- 对目标 Rust 文件做 fmt 检查；不要用全仓格式化覆盖用户未提交修改。

远程阶段，在 `E:/UltraGameStudio/backend`：

- `node --test test/workspace-skills.test.mjs test/skill-learning.test.mjs`
- `npm test`

Node/Vitest 环境注意：本会话此前观察到共享 jsdom storage setup 与 Node 原生 Web Storage 的冲突；上述环境开关用于隔离测试环境，实施时先确认现场版本/报错，不把环境失败误判为生产逻辑失败。

浏览器/桌面 UI 单独覆盖：pending/applied/conflict/failed/empty 状态；明暗主题；窄窗口和长中文路径；键盘 focus；批准、拒绝、撤销；切项目时结果归属。保存实际截图/DOM与错误记录，fixture 验证和真实后端验证分别报告。

## 10. 发布优先级与停止标准

| 里程碑 | 包含 | 交付判断 |
|---|---|---|
| V1 手动闭环 | Tasks 1–8 + 对应 Task 15 验收 | 能学、能审批、能复用、能回滚；记忆功能不动 |
| V2 自动复盘 | Tasks 9–11 | 独立、受限、可取消、可计费观察，不影响前台 |
| V3 长期治理 | Tasks 12–13 | 不积累碎片、归档可恢复、合并不丢包 |
| V4 多运行环境 | Task 14 | 本地/远程身份和权限隔离，每个适配器真实验证 |

**建议立项顺序：V1 → V2 → V3；V4 按实际远程/CLI需求排期。** 不先投入大规模自动整理，也不只做一个“学习总结”气泡。最先证明完整闭环，再增加自动触发。

尚未实现或跑过的东西必须列为未验证。本轮只交付开发计划，不修改 UGS 功能代码，不声称技能自我改进已经可用。
