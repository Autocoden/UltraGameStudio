import { describe, expect, it } from 'vitest';
import { parseSkillReviewMessage } from './protocol';

describe('skill protocol v1', () => {
  it('validates exact read fields and rejects unsafe paths rather than repairing tokens', () => {
    for (const request of [
      { skillId: 'opaque', origin: 'other' }, { skillId: '' },
      { skillId: 'opaque', filePath: '../config.json' },
      { skillId: 'opaque', filePath: 'C:/keys' },
      { skillId: 'opaque', filePath: 'references/CON.md' },
      { skillId: 'opaque', filePath: 'references/topic.md:secret' },
      { skillId: 'opaque', filePath: 'references/topic.md.' },
    ]) expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'read', requests: [request] }))).toThrow();
    expect(parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'read', requests: [
      { skillId: 'opaque', filePath: 'references/testing.md' },
    ] })).kind).toBe('read');
  });

  it('accepts bounded proposals only with receipt/hash or explicit absence', () => {
    const operations = [
      { action: 'create', name: 'testing-workflows', content: 'new skill' },
      { action: 'patch', skillId: 'opaque', oldString: 'old', newString: 'new', expectedHash: 'h', readReceiptId: 'r' },
      { action: 'write_file', skillId: 'opaque', filePath: 'references/tests.md', content: 'text', absent: true },
      { action: 'write_file', skillId: 'opaque', filePath: 'references/old.md', content: 'text', expectedHash: 'h', readReceiptId: 'r' },
      { action: 'remove_file', skillId: 'opaque', filePath: 'references/remove.md', expectedHash: 'h', readReceiptId: 'r' },
    ];
    const proposal = { version: 1, kind: 'propose', lesson: 'Run the actual check.', evidenceIds: ['e'], operations };
    expect(parseSkillReviewMessage(JSON.stringify(proposal))).toEqual(proposal);
  });

  it('rejects overlarge payloads and more than one new class-level skill', () => {
    const proposal = (operations: unknown[]) => JSON.stringify({ version: 1, kind: 'propose', lesson: 'Rule', evidenceIds: ['e'], operations });
    const create = { action: 'create', name: 'testing-workflows', content: 'text' };
    expect(() => parseSkillReviewMessage(proposal([create, { ...create, name: 'other-workflows' }]))).toThrow();
    expect(() => parseSkillReviewMessage(proposal([{ ...create, content: 'x'.repeat(100001) }]))).toThrow();
    expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'noop', reason: 'x'.repeat(150000) }))).toThrow();
  });

  it('rejects names whose first character is not lowercase alphabetic', () => {
    for (const name of ['1testing', 'Test-workflows', '-testing', 'test--workflow', 'testing-']) {
      expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'propose', lesson: 'Rule', evidenceIds: ['e'],
        operations: [{ action: 'create', name, content: 'text' }] }))).toThrow();
    }
  });

  it('rejects unknown operation permissions actor roots and unsupported actions', () => {
    const valid = [
      { action: 'create', name: 'testing-workflows', content: 'text' },
      { action: 'patch', skillId: 'id', oldString: 'a', newString: 'b', expectedHash: 'h', readReceiptId: 'r' },
      { action: 'write_file', skillId: 'id', filePath: 'references/topic.md', content: 'text', absent: true },
      { action: 'remove_file', skillId: 'id', filePath: 'references/topic.md', expectedHash: 'h', readReceiptId: 'r' },
    ];
    for (const operation of valid) for (const key of ['permissions', 'origin', 'actor', 'root', 'approve', 'replaceAll']) {
      expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'propose', lesson: 'Rule', evidenceIds: ['e'], operations: [{ ...operation, [key]: 'injected' }] }))).toThrow('Unknown');
    }
    for (const action of ['delete', 'archive', 'adopt', 'execute']) expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'propose', lesson: 'Rule', evidenceIds: ['e'], operations: [{ action, skillId: 'id' }] }))).toThrow();
  });

  it('rejects Windows reserved package and support-file identifiers', () => {
    for (const name of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
      expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'propose', lesson: 'Rule', evidenceIds: ['e'],
        operations: [{ action: 'create', name, content: 'content' }] })), name).toThrow();
    }
    for (const filePath of ['references/clock$.md', 'references/conin$.md', 'references/conout$.md', 'references/com¹.md', 'references/lpt².md']) {
      expect(() => parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: 'id', filePath }] })), filePath).toThrow();
    }
  });

  it('accepts v1 read/noop and rejects unknown top-level fields or kinds', () => {
    expect(parseSkillReviewMessage('{"version":1,"kind":"noop","reason":"no reusable lesson"}'))
      .toEqual({ version: 1, kind: 'noop', reason: 'no reusable lesson' });
    expect(parseSkillReviewMessage('{"version":1,"kind":"read","requests":[{"skillId":"opaque"}]}').kind).toBe('read');
    for (const message of [
      { version: 2, kind: 'noop', reason: 'x' },
      { version: 1, kind: 'exec', reason: 'x' },
      { version: 1, kind: 'noop', reason: 'x', root: 'C:/private' },
      { version: 1, kind: 'noop', reason: 'x', permissions: 'full' },
    ]) expect(() => parseSkillReviewMessage(JSON.stringify(message))).toThrow();
  });
});
