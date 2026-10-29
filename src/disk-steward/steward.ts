/**
 * 디스크 관리자 — 실행기(DISK-STEWARD-CORE · RFC-disk-steward-reclaim-on-job-end-2026-10-28 §2·§3·§5).
 *
 * 원장(`requests.jsonl`)의 새 요청 ⊕ 지난번에 «살아 있어서» 남긴 것을 모아 §2 기준으로 판정하고 지운다.
 *
 * 세 얼굴(제1원칙):
 *  - 관측: `debug.log('disk.steward', …)` — `reclaim-requested`(ledger) · `reclaimed` · `kept-open-pr` · `kept-live` ·
 *          `kept-protected` · `reclaim-failed` · `reclaim-planned`(dry-run) · `run-summary`.
 *  - 판단: `judge.ts` — 열린 PR(가지 «또는» sha) · 살아 있는 일(cwd·소유) · 보호 뿌리. 나머지는 지운다.
 *  - 수복·실패: ⛔ 열린 PR 목록·살아 있는 cwd 목록을 «못 얻으면» 그 판은 아무것도 지우지 않는다(fail-closed) ⊕
 *          `run-summary.outcome` 으로 알린다. 요청은 잃지 않고 다음 판으로 넘긴다.
 *
 * ⭐ 기본은 dry-run 이다 — 실제 삭제는 `apply: true` 를 «명시»할 때만.
 * ⭐ 발행 창(컷 −90분 ~ 공개 +30분)에는 디렉터리만 지우고 ref·`git worktree prune` 은 창 밖으로 미룬다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { listActiveTerminalDirectories } from '../harness/harness-clean.js';
import { DISK_STEWARD_CATEGORY, diskStewardStateDir, readReclaimLedger, reclaimLedgerPath, RECLAIM_KINDS } from './ledger.js';
import { judgeReclaimTarget, type OpenPrIndex, type ReclaimTarget, type TreeHead } from './judge.js';

export interface TreeInfo extends TreeHead {
  /** 이 트리의 git common dir(절대). ref 정리·prune 을 어디서 할지. */
  commonDir?: string;
  /** `.git` 이 «디렉터리»인 본 체크아웃인가(링크 워크트리는 파일). */
  mainCheckout?: boolean;
}

export type Query<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GitResult { status: number | null; stdout: string; stderr: string }

export interface DiskStewardDeps {
  stateDir?: string;
  ledgerPath?: string;
  now?: () => Date;
  listOpenPrs?: () => Query<OpenPrIndex>;
  listLiveDirectories?: () => Query<string[]>;
  readTree?: (path: string) => TreeInfo | null;
  isOwnerLive?: (owner: string | undefined) => boolean;
  protectedRoots?: readonly string[];
  isReleaseWindow?: (now: Date) => boolean;
  removeDir?: (path: string) => { ok: boolean; error?: string };
  exists?: (path: string) => boolean;
  git?: (args: string[]) => GitResult;
  sleep?: (ms: number) => Promise<void>;
}

export interface DiskStewardOptions {
  /** ⭐ 명시해야 실제로 지운다. 기본 false(dry-run). */
  apply?: boolean;
  /** 원장 밖에서 바로 넘기는 대상(순찰·밤 정리 등). */
  targets?: ReclaimTarget[];
  /** 한 판에 지우는 상한(넘치면 다음 판으로). 기본 50. */
  maxRemove?: number;
  /** 삭제 사이 쉼(ms). 기본 200. */
  pauseMs?: number;
}

export type DiskStewardOutcome = 'ok' | 'pr-list-unavailable' | 'live-list-unavailable' | 'nothing-to-do';

export interface DiskStewardEntry {
  path: string;
  kind: string;
  owner?: string;
  requester?: string;
  action: 'reclaimed' | 'planned' | 'kept-open-pr' | 'kept-live' | 'kept-protected' | 'failed' | 'deferred' | 'already-gone' | 'unjudged';
  reason: string;
}

