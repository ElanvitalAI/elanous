// EN5 — one source model: every reader goes through resolveSkillSources(), and an old config resolves to the old list.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, defaultSkillDirs, resolveSkillSources, saveUserConfig, skillSetDir, skillSourceId, type UserConfig } from './user-config.js';
import { checkSetupStatus } from './nexus/setup-status.js';
import { USER_CONFIG_VERSION } from './nexus/config/types.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }

/** The pre-EN5 algorithm (preset → shared → connected), kept verbatim as the regression oracle. */
function legacyDirs(cfg: UserConfig, sharedHome: string, connected: string[] = []): string[] {
  let base = [skillSetDir('claudecode')!];
  const sk = cfg.skills;
  if (sk.activeSet !== 'custom') {
    const d = skillSetDir(sk.activeSet);
    if (d) base = [d];
    else if (sk.dirs.length > 0) base = [...sk.dirs];
  } else if (sk.dirs.length > 0) base = [...sk.dirs];
  const shared = join(sharedHome, '.agents', 'skills');
  if (sk.includeSharedAgentSkills !== false) {
    try { if (statSync(shared).isDirectory() && !base.includes(shared)) base.push(shared); } catch { /* absent */ }
  }
  for (const dir of connected) if (!base.includes(dir)) base.push(dir);
  return base;
}

function cfgWith(skills: Record<string, unknown>): UserConfig {
  const dir = temp('en5-cfg-');
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ skills }));
  return buildUserConfig(path);
}

describe('EN5 skills.sources — one model, old configs unchanged', () => {
  const opts = (home: string) => ({ sharedAgentHome: home, bundledSkillsRoot: '/nonexistent-bundle' });

  test('regression: old configs resolve to exactly the old directory list', () => {
    const home = temp('en5-home-');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    const cases: Record<string, unknown>[] = [
      { activeSet: 'claudecode' },
      { activeSet: 'codex' },
      { activeSet: 'custom', dirs: ['/a', '/b'] },
      { activeSet: 'custom', dirs: [] },
      { activeSet: 'claudecode', includeSharedAgentSkills: false },
      { activeSet: 'custom', dirs: [join(home, '.agents', 'skills')] },
    ];
    for (const skills of cases) {
      const cfg = cfgWith(skills);
      expect(defaultSkillDirs(cfg, opts(home))).toEqual(legacyDirs(cfg, home));
    }
  });

  test('the dev-only connected[] key is read into sources and saved back as sources (not connected)', () => {
    const home = temp('en5-home-');
    const cfg = cfgWith({ activeSet: 'claudecode', connected: ['/h/.codex/skills', '/p/demo/skills'] });
    expect(cfg.skills.sources).toEqual([
      { id: 'codex', path: '/h/.codex/skills', kind: 'connected', enabled: true },
      { id: 'plugin:demo', path: '/p/demo/skills', kind: 'connected', enabled: true },
    ]);
    expect(defaultSkillDirs(cfg, opts(home))).toEqual(legacyDirs(cfg, home, ['/h/.codex/skills', '/p/demo/skills']));
    const out = join(temp('en5-save-'), 'config.json');
    saveUserConfig(cfg, out);
    const disk = JSON.parse(readFileSync(out, 'utf8')).skills;
    expect(disk.connected).toBeUndefined();
    expect(disk.sources).toEqual([{ id: 'codex', path: '/h/.codex/skills', enabled: true }, { id: 'plugin:demo', path: '/p/demo/skills', enabled: true }]);
    expect(disk.activeSet).toBe('claudecode'); // the preset keys stay on disk — older builds still read them
  });

  test('a disabled source is listed but not read; kinds come out in order', () => {
    const home = temp('en5-home-');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    const cfg = cfgWith({ activeSet: 'custom', dirs: ['/a'], sources: [{ id: 'codex', path: '/h/.codex/skills', enabled: false }, { path: '/p/x/skills' }] });
    expect(resolveSkillSources(cfg, opts(home)).map((s) => [s.kind, s.id, s.enabled])).toEqual([
      ['preset', 'custom', true], ['shared', 'agents', true], ['connected', 'codex', false], ['connected', 'plugin:x', true],
    ]);
    expect(defaultSkillDirs(cfg, opts(home))).toEqual(['/a', join(home, '.agents', 'skills'), '/p/x/skills']);
  });

  test('setup checklist reads the same list as the loader (preset from activeSet, plus connected)', () => {
    const cfg = cfgWith({ activeSet: 'codex', dirs: [], sources: [{ path: '/p/x/skills' }] });
    cfg.llm = { provider: 'local', baseUrl: 'http://localhost:11434/v1' };
    const seen: string[] = [];
    const result = checkSetupStatus({ cfg, nexusCfg: { version: USER_CONFIG_VERSION, global: {}, tabs: {} }, pwaBuilt: true, exists: (p) => { seen.push(p); return p === skillSetDir('codex'); } });
    expect(result.recommended.find((item) => item.id === 'skill-dirs')).toMatchObject({ passed: true, detail: `2 dirs · 1 exist · missing: /p/x/skills` });
  });

  test('ids: agent roots by name, other folders by their (plugin) name', () => {
    expect(skillSourceId('/u/.claude/skills')).toBe('claude');
    expect(skillSourceId('/u/.codex/skills/')).toBe('codex');
    expect(skillSourceId('/x/antv/skills')).toBe('plugin:antv');
    expect(skillSourceId('/x/my-skills')).toBe('plugin:my-skills');
  });
});
