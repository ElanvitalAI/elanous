import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPrompt, connectSkillRoot, findSkillFolders, planConnect, withConnectedSource, withoutSources } from './connect.js';
import { buildUserConfig, defaultSkillDirs, saveUserConfig } from '../user-config.js';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function homeWith(agentDir: string, names: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'en9-'));
  homes.push(home);
  for (const name of names) {
    mkdirSync(join(home, agentDir, 'skills', name), { recursive: true });
    writeFileSync(join(home, agentDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  }
  return home;
}

describe('EN9 connect — find skills another agent already uses and register them in place', () => {
  test('codex skills not yet read → new, with the count and the question', () => {
    const home = homeWith('.codex', ['alpha', 'beta', '.system']);
    mkdirSync(join(home, '.codex', 'skills', 'no-skill-md'));
    const plan = planConnect('codex', [], home);
    expect(plan).toEqual({ agent: 'codex', root: join(home, '.codex', 'skills'), state: 'new', skills: ['alpha', 'beta'] });
    const prompt = connectPrompt(plan);
    expect(prompt).toContain('쓰던 스킬 2개를 찾았습니다');
    expect(prompt).toContain('복사하지 않고');
    expect(prompt).toContain('가져올까요?');
  });

  test('a folder elanous already reads → already (nothing to ask)', () => {
    const home = homeWith('.claude', ['one']);
    const plan = planConnect('claude', [connectSkillRoot('claude', home)], home);
    expect(plan.state).toBe('already');
    expect(connectPrompt(plan)).toContain('이미 연결돼 있습니다');
  });

  test('missing or empty folder → says so instead of asking', () => {
    const home = homeWith('.claude', []);
    expect(planConnect('codex', [], home).state).toBe('missing');
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
    expect(planConnect('codex', [], home).state).toBe('empty');
    expect(findSkillFolders(join(home, 'nope'))).toEqual([]);
  });

  test('withConnectedSource adds once; withoutSources removes by path', () => {
    const one = withConnectedSource(undefined, '/h/.codex/skills');
    expect(one).toEqual([{ id: 'codex', path: '/h/.codex/skills', kind: 'connected', enabled: true }]);
    expect(withConnectedSource(one, '/h/.codex/skills')).toEqual(one);
    expect(withoutSources(one, ['/h/.codex/skills'])).toEqual([]);
  });

  test('a connected root joins the skill dirs after the active set, and survives a save → load round trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'en9-cfg-'));
    homes.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ skills: { activeSet: 'claudecode' } }));
    const before = buildUserConfig(path);
    expect(before.skills.sources).toBeUndefined();
    saveUserConfig({ ...before, skills: { ...before.skills, sources: withConnectedSource(undefined, '/x/.codex/skills') } }, path);
    const after = buildUserConfig(path);
    expect(after.skills.sources).toEqual([{ id: 'codex', path: '/x/.codex/skills', kind: 'connected', enabled: true }]);
    const dirs = defaultSkillDirs(after, { bundledSkillsRoot: '/nonexistent-bundle' });
    expect(dirs.indexOf('/x/.codex/skills')).toBeGreaterThan(0);
    expect(defaultSkillDirs(before, { bundledSkillsRoot: '/nonexistent-bundle' })).not.toContain('/x/.codex/skills');
  });
});
