import { describe, expect, it, vi } from 'vitest';
import { loadSkillContext } from './context';
import type { SkillEntry, SkillHostPort, SkillReadResult, SkillReviewModelPort } from './types';
const origin = { hostId: 'local', workspaceId: 'p', sessionId: 's', turnId: 't', runId: 'r' };
const entry = (id = 'a', overrides: Partial<SkillEntry> = {}): SkillEntry => ({
  skillId: id, rootId: 'project', name: 'testing-workflows', description: 'Use when running vitest regression tests.',
  scope: 'project', source: 'background', relativePath: 'testing-workflows', revision: 'new-r', hash: 'new-h',
  readOnly: false, autoEditable: true, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md', 'references/tests.md'], ...overrides,
});
const read = (id = 'a', filePath = 'SKILL.md'): SkillReadResult => ({ entry: entry(id), relativePath: filePath,
  content: filePath === 'SKILL.md' ? 'FULL NEW RULE: run actual tests before editing.' : 'FULL REFERENCE: test command.',
  revision: 'new-r', hash: 'new-h', fullRead: true, readReceiptId: `receipt:${id}:${filePath}`, files: entry(id).files,
});
const host = (overrides: Partial<SkillHostPort> = {}): SkillHostPort => ({
  list: async () => ({ revision: 'catalog-new', entries: [entry()] }),
  view: async ({ skillId, filePath }) => read(skillId, filePath),
  manage: async () => { throw new Error('context must not manage'); }, ...overrides,
});

