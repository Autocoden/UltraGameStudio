import { describe, expect, it } from 'vitest';
import type { Message } from '@/store/types';
import { orderDisplayMessages } from './orderDisplayMessages';

function msg(
  id: string,
  role: Message['role'],
  createdAt: number,
  extra: Partial<Message> = {},
): Message {
  return { id, role, text: `${id}`, createdAt, ...extra };
}

function ids(messages: Message[]): string[] {
  return messages.map((m) => m.id);
}

describe('orderDisplayMessages', () => {
  it('returns the same array reference when already monotonic', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 200),
    ];
    expect(orderDisplayMessages(messages)).toBe(messages);
  });

  it('sorts out-of-order messages by createdAt when no interjection is present', () => {
    const messages = [
      msg('a2', 'assistant', 300),
      msg('u2', 'user', 200),
      msg('a1', 'assistant', 100),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['a1', 'u2', 'a2']);
  });

  it('keeps an interjection just above the reply it interrupted', () => {
    // Store order: user1 → interjection → reply. The interjection was sent
    // after the reply started, so its createdAt is later than the reply's.
    const messages = [
      msg('u1', 'user', 100),
      msg('i1', 'user', 300, { interjected: true }),
      msg('a1', 'assistant', 200),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i1', 'a1']);
  });

  it('keeps consecutive interjections above their shared reply in store order', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('i2', 'user', 400, { interjected: true }),
      msg('i1', 'user', 300, { interjected: true }),
      msg('a1', 'assistant', 200),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i2', 'i1', 'a1']);
  });

  it('leaves a trailing interjection at the tail when nothing follows it', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 200),
      msg('i1', 'user', 300, { interjected: true }),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'a1', 'i1']);
  });
});
