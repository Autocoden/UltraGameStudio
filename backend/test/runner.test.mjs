import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonStore } from '../src/store.mjs';
import { JobRunner } from '../src/runner.mjs';

async function makeRunner(opts = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ugs-runner-data-'));
  const workdir = await mkdtemp(join(tmpdir(), 'ugs-runner-work-'));
  const store = await new JsonStore(dataDir).load();
  const runner = new JobRunner({
    store,
    workdir,
    maxConcurrency: opts.maxConcurrency ?? 1,
    jobTimeoutMs: 60_000,
    execAllowlist: opts.execAllowlist ?? [],
  });
  return { runner, store, dataDir, workdir };
}

async function cleanup(ctx) {
  await ctx.store._writeChain;
  await Promise.all([
    rm(ctx.dataDir, { recursive: true, force: true }),
    rm(ctx.workdir, { recursive: true, force: true }),
  ]);
}

function waitForStatus(runner, id, statuses) {
  const allowed = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  const current = runner.store.getJob(id)?.status;
  if (allowed.has(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const onStatus = (status) => {
      if (!allowed.has(status)) return;
      runner.off(`status:${id}`, onStatus);
      resolve(status);
    };
    runner.on(`status:${id}`, onStatus);
  });
}

test('exec allowlist blocks unapproved adapter command', async () => {
  const ctx = await makeRunner({ execAllowlist: ['not-claude'] });
  try {
    const job = ctx.runner.enqueue({ prompt: 'hi', adapter: 'claude' });
    const status = await waitForStatus(ctx.runner, job.id, 'error');
    const stored = ctx.store.getJob(job.id);
    assert.equal(status, 'error');
    assert.equal(stored.error, 'command not allowed: claude');
    assert.equal(JSON.stringify(stored).includes('_apiKey'), false);
  } finally {
    await cleanup(ctx);
  }
});

test('cancel marks a queued job as canceled', async () => {
  const ctx = await makeRunner();
  try {
    const job = ctx.runner.enqueue({ prompt: 'hi', adapter: 'claude' });
    assert.equal(ctx.runner.cancel(job.id), true);
    const stored = ctx.store.getJob(job.id);
    assert.equal(stored.status, 'canceled');
    assert.equal(stored.error, 'canceled');
  } finally {
    await cleanup(ctx);
  }
});

test('completed jobs write runtime and token ledger entries', async () => {
  const ctx = await makeRunner();
  try {
    ctx.runner._spawn = async () => ({
      code: 0,
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cachedInputTokens: 0,
        totalTokens: 7,
        calls: 1,
      },
    });
    const job = ctx.runner.enqueue({ prompt: 'hi', adapter: 'claude' });
    await waitForStatus(ctx.runner, job.id, 'done');
    const stored = ctx.store.getJob(job.id);
    const entries = ctx.store.listLedgerEntries();
    assert.equal(stored.status, 'done');
    assert.equal(stored.usage.totalTokens, 7);
    assert.equal(entries.length, 2);
    assert.ok(entries.some((entry) => entry.type === 'runtime'));
    assert.ok(entries.some((entry) => entry.type === 'model_tokens'));
  } finally {
    await cleanup(ctx);
  }
});

test('project job with a non-sandboxing adapter is rejected under process isolation', async () => {
  const ctx = await makeRunner();
  try {
    ctx.store.upsertProject({
      id: 'proj_claude',
      userId: 'default',
      label: 'Game',
      repoUrl: null,
      branch: 'main',
      adapter: 'claude',
      model: null,
      createdAt: 1,
      updatedAt: 2,
    });
    let spawned = false;
    ctx.runner._spawn = async () => {
      spawned = true;
      return { code: 0, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, calls: 0 } };
    };
    const job = ctx.runner.enqueue({
      projectId: 'proj_claude',
      prompt: 'hi',
      adapter: 'claude',
      isolationLevel: 'process',
    });
    await waitForStatus(ctx.runner, job.id, 'error');
    const stored = ctx.store.getJob(job.id);
    assert.equal(stored.error, 'adapter does not enforce workspace boundary: claude');
    assert.equal(spawned, false);
  } finally {
    await cleanup(ctx);
  }
});

