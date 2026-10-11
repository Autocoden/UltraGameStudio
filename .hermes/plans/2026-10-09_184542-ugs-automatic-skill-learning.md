# UGS 自动学习与总结 Skill Implementation Plan

> **For Hermes:** Implement task-by-task using the applicable implementation/delegation skills and test-driven-development. Obtain implementation authorization first. Do not commit, push, reset, stash, read secrets, or modify unrelated work.

**Goal:** 让 UGS 在真实任务中主动复用技能，任务结束后自动提炼经验、优先修补已有技能、受控保存并总结真实变更，随后在新任务中读到并使用这些经验。

**Architecture:** 采用 Hermes 的“渐进加载 + 主动学习提示 + 独立后台复盘 + 统一技能管理 + 真实工具结果汇报”闭环。UGS 增加宿主编排的技能专用协议和事务服务；模型只提出读请求与修改，宿主掌握路径、权限、归属、校验、审批、提交和回滚。首版包含自动复盘与低风险自动保存，不以手动 `/learn` 代替自动能力。

**Tech Stack:** 现有 React / TypeScript / Zustand、Tauri 2 / Rust、Node 远程 Runner；复用现有模型路由、SHA-256 与 SQLite 依赖。拟新增 YAML 解析依赖与跨进程锁实现，实施时核对 `rust-version = 1.77.2` 兼容性并锁定版本。不新增向量数据库、训练服务或常驻 Python Agent。

---

## 1. 结论与范围

### 推荐路线

**采用 Hermes 的学习机制，不嵌入整个 Hermes 运行时。** UGS 自己管理技能库、证据与权限，兼容 SKILL.md 包格式。模型调用采用宿主受控协议，既能支持普通文本模型，又保留后续接原生 tool calling / MCP 的空间。

需要实现的不是“任务后多生成一段总结”，而是以下链路：

```text
相关任务开始
  → 发现技能 → 实际完整读取 → 按需读取引用 → 用于任务
  → 记录真实工具结果、验证、产物与用户纠正
  → 回合结束且触发条件满足
  → 独立复盘：先修当前使用的技能，再找已有同类技能，最后才新建
  → 宿主校验：归属 / 证据 / 新鲜读取 / 权限 / 内容 / 冲突
  → 低风险自动提交，其他修改进入审批
  → 按真实提交结果显示学习卡片
  → 下一相关任务读到新版本并采用
```

### 包含

- 自动复用、自动复盘、自动提炼、低风险自动保存、真实结果总结。
- `skills_list` / `skill_view` / `skill_manage` 语义；文本协议由宿主执行，不要求模型本身支持 function calling。
- 用户主动 `/learn`、`/refine [focus]`，但它们是自动闭环的补充，不是首版的唯一入口。
- SKILL.md、按主题组织的 references、来源、读取回执、版本、diff、审批、撤销与使用记录。
- 第一阶段支持桌面本地项目；第二阶段补 Node CLI / 远程宿主及生命周期整理。

### 不包含

- 记忆模块扩建、记忆与技能合并、模型参数训练。
- 自动修改产品源码、GameSkill 能力定义、执行权限、凭据、项目配置或 MCP 配置。
- 后台执行新生成脚本、自动安装依赖、对外发布技能。
- 首版向量检索、技能市场、跨设备双向同步、自动合并或永久删除技能。

**替代关系：** 本计划替代 `.hermes/plans/2026-10-09_173101-ugs-skill-self-improvement.md` 中“手动 V1 → 自动 V2”的优先级。旧计划保留作历史参考；其默认审批、分期与接口建议不是用户批准的产品规格。

## 2. Hermes 调研结果：哪些值得参考

### 2.1 渐进加载，而不是每轮灌入全部技能

Hermes 的发现层返回名称、描述与分类；使用时读取完整 SKILL.md，再按需读取支持文件。技能与 Agent Skills 开放格式兼容。[1][14]

**UGS 对应：** 小索引用于选择，完整内容用于执行。菜单摘要不算读过技能；仅扫描到文件不计入使用次数。

### 2.2 自动复盘有真实触发机制

固定参考源码中，`skills.creation_nudge_interval` 默认 10；`prepare_iteration` 在启用 skill_manage 时累加 agent-loop iteration；回合收尾检查阈值并清零，非中断且已有最终回复时才安排后台复盘。使用 skill_manage 也会将计数归零。[8][7][6]

该实现的单位不是“用户消息数”，也不是每一个工具调用；一次 agent-loop iteration 与一次工具活动不能直接等同。[7][28]

后台 review 的总开关默认启用；自动子代理复盘有额外门控，管理的本地推理运行时可延后到空闲执行。复盘输入做结构化克隆，避免改到前台历史。[9][27]

**UGS 对应：** 当前拿不到统一 harness iteration 时，显式使用“已完成工具活动”作为代理指标，配置中注明差异；不伪装成 Hermes 相同计量。明显用户纠正不必等到阈值。

### 2.3 学习提示主动，而且明确“先修补，最后才新建”

Hermes 把任务相关的用户风格/格式/流程纠正、非平凡技术、工具使用经验、已加载技能中的错误或遗漏作为学习信号。优先级是：当前加载技能 → 已有同类技能 → 支持文件 → 新的类级技能；写的是可复用规则及原因，而不是会话日志。[9]

Hermes 提示很主动，但仍允许确实没有新经验时不写入；不应把“每次必须新增技能”当成产品目标。[9]

**UGS 对应：** 首版就自动发现这些信号，规则必须能脱离本次会话独立使用；支持正常 `noop`，不能为提高新增数量而制造技能。

### 2.4 后台是独立运行，安全靠执行侧限制

Hermes 同模型复盘保留前台缓存前缀和工具声明，但在执行侧限制可调用工具；默认技能管理与只读文件工具可用，普通写文件、patch、terminal 不可用。技能单独触发的复盘不顺带拿到 memory 工具。[9]

同模型路径复用完整快照；切换复盘模型时使用紧凑历史摘要。当前参考 review 上限为 16 iterations，并有聚合输入预算，不能理解成一次零成本总结。[9]

**UGS 对应：** 只参考隔离与缓存原则，不机械复制 Python fork。先建立低权限宿主通道；缓存优化不得换来执行权限放大，也不能声称“小模型一定更便宜”。

