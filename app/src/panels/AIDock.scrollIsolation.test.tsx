// Per-session scroll isolation, exercised against browser scrolling semantics.
//
// The plain jsdom tests cannot reach these bugs: `getBoundingClientRect()`
// returns zeros, `scrollHeight`/`clientHeight` are static stubs, and
// IntersectionObserver is undefined — so the lazy markdown never upgrades and
// the content never grows under the viewport. This harness models what WebView2
// actually does instead:
//   * scrollHeight is derived from the rows currently mounted, scrollTop is
//     clamped against it, and every write is delivered as a real scroll event;
//   * rows report real (offset, height) rects, so the anchor logic in
//     streamScroll.ts has something to work with;
//   * IntersectionObserver upgrades off-screen placeholders to rich markdown on
//     a later frame, growing the content while the viewport stays put;
//   * ResizeObserver fires after that growth.
// Regression: a session pinned to the bottom was restored against the partial
// first-frame layout, then the growth its own restore triggered produced a
// scroll event which was read as "the user scrolled away from the bottom". That
// latched the session as manually scrolled, so every later re-pin was skipped
// and switching back to it left its scrollbar stranded in the middle.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import type { Message } from '@/store/types';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return { ...actual, tauriAvailable: () => true };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CLIENT_H = 600;
const PAD = 16;
const GAP = 16;
const RICH_H = 220;
const PLAIN_H = 44;
const LOAD_MORE_H = 30;
/**
 * How far a session left part way up its history may reopen from where it was
 * left, in messages. Reopening exact is not guaranteed for the rows above the
 * visible anchor (they are re-mounted as plain placeholders and grow when they
 * upgrade); what matters is that a session reopens on its OWN history rather
 * than on the other session's position, which is thousands of pixels away.
 */
const MID_SCROLL_DRIFT_ROWS = 12;

interface Item {
  el: Element;
  top: number;
  height: number;
}

function isRichRow(li: Element): boolean {
  return li.querySelector('.ai-stream-text') === null;
}

function layoutItems(stream: HTMLElement): Item[] {
  const ul = stream.querySelector('ul');
  if (!ul) return [];
  const out: Item[] = [];
  let top = PAD;
  for (const li of Array.from(ul.children)) {
    const height = li.querySelector('[data-ugs-load-earlier-messages]')
      ? LOAD_MORE_H
      : isRichRow(li)
        ? RICH_H
        : PLAIN_H;
    out.push({ el: li, top, height });
    top += height + GAP;
  }
  return out;
}

function contentHeight(stream: HTMLElement): number {
  const items = layoutItems(stream);
  if (items.length === 0)
    return stream.querySelector('.ugs-ai-return-empty') ? CLIENT_H : 0;
  const last = items[items.length - 1];
  return last.top + last.height + PAD;
}

function rect(top: number, height: number, width = 400): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const scrollTops = new WeakMap<Element, number>();
const pendingScrollEvents = new Set<Element>();

function maxScroll(stream: HTMLElement): number {
  return Math.max(0, contentHeight(stream) - CLIENT_H);
}

function setScrollTop(stream: HTMLElement, value: number): void {
  const next = Math.max(0, Math.min(value, maxScroll(stream)));
  const prev = scrollTops.get(stream) ?? 0;
  scrollTops.set(stream, next);
  if (next !== prev) pendingScrollEvents.add(stream);
}

function installStreamLayout(stream: HTMLElement): void {
  scrollTops.set(stream, 0);
  Object.defineProperty(stream, 'clientHeight', {
    configurable: true,
    get: () => CLIENT_H,
  });
  Object.defineProperty(stream, 'scrollHeight', {
    configurable: true,
    get: () => contentHeight(stream),
  });
  Object.defineProperty(stream, 'scrollTop', {
    configurable: true,
    get: () => scrollTops.get(stream) ?? 0,
    set: (v: number) => setScrollTop(stream, v),
  });
  stream.scrollTo = ((opts?: ScrollToOptions | number) => {
    const top =
      typeof opts === 'object' && opts
        ? (opts.top ?? scrollTops.get(stream) ?? 0)
        : (scrollTops.get(stream) ?? 0);
    setScrollTop(stream, top);
  }) as typeof stream.scrollTo;
  stream.getBoundingClientRect = () => rect(0, CLIENT_H, 800);
}

