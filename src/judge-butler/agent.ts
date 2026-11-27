// 판정 집사 — one wake: body tick (L1) → voice turns for the messages waiting in its inbox adapter. Shared by live and sim.
import { judgeCell, type CellIn, type Verdict } from './done-when.js';
import { namedByHold, planTick, runTick, type ButlerPorts, type ButlerView, type HandIn, type TickReport, ANSWER_DEADLINE_MS } from './body.js';
import { BUTLER_SEAT, BUTLER_SUPERVISOR, type ButlerLevel } from './memory.js';
import { mayDemote, voiceBudgetOk, voiceTurn, type VoiceCommands, type VoiceInbox, type VoiceLlm, type VoiceMessage, type VoiceResult, type VoiceState } from './voice.js';
import { DEFAULT_GOAL, type GoalCard } from './cards.js';
import { dirname } from 'node:path';
import { fileAgentMemory, knowhowFor } from '../loop-agent/memory.js';
import { median } from '../kit/kpi/index.js';
import { refreshHome } from '../loop-agent/live.js';
import { smartButlerPorts, type ButlerSmartInput, type ButlerSmartReport } from './smart.js';

/** LOOP-AGENT v2 shell (대표 11-27 09:2x): the butler's knowhow pack lives in the same home as its cases/lessons
 *  (<stateRoot>/loop-agents/judge-butler/knowhow/ · seeded from graphs/loop-agents/judge-butler/knowhow.md). Fail-open → ''. */
export function butlerKnowhow(mem: { root: string }, now: Date): (query: string) => string {
  return (query: string) => {
    try {
      const shell = fileAgentMemory(dirname(dirname(mem.root)), 'judge-butler', BUTLER_SUPERVISOR);
      refreshHome(shell, 'judge-butler', null);
      return knowhowFor(shell, query, now);
    } catch { return ''; }
  };
}

export interface WakeInput {
  readonly view: ButlerView;
  readonly ports: ButlerPorts;
  readonly inbox?: VoiceInbox | null;
  readonly llm?: VoiceLlm | null;
  readonly cards?: { goal: GoalCard; goalText: string; soulText: string };
  /** v3 (agent.yaml reflect · plan · learn-knowhow) — absent = the v2 wake exactly. Live only. */
  readonly smart?: ButlerSmartInput | null;
}
export interface WakeResult { readonly tick: TickReport; readonly voice: VoiceResult[]; readonly smart?: ButlerSmartReport }

/** Judge queue as the snapshot reads it: yellow cells citing a merged PR (wait = since last update) · `ready` = the ones the
 *  judge can close now (done-when met, not security-4) — the KPI «median wait ≤ 15 min» is measured on these. */
export interface JudgeQueue { count: number; medianWaitMin: number | null; ready: number; readyMedianWaitMin: number | null }
export function judgeQueue(view: ButlerView, verdicts: ReadonlyMap<string, Verdict>, vetoed: Readonly<Record<string, string>> = {}): JudgeQueue {
  const wait = (c: CellIn) => Math.max(0, (view.now.getTime() - Date.parse(c.updatedAt ?? view.now.toISOString())) / 60_000);
  const merged = (v: Verdict) => !(v.kind === 'missing' && (v.why === 'no PR in evidence' || v.why.startsWith('no merged PR')));
  const waiting = view.cells.filter(c => c.status === 'yellow' && verdicts.has(c.id) && merged(verdicts.get(c.id)!));
  const ready = waiting.filter(c => verdicts.get(c.id)!.kind === 'sign' && !vetoed[c.id]); // a vetoed cell is JUD's, not the butler's queue
  return { count: waiting.length, medianWaitMin: median(waiting.map(wait)), ready: ready.length, readyMedianWaitMin: median(ready.map(wait)) };
}

