import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogStore } from '../mss/logging/log-store.js';
import { measureParentSpeedClaims, measureSpeedClaims, renderSpeedClaims, type ParentSpeedClaimsEvent } from './speed-claims.js';

const id = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;
const stamp = (minute: number) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + minute * 60_000).toISOString();

function writeRun(dir: string, suffix: string, events: readonly { minute?: number; event: string; data?: Record<string, unknown> }[], seat?: string): void {
  const runId = id(suffix);
  writeFileSync(join(dir, 'run-ledger', `${runId}.jsonl`), events.map(({ minute, event, data }) => JSON.stringify({
    runId, event, ...(minute === undefined ? {} : { timestamp: stamp(minute) }), data: data ?? {},
  })).join('\n') + '\n');
  if (seat) {
    mkdirSync(join(dir, 'self-dev-runs'), { recursive: true });
    writeFileSync(join(dir, 'self-dev-runs', `${runId}.json`), JSON.stringify({ runId, seat }));
  }
}

function invoke(dir: string, json = false) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/elanous.mjs', import.meta.url)), `--test=${dir}`, 'self', 'speed-claims', ...(json ? ['--json'] : [])], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELANOUS_STATE_DIR: dir },
  });
}

describe('SPEED-CLAIMS launch-to-end census', () => {
  it('measures parent starts to done from logs, joining seats only by parent runId', () => {
    const parent = (suffix: string, minute: number, event: string, data: Record<string, unknown> = {}): ParentSpeedClaimsEvent => ({
      ts: stamp(minute), category: 'self-dev.orchestrate', event, data: { runId: id(suffix), ...data },
    });
    const events = [
      parent('0001', 0, 'start'),
      parent('0002', 5, 'start'),
      parent('0003', 12, 'start'),
      parent('0001', 33, 'done', { total: 1, completed: 1, failed: 0, landed: 1, outcomes: [{ taskId: 'task:afd73d0b111a', status: 'done', stage: 'merged', merged: true, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/23995' }] }),
      parent('0002', 6, 'done', { total: 1, completed: 0, failed: 1, landed: 0, outcomes: [{ taskId: 'task:failed', status: 'failed', stage: 'failed', merged: false }] }),
      { ...parent('0004', 7, 'done', { outcomes: [{ stage: 'merged', merged: true }] }), category: 'other.category' },
    ];
    const queue = [{ runId: id('0001'), seat: 'MK', kind: 'ask' }, { runId: id('0003'), seat: 'UX' }];
    const measured = measureParentSpeedClaims(events, queue);
    expect(measureParentSpeedClaims(events, [{ runId: id('0001'), seat: 'MK' }, { runId: id('0001'), seat: 'TC' }]).rows.find((row) => row.stage === 'merged')?.seat).toBe('unknown');
    expect(measured).toMatchObject({ scope: 'self-dev.orchestrate-parent-logs', status: 'measured', completedCount: 2, inProgressCount: 1, cannotMeasureCount: 0 });
    expect(measured.rows).toEqual([
      { seat: 'MK', stage: 'merged', merged: true, count: 1, medianMinutes: 33, q1Minutes: 33, q3Minutes: 33 },
      { seat: 'direct', stage: 'failed', merged: false, count: 1, medianMinutes: 1, q1Minutes: 1, q3Minutes: 1 },
    ]);
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-parent-'));
    try {
      mkdirSync(join(state, 'run-ledger'));
      const combined = measureSpeedClaims({ dir: join(state, 'run-ledger'), readParentEvents: () => events, readParentQueue: () => queue });
      expect(combined.parent).toEqual(measured);
      expect(combined.completedCount).toBe(0);
      expect(renderSpeedClaims(combined)).toContain('seat=MK stage=merged merged=true count=1 median=33m');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('uses the earliest start and latest done even when logs are newest-first and retries recur', () => {
    const runId = id('0040');
    const events: ParentSpeedClaimsEvent[] = [
      { ts: stamp(33), category: 'self-dev.orchestrate', event: 'done', data: { runId, outcomes: [{ stage: 'merged', merged: true }] } },
      { ts: stamp(20), category: 'self-dev.orchestrate', event: 'start', data: { runId } },
      { ts: 'invalid', category: 'self-dev.orchestrate', event: 'start', data: { runId } },
      { ts: stamp(0), category: 'self-dev.orchestrate', event: 'start', data: { runId } },
      { ts: stamp(12), category: 'self-dev.orchestrate', event: 'done', data: { runId, outcomes: [{ stage: 'failed', merged: false }] } },
      { ts: 'invalid', category: 'self-dev.orchestrate', event: 'done', data: { runId, outcomes: [{ stage: 'failed', merged: false }] } },
    ];
    expect(measureParentSpeedClaims(events, [])).toMatchObject({ completedCount: 1, rows: [{ seat: 'direct', stage: 'merged', medianMinutes: 33 }] });
    expect(measureParentSpeedClaims([events[5]!, events[4]!, events[2]!, events[0]!, events[3]!, events[1]!], [])).toMatchObject({ completedCount: 1, rows: [{ stage: 'merged', medianMinutes: 33 }] });
  });

  it('marks an unmatched run direct only when the queue is readable, never when the queue read fails', () => {
    const runId = id('0041');
    const events: ParentSpeedClaimsEvent[] = [
      { ts: stamp(0), category: 'self-dev.orchestrate', event: 'start', data: { runId } },
      { ts: stamp(33), category: 'self-dev.orchestrate', event: 'done', data: { runId, outcomes: [{ stage: 'merged', merged: true }] } },
    ];
    expect(measureParentSpeedClaims(events).rows[0]?.seat).toBe('unknown');
    expect(measureParentSpeedClaims(events, []).rows[0]?.seat).toBe('direct');
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-parent-queue-'));
    try {
      mkdirSync(join(state, 'run-ledger'));
      const result = measureSpeedClaims({ dir: join(state, 'run-ledger'), readParentEvents: () => events, readParentQueue: () => { throw new Error('unreadable'); } });
      expect(result.parent.rows[0]?.seat).toBe('unknown');
      expect(renderSpeedClaims(result)).toContain('seat=unknown stage=merged');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('reads seeded parent logs and queue through self speed-claims from outside the repository', () => {
    const external = mkdtempSync(join(tmpdir(), 'speed-claims-external-cwd-'));
    const home = join(external, 'home');
    const prod = join(home, '.elanous');
    const state = join(external, 'test-state');
    const runId = id('0080');
    const store = new LogStore(join(prod, 'logs', 'logs.db'), { instance: 'prod' });
    try {
      mkdirSync(join(state, 'run-ledger'), { recursive: true });
      mkdirSync(join(prod, 'harness'), { recursive: true });
      writeFileSync(join(prod, 'harness', 'queue.json'), JSON.stringify([{ runId, seat: 'MK', kind: 'ask' }]));
      store.insertBatch([
        { rec: { ts: stamp(0), category: 'self-dev.orchestrate', event: 'start', data: { runId } }, surface: 'tui' },
        { rec: { ts: stamp(33), category: 'self-dev.orchestrate', event: 'done', data: { runId, total: 1, completed: 1, failed: 0, landed: 1, outcomes: [{ taskId: 'task:afd73d0b111a', status: 'done', stage: 'merged', merged: true, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/23995' }] } }, surface: 'tui' },
      ]);
      store.close();
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/elanous.mjs', import.meta.url)), `--test=${state}`, 'self', 'speed-claims', '--json'], {
        cwd: external, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, NODE_ENV: '' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).parent).toMatchObject({
        scope: 'self-dev.orchestrate-parent-logs', status: 'measured', completedCount: 1,
        rows: [{ seat: 'MK', stage: 'merged', merged: true, count: 1, medianMinutes: 33 }],
      });
    } finally {
      store.close();
      rmSync(external, { recursive: true, force: true });
    }
  }, 70_000);

  it('counts three merges, one failure and one in-progress separately, with seat-specific interpolated quartiles', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-'));
    try {
      mkdirSync(join(state, 'run-ledger'));
      mkdirSync(join(state, 'self-dev-runs'));
      for (const [suffix, duration] of [['0001', 10], ['0002', 30], ['0003', 50]] as const) {
        writeRun(state, suffix, [
          { minute: 0, event: 'start' },
          { minute: duration, event: 'merged', data: { number: Number(suffix), merged: true } },
          ...(suffix === '0003' ? [{ minute: duration + 1, event: 'run-status', data: { runStatus: 'failed', stage: 'gate-failed' } }] : []),
          { minute: duration + 2, event: 'run-status', data: { runStatus: 'completed', stage: 'merged' } },
          ...(suffix === '0002' ? [{ minute: duration + 3, event: 'run-status', data: { runStatus: 'failed', stage: 'gate-failed' } }] : []),
        ], 'OP');
      }
      writeRun(state, '0004', [{ minute: 0, event: 'start' }, { minute: 20, event: 'run-status', data: { runStatus: 'failed', stage: 'gate-failed' } }], 'TC');
      writeRun(state, '0005', [{ minute: 0, event: 'start' }, { minute: 100, event: 'reviewed' }], 'OP');
      const recordedLedger = join(state, 'run-ledger', `${id('0001')}.jsonl`);
      const before = readFileSync(recordedLedger, 'utf8');
      const result = measureSpeedClaims({ dir: join(state, 'run-ledger') });
      expect(result).toMatchObject({ status: 'measured', completedCount: 4, inProgressCount: 1, cannotMeasureCount: 0 });
      expect(result.rows).toEqual([
        { seat: 'OP', outcome: 'merged', count: 3, underOneMinuteCount: 0, medianMinutes: 30, q1Minutes: 20, q3Minutes: 40 },
        { seat: 'TC', outcome: 'failed', count: 1, underOneMinuteCount: 0, medianMinutes: 20, q1Minutes: 20, q3Minutes: 20 },
      ]);
      const json = invoke(state, true);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ completedCount: 4, inProgressCount: 1, rows: result.rows });
      const text = invoke(state);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain('in progress (excluded): 1');
      expect(text.stdout).toContain('seat=OP outcome=merged count=3 underOneMinute=0 median=30m q1=20m q3=40m');
      expect(readFileSync(recordedLedger, 'utf8')).toBe(before);
    } finally { rmSync(state, { recursive: true, force: true }); }
  }, 70_000);

  it('separates abandonment, failure, non-merge completion, and malformed or missing timestamps from the denominator', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-outcomes-'));
    try {
      const dir = join(state, 'run-ledger');
      mkdirSync(dir);
      writeRun(state, '0010', [{ minute: 0, event: 'start' }, { minute: 9, event: 'run-status', data: { runStatus: 'failed', stage: 'aborted' } }]);
      writeRun(state, '0011', [{ minute: 0, event: 'start' }, { minute: 11, event: 'human-stop' }]);
      writeRun(state, '0012', [{ minute: 0, event: 'start' }, { minute: 12, event: 'run-status', data: { runStatus: 'completed', stage: 'pr-opened' } }]);
      writeRun(state, '0013', [{ minute: 0, event: 'start' }, { minute: 13, event: 'merged', data: { merged: false } }, { minute: 14, event: 'run-status', data: { runStatus: 'failed' } }]);
      writeRun(state, '0014', [{ event: 'start' }, { minute: 15, event: 'run-status', data: { runStatus: 'failed' } }]);
      writeRun(state, '0015', [{ minute: 0, event: 'start' }, { event: 'run-status', data: { runStatus: 'failed' } }]);
      writeRun(state, '0016', [{ minute: 10, event: 'start' }, { minute: 1, event: 'run-status', data: { runStatus: 'failed' } }]);
      writeFileSync(join(dir, `${id('0017')}.jsonl`), '{broken}\n');
      writeRun(state, '0018', [{ minute: 0, event: 'start' }, { minute: 15, event: 'merged', data: { merged: true } }, { minute: 20, event: 'start' }]);
      writeRun(state, '0019', [{ minute: 0, event: 'start' }, { minute: 4, event: 'run-status', data: { runStatus: 'parked', stage: 'parked' } }]);
      writeRun(state, '0022', [{ minute: 0, event: 'start' }, { minute: 3, event: 'run-status', data: { runStatus: 'failed' } }, { minute: 4, event: 'run-status', data: { runStatus: 'parked' } }]);
      const result = measureSpeedClaims({ dir });
      expect(result).toMatchObject({ status: 'cannot-measure', completedCount: 4, inProgressCount: 3, cannotMeasureCount: 4 });
      expect(result.rows).toEqual([
        { seat: 'unknown', outcome: 'abandoned', count: 2, underOneMinuteCount: 0, medianMinutes: 10, q1Minutes: 9.5, q3Minutes: 10.5 },
        { seat: 'unknown', outcome: 'completed-without-merge', count: 1, underOneMinuteCount: 0, medianMinutes: 12, q1Minutes: 12, q3Minutes: 12 },
        { seat: 'unknown', outcome: 'failed', count: 1, underOneMinuteCount: 0, medianMinutes: 14, q1Minutes: 14, q3Minutes: 14 },
      ]);
      expect(renderSpeedClaims(result)).toContain('cannot measure (excluded): 4');
      expect(readFileSync(join(dir, `${id('0010')}.jsonl`), 'utf8')).toContain('aborted');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('measures the final merge from the first launch across retries and resumes, excluding parked status', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-restart-'));
    try {
      const dir = join(state, 'run-ledger');
      mkdirSync(dir);
      writeRun(state, '0020', [
        { minute: 0, event: 'start' },
        { minute: 10, event: 'run-status', data: { runStatus: 'failed', stage: 'gate-failed' } },
        { minute: 100, event: 'start' },
        { minute: 107, event: 'run-status', data: { runStatus: 'parked', stage: 'parked' } },
        { minute: 120, event: 'start' },
        { minute: 130, event: 'merged', data: { merged: true } },
      ]);
      writeRun(state, '0021', [
        { minute: 0, event: 'start' },
        { minute: 5, event: 'run-status', data: { runStatus: 'cancelled', stage: 'soft-stopped' } },
      ]);
      expect(measureSpeedClaims({ dir })).toMatchObject({
        status: 'measured', completedCount: 2, inProgressCount: 0, cannotMeasureCount: 0,
        rows: [
          { seat: 'unknown', outcome: 'abandoned', count: 1, underOneMinuteCount: 0, medianMinutes: 5, q1Minutes: 5, q3Minutes: 5 },
          { seat: 'unknown', outcome: 'merged', count: 1, underOneMinuteCount: 0, medianMinutes: 130, q1Minutes: 130, q3Minutes: 130 },
        ],
      });
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('attributes checkpoint-less runs to a matching launch queue seat or the launch tree seat', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-seats-'));
    try {
      const dir = join(state, 'run-ledger');
      mkdirSync(dir);
      mkdirSync(join(state, 'harness'));
      const goalFile = join(state, 'goal.txt');
      writeFileSync(join(state, 'harness', 'queue.json'), JSON.stringify([
        { kind: 'ask', input: goalFile, seat: 'MK', status: 'launched' },
        { kind: 'ask', input: join(state, 'other.txt'), seat: 'TC', status: 'queued' },
      ]));
      writeRun(state, '0032', [
        { minute: 0, event: 'start', data: { goalFile } },
        { minute: 5, event: 'merged', data: { merged: true } },
      ]);
      const tree = join(state, 'launch-tree');
      mkdirSync(join(tree, '.claude'), { recursive: true });
      writeFileSync(join(tree, '.claude', 'seat'), 'UX');
      writeRun(state, '0033', [
        { minute: 0, event: 'start', data: { targetRoot: tree } },
        { minute: 4, event: 'run-status', data: { runStatus: 'failed' } },
      ]);
      const result = measureSpeedClaims({ dir });
      expect(result).toMatchObject({ unknownSeatCount: 0, completedCount: 2 });
      expect(result.rows).toEqual([
        { seat: 'MK', outcome: 'merged', count: 1, underOneMinuteCount: 0, medianMinutes: 5, q1Minutes: 5, q3Minutes: 5 },
        { seat: 'UX', outcome: 'failed', count: 1, underOneMinuteCount: 0, medianMinutes: 4, q1Minutes: 4, q3Minutes: 4 },
      ]);
      writeFileSync(join(state, 'harness', 'queue.json'), JSON.stringify([
        { kind: 'ask', input: goalFile, seat: 'MK', status: 'launched' },
        { kind: 'ask', input: goalFile, seat: 'TC', status: 'launched' },
      ]));
      const ambiguous = measureSpeedClaims({ dir });
      expect(ambiguous.unknownSeatCount).toBe(1);
      expect(ambiguous.rows.find((row) => row.outcome === 'merged')?.seat).toBe('unknown');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('uses checkpoint creation when the first ledger event has no timestamp and counts a 30-second abandonment', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-creation-'));
    try {
      const dir = join(state, 'run-ledger');
      mkdirSync(dir);
      writeRun(state, '0030', [
        { event: 'start' }, { minute: 0, event: 'start' },
        { minute: 1, event: 'merged', data: { merged: true } },
      ]);
      mkdirSync(join(state, 'self-dev-runs'));
      writeFileSync(join(state, 'self-dev-runs', `${id('0030')}.json`), JSON.stringify({ runId: id('0030'), createdAt: Date.parse(stamp(-10)) }));
      writeRun(state, '0031', [{ minute: 0, event: 'start' }, { minute: 0.5, event: 'run-status', data: { runStatus: 'failed', stage: 'aborted' } }]);
      writeFileSync(join(state, 'self-dev-runs', `${id('0031')}.json`), JSON.stringify({ runId: id('0031'), createdAt: Date.parse(stamp(-2)) }));
      const result = measureSpeedClaims({ dir });
      expect(result).toMatchObject({ completedCount: 2, unknownSeatCount: 2, cannotMeasureCount: 0 });
      expect(result.rows).toEqual([
        { seat: 'unknown', outcome: 'abandoned', count: 1, underOneMinuteCount: 1, medianMinutes: 0.5, q1Minutes: 0.5, q3Minutes: 0.5 },
        { seat: 'unknown', outcome: 'merged', count: 1, underOneMinuteCount: 0, medianMinutes: 11, q1Minutes: 11, q3Minutes: 11 },
      ]);
      expect(renderSpeedClaims(result)).toContain('unknown seat (finished): 2');
      expect(renderSpeedClaims(result)).toContain('outcome=abandoned count=1 underOneMinute=1');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('excludes calendar-invalid start and end timestamps as cannot-measure without losing a valid leap day', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-calendar-'));
    try {
      const dir = join(state, 'run-ledger');
      mkdirSync(dir);
      for (const suffix of ['0023', '0024', '0025']) {
        writeRun(state, suffix, [{ minute: 0, event: 'start' }, { minute: 30, event: 'merged', data: { merged: true } }]);
      }
      const replaceTimestamp = (suffix: string, original: string, replacement: string) => {
        const path = join(dir, `${id(suffix)}.jsonl`);
        writeFileSync(path, readFileSync(path, 'utf8').replace(original, replacement));
      };
      replaceTimestamp('0023', stamp(0), '2026-02-30T00:00:00.000Z');
      replaceTimestamp('0024', stamp(0), '2026-02-28T00:00:00.000Z');
      replaceTimestamp('0024', stamp(30), '2026-02-30T00:30:00.000Z');
      replaceTimestamp('0025', stamp(0), '2024-02-29T00:00:00.000Z');
      replaceTimestamp('0025', stamp(30), '2024-02-29T00:30:00.000Z');
      const result = measureSpeedClaims({ dir });
      expect(result).toMatchObject({ status: 'cannot-measure', completedCount: 1, inProgressCount: 0, cannotMeasureCount: 2 });
      expect(result.rows).toEqual([
        { seat: 'unknown', outcome: 'merged', count: 1, underOneMinuteCount: 0, medianMinutes: 30, q1Minutes: 30, q3Minutes: 30 },
      ]);
      expect(renderSpeedClaims(result)).toContain('cannot measure (excluded): 2');
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it('marks a missing or unreadable ledger directory cannot-measure rather than treating it as zero runs', () => {
    const state = mkdtempSync(join(tmpdir(), 'speed-claims-missing-'));
    try {
      expect(measureSpeedClaims({ dir: join(state, 'absent') })).toMatchObject({ status: 'cannot-measure', rows: [], completedCount: 0 });
      const empty = join(state, 'empty');
      mkdirSync(empty);
      expect(measureSpeedClaims({ dir: empty })).toMatchObject({ status: 'measured', completedCount: 0 });
      expect(measureSpeedClaims({ dir: empty, list: () => { throw new Error('unreadable'); } }).status).toBe('cannot-measure');
      const cli = invoke(state);
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toContain('status: cannot-measure');
    } finally { rmSync(state, { recursive: true, force: true }); }
  }, 70_000);
});
