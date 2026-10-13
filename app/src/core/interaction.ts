/**
 * CONTRACT: model-agnostic "node asks the user" protocol.
 *
 * A running workflow node is a one-shot CLI call (`claude -p`, `codex exec`,
 * `gemini …`). It cannot pause mid-turn to ask a question. So instead of relying
 * on each model's native tool-calling format, we *impose* a single convention on
 * every model: when a node needs the user to choose between options or type
 * something, it emits a delimited JSON block and ends its turn:
 *
 *     <<UGS_ASK>>
 *     { "type": "select", "prompt": "选择部署环境", "options": ["staging","prod"] }
 *     <<UGS_ASK_END>>
 *
 * The run loop parses that block, renders an interactive widget in the AI-return
 * dock, waits for the user's answer, appends the answer to the node prompt, and
 * re-invokes the node (bounded loop). Because the instruction is injected by us
 * — not parsed out of a provider-specific tool schema — the same parser works
 * for Claude, Codex, Gemini, and any future CLI.
 *
 * This module is pure (no React / no store). It owns: the protocol instruction
 * text, the request/answer types, and the tolerant parse / strip / format-back
 * helpers.
 */

import { MEMORY_OPEN } from './memoryProtocol';
import { RECALL_OPEN } from './recallProtocol';

/** The kinds of user interaction a node can request. */
export type InteractionKind = 'select' | 'input' | 'confirm';

/** A request emitted by a node that the UI renders as a widget. */
export interface InteractionRequest {
  type: InteractionKind;
  /** Question / instruction shown to the user. */
  prompt: string;
  /** `select`: the choices. */
  options?: string[];
  /** `select`: allow choosing more than one. */
  multi?: boolean;
  /** `select`: render a free-text input below the option buttons so the user
   *  can type a custom answer instead of picking a preset. */
  allowInput?: boolean;
  /** `input`: placeholder text for the field. */
  placeholder?: string;
  /** `input`: render a multi-line textarea instead of a single-line field. */
  multiline?: boolean;
  /** `confirm`: label for the affirmative button (default "确定"). */
  confirmLabel?: string;
  /** `confirm`: label for the negative button (default "取消"). */
  cancelLabel?: string;
}

/** The user's reply to an {@link InteractionRequest}. */
export interface InteractionAnswer {
  kind: InteractionKind;
  /** `select`: the chosen option label(s). */
  values?: string[];
  /** `input`: the typed text. */
  text?: string;
  /** `confirm`: whether the user confirmed. */
  confirmed?: boolean;
}

const ASK_OPEN = '<<UGS_ASK>>';
const ASK_CLOSE = '<<UGS_ASK_END>>';

// Tolerant sentinel matchers. Models routinely fumble the exact delimiter —
// dropping a `>` (`<<UGS_ASK>`), adding a third (`<<UGS_ASK>>>`), or slipping in
// whitespace (`<< UGS_ASK >>`). A strict `indexOf('<<UGS_ASK>>')` misses those,
// so the whole reply (raw protocol JSON and all) leaks into the chat bubble and
// no interaction widget renders. These regexes accept any positive number of
// trailing `>` and stray inner whitespace. The open matcher can't collide with
// the close sentinel because `UGS_ASK` there is immediately followed by `_END`,
// not `>`/whitespace.
const ASK_OPEN_RE = /<<\s*UGS_ASK\s*>+/;
const ASK_CLOSE_RE = /<<\s*UGS_ASK_END\s*>+/;

