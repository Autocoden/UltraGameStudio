// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const helper = fileURLToPath(new URL('./needs-rebuild.ps1', import.meta.url));
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'ugs-rebuild-'));
  roots.push(root);
  await mkdir(join(root, 'app', 'src'), { recursive: true });
  const exe = join(root, 'UltraGameStudio.exe');
  const source = join(root, 'app', 'src', 'main.ts');
  await writeFile(exe, 'isolated executable fixture; never launched');
  await writeFile(source, 'export const value = 1;\n');
  await utimes(exe, new Date('2020-01-01'), new Date('2020-01-01'));
  await utimes(source, new Date('2030-01-01'), new Date('2030-01-01'));
  return { root, exe, source };
}
function run(root: string, exe: string, stamp = false) {
  const child = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-ExePath', exe, '-Root', root, ...(stamp ? ['-WriteStamp'] : []),
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (child.error) throw child.error;
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

describe.skipIf(process.platform !== 'win32')('Windows launcher rebuild fingerprint', () => {
  it('persists source content fingerprints instead of relying on mtimes', async () => {
    const { root, exe, source } = await fixture();
    const stamped = run(root, exe, true);
    expect(stamped.status, stamped.output).toBe(0);
    expect(run(root, exe).status).toBe(0);
    const saved = JSON.parse(await readFile(`${exe}.sources.json`, 'utf8'));
    expect(saved.version).toBe(1);
    await utimes(source, new Date('2035-01-01'), new Date('2035-01-01'));
    expect(run(root, exe).status).toBe(0);
    await writeFile(source, 'export const value = 2;\n');
    await utimes(source, new Date('2010-01-01'), new Date('2010-01-01'));
    expect(run(root, exe).status).toBe(1);
    await writeFile(source, 'export const value = 1;\n');
    expect(run(root, exe).status).toBe(0);
  }, 30_000);

  it('detects shared protocol and Rust build-script content changes', async () => {
    const { root, exe } = await fixture();
    const protocol = join(root, 'packages', 'protocol', 'index.ts');
    const buildScript = join(root, 'app', 'src-tauri', 'build.rs');
    await mkdir(join(root, 'packages', 'protocol'), { recursive: true });
    await mkdir(join(root, 'app', 'src-tauri'), { recursive: true });
    await writeFile(protocol, 'export const protocolVersion = 1;\n');
    await writeFile(buildScript, 'fn main() {}\n');
    expect(run(root, exe, true).status).toBe(0);
    await writeFile(protocol, 'export const protocolVersion = 2;\n');
    await utimes(protocol, new Date('2010-01-01'), new Date('2010-01-01'));
    expect(run(root, exe).status).toBe(1);
    expect(run(root, exe, true).status).toBe(0);
    await writeFile(buildScript, 'fn main() { tauri_build::build(); }\n');
    await utimes(buildScript, new Date('2010-01-01'), new Date('2010-01-01'));
    expect(run(root, exe).status).toBe(1);
  }, 30_000);

  it('tracks the backend skill service bundled into the shipped CLI', async () => {
    const { root, exe } = await fixture();
    const service = join(root, 'backend', 'src', 'workspace-skill-service.mjs');
    await mkdir(join(root, 'backend', 'src'), { recursive: true });
    await writeFile(service, 'export const serviceVersion = 1;\n');
    expect(run(root, exe, true).status).toBe(0);
    await writeFile(service, 'export const serviceVersion = 2;\n');
    await utimes(service, new Date('2010-01-01'), new Date('2010-01-01'));
    expect(run(root, exe).status).toBe(1);
  }, 30_000);
});
