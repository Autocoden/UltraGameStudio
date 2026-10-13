import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCatalog, SkillOrigin, SkillProposal, SkillReadRequest, SkillEvidence } from '../../src/runtime/skills/types';

const origin: SkillOrigin = {
  hostId: 'node-local', workspaceId: 'workspace-a', sessionId: 'session-a',
  turnId: 'turn-a', runId: 'review-a', cwd: 'E:/workspace-a',
};

async function implementation() {
  const module = await import(/* @vite-ignore */ './skill-host');
  expect(module.createNodeSkillHostPort, 'Node host factory must exist').toBeTypeOf('function');
  return module;
}

describe('Node skill host binding', () => {
  it('lists through the injected service using a frozen host origin', async () => {
    const { createNodeSkillHostPort } = await implementation();
    const calls: unknown[] = [];
    const catalog: SkillCatalog = { revision: 'catalog-1', entries: [] };
    const mutable = { ...origin };
    const host = createNodeSkillHostPort({
      origin: mutable,
      request: async (payload: unknown) => { calls.push(payload); return catalog; },
    });
    mutable.workspaceId = 'workspace-b';
    mutable.runId = 'review-b';
    expect(await host.list()).toEqual(catalog);
    expect(calls).toEqual([{ action: 'list', origin }]);
  });

  it('views only the requested identity and ignores model-supplied host fields', async () => {
    const { createNodeSkillHostPort } = await implementation();
    const calls: unknown[] = [];
    const read = { content: 'full content', fullRead: true };
    const host = createNodeSkillHostPort({ origin,
      request: async (payload: unknown) => { calls.push(payload); return read; },
    });
    expect(host.view, 'view is required by SkillHostPort').toBeTypeOf('function');
    expect(await host.view({ skillId: 'opaque-project-skill', filePath: 'references/tests.md',
      origin: { ...origin, workspaceId: 'other' }, root: 'C:/external',
    } as SkillReadRequest)).toEqual(read);
    expect(calls).toEqual([{ action: 'view', origin,
      skillId: 'opaque-project-skill', filePath: 'references/tests.md',
    }]);
  });

  it('manages a detached proposal without allowing it to replace the host origin', async () => {
    const { createNodeSkillHostPort } = await implementation();
    const calls: unknown[] = [];
    const result = { status: 'awaiting_approval', origin, operationsApplied: 0 };
    const host = createNodeSkillHostPort({ origin,
      request: async (payload: unknown) => { calls.push(payload); return result; },
    });
    const proposal: SkillProposal = { version: 1, kind: 'propose', lesson: 'Verify before saving.',
      evidenceIds: ['native-a'], operations: [{ action: 'create', name: 'verify-work', content: 'body' }],
    };
    expect(host.manage, 'manage is required by SkillHostPort').toBeTypeOf('function');
    expect(await host.manage({ ...proposal, origin: { ...origin, workspaceId: 'other' },
      root: 'C:/external', autoApprove: true,
    } as SkillProposal)).toEqual(result);
    const forwarded = structuredClone(proposal);
    proposal.operations[0] = { action: 'create', name: 'mutated', content: 'later' };
    expect(calls).toEqual([{ action: 'manage', origin, mode: 'approve-all', evidence: [], proposal: forwarded }]);
  });

  it('records distinct viewed and delivered usage with a detached evidence list', async () => {
    const { createNodeSkillHostPort } = await implementation();
    const calls: unknown[] = [];
    const host = createNodeSkillHostPort({ origin,
      request: async (payload: unknown) => { calls.push(payload); },
    });
    expect(host.recordUsage, 'recordUsage must reach the service').toBeTypeOf('function');
    await host.recordUsage!('skill-a', 'viewed');
    await host.recordUsage!('skill-a', 'delivered');
    const evidenceIds = ['tool-a'];
    await host.recordUsage!('skill-a', 'used-with-evidence', evidenceIds);
    evidenceIds.push('tool-b');
    expect(calls).toEqual([
      { action: 'usage', origin, skillId: 'skill-a', kind: 'viewed', evidence: [] },
      { action: 'usage', origin, skillId: 'skill-a', kind: 'delivered', evidence: [] },
      { action: 'usage', origin, skillId: 'skill-a', kind: 'used-with-evidence', evidence: [], evidenceIds: ['tool-a'] },
    ]);
  });

  it('reads a real managed SKILL.md through the workspace service request API', async () => {
    const { createNodeSkillHostPort } = await implementation();
    // @ts-expect-error Backend JavaScript service has no declaration file yet.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'ugs-node-skill-port-'));
    try {
      const content = '---\nname: verify-work\ndescription: Use when verifying work.\n---\nRead the evidence.\n';
      const packageDir = join(dir, '.ultragamestudio', 'skills', 'verify-work');
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'SKILL.md'), content);
      const service = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
      const host = createNodeSkillHostPort({ origin, request: (payload: unknown) => service.request(payload) });
      const catalog = await host.list();
      expect(catalog.entries).toHaveLength(1);
      const read = await host.view({ skillId: catalog.entries[0].skillId });
      expect(read.content).toBe(await readFile(join(packageDir, 'SKILL.md'), 'utf8'));
      expect(read.fullRead).toBe(true);
      expect(read.readReceiptId).toBeTruthy();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('passes only trusted frozen mode and evidence into a real managed write', async () => {
    const { createNodeSkillHostPort } = await implementation();
    // @ts-expect-error Backend JavaScript service has no declaration file yet.
    const { createWorkspaceSkillService } = await import('../../../backend/src/workspace-skill-service.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'ugs-node-skill-write-'));
    const evidence: SkillEvidence[] = [{ evidenceId: 'native-check', origin: { ...origin }, occurredAt: 1,
      kind: 'verification', provenance: 'host-check', toolCallId: 'check', toolName: 'test',
      summary: 'Actual host check passed', status: 'success', exitCode: 0 }];
    try {
      const service = createWorkspaceSkillService({ dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
      const host = createNodeSkillHostPort({ origin, mode: 'auto-safe', evidence,
        request: (payload: unknown) => service.request(payload) });
      evidence[0].status = 'error';
      const content = '---\nname: verify-work\ndescription: Use when verifying work.\n---\nRead the evidence.\n';
      const result = await host.manage({ version: 1, kind: 'propose', lesson: 'Check actual evidence.',
        evidenceIds: ['native-check'], operations: [{ action: 'create', name: 'verify-work', content }],
        mode: 'off', evidence: [],
      } as SkillProposal);
      expect(result.status).toBe('applied');
      expect(result.operationsApplied).toBe(1);
      expect(await readFile(join(dir, '.ultragamestudio', 'skills', 'verify-work', 'SKILL.md'), 'utf8')).toBe(content);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('records adoption only after an exact-source full read and a frozen explicit host check', async () => {
    const { createNodeSkillHostPort, createNodeWorkspaceSkillRequest } = await implementation();
    const dir = await mkdtemp(join(tmpdir(), 'ugs-node-adoption-'));
    try {
      const packageDir = join(dir, '.ultragamestudio', 'skills', 'verify-adoption');
      const content = '---\nname: verify-adoption\ndescription: Use when checking exact adoption evidence.\n---\nPreserve every delivered rule.\n';
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'SKILL.md'), content);
      const request = createNodeWorkspaceSkillRequest({ cwd: dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
      const entry = (await request({ action: 'list', origin }) as SkillCatalog).entries[0];
      const generic: SkillEvidence = { evidenceId: 'ordinary-check', origin: { ...origin }, occurredAt: 1,
        kind: 'verification', provenance: 'native-tool', toolCallId: 'native-test', toolName: 'test',
        status: 'success', exitCode: 0, summary: 'Ordinary successful check.', skillId: entry.skillId, revision: entry.revision };
      const ordinary = createNodeSkillHostPort({ origin, evidence: [generic], request });
      await ordinary.view({ skillId: entry.skillId });
      await expect(ordinary.recordUsage!(entry.skillId, 'used-with-evidence', [generic.evidenceId])).rejects.toThrow(/adoption/);
      expect((await ordinary.list()).entries[0].usage?.usedWithEvidence).toBe(0);
      const facts: SkillEvidence[] = [{ ...generic, evidenceId: 'explicit-host-adoption', kind: 'skill-use',
        provenance: 'host-check', toolCallId: 'adoption-check', toolName: 'skill-adoption-check' }];
      const adopted = createNodeSkillHostPort({ origin, evidence: facts, request });
      facts[0].status = 'error';
      facts[0].revision = 'mutated-after-host-construction';
      await adopted.recordUsage!(entry.skillId, 'used-with-evidence', ['explicit-host-adoption']);
      await adopted.recordUsage!(entry.skillId, 'used-with-evidence', ['explicit-host-adoption']);
      const fresh = createNodeSkillHostPort({ origin,
        request: createNodeWorkspaceSkillRequest({ cwd: dir, hostId: origin.hostId, workspaceId: origin.workspaceId }) });
      const measured = (await fresh.list()).entries[0];
      expect(measured.usage?.usedWithEvidence).toBe(1);
      expect(measured.revision).toBe(entry.revision);
      expect((await fresh.view({ skillId: entry.skillId })).content).toBe(await readFile(join(packageDir, 'SKILL.md'), 'utf8'));
      const other = createNodeSkillHostPort({ origin: { ...origin, turnId: 'other-turn', runId: 'other-run' },
        evidence: [{ ...generic, evidenceId: 'other-source-adoption', kind: 'skill-use', provenance: 'host-check',
          origin: { ...origin, turnId: 'other-turn', runId: 'other-run' } }], request });
      await expect(other.recordUsage!(entry.skillId, 'used-with-evidence', ['other-source-adoption'])).rejects.toThrow(/complete.*read|full.read|adoption/);
      expect((await fresh.list()).entries[0].usage?.usedWithEvidence).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 20000);

  it('constructs a real Node workspace request adapter from the trusted cwd and identity', async () => {
    const module = await implementation();
    expect(module.createNodeWorkspaceSkillRequest, 'Node service request factory must exist').toBeTypeOf('function');
    const dir = await mkdtemp(join(tmpdir(), 'ugs-node-workspace-factory-'));
    try {
      const request = module.createNodeWorkspaceSkillRequest({ cwd: dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
      const host = module.createNodeSkillHostPort({ origin, request });
      expect((await host.list()).entries).toEqual([]);
      await expect(request({ action: 'list', origin: { ...origin, workspaceId: 'foreign' } })).rejects.toThrow(/workspace/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
