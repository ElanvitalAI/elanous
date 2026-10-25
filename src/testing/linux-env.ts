/**
 * 🐧 LINUX-STAGE — 개발 머신 환경에 기대지 않는 «격리 무대».
 *
 * Situation: 같은 시험이 macOS(개발 머신)에서는 통과하고 Linux 에서는 실패하는 잔여 실패가 있다.
 *   원인은 코드가 아니라 «환경»이다 — 개발 머신 HOME 의 글로벌 git user.* · PATH 에 있는 grok CLI ·
 *   LANG/LC_ALL 이 정하는 콜레이션 · 로케일마다 달라지는 이모지 비교.
 * Answer: 그 네 축을 «무대»로 고정한다 — 임시 HOME(글로벌 설정 없음), grok 이 없는 PATH,
 *   저장소 로컬 identity 만 가진 git 작업 트리, C.UTF-8, 코드포인트 비교.
 * ⛔ 이 무대는 «생산 진입점을 그대로 지나게» 하는 시험을 위한 것이다 — 소스 문자열 검사용이 아니다.
 * ⛔ `withLinuxEnv` 는 끝나면 env 와 임시 디렉터리를 원상복구한다(같은 파일의 뒤 시험을 오염시키지 않는다).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** 무대 로케일 — Linux CI 의 기본값(LANG 미설정 · POSIX)을 넘긴다. */
export const STAGE_LOCALE = 'C.UTF-8';

/** 무대 git 신원 — 글로벌 설정이 아니라 저장소 로컬에만 박는다. */
export const STAGE_GIT_IDENTITY = { name: 'Elanous Stage', email: 'stage@elanous.test', branch: 'main' } as const;

export interface LinuxEnvStage {
  /** 무대 루트(시험 끝에 통째로 지운다). */
  readonly root: string;
  /** 임시 HOME — `.gitconfig` 가 없다(글로벌 git 신원 없음). */
  readonly home: string;
  /** ELANOUS_STATE_DIR — config-dir 이 이 경로를 따라가므로 둘 다 격리된다. */
  readonly state: string;
  /** 무대 git 작업 트리(저장소 로컬 identity 만). */
  readonly repo: string;
  /** PATH 앞머리 — grok 이 없는 빈 디렉터리. */
  readonly bin: string;
  readonly env: Record<string, string>;
}

