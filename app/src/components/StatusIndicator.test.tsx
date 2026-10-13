import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import StatusIndicator from './StatusIndicator';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('semantic session status indicators', () => {
  it.each([
    ['thinking', 'sparkles', 'var(--status-ai-edit)'],
    ['running', 'loader-circle', 'var(--status-ai-edit)'],
    ['waiting', 'pause', 'var(--status-warning)'],
    ['unrun', 'circle', 'var(--fg-faint)'],
    ['draft', 'pencil', 'var(--status-draft)'],
    ['failed', 'circle-alert', 'var(--status-error)'],
    ['interrupted', 'square', 'var(--fg-dim)'],
  ] as const)('distinguishes %s by a static icon instead of a colored ball', async (tone, icon, color) => {
    await act(async () => root.render(<StatusIndicator tone={tone} label={tone} />));
    const slot = container.querySelector<HTMLElement>('.ugs-status-slot')!;
    expect(slot.getAttribute('data-status')).toBe(tone);
    expect(slot.getAttribute('role')).toBe('img');
    expect(slot.getAttribute('aria-label')).toBe(tone);
    expect(slot.querySelector(`svg.lucide-${icon}`)).not.toBeNull();
    expect(slot.querySelector<HTMLElement>('.ugs-status-indicator')?.style.getPropertyValue('--ugs-status-color')).toBe(color);
    expect(slot.querySelector('.ugs-status-spinner')).toBeNull();
  });

  it('uses a quiet completion check with a separate unread marker that clears without moving the slot', async () => {
    await act(async () => root.render(<StatusIndicator tone="successUnread" label="已完成（未查看）" />));
    const slot = container.querySelector<HTMLElement>('.ugs-status-slot')!;
    expect(slot.getAttribute('aria-label')).toBe('已完成（未查看）');
    expect(slot.querySelector('svg.lucide-check')).not.toBeNull();
    expect(slot.querySelector('.ugs-status-unread')).not.toBeNull();

    await act(async () => root.render(<StatusIndicator tone="success" label="已完成" />));
    expect(container.querySelector('.ugs-status-slot')).toBe(slot);
    expect(slot.querySelector('svg.lucide-check')).not.toBeNull();
    expect(slot.querySelector('.ugs-status-unread')).toBeNull();
    expect(slot.querySelector('.ugs-status-spinner')).toBeNull();

    await act(async () => root.render(<StatusIndicator />));
    expect(container.querySelector('.ugs-status-slot')).toBe(slot);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.getAttribute('role')).toBeNull();
    expect(slot.childElementCount).toBe(0);
  });
});
