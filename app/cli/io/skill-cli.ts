/** Foreground CLI MCP attachment, not a completion-only review capsule. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSkillToolDispatcher, type NodeSkillToolOptions } from './skill-tools';
import { startNodeSkillMcpBridge } from './skill-mcp';

export const NODE_SKILL_MCP_TOKEN_ENV = 'UGS_SKILL_MCP_TOKEN';
export interface CliSkillToolCapability {
  adapter: string;
  capability: 'scoped-skill-tools';
  status: 'available' | 'unavailable';
  /** A transport gate never claims the coding CLI is a safe review sandbox. */
  foregroundOnly: true;
  reason: string;
}
export function getCliSkillToolCapability(adapter: string, help: string): CliSkillToolCapability {
  const available = ['claude-code', 'claude'].includes(adapter) && ['--mcp-config', '--output-format'].every((flag) => help.includes(flag));
  return { adapter, capability: 'scoped-skill-tools', foregroundOnly: true, status: available ? 'available' : 'unavailable',
    reason: available ? 'Foreground MCP transport flags present; host scopes every skill call. Not a review capsule.'
      : 'SKILL_TOOLS_UNAVAILABLE: this foreground CLI lacks a verified skill MCP transport; no general reviewer fallback.' };
}
export interface NodeCliSkillAttachmentOptions extends NodeSkillToolOptions {
  adapter: string;
  help: string;
  permission?: string;
}
export async function attachNodeCliSkillTools(options: NodeCliSkillAttachmentOptions) {
  const capability = getCliSkillToolCapability(options.adapter, options.help);
  if (capability.status !== 'available') throw new Error(capability.reason);
  const dispatcher = createNodeSkillToolDispatcher({ ...options,
    allowManage: options.permission === 'readonly' ? false : options.allowManage,
    mode: options.mode === 'off' ? 'off' : options.permission === 'ask' ? 'approve-all' : options.mode,
  });
  const bridge = await startNodeSkillMcpBridge({ dispatcher, signal: options.signal });
  let dir: string | undefined;
  try {
    const scratch = process.env.TMPDIR?.trim() || tmpdir();
    mkdirSync(scratch, { recursive: true });
    dir = mkdtempSync(join(scratch, 'ugs-scoped-skill-mcp-'));
    const path = join(dir, 'settings.json');
    const mcp = { type: 'http', url: bridge.url, headers: { Authorization: `Bearer \${${NODE_SKILL_MCP_TOKEN_ENV}}` } };
    writeFileSync(path, JSON.stringify({ mcpServers: { ugs_skill_tools: mcp } }), { mode: 0o600, flag: 'wx' });
    return { path, mcp, env: { [NODE_SKILL_MCP_TOKEN_ENV]: bridge.headers.Authorization.slice('Bearer '.length) },
      close: async () => { await bridge.close(); rmSync(dir!, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } };
  } catch (error) {
    await bridge.close(); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); throw error;
  }
}
