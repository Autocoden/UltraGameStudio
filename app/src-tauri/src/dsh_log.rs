//! dsh（`@deepseek-ai/dsh`）headless 实时进度尾随器。
//!
//! dsh headless 的 stdout 只在任务结束时打印最终答案，运行期间没有任何
//! 中间输出，导致 UGS 信息流在长任务期间只有 12 秒一次的心跳，观感像
//! “卡住不刷新”。但 dsh 会把每一步事件实时落盘到持久化会话日志——网页端
//! （`dsh web`）看到的实时刷新，正是读的这份日志。
//!
//! 本模块通过 `--patch` 让 headless 把会话日志写到 UGS 专属目录（纯 JSONL：
//! 关闭 zstd 压缩与 chunk 打包，见 [`ugs_patch_yaml`]），再由
//! [`run_tracer`] 轮询尾随该文件，把文本增量、`tool/call` / `tool/result`
//! 工具卡片、`step/start` 步骤提示实时转发到前端的 `ai-cli-progress` 通道
//! （复用 `<<UGS_TOOL>>` 哨兵协议与 [`crate::AiCliProgressBatcher`]，前端
//! 零改动即可显示）。
//!
//! 事件格式有两代，尾随器必须同时兼容：
//! - v1/v2：文件名 `session.jsonl`，正文按 `assistant/chunk` 的
//!   `text-delta` / `reasoning-delta` 逐 token 落盘。
//! - v3：文件名 `session.v3.jsonl`，不再有 chunk 事件，正文/思考收在整条
//!   `assistant/message` 的 `data.message.content[]` 里（见
//!   [`assistant_message_progress`]），工具事件形状不变。
//!   文件名一律走 [`session_log_path`] 解析——写死任何一个名字都会让整条
//!   live 进度链路静默失效。
//!
//! 设计约束：
//! - 不引入新 crate（纯标准库 + serde_json）：crates.io 在本机不可达，
//!   且 zstd 解码完全没有必要——dsh 的 patch 机制能直接产出纯 JSONL。
//! - 独立会话根目录，与 web/tui profile 共享的 `$DSH_HOME/sessions`
//!   完全隔离，不会触发 dsh 的“一个根只属于一种编码”检查，也不影响网页端。
//! - stdout 的最终答案仍是权威结果；本模块只增强运行期间的可见性，
//!   且任何失败（目录找不到、JSON 解析错、解码错）都静默降级回
//!   “stdout 逐行转发”的旧行为，不会让现有功能更糟。

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// 单次 dsh 调用可推送的一则进度。
#[derive(Debug)]
pub enum DshProgressItem {
    /// 追加式文本（流式打字 / 状态行）。
    Text(String),
    /// 结构化工具哨兵补丁（`<<UGS_TOOL>>…<<UGS_TOOL_END>>`）。
    Patch(serde_json::Value),
}

/// 尾随器配置：由 `ai_cli` 的 is_dsh 分支在 spawn 前后组装。
pub struct DshTracerConfig {
    pub app: tauri::AppHandle,
    pub run_id: String,
    /// UGS 专属会话根目录（与注入 dsh 的 `UGS_DSH_SESSIONS` 一致）。
    pub sessions_root: PathBuf,
    /// spawn 前快照的既有会话目录（用于发现本次运行新建的目录）。
    pub known: HashSet<PathBuf>,
    /// spawn 时刻（用于过滤“本次运行新建”的会话目录）。
    pub spawned_at: SystemTime,
    /// 空转/心跳看门狗共享的活动时间戳。
    pub activity: Arc<Mutex<Instant>>,
    /// “产生了真实内容”标志（供静默失败判定复用）。
    pub received: Arc<AtomicBool>,
    /// “日志尾随已成功工作”标志（stdout 分支据此跳过重复转发）。
    pub active: Arc<AtomicBool>,
    /// 停止信号（主线程 join 时置位）。
    pub cancel: Arc<AtomicBool>,
}

/// dsh 会话日志的 UGS 专属根目录：`<UGS 全局根>/dsh-sessions`。
/// 通过 `UGS_DSH_SESSIONS` 环境变量注入 dsh（见 [`ugs_patch_yaml`]），
/// 与 web/tui 共享的 `$DSH_HOME/sessions` 完全隔离。
pub fn ugs_dsh_sessions_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let global = std::env::var_os("UGS_HOME")
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|home| PathBuf::from(home).join(".ultragamestudio")))
        .unwrap_or_else(|| std::env::temp_dir().join("ultragamestudio"));
    global.join("dsh-sessions")
}

/// `--patch` 覆盖：让 headless 把会话日志写到 UGS 专属根目录，
/// 以纯 JSONL（`compression: none`）且每事件一行（`packChunks: false`）
/// 落盘。整行替换 `session-persistence-jsonl` 的 config（dsh 的 patch
/// 语义是替换而非合并，故必须同时给出 root）。`!!js` 表达式在运行时求值。
///
/// 另外按 UGS 渠道注入模型与端点配置。dsh 内置**两条** DeepSeek 路径：
///
/// 1. **native**（`dsh-llm-deepseek`，路由名 `deepseek-official`）：按
///    DeepSeek 私有 wire 发请求——带 `thinking:{type}`、`reasoning_effort`，
///    历史里回传 `reasoning_content`。**官方 `api.deepseek.com` 专用**。
/// 2. **pi-ai 通用兼容**（`dsh-llm-pi-ai`，OpenAI 兼容多 provider 适配器）：
///    默认 dormant，一旦 config 给出 provider profiles 就注册路由。
///    hand-declared route + `api: openai-completions` 只发**标准 OpenAI
///    字段**，不带任何 DeepSeek 私有字段。
///
/// 判定：baseURL 为空或指向官方 `api.deepseek.com` → 走 native，保留完整
/// 思考能力；baseURL 是第三方兼容网关（OpenRouter / SiliconFlow / 自建 /
/// 中转）→ 走 pi-ai `openai-completions`。此前所有渠道一律套 native
/// `deepseek-official`，第三方网关收到私有 `thinking`/`reasoning_effort`
/// 字段直接 `HTTP 400 INVALID_REQUEST`——这正是第三方 DSH 一直不可用的根因。
///
/// pi-ai hand-declared route 必须显式列出 model catalog（否则请求前就
/// `UNKNOWN_MODEL`），故第三方分支要求同时有 model 与 baseURL；缺 model
/// 时退回 native（保持旧行为，不至于 UNKNOWN_MODEL 崩）。API key 均通过
/// `apiKeyEnv: DEEPSEEK_API_KEY` 从 credential seam / 环境变量解析，UGS
/// 已在 spawn 时注入 `DEEPSEEK_API_KEY`，不写进 config。
///
/// 两个字段都来自 `env_vars`（`UGS_DSH_MODEL` / `DEEPSEEK_BASE_URL`）。
///
/// 第三个可选入参是会话级**思考深度**（`UGS_THINKING_LEVEL`，原样是 DeepSeek
/// 的 `off|low|high|max`）。它落在 native `llm-deepseek` 条目上：
/// `dsh-llm-deepseek` 的 plugin config 明确接受 `reasoningEffort`（见该包
/// `Config` schema 的 `z.union(["off","low","high","max"])`），并且当 agent 自身
/// 没有显式选档时它就是该次请求的默认档 —— headless 正好属于这种情况
/// （`agent-default-model` 只给 provider/model）。
///
/// `off` 不会以 `reasoning_effort: "off"` 过线：适配器把它序列化成
/// `thinking: { type: disabled }`，这正是我们要的「关闭思考」。
///
/// 第三方兼容网关（pi-ai `openai-completions`）不认 DeepSeek 私有字段，所以
/// **不能**在那里写 `reasoningEffort`；但同理，pi-ai 的手声明模型默认「不推理」
/// ——只写一个裸 model 条目等于这个渠道永远没有思考深度。因此第三方路由改由
/// [`ugs_patch_yaml_with_plan`] 按前端计划显式声明 `reasoningEfforts` +
/// `compat.thinkingFormat`，把档位翻译成该端点认的字段（OpenAI 兼容 →
/// `reasoning_effort`；`deepseek` → `thinking` + `reasoning_effort`；等等）。
///
/// 便捷形式：不带思考计划（生产路径走 [`ugs_patch_yaml_with_plan`]，由前端
/// `UGS_THINKING_PLAN` 提供计划）。保留给单元测试与只关心「模型/端点/任务」
/// 三个字段的调用点。
#[allow(dead_code)]
pub fn ugs_patch_yaml(
    model: Option<&str>,
    base_url: Option<&str>,
    task: Option<&str>,
    thinking_level: Option<&str>,
) -> String {
    ugs_patch_yaml_with_plan(model, base_url, task, thinking_level, None)
}

