import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => true,
}));

const resizeCallbacks = new Set<ResizeObserverCallback>();
class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;
let contentHeight: number;
let chromeHeight: number;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.localStorage.clear();
  window.localStorage.setItem('ultragamestudio.chatInputHeight.v1', '180');
  contentHeight = 24;
  chromeHeight = 100;
  useStore.setState({
    mode: 'design', locale: 'zh-CN', selectedNodeId: null,
    composer: { ...defaultComposer, workspace: '' }, composerDraft: '',
    composerDrafts: {}, composerFocusVersion: 0,
    aiStreaming: false, aiEditingSessions: [], chattingSessions: [],
    activeWorkspaceId: null, activeSessionId: 'autogrow', workspaceHistory: [],
    runningSessionProgress: {},
    messages: [{ id: 'answer', role: 'assistant', text: '继续。', createdAt: 1 }],
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    let height = 0;
    if (this.matches('section[aria-label="AI 输入"]')) height = parseFloat(this.style.height) || 180;
    if (this.matches('.ugs-ai-input-card textarea')) {
      const section = this.closest('section') as HTMLElement;
      height = (parseFloat(section.style.height) || 180) - chromeHeight;
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: height, width: 1000, height, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('.ugs-ai-input-card textarea') ? contentHeight : 0;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  resizeCallbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const section = () => container.querySelector<HTMLElement>('section[aria-label="AI 输入"]')!;
const input = () => container.querySelector<HTMLTextAreaElement>('.ugs-ai-input-card textarea')!;
const render = async () => { await act(async () => root.render(<AIDock layout="chat" />)); };
const updateDraft = async (height: number, text: string) => {
  contentHeight = height;
  await act(async () => useStore.getState().setComposerDraft(text));
};

describe('chat composer content height', () => {
  it('grows after messages exist and shrinks when text is removed', async () => {
    await render();
    expect(section().style.height).toBe('180px');
    expect(input().style.overflowY).toBe('hidden');
    await updateDraft(260, '多行内容\n最后一行');
    expect(section().style.height).toBe('360px');
    expect(input().style.overflowY).toBe('hidden');
    await updateDraft(24, '短文本');
    expect(section().style.height).toBe('180px');
    expect(window.localStorage.getItem('ultragamestudio.chatInputHeight.v1')).toBe('180');
  });

  it('scrolls only above the cap and hides scrolling after shrinking', async () => {
    await render();
    await updateDraft(1200, '长文本');
    expect(parseFloat(section().style.height)).toBeLessThanOrEqual(560);
    expect(input().style.overflowY).toBe('auto');
    await updateDraft(24, '短文本');
    expect(input().style.overflowY).toBe('hidden');
  });

  it('remeasures wrapping and toolbar or attachment space without changing the draft', async () => {
    await render();
    await updateDraft(220, '同一段文字');
    contentHeight = 300;
    chromeHeight = 140;
    await act(async () => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    });
    expect(section().style.height).toBe('440px');
    expect(input().style.overflowY).toBe('hidden');
  });
});
