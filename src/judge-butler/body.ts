// 판정 집사 (judge-butler) — body (L1 · LLM 0). First instance of the loop-agent v2 skeleton (내부 문서 `LOOP-AGENT`):
//   observe → goal (judge vs done-when / KPI) → act → verify → evidence → report  ⊕ escalate ⊕ voice (judgment only).
//
// S: rail 73 · 00:44 `eln fed snapshot --anomalies` — «TC HOLD freezes 16 hands» · «OP HOLD freezes 5 hands» · «judge queue 50 ·
//    median wait 47m» · greens ≈ 0/h while lands ran 6–10/h. Landed cells with same-head receipts sat unsigned.
// C: nobody owned «landed + receipt → green»; HOLDs had no scope or expiry; judge-domain ✋ waited on a human judge.
// Q: what deterministic body closes greens from evidence, unfreezes hands and answers judge ✋ within 10 min — and never signs
//    without done-when or on a security-4 path?
// A: `planTick(view)` (pure) turns one observation into closed L1 actions; `runTick(ports)` executes them through ports (the
//    checklist green path as JUDGE-BUTLER with decidedBy/supervisedBy, the HOLD ledger, msg outcomes) and verifies each.
//    The fed-org sim (seeds 1–5, src/judge-butler/judge-butler-sim.test.ts) and the live CLI drive the SAME planner/executor.
//
// 세 얼굴: 관측 = cases.jsonl (every decision with evidence refs) ⊕ fed-state green facts (decidedBy · doneBy · supervisedBy) ⊕
// `eln loop butler status` · 판단 근거 = judgeCell() (done-when) ⊕ hold-ledger covers/frozenBy ⊕ the goal card KPI ·
// 수복과 인계 = a failed verify / security-4 / judgment it cannot make → one card to JUD (L0); 30-min digest to OP.
import type { ExpireRow, Hold, HoldBlock } from '../hold-ledger/hold-ledger.js';
import { frozenBy, holdsCovering } from '../hold-ledger/hold-ledger.js';
import { isE4Cell, judgeCell, RULES_VERSION, signWithoutE4, simEvidenceLine, type CellIn, type PrFacts, type Verdict } from './done-when.js';
import { checklistEvidenceCommand } from '../release-loop/checklist.js';
import { BUTLER_SEAT, BUTLER_SUPERVISOR, type ButlerLevel, type ButlerMemory, type ButlerState, type Case } from './memory.js';

export const HOLD_FREEZE_HANDS = 3;
export const PROPOSAL_GRACE_MS = 30 * 60_000;
export const HAND_SLA_MS = 10 * 60_000;
export const RESCAN_AFTER_MS = 30 * 60_000;
/** BUTLER-E4-AUTORUN: ≤3 evidence runs per tick (serial) · the same cell at most once an hour. */
export const E4_RUNS_PER_TICK = 3;
export const E4_RETRY_MS = 60 * 60_000;
export const DIGEST_EVERY_MS = 30 * 60_000;
export const ANSWER_DEADLINE_MS = 2 * 60 * 60_000;
/** Receivers whose ✋ are the judge domain (the butler answers first; JUD stays L0). */
export const JUDGE_DOMAIN = new Set(['JUD', BUTLER_SEAT]);

export interface HandIn {
  readonly id: number; readonly rootId: number; readonly sender: string; readonly receiver: string; readonly blockedSeat: string;
  readonly cell: string; readonly reason: string; readonly refs: readonly string[]; readonly createdAtMs: number; readonly body: string;
}
export const inJudgeDomain = (h: HandIn): boolean => JUDGE_DOMAIN.has(h.receiver.toUpperCase()) || h.refs.some(r => r.startsWith('hold:'));

export interface ButlerView {
  readonly now: Date;
  readonly version: string | null;
  readonly cells: readonly CellIn[];
  readonly prFacts: ReadonlyMap<number, PrFacts>;
  readonly holds: readonly Hold[];
  readonly blocks: readonly HoldBlock[];
  readonly hands: readonly HandIn[];
  /** TARGET-VERSION (11-27): false = `version` is not the release in play (published, or not release.graph.version) → act on nothing. */
  readonly actable?: boolean;
  readonly targetWhy?: string;
}

export type Action =
  | { kind: 'sign'; cell: string; why: string; evidence: readonly string[]; expected: { title: string; status: string; evidence: string }; doneBy: string | null; e4Run?: boolean }
  | { kind: 'escalate-cell'; cell: string; why: string; key: string }
  | { kind: 'withdraw-escalation'; cell: string; key: string; verdict: Verdict }
  | { kind: 'lesson'; cell: string; text: string; fp: string; /** JUD's verdict on a yellow cell: veto at exactly this fp · seen-once key */ verdictKey?: string }
  | { kind: 'expire-holds' }
  | { kind: 'propose-narrow'; hold: string; to: string; key: string; body: string }
  | { kind: 'escalate-hold'; hold: string; key: string; body: string }
  | { kind: 'notify-freed'; hand: string; hold: string; key: string; body: string }
  | { kind: 'answer-hand'; hand: HandIn; text: string; owner: string; deadline: string; refs: readonly string[]; afterSign?: string }
  | { kind: 'escalate-hand'; hand: HandIn; text: string }
  | { kind: 'voice-hand'; hand: HandIn; facts: string };

