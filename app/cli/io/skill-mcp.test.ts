// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillEvidence, SkillOrigin } from '../../src/runtime/skills/types';
import { createNodeWorkspaceSkillRequest } from './skill-host';
import { createNodeSkillToolDispatcher } from './skill-tools';

const dirs: string[] = [];
const bridges: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});
const origin: SkillOrigin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a/cli/invocation-a' };
const content = '---\nname: verify-outcomes\ndescription: Use when checking outcomes.\n---\nRead actual outcomes before reporting success.\n';
const evidence: SkillEvidence[] = [{ evidenceId: 'host-test', origin, occurredAt: 1, kind: 'verification', provenance: 'host-check',
  toolCallId: 'actual-test', toolName: 'test', status: 'success', exitCode: 0, summary: 'An actual host check passed.' }];

async function implementation() {
  const module = await import(/* @vite-ignore */ './skill-mcp');
  expect(module.startNodeSkillMcpBridge, 'Scoped inbound MCP bridge must exist').toBeTypeOf('function');
  return module;
}

describe('Node scoped inbound skill MCP', () => {
  it('refuses unauthenticated, cross-origin, cross-host and skill-authority requests over real HTTP', async () => {
    const { startNodeSkillMcpBridge } = await implementation();
    const calls: unknown[] = [];
    const bridge = await startNodeSkillMcpBridge({ dispatcher: createNodeSkillToolDispatcher({ origin,
      mode: 'auto-safe', evidence: () => evidence, request: async (value) => { calls.push(value); return { entries: [] }; } }) });
    bridges.push(bridge);
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skills_list', arguments: {} } });
    for (const headers of [{}, { ...bridge.headers, Origin: 'http://foreign.example' }]) {
      const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: rpc });
      expect(response.status, Object.keys(headers).join(',') || 'missing authorization').toBe(403);
      expect(await response.json()).toEqual({ error: 'SKILL_MCP_ACCESS_DENIED' });
    }
    // fetch controls Host; raw Node HTTP is required to exercise rebinding.
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(bridge.url, { method: 'POST', headers: {
        'content-type': 'application/json', ...bridge.headers, Host: 'foreign.example',
      } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject); request.end(rpc);
    });
    expect(foreignHost).toBe(403);
    for (const params of [
      { name: 'terminal', arguments: {} }, { name: 'skill_view', arguments: { skillId: 'opaque', filePath: '../outside' } },
      { name: 'skill_manage', arguments: { version: 1, kind: 'propose', lesson: 'check', evidenceIds: ['host-test'],
        operations: [{ action: 'create', name: 'verify-outcomes', content }], origin: { ...origin, workspaceId: 'foreign' } } },
    ]) {
      const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', ...bridge.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { isError: true } });
    }
    expect(calls).toEqual([]);
  });

  it('bounds bytes, request count and lifetime and removes the port on abort or close', async () => {
    const { startNodeSkillMcpBridge } = await implementation();
    const tools = createNodeSkillToolDispatcher({ origin, request: async () => ({ entries: [] }) });
    const limited = await startNodeSkillMcpBridge({ dispatcher: tools, maxRequests: 2 }); bridges.push(limited);
    const rpc = async (payload: string) => fetch(limited.url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...limited.headers }, body: payload });
    const oversize = await rpc(JSON.stringify({ oversized: 'x'.repeat(131073) }));
    expect(oversize.status).toBe(400);
    expect(await oversize.json()).toMatchObject({ error: { message: expect.stringContaining('byte limit') } });
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect((await rpc(ping)).status).toBe(200);
    expect((await rpc(ping)).status).toBe(429);
    await limited.close(); await limited.close();
    await expect(fetch(limited.url)).rejects.toThrow();
    const controller = new AbortController();
    const aborted = await startNodeSkillMcpBridge({ dispatcher: tools, signal: controller.signal }); bridges.push(aborted);
    controller.abort(); await aborted.close();
    await expect(fetch(aborted.url)).rejects.toThrow();
    await expect(startNodeSkillMcpBridge({ dispatcher: tools, signal: controller.signal })).rejects.toThrow(/CANCELLED/);
    const expired = await startNodeSkillMcpBridge({ dispatcher: tools, lifetimeMs: 30 }); bridges.push(expired);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(fetch(expired.url)).rejects.toThrow();
    for (const options of [{ maxRequests: 257 }, { lifetimeMs: 600001 }])
      await expect(startNodeSkillMcpBridge({ dispatcher: tools, ...options })).rejects.toThrow(/INVALID_LIMIT/);
  });

  it('prevents an in-flight bridge from using host authority after its port is explicitly closed', async () => {
    const { startNodeSkillMcpBridge } = await implementation();
    const calls: unknown[] = [];
    const tools = createNodeSkillToolDispatcher({ origin, mode: 'auto-safe',
      request: async (value) => { calls.push(value); return {}; },
      evidence: () => { void bridge.close(); return evidence; } });
    const bridge = await startNodeSkillMcpBridge({ dispatcher: tools }); bridges.push(bridge);
    await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', ...bridge.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_manage', arguments: {
        version: 1, kind: 'propose', lesson: 'Check outcomes.', evidenceIds: ['host-test'], operations: [{ action: 'create', name: 'verify-outcomes', content }],
      } } }) }).catch(() => {});
    await bridge.close();
    expect(calls).toEqual([]);
  });

  it('negotiates a current client protocol and rejects an unsupported HTTP version before host dispatch', async () => {
    const { startNodeSkillMcpBridge } = await implementation();
    const calls: unknown[] = [];
    const bridge = await startNodeSkillMcpBridge({ dispatcher: createNodeSkillToolDispatcher({ origin,
      request: async (value) => { calls.push(value); return { entries: [] }; } }) });
    bridges.push(bridge);
    const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', ...bridge.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'current-client', version: '1' },
      } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
    const rejected = await fetch(bridge.url, { method: 'POST', headers: {
      'content-type': 'application/json', 'MCP-Protocol-Version': 'unsupported', ...bridge.headers,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(rejected.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts inert CLI transport metadata without promoting it to host authority', async () => {
    const { startNodeSkillMcpBridge } = await implementation();
    const cwd = await mkdtemp(join(tmpdir(), 'ugs-skill-mcp-meta-')); dirs.push(cwd);
    const service = createNodeWorkspaceSkillRequest({ cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const calls: unknown[] = [];
    const bridge = await startNodeSkillMcpBridge({ dispatcher: createNodeSkillToolDispatcher({ origin,
      request: async (value) => { calls.push(value); return service(value); }, mode: 'auto-safe', evidence: () => evidence }) });
    bridges.push(bridge);
    const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', ...bridge.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cli-native', method: 'tools/call', params: {
        name: 'skill_manage', arguments: { version: 1, kind: 'propose', lesson: 'Read actual outcomes.', evidenceIds: ['host-test'],
          operations: [{ action: 'create', name: 'verify-outcomes', content }] },
        _meta: { 'claudecode/toolUseId': 'original-native-id', progressToken: 'original-progress-id',
          origin: { ...origin, workspaceId: 'foreign' }, root: 'C:/foreign', mode: 'off' },
      } }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(calls).toMatchObject([{ action: 'manage', origin, mode: 'auto-safe', evidence }]);
    expect(calls[0]).not.toHaveProperty('_meta');
    expect(calls[0]).not.toHaveProperty('root');
    expect(await readFile(join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md'), 'utf8')).toBe(content);
  });

  it('exposes only three scoped tools and completes actual HTTP calls against the injected disk service', async () => {
    const { startNodeSkillMcpBridge } = await implementation();
    const cwd = await mkdtemp(join(tmpdir(), 'ugs-skill-mcp-')); dirs.push(cwd);
    const request = createNodeWorkspaceSkillRequest({ cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const bridge = await startNodeSkillMcpBridge({ dispatcher: createNodeSkillToolDispatcher({ origin, request, mode: 'auto-safe', evidence: () => evidence }) });
    bridges.push(bridge);
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', ...bridge.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      expect(response.status).toBe(200); return await response.json();
    };
    expect(await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'actual-http-test', version: '1' } }))
      .toMatchObject({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
    expect((await rpc('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['skills_list', 'skill_view', 'skill_manage']);
    const result = await rpc('tools/call', { name: 'skill_manage', arguments: { version: 1, kind: 'propose', lesson: 'Read actual outcomes.',
      evidenceIds: ['host-test'], operations: [{ action: 'create', name: 'verify-outcomes', content }] } });
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ status: 'applied', operationsApplied: 1 });
    const catalog = JSON.parse((await rpc('tools/call', { name: 'skills_list', arguments: {} })).result.content[0].text);
    const viewed = JSON.parse((await rpc('tools/call', { name: 'skill_view', arguments: { skillId: catalog.entries[0].skillId } })).result.content[0].text);
    expect(viewed).toMatchObject({ fullRead: true, content, hash: catalog.entries[0].hash });
    expect(await readFile(join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md'), 'utf8')).toBe(content);
  });
});