### 2.5 读取、批次、审批和总结共同构成闭环

后台修改已有 SKILL.md 或支持文件前，Hermes 要求本次 review 实际读取确切目标；旧会话中的引用不替代新鲜读取。新建技能/新支持文件不需要先读取不存在的目标。[9][11]

skill_manage 支持原子批次语义、定向 patch 和支持文件操作；写审批默认关闭，开启后技能写入会进入待审流程。[10][13][1]

背景总结来自新增、成功的管理工具结果，跳过继承的历史结果；批次必须有 `operations_applied` 才能报告已应用的操作，模型的最终自述不是写入证明。[9]

**UGS 对应：** 新鲜读取进一步绑定内容 hash 与读回执；提交失败、待审、冲突、回滚都不能展示“已保存”。

### 2.6 整理器不是学习器，pin 不是内容锁

Hermes Curator 负责使用统计及 active / stale / archived 生命周期；不自动永久删除，LLM 合并默认关闭。当前官方文档与固定源码将 `prune_builtins` 描述为默认关闭的 opt-in；不能沿用旧参考资料中的默认 true。[2][15]

固定代码里 ownership 主要限制后台删除/归档，不限制一切内容 patch；pin 防删除/归档而非禁止内容修补。前台 user-directed create 与后台自主 create 的治理归属也不同。[11][10][2]

**UGS 对应：** 分开 `pinned`（不自动归档）与 `contentLocked`（不允许自动编辑）。采用更严格的自管库自动写策略，但明确这是 UGS 的安全取舍，不是声称逐字复制 Hermes 默认。

### 调研基线

- 官方文档读取日期：2026-10-09。
- 固定源码 revision：`8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f`；本次远端 HEAD 查询与它一致。
- 已以本地 `git show <revision>:<path>` 对照 scratch 中 11 个核心参考文件；经 CRLF/LF 归一化后全部一致。
- 关键锚点：`agent_init.py:1378`、`turn_iteration_prep.py:165`、`turn_finalizer.py:759`、`background_review.py:440 / :699 / :956 / :1079`、`skill_manager_guards.py:164 / :211`、`tool_executor.py:746`。
- 读过 Hermes 的 summary / cost-controls / batch 测试作为设计参考，但没有运行它们；不将源码阅读称为测试通过。

## 3. UGS 当前基础与真实缺口

本地工作树已重新检查：`main`，HEAD `034f599668f3221891764eb6ea5b966eb496e868`，有大量用户未提交修改。以下定位基于当前工作树，实施前重新确认，不 reset 或覆盖这些修改。

| 当前能力 | 当前接入点 | 需要补齐 |
|---|---|---|
| 技能根、扫描与安装管理 | `app/src-tauri/src/lib.rs:1838 / :2403 / :2527` | UGS 自管根、稳定 skillId、完整读取与变更服务 |
| slash 技能条目 | `app/src-tauri/src/lib.rs:2306`；`backend/src/workspace-skills.mjs:147` | 现路径将描述扩成提示；需要传递确定的技能身份并实际读取 |
| 目录更新订阅 | `app/src/panels/AIDock.tsx:2284` | 当前只比较条目 id，同 id 的描述更新可能被忽略；比较 revision / 内容摘要 |
| 项目技能配置 | `app/src/lib/projectSettings.ts:65`；`ProjectSettingsModal.tsx:4975` | 学习模式、作用域、自动编辑授权、待审与历史 |
| 主聊天文件汇总 | `app/src/store/useStore.ts:7069` | 保存结构化工具结果、纠正与运行归属；不能只复用 UI 文本 |
| 工作流终态与证据类型 | `app/src/store/useStore.ts:10255`；`app/src/runtime/types.ts:104` | 把真实证据和成功/中断状态送入统一学习入口 |
| 消息的本地展示标记 | `app/src/store/types.ts:114` | 学习卡片用结构化字段、UI-only 展示，不能变成下一轮模型自造事实 |
| 通用模型调用 | `app/src/lib/modelGateway/modelGateway.ts:25 / :85` | 直连失败可转 CLI，且 CLI permission 默认 full；后台禁止原样调用 |
| 直连模型适配 | `app/src/lib/modelGateway/types.ts:97`；`adapters/openaiCompatible.ts:53` | 现 TextRequest / 文本返回不是完整 tool-calling runtime；需技能专用协议 |
| CLI 启动与事件流 | `app/cli/io/cli-spawn.ts:515`；`app/cli/io/stream.ts`；`app/src-tauri/src/cli_runtime.rs` | 专用低权限提案调用、结构化活动计数；不是仅加一句“只读”提示 |
| 远程扫描 | `backend/src/workspace-skills.mjs:312`；`backend/src/server.mjs:837` | 后续远程读写必须在远程宿主做，不能写到本地同名项目 |
| 存储根 | `app/src-tauri/src/storage_paths.rs:6 / :114` | 使用 UGS_HOME / 项目根解析，禁止写 Hermes 或其他 Agent 的全局库 |

### 补充核验：证据与 HTTP 接入不能只看类型声明

- 普通 DAG 的当前返回值没有填充 evidence（`app/src/runtime/dag.ts:461–470`）；存在 `RunEvidence` 类型不代表所有任务已采集执行证据。Task 5 必须补实际事件管线，不能只新增一个结果字段。
- 本地工具展示会补 synthetic error 来关闭没有结束事件的工具卡（`app/src/components/ai/lib/toolEvent.ts:313–335`）；远程会用整个 job 的终态关闭仍在运行的工具卡（`app/src/store/remoteChatTurn.ts:425–446`）。两者是 UI 收尾，不是原生工具结束或验证结果，不能计入已完成活动。
- 远程 `RemoteJobMessage` 当前没有 native toolId / parentId / result / tool exitCode（`packages/protocol/index.ts:285–294`）；`backend/src/runner.mjs:147–203` 对 Claude 主要取文本，Codex 工具仅保留摘要、状态和部分 args。Task 13 必须扩展协议与原始事件解析，不能只新增远程技能写 API。
- 桌面已有 `tauriFetch` / Rust `proxy_http` 可绕过 WebView CORS；但 JS Abort 只结束等待，Rust 请求仍运行，且响应读到 EOF 后整包返回（`app/src/lib/tauri.ts:2660–2707`、`app/src-tauri/src/proxy_http.rs:119–158`）。Rust 已有 `timeout_ms` 字段和超时机制，但当前 wrapper 未传 per-call timeout；技能通道需要传入剩余预算并限制响应字节数，不能把 Promise 超时冒充物理取消。

