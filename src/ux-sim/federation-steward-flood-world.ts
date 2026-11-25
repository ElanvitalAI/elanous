// SIM-STEWARD-AB «flood» — the GENERATION side of OP's mail (MAIL-ANTI-FLOOD E·F·G · CEO 11-25).
// Companion to the steward A/B world (OP-turn side): this one measures what seats generate, what reaches OP's mailbox,
// how deep reply chains get, and how much of OP's mail is its own wakes or coach injections.
//
// Calibration (11-25 08–14 · 1068 mails to OP · ≈178/h): OP→OP 26% (waker fire/expire notices · resident checks ·
// auto-wakes) · CLAUDE-OP 10% (10-min situation boards · landing notices · retro reminders · crown relays) · TC 19% ·
// RES 10% · JUD 7% · UX/MK/REL 11% · hands 17% · kind none 60% · notice 21%.
//
// Real code on every arm: MsgStore (ledger · acks · replyTo) · isInfoSeatMail (main receiver path, arm A).
// Arm B' and B'' take the receiver route as a dependency (`route`) — the B' turn policy («passive default»).
// Arm B'' adds the sender side: gatePost ⊕ storeGateDeps (E shape · F divert · G back-pressure on the real ledger,
// turn stamps and folded ledger) and the TUI feed createSelfWakeCoachFeed (self-wakes → wakes · coach note ≤1/30 min ·
// folded digest). OP is a scripted fake LLM with the same propensities in every arm.
import { MsgStore, type MessageEnvelope } from '../msg/msg-store.js';
import { isInfoSeatMail } from '../tui/seat-mail-digest.js';
import { gatePost, storeGateDeps } from '../msg/post-gate.js';
import { createSelfWakeCoachFeed } from '../tui/self-wake-coach-feed.js';

export type FloodArm = 'A' | 'Bp' | 'Bpp';
const SEC = 1000;
export const FLOOD_T0 = Date.parse('2026-11-25T00:00:00.000Z');
export const FLOOD_HOUR_S = 3600;
const DRAIN_S = 900;

/** Receiver route input — structured ledger fields only (the B' policy contract). */
export interface RouteInput {
  kind: string | null; intent: string | null; crownDirective: string | null; refs: string[] | null; replyTo: number | null;
  needsAck: boolean | null; priority: number | null; resultState: 'done' | 'failed' | null; fromKind: string | null; senderAbove: boolean | null; body: string;
}
export type ReceiverRoute = (m: RouteInput) => 'turn' | 'passive';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
function weighted<T>(r: () => number, table: ReadonlyArray<readonly [T, number]>): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of table) { x -= w; if (x <= 0) return v; }
  return table[table.length - 1]![0];
}

type Cat = 'self' | 'coach-board' | 'coach-notice' | 'coach-retro' | 'coach-crown' | 'coach-ask' | 'info' | 'dup' | 'status' | 'req-routine' | 'req-op'
  | 'question' | 'question-ledger' | 'hand' | 'alert' | 'result' | 'result-failed' | 'crown';
/** One generated mail: how senders write it today (legacy) and how an E-disciplined sender writes it (structured). */
export interface FloodMail {
  key: string; atS: number; from: string; cat: Cat; needsOP: boolean; body: string;
  legacy: Omit<MessageEnvelope, 'from' | 'to' | 'body'>;
  structured: Omit<MessageEnvelope, 'from' | 'to' | 'body'> & { needsReply: boolean };
  replyToAsk?: string;
}
export interface FloodWorld { seed: number; hours: number; mails: FloodMail[]; preAsks: Array<{ key: string; atS: number; to: string; replyAtS: number }>; harnessTurnsS: number[] }
/** The measured hour is the last one; the hours before it bring the ledger, turn stamps and queues to steady state. */
export const FLOOD_HOURS = 2;

const SEATS = ['TC', 'TC', 'TC', 'TC', 'RES', 'RES', 'JUD', 'UX', 'MK', 'REL', 'TC-H-CX-3', 'TC-H-CX-5', 'JUD-C', 'TC-H-CX-4', 'HAND-ELN-ELS-API'] as const;
const pad = (s: string): string => `${s} · 근거 원장 · 다음 점검 시각 · 칸 상태 🟡`;

