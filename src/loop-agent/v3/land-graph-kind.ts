// CODE-BODY-TO-KIND — the `land-graph.tick` node kind: any agent.yaml whose body is the land graph (LOOP-AGENTS-AS-PLUGINS ·
// 대표 11-28 «코드로 된 것도 플러그인화»). The land steward is one instance of it (graphs/loop-agents/land-steward/agent.yaml);
// nothing here names that agent: its id · address · L0 duty · KPIs · breach texts · lane order come from its package.
//
// One wake: refused definition → one L0 card and the agent stays down (plain body · off) · body tick (tickLand) with the
// package's lane order (policies.yaml · src/land-graph/lane-order.ts) and the agent's address as terminal owner (live only —
// shadow / off run the plain body: landing never stops) · post-merge cell link (fail-open) · metrics at the END of the tick
// (src/land-graph/metrics.ts) · the `kpi-voice` node (src/loop-agent/v3/kpi-voice.ts) · journal ⊕ case row ⊕ state.
//
// 세 얼굴: 관측 = the tick report (last-tick.json: kpi · breaches · posted · lanes · slots · cellLink · smart) / 판단 근거 = the
//   agent.yaml (kpis · voice · policies) ⊕ policies.yaml (lane order) / 수복과 인계 = a failed body tick is not «0 lands» (no
//   KPI · no line · state untouched · the CLI exits 1) · a refused agent.yaml → one deduped L0 card per error set.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readBook, type FinishBook } from '../../land-graph/finisher.js';
import { landOrder, readLedger, tickLand, type LandDeps, type LedgerRow, type PrInfo, type TickResult } from '../../land-graph/land-graph.js';
import { loadLivePolicy } from '../../kit/lane-pins/index.js';
import { lanes, policyOrder, slotAdvice, type Lane, type LandPolicy, type SlotAdvice } from '../../land-graph/lane-order.js';
import { landMetrics, type LandMetrics } from '../../land-graph/metrics.js';
import type { LandVoiceInput } from '../../land-graph/voice.js';
import type { SweepReport } from '../../land-graph/main-cell-link.js';
import { loadDefinition } from '../../definitions/loader.js';
import { appendJournal } from '../journal.js';
import { fileAgentMemory } from '../memory.js';
import { kpiOf, lintAgentDir, refusalReport, supervisorSeat, type CompiledAgent, type LintEnv } from './agent-yaml.js';
import { openKpiSmart, runKpiVoice, type KpiVoiceChoice } from './kpi-voice.js';
import { smartConfig, type KnowhowSink, type Router, type SmartConfig } from './smart.js';

export type TickLevel = 'live' | 'shadow' | 'off';
/** What the kind needs of the agent's memory (the agent's own file layout implements it). */
export interface TickMemory {
  readonly root: string;
  readState(): { lastTickAt: string | null; ticks: number; breaches: Record<string, string> };
  writeState(s: { lastTickAt: string | null; ticks: number; breaches: Record<string, string> }): void;
  appendCase(c: { at: string; kind: 'tick' | 'voice' | 'breach' | 'level'; subject: string; why: string; refs?: string[]; extra?: Record<string, unknown> }): void;
  level(): { level: TickLevel };
}
export interface AgentTickCards {
  /** the linted agent.yaml · null = absent or refused (the agent is down) */
  readonly compiled: CompiledAgent | null;
  readonly soulText: string; readonly knowhowText: string;
  readonly source: 'agent.yaml' | 'default';
  readonly refused?: string[];
  readonly supervisor?: { duty?: string; seat?: string };
  /** v3 hook nodes (reflect · plan · learn-knowhow) — absent = the default line every breach (LOOP-AGENT-V3-SMART). */
  readonly smart?: SmartConfig;
}

