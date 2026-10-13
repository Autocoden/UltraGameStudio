use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_DESCRIPTION_CHARS: usize = 8_000;
const MAX_TASKS_BYTES: u64 = 2 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
struct OpenSpecLaunch {
    program: PathBuf,
    prefix_args: Vec<String>,
    source: String,
    display_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecRuntimeStatus {
    available: bool,
    version: Option<String>,
    source: Option<String>,
    executable: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecCommandResult {
    success: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
    json: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpecPrepareResult {
    runtime: OpenSpecRuntimeStatus,
    initialized: bool,
    created: bool,
    status: OpenSpecCommandResult,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn bundled_script(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|root| {
            root.join("openspec")
                .join("node_modules")
                .join("@fission-ai")
                .join("openspec")
                .join("bin")
                .join("openspec.js")
        })
        .filter(|path| path.is_file())
}

fn development_script() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| {
            root.join("node_modules")
                .join("@fission-ai")
                .join("openspec")
                .join("bin")
                .join("openspec.js")
        })
        .filter(|path| path.is_file())
}

#[cfg(windows)]
fn node_compatible_path(path: &Path) -> PathBuf {
    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if let Some(rest) = encoded.strip_prefix(VERBATIM_UNC_PREFIX) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(rest);
        return PathBuf::from(OsString::from_wide(&normalized));
    }
    if let Some(rest) = encoded.strip_prefix(VERBATIM_PREFIX) {
        return PathBuf::from(OsString::from_wide(rest));
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn node_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn node_script_launch(script: PathBuf, source: &str) -> Option<OpenSpecLaunch> {
    let node = crate::cli_runtime::resolve_command_path("node")?;
    // Tauri returns resource paths in Windows' verbatim form (`\\?\D:\...`).
    // Node 24 resolves that form as the drive root (`D:`) when it is used as
    // the entry script, so pass the equivalent regular/UNC path to Node.
    let script = node_compatible_path(&script);
    Some(OpenSpecLaunch {
        display_path: script.to_string_lossy().to_string(),
        program: node,
        prefix_args: vec![script.to_string_lossy().to_string()],
        source: source.to_string(),
    })
}

fn command_launch(path: PathBuf) -> Option<OpenSpecLaunch> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let display_path = path.to_string_lossy().to_string();

    if extension == "js" || extension == "mjs" || extension == "cjs" {
        return node_script_launch(path, "path");
    }

    #[cfg(windows)]
    {
        if matches!(extension.as_str(), "cmd" | "bat" | "ps1") {
            let dir = path.parent()?;
            let node_modules = if dir.file_name().is_some_and(|name| name == ".bin") {
                dir.parent()?.to_path_buf()
            } else {
                dir.join("node_modules")
            };
            let script = node_modules
                .join("@fission-ai")
                .join("openspec")
                .join("bin")
                .join("openspec.js");
            // Task descriptions are arbitrary text; never pass them through a shell wrapper.
            if !script.is_file() {
                return None;
            }
            let mut launch = node_script_launch(script, "path")?;
            launch.display_path = display_path;
            return Some(launch);
        }
    }

    Some(OpenSpecLaunch {
        program: path,
        prefix_args: Vec::new(),
        source: "path".to_string(),
        display_path,
    })
}

fn resolve_launch(app: &AppHandle) -> Option<OpenSpecLaunch> {
    bundled_script(app)
        .and_then(|path| node_script_launch(path, "bundled"))
        .or_else(|| development_script().and_then(|path| node_script_launch(path, "development")))
        .or_else(|| crate::cli_runtime::resolve_command_path("openspec").and_then(command_launch))
}

fn parse_json_output(stdout: &str) -> Option<Value> {
    let trimmed = stdout.trim();
    serde_json::from_str(trimmed).ok().or_else(|| {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        (end >= start)
            .then(|| serde_json::from_str(&trimmed[start..=end]).ok())
            .flatten()
    })
}

fn read_output(path: &Path) -> String {
    let mut bytes = Vec::new();
    if let Ok(mut file) = std::fs::File::open(path) {
        let _ = file.read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn run_launch(
    launch: &OpenSpecLaunch,
    cwd: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<OpenSpecCommandResult, String> {
    let temp_id = format!(
        "ugs-openspec-{}-{}-{}",
        std::process::id(),
        now_ms(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let stdout_path = std::env::temp_dir().join(format!("{temp_id}.stdout"));
    let stderr_path = std::env::temp_dir().join(format!("{temp_id}.stderr"));
    let stdout_file = std::fs::File::create(&stdout_path)
        .map_err(|error| format!("创建 OpenSpec 输出缓存失败: {error}"))?;
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|error| format!("创建 OpenSpec 错误缓存失败: {error}"))?;

    let mut command = Command::new(&launch.program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .current_dir(cwd)
        .args(&launch.prefix_args)
        .args(args)
        .env("NO_COLOR", "1")
        .env("OPENSPEC_TELEMETRY", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 OpenSpec 失败: {error}"))?;
    let started = Instant::now();
    let mut timed_out = false;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let stdout = read_output(&stdout_path);
    let stderr = read_output(&stderr_path);
    let _ = std::fs::remove_file(stdout_path);
    let _ = std::fs::remove_file(stderr_path);
    let json = parse_json_output(&stdout);
    Ok(OpenSpecCommandResult {
        success,
        timed_out,
        stdout,
        stderr,
        json,
    })
}

fn workspace_root(root_path: &str) -> Result<PathBuf, String> {
    let value = root_path.trim();
    if value.is_empty() {
        return Err("OpenSpec 工作区路径为空".to_string());
    }
    let root = std::fs::canonicalize(value)
        .map_err(|error| format!("读取 OpenSpec 工作区失败: {error}"))?;
    if !root.is_dir() {
        return Err("OpenSpec 工作区不是文件夹".to_string());
    }
    Ok(root)
}

fn valid_change_id(value: &str) -> bool {
    let value = value.trim();
    value.len() >= 3
        && value.len() <= 120
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn valid_schema(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 80
        && !value.starts_with('-')
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn markdown_task_checkbox_offset(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut index = usize::from(bytes.starts_with(&[0xef, 0xbb, 0xbf])) * 3;
    while bytes
        .get(index)
        .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        index += 1;
    }
    if !matches!(bytes.get(index), Some(b'-' | b'*')) {
        return None;
    }
    index += 1;
    if !bytes
        .get(index)
        .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        return None;
    }
    while bytes
        .get(index)
        .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        index += 1;
    }
    if bytes.get(index) != Some(&b'[')
        || !bytes
            .get(index + 1)
            .is_some_and(|byte| matches!(*byte, b' ' | b'x' | b'X'))
        || bytes.get(index + 2) != Some(&b']')
        || !bytes
            .get(index + 3)
            .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
    {
        return None;
    }
    Some(index + 1)
}

fn set_markdown_task_status(
    markdown: &str,
    task_index: usize,
    completed: bool,
) -> Result<(String, String), String> {
    let mut offset = 0usize;
    let mut checkbox_index = 0usize;
    for line in markdown.split_inclusive('\n') {
        if let Some(marker_offset) = markdown_task_checkbox_offset(line) {
            if checkbox_index == task_index {
                let marker = offset + marker_offset;
                let title = line[marker_offset + 2..]
                    .trim_matches([' ', '\t', '\r', '\n'])
                    .to_string();
                let mut next = markdown.to_string();
                next.replace_range(marker..marker + 1, if completed { "x" } else { " " });
                return Ok((next, title));
            }
            checkbox_index += 1;
        }
        offset += line.len();
    }
    Err(format!(
        "OpenSpec tasks.md 中不存在第 {} 个复选任务",
        task_index + 1
    ))
}

fn runtime_status_blocking(app: &AppHandle) -> OpenSpecRuntimeStatus {
    let Some(launch) = resolve_launch(app) else {
        return OpenSpecRuntimeStatus {
            available: false,
            version: None,
            source: None,
            executable: None,
            message: Some(
                "未找到 OpenSpec。请安装 @fission-ai/openspec，或重新安装带 OpenSpec 运行时的 UGS。"
                    .to_string(),
            ),
        };
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match run_launch(
        &launch,
        &cwd,
        &["--version".to_string()],
        Duration::from_secs(15),
    ) {
        Ok(output) if output.success => OpenSpecRuntimeStatus {
            available: true,
            version: Some(output.stdout.trim().to_string()),
            source: Some(launch.source),
            executable: Some(launch.display_path),
            message: None,
        },
        Ok(output) => OpenSpecRuntimeStatus {
            available: false,
            version: None,
            source: Some(launch.source),
            executable: Some(launch.display_path),
            message: Some(if output.timed_out {
                "OpenSpec 版本检查超时".to_string()
            } else {
                let detail = output.stderr.trim();
                if detail.is_empty() {
                    "OpenSpec 版本检查失败".to_string()
                } else {
                    detail.to_string()
                }
            }),
        },
        Err(error) => OpenSpecRuntimeStatus {
            available: false,
            version: None,
            source: Some(launch.source),
            executable: Some(launch.display_path),
            message: Some(error),
        },
    }
}

fn require_launch(app: &AppHandle) -> Result<(OpenSpecLaunch, OpenSpecRuntimeStatus), String> {
    let runtime = runtime_status_blocking(app);
    if !runtime.available {
        return Err(runtime
            .message
            .clone()
            .unwrap_or_else(|| "OpenSpec 不可用".to_string()));
    }
    let launch = resolve_launch(app).ok_or_else(|| "OpenSpec 不可用".to_string())?;
    Ok((launch, runtime))
}

fn require_success(
    output: OpenSpecCommandResult,
    action: &str,
) -> Result<OpenSpecCommandResult, String> {
    if output.success {
        return Ok(output);
    }
    let detail = if output.timed_out {
        "执行超时".to_string()
    } else if !output.stderr.trim().is_empty() {
        output.stderr.trim().to_string()
    } else if !output.stdout.trim().is_empty() {
        output.stdout.trim().to_string()
    } else {
        "命令没有返回错误详情".to_string()
    };
    Err(format!("{action}失败: {detail}"))
}

#[tauri::command]
pub async fn openspec_runtime_status(app: AppHandle) -> Result<OpenSpecRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || runtime_status_blocking(&app))
        .await
        .map_err(|error| format!("OpenSpec 运行时检查失败: {error}"))
}

#[tauri::command]
pub async fn openspec_prepare_change(
    app: AppHandle,
    root_path: String,
    change_id: String,
    schema: String,
    description: String,
) -> Result<OpenSpecPrepareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_change_id(&change_id) {
            return Err("OpenSpec 变更 ID 必须由小写字母、数字和连字符组成".to_string());
        }
        if !valid_schema(&schema) {
            return Err("OpenSpec Schema 名称无效".to_string());
        }
        let root = workspace_root(&root_path)?;
        let (launch, runtime) = require_launch(&app)?;
        let mut initialized = false;
        if !root.join("openspec").join("config.yaml").is_file() {
            let output = run_launch(
                &launch,
                &root,
                &[
                    "init".to_string(),
                    ".".to_string(),
                    "--tools".to_string(),
                    "none".to_string(),
                    "--language".to_string(),
                    "zh-CN".to_string(),
                    "--force".to_string(),
                ],
                Duration::from_secs(90),
            )?;
            require_success(output, "初始化 OpenSpec")?;
            initialized = true;
        }

        let change_root = root.join("openspec").join("changes").join(&change_id);
        let mut created = false;
        if !change_root.join(".openspec.yaml").is_file() {
            let description = description
                .chars()
                .filter(|character| *character != '\0')
                .take(MAX_DESCRIPTION_CHARS)
                .collect::<String>();
            let output = run_launch(
                &launch,
                &root,
                &[
                    "new".to_string(),
                    "change".to_string(),
                    change_id.clone(),
                    "--description".to_string(),
                    description,
                    "--schema".to_string(),
                    schema,
                    "--json".to_string(),
                ],
                Duration::from_secs(45),
            )?;
            require_success(output, "创建 OpenSpec 变更")?;
            created = true;
        }

        let status = require_success(
            run_launch(
                &launch,
                &root,
                &[
                    "status".to_string(),
                    "--change".to_string(),
                    change_id,
                    "--json".to_string(),
                ],
                Duration::from_secs(30),
            )?,
            "读取 OpenSpec 状态",
        )?;
        Ok(OpenSpecPrepareResult {
            runtime,
            initialized,
            created,
            status,
        })
    })
    .await
    .map_err(|error| format!("OpenSpec 变更准备任务失败: {error}"))?
}

#[tauri::command]
pub async fn openspec_change_status(
    app: AppHandle,
    root_path: String,
    change_id: String,
) -> Result<OpenSpecCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_change_id(&change_id) {
            return Err("OpenSpec 变更 ID 无效".to_string());
        }
        let root = workspace_root(&root_path)?;
        let (launch, _) = require_launch(&app)?;
        require_success(
            run_launch(
                &launch,
                &root,
                &[
                    "status".to_string(),
                    "--change".to_string(),
                    change_id,
                    "--json".to_string(),
                ],
                Duration::from_secs(30),
            )?,
            "读取 OpenSpec 状态",
        )
    })
    .await
    .map_err(|error| format!("OpenSpec 状态任务失败: {error}"))?
}

