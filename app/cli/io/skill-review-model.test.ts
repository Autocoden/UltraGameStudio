import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedRoute } from '../config/providers';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function server(reply: (body: Record<string, unknown>, path: string) => unknown) {
  const instance = createServer((req, res) => {
    let input = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { input += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(JSON.parse(input), req.url ?? '')));
    });
  });
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('server failed');
  return `http://127.0.0.1:${address.port}`;
}

function route(baseUrl: string, transport: ResolvedRoute['transport'] = 'openai-compatible'): ResolvedRoute {
  return { selection: { adapter: 'custom', modelClass: 'review' }, adapter: 'custom', modelClass: 'review',
    transport, mode: 'direct', model: 'review-model', baseUrl, apiKey: 'test-fixture-only' };
}
const request = () => ({ system: 'review instructions', userContent: 'evidence snapshot',
  signal: new AbortController().signal, timeoutMs: 1000, maxOutputTokens: 100 });

async function implementation() {
  return await import(/* @vite-ignore */ './skill-review-model');
}

describe('Node completion-only skill review HTTP port', () => {
  it('sends a tool-free one-shot request to the injected direct route and preserves usage', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const payloads: unknown[] = [];
    const baseUrl = await server((body, path) => {
      payloads.push({ body, path });
      return { choices: [{ message: { content: '{"version":1,"kind":"noop","reason":"no new lesson"}' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
    });
    const model = createNodeSkillReviewModelPort({ route: route(baseUrl) });
    expect(model.capability).toBe('completion-only');
    expect(await model.complete(request())).toEqual({
      text: '{"version":1,"kind":"noop","reason":"no new lesson"}',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, estimated: false },
    });
    expect(payloads).toEqual([{ path: '/v1/chat/completions', body: { model: 'review-model', stream: false,
      max_tokens: 100, messages: [{ role: 'system', content: 'review instructions' }, { role: 'user', content: 'evidence snapshot' }] } }]);
  });

  it('validates injected HTTP route endpoints before any network or agent dispatch', async () => {
    const { createNodeSkillReviewModelPort } = await implementation(); const dispatch = vi.spyOn(globalThis, 'fetch');
    try {
      for (const baseUrl of ['file:///fixture/api', 'https://fixture.invalid/v1?api_key=fixture', 'https://user:password@fixture.invalid/v1',
        'http://fixture.invalid/v1', 'http://127.0.0.1:1/v1#fragment']) {
        expect(() => createNodeSkillReviewModelPort({ route: route(baseUrl) })).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
      }
      expect(dispatch).not.toHaveBeenCalled();
    } finally { dispatch.mockRestore(); }
  });

  it('rejects malformed caller-injected model identifiers before any request', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    for (const model of ['bad\nmodel', ' model ', { permissions: 'full' }]) {
      expect(() => createNodeSkillReviewModelPort({ route: { ...route('http://127.0.0.1:1'), model } as ResolvedRoute })).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    }
  });

  it('supports Anthropic text completions without declaring tools and preserves both usage directions', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const payloads: unknown[] = [];
    const baseUrl = await server((body, path) => {
      payloads.push({ body, path });
      return { content: [{ type: 'text', text: 'anthropic-only text' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 } };
    });
    expect(await createNodeSkillReviewModelPort({ route: route(baseUrl, 'anthropic') }).complete(request())).toEqual({
      text: 'anthropic-only text', usage: { inputTokens: 9, outputTokens: 4, totalTokens: undefined, estimated: false },
    });
    expect(payloads).toEqual([{ path: '/v1/messages', body: { model: 'review-model', stream: false, max_tokens: 100,
      system: 'review instructions', messages: [{ role: 'user', content: 'evidence snapshot' }] } }]);
  });

  it('rejects provider attempts to invoke tools despite tool-free requests', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const baseUrl = await server(() => ({ choices: [{ message: {
      content: '{"version":1,"kind":"noop","reason":"done"}',
      tool_calls: [{ id: 'unauthorized', type: 'function', function: { name: 'shell', arguments: '{}' } }],
    } }] }));
    const model = createNodeSkillReviewModelPort({ route: route(baseUrl) });
    await expect(model.complete(request())).rejects.toThrow(/SKILL_REVIEW_TOOL_CALL_REJECTED/);
  });

  it('rejects malformed provider tool declarations rather than accepting adjacent prose', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const baseUrl = await server(() => ({ choices: [{ message: { content: 'benign looking prose', tool_calls: { function: { name: 'shell' } } } }] }));
    await expect(createNodeSkillReviewModelPort({ route: route(baseUrl) }).complete(request())).rejects.toThrow(/SKILL_REVIEW_(?:TOOL_CALL_REJECTED|INVALID_RESPONSE)/);
  });

  it('rejects a tool finish reason even when the provider supplies benign prose instead of an actual tool array', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const baseUrl = await server(() => ({ choices: [{ finish_reason: 'tool_calls', message: { content: 'benign looking prose' } }] }));
    const model = createNodeSkillReviewModelPort({ route: route(baseUrl) });
    await expect(model.complete(request())).rejects.toThrow(/SKILL_REVIEW_TOOL_CALL_REJECTED/);
  });

  it('refuses CLI routes and invalid request budgets before any HTTP dispatch', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    expect(() => createNodeSkillReviewModelPort({ route: null })).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    expect(() => createNodeSkillReviewModelPort({ route: { ...route('http://127.0.0.1:1'), mode: 'cli' } })).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    const dispatch = vi.spyOn(globalThis, 'fetch');
    try {
      const model = createNodeSkillReviewModelPort({ route: route('http://127.0.0.1:1') });
      for (const timeoutMs of [0, -1, Infinity, NaN, 600001]) await expect(model.complete({ ...request(), timeoutMs })).rejects.toThrow(/SKILL_REVIEW_INVALID_BUDGET/);
      for (const maxOutputTokens of [0, -1, 0.5, Infinity, 100001]) await expect(model.complete({ ...request(), maxOutputTokens })).rejects.toThrow(/SKILL_REVIEW_INVALID_BUDGET/);
      const controller = new AbortController(); controller.abort();
      await expect(model.complete({ ...request(), signal: controller.signal })).rejects.toThrow(/SKILL_REVIEW_CANCELLED/);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { dispatch.mockRestore(); }
  });

  it('rejects responses larger than the bounded capsule before accepting any text', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const baseUrl = await server(() => ({ choices: [{ message: { content: 'x'.repeat(5000) } }] }));
    const model = createNodeSkillReviewModelPort({ route: route(baseUrl), maxResponseBytes: 1000 });
    await expect(model.complete(request())).rejects.toThrow(/SKILL_REVIEW_RESPONSE_TOO_LARGE/);
  });

  it('closes an HTTP error response even when its body never reaches EOF', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    let closed = false;
    const instance = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.on('close', () => { closed = true; });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.write('service unavailable');
      });
    });
    servers.push(instance);
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
    const address = instance.address();
    if (!address || typeof address === 'string') throw new Error('server failed');
    const model = createNodeSkillReviewModelPort({ route: route(`http://127.0.0.1:${address.port}`) });
    await expect(model.complete(request())).rejects.toThrow(/SKILL_REVIEW_HTTP_ERROR: HTTP 503/);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(closed, 'The failed completion must not leave a live response body after clearing its deadline').toBe(true);
  });

  it('deducts synchronous payload preparation from one absolute completion deadline', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const payloads: unknown[] = [];
    const baseUrl = await server((body) => { payloads.push(body); return { choices: [{ message: { content: 'late completion' } }] }; });
    const model = createNodeSkillReviewModelPort({ route: route(baseUrl) });
    const serialize = JSON.stringify;
    const dispatch = vi.spyOn(globalThis, 'fetch');
    let delayed = false;
    const preparation = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (!delayed && value && typeof value === 'object' && (value as Record<string, unknown>).model === 'review-model') {
        delayed = true;
        const end = performance.now() + 60;
        while (performance.now() < end) { /* Model a slow bounded payload conversion. */ }
      }
      return Reflect.apply(serialize, JSON, [value, ...args]);
    }) as typeof JSON.stringify);
    try {
      await expect(model.complete({ ...request(), timeoutMs: 15 })).rejects.toThrow(/SKILL_REVIEW_TIMEOUT/);
      expect(dispatch, 'An expired reviewer must be rejected before fetch is called').not.toHaveBeenCalled();
      expect(payloads, 'No billable request may dispatch after preparation consumes the deadline').toEqual([]);
    } finally { preparation.mockRestore(); dispatch.mockRestore(); }
  });

  it('rejects text that finishes parsing after the same absolute deadline', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const baseUrl = await server(() => ({ choices: [{ message: { content: 'post-deadline text' } }] }));
    const model = createNodeSkillReviewModelPort({ route: route(baseUrl) });
    const parse = JSON.parse;
    const parsing = vi.spyOn(JSON, 'parse').mockImplementation(((text: string, ...args: unknown[]) => {
      if (text.includes('post-deadline text')) {
        const end = performance.now() + 140;
        while (performance.now() < end) { /* Exercise synchronous result processing, not a fake network timeout. */ }
      }
      return Reflect.apply(parse, JSON, [text, ...args]);
    }) as typeof JSON.parse);
    try { await expect(model.complete({ ...request(), timeoutMs: 100 })).rejects.toThrow(/SKILL_REVIEW_TIMEOUT/); }
    finally { parsing.mockRestore(); }
  });

  it('aborts a live hanging response body when the caller cancels', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    let began!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { began = resolve; });
    let closed = false;
    const instance = createServer((req, res) => {
      req.resume(); req.on('end', () => {
        res.on('close', () => { closed = true; });
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":['); began();
      });
    });
    servers.push(instance);
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
    const address = instance.address(); if (!address || typeof address === 'string') throw new Error('server failed');
    const model = createNodeSkillReviewModelPort({ route: route(`http://127.0.0.1:${address.port}`) });
    const controller = new AbortController();
    const rejection = expect(model.complete({ ...request(), signal: controller.signal })).rejects.toThrow(/SKILL_REVIEW_CANCELLED/);
    await bodyStarted; controller.abort(); await rejection;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true);
  });

  it('caps an oversized chunked response before EOF and closes its socket', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    let closed = false;
    const instance = createServer((req, res) => {
      req.resume(); req.on('end', () => {
        res.on('close', () => { closed = true; });
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('x'.repeat(8192));
      });
    });
    servers.push(instance);
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
    const address = instance.address(); if (!address || typeof address === 'string') throw new Error('server failed');
    const model = createNodeSkillReviewModelPort({ route: route(`http://127.0.0.1:${address.port}`), maxResponseBytes: 1024 });
    await expect(model.complete(request())).rejects.toThrow(/SKILL_REVIEW_RESPONSE_TOO_LARGE/);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true);
  });

  it('rejects an actual connection reset without a coding-agent recovery path', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const instance = createServer((req) => { req.resume(); req.on('end', () => req.socket.destroy()); });
    servers.push(instance);
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
    const address = instance.address(); if (!address || typeof address === 'string') throw new Error('server failed');
    const model = createNodeSkillReviewModelPort({ route: route(`http://127.0.0.1:${address.port}`) });
    await expect(model.complete(request())).rejects.toThrow(/fetch failed|socket|terminated/i);
  });

  it('physically aborts a stalled HTTP request at the per-call deadline', async () => {
    const { createNodeSkillReviewModelPort } = await implementation();
    const instance = createServer((req, res) => {
      req.resume();
      req.on('end', () => setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'too late' } }] }));
      }, 80));
    });
    servers.push(instance);
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
    const address = instance.address();
    if (!address || typeof address === 'string') throw new Error('server failed');
    const model = createNodeSkillReviewModelPort({ route: route(`http://127.0.0.1:${address.port}`) });
    await expect(model.complete({ ...request(), timeoutMs: 10 })).rejects.toThrow(/SKILL_REVIEW_TIMEOUT/);
  });
});
