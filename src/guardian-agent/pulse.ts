// 수호자 — the THIN resident body (FEDERATION-ORG-SYSTEM-1127 v2 · GUARDIAN-CHARTER-1127 §4 ①): one LLM-0 pulse every trigger
// tick (≤ 2 min · trigger guardian-pulse) that only aggregates the world (host load/ncpu · supervisor heartbeats), keeps the
// sub-agent KPI table, decides which sub-agent to spawn (event or cadence — one spawn line each, the parent reaps) and makes
// the final load-switch decision (writes the route the 임대관 proposed). The heavy work runs inside the sub-agents.
import { spawn } from 'node:child_process';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { ButlerMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SEAT, GUARDIAN_SUPERVISOR, planGuardian, runGuardian, type GuardianPorts, type GuardianView } from './body.js';
import { LOCAL_HOSTS, pickHost, probeHost, type HostProbe } from './hosts.js';
import { dueSubAgents, memorySpawnLedger, runSubAgents, worldEvents, type KpiRow, type SubAgentId, type SubAgentRunner } from './subagents.js';
import { accountEntries, judgeFuel, type UsageSnapshot } from './fuel.js';
import { credentialEntries, exposureCard, judgeKeys, type CredentialIn, type ExposureIn } from './keys.js';
import { diffWorld, emptyPulseState, hostEntries, planPulse, readPulseSnapshot, supervisorEntries, writePulseSnapshot, type PulseState, type SupervisorIn, type WorldChange, type WorldEntry } from './world.js';

export interface PulseDeps {
  readonly stateRoot: string;
  readonly now: Date;
  readonly memory: ButlerMemory;
  probes(): HostProbe[];
  /** <state>/status/llm-usage.json (#40354) — null = none yet */
  fuelSnapshot(): UsageSnapshot | null;
  /** one bounded `eln usage status-cache` (the 연료관 refreshes a stale snapshot) */
  refreshFuel(): void;
  /** credential metadata (names · expiry · last refresh — never values) */
  credentials(): CredentialIn[];
  /** the existing secret-exposure scan in shadow mode (logs · decisions · context) */
  scanSecrets(): ExposureIn[];
  supervisors(): SupervisorIn[];
  /** start one trigger's graph now (detached) */
  restart(id: string): void;
  post(key: string, to: string, body: string): number | null;
  /** the heavy view (process lists per host · supply) — built only when a sub-agent needs it */
  heavy(): { view: GuardianView; ports: GuardianPorts; close(): void };
  beat(saw: number): void;
  /** ALLOCATION-BUDGET 임대관 — take back allocations whose TTL passed without a release (alloc.reclaim rows); returns ids */
  reclaimAllocations?(): string[];
  /** LLM-PHASE-BY-GUARDIAN — the 연료관's phase ports (absent = no phase evaluation, e.g. sim worlds without a pack). */
  fuelPhase?(sent: Readonly<Record<string, string>>, mark: (key: string, value: string) => void): import('./fuel-phase-run.js').FuelPhasePorts;
}
export interface PulseReport { readonly at: string; readonly level: string; readonly changes: WorldChange[]; readonly spawned: string[]; readonly reaped: string[]; readonly kpi: KpiRow[]; readonly route: string | null }

const pulseState = (sent: Record<string, string>): PulseState => {
  const s = emptyPulseState();
  for (const [k, v] of Object.entries(sent)) {
    if (k.startsWith('restart:')) s.restartedAt[k.slice(8)] = v;
    else if (k.startsWith('reattach:')) s.reattachAt[k.slice(9)] = v;
    else if (k.startsWith('fuel:')) s.fuelAlertAt[k.slice(5)] = v;
    else if (k === 'tick-wake') s.tickWokeAt = v;
  }
  return s;
};

