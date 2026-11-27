// LOOP-AGENT v3 «smartness» — reflect · plan · learn-knowhow (LOOP-AGENT-V3-SMART · 대표 11-27 12:5x «v3 = 스마트함 · 지금 시작»).
//
// S: v2 loop agents are faithful machines: they speak / mail on every breach and never look back. Measured 11-27: the
//    supervisors and loop agents mail, the receivers act on 0 of them, 9 agents are silent and OP takes 83 mails/h.
// C: an agent that keeps repeating an action nobody acts on is not «responsible», it is noise. Smartness starts with the
//    cheapest loop: look at what my last actions did (did the receiver act? did my KPI move?) → when the same «nobody acted»
//    repeats, write it down once (a lesson card) → choose the next action from what the YAML lets me do, using the KPI gap
//    and the lessons — not the same action again.
// Q: what is the smallest runtime that does this for ANY agent.yaml, deterministic first, LLM only when it is a toss-up?
// A: three hook nodes the agent.yaml declares (`reflect` · `plan` · `learn-knowhow`, optional = fail-open) with every number
//    under `policies:` and every choice under `actions:`. One session per tick:
//      begin()  — reflect: resolve the outcome of past actions (acted | unacted after the grace) from the agent's ports (mail
//                 state / fed facts) or from its own KPI (moved toward target) · patterns «N unacted in a row» per
//                 (intent, action, receiver) → learn: one lesson per pattern key (deduped · capped) · cleared when the
//                 receiver acts again · promoted to the knowhow pack after N reflection windows (capped · marker-deduped).
//      choose() — plan: the YAML default action unless a lesson says it does not work for this receiver; then score every
//                 declared action = Σ KPI gap it serves × its act rate (Laplace · lesson penalty) − cost. Top two within the
//                 ambiguity margin → the LLM judgment node through the router (budget-capped); router down / bad answer →
//                 the deterministic top, recorded as a fallback.
//      record() — every action taken (or folded) is an action row: the next reflection judges it.
//      save()   — <agentHome>/v3/{actions.jsonl, lessons.json, state.json}.
//
// Slice 2 (LOOP-AGENT-V3-SMART-2 · 대표 11-27 «회고도 되고, 영혼 있고, 더 발전할 수 있는 형태»): the nine supervisors run the same
//    hooks on the v2 shell (runtime.ts · no per-agent code): an action's own failure is an «unacted» row with its CAUSE · the
//    same action failing lesson_repeat_min× in a row on one subject kind → one lesson ⊕ one knowhow line with the cause ·
//    shellPlan() reads that knowhow next tick and runs the agent.yaml `fallback:` · the soul block's do_not refuses an action
//    it names · human memory rows («기억해» · knowhow add · L0 lessons) are cited in the plan · retro() every retro_every_h.
// 세 얼굴: 관측 = Reflection (gaps · stats · patterns) ⊕ the choice's `why` in the agent's report / `eln loop agent lint` /
//          판단 근거 = YAML policies ⊕ actions ⊕ lessons (no number in this file) /
//          수복과 인계 = a protected action (security-4 · L0 policy mail) is never planned · knowhow promotion is capped and
//          carries `[v3:<key>]` so a second promotion of the same lesson is impossible · every hook is fail-open.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kpiOk, HOUR_MS, MINUTE_MS } from '../../kit/kpi/index.js';
import type { AgentKpi, AgentSoul, CompiledAgent } from './agent-yaml.js';

export { HOOK_POLICIES } from './node-kinds.js';

export type ActionChannel = 'mail' | 'channel' | 'self' | 'none';
export interface SmartAction {
  readonly id: string;
  readonly channel: ActionChannel;
  /** `receiver` = the intent's receiver · `l0` = the agent's L0 (org duty) · `self` / `none` = nobody to act. */
  readonly target: 'receiver' | 'l0' | 'self' | 'none';
  readonly serves: readonly string[];
  readonly cost: number;
  readonly isDefault: boolean;
  /** LOOP-AGENT-V3-SMART-2: what the shell plan runs instead once a lesson / knowhow line says this action keeps failing. */
  readonly fallback?: string;
}
export interface SmartPolicy {
  readonly graceMin: number; readonly repeatMin: number; readonly windowMin: number;
  readonly margin: number; readonly penalty: number; readonly llmPerHour: number;
  readonly lessonCap: number; readonly promoteMin: number; readonly knowhowCap: number;
}
export interface SmartConfig {
  readonly agent: string;
  readonly reflect: boolean; readonly plan: boolean; readonly learn: boolean;
  /** LOOP-AGENT-V3-SMART-2: the retro hook and its cadence (hours) · the soul block plan and judge load. */
  readonly retro: boolean; readonly retroEveryH: number;
  readonly soul: AgentSoul | null;
  readonly actions: readonly SmartAction[];
  readonly kpis: readonly AgentKpi[];
  readonly p: SmartPolicy;
  /** min(plan_llm_per_hour, budget.llm_turns_per_hour) — 0 = deterministic only. */
  readonly llmPerHour: number;
}