/// 前端（`app/src/lib/thinkingLevels.ts`）解析好的思考计划。**族判定的唯一事实
/// 源在前端**：哪个模型支持哪几档、每档过线怎么拼写、pi-ai 该用哪个
/// `thinkingFormat`，全部由它给出；Rust 只做机械落地，不再做第二套 host/模型
/// 判断——否则前端选择器与 sidecar 实际下发的档位会各自漂移。
///
/// `channel` 是协议通道（`dsh-pi-ai` / `dsh-deepseek-native` / `cli-*` /
/// `http-*`）；`wire` 为 `None` 表示「关闭思考」：pi-ai 侧写进
/// `reasoningEfforts` 的空值（"supported, send nothing"），native 侧写 `off`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinkingPlan {
    pub channel: String,
    pub level: String,
    /// 选中档位的过线拼写；`None` = 不发字段 / 关闭。
    pub wire: Option<String>,
    /// 选择器提供的全部档位及其 wire 拼写（`None` = 该档不发字段）。
    pub efforts: Vec<(String, Option<String>)>,
    /// pi-ai `compat.thinkingFormat`；`None` = 不写，交由 pi-ai 判定。
    pub thinking_format: Option<String>,
}

/// 解析 `UGS_THINKING_PLAN`（JSON）。任何格式问题都返回 `None`（降级为不打
/// 档位，而不是让整轮请求带一个半截配置出去）。
pub fn parse_thinking_plan(raw: Option<&str>) -> Option<ThinkingPlan> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let channel = value.get("channel")?.as_str()?.trim().to_string();
    if channel.is_empty() {
        return None;
    }
    let level = value
        .get("level")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let wire = value
        .get("wire")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let efforts = value
        .get("efforts")
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, entry)| {
                    (
                        key.clone(),
                        entry
                            .as_str()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let thinking_format = value
        .get("thinkingFormat")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(ThinkingPlan {
        channel,
        level,
        wire,
        efforts,
        thinking_format,
    })
}

/// YAML flow map：`{off: null, low: "low", high: "high"}`。键是档位标识符
/// （安全裸标量），值走双引号标量；`None` = pi-ai 的「该档不发字段」空值。
fn yaml_flow_map(entries: &[(String, Option<String>)]) -> String {
    entries
        .iter()
        .map(|(key, value)| {
            let key = if !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                key.clone()
            } else {
                yaml_scalar(key)
            };
            match value {
                Some(wire) => format!("{}: {}", key, yaml_scalar(wire)),
                None => format!("{}: null", key),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// 按 UGS composer 权限档位给出 dsh 的 `DSH_PERMISSION_MODE` 值。
///
/// dsh base profile 里 `sandbox-policy.mode` 与 `approval.policy` 都直接读
/// `DSH_PERMISSION_MODE` 环境变量（其 cordis.patch.yml 明示这是"explicit
/// deployment override"）：不设则任何 CLI 模式都钉在 workspace-write + ask。
/// 所以正确接法是在 spawn dsh 前注入该变量，而不是去覆盖 `permission` 插件的
/// config（那是 UI 会话内切换 preset 用的，headless 无需也不应触碰）。
/// 映射与 codex/claude 分支的权限翻译保持一致：缺省按 `full` 处理。
pub fn dsh_permission_mode(permission: Option<&str>) -> &'static str {
    match permission.unwrap_or("full") {
        "readonly" => "read-only",
        "ask" => "workspace-write",
        _ => "danger-full-access",
    }
}

/// 带思考计划的 [`ugs_patch_yaml`]。计划只影响「档位怎么写进 sidecar 覆盖层」：
/// - `dsh-pi-ai`：把手声明的模型条目补上 `reasoningEfforts` + `compat`，
///   route 级补 `reasoning`，让第三方兼容网关也有真实可用的档位；
/// - 其他通道：沿用 native `llm-deepseek.reasoningEffort`。
pub fn ugs_patch_yaml_with_plan(
    model: Option<&str>,
    base_url: Option<&str>,
    task: Option<&str>,
    thinking_level: Option<&str>,
    thinking_plan: Option<&ThinkingPlan>,
) -> String {
    let mut out = String::from(
        "- id: session-persistence-jsonl\n  config:\n    root: !!js process.env.UGS_DSH_SESSIONS\n    packChunks: false\n    compression: none\n",
    );
    // 大任务透传：把一次性任务写进 `headless-runner` 的 `task` 配置，而不是
    // 当作 argv 位置参数传给 dsh。dsh-headless 的 runner 就是读这个配置字段
    // （bundle 默认 `task: !!js ctx.headlessStartup.task`）来驱动本轮任务的，
    // 因此用 overlay 按 id 整行替换 config 即可让任务文本走文件，绕开 Windows
    // CreateProcess 的命令行长度上限（os error 206）。headless-startup 仍会因
    // 占位位置参数而照常提供非空服务。
    //
    // 位置必须在所有渠道分支之前：下面的第三方 pi-ai 分支会提前 `return`，
    // 若把它留在函数尾部，第三方渠道 + 长任务（走 `--patch`）时 patch 里就没有
    // `headless-runner.task`，dsh 只能拿 argv 占位符 "." 当任务 —— 模型因为只
    // 收到一个句点而"失智"（现场：provider=deepseek-compat 的会话 user 消息恒为 .）。
    if let Some(task) = task.map(str::trim).filter(|t| !t.is_empty()) {
        out.push_str(&format!(
            "- id: headless-runner\n  config:\n    task: {}\n",
            yaml_scalar(task)
        ));
    }

    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let base_url = base_url.map(str::trim).filter(|b| !b.is_empty());

    let third_party = base_url.is_some_and(|b| !is_official_deepseek(b));

    if third_party && model.is_some() {
        // 第三方兼容网关：走 pi-ai `openai-completions`。声明一条 UGS 专属
        // 路由 `deepseek-compat`（pi-ai 不 ship 这个 key，属 hand-declared
        // route），把 agent 默认模型指向它。不给 `compat` 段——pi-ai 对无法
        // 识别的端点默认按纯 OpenAI 处理，正好只发标准字段、不带 DeepSeek
        // 私有的 thinking/reasoning。
        let model = model.unwrap();
        let base_url = base_url.unwrap();
        out.push_str(&format!(
            "- id: agent-default-model\n  config:\n    provider: deepseek-compat\n    model: {model}\n",
            model = yaml_scalar(model)
        ));
        // 必须显式声明 `input`：pi-ai 的 `modelProfile.input` 无默认值，条目
        // 不写该字段时 `declaredInput()` 返回 undefined，直接落到 profile 级
        // `defaultInput`（dsh 内置为 `[text]`）。于是连 id 里写着 vision 的模型
        // 也会被判定成纯文本，`read_image` 在发请求前就被拒（"does not declare
        // image input"）。转写时按 id 保守判定图片能力，避免给纯文本模型虚报。
        let input = if model_declares_image_input(model) {
            "[text, image]"
        } else {
            "[text]"
        };
        // 思考档位：只有前端明确判定本次走 pi-ai 通道、且给出了档位集合时才声明。
        // pi-ai 的手工声明模型**默认不推理**（`reasoningEfforts` 缺省 = 无档位），
        // 所以不声明就等于第三方网关永远没有思考深度 —— 这正是「有的渠道有档位、
        // 有的没有」的根因。声明后 pi-ai 会按 `compat.thinkingFormat` 把档位翻成
        // 该端点认的字段（openai → `reasoning_effort`、deepseek → `thinking` +
        // `reasoning_effort` 等）。
        let mut route_extra = String::new();
        let mut model_extra = String::new();
        if let Some(plan) = thinking_plan.filter(|plan| plan.channel == "dsh-pi-ai") {
            if !plan.efforts.is_empty() {
                model_extra.push_str(&format!(
                    "            reasoningEfforts: {{{}}}\n",
                    yaml_flow_map(&plan.efforts)
                ));
                let mut compat = Vec::new();
                if let Some(format) = plan.thinking_format.as_deref() {
                    compat.push(format!("thinkingFormat: {}", yaml_scalar(format)));
                }
                compat.push("supportsReasoningEffort: true".to_string());
                model_extra.push_str(&format!(
                    "            compat: {{{}}}\n",
                    compat.join(", ")
                ));
            }
            // route 级 `reasoning`：agent 未显式选档时该次请求的默认档。
            if !plan.level.is_empty() && plan.level != "off" {
                route_extra.push_str(&format!(
                    "        reasoning: {}\n",
                    yaml_scalar(&plan.level)
                ));
            }
        }
        out.push_str(&format!(
            concat!(
                "- id: llm-pi-ai\n  config:\n    providers:\n",
                "      deepseek-compat:\n",
                "        apiKeyEnv: DEEPSEEK_API_KEY\n",
                "        api: openai-completions\n",
                "        baseURL: {base_url}\n",
                "{route_extra}",
                "        models:\n",
                "          - id: {model}\n",
                "            name: {model}\n",
                "            contextWindow: 131072\n",
                "            maxTokens: 8192\n",
                "            input: {input}\n",
                "{model_extra}",
            ),
            base_url = yaml_scalar(base_url),
            route_extra = route_extra,
            model = yaml_scalar(model),
            input = input,
            model_extra = model_extra,
        ));
        return out;
    }

    // 官方直连（或缺 model 无法安全声明 pi-ai 路由时的兜底）：保持 native
    // `deepseek-official`。
    if let Some(model) = model {
        // `agent-default-model` 的 plugin config 是 `{provider, model}`
        // 必填整行替换；provider 固定 `deepseek-official`（dsh-llm-deepseek
        // 注册的路由名），model 用渠道透传的 id。
        out.push_str(&format!(
            "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: {}\n",
            yaml_scalar(model)
        ));
    }
    // 思考深度只在官方 native 路由上注入：第三方兼容网关收到 DeepSeek 私有
    // `reasoning_effort` 会直接 400（这正是 `ugs_patch_yaml` 分流成 pi-ai 的
    // 根因）。第三方网关的档位走上面的 pi-ai 分支声明，不再靠「一律不写」。
    // `wire` 为 `None`（前端表达「关闭思考」）时退回 level 本身，native 适配器
    // 会把 `off` 序列化成 `thinking: {type: disabled}`。
    let planned_effort: Option<String> = thinking_plan
        .filter(|plan| {
            matches!(
                plan.channel.as_str(),
                "dsh-deepseek-native" | "dsh-pi-ai"
            )
        })
        .and_then(|plan| {
            if plan.level.is_empty() {
                None
            } else {
                Some(
                    plan.wire
                        .clone()
                        .unwrap_or_else(|| plan.level.clone()),
                )
            }
        });
    let effort: Option<String> = if third_party {
        None
    } else {
        planned_effort.or_else(|| {
            thinking_level
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
    };
    if base_url.is_some() || effort.is_some() {
        // `llm-deepseek` 默认条目无 config（全靠 settings.yaml 的
        // `llm-deepseek:` 段）。整行替换为 `{apiKeyEnv, baseURL, reasoningEffort}`，
        // 让 headless 在不读 settings.yaml 的场景下也能命中端点覆盖与思考档位。
        // `apiKeyEnv` 用默认值 `DEEPSEEK_API_KEY`，与 UGS 注入的环境变量对齐。
        let mut row = String::from(
            "- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n",
        );
        if let Some(base_url) = base_url {
            row.push_str(&format!("    baseURL: {}\n", yaml_scalar(base_url)));
        }
        if let Some(effort) = effort {
            row.push_str(&format!("    reasoningEffort: {}\n", yaml_scalar(&effort)));
        }
        out.push_str(&row);
    }
    out
}

/// baseURL 是否指向 DeepSeek 官方端点。官方（或其区域别名）才使用 native
/// 适配器的私有 wire；其余一律视为第三方兼容网关。仅比对 host，忽略协议、
/// 端口与路径（官方文档端点为 `https://api.deepseek.com`）。
fn is_official_deepseek(base_url: &str) -> bool {
    let after_scheme = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    let host = after_scheme
        .split(['/', ':'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == "api.deepseek.com" || host.ends_with(".deepseek.com") || host == "deepseek.com"
}

/// 模型 id 是否应按「可读图片」声明给 pi-ai 的 catalog。
///
/// 第三方分支只能在 patch 里手工声明模型条目，UGS 拿不到网关侧的模态元数据，
/// 因此按 id 命名保守判定：只有名字里明确标注视觉能力的模型才声明 `image`，
/// 其余保持纯文本，避免给纯文本模型虚报图片能力后请求被网关 400。
///
/// `deepseek-flash`（V4.1-Flash）是官方原生多模态模型，官方渠道
/// `deepseek-v4-flash-vision-exp` 已于 2026-09 下线、由它接替，按名字判定
/// 会漏掉，这里显式补上。
fn model_declares_image_input(model: &str) -> bool {
    let id = model.to_ascii_lowercase();
    id.contains("vision")
        || id.contains("-vl")
        || id.starts_with("vl")
        || id == "deepseek-flash"
}

/// 把任意字符串编为 YAML 双引号标量，转义反斜杠、双引号与全部控制字符。
/// dsh 的 patch 文件按 YAML 解析，URL/model id 含 `:`、`/` 等字符时
/// 必须引用，避免被误读为 map/anchor。任务文本可能含换行/制表等控制字符，
/// 同样必须转义，否则会破坏 YAML 双引号标量结构。
fn yaml_scalar(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0C}' => escaped.push_str("\\f"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\x{:02x}", c as u32)),
            c => escaped.push(c),
        }
    }
    format!("\"{escaped}\"")
}

/// 快照一个会话根目录下的全部会话目录（两层：项目目录 → 会话目录）。
pub fn snapshot_session_dirs(root: &Path) -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return set;
    };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(sessions) = std::fs::read_dir(&project_path) else {
            continue;
        };
        for session in sessions.flatten() {
            let path = session.path();
            if path.is_dir() {
                set.insert(path);
            }
        }
    }
    set
}

/// 定位一个会话目录里的落盘日志文件。
///
/// dsh 的 v3 事件格式把日志名从 `session.jsonl` 改成了 `session.v3.jsonl`
/// （首行 `{"type":"session","version":3,…}`）。旧实现把 `session.jsonl`
/// 写死，v3 会话下 `poll_log` 每次都因为文件不存在直接 `return`，整条
/// live 进度链路**静默失效**——聊天气泡只剩占位符，直到回合结束才用最终
/// 文本整体刷新（现场：`📋 进入步骤 N` 与工具卡片全部消失，用户只看到
/// 最终结论）。
///
/// 因此按「精确名优先、再退到 `session*.jsonl` 里最新修改的那个」解析，
/// 后续 dsh 再改一次版本后缀也不会重犯同一个问题。
fn session_log_path(dir: &Path) -> Option<PathBuf> {
    let legacy = dir.join("session.jsonl");
    if legacy.is_file() {
        return Some(legacy);
    }
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("session") || !name.ends_with(".jsonl") {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().map_or(true, |(time, _)| modified > *time) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

/// 长任务期间文本/工具补丁的批量推送器（独立于 lib.rs 的
/// `AiCliProgressBatcher`，拥有 AppHandle 避免借用问题；语义一致）。
struct ProgressBatcher {
    app: tauri::AppHandle,
    run_id: String,
    pending: String,
    last_flush: Instant,
}

impl ProgressBatcher {
    fn new(app: tauri::AppHandle, run_id: String) -> Self {
        Self {
            app,
            run_id,
            pending: String::new(),
            last_flush: Instant::now(),
        }
    }

    fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.pending.push_str(text);
        if self.pending.len() >= crate::AI_CLI_PROGRESS_BATCH_MAX_BYTES
            || self.last_flush.elapsed()
                >= Duration::from_millis(crate::AI_CLI_PROGRESS_BATCH_INTERVAL_MS)
        {
            self.flush();
        }
    }

    fn emit_now(&mut self, text: &str) {
        self.flush();
        crate::emit_progress(&self.app, &self.run_id, text);
        self.last_flush = Instant::now();
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        crate::emit_progress(&self.app, &self.run_id, &self.pending);
        self.pending.clear();
        self.last_flush = Instant::now();
    }
}

/// 轮询尾随器。
struct DshLogTracer {
    sessions_root: PathBuf,
    known: HashSet<PathBuf>,
    spawned_at: SystemTime,
    activity: Arc<Mutex<Instant>>,
    received: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    /// 已锁定的本次运行会话目录。
    target: Option<PathBuf>,
    /// 已处理到的文件字节偏移（只推进到最后一个完整行的行尾）。
    committed: u64,
    /// 跨轮次残留的半行。
    line_buf: String,
    /// 已提示过“思考中”的 (turn, step)，避免思考增量刷屏。
    thinking_announced: HashSet<(i64, i64)>,
    progress: ProgressBatcher,
}

impl DshLogTracer {
    fn new(cfg: DshTracerConfig) -> Self {
        let progress = ProgressBatcher::new(cfg.app, cfg.run_id);
        Self {
            sessions_root: cfg.sessions_root,
            known: cfg.known,
            spawned_at: cfg.spawned_at,
            activity: cfg.activity,
            received: cfg.received,
            active: cfg.active,
            cancel: cfg.cancel,
            target: None,
            committed: 0,
            line_buf: String::new(),
            thinking_announced: HashSet::new(),
            progress,
        }
    }

    /// 一轮轮询：发现会话目录（若尚未锁定），然后尾随其日志。
    fn poll_once(&mut self) {
        if self.target.is_none() {
            self.discover();
        }
        if let Some(dir) = self.target.clone() {
            self.poll_log(&dir);
        }
    }

    /// 在 spawn 后新建（创建时间晚于 spawn 时刻，宽容 2 秒）的会话目录中
    /// 选择最新一个作为本次运行的日志。取到后立即锁定，不再更换。
    fn discover(&mut self) {
        let cutoff = self
            .spawned_at
            .checked_sub(Duration::from_secs(2))
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();
        if let Ok(projects) = std::fs::read_dir(&self.sessions_root) {
            for project in projects.flatten() {
                let project_path = project.path();
                if !project_path.is_dir() {
                    continue;
                }
                if let Ok(sessions) = std::fs::read_dir(&project_path) {
                    for session in sessions.flatten() {
                        let path = session.path();
                        if !path.is_dir() || self.known.contains(&path) {
                            continue;
                        }
                        let created = session
                            .metadata()
                            .ok()
                            .and_then(|meta| meta.created().ok())
                            .unwrap_or(SystemTime::UNIX_EPOCH);
                        if created >= cutoff {
                            candidates.push((created, path));
                        }
                    }
                }
            }
        }
        if candidates.is_empty() {
            return;
        }
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        if let Some((_, dir)) = candidates.into_iter().next() {
            self.target = Some(dir);
        }
    }

    /// 增量读取会话日志，只处理新增的完整行。文件名走 [`session_log_path`]，
    /// 兼容 `session.jsonl`（旧）与 `session.v3.jsonl`（v3）。
    fn poll_log(&mut self, dir: &Path) {
        let Some(path) = session_log_path(dir) else {
            return;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            return;
        };
        let len = meta.len();
        if len < self.committed {
            // 文件被重建/截断：从头重读。
            self.committed = 0;
            self.line_buf.clear();
        }
        let mut file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(_) => return,
        };
        if file.seek(SeekFrom::Start(self.committed)).is_err() {
            return;
        }
        let mut new_bytes = Vec::new();
        if file.read_to_end(&mut new_bytes).is_err() || new_bytes.is_empty() {
            return;
        }
        self.line_buf.push_str(&String::from_utf8_lossy(&new_bytes));
        let Some(nl) = self.line_buf.rfind('\n') else {
            return; // 尚无完整行（半帧/半行跨轮次）
        };
        let complete = self.line_buf[..nl].to_string();
        let tail = self.line_buf[nl + 1..].to_string();
        let consumed = new_bytes.len() - tail.len();
        self.line_buf = tail;
        self.committed += consumed as u64;
        for line in complete.split('\n') {
            self.handle_line(line);
        }
    }

    fn handle_line(&mut self, line: &str) {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            return;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        if event_sets_received(&event) {
            self.received.store(true, Ordering::Relaxed);
            crate::touch_activity(&self.activity);
        }
        if let Some(item) = event_to_progress(&event, &mut self.thinking_announced) {
            match item {
                DshProgressItem::Text(text) => self.progress.push(&text),
                DshProgressItem::Patch(patch) => {
                    self.progress.emit_now(&crate::encode_tool_patch(&patch));
                }
            }
            self.active.store(true, Ordering::Relaxed);
            crate::touch_activity(&self.activity);
        }
    }
}

/// 启动尾随器线程的主体循环：每 500ms 轮询一次，直到收到取消信号。
pub fn run_tracer(cfg: DshTracerConfig) {
    let mut tracer = DshLogTracer::new(cfg);
    while !tracer.cancel.load(Ordering::Relaxed) {
        tracer.poll_once();
        std::thread::sleep(Duration::from_millis(500));
    }
    // 退出前补一轮，尽量收走进程退出前最后一批事件。
    tracer.poll_once();
    tracer.progress.flush();
}

/// 该事件是否算“产生了真实内容”（用于静默失败判定）。
fn event_sets_received(event: &serde_json::Value) -> bool {
    match event.get("type").and_then(|value| value.as_str()) {
        Some("assistant/chunk") => match chunk_kind(event) {
            Some("text-delta") | Some("reasoning-delta") => true,
            _ => false,
        },
        Some("tool/call") | Some("tool/result") => true,
        // v3：整条 assistant 消息里带正文/思考/工具调用块都算真实产出。
        Some("assistant/message") => event
            .pointer("/data/message/content")
            .and_then(|value| value.as_array())
            .map_or(false, |blocks| {
                blocks.iter().any(|block| {
                    matches!(
                        block.get("type").and_then(|value| value.as_str()),
                        Some("text") | Some("reasoning") | Some("tool-call")
                    )
                })
            }),
        _ => false,
    }
}

/// 取出 `data.chunk.type`（仅 assistant/chunk 有效）。
fn chunk_kind(event: &serde_json::Value) -> Option<&str> {
    event
        .pointer("/data/chunk/type")
        .and_then(|value| value.as_str())
}

/// 把一个会话事件映射为一则进度（文本或工具补丁）。`thinking_announced`
/// 用于抑制同一 (turn, step) 内重复的“思考中”提示。
pub fn event_to_progress(
    event: &serde_json::Value,
    thinking_announced: &mut HashSet<(i64, i64)>,
) -> Option<DshProgressItem> {
    let event_type = event.get("type").and_then(|value| value.as_str())?;
    match event_type {
        "assistant/chunk" => match chunk_kind(event) {
            Some("text-delta") => {
                let text = event
                    .pointer("/data/chunk/text")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if text.is_empty() {
                    None
                } else {
                    Some(DshProgressItem::Text(text.to_string()))
                }
            }
            Some("reasoning-delta") => {
                let turn = event
                    .pointer("/data/turn")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let step = event
                    .pointer("/data/step")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if thinking_announced.insert((turn, step)) {
                    Some(DshProgressItem::Text("\n💭 正在深入思考…\n".to_string()))
                } else {
                    None
                }
            }
            _ => None,
        },
        // v3 事件格式不再逐 token 推 `assistant/chunk`，而是在每一步收尾时
        // 落一条完整的 `assistant/message`（`data.message.content[]` 里是
        // 正文 / 思考 / 工具调用块）。不接这个分支，v3 会话的中间解释文字会
        // 整段丢失，live 缓冲里只剩步骤行与工具卡片。
        "assistant/message" => assistant_message_progress(event, thinking_announced),
        "tool/call" => tool_call_patch(event).map(DshProgressItem::Patch),
        "tool/result" => tool_result_patch(event).map(DshProgressItem::Patch),
        "step/start" => {
            let step = event
                .pointer("/data/step")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            Some(DshProgressItem::Text(format!("\n📋 进入步骤 {step}\n")))
        }
        "turn/start" => {
            let turn = event
                .pointer("/data/turn")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            Some(DshProgressItem::Text(format!("\n▶ 第 {turn} 回合开始\n")))
        }
        _ => None,
    }
}

/// v3 `assistant/message` → 一段进度文本。
///
/// 只取 `text` / `reasoning` 块：`tool-call` 块由紧随其后的 `tool/call`
/// 事件单独推送，这里再推一次会渲染成重复的工具卡片。
fn assistant_message_progress(
    event: &serde_json::Value,
    thinking_announced: &mut HashSet<(i64, i64)>,
) -> Option<DshProgressItem> {
    let blocks = event.pointer("/data/message/content")?.as_array()?;
    let turn = event
        .pointer("/data/turn")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let step = event
        .pointer("/data/step")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let mut out = String::new();
    for block in blocks {
        match block.get("type").and_then(|value| value.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                    if !text.trim().is_empty() {
                        out.push_str(text);
                        if !out.ends_with('\n') {
                            out.push('\n');
                        }
                    }
                }
            }
            Some("reasoning") => {
                if thinking_announced.insert((turn, step)) {
                    out.push_str("\n💭 正在深入思考…\n");
                }
            }
            _ => {}
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(DshProgressItem::Text(out))
    }
}

