import { describe, expect, test } from 'bun:test';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFact, readFacts } from './ledger.js';
import { computeFedKpi, fedKpi, hqBlockLines, parseGitLandLog } from './kpi.js';
import { fedSeat, turnOpenerOf } from './turn-writer.js';

const at = (m: number) => new Date(Date.UTC(2026, 10, 25, 20, m)).toISOString();

describe('fed-state ledger + KPI', () => {
  test('synthetic hour → hand-computed KPIs', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fed-')), 'facts.jsonl');
    // hands: TC idle+work (still idle at end), UX idle+work then busy, MK idle no work, RES idle+work before window
    recordFact({ ts: '2026-11-25T19:50:00.000Z', type: 'hand', seat: 'RES', state: 'idle', workReady: true }, p);
    recordFact({ ts: at(5), type: 'hand', seat: 'TC', state: 'idle', workReady: true }, p);
    recordFact({ ts: at(10), type: 'hand', seat: 'UX', state: 'idle', workReady: true }, p);
    recordFact({ ts: at(20), type: 'hand', seat: 'UX', state: 'busy' }, p);
    recordFact({ ts: at(30), type: 'hand', seat: 'MK', state: 'idle', workReady: false }, p);
    for (const m of [1, 15, 40]) recordFact({ ts: at(m), type: 'land', ref: `${m}` }, p);
    recordFact({ ts: '2026-11-25T19:59:00.000Z', type: 'land', ref: 'old' }, p);
    for (const m of [2, 3, 4, 50]) recordFact({ ts: at(m), type: 'mail', state: 'post', from: 'TC', to: 'OP' }, p);
    recordFact({ ts: at(6), type: 'mail', state: 'post', from: 'OP', to: 'TC' }, p);
    recordFact({ ts: at(7), type: 'mail', state: 'ack', seat: 'OP' }, p);
    for (const [m, s] of [[8, 'mail'], [9, 'mail'], [11, 'other'], [12, 'mail']] as const) recordFact({ ts: at(m), type: 'turn', seat: 'OP', state: s }, p);
    recordFact({ ts: at(13), type: 'turn', seat: 'TC', state: 'mail' }, p);
    recordFact({ ts: at(14), type: 'work', seat: 'TC', state: 'claimed', cell: 'A1' }, p);
    recordFact({ ts: at(16), type: 'work', seat: 'UX', state: 'empty' }, p);
    recordFact({ ts: at(17), type: 'work', seat: 'TC', state: 'block', cell: 'A1' }, p);
    recordFact({ ts: at(18), type: 'steward', state: 'wake' }, p);
    recordFact({ ts: at(19), type: 'steward', state: 'reclaim', cell: 'B2' }, p);
    appendFileSync(p, 'not json\n');
    const k = fedKpi({ window: '1h', now: new Date(at(60)), path: p });
    expect(k.idleWithWorkSeats).toEqual(['RES', 'TC']);
    expect(k.idleWithWorkHands).toBe(2);
    expect(k.landed).toBe(3);
    expect(k.landedPerHour).toBe(3);
    expect(k.opInbound).toBe(4);
    expect(k.opInboundPerHour).toBe(4);
    expect(k.opTurns).toBe(4);
    expect(k.opTurnsByMail).toBe(3);
    expect(k.opTurnsByMailPct).toBe(75);
    expect(k.aux).toEqual({ workNext: 2, claims: 1, stewardWakes: 1, reclaims: 1, blocks: 1, greens: 0 });
    expect(readFacts({ path: p }).skipped).toBe(1);
  });

  test('30m window halves the denominator', () => {
    const k = computeFedKpi([{ ts: at(40), type: 'land' }, { ts: at(45), type: 'mail', state: 'post', to: 'OP' }], new Date(at(30)), new Date(at(60)));
    expect(k.landedPerHour).toBe(2);
    expect(k.opInboundPerHour).toBe(2);
    expect(k.opTurnsByMailPct).toBeNull();
  });

  test('writer is fail-open on an unwritable path', () => {
    expect(recordFact({ type: 'land' }, '/dev/null/x/facts.jsonl')).toBe(false);
  });
});