export function makeCommands(view: ButlerView, ports: ButlerPorts, verdicts: ReadonlyMap<string, Verdict>, opts: { forwardOnly?: boolean } = {}): VoiceCommands {
  const mem = ports.memory; const now = view.now;
  const cellOf = (id: string): CellIn | undefined => view.cells.find(c => c.id.toUpperCase() === id.trim().toUpperCase());
  return {
    sign(id) {
      const c = cellOf(id);
      if (!c) return { ok: false, line: `${id}: 없는 칸` };
      if (view.actable === false) return { ok: false, line: `${c.id} 서명 거절 — ${view.version} 은 지금 판이 아니다(${view.targetWhy ?? 'off-target'})` };
      const fresh = ports.readCell(c.id) ?? c;
      if (fresh.status === 'green') return { ok: true, line: `${c.id} 이미 초록(${fresh.updatedBy ?? '?'})`, ref: `cell:${c.id}` };
      const state = mem.readState();
      if (state.reversed[c.id]) return { ok: false, line: `${c.id} 서명 거절 — 서명 뒤 되돌려진 칸(거부권) · 증거(head·영수)가 바뀌기 전까지 다시 서명하지 않는다` };
      if (namedByHold(view.holds, c.id, view.now)) return { ok: false, line: `${c.id} 서명 거절 — 등록된 HOLD 가 덮고 있다` };
      // SAFETY (Terra r1): judge the freshly read cell on freshly read receipt ⊕ PR facts (incl. security-4), never the wake's verdict
      const v = judgeCell(fresh, ports.freshFacts(fresh));
      if (v.kind !== 'sign') return { ok: false, line: `${c.id} 서명 거절 — ${v.why}` };
      const line = `🟢 판정 집사 서명 ${now.toISOString().slice(0, 16)}Z — ${v.why} · decidedBy judge-butler · supervisedBy ${BUTLER_SUPERVISOR}`;
      try {
        ports.sign(c.id, fresh.evidence ? `${fresh.evidence}\n${line}` : line, { title: fresh.title ?? '', status: fresh.status, evidence: fresh.evidence ?? '' },
          { decidedBy: BUTLER_SEAT, ...(fresh.owner ? { doneBy: fresh.owner.split('/')[0]! } : {}), supervisedBy: BUTLER_SUPERVISOR });
      } catch (e) { return { ok: false, line: `${c.id} 서명 실패 — ${e instanceof Error ? e.message : String(e)}` }; }
      const after = ports.readCell(c.id);
      if (after?.status !== 'green') return { ok: false, line: `${c.id} 서명 검증 실패(${after?.status ?? 'missing'})` };
      state.signed[c.id] = now.toISOString(); mem.writeState(state);
      mem.appendCase({ at: now.toISOString(), kind: 'sign', subject: c.id, why: `voice · ${v.why}`, refs: [`cell:${c.id}`, ...v.evidence], decidedBy: BUTLER_SEAT, supervisedBy: BUTLER_SUPERVISOR });
      return { ok: true, line: `${c.id} 초록 서명 (${v.why})`, ref: `cell:${c.id}` };
    },
    explain(id) {
      const c = cellOf(id);
      if (!c) return `${id}: 없는 칸`;
      const v = verdicts.get(c.id) ?? (c.status === 'yellow' ? judgeCell(c, view.prFacts) : undefined);
      return `${c.id} [${c.status}] ${v ? `${v.kind}: ${v.why}` : `green by ${c.updatedBy ?? '?'}`}`;
    },
    proposeNarrow(holdId, from) {
      const h = view.holds.find(x => x.id === holdId.trim().toUpperCase() && x.state === 'active');
      if (!h) return { ok: false, line: `${holdId}: 활성 HOLD 아님` };
      const id = ports.post(`propose:${h.id}:${h.narrowed}:voice`, h.owner,
        `[판정 집사 · HOLD 좁히기 제안 · ${from} 요청] ${h.id} (${h.cells.join(',')} · ~${h.expiresAt.slice(11, 16)}Z) — 묶을 칸만 남기고 만료를 줄여 달라: eln hold narrow ${h.id} --cells <칸> --expires 30m · 필요 없으면 eln hold lift ${h.id} --reason '…'`, 'request');
      return { ok: true, line: `${h.id} 좁히기 제안 → ${h.owner}${id ? ` #${id}` : ' (이미 보냄)'}`, ...(id ? { ref: `msg:${id}` } : {}) };
    },
    expireDue() {
      const green = new Set(view.cells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id.toUpperCase()));
      const rows = ports.expireHolds(BUTLER_SEAT, { merged: ports.merged, green });
      return { line: rows.length ? `HOLD 만료 ${rows.map(r => r.id).join(',')}` : '만료할 HOLD 없음', refs: rows.map(r => `hold:${r.id}`) };
    },
    escalate(to, why, msg) {
      if (opts.forwardOnly) return { line: `→ ${to} (✋ 전달)` };
      const id = ports.post(`voice-esc:${msg.channel}:${msg.id}:${to}`, to, `[판정 집사 → ${to}] ${msg.from} #${msg.id}: ${why}`, 'request');
      return { line: `→ ${to}${id ? ` #${id}` : ''}`, ...(id ? { ref: `msg:${id}` } : {}) };
    },
    demote(to: ButlerLevel, by, why) {
      if (!mayDemote(by)) return { ok: false, line: `수준 변경 거절 — ${by} 는 JUD·OP·CLAUDE-OP·CEO 가 아니다` };
      mem.setLevel(to, by, why, now);
      return { ok: true, line: `수준 → ${to} (${by})` };
    },
  };
}

/** One wake of the agent. */
export async function wakeButler(input: WakeInput): Promise<WakeResult> {
  const { view, ports } = input;
  const cards = input.cards ?? { goal: DEFAULT_GOAL, goalText: '', soulText: '판정 집사' };
  const mem = ports.memory;
  const perHour = cards.goal.voice.per_hour_max;
  const verdictsNow = (): Map<string, Verdict> => planTick(view, mem.readState()).verdicts;
  const stateFor = (verdicts: ReadonlyMap<string, Verdict>, frozenHands: number): VoiceState =>
    ({ now: view.now, level: mem.level().level, cells: view.cells, verdicts, holds: view.holds, frozenHands, judgeQueue: judgeQueue(view, verdicts, mem.readState().reversed) });
  const spend = (): boolean => {
    const s = mem.readState(); const nowMs = view.now.getTime();
    s.voiceTurns = s.voiceTurns.filter(t => nowMs - t < 3_600_000);
    const ok = voiceBudgetOk(s.voiceTurns, nowMs, perHour);
    if (ok) { s.voiceTurns.push(nowMs); mem.writeState(s); }
    return ok;
  };
  const llm = input.llm ?? null;
  const voiceHand = async (hand: HandIn, facts: string) => {
    const verdicts = verdictsNow();
    const msg: VoiceMessage = { id: hand.id, from: hand.blockedSeat, body: `${hand.body}\n[사실] ${facts}`, at: new Date(hand.createdAtMs).toISOString(), channel: 'hand' };
    const res = await voiceTurn(msg, stateFor(verdicts, 0), { memory: mem, llm, cmds: makeCommands(view, ports, verdicts, { forwardOnly: true }), soulText: cards.soulText, goalText: cards.goalText, perHourMax: perHour, knowhow: butlerKnowhow(mem, view.now) }, llm ? spend() : false);
    if (res.folded || res.escalated) return { action: 'escalate' as const, text: res.reply };
    return { action: 'resolve' as const, text: res.reply, owner: hand.blockedSeat, deadline: new Date(view.now.getTime() + ANSWER_DEADLINE_MS).toISOString() };
  };
  const smart = input.smart && mem.level().level === 'live' ? await smartButlerPorts(view, ports, input.smart, planTick(view, mem.readState()).frozen.size).catch(() => null) : null;
  const tick = await runTick(view, { ...(smart?.ports ?? ports), voiceHand });
  smart?.session.save();
  const voice: VoiceResult[] = [];
  if (tick.level !== 'off' && tick.level !== 'shadow' && input.inbox) {
    for (const msg of input.inbox.pending(view.now.getTime()).slice(0, 10)) {
      const res = await voiceOnce(input, msg, tick.frozenHands);
      input.inbox.reply(msg, res.reply, res.refs);
      voice.push(res);
    }
  }
  return { tick, voice, ...(smart ? { smart: smart.report } : {}) };
}

/** One voice turn on the shared core (mail inbox · els channel adapter): same context, same budget, same L1 commands. */
export async function voiceOnce(input: Omit<WakeInput, 'inbox'>, msg: VoiceMessage, frozenHands = 0): Promise<VoiceResult> {
  const { view, ports } = input;
  const cards = input.cards ?? { goal: DEFAULT_GOAL, goalText: '', soulText: '판정 집사' };
  const mem = ports.memory; const perHour = cards.goal.voice.per_hour_max; const llm = input.llm ?? null;
  const lvl = mem.level(); const level = lvl.level;
  if (level === 'off' || level === 'shadow') // killed / shadow: answer, act on nothing, write nothing
    return { msg, folded: true, reply: `[판정 집사 · ${level} (by ${lvl.by} ${lvl.at})] 지금은 판단도 행동도 하지 않는다 — 판정은 JUD 에 직접.`, refs: [`${msg.channel}:${msg.id}`], model: null, escalated: false, actions: [] };
  const verdicts = planTick(view, mem.readState()).verdicts;
  const state: VoiceState = { now: view.now, level, cells: view.cells, verdicts, holds: view.holds, frozenHands, judgeQueue: judgeQueue(view, verdicts, mem.readState().reversed) };
  let budgetOk = false;
  if (llm && level === 'live') {
    const s = mem.readState(); const nowMs = view.now.getTime();
    s.voiceTurns = s.voiceTurns.filter(t => nowMs - t < 3_600_000);
    budgetOk = voiceBudgetOk(s.voiceTurns, nowMs, perHour);
    if (budgetOk) { s.voiceTurns.push(nowMs); mem.writeState(s); }
  }
  return voiceTurn(msg, state, { memory: mem, llm, cmds: makeCommands(view, ports, verdicts), soulText: cards.soulText, goalText: cards.goalText, perHourMax: perHour, knowhow: butlerKnowhow(mem, view.now) }, budgetOk);
}
