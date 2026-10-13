import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaceSkills } from '../src/workspace-skills.mjs';

async function makeWorkspace() {
  return mkdtemp(join(tmpdir(), 'ugs-workspace-skills-'));
}

test('scans project skills/ dir and per-agent skill dirs', async () => {
  const dir = await makeWorkspace();
  try {
    // root skills/<name>/SKILL.md
    await mkdir(join(dir, 'skills', 'level-builder'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'level-builder', 'SKILL.md'),
      '---\nname: Level Builder\ndescription: Generate tilemap levels.\n---\n# Level Builder\n',
    );
    // .claude/skills/<name>/SKILL.md
    await mkdir(join(dir, '.claude', 'skills', 'rigging'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'skills', 'rigging', 'SKILL.md'),
      '---\nname: Auto Rig\n---\n',
    );
    // .codex/commands/<name>.md
    await mkdir(join(dir, '.codex', 'commands'), { recursive: true });
    await writeFile(
      join(dir, '.codex', 'commands', 'deploy.md'),
      '---\nname: Deploy\ndescription: Ship a build.\n---\n',
    );

    const snapshot = await listWorkspaceSkills({ dir });
    assert.equal(snapshot.ready, true);
    const names = snapshot.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['/auto-rig', '/deploy', '/level-builder']);

    const levelBuilder = snapshot.entries.find((e) => e.name === '/level-builder');
    assert.equal(levelBuilder.kind, 'skill');
    assert.equal(levelBuilder.label['zh-CN'], 'Level Builder');
    assert.match(levelBuilder.insertText['zh-CN'], /tilemap levels/);

    const deploy = snapshot.entries.find((e) => e.name === '/deploy');
    assert.equal(deploy.kind, 'command');
    assert.equal(deploy.sourceAdapter, 'codex');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ignores host-level config outside the project and dedupes', async () => {
  const dir = await makeWorkspace();
  try {
    await mkdir(join(dir, 'skills', 'a'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'a', 'SKILL.md'),
      '---\nname: Dup\n---\n',
    );
    // Same slash name under a different agent dir → deduped.
    await mkdir(join(dir, '.gemini', 'skills', 'b'), { recursive: true });
    await writeFile(
      join(dir, '.gemini', 'skills', 'b', 'SKILL.md'),
      '---\nname: Dup\n---\n',
    );

    const snapshot = await listWorkspaceSkills({ dir });
    const dups = snapshot.entries.filter((e) => e.name === '/dup');
    assert.equal(dups.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy slash scanning includes managed skills and propagates stable identity plus changed revision', async () => {
  const dir = await makeWorkspace();
  try {
    await mkdir(join(dir, '.ultragamestudio', 'skills', 'managed-check'), { recursive: true });
    const path = join(dir, '.ultragamestudio', 'skills', 'managed-check', 'SKILL.md');
    await writeFile(path, '---\nname: managed-check\ndescription: "Use when a YAML colon: appears."\n---\n# Managed\n');
    const first = await listWorkspaceSkills({ dir, hostId: 'ugs-remote-runner', workspaceId: 'p' });
    const entry = first.entries.find((e) => e.name === '/managed-check');
    assert.ok(entry);
    assert.match(entry.skillId, /^skill:/);
    assert.match(entry.revision, /^[a-f0-9]{64}$/);
    assert.equal(entry.detail['en-US'], 'Use when a YAML colon: appears.');
    await writeFile(path, '---\nname: managed-check\ndescription: Use when changed text must remain visible.\n---\n# Managed\n');
    const changed = (await listWorkspaceSkills({ dir, hostId: 'ugs-remote-runner', workspaceId: 'p' })).entries.find((e) => e.name === '/managed-check');
    assert.equal(changed.id, entry.id);
    assert.equal(changed.skillId, entry.skillId);
    assert.notEqual(changed.revision, entry.revision);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('returns empty snapshot for missing dir', async () => {
  const snapshot = await listWorkspaceSkills({ dir: join(tmpdir(), 'does-not-exist-ugs') });
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.entries, []);
});
