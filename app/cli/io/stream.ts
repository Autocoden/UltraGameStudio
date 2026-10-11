/**
 * Streaming stdout/stderr helpers + tool-use summarisation for the Node CLI.
 *
 * A faithful port of the relevant pieces of `src-tauri/src/lib.rs`:
 *   - `summarize_tool_use`          -> {@link summarizeToolUse}
 *   - `codex_progress_line`         -> {@link codexProgressLine}
 *   - `codex_completed_item`        -> {@link codexCompletedItem}
 *   - `codex_turn_completion_status`-> {@link codexTurnCompletionStatus}
 *   - `codex_turn_usage`            -> {@link codexTurnUsage}
 *   - `codex_status_success`        -> {@link codexStatusSuccess}
 *
 * Pure (no spawn): consumed by `cli/io/cli-spawn.ts` while it walks the JSONL
 * stream, and re-usable by tests.
 */

/**
 * Summarise a Claude `tool_use` block into one readable progress line, e.g.
 * `🔧 Bash: ls app/src` / `🔧 Read: app/src/core/ir.ts`. Mirrors
 * `summarize_tool_use` in lib.rs exactly (same key precedence + 200-char clamp).
 */
import type { SkillNativeToolEvent } from '../../src/runtime/skills/types';
import { redactSkillText } from '../../src/runtime/skills/evidence';

export function summarizeToolUse(name: string, input: unknown): string {
  const keys = [
    'command',
    'pattern',
    'file_path',
    'path',
    'query',
    'url',
    'description',
    'prompt',
    'old_string',
    'title',
  ];
  let detail = '';
  const obj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : null;
  if (obj) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string') {
        const s = v.trim();
        if (s) {
          detail = s;
          break;
        }
      }
    }
  }
  if (!detail) {
    if (input == null) {
      detail = '';
    } else {
      try {
        const s = JSON.stringify(input);
        detail = s === 'null' ? '' : s;
      } catch {
        detail = '';
      }
    }
  }
  detail = detail.replace(/[\r\n]/g, ' ').slice(0, 200);
  return detail ? `🔧 ${name}: ${detail}` : `🔧 ${name}`;
}

/** Extract a one-line subject (command/path/pattern) from a tool input object. */
export function toolSubject(input: unknown): string {
  const keys = ['command', 'pattern', 'file_path', 'path', 'query', 'url', 'description'];
  const obj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : null;
  if (obj) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) {
        return v.trim().replace(/[\r\n]/g, ' ').slice(0, 200);
      }
    }
  }
  return '';
}

// Inline tool-event sentinel protocol (mirrors src/components/ai/lib/toolEvent.ts).
const TOOL_OPEN = '<<UGS_TOOL>>';
const TOOL_CLOSE = '<<UGS_TOOL_END>>';

/** Serialise a tool-event patch into an inline sentinel block for the stream. */
export function encodeToolPatch(patch: Record<string, unknown>): string {
  // Escape `<`/`>` in the payload (JSON.parse restores them) so a tool result
  // that itself contains the literal sentinel markers can't produce a stray
  // `<<UGS_TOOL_END>>` that would prematurely close the block.
  const payload = JSON.stringify(patch).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `\n${TOOL_OPEN}${payload}${TOOL_CLOSE}\n`;
}

/** The method/type discriminator of a codex JSONL event. */
function codexEventKind(event: Record<string, unknown>): string | undefined {
  const method = event.method;
  if (typeof method === 'string') return method;
  const type = event.type;
  if (typeof type === 'string') return type;
  return undefined;
}

/** Preserve native plan snapshots from both Codex JSONL transports. */
export function codexPlanPatch(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const kind = codexEventKind(event);
  const params = event.params && typeof event.params === 'object'
    ? event.params as Record<string, unknown> : event;
  if (kind === 'turn/plan/updated' || kind === 'turn.plan.updated') {
    if (!Array.isArray(params.plan)) return undefined;
    return { id: `plan:${params.turnId ?? 'current'}`, name: 'update_plan', status: 'done',
      args: { plan: params.plan, explanation: params.explanation } };
  }
  if (!['item.started', 'item.updated', 'item.completed', 'item/started', 'item/updated', 'item/completed'].includes(kind ?? '')) return undefined;
  const item = (event.item ?? params.item) as Record<string, unknown> | undefined;
  if (!item || !['todo_list', 'todoList', 'plan'].includes(String(item.type))) return undefined;
  return { id: `plan:${item.id ?? 'current'}`, name: 'update_plan', status: 'done',
    args: { plan: item.plan ?? item.items ?? item.todos } };
}