export function buildFloodWorld(seed: number, hours: number = FLOOD_HOURS): FloodWorld {
  const r = mulberry32(seed);
  const mails: FloodMail[] = [];
  const harnessTurnsS: number[] = [];
  for (let h = 0; h < hours; h++) {
    const hourMails = buildHour(r, h * FLOOD_HOUR_S, `h${h}-`);
    mails.push(...hourMails);
    for (let i = 0; i < 20; i++) harnessTurnsS.push(h * FLOOD_HOUR_S + between(r, 30, FLOOD_HOUR_S - 30));
  }
  mails.sort((a, b) => a.atS - b.atS || a.key.localeCompare(b.key));
  harnessTurnsS.sort((a, b) => a - b);
  // 25 OP asks made before the window; their replies (status) land in the first hour
  const preAsks = Array.from({ length: 25 }, (_, i) => { const atS = -between(r, 60, 1800); return { key: `pre-${i}`, atS, to: SEATS[i % SEATS.length]!, replyAtS: Math.max(10, atS + between(r, 300, 3000)) }; });
  return { seed, hours, mails, preAsks, harnessTurnsS };
}

function buildHour(r: () => number, base: number, prefix: string): FloodMail[] {
  const mails: FloodMail[] = [];
  const at = (): number => base + between(r, 5, FLOOD_HOUR_S - 5);
  const add = (m: FloodMail): void => { mails.push({ ...m, key: `${prefix}${m.key}` }); };
  // OP → OP (46/h): waker fired 28 · expired 10 · resident-check reminders 4 · auto-wakes 4
  for (let i = 0; i < 46; i++) {
    const what = i < 28 ? '⏰ 깨우개 발화 · mail-reply' : i < 38 ? '⌛ 깨우개 만료(expired)' : i < 42 ? '[OP 상주 점검] 1시간 전체 활용 점검' : '[자동 깨움] 다음 점검';
    const legacy = i < 38 ? { kind: 'notice', intent: 'info' as const } : i < 42 ? { kind: 'request', intent: 'request' as const } : { intent: 'info' as const };
    add({ key: `self-${i}`, atS: at(), from: 'OP', cat: 'self', needsOP: false, body: pad(`${what} ${i}`), legacy, structured: { kind: 'notice', needsReply: false } });
  }
  // CLAUDE-OP (17/h): boards 6 (every 10 min) · landing notices 8 · retro reminders/orders 2 · crown relays 1
  for (let i = 0; i < 6; i++) add({ key: `coach-board-${i}`, atS: base + 30 + i * 600, from: 'CLAUDE-OP', cat: 'coach-board', needsOP: false, body: pad(`[⚡ 전시 상황판 ${i}]`),
    legacy: { kind: 'decision', intent: 'decision' }, structured: { kind: 'info', needsReply: false } });
  for (let i = 0; i < 8; i++) add({ key: `coach-notice-${i}`, atS: at(), from: 'CLAUDE-OP', cat: 'coach-notice', needsOP: false, body: pad(`[코치 직권 착지 후통보] #4${i}`),
    legacy: { kind: 'info', intent: 'info' }, structured: { kind: 'info', needsReply: false } });
  for (let i = 0; i < 2; i++) add({ key: `coach-retro-${i}`, atS: at(), from: 'CLAUDE-OP', cat: 'coach-retro', needsOP: false, body: pad(`[코치 · 회고 알림 ${i}]`),
    legacy: { kind: 'decision', intent: 'decision' }, structured: { kind: 'notice', needsReply: false } });
  // crown relays with the CEO's words: 8 of 54 coach «decision» mails in 08–14 (≈1.3/h) — 1/h here.
  for (let i = 0; i < 1; i++) add({ key: `coach-crown-${i}`, atS: at(), from: 'CLAUDE-OP', cat: 'coach-crown', needsOP: true, body: pad(`CEO words relay ${i}`),
    legacy: { kind: 'decision', intent: 'decision' }, structured: { kind: 'request', crownDirective: `crown-relay-${i}`, needsReply: true } });
  // other seats: info/notice 40 · dups 10 · routine requests 8 · OP-level requests 3 · questions 5 · ✋ 1 (+1 by ladder) · alert 1 · results 4 · crown TG 1
  const infos: FloodMail[] = [];
  for (let i = 0; i < 40; i++) {
    const from = SEATS[between(r, 0, SEATS.length - 1)]!;
    const k = weighted(r, [[null, 55], ['notice', 25], ['info', 10], ['report', 10]] as const);
    const m: FloodMail = { key: `info-${i}`, atS: at(), from, cat: 'info', needsOP: false, body: pad(`[${from}] 정보 ${i}: 착지 후통보 · 공보`),
      legacy: { ...(k ? { kind: k } : {}), intent: 'info' }, structured: { kind: k ?? 'info', needsReply: false } };
    infos.push(m); add(m);
  }
  for (let i = 0; i < 10; i++) { const o = infos[between(r, 0, infos.length - 1)]!; add({ ...o, key: `dup-${i}`, cat: 'dup', atS: Math.min(base + FLOOD_HOUR_S - 1, o.atS + between(r, 60, 480)) }); }
  for (let i = 0; i < 8; i++) {
    const from = SEATS[between(r, 0, SEATS.length - 1)]!;
    add({ key: `req-routine-${i}`, atS: at(), from, cat: 'req-routine', needsOP: false, body: pad(`[${from}] 요청: pregate 돌려 주세요 ${i}`),
      legacy: r() < 0.5 ? { kind: 'request', intent: 'request' } : { intent: 'request' }, structured: { kind: 'request', needsReply: false } });
  }
  for (let i = 0; i < 3; i++) add({ key: `req-op-${i}`, atS: at(), from: ['TC', 'JUD', 'RES'][i]!, cat: 'req-op', needsOP: true, body: pad(`[요청] 범위 넘음 ${i}`),
    legacy: { kind: 'request', intent: 'request' }, structured: { kind: 'request', refs: ['reason:CROSS_SCOPE'], needsReply: true } });
  for (let i = 0; i < 5; i++) {
    const ledger = i === 4;
    add({ key: `question-${i}`, atS: at(), from: ['TC', 'JUD', 'UX', 'RES', 'TC'][i]!, cat: ledger ? 'question-ledger' : 'question', needsOP: !ledger, body: pad(`[질문] ${ledger ? '#50003 영수 GREEN 인가요?' : '이 방향 결정 필요'} ${i}`),
      legacy: { kind: i % 2 ? 'decision' : 'question', intent: 'decision' }, structured: { kind: i % 2 ? 'decision' : 'question', needsReply: true } });
  }
  const hand = { kind: 'request', intent: 'decision' as const, refs: ['block:B-c', 'seat:TC', 'reason:BUDGET'] };
  add({ key: 'hand-c', atS: base + between(r, 900, 2400), from: 'TC', cat: 'hand', needsOP: true, body: '[✋ NEED HUMAN · TC] 범위 밖 자원 결정 필요', legacy: hand, structured: { ...hand, needsReply: true } });
  const ladder = { kind: 'request', intent: 'decision' as const, refs: ['block:B-b', 'seat:JUD-H1', 'reason:HUMAN_DECISION', 'escalated-from:JUD'] };
  add({ key: 'hand-b-ladder', atS: base + between(r, 1200, 2400), from: 'JUD', cat: 'hand', needsOP: true, body: '[✋ ESCALATED · JUD → OP] 판정 기준 충돌', legacy: ladder, structured: { ...ladder, needsReply: true } });
  add({ key: 'alert-0', atS: at(), from: 'RES', cat: 'alert', needsOP: true, body: pad('[stall] TC-H-CX-3 2시간 정지'), legacy: { kind: 'stall-alert', intent: 'alert' }, structured: { kind: 'stall-alert', needsReply: false } });
  for (let i = 0; i < 4; i++) {
    const failed = i === 3;
    const res = { kind: 'report', intent: 'info' as const, result: { state: failed ? 'failed' : 'done' } as never };
    add({ key: `result-${i}`, atS: at(), from: 'TC-H-CX-5', cat: failed ? 'result-failed' : 'result', needsOP: failed, body: pad(`캡슐 결과 ${failed ? 'FAILED' : 'done'} ${i}`), legacy: res, structured: { ...res, needsReply: false } });
  }
  const tg = { kind: 'coord', refs: ['telegram-message:9001', 'telegram-chat:1'], origin: { kind: 'human' as const } };
  add({ key: 'crown-tg', atS: base + between(r, 600, 3000), from: 'CEO', cat: 'crown', needsOP: true, body: '[TG-OP crown] 지금 유휴 손 전부 P0 로', legacy: tg, structured: { ...tg, needsReply: true } });
  return mails;
}

