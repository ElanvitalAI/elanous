import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectControlStatus, type ControlStatusDeps } from './control-status.js';
import type { DriftReport } from '../cli/config-drift.js';

const now = new Date('2026-10-08T12:00:00Z');
const freeze = { reason: '릴리스 점검', startedAt: now.toISOString(), until: null, by: 'OP' };
const drift = (overrides: { prodStatus?: DriftReport['prodStatus']; registryOk?: boolean; compared?: number; unreadable?: number; keys?: number } = {}): DriftReport => ({
  prodConfigPath: '/tmp/config.json', prodStatus: overrides.prodStatus ?? 'ok', includeExpected: false,
  universes: { total: 1, compared: overrides.compared ?? 1, noConfig: 0, unreadable: overrides.unreadable ?? 0, gone: 0 },
  registry: { path: '/tmp/instances.json', ok: overrides.registryOk ?? true, entries: 1, testEntries: 1 },
  treeScanRoots: [], unreadable: [],
  rows: Array.from({ length: overrides.keys ?? 1 }, () => ({ key: 'harness.podPool', prodPresent: true, prodValue: 'x', differing: 1,
    missingInDerived: 0, extraInDerived: 0, valueDiffers: 1, groups: [] })),
});

const emptyInstallRoot = mkdtempSync(join(tmpdir(), 'elanous-control-status-empty-'));
afterAll(() => { rmSync(emptyInstallRoot, { recursive: true, force: true }); });

const deps: ControlStatusDeps = {
  now: () => now,
  installRoot: emptyInstallRoot,
  readLease: () => ({ record: { holder: 'node-b', generation: 7, state: 'held', acquiredAt: 1, renewedAt: 2, ttlSeconds: 600 }, ageSeconds: 4, expired: false }),
  readFreeze: () => freeze,
  readLoops: () => ({ scope: 'registry', entries: [
    { id: 'failing-loop', enabled: true, registered: true, recentStatuses: ['failed', 'failed', 'failed'] },
    { id: 'healthy-loop', enabled: true, registered: true, lastRunAt: now.toISOString(), expectEveryMinutes: 10 },
  ] }),
  readDrift: () => drift(),
  log: () => {},
};

test('seven rows measure lease, freeze, failing loops and drift; disconnected sources stay unmeasured', async () => {
  const events: Array<{ row: string; state: string }> = [];
  const rows = await collectControlStatus({ ...deps, log: (_category, _event, data) => { events.push(data as { row: string; state: string }); } });
  expect(rows.map(r => r.row)).toEqual(['집', '판', '자원', '자격', '동결·몫', '루프', 'config']);
  expect(rows[0]).toMatchObject({ row: '집', state: 'ok' });
  expect(rows[0]!.text.includes('node-b')).toBe(true);
  expect(rows[0]!.text.includes('세대 7')).toBe(true);
  expect(rows.slice(1, 4).map(r => r.state)).toEqual(['unmeasured', 'unmeasured', 'unmeasured']);
  for (const row of rows.slice(1, 4)) { expect(row.text).toBe('못 쟀다'); expect(row.reason).toBeTruthy(); }
  expect(rows[4]).toMatchObject({ state: 'warn', text: expect.stringContaining('동결 켬') });
  expect(rows[5]).toMatchObject({ state: 'warn', text: expect.stringContaining('failing 1 (failing-loop)') });
  expect(rows[6]).toMatchObject({ state: 'warn', text: '드리프트 키 1' });
  expect(events).toEqual(rows.map(({ row, state }) => ({ row, state })));
});

test('a throwing freeze reader only makes the freeze row unmeasured', async () => {
  const baseline = await collectControlStatus(deps);
  const rows = await collectControlStatus({ ...deps, readFreeze: () => { throw new Error('read failed'); } });
  expect(rows).toHaveLength(7);
  expect(rows[4]).toMatchObject({ row: '동결·몫', state: 'unmeasured', text: '못 쟀다', reason: expect.any(String) });
  expect(rows.filter((_, i) => i !== 4)).toEqual(baseline.filter((_, i) => i !== 4));
});

test('each disconnected source fails independently without dropping the measured rows', async () => {
  const rows = await collectControlStatus({ ...deps,
    readVersion: () => { throw new Error('version unavailable'); },
    readResources: () => { throw new Error('resource unavailable'); },
    readCredentials: () => { throw new Error('credential unavailable'); },
    readDrift: () => { throw new Error('drift unavailable'); },
  });
  expect(rows).toHaveLength(7);
  for (const index of [1, 2, 3, 6]) expect(rows[index]).toMatchObject({ state: 'unmeasured', text: '못 쟀다', reason: expect.any(String) });
  expect(rows[0]!.state).toBe('ok');
  expect(rows[4]!.state).toBe('warn');
  expect(rows[5]!.state).toBe('warn');
});

test('absence of a lease and an off freeze cannot be displayed as healthy complete measurements', async () => {
  const rows = await collectControlStatus({ ...deps, readLease: () => ({ record: null, ageSeconds: null, expired: null }), readFreeze: () => null });
  expect(rows[0]).toMatchObject({ state: 'unmeasured', text: '못 쟀다', reason: expect.any(String) });
  expect(rows[4]).toMatchObject({ state: 'unmeasured', text: expect.stringContaining('동결 끔'), reason: expect.any(String) });
});

test('missing measurements never masquerade as zero or healthy', async () => {
  const rows = await collectControlStatus({ ...deps,
    readLease: () => { throw new Error('no arbiter'); },
    readLoops: () => ({ scope: 'registry', entries: [] }),
    readDrift: () => drift({ prodStatus: 'unreadable', registryOk: false, compared: 0, unreadable: 1, keys: 0 }),
  });
  for (const index of [0, 5, 6]) expect(rows[index]).toMatchObject({ state: 'unmeasured', text: '못 쟀다', reason: expect.any(String) });
});

test('version row reads the local install.json and stays unmeasured when it is missing', async () => {
  const present = mkdtempSync(join(tmpdir(), 'elanous-control-status-install-'));
  const absent = mkdtempSync(join(tmpdir(), 'elanous-control-status-absent-'));
  const broken = mkdtempSync(join(tmpdir(), 'elanous-control-status-broken-'));
  try {
    writeFileSync(join(present, 'install.json'), JSON.stringify({ version: '0.2.25', commit: '5fda696427ab' }));
    const measured = await collectControlStatus({ ...deps, installRoot: present });
    expect(measured[1]).toEqual({ row: '판', state: 'ok', text: '설치본 0.2.25 · 5fda696427ab' });
    expect(measured.filter((_, i) => i !== 1)).toEqual((await collectControlStatus(deps)).filter((_, i) => i !== 1));

    const missing = await collectControlStatus({ ...deps, installRoot: absent });
    expect(missing[1]).toMatchObject({ row: '판', state: 'unmeasured', text: '못 쟀다', reason: '이 기계 install.json 없음' });

    writeFileSync(join(broken, 'install.json'), '{');
    const unreadable = await collectControlStatus({ ...deps, installRoot: broken });
    expect(unreadable[1]).toMatchObject({ row: '판', state: 'unmeasured', text: '못 쟀다', reason: '이 기계 install.json 파싱 실패' });

    const injected = await collectControlStatus({ ...deps, installRoot: present, readVersion: () => ({ row: '판', state: 'ok', text: 'injected' }) });
    expect(injected[1]).toEqual({ row: '판', state: 'ok', text: 'injected' });
  } finally {
    for (const dir of [present, absent, broken]) rmSync(dir, { recursive: true, force: true });
  }
});
