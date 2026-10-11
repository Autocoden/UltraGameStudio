import { describe, expect, it } from 'vitest';
import { closeDanglingToolPatches, encodeToolPatch, extractToolSentinels } from './toolEvent';

// A UI-only closer must not overwrite native evidence with a fabricated failure.
describe('tool sentinel evidence provenance', () => {
  it('marks a dangling UI closer as ui-synthetic without inventing an exit code', () => {
    const running = encodeToolPatch({
      id: 'native-call', name: 'Bash', status: 'running',
      parentId: 'native-parent', provenance: 'native-tool',
    });
    const patches = extractToolSentinels(closeDanglingToolPatches(running)).patches;
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ id: 'native-call', status: 'error', provenance: 'ui-synthetic' });
    expect(patches[1]).not.toHaveProperty('exitCode');
  });
});
