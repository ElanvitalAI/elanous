import { describe, expect, test, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, skillIndexProblems, getSkillIndex, resetSkillIndex } from './index.js';
import { resetUserConfig } from '../user-config.js';

// ★ G9 P5a — defaultSkillDirs 단위검증(user-config.defaultskilldirs.test.ts)과 짝을 이뤄, 실제
//   buildSkillIndex 가 (1) 주어진 dir 를 스캔하고 (2) **무인자 호출 시 user-config 를 따르는** wiring 을 검증.
function writeFixtureSkill(root: string, name: string): void {
  const sd = join(root, name);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture skill ${name} for P5a wiring test\n---\nbody\n`);
}

describe('buildSkillIndex — G9 P5a dir 스캔 wiring(Goodhart 방지)', () => {
  test('명시 dir 를 실제로 스캔해 skill 을 인덱싱한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-fix-'));
    try {
      writeFixtureSkill(root, 'my-fixture-skill');
      const idx = buildSkillIndex([root]);
      expect(idx.some((e) => e.name === 'my-fixture-skill')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('다중 루트 — 두 dir 의 skill 을 모두 인덱싱(user-config skills.dirs 다중 루트 계약)', () => {
    const a = mkdtempSync(join(tmpdir(), 'skill-a-'));
    const b = mkdtempSync(join(tmpdir(), 'skill-b-'));
    try {
      writeFixtureSkill(a, 'skill-alpha');
      writeFixtureSkill(b, 'skill-beta');
      const names = buildSkillIndex([a, b]).map((e) => e.name);
      expect(names).toContain('skill-alpha');
      expect(names).toContain('skill-beta');
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test('부재 dir 는 조용히 빈 결과(fail-soft)', () => {
    // should-fix: 고정 경로 대신 임시 루트를 만들어 즉시 삭제(환경 충돌 회피).
    const gone = mkdtempSync(join(tmpdir(), 'skill-gone-'));
    rmSync(gone, { recursive: true, force: true });
    expect(buildSkillIndex([gone])).toEqual([]);
  });

  test('SKILL.md 가 디렉터리여서 readFileSync 가 던져도 인덱스가 죽지 않는다 (TOCTOU)', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-eisdir-'));
    try {
      writeFixtureSkill(root, 'good-skill');
      const bad = join(root, 'bad-skill');
      mkdirSync(join(bad, 'SKILL.md'), { recursive: true });
      const idx = buildSkillIndex([root]);
      expect(idx.some((e) => e.name === 'good-skill')).toBe(true);
      expect(idx.some((e) => e.name === 'bad-skill')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('SKILL.md 권한 오류는 화면을 튕기지 않고 건너뛰되 반드시 기록한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-eacces-'));
    const skillMd = join(root, 'locked-skill', 'SKILL.md');
    try {
      writeFixtureSkill(root, 'locked-skill');
      chmodSync(skillMd, 0);
      let denied = false;
      try {
        readFileSync(skillMd, 'utf-8');
      } catch {
        denied = true;
      }
      if (denied) {
        expect(() => buildSkillIndex([root])).not.toThrow();
        expect(skillIndexProblems().some((p) => p.name === 'locked-skill' && p.code === 'EACCES')).toBe(true);
      }
    } finally {
      try { chmodSync(skillMd, 0o644); } catch { /* restore for cleanup */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ★ 핵심 계약 회귀 — 무인자 buildSkillIndex() 가 **user-config(skills.dirs)를 실제로 따른다**.
//   XDG_CONFIG_HOME 로 격리 config 를 주입 → 무인자 호출이 그 dir 를 스캔하는지 검증. normalizeBaseDirs 를
//   [LOCAL_SKILLS_DIR] 로 되돌리면 이 테스트가 실패한다(Goodhart 아님).
describe('무인자 buildSkillIndex() — user-config skills.dirs 존중(격리 config)', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    resetUserConfig();
    resetSkillIndex();
  });

  test('config.skills.dirs=[fixture] 이면 무인자 getSkillIndex()(캐시 진입점)가 그 fixture 를 스캔한다', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'xdg-'));
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'cfg-skill-'));
    try {
      writeFixtureSkill(fixtureRoot, 'config-routed-skill');
      mkdirSync(join(xdg, 'elanous'), { recursive: true });
      writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({ skills: { activeSet: 'custom', dirs: [fixtureRoot] } }));

      process.env.XDG_CONFIG_HOME = xdg;
      resetUserConfig();
      resetSkillIndex();

      // 무인자 getSkillIndex — normalizeBaseDirs(undefined) → defaultSkillDirs() → config.skills.dirs.
      //   실 소비자 진입점(캐시 dir-키). buildSkillIndex 도 같은 dir 를 봐야 함(교차 확인).
      expect(getSkillIndex().map((e) => e.name)).toContain('config-routed-skill');
      expect(buildSkillIndex().map((e) => e.name)).toContain('config-routed-skill');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
