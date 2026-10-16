// ── 비-git dir 그림자 스테이징 + 실위치 적용 (#25 P2 · 2026-07-21) ────────────────────
//
// 비-git 디렉토리(~/temp)는 worktree+PR 전제가 깨진다(.git 없음·PR 없음). DESIGN §1 통일 아키텍처:
//   ① 스테이징(임시복사+git init 그림자) → ② gate → ③ diff → ④ HITL → ⑤ 백업 후 실위치 rsync 적용.
// "git-init 그림자에서 diff 뽑아 HITL 로 보여주고 → 확인 → 백업 후 실위치 적용"이 PR 을 대체한다(§1).
//
// 그림자는 진짜 git repo 라 기존 seam(implement/gate/commit/diff)이 무변경으로 동작한다 —
// createWorktree 대체물로 끼워넣기만 하면 된다(재발명 0). 적용(applyShadowToTarget)은 안전 민감:
// **백업 필수·실패 시 중단**(§4). P2 는 이 primitive 를 짓고 단위테스트로 검증하며, front door 라이브
// 배선은 P4(현재 비-git 은 front door 에서 refuse 유지 → 이 적용 경로는 프로덕션 미도달).

import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { cpSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import { ELANOUS_RUNTIME_ARTIFACT_DIRS, ELANOUS_RUNTIME_ARTIFACT_PATHS } from './gate-scope.js';

const GIT_TIMEOUT_MS = 30_000;
const RSYNC_TIMEOUT_MS = 120_000;

function git(cwd: string, argv: string[]): { ok: boolean; out: string } {
  const r = runGitCommand(cwd, argv, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export interface StageNonGitResult {
  /** 그림자 디렉토리(진짜 git repo) — implement/gate seam 의 cwd(=worktree 대체). */
  path: string;
  /** 편집이 얹힐 브랜치(worktree 파리티). */
  branch: string;
  /** 베이스라인 커밋(diff 기준). */
  base: string;
  /** 그림자 정리(임시 디렉토리 제거). 적용 후/실패 시 호출. */
  cleanup: () => void;
}

/** 비-git 디렉토리를 임시 위치로 복사 + `git init` + 베이스라인 커밋으로 감싼다(그림자 스테이징).
 *  반환 path 는 진짜 git repo → goal-loop 편집이 diff 를 남기고, 기존 gate/commit/diff seam 이 그대로 동작.
 *  ⚠️ 그림자는 os tmpdir 하위(대상 부모 오염 없음). 대상 전체를 복사한다(P2: ignore-list 없음 —
 *     대용량 하위(node_modules 등)는 P3+ 에서 제외 고려). */
export function stageNonGitDir(opts: { target: string; branch: string }): StageNonGitResult {
  const { target, branch } = opts;
  if (!existsSync(target)) throw new Error(`stageNonGitDir: target 없음 — ${target}`);
  if (!statSync(target).isDirectory()) throw new Error(`stageNonGitDir: 디렉토리 아님 — ${target}`);

  // ① 임시 그림자 경로(대상 부모 밖·tmpdir). mkdtemp 대신 예측가능 슬러그+pid 로(관측/정리 용이).
  const slug = basename(target).replace(/[^a-zA-Z0-9._-]/g, '-');
  const shadowPath = join(tmpdir(), `elanous-shadow-${slug}-${process.pid}`);
  // 이전 세대 잔여 정리(고아 방지·createWorktree resetExisting 정합).
  try { spawnSync('rm', ['-rf', shadowPath], { timeout: GIT_TIMEOUT_MS, maxBuffer: SPAWN_SYNC_MAX_BUFFER }); } catch { /* fail-soft */ }

  // ② 대상 → 그림자 복사(내용 전체·심볼릭 보존 X: cpSync 기본).
  cpSync(target, shadowPath, { recursive: true });

  // ③ git init + 베이스라인 커밋. 그림자 로컬 아이덴티티(전역 config 무의존).
  git(shadowPath, ['init', '-b', 'shadow-base']);
  git(shadowPath, ['config', 'user.email', 'elanous-shadow@local']);
  git(shadowPath, ['config', 'user.name', 'elanous-shadow']);
  git(shadowPath, ['add', '-A']);
  const commit = git(shadowPath, ['commit', '-m', 'shadow baseline (pre-edit)', '--allow-empty']);
  const base = git(shadowPath, ['rev-parse', 'HEAD']).out.trim() || 'HEAD';
  // ④ 편집 브랜치로 체크아웃(worktree 파리티 — 편집·커밋이 이 브랜치에).
  git(shadowPath, ['checkout', '-B', branch]);

  debug.log('harness.target', 'shadow.staged', { target: target.slice(-48), shadow: shadowPath.slice(-48), branch, committed: commit.ok });
  return {
    path: shadowPath,
    branch,
    base,
    cleanup: () => { try { spawnSync('rm', ['-rf', shadowPath], { timeout: GIT_TIMEOUT_MS, maxBuffer: SPAWN_SYNC_MAX_BUFFER }); } catch { /* fail-soft */ } },
  };
}

export interface StageFileResult {
  /** 그림자 디렉토리(파일 하나를 담은 git repo). implement/gate seam 의 cwd. */
  path: string;
  /** 그림자 안 파일명(=basename(target)). gate/apply 가 이 파일을 지목. */
  fileName: string;
  branch: string;
  base: string;
  cleanup: () => void;
}

/** 단일 파일 타겟(config/dotfile ~/.zshrc)을 그림자로 감싼다(#25 P3). 파일 하나만 담는 임시 디렉토리를
 *  만들어 복사→git init→베이스라인 커밋→편집 브랜치. 자식 goal-loop 은 cwd=그림자 에서 fileName 을 편집.
 *  ⚠️ 디렉토리 그림자(stageNonGitDir)와 달리 **파일 하나만** 담으므로 apply 는 파일 단위(applyFileToTarget)로
 *     — rsync 디렉토리 미러링(--delete)은 부모를 지울 위험이라 파일엔 쓰지 않는다. */
export function stageFile(opts: { target: string; branch: string }): StageFileResult {
  const { target, branch } = opts;
  if (!existsSync(target)) throw new Error(`stageFile: target 없음 — ${target}`);
  if (statSync(target).isDirectory()) throw new Error(`stageFile: 파일 아님(디렉토리) — ${target}`);
  const fileName = basename(target);
  const slug = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
  const shadowPath = join(tmpdir(), `elanous-shadow-file-${slug}-${process.pid}`);
  try { spawnSync('rm', ['-rf', shadowPath], { timeout: GIT_TIMEOUT_MS, maxBuffer: SPAWN_SYNC_MAX_BUFFER }); } catch { /* fail-soft */ }

  spawnSync('mkdir', ['-p', shadowPath], { timeout: GIT_TIMEOUT_MS, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  cpSync(target, join(shadowPath, fileName));

  git(shadowPath, ['init', '-b', 'shadow-base']);
  git(shadowPath, ['config', 'user.email', 'elanous-shadow@local']);
  git(shadowPath, ['config', 'user.name', 'elanous-shadow']);
  git(shadowPath, ['add', '-A']);
  const commit = git(shadowPath, ['commit', '-m', 'shadow baseline (pre-edit)', '--allow-empty']);
  const base = git(shadowPath, ['rev-parse', 'HEAD']).out.trim() || 'HEAD';
  git(shadowPath, ['checkout', '-B', branch]);

  debug.log('harness.target', 'shadow.staged-file', { target: target.slice(-48), shadow: shadowPath.slice(-48), fileName, branch, committed: commit.ok });
  return {
    path: shadowPath,
    fileName,
    branch,
    base,
    cleanup: () => { try { spawnSync('rm', ['-rf', shadowPath], { timeout: GIT_TIMEOUT_MS, maxBuffer: SPAWN_SYNC_MAX_BUFFER }); } catch { /* fail-soft */ } },
  };
}

/** 그림자 안 편집된 단일 파일을 실위치(target 파일)에 반영한다(#25 P3). **백업 필수→실패 시 중단**(§4).
 *  파일 단위 — 백업(`<target>.bak-<stamp>`)+복사(rsync 아님·부모 무접촉). config/OS 안전 경로. */
export function applyFileToTarget(opts: { shadowPath: string; fileName: string; target: string; stamp?: string }): ApplyShadowResult {
  const { shadowPath, fileName, target } = opts;
  const src = join(shadowPath, fileName);
  if (!existsSync(src)) throw new Error(`applyFileToTarget: 그림자 파일 없음 — ${src}`);
  if (!existsSync(target)) throw new Error(`applyFileToTarget: 대상 없음 — ${target}`);
  const stamp = opts.stamp ?? `${Date.now()}`;
  const backup = join(dirname(target), `${basename(target)}.bak-${stamp}`);

  // ① 백업 필수(fail-closed·§4).
  cpSync(target, backup);
  if (!existsSync(backup)) throw new Error(`applyFileToTarget: 백업 생성 실패 — ${backup} (적용 중단)`);
  debug.log('harness.target', 'apply.backup-file', { target: target.slice(-48), backup: backup.slice(-48) });

  // ② 파일 복사(그림자 → 실위치). 디렉토리 미러링 아님(부모 안전).
  cpSync(src, target);
  const applied = existsSync(target);
  debug.log('harness.target', 'apply.done-file', { target: target.slice(-48), applied, backup: backup.slice(-48) });
  return { backup, applied, log: `file apply: ${fileName} → ${target}` };
}

export interface ApplyShadowResult {
  /** 생성된 백업 경로(`<target>.bak-<stamp>`). */
  backup: string;
  /** 실위치 적용 성공 여부. */
  applied: boolean;
  /** rsync stdout/stderr(관측·진단). */
  log: string;
}

/** 그림자의 변경을 실위치(target)에 반영한다. **백업 필수 → 실패 시 적용 중단**(DESIGN §4 크리티컬).
 *  1) `<target>.bak-<stamp>` 로 대상 전체 백업(검증) → 없으면 throw(적용 안 함). 2) rsync `-a --delete`
 *  로 그림자→대상 미러링(그림자 git 메타와 gate-scope 런타임 산출물 제외·삭제 반영). rsync 부재 시 fail-closed.
 *  ⚠️ 파괴적(--delete)이나 직전 백업으로 복원 가능. HITL 확인은 **호출측(P4 deploy seam)** 책임 —
 *     이 함수는 "확인됨" 전제의 적용 메커니즘(primitive). */
export function applyShadowToTarget(opts: { shadowPath: string; target: string; stamp?: string }): ApplyShadowResult {
  const { shadowPath, target } = opts;
  if (!existsSync(shadowPath)) throw new Error(`applyShadowToTarget: 그림자 없음 — ${shadowPath}`);
  if (!existsSync(target)) throw new Error(`applyShadowToTarget: 대상 없음 — ${target}`);
  const stamp = opts.stamp ?? `${Date.now()}`;
  const backup = join(dirname(target), `${basename(target)}.bak-${stamp}`);

  // ① 백업 필수 — 실패 시 적용 중단(fail-closed·§4).
  cpSync(target, backup, { recursive: true });
  if (!existsSync(backup)) throw new Error(`applyShadowToTarget: 백업 생성 실패 — ${backup} (적용 중단)`);
  debug.log('harness.target', 'apply.backup', { target: target.slice(-48), backup: backup.slice(-48) });

  // ② rsync 미러링(--delete·그림자 git 메타 제외). rsync 부재 = fail-closed(백업만 남기고 미적용).
  const probe = spawnSync('rsync', ['--version'], { encoding: 'utf8', timeout: 5_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (probe.status !== 0) {
    debug.log('harness.target', 'apply.no-rsync', { target: target.slice(-48) });
    return { backup, applied: false, log: 'rsync 미설치 → 적용 안 함(백업만 생성·fail-closed). 수동 적용 필요.' };
  }
  // rsync 는 후행 슬래시로 "디렉토리 내용" 을 복사한다(src/ → dst/). 둘 다 슬래시 붙임.
  const runtimeExcludes = [...ELANOUS_RUNTIME_ARTIFACT_PATHS, ...ELANOUS_RUNTIME_ARTIFACT_DIRS]
    .map((path) => `--exclude=${path}`);
  const r = spawnSync('rsync', ['-a', '--delete', '--exclude=.git', ...runtimeExcludes, `${shadowPath}/`, `${target}/`], {
    encoding: 'utf8', timeout: RSYNC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
  });
  const applied = r.status === 0;
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000);
  debug.log('harness.target', 'apply.done', { target: target.slice(-48), applied, backup: backup.slice(-48) });
  return { backup, applied, log };
}
