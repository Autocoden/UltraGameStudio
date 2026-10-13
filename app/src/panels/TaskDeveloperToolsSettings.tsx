import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  Check,
  Code2,
  FileSearch,
  Loader2,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import type { Locale } from '@/lib/i18n';
import {
  TASK_IDE_OPTIONS,
  TASK_TERMINAL_OPTIONS,
  loadTaskDeveloperToolPreferences,
  saveTaskDeveloperToolPreferences,
  subscribeTaskDeveloperToolPreferences,
  type TaskDeveloperToolPreferences,
  type TaskIDEId,
  type TaskTerminalId,
} from '@/lib/taskDeveloperTools';
import {
  detectTaskDeveloperTools,
  tauriAvailable,
  type DetectedTaskDeveloperTool,
  type DetectedTaskDeveloperTools,
} from '@/lib/tauri';

type ToolOption<T extends string> = {
  id: T;
  label: string;
  detected: boolean;
};

function orderedOptions<T extends string>(
  options: readonly { id: T; label: string }[],
  detected: DetectedTaskDeveloperTool[] | undefined,
): ToolOption<T>[] {
  const known = new Map(options.map((option) => [option.id, option]));
  const detectedIds = new Set<T>();
  const result: ToolOption<T>[] = [];

  for (const tool of detected ?? []) {
    const option = known.get(tool.id as T);
    if (!option || option.id === 'custom' || detectedIds.has(option.id)) continue;
    detectedIds.add(option.id);
    result.push({ id: option.id, label: tool.name || option.label, detected: true });
  }

  for (const option of options) {
    if (option.id === 'custom' || detectedIds.has(option.id)) continue;
    result.push({ ...option, detected: false });
  }

  const custom = options.find((option) => option.id === 'custom');
  if (custom) result.push({ ...custom, detected: false });
  return result;
}

function copy(locale: Locale) {
  const zh = locale === 'zh-CN';
  return zh
    ? {
        title: '开发工具',
        description: '配置用于打开任务 Worktree 的首选 IDE 和终端。',
        detectAgain: '重新检测',
        detecting: '正在检测…',
        desktopOnly: '自动检测与路径选择仅在桌面版中可用。',
        preferredIDE: '首选 IDE',
        ideDescription: '验收任务时，Worktree 将在这个编辑器中打开。',
        preferredTerminal: '首选终端',
        terminalDescription: '验收任务时，终端会在 Worktree 目录中启动。',
        customPath: '自定义可执行文件路径',
        idePlaceholder: '请选择 IDE…',
        terminalPlaceholder: '请选择终端…',
        idePathPlaceholder: '例如 C:\\Tools\\Editor\\editor.exe',
        terminalPathPlaceholder: '例如 C:\\Tools\\Terminal\\terminal.exe',
        browse: '选择可执行文件',
        detected: '在此电脑上检测到',
        noAdditionalTools: '没有检测到其他开发工具',
      }
    : {
        title: 'Developer Tools',
        description: 'Configure the preferred IDE and terminal used to open task worktrees.',
        detectAgain: 'Detect Again',
        detecting: 'Detecting…',
        desktopOnly: 'Automatic detection and path selection are available in the desktop app.',
        preferredIDE: 'Preferred IDE',
        ideDescription: 'Task worktrees open in this editor during review.',
        preferredTerminal: 'Preferred Terminal',
        terminalDescription: 'Terminals start in the task worktree directory.',
        customPath: 'Custom executable path',
        idePlaceholder: 'Select IDE…',
        terminalPlaceholder: 'Select terminal…',
        idePathPlaceholder: '/path/to/your/editor',
        terminalPathPlaceholder: '/path/to/your/terminal',
        browse: 'Choose executable',
        detected: 'Detected on this computer',
        noAdditionalTools: 'No additional developer tools detected',
      };
}

