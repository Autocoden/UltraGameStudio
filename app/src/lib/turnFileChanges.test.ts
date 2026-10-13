import { describe, expect, it } from 'vitest';
import { collectSessionEditedFiles, collectSessionFileChanges, collectTurnFileChanges, supportsNativeFileChanges } from './turnFileChanges';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { extractSessionFiles } from './sessionFiles';
import type { Message } from '@/store/types';
import type { WorkspaceChanges } from './tauri';

const message = (text: string): Message => ({ id: 'a', role: 'assistant', createdAt: 1, text });
const snapshot: WorkspaceChanges = {
  rootPath: 'E:/Game', generatedAtMs: 2, source: 'snapshot', truncated: false,
  files: [{ path: 'src/fallback.ts', status: 'modified', binary: false, truncated: false,
    lines: [{ kind: 'added', content: 'new' }, { kind: 'deleted', content: 'old' }] }],
};

describe('turn file changes', () => {
  it('derives sidebar membership from saved turn totals while retaining activity metadata', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', text: 'edit', createdAt: 1 },
      { ...message(encodeToolPatch({ id: 'edit', name: 'Edit', status: 'done', args: { file_path: 'src/app.ts' } }) +
        encodeToolPatch({ id: 'read', name: 'Read', status: 'done', args: { file_path: 'read-only.ts' } }) +
        encodeToolPatch({ id: 'not-saved', name: 'Edit', status: 'done', args: { file_path: 'excluded-by-summary.ts' } })),
        createdAt: 2, fileChanges: { source: 'snapshot', rootPath: 'E:/Game', files: [
          { path: 'E:/Game/src/app.ts', added: 3, deleted: 1 },
          { path: '.ultragamestudio/temp/report.md', status: 'added', added: 2, deleted: 0 },
        ] } },
    ];
    const summary = collectSessionFileChanges(messages, 'E:/Game')!;
    const entries = collectSessionEditedFiles(messages, 'E:/Game');
    expect(entries.map((entry) => entry.path)).toEqual(summary.files.map((file) => file.path));
    expect(entries[0]).toMatchObject({ action: 'edited', lastTouchedAt: 2, changeStatus: 'modified' });
    expect(entries[1]).toMatchObject({ basename: 'report.md', action: 'edited', changeStatus: 'added' });
  });
  it('counts live confirmed edits, ignores local notes and preserves unknown counts', () => {
    const live = { ...message(encodeToolPatch({ id: 'live-edit', name: 'Edit', status: 'done',
      args: { file_path: 'src/App.ts', old_string: 'old', new_string: 'new' } }) +
      encodeToolPatch({ id: 'failed-edit', name: 'Edit', status: 'error', fileChanges: [{ path: 'bad.ts', added: 99, deleted: 99 }] })), id: 'live' };
    const result = collectSessionFileChanges([
      { ...message('saved'), fileChanges: { source: 'agent', rootPath: 'E:/Game',
        files: [{ path: 'src/App.ts' }, { path: 'image.png', binary: true }] } },
      { ...message('local receipt'), localOnly: true, fileChanges: { source: 'agent',
        files: [{ path: 'unrelated.ts', added: 99, deleted: 99 }] } },
      { id: 'user', role: 'user', createdAt: 2, text: 'next turn' }, live,
    ], 'E:/Game');
    expect(result?.files).toHaveLength(2);
    expect(result?.files[0]).toMatchObject({ added: undefined, deleted: undefined });
    expect(result?.files[1]).toMatchObject({ binary: true });
    expect(collectSessionFileChanges([{ id: 'chat', role: 'user', text: 'hello', createdAt: 1 }])).toBeUndefined();
  });

  it('aggregates saved turns without counting their native events twice', () => {
    const first = message(encodeToolPatch({ id: 'edit', name: 'Edit', status: 'done',
      fileChanges: [{ path: 'src/App.ts', added: 3, deleted: 2 }] }));
    first.fileChanges = { source: 'agent', rootPath: 'E:/Game',
      files: [{ path: 'src/App.ts', added: 3, deleted: 2 }] };
    const second = { ...message('saved shell changes'), id: 'second', fileChanges: {
      source: 'snapshot' as const, rootPath: 'E:/Game',
      files: [{ path: 'E:\\Game\\src\\app.ts', added: 5, deleted: 1 },
        { path: 'readme.md', added: 2, deleted: 0 }],
    } };
    const result = collectSessionFileChanges([
      { id: 'u1', role: 'user', text: 'first', createdAt: 1 }, first,
      { id: 'u2', role: 'user', text: 'second', createdAt: 2 }, second,
    ], 'E:/Game');
    expect(result?.files).toHaveLength(2);
    expect(result?.files[0]).toMatchObject({ added: 8, deleted: 3 });
    expect(result?.files[1]).toMatchObject({ added: 2, deleted: 0 });
  });

  it('uses native metadata for Codex/DSH and reserves snapshots for other runtimes', () => {
    expect(supportsNativeFileChanges('codex')).toBe(true);
    expect(supportsNativeFileChanges('deepseek-harness')).toBe(true);
    expect(supportsNativeFileChanges('grok')).toBe(false);
  });
  it('reuses Codex app-server fileChange events and their native diffs', () => {
    const changes = collectTurnFileChanges([message(encodeToolPatch({ id: 'cx', name: 'fileChange', status: 'done',
      args: { changes: [{ path: 'src/app.ts', kind: { type: 'add' },
        diff: '--- /dev/null\n+++ b/src/app.ts\n@@ -0,0 +1,2 @@\n+hello\n+world' }] } }))], snapshot);
    expect(changes?.source).toBe('agent');
    expect(changes?.files).toEqual([{ path: 'src/app.ts', status: 'added', added: 2, deleted: 0 }]);
  });

  it('keeps DSH counts captured before arguments were clipped', () => {
    const changes = collectTurnFileChanges([message(encodeToolPatch({ id: 'dsh', name: 'edit', status: 'done',
      args: { file_path: 'E:/Game/app.ts', old_string: 'old…（已截断）', new_string: 'new…（已截断）' },
      fileChanges: [{ path: 'E:/Game/app.ts', added: 150, deleted: 120 }] }))]);
    expect(changes?.files[0]).toMatchObject({ added: 150, deleted: 120 });
  });

  it('excludes unchanged context lines from native replacement counts', () => {
    const changes = collectTurnFileChanges([message(encodeToolPatch({ id: 'edit', name: 'Edit', status: 'done',
      args: { file_path: 'app.ts', old_string: 'keep\nold\ncontext\ntail\n',
        new_string: 'keep\nnew\ncontext\nextra\ntail\n' } }))]);
    expect(changes?.files[0]).toMatchObject({ added: 2, deleted: 1 });
  });

  it('does not report failed or unfinished edits as successful native writes', () => {
    const text = encodeToolPatch({ id: 'bad', name: 'Edit', status: 'error', args: { file_path: 'bad.ts' } }) +
      encodeToolPatch({ id: 'live', name: 'Write', status: 'running', args: { file_path: 'unfinished.ts' } });
    expect(collectTurnFileChanges([message(text)])).toBeUndefined();
  });

  it('falls back to a per-turn snapshot when tools do not supply file changes', () => {
    const changes = collectTurnFileChanges([message(encodeToolPatch({ id: 'shell', name: 'Bash', status: 'done',
      args: { command: 'write-file' } }))], snapshot);
    expect(changes?.source).toBe('snapshot');
    expect(changes?.files[0]).toMatchObject({ path: 'src/fallback.ts', added: 1, deleted: 1 });
  });

  it('deduplicates absolute and relative Windows paths', () => {
    const text = encodeToolPatch({ id: 'a', name: 'Edit', status: 'done', args: {
      file_path: 'E:\\Game\\src\\App.ts', old_string: 'old', new_string: 'new' } }) +
      encodeToolPatch({ id: 'b', name: 'Edit', status: 'done', args: {
        file_path: 'src/app.ts', old_string: 'old', new_string: 'new' } });
    expect(collectTurnFileChanges([message(text)], null, 'E:/Game')?.files).toHaveLength(1);
  });

  it('persists the fallback summary and restores it into session files', () => {
    const saved = JSON.parse(JSON.stringify({ ...message('done'), fileChanges:
      collectTurnFileChanges([], snapshot) })) as Message;
    expect(extractSessionFiles([saved])).toEqual([expect.objectContaining({ path: 'src/fallback.ts', action: 'edited' })]);
  });

  it('does not show a summary for pure chat', () => {
    expect(collectTurnFileChanges([message('Hello')])).toBeUndefined();
  });

  it('extracts apply_patch paths from raw native arguments', () => {
    const changes = collectTurnFileChanges([message(encodeToolPatch({ id: 'p', name: 'apply_patch', status: 'done',
      args: '*** Begin Patch\n*** Add File: config\n+hello\n*** End Patch' }))]);
    expect(changes?.files[0].path).toBe('config');
  });
});
