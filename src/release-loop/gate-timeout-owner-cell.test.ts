import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { checklistHistory, listChecklist } from './checklist.js';
import { recordGateTimeoutOwnerCells } from './gate-timeout-owner-cell.js';

const roots: string[] = [];
let previousConfigDirEnv: string | undefined;
let restoreConfigDirEnv = false;
function ledgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-timeout-owner-cell-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  resetElanousConfigDir();
  if (restoreConfigDirEnv) {
    if (previousConfigDirEnv === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = previousConfigDirEnv;
    restoreConfigDirEnv = false;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const testId = 'src/release-loop/gate-node.test.ts > slow baseline case';
const commit = (n: number) => n.toString(16).padStart(40, '0');

test('GATE-TIMEOUT-NOT-BLOCK sim: creates one real owner cell after three distinct consecutive unmeasurable cuts', () => {
  const root = ledgerRoot();
  if (!restoreConfigDirEnv) { previousConfigDirEnv = process.env.ELANOUS_CONFIG_DIR; restoreConfigDirEnv = true; }
  process.env.ELANOUS_CONFIG_DIR = root;
  setElanousConfigDir(root);
  const first = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId] });
  const retry = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId] });
  const second = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(2), unmeasurableIds: [testId] });
  const third = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(3), unmeasurableIds: [testId] });
  const cellId = third[0]!.cellId!;

  expect(first[0]).toMatchObject({ streak: 1, created: false });
  expect(retry[0]).toMatchObject({ streak: 1, created: false });
  expect(second[0]).toMatchObject({ streak: 2, created: false });
  expect(third[0]).toMatchObject({ streak: 3, cellId: expect.stringMatching(/^GATE-TIMEOUT-OWNER-[A-F0-9]{16}$/), created: true });
  expect(checklistHistory(cellId)).toHaveLength(1);
  expect(listChecklist('0.3.6').items.find((item) => item.id === cellId)).toMatchObject({ owner: 'OPT', status: 'yellow', dispatchKind: 'code' });
  expect(listChecklist('0.3.6').items.find((item) => item.id === cellId)!.title).toContain(testId);

  const ledger = new Database(join(root, 'release', 'gate-timeout-owner-cells.sqlite'));
  const reachedAt = (ledger.query('SELECT at FROM timeout_observations WHERE test_id = ? AND commit_sha = ?').get(testId, commit(3)) as { at: string }).at;
  ledger.query('DELETE FROM completed_owner_cells WHERE test_id = ?').run(testId);
  ledger.query('INSERT INTO pending_owner_cells (test_id, version, cell_id, threshold, reached_at) VALUES (?, ?, ?, ?, ?)')
    .run(testId, '0.3.6', cellId, 3, reachedAt);
  ledger.close();
  const later = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(4), unmeasurableIds: [testId] });
  expect(later[0]).toMatchObject({ streak: 4, cellId, created: false });
  expect(checklistHistory(cellId)).toHaveLength(1);
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.7', commit: commit(5), unmeasurableIds: [], measuredIds: [testId] });
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.7', commit: commit(6), unmeasurableIds: [testId] });
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.7', commit: commit(7), unmeasurableIds: [testId] });
  const afterReset = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.7', commit: commit(8), unmeasurableIds: [testId] });
  expect(afterReset[0]).toMatchObject({ streak: 3, created: false });
  expect(checklistHistory(cellId)).toHaveLength(1);
});

