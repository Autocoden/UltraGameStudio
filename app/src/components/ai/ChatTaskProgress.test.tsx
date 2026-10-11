import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import ChatTaskProgress from './ChatTaskProgress';
import type { ChatTaskProgress as Progress, BackgroundJobDetail } from '@/lib/chatTasks';

let root: Root;
let container: HTMLDivElement;
const plan: Progress = { tasks: [{ id: '1', title: '检查源码', status: 'done' },
  { id: '2', title: '实现功能', activeTitle: '正在实现功能', detail: '补齐进度栏', status: 'running' },
  { id: '3', title: '截图验收', status: 'pending' }], tools: [], startedAt: Date.now() - 1000, hasPlan: true };
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = (progress = plan, active = true, jobs: BackgroundJobDetail[] = []) =>
  act(async () => root.render(<ChatTaskProgress progress={progress} active={active} jobs={jobs} locale="zh-CN" />));

describe('chat task disclosure', () => {
  it('starts folded, expands task details, and updates completion live without losing expansion', async () => {
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[data-ugs-chat-tasks-toggle]')!;
    const body = container.querySelector<HTMLElement>('[data-ugs-chat-tasks-body]')!;
    expect(toggle.textContent).toContain('任务 1/3');
    expect(toggle.textContent).toContain('正在实现功能');
    expect(body.hidden).toBe(true);
    await act(async () => toggle.click());
    expect(body.hidden).toBe(false);
    const detail = container.querySelector<HTMLDetailsElement>('li[data-task-status="running"] details')!;
    await act(async () => detail.querySelector('summary')!.click());
    expect(detail.open).toBe(true);
    expect(detail.textContent).toContain('补齐进度栏');
    await render({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: 'done' })) });
    expect(toggle.textContent).toContain('任务 3/3');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await render({ ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: 'done' })) }, false);
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
  });
  it('hides interrupted tasks and opens folded when another run starts', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-ugs-chat-tasks-toggle]')!.click());
    await render(plan, false);
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
    await render();
    expect(container.querySelector('[data-ugs-chat-tasks-toggle]')?.textContent).toContain('1/3');
    expect(container.querySelector('[data-ugs-chat-tasks-toggle]')?.getAttribute('aria-expanded')).toBe('false');
  });
  it('keeps inside interactions open and dismisses on outside pointer presses even if bubbling is stopped', async () => {
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[data-ugs-chat-tasks-toggle]')!;
    const body = container.querySelector<HTMLElement>('[data-ugs-chat-tasks-body]')!;
    await act(async () => toggle.click());
    await act(async () => body.querySelector('summary')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(body.hidden).toBe(false);
    await act(async () => toggle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(body.hidden).toBe(false);
    const outside = document.createElement('button');
    outside.addEventListener('pointerdown', (event) => event.stopPropagation());
    container.appendChild(outside);
    await act(async () => outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(body.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    outside.remove();
    await act(async () => toggle.click());
    expect(body.hidden).toBe(false);
  });
  it('shows real background progress and logs and never guesses a percentage', async () => {
    const job: BackgroundJobDetail = { manifest: { schema: 1, id: 'job', sessionId: 's', workspaceId: 'w',
      label: '编译验收', startedAt: Date.now(), done: {} }, status: 'running', percent: 37.5,
      progressTail: '构建 37.5%\n正在链接', probedAt: Date.now() };
    await render({ ...plan, tasks: [] }, false, [job]);
    expect(container.querySelector('[data-ugs-chat-tasks-toggle]')?.textContent).toContain('37.5%');
    expect(container.querySelector('[role="log"]')?.textContent).toContain('正在链接');
    await render({ ...plan, tasks: [] }, false, [{ ...job, percent: null }]);
    expect(container.querySelector('[data-ugs-chat-tasks-toggle]')?.textContent).not.toContain('%');
    await render({ ...plan, tasks: [] }, false, [{ ...job, status: 'failed', progressTail: '错误：链接失败' }]);
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
    await render({ ...plan, tasks: [] }, true, [{ ...job, status: 'failed', progressTail: '错误：链接失败' }]);
    expect(container.querySelector('[data-ugs-chat-tasks]')?.getAttribute('data-status')).toBe('error');
    expect(container.querySelector('[role="log"]')?.textContent).toContain('链接失败');
    await render({ ...plan, tasks: [] }, false, [{ ...job, status: 'success', percent: 100 }]);
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
  });
  it('does not render an empty task bar', async () => {
    await render({ tasks: [], tools: [], hasPlan: false, startedAt: 0 }, false);
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
  });
  it('never presents tool calls as tasks or execution details', async () => {
    const interrupted = { ...plan, tools: [{ id: 'tool', name: 'Bash', subject: 'npm test', status: 'running' as const }] };
    const job: BackgroundJobDetail = { manifest: { schema: 1, id: 'job', sessionId: 's', workspaceId: 'w',
      label: '后台验收', startedAt: Date.now(), done: {} }, status: 'running', percent: null,
      progressTail: '', probedAt: Date.now() };
    await render(interrupted, false, [job]);
    expect(container.querySelector('.ai-tool-card[data-status="running"]')).toBeNull();
    expect(container.querySelector('.ai-tool-card')).toBeNull();
    await render({ ...interrupted, hasPlan: false, tasks: [] }, false, [job]);
    expect(container.querySelector('.ai-tool-card[data-status="running"]')).toBeNull();
    expect(container.querySelector('.ai-tool-card')).toBeNull();
  });

  it('hides the task bar without native tasks even while tools run', async () => {
    await render({ tasks: [], tools: [{ id: 'cmd', name: 'commandExecution', subject: 'Get-Content app/package.json', status: 'running' }],
      startedAt: Date.now(), hasPlan: false });
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
    expect(container.textContent).not.toContain('Get-Content');
    expect(container.querySelectorAll('li[data-task-status]')).toHaveLength(0);
  });

  it('waits for native tasks before showing a disclosure and running dots', async () => {
    await render({ tasks: [], tools: [], startedAt: Date.now(), hasPlan: false });
    expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
    await render();
    expect(container.querySelector('li[data-task-status="running"] [data-ugs-task-spinner]')).not.toBeNull();
    expect(container.querySelector('li[data-task-status="pending"] [data-ugs-task-spinner]')).toBeNull();
  });

  it('does not mark the task bar failed just because an execution detail failed', async () => {
    await render({ ...plan, tools: [{ id: 'probe', name: 'mcpToolCall', status: 'error', result: 'unavailable' }] });
    expect(container.querySelector('[data-ugs-chat-tasks]')?.getAttribute('data-status')).toBe('running');
  });
});
