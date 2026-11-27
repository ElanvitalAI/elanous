// ── OP pulse digest `op-control/pulse-digest` (OP-WAKE-COMMIT-BATCH · P0 · 대표 11-26 04:5x) ─────────────────────
//
// S: due self-wakes and commitment follow-ups reached OP as bursts — «예약 깨움 묶음 · 6건» plus four «깨우개 발화»
//    in one turn, each asking OP to re-read and re-decide.
// C: the OP inbox already batches non-P0 mail to the pulse (#40191) — but scheduled wakes opened their own turns, and the
//    batch turn listed every notice raw, so OP still re-derived «what is done, what is late» by itself.
// A: (1) on the OP seat a due scheduled wake is queued (source `scheduled-wake`) and rides the pulse batch like held mail;
//    (2) the released batch turn opens with ONE digest whose outcomes are pre-evaluated from facts already measured by the
//    watchers (waker status · commitment ledger): ✅ done · ⏰ overdue · ▶ needs action. Crown / urgent / release-stop
//    mail is P0 and never waits (queue-finish-first). A missing pulse still releases at the 30-min max hold.
//
// Three faces:
//   observe = `tui.queue held|released` (reason pulse/starvation) ⊕ the digest head line on the batch turn
//   decision basis = waker status (fired·expired·armed past deadline) ⊕ commitment status — never the model's memory
//   repair & handoff = an overdue / needs-action row names the commitment id and the close door (done needs the facts)

import { CommitmentLedger, type CommitmentEntry } from '../commitment/ledger.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancelCommitmentWakers, listWakers, type SelfTimerDeps, type WakerRecord } from '../msg/self-timer-watch.js';

export type DigestBucket = 'done' | 'overdue' | 'action';

export interface DigestRow {
  readonly bucket: DigestBucket;
  readonly commitmentId: string;
  readonly line: string;
}

const clock = (iso: string | undefined): string => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Pure: classify each commitment from its wakers (facts the watchers measured) — one row per commitment, newest waker wins.
 * done = closed done since `sinceMs` · overdue = open with a waker expired or armed past its deadline · action = open and a
 * waker fired without auto-closing (the condition held, the owner must act) or blocked. Pending (armed, not due) is omitted.
 */
export function classifyDigest(commitments: readonly CommitmentEntry[], wakers: readonly WakerRecord[], nowMs: number, sinceMs: number): DigestRow[] {
  const byCommitment = new Map<string, WakerRecord[]>();
  for (const w of wakers) byCommitment.set(w.commitmentId, [...(byCommitment.get(w.commitmentId) ?? []), w]);
  const rows: DigestRow[] = [];
  for (const c of commitments) {
    const ws = (byCommitment.get(c.id) ?? []).slice().sort((a, b) => Date.parse(a.armedAt) - Date.parse(b.armedAt));
    const last = ws.at(-1);
    const cond = last ? ` · ${last.condition}` : '';
    if (c.status === 'done') {
      if (Date.parse(c.updatedAt) >= sinceMs) rows.push({ bucket: 'done', commitmentId: c.id, line: `${c.id} «${c.text}»${cond} · ${c.doneEvidence ?? 'done'}` });
      continue;
    }
    if (c.status === 'blocked') { rows.push({ bucket: 'action', commitmentId: c.id, line: `${c.id} «${c.text}» · blocked: ${c.reason ?? '?'}` }); continue; }
    if (c.status !== 'open' || !last) continue;
    if (last.status === 'expired' || (last.status === 'armed' && nowMs >= Date.parse(last.deadlineAt))) {
      rows.push({ bucket: 'overdue', commitmentId: c.id, line: `${c.id} «${c.text}»${cond} · not met by ${clock(last.deadlineAt)}` });
    } else if (last.status === 'fired') {
      rows.push({ bucket: 'action', commitmentId: c.id, line: `${c.id} «${c.text}»${cond} · condition held${last.evidence ? ` (${last.evidence})` : ''} — continue or close` });
    }
  }
  return rows;
}

// DIGEST-CAP (11-26 22:45 OP «✘ Could not process the request» on build 2226): the digest listed every row — 1 039 overdue
// mail-reply follow-ups — and the turn blew the context budget. 출처: CEO 11-26 22:5x «counts + top 5 · ≤ 2k chars».
export const DIGEST_ROWS_PER_SECTION = 5;
export const DIGEST_MAX_CHARS = 2_000;
export const DIGEST_LINE_MAX_CHARS = 160;

