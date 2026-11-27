// 수호자 = 얇은 상주 본체 + 서브 루프 에이전트 7 (FEDERATION-ORG-SYSTEM-1127 v2 · 내부 문서 `LOOP-AGENTS` §1 수호자 칸 · §1a
// 수명⊕임대 · 대표 10:0x). The body never does the heavy work itself: on an event or its cadence it SPAWNS a sub-agent — one spawn
// line {id · generation · by · why · resource · TTL · heartbeat} — runs it, records its KPI, closes the line; a line past its
// TTL that never closed is reaped by the parent. Spawn lines live in the guardian's own memory (cases), not a new ledger;
// the port is shaped like the Nexus lease ledger (RFC-guardian-resource-ledger) so it moves there unchanged.
import type { ButlerMemory } from '../judge-butler/memory.js';
import type { WorldEntry } from './world.js';
import { okMark } from '../kit/kpi/index.js';

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

/** The seven (FEDERATION-ORG-SYSTEM-1127 v2 table — the guardian's handbook duties split one per sub-agent). */
export const SUB_AGENTS: readonly SubAgentSpec[] = [
  { id: 'pulse', name: '맥박', duty: '관측·건강 · doctor', absorbs: ['watchers-check', 'resource-heartbeat-collect', 'seat-main-liveness'], kpi: '감독자·호스트 heartbeat 결손 0', rights: ['재기동', '경보'], everyMin: 15, events: ['supervisor-dead', 'supervisor-bad', 'host-unreachable'], ttlMin: 5 },
  { id: 'lease', name: '임대관', duty: '임대 장부 · 할당 · 부하 스위칭', absorbs: ['res-burst-lease', 'host-reservation-watch', 'release-traffic', 'guardian-placement', 'pregate host balance'], kpi: 'load/ncpu ≤ 1.0 · 임대 없는 spawn 0', rights: ['경로 변경', '호스트 비우기', '버스트 VM(OP 승인)'], everyMin: 15, events: ['host-overload'], ttlMin: 10 },
  { id: 'fuel', name: '연료관', duty: 'LLM·외부 할당', absorbs: ['MODEL-BY-DIFFICULTY budget guard'], kpi: '소진 0 · 우회 지연 ≤ 5분', rights: ['손 모델 단계 우회', '새 배정 한도', 'LLM 국면·레벨 사실(llm-state)', '자동 오버라이드(크레딧 바닥)'], everyMin: 30, events: ['fuel-90', 'fuel-level'], ttlMin: 5 },
  { id: 'keys', name: '열쇠지기', duty: '자격·비밀', absorbs: ['secret-exposure', 'cred-push', 'gws/grok relogin watch'], kpi: '만료 사고 0 · 노출 0', rights: ['갱신', '노출 즉시 차단 카드(👑)'], everyMin: 60, events: ['credential-expiring'], ttlMin: 5 },
  { id: 'macrophage', name: '대식세포', duty: '위생 · 고아 회수 · 잔재', absorbs: ['machine-sanitize', 'harness-gc', 'orphan test universes', 'leftover launchd/cron'], kpi: '고아 2h 초과 0 · 잔재 0', rights: ['정확 PID 회수', '잔재 정리(되돌림 기록)'], everyMin: 15, events: ['host-overload', 'orphans'], ttlMin: 10 },
  { id: 'patrol', name: '순찰대', duty: '수명 순찰 ①카드 PR 없음 ②부모 없는 프로세스 ③임대 없는 부모 · 부검 감지', absorbs: ['run-supervisor', 'run-doctor', 'autopsy', 'stop-autoheal'], kpi: '좀비 런 0 · 미분류 사망 0', rights: ['원장 짝짓기 뒤 거두기', '1회 수리', '반복 꼴 → 칸(조율자)'], everyMin: 30, events: [], ttlMin: 10 },
  { id: 'post', name: '우체국·레일지기', duty: '운영 레일 · 발송 큐', absorbs: ['postoffice SSE', 'seat-inbox/idle-nudge', 'wake ledger', 'kingdom-mail-relay', 'op-mail-bridge', 'silence-watch', 'rail-watch'], kpi: 'SLA 초과 우편 0 · 레일 회귀 즉시 카드', rights: ['재배달·재경로', '레일 되돌림 제안'], everyMin: 30, events: [], ttlMin: 5 },
];

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
    if (e.kind === 'account' && typeof e.facts.used === 'number' && (e.facts.used as number) >= 0.9) ev.add('fuel-90');
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
  for (const spec of SUB_AGENTS) {
    const hit = spec.events.find(e => events.has(e));
    const last = lastSpawnAt[spec.id];
    const cadenceDue = spec.everyMin !== null && (!last || nowMs - Date.parse(last) >= spec.everyMin * 60_000);
    const eventDue = !!hit && (!last || nowMs - Date.parse(last) >= 2 * 60_000); // an event re-spawns at most every 2 min
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
  return SUB_AGENTS.map(s => { const r = byId.get(s.id); return `${okMark(r?.ok)} ${s.name}(${s.id}) — ${s.kpi}: ${r ? `${r.value} · ${r.lastSpawn?.slice(11, 16)}Z (${r.why})` : '아직 spawn 없음'}`; }).join('\n');
}
