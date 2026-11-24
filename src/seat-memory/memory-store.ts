// 🧠 MEMORY-STORE-SPLIT (0.3.35 P0) — 기억 저장소 «하나의» 해석기.
//
// S: 같은 자리의 기억이 세 곳으로 갈라졌다 — CLI `eln memory add/list/pin/where` 는 전역 사용자 저장소(XDG
//    `~/.local/share/elanous/memory`)에, 돌고 있는 자리 세션은 운영 집(`~/.elanous/elanous/memory/seats/<SEAT>`)에,
//    `eln memory seat-index` 는 XDG 아래 `seats/<SEAT>`(빈 폴더)를 봤다. 자리 세션은 els 가 ELANOUS_STATE_DIR 을 찍어
//    주지만 셸 CLI 는 그 도장이 없어 `memoryRoot()` 가 XDG 로 떨어졌다 — 그래서 CLI 로 쓴 기억을 자리가 못 봤다.
// A: 우선순위 하나(본부·일반 사용자 공통 · 본부 경로 하드코딩 없음):
//    ① 자리 맥락 — `ELANOUS_TRACK=<SEAT>` 또는 cwd 의 `seats/<SEAT>` → `<기억 뿌리>/seats/<SEAT>`
//    ② 그 밖에 git 저장소 안 → 저장소(공통 git 폴더) 단위 프로젝트 저장소 `<기억 뿌리>/projects/<이름>-<해시>`
//       — 같은 저장소의 worktree 들은 같은 공통 폴더를 가리키므로 한 저장소를 함께 쓴다.
//    ③ 그 밖 → 전역 사용자 저장소(`memoryRoot()` · 옛 동작 그대로)
//    기억 뿌리 = 인스턴스 state 뿌리(`elanousStateRoot()` — `--config-dir`·`ELANOUS_STATE_DIR`·운영 집 순) 아래
//    `elanous/memory` · 시험 우주(`--test-state-dir`)면 그 우주의 `memoryRoot()`.
// 세 얼굴: 관측 = `eln memory where` 가 종류·근거·폴더를 출력 · 판단 근거 = 위 우선순위(근거 문자열) ·
//    수복 = git 판독 실패는 ③ 으로 내려간다(턴·CLI 를 막지 않는다).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getAppliedGlobalTestRoot } from '../cli/test-flag.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { memoryRoot } from '../memory.js';

const SEAT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;
const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/;

export type MemoryStore =
  /** commonDir = 본부 자리 공통 층(`<기억 뿌리>/seats/_common`) — 읽기만(세션 시작 색인 앞 · memory_search 뒤). 쓰기는 자리 저장소. */
  | { kind: 'seat'; seat: string; label: string; dir: string; why: string; commonDir: string }
  | { kind: 'project'; label: string; dir: string; why: string; repo: GitRepoIdentity }
  | { kind: 'user'; label: null; dir: string; why: string };

export interface GitRepoIdentity {
  /** 공통 git 폴더(실경로) — worktree 들이 함께 가리키는 곳. */
  commonDir: string;
  /** 이 cwd 의 작업 트리 뿌리. */
  worktreeRoot: string;
  /** 사람이 읽을 저장소 이름. */
  name: string;
  /** 공통 폴더 실경로의 해시(앞 12자). */
  key: string;
}

export interface MemoryStoreDeps {
  env?: NodeJS.ProcessEnv;
  /** 기억 뿌리(시험) — 기본 `memoryStoreBaseRoot()`. */
  baseRoot?: string;
  /** 전역 사용자 저장소(시험) — 기본 `memoryRoot()`. */
  userRoot?: string;
}

/** 자리·프로젝트 저장소의 뿌리. 자리 세션(els 가 찍은 ELANOUS_STATE_DIR)과 셸 CLI(도장 없음 → 운영 집)가 같은 곳을 본다. */
export function memoryStoreBaseRoot(): string {
  if (getAppliedGlobalTestRoot()) return memoryRoot();
  return join(elanousStateRoot(), 'elanous', 'memory');
}

/** ELANOUS_TRACK 의 자리 이름. 미션 꼬리표(`MISSION-<id>`)는 자리가 아니다. */
function seatFromTrack(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.ELANOUS_TRACK ?? '').trim().toUpperCase();
  if (!raw || raw.startsWith('MISSION-') || !SEAT_ID.test(raw)) return null;
  return raw;
}

