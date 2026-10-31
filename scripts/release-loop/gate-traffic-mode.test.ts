import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithReleaseGateTraffic, runWithReleasePwaTraffic } from './gate-traffic-mode.js';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('release gate failure exit restores the previous global traffic mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-traffic-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  writeFileSync(path, JSON.stringify({ global: 'green', versions: ['0.2.35'], hold: ['KEEP'], reason: 'before', updatedAt: 'old' }));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'gate', runId: 'run-failure', input: {} }) };

  const exitCode = await runWithReleaseGateTraffic(env, async () => {
    expect(JSON.parse(readFileSync(path, 'utf8')).global).toBe('gate');
    return 1;
  });

  expect(exitCode).toBe(1);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ global: 'green', versions: ['0.2.35'], hold: ['KEEP'], reason: 'release gate finished' });
});

for (const outcome of ['success', 'failure'] as const) {
  test(`release PWA ${outcome} restores per-cycle traffic and heavy-local marker`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-pwa-traffic-'));
    scratch.push(root);
    const path = join(root, 'traffic.json');
    const before = { global: 'green', reason: 'before', heavyLocalBan: false,
      seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8, keep: seat }])) };
    writeFileSync(path, JSON.stringify(before));
    const env = { ELANOUS_TRAFFIC_SIGNAL: path,
      ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: `run-${outcome}`, input: {} }) };

    let failure: unknown;
    const run = runWithReleasePwaTraffic(env, async () => {
      const active = JSON.parse(readFileSync(path, 'utf8'));
      expect(active.global).toBe('green');
      expect(Object.values(active.seats).every((seat: any) => seat.perCycle === 3)).toBe(true);
      expect(active.heavyLocalBan).toBe(true);
      expect(active.seats.OP.keep).toBe('OP');
      if (outcome === 'failure') throw new Error('pwa failed');
      return 'ok';
    });
    if (outcome === 'failure') await run.catch(error => { failure = error; });
    else expect(await run).toBe('ok');
    if (outcome === 'failure') expect(String(failure)).toContain('pwa failed');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before);
  });
}

test('release PWA traffic wrapper ignores other graph nodes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-pwa-traffic-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  const before = { global: 'green', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8 }])) };
  writeFileSync(path, JSON.stringify(before));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'tui', runId: 'run-other', input: {} }) };

  await runWithReleasePwaTraffic(env, async () => undefined);

  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before);
});

test('release PWA policy failure is surfaced and the gate callback does not run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-pwa-traffic-invalid-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  const before = { global: 'green', seats: { OP: { perCycle: 8 } } };
  writeFileSync(path, JSON.stringify(before));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: 'run-invalid', input: {} }) };
  let called = false;

  await expect(runWithReleasePwaTraffic(env, async () => { called = true; })).rejects.toThrow('invalid traffic board for PWA policy');

  expect(called).toBe(false);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before);
});

test('preexisting heavy-local marker does not skip half-traffic and restores prior traffic fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-pwa-traffic-stale-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  const before = { global: 'green', reason: 'operator-owned', updatedAt: 'before', heavyLocalBan: true,
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8 }])) };
  writeFileSync(path, JSON.stringify(before));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: 'run-existing-ban', input: {} }) };

  await runWithReleasePwaTraffic(env, async () => {
    const active = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.values(active.seats).every((seat: any) => seat.perCycle === 3)).toBe(true);
    expect(active.reason).toBe('operator-owned');
    expect(active.heavyLocalBan).toBe(true);
  });

  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(before);
});

test('external updatedAt written during PWA execution is preserved at restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-pwa-traffic-external-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  const before = { global: 'green', updatedAt: 'before', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8 }])) };
  writeFileSync(path, JSON.stringify(before));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: 'run-external-write', input: {} }) };

  await runWithReleasePwaTraffic(env, async () => {
    const external = JSON.parse(readFileSync(path, 'utf8'));
    external.updatedAt = 'external-update';
    external.externalNote = 'keep';
    writeFileSync(path, JSON.stringify(external));
  });

  const restored = JSON.parse(readFileSync(path, 'utf8'));
  expect(restored.updatedAt).toBe('external-update');
  expect(restored.externalNote).toBe('keep');
  expect(Object.values(restored.seats).every((seat: any) => seat.perCycle === 8)).toBe(true);
});

test('PWA traffic backup history is bounded per policy write kind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-pwa-traffic-backups-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  writeFileSync(path, JSON.stringify({ global: 'green', seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map(seat => [seat, { perCycle: 8 }])) }));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'pwa', runId: 'run-backup-rotation', input: {} }) };

  for (let index = 0; index < 12; index++) await runWithReleasePwaTraffic(env, async () => undefined);

  const names = readdirSync(root).filter(name => name.startsWith('traffic.json.bak-'));
  expect(names.filter(name => name.endsWith('-release-pwa-policy')).length).toBe(10);
  expect(names.filter(name => name.endsWith('-release-pwa-restore')).length).toBe(10);
});
