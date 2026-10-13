use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy)]
struct ToolInfo {
    id: &'static str,
    name: &'static str,
}

const IDE_TOOLS: &[ToolInfo] = &[
    ToolInfo {
        id: "androidstudio",
        name: "Android Studio",
    },
    ToolInfo {
        id: "clion",
        name: "CLion",
    },
    ToolInfo {
        id: "cursor",
        name: "Cursor",
    },
    ToolInfo {
        id: "emacs",
        name: "Emacs",
    },
    ToolInfo {
        id: "goland",
        name: "GoLand",
    },
    ToolInfo {
        id: "intellij",
        name: "IntelliJ IDEA",
    },
    ToolInfo {
        id: "neovim",
        name: "Neovim",
    },
    ToolInfo {
        id: "nova",
        name: "Nova",
    },
    ToolInfo {
        id: "phpstorm",
        name: "PhpStorm",
    },
    ToolInfo {
        id: "pycharm",
        name: "PyCharm",
    },
    ToolInfo {
        id: "rider",
        name: "Rider",
    },
    ToolInfo {
        id: "rubymine",
        name: "RubyMine",
    },
    ToolInfo {
        id: "sublime",
        name: "Sublime Text",
    },
    ToolInfo {
        id: "vim",
        name: "Vim",
    },
    ToolInfo {
        id: "vscode",
        name: "Visual Studio Code",
    },
    ToolInfo {
        id: "vscodium",
        name: "VSCodium",
    },
    ToolInfo {
        id: "webstorm",
        name: "WebStorm",
    },
    ToolInfo {
        id: "windsurf",
        name: "Windsurf",
    },
    ToolInfo {
        id: "xcode",
        name: "Xcode",
    },
    ToolInfo {
        id: "zed",
        name: "Zed",
    },
];

