import type { GatewaySelection, IRGraph } from '@/core/ir';
import {
  personalInstructionsForSelection,
  withPersonalInstructionsForSelection,
} from '@/core/personalInstructions';
import {
  applyAppearance,
  isBuiltinStylePresetId,
  normalizeAppearanceSettings,
  streamSchemeForStylePresetId,
  type AppearanceSettings,
} from '@/lib/appearance';
import { loadAppearance, saveAppearance } from '@/lib/appearanceStorage';
import {
  loadAssetCenterEnabled,
  loadComposerToolButtonsVisible,
  loadComposerHintRowVisible,
  loadGameExpertSettings,
  loadLocale,
  loadPersonalInstructionsByModel,
  loadPromptAutoTranslate,
  loadThinkingLevelOverrides,
  loadThinkingLevelsEnabled,
  saveAssetCenterEnabled,
  saveComposerToolButtonsVisible,
  saveComposerHintRowVisible,
  saveGameExpertSettings,
  saveLocale,
  savePersonalInstructionsByModel,
  savePromptAutoTranslate,
  saveThinkingLevelOverrides,
  saveThinkingLevelsEnabled,
} from '@/lib/composerStorage';
import { normalizeGameExpertSettings, type GameExpertSettings } from '@/lib/gameExperts';
import type { Locale } from '@/lib/i18n';
import {
  listGatewayRunOptions,
  normalizeGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import {
  definePersistedFields,
  loadPersistedFields,
} from '@/lib/persistedFields';
import type { StoreState, StoreSet, StoreGet } from './storeState';
import type { ComposerSettings } from './types';

// M4: load/save pairing enforced at compile time for the settings fields whose
// persistence is a plain 1:1 read/write (the shapes most prone to "added a
// persisted field, forgot the save side"). Each entry must supply BOTH `load`
// and `save`, and definePersistedFields pins the value type to the matching
// StoreState field — so a registry entry that loads/saves the wrong type, or
// only declares one half, fails to compile. The seed loader and the setters
// below both route through this registry instead of calling save* directly.
//
// personalInstructionsByModel is intentionally NOT here: its load takes a
// selection + defaults (not a nullary load()), so it doesn't fit the 1:1
// PersistedField contract and keeps its bespoke flow below.
type SimpleSettingsPersist = {
  locale: Locale;
  promptAutoTranslate: boolean;
  composerToolButtonsVisible: boolean;
  thinkingLevelsEnabled: boolean;
  composerHintRowVisible: boolean;
  assetCenterEnabled: boolean;
  thinkingLevelOverrides: string;
  gameExpertSettings: GameExpertSettings;
  appearance: AppearanceSettings;
};

const settingsPersist = definePersistedFields<SimpleSettingsPersist>({
  locale: { load: loadLocale, save: saveLocale },
  promptAutoTranslate: {
    load: loadPromptAutoTranslate,
    save: savePromptAutoTranslate,
  },
  composerToolButtonsVisible: {
    load: loadComposerToolButtonsVisible,
    save: saveComposerToolButtonsVisible,
  },
  thinkingLevelsEnabled: {
    load: loadThinkingLevelsEnabled,
    save: saveThinkingLevelsEnabled,
  },
  composerHintRowVisible: {
    load: loadComposerHintRowVisible,
    save: saveComposerHintRowVisible,
  },
  assetCenterEnabled: {
    load: loadAssetCenterEnabled,
    save: saveAssetCenterEnabled,
  },
  thinkingLevelOverrides: {
    load: loadThinkingLevelOverrides,
    save: saveThinkingLevelOverrides,
  },
  gameExpertSettings: {
    load: loadGameExpertSettings,
    save: saveGameExpertSettings,
  },
  appearance: { load: loadAppearance, save: saveAppearance },
});

// Canonical store set/get signatures live in storeState.ts (derived from
// zustand's StoreApi). Re-exported here under the slice-local names so existing
// references keep working without diverging from what create<StoreState>() passes.
export type SettingsSliceSet = StoreSet;

export type SettingsSliceGet = StoreGet;

export type SettingsSlice = Pick<
  StoreState,
  | 'locale'
  | 'promptAutoTranslate'
  | 'composerToolButtonsVisible'
  | 'thinkingLevelsEnabled'
  | 'composerHintRowVisible'
  | 'assetCenterEnabled'
  | 'thinkingLevelOverrides'
  | 'personalInstructionsByModel'
  | 'personalInstructions'
  | 'gameExpertSettings'
  | 'appearance'
  | 'setLocale'
  | 'setPromptAutoTranslate'
  | 'setComposerToolButtonsVisible'
  | 'setThinkingLevelsEnabled'
  | 'setComposerHintRowVisible'
  | 'setAssetCenterEnabled'
  | 'setThinkingLevelOverrides'
  | 'setPersonalInstructions'
  | 'setGameExpertSettings'
  | 'setStylePresetId'
  | 'setStreamSchemeId'
  | 'setFontFamilyId'
  | 'setFontSizePx'
>;

export type SettingsSliceSeeds = Pick<
  SettingsSlice,
  | 'locale'
  | 'promptAutoTranslate'
  | 'composerToolButtonsVisible'
  | 'thinkingLevelsEnabled'
  | 'composerHintRowVisible'
  | 'assetCenterEnabled'
  | 'thinkingLevelOverrides'
  | 'personalInstructionsByModel'
  | 'personalInstructions'
  | 'gameExpertSettings'
  | 'appearance'
>;

function personalInstructionsSelectionForState(
  state: Pick<StoreState, 'workflow' | 'composer'>,
): GatewaySelection {
  return workflowDefaultGatewaySelection(state.workflow, state.composer.model);
}

function activePersonalInstructionsForState(
  state: Pick<
    StoreState,
    'personalInstructionsByModel' | 'workflow' | 'composer'
  >,
): string {
  return personalInstructionsForSelection(
    state.personalInstructionsByModel,
    personalInstructionsSelectionForState(state),
  );
}

export function loadSettingsSliceSeeds(
  workflow: IRGraph,
  composer: ComposerSettings,
  // Threaded in from useStore's cold-start so locale is read exactly once and
  // the store's `locale` field provably matches the workflow's seed locale.
  // Falls back to the registry's locale.load() if a caller doesn't supply it.
  seedLocale?: Locale,
): SettingsSliceSeeds {
  // 1:1 fields come from the compile-time-paired registry; locale may be
  // overridden by the cold-start seed so it is read exactly once.
  const simple = loadPersistedFields(settingsPersist);
  const locale = seedLocale ?? simple.locale;
  const personalInstructionsSelection = workflowDefaultGatewaySelection(
    workflow,
    composer.model,
  );
  const personalInstructionsSelections = [
    personalInstructionsSelection,
    ...listGatewayRunOptions().map((option) => option.selection),
  ];
  const personalInstructionsByModel = loadPersonalInstructionsByModel(
    personalInstructionsSelection,
    personalInstructionsSelections,
  );
  const personalInstructions = personalInstructionsForSelection(
    personalInstructionsByModel,
    personalInstructionsSelection,
  );
  return {
    locale,
    promptAutoTranslate: simple.promptAutoTranslate,
    composerToolButtonsVisible: simple.composerToolButtonsVisible,
    thinkingLevelsEnabled: simple.thinkingLevelsEnabled,
    composerHintRowVisible: simple.composerHintRowVisible,
    assetCenterEnabled: simple.assetCenterEnabled,
    thinkingLevelOverrides: simple.thinkingLevelOverrides,
    personalInstructionsByModel,
    personalInstructions,
    gameExpertSettings: simple.gameExpertSettings,
    appearance: simple.appearance,
  };
}

export function createSettingsSlice(
  set: SettingsSliceSet,
  get: SettingsSliceGet,
  seeds: SettingsSliceSeeds,
): SettingsSlice {
  return {
    locale: seeds.locale,
    promptAutoTranslate: seeds.promptAutoTranslate,
    composerToolButtonsVisible: seeds.composerToolButtonsVisible,
    thinkingLevelsEnabled: seeds.thinkingLevelsEnabled,
    composerHintRowVisible: seeds.composerHintRowVisible,
    assetCenterEnabled: seeds.assetCenterEnabled,
    thinkingLevelOverrides: seeds.thinkingLevelOverrides,
    personalInstructionsByModel: seeds.personalInstructionsByModel,
    personalInstructions: seeds.personalInstructions,
    gameExpertSettings: seeds.gameExpertSettings,
    appearance: seeds.appearance,

    setLocale: (locale) => {
      set({ locale });
      settingsPersist.locale.save(locale);
    },

    setPromptAutoTranslate: (enabled) => {
      set({ promptAutoTranslate: enabled });
      settingsPersist.promptAutoTranslate.save(enabled);
    },

    setComposerToolButtonsVisible: (visible) => {
      set({ composerToolButtonsVisible: visible });
      settingsPersist.composerToolButtonsVisible.save(visible);
    },

    setThinkingLevelsEnabled: (enabled) => {
      set({ thinkingLevelsEnabled: enabled });
      settingsPersist.thinkingLevelsEnabled.save(enabled);
    },

    setComposerHintRowVisible: (visible) => {
      set({ composerHintRowVisible: visible });
      settingsPersist.composerHintRowVisible.save(visible);
    },

    setAssetCenterEnabled: (enabled) => {
      set({ assetCenterEnabled: enabled });
      settingsPersist.assetCenterEnabled.save(enabled);
    },

    setThinkingLevelOverrides: (raw) => {
      set({ thinkingLevelOverrides: raw });
      settingsPersist.thinkingLevelOverrides.save(raw);
    },

    setPersonalInstructions: (instructions, selection) => {
      set((state) => {
        const targetSelection = selection
          ? normalizeGatewaySelection(selection)
          : personalInstructionsSelectionForState(state);
        const personalInstructionsByModel = withPersonalInstructionsForSelection(
          state.personalInstructionsByModel,
          targetSelection,
          instructions,
        );
        savePersonalInstructionsByModel(personalInstructionsByModel);
        return {
          personalInstructionsByModel,
          personalInstructions: activePersonalInstructionsForState({
            ...state,
            personalInstructionsByModel,
          }),
        };
      });
    },

    setGameExpertSettings: (patch) => {
      set((state) => {
        const gameExpertSettings = normalizeGameExpertSettings({
          ...state.gameExpertSettings,
          ...patch,
        });
        settingsPersist.gameExpertSettings.save(gameExpertSettings);
        return { gameExpertSettings };
      });
    },

    setStylePresetId: (stylePresetId) => {
      const appearance: AppearanceSettings = normalizeAppearanceSettings({
        ...get().appearance,
        stylePresetId,
        streamSchemeId: streamSchemeForStylePresetId(stylePresetId),
      });
      set({ appearance });
      settingsPersist.appearance.save(appearance);
      applyAppearance(appearance);
    },

    setStreamSchemeId: (streamSchemeId) => {
      const current = get().appearance;
      const appearance: AppearanceSettings = normalizeAppearanceSettings({
        ...current,
        stylePresetId: isBuiltinStylePresetId(streamSchemeId)
          ? streamSchemeId
          : current.stylePresetId,
        streamSchemeId,
      });
      set({ appearance });
      settingsPersist.appearance.save(appearance);
      applyAppearance(appearance);
    },

    setFontFamilyId: (fontFamilyId) => {
      const appearance: AppearanceSettings = normalizeAppearanceSettings({
        ...get().appearance,
        fontFamilyId,
      });
      set({ appearance });
      settingsPersist.appearance.save(appearance);
      applyAppearance(appearance);
    },

    setFontSizePx: (fontSizePx) => {
      const appearance: AppearanceSettings = normalizeAppearanceSettings({
        ...get().appearance,
        fontSizePx,
      });
      set({ appearance });
      settingsPersist.appearance.save(appearance);
      applyAppearance(appearance);
    },
  };
}
