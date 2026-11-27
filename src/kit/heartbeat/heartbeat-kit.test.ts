// kit/heartbeat — one truth (beats.jsonl) · loop_signals as a read-only mirror · one SLA staleness rule.
// Expected values are literals or come from the small oracle below (multipliers written out, not imported from the product).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../../msg/msg-store.js';
import { beat, emitSignal, extendSignalLease, judgeWatchers, lastBeat, readBeats, staleness, type Beat } from './index.js';

const T0 = Date.parse('2026-11-27T03:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const root = () => mkdtempSync(join(tmpdir(), 'kit-heartbeat-'));
const mirrorRow = (r: string, id: string) => {
  const store = openMsgStore(join(r, 'msg', 'messages.db'));
  try { return store.db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?').get(id); } finally { store.close(); }
};

describe('beat · lastBeat', () => {
  test('beat(id) appends one line under {root}/watchers/beats.jsonl and lastBeat reads it back', () => {
    const r = root();
    beat('judge-butler', { root: r, everyMin: 10, saw: 3, last: 'c-7', now: at(0) });
    const lines = readFileSync(join(r, 'watchers', 'beats.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ name: 'judge-butler', at: '2026-11-27T03:00:00.000Z', saw: 3, everyMin: 10, last: 'c-7' });
    expect(lastBeat('judge-butler', { root: r })?.at).toBe('2026-11-27T03:00:00.000Z');
    expect(lastBeat('nobody', { root: r })).toBeNull();
  });
  test('lastBeat picks the latest by event time, not by line order', () => {
    const r = root();
    beat('res-patrol', { root: r, everyMin: 5, now: at(9) });
    beat('res-patrol', { root: r, everyMin: 5, now: at(2) });
    expect(lastBeat('res-patrol', { root: r })?.at).toBe('2026-11-27T03:09:00.000Z');
  });
  test('ok:false marks an errored beat; three in a row is BROKEN', () => {
    const r = root();
    for (const m of [0, 1, 2]) beat('w1', { root: r, everyMin: 5, ok: false, now: at(m) });
    const v = judgeWatchers(readBeats(join(r, 'watchers', 'beats.jsonl')), at(3));
    expect(v[0]!.status).toBe('BROKEN');
    expect(v[0]!.lastError).toBe('not ok');
  });
  test('fail-soft: an unwritable ledger never throws to the caller', () => {
    const r = root();
    writeFileSync(join(r, 'watchers'), 'a file where the directory should be');
    expect(() => beat('w2', { root: r, everyMin: 5, now: at(0) })).not.toThrow();
  });
});

describe('staleness — one SLA rule', () => {
  const b = (min: number, extra: Partial<Beat> = {}): Beat => ({ name: 'x', at: at(min).toISOString(), saw: 0, everyMin: 5, ...extra });
  test('cadence 5: 4m fresh · 6m late · 10m late · 11m dead · never = missing', () => {
    expect(staleness(b(0), at(4)).state).toBe('fresh');
    expect(staleness(b(0), at(6)).state).toBe('late');
    expect(staleness(b(0), at(10)).state).toBe('late');
    expect(staleness(b(0), at(11)).state).toBe('dead');
    expect(staleness(null, at(11))).toEqual({ state: 'missing', ageMin: null, slaMin: null, leased: false });
  });
  test('an explicit SLA overrides the declared cadence', () => {
    expect(staleness(b(0), at(11), 30).state).toBe('fresh');
    expect(staleness(b(0), at(31), 30).state).toBe('late');
    expect(staleness(b(0), at(61), 30).state).toBe('dead');
  });
  test('a future lease keeps a 100-minute-old beat fresh; an expired lease is dead at once', () => {
    expect(staleness(b(0, { endsAt: at(120).toISOString() }), at(100))).toMatchObject({ state: 'fresh', leased: true });
    expect(staleness(b(0, { endsAt: at(3).toISOString() }), at(4)).state).toBe('dead');
  });
});

describe('loop signals — truth first, loop_signals mirrored', () => {
  test('emitSignal writes the truth line (kind loop-signal) and the mirror row', () => {
    const r = root();
    emitSignal(r, 'tc-seat', 'healthy', at(0), at(30).toISOString(), 15);
    expect(lastBeat('tc-seat', { root: r })).toEqual({ name: 'tc-seat', at: '2026-11-27T03:00:00.000Z', saw: 0, everyMin: 15,
      endsAt: '2026-11-27T03:30:00.000Z', kind: 'loop-signal', health: 'healthy' });
    expect(mirrorRow(r, 'tc-seat')).toEqual({ at: '2026-11-27T03:00:00.000Z', health: 'healthy', ends_at: '2026-11-27T03:30:00.000Z' });
  });
  test('an older signal never overwrites a newer mirror row', () => {
    const r = root();
    emitSignal(r, 'op-seat', 'healthy', at(10), at(40).toISOString());
    emitSignal(r, 'op-seat', 'degraded', at(5));
    expect(mirrorRow(r, 'op-seat')).toEqual({ at: '2026-11-27T03:10:00.000Z', health: 'healthy', ends_at: '2026-11-27T03:40:00.000Z' });
    expect(lastBeat('op-seat', { root: r })?.health).toBe('healthy');
  });
  test('invalid loop id is refused before anything is written', () => {
    const r = root();
    expect(() => emitSignal(r, 'Bad Id', 'healthy', at(0))).toThrow('invalid loop heartbeat');
    expect(readBeats(join(r, 'watchers', 'beats.jsonl'))).toEqual([]);
  });
  test('watcher views skip loop-signal beats unless asked', () => {
    const r = root();
    emitSignal(r, 'ux-seat', 'healthy', at(0), at(1).toISOString());
    beat('trigger-tick', { root: r, everyMin: 5, now: at(0) });
    const beats = readBeats(join(r, 'watchers', 'beats.jsonl'));
    expect(judgeWatchers(beats, at(2)).map(v => v.name)).toEqual(['trigger-tick']);
    const all = judgeWatchers(beats, at(2), () => null, { includeSignals: true });
    expect(all.map(v => `${v.name}:${v.status}`)).toEqual(['trigger-tick:OK', 'ux-seat:DEAD']);
    expect(all[1]!.reason).toBe('lease ended 2026-11-27T03:01:00.000Z (last beat 2m ago)');
  });
  test('extendSignalLease moves the mirror lease and the truth lease together; the beat age does not change', () => {
    const r = root();
    emitSignal(r, 'active', 'healthy', at(0), at(5).toISOString());
    expect(extendSignalLease(r, 'active', at(10))).toBe(true);
    expect(mirrorRow(r, 'active')).toEqual({ at: '2026-11-27T03:00:00.000Z', health: 'healthy', ends_at: '2026-11-27T03:25:00.000Z' });
    const last = lastBeat('active', { root: r })!;
    expect(last.at).toBe('2026-11-27T03:00:00.000Z');
    expect(last.endsAt).toBe('2026-11-27T03:25:00.000Z');
    expect(staleness(last, at(20)).state).toBe('fresh');
  });
  test('extendSignalLease refuses a degraded loop, a live lease, and a beat older than 15 minutes', () => {
    const r = root();
    emitSignal(r, 'sick', 'degraded', at(0), at(5).toISOString());
    emitSignal(r, 'leased', 'healthy', at(0), at(60).toISOString());
    emitSignal(r, 'old', 'healthy', at(0), at(5).toISOString());
    expect(extendSignalLease(r, 'sick', at(10))).toBe(false);
    expect(extendSignalLease(r, 'leased', at(10))).toBe(false);
    expect(extendSignalLease(r, 'old', at(16))).toBe(false);
    expect(extendSignalLease(root(), 'none', at(10))).toBe(false);
  });
});

// ── sim: seeded beat streams (3 seeds) — staleness and judgeWatchers agree with a hand oracle at every probe ──────
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
/** Oracle written independently: late past 1 cadence, dead past 2 cadences, a live lease wins, an ended lease is dead. */
function oracle(lastAtMin: number | null, cadence: number, nowMin: number, leaseEndMin: number | null): string {
  if (lastAtMin === null) return 'missing';
  if (leaseEndMin !== null) return leaseEndMin > nowMin ? 'fresh' : 'dead';
  const age = nowMin - lastAtMin;
  return age > cadence * 2 ? 'dead' : age > cadence ? 'late' : 'fresh';
}

describe('sim — staleness by SLA over seeded streams', () => {
  for (const seed of [7, 1127, 40404]) {
    test(`seed ${seed}: 40 probes, staleness == oracle and judgeWatchers DEAD == staleness dead`, () => {
      const rnd = prng(seed);
      const r = root();
      const cadence = [1, 5, 10][Math.floor(rnd() * 3)]!;
      const leased = rnd() < 0.5;
      const beatsAt: number[] = [];
      let t = 0;
      while (t < 300) { beatsAt.push(t); t += Math.max(0.5, Math.round(rnd() * cadence * 3.5 * 2) / 2); }
      // shuffle append order — event time, not line order, must decide
      const order = [...beatsAt].sort(() => rnd() - 0.5);
      const leaseFor = (m: number) => (leased ? m + cadence * 2 : null);
      for (const m of order) {
        if (leased) emitSignal(r, 'sim-loop', 'healthy', at(m), at(leaseFor(m)!).toISOString(), cadence);
        else beat('sim-loop', { root: r, everyMin: cadence, now: at(m) });
      }
      const all = readBeats(join(r, 'watchers', 'beats.jsonl'));
      const seen: Record<string, number> = { fresh: 0, late: 0, dead: 0, missing: 0 };
      for (let i = 0; i < 40; i++) {
        const nowMin = Math.round(rnd() * 330 * 2) / 2;
        const upTo = all.filter(b => Date.parse(b.at) <= at(nowMin).getTime());
        const lastMin = beatsAt.filter(m => m <= nowMin).reduce<number | null>((a, m) => (a === null || m > a ? m : a), null);
        const want = oracle(lastMin, cadence, nowMin, lastMin === null ? null : leaseFor(lastMin));
        const got = staleness(lastBeat('sim-loop', { beats: upTo }), at(nowMin)).state;
        expect(`${nowMin}:${got}`).toBe(`${nowMin}:${want}`);
        seen[got] = (seen[got] ?? 0) + 1;
        if (upTo.length) {
          const v = judgeWatchers(upTo, at(nowMin), () => null, { includeSignals: true })[0]!;
          expect(`${nowMin}:${v.status === 'DEAD'}`).toBe(`${nowMin}:${want === 'dead'}`);
        }
      }
      expect(seen.fresh! + seen.late! + seen.dead! + seen.missing!).toBe(40);
    });
  }
});
