import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Scale,
  SlidersHorizontal,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  TASK_AGENT_PROFILE_DEFINITIONS,
  pickTaskProfileModelSelection,
  taskAgentProfileDefinition,
  taskModelSelectionKey,
  type TaskProfileModelOption,
} from "@/lib/taskAgentProfiles";
import {
  TASK_THINKING_LEVELS,
  type TaskAgentProfile,
  type TaskMeta,
  type TaskModelSelection,
  type TaskPhaseThinking,
  type TaskThinkingLevel,
} from "@/lib/taskBoard";

export type TaskModelOption = TaskProfileModelOption;

const PROFILE_ICONS: Record<TaskAgentProfile, LucideIcon> = {
  auto: Sparkles,
  complex: Brain,
  balanced: Scale,
  quick: Zap,
  custom: SlidersHorizontal,
};

const PHASES: readonly {
  id: keyof TaskPhaseThinking;
  label: string;
  description: string;
}[] = [
  { id: "spec", label: "规范", description: "需求与 OpenSpec 工件" },
  { id: "planning", label: "规划", description: "实施计划与子任务" },
  { id: "coding", label: "编码", description: "逐项实现任务" },
  { id: "qa", label: "QA", description: "检查与验收" },
];

const THINKING_LABELS: Record<TaskThinkingLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
};

const PROFILE_LABELS: Record<TaskAgentProfile, string> = {
  auto: "自动（已优化）",
  complex: "复杂任务",
  balanced: "均衡",
  quick: "快速修改",
  custom: "自定义",
};

function phaseSelection(
  value: TaskMeta,
  phase: keyof TaskPhaseThinking,
  fallback: TaskModelSelection | undefined,
): TaskModelSelection | undefined {
  if (phase === "spec") {
    return (
      value.specModelSelection ??
      value.planningModelSelection ??
      value.modelSelection ??
      fallback
    );
  }
  if (phase === "planning") {
    return value.planningModelSelection ?? value.modelSelection ?? fallback;
  }
  if (phase === "qa") {
    return value.reviewModelSelection ?? value.modelSelection ?? fallback;
  }
  return value.modelSelection ?? fallback;
}

function modelLabel(
  selection: TaskModelSelection | undefined,
  options: readonly TaskModelOption[],
): string {
  if (!selection) return "跟随当前模型";
  const key = taskModelSelectionKey(selection);
  return (
    options.find((option) => option.key === key)?.label ??
    selection.label ??
    selection.modelOverride ??
    "跟随当前模型"
  );
}

