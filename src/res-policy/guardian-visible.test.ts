// GUARDIAN-FINDINGS-VISIBLE — expectations are independent literals (rule 11): host names, times, verdicts, rule ids
// and card fragments are written out here, never derived from the product's constants or formatters.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextAction, shadowedCloudVm, writeShadowPair, type ShadowContext } from './auto-record.js';
import { resolveResPolicy } from './policy.js';
import { pregateInflightExcept, readPatrolState, runResPatrol, runResPatrolWith, type PatrolRunDeps } from './patrol-run.js';
import { guardianBoardLine, releaseWindowGuard, shadowCardStep } from './shadow-cards.js';
import { shadowAcceptance, shadowReport, shadowRows, type ShadowRow } from './shadow.js';
import { EMPTY_PATROL_STATE, type PatrolFinding } from './patrol.js';
import { parseResourceLedgerEvents, readResourceLedger, recordResDecision } from '../resource-ledger/resource-ledger.js';

const policy = resolveResPolicy(undefined);
// 2026-11-25 19:00 KST — outside the 04:00–06:30 KST release window.
const T0 = new Date('2026-11-25T10:00:00.000Z');
const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function ctx(over: Partial<ShadowContext> = {}): ShadowContext {
  return { policy, hosts: [], inflight: {}, idleSince: {}, spentTodayUsd: 0, now: T0, ...over };
}