export interface FloodTurn { startS: number; opener: 'mail' | 'digest' | 'wake' | 'harness'; mailItems: Array<{ key: string; needsOP: boolean }> }
export interface FloodResult {
  arm: FloodArm;
  /** Measured window [windowStartS, windowStartS + 3600). */
  windowStartS: number;
  turns: FloodTurn[];
  rowsToOp: number; rowsToOpKindless: number;
  /** Rows whose sender gave no kind (raw) · of those, how many opened an OP turn on their own. */
  rowsSentKindless: number; kindlessOpened: number;
  /** Every post addressed to OP in the window (rows ⊕ diverted ⊕ folded) · of those, sent without a kind. */
  postsToOp: number; postsSentKindless: number; rowsToOpSelf: number; rowsToOpCoach: number;
  /** Self/coach rows that carry a crown directive (a crown relay is crown traffic, not a coach injection). */
  rowsToOpSelfCoachCrown: number;
  generatedPerSeat: Record<string, number>; diverted: { selfWake: number; coachNote: number; folded: number };
  maxReplyChainDepth: number; missed: Array<{ key: string; why: string }>; backpressureLogs: number;
}

interface Pending { key: string; atS: number; needsOP: boolean; cat: Cat | 'reply'; from: string; msgId: number | null }

export async function runFloodArm(arm: FloodArm, world: FloodWorld, deps: { storePath: string; divertedRoot: string; setClock: (ms: number) => void; route: ReceiverRoute }): Promise<FloodResult> {
  const opR = mulberry32(world.seed * 7 + 11);
  let curS = 0;
  const endS = world.hours * FLOOD_HOUR_S;
  const winS = endS - FLOOD_HOUR_S;
  const inWin = (): boolean => curS >= winS && curS < endS;
  const r = mulberry32(world.seed * 31 + (arm === 'A' ? 1 : arm === 'Bp' ? 2 : 3));
  const store = new MsgStore(deps.storePath);
  const at = (s: number): void => deps.setClock(FLOOD_T0 + s * SEC);
  const generated: Record<string, number> = {};
  const diverted = { selfWake: 0, coachNote: 0, folded: 0 };
  let rowsToOp = 0, rowsToOpKindless = 0, rowsSentKindless = 0, postsToOp = 0, postsSentKindless = 0, kindlessOpened = 0, rowsToOpSelf = 0, rowsToOpCoach = 0, rowsToOpSelfCoachCrown = 0, backpressureLogs = 0;
  const turnQ: Pending[] = [];
  const passiveQ: Pending[] = [];
  const wakeQ: number[] = [];
  const turns: FloodTurn[] = [];
  const reached = new Map<string, number>();
  const askIds = new Map<string, number>();
  const future: Array<{ s: number; fn: () => void }> = [];
  const gateDeps = { ...storeGateDeps(store, deps.divertedRoot), log: (event: string) => { if (event === 'msg.backpressure' && inWin()) backpressureLogs += 1; } };
  const feed = arm === 'Bpp' ? createSelfWakeCoachFeed({ seat: 'OP', root: deps.divertedRoot, now: () => Date.now(), log: () => {},
    schedule: () => { wakeQ.push(curS); return true; },
    enqueuePassive: (line) => { passiveQ.push({ key: `line-${curS}-${line.slice(0, 16)}`, atS: curS, needsOP: false, cat: 'info', from: 'feed', msgId: null }); } }) : null;

  const writeRow = (env: MessageEnvelope): number => {
    if (inWin()) generated[env.from] = (generated[env.from] ?? 0) + 1;
    try { return store.post(env, { dedupe: true }).id; } catch { return store.post({ ...env, body: `${env.body} ·${curS}` }).id; }
  };
  /** One mail reaching OP's side: the arm's sender path, then the receiver route. */
  const deliver = (m: { key: string; from: string; body: string; cat: Cat | 'reply'; needsOP: boolean; legacy: FloodMail['legacy']; structured: FloodMail['structured']; replyTo?: number }): void => {
    at(curS);
    // B'' worst case for E: a sender that posts kind-less today keeps doing so (seat scripts are not rewritten) — the CLI
    // stores it as passive info (rule kindless) instead of refusing it.
    const staysKindless = arm === 'Bpp' && m.legacy.kind === undefined && !m.legacy.crownDirective;
    let env: MessageEnvelope = { from: m.from, to: 'OP', body: m.body, ...(arm === 'Bpp' && !staysKindless ? m.structured : m.legacy), ...(m.replyTo ? { replyTo: m.replyTo } : {}) };
    delete (env as { needsReply?: boolean }).needsReply;
    const sentKindless = env.kind === undefined;
    if (inWin()) { postsToOp += 1; if (sentKindless) postsSentKindless += 1; }
    if (arm === 'Bpp') {
      const gate = gatePost({ envelope: env, entrance: 'cli', ...(staysKindless ? {} : { needsReply: m.structured.needsReply }) }, gateDeps);
      if (gate.action === 'refuse') throw new Error(`sim sender refused: ${m.key} ${gate.error}`);
      if (gate.action === 'divert') {
        if (inWin()) {
          generated[`${m.from}(diverted)`] = (generated[`${m.from}(diverted)`] ?? 0) + 1;
          if (gate.ledger === 'self-wake') diverted.selfWake += 1; else if (gate.ledger === 'coach-note') diverted.coachNote += 1; else diverted.folded += 1;
        }
        return;
      }
      env = gate.envelope;
    }
    const id = writeRow(env);
    if (inWin()) {
      rowsToOp += 1;
      if (!env.kind) rowsToOpKindless += 1;
      if (sentKindless) rowsSentKindless += 1;
      if (m.from === 'OP') rowsToOpSelf += 1;
      if (m.from === 'CLAUDE-OP') rowsToOpCoach += 1;
      if ((m.from === 'OP' || m.from === 'CLAUDE-OP') && env.crownDirective) rowsToOpSelfCoachCrown += 1;
    }
    const stored = store.getMessage(id)!;
    const route: 'turn' | 'passive' = arm === 'A'
      ? (isInfoSeatMail({ id, sender: stored.from, body: stored.body, kind: stored.kind ?? null, intent: stored.intent ?? null }) ? 'passive' : 'turn')
      : deps.route({ kind: stored.kind ?? null, intent: stored.intent ?? null, crownDirective: stored.crownDirective ?? null, refs: stored.refs ?? null, replyTo: stored.replyTo ?? null,
        needsAck: stored.needsAck ?? null, priority: stored.priority ?? null, resultState: (stored.result as { state?: 'done' | 'failed' } | undefined)?.state ?? null,
        fromKind: stored.origin?.kind ?? null, senderAbove: false, body: stored.body });
    if (sentKindless && route === 'turn' && inWin()) kindlessOpened += 1;
    const p: Pending = { key: m.key, atS: curS, needsOP: m.needsOP, cat: m.cat, from: m.from, msgId: id };
    (route === 'turn' ? turnQ : passiveQ).push(p);
  };
  /** OP asks a seat for the next step; the seat replies (habit) with replyTo. */
  const opAsk = (to: string, key: string, onMsg: number | null): void => {
    at(curS);
    // OP answers on the thread it read (replyTo = the mail that prompted the ask) — the chain the metric measures.
    const thread = onMsg === null ? {} : { replyTo: onMsg };
    const env: MessageEnvelope = arm === 'Bpp' ? { from: 'OP', to, body: `[OP] 다음 단계 확인 ${key}`, kind: 'question', needsAck: true, ...thread } : { from: 'OP', to, body: `[OP] 다음 단계 확인 ${key}`, kind: 'request', intent: 'request', ...thread };
    const id = writeRow(env);
    askIds.set(key, id);
    if (r() < 0.85) {
      const rs = curS + between(r, 240, 1500);
      future.push({ s: rs, fn: () => deliver({ key: `reply-${key}`, from: to, body: `[${to}] 회신: 확인했습니다 · 다음 단계 진행 ${key}`, cat: 'reply', needsOP: false, replyTo: id,
        legacy: { intent: 'info' }, structured: { kind: 'status', needsReply: false } }) });
    }
  };
  for (const a of world.preAsks) {
    at(a.atS);
    curS = a.atS;
    const id = writeRow(arm === 'Bpp' ? { from: 'OP', to: a.to, body: `[OP] 확인 요청 ${a.key}`, kind: 'question', needsAck: true } : { from: 'OP', to: a.to, body: `[OP] 확인 요청 ${a.key}`, kind: 'request', intent: 'request' });
    askIds.set(a.key, id);
    future.push({ s: a.replyAtS, fn: () => deliver({ key: `reply-${a.key}`, from: a.to, body: `[${a.to}] 회신: 요청하신 것 진행했습니다 ${a.key}`, cat: 'reply', needsOP: false, replyTo: id,
      legacy: { intent: 'info' }, structured: { kind: 'status', needsReply: false } }) });
  }
  // OP's own turn: take everything waiting; reply habits fire only on mail that opened/joined as an individual turn item.
  let busyUntil = 0;
  const harness = [...world.harnessTurnsS];
  const passiveWindowS = arm === 'A' ? 60 : 600;
  const openTurn = (opener: FloodTurn['opener']): void => {
    at(curS);
    feed?.noteTurnStarted();
    const items = turnQ.splice(0, turnQ.length);
    const passive = passiveQ.splice(0, passiveQ.length);
    wakeQ.splice(0, wakeQ.length);
    for (const it of [...items, ...passive]) if (!reached.has(it.key)) reached.set(it.key, curS);
    const ids = [...items, ...passive].flatMap((it) => (it.msgId === null ? [] : [it.msgId]));
    if (ids.length) store.ackMessages('OP', ids);
    for (const it of items) if ((it.cat === 'reply' || it.cat === 'info' || it.cat === 'dup') && it.from !== 'OP' && opR() < 0.35) opAsk(it.from, `ask-${it.key}-${curS}`, it.msgId);
    turns.push({ startS: curS, opener, mailItems: items.map((it) => ({ key: it.key, needsOP: it.needsOP })) });
    busyUntil = curS + 30 + 20 * items.filter((it) => it.needsOP).length + 6 * (items.length + passive.length);
  };
  const mailQ = [...world.mails];
  for (let s = 0; s <= endS + DRAIN_S; s += 5) {
    curS = s;
    at(s);
    while (mailQ.length && mailQ[0]!.atS <= s) { const m = mailQ.shift()!; deliver(m); }
    for (let i = future.length - 1; i >= 0; i--) if (future[i]!.s <= s) { const f = future.splice(i, 1)[0]!; if (f.s < endS) f.fn(); }
    if (feed && s % 30 === 0) feed.tick();
    if (s < busyUntil) continue;
    if (turnQ.length) openTurn('mail');
    else if (wakeQ.length) openTurn('wake');
    else if (harness.length && harness[0]! <= s) { harness.shift(); openTurn('harness'); }
    else if (passiveQ.length && s - passiveQ[0]!.atS >= passiveWindowS) openTurn('digest');
  }
  // misses: OP-level urgent mail must reach an OP turn — ✋/crown 10 min · questions 15 min
  const missed: FloodResult['missed'] = [];
  for (const m of world.mails.filter((x) => x.atS >= winS && x.atS < endS && x.needsOP && ['hand', 'crown', 'coach-crown', 'question', 'alert', 'req-op'].includes(x.cat))) {
    const got = reached.get(m.key);
    const limit = m.cat === 'question' || m.cat === 'req-op' ? 900 : 600;
    if (got === undefined) missed.push({ key: m.key, why: 'never reached an OP turn' });
    else if (got - m.atS > limit) missed.push({ key: m.key, why: `late ${Math.round((got - m.atS) / 60)}m` });
  }
  // reply-chain depth over the ledger (rows linked by replyTo)
  const rows = store.db.query('SELECT id, reply_to FROM msg_messages').all() as Array<{ id: number; reply_to: number | null }>;
  const parent = new Map(rows.map((x) => [x.id, x.reply_to] as const));
  let maxDepth = 0;
  for (const x of rows) { let d = 1; let p = x.reply_to; while (p !== null && p !== undefined && d < 50) { d += 1; p = parent.get(p) ?? null; } if (d > maxDepth) maxDepth = d; }
  store.close();
  return { arm, windowStartS: winS, turns, rowsToOp, rowsToOpKindless, rowsSentKindless, kindlessOpened, postsToOp, postsSentKindless, rowsToOpSelf, rowsToOpCoach, rowsToOpSelfCoachCrown, generatedPerSeat: generated, diverted, maxReplyChainDepth: maxDepth, missed, backpressureLogs };
}