/** The smart config of a linted agent.yaml, or null when it declares none of the three hook nodes (plain v2 behaviour). */
export function smartConfig(c: CompiledAgent): SmartConfig | null {
  const has = (k: string) => c.body.nodes.some(n => n.kind === k);
  const reflect = has('reflect'); const plan = has('plan'); const learn = has('learn-knowhow'); const retroHook = has('retro');
  if (!reflect && !plan && !learn && !retroHook) return null;
  const n = (k: string, dflt: number) => (Object.hasOwn(c.policies, k) ? c.policies[k]! : dflt); // lint guarantees the keys of the hooks present
  const p: SmartPolicy = {
    graceMin: n('act_grace_min', 0), repeatMin: n('lesson_repeat_min', Number.POSITIVE_INFINITY), windowMin: n('reflect_window_min', 60),
    margin: n('plan_ambiguity_margin', 0), penalty: n('unacted_penalty', 1), llmPerHour: n('plan_llm_per_hour', 0),
    lessonCap: n('lesson_cap', 0), promoteMin: n('knowhow_promote_min', Number.POSITIVE_INFINITY), knowhowCap: n('knowhow_cap', 0),
  };
  return { agent: c.id, reflect, plan, learn, retro: retroHook, retroEveryH: n('retro_every_h', Number.POSITIVE_INFINITY), soul: c.soul ?? null,
    actions: c.actions, kpis: c.kpis, p, llmPerHour: Math.max(0, Math.min(p.llmPerHour, c.budget.llmTurnsPerHour)) };
}

// ── memory ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActionRow {
  readonly at: string;
  /** Why the agent acted (`breach:lands` · `propose-narrow`) — the plan's unit. */
  readonly intent: string;
  readonly action: string;
  /** Who must act (seat · `channel` · `self`). */
  readonly to: string;
  readonly key: string;
  /** mail id / channel ref — the outcome port reads it. */
  readonly ref?: string;
  /** KPI this action is meant to move and its raw value when taken (outcome = moved toward target). */
  readonly kpi?: string;
  readonly base?: number | null;
  /** LOOP-AGENT-V3-SMART-2: why the action failed (the failure line, the target id stripped) — the lesson ⊕ knowhow carry it. */
  readonly cause?: string;
  outcome?: 'acted' | 'unacted';
  resolvedAt?: string;
}
export interface SmartLesson {
  readonly key: string; readonly intent: string; readonly action: string; readonly to: string;
  text: string; streak: number; hits: number; firstAt: string; lastAt: string;
  /** Reflection windows (floor(t / reflect_window_min)) in which the pattern held — promotion counts these. */
  windows: number[];
  status: 'active' | 'cleared';
  promoted?: string;
  /** The last failure cause of the pattern (LOOP-AGENT-V3-SMART-2). */
  cause?: string;
}
export interface SmartState { llmTurns: number[]; reflections: number; /** knowhow markers this agent promoted (knowhow_cap is a total). */ promoted?: string[]; /** retro clock (LOOP-AGENT-V3-SMART-2). */ lastRetroAt?: string }
export interface SmartStore {
  readonly root: string;
  actions(): ActionRow[]; writeActions(rows: readonly ActionRow[]): void;
  lessons(): SmartLesson[]; writeLessons(rows: readonly SmartLesson[]): void;
  state(): SmartState; writeState(s: SmartState): void;
}
const ROW_KEEP = 500; const ROW_KEEP_MS = 7 * 24 * HOUR_MS;
const atomic = (p: string, text: string) => { const t = `${p}.${process.pid}.tmp`; writeFileSync(t, text); renameSync(t, p); };
const readJson = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return d; } };