/// 从工具参数里挑一个适合做卡片标题的短摘要（单行、≤200 字符）。
fn tool_subject_from_args(args: Option<&serde_json::Value>) -> String {
    const PREFERRED: &[&str] = &[
        "file_path",
        "path",
        "command",
        "query",
        "pattern",
        "url",
        "folder",
        "directory",
        "name",
        "message",
        "text",
        "title",
    ];
    let Some(args) = args else {
        return String::new();
    };
    for key in PREFERRED {
        if let Some(value) = args.get(*key).and_then(|value| value.as_str()) {
            let one_line = value.replace(['\n', '\r'], " ");
            let trimmed = one_line.trim();
            if !trimmed.is_empty() {
                return trimmed.chars().take(200).collect();
            }
        }
    }
    String::new()
}

/// 递归把 JSON 里的长字符串字段截短，避免超大工具参数撑爆 live 消息。
fn clamp_json_strings(value: &serde_json::Value, limit: usize) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            if text.chars().count() > limit {
                let head: String = text.chars().take(limit).collect();
                serde_json::Value::String(format!("{head}…（已截断）"))
            } else {
                value.clone()
            }
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| clamp_json_strings(item, limit))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), clamp_json_strings(item, limit)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `tool/call` 事件 → running 工具补丁（与前端 `ToolEventPatch` 契约一致，
/// 按 callId 与后续 `tool/result` 补丁原地合并成一张卡片）。
fn tool_call_patch(event: &serde_json::Value) -> Option<serde_json::Value> {
    let name = event.pointer("/data/name")?.as_str()?;
    let call_id = event.pointer("/data/callId")?.as_str()?;
    let args_raw = event
        .pointer("/data/arguments")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let args = serde_json::from_str::<serde_json::Value>(args_raw).ok();
    let subject = tool_subject_from_args(args.as_ref());
    let file_changes = args.as_ref().and_then(|value| {
        let normalized = name.to_ascii_lowercase().replace('_', "");
        if !matches!(normalized.as_str(), "edit" | "editfile" | "strreplace" | "multiedit") {
            return None;
        }
        let path = value.get("file_path").or_else(|| value.get("path"))?.as_str()?;
        let old = value.get("old_string")?.as_str()?;
        let new = value.get("new_string")?.as_str()?;
        if old == new { return None; }
        if value.get("replace_all").and_then(|value| value.as_bool()) == Some(true) {
            return None;
        }
        let (lines, truncated) = crate::diff_text_lines(old, new);
        if truncated { return None; }
        Some(serde_json::json!([{
            "path": path,
            "added": lines.iter().filter(|line| matches!(line.kind.as_str(), "added" | "replacedAdded")).count(),
            "deleted": lines.iter().filter(|line| matches!(line.kind.as_str(), "deleted" | "replacedDeleted")).count(),
        }]))
    });
    let args = args.map(|value| clamp_json_strings(&value, 600));
    // Moon Add: update_goal 是 dsh harness 内部的目标管理工具，不是面向用户
    // 的调用。标记 ephemeral 让它只在流式期间短暂可见，最终消息持久化时被
    // 前端 isPersistentToolPatch 过滤掉，不再作为「末尾莫名多出的工具卡片」出现。
    let mut patch = serde_json::json!({
        "id": call_id,
        "name": name,
        "subject": subject,
        "status": "running",
        "args": args,
    });
    if let Some(file_changes) = file_changes {
        patch["fileChanges"] = file_changes;
    }
    if name == "update_goal" {
        patch["ephemeral"] = serde_json::Value::Bool(true);
    }
    Some(patch)
}