export function seatFromCwd(cwd: string): string | null {
  const s = SEAT_IN_PATH.exec(cwd)?.[1]?.toUpperCase();
  return s && SEAT_ID.test(s) ? s : null;
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** cwd 위로 올라가며 `.git` 을 찾아 공통 git 폴더를 읽는다(git 프로세스 없이). 못 찾으면 null. */
export function findGitRepoIdentity(cwd: string): GitRepoIdentity | null {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, '.git');
    if (existsSync(dotGit)) {
      let commonDir: string | null = null;
      if (isDir(dotGit)) commonDir = dotGit;
      else {
        try {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
          if (m) {
            const gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
            const commonFile = join(gitDir, 'commondir');
            commonDir = existsSync(commonFile)
              ? (() => { const c = readFileSync(commonFile, 'utf8').trim(); return isAbsolute(c) ? c : resolve(gitDir, c); })()
              : gitDir;
          }
        } catch { commonDir = null; }
      }
      if (!commonDir) return null;
      const abs = real(commonDir);
      const name = (basename(abs) === '.git' ? basename(dirname(abs)) : basename(abs).replace(/\.git$/, '')) || 'repo';
      const key = createHash('sha256').update(abs).digest('hex').slice(0, 12);
      return { commonDir: abs, worktreeRoot: real(dir), name, key };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** 저장소 이름 → 자리 id 꼴 꼬리표(기억 원장이 자리 id 꼴만 받는다). */
function projectLabel(repo: GitRepoIdentity): string {
  const slug = repo.name.toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'REPO';
  return `PROJECT-${slug}-${repo.key.toUpperCase()}`.slice(0, 64);
}

export function projectMemoryDir(repo: GitRepoIdentity, base: string = memoryStoreBaseRoot()): string {
  const slug = repo.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'repo';
  return join(base, 'projects', `${slug}-${repo.key}`);
}

/** 🧠 SEAT-COMMON-MEMORY (0.3.35 P0) — 본부 자리 공통 기억 층 이름. `_` 로 시작해 자리 id(대문자 시작)와 겹치지 않는다.
 *  일반 사용자는 프로젝트 저장소가 이 역할을 한다(공통 층 없음). 승격은 조율자(OP)만 — `eln memory promote <name> --to common`. */
export const COMMON_MEMORY_STORE = '_common';

export function commonMemoryDir(base: string = memoryStoreBaseRoot()): string {
  return join(base, 'seats', COMMON_MEMORY_STORE);
}

/** 기억 저장소 해석기 — 세션 시작 색인·턴 회상·memory_save 도구·CLI 가 모두 이것 하나를 쓴다. */
export function resolveMemoryStore(cwd: string, deps: MemoryStoreDeps = {}): MemoryStore {
  const env = deps.env ?? process.env;
  const base = () => deps.baseRoot ?? memoryStoreBaseRoot();
  const track = seatFromTrack(env);
  const seat = track ?? seatFromCwd(cwd);
  if (seat) return { kind: 'seat', seat, label: seat, dir: join(base(), 'seats', seat), why: track ? 'ELANOUS_TRACK' : 'cwd seats/<SEAT>', commonDir: commonMemoryDir(base()) };
  const repo = findGitRepoIdentity(cwd);
  if (repo) return { kind: 'project', label: projectLabel(repo), dir: projectMemoryDir(repo, base()), why: `git common dir ${repo.commonDir}`, repo };
  return { kind: 'user', label: null, dir: deps.userRoot ?? memoryRoot(), why: 'no seat · no git repo' };
}

/** 같은 저장소의 작업 트리 뿌리들(주 트리 ⊕ `worktrees/*`). 지시 색인을 이 프로젝트로 거를 때 쓴다. */
export function gitWorktreeRoots(repo: GitRepoIdentity): string[] {
  const out = new Set<string>([repo.worktreeRoot]);
  if (basename(repo.commonDir) === '.git') out.add(dirname(repo.commonDir));
  try {
    const wtDir = join(repo.commonDir, 'worktrees');
    if (isDir(wtDir)) {
      for (const name of readdirSync(wtDir)) {
        try {
          const gitdir = readFileSync(join(wtDir, name, 'gitdir'), 'utf8').trim();
          if (gitdir) out.add(real(dirname(gitdir)));
        } catch { /* 깨진 worktree 기록은 건너뛴다 */ }
      }
    }
  } catch { /* */ }
  return [...out];
}
