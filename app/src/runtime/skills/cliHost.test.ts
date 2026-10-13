import { describe, expect, it } from 'vitest';
import type { SkillNativeToolEvent } from './types';

async function implementation() { return import(/* @vite-ignore */ './cliHost'); }
const event = (patch: Partial<SkillNativeToolEvent> = {}): SkillNativeToolEvent => ({
  runId: 'run', toolCallId: 'call', toolName: 'Bash', phase: 'end', provenance: 'native-tool',
  status: 'success', exitCode: 0, args: { command: 'npm test' }, ...patch,
});

describe('CLI verification evidence classification', () => {
  it('recognizes only direct native verification commands with a real successful exit', async () => {
    const { isCliVerificationEvent } = await implementation();
    expect(isCliVerificationEvent(event())).toBe(true);
    expect(isCliVerificationEvent(event({ toolName: 'command_execution' }))).toBe(true);
    expect(isCliVerificationEvent(event({ toolName: 'run_shell_command', args: { command: 'npx tsc --noEmit' } }))).toBe(true);
    for (const patch of [
      { phase: 'start' }, { provenance: 'model-output' }, { provenance: 'ui-synthetic' }, { provenance: 'fixture' },
      { exitCode: undefined }, { exitCode: null }, { exitCode: 1 }, { status: 'unknown' },
      { toolName: 'Read' }, { args: { command: 'echo npm test' } },
      { args: { command: 'npm test || true' } }, { args: { command: 'npm test; exit 0' } },
      { args: { command: 'npm test --ignore-scripts' } }, { args: { command: 'npm run test --if-present' } },
      { args: { command: 'cat README.md' }, result: 'npm test PASS' },
      { args: { command: 'npm test ' + 'x'.repeat(5000) } },
    ] as Partial<SkillNativeToolEvent>[]) expect(isCliVerificationEvent(event(patch)), JSON.stringify(patch)).toBe(false);
  });
});
