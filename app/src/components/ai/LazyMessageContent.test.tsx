import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import LazyMessageContent from './LazyMessageContent';

vi.mock('./MessageContent', () => ({ default: () => <div data-rich="true">完整正文与执行记录</div> }));

afterEach(() => vi.unstubAllGlobals());

describe('initial message rendering', () => {
  it.each([false, true])('renders eager content in the first commit (streaming=%s)', async (streaming) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const firstCommit: boolean[] = [];
    function Probe() {
      useLayoutEffect(() => { firstCommit.push(!!container.querySelector('[data-rich]')); }, []);
      return <LazyMessageContent text="正文" fallback="占位" eager streaming={streaming} />;
    }
    try {
      await act(async () => root.render(<Probe />));
      expect(firstCommit).toEqual([true]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps offscreen messages lazy until they approach the viewport', async () => {
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LazyMessageContent text="正文" fallback="占位" />));
      expect(container.querySelector('[data-rich]')).toBeNull();
      await act(async () => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(container.querySelector('[data-rich]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
