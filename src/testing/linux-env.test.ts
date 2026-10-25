import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { STAGE_GIT_IDENTITY, STAGE_LOCALE, codePoints, createLinuxEnvStage, gitStageIdentity, hasGlobalGitIdentity,
  initGitWithExplicitIdentity, stageHasCommand, stageSpawnSync, withLinuxEnv } from './linux-env.js';

// LINUX-STAGE 직접 시험 — helper 의 네 축(grok · /home · git 설정 · 이모지)을 각각 «실행»으로 잰다.
// planner.test.ts 경유 커버만으로는 분기 하나가 빠져도 못 잡으므로 여기서 축마다 직접 증명한다.

// ① grok — 무대 PATH 는 grok 을 걸러내고, stageHasCommand 는 실행 가능 비트까지 본다.
test('stage PATH hides grok and stageHasCommand checks the executable bit', () => {
  const stage = createLinuxEnvStage();
  try {
    expect(stage.env.PATH?.split(delimiter)[0]).toBe(stage.bin);
    expect(stageHasCommand(stage, 'grok')).toBe(false);
    for (const dir of stage.env.PATH?.split(delimiter) ?? []) expect(existsSync(join(dir, 'grok'))).toBe(false);
    // 실행 가능한 파일을 bin 에 놓으면 찾고, 실행 불가 파일은 못 찾는다(X_OK 분기).
    const tool = join(stage.bin, 'stage-tool');
    writeFileSync(tool, '#!/bin/sh\n');
    expect(stageHasCommand(stage, 'stage-tool')).toBe(false);
    chmodSync(tool, 0o755);
    expect(stageHasCommand(stage, 'stage-tool')).toBe(true);
  } finally {
    rmSync(stage.root, { recursive: true, force: true });
  }
});

// ② /home — withLinuxEnv 안에서 HOME·로케일·config 축이 무대 값이고, 끝나면 env 와 디렉터리가 원상복구된다.
test('withLinuxEnv applies the stage env, then restores HOME, ELANOUS_CONFIG_DIR and removes the root', async () => {
  const beforeHome = process.env.HOME;
  const beforeConfigDir = process.env.ELANOUS_CONFIG_DIR;
  process.env.ELANOUS_CONFIG_DIR = join('/tmp', 'elanous-config-sentinel');
  let root = '';
  try {
    await withLinuxEnv(async (stage) => {
      root = stage.root;
      expect(process.env.HOME).toBe(stage.home);
      expect(process.env.HOME).not.toBe(beforeHome);
      expect(process.env.ELANOUS_CONFIG_DIR).toBeUndefined();
      expect(process.env.ELANOUS_STATE_DIR).toBe(stage.state);
      expect(process.env.ELANOUS_STATE_DIR_SOURCE).toBe('explicit');
      expect(process.env.LANG).toBe(STAGE_LOCALE);
      expect(process.env.LC_ALL).toBe(STAGE_LOCALE);
      expect(process.env.GIT_AUTHOR_NAME).toBeUndefined();
      expect(existsSync(stage.root)).toBe(true);
    });
    expect(process.env.HOME).toBe(beforeHome);
    expect(process.env.ELANOUS_CONFIG_DIR).toBe(join('/tmp', 'elanous-config-sentinel'));
    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  } finally {
    if (beforeConfigDir === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = beforeConfigDir;
  }
});

// ③ git 설정 — 무대 env 가 «자식 프로세스»에 실제로 도달하고, 글로벌 신원 없이 로컬 identity 만으로 커밋이 선다.
// ambient 상속은 bun 의 PATH 버그로 새므로(헬퍼 주석 참고) 자식은 반드시 stageSpawnSync 로 띄운다.
test('stage git has no global identity and commits with the repo-local identity only', async () => {
  await withLinuxEnv(async (stage) => {
    // 무대 env 가 자식에게 도달한다는 직접 증거 — 이 단언이 ambient 상속에 기댔으면 bun 버그로 깨진다.
    const childEnv = stageSpawnSync(stage, 'env', []);
    expect(childEnv.status).toBe(0);
    expect(childEnv.stdout).toContain(`HOME=${stage.home}\n`);
    expect(childEnv.stdout).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(hasGlobalGitIdentity(stage)).toBe(false);
    // 글로벌 read 경로 자체가 막혔다(GIT_CONFIG_GLOBAL=/dev/null)는 실물 증거.
    expect(stageSpawnSync(stage, 'git', ['config', '--global', '--get', 'user.name']).status).not.toBe(0);
    writeFileSync(join(stage.home, '.gitconfig'), '[user]\n\tname = Leaked\n');
    expect(hasGlobalGitIdentity(stage)).toBe(true);
    // 무대 HOME 에 .gitconfig 를 심어도 GIT_CONFIG_GLOBAL=/dev/null 이라 git 은 못 읽는다.
    expect(stageSpawnSync(stage, 'git', ['config', '--global', '--get', 'user.name']).status).not.toBe(0);
    rmSync(join(stage.home, '.gitconfig'));
    mkdirSync(join(stage.home, '.config', 'git'), { recursive: true });
    writeFileSync(join(stage.home, '.config', 'git', 'config'), '[user]\n\tname = Leaked\n');
    expect(hasGlobalGitIdentity(stage)).toBe(true);
    rmSync(join(stage.home, '.config'), { recursive: true, force: true });

    initGitWithExplicitIdentity(stage);
    expect(gitStageIdentity(stage)).toEqual(STAGE_GIT_IDENTITY);
    // 커밋 작성자가 저장소 로컬 신원 — 글로벌 설정 없이 commit 이 성공했다는 것 자체가 실물 증거다.
    const author = stageSpawnSync(stage, 'git', ['log', '-1', '--format=%an <%ae>']);
    expect(author.status).toBe(0);
    expect(author.stdout.trim()).toBe(`${STAGE_GIT_IDENTITY.name} <${STAGE_GIT_IDENTITY.email}>`);
    expect(stageSpawnSync(stage, 'git', ['log', '--oneline']).stdout).toContain('stage: 초기 커밋');
  });
});

// ④ 이모지 — 코드포인트 단위로 쪼개므로 UTF-16 길이에 흔들리지 않는다.
test('codePoints splits by code point, not UTF-16 unit', () => {
  expect(codePoints('🎉party')).toEqual(['🎉', 'p', 'a', 'r', 't', 'y']);
  expect('🎉party'.length).toBe(7);
  expect(codePoints('🎉party')).toHaveLength(6);
  expect(codePoints('')).toEqual([]);
  expect(codePoints('한글abc')).toEqual(['한', '글', 'a', 'b', 'c']);
  expect(codePoints('👨‍👩‍👧')).toEqual(['👨', '‍', '👩', '‍', '👧']);
});