export interface DiskStewardResult {
  outcome: DiskStewardOutcome;
  dryRun: boolean;
  releaseWindow: boolean;
  considered: number;
  reclaimed: number;
  planned: number;
  keptOpenPr: number;
  keptLive: number;
  keptProtected: number;
  failed: number;
  deferred: number;
  alreadyGone: number;
  newRequests: number;
  malformedRequests: number;
  prunedRepos: string[];
  deletedBranches: string[];
  refsDeferred: number;
  error?: string;
  entries: DiskStewardEntry[];
}

interface PendingRef { commonDir: string; branch: string }
interface StewardState { offset: number; pending: ReclaimTarget[]; pendingRefs: PendingRef[] }

const RELEASE_WINDOW_BEFORE_MS = 90 * 60_000;
const RELEASE_WINDOW_AFTER_MS = 30 * 60_000;

/** 발행 창 술어 — 컷 −90분 ~ 공개 +30분. 컷·공개 시각을 주입한다. */
export function releaseWindowPredicate(windows: ReadonlyArray<{ cutAt: Date; publishAt: Date }>): (now: Date) => boolean {
  return (now) => windows.some(({ cutAt, publishAt }) =>
    now.getTime() >= cutAt.getTime() - RELEASE_WINDOW_BEFORE_MS && now.getTime() <= publishAt.getTime() + RELEASE_WINDOW_AFTER_MS);
}

function log(event: string, data: unknown): void {
  try { debug.log(DISK_STEWARD_CATEGORY, event, data); } catch { /* 관측 실패는 판정을 깨지 않는다 */ }
}

function readState(dir: string): StewardState {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Partial<StewardState>;
    return {
      offset: Number.isSafeInteger(raw.offset) && raw.offset! >= 0 ? raw.offset! : 0,
      pending: Array.isArray(raw.pending) ? raw.pending.filter((t) => typeof t?.path === 'string'
        && (RECLAIM_KINDS as readonly string[]).includes(t.kind)) : [],
      pendingRefs: Array.isArray(raw.pendingRefs) ? raw.pendingRefs.filter((r) => typeof r?.commonDir === 'string' && typeof r?.branch === 'string') : [],
    };
  } catch { return { offset: 0, pending: [], pendingRefs: [] }; }
}

function writeState(dir: string, state: StewardState): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  // rename 은 원자적 — 반쯤 쓴 상태 파일을 남기지 않는다.
  renameSync(`${file}.tmp`, file);
}

