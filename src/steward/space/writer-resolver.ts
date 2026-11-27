// WRITER-CHECK-RESOLVER (대표 11-25 22:4x «구조로 멈춰라»)
// S: in 30 min TC got 55 ✋, nearly all one family — «기존 writer 인계·범위 확인 / HOLD 해제 / 작업트리 경로 / 격리·슬롯 승인 전
//    편집·시험 금지». TC answered «HOLD» again and again although its own rule (writer check ≤2 min) already gives the answer.
// C: the answer is a lookup, not a judgement — open PR on the paths? recent commit by another seat? uncommitted files? which worktree?
// Q: who answers? A: the space steward tick — deterministic, before the beacon:
//   cause (structured: ref `cause:<c>`; legacy ✋ without it → the block code OWNER_UNKNOWN = writer-handover (DEPENDENCY_WAIT is
//   not a writer question — WRITER-CHECK-INTENT-GATE 11-26),
//   APPROVAL_PENDING = res-approval; never the prose) → answer → HandRaise resolve with owner = blocked seat ⊕ deadline +30 m
//   (a real outcome under BEACON-LADDER ②) → one digest line per leader per tick. A leader HOLD (no owner ⊕ deadline) on that
//   chain is overridden and logged. What it cannot answer (worktree unknown) climbs as ONE card per cause to HQ.
// 세 얼굴 = 관측 needhuman.resolver-* 로그 ⊕ digest 줄 · 판단 근거 = 답에 PR 번호·커밋·경로 원문 · 수복 = resolve / 원인별 카드 1장.
import { liveWipTakeoverRule } from '../../seat/seat-assign-wip1.js';
import { WRITER_CHECK_CAUSES, isWriterCheckCause, type HandCause } from '../../agent-events/protocol.js';
import type { MsgStore } from '../../msg/msg-store.js';
import { readHandRoutes } from '../../kit/mail-route/hand-routes.js';
import {
  appendOnce, applyHandOutcome, HAND_CEO, isCeoOnlyHand, keepsWaiting, lastLeaderReply, openHands,
  type HandLadderDeps, type OpenHand,
} from '../../msg/hand-raise-ladder.js';

export const RESOLVER_DEADLINE_MS = 30 * 60_000;
export const RECENT_COMMIT_MS = 2 * 60 * 60_000;
export const RESOLVER_SENDER = 'ORCHESTRATOR';
/** plan-limit (live 11-27 23:0x): the TUI's auto-continue cap — not an LLM quota, nothing for GUARDIAN to fix. Resume. */
export const PLAN_LIMIT_AUTO_ANSWER = '재개 — plan-limit is the TUI auto-continue cap (not an LLM quota). Continue the open steps; if a step waits on your own background process, wait for it and update the plan instead of asking again';
export const PLAN_LIMIT_WINDOW_MS = 60 * 60_000;
export const POLICY_AUTO_ANSWER = 'policy auto (guardian caps) · RES absorbed — no approval needed; test-universe runs never need one (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head push to minim5/node-b/node-c) — only secrets · other users\' data · public exposure · destructive deletes · publish/money ask';

export interface OpenPr { readonly number: number; readonly branch: string; readonly files: readonly string[] }
export interface RecentCommit { readonly sha: string; readonly seat: string; readonly files: readonly string[] }

/** Read-only lookups (live = gh · git; tests = literals). Each may throw — a throw is «unknown», never a crash. */
export interface WriterCheckPorts {
  /** The seat's worktree path: ref `worktree:` first, else git worktree list / branch name. null = not found. */
  worktreeOf(seat: string, hint?: string): string | null;
  /** Uncommitted files in a worktree. */
  uncommitted(worktree: string): readonly string[];
  /** Open PRs with their files (one read per tick). */
  openPrs(): readonly OpenPr[];
  /** Commits within RECENT_COMMIT_MS with the seat that made them. */
  recentCommits(): readonly RecentCommit[];
}

export type ResolverVerdict =
  | { readonly kind: 'resolve'; readonly cause: HandCause; readonly answer: string; readonly coordinateWith?: string }
  | { readonly kind: 'escalate'; readonly cause: HandCause; readonly why: string };

const refValue = (refs: readonly string[] | undefined, prefix: string): string | undefined =>
  refs?.find((r) => r.startsWith(prefix))?.slice(prefix.length) || undefined;