describe('fresh task skill context', () => {
  it('loads multiple skills and only the explicitly requested support files', async () => {
    const view = vi.fn(async ({ skillId, filePath }: { skillId: string; filePath?: string }) => read(skillId, filePath));
    const loaded = await loadSkillContext({ host: host({ view, list: async () => ({ revision: 'c', entries: [entry('a'), entry('b')] }) }),
      origin, prompt: 'request', explicitSkillIds: ['a', 'b', 'a'], supportRequests: [{ skillId: 'a', filePath: 'references/tests.md' }] });
    expect(view).toHaveBeenCalledTimes(3);
    expect(loaded.loadedSkills).toHaveLength(2);
    expect(loaded.loadedSkills[0].files).toEqual(['SKILL.md', 'references/tests.md']);
    expect(loaded.loadedSkills[1].files).toEqual(['SKILL.md']);
    expect(loaded.prompt).toContain('FULL REFERENCE');
  });

  it('resolves typed slash names by scope and rejects same-priority ambiguity or unknown ids', async () => {
    const local = entry('local'); const global = entry('global', { scope: 'global' });
    const scopedHost = host({ list: async () => ({ revision: 'c', entries: [global, local] }) });
    expect((await loadSkillContext({ host: scopedHost, origin, prompt: '/testing-workflows run tests' })).loadedSkills[0].skillId).toBe('local');
    await expect(loadSkillContext({ host: host({ list: async () => ({ revision: 'c', entries: [local, entry('other')] }) }), origin,
      prompt: '/testing-workflows run tests' })).rejects.toThrow('AMBIGUOUS');
    await expect(loadSkillContext({ host: scopedHost, origin, prompt: 'task', explicitSkillIds: ['invented'] })).rejects.toThrow('UNKNOWN');
  });

  it('uses a bounded completion-only semantic selector over the small index', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: JSON.stringify({ skillIds: ['a', 'b'] }) }));
    const model: SkillReviewModelPort = { capability: 'completion-only', complete };
    const loaded = await loadSkillContext({ host: host({ list: async () => ({ revision: 'c', entries: [entry('a'), entry('b')] }) }),
      origin, prompt: 'Please check the change without regressing behavior.', model });
    expect(loaded.loadedSkills.map((s) => s.skillId)).toEqual(['a', 'b']);
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    expect(request.maxOutputTokens).toBeLessThanOrEqual(512);
    expect(request.timeoutMs).toBeLessThanOrEqual(5000);
    expect(request.userContent).not.toContain('FULL NEW RULE');
    expect(request.userContent).not.toContain('autoEditable');
  });

  it('uses a high deterministic name match without claiming generic keyword retrieval', async () => {
    const loaded = await loadSkillContext({ host: host(), origin, prompt: 'Use testing-workflows to run the regression suite.' });
    expect(loaded.loadedSkills).toHaveLength(1);
    expect((await loadSkillContext({ host: host(), origin, prompt: 'hello test things' })).loadedSkills).toEqual([]);
  });

  it('rejects truncated or mismatched reads without recording delivery', async () => {
    const recordUsage = vi.fn(async () => {});
    for (const response of [
      { ...read(), fullRead: false }, { ...read(), entry: entry('foreign') },
      { ...read(), relativePath: 'references/not-main.md' }, { ...read(), content: 'x'.repeat(100001) },
    ]) await expect(loadSkillContext({ host: host({ recordUsage, view: async () => response as SkillReadResult }), origin,
      prompt: 'task', explicitSkillIds: ['a'] })).rejects.toThrow();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('aborts a slow read without delivery even when the host ignores the signal', async () => {
    const controller = new AbortController();
    let deliver!: (value: SkillReadResult) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const recordUsage = vi.fn(async () => {});
    const pending = loadSkillContext({ host: host({ recordUsage, view: async () => {
      started(); return new Promise((resolve) => { deliver = resolve; });
    } }), origin, prompt: 'task', explicitSkillIds: ['a'], signal: controller.signal });
    await called; controller.abort(); deliver(read());
    await expect(pending).rejects.toThrow('CANCELLED');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('discards the entire malformed selector response rather than loading a valid prefix', async () => {
    const view = vi.fn(async () => read());
    const model: SkillReviewModelPort = { capability: 'completion-only', complete: async () => ({ text: '{"skillIds":["a","invented"]}' }) };
    const loaded = await loadSkillContext({ host: host({ view }), origin, prompt: 'check the regressions', model });
    expect(loaded.loadedSkills).toEqual([]);
    expect(view).not.toHaveBeenCalled();
  });

  it('does not select a skill merely because its name is a substring of an unrelated token', async () => {
    const loaded = await loadSkillContext({ host: host(), origin, prompt: 'not-testing-workflows-magic' });
    expect(loaded.loadedSkills).toEqual([]);
  });

  it('rejects an unknown typed skill name before invoking a semantic selector', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: '{"skillIds":["a"]}' }));
    const view = vi.fn(async () => read());
    await expect(loadSkillContext({ host: host({ view }), origin, prompt: '/unknown-workflow perform task',
      model: { capability: 'completion-only', complete } })).rejects.toThrow('UNKNOWN_NAME');
    expect(complete).not.toHaveBeenCalled();
    expect(view).not.toHaveBeenCalled();
  });

  it('requires an exact fresh revision and file hash before recording delivery', async () => {
    const recordUsage = vi.fn(async () => {});
    for (const malformed of [
      { ...read(), revision: '' },
      { ...read(), revision: 'different-revision' },
      { ...read(), hash: 'different-main-hash' },
    ]) await expect(loadSkillContext({ host: host({ recordUsage, view: async () => malformed }), origin,
      prompt: 'task', explicitSkillIds: ['a'] })).rejects.toThrow('INVALID_FULL_READ');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('appends the current full skill to a new user prompt and records delivered not adherence', async () => {
    const prompt = 'unchanged system/history prefix\nuser request';
    const recordUsage = vi.fn(async () => {});
    const loaded = await loadSkillContext({ host: host({ recordUsage }), origin, prompt, explicitSkillIds: ['a'] });
    expect(loaded.prompt.startsWith(prompt)).toBe(true);
    expect(loaded.prompt).toContain('FULL NEW RULE');
    expect(loaded.prompt).toContain('new-h');
    expect(loaded.catalogRevision).toBe('catalog-new');
    expect(loaded.loadedSkills).toEqual([{ skillId: 'a', revision: 'new-r', hash: 'new-h', files: ['SKILL.md'] }]);
    expect(recordUsage).toHaveBeenCalledWith('a', 'delivered');
    expect(recordUsage).not.toHaveBeenCalledWith('a', 'used-with-evidence');
  });
});