/** Pull the `item` payload out of a codex `item.completed`/`item/completed` event. */
export function codexCompletedItem(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const kind = codexEventKind(event);
  if (kind === 'item.completed' || kind === 'item/completed') {
    const item = event.item;
    if (typeof item === 'object' && item !== null) {
      return item as Record<string, unknown>;
    }
    const params = event.params;
    if (typeof params === 'object' && params !== null) {
      const nested = (params as Record<string, unknown>).item;
      if (typeof nested === 'object' && nested !== null) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** Build a readable progress line from a completed codex item (mirrors codex_progress_line). */
export function codexProgressLine(item: Record<string, unknown>): string | null {
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (itemType === 'agent_message') {
    const text = item.text;
    if (typeof text === 'string' && text.length > 0) return text;
    return null;
  }
  if (!itemType) return null;

  const keys = ['command', 'name', 'path', 'file_path', 'query', 'text', 'status'];
  let detail = '';
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) {
        detail = s.replace(/[\r\n]/g, ' ');
        break;
      }
    }
  }
  detail = detail.slice(0, 200);
  return detail ? `\n🔧 ${itemType}: ${detail}\n` : `\n🔧 ${itemType}\n`;
}

/** Extract a codex turn-completion status, or undefined (mirrors codex_turn_completion_status). */
export function codexTurnCompletionStatus(
  event: Record<string, unknown>,
): string | undefined {
  const kind = codexEventKind(event);
  if (kind === 'turn.completed' || kind === 'turn/completed' || kind === 'turn_complete') {
    const params = event.params as Record<string, unknown> | undefined;
    const turn =
      params && typeof params.turn === 'object' && params.turn !== null
        ? (params.turn as Record<string, unknown>)
        : undefined;
    const eventTurn =
      typeof event.turn === 'object' && event.turn !== null
        ? (event.turn as Record<string, unknown>)
        : undefined;
    const status =
      (turn && typeof turn.status === 'string' ? turn.status : undefined) ??
      (eventTurn && typeof eventTurn.status === 'string' ? eventTurn.status : undefined) ??
      (typeof event.status === 'string' ? event.status : undefined) ??
      'completed';
    return status;
  }
  return undefined;
}

/** Extract a codex turn-completion usage payload, when the JSONL event includes one. */
export function codexTurnUsage(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const kind = codexEventKind(event);
  if (kind !== 'turn.completed' && kind !== 'turn/completed' && kind !== 'turn_complete') {
    return undefined;
  }
  if (typeof event.usage === 'object' && event.usage !== null) {
    return event.usage as Record<string, unknown>;
  }
  const params =
    typeof event.params === 'object' && event.params !== null
      ? (event.params as Record<string, unknown>)
      : undefined;
  if (params && typeof params.usage === 'object' && params.usage !== null) {
    return params.usage as Record<string, unknown>;
  }
  const turn =
    params && typeof params.turn === 'object' && params.turn !== null
      ? (params.turn as Record<string, unknown>)
      : typeof event.turn === 'object' && event.turn !== null
        ? (event.turn as Record<string, unknown>)
        : undefined;
  if (turn && typeof turn.usage === 'object' && turn.usage !== null) {
    return turn.usage as Record<string, unknown>;
  }
  return undefined;
}

/** Whether a codex turn status string indicates success (mirrors codex_status_success). */
export function codexStatusSuccess(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === 'completed' || s === 'success' || s === 'succeeded' || s === 'ok';
}

/** A live sink for a CLI agent's progress chunks (stderr by default). */
export interface ProgressSink {
  write(chunk: string): void;
}

/** Build a {@link ProgressSink} that writes chunks to a stream (default process.stderr). */
export function streamSink(out: NodeJS.WriteStream = process.stderr): ProgressSink {
  return {
    write(chunk: string) {
      out.write(chunk);
    },
  };
}

// Evidence has its own budget; rich UI sentinels retain their existing clipping.
const NATIVE_EVENT_BYTES = 16384;
const NATIVE_SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|credential)/i;

