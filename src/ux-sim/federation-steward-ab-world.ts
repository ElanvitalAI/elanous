// SIM-STEWARD-AB-1125 — «federation day hour»: does the steward structure let OP spend its context on decisions?
// Deterministic (seeded) world: OP + TC + JUD coordinators · 12 fake hands · 20 cells · 15 PRs · ≈120 mails/h · 6 hands go idle.
// The OP seat is a scripted fake LLM (rules below, calibrated to the 11-25 trace); the steward pieces are the REAL code:
//   #40054 createMailTriageLedger + wire rule (only D-merged absorbed) · isInfoSeatMail passive path
//   #40061 hand-raise ladder on a real MsgStore (sweepHandRaises · applyHandOutcome)
//   #40065 wait contract (msg ask wait-until → sweepWaitContracts)
//   #40074 suggestWatch (structured PR ask → pregate-receipt watch)  [open PR, merged locally]
//   #40073 buildMatchingTable · formatAssignmentPrompt · createAssignmentGate · nextHourlyDue  [open PR, merged locally]
//   #40072 seatAssign (writer check · refusals)  [open PR — injected: deps.seatAssign]
// Arm A = stewards off · Arm B = main + the three open PRs (measured on main ⊕ #40072/73/74 before this PR; on a branch that
//   carries SEAT-MAIL-PASSIVE-DEFAULT arm B runs B's wire rules over the NEW triage ledger, so its numbers are not main's) · Arm B+ = design projection (LOOP-TRAFFIC R1/R2/R5/X + 30-min C
// digest + cheap classifier) built from the same real functions — not code that exists as a running loop.
// Arm B' = B ⊕ SEAT-MAIL-PASSIVE-DEFAULT ⊕ RESOURCE-OPT-STEWARD — REAL code only: the OP turn decision is the triage
//   verdict (mail-triage.ts → seat-mail-turn-policy.ts seatMailRoute · sender role from the ladder · dup merge), passive
//   mail rides the next turn or a digest turn after the queue's passive window (INFO_MAIL_IDLE_BATCH_MS · digest text =
//   seatMailBundleText), wait-cancel notices are the real ledger rows routed the same way, and resource work is
//   createSteward (every 10 min ⊕ seat-idle +5 min) whose refused rows alone reach OP (formatExceptionPrompt).
// #40072/#40074 are open PRs: seatAssign and suggestWatch are injected (deps) so this device compiles on main — the
// runner passes the real functions when they are present, else the models in federation-steward-ab-models.ts.
import { createMailTriageLedger, type MailTriageInput } from '../tui/triage/mail-triage.js';
import { isInfoSeatMail } from '../tui/seat-mail-digest.js';
import { MsgStore, type MessageEnvelope } from '../msg/msg-store.js';
import { applyHandOutcome, buildFederationLadder, sweepHandRaises, type CeoCard } from '../msg/hand-raise-ladder.js';
import { sweepWaitContracts, waitUntilRef } from '../msg/msg-wait-contract.js';
import { buildMatchingTable, formatAssignmentPrompt, exceptionTable, type MatchingTable, type PaneIn, type CellIn } from '../resource-opt/matching-table.js';
import { createAssignmentGate } from '../resource-opt/assignment-gate.js';
import { nextHourlyDue } from '../resource-opt/scheduler.js';
import { createSteward, formatExceptionPrompt } from '../resource-opt/steward.js';
import { senderAboveOnLadder } from '../tui/seat-mail-turn-policy.js';
import { SEAT_MAIL_PASSIVE_DIGEST_BODY_CHARS, seatMailBundleText, seatMailDigestLine, seatMailDigestPrefix } from '../tui/seat-mail-digest.js';
import { INFO_MAIL_IDLE_BATCH_MS } from '../tui/core/queue.js';
import type { SimSeatAssign, SimSeatAssignDeps, SimSuggestWatch } from './federation-steward-ab-models.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { estimateTokens } from '../tokens.js';

export type Arm = 'A' | 'B' | 'Bplus' | 'Bprime';
const SEC = 1000;
const MIN = 60 * SEC;
export const T0 = Date.parse('2026-11-25T01:00:00.000Z'); // 10:00 KST
export const HOUR_S = 3600;
export const DRAIN_S = 4500; // 75 min: latencies that start late can still finish
const VERSION = '0.3.40';

// ── seeded PRNG ───────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const between = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
function weighted<T>(r: () => number, table: ReadonlyArray<readonly [T, number]>): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of table) { x -= w; if (x <= 0) return v; }
  return table[table.length - 1]![0];
}

// ── world ─────────────────────────────────────────────────────────────────────────────────────
export const TC_HANDS = Array.from({ length: 8 }, (_, i) => `TC-H${i + 1}`);
export const JUD_HANDS = Array.from({ length: 4 }, (_, i) => `JUD-H${i + 1}`);
export const HANDS = [...TC_HANDS, ...JUD_HANDS];
const coordinatorOf = (seat: string): string => (seat.startsWith('JUD') ? 'JUD' : 'TC');
const ladder = buildFederationLadder({ spaces: [
  { coordinator: 'TC', seats: ['TC', ...TC_HANDS] }, { coordinator: 'OP', seats: ['OP'] }, { coordinator: 'JUD', seats: ['JUD', ...JUD_HANDS] },
] });

export type Cat = 'status' | 'info' | 'dup' | 'result' | 'req-routine' | 'req-op' | 'question' | 'question-ledger' | 'hand' | 'crown' | 'idle-fwd' | 'reply-new' | 'ladder' | 'wait-notice';
export interface MailSpec {
  key: string; atS: number; from: string; to: string; kind: string | null; intent: 'info' | 'request' | 'decision' | 'alert';
  refs?: string[]; replyToAsk?: string; crown?: string; result?: 'done' | 'failed'; body: string; cat: Cat; needsOP: boolean; pr?: number;
}
export interface PrSpec { number: number; author: string; branch: string; head: string; draft: boolean; receiptAtS: number | null; touches: string }
export interface World {
  seed: number; mails: MailSpec[]; preAsks: Array<{ key: string; atS: number; to: string; pr?: number; replyAtS: number | null }>;
  idleAt: Map<string, number>; cells: ChecklistItem[]; cellUpdated: Map<string, number>; prs: PrSpec[]; judge: Array<{ id: string; sinceS: number; pr: number }>;
}

const pad = (r: () => number, head: string): string => {
  // body length drawn from the 11-25 08–14 OP window (n=1068 · median 245 · mean 288 chars)
  const len = weighted(r, [[110, 10], [240, 24], [320, 10], [480, 3], [700, 2], [1000, 1]] as const);
  const filler = ' · 근거 원장 확인 · 다음 점검 시각 · 영수 경로 seat-state/… · 칸 상태 🟡 · 착지 대기열 · 메모';
  let s = head;
  while (s.length < len) s += filler;
  return s.slice(0, len);
};