/** A package dir → its cards: agent.yaml (lint ⊕ the strict definition loader) · refused → `refused` (never a silent default). */
export function loadAgentCards(dir: string, fallbackSoul: string, env: LintEnv = {}): AgentTickCards {
  const triggersDir = join(dir, '..', '..', 'triggers');
  const read = (f: string) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const v3 = lintAgentDir(dir, { triggersDir, ...env });
  const strict = v3.present && v3.compiled ? loadDefinition(join(dir, 'agent.yaml'), { triggersDir, ...env }) : null;
  if (v3.present && v3.compiled && !strict?.errors.length) {
    const smart = smartConfig(v3.compiled);
    return { compiled: v3.compiled, soulText: v3.compiled.soulText || fallbackSoul, knowhowText: v3.compiled.knowhowText, source: 'agent.yaml', supervisor: v3.compiled.supervisor, ...(smart ? { smart } : {}) };
  }
  let supervisor: AgentTickCards['supervisor'];
  try { const d = (parse(read('agent.yaml')) as { supervisor?: { duty?: unknown } } | null)?.supervisor?.duty; if (typeof d === 'string' && d) supervisor = { duty: d }; } catch { /* unreadable */ }
  const errors = v3.present ? [...v3.errors, ...(strict?.errors.map(e => `agent.yaml:${e.line}: ${e.message}`) ?? [])] : [`no agent.yaml in ${dir}`];
  return { compiled: null, soulText: read('soul.md') || fallbackSoul, knowhowText: read('knowhow.md'), source: 'default', refused: errors.length ? errors : ['agent.yaml refused'], ...(supervisor ? { supervisor } : {}) };
}

export interface LandTickPorts {
  memory: TickMemory;
  /** One line into the agent's own channel (els `loop:<id>`) — never mail. Fail-open. */
  channel(line: string): void;
  book?(): FinishBook;
  /** Deduped mail to the L0 (key → once): a refused agent.yaml · a plan-chosen L0 card. Fail-open. */
  report?(key: string, to: string, body: string): void;
  /** LAND-CELL-LINK-ALWAYS: the post-merge cell-link sweep over main — every merge, whatever path landed it. Fail-open. */
  cellSweep?(): Promise<SweepReport>;
  router?: Router | null;
  /** v3 knowhow sink — default = the agent's v2 pack (<home>/knowhow/learned.md). */
  knowhow?: KnowhowSink | null;
  /** the lane-order pack (default: <package>/policies.yaml of the repo) */
  policy?: LandPolicy | null;
}
export interface LandTickReport {
  at: string; level: TickLevel; mode: string; locked: boolean;
  landed: number[]; kpi: LandMetrics | null; breaches: string[]; posted: string[];
  lanes: Lane[]; slots: SlotAdvice | null; error?: string;
  /** GH-BUDGET-GOVERNOR ④: the body skipped this tick (open-PR read failed) — not an exception; the next tick retries. */
  skipped?: 'gh-error';
  decisions: TickResult['decisions'];
  /** PR-ZOMBIE-AGING: the aged open PRs of this tick (drafted · would-draft · close proposals). */
  aging?: TickResult['aging'];
  refused?: string[];
  cellLink?: Pick<SweepReport, 'version' | 'since' | 'scanned' | 'counts' | 'error'>;
  smart?: { choices: KpiVoiceChoice[]; lessons: number; created: string[]; cleared: string[]; promoted: string[]; resolved: { acted: number; unacted: number } };
}

/** The body deps an agent runs with: live = the pack's lane order ⊕ the agent as terminal owner · shadow / off = the plain body. */
export function agentLandDeps(d: LandDeps, level: TickLevel, address: string, capture: (prs: PrInfo[]) => void, policy: LandPolicy | null = loadLivePolicy(d.stateRoot)): LandDeps {
  return {
    // no pack → the body's own order (the train order is the pack's — there is no built-in copy of it)
    ...d, ...(level === 'live' ? { order: policy ? policyOrder(policy) : landOrder, terminalOwner: address } : {}),
    listPrs: async () => { const v = await d.listPrs(); capture(v); return v; },
  };
}

