import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir';
import { resetUserConfig, getUserConfig, saveUserConfig } from '../../user-config';
import { SKILL_PRESETS } from '../../onboarding';
import { handleObsidianSet, handleObsidianSkillsGet, handleSkillsSet } from './setup-obsidian-skills';
import { resolveObsidianRoot, _resetObsidianCacheForTests } from '../../acp/fs-roots';
import { startNexusHttpServer } from './http-server';
import { createNexusState } from '../state/state';
import { TabRegistry } from '../state/tab-registry';
import { NexusEventBus } from './event-bus';

let root: string;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let vault: string;
let skillDir: string;
const post = (route: string, body: unknown) => new Request(`http://localhost/v1/setup/${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const disk = () => JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
  obsidian?: { vault: string }; skills?: { activeSet: string; dirs: string[]; urlRouting: unknown; devRequestRouting: unknown };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-obsidian-skills-'));
  vault = join(root, 'vault'); skillDir = join(root, 'skills');
  mkdirSync(vault); mkdirSync(skillDir);
  delete process.env.XDG_CONFIG_HOME;
  setElanousConfigDir(root);
  resetUserConfig();
  writeFileSync(join(root, 'config.json'), '{}');
});
afterEach(() => {
  resetElanousConfigDir(); resetUserConfig();
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  rmSync(root, { recursive: true, force: true });
});

describe('Obsidian and skills setup', () => {
  test('GET reports current state and TUI preset source, including existing directories', async () => {
    saveUserConfig({ ...getUserConfig(), obsidian: { vault }, skills: { ...getUserConfig().skills, dirs: [skillDir] } });
    const body = await handleObsidianSkillsGet().json();
    expect(body.obsidian).toEqual({ vault, exists: true, looksLikeVault: false });
    expect(body.skills.dirs).toEqual([skillDir]);
    expect(body.skills.activeSet).toBe(getUserConfig().skills.activeSet);
    expect(body.skills.presets).toEqual(SKILL_PRESETS.map(({ key, label, dir }) => ({
      key, label, dir, exists: dir !== null && (() => { try { return statSync(dir).isDirectory(); } catch { return false; } })(),
    })));
    mkdirSync(join(vault, '.obsidian'));
    expect((await handleObsidianSkillsGet().json()).obsidian.looksLikeVault).toBe(true);
  });

  test('POST obsidian saves existing directory and warns without .obsidian', async () => {
    const res = await handleObsidianSet(post('obsidian', { vault }));
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toContain('.obsidian');
    expect(disk().obsidian?.vault).toBe(vault);
    mkdirSync(join(vault, '.obsidian'));
    expect((await (await handleObsidianSet(post('obsidian', { vault }))).json()).warning).toBeUndefined();
  });

  test('POST obsidian 은 도는 데몬의 볼트 해석도 바꾼다 — 캐시에 옛 볼트가 남지 않는다', async () => {
    const env = { a: process.env.OBSIDIAN_VAULT, b: process.env.ELANOUS_OBSIDIAN_VAULT };
    delete process.env.OBSIDIAN_VAULT; delete process.env.ELANOUS_OBSIDIAN_VAULT;
    try {
      const other = join(root, 'other'); mkdirSync(join(other, '.obsidian'), { recursive: true });
      mkdirSync(join(vault, '.obsidian'));
      saveUserConfig({ ...getUserConfig(), obsidian: { ...getUserConfig().obsidian, vault } });
      _resetObsidianCacheForTests();
      expect(resolveObsidianRoot().root).toBe(vault);   // 캐시에 앉는다
      expect((await handleObsidianSet(post('obsidian', { vault: other }))).status).toBe(200);
      expect(resolveObsidianRoot().root).toBe(other);
    } finally {
      _resetObsidianCacheForTests();
      if (env.a !== undefined) process.env.OBSIDIAN_VAULT = env.a;
      if (env.b !== undefined) process.env.ELANOUS_OBSIDIAN_VAULT = env.b;
    }
  });

  test('malformed JSON and ambiguous skills selection return 400 without a config write', async () => {
    const before = readFileSync(join(root, 'config.json'), 'utf8');
    for (const route of ['obsidian', 'skills']) {
      const req = new Request(`http://localhost/v1/setup/${route}`, { method: 'POST', body: '{broken' });
      const res = route === 'obsidian' ? await handleObsidianSet(req) : await handleSkillsSet(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid-json');
    }
    expect((await handleSkillsSet(post('skills', { activeSet: 'codex', dirs: [skillDir] }))).status).toBe(400);
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(before);
  });

  test('POST obsidian rejects missing, relative, and file paths without modifying vault', async () => {
    saveUserConfig({ ...getUserConfig(), obsidian: { vault } });
    const original = disk().obsidian?.vault;
    const file = join(root, 'file'); writeFileSync(file, 'x');
    for (const invalid of [join(root, 'absent'), 'relative', file, '']) {
      const res = await handleObsidianSet(post('obsidian', { vault: invalid }));
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBeTruthy();
      expect(disk().obsidian?.vault).toBe(original);
    }
    expect((await handleObsidianSet(post('obsidian', { vault: 1 }))).status).toBe(400);
  });

  test('POST skills custom dirs preserves routing and unrelated fields', async () => {
    const cfg = getUserConfig();
    const urlRouting = { ...cfg.skills.urlRouting, enabled: false };
    const devRequestRouting = { ...cfg.skills.devRequestRouting, enabled: false };
    saveUserConfig({ ...cfg, skills: { ...cfg.skills, urlRouting, devRequestRouting, allow: ['wanted'] } });
    expect(disk().skills?.urlRouting).toMatchObject(urlRouting);
    const res = await handleSkillsSet(post('skills', { dirs: [skillDir] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skills: { activeSet: 'custom', dirs: [skillDir] } });
    expect(disk().skills).toMatchObject({ activeSet: 'custom', dirs: [skillDir], urlRouting, devRequestRouting, allow: ['wanted'] });
  });

  test('HTTP GET and POST dispatch use existing bearer authentication', async () => {
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const server = startNexusHttpServer({
      state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
      metaApi: { bearerToken: 'temporary-test-token' },
      startPort: 44000 + Math.floor(Math.random() * 1000), portRange: 5,
      portProbe: () => 'available',
    });
    const authorized = { authorization: 'Bearer temporary-test-token' };
    try {
      const url = `${server.url}/v1/setup`;
      const unauth = await fetch(`${url}/obsidian`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault }) });
      expect(unauth.status).toBe(401);
      expect(disk().obsidian?.vault).not.toBe(vault);
      expect((await fetch(`${url}/obsidian-skills`)).status).toBe(401);
      expect((await fetch(`${url}/skills`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dirs: [skillDir] }) })).status).toBe(401);
      expect(disk().skills?.dirs).not.toEqual([skillDir]);
      const list = await fetch(`${url}/obsidian-skills`, { headers: authorized });
      expect(list.status).toBe(200);
      expect((await list.json()).skills.presets.length).toBe(SKILL_PRESETS.length);
      const obsidian = await fetch(`${url}/obsidian`, { method: 'POST', headers: { ...authorized, 'content-type': 'application/json' }, body: JSON.stringify({ vault }) });
      expect(obsidian.status).toBe(200);
      expect(disk().obsidian?.vault).toBe(vault);
      const skills = await fetch(`${url}/skills`, { method: 'POST', headers: { ...authorized, 'content-type': 'application/json' }, body: JSON.stringify({ dirs: [skillDir] }) });
      expect(skills.status).toBe(200);
      expect(disk().skills?.dirs).toEqual([skillDir]);
      const invalid = await fetch(`${url}/obsidian`, { method: 'POST', headers: { ...authorized, 'content-type': 'application/json' }, body: JSON.stringify({ vault: join(root, 'missing') }) });
      expect(invalid.status).toBe(400);
      expect(disk().obsidian?.vault).toBe(vault);
    } finally { server.stop(); }
  });

  test('POST skills preset uses TUI preset directory; invalid paths do not persist', async () => {
    const preset = SKILL_PRESETS.find((item) => item.dir);
    expect(preset).toBeDefined();
    const dir = preset!.dir!;
    const previous = disk().skills;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      expect((await handleSkillsSet(post('skills', { activeSet: preset!.key }))).status).toBe(400);
      expect(disk().skills).toEqual(previous);
    } else {
      const res = await handleSkillsSet(post('skills', { activeSet: preset!.key }));
      expect(res.status).toBe(200);
      expect(disk().skills?.dirs).toEqual([dir]);
    }
    const file = join(root, 'file'); writeFileSync(file, 'x');
    const clear = await handleSkillsSet(post('skills', { dirs: [] }));
    expect(clear.status).toBe(200);
    expect(disk().skills).toMatchObject({ activeSet: 'custom', dirs: [] });
    const before = disk().skills;
    for (const body of [{ dirs: [skillDir, join(root, 'absent')] }, { dirs: ['relative'] }, { dirs: [file] }, { activeSet: 'unknown' }]) {
      expect((await handleSkillsSet(post('skills', body))).status).toBe(400);
      expect(disk().skills).toEqual(before);
    }
  });
});
