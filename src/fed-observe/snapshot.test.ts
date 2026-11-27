import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockedOn, buildFedSnapshot, formatAnomalies, formatSnapshot, type FedSources } from './snapshot.js';
import { latestAnomalyBlock, readLatestSnapshot, runFedSnapshotCli, saveSnapshot } from './fed-observe-cli.js';
import { readFedAnomalyDigest } from '../op-control/pulse-digest.js';

const NOW = new Date('2026-11-26T14:30:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function quiet(over: Partial<FedSources> = {}): FedSources {
  return {
    now: NOW, installedSha: 'abc1234def', panes: [], pool: [], turns: [], errors: [], queues: [], mail: [], hands: [], blocks: [],
    landingFreeze: null, landHolds: [], commitments: { seat: 'OP', open: 2, overdue: 0, action: 0 },
    land: { lastAt: ago(5), landedToday: 3, pending: 1, mode: 'live' }, judge: { queue: 1, medianWaitMin: 4 },
    loops: { windowMin: 60, ok: 10, goalNotMet: 0, failed: 0, stale: 0, running: 0, failing: [] },
    release: { version: '0.3.37', green: 3, yellow: 5, total: 8 }, kpi: { landedPerHour: 4, opInboundPerHour: 9, idleWithWork: [] }, unmeasured: [],
    ...over,
  };
}

describe('fed snapshot (pure)', () => {
  test('a quiet federation has no anomalies and prints «anomalies: none»', () => {
    const s = buildFedSnapshot(quiet({ panes: [{ seat: 'OP', coordinator: true, status: { state: 'IDLE' }, build: { sha: 'abc', desired: 'abc' }, unreadMail: { count: 0 } }] }));
    expect(s.anomalies).toEqual([]);
    expect(formatSnapshot(s)).toContain('anomalies: none');
    expect(formatAnomalies(s)).toBe('');
  });

  test('pane unread counter wins over the msg store; no-pane hands are hidden unless --all', () => {
    const s = buildFedSnapshot(quiet({
      panes: [{ seat: 'OP', coordinator: true, status: { state: 'IDLE' }, unreadMail: { count: 2, oldestCreatedAt: ago(3) } }],
      mail: [{ seat: 'OP', unacked: 40, oldestAt: ago(20_000) }, { seat: 'GONE', unacked: 1, oldestAt: ago(1) }],
      pool: [{ seat: 'GONE', home: 'TC', state: 'no-pane' }],
    }));
    const op = s.seats.find(r => r.seat === 'OP')!;
    expect(op.mail).toEqual({ unacked: 2, oldestAgeMin: 3 });
    expect(formatSnapshot(s)).not.toContain('GONE ');
    expect(formatSnapshot(s)).toContain('1 declared hands without a pane hidden');
    expect(formatSnapshot(s, { all: true })).toContain('GONE ');
  });

  test('stale build = running sha differs from the desired sha', () => {
    const s = buildFedSnapshot(quiet({ panes: [{ seat: 'TC', coordinator: true, status: { state: 'IDLE' }, build: { sha: '1111111aaa', desired: '2222222bbb', age: 'older' } }] }));
    expect(s.anomalies.map(a => a.rule)).toEqual(['stale-build']);
    expect(s.anomalies[0]!.why).toBe('TC runs build 1111111aaa, desired 2222222bbb (older)');
  });

  test('blocks group by the awaited seat; HOLD words mark a hold; old blocks do not count', () => {
    const groups = blockedOn([
      { by: 'H1', on: 'TC', cell: 'A', reason: '시험 HOLD 유지', at: ago(5) },
      { by: 'H2', on: 'TC', cell: 'B', reason: 'waiting', at: ago(10) },
      { by: 'H3', on: 'JUD', cell: 'C', reason: 'verdict', at: ago(2) },
      { by: 'H4', on: 'TC', cell: 'D', reason: 'HOLD', at: ago(300) },
    ], NOW);
    expect(groups).toEqual([
      { on: 'TC', hands: ['H1', 'H2'], hold: true, sample: 'A: 시험 HOLD 유지' },
      { on: 'JUD', hands: ['H3'], hold: false, sample: 'C: verdict' },
    ]);
  });

  test('a running last turn of a coordinator is not an anomaly; failed and no-op are', () => {
    const panes = ['OP', 'TC', 'UX'].map(seat => ({ seat, coordinator: true, status: { state: 'WORKING' } }));
    const s = buildFedSnapshot(quiet({ panes, turns: [
      { seat: 'OP', at: ago(1), outcome: 'running' }, { seat: 'TC', at: ago(2), outcome: 'failed', why: 'no reply' }, { seat: 'UX', at: ago(3), outcome: 'no-op', why: 'ended on «HH:MM에 확인» with no action' },
    ] }));
    expect(s.anomalies.map(a => `${a.rule}:${a.seat}`)).toEqual(['last-turn-failed:TC', 'last-turn-no-op:UX']);
  });

  test('anomaly block is capped (≤1500 chars) and says how many were cut', () => {
    const hands = Array.from({ length: 80 }, (_, i) => ({ id: 1000 + i, from: `H${i}`, to: 'TC', blockedSeat: `H${i}`, reason: 'x'.repeat(60), waitedMs: 5 * 3_600_000 }));
    const s = buildFedSnapshot(quiet({ hands }));
    const block = formatAnomalies(s);
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toMatch(/… \d+ more — eln fed snapshot --anomalies$/);
    expect(block.startsWith('[fed snapshot ')).toBe(true);
  });

  test('null sources print «?» and are not read as zero', () => {
    const s = buildFedSnapshot(quiet({ pool: null, errors: null, queues: null, hands: null, blocks: null, land: null, judge: null, loops: null, kpi: null, commitments: null, unmeasured: ['logs(boom)'] }));
    const text = formatSnapshot(s);
    expect(text).toContain('hands ?');
    expect(text).toContain('✋ open ?');
    expect(text).toContain('unmeasured: logs(boom)');
    expect(text).toContain('idle-with-work ? (pane idle · work ready · = fed kpi)');
    expect(s.anomalies).toEqual([]);
  });

  // OP-OBSERVE-LANDED neighbour (11-27 22:39): «hands idle 0» next to `fed kpi` «idle-with-work 11» — two measures, both named.
  test('head line names the pool count (free · no cell) and the KPI idle-with-work count side by side', () => {
    const s = buildFedSnapshot(quiet({
      panes: [{ seat: 'H-1', status: { state: 'IDLE' } }, { seat: 'H-2', status: { state: 'IDLE' } }],
      pool: [{ seat: 'H-1', home: 'TC', state: 'idle' }, { seat: 'H-2', home: 'TC', state: 'working', cell: 'CELL-A' }],
      kpi: { landedPerHour: 4, opInboundPerHour: 9, idleWithWork: ['H-1', 'H-2'] },
    }));
    const head = formatSnapshot(s).split('\n')[0]!;
    expect(head).toContain('· hands free 1 (no cell) · holding 0 · working 1 (cell or busy) · no-pane 0');
    expect(head).toContain('· idle-with-work 2 (pane idle · work ready · = fed kpi)');
    expect(head).not.toContain('hands idle');
  });
});

