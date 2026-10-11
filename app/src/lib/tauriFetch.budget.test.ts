import { Blob as NodeBlob } from 'node:buffer';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriFetch } from './tauri';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
const originals = new Map(['isTauri', '__TAURI_INTERNALS__', '__TAURI__'].map((key) =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)],
));
const closers: Array<() => Promise<void>> = [];
async function httpFixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  // Windows may allocate port 6000, which WHATWG fetch explicitly blocks.
  if ([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes(address.port)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return httpFixture(handler);
  }
  closers.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${address.port}`;
}
function desktop(enabled: boolean): void {
  for (const key of originals.keys()) delete (globalThis as Record<string, unknown>)[key];
  if (enabled) Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
}
function payload(body = 'ok', status = 200) {
  return { status, statusText: status === 200 ? 'OK' : 'Error', headers: [], bodyBase64: btoa(body), url: 'http://127.0.0.1/model' };
}
beforeEach(() => {
  desktop(false);
  ipc.invoke.mockReset();
  // Node's fetch Response consumes Node Blob, not jsdom's Blob implementation.
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

describe('tauriFetch hard HTTP budgets', () => {
  it('passes the remaining timeout and response byte limit to the Rust CORS proxy', async () => {
    desktop(true);
    ipc.invoke.mockResolvedValue(payload());
    await tauriFetch('http://127.0.0.1/model', {
      method: 'POST', body: 'test', signal: new AbortController().signal,
    }, { timeoutMs: 137, maxResponseBytes: 512 });
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('proxy_http', {
      request: {
        method: 'POST', url: 'http://127.0.0.1/model', headers: [], bodyBase64: btoa('test'),
        timeoutMs: expect.any(Number), maxResponseBytes: 512,
      },
    });
    const timeout = ipc.invoke.mock.calls[0][1].request.timeoutMs;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(137);
  });

  it('aborts a real browser HTTP body read at the total deadline', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('waiting'); // Headers arrive; the response body never ends.
    });
    const startedAt = performance.now();
    await expect(tauriFetch(baseUrl, undefined, { timeoutMs: 60, maxResponseBytes: 512 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(performance.now() - startedAt).toBeLessThan(600);
  });

  it('rejects an oversized real HTTP stream without waiting for EOF', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('x'.repeat(513)); // Keep the socket open after limit+1 bytes.
    });
    const startedAt = performance.now();
    await expect(tauriFetch(baseUrl, undefined, { timeoutMs: 200, maxResponseBytes: 512 }))
      .rejects.toThrow('HTTP_RESPONSE_TOO_LARGE');
    expect(performance.now() - startedAt).toBeLessThan(180);
  });

  it('removes the desktop abort listener once the proxy response settles', async () => {
    desktop(true);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    ipc.invoke.mockResolvedValue(payload());
    await tauriFetch('http://127.0.0.1/model', { signal: controller.signal }, { timeoutMs: 300, maxResponseBytes: 512 });
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });

  it('rejects a stalled desktop IPC response by the hard deadline', async () => {
    desktop(true);
    ipc.invoke.mockImplementation(() => new Promise(() => {}));
    await expect(tauriFetch('http://127.0.0.1/model', undefined, { timeoutMs: 40, maxResponseBytes: 512 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  }, 700);

  it('does not dispatch IPC when cancellation arrives during async body preparation', async () => {
    desktop(true);
    const controller = new AbortController();
    let finish!: (buffer: ArrayBuffer) => void;
    const body = new Blob(['request']);
    Object.defineProperty(body, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) });
    ipc.invoke.mockResolvedValue(payload());
    const pending = tauriFetch('http://127.0.0.1/model', { body, method: 'POST', signal: controller.signal },
      { timeoutMs: 300, maxResponseBytes: 512 });
    await Promise.resolve();
    controller.abort();
    finish(new TextEncoder().encode('request').buffer);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('exhausts the budget during body preparation without dispatching late IPC', async () => {
    desktop(true);
    let finish!: (buffer: ArrayBuffer) => void;
    const body = new Blob(['request']);
    Object.defineProperty(body, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) });
    ipc.invoke.mockResolvedValue(payload());
    const pending = tauriFetch('http://127.0.0.1/model', { body, method: 'POST' }, { timeoutMs: 35, maxResponseBytes: 512 });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await new Promise((resolve) => setTimeout(resolve, 70));
    finish(new TextEncoder().encode('request').buffer);
    await assertion;
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('cancels promptly even when desktop body preparation never settles', async () => {
    desktop(true);
    const controller = new AbortController();
    const body = new Blob(['request']);
    Object.defineProperty(body, 'arrayBuffer', { value: () => new Promise(() => {}) });
    const pending = tauriFetch('http://127.0.0.1/model', { body, method: 'POST', signal: controller.signal },
      { timeoutMs: 500, maxResponseBytes: 512 });
    await Promise.resolve();
    controller.abort();
    const observed = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve({ name: 'STALLED_AFTER_ABORT' }), 120)),
    ]);
    expect(observed).toMatchObject({ name: 'AbortError' });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('rejects an invalid hard budget without sending a request', async () => {
    desktop(true);
    ipc.invoke.mockResolvedValue(payload());
    await expect(tauriFetch('http://127.0.0.1/model', undefined, { timeoutMs: NaN, maxResponseBytes: 512 }))
      .rejects.toThrow('HTTP_INVALID_BUDGET');
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('never accepts a payload delivered by IPC after cancellation', async () => {
    desktop(true);
    const controller = new AbortController();
    let deliver!: (result: ReturnType<typeof payload>) => void;
    ipc.invoke.mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
    const pending = tauriFetch('http://127.0.0.1/model', { signal: controller.signal }, { timeoutMs: 200, maxResponseBytes: 512 });
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
    controller.abort();
    deliver(payload());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a response when cancellation occurs synchronously inside IPC dispatch', async () => {
    desktop(true);
    const controller = new AbortController();
    ipc.invoke.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(payload());
    });
    await expect(tauriFetch('http://127.0.0.1/model', { signal: controller.signal }, { timeoutMs: 200, maxResponseBytes: 512 }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects cancellation during desktop response decoding before exposing a late result', async () => {
    desktop(true);
    const controller = new AbortController();
    ipc.invoke.mockResolvedValue(payload());
    const decode = globalThis.atob;
    vi.spyOn(globalThis, 'atob').mockImplementation((value) => {
      controller.abort();
      return decode(value);
    });
    await expect(tauriFetch('http://127.0.0.1/model', { signal: controller.signal }, { timeoutMs: 200, maxResponseBytes: 512 }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('enforces the response byte cap on a desktop payload before allocating a decoded body', async () => {
    desktop(true);
    ipc.invoke.mockResolvedValue(payload('x'.repeat(513)));
    const decode = vi.spyOn(globalThis, 'atob');
    await expect(tauriFetch('http://127.0.0.1/model', undefined, { timeoutMs: 200, maxResponseBytes: 512 }))
      .rejects.toThrow('HTTP_RESPONSE_TOO_LARGE');
    expect(decode).not.toHaveBeenCalled();
  });

  it('caps UTF-8 bytes rather than string characters on browser and desktop paths', async () => {
    const text = '你'.repeat(171); // 513 UTF-8 bytes, only 171 characters.
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    });
    await expect(tauriFetch(baseUrl, undefined, { timeoutMs: 500, maxResponseBytes: 512 }))
      .rejects.toThrow('HTTP_RESPONSE_TOO_LARGE');
    desktop(true);
    const bytes = new TextEncoder().encode(text);
    ipc.invoke.mockResolvedValue({ ...payload(), bodyBase64: btoa(String.fromCharCode(...bytes)) });
    await expect(tauriFetch(baseUrl, undefined, { timeoutMs: 500, maxResponseBytes: 512 }))
      .rejects.toThrow('HTTP_RESPONSE_TOO_LARGE');
  });

  it('accepts an exact-limit body while retaining non-2xx fetch response semantics', async () => {
    const baseUrl = await httpFixture((_req, res) => {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('x'.repeat(512));
    });
    const response = await tauriFetch(baseUrl, undefined, { timeoutMs: 500, maxResponseBytes: 512 });
    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);
    expect((await response.text()).length).toBe(512);
    desktop(true);
    for (const body of ['x'.repeat(510), 'x'.repeat(511), 'x'.repeat(512)]) {
      ipc.invoke.mockResolvedValue(payload(body, 429));
      const desktopResponse = await tauriFetch(baseUrl, undefined, { timeoutMs: 500, maxResponseBytes: 512 });
      expect(desktopResponse.status).toBe(429);
      expect(await desktopResponse.text()).toBe(body);
    }
  });

  it('cleans browser abort listeners after a real successful response', async () => {
    const baseUrl = await httpFixture((_req, res) => res.end('ok'));
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await tauriFetch(baseUrl, { signal: controller.signal }, { timeoutMs: 500, maxResponseBytes: 512 });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });

  it('keeps desktop native-fallback responses inside the same byte cap', async () => {
    desktop(true);
    await expect(tauriFetch(`data:text/plain,${'x'.repeat(513)}`, undefined,
      { timeoutMs: 500, maxResponseBytes: 512 })).rejects.toThrow('HTTP_RESPONSE_TOO_LARGE');
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('does not reset a browser hard budget after synchronous request preparation', async () => {
    const controller = new AbortController();
    const native = vi.fn(async () => new Response('late'));
    vi.stubGlobal('fetch', native);
    const init: RequestInit = { get signal() {
      const until = performance.now() + 40;
      while (performance.now() < until) { /* preparation belongs to the one call budget */ }
      return controller.signal;
    } };
    await expect(tauriFetch('http://127.0.0.1/model', init,
      { timeoutMs: 20, maxResponseBytes: 512 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(native).not.toHaveBeenCalled();
  });

  it('does not round a sub-millisecond desktop budget up into a new request', async () => {
    desktop(true);
    vi.spyOn(performance, 'now').mockReturnValue(100);
    ipc.invoke.mockResolvedValue(payload());
    await expect(tauriFetch('http://127.0.0.1/model', undefined,
      { timeoutMs: 0.5, maxResponseBytes: 512 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('leaves ordinary native fetch calls unbuffered without options', async () => {
    const response = new Response('unchanged');
    const native = vi.fn(async () => response);
    vi.stubGlobal('fetch', native);
    const init = { method: 'GET' };
    const result = await tauriFetch('http://127.0.0.1/model', init);
    expect(result).toBe(response);
    expect(native).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1/model', init);
    expect(response.bodyUsed).toBe(false);
  });
});