/** Locate a sentinel; returns its start index and matched length, or null. */
function findSentinel(
  text: string,
  re: RegExp,
  from = 0,
): { index: number; length: number } | null {
  const scoped = new RegExp(re.source, 'g');
  scoped.lastIndex = from;
  const m = scoped.exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

/** Index of the (tolerant) opening sentinel, or -1. */
function askOpenIndex(text: string): number {
  return findSentinel(text, ASK_OPEN_RE)?.index ?? -1;
}

/**
 * Instruction block appended to every executable node prompt. Kept terse and
 * imperative so weaker models still follow it. The key rules: ask only when
 * genuinely blocked, emit ONLY the block (no surrounding prose), one block at a
 * time, and never invent options the user didn't imply.
 */
export const INTERACTION_PROTOCOL = `---
用户交互协议（重要）：
当且仅当你确实需要用户做出选择，或需要用户补充一段你无法自行决定的信息时，不要用自然语言提问，而是只输出下面这个交互块，然后立刻结束本回合，不要再输出其它任何文字：

${ASK_OPEN}
{"type":"select","prompt":"问题（简体中文）","options":["选项A","选项B"],"multi":false,"allowInput":true}
${ASK_CLOSE}

可用的 type：
- "select"：让用户在 options 中选择；需要多选时设 "multi":true。推荐设 "allowInput":true，选项下方会显示输入框，用户可直接输入自定义内容，不必从预设里选。
- "input"：让用户输入文本；可选 "placeholder"、"multiline":true（多行）。
- "confirm"：让用户确认是否继续；可选 "confirmLabel"、"cancelLabel"。
规则：
- prompt 用简体中文，简洁清楚。
- 一次只问一个交互块。
- 块内必须是单个合法 JSON，不要加注释或多余文字。
- 如果你已经掌握足够信息（例如下方已给出用户的上一次回答），就不要再提问，直接给出最终结果。
- 不需要用户参与时，正常输出结果即可，不要输出交互块。
- 严禁把"额外建议""推荐下一步""你可以试试 X 或 Y"之类的收尾性建议包成交互块。只有当缺少用户输入就**无法继续**、且你无法自行合理假设时才出交互块；主问题已回答完后，任何追加建议一律用普通文字陈述，不要变成可点击选项。
- 不要为了"显得在征求用户意见"而出交互块；只有真正阻塞、必须用户拍板才能继续时才出。
- 如果上下文里给出了「已确认基线」或「你上一轮的结论」，一律直接沿用：不要重新判定、不要重新读一遍已读过的资料、不要重发已经产出过的完整交付物。`;

/** Coerce an unknown value into a clean string[]; drops empties, de-dupes. */
function toOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Pull the first balanced `{…}` object span out of a string, or null. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a node's output for an interaction request. Keyed strictly on the
 * `<<UGS_ASK>>` sentinel — a unique token we inject and instruct every model to
 * use — so normal output that happens to contain JSON (e.g. a code-generating
 * node) never false-positives and wrongly pauses the run. Returns null when no
 * valid request is present.
 */
export function parseInteraction(text: string): InteractionRequest | null {
  if (!text) return null;

  const open = findSentinel(text, ASK_OPEN_RE);
  if (!open) return null;
  const afterOpen = text.slice(open.index + open.length);
  const close = findSentinel(afterOpen, ASK_CLOSE_RE);
  // Require a closing sentinel: an unterminated block usually means the reply
  // was cut off mid-stream, and pausing on a half-written request would strand
  // the run. (Covered by "does not pause … on an unterminated interaction block".)
  if (!close) return null;
  const body = afterOpen.slice(0, close.index);
  const jsonSpan = firstJsonObject(body);
  if (!jsonSpan) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonSpan) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = raw.type;
  if (type !== 'select' && type !== 'input' && type !== 'confirm') return null;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return null;

  if (type === 'select') {
    const options = toOptions(raw.options);
    if (options.length === 0) return null; // a select with no options is unusable
    return {
      type,
      prompt,
      options,
      multi: raw.multi === true,
      allowInput: raw.allowInput === true,
    };
  }
  if (type === 'input') {
    return {
      type,
      prompt,
      placeholder:
        typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
      multiline: raw.multiline === true,
    };
  }
  return {
    type,
    prompt,
    confirmLabel:
      typeof raw.confirmLabel === 'string' ? raw.confirmLabel : undefined,
    cancelLabel:
      typeof raw.cancelLabel === 'string' ? raw.cancelLabel : undefined,
  };
}