const clip = (line: string): string => (line.length > DIGEST_LINE_MAX_CHARS ? `${line.slice(0, DIGEST_LINE_MAX_CHARS - 1)}…` : line);

/**
 * Pure: the one digest block (null when there is nothing to say). `wakes` = the scheduled-wake reasons riding this pulse.
 * Bounded: counts always; per section the first {@link DIGEST_ROWS_PER_SECTION} rows (overdue: the latest deadlines
 * first when cut) and «… N more»; the whole block ≤ {@link DIGEST_MAX_CHARS} (done rows go first, then the rest).
 */
export function formatPulseDigest(rows: readonly DigestRow[], wakes: number): string | null {
  if (rows.length === 0 && wakes === 0) return null;
  const pick = (b: DigestBucket) => rows.filter((r) => r.bucket === b);
  const done = pick('done'); const overdue = pick('overdue'); const action = pick('action');
  const head = `[Pulse digest · done ${done.length} · overdue ${overdue.length} · needs action ${action.length} · scheduled wakes ${wakes}] Outcomes are pre-evaluated from facts — act on overdue and needs-action only; done needs no reply.`;
  const tail = 'Close an overdue commitment as reassigned or blocked with a reason when its outcome will not come; «request sent» or a reply is not done.';
  const build = (per: number): string => {
    const section = (title: string, list: readonly DigestRow[]) => {
      if (!list.length) return [];
      const shown = list.length > per ? list.slice(-per).reverse() : list; // cut → the latest rows (newest deadlines) first
      return [`${title} (${list.length})`, ...shown.map((r) => `  - ${clip(r.line)}`),
        ...(list.length > shown.length ? [`  … ${list.length - shown.length} more — eln commitment list --seat OP`] : [])];
    };
    return [head, ...section('✅ Done', done), ...section('⏰ Overdue', overdue), ...section('▶ Needs action', action), tail].join('\n');
  };
  for (let per = DIGEST_ROWS_PER_SECTION; per >= 0; per--) {
    const text = build(per);
    if (text.length <= DIGEST_MAX_CHARS || per === 0) return text;
  }
  return build(0);
}

// ── MAIL-REPLY EXPIRY (CEO 11-26 22:5x) ───────────────────────────────────────────────────────────────────────────
// S: every OP request mail armed a `mail-reply:<id>` follow-up; 1 039 of them were overdue by the evening — replies to
//    absorbed seats (REL · RES) that never come, mails long acked, mornings-old asks. They filled the digest.
// A: an open commitment whose waker is `mail-reply:<id>` closes itself (dropped · reason) when the target mail was acked,
//    the recipient is an absorbed seat, or it is older than 12 h. Swept on every digest read; one audit line per sweep.

// 출처: hand-raise ladder HAND_LEADER_RULE «RES/REL are absorbed — never wait for them» (11-25).
export const ABSORBED_SEATS: ReadonlySet<string> = new Set(['REL', 'RES', 'RES-INFRA']);
// 출처: CEO 11-26 22:5x — «older than 12h».
export const MAIL_REPLY_MAX_AGE_MS = 12 * 60 * 60_000;

export interface StaleMailReply { readonly commitmentId: string; readonly msgId: number; readonly to: string; readonly reason: 'acked' | 'absorbed' | 'older-than-12h' | 'duplicate'; readonly condition?: string }

// COMMITMENT-EXPIRY (11-27 · OP «169 overdue · open 197» after the mail-reply sweep): what stayed open were COND-WATCH
// watches («Watch cell-status:X=green / mail-from:SEAT (message #N to …)») and pr-merged follow-ups — their wakers have a
// 2 h horizon, so after it they are overdue forever; many watch the same condition 5–17 times, and some wait on a loop
// agent's mail (BOARD-STEWARD · ORCHESTRATOR) that never answers. The same expiry now covers every open commitment:
// absorbed / loop-agent target → closed · older than 12 h → closed · the same condition as a newer open one → duplicate.
// 출처: CEO 11-27 «what kinds remain and should they expire/close too» — the 12 h rule of the mail-reply sweep.
export const LOOP_AGENT_ADDRESSES: ReadonlySet<string> = new Set(['BOARD-STEWARD', 'ORCHESTRATOR']);

/** Pure: open commitments that will never be met — mail-reply (acked · absorbed · > 12 h) and every other kind (absorbed ·
 *  loop-agent target · > 12 h · duplicate condition of a newer open one). */