#[tauri::command]
pub async fn openspec_validate_change(
    app: AppHandle,
    root_path: String,
    change_id: String,
) -> Result<OpenSpecCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_change_id(&change_id) {
            return Err("OpenSpec 变更 ID 无效".to_string());
        }
        let root = workspace_root(&root_path)?;
        let (launch, _) = require_launch(&app)?;
        run_launch(
            &launch,
            &root,
            &[
                "validate".to_string(),
                change_id,
                "--type".to_string(),
                "change".to_string(),
                "--strict".to_string(),
                "--json".to_string(),
                "--no-interactive".to_string(),
            ],
            Duration::from_secs(60),
        )
    })
    .await
    .map_err(|error| format!("OpenSpec 校验任务失败: {error}"))?
}

#[tauri::command]
pub async fn openspec_set_task_status(
    root_path: String,
    change_id: String,
    task_index: u32,
    completed: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_change_id(&change_id) {
            return Err("OpenSpec 变更 ID 无效".to_string());
        }
        let root = workspace_root(&root_path)?;
        let tasks_path = std::fs::canonicalize(
            root.join("openspec")
                .join("changes")
                .join(&change_id)
                .join("tasks.md"),
        )
        .map_err(|error| format!("读取 OpenSpec tasks.md 失败: {error}"))?;
        if !tasks_path.starts_with(&root) {
            return Err("OpenSpec tasks.md 位于工作区之外".to_string());
        }
        let metadata = std::fs::metadata(&tasks_path)
            .map_err(|error| format!("读取 OpenSpec tasks.md 元数据失败: {error}"))?;
        if metadata.len() > MAX_TASKS_BYTES {
            return Err("OpenSpec tasks.md 超过 2 MB，无法安全更新".to_string());
        }
        let markdown = std::fs::read_to_string(&tasks_path)
            .map_err(|error| format!("读取 OpenSpec tasks.md 失败: {error}"))?;
        let (next, title) = set_markdown_task_status(&markdown, task_index as usize, completed)?;
        if next != markdown {
            std::fs::write(&tasks_path, next)
                .map_err(|error| format!("更新 OpenSpec tasks.md 失败: {error}"))?;
        }
        Ok(title)
    })
    .await
    .map_err(|error| format!("OpenSpec 任务状态更新失败: {error}"))?
}