/** Serialized-byte limit accounts for UTF-8 AND JSON escaping. */
function nativeText(text: string, maxBytes: number): string {
  const value = redactSkillText(text.slice(0, 65536), 65536);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle)), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function nativeArgs(value: unknown): unknown {
  let entries = 0;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number, key = ''): unknown => {
    if (NATIVE_SECRET_KEY.test(key)) return '[REDACTED]';
    if (typeof input === 'string') {
      // Never turn a truncated shell command into an apparent direct check.
      if (key === 'command' && input.length > 4096) return '[command exceeds evidence limit]';
      return nativeText(input, 4096);
    }
    if (!input || typeof input !== 'object') return typeof input === 'number' && !Number.isFinite(input) ? null : input;
    if (depth >= 4 || seen.has(input)) return '[bounded arguments]';
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 32).map((item) => ++entries > 128 ? '[bounded arguments]' : visit(item, depth + 1));
    const output: Record<string, unknown> = {};
    for (const field of Object.keys(input).slice(0, 32)) {
      if (++entries > 128) break;
      Object.defineProperty(output, field.slice(0, 128), { enumerable: true, configurable: true,
        value: visit((input as Record<string, unknown>)[field], depth + 1, field) });
    }
    return output;
  };
  const minimized = visit(value, 0);
  return Buffer.byteLength(JSON.stringify(minimized) ?? '', 'utf8') <= 4096 ? minimized : '[arguments exceed evidence limit]';
}

function nativeEvent(value: SkillNativeToolEvent): SkillNativeToolEvent[] {
  // Reject oversized identities, rather than inventing or repairing an id.
  if ([value.runId, value.toolCallId, value.toolName, value.parentId].some((id) => id !== undefined &&
    (typeof id !== 'string' || !id || Buffer.byteLength(id, 'utf8') > 1024))) return [];
  const event = { ...value, ...(value.args === undefined ? {} : { args: nativeArgs(value.args) }),
    ...(value.result === undefined ? {} : { result: nativeText(value.result, 8192) }) };
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > NATIVE_EVENT_BYTES) return [];
  return [event];
}

export interface CliNativeToolParserOptions {
  adapter: string;
  /** Host-owned run id, never taken from assistant text or stream metadata. */
  runId: string;
  now?: () => number;
}