test('container isolation satisfies the workspace boundary for a non-sandboxing adapter', async () => {
  const ctx = await makeRunner();
  try {
    ctx.store.upsertProject({
      id: 'proj_claude_c',
      userId: 'default',
      label: 'Game',
      repoUrl: null,
      branch: 'main',
      adapter: 'claude',
      model: null,
      isolationLevel: 'container',
      createdAt: 1,
      updatedAt: 2,
    });
    let spawned = false;
    ctx.runner._spawn = async () => {
      spawned = true;
      return { code: 0, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, calls: 0 } };
    };
    const job = ctx.runner.enqueue({
      projectId: 'proj_claude_c',
      prompt: 'hi',
      adapter: 'claude',
      isolationLevel: 'container',
    });
    await waitForStatus(ctx.runner, job.id, 'done');
    const stored = ctx.store.getJob(job.id);
    assert.equal(stored.status, 'done');
    assert.equal(stored.isolationLevel, 'container');
    assert.equal(spawned, true);
  } finally {
    await cleanup(ctx);
  }
});

test('project jobs use server-owned project workspace directory', async () => {  const ctx = await makeRunner();
  try {
    ctx.store.upsertProject({
      id: 'proj_game',
      userId: 'default',
      label: 'Game',
      repoUrl: null,
      branch: 'main',
      adapter: 'codex',
      model: 'gpt-test',
      createdAt: 1,
      updatedAt: 2,
    });
    let cwd = '';
    ctx.runner._spawn = async (_job, _command, _args, opts) => {
      cwd = opts.cwd;
      return {
        code: 0,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, calls: 0 },
      };
    };
    const job = ctx.runner.enqueue({
      projectId: 'proj_game',
      prompt: 'hi',
      adapter: 'codex',
    });
    await waitForStatus(ctx.runner, job.id, 'done');
    const stored = ctx.store.getJob(job.id);
    assert.equal(stored.projectId, 'proj_game');
    assert.equal(stored.userId, 'default');
    assert.equal(stored.branch, 'main');
    assert.equal(stored.model, 'gpt-test');
    assert.equal(cwd, join(ctx.workdir, 'default', 'proj_game'));
  } finally {
    await cleanup(ctx);
  }
});

test('enqueue binds the submitted skill source to the actual server job before it runs', async () => {
  const ctx = await makeRunner();
  try {
    ctx.runner._drain = () => {};
    ctx.store.upsertProject({ id: 'skill-project', userId: 'skill-owner', label: 'Skills', repoUrl: null, createdAt: 1, updatedAt: 1 });
    const source = { sessionId: 'captured-session', turnId: 'captured-turn' };
    const job = ctx.runner.enqueue({ userId: 'skill-owner', projectId: 'skill-project', prompt: 'No agent is spawned.', skillSource: source });
    const expected = { hostId: 'ugs-remote-runner', workspaceId: 'skill-project', sessionId: source.sessionId, turnId: source.turnId, runId: job.id };
    source.sessionId = 'switched-session';
    assert.deepEqual(job.skillOrigin, expected);
    assert.equal(Object.isFrozen(job.skillOrigin), true);
    assert.equal(job.status, 'queued');
    await ctx.store._writeChain;
    assert.deepEqual((await new JsonStore(ctx.dataDir).load()).getJob(job.id).skillOrigin, expected);
    assert.throws(() => ctx.runner.enqueue({ userId: 'skill-owner', projectId: 'skill-project', prompt: 'No overrides.', skillSource: { sessionId: 's', turnId: 't', runId: 'client-run' } }), /skill source/);
    assert.throws(() => ctx.runner.enqueue({ userId: 'skill-owner', projectId: 'skill-project', prompt: 'No empty source.', skillSource: { sessionId: ' ', turnId: 't' } }), /skill source/);
    assert.throws(() => ctx.runner.enqueue({ prompt: 'A source requires a bound project.', skillSource: { sessionId: 's', turnId: 't' } }), /skill source/);
  } finally { await cleanup(ctx); }
});