const iso = (ms: number) => new Date(ms).toISOString();
/** The evidence a sign rests on (PR@head ⊕ receipt) — a veto lifts only when this changes. */
/** A registered, active HOLD that names this cell explicitly (a wildcard HOLD freezes hands' work, it is not a verdict on a cell). */
export const namedByHold = (holds: readonly Hold[], cell: string, now: Date): boolean =>
  holds.some(h => h.state === 'active' && Date.parse(h.expiresAt) > now.getTime() && h.cells.includes(cell.toUpperCase()));
export const fingerprint = (v: Verdict): string => (v.kind === 'sign' ? v.evidence.filter(e => !e.startsWith('E4:')).join(' | ') : '');
/** The veto fingerprint of one cell — an E4 cell's own evidence run IS its evidence, so a new run lifts a veto on it. */
export const cellFingerprint = (cell: string, v: Verdict): string => (isE4Cell(cell) && v.kind === 'sign' ? v.evidence.join(' | ') : fingerprint(v));
/** JUDGE-BUTLER-E4-RESIGN-SCOPE: JUD (A · any JUD* seat but the butler itself) wrote the cell last — an independent verdict. */
export const isIndependentJudge = (by: string | undefined): boolean => { const s = (by ?? '').trim().toUpperCase(); return /^JUD/u.test(s) && s !== BUTLER_SEAT; };

