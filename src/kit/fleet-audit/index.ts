// kit/fleet-audit — audit a fleet of loop agents from their own homes (SUPERVISOR-AUDITOR-LOOP · 0.3.39 · 대표 11-28 16:5x
// «자동으로 돌아가도록 조치를 계속 · 스스로 돌아가도록»).
//
// S: a Claude session cron did two supervision jobs by hand — the hourly supervisor audit (tick age · KPI · breach length ·
//    acts tried/ok/refused · lessons · six-axis score ⊕ trend · «보기만 함» · «거짓 초록» → a ledger table) and the 15-min
//    live check (seat-state/OP/tools/loop-agent-live-check.sh: tick stale > 45 min · KPI missing · watch-only). Both shelled
//    out to `eln loop agent <id>` per agent and parsed its text; when the session stopped, nobody audited the auditors.
// C: the facts already live in every agent's home (`<stateRoot>/loop-agents/<id>/{state.json, last-tick.json, cases.jsonl,
//    lessons.jsonl, journal/}`) behind existing readers (memory.ts fileAgentMemory · journal.ts readJournal); the judgment is
//    a few rules whose numbers belong in YAML; the hand-off is a short ladder (refire → owner card → ✋ L0).
// Q: what is the smallest shared piece that any auditor instance (HQ today · a kingdom's own fleet tomorrow) can run from
//    its agent.yaml policies alone?
// A: this kit — pure judgment (`judgeFleet` · `healPlan` · `redStep` · `ledgerTable` · `summaryLines`) over readings
//    (`readFleetReading` · `fleetMembers`), every number from the caller's policy record (`fleetPolicy(pn)`), no clock, no
//    mail, no CLI. The executor kind `fleet-audit.observe` (src/loop-agent/v3/fleet-audit-kind.ts) wires it to the runtime.
//
// 세 얼굴: 관측 = the agents' own homes through memory.ts / journal.ts (a reader that fails is «?», never 0) ⊕ the trigger
//          registry rows (which trigger refires whom) / 판단 근거 = agent.yaml policies (stale_tick_min · watch_only_breach_min ·
//          false_green_unacted_min · rung_wait_min · red_* · w_*) / 수복과 인계 = the ladder each flagged agent climbs once per
//          episode (refire when its tick stopped → card to its L0 with the top refusal → ✋ to the auditor's L0) ⊕ red → one
//          notice per red episode. The executor owns the doors; this module only decides.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MINUTE_MS, ageMin } from '../kpi/index.js';
import { readPeer } from '../kpi/rollup.js';
import { agentHome, fileAgentMemory } from '../../loop-agent/memory.js';
import { readJournal } from '../../loop-agent/journal.js';

// ── policy (every number from the agent.yaml policies: block) ───────────────────────────────────────────────────────
export interface FleetPolicy {
  readonly windowMin: number; readonly staleTickMin: number; readonly staleCadenceX: number; readonly watchOnlyBreachMin: number; readonly falseGreenUnactedMin: number;
  readonly rungWaitMin: number; readonly healMaxPerTick: number; readonly redWatchOnlyMin: number; readonly redAfterMin: number;
  readonly partial: number; readonly summaryLinesMax: number;
  readonly weights: { readonly outcome: number; readonly response: number; readonly proactive: number; readonly robust: number; readonly judgment: number; readonly sustain: number };
}
export { FLEET_POLICY_NAMES } from './policy-names.js';

/** `pn` = the runtime's policy reader (throws on a missing name — no default here). */
export function fleetPolicy(pn: (name: string) => number): FleetPolicy {
  return {
    windowMin: pn('window_min'), staleTickMin: pn('stale_tick_min'), staleCadenceX: pn('stale_cadence_x'), watchOnlyBreachMin: pn('watch_only_breach_min'), falseGreenUnactedMin: pn('false_green_unacted_min'),
    rungWaitMin: pn('rung_wait_min'), healMaxPerTick: pn('heal_max_per_tick'), redWatchOnlyMin: pn('red_watch_only_min'), redAfterMin: pn('red_after_min'),
    partial: pn('score_partial_pct') / 100, summaryLinesMax: pn('summary_lines_max'),
    weights: { outcome: pn('w_outcome'), response: pn('w_response'), proactive: pn('w_proactive'), robust: pn('w_robust'), judgment: pn('w_judgment'), sustain: pn('w_sustain') },
  };
}

