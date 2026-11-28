// LOOP-AGENT v2 generic shell — the runtime: body tick (L1) ⊕ voice turn ⊕ L0 escalation ⊕ heartbeat ⊕ audit ⊕ self-learning.
//
// 세 얼굴:
//   관측 = every tick observes its subject through the body (`observe` → KPI value ⊕ subjects ⊕ facts ⊕ outcome patterns),
//          writes a `tick` case and last-tick.json, and beats `loop:<id>` into the watchers ledger (watchers-check sees it).
//   판단 근거 = the card: KPI target (with the policy overlay) · rights.actions (closed set) · cooldown · max_per_tick ·
//          recall (knowhow ⊕ lessons ⊕ recent cases) handed to the body's `plan` and to every voice turn.
//   수복과 인계 = the body runs at most max_per_tick reversible actions inside its rights (each one a case with its undo line);
//          a KPI breach is spoken once in the agent's channel (port `speak`) and, if it lasts escalate_after_min, carded once
//          to the L0; a repeated outcome pattern (3×) becomes a candidate lesson the L0 can approve/reject (silence = promote).
// The voice is an LLM turn only when spoken to: soul ⊕ card ⊕ policy ⊕ KPI/state ⊕ recall ⊕ thread → {reply, actions[]};
// actions are the body's own rights (`act`) or the shell's closed commands — never shell, never a widened right.
import { effectiveCard, kpiLine, kpiOk, policySeats, applyPolicyChange, type AgentCard } from './card.js';
import { breachStep } from '../kit/kpi/index.js';
import { pv, withPolicies } from './policy-context.js';
import { appendJournal, backfillTodayFromCases, emitWindowRollups, journalBrief, readJournal, type JournalRow } from './journal.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRetro, beginSmart, failureCause, fileSmartStore, humanMemory, readRetros, retro, retroDue, retroLine, shellIntent, shellPlan, type ActionRow, type RetroEntry, type ShellPlan, type SmartConfig } from './v3/smart.js';
import type { AgentSoul } from './v3/agent-yaml.js';
import { AGENT_LEVELS, addCandidate, addLesson, decideLesson, maintainLessons, notePattern, recall, type AgentLevel, type AgentMemory, type AgentState, type Recall } from './memory.js';

export interface Subject { readonly id: string; readonly kind: string; readonly summary: string; readonly ageMin?: number }
export interface Observation {
  /** The KPI value now (null = unknown — never read as 0). */
  readonly kpi: number | null;
  readonly subjects: readonly Subject[];
  readonly facts: readonly string[];
  /** Outcome patterns seen this tick (e.g. `tsc-timeout@node-b`) — 3× in a week → candidate lesson. */
  readonly patterns?: readonly { readonly key: string; readonly lesson: string }[];
}
export interface PlannedAction { readonly action: string; readonly target: string; readonly why: string }
export interface ActionResult { readonly ok: boolean; readonly line: string; readonly ref?: string; readonly undo?: string; readonly before?: string; readonly after?: string }
export interface BodyCtx { readonly now: Date; readonly card: AgentCard; readonly state: AgentState; readonly recall: Recall | null; readonly level: AgentLevel }
export interface ActionDef {
  readonly describe: string;
  run(target: string, ctx: BodyCtx & { readonly obs: Observation; readonly by: string }): Promise<ActionResult> | ActionResult;
}
/** The L1 body: deterministic, LLM 0. */
export interface AgentBody {
  observe(ctx: BodyCtx): Promise<Observation> | Observation;
  plan(obs: Observation, ctx: BodyCtx): readonly PlannedAction[];
  readonly actions: Readonly<Record<string, ActionDef>>;
}

export interface VoiceLlm { complete(system: string, user: string): Promise<{ text: string; model: string }> }
export interface AgentPorts {
  readonly memory: AgentMemory;
  /** Durable mail, deduped by key (null = already sent). */
  post(key: string, to: string, body: string, kind?: string): number | string | null;
  beat(b: { name: string; saw: number; everyMin: number; err?: string; last?: string }): void;
  /** One line into the agent's own channel (proactive voice) — not mail to OP. */
  speak?(line: string): void;
  readonly llm?: VoiceLlm | null;
  /** SUPERVISOR-CORRECTION-JOURNAL rollup sink (live: OP 30-min digest ⊕ ws:supervisors) · omitted = no rollup lines. */
  readonly rollup?: import('./journal.js').RollupSink;
  /** SUPERVISORS-EXECUTE-NOT-PROPOSE: the active HOLD over an act's target («<id> (<owner>)») · null = none · absent = no ledger. */
  holdOn?(target: string, now: Date): string | null;
}

export interface TickReport {
  readonly id: string; readonly at: string; readonly level: AgentLevel;
  readonly kpi: number | null; readonly kpiOk: boolean | null; readonly kpiLine: string;
  readonly subjects: number; readonly planned: number;
  readonly acted: string[]; readonly refused: string[]; readonly failed: string[];
  /** DETECT-TO-ACTION: planned but waiting (cooldown · parked streak) with the reason — not refused, not acted. */
  readonly deferred?: string[];
  readonly breach: 'new' | 'ongoing' | 'recovered' | null; readonly escalated: boolean;
  readonly candidates: string[]; readonly promoted: string[]; readonly error?: string;
  /** The subject could not be read SUBJECT_LOST_TICKS ticks in a row → a reattach proposal went to the L0 (once per episode). */
  readonly subjectLost?: boolean;
  /** LOOP-AGENT-V3-SMART-2 (agent.yaml hook nodes): the plan with its reasons · lessons/knowhow learned this tick · the retro written. */
  readonly plan?: ShellPlan;
  readonly learned?: { readonly created: string[]; readonly promoted: string[] };
  readonly retro?: string;
}

export const beatName = (id: string): string => `loop:${id}`;
/** SUPERVISOR-REVIVE «환자를 잃은 의사»: this many unreadable ticks in a row = the subject is gone → propose a reattach (never idle). */
export const SUBJECT_LOST_TICKS = 3;
/** SUPERVISOR-JOURNAL-DEFECTS (11-27 journal: end-zombie-pregate failed 21× and open-cell 29× on the same targets, a row every
 *  tick): this many failures in a row on one `${action}:${target}` parks it — no retry, one card to the L0 — and the parked
 *  target is tried once more after PARK_RETRY_H (a world that changed gets its chance; a failure re-parks without a new card). */
export const PARK_AFTER_FAILS = 3; // 출처: SUPERVISOR-REVIVE-1127 «같은 원인 3회» = 교훈 후보 문턱(notePattern)과 같은 수
export const PARK_RETRY_H = 24; // 출처: SUPERVISOR-REVIVE-1127 일일 점검 주기(lesson decay·cells_per_day 와 같은 하루 창)
const PARK_KEEP_DAYS = 7; // 출처: notePattern 주간 창(일주일 3회) — 그보다 오래된 연속 실패 기록은 지운다