describe('fed snapshot CLI · saving · pulse digest', () => {
  test('save rotates to the newest N and writes latest.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-snap-'));
    for (let i = 0; i < 5; i++) expect(saveSnapshot(buildFedSnapshot(quiet({ now: new Date(NOW.getTime() + i * 60_000) })), dir, 3)).toBe(true);
    expect(readdirSync(dir).filter(f => f.startsWith('snap-')).length).toBe(3);
    expect(readLatestSnapshot(dir)!.at).toBe('2026-11-26T14:34:00.000Z');
  });

  test('--anomalies prints only the block; the snapshot is saved through the seam', async () => {
    const lines: string[] = []; let saved = 0;
    const code = await runFedSnapshotCli({ anomalies: true }, {
      now: () => NOW, out: l => lines.push(l), save: () => { saved++; return true; },
      collect: async () => ({ sources: quiet({ landingFreeze: { reason: 'cut 0.3.37', by: 'REL', until: null } }) }),
    });
    expect(code).toBe(0); expect(saved).toBe(1);
    expect(lines).toEqual(['[fed snapshot ' + NOW.toTimeString().slice(0, 5) + ' · 1 anomalies (1 red)]\n✘ [landing-freeze] landing frozen by REL: cut 0.3.37']);
  });

  test('latestAnomalyBlock: fresh → text · old → stale with no text · missing → stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fed-latest-'));
    expect(latestAnomalyBlock({ dir, now: NOW.getTime() })).toEqual({ text: null, stale: true });
    saveSnapshot(buildFedSnapshot(quiet({ landingFreeze: { reason: 'r', by: 'OP', until: null } })), dir);
    expect(latestAnomalyBlock({ dir, now: NOW.getTime() + 60_000 }).text).toContain('[landing-freeze]');
    expect(latestAnomalyBlock({ dir, now: NOW.getTime() + 60_000 }).stale).toBe(false);
    expect(latestAnomalyBlock({ dir, now: NOW.getTime() + 30 * 60_000 })).toEqual({ text: null, stale: true });
  });

  test('pulse digest: stale snapshot asks for one refresh; text is capped at 1500', () => {
    let refreshed = 0;
    expect(readFedAnomalyDigest({ latest: () => ({ text: null, stale: true }), refresh: () => { refreshed++; } })).toBeNull();
    expect(refreshed).toBe(1);
    const long = readFedAnomalyDigest({ latest: () => ({ text: 'y'.repeat(4000), stale: false }), refresh: () => { refreshed++; } })!;
    expect(long.length).toBe(1500); expect(refreshed).toBe(1);
    expect(readFedAnomalyDigest({ latest: () => { throw new Error('x'); } })).toBeNull();
  });
});

describe('Terra r1 must-fix regressions (snapshot)', () => {
  test('#2 a failed save is reported on stderr (also with --quiet) and as saved:false in --json', async () => {
    const out: string[] = []; const err: string[] = [];
    const deps = { now: () => NOW, out: (l: string) => out.push(l), err: (l: string) => err.push(l), save: () => false, collect: async () => ({ sources: quiet() }) };
    expect(await runFedSnapshotCli({ quiet: true }, deps)).toBe(0);
    expect(err.length).toBe(1);
    expect(err[0]).toMatch(/^fed snapshot: not saved to .*snapshots \(write failed\)/);
    expect(out).toEqual([]);
    await runFedSnapshotCli({ json: true }, deps);
    expect((JSON.parse(out[0]!) as { saved: boolean }).saved).toBe(false);
    expect(err.length).toBe(2);
    await runFedSnapshotCli({ json: true, save: false }, deps);
    expect(err.length).toBe(2);
  });
});