export async function runDiskSteward(opts: DiskStewardOptions = {}, deps: DiskStewardDeps = {}): Promise<DiskStewardResult> {
  const apply = opts.apply === true;
  const maxRemove = opts.maxRemove ?? 50;
  const pauseMs = opts.pauseMs ?? 200;
  const stateDir = deps.stateDir ?? diskStewardStateDir();
  const ledgerPath = deps.ledgerPath ?? reclaimLedgerPath(dirname(stateDir));
  const now = (deps.now ?? (() => new Date()))();
  const exists = deps.exists ?? existsSync;
  const removeDir = deps.removeDir ?? defaultRemoveDir;
  const readTree = deps.readTree ?? defaultReadTree;
  const git = deps.git ?? defaultGit;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isOwnerLive = deps.isOwnerLive ?? defaultIsOwnerLive;
  const releaseWindow = (deps.isReleaseWindow ?? defaultIsReleaseWindow)(now);
  const protectedRoots = [...(deps.protectedRoots ?? defaultProtectedRoots()), stateDir];

  const state = readState(stateDir);
  const read = readReclaimLedger(ledgerPath, state.offset);
  // 같은 경로는 한 번만 — 뒤에 온 요청이 이긴다(pending → 원장 → 직접 대상 순).
  const byPath = new Map<string, ReclaimTarget>();
  for (const t of [...state.pending, ...read.requests, ...(opts.targets ?? [])]) {
    if (typeof t.path !== 'string' || !isAbsolute(t.path)) continue;
    byPath.set(resolve(t.path), { ...t, path: resolve(t.path) });
  }
  const result: DiskStewardResult = {
    outcome: 'ok', dryRun: !apply, releaseWindow, considered: byPath.size,
    reclaimed: 0, planned: 0, keptOpenPr: 0, keptLive: 0, keptProtected: 0, failed: 0, deferred: 0, alreadyGone: 0,
    newRequests: read.requests.length, malformedRequests: read.malformed,
    prunedRepos: [], deletedBranches: [], refsDeferred: 0, entries: [],
  };
  const carry: ReclaimTarget[] = [];
  const entry = (t: ReclaimTarget, action: DiskStewardEntry['action'], reason: string) => {
    result.entries.push({ path: t.path, kind: t.kind, ...(t.owner ? { owner: t.owner } : {}), ...(t.requester ? { requester: t.requester } : {}), action, reason });
  };
  const finish = (nextState: StewardState | null): DiskStewardResult => {
    if (apply && nextState) {
      try { writeState(stateDir, nextState); }
      catch (error) { result.error = `state-write-failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const { entries: _entries, ...summary } = result;
    log('run-summary', summary);
    return result;
  };

  const targets = [...byPath.values()].filter((t) => {
    if (exists(t.path)) return true;
    result.alreadyGone++;
    entry(t, 'already-gone', 'missing');
    return false;
  });
  const pendingRefs = [...state.pendingRefs];
  if (targets.length === 0 && pendingRefs.length === 0) {
    result.outcome = 'nothing-to-do';
    return finish({ offset: read.nextOffset, pending: [], pendingRefs });
  }

  // ⛔ fail-closed — 열린 PR·살아 있는 cwd 를 «모르면» 이 판은 하나도 지우지 않는다(0 으로 읽지 않는다).
  const prs = (deps.listOpenPrs ?? defaultListOpenPrs)();
  const live = prs.ok ? (deps.listLiveDirectories ?? defaultListLiveDirectories)() : null;
  if (!prs.ok || !live || !live.ok) {
    result.outcome = !prs.ok ? 'pr-list-unavailable' : 'live-list-unavailable';
    result.error = !prs.ok ? prs.error : live && !live.ok ? live.error : 'unknown';
    for (const t of targets) { entry(t, 'unjudged', result.outcome); }
    log('reclaim-failed', { reason: result.outcome, error: result.error, targets: targets.length, dryRun: !apply });
    return finish({ offset: read.nextOffset, pending: targets, pendingRefs });
  }

  const touchedRepos = new Set<string>();
  const deadBranches: PendingRef[] = [];
  for (const target of targets) {
    const tree = readTree(target.path);
    const roots = target.kind === 'worktree' && tree?.commonDir ? [...protectedRoots, tree.commonDir] : protectedRoots;
    const verdict = tree?.mainCheckout && target.kind === 'worktree'
      ? { action: 'keep' as const, reason: 'protected-root' as const, detail: 'main-checkout' }
      : judgeReclaimTarget(target, { openPrs: prs.value, liveDirectories: live.value, protectedRoots: roots, isOwnerLive, head: tree });
    const base = { path: target.path, kind: target.kind, owner: target.owner, requester: target.requester, dryRun: !apply };
    if (verdict.action === 'keep') {
      if (verdict.reason === 'open-pr') {
        // 이월하지 않는다 — PR 이 닫히면 그 트리는 draft 정리·밤 전수 점검(DRAFT-SWEEP)이 다시 요청한다(RFC §3 ③).
        result.keptOpenPr++; entry(target, 'kept-open-pr', `${verdict.match}:${verdict.detail}`);
        log('kept-open-pr', { ...base, match: verdict.match, head: verdict.detail });
      } else if (verdict.reason === 'live') {
        result.keptLive++; entry(target, 'kept-live', `${verdict.via}:${verdict.detail}`);
        log('kept-live', { ...base, via: verdict.via, detail: verdict.detail });
        carry.push(target); // RFC §3 — 살아 있어서 남긴 것은 다음 판에 다시 본다.
      } else {
        result.keptProtected++; entry(target, 'kept-protected', verdict.detail);
        log('kept-protected', { ...base, root: verdict.detail });
      }
      continue;
    }
    if (!apply) {
      result.planned++; entry(target, 'planned', verdict.reason);
      log('reclaim-planned', { ...base, reason: verdict.reason });
      continue;
    }
    if (result.reclaimed >= maxRemove) {
      result.deferred++; entry(target, 'deferred', 'max-remove'); carry.push(target);
      continue;
    }
    const removed = removeDir(target.path);
    if (removed.ok && !exists(target.path)) {
      result.reclaimed++; entry(target, 'reclaimed', verdict.reason);
      log('reclaimed', { ...base, reason: verdict.reason, branch: tree?.branch, sha: tree?.sha });
      if (target.kind === 'worktree' && tree?.commonDir) {
        touchedRepos.add(tree.commonDir);
        if (tree.branch) deadBranches.push({ commonDir: tree.commonDir, branch: tree.branch });
      }
    } else {
      result.failed++; entry(target, 'failed', removed.error ?? 'still-exists'); carry.push(target);
      log('reclaim-failed', { ...base, reason: verdict.reason, error: removed.error ?? 'still-exists' });
    }
    if (pauseMs > 0) await sleep(pauseMs);
  }

  // ref·prune — 발행 창 밖에서만. 창 안이면 다음 판으로 미룬다.
  let nextRefs: PendingRef[] = [];
  if (apply) {
    const allRefs = [...pendingRefs, ...deadBranches];
    for (const ref of allRefs) touchedRepos.add(ref.commonDir);
    if (releaseWindow) {
      nextRefs = allRefs;
      result.refsDeferred = allRefs.length;
    } else {
      for (const repo of touchedRepos) {
        const r = git(['-C', repo, 'worktree', 'prune']);
        if (r.status === 0) result.prunedRepos.push(repo);
        else log('reclaim-failed', { path: repo, kind: 'git-prune', error: r.stderr.trim() || `rc=${r.status}` });
      }
      for (const ref of allRefs) {
        if (prs.value.heads.has(ref.branch)) continue; // 그 사이 PR 이 열렸다
        const r = git(['-C', ref.commonDir, 'branch', '-D', ref.branch]);
        if (r.status === 0) result.deletedBranches.push(ref.branch);
        else if (!/not found/i.test(r.stderr)) {
          // 다른 워크트리가 그 가지를 쓰고 있는 등 — 관측만 남기고 다음 판에 다시 보지 않는다(트리가 남아 있으면 그 트리의 요청이 다시 온다).
          log('reclaim-failed', { path: ref.commonDir, kind: 'git-branch', branch: ref.branch, error: r.stderr.trim() || `rc=${r.status}` });
        }
      }
    }
  }
  return finish({ offset: read.nextOffset, pending: carry, pendingRefs: nextRefs });
}

// ── 기본 의존(실물) ────────────────────────────────────────────────

function defaultIsReleaseWindow(): boolean {
  // 발행 일정 배선은 WIRE 칸 몫이다. 그 전에는 환경변수로 손 고정할 수 있다.
  return process.env.ELANOUS_DISK_STEWARD_RELEASE_WINDOW === '1';
}

export function defaultProtectedRoots(): string[] {
  const home = homedir();
  return [join(home, 'elanous-hq', 'seats'), join(home, 'elanous-hq', 'repo.git'), effectiveInstanceRoot()]
    // 인스턴스 뿌리는 «통째로» 지우지 않게만 — 그 아래 캐시(worktrees 등)는 판정 대상이다.
    .map((p, i) => i === 2 ? join(p, 'disk-steward') : p);
}

function defaultIsOwnerLive(owner: string | undefined): boolean {
  // `pid:<n>` 만 여기서 잰다. run/seat/pod 소유의 생존 판정은 CRASH-SWEEP·WIRE 칸이 붙인다(모르면 false = 지움).
  const m = owner ? /^pid:(\d+)$/.exec(owner) : null;
  if (!m) return false;
  try { process.kill(Number(m[1]), 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function defaultGit(args: string[]): GitResult {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

export function defaultListOpenPrs(cwd: string = process.cwd()): Query<OpenPrIndex> {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '3000', '--json', 'headRefName,headRefOid'],
    { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, error: (r.stderr || String(r.error ?? `rc=${r.status}`)).trim().slice(0, 400) };
  try {
    const rows = JSON.parse(r.stdout) as Array<{ headRefName?: string; headRefOid?: string }>;
    if (!Array.isArray(rows)) return { ok: false, error: 'gh pr list: not an array' };
    return { ok: true, value: {
      heads: new Set(rows.map((x) => x.headRefName).filter((x): x is string => !!x)),
      shas: new Set(rows.map((x) => x.headRefOid).filter((x): x is string => !!x)),
    } };
  } catch (error) { return { ok: false, error: `gh pr list: ${error instanceof Error ? error.message : String(error)}` }; }
}

/** 살아 있는 프로세스 cwd(lsof) ⊕ 살아 있는 PTY workdir(공용 매니페스트). 둘 중 하나라도 못 읽으면 실패. */
export function defaultListLiveDirectories(): Query<string[]> {
  const r = spawnSync('lsof', ['-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  // lsof 는 일부 프로세스를 못 읽어도 rc=1 을 낸다 — 출력이 있으면 쓴다.
  if (!r.stdout || r.stdout.trim() === '') return { ok: false, error: `lsof: ${(r.stderr || String(r.error ?? `rc=${r.status}`)).trim().slice(0, 300)}` };
  const dirs = r.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
  const ptys = listActiveTerminalDirectories();
  if (!ptys.ok) return { ok: false, error: 'pty manifest unreadable' };
  return { ok: true, value: [...dirs, ...ptys.value] };
}

/** `.git` 을 직접 읽어 가지를 얻고(깨진 워크트리도), sha·common dir 은 git 으로 보탠다. */
export function defaultReadTree(path: string): TreeInfo | null {
  const dotGit = join(path, '.git');
  let st;
  try { st = lstatSync(dotGit); } catch { return null; }
  const info: TreeInfo = {};
  let gitDir: string | undefined;
  if (st.isDirectory()) { info.mainCheckout = true; gitDir = dotGit; }
  else {
    try {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (m) gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(path, m[1]!.trim());
    } catch { /* 아래 git 으로 */ }
  }
  if (gitDir) {
    try {
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (ref) info.branch = ref[1];
      else if (/^[0-9a-f]{40}$/.test(head)) info.sha = head;
    } catch { /* 없음 */ }
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      info.commonDir = resolve(isAbsolute(common) ? common : join(gitDir, common));
    } catch { if (info.mainCheckout) info.commonDir = gitDir; }
  }
  if (!info.sha) {
    const r = defaultGit(['-C', path, 'rev-parse', 'HEAD']);
    if (r.status === 0) info.sha = r.stdout.trim();
  }
  return info;
}

/** 낮은 우선순위로 지운다 — macOS 는 배경 QoS(`taskpolicy -b`), 그 밖은 `nice -n 19`. */
function defaultRemoveDir(path: string): { ok: boolean; error?: string } {
  const [cmd, args] = process.platform === 'darwin'
    ? ['taskpolicy', ['-b', 'rm', '-rf', '--', path]] as const
    : ['nice', ['-n', '19', 'rm', '-rf', '--', path]] as const;
  const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 30 * 60_000 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    try { rmSync(path, { recursive: true, force: true }); return { ok: true }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || String(r.error ?? `rc=${r.status}`)).trim().slice(0, 300) };
}