export function runResidentPulse(d: PulseDeps): PulseReport {
  const at = d.now.toISOString(); const nowMs = d.now.getTime();
  const mem = d.memory; const level = mem.level().level;
  // ① aggregate (always — even shadow/off records the world)
  const prev = readPulseSnapshot(d.stateRoot);
  let world: WorldEntry[] = [...hostEntries(d.probes(), at), ...supervisorEntries(d.supervisors(), d.now), ...accountEntries(d.fuelSnapshot(), nowMs), ...credentialEntries(d.credentials(), nowMs)];
  const changes = diffWorld(prev?.world ?? [], world, at);
  if (changes.length) mem.appendCase({ at, kind: 'world', subject: `${changes.length} change(s)`, why: changes.slice(0, 8).map(c => `${c.kind}:${c.id} ${c.from ?? '∅'}→${c.to ?? '∅'}`).join(' · '), decidedBy: GUARDIAN_SEAT, supervisedBy: GUARDIAN_SUPERVISOR });
  let kpi: KpiRow[] = prev?.kpi ?? [];
  const report = (spawned: string[], reaped: string[], route: string | null): PulseReport => ({ at, level, changes, spawned, reaped, kpi, route });
  if (level === 'off' || level === 'shadow') { writePulseSnapshot(d.stateRoot, { at, world, kpi }); d.beat(changes.length); return report([], [], null); }
  // ② decide spawns
  const state = mem.readState();
  const lastSpawn: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.sent)) if (k.startsWith('spawn:')) lastSpawn[k.slice(6)] = v;
  // LLM-PHASE-BY-GUARDIAN: LLM-0 probe every tick — a level/phase/floor change spawns the 연료관 at once (event fuel-level).
  const phaseMarks: Record<string, string> = {};
  const phasePorts = d.fuelPhase?.(state.sent, (k, v) => { phaseMarks[k] = v; });
  let fuelLevel = false;
  if (phasePorts) { try { fuelLevel = (require('./fuel-phase-run.js') as typeof import('./fuel-phase-run.js')).fuelPhaseDue(phasePorts); } catch { fuelLevel = false; } }
  const due = dueSubAgents(worldEvents(world, { fuelLevel }), lastSpawn, nowMs);
  // ③ sub-agent runners (heavy view shared, built lazily, closed at the end)
  let heavy: ReturnType<PulseDeps['heavy']> | null = null;
  const H = () => (heavy ??= d.heavy());
  let proposedRoute: ReturnType<typeof pickHost> | null = null;
  const ps = pulseState(state.sent);
  const mine: Record<string, string> = {}; // sub-agents write their own state; the body merges only its marks at the end
  const runners: Partial<Record<SubAgentId, SubAgentRunner>> = {
    pulse: () => {
      const a = planPulse(world, ps, nowMs); const acts: string[] = [];
      for (const r of a.restart) {
        mine[`restart:${r.id}`] = at; try { d.restart(r.id); } catch { /* card still goes out */ }
        if (r.owner) d.post(`guardian-restart:${r.id}:${at.slice(0, 13)}`, r.owner, `[수호자·맥박 · 감독자 재기동] ${r.id} (${r.why}) — 한 번 다시 깨웠다(eln loop trigger tick --only ${r.id}). 30분 안에 또 멈추면 다시 알린다.`);
        acts.push(`restart ${r.id}`);
      }
      for (const r of a.reattach) {
        mine[`reattach:${r.id}`] = at;
        d.post(`guardian-reattach:${r.id}:${at.slice(0, 10)}`, r.owner ?? 'OP', `[수호자·맥박 → L0 · 재부착 제안] 감독자 ${r.id}: ${r.why}. 은퇴가 아니라 새 대상·목표로 다시 붙이자 — 목표/결과 탐침 갱신 또는 대상 칸 지정. 수호자는 끄지 않는다.`);
        acts.push(`reattach ${r.id}`);
      }
      const sups = world.filter(e => e.kind === 'supervisor'); const bad = sups.filter(e => e.status !== 'ok');
      const gone = world.filter(e => e.kind === 'host' && e.status === 'unreachable');
      return { kpi: { value: `감독자 결손 ${bad.length}/${sups.length} · 호스트 미응답 ${gone.length}`, ok: bad.length === 0 && gone.length === 0 }, actions: acts };
    },
    lease: () => {
      const h = H(); const r = runGuardian(h.view, h.ports, new Set(['scale']));
      proposedRoute = planGuardian(h.view).route;
      const over = r.kpi.overloaded;
      return { kpi: { value: `최대 load/ncpu ${r.kpi.maxRatio?.toFixed(2) ?? '?'}${over.length ? ` · 과부하 ${over.join(',')}` : ''} · 경로 제안 ${proposedRoute.host ?? '-'}`, ok: over.length === 0 }, actions: [...r.proposals, ...r.escalations] };
    },
    macrophage: () => {
      const h = H(); const r = runGuardian(h.view, h.ports, new Set(['sanitize']));
      const n = Object.values(r.reaped).reduce((a, b) => a + b, 0);
      return { kpi: { value: `고아 회수 ${n}${n ? ` (${Object.entries(r.reaped).map(([k, v]) => `${k} ${v}`).join(' ')})` : ''} · 남은 2h+ 고아 ${r.kpi.orphansOver2h - n}`, ok: r.kpi.orphansOver2h - n === 0 }, actions: n ? [`reaped ${n}`] : [] };
    },
    fuel: () => {
      const acts: string[] = [];
      if (judgeFuel(world).stale || !world.some(e => e.kind === 'account')) {
        try { d.refreshFuel(); acts.push('refresh'); } catch { /* keep the old numbers */ }
        world = [...world.filter(e => e.kind !== 'account'), ...accountEntries(d.fuelSnapshot(), nowMs)];
      }
      const v = judgeFuel(world);
      const hourly = (k: string) => !state.sent[k] || nowMs - Date.parse(state.sent[k]!) >= 60 * 60_000;
      for (const id of [...v.exhausted, ...v.low]) if (hourly(`fuel:${id}`)) {
        mine[`fuel:${id}`] = at;
        const e = world.find(x => x.id === id)!;
        d.post(`guardian-fuel:${id}:${at.slice(0, 13)}`, 'OP', `[수호자·연료관 · ${Math.round((e.facts.used as number) * 100)}%${e.facts.resetsIn ? ` · 리셋 ${String(e.facts.resetsIn)}` : ''}] ${id} — ${e.status === 'exhausted' ? '새 손 배정은 이미 다음 등급으로 우회 중(MODEL-BY-DIFFICULTY 상한 95%)' : '95% 에서 새 손 배정이 다음 등급으로 우회된다'}. 충전·계정 전환은 OP.`);
        acts.push(`alert ${id}`);
      }
      if (v.floorGone && hourly('fuel:floor')) {
        mine['fuel:floor'] = at;
        d.post(`guardian-fuel-floor:${at.slice(0, 13)}`, 'OP', `[수호자·연료관 · 🚨 바닥 소진] 손 사다리의 바닥(glm · OpenRouter)이 모두 소진 — 더 내려갈 등급이 없다. 충전 또는 다른 공급자 연결이 필요(OP).`);
        acts.push('floor-gone');
      }
      // LLM-PHASE-BY-GUARDIAN — levels ⊕ phase ⊕ floor overrides ⊕ CEO card (fuel-phase-run.ts).
      if (phasePorts) {
        try {
          const ph = (require('./fuel-phase-run.js') as typeof import('./fuel-phase-run.js')).runFuelPhase(phasePorts);
          acts.push(...ph.actions);
          return { kpi: { value: `${v.value} · ${ph.kpi.value}`, ok: v.ok === false || ph.kpi.ok === false ? false : v.ok ?? ph.kpi.ok }, actions: acts };
        } catch (e) { acts.push(`phase-failed ${String(e).slice(0, 80)}`); }
      }
      return { kpi: { value: v.value, ok: v.ok }, actions: acts };
    },
    keys: () => {
      const exposures = d.scanSecrets(); const acts: string[] = [];
      for (const x of exposures) {
        const k = `expose:${x.store}:${x.rowId}`;
        if (state.sent[k]) continue;
        mine[k] = at; d.post(`guardian-expose:${x.store}:${x.rowId}`, 'OP', exposureCard(x)); acts.push(`exposure ${x.store}:${x.rowId}`);
      }
      const v = judgeKeys(world, exposures);
      for (const id of v.stale) {
        const k = `key-stale:${id}`;
        if (state.sent[k] && nowMs - Date.parse(state.sent[k]!) < 6 * 60 * 60_000) continue;
        mine[k] = at;
        const e = world.find(x => x.id === id)!;
        d.post(`guardian-key-stale:${id}:${at.slice(0, 10)}`, 'OP', `[수호자·열쇠지기 · 자격 정지] ${id} — ${String(e.facts.why ?? 'stale')} (마지막 갱신 ${String(e.facts.lastRefresh ?? '없음')}). 재로그인/갱신은 주인 한 곳에서(memory codex-token-single-owner).`);
        acts.push(`stale ${id}`);
      }
      return { kpi: { value: v.value, ok: v.ok }, actions: acts };
    },
  };
  const ledger = memorySpawnLedger(mem);
  let ran: KpiRow[] = []; let reaped: string[] = [];
  try {
    ({ ran, reaped } = runSubAgents({ due, runners, ledger, now: d.now, resource: (spec) => (spec.id === 'lease' || spec.id === 'macrophage' ? `hosts:${LOCAL_HOSTS.join(',')},mshq` : 'local') }));
  } finally { (heavy as { close(): void } | null)?.close(); }
  for (const r of ran) mine[`spawn:${r.agent}`] = at;
  // ③b 임대관 — ALLOCATION-BUDGET leases past their TTL go back (LLM 0 · one ledger lock · fail-open)
  const reclaimed = (() => { try { return d.reclaimAllocations?.() ?? []; } catch { return []; } })();
  if (reclaimed.length) mem.appendCase({ at, kind: 'reap', subject: `alloc ${reclaimed.length}`, why: `TTL 지난 할당 회수: ${reclaimed.slice(0, 8).join(' ')}`, decidedBy: GUARDIAN_SEAT, supervisedBy: GUARDIAN_SUPERVISOR });
  kpi = [...kpi.filter(k => !ran.some(r => r.agent === k.agent)), ...ran];
  // ④ final load-switch decision: the body writes the route the 임대관 proposed (RES policy = thresholds; money = OP)
  const route = proposedRoute as ReturnType<typeof pickHost> | null;
  if (route && heavy) (heavy as { ports: GuardianPorts }).ports.writeRoute({ ...route, at });
  const fresh = mem.readState(); fresh.sent = { ...fresh.sent, ...mine, ...phaseMarks }; mem.writeState(fresh);
  writePulseSnapshot(d.stateRoot, { at, world, kpi });
  d.beat(changes.length + ran.length + reaped.length);
  return report(ran.map(r => `${r.agent}(${r.why})`), reaped, route?.host ?? null);
}

