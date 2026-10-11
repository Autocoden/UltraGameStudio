import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MessageContent from './MessageContent';
import { encodeToolPatch } from './lib/toolEvent';
import { useStore } from '@/store/useStore';

// File existence is a desktop filesystem boundary, not part of grouping.
vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  fileExists: vi.fn(async () => true),
}));

let container: HTMLDivElement;
let root: Root;

async function renderMessage(props: Parameters<typeof MessageContent>[0]) {
  await act(async () => root.render(createElement(MessageContent, props)));
}

function isHidden(node: Element | null): boolean {
  return node == null || node.closest('[hidden]') != null;
}

describe('execution process aggregation', () => {
  beforeEach(() => {
    useStore.setState({ locale: 'zh-CN' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('hoists successful native plan bookkeeping but retains failed updates and regular tools', async () => {
    await renderMessage({ text: encodeToolPatch({ id: 'plan', name: 'functions.update_plan', status: 'done',
      args: { plan: [{ step: '验证', status: 'in_progress' }] } }) });
    expect(container.querySelector('.ai-execution-process')).toBeNull();
    await renderMessage({ text: encodeToolPatch({ id: 'plan-failed', name: 'TodoWrite', status: 'error', result: '计划更新失败' })
      + encodeToolPatch({ id: 'read', name: 'Read', status: 'done' }) });
    expect(container.querySelector('.ai-execution-process__summary')?.textContent).toContain('2 步');
    expect(container.querySelector('.ai-tool-card[data-status="error"]')?.textContent).toContain('TodoWrite');
  });

  it('keeps running tools, failed tools, and live reasoning visible while completed steps stay folded', async () => {
    await renderMessage({
      text: encodeToolPatch({ id: 'settled', name: 'Read', subject: 'settled', status: 'done' })
        + encodeToolPatch({ id: 'active', name: 'Bash', subject: 'building', status: 'running' })
        + encodeToolPatch({ id: 'failed', name: 'Edit', subject: 'failed edit', status: 'error' })
        + '<think>Working through the failure',
      streaming: true,
    });

    expect(container.querySelector('.ai-execution-process__toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(isHidden(container.querySelector('[data-status="running"]'))).toBe(false);
    expect(isHidden(container.querySelector('[data-status="error"]'))).toBe(false);
    expect(isHidden(container.querySelector('.ai-reasoning'))).toBe(false);
    expect(isHidden(container.querySelector('.ai-tool-card[data-status="done"]'))).toBe(true);
  });

  it('reveals completed reasoning on expansion and hides it again on collapse', async () => {
    await renderMessage({ text: '<think>Completed reasoning</think>Answer.' });
    const toggle = container.querySelector<HTMLButtonElement>('.ai-execution-process__toggle');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.click());

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(isHidden(container.querySelector('.ai-reasoning'))).toBe(false);
    expect(container.querySelector<HTMLElement>('.ai-reasoning__body')?.style.gridTemplateRows).toBe('1fr');

    await act(async () => toggle!.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(isHidden(container.querySelector('.ai-reasoning'))).toBe(true);
    expect(isHidden(container.querySelector('.ai-answer-sep'))).toBe(false);
  });

  it('keeps answers chronological and groups telemetry across whitespace-only separators', async () => {
    await renderMessage({
      text: 'First answer.' + encodeToolPatch({ id: 'first', name: 'Read', status: 'done' })
        + '  <think>First reasoning</think>Second answer.'
        + encodeToolPatch({ id: 'second', name: 'Bash', status: 'done' })
        + '<think>Second reasoning</think>Final answer.',
    });

    expect(Array.from(container.querySelectorAll('.ai-answer-sep'), (node) => node.textContent))
      .toEqual(['First answer.', 'Second answer.', 'Final answer.']);
    expect(container.querySelectorAll('.ai-execution-process')).toHaveLength(2);
    expect(Array.from(container.querySelectorAll('.ai-message > .ai-answer-sep, .ai-message > .ai-execution-process'),
      (node) => node.classList.contains('ai-execution-process') ? 'process' : node.textContent))
      .toEqual(['First answer.', 'process', 'Second answer.', 'process', 'Final answer.']);
  });

  it('keeps nested running and failed children visible under their parent without expansion', async () => {
    await renderMessage({
      text: encodeToolPatch({ id: 'parent', name: 'task', subject: 'Review', status: 'done' })
        + '<think>Delegate review</think>'
        + encodeToolPatch({ id: 'child-active', parentId: 'parent', name: 'Read', subject: 'active child', status: 'running' })
        + encodeToolPatch({ id: 'child-failed', parentId: 'parent', name: 'Bash', subject: 'failed child', status: 'error' }),
      streaming: true,
    });

    const parent = container.querySelector('.ai-tool-card');
    expect(parent?.querySelector('.ai-tool-name')?.textContent).toBe('task');
    expect(parent?.querySelectorAll('.ai-tool-card')).toHaveLength(2);
    expect(isHidden(parent?.querySelector('[data-status="running"]') ?? null)).toBe(false);
    expect(isHidden(parent?.querySelector('[data-status="error"]') ?? null)).toBe(false);
    expect(isHidden(parent)).toBe(false);
  });

  it('reveals matching completed reasoning during search without changing the user disclosure choice', async () => {
    const text = '<think>needle in reasoning</think>'
      + encodeToolPatch({ id: 'search-tool', name: 'Read', status: 'done' })
      + 'needle in the answer';
    await renderMessage({ text });
    expect(isHidden(container.querySelector('.ai-reasoning'))).toBe(true);

    await renderMessage({ text, searchState: {
      query: 'needle', messageId: 'message-1', hitCounter: { current: 0 }, activeMatchId: 'message-1:text:0',
    } });

    const marks = container.querySelectorAll('mark[data-search-match-id]');
    expect(Array.from(marks, (mark) => mark.getAttribute('data-search-match-id')))
      .toEqual(['message-1:text:0', 'message-1:text:1']);
    expect(isHidden(marks[0])).toBe(false);
    expect(container.querySelector('.ai-execution-process__toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector<HTMLElement>('.ai-reasoning__body')?.style.gridTemplateRows).toBe('1fr');

    await renderMessage({ text });
    expect(container.querySelector('.ai-execution-process__toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(isHidden(container.querySelector('.ai-reasoning'))).toBe(true);
  });

  it('does not hide an active child whose parent is separated by an answer', async () => {
    await renderMessage({
      text: encodeToolPatch({ id: 'earlier-parent', name: 'task', status: 'done' })
        + 'An ordered answer.'
        + encodeToolPatch({ id: 'later-child', parentId: 'earlier-parent', name: 'Read', subject: 'follow-up child', status: 'running' }),
      streaming: true,
    });

    const groups = container.querySelectorAll('.ai-execution-process');
    expect(groups).toHaveLength(2);
    const child = groups[1].querySelector('.ai-tool-card[data-status="running"]');
    expect(isHidden(child)).toBe(false);
    expect(child?.textContent).toContain('follow-up child');
    expect(container.querySelector('.ai-answer-sep')?.textContent).toBe('An ordered answer.');
  });

  it('preserves user expansion and tool nodes across streaming identity and status updates', async () => {
    const initial = encodeToolPatch({ id: 'streaming-tool-tail', name: 'Read', subject: 'Checking', args: { path: 'example' }, status: 'running' });
    await renderMessage({ text: initial, streaming: true });
    const toggle = container.querySelector<HTMLButtonElement>('.ai-execution-process__toggle');
    const tool = container.querySelector('.ai-tool-card');
    await act(async () => {
      toggle!.click();
      container.querySelector<HTMLButtonElement>('.ai-tool-toggle')!.click();
    });
    expect(tool?.getAttribute('data-open')).toBe('true');

    await renderMessage({
      text: encodeToolPatch({ id: 'actual-tool-id', name: 'Read', subject: 'Checking', args: { path: 'example' }, status: 'done', result: 'Finished' })
        + 'Final answer.',
      streaming: false,
    });
    expect(container.querySelector('.ai-tool-card')).toBe(tool);
    expect(tool?.getAttribute('data-open')).toBe('true');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(tool?.textContent).toContain('Finished');

    await act(async () => toggle!.click());
    expect(isHidden(tool)).toBe(true);
    await act(async () => toggle!.click());
    expect(container.querySelector('.ai-tool-card')).toBe(tool);
    expect(tool?.getAttribute('data-open')).toBe('true');
  });

  it('automatically folds a completed tool without hiding failures after a user collapse', async () => {
    const text = encodeToolPatch({ id: 'active-step', name: 'Bash', subject: 'Active step', status: 'running' })
      + encodeToolPatch({ id: 'failed-step', name: 'Read', subject: 'Failed step', status: 'error' });
    await renderMessage({ text, streaming: true });
    const toggle = container.querySelector<HTMLButtonElement>('.ai-execution-process__toggle');
    await act(async () => toggle!.click());
    await act(async () => toggle!.click());
    expect(isHidden(container.querySelector('.ai-tool-card[data-status="running"]'))).toBe(false);
    expect(isHidden(container.querySelector('.ai-tool-card[data-status="error"]'))).toBe(false);

    await renderMessage({ text: text + encodeToolPatch({ id: 'active-step', status: 'done' }) + 'Final answer.' });
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(isHidden(container.querySelector('.ai-tool-card[data-status="done"]'))).toBe(true);
    expect(isHidden(container.querySelector('.ai-tool-card[data-status="error"]'))).toBe(false);
  });

  it('exposes a semantic tool header hook for execution-process styling', async () => {
    await renderMessage({ text: encodeToolPatch({ id: 'hook', name: 'Read', status: 'running' }), streaming: true });
    expect(container.querySelector('.ai-tool-card > .ai-tool-card__header')).not.toBeNull();
  });

  it('summarizes step counts and active/failure status including nested tools', async () => {
    await renderMessage({
      text: '<think>Plan</think>'
        + encodeToolPatch({ id: 'summary-parent', name: 'task', status: 'done' })
        + encodeToolPatch({ id: 'summary-active', parentId: 'summary-parent', name: 'Read', status: 'running' })
        + encodeToolPatch({ id: 'summary-failed', name: 'Bash', status: 'error' }),
      streaming: true,
    });
    const group = container.querySelector('.ai-execution-process');
    expect(group?.getAttribute('data-status')).toBe('error');
    expect(group?.querySelector('.ai-execution-process__summary')?.textContent).toBe('4 步 · 1 进行中 · 1 失败');
  });

  it('passes workspace file-preview links through grouped reasoning', async () => {
    const calls: string[] = [];
    await renderMessage({
      text: '<think>Inspect src/reasoning.ts</think>Final answer.',
      cwd: 'E:/UltraGameStudio',
      onOpenFile: (ref) => { calls.push(ref.path); },
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.ai-execution-process__toggle')!.click());
    const chip = container.querySelector<HTMLButtonElement>('.ai-reasoning .ai-file-chip');
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.classList.contains('ai-file-chip--interactive')).toBe(true);
    expect(chip?.title.replace(/\\/g, '/')).toContain('E:/UltraGameStudio/src/reasoning.ts');
    await act(async () => chip!.click());
    expect(calls).toEqual(['src/reasoning.ts']);
  });

  it('groups consecutive completed reasoning and tools into one collapsed process', async () => {
    await renderMessage({
      text: '<think>Plan the change</think>' + encodeToolPatch({
        id: 'read-1', name: 'Read', subject: 'src/example.ts', status: 'done',
      }) + 'The final answer.',
    });

    const groups = container.querySelectorAll('.ai-execution-process');
    expect(groups).toHaveLength(1);
    const toggle = groups[0].querySelector('.ai-execution-process__toggle');
    expect(toggle?.textContent).toContain('执行过程');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(isHidden(groups[0].querySelector('.ai-reasoning'))).toBe(true);
    expect(isHidden(groups[0].querySelector('.ai-tool-card'))).toBe(true);
    expect(container.querySelector('.ai-answer-sep')?.textContent).toBe('The final answer.');
    expect(isHidden(container.querySelector('.ai-answer-sep'))).toBe(false);
  });
});
