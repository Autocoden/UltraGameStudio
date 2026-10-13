import { describe, expect, it } from 'vitest';
import { isContextCompressionEvent, sessionHasContextCompression } from './contextCompression';

describe('native context compression', () => {
  it.each([
    { type: 'system', subtype: 'compact_boundary' },
    { method: 'thread/compacted', params: { threadId: 'thread' } },
    { type: 'thread.compacted' },
    { type: 'item.completed', item: { type: 'context_compaction' } },
    { method: 'item/completed', params: { item: { type: 'contextCompaction' } } },
  ])('recognizes a completed compression: %j', (event) => {
    expect(isContextCompressionEvent(event)).toBe(true);
  });
  it.each([
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'item.started', item: { type: 'context_compaction' } },
    { type: 'assistant', text: '上下文已压缩' },
    { type: 'item.completed', item: { type: 'command_execution', output: 'compact_boundary' } },
  ])('does not infer compression: %j', (event) => {
    expect(isContextCompressionEvent(event)).toBe(false);
  });
  it('uses persisted assistant metadata, never ordinary text or user messages', () => {
    expect(sessionHasContextCompression([{ id: 'a', role: 'assistant', text: '', createdAt: 1, contextCompressed: true }])).toBe(true);
    expect(sessionHasContextCompression([{ id: 'u', role: 'user', text: '已压缩', createdAt: 1, contextCompressed: true }])).toBe(false);
    expect(sessionHasContextCompression([], { contextCompressed: true })).toBe(true);
    expect(sessionHasContextCompression([])).toBe(false);
  });
});
