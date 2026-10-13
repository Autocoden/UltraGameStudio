import { describe, it, expect } from 'vitest';
import {
  parseInteraction,
  stripInteraction,
  liveProse,
  detectFallbackInteraction,
  extractLeadConclusion,
  formatAnswerForPrompt,
  isPinnableAnswer,
} from './interaction';

// Regression: models frequently fumble the opening sentinel — a dropped `>`
// (`<<UGS_ASK>`), an extra one (`<<UGS_ASK>>>`), or stray whitespace. The strict
// `indexOf('<<UGS_ASK>>')` used to miss those, leaking raw protocol JSON into the
// chat bubble and rendering no interaction widget.
describe('tolerant UGS_ASK sentinel matching', () => {
  const cases: Array<[string, string]> = [
    ['single >', '<<UGS_ASK>'],
    ['triple >', '<<UGS_ASK>>>'],
    ['inner spaces', '<< UGS_ASK >>'],
  ];

  for (const [name, open] of cases) {
    const text = `前言正文。\n\n${open}\n{"type":"confirm","prompt":"要改名吗？","confirmLabel":"改","cancelLabel":"先别动"}\n<<UGS_ASK_END>>`;

    it(`parses a confirm request with a ${name} open sentinel`, () => {
      const req = parseInteraction(text);
      expect(req).not.toBeNull();
      expect(req!.type).toBe('confirm');
      expect(req!.prompt).toBe('要改名吗？');
    });

    it(`strips the block for a ${name} open sentinel`, () => {
      expect(stripInteraction(text)).toBe('前言正文。');
    });

    it(`liveProse cuts at a ${name} open sentinel`, () => {
      expect(liveProse(text)).toBe('前言正文。');
    });
  }

  it('still requires a closing sentinel (unterminated block is not a request)', () => {
    const text = `前言。\n\n<<UGS_ASK>\n{"type":"confirm","prompt":"要改名吗？"}`;
    expect(parseInteraction(text)).toBeNull();
  });
});

// Root-cause regression: `liveProse` used to scan the whole stream for the first
// ``` and cut there. Tool-result sentinels (`<<UGS_TOOL>>…<<UGS_TOOL_END>>`)
// routinely contain literal backticks (markdown files, diffs, compile logs), so
// the live bubble got truncated at the first tool result and only refreshed at
// round end ("stream frozen, then a sudden full refresh").
describe('liveProse tool-sentinel fence handling', () => {
  const toolBlock =
    `<<UGS_TOOL>>${JSON.stringify({
      id: 't1',
      name: 'Read',
      subject: 'README.md',
      status: 'done',
      result: '\n```\n# 标题\n```\n',
    })}<<UGS_TOOL_END>>`;

  it('does not cut inside a tool sentinel payload that contains ```', () => {
    const text = `好的，我先读取这个文件。\n${toolBlock}\n文件读完了，接下来开始编译。`;
    const out = liveProse(text);
    expect(out).toBe(text);
    expect(out).toContain('文件读完了，接下来开始编译。');
  });

  it('does not cut inside an unterminated tool payload that contains ```', () => {
    const text = '开头。\n<<UGS_TOOL>>{"id":"t1","result":"\n```\n半截载荷';
    const out = liveProse(text);
    expect(out).toBe(text.trimEnd());
  });

  it('still cuts at a real fence in prose (blueprint flow regression guard)', () => {
    const text = '先看说明。\n```json\n{"a":1}\n```\n后面还有正文';
    expect(liveProse(text)).toBe('先看说明。');
  });

  it('cutAtFence=false keeps real code fences visible (plain chat)', () => {
    const text = '先看说明。\n```ts\nconst x = 1;\n```\n后面还有正文';
    expect(liveProse(text, false)).toBe(text.trimEnd());
  });
});

