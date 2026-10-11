import { Blob as NodeBlob } from 'node:buffer';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayProvider, GatewaySelection } from './types';
import type { SkillModelRequest } from '@/runtime/skills/types';

const seams = vi.hoisted(() => ({
  providers: [] as GatewayProvider[],
  cli: vi.fn(() => { throw new Error('FORBIDDEN_CLI_SPAWN'); }),
  invoke: vi.fn(),
  genericCompletion: vi.fn(() => { throw new Error('FORBIDDEN_GENERIC_GATEWAY'); }),
}));
vi.mock('@/lib/gatewayConfig', () => ({ listGatewayProviders: () => seams.providers }));
vi.mock('@/lib/tauri', async (original) => ({
  ...await original<typeof import('@/lib/tauri')>(),
  aiEditViaCli: seams.cli,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: seams.invoke }));
vi.mock('./modelGateway', () => ({ completeGatewayText: seams.genericCompletion }));
import * as gateway from './skillReviewGateway';

const selection: GatewaySelection = {
  adapter: 'codex', modelClass: 'review-model', providerId: 'review-provider', channelId: 'http',
};
const request = (overrides: Partial<SkillModelRequest> = {}): SkillModelRequest => ({
  system: 'Return the skill review JSON protocol only.',
  userContent: 'Evidence: a real host check passed.',
  signal: new AbortController().signal,
  timeoutMs: 1000,
  maxOutputTokens: 128,
  ...overrides,
});

const closers: Array<() => Promise<void>> = [];
async function httpFixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  return `http://127.0.0.1:${address.port}`;
}
function configure(baseUrl: string, transport: GatewayProvider['channels'][number]['route']['transport'] = 'openai-compatible'): void {
  seams.providers = [{
    id: 'review-provider', kind: 'codex', adapter: 'codex', name: 'Local test HTTP',
    channels: [{
      id: 'http', name: 'completion', apiKey: undefined, baseUrl, model: 'review-model', models: undefined,
      route: { transport, baseUrl, model: 'review-model', models: undefined },
    }],
  }];
}