export default function TaskDeveloperToolsSettings({ locale }: { locale: Locale }) {
  const text = copy(locale);
  const desktop = tauriAvailable();
  const [preferences, setPreferences] = useState<TaskDeveloperToolPreferences>(
    loadTaskDeveloperToolPreferences,
  );
  const [detectedTools, setDetectedTools] =
    useState<DetectedTaskDeveloperTools | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState('');

  useEffect(
    () => subscribeTaskDeveloperToolPreferences(setPreferences),
    [],
  );

  const detectTools = useCallback(async () => {
    if (!desktop) return;
    setDetecting(true);
    setDetectError('');
    try {
      setDetectedTools(await detectTaskDeveloperTools());
    } catch (reason) {
      setDetectError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDetecting(false);
    }
  }, [desktop]);

  useEffect(() => {
    void detectTools();
  }, [detectTools]);

  const ideOptions = useMemo(
    () => orderedOptions(TASK_IDE_OPTIONS, detectedTools?.ides),
    [detectedTools?.ides],
  );
  const terminalOptions = useMemo(
    () => orderedOptions(TASK_TERMINAL_OPTIONS, detectedTools?.terminals),
    [detectedTools?.terminals],
  );

  const persist = (patch: Partial<TaskDeveloperToolPreferences>) => {
    // Read the persisted snapshot so two controls changed in one browser turn
    // cannot overwrite each other with a stale render closure.
    const next = { ...loadTaskDeveloperToolPreferences(), ...patch };
    setPreferences(next);
    saveTaskDeveloperToolPreferences(next);
  };

  const chooseExecutable = async (target: 'ide' | 'terminal') => {
    if (!desktop) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      title: text.browse,
      directory: false,
      multiple: false,
    });
    if (typeof picked !== 'string' || !picked.trim()) return;
    persist(
      target === 'ide'
        ? { customIDEPath: picked }
        : { customTerminalPath: picked },
    );
  };

  const detectedNames = [
    ...(detectedTools?.ides ?? []),
    ...(detectedTools?.terminals ?? []).filter((tool) => tool.id !== 'system'),
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-fg">{text.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {text.description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void detectTools()}
          disabled={!desktop || detecting}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-xs font-medium text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
        >
          {detecting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {detecting ? text.detecting : text.detectAgain}
        </button>
      </div>

      {!desktop && (
        <p className="rounded-md border border-border bg-panel-2/60 px-3 py-2 text-xs text-fg-faint">
          {text.desktopOnly}
        </p>
      )}
      {detectError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-all">{detectError}</span>
        </p>
      )}

      <ToolSelector
        icon={<Code2 size={15} />}
        label={text.preferredIDE}
        description={text.ideDescription}
        selectId="preferred-task-ide"
        value={preferences.preferredIDE}
        placeholder={text.idePlaceholder}
        options={ideOptions}
        onChange={(preferredIDE) =>
          persist({
            preferredIDE,
            ...(preferredIDE === 'custom' ? {} : { customIDEPath: '' }),
          })
        }
      >
        {preferences.preferredIDE === 'custom' && (
          <CustomPathField
            id="custom-task-ide-path"
            label={text.customPath}
            value={preferences.customIDEPath}
            placeholder={text.idePathPlaceholder}
            browseLabel={text.browse}
            browseDisabled={!desktop}
            onChange={(customIDEPath) => persist({ customIDEPath })}
            onBrowse={() => void chooseExecutable('ide')}
          />
        )}
      </ToolSelector>

      <ToolSelector
        icon={<Terminal size={15} />}
        label={text.preferredTerminal}
        description={text.terminalDescription}
        selectId="preferred-task-terminal"
        value={preferences.preferredTerminal}
        placeholder={text.terminalPlaceholder}
        options={terminalOptions}
        onChange={(preferredTerminal) =>
          persist({
            preferredTerminal,
            ...(preferredTerminal === 'custom'
              ? {}
              : { customTerminalPath: '' }),
          })
        }
      >
        {preferences.preferredTerminal === 'custom' && (
          <CustomPathField
            id="custom-task-terminal-path"
            label={text.customPath}
            value={preferences.customTerminalPath}
            placeholder={text.terminalPathPlaceholder}
            browseLabel={text.browse}
            browseDisabled={!desktop}
            onChange={(customTerminalPath) => persist({ customTerminalPath })}
            onBrowse={() => void chooseExecutable('terminal')}
          />
        )}
      </ToolSelector>

      {detectedTools && !detecting && (
        <div className="rounded-lg border border-border bg-panel-2/55 p-4 text-xs text-fg-dim">
          <p className="font-semibold text-fg">{text.detected}</p>
          {detectedNames.length ? (
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {detectedNames.map((tool) => (
                <li key={`${tool.id}:${tool.path}`} className="flex min-w-0 items-center gap-2">
                  <Check size={12} className="shrink-0 text-emerald-400" />
                  <span className="truncate" title={tool.path || tool.name}>
                    {tool.name}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-fg-faint">{text.noAdditionalTools}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ToolSelector<T extends TaskIDEId | TaskTerminalId>({
  icon,
  label,
  description,
  selectId,
  value,
  placeholder,
  options,
  onChange,
  children,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  selectId: string;
  value: T;
  placeholder: string;
  options: ToolOption<T>[];
  onChange: (value: T) => void;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-panel-2/35 p-4">
      <div>
        <label htmlFor={selectId} className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="text-accent">{icon}</span>
          {label}
        </label>
        <p className="mt-1 text-xs leading-relaxed text-fg-faint">{description}</p>
      </div>
      <select
        id={selectId}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-10 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg outline-none transition-colors focus:border-accent"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}{option.detected ? '  ✓' : ''}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

function CustomPathField({
  id,
  label,
  value,
  placeholder,
  browseLabel,
  browseDisabled,
  onChange,
  onBrowse,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  browseLabel: string;
  browseDisabled: boolean;
  onChange: (value: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label htmlFor={id} className="text-xs font-medium text-fg-dim">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 font-mono text-xs text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent"
        />
        <button
          type="button"
          title={browseLabel}
          aria-label={browseLabel}
          disabled={browseDisabled}
          onClick={onBrowse}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FileSearch size={15} />
        </button>
      </div>
    </div>
  );
}