/** Parse native JSON objects only; inline display sentinels are never evidence. */
export function createCliNativeToolParser(options: CliNativeToolParserOptions) {
  const tools = new Map<string, { name: string; parentId?: string; args?: unknown }>();
  const now = options.now ?? Date.now;
  return (value: unknown): SkillNativeToolEvent[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    let event = value as Record<string, unknown>;
    if (options.adapter === 'gemini') {
      const parentId = event.parent_id ?? event.parentId;
      if (event.type === 'tool_use') {
        event = { type: 'assistant', parent_tool_use_id: parentId, message: { content: [
          { type: 'tool_use', id: event.tool_id, name: event.tool_name, input: event.parameters },
        ] } };
      } else if (event.type === 'tool_result') {
        const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : undefined;
        event = { type: 'user', parent_tool_use_id: parentId, message: { content: [
          { type: 'tool_result', tool_use_id: event.tool_id, content: event.output ?? error?.message,
            is_error: error || /^(?:error|failed|failure)$/.test(String(event.status)) ? true : event.status === 'success' ? false : undefined,
            exit_code: event.exit_code !== undefined ? event.exit_code : event.exitCode },
        ] } };
      } else return [];
    }
    if (options.adapter === 'codex') {
      const kind = codexEventKind(event);
      const phase = kind === 'item.started' || kind === 'item/started' ? 'start'
        : kind === 'item.completed' || kind === 'item/completed' ? 'end' : undefined;
      const params = event.params && typeof event.params === 'object' ? event.params as Record<string, unknown> : event;
      const item = (event.item ?? params.item) as Record<string, unknown> | undefined;
      if (!phase || !item || typeof item.id !== 'string' || !item.id || !['command_execution', 'commandExecution', 'file_change', 'fileChange', 'mcp_tool_call', 'mcpToolCall', 'web_search', 'webSearch'].includes(String(item.type))) return [];
      const rawExit = item.exit_code !== undefined ? item.exit_code : item.exitCode;
      const exitCode = typeof rawExit === 'number' && Number.isSafeInteger(rawExit) || rawExit === null ? rawExit as number | null : undefined;
      const previous = tools.get(item.id);
      const parent = item.parent_id ?? item.parentId ?? params.parentId ?? event.parentId ?? previous?.parentId;
      const output = item.aggregated_output ?? item.aggregatedOutput ?? item.output ?? item.result;
      const result = typeof output === 'string' ? output : output !== undefined ? JSON.stringify(output) : '';
      const status = typeof exitCode === 'number' && exitCode !== 0 || /error|fail/i.test(String(item.status)) ? 'error'
        : exitCode === 0 || (!['command_execution', 'commandExecution'].includes(String(item.type)) && /^(completed|success|succeeded|ok)$/.test(String(item.status))) ? 'success' : 'unknown';
      const args: Record<string, unknown> = previous?.args && typeof previous.args === 'object' ? structuredClone(previous.args) as Record<string, unknown> : {};
      for (const key of ['command', 'changes', 'server', 'tool', 'arguments', 'query', 'url']) {
        if (item[key] !== undefined) args[key] = item[key];
      }
      if (phase === 'start') {
        if (tools.size >= 1024 && !tools.has(item.id)) tools.delete(tools.keys().next().value!);
        tools.set(item.id, { name: String(item.type), parentId: typeof parent === 'string' ? parent : undefined, args: nativeArgs(args) });
      }
      return nativeEvent({ runId: options.runId, toolCallId: item.id, toolName: String(item.type), phase,
        provenance: 'native-tool', occurredAt: now(), ...(typeof parent === 'string' && parent ? { parentId: parent } : {}), args,
        ...(phase === 'end' ? { result, status, ...(exitCode !== undefined ? { exitCode } : {}) } : {}),
      });
    }
    if (!['claude-code', 'claude', 'grok', 'gemini'].includes(options.adapter)) return [];
    const message = event.message as Record<string, unknown> | undefined;
    if (!Array.isArray(message?.content)) return [];
    const events: SkillNativeToolEvent[] = [];
    const parentId = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : undefined;
    for (const value of message.content) {
      if (!value || typeof value !== 'object') continue;
      const block = value as Record<string, unknown>;
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && block.id &&
        typeof block.name === 'string' && block.name) {
        const name = block.name;
        const args = nativeArgs(block.input);
        if (tools.size >= 1024 && !tools.has(block.id)) tools.delete(tools.keys().next().value!);
        tools.set(block.id, { name, parentId, args: structuredClone(args) });
        events.push(...nativeEvent({ runId: options.runId, toolCallId: block.id, toolName: name, phase: 'start',
          provenance: 'native-tool', occurredAt: now(), ...(parentId ? { parentId } : {}), args }));
      } else if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        let rawExit = block.exit_code !== undefined ? block.exit_code : block.exitCode;
        if (rawExit === undefined && event.tool_use_result && typeof event.tool_use_result === 'object') {
          const metadata = event.tool_use_result as Record<string, unknown>;
          const metadataId = metadata.tool_use_id ?? metadata.toolUseId;
          const results = message.content.filter((value) => value && typeof value === 'object' && value.type === 'tool_result');
          const correlated = typeof metadataId === 'string' ? metadataId === block.tool_use_id
            : metadataId === undefined && results.length === 1 && results[0].tool_use_id === block.tool_use_id;
          if (correlated) rawExit = metadata.exit_code !== undefined ? metadata.exit_code : metadata.exitCode;
        }
        const exitCode = typeof rawExit === 'number' && Number.isSafeInteger(rawExit) || rawExit === null ? rawExit as number | null : undefined;
        const result = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.map((block) => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n') : '';
        events.push(...nativeEvent({ runId: options.runId, toolCallId: block.tool_use_id, toolName: tool.name, phase: 'end',
          provenance: 'native-tool', occurredAt: now(), ...(parentId ?? tool.parentId ? { parentId: parentId ?? tool.parentId } : {}),
          args: tool.args, result, status: block.is_error === true || (typeof exitCode === 'number' && exitCode !== 0)
                      ? 'error' : block.is_error === false || exitCode === 0 ? 'success' : 'unknown',
                    ...(exitCode !== undefined ? { exitCode } : {}),
        }));
      }
    }
    return events;
  };
}