// ── readings (one per agent · from its own home) ────────────────────────────────────────────────────────────────────
export interface FleetMember {
  readonly id: string;
  /** The seat that owns this agent's KPI (its L0). */
  readonly l0: string;
  /** The live trigger that runs it (null = not registered here → no refire door). */
  readonly trigger: string | null;
  /** Its own beat cadence (agent.yaml heartbeat_every_min) — a daily agent is not «stopped» after 45 min · null = unknown. */
  readonly cadenceMin: number | null;
}
export type KpiState = 'ok' | 'breach' | 'unknown' | 'missing';
export interface FleetReading {
  readonly id: string; readonly l0: string; readonly trigger: string | null; readonly cadenceMin: number | null;
  /** The level its L0 set (`off` = switched off on purpose → listed, never flagged). */
  readonly level: string;
  readonly tickAt: string | null; readonly tickError: string | null;
  readonly kpiState: KpiState; readonly kpi: number | null; readonly breachSince: string | null;
  /** Journal rows in the window (`acted` · `failed` · `refused`). */
  readonly acted: number; readonly failed: number; readonly refused: number;
  /** The most frequent refusal / failure line in the window (what the owner should look at first). */
  readonly topRefusal: string | null;
  /** The agent carded its own L0 for this breach (a `kind: escalate` case at/after breachSince). */
  readonly escalated: boolean;
  /** Active lessons (what it learned and keeps). */
  readonly lessons: number;
}

const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; } };

