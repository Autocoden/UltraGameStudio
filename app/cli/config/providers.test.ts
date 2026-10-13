// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewaySelection } from '../../src/core/ir';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(),
  homedir: () => { if (!isolated.home) throw new Error('Review fixture home is not initialized'); return isolated.home; },
}));

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ugs-review-provider-fixture-'));
  cwd = join(root, 'project'); isolated.home = join(root, 'home');
  await mkdir(cwd, { recursive: true }); await mkdir(isolated.home, { recursive: true });
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY']) vi.stubEnv(name, undefined);
  (await import('./providers')).resetFucConfigCache();
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function config(value: unknown, directory = cwd) {
  await mkdir(join(directory, '.ugs'), { recursive: true });
  const file = join(directory, '.ugs', 'config.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}
const selection: GatewaySelection = { adapter: 'codex', providerId: 'fixture-review', modelClass: 'review' };

async function resolver() {
  const source = await import('./providers');
  const resolve = (source as unknown as { resolveNodeSkillReviewRoute?:
    (selection: GatewaySelection, cwd?: string, transport?: string) => import('./providers').ResolvedRoute }).resolveNodeSkillReviewRoute;
  expect(resolve, 'Dedicated reviewer resolution must not use the ordinary gateway fallback').toBeTypeOf('function');
  return resolve!;
}

describe('dedicated Node skill review route resolution', () => {
  it('resolves an explicit HTTP protocol against an existing provider without changing its ordinary CLI route', async () => {
    const file = await config({ providers: { 'fixture-review': { transport: 'cli', baseUrl: 'http://127.0.0.1:12345/v1', models: { review: 'fixture/review-only' } } } });
    const before = await readFile(file);
    const resolve = await resolver();
    const providers = await import('./providers');
    const primaryBefore = providers.resolveCliRoute(selection, cwd);
    expect(resolve(selection, cwd, 'openai-compatible')).toMatchObject({
      selection, adapter: 'codex', transport: 'openai-compatible', mode: 'direct',
      model: 'fixture/review-only', baseUrl: 'http://127.0.0.1:12345/v1',
    });
    expect(providers.resolveCliRoute(selection, cwd)).toEqual(primaryBefore);
    expect(primaryBefore.transport).toBe('cli');
    expect(await readFile(file)).toEqual(before);
  });

  it('requires an exact own provider and rejects unsupported channels or system-default routes without ordinary fallback', async () => {
    const file = await config({ providers: { codex: { transport: 'openai-compatible', baseUrl: 'http://127.0.0.1:12345/v1', model: 'ordinary/default' },
      'fixture-review': { transport: 'cli', baseUrl: 'http://127.0.0.1:12345/v1', model: 'review/model' } } });
    const source = await import('./providers'); const resolve = await resolver(); const before = await readFile(file);
    const ordinary = vi.spyOn(source, 'resolveDirectRoute').mockImplementation(() => { throw new Error('FORBIDDEN_GENERAL_REVIEW_ROUTE'); });
    const cli = vi.spyOn(source, 'resolveCliRoute').mockImplementation(() => { throw new Error('FORBIDDEN_CLI_REVIEW_ROUTE'); });
    for (const selected of [{ ...selection, providerId: undefined }, { ...selection, providerId: 'missing-provider' },
      { ...selection, providerId: ' fixture-review ' }, { ...selection, providerId: 'toString' },
      { ...selection, channelId: 'guessed-default' }, { ...selection, systemDefault: true }]) {
      expect(() => resolve(selected, cwd, 'openai-compatible')).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    }
    expect(() => resolve(selection, cwd)).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    expect(() => resolve(selection, cwd, 'cli')).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    expect(ordinary).not.toHaveBeenCalled(); expect(cli).not.toHaveBeenCalled(); expect(await readFile(file)).toEqual(before);
  });

  it('ignores inherited model-map entries and retains the exact configured concrete selection', async () => {
    await config({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl: 'http://127.0.0.1:12345/v1', model: 'fallback/model' } } });
    const source = await import('./providers'); const resolve = await resolver();
    source.loadFucConfig(cwd).providers!['fixture-review'].models = Object.create({ 'review/exact-model': 'inherited/incorrect-model' }) as Record<string, string>;
    expect(resolve({ ...selection, modelClass: 'review/exact-model' }, cwd).model).toBe('review/exact-model');
  });

  it('rejects a remote keyless endpoint before dispatch rather than silently using anonymous HTTP', async () => {
    await config({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl: 'https://fixture-review.invalid/v1', model: 'fixture-review-model' } } });
    const resolve = await resolver();
    const dispatch = vi.spyOn(globalThis, 'fetch');
    expect(() => resolve(selection, cwd)).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a present invalid tier-map model instead of silently falling back to a different concrete model', async () => {
    const source = await import('./providers'); const resolve = await resolver();
    for (const mapped of [null, '', { permissions: 'full' }]) {
      await config({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl: 'http://127.0.0.1:12345/v1',
        model: 'fallback/model', models: { review: mapped } } } }); source.resetFucConfigCache();
      expect(() => resolve(selection, cwd)).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    }
  });

  it('honors the exact selected reviewer model instead of replacing it with the provider default', async () => {
    const file = await config({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl: 'http://127.0.0.1:12345/v1', model: 'foreground/default-model' } } });
    const resolve = await resolver();
    expect(resolve({ ...selection, modelClass: 'reviewer/exact-model' }, cwd).model).toBe('reviewer/exact-model');
    expect(JSON.parse(await readFile(file, 'utf8')).providers['fixture-review'].model).toBe('foreground/default-model');
  });

  it('rejects malformed concrete model identifiers before route construction', async () => {
    await config({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl: 'http://127.0.0.1:12345/v1', model: 'fallback-model' } } });
    const resolve = await resolver();
    for (const modelOverride of ['', ' model', 'model ', 'bad\nmodel', 'bad\0model', 'model?key=value', 'model#fragment', 'm'.repeat(257),
      { permissions: 'full' }]) {
      expect(() => resolve({ ...selection, modelOverride } as GatewaySelection, cwd)).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    }
  });

  it('does not treat a simulator provider as HTTP merely because a reviewer protocol override exists', async () => {
    await config({ providers: { 'fixture-review': { transport: 'simulator', baseUrl: 'http://127.0.0.1:12345/v1', model: 'review-model' } } });
    const resolve = await resolver();
    expect(() => resolve(selection, cwd, 'openai-compatible')).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
  });

  it('loads independent skill policy from isolated home and project config with omission inheritance and null clearing', async () => {
    const homeFile = await config({ skillLearning: { reviewTransport: 'anthropic', reviewSelection: { adapter: 'codex', providerId: 'fixture-review',
      modelClass: 'home-review', model: 'fixture/pinned-review' }, activityThreshold: 17, timeoutMs: 30000 } }, isolated.home);
    const projectFile = await config({ skillLearning: { cooldownMs: 1000 } });
    const source = await import('./providers');
    const load = (source as unknown as { loadNodeSkillLearningConfig?:
      (cwd: string, value?: unknown) => import('../../src/runtime/skills/types').SkillLearningConfig }).loadNodeSkillLearningConfig;
    expect(load, 'CLI/studio must load independently persisted reviewer configuration').toBeTypeOf('function');
    const before = await readFile(homeFile);
    expect(load!(cwd)).toMatchObject({ reviewTransport: 'anthropic', reviewSelection: { model: 'fixture/pinned-review' }, activityThreshold: 17, cooldownMs: 1000, timeoutMs: 30000 });
    await config({ skillLearning: { reviewTransport: null, cooldownMs: 2000 } }); source.resetFucConfigCache();
    expect(load!(cwd)).toMatchObject({ reviewSelection: { model: 'fixture/pinned-review' }, activityThreshold: 17, cooldownMs: 2000 });
    expect(load!(cwd)).not.toHaveProperty('reviewTransport');
    expect(load!(cwd, { reviewSelection: null })).not.toHaveProperty('reviewSelection');
    expect(await readFile(homeFile)).toEqual(before);
    expect(JSON.parse(await readFile(projectFile, 'utf8')).skillLearning).toEqual({ reviewTransport: null, cooldownMs: 2000 });
  });

  it('rejects an invalid persisted reviewer override instead of normalizing it into an implicit HTTP fallback', async () => {
    const source = await import('./providers');
    const load = (source as unknown as { loadNodeSkillLearningConfig: (cwd: string) => unknown }).loadNodeSkillLearningConfig;
    for (const skillLearning of [{ reviewTransport: 'cli' }, { reviewTransport: 'simulator' },
      { reviewSelection: { adapter: 'codex', providerId: 'fixture-review', modelClass: 'review', systemDefault: true } },
      { reviewSelection: { adapter: 'codex', providerId: 'fixture-review', modelClass: 'review', apiKey: 'fixture-only' } }]) {
      const file = await config({ skillLearning }); source.resetFucConfigCache(); const before = await readFile(file);
      expect(() => load(cwd)).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
      expect(await readFile(file)).toEqual(before);
    }
  });

  it('rejects unsafe HTTP endpoint syntax without normalizing it into a different destination', async () => {
    const resolve = await resolver();
    vi.stubEnv('OPENAI_API_KEY', 'fixture-review-credential');
    for (const baseUrl of ['file:///fixture/api', 'ftp://fixture.invalid', 'https://user:password@fixture.invalid/v1',
      'https://fixture.invalid/v1?token=fixture', 'https://fixture.invalid/v1#fragment', ' https://fixture.invalid/v1',
      'https://fixture.invalid\\/v1', 'http://fixture.invalid/v1', 'https://fixture.invalid/api/../v1', 'https://fixture.invalid/%2e%2e/v1']) {
      await config({ providers: { 'fixture-review': { transport: 'openai-compatible', baseUrl, model: 'fixture-review-model' } } });
      (await import('./providers')).resetFucConfigCache();
      expect(() => resolve(selection, cwd), `Reject unsafe endpoint ${baseUrl}`).toThrow(/SKILL_REVIEW_UNAVAILABLE/);
    }
  });
});
