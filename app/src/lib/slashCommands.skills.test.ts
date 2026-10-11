import { describe, expect, it } from 'vitest';
import { buildGameSkillSuggestions, buildSlashSuggestions, SLASH_COMMANDS } from './slashCommands';
import { scopeSlashSuggestionsForAdapter } from '@/panels/aidock/slashSuggestions';

describe('app-native learning commands', () => {
  it('offers learn and refine for every adapter without changing the manifest or game registry', () => {
    for (const adapter of ['claude-code', 'codex', 'gemini'] as const) {
      const suggestions = scopeSlashSuggestionsForAdapter(buildSlashSuggestions([], 'en-US'), adapter);
      for (const name of ['/learn', '/refine']) {
        expect(suggestions.find((item) => item.name === name)).toMatchObject({
          kind: 'command', sourceAdapter: 'app', insertText: `${name} `,
        });
      }
    }
    expect(buildGameSkillSuggestions('en-US').some((item) => ['/learn', '/refine'].includes(item.name))).toBe(false);
    expect(SLASH_COMMANDS.some((item) => ['/learn', '/refine'].includes(item.name))).toBe(false);
  });
});
