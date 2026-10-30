import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, loadRunLedger, runLedgerDir } from './run-ledger.js';
import { readDoctorVisits, runDoctorHandoff } from './doctor-visit.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seedHandoff() {
  const root = mkdtempSync(join(tmpdir(), 'run-doctor-handoff-'));
  roots.push(root);
  const runId = 'run-22222222-2222-4222-8222-222222222222';
  const dir = runLedgerDir(root);
  const stopKey = `${runId}:wait-streak:1`;
  appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId, event: 'start', data: { feature: 'wait handoff fixture' } }, dir);
  appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId, event: 'run-chart-cell',
    data: { device: 'run-supervisor', stopKey, observed: 'consecutive waits=3', verdict: 'wait', action: 'wait',
      waitCount: 3, handoff: 'run-doctor', failureClass: 'implement-aborted', readStopKeys: [], why: 'stalled' } }, dir);
  return { runId, dir, stopKey };
}

test('run doctor reads the persisted handoff, selects the PR1 graph prescription, acts once, and records the result', async () => {
  const fixture = seedHandoff();
  const actions: string[] = [];
  const input = { ...fixture, dispatch: (action: string) => { actions.push(action); return { outcome: 'heal-graph-requested' }; } };

  const result = await runDoctorHandoff(input);
  expect(result).toMatchObject({ status: 'acted', action: 'reauthor-from-materialized', outcome: 'heal-graph-requested' });
  expect(actions).toEqual(['reauthor-from-materialized']);
  expect(readDoctorVisits(fixture.runId, { dir: fixture.dir })).toEqual([
    expect.objectContaining({ from: 'supervisor', symptom: 'no-progress', evidence: 'consecutive wait decisions=3' }),
  ]);
  const rx = loadRunLedger(fixture.runId, fixture.dir)!.filter((entry) => entry.event === 'doctor-rx');
  expect(loadRunLedger(fixture.runId, fixture.dir)!.at(-1)?.data).toMatchObject({ device: 'run-doctor',
    stopKey: fixture.stopKey, handoff: 'reauthor', action: 'reauthor-from-materialized' });
  expect(rx.map((entry) => entry.data.status)).toEqual(['started', 'completed']);
  expect(rx.at(-1)?.data).toMatchObject({ action: 'reauthor-from-materialized', executed: true, outcome: 'heal-graph-requested' });
  await expect(runDoctorHandoff(input)).resolves.toMatchObject({ status: 'already-acted', action: 'reauthor-from-materialized' });
  expect(actions).toHaveLength(1);
});

test('run doctor records needs-human when the chosen executor cannot act', async () => {
  const fixture = seedHandoff();
  const result = await runDoctorHandoff({ ...fixture, dispatch: () => { throw new Error('heal intake unavailable'); } });
  expect(result).toMatchObject({ status: 'needs-human', action: 'reauthor-from-materialized', outcome: 'needs-human' });
  expect([...loadRunLedger(fixture.runId, fixture.dir)!].reverse().find((entry) => entry.event === 'doctor-rx')?.data).toMatchObject({
    device: 'run-doctor', status: 'needs-human', action: 'reauthor-from-materialized', executed: false,
  });
  expect(loadRunLedger(fixture.runId, fixture.dir)!.at(-1)?.data).toMatchObject({
    device: 'run-doctor', handoff: 'outer-supervisor', verdict: 'needs-human',
  });
});

test('run doctor does not infer a handoff from an empty or unrelated ledger', async () => {
  const fixture = seedHandoff();
  await expect(runDoctorHandoff({ ...fixture, stopKey: `${fixture.runId}:other`, dispatch: () => ({ outcome: 'unexpected' }) }))
    .resolves.toMatchObject({ status: 'missing-handoff' });
});