/// 工具结果文本：`data.message.content[].content[].text`（兼容直接 text 块）。
fn extract_tool_result_text(event: &serde_json::Value) -> String {
    let mut parts = Vec::new();
    if let Some(blocks) = event
        .pointer("/data/message/content")
        .and_then(|v| v.as_array())
    {
        for block in blocks {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                parts.push(text.to_string());
                continue;
            }
            if let Some(inner) = block.get("content").and_then(|v| v.as_array()) {
                for item in inner {
                    if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            parts.push(text.to_string());
                        }
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        if let Some(text) = event.pointer("/data/content").and_then(|v| v.as_str()) {
            return text.to_string();
        }
    }
    parts.join("\n")
}

/// `tool/result` 事件 → done/error 工具补丁。
fn tool_result_patch(event: &serde_json::Value) -> Option<serde_json::Value> {
    let call_id = event
        .pointer("/data/message/source/callId")
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .pointer("/data/callId")
                .and_then(|value| value.as_str())
        })?;
    let is_error = event
        .pointer("/data/message/content")
        .and_then(|value| value.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("isError").and_then(|v| v.as_bool()) == Some(true))
        })
        .unwrap_or(false);
    let result_raw = extract_tool_result_text(event);
    let truncated = result_raw.chars().count() > crate::TOOL_RESULT_CLAMP;
    let result: String = result_raw.chars().take(crate::TOOL_RESULT_CLAMP).collect();
    Some(serde_json::json!({
        "id": call_id,
        "status": if is_error { "error" } else { "done" },
        "result": result,
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn event(line: &str) -> serde_json::Value {
        serde_json::from_str(line).expect("valid event JSON")
    }

    fn text_delta(turn: i64, step: i64, text: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "assistant/chunk",
            "seq": 1, "time": 1,
            "data": { "turn": turn, "step": step, "chunk": { "type": "text-delta", "index": 0, "text": text } }
        })
    }

    #[test]
    fn text_delta_maps_to_streaming_text() {
        let mut announced = HashSet::new();
        let item = event_to_progress(&text_delta(1, 1, "你好，"), &mut announced);
        match item {
            Some(DshProgressItem::Text(text)) => assert_eq!(text, "你好，"),
            other => panic!("expected Text, got {other:?}"),
        }
        assert!(event_sets_received(&text_delta(1, 1, "x")));
    }

    #[test]
    fn reasoning_delta_announces_once_per_step() {
        let mut announced = HashSet::new();
        let first = event_to_progress(
            &serde_json::json!({
                "type": "assistant/chunk", "seq": 1, "time": 1,
                "data": { "turn": 1, "step": 2, "chunk": { "type": "reasoning-delta", "index": 0, "text": "思考中……" } }
            }),
            &mut announced,
        );
        assert!(matches!(first, Some(DshProgressItem::Text(_))));
        let second = event_to_progress(
            &serde_json::json!({
                "type": "assistant/chunk", "seq": 2, "time": 2,
                "data": { "turn": 1, "step": 2, "chunk": { "type": "reasoning-delta", "index": 0, "text": "继续……" } }
            }),
            &mut announced,
        );
        assert!(second.is_none());
    }

    #[test]
    fn tool_call_produces_running_patch() {
        let ev = event(
            r#"{"type":"tool/call","seq":10,"time":3,"data":{"turn":1,"step":1,"callId":"call_1","name":"read","arguments":"{\"file_path\": \"E:\\\\src\\\\a.rs\", \"limit\": 80}"}}"#,
        );
        let patch = tool_call_patch(&ev).expect("patch");
        assert_eq!(patch["id"], "call_1");
        assert_eq!(patch["name"], "read");
        assert_eq!(patch["status"], "running");
        assert_eq!(patch["subject"], r"E:\src\a.rs");
        assert_eq!(patch["args"]["file_path"], r"E:\src\a.rs");
        assert!(event_sets_received(&ev));
    }

    #[test]
    fn tool_result_produces_done_patch() {
        let ev = event(
            r#"{"type":"tool/result","seq":11,"time":4,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_1"},"content":[{"type":"tool-result","toolCallId":"call_1","content":[{"type":"text","text":"OK 42 lines"}],"isError":false}],"role":"user"}}}"#,
        );
        let patch = tool_result_patch(&ev).expect("patch");
        assert_eq!(patch["id"], "call_1");
        assert_eq!(patch["status"], "done");
        assert_eq!(patch["result"], "OK 42 lines");
        assert_eq!(patch["truncated"], false);
        assert!(event_sets_received(&ev));
    }

    #[test]
    fn edit_file_counts_survive_argument_clipping() {
        let ev = serde_json::json!({ "data": {
            "name": "edit", "callId": "edit1", "arguments": serde_json::json!({
                "file_path": "src/app.ts",
                "old_string": "old\n".repeat(200), "new_string": "new\n".repeat(300)
            }).to_string()
        }});
        let patch = tool_call_patch(&ev).unwrap();
        assert_eq!(patch["fileChanges"][0]["added"], 300);
        assert_eq!(patch["fileChanges"][0]["deleted"], 200);
        assert!(patch["args"]["new_string"].as_str().unwrap().contains("已截断"));
    }

    #[test]
    fn tool_result_error_status() {
        let ev = event(
            r#"{"type":"tool/result","seq":12,"time":5,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_2"},"content":[{"type":"tool-result","toolCallId":"call_2","content":[{"type":"text","text":"failed"}],"isError":true}],"role":"user"}}}"#,
        );
        let patch = tool_result_patch(&ev).expect("patch");
        assert_eq!(patch["status"], "error");
    }

    #[test]
    fn step_start_produces_status_line() {
        let ev = event(r#"{"type":"step/start","seq":6,"time":6,"data":{"turn":1,"step":3}}"#);
        let mut announced = HashSet::new();
        match event_to_progress(&ev, &mut announced) {
            Some(DshProgressItem::Text(text)) => assert!(text.contains("步骤 3")),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn unrelated_events_are_ignored() {
        let mut announced = HashSet::new();
        for line in [
            r#"{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}"#,
            r#"{"type":"permission/preset","seq":0,"time":1,"data":{"preset":"workspace-write"}}"#,
            r#"{"type":"user/message","seq":7,"time":1,"data":{"role":"user"}}"#,
            r#"{"type":"assistant/message","seq":8,"time":1,"data":{"role":"assistant"}}"#,
            r#"{"type":"request/header","seq":9,"time":1,"data":{}}"#,
        ] {
            assert!(
                event_to_progress(&event(line), &mut announced).is_none(),
                "should ignore: {line}"
            );
            assert!(
                !event_sets_received(&event(line)),
                "should not set received: {line}"
            );
        }
    }

    #[test]
    fn snapshot_finds_session_dirs_two_levels_deep() {
        let tmp = std::env::temp_dir().join(format!("ugs-dsh-test-{}", std::process::id()));
        let session = tmp.join("--Proj--").join("session-abc");
        std::fs::create_dir_all(&session).expect("create tree");
        let set = snapshot_session_dirs(&tmp);
        assert_eq!(set.len(), 1);
        assert!(set.contains(&session));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 回归：dsh 的 v3 事件格式把日志改名成 `session.v3.jsonl`。旧实现把
    /// `session.jsonl` 写死，v3 会话下尾随器每轮都因文件不存在直接返回，
    /// 整条 live 进度链路静默失效——聊天气泡只剩最终结果（现场现象）。
    #[test]
    fn session_log_path_reads_v3_file_name() {
        let tmp = std::env::temp_dir().join(format!("ugs-dsh-logpath-{}", std::process::id()));
        let session = tmp.join("--Proj--").join("session-abc");
        std::fs::create_dir_all(&session).expect("create tree");

        let v3 = session.join("session.v3.jsonl");
        std::fs::write(&v3, "{}\n").expect("write v3");
        assert_eq!(session_log_path(&session), Some(v3));

        // 老文件名在场时优先老名，避免多文件时选错。
        let legacy = session.join("session.jsonl");
        std::fs::write(&legacy, "{}\n").expect("write legacy");
        assert_eq!(session_log_path(&session), Some(legacy.clone()));

        // 再改名（v4）也必须命中：按 `session*.jsonl` 取最新，而不是再写死一次。
        std::fs::remove_file(&legacy).expect("rm legacy");
        let v4 = session.join("session.v4.jsonl");
        std::fs::write(&v4, "{}\n").expect("write v4");
        assert_eq!(session_log_path(&session), Some(v4));

        // 空目录返回 None，保持「静默降级回 stdout 转发」的既有约定。
        let empty = tmp.join("empty");
        std::fs::create_dir_all(&empty).expect("create empty");
        assert_eq!(session_log_path(&empty), None);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// v3 不再推 `assistant/chunk`，正文/思考只存在于整条 `assistant/message`
    /// 里；不接这个分支，回合中间的正文会整段丢失。
    #[test]
    fn assistant_message_maps_text_and_reasoning() {
        let mut announced = HashSet::new();
        let ev = event(
            r#"{"type":"assistant/message","seq":14,"time":9,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"reasoning","text":"先看文件"},{"type":"text","text":"现在读取渲染源码。"}]}}}"#,
        );
        match event_to_progress(&ev, &mut announced) {
            Some(DshProgressItem::Text(text)) => {
                assert!(text.contains("正在深入思考"), "{text}");
                assert!(text.contains("现在读取渲染源码。"), "{text}");
            }
            other => panic!("expected Text, got {other:?}"),
        }
        assert!(event_sets_received(&ev));

        // 同一 (turn, step) 的思考提示只出现一次，避免整条消息刷屏。
        let again = event(
            r#"{"type":"assistant/message","seq":15,"time":10,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"reasoning","text":"继续想"}]}}}"#,
        );
        assert!(event_to_progress(&again, &mut announced).is_none());
    }

    /// 工具调用块不从这里推：紧随其后的 `tool/call` 事件会单独出卡片，
    /// 两边都推会在气泡里渲染出两张重复卡片。
    #[test]
    fn assistant_message_skips_tool_call_blocks() {
        let mut announced = HashSet::new();
        let ev = event(
            r#"{"type":"assistant/message","seq":16,"time":11,"data":{"turn":1,"step":3,"message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_9","name":"read"}]}}}"#,
        );
        assert!(event_to_progress(&ev, &mut announced).is_none());
    }

    #[test]
    fn clamp_truncates_long_strings() {
        let long = "x".repeat(2000);
        let value = serde_json::json!({ "content": long, "small": "ok" });
        let clamped = clamp_json_strings(&value, 600);
        assert_eq!(clamped["small"], "ok");
        let text = clamped["content"].as_str().expect("string");
        assert!(text.contains("已截断"));
        assert!(text.chars().count() < 700);
    }

    #[test]
    fn subject_picks_file_path_over_command() {
        let args = serde_json::json!({ "command": "ls", "file_path": "src/main.rs" });
        assert_eq!(tool_subject_from_args(Some(&args)), "src/main.rs");
        let args = serde_json::json!({ "command": "npm test" });
        assert_eq!(tool_subject_from_args(Some(&args)), "npm test");
    }

    #[test]
    fn ugs_patch_yaml_targets_persistence_row() {
        let yaml = ugs_patch_yaml(None, None, None, None);
        assert!(yaml.contains("session-persistence-jsonl"));
        assert!(yaml.contains("compression: none"));
        assert!(yaml.contains("packChunks: false"));
        assert!(yaml.contains("UGS_DSH_SESSIONS"));
        // 无 model/baseURL 时不应生成对应 patch 行，保持 dsh 默认行为。
        assert!(!yaml.contains("agent-default-model"));
        assert!(!yaml.contains("llm-deepseek"));
    }

    /// dsh 权限档必须经 DSH_PERMISSION_MODE 环境变量下发（dsh base profile 的
    /// sandbox-policy/approval 读它）；不设则 dsh 永远落在 workspace-write+ask，
    /// composer 选「完全访问」也照样弹审批。
    #[test]
    fn dsh_permission_mode_maps_composer_tiers() {
        assert_eq!(dsh_permission_mode(Some("full")), "danger-full-access");
        assert_eq!(dsh_permission_mode(None), "danger-full-access");
        assert_eq!(dsh_permission_mode(Some("readonly")), "read-only");
        assert_eq!(dsh_permission_mode(Some("ask")), "workspace-write");
        // 未知档位与缺省一致，按 full 处理，避免静默降级成 ask。
        assert_eq!(dsh_permission_mode(Some("bogus")), "danger-full-access");
    }

    #[test]
    fn ugs_patch_yaml_overrides_default_model_when_channel_supplies_one() {
        let yaml = ugs_patch_yaml(Some("deepseek-v4-pro"), None, None, None);
        assert!(yaml.contains("agent-default-model"));
        assert!(yaml.contains("provider: deepseek-official"));
        assert!(yaml.contains("model: \"deepseek-v4-pro\""));
        // baseURL 缺省时不写 llm-deepseek 行。
        assert!(!yaml.contains("llm-deepseek"));
        // 无第三方 baseURL 不应触碰 pi-ai 路径。
        assert!(!yaml.contains("llm-pi-ai"));
    }

    #[test]
    fn ugs_patch_yaml_keeps_native_for_official_base_url() {
        // 官方端点即便显式给出 baseURL，也走 native deepseek-official，
        // 保留 thinking/reasoning 能力。
        let yaml = ugs_patch_yaml(
            Some("deepseek-v4-pro"),
            Some("https://api.deepseek.com"),
            None,
            None,
        );
        assert!(yaml.contains("provider: deepseek-official"));
        assert!(yaml.contains("id: llm-deepseek"));
        assert!(yaml.contains("baseURL: \"https://api.deepseek.com\""));
        assert!(!yaml.contains("llm-pi-ai"));
        assert!(!yaml.contains("deepseek-compat"));
    }

    #[test]
    fn ugs_patch_yaml_routes_third_party_through_pi_ai() {
        // 第三方兼容网关：必须走 pi-ai openai-completions，绝不带 native
        // deepseek-official（否则私有 thinking 字段触发 HTTP 400）。
        let yaml = ugs_patch_yaml(
            Some("deepseek-v4-pro"),
            Some("https://gateway.example.com/v1"),
            None,
            None,
        );
        assert!(yaml.contains("id: llm-pi-ai"));
        assert!(yaml.contains("provider: deepseek-compat"));
        assert!(yaml.contains("deepseek-compat:"));
        assert!(yaml.contains("api: openai-completions"));
        assert!(yaml.contains("apiKeyEnv: DEEPSEEK_API_KEY"));
        assert!(yaml.contains("baseURL: \"https://gateway.example.com/v1\""));
        assert!(yaml.contains("id: \"deepseek-v4-pro\""));
        // 关键：不得回落到 native 官方路由。
        assert!(!yaml.contains("provider: deepseek-official"));
        assert!(!yaml.contains("id: llm-deepseek"));
    }

    #[test]
    fn ugs_patch_yaml_third_party_without_model_falls_back_to_native() {
        // 第三方 baseURL 但缺 model：无法安全声明 pi-ai catalog（会
        // UNKNOWN_MODEL），退回 native + baseURL 覆盖，保持旧行为不崩。
        let yaml = ugs_patch_yaml(None, Some("https://gateway.example.com/v1"), None, None);
        assert!(!yaml.contains("llm-pi-ai"));
        assert!(yaml.contains("id: llm-deepseek"));
        assert!(yaml.contains("baseURL: \"https://gateway.example.com/v1\""));
        assert!(!yaml.contains("agent-default-model"));
    }

    #[test]
    fn ugs_patch_yaml_embeds_task_into_headless_runner() {
        // 大任务（会溢出 Windows 命令行长度）应写入 `headless-runner` 的
        // `task` 配置，而不是 argv；缺省无任务时绝不生成该行。
        let yaml = ugs_patch_yaml(None, None, None, None);
        assert!(!yaml.contains("headless-runner"));

        let task = "运行一下测试\n并检查 \"引号\" 与反斜杠 \\。";
        let yaml = ugs_patch_yaml(None, None, Some(task), None);
        assert!(yaml.contains("id: headless-runner"));
        assert!(yaml.contains(r#"task: "运行一下测试\n并检查 \"引号\" 与反斜杠 \\。""#));

        // 空白任务不会写入（与 headless 拒绝空白任务一致）。
        let yaml = ugs_patch_yaml(None, None, Some("   "), None);
        assert!(!yaml.contains("headless-runner"));
    }

    #[test]
    fn ugs_patch_yaml_keeps_task_on_third_party_route() {
        // 回归：第三方 pi-ai 分支曾提前 `return`，把 `headless-runner.task`
        // 整个吞掉。dsh 于是只能拿 argv 占位符 `.` 当任务，模型收到的用户
        // 消息就是一个句点（现场 session 的 provider=deepseek-compat）。
        // 长任务 + 第三方渠道必须同时带 pi-ai 路由与任务行。
        let task = "看一下这个渲染 bug";
        let yaml = ugs_patch_yaml(
            Some("deepseek-v4.1-flash"),
            Some("https://gateway.example.com/v1"),
            Some(task),
            None,
        );
        assert!(yaml.contains("id: llm-pi-ai"));
        assert!(yaml.contains("provider: deepseek-compat"));
        assert!(yaml.contains("id: headless-runner"));
        assert!(yaml.contains(&format!("task: {}", yaml_scalar(task))));
        // 任务行必须排在渠道分支之前，任何 return 都不能越过它。
        let task_at = yaml.find("id: headless-runner").unwrap();
        let route_at = yaml.find("id: llm-pi-ai").unwrap();
        assert!(task_at < route_at);
    }

    #[test]
    fn ugs_patch_yaml_declares_image_input_for_vision_models() {
        // 回归：第三方分支曾在 catalog 条目里漏写 `input`，pi-ai 于是把
        // vision 模型当纯文本，`read_image` 直接报 "does not declare image
        // input"（现场 provider=deepseek-compat、model=deepseek-v4-flash-vision-exp）。
        let yaml = ugs_patch_yaml(
            Some("deepseek-v4-flash-vision-exp"),
            Some("https://ai-gateway.example.com"),
            None,
            None,
        );
        assert!(yaml.contains("input: [text, image]"));

        // 纯文本模型不得虚报图片能力。
        let yaml = ugs_patch_yaml(
            Some("deepseek-v4-pro"),
            Some("https://ai-gateway.example.com"),
            None,
            None,
        );
        assert!(yaml.contains("input: [text]"));
        assert!(!yaml.contains("input: [text, image]"));
    }

    #[test]
    fn ugs_patch_yaml_keeps_task_on_official_route() {
        // 官方直连（native）路径同样不许吞任务行。
        let yaml = ugs_patch_yaml(Some("deepseek-v4-pro"), None, Some("跑一遍回归测试"), None);
        assert!(yaml.contains("provider: deepseek-official"));
        assert!(yaml.contains("id: headless-runner"));
        assert!(yaml.contains(r#"task: "跑一遍回归测试""#));
    }

    /// 思考深度：官方 native 路由写进 `llm-deepseek.reasoningEffort`。
    #[test]
    fn ugs_patch_yaml_injects_reasoning_effort_on_native_route() {
        let yaml = ugs_patch_yaml(Some("deepseek-v4-pro"), None, None, Some("max"));
        assert!(yaml.contains("id: llm-deepseek"));
        assert!(yaml.contains("apiKeyEnv: DEEPSEEK_API_KEY"));
        assert!(yaml.contains("reasoningEffort: \"max\""));
        // `off` 由适配器序列化成 thinking.type=disabled，原样透传即可。
        let yaml = ugs_patch_yaml(Some("deepseek-v4-pro"), None, None, Some("off"));
        assert!(yaml.contains("reasoningEffort: \"off\""));
        // 空白等级不写行。
        let yaml = ugs_patch_yaml(None, None, None, Some("   "));
        assert!(!yaml.contains("llm-deepseek"));
    }

    /// 第三方兼容网关不认 DeepSeek 私有字段，绝不能带上 reasoningEffort。
    #[test]
    fn ugs_patch_yaml_skips_reasoning_effort_on_third_party_route() {
        let yaml = ugs_patch_yaml(
            Some("deepseek-v4-pro"),
            Some("https://gateway.example.com/v1"),
            None,
            Some("max"),
        );
        assert!(yaml.contains("id: llm-pi-ai"));
        assert!(!yaml.contains("reasoningEffort"));
    }

    /// 前端计划（`UGS_THINKING_PLAN`）解析：wire 为 null = 该档不发字段。
    #[test]
    fn parse_thinking_plan_reads_frontend_json() {
        let plan = parse_thinking_plan(Some(
            r#"{"channel":"dsh-pi-ai","level":"high","wire":"high","efforts":{"off":null,"low":"low","high":"high","max":"max"},"thinkingFormat":"deepseek"}"#,
        ))
        .expect("valid plan");
        assert_eq!(plan.channel, "dsh-pi-ai");
        assert_eq!(plan.level, "high");
        assert_eq!(plan.wire.as_deref(), Some("high"));
        assert_eq!(plan.efforts.len(), 4);
        assert!(plan.efforts.iter().any(|(k, v)| k == "off" && v.is_none()));
        assert!(plan
            .efforts
            .iter()
            .any(|(k, v)| k == "high" && v.as_deref() == Some("high")));
        assert_eq!(plan.thinking_format.as_deref(), Some("deepseek"));

        // wire 为 null 的「关闭思考」计划仍然可用，只是不带 wire。
        let off = parse_thinking_plan(Some(
            r#"{"channel":"dsh-pi-ai","level":"off","wire":null,"efforts":{"off":null},"thinkingFormat":"deepseek"}"#,
        ))
        .expect("valid off plan");
        assert!(off.wire.is_none());

        // 坏输入一律降级为 None（宁可不打档位，也不发半截配置）。
        assert!(parse_thinking_plan(None).is_none());
        assert!(parse_thinking_plan(Some("   ")).is_none());
        assert!(parse_thinking_plan(Some("not json")).is_none());
        assert!(parse_thinking_plan(Some(r#"{"level":"high"}"#)).is_none());
    }

    /// 第三方 pi-ai 路由：手声明模型必须显式声明档位，否则永远没有思考深度。
    #[test]
    fn ugs_patch_yaml_declares_reasoning_efforts_on_pi_ai_route() {
        let plan = parse_thinking_plan(Some(
            r#"{"channel":"dsh-pi-ai","level":"high","wire":"high","efforts":{"off":null,"low":"low","high":"high","max":"max"},"thinkingFormat":"deepseek"}"#,
        ))
        .expect("valid plan");
        let yaml = ugs_patch_yaml_with_plan(
            Some("deepseek-v4-pro"),
            Some("https://gateway.example.com/v1"),
            None,
            Some("high"),
            Some(&plan),
        );
        assert!(yaml.contains("id: llm-pi-ai"));
        assert!(yaml.contains("reasoningEfforts: {"));
        assert!(yaml.contains("off: null"));
        assert!(yaml.contains(r#"low: "low""#));
        assert!(yaml.contains(r#"high: "high""#));
        assert!(yaml.contains(r#"max: "max""#));
        assert!(yaml.contains(
            r#"compat: {thinkingFormat: "deepseek", supportsReasoningEffort: true}"#
        ));
        // route 级默认档；native 的 llm-deepseek 条目一个都不许出现。
        assert!(yaml.contains(r#"reasoning: "high""#));
        assert!(!yaml.contains("id: llm-deepseek"));
    }

    /// 没有计划时，第三方 pi-ai profile 与旧版逐字一致（不带任何思考字段）。
    #[test]
    fn ugs_patch_yaml_keeps_pi_ai_profile_unchanged_without_plan() {
        let yaml = ugs_patch_yaml_with_plan(
            Some("deepseek-v4-pro"),
            Some("https://gateway.example.com/v1"),
            None,
            Some("high"),
            None,
        );
        assert!(yaml.contains("id: llm-pi-ai"));
        assert!(!yaml.contains("reasoningEffort"));
        assert!(!yaml.contains("thinkingFormat"));
        assert!(!yaml.contains("reasoning:"));
    }

    /// native 路由：计划里的 wire 优先，wire 缺失时退回档位本身（`off` 由适配器
    /// 序列化成 thinking.type=disabled）。
    #[test]
    fn ugs_patch_yaml_prefers_plan_wire_on_native_route() {
        let plan = parse_thinking_plan(Some(
            r#"{"channel":"dsh-deepseek-native","level":"off","wire":null,"efforts":{"off":null,"low":"low","high":"high","max":"max"}}"#,
        ))
        .expect("valid plan");
        let yaml = ugs_patch_yaml_with_plan(
            Some("deepseek-v4-pro"),
            None,
            None,
            None,
            Some(&plan),
        );
        assert!(yaml.contains("id: llm-deepseek"));
        assert!(yaml.contains(r#"reasoningEffort: "off""#));
    }

    #[test]
    fn yaml_scalar_escapes_control_chars() {
        assert_eq!(yaml_scalar("a\nb\tc"), r#""a\nb\tc""#);
        assert_eq!(yaml_scalar("say \"hi\""), r#""say \"hi\"""#);
        assert_eq!(yaml_scalar("a\\b"), r#""a\\b""#);
        // 单行普通值不受影响（与旧行为一致）。
        assert_eq!(
            yaml_scalar("https://api.deepseek.com"),
            r#""https://api.deepseek.com""#
        );
    }

    #[test]
    fn is_official_deepseek_matches_only_official_hosts() {
        assert!(is_official_deepseek("https://api.deepseek.com"));
        assert!(is_official_deepseek("https://api.deepseek.com/v1"));
        assert!(is_official_deepseek("http://api.deepseek.com:443/v1"));
        assert!(is_official_deepseek("https://cn.api.deepseek.com"));
        assert!(!is_official_deepseek("https://gateway.example.com/v1"));
        assert!(!is_official_deepseek("https://openrouter.ai/api/v1"));
        assert!(!is_official_deepseek(
            "https://api.deepseek.com.evil.com/v1"
        ));
    }

    #[test]
    fn progress_items_cover_tool_and_text() {
        // 确保 DshProgressItem 两种变体都可构造（编译期契约）。
        let _text = DshProgressItem::Text("hi".to_string());
        let _patch = DshProgressItem::Patch(serde_json::json!({"id": "x"}));
        // 未使用字段占位，防止编译器告警被误报。
        let _ = std::mem::discriminant(&_text);
        let _ = std::mem::discriminant(&_patch);
        assert_eq!(HashMap::<String, String>::new().len(), 0);
    }
}
