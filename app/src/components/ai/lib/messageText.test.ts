import { describe, expect, it } from 'vitest';
import { answerActionText, turnTimingFromMessage } from './messageText';
import { encodeToolPatch } from './toolEvent';

describe('answerActionText', () => {
  it('keeps only assistant answer prose for copy and translation actions', () => {
    const text = [
      '⚙ 路由：Claude Code · 模型：sonnet',
      '⏱ 10:00:00 → 10:00:01 · 耗时 1s',
      '<think>private reasoning</think>',
      '第一段。',
      '🔧 command_execution: npm run typecheck',
      '第二段。' +
        encodeToolPatch({
          id: 'tool-1',
          name: 'Read',
          subject: 'app/src/App.tsx',
          status: 'done',
          result: 'secret tool output',
        }),
      '第三段。',
    ].join('\n');

    expect(answerActionText(text)).toBe('第一段。\n\n第二段。\n\n第三段。');
  });
});

describe('turnTimingFromMessage', () => {
  it('prefers the verbatim ⏱ line written by the turn', () => {
    expect(
      turnTimingFromMessage({
        text: '⏱ 10:00:00 → 10:00:01 · 耗时 1s\n正文',
        createdAt: 1_000,
        completedAt: 9_999,
      }),
    ).toBe('⏱ 10:00:00 → 10:00:01 · 耗时 1s');
  });

  it('falls back to createdAt/completedAt when the prefix is gone', () => {
    const createdAt = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const completedAt = createdAt + 11 * 60_000 + 49_000;
    expect(turnTimingFromMessage({ text: '正文', createdAt, completedAt }))
      .toBe('⏱ 10:00:00 → 10:11:49 · 耗时 11m 49s');
  });

  it('returns empty for turns with no measurable span', () => {
    expect(turnTimingFromMessage({ text: '正文', createdAt: 5_000, completedAt: 5_000 }))
      .toBe('');
    expect(turnTimingFromMessage({ text: '正文' })).toBe('');
  });
});