/**
 * Return the node output with the interaction block (and anything after it)
 * removed, so the streamed message doesn't show raw protocol JSON. Any prose the
 * model emitted *before* the block is preserved.
 */
export function stripInteraction(text: string): string {
  const open = askOpenIndex(text);
  if (open !== -1) return text.slice(0, open).trim();
  return text.trim();
}

/** Tool sentinel delimiters — mirror `TOOL_OPEN`/`TOOL_CLOSE` in
 * `components/ai/lib/toolEvent.ts` without importing UI-layer code here (this
 * module is also shared by the headless CLI host). */
const TOOL_SENTINEL_OPEN = '<<UGS_TOOL>>';
const TOOL_SENTINEL_CLOSE = '<<UGS_TOOL_END>>';

/**
 * Index of the first ``` code fence that lies *outside* any tool sentinel
 * payload (`<<UGS_TOOL>>…<<UGS_TOOL_END>>`). Tool results routinely contain
 * literal backticks (markdown files, diffs, compile logs); treating those as
 * the hidden IRGraph fence would cut the live bubble at the first tool result
 * and make the stream look frozen. Returns -1 when no such fence exists.
 */
function firstProseFenceIndex(text: string): number {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(TOOL_SENTINEL_OPEN, i);
    if (open === -1) return text.indexOf('```', i);
    const hit = text.indexOf('```', i);
    if (hit !== -1 && hit < open) return hit;
    // Skip the whole sentinel; if the close is missing (streaming tail),
    // treat the rest of the text as payload and stop scanning.
    const close = text.indexOf(TOOL_SENTINEL_CLOSE, open + TOOL_SENTINEL_OPEN.length);
    i = close === -1 ? text.length : close + TOOL_SENTINEL_CLOSE.length;
  }
  return -1;
}

/**
 * The prefix of a streaming reply that is safe to show live: everything before
 * either a ``` code fence (the hidden IRGraph payload in the AI-edit flow) or an
 * interaction block. Keeps both the JSON graph and the raw protocol out of the
 * visible message while tokens are still arriving.
 *
 * The fence scan skips tool-sentinel payloads (`<<UGS_TOOL>>…<<UGS_TOOL_END>>`),
 * whose results may legitimately contain backticks. Pass `cutAtFence = false`
 * for plain chat streams, where the model's own code blocks are real content
 * and must stream visibly instead of being hidden.
 */
export function liveProse(text: string, cutAtFence = true): string {
  const cuts: number[] = [];
  const ask = askOpenIndex(text);
  if (ask !== -1) cuts.push(ask);
  const fence = cutAtFence ? firstProseFenceIndex(text) : -1;
  if (fence !== -1) cuts.push(fence);
  const mem = text.indexOf(MEMORY_OPEN);
  if (mem !== -1) cuts.push(mem);
  const recall = text.indexOf(RECALL_OPEN);
  if (recall !== -1) cuts.push(recall);
  const visible = cuts.length === 0 ? text : text.slice(0, Math.min(...cuts)).trimEnd();
  return compactRuntimeHeartbeatLines(visible);
}

const RUNTIME_HEARTBEAT_LINE_RE =
  /^\s*(?:⏳\s*)?仍在运行[.…。]*(?:[（(]已\s*\d+\s*s[）)])?\s*$/u;

/**
 * Strip ephemeral progress markers the Rust backend injects via the
 * `ai-cli-progress` event channel — e.g. "⏳ 正在请求模型…",
 * "⚙ 会话已启动（…），开始处理…", "⚠ …". These lines are meant to be
 * live-only placeholders and must never leak into the finalized chat
 * bubble. They become a problem when the CLI's terminal `result` field
 * is empty and the chat loop falls back to the streamed `live` buffer
 * (which contains those markers) — without this strip the bubble would
 * show "⏳ 正在请求模型…" permanently while the node is actually parked
 * on a `<<UGS_ASK>>` interaction. Tool-patch sentinels (`<<UGS_TOOL>>`)
 * are not touched here; they are extracted separately via
 * `extractToolSentinels`.
 */