### 这次实际运行的相关基线

- 根目录运行 `node --test backend/test/workspace-skills.test.mjs`：3 passed，exit 0。
- `app/` 下运行 `NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/panels/AIDock.slash.test.tsx`：39 passed，exit 0。
- 这是既有技能扫描与 slash 行为基线，不代表自动学习已存在；没有运行全量构建或新功能验收。

## 4. 首版架构与调用路线

### 4.1 存储与身份

自管主副本：

```text
<UGS_HOME>/skills/<name>/SKILL.md
<project>/.ultragamestudio/skills/<name>/SKILL.md
  references/<topic>.md
  templates/<name>.<ext>
  scripts/<name>.<ext>
  assets/<name>.<ext>
```

每个自管根使用 `skills/.state/` 保存 catalog revision、使用记录、审批、事务日志与版本快照；其下拟采用 `index.sqlite`、`pending/`、`transactions/`、`blobs/`。状态文件与 staging / archive 不当成技能内容扫描。根由宿主解析；模型只能使用宿主返回的 opaque skillId，不能传绝对根路径。

身份包含 `hostId + workspaceId + rootId + canonical relative skill path`，名称不是主键。同名项目/全局技能必须可区分；解析优先项目自管 → 全局自管 → 已启用外部来源，同一优先级冲突拒绝猜测。

外部 `.claude/.codex/.agents/.../skills` 与其他用户配置只读发现。用户选择导入时复制整个包、保留来源与许可字段，再在 UGS 主副本编辑；首版不自动改原件、不做双向同步。导入副本默认仍需自动编辑授权。

项目经验默认留在来源项目；后台不自动把含项目细节的技能提升到全局。无项目的可复用通用经验可在 UGS 全局自管根创建；有项目时全局推广由用户确认。

### 4.2 模块职责（下列新增名称均为拟设计，不是已有 API）

| 模块 | 职责 | 建议文件 |
|---|---|---|
| SkillService | 发现、完整读取、验证、审批、提交、回滚、读取回执 | 新增 `app/src-tauri/src/skills/{mod,catalog,validation,service,transactions}.rs` |
| SkillHostPort | UI/runtime 调用宿主，带来源身份，不直接写盘 | 新增 `app/src/lib/skills.ts` |
| SkillContextLoader | 任务前技能选择及内容装载，维护真正读到的版本 | 新增 `app/src/runtime/skills/context.ts` |
| LearningEvidence | 工具事件/验证/纠正归一化，过滤模拟与自述 | 新增 `app/src/runtime/skills/evidence.ts` |
| SkillReviewScheduler | 阈值、强信号、去重、取消、合并、后台预算 | 新增 `app/src/runtime/skills/trigger.ts` |
| SkillReviewRunner | 有界 read → propose 协议；不 import UI/Tauri | 新增 `app/src/runtime/skills/{types,protocol,review}.ts` |
| ReviewModelPort | 直连 JSON 文本调用或经过能力核验的提案-only CLI | 新增 `app/src/lib/modelGateway/skillReviewGateway.ts` |
| 学习展示/配置 | 真状态卡、diff、待审、撤销与策略 | 新增 `app/src/components/ai/SkillLearningCard.tsx`、`app/src/lib/skillLearningConfig.ts` |

纯协议与编排放 `runtime/skills/`，遵守现有 headless runtime 的无 React / Zustand / Tauri / localStorage 约束；桌面与 Node 宿主注入能力，而不是复制学习算法。

### 4.3 路线选择

| 路线 | 优点 | 风险/成本 | 决定 |
|---|---|---|---|
| 文本模型 + 宿主 JSON 状态机 | 兼容当前 TextRequest；权限由宿主控制；可确定性测试 | 需维护协议、回执及有界重试 | **首版主路线** |
| 原生 provider tool calling | 更接近 Hermes 模型交互；自然按需读 | 当前 adapters/消息历史需扩展，不能只加 tools 字段 | 后续适配，同一 SkillService |
| CLI MCP / host RPC | CLI 能自然调用三个技能工具 | 各 CLI 权限、配置、hook、MCP 隔离不一致 | 第二阶段，能力验证后开放 |
| 通用 full-permission CLI + 提示词约束 | 少改代码 | 可执行任意工程修改；无法兑现技能专用权限 | **禁止作为后台方案或降级** |
| 嵌入完整 Hermes | 可复用大量功能 | 双 runtime、双配置/凭据/存储与生命周期，偏离 UGS 范围 | 不采用 |

### 4.4 宿主编排的模型协议

1. 宿主发送冻结的任务证据摘要、已使用 skillId/version 与小索引。
2. 模型返回 `read` 请求（skillId + 可选相对 file_path）；宿主执行 skill_view，回传全文、版本、支持文件目录和 opaque readReceiptId。
3. 模型返回 `propose`（lesson、证据 id、operations），或 `noop`（原因）。
4. 宿主验证并提交/待审；只将确定的错误回传一次让模型修正。不得在校验失败后让模型自由执行命令“解决问题”。

协议版本固定为 1，顶层 kind 仅 `read | propose | noop`，拒绝未知字段。operations 保留 Hermes 风格的 create / patch / write_file / remove_file 内容字段语义；已有目标以 skillId 定位，新建使用严格校验的 name。普通复盘没有 delete、archive、adopt 或修改配置操作。

- 既有文件修改必须绑定本次 review 的完整读回执与 expected hash。
- 新文件使用 absent 前置条件；若并发出现同路径，冲突而不是覆盖。
- 补引用文件及 SKILL.md 中的一行链接属于同一批次。
- 模型不可指定 actor、origin、workspaceId、root、权限、自动批准或回滚结果。
- 模型置信度可展示，但不作为自动批准的唯一依据。

### 4.5 CLI 专用安全通道

