import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialRollingMainState, nextRollingMainLanding, parseRollingMainState, rollingMainReceiptIntact, rollingMainGateRuntimePath, runRollingMainGate, snapshotRollingMainReceipt, type RollingMainState } from './rolling-main-gate.js';

const sha = (letter: string) => letter.repeat(40);

test('GATE-ROLLING-MAIN sim: direct runtime entry preserves the legacy gate CLI help contract', () => {
  const repo = process.cwd();
  const runtime = rollingMainGateRuntimePath(repo);
  expect(runtime).toBe(join(repo, 'scripts/release-loop/gate-runtime.ts'));
  const runtimeHelp = spawnSync('bun', [runtime, '--help'], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  expect(runtimeHelp.status).toBe(0);
  expect(runtimeHelp.stdout).toContain('Usage: bun scripts/release-loop/gate-node.ts');
  expect(runtimeHelp.stdout).toContain('--full disables receipt and partial reuse');
});

test('GATE-ROLLING-MAIN sim: every main landing bundle is selected once in first-parent order', () => {
  const chain = [sha('d'), sha('c'), sha('b'), sha('a')];
  expect(nextRollingMainLanding(chain, sha('a'), sha('d'))).toBe(sha('b'));
  expect(nextRollingMainLanding(chain, sha('b'), sha('d'))).toBe(sha('c'));
  expect(nextRollingMainLanding(chain, sha('d'), sha('d'))).toBeNull();
  expect(() => nextRollingMainLanding(chain, sha('e'), sha('d'))).toThrow('cursor unavailable');
});

test('GATE-ROLLING-MAIN sim: damaged cursor fields or run rows are rejected instead of normalized', () => {
  const state = initialRollingMainState('0.3.7');
  const { lastAttemptCommit, ...missingCursor } = state;
  void lastAttemptCommit;
  expect(() => parseRollingMainState(JSON.stringify(missingCursor), '0.3.7')).toThrow('state is invalid');
  expect(() => parseRollingMainState(JSON.stringify({ ...state, runs: [{ commit: 'bad' }] }), '0.3.7'))
    .toThrow('invalid run record');
  expect(() => parseRollingMainState(JSON.stringify({ ...state, runs: [{ commit: sha('b'), host: 'aws1',
    status: 'red', verdict: 'pass', introduced: [], at: new Date().toISOString() }] }), '0.3.7'))
    .toThrow('status, verdict, and receipt disagree');
});

test('GATE-ROLLING-MAIN sim: runs the main tip only on the first measured idle host and pins the full-gate receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-green-'));
  const receiptPath = join(root, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ outcome: 'ok', commit: sha('b'), files: 2700 }));
  const statePath = join(root, 'rolling-main.json');
  const hosts: string[] = [];
  try {
    const result = await runRollingMainGate({ state: initialRollingMainState('0.3.7'), repo: root, commit: sha('b'),
      previousVersion: '0.3.6', baselineCommit: sha('a'), statePath,
      deps: { hostStatus: (host) => host === 'gcp1' ? 'busy' : 'idle',
        runFullGate: async (input) => { hosts.push(input.host); expect(input).toMatchObject({ commit: sha('b'), baselineCommit: sha('a'), host: 'aws1' });
          return { output: { outcome: 'ok', commit: sha('b'), baselineReceipt: { valid: true, commit: sha('b') } }, receiptPath }; },
        runBisectSidecar: async () => { throw new Error('green gate cannot start failure bisect'); },
        now: () => new Date('2026-11-07T12:00:00.000Z') } });
    expect(hosts).toEqual(['aws1']);
    expect(result).toMatchObject({ status: 'green', host: 'aws1', state: { lastAttemptCommit: sha('b'), latestGreenCommit: sha('b'),
      latestGreenReceipt: { valid: true, commit: sha('b') } } });
    expect(parseRollingMainState(readFileSync(statePath, 'utf8'), '0.3.7')).toMatchObject(result.state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: no idle or unmeasured host does not consume the main tip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-busy-'));
  let runs = 0;
  try {
    const result = await runRollingMainGate({ state: initialRollingMainState('0.3.7'), repo: root, commit: sha('b'),
      previousVersion: '0.3.6', baselineCommit: sha('a'), statePath: join(root, 'state.json'),
      deps: { hostStatus: () => 'unmeasured', runFullGate: async () => { runs++; throw new Error('must not start'); },
        runBisectSidecar: async () => ({ path: 'unused' }) } });
    expect(result).toMatchObject({ status: 'skipped', state: { lastAttemptCommit: null, latestGreenCommit: null } });
    expect(runs).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: a nominal pass without a valid reusable receipt cannot advance latest green', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-unreusable-'));
  try {
    const result = await runRollingMainGate({ state: initialRollingMainState('0.3.7'), repo: root, commit: sha('b'),
      previousVersion: '0.3.6', baselineCommit: sha('a'), statePath: join(root, 'state.json'),
      deps: { hostStatus: () => 'idle', runFullGate: async () => ({ output: { outcome: 'ok', commit: sha('b'),
        baselineReceipt: { valid: false, commit: sha('b'), reason: 'Pod receipt evidence absent' } } }),
        runBisectSidecar: async () => ({ path: 'unused' }) } });
    expect(result.status).toBe('unreusable');
    expect(result.state).toMatchObject({ lastAttemptCommit: null, latestGreenCommit: null, latestGreenReceipt: null,
      runs: [{ status: 'unreusable', verdict: 'unmeasured' }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: unmeasured result keeps the commit cursor retryable on the next tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-retry-'));
  let attempts = 0;
  try {
    const deps = { hostStatus: () => 'idle' as const, runFullGate: async () => {
      attempts++;
      if (attempts === 1) return { output: { outcome: 'ok', commit: sha('b') } };
      const receiptPath = join(root, 'retry.json');
      writeFileSync(receiptPath, JSON.stringify({ outcome: 'ok', commit: sha('b') }));
      return { output: { outcome: 'ok', commit: sha('b') }, receiptPath };
    }, runBisectSidecar: async () => ({ path: 'unused' }) };
    const first = await runRollingMainGate({ state: initialRollingMainState('0.3.7'), repo: root, commit: sha('b'),
      previousVersion: '0.3.6', baselineCommit: sha('a'), statePath: join(root, 'state.json'), deps });
    const second = await runRollingMainGate({ state: first.state, repo: root, commit: sha('b'),
      previousVersion: '0.3.6', baselineCommit: sha('a'), statePath: join(root, 'state.json'), deps });
    expect(attempts).toBe(2);
    expect(first.state.lastAttemptCommit).toBeNull();
    expect(second).toMatchObject({ status: 'green', state: { lastAttemptCommit: sha('b'), latestGreenCommit: sha('b') } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: immutable receipt snapshot survives a later mutable verdict write', () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-receipt-'));
  const source = join(root, 'gate-verdict.json');
  const snapshot = join(root, 'receipts', 'attempt-1.json');
  try {
    writeFileSync(source, JSON.stringify({ outcome: 'ok', commit: sha('b') }));
    const receipt = snapshotRollingMainReceipt({ outcome: 'ok', commit: sha('b') }, source, snapshot);
    writeFileSync(source, JSON.stringify({ outcome: 'ok', commit: sha('c') }));
    expect(receipt).not.toBeNull();
    expect(rollingMainReceiptIntact(receipt!)).toBe(true);
    writeFileSync(snapshot, JSON.stringify({ outcome: 'ok', commit: sha('c') }));
    expect(rollingMainReceiptIntact(receipt!)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: changed green receipt fails closed without overwriting the state ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-corrupt-receipt-'));
  const receiptPath = join(root, 'green.json');
  const statePath = join(root, 'rolling-main.json');
  try {
    writeFileSync(receiptPath, JSON.stringify({ outcome: 'ok', commit: sha('a') }));
    const originalReceipt = { valid: true as const, commit: sha('a'), receiptPath,
      sha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex') };
    const state: RollingMainState = { ...initialRollingMainState('0.3.7'), lastAttemptCommit: sha('a'),
      latestGreenCommit: sha('a'), latestGreenReceipt: originalReceipt, runs: [] };
    const stateText = `${JSON.stringify(state)}\n`;
    writeFileSync(statePath, stateText);
    writeFileSync(receiptPath, JSON.stringify({ outcome: 'ok', commit: sha('c') }));
    let runs = 0;
    await expect(runRollingMainGate({ state, repo: root, commit: sha('b'), previousVersion: '0.3.6',
      baselineCommit: sha('0'), statePath, deps: { hostStatus: () => 'idle',
        runFullGate: async () => { runs++; return { output: { outcome: 'ok', commit: sha('b') } }; },
        runBisectSidecar: async () => ({ path: 'unused' }) } })).rejects.toThrow('state preserved');
    expect(runs).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toBe(stateText);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: green receipt changed during full gate stops before recording failure or advancing cursor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-receipt-race-'));
  const receiptPath = join(root, 'green.json');
  const statePath = join(root, 'rolling-main.json');
  try {
    const original = JSON.stringify({ outcome: 'ok', commit: sha('a') });
    writeFileSync(receiptPath, original);
    const priorReceipt = { valid: true as const, commit: sha('a'), receiptPath,
      sha256: createHash('sha256').update(original).digest('hex') };
    const state: RollingMainState = { ...initialRollingMainState('0.3.7'), lastAttemptCommit: sha('a'),
      latestGreenCommit: sha('a'), latestGreenReceipt: priorReceipt, runs: [] };
    const stateText = `${JSON.stringify(state)}\n`;
    writeFileSync(statePath, stateText);
    let sidecars = 0;
    await expect(runRollingMainGate({ state, repo: root, commit: sha('b'), previousVersion: '0.3.6',
      baselineCommit: sha('0'), statePath, deps: { hostStatus: () => 'idle',
        runFullGate: async () => { writeFileSync(receiptPath, JSON.stringify({ outcome: 'ok', commit: sha('c') }));
          return { output: { outcome: 'regression', commit: sha('b'), introduced: ['src/a.test.ts > failure'] } }; },
        runBisectSidecar: async () => { sidecars++; return { path: join(root, 'bisect.json') }; } } }))
      .rejects.toThrow('changed during gate');
    expect(sidecars).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toBe(stateText);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: failure without a measured green baseline does not attribute or mail an owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-unproven-base-'));
  let sidecars = 0;
  try {
    const result = await runRollingMainGate({ state: initialRollingMainState('0.3.7'), repo: root, commit: sha('b'),
      previousVersion: '0.3.6', baselineCommit: sha('a'), statePath: join(root, 'state.json'),
      deps: { hostStatus: () => 'idle', runFullGate: async () => ({ output: { outcome: 'regression', commit: sha('b'), introduced: ['src/a.test.ts > regression'] } }),
        runBisectSidecar: async () => { sidecars++; return { path: join(root, 'bisect.json') }; } } });
    expect(result.status).toBe('red');
    expect(result.state.lastAttemptCommit).toBe(sha('b'));
    expect(sidecars).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-ROLLING-MAIN sim: failure runs bisect from the latest reusable green and leaves that receipt pinned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-main-red-'));
  const priorReceiptPath = join(root, 'prior.json');
  const priorReceiptText = JSON.stringify({ outcome: 'ok', commit: sha('a') });
  writeFileSync(priorReceiptPath, priorReceiptText);
  const receipt = { valid: true as const, commit: sha('a'), receiptPath: priorReceiptPath,
    sha256: createHash('sha256').update(priorReceiptText).digest('hex') };
  const priorState: RollingMainState = { ...initialRollingMainState('0.3.7'), lastAttemptCommit: sha('a'), latestGreenCommit: sha('a'),
    latestGreenReceipt: receipt, runs: [] };
  const sidecars: unknown[] = [];
  try {
    const result = await runRollingMainGate({ state: priorState, repo: root, commit: sha('b'), previousVersion: '0.3.6',
      baselineCommit: sha('a'), statePath: join(root, 'state.json'), deps: { hostStatus: () => 'idle',
        runFullGate: async () => ({ output: { outcome: 'regression', commit: sha('b'), introduced: ['src/a.test.ts > regression'] } }),
        runBisectSidecar: async (input) => { sidecars.push(input); return { path: join(root, 'bisect.json') }; } } });
    expect(sidecars).toEqual([{ baseCommit: sha('a'), cutCommit: sha('b'), version: '0.3.7',
      introduced: ['src/a.test.ts > regression'], host: 'gcp1' }]);
    expect(result).toMatchObject({ status: 'red', host: 'gcp1', state: { lastAttemptCommit: sha('b'), latestGreenCommit: sha('a'),
      latestGreenReceipt: receipt, runs: [{ status: 'red', verdict: 'fail', sidecarPath: join(root, 'bisect.json') }] } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
