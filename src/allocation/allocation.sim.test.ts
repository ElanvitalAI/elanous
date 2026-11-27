// ALLOCATION-BUDGET sim seeds — the allocator and the budget advisor against synthetic ledgers and snapshots
// (CEO 11-27: a seat floods → capped at its share while P0 is still granted · account near cap → step down · cut window
// reserve honored · expired lease reclaimed · budget tight → 정비 모드 · VM only when local is saturated · broken → repair).
// Expectations are literals; every ledger lives in a temp dir.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readResourceLedger } from '../resource-ledger/resource-ledger.js';
import { adviseBudget, proposalCard, type AdvisorHost } from './advisor.js';
import type { AllocBudgetPolicy } from './alloc-events.js';
import { grant, grantLlm, reclaimExpired } from './alloc.js';
import { budgetView, foldAllocations, type AllocUsageSnapshot } from './fold.js';
import { DEFAULT_ALLOC_POLICY } from './policy.js';

let dir: string; let path: string;
const T0 = new Date('2026-11-27T02:00:00.000Z'); // 11:00 KST
const CUT = new Date('2026-11-26T18:30:00.000Z'); // 03:30 KST
const snap = (codex: number, orLeft = 893, extra: AllocUsageSnapshot['accounts'] = []): AllocUsageSnapshot => ({ ts: T0.getTime(), accounts: [
  { provider: 'codex', account: 'team', usedPercent: codex, resetsIn: '2h 0m', status: 'ok' },
  { provider: 'openrouter', account: 'main', usedPercent: null, leftUsd: orLeft, status: 'ok' }, ...extra] });
