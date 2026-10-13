import { describe, expect, it } from 'vitest';
import type { RuntimeAdapterId } from '@/lib/adapters';
import { buildSlashSuggestions } from '@/lib/slashCommands';
import type { SlashCatalogEntry } from '@/lib/tauri';
import { scopeSlashSuggestionsForAdapter } from './slashSuggestions';

function externalCommand(adapter: RuntimeAdapterId, name: string): SlashCatalogEntry {
  return {
    id: `command:${adapter}:${name}`, kind: 'command', name,
    label: { 'en-US': `External ${name}` }, detail: { 'en-US': 'Adapter command' },
    insertText: { 'en-US': `External prompt for ${name}` },
    source: adapter, sourceAdapter: adapter,
  };
}

describe('native learning suggestion ownership', () => {
  it.each(['claude-code', 'codex', 'gemini'] as const)('keeps app-owned learn/refine inserts when %s advertises the same names', (adapter) => {
    const catalog = ['/learn', '/refine', '/status'].map((name) => externalCommand(adapter, name));
    const scoped = scopeSlashSuggestionsForAdapter(buildSlashSuggestions(catalog, 'en-US'), adapter);
    for (const name of ['/learn', '/refine']) {
      expect(scoped.filter((suggestion) => suggestion.name === name)).toHaveLength(1);
      expect(scoped.find((suggestion) => suggestion.name === name)).toMatchObject({
        id: `command:app:${name}`, sourceAdapter: 'app', insertText: `${name} `,
      });
    }
    // Native ownership is narrowly scoped; existing adapter entries still win.
    expect(scoped.find((suggestion) => suggestion.name === '/status')?.sourceAdapter).toBe(adapter);
  });
});
