import type { Message } from '@/store/types';

/** Only native completion events count; prompts, tool output and token estimates do not. */
export function isContextCompressionEvent(event: Record<string, unknown>): boolean {
  const kind = event.method ?? event.type;
  if (kind === 'system') return event.subtype === 'compact_boundary';
  if (kind === 'thread/compacted' || kind === 'thread.compacted') return true;
  if (kind === 'item.completed' || kind === 'item/completed') {
    const params = event.params as Record<string, unknown> | undefined;
    const item = (event.item ?? params?.item) as Record<string, unknown> | undefined;
    return item?.type === 'contextCompaction' || item?.type === 'context_compaction';
  }
  return false;
}

export const CONTEXT_COMPRESSION_TOOL = 'ugs_context_compaction';

export function sessionHasContextCompression(messages: Message[], metadata?: Record<string, unknown>): boolean {
  return metadata?.contextCompressed === true || messages.some((message) =>
    message.role === 'assistant' && message.contextCompressed === true);
}
