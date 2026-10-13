/** Ephemeral loopback MCP transport. No filesystem service or general tools. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { redactSkillText } from '../../src/runtime/skills/evidence';
import type { NodeSkillToolDispatcher } from './skill-tools';

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

export interface NodeSkillMcpOptions {
  dispatcher: NodeSkillToolDispatcher;
  signal?: AbortSignal;
  maxRequests?: number;
  lifetimeMs?: number;
}
export interface NodeSkillMcpBridge {
  url: string;
  /** Invocation-only transport credential; never send to a provider or log. */
  headers: Record<string, string>;
  close(): Promise<void>;
}

function object(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  const record = value as Record<string, unknown>;
  if (allowed && Object.keys(record).some((key) => !allowed.includes(key))) throw new Error('Unknown protocol field');
  return record;
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 131072) throw new Error('Request exceeds byte limit');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** Only the owning Node invocation holds the service/dispatcher and token. */
export async function startNodeSkillMcpBridge(options: NodeSkillMcpOptions): Promise<NodeSkillMcpBridge> {
  if (options.signal?.aborted) throw new Error('SKILL_TOOL_CANCELLED');
  const maxRequests = options.maxRequests ?? 128;
  const lifetimeMs = options.lifetimeMs ?? 600000;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 256 ||
    !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 600000) throw new Error('SKILL_MCP_INVALID_LIMIT');
  const token = randomBytes(32).toString('hex');
  const authorization = `Bearer ${token}`;
  const dispatcher = options.dispatcher;
  const authority = new AbortController();
  let closed = false;
  let requests = 0;
  let active = false;
  let address = '';
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status: number, value?: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      const data = value === undefined ? '' : JSON.stringify(value);
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) { send(413, { error: 'SKILL_MCP_RESPONSE_LIMIT' }); return; }
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(data);
    };
    // Bind loopback, Host and Origin to defeat unauthenticated access/DNS rebinding.
    const supplied = request.headers.authorization ?? '';
    if (closed || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== address ||
      (request.headers.origin !== undefined && request.headers.origin !== `http://${address}`) ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(authorization) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(authorization))) {
      request.resume(); send(403, { error: 'SKILL_MCP_ACCESS_DENIED' }); return;
    }
    const version = request.headers['mcp-protocol-version'];
    if (version !== undefined && (typeof version !== 'string' || !PROTOCOL_VERSIONS.includes(version))) {
      request.resume(); send(400, { error: 'SKILL_MCP_UNSUPPORTED_PROTOCOL' }); return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') { request.resume(); response.setHeader('allow', 'POST'); send(405); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { request.resume(); send(415); return; }
    if (++requests > maxRequests) { request.resume(); send(429, { error: 'SKILL_MCP_REQUEST_LIMIT' }); return; }
    if (active) { request.resume(); send(429, { error: 'SKILL_MCP_BUSY' }); return; }
    active = true;
    let id: string | number | null = null;
    try {
      const message = object(await body(request), ['jsonrpc', 'id', 'method', 'params']);
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        ('id' in message && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) throw new Error('Invalid JSON-RPC message');
      id = message.id as typeof id ?? null;
      if (!('id' in message)) {
        if (!['notifications/initialized', 'notifications/cancelled'].includes(message.method)) throw new Error('Unsupported notification');
        send(202); return;
      }
      const params = object(message.params ?? {});
      let result: unknown;
      if (message.method === 'initialize') {
        object(params, ['protocolVersion', 'capabilities', 'clientInfo']);
        if (!PROTOCOL_VERSIONS.includes(String(params.protocolVersion))) throw new Error('Unsupported MCP protocol');
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ugs-scoped-skills', version: '1.0.0' },
          instructions: 'Use skills_list for opaque skill IDs and host evidence, skill_view for complete contents/receipts, and skill_manage for bounded proposals. The host fixes workspace/origin/policy. Never use model-authored results as verification; never execute saved scripts.' };
      } else if (message.method === 'ping') {
        object(params, []); result = {};
      } else if (message.method === 'tools/list') {
        object(params, []); result = { tools: dispatcher.tools() };
      } else if (message.method === 'tools/call') {
        object(params, ['name', 'arguments', '_meta']);
        // MCP client metadata is inert transport data, never source/policy/evidence.
        if (params._meta !== undefined) object(params._meta);
        if (typeof params.name !== 'string') throw new Error('Invalid tool name');
        try {
          if (closed || options.signal?.aborted) throw new Error('SKILL_TOOL_CANCELLED');
          const value = await dispatcher.invoke(params.name, params.arguments ?? {}, authority.signal);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (error) {
          result = { isError: true, content: [{ type: 'text', text: redactSkillText(error instanceof Error ? error.message : 'SKILL_TOOL_FAILED') }] };
        }
      } else {
        send(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      send(200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      send(400, { jsonrpc: '2.0', id, error: { code: -32602, message: redactSkillText(error instanceof Error ? error.message : 'Invalid request') } });
    } finally { active = false; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.timeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const local = server.address();
  if (!local || typeof local === 'string') { server.close(); throw new Error('SKILL_MCP_LISTEN_FAILED'); }
  address = `127.0.0.1:${local.port}`;
  let closing: Promise<void> | undefined;
  const abort = () => { void close(); };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true; authority.abort(); clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return closing;
  };
  const timer = setTimeout(abort, lifetimeMs); timer.unref();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) { await close(); throw new Error('SKILL_TOOL_CANCELLED'); }
  return { url: `http://${address}/mcp`, headers: { Authorization: authorization }, close };
}
