// `elanous shadow` — git 을 거절한 폴더의 이력을 폴더 «밖» 그림자 저장소에 남긴다.
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Command } from 'commander';

import { effectiveInstanceRoot } from '../instance/resolve.js';
import {
  diffShadow,
  listShadow,
  restoreShadow,
  shadowPaths,
  snapshotShadow,
  targetIsGitRepo,
  type ShadowContext,
  type ShadowGit,
} from '../self-implement/shadow-repo.js';

export const GIT_REPO_REFUSAL = '이 폴더는 git 저장소입니다 — git 을 쓰세요';

export interface ShadowCliIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface ShadowCliDeps {
  cwd?: () => string;
  instanceRoot?: () => string;
  git?: ShadowGit;
  now?: () => Date;
  out?: ShadowCliIo;
  setExitCode?: (code: number) => void;
}

interface ShadowFlags {
  message?: string;
  json?: boolean;
  yes?: boolean;
}

function depsOf(overrides: ShadowCliDeps): Required<Pick<ShadowCliDeps, 'cwd' | 'instanceRoot' | 'out' | 'setExitCode'>> & ShadowCliDeps {
  return {
    cwd: () => process.cwd(),
    instanceRoot: () => effectiveInstanceRoot(),
    out: { log: (message) => console.log(message), error: (message) => console.error(message) },
    setExitCode: (code) => { process.exitCode = code; },
    ...overrides,
  };
}

function contextFor(dir: string | undefined, deps: ReturnType<typeof depsOf>): ShadowContext & { target: string } {
  const target = resolve(dir ?? deps.cwd());
  return {
    target,
    instanceRoot: deps.instanceRoot(),
    git: deps.git,
    now: deps.now,
  };
}

/** 대상이 git 저장소면 한 줄만 내고 2. 그림자에는 아무것도 쓰지 않는다. */
function refuseGitRepo(ctx: ShadowContext, deps: ReturnType<typeof depsOf>): boolean {
  // A missing folder must not become a shadow repository keyed by a path that does not exist
  // (2026-09-28: `restore <dir> <commit>` in the wrong order created one and then crashed in git add).
  let isDirectory = false;
  try { isDirectory = statSync(ctx.target).isDirectory(); } catch { /* missing */ }
  if (!isDirectory) {
    deps.out.error(`폴더가 아닙니다: ${ctx.target}${/^[0-9a-f]{7,40}$/i.test(basename(ctx.target)) ? ' — 커밋처럼 보인다. restore 는 `shadow restore <커밋> [폴더]` 순서다' : ''}`);
    deps.setExitCode(2);
    return true;
  }
  if (!targetIsGitRepo(ctx.target, deps.git)) return false;
  deps.out.error(GIT_REPO_REFUSAL);
  deps.setExitCode(2);
  return true;
}

function runSnapshot(dir: string | undefined, flags: ShadowFlags, overrides: ShadowCliDeps): void {
  const deps = depsOf(overrides);
  const ctx = contextFor(dir, deps);
  if (refuseGitRepo(ctx, deps)) return;
  const message = flags.message?.trim() || 'shadow snapshot';
  const result = snapshotShadow({ ...ctx, message });
  deps.out.log(`${result.mode} ${result.commit} changed=${result.changed}`);
}

function runLog(dir: string | undefined, flags: ShadowFlags, overrides: ShadowCliDeps): void {
  const deps = depsOf(overrides);
  const ctx = contextFor(dir, deps);
  if (refuseGitRepo(ctx, deps)) return;
  const rows = listShadow(ctx);
  if (flags.json) {
    deps.out.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    deps.out.log('(그림자 이력 없음)');
    return;
  }
  for (const row of rows) {
    deps.out.log(`${row.commit} ${row.at} changed=${row.changed} ${row.message}`);
  }
}

