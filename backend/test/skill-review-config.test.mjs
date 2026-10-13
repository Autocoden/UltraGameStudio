import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceSkillService } from '../src/workspace-skill-service.mjs';

// Local filesystem fixtures only: no real project, provider, or remote server.
const fixtureRoot = process.env.UGS_SKILL_REVIEW_CONFIG_FIXTURE_ROOT ?? join(tmpdir(), 'ugs-review-config-fixtures');
async function fixture(t) {
  await mkdir(fixtureRoot, { recursive: true });
  const dir = await mkdtemp(join(fixtureRoot, 'review-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const create = () => createWorkspaceSkillService({
    dir, hostId: 'review-config-fixture', workspaceId: 'review-config-project',
  });
  const statePath = join(dir, '.ultragamestudio', 'skills', '.state', 'state.json');
  const diskState = async () => JSON.parse(await readFile(statePath, 'utf8'));
  return { service: create(), create, statePath, diskState };
}

const reviewSelection = {
  adapter: 'claude', modelClass: 'primary', providerId: 'fixture-provider',
  channelId: 'fixture-http-channel', model: 'fixture-review-model',
};

for (const reviewTransport of ['anthropic', 'openai-compatible']) {
  test(`persists an independent ${reviewTransport} HTTP review protocol across service restart`, async (t) => {
    const { service, create, diskState } = await fixture(t);
    const config = await service.setConfig({ reviewTransport });
    assert.equal(config.reviewTransport, reviewTransport);
    assert.deepEqual((await diskState()).config, config, 'read the actual durable state, not only the reply');
    assert.deepEqual(await create().getConfig(), config, 'a fresh service must reload the HTTP override');
  });
}

test('null removes only the review protocol override from durable config', async (t) => {
  const { service, create, diskState } = await fixture(t);
  const configured = await service.setConfig({ reviewSelection, reviewTransport: 'openai-compatible' });
  const { reviewTransport: removed, ...expected } = configured;
  assert.equal(removed, 'openai-compatible');
  const cleared = await service.setConfig({ reviewTransport: null });
  assert.deepEqual(cleared, expected);
  assert.equal(Object.hasOwn(cleared, 'reviewTransport'), false);
  assert.deepEqual((await diskState()).config, expected, 'persist omission rather than null');
  assert.deepEqual(await create().getConfig(), expected);
});

// Characterization guards for existing merge, defaults, and fail-closed rules.
// They are not additional RED stages and require no production changes.
test('omitting the HTTP override keeps the original learning defaults', async (t) => {
  const { service, create, statePath, diskState } = await fixture(t);
  const defaults = {
    enabled: true, mode: 'auto-safe', activityThreshold: 10, cooldownMs: 60000,
    maxRounds: 6, maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 90000,
    autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90,
  };
  assert.deepEqual(await service.getConfig(), defaults);
  await assert.rejects(readFile(statePath), { code: 'ENOENT' }, 'reading defaults must not save an override');
  const expected = { ...defaults, enabled: false, mode: 'off' };
  assert.deepEqual(await service.setConfig({ enabled: false, mode: 'off' }), expected);
  assert.deepEqual((await diskState()).config, expected);
  assert.deepEqual(await create().getConfig(), expected);
});

test('partial updates preserve the persisted review protocol and selection', async (t) => {
  const { service, create, diskState } = await fixture(t);
  const configured = await service.setConfig({ reviewSelection, reviewTransport: 'anthropic', activityThreshold: 17 });
  const expected = { ...configured, cooldownMs: 1200 };
  assert.deepEqual(await create().setConfig({ cooldownMs: 1200 }), expected);
  assert.deepEqual((await diskState()).config, expected);
  assert.deepEqual(await create().getConfig(), expected);
  const switched = { ...expected, reviewTransport: 'openai-compatible' };
  assert.deepEqual(await create().setConfig({ reviewTransport: 'openai-compatible' }), switched);
  assert.deepEqual((await diskState()).config, switched);
  assert.deepEqual(await create().getConfig(), switched);
});

test('clearing reviewSelection does not clear the independent HTTP override', async (t) => {
  const { service, create, diskState } = await fixture(t);
  const configured = await service.setConfig({ reviewSelection, reviewTransport: 'anthropic' });
  const { reviewSelection: removed, ...expected } = configured;
  assert.deepEqual(removed, reviewSelection);
  assert.deepEqual(await service.setConfig({ reviewSelection: null }), expected);
  assert.deepEqual((await diskState()).config, expected);
  assert.deepEqual(await create().getConfig(), expected);
});

test('clearing an absent review protocol stays absent on disk', async (t) => {
  const { service, create, diskState } = await fixture(t);
  const defaults = await service.getConfig();
  assert.deepEqual(await service.setConfig({ reviewTransport: null }), defaults);
  assert.deepEqual((await diskState()).config, defaults);
  assert.deepEqual(await create().setConfig({ reviewTransport: null }), defaults);
  assert.deepEqual((await diskState()).config, defaults);
  assert.deepEqual(await create().getConfig(), defaults);
});

test('non-HTTP or malformed protocol values cannot change persisted config', async (t) => {
  const { service, create, statePath } = await fixture(t);
  const configured = await service.setConfig({ reviewSelection, reviewTransport: 'anthropic' });
  const bytesBefore = await readFile(statePath);
  const rejected = [
    'cli', 'claude-cli', 'codex-cli', 'simulator', 'unknown', 'system-default',
    'openai', 'Anthropic', ' anthropic', 'anthropic ', '', 'anthropic\0',
    false, 1, undefined, ['anthropic'], { transport: 'anthropic' },
  ];
  for (const reviewTransport of rejected) {
    await assert.rejects(
      service.setConfig({ reviewTransport }),
      /invalid remote skill config reviewTransport/,
    );
    assert.deepEqual(await readFile(statePath), bytesBefore, 'a rejected value must not rewrite durable state');
  }
  assert.deepEqual(await create().getConfig(), configured);
});

test('unknown or credential fields remain rejected in review config', async (t) => {
  const { service, create, statePath } = await fixture(t);
  const configured = await service.setConfig({ reviewSelection, reviewTransport: 'anthropic' });
  const bytesBefore = await readFile(statePath);
  for (const key of ['unknownField', 'transport', 'apiKey', 'secret', 'token', 'password', 'baseUrl', 'tools']) {
    await assert.rejects(
      service.setConfig({ reviewTransport: 'openai-compatible', [key]: 'fixture-only-not-a-credential' }),
      /unknown remote skill config field/,
    );
    assert.deepEqual(await readFile(statePath), bytesBefore);
  }
  for (const key of ['reviewTransport', 'apiKey', 'secret', 'token', 'password']) {
    await assert.rejects(
      service.setConfig({ reviewTransport: 'openai-compatible', reviewSelection: { ...reviewSelection, [key]: 'fixture-only-not-a-credential' } }),
      /unknown review selection field/,
    );
    assert.deepEqual(await readFile(statePath), bytesBefore, 'the entire partial update must be rejected');
  }
  assert.deepEqual(await create().getConfig(), configured);
});
