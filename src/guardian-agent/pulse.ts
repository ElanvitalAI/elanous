// 수호자 — the THIN resident body (FEDERATION-ORG-SYSTEM-1127 v2 · GUARDIAN-CHARTER-1127 §4 ①): one LLM-0 pulse every trigger
// tick (≤ 2 min · trigger guardian-pulse) that only aggregates the world (host load/ncpu · supervisor heartbeats), keeps the
// sub-agent KPI table, decides which sub-agent to spawn (event or cadence — one spawn line each, the parent reaps) and makes
// the final load-switch decision (writes the route the 임대관 proposed). The heavy work runs inside the sub-agents.
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { ButlerMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SEAT, GUARDIAN_SUPERVISOR, planGuardian, runGuardian, type GuardianPorts, type GuardianView } from './body.js';
import { LOCAL_HOSTS, pickHost, probeHost, type HostProbe } from './hosts.js';
import { dueSubAgents, memorySpawnLedger, runSubAgents, worldEvents, type KpiRow, type SubAgentId, type SubAgentRunner } from './subagents.js';
import { accountEntries, annotateRoutes, judgeFuel, type FuelRoutes, type UsageSnapshot } from './fuel.js';
import { credentialEntries, judgeKeys, type CredentialIn, type ExposureIn } from './keys.js';
import { codexAuthMeta, credentialId, packCredentialHomes, refreshAdvanced, refreshDue, reloginCard, unrefreshedSoon, type KeyCard, type KeyRefreshResult } from '../kit/credential-keeper/index.js';
import { diffWorld, hostEntries, readPulseSnapshot, supervisorEntries, writePulseSnapshot, type SupervisorIn, type WorldChange, type WorldEntry } from './world.js';
import { gp, guardianDef, type GuardianSub } from './def.js';
import { mergeLadder, reconcileDetector, type DetectorObs, type LadderResult } from './ladder.js';
import { openGuardianSmart, type GuardianSmartReport } from './smart.js';
import { runKpiRollup } from '../kit/kpi/rollup.js';
import { runResourceCheck, type ActResult, type Row, type RunResult } from '../loop-agent/v3/resource-check.js';

export interface PulseDeps {
  readonly stateRoot: string;
  readonly now: Date;
  readonly memory: ButlerMemory;
  /** the guardian package dir (agent.yaml) — absent = the shipped graphs/loop-agents/guardian (sims run an edited copy) */
  readonly defDir?: string;
  probes(): HostProbe[];
  /** <state>/status/llm-usage.json (#40354) — null = none yet */
  fuelSnapshot(): UsageSnapshot | null;
  /** one bounded `eln usage status-cache` (the 연료관 refreshes a stale snapshot) */
  refreshFuel(): void;
  /** credential metadata (names · expiry · last refresh — never values) */
  credentials(): CredentialIn[];
  /** KEYS-PROACTIVE-REFRESH — refresh one credential home by the CLI's own flow (times in/out, never values) · absent = card only */
  refreshKey?(home: string): KeyRefreshResult;
  /** KEYS-PROACTIVE-REFRESH — one HITL card per ref in the decisions ledger (the id · null = not raised → mail fallback) */
  raiseKeyCard?(card: KeyCard, ref: string): string | null;
  /** the existing secret-exposure scan in shadow mode (logs · decisions · context) */
  scanSecrets(): ExposureIn[];
  supervisors(): SupervisorIn[];
  post(key: string, to: string, body: string): number | null;
  /** the heavy view (process lists per host · supply) — built only when a sub-agent needs it */
  heavy(): { view: GuardianView; ports: GuardianPorts; close(): void };
  beat(saw: number): void;
  /** ALLOCATION-BUDGET 임대관 — take back allocations whose TTL passed without a release (alloc.reclaim rows); returns ids */
  reclaimAllocations?(): string[];
  /** GUARDIAN-SUBS 우체국·레일지기 — the installed rail commit (install.json) · absent/null = unknown. */
  installedSha?(): string | null;
  /** GUARDIAN-SUBS 연료관 — per usage account (`codex:third`) whether the llm-accounts decision still routes its subscription
   *  (`routed`) or any path at all (`routable` · credits), by pack provider for the dry check · absent/null = unknown. */
  fuelRoutes?(): FuelRoutes | null;
  /** LLM-PHASE-BY-GUARDIAN — the 연료관's phase ports (absent = no phase evaluation, e.g. sim worlds without a pack). */
  fuelPhase?(sent: Readonly<Record<string, string>>, mark: (key: string, value: string) => void): import('./fuel-phase-run.js').FuelPhasePorts;
}
export interface PulseReport {
  readonly at: string; readonly level: string; readonly changes: WorldChange[]; readonly spawned: string[]; readonly reaped: string[]; readonly kpi: KpiRow[]; readonly route: string | null;
  /** GUARDIAN-SUBS: detector ladders this pulse (kit/case-ledger guardian-<sub>) — opened · acting · resolved · escalated */
  readonly cases?: LadderResult;
  /** GUARDIAN-V3-SMART: plan lines that changed an action · lessons created · knowhow promoted · retro written */
  readonly smart?: GuardianSmartReport;
  /** where the definition came from (agent.yaml · last-known-good) */
  readonly def?: string;
}

