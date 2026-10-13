import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { GatewayProvider } from './modelGateway/types';
import type { SkillReviewState } from '@/runtime/skills/types';
import { createNodeSkillHostPort, createNodeWorkspaceSkillRequest } from '../../cli/io/skill-host';
const live = vi.hoisted(() => ({ providers: [] as GatewayProvider[] }));
vi.mock('@/lib/gatewayConfig', () => ({ listGatewayProviders: () => live.providers }));
import { beginSkillLearningTurn } from './skillLearningDesktop';
import { createSkillReviewModelPort } from './modelGateway/skillReviewGateway';
import { DEFAULT_SKILL_LEARNING_CONFIG } from './skillLearningConfig';

it.skipIf(!process.env.UGS_LIVE_REVIEW_KEY)('learns and reloads a real provider-generated skill through the desktop scheduler', async () => {
  const dir = resolve('../.ultragamestudio/tests/skill-learning-live', String(Date.now()));
  await mkdir(dir, { recursive: true });
  const selection = { adapter: 'codex', providerId: 'live-provider', channelId: 'default', modelClass: 'gpt-6.1-sol' };
  const baseUrl = 'https://ai-gateway.kurogames.com';
  live.providers = [{ id: selection.providerId, name: 'KuroCodeX', kind: 'codex', adapter: 'codex', channels: [{
    id: 'default', name: 'default', apiKey: process.env.UGS_LIVE_REVIEW_KEY, baseUrl, model: selection.modelClass,
    models: undefined, route: { transport: 'cli', baseUrl, model: selection.modelClass, models: undefined },
  }] }];
  const origin = { hostId: 'local', workspaceId: 'live-review-verification', sessionId: 'source', turnId: 'turn', runId: 'source-run' };
  const request = createNodeWorkspaceSkillRequest({ cwd: dir, hostId: origin.hostId, workspaceId: origin.workspaceId });
  const model = createSkillReviewModelPort(selection);
  const states: SkillReviewState[] = [];
  const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 };
  const prompt = '纠正：项目没有指定位置的派生工作副产物，一律写入工作区 .ultragamestudio/ 对应子目录；临时文件进 temp，脚本进 scripts，验证产物进 tests，日志进 logs。修改前先检查现有编码和行尾，仓库 .editorconfig 优先。将这条已确认的工作区约定保存成可复用技能。';
  let host = createNodeSkillHostPort({ origin, mode: 'auto-safe', evidence: [], request });
  const turn = beginSkillLearningTurn({ origin, prompt, selection, config, host: {
    list: () => host.list(), view: (read) => host.view(read), manage: (proposal) => host.manage(proposal),
  }, model, onState: (state) => {
    states.push(state); console.log('真实复盘状态：', state.status);
    if (state.status === 'queued') host = createNodeSkillHostPort({ origin: state.origin,
      mode: 'auto-safe', evidence: state.resume!.job.evidence, request });
  } });
  const result = await turn.finish({ finalAnswer: '已确认工作区目录约定。', terminal: 'completed' });
  await writeFile(resolve(dir, 'result.json'), JSON.stringify({ result, states }, null, 2));
  expect(result.status, result.error).toBe('applied');
  expect(result.operationsApplied).toBeGreaterThan(0);
  const catalog = await host.list();
  expect(catalog.entries.length).toBe(1);
  const entry = catalog.entries[0];
  const read = await host.view({ skillId: entry.skillId });
  expect(read.content).toContain('.ultragamestudio/');
  const next = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'next', turnId: 'next', runId: 'next' },
    prompt: '处理工作区临时验证产物', selection, config: { ...config, enabled: false }, host, model, explicitSkillIds: [entry.skillId] });
  const context = await next.loadContext();
  expect(context.prompt).toContain('.ultragamestudio/');
  expect(context.loadedSkills[0].hash).toBe(read.hash);
  await next.finish({ finalAnswer: '已重新加载真实技能。', terminal: 'completed' });
  await writeFile(resolve(dir, 'learned-skill.md'), read.content);
  expect(await readFile(resolve(dir, 'learned-skill.md'), 'utf8')).toBe(read.content);
  await writeFile(resolve(dir, 'verified.json'), JSON.stringify({ status: 'success', model: selection.modelClass,
    batchId: result.batchId, skillId: entry.skillId, hash: read.hash, reuse: true, usage: result.usage }, null, 2));
  console.log('真实产物：', dir);
}, 120000);