export function stripCliProgressMarkers(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/u);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // preserve blank structural lines
    return !/^(?:⏳|⚙|⚠)/u.test(trimmed);
  });
  return kept.join('\n').trim();
}

/**
 * Keep only a tail-position runtime heartbeat; drop stale "still running" lines.
 */
export function compactRuntimeHeartbeatLines(text: string): string {
  if (!text.includes('仍在运行')) return text;
  const lines = text.split(/\r?\n/u);
  const heartbeatIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (RUNTIME_HEARTBEAT_LINE_RE.test(lines[i])) heartbeatIndexes.push(i);
  }
  if (heartbeatIndexes.length === 0) return text;

  const lastHeartbeat = heartbeatIndexes[heartbeatIndexes.length - 1];
  const keepLast =
    lines.slice(lastHeartbeat + 1).every((line) => line.trim().length === 0);
  const drop = new Set(
    keepLast
      ? heartbeatIndexes.slice(0, -1)
      : heartbeatIndexes,
  );
  return lines.filter((_, index) => !drop.has(index)).join('\n');
}

/** Human-readable one-line summary of an answer (for the answered widget). */
export function summarizeAnswer(
  req: InteractionRequest,
  answer: InteractionAnswer,
): string {
  switch (req.type) {
    case 'select':
      return (answer.values ?? []).join('、') || '(未选择)';
    case 'input':
      return (answer.text ?? '').trim() || '(空)';
    case 'confirm':
      return answer.confirmed
        ? req.confirmLabel ?? '确定'
        : req.cancelLabel ?? '取消';
  }
}

/** Replies longer than this are deliverables, not parked questions. */
const FALLBACK_MAX_REPLY_CHARS = 1200;

/**
 * How far back from the last `?` an option list may start. Bounds the scan for
 * a single-paragraph reply, which has no blank line to anchor on.
 */
const FALLBACK_WINDOW_CHARS = 600;

/** Horizontal rule (`---`, `***`, `___`) — markdown structure, never a choice. */
const HORIZONTAL_RULE_RE = /^\s*(?:[-*_]\s*){3,}$/u;

