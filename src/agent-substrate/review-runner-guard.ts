/**
 * A204 REVIEW-RUNNER-ROBUST — review runner pre-admission guards.
 *
 * Three faces (관측 · 판단 근거 · 수복과 인계):
 * - needs-clean-branch: a PR whose base..head carries a merge with hand-resolved
 *   content cannot be reviewed as a delta (`main-merge-has-resolution-changes`).
 *   Before 11-17 the runner refused and was re-launched again and again (#38029).
 *   Since REVIEW-ACCEPT-MERGE-MAIN (0.3.38 P0) such a PR is reviewed as merge-base..head
 *   (the PR's own change, resolutions included) — the land policy merges main into PRs.
 * - identity freeze: head + body sha are frozen when a review starts; a mismatch at
 *   the end names exactly which side changed (#38047 body edited mid-review).
 * - one review-slot ledger: OP and RES launches share the existing
 *   `review-acp-slots/<n>.d` registry, keyed by PR+head, bounded by the canonical
 *   review cap file (read, never written).
 *
 * Every side effect goes through injected seams so tests use fake git/gh/fs clocks.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type RunResult = { status: number | null; stdout: string; stderr: string };
export type GitRunner = (args: string[]) => RunResult;
export type GhRunner = (args: string[]) => RunResult;

const OID = /^[0-9a-f]{40}$/i;

/** One-line author instruction for a merge-commit PR (Korean, verbatim from A204). */
export const NEEDS_CLEAN_BRANCH_AUTHOR_ACTION =
  '병합 커밋 없는 깨끗한 가지 필요 — 현재 main 위에 새 가지로 다시 쌓고 새 PR 로 대체';

/** Delta refusals the review CLI answers with a merge-base..head review (REVIEW-ACCEPT-MERGE-MAIN), never a refusal. */
export const NEEDS_CLEAN_BRANCH_DELTA_REFUSALS: ReadonlySet<string> = new Set([
  'main-merge-has-resolution-changes',
]);

export interface NeedsCleanBranchOutcome {
  pr: string;
  headCommit: string;
  reviewed: false;
  verdict: null;
  refusal: 'needs-clean-branch';
  /** Kept so existing consumers (auto-chain `premodel_refusal`) still classify it as pre-model. */
  modelStarted: false;
  terminal: true;
  retryable: false;
  authorAction: string;
  reason: string;
  mergeCommits: string[];
}

export function needsCleanBranchOutcome(pr: string, headCommit: string, reason: string, mergeCommits: string[] = []): NeedsCleanBranchOutcome {
  return {
    pr, headCommit, reviewed: false, verdict: null, refusal: 'needs-clean-branch', modelStarted: false,
    terminal: true, retryable: false, authorAction: NEEDS_CLEAN_BRANCH_AUTHOR_ACTION, reason, mergeCommits,
  };
}

export type MergePreflight =
  | { status: 'clean'; mergeCommits: string[] }
  /** REVIEW-ACCEPT-MERGE-MAIN: hand-resolved main merges are reviewed as merge-base..head, never refused. */
  | { status: 'clean'; mergeCommits: string[]; reviewedDiff: 'merge-base'; mergeBase: string; resolutionMerges: string[]; smartMerges?: string[] }
  | { status: 'unmeasured'; reason: string }
  | NeedsCleanBranchOutcome;

/**
 * Inspect merge-base(baseTip, head)..head before any reviewer is admitted.
 * REVIEW-ACCEPT-MERGE-MAIN (0.3.38 P0): the land policy merges main into PR branches, so a
 * merge whose remerge-diff is non-empty (hand-resolved content) is reviewable — the reviewer
 * reads the PR's own change merge-base..head (resolutions included, main-side changes not).
 * It is `clean` with `reviewedDiff: 'merge-base'`; it no longer returns needs-clean-branch.
 * A remerge-diff that cannot be computed (timeout · old git · missing object) is
 * `unmeasured` with `main-merge-resolution-unknown` (non-terminal).
 * Git failures before merges are known are `unmeasured`: the caller keeps its old path.
 */