const TERMINAL_TOOLS: &[ToolInfo] = &[
    ToolInfo {
        id: "system",
        name: "System Terminal",
    },
    ToolInfo {
        id: "alacritty",
        name: "Alacritty",
    },
    ToolInfo {
        id: "ghostty",
        name: "Ghostty",
    },
    ToolInfo {
        id: "gnometerminal",
        name: "GNOME Terminal",
    },
    ToolInfo {
        id: "hyper",
        name: "Hyper",
    },
    ToolInfo {
        id: "iterm2",
        name: "iTerm2",
    },
    ToolInfo {
        id: "kitty",
        name: "Kitty",
    },
    ToolInfo {
        id: "konsole",
        name: "Konsole",
    },
    ToolInfo {
        id: "powershell",
        name: "PowerShell",
    },
    ToolInfo {
        id: "tabby",
        name: "Tabby",
    },
    ToolInfo {
        id: "terminal",
        name: "Terminal.app",
    },
    ToolInfo {
        id: "terminator",
        name: "Terminator",
    },
    ToolInfo {
        id: "tilix",
        name: "Tilix",
    },
    ToolInfo {
        id: "tmux",
        name: "tmux",
    },
    ToolInfo {
        id: "warp",
        name: "Warp",
    },
    ToolInfo {
        id: "wezterm",
        name: "WezTerm",
    },
    ToolInfo {
        id: "windowsterminal",
        name: "Windows Terminal",
    },
    ToolInfo {
        id: "zellij",
        name: "Zellij",
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTaskDeveloperTool {
    id: String,
    name: String,
    path: String,
    installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTaskDeveloperTools {
    ides: Vec<DetectedTaskDeveloperTool>,
    terminals: Vec<DetectedTaskDeveloperTool>,
}

fn require_workspace_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径为空".to_string());
    }
    let directory = PathBuf::from(trimmed);
    let metadata = std::fs::metadata(&directory).map_err(|e| format!("读取工作区目录失败：{e}"))?;
    if !metadata.is_dir() {
        return Err("工作区路径不是目录".to_string());
    }
    Ok(directory)
}

fn prepare_background_command(command: &mut Command) {
    if let Some(path) = crate::cli_runtime::augmented_path_var() {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn spawn_ide(mut command: Command, label: &str) -> Result<(), String> {
    prepare_background_command(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
        .spawn()
        .map_err(|error| format!("未能启动编辑器“{label}”：{error}"))?;
    Ok(())
}

fn spawn_terminal(mut command: Command, label: &str) -> Result<(), String> {
    prepare_background_command(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The desktop process has no console. Explicitly allocate one for
        // console-based terminals instead of inheriting CREATE_NO_WINDOW.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    command
        .spawn()
        .map_err(|error| format!("未能启动终端“{label}”：{error}"))?;
    Ok(())
}

fn tool_info<'a>(tools: &'a [ToolInfo], id: &str) -> Option<&'a ToolInfo> {
    tools.iter().find(|tool| tool.id == id)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn env_path(variable: &str, segments: &[&str]) -> Option<PathBuf> {
    let mut path = PathBuf::from(std::env::var_os(variable)?);
    for segment in segments {
        path.push(segment);
    }
    Some(path)
}

fn find_command_on_path(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return command_path.exists().then(|| command_path.to_path_buf());
    }

    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let direct = directory.join(command);
        if direct.is_file() {
            return Some(direct);
        }
        #[cfg(windows)]
        if direct.extension().is_none() {
            for extension in ["exe", "cmd", "bat", "com"] {
                let candidate = directory.join(format!("{command}.{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn installed_candidate(paths: Vec<PathBuf>, command: Option<&str>) -> Option<PathBuf> {
    paths
        .into_iter()
        .find(|path| path.is_file() || path.is_dir())
        .or_else(|| command.and_then(find_command_on_path))
}

#[cfg(windows)]
fn scan_product_directories(root: PathBuf, prefixes: &[&str], suffix: &[&str]) -> Vec<PathBuf> {
    let mut matches = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return matches;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !prefixes
            .iter()
            .any(|prefix| name.starts_with(&prefix.to_ascii_lowercase()))
        {
            continue;
        }
        let mut path = entry.path();
        for segment in suffix {
            path.push(segment);
        }
        matches.push(path);
    }
    matches
}

#[cfg(windows)]
fn windows_jetbrains_paths(prefix: &str, executable: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = env_path(variable, &["JetBrains"]) {
            paths.extend(scan_product_directories(
                root,
                &[prefix],
                &["bin", executable],
            ));
        }
    }
    paths
}

#[cfg(windows)]
fn known_ide_paths(id: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut add = |variable: &str, segments: &[&str]| {
        if let Some(path) = env_path(variable, segments) {
            paths.push(path);
        }
    };
    match id {
        "androidstudio" => add(
            "ProgramFiles",
            &["Android", "Android Studio", "bin", "studio64.exe"],
        ),
        "clion" => paths.extend(windows_jetbrains_paths("CLion", "clion64.exe")),
        "cursor" => {
            add("LOCALAPPDATA", &["Programs", "cursor", "Cursor.exe"]);
            add("ProgramFiles", &["Cursor", "Cursor.exe"]);
        }
        "goland" => paths.extend(windows_jetbrains_paths("GoLand", "goland64.exe")),
        "intellij" => paths.extend(windows_jetbrains_paths("IntelliJ IDEA", "idea64.exe")),
        "neovim" => add("ProgramFiles", &["Neovim", "bin", "nvim.exe"]),
        "phpstorm" => paths.extend(windows_jetbrains_paths("PhpStorm", "phpstorm64.exe")),
        "pycharm" => paths.extend(windows_jetbrains_paths("PyCharm", "pycharm64.exe")),
        "rider" => paths.extend(windows_jetbrains_paths("JetBrains Rider", "rider64.exe")),
        "rubymine" => paths.extend(windows_jetbrains_paths("RubyMine", "rubymine64.exe")),
        "sublime" => {
            add("ProgramFiles", &["Sublime Text", "sublime_text.exe"]);
            add("ProgramFiles(x86)", &["Sublime Text", "sublime_text.exe"]);
        }
        "vscode" => {
            add(
                "LOCALAPPDATA",
                &["Programs", "Microsoft VS Code", "Code.exe"],
            );
            add("ProgramFiles", &["Microsoft VS Code", "Code.exe"]);
            add("ProgramFiles(x86)", &["Microsoft VS Code", "Code.exe"]);
        }
        "vscodium" => {
            add("LOCALAPPDATA", &["Programs", "VSCodium", "VSCodium.exe"]);
            add("ProgramFiles", &["VSCodium", "VSCodium.exe"]);
        }
        "webstorm" => paths.extend(windows_jetbrains_paths("WebStorm", "webstorm64.exe")),
        "windsurf" => {
            add("LOCALAPPDATA", &["Programs", "Windsurf", "Windsurf.exe"]);
            add("ProgramFiles", &["Windsurf", "Windsurf.exe"]);
        }
        "zed" => add("LOCALAPPDATA", &["Programs", "Zed", "Zed.exe"]),
        _ => {}
    }
    paths
}

#[cfg(target_os = "macos")]
fn known_ide_paths(id: &str) -> Vec<PathBuf> {
    let app = match id {
        "androidstudio" => "Android Studio.app",
        "clion" => "CLion.app",
        "cursor" => "Cursor.app",
        "emacs" => "Emacs.app",
        "goland" => "GoLand.app",
        "intellij" => "IntelliJ IDEA.app",
        "neovim" => "Neovim.app",
        "nova" => "Nova.app",
        "phpstorm" => "PhpStorm.app",
        "pycharm" => "PyCharm.app",
        "rider" => "Rider.app",
        "rubymine" => "RubyMine.app",
        "sublime" => "Sublime Text.app",
        "vscode" => "Visual Studio Code.app",
        "vscodium" => "VSCodium.app",
        "webstorm" => "WebStorm.app",
        "windsurf" => "Windsurf.app",
        "xcode" => "Xcode.app",
        "zed" => "Zed.app",
        _ => return Vec::new(),
    };
    vec![PathBuf::from("/Applications").join(app)]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn known_ide_paths(id: &str) -> Vec<PathBuf> {
    match id {
        "cursor" => vec![PathBuf::from("/opt/Cursor/cursor")],
        "windsurf" => vec![PathBuf::from("/opt/Windsurf/windsurf")],
        _ => Vec::new(),
    }
}

#[cfg(windows)]
fn ide_command(id: &str) -> Option<&'static str> {
    match id {
        "androidstudio" => Some("studio64.exe"),
        "clion" => Some("clion64.exe"),
        "cursor" => Some("cursor"),
        "emacs" => Some("emacs.exe"),
        "goland" => Some("goland64.exe"),
        "intellij" => Some("idea64.exe"),
        "neovim" => Some("nvim.exe"),
        "phpstorm" => Some("phpstorm64.exe"),
        "pycharm" => Some("pycharm64.exe"),
        "rider" => Some("rider64.exe"),
        "rubymine" => Some("rubymine64.exe"),
        "sublime" => Some("subl.exe"),
        "vim" => Some("vim.exe"),
        "vscode" => Some("code"),
        "vscodium" => Some("codium"),
        "webstorm" => Some("webstorm64.exe"),
        "windsurf" => Some("windsurf"),
        "zed" => Some("zed.exe"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn ide_command(id: &str) -> Option<&'static str> {
    match id {
        "androidstudio" => Some("studio"),
        "clion" => Some("clion"),
        "cursor" => Some("cursor"),
        "emacs" => Some("emacs"),
        "goland" => Some("goland"),
        "intellij" => Some("idea"),
        "neovim" => Some("nvim"),
        "nova" => Some("nova"),
        "phpstorm" => Some("phpstorm"),
        "pycharm" => Some("pycharm"),
        "rider" => Some("rider"),
        "rubymine" => Some("rubymine"),
        "sublime" => Some("subl"),
        "vim" => Some("vim"),
        "vscode" => Some("code"),
        "vscodium" => Some("codium"),
        "webstorm" => Some("webstorm"),
        "windsurf" => Some("windsurf"),
        "xcode" => Some("xed"),
        "zed" => Some("zed"),
        _ => None,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn ide_command(id: &str) -> Option<&'static str> {
    match id {
        "androidstudio" => Some("studio"),
        "clion" => Some("clion"),
        "cursor" => Some("cursor"),
        "emacs" => Some("emacs"),
        "goland" => Some("goland"),
        "intellij" => Some("idea"),
        "neovim" => Some("nvim"),
        "phpstorm" => Some("phpstorm"),
        "pycharm" => Some("pycharm"),
        "rider" => Some("rider"),
        "rubymine" => Some("rubymine"),
        "sublime" => Some("subl"),
        "vim" => Some("vim"),
        "vscode" => Some("code"),
        "vscodium" => Some("codium"),
        "webstorm" => Some("webstorm"),
        "windsurf" => Some("windsurf"),
        "zed" => Some("zed"),
        _ => None,
    }
}

#[cfg(windows)]
fn known_terminal_paths(id: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut add = |variable: &str, segments: &[&str]| {
        if let Some(path) = env_path(variable, segments) {
            paths.push(path);
        }
    };
    match id {
        "windowsterminal" => add("LOCALAPPDATA", &["Microsoft", "WindowsApps", "wt.exe"]),
        "powershell" => add(
            "SystemRoot",
            &["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
        ),
        "alacritty" => {
            add("ProgramFiles", &["Alacritty", "alacritty.exe"]);
            if let Some(home) = home_dir() {
                paths.push(home.join("scoop/apps/alacritty/current/alacritty.exe"));
            }
        }
        "hyper" => add("LOCALAPPDATA", &["Programs", "Hyper", "Hyper.exe"]),
        "tabby" => add("LOCALAPPDATA", &["Programs", "Tabby", "Tabby.exe"]),
        "wezterm" => add("ProgramFiles", &["WezTerm", "wezterm-gui.exe"]),
        _ => {}
    }
    paths
}

#[cfg(target_os = "macos")]
fn known_terminal_paths(id: &str) -> Vec<PathBuf> {
    let app = match id {
        "system" | "terminal" => "Terminal.app",
        "alacritty" => "Alacritty.app",
        "ghostty" => "Ghostty.app",
        "hyper" => "Hyper.app",
        "iterm2" => "iTerm.app",
        "kitty" => "kitty.app",
        "tabby" => "Tabby.app",
        "warp" => "Warp.app",
        "wezterm" => "WezTerm.app",
        _ => return Vec::new(),
    };
    vec![PathBuf::from("/Applications").join(app)]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn known_terminal_paths(_id: &str) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(windows)]
fn terminal_command(id: &str) -> Option<&'static str> {
    match id {
        "system" => Some("cmd.exe"),
        "alacritty" => Some("alacritty.exe"),
        "hyper" => Some("hyper.exe"),
        "powershell" => Some("powershell.exe"),
        "tabby" => Some("Tabby.exe"),
        "wezterm" => Some("wezterm-gui.exe"),
        "windowsterminal" => Some("wt.exe"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn terminal_command(id: &str) -> Option<&'static str> {
    match id {
        "system" | "terminal" => Some("open"),
        "alacritty" => Some("alacritty"),
        "ghostty" => Some("ghostty"),
        "hyper" => Some("hyper"),
        "iterm2" => Some("open"),
        "kitty" => Some("kitty"),
        "powershell" => Some("pwsh"),
        "tabby" => Some("tabby"),
        "tmux" => Some("tmux"),
        "warp" => Some("open"),
        "wezterm" => Some("wezterm"),
        "zellij" => Some("zellij"),
        _ => None,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn terminal_command(id: &str) -> Option<&'static str> {
    match id {
        "system" => Some("x-terminal-emulator"),
        "alacritty" => Some("alacritty"),
        "ghostty" => Some("ghostty"),
        "gnometerminal" => Some("gnome-terminal"),
        "hyper" => Some("hyper"),
        "kitty" => Some("kitty"),
        "konsole" => Some("konsole"),
        "powershell" => Some("pwsh"),
        "tabby" => Some("tabby"),
        "terminator" => Some("terminator"),
        "tilix" => Some("tilix"),
        "tmux" => Some("tmux"),
        "warp" => Some("warp-terminal"),
        "wezterm" => Some("wezterm"),
        "zellij" => Some("zellij"),
        _ => None,
    }
}

fn detected_tool(info: ToolInfo, path: PathBuf) -> DetectedTaskDeveloperTool {
    DetectedTaskDeveloperTool {
        id: info.id.to_string(),
        name: info.name.to_string(),
        path: path.to_string_lossy().into_owned(),
        installed: true,
    }
}

fn detect_tools_blocking() -> DetectedTaskDeveloperTools {
    let ides = IDE_TOOLS
        .iter()
        .filter_map(|info| {
            installed_candidate(known_ide_paths(info.id), ide_command(info.id))
                .map(|path| detected_tool(*info, path))
        })
        .collect();

    let mut terminals = vec![detected_tool(
        TERMINAL_TOOLS[0],
        PathBuf::from(terminal_command("system").unwrap_or("system")),
    )];
    terminals.extend(TERMINAL_TOOLS.iter().skip(1).filter_map(|info| {
        installed_candidate(known_terminal_paths(info.id), terminal_command(info.id))
            .map(|path| detected_tool(*info, path))
    }));

    DetectedTaskDeveloperTools { ides, terminals }
}

#[tauri::command]
pub async fn task_detect_developer_tools() -> Result<DetectedTaskDeveloperTools, String> {
    tauri::async_runtime::spawn_blocking(detect_tools_blocking)
        .await
        .map_err(|error| format!("检测开发工具失败：{error}"))
}

fn custom_executable(path: Option<String>, kind: &str) -> Result<PathBuf, String> {
    let raw = path.unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("请先在设置中选择自定义{kind}可执行文件"));
    }
    let executable = PathBuf::from(trimmed);
    if !executable.is_absolute() {
        return Err(format!("自定义{kind}路径必须是绝对路径"));
    }
    if !executable.is_file() {
        return Err(format!(
            "自定义{kind}可执行文件不存在：{}",
            executable.display()
        ));
    }
    Ok(executable)
}

fn normalized_id(value: Option<String>, fallback: &str) -> String {
    let normalized = value
        .unwrap_or_else(|| fallback.to_string())
        .trim()
        .to_ascii_lowercase();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

fn open_workspace_in_ide_blocking(
    path: String,
    editor: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    let directory = require_workspace_directory(&path)?;
    let editor = normalized_id(editor, "vscode");

    if editor == "custom" {
        let executable = custom_executable(custom_path, " IDE ")?;
        let mut command = Command::new(executable);
        command.current_dir(&directory).arg(&directory);
        return spawn_ide(command, "Custom");
    }

    let info = tool_info(IDE_TOOLS, &editor).ok_or_else(|| format!("未知 IDE：{editor}"))?;
    let installed = installed_candidate(known_ide_paths(&editor), ide_command(&editor));

    #[cfg(target_os = "macos")]
    if let Some(app) = installed.as_ref().filter(|path| path.is_dir()) {
        let mut command = Command::new("open");
        command.arg("-a").arg(app).arg(&directory);
        return spawn_ide(command, info.name);
    }

    let program: OsString = installed
        .map(PathBuf::into_os_string)
        .or_else(|| ide_command(&editor).map(OsString::from))
        .ok_or_else(|| format!("IDE“{}”不支持当前系统", info.name))?;
    let mut command = Command::new(program);
    command.current_dir(&directory).arg(&directory);
    spawn_ide(command, info.name)
}

#[tauri::command]
pub async fn open_workspace_in_ide(
    path: String,
    editor: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace_in_ide_blocking(path, editor, custom_path)
    })
    .await
    .map_err(|error| format!("打开任务编辑器任务失败：{error}"))?
}

#[cfg(windows)]
fn build_terminal_command(id: &str, directory: &Path) -> Result<Command, String> {
    let program = installed_candidate(known_terminal_paths(id), terminal_command(id))
        .map(PathBuf::into_os_string)
        .or_else(|| terminal_command(id).map(OsString::from))
        .ok_or_else(|| format!("终端不支持当前系统：{id}"))?;
    let mut command = Command::new(program);
    command.current_dir(directory);
    match id {
        "system" => {
            command.arg("/K");
        }
        "windowsterminal" => {
            command.arg("-d").arg(directory);
        }
        "powershell" => {
            command.arg("-NoExit");
        }
        "alacritty" => {
            command.arg("--working-directory").arg(directory);
        }
        "wezterm" => {
            command.arg("start").arg("--cwd").arg(directory);
        }
        "hyper" | "tabby" => {
            command.arg(directory);
        }
        _ => return Err(format!("终端不支持当前系统：{id}")),
    }
    Ok(command)
}

#[cfg(target_os = "macos")]
fn build_terminal_command(id: &str, directory: &Path) -> Result<Command, String> {
    let mut command = match id {
        "system" | "terminal" => {
            let mut command = Command::new("open");
            command.arg("-a").arg("Terminal").arg(directory);
            command
        }
        "iterm2" => {
            let mut command = Command::new("open");
            command.arg("-a").arg("iTerm").arg(directory);
            command
        }
        "warp" => {
            let mut command = Command::new("open");
            command.arg("-a").arg("Warp").arg(directory);
            command
        }
        "alacritty" | "ghostty" | "hyper" | "kitty" | "tabby" | "wezterm" => {
            let app = tool_info(TERMINAL_TOOLS, id)
                .map(|tool| tool.name)
                .unwrap_or(id);
            let mut command = Command::new("open");
            command.arg("-a").arg(app).arg(directory);
            command
        }
        "powershell" | "tmux" | "zellij" => {
            let program =
                terminal_command(id).ok_or_else(|| format!("终端不支持当前系统：{id}"))?;
            let mut command = Command::new(program);
            command.current_dir(directory);
            command
        }
        _ => return Err(format!("终端不支持当前系统：{id}")),
    };
    command.current_dir(directory);
    Ok(command)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn build_terminal_command(id: &str, directory: &Path) -> Result<Command, String> {
    let program = terminal_command(id).ok_or_else(|| format!("终端不支持当前系统：{id}"))?;
    let mut command = Command::new(program);
    command.current_dir(directory);
    match id {
        "system" => {}
        "gnometerminal" | "terminator" | "tilix" => {
            command.arg(format!("--working-directory={}", directory.display()));
        }
        "konsole" => {
            command.arg("--workdir").arg(directory);
        }
        "alacritty" => {
            command.arg("--working-directory").arg(directory);
        }
        "kitty" => {
            command.arg("--directory").arg(directory);
        }
        "wezterm" => {
            command.arg("start").arg("--cwd").arg(directory);
        }
        "ghostty" => {
            command.arg(format!("--working-directory={}", directory.display()));
        }
        "hyper" | "tabby" | "warp" => {
            command.arg(directory);
        }
        "powershell" | "tmux" | "zellij" => {}
        _ => return Err(format!("终端不支持当前系统：{id}")),
    }
    Ok(command)
}

fn open_workspace_in_terminal_blocking(
    path: String,
    terminal: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    let directory = require_workspace_directory(&path)?;
    let terminal = normalized_id(terminal, "system");

    if terminal == "custom" {
        let executable = custom_executable(custom_path, "终端")?;
        let mut command = Command::new(executable);
        command.current_dir(&directory).arg(&directory);
        return spawn_terminal(command, "Custom");
    }

    let info =
        tool_info(TERMINAL_TOOLS, &terminal).ok_or_else(|| format!("未知终端：{terminal}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    if terminal == "system" {
        let mut last_error = None;
        for (program, args) in [
            ("x-terminal-emulator", vec![]),
            (
                "gnome-terminal",
                vec![format!("--working-directory={}", directory.display())],
            ),
            (
                "konsole",
                vec![
                    "--workdir".to_string(),
                    directory.to_string_lossy().into_owned(),
                ],
            ),
            (
                "xfce4-terminal",
                vec![format!("--working-directory={}", directory.display())],
            ),
        ] {
            let mut command = Command::new(program);
            command.current_dir(&directory).args(args);
            match spawn_terminal(command, info.name) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
        }
        return Err(last_error.unwrap_or_else(|| "没有可用终端".to_string()));
    }

    spawn_terminal(build_terminal_command(&terminal, &directory)?, info.name)
}

#[tauri::command]
pub async fn open_workspace_in_terminal(
    path: String,
    terminal: Option<String>,
    custom_path: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_workspace_in_terminal_blocking(path, terminal, custom_path)
    })
    .await
    .map_err(|error| format!("打开任务终端任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn developer_tool_ids_are_unique_and_cover_the_settings_contract() {
        let ide_ids = IDE_TOOLS.iter().map(|tool| tool.id).collect::<Vec<_>>();
        let terminal_ids = TERMINAL_TOOLS
            .iter()
            .map(|tool| tool.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ide_ids.len(),
            ide_ids.iter().copied().collect::<HashSet<_>>().len()
        );
        assert_eq!(
            terminal_ids.len(),
            terminal_ids.iter().copied().collect::<HashSet<_>>().len()
        );
        assert_eq!(
            ide_ids,
            vec![
                "androidstudio",
                "clion",
                "cursor",
                "emacs",
                "goland",
                "intellij",
                "neovim",
                "nova",
                "phpstorm",
                "pycharm",
                "rider",
                "rubymine",
                "sublime",
                "vim",
                "vscode",
                "vscodium",
                "webstorm",
                "windsurf",
                "xcode",
                "zed",
            ]
        );
        assert_eq!(
            terminal_ids,
            vec![
                "system",
                "alacritty",
                "ghostty",
                "gnometerminal",
                "hyper",
                "iterm2",
                "kitty",
                "konsole",
                "powershell",
                "tabby",
                "terminal",
                "terminator",
                "tilix",
                "tmux",
                "warp",
                "wezterm",
                "windowsterminal",
                "zellij",
            ]
        );
    }

    #[test]
    fn custom_executables_require_an_absolute_existing_file() {
        assert!(custom_executable(None, " IDE ").is_err());
        assert!(custom_executable(Some("relative/editor.exe".to_string()), " IDE ").is_err());
    }

    #[test]
    fn unknown_tools_are_rejected_before_launch() {
        assert!(tool_info(IDE_TOOLS, "unknown").is_none());
        assert!(tool_info(TERMINAL_TOOLS, "unknown").is_none());
    }
}
