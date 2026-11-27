// ALLOCATION-BUDGET — identity · purpose · ledger rows · fold · reports · policy. Expectations are literals (independent of
// the product's renderers); every ledger lives in a temp dir.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readResourceLedger } from '../resource-ledger/resource-ledger.js';
import { dispatchHeavyCheck, resolveGateRemoteSettings, type GateRemoteRunner } from '../self-implement/gate-remote.js';
import { grant, grantLlm, meterHost, reclaimExpired, release } from './alloc.js';
import type { AllocUsageSnapshot } from './fold.js';
import { allocSummaryLine, budgetView, byPeriod, byPurpose, byWho, foldAllocations, meteringKpi } from './fold.js';
import { proxySeatIdentity, resolveCallerIdentity, resolvePurpose } from './identity.js';
import { DEFAULT_ALLOC_POLICY, effectivePolicy, inCutWindow, kstDay, mergePolicy } from './policy.js';
import { adviseBudget } from './advisor.js';
import { reconcileMetering } from './reconcile.js';

let dir: string; let path: string;
const T0 = new Date('2026-11-27T02:00:00.000Z'); // 11:00 KST
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const SNAP: AllocUsageSnapshot = { ts: T0.getTime(), accounts: [
  { provider: 'codex', account: 'team', usedPercent: 40, status: 'ok' },
  { provider: 'openrouter', account: 'main', usedPercent: null, leftUsd: 893, status: 'ok' },
] };
const deps = (min: number, env: Record<string, string> = { ELANOUS_TRACK: 'TC' }, snap: AllocUsageSnapshot | null = SNAP) =>
  ({ path, now: () => at(min), snapshot: () => snap, env, cwd: '/tmp' });
const rows = (m = 0) => foldAllocations(readResourceLedger(path), at(m));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'alloc-')); path = join(dir, 'resource-ledger', 'events.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('identity — verified from the process context, never a label', () => {
  test('seat from ELANOUS_TRACK, then cwd seats/<SEAT>, then COORD_ID', () => {
    expect(resolveCallerIdentity({ ELANOUS_TRACK: 'op' }, '/x')).toEqual({ kind: 'seat', id: 'OP', source: 'env:ELANOUS_TRACK', chain: [{ kind: 'seat', id: 'OP', source: 'env:ELANOUS_TRACK' }] });
    expect(resolveCallerIdentity({}, '/Users/a/elanous-hq/seats/TC/.claude/wt/x').id).toBe('TC');
    expect(resolveCallerIdentity({ COORD_ID: 'ux' }, '/x').id).toBe('UX');
  });
  test('parent chain: seat → capsule → TA card; the principal is the innermost link', () => {
    const who = resolveCallerIdentity({ ELANOUS_TRACK: 'OP', ELANOUS_PARENT_RUN_ID: 'run-7', ELANOUS_TASK_CARD_ID: 'ALLOC-1' }, '/x');
    expect(who.kind).toBe('ta-card');
    expect(who.id).toBe('ALLOC-1');
    expect(who.chain.map(l => `${l.kind}:${l.id}`)).toEqual(['seat:OP', 'capsule:run-7', 'ta-card:ALLOC-1']);
  });
  test('loop agent id', () => {
    expect(resolveCallerIdentity({ ELANOUS_LOOP_ID: 'loop:guardian' }, '/x')).toMatchObject({ kind: 'loop-agent', id: 'loop:guardian' });
  });
  test('nothing resolvable → unattributed (not blocked)', () => {
    expect(resolveCallerIdentity({}, '/tmp')).toEqual({ kind: 'unattributed', id: 'unattributed', source: 'none', chain: [] });
    expect(proxySeatIdentity('local').kind).toBe('unattributed');
    expect(proxySeatIdentity('mk')).toMatchObject({ kind: 'seat', id: 'MK', source: 'proxy:seat' });
  });
  test('an els worker child pane does not inherit the folder seat', () => {
    expect(resolveCallerIdentity({ ELANOUS_ELS_PARENT_PANE: 'p1' }, '/h/seats/OP').kind).toBe('unattributed');
  });
});

describe('purpose — explicit, inferred, else unspecified', () => {
  const who = resolveCallerIdentity({ ELANOUS_TRACK: 'TC', ELANOUS_TASK_CARD_ID: 'CELL-9' }, '/x');
  test('explicit wins', () => { expect(resolvePurpose({ explicit: { kind: 'review', ref: '#40400' }, consumer: 'route-llm', who })).toEqual({ kind: 'review', ref: '#40400' }); });
  test('pregate → gate · TA card → work on that card', () => {
    expect(resolvePurpose({ consumer: 'pregate', who })).toEqual({ kind: 'gate', ref: 'CELL-9', inferred: true });
    expect(resolvePurpose({ consumer: 'route-llm', who })).toEqual({ kind: 'work', ref: 'CELL-9', inferred: true });
  });
  test('missing → unspecified', () => {
    expect(resolvePurpose({ consumer: 'route-llm', who: resolveCallerIdentity({ ELANOUS_TRACK: 'TC' }, '/x') })).toEqual({ kind: 'unspecified' });
  });
});