/** Pure: one observation → the closed set of L1 actions (order = execution order). */
export function planTick(view: ButlerView, state: ButlerState): { actions: Action[]; verdicts: Map<string, Verdict>; frozen: Map<string, string>; e4: { candidates: number; noCommand: number; cooldown: number; cap: number } } {
  const now = view.now; const nowMs = now.getTime();
  const actions: Action[] = [];
  const byId = new Map(view.cells.map(c => [c.id.toUpperCase(), c] as const));
  // BUTLER-RESPECT-VETO (rail 81 · 19:18–19:48Z flapping): ANY actor other than the butler that moves a butler-signed cell away
  // from green is a veto (JUD's revert arrived as by «cli»). The cell is not re-signed until its evidence fingerprint (PR@head ·
  // receipt) changes; one lesson per veto.
  for (const [cell, at] of Object.entries(state.signed)) {
    const c = byId.get(cell.toUpperCase());
    if (!c || state.reversed[cell]) continue;
    const by = (c.updatedBy ?? '').toUpperCase();
    if (c.status !== 'green' && c.status !== 'done' && by !== BUTLER_SEAT)
      actions.push({ kind: 'lesson', cell, fp: cellFingerprint(cell, judgeCell(c, view.prFacts)), text: `${by || '?'} set ${cell} back to ${c.status} after the butler signed it ${at} — a veto: no re-sign until the PR head / receipt changes` });
  }
  // JUDGE-BUTLER-E4-RESIGN-SCOPE (CX3-LAND-VERSION-REVERT-E4-E4 · FED-FACT-OP-ACTIONS-E4-E4 · 11-27 09:4x): JUD's latest write on a
  // yellow cell is an independent verdict — the butler never signs over it on the same evidence. Seen once per write
  // (updatedAt); a new PR head / receipt / E4 run after it lifts it, exactly like a revert after sign.
  for (const c of view.cells) {
    if (c.status !== 'yellow' || !isIndependentJudge(c.updatedBy)) continue;
    const verdictKey = `jud-verdict:${c.id}:${c.updatedAt ?? ''}`;
    if (state.sent[verdictKey] || actions.some(a => a.kind === 'lesson' && a.cell === c.id)) continue;
    const v = judgeCell(c, view.prFacts);
    if (v.kind !== 'sign') continue; // nothing to sign over — no lesson noise
    actions.push({ kind: 'lesson', cell: c.id, fp: cellFingerprint(c.id, v), verdictKey,
      text: `${(c.updatedBy ?? '').toUpperCase()} judged ${c.id} yellow (latest write ${c.updatedAt ?? '?'}) — an independent verdict: no butler sign until the PR head / receipt / E4 evidence changes` });
  }
  // ① greens: every yellow cell, judged against done-when
  const verdicts = new Map<string, Verdict>();
  for (const c of view.cells) {
    if (c.status !== 'yellow') continue;
    const v = judgeCell(c, view.prFacts);
    verdicts.set(c.id, v);
    if (actions.some(a => a.kind === 'lesson' && a.cell === c.id)) continue;
    if (state.reversed[c.id] && (v.kind !== 'sign' || (state.vetoFp?.[c.id] ?? '') === cellFingerprint(c.id, v))) continue; // veto stands
    if (v.kind === 'sign' && namedByHold(view.holds, c.id, now)) continue; // a registered HOLD naming this cell → not ours to sign
    if (v.kind === 'sign') actions.push({ kind: 'sign', cell: c.id, why: v.why, evidence: v.evidence, expected: { title: c.title ?? '', status: c.status, evidence: c.evidence ?? '' }, doneBy: c.owner ? c.owner.split('/')[0]! : null });
    else if (v.kind === 'security') {
      const key = `security:${c.id}`;
      if (!state.sent[key]) actions.push({ kind: 'escalate-cell', cell: c.id, why: v.why, key });
    }
  }
  // E4 opportunistic (GREEN-DEFINITION-ONE): a signable cell without an E4 line whose title names its evidence command gets one
  // run before the sign (≤3 per tick · once an hour per cell). Every other signable-without-E4 cell is counted by reason.
  const e4 = { candidates: 0, noCommand: 0, cooldown: 0, cap: 0 };
  for (const a of actions) {
    if (a.kind !== 'sign') continue;
    const v = verdicts.get(a.cell);
    if (!v || !signWithoutE4(v)) continue;
    const c = byId.get(a.cell.toUpperCase());
    if (!checklistEvidenceCommand(c?.title ?? '')) { e4.noCommand++; continue; }
    const at = state.sent[`e4:${a.cell}`];
    if (at && nowMs - Date.parse(at) < E4_RETRY_MS) { e4.cooldown++; continue; }
    if (e4.candidates >= E4_RUNS_PER_TICK) { e4.cap++; continue; }
    a.e4Run = true; e4.candidates++;
  }
  // BUTLER-RESCAN (rail 78): a cell escalated as security-4 is re-judged when the rules changed or the escalation is ≥ 30 min
  // old with the cell still yellow; no longer security-4 → withdraw the escalation (signed now, or what is still missing).
  const rulesChanged = state.rulesVersion !== RULES_VERSION;
  for (const [key, at] of Object.entries(state.sent)) {
    if (!key.startsWith('security:')) continue;
    const cell = key.slice('security:'.length);
    const v = verdicts.get(cell);
    if (!v || v.kind === 'security') continue;
    if (rulesChanged || nowMs - Date.parse(at) >= RESCAN_AFTER_MS) actions.push({ kind: 'withdraw-escalation', cell, key, verdict: v });
  }
  // ② HOLDs: expiry / unlock sweep first, then what still freezes
  actions.push({ kind: 'expire-holds' });
  const live = view.holds.filter(h => h.state === 'active' && Date.parse(h.expiresAt) > nowMs);
  const { frozen } = frozenBy(live, view.blocks, now);
  const frozenNow = new Map<string, string>();
  for (const row of frozen) for (const hand of row.hands) frozenNow.set(hand, row.hold.id);
  for (const row of frozen) {
    if (row.hands.length < HOLD_FREEZE_HANDS) continue;
    const h = row.hold;
    const key = `propose:${h.id}:${h.narrowed}`;
    const sentAt = state.sent[key];
    if (!sentAt) {
      actions.push({ kind: 'propose-narrow', hold: h.id, to: h.owner, key,
        body: `[판정 집사 · HOLD 좁히기 제안] ${h.id} (${h.cells.join(',')} · ~${h.expiresAt.slice(11, 16)}Z) 이 손 ${row.hands.length}명을 묶고 있다(${row.hands.slice(0, 8).join(',')}${row.hands.length > 8 ? ',…' : ''} · 칸 ${row.cells.slice(0, 8).join(',')}). `
          + `정말 묶어야 할 칸만 남기고 만료를 줄여 달라: eln hold narrow ${h.id} --cells <칸> --expires 30m — 필요 없으면 eln hold lift ${h.id} --reason '…'. 30분 안 변화 없으면 JUD 로 올린다. 사유: ${h.reason.slice(0, 80)}` });
    } else if (nowMs - Date.parse(sentAt) >= PROPOSAL_GRACE_MS && !state.sent[`${key}:jud`]) {
      actions.push({ kind: 'escalate-hold', hold: h.id, key: `${key}:jud`,
        body: `[판정 집사 → JUD · HOLD 처분 요청] ${h.id} (주인 ${h.owner} · ${h.cells.join(',')} · ~${h.expiresAt.slice(11, 16)}Z) 좁히기 제안 ${Math.round((nowMs - Date.parse(sentAt)) / 60_000)}분 무응답 · 손 ${row.hands.length}명 묶임. `
          + `JUD 결정: eln hold narrow ${h.id} --cells <칸> --expires 30m --by JUD · 또는 eln hold lift ${h.id} --by JUD --reason '…'` });
    }
  }
  // hands that were frozen and are no longer covered → tell them once (the HOLD id and why)
  for (const [hand, holdId] of Object.entries(state.frozenLast)) {
    if (frozenNow.has(hand)) continue;
    const h = view.holds.find(x => x.id === holdId);
    const why = !h ? 'gone' : h.state !== 'active' || Date.parse(h.expiresAt) <= nowMs ? (h.closeReason ?? `expired ${h.expiresAt}`) : `narrowed to ${h.cells.join(',')}`;
    actions.push({ kind: 'notify-freed', hand, hold: holdId, key: `freed:${holdId}:${hand}:${h?.narrowed ?? 0}:${h?.state ?? 'gone'}`,
      body: `[판정 집사] ${holdId} 은 이제 네 칸을 묶지 않는다(${why}). 진행해도 된다 — 확인: eln hold ls --cell <칸>` });
  }
  // a registered broadcast (HOLD with sourceMsg) that does not cover a waiting hand's cell → tell that hand once
  const { unregistered } = frozenBy(live, view.blocks, now);
  const latestCell = new Map<string, string>();
  for (const b of [...view.blocks].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) latestCell.set(b.by.toUpperCase(), b.cell);
  for (const [owner, hands] of unregistered) {
    const reg = live.find(h => h.owner === owner && h.sourceMsg !== undefined);
    if (!reg) continue;
    for (const hand of hands) actions.push({ kind: 'notify-freed', hand, hold: reg.id, key: `freed:${reg.id}:${hand}:${reg.narrowed}:scope`,
      body: `[판정 집사] ${owner} 의 HOLD 는 ${reg.id}(범위 ${reg.cells.join(',')} · 만료 ${reg.expiresAt.slice(11, 16)}Z)로 등록됐고 네 칸 ${latestCell.get(hand) ?? '?'} 은 범위 밖이다. 진행해도 된다.` });
  }
  // ③ judge-domain ✋ — answered or escalated within the SLA, never left
  for (const hand of view.hands) {
    if (!inJudgeDomain(hand) || hand.sender.toUpperCase() === BUTLER_SEAT) continue; // its own forwards to JUD are JUD's
    const cell = byId.get(hand.cell.toUpperCase());
    const deadline = iso(nowMs + ANSWER_DEADLINE_MS);
    const v = cell ? verdicts.get(cell.id) : undefined;
    if (cell && v?.kind === 'sign' && !state.reversed[cell.id]) {
      // answered only AFTER the sign is confirmed (executor) — a refused/failed sign escalates the ✋ to JUD instead
      actions.push({ kind: 'answer-hand', hand, owner: hand.blockedSeat, deadline, refs: [`cell:${cell.id}`], afterSign: cell.id,
        text: `${cell.id} 는 완료 조건을 채워 판정 집사가 초록으로 서명했다 — ${v.why}` });
      continue;
    }
    if (cell && v?.kind === 'missing') {
      actions.push({ kind: 'answer-hand', hand, owner: hand.blockedSeat, deadline, refs: [`cell:${cell.id}`],
        text: `${cell.id} 는 아직 초록이 아니다 — 빠진 것: ${v.missing.join(' · ')}. 이것을 채우면 다음 틱에 자동 서명한다(재질문 불필요).` });
      continue;
    }
    if (cell && v?.kind === 'security') { actions.push({ kind: 'escalate-hand', hand, text: `${cell.id} ${v.why}` }); continue; }
    const covering = holdsCovering(live, hand.cell, now);
    if (covering.length) {
      const h = covering[0]!;
      actions.push({ kind: 'answer-hand', hand, owner: h.owner, deadline: h.expiresAt, refs: [`hold:${h.id}`],
        text: `${hand.cell} 는 ${h.id}(주인 ${h.owner} · 범위 ${h.cells.join(',')} · 만료 ${h.expiresAt.slice(0, 16)}Z · 해제 조건 ${h.unlock})에 걸려 있다. 만료되면 판정 집사가 자동으로 걷고 알려 준다 — 그동안 이 칸 밖의 일을 잡아라(eln work next).` });
      continue;
    }
    // judgment needed (no cell fact, no covering HOLD) → voice turn; the executor falls back to JUD when voice is off/over budget
    const facts = [cell ? `cell ${cell.id} status ${cell.status}` : `cell ${hand.cell || '?'} not on the checklist`, `no registered HOLD covers ${hand.cell || '?'}`,
      `active HOLDs: ${live.map(h => `${h.id}(${h.owner}:${h.cells.join(',')})`).join(' ') || 'none'}`].join(' · ');
    actions.push({ kind: 'voice-hand', hand, facts });
  }
  return { actions, verdicts, frozen: frozenNow, e4 };
}

