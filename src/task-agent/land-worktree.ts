/**
 * TA-LAND-WORKTREE — task agent 의 머리 고정 착지(`pr land --pr N --expected-head <sha>`)를 PR 머리 트리에서 부른다.
 *
 * - 왜: `pr land --expected-head` 는 «로컬 HEAD = 고정 머리 · 깨끗한 트리 · 현재 가지 = PR 가지»를 요구한다. 로컬 런은 런 작업
 *   트리가 그 머리라 넘었지만, Pod 런 PR 은 호스트에 그 머리의 트리가 없다 — 카드의 대상 저장소(호스트 checkout)는 다른 머리라
 *   관문을 영영 못 넘었다(2026-10-11 #26030 · `✗ expected-head: … matching local HEAD and clean worktree required`).
 * - 무엇을: 그 cwd 의 HEAD 가 PR 머리와 다를 때만, `<state>/land-worktrees/<card>-<pr>-<head12>` 에 임시 워크트리를 만든다 —
 *   `git fetch origin pull/N/head` 로 머리를 받고(그 sha 인지 확인), PR 가지 이름(headRefName)의 로컬 가지를 그 머리에 둔다
 *   (`pr land` 는 현재 가지 = PR 가지를 요구한다 · detached 는 거부된다). 같은 이름의 로컬 가지가 «다른» 커밋에 있으면 만들지
 *   않는다(남의 가지를 덮지 않는다). 의존성은 호스트 재게이트와 같은 함수(`provideCheckoutDependencies`)로 빌린다.
 *   land 가 끝나면 성공이든 실패든 걷는다(`git worktree remove --force` ⊕ prune ⊕ 우리가 만든 가지만 지운다).
 * - 관측: `task-agent` · `land-worktree {card, pr, head, created, removed, reason}`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';

export type GitRun = (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
const defaultGit: GitRun = (cwd, args) => {
  const r = runGitCommand(cwd, args, { encoding: 'utf-8' });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};

export interface LandWorktreeInput { card: string; pr: number; head: string; branch: string | undefined; repoCwd: string; statePath: string }
export type LandWorktreeRemoval = { removed: boolean; reason?: string; /** 이 호출이 만든 가지를 지웠나 — 만든 가지가 없으면 null. */ branchRemoved?: boolean | null };
export interface LandWorktree { cwd: string; cleanup: () => LandWorktreeRemoval }

export interface LandWorktreeDeps {
  git?: GitRun;
  /** 시험 seam — 의존성 빌리기(기본 = 호스트 재게이트의 `provideCheckoutDependencies`). */
  provideDeps?: (worktree: string, sourceRoot: string) => Promise<void> | void;
}

const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
export function landWorktreePath(statePath: string, card: string, pr: number, head: string): string {
  return join(dirname(statePath), 'land-worktrees', `${safe(card)}-${pr}-${safe(head.slice(0, 12))}`);
}

/** cwd 의 HEAD — 못 읽으면 null. */
export function localHead(cwd: string, git: GitRun = defaultGit): string | null {
  try {
    const r = git(cwd, ['rev-parse', 'HEAD']);
    const out = r.stdout.trim();
    return r.status === 0 && /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch { return null; }
}

async function defaultProvideDeps(worktree: string, sourceRoot: string): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const { provideCheckoutDependencies } = await import('../self-implement/host-regate.js');
  const install = (cwd: string) => {
    const r = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd, encoding: 'utf8', timeout: 600_000 });
    if (r.status !== 0) throw new Error(`bun install failed in ${cwd}: ${(r.stderr || r.stdout || '').trim().slice(-200)}`);
  };
  provideCheckoutDependencies(worktree, sourceRoot, '', 'typescript', install);
  // apps/pwa 는 «빌리기만» 한다 — 호스트에 설치돼 있을 때 링크하고, 아니면 설치하지 않는다(PWA 를 안 건드리는 PR 의 착지를 설치 실패로
  //   막지 않게 · PWA 빌드가 필요한 PR 이면 `pr land` 의 자기 관문이 그 결손을 말한다).
  if (existsSync(join(worktree, 'apps/pwa')) && existsSync(join(sourceRoot, 'apps/pwa', 'node_modules', 'next', 'package.json'))) {
    provideCheckoutDependencies(worktree, sourceRoot, 'apps/pwa', 'next', install);
  }
}

/** 그 경로가 이 저장소에 등록된 워크트리인가 — `git worktree list --porcelain`. 목록을 못 읽으면 null(«미등록»으로 읽지 않는다). */
function registered(git: GitRun, repoCwd: string, path: string): boolean | null {
  const list = git(repoCwd, ['worktree', 'list', '--porcelain']);
  if (list.status !== 0) return null;
  // macOS 의 /var → /private/var 처럼 같은 자리가 다른 철자로 나온다 — 실경로로 맞춘다(못 풀면 그대로).
  const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  const want = real(path);
  return list.stdout.split('\n').some((line) => line.startsWith('worktree ') && real(line.slice('worktree '.length).trim()) === want);
}