/** The ✋'s cause from structured fields only (ref `cause:`, else the block code). null = not this family. */
export function handCauseOf(hand: Pick<OpenHand, 'reason' | 'refs'>): HandCause | null {
  // money · security · irreversible · policy stay with people (category / urgency refs); the cause ref outranks the block code.
  if (isCeoOnlyHand({ reason: '', refs: hand.refs })) return null;
  const cause = refValue(hand.refs, 'cause:');
  // hold · cell-scope are not the writer check's family: they route to their owners (hand-routes.yaml).
  if (cause !== undefined) return isWriterCheckCause(cause) ? cause : null;
  // A ✋ whose root the router (Jev) read as the auto-continue cap — an older TUI that sent no `cause:` for it.
  if ((hand.refs ?? []).some((r) => r.startsWith('hand-ask:auto-continue:'))) return 'plan-limit';
  // WRITER-CHECK-INTENT-GATE (11-26 23:xx · 28 wrong auto-answers): only an ownership question is a writer check.
  // DEPENDENCY_WAIT waits on something else (a PR, a seat, an approval) — it stays on the ✋ ladder (#40318 escalation) or
  // the hand parks it with `eln work block --on <ref>`; the writer lookup never answers it.
  if (hand.reason === 'OWNER_UNKNOWN') return 'writer-handover';
  if (hand.reason === 'APPROVAL_PENDING') return 'res-approval';
  return null;
}

const attempt = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
const overlap = (a: readonly string[], b: readonly string[]): boolean => a.some((x) => b.includes(x));

/** The resolver's answer for one ✋ (pure over the ports). */
export function resolveWriterCheck(hand: Pick<OpenHand, 'reason' | 'refs' | 'blockedSeat'>, ports: WriterCheckPorts, cache?: { prs?: readonly OpenPr[] | null; commits?: readonly RecentCommit[]; planLimitHits?: (seat: string) => number; planLimitCardAt?: number }): ResolverVerdict | null {
  const cause = handCauseOf(hand);
  if (!cause) return null;
  const seat = hand.blockedSeat;
  if (cause === 'plan-limit') {
    // The 행정관 resumes the hand; the same hand at the cap N times in an hour → its leader gets the open steps instead.
    const hits = attempt(() => cache?.planLimitHits?.(seat) ?? 1, 1);
    const cardAt = cache?.planLimitCardAt ?? 3;
    return hits >= cardAt
      ? { kind: 'escalate', cause, why: `${seat} hit the auto-continue cap ${hits}× within 1h — resuming again would loop` }
      : { kind: 'resolve', cause, answer: PLAN_LIMIT_AUTO_ANSWER };
  }
  if (cause === 'res-approval' || cause === 'slot-isolation') return { kind: 'resolve', cause, answer: POLICY_AUTO_ANSWER };
  const worktree = attempt(() => ports.worktreeOf(seat, refValue(hand.refs, 'worktree:')), null);
  if (cause === 'worktree-path') {
    return worktree ? { kind: 'resolve', cause, answer: `your worktree is ${worktree} — proceed there` }
      : { kind: 'escalate', cause, why: `no worktree found for ${seat} (refs · git worktree list · branch name)` };
  }
  // writer-handover: the writer check (≤2 min rule) done for the seat.
  const dirty = worktree ? attempt(() => ports.uncommitted(worktree), []) : [];
  // Dirty files are not evidence of the task or cell's scope: they may belong to unrelated WIP.
  const taskPaths = [...new Set((hand.refs ?? []).filter((r) => r.startsWith('path:')).map((r) => r.slice(5)).filter(Boolean))];
  const paths = [...new Set([...taskPaths, ...dirty])];
  const prRef = refValue(hand.refs, 'pr:');
  const prNum = Number(prRef);
  const prs = cache?.prs === undefined ? attempt<readonly OpenPr[] | null>(() => ports.openPrs(), null) : cache.prs;
  if (!prs) return { kind: 'escalate', cause, why: 'open PR lookup failed; relevance is unknown — do not hand over' };
  const explicitPr = prRef ? prs.find((p) => p.number === prNum) : undefined;
  if (prRef && (!explicitPr || !taskPaths.length || !explicitPr.files.length || !overlap(explicitPr.files, taskPaths))) {
    return { kind: 'escalate', cause, why: `PR ${prRef} relevance to task/cell paths is unverified or mismatched — do not hand over` };
  }
  const pr = explicitPr ?? (taskPaths.length ? prs.find((p) => overlap(p.files, taskPaths)) : undefined);
  if (pr) return { kind: 'resolve', cause, answer: `open PR #${pr.number} touches these paths — continue on top of its branch ${pr.branch}` };
  const commits = cache?.commits ?? attempt(() => ports.recentCommits(), []);
  const other = paths.length ? commits.find((c) => c.seat.toUpperCase() !== seat.toUpperCase() && overlap(c.files, paths)) : undefined;
  if (other) return { kind: 'resolve', cause, coordinateWith: other.seat, answer: `${other.seat} committed ${other.sha.slice(0, 10)} on these files within 2h — one mail to ${other.seat} is sent for you; proceed in 30 min` };
  if (dirty.length) return { kind: 'resolve', cause, answer: `uncommitted files in ${worktree} (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''}) — ${liveWipTakeoverRule()}` };
  // «You are the writer» only when the lookup actually ran on named paths. No paths, no PR ref, no dirty files = nothing was
  // checked — never the generic «proceed» (11-26: 28 ✋ got it while they waited on something else); it climbs instead.
  if (!paths.length) return { kind: 'escalate', cause, why: `${seat} named no paths (path: refs) and has no uncommitted files — the writer check has nothing to look up` };
  return { kind: 'resolve', cause, answer: 'no open PR and no recent commit on these paths — you are the writer; proceed' };
}

