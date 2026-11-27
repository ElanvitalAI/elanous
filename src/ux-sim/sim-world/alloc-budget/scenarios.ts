// SIM-WORLD alloc-budget — ALLOCATION-BUDGET on the kernel contract (CEO 11-27 11:0x · 11:1x · 11:2x · «시뮬레이션 월드에서 다 충분히 검증»).
// Device ALLOC-LEDGER = the real allocator / metering / advisor code against a lease ledger inside the scenario's universe
// (LLM 0 · no network · no probes). Each scenario draws its numbers from the seed (ctx.random) and pins one property:
// flood capped at its share while P0 is granted · near-cap step-down / queue / P0 override · cut window reserve · TTL reclaim
// · unattributed caller metered and flagged (never blocked) · mode shift / VM only when saturated / repair · metering chain.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { adviseBudget, type AdvisorHost } from '../../../allocation/advisor.js';
import type { AllocBudgetPolicy } from '../../../allocation/alloc-events.js';
import { grant, grantLlm, meterHost, reclaimExpired, release, type AllocDeps } from '../../../allocation/alloc.js';
import { allocSummaryLine, budgetView, byPeriod, byPurpose, byWho, foldAllocations, meteringKpi, type AllocUsageSnapshot } from '../../../allocation/fold.js';
import { DEFAULT_ALLOC_POLICY, effectivePolicy } from '../../../allocation/policy.js';
import { reconcileMetering } from '../../../allocation/reconcile.js';
import { readResourceLedger, recordAllocEventsWith } from '../../../resource-ledger/resource-ledger.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE = 'ALLOC-LEDGER';
const T0 = new Date('2026-11-27T02:00:00.000Z'); // 11:00 KST
const CUT = new Date('2026-11-26T18:30:00.000Z'); // 03:30 KST
const min = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

export interface AllocLedgerDevice {
  readonly path: string;
  deps(seat: string | null, now: Date, snap: AllocUsageSnapshot | null, extraEnv?: Record<string, string>): AllocDeps;
  writePolicy(p: Partial<AllocBudgetPolicy>): void;
  rows(now: Date): ReturnType<typeof foldAllocations>;
  events(): { event: string }[];
}

export const simWorldDevices: readonly SimWorldDeviceDef<AllocLedgerDevice>[] = [{
  id: DEVICE,
  title: 'ALLOCATION-BUDGET — allocator · metering · budget advisor on a lease ledger inside the scenario universe (LLM 0)',
  create: (ctx) => {
    const path = join(ctx.universeRoot, 'resource-ledger', 'events.jsonl');
    return {
      path,
      deps: (seat, now, snap, extraEnv = {}) => ({ path, now: () => now, snapshot: () => snap, env: { ...(seat ? { ELANOUS_TRACK: seat } : {}), ...extraEnv }, cwd: '/' }),
      writePolicy: (p) => { recordAllocEventsWith(path, () => [{ event: 'alloc-budget-policy', at: '2026-11-26T00:00:00.000Z', by: 'RES', policy: { ...DEFAULT_ALLOC_POLICY, version: 'sim', ...p } }]); },
      rows: (now) => foldAllocations(readResourceLedger(path), now),
      events: () => readResourceLedger(path),
    };
  },
}];

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const snap = (codex: number, orLeft = 893, extra: AllocUsageSnapshot['accounts'] = []): AllocUsageSnapshot => ({ ts: T0.getTime(), accounts: [
  { provider: 'codex', account: 'team', usedPercent: codex, resetsIn: '2h 0m', status: 'ok' },
  { provider: 'openrouter', account: 'main', usedPercent: null, leftUsd: orLeft, status: 'ok' }, ...extra] });