/** Count an unreadable tick; on the SUBJECT_LOST_TICKS-th one card the L0 once with a reattach proposal. Mutates `state`. */
function noteSubject(card: AgentCard, ports: AgentPorts, state: AgentState, readable: boolean, at: string, why: string): boolean {
  if (readable) { state.unknownTicks = 0; state.lostSince = null; state.lostAlerted = false; return false; }
  state.unknownTicks = (state.unknownTicks ?? 0) + 1;
  if (state.unknownTicks === 1) { state.lostSince = at; state.lostAlerted = false; }
  const lostTicks = pv('subject_lost_ticks', SUBJECT_LOST_TICKS);
  // ≥ (not ===): a threshold lowered below the running count mid-outage still alerts — once per outage (Terra #40447 r3)
  if (state.unknownTicks < lostTicks || state.lostAlerted) return false;
  state.lostAlerted = true;
  const since = state.lostSince ?? at;
  const id = ports.post(`subject-lost:${card.id}:${since}`, card.supervisor,
    `[${card.name} → L0 ${card.supervisor}] 대상 잃음 — «${card.subject || card.id}» 를 ${lostTicks}틱 연속 못 읽었다(${why.slice(0, 160)}). 쉬지 않고 다시 붙을 곳을 제안한다: 새 원천(원장·CLI 경로)을 알려 주거나 정책 focus 로 대상을 바꿔 달라 — @loop:${card.id} «대상을 <새 대상> 으로» · 그동안 KPI 는 «모름»으로 둔다(0 아님).`, 'request');
  ports.memory.appendCase({ at, kind: 'subject-lost', subject: card.subject || card.id, why: `${lostTicks} ticks unreadable since ${since} · reattach proposed to ${card.supervisor}${id !== null ? ` #${id}` : ''} · ${why.slice(0, 160)}`,
    ...(id !== null ? { refs: [`msg:${id}`] } : {}), decidedBy: card.address, supervisedBy: card.supervisor });
  ports.speak?.(`❓ [${card.name}] 대상 잃음 — «${card.subject || card.id}» 를 못 읽는다 · L0 ${card.supervisor} 에 다시 붙일 곳을 물었다`);
  return true;
}

function nowCard(card: AgentCard, mem: AgentMemory): AgentCard { return effectiveCard(card, mem.policy()); }
/** The level in force: level.json when an L0/HQ set one, else the card's start_level. */
export function levelOf(card: AgentCard, mem: AgentMemory): { level: AgentLevel; by: string; at: string; reason: string } {
  const l = mem.level();
  return l.by === 'default' ? { level: card.startLevel, by: 'card', at: '-', reason: `start_level ${card.startLevel}` } : l;
}

/** True while `${action}:${target}` is parked by its failure streak (before the PARK_RETRY_H re-check). */
export function isParked(state: AgentState, key: string, now: Date): boolean {
  const at = state.failStreak?.[key]?.parkedAt;
  return !!at && now.getTime() - Date.parse(at) < PARK_RETRY_H * 3_600_000;
}

/** Run one action through the rights gate (closed set ⊕ policy-narrowed ⊕ cooldown) and record it. */
export async function runAction(card: AgentCard, body: AgentBody, ports: AgentPorts, ctx: BodyCtx, obs: Observation, pa: PlannedAction, by: string, opts: { ignoreCooldown?: boolean } = {}): Promise<{ status: 'acted' | 'refused' | 'failed' | 'cooldown' | 'parked' | 'held'; line: string; ref?: string; journal?: JournalRow }> {
  const mem = ports.memory; const at = ctx.now.toISOString();
  const def = body.actions[pa.action];
  if (!def || !card.rights.actions.includes(pa.action)) {
    const line = `${pa.action}: 권한 밖 행동 — 허용: ${card.rights.actions.join(', ') || '없음'}`;
    mem.appendCase({ at, kind: 'act-refused', subject: `${pa.action}:${pa.target}`, why: `${line} · ${pa.why}`, decidedBy: by, supervisedBy: card.supervisor });
    return { status: 'refused', line, journal: journalRow(card, at, 'refused', pa, line, by, obs, null) };
  }
  const key = `${pa.action}:${pa.target}`;
  // SUPERVISORS-EXECUTE-NOT-PROPOSE: an act the agent runs itself (agent.yaml authority.executes) waits under an active HOLD
  // over its target — journaled «held», retried next tick (no cooldown taken). An unreadable ledger holds too (fail-closed).
  if (card.authority?.respectHold && card.authority.executes.includes(pa.action)) {
    let hold: string | null;
    try { hold = ports.holdOn?.(pa.target, ctx.now) ?? null; } catch (e) { hold = `hold ledger unreadable (${e instanceof Error ? e.message : String(e)})`.slice(0, 120); }
    if (hold) {
      const line = `${key}: HOLD ${hold} — 실행 안 함(풀리면 다음 틱)`;
      mem.appendCase({ at, kind: 'act-held', subject: key, why: `${line} · ${pa.why}`, decidedBy: by, supervisedBy: card.supervisor });
      return { status: 'held', line, journal: journalRow(card, at, 'refused', pa, line, by, obs, null) };
    }
  }
  const last = ctx.state.acted[key];
  if (!opts.ignoreCooldown && last && ctx.now.getTime() - Date.parse(last) < card.rights.cooldownMin * 60_000)
    return { status: 'cooldown', line: `${key}: ${card.rights.cooldownMin}분 쿨다운 안 (마지막 ${last.slice(11, 16)}Z)` };
  const streaks = (ctx.state.failStreak ??= {});
  if (!opts.ignoreCooldown && isParked(ctx.state, key, ctx.now))
    return { status: 'parked', line: `${key}: ${streaks[key]!.n}번 연속 실패로 멈춤(${streaks[key]!.parkedAt!.slice(5, 16)}Z · ${PARK_RETRY_H}h 뒤 한 번 다시)` };
  let r: ActionResult;
  try { r = await def.run(pa.target, { ...ctx, obs, by }); }
  catch (e) { r = { ok: false, line: `${key} 실패 — ${e instanceof Error ? e.message : String(e)}` }; }
  ctx.state.acted[key] = at;
  if (r.ok) delete streaks[key];
  else {
    const cur = streaks[key]; const n = (cur?.n ?? 0) + 1; const since = cur?.since ?? at;
    streaks[key] = { n, since, last: r.line.slice(0, 200), ...(n >= PARK_AFTER_FAILS ? { parkedAt: at } : {}) };
    if (n >= PARK_AFTER_FAILS && !cur?.parkedAt) {
      const id = ports.post(`act-parked:${card.id}:${key}:${since}`, card.supervisor,
        `[${card.name} → L0 ${card.supervisor}] ${key} 가 ${n}번 연속 실패 — 같은 대상 재시도를 멈춘다(${PARK_RETRY_H}h 뒤 한 번 다시) · 마지막: ${r.line.slice(0, 200)} · 판단: @loop:${card.id} 또는 eln loop agent ${card.id} status`, 'request');
      mem.appendCase({ at, kind: 'act-parked', subject: key, why: `${n}번 연속 실패 — ${r.line.slice(0, 160)}`, ...(id !== null ? { refs: [`msg:${id}`] } : {}), decidedBy: by, supervisedBy: card.supervisor });
    }
  }
  mem.appendCase({ at, kind: r.ok ? 'act' : 'act-failed', subject: key, why: `${r.line} · 이유: ${pa.why}`, ...(r.ref ? { refs: [r.ref] } : {}),
    decidedBy: by, supervisedBy: card.supervisor, ...(r.undo ? { extra: { undo: r.undo } } : {}) });
  // self-learning: the outcome of an action is a pattern too (`act:<action>:fail` 3× → «this action keeps failing» candidate)
  if (!r.ok && notePattern(ctx.state, `act:${pa.action}:fail`, ctx.now.getTime()))
    addCandidate(mem, `act:${pa.action}:fail`, `${pa.action} 이 일주일에 3번 실패했다 (마지막: ${r.line.slice(0, 160)}) — 같은 대상에 반복하기 전에 원인을 먼저 본다.`, ctx.now);
  return { status: r.ok ? 'acted' : 'failed', line: r.line, ...(r.ref ? { ref: r.ref } : {}), journal: journalRow(card, at, r.ok ? 'acted' : 'failed', pa, r.line, by, obs, r) };
}

