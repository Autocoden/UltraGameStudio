import { describe, expect, it } from 'vitest';
import {
  isOfficialDeepSeekBaseUrl,
  isSupportedThinkingLevel,
  resolveThinkingChannel,
  resolveThinkingPlan,
  thinkingDefault,
  thinkingLevelOptions,
  thinkingPlanEnv,
} from './thinkingLevels';

const ids = (source: Parameters<typeof thinkingLevelOptions>[0]) =>
  thinkingLevelOptions(source).map((o) => o.id);

describe('thinking level capability resolver', () => {
  it('exposes the five levels the installed claude CLI accepts', () => {
    expect(ids({ adapter: 'claude-code' })).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // CLI 的档位枚举由 CLI 决定，不因「模型 id 是裸 tier 别名」而收缩。
    expect(ids({ adapter: 'claude-code', model: 'sonnet' })).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('exposes the six model_reasoning_effort values for codex', () => {
    expect(ids({ adapter: 'codex' })).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('exposes the four DeepSeek native levels on the official endpoint', () => {
    expect(
      ids({ adapter: 'deepseek-harness', baseUrl: 'https://api.deepseek.com' }),
    ).toEqual(['off', 'low', 'high', 'max']);
    // 空 baseURL = 用 CLI 自身默认端点（官方）。
    expect(ids({ adapter: 'deepseek-harness' })).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);
  });

  it('still offers levels on a third-party gateway, keyed by the model family', () => {
    const gateway = 'https://ai-gateway.example.com/v1';
    // 未给模型：通用 OpenAI 三档（只有用户主动选档才会过线）。
    expect(ids({ adapter: 'deepseek-harness', baseUrl: gateway })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    // DeepSeek 族：off/low/high/max。
    expect(
      ids({ adapter: 'deepseek-harness', baseUrl: gateway, model: 'deepseek-v4-pro' }),
    ).toEqual(['off', 'low', 'high', 'max']);
    // Anthropic 族：low/medium/high。
    expect(
      ids({ adapter: 'deepseek-harness', baseUrl: gateway, model: 'claude-opus-4.8' }),
    ).toEqual(['low', 'medium', 'high']);
    // OpenAI 推理族：minimal/low/medium/high。
    expect(
      ids({ adapter: 'deepseek-harness', baseUrl: gateway, model: 'gpt-5.5' }),
    ).toEqual(['minimal', 'low', 'medium', 'high']);
    // 带 provider 前缀 / 版本标签同样识别。
    expect(
      ids({
        adapter: 'deepseek-harness',
        baseUrl: gateway,
        model: 'deepseek/deepseek-reasoner:free',
      }),
    ).toEqual(['off', 'low', 'high', 'max']);
  });

  it('hides the selector only for models that provably do not reason', () => {
    for (const model of ['gpt-4o', 'text-embedding-3-large', 'claude-haiku-4.5', 'whisper-1']) {
      expect(ids({ adapter: 'deepseek-harness', baseUrl: 'https://gw.example.com', model })).toEqual(
        [],
      );
    }
  });

  it('offers levels on HTTP-direct transports instead of hiding them', () => {
    // 直连 Anthropic：思考走原生 thinking 字段。
    expect(
      ids({ adapter: 'claude-code', transport: 'anthropic', model: 'claude-sonnet-4-6' }),
    ).toEqual(['low', 'medium', 'high']);
    // 直连 OpenAI 兼容：思考走 reasoning_effort。
    expect(
      ids({
        adapter: 'deepseek-harness',
        baseUrl: 'https://api.deepseek.com',
        transport: 'openai-compatible',
        model: 'deepseek-v4-pro',
      }),
    ).toEqual(['off', 'low', 'high', 'max']);
  });

  it('lets an explicit channel declaration override the family table', () => {
    expect(
      ids({
        adapter: 'deepseek-harness',
        baseUrl: 'https://gw.example.com',
        model: 'mystery-model',
        declaredLevels: ['off', 'ultra'],
        declaredWire: { off: null, ultra: 'ultra' },
      }),
    ).toEqual(['off', 'ultra']);
  });

  it('validates a stored level against the current channel', () => {
    expect(isSupportedThinkingLevel({ adapter: 'codex' }, 'minimal')).toBe(true);
    expect(isSupportedThinkingLevel({ adapter: 'codex' }, 'off')).toBe(false);
    expect(
      isSupportedThinkingLevel(
        { adapter: 'deepseek-harness', baseUrl: 'https://api.deepseek.com' },
        'xhigh',
      ),
    ).toBe(false);
    expect(isSupportedThinkingLevel({ adapter: 'codex' }, undefined)).toBe(false);
  });

  it('recognises only official DeepSeek hosts', () => {
    expect(isOfficialDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true);
    expect(isOfficialDeepSeekBaseUrl('https://deepseek.com')).toBe(true);
    expect(isOfficialDeepSeekBaseUrl('')).toBe(true);
    expect(isOfficialDeepSeekBaseUrl('https://ai-gateway.example.com')).toBe(false);
    expect(isOfficialDeepSeekBaseUrl('https://notdeepseek.com')).toBe(false);
  });
});

describe('thinking channel routing', () => {
  it('routes by transport first, adapter second', () => {
    expect(resolveThinkingChannel({ adapter: 'claude-code' })).toBe('cli-claude-effort');
    expect(resolveThinkingChannel({ adapter: 'codex' })).toBe('cli-codex-effort');
    expect(resolveThinkingChannel({ adapter: 'claude-code', transport: 'anthropic' })).toBe(
      'http-anthropic',
    );
    expect(
      resolveThinkingChannel({ adapter: 'deepseek-harness', transport: 'openai-compatible' }),
    ).toBe('http-openai');
    expect(
      resolveThinkingChannel({ adapter: 'deepseek-harness', baseUrl: 'https://api.deepseek.com' }),
    ).toBe('dsh-deepseek-native');
    expect(
      resolveThinkingChannel({ adapter: 'deepseek-harness', baseUrl: 'https://gw.example.com' }),
    ).toBe('dsh-pi-ai');
    // 没有已验证思考通道的 CLI 适配器不臆造档位。
    expect(resolveThinkingChannel({ adapter: 'kimi' })).toBeNull();
  });
});

describe('thinking plan', () => {
  it('builds a pi-ai plan with efforts and wire format', () => {
    const plan = resolveThinkingPlan(
      { adapter: 'deepseek-harness', baseUrl: 'https://gw.example.com', model: 'deepseek-v4-pro' },
      'high',
    );
    expect(plan?.channel).toBe('dsh-pi-ai');
    expect(plan?.wire).toBe('high');
    expect(plan?.thinkingFormat).toBe('deepseek');
    expect(plan?.efforts).toEqual({ off: null, low: 'low', high: 'high', max: 'max' });
    expect(plan?.openaiBody).toEqual({ reasoning_effort: 'high' });
  });

  it('maps "thinking off" to the family-specific off body', () => {
    const plan = resolveThinkingPlan(
      { adapter: 'deepseek-harness', baseUrl: 'https://gw.example.com', model: 'deepseek-v4-pro' },
      'off',
    );
    expect(plan?.wire).toBeNull();
    expect(plan?.openaiBody).toEqual({ thinking: { type: 'disabled' } });
    expect(plan?.anthropicThinking).toEqual({ type: 'disabled' });
  });

  it('maps anthropic budgets and OpenAI reasoning_effort spellings', () => {
    const anthropic = resolveThinkingPlan(
      { adapter: 'claude-code', transport: 'anthropic', model: 'claude-sonnet-4-6' },
      'high',
    );
    expect(anthropic?.anthropicThinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(anthropic?.openaiBody).toEqual({ reasoning_effort: 'high' });

    const openai = resolveThinkingPlan(
      { adapter: 'deepseek-harness', transport: 'openai-compatible', model: 'gpt-5.5' },
      'minimal',
    );
    expect(openai?.openaiBody).toEqual({ reasoning_effort: 'minimal' });
  });

  it('refuses a level the current channel does not offer', () => {
    expect(
      resolveThinkingPlan({ adapter: 'deepseek-harness', baseUrl: 'https://api.deepseek.com' }, 'xhigh'),
    ).toBeNull();
    expect(resolveThinkingPlan({ adapter: 'kimi' }, 'high')).toBeNull();
    expect(resolveThinkingPlan({ adapter: 'codex' }, undefined)).toBeNull();
  });

  it('serialises into the env pair Rust consumes', () => {
    const plan = resolveThinkingPlan({ adapter: 'codex' }, 'xhigh');
    expect(thinkingPlanEnv(plan)).toEqual({
      UGS_THINKING_LEVEL: 'xhigh',
      UGS_THINKING_PLAN: JSON.stringify(plan),
    });
    expect(thinkingPlanEnv(null)).toEqual({});
  });
});

describe('default thinking level', () => {
  it('resolves the claude CLI per-model default_effort', () => {
    // 依据：本机 claude 模型目录的 default_effort 字段（具名条目）。
    expect(thinkingDefault({ adapter: 'claude-code', model: 'claude-sonnet-5' })).toEqual({
      level: 'high',
      hintKey: 'dock.thinkingDefaultModel',
    });
    expect(thinkingDefault({ adapter: 'claude-code', model: 'claude-opus-4-7' }).level).toBe(
      'xhigh',
    );
    // 点号拼写的模型 id 与目录的横线写法等价。
    expect(thinkingDefault({ adapter: 'claude-code', model: 'claude-opus-4.7' }).level).toBe(
      'xhigh',
    );
    expect(thinkingDefault({ adapter: 'claude-code', model: 'claude-opus-5-5' }).level).toBe(
      'medium',
    );
    // 带 provider 前缀同样命中。
    expect(
      thinkingDefault({ adapter: 'claude-code', model: 'anthropic/claude-opus-4-8' }).level,
    ).toBe('high');
  });

  it('does not invent a default for bare tier aliases or unknown models', () => {
    // 裸别名映射到哪个版本由 CLI 决定 —— 宁可说「由 CLI 决定」也不猜。
    expect(thinkingDefault({ adapter: 'claude-code', model: 'sonnet' })).toEqual({
      level: null,
      hintKey: 'dock.thinkingDefaultCli',
    });
    expect(thinkingDefault({ adapter: 'claude-code', model: 'mystery-model' }).level).toBeNull();
  });

  it('names the real owner of the default on every other channel', () => {
    expect(thinkingDefault({ adapter: 'codex' })).toEqual({
      level: null,
      hintKey: 'dock.thinkingDefaultCodex',
    });
    expect(
      thinkingDefault({ adapter: 'deepseek-harness', baseUrl: 'https://api.deepseek.com' }).hintKey,
    ).toBe('dock.thinkingDefaultDeepseek');
    // 第三方网关：pi-ai 未声明档位时模型默认不推理。
    expect(
      thinkingDefault({ adapter: 'deepseek-harness', baseUrl: 'https://gw.example.com' }).hintKey,
    ).toBe('dock.thinkingDefaultGateway');
    expect(
      thinkingDefault({ adapter: 'claude-code', transport: 'anthropic' }).hintKey,
    ).toBe('dock.thinkingDefaultEndpoint');
  });
});
