import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { recordAutoLongRunVisit } from './doctor-visit.js';

const runId = 'run-1a2b3c4d-0000-4000-8000-000000000001';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seededLedger(): string {
  const root = mkdtempSync(join(tmpdir(), 'doctor-auto-long-run-'));
  roots.push(root);
  const dir = join(root, 'run-ledger');
  mkdirSync(dir);
  writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify({
    timestamp: '2026-10-23T00:00:00.000Z', runId, event: 'start', data: {},
  })}\n`);
  return dir;
}

test('60-minute boundary writes one auto long-run visit, and a second tick writes zero', () => {
  const dir = seededLedger();
  const startedAt = '2026-10-23T00:00:00.000Z';
  expect(recordAutoLongRunVisit({ runId, startedAt, now: '2026-10-23T00:59:59.999Z', dir })).toEqual({ status: 'below-threshold' });
  expect(recordAutoLongRunVisit({ runId, startedAt, now: '2026-10-23T01:00:00.000Z', dir })).toEqual({ status: 'recorded' });
  expect(recordAutoLongRunVisit({ runId, startedAt, now: '2026-10-23T01:10:00.000Z', dir })).toEqual({ status: 'already-recorded' });
  const entries = readFileSync(join(dir, `${runId}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(entries.filter((entry) => entry.event === 'doctor-visit')).toEqual([expect.objectContaining({
    runId, data: expect.objectContaining({ from: 'auto', symptom: 'long-run', thresholdMs: 3_600_000, thresholdWindow: '60m' }),
  })]);
});

test('a future Pod start time remains below threshold until the host clock catches up', () => {
  const dir = seededLedger();
  expect(recordAutoLongRunVisit({ runId, startedAt: '2026-10-23T01:00:01.000Z', now: '2026-10-23T01:00:00.000Z', dir }))
    .toEqual({ status: 'below-threshold' });
  const entries = readFileSync(join(dir, `${runId}.jsonl`), 'utf8').trim().split('\n');
  expect(entries).toHaveLength(1);
});

test('a missing run ledger does not create a synthetic auto visit', () => {
  const dir = seededLedger();
  const missingRunId = 'run-1a2b3c4d-0000-4000-8000-ffffffffffff';
  for (const now of ['2026-10-23T00:59:00.000Z', '2026-10-23T01:01:00.000Z']) {
    expect(() => recordAutoLongRunVisit({
      runId: missingRunId, startedAt: '2026-10-23T00:00:00.000Z', now, dir,
    })).toThrow('run-ledger-missing');
  }
  expect(recordAutoLongRunVisit({ runId, startedAt: '2026-10-23T00:00:00.000Z', now: '2026-10-23T01:01:00.000Z', dir }))
    .toEqual({ status: 'recorded' });
});