test('a skill-bound job cannot begin execution until its source write completes', async () => {
  const ctx = await makeRunner();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let execution;
  try {
    ctx.store.upsertProject({ id: 'source-barrier-project', userId: 'source-owner', label: 'Source barrier', repoUrl: null, createdAt: 1, updatedAt: 1 });
    await ctx.store._writeChain;
    ctx.runner._drain = () => {};
    ctx.store._writeChain = ctx.store._writeChain.then(() => gate);
    ctx.runner._spawn = async (job) => {
      // Source-order assertions above do not depend on this readback; wait for
      // subsequent status writes so the existing non-atomic JSON store is idle.
      await ctx.store._writeChain;
      const saved = (await new JsonStore(ctx.dataDir).load()).getJob(job.id);
      assert.deepEqual(saved.skillOrigin, job.skillOrigin, 'the authentic source must already be on disk before the native process starts');
      return { code: 0 };
    };
    const job = ctx.runner.enqueue({ userId: 'source-owner', projectId: 'source-barrier-project', adapter: 'codex', prompt: 'Wait for the source.', skillSource: { sessionId: 'barrier-session', turnId: 'barrier-turn' } });
    execution = ctx.runner._execute(job);
    assert.equal(job.startedAt, undefined, 'execution must remain unstarted behind the source persistence barrier');
    assert.equal(job.status, 'queued');
    release();
    await execution;
    assert.equal(job.status, 'done');
    assert.equal(job.skillOrigin.runId, job.id);
  } finally { release(); if (execution) await execution; await cleanup(ctx); }
});

test('enqueue rejects jobs for projects outside current user', async () => {
  const ctx = await makeRunner();
  try {
    ctx.store.upsertProject({
      id: 'proj_game',
      userId: 'user_a',
      label: 'Game',
      repoUrl: null,
      createdAt: 1,
      updatedAt: 2,
    });
    assert.throws(
      () => ctx.runner.enqueue({ userId: 'user_b', projectId: 'proj_game', prompt: 'hi' }),
      /project not found/,
    );
  } finally {
    await cleanup(ctx);
  }
});

test('non-zero exits persist error before terminal status', async () => {
  const ctx = await makeRunner();
  try {
    ctx.runner._spawn = async () => ({
      code: 42,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, calls: 0 },
    });
    const job = ctx.runner.enqueue({ prompt: 'hi', adapter: 'claude' });
    await waitForStatus(ctx.runner, job.id, 'error');
    const stored = ctx.store.getJob(job.id);
    assert.equal(stored.error, 'agent exited with code 42');
  } finally {
    await cleanup(ctx);
  }
});