#[tauri::command]
pub async fn openspec_archive_change(
    app: AppHandle,
    root_path: String,
    change_id: String,
    force: Option<bool>,
    skip_specs: Option<bool>,
) -> Result<OpenSpecCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_change_id(&change_id) {
            return Err("OpenSpec 变更 ID 无效".to_string());
        }
        let root = workspace_root(&root_path)?;
        let (launch, _) = require_launch(&app)?;
        let mut args = vec![
            "archive".to_string(),
            change_id,
            "--yes".to_string(),
            "--json".to_string(),
        ];
        if skip_specs.unwrap_or(false) {
            args.push("--skip-specs".to_string());
        }
        if force.unwrap_or(false) {
            args.push("--no-validate".to_string());
        }
        run_launch(&launch, &root, &args, Duration::from_secs(90))
    })
    .await
    .map_err(|error| format!("OpenSpec 归档任务失败: {error}"))?
}

#[tauri::command]
pub async fn openspec_list_changes(
    app: AppHandle,
    root_path: String,
) -> Result<OpenSpecCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(&root_path)?;
        let (launch, _) = require_launch(&app)?;
        run_launch(
            &launch,
            &root,
            &[
                "list".to_string(),
                "--changes".to_string(),
                "--sort".to_string(),
                "recent".to_string(),
                "--json".to_string(),
            ],
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|error| format!("OpenSpec 变更列表读取失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn npm_shims_launch_node_with_literal_arguments() {
        let root = std::env::temp_dir().join(format!(
            "ugs-openspec-shims-{}-{}-{} 空格",
            std::process::id(),
            now_ms(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let node = crate::cli_runtime::resolve_command_path("node")
            .expect("the OpenSpec runtime tests require Node.js");
        let args = vec![
            "new".to_string(),
            "change".to_string(),
            "literal-args".to_string(),
            "--description".to_string(),
            "计划 \"quoted\" & | < > ^ %PATH% !value!\r\nsecond line \\".to_string(),
        ];
        for (name, extension, local) in [
            ("global", "CMD", false),
            ("local", "bat", true),
            ("powershell", "ps1", false),
        ] {
            let install = root.join(name);
            let node_modules = install.join("node_modules");
            let shim_dir = if local {
                node_modules.join(".bin")
            } else {
                install
            };
            let script = node_modules
                .join("@fission-ai")
                .join("openspec")
                .join("bin")
                .join("openspec.js");
            std::fs::create_dir_all(script.parent().unwrap()).unwrap();
            std::fs::create_dir_all(&shim_dir).unwrap();
            std::fs::write(
                &script,
                "console.log(process.argv[2] === '--version' ? '1.2.3' : JSON.stringify(process.argv.slice(2)));",
            )
            .unwrap();
            let shim = shim_dir.join(format!("openspec.{extension}"));
            std::fs::write(&shim, "this wrapper must never execute").unwrap();

            let launch = command_launch(shim.clone()).expect("supported npm layout");
            assert_eq!(launch.program, node);
            assert_eq!(launch.prefix_args, [script.to_string_lossy().to_string()]);
            assert_eq!(launch.source, "path");
            assert_eq!(launch.display_path, shim.to_string_lossy());
            let result = run_launch(&launch, &root, &args, Duration::from_secs(10)).unwrap();
            assert!(result.success, "{}", result.stderr);
            assert_eq!(result.json, Some(serde_json::json!(args)));
            let version = run_launch(
                &launch,
                &root,
                &["--version".to_string()],
                Duration::from_secs(10),
            )
            .unwrap();
            assert!(version.success, "{}", version.stderr);
            assert_eq!(version.stdout.trim(), "1.2.3");

            std::fs::remove_file(script).unwrap();
            assert!(
                command_launch(shim).is_none(),
                "unknown wrappers must fail closed"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn change_id_and_schema_validation_reject_option_injection() {
        assert!(valid_change_id("add-task-streaming"));
        assert!(!valid_change_id("--help"));
        assert!(!valid_change_id("Upper-Case"));
        assert!(!valid_change_id("change\n--all"));
        assert!(valid_schema("spec-driven"));
        assert!(!valid_schema("--schema"));
    }

    #[test]
    fn parse_json_output_accepts_clean_and_prefixed_json() {
        assert_eq!(
            parse_json_output("{\"isComplete\":true}")
                .and_then(|value| value["isComplete"].as_bool()),
            Some(true)
        );
        assert_eq!(
            parse_json_output("notice\n{\"isPlanningComplete\":false}\n")
                .and_then(|value| value["isPlanningComplete"].as_bool()),
            Some(false)
        );
    }

    #[cfg(windows)]
    #[test]
    fn node_compatible_path_removes_windows_verbatim_prefixes() {
        assert_eq!(
            node_compatible_path(Path::new(
                r"\\?\D:\Dev\UltraGameStudio\openspec\openspec.js"
            )),
            PathBuf::from(r"D:\Dev\UltraGameStudio\openspec\openspec.js")
        );
        assert_eq!(
            node_compatible_path(Path::new(r"\\?\UNC\server\share\openspec.js")),
            PathBuf::from(r"\\server\share\openspec.js")
        );
    }

    #[test]
    fn set_markdown_task_status_updates_only_the_requested_checkbox() {
        let markdown = "## Tasks\r\n\r\n- [ ] 1.1 First\r\n* [X] 1.2 Second\r\n";
        let (completed, title) = set_markdown_task_status(markdown, 0, true).unwrap();
        assert_eq!(title, "1.1 First");
        assert_eq!(
            completed,
            "## Tasks\r\n\r\n- [x] 1.1 First\r\n* [X] 1.2 Second\r\n"
        );
        let (pending, title) = set_markdown_task_status(&completed, 1, false).unwrap();
        assert_eq!(title, "1.2 Second");
        assert!(pending.contains("* [ ] 1.2 Second"));
        assert!(set_markdown_task_status(markdown, 2, true).is_err());
    }
}
