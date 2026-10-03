// PLAN-codex-app-server-hermes-parity §5 Phase H1·5a test —
// dispatchElanousSkillsList enumeration + filter + SKILL.md first-line
// + failure modes. Uses an isolated tmp `skillsDir` so the test never
// touches the real ~/.elanous/skills.

import { setDefaultTimeout, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchElanousSkillsList,
  elanousSkillsListRuntime,
  buildElanousSkillsListTool,
} from './elanous-skills-list-runtime.js';
import { defaultSkillDirs, resetUserConfig } from '../user-config.js';
import { SKILLS_LIST_DESCRIPTION } from '../onboarding/entry-hints.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

let workdir: string;
let skillsDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'elanous-skills-test-'));
  skillsDir = join(workdir, 'skills');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('dispatchElanousSkillsList · enumeration', () => {
  test('empty when the directory does not exist', async () => {
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries).toEqual([]);
    expect(r.error).toBeTruthy();
    expect(r.output).toContain('failed to enumerate');
  });

  test('empty when the directory exists but has no entries', async () => {
    mkdirSync(skillsDir);
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries).toEqual([]);
    expect(r.error).toBeUndefined();
    expect(r.output).toBe(`0 skill(s) under ${skillsDir}`);
  });

  test('blank description when SKILL.md absent', async () => {
    mkdirSync(skillsDir);
    mkdirSync(join(skillsDir, 'foo-skill'));
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries).toEqual([{ name: 'foo-skill', description: '' }]);
  });

  test('extracts first non-heading line from SKILL.md', async () => {
    mkdirSync(skillsDir);
    mkdirSync(join(skillsDir, 'foo-skill'));
    writeFileSync(
      join(skillsDir, 'foo-skill', 'SKILL.md'),
      '# Heading\n# Another heading\n\nThe foo skill does foo things.\nSecond line ignored.\n',
    );
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries).toEqual([
      { name: 'foo-skill', description: 'The foo skill does foo things.' },
    ]);
  });

  test('caps description at 80 chars', async () => {
    mkdirSync(skillsDir);
    mkdirSync(join(skillsDir, 'big'));
    const long = 'x'.repeat(200);
    writeFileSync(join(skillsDir, 'big', 'SKILL.md'), long);
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries[0]!.description.length).toBe(80);
  });

  test('skips regular files (not directories)', async () => {
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, 'not-a-skill.txt'), 'noop');
    mkdirSync(join(skillsDir, 'real-skill'));
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries.map((e) => e.name)).toEqual(['real-skill']);
  });

  test('sorts entries alphabetically', async () => {
    mkdirSync(skillsDir);
    mkdirSync(join(skillsDir, 'zeta'));
    mkdirSync(join(skillsDir, 'alpha'));
    mkdirSync(join(skillsDir, 'mid'));
    const r = await dispatchElanousSkillsList({}, { skillsDir });
    expect(r.entries.map((e) => e.name)).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('dispatchElanousSkillsList · query filter', () => {
  beforeEach(() => {
    mkdirSync(skillsDir);
    mkdirSync(join(skillsDir, 'omni-llm'));
    mkdirSync(join(skillsDir, 'omni-digest'));
    mkdirSync(join(skillsDir, 'photo-intake-ocr'));
  });

  test('case-insensitive substring match', async () => {
    const r = await dispatchElanousSkillsList({ query: 'OMNI' }, { skillsDir });
    expect(r.entries.map((e) => e.name).sort()).toEqual([
      'omni-digest',
      'omni-llm',
    ]);
  });

  test('empty query returns all', async () => {
    const r = await dispatchElanousSkillsList({ query: '' }, { skillsDir });
    expect(r.entries).toHaveLength(3);
  });

  test('no matches returns []', async () => {
    const r = await dispatchElanousSkillsList({ query: 'no-such-skill' }, { skillsDir });
    expect(r.entries).toEqual([]);
  });
});

// ★ G9 P5b — 다중 루트: config.skills.dirs=[a,b] 면 무인자 호출이 **두 dir 를 모두 열거**(getSkillIndex 와
//   동일 정책). XDG_CONFIG_HOME 격리 config 로 검증(should-fix "[0]만 선택" 해소).
describe('dispatchElanousSkillsList · 다중 루트(user-config skills.dirs)', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    resetUserConfig();
  });

  test('config.skills.dirs=[a,b] → 두 dir 의 skill 을 모두 열거', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'xdg-'));
    const a = mkdtempSync(join(tmpdir(), 'sk-a-'));
    const b = mkdtempSync(join(tmpdir(), 'sk-b-'));
    try {
      mkdirSync(join(a, 'skill-in-a')); writeFileSync(join(a, 'skill-in-a', 'SKILL.md'), 'the A skill\n');
      mkdirSync(join(b, 'skill-in-b')); writeFileSync(join(b, 'skill-in-b', 'SKILL.md'), 'the B skill\n');
      mkdirSync(join(xdg, 'elanous'), { recursive: true });
      writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({ skills: { activeSet: 'custom', dirs: [a, b] } }));
      process.env.XDG_CONFIG_HOME = xdg;
      resetUserConfig();

      expect(defaultSkillDirs().slice(0, 2)).toEqual([a, b]); // config 해석 확인; packaged root follows
      const names = (await dispatchElanousSkillsList({})).entries.map((e) => e.name);
      expect(names).toContain('skill-in-a');
      expect(names).toContain('skill-in-b');
    } finally {
      for (const d of [xdg, a, b]) rmSync(d, { recursive: true, force: true });
    }
  });

  test('★ 기본 root = user-config skill dir·격리 fixture 노출(CI 안전·비-.elanous·정밀 일치)', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'xdg-'));
    const fx = mkdtempSync(join(tmpdir(), 'sk-fx-'));
    try {
      mkdirSync(join(fx, 'fixture-skill')); writeFileSync(join(fx, 'fixture-skill', 'SKILL.md'), 'the fixture skill\n');
      mkdirSync(join(xdg, 'elanous'), { recursive: true });
      writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({ skills: { activeSet: 'custom', dirs: [fx] } }));
      process.env.XDG_CONFIG_HOME = xdg; resetUserConfig();

      const r = await dispatchElanousSkillsList({});
      expect(r.skillsDir).toBe(defaultSkillDirs()[0]);            // 단일 경로 계약(dirs[0])·정밀 일치
      expect(r.skillsDirs).toEqual(defaultSkillDirs());           // 다중 루트 계약
      expect(r.skillsDir).not.toContain('.elanous/skills');         // 빈 피커 버그 아님
      expect(r.entries.map((e) => e.name)).toContain('fixture-skill'); // 실 skill 노출(격리·CI 안전)
    } finally {
      for (const d of [xdg, fx]) rmSync(d, { recursive: true, force: true });
    }
  });

  test('★ partial-error 표면화 — 일부 root 부재면 error 로 노출(config 은폐 방지)', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'xdg-'));
    const good = mkdtempSync(join(tmpdir(), 'sk-good-'));
    const gone = mkdtempSync(join(tmpdir(), 'sk-gone-'));
    rmSync(gone, { recursive: true, force: true }); // 존재하지 않는 dir
    try {
      mkdirSync(join(good, 'good-skill')); writeFileSync(join(good, 'good-skill', 'SKILL.md'), 'ok\n');
      mkdirSync(join(xdg, 'elanous'), { recursive: true });
      writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({ skills: { activeSet: 'custom', dirs: [good, gone] } }));
      process.env.XDG_CONFIG_HOME = xdg; resetUserConfig();

      const r = await dispatchElanousSkillsList({});
      expect(r.entries.map((e) => e.name)).toContain('good-skill'); // 성공 dir 산출 유지
      expect(r.error).toBeTruthy();                                 // 실패 dir 은 은폐 없이 표면화
    } finally {
      for (const d of [xdg, good]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('dispatchElanousSkillsList · shared HOME discovery', () => {
  test('a pre-existing ~/.agents/skills/x/SKILL.md appears without copying or writing', () => {
    const home = mkdtempSync(join(tmpdir(), 'shared-agent-list-home-'));
    try {
      const shared = join(home, '.agents', 'skills');
      mkdirSync(join(shared, 'x'), { recursive: true });
      writeFileSync(join(shared, 'x', 'SKILL.md'), '# x\nA shared skill.\n');
      const before = readdirSync(shared);
      const childBefore = readdirSync(join(shared, 'x'));
      const script = `import { defaultSkillDirs } from './src/user-config.ts';
        import { dispatchElanousSkillsList } from './src/tool-runtime/elanous-skills-list-runtime.ts';
        console.log(JSON.stringify({ dirs: defaultSkillDirs(), result: await dispatchElanousSkillsList({ query: 'x' }) }));`;
      const child = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home },
        encoding: 'utf8',
      });
      expect(child.status).toBe(0);
      const output = child.stdout.trim().split('\n').at(-1)!;
      const { dirs, result } = JSON.parse(output) as {
        dirs: string[];
        result: { skillsDirs: string[]; entries: Array<{ name: string; description: string }> };
      };
      expect(dirs).toContain(shared);
      expect(result.skillsDirs).toContain(shared);
      expect(result.entries).toContainEqual({ name: 'x', description: 'A shared skill.' });
      expect(readdirSync(shared)).toEqual(before);
      expect(readdirSync(join(shared, 'x'))).toEqual(childBefore);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('earlier custom root wins a duplicate skill name over shared root', () => {
    const home = mkdtempSync(join(tmpdir(), 'shared-agent-priority-home-'));
    try {
      const first = join(home, 'first');
      const shared = join(home, '.agents', 'skills');
      for (const root of [first, shared]) mkdirSync(join(root, 'x'), { recursive: true });
      writeFileSync(join(first, 'x', 'SKILL.md'), 'First version.\n');
      writeFileSync(join(shared, 'x', 'SKILL.md'), 'Shared version.\n');
      const xdg = join(home, 'config');
      mkdirSync(join(xdg, 'elanous'), { recursive: true });
      writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({ skills: { activeSet: 'custom', dirs: [first] } }));
      const script = `import { dispatchElanousSkillsList } from './src/tool-runtime/elanous-skills-list-runtime.ts';
        console.log(JSON.stringify(await dispatchElanousSkillsList({ query: 'x' })));`;
      const child = spawnSync(process.execPath, ['-e', script], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg }, encoding: 'utf8',
      });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {
        skillsDirs: string[]; entries: Array<{ name: string; description: string }>;
      };
      expect(result.skillsDirs.slice(0, 2)).toEqual([first, shared]);
      expect(result.entries.filter((entry) => entry.name === 'x')).toEqual([{ name: 'x', description: 'First version.' }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('elanousSkillsListRuntime · ToolRuntime interface', () => {
  test('exposes id and spec', () => {
    expect(elanousSkillsListRuntime.id).toBe('elanous_skills_list');
    expect(elanousSkillsListRuntime.spec.name).toBe('elanous_skills_list');
    expect(elanousSkillsListRuntime.spec.parameters).toBeDefined();
  });

  test('buildElanousSkillsListTool returns valid LLMToolSpec', () => {
    const spec = buildElanousSkillsListTool();
    expect(spec.name).toBe('elanous_skills_list');
    expect(spec.description).toBe(SKILLS_LIST_DESCRIPTION);
    const params = spec.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
  });

  test('runtime.run defers to dispatchElanousSkillsList', async () => {
    // run() uses the default user-config skill dir(defaultSkillDirs·P5b),
    // which may or may not exist on the test host. Just assert the call
    // succeeds (soft-fail absorbs missing dirs).
    const r = await elanousSkillsListRuntime.run({}, { surface: 'mcp' });
    expect(Array.isArray(r.entries)).toBe(true);
  });

});