/** 이 저장소의 git 공통 디렉터리(실경로) — 못 읽으면 null. */
function commonDir(git: GitRun, repoCwd: string): string | null {
  const r = git(repoCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try { return realpathSync(r.stdout.trim()); } catch { return null; }
}
const ownerPath = (path: string) => `${path}.owner`;

/**
 * 걷기 — git 이 지운 것만 «지웠다»고 한다. git 이 거부하면(잠긴 트리 등) 파일을 임의로 지우지 않고 사유를 낸다.
 * 등록이 «없는» 자리는 «우리 저장소가 만든 자리»임이 표지(`<path>.owner` = 이 저장소의 git 공통 디렉터리)로 확인될 때만 파일로 지운다
 * (등록 전에 죽은 시도의 잔여) — 확인 못 하면(다른 저장소 · 사용자 파일일 수 있다) 지우지 않는다.
 */
function removeWorktree(git: GitRun, repoCwd: string, path: string): { removed: boolean; reason?: string } {
  const isRegistered = registered(git, repoCwd, path);
  if (isRegistered === null) return { removed: false, reason: 'git worktree list unreadable — not removing anything' };
  if (!isRegistered && !existsSync(path)) { git(repoCwd, ['worktree', 'prune']); return { removed: true }; }
  // 등록됐든 아니든, «우리 저장소가 만든 land 자리»임이 표지로 확인될 때만 지운다 — 같은 자리의 남의 트리·파일을 지우지 않게.
  let owner: string | null = null;
  try { owner = readFileSync(ownerPath(path), 'utf8').trim(); } catch { owner = null; }
  const mine = commonDir(git, repoCwd);
  if (!owner || !mine || owner !== mine) return { removed: false, reason: 'path not proven to be this repository\'s land worktree (no owner mark) — not deleting' };
  const dropOwner = () => { try { rmSync(ownerPath(path), { force: true }); } catch { /* best effort */ } };
  if (isRegistered) {
    const removed = git(repoCwd, ['worktree', 'remove', '--force', path]);
    if (removed.status !== 0) return { removed: false, reason: `git worktree remove failed: ${(removed.stderr || removed.stdout).trim().slice(-200)}` };
    git(repoCwd, ['worktree', 'prune']);
    if (existsSync(path)) return { removed: false, reason: 'worktree path still present after git worktree remove' };
    dropOwner();
    return { removed: true };
  }
  try { rmSync(path, { recursive: true, force: true }); } catch (error) { return { removed: false, reason: `unregistered leftover not removed: ${String(error).slice(-200)}` }; }
  git(repoCwd, ['worktree', 'prune']);
  if (existsSync(path)) return { removed: false, reason: 'leftover path still present' };
  dropOwner();
  return { removed: true };
}

/** `created` — 트리를 만들었었나(모르면 null) · `removed` — 만들었다면 걷었나(만든 적 없거나 모르면 null). */
export type LandWorktreeFailure = { reason: string; created: boolean | null; removed: boolean | null };

/** PR 머리 트리를 만든다 — 못 만들면 이유 ⊕ 만들었다 걷었는지(관측용). 던지지 않는다. */
export async function createLandWorktree(input: LandWorktreeInput, deps: LandWorktreeDeps = {}): Promise<LandWorktree | LandWorktreeFailure> {
  const git = deps.git ?? defaultGit;
  const path = landWorktreePath(input.statePath, input.card, input.pr, input.head);
  const head = input.head.toLowerCase();
  const branch = input.branch;
  const fail = (reason: string, created: boolean | null = false, removed: boolean | null = null): LandWorktreeFailure => ({ reason, created, removed });
  if (!branch) return fail('PR head branch name unknown');
  if (!/^[0-9a-f]{40}$/.test(head)) return fail('PR head is not a full sha');
  // 지난 시도가 남긴 같은 자리는 먼저 걷는다(같은 PR·머리 · 재사용하지 않는다 — 상태를 모르는 트리에서 착지하지 않게).
  if (existsSync(path) || registered(git, input.repoCwd, path) !== false) {
    const stale = removeWorktree(git, input.repoCwd, path);
    if (!stale.removed) return fail(`stale land worktree could not be removed: ${stale.reason}`);
  }
  const fetched = git(input.repoCwd, ['fetch', 'origin', `pull/${input.pr}/head`]);
  if (fetched.status !== 0) return fail(`fetch pull/${input.pr}/head failed: ${(fetched.stderr || fetched.stdout).trim().slice(-200)}`);
  const fetchedHead = git(input.repoCwd, ['rev-parse', 'FETCH_HEAD']);
  if (fetchedHead.status !== 0 || fetchedHead.stdout.trim().toLowerCase() !== head) return fail(`fetched PR head ${fetchedHead.stdout.trim().slice(0, 12) || '?'} ≠ ${head.slice(0, 12)}`);
  const branchHead = (): string | null => {
    const r = git(input.repoCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return r.status === 0 ? r.stdout.trim().toLowerCase() : null;
  };
  const existingHead = branchHead();
  if (existingHead && existingHead !== head) return fail(`local branch ${branch} exists at ${existingHead.slice(0, 12)} (not the PR head) — not overwriting it`);
  const mine = commonDir(git, input.repoCwd);
  if (!mine) return fail('git common directory unreadable');
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 표지를 먼저 — 등록 전에 죽어도 다음 시도가 «우리 잔여»임을 확인하고 걷을 수 있게.
    writeFileSync(ownerPath(path), mine);
  } catch (error) { return fail(`land worktree parent unavailable: ${String(error).slice(-200)}`); }
  // `-b` 는 가지가 이미 있으면 아무것도 만들지 않고 실패한다 — 그래서 «우리가 만든 가지»는 add 가 성공했을 때만 참이다.
  let added: ReturnType<GitRun>;
  try {
    added = existingHead
      ? git(input.repoCwd, ['worktree', 'add', path, branch])
      : git(input.repoCwd, ['worktree', 'add', '-b', branch, path, head]);
  } catch (error) {
    // 던졌다 — 실패와 같게 다룬다(아래에서 부분 생성물을 걷는다).
    added = { status: null, stdout: '', stderr: (error instanceof Error ? error.message : String(error)).slice(-200) };
  }
  if (added.status !== 0) {
    // add 가 실패했다 — 가지는 우리 것이 아니다(경합으로 남이 만들었을 수 있다). 트리 자리만 정리한다.
    const addReason = `git worktree add failed: ${(added.stderr || added.stdout).trim().slice(-200)}`;
    // 트리를 전혀 못 만들었으면 표지만 걷고 removed 는 «해당 없음»(null). 일부라도 남았으면(등록·경로) 걷고 그 결과를 싣는다.
    if (!existsSync(path) && registered(git, input.repoCwd, path) === false) {
      try { rmSync(ownerPath(path), { force: true }); } catch { /* best effort */ }
      return fail(addReason, false, null);
    }
    const partial = removeWorktree(git, input.repoCwd, path);
    return fail(`${addReason} · partial tree ${partial.removed ? 'removed' : `not removed: ${partial.reason}`}`, null, partial.removed);
  }
  const createdBranch = !existingHead;
  const cleanup = (): LandWorktreeRemoval => {
    const out = removeWorktree(git, input.repoCwd, path);
    if (!createdBranch) return { ...out, branchRemoved: null };
    // 우리가 만든 가지만, 그리고 아직 그 머리에 있을 때만 지운다(그 사이 남이 옮겼으면 남긴다) — 결과는 관측에 싣는다.
    if (!out.removed) return { ...out, branchRemoved: false };
    if (branchHead() !== head) return { ...out, branchRemoved: false, reason: `branch ${branch} moved or gone — left as is` };
    const deleted = git(input.repoCwd, ['branch', '-D', branch]);
    return deleted.status === 0 ? { ...out, branchRemoved: true } : { ...out, branchRemoved: false, reason: `branch -D failed: ${(deleted.stderr || deleted.stdout).trim().slice(-200)}` };
  };
  const abort = (reason: string): LandWorktreeFailure => { const out = cleanup(); return fail(out.reason ? `${reason} · cleanup: ${out.reason}` : reason, true, out.removed); };
  // 만든 뒤의 준비·검증은 어떤 예외에도 걷고 돌아온다(실패해도 임시 트리를 남기지 않는다).
  try {
    try {
      await (deps.provideDeps ?? defaultProvideDeps)(path, input.repoCwd);
    } catch (error) {
      return abort(`dependencies unavailable: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`);
    }
    if (localHead(path, git)?.toLowerCase() !== head) return abort('land worktree HEAD is not the PR head');
    // `pr land` 는 현재 가지 = PR 가지를 요구한다 — 의존성 준비가 가지를 바꿨으면 부르기 «전»에 멈춘다.
    const current = git(path, ['branch', '--show-current']);
    if (current.status !== 0 || current.stdout.trim() !== branch) return abort(`land worktree branch is ${current.stdout.trim() || 'detached'} (expected ${branch})`);
    // `pr land --expected-head` 는 깨끗한 트리를 요구한다 — 의존성 준비가 추적 파일을 바꿨으면 부르기 «전»에 멈춘다(시도를 쓰지 않게).
    const status = git(path, ['status', '--porcelain']);
    if (status.status !== 0 || status.stdout.trim()) return abort(`land worktree not clean after dependency setup: ${status.stdout.trim().split('\n').slice(0, 3).join(' · ').slice(0, 200) || 'status unreadable'}`);
  } catch (error) {
    return abort(`land worktree check threw: ${(error instanceof Error ? error.message : String(error)).slice(-200)}`);
  }
  return { cwd: path, cleanup };
}

export function observeLandWorktree(data: { card: string; pr: number; head: string; created: boolean | null; removed: boolean | null; branchRemoved?: boolean | null; reason: string },
  log?: (category: string, event: string, data: Record<string, unknown>) => void): void {
  try { (log ?? ((c, e, d) => debug.log(c, e, d)))('task-agent', 'land-worktree', data); } catch { /* fail-soft */ }
}