export function runResidentPulse(d: PulseDeps): PulseReport {
  const at = d.now.toISOString(); const nowMs = d.now.getTime();
  const mem = d.memory; const level = mem.level().level;
  // GUARDIAN-V3-SMART: the ONE definition (graphs/loop-agents/guardian/agent.yaml) — refused → last-known-good ⊕ one L0 card
  const def = guardianDef({ stateRoot: d.stateRoot, ...(d.defDir ? { dir: d.defDir } : {}) });
  const l0 = (() => { try { return (require('../loop-agent/v3/agent-yaml.js') as typeof import('../loop-agent/v3/agent-yaml.js')).supervisorSeat(def.compiled?.supervisor ?? { duty: 'resource-supervision' }, GUARDIAN_SUPERVISOR); } catch { return GUARDIAN_SUPERVISOR; } })();
  if (def.source !== 'agent.yaml') {
    try { const r = (require('../loop-agent/v3/agent-yaml.js') as typeof import('../loop-agent/v3/agent-yaml.js')).refusalReport(GUARDIAN_ID, def.errors, l0); d.post(r.key, r.to, `${r.body} · 지금 ${def.source === 'last-known-good' ? '마지막 정상 정의(agent.lkg.json)로 돈다' : '정의 없음 — 맥박이 멈춘다'}`); } catch { /* the pulse still runs */ }
  }
  // ① aggregate (always — even shadow/off records the world)
  const prev = readPulseSnapshot(d.stateRoot);
  // 연료관: an account the llm-accounts decision already took off the subscription route is normalized (phase-set), not a miss
  const routes = (() => { try { return d.fuelRoutes?.() ?? null; } catch { return null; } })();
  let creds: CredentialIn[] = (() => { try { return d.credentials(); } catch { return []; } })();
  let world: WorldEntry[] = [...hostEntries(d.probes(), at), ...supervisorEntries(d.supervisors(), d.now), ...annotateRoutes(accountEntries(d.fuelSnapshot(), nowMs), routes), ...credentialEntries(creds, nowMs)];
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
  // ③ the subs (CODE-BODY-TO-KIND): every sub runs on its shared kind (agent.yaml subs[].kind) — kpi-rollup (kit/kpi) or
  // resource-check (src/loop-agent/v3/resource-check.ts). What a sub looks at, what normal is, which card goes to whom with
  // what text and how often, and how its KPI reads are its params block; this body only gives the kinds its sensors (rows)
  // and its action ports (the effects, named by the agent.yaml action ids). The heavy view is shared, built lazily, closed at the end.
  let heavy: ReturnType<PulseDeps['heavy']> | null = null;
  const H = () => (heavy ??= d.heavy());
  let proposedRoute: ReturnType<typeof pickHost> | null = null;
  const mine: Record<string, string> = {}; // sub-agents write their own state; the body merges only its marks at the end
  // GUARDIAN-SUBS: every detector of a sub reconciles what it saw (kit/case-ledger) · GUARDIAN-V3-SMART: plan ⊕ outcome rows
  const smart = (() => { try { return openGuardianSmart({ stateRoot: d.stateRoot, now: d.now, def, l0, address: GUARDIAN_SEAT }); } catch { return null; } })();
  const ladders: LadderResult[] = [];
  const lports = { stateRoot: d.stateRoot, now: d.now, l0, by: GUARDIAN_SEAT, post: (k: string, to: string, b: string) => d.post(k, to, b) };
  const ladder = (sub: SubAgentId, detector: string, obs: readonly DetectorObs[], o: { complete?: boolean; ownCard?: boolean } = {}) => {
    const spec = def.subs.find(x => x.id === sub); const det = spec?.detectors.find(x => x.id === detector);
    if (!spec || !det) return;
    try { ladders.push(reconcileDetector({ sub: { id: sub, name: spec.name }, det, obs, ports: lports, ...o })); } catch { /* fail-open: the subject is seen again next spawn */ }
  };
  // ── sensors: the world rows ⊕ the rows derived from them (usage summary · pack providers · CLI credential homes · the
  //    credential summary · the exposure scan · the reap result). Unknown here (no sensor this spawn) = null.
  let exposures: ExposureIn[] | null = null;
  const scan = (): ExposureIn[] => (exposures ??= d.scanSecrets());
  let reapRows: Row[] | null = null;
  const pctOf = (e: WorldEntry) => (typeof e.facts.used === 'number' ? `${Math.round((e.facts.used as number) * 100)}%` : '?');
  const rows = (kind: string): readonly Row[] | null => {
    if (kind === 'fuel') {
      const v = judgeFuel(world); const has = world.some(e => e.kind === 'account');
      return [{ kind, id: 'llm-usage', owner: null, status: v.stale ? 'stale' : has ? 'ok' : 'missing', facts: { value: v.value, stale: v.stale, has, stuck: v.stuck, low: v.low, dry: v.dry, floorGone: v.floorGone } }];
    }
    if (kind === 'provider') {
      if (!routes) return null;
      const dry = judgeFuel(world).dry;
      return Object.keys(routes.providers).map(prov => ({ kind, id: prov, owner: null, status: dry.includes(prov) ? 'dry' : 'ok',
        facts: { route: routes.providers[prov]!.join(' → ') || '(크레딧만)', accounts: world.filter(e => e.kind === 'account' && e.facts.pack === prov).map(e => `${e.id} ${pctOf(e)}${e.facts.resetsIn ? ` 리셋 ${String(e.facts.resetsIn)}` : ''}`).join(' · ') } }));
    }
    if (kind === 'credential-home') return creds.filter(c => c.home).map(c => {
      const due = refreshDue(c, nowMs, { beforeH: gp('key_refresh_before_h'), afterDays: gp('key_refresh_after_days') });
      return { kind, id: credentialId(c), owner: null, status: due ? 'due' : 'ok', facts: { home: c.home, refreshable: c.refreshable ?? null, refreshDue: due } };
    });
    if (kind === 'keys') return [{ kind, id: 'credentials', owner: null, status: 'ok', facts: { value: judgeKeys(world, scan()).value, soon: unrefreshedSoon(creds, nowMs, gp('key_refresh_before_h')).map(credentialId) } }];
    if (kind === 'exposure') return scan().map(x => ({ kind, id: `${x.store}:${x.rowId}`, owner: null, status: 'exposed', facts: { ...x, prefixLen: x.prefix.length } }));
    if (kind === 'reap-host') return reapRows;
    return world.filter(e => e.kind === kind);
  };
  // ── action ports (the effects only — when, on what and how often is the sub's params block) ──
  const actPorts: Record<string, (row: Row) => ActResult> = {
    'route-away': (row) => {
      const routeTo = (proposedRoute ??= planGuardian(H().view).route).host;
      return { ok: !!routeTo && routeTo !== row.id, line: routeTo && routeTo !== row.id ? `new work → ${routeTo}` : 'no other host to route to' };
    },
    'refresh-fuel': () => {
      let refreshed: { ok: boolean; line: string };
      try { d.refreshFuel(); refreshed = { ok: true, line: 'eln usage status-cache' }; } catch (e) { refreshed = { ok: false, line: `refresh failed — ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` }; /* keep the old numbers */ }
      world = [...world.filter(e => e.kind !== 'account'), ...annotateRoutes(accountEntries(d.fuelSnapshot(), nowMs), routes)];
      const stale = judgeFuel(world).stale;
      smart?.record({ action: 'refresh-fuel', target: 'llm-usage', kind: 'fuel', ok: refreshed.ok && !stale, line: refreshed.ok && stale ? 'refreshed but still stale' : refreshed.line });
      return { ...refreshed, ...(refreshed.ok ? { log: 'refresh' } : {}) };
    },
    // KEYS-PROACTIVE-REFRESH: the CLI's own refresh → verified on disk (last_refresh moved) · a home this install cannot refresh has no port
    ...(d.refreshKey ? { 'refresh-key': (row: Row): ActResult => {
      const c = creds.find(x => credentialId(x) === row.id)!;
      let r: KeyRefreshResult;
      try { r = d.refreshKey!(c.home!); } catch (e) { r = { ok: false, before: { lastRefresh: c.lastRefresh, expiresAt: c.expiresAt }, after: { lastRefresh: c.lastRefresh, expiresAt: c.expiresAt }, line: `refresh threw (${String(e).slice(0, 80)})` }; }
      const ok = r.ok && refreshAdvanced(r);
      smart?.record({ action: 'refresh-key', target: row.id, kind: 'credential', ok, line: r.line.slice(0, 200), why: String(row.facts.refreshDue) });
      if (ok) {
        creds = creds.map(x => (x === c ? { ...x, expiresAt: r.after.expiresAt, lastRefresh: r.after.lastRefresh } : x));
        world = [...world.filter(e => e.kind !== 'credential'), ...credentialEntries(creds, nowMs)];
      }
      return { ok, line: r.line, log: `refresh ${row.id} ${ok ? 'ok' : 'failed'}` };
    } } : {}),
  };
  const runPorts: Record<string, () => RunResult | null> = {
    'scale-proposal': () => {
      const h = H(); const r = runGuardian(h.view, h.ports, new Set(['scale']));
      proposedRoute = planGuardian(h.view).route;
      return { facts: { maxRatio: r.kpi.maxRatio, overloaded: r.kpi.overloaded, route: proposedRoute.host }, log: [...r.proposals, ...r.escalations] };
    },
    reap: () => {
      const h = H(); const before = planGuardian(h.view).reap; const r = runGuardian(h.view, h.ports, new Set(['sanitize']));
      const n = Object.values(r.reaped).reduce((a, b) => a + b, 0);
      reapRows = [...h.view.procs.keys()].filter(host => h.view.procs.get(host) !== null).map(host => {
        const cands = before.get(host)?.length ?? 0; const killed = r.reaped[host] ?? 0; const skipped = r.skipped[host] ?? 0; const left = Math.max(0, cands - killed);
        if (cands) smart?.record({ action: 'reap', target: host, kind: 'host', ok: killed > 0 || skipped === 0, line: `killed ${killed} · skipped ${skipped} of ${cands}`, ...(killed === 0 && skipped ? { cause: `exact-PID reap skipped ${skipped} (changed/gone)` } : {}) });
        return { kind: 'reap-host', id: host, owner: null, status: left ? 'orphans' : 'ok', facts: { cands, killed, skipped, left } };
      });
      return { facts: { n, byHost: Object.entries(r.reaped).map(([k, v]) => `${k} ${v}`).join(' '), left: r.kpi.orphansOver2h - n }, log: n ? [`reaped ${n}`] : [] };
    },
    // LLM-PHASE-BY-GUARDIAN — levels ⊕ phase ⊕ floor overrides ⊕ CEO card (fuel-phase-run.ts) · no phase ports = not run
    'phase-set': () => {
      if (!phasePorts) return null;
      const ph = (require('./fuel-phase-run.js') as typeof import('./fuel-phase-run.js')).runFuelPhase(phasePorts);
      return { facts: { value: ph.kpi.value, ok: ph.kpi.ok }, log: ph.actions };
    },
  };
  const cardPorts: Record<string, (row: Row, act: ActResult | null) => { ref: string | null; log?: string }> = {
    // not refreshed: ONE relogin card (decisions ledger · mail when the ledger is not reachable)
    'relogin-card': (row, act) => {
      const ref = `guardian-key-relogin:${row.id}:${at}`;
      const owner = (() => { try { const co = require('../nexus/config/secrets/cred-owner.js') as typeof import('../nexus/config/secrets/cred-owner.js'); return co.readCredentialOwner(co.CODEX_CREDENTIAL_SLOT)?.ownerHost ?? null; } catch { return null; } })();
      const card = reloginCard(row.id, String(row.facts.home), String(row.facts.refreshDue), act?.line ?? '', owner ?? (require('node:os') as typeof import('node:os')).hostname().split('.')[0]!);
      const raised = (() => { try { return d.raiseKeyCard?.({ ...card, refs: [ref] }, ref) ?? null; } catch { return null; } })();
      const via = raised ?? (d.post(ref, 'OP', `[수호자·열쇠지기 · 재로그인 필요] ${card.title} — ${card.scqa.s} ${card.scqa.c} ${card.scqa.a}`) !== null ? `mail:${ref}` : null);
      return via ? { ref: raised ? `decision:${raised}` : via, log: `relogin-card ${row.id}` } : { ref: null };
    },
  };
  const runSub = (s: GuardianSub): ReturnType<SubAgentRunner> => {
    if (s.kind === 'kpi-rollup') {
      if (!s.kpiRollup) return { kpi: { value: `${s.id}: agent.yaml kpi_rollup 없음`, ok: null }, actions: [] };
      return { kpi: runKpiRollup(s.kpiRollup, { stateRoot: d.stateRoot, now: d.now, rows: world, installedSha: () => d.installedSha?.() ?? null }), actions: [] };
    }
    if (s.kind === 'resource-check' && s.resourceCheck) return runResourceCheck(s.resourceCheck, {
      at, nowMs, policies: def.policies, rows, sent: state.sent, mark: (k, v) => { mine[k] = v; }, post: (k, to, b) => d.post(k, to, b),
      act: (a, r) => actPorts[a]?.(r), run: a => runPorts[a]?.(), card: (a, r, x) => cardPorts[a]?.(r, x), ladder: (det, obs, o) => ladder(s.id, det, obs, o),
    });
    return { kpi: { value: `${s.id}: sub kind ${s.kind ?? '—'} 없음 (agent.yaml subs[].kind)`, ok: null }, actions: [] };
  };
  const runners: Partial<Record<SubAgentId, SubAgentRunner>> = Object.fromEntries(def.subs.map(s => [s.id, () => runSub(s)]));
  const ledger = memorySpawnLedger(mem);
  let ran: KpiRow[] = []; let reaped: string[] = [];
  try {
    ({ ran, reaped } = runSubAgents({ due, runners, ledger, now: d.now, resource: (spec) => ((spec as GuardianSub).resource === 'hosts' ? `hosts:${LOCAL_HOSTS.join(',')},mshq` : 'local') }));
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
  // GUARDIAN-V3-SMART: reflect → learn → knowhow · KPI history · retro (sub actions are judged when they return)
  const cases = mergeLadder(ladders);
  let smartReport: GuardianSmartReport | undefined;
  if (smart) {
    const un = (() => { try { return (require('../kit/case-ledger/index.js') as typeof import('../kit/case-ledger/index.js')).unnormalizedCases(d.stateRoot, d.now)?.open ?? null; } catch { return null; } })();
    smartReport = smart.finish(un);
  }
  d.beat(changes.length + ran.length + reaped.length);
  return { ...report(ran.map(r => `${r.agent}(${r.why})`), reaped, route?.host ?? null), cases, ...(smartReport ? { smart: smartReport } : {}), def: def.source };
}

/** 연료관 live routes: the llm-accounts decision (the same one the router · codex rotation read) → per usage account. */
export function liveFuelRoutes(now: Date = new Date()): FuelRoutes | null {
  try {
    const { llmAccountDecision } = require('../kit/resource-facts/llm-decide.js') as typeof import('../kit/resource-facts/llm-decide.js');
    const { USAGE_TO_PACK_PROVIDER } = require('./fuel-phase.js') as typeof import('./fuel-phase.js');
    const d = llmAccountDecision('guardian-fuel', now);
    if (!d.revision) return null;
    const back = Object.fromEntries(Object.entries(USAGE_TO_PACK_PROVIDER).map(([u, pk]) => [pk, u] as const));
    const accounts: Record<string, FuelRoutes['accounts'][string]> = {};
    for (const a of d.accounts) accounts[`${back[a.provider] ?? a.provider}:${a.account}`] = { pack: a.provider, routed: a.subscriptionRoutable, routable: a.routable, level: a.level };
    const providers: Record<string, string[]> = {};
    // the SUBSCRIPTION route (skipped accounts stay in llm-decide `route` only for their credits path)
    for (const a of d.accounts) providers[a.provider] = (d.route[a.provider] ?? []).filter(acc => d.accounts.some(x => x.provider === a.provider && x.account === acc && x.subscriptionRoutable));
    return { accounts, providers };
  } catch { return null; }
}

/** 열쇠지기 live credentials — metadata only. A named codex account's elanous row only points at its CODEX_HOME (no expiry,
 *  lastRefresh = the import time): its real refresh time and access expiry live in `<codexHome>/auth.json` (last_refresh ·
 *  the access JWT's `exp` claim — the payload is decoded for that one number, the token never leaves this function). */
/** Test seam: the store rows, the auth.json reader and the pack homes (defaults = live). */
type CredSources = {
  rows?: () => Array<{ provider: string; connected: boolean; expiresAt: number | null; lastRefresh: string | null; home: string | null }>;
  readAuth?: (path: string) => string;
  packHomes?: () => Array<{ account: string; home: string }>;
  real?: (h: string) => string;
};
export function liveCredentials(src: CredSources = {}): CredentialIn[] {
  const out: CredentialIn[] = [];
  const { realpathSync } = require('node:fs') as typeof import('node:fs');
  const real = src.real ?? ((h: string) => { try { return realpathSync(h); } catch { return h; } });
  const seen = new Set<string>();
  const meta = (h: string) => codexHomeMeta(h, src.readAuth);
  const storeRows = src.rows ?? (() => {
    const o = require('../oauth/store.js') as typeof import('../oauth/store.js');
    return o.listProviders().map(p => { const c = o.oauthConnectionStatus(p); return { provider: p, connected: c.connected, expiresAt: c.expiresAt, lastRefresh: c.lastRefresh, home: (() => { try { return o.loadTokens(p)?.codexHome ?? null; } catch { return null; } })() }; });
  });
  try {
    for (const c of storeRows()) {
      const p = c.provider; const home = c.home;
      const cli = home ? meta(home) : null;
      // Terra #40656 r1 ①: a CODEX_HOME row whose auth.json cannot be read is disconnected/unknown — never the store's numbers —
      // and is not `seen` (a pack-declared home at that path is still checked below)
      if (home && !cli) { out.push({ provider: p, connected: false, expiresAt: null, lastRefresh: null, home, refreshable: false }); continue; }
      if (home) seen.add(real(home));
      // Terra #40656 r2 ①: a readable CODEX_HOME is the only truth for its login — an undecodable exp / missing last_refresh stays
      // null (unknown), never the store row's numbers
      out.push(cli ? { provider: p, connected: cli.connected, expiresAt: cli.expiresAt, lastRefresh: cli.lastRefresh, home: home!, refreshable: cli.refreshable }
        : { provider: p, connected: c.connected, expiresAt: c.expiresAt, lastRefresh: c.lastRefresh });
    }
  } catch { /* store unreadable → only the pack-declared homes below */ }
  // KEYS-PROACTIVE-REFRESH: the homes the seats actually run on (llm-accounts pack · providers.<p>.accounts.<a>.homes · overlay)
  for (const h of (src.packHomes ?? packCredentialHomes)()) {
    if (seen.has(real(h.home))) continue;
    seen.add(real(h.home));
    const cli = meta(h.home);
    // Terra #40656 r1 ②: the id carries the normalized full path — two homes with one basename never share a cooldown
    out.push({ provider: `codex-home:${h.account}:${real(h.home)}`, connected: !!cli?.connected, expiresAt: cli?.expiresAt ?? null, lastRefresh: cli?.lastRefresh ?? null, home: h.home, refreshable: cli?.refreshable ?? false });
  }
  return out;
}
/** `<codexHome>/auth.json` → {connected · expiresAt (JWT exp ms) · lastRefresh · refreshable} — null when unreadable. Values never returned. */
export function codexHomeMeta(home: string, read?: (p: string) => string): { connected: boolean; expiresAt: number | null; lastRefresh: string | null; refreshable: boolean } | null {
  return codexAuthMeta(home, read);
}

/** Live supervisors: the trigger registry (graph-backed loops · the registry refires and cards) ⊕ watcher heartbeats. */
export function liveSupervisors(stateRoot: string, now: Date): SupervisorIn[] {
  const out: SupervisorIn[] = [];
  let retired: ReadonlySet<string> | null = null; // a retired (absorbed) trigger is history — neither its row nor its old beat is a supervisor
  try {
    const tr = require('../loops/trigger-registry.js') as typeof import('../loops/trigger-registry.js');
    const db = tr.openTriggerRegistry(stateRoot);
    try {
      const outcomes = tr.listOutcomes(db);
      retired = tr.retiredTriggerIds(db);
      for (const t of tr.listLiveTriggers(db)) {
        out.push({ id: t.graphId, owner: t.owner ?? null, everyMin: t.cron ? null : (t.condition?.maxWaitMin ?? null), lastAt: t.lastAt, lastStatus: t.lastStatus,
          badSince: outcomes.get(t.graphId)?.bad ? outcomes.get(t.graphId)!.badSince : null, via: 'trigger' });
      }
    } finally { db.close(); }
  } catch { /* registry unreadable → no trigger rows this pulse */ }
  try {
    const hb = require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js');
    for (const v of hb.judgeWatchers(hb.readBeats(), now, () => null, { retired })) out.push({ id: `beat:${v.name}`, owner: null, everyMin: v.everyMin, lastAt: new Date(now.getTime() - v.ageMin * 60_000).toISOString(), lastStatus: v.status, badSince: null, via: 'beat', watcherStatus: v.status });
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
    credentials: () => liveCredentials(),
    // KEYS-PROACTIVE-REFRESH: the CLI's own refresh, bounded, in a child (`eln loop guardian key-refresh --home <dir> --json`)
    refreshKey: (home) => {
      // the child is bounded by key_refresh_timeout_sec (agent.yaml); this spawn waits that plus the child's own start-up
      const r = require('node:child_process').spawnSync(process.execPath, [process.argv[1]!, 'loop', 'guardian', 'key-refresh', '--home', home, '--json'], { encoding: 'utf8', timeout: (gp('key_refresh_timeout_sec') + gp('key_refresh_timeout_sec')) * 1000 }) as { stdout?: string; status: number | null; error?: Error };
      try { return JSON.parse(String(r.stdout ?? '').trim().split('\n').pop() ?? '') as KeyRefreshResult; }
      catch { const m = codexHomeMeta(home); const t = { lastRefresh: m?.lastRefresh ?? null, expiresAt: m?.expiresAt ?? null }; return { ok: false, before: t, after: t, line: `key-refresh child rc=${r.status ?? '?'}${r.error ? ` ${r.error.message.slice(0, 60)}` : ''}` }; }
    },
    raiseKeyCard: (card, ref) => {
      try { const m = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js'); return new m.DecisionLedger({ stateDir: stateRoot }).raiseOnce({ ...card, options: [...card.options], refs: [...card.refs], raisedBy: { ...card.raisedBy } } as Parameters<InstanceType<typeof m.DecisionLedger>['raiseOnce']>[0], ref).id; }
      catch { return null; }
    },
    scanSecrets: () => {
      try { return (require('../guardian/secret-exposure-scan.js') as typeof import('../guardian/secret-exposure-scan.js')).scanSecretExposures({ publish: false }).candidates; }
      catch { return []; }
    },
    refreshFuel: () => { require('node:child_process').spawnSync(process.execPath, [process.argv[1]!, 'usage', 'status-cache'], { stdio: 'ignore', timeout: 75_000 }); },
    supervisors: () => liveSupervisors(stateRoot, now),
    installedSha: () => { try { const { installJsonCommit } = require('../land-graph/rail-watch.js') as typeof import('../land-graph/rail-watch.js'); return installJsonCommit((require('../cli/self-update.js') as typeof import('../cli/self-update.js')).defaultInstallRoot()); } catch { return null; } },
    fuelRoutes: () => liveFuelRoutes(now),
    reclaimAllocations: () => (require('../allocation/alloc.js') as typeof import('../allocation/alloc.js')).reclaimExpired({ by: 'loop:guardian', now: () => now }),
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