/** One wake of an agent on the land graph. `id` · `address` · `l0Fallback` = the agent's names when its agent.yaml is refused. */
export async function landGraphAgentTick(d: LandDeps, ports: LandTickPorts, cards: AgentTickCards, names: { id: string; address: string; l0Fallback: string }): Promise<LandTickReport> {
  const c = cards.compiled;
  const l0 = () => supervisorSeat(c?.supervisor ?? cards.supervisor ?? { duty: 'landing' }, names.l0Fallback, d.org ?? {});
  // A refused definition must not run the body with implicit defaults. Report its L0 and remain down.
  if (!c) {
    const r = refusalReport(names.id, cards.refused ?? ['agent.yaml refused'], l0());
    const body = r.body.replace('이 정의로는 돌지 않는다(정의 전 기본 몸으로만 돈다)', `이 정의는 거부되어 ${names.id} 가 내려간 상태다(기본 몸도 돌지 않는다)`);
    try { ports.report?.(r.key, r.to, body); } catch { /* fail-open: the report field keeps it */ }
  }
  const lvl: TickLevel = c ? ports.memory.level().level : 'off';
  const started = d.now().toISOString();
  const empty: LandTickReport = { at: started, level: lvl, mode: d.mode, locked: false, landed: [], kpi: null, breaches: [], posted: [], lanes: [], slots: null, decisions: [] };
  if (!c) return { ...empty, refused: cards.refused ?? ['agent.yaml refused'], error: 'agent.yaml refused; agent down' };
  let prs: PrInfo[] = [];
  const res = await tickLand(agentLandDeps(d, lvl, c.address, v => { prs = v; }, ports.policy === undefined ? loadLivePolicy(d.stateRoot) : ports.policy));
  if (res.locked) return { ...empty, locked: true };
  // LAND-CELL-LINK-ALWAYS: after the body tick (its own lands included), link every merge to main since the cursor. Every level.
  const cellLink = await (async () => {
    if (!ports.cellSweep) return undefined;
    try { const s = await ports.cellSweep(); return { version: s.version, since: s.since, scanned: s.scanned, counts: s.counts, ...(s.error ? { error: s.error } : {}) }; }
    catch (e) { return { version: null, since: '', scanned: 0, counts: {}, error: String(e).slice(0, 160) }; }
  })();
  const withCells = cellLink ? { cellLink } : {};
  if (lvl === 'off') return { ...empty, ...withCells, landed: res.landed, decisions: res.decisions, ...(res.error ? { error: res.error } : {}), ...(res.skipped ? { skipped: res.skipped } : {}) };
  // A failed body tick (gh list · lock · …) is NOT «0 lands»: no KPI, no breach line, breach state and case untouched.
  // A skipped tick (GitHub read failed · cooldown) is a wake, not a stall: lastTickAt moves (the fleet audit's «틱 정지» reads it);
  // breaches · KPI · cases stay untouched.
  if (res.skipped && lvl === 'live') { const st = ports.memory.readState(); st.lastTickAt = started; ports.memory.writeState(st); }
  if (res.error) return { ...empty, ...withCells, landed: res.landed, decisions: res.decisions, error: res.error, ...(res.skipped ? { skipped: res.skipped } : {}) };
  // The body tick can take tens of minutes (live lands): measure at its END, so its own lands / finisher starts are not «future».
  const now = d.now(); const at = now.toISOString();
  const rows = readLedger(d.stateRoot);
  const open = prs.filter(p => p.state === 'OPEN');
  const kpi = landMetrics({ rows, tick: res, book: (ports.book ?? (() => readBook(d.stateRoot)))(), prs: open, now });
  const state = ports.memory.readState();
  const knowhow = (): KnowhowSink | null => {
    if (ports.knowhow !== undefined) return ports.knowhow;
    const shell = fileAgentMemory(d.stateRoot, c.id, l0());
    return { text: () => shell.knowhow().text, add: (item, by, when) => shell.addKnowhow(item, by, when) };
  };
  const smart = lvl === 'live' && cards.smart ? (() => { try { return openKpiSmart({ cfg: cards.smart!, storeRoot: ports.memory.root, now, l0: l0(), knowhow: knowhow(), metrics: { kpi }, kpis: c.kpis }); } catch { return null; } })() : null;
  const v = await runKpiVoice({ agent: c.id, kpis: c.kpis, voice: c.voice, everyMin: c.voice.breachLineEveryMin ?? c.policies.breach_line_every_min!, metrics: { kpi }, cursor: state.breaches, now,
    live: lvl === 'live', smart, router: ports.router ?? null, channel: l => ports.channel(l), ...(ports.report ? { report: ports.report } : {}) });
  state.breaches = v.cursor;
  if (lvl === 'live') { state.lastTickAt = at; state.ticks = (state.ticks ?? 0) + 1; ports.memory.writeState(state); }
  const landsTarget = kpiOf(c, 'lands_per_hour')!.target; // node kind land-graph.tick needs KPI lands_per_hour (slot advice)
  const report: LandTickReport = {
    at, level: lvl, mode: res.mode, locked: false, landed: res.landed, kpi, breaches: v.breaches.map(b => b.line), posted: v.posted,
    lanes: lanes(open).slice(0, 8), slots: slotAdvice(d.slots, kpi.waitingForSlot, kpi.landsLastHour, landsTarget),
    decisions: res.decisions, ...withCells, ...(res.error ? { error: res.error } : {}), ...(res.aging ? { aging: res.aging } : {}),
    ...(smart ? { smart: { choices: v.choices, lessons: smart.lessons.filter(l => l.status === 'active').length, created: smart.learned.created, cleared: smart.learned.cleared, promoted: smart.learned.promoted, resolved: smart.reflection.resolved } } : {}),
  };
  // SUPERVISOR-CORRECTION-JOURNAL: the real corrections = lands ⊕ stale-PR closes (one journal row each).
  if (lvl === 'live') {
    const dec = (n: number) => res.decisions.find(x => x.pr === n);
    try {
      appendJournal(ports.memory.root, [
        ...res.landed.map(n => ({ v: 1 as const, at, agent: c.id, status: 'acted' as const, action: 'land', target: `pr:#${n}`, what: `landed #${n}`, why: dec(n)?.why ?? 'ready', before: 'open · ready', after: 'merged', evidence: [`pr:#${n}`, 'ledger:land-graph'], undo: `git revert the merge of #${n}`, source: 'tick' as const, by: c.address })),
        // PR-ZOMBIE-AGING: a draft conversion is a correction (reversible) · a close proposal is a card, not a correction.
        ...(res.aging ?? []).filter(r => r.action === 'drafted' || r.action === 'draft-failed').map(r => ({ v: 1 as const, at, agent: c.id, status: (r.action === 'drafted' ? 'acted' : 'failed') as 'acted' | 'failed', action: 'to-draft', target: `pr:#${r.pr}`, what: `${r.action} #${r.pr}`, why: r.why, before: 'open · ready for review', after: r.action === 'drafted' ? 'draft' : null, evidence: [`pr:#${r.pr}`, 'ledger:land-graph'], undo: r.action === 'drafted' ? `gh pr ready ${r.pr}` : null, source: 'tick' as const, by: c.address })),
        ...(res.reaped ?? []).filter(r => r.action !== 'would-close').map(r => ({ v: 1 as const, at, agent: c.id, status: (r.action === 'closed' ? 'acted' : 'failed') as 'acted' | 'failed', action: 'close-stale', target: `pr:#${r.pr}`, what: `${r.action} #${r.pr}`, why: r.why, before: 'open · stale', after: r.action === 'closed' ? 'closed' : null, evidence: [`pr:#${r.pr}`], undo: r.action === 'closed' ? `gh pr reopen ${r.pr}` : null, source: 'tick' as const, by: c.address })),
      ]);
    } catch { /* fail-soft */ }
    ports.memory.appendCase({ at, kind: 'tick', subject: `landed ${res.landed.length}`, why: `ready ${kpi.ready}/${kpi.judged} · lands/h ${kpi.landsLastHour} · breaches ${v.breaches.length}`, refs: res.landed.map(n => `pr:#${n}`), extra: { started, supervisedBy: l0Of(c, names.l0Fallback) } });
  }
  return report;
}
/** The case row's supervisedBy (the literal L0 seat the old body wrote: the org duty's seat when the YAML names one). */
const l0Of = (c: CompiledAgent, fallback: string): string => c.supervisor.seat ?? fallback;

/** The view for one voice answer: a dry plan of the body (no lock · no ledger · no cards). */
export async function landVoiceView(d: LandDeps, address: string, book?: FinishBook): Promise<LandVoiceInput> {
  let prs: PrInfo[] = [];
  const plan = await tickLand({ ...agentLandDeps(d, 'live', address, v => { prs = v; }), dry: true });
  // A failed plan (gh down · lock) must never read as «closed» / «nothing blocked»: refuse to answer from it.
  if (plan.error) throw new Error(`body plan failed — ${plan.error}`);
  if (plan.locked) throw new Error('body plan unavailable — a tick holds the lock');
  const rows = readLedger(d.stateRoot);
  const open = prs.filter(p => p.state === 'OPEN');
  return { now: d.now(), plan, prs: open, rows, kpi: landMetrics({ rows, tick: plan, book: book ?? readBook(d.stateRoot), prs: open, now: d.now() }), slots: d.slots };
}
