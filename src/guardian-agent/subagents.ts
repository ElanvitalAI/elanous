// 수호자 = 얇은 상주 본체 + 서브 루프 에이전트 7 (FEDERATION-ORG-SYSTEM-1127 v2 · 내부 문서 `LOOP-AGENTS` §1 수호자 칸 · §1a
// 수명⊕임대 · 대표 10:0x). The body never does the heavy work itself: on an event or its cadence it SPAWNS a sub-agent — one spawn
// line {id · generation · by · why · resource · TTL · heartbeat} — runs it, records its KPI, closes the line; a line past its
// TTL that never closed is reaped by the parent. Spawn lines live in the guardian's own memory (cases), not a new ledger;
// the port is shaped like the Nexus lease ledger (RFC-guardian-resource-ledger) so it moves there unchanged.
import type { ButlerMemory } from '../judge-butler/memory.js';
import type { WorldEntry } from './world.js';
import { okMark } from '../kit/kpi/index.js';
import { gp, guardianSubs } from './def.js';

export type SubAgentId = 'pulse' | 'lease' | 'fuel' | 'keys' | 'macrophage' | 'patrol' | 'post';
export interface SubAgentSpec {
  readonly id: SubAgentId;
  readonly name: string;
  readonly duty: string;
  /** existing supervisors it absorbs (handbook map) */
  readonly absorbs: readonly string[];
  readonly kpi: string;
  readonly rights: readonly string[];
  /** cadence in minutes (null = event-only) */
  readonly everyMin: number | null;
  /** world events that spawn it now */
  readonly events: readonly WorldEventKind[];
  readonly ttlMin: number;
}
export type WorldEventKind = 'host-overload' | 'host-unreachable' | 'supervisor-dead' | 'supervisor-bad' | 'fuel-90' | 'fuel-level' | 'credential-expiring' | 'orphans';

/** The seven — GUARDIAN-SUBS: defined ONLY in graphs/loop-agents/guardian/agent.yaml `subs:` (duty · rights · KPI · cadence ·
 *  TTL · events · detectors · src/guardian-agent/def.ts). This is a live view of that table for callers that iterate it. */
export const SUB_AGENTS: readonly SubAgentSpec[] = new Proxy([] as SubAgentSpec[], {
  get: (_t, k) => { const subs: readonly SubAgentSpec[] = guardianSubs(); const v: unknown = Reflect.get(subs, k); return typeof v === 'function' ? v.bind(subs) : v; },
});

export interface SubAgentResult { readonly kpi: { readonly value: string; readonly ok: boolean | null }; readonly actions: readonly string[] }
export type SubAgentRunner = () => SubAgentResult;

/** Pure: world events from the aggregate. */
export function worldEvents(world: readonly WorldEntry[], extra: { orphans?: number; fuelLevel?: boolean } = {}): Set<WorldEventKind> {
  const ev = new Set<WorldEventKind>();
  for (const e of world) {
    if (e.kind === 'host' && e.status === 'overloaded') ev.add('host-overload');
    if (e.kind === 'host' && e.status === 'unreachable') ev.add('host-unreachable');
    if (e.kind === 'supervisor' && (e.status === 'dead' || e.status === 'broken')) ev.add('supervisor-dead');
    if (e.kind === 'supervisor' && e.status === 'bad') ev.add('supervisor-bad');
    // an account the llm-accounts decision already reacted to (skip · demote · tier down) is handled — no 2-min re-spawn (11-28: fuel-263…)
    if (e.kind === 'account' && typeof e.facts.used === 'number' && (e.facts.used as number) >= 0.9 && e.facts.handled !== true) ev.add('fuel-90');
    if (e.kind === 'credential' && e.status === 'stale') ev.add('credential-expiring');
  }
  if ((extra.orphans ?? 0) > 0) ev.add('orphans');
  // LLM-PHASE-BY-GUARDIAN: a level / phase / floor override would change (the body's LLM-0 probe) → the 연료관 now.
  if (extra.fuelLevel) ev.add('fuel-level');
  return ev;
}

/** Pure: which sub-agents to spawn now — an event they answer, or their cadence came due — and why. */
export function dueSubAgents(events: ReadonlySet<WorldEventKind>, lastSpawnAt: Readonly<Record<string, string>>, nowMs: number): Array<{ spec: SubAgentSpec; why: string }> {
  const out: Array<{ spec: SubAgentSpec; why: string }> = [];
  const respawnMs = gp('event_respawn_min') * 60_000; // an event re-spawns its sub at most this often (agent.yaml)
  for (const spec of guardianSubs()) {
    const hit = spec.events.find(e => events.has(e));
    const last = lastSpawnAt[spec.id];
    const cadenceDue = spec.everyMin !== null && (!last || nowMs - Date.parse(last) >= spec.everyMin * 60_000);
    const eventDue = !!hit && (!last || nowMs - Date.parse(last) >= respawnMs);
    if (eventDue) out.push({ spec, why: `event ${hit}` });
    else if (cadenceDue) out.push({ spec, why: `cadence ${spec.everyMin}m` });
  }
  return out;
}