test('spawn writes prompt to stdin and closes it', async () => {
  const ctx = await makeRunner();
  try {
    const job = ctx.store.upsertJob({
      id: 'job_stdin',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      repoUrl: null,
      branch: null,
      adapter: 'codex',
      model: null,
      prompt: 'hello stdin',
      pushBranch: null,
      logs: [],
      result: null,
      error: null,
    });
    const script =
      'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s));';
    const result = await Promise.race([
      ctx.runner._spawn(job, process.execPath, ['-e', script], {
        cwd: ctx.workdir,
        env: {},
        input: 'hello stdin',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stdin was not closed')), 2000),
      ),
    ]);
    assert.equal(result.code, 0);
    assert.ok(job.logs.some((line) => line.stream === 'stdout' && line.text === 'hello stdin'));
  } finally {
    await cleanup(ctx);
  }
});

test('spawn extracts structured assistant messages from CLI JSONL', async () => {
  const ctx = await makeRunner();
  try {
    const job = ctx.store.upsertJob({
      id: 'job_messages',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      repoUrl: null,
      branch: null,
      adapter: 'codex',
      model: null,
      prompt: 'hello',
      pushBranch: null,
      logs: [],
      messages: [],
      result: null,
      error: null,
    });
    const script = [
      'const event={type:"item.completed",item:{type:"agent_message",text:"远程消息"}};',
      'process.stdout.write(JSON.stringify(event));',
    ].join('');
    const result = await ctx.runner._spawn(job, process.execPath, ['-e', script], {
      cwd: ctx.workdir,
      env: {},
      input: 'hello',
    });
    assert.equal(result.code, 0);
    assert.equal(job.messages.length, 1);
    assert.equal(job.messages[0].role, 'assistant');
    assert.equal(job.messages[0].kind, 'delta');
    assert.equal(job.messages[0].text, '远程消息');
  } finally {
    await cleanup(ctx);
  }
});

test('native Claude tool use and result preserve identities, parent, result and phase', async () => {
  const { remoteMessagesFromJsonEvent } = await import('../src/runner.mjs');
  const context = { runId: 'job-native-claude', nativeTools: new Map() };
  const start = remoteMessagesFromJsonEvent({ type: 'assistant', parent_tool_use_id: 'parent-1', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'node --test' } }] } }, context);
  assert.equal(start.length, 1);
  assert.equal(start[0].toolCallId, 'tool-1');
  assert.equal(start[0].toolId, 'tool-1');
  assert.equal(start[0].nativeToolId, 'tool-1');
  assert.equal(start[0].parentId, 'parent-1');
  assert.equal(start[0].phase, 'start');
  assert.equal(start[0].runId, context.runId);
  assert.equal(start[0].provenance, 'native-tool');
  const end = remoteMessagesFromJsonEvent({ type: 'user', parent_tool_use_id: 'parent-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: '3 tests passed.' }] } }, context);
  assert.equal(end[0].toolName, 'Bash');
  assert.equal(end[0].phase, 'end');
  assert.equal(end[0].result, '3 tests passed.');
  assert.equal(end[0].status, 'success');
  assert.equal(Object.isFrozen(end[0]), true);
});

test('native Codex command execution preserves nonzero exit and output without synthetic success', async () => {
  const { remoteMessagesFromJsonEvent } = await import('../src/runner.mjs');
  const context = { runId: 'job-native-codex', nativeTools: new Map() };
  const start = remoteMessagesFromJsonEvent({ type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: 'node --test', status: 'in_progress' } }, context);
  assert.equal(start[0]?.phase, 'start');
  const end = remoteMessagesFromJsonEvent({ type: 'item.completed', item: { id: 'item-1', type: 'command_execution', command: 'node --test', aggregated_output: '1 test failed.', exit_code: 7, status: 'completed', parent_id: 'parent-codex' } }, context);
  assert.equal(end[0].toolCallId, 'item-1');
  assert.equal(end[0].parentId, 'parent-codex');
  assert.equal(end[0].result, '1 test failed.');
  assert.equal(end[0].exitCode, 7);
  assert.equal(end[0].toolExitCode, 7);
  assert.equal(end[0].status, 'error');
  assert.equal(end[0].provenance, 'native-tool');
  const unknown = remoteMessagesFromJsonEvent({ type: 'item.completed', item: { id: 'item-unknown', type: 'command_execution', status: 'completed', exit_code: null } }, context);
  assert.equal(unknown[0].status, 'unknown');
});