const deps = (seat: string, now: Date, s: AllocUsageSnapshot) => ({ path, now: () => now, snapshot: () => s, env: { ELANOUS_TRACK: seat }, cwd: '/tmp' });
function writePolicy(p: Partial<AllocBudgetPolicy>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ event: 'alloc-budget-policy', at: '2026-11-26T00:00:00.000Z', by: 'RES', policy: { ...DEFAULT_ALLOC_POLICY, version: 'sim', ...p } })}\n`);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alloc-sim-')); path = join(dir, 'resource-ledger', 'events.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('seed 1 — a seat floods a scarce account', () => {
  test('capped at its share (stepped down) while its P0 request is still granted on the account', () => {
    const s = snap(85); // scarce (≥ 80) but under the work ceiling (95 × 90 % = 85.5)
    grantLlm({ provider: 'codex', purpose: 'work', estTokens: 1_000 }, deps('UX', T0, s));
    const tc = [1, 2, 3, 4].map(i => grantLlm({ provider: 'codex', purpose: 'work', estTokens: 1_000 }, deps('TC', new Date(T0.getTime() + i * 60_000), s)));
    expect(tc.map(t => `${t.mode}:${t.resource.type === 'llm' ? t.resource.provider : ''}`)).toEqual(['granted:codex', 'granted:codex', 'stepped-down:openrouter', 'stepped-down:openrouter']);
    expect(tc[2]!.reason).toBe('seat:TC 몫 67% > 40% (희소 codex 85%) → openrouter');
    const p0 = grantLlm({ provider: 'codex', purpose: 'p0-cell', ref: 'ALLOCATION-BUDGET', estTokens: 1_000 }, deps('TC', new Date(T0.getTime() + 5 * 60_000), s));
    expect([p0.status, p0.mode, p0.resource.type === 'llm' && p0.resource.provider]).toEqual(['granted', 'granted', 'codex']);
  });
});

describe('seed 2 — an account at its cap', () => {
  test('steps down to the cheaper provider', () => {
    const t = grantLlm({ provider: 'codex', purpose: 'work' }, deps('TC', T0, snap(96)));
    expect([t.mode, t.resource.type === 'llm' && t.resource.provider, t.reason]).toEqual(['stepped-down', 'openrouter', 'codex 창 96% ≥ 상한 95% → openrouter']);
  });
  test('nothing below → queued with the window refill ETA; P0 is overridden, never stalled', () => {
    const s = snap(96, 0);
    const w = grantLlm({ provider: 'codex', purpose: 'work' }, deps('TC', T0, s));
    expect([w.status, w.etaAt]).toEqual(['queued', '2026-11-27T04:00:00.000Z']);
    const p0 = grantLlm({ provider: 'codex', purpose: 'p0-cell' }, deps('TC', T0, s));
    expect([p0.status, p0.mode, p0.alerts]).toEqual(['granted', 'override', ['codex 창 96% ≥ 상한 95%']]);
    expect(foldAllocations(readResourceLedger(path), T0).map(r => r.state)).toEqual(['queued', 'active']);
  });
});

describe('seed 3 — the cut window reserve (KST 03:00–06:30)', () => {
  test('LLM: normal work leaves 20 % of the window for the cut; the cut itself gets the whole cap', () => {
    const s = snap(70); // work ceiling in the cut window = 95 × (90 − 20) % = 66.5
    const work = grantLlm({ provider: 'codex', purpose: 'work' }, deps('TC', CUT, s));
    expect([work.mode, work.reason]).toEqual(['stepped-down', 'codex 창 70% ≥ work 상한 66.5% (컷 창 예비 20%) → openrouter']);
    const cut = grantLlm({ provider: 'codex', purpose: 'cut' }, deps('REL', CUT, s));
    expect([cut.mode, cut.resource.type === 'llm' && cut.resource.provider]).toEqual(['granted', 'codex']);
    const day = grantLlm({ provider: 'codex', purpose: 'work' }, deps('TC', T0, s)); // 11:00 KST — no reserve
    expect(day.mode).toBe('granted');
  });
  test('host: work queues behind the reserve, the cut is granted', () => {
    writePolicy({ hostSlots: { 'node-b': 10 }, hostOrder: ['node-b'] });
    grant({ consumer: 'manual', purpose: 'cut', resource: { type: 'host', host: 'node-b', cpuSlots: 6 } }, deps('REL', CUT, snap(10)));
    const work = grant({ consumer: 'manual', purpose: 'work', resource: { type: 'host', host: 'node-b', cpuSlots: 2 } }, deps('TC', CUT, snap(10)));
    expect([work.status, work.reason]).toEqual(['queued', 'node-b 6+2 > 7 슬롯 (work)']);
    const cut = grant({ consumer: 'manual', purpose: 'cut', resource: { type: 'host', host: 'node-b', cpuSlots: 2 } }, deps('REL', CUT, snap(10)));
    expect([cut.status, cut.mode, cut.reason]).toEqual(['granted', 'granted', 'node-b 8/10 슬롯']);
  });
});

describe('seed 4 — an expired lease is reclaimed and its capacity comes back', () => {
  test('held past TTL blocks; after the guardian reclaims, the next request is granted', () => {
    writePolicy({ hostSlots: { nuc1: 4 }, hostOrder: ['nuc1'] });
    const t0 = grant({ consumer: 'manual', purpose: 'work', ttlMs: 10 * 60_000, resource: { type: 'host', host: 'nuc1', cpuSlots: 3 } }, deps('TC', T0, snap(10)));
    const later = new Date(T0.getTime() + 20 * 60_000);
    expect(grant({ consumer: 'manual', purpose: 'work', resource: { type: 'host', host: 'nuc1', cpuSlots: 2 } }, deps('UX', later, snap(10))).status).toBe('queued');
    expect(reclaimExpired({ path, now: () => later, by: 'loop:guardian' })).toEqual([t0.id]);
    const again = grant({ consumer: 'manual', purpose: 'work', resource: { type: 'host', host: 'nuc1', cpuSlots: 2 } }, deps('UX', later, snap(10)));
    expect([again.status, again.reason]).toEqual(['granted', 'nuc1 2/3 슬롯']);
  });
});

describe('budget advisor seeds', () => {
  const host = (h: string, load1: number, ncpu: number, extra: Partial<AdvisorHost> = {}): AdvisorHost => ({ host: h, reachable: true, load1, ncpu, ...extra });
  const base = (s: AllocUsageSnapshot, policy: AllocBudgetPolicy = DEFAULT_ALLOC_POLICY) => ({ budget: budgetView([], policy, s, T0), rows: [], policy, now: T0 });
  const queues = { landQueue: 4, readyCells: 5, judgeQueue: 1, handsIdle: 0 };

  test('budget tight → 정비 모드 proposed (guardian, in-policy); free again → 구현 모드', () => {
    const tight = snap(88, 893, [{ provider: 'claude', account: 'elanvital', usedPercent: 91, status: 'ok' }]);
    const p = adviseBudget({ ...base(tight), hosts: [], queues: null });
    expect(p.map(x => [x.id, x.route])).toEqual([['mode:maintenance', 'guardian']]);
    expect(p[0]!.why).toBe('LLM 빠듯 (claude 91% · codex 88%)');
    const free = adviseBudget({ ...base(snap(30), { ...DEFAULT_ALLOC_POLICY, mode: 'maintenance' }), hosts: [], queues: { ...queues, handsIdle: 2 } });
    expect(free.map(x => x.id)).toEqual(['mode:build']);
  });

  test('idle local host + full queue → no VM; every local host saturated → VM card for the CEO with cost', () => {
    const idle = adviseBudget({ ...base(snap(30)), hosts: [host('nuc1', 2, 18), host('node-b', 40, 32), host('aws1', 0, 0, { reachable: false, paid: true })], queues });
    expect(idle.filter(x => x.kind === 'vm')).toEqual([]);
    const policy = { ...DEFAULT_ALLOC_POLICY, vmHourlyUsd: { 'aws1': 0.5 } };
    const sat = adviseBudget({ ...base(snap(30), policy), hosts: [host('nuc1', 20, 18), host('node-b', 40, 32), host('aws1', 0, 0, { reachable: false, paid: true })], queues });
    const vm = sat.find(x => x.kind === 'vm')!;
    expect([vm.id, vm.route, vm.costUsd, vm.why]).toEqual(['vm:aws1', 'ceo', 1, '로컬 nuc1 1.1 · node-b 1.3 포화 · 대기 9 (준비 5 · 착지 4)']);
    const card = proposalCard(vm, '2026-11-27');
    expect([card.category, card.refs, card.recommendation.option]).toEqual(['money', ['alloc-advice:vm:aws1:2026-11-27'], 'a']);
  });

  test('broken route / unreachable host / errored account → repair proposals with owner and action', () => {
    const s = snap(30, 893, [{ provider: 'zai', account: 'glm', usedPercent: null, status: 'error' }]);
    const p = adviseBudget({ ...base(s), hosts: [host('nuc1', 2, 18), host('node-c', 0, 0, { reachable: false, why: 'ssh timeout' })], queues: null,
      routes: [{ id: 'judge-butler', healthy: false, owner: 'JUD', why: 'supervisor dead' }], accounts: s.accounts });
    expect(p.map(x => [x.id, x.route])).toEqual([['repair:host:node-c', 'guardian'], ['repair:account:zai:glm', 'guardian'], ['repair:route:judge-butler', 'guardian']]);
    expect(p[2]!.effect).toBe('judge-butler 로 가는 할당 정상화 (주인 JUD)');
  });

  test('prepaid runway short → top-up card (provider · amount · why · runway)', () => {
    const p = adviseBudget({ ...base(snap(30, 0)), hosts: [], queues: null });
    const t = p.find(x => x.kind === 'topup')!;
    expect([t.title, t.route, t.costUsd, t.why]).toEqual(['OpenRouter 크레딧 $350 충전', 'ceo', 350, '잔액 0 — 바닥 사다리(glm) 사라짐']);
  });
});