describe('ledger rows — reserve → grant → release on the lease ledger', () => {
  test('grant writes reserve + grant; release attributes caller usage and the real duration', () => {
    const t = grantLlm({ provider: 'codex', model: 'gpt-5', purpose: 'review', ref: '#40400', estTokens: 20_000 }, deps(0));
    expect(t.status).toBe('granted');
    expect(t.mode).toBe('granted');
    const lines = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l).event);
    expect(lines).toEqual(['alloc.reserve', 'alloc.grant']);
    expect(release(t.id, { inputTokens: 15_000, outputTokens: 3_000, billing: 'subscription' }, { ...deps(12), by: 'TC' })).toBe(true);
    const r = rows(12).find(x => x.id === t.id)!;
    expect(r.state).toBe('released');
    expect(r.durationMs).toBe(12 * 60_000);
    expect(r.usage).toEqual({ inputTokens: 15_000, outputTokens: 3_000, billing: 'subscription', basis: 'caller' });
    expect(release(t.id, null, deps(13))).toBe(false); // already closed
  });
  test('release without numbers → the ledger llm-proxy-call rows of that seat inside the window', () => {
    const t = grantLlm({ provider: 'openrouter', purpose: 'work' }, deps(0));
    mkdirSync(dirname(path), { recursive: true });
    const call = (min: number, seat: string, cost: number) => appendFileSync(path, `${JSON.stringify({ event: 'llm-proxy-call', at: at(min).toISOString(), host: 'mshq', seat, purpose: 'hand', model: 'z-ai/glm', inputTokens: 100, outputTokens: 50, costUsd: cost, costBasis: 'reported', status: 'ok' })}\n`);
    call(1, 'TC', 0.5); call(2, 'TC', 0.25); call(3, 'MK', 9);
    release(t.id, null, deps(5));
    expect(rows(5).find(x => x.id === t.id)!.usage).toEqual({ inputTokens: 200, outputTokens: 100, usd: 0.75, billing: 'paid', basis: 'llm-proxy-call' });
  });
  test('host meter: wall clock × slots on release when no numbers', () => {
    const t = meterHost({ host: 'node-b', cpuSlots: 2, consumer: 'pregate', purpose: 'gate', ref: 'self-gate' }, deps(0));
    expect(t.reason.startsWith('metered · allocator would: granted')).toBe(true);
    release(t.id, null, deps(30));
    expect(rows(30).find(x => x.id === t.id)!.usage).toEqual({ cpuMin: 60, host: 'node-b', basis: 'wall-clock' });
  });
  test('idempotent id returns the existing allocation without new rows', () => {
    grant({ id: 'seat-turn-TC-2026112711', consumer: 'seat-turn', resource: { type: 'llm', provider: 'codex' } }, deps(0));
    const again = grant({ id: 'seat-turn-TC-2026112711', consumer: 'seat-turn', resource: { type: 'llm', provider: 'codex' } }, deps(5));
    expect(again.id).toBe('seat-turn-TC-2026112711');
    expect(readFileSync(path, 'utf8').trim().split('\n').length).toBe(2);
  });
  test('a malformed ledger never throws at the caller — ticket says unrecorded', () => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, '{not json\n');
    expect(grantLlm({ provider: 'codex' }, deps(0)).status).toBe('unrecorded');
  });
  test('an invalid alloc row is refused by the ledger parser', () => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ event: 'alloc.reserve', at: T0.toISOString(), id: 'x', who: { kind: 'boss', id: 'me', source: 'typed', chain: [] } })}\n`);
    expect(() => readResourceLedger(path)).toThrow('resource ledger invalid alloc event at line 1');
  });
});

describe('reports — who · purpose · period · KPI · budget · summary', () => {
  test('by identity, purpose, KST hour; unattributed/unspecified KPI', () => {
    grantLlm({ provider: 'codex', purpose: 'work', estTokens: 3_000 }, deps(0));
    grantLlm({ provider: 'codex', purpose: 'review', estTokens: 1_000 }, deps(1, { ELANOUS_TRACK: 'UX' }));
    grantLlm({ provider: 'codex', estTokens: 1_000 }, deps(2, {}));
    const rs = rows(3); const p = DEFAULT_ALLOC_POLICY;
    expect(byWho(rs, p).map(g => [g.key, g.grants, Math.round(g.share * 100)])).toEqual([['seat:TC', 1, 60], ['seat:UX', 1, 20], ['unattributed', 1, 20]]);
    expect(byPurpose(rs, p).map(g => g.key)).toEqual(['work', 'review', 'unspecified']);
    expect(byPeriod(rs, 'hour', p).map(g => g.key)).toEqual(['2026-11-27T11h']);
    expect(meteringKpi(rs)).toEqual({ total: 3, unattributed: 1, unspecified: 1, unattributedShare: 1 / 3, unspecifiedShare: 1 / 3 });
  });
  test('budget: paid today vs daily cap with the 80 % alert; summary line', () => {
    const t = grantLlm({ provider: 'openrouter', purpose: 'work' }, deps(0));
    release(t.id, { usd: 42, billing: 'paid' }, deps(10));
    const b = budgetView(rows(10), DEFAULT_ALLOC_POLICY, SNAP, at(10));
    expect(b.day).toBe('2026-11-27');
    expect(b.paidTodayUsd).toBe(42);
    expect(b.paidAlert).toBe('유료 오늘 $42.00/$50 (≥80%)');
    expect(b.rows.find(r => r.provider === 'codex')!.usedPct).toBe(40);
    expect(allocSummaryLine(rows(10), DEFAULT_ALLOC_POLICY, SNAP, at(10)))
      .toBe('예산: codex 40% · openrouter $893 (오늘 $42/$50) · 상위 소비 seat:TC 100% · 미귀속 0% · 목적 미상 0% · ⚠ 유료 오늘 $42.00/$50 (≥80%)');
  });
});

describe('policy — data on the ledger, defaults only as fallback', () => {
  test('a trusted row overrides; an untrusted writer is ignored', () => {
    const ev = (by: string, paidDailyCapUsd: number) => ({ event: 'alloc-budget-policy', at: T0.toISOString(), by, policy: { ...DEFAULT_ALLOC_POLICY, version: `v-${by}`, paidDailyCapUsd } });
    expect(effectivePolicy([]).source).toBe('default');
    expect(effectivePolicy([ev('RES', 80)]).paidDailyCapUsd).toBe(80);
    expect(effectivePolicy([ev('RES', 80), ev('TC', 999)]).paidDailyCapUsd).toBe(80);
  });
  test('cut window is KST 03:00–06:30', () => {
    expect(inCutWindow(DEFAULT_ALLOC_POLICY, new Date('2026-11-26T18:00:00Z'))).toBe(true); // 03:00 KST
    expect(inCutWindow(DEFAULT_ALLOC_POLICY, new Date('2026-11-26T21:29:00Z'))).toBe(true); // 06:29 KST
    expect(inCutWindow(DEFAULT_ALLOC_POLICY, new Date('2026-11-26T21:30:00Z'))).toBe(false); // 06:30 KST
    expect(kstDay(new Date('2026-11-26T15:00:00Z'))).toBe('2026-11-27');
  });
});

describe('reconcile — metered totals vs the provider snapshot', () => {
  test('window share rose ≥ 5 % with no metered allocation → drift alert', () => {
    const first = reconcileMetering([], [], SNAP, at(0));
    expect(first.rows.find(r => r.provider === 'codex')!.why).toBe('첫 대조 또는 스냅숏 없음');
    const later: AllocUsageSnapshot = { ...SNAP, accounts: [{ provider: 'codex', account: 'team', usedPercent: 52, status: 'ok' }] };
    const second = reconcileMetering([first], [], later, at(60));
    expect(second.rows.find(r => r.provider === 'codex')).toEqual({ provider: 'codex', meteredUsd: 0, meteredTokens: 0, grants: 0, providerUsedPct: 52, deltaUsedPct: 12, alert: true, why: '창 +12% 인데 미터링 0건 — 할당기 밖 소비' });
  });
});

describe('reclaim — the guardian takes back expired leases', () => {
  test('only active allocations past TTL', () => {
    const a = grantLlm({ provider: 'codex', ttlMs: 10 * 60_000 }, deps(0));
    const b = grantLlm({ provider: 'codex', ttlMs: 120 * 60_000 }, deps(0));
    expect(reclaimExpired({ ...deps(30), by: 'loop:guardian' })).toEqual([a.id]);
    const rs = rows(30);
    expect(rs.find(r => r.id === a.id)!.state).toBe('reclaimed');
    expect(rs.find(r => r.id === b.id)!.state).toBe('active');
    expect(reclaimExpired(deps(31))).toEqual([]);
  });
});

describe('pregate hook — the remote check placement is metered (never blocks)', () => {
  test('start on the dispatched host before the run; end after it (busy outcome → no run ms)', async () => {
    const calls: string[] = [];
    const runner: GateRemoteRunner = {
      local(_cmd, args) {
        if (args[0] === 'cat-file') return { rc: 0, stdout: 'commit\n', stderr: '' };
        if (args[0] === 'rev-parse') return { rc: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
        return { rc: 0, stdout: '', stderr: '' };
      },
      ssh(host) { calls.push(`ssh ${host}`); return { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY=3\n' }; },
    };
    const settings = resolveGateRemoteSettings({ hostCaps: { nuc1: 3 }, slotWaitSeconds: 0 }, {});
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote: 'nuc1' }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { throw new Error('local gate must not run'); } },
      { runner, settings, env: {}, load1: 1, write: { out: () => {}, err: () => {} },
        allocMeter: { start: (host, tool) => { calls.push(`start ${host} ${tool}`); return 'al-1'; }, end: (id, ms) => { calls.push(`end ${id} ${ms}`); } } });
    expect(calls[0]).toBe('start nuc1 self-gate');
    expect(calls.at(-1)).toBe('end al-1 null');
    expect(calls.slice(1, -1)).not.toEqual([]);
    expect(calls.slice(1, -1).every(c => c === 'ssh nuc1')).toBe(true);
  });
});

describe('review fixes — no double attribution · closed ids · partial policy · paid estimate · settle day · unmeasured host', () => {
  const call = (min: number, model: string) => appendFileSync(path, `${JSON.stringify({ event: 'llm-proxy-call', at: at(min).toISOString(), host: 'mshq', seat: 'TC', purpose: 'hand', model, inputTokens: 10, outputTokens: 1, costUsd: 0.1, costBasis: 'reported', status: 'ok' })}\n`);
  test('overlapping allocations of one seat never count a proxy call twice; a direct provider takes no routed call', () => {
    const a = grantLlm({ provider: 'openrouter' }, deps(0));
    const b = grantLlm({ provider: 'openrouter' }, deps(1));
    const c = grantLlm({ provider: 'codex' }, deps(1));
    call(2, 'z-ai/glm'); call(3, 'z-ai/glm');
    release(a.id, null, deps(4));
    call(5, 'z-ai/glm');
    release(b.id, null, deps(6));
    release(c.id, null, deps(6));
    const rs = rows(6);
    expect(rs.find(r => r.id === a.id)!.usage!.inputTokens).toBe(20);
    expect(rs.find(r => r.id === b.id)!.usage!.inputTokens).toBe(10);
    expect(rs.find(r => r.id === c.id)!.usage).toEqual({ basis: 'none' });
  });
  test('a closed id is never handed back as a live grant', () => {
    const t = grant({ id: 'seat-turn-TC-h', consumer: 'seat-turn', resource: { type: 'llm', provider: 'codex' } }, deps(0));
    release(t.id, null, deps(1));
    expect(grant({ id: 'seat-turn-TC-h', consumer: 'seat-turn', resource: { type: 'llm', provider: 'codex' } }, deps(2)).status).toBe('closed');
  });
  test('a partial policy keeps the rest of nested maps', () => {
    const p = mergePolicy(DEFAULT_ALLOC_POLICY, { providers: { openrouter: { dailyUsd: 80 } } });
    expect(p.providers.openrouter).toEqual({ paid: true, dailyUsd: 80, estUsdPerGrant: 0.25 });
    expect(p.providers.codex).toEqual({ windowCapPct: 95, stepDownTo: 'openrouter' });
  });
  test('a paid request without an estimate reserves estUsdPerGrant — the daily cap stops unbounded grants', () => {
    const t = grantLlm({ provider: 'openrouter', purpose: 'work' }, deps(0));
    expect(rows(0).find(r => r.id === t.id)!.amount).toEqual({ usd: 0.25 });
  });
  test('spend lands on the KST day it was settled', () => {
    const late = (m: number) => ({ ...deps(0), now: () => new Date(Date.parse('2026-11-27T14:50:00.000Z') + m * 60_000) }); // 23:50 KST
    const t = grantLlm({ provider: 'openrouter', purpose: 'work' }, late(0));
    release(t.id, { usd: 3, billing: 'paid' }, late(20)); // 00:10 KST next day
    const next = new Date('2026-11-27T15:30:00.000Z');
    expect(budgetView(foldAllocations(readResourceLedger(path), next), DEFAULT_ALLOC_POLICY, SNAP, next).paidTodayUsd).toBe(3);
  });
  test('advisor: an unmeasured reachable local host blocks the VM proposal', () => {
    const p = adviseBudget({ budget: budgetView([], DEFAULT_ALLOC_POLICY, SNAP, T0), rows: [], policy: DEFAULT_ALLOC_POLICY, now: T0, queues: { landQueue: 5, readyCells: 5, judgeQueue: 0, handsIdle: 0 },
      hosts: [{ host: 'node-b', reachable: true, load1: 40, ncpu: 32 }, { host: 'nuc1', reachable: true, load1: null, ncpu: null }] });
    expect(p.filter(x => x.kind === 'vm')).toEqual([]);
  });
});