export function preflightMergeHistory(input: { pr: string; head: string; baseTip: string; git: GitRunner }): MergePreflight {
  const { pr, head, baseTip, git } = input;
  if (!OID.test(head) || !OID.test(baseTip)) return { status: 'unmeasured', reason: 'head-or-base-not-oid' };
  const mergeBase = git(['merge-base', baseTip, head]);
  const base = mergeBase.stdout.trim();
  if (mergeBase.status !== 0 || !OID.test(base)) return { status: 'unmeasured', reason: 'merge-base-unavailable' };
  const merges = git(['rev-list', '--merges', `${base}..${head}`]);
  if (merges.status !== 0) return { status: 'unmeasured', reason: 'merge-list-unavailable' };
  const mergeCommits = merges.stdout.split(/\s+/).filter(Boolean);
  const resolved: string[] = [];
  let unknown = false;
  for (const merge of mergeCommits) {
    const remerge = git(['show', '--remerge-diff', '--format=', '--no-ext-diff', '--no-color', merge]);
    if (remerge.status !== 0) { unknown = true; continue; }
    if (remerge.stdout.trim()) resolved.push(merge);
  }
  // Proven resolution wins over an unmeasured sibling merge: the merge-base diff covers both.
  if (resolved.length > 0) {
    // SMART-MERGE: merges git-smart wrote carry a `Smart-Merge:` trailer (rebuild / merge + ladder steps) — same rule as a
    // hand-resolved merge (review the PR-own delta merge-base..head), only labelled.
    const smart = resolved.filter(m => /^Smart-Merge:/m.test(git(['show', '-s', '--format=%B', m]).stdout));
    return { status: 'clean', mergeCommits, reviewedDiff: 'merge-base', mergeBase: base.toLowerCase(), resolutionMerges: resolved, ...(smart.length ? { smartMerges: smart } : {}) };
  }
  if (unknown) return { status: 'unmeasured', reason: 'main-merge-resolution-unknown' };
  return { status: 'clean', mergeCommits };
}

// ── identity freeze ─────────────────────────────────────────────────────────

export interface PrIdentity { head: string; bodySha256: string }
export interface FrozenIdentity extends PrIdentity { pr: string; frozenAt: string; markerCommentId?: string }

export function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function readPrIdentity(pr: string, gh: GhRunner): PrIdentity | { error: string } {
  const view = gh(['pr', 'view', pr, '--json', 'headRefOid,body']);
  if (view.status !== 0) return { error: 'pr-identity-unavailable' };
  try {
    const parsed = JSON.parse(view.stdout) as { headRefOid?: unknown; body?: unknown };
    if (typeof parsed.headRefOid !== 'string' || !OID.test(parsed.headRefOid) || typeof parsed.body !== 'string') {
      return { error: 'pr-identity-malformed' };
    }
    return { head: parsed.headRefOid.toLowerCase(), bodySha256: bodySha256(parsed.body) };
  } catch {
    return { error: 'pr-identity-malformed' };
  }
}

export const FREEZE_MARKER_BODY = '리뷰 중 — 본문·head 동결';
export const FREEZE_RELEASED_BODY = '리뷰 끝 — 본문·head 동결 해제';

/** Body-independent marker: a PR comment. Its id is kept so the end can update it. */
export function postFreezeMarker(pr: string, frozen: PrIdentity, gh: GhRunner): string | undefined {
  const body = `${FREEZE_MARKER_BODY} (head ${frozen.head.slice(0, 12)} · body sha ${frozen.bodySha256.slice(0, 12)})`;
  const posted = gh(['pr', 'comment', pr, '--body', body]);
  if (posted.status !== 0) return undefined;
  return /#issuecomment-(\d+)/.exec(posted.stdout)?.[1];
}