/** SUPERVISOR-CORRECTION-JOURNAL: one journal row for one decided correction (before = what the body saw of the target). */
function journalRow(card: AgentCard, at: string, status: JournalRow['status'], pa: PlannedAction, line: string, by: string, obs: Observation, r: ActionResult | null): JournalRow {
  const seen = obs.subjects.find(s => s.id === pa.target || s.id.endsWith(`:${pa.target}`) || pa.target.endsWith(`:${s.id}`));
  return { v: 1, at, agent: card.id, status, action: pa.action, target: pa.target, what: line.slice(0, 300), why: pa.why.slice(0, 300),
    before: r?.before ?? (seen ? `${seen.kind} · ${seen.summary}`.slice(0, 200) : null), after: status === 'acted' ? (r?.after ?? line).slice(0, 200) : null,
    evidence: [`case:${card.id}@${at}`, ...(r?.ref ? [r.ref] : [])], undo: r?.undo ?? null, source: by === card.address ? 'tick' : 'voice', by };
}

/** DETECT-TO-ACTION: « · 대기 N(쿨다운 a:b 12:04Z…)» — a waiting action says why, so a flat KPI with «행동 0» reads as
 *  «my next step is due at …», never as an unexplained refusal. */
export function deferredLine(deferred: readonly string[]): string {
  if (!deferred.length) return '';
  const cool = deferred.filter(d => d.includes('쿨다운')).length;
  return ` · 대기 ${deferred.length}(${cool ? `쿨다운 ${cool}` : ''}${cool && deferred.length > cool ? ' · ' : ''}${deferred.length > cool ? `멈춤 ${deferred.length - cool}` : ''} — ${deferred[0]!.slice(0, 120)})`;
}

/** One wake of the body (the trigger runs this). */
/** The steps one tick walks (LOOP-AGENT v3 · agent.yaml `body:` names them as node kinds `loop-agent.<step>`). */
export const TICK_STEPS = ['observe', 'act', 'learn', 'judge', 'finish'] as const;
export type TickStep = typeof TICK_STEPS[number];
/** observe → ok | breach | unknown | off | error · every other step → ok. */
export type StepOutcome = 'ok' | 'breach' | 'unknown' | 'off' | 'error';
export interface TickGraph { readonly entry: string; readonly terminal: readonly string[]; readonly nodes: readonly { readonly node_id: string; readonly step: TickStep | 'gate'; readonly max_visits?: number }[]; readonly edges: readonly { readonly from: string; readonly map: Readonly<Record<string, string>> }[] }

/** The v2 tick as a graph: observe → act → learn → judge → finish (off / error → finish). agent.yaml may reorder or drop steps. */
const TICK_DONE = 'done';
const nextStep = (s: TickStep): string => TICK_STEPS[TICK_STEPS.indexOf(s) + 1] ?? TICK_DONE;
export const DEFAULT_TICK_GRAPH: TickGraph = {
  entry: TICK_STEPS[0], terminal: [TICK_DONE],
  nodes: [...TICK_STEPS.map(s => ({ node_id: s, step: s })), { node_id: TICK_DONE, step: 'gate' as const }],
  edges: TICK_STEPS.map((s): { from: string; map: Record<string, string> } => ({ from: s, map: s === 'observe'
    ? { ok: nextStep(s), breach: nextStep(s), unknown: nextStep(s), off: 'finish', error: 'finish' }
    : { ok: nextStep(s) } })),
};

/** LOOP-AGENT-V3-SMART-2: what the shell runs from the agent.yaml hook nodes (reflect · plan · learn-knowhow · retro) — data only,
 *  the same code for every supervisor. Absent = the v2 tick exactly (SUP-V3-EQUIV). */
export interface ShellSmart { readonly cfg: SmartConfig }

interface TickRun {
  readonly card: AgentCard; readonly body: AgentBody; readonly ports: AgentPorts; readonly now: Date; readonly at: string;
  readonly lvl: AgentLevel; readonly state: AgentState; ctx: BodyCtx | null;
  readonly smart: ShellSmart | null; planOut: ShellPlan | null; smartRows: ActionRow[]; learned: { created: string[]; promoted: string[] } | null; retro: RetroEntry | null;
  obs: Observation | null; ok: boolean | null; err: string | null; subjectLost: boolean;
  plan: PlannedAction[]; acted: string[]; refused: string[]; failed: string[]; candidates: string[]; promoted: string[]; journal: JournalRow[];
  breach: TickReport['breach']; escalated: boolean; walked: string[];
  /** DETECT-TO-ACTION: why each planned action waits (cooldown · parked) — the 11-27 journals counted these as «거절». */
  deferred: string[];
}