export function buildWorld(seed: number): World {
  const r = mulberry32(seed);
  // PRs: 15 · 2 draft · 6 non-draft without receipt (2 of them get a receipt from their author during the hour)
  const prs: PrSpec[] = [];
  for (let i = 0; i < 15; i++) {
    const author = HANDS[i % HANDS.length]!;
    const number = 50001 + i;
    const draft = i === 13 || i === 14;
    const noReceipt = i >= 7 && i <= 12;
    prs.push({ number, author, branch: `${author.toLowerCase()}/cell-${i + 1}`, head: (number.toString(16) + 'abcdef0123456789').slice(0, 12).padEnd(40, '0'),
      draft, receiptAtS: draft ? null : noReceipt ? (i <= 8 ? between(r, 900, 3000) : null) : -600, touches: `src/area${i + 1}/` });
  }
  // cells: 20 · 11 owned+active · 5 unowned (P0 2 · P1 2 · P2 1) · 4 stalled (owner set, no move for 3h)
  const cells: ChecklistItem[] = [];
  const cellUpdated = new Map<string, number>();
  for (let i = 0; i < 20; i++) {
    const id = `C${String(i + 1).padStart(2, '0')}`;
    const unowned = i >= 11 && i <= 15;
    const stalled = i >= 16;
    const priority = (unowned ? ['P0', 'P0', 'P1', 'P1', 'P2'][i - 11] : stalled ? ['P0', 'P1', 'P1', 'P2'][i - 16] : pick(r, ['P0', 'P1', 'P2'])) as 'P0' | 'P1' | 'P2';
    const owner = unowned ? undefined : HANDS[(i * 5) % HANDS.length]!;
    // C12 (P0 unowned) declares a path PR #50004 (TC-H4, live) is writing → seatAssign must refuse with live-writer.
    const body = i === 11 ? '대상 경로: src/area4/' : `대상 경로: src/cell${i + 1}/`;
    cells.push({ id, title: `cell ${id} — ${unowned ? 'unowned work' : stalled ? 'stalled work' : 'active work'}`, status: 'yellow', ...(owner ? { owner } : {}), priority, body, doneCriterion: `${id} PR landed` } as ChecklistItem);
    cellUpdated.set(id, stalled ? -3 * 3600 : -between(r, 5, 50) * 60);
  }
  const judge = [{ id: 'J-1', sinceS: -50 * 60, pr: 50002 }, { id: 'J-2', sinceS: -35 * 60, pr: 50003 }, { id: 'J-3', sinceS: -5 * 60, pr: 50005 }];
  // 6 hands go idle at seeded minutes (owners of stalled cells included by the draw when it happens)
  const idleAt = new Map<string, number>();
  const pool = [...HANDS];
  while (idleAt.size < 6) { const h = pool.splice(Math.floor(r() * pool.length), 1)[0]!; idleAt.set(h, between(r, 3, 50) * 60); }

  // OP asks already in flight at 10:00 (40 · made 09:30–10:00) — their replies are the status storm
  const preAsks: World['preAsks'] = [];
  for (let i = 0; i < 40; i++) {
    const to = r() < 0.3 ? pick(r, ['TC', 'JUD']) : pick(r, HANDS);
    const pr = r() < 0.5 ? pick(r, prs).number : undefined;
    const atS = -between(r, 1, 30) * 60;
    preAsks.push({ key: `ask-pre-${i}`, atS, to, ...(pr ? { pr } : {}), replyAtS: atS + between(r, 4, 30) * 60 + between(r, 0, 59) });
  }
  const mails: MailSpec[] = [];
  const kindStatus = (): string | null => weighted(r, [[null, 65], ['notice', 20], ['status', 10], ['info', 5]] as const);
  const kindInfo = (): string | null => weighted(r, [[null, 50], ['notice', 30], ['info', 10], ['announce', 5], ['report', 5]] as const);
  // 40 status replies (each pre-ask's reply that lands inside the hour; the rest are drawn in-hour)
  for (const ask of preAsks) {
    const atS = Math.max(5, ask.replyAtS ?? between(r, 60, 3500));
    mails.push({ key: `status-${ask.key}`, atS, from: ask.to, to: 'OP', kind: kindStatus(), intent: 'info', replyToAsk: ask.key, cat: 'status', needsOP: false,
      ...(ask.pr ? { pr: ask.pr } : {}), body: pad(r, `[${ask.to}] ${ask.pr ? `#${ask.pr} ` : ''}회신: 요청하신 것 진행했습니다 — PR 올림/영수 확인/수락`) });
  }
  // 35 info / announce
  for (let i = 0; i < 35; i++) {
    const kind = kindInfo();
    const from = pick(r, ['TC', 'JUD', 'RES', 'REL', 'UX', 'MK', 'CLAUDE-OP']);
    mails.push({ key: `info-${i}`, atS: between(r, 10, 3590), from, to: 'OP', kind, intent: 'info', cat: 'info', needsOP: false,
      ...(kind === 'announce' ? { refs: [`announce:A-${i}`] } : {}), body: pad(r, `[${from}] ${kind === 'announce' ? '공지' : '정보'}: 착지 후통보 · 공보 · 상태 카드`) });
  }
  // 20 duplicates of earlier status/info mails (same fields + body, 1–8 min later)
  const originals = mails.filter((m) => m.cat === 'status' || m.cat === 'info');
  for (let i = 0; i < 20; i++) {
    const o = pick(r, originals);
    mails.push({ ...o, key: `dup-${i}-${o.key}`, atS: Math.min(3595, o.atS + between(r, 60, 480)), cat: 'dup', needsOP: false });
  }
  // 4 result mails (3 done · 1 failed — a failed result is OP's to see)
  for (let i = 0; i < 4; i++) {
    const from = pick(r, HANDS); const failed = i === 3;
    mails.push({ key: `result-${i}`, atS: between(r, 60, 3500), from, to: 'OP', kind: 'report', intent: 'info', result: failed ? 'failed' : 'done', cat: 'result', needsOP: failed,
      body: pad(r, `[${from}] 캡슐 결과 ${failed ? 'FAILED' : 'done'}`) });
  }
  // 8 routine requests (computable: run a pregate · who takes this cell · judge this) + 3 that need OP
  for (let i = 0; i < 8; i++) {
    const from = pick(r, ['TC', 'JUD', ...HANDS.slice(0, 4)]);
    const what = pick(r, ['#5001x pregate 돌려 주세요', '이 칸 누구에게 줄까요(유휴 손 있음)', '판정 대기 40분 — JUD 서브 붙여 주세요']);
    mails.push({ key: `req-routine-${i}`, atS: between(r, 60, 3500), from, to: 'OP', kind: r() < 0.5 ? 'request' : null, intent: 'request', cat: 'req-routine', needsOP: false, body: pad(r, `[${from}] 요청: ${what}`) });
  }
  for (const [i, what] of ['TC 손 2 를 JUD 판정 적체로 빌려 주세요(범위 넘음)', 'gcp1 VM 켜도 되나요(비용)', 'P0 둘이 같은 손을 원함 — 우선순위 결정'].entries()) {
    mails.push({ key: `req-op-${i}`, atS: between(r, 300, 3300), from: pick(r, ['TC', 'JUD', 'RES']), to: 'OP', kind: 'request', intent: 'request', cat: 'req-op', needsOP: true, body: pad(r, `[요청] ${what}`) });
  }
  // 5 questions (4 judgment · 1 answerable from the ledger)
  for (let i = 0; i < 5; i++) {
    const ledger = i === 4;
    const from = pick(r, ['TC', 'JUD', 'UX', 'RES']);
    mails.push({ key: `question-${i}`, atS: between(r, 120, 3400), from, to: 'OP', kind: i % 2 ? 'decision' : 'question', intent: 'decision', cat: ledger ? 'question-ledger' : 'question', needsOP: !ledger,
      body: pad(r, `[${from}] 질문: ${ledger ? '#50003 영수 GREEN 인가요?' : '이 방향으로 가도 되나요 — 결정 필요'}`) });
  }
  // 3 ✋: a → TC (TC resolves in 4 min) · b → JUD (JUD silent; must reach OP by the ladder) · c → OP directly (cross-space)
  const handAt = [between(r, 300, 1500), between(r, 600, 1800), between(r, 900, 2400)];
  mails.push({ key: 'hand-a', atS: handAt[0]!, from: 'TC-H2', to: 'TC', kind: 'request', intent: 'decision', refs: ['block:B-a', 'seat:TC-H2', 'reason:HUMAN_DECISION'], cat: 'hand', needsOP: false, body: '[✋ NEED HUMAN · TC-H2] 리뷰 지적 처리 방향 결정 필요' });
  mails.push({ key: 'hand-b', atS: handAt[1]!, from: 'JUD-H1', to: 'JUD', kind: 'request', intent: 'decision', refs: ['block:B-b', 'seat:JUD-H1', 'reason:HUMAN_DECISION'], cat: 'hand', needsOP: true, body: '[✋ NEED HUMAN · JUD-H1] 판정 기준 충돌 — 결정 필요' });
  mails.push({ key: 'hand-c', atS: handAt[2]!, from: 'TC', to: 'OP', kind: 'request', intent: 'decision', refs: ['block:B-c', 'seat:TC', 'reason:BUDGET'], cat: 'hand', needsOP: true, body: '[✋ NEED HUMAN · TC] 범위 밖 자원(유료 VM) 결정 필요' });
  // 1 CEO directive (TG relay)
  mails.push({ key: 'crown-0', atS: between(r, 600, 3000), from: 'OP', to: 'OP', kind: 'request', intent: 'request', crown: '👑 TG-OP', cat: 'crown', needsOP: true, body: '[TG-OP 👑] 지금 유휴 손 전부 P0 로 돌리고 30분 뒤 숫자 보고' });
  mails.sort((a, b) => a.atS - b.atS || a.key.localeCompare(b.key));
  return { seed, mails, preAsks, idleAt, cells, cellUpdated, prs, judge };
}

// ── arm run ───────────────────────────────────────────────────────────────────────────────────
export interface TurnRec {
  startS: number; endS: number; opener: 'mail' | 'wake' | 'watch' | 'steward' | 'hand-crown' | 'question' | 'digest'; items: Array<{ key: string; cat: string; needsOP: boolean; via: string }>;
  payloadTokens: number; statusTokens: number; decisionTokens: number;
}
export interface ArmResult {
  arm: Arm; turns: TurnRec[]; mailsToOp: number; mailsOpenedTurn: number; mailsAbsorbed: number; mailsDigested: number;
  escalations: Array<{ key: string; cat: string; needsOP: boolean; via: string; atS: number }>;
  missed: Array<{ key: string; why: string }>; reachedOpAt: Record<string, number | null>;
  idle: Array<{ seat: string; idleS: number; assignedS: number | null; by: string | null }>;
  receipts: { missingAtStart: number; supplied: number; byStewardOrOp: number };
  assignments: { bySteward: number; byOp: number; byCoordinatorOnOpAsk: number; refusals: number };
  log: string[];
}

interface Pending { key: string; cat: string; needsOP: boolean; via: string; text: string; atS: number; prio: number; status: boolean; opener: TurnRec['opener'] }

export async function runArm(arm: Arm, world: World, deps: { storePath: string; setClock: (ms: number) => void; seatAssign: SimSeatAssign; suggestWatch: SimSuggestWatch }): Promise<ArmResult> {
  const { seatAssign, suggestWatch } = deps;
  const PRIME = arm === 'Bprime';
  // B' shares B's random stream: the same replies/forwards are drawn, so the difference is the code under test.
  const r = mulberry32(world.seed * 31 + (arm === 'A' ? 1 : arm === 'B' || arm === 'Bprime' ? 2 : 3));
  const opR = mulberry32(world.seed * 7 + 11); // OP propensities identical across arms
  const store = new MsgStore(deps.storePath);
  const log: string[] = [];
  const L = (s: number, line: string): void => { log.push(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} ${line}`); };
  const at = (s: number): void => deps.setClock(T0 + s * SEC);
  const triage = createMailTriageLedger({ now: () => Date.now(), ...(arm === 'Bplus' ? { model: cheapModel } : {}) });
  const msgIdOf = new Map<string, number>();
  const askMsg = new Map<string, number>(); // ask key → ledger id (for replyTo)
  const queue: Pending[] = [];
  const digestBuf: string[] = [];
  const turns: TurnRec[] = [];
  const escalations: ArmResult['escalations'] = [];
  const reachedOpAt: Record<string, number | null> = {};
  let mailsToOp = 0, mailsOpenedTurn = 0, mailsAbsorbed = 0, mailsDigested = 0;
  const assignments = { bySteward: 0, byOp: 0, byCoordinatorOnOpAsk: 0, refusals: 0 };
  const idleState = new Map<string, { idleS: number; assignedS: number | null; by: string | null }>();
  const busyHands = new Set(HANDS);
  const cellOwner = new Map(world.cells.map((c) => [c.id, c.owner ?? null] as const));
  const cellTouched = new Map(world.cellUpdated);
  const receiptAt = new Map(world.prs.map((p) => [p.number, p.receiptAtS] as const));
  const missingAtStart = world.prs.filter((p) => !p.draft && (p.receiptAtS === null || p.receiptAtS > 0)).length;
  let receiptByStewardOrOp = 0;
  const future: Array<{ s: number; fn: () => unknown; tag: string }> = [];
  const later = (s: number, tag: string, fn: () => unknown): void => { future.push({ s, fn, tag }); };
  const wakes: Array<{ s: number; ask: string; round: number }> = [];
  const asks = new Map<string, { to: string; pr?: number; replied: boolean; askedS: number; mode: 'reply-wake' | 'watch' | 'wait-contract' }>();

  // ── arm policies ──
  const passiveOnMain = (m: MailSpec): boolean => isInfoSeatMail({ kind: m.kind, intent: m.intent, body: m.body } as never);

  const opAsk = (s: number, to: string, pr: number | undefined, why: string, key: string): void => {
    // How OP asks for a follow-up: A = mail + «HH:MM 회신» wake · B/B+ = watch when structured (#40074), else msg ask wait-until (#40065)
    const watch = arm !== 'A' && pr !== undefined ? suggestWatch({ kind: 'pregate', refs: [`pr:${pr}`] }) : null;
    const mode = arm === 'A' ? 'reply-wake' : watch ? 'watch' : 'wait-contract';
    at(s);
    const env: MessageEnvelope = { from: 'OP', to, body: `[OP] ${why}${watch ? ' — no reply needed —' : ' · HH:MM 회신'}`, kind: mode === 'wait-contract' ? 'question' : 'request', intent: mode === 'wait-contract' ? 'decision' : 'request',
      refs: [...(pr ? [`pr:${pr}`] : []), ...(mode === 'wait-contract' ? [waitUntilRef(T0 + (s + 600) * SEC)] : [])] };
    const id = store.append(env).id;
    askMsg.set(key, id);
    asks.set(key, { to, ...(pr ? { pr } : {}), replied: false, askedS: s, mode });
    if (mode === 'reply-wake') wakes.push({ s: s + 600, ask: key, round: 1 });
    if (mode === 'watch') {
      const rAt = receiptAt.get(pr!) ?? null;
      if (rAt !== null) later(Math.max(s + 30, rAt), `watch-fire ${key}`, () => fireWatch(key, watch!, Math.max(s + 30, rAt)));
    }
    // replies: the counterpart answers (habit) — watch asks were told «no reply needed»
    const replyP = mode === 'watch' ? 0.2 : 0.85;
    if (r() < replyP && s >= 0) {
      const rs = s + between(r, 240, 1500);
      later(rs, `reply ${key}`, () => deliverMail({ key: `reply-${key}`, atS: rs, from: to, to: 'OP', kind: weighted(r, [[null, 70], ['notice', 20], ['status', 10]] as const), intent: 'info', replyToAsk: key, cat: 'reply-new', needsOP: false, ...(pr ? { pr } : {}), body: `[${to}] 회신: 확인했습니다${pr ? ` #${pr}` : ''} · 다음 단계 진행` }));
    }
  };

  const enqueue = (p: Pending): void => { queue.push(p); };

  function cheapSync(input: { replyTo: number | null; body: string }): 'B' | 'C' | 'D' {
    if (typeof input.replyTo === 'number') return 'D';
    if (/요청|돌려 주세요|붙여 주세요/u.test(input.body)) return 'B';
    return 'C';
  }
  function cheapModel(input: MailTriageInput): Promise<'A' | 'B' | 'C' | 'D' | null> {
    // B+ only: a fake cheap classifier for mail with no structured signal — replies to an ask are updates (D), «요청» B, else info C.
    const body = input.body ?? '';
    if (typeof input.replyTo === 'number') return Promise.resolve('D');
    if (/요청|돌려 주세요|붙여 주세요/u.test(body)) return Promise.resolve('B');
    return Promise.resolve('C');
  }

  const renderMail = (m: MailSpec, id: number): string => `[seat-mail #${id} from ${m.from}${m.kind ? ` kind ${m.kind}` : ''}] ${m.body}`;

  // ── B': the real verdict decides — absorbed (D merged) · passive (waits for the next turn / the digest) · a turn ──
  const passiveQ: Array<{ id: number; from: string; kind: string | null; body: string; atS: number }> = [];
  function primeDispose(verdict: ReturnType<typeof triage.ingest>, id: number, from: string, kind: string | null, body: string,
    p: { key: string; cat: string; needsOP: boolean; text: string; atS: number; prio: number; status: boolean; opener: TurnRec['opener'] }): void {
    if (verdict.cls === 'D' && !verdict.costsTurn) { mailsAbsorbed += 1; L(p.atS, `absorb #${id} ${p.key} (${verdict.routeReason} ${verdict.key})`); return; }
    if (!verdict.costsTurn) { mailsDigested += 1; passiveQ.push({ id, from, kind, body, atS: p.atS }); return; }
    enqueue({ key: p.key, cat: p.cat, needsOP: p.needsOP, via: `mail:${verdict.routeReason}`, text: p.text, atS: p.atS, prio: p.prio, status: p.status, opener: p.opener });
  }
  // A fired watch: B/B+ open a watch turn (as #40074 models it). B' — the self-timer's real delivery on main is a ledger
  // notice to the seat itself (self-timer-watch.ts defaultPostNotice: kind «notice» · no intent), so it goes through the
  // same triage/router as every other mail.
  function fireWatch(key: string, cond: string, atS: number): void {
    const text = `[watch fired] ${cond} satisfied — ask ${key}`;
    if (!PRIME) { enqueue({ key: `watch-${key}`, cat: 'watch', needsOP: false, via: 'watch', text, atS, prio: 3, status: true, opener: 'watch' }); return; }
    at(atS);
    const row = store.append({ from: 'OP', to: 'OP', kind: 'notice', body: text });
    mailsToOp += 1;
    const v = triage.ingest({ msgId: row.id, from: 'OP', kind: 'notice', intent: row.intent ?? null, body: text, senderAbove: false });
    primeDispose(v, row.id, 'OP', 'notice', text, { key: `watch-${key}`, cat: 'watch', needsOP: false, text, atS, prio: 3, status: true, opener: 'watch' });
  }
  const takePassiveBundle = (): string => {
    if (passiveQ.length === 0) return '';
    const items = passiveQ.splice(0, passiveQ.length);
    // As notice-producers.ts enqueues a passive mail: its short digest line ⊕ the fold span (sender · body offset).
    return seatMailBundleText(items.map((x) => ({ text: x.body, source: 'seat-mail', msgId: x.id, passive: true,
      digest: seatMailDigestLine({ id: x.id, sender: x.from, body: x.body, kind: x.kind }, SEAT_MAIL_PASSIVE_DIGEST_BODY_CHARS),
      mail: { sender: x.from, digestBodyAt: seatMailDigestPrefix({ id: x.id, sender: x.from, body: x.body, kind: x.kind }).length } })));
  };

  function deliverMail(m: MailSpec): void {
    at(m.atS);
    const replyTo = m.replyToAsk ? askMsg.get(m.replyToAsk) : undefined;
    const env: MessageEnvelope = { from: m.from, to: m.to, body: m.body, ...(m.kind ? { kind: m.kind } : {}), intent: m.intent, ...(m.refs ? { refs: m.refs } : {}),
      ...(replyTo ? { replyTo } : {}), ...(m.crown ? { crownDirective: m.crown } : {}), ...(m.result ? { result: { state: m.result } as never } : {}) };
    let id: number;
    try { id = store.append(env).id; } catch { id = store.append({ ...env, body: `${env.body} ·${m.key}` }).id; }
    msgIdOf.set(m.key, id);
    if (m.replyToAsk) { const a = asks.get(m.replyToAsk); if (a) a.replied = true; }
    if (m.to !== 'OP') return; // ✋ to TC/JUD: their ladder handles it
    mailsToOp += 1;
    const text = renderMail(m, id);
    const isHand = m.cat === 'hand' || m.cat === 'ladder';
    const crownOrHand = m.crown !== undefined || isHand;
    const prio = crownOrHand ? 0 : m.cat === 'question' || m.cat === 'question-ledger' ? 1 : 2;
    const opener: TurnRec['opener'] = crownOrHand ? 'hand-crown' : prio === 1 ? 'question' : 'mail';
    const status = !(m.needsOP || m.cat === 'question-ledger' || m.cat === 'req-routine' || m.cat === 'req-op');
    if (arm === 'A') { enqueue({ key: m.key, cat: m.cat, needsOP: m.needsOP, via: 'mail', text, atS: m.atS, prio, status, opener }); return; }
    // B / B+: real triage ledger; wire rule on main absorbs only D merged (or result-carrying D); C rides the passive path only for SEAT_MAIL_INFO_KINDS.
    const verdict = triage.ingest({ msgId: id, from: m.from, kind: m.kind, intent: m.intent, crownDirective: m.crown ?? null, replyTo: replyTo ?? null, refs: m.refs ?? null,
      resultState: m.result ?? null, body: m.body, ...(PRIME ? { senderAbove: senderAboveOnLadder(ladder, m.from, 'OP') ?? null } : {}) });
    if (PRIME) { primeDispose(verdict, id, m.from, m.kind, m.body, { key: m.key, cat: m.cat, needsOP: m.needsOP, text, atS: m.atS, prio, status, opener }); return; }
    let cls = verdict.cls;
    if (arm === 'Bplus' && verdict.signal === 'default') { const c = cheapSync({ replyTo: replyTo ?? null, body: m.body }); if (c) cls = c; }
    const absorbed = cls === 'D' && (verdict.merged || arm === 'Bplus') && m.result !== 'failed';
    if (arm === 'Bplus' && cls !== verdict.cls) L(m.atS, `cheap-model ${m.key} ${verdict.cls}→${cls}`);
    if (absorbed) { mailsAbsorbed += 1; L(m.atS, `absorb #${id} ${m.key} (${verdict.cls} ${verdict.key})`); return; }
    if (arm === 'Bplus' && cls === 'C') { mailsDigested += 1; digestBuf.push(`#${id} · ${m.from} · ${m.kind ?? '-'} · ${m.body.slice(0, 120)}`); return; }
    if (arm === 'B' && passiveOnMain(m)) { mailsDigested += 1; digestBuf.push(`#${id} · ${m.from} · ${m.kind ?? '-'} · ${m.body.slice(0, 120)}`); return; }
    enqueue({ key: m.key, cat: m.cat, needsOP: m.needsOP, via: `mail:${cls}`, text, atS: m.atS, prio, status, opener });
  }

  // ── hand idle / assignment ──
  const setIdle = (seat: string, s: number): void => {
    busyHands.delete(seat);
    idleState.set(seat, { idleS: s, assignedS: null, by: null });
    L(s, `${seat} idle`);
    // the hand tells its coordinator «일감 0» (standing pull rule); coordinators forward to OP sometimes (same in all arms)
    if (r() < 0.6) {
      const fs = s + between(r, 120, 360);
      later(fs, `fwd-idle ${seat}`, () => deliverMail({ key: `idle-fwd-${seat}`, atS: fs, from: coordinatorOf(seat), to: 'OP', kind: null, intent: 'info', cat: 'idle-fwd', needsOP: false, body: `[${coordinatorOf(seat)}] ${seat} 일감 0 · 유휴 — 배정 필요하면 알려 주세요` }));
    }
    if (arm === 'Bplus') later(s + 5, `projection seat-idle ${seat}`, () => projectionTick(s + 5, `seat-idle ${seat}`));
    // B': RESOURCE_OPT_IDLE_TRIGGER_MS (5 min) after the seat-idle event, the steward runs if the seat is still idle.
    if (PRIME) later(s + 300, `steward seat-idle ${seat}`, () => { const st = idleState.get(seat); return st && st.assignedS === null ? stewardTick(s + 300, `seat-idle ${seat}`) : undefined; });
  };
  const markAssigned = (seat: string, s: number, by: string, cellId: string | null): void => {
    const st = idleState.get(seat);
    if (!st || st.assignedS !== null) return;
    st.assignedS = s; st.by = by; busyHands.add(seat);
    if (cellId) { cellOwner.set(cellId, seat); cellTouched.set(cellId, s); }
    L(s, `${seat} assigned ${cellId ?? '(cell via coordinator)'} by ${by}`);
  };

  const panesAt = (s: number): PaneIn[] => ['OP', 'TC', 'JUD', ...HANDS].map((seat) => {
    const st = idleState.get(seat);
    return st && st.assignedS === null ? { seat, state: 'IDLE', since: T0 + st.idleS * SEC } : { seat, state: 'BUSY' };
  });
  const cellsAt = (): CellIn[] => world.cells.map((c) => ({ id: c.id, title: c.title, status: 'yellow', ...(cellOwner.get(c.id) ? { owner: cellOwner.get(c.id)! } : {}), priority: c.priority, updatedAt: new Date(T0 + (cellTouched.get(c.id) ?? 0) * SEC).toISOString() }));
  const tableAt = (s: number, skip: ReadonlySet<string> = new Set(), refused?: ReadonlyArray<{ cell: string; seat?: string }>): MatchingTable => {
    at(s);
    return buildMatchingTable({ now: T0 + s * SEC, version: VERSION, hqSeat: 'OP', panes: panesAt(s), cells: cellsAt().filter((c) => !skip.has(c.id)), ...(refused ? { refused } : {}),
      prs: world.prs.map((p) => ({ number: p.number, headSha: p.head, branch: p.branch, isDraft: p.draft })),
      greenLanes: world.prs.filter((p) => { const a = receiptAt.get(p.number); return a !== null && a !== undefined && a <= s; }).map((p) => `${p.number}-${p.head.slice(0, 12)}-node-b`),
      judgeQueue: world.judge.map((j) => ({ id: j.id, sinceMs: T0 + j.sinceS * SEC, pr: j.pr })) });
  };
  const assignDeps = (actor: string, s: number): SimSeatAssignDeps => ({
    now: () => new Date(T0 + s * SEC),
    coordinators: () => ({ hq: 'OP', spaces: ['TC', 'JUD'] }),
    federationSeats: () => new Set(['OP', 'TC', 'JUD', ...HANDS]),
    findCell: (id) => { const item = world.cells.find((c) => c.id === id); return item ? { version: VERSION, item: { ...item, owner: cellOwner.get(id) ?? undefined } as ChecklistItem } : undefined; },
    writers: (paths) => world.prs.filter((p) => paths.some((x) => p.touches.startsWith(x) || x.startsWith(p.touches)))
      .map((p) => ({ kind: 'pr' as const, ref: `#${p.number}`, title: `${p.author} work`, updatedAt: new Date(T0 + (s - 1200) * SEC).toISOString(), branch: p.branch, paths: [p.touches] })),
    assign: (_v, cellId, seat) => { const from = cellOwner.get(cellId) ?? null; return { from, outcome: from === seat ? 'same' : 'assigned' }; },
    post: (mail) => { at(s); return { id: store.append({ ...mail, intent: 'request' }).id }; },
    wake: async () => ({ result: 'woken' }),
    pool: () => ({ hosts: ['minim5', 'node-b', 'node-c'], scope: 'test-universe runs (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head fetch/push to the pool host)', source: 'code-default' }),
  });
  // seatAssign is async only for wake(); the sim awaits it synchronously via a settled flag
  const runAssign = async (actor: string, seat: string, cellId: string, s: number): Promise<{ ok: boolean; reason?: string; code?: string }> => {
    const res = await seatAssign({ seat, cellId, actor, why: 'sim' }, assignDeps(actor, s));
    return res.ok ? { ok: true } : { ok: false, reason: res.reason, code: res.code };
  };

  // B' steward (RESOURCE-OPT-STEWARD · real createSteward): assign via SeatAssign · pregate request to the author · refused rows → OP
  let stewardS = 0;
  const steward = createSteward({
    now: () => T0 + stewardS * SEC,
    build: async (refused) => tableAt(stewardS, new Set(), refused),
    assign: async (row) => {
      const actor = row.seat.startsWith('JUD') ? 'JUD' : 'TC';
      const res = await runAssign(actor, row.seat, row.cell, stewardS);
      if (res.ok) { assignments.bySteward += 1; markAssigned(row.seat, stewardS, `steward(${actor})`, row.cell); return { ok: true }; }
      assignments.refusals += 1;
      return { ok: false, ...(res.code ? { code: res.code } : {}), reason: res.reason ?? 'refused' };
    },
    requestPregate: (row) => {
      const s0 = stewardS; const done = s0 + between(r, 600, 900);
      later(done, `steward pregate #${row.pr}`, () => { if ((receiptAt.get(row.pr) ?? Infinity) > done) { receiptAt.set(row.pr, done); receiptByStewardOrOp += 1; L(done, `steward receipt #${row.pr}`); } });
      return true;
    },
    requestJudge: () => true,
  });
  async function stewardTick(s: number, why: string): Promise<void> {
    stewardS = s;
    at(s);
    const out = await steward.run(why);
    if (out.exceptions.length && out.table) {
      enqueue({ key: `exception-${s}`, cat: 'exception', needsOP: true, via: 'steward-exception', text: formatExceptionPrompt(out.table, out.exceptions), atS: s, prio: 1, status: false, opener: 'steward' });
    }
    L(s, `steward (${why}) assigned ${out.assigned.length} routine ${out.routine.length} exceptions ${out.exceptions.length}`);
  }

  // B+ projection tick (LOOP-TRAFFIC R1 match ⊕ R2 receipt ⊕ X exceptions) — design projection, not running code
  const pregateDispatched = new Set<number>();
  const refusedCells = new Set<string>();
  const exceptionSent = new Set<string>();
  let lastTickS = -1;
  async function projectionTick(s: number, why: string): Promise<void> {
    if (s === lastTickS) return;
    lastTickS = s;
    let table = tableAt(s, refusedCells);
    const first = table;
    const exceptions: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      let refusedNow = false;
      for (const row of table.rows) {
        if (row.kind !== 'assign') continue;
        const actor = row.seat.startsWith('JUD') ? 'JUD' : 'TC';
        const res = await runAssign(actor, row.seat, row.cell, s);
        if (res.ok) { assignments.bySteward += 1; markAssigned(row.seat, s, `steward(${actor})`, row.cell); }
        else { assignments.refusals += 1; refusedCells.add(row.cell); refusedNow = true; if (!exceptionSent.has(row.cell)) { exceptionSent.add(row.cell); exceptions.push(row.id); } L(s, `R1 refuse ${row.cell}→${row.seat}: ${res.reason}`); }
      }
      if (!refusedNow) break;
      table = tableAt(s, refusedCells); // fall through: the next cell for the same idle seat
    }
    for (const row of table.rows) {
      if (row.kind === 'assign') {
        continue;
      } else if (row.kind === 'pregate' && !pregateDispatched.has(row.pr)) {
        pregateDispatched.add(row.pr);
        const done = s + between(r, 600, 900);
        later(done, `R2 receipt #${row.pr}`, () => { if ((receiptAt.get(row.pr) ?? Infinity) > done) { receiptAt.set(row.pr, done); receiptByStewardOrOp += 1; L(done, `R2 receipt #${row.pr}`); } });
      }
      // judge rows → JUD sub (R3) without OP; idle rows with no cell are not exceptions (nothing to decide)
    }
    if (exceptions.length) {
      const ex = exceptionTable(first, exceptions);
      enqueue({ key: `exception-${s}`, cat: 'exception', needsOP: true, via: 'steward-exception', text: formatAssignmentPrompt(ex), atS: s, prio: 1, status: false, opener: 'steward' });
    }
    L(s, `steward tick (${why}) rows ${table.rows.length} exceptions ${exceptions.length}`);
  }

  // B hourly resource-opt (#40073): the whole table becomes one OP turn; OP disposes rows (SeatAssign now on the branch)
  const gate = createAssignmentGate({ startTurnIfIdle: () => ({ opened: true, turnId: 'sim' }) as never, now: () => Date.now(), write: () => {} });
  let gateResult: string[] = [];
  const hourly: number[] = [];
  if (arm === 'B') {
    let due = nextHourlyDue(T0 - 1);
    while (due < T0 + DRAIN_S * SEC) { hourly.push(Math.round((due - T0) / SEC)); due = nextHourlyDue(due); }
  }

  // ── the OP seat (fake LLM) ──
  let busyUntil = 0;
  const handTimers: Array<{ s: number; key: string }> = [];
  async function opTurn(s: number): Promise<void> {
    if (queue.length === 0) return;
    queue.sort((a, b) => a.prio - b.prio || a.atS - b.atS);
    const opener = queue[0]!.opener;
    const items = queue.splice(0, queue.length);
    const digest = arm !== 'A' && digestBuf.length && (arm === 'B' || s - (digestSince ?? s) >= 30 * 60) ? digestBuf.splice(0, digestBuf.length) : [];
    if (digest.length) digestSince = null;
    let statusTok = digest.length ? estimateTokens(`[seat-mail digest]\n${digest.join('\n')}`) : 0;
    let primeDigestItems = 0;
    if (PRIME) { primeDigestItems = passiveQ.length; const bundle = takePassiveBundle(); if (bundle) statusTok += estimateTokens(bundle); }
    let decisionTok = 0;
    let dur = 25;
    const recItems: TurnRec['items'] = [];
    const outputs: string[] = [];
    for (const it of items) {
      recItems.push({ key: it.key, cat: it.cat, needsOP: it.needsOP, via: it.via });
      if (reachedOpAt[it.key] === undefined) reachedOpAt[it.key] = s;
      const tok = estimateTokens(it.text);
      if (it.status) statusTok += tok; else decisionTok += tok;
      if (it.via !== 'mail' || arm === 'A') escalations.push({ key: it.key, cat: it.cat, needsOP: it.needsOP, via: it.via, atS: s });
      dur += it.status ? 6 : 20;
      const mail = world.mails.find((m) => m.key === it.key) ?? null;
      // OP's response per item
      if (it.cat === 'wake') {
        // A reply-collection wake: MsgList → rows into context
        const rows = Array.from({ length: 12 }, (_, i) => `#${150000 + i} · ${pick(opR, HANDS)} · notice · 회신/상태 줄 — 확인 후 다음 단계 · 영수 경로 · 칸 🟡`);
        statusTok += estimateTokens(`MsgList →\n${rows.join('\n')}`) + 30;
        const ask = asks.get(it.key.replace(/^wake-/, '').replace(/-r\d+$/, ''));
        const round = Number(/-r(\d+)$/.exec(it.key)?.[1] ?? 1);
        if (ask && !ask.replied && round < 3) { wakes.push({ s: s + 600, ask: it.key.replace(/^wake-/, '').replace(/-r\d+$/, ''), round: round + 1 }); outputs.push(`re-ask ${ask.to}`); statusTok += 40; }
        continue;
      }
      if (it.cat === 'watch') { statusTok += 30; continue; }
      if (it.status) {
        statusTok += 25; // MsgAck / one ack line
        // follow-up habit: OP asks a status reply's sender for the next step (calibrated: 0.35)
        if ((it.cat === 'status' || it.cat === 'reply-new' || it.cat === 'dup') && opR() < 0.35 && mail?.from !== 'OP') {
          const from = mail?.from ?? pick(opR, HANDS);
          opAsk(s, from, mail?.pr, `다음 단계 확인 (${it.key})`, `ask-${it.key}-${s}`);
          statusTok += 60;
        }
        if (it.cat === 'idle-fwd') {
          const seat = /(TC-H\d|JUD-H\d)/u.exec(it.text)?.[1];
          if (seat && opR() < 0.3) {
            if (arm === 'A') {
              // ask the coordinator to assign; the coordinator does it 8–20 min later
              const coord = coordinatorOf(seat);
              opAsk(s, coord, undefined, `${seat} 에 칸 배정 후 회신`, `ask-assign-${seat}`);
              const ds = s + between(r, 480, 1200);
              later(ds, `coord-assign ${seat}`, () => { const st = idleState.get(seat); if (st && st.assignedS === null) { assignments.byCoordinatorOnOpAsk += 1; markAssigned(seat, ds, `${coord}(on OP ask)`, null); } });
            } else {
              const t = tableAt(s);
              const row = t.rows.find((x) => x.kind === 'assign' && x.seat === seat);
              if (row && row.kind === 'assign') { const res = await runAssign('OP', seat, row.cell, s); if (res.ok) { assignments.byOp += 1; markAssigned(seat, s, 'OP(SeatAssign)', row.cell); } else assignments.refusals += 1; }
            }
            decisionTok += 120; dur += 15;
          }
        }
        continue;
      }
      // decision items
      decisionTok += 150; // OP's decision output
      if (it.cat === 'hand' || it.cat === 'ladder') {
        const id = msgIdOf.get(it.key);
        if (id !== undefined && arm !== 'A') { at(s); try { applyHandOutcome(store, { msgId: id, action: 'resolve', text: 'OP decision: proceed (sim)', actor: 'OP' }, handDeps()); } catch (e) { L(s, `hand outcome failed ${it.key}: ${String(e).slice(0, 80)}`); } }
      }
      if (it.cat === 'req-routine') {
        // A/B: OP relays to a coordinator / author and waits; B+ would not see it with ⑥ (not modelled)
        opAsk(s, pick(opR, ['TC', 'JUD']), undefined, `처리 요청 (${it.key})`, `ask-${it.key}`);
      }
      if (it.cat === 'resource-opt') {
        // the hourly table: dispose every row
        const t = gate.active();
        const lines: string[] = []; const rows: Array<{ role: string; toolName: string; toolArgs: unknown; toolResult: unknown }> = [];
        for (const row of t?.rows ?? []) {
          dur += 15; decisionTok += 60;
          if (row.kind === 'assign') {
            const res = await runAssign('OP', row.seat, row.cell, s);
            if (res.ok) { assignments.byOp += 1; markAssigned(row.seat, s, 'OP(hourly table)', row.cell); rows.push({ role: 'tool', toolName: 'SeatAssign', toolArgs: { seat: row.seat, cell: row.cell, why: `[${row.id}]` }, toolResult: 'ok' }); }
            else { assignments.refusals += 1; lines.push(`${row.id} reject: ${res.reason}`); }
          } else if (row.kind === 'pregate') {
            rows.push({ role: 'tool', toolName: 'SeatAssign', toolArgs: { body: `[${row.id}] pregate #${row.pr}` }, toolResult: 'ok' });
            const done = s + between(r, 900, 1500);
            later(done, `author pregate #${row.pr}`, () => { if ((receiptAt.get(row.pr) ?? Infinity) > done) { receiptAt.set(row.pr, done); receiptByStewardOrOp += 1; } });
          } else if (row.kind === 'judge') rows.push({ role: 'tool', toolName: 'SeatAssign', toolArgs: { body: `[${row.id}] judge ${row.cell}` }, toolResult: 'ok' });
          else lines.push(`${row.id} reject: no open cell for this seat in the table`);
        }
        gate.noteTurnEnded({ lines, rows: rows as never });
        gateResult = [JSON.stringify(gate.check())];
      }
      if (it.cat === 'exception') { dur += 30; }
      if (it.cat === 'crown') {
        // 대표: move idle hands to P0 now — B/B+ via SeatAssign, A via mail to TC (8–20 min)
        for (const [seat, st] of idleState) {
          if (st.assignedS !== null) continue;
          if (arm === 'A') { const ds = s + between(r, 480, 1200); later(ds, `crown-assign ${seat}`, () => { const x = idleState.get(seat); if (x && x.assignedS === null) { assignments.byCoordinatorOnOpAsk += 1; markAssigned(seat, ds, 'TC(on 👑 relay)', null); } }); }
          else { const t = tableAt(s); const row = t.rows.find((x) => x.kind === 'assign' && x.seat === seat); if (row && row.kind === 'assign') { const res = await runAssign('OP', seat, row.cell, s); if (res.ok) { assignments.byOp += 1; markAssigned(seat, s, 'OP(👑)', row.cell); } } }
        }
      }
    }
    const payload = statusTok + decisionTok;
    turns.push({ startS: s, endS: s + dur, opener, items: recItems, payloadTokens: payload, statusTokens: statusTok, decisionTokens: decisionTok });
    L(s, `OP turn (${opener}) items ${items.length}${digest.length || primeDigestItems ? ` +digest ${digest.length || primeDigestItems}` : ''} · status ${statusTok}t · decision ${decisionTok}t · ${dur}s`);
    busyUntil = s + dur;
  }
  let digestSince: number | null = null;
  const handDeps = () => ({ ladder, now: () => Date.now(), raiseDecision: (_c: CeoCard) => { L(0, 'CEO card raised'); } });

  // pre-asks enter the asks table per arm policy (made before the window)
  for (const a of world.preAsks) {
    const watch = arm !== 'A' && a.pr !== undefined;
    at(a.atS);
    const id = store.append({ from: 'OP', to: a.to, body: `[OP] 확인 요청 ${a.key}`, kind: watch ? 'request' : arm === 'A' ? 'request' : 'question', intent: watch ? 'request' : arm === 'A' ? 'request' : 'decision',
      refs: [...(a.pr ? [`pr:${a.pr}`] : []), ...(!watch && arm !== 'A' ? [waitUntilRef(T0 + (a.atS + 600) * SEC)] : [])] }).id;
    askMsg.set(a.key, id);
    asks.set(a.key, { to: a.to, ...(a.pr ? { pr: a.pr } : {}), replied: false, askedS: a.atS, mode: arm === 'A' ? 'reply-wake' : watch ? 'watch' : 'wait-contract' });
    if (arm === 'A') { let w = a.atS + 600; let round = 1; while (w < 0 && round < 3) { w += 600; round += 1; } if (w >= 0) wakes.push({ s: w, ask: a.key, round }); }
    if (watch) { const rAt = receiptAt.get(a.pr!) ?? null; if (rAt !== null && rAt > 0) later(rAt, `watch-fire ${a.key}`, () => fireWatch(a.key, `pregate-receipt:${a.pr}`, rAt)); }
  }

  // ── main loop (5 s steps) ──
  const mailQ = [...world.mails];
  const handSent = new Set<string>();
  for (let s = 0; s <= DRAIN_S; s += 5) {
    at(s);
    for (const [seat, is] of world.idleAt) if (is <= s && is > s - 5) setIdle(seat, s);
    while (mailQ.length && mailQ[0]!.atS <= s) {
      const m = mailQ.shift()!;
      if (m.atS > HOUR_S) continue;
      deliverMail({ ...m, atS: s });
      if (m.cat === 'hand') { handSent.add(m.key); if (m.key === 'hand-a') handTimers.push({ s: s + 240, key: m.key }); }
    }
    for (let i = future.length - 1; i >= 0; i--) if (future[i]!.s <= s) { const f = future.splice(i, 1)[0]!; await f.fn(); }
    for (let i = wakes.length - 1; i >= 0; i--) {
      const w = wakes[i]!;
      if (w.s > s) continue;
      wakes.splice(i, 1);
      enqueue({ key: `wake-${w.ask}-r${w.round}`, cat: 'wake', needsOP: false, via: 'wake', text: `[wake] ${w.ask} 회신 확인 (round ${w.round})`, atS: s, prio: 3, status: true, opener: 'wake' });
    }
    // TC resolves ✋a at +4m (its own rung) — every arm
    for (let i = handTimers.length - 1; i >= 0; i--) if (handTimers[i]!.s <= s) {
      const t = handTimers.splice(i, 1)[0]!; const id = msgIdOf.get(t.key);
      if (id !== undefined && arm !== 'A') { try { applyHandOutcome(store, { msgId: id, action: 'resolve', text: 'TC: 리뷰 지적은 FU 칸으로', actor: 'TC' }, handDeps()); } catch (e) { L(s, `TC resolve failed ${String(e).slice(0, 80)}`); } }
      L(s, `TC resolves ${t.key}`);
    }
    if (arm !== 'A' && s % 60 === 0) {
      // #40061 ladder sweep (any TUI runs it) — escalations to OP become ✋ mail in OP's queue
      for (const act of sweepHandRaises(store, { ...handDeps() })) {
        L(s, `ladder: ✋ #${act.msgId} ${act.from} → ${act.to} after ${act.waitedMin}m`);
        if (act.to === 'OP' && act.mailId !== null) {
          const hk = [...msgIdOf.entries()].find(([, v]) => v === act.msgId)?.[0] ?? `hand-${act.msgId}`;
          const m = store.getMessage(act.mailId)!;
          msgIdOf.set(`ladder-${hk}`, act.mailId);
          mailsToOp += 1;
          triage.ingest({ msgId: act.mailId, from: m.from, kind: m.kind ?? null, intent: m.intent ?? null, refs: m.refs ?? null, body: m.body });
          enqueue({ key: `ladder-${hk}`, cat: 'ladder', needsOP: true, via: 'ladder', text: `[seat-mail #${act.mailId} from ${m.from}] ${m.body}`, atS: s, prio: 0, status: false, opener: 'hand-crown' });
          reachedOpAt[`ladder-${hk}`] = reachedOpAt[`ladder-${hk}`] ?? undefined as never;
        }
      }
      // #40065 wait-contract sweep (reminders → cancel notices to the asker)
      for (const act of sweepWaitContracts(store, { now: Date.now(), involving: 'OP', parentOf: ladder.parentOf, log: () => {} })) {
        if (act.state === 'cancelled' && act.asker === 'OP' && arm === 'Bplus') { mailsDigested += 1; digestBuf.push(`#${act.messageId} wait cancelled (${act.counterpart})`); continue; }
        if (act.state === 'cancelled' && act.asker === 'OP' && PRIME) {
          const row = store.findByProvenanceKey(`msg-wait-cancel:${act.messageId}`);
          if (row) {
            mailsToOp += 1;
            const v = triage.ingest({ msgId: row.id, from: row.from, kind: row.kind ?? null, intent: row.intent ?? null, refs: row.refs ?? null, body: row.body,
              senderAbove: senderAboveOnLadder(ladder, row.from, 'OP') ?? null });
            primeDispose(v, row.id, row.from, row.kind ?? null, row.body, { key: `waitcancel-${act.messageId}`, cat: 'wait-notice', needsOP: false, text: `[seat-mail #${row.id} from ${row.from}] ${row.body}`, atS: s, prio: 2, status: true, opener: 'mail' });
          }
          continue;
        }
        if (act.state === 'cancelled' && act.asker === 'OP') enqueue({ key: `waitcancel-${act.messageId}`, cat: 'wait-notice', needsOP: false, via: 'wait-contract', text: `[wait cancelled] #${act.messageId} ${act.counterpart} no reply in 15m`, atS: s, prio: 2, status: true, opener: 'mail' });
      }
    }
    if (arm === 'B' && hourly.includes(s)) {
      const table = tableAt(s);
      gate.open(table);
      enqueue({ key: `resource-opt-${s}`, cat: 'resource-opt', needsOP: false, via: 'steward-table', text: formatAssignmentPrompt(table), atS: s, prio: 1, status: false, opener: 'steward' });
      L(s, `resource-opt table rows ${table.rows.length}`);
    }
    if (arm === 'Bplus' && s % 600 === 0) await projectionTick(s, 'cron */10');
    if (PRIME && s % 600 === 0) await stewardTick(s, 'cron */10');
    // B': passive mail opens its own (digest) turn only when the oldest has waited the queue's passive window.
    if (PRIME && passiveQ.length && s - passiveQ[0]!.atS >= INFO_MAIL_IDLE_BATCH_MS / SEC && queue.length === 0 && s >= busyUntil) {
      enqueue({ key: `digest-${s}`, cat: 'digest', needsOP: false, via: 'digest', text: '', atS: s, prio: 3, status: true, opener: 'digest' });
    }
    if (arm === 'Bplus' && digestBuf.length && digestSince === null) digestSince = s;
    if (arm === 'Bplus' && digestBuf.length && digestSince !== null && s - digestSince >= 30 * 60 && queue.length === 0 && s >= busyUntil) {
      enqueue({ key: `digest-${s}`, cat: 'digest', needsOP: false, via: 'digest', text: '[mail digest]', atS: s, prio: 3, status: true, opener: 'mail' });
    }
    if (s >= busyUntil && queue.length) await opTurn(s);
  }
  // escalation latencies: ✋/CEO/question must reach an OP turn — ✋b via the ladder
  const missed: ArmResult['missed'] = [];
  for (const m of world.mails.filter((x) => x.needsOP && (x.cat === 'hand' || x.cat === 'crown' || x.cat === 'question'))) {
    const key = m.key === 'hand-b' ? 'ladder-hand-b' : m.key;
    const reached = reachedOpAt[key];
    const limit = m.cat === 'question' ? 15 * 60 : m.key === 'hand-b' ? 20 * 60 : 10 * 60; // ✋b: 10 min at JUD + 10 min at OP
    if (reached === undefined || reached === null) missed.push({ key: m.key, why: m.key === 'hand-b' && arm === 'A' ? 'JUD silent · no ladder → never reached OP' : 'never reached an OP turn' });
    else if (reached - m.atS > limit) missed.push({ key: m.key, why: `late ${Math.round((reached - m.atS) / 60)}m` });
    reachedOpAt[m.key] = reached ?? null;
  }
  store.close();
  return {
    arm, turns, mailsToOp, mailsOpenedTurn: turns.filter((t) => t.opener === 'mail' || t.opener === 'question').length, mailsAbsorbed, mailsDigested, escalations, missed, reachedOpAt,
    idle: [...idleState].map(([seat, st]) => ({ seat, idleS: st.idleS, assignedS: st.assignedS, by: st.by })),
    receipts: { missingAtStart, supplied: world.prs.filter((p) => !p.draft && (p.receiptAtS === null || p.receiptAtS > 0) && (receiptAt.get(p.number) ?? Infinity) <= DRAIN_S).length, byStewardOrOp: receiptByStewardOrOp },
    assignments, log: [...log, ...gateResult.map((g) => `gate ${g}`)],
  };
}