// ── executor ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ButlerPorts {
  readonly memory: ButlerMemory;
  /** Green through the checklist path as JUDGE-BUTLER (setItemIfSnapshot · attribution). Throws on refusal. */
  sign(cell: string, evidence: string, expected: { title: string; status: string; evidence: string }, attribution: { decidedBy: string; doneBy?: string; supervisedBy: string }): void;
  /** Re-read one cell (verify node · and the fresh read right before signing). */
  readCell(cell: string): CellIn | null;
  /** Fresh PR facts (receipt · focused · files/security-4 · Terra) for a cell's cited PRs — read immediately before signing. */
  freshFacts(cell: CellIn): ReadonlyMap<number, PrFacts>;
  expireHolds(by: string, unlockFacts: { merged: ReadonlySet<number>; green: ReadonlySet<string> }): ExpireRow[];
  /** Idempotent mail by provenance key; returns the mail id (null = already sent or failed). */
  post(key: string, to: string, body: string, kind?: string): number | null;
  /** ✋ outcome «resolve» from JUDGE-BUTLER with owner ⊕ deadline (closes the ✋ on the ladder). */
  answerHand(hand: HandIn, text: string, owner: string, deadline: string, refs: readonly string[]): number | null;
  /** Forward the ✋ to JUD (stays a ✋ there). */
  escalateHand(hand: HandIn, to: string, text: string): number | null;
  /** BUTLER-E4-AUTORUN: `eln release checklist evidence run <cell> --version <v>` (timeout inside) — absent = no autorun. */
  runEvidence?(cell: string, version: string): { rc: number; out: string };
  /** GREEN-DEFINITION-ONE: register one FU cell (P2 · unowned = the board pool · BUTLER-E4-FU-UNOWNED) — true when added or already there. */
  addFollowUp?(id: string, title: string): boolean;
  /** Voice for a judgment ✋ — returns the outcome or null (off · over budget · LLM failure) → escalate. */
  voiceHand?(hand: HandIn, facts: string): Promise<{ action: 'resolve'; text: string; owner: string; deadline: string } | { action: 'escalate'; text: string } | null>;
  readonly merged: ReadonlySet<number>;
}

