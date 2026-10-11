import { describe, expect, it } from 'vitest';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { collectChatTaskProgress } from './chatTasks';
import type { Message } from '@/store/types';

const user = (id = 'u'): Message => ({ id, role: 'user', text: '实现需求', createdAt: 1 });
const answer = (text: string): Message => ({ id: 'a', role: 'assistant', text, createdAt: 2 });

describe('native chat task progress', () => {
  it('applies snapshots in stream order and restores them from saved messages', () => {
    const text = encodeToolPatch({ id: 'plan', name: 'update_plan', status: 'done', args: {
      plan: [{ step: '检查', status: 'in_progress' }, { step: '实现', status: 'pending' }],
    } }) + encodeToolPatch({ id: 'plan', args: {
      plan: [{ step: '检查', status: 'completed' }, { step: '实现', status: 'in_progress' }],
    } });
    const progress = collectChatTaskProgress(JSON.parse(JSON.stringify([user(), answer(text)])));
    expect(progress.tasks.map((task) => [task.title, task.status])).toEqual([['检查', 'done'], ['实现', 'running']]);
    expect(progress.tools).toHaveLength(0);
  });

  it('supports Claude TodoWrite and TaskCreate/TaskUpdate native ids', () => {
    const text = encodeToolPatch({ id: 'todos', name: 'TodoWrite', status: 'done', args: {
      todos: [{ content: '编译', activeForm: '正在编译', status: 'in_progress' }],
    } }) + encodeToolPatch({ id: 'create', name: 'TaskCreate', status: 'done', args: {
      subject: '验收', description: '真实点击截图', activeForm: '正在验收',
    }, result: 'Task #7 created successfully: 验收' })
      + encodeToolPatch({ id: 'update', name: 'TaskUpdate', status: 'done', args: { taskId: '7', status: 'completed' } });
    const tasks = collectChatTaskProgress([user(), answer(text)]).tasks;
    expect(tasks).toMatchObject([{ title: '编译', activeTitle: '正在编译', status: 'running' },
      { title: '验收', detail: '真实点击截图', status: 'done' }]);
  });

  it('does not invent tasks from prose or leak a prior turn or nested agent plan', () => {
    const plan = encodeToolPatch({ id: 'old', name: 'update_plan', status: 'done', args: {
      plan: [{ step: '上一轮', status: 'completed' }],
    } });
    const nested = encodeToolPatch({ id: 'child', parentId: 'agent', name: 'TodoWrite', status: 'done',
      args: { todos: [{ content: '子任务', status: 'in_progress' }] } });
    expect(collectChatTaskProgress([user(), answer(plan), user('next'), answer('1. 我正在编译。' + nested)]).tasks).toEqual([]);
  });

  it('accepts an explicit clear but ignores incomplete streamed or failed updates', () => {
    const plan = encodeToolPatch({ id: 'old', name: 'TodoWrite', status: 'done', args: {
      todos: [{ content: '保留', status: 'pending' }],
    } });
    const bad = encodeToolPatch({ id: 'bad', name: 'TodoWrite', status: 'error', args: { todos: [] } });
    expect(collectChatTaskProgress([user(), answer(plan + bad + '\n<<UGS_TOOL>>{"id":"tail","name":"TodoWrite","args":')]).tasks).toHaveLength(1);
    const clear = encodeToolPatch({ id: 'clear', name: 'TodoWrite', status: 'done', args: { todos: [] } });
    expect(collectChatTaskProgress([user(), answer(plan + clear)]).tasks).toHaveLength(0);
  });

  it('preserves Codex todo list booleans and tool fallback metadata', () => {
    const progress = collectChatTaskProgress([user(), answer(encodeToolPatch({ id: 'todo', name: 'todo_list', status: 'done',
      args: { items: [{ text: '完成', completed: true }, { text: '等待', completed: false }] } })
      + encodeToolPatch({ id: 'cmd', name: 'Bash', subject: 'npm test', status: 'running', args: { command: 'npm test' } }))]);
    expect(progress.tasks.map((task) => task.status)).toEqual(['done', 'pending']);
    expect(progress.tools).toMatchObject([{ subject: 'npm test', status: 'running' }]);
  });

  it('keeps interjected input in the same turn instead of clearing its tasks and start time', () => {
    const plan = answer(encodeToolPatch({ id: 'plan', name: 'update_plan', status: 'done', args: {
      plan: [{ step: '当前计划', status: 'in_progress' }],
    } }));
    const progress = collectChatTaskProgress([user(), plan,
      { ...user('interjection'), createdAt: 3, interjected: true },
      { ...answer(encodeToolPatch({ id: 'tool', name: 'Bash', status: 'running' })), id: 'continuation', createdAt: 4 }]);
    expect(progress.tasks).toMatchObject([{ title: '当前计划', status: 'running' }]);
    expect(progress.tools).toMatchObject([{ id: 'tool' }]);
    expect(progress.startedAt).toBe(1);
  });

  it('does not use public progress text as task data', () => {
    const progress = collectChatTaskProgress([user(), answer('🔎 正在核对入口与数据来源。'
      + encodeToolPatch({ id: 'cmd', name: 'commandExecution', subject: 'Get-Content secret.txt', status: 'running' })
      + '<think>内部推理</think>\n已确认两处来源不同，正在统一文件列表。')]);
    expect(progress).not.toHaveProperty('activity');
    expect(progress.tasks).toEqual([]);
    expect(progress.hasPlan).toBe(false);
  });

  it('does not use timing, routing, interaction payloads or a prior turn as task data', () => {
    const progress = collectChatTaskProgress([user(), answer('上一轮文字'), user('next'),
      answer('⏱ 17:35:34 → 17:46:35 · 耗时 11m 01s\n⚙ 路由：渠道 · 模型：模型\n'
        + '<<UGS_ASK>>{"prompt":"私人选择"}<<UGS_ASK_END>>'
        + encodeToolPatch({ id: 'cmd', name: 'commandExecution', status: 'running' }))]);
    expect(progress).not.toHaveProperty('activity');
  });

  it('does not derive task data from a streaming code block or thought', () => {
    expect(collectChatTaskProgress([user(), answer('正在检查配置。\n```ts\nconst token = "private";')])).not.toHaveProperty('activity');
    expect(collectChatTaskProgress([user(), answer('正在检查配置。<think>内部推理')])).not.toHaveProperty('activity');
  });

  it('uses authoritative todo result snapshots including read-only calls', () => {
    const text = encodeToolPatch({ id: 'read', name: 'todo_list', status: 'done', args: {},
      result: JSON.stringify({ todos: [{ id: '1', content: '核对源码', status: 'completed' },
        { id: '2', content: '编译验证', status: 'in_progress' }], revision: 4 }) });
    expect(collectChatTaskProgress([user(), answer(text)]).tasks).toMatchObject([
      { id: 'todos:1', title: '核对源码', status: 'done' }, { id: 'todos:2', title: '编译验证', status: 'running' },
    ]);
  });

  it('merges todo status updates by id without dropping the rest of the plan', () => {
    const text = encodeToolPatch({ id: 'write', name: 'todo_list', status: 'done', args: {
      todos: [{ id: '1', content: '检查', status: 'in_progress' }, { id: '2', content: '实现', status: 'pending' }],
    } }) + encodeToolPatch({ id: 'merge', name: 'todo_list', status: 'done', args: {
      merge: true, todos: [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }],
    } });
    expect(collectChatTaskProgress([user(), answer(text)]).tasks).toMatchObject([
      { title: '检查', status: 'done' }, { title: '实现', status: 'running' },
    ]);
    const authoritative = text + encodeToolPatch({ id: 'replace', name: 'todo_list', status: 'done', args: {
      merge: true, todos: [{ id: '2', content: '实现', status: 'completed' }],
    }, result: JSON.stringify({ todos: [] }) });
    expect(collectChatTaskProgress([user(), answer(authoritative)]).tasks).toEqual([]);
  });
});