const STEP: Readonly<Record<TickStep, (r: TickRun) => Promise<StepOutcome>>> = {
  async observe(r) {
    const { card, ports, now, at, state } = r; const mem = ports.memory;
    if (r.lvl === 'off') return 'off';
    // first journal start: today's earlier act* cases become journal rows once — before this tick adds its own
    try { backfillTodayFromCases(mem.root, card.id, now); } catch { /* fail-soft */ }
    const rc = recall(mem, `${card.goal} ${card.subject} ${card.kpi.name}`, now, { budget: 3_000, mark: false });
    r.ctx = { now, card, state, recall: rc, level: r.lvl };
    try { r.obs = await r.body.observe(r.ctx); }
    catch (e) {
      r.err = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      mem.appendCase({ at, kind: 'observe-error', subject: card.subject || card.id, why: r.err, decidedBy: card.address, supervisedBy: card.supervisor });
      r.subjectLost = noteSubject(card, ports, state, false, at, `observe error: ${r.err}`);
      return 'error';
    }
    r.ok = kpiOk(card.kpi, r.obs.kpi);
    r.subjectLost = noteSubject(card, ports, state, r.obs.kpi !== null || r.obs.subjects.length > 0, at, r.obs.facts.slice(0, 3).join(' · ') || 'KPI unknown · no subject seen');
    return r.ok === false ? 'breach' : r.ok === true ? 'ok' : 'unknown';
  },
  async act(r) {
    const { card, ports, now, at, state } = r; const mem = ports.memory; const obs = r.obs; const ctx = r.ctx;
    if (!obs || !ctx) return 'ok';
    // A planned action outside the card's rights (not granted yet · narrowed by policy) is recorded as «planned», not refused —
    // once per target per cooldown — so a body can carry an action its L0 has not switched on.
    const planned = r.lvl === 'shadow' ? [] : r.smart ? smartPlan(r, r.body.plan(obs, ctx)) : r.body.plan(obs, ctx);
    for (const pa of planned.filter(p => !card.rights.actions.includes(p.action))) {
      const key = `planned:${pa.action}:${pa.target}`; const last = state.acted[key];
      if (last && now.getTime() - Date.parse(last) < card.rights.cooldownMin * 60_000) continue;
      state.acted[key] = at;
      mem.appendCase({ at, kind: 'planned', subject: `${pa.action}:${pa.target}`, why: `권한 꺼짐(카드 rights.actions 밖) — ${pa.why}`, decidedBy: card.address, supervisedBy: card.supervisor });
    }
    // a parked target does not take a slot of max_per_tick from the targets that can still move (SUPERVISOR-JOURNAL-DEFECTS)
    r.plan = planned.filter(p => card.rights.actions.includes(p.action) && !isParked(state, `${p.action}:${p.target}`, now)).slice(0, Math.max(0, card.rights.maxPerTick));
    if (r.lvl === 'shadow') for (const pa of r.body.plan(obs, ctx).slice(0, card.rights.maxPerTick))
      mem.appendCase({ at, kind: 'planned', subject: `${pa.action}:${pa.target}`, why: `shadow — ${pa.why}`, decidedBy: card.address, supervisedBy: card.supervisor });
    // a failure streak older than the pattern window is forgotten (its target is long gone or long fixed)
    for (const [k, v] of Object.entries(state.failStreak ?? {})) if (now.getTime() - Date.parse(v.since) > PARK_KEEP_DAYS * 86_400_000) delete state.failStreak![k];
    for (const pa of r.plan) {
      const res = await runAction(card, r.body, ports, ctx, obs, pa, card.address);
      if (res.status === 'cooldown' || res.status === 'parked' || res.status === 'held') r.deferred.push(res.line); // the line names the key and why («a:b: 60분 쿨다운 안 (마지막 21:28Z)»)
      else (res.status === 'acted' ? r.acted : res.status === 'failed' ? r.failed : r.refused).push(`${pa.action}:${pa.target}`);
      // v3 (LOOP-AGENT-V3-SMART-2): every decided action is an outcome row the reflection reads — a failure carries its cause
      if (r.smart && (res.status === 'acted' || res.status === 'failed')) r.smartRows.push({ at, intent: shellIntent(obs.subjects.find(x => x.id === pa.target)?.kind), action: pa.action, to: 'self', key: `${pa.action}:${pa.target}:${at}`,
        outcome: res.status === 'acted' ? 'acted' : 'unacted', resolvedAt: at, ...(res.status === 'failed' ? { cause: failureCause(res.line, pa.target) } : {}) });
      if (res.journal) r.journal.push(res.journal); // a cooldown skip carries no journal row — it is not a correction
    }
    return 'ok';
  },
  async learn(r) {
    const { card, ports, now, state } = r; const mem = ports.memory;
    for (const p of r.obs?.patterns ?? []) if (notePattern(state, p.key, now.getTime())) {
      const l = addCandidate(mem, p.key, p.lesson, now);
      if (l) {
        r.candidates.push(l.id);
        ports.post(`lesson-candidate:${card.id}:${l.id}`, card.supervisor,
          `[${card.name} · 교훈 후보 ${l.id}] ${l.text} — 같은 꼴 3회(${p.key}). 이의 없으면 12시간 뒤 승격 · 승인/거절: @loop:${card.id} 에 «${l.id} 승인|거절» 또는 eln loop agent ${card.id} lesson approve|reject ${l.id} --by ${card.supervisor}`, 'info');
      }
    }
    r.promoted = maintainLessons(mem, now).promoted.map(l => l.id);
    if (r.smart) smartLearn(r);
    return 'ok';
  },
  async judge(r) {
    const { card, ports, now, at, state } = r; const mem = ports.memory; const obs = r.obs;
    if (!obs) return 'ok';
    // KPI breach — speak once in the channel; card the L0 once if it lasts
    const step = breachStep({ ok: state.kpiOk, since: state.breachSince }, r.ok, at);
    r.breach = step.event; state.breachSince = step.next.since;
    if (r.breach === 'new') {
      mem.appendCase({ at, kind: 'kpi-breach', subject: card.kpi.name, why: kpiLine(card.kpi, obs.kpi), decidedBy: card.address, supervisedBy: card.supervisor });
      ports.speak?.(`⚠️ [${card.name}] ${kpiLine(card.kpi, obs.kpi)} · 대상 ${obs.subjects.length} · 행동 ${r.acted.length ? r.acted.join(', ') : '없음'}`);
    } else if (r.breach === 'ongoing') {
      const since = step.next.since ?? at;
      if ((step.breachMin ?? 0) >= card.escalateAfterMin) {
        const id = ports.post(`kpi-breach:${card.id}:${since}`, card.supervisor,
          `[${card.name} → L0 ${card.supervisor}] KPI 위반 ${Math.round((now.getTime() - Date.parse(since)) / 60_000)}분 — ${kpiLine(card.kpi, obs.kpi)} · 대상 ${obs.subjects.slice(0, 5).map(s => s.id).join(', ') || '없음'} · 내 행동으로 안 닫힌다 · 판단: @loop:${card.id} 또는 eln loop agent ${card.id} status`, 'request');
        if (id !== null) { r.escalated = true; mem.appendCase({ at, kind: 'escalate', subject: card.kpi.name, why: `L0 ${card.supervisor} 카드 #${id}`, refs: [`msg:${id}`], decidedBy: card.address, supervisedBy: card.supervisor }); }
      }
    } else if (r.breach === 'recovered') {
      mem.appendCase({ at, kind: 'kpi-recovered', subject: card.kpi.name, why: kpiLine(card.kpi, obs.kpi), decidedBy: card.address, supervisedBy: card.supervisor });
      ports.speak?.(`✅ [${card.name}] 회복 — ${kpiLine(card.kpi, obs.kpi)}`);
    }
    return 'ok';
  },
  async finish(r) {
    const { card, ports, at, state } = r; const mem = ports.memory;
    if (r.lvl === 'off') { ports.beat({ name: beatName(card.id), saw: 0, everyMin: card.heartbeatEveryMin, err: 'level off' }); return 'ok'; }
    if (r.err !== null) {
      state.lastTickAt = at; state.ticks += 1; mem.writeState(state);
      ports.beat({ name: beatName(card.id), saw: 0, everyMin: card.heartbeatEveryMin, err: r.err });
      return 'ok';
    }
    const obs = r.obs!;
    if (r.ok !== null) state.kpiOk = r.ok;
    state.lastKpi = obs.kpi; state.kpiHistory.push({ at, v: obs.kpi });
    state.lastTickAt = at; state.ticks += 1;
    mem.writeState(state);
    // SUPERVISOR-CORRECTION-JOURNAL — one line per correction ⊕ the rollup of windows that ended (OP digest ⊕ ws:supervisors)
    try { appendJournal(mem.root, r.journal); } catch { /* fail-soft: the cases row keeps it */ }
    if (ports.rollup) { try { emitWindowRollups(mem.root, card.id, r.now, ports.rollup); } catch { /* fail-soft */ } }
    mem.appendCase({ at, kind: 'tick', subject: card.kpi.name, why: `${kpiLine(card.kpi, obs.kpi)} · 대상 ${obs.subjects.length} · 행동 ${r.acted.length}/${r.plan.length}${r.refused.length ? ` · 거절 ${r.refused.length}` : ''}${r.failed.length ? ` · 실패 ${r.failed.length}` : ''}${deferredLine(r.deferred)}`,
      decidedBy: card.address, supervisedBy: card.supervisor, extra: { level: r.lvl, ...(r.walked.join('>') !== 'observe>act>learn>judge>finish' ? { walked: r.walked } : {}) } });
    ports.beat({ name: beatName(card.id), saw: obs.subjects.length, everyMin: card.heartbeatEveryMin, last: at });
    if (r.smart?.cfg.retro) smartRetro(r);
    return 'ok';
  },
};

