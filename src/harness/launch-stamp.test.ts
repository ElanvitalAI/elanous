import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  doorFromEntrance,
  launchStampFromLedger,
  parseDoorSince,
  queryLaunchDoors,
  renderLaunchDoors,
  resolveLaunchStamp,
} from './launch-stamp.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledgerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'launch-stamp-'));
  dirs.push(dir);
  return dir;
}

function write(dir: string, runId: string, event: string, data: Record<string, unknown>, timestamp: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify({ timestamp, runId, event, data })}\n`, { flag: 'a' });
}

function firstRow(dir: string, runId: string): { event: string; data: { launch?: unknown } } {
  return JSON.parse(readFileSync(join(dir, `${runId}.jsonl`), 'utf8').split('\n')[0]!) as { event: string; data: { launch?: unknown } };
}

const NOW = Date.parse('2026-10-05T15:55:00.000Z');
const INSIDE = '2026-10-05T12:00:00.000Z';

describe('launch stamp', () => {
  test('direct harness say stamps harness-say and viaQueue false', () => {
    const stamp = resolveLaunchStamp({
      entrance: 'cli-harness-say',
      seat: 'OP',
      env: {},
    });
    expect(stamp).toEqual({ entrance: 'harness-say', actor: 'OP', viaQueue: false });
  });

  test('queue tick launch stamps queue-tick, viaQueue true, and the queue id', () => {
    const stamp = resolveLaunchStamp({
      entrance: 'cli-harness-say',
      seat: 'TC',
      env: { ELANOUS_HARNESS_QUEUE_LAUNCH: 'hq-11111111-1111-1111-1111-111111111111' },
    });
    expect(stamp).toEqual({
      entrance: 'queue-tick',
      actor: 'TC',
      viaQueue: true,
      queueId: 'hq-11111111-1111-1111-1111-111111111111',
    });
  });

  test('an untagged ledger reads unknown, which is not a zero', () => {
    const dir = ledgerDir();
    write(dir, 'run-untagged', 'run-origin', { hostId: 'old' }, INSIDE);
    const loaded = [JSON.parse(readFileSync(join(dir, 'run-untagged.jsonl'), 'utf8'))];
    expect(launchStampFromLedger(loaded)).toEqual({ entrance: 'unknown', actor: '', viaQueue: false });
    expect(doorFromEntrance(undefined)).toBe('unknown');
    expect(doorFromEntrance('not-a-door')).toBe('unknown');
  });

  test('door table totals equal the run count', () => {
    const dir = ledgerDir();
    write(dir, 'run-say', 'run-origin', { launch: { entrance: 'harness-say', actor: 'OP', viaQueue: false } }, INSIDE);
    write(dir, 'run-say', 'later', { note: 'not the first row' }, '2026-10-05T13:00:00.000Z');
    write(dir, 'run-tick', 'run-origin', {
      launch: { entrance: 'queue-tick', actor: 'TC', viaQueue: true, queueId: 'hq-22222222-2222-2222-2222-222222222222' },
    }, INSIDE);
    write(dir, 'run-old', 'start', { feature: 'before the stamp' }, INSIDE);
    write(dir, 'run-stale', 'run-origin', { launch: { entrance: 'dev-ask', actor: 'MK', viaQueue: false } }, '2026-10-01T00:00:00.000Z');
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: 24 * 60 * 60 * 1000 });
    expect(table.runs).toBe(3);
    expect(table.unknown).toBe(1);
    expect(table.outsideQueue).toBe(2);
    expect(table.viaQueue).toBe(1);
    expect(table.rows.reduce((sum, row) => sum + row.runs, 0)).toBe(table.runs);
    const rendered = renderLaunchDoors(table);
    expect(rendered).toContain('unknown');
    expect(rendered).toContain('queue-tick');
    expect(rendered).toContain('total               3');
  });

  test('actor falls back from seat to session to loop name', () => {
    expect(resolveLaunchStamp({ entrance: 'cli-dev-ask', session: 'human-1', env: {} }).actor).toBe('human-1');
    expect(resolveLaunchStamp({ entrance: 'cli-self-implement', loopName: 'seat-loop', env: {} })).toMatchObject({
      entrance: 'self-implement',
      actor: 'seat-loop',
      viaQueue: false,
    });
    expect(resolveLaunchStamp({ env: { ELANOUS_HARNESS_SEAT: 'UX', ELANOUS_HARNESS_ENTRANCE: 'cli-harness-ask' } })).toEqual({
      entrance: 'harness-ask',
      actor: 'UX',
      viaQueue: false,
    });
  });

  test('--since accepts 1d and refuses a bare number', () => {
    expect(parseDoorSince('1d')).toEqual({ sinceMs: 86_400_000 });
    expect(parseDoorSince('30m')).toEqual({ sinceMs: 1_800_000 });
    expect('error' in parseDoorSince('1')).toBe(true);
    expect('error' in parseDoorSince('0d')).toBe(true);
  });
});

describe('run-origin first row', () => {
  test('a direct say stamp is the first ledger row: harness-say, viaQueue false', () => {
    const dir = ledgerDir();
    const launch = resolveLaunchStamp({ entrance: 'cli-harness-say', seat: 'OP', env: {} });
    write(dir, 'run-direct-say', 'run-origin', { launch }, INSIDE);
    const first = firstRow(dir, 'run-direct-say');
    expect(first.event).toBe('run-origin');
    expect(first.data.launch).toEqual({ entrance: 'harness-say', actor: 'OP', viaQueue: false });
  });

  test('a queue tick stamp is the first ledger row: queue-tick, viaQueue true, queueId', () => {
    const dir = ledgerDir();
    const launch = resolveLaunchStamp({
      entrance: 'cli-harness-say',
      seat: 'TC',
      queueId: 'hq-33333333-3333-3333-3333-333333333333',
      env: {},
    });
    write(dir, 'run-queue-tick', 'run-origin', { launch }, INSIDE);
    const first = firstRow(dir, 'run-queue-tick');
    expect(first.event).toBe('run-origin');
    expect(first.data.launch).toEqual({
      entrance: 'queue-tick',
      actor: 'TC',
      viaQueue: true,
      queueId: 'hq-33333333-3333-3333-3333-333333333333',
    });
  });
});