describe('① auto-record at decision points', () => {
  test('fake pregate: own lock excluded, one other slot busy on minim5 → guardian allow ⊕ actual allow = one agreeing pair in the ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'res-auto-'));
    try {
      const inflightDir = join(root, 'inflight');
      mkdirSync(inflightDir);
      writeFileSync(join(inflightDir, 'aaaaaaaaaaaa-light.lock'), '4242 minim5 tok-self\n');
      writeFileSync(join(inflightDir, 'bbbbbbbbbbbb-full.lock'), '4343 minim5 tok-other\n');
      const inflight = pregateInflightExcept(inflightDir, () => true, 4242);
      // Source: 내부 문서 `LOOP-AGENTS` §2 rule 9 — «minim5» is a host-name fixture, not a numeric bound.
      expect(inflight).toEqual({ minim5: 1 });
      const ledger = join(root, 'ledger.jsonl');
      const action = contextAction('pregate', 'minim5', ctx({ inflight }));
      const pair = writeShadowPair({ action, actual: 'allow', actor: 'pregate.py', ref: 'pregate.py:aaaaaaaaaaaa' }, policy,
        { now: T0, record: (row, at) => recordResDecision(row, at, ledger) });
      expect(pair.agree).toBe(true);
      expect(pair.guardian.rule).toBe('pregate-slot-free');
      const rows = shadowRows(readResourceLedger(ledger));
      expect(rows.map((row) => `${row.source}:${row.decision}:${row.actor ?? '-'}`)).toEqual(['guardian:allow:-', 'res-tab:allow:pregate.py']);
      expect(rows[0]!.pairId).toBe(rows[1]!.pairId!);
      const report = shadowReport(rows, new Date('2026-11-25T09:00:00.000Z'));
      expect(report.paired).toBe(1);
      expect(report.agreementPercent).toBe(100);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('two slots already busy (own lock excluded) → guardian deny while pregate.py allowed = a false-critical disagreement', () => {
    const rows: Parameters<typeof recordResDecision>[0][] = [];
    const action = contextAction('pregate', 'node-b', ctx({ inflight: { 'node-b': 2, minim5: 0, 'node-c': 0 } }));
    const pair = writeShadowPair({ action, actual: 'allow', actor: 'pregate.py' }, policy, { now: T0, record: (row) => { rows.push(row); } });
    expect(pair.agree).toBe(false);
    expect(pair.guardian.verdict).toBe('deny');
    expect(rows[1]).toMatchObject({ source: 'res-tab', decision: 'allow', rule: 'actual:pregate.py', actor: 'pregate.py' });
  });
  test('vm-stop idle minutes come from the patrol idleSince; never seen idle = 0 minutes', () => {
    expect(contextAction('vm-stop', 'aws2', ctx({ idleSince: { aws2: '2026-11-25T09:25:00.000Z' } }))).toEqual({ kind: 'vm-stop', host: 'aws2', idleMinutes: 35 });
    expect(contextAction('vm-stop', 'aws3', ctx())).toEqual({ kind: 'vm-stop', host: 'aws3', idleMinutes: 0 });
  });
  test('vm-start pressure: every test host at load1 ≥ 40 → pressure true', () => {
    const hosts = ['minim5', 'node-b', 'node-c'].map((host) => ({ host, at: '2026-11-25T09:58:00.000Z', load1: 41 }));
    expect(contextAction('vm-start', 'aws1', ctx({ hosts }))).toEqual({ kind: 'vm-start', host: 'aws1', pressure: true, spentTodayUsd: 0 });
    expect(contextAction('vm-start', 'aws1', ctx())).toEqual({ kind: 'vm-start', host: 'aws1', pressure: false, spentTodayUsd: 0 });
  });
  test('shadowed cloud VM adapter records start/stop before the real call and passes status through', async () => {
    const calls: string[] = [];
    const adapter = {
      start: async (host: string) => { calls.push(`start ${host}`); },
      stop: async (host: string) => { calls.push(`stop ${host}`); },
      status: async (host: string) => ({ host, state: 'running' as const }),
    };
    const wrapped = shadowedCloudVm(adapter, 'fleet.cloud-burst', async (kind, host, actual, actor) => { calls.push(`record ${kind} ${host} ${actual} ${actor}`); return null; });
    await wrapped.start('aws2');
    await wrapped.stop('aws2');
    expect(await wrapped.status('aws2')).toEqual({ host: 'aws2', state: 'running' });
    expect(calls).toEqual(['record vm-start aws2 allow fleet.cloud-burst', 'start aws2', 'record vm-stop aws2 allow fleet.cloud-burst', 'stop aws2']);
  });
  test('ledger: actor round-trips; an empty actor is refused', () => {
    const line = (actor: string) => `${JSON.stringify({ event: 'res-decision', at: '2026-11-25T10:00:00.000Z',
      row: { source: 'res-tab', action: 'pregate', host: 'minim5', decision: 'allow', rule: 'actual:pregate.py', policyVersion: 'res-policy-v1', pairId: 'p1', actor } })}\n`;
    expect(parseResourceLedgerEvents(line('pregate.py'))).toHaveLength(1);
    expect(() => parseResourceLedgerEvents(line(''))).toThrow('invalid RES decision');
  });
});

describe('③ release-window guard', () => {
  test('04:00–06:30 KST forces shadow; 06:30 KST does not', () => {
    expect(releaseWindowGuard(new Date('2026-11-25T19:00:00.000Z'), [])).toBe('release-window 04:00–06:30 KST'); // 04:00 KST
    expect(releaseWindowGuard(new Date('2026-11-25T21:29:00.000Z'), [])).toBe('release-window 04:00–06:30 KST'); // 06:29 KST
    expect(releaseWindowGuard(new Date('2026-11-25T21:30:00.000Z'), [])).toBeNull(); // 06:30 KST
    expect(releaseWindowGuard(new Date('2026-11-25T18:59:00.000Z'), [])).toBeNull(); // 03:59 KST
  });
  test('a scheduled cut→publish in progress forces shadow until 30 min after publish; unreadable schedule forces shadow', () => {
    const schedules = [{ version: '0.3.36', cutAt: '2026-11-26T05:00:00.000Z', publishAt: '2026-11-26T07:00:00.000Z' }]; // 14:00 → 16:00 KST
    expect(releaseWindowGuard(new Date('2026-11-26T06:00:00.000Z'), schedules)).toBe('release 0.3.36 cut→publish in progress');
    expect(releaseWindowGuard(new Date('2026-11-26T07:30:00.000Z'), schedules)).toBe('release 0.3.36 cut→publish in progress');
    expect(releaseWindowGuard(new Date('2026-11-26T07:31:00.000Z'), schedules)).toBeNull();
    expect(releaseWindowGuard(new Date('2026-11-26T04:59:00.000Z'), schedules)).toBeNull();
    expect(releaseWindowGuard(new Date('2026-11-26T04:00:00.000Z'), null)).toBe('release-schedule-unreadable');
  });
});

describe('② shadow with cards — one batched card per 30 minutes', () => {
  const vmFinding: PatrolFinding = { key: 'unknown-vm-running:gcp3', rule: 'unknown-vm', subject: 'gcp3', severity: 'warn', detail: 'running cloud VM not in the RES policy — exception (no auto-stop)' };
  const memFinding: PatrolFinding = { key: 'memory-low:mshq', rule: 'memory-low', subject: 'mshq', severity: 'critical', detail: 'free memory 6% < 10%' };
  test('first finding cards at once; a new one 10 min later waits; at +30 min the batch goes, cleared ones marked', () => {
    const first = shadowCardStep(EMPTY_PATROL_STATE, [vmFinding], new Set([vmFinding.key]), false, T0, null);
    expect(first.card?.to).toBe('RES');
    expect(first.card?.body).toContain('❓ unknown-vm · gcp3 — running cloud VM not in the RES policy');
    expect(first.card?.body).toContain('행동 없음');
    const state1 = { ...EMPTY_PATROL_STATE, pending: first.pending, lastCardAt: first.lastCardAt!, lastCardTo: first.lastCardTo! };
    const second = shadowCardStep(state1, [memFinding], new Set([vmFinding.key, memFinding.key]), false, plus(10), null);
    expect(second.card).toBeNull();
    expect(second.pending.map((f) => f.key)).toEqual(['memory-low:mshq']);
    const state2 = { ...state1, pending: second.pending };
    const third = shadowCardStep(state2, [], new Set([vmFinding.key]), true, plus(30), 'release-window 04:00–06:30 KST');
    expect(third.card?.to).toBe('OP');
    expect(third.card?.body).toContain('🚨 memory-low · mshq — free memory 6% < 10% (cleared since)');
    expect(third.card?.body).toContain('강제 그림자: release-window 04:00–06:30 KST');
    expect(third.card?.body).toContain('eln res capsule');
    expect(third.pending).toEqual([]);
  });
  test('nothing pending = no card even when the window is due', () => {
    expect(shadowCardStep(EMPTY_PATROL_STATE, [], new Set(), false, T0, null).card).toBeNull();
  });
});

describe('② patrol run --shadow-cards (fake world: unknown VM gcp3 · no signals · no network)', () => {
  function world(root: string, overrides: Partial<PatrolRunDeps> = {}) {
    const cards: Array<{ to: string; body: string }> = [];
    let reaps = 0;
    let vmRuns = 0;
    const deps: PatrolRunDeps = {
      now: () => T0,
      config: () => ({}),
      ledger: () => [],
      processTable: () => [{ pid: 501, ppid: 1, pgid: 501, stat: 'S', tty: 'ttys001', rssKb: 1024, command: '/bin/zsh' }],
      localHost: () => 'mshq',
      inflightDir: () => join(root, 'none'),
      alive: () => true,
      cloud: async () => [{ id: '9100', name: 'gcp3', state: 'running', protected: null }],
      credentials: async () => [],
      statePath: () => join(root, 'state', 'state.json'),
      applyReap: async () => { reaps += 1; return { ok: true, detail: 'fake' }; },
      runVmCommand: () => { vmRuns += 1; return { status: 0, output: '' }; },
      recordDecision: () => {},
      postCard: (card) => { cards.push(card); },
      releaseSchedules: () => [],
      ...overrides,
    };
    return { deps, cards, counts: () => ({ reaps, vmRuns }) };
  }
  test('unknown VM gcp3 → one card to RES, Federation Board row, no actions; the next tick within 30 min stays quiet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'res-shadow-cards-'));
    try {
      const w = world(root);
      const first = await runResPatrolWith(w.deps, { shadowCards: true });
      expect(first.observeOnly).toBe(true);
      expect(first.carded).toBe('RES');
      expect(w.cards).toHaveLength(1);
      expect(w.cards[0]!.body).toContain('[수호자 · RES · 그림자] 정책 밖 1건 (critical 0 · warn 1)');
      expect(w.cards[0]!.body).toContain('unknown-vm · gcp3');
      const state = readPatrolState(join(root, 'state', 'state.json'));
      expect(guardianBoardLine(state, plus(1))).toBe('🛡 Guardian (shadow) — 0 critical · 1 warn: unknown-vm gcp3 · last card 10:00Z→RES');
      const second = await runResPatrolWith({ ...w.deps, now: () => plus(5) }, { shadowCards: true });
      expect(second.carded).toBeNull();
      expect(w.cards).toHaveLength(1);
      expect(w.counts()).toEqual({ reaps: 0, vmRuns: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('live mode inside 04:00–06:30 KST is forced to shadow: an allowed VM start is not executed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'res-forced-'));
    try {
      mkdirSync(join(root, 'inflight'));
      for (const [name, host] of [['a1', 'minim5'], ['a2', 'minim5'], ['b1', 'node-b'], ['b2', 'node-b'], ['c1', 'node-c'], ['c2', 'node-c']] as const)
        writeFileSync(join(root, 'inflight', `${name}-full.lock`), `7${name.charCodeAt(0)}${name.at(1)} ${host} tok\n`);
      const w = world(root, { now: () => new Date('2026-11-25T20:00:00.000Z'), // 05:00 KST
        config: () => ({ mode: 'live', vmStartCommand: 'echo start {host}' }), inflightDir: () => join(root, 'inflight'),
        cloud: async () => [{ id: 'i-05e66cd52ebd3a2c6', name: 'elanous-aws1', state: 'stopped', protected: null }] });
      const result = await runResPatrol(w.deps);
      expect(result.forcedShadow).toBe('release-window 04:00–06:30 KST');
      expect(result.mode).toBe('shadow');
      expect(result.vm).toEqual([{ host: 'aws1', action: 'vm-start', verdict: 'allow', rule: 'vm-start-within-budget', executed: false, detail: 'aws1: $2.40 projected ≤ $30 daily cap' }]);
      expect(w.counts()).toEqual({ reaps: 0, vmRuns: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('④ shadow-report acceptance --accept-min-samples', () => {
  const pairRows = (n: number, guardian: 'allow' | 'deny' | 'ask', actual: 'allow' | 'deny' | 'ask', start = 0): ShadowRow[] =>
    Array.from({ length: n }, (_, i) => [
      { at: '2026-11-25T10:00:00.000Z', source: 'guardian' as const, action: 'pregate', host: 'minim5', decision: guardian, rule: 'r', policyVersion: 'v', pairId: `p${start + i}` },
      { at: '2026-11-25T10:00:00.000Z', source: 'res-tab' as const, action: 'pregate', host: 'minim5', decision: actual, rule: 'actual:pregate.py', policyVersion: 'v', pairId: `p${start + i}`, actor: 'pregate.py' },
    ]).flat();
  const since = new Date('2026-11-25T09:00:00.000Z');
  test('10 agreeing pairs → PASS', () => {
    const acceptance = shadowAcceptance(shadowReport(pairRows(10, 'allow', 'allow'), since), 10);
    expect(acceptance.pass).toBe(true);
    expect(acceptance.agreementPercent).toBe(100);
  });
  test('9 agree + 1 guardian-deny/actual-allow → false-critical 1 → FAIL (agreement 90% still passes its own check)', () => {
    const acceptance = shadowAcceptance(shadowReport([...pairRows(9, 'allow', 'allow'), ...pairRows(1, 'deny', 'allow', 9)], since), 10);
    expect(acceptance.pass).toBe(false);
    expect(acceptance.falseCritical).toBe(1);
    expect(acceptance.checks.find((check) => check.name === 'agreement')?.pass).toBe(true);
  });
  test('guardian allow where the actual decision asked → missed-critical 1 → FAIL', () => {
    const acceptance = shadowAcceptance(shadowReport([...pairRows(10, 'allow', 'allow'), ...pairRows(1, 'allow', 'ask', 10)], since), 10);
    expect(acceptance.missedCritical).toBe(1);
    expect(acceptance.pass).toBe(false);
  });
  test('7 of 10 agree (70%) → agreement FAIL; 5 pairs < 10 samples → FAIL', () => {
    const low = shadowAcceptance(shadowReport([...pairRows(7, 'allow', 'allow'), ...pairRows(3, 'ask', 'deny', 7)], since), 10);
    expect(low.agreementPercent).toBe(70);
    expect(low.pass).toBe(false);
    const few = shadowAcceptance(shadowReport(pairRows(5, 'allow', 'allow'), since), 10);
    expect(few.checks.find((check) => check.name === 'samples')).toEqual({ name: 'samples', pass: false, detail: '5/10' });
    expect(few.pass).toBe(false);
  });
});
