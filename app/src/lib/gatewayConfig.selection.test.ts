import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_GATEWAY_SELECTION_STORAGE,
  getActiveGatewaySelection,
  setActiveGatewaySelection,
} from './gatewayConfig';

afterEach(() => {
  window.localStorage.clear();
});

describe('persisted default thinking level', () => {
  it.each([
    { adapter: 'codex' as const, modelClass: 'default', systemDefault: true },
    {
      adapter: 'claude-code' as const,
      modelClass: 'opus',
      providerId: 'provider-cli',
      channelId: 'default',
    },
  ])('retains the thinking level when reading $adapter settings', (selection) => {
    setActiveGatewaySelection({ ...selection, thinkingLevel: 'high' });

    expect(getActiveGatewaySelection()).toEqual({
      ...selection,
      thinkingLevel: 'high',
    });
  });

  it.each([
    { value: ' xhigh ', expected: 'xhigh' },
    { value: '', expected: undefined },
    { value: '   ', expected: undefined },
    { value: null, expected: undefined },
    { value: 3, expected: undefined },
    { value: undefined, expected: undefined },
  ])('normalizes the stored thinking level $value', ({ value, expected }) => {
    window.localStorage.setItem(
      ACTIVE_GATEWAY_SELECTION_STORAGE,
      JSON.stringify({ adapter: 'codex', modelClass: 'default', thinkingLevel: value }),
    );

    expect(getActiveGatewaySelection().thinkingLevel).toBe(expected);
  });
});