/**
 * Give every mounted row a rect whose scroll offset is resolved when it is
 * asked for. A rect captured with the current scrollTop baked in goes stale the
 * moment anything scrolls, and the app reads rects immediately after a scroll
 * (to remember an anchor) — a stale one makes it record a position that never
 * existed. Row order and heights are refreshed each frame, since those only
 * change through the DOM updates this harness already drives.
 */
function patchRects(stream: HTMLElement): void {
  for (const item of layoutItems(stream)) {
    const el = item.el as HTMLElement;
    el.getBoundingClientRect = () =>
      el.isConnected
        ? rect(item.top - (scrollTops.get(stream) ?? 0), item.height)
        : rect(0, 0);
  }
}

async function flushScrollEvents(): Promise<void> {
  if (pendingScrollEvents.size === 0) return;
  const els = Array.from(pendingScrollEvents);
  pendingScrollEvents.clear();
  await act(async () => {
    for (const el of els)
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this);
  }
  observe = (el: Element) => {
    this.targets.add(el);
  };
  unobserve = (el: Element) => {
    this.targets.delete(el);
  };
  disconnect = () => {
    this.targets.clear();
  };
  takeRecords = () => [];

  /** Deliver intersections the way the browser would on the next frame. */
  deliver(): boolean {
    const margin = 600;
    const rootTop = -margin;
    const rootBottom = CLIENT_H + margin;
    const entries: IntersectionObserverEntry[] = [];
    let intersecting = false;
    for (const el of this.targets) {
      const r = el.getBoundingClientRect();
      const hit = r.bottom > rootTop && r.top < rootBottom;
      if (hit) intersecting = true;
      entries.push({
        target: el,
        isIntersecting: hit,
        boundingClientRect: r,
      } as unknown as IntersectionObserverEntry);
    }
    if (entries.length === 0 || !intersecting) return false;
    this.callback(entries, this as unknown as IntersectionObserver);
    return true;
  }
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function makeMessages(prefix: string, count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    role: 'assistant',
    text: `${prefix} message ${i}\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n`,
    createdAt: Date.now() + i,
  }));
}

function resetStore(sessionId: string, messages: Message[]): void {
  useStore.setState({
    mode: 'design',
    workflow: defaultBlueprint('Scroll isolation'),
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    locale: 'zh-CN',
    promptGroups: samplePromptGroups,
    composer: { ...defaultComposer, workspace: 'E:\\UltraGameStudio' },
    composerDraft: '',
    composerDrafts: {},
    composerFocusVersion: 0,
    messages,
    activeWorkspaceId: null,
    activeSessionId: sessionId,
    workspaceHistory: [],
    runningSessionProgress: {},
  });
}

function streamOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.ugs-ai-return-stream');
  if (!(el instanceof HTMLElement)) throw new Error('missing stream');
  return el;
}

async function renderDock(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<AIDock layout="chat" />);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** One browser frame, in the order the browser delivers work. */
async function frame(stream: HTMLElement, rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await flushScrollEvents();
    patchRects(stream);
    await act(async () => {
      for (const io of IntersectionObserverStub.instances) io.deliver();
    });
    patchRects(stream);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    patchRects(stream);
    await act(async () => {
      for (const ro of ResizeObserverStub.instances) ro.trigger();
    });
    patchRects(stream);
  }
}

function topOf(stream: HTMLElement): number {
  return scrollTops.get(stream) ?? 0;
}

/**
 * The message currently sitting at the top of the viewport, and how far above
 * the viewport edge it starts. This — not the absolute scrollTop — is the
 * contract for a session left part way up its history: the same message must
 * come back to the same place on screen, whatever the lazily mounted window
 * above it happens to contain.
 */
function topVisibleMessage(
  stream: HTMLElement,
): { session: string; index: number; offsetTop: number } | null {
  const ul = stream.querySelector('ul');
  if (!ul) return null;
  for (const li of Array.from(ul.children)) {
    const r = li.getBoundingClientRect();
    if (r.bottom <= 0) continue;
    // Row text carries the assistant header and copy label around the body.
    const match = /(?:^|[^a-z])([ab]) message (\d+)/.exec(li.textContent ?? '');
    if (!match) continue;
    return { session: match[1], index: Number(match[2]), offsetTop: r.top };
  }
  return null;
}

async function switchSession(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  await act(async () => {
    useStore.setState({ activeSessionId: sessionId, messages });
  });
}