export interface ResolverReport {
  readonly resolved: readonly { readonly msgId: number; readonly seat: string; readonly leader: string; readonly cause: HandCause; readonly answer: string; readonly overrode: boolean }[];
  readonly cards: readonly { readonly cause: HandCause; readonly members: readonly number[]; readonly cardId: number }[];
  readonly digests: readonly string[];
}

const DIGEST = (leader: string, rows: readonly { msgId: number; cause: string }[]): string => {
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.cause, [...(by.get(r.cause) ?? []), r.msgId]);
  return `[행정관 · writer-check] ${leader}: resolved ${rows.length} ✋ — ${[...by].map(([c, ids]) => `${c} ×${ids.length} (${ids.map((i) => `#${i}`).join(' ')})`).join(' · ')} · 회신 불필요`;
};

/**
 * One resolver tick over the open ✋ (idempotent: a resolved ✋ is closed; cards by provenance). live=false computes only.
 */
export function runWriterCheckResolver(store: MsgStore, deps: HandLadderDeps & { readonly ports: WriterCheckPorts; readonly live?: boolean }): ResolverReport {
  const now = deps.now();
  const log = (e: string, d: Record<string, unknown>): void => { try { deps.log?.(e, d); } catch { /* observation never breaks the tick */ } };
  const seen = new Set<number>();
  // Live 11-25 23:0x: the family's open copies sat at CLAUDE-OP (TC → OP → CEO copy) — every rung below the CEO answers.
  const opens = openHands(store, { now, ladder: deps.ladder }).filter((h) => {
    if (h.receiver === HAND_CEO || seen.has(h.rootId)) return false;
    seen.add(h.rootId);
    return true;
  });
  // plan-limit ✋ the seat raised in the last hour (structured: `cause:plan-limit` or the router's auto-continue ask root).
  const planLimitHits = (seat: string): number => (store.db.query(`SELECT COUNT(*) AS n FROM msg_messages WHERE sender = ? AND created_at >= ?
    AND (refs_json LIKE '%"cause:plan-limit"%' OR refs_json LIKE '%"hand-ask:auto-continue:%')`).get(seat, new Date(now - PLAN_LIMIT_WINDOW_MS).toISOString()) as { n: number }).n;
  const planLimitCardAt = attempt(() => readHandRoutes().autoContinueCardAfterHitsPerHour, 3);
  const cache = { prs: attempt<readonly OpenPr[] | null>(() => deps.ports.openPrs(), null), commits: attempt(() => deps.ports.recentCommits(), [] as readonly RecentCommit[]), planLimitHits, planLimitCardAt };
  const resolved: ResolverReport['resolved'][number][] = [];
  const unresolved = new Map<HandCause, OpenHand[]>();
  const deadline = new Date(now + RESOLVER_DEADLINE_MS).toISOString();
  for (const hand of opens) {
    const verdict = resolveWriterCheck(hand, deps.ports, cache);
    if (!verdict) continue;
    if (verdict.kind === 'escalate' && verdict.cause === 'plan-limit') {
      // Not a writer question for HQ: ONE card to the hand's leader (TC) with the plan's open steps (the ✋ line names them).
      const leader = attempt(() => deps.ladder.parentOf(hand.blockedSeat), hand.receiver);
      if (deps.live !== false) {
        const { fresh, mail } = appendOnce(store, `hand-plan-limit-card:${hand.rootId}`, () => ({
          from: RESOLVER_SENDER, to: leader, kind: 'request', intent: 'decision',
          refs: [`hand-of:${hand.rootId}`, `seat:${hand.blockedSeat}`, 'cause:plan-limit', 'plan-limit-card'],
          body: `[행정관 · plan-limit] ${verdict.why}. ✋ #${hand.rootId}: ${hand.body.replace(/\s+/gu, ' ').slice(0, 300)} · `
            + `re-scope the plan or split the cell; close it: eln msg hand ${hand.rootId} resolve|reject "<text>"`,
        }));
        if (fresh) log('needhuman.resolver-plan-limit-card', { msgId: hand.id, seat: hand.blockedSeat, leader, cardId: mail.id });
      }
      continue;
    }
    if (verdict.kind === 'escalate') { unresolved.set(verdict.cause, [...(unresolved.get(verdict.cause) ?? []), hand]); continue; }
    const last = lastLeaderReply(store, hand);
    const overrode = last !== null && keepsWaiting(last, []);
    if (deps.live !== false) {
      try {
        applyHandOutcome(store, { msgId: hand.id, action: 'resolve', actor: hand.receiver, owner: hand.blockedSeat, deadline,
          text: `[writer-check resolver · ${verdict.cause}] ${verdict.answer}` }, deps);
      } catch (error) { log('needhuman.resolver-failed', { msgId: hand.id, error: String(error).slice(0, 200) }); continue; }
      if (verdict.coordinateWith) {
        try {
          store.appendWithProvenance({ from: RESOLVER_SENDER, to: verdict.coordinateWith, kind: 'info', intent: 'info', refs: [`hand-of:${hand.rootId}`, 'writer-coord'],
            body: `[행정관 · writer-check] ${hand.blockedSeat} will work on files you committed within 2h (✋ #${hand.rootId}) — reply within 30 min if it must wait` },
            `writer-coord:${hand.rootId}`);
        } catch { /* the resolve is the fact */ }
      }
      if (overrode) log('needhuman.resolver-override', { msgId: hand.id, leader: hand.receiver, seat: hand.blockedSeat, cause: verdict.cause, leaderReply: last!.slice(0, 160) });
      log('needhuman.resolver-resolved', { msgId: hand.id, leader: hand.receiver, seat: hand.blockedSeat, cause: verdict.cause });
    }
    resolved.push({ msgId: hand.id, seat: hand.blockedSeat, leader: hand.receiver, cause: verdict.cause, answer: verdict.answer, overrode });
  }
  const cards: { cause: HandCause; members: number[]; cardId: number }[] = [];
  for (const cause of WRITER_CHECK_CAUSES) {
    const members = unresolved.get(cause);
    if (!members?.length) continue;
    const lead = [...members].sort((a, b) => a.id - b.id)[0]!;
    let cardId = 0;
    if (deps.live !== false) {
      const { mail, fresh } = appendOnce(store, `hand-resolver-card:${cause}:${lead.id}`, () => ({
        from: lead.receiver, to: deps.ladder.hq, kind: 'request', intent: 'decision',
        refs: [`block:${lead.blockId}`, `seat:${lead.blockedSeat}`, `reason:${lead.reason}`, `cause:${cause}`, `hand-of:${lead.rootId}`,
          ...members.map((m) => `hand-escalated-from:${m.id}`), 'hand-beacon', `hand-repeat:${members.length}`],
        body: `[✋ BEACON · writer-check · ${cause}] ${members.length} ✋ the resolver could not answer (${members.map((m) => `#${m.id} ${m.blockedSeat}`).join(' · ')}) · `
          + `close it: eln msg hand <this mail> resolve|reject|escalate "<text>"`,
      }));
      cardId = mail.id;
      if (fresh) log('needhuman.resolver-card', { cause, members: members.map((m) => m.id), cardId });
    }
    cards.push({ cause, members: members.map((m) => m.id), cardId });
  }
  const byLeader = new Map<string, { msgId: number; cause: string }[]>();
  for (const r of resolved) byLeader.set(r.leader, [...(byLeader.get(r.leader) ?? []), r]);
  const digests = [...byLeader].map(([leader, rows]) => DIGEST(leader, rows));
  if (deps.live !== false) {
    for (const [leader, rows] of byLeader) {
      try { store.append({ from: RESOLVER_SENDER, to: leader, kind: 'info', intent: 'info', refs: ['writer-check-digest'], body: DIGEST(leader, rows) }); } catch { /* digest is a courtesy */ }
    }
  }
  return { resolved, cards, digests };
}

/** Status line: «writer-check resolved n · cards k». */
export const resolverLine = (r: Pick<ResolverReport, 'resolved' | 'cards'>): string => `writer-check resolved ${r.resolved.length} · cards ${r.cards.length}`;