const ENV_KEYS = [
  'HOME',
  'ELANOUS_STATE_DIR',
  'ELANOUS_STATE_DIR_SOURCE',
  'ELANOUS_CONFIG_DIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'PATH',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/** 무대 PATH 의 시스템 꼬리 — grok 이 깔린 디렉터리는 «걸러낸다»(머신마다 설치 위치가 다르다). */
const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin'];

/** 무대를 만들기만 한다(env 적용은 `withLinuxEnv`). */
export function createLinuxEnvStage(): LinuxEnvStage {
  const root = mkdtempSync(join(tmpdir(), 'elanous-linux-env-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const state = join(repo, '.elanous');
  for (const dir of [home, repo, bin, state]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    // ELANOUS_CONFIG_DIR 는 state 를 따라가는 것이 정본이므로 따로 두지 않는다(무시 경고 방지).
    ELANOUS_STATE_DIR: state,
    ELANOUS_STATE_DIR_SOURCE: 'explicit',
    LANG: STAGE_LOCALE,
    LC_ALL: STAGE_LOCALE,
    TZ: 'UTC',
    PATH: [bin, ...SYSTEM_PATH.filter((dir) => !existsSync(join(dir, 'grok')))].join(delimiter),
    // 글로벌·시스템 git 설정을 read 자체에서 끊는다 — 개발 머신 설정이 새어 들어올 길을 없앤다.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  return { root, home, state, repo, bin, env };
}

/**
 * 무대 env 로 `fn` 을 돌리고 원상복구한다.
 * `ELANOUS_STATE_DIR` 가 정해지면 config-dir 도 그 아래로 오므로(config 정본 = state) 저장소·HOME 오염이 없다.
 */
export async function withLinuxEnv<T>(fn: (stage: LinuxEnvStage) => T | Promise<T>): Promise<T> {
  const stage = createLinuxEnvStage();
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  delete process.env.ELANOUS_CONFIG_DIR;
  for (const [key, value] of Object.entries(stage.env)) process.env[key] = value;
  // 개발 머신이 물려준 author/committer env 가 저장소 로컬 identity 증명을 가리지 않게 걷어낸다.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key];
  try {
    return await fn(stage);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stage.root, { recursive: true, force: true });
  }
}

/**
 * 무대 env 를 «명시» 해서 자식 프로세스를 띄운다.
 * ⛔ bun 1.4.2 는 `process.env.PATH` 를 바꾸는 순간 이후 spawn 한 자식의 environ 을 기동 시 스냅샷으로
 * 재구성한다 — HOME 등 다른 키의 JS 측 변이가 자식에 새지 않는다(실측: PATH assign 뒤 `env` 자식의
 * HOME 이 원래 값으로 되돌아감). ambient 상속에 기대지 말고 무대 안의 자식은 반드시 이 함수로 띄운다.
 * in-process(process.env 를 직접 읽는 코드)는 `withLinuxEnv` 의 변이가 그대로 보인다.
 */
export function stageSpawnSync(
  stage: LinuxEnvStage,
  file: string,
  args: string[],
  opts: { cwd?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync(file, args, {
    cwd: opts.cwd ?? stage.repo,
    env: { ...process.env, ...stage.env },
    encoding: 'utf8',
  });
}

/** 무대 PATH 에서 그 명령이 실행 가능한가 — Linux CI 에 grok 이 없다는 사실을 «재는» 데 쓴다. */
export function stageHasCommand(stage: LinuxEnvStage, name: string): boolean {
  return (stage.env.PATH ?? '').split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** 무대 HOME 에 글로벌 git 신원이 있는가 — 무대에서는 false 여야 한다. */
export function hasGlobalGitIdentity(stage: LinuxEnvStage): boolean {
  return existsSync(join(stage.home, '.gitconfig')) || existsSync(join(stage.home, '.config', 'git', 'config'));
}

function gitInStage(stage: LinuxEnvStage, args: string[]): string {
  const result = stageSpawnSync(stage, 'git', args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 실패(rc=${result.status}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * 무대 작업 트리를 «저장소 로컬 identity 만» 으로 초기화하고 첫 커밋까지 만든다.
 * 커밋이 성공했다는 것 자체가 user.name/user.email 이 로컬 설정으로 먹었다는 실물 증거다.
 */
export function initGitWithExplicitIdentity(stage: LinuxEnvStage): void {
  gitInStage(stage, ['-c', `init.defaultBranch=${STAGE_GIT_IDENTITY.branch}`, 'init', '--quiet']);
  gitInStage(stage, ['config', 'user.name', STAGE_GIT_IDENTITY.name]);
  gitInStage(stage, ['config', 'user.email', STAGE_GIT_IDENTITY.email]);
  gitInStage(stage, ['config', 'init.defaultBranch', STAGE_GIT_IDENTITY.branch]);
  writeFileSync(join(stage.repo, 'README.md'), '# linux stage\n');
  gitInStage(stage, ['add', 'README.md']);
  gitInStage(stage, ['commit', '--quiet', '-m', 'stage: 초기 커밋']);
}

/** 무대 작업 트리의 실제 git 정체 — 로컬 설정과 현재 브랜치를 읽어 온다. */
export function gitStageIdentity(stage: LinuxEnvStage): { name: string; email: string; branch: string } {
  return {
    name: gitInStage(stage, ['config', '--get', 'user.name']),
    email: gitInStage(stage, ['config', '--get', 'user.email']),
    branch: gitInStage(stage, ['symbolic-ref', '--short', 'HEAD']),
  };
}

/**
 * 문자열을 «코드포인트» 단위로 쪼갠다 — `'🎉party'.length` 는 7(UTF-16)이지만 코드포인트는 6이다.
 * 로케일·인코딩에 따라 이모지 비교가 흔들리는 자리를 코드포인트로 고정한다.
 */
export function codePoints(value: string): string[] {
  return [...value];
}