export function staleMailReplies(commitments: readonly CommitmentEntry[], wakers: readonly WakerRecord[], input: { nowMs: number; acked: (msgId: number, to: string) => boolean }): StaleMailReply[] {
  const target = new Map<string, number>();
  for (const w of wakers) if (w.condition.startsWith('mail-reply:')) { const id = Number(w.condition.slice('mail-reply:'.length)); if (Number.isSafeInteger(id)) target.set(w.commitmentId, id); }
  const conditionOf = (c: CommitmentEntry): string => c.wakers?.[0]?.condition ?? wakers.find(w => w.commitmentId === c.id)?.condition ?? '';
  const gone = (seat: string) => ABSORBED_SEATS.has(seat) || LOOP_AGENT_ADDRESSES.has(seat);
  // Newest open commitment per condition — older ones with the same condition are duplicates.
  const newest = new Map<string, CommitmentEntry>();
  for (const c of commitments) {
    if (c.status !== 'open') continue;
    const cond = conditionOf(c); if (!cond) continue;
    const cur = newest.get(cond);
    if (!cur || Date.parse(c.createdAt) > Date.parse(cur.createdAt)) newest.set(cond, c);
  }
  const out: StaleMailReply[] = [];
  for (const c of commitments) {
    if (c.status !== 'open') continue;
    const to = (c.assignee ?? '').trim().toUpperCase();
    const cond = conditionOf(c);
    const mailMsg = target.get(c.id);
    const msgId = mailMsg ?? (Number(/^msg:(\d+)$/u.exec(c.sessionId ?? '')?.[1]) || 0);
    const waitsOn = cond.startsWith('mail-from:') ? cond.slice('mail-from:'.length).trim().toUpperCase() : '';
    const reason = (to && gone(to)) || (waitsOn && gone(waitsOn)) ? 'absorbed'
      : input.nowMs - Date.parse(c.createdAt) > MAIL_REPLY_MAX_AGE_MS ? 'older-than-12h'
        : mailMsg !== undefined && to && input.acked(mailMsg, to) ? 'acked'
          : cond && newest.get(cond) !== c ? 'duplicate' : null;
    if (reason) out.push({ commitmentId: c.id, msgId, to, reason, ...(cond ? { condition: cond } : {}) });
  }
  return out;
}

export interface SweepDeps {
  readonly ledger: CommitmentLedger;
  readonly timer?: SelfTimerDeps;
  readonly nowMs: number;
  readonly acked: (msgId: number, to: string) => boolean;
  /** One audit line per sweep that closed anything. */
  readonly audit: (row: Record<string, unknown>) => void;
}

/** Close the stale mail-reply commitments of `seat` (dropped · reason) and their wakers. Returns what was closed. */
export function sweepMailReplies(seat: string, deps: SweepDeps): StaleMailReply[] {
  const commitments = deps.ledger.list(seat);
  const wakers = listWakers(seat, { ...deps.timer, ledger: deps.ledger });
  const stale = staleMailReplies(commitments, wakers, { nowMs: deps.nowMs, acked: deps.acked });
  const closed: StaleMailReply[] = [];
  for (const s of stale) {
    try {
      deps.ledger.markDropped(seat, s.commitmentId, s.condition && !s.condition.startsWith('mail-reply:')
        ? `auto-expired: ${s.condition}${s.to ? ` (to ${s.to})` : ''} — ${s.reason}`
        : `auto-expired: mail-reply #${s.msgId} to ${s.to || '?'} — ${s.reason}`);
      try { cancelCommitmentWakers(seat, s.commitmentId, `commitment auto-expired (${s.reason})`, { ...deps.timer, ledger: deps.ledger }); } catch { /* the waker ends at its own horizon */ }
      closed.push(s);
    } catch { /* a commitment closed meanwhile — skip */ }
  }
  if (closed.length) {
    const byReason: Record<string, number> = {};
    for (const c of closed) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
    deps.audit({ at: new Date(deps.nowMs).toISOString(), seat, sweep: 'mail-reply-expiry', closed: closed.length, byReason, sample: closed.slice(0, 5).map((c) => `${c.commitmentId}:#${c.msgId}`) });
  }
  return closed;
}