describe('fed-state TUI writers', () => {
  test('turn opener mapping', () => {
    expect(turnOpenerOf('human')).toBe('person');
    expect(turnOpenerOf('queue-user')).toBe('person');
    expect(turnOpenerOf('queue-notice', 'mail')).toBe('mail');
    expect(turnOpenerOf('queue-notice', 'wakeup')).toBe('wake');
    expect(turnOpenerOf('internal', 'scheduled')).toBe('wake');
    expect(turnOpenerOf('internal', 'self-pull')).toBe('internal');
  });
  test('OP-HELPERS-STABILIZE: the seat of an els pane comes from its seats/<SEAT> cwd (no ELANOUS_TRACK there)', () => {
    expect(fedSeat({ ELANOUS_ELS_WS: 'OP' }, '/Users/x/elanous-hq/seats/OP')).toBe('OP');
    expect(fedSeat({}, '/Users/x/elanous-hq/seats/tc-h-cx-1/sub')).toBe('TC-H-CX-1');
    expect(fedSeat({ ELANOUS_TRACK: 'jud' }, '/Users/x/elanous-hq/seats/OP')).toBe('JUD');
    // a workspace alone is not a seat (a hand pane in workspace TC is not TC) · a non-seat cwd writes nothing
    expect(fedSeat({ ELANOUS_ELS_WS: 'TC' }, '/Users/x/elanous-hq/repo.git/.claude/wt/a')).toBe(null);
    expect(fedSeat({}, '/tmp')).toBe(null);
  });
  test('idle hand without a flag counts until work next says empty', () => {
    const k = computeFedKpi([
      { ts: at(1), type: 'hand', seat: 'TC', state: 'idle' },
      { ts: at(2), type: 'hand', seat: 'UX', state: 'idle' },
      { ts: at(3), type: 'work', seat: 'UX', state: 'empty' },
      { ts: at(4), type: 'hand', seat: 'MK', state: 'idle', workReady: false },
      { ts: at(5), type: 'turn', seat: 'OP', state: 'mail' },
      { ts: at(6), type: 'turn', seat: 'OP', state: 'person' },
    ], new Date(at(0)), new Date(at(60)));
    expect(k.idleWithWorkSeats).toEqual(['TC']);
    expect(k.opTurnsByMailPct).toBe(50);
    expect(computeFedKpi([{ ts: at(1), type: 'land', ref: '7' }, { ts: at(2), type: 'land', ref: '7' }, { ts: at(3), type: 'land' }], new Date(at(0)), new Date(at(60))).landed).toBe(2);
  });
});

describe('steward HQ block digest', () => {
  test('blocks in the last 30 min become digest lines', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'fed-')), 'facts.jsonl');
    recordFact({ ts: at(10), type: 'work', state: 'block', seat: 'MK', cell: 'OLD', to: 'TC' }, p);
    recordFact({ ts: at(45), type: 'work', state: 'block', seat: 'MK', cell: 'DOCS-UMBRELLA-SYNC', to: 'TC', kind: 'review' }, p);
    expect(hqBlockLines(Date.parse(at(60)), p)).toEqual(['DOCS-UMBRELLA-SYNC → TC (MK) · review']);
  });
});

describe('fed-state land truth from main (OP 11-26 · KPI read 0/h while main took 13)', () => {
  test('first-parent «(#N)» subjects in window become land facts; others are skipped', () => {
    const log = [
      '2026-11-25T20:40:00Z\tfix(a): one (#40001)',
      '2026-11-25T20:50:00Z\tMerge branch x',
      '2026-11-25T20:10:00Z\tfix(b): before window (#40002)',
      '',
    ].join('\n');
    const f = parseGitLandLog(log, new Date('2026-11-25T20:30:00Z'), new Date('2026-11-25T21:00:00Z'));
    expect(f).toEqual([{ ts: '2026-11-25T20:40:00.000Z', type: 'land', ref: '40001', source: 'git:main' }]);
  });
  test('a pr-land fact and the git commit for the same PR count once', () => {
    const k = computeFedKpi([
      { ts: '2026-11-25T20:40:05Z', type: 'land', ref: '40001', source: 'pr-land' },
      { ts: '2026-11-25T20:40:00Z', type: 'land', ref: '40001', source: 'git:main' },
      { ts: '2026-11-25T20:45:00Z', type: 'land', ref: '40003', source: 'git:main' },
    ], new Date('2026-11-25T20:30:00Z'), new Date('2026-11-25T21:00:00Z'));
    expect(k.landed).toBe(2);
  });
});
