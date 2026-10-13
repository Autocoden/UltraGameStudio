// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const launcher = fileURLToPath(new URL('../../run.bat', import.meta.url));
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Windows batch launcher failure status', () => {
  it('returns failure when run-only mode has no executable', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'ugs-launcher-'));
    roots.push(root);
    await writeFile(join(root, 'run.bat'), await readFile(launcher));
    // No executable or build inputs exist here; this cannot launch or close a real app.
    const child = spawnSync(process.env.ComSpec || 'cmd.exe', [
      '/d', '/c', 'call run.bat /run <nul',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (child.error) throw child.error;
    const output = `${child.stdout}${child.stderr}`;
    const expectedPath = ['app', 'src-tauri', 'target', 'release', 'UltraGameStudio.exe'].join(String.fromCharCode(92));
    expect(output).toContain(`[X] exe not found: ${expectedPath}`);
    expect(output).not.toContain('is not recognized');
    expect(child.status, output).toBe(1);
    expect(output).not.toContain('[OK] launched');
  });
});
