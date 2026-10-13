import type { Message } from '@/store/types';

/**
 * Display-only chronological ordering for the AI-return stream.
 *
 * The store keeps messages merged by turn, so the raw array can be out of
 * `createdAt` order (e.g. an in-flight reply lands right after its own prompt,
 * even when a later user message was appended first). This sorts a copy by
 * `createdAt` so the stream reads top-down in real send time, leaving the
 * store array and the LLM-facing history untouched.
 *
 * The one exception is an interjected ("插话") message: its `createdAt` is its
 * *send* time, which is later than the reply it was steered into. A plain
 * `createdAt` sort would drop it below that reply — back to the tail, where it
 * reads as "not sent yet". Each interjection is instead anchored to the message
 * right after it in the store (the reply it precedes), so it stays just above
 * that reply while everything else keeps its chronological position.
 *
 * Sort is skipped when the array is already monotonic, so steady-state
 * rendering stays O(n).
 */
export function orderDisplayMessages(messages: Message[]): Message[] {
  let sorted = true;
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].createdAt < messages[i - 1].createdAt) {
      sorted = false;
      break;
    }
  }
  if (sorted) return messages;

  const interjectionAnchor = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    if (!messages[i].interjected) continue;
    let nextIdx = -1;
    for (let j = i + 1; j < messages.length; j += 1) {
      if (!messages[j].interjected) {
        nextIdx = j;
        break;
      }
    }
    interjectionAnchor.set(
      messages[i].id,
      nextIdx >= 0 ? messages[nextIdx].createdAt - 1 : messages[i].createdAt,
    );
  }

  return [...messages].sort((a, b) => {
    const ta = interjectionAnchor.get(a.id) ?? a.createdAt;
    const tb = interjectionAnchor.get(b.id) ?? b.createdAt;
    return ta - tb;
  });
}
