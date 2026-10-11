// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillEvidence, SkillOrigin } from '../../src/runtime/skills/types';
import { createNodeWorkspaceSkillRequest } from './skill-host';
import { spawnCliAgent } from './cli-spawn';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
const origin: SkillOrigin = { hostId: 'node-cli', workspaceId: 'workspace-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'foreground-a' };
const content = '---\nname: verify-outcomes\ndescription: Use when checking outcomes.\n---\nRead actual results before reporting success.\n';

function fixture(cwd: string, source: string): string {
  const file = join(cwd, 'fixture.cjs'); writeFileSync(file, source);
  const shim = join(cwd, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
  writeFileSync(shim, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${file}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
  if (process.platform !== 'win32') chmodSync(shim, 0o755);
  return shim;
}

describe('Node foreground CLI skill MCP attachment', () => {
  it('reports unsupported transport without mounting a skill server or starting any reviewer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ugs-cli-transport-gate-')); dirs.push(cwd);
    const localHome = join(cwd, 'ugs-home'); mkdirSync(localHome); vi.stubEnv('UGS_HOME', localHome);
    const cli = fixture(cwd, `const fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--help')){process.stdout.write('unverified');process.exit(0);}process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync('ordinary-spawns.jsonl',JSON.stringify({args,hasCredential:typeof process.env.UGS_SKILL_MCP_TOKEN==='string'})+'\\n');process.stdout.write(JSON.stringify({type:'result',result:'ordinary task only'})+'\\n');});`);
    const unavailable: string[] = [];
    const calls: unknown[] = [];
    expect(await spawnCliAgent('ordinary task', { adapter: 'claude-code', cliCommand: cli, cwd,
      permission: 'readonly', skillTools: { origin, request: async (value) => { calls.push(value); return {}; } },
      onSkillToolsUnavailable: (reason) => unavailable.push(reason) })).toBe('ordinary task only');
    const spawns = readFileSync(join(cwd, 'ordinary-spawns.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).not.toContain('--mcp-config');
    expect(spawns[0].hasCredential).toBe(false);
    expect(unavailable).toEqual([expect.stringContaining('SKILL_TOOLS_UNAVAILABLE')]);
    expect(calls).toEqual([]);
    vi.stubEnv('ULTRAGAMESTUDIO_ENABLE_MCP', 'off');
    expect(await spawnCliAgent('ordinary disabled task', { adapter: 'claude-code', cliCommand: cli, cwd,
      permission: 'readonly', skillTools: { origin, request: async (value) => { calls.push(value); return {}; } },
      onSkillToolsUnavailable: (reason) => unavailable.push(reason) })).toBe('ordinary task only');
    const disabled = JSON.parse(readFileSync(join(cwd, 'ordinary-spawns.jsonl'), 'utf8').trim().split('\n')[1]);
    expect(disabled.args).toContain('--strict-mcp-config');
    expect(disabled.args).not.toContain('--mcp-config');
    expect(disabled.hasCredential).toBe(false);
    expect(unavailable[1]).toContain('MCP is explicitly disabled');
    expect(calls).toEqual([]);
  });

  it('readonly policy never authorizes manage and unsupported adapters never claim an attachment', async () => {
    const { attachNodeCliSkillTools, getCliSkillToolCapability } = await import('./skill-cli');
    for (const adapter of ['codex', 'gemini', 'grok', 'custom', 'unknown'])
      expect(getCliSkillToolCapability(adapter, '--mcp-config --output-format')).toMatchObject({ status: 'unavailable', foregroundOnly: true });
    const calls: unknown[] = [];
    const attachment = await attachNodeCliSkillTools({ origin, adapter: 'claude-code', help: '--mcp-config --output-format',
      permission: 'readonly', mode: 'auto-safe', request: async (value) => { calls.push(value); return { entries: [] }; } });
    try {
      const config = JSON.parse(readFileSync(attachment.path, 'utf8')).mcpServers.ugs_skill_tools;
      const header = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, String(value).replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => attachment.env[name as keyof typeof attachment.env] ?? '')]));
      const rpc = async (method: string, params: unknown) => (await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json', ...header }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      expect((await rpc('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['skills_list', 'skill_view']);
      expect(await rpc('tools/call', { name: 'skill_manage', arguments: {} })).toMatchObject({ result: { isError: true } });
      expect(calls).toEqual([]);
    } finally { await attachment.close(); }
  });

  it('keeps a disabled host mode disabled when foreground CLI permission asks for approval', async () => {
    const { attachNodeCliSkillTools } = await import('./skill-cli');
    const attachment = await attachNodeCliSkillTools({ origin, adapter: 'claude-code', help: '--mcp-config --output-format',
      permission: 'ask', mode: 'off', request: async () => ({ entries: [] }) });
    try {
      const config = JSON.parse(readFileSync(attachment.path, 'utf8')).mcpServers.ugs_skill_tools;
      const header = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, String(value).replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => attachment.env[name as keyof typeof attachment.env] ?? '')]));
      const response = await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json', ...header },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect((await response.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['skills_list', 'skill_view']);
    } finally { await attachment.close(); }
  });

  it('rejects foreign invocation identity before probing, starting a process or dispatching host calls', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ugs-cli-origin-gate-')); dirs.push(cwd);
    const cli = fixture(cwd, "require('node:fs').writeFileSync('unexpected-start','started');");
    const calls: unknown[] = [];
    await expect(spawnCliAgent('task', { adapter: 'claude-code', cliCommand: cli, cwd, runId: 'foreign/cli/run',
      skillTools: { origin, request: async (value) => { calls.push(value); return {}; } } })).rejects.toThrow(/ORIGIN_MISMATCH/);
    expect(() => readFileSync(join(cwd, 'unexpected-start'), 'utf8')).toThrow();
    expect(calls).toEqual([]);
  });

  it('attaches invocation-scoped tools so a real subprocess can actively learn and read through the same host service', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ugs-cli-active-skill-')); dirs.push(cwd);
    const localHome = join(cwd, 'ugs-home'); mkdirSync(localHome); vi.stubEnv('UGS_HOME', localHome);
    const check = join(cwd, 'check.test.cjs'); writeFileSync(check, "const {test}=require('node:test');const assert=require('node:assert/strict');test('host check',()=>assert.equal(2+2,4));");
    const checked = spawnSync(process.execPath, ['--test', check], { encoding: 'utf8' }); expect(checked.status).toBe(0);
    const nativeRun = `${origin.runId}/cli/invocation-a`;
    const evidence: SkillEvidence[] = [{ evidenceId: 'host-check-a', origin: { ...origin, runId: nativeRun }, occurredAt: 1,
      provenance: 'host-check', kind: 'verification', toolCallId: 'actual-test', toolName: 'node-test', summary: 'Actual Node test passed', status: 'success', exitCode: checked.status!, result: checked.stdout }];
    const proposal = { version: 1, kind: 'propose', lesson: 'Read actual outcomes.', evidenceIds: ['host-check-a'], operations: [{ action: 'create', name: 'verify-outcomes', content }] };
    const cli = fixture(cwd, `
const fs=require('node:fs'); const args=process.argv.slice(2);
if(args.includes('--help')) { process.stdout.write('--mcp-config --output-format'); process.exit(0); }
process.stdin.resume();process.stdin.on('end',async()=>{
try {
const path=args[args.indexOf('--mcp-config')+1];if(!path||args.indexOf('--mcp-config')<0) throw new Error('MISSING_SCOPED_SKILL_MCP');
const settings=JSON.parse(fs.readFileSync(path,'utf8')); const mcp=settings.mcpServers.ugs_skill_tools;
const headers={};for(const [key,value] of Object.entries(mcp.headers)) headers[key]=value.replace(/\\$\\{([A-Z_]+)\\}/g,(_,name)=>process.env[name]||'');
const rpc=async(method,params)=>{const res=await fetch(mcp.url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return await res.json();};
const tools=await rpc('tools/list',{});if(!tools.result.tools.some(t=>t.name==='skill_manage'))throw new Error('NO_ACTIVE_MANAGE');
const changed=await rpc('tools/call',{name:'skill_manage',arguments:${JSON.stringify(proposal)}});const result=JSON.parse(changed.result.content[0].text);if(result.status!=='applied')throw new Error(JSON.stringify(result));
const catalog=JSON.parse((await rpc('tools/call',{name:'skills_list',arguments:{}})).result.content[0].text);
const read=JSON.parse((await rpc('tools/call',{name:'skill_view',arguments:{skillId:catalog.entries[0].skillId}})).result.content[0].text);
if(!read.fullRead||read.content!==${JSON.stringify(content)})throw new Error('WRONG_READ');
const denied=await rpc('tools/call',{name:'skill_manage',arguments:{...${JSON.stringify(proposal)},root:'C:/foreign'}});if(!denied.result.isError)throw new Error('UNSCOPED_AUTHORITY_ACCEPTED');
process.stdout.write(JSON.stringify({type:'result',result:JSON.stringify({status:'active',fullRead:read.fullRead,rootDenied:denied.result.isError,configPath:path,url:mcp.url})})+'\\n');
}catch(error){process.stderr.write(String(error));process.exitCode=1;}
});`);
    const request = createNodeWorkspaceSkillRequest({ cwd, hostId: origin.hostId, workspaceId: origin.workspaceId });
    const result = await spawnCliAgent('task', { adapter: 'claude-code', cliCommand: cli, cwd, permission: 'full', runId: nativeRun,
      skillTools: { origin, request, mode: 'auto-safe', evidence: () => evidence } } as Parameters<typeof spawnCliAgent>[1]);
    const out = JSON.parse(result); expect(out).toMatchObject({ status: 'active', fullRead: true, rootDenied: true });
    expect(readFileSync(join(cwd, '.ultragamestudio', 'skills', 'verify-outcomes', 'SKILL.md'), 'utf8')).toBe(content);
    expect(() => readFileSync(out.configPath, 'utf8')).toThrow();
    await expect(fetch(out.url)).rejects.toThrow();
    // Real subprocess + loopback MCP + fsynced service writes on Windows.
    // Keep a finite integration-only budget; no transport/authority gate changes.
  }, 20000);
});
