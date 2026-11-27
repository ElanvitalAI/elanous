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

  test('retired harness mission stamps remain readable in historical ledgers', () => {
    expect(doorFromEntrance('cli-harness-mission')).toBe('agent-mission');
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
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(table.rows.reduce((sum, row) => sum + row.runs, 0)).toBe(table.runs);
    const rendered = renderLaunchDoors(table);
    expect(rendered).toContain('unknown');
    expect(rendered).toContain('queue-tick');
    expect(rendered.split('\n')[1]).toBe('excluded graph-run=0 seat-turn=0');
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

describe('DOORS-NON-HARNESS-EXCLUDE', () => {
  const DAY = 24 * 60 * 60 * 1000;

  test('혼합 원장에서 graph-run과 seat-turn만 제외하고 스탬프 하니스는 유지한다', () => {
    const dir = ledgerDir();
    write(dir, 'graph-run-1', 'start', { graphId: 'natural-language-research', node: 'research' }, INSIDE);
    write(dir, 'graph-run-2', 'start', { graphId: 'landing-train' }, INSIDE);
    write(dir, 'seat-turn-1', 'child-first-llm-call', { status: 'started', at: INSIDE }, INSIDE);
    write(dir, 'harness-run-1', 'run-origin', { launch: { entrance: 'self-implement', actor: 'OP', viaQueue: false } }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(1);
    expect(table.unknown).toBe(0);
    expect(table.outsideQueue).toBe(1);
    expect(table.viaQueue).toBe(0);
    expect(table.excluded).toEqual({ graphRun: 2, seatTurn: 1 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['self-implement']);
    const rendered = renderLaunchDoors(table);
    expect(rendered.split('\n')[1]).toBe('excluded graph-run=2 seat-turn=1');
    expect(rendered).toContain('total               1');
  });

  test('첫 줄에 data.launch가 있으면 graphId가 함께 있어도 하니스 런으로 센다', () => {
    const dir = ledgerDir();
    write(dir, 'launch-with-graph', 'run-origin', {
      launch: { entrance: 'dev-ask', actor: 'MK', viaQueue: false },
      graphId: 'natural-language-research',
    }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(1);
    expect(table.unknown).toBe(0);
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['dev-ask']);
  });

  test('launch: "legacy" 문자열과 graphId가 함께 있어도 하니스 런으로 센다', () => {
    const dir = ledgerDir();
    write(dir, 'launch-legacy-string', 'run-origin', { launch: 'legacy', graphId: 'natural-language-research' }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(1);
    expect(table.unknown).toBe(1);
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['unknown']);
  });

  test('launch: null 값도 속성이 있으면 graphId보다 우선해 하니스 런으로 센다', () => {
    const dir = ledgerDir();
    write(dir, 'launch-null-with-graph', 'run-origin', { launch: null, graphId: 'natural-language-research' }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(1);
    expect(table.unknown).toBe(1);
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['unknown']);
  });

  test('launch: null 값이 child-first 이벤트와 함께 있어도 하니스 런으로 센다', () => {
    const dir = ledgerDir();
    write(dir, 'launch-null-with-child-first', 'child-first-llm-call', { launch: null, status: 'started' }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(1);
    expect(table.unknown).toBe(1);
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['unknown']);
  });

  test('첫 줄에 data.launch가 있으면 child-first 이벤트와 함께 있어도 하니스 런으로 센다', () => {
    const dir = ledgerDir();
    write(dir, 'launch-with-child-first', 'child-first-llm-call', {
      launch: { entrance: 'harness-say', actor: 'OP', viaQueue: false },
      status: 'started',
    }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(1);
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['harness-say']);
  });

  test('graphId: null 값도 속성이 있으면 graph-run으로 제외한다', () => {
    const dir = ledgerDir();
    write(dir, 'graph-id-null', 'start', { graphId: null }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(0);
    expect(table.unknown).toBe(0);
    expect(table.excluded).toEqual({ graphRun: 1, seatTurn: 0 });
    expect(table.rows).toEqual([]);
  });

  test('graphId: null이 child-first 이벤트와 함께 있어도 graph-run으로 제외한다', () => {
    const dir = ledgerDir();
    write(dir, 'graph-id-null-child-first', 'child-first-llm-call', { graphId: null, status: 'started' }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(0);
    expect(table.excluded).toEqual({ graphRun: 1, seatTurn: 0 });
    expect(renderLaunchDoors(table).split('\n')[1]).toBe('excluded graph-run=1 seat-turn=0');
  });

  test('창 밖 graph-run 원장은 하니스 집계와 제외 집계 어디에도 들어가지 않는다', () => {
    const dir = ledgerDir();
    write(dir, 'graph-run-stale', 'start', { graphId: 'natural-language-research' }, '2026-10-01T00:00:00.000Z');
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: DAY });
    expect(table.runs).toBe(0);
    expect(table.excluded).toEqual({ graphRun: 0, seatTurn: 0 });
    expect(renderLaunchDoors(table)).toContain('(no runs)');
  });

  test('real harness ledger order: authoring rows (graph.unit self-implement · child-first) before run-origin still count as the stamped harness run', () => {
    const dir = ledgerDir();
    // 11-27 node-c run-3c6a0c36: rows 1-9 = graph.unit {graphId:"self-implement"} and child-first-llm-call, row 10 = run-origin with the stamp.
    write(dir, 'run-harness-real', 'graph.unit', { graphId: 'self-implement', nodeId: 'author', phase: 'enter' }, INSIDE);
    write(dir, 'run-harness-real', 'child-first-llm-call', { status: 'started' }, INSIDE);
    write(dir, 'run-harness-real', 'run-origin', { hostId: 'h', launch: { entrance: 'harness-ask', actor: 'OP', viaQueue: false } }, INSIDE);
    write(dir, 'graph-run-real', 'start', { graphId: 'natural-language-research' }, INSIDE);
    const table = queryLaunchDoors({ dir, now: NOW, sinceMs: 24 * 60 * 60 * 1000 });
    expect(table.runs).toBe(1);
    expect(table.unknown).toBe(0);
    expect(table.excluded).toEqual({ graphRun: 1, seatTurn: 0 });
    expect(table.rows.map((row) => row.entrance)).toEqual(['harness-ask']);
  });
});
