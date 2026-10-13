export const TASK_IDE_OPTIONS = [
  { id: "androidstudio", label: "Android Studio" },
  { id: "clion", label: "CLion" },
  { id: "cursor", label: "Cursor" },
  { id: "emacs", label: "Emacs" },
  { id: "goland", label: "GoLand" },
  { id: "intellij", label: "IntelliJ IDEA" },
  { id: "neovim", label: "Neovim" },
  { id: "nova", label: "Nova" },
  { id: "phpstorm", label: "PhpStorm" },
  { id: "pycharm", label: "PyCharm" },
  { id: "rider", label: "Rider" },
  { id: "rubymine", label: "RubyMine" },
  { id: "sublime", label: "Sublime Text" },
  { id: "vim", label: "Vim" },
  { id: "vscode", label: "Visual Studio Code" },
  { id: "vscodium", label: "VSCodium" },
  { id: "webstorm", label: "WebStorm" },
  { id: "windsurf", label: "Windsurf" },
  { id: "xcode", label: "Xcode" },
  { id: "zed", label: "Zed" },
  { id: "custom", label: "Custom" },
] as const;

export const TASK_TERMINAL_OPTIONS = [
  { id: "system", label: "System Terminal" },
  { id: "alacritty", label: "Alacritty" },
  { id: "ghostty", label: "Ghostty" },
  { id: "gnometerminal", label: "GNOME Terminal" },
  { id: "hyper", label: "Hyper" },
  { id: "iterm2", label: "iTerm2" },
  { id: "kitty", label: "Kitty" },
  { id: "konsole", label: "Konsole" },
  { id: "powershell", label: "PowerShell" },
  { id: "tabby", label: "Tabby" },
  { id: "terminal", label: "Terminal.app" },
  { id: "terminator", label: "Terminator" },
  { id: "tilix", label: "Tilix" },
  { id: "tmux", label: "tmux" },
  { id: "warp", label: "Warp" },
  { id: "wezterm", label: "WezTerm" },
  { id: "windowsterminal", label: "Windows Terminal" },
  { id: "zellij", label: "Zellij" },
  { id: "custom", label: "Custom" },
] as const;

export type TaskIDEId = (typeof TASK_IDE_OPTIONS)[number]["id"];
export type TaskTerminalId = (typeof TASK_TERMINAL_OPTIONS)[number]["id"];

export interface TaskDeveloperToolPreferences {
  preferredIDE: TaskIDEId;
  customIDEPath: string;
  preferredTerminal: TaskTerminalId;
  customTerminalPath: string;
}

export const TASK_DEVELOPER_TOOLS_STORAGE = "ugs.task.developer-tools.v1";
export const TASK_DEVELOPER_TOOLS_CHANGED = "ugs:task-developer-tools-changed";

const DEFAULTS: TaskDeveloperToolPreferences = {
  preferredIDE: "vscode",
  customIDEPath: "",
  preferredTerminal: "system",
  customTerminalPath: "",
};

const IDE_IDS = new Set<string>(TASK_IDE_OPTIONS.map((option) => option.id));
const TERMINAL_IDS = new Set<string>(
  TASK_TERMINAL_OPTIONS.map((option) => option.id),
);

export function loadTaskDeveloperToolPreferences(): TaskDeveloperToolPreferences {
  try {
    const raw = localStorage.getItem(TASK_DEVELOPER_TOOLS_STORAGE);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    return {
      preferredIDE:
        typeof parsed?.preferredIDE === "string" &&
        IDE_IDS.has(parsed.preferredIDE)
          ? (parsed.preferredIDE as TaskIDEId)
          : DEFAULTS.preferredIDE,
      customIDEPath:
        typeof parsed?.customIDEPath === "string"
          ? parsed.customIDEPath
          : DEFAULTS.customIDEPath,
      preferredTerminal:
        typeof parsed?.preferredTerminal === "string" &&
        TERMINAL_IDS.has(parsed.preferredTerminal)
          ? (parsed.preferredTerminal as TaskTerminalId)
          : DEFAULTS.preferredTerminal,
      customTerminalPath:
        typeof parsed?.customTerminalPath === "string"
          ? parsed.customTerminalPath
          : DEFAULTS.customTerminalPath,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTaskDeveloperToolPreferences(
  preferences: TaskDeveloperToolPreferences,
): void {
  localStorage.setItem(TASK_DEVELOPER_TOOLS_STORAGE, JSON.stringify(preferences));
  window.dispatchEvent(new Event(TASK_DEVELOPER_TOOLS_CHANGED));
}

export function subscribeTaskDeveloperToolPreferences(
  listener: (preferences: TaskDeveloperToolPreferences) => void,
): () => void {
  const refresh = () => listener(loadTaskDeveloperToolPreferences());
  window.addEventListener(TASK_DEVELOPER_TOOLS_CHANGED, refresh);
  window.addEventListener("storage", refresh);
  return () => {
    window.removeEventListener(TASK_DEVELOPER_TOOLS_CHANGED, refresh);
    window.removeEventListener("storage", refresh);
  };
}

export function taskIDELabel(id: TaskIDEId): string {
  return TASK_IDE_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

export function taskTerminalLabel(id: TaskTerminalId): string {
  return TASK_TERMINAL_OPTIONS.find((option) => option.id === id)?.label ?? id;
}
