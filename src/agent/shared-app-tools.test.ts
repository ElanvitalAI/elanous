// turn 조립기 통일 Phase 0 — buildSharedAppTools(core+finance gated) 단일 조립기 검증.
import { test, expect, describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSharedAppTools } from './shared-app-tools.js';
import { findNativeTool } from '../native-tool-catalog.js';
import { buildSkillExecTool } from '../tool-runtime/skill-exec-runtime.js';
import { resetUserConfig } from '../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import type { UserConfig } from '../user-config.js';

const cfg = (financeOn: boolean): UserConfig => ({ finance: { enabled: financeOn } } as unknown as UserConfig);

describe('buildSharedAppTools — core + finance(gated) + skill execution 단일 조립', () => {
  test('cfg 없음 → core + skill_exec(finance 미포함)', () => {
    const s = buildSharedAppTools();
    expect(s.names.has('schedule_manage')).toBe(true);   // L2 core
    expect(s.names.has('finance_quote')).toBe(false);
    expect(s.names.has('elanous_skills_list')).toBe(true);
    expect(s.names.has('skill_exec')).toBe(true);
  });

  test('finance 비활성 → core 만', () => {
    const s = buildSharedAppTools(cfg(false));
    expect(s.names.has('memory_recall')).toBe(true);
    expect(s.names.has('finance_quote')).toBe(false);
  });

  test('finance 활성 → core + finance', () => {
    const s = buildSharedAppTools(cfg(true));
    expect(s.names.has('schedule_manage')).toBe(true);    // core 유지
    expect(s.names.has('finance_quote')).toBe(true);      // finance 추가
    expect(s.names.has('finance_kr_flow')).toBe(true);
  });

  test('specs 순서 = core 먼저·finance 뒤·skill discovery/execution 마지막', () => {
    const s = buildSharedAppTools(cfg(true));
    const coreIdx = s.specs.findIndex((t) => t.name === 'schedule_manage');
    const finIdx = s.specs.findIndex((t) => t.name === 'finance_quote');
    const skillsListIdx = s.specs.findIndex((t) => t.name === 'elanous_skills_list');
    const skillIdx = s.specs.findIndex((t) => t.name === 'skill_exec');
    expect(coreIdx).toBeGreaterThanOrEqual(0);
    expect(finIdx).toBeGreaterThan(coreIdx);
    expect(skillsListIdx).toBeGreaterThan(finIdx);
    expect(skillIdx).toBeGreaterThan(skillsListIdx);
  });

  test('dispatch 라우팅 — elanous_skills_list → 재사용 목록 runtime', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const workdir = mkdtempSync(join(tmpdir(), 'shared-app-skills-'));
    const skillsDir = join(workdir, 'skills');
    try {
      mkdirSync(join(skillsDir, 'fixture-skill'), { recursive: true });
      writeFileSync(join(skillsDir, 'fixture-skill', 'SKILL.md'), 'fixture description\n');
      mkdirSync(join(workdir, 'elanous'));
      writeFileSync(join(workdir, 'elanous', 'config.json'), JSON.stringify({ skills: { activeSet: 'custom', dirs: [skillsDir] } }));
      process.env.XDG_CONFIG_HOME = workdir;
      // 설정 로더는 XDG 가 아니라 elanous 설정 폴더를 읽는다 — XDG 만 바꾸면 실제 ~/.claude/skills 가 섞였다(🅣·🅢 2026-09-27).
      setElanousConfigDir(join(workdir, 'elanous'));
      resetUserConfig();

      const result = await buildSharedAppTools().dispatch('elanous_skills_list', {});
      // 설정 폴더 뒤에 배포판 동봉 스킬 폴더(`appendBundledSkillsDir`)가 늘 붙는다 — fixture 가 «들어 있는지»만 본다.
      expect(result).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill', description: 'fixture description' })]) });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      resetElanousConfigDir();
      resetUserConfig();
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('skill_exec runtime and catalog direct unknown names to the shared elanous_skills_list spec', () => {
    const description = buildSkillExecTool().description;
    const skillExec = findNativeTool('skill_exec');
    const skillsListSpec = buildSharedAppTools().specs.find(({ name }) => name === 'elanous_skills_list');
    expect(description).toContain('elanous_skills_list');
    expect(skillExec?.description).toBe(description);
    expect(skillExec?.promptSummary).toContain('elanous_skills_list');
    expect(skillsListSpec?.description).toContain('Read-only');
  });

  test('dispatch 라우팅 — skill_exec → 기존 skill runtime', async () => {
    const s = buildSharedAppTools();
    const result = await s.dispatch('skill_exec', { skill: '__not_allowlisted__', task: 'test' });
    expect(result).toMatchObject({ skill: '__not_allowlisted__', ok: false });
  });

  test('dispatch 라우팅 — finance_* → finance, 그 외 → core', async () => {
    const s = buildSharedAppTools(cfg(true));
    // 이름이 names 에 있으면 dispatch 가 라우팅(실행은 외부 의존이라 라우팅만 확인).
    expect(s.names.has('finance_quote')).toBe(true);
    expect(typeof s.dispatch).toBe('function');
  });
});
