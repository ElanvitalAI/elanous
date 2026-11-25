// 낡은 cwd 트리 감지 — Grep/Glob/docs search 가 «며칠 묵은 작업 트리»만 보고 답하지 않게 한다.
//
// 관측(11-25 실험): 자리 cwd 가 origin/main 보다 며칠 뒤처진 worktree 라서, 최신 설계 문서가
// 있어도 도구가 «없다»고 답했다. 설정 `knowledge.docsRoots` 에 최신 체크아웃(latest)이 있으면
// 그 뿌리도 같이 찾고, 결과 앞에 한 줄 힌트를 붙인다.
//
// 비용: 세션(프로세스)당 cwd 하나에 git 한 번(`git show -s --format=%ct HEAD origin/main`) — 캐시.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { resolveSearchRoots } from './search-roots.js';
import { debug } from '../debug/log.js';

/** 이 일수보다 뒤처지면 낡은 트리로 본다. */
export const STALE_CWD_DAYS = 2;

export interface StaleCwd {
  /** origin/main 대비 HEAD 가 뒤처진 일수. */
  days: number;
  /** cwd 가 속한 git 작업 트리 뿌리. */
  cwdRoot: string;
  /** 같이 찾을 최신 체크아웃 뿌리. */
  latestRoot: string;
}

export interface StaleCwdDeps {
  latestRoots: () => string[];
  /** `[headCommitTs, originMainCommitTs]`(초) — 못 읽으면 null. */
  commitTimes: (cwdRoot: string) => [number, number] | null;
  gitRoot: (cwd: string) => string | null;
}

function realOr(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** `.git` 파일/디렉터리를 위로 찾아 올라간다 — spawn 없음. */
function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const defaultDeps: StaleCwdDeps = {
  // 단일 해석기(env ELANOUS_DOCS_ROOTS > config knowledge.docsRoots > 없음) — 경로를 코드에 박지 않는다.
  latestRoots: () => {
    try { return resolveSearchRoots().latestRepoRoots; } catch { return []; }
  },
  commitTimes: (cwdRoot) => {
    const r = spawnSync('git', ['-C', cwdRoot, 'show', '-s', '--format=%ct', 'HEAD', 'origin/main'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    const [head, main] = (r.stdout ?? '').trim().split('\n').map(Number);
    return Number.isFinite(head) && Number.isFinite(main) ? [head!, main!] : null;
  },
  gitRoot: findGitRoot,
};

const cache = new Map<string, StaleCwd | null>();
let probeOverride: ((cwd: string) => StaleCwd | null) | null = null;

/** 시험 심 — 실물 git/설정 없이 낡은 트리를 흉내 낸다. null 이면 실물로 복귀. */
export function setStaleCwdProbeForTesting(probe: ((cwd: string) => StaleCwd | null) | null): void {
  probeOverride = probe;
  cache.clear();
}

/** 판정(캐시 없음) — 시험용으로 deps 주입. */
export function assessStaleCwd(cwd: string, deps: StaleCwdDeps = defaultDeps, thresholdDays = STALE_CWD_DAYS): StaleCwd | null {
  const latest = deps.latestRoots().map(realOr);
  if (latest.length === 0) return null;
  const root = deps.gitRoot(cwd);
  if (!root) return null;
  const cwdRoot = realOr(root);
  const latestRoot = latest.find((l) => l !== cwdRoot && !(cwdRoot + sep).startsWith(l + sep));
  if (!latestRoot) return null; // cwd 가 곧 latest(또는 그 안)
  const times = deps.commitTimes(cwdRoot);
  if (!times) return null;
  const days = Math.floor((times[1] - times[0]) / 86_400);
  if (days <= thresholdDays) return null;
  return { days, cwdRoot, latestRoot };
}

/** 프로세스당 cwd 하나에 한 번만 잰다. */
export function staleCwdFor(cwd: string): StaleCwd | null {
  if (probeOverride) return probeOverride(cwd);
  const key = resolve(cwd);
  if (cache.has(key)) return cache.get(key)!;
  let result: StaleCwd | null = null;
  try { result = assessStaleCwd(key); } catch { result = null; }
  cache.set(key, result);
  if (result) debug.log('tools.search', 'stale-cwd', { cwdRoot: result.cwdRoot, latestRoot: result.latestRoot, days: result.days });
  return result;
}

/** 힌트 한 줄. */
export function staleCwdHint(stale: StaleCwd): string {
  return `cwd tree is ${stale.days} days old — searched latest too (${stale.latestRoot})`;
}

/** cwd 트리 안의 경로를 latest 의 같은 상대 경로로 옮긴다. 트리 밖이면 null. */
export function mapToLatest(absPath: string, stale: StaleCwd): string | null {
  const real = realOr(absPath);
  const rel = relative(stale.cwdRoot, real);
  if (rel.startsWith('..') || resolve(stale.cwdRoot, rel) !== real) return null;
  const mapped = join(stale.latestRoot, rel);
  return existsSync(mapped) ? mapped : null;
}