/** `<agentHome>/v3/` — separate from the v2 cases/lessons so the v2 ledgers (and the LA3 equivalence) stay byte-identical. */
export function fileSmartStore(agentHome: string): SmartStore {
  const root = join(agentHome, 'v3');
  const p = (f: string) => join(root, f);
  const ensure = () => mkdirSync(root, { recursive: true });
  return {
    root,
    actions() {
      if (!existsSync(p('actions.jsonl'))) return [];
      return readFileSync(p('actions.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as ActionRow]; } catch { return []; } });
    },
    writeActions(rows) { ensure(); atomic(p('actions.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); },
    lessons() { return readJson<SmartLesson[]>(p('lessons.json'), []); },
    writeLessons(rows) { ensure(); atomic(p('lessons.json'), JSON.stringify(rows, null, 1)); },
    state() { return { llmTurns: [], reflections: 0, ...readJson<Partial<SmartState>>(p('state.json'), {}) }; },
    writeState(s) { ensure(); atomic(p('state.json'), JSON.stringify(s)); },
  };
}

// ── reflect ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KpiReading { readonly name: string; readonly value: number | null }
export interface ActStat { intent: string; action: string; to: string; sent: number; acted: number; unacted: number; pending: number; streak: number; cause?: string }
export interface Pattern { readonly key: string; readonly intent: string; readonly action: string; readonly to: string; readonly streak: number; readonly cause?: string }
export interface Reflection {
  readonly at: string;
  /** Normalized KPI gap 0..1 (0 = target met · unknown = 0). */
  readonly gaps: Readonly<Record<string, number>>;
  readonly stats: readonly ActStat[];
  readonly patterns: readonly Pattern[];
  readonly resolved: { acted: number; unacted: number };
}
/** Did the receiver act on this row? true / false / null = cannot tell (mail state · fed facts). */
export type OutcomePort = (row: ActionRow) => boolean | null;

const statKey = (intent: string, action: string, to: string) => `${intent}|${action}|${to}`;
export const lessonKey = (intent: string, action: string, to: string): string => `unacted:${intent}:${action}:${to}`;

export function kpiGaps(kpis: readonly AgentKpi[], readings: readonly KpiReading[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of kpis) {
    const v = readings.find(r => r.name === k.name)?.value ?? null;
    const ok = kpiOk({ target: k.target, dir: k.dir }, v);
    out[k.name] = ok === false && v !== null ? Math.min(1, Math.abs(v - k.target) / Math.max(Math.abs(k.target), 1)) : 0;
  }
  return out;
}

/** A row tied to a KPI: acted = the KPI is met now or moved toward its target since the row (raw values). */
function kpiOutcome(row: ActionRow, kpis: readonly AgentKpi[], readings: readonly KpiReading[]): boolean | null {
  if (!row.kpi) return null;
  const k = kpis.find(x => x.name === row.kpi); const v = readings.find(r => r.name === row.kpi)?.value ?? null;
  if (!k || v === null) return null;
  if (kpiOk({ target: k.target, dir: k.dir }, v)) return true;
  if (row.base === null || row.base === undefined) return null;
  return k.dir === 'at_least' ? v > row.base : v < row.base;
}

/** Resolve outcomes (mutates rows) and compute stats ⊕ «N unacted in a row» patterns. */
export function reflect(i: { now: Date; cfg: SmartConfig; readings: readonly KpiReading[]; rows: ActionRow[]; outcome?: OutcomePort }): Reflection {
  const nowMs = i.now.getTime(); const at = i.now.toISOString();
  let acted = 0; let unacted = 0;
  for (const r of i.rows) {
    if (r.outcome) continue;
    const age = nowMs - Date.parse(r.at);
    if (!Number.isFinite(age) || age < 0) continue;
    let o: boolean | null = null;
    try { o = i.outcome?.(r) ?? null; } catch { o = null; }
    if (o === null) o = kpiOutcome(r, i.cfg.kpis, i.readings);
    if (o === true) { r.outcome = 'acted'; r.resolvedAt = at; acted++; }
    else if (o === false && age >= i.cfg.p.graceMin * MINUTE_MS) { r.outcome = 'unacted'; r.resolvedAt = at; unacted++; }
  }
  const stats = new Map<string, ActStat>();
  for (const r of i.rows) {
    const k = statKey(r.intent, r.action, r.to);
    const s = stats.get(k) ?? { intent: r.intent, action: r.action, to: r.to, sent: 0, acted: 0, unacted: 0, pending: 0, streak: 0 };
    s.sent++;
    if (r.outcome === 'acted') { s.acted++; s.streak = 0; } else if (r.outcome === 'unacted') { s.unacted++; s.streak++; if (r.cause) s.cause = r.cause; } else s.pending++;
    stats.set(k, s);
  }
  const patterns = [...stats.values()].filter(s => s.streak >= i.cfg.p.repeatMin)
    .map(s => ({ key: lessonKey(s.intent, s.action, s.to), intent: s.intent, action: s.action, to: s.to, streak: s.streak, ...(s.cause ? { cause: s.cause } : {}) }));
  return { at, gaps: kpiGaps(i.cfg.kpis, i.readings), stats: [...stats.values()], patterns, resolved: { acted, unacted } };
}

// ── learn ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LearnResult { lessons: SmartLesson[]; created: string[]; cleared: string[]; evicted: string[]; promote: SmartLesson[] }

/** One lesson per pattern key (dedupe) · cleared when the same (intent, action, receiver) is acted on again · capped (oldest
 *  evicted) · promotion candidates = active, not promoted, held in ≥ knowhow_promote_min windows, within knowhow_cap. */
export function learn(i: { now: Date; cfg: SmartConfig; reflection: Reflection; lessons: readonly SmartLesson[] }): LearnResult {
  const at = i.now.toISOString(); const win = Math.floor(i.now.getTime() / (Math.max(1, i.cfg.p.windowMin) * MINUTE_MS));
  const rows = i.lessons.map(l => ({ ...l, windows: [...l.windows] }));
  const created: string[] = []; const cleared: string[] = []; const evicted: string[] = [];
  for (const pat of i.reflection.patterns) {
    const fb = i.cfg.actions.find(a => a.id === pat.action)?.fallback;
    // LOOP-AGENT-V3-SMART-2: a failure (the action itself returned not-ok) carries its cause — the lesson says why, and what next
    const text = pat.cause
      ? `${pat.action} 이 «${pat.intent}» 에 ${pat.streak}회 연속 실패 — 원인: ${pat.cause.slice(0, 160)} · ${fb ? `다음부터 ${fb} 로 바꾼다(agent.yaml fallback)` : '같은 행동을 되풀이하기 전에 원인을 먼저 고친다(L0)'}`
      : `${pat.to} 가 «${pat.intent}» 에 대한 ${pat.action} 에 ${pat.streak}회 연속 반응 없음 — 같은 행동을 되풀이하지 말고 다른 행동을 고른다`;
    const l = rows.find(x => x.key === pat.key);
    if (!l) { rows.push({ key: pat.key, intent: pat.intent, action: pat.action, to: pat.to, text, streak: pat.streak, hits: 1, firstAt: at, lastAt: at, windows: [win], status: 'active', ...(pat.cause ? { cause: pat.cause } : {}) }); created.push(pat.key); continue; }
    if (l.status === 'cleared') l.status = 'active';
    l.streak = pat.streak; l.hits++; l.lastAt = at; l.text = text; if (pat.cause) l.cause = pat.cause;
    if (!l.windows.includes(win)) l.windows = [...l.windows, win].slice(-20);
  }
  for (const s of i.reflection.stats) {
    const l = rows.find(x => x.key === lessonKey(s.intent, s.action, s.to));
    if (l?.status === 'active' && s.streak === 0 && s.acted > 0) { l.status = 'cleared'; l.lastAt = at; cleared.push(l.key); }
  }
  const active = rows.filter(l => l.status === 'active').sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt));
  const drop = new Set(active.slice(0, Math.max(0, active.length - i.cfg.p.lessonCap)).map(l => l.key));
  const cleanedOut = rows.filter(l => l.status === 'cleared').slice(0, Math.max(0, rows.filter(l => l.status === 'cleared').length - i.cfg.p.lessonCap));
  for (const l of cleanedOut) drop.add(l.key);
  const kept = rows.filter(l => { if (drop.has(l.key)) { evicted.push(l.key); return false; } return true; });
  const promotedSoFar = kept.filter(l => l.promoted).length;
  const promote = i.cfg.learn ? kept.filter(l => l.status === 'active' && !l.promoted && l.windows.length >= i.cfg.p.promoteMin)
    .slice(0, Math.max(0, i.cfg.p.knowhowCap - promotedSoFar)) : [];
  return { lessons: kept, created, cleared, evicted, promote };
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Intent {
  readonly intent: string;
  /** Who the default action addresses. */
  readonly to: string;
  /** KPIs this intent is about (default: every KPI the action serves). */
  readonly kpis?: readonly string[];
}
export interface Choice {
  readonly action: string;
  /** Who must act for the chosen action (receiver · L0 seat · self). */
  readonly to: string;
  readonly why: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly lesson: string | null;
  /** Top two within the ambiguity margin (the LLM judgment node's question). */
  readonly ambiguous: readonly [string, string] | null;
  readonly judgedBy: 'default' | 'score' | 'llm' | 'fallback';
  readonly fallback?: 'router-unavailable' | 'over-budget' | 'llm-error' | 'llm-invalid';
  readonly model?: string;
}

const targetOf = (a: SmartAction, it: Intent, l0: string): string => (a.target === 'receiver' ? it.to : a.target === 'l0' ? l0 : a.target === 'self' ? 'self' : 'none');

/** Deterministic plan for one intent. `l0` = the seat that holds the agent's L0 now. */
export function plan(i: { cfg: SmartConfig; reflection: Reflection; lessons: readonly SmartLesson[]; intent: Intent; l0: string }): Choice {
  const { cfg, intent: it } = i;
  const def = cfg.actions.find(a => a.isDefault) ?? cfg.actions[0];
  if (!def) return { action: 'none', to: 'none', why: 'no actions declared', scores: {}, lesson: null, ambiguous: null, judgedBy: 'default' };
  const active = (a: SmartAction) => i.lessons.find(l => l.status === 'active' && l.key === lessonKey(it.intent, a.id, targetOf(a, it, i.l0))) ?? null;
  const defLesson = active(def);
  // Prior = the YAML default. Evidence (a lesson that the default does not work for this receiver) is what moves the plan.
  if (!cfg.plan || !defLesson) return { action: def.id, to: targetOf(def, it, i.l0), why: defLesson ? 'plan node absent — default' : 'default (no lesson against it)', scores: {}, lesson: null, ambiguous: null, judgedBy: 'default' };
  const scores: Record<string, number> = {};
  for (const a of cfg.actions) {
    const to = targetOf(a, it, i.l0);
    const s = i.reflection.stats.find(x => x.intent === it.intent && x.action === a.id && x.to === to);
    let eff = s ? (s.acted + 1) / (s.acted + s.unacted + 2) : 0.5; // Laplace: unseen = 0.5
    if (active(a)) eff *= cfg.p.penalty;
    const kp = it.kpis ?? a.serves;
    const gap = a.serves.filter(k => kp.includes(k)).reduce((m, k) => m + (i.reflection.gaps[k] ?? 0), 0);
    scores[a.id] = Math.round((gap * eff - a.cost) * 1e6) / 1e6;
  }
  const ranked = [...cfg.actions].sort((a, b) => scores[b.id]! - scores[a.id]! || (a.isDefault ? -1 : b.isDefault ? 1 : 0) || a.id.localeCompare(b.id));
  const top = ranked[0]!; const second = ranked[1];
  const ambiguous: [string, string] | null = second && scores[top.id]! - scores[second.id]! <= cfg.p.margin ? [top.id, second.id] : null;
  return { action: top.id, to: targetOf(top, it, i.l0), why: `lesson ${defLesson.key} (${defLesson.streak}× unacted) → ${top.id} score ${scores[top.id]}${second ? ` vs ${second.id} ${scores[second.id]}` : ''}`,
    scores, lesson: defLesson.key, ambiguous, judgedBy: 'score' };
}

/** The router port for the LLM judgment node (same shape as the voice LLM · resolveRoleLlm behind it in live). */
export interface Router { complete(system: string, user: string): Promise<{ text: string; model: string }> }

/** LLM judgment node: only for an ambiguous choice · budget-capped · any failure → the deterministic top (recorded). */
export async function judge(i: { cfg: SmartConfig; choice: Choice; intent: Intent; l0: string; router: Router | null; state: SmartState; now: Date; facts?: string }): Promise<Choice> {
  const c = i.choice;
  if (!c.ambiguous) return c;
  if (!i.router) return { ...c, judgedBy: 'fallback', fallback: 'router-unavailable' };
  const nowMs = i.now.getTime();
  i.state.llmTurns = i.state.llmTurns.filter(t => nowMs - t < HOUR_MS);
  if (i.state.llmTurns.length >= i.cfg.llmPerHour) return { ...c, judgedBy: 'fallback', fallback: 'over-budget' };
  i.state.llmTurns.push(nowMs);
  const [a, b] = c.ambiguous;
  const soul = i.cfg.soul ? `\nPurpose: ${i.cfg.soul.purpose}\nValues: ${i.cfg.soul.values.join('; ')}\nNever: ${i.cfg.soul.doNot.join('; ')}` : '';
  const system = `You are the planning judgment of loop agent ${i.cfg.agent}. Answer with exactly one action id from the list, nothing else.${soul}`;
  const user = `intent: ${i.intent.intent} · receiver: ${i.intent.to}\ncandidates: ${a}, ${b}\nscores: ${JSON.stringify(c.scores)}\nwhy: ${c.why}${i.facts ? `\nfacts: ${i.facts.slice(0, 800)}` : ''}`;
  try {
    const r = await i.router.complete(system, user);
    const pick = /[a-z][a-z0-9-]*/u.exec(r.text.trim().toLowerCase())?.[0];
    const act = pick === a || pick === b ? i.cfg.actions.find(x => x.id === pick)! : null;
    if (!act) return { ...c, judgedBy: 'fallback', fallback: 'llm-invalid', model: r.model };
    return { ...c, action: act.id, to: targetOf(act, i.intent, i.l0), why: `${c.why} · LLM (${r.model}) → ${act.id}`, judgedBy: 'llm', model: r.model };
  } catch { return { ...c, judgedBy: 'fallback', fallback: 'llm-error' }; }
}

// ── session (one tick) ───────────────────────────────────────────────────────────────────────────────────────────

/** Knowhow sink (the agent's v2 pack: fileAgentMemory.knowhow/addKnowhow). */
export interface KnowhowSink { text(): string; add(item: { title: string; situation: string; prescription: string; kind?: string }, by: string, now: Date): string }
export interface SmartSession {
  readonly cfg: SmartConfig;
  readonly reflection: Reflection;
  readonly learned: Omit<LearnResult, 'lessons'> & { promoted: string[] };
  readonly lessons: readonly SmartLesson[];
  choose(intent: Intent): Choice;
  chooseJudged(intent: Intent, router: Router | null, facts?: string): Promise<Choice>;
  record(row: Omit<ActionRow, 'at'> & { at?: string }): void;
  save(): void;
}

export const lessonMarker = (key: string): string => `[v3:${createHash('sha256').update(key).digest('hex').slice(0, 10)}]`;

/** begin = reflect → learn → promote (when the hooks are present). Fail-open: a broken store reads as empty. */
export function beginSmart(i: { cfg: SmartConfig; store: SmartStore; now: Date; readings: readonly KpiReading[]; outcome?: OutcomePort; l0: string; knowhow?: KnowhowSink | null }): SmartSession {
  const { cfg, store, now } = i;
  const nowMs = now.getTime();
  const rows = store.actions().filter(r => nowMs - Date.parse(r.at) <= ROW_KEEP_MS).slice(-ROW_KEEP);
  const state = store.state();
  const reflection = cfg.reflect ? reflect({ now, cfg, readings: i.readings, rows, ...(i.outcome ? { outcome: i.outcome } : {}) })
    : { at: now.toISOString(), gaps: kpiGaps(cfg.kpis, i.readings), stats: [], patterns: [], resolved: { acted: 0, unacted: 0 } };
  const l = learn({ now, cfg, reflection, lessons: store.lessons() });
  const promoted: string[] = [];
  if (i.knowhow) {
    let text = ''; try { text = i.knowhow.text(); } catch { text = ''; }
    // knowhow_cap is a total per agent: markers already in the pack ⊕ the ones this store promoted (an evicted lesson still counts)
    const done = new Set([...(state.promoted ?? []), ...(text.match(/\[v3:[0-9a-f]{10}\]/gu) ?? [])]);
    for (const p of l.promote) {
      const mark = lessonMarker(p.key);
      const row = l.lessons.find(x => x.key === p.key)!;
      if (text.includes(mark) || done.has(mark)) { row.promoted = 'already'; continue; }
      if (done.size >= cfg.p.knowhowCap) break;
      const fb = cfg.actions.find(a => a.id === p.action)?.fallback;
      const item = p.cause
        ? { title: `${mark} ${p.action} 반복 실패 (${p.intent})`, situation: `${p.action} 이 «${p.intent}» 에 ${p.streak}회 연속 실패 — 원인: ${p.cause.slice(0, 200)}`,
            prescription: fb ? `«${p.intent}» 에는 ${p.action} 대신 ${fb} 를 쓴다(plan 이 이 줄을 읽고 바꾼다) · ${fb} 가 그 대상에서 실패하면 원래 행동으로 돌아가고, ${p.action} 이 다시 통하면 교훈은 풀린다` : `같은 대상에 ${p.action} 을 되풀이하기 전에 원인을 고친다 — 원인 칸은 L0 에`, kind: 'warning' }
        : { title: `${mark} ${p.to} — ${p.action} 무반응 (${p.intent})`, situation: p.text, prescription: `«${p.intent}» 에서 ${p.to} 에게 ${p.action} 대신 plan 이 고른 다른 행동(agent.yaml actions)을 쓴다 · 반응이 돌아오면 교훈은 저절로 풀린다`, kind: 'heuristic' };
      try {
        row.promoted = i.knowhow.add(item, cfg.agent.toUpperCase(), now);
        promoted.push(row.promoted); text += `\n${mark}`; done.add(mark); state.promoted = [...done].slice(-200);
      } catch { /* fail-open: try again next window */ }
    }
  }
  const lessons = l.lessons;
  state.reflections++;
  const session: SmartSession = {
    cfg, reflection, lessons,
    learned: { created: l.created, cleared: l.cleared, evicted: l.evicted, promote: l.promote, promoted },
    choose: intent => plan({ cfg, reflection, lessons, intent, l0: i.l0 }),
    chooseJudged: async (intent, router, facts) => judge({ cfg, choice: plan({ cfg, reflection, lessons, intent, l0: i.l0 }), intent, l0: i.l0, router, state, now, ...(facts ? { facts } : {}) }),
    record(row) { rows.push({ ...row, at: row.at ?? now.toISOString() }); },
    save() { try { store.writeActions(rows.slice(-ROW_KEEP)); store.writeLessons(lessons); store.writeState(state); } catch { /* fail-open */ } },
  };
  return session;
}

// ── shell plan (LOOP-AGENT-V3-SMART-2 · the nine supervisors on the v2 shell) ────────────────────────────────────────
// The body plans (tier ② · deterministic). The shell plan then reads the agent's memory: a knowhow line this agent learned
// («action X keeps failing on subject kind K · cause C») with a lesson still active and an agent.yaml `fallback:` → run the
// fallback instead · the soul's do_not refuses an action named there · every human row («기억해» · `knowhow add` · an L0
// lesson) is cited as a reason. Same function for every supervisor — the data (actions · fallback · soul) is in agent.yaml.

export interface ShellPlanned { readonly action: string; readonly target: string; readonly why: string; /** subject kind of the target (the lesson's intent) */ readonly kind: string }
export interface PlanLine {
  readonly action: string; readonly target: string; readonly why: string;
  /** The body's action this line replaced (fallback) — absent = the body's plan as is. */
  readonly from?: string;
  readonly cites: readonly string[];
  readonly by: 'body' | 'knowhow' | 'soul';
  /** true = not run (soul do_not). */
  readonly refused?: boolean;
}
export interface ShellPlan { readonly purpose: string; readonly lines: readonly PlanLine[]; /** human memory rows not tied to one line (latest first) */ readonly memory: readonly string[] }
/** One memory row the plan may cite (knowhow item K-… · lesson L-…). */
export interface MemoryRow { readonly id: string; readonly by: string; readonly text: string }

/** The subject kind the shell uses as the lesson intent (`<kind>` of the body's subject · `-` when the target is not a subject). */
export const shellIntent = (kind: string | undefined): string => kind || '-';
/** The failure line without the target id prefix (`<id>: why` → `why`) — the cause a lesson ⊕ knowhow line carry. */
export const failureCause = (line: string, target: string): string => {
  const bare = target.replace(/^[a-z-]+:/u, '');
  const pre = [target, bare].find(t => t && line.startsWith(`${t}:`));
  return (pre ? line.slice(pre.length + 1) : line).trim().slice(0, 200);
};
const soulForbids = (soul: AgentSoul | null, action: string): string | null => soul?.doNot.find(d => d.split(/[\s·,;()]+/u).includes(action)) ?? null;
const mentions = (text: string, words: readonly string[]): boolean => words.some(w => w.length > 2 && text.includes(w));

export function shellPlan(i: {
  cfg: SmartConfig; planned: readonly ShellPlanned[]; lessons: readonly SmartLesson[];
  /** knowhow item id (K-…) holding this marker — null = not in the pack */
  knowhowId: (marker: string) => string | null;
  /** rows a person wrote (knowhow learned.md without a v3 marker · lessons from a seat) — newest last */
  human: readonly MemoryRow[];
  /** the fallback already failed on this exact target (then the body's action runs) */
  failedOn: (action: string, target: string) => boolean;
}): ShellPlan {
  const { cfg } = i; const used = new Set<string>(); const lines: PlanLine[] = [];
  for (const p of i.planned) {
    const key = lessonKey(shellIntent(p.kind), p.action, 'self');
    const lesson = i.lessons.find(l => l.key === key) ?? null;
    const kid = i.knowhowId(lessonMarker(key));
    const fb = cfg.actions.find(a => a.id === p.action)?.fallback;
    const cites: string[] = [];
    let line: PlanLine = { action: p.action, target: p.target, why: p.why, cites, by: 'body' };
    if (kid) cites.push(`${kid}(${cfg.agent.toUpperCase()}) ${p.action} 반복 실패${lesson?.cause ? ` — ${lesson.cause.slice(0, 80)}` : ''}`);
    if (cfg.plan && kid && lesson?.status !== 'cleared' && fb) {
      const no = soulForbids(cfg.soul, fb);
      if (no) cites.push(`soul.do_not «${no}» → ${fb} 안 씀`);
      else if (i.failedOn(fb, p.target)) cites.push(`${fb} 가 이 대상에서 이미 실패 → 원래 행동`);
      else line = { action: fb, target: p.target, from: p.action, by: 'knowhow', cites,
        why: `${kid}: ${p.action} 이 «${p.kind}» 에 ${lesson?.streak ?? cfg.p.repeatMin}회 연속 실패(원인: ${(lesson?.cause ?? '?').slice(0, 100)}) → ${fb} · ${p.why}` };
    }
    const no = soulForbids(cfg.soul, line.action);
    if (no) line = { ...line, by: 'soul', refused: true, why: `soul.do_not «${no}» — ${line.action} 은 하지 않는다 · ${line.why}` };
    for (const h of i.human) if (mentions(h.text, [p.action, p.kind, line.action, p.target])) { cites.push(`${h.id}(${h.by}) ${h.text.slice(0, 100)}`); used.add(h.id); }
    lines.push(line);
  }
  const memory = [...i.human].reverse().filter(h => !used.has(h.id)).slice(0, 3).map(h => `${h.id}(${h.by}) ${h.text.slice(0, 120)}`);
  return { purpose: cfg.soul?.purpose ?? '', lines, memory };
}

/** Rows a person wrote into this agent's memory: knowhow/learned.md items without a v3 marker ⊕ active lessons from a seat. */
export function humanMemory(i: { learnedText: string; lessons: readonly { id: string; text: string; from: string; status: string }[]; self: string }): MemoryRow[] {
  const out: MemoryRow[] = [];
  for (const block of i.learnedText.split(/^(?=##\s+K-)/mu)) {
    const id = /^##\s+(K-[A-Z0-9-]+-\d+)/u.exec(block)?.[1];
    if (!id || /\[v3:[0-9a-f]{10}\]/u.test(block)) continue;
    const by = /^- 출처:\s*([^·\n]+)/mu.exec(block)?.[1]?.trim() ?? '?';
    if (by.toUpperCase() === i.self.toUpperCase()) continue;
    const title = /^##\s+K-[A-Z0-9-]+-\d+\s+(.*)$/mu.exec(block)?.[1] ?? '';
    const rx = /^- 처방\(힐링\):\s*(.*)$/mu.exec(block)?.[1] ?? '';
    out.push({ id, by, text: `${title}${rx ? ` — ${rx}` : ''}`.trim() });
  }
  for (const l of i.lessons) if (l.status === 'active' && !['OUTCOME', 'SILENCE', '?'].includes(l.from.toUpperCase())) out.push({ id: l.id, by: l.from, text: l.text });
  return out;
}

// ── retro (LOOP-AGENT-V3-SMART-2 «회고») ─────────────────────────────────────────────────────────────────────────────
// Every retro_every_h (and `eln loop agent <id> retro`): the journal window ⊕ the KPI window → a short entry — what worked ·
// what failed and why · one change to try. LLM 0 (facts only); stored in the agent's memory (<home>/v3/retros.jsonl ⊕ a
// `retro` case) and the voice quotes the latest one.

export interface RetroRow { readonly at: string; readonly status: 'acted' | 'failed' | 'refused'; readonly action: string; readonly target: string; readonly what: string }
export interface RetroEntry {
  readonly at: string; readonly agent: string; readonly windowH: number;
  readonly worked: string; readonly failed: string; readonly tryNext: string;
  readonly counts: { readonly acted: number; readonly failed: number; readonly refused: number };
  readonly kpi: { readonly name: string; readonly first: number | null; readonly last: number | null; readonly okTicks: number; readonly ticks: number } | null;
  readonly evidence: readonly string[];
}
const top = <T>(xs: readonly T[], key: (x: T) => string, n: number): Array<{ k: string; n: number; x: T }> => {
  const m = new Map<string, { k: string; n: number; x: T }>();
  for (const x of xs) { const k = key(x); const c = m.get(k); if (c) { c.n++; c.x = x; } else m.set(k, { k, n: 1, x }); }
  return [...m.values()].sort((a, b) => b.n - a.n || a.k.localeCompare(b.k)).slice(0, n);
};

export function retro(i: {
  agent: string; now: Date; windowH: number; rows: readonly RetroRow[];
  kpi: { readonly name: string; readonly target: number; readonly dir: 'at_least' | 'at_most' } | null;
  kpiHistory: readonly { at: string; v: number | null }[];
  lessons: readonly SmartLesson[]; actions: readonly SmartAction[];
}): RetroEntry {
  const since = i.now.getTime() - i.windowH * HOUR_MS;
  const rows = i.rows.filter(r => Date.parse(r.at) >= since);
  const hist = i.kpiHistory.filter(h => Date.parse(h.at) >= since);
  const acted = rows.filter(r => r.status === 'acted'); const failed = rows.filter(r => r.status === 'failed'); const refused = rows.filter(r => r.status === 'refused');
  const kv = hist.map(h => h.v).filter((v): v is number => v !== null);
  const okTicks = i.kpi ? kv.filter(v => kpiOk({ target: i.kpi!.target, dir: i.kpi!.dir }, v) === true).length : 0;
  const kpi = i.kpi ? { name: i.kpi.name, first: kv[0] ?? null, last: kv[kv.length - 1] ?? null, okTicks, ticks: kv.length } : null;
  const kpiTxt = kpi ? `KPI ${kpi.name} ${kpi.first ?? '?'}→${kpi.last ?? '?'} (목표 충족 ${kpi.okTicks}/${kpi.ticks} 틱)` : 'KPI 없음';
  const worked = `${acted.length ? top(acted, r => r.action, 3).map(t => `${t.k}×${t.n}`).join(' · ') : '행동 0'} · ${kpiTxt}`;
  const fails = top(failed, r => r.action, 2);
  const failedTxt = fails.length ? fails.map(t => `${t.k}×${t.n} — 원인 «${failureCause(t.x.what, t.x.target).slice(0, 100)}»`).join(' · ') : '실패 0';
  const live = i.lessons.filter(l => l.status === 'active' && l.cause).sort((a, b) => b.streak - a.streak);
  const l0 = live[0];
  const fb = l0 ? i.actions.find(a => a.id === l0.action)?.fallback : undefined;
  const breachMost = kpi && kpi.ticks > 0 && kpi.okTicks * 2 < kpi.ticks;
  const tryNext = l0 && fb ? `«${l0.intent}» 에는 ${l0.action} 대신 ${fb} — 원인 «${(l0.cause ?? '').slice(0, 80)}» 이 사라지는지 다음 창에서 본다`
    : l0 ? `${l0.action} 이 «${l0.intent}» 에 ${l0.streak}회 연속 실패(${(l0.cause ?? '').slice(0, 80)}) — 원인을 고치는 칸 또는 agent.yaml 정책 조정을 L0 에 올린다`
    : fails[0] ? `${fails[0].k} 실패 원인 «${failureCause(fails[0].x.what, fails[0].x.target).slice(0, 80)}» 을 다음 창에서 다시 본다`
    : breachMost ? `KPI 가 창의 절반 넘게 위반 — 행동을 늘리거나 L0 에 더 일찍 올린다(escalate_after_min)`
    : '지금대로 — 바꿀 근거가 없다';
  const evidence = [`journal ${rows.length} rows / ${i.windowH}h`, ...live.slice(0, 3).map(l => `lesson ${l.key}`), ...(hist.length ? [`kpi ${hist.length} ticks`] : [])];
  return { at: i.now.toISOString(), agent: i.agent, windowH: i.windowH, worked, failed: failedTxt, tryNext, counts: { acted: acted.length, failed: failed.length, refused: refused.length }, kpi, evidence };
}

export const retroLine = (e: RetroEntry): string => `회고 ${e.at.slice(5, 16)}Z (${e.windowH}h) — 잘 된 것: ${e.worked} · 안 된 것: ${e.failed} · 다음에 해 볼 것: ${e.tryNext}`;
const retroFile = (agentHome: string): string => join(agentHome, 'v3', 'retros.jsonl');
export function appendRetro(agentHome: string, e: RetroEntry): void { mkdirSync(join(agentHome, 'v3'), { recursive: true }); appendFileSync(retroFile(agentHome), `${JSON.stringify(e)}\n`); }
/** The latest retros (newest last) — the voice quotes the last one. Torn lines are skipped. */
export function readRetros(agentHome: string, limit = 5): RetroEntry[] {
  const p = retroFile(agentHome);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as RetroEntry]; } catch { return []; } }).slice(-limit);
}
/** Due when retro_every_h passed since the last retro. The first sight starts the clock (no retro over an empty window). */
export function retroDue(cfg: SmartConfig, state: SmartState, now: Date): boolean {
  if (!cfg.retro || !Number.isFinite(cfg.retroEveryH)) return false;
  if (!state.lastRetroAt) { state.lastRetroAt = now.toISOString(); return false; }
  return now.getTime() - Date.parse(state.lastRetroAt) >= cfg.retroEveryH * HOUR_MS;
}