/** Live supervisors: the trigger registry (graph-backed loops · restartable) ⊕ watcher heartbeats. */
export function liveSupervisors(stateRoot: string, now: Date): SupervisorIn[] {
  const out: SupervisorIn[] = [];
  try {
    const tr = require('../loops/trigger-registry.js') as typeof import('../loops/trigger-registry.js');
    const db = tr.openTriggerRegistry(stateRoot);
    try {
      const outcomes = tr.listOutcomes(db);
      for (const t of tr.listTriggers(db)) {
        if (t.stage === 'retired') continue;
        out.push({ id: t.graphId, owner: t.owner ?? null, everyMin: t.cron ? null : (t.condition?.maxWaitMin ?? null), lastAt: t.lastAt, lastStatus: t.lastStatus,
          badSince: outcomes.get(t.graphId)?.bad ? outcomes.get(t.graphId)!.badSince : null, via: 'trigger' });
      }
    } finally { db.close(); }
  } catch { /* registry unreadable → no trigger rows this pulse */ }
  try {
    const hb = require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js');
    for (const v of hb.judgeWatchers(hb.readBeats(), now)) out.push({ id: `beat:${v.name}`, owner: null, everyMin: v.everyMin, lastAt: new Date(now.getTime() - v.ageMin * 60_000).toISOString(), lastStatus: v.status, badSince: null, via: 'beat', watcherStatus: v.status });
  } catch { /* no beats */ }
  return out;
}