export interface TickReport {
  readonly level: ButlerLevel;
  readonly at: string;
  readonly signed: string[];
  readonly signRefused: Array<{ cell: string; why: string }>;
  /** BUTLER-SIGN-MERGED-PATCHID: yellow cells with a merged PR that the butler did not sign this tick, with the one-line reason. */
  readonly notSigned: Array<{ cell: string; why: string }>;
  readonly expired: string[];
  readonly proposed: string[];
  readonly escalated: string[];
  readonly answered: number[];
  readonly freed: string[];
  readonly frozenHands: number;
  readonly planned: number;
  readonly digest: number | null;
  /** E4 opportunistic runs: tried/ok/fail · FU cells registered · why the rest were not tried. */
  readonly e4: { tried: number; ok: number; fail: number; fu: number; noCommand: number; cooldown: number; cap: number };
}

const kase = (k: Case['kind'], subject: string, why: string, now: Date, refs?: readonly string[], extra?: Record<string, unknown>): Case =>
  ({ at: now.toISOString(), kind: k, subject, why, ...(refs?.length ? { refs } : {}), decidedBy: BUTLER_SEAT, supervisedBy: BUTLER_SUPERVISOR, ...(extra ? { extra } : {}) });

/** Why a judged yellow cell was not signed (null = it is being signed / nothing to say). */
export function notSignedWhy(cell: string, v: Verdict, view: ButlerView, state: ButlerState): string | null {
  if (v.kind === 'missing') return `missing — ${v.why}`;
  if (v.kind === 'security') return `security-4 → JUD/Terra — ${v.why}`;
  if (state.reversed[cell]) return `veto stands (set back after the butler signed ${state.signed[cell] ?? '?'} · re-sign only when PR head / receipt changes) — ${v.why}`;
  if (namedByHold(view.holds, cell, view.now)) return `a registered HOLD names this cell — ${v.why}`;
  return null;
}