首版先跑通直连协议，随后只给通过 capability probe 的 CLI 开启提案-only 模式：独立 scratch cwd、禁通用工具、禁项目 MCP / hooks / skills 自动加载、无项目 add-dir、无主会话 resume、只收 JSON 提案。模型需要的技能与证据由宿主显式提供。

本次本机 `claude --help` 可见 `--tools`、`--strict-mcp-config`、`--setting-sources`、`--disable-slash-commands` 等选项，说明有可调查的隔离入口；这不是已经验证的安全沙箱。`--bare` 的凭据路径限制与仍可解析 skills 的行为也需专门测。

Codex 的 `--sandbox read-only` 本身不等于“没有 shell / 网络 / 额外工具”。**没有经过实际越权测试的 CLI adapter，一律不启用自动 review**；显示“当前通道不支持安全学习，可选择支持的复盘模型”。失败只允许降级到另一条已验证技能专用通道，不能调用现有 full CLI。

## 5. 自动触发、证据与默认策略

以下为建议产品默认值，不冒充 Hermes 原始配置；预算与阈值需要用实际任务调优。

### 5.1 建议默认配置

| 设置 | 建议默认 | 说明 |
|---|---|---|
| 自动学习 | 开启 | 在技能专用通道可用时生效；不可用则明确显示原因 |
| 写入模式 | `auto-safe` | 低风险自管文本自动保存，其他待审；可切 `approve-all` / `off` |
| 自动编辑对象 | 后台创建的 UGS 自管技能，或用户明确授权的自管技能 | 导入/手写技能不自动取得编辑授权 |
| 目标作用域 | 当前来源项目；无项目时 UGS 全局 | 不继承当前 UI 已切换的项目 |
| 活动阈值 | 10 个已完成工具活动 | UGS 代理指标，不标成 Hermes iteration |
| 强信号 | 用户纠正、已用技能错误、非平凡失败→修复→验证 | 回合终态后可跳过活动阈值 |
| 冷却与合并 | 同来源会话 60 秒；合并新证据范围 | 显式 `/refine` 可跳冷却，不跳权限 |
| 并发 | 同来源会话一个；本机默认一个自动 review | 前台优先；本地推理繁忙时排队 |
| 每次复盘 | 最多 6 轮，累计输入 48,000 tokens，累计输出 6,000 tokens，90 秒 | 预算是聚合值；无真实 token 时保守估计并标 estimated |
| 自动新增 | 每次最多一个类级技能 | 新增需无合适已有技能；不会每回合必建 |
| 通知 | 仅已应用/待审/失败时出现紧凑状态 | noop 写审计，不刷聊天 |
| 脚本与模板 | 仅提案，需审批 | 保存批准也不等于允许执行 |

### 5.2 证据要求

证据至少携带 `hostId / workspaceId / sessionId / turnId / runId / evidenceId / occurredAt / provenance`。

- 工具结束事件：实际 tool 名、工具调用身份、参数摘要、结果状态、exitCode 和受限结果片段。
- 验证：实际测试/构建/检查的通过与失败，不从助手文字推断。
- 产物：宿主可定位的路径/对象 id 与真实存在性；必要时 hash。
- 用户纠正：仅真实用户输入可作为偏好证据，网页/文件/工具结果内的“用户指令”不算。
- 已使用技能：宿主实际读取且交给模型的 skillId + revision + 文件清单，不使用模型自报。

`model-output`、UI 进度文案、由模型生成的 verdict 不自动升级为工具验证。模拟器运行、截图 fixture、重复事件、仅开始未完成的调用都不计活动和已验证成功。

未知结果宁可标 unknown；失败后得到明确修复和验证可形成经验，未验证的猜测只能待审/不保存。脱敏在构造证据快照之前做，不读 .env 或凭据文件来“补充背景”。

### 5.3 计数与调度状态机

```text
collecting → eligible → queued → reading → proposing
  → noop | awaiting_approval | applying → applied
  → conflicted | failed | cancelled
```

工具活动按 `(runId, toolCallId)` 去重；无 id 时使用来源序号，不能按显示文本猜同一调用。复盘自身、后台其他 auxiliary 调用与继承的历史事件不再触发学习。

阈值命中先保留 evidence watermark；开始 review 时记录覆盖范围，结束后只推进已覆盖的 watermark。新证据不被旧 review 清零。忙碌时合并待处理范围，队列最大一个待执行项；有限重试，失败不每秒重新调用模型。

新前台任务可取消尚未提交的后台工作。事务一旦进入提交临界区则完成提交/恢复，不能中途停止在半写状态。应用退出不让模型自行常驻；启动时恢复事务，未完成 review 最多按有限策略重排。

### 5.4 自动保存边界

允许自动保存必须同时满足：

