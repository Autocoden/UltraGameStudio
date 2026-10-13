// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillEvidence, SkillOrigin } from '../../src/runtime/skills/types';
import { createNodeWorkspaceSkillRequest } from './skill-host';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
const origin: SkillOrigin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a/cli/invocation-a' };
const content = '---\nname: verify-outcomes\ndescription: Use when checking outcomes.\n---\nCheck actual outcomes before reporting success.\n';
const evidence: SkillEvidence[] = [{ evidenceId: 'host-test', origin, occurredAt: 1, provenance: 'host-check', kind: 'verification',
  toolCallId: 'actual-test', toolName: 'test', status: 'success', exitCode: 0, summary: 'An actual host check passed.' }];
async function implementation() {
  const module = await import(/* @vite-ignore */ './skill-tools');
  expect(module.createNodeSkillToolDispatcher, 'Model-facing scoped skill dispatcher must exist').toBeTypeOf('function');
  return module;
}

describe('Node model-facing scoped skill tools', () => {
  it('actively lists, creates, and fully views via the same injected real workspace service', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const cwd = await mkdtemp(join(tmpdir(), 'ugs-active-skill-tools-')); dirs.push(cwd);
    const request = createNodeWorkspaceSkillRequest({ cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const tools = createNodeSkillToolDispatcher({ origin, request, mode: 'auto-safe', evidence: () => evidence });
    expect(tools.tools().map((tool) => tool.name)).toEqual(['skills_list', 'skill_view', 'skill_manage']);
    expect(await tools.invoke('skills_list', {})).toMatchObject({ entries: [], learningEvidence: [{ evidenceId: 'host-test' }] });
    expect(await tools.invoke('skill_manage', { version: 1, kind: 'propose', lesson: 'Check actual outcomes.', evidenceIds: ['host-test'],
      operations: [{ action: 'create', name: 'verify-outcomes', content }] })).toMatchObject({ status: 'applied', operationsApplied: 1 });
    const catalog = await tools.invoke('skills_list', {}) as { entries: Array<{ skillId: string }> };
    expect(catalog.entries).toHaveLength(1);
    expect(await tools.invoke('skill_view', { skillId: catalog.entries[0].skillId })).toMatchObject({ content, fullRead: true, readReceiptId: expect.any(String) });
    expect(await readFile(join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md'), 'utf8')).toBe(content);
  });

  it('rejects roots, origin, policy, approvals, unknown tools, and nested authority before forwarding any service call', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const calls: unknown[] = [];
    const tools = createNodeSkillToolDispatcher({ origin, mode: 'auto-safe', evidence: () => evidence,
      request: async (value) => { calls.push(value); return { entries: [] }; } });
    const proposal = { version: 1, kind: 'propose', lesson: 'Check outcomes.', evidenceIds: ['host-test'],
      operations: [{ action: 'create', name: 'verify-outcomes', content }] };
    for (const key of ['root', 'origin', 'workspaceId', 'mode', 'evidence', 'actor', 'autoApprove', 'approval']) {
      await expect(tools.invoke('skill_manage', { ...proposal, [key]: 'foreign' })).rejects.toThrow();
      await expect(tools.invoke('skill_view', { skillId: 'opaque', [key]: 'foreign' })).rejects.toThrow();
    }
    await expect(tools.invoke('skill_manage', { ...proposal, operations: [{ ...proposal.operations[0], root: 'C:/foreign' }] })).rejects.toThrow();
    for (const name of ['terminal', 'shell', 'approve', 'reject', 'archive', 'restore', 'set_policy', 'rollback'])
      await expect(tools.invoke(name, {})).rejects.toThrow(/UNAVAILABLE/);
    expect(calls).toEqual([]);
  });

  it('rejects model-authored or foreign evidence even if a host callback returns it', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const calls: unknown[] = [];
    const tools = createNodeSkillToolDispatcher({ origin, mode: 'auto-safe', request: async (value) => { calls.push(value); return {}; },
      evidence: () => [{ ...evidence[0], evidenceId: 'model', provenance: 'model-output' },
        { ...evidence[0], evidenceId: 'foreign', origin: { ...origin, runId: 'other-invocation' } }] });
    for (const evidenceId of ['model', 'foreign', 'invented']) await expect(tools.invoke('skill_manage', { version: 1, kind: 'propose',
      lesson: 'Check outcomes.', evidenceIds: [evidenceId], operations: [{ action: 'create', name: 'verify-outcomes', content }] })).rejects.toThrow(/UNKNOWN_EVIDENCE/);
    expect(calls).toEqual([]);
  });

  it('does not claim used-with-evidence for a full read and rejects stale or cross-invocation receipts', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const cwd = await mkdtemp(join(tmpdir(), 'ugs-active-skill-receipts-')); dirs.push(cwd);
    const request = createNodeWorkspaceSkillRequest({ cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const tools = createNodeSkillToolDispatcher({ origin, request, mode: 'auto-safe', evidence: () => evidence });
    await tools.invoke('skill_manage', { version: 1, kind: 'propose', lesson: 'Check outcomes.', evidenceIds: ['host-test'], operations: [{ action: 'create', name: 'verify-outcomes', content }] });
    const catalog = await tools.invoke('skills_list', {}) as { entries: Array<{ skillId: string }> };
    const skillId = catalog.entries[0].skillId;
    const read = await tools.invoke('skill_view', { skillId }) as { readReceiptId: string; hash: string; entry: { usage?: { usedWithEvidence: number } } };
    expect(read.entry.usage?.usedWithEvidence ?? 0).toBe(0);
    const proposal = { version: 1, kind: 'propose', lesson: 'Read current results.', evidenceIds: ['host-test'], operations: [{ action: 'patch', skillId,
      oldString: 'Check actual outcomes', newString: 'Read current outcomes', readReceiptId: read.readReceiptId, expectedHash: read.hash }] };
    const foreignOrigin = { ...origin, runId: 'run-a/cli/foreign' };
    const foreign = createNodeSkillToolDispatcher({ origin: foreignOrigin, request, mode: 'auto-safe', evidence: () => [{ ...evidence[0], origin: foreignOrigin }] });
    expect(await foreign.invoke('skill_manage', proposal)).toMatchObject({ status: 'failed', operationsApplied: 0, error: expect.stringContaining('receipt') });
    const file = join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, content + 'User external edit.\n');
    expect(await tools.invoke('skill_manage', proposal)).toMatchObject({ status: 'conflicted', operationsApplied: 0 });
    expect(await readFile(file, 'utf8')).toBe(content + 'User external edit.\n');
  });

  it('does not dispatch a mutation after a host evidence observer aborts the invocation', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const calls: unknown[] = [];
    const controller = new AbortController();
    const tools = createNodeSkillToolDispatcher({ origin, signal: controller.signal, mode: 'auto-safe',
      request: async (value) => { calls.push(value); return {}; }, evidence: () => { controller.abort(); return evidence; } });
    await expect(tools.invoke('skill_manage', { version: 1, kind: 'propose', lesson: 'Check outcomes.', evidenceIds: ['host-test'],
      operations: [{ action: 'create', name: 'verify-outcomes', content }] })).rejects.toThrow(/CANCELLED/);
    expect(calls).toEqual([]);
  });

  it('reports an actual committed host result even if the signal aborts after dispatch', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const controller = new AbortController();
    let called = false;
    const tools = createNodeSkillToolDispatcher({ origin, signal: controller.signal, mode: 'auto-safe', evidence: () => evidence,
      request: async () => { called = true; controller.abort(); return { status: 'applied', operationsApplied: 1 }; } });
    expect(await tools.invoke('skill_manage', { version: 1, kind: 'propose', lesson: 'Check outcomes.', evidenceIds: ['host-test'],
      operations: [{ action: 'create', name: 'verify-outcomes', content }] })).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(called).toBe(true);
  });

  it('honors host cancellation and read-only/off policy without dispatching a mutation', async () => {
    const { createNodeSkillToolDispatcher } = await implementation();
    const calls: unknown[] = [];
    const request = async (value: unknown) => { calls.push(value); return {}; };
    const proposal = { version: 1, kind: 'propose', lesson: 'Check outcomes.', evidenceIds: ['host-test'], operations: [{ action: 'create', name: 'verify-outcomes', content }] };
    for (const options of [{ mode: 'off' as const }, { allowManage: false }]) {
      const tools = createNodeSkillToolDispatcher({ origin, request, evidence: () => evidence, ...options });
      expect(tools.tools().map((tool) => tool.name)).toEqual(['skills_list', 'skill_view']);
      await expect(tools.invoke('skill_manage', proposal)).rejects.toThrow(/DISABLED/);
    }
    const controller = new AbortController(); controller.abort();
    const tools = createNodeSkillToolDispatcher({ origin, request, signal: controller.signal });
    await expect(tools.invoke('skills_list', {})).rejects.toThrow(/CANCELLED/);
    expect(calls).toEqual([]);
  });
});
