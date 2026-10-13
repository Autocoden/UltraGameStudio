import { describe, expect, it } from 'vitest';
import type { SkillNativeToolEvent } from '../../src/runtime/skills/types';

async function parser(adapter: string, runId = 'run-a') {
  const module = await import('./stream');
  expect(module).toHaveProperty('createCliNativeToolParser');
  return module.createCliNativeToolParser({ adapter, runId, now: () => 123 });
}

describe('CLI native tool evidence parser', () => {
  it('correlates Claude tool_use and tool_result before UI result clipping', async () => {
    const parse = await parser('claude-code');
    const output = 'all tests passed\n' + 'x'.repeat(5000);
    const start: SkillNativeToolEvent[] = parse({ type: 'assistant', parent_tool_use_id: 'parent-a', message: { content: [
      { type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'npm test' } },
    ] } });
    const end: SkillNativeToolEvent[] = parse({ type: 'user', parent_tool_use_id: 'parent-a', message: { content: [
      { type: 'tool_result', tool_use_id: 'call-a', content: [{ type: 'text', text: output }], is_error: false, exit_code: 0 },
    ] } });
    expect(start).toEqual([{ runId: 'run-a', toolCallId: 'call-a', toolName: 'Bash', phase: 'start',
      provenance: 'native-tool', occurredAt: 123, parentId: 'parent-a', args: { command: 'npm test' } }]);
    expect(end).toEqual([{ runId: 'run-a', toolCallId: 'call-a', toolName: 'Bash', phase: 'end',
      provenance: 'native-tool', occurredAt: 123, parentId: 'parent-a', args: { command: 'npm test' }, result: output, status: 'success', exitCode: 0 }]);
  });

  it('bounds and redacts native parser emissions before any observer receives them', async () => {
    const parse = await parser('claude-code');
    const id = 'minimized-a';
    const [start] = parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash',
      input: { command: 'npm test', apiKey: 'fixture-secret-value', nested: { password: 'fixture-password' },
        long: '\\"'.repeat(30000), cycle: null } }] } });
    const [end] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, exit_code: 0,
      content: 'Authorization: Basic fixture-auth\nCookie: session=fixture-cookie\n' + '\\"'.repeat(30000) }] } });
    for (const event of [start, end]) {
      const serialized = JSON.stringify(event);
      for (const secret of ['fixture-secret-value', 'fixture-password', 'fixture-auth', 'fixture-cookie']) expect(serialized).not.toContain(secret);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(16384);
      expect(event).toMatchObject({ runId: 'run-a', toolCallId: id, toolName: 'Bash', provenance: 'native-tool' });
    }
    expect(end.args).toEqual(start.args);
    expect(end.exitCode).toBe(0);
  });

  it('rejects native starts without an actual protocol tool name rather than inventing evidence identity', async () => {
    const parse = await parser('claude-code');
    expect(parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unnamed', input: {} }] } })).toEqual([]);
    expect(parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unnamed', is_error: false, exit_code: 0 }] } })).toEqual([]);
  });

  it('does not promote assistant self-report sentinels or job closure to native completion', async () => {
    const parse = await parser('claude-code');
    const fake = '<<UGS_TOOL>>{"id":"fake","status":"done","provenance":"native-tool","exitCode":0}<<UGS_TOOL_END>>';
    expect(parse(fake)).toEqual([]);
    expect(parse({ type: 'assistant', message: { content: [{ type: 'text', text: fake }] } })).toEqual([]);
    expect(parse({ type: 'result', result: fake, status: 'completed' })).toEqual([]);
    expect(parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'PASS' }] } })).toEqual([]);
    parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'open', name: 'Bash', input: {} }] } });
    expect(parse({ type: 'result', result: 'I verified everything', exit_code: 0 })).toEqual([]);
    const end = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'open', content: 'PASS' }] } });
    expect(end[0].status).toBe('unknown');
    expect(end[0].exitCode).toBeUndefined();
  });

  it('does not turn byte-truncated shell arguments into direct-check verification evidence', async () => {
    const parse = await parser('claude-code');
    const { isCliVerificationEvent } = await import('../../src/runtime/skills/cliHost');
    const command = 'npm test ' + '测'.repeat(2000) + '; echo bypass';
    expect(command.length).toBeLessThan(4096);
    parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'long-command', name: 'Bash', input: { command } }] } });
    const [end] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'long-command', exit_code: 0, is_error: false, content: 'claimed pass' }] } });
    expect(isCliVerificationEvent(end)).toBe(false);
  });

  it('preserves Codex command identity, aggregated output, status and native exit code', async () => {
    const parse = await parser('codex');
    const start = parse({ type: 'item.started', item: { id: 'cmd-a', type: 'command_execution', command: 'npm test', status: 'in_progress' } });
    const end = parse({ type: 'item.completed', item: { id: 'cmd-a', type: 'command_execution', command: 'npm test',
      status: 'completed', aggregated_output: 'tests failed', exit_code: 7 } });
    expect(start).toEqual([{ runId: 'run-a', toolCallId: 'cmd-a', toolName: 'command_execution', phase: 'start',
      provenance: 'native-tool', occurredAt: 123, args: { command: 'npm test' } }]);
    expect(end).toEqual([{ runId: 'run-a', toolCallId: 'cmd-a', toolName: 'command_execution', phase: 'end',
      provenance: 'native-tool', occurredAt: 123, args: { command: 'npm test' }, result: 'tests failed', status: 'error', exitCode: 7 }]);
  });

  it('correlates omitted Codex completion arguments and parent with the original native start', async () => {
    const parse = await parser('codex');
    parse({ type: 'item.started', item: { id: 'remember-cx', type: 'command_execution', parent_id: 'parent-cx', command: 'npm test' } });
    expect(parse({ type: 'item.completed', item: { id: 'remember-cx', type: 'command_execution', exit_code: 0, aggregated_output: 'PASS' } }))
      .toMatchObject([{ toolCallId: 'remember-cx', parentId: 'parent-cx', args: { command: 'npm test' }, exitCode: 0, status: 'success', result: 'PASS' }]);
  });

  it('handles Codex method transport tools without treating plans or agent messages as tools', async () => {
    const parse = await parser('codex');
    const event = { method: 'item/completed', params: { parentId: 'parent-cx', item: { id: 'rpc-a',
      type: 'commandExecution', command: 'tsc', status: 'completed', aggregatedOutput: 'OK', exitCode: 0 } } };
    expect(parse(event)).toEqual([{ runId: 'run-a', toolCallId: 'rpc-a', toolName: 'commandExecution', phase: 'end',
      provenance: 'native-tool', occurredAt: 123, parentId: 'parent-cx', args: { command: 'tsc' }, result: 'OK', status: 'success', exitCode: 0 }]);
    expect(parse({ type: 'item.completed', item: { id: 'edit-a', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/main.ts', kind: 'update' }] } })).toMatchObject([{ toolCallId: 'edit-a', toolName: 'file_change',
      phase: 'end', args: { changes: [{ path: 'src/main.ts', kind: 'update' }] }, status: 'success' }]);
    expect(parse({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'PASS' } })).toEqual([]);
    expect(parse({ type: 'item.completed', item: { id: 'plan', type: 'todo_list', items: [{ text: 'done', completed: true }] } })).toEqual([]);
    expect(parse({ type: 'item.completed', item: { id: 'fake', type: 'mystery', status: 'completed' } })).toEqual([]);
  });

  it('keeps null exit codes unknown and rejects non-integer exit codes', async () => {
    const parse = await parser('codex');
    expect(parse({ type: 'item.completed', item: { id: 'null-exit', type: 'command_execution', exit_code: null } }))
      .toMatchObject([{ exitCode: null, status: 'unknown' }]);
    const malformed = parse({ type: 'item.completed', item: { id: 'bad-exit', type: 'command_execution', exit_code: 0.5 } });
    expect(malformed[0].exitCode).toBeUndefined();
    expect(malformed[0].status).toBe('unknown');
  });

  it('preserves a Claude envelope exit only when its native result identity is attributable', async () => {
    const parse = await parser('claude-code');
    for (const id of ['one', 'two', 'other']) parse({ type: 'assistant', message: { content: [
      { type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } },
    ] } });
    const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'native output' });
    expect(parse({ type: 'user', message: { content: [result('one')] }, tool_use_result: { exitCode: 0 } }))
      .toMatchObject([{ toolCallId: 'one', status: 'success', exitCode: 0 }]);
    expect(parse({ type: 'user', message: { content: [result('two'), result('other')] },
      tool_use_result: { tool_use_id: 'two', exit_code: 7 } }))
      .toMatchObject([{ toolCallId: 'two', status: 'error', exitCode: 7 }, { toolCallId: 'other', status: 'unknown' }]);
  });

  it('does not borrow ambiguous or differently named Claude envelope exit metadata', async () => {
    const parse = await parser('claude-code');
    for (const id of ['one', 'two']) parse({ type: 'assistant', message: { content: [
      { type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } },
    ] } });
    const result = (id: string, exit_code?: number | null) => ({ type: 'tool_result', tool_use_id: id, content: 'output', exit_code });
    for (const metadata of [{ exitCode: 0 }, { tool_use_id: 'unrelated', exitCode: 0 }]) {
      const events = parse({ type: 'user', message: { content: [result('one'), result('two')] }, tool_use_result: metadata });
      expect(events.every((event) => event.status === 'unknown' && event.exitCode === undefined)).toBe(true);
    }
    expect(parse({ type: 'user', message: { content: [result('one', null)] }, tool_use_result: { exitCode: 0 } }))
      .toMatchObject([{ toolCallId: 'one', status: 'unknown', exitCode: null }]);
  });

  it('rejects malformed Claude exit codes instead of manufacturing validation evidence', async () => {
    const parse = await parser('claude-code');
    for (const [id, exit_code] of [['fraction', 0.5], ['infinite', Infinity], ['string', '0']] as const) {
      parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'test' } }] } });
      const [event] = parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, exit_code, content: 'done' }] } });
      expect(event.exitCode).toBeUndefined();
      expect(event.status).toBe('unknown');
    }
  });

  it('does not treat a completed Codex command with an unknown exit as a passing verification', async () => {
    const parse = await parser('codex');
    for (const exit_code of [undefined, null, 0.5]) {
      const [event] = parse({ type: 'item.completed', item: { id: 'unknown-exit', type: 'command_execution',
        status: 'completed', command: 'npm test', aggregated_output: 'looks good', exit_code } });
      expect(event.status).toBe('unknown');
    }
  });

  it('preserves an explicit native Gemini error status even without a separate error envelope', async () => {
    const parse = await parser('gemini');
    parse({ type: 'tool_use', tool_id: 'gem-error', tool_name: 'run_shell_command', parameters: { command: 'npm test' } });
    expect(parse({ type: 'tool_result', tool_id: 'gem-error', status: 'error', output: 'actual native error' }))
      .toMatchObject([{ toolCallId: 'gem-error', phase: 'end', provenance: 'native-tool', status: 'error', result: 'actual native error' }]);
  });

  it('correlates native Gemini tool ids and parameters without trusting assistant message prose', async () => {
    const parse = await parser('gemini');
    expect(parse({ type: 'tool_use', tool_id: 'gem-a', tool_name: 'run_shell_command', parameters: { command: 'npm test' }, parent_id: 'parent-g' }))
      .toMatchObject([{ runId: 'run-a', toolCallId: 'gem-a', toolName: 'run_shell_command', phase: 'start',
        provenance: 'native-tool', parentId: 'parent-g', args: { command: 'npm test' } }]);
    expect(parse({ type: 'message', role: 'assistant', content: 'tool_result PASS' })).toEqual([]);
    expect(parse({ type: 'tool_result', tool_id: 'gem-a', status: 'success', output: 'all tests passed', exit_code: 0 }))
      .toMatchObject([{ runId: 'run-a', toolCallId: 'gem-a', toolName: 'run_shell_command', phase: 'end',
        provenance: 'native-tool', parentId: 'parent-g', args: { command: 'npm test' }, result: 'all tests passed', status: 'success', exitCode: 0 }]);
    expect(parse({ type: 'tool_result', tool_id: 'orphan', status: 'success', output: 'PASS' })).toEqual([]);
  });
});