function compactModelLabel(
  selection: TaskModelSelection | undefined,
  options: readonly TaskModelOption[],
): string {
  if (!selection) return "跟随当前模型";
  if (selection.modelOverride?.trim()) return selection.modelOverride.trim();
  const option = options.find(
    (candidate) => candidate.key === taskModelSelectionKey(selection),
  );
  const compact = option?.label
    .split(/\s+[·|]\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return compact || selection.label || selection.modelClass || "跟随当前模型";
}

export default function TaskAgentProfileSelector({
  value,
  options,
  fallbackSelection,
  onChange,
  disabled = false,
}: {
  value: TaskMeta;
  options: readonly TaskModelOption[];
  fallbackSelection?: TaskModelSelection;
  onChange: (patch: Partial<TaskMeta>) => void;
  disabled?: boolean;
}) {
  const [showPhaseDetails, setShowPhaseDetails] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const profileId = value.agentProfile ?? "auto";
  const isCustom = profileId === "custom";
  const profile = taskAgentProfileDefinition(profileId);
  const currentPhaseThinking = value.phaseThinking ?? profile.phaseThinking;
  const Icon = PROFILE_ICONS[profileId];
  const selectedModel = pickTaskProfileModelSelection(
    profileId === "custom" ? "auto" : profileId,
    options,
    value.modelSelection ?? fallbackSelection,
  );

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  const selectProfile = (next: TaskAgentProfile) => {
    setProfileMenuOpen(false);
    profileButtonRef.current?.focus();
    if (next === "custom") {
      onChange({
        agentProfile: "custom",
        thinkingLevel: value.thinkingLevel ?? profile.thinkingLevel,
      });
      return;
    }
    const nextProfile = taskAgentProfileDefinition(next);
    const selection = pickTaskProfileModelSelection(
      next,
      options,
      value.modelSelection ?? fallbackSelection,
    );
    onChange({
      agentProfile: next,
      thinkingLevel: nextProfile.thinkingLevel,
      phaseThinking: { ...nextProfile.phaseThinking },
      model: undefined,
      reviewModel: undefined,
      modelSelection: selection,
      specModelSelection: selection,
      planningModelSelection: selection,
      reviewModelSelection: selection,
    });
    setShowPhaseDetails(false);
  };

  const profileDescription = isCustom
    ? "选择模型与思考级别"
    : profileId === "auto"
      ? `在各个阶段使用 ${compactModelLabel(selectedModel, options)}，并套用优化的思考级别`
      : profileId === "complex"
        ? `使用 ${compactModelLabel(selectedModel, options)} 与高思考级别，适合复杂、多步骤任务`
        : profileId === "balanced"
          ? `使用 ${compactModelLabel(selectedModel, options)} 与中思考级别，在速度与质量之间取得平衡`
          : `使用 ${compactModelLabel(selectedModel, options)} 与低思考级别，适合简单修改`;

  const updatePhaseModel = (
    phase: keyof TaskPhaseThinking,
    selection: TaskModelSelection | undefined,
  ) => {
    const key =
      phase === "spec"
        ? "specModelSelection"
        : phase === "planning"
          ? "planningModelSelection"
          : phase === "qa"
            ? "reviewModelSelection"
            : "modelSelection";
    onChange({
      [key]: selection,
      ...(phase === "coding" ? { model: undefined } : {}),
      ...(phase === "qa" ? { reviewModel: undefined } : {}),
    });
  };

  const updatePhaseThinking = (
    phase: keyof TaskPhaseThinking,
    thinkingLevel: TaskThinkingLevel,
  ) => {
    onChange({
      phaseThinking: {
        ...currentPhaseThinking,
        [phase]: thinkingLevel,
      },
    });
  };

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <label
          id="task-agent-profile-label"
          className="block text-sm font-medium text-fg"
        >
          智能体配置
        </label>
        <div ref={profileMenuRef} className="relative">
          <button
            ref={profileButtonRef}
            id="task-agent-profile"
            type="button"
            role="combobox"
            aria-labelledby="task-agent-profile-label"
            aria-controls="task-agent-profile-listbox"
            aria-haspopup="listbox"
            aria-expanded={profileMenuOpen}
            disabled={disabled}
            onClick={() => setProfileMenuOpen((open) => !open)}
            className={cn(
              "flex h-10 w-full items-center justify-between rounded-md border border-border bg-bg px-3 text-sm text-fg transition-colors",
              "hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-[#58a6ff]/30",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon size={16} className="shrink-0" />
              <span className="truncate font-medium">
                {profileId === "custom"
                  ? "自定义配置"
                  : PROFILE_LABELS[profileId]}
              </span>
            </span>
            <ChevronDown
              size={16}
              className={cn(
                "shrink-0 text-fg-dim transition-transform",
                profileMenuOpen && "rotate-180",
              )}
            />
          </button>

          {profileMenuOpen && (
            <div
              id="task-agent-profile-listbox"
              role="listbox"
              aria-labelledby="task-agent-profile-label"
              className="absolute bottom-[calc(100%+4px)] left-0 z-[90] w-full overflow-hidden rounded-lg border border-border bg-panel p-1 shadow-2xl"
            >
              {[
                ...TASK_AGENT_PROFILE_DEFINITIONS,
                {
                  id: "custom" as const,
                  label: "自定义",
                  description: "选择模型与思考级别",
                  thinkingLevel: "medium" as const,
                  phaseThinking: profile.phaseThinking,
                },
              ].map((item) => {
                const ItemIcon = PROFILE_ICONS[item.id];
                const selected =
                  item.id === "custom"
                    ? undefined
                    : pickTaskProfileModelSelection(
                        item.id,
                        options,
                        value.modelSelection ?? fallbackSelection,
                      );
                const selectedOption = item.id === profileId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    data-value={item.id}
                    aria-selected={selectedOption}
                    onClick={() => selectProfile(item.id)}
                    className={cn(
                      "flex h-9 w-full items-center rounded-md px-2 text-left text-sm transition-colors hover:bg-panel-2",
                      selectedOption
                        ? "bg-[#58a6ff]/15 text-[#58a6ff]"
                        : "text-fg",
                    )}
                  >
                    <span className="flex w-6 shrink-0 justify-center">
                      {selectedOption && <Check size={15} />}
                    </span>
                    <ItemIcon size={16} className="mr-2 shrink-0" />
                    <span className="font-medium">
                      {PROFILE_LABELS[item.id]}
                    </span>
                    <span className="ml-2 truncate text-xs text-fg-dim">
                      {item.id === "custom"
                        ? "（选择模型与思考级别）"
                        : `（${compactModelLabel(selected, options)} + ${THINKING_LABELS[item.thinkingLevel]}）`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <p className="text-xs text-fg-dim">{profileDescription}</p>
      </div>

      {!isCustom ? (
        <div className="overflow-visible rounded-lg border border-border bg-[#21262d]/40">
          <button
            type="button"
            aria-expanded={showPhaseDetails}
            disabled={disabled}
            onClick={() => setShowPhaseDetails((shown) => !shown)}
            className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-border-soft disabled:cursor-default"
          >
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium">阶段配置</span>
              {!showPhaseDetails && (
                <span className="inline-flex items-center gap-1 text-xs text-fg-dim">
                  <Pencil size={12} />
                  点击自定义
                </span>
              )}
            </span>
            {showPhaseDetails ? (
              <ChevronUp size={16} className="text-fg-dim" />
            ) : (
              <ChevronDown size={16} className="text-fg-dim" />
            )}
          </button>

          {!showPhaseDetails ? (
            <div className="-mt-1 grid grid-cols-2 gap-2 px-4 pb-4 text-xs">
              {PHASES.map((phase) => (
                <div
                  key={phase.id}
                  className="flex min-w-0 items-center justify-between gap-2 rounded bg-bg/60 px-2 py-1.5"
                >
                  <span className="shrink-0 text-fg-dim">{phase.label}:</span>
                  <span
                    className="truncate font-medium text-fg"
                    title={modelLabel(
                      phaseSelection(value, phase.id, fallbackSelection),
                      options,
                    )}
                  >
                    {modelLabel(
                      phaseSelection(value, phase.id, fallbackSelection),
                      options,
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4 border-t border-border px-4 pb-4 pt-4">
              {PHASES.map((phase) => (
                <div key={phase.id} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-fg">
                      {phase.label}
                    </span>
                    <span className="text-[10px] text-fg-dim">
                      {phase.description}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <TaskModelSelect
                      id={`task-${phase.id}-model`}
                      label="模型"
                      value={phaseSelection(value, phase.id, fallbackSelection)}
                      options={options}
                      placeholder="跟随执行模型"
                      disabled={disabled}
                      onChange={(selection) =>
                        updatePhaseModel(phase.id, selection)
                      }
                    />
                    <TaskThinkingSelect
                      id={`task-${phase.id}-thinking`}
                      value={currentPhaseThinking[phase.id]}
                      disabled={disabled}
                      onChange={(level) => updatePhaseThinking(phase.id, level)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-[#21262d]/40 p-4">
          <TaskModelSelect
            id="task-execution-model"
            label="模型"
            value={value.modelSelection ?? fallbackSelection}
            options={options}
            placeholder="跟随当前模型"
            disabled={disabled}
            onChange={(selection) =>
              onChange({ model: undefined, modelSelection: selection })
            }
          />
          <TaskThinkingSelect
            id="task-thinking-level"
            value={value.thinkingLevel ?? "medium"}
            disabled={disabled}
            onChange={(thinkingLevel) => onChange({ thinkingLevel })}
          />
        </div>
      )}
    </section>
  );
}

export function TaskThinkingSelect({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: TaskThinkingLevel;
  onChange: (value: TaskThinkingLevel) => void;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className="block space-y-1.5 text-[11px] text-fg-dim">
      <span>思考级别</span>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as TaskThinkingLevel)}
        className="h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
      >
        {TASK_THINKING_LEVELS.map((level) => (
          <option key={level} value={level}>
            {THINKING_LABELS[level]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TaskModelSelect({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  value?: TaskModelSelection;
  options: readonly TaskModelOption[];
  placeholder: string;
  onChange: (selection: TaskModelSelection | undefined) => void;
  disabled?: boolean;
}) {
  const selectedKey = taskModelSelectionKey(value);
  const selectedMissing =
    !!selectedKey && !options.some((option) => option.key === selectedKey);
  return (
    <label htmlFor={id} className="block space-y-1.5 text-[11px] text-fg-dim">
      <span>{label}</span>
      <select
        id={id}
        value={selectedKey}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            options.find((option) => option.key === event.target.value)
              ?.selection,
          )
        }
        className={cn(
          "h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg focus:border-accent focus:outline-none",
          disabled && "opacity-50",
        )}
      >
        <option value="">{placeholder}</option>
        {selectedMissing && (
          <option value={selectedKey}>
            {value?.label || value?.modelOverride || selectedKey}
          </option>
        )}
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
