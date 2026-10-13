import type { Segment } from './lib/segmenter';
import { isChatTaskTool } from './lib/toolEvent';
import { CONTEXT_COMPRESSION_TOOL } from '@/lib/contextCompression';

export type ExecutionSegment = Exclude<Segment, { type: 'answer' }>;
export type MessageDisplaySegment =
  | { type: 'answer'; text: string; index: number }
  | { type: 'execution'; segments: ExecutionSegment[]; index: number };

/** Answers stay in place; only adjacent telemetry shares a disclosure. */
export function groupExecutionSegments(segments: Segment[]): MessageDisplaySegment[] {
  const groups: MessageDisplaySegment[] = [];
  segments.forEach((segment, index) => {
    if (segment.type === 'tools') {
      // Keep failures visible; successful plan bookkeeping belongs only to the task panel.
      segment = { ...segment, events: segment.events.filter((event) =>
        event.name !== CONTEXT_COMPRESSION_TOOL && (event.status !== 'done' || !isChatTaskTool(event.name))) };
      if (!segment.events.length) return;
    }
    if (segment.type === 'answer') {
      // Sentinel padding is not an answer and must not split a process run.
      if (!segment.text.trim()) return;
      groups.push({ ...segment, index });
      return;
    }
    const previous = groups[groups.length - 1];
    if (previous?.type === 'execution') previous.segments.push(segment);
    else groups.push({ type: 'execution', segments: [segment], index });
  });
  return groups;
}
