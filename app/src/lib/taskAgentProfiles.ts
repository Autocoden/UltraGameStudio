import type { GatewaySelection } from "@/lib/modelGateway/types";
import type {
  TaskAgentProfile,
  TaskModelSelection,
  TaskPhaseThinking,
  TaskThinkingLevel,
} from "@/lib/taskBoard";

export interface TaskAgentProfileDefinition {
  id: Exclude<TaskAgentProfile, "custom">;
  label: string;
  description: string;
  thinkingLevel: TaskThinkingLevel;
  phaseThinking: TaskPhaseThinking;
}

export interface TaskProfileModelOption {
  key: string;
  label: string;
  selection: TaskModelSelection;
}

export const TASK_AGENT_PROFILE_DEFINITIONS: readonly TaskAgentProfileDefinition[] =
  [
    {
      id: "auto",
      label: "自动（优化）",
      description: "默认使用均衡模型，并在编码与 QA 阶段减少思考开销。",
      thinkingLevel: "medium",
      phaseThinking: {
        spec: "medium",
        planning: "medium",
        coding: "low",
        qa: "low",
      },
    },
    {
      id: "complex",
      label: "复杂任务",
      description: "适合需要深入分析的复杂、多步骤实现。",
      thinkingLevel: "high",
      phaseThinking: {
        spec: "high",
        planning: "high",
        coding: "high",
        qa: "high",
      },
    },
    {
      id: "balanced",
      label: "均衡",
      description: "在速度与质量之间取得平衡，适合大多数任务。",
      thinkingLevel: "medium",
      phaseThinking: {
        spec: "medium",
        planning: "medium",
        coding: "medium",
        qa: "medium",
      },
    },
    {
      id: "quick",
      label: "快速编辑",
      description: "适合简单修改、修复与快速迭代。",
      thinkingLevel: "low",
      phaseThinking: {
        spec: "low",
        planning: "low",
        coding: "low",
        qa: "low",
      },
    },
  ] as const;

export const DEFAULT_TASK_PHASE_THINKING: TaskPhaseThinking = {
  ...TASK_AGENT_PROFILE_DEFINITIONS[0].phaseThinking,
};

export function taskAgentProfileDefinition(
  profile: TaskAgentProfile | undefined,
): TaskAgentProfileDefinition {
  return (
    TASK_AGENT_PROFILE_DEFINITIONS.find((item) => item.id === profile) ??
    TASK_AGENT_PROFILE_DEFINITIONS[0]
  );
}

export function taskModelSelectionFromGateway(
  selection: GatewaySelection,
): TaskModelSelection {
  return {
    adapter: selection.adapter,
    modelClass: selection.modelClass,
    ...(selection.providerId ? { providerId: selection.providerId } : {}),
    ...(selection.channelId ? { channelId: selection.channelId } : {}),
    ...(selection.modelOverride
      ? { modelOverride: selection.modelOverride }
      : {}),
  };
}

export function taskModelSelectionKey(
  selection: TaskModelSelection | undefined,
): string {
  return selection?.providerId && selection.channelId
    ? `${selection.providerId}\u0000${selection.channelId}`
    : "";
}

const PROFILE_MODEL_HINTS: Record<"complex" | "quick", readonly RegExp[]> = {
  complex: [
    /\bopus\b/i,
    /\bpro\b/i,
    /reason/i,
    /\bmax\b/i,
    /\blarge\b/i,
    /gpt[- ]?5/i,
    /glm[- ]?5/i,
  ],
  quick: [
    /\bhaiku\b/i,
    /flash[- ]?lite/i,
    /\bflash\b/i,
    /\bmini\b/i,
    /\bsmall\b/i,
    /\bfast\b/i,
  ],
};

/**
 * Pick the closest configured channel for an Autocode preset. The search stays
 * inside the currently selected provider whenever possible, so switching a
 * profile never jumps to another account unexpectedly.
 */
export function pickTaskProfileModelSelection(
  profile: Exclude<TaskAgentProfile, "custom">,
  options: readonly TaskProfileModelOption[],
  current?: TaskModelSelection,
): TaskModelSelection | undefined {
  const currentKey = taskModelSelectionKey(current);
  const currentOption = options.find((option) => option.key === currentKey);
  const base = currentOption?.selection ?? current;
  const providerOptions = base?.providerId
    ? options.filter(
        (option) => option.selection.providerId === base.providerId,
      )
    : options;
  const candidates = providerOptions.length ? providerOptions : options;

  if (profile === "auto" || profile === "balanced") {
    return base ?? candidates[0]?.selection;
  }

  const hints = PROFILE_MODEL_HINTS[profile];
  const ranked = candidates
    .map((option, index) => {
      const text = `${option.selection.modelOverride ?? ""} ${option.label}`;
      const hintIndex = hints.findIndex((hint) => hint.test(text));
      return { option, index, hintIndex };
    })
    .filter((item) => item.hintIndex >= 0)
    .sort((left, right) =>
      left.hintIndex === right.hintIndex
        ? left.index - right.index
        : left.hintIndex - right.hintIndex,
    );
  return ranked[0]?.option.selection ?? base ?? candidates[0]?.selection;
}
