import { describe, expect, it, vi } from 'vitest';

async function implementation() {
  const module = await import(/* @vite-ignore */ './skill-review-capability');
  return module;
}

describe('CLI skill review capability gate', () => {
  it('explicitly disables every adapter without an adversarially verified capsule', async () => {
    const { getCliSkillReviewCapability, listSupportedCliSkillReviewAdapters } = await implementation();
    for (const adapter of ['claude-code', 'codex', 'gemini', 'grok', 'custom', 'unknown']) {
      const capability = getCliSkillReviewCapability(adapter);
      expect(capability).toMatchObject({ adapter, capability: 'completion-only', status: 'unavailable' });
      expect(capability.reason).toMatch(/未.*验证|unverified/i);
    }
    expect(listSupportedCliSkillReviewAdapters()).toEqual([]);
  });

  it('reports an explicit completion-only HTTP support list separately from the empty CLI capsule list', async () => {
    const module = await import('./skill-review-model');
    const supported = (module as unknown as { listSupportedNodeSkillReviewHttpTransports?: () => unknown }).listSupportedNodeSkillReviewHttpTransports;
    expect(supported).toBeTypeOf('function');
    expect(supported!()).toEqual([
      { transport: 'anthropic', execution: 'http', capability: 'completion-only' },
      { transport: 'openai-compatible', execution: 'http', capability: 'completion-only' },
    ]);
    expect((await implementation()).listSupportedCliSkillReviewAdapters()).toEqual([]);
  });

  it('rejects model-port creation rather than launching a general-purpose CLI reviewer', async () => {
    const { createCliSkillReviewModelPort } = await implementation();
    expect(createCliSkillReviewModelPort, 'safe model-port gate must exist').toBeTypeOf('function');
    const spawn = vi.fn();
    for (const adapter of ['claude-code', 'codex', 'gemini', 'grok', 'custom']) {
      expect(() => (createCliSkillReviewModelPort as (...args: unknown[]) => unknown)(adapter, {
        permission: 'readonly', cwd: 'project', resume: true, sessionId: 'main-session', spawn,
      })).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
