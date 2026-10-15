import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_HISTORY_GRAPHS,
  applyWatchList,
  causePrNumbersOf,
  causePrsByVersion,
  formatGateHistory,
  gateHistory,
  gateOutputsOfLedger,
  gateVerdictPath,
  passesSince,
  readGateHistoryRecords,
  compareGateVersions,
  UNATTRIBUTED_FILE,
} from './gate-history.js';

const ledger = (o: { version: string; startedAt: string; gate?: unknown; nodes?: unknown[] }) =>
  JSON.stringify({ input: { version: o.version, previousVersion: '0.2.0' }, startedAt: o.startedAt, ...(o.nodes ? { nodes: o.nodes } : {}) , ...(o.gate !== undefined ? { nodes: [{ nodeId: 'gate', output: typeof o.gate === 'string' ? o.gate : JSON.stringify(o.gate) }] } : {}) });

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), 'gate-history-'));
  const instanceRoot = join(root, 'instance');
  const ledgerRoot = join(root, 'ledger');
  for (const graph of GATE_HISTORY_GRAPHS) mkdirSync(join(instanceRoot, 'graph-runs', graph), { recursive: true });
  mkdirSync(join(ledgerRoot, 'release', '0.2.25'), { recursive: true });
  const write = (graph: string, name: string, body: string) => writeFileSync(join(instanceRoot, 'graph-runs', graph, name), body);
  // 0.2.25 — gate node output names introduced by id; preexisting/knownEnv are bare counts in the node, ids in the verdict file.
  write('release-loop', 'aaa.json', ledger({
    version: '0.2.25', startedAt: '2026-10-01T01:00:00.000Z',
    gate: { commit: 'a'.repeat(40), outcome: 'regression', introduced: ['src/cli/foo.test.ts > fails'], preexisting: 2, knownEnv: 1, loadFlaky: [] },
  }));
  // Same version re-run at another commit: the same introduced id must count once for this version.
  write('release-loop', 'aab.json', ledger({
    version: '0.2.25', startedAt: '2026-10-01T02:00:00.000Z',
    gate: { commit: 'b'.repeat(40), outcome: 'regression', introduced: ['src/cli/foo.test.ts > fails'], preexisting: ['src/harness/old.test.ts > known bad', 'scripts/kept.test.ts > also known'], knownEnv: ['src/maturity/env.test.ts > env only'], loadFlaky: [] },
  }));
  write('light-rc', 'aac.json', ledger({
    version: '0.2.25', startedAt: '2026-10-01T03:00:00.000Z',
    gate: { commit: 'c'.repeat(40), outcome: 'regression', introduced: ['src/cli/foo.test.ts > fails'], preexisting: ['src/harness/old.test.ts > known bad', 'scripts/kept.test.ts > also known'], knownEnv: ['src/maturity/env.test.ts > env only'], loadFlaky: [] },
  }));
  writeFileSync(gateVerdictPath(ledgerRoot, '0.2.25'), JSON.stringify({
    version: '0.2.25', commit: 'a'.repeat(40), outcome: 'regression',
    introduced: ['src/cli/foo.test.ts > fails'],
    preexisting: ['src/harness/old.test.ts > known bad', 'scripts/kept.test.ts > also known'],
    knownEnv: ['src/maturity/env.test.ts > env only'],
    loadFlaky: [],
  }));
  // 0.2.27 — foo fails again (watch list hit #1) ⊕ a load-flaky row.
  write('release-loop', 'aba.json', ledger({
    version: '0.2.27', startedAt: '2026-10-05T01:00:00.000Z',
    gate: { outcome: 'regression', introduced: ['src/cli/foo.test.ts > fails again'], preexisting: 0, knownEnv: 0, loadFlaky: ['apps/pwa/src/wiggle.test.ts > timed out'] },
  }));
  // 0.2.28 — foo fails a third time (watch list hit #2) ⊕ a light-rc run whose output is already an object.
  write('release-loop', 'aca.json', ledger({
    version: '0.2.28', startedAt: '2026-10-08T01:00:00.000Z',
    gate: { outcome: 'regression', introduced: ['src/cli/foo.test.ts > fails third'], preexisting: 0, knownEnv: 0, loadFlaky: [] },
  }));
  write('light-rc', 'acb.json', JSON.stringify({
    input: { version: '0.2.28' }, startedAt: '2026-10-08T02:00:00.000Z',
    nodes: [{ nodeId: 'gate', output: { outcome: 'regression', introduced: ['apps/pwa/src/wiggle.test.ts > timed out'], preexisting: 0, knownEnv: 0, loadFlaky: [] } }],
  }));
  // 0.2.26 — no verdict file for this version: the node's bare counts must still reach the table, not vanish.
  write('release-loop', 'ada.json', ledger({
    version: '0.2.26', startedAt: '2026-10-03T01:00:00.000Z',
    gate: { outcome: 'regression', introduced: [], preexisting: 2, knownEnv: 1, loadFlaky: [] },
  }));
  // A retry of the same version — the same bare failures, so the version still counts 2 (never 4).
  write('release-loop', 'adb.json', ledger({
    version: '0.2.26', startedAt: '2026-10-03T02:00:00.000Z',
    gate: { outcome: 'regression', introduced: [], preexisting: 2, knownEnv: 1, loadFlaky: [] },
  }));
  // Unreadable ledgers: broken JSON, no version, a non-gate-only run, and a gate output that is not JSON.
  write('release-loop', 'broken.json', '{not json');
  write('release-loop', 'nover.json', JSON.stringify({ input: {} }));
  write('release-loop', 'early.json', JSON.stringify({ input: { version: '0.2.26' }, nodes: [{ nodeId: 'version-release', output: '{"outcome":"ok"}' }] }));
  write('release-loop', 'badout.json', JSON.stringify({ input: { version: '0.2.26' }, nodes: [{ nodeId: 'gate', output: 'not json' }] }));
  return { root, instanceRoot, ledgerRoot };
}