/** Opens a session and lets its background window growth and lazy markdown settle. */
async function openSession(
  stream: HTMLElement,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  await switchSession(sessionId, messages);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await frame(stream, 4);
}

describe('AIDock per-session scroll isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    IntersectionObserverStub.instances = [];
    ResizeObserverStub.instances = [];
    (
      globalThis as { IntersectionObserver?: typeof IntersectionObserver }
    ).IntersectionObserver =
      IntersectionObserverStub as unknown as typeof IntersectionObserver;
    (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a bottom-pinned session at the bottom across a switch into a scrolled session', async () => {
    const sessionA = makeMessages('a', 60);
    const sessionB = makeMessages('b', 60);
    resetStore('session-a', sessionA);
    const { container, cleanup } = await renderDock();
    try {
      const stream = streamOf(container);
      installStreamLayout(stream);
      patchRects(stream);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await frame(stream, 4);

      // The user reads A at the bottom.
      setScrollTop(stream, maxScroll(stream) + 5000);
      await flushScrollEvents();

      // Switch to B and leave it scrolled up.
      await openSession(stream, 'session-b', sessionB);
      setScrollTop(stream, 1200);
      await flushScrollEvents();

      // Back to A: it must settle at the true bottom of its own content, which
      // keeps growing for several frames after the switch.
      await switchSession('session-a', sessionA);
      for (let i = 0; i < 8; i += 1) {
        await frame(stream, 1);
        expect(topOf(stream)).toBe(maxScroll(stream));
      }
    } finally {
      await cleanup();
    }
  });

  it('does not leak one session scroll position into another mid-scrolled session', async () => {
    const sessionA = makeMessages('a', 60);
    const sessionB = makeMessages('b', 60);
    resetStore('session-a', sessionA);
    const { container, cleanup } = await renderDock();
    try {
      const stream = streamOf(container);
      installStreamLayout(stream);
      patchRects(stream);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await frame(stream, 4);

      // A is left part way up its history.
      setScrollTop(stream, 1400);
      await flushScrollEvents();
      await frame(stream, 2);
      const aLeftAt = topOf(stream);
      const aReading = topVisibleMessage(stream);
      expect(aReading).not.toBeNull();

      // B is left somewhere completely different.
      await openSession(stream, 'session-b', sessionB);
      setScrollTop(stream, 3600);
      await flushScrollEvents();
      await frame(stream, 2);
      const bLeftAt = topOf(stream);
      const bReading = topVisibleMessage(stream);
      expect(bReading).not.toBeNull();
      expect(
        Math.abs(bLeftAt - aLeftAt),
        `A left at ${aLeftAt} (${JSON.stringify(aReading)}), B left at ${bLeftAt} (${JSON.stringify(bReading)})`,
      ).toBeGreaterThan(1000);

      // Switching back reopens A around its own reading position and never at
      // B's. The exact offset inside A drifts by at most a screenful: the rows
      // above the visible anchor are re-mounted as plain placeholders and grow
      // when they upgrade, which is a separate, pre-existing approximation. What
      // must not happen is A landing on the other session's position.
      await switchSession('session-a', sessionA);
      await frame(stream, 6);
      const aRestored = topVisibleMessage(stream);
      expect(
        aRestored,
        `A had ${JSON.stringify(aReading)}, got ${JSON.stringify(aRestored)}`,
      ).not.toBeNull();
      expect(
        Math.abs((aRestored?.index ?? 0) - (aReading?.index ?? 0)),
        `A top message was ${aReading?.index}, restored as ${aRestored?.index} ` +
          `(scrollTop ${topOf(stream)}, left at ${aLeftAt}, B at ${bLeftAt})`,
      ).toBeLessThanOrEqual(MID_SCROLL_DRIFT_ROWS);
      expect(
        aRestored?.session,
        `A restored onto session ${aRestored?.session} content`,
      ).toBe('a');

      // And B still reopens on its own history, not on A's position.
      await switchSession('session-b', sessionB);
      await frame(stream, 6);
      const bRestored = topVisibleMessage(stream);
      expect(bRestored).not.toBeNull();
      expect(
        bRestored?.session,
        `B restored onto session ${bRestored?.session} content`,
      ).toBe('b');
      expect(Math.abs(topOf(stream) - bLeftAt)).toBeLessThanOrEqual(
        MID_SCROLL_DRIFT_ROWS * (RICH_H + GAP),
      );
    } finally {
      await cleanup();
    }
  });
});