test('native parser persistence redacts and freezes results before storage and never closes tools on job status', async () => {
  const ctx = await makeRunner();
  try {
    const job = ctx.store.upsertJob({ id: 'job_native_persist', status: 'running', createdAt: 1, updatedAt: 1, adapter: 'codex', prompt: '', logs: [], messages: [], result: null, error: null });
    const events = [
      { type: 'item.started', item: { id: 'native-1', type: 'command_execution', command: 'node --test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'native-1', type: 'command_execution', command: 'node --test', aggregated_output: 'ok api_key=fixture-sensitive-secret', exit_code: 0, status: 'completed' } },
      { type: 'item.started', item: { id: 'unfinished-native', type: 'command_execution', command: 'node --test', status: 'in_progress' } },
    ];
    const script = `process.stdout.write(${JSON.stringify(events.map((e) => JSON.stringify(e)).join('\n'))});`;
    const result = await ctx.runner._spawn(job, process.execPath, ['-e', script], { cwd: ctx.workdir, env: {}, input: '' });
    assert.equal(result.code, 0);
    const end = job.messages.find((m) => m.toolCallId === 'native-1' && m.phase === 'end');
    assert.equal(end?.runId, job.id);
    assert.equal(end?.provenance, 'native-tool');
    assert.equal(end?.exitCode, 0);
    assert.match(end?.result, /\[REDACTED\]/);
    assert.equal(Object.isFrozen(end), true);
    ctx.runner._setStatus(job, 'done');
    assert.equal(job.messages.filter((m) => m.toolCallId === 'unfinished-native' && m.phase === 'end').length, 0);
    await ctx.store._writeChain;
    const reloaded = await new JsonStore(ctx.dataDir).load();
    const stored = reloaded.getJob(job.id);
    assert.equal(stored.messages.find((m) => m.phase === 'end').toolCallId, 'native-1');
    assert.equal(JSON.stringify(stored).includes('fixture-sensitive-secret'), false, 'neither raw log nor evidence may store secrets');
  } finally { await cleanup(ctx); }
});

test('native evidence never persists known job secrets or complete credential headers', async () => {
  const ctx = await makeRunner();
  try {
    const secret = 'fixture-bare-sensitive-value';
    const job = ctx.store.upsertJob({ id: 'job_known_redaction', status: 'running', createdAt: 1, updatedAt: 1, adapter: 'codex', prompt: '', logs: [], messages: [], result: null, error: null });
    job._apiKey = secret;
    const output = `Bare known value: ${secret}\nCookie: first=fixture-cookie-one; second=fixture-cookie-two\nSet-Cookie: session=fixture-session-cookie; HttpOnly\n{"password": "fixture spaced password"}`;
    const script = `process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'known-redaction',type:'command_execution',command:'node --test',exit_code:0,aggregated_output:${JSON.stringify(output)}}}));`;
    assert.equal((await ctx.runner._spawn(job, process.execPath, ['-e', script], { cwd: ctx.workdir, env: {}, input: '' })).code, 0);
    ctx.runner._scrubSecrets(job);
    ctx.runner._setStatus(job, 'done');
    await ctx.store._writeChain;
    const stored = (await new JsonStore(ctx.dataDir).load()).getJob(job.id);
    const text = JSON.stringify(stored);
    for (const [index, value] of [secret, 'fixture-cookie-one', 'fixture-cookie-two', 'fixture-session-cookie', 'fixture spaced password'].entries()) assert.equal(text.includes(value), false, `redacted native messages and logs only, fixture index ${index}`);
    assert.equal(stored.messages.find((message) => message.phase === 'end').toolCallId, 'known-redaction');
  } finally { await cleanup(ctx); }
});

test('toolSubject never surfaces free-form text/content snippets', async () => {
  const { toolSubject, remoteMessagesFromJsonEvent } = await import('../src/runner.mjs');
  // A codex tool item carrying the source it is editing must NOT leak that
  // source into the live chat stream — only a short subject (path/command).
  const item = {
    type: 'file_edit',
    file_path: 'app/src/store/useStore.ts',
    text: 'const a = `${phase}${stream}${text}`; // leaked source body',
    status: 'completed',
  };
  const subject = toolSubject(item);
  assert.equal(subject, 'app/src/store/useStore.ts');
  assert.ok(!subject.includes('${phase}'));

  const messages = remoteMessagesFromJsonEvent({ type: 'item.completed', item });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'tool');
  assert.ok(!String(messages[0].text).includes('${phase}'));
  assert.ok(String(messages[0].text).includes('app/src/store/useStore.ts'));
});
