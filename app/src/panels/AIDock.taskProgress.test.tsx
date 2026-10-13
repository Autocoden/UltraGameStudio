import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import AIDock from './AIDock';
import { useStore } from '@/store/useStore';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from '@/store/sampleSessions';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  useStore.setState({ mode: 'design', workflow: simpleBlueprint('任务验收'), locale: 'zh-CN',
    composer: { ...defaultComposer, workspace: 'E:/UltraGameStudio' }, activeSessionId: 's1', activeWorkspaceId: 'w1',
    queuedChatMessageIds: [], aiEditingSessions: [], chattingSessions: [{ workspaceId: 'w1', sessionId: 's1' }], jobDetails: [],
    messages: [{ id: 'u1', role: 'user', text: '实现', createdAt: 1 },
      { id: 'a1', role: 'assistant', createdAt: 2, text: encodeToolPatch({ id: 'plan', name: 'update_plan', status: 'done', args: {
        plan: [{ step: '检查源码', status: 'completed' }, { step: '实现任务进度', status: 'in_progress' }],
      } }) }] });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('places native progress above the input, ignores queued turns and isolates session job details', async () => {
  await act(async () => root.render(<AIDock layout="chat" />));
  const bar = container.querySelector('[data-ugs-chat-tasks]')!;
  expect(bar.textContent).toContain('任务 1/2');
  expect(bar.compareDocumentPosition(container.querySelector('.ugs-ai-input-card')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => useStore.setState({ queuedChatMessageIds: ['queued'], messages: [...useStore.getState().messages,
    { id: 'queued', role: 'user', text: '下一条', createdAt: 3 }] }));
  expect(container.querySelector('[data-ugs-chat-tasks]')?.textContent).toContain('任务 1/2');
  await act(async () => useStore.setState({ activeWorkspaceId: 'w2', activeSessionId: 's2', messages: [],
    jobDetails: [{ manifest: { schema: 1, id: 'job1', workspaceId: 'w1', sessionId: 's1', label: '其他会话任务', startedAt: 1, done: {} },
      status: 'running', percent: 25, progressTail: '25%', probedAt: 2 }] }));
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
  await act(async () => useStore.setState({ activeWorkspaceId: 'w1', activeSessionId: 's1' }));
  expect(container.querySelector('[data-ugs-chat-tasks]')?.textContent).toContain('其他会话任务');
});

it('dismisses progress when the input is pressed and removes the bar when the turn ends', async () => {
  await act(async () => root.render(<AIDock layout="chat" />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-ugs-chat-tasks-toggle]')!.click());
  const body = container.querySelector<HTMLElement>('[data-ugs-chat-tasks-body]')!;
  expect(body.hidden).toBe(false);
  await act(async () => container.querySelector('.ugs-ai-input-card')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(body.hidden).toBe(true);
  await act(async () => useStore.setState({ chattingSessions: [] }));
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
  await act(async () => useStore.setState({ jobDetails: [{ manifest: { schema: 1, id: 'job1', workspaceId: 'w1', sessionId: 's1',
    label: '仍在构建', startedAt: 1, done: {} }, status: 'running', percent: 80, progressTail: '80%', probedAt: 2 }] }));
  expect(container.querySelector('[data-ugs-chat-tasks-toggle]')?.textContent).toContain('仍在构建');
  await act(async () => useStore.setState({ jobDetails: useStore.getState().jobDetails.map((job) => ({ ...job, status: 'success' })) }));
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
});

it('only shows the latest turn tasks and jobs, even when an older job is still running', async () => {
  const oldMessages = useStore.getState().messages;
  await act(async () => useStore.setState({ jobDetails: [
    { manifest: { schema: 1, id: 'old-running', workspaceId: 'w1', sessionId: 's1',
      label: '上一轮仍在运行', startedAt: 3, done: {} }, status: 'running', percent: 90, progressTail: '90%', probedAt: 20 },
    { manifest: { schema: 1, id: 'old-done', workspaceId: 'w1', sessionId: 's1',
      label: '上一轮已完成', startedAt: 4, done: {} }, status: 'success', percent: 100, progressTail: '100%', probedAt: 20 },
  ] }));
  await act(async () => root.render(<AIDock layout="chat" />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-ugs-chat-tasks-toggle]')!.click());
  await act(async () => useStore.setState({ messages: [...oldMessages,
    { id: 'u2', role: 'user', text: '第二轮', createdAt: 10 },
    { id: 'a2', role: 'assistant', createdAt: 11, text: encodeToolPatch({ id: 'new-plan', name: 'update_plan', status: 'done', args: {
      plan: [{ step: '本轮检查', status: 'completed' }, { step: '本轮构建', status: 'in_progress' }],
    } }) }], jobDetails: [...useStore.getState().jobDetails,
    { manifest: { schema: 1, id: 'new-running', workspaceId: 'w1', sessionId: 's1',
      label: '本轮后台任务', startedAt: 12, done: {} }, status: 'running', percent: 25, progressTail: '25%', probedAt: 20 },
    { manifest: { schema: 1, id: 'new-done', workspaceId: 'w1', sessionId: 's1',
      label: '本轮完成任务', startedAt: 13, done: {} }, status: 'success', percent: 100, progressTail: '100%', probedAt: 20 },
  ] }));
  const bar = container.querySelector('[data-ugs-chat-tasks]')!;
  expect(bar.textContent).toContain('任务 1/2');
  expect(bar.textContent).toContain('后台 1/2');
  expect(bar.textContent).toContain('本轮后台任务');
  expect(bar.textContent).not.toContain('上一轮');
  expect(bar.textContent).not.toContain('实现任务进度');
  expect(container.querySelector<HTMLElement>('[data-ugs-chat-tasks-body]')!.hidden).toBe(true);
  await act(async () => useStore.setState({ queuedChatMessageIds: ['u3'], messages: [...useStore.getState().messages,
    { id: 'u3', role: 'user', text: '排队的第三轮', createdAt: 30 }] }));
  expect(container.querySelector('[data-ugs-chat-tasks]')?.textContent).toContain('本轮后台任务');
  await act(async () => useStore.setState({ chattingSessions: [],
    jobDetails: useStore.getState().jobDetails.map((job) => job.manifest.id === 'new-running' ? { ...job, status: 'success' } : job) }));
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
});

it('does not reuse previous tasks while the latest turn waits for its first task event', async () => {
  await act(async () => root.render(<AIDock layout="chat" />));
  await act(async () => useStore.setState({ messages: [...useStore.getState().messages,
    { id: 'u2', role: 'user', text: '新一轮', createdAt: 10 }], jobDetails: [
    { manifest: { schema: 1, id: 'old', workspaceId: 'w1', sessionId: 's1',
      label: '旧后台任务', startedAt: 3, done: {} }, status: 'running', percent: 90, progressTail: '90%', probedAt: 20 },
  ] }));
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
  await act(async () => useStore.setState({ messages: [...useStore.getState().messages,
    { id: 'a2', role: 'assistant', createdAt: 11, text: encodeToolPatch({ id: 'new-tool', name: 'Bash',
      subject: '当前工具步骤', status: 'running', args: { command: 'npm test' } }) }] }));
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
});

it('keeps commentary in the transcript and does not manufacture a task disclosure from it', async () => {
  const commentary = '检查截图和上次增高改动，定位底部留白原因。';
  await act(async () => useStore.setState({ messages: [
    { id: 'u1', role: 'user', text: '检查问题', createdAt: 1 },
    { id: 'a1', role: 'assistant', text: commentary + encodeToolPatch({ id: 'read', name: 'Bash', status: 'running', subject: '读取源码' }), createdAt: 2 },
  ] }));
  await act(async () => root.render(<AIDock layout="chat" />));
  expect(container.textContent).toContain(commentary);
  expect(container.querySelector('[data-ugs-chat-tasks]')).toBeNull();
});

it('renders successful plan updates only in the task disclosure', async () => {
  await act(async () => root.render(<AIDock layout="chat" />));
  expect(container.querySelector('[data-ugs-chat-tasks]')?.textContent).toContain('实现任务进度');
  expect(container.querySelector('.ai-execution-process')).toBeNull();
  await act(async () => useStore.setState({ messages: [...useStore.getState().messages,
    { id: 'a2', role: 'assistant', createdAt: 3, text: encodeToolPatch({ id: 'read', name: 'Bash', status: 'running', subject: '读取源码' }) },
  ] }));
  expect(container.querySelector('.ai-execution-process')?.textContent).toContain('1 步');
  expect(container.querySelector('.ai-execution-process')?.textContent).not.toContain('update_plan');
});