describe('GATE-FAIL-HISTORY — gateOutputsOfLedger', () => {
  test('reads gate node outputs as JSON strings or objects, skips other nodes', () => {
    const outputs = gateOutputsOfLedger({ nodes: [
      { nodeId: 'version-release', output: '{"outcome":"ok"}' },
      { nodeId: 'gate', output: '{"outcome":"regression","introduced":[]}' },
      { nodeId: 'gate', output: { outcome: 'ok' } },
      { nodeId: 'gate', output: 'not json' },
    ] });
    expect(outputs).toEqual([{ outcome: 'regression', introduced: [] }, { outcome: 'ok' }]);
  });
});

describe('GATE-FAIL-HISTORY — readGateHistoryRecords', () => {
  test('keeps bare counts while naming verdict ids and counts unreadable ledgers', () => {
    const f = fixtures();
    try {
      const { records, unreadable } = readGateHistoryRecords([f.instanceRoot], [f.ledgerRoot]);
      // broken.json, nover.json, badout.json (a gate node whose output cannot be read); early.json has no gate node at all (a readable run that never reached one).
      expect(unreadable).toBe(3);
      const first = records.find((record) => record.runId === 'aaa')!;
      expect(first.version).toBe('0.2.25');
      expect(first.buckets.introduced).toEqual(['src/cli/foo.test.ts > fails']);
      expect(first.buckets.preexisting).toEqual(['src/harness/old.test.ts > known bad', 'scripts/kept.test.ts > also known']);
      expect(first.buckets.knownEnv).toEqual(['src/maturity/env.test.ts > env only']);
      expect(first.unattributed).toEqual({ preexisting: 2, knownEnv: 1 });
      const objectOutput = records.find((record) => record.runId === 'acb')!;
      expect(objectOutput.graph).toBe('light-rc');
      expect(objectOutput.buckets.introduced).toEqual(['apps/pwa/src/wiggle.test.ts > timed out']);
      const bare = records.find((record) => record.runId === 'ada')!;
      expect(bare.unattributed).toEqual({ preexisting: 2, knownEnv: 1 });
      expect(bare.buckets.preexisting).toBeUndefined();
      expect(records.length).toBe(8);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('GATE-FAIL-HISTORY — gateHistory', () => {
  test('aggregates per file, dedupes a version, makes the watch list, and carries cause PRs', () => {
    const f = fixtures();
    try {
      const mergedPrs = () => [
        // Repair PR merged while 0.2.27 was the open gate — its body names the cause PR.
        { number: 300, title: 'fix foo', body: '원인 #123', mergedAt: '2026-10-06T01:00:00.000Z' },
        { number: 301, title: 'unrelated', body: 'no cause line', mergedAt: '2026-10-06T02:00:00.000Z' },
        { number: 302, title: 'later repair', body: '원인 #999', mergedAt: '2026-10-09T00:00:00.000Z' },
      ];
      const report = gateHistory({ instanceRoots: [f.instanceRoot], ledgerRoots: [f.ledgerRoot] }, { mergedPrs });
      expect(report.versions).toEqual(['0.2.25', '0.2.26', '0.2.27', '0.2.28']);
      expect(report.runs).toBe(8);
      expect(report.unreadable).toBe(3);
      const foo = report.rows.find((row) => row.file === 'src/cli/foo.test.ts')!;
      expect(foo).toBeDefined();
      expect(foo.introduced).toBe(3);
      expect(foo.preexisting).toBe(0);
      expect(foo.lastFailVersion).toBe('0.2.28');
      // The 0.2.27 repair names cause #123 (merged in its window); the repair merged while 0.2.28 was open names #999.
      expect(foo.causePrs).toEqual([123, 999]);
      const preexisting = report.rows.find((row) => row.file === 'src/harness/old.test.ts')!;
      expect(preexisting.preexisting).toBe(1);
      expect(preexisting.lastFailVersion).toBe('0.2.25');
      // 0.2.26 has no verdict file — its bare counts (기존 2, 환경 1) reach the table as the unnamed row, once for the version.
      const unnamed = report.rows.find((row) => row.file === UNATTRIBUTED_FILE)!;
      expect(unnamed).toBeDefined();
      expect(unnamed.introduced).toBe(0);
      expect(unnamed.preexisting).toBe(2);
      expect(unnamed.env).toBe(1);
      expect(unnamed.flaky).toBe(0);
      expect(unnamed.lastFailVersion).toBe('0.2.26');
      expect(unnamed.causePrs).toEqual([]);
      expect(formatGateHistory(report)).toContain('(파일 미상) · 새 0 · 기존 2 · 환경 1 · 흔들림 0 · 마지막 실패 0.2.26');
      // foo failed (introduced) in all three versions; wiggle was flaky in 0.2.27 and introduced in 0.2.28 (light-rc).
      expect(report.watchList).toEqual(['apps/pwa/src/wiggle.test.ts', 'src/cli/foo.test.ts']);
      expect(report.causePrsByVersion['0.2.27']).toEqual([123]);
      expect(report.causePrsByVersion['0.2.28']).toEqual([999]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('--since filters by version and by date, top truncates the printed rows', () => {
    const f = fixtures();
    try {
      const sinceVersion = gateHistory({ instanceRoots: [f.instanceRoot], ledgerRoots: [f.ledgerRoot], since: '0.2.27' });
      expect(sinceVersion.versions).toEqual(['0.2.27', '0.2.28']);
      expect(sinceVersion.unreadable).toBe(3);
      const sinceDate = gateHistory({ instanceRoots: [f.instanceRoot], ledgerRoots: [f.ledgerRoot], since: '2026-10-05' });
      expect(sinceDate.versions).toEqual(['0.2.27', '0.2.28']);
      const lines = formatGateHistory(sinceVersion, 1);
      expect(lines[0]).toContain('못 읽음 3');
      expect(lines).toHaveLength(3); // header + 1 top row + 감시 목록
      expect(formatGateHistory(sinceVersion, 0)).toContain(`상위 제한으로 실패 행 ${sinceVersion.rows.length}개 생략`);
      expect(formatGateHistory(sinceVersion, 0)).not.toContain('읽은 원장에 게이트 실패가 없다');
      expect(formatGateHistory({ ...sinceVersion, rows: [], watchList: [] }, 0)).toContain('읽은 원장에 실패 ID가 없다 · 못 읽은 원장 3건');
      expect(formatGateHistory({ ...sinceVersion, rows: [], watchList: [], unreadable: 0 }, 0)).toContain('읽은 원장에 게이트 실패가 없다');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('an error gate with no failure ids is reported as an error, not clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-error-empty-'));
    const instance = join(root, 'instance');
    mkdirSync(join(instance, 'graph-runs', 'release-loop'), { recursive: true });
    try {
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'run.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00Z',
        gate: { outcome: 'error', introduced: [], preexisting: 0, rehearsalTui: { outcome: 'fail', detail: 'help-closes' } },
      }));
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'no-buckets.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T02:00:00Z',
        gate: { outcome: 'error', rehearsalTui: { outcome: 'unmeasured', detail: 'result missing' } },
      }));
      const report = gateHistory({ instanceRoots: [instance], ledgerRoots: [] });
      expect(report).toMatchObject({ runs: 2, errorRuns: 2, rows: [] });
      expect(formatGateHistory(report)).toContain('게이트 오류 2런 · 실패 ID 없음');
      expect(formatGateHistory(report)).not.toContain('읽은 원장에 게이트 실패가 없다');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('date filter cannot reintroduce an excluded commit through the version verdict; retries count per file', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-since-'));
    const instance = join(root, 'instance');
    const machine = join(root, 'ledger');
    mkdirSync(join(instance, 'graph-runs', 'release-loop'), { recursive: true });
    mkdirSync(join(machine, 'release', '0.2.30'), { recursive: true });
    const run = (name: string, at: string, commit: string, ids: string[]) => writeFileSync(
      join(instance, 'graph-runs', 'release-loop', `${name}.json`),
      ledger({ version: '0.2.30', startedAt: at, gate: { commit, outcome: 'regression', introduced: ids } }),
    );
    try {
      run('old', '2026-10-01T00:00:00Z', 'a'.repeat(40), ['src/old.test.ts > failure']);
      run('new', '2026-10-02T00:00:00Z', 'b'.repeat(40), ['src/new.test.ts > first', 'src/new.test.ts > second']);
      run('retry', '2026-10-02T01:00:00Z', 'c'.repeat(40), ['src/new.test.ts > third']);
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'unknown.json'), JSON.stringify({
        input: { version: '0.2.30' }, startedAt: 'invalid',
        nodes: [{ nodeId: 'gate', output: { commit: 'e'.repeat(40), outcome: 'regression', introduced: ['src/unknown.test.ts > failure'] } }],
      }));
      writeFileSync(gateVerdictPath(machine, '0.2.30'), JSON.stringify({
        version: '0.2.30', commit: 'a'.repeat(40), introduced: ['src/old.test.ts > failure'],
      }));
      const report = gateHistory({ instanceRoots: [instance], ledgerRoots: [machine], since: '2026-10-02' });
      expect(report.runs).toBe(2);
      expect(report.rows).toMatchObject([{ file: 'src/new.test.ts', introduced: 1, lastFailVersion: '0.2.30' }]);
      expect(report.rows.some((row) => row.file === 'src/old.test.ts')).toBe(false);
      expect(report.rows.some((row) => row.file === 'src/unknown.test.ts')).toBe(false);
      expect(report.watchList).toEqual([]);
      run('shared-commit', '2026-10-01T03:00:00Z', 'b'.repeat(40), ['src/old.test.ts > another failure']);
      writeFileSync(gateVerdictPath(machine, '0.2.30'), JSON.stringify({
        version: '0.2.30', commit: 'b'.repeat(40), introduced: ['src/old.test.ts > leaked from shared commit'],
      }));
      const shared = gateHistory({ instanceRoots: [instance], ledgerRoots: [machine], since: '2026-10-02' });
      expect(shared.runs).toBe(2);
      expect(shared.rows).toMatchObject([{ file: 'src/new.test.ts', introduced: 1 }]);
      // Same-version verdict from a different commit must not bleed into either included run.
      writeFileSync(gateVerdictPath(machine, '0.2.30'), JSON.stringify({
        version: '0.2.30', commit: 'd'.repeat(40), introduced: ['src/foreign.test.ts > failure'],
      }));
      expect(gateHistory({ instanceRoots: [instance], ledgerRoots: [machine] }).rows.some((row) => row.file === 'src/foreign.test.ts')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('named ids from another commit cannot erase a run\'s unnamed failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-named-'));
    const instanceRoot = join(root, 'instance');
    for (const graph of GATE_HISTORY_GRAPHS) mkdirSync(join(instanceRoot, 'graph-runs', graph), { recursive: true });
    const write = (graph: string, name: string, body: string) => writeFileSync(join(instanceRoot, 'graph-runs', graph, name), body);
    try {
      write('release-loop', 'bare.json', ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00.000Z',
        gate: { commit: 'a'.repeat(40), outcome: 'regression', introduced: [], preexisting: 2, knownEnv: 0, loadFlaky: [] },
      }));
      write('light-rc', 'named.json', ledger({
        version: '0.2.30', startedAt: '2026-10-10T02:00:00.000Z',
        gate: { commit: 'b'.repeat(40), outcome: 'regression', introduced: [], preexisting: ['src/named/old.test.ts > first', 'src/named/old.test.ts > second'], knownEnv: 0, loadFlaky: [] },
      }));
      const report = gateHistory({ instanceRoots: [instanceRoot], ledgerRoots: [] });
      expect(report.rows.find((row) => row.file === 'src/named/old.test.ts')!.preexisting).toBe(1);
      expect(report.rows.find((row) => row.file === UNATTRIBUTED_FILE)!.preexisting).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a verdict for same-commit retries cannot assign one retry\'s failures to the other', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-retry-'));
    const instance = join(root, 'instance');
    const machine = join(root, 'ledger');
    mkdirSync(join(instance, 'graph-runs', 'release-loop'), { recursive: true });
    mkdirSync(join(machine, 'release', '0.2.30'), { recursive: true });
    try {
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'first.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00Z',
        gate: { commit: 'a'.repeat(40), outcome: 'regression', preexisting: 2 },
      }));
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'retry.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T02:00:00Z',
        gate: { commit: 'a'.repeat(40), outcome: 'regression', preexisting: ['src/retry.test.ts > only retry'] },
      }));
      writeFileSync(gateVerdictPath(machine, '0.2.30'), JSON.stringify({
        version: '0.2.30', commit: 'a'.repeat(40), preexisting: ['src/verdict.test.ts > latest'],
      }));
      const report = gateHistory({ instanceRoots: [instance], ledgerRoots: [machine] });
      expect(report.rows.find((row) => row.file === UNATTRIBUTED_FILE)?.preexisting).toBe(2);
      expect(report.rows.find((row) => row.file === 'src/retry.test.ts')?.preexisting).toBe(1);
      expect(report.rows.some((row) => row.file === 'src/verdict.test.ts')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('terminal gate output and its commit supersede an earlier gate node', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-terminal-'));
    const instance = join(root, 'instance');
    const machine = join(root, 'ledger');
    mkdirSync(join(instance, 'graph-runs', 'release-loop'), { recursive: true });
    mkdirSync(join(machine, 'release', '0.2.30'), { recursive: true });
    try {
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'run.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00Z', nodes: [
          { nodeId: 'gate', output: { commit: 'a'.repeat(40), outcome: 'regression', introduced: ['src/old.test.ts > old'] } },
          { nodeId: 'gate', output: { commit: 'b'.repeat(40), outcome: 'regression', introduced: ['src/new.test.ts > final'] } },
        ],
      }));
      writeFileSync(gateVerdictPath(machine, '0.2.30'), JSON.stringify({
        version: '0.2.30', commit: 'a'.repeat(40), introduced: ['src/old.test.ts > superseded'],
      }));
      const report = gateHistory({ instanceRoots: [instance], ledgerRoots: [machine] });
      expect(report.rows).toMatchObject([{ file: 'src/new.test.ts', introduced: 1 }]);
      expect(report.rows.some((row) => row.file === 'src/old.test.ts')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a corrupt terminal gate output is unreadable and never revives an earlier result', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-corrupt-terminal-'));
    const instance = join(root, 'instance');
    mkdirSync(join(instance, 'graph-runs', 'release-loop'), { recursive: true });
    try {
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'run.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00Z', nodes: [
          { nodeId: 'gate', output: { outcome: 'regression', introduced: ['src/old.test.ts > superseded'] } },
          { nodeId: 'gate', output: '{damaged' },
        ],
      }));
      const report = gateHistory({ instanceRoots: [instance], ledgerRoots: [] });
      expect(report).toMatchObject({ runs: 0, unreadable: 1, rows: [] });
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'run.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00Z', nodes: [
          { nodeId: 'gate', output: { outcome: 'regression', introduced: ['src/old.test.ts > superseded'] } },
          { nodeId: 'gate', output: {} },
        ],
      }));
      expect(gateHistory({ instanceRoots: [instance], ledgerRoots: [] })).toMatchObject({
        runs: 0, unreadable: 1, rows: [],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a file has one classified hit per version across introduced and flaky retries', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-history-bucket-'));
    const instance = join(root, 'instance');
    mkdirSync(join(instance, 'graph-runs', 'release-loop'), { recursive: true });
    try {
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'first.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T01:00:00Z',
        gate: { outcome: 'regression', introduced: ['src/shared.test.ts > regression'] },
      }));
      writeFileSync(join(instance, 'graph-runs', 'release-loop', 'retry.json'), ledger({
        version: '0.2.30', startedAt: '2026-10-10T02:00:00Z',
        gate: { outcome: 'regression', loadFlaky: ['src/shared.test.ts > passed on retry'] },
      }));
      expect(gateHistory({ instanceRoots: [instance], ledgerRoots: [] }).rows).toMatchObject([
        { file: 'src/shared.test.ts', introduced: 1, flaky: 0 },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('GATE-FAIL-HISTORY — helpers', () => {
  test('causePrNumbersOf reads «원인 #N» uniquely', () => {
    expect(causePrNumbersOf('원인 #5\n원인 #5 · also 원인 #7')).toEqual([5, 7]);
    expect(causePrNumbersOf('none')).toEqual([]);
  });
  test('compareGateVersions orders rc before final', () => {
    expect(compareGateVersions('0.2.28-rc.1', '0.2.28')).toBeLessThan(0);
    expect(compareGateVersions('0.2.28', '0.2.27')).toBeGreaterThan(0);
  });
  test('passesSince rejects a bad --since', () => {
    expect(() => passesSince('0.2.28', null, 'yesterday')).toThrow();
    expect(() => passesSince('0.2.28', null, '2026-13-01')).toThrow();
    expect(() => passesSince('0.2.28', null, '2026-02-30')).toThrow();
    expect(passesSince('0.2.28', null, '2026-10-01')).toBe(false);
    expect(passesSince('0.2.28', 'not-a-date', '2026-10-01')).toBe(false);
    expect(passesSince('0.2.28', '2026-02-30T00:00:00Z', '2026-03-01')).toBe(false);
    expect(() => gateHistory({ instanceRoots: [], ledgerRoots: [], since: '2026-13-01' })).toThrow();
  });
  test('causePrsByVersion windows each version between run starts', () => {
    const firstRunAt = { '0.2.25': '2026-10-01T01:00:00.000Z', '0.2.27': '2026-10-05T01:00:00.000Z', '0.2.28': '2026-10-08T01:00:00.000Z' };
    const byVersion = causePrsByVersion(['0.2.25', '0.2.27', '0.2.28'], firstRunAt, [
      { number: 10, title: 'a', body: '원인 #11', mergedAt: '2026-10-02T00:00:00.000Z' },
      { number: 20, title: 'b', body: '원인 #21', mergedAt: '2026-10-06T00:00:00.000Z' },
    ]);
    expect(byVersion['0.2.25']).toEqual([11]);
    expect(byVersion['0.2.27']).toEqual([21]);
    expect(byVersion['0.2.28']).toEqual([]);
  });
  test('applyWatchList adds only missing lines, idempotently', () => {
    const text = '# header\nsrc/keep.test.ts\n';
    const once = applyWatchList(text, ['src/keep.test.ts', 'src/new.test.ts']);
    expect(once.added).toEqual(['src/new.test.ts']);
    expect(once.text).toContain('src/new.test.ts');
    const twice = applyWatchList(once.text, ['src/new.test.ts']);
    expect(twice.added).toEqual([]);
    expect(twice.text).toBe(once.text);
    const duplicated = applyWatchList(text, ['src/new.test.ts', 'src/new.test.ts']);
    expect(duplicated.added).toEqual(['src/new.test.ts']);
    expect(duplicated.text.match(/src\/new\.test\.ts/g)).toHaveLength(1);
  });
});