/** One agent's reading from its home. Null = the home could not be read at all (the caller shows «?»). */
export function readFleetReading(stateRoot: string, m: FleetMember, now: Date, windowMin: number): FleetReading | null {
  try {
    const mem = fileAgentMemory(stateRoot, m.id, m.l0);
    const st = mem.readState();
    // the peer's own tick file ⊕ its escalation since the breach start: the ONE peer reader (kit/kpi/rollup readPeer · P1 #40684)
    const peer = readPeer(stateRoot, { id: m.id, trigger: m.trigger ?? m.id, label: null, show: 'none', tick: null }, [], now);
    const tickAt = st.lastTickAt ?? peer.tick?.at ?? null;
    const everKpi = st.kpiHistory.some(h => h.v !== null) || st.lastKpi !== null;
    const kpiState: KpiState = st.kpiOk === true ? 'ok' : st.kpiOk === false ? 'breach' : everKpi || st.kpiHistory.length ? 'unknown' : 'missing';
    const nowMs = now.getTime();
    const rows = readJournal(agentHome(stateRoot, m.id), nowMs - windowMin * MINUTE_MS, nowMs);
    const count = (s: string) => rows.filter(r => r.status === s).length;
    const why = new Map<string, number>();
    for (const r of rows) if (r.status !== 'acted') { const k = (r.what || r.why || r.action).slice(0, 140); why.set(k, (why.get(k) ?? 0) + 1); }
    const top = [...why.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const since = st.kpiOk === false ? st.breachSince : null;
    const escalated = peer.escalatedRef !== null;
    return {
      id: m.id, l0: m.l0, trigger: m.trigger, cadenceMin: m.cadenceMin, level: mem.level().level, tickAt, tickError: peer.tick?.error ? peer.tick.error.slice(0, 160) : null,
      kpiState, kpi: st.lastKpi, breachSince: since, acted: count('acted'), failed: count('failed'), refused: count('refused'),
      topRefusal: top ? `${top[0]} ×${top[1]}` : null, escalated, lessons: mem.lessons().filter(l => l.status === 'active').length,
    };
  } catch { return null; }
}

/** An agent with no v2 card (judge-butler · land-steward · guardian — JUDGE-BUTLER-V3-LISTED) keeps its tick and KPI in its own
 *  tick file (agent.yaml kpis[].from · src/loop-agent/v3/listed.ts listedRow): fill what the shell state does not carry. Its breach
 *  start is not recorded anywhere → breachSince stays null (breach minutes «0» · never «보기만 함» on a guess). GUARDIAN-KPI-FROM: a
 *  shell state with history but no verdict («모름» — guardian's state.json) takes the tick file's verdict too. */
export function withListed(r: FleetReading, l: { readonly lastTickAt: string | null; readonly kpiOk: boolean | null; readonly kpisRead: number }): FleetReading {
  const listed: KpiState | null = l.kpiOk === true ? 'ok' : l.kpiOk === false ? 'breach' : null;
  const kpiState: KpiState = r.kpiState === 'unknown' ? listed ?? 'unknown' : r.kpiState !== 'missing' ? r.kpiState : listed ?? (l.kpisRead > 0 ? 'unknown' : 'missing');
  return { ...r, tickAt: r.tickAt ?? l.lastTickAt, kpiState };
}

/** The fleet: every agent definition dir (agent.yaml / goal.yaml), minus `self`, minus agents whose trigger is retired here (an
 *  uninstalled plugin is history) and minus agents that are neither registered here nor ever ran here (not installed on this
 *  host). A home without a definition is history too (a removed agent). `l0Of` / `triggerOf` / `cadenceOf` read the definition. */
export function fleetMembers(opts: {
  readonly defsRoot: string; readonly stateRoot: string; readonly self: string; readonly fallbackL0: string;
  readonly l0Of: (id: string) => string | null; readonly triggerOf: (id: string) => string | null; readonly cadenceOf: (id: string) => number | null;
  readonly liveTriggers: ReadonlySet<string> | null; readonly retiredTriggers: ReadonlySet<string> | null;
}): FleetMember[] {
  const ID = /^[a-z][a-z0-9-]{0,62}$/u;
  const ids = new Set<string>();
  const add = (dir: string, has: (d: string) => boolean) => { try { for (const n of readdirSync(dir)) if (ID.test(n) && has(join(dir, n))) ids.add(n); } catch { /* absent root */ } };
  add(opts.defsRoot, d => existsSync(join(d, 'agent.yaml')) || existsSync(join(d, 'goal.yaml')));
  ids.delete(opts.self);
  const out: FleetMember[] = [];
  for (const id of [...ids].sort()) {
    const declared = opts.triggerOf(id) ?? id;
    if (opts.retiredTriggers?.has(declared)) continue;
    const trigger = opts.liveTriggers?.has(declared) ? declared : null;
    if (opts.liveTriggers && !trigger && !existsSync(join(agentHome(opts.stateRoot, id), 'state.json'))) continue;
    out.push({ id, l0: opts.l0Of(id) ?? opts.fallbackL0, trigger, cadenceMin: opts.cadenceOf(id) });
  }
  return out;
}

// ── judgment ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type FleetFlag = 'tick-stale' | 'kpi-missing' | 'watch-only' | 'false-green';
export interface AxisScores { readonly outcome: number; readonly response: number; readonly proactive: number; readonly robust: number; readonly judgment: number; readonly sustain: number; readonly total: number }
export interface FleetVerdict extends FleetReading {
  readonly tickAgeMin: number | null; readonly breachMin: number | null;
  readonly flags: readonly FleetFlag[]; readonly score: AxisScores;
}

/** Six axes (성과 · 반응책임 · 능동 · 견고 · 판단 · 지속) — each a 0..1 fraction × its YAML weight. */
export function scoreReading(r: FleetReading, flags: readonly FleetFlag[], breachMin: number | null, p: FleetPolicy): AxisScores {
  const part = p.partial; const tries = r.acted + r.failed + r.refused;
  const outcome = r.kpiState === 'ok' ? 1 : r.kpiState === 'breach' ? Math.max(0, 1 - (breachMin ?? 0) / (2 * p.watchOnlyBreachMin)) : part;
  const response = r.kpiState !== 'breach' ? 1 : r.acted > 0 ? 1 : r.escalated ? part : (breachMin ?? 0) < p.watchOnlyBreachMin ? part : 0;
  const proactive = r.acted > 0 ? 1 : tries > 0 ? 0 : part;
  const robust = flags.includes('tick-stale') ? 0 : r.tickError ? part : 1;
  const judgment = tries === 0 ? 1 : r.acted / tries;
  const sustain = r.lessons > 0 ? 1 : part;
  const w = p.weights;
  const s = { outcome: outcome * w.outcome, response: response * w.response, proactive: proactive * w.proactive, robust: robust * w.robust, judgment: judgment * w.judgment, sustain: sustain * w.sustain };
  return { ...s, total: Math.round(s.outcome + s.response + s.proactive + s.robust + s.judgment + s.sustain) };
}

/** Flags ⊕ scores for each reading («틱 정지» = older than max(stale_tick_min, stale_cadence_x × its own cadence) · a level
 *  `off` agent is listed with no flag). «보기만 함» = KPI breach ≥ watch_only_breach_min ∧ 0 acts in the window (only refusals /
 *  failures or nothing) · «거짓 초록» = KPI ok but the tick that judged it is stale or errored, or ≥ false_green_unacted_min
 *  refusals/failures with 0 acts in the window. */
export function judgeFleet(readings: readonly FleetReading[], p: FleetPolicy, now: Date): FleetVerdict[] {
  const nowMs = now.getTime();
  return readings.map(r => {
    const tickAgeMin = ageMin(r.tickAt, nowMs);
    const breachMin = r.kpiState === 'breach' ? ageMin(r.breachSince, nowMs) ?? 0 : null;
    const flags: FleetFlag[] = [];
    const staleAfter = Math.max(p.staleTickMin, p.staleCadenceX * (r.cadenceMin ?? 0));
    const stale = tickAgeMin === null || tickAgeMin > staleAfter;
    if (r.level === 'off') return { ...r, tickAgeMin, breachMin, flags, score: scoreReading(r, flags, breachMin, p) };
    if (stale) flags.push('tick-stale');
    if (r.kpiState === 'missing') flags.push('kpi-missing');
    if (r.kpiState === 'breach' && (breachMin ?? 0) >= p.watchOnlyBreachMin && r.acted === 0) flags.push('watch-only');
    if (r.kpiState === 'ok' && (stale || r.tickError !== null || (r.acted === 0 && r.failed + r.refused >= p.falseGreenUnactedMin))) flags.push('false-green');
    return { ...r, tickAgeMin, breachMin, flags, score: scoreReading(r, flags, breachMin, p) };
  });
}

export const trendOf = (prev: number | null | undefined, cur: number): string => (prev === null || prev === undefined ? '·' : cur > prev ? `↑${cur - prev}` : cur < prev ? `↓${prev - cur}` : '→');

// ── the auditor's own memory (one JSON in its home) ─────────────────────────────────────────────────────────────────
export interface LadderStep { readonly episode: string; readonly rung: number; readonly at: string }
export interface AuditMemory {
  /** last full audit (the report action) — audit_age_min reads it */
  lastAuditAt: string | null;
  /** scores at the start of the current hour (trend baseline) · the hour they belong to */
  baseHour: string | null; baseScores: Record<string, number>; curHour: string | null; curScores: Record<string, number>;
  /** agent → the ladder it climbs for its current episode */
  ladder: Record<string, LadderStep>;
  redSince: string | null; redNotified: string | null; lastSummaryHour: string | null;
}
export const emptyAuditMemory = (): AuditMemory => ({ lastAuditAt: null, baseHour: null, baseScores: {}, curHour: null, curScores: {}, ladder: {}, redSince: null, redNotified: null, lastSummaryHour: null });
const memPath = (home: string) => join(home, 'fleet-audit.json');
export function readAuditMemory(home: string): AuditMemory { return { ...emptyAuditMemory(), ...(readJson<Partial<AuditMemory>>(memPath(home)) ?? {}) }; }
export function writeAuditMemory(home: string, m: AuditMemory): void {
  mkdirSync(home, { recursive: true });
  const tmp = `${memPath(home)}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(m, null, 1)); renameSync(tmp, memPath(home));
}
/** The hour key of a time (UTC `YYYY-MM-DDTHH`). */
export const hourKey = (now: Date): string => now.toISOString().slice(0, 13);

/** Fold this tick's scores into the hour baseline: a new hour makes the last hour's scores the baseline. Mutates `m`. */
export function rollScores(m: AuditMemory, verdicts: readonly FleetVerdict[], now: Date): void {
  const h = hourKey(now);
  if (m.curHour !== h) { if (m.curHour) { m.baseHour = m.curHour; m.baseScores = m.curScores; } m.curHour = h; }
  m.curScores = Object.fromEntries(verdicts.map(v => [v.id, v.score.total]));
}

// ── the ladder (one rung per agent per tick · each rung once per episode) ───────────────────────────────────────────
export type HealAction = 'refire' | 'owner-card' | 'l0-hand';
export interface HealStep { readonly action: HealAction; readonly target: string; readonly why: string; readonly episode: string; readonly rung: number }

/** The episode a flagged agent is in: a stopped tick is keyed by its last tick · a watch-only by its breach start. */
export function episodeOf(v: FleetVerdict): string | null {
  if (v.flags.includes('tick-stale')) return `stale@${v.tickAt ?? 'never'}`;
  if (v.flags.includes('watch-only')) return `watch@${v.breachSince ?? '?'}`;
  return null;
}

/** Rungs for an episode: a stopped tick starts with a refire (when a trigger can be fired) · then the owner card · then ✋ L0. */
export function rungsOf(v: FleetVerdict): HealAction[] {
  return v.flags.includes('tick-stale') && v.trigger ? ['refire', 'owner-card', 'l0-hand'] : ['owner-card', 'l0-hand'];
}

/** What to do this tick: per flagged agent the next rung of its episode (rung_wait_min after the last one) · ≤ heal_max_per_tick
 *  in fleet order (watch-only first, then stopped ticks). Episodes that ended are dropped from `m.ladder` (mutates `m`). */
export function healPlan(verdicts: readonly FleetVerdict[], m: AuditMemory, p: FleetPolicy, now: Date): HealStep[] {
  const live = new Set<string>(); const out: HealStep[] = [];
  const order = [...verdicts].sort((a, b) => Number(b.flags.includes('watch-only')) - Number(a.flags.includes('watch-only')) || a.id.localeCompare(b.id));
  for (const v of order) {
    const ep = episodeOf(v); if (!ep) continue;
    live.add(v.id);
    const step = m.ladder[v.id]?.episode === ep ? m.ladder[v.id]! : null;
    const rungs = rungsOf(v); const next = step ? step.rung + 1 : 0;
    if (next >= rungs.length) continue;
    if (step && now.getTime() - Date.parse(step.at) < p.rungWaitMin * MINUTE_MS) continue;
    if (out.length >= p.healMaxPerTick) continue;
    out.push({ action: rungs[next]!, target: v.id, why: whyLine(v), episode: ep, rung: next });
  }
  for (const id of Object.keys(m.ladder)) if (!live.has(id)) delete m.ladder[id];
  return out;
}

/** Record that a rung ran (the executor calls it after the door answered ok). Mutates `m`. */
export function noteRung(m: AuditMemory, s: HealStep, now: Date): void { m.ladder[s.target] = { episode: s.episode, rung: s.rung, at: now.toISOString() }; }

const h1 = (min: number | null) => (min === null ? '?' : min >= 60 ? `${Math.floor(min / 60)}h${Math.round(min % 60) ? `${Math.round(min % 60)}m` : ''}` : `${Math.round(min)}분`);
export function whyLine(v: FleetVerdict): string {
  const parts: string[] = [];
  if (v.flags.includes('tick-stale')) parts.push(`틱 정지 ${v.tickAgeMin === null ? '(틱 없음)' : h1(v.tickAgeMin)}`);
  if (v.flags.includes('watch-only')) parts.push(`보기만 함 — KPI 위반 ${h1(v.breachMin)} · 행동 0 (거절 ${v.refused} · 실패 ${v.failed})`);
  if (v.topRefusal) parts.push(`가장 많은 거절: ${v.topRefusal}`);
  return parts.join(' · ');
}

// ── red (≥ red_watch_only_min watch-only agents for ≥ red_after_min) ────────────────────────────────────────────────
/** Advance the red episode with this tick's count. `due` = red now and not yet notified for this episode. Mutates `m`. */
export function redStep(m: AuditMemory, watchOnly: number, p: FleetPolicy, now: Date): { red: boolean; due: boolean; sinceMin: number | null } {
  if (watchOnly < p.redWatchOnlyMin) { m.redSince = null; return { red: false, due: false, sinceMin: null }; }
  m.redSince ??= now.toISOString();
  const sinceMin = (now.getTime() - Date.parse(m.redSince)) / MINUTE_MS;
  const red = sinceMin >= p.redAfterMin;
  return { red, due: red && m.redNotified !== m.redSince, sinceMin };
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const KPI_KO: Readonly<Record<KpiState, string>> = { ok: '충족', breach: '위반', unknown: '모름', missing: 'KPI 없음' };
const FLAG_KO: Readonly<Record<FleetFlag, string>> = { 'tick-stale': '틱 정지', 'kpi-missing': 'KPI 없음', 'watch-only': '보기만 함', 'false-green': '거짓 초록' };
export const flagKo = (f: FleetFlag): string => FLAG_KO[f];

/** The ledger table (markdown) — one row per agent: 틱 · KPI · 위반 · 행동/실패/거절 · 교훈 · 6축 ⊕ 추세 · 판정. */
export function ledgerTable(verdicts: readonly FleetVerdict[], base: Readonly<Record<string, number>>, at: string): string {
  const rows = verdicts.map(v => `| ${v.id}${v.level === 'off' ? ' (off)' : ''} | ${v.tickAgeMin === null ? '—' : `${Math.round(v.tickAgeMin)}분`}${v.tickError ? ' ⚠' : ''} | ${KPI_KO[v.kpiState]}${v.breachMin !== null ? ` ${h1(v.breachMin)}` : ''} | ${v.acted}/${v.failed}/${v.refused} | ${v.lessons} | ${v.score.total} ${trendOf(base[v.id], v.score.total)} | ${v.flags.length ? v.flags.map(flagKo).join(' · ') : '정상'} |`);
  return [`# 감독 감사 ${at}`, '', '| 감독 | 틱 | KPI | 행동/실패/거절 (창) | 교훈 | 6축 (추세) | 판정 |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
}

/** The hourly summary (Korean · ≤ summary_lines_max lines). */
export function summaryLines(verdicts: readonly FleetVerdict[], base: Readonly<Record<string, number>>, ctx: { readonly hour: string; readonly red: boolean; readonly redSinceMin: number | null; readonly ledger: string; readonly actsLastHour: string }, p: FleetPolicy): string[] {
  const n = (f: FleetFlag) => verdicts.filter(v => v.flags.includes(f));
  const avg = verdicts.length ? Math.round(verdicts.reduce((a, v) => a + v.score.total, 0) / verdicts.length) : null;
  const prevIds = verdicts.filter(v => typeof base[v.id] === 'number');
  const prevAvg = prevIds.length ? Math.round(prevIds.reduce((a, v) => a + base[v.id]!, 0) / prevIds.length) : null;
  const low = [...verdicts].sort((a, b) => a.score.total - b.score.total)[0];
  const watch = n('watch-only');
  const lines = [
    `[감독 감사 ${ctx.hour.slice(11, 13)}시 UTC] 루프 에이전트 ${verdicts.length} · 보기만 함 ${watch.length} · 거짓 초록 ${n('false-green').length} · 틱 정지 ${n('tick-stale').length} · KPI 없음 ${n('kpi-missing').length}`,
    `6축 평균 ${avg ?? '?'}${avg !== null ? ` (${trendOf(prevAvg, avg)})` : ''}${low ? ` · 최저 ${low.id} ${low.score.total}` : ''}`,
    ...(watch.length ? [`보기만 함: ${watch.slice(0, 3).map(v => `${v.id} 위반 ${h1(v.breachMin)}${v.topRefusal ? ` («${v.topRefusal.slice(0, 60)}»)` : ''}`).join(' · ')}`] : []),
    `조치(지난 창): ${ctx.actsLastHour}`,
    ctx.red ? `🔴 빨강 — 보기만 함 ${watch.length} 이 ${h1(ctx.redSinceMin)} 지속` : '빨강 아님',
    `원장: ${ctx.ledger}`,
  ];
  return lines.slice(0, Math.max(1, p.summaryLinesMax));
}