export function livePulseDeps(now: Date = new Date()): PulseDeps & { close(): void } {
  const stateRoot = effectiveInstanceRoot();
  const { fileMemory } = require('../judge-butler/memory.js') as typeof import('../judge-butler/memory.js');
  const memory = fileMemory(stateRoot, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
  let store: import('../msg/msg-store.js').MsgStore | null = null;
  const msg = () => { if (!store) { const m = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js'); store = m.openMsgStore(m.defaultMsgStorePath()); } return store; };
  return {
    stateRoot, now, memory,
    probes: () => LOCAL_HOSTS.map(h => probeHost(h)),
    fuelSnapshot: () => {
      try {
        const u = require('../statusline/sources/llm-usage.js') as typeof import('../statusline/sources/llm-usage.js');
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        return u.parseLlmUsageSnapshot(readFileSync(u.llmUsageCachePath(), 'utf8')) as UsageSnapshot | null;
      } catch { return null; }
    },
    credentials: () => {
      try {
        const o = require('../oauth/store.js') as typeof import('../oauth/store.js');
        return o.listProviders().map(p => { const c = o.oauthConnectionStatus(p); return { provider: p, connected: c.connected, expiresAt: c.expiresAt, lastRefresh: c.lastRefresh }; });
      } catch { return []; }
    },
    scanSecrets: () => {
      try { return (require('../guardian/secret-exposure-scan.js') as typeof import('../guardian/secret-exposure-scan.js')).scanSecretExposures({ publish: false }).candidates; }
      catch { return []; }
    },
    refreshFuel: () => { require('node:child_process').spawnSync(process.execPath, [process.argv[1]!, 'usage', 'status-cache'], { stdio: 'ignore', timeout: 75_000 }); },
    supervisors: () => liveSupervisors(stateRoot, now),
    reclaimAllocations: () => (require('../allocation/alloc.js') as typeof import('../allocation/alloc.js')).reclaimExpired({ by: 'loop:guardian', now: () => now }),
    restart: (id) => { const c = spawn(process.execPath, [process.argv[1]!, 'loop', 'trigger', 'tick', '--only', id], { detached: true, stdio: 'ignore' }); c.unref(); },
    post: (key, to, body) => {
      try { const { appendOnce } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js'); const w = appendOnce(msg(), key, () => ({ from: GUARDIAN_SEAT, to, body, kind: 'request', intent: 'decision', refs: [key] })); return w.fresh ? w.mail.id : 0; }
      catch { return null; }
    },
    heavy: () => { const { guardianLive } = require('./live.js') as typeof import('./live.js'); return guardianLive(now); },
    beat: (saw) => { try { (require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js')).beatSafe({ name: 'guardian-pulse', saw, everyMin: 2, last: now.toISOString() }); } catch { /* fail-open */ } },
    // CREDIT-PACE-METERING: the live body must hand the 연료관 its phase ports — without this line (lost in the #40510 main
    // merge) no level/phase was ever evaluated live: «no guardian state yet» at 100 % with credits burning.
    fuelPhase: (sent, mark) => liveFuelPhasePorts(stateRoot, memory, now, sent, mark),
    close: () => { (store as { close(): void } | null)?.close(); },
  };
}

/** LLM-PHASE-BY-GUARDIAN live ports: the usage snapshot, codex credit balances (rotation candidates), the decision ledger, the
 *  guardian journal. Every reader fails open into «unknown» (a level with unknown input stays where it was). */
export function liveFuelPhasePorts(stateRoot: string, memory: ButlerMemory, now: Date, sent: Readonly<Record<string, string>>, mark: (key: string, value: string) => void): import('./fuel-phase-run.js').FuelPhasePorts {
  const j = require('../loop-agent/journal.js') as typeof import('../loop-agent/journal.js');
  const tz = (() => { try { return j.readJournalPolicy().tz; } catch { return 'Asia/Seoul'; } })();
  const decisions = () => { const m = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js'); return new m.DecisionLedger({ stateDir: stateRoot }); };
  return {
    now, day: j.dayKey(now, tz), sent, mark,
    usage: () => {
      try {
        const u = require('../statusline/sources/llm-usage.js') as typeof import('../statusline/sources/llm-usage.js');
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        return (u.parseLlmUsageSnapshot(readFileSync(u.llmUsageCachePath(), 'utf8')) as UsageSnapshot | null)?.accounts ?? null;
      } catch { return null; }
    },
    credits: () => {
      try {
        const s = require('../oauth/codex-account-store.js') as typeof import('../oauth/codex-account-store.js');
        return Object.fromEntries(s.inspectCodexRotation().candidates.map(c => [`openai-codex:${c.name}`, typeof c.creditBalance === 'number' ? c.creditBalance : null]));
      } catch { return {}; }
    },
    // No global maintenance signal yet: OP/CEO enter it with `eln policy override set --scope '*' --action mode:maintenance`.
    maintenance: () => false,
    raise: (card, ref) => { try { return decisions().raiseOnce({ ...card, options: [...card.options], refs: [...card.refs, ref], raisedBy: { ...card.raisedBy } }, ref).id; } catch { return null; } },
    decided: (id) => {
      try {
        const e = decisions().list({ status: 'all' }).find(x => x.id === id);
        if (!e || e.status === 'open') return null;
        if (e.status === 'withdrawn') return { choice: 'withdrawn', human: false };
        return { choice: e.choice ?? '', human: e.decidedBy?.kind === 'human' };
      } catch { return null; }
    },
    journal: (rows) => { j.appendJournal(memory.root, rows); },
  };
}