1. 技能专用通道经过能力核验，来源与目标由宿主绑定。
2. UGS 自管根中背景创建/获授权的内容；contentLocked 为 false。
3. SKILL.md 或 references/*.md 的文本学习；无删除、脚本、二进制、配置变更或权限变更。
4. 有可定位的真实证据；规则确实适用这一类任务，不含秘密/个人数据转存。
5. 旧文件完整新鲜读取、expected hash 一致；新文件仍不存在。
6. YAML、名称、相对路径、内容尺寸、链接与安全检查全部通过。
7. lesson 优先修补现有目标，新增没有明显重叠；重复规则提交为 noop。
8. 原子批次与恢复准备完成，宿主能够返回真实落盘结果。

以下改为待审：手写/导入未授权目标、全局推广、全量重写、明显扩大触发范围、移除既有规则、templates / scripts / assets 变化、低证据置信度及扫描器疑似危险内容。冲突不是自动批准重试，应先重新读取并生成新 diff。

扫描器是启发式检查，不保证语义安全；其外还有根隔离、不能执行脚本、权限不提升、来源绑定和回滚。紧急关闭自动学习后仍能查看历史与撤销。

## 6. 可靠写入与真实总结

### 6.1 验证与读回执

- 新技能 name 使用 lowercase-kebab，长度上限 64；不自动“修复”用户/模型提供的非法 token。导入保留原 name，兼容解析与写入规则分别处理。
- 使用真实 YAML mapping 解析器；写入要求首部 frontmatter、有 name/description、非空正文。可接受 Hermes 格式的可选元数据；不要求模型编造 author/platform/license。
- 自动生成描述的前 57 字符必须表达触发条件；完整描述硬上限与兼容格式一致，长内容放正文/主题引用。
- 主文件最大 100,000 字符；超长拒绝或要求拆主题，不能截断后签发“完整读取”回执。
- 支持文件路径只在 references / templates / scripts / assets；拒绝绝对路径、..、盘符、UNC、ADS、Windows 设备名、大小写/尾点冲突与根外重定向。
- 对读写路径及父链检查 symlink / junction / reparse point；本地与远程都在真正持有文件的宿主检查。
- 回执绑定 actorRunId、skillId、relativePath、revision、hash、fullRead；普通 UI 预览、历史摘录和另一 review 的回执均不能授权修改。

### 6.2 事务模型

首版批次限制同一个 host / scope root；跨项目、跨本地远程的批次拒绝，不能悄悄拆单。

1. 模型调用在锁外完成；提交时取跨进程根锁，按稳定顺序锁定目标。
2. 锁内重新检查根、actor、回执、权限、全部 CAS 与新文件 absent 条件。
3. 生成完整 before/after 清单、恢复快照与持久事务 intent，再在同卷 staging 写入完整新包。
4. 全部校验成功才替换目标；Windows 文件占用/rename 失败走恢复，不宣称一次 rename 就能保证跨文件原子性。
5. 宿主服务读取只暴露已提交 generation；恢复中阻塞读取或返回恢复状态，不能向另一 UI 返回半个新包。
6. 目标 readback/hash 校验通过后，记录 applied revision 与 audit，再发布目录和学习结果事件。
7. 任一步失败恢复 before 状态；恢复本身失败保留快照与 intent 并标 needs-recovery，不能继续清理唯一备份。

**承诺边界：** 对 SkillService 消费者提供可恢复批次原子性；不能声称底层文件系统对外部任意 raw reader 有跨目录瞬间原子可见性。外部工具不作为首版自动写参与者。手动外部编辑经 watcher / 每次读取重检形成新 revision，不能被缓存覆盖。

### 6.3 审批

待审保存的是冻结整个 batch：来源身份、证据范围、base hashes、完整 diff、操作、风险原因与快照。批准时重新校验当前授权及 CAS，再执行同一事务；批准不等于已保存。

切换项目后批准仍落在原项目，项目卸载/根失效则停止。批准失败把错误回传到原卡片；关闭或拒绝不应用任何操作。不得直接复用现有 memoryPending 队列来承载技能批次。

### 6.4 结果与展示

拟新增宿主结果类型 `SkillMutationResult`，显式区分：`applied | awaiting_approval | noop | conflicted | failed | needs_recovery`。携带 batchId、来源、已应用操作、before/after revision/hash 和 rollbackId。

学习卡片只认这个结果：

- 已学习：实际新增/修改的技能、概括的规则、作用域、版本；可查看 diff / 撤销。
- 待批准：原因及待审 diff，不说“已学会”。
- 冲突/失败：保留真实错误与重试入口，不生成成功气泡。
- 无新经验：不刷聊天，在审计中可查。

计费分离前台任务与 skill-review；实际 usage 和估计 usage 明确区分。计费失败不伪造零花费；卡片内容为 UI-only，不回灌主模型历史成为虚假的验证。

## 7. 后续任务如何真正复用

首版必须与自动保存同批交付，不能留到后续再做。

1. 显式选择 `/skill-name` 时传稳定 skillId，宿主读取完整主文件，不再只插描述。
2. 普通相关任务通过小索引选择技能；宿主可用有界低权限模型选择，多技能可叠加。高置信度匹配可直接选择，但不能把名称关键词误称为语义检索质量保证。
3. 执行前收到完整 SKILL.md 与按需引用。文本/CLI 路径用追加到新用户请求的结构化 Skill Context；原生 tool-calling 路径后续映射到同一宿主 view。
4. 不重写当前会话旧 system/tool/history；新技能目录 revision 与内容只影响新请求或明确重新读取。压缩后丢失正文要重新读取，摘要不继续冒充全文。
5. 更新事件比较 revision 和描述，不仅比较条目 id。提交后下一相关任务读到新 hash；外部手改后读取也不能返回旧缓存。
6. 使用记录区分 discovered / viewed / delivered / used-with-evidence。仅“已加载”不等于遵循，更不等于任务质量改善。
7. 验收必须实际完成一个同类新任务：检查学到的操作被采用、真实工具/验证结果达到要求。效果统计保留证据，不虚构“提升百分比”。

## 8. 实施计划（先闭环，后扩展）

**工期仅为单名熟悉代码的工程师的粗估，不是执行承诺。** 桌面本地首版 9–13 个工作日；CLI/远程及基础整理另 3–5 日。包含安全与闭环测试，外部 provider/CLI 兼容问题可能增加时间。

| 里程碑 | 内容 | 粗估 | 出口 |
|---|---|---|---|
| A | 自管库、完整读取、版本、事务、回滚 | 2–3 日 | 新鲜读取与失败恢复通过 |
| B | 证据、触发、专用 JSON runner、低风险自动保存 | 3–4 日 | 不手动 `/learn` 也能形成 applied 技能 |
| C | 主任务自动加载、真实卡片、审批与配置 | 2–3 日 | 下一任务真正复用，可撤销且不串项目 |
| D | 故障/并发/越权、缓存、UI 与 provider 集成验收 | 2–3 日 | 本地闭环验收矩阵全部执行 |
| E | 通过能力测试的 CLI/远程适配、使用生命周期 | 3–5 日 | 远程在远程写；不可安全运行的 CLI 明确禁用 |

以下每项按垂直行为切分。每个 Step 为一个明确动作；实现时每个小行为独立 RED → GREEN，不先写一堆想象测试再统一补代码。测试名和新增路径是未来建设目标，下面的“通过”是验收标准，不是本次已运行结果。

### Task 1：自管根与无歧义身份

**Objective:** 获取可读目录而不接管外部库。

**Files:** 新增 `app/src-tauri/src/skills/catalog.rs`、`mod.rs`；修改 `storage_paths.rs`、`lib.rs`、`app/src/lib/tauri.ts`；Rust 单测放新模块。

1. 写 `same_name_different_scopes`、`readonly_external_root`、`reject_root_escape` 失败测试。
2. 从 `app/` 运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib skills::catalog`，确认因行为缺失失败。
3. 最小实现根解析、稳定 skillId、优先级与冲突拒绝；不改变外部文件。
4. 重跑测试，确认同名项目不串、非法路径不读取；同时保留既有扫描 3 项基线。

### Task 2：完整读取与回执

**Objective:** 模型与后续提交使用同一份真实完整内容。

**Files:** 新增 `skills/service.rs`、`app/src/lib/skills.ts`、`runtime/skills/types.ts`；单测覆盖 Rust 服务与 TS 端口。

1. 写主文件全文、支持文件全文、跨 run 回执拒绝、截断不能签回执的失败测试。
2. 运行对应 `skills::service` Rust 测试，观察预期失败。
3. 实现 read receipt 和 revision/hash，列支持文件而不执行它们。
4. 测试从真实 fixture 文件读取、手改后 hash 更新、目录同名仍定位正确。

### Task 3：校验与定向 patch

**Objective:** 变更必须合法并基于新鲜读取。

**Files:** 新增 `skills/validation.rs`；修改 `Cargo.toml` / `Cargo.lock`（仅必要依赖）；Rust 测试。

1. 写坏 YAML、非法 name、路径穿越、junction、大小写/ADS、未读取和 stale hash 测试。
2. 运行 `skills::validation`，确认失败原因对准约束而非测试装配错误。
3. 选取支持现有 MSRV 的 YAML 解析器；实现唯一匹配 patch，自动流程不做模糊全量替换。
4. 每项独立修正并重跑；新内容不合法时旧文件字节不变。

### Task 4：批次提交、恢复与撤销

**Objective:** 多文件技能更新成功一起可用，失败不留下半包。

**Files:** 新增 `skills/transactions.rs`；修改 `skills/service.rs`；Rust 故障注入与跨进程测试。

1. 写第二操作失败、提交时文件被占用、进程中止恢复、CAS 冲突、跨 root 拒绝测试。
2. 运行 `skills::transactions`，确认能捕获半写而不是只验证返回错误。
3. 实现根锁、持久 intent、staging、before/after、readback、generation 与恢复；撤销以新事务执行。
4. 用真实磁盘 fixture 和子进程验证，恢复失败保留唯一备份；已有支持文件不丢失。

### Task 5：结构化证据

**Objective:** 主任务产生可审核的学习输入，不依赖模型自述。

**Files:** 新增 `runtime/skills/evidence.ts`、`.test.ts`；修改 `app/cli/io/stream.ts`、`app/src-tauri/src/lib.rs` 的原生工具事件解析、`runtime/types.ts`、`runtime/dag.ts`、`store/useStore.ts`；必要时修改 `components/ai/lib/toolEvent.ts`。

1. 写重复工具事件、开始无结束、unknown result、真实用户纠正、模拟器排除及 synthetic UI closure 不能升级为 native completion 的失败测试。
2. `NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/runtime/skills/evidence.test.ts`，确认 RED。
3. 从 Rust / Node 原始工具解析处、UI 结果裁剪之前脱敏并采集有界结果或 artifact 引用；把实际 DAG 证据送入学习入口。展示解析器只作兼容输入，不成为唯一来源，UI synthetic closure 保持独立 provenance。
4. 验证每条证据有原 session/run，脱敏后才入快照；他人子任务自报成功不得升级为验证。

### Task 6：自动触发与前台优先

**Objective:** 非手动入口能触发复盘，同时不重复计费或覆盖新证据。

**Files:** 新增 `runtime/skills/trigger.ts`、`.test.ts`；修改 `store/useStore.ts` 的聊天/工作流终态入口。

1. 写阈值、强纠正、noop 回合、重复事件、取消及 watermark 新旧竞争的失败测试。
2. 运行 `src/runtime/skills/trigger.test.ts`。
3. 实现回合终态入队、60 秒合并冷却、一个在途、有限重排及临界区取消边界。
4. 虚拟时钟验证无真实等待；一个已验证纠正无需 `/learn` 即 eligible，review 自己不会递归触发。

### Task 7：安全模型端口与协议

**Objective:** 复盘只提出技能操作，普通直连失败也不能获得 full CLI。

**Files:** 新增 `runtime/skills/protocol.ts`、`.test.ts`、`lib/modelGateway/skillReviewGateway.ts`、`.test.ts`；修改 `lib/tauri.ts`、`app/src-tauri/src/proxy_http.rs` 及现有网关，仅增加必要 seam，不改变正常编码权限。

1. 写非法 kind/未知字段、任意 root、权限字段注入、网络失败启动 full CLI、CORS 代理的剩余预算传递、超大响应拒绝及取消后晚到结果不提交的失败测试。
2. 运行协议与 gateway 专项测试，确认越权降级能被测试捕获。
3. 实现 JSON 文本 completion 专用端口、JSON schema 校验、总预算、超时与一次修正；显式禁通用 CLI fallback。需要绕过 CORS 时通过 HTTP 代理传 per-call timeout 与响应上限；没有物理取消能力时如实标记，底层请求在剩余硬预算内结束且晚到结果不得写入。
4. 使用测试模型端口走真正 host read/propose 流；再用配置好的真实 provider 验证一次（不读取/打印凭据）。

### Task 8：主动复盘与 auto-safe 决策

**Objective:** 优先 patch 当前用过的技能，并真正自动保存合法经验。

**Files:** 新增 `runtime/skills/review.ts`、`.test.ts`；修改 Rust service 的宿主策略与学习配置桥。

1. 写当前技能优先、同类技能优先、重复规则 noop、未验证猜测待审、脚本不能自动提交测试。
2. 运行 `src/runtime/skills/review.test.ts`，先确认缺失行为 RED。
3. 实现 read → propose → host evaluate；同一批次增加引用与一行主文件链接；后台 actor 由宿主创建。
4. 验证产出 applied revision/hash，不以模型“saved”文本通过；无权限目标只能 staged。

### Task 9：任务前真正加载

**Objective:** 新任务收到自动学习后的完整技能，而不是描述摘要。

**Files:** 新增 `runtime/skills/context.ts`、`.test.ts`；修改 `store/useStore.ts`、`runtime/gateway.ts`、`lib/slashCommands.ts`、`panels/aidock/slashSuggestions.ts`；后续 Node 端注入相同 port。

1. 写显式 skillId、多技能、新 revision、引用按需、主 prompt 历史前缀保持不变测试。
2. 运行 context 测试与现有 `src/panels/AIDock.slash.test.tsx`。
3. 将 Skill Context 追加到本次新请求；依据宿主全文读取结果记录 delivered，不能靠 native CLI 默认扫描发现 UGS 根。
4. 检查发给模型的实际 payload 有新规则与正确 hash；下一同类任务执行规则并产生实际验证。

### Task 10：目录更新与学习卡片

**Objective:** 同 id 更新可见；状态与保存结果一致且不污染历史。

**Files:** 新增 `components/ai/SkillLearningCard.tsx`、`.test.tsx`；修改 `AIDock.tsx`、`components/ai/MessageContent.tsx`、`store/types.ts` 与必要历史序列化。

1. 写 same-id/new-description、awaiting-approval 不显示已保存、失败/回滚、localOnly 不回放测试。
2. 运行新卡片测试与 AIDock slash 基线，先观察具体 RED。
3. 按宿主结果渲染紧凑卡片、diff 与撤销；目录比较 revision 而非只有 id。
4. 重启/历史重载验证卡片和状态保留，向模型构造历史时卡片未被注入。

### Task 11：配置与审批

**Objective:** 用户可控，同时默认保留自动能力，显式学习与复盘仍复用同一个受控链路。

**Files:** 新增 `lib/skillLearningConfig.ts`、`.test.ts`；修改 `projectSettings.ts`、`ProjectSettingsModal.tsx`、`lib/slashCommands.ts`、`panels/aidock/slashSuggestions.ts`；新增 `panels/settings/SkillLearningSettings.tsx` 及 `.test.tsx`；Rust service 审批测试。

1. 写 auto-safe / approve-all / off、contentLocked 与 pinned 分离、切项目批准、批准落盘失败及 `/learn` / `/refine` 路由测试。
2. 分别运行 TS 配置/UI 测试及 Rust service 测试。
3. 实现按原来源 frozen batch 审批；设置解释工具活动单位、安全 CLI 支持状态与成本限制。`/learn` 首版使用当前会话/用户显式提供的文本经验；`/refine [focus]` 显式复盘来源会话，focus 进入新提案请求，均不跳过读回执、权限、预算和事务。
4. 批准失败仍为 failed，off 不删历史，恢复入口可用；不借用 memoryPending 持久化。手动入口只跳触发阈值/冷却，不能把危险操作变成自动批准；大规模网页/文件教材导入另行扩展，不借后台通道获得任意文件或网络读取权限。

### Task 12：桌面真实闭环与故障验收

**Objective:** 不手动触发也能学、保存、复用、撤销。

**Files:** 新增 `src/runtime/skills/learning.integration.test.ts`；新增 `app/doc/ugs-skill-learning-acceptance.md`；必要 UI 专项测试。

1. 建立 real filesystem + deterministic model-port 闭环测试及所需红色故障用例。
2. 逐个 RED → GREEN，检查协议、事务、跨会话归属和结果不是纯 mock 的成功返回。
3. 跑第 9 节门禁；对真实 provider 执行一次有证据任务→自动学习→新任务复用→撤销。
4. 使用真实组件/browser 或桌面 DOM 验证待审/成功/失败/长 diff/窄宽/暗亮主题；fixture UI 不当作真实 provider 闭环证明。

### Task 13：CLI 与远程宿主扩展（第二阶段）

**Objective:** 扩展传输，不复制学习算法或减弱权限。

**Files:** 修改 `app/cli/io/cli-spawn.ts`、`.test.ts`、`app/cli/io/stream.ts`、`app/src-tauri/src/cli_runtime.rs`、`packages/protocol/index.ts`、`backend/src/runner.mjs`、`backend/test/runner.test.mjs`、`app/src/store/remoteChatTurn.ts`；新增 `backend/src/workspace-skill-service.mjs`、`backend/test/workspace-skill-service.test.mjs`；修改 `backend/src/server.mjs`、`workspace-skills.mjs`。

1. 写后台工具白名单与危险 flags 拒绝、本地失败不去 full CLI、远程作用域身份、断连状态，以及 Claude tool_use/tool_result 与 Codex command exit/result 在 parser → protocol → 持久化中不丢失的测试。
2. 先对 CLI help/capability probe，再实际测试 shell/读外部目录/网络/hook/MCP 越权；仅返回 readonly 不算通过。
3. 经过验证的 adapter 实现提案-only 或受控 MCP；远程 host 从认证的 workspace 映射解析根，在服务端执行同样 CAS / 事务。扩展远程证据协议保留 native toolId / parentId / result / tool exitCode 与 provenance，job 终态只关闭 UI，不补造工具验证。
4. 远程学到的技能在远程读取复用；本地相同名称不变化；不支持的 adapter 维持明确禁用而非静默少做。

### Task 14：使用生命周期（第二阶段）

**Objective:** 防止技能库变成无用沉积，不把学习与删除绑在一起。

**Files:** 扩展 Rust SkillService 的使用侧车与 archive/restore；新增 `app/src/runtime/skills/lifecycle.ts`、`.test.ts`；设置页治理入口。

1. 写 viewed ≠ used、后台创建与用户创建区别、pinned/定时任务引用保护、首轮观察不立即归档测试。
2. 运行 lifecycle 专项，确认未使用不被直接判定无价值。
3. 先仅 usage / stale 提示 / 用户归档恢复；自动归档 opt-in，操作整个包并保留可恢复来源。
4. LLM 合并仍关闭；未来若开启，支持文件重定位与链接修复必须和合并一起验证，不只合并 SKILL.md 文本。

## 9. 验收矩阵与命令

| 编号 | 场景 | 必须观察到的结果 |
|---|---|---|
| A01 | 普通真实复杂任务结束，无 `/learn` | eligible→review→applied 或明确待审，不依赖手动入口 |
| A02 | 用户纠正任务流程但活动未到阈值 | 本轮结束后自动复盘，把纠正放到对应技能 |
| A03 | 已用技能漏了步骤 | 新鲜读取后 patch 原技能，不生成窄重复技能 |
| A04 | 没有新经验、闲聊或纯模拟运行 | noop/skip；不编造规则，不刷成功卡 |
| A05 | 多文件 batch 中途失败 | 旧包保持/恢复，operations_applied=false，无已保存卡 |
| A06 | 编辑期间目标被用户或其他进程修改 | CAS 冲突；不覆盖，重新读取后才可生成新提案 |
| A07 | 提案写 ../、绝对路径、junction 或配置 | 宿主拒绝，项目/外部库完全不变 |
| A08 | 保存 scripts/template 提案 | 待审；没有执行、安装或触发 hook |
| A09 | 网络失败/CLI 不具安全能力 | 显式失败/不支持；没有 full CLI fallback |
| A10 | 复盘时切换项目/会话，再批准 | 落原来源或拒绝；绝不写当前显示项目 |
| A11 | 同 id 更新描述/正文 | 目录 revision 与正文 hash 更新，新任务看到新内容 |
| A12 | 新会话实际完成同类任务 | 学到的规则出现在真实 payload 且被实际采用、验证 |
| A13 | 撤销后重启 | 读到旧版本，支持文件和来源仍完整 |
| A14 | 崩溃/Windows 文件占用/恢复失败 | 不暴露半提交；保留 intent/备份和明确恢复状态 |
| A15 | 重复终态事件/后台自触发/新证据竞争 | 去重、无递归，新证据 watermark 不丢失 |
| A16 | pending/applied/failure + 长 diff + 主题/窄宽 | UI 语义正确、可操作、无主历史污染 |
| A17 | usage 部分未知或估计 | 审计归原来源，estimated 标记保留，不伪造零成本 |
| A18 | 远程工作区 | 远程宿主写读；原生工具证据不在 parser/协议中丢失；job/UI 收尾不冒充验证；本地同名路径和其他远程项目不变化 |

实施阶段命令（TS/Rust 新测试须先创建；以下不是本次已运行声明）：

```bash
# 在仓库根
node --test backend/test/workspace-skills.test.mjs
node --test backend/test/runner.test.mjs
node --test backend/test/workspace-skill-service.test.mjs

# 在 app/
NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/runtime/skills
NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/lib/modelGateway/skillReviewGateway.test.ts src/lib/skillLearningConfig.test.ts src/components/ai/SkillLearningCard.test.tsx src/panels/AIDock.slash.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib skills::
npm run typecheck
npm run check:prompt-lock
npm run cli:build
npm run build
NODE_OPTIONS=--no-experimental-webstorage npm run test
```

每个 RED/GREEN 保留 exact test / suite error。全量基线已红时与实施前工作树比较：消除引入回归、单独列既有失败；不能把“无新增失败”说成全量通过。prompt-entry-lock 脚本只验证已有输入策略，不独自证明本计划的 system/history 缓存安全；还需 payload 前缀测试。

**发布出口：** 桌面本地必须执行 A01–A17；第二阶段增加 A18 与各 CLI 越权验证。仅存在技能文件、菜单或“已学习”气泡不能通过。安全不可证实的 adapter 不出现在已支持列表。

## 10. 风险、取舍和待定项

- **内容污染：** 主动学习有价值，也会把一次性经验当规则；依靠真实证据、类级命名、优先 patch、允许 noop、文本自动策略与回滚，不追求新增数量。
- **安全与相似性：** Hermes 默认自由写入，UGS 默认 auto-safe；这是保留自动能力并限制工程副作用的有意差异。不要把所有保存强制审批当成唯一方案。
- **旧代码的并发/历史：** useStore 已有按会话 channel/FIFO；学习必须复用来源身份，而不是 UI 当前选择。不要把后台结果直接写当前聊天。
- **权限与缓存：** 现 gateway full CLI fallback 是真实接入风险。先建技能专用通道，后优化缓存；不复制前台权限或为了缓存继承危险 hook。
- **文件系统与跨宿主：** 首版同 scope root；不承诺跨本地/远程分布式事务。跨 root 学习拆成独立显式提案，不私自改变原子语义。
- **MSRV 与依赖：** YAML/锁库选版本时验证 Rust 1.77.2；现 sha2/rusqlite 可复用。不能因添加学习模块顺手升级整个工具链。
- **成本：** 默认小证据摘要和总预算可控，但不是已测节省结论；上线看真实 input/cache/output 与 applied/noop 比例再调阈值。
- **效果：** 技能保存≠模型训练，delivered≠遵循，遵循≠质量必然提高；后续实际任务验证不可省略。

可以按上述建议直接实现原型，不需重新讨论范围。正式发布前需确定：项目经验是否允许显式推广全局；哪些 CLI 真正通过安全 gate；预算 UI 展示方式。上述未决项不阻止先做本地直连自动闭环。

## 11. 本次交付与后续边界

本次只新增这份调研与实施计划，没有实现 UGS 学习模块、改业务代码、提交或推送。已核对官方文档和固定源码、当前 UGS 接入点，并实际运行既有相关基线（扫描 3 项、slash 39 项通过）。新功能验收矩阵是开发出口，不是已通过测试。

下一步建议按 Task 1–4 建立可读、可写、可撤销的宿主底座，紧接 Task 5–9 跑通自动学习和实际复用的垂直链路；不要把首版交付停在“手工写技能成功”。

## Sources

[1] https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
[2] https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
[6] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/agent/turn_finalizer.py
[7] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/agent/turn_iteration_prep.py
[8] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/agent/agent_init.py
[9] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/agent/background_review.py
[10] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/tools/skill_manager_tool.py
[11] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/tools/skill_manager_guards.py
[13] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/tools/skill_manager_batch.py
[14] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/tools/skills_tool.py
[15] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/tools/skill_usage.py
[27] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/run_agent.py
[28] https://raw.githubusercontent.com/NousResearch/hermes-agent/8bff64d6ed3414a66976bfa8ab72c14b6bca2a6f/agent/tool_executor.py