const between = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const llmProvider = (t: { resource: { type: string; provider?: string } }) => (t.resource.type === 'llm' ? t.resource.provider : '-');

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'ALLOC-FLOOD',
    title: 'one seat floods a scarce account → capped at its share (stepped down); its P0 is still granted on the account',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const used = between(ctx.random, 80, 85); // scarce, under the work ceiling 85.5
      const s = snap(used);
      const n = between(ctx.random, 6, 12);
      grantLlm({ provider: 'codex', purpose: 'work', estTokens: 1_000 }, d.deps('UX', T0, s));
      grantLlm({ provider: 'codex', purpose: 'work', estTokens: 1_000 }, d.deps('MK', min(T0, 1), s));
      const flood = Array.from({ length: n }, (_, i) => grantLlm({ provider: 'codex', purpose: 'work', estTokens: 1_000 }, d.deps('TC', min(T0, 2 + i), s)));
      const p0 = grantLlm({ provider: 'codex', purpose: 'p0-cell', ref: 'ALLOCATION-BUDGET', estTokens: 1_000 }, d.deps('TC', min(T0, 3 + n), s));
      const day = d.rows(min(T0, 4 + n)).filter(r => r.resource.type === 'llm' && r.resource.provider === 'codex' && r.purpose.kind !== 'p0-cell');
      const tcShare = byWho(day, DEFAULT_ALLOC_POLICY).find(g => g.key === 'seat:TC')?.share ?? 0;
      ctx.recorder.event('alloc:flood', { used, n, modes: flood.map(t => t.mode), p0: p0.mode, tcShareOnCodex: Math.round(tcShare * 100) });
      if (flood.some(t => t.status !== 'granted')) return fail('flood-stalled', 'a flood request was queued although a cheaper provider had room');
      if (!flood.slice(-3).every(t => t.mode === 'stepped-down' && llmProvider(t) === 'openrouter')) return fail('flood-not-capped', `tail modes ${flood.slice(-3).map(t => t.mode).join(',')}`);
      // TC can reach the cap only once (a share computed over the rows seen so far) — never run away with the account
      if (tcShare * 100 > 60) return fail('share-exceeded', `TC holds ${Math.round(tcShare * 100)}% of codex`);
      if (p0.status !== 'granted' || llmProvider(p0) !== 'codex') return fail('p0-stalled', `p0 ${p0.status}/${p0.mode} on ${llmProvider(p0)}`);
      return { ok: true };
    },
  },
  {
    id: 'ALLOC-NEAR-CAP',
    title: 'account at its cap → step down; nothing below → queue with the refill ETA; P0 overridden, never stalled',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const used = between(ctx.random, 95, 99);
      const down = grantLlm({ provider: 'codex', purpose: 'work' }, d.deps('TC', T0, snap(used)));
      const dry = snap(used, 0);
      const q = grantLlm({ provider: 'codex', purpose: between(ctx.random, 0, 1) ? 'review' : 'voice' }, d.deps('UX', T0, dry));
      const p0 = grantLlm({ provider: 'codex', purpose: 'p0-cell' }, d.deps('OP', T0, dry));
      const cut = grantLlm({ provider: 'codex', purpose: 'cut' }, d.deps('REL', T0, dry));
      ctx.recorder.event('alloc:near-cap', { used, down: [down.mode, llmProvider(down)], queued: [q.status, q.etaAt], p0: p0.mode, cut: cut.mode });
      if (down.mode !== 'stepped-down' || llmProvider(down) !== 'openrouter') return fail('no-step-down', `${down.status}/${down.mode} → ${llmProvider(down)}`);
      if (q.status !== 'queued' || q.etaAt !== '2026-11-27T04:00:00.000Z') return fail('no-queue-eta', `${q.status} eta ${q.etaAt}`);
      if (p0.mode !== 'override' || cut.mode !== 'override') return fail('urgent-stalled', `p0 ${p0.mode} · cut ${cut.mode}`);
      return { ok: true };
    },
  },
  {
    id: 'ALLOC-CUT-RESERVE',
    title: 'cut window (KST 03:00–06:30) leaves 20 % reserve: normal work steps down / queues, the cut gets the whole cap',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const used = between(ctx.random, 67, 85); // ≥ work ceiling in the window (66.5) and < work ceiling by day (85.5)
      const s = snap(used);
      const work = grantLlm({ provider: 'codex', purpose: 'work' }, d.deps('TC', CUT, s));
      const cut = grantLlm({ provider: 'codex', purpose: 'cut' }, d.deps('REL', CUT, s));
      const day = grantLlm({ provider: 'codex', purpose: 'work' }, d.deps('TC', T0, s));
      const cap = between(ctx.random, 8, 12);
      d.writePolicy({ hostSlots: { 'node-b': cap }, hostOrder: ['node-b'] });
      const limit = Math.floor(cap * 0.7 + 1e-9);
      grant({ consumer: 'manual', purpose: 'cut', resource: { type: 'host', host: 'node-b', cpuSlots: limit } }, d.deps('REL', CUT, s));
      const hostWork = grant({ consumer: 'manual', purpose: 'work', resource: { type: 'host', host: 'node-b', cpuSlots: 1 } }, d.deps('TC', CUT, s));
      const hostCut = grant({ consumer: 'manual', purpose: 'cut', resource: { type: 'host', host: 'node-b', cpuSlots: cap - limit } }, d.deps('REL', CUT, s));
      ctx.recorder.event('alloc:cut-reserve', { used, work: work.mode, cut: cut.mode, day: day.mode, cap, limit, hostWork: hostWork.status, hostCut: hostCut.status });
      if (work.mode !== 'stepped-down') return fail('reserve-ignored', `work in the cut window ${work.status}/${work.mode} at ${used}%`);
      if (cut.mode !== 'granted' || llmProvider(cut) !== 'codex') return fail('cut-starved', `cut ${cut.status}/${cut.mode}`);
      if (day.mode !== 'granted') return fail('reserve-outside-window', `work at 11:00 KST ${day.mode}`);
      if (hostWork.status !== 'queued') return fail('host-reserve-ignored', `host work ${hostWork.status}`);
      if (hostCut.status !== 'granted' || hostCut.mode !== 'granted') return fail('host-cut-starved', `host cut ${hostCut.status}/${hostCut.mode}`);
      return { ok: true };
    },
  },
  {
    id: 'ALLOC-TTL-RECLAIM',
    title: 'a lease past its TTL holds capacity until the guardian reclaims it; then the next request is granted',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const cap = between(ctx.random, 3, 6);
      d.writePolicy({ hostSlots: { 'minim5': cap }, hostOrder: ['minim5'] });
      const limit = Math.floor(cap * 0.9 + 1e-9);
      const ttl = between(ctx.random, 5, 30);
      const held = grant({ consumer: 'ta-launch', purpose: 'work', ttlMs: ttl * 60_000, resource: { type: 'host', host: 'minim5', cpuSlots: limit } }, d.deps('TC', T0, null));
      const later = min(T0, ttl + 1);
      const before = grant({ consumer: 'ta-launch', purpose: 'work', resource: { type: 'host', host: 'minim5', cpuSlots: 1 } }, d.deps('UX', later, null));
      const early = reclaimExpired({ path: d.path, now: () => min(T0, ttl - 1) });
      const got = reclaimExpired({ path: d.path, now: () => later });
      const after = grant({ consumer: 'ta-launch', purpose: 'work', resource: { type: 'host', host: 'minim5', cpuSlots: 1 } }, d.deps('UX', later, null));
      const state = d.rows(later).find(r => r.id === held.id)?.state;
      ctx.recorder.event('alloc:ttl', { cap, ttl, before: before.status, early, reclaimed: got, after: after.status, state });
      if (before.status !== 'queued') return fail('expired-not-counted', `before reclaim ${before.status}`);
      if (early.length) return fail('reclaimed-early', `reclaimed before TTL: ${early.join(' ')}`);
      if (got.length !== 1 || got[0] !== held.id || state !== 'reclaimed') return fail('not-reclaimed', `reclaimed ${got.join(' ')} · state ${state}`);
      if (after.status !== 'granted') return fail('capacity-not-back', `after reclaim ${after.status}`);
      return { ok: true };
    },
  },
  {
    id: 'ALLOC-UNATTRIBUTED',
    title: 'an unknown caller is metered as «unattributed», flagged in the KPI and the summary line — never blocked',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const known = between(ctx.random, 2, 6); const unknown = between(ctx.random, 1, 3);
      const s = snap(30);
      for (let i = 0; i < known; i++) grantLlm({ provider: 'codex', purpose: 'work', estTokens: 1_000 }, d.deps('TC', min(T0, i), s));
      const anon = Array.from({ length: unknown }, (_, i) => grantLlm({ provider: 'codex', estTokens: 1_000 }, d.deps(null, min(T0, known + i), s)));
      const rows = d.rows(min(T0, 30));
      const kpi = meteringKpi(rows);
      const line = allocSummaryLine(rows, DEFAULT_ALLOC_POLICY, s, min(T0, 30));
      const pct = Math.round((unknown / (known + unknown)) * 100);
      ctx.recorder.event('alloc:unattributed', { known, unknown, kpi, line });
      if (anon.some(t => t.status !== 'granted')) return fail('unattributed-blocked', anon.map(t => t.status).join(','));
      if (anon.some(t => t.who.kind !== 'unattributed' || t.purpose.kind !== 'unspecified')) return fail('label-trusted', 'an empty-context caller got an identity or purpose');
      if (kpi.unattributed !== unknown || kpi.unspecified !== unknown) return fail('kpi-miscount', `kpi ${kpi.unattributed}/${kpi.unspecified} vs ${unknown}`);
      if (!line.includes(`미귀속 ${pct}%`) || !line.includes(`목적 미상 ${pct}%`)) return fail('summary-hides-kpi', line);
      return { ok: true };
    },
  },
  {
    id: 'ALLOC-MODE-SHIFT',
    title: 'budget advisor: LLM tight → 정비 모드 · free → 구현 모드 · VM only when every local host is saturated · broken → repair',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const policy = effectivePolicy(d.events());
      const host = (h: string, load1: number, ncpu: number, extra: Partial<AdvisorHost> = {}): AdvisorHost => ({ host: h, reachable: true, load1, ncpu, ...extra });
      const view = (s: AllocUsageSnapshot, p: AllocBudgetPolicy = policy) => ({ budget: budgetView([], p, s, T0), rows: [], policy: p, now: T0 });
      const tight = snap(between(ctx.random, 85, 94), 893, [{ provider: 'claude', account: 'a', usedPercent: between(ctx.random, 85, 94), status: 'ok' }]);
      const free = snap(between(ctx.random, 10, 40), 893, [{ provider: 'claude', account: 'a', usedPercent: between(ctx.random, 10, 40), status: 'ok' }]);
      const backlog = { landQueue: between(ctx.random, 3, 8), readyCells: between(ctx.random, 3, 8), judgeQueue: 1, handsIdle: 0 };
      const toMaint = adviseBudget({ ...view(tight), hosts: [], queues: null }).map(p => p.id);
      const toBuild = adviseBudget({ ...view(free, { ...policy, mode: 'maintenance' }), hosts: [], queues: { ...backlog, landQueue: 1, judgeQueue: 0, handsIdle: 2 } }).map(p => p.id);
      const idleLoad = between(ctx.random, 1, 9);
      const idle = adviseBudget({ ...view(free), hosts: [host('minim5', idleLoad, 18), host('node-b', 40, 32), host('aws1', 0, 0, { reachable: false, paid: true })], queues: backlog }).map(p => p.id);
      const sat = adviseBudget({ ...view(free), hosts: [host('minim5', 18 + idleLoad, 18), host('node-b', 40, 32), host('aws1', 0, 0, { reachable: false, paid: true })], queues: backlog });
      const broken = adviseBudget({ ...view(free), hosts: [host('node-c', 0, 0, { reachable: false, why: 'ssh timeout' })], routes: [{ id: 'judge-butler', healthy: false, owner: 'JUD', why: 'supervisor dead' }], queues: null }).map(p => p.id);
      ctx.recorder.event('alloc:advisor', { toMaint, toBuild, idle, sat: sat.map(p => `${p.id}:${p.route}`), broken });
      if (!toMaint.includes('mode:maintenance')) return fail('no-maintenance', toMaint.join(','));
      if (!toBuild.includes('mode:build')) return fail('no-build', toBuild.join(','));
      if (idle.some(id => id.startsWith('vm:'))) return fail('vm-while-idle', idle.join(','));
      const vm = sat.find(p => p.kind === 'vm');
      if (!vm || vm.route !== 'ceo') return fail('no-vm-when-saturated', sat.map(p => p.id).join(','));
      if (!broken.includes('repair:host:node-c') || !broken.includes('repair:route:judge-butler')) return fail('no-repair', broken.join(','));
      return { ok: true };
    },
  },
  {
    id: 'ALLOC-METERING',
    title: 'metering: identity chain · purpose · period · actual usage from the ledger · daily reconcile drift',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<AllocLedgerDevice>(DEVICE);
      const s = snap(40);
      const t = grantLlm({ provider: 'openrouter' }, d.deps('OP', T0, s, { ELANOUS_PARENT_RUN_ID: 'run-7', ELANOUS_TASK_CARD_ID: 'CELL-9' }));
      const calls = between(ctx.random, 1, 5);
      for (let i = 0; i < calls; i++) appendFileSync(d.path, `${JSON.stringify({ event: 'llm-proxy-call', at: min(T0, i + 1).toISOString(), host: 'mshq', seat: 'OP', purpose: 'hand', model: 'z-ai/glm', inputTokens: 100, outputTokens: 10, costUsd: 0.01, costBasis: 'reported', status: 'ok' })}\n`);
      const h = meterHost({ host: 'node-b', cpuSlots: 2, consumer: 'pregate', ref: 'self-gate' }, d.deps('TC', T0, s));
      const dur = between(ctx.random, 5, 40);
      release(t.id, null, d.deps('OP', min(T0, dur), s));
      release(h.id, null, d.deps('TC', min(T0, dur), s));
      const rows = d.rows(min(T0, dur));
      const rt = rows.find(r => r.id === t.id)!; const rh = rows.find(r => r.id === h.id)!;
      const purposes = byPurpose(rows, DEFAULT_ALLOC_POLICY).map(g => g.key).sort();
      const hours = byPeriod(rows, 'hour', DEFAULT_ALLOC_POLICY).map(g => g.key);
      const first = reconcileMetering(d.events(), rows, s, min(T0, dur));
      const second = reconcileMetering([...d.events(), first], [], snap(55), min(T0, dur + 60));
      ctx.recorder.event('alloc:metering', { chain: rt.who.chain.map(l => `${l.kind}:${l.id}`), purposes, hours, usage: rt.usage, cpu: rh.usage, drift: second.rows.find(r => r.provider === 'codex') });
      if (rt.who.chain.map(l => `${l.kind}:${l.id}`).join(' → ') !== 'seat:OP → capsule:run-7 → ta-card:CELL-9') return fail('chain-lost', JSON.stringify(rt.who.chain));
      if (purposes.join(',') !== 'gate,work') return fail('purpose-not-inferred', purposes.join(','));
      if (hours.join(',') !== '2026-11-27T11h') return fail('period-wrong', hours.join(','));
      if (rt.durationMs !== dur * 60_000) return fail('duration-wrong', `${rt.durationMs}`);
      const u = rt.usage!;
      if (u.basis !== 'llm-proxy-call' || u.inputTokens !== 100 * calls || u.billing !== 'paid') return fail('usage-unattributed', JSON.stringify(u));
      if (rh.usage?.cpuMin !== dur * 2 || rh.usage.basis !== 'wall-clock') return fail('cpu-unmetered', JSON.stringify(rh.usage));
      if (second.rows.find(r => r.provider === 'codex')?.alert !== true) return fail('drift-missed', JSON.stringify(second.rows));
      return { ok: true };
    },
  },
];