export function releaseFreezeMarker(commentId: string | undefined, outcome: string, gh: GhRunner): boolean {
  if (!commentId || !/^\d+$/.test(commentId)) return false;
  const body = `${FREEZE_RELEASED_BODY} (결과: ${outcome})`;
  return gh(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${commentId}`, '-f', `body=${body}`]).status === 0;
}

export type IdentityCheck =
  | { match: true }
  | {
    match: false;
    refusal: 'identity-changed-during-review';
    changed: Array<'head' | 'body'>;
    frozen: PrIdentity;
    current: PrIdentity;
    /** Change happened in (frozenAt, detectedAt]; the runner cannot see it more precisely. */
    frozenAt: string;
    detectedAt: string;
    actor: 'author';
    authorAction: string;
  };

export function compareFrozenIdentity(frozen: FrozenIdentity, current: PrIdentity, detectedAt: string): IdentityCheck {
  const changed: Array<'head' | 'body'> = [];
  if (frozen.head.toLowerCase() !== current.head.toLowerCase()) changed.push('head');
  if (frozen.bodySha256 !== current.bodySha256) changed.push('body');
  if (changed.length === 0) return { match: true };
  const what = changed.map((side) => (side === 'head' ? 'head(새 커밋 push)' : 'PR 본문 수정')).join(' · ');
  return {
    match: false, refusal: 'identity-changed-during-review', changed,
    frozen: { head: frozen.head, bodySha256: frozen.bodySha256 }, current, frozenAt: frozen.frozenAt, detectedAt,
    actor: 'author',
    authorAction: `작성자 행위: 리뷰 중 ${what} (${frozen.frozenAt} 이후 ~ ${detectedAt} 사이) — 리뷰가 끝날 때까지 본문·head 를 고치지 말고, 고쳤다면 새 리뷰를 다시 요청`,
  };
}

// ── single review-slot ledger ───────────────────────────────────────────────

export const LEDGER_SCHEMA = 'review-slot-ledger/v1';
/** Source: review-claude-acp-75868.py `review_slots()` counts registry names 1.d..4.d (OP 11-16 23:4x 전역 4). */
export const LEGACY_REGISTRY_WIDTH = 4;
/**
 * Source: review-claude-acp-75868.py stops its model child after 660s and refreshes
 * quota every 120s; a v1 holder whose heartbeat is older than this has outlived any admitted review.
 */
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

export interface SlotOwner {
  ledger: typeof LEDGER_SCHEMA;
  token: string;
  pr: string;
  head: string;
  seat: string;
  engine: string;
  host: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
  frozen?: FrozenIdentity;
}

/**
 * A terminal needs-clean-branch record is keyed by PR+head, so a re-stacked branch (new head)
 * never meets it. The expiry only bounds a wrong or stale record: it is read as absent and removed.
 */
// 출처: OP A204 #38060 Claude r1 MF — 종단 기록에 만료 길 · 발행 하루 주기(06:00 컷)와 같은 하루
export const TERMINAL_REFUSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Reasons a terminal record may still carry. Empty since REVIEW-ACCEPT-MERGE-MAIN (0.3.38 P0):
 * hand-resolved main merges are reviewed as merge-base..head, so any older record is cleared.
 */
export const TERMINAL_REFUSAL_REASONS: ReadonlySet<string> = new Set<string>();

export interface LedgerDeps {
  root: string;
  /** Canonical review cap file (K-EAST heavy-slot-review-cap.txt). Read only. */
  capFile: string;
  now(): number;
  host: string;
  pid: number;
  /** Same-host liveness probe for a recorded pid. */
  pidAlive(pid: number): boolean;
  staleAfterMs?: number;
  token?(): string;
}

export type AcquireResult =
  | { status: 'acquired'; slot: string; token: string; owner: SlotOwner; reclaimed: string[] }
  | { status: 'already-reviewing'; slot: string; holder: Partial<SlotOwner> }
  | { status: 'cap-full'; cap: number; occupied: number; reclaimed: string[] }
  | { status: 'terminal-refusal'; record: Record<string, unknown> }
  | { status: 'ledger-busy' }
  | { status: 'cap-unavailable'; reason: string };

export function readCanonicalReviewCap(capFile: string): { cap: number } | { reason: string } {
  try {
    const raw = readFileSync(capFile, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return { reason: 'review-cap-not-integer' };
    const cap = Number(raw);
    return cap >= 1 ? { cap } : { reason: 'review-cap-disabled' };
  } catch {
    return { reason: 'review-cap-file-missing' };
  }
}

function safeKey(pr: string, head: string): string {
  return `${pr.replace(/\D/g, '')}-${head.toLowerCase().replace(/[^0-9a-f]/g, '')}`;
}

function readOwner(slotDir: string): Partial<SlotOwner> | undefined {
  try {
    return JSON.parse(readFileSync(join(slotDir, 'owner.json'), 'utf8')) as Partial<SlotOwner>;
  } catch {
    return undefined; // legacy owner.txt-only slot or a writer mid-write: occupied, owner unknown
  }
}

function slotNames(width: number): string[] {
  return Array.from({ length: width }, (_, index) => `${index + 1}.d`);
}

export class ReviewSlotLedger {
  constructor(private readonly deps: LedgerDeps) {}

  private get staleAfterMs(): number { return this.deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS; }
  private get mutex(): string { return join(this.deps.root, '.ledger-mutex.d'); }
  terminalPath(pr: string, head: string): string { return join(this.deps.root, 'terminal', `${safeKey(pr, head)}.json`); }

  /** Short critical section; a dead or stale mutex owner is archived, never deleted silently. */
  private withMutex<T>(fn: () => T): T | { status: 'ledger-busy' } {
    mkdirSync(this.deps.root, { recursive: true });
    try {
      mkdirSync(this.mutex);
    } catch {
      const holder = (() => { try { return JSON.parse(readFileSync(join(this.mutex, 'owner.json'), 'utf8')) as { pid?: number; host?: string; at?: number }; } catch { return undefined; } })();
      const dead = holder && holder.host === this.deps.host && typeof holder.pid === 'number' && !this.deps.pidAlive(holder.pid);
      const stale = holder && typeof holder.at === 'number' && this.deps.now() - holder.at > this.staleAfterMs;
      if (!(dead || stale)) return { status: 'ledger-busy' };
      this.archive(this.mutex, 'mutex');
      try { mkdirSync(this.mutex); } catch { return { status: 'ledger-busy' }; }
    }
    writeFileSync(join(this.mutex, 'owner.json'), JSON.stringify({ pid: this.deps.pid, host: this.deps.host, at: this.deps.now() }));
    try {
      return fn();
    } finally {
      rmSync(this.mutex, { recursive: true, force: true });
    }
  }

  private archive(dir: string, why: string): string {
    const dest = join(this.deps.root, '_archive', `${dir.split('/').pop()}.${why}-${this.deps.now()}-${this.deps.pid}`);
    mkdirSync(join(this.deps.root, '_archive'), { recursive: true });
    renameSync(dir, dest);
    return dest;
  }

  private width(cap: number): number { return Math.max(cap, LEGACY_REGISTRY_WIDTH); }

  /** A v1 holder is stale when its heartbeat is old AND it is not a live same-host process. */
  isStale(owner: Partial<SlotOwner> | undefined): boolean {
    if (!owner || owner.ledger !== LEDGER_SCHEMA || typeof owner.heartbeatAt !== 'number') return false; // legacy/foreign: never reclaimed here
    if (this.deps.now() - owner.heartbeatAt <= this.staleAfterMs) return false;
    return !(owner.host === this.deps.host && typeof owner.pid === 'number' && this.deps.pidAlive(owner.pid));
  }

  private reclaimStaleLocked(width: number): string[] {
    const reclaimed: string[] = [];
    for (const name of slotNames(width)) {
      const dir = join(this.deps.root, name);
      if (!existsSync(dir)) continue;
      if (this.isStale(readOwner(dir))) reclaimed.push(this.archive(dir, 'stale'));
    }
    return reclaimed;
  }

  reclaimStale(): { reclaimed: string[] } | { status: 'ledger-busy' } | { status: 'cap-unavailable'; reason: string } {
    const cap = readCanonicalReviewCap(this.deps.capFile);
    if ('reason' in cap) return { status: 'cap-unavailable', reason: cap.reason };
    return this.withMutex(() => ({ reclaimed: this.reclaimStaleLocked(this.width(cap.cap)) }));
  }

  acquire(input: { pr: string; head: string; seat: string; engine: string; frozen?: FrozenIdentity }): AcquireResult {
    const head = input.head.toLowerCase();
    const terminal = this.terminalRefusal(input.pr, head);
    if (terminal) return { status: 'terminal-refusal', record: terminal };
    const cap = readCanonicalReviewCap(this.deps.capFile);
    if ('reason' in cap) return { status: 'cap-unavailable', reason: cap.reason };
    const result = this.withMutex((): AcquireResult => {
      const width = this.width(cap.cap);
      const reclaimed = this.reclaimStaleLocked(width);
      let occupied = 0;
      const free: string[] = [];
      for (const name of slotNames(width)) {
        const dir = join(this.deps.root, name);
        if (!existsSync(dir)) { free.push(name); continue; }
        occupied += 1;
        const owner = readOwner(dir);
        if (owner && String(owner.pr) === input.pr && String(owner.head ?? '').toLowerCase() === head) {
          return { status: 'already-reviewing', slot: name, holder: owner };
        }
      }
      const pick = free.find((name) => Number(name.split('.')[0]) <= cap.cap) ?? free[0];
      if (occupied >= cap.cap || !pick) return { status: 'cap-full', cap: cap.cap, occupied, reclaimed };
      const token = this.deps.token?.() ?? randomBytes(16).toString('hex');
      const at = this.deps.now();
      const owner: SlotOwner = {
        ledger: LEDGER_SCHEMA, token, pr: input.pr, head, seat: input.seat, engine: input.engine,
        host: this.deps.host, pid: this.deps.pid, acquiredAt: at, heartbeatAt: at,
        ...(input.frozen ? { frozen: input.frozen } : {}),
      };
      const dir = join(this.deps.root, pick);
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner, null, 2));
      return { status: 'acquired', slot: pick, token, owner, reclaimed };
    });
    return result;
  }

  private ownedSlot(token: string): { dir: string; owner: SlotOwner } | undefined {
    if (!existsSync(this.deps.root)) return undefined;
    for (const name of readdirSync(this.deps.root)) {
      if (!/^\d+\.d$/.test(name)) continue;
      const owner = readOwner(join(this.deps.root, name));
      if (owner?.ledger === LEDGER_SCHEMA && owner.token === token) return { dir: join(this.deps.root, name), owner: owner as SlotOwner };
    }
    return undefined;
  }

  owner(token: string): SlotOwner | undefined {
    return this.ownedSlot(token)?.owner;
  }

  attachMarker(token: string, markerCommentId: string): boolean {
    const slot = this.ownedSlot(token);
    if (!slot?.owner.frozen) return false;
    const owner = { ...slot.owner, frozen: { ...slot.owner.frozen, markerCommentId } };
    writeFileSync(join(slot.dir, 'owner.json'), JSON.stringify(owner, null, 2));
    return true;
  }

  heartbeat(token: string): boolean {
    const slot = this.ownedSlot(token);
    if (!slot) return false;
    writeFileSync(join(slot.dir, 'owner.json'), JSON.stringify({ ...slot.owner, heartbeatAt: this.deps.now() }, null, 2));
    return true;
  }

  release(token: string, outcome: Record<string, unknown> = {}): boolean {
    const slot = this.ownedSlot(token);
    if (!slot) return false;
    writeFileSync(join(slot.dir, 'outcome.json'), JSON.stringify({ ...outcome, releasedAt: this.deps.now() }));
    this.archive(slot.dir, 'released');
    return true;
  }

  /** Read-only view for seat tools: is this PR frozen by a running review? */
  status(pr: string): { frozen: boolean; holders: Array<Partial<SlotOwner> & { slot: string; stale: boolean }>; terminal: Array<Record<string, unknown>> } {
    const holders: Array<Partial<SlotOwner> & { slot: string; stale: boolean }> = [];
    if (existsSync(this.deps.root)) {
      for (const name of readdirSync(this.deps.root).sort()) {
        if (!/^\d+\.d$/.test(name)) continue;
        const owner = readOwner(join(this.deps.root, name));
        if (owner && String(owner.pr) === pr) holders.push({ ...owner, slot: name, stale: this.isStale(owner) });
      }
    }
    const terminal: Array<Record<string, unknown>> = [];
    const terminalDir = join(this.deps.root, 'terminal');
    if (existsSync(terminalDir)) {
      for (const name of readdirSync(terminalDir)) {
        if (!name.startsWith(`${pr.replace(/\D/g, '')}-`)) continue;
        try { terminal.push(JSON.parse(readFileSync(join(terminalDir, name), 'utf8')) as Record<string, unknown>); } catch { /* unreadable record stays visible by name only */ }
      }
    }
    return { frozen: holders.some((holder) => !holder.stale), holders, terminal };
  }

  recordTerminalRefusal(outcome: NeedsCleanBranchOutcome): string {
    const path = this.terminalPath(outcome.pr, outcome.headCommit);
    mkdirSync(join(this.deps.root, 'terminal'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...outcome, recordedAt: this.deps.now() }, null, 2));
    return path;
  }

  /**
   * The recorded refusal for PR+head, or undefined. A record past TERMINAL_REFUSAL_TTL_MS, an
   * unreadable one, or one whose reason is not in TERMINAL_REFUSAL_REASONS is removed and read
   * as absent — the next preflight measures again. REVIEW-ACCEPT-MERGE-MAIN: older
   * `main-merge-has-resolution-changes` records are no longer terminal (merge-base review).
   */
  terminalRefusal(pr: string, head: string): Record<string, unknown> | undefined {
    const path = this.terminalPath(pr, head);
    if (!existsSync(path)) return undefined;
    let record: Record<string, unknown> | undefined;
    try { record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { record = undefined; }
    const recordedAt = typeof record?.recordedAt === 'number' ? record.recordedAt : Number.NaN;
    const valid = record !== undefined
      && typeof record.reason === 'string' && TERMINAL_REFUSAL_REASONS.has(record.reason)
      && Number.isFinite(recordedAt)
      && this.deps.now() - recordedAt < TERMINAL_REFUSAL_TTL_MS;
    if (valid) return record;
    this.clearTerminalRefusal(pr, head);
    return undefined;
  }

  /** Remove the terminal record for PR+head (operator path: `review-runner-guard clear`). */
  clearTerminalRefusal(pr: string, head: string): boolean {
    const path = this.terminalPath(pr, head);
    if (!existsSync(path)) return false;
    try { rmSync(path, { force: true }); return true; } catch { return false; }
  }
}
