// JUDGE-BUTLER-V3-LISTED (LOOP-AGENTS-AS-PLUGINS · 대표 11-28 15:3x «감독자들이 다 도는지 · 기존 것 통합 및 플러그인화»).
//
// S: `eln loop agent list` listed only v2 cards (goal.yaml `runtime: v2`). The agents whose body is one bespoke node kind —
//    judge-butler (judge-butler.tick) · land-steward (land-graph.tick) · guardian (guardian.pulse) — were a «(bespoke)» line
//    with no L0, level, last tick or KPI, and `eln loop agent <id> status` said «KPI ?».
// C: agent.yaml already names the body (body.entry_node → its kind), the L0 (supervisor.duty), the KPIs and the trigger; only
//    the KPI value had no address — each body writes it under its own field names in its tick file.
// A: one generic reader for every agent.yaml that has no v2 card. A KPI's value is `kpis[].from` (a dotted path into the tick
//    file · an array counts its length) — the numbers stay in agent.yaml, the reader keeps none. The body runs through the
//    shared door `eln loop agent <id> tick`: the entry node kind's runner (kind-runners.ts) — the bespoke CLI doors stay aliases.
// GUARDIAN-KPI-FROM: a body whose snapshot is another file of its home (guardian = last-pulse.json · its sub KPI rows) names it
//    in YAML — `from: { file, path, where }` · `where` counts the array rows whose fields match (e.g. sub rows with ok false).
//    The last tick falls back to the `at` of the first KPI source file when last-tick.json has none.
//
// 세 얼굴: 관측 = agent.yaml (lint) ⊕ <stateRoot>/loop-agents/<id>/{last-tick.json · level.json} / 판단 근거 = kpis (target ·
//   from) · supervisor duty → seat (org map) / 수복과 인계 = a refused agent.yaml is a row with its first error (never hidden) ·
//   an unreadable tick file = value «?» (모름 — never a false 0).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kpiLine, type KpiSpec } from '../card.js';
import { agentHome, fileAgentMemory } from '../memory.js';
import { kpiOk } from '../../kit/kpi/index.js';
import { lintAgentDir, supervisorSeat, type AgentKpi, type CompiledAgent, type KpiWhere } from './agent-yaml.js';

export interface KpiReading { readonly name: string; readonly value: number | null; readonly ok: boolean | null; readonly line: string }
export interface ListedAgent {
  readonly id: string; readonly name: string; readonly address: string; readonly supervisor: string; readonly level: string;
  readonly lastTickAt: string | null; readonly kpis: readonly KpiReading[]; readonly kpi: string; readonly kpiOk: boolean | null;
  /** the body's node kind (agent.yaml body.entry_node) */
  readonly body: string; readonly runtime: 'v3';
}

/** The value at a dotted path: a finite number, or an array's length (with `where`: the rows whose fields all match) · anything
 *  else = null (모름). */
export function valueAt(obj: unknown, path: string, where?: KpiWhere): number | null {
  let v: unknown = obj;
  for (const k of path.split('.')) { if (!v || typeof v !== 'object' || Array.isArray(v)) return null; v = (v as Record<string, unknown>)[k]; }
  if (Array.isArray(v) && where) return v.filter(r => !!r && typeof r === 'object' && Object.entries(where).every(([f, w]) => (r as Record<string, unknown>)[f] === w)).length;
  if (Array.isArray(v)) return v.length;
  if (where) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const spec = (k: AgentKpi): KpiSpec => ({ name: k.name, target: k.target, dir: k.dir, unit: k.unit });
const shown = (n: number | null): number | null => (n === null ? null : Number.isInteger(n) ? n : Math.round(n * 100) / 100);

export const TICK_FILE = 'last-tick.json';

/** Every KPI with a `from:` read from its source file (`file(name)` → parsed JSON · null = every value there «?»). KPIs without
 *  `from` are not read here. */
export function kpiReadings(c: Pick<CompiledAgent, 'kpis'>, file: (name: string) => unknown): KpiReading[] {
  return c.kpis.filter(k => !!k.from).map(k => {
    const src = file(k.fromFile ?? TICK_FILE);
    const value = src === null ? null : valueAt(src, k.from!, k.fromWhere);
    return { name: k.name, value, ok: kpiOk(k, value), line: kpiLine(spec(k), shown(value)) };
  });
}

/** One KPI line for a list row: every read KPI · ok = all met (null when one is unknown and none is breached). */
export function kpiSummary(readings: readonly KpiReading[]): { line: string; ok: boolean | null } {
  if (!readings.length) return { line: 'KPI ? (agent.yaml kpis 에 from: 없음)', ok: null };
  const ok = readings.some(r => r.ok === false) ? false : readings.every(r => r.ok === true) ? true : null;
  return { line: readings.map(r => r.line).join(' · '), ok };
}

const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, 'utf8')) as unknown; } catch { return null; } };

/** The listed (v3) row of one compiled agent from its home. */
export function listedRow(c: CompiledAgent, stateRoot: string, fallbackSeat = 'OP'): ListedAgent {
  const home = agentHome(stateRoot, c.id);
  const files = new Map<string, unknown>();
  const file = (name: string): unknown => { if (!files.has(name)) files.set(name, readJson(join(home, name))); return files.get(name); };
  const atOf = (j: unknown): string | null => (j && typeof j === 'object' && typeof (j as { at?: unknown }).at === 'string' ? (j as { at: string }).at : null);
  const firstSource = c.kpis.find(k => !!k.from)?.fromFile ?? TICK_FILE;
  const at = atOf(file(TICK_FILE)) ?? (firstSource !== TICK_FILE ? atOf(file(firstSource)) : null);
  const supervisor = supervisorSeat(c.supervisor, fallbackSeat);
  const readings = kpiReadings(c, file);
  const sum = kpiSummary(readings);
  const entry = c.body.nodes.find(n => n.node_id === c.body.entry);
  return { id: c.id, name: c.name, address: c.address, supervisor, level: fileAgentMemory(stateRoot, c.id, supervisor).level().level,
    lastTickAt: at, kpis: readings, kpi: sum.line, kpiOk: sum.ok, body: entry?.kind ?? '?', runtime: 'v3' };
}

/** Every agent.yaml under `cardsRoot` that is not a v2 card (`skip` = the v2 card ids) — refused ones come back as errors. */
export function listedAgents(o: { cardsRoot: string; stateRoot: string; skip: ReadonlySet<string> }): { agents: ListedAgent[]; errors: string[] } {
  const agents: ListedAgent[] = []; const errors: string[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(o.cardsRoot).filter(n => !o.skip.has(n) && existsSync(join(o.cardsRoot, n, 'agent.yaml'))).sort(); }
  catch (e) { return { agents, errors: [`${o.cardsRoot}: ${e instanceof Error ? e.message : String(e)}`] }; }
  for (const id of ids) {
    const r = lintAgentDir(join(o.cardsRoot, id), { triggersDir: join(o.cardsRoot, '..', 'triggers') });
    if (!r.ok || !r.compiled) { errors.push(`${id}/agent.yaml refused: ${r.errors[0] ?? 'no compiled agent'}`); continue; }
    agents.push(listedRow(r.compiled, o.stateRoot));
  }
  return { agents, errors };
}