export interface FloodMetrics {
  arm: FloodArm; opInboundPerH: number;
  /** Kind-less posts that opened an OP turn on their own (the E target · stored-as-passive counts as 0) · raw = posts sent without a kind. */
  kindlessPct: number; kindlessRawPct: number; kindlessStoredPct: number;
  /** Self ⊕ coach rows (crown-flagged relays excluded — they are crown traffic) · raw = including them. */
  selfCoachPct: number; selfCoachRawPct: number; maxReplyChainDepth: number; turnsPerH: number;
  mailOpenedTurnPct: number; escalations: number; escalationPrecisionPct: number; missed: number;
  diverted: FloodResult['diverted']; backpressureLogs: number; generatedPerSeatPerH: Record<string, number>;
}

/** The hour's numbers (turns that started inside the 60-min window). */
export function floodMetrics(res: FloodResult): FloodMetrics {
  const inHour = res.turns.filter((t) => t.startS >= res.windowStartS && t.startS < res.windowStartS + FLOOD_HOUR_S);
  const mailOpened = inHour.filter((t) => t.opener === 'mail' || t.opener === 'digest').length;
  const esc = inHour.flatMap((t) => t.mailItems);
  const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((100 * a) / b));
  return {
    arm: res.arm, opInboundPerH: res.rowsToOp, kindlessPct: pct(res.kindlessOpened, res.rowsToOp), kindlessRawPct: pct(res.postsSentKindless, res.postsToOp), kindlessStoredPct: pct(res.rowsToOpKindless, res.rowsToOp), selfCoachPct: pct(res.rowsToOpSelf + res.rowsToOpCoach - res.rowsToOpSelfCoachCrown, res.rowsToOp), selfCoachRawPct: pct(res.rowsToOpSelf + res.rowsToOpCoach, res.rowsToOp),
    maxReplyChainDepth: res.maxReplyChainDepth, turnsPerH: inHour.length, mailOpenedTurnPct: pct(mailOpened, inHour.length),
    escalations: esc.length, escalationPrecisionPct: esc.length ? pct(esc.filter((e) => e.needsOP).length, esc.length) : 100, missed: res.missed.length,
    diverted: res.diverted, backpressureLogs: res.backpressureLogs,
    generatedPerSeatPerH: Object.fromEntries(Object.entries(res.generatedPerSeat).sort((a, b) => b[1] - a[1])),
  };
}

/** Pass criteria (CEO 11-25): inbound ≤ 20/h · kind-less 0% · self+coach ≤ 5% · chain ≤ 2 · mail-opened ≤ 25% · precision ≥ 90% · 0 missed. */
export function floodPasses(m: FloodMetrics): Record<string, boolean> {
  return { inbound: m.opInboundPerH <= 20, kindless: m.kindlessPct === 0, selfCoach: m.selfCoachPct <= 5, chain: m.maxReplyChainDepth <= 2,
    mailOpened: m.mailOpenedTurnPct <= 25, precision: m.escalationPrecisionPct >= 90, missed: m.missed === 0 };
}
