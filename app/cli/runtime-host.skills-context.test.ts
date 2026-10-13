import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { RunGateway } from '../src/runtime';
import type { IRGraph } from '../src/core/ir';
import type { SkillNativeToolEvent, SkillOrigin } from '../src/runtime/skills/types';
import { runBlueprint } from './runtime-host';
import { createNodeSkillHostPort, createNodeWorkspaceSkillRequest } from './io/skill-host';
import { createCliNativeToolParser } from './io/stream';

const graph: IRGraph = { version: 1, meta: { name: 'node-skill-context', adapter: 'codex' }, nodes: [
  { id: 'start', type: 'start', params: {} },
  { id: 'work', type: 'agent', params: { prompt: 'verify-work task' } },
  { id: 'end', type: 'end', params: {} },
], edges: [
  { id: 's-w', from: { node: 'start', port: 'exec_out' }, to: { node: 'work', port: 'exec_in' }, kind: 'exec' },
  { id: 'w-e', from: { node: 'work', port: 'exec_out' }, to: { node: 'end', port: 'exec_in' }, kind: 'exec' },
] };

describe('Node runtime shared skill context injection', () => {
  it('reads a full managed skill into the actual DAG payload and returns redacted native evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ugs-node-dag-skills-'));
    const origin: SkillOrigin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'foreground-a' };
    try {
      const packageDir = join(dir, '.ultragamestudio', 'skills', 'verify-work');
      await mkdir(packageDir, { recursive: true });
      const file = join(packageDir, 'SKILL.md');
      const content = '---\nname: verify-work\ndescription: Use when verifying work.\n---\nACTUAL FULL RULE: verify before reporting.\n';
      await writeFile(file, content);
      const host = createNodeSkillHostPort({ origin, request: createNodeWorkspaceSkillRequest({ cwd: dir, hostId: origin.hostId, workspaceId: origin.workspaceId }) });
      const entry = (await host.list()).entries[0];
      const prompts: string[] = [];
      const events: SkillNativeToolEvent[] = [];
      const gateway: RunGateway = {
        resolveDirectRoute: () => null,
        resolveCliRoute: async () => ({ adapter: 'codex', cliCommand: 'fixture' }),
        completeText: async () => { throw new Error('HTTP is not used'); },
        spawnCliAgent: async (prompt, _adapter, opts) => {
          prompts.push(prompt);
          const parse = createCliNativeToolParser({ adapter: 'codex', runId: `${origin.runId}/cli/fixture-a` });
          for (const event of parse({ type: 'item.completed', item: { id: 'check-a', type: 'command_execution', command: 'npm test', status: 'completed', exit_code: 0, aggregated_output: 'PASS\npassword=fixture-not-a-credential' } })) opts.onToolEvent?.(event);
          return 'DONE';
        },
        applyOverride: (selection) => selection,
        nodeGatewayOverride: () => undefined,
        modelClassFromModelId: () => 'sonnet',
        recordCall: () => {},
        timeoutPolicy: () => ({ timeoutSeconds: 60, idleTimeoutSeconds: 30 }),
        effectiveConcurrency: (configured) => configured,
        effectiveConsensusSamples: (configured) => configured,
      };
      const result = await runBlueprint(graph, { cwd: dir, gateway, selection: { adapter: 'codex', modelClass: 'sonnet' }, nonInteractive: true,
        skills: { origin, host, explicitSkillIds: [entry.skillId] }, skillOrigin: origin, onToolEvent: (event) => events.push(event) });
      expect(result.success).toBe(true);
      expect(prompts[0]).toContain('ACTUAL FULL RULE');
      expect(prompts[0]).toContain('<UGS_SKILL_CONTEXT>');
      expect(events).toHaveLength(1);
      expect(result.skillEvidence).toMatchObject([{ origin: { ...origin, runId: `${origin.runId}/cli/fixture-a` }, provenance: 'native-tool', exitCode: 0, result: 'PASS\npassword=[REDACTED]' }]);
      const taskContext = JSON.parse(prompts[0].split('<UGS_SKILL_CONTEXT>\n')[1].split('\n</UGS_SKILL_CONTEXT>')[0]);
      expect(taskContext[0]).toMatchObject({ skillId: entry.skillId, content,
        hash: createHash('sha256').update(await readFile(file)).digest('hex') });
      expect(await readFile(file, 'utf8')).toBe(content);
      const updated = content.replace('ACTUAL FULL RULE', 'LATEST FULL RULE');
      await writeFile(file, updated);
      const nextOrigin = { ...origin, runId: 'foreground-b', turnId: 'turn-b' };
      const nextHost = createNodeSkillHostPort({ origin: nextOrigin, request: createNodeWorkspaceSkillRequest({ cwd: dir, hostId: nextOrigin.hostId, workspaceId: nextOrigin.workspaceId }) });
      expect((await runBlueprint(graph, { cwd: dir, gateway, selection: { adapter: 'codex', modelClass: 'sonnet' }, nonInteractive: true,
        skills: { origin: nextOrigin, host: nextHost, explicitSkillIds: [entry.skillId] }, skillOrigin: nextOrigin })).success).toBe(true);
      const nextContext = JSON.parse(prompts[1].split('<UGS_SKILL_CONTEXT>\n')[1].split('\n</UGS_SKILL_CONTEXT>')[0]);
      expect(nextContext[0]).toMatchObject({ skillId: entry.skillId, content: updated,
        hash: createHash('sha256').update(await readFile(file)).digest('hex') });
      expect(nextContext[0].hash).not.toBe(taskContext[0].hash);
      expect(await readFile(file, 'utf8')).toBe(updated);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
