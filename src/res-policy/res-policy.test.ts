// RES-POLICY-GUARDIAN — expectations are independent literals (rule 11): host names, thresholds, rule ids and
// percentages are written out here, never derived from DEFAULT_RES_POLICY or the product's formatters.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideResAction, resolveResPolicy } from './policy.js';
import { evaluatePatrol, EMPTY_PATROL_STATE, patrolCard, type PatrolHost, type PatrolSnapshot } from './patrol.js';
import { shadowReport, type ShadowRow } from './shadow.js';
import { buildResCapsuleBrief } from './capsule.js';
import { credentialsFromUsageJson, localBunUsage, parseDarwinMemory, parseLinuxMemory, pregateInflight, patrolVms, runResPatrol, type PatrolRunDeps } from './patrol-run.js';
import { parseResourceLedgerEvents, readResourceLedger, recordResDecision } from '../resource-ledger/resource-ledger.js';
import { parseBunUsage } from '../resource-ledger/host-readiness-collector.js';
import type { ChainPlan } from '../tui/restart-chain.js';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { buildUserConfig, saveUserConfig } from '../user-config.js';

const policy = resolveResPolicy(undefined);
const T0 = new Date('2026-11-25T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('policy allows / denies', () => {
  test('pre-approved test hosts need no RES approval in the test universe', () => {
    for (const host of ['minim5', 'node-b', 'node-c'])
      expect(decideResAction(policy, { kind: 'test', host })).toMatchObject({ verdict: 'allow', rule: 'pre-approved-test-host' });
  });
  test('hand tests on mshq are denied with test-host alternatives', () => {
    const decision = decideResAction(policy, { kind: 'test', host: 'mshq' });
    expect(decision.verdict).toBe('deny');
    expect(decision.rule).toBe('forbidden-test-host');
    expect(decision.alternatives).toEqual(['minim5', 'node-b', 'node-c']);
  });
  test('ops universe on a test host and unknown hosts go to RES', () => {
    expect(decideResAction(policy, { kind: 'test', host: 'minim5', universe: 'ops' })).toMatchObject({ verdict: 'ask', rule: 'ops-universe-needs-res' });
    expect(decideResAction(policy, { kind: 'test', host: 'aws1' })).toMatchObject({ verdict: 'ask', rule: 'cloud-host-needs-budget' });
    expect(decideResAction(policy, { kind: 'test', host: 'user-laptop' })).toMatchObject({ verdict: 'ask', rule: 'unknown-host' });
  });
  test('pregate slot cap 2: one in flight allowed, two in flight denied with free alternatives', () => {
    expect(decideResAction(policy, { kind: 'pregate', host: 'minim5', inflight: 1 })).toMatchObject({ verdict: 'allow', rule: 'pregate-slot-free' });
    // Host-name keys stay quoted: the public export redacts private host literals, and an unquoted key is an identifier it must not rewrite.
    // Source: 내부 문서 `LOOP-AGENTS` §2 rule 9 — «minim5/node-c» are host-name fixtures, not numeric bounds.
    const full = decideResAction(policy, { kind: 'pregate', host: 'minim5', inflight: 2, inflightByHost: { minim5: 2, 'node-b': 2, 'node-c': 0 } });
    expect(full).toMatchObject({ verdict: 'deny', rule: 'pregate-slot-full' });
    expect(full.alternatives).toEqual(['node-c']);
    expect(decideResAction(policy, { kind: 'pregate', host: 'mshq', inflight: 0 })).toMatchObject({ verdict: 'deny', rule: 'forbidden-test-host' });
  });
  test('VM start within the $30/day budget is allowed; over the cap goes to RES; always-on is forbidden', () => {
    // 1.2 $/h × 2 h = 2.4 → 10 + 2.4 = 12.4 ≤ 30
    expect(decideResAction(policy, { kind: 'vm-start', host: 'aws1', pressure: true, spentTodayUsd: 10 })).toMatchObject({ verdict: 'allow', rule: 'vm-start-within-budget' });
    // 28 + 2.4 = 30.4 > 30
    expect(decideResAction(policy, { kind: 'vm-start', host: 'aws1', pressure: true, spentTodayUsd: 28 })).toMatchObject({ verdict: 'ask', rule: 'vm-budget-cap' });
    expect(decideResAction(policy, { kind: 'vm-start', host: 'aws1', pressure: false, spentTodayUsd: 0 })).toMatchObject({ verdict: 'deny', rule: 'vm-no-pressure' });
    expect(decideResAction(policy, { kind: 'vm-keep-on', host: 'gcp1' })).toMatchObject({ verdict: 'deny', rule: 'forbidden-always-on-vm' });
    expect(decideResAction(policy, { kind: 'vm-stop', host: 'aws2', idleMinutes: 30 })).toMatchObject({ verdict: 'allow', rule: 'vm-idle-stop' });
    expect(decideResAction(policy, { kind: 'vm-stop', host: 'aws2', idleMinutes: 29 })).toMatchObject({ verdict: 'deny', rule: 'vm-not-idle' });
  });
  test('config overrides apply; ill-typed fields fall back to the code default', () => {
    // Source: 내부 문서 `LOOP-AGENTS` §2 rule 9 — «minim5/node-c» are host-name fixtures, not numeric bounds.
    const custom = resolveResPolicy({ policy: { defaultPregateSlots: 3, pregateSlots: { minim5: 1, 'node-b': 'four' }, load: { warnLoad1: -5, criticalLoad1: 70 }, preApprovedTestHosts: 'minim5' } });
    expect(custom.defaultPregateSlots).toBe(3);
    // Source: 내부 문서 `LOOP-AGENTS` §2 rule 9 — «minim5/node-c» are host-name fixtures, not numeric bounds.
    expect(custom.pregateSlots).toEqual({ minim5: 1 });
    expect(custom.load.warnLoad1).toBe(60);
    expect(custom.load.criticalLoad1).toBe(70);
    expect(custom.preApprovedTestHosts).toEqual(['minim5', 'node-b', 'node-c']);
    expect(decideResAction(custom, { kind: 'pregate', host: 'minim5', inflight: 1 })).toMatchObject({ verdict: 'deny', rule: 'pregate-slot-full' });
  });
});