/** A line starting with markdown block syntax is prose, not a choice. */
const MARKDOWN_BLOCK_RE = /^(?:#{1,6}\s|>\s?|\||`{3})/u;

/**
 * Reject a candidate option label that is markdown structure rather than a real
 * choice. Session 037bb1b8 shipped a widget whose options were `--` (a `---`
 * rule split in half by the bullet regex) and `*答案要点：**` (a bolded bullet).
 */
function isUsableOptionLabel(label: string): boolean {
  const s = label.trim();
  if (!s) return false;
  if (HORIZONTAL_RULE_RE.test(s)) return false;
  if (MARKDOWN_BLOCK_RE.test(s)) return false;
  if (s.includes('**') || s.includes('__')) return false;
  // Must carry at least one letter / digit / CJK char, so a mis-split fragment
  // of punctuation alone never becomes a clickable choice.
  return /[\p{L}\p{N}]/u.test(s);
}

/** Trailing markdown decoration (`**`, `_`, `` ` ``, `~~`) on a line. */
const TRAILING_MARKUP_RE = /[\s*_~`]+$/u;

/**
 * Questions that ask for PERMISSION to take the next step ("要我继续吗？",
 * "需要我把这份导出成 docx 吗？") rather than for a missing piece of
 * information. Kimi's own harness instructs the model to close every turn with
 * a question, and its in-body fallback wording is exactly this shape; turning
 * each one into a widget is what made a single request feel like an endless
 * Q&A loop. Such a question finalizes the turn instead — if the user does want
 * the next step, "继续" is one message away.
 *
 * Deliberately narrow: it needs both an "asking permission" stem and a concrete
 * follow-up action, so a real information request ("你想要几个难度档位？")
 * still parks on an input box.
 */
const PERMISSION_ASK_RE =
  /(?:要不要|需不需要|用不用|是否要|是否|要|需要)\s*(?:我|我来|我帮|我帮你|帮你)?[^。！？!?]{0,30}?(?:继续|接着|往下|导出|输出|生成|补充|补全|保存|打包|整理|贴出|贴出来|写|做|处理|开始|动手|发你|发给你|给你)/u;

/** English equivalent of {@link PERMISSION_ASK_RE}. */
const PERMISSION_ASK_EN_RE =
  /\b(?:shall|should|do you want me to|would you like me to|want me to)\b[^.?]{0,40}?(?:continue|proceed|go on|keep going|export|save|generate)\b/iu;

/** True when the closing question is only asking to proceed. */
function isPermissionSeekingQuestion(text: string): boolean {
  return PERMISSION_ASK_RE.test(text) || PERMISSION_ASK_EN_RE.test(text);
}

/**
 * Take the closing clause of `text`, at most `maxChars` long, dropping the
 * leading partial sentence when we had to cut. Used to keep a synthesized
 * prompt readable when the "question paragraph" is actually a long document.
 */
function tailClause(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const cut = tail.search(/[。！？!?；;]/u);
  return (cut === -1 ? tail : tail.slice(cut + 1)).trim();
}

/**
 * Fallback for when the model ignores the `<<UGS_ASK>>` protocol and asks its
 * question as plain text — e.g. "滑条要放在哪里？A) 顶部 B) 底部". Without
 * this the user sees a bubble ending in `?`, no widget, and the chat turn
 * stays parked on `awaitInteraction` forever (the "sent it and nothing
 * happened" stall).
 *
 * Heuristic, gated by the caller on a settings toggle:
 * - The reply must contain at least one `?` / `？`; we anchor on the LAST one.
 * - Everything after that last `?` must be blank lines or choice lines — the
 *   model may list options *under* the question ("…？\nA) 顶部\nB) 底部"), so
 *   we don't require the reply to literally end with `?`. But if non-choice
 *   prose sits between the last `?` and the end, the model wasn't actually
 *   waiting on an answer (it was mid-explanation) and we must not pause.
 * - Choice-line patterns: `- foo`, `1. foo`, `A) foo`, `（B）foo` — at least
 *   two distinct choices makes it a `select`; otherwise it's an `input`, unless
 *   the question only asks for permission to proceed, in which case the turn
 *   finalizes with no widget.
 * - The prompt is the paragraph containing the last `?` (from the most recent
 *   blank-line break onward), with choice lines stripped when we matched them.
 * - Trailing markdown decoration is ignored when deciding whether the reply
 *   ends on the question, so `**要我继续吗？**` behaves like `要我继续吗？`.
 *
 * Guards added after session 037bb1b8: a model answered with a multi-thousand
 * character question bank that ended in "要不要我把这份导出成 docx？". The old
 * heuristic harvested options from the WHOLE reply, so the bank's `- ` bullets
 * became the widget's choices (the user was literally offered `--` and
 * `*答案要点：**`), and every answer re-ran the task from scratch:
 * - length cap ({@link FALLBACK_MAX_REPLY_CHARS}): a long reply is a
 *   deliverable, not a parked question — bail out and let the turn finalize;
 * - options come only from the tail window (the last paragraph holding the `?`
 *   plus the lines after it), never from the whole document;
 * - markdown junk is rejected as an option label ({@link isUsableOptionLabel}).
 *
 * `allowInput: true` is always set on the synthesized select so the user can
 * escape a wrong detection by typing their own answer. We deliberately never
 * return `confirm` here — a false-positive confirm has no safe default.
 *
 * Returns null when the text doesn't look like a question, so the caller can
 * fall through to the plain-bubble path.
 */
export function detectFallbackInteraction(text: string): InteractionRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A long reply is a deliverable (a report, a question bank, a doc), not a
  // model parked on a question. Treating it as an interaction both fabricates
  // options out of its markdown bullets and re-runs the whole task on answer.
  if (trimmed.length > FALLBACK_MAX_REPLY_CHARS) return null;

  // Choice-line patterns. Each match captures the label without its leading
  // bullet; we keep them in encounter order, deduped, capped at 6 so an
  // accidental match on a long list can't produce an unwieldy widget.
  const CHOICE_LINE_RE =
    /^\s*(?:[-*•]|\d{1,2}\s*[.、)）]|[A-Ha-hＡ-Ｈａ-ｈ]\s*[.、)）]|[(（]\s*[A-Ha-hＡ-Ｈａ-ｈ]\s*[)）])\s*(.{2,80}?)\s*$/gm;

  const isChoiceLine = (line: string): boolean => {
    CHOICE_LINE_RE.lastIndex = 0;
    const hit = CHOICE_LINE_RE.exec(line);
    return hit !== null && isUsableOptionLabel(hit[1]);
  };

  // Locate the LAST question mark (`?` / `？`) in the reply. The question is
  // the "tail" the user must respond to; everything after it must be either
  // blank lines or choice lines (the options the model listed under the
  // question). If any non-blank non-choice content sits between the last "?"
  // and the end of the reply, the model wasn't actually waiting on an answer
  // — it was mid-explanation — and we must not pause the turn.
  const lastQuestionIdx = (() => {
    const half = trimmed.lastIndexOf('?');
    const full = trimmed.lastIndexOf('？');
    return Math.max(half, full);
  })();
  if (lastQuestionIdx === -1) return null;
  const tailAfterQuestion = trimmed.slice(lastQuestionIdx + 1);
  const tailLines = tailAfterQuestion.split(/\r?\n/);
  for (const line of tailLines) {
    // Strip trailing markdown decoration first: a bolded question
    // (`**要我继续吗？**`) leaves a bare `**` after the `?`, which the old
    // check misread as non-choice prose and rejected — the same sentence
    // parked the turn or not depending on whether the model bolded it.
    const s = line.trim().replace(TRAILING_MARKUP_RE, '');
    if (!s) continue;
    if (!isChoiceLine(s)) return null;
  }

  // The prompt source is the paragraph containing the last `?`; the option
  // source is that paragraph plus everything after it. Never the whole reply:
  // earlier sections are a document the user already read, and harvesting their
  // bullets is what produced the `--` / `*答案要点：**` widget in session
  // 037bb1b8. For a single-paragraph reply there is no blank line to anchor on,
  // so the window is additionally capped to a bounded lookback.
  const upToQuestionEnd = trimmed.slice(0, lastQuestionIdx + 1);
  const lastParaBreak = Math.max(
    upToQuestionEnd.lastIndexOf('\n\n'),
    upToQuestionEnd.lastIndexOf('\r\n\r\n'),
  );
  const windowStart = Math.max(
    lastParaBreak,
    lastQuestionIdx - FALLBACK_WINDOW_CHARS,
    0,
  );
  const questionBlock = (lastParaBreak === -1
    ? upToQuestionEnd
    : upToQuestionEnd.slice(lastParaBreak + 1)
  ).trim();

  const options: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CHOICE_LINE_RE.lastIndex = 0;
  const scanRegion = trimmed.slice(windowStart);
  while ((m = CHOICE_LINE_RE.exec(scanRegion)) !== null) {
    const label = m[1].trim().replace(/[。；;，,]\s*$/, '');
    if (!isUsableOptionLabel(label) || seen.has(label)) continue;
    seen.add(label);
    options.push(label);
    if (options.length >= 6) break;
  }

  // Pull the question itself for the prompt. If we matched options, strip the
  // choice lines so the prompt reads as a single question; otherwise keep the
  // full trimmed tail (bounded to a sane widget length). We only surface the
  // text from the most recent paragraph break onward — earlier prose in the
  // same reply is context the user has already read, not part of the question.
  const promptSource = options.length >= 2
    ? questionBlock
        .split(/\r?\n/)
        .filter((line) => !isChoiceLine(line))
        .join(' ')
        .trim()
    : questionBlock;
  const prompt = tailClause(promptSource || trimmed, 200).trim();
  if (!prompt) return null;

  if (options.length >= 2) {
    return { type: 'select', prompt, options, multi: false, allowInput: true };
  }
  // No choices under the question and the question only asks to proceed:
  // finalize. Park on nothing rather than on a one-field form the user has to
  // fill in just to say "yes, carry on" (see {@link PERMISSION_ASK_RE}).
  if (isPermissionSeekingQuestion(prompt)) return null;
  return { type: 'input', prompt, multiline: false };
}

/**
 * True when an answer carries content worth pinning as a confirmed fact.
 * Rejects the degenerate cases the fallback widget can produce — an unanswered
 * box, or a junk option label (`--`, `*答案要点：**`) the user clicked by
 * accident — so they never get promoted to "已确认基线" for later rounds.
 */
export function isPinnableAnswer(
  req: InteractionRequest,
  answer: InteractionAnswer,
): boolean {
  const text = summarizeAnswer(req, answer).trim();
  if (text === '(未选择)' || text === '(空)') return false;
  return isUsableOptionLabel(text);
}

/** Cumulative context threaded through the multi-round interaction loop. */
export interface InteractionBaseline {
  /**
   * The model's own lead paragraph from the round that produced the current
   * deliverable — e.g. "简历读完。背景：TA 实习，Unity URP…". Pinning it stops
   * the next round from re-reading the source material and re-labelling the
   * task: session 037bb1b8 drifted 技术美术 → 图形引擎(HDRP) → 客户端(UE) across
   * five rounds of the SAME request, because each round re-judged from scratch.
   */
  roundConclusion?: string;
  /** Earlier answered interactions, oldest first. */
  confirmations?: readonly string[];
}

/**
 * Lead paragraph of a model reply with CLI status noise and protocol sentinels
 * removed — the raw material for {@link InteractionBaseline.roundConclusion}.
 * Returns '' when the reply has no usable prose.
 */
export function extractLeadConclusion(text: string, maxChars = 400): string {
  const kept: string[] = [];
  for (const raw of stripCliProgressMarkers(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) {
      if (kept.length) break;
      continue;
    }
    // Tool/prompt sentinels and status glyphs are not prose: skip them while
    // still looking for the opening paragraph, stop once it has started.
    if (line.includes('<<UGS_')) {
      if (kept.length) break;
      continue;
    }
    if (/^[⏱⏳⚙⚠]/u.test(line)) {
      if (kept.length) break;
      continue;
    }
    if (HORIZONTAL_RULE_RE.test(line)) {
      if (kept.length) break;
      continue;
    }
    kept.push(line);
    if (kept.join(' ').length >= maxChars) break;
  }
  const block = kept.join(' ').replace(/\s+/gu, ' ').trim();
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}

/**
 * Build the appendix fed back into the node prompt on re-invocation, so the
 * model continues with the user's answer instead of asking again.
 *
 * `baseline` (optional — callers that don't thread it get the original text
 * byte-for-byte) pins what is already settled, so a re-invocation cannot
 * silently re-decide it.
 */
export function formatAnswerForPrompt(
  req: InteractionRequest,
  answer: InteractionAnswer,
  baseline?: InteractionBaseline,
): string {
  const lines = [
    '---',
    '用户已回复你上一次的交互请求：',
    `- 你的问题：${req.prompt}`,
    `- 用户的回答：${summarizeAnswer(req, answer)}`,
  ];
  const pinned: string[] = [];
  const conclusion = baseline?.roundConclusion?.trim();
  if (conclusion) {
    pinned.push(
      `你上一轮的结论（已确认，必须沿用，不得重新判定或推翻）：${conclusion}`,
    );
  }
  const confirmations = (baseline?.confirmations ?? []).filter(
    (item) => item.trim().length > 0,
  );
  if (confirmations.length) {
    pinned.push('已确认基线（用户已拍板，后续所有输出必须与之一致）：');
    confirmations.forEach((item, index) => {
      pinned.push(`${index + 1}. ${item}`);
    });
  }
  if (pinned.length) lines.push('', ...pinned);
  lines.push('请基于这个回答继续，不要重复提问，直接产出最终结果。');
  return lines.join('\n');
}
