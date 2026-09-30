import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginManifestFromDir } from '../plugins/core/manifest.js';
import { loadPluginNodes } from '../graph-kinds/plugin-nodes.js';
import { listNodeKinds, unregisterPluginNodeKind, getNodeKindRegistration } from '../graph-kinds/registry.js';
import { buildRunSkill } from './deps-bridge.js';
import { parseSkillMd } from '../skills/runner.js';
import { executePluginKindNode } from './plugin-kind-node.js';
import type { WorkflowDeps } from './types.js';

// 🅕 K3 실물(09-30): 공식 팩 `elanous-hwp` 의 `from-md` 노드가 `unknown skill 'hwp-write'` 로 죽었다 —
// 실행기가 설치자 HOME(`~/.claude/skills`)만 보고 팩 안 `skills/` 를 안 봤다. 실물 팩을 설치 자리에 두고 잰다.
const repo = join(import.meta.dir, '../..');
const originalStateDir = process.env.ELANOUS_STATE_DIR;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
});

function installRealHwpPack(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-skill-root-'));
  const version = (JSON.parse(readFileSync(join(repo, 'packs', 'elanous-hwp', 'plugin.json'), 'utf8')) as { version: string }).version;
  const path = join(root, 'plugins', 'official', 'elanous-hwp', version);
  mkdirSync(path, { recursive: true });
  cpSync(join(repo, 'packs', 'elanous-hwp'), path, { recursive: true });
  process.env.ELANOUS_STATE_DIR = root;
  const manifest = loadPluginManifestFromDir(path, { id: 'elanous-hwp' }).manifest;
  const before = new Set(listNodeKinds().filter((entry) => entry.plugin === manifest.id).map((entry) => `${entry.graph}:${entry.kind}`));
  loadPluginNodes(path, manifest);
  const added = listNodeKinds().filter((entry) => entry.plugin === manifest.id && !before.has(`${entry.graph}:${entry.kind}`));
  cleanups.push(() => {
    for (const entry of added) {
      const registered = getNodeKindRegistration(entry.graph, entry.kind);
      if (registered) unregisterPluginNodeKind(entry.graph, entry.kind, manifest.id, registered);
    }
    rmSync(root, { recursive: true, force: true });
  });
  return path;
}

test('a plugin skill node looks up the skill in the installed plugin skills/ before the user skills dir', async () => {
  const path = installRealHwpPack();
  const kind = listNodeKinds().find((entry) => entry.plugin === 'elanous-hwp' && entry.graph === 'workflow' && entry.kind.endsWith('from-md'))!.kind;
  const seen: Array<{ slug: string; skillsDir?: string }> = [];
  const deps: WorkflowDeps = { runSkill: async (slug, _args, opts) => { seen.push({ slug, skillsDir: opts?.skillsDir }); return 'ok'; } } as WorkflowDeps;
  const result = await executePluginKindNode({ id: 'n1', kind, inputs: { markdown: '# 주간 보고\n- 한 줄', template: 'report' } } as never, { arguments: '', outputs: {} } as never, deps);
  expect(result.ok).toBe(true);
  expect(seen).toEqual([{ slug: 'hwp-write', skillsDir: join(path, 'skills') }]);
  expect(parseSkillMd('hwp-write', join(path, 'skills'))?.name).toBe('hwp-write');
});

test('the runSkill bridge resolves a skill from the given skills dir and names it in the error when absent', async () => {
  const path = installRealHwpPack();
  const run = buildRunSkill();
  await expect(run('no-such-skill-xyz', '', { skillsDir: join(path, 'skills') })).rejects.toThrow(`${join(path, 'skills')}, then `);
});
