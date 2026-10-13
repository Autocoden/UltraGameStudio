import { describe, expect, it } from 'vitest';
import { codexPlanPatch } from './stream';

describe('Codex native plan transport', () => {
  it('preserves app-server plan status and explanation', () => {
    expect(codexPlanPatch({ method: 'turn/plan/updated', params: { turnId: 'turn',
      explanation: '开始验证', plan: [{ step: '编译', status: 'inProgress' }] } }))
      .toMatchObject({ id: 'plan:turn', name: 'update_plan', args: {
        explanation: '开始验证', plan: [{ step: '编译', status: 'inProgress' }],
      } });
  });
  it.each(['item.started', 'item.updated', 'item.completed'])('preserves %s todo snapshots', (type) => {
    expect(codexPlanPatch({ type, item: { id: 'todos', type: 'todo_list', items: [{ text: '编译', completed: false }] } }))
      .toMatchObject({ id: 'plan:todos', args: { plan: [{ text: '编译', completed: false }] } });
  });
  it('ignores ordinary tools and malformed native plans', () => {
    expect(codexPlanPatch({ type: 'item.completed', item: { type: 'command_execution' } })).toBeUndefined();
    expect(codexPlanPatch({ method: 'turn/plan/updated', params: { plan: 'bad' } })).toBeUndefined();
  });
});