test('GATE-TIMEOUT-NOT-BLOCK sim: old commit replay cannot inflate a streak, and measured baselines reset only their test', () => {
  const root = ledgerRoot();
  const created: unknown[] = [];
  const seenCells = new Set<string>();
  const ensureCell = (cell: { id: string }) => {
    if (seenCells.has(cell.id)) return false;
    seenCells.add(cell.id);
    created.push(cell);
    return true;
  };
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId, 'src/other.test.ts > other'] }, { ensureCell });
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(2), unmeasurableIds: [testId, 'src/other.test.ts > other'] }, { ensureCell });
  const replay = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId, 'src/other.test.ts > other'] }, { ensureCell });
  const measured = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(3), measuredIds: [testId], unmeasurableIds: ['src/other.test.ts > other'] }, { ensureCell });
  const next = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(4), unmeasurableIds: [testId, 'src/other.test.ts > other'] }, { ensureCell });

  expect(replay.find((row) => row.testId === testId)).toMatchObject({ streak: 2, created: false });
  expect(measured.find((row) => row.testId === testId)).toMatchObject({ streak: 0, created: false });
  expect(measured.find((row) => row.testId === 'src/other.test.ts > other')).toMatchObject({ streak: 3, created: true });
  expect(next.find((row) => row.testId === testId)).toMatchObject({ streak: 1, created: false });
  expect(created).toHaveLength(1);
});

test('GATE-TIMEOUT-NOT-BLOCK sim: malformed rows and invalid streak transitions fail closed', () => {
  const cases = [
    { outcome: 'measured', streak: 3 },
    { outcome: 'unmeasurable', streak: 99 },
  ] as const;
  for (const [index, invalid] of cases.entries()) {
    const root = ledgerRoot();
    mkdirSync(join(root, 'release'), { recursive: true });
    const db = new Database(join(root, 'release/gate-timeout-owner-cells.sqlite'), { create: true });
    db.exec(`CREATE TABLE timeout_observations (test_id TEXT NOT NULL, commit_sha TEXT NOT NULL, version TEXT NOT NULL, outcome TEXT NOT NULL, streak INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (test_id, commit_sha))`);
    db.query('INSERT INTO timeout_observations VALUES (?, ?, ?, ?, ?, ?)').run(testId, commit(index + 20), '0.3.6', invalid.outcome, invalid.streak, new Date().toISOString());
    db.close();
    let created = false;

    expect(recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(index + 30), unmeasurableIds: [testId] }, {
      ensureCell: () => { created = true; return true; },
    })).toEqual([]);
    expect(created).toBe(false);
  }
});

test('GATE-TIMEOUT-NOT-BLOCK sim: a pending cell without its threshold observation fails closed', () => {
  const root = ledgerRoot();
  const observedId = 'src/observed.test.ts > case';
  const fakeId = 'src/fake.test.ts > forged pending';
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [observedId] });
  const fakeCellId = `GATE-TIMEOUT-OWNER-${createHash('sha256').update(fakeId).digest('hex').slice(0, 16).toUpperCase()}`;
  const db = new Database(join(root, 'release', 'gate-timeout-owner-cells.sqlite'));
  db.query('INSERT INTO pending_owner_cells (test_id, version, cell_id, threshold, reached_at) VALUES (?, ?, ?, ?, ?)')
    .run(fakeId, '0.3.6', fakeCellId, 3, new Date().toISOString());
  db.close();
  let ensured = false;
  const result = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(2), unmeasurableIds: [observedId] }, {
    ensureCell: () => { ensured = true; return true; },
  });

  expect(result).toEqual([]);
  expect(ensured).toBe(false);
});

test('GATE-TIMEOUT-NOT-BLOCK sim: persisted threshold survives owner-cell store failure and retry creates exactly once', () => {
  const root = ledgerRoot();
  const failed = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId] });
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(2), unmeasurableIds: [testId] });
  const threshold = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(3), unmeasurableIds: [testId] }, {
    ensureCell: () => { throw new Error('injected checklist write failure'); },
  });
  const retried = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(3), unmeasurableIds: [testId] }, {
    ensureCell: () => true,
  });

  expect(failed[0]).toMatchObject({ streak: 1, created: false });
  expect(threshold[0]).toMatchObject({ streak: 3, created: false });
  expect(retried[0]).toMatchObject({ streak: 3, created: true });
});

