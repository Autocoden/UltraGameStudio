import type { RuntimeAdapterId } from '@/lib/adapters';
import type { SlashSuggestion } from '@/lib/slashCommands';

const MAX_FILTERED_SLASH_SUGGESTIONS = 10;

export interface SlashTrigger {
  start: number;
  end: number;
  query: string;
}

function slashSuggestionRankForAdapter(
  suggestion: SlashSuggestion,
  adapter: RuntimeAdapterId,
): number {
  const sourceAdapter = suggestion.sourceAdapter;
  // These names execute inside the app, never as adapter prompt expansions.
  if (sourceAdapter === 'app' && /^\/(learn|refine)$/i.test(suggestion.name)) return 3;
  if (sourceAdapter === adapter) return 2;
  if (!sourceAdapter || sourceAdapter === 'app' || sourceAdapter === 'agent') {
    return 1;
  }
  return 0;
}

export function scopeSlashSuggestionsForAdapter(
  suggestions: SlashSuggestion[],
  adapter: RuntimeAdapterId,
): SlashSuggestion[] {
  const scoped = suggestions
    .filter((suggestion) => slashSuggestionRankForAdapter(suggestion, adapter) > 0)
    .sort(
      (a, b) =>
        slashSuggestionRankForAdapter(b, adapter) -
        slashSuggestionRankForAdapter(a, adapter),
    );
  const seen = new Set<string>();
  const out: SlashSuggestion[] = [];
  for (const suggestion of scoped) {
    const key = `${suggestion.kind}:${suggestion.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
}

export function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  if (caret < 1) return null;

  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)\/([^\s/]*)$/.exec(beforeCaret);
  if (!match) return null;

  const query = match[2] ?? '';
  const start = beforeCaret.length - query.length - 1;
  return { start, end: caret, query };
}

export function findGameSkillTrigger(text: string, caret: number): SlashTrigger | null {
  if (caret < 1) return null;

  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)#([^\s#]*)$/.exec(beforeCaret);
  if (!match) return null;

  const query = match[2] ?? '';
  const start = beforeCaret.length - query.length - 1;
  return { start, end: caret, query };
}

export function findOrgMentionTrigger(text: string, caret: number): SlashTrigger | null {
  if (caret < 1) return null;

  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)\$([^\s$]*)$/.exec(beforeCaret);
  if (!match) return null;

  const query = match[2] ?? '';
  const start = beforeCaret.length - query.length - 1;
  return { start, end: caret, query };
}

export function filterSlashSuggestions(
  suggestions: SlashSuggestion[],
  query: string,
): SlashSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return suggestions;

  const starts: SlashSuggestion[] = [];
  const contains: SlashSuggestion[] = [];
  for (const suggestion of suggestions) {
    const name = suggestion.name.slice(1).toLowerCase();
    const label = suggestion.label.toLowerCase();
    if (name.startsWith(q) || label.startsWith(q)) {
      starts.push(suggestion);
      continue;
    }
    if (suggestion.searchText.includes(q)) contains.push(suggestion);
  }

  return [...starts, ...contains].slice(0, MAX_FILTERED_SLASH_SUGGESTIONS);
}

function findSlashSuggestionForText(
  text: string,
  suggestions: SlashSuggestion[],
): { suggestion: SlashSuggestion; request: string } | null {
  const match = /^\/[^\s]+(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!command) return null;
  const suggestion = suggestions.find(
    (item) => item.name.toLowerCase() === command,
  );
  if (!suggestion) return null;
  return {
    suggestion,
    request: (match[1] ?? '').trim(),
  };
}

export function expandSlashRequest(
  text: string,
  suggestions: SlashSuggestion[],
): string {
  const found = findSlashSuggestionForText(text, suggestions);
  if (!found) return text;
  const { suggestion, request } = found;
  const instruction =
    suggestion.insertText.trim() ||
    suggestion.detail.trim() ||
    `Use ${suggestion.name} for this request.`;
  if (!request) return instruction;
  return `${instruction}\n\n请求：\n${request}`;
}