beforeEach(() => {
  seams.providers = [];
  seams.cli.mockClear();
  seams.genericCompletion.mockClear();
  seams.invoke.mockReset();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('completion-only skill review gateway', () => {
  it('sends only non-streaming text completion fields over real HTTP', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const baseUrl = await httpFixture((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        captured.push({ url: req.url ?? '', body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"version":1,"kind":"noop","reason":"No new lesson"}' } }],
          usage: { prompt_tokens: 31, completion_tokens: 12, total_tokens: 43 },
        }));
      });
    });
    configure(baseUrl);
    expect(gateway.createSkillReviewModelPort).toBeTypeOf('function');
    const port = gateway.createSkillReviewModelPort(selection);
    const result = await port.complete(request());
    expect(port.capability).toBe('completion-only');
    expect(captured).toEqual([{
      url: '/v1/chat/completions',
      body: {
        model: 'review-model', stream: false, max_tokens: 128,
        messages: [
          { role: 'system', content: 'Return the skill review JSON protocol only.' },
          { role: 'user', content: 'Evidence: a real host check passed.' },
        ],
      },
    }]);
    expect(result).toEqual({
      text: '{"version":1,"kind":"noop","reason":"No new lesson"}',
      usage: { inputTokens: 31, outputTokens: 12, totalTokens: 43, estimated: false },
    });
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('passes each model call remaining hard budget and one MiB byte cap through desktop IPC', async () => {
    configure('http://127.0.0.1/model');
    vi.stubGlobal('isTauri', true);
    seams.invoke.mockResolvedValue({
      status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'application/json' }],
      bodyBase64: btoa(JSON.stringify({ choices: [{ message: { content: 'noop' } }] })),
      url: 'http://127.0.0.1/model/v1/chat/completions',
    });
    const port = gateway.createSkillReviewModelPort(selection);
    await port.complete(request({ timeoutMs: 137 }));
    await port.complete(request({ timeoutMs: 93 }));
    const budgets = seams.invoke.mock.calls.map(([, args]) => args.request);
    expect(budgets).toHaveLength(2);
    expect(budgets[0].timeoutMs).toBeGreaterThan(0);
    expect(budgets[0].timeoutMs).toBeLessThanOrEqual(137);
    expect(budgets[1].timeoutMs).toBeGreaterThan(0);
    expect(budgets[1].timeoutMs).toBeLessThanOrEqual(93);
    expect(budgets.map((call) => call.maxResponseBytes)).toEqual([1048576, 1048576]);
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('deducts request construction time before passing the remaining HTTP budget', async () => {
    configure('http://127.0.0.1/model');
    vi.stubGlobal('isTauri', true);
    seams.invoke.mockResolvedValue({
      status: 200, statusText: 'OK', headers: [],
      bodyBase64: btoa(JSON.stringify({ choices: [{ message: { content: 'noop' } }] })),
      url: 'http://127.0.0.1/model/v1/chat/completions',
    });
    const reviewRequest = request({ timeoutMs: 180 });
    Object.defineProperty(reviewRequest, 'maxOutputTokens', { get: () => {
      const until = performance.now() + 50;
      while (performance.now() < until) { /* synchronous serialization work */ }
      return 128;
    } });
    await gateway.createSkillReviewModelPort(selection).complete(reviewRequest);
    expect(seams.invoke.mock.calls[0][1].request.timeoutMs).toBeLessThanOrEqual(130);
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('speaks Anthropic non-streaming text-only Messages without tools or session permissions', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const baseUrl = await httpFixture((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        captured.push({ url: req.url ?? '', body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: '{"version":1,"kind":"noop","reason":"checked"}' }],
          usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } }));
      });
    });
    configure(baseUrl, 'anthropic');
    const hostileRequest = { ...request(), permission: 'full', cwd: 'E:/private', tools: [{ name: 'shell' }],
      tool_choice: 'auto', hooks: ['execute'], mcp: { local: true }, sessionId: 'foreground', resume: true };
    const result = await gateway.createSkillReviewModelPort(selection).complete(hostileRequest);
    expect(captured).toEqual([{
      url: '/v1/messages',
      body: { model: 'review-model', stream: false, max_tokens: 128,
        system: request().system, messages: [{ role: 'user', content: request().userContent }] },
    }]);
    expect(result).toEqual({ text: '{"version":1,"kind":"noop","reason":"checked"}',
      usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22, estimated: false } });
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('returns an explicit estimate when provider usage is absent rather than pretending it is real or zero', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"version":1,"kind":"noop","reason":"checked"}' } }] }));
    });
    configure(baseUrl);
    const result = await gateway.createSkillReviewModelPort(selection).complete(request());
    expect(result.usage?.estimated).toBe(true);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.usage?.totalTokens).toBe((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0));
  });

  it('keeps estimated totals complete when Anthropic reports only one token direction', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'needs another review' }], usage: { input_tokens: 9 } }));
    });
    configure(baseUrl, 'anthropic');
    const result = await gateway.createSkillReviewModelPort(selection).complete(request());
    expect(result.usage).toMatchObject({ inputTokens: 9, estimated: true });
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.usage?.totalTokens).toBe((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0));
  });

  it('does not resolve a completion aborted while consuming a late response body', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
    });
    configure(baseUrl);
    const controller = new AbortController();
    const originalJson = Response.prototype.json;
    vi.spyOn(Response.prototype, 'json').mockImplementation(async function(this: Response) {
      const result = await originalJson.call(this);
      controller.abort();
      return result;
    });
    await expect(gateway.createSkillReviewModelPort(selection).complete(request({ signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('rejects results whose parsing completed after the model-call deadline', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
    });
    configure(baseUrl);
    const originalJson = Response.prototype.json;
    vi.spyOn(Response.prototype, 'json').mockImplementation(async function(this: Response) {
      const result = await originalJson.call(this);
      await new Promise((resolve) => setTimeout(resolve, 90));
      return result;
    });
    await expect(gateway.createSkillReviewModelPort(selection).complete(request({ timeoutMs: 60 })))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('terminates a stalled parser within the same hard model-call budget', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'noop' } }] }));
    });
    configure(baseUrl);
    vi.spyOn(Response.prototype, 'json').mockImplementation(() => new Promise(() => {}));
    const pending = gateway.createSkillReviewModelPort(selection).complete(request({ timeoutMs: 40 }));
    const observed = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve({ name: 'STALLED_PAST_BUDGET' }), 180)),
    ]);
    expect(observed).toMatchObject({ name: 'TimeoutError' });
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('never starts a CLI after a real HTTP provider failure', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture unavailable' } }));
    });
    configure(baseUrl);
    await expect(gateway.createSkillReviewModelPort(selection).complete(request()))
      .rejects.toThrow('SKILL_REVIEW_HTTP_ERROR: HTTP 503');
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('never starts a CLI after a real HTTP connection reset', async () => {
    const baseUrl = await httpFixture((req) => req.socket.destroy());
    configure(baseUrl);
    await expect(gateway.createSkillReviewModelPort(selection).complete(request())).rejects.toThrow();
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('bounds an oversized live review response without falling back to a CLI', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(gateway.SKILL_REVIEW_MAX_RESPONSE_BYTES + 1));
    });
    configure(baseUrl);
    await expect(gateway.createSkillReviewModelPort(selection).complete(request({ timeoutMs: 1500 })))
      .rejects.toThrow('HTTP_RESPONSE_TOO_LARGE');
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('terminates a real hanging review body with no CLI fallback', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    configure(baseUrl);
    await expect(gateway.createSkillReviewModelPort(selection).complete(request({ timeoutMs: 60 })))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('aborts a live review socket without exposing a completion or invoking a CLI', async () => {
    let bodyStarted!: () => void;
    const ready = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      bodyStarted();
    });
    configure(baseUrl);
    const controller = new AbortController();
    const pending = gateway.createSkillReviewModelPort(selection).complete(request({ signal: controller.signal }));
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.abort();
    await assertion;
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('never forwards non-text or invalid output-limit request values to HTTP', async () => {
    configure('http://127.0.0.1/model');
    vi.stubGlobal('isTauri', true);
    for (const malformed of [
      { system: { tools: [{ name: 'shell' }] } },
      { userContent: [{ type: 'tool_use', id: 'hostile', name: 'shell', input: { command: 'run' } }] },
      { maxOutputTokens: 0 },
      { maxOutputTokens: NaN },
      { maxOutputTokens: { permission: 'full' } },
    ]) {
      const untrusted = { ...request(), ...malformed } as unknown as SkillModelRequest;
      await expect(gateway.createSkillReviewModelPort(selection).complete(untrusted))
        .rejects.toThrow('SKILL_REVIEW_INVALID_REQUEST');
    }
    expect(seams.invoke).not.toHaveBeenCalled();
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('uses the validated text snapshots for both HTTP and estimated usage', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'noop' } }] }));
    });
    configure(baseUrl);
    const reviewRequest = request();
    const readSystem = vi.fn(() => 'Validated system text.');
    const readUser = vi.fn(() => 'Validated evidence text.');
    Object.defineProperties(reviewRequest, {
      system: { get: readSystem }, userContent: { get: readUser },
    });
    const result = await gateway.createSkillReviewModelPort(selection).complete(reviewRequest);
    expect(result.usage?.estimated).toBe(true);
    expect(readSystem).toHaveBeenCalledOnce();
    expect(readUser).toHaveBeenCalledOnce();
  });

  it('never exposes a completion cancelled during usage normalization', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'noop' } }] }));
    });
    configure(baseUrl);
    const controller = new AbortController();
    const originalJson = Response.prototype.json;
    vi.spyOn(Response.prototype, 'json').mockImplementation(async function(this: Response) {
      const payload = await originalJson.call(this);
      Object.defineProperty(payload, 'usage', { get: () => {
        controller.abort();
        return { prompt_tokens: 9, completion_tokens: 4 };
      } });
      return payload;
    });
    await expect(gateway.createSkillReviewModelPort(selection).complete(request({ signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('rejects tool-bearing or malformed provider envelopes rather than accepting their text', async () => {
    const responses: unknown[] = [
      { choices: [{ message: { content: 'noop', tool_calls: [{ id: 'call', type: 'function', function: { name: 'shell' } }] } }] },
      { choices: [{ message: { content: 'noop', function_call: { name: 'shell' } } }] },
      { content: [{ type: 'text', text: 'noop' }, { type: 'tool_use', name: 'shell', input: {} }] },
      null,
      { content: { type: 'text', text: 'noop' } },
    ];
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responses.shift()));
    });
    for (const transport of ['openai-compatible', 'openai-compatible', 'anthropic', 'openai-compatible', 'anthropic'] as const) {
      configure(baseUrl, transport);
      await expect(gateway.createSkillReviewModelPort(selection).complete(request()))
        .rejects.toThrow('SKILL_REVIEW_INVALID_RESPONSE');
    }
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('rejects extra OpenAI choices or tool-call finish reasons without falling back to CLI', async () => {
    const responses = [
      { choices: [{ message: { content: 'noop' }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: 'noop' } }, { message: { content: null, tool_calls: [{ function: { name: 'shell' } }] } }] },
    ];
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responses.shift()));
    });
    configure(baseUrl);
    for (let i = 0; i < 2; i += 1) {
      await expect(gateway.createSkillReviewModelPort(selection).complete(request()))
        .rejects.toThrow('SKILL_REVIEW_INVALID_RESPONSE');
    }
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('accepts empty optional OpenAI tool fields as a text-only response', async () => {
    const responses = [
      { choices: [{ message: { content: 'noop', tool_calls: null, function_call: null } }] },
      { choices: [{ message: { content: 'noop', tool_calls: [] } }] },
    ];
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responses.shift()));
    });
    configure(baseUrl);
    for (let i = 0; i < 2; i += 1) {
      expect((await gateway.createSkillReviewModelPort(selection).complete(request())).text).toBe('noop');
    }
  });

  it('rejects malformed Anthropic blocks and tool stop reasons despite accompanying text', async () => {
    const responses = [
      { content: [{ type: 'text', text: 'noop' }, { type: 'text', text: { command: 'run' } }] },
      { content: [{ type: 'text', text: 'noop' }, []] },
      { content: [{ type: 'text', text: 'noop' }], stop_reason: 'tool_use' },
    ];
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responses.shift()));
    });
    configure(baseUrl, 'anthropic');
    for (let i = 0; i < 3; i += 1) {
      await expect(gateway.createSkillReviewModelPort(selection).complete(request()))
        .rejects.toThrow('SKILL_REVIEW_INVALID_RESPONSE');
    }
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('honors the explicitly selected OpenAI model over a channel default without repairing its id', () => {
    configure('http://127.0.0.1/model');
    seams.providers[0].channels[0].route.model = 'provider-default';
    seams.providers[0].channels[0].model = 'provider-default';
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelClass: 'exact/session-model' })?.model)
      .toBe('exact/session-model');
    seams.providers[0].channels[0].route.models = { 'exact/session-model': 'explicit-tier-map' };
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelClass: 'exact/session-model' })?.model)
      .toBe('explicit-tier-map');
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelOverride: 'literal-pinned/model' })?.model)
      .toBe('literal-pinned/model');
  });

  it('maps unpinned Anthropic tiers to concrete direct model ids, never sending a CLI alias', () => {
    configure('http://127.0.0.1/model', 'anthropic');
    seams.providers[0].channels[0].route.model = undefined;
    seams.providers[0].channels[0].model = undefined;
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelClass: 'sonnet' })?.model)
      .toBe('claude-sonnet-4-6');
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelClass: 'default' })).toBeNull();
  });

  it('never treats an inherited model-map property as a configured route or forwards non-text model ids', () => {
    configure('http://127.0.0.1/model', 'anthropic');
    const channel = seams.providers[0].channels[0];
    channel.route.model = undefined;
    channel.model = undefined;
    channel.route.models = {};
    channel.models = {};
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelClass: 'toString' })?.model).toBe('toString');
    channel.route.models = { 'review-model': { tools: [{ name: 'shell' }] } } as unknown as Record<string, string>;
    expect(gateway.resolveSkillReviewGatewayRoute(selection)).toBeNull();
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelOverride: '' })).toBeNull();
    expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelOverride: { permissions: 'full' } } as unknown as GatewaySelection))
      .toBeNull();
  });

  it('fails closed instead of guessing among unpinned HTTP providers', () => {
    configure('http://127.0.0.1/model');
    seams.providers.push({ ...seams.providers[0], id: 'another-provider' });
    const ambiguous = { adapter: 'codex', modelClass: 'review-model' };
    expect(gateway.resolveSkillReviewGatewayRoute(ambiguous)).toBeNull();
    expect(() => gateway.createSkillReviewModelPort(ambiguous)).toThrow('SKILL_REVIEW_UNAVAILABLE');
    expect(seams.cli).not.toHaveBeenCalled();
  });

  it('uses an explicitly configured review HTTP transport without changing the source CLI channel', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const baseUrl = await httpFixture((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        captured.push({ url: req.url ?? '', body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'explicit HTTP review' } }] }));
      });
    });
    configure(baseUrl, 'cli');
    expect(gateway.resolveSkillReviewGatewayRoute(selection)?.transport).toBe('openai-compatible');
    const result = await gateway.createSkillReviewModelPort(selection, undefined, 'openai-compatible').complete(request());
    expect(result.text).toBe('explicit HTTP review');
    expect(captured).toEqual([{
      url: '/v1/chat/completions',
      body: {
        model: 'review-model', stream: false, max_tokens: 128,
        messages: [{ role: 'system', content: request().system }, { role: 'user', content: request().userContent }],
      },
    }]);
    expect(seams.providers[0].channels[0].route.transport).toBe('cli');
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });

  it('refuses simulator and implicit selections without switching providers', () => {
    for (const transport of ['simulator'] as const) {
      configure('http://127.0.0.1/model', transport);
      expect(gateway.resolveSkillReviewGatewayRoute(selection)).toBeNull();
      expect(() => gateway.createSkillReviewModelPort(selection)).toThrow('SKILL_REVIEW_UNAVAILABLE');
    }
    configure('http://127.0.0.1/model');
    for (const chosen of [
      { ...selection, systemDefault: true },
      { ...selection, providerId: 'stale-provider' },
      { ...selection, channelId: 'stale-channel' },
      { ...selection, adapter: 'unknown-adapter' },
    ]) expect(() => gateway.createSkillReviewModelPort(chosen)).toThrow('SKILL_REVIEW_UNAVAILABLE');
    expect(seams.cli).not.toHaveBeenCalled();
    expect(seams.genericCompletion).not.toHaveBeenCalled();
  });
});

it('reviews the exact configured CLI endpoint and model without launching a coding process', () => {
  configure('http://127.0.0.1/model', 'cli');
  expect(gateway.resolveSkillReviewGatewayRoute({ ...selection, modelClass: 'source-model' })).toMatchObject({
    providerId: selection.providerId, channelId: selection.channelId, model: 'source-model', transport: 'openai-compatible',
  });
  expect(gateway.resolveSkillReviewGatewayRoute({ adapter: 'codex', modelClass: 'default' })).toBeNull();
  expect(seams.cli).not.toHaveBeenCalled();
});