/** Production ack probe: the recipient's status of the mail in the msg store (read-only; unknown → not acked). */
export function msgStoreAcked(): (msgId: number, to: string) => boolean {
  // Lazy: the store opens only when a mail-reply commitment is actually checked (most digests have none).
  let store: import('../msg/msg-store.js').MsgStore | null = null;
  return (msgId, to) => {
    try {
      if (!store) { const { openMsgStoreReadOnly } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js'); store = openMsgStoreReadOnly(); }
      const st = store.messageStatus(to, msgId); return st === 'acked' || st === 'done';
    } catch { return false; }
  };
}

export interface OpPulseDigestDeps {
  readonly ledger?: CommitmentLedger;
  readonly timer?: SelfTimerDeps;
  readonly now?: () => number;
  /** Ack probe for the mail-reply sweep (default: the msg store, read-only). */
  readonly acked?: (msgId: number, to: string) => boolean;
  readonly audit?: (row: Record<string, unknown>) => void;
}

/** Read the OP ledger + wakers once and build the digest (fail-open: a read error → null, the batch still goes). */
export function readPulseDigest(seat: string, sinceMs: number, wakes: number, deps: OpPulseDigestDeps = {}): string | null {
  try {
    const ledger = deps.ledger ?? new CommitmentLedger();
    const now = (deps.now ?? Date.now)();
    // MAIL-REPLY EXPIRY — close the follow-ups that can never be met before they reach the digest (fail-open).
    try {
      sweepMailReplies(seat, { ledger, ...(deps.timer ? { timer: deps.timer } : {}), nowMs: now, acked: deps.acked ?? msgStoreAcked(),
        audit: deps.audit ?? ((row) => { try { appendFileSync(join(ledger.root, 'sweeps.jsonl'), `${JSON.stringify(row)}\n`); } catch { /* audit is fail-open */ } }) });
    } catch { /* the digest still goes */ }
    const commitments = ledger.list(seat);
    const wakers = listWakers(seat, { ...deps.timer, ledger });
    return formatPulseDigest(classifyDigest(commitments, wakers, now, sinceMs), wakes);
  } catch {
    return wakes > 0 ? formatPulseDigest([], wakes) : null;
  }
}

// ── FED-OBSERVE (대표 11-26 23:3x) — the federation's anomalies ride the same pulse digest ───────────────────────────
// S: Claude OP read «what is abnormal in the federation» from a screen-scraping script; eln OP never saw it.
// A: the pulse batch turn appends the latest `eln fed snapshot --anomalies` block (≤ FED_ANOMALY_MAX_CHARS, from the saved
//    snapshot — no live probing inside the TUI). A missing or stale snapshot asks for a detached refresh for the next pulse.
// 출처: CEO 11-26 23:3x «≤1.5k chars» (the digest itself stays ≤ DIGEST_MAX_CHARS).
export const FED_ANOMALY_MAX_CHARS = 1_500;
// 출처: the snapshot takes ~4 s live; one refresh per 5 min is ample and bounds the processes a failing collector can start.
export const FED_REFRESH_MIN_GAP_MS = 5 * 60_000;
let lastFedRefreshAt = 0;

export interface FedAnomalyDeps {
  readonly latest?: () => { text: string | null; stale: boolean };
  /** Start `eln fed snapshot --quiet` detached (the next pulse reads it). */
  readonly refresh?: () => void;
}

/** The anomaly block for OP's pulse turn, or null. Fail-open; a stale/missing snapshot triggers one background refresh. */
export function readFedAnomalyDigest(deps: FedAnomalyDeps = {}): string | null {
  try {
    const latest = deps.latest ?? (() => (require('../fed-observe/fed-observe-cli.js') as typeof import('../fed-observe/fed-observe-cli.js')).latestAnomalyBlock({ maxChars: FED_ANOMALY_MAX_CHARS }));
    const r = latest();
    // One refresh in flight at a time: a slow or failing collector must not pile up detached processes.
    if (r.stale && (deps.refresh || Date.now() - lastFedRefreshAt >= FED_REFRESH_MIN_GAP_MS)) {
      if (!deps.refresh) lastFedRefreshAt = Date.now();
      try {
        (deps.refresh ?? (() => {
          const { spawnElanous } = require('../instance/spawn-elanous.js') as typeof import('../instance/spawn-elanous.js');
          const child = spawnElanous(['fed', 'snapshot', '--quiet'], { executable: 'eln', stdio: 'ignore', detached: true });
          child.once('error', () => {}); child.unref();
        }))();
      } catch { /* the next pulse tries again */ }
    }
    return r.text && r.text.length > FED_ANOMALY_MAX_CHARS ? `${r.text.slice(0, FED_ANOMALY_MAX_CHARS - 1)}…` : r.text;
  } catch { return null; }
}