/** One tick: plan → act → verify → evidence (cases) → report. `off` does nothing · `shadow` plans and records nothing. */
export async function runTick(view: ButlerView, ports: ButlerPorts): Promise<TickReport> {
  const mem = ports.memory; const now = view.now;
  const level = mem.level().level;
  const state = mem.readState();
  if (state.version !== view.version) Object.assign(state, { version: view.version, signed: {}, reversed: {} });
  const empty: TickReport = { level, at: now.toISOString(), signed: [], signRefused: [], notSigned: [], expired: [], proposed: [], escalated: [], answered: [], freed: [], frozenHands: 0, planned: 0, digest: null, e4: { tried: 0, ok: 0, fail: 0, fu: 0, noCommand: 0, cooldown: 0, cap: 0 } };
  if (level === 'off') return empty;
  if (view.actable === false) { // TARGET-VERSION: never judge/sign/run on a published or non-target release
    const key = `off-target:${view.version ?? '?'}`;
    if (!state.sent[key]) { state.sent[key] = now.toISOString(); mem.appendCase(kase('off-target', view.version ?? '?', view.targetWhy ?? 'not the target release', now)); mem.writeState(state); }
    return empty;
  }
  const plan = planTick(view, state);
  const r = { ...empty, notSigned: [] as Array<{ cell: string; why: string }>, planned: plan.actions.length, frozenHands: plan.frozen.size, e4: { ...empty.e4, noCommand: plan.e4.noCommand, cooldown: plan.e4.cooldown, cap: plan.e4.cap } };
  if (level === 'shadow') return r;
  const green = new Set(view.cells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id.toUpperCase()));
  /** SAFETY (Terra r1): re-read the cell and re-judge on fresh receipt ⊕ PR facts (incl. security-4) immediately before signing. */
  const trySign = (cellId: string, doneByHint: string | null): boolean => {
    const fresh = ports.readCell(cellId);
    const v = fresh && fresh.status === 'yellow' ? judgeCell(fresh, ports.freshFacts(fresh)) : null;
    if (!fresh || !v || v.kind !== 'sign') {
      const why = !fresh ? 'cell gone' : fresh.status !== 'yellow' ? `now ${fresh.status}` : `re-judge: ${v!.kind} — ${v!.why}`;
      r.signRefused.push({ cell: cellId, why }); mem.appendCase(kase('sign-refused', cellId, why, now));
      if (v?.kind === 'security' && !state.sent[`security:${cellId}`]) { const id = ports.post(`security:${cellId}`, BUTLER_SUPERVISOR, `[판정 집사 → JUD · 보안 4종] ${cellId}: ${v.why}. 판정 집사는 서명하지 않는다.`, 'request'); if (id !== null) state.sent[`security:${cellId}`] = now.toISOString(); }
      return false;
    }
    const doneBy = fresh.owner ? fresh.owner.split('/')[0]! : doneByHint;
    const expected = { title: fresh.title ?? '', status: fresh.status, evidence: fresh.evidence ?? '' };
    const line = `🟢 판정 집사 서명 ${now.toISOString().slice(0, 16)}Z — ${v.why} · decidedBy judge-butler · supervisedBy ${BUTLER_SUPERVISOR}`;
    try { ports.sign(cellId, expected.evidence ? `${expected.evidence}\n${line}` : line, expected, { decidedBy: BUTLER_SEAT, ...(doneBy ? { doneBy } : {}), supervisedBy: BUTLER_SUPERVISOR }); }
    catch (e) { const why = e instanceof Error ? e.message : String(e); r.signRefused.push({ cell: cellId, why }); mem.appendCase(kase('sign-refused', cellId, why, now)); return false; }
    // verify node: the green must be on the ledger, written by the butler
    const after = ports.readCell(cellId);
    if (!after || after.status !== 'green' || (after.updatedBy ?? '').toUpperCase() !== BUTLER_SEAT) {
      mem.appendCase(kase('verify-failed', cellId, `after sign: ${after ? `${after.status} by ${after.updatedBy}` : 'missing'}`, now));
      const id = ports.post(`verify-failed:${cellId}:${now.toISOString().slice(0, 13)}`, BUTLER_SUPERVISOR, `[판정 집사 → JUD] ${cellId} 서명 검증 실패(${after ? `${after.status} by ${after.updatedBy}` : 'missing'}) — 확인 요청`, 'request');
      if (id) r.escalated.push(`verify:${cellId}#${id}`);
      return false;
    }
    state.signed[cellId] = now.toISOString(); green.add(cellId.toUpperCase()); r.signed.push(cellId);
    state.signedFp = { ...(state.signedFp ?? {}), [cellId]: cellFingerprint(cellId, v) };
    if (state.reversed[cellId]) { delete state.reversed[cellId]; if (state.vetoFp) delete state.vetoFp[cellId]; } // new evidence lifted the veto
    mem.appendCase(kase('sign', cellId, v.why, now, [...v.evidence, `cell:${cellId}`], doneBy ? { doneBy } : undefined));
    return true;
  };
  for (const a of plan.actions) {
    try {
      switch (a.kind) {
        case 'lesson': {
          state.reversed[a.cell] = now.toISOString();
          state.vetoFp = { ...(state.vetoFp ?? {}), [a.cell]: a.verdictKey ? a.fp : (state.signedFp?.[a.cell] || a.fp) };
          if (a.verdictKey) state.sent[a.verdictKey] = now.toISOString();
          mem.appendLesson({ at: now.toISOString(), cell: a.cell, text: a.text, from: 'JUD' });
          mem.appendCase(kase('lesson', a.cell, a.text, now));
          break;
        }
        case 'sign': {
          if (a.e4Run && ports.runEvidence && view.version) { // opportunistic E4 first; its result never blocks the sign
            state.sent[`e4:${a.cell}`] = now.toISOString();
            const run = ports.runEvidence(a.cell, view.version);
            r.e4.tried++; if (run.rc === 0) r.e4.ok++; else r.e4.fail++;
            mem.appendCase(kase('e4-run', a.cell, `evidence run rc ${run.rc} — ${run.out.slice(-160)}`, now, [`cell:${a.cell}`]));
          }
          if (!trySign(a.cell, a.doneBy)) break;
          const after = ports.readCell(a.cell);
          // BUTLER-E4-FU-UNOWNED: one «<cell>-E4» FU, unowned (board pool — never parked on OP) · an E4 cell never gets an E4-of-E4
          if (after && !isE4Cell(a.cell) && !simEvidenceLine(after) && !state.sent[`fu-e4:${a.cell}`] && ports.addFollowUp) {
            const ok = ports.addFollowUp(`${a.cell}-E4`, `${a.cell} — E4 sim/test-universe evidence (green signed on same-head receipt + focused exit 0; E4 ${a.e4Run ? 'run failed' : 'not run: no «완료 경계 증거 명령» in the title'})`);
            if (ok) { state.sent[`fu-e4:${a.cell}`] = now.toISOString(); r.e4.fu++; }
          }
          break;
        }
        case 'escalate-cell': {
          const id = ports.post(a.key, BUTLER_SUPERVISOR, `[판정 집사 → JUD · 보안 4종] ${a.cell}: ${a.why}. 판정 집사는 서명하지 않는다 — JUD/Terra 판정 요청.`, 'request');
          state.sent[a.key] = now.toISOString();
          if (id) { r.escalated.push(`${a.cell}#${id}`); mem.appendCase(kase('escalate-cell', a.cell, a.why, now, [`msg:${id}`])); }
          break;
        }
        case 'withdraw-escalation': {
          const escCell = a.cell;
          const esc = mem.cases(1000).filter(c => c.kind === 'escalate-cell' && c.subject === escCell).at(-1);
          const escId = esc?.refs?.find(x => x.startsWith('msg:'))?.slice(4);
          const signed = r.signed.includes(a.cell);
          const body = signed
            ? `[판정 집사] 보안 4종 올림 ${escId ? `#${escId} ` : ''}철회 → ${a.cell} 서명 완료 (규칙 ${RULES_VERSION}: 시험·픽스처·문서는 실행 코드가 아니다) — JUD 조치 불필요`
            : `[판정 집사] 보안 4종 올림 ${escId ? `#${escId} ` : ''}철회 — ${a.cell} 는 보안 4종이 아니다(규칙 ${RULES_VERSION}). 아직 초록 아님: ${a.verdict.why} — 채워지면 자동 서명`;
          const id = ports.post(`withdraw:${a.cell}:${RULES_VERSION}`, BUTLER_SUPERVISOR, body, 'info');
          if (id !== null) { delete state.sent[a.key]; mem.appendCase(kase('escalation-withdrawn', a.cell, body.slice(0, 200), now, [...(escId ? [`msg:${escId}`] : []), ...(id ? [`msg:${id}`] : [])])); }
          break;
        }
        case 'expire-holds': {
          for (const row of ports.expireHolds(BUTLER_SEAT, { merged: ports.merged, green })) { r.expired.push(row.id); mem.appendCase(kase('hold-expire', row.id, row.audit, now, [`hold:${row.id}`])); }
          break;
        }
        case 'propose-narrow': case 'escalate-hold': {
          const to = a.kind === 'propose-narrow' ? a.to : BUTLER_SUPERVISOR;
          const id = ports.post(a.key, to, a.body, 'request');
          state.sent[a.key] = now.toISOString();
          if (id) {
            (a.kind === 'propose-narrow' ? r.proposed : r.escalated).push(`${a.hold}#${id}`);
            mem.appendCase(kase(a.kind === 'propose-narrow' ? 'hold-propose' : 'hold-escalate', a.hold, a.body.slice(0, 160), now, [`hold:${a.hold}`, `msg:${id}`]));
          }
          break;
        }
        case 'notify-freed': {
          if (state.sent[a.key]) break;
          const id = ports.post(a.key, a.hand, a.body, 'info');
          state.sent[a.key] = now.toISOString(); r.freed.push(a.hand);
          mem.appendCase(kase('hand-freed', a.hand, a.body.slice(0, 120), now, [`hold:${a.hold}`, ...(id ? [`msg:${id}`] : [])]));
          break;
        }
        case 'answer-hand': {
          const signedCell = a.afterSign;
          if (signedCell && !r.signed.includes(signedCell)) { // the sign did not land → never say «signed»; JUD decides
            const why = r.signRefused.find(x => x.cell === signedCell)?.why ?? 'sign not verified';
            const id = ports.escalateHand(a.hand, BUTLER_SUPERVISOR, `${signedCell} 서명 실패(${why}) — JUD 판정 필요`);
            if (id) { r.escalated.push(`hand#${a.hand.id}`); mem.appendCase(kase('hand-escalate', `#${a.hand.id}`, `sign failed: ${why}`, now, [`msg:${id}`])); }
            break;
          }
          const id = ports.answerHand(a.hand, a.text, a.owner, a.deadline, a.refs);
          if (id) { r.answered.push(a.hand.id); mem.appendCase(kase('hand-answer', `#${a.hand.id}`, a.text.slice(0, 200), now, [...a.refs, `msg:${id}`])); }
          break;
        }
        case 'escalate-hand': {
          const id = ports.escalateHand(a.hand, BUTLER_SUPERVISOR, a.text);
          if (id) { r.escalated.push(`hand#${a.hand.id}`); mem.appendCase(kase('hand-escalate', `#${a.hand.id}`, a.text.slice(0, 200), now, [`msg:${id}`])); }
          break;
        }
        case 'voice-hand': {
          const out = level === 'live' && ports.voiceHand ? await ports.voiceHand(a.hand, a.facts).catch(() => null) : null;
          if (out?.action === 'resolve') {
            const id = ports.answerHand(a.hand, out.text, out.owner, out.deadline, ['voice']);
            if (id) { r.answered.push(a.hand.id); mem.appendCase(kase('hand-answer', `#${a.hand.id}`, `voice: ${out.text.slice(0, 180)}`, now, [`msg:${id}`])); }
          } else {
            const text = out?.action === 'escalate' ? out.text : `판정 판단이 필요한 ✋ — ${a.facts}${level !== 'live' ? ` (판정 집사 ${level}: 목소리 꺼짐)` : ''}`;
            const id = ports.escalateHand(a.hand, BUTLER_SUPERVISOR, text);
            if (id) { r.escalated.push(`hand#${a.hand.id}`); mem.appendCase(kase('hand-escalate', `#${a.hand.id}`, text.slice(0, 200), now, [`msg:${id}`])); }
          }
          break;
        }
      }
    } catch (e) {
      mem.appendCase(kase('verify-failed', a.kind, e instanceof Error ? e.message : String(e), now));
    }
  }
  // BUTLER-SIGN-MERGED-PATCHID: every yellow cell with a merged PR that is still unsigned gets its one-line reason — in the tick
  // report each tick, and as one «not-signed» case whenever that reason changes (never a silent «signed 0 refused 0»).
  for (const c of view.cells) {
    if (c.status !== 'yellow' || r.signed.includes(c.id) || r.signRefused.some(x => x.cell === c.id)) continue;
    const v = plan.verdicts.get(c.id);
    if (!v || (v.kind === 'missing' && v.missing.length === 1 && v.missing[0] === 'merged PR')) continue; // supply, not judging
    const why = notSignedWhy(c.id, v, view, state);
    if (!why) continue;
    r.notSigned.push({ cell: c.id, why });
    const key = `not-signed:${c.id}`; const fp = new Bun.CryptoHasher('sha256').update(why).digest('hex').slice(0, 12);
    if (state.sent[key]?.endsWith(`#${fp}`)) continue;
    state.sent[key] = `${now.toISOString()}#${fp}`;
    mem.appendCase(kase('not-signed', c.id, why, now, [`cell:${c.id}`]));
  }
  state.frozenLast = Object.fromEntries(plan.frozen);
  // report: one OP digest per 30 min, only when something closed or stuck
  const moved = r.signed.length + r.expired.length + r.escalated.length + r.answered.length + r.proposed.length;
  let digest: number | null = null;
  if (moved && (!state.lastDigestAt || now.getTime() - Date.parse(state.lastDigestAt) >= DIGEST_EVERY_MS)) {
    const since = state.lastDigestAt ?? new Date(now.getTime() - DIGEST_EVERY_MS).toISOString();
    const recent = mem.cases(500).filter(c => c.at > since);
    const n = (k: Case['kind']) => recent.filter(c => c.kind === k).length;
    digest = ports.post(`butler-digest:${now.toISOString().slice(0, 16)}`, 'OP',
      `[판정 집사 · 30분] 초록 ${new Set(recent.filter(c => c.kind === 'sign').map(c => c.subject)).size} · HOLD 만료 ${n('hold-expire')} · 좁히기 제안 ${n('hold-propose')} · ✋ 답 ${n('hand-answer')} · JUD 올림 ${n('hand-escalate') + n('escalate-cell') + n('hold-escalate')} · 묶인 손 ${plan.frozen.size} — eln loop butler status`, 'status');
    state.lastDigestAt = now.toISOString();
  }
  state.lastTickAt = now.toISOString();
  state.rulesVersion = RULES_VERSION;
  state.voiceTurns = mem.readState().voiceTurns; // the voice spends budget mid-tick — keep its write
  mem.writeState(state);
  return { ...r, digest };
}