// ── spawn ledger port (Nexus lease-ledger shape; guardian memory backs it until the Nexus ledger exists) ──────────────

export interface SpawnLine { readonly id: string; readonly agent: SubAgentId; readonly generation: number; readonly by: string; readonly why: string; readonly resource: string; readonly ttlMin: number; readonly at: string; readonly heartbeatAt: string; readonly closedAt?: string; readonly outcome?: string }
export interface SpawnLedger {
  open(line: Omit<SpawnLine, 'id' | 'generation' | 'heartbeatAt'>): SpawnLine;
  close(line: SpawnLine, outcome: string, at: string): void;
  /** lines still open */
  openLines(): SpawnLine[];
}

/** Memory-backed ledger: each open/close is one guardian case (kind 'spawn' · subject = line id). */
export function memorySpawnLedger(mem: ButlerMemory): SpawnLedger {
  const lines = () => {
    const byId = new Map<string, SpawnLine>();
    for (const c of mem.cases(2000)) {
      if (c.kind !== 'spawn' || !c.extra) continue;
      const l = c.extra as unknown as SpawnLine;
      byId.set(l.id, { ...(byId.get(l.id) ?? {}), ...l });
    }
    return [...byId.values()];
  };
  return {
    open(input) {
      const generation = lines().filter(l => l.agent === input.agent).length + 1;
      const line: SpawnLine = { ...input, id: `${input.agent}-${generation}`, generation, heartbeatAt: input.at };
      mem.appendCase({ at: input.at, kind: 'spawn', subject: line.id, why: `open · ${input.why}`, decidedBy: 'GUARDIAN', supervisedBy: 'RES', extra: line as unknown as Record<string, unknown> });
      return line;
    },
    close(line, outcome, at) {
      mem.appendCase({ at, kind: 'spawn', subject: line.id, why: `close · ${outcome.slice(0, 160)}`, decidedBy: 'GUARDIAN', supervisedBy: 'RES', extra: { id: line.id, closedAt: at, outcome: outcome.slice(0, 200) } });
    },
    openLines: () => lines().filter(l => !l.closedAt),
  };
}

export interface KpiRow { readonly agent: SubAgentId; readonly name: string; readonly kpi: string; readonly value: string; readonly ok: boolean | null; readonly lastSpawn: string | null; readonly why: string | null }

/** Spawn the due sub-agents (one line each), run them, close; reap lines past their TTL. Returns the KPI table rows touched. */
export function runSubAgents(input: { due: Array<{ spec: SubAgentSpec; why: string }>; runners: Partial<Record<SubAgentId, SubAgentRunner>>; ledger: SpawnLedger; now: Date; resource: (spec: SubAgentSpec) => string }):
  { ran: KpiRow[]; reaped: string[] } {
  const at = input.now.toISOString(); const nowMs = input.now.getTime();
  const reaped: string[] = [];
  for (const l of input.ledger.openLines()) if (nowMs - Date.parse(l.at) > l.ttlMin * 60_000) { input.ledger.close(l, `reaped by parent — TTL ${l.ttlMin}m passed without close`, at); reaped.push(l.id); }
  const ran: KpiRow[] = [];
  for (const { spec, why } of input.due) {
    const runner = input.runners[spec.id];
    const line = input.ledger.open({ agent: spec.id, by: 'GUARDIAN', why, resource: input.resource(spec), ttlMin: spec.ttlMin, at });
    let result: SubAgentResult;
    try { result = runner ? runner() : { kpi: { value: 'not built yet', ok: null }, actions: [] }; }
    catch (e) { result = { kpi: { value: `error ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`, ok: false }, actions: [] }; }
    input.ledger.close(line, `${result.kpi.ok === false ? 'KPI miss' : result.kpi.ok ? 'KPI ok' : 'KPI ?'} · ${result.kpi.value}${result.actions.length ? ` · ${result.actions.slice(0, 4).join(' · ')}` : ''}`, at);
    ran.push({ agent: spec.id, name: spec.name, kpi: spec.kpi, value: result.kpi.value, ok: result.kpi.ok, lastSpawn: at, why });
  }
  return { ran, reaped };
}

export function renderKpiTable(rows: readonly KpiRow[]): string {
  const byId = new Map(rows.map(r => [r.agent, r] as const));
  return guardianSubs().map(s => { const r = byId.get(s.id); return `${okMark(r?.ok)} ${s.name}(${s.id}) — ${s.kpi}: ${r ? `${r.value} · ${r.lastSpawn?.slice(11, 16)}Z (${r.why})` : '아직 spawn 없음'}`; }).join('\n');
}