// Regression (session 037bb1b8): a model answered with a ~10k-char interview
// question bank that ended in "要不要我把这份导出成 docx 放到 … 下？". The
// fallback harvested option lines from the WHOLE reply, so the bank's own
// markdown bullets became the widget's choices — the user was offered `--`
// (half of a `---` rule) and `*答案要点：**` (a bolded bullet). Answering one
// re-ran the task and re-emitted the entire bank; the same request produced
// five different answers in one turn.
describe('detectFallbackInteraction guards', () => {
  const bank = Array.from(
    { length: 12 },
    (_, i) =>
      `## Q${i + 1}. 渲染管线基础\n**问题：** URP 中 RenderFeature 的注入点有哪些？\n**答案要点：**\n- 注入点：BeforeRendering、AfterRenderingTransparents 等\n- 若涉及深度依赖，需注意深度是否仍可访问\n- 观察候选人是否理解"物体级排序"的局限\n\n---\n`,
  ).join('\n');
  const longReply = `${bank}\n要不要我把这份导出成 docx 放到 .ultragamestudio/docs/dev/ 下？或者哪题难度需要再调？`;

  it('bails out on a long deliverable that merely ends in a question', () => {
    expect(longReply.length).toBeGreaterThan(1200);
    expect(detectFallbackInteraction(longReply)).toBeNull();
  });

  it('never harvests options from an earlier section of the reply', () => {
    const text = [
      '## 题目正文',
      '- 这是文档正文第一条，不是选项',
      '- 这是文档正文第二条，不是选项',
      '',
      '导出目录用哪个？',
    ].join('\n');
    const req = detectFallbackInteraction(text);
    expect(req).not.toBeNull();
    // No choices under the question → an input box, never a fabricated select.
    expect(req!.type).toBe('input');
    expect(req!.prompt).toContain('导出目录用哪个');
    expect(JSON.stringify(req)).not.toContain('文档正文第一条');
  });

  it('rejects markdown structure as option labels', () => {
    expect(detectFallbackInteraction('要不要导出？\n---')).toBeNull();
    expect(
      detectFallbackInteraction('要不要导出？\n- **答案要点：** foo\n- **评分锚点：** bar'),
    ).toBeNull();
  });

  it('ignores trailing markdown when deciding the reply ends on the question', () => {
    // The `?` is followed by the closing `**`. The old tail check read that as
    // non-choice prose and bailed, so the SAME sentence parked the turn or not
    // depending on whether the model bolded it.
    expect(detectFallbackInteraction('**要我继续吗？**')).toBeNull();
    const req = detectFallbackInteraction('**滑条要放在哪里？**\n- 顶部\n- 底部');
    expect(req).not.toBeNull();
    expect(req!.type).toBe('select');
    expect(req!.options).toEqual(['顶部', '底部']);
  });

  it('finalizes instead of parking on a permission-seeking question', () => {
    // Kimi's harness closes every turn with a question; each one used to become
    // an input box the user had to fill in just to say "carry on".
    expect(detectFallbackInteraction('要我继续吗？')).toBeNull();
    expect(detectFallbackInteraction('需要我把这份导出成 docx 吗？')).toBeNull();
    expect(detectFallbackInteraction('要不要我把结果贴出来？')).toBeNull();
    expect(detectFallbackInteraction('Shall I continue?')).toBeNull();
    // Choice lines under the question still win: the user gets real buttons.
    expect(
      detectFallbackInteraction('要不要继续？\n- 继续\n- 停在这里'),
    )?.toMatchObject({ type: 'select' });
  });

  it('still detects a genuine short question with real options', () => {
    const req = detectFallbackInteraction('滑条要放在哪里？\n- 顶部\n- 底部');
    expect(req).not.toBeNull();
    expect(req!.type).toBe('select');
    expect(req!.options).toEqual(['顶部', '底部']);
    expect(req!.prompt).toBe('滑条要放在哪里？');
    expect(req!.allowInput).toBe(true);
  });

  it('still detects a short question with no options as an input', () => {
    const req = detectFallbackInteraction('你想要几个难度档位？');
    expect(req).not.toBeNull();
    expect(req!.type).toBe('input');
  });
});

// The anti-drift anchor: pin the model's own lead paragraph from the previous
// round so a re-invocation cannot silently re-judge the task. In session
// 037bb1b8 the same candidate was labelled 技术美术 → 图形引擎(HDRP) → 客户端(UE)
// across five rounds of one request.
describe('extractLeadConclusion', () => {
  it('skips CLI status lines and tool sentinels, keeps the first paragraph', () => {
    const raw = [
      '⏱ 10:03:09 → 10:23:49 · 耗时 20m 40s',
      '⚙ 会话已启动（kimi-k3），开始处理…',
      '⏳ 正在请求模型…',
      '',
      '<<UGS_TOOL>>{"name":"Read","status":"done"}<<UGS_TOOL_END>>',
      '',
      '读完简历了。这是客户端方向的候选人。',
      '',
      '后面是题库正文。',
    ].join('\n');
    expect(extractLeadConclusion(raw)).toBe('读完简历了。这是客户端方向的候选人。');
  });

  it('caps the conclusion length', () => {
    const out = extractLeadConclusion('啊'.repeat(100), 10);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty string when there is no prose', () => {
    expect(extractLeadConclusion('⚙ 会话已启动\n<<UGS_TOOL>>{}<<UGS_TOOL_END>>')).toBe('');
  });
});

describe('formatAnswerForPrompt', () => {
  const req = { type: 'input' as const, prompt: '要导出吗？' };

  it('keeps the original text byte-for-byte when no baseline is threaded', () => {
    expect(formatAnswerForPrompt(req, { kind: 'input', text: '要' })).toBe(
      [
        '---',
        '用户已回复你上一次的交互请求：',
        '- 你的问题：要导出吗？',
        '- 用户的回答：要',
        '请基于这个回答继续，不要重复提问，直接产出最终结果。',
      ].join('\n'),
    );
  });

  it('pins the previous conclusion and every settled answer', () => {
    const out = formatAnswerForPrompt(
      req,
      { kind: 'input', text: '你直接输出就好了，不要反复来问' },
      {
        roundConclusion: '简历读完。背景：TA 实习，Unity URP。',
        confirmations: ['第一问 → 技术美术'],
      },
    );
    expect(out).toContain('你上一轮的结论（已确认，必须沿用，不得重新判定或推翻）');
    expect(out).toContain('简历读完。背景：TA 实习，Unity URP。');
    expect(out).toContain('已确认基线（用户已拍板，后续所有输出必须与之一致）：');
    expect(out).toContain('1. 第一问 → 技术美术');
  });

  it('isPinnableAnswer rejects junk answers, keeps real ones', () => {
    expect(isPinnableAnswer(req, { kind: 'input', text: '   ' })).toBe(false);
    expect(isPinnableAnswer({ type: 'select', prompt: 'p' }, {
      kind: 'select',
      values: ['--'],
    })).toBe(false);
    expect(
      isPinnableAnswer({ type: 'select', prompt: 'p' }, {
        kind: 'select',
        values: ['*答案要点：**'],
      }),
    ).toBe(false);
    expect(
      isPinnableAnswer({ type: 'select', prompt: 'p' }, {
        kind: 'select',
        values: ['你直接输出就好了，不要反复来问'],
      }),
    ).toBe(true);
    expect(isPinnableAnswer(req, { kind: 'input' })).toBe(false);
  });
});