test('GATE-TIMEOUT-NOT-BLOCK sim: an uncreated threshold cell survives a later measurement and retries in its original version', () => {
  const root = ledgerRoot();
  const missed = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId] }, { ensureCell: () => false });
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(2), unmeasurableIds: [testId] }, { ensureCell: () => false });
  const threshold = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(3), unmeasurableIds: [testId] }, {
    ensureCell: () => { throw new Error('injected checklist write failure'); },
  });
  const ledger = new Database(join(root, 'release', 'gate-timeout-owner-cells.sqlite'), { readonly: true });
  expect(ledger.query('SELECT test_id FROM pending_owner_cells').all()).toHaveLength(1);
  ledger.close();
  recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.7', commit: commit(4), unmeasurableIds: [], measuredIds: [testId] }, { ensureCell: () => {
    throw new Error('injected checklist write failure');
  } });
  const ledgerAfterMeasurement = new Database(join(root, 'release', 'gate-timeout-owner-cells.sqlite'), { readonly: true });
  expect(ledgerAfterMeasurement.query('SELECT test_id FROM pending_owner_cells').all()).toHaveLength(1);
  const retriedVersions: string[] = [];
  const replay = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [testId] }, {
    ensureCell: (cell) => { retriedVersions.push(cell.version); return true; },
  });

  expect(missed[0]).toMatchObject({ streak: 1, created: false });
  expect(threshold[0]).toMatchObject({ streak: 3, created: false });
  expect(retriedVersions).toEqual(['0.3.6']);
  expect(replay[0]).toMatchObject({ streak: 0, cellId: expect.stringMatching(/^GATE-TIMEOUT-OWNER-/), created: true });
  ledgerAfterMeasurement.close();
});

test('GATE-TIMEOUT-NOT-BLOCK sim: rejects unsafe IDs and normalizes SHA casing without poisoning or double-counting the ledger', () => {
  const root = ledgerRoot();
  const invalid = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(1), unmeasurableIds: [`${testId}\npoison`] });
  const lower = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.6', commit: commit(2), unmeasurableIds: [testId] });
  const upper = recordGateTimeoutOwnerCells({ ledgerRoot: root, version: '0.3.7', commit: commit(2).toUpperCase(), unmeasurableIds: [testId] });

  expect(invalid).toEqual([]);
  expect(lower[0]).toMatchObject({ streak: 1, created: false });
  expect(upper[0]).toMatchObject({ streak: 1, created: false });
});

test('GATE-TIMEOUT-NOT-BLOCK sim: concurrent processes serialize the same-cut observation', async () => {
  const root = ledgerRoot();
  const moduleUrl = new URL('./gate-timeout-owner-cell.ts', import.meta.url).href;
  const childScript = `import { recordGateTimeoutOwnerCells } from ${JSON.stringify(moduleUrl)}; const result = recordGateTimeoutOwnerCells({ ledgerRoot: process.env.GATE_OWNER_CELL_TEST_ROOT, version: '0.3.6', commit: '${commit(1)}', unmeasurableIds: ['${testId}'] }); if (result.length !== 1 || result[0].streak !== 1) process.exit(2);`;
  const run = () => new Promise<{ code: number | null; error: string }>((resolve) => {
    const child = spawn(process.execPath, ['-e', childScript], { env: { ...process.env, GATE_OWNER_CELL_TEST_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { error += chunk; });
    child.on('error', (cause) => resolve({ code: null, error: String(cause) }));
    child.on('close', (code) => resolve({ code, error }));
  });
  const children = await Promise.all([run(), run()]);
  const db = new Database(join(root, 'release/gate-timeout-owner-cells.sqlite'), { readonly: true });
  const row = db.query('SELECT COUNT(*) AS count, MAX(streak) AS streak FROM timeout_observations WHERE test_id = ?').get(testId) as { count: number; streak: number };
  db.close();

  expect(children.map((child) => child.code)).toEqual([0, 0]);
  expect(children.map((child) => child.error).join('')).toBe('');
  expect(row).toEqual({ count: 1, streak: 1 });
});