// ── v3 hooks on the shell (LOOP-AGENT-V3-SMART-2) — every one fail-open: a broken store never stops the tick ─────────────

/** plan: the body's plan rewritten by what the agent learned (knowhow ⊕ lesson ⊕ agent.yaml fallback) and refused by its soul. */
function smartPlan(r: TickRun, planned: readonly PlannedAction[]): PlannedAction[] {
  try {
    const mem = r.ports.memory; const store = fileSmartStore(mem.root); const subjects = r.obs?.subjects ?? [];
    const blocks = mem.knowhow().text.split(/^(?=##\s+K-)/mu);
    const knowhowId = (marker: string): string | null => /^##\s+(K-[A-Z0-9-]+-\d+)/u.exec(blocks.find(b => b.includes(marker)) ?? '')?.[1] ?? null;
    let learnedText = ''; try { learnedText = readFileSync(join(mem.root, 'knowhow', 'learned.md'), 'utf8'); } catch { /* none yet */ }
    const sp = shellPlan({ cfg: r.smart!.cfg, lessons: store.lessons(), knowhowId,
      planned: planned.map(p => ({ ...p, kind: shellIntent(subjects.find(x => x.id === p.target)?.kind) })),
      human: humanMemory({ learnedText, lessons: mem.lessons(), self: r.card.address }),
      failedOn: (a, t) => (r.state.failStreak?.[`${a}:${t}`]?.n ?? 0) > 0 });
    r.planOut = sp;
    for (const l of sp.lines) if (l.from || l.refused) mem.appendCase({ at: r.at, kind: 'plan', subject: `${l.from ?? l.action}:${l.target}`, why: `${l.refused ? 'refused' : `→ ${l.action}`} · ${l.why}`.slice(0, 400), refs: [...l.cites].slice(0, 4), decidedBy: r.card.address, supervisedBy: r.card.supervisor });
    return sp.lines.filter(l => !l.refused).map(l => ({ action: l.action, target: l.target, why: l.why }));
  } catch { return [...planned]; }
}

/** reflect ⊕ learn-knowhow: this tick's outcome rows → «same action failed N in a row» → one lesson with the cause → one knowhow line. */
function smartLearn(r: TickRun): void {
  try {
    const mem = r.ports.memory; const store = fileSmartStore(mem.root); const cfg = r.smart!.cfg;
    if (r.smartRows.length) store.writeActions([...store.actions(), ...r.smartRows]);
    const s = beginSmart({ cfg, store, now: r.now, l0: r.card.supervisor, readings: [{ name: r.card.kpi.name, value: r.obs?.kpi ?? null }],
      knowhow: cfg.learn ? { text: () => mem.knowhow().text, add: (item, by, now) => mem.addKnowhow(item, by, now) } : null });
    s.save();
    r.learned = { created: s.learned.created, promoted: s.learned.promoted };
    for (const k of s.learned.promoted) mem.appendCase({ at: r.at, kind: 'knowhow-learned', subject: k, why: s.lessons.find(l => l.promoted === k)?.text.slice(0, 300) ?? k, decidedBy: r.card.address, supervisedBy: r.card.supervisor });
  } catch { /* fail-open */ }
}

/** retro: every retro_every_h — journal ⊕ KPI window → what worked · what failed and why · one change to try. */
function smartRetro(r: TickRun): void {
  try {
    const store = fileSmartStore(r.ports.memory.root); const st = store.state();
    const due = retroDue(r.smart!.cfg, st, r.now);
    if (due) { r.retro = writeRetro({ memory: r.ports.memory, card: r.card, actions: r.smart!.cfg.actions, now: r.now, windowH: r.smart!.cfg.retroEveryH }); st.lastRetroAt = r.at; }
    store.writeState(st);
  } catch { /* fail-open */ }
}

/** One retro entry over the last `windowH` hours of this agent (the tick hook and `eln loop agent <id> retro` both call this). */
export function writeRetro(i: { memory: AgentMemory; card: Pick<AgentCard, 'id' | 'kpi' | 'address' | 'supervisor'>; actions: SmartConfig['actions']; now: Date; windowH: number }): RetroEntry {
  const mem = i.memory; const nowMs = i.now.getTime();
  let rows: JournalRow[] = []; try { rows = readJournal(mem.root, nowMs - i.windowH * 3_600_000, nowMs + 1); } catch { rows = []; }
  const e = retro({ agent: i.card.id, now: i.now, windowH: i.windowH, rows, kpi: { name: i.card.kpi.name, target: i.card.kpi.target, dir: i.card.kpi.dir },
    kpiHistory: mem.readState().kpiHistory, lessons: fileSmartStore(mem.root).lessons(), actions: i.actions });
  appendRetro(mem.root, e);
  mem.appendCase({ at: e.at, kind: 'retro', subject: `${i.windowH}h`, why: retroLine(e).slice(0, 600), refs: [...e.evidence], decidedBy: i.card.address, supervisedBy: i.card.supervisor });
  return e;
}

/** One wake of the body (the trigger runs this). `opts.graph` = the agent.yaml body · `opts.policies` = its resolved policies. */
export async function tickAgent(baseCard: AgentCard, body: AgentBody, ports: AgentPorts, now = new Date(), opts: { graph?: TickGraph; policies?: Readonly<Record<string, number>>; smart?: ShellSmart | null } = {}): Promise<TickReport> {
  return withPolicies(opts.policies ?? baseCard.policies, async () => {
    const mem = ports.memory; const card = nowCard(baseCard, mem); const at = now.toISOString();
    const r: TickRun = { card, body, ports, now, at, lvl: levelOf(card, mem).level, state: mem.readState(), ctx: null, obs: null, ok: null, err: null, subjectLost: false,
      plan: [], acted: [], refused: [], failed: [], candidates: [], promoted: [], journal: [], breach: null, escalated: false, walked: [], deferred: [],
      smart: opts.smart ?? null, planOut: null, smartRows: [], learned: null, retro: null };
    const g = opts.graph ?? DEFAULT_TICK_GRAPH;
    const visits = new Map<string, number>();
    let node = g.entry;
    for (let hops = 0; hops < 50 && !g.terminal.includes(node); hops++) {
      const n = g.nodes.find(x => x.node_id === node);
      if (!n) break;
      const v = (visits.get(node) ?? 0) + 1; visits.set(node, v);
      if (v > (n.max_visits ?? 1)) break;
      const out: StepOutcome = n.step === 'gate' ? 'ok' : await STEP[n.step](r);
      if (n.step !== 'gate') r.walked.push(n.step);
      const next = g.edges.find(e => e.from === node)?.map[out];
      if (!next) break;
      node = next;
    }
    const base = { id: card.id, at, level: r.lvl, candidates: r.candidates, promoted: r.promoted };
    if (r.lvl === 'off') return { ...base, subjects: 0, planned: 0, acted: [], refused: [], failed: [], kpi: null, kpiOk: null, kpiLine: kpiLine(card.kpi, null), breach: null, escalated: false };
    if (r.err !== null) return { ...base, subjects: 0, planned: 0, acted: [], refused: [], failed: [], kpi: null, kpiOk: null, kpiLine: kpiLine(card.kpi, null), breach: null, escalated: false, error: r.err, ...(r.subjectLost ? { subjectLost: true } : {}) };
    const kpi = r.obs?.kpi ?? null;
    return { ...base, kpi, kpiOk: r.ok, kpiLine: kpiLine(card.kpi, kpi), subjects: r.obs?.subjects.length ?? 0, planned: r.plan.length, acted: r.acted, refused: r.refused, failed: r.failed, ...(r.deferred.length ? { deferred: r.deferred } : {}),
      breach: r.breach, escalated: r.escalated, ...(r.subjectLost ? { subjectLost: true } : {}),
      ...(r.planOut ? { plan: r.planOut } : {}), ...(r.learned && (r.learned.created.length || r.learned.promoted.length) ? { learned: r.learned } : {}), ...(r.retro ? { retro: retroLine(r.retro) } : {}) };
  });
}

// ── voice ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface VoiceMessage { readonly id: number | string; readonly from: string; readonly body: string; readonly at: string; readonly channel: string; readonly thread?: string }
export interface VoiceResult { readonly msg: VoiceMessage; readonly folded: boolean; readonly reply: string; readonly refs: string[]; readonly actions: string[]; readonly model: string | null; readonly escalated: boolean }

export type VoiceCmd =
  | { cmd: 'act'; action: string; target: string; why?: string }
  | { cmd: 'escalate'; why: string }
  | { cmd: 'set-level'; to: string; why?: string }
  | { cmd: 'set-policy'; key: string; value: unknown; why?: string }
  | { cmd: 'lesson'; text: string }
  | { cmd: 'lesson-decide'; id: string; approve: boolean };

export function voiceRights(card: AgentCard, body: AgentBody): string {
  const acts = card.rights.actions.map(a => `  - {"cmd":"act","action":"${a}","target":"<대상 id>","why":"…"} — ${body.actions[a]?.describe ?? '(몸에 없음)'}`).join('\n');
  return [`할 수 있는 명령(이 JSON 만 · 다른 것은 실행되지 않는다):`, acts,
    `  - {"cmd":"escalate","why":"…"} — 권한 밖·판단 필요 → L0 ${card.supervisor}`,
    `  - {"cmd":"set-level","to":"live|L1|shadow|off"} · {"cmd":"set-policy","key":"<kpi.target|wake.max_wait_min|rights.max_per_tick|rights.cooldown_min|voice.per_hour_max|escalate_after_min|rights.disable|rights.enable|focus>","value":…} · {"cmd":"lesson","text":"…"} · {"cmd":"lesson-decide","id":"L-n","approve":true|false} — 보낸 이가 ${[...policySeats(card)].join('·')} 일 때만(그 밖이면 거절된다)`,
    `하지 않는 것: ${card.rights.neverAuto.join(' · ') || '권한 밖 행동'} · 셸 실행 · 권한 넓히기.`].join('\n');
}

/** LOOP-AGENT-V3-SMART-2: the agent.yaml soul block as prompt text (purpose · values · do_not · voice · serves). */
export const soulBlockText = (s: AgentSoul): string => ['## 영혼 (agent.yaml soul)', `목적: ${s.purpose}`, s.values.length ? `가치: ${s.values.join(' · ')}` : '',
  s.doNot.length ? `하지 않는 것: ${s.doNot.join(' · ')}` : '', s.voice ? `말투: ${s.voice}` : '', s.serves.length ? `섬기는 이: ${s.serves.join(' · ')}` : ''].filter(Boolean).join('\n');

export function buildPrompt(card: AgentCard, body: AgentBody, msg: VoiceMessage, obs: Observation | null, state: AgentState, level: AgentLevel, rc: Recall, thread: readonly { from: string; text: string; reply: string }[], journal = '', extra: { soul?: AgentSoul | null; retro?: string } = {}): { system: string; user: string } {
  const soul = [`# ${card.name} (${card.id} · 주소 ${card.address} · @loop:${card.id})`, card.role && `역할: ${card.role}`, card.temperament && `기질: ${card.temperament}`,
    card.values.length ? `가치:\n${card.values.map((v, i) => `${i + 1}. ${v}`).join('\n')}` : '', card.soulText, extra.soul ? soulBlockText(extra.soul) : ''].filter(Boolean).join('\n');
  const system = [soul,
    '## 목표 카드', `대상: ${card.subject || '-'}\n목표: ${card.goal || '-'}\nKPI: ${card.kpi.name} ${card.kpi.dir === 'at_most' ? '≤' : '≥'} ${card.kpi.target}${card.kpi.unit ? ` ${card.kpi.unit}` : ''}\n완료 조건: ${card.doneWhen.join(' · ') || '-'}\nL0 감독: ${card.supervisor}${card.focus ? `\n지금 초점(정책): ${card.focus}` : ''}`,
    '## 권한', voiceRights(card, body),
    '## 답 형식', `오직 JSON 한 덩어리: {"reply":"<한국어 · ${card.name}로서 · 증거 id(대상·case·msg) 포함 · 6줄 이하>","actions":[<위 명령 0개 이상>]}. «왜 KPI 가 떨어졌나·지금 뭘 하나·뭐가 막나» 에는 아래 사실·사건으로 답한다. «오늘 뭘 했나·뭘 고쳤나» 에는 아래 «교정 일지»의 숫자(행동·실패·거절)와 항목을 그대로 쓴다 — 일지에 없는 교정을 지어내지 않는다. «회고·뭘 배웠나» 에는 아래 «최근 회고»를 그대로 인용한다. 모르면 모른다고 한다.`,
  ].join('\n\n');
  const user = [
    `## 지금 (${state.lastTickAt ?? '-'} 마지막 틱 · 수준 ${level})`,
    obs ? `${kpiLine(card.kpi, obs.kpi)}\n대상 ${obs.subjects.length}: ${obs.subjects.slice(0, 10).map(s => `${s.id}(${s.kind}${s.ageMin !== undefined ? ` ${Math.round(s.ageMin)}분` : ''} · ${s.summary.slice(0, 80)})`).join(' · ') || '없음'}${obs.facts.length ? `\n사실: ${obs.facts.slice(0, 8).join(' · ')}` : ''}` : `KPI 마지막 ${state.lastKpi ?? '?'} (관측 실패)`,
    `KPI 이력(최근): ${state.kpiHistory.slice(-8).map(h => `${h.at.slice(11, 16)}=${h.v ?? '?'}`).join(' ') || '-'}${state.breachSince ? ` · 위반 시작 ${state.breachSince.slice(5, 16)}` : ''}`,
    journal ? `## 교정 일지 (eln loop agent journal ${card.id})\n${journal}` : '',
    extra.retro ? `## 최근 회고 (eln loop agent ${card.id} retro)\n${extra.retro}` : '',
    rc.text,
    thread.length ? `## 이 대화의 앞 turn\n${thread.map(t => `${t.from}: ${t.text.slice(0, 300)}\n→ ${t.reply.slice(0, 300)}`).join('\n')}` : '',
    `## 받은 말 (${msg.channel} #${msg.id} · 보낸 이 ${msg.from})\n${msg.body.slice(0, 2_000)}`,
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

export function parseVoice(text: string): { reply: string; actions: VoiceCmd[] } {
  const m = /\{[\s\S]*\}/u.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { reply?: unknown; actions?: unknown };
      const actions = Array.isArray(j.actions) ? j.actions.filter((a): a is VoiceCmd => !!a && typeof a === 'object' && typeof (a as { cmd?: unknown }).cmd === 'string') : [];
      if (typeof j.reply === 'string') return { reply: j.reply.trim(), actions };
    } catch { /* fall through */ }
  }
  return { reply: text.trim(), actions: [] };
}

/** Channel action token (#40331 contract /^[A-Za-z0-9._:=-]{1,120}$/). */
export const actionToken = (verb: string, arg = ''): string => `${verb}${arg ? `:${arg}` : ''}`.replace(/[^A-Za-z0-9._:=-]/gu, '_').slice(0, 120);

export interface VoiceDeps { readonly card: AgentCard; readonly body: AgentBody; readonly ports: AgentPorts; readonly now?: Date; readonly policies?: Readonly<Record<string, number>>; /** agent.yaml soul block (LOOP-AGENT-V3-SMART-2) */ readonly soul?: AgentSoul | null }

/** Deterministic reply when the voice cannot think (no LLM · over budget · L1 · LLM error): the facts, and where to go. */
export function foldedReply(card: AgentCard, obs: Observation | null, state: AgentState, why: string, journal = '', knowhow: readonly string[] = [], retroText = ''): string {
  // SUPERVISOR-CORRECTION-JOURNAL: without an LLM the voice still answers «what did you do» — from its own journal.
  return [`[${card.name} · 목소리 접힘: ${why}]${card.role ? ` ${card.role.slice(0, 80)}` : ''}`, journal, obs ? kpiLine(card.kpi, obs.kpi) : `KPI 마지막 ${state.lastKpi ?? '?'}`,
    obs ? `대상 ${obs.subjects.length}: ${obs.subjects.slice(0, 5).map(s => s.id).join(', ') || '없음'}` : '', state.breachSince ? `위반 시작 ${state.breachSince.slice(5, 16)}` : '',
    knowhow.length ? `노하우: ${knowhow.slice(0, 2).map(k => k.replace(/^##\s+/u, '').slice(0, 80)).join(' · ')}` : '',
    retroText ? `최근 ${retroText.slice(0, 400)}` : '',
    `판단·결정이 필요하면 L0 ${card.supervisor} 에 직접.`].filter(Boolean).join('\n');
}

export async function voiceAgent(deps: VoiceDeps, msg: VoiceMessage): Promise<VoiceResult> {
  return withPolicies(deps.policies ?? deps.card.policies, () => voiceAgentTurn(deps, msg));
}
async function voiceAgentTurn(deps: VoiceDeps, msg: VoiceMessage): Promise<VoiceResult> {
  const { body, ports } = deps; const mem = ports.memory; const now = deps.now ?? new Date();
  const card = nowCard(deps.card, mem); const at = now.toISOString();
  const lvl = levelOf(card, mem);
  const threadKey = msg.thread ?? msg.channel;
  const finish = (r: Omit<VoiceResult, 'msg'>): VoiceResult => {
    const refs = [`${msg.channel}:${msg.id}`, ...r.refs];
    const reply = `${r.reply}\n— 근거: ${refs.join(' ')} · ${card.name}(${card.address} · L0 ${card.supervisor})`;
    mem.appendCase({ at, kind: 'voice', subject: `${msg.channel}#${msg.id}`, why: reply.slice(0, 400), refs, decidedBy: card.address, supervisedBy: card.supervisor,
      extra: { from: msg.from, folded: r.folded, model: r.model, escalated: r.escalated, actions: r.actions } });
    mem.appendThread(threadKey, { at, from: msg.from, text: msg.body.slice(0, 1_000), reply: r.reply.slice(0, 1_000) });
    return { msg, ...r, refs, reply };
  };
  if (lvl.level === 'off' || lvl.level === 'shadow')
    return finish({ folded: true, reply: `[${card.name} · ${lvl.level} (by ${lvl.by} ${lvl.at})] 지금은 판단도 행동도 하지 않는다 — L0 ${card.supervisor} 에 직접.`, refs: [], actions: [], model: null, escalated: false });
  const state = mem.readState();
  const rc = recall(mem, msg.body, now);
  const ctx: BodyCtx = { now, card, state, recall: rc, level: lvl.level };
  let obs: Observation | null = null;
  try { obs = await body.observe(ctx); } catch { obs = null; }
  let journal = '';
  try { backfillTodayFromCases(mem.root, card.id, now); journal = journalBrief(mem.root, card.id, now).text; } catch { journal = ''; }
  let retroText = '';
  try { const last = readRetros(mem.root, 1)[0]; retroText = last ? retroLine(last) : ''; } catch { retroText = ''; }
  const llm = ports.llm ?? null;
  let budgetOk = false;
  if (llm && lvl.level === 'live') {
    state.voiceTurns = state.voiceTurns.filter(t => now.getTime() - t < 3_600_000);
    budgetOk = state.voiceTurns.length < card.voice.perHourMax;
    if (budgetOk) state.voiceTurns.push(now.getTime());
  }
  const why = lvl.level !== 'live' ? `수준 ${lvl.level}` : !llm ? 'LLM 없음' : !budgetOk ? `예산 초과(${card.voice.perHourMax}/h)` : null;
  if (why) { mem.writeState(state); return finish({ folded: true, reply: foldedReply(card, obs, state, why, journal, rc.knowhow, retroText), refs: [], actions: [], model: null, escalated: false }); }
  const prompt = buildPrompt(card, body, msg, obs, state, lvl.level, rc, mem.thread(threadKey, 6), journal, { soul: deps.soul ?? null, retro: retroText });
  let out: { text: string; model: string };
  try { out = await llm!.complete(prompt.system, prompt.user); if (!out.text.trim()) throw new Error('empty answer'); }
  catch (e) { mem.writeState(state); return finish({ folded: true, reply: foldedReply(card, obs, state, `LLM 오류 ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`, journal, rc.knowhow, retroText), refs: [], actions: [], model: null, escalated: false }); }
  const parsed = parseVoice(out.text);
  const lines: string[] = []; const refs: string[] = []; const tokens: string[] = []; let escalated = false;
  const from = msg.from.trim().toUpperCase(); const mayPolicy = policySeats(card).has(from);
  const escalate = (why2: string): void => {
    const id = ports.post(`voice-esc:${card.id}:${msg.channel}:${msg.id}`, card.supervisor, `[${card.name} → L0 ${card.supervisor}] ${msg.from} ${msg.channel}#${msg.id}: ${why2.slice(0, 300)}`, 'request');
    lines.push(`→ L0 ${card.supervisor}${id !== null ? ` #${id}` : ' (이미 올림)'}`); if (id !== null) refs.push(`msg:${id}`); tokens.push(actionToken('escalate', card.supervisor)); escalated = true;
  };
  for (const a of parsed.actions.slice(0, 6)) {
    switch (a.cmd) {
      case 'act': {
        if (!obs) { lines.push(`${a.action}: 관측 실패라 행동하지 않는다`); tokens.push(actionToken('act-refused', a.action)); break; }
        const r = await runAction(card, body, ports, ctx, obs, { action: String(a.action ?? ''), target: String(a.target ?? ''), why: `voice ${msg.from} #${msg.id}${a.why ? ` · ${a.why}` : ''}` }, `${card.address}<-${from}`);
        if (r.journal) { try { appendJournal(mem.root, [r.journal]); } catch { /* fail-soft */ } }
        lines.push(r.line); if (r.ref) refs.push(r.ref); tokens.push(actionToken(r.status === 'acted' ? 'act' : `act-${r.status}`, `${a.action}:${a.target}`)); break;
      }
      case 'escalate': escalate(String(a.why ?? '판단 요청')); break;
      case 'set-level': {
        const to = String(a.to ?? '');
        if (!mayPolicy) { lines.push(`수준 변경 거절 — ${from} 는 L0·HQ 가 아니다`); tokens.push(actionToken('set-level-refused', to)); break; }
        if (!(AGENT_LEVELS as readonly string[]).includes(to)) { lines.push(`없는 수준 ${to}`); break; }
        mem.setLevel(to as AgentLevel, from, a.why ?? `voice ${msg.channel}#${msg.id}`, now); lines.push(`수준 → ${to} (${from})`); tokens.push(actionToken('set-level', to)); break;
      }
      case 'set-policy': {
        if (!mayPolicy) { lines.push(`정책 변경 거절 — ${from} 는 L0·HQ 가 아니다`); tokens.push(actionToken('set-policy-refused', String(a.key))); break; }
        const r = applyPolicyChange(deps.card, mem.policy(), String(a.key ?? ''), a.value);
        if (!r.ok) { lines.push(`정책 거절 — ${r.why}`); tokens.push(actionToken('set-policy-refused', String(a.key))); break; }
        mem.writePolicy(r.policy);
        mem.appendCase({ at, kind: 'policy', subject: String(a.key), why: `${JSON.stringify(a.value)} · ${a.why ?? ''} · voice ${msg.channel}#${msg.id}`, decidedBy: from, supervisedBy: card.supervisor });
        lines.push(`정책 ${a.key} = ${JSON.stringify(a.value)} (${from})`); tokens.push(actionToken('set-policy', String(a.key))); break;
      }
      case 'lesson': {
        if (!mayPolicy) { lines.push(`교훈 기록 거절 — ${from} 는 L0·HQ 가 아니다`); break; }
        const l = addLesson(mem, String(a.text ?? ''), `voice:${msg.channel}`, from, now);
        mem.appendCase({ at, kind: 'lesson', subject: l.id, why: l.text, decidedBy: from, supervisedBy: card.supervisor });
        lines.push(`교훈 ${l.id} 기록`); tokens.push(actionToken('lesson', l.id)); break;
      }
      case 'lesson-decide': {
        if (!mayPolicy) { lines.push(`교훈 결정 거절 — ${from} 는 L0·HQ 가 아니다`); break; }
        const l = decideLesson(mem, String(a.id ?? ''), a.approve === true, from, now);
        if (!l) { lines.push(`${a.id}: 후보 교훈 아님`); break; }
        mem.appendCase({ at, kind: 'lesson', subject: l.id, why: `${l.status} by ${from}`, decidedBy: from, supervisedBy: card.supervisor });
        lines.push(`교훈 ${l.id} → ${l.status}`); tokens.push(actionToken(a.approve ? 'lesson-approve' : 'lesson-reject', l.id)); break;
      }
      default: {
        lines.push(`권한 밖 명령 ${String((a as { cmd?: unknown }).cmd).slice(0, 20)} 실행 안 함`); tokens.push(actionToken('refused', String((a as { cmd?: unknown }).cmd)));
        escalate(`권한 밖 명령 요청 ${JSON.stringify(a).slice(0, 120)}`);
      }
    }
  }
  mem.writeState(state);
  return finish({ folded: false, reply: [parsed.reply || '(빈 답)', ...(lines.length ? [`— 행동: ${lines.join(' · ')}`] : [])].join('\n'), refs, actions: tokens, model: out.model, escalated });
}
