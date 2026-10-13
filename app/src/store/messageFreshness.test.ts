import { describe, it, expect } from 'vitest';
import {
  aiEditMergeBaseMessages,
  mergeMessagesById,
  messageFreshness,
  newerMessage,
} from './useStore';
import type { Message } from './types';

const msg = (
  id: string,
  role: Message['role'],
  text = id,
  stamps: { createdAt?: number; completedAt?: number } = {},
): Message => ({
  id,
  role,
  text,
  createdAt: stamps.createdAt ?? 1,
  ...(stamps.completedAt !== undefined
    ? { completedAt: stamps.completedAt }
    : {}),
});

describe('messageFreshness', () => {
  it('prefers the completion stamp over the creation stamp', () => {
    expect(messageFreshness(msg('a', 'assistant', 'a', { createdAt: 10, completedAt: 90 }))).toBe(90);
  });

  it('falls back to the creation stamp while a reply is still streaming', () => {
    expect(messageFreshness(msg('a', 'assistant', 'a', { createdAt: 10 }))).toBe(10);
  });
});

describe('newerMessage', () => {
  it('keeps the update when it finished later', () => {
    const base = msg('a', 'assistant', 'disk', { completedAt: 100 });
    const update = msg('a', 'assistant', 'live', { completedAt: 200 });
    expect(newerMessage(base, update)).toBe(update);
  });

  it('keeps the base when the update is an older frozen copy', () => {
    const base = msg('a', 'assistant', 'final answer', { completedAt: 200 });
    const update = msg('a', 'assistant', 'mid-stream', { completedAt: 100 });
    expect(newerMessage(base, update)).toBe(base);
  });

  it('keeps the base when both stamps agree', () => {
    const base = msg('a', 'assistant', 'disk', { completedAt: 100 });
    const update = msg('a', 'assistant', 'snapshot', { completedAt: 100 });
    expect(newerMessage(base, update)).toBe(base);
  });

  it('lets a fresh streaming copy win over an unfinished base', () => {
    const base = msg('a', 'assistant', 'old', { createdAt: 10 });
    const update = msg('a', 'assistant', 'new', { createdAt: 10, completedAt: 50 });
    expect(newerMessage(base, update)).toBe(update);
  });
});

describe('mergeMessagesById with a freshness resolver', () => {
  // Regression: switch away while a reply is streaming, switch back.
  // The persisted record already holds the FINAL answer; the retained snapshot
  // froze an intermediate commit (the interjection path stamps an early
  // `completedAt`). Merging with the snapshot as the unconditional winner made
  // the final answer vanish from the restored view.
  it('does not let an older snapshot bury the final persisted answer', () => {
    const persisted = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'FINAL ANSWER', { completedAt: 200 }),
    ];
    const snapshot = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'mid-stream log only', { completedAt: 100 }),
    ];
    const merged = mergeMessagesById(persisted, snapshot, newerMessage);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged[1].text).toBe('FINAL ANSWER');
  });

  it('restores in-flight text that the debounced write has not flushed yet', () => {
    const persisted = [msg('u1', 'user', 'go')];
    const snapshot = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'streaming now', { createdAt: 200 }),
    ];
    const merged = mergeMessagesById(persisted, snapshot, newerMessage);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged[1].text).toBe('streaming now');
  });

  it('still inserts a brand-new reply right after its prompt, not at the tail', () => {
    const base = [msg('u1', 'user'), msg('u2', 'user')];
    const updates = [
      msg('u1', 'user'),
      msg('a1', 'assistant', 'reply', { createdAt: 50 }),
    ];
    expect(
      mergeMessagesById(base, updates, newerMessage).map((m) => m.id),
    ).toEqual(['u1', 'a1', 'u2']);
  });

  it('keeps the default "updates win" behaviour when no resolver is passed', () => {
    const base = [msg('a1', 'assistant', 'old', { completedAt: 200 })];
    const updates = [msg('a1', 'assistant', 'new', { completedAt: 100 })];
    expect(mergeMessagesById(base, updates)[0].text).toBe('new');
  });
});

describe('aiEditMergeBaseMessages', () => {
  it('uses the channel buffer once it has produced messages', () => {
    const channel = [msg('a1', 'assistant', 'channel')];
    const snapshot = [msg('a1', 'assistant', 'snapshot')];
    expect(aiEditMergeBaseMessages(channel, snapshot)).toBe(channel);
  });

  it('falls back to the snapshot only for a channel that produced nothing', () => {
    const snapshot = [msg('a1', 'assistant', 'snapshot')];
    expect(aiEditMergeBaseMessages([], snapshot)).toBe(snapshot);
    expect(aiEditMergeBaseMessages([], undefined)).toEqual([]);
  });
});