function runDiff(dir: string | undefined, from: string | undefined, to: string | undefined, overrides: ShadowCliDeps): void {
  const deps = depsOf(overrides);
  const ctx = contextFor(dir, deps);
  if (refuseGitRepo(ctx, deps)) return;
  const rows = listShadow(ctx);
  const base = from ?? rows[0]?.commit;
  if (!base) {
    deps.out.error('비교할 그림자 커밋이 없습니다');
    deps.setExitCode(1);
    return;
  }
  deps.out.log(diffShadow({ ...ctx, from: base, to }));
}

/** `--yes` 없이 restore 가 보여줄 바뀔 파일 목록. 쓰기는 하지 않는다. */
function previewRestore(ctx: ShadowContext & { commit: string }): string {
  return diffShadow({ ...ctx, from: 'HEAD', to: ctx.commit });
}

function runRestore(dir: string | undefined, commit: string | undefined, flags: ShadowFlags, overrides: ShadowCliDeps): void {
  const deps = depsOf(overrides);
  const ctx = contextFor(dir, deps);
  if (refuseGitRepo(ctx, deps)) return;
  if (!commit) {
    deps.out.error('restore 에는 커밋이 필요합니다');
    deps.setExitCode(1);
    return;
  }
  if (!flags.yes) {
    const text = previewRestore({ ...ctx, commit });
    const files = text.split('\n').filter((line) => line.startsWith('diff --git ')).map((line) => line.slice('diff --git '.length));
    if (files.length === 0) deps.out.log('(바뀔 파일 없음)');
    else for (const file of files) deps.out.log(file);
    deps.out.log('반영하려면 --yes');
    return;
  }
  const result = restoreShadow({ ...ctx, commit });
  deps.out.log(`restored ${commit} ${result.commit} changed=${result.changed}`);
}

/** One line and exit 1 instead of a stack trace. */
function guarded(overrides: ShadowCliDeps, run: () => void): void {
  try { run(); }
  catch (error) {
    const deps = depsOf(overrides);
    deps.out.error(`shadow: ${error instanceof Error ? error.message : String(error)}`);
    deps.setExitCode(1);
  }
}

export function registerShadowCommand(program: Command, overrides: ShadowCliDeps = {}): void {
  const shadow = program.command('shadow').description('git 아닌 폴더의 이력을 인스턴스 밖 그림자 저장소에 남긴다');

  shadow.command('snapshot')
    .description('현재 폴더(또는 [dir])의 그림자 스냅숏')
    .argument('[dir]', '대상 폴더 (기본: 현재 폴더)')
    .option('-m, --message <message>', '스냅숏 메시지')
    .action((dir: string | undefined, flags: ShadowFlags) => guarded(overrides, () => runSnapshot(dir, flags, overrides)));

  shadow.command('log')
    .description('그림자 커밋 목록 (최신 먼저)')
    .argument('[dir]', '대상 폴더 (기본: 현재 폴더)')
    .option('--json', 'JSON 출력')
    .action((dir: string | undefined, flags: ShadowFlags) => guarded(overrides, () => runLog(dir, flags, overrides)));

  shadow.command('diff')
    .description('그림자 커밋과 작업 트리(또는 다른 커밋)의 unified diff')
    .argument('[dir]', '대상 폴더 (기본: 현재 폴더)')
    .argument('[from]', '기준 커밋 (생략 시 최신)')
    .argument('[to]', '비교 커밋 (생략 시 WORKTREE)')
    .action((dir: string | undefined, from: string | undefined, to: string | undefined) => {
      guarded(overrides, () => runDiff(dir, from, to, overrides));
    });

  shadow.command('restore')
    .description('그림자 커밋으로 되돌린다 (--yes 없으면 바뀔 파일만 보여 주고 멈춘다)')
    .argument('<commit>', '되돌릴 커밋')
    .argument('[dir]', '대상 폴더 (기본: 현재 폴더)')
    .option('--yes', '실제로 대상 파일을 되돌린다')
    .action((commit: string, dir: string | undefined, flags: ShadowFlags) => {
      guarded(overrides, () => runRestore(dir, commit, flags, overrides));
    });
}