const emptySnapshot: PatrolSnapshot = { hosts: [], chains: [], pregateInflight: {}, vms: [], vmSpentTodayUsd: 0 };
const host = (name: string, load1: number, extra: Partial<PatrolHost> = {}) => ({ host: name, at: T0.toISOString(), load1, memoryAvailablePercent: 50, ...extra });

describe('patrol thresholds trigger once', () => {
  test('load 61 warns once, stays quiet while it holds, clears, then fires again', () => {
    const s1 = { ...emptySnapshot, hosts: [host('minim5', 61)] };
    const r1 = evaluatePatrol(s1, policy, EMPTY_PATROL_STATE, at(0));
    expect(r1.fresh.map((f) => f.key)).toEqual(['load-warn:minim5']);
    const r2 = evaluatePatrol(s1, policy, r1.next, at(5));
    expect(r2.fresh).toEqual([]);
    expect(r2.findings.map((f) => f.key)).toEqual(['load-warn:minim5']);
    const r3 = evaluatePatrol({ ...emptySnapshot, hosts: [host('minim5', 20)] }, policy, r2.next, at(10));
    expect(r3.cleared).toEqual(['load-warn:minim5']);
    const r4 = evaluatePatrol(s1, policy, r3.next, at(15));
    expect(r4.fresh.map((f) => f.key)).toEqual(['load-warn:minim5']);
  });
  test('the 11-25 crisis (load 759 · 733 bun processes on 54 panes · chains to end · 4% free) fires every alarm', () => {
    const leak: ChainPlan = { sessionId: 's-leak', depth: 30, tty: '??', pids: [11, 12], action: { kind: 'kill-orphan', kill: [11, 12], reclaimKb: 2_048_000 } };
    const r = evaluatePatrol({ ...emptySnapshot, chains: [leak], hosts: [host('mshq', 759, { bunProcesses: 733, livePanes: 54, bunRssMb: 53 * 1024, memoryAvailablePercent: 4 })] }, policy, EMPTY_PATROL_STATE, at(0));
    expect(r.fresh.map((f) => f.rule).sort()).toEqual(['bun-processes', 'load-critical', 'memory-low']);
    expect(r.fresh.every((f) => f.severity === 'critical')).toBe(true);
    // The RSS sum is recorded as info only — never fires.
    expect(r.findings.find((f) => f.rule === 'bun-rss')?.severity).toBe('info');
    // At the lines: 30 GB exactly, 108 bun on 54 panes, 25% free → quiet.
    expect(evaluatePatrol({ ...emptySnapshot, hosts: [host('mshq', 30, { bunProcesses: 108, livePanes: 54, bunRssMb: 30_720, memoryAvailablePercent: 25 })] }, policy, EMPTY_PATROL_STATE, at(0)).findings).toEqual([]);
  });
  describe('GUARDIAN-RSS-THRESHOLD — memory from system signals, process count from chains to end', () => {
    const orphan = (n: number): ChainPlan => ({ sessionId: `s-o${n}`, depth: 2, tty: '??', pids: [1000 + n], action: { kind: 'kill-orphan', kill: [1000 + n], reclaimKb: 102_400 } });
    test('11-25 19:5x false alarm (343 procs · 85 GB RSS sum · 91% free · 0 orphan chains) → no critical, nothing fires', () => {
      const r = evaluatePatrol({ ...emptySnapshot, hosts: [host('mshq', 13, { bunProcesses: 343, livePanes: 61, bunRssMb: 87_040, memoryAvailablePercent: 91, swapUsedMb: 4_741, memoryPressureLevel: 'normal' })] }, policy, EMPTY_PATROL_STATE, at(0));
      expect(r.findings.filter((f) => f.severity === 'critical')).toEqual([]);
      expect(r.findings.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(['bun-processes:info', 'bun-rss:info']);
      expect(r.fresh).toEqual([]);
      expect(r.next.active).toEqual({});
      expect(patrolCard(r.fresh, true)).toBeNull();
    });
    test('40% free + 8 GB swap → warn', () => {
      const r = evaluatePatrol({ ...emptySnapshot, hosts: [host('mshq', 13, { memoryAvailablePercent: 40, swapUsedMb: 8_192 })] }, policy, EMPTY_PATROL_STATE, at(0));
      expect(r.fresh.map((f) => [f.key, f.severity])).toEqual([['memory-warn:mshq', 'warn']]);
    });
    test('91% free with 8 GB swap stays quiet (swap alone is not pressure)', () => {
      expect(evaluatePatrol({ ...emptySnapshot, hosts: [host('mshq', 13, { memoryAvailablePercent: 91, swapUsedMb: 8_192 })] }, policy, EMPTY_PATROL_STATE, at(0)).findings).toEqual([]);
    });
    test('9% free → critical; macOS pressure level critical → critical; Linux PSI some avg10 60 → critical', () => {
      for (const extra of [{ memoryAvailablePercent: 9 }, { memoryAvailablePercent: 80, memoryPressureLevel: 'critical' as const }, { memoryAvailablePercent: 80, memoryPsiSomeAvg10: 60 }]) {
        const r = evaluatePatrol({ ...emptySnapshot, hosts: [host('h1', 5, extra)] }, policy, EMPTY_PATROL_STATE, at(0));
        expect(r.fresh.map((f) => [f.key, f.severity])).toEqual([['memory-low:h1', 'critical']]);
      }
    });
    test('10% free → warn (critical is below 10%)', () => {
      const r = evaluatePatrol({ ...emptySnapshot, hosts: [host('h1', 5, { memoryAvailablePercent: 10 })] }, policy, EMPTY_PATROL_STATE, at(0));
      expect(r.fresh.map((f) => [f.key, f.severity])).toEqual([['memory-warn:h1', 'warn']]);
    });
    test('orphan chains 20 → bun-processes critical with count and MB', () => {
      const chains = Array.from({ length: 20 }, (_, i) => orphan(i));
      const r = evaluatePatrol({ ...emptySnapshot, chains, hosts: [host('mshq', 13, { bunProcesses: 343, livePanes: 61, memoryAvailablePercent: 91 })] }, policy, EMPTY_PATROL_STATE, at(0));
      const finding = r.fresh.find((f) => f.rule === 'bun-processes');
      expect(finding?.severity).toBe('critical');
      expect(finding?.detail).toBe('343 bun processes > 2 × 61 live panes · 20 chains to end (20 processes · 2000 MB)');
    });
    test('thresholds come from the policy config (code defaults overridable)', () => {
      const strict = resolveResPolicy({ policy: { load: { memoryWarnFreePercent: 95, minChainsToEndCritical: 50 } } } as never);
      expect(strict.load.memoryWarnFreePercent).toBe(95);
      expect(strict.load.minChainsToEndCritical).toBe(50);
      expect(resolveResPolicy(undefined).load.memoryWarnFreePercent).toBe(25);
      const r = evaluatePatrol({ ...emptySnapshot, chains: Array.from({ length: 20 }, (_, i) => orphan(i)), hosts: [host('mshq', 13, { bunProcesses: 343, livePanes: 61, memoryAvailablePercent: 91 })] }, strict, EMPTY_PATROL_STATE, at(0));
      expect(r.findings.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(['bun-processes:info', 'memory-warn:warn']);
    });
    test('parsers read the real command shapes', () => {
      expect(parseDarwinMemory('The system has 137438953472 (33554432 pages with a page size of 4096).\nSystem-wide memory free percentage: 91%\n',
        'total = 6144.00M  used = 4741.69M  free = 1402.31M  (encrypted)', '1\n'))
        .toEqual({ memoryAvailablePercent: 91, swapUsedMb: 4742, memoryPressureLevel: 'normal' });
      expect(parseDarwinMemory('', 'total = 0.00M  used = 0.00M  free = 0.00M', '4')).toEqual({ swapUsedMb: 0, memoryPressureLevel: 'critical' });
      expect(parseLinuxMemory('MemTotal:       1000000 kB\nMemFree:          100000 kB\nMemAvailable:    400000 kB\nSwapTotal:      8388608 kB\nSwapFree:              0 kB\n',
        'some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=1\n'))
        .toEqual({ memoryAvailablePercent: 40, swapUsedMb: 8192, memoryPsiSomeAvg10: 12.5 });
    });
  });
  test('safe chains are reaped; a chain holding a terminal is carded, not touched', () => {
    const orphan: ChainPlan = { sessionId: 's-orphan', depth: 4, tty: '??', pids: [101, 102, 103, 104], action: { kind: 'kill-orphan', kill: [101, 102, 103, 104], reclaimKb: 400_000 } };
    const thaw: ChainPlan = { sessionId: 's-thaw', depth: 0, tty: 'ttys009', pids: [201], action: { kind: 'thaw', cont: 201 } };
    const live: ChainPlan = { sessionId: 's-live', depth: 38, tty: 'ttys004', pids: [301, 302, 303], action: { kind: 'collapse', stop: 301, kill: [302], keep: 303, reclaimKb: 2_048_000 } };
    const r = evaluatePatrol({ ...emptySnapshot, chains: [orphan, thaw, live] }, policy, EMPTY_PATROL_STATE, at(0));
    expect(r.reap.map((p) => p.sessionId)).toEqual(['s-orphan', 's-thaw']);
    // s-orphan has 4 eln TUI processes (> 3): reaped AND alerted; s-live (3) holds a terminal: alerted, not touched.
    expect(r.fresh.map((f) => [f.key, f.rule, f.severity])).toEqual([
      ['restart-chain:s-orphan', 'tui-chain', 'critical'], ['restart-chain:s-live', 'restart-chain-live', 'warn']]);
  });
  test('credential expiring in 3h and quota at 90% fire; an untouched tick keeps them active', () => {
    const r1 = evaluatePatrol({ ...emptySnapshot, credentials: [
      { provider: 'grok', account: 'subscription', expiresAt: '2026-11-25T13:00:00.000Z' },
      { provider: 'codex', account: 'third', usedPercent: 90 },
      { provider: 'openrouter', account: 'default', usedPercent: 10 },
    ] }, policy, EMPTY_PATROL_STATE, at(0));
    expect(r1.fresh.map((f) => f.key).sort()).toEqual(['credential-expiry:grok/subscription', 'quota-high:codex/third']);
    const r2 = evaluatePatrol(emptySnapshot, policy, r1.next, at(5));
    expect(r2.cleared).toEqual([]);
    expect(r2.fresh).toEqual([]);
  });
  test('VM pressure: all test hosts at load ≥ 40 starts one stopped VM within budget; idle 30 min stops it', () => {
    const loaded = { ...emptySnapshot, hosts: [host('minim5', 45), host('node-b', 41), host('node-c', 52)],
      vms: [{ host: 'aws1', state: 'stopped' as const }, { host: 'aws2', state: 'stopped' as const }] };
    const start = evaluatePatrol(loaded, policy, EMPTY_PATROL_STATE, at(0));
    expect(start.vm.map((v) => [v.action.kind, v.action.host, v.decision.verdict, v.decision.rule])).toEqual([['vm-start', 'aws1', 'allow', 'vm-start-within-budget']]);
    const idle = { ...emptySnapshot, hosts: [host('aws1', 0.5)], vms: [{ host: 'aws1', state: 'running' as const }] };
    const t0 = evaluatePatrol(idle, policy, EMPTY_PATROL_STATE, at(0));
    expect(t0.vm).toEqual([]);
    const t30 = evaluatePatrol(idle, policy, t0.next, at(30));
    expect(t30.vm.map((v) => [v.action.kind, v.decision.rule])).toEqual([['vm-stop', 'vm-idle-stop']]);
  });
  test('a running VM outside the policy is an always-on exception; protected VMs are ignored', () => {
    const r = evaluatePatrol({ ...emptySnapshot, vms: [{ host: 'gcp3', state: 'running' }, { host: 'elanous-dream', state: 'running', protected: true }] }, policy, EMPTY_PATROL_STATE, at(0));
    expect(r.fresh.map((f) => [f.key, f.rule])).toEqual([['unknown-vm-running:gcp3', 'unknown-vm']]);
    expect(r.vm).toEqual([]);
  });
  test('card goes to RES, or to OP when RES is dormant; nothing new = no card', () => {
    const fresh = [{ key: 'load-warn:node-b', rule: 'load-warn', subject: 'node-b', severity: 'warn' as const, detail: 'load1 70.0 ≥ 60' }];
    expect(patrolCard(fresh, false)?.to).toBe('RES');
    expect(patrolCard(fresh, false)?.body.startsWith('[수호자 · RES] 정책 밖 1건')).toBe(true);
    expect(patrolCard(fresh, true)?.to).toBe('OP');
    expect(patrolCard([], false)).toBeNull();
  });
});

describe('shadow report math', () => {
  const row = (source: 'guardian' | 'res-tab', pairId: string | undefined, decision: 'allow' | 'deny' | 'ask', hostName = 'minim5'): ShadowRow =>
    ({ at: '2026-11-25T11:00:00.000Z', source, action: 'pregate', host: hostName, decision, rule: source === 'guardian' ? 'pregate-slot-free' : 'res-tab', policyVersion: 'v1', ...(pairId ? { pairId } : {}) });
  test('2 of 3 pairs agree = 66.7%, one disagreement listed, unpaired guardian rows counted', () => {
    const rows = [
      row('guardian', 'p1', 'allow'), row('res-tab', 'p1', 'allow'),
      row('guardian', 'p2', 'deny'), row('res-tab', 'p2', 'deny'),
      row('guardian', 'p3', 'allow', 'node-b'), row('res-tab', 'p3', 'deny', 'node-b'),
      row('guardian', undefined, 'allow'), row('guardian', undefined, 'allow'),
      row('res-tab', 'p4', 'allow'),
      { ...row('guardian', 'p0', 'allow'), at: '2026-11-24T08:00:00.000Z' }, { ...row('res-tab', 'p0', 'deny'), at: '2026-11-24T08:00:00.000Z' },
    ];
    const report = shadowReport(rows, new Date('2026-11-25T00:00:00.000Z'));
    expect(report.paired).toBe(3);
    expect(report.agreed).toBe(2);
    expect(report.agreementPercent).toBe(66.7);
    expect(report.disagreements).toEqual([{ pairId: 'p3', at: '2026-11-25T11:00:00.000Z', action: 'pregate', host: 'node-b', guardian: 'allow', resTab: 'deny', rule: 'pregate-slot-free' }]);
    expect(report.guardianOnly).toBe(2);
    expect(report.resOnly).toBe(1);
    expect(report.days).toBe(1);
  });
  test('nothing paired = agreement n/a (null), not 0% or 100%', () => {
    expect(shadowReport([], new Date('2026-11-25T00:00:00.000Z')).agreementPercent).toBeNull();
  });
});

describe('credentials from `eln usage --json`', () => {
  test('codex accounts read per account: default 100% / team 76% / third 57% → only default is over 85%', () => {
    const usage = { rows: [
      { provider: 'codex', accountName: 'default', credits: { status: 'ok', usedPercent: 100 }, subscription: { status: 'available', remainingPercent: 0 }, resetCredits: { status: 'available', expiresAt: '2026-11-30T19:52:24.191Z' } },
      { provider: 'codex', accountName: 'team', credits: { status: 'ok', usedPercent: 76 }, subscription: { status: 'available', remainingPercent: 24 }, resetCredits: { status: 'available', expiresAt: '2026-11-30T19:49:59.488Z' } },
      { provider: 'codex', accountName: 'third', credits: { status: 'ok', usedPercent: 57 }, subscription: { status: 'available', remainingPercent: 43 }, resetCredits: { status: 'available', expiresAt: '2026-11-30T19:49:47.883Z' } },
      { provider: 'openrouter', accountName: 'default', credits: { status: 'ok', usedPercent: 92.8 }, subscription: { status: 'unavailable' }, resetCredits: { status: 'not-applicable' } },
      { provider: 'zai', accountName: 'plan-week', credits: { status: 'ok', usedPercent: 100 } },
    ] };
    const credentials = credentialsFromUsageJson(usage);
    expect(credentials).toEqual([
      { provider: 'codex', account: 'default', usedPercent: 100, expiresAt: null },
      { provider: 'codex', account: 'team', usedPercent: 76, expiresAt: null },
      { provider: 'codex', account: 'third', usedPercent: 57, expiresAt: null },
      { provider: 'openrouter', account: 'default', usedPercent: null, expiresAt: null },
    ]);
    const r = evaluatePatrol({ ...emptySnapshot, credentials }, policy, EMPTY_PATROL_STATE, at(0));
    expect(r.fresh.map((f) => f.key)).toEqual(['quota-high:codex/default']);
  });
  test('usage json without rows is a read failure, not «no credentials»', () => {
    expect(() => credentialsFromUsageJson({})).toThrow('usage json without rows');
  });
});

describe('ledger, inflight, collector, capsule', () => {
  test('res-decision rows round-trip through the resource ledger; a bad verdict is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'res-decision-'));
    try {
      const path = join(root, 'events.jsonl');
      recordResDecision({ source: 'res-tab', action: 'pregate', host: 'node-b', decision: 'deny', rule: 'res-tab', policyVersion: 'v1', pairId: 'p9', ref: 'mail#123' }, T0, path);
      expect(readResourceLedger(path)).toEqual([{ event: 'res-decision', at: '2026-11-25T10:00:00.000Z',
        row: { source: 'res-tab', action: 'pregate', host: 'node-b', decision: 'deny', rule: 'res-tab', policyVersion: 'v1', pairId: 'p9', ref: 'mail#123' } }]);
      expect(() => parseResourceLedgerEvents('{"event":"res-decision","at":"2026-11-25T10:00:00.000Z","row":{"source":"guardian","action":"pregate","host":"node-b","decision":"maybe","rule":"x","policyVersion":"v1"}}\n'))
        .toThrow('resource ledger invalid RES decision at line 1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('pregate inflight counts live pids per host and skips dead pids and guard files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'res-inflight-'));
    try {
      writeFileSync(join(dir, 'aaaaaaaaaaaa-light.lock'), '4101 minim5 tok1\n');
      writeFileSync(join(dir, 'bbbbbbbbbbbb-full.lock'), '4102 minim5 tok2\n');
      writeFileSync(join(dir, 'cccccccccccc-full.lock'), '4103 node-b tok3\n');
      writeFileSync(join(dir, 'dddddddddddd-full.lock'), '9999 node-b tok4\n');
      writeFileSync(join(dir, 'aaaaaaaaaaaa-light.lock.guard'), '');
      // Source: 내부 문서 `LOOP-AGENTS` §2 rule 9 — «minim5/node-c» are host-name fixtures, not numeric bounds.
      expect(pregateInflight(dir, (pid) => pid !== 9999)).toEqual({ minim5: 2, 'node-b': 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('local live panes = distinct controlling ttys', () => {
    const row = (pid: number, tty: string, command: string) => ({ pid, ppid: 1, pgid: pid, stat: 'S', tty, rssKb: 2048, command });
    expect(localBunUsage([row(1, 'ttys001', '/b/bun x'), row(2, 'ttys001', 'zsh'), row(3, 'ttys002', '/b/bun y'), row(4, '??', '/b/bun z')]))
      .toEqual({ bunProcesses: 3, bunRssMb: 6, livePanes: 2 });
  });
  test('collector BUN section parses "<count> <rssKiB>"', () => {
    expect(parseBunUsage('733 55574528')).toEqual({ processes: 733, rssMb: 54272 });
    expect(parseBunUsage('')).toBeUndefined();
  });
  test('cloud inventory maps onto policy hosts by instance id or name', () => {
    expect(patrolVms(policy, [
      { id: 'i-05e66cd52ebd3a2c6', name: 'elanous-aws1', state: 'stopped', protected: null },
      { id: '2677340726811681093', name: 'elanous-burst-128', state: 'terminated', protected: null },
      { id: '7124222536489942771', name: 'gcp3', state: 'running', protected: null },
    ])).toEqual([{ host: 'aws1', state: 'stopped' }, { host: 'gcp1', state: 'stopped' }, { host: 'gcp3', state: 'running' }]);
  });
  test('capsule brief carries the question, the policy and the instruction to record the verdict', () => {
    // Source: 내부 문서 `LOOP-AGENTS` §2 rule 9 — «minim5/node-c» are host-name fixtures, not numeric bounds.
    const brief = buildResCapsuleBrief({ question: 'Start aws1 for the 04:00 cut?', policy, events: [], hosts: [], pregateInflight: { minim5: 2 }, now: T0 });
    expect(brief).toContain('Start aws1 for the 04:00 cut?');
    expect(brief).toContain('"preApprovedTestHosts": [\n    "minim5",\n    "node-b",\n    "node-c"\n  ]');
    expect(brief).toContain('eln res shadow record --action <action> --host <host> --decision <allow|deny|ask> --ref capsule');
    expect(brief).toContain('{"minim5":2}');
  });
});

describe('patrol run (fake world · no signals · no network)', () => {
  function world(root: string, overrides: Partial<PatrolRunDeps> = {}) {
    const cards: Array<{ to: string; body: string; key: string }> = [];
    const reaped: string[] = [];
    const decisions: string[] = [];
    const deps: PatrolRunDeps = {
      now: () => T0,
      config: () => ({ dormant: true }),
      ledger: () => [{ event: 'host-readiness-heartbeat', at: '2026-11-25T09:58:00.000Z', heartbeat: { host: 'node-b', at: '2026-11-25T09:58:00.000Z', sshAvailable: true, maintenance: false, gateProtected: false, tools: {},
        sample: { loadPercent: 700, load15Percent: 600, memoryAvailablePercent: 40, rootDiskUsedPercent: 50, tmpDiskUsedPercent: 50, load1: 72 } } }],
      processTable: () => [
        { pid: 501, ppid: 1, pgid: 501, stat: 'S', tty: 'ttys001', rssKb: 1024, command: '/Users/x/.bun/bin/bun run worker.ts' },
        { pid: 502, ppid: 501, pgid: 501, stat: 'S', tty: 'ttys001', rssKb: 1024, command: '/Users/x/.bun/bin/bun run worker.ts' },
      ],
      localHost: () => 'mshq',
      inflightDir: () => join(root, 'inflight-missing'),
      alive: () => true,
      cloud: async () => [],
      credentials: async () => [],
      statePath: () => join(root, 'state', 'state.json'),
      applyReap: async (plan) => { reaped.push(plan.action.kind); return { ok: true, detail: 'fake' }; },
      runVmCommand: () => ({ status: 0, output: '' }),
      recordDecision: (row) => { decisions.push(`${row.action}:${row.decision}`); },
      postCard: (card, key) => { cards.push({ ...card, key }); },
      ...overrides,
    };
    return { deps, cards, reaped, decisions };
  }
  test('dry run cards nothing and keeps the fire-once edge for the real tick; the real tick cards OP once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'res-patrol-'));
    try {
      const w = world(root);
      const dry = await runResPatrol(w.deps, { dryRun: true });
      expect(dry.fresh.map((f) => f.key)).toEqual(['load-warn:node-b']);
      expect(w.cards).toEqual([]);
      expect(existsSync(join(root, 'state', 'state.json'))).toBe(false);
      const first = await runResPatrol(w.deps);
      expect(first.carded).toBe('OP');
      expect(w.cards.length).toBe(1);
      expect(w.cards[0]!.body).toContain('load-warn · node-b — load1 72.0 ≥ 60');
      const second = await runResPatrol(w.deps);
      expect(second.carded).toBeNull();
      expect(w.cards.length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('shadow mode records a VM start as «would» and never runs the command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'res-patrol-vm-'));
    try {
      mkdirSync(join(root, 'inflight'));
      for (const [name, hostName] of [['a1', 'minim5'], ['a2', 'minim5'], ['b1', 'node-b'], ['b2', 'node-b'], ['c1', 'node-c'], ['c2', 'node-c']] as const)
        writeFileSync(join(root, 'inflight', `${name}-full.lock`), `7${name.charCodeAt(0)}${name.at(1)} ${hostName} tok\n`);
      let ran = 0;
      const w = world(root, { config: () => ({ vmStartCommand: 'echo start {host}' }), inflightDir: () => join(root, 'inflight'),
        cloud: async () => [{ id: 'i-05e66cd52ebd3a2c6', name: 'elanous-aws1', state: 'stopped', protected: null }],
        runVmCommand: () => { ran += 1; return { status: 0, output: '' }; } });
      const result = await runResPatrol(w.deps);
      expect(result.mode).toBe('shadow');
      expect(result.vm).toEqual([{ host: 'aws1', action: 'vm-start', verdict: 'allow', rule: 'vm-start-within-budget', executed: false, detail: 'aws1: $2.40 projected ≤ $30 daily cap' }]);
      expect(ran).toBe(0);
      expect(w.decisions).toEqual(['vm-start:allow']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('wiring', () => {
  const repo = new URL('../../', import.meta.url).pathname;
  test('graphs/ops/res-patrol.yaml runs `res patrol --json` every 5 minutes as a RES-owned shadow loop', () => {
    const yaml = readFileSync(join(repo, 'graphs/ops/res-patrol.yaml'), 'utf8');
    expect(parseGraphTemplateYaml(yaml, 'graphs/ops/res-patrol.yaml').errors).toEqual([]);
    const graph = parseYaml(yaml);
    expect(graph.loop.trigger.cron).toBe('*/5 * * * *');
    expect(graph.loop.owner).toBe('RES');
    expect(graph.loop.stage).toBe('shadow');
    expect(graph.nodes[0].recipe).toBe('cmd:res-patrol');
    const recipes = parseYaml(readFileSync(join(repo, 'graphs/ops/recipes.yaml'), 'utf8'));
    expect(recipes['res-patrol'].command).toBe('bun "$ELANOUS_GRAPH_DIR/../../bin/elanous.mjs" res patrol --json');
  });
  test('config res section parses, drops ill-typed fields and survives a save', () => {
    const root = mkdtempSync(join(tmpdir(), 'res-config-'));
    try {
      const path = join(root, 'config.json');
      writeFileSync(path, JSON.stringify({ res: { mode: 'live', dormant: true, vmStartCommand: 7, policy: { defaultPregateSlots: 3 } } }));
      const config = buildUserConfig(path);
      expect(config.res).toEqual({ mode: 'live', dormant: true, policy: { defaultPregateSlots: 3 } });
      saveUserConfig(config, path);
      expect(buildUserConfig(path).res).toEqual({ mode: 'live', dormant: true, policy: { defaultPregateSlots: 3 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
