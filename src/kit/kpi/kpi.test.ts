// kit/kpi — expectations are independent literals (rule 11): no product constant or helper builds an expected value.
import { describe, expect, test } from 'bun:test';
import { ageMin, breachStep, countInWindow, debounceKeys, displayRound, filterInWindow, fixed, inRange, inWindow, kpiBreached, kpiOk, median, okMark, pct, type BreachState } from './index.js';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');

describe('kit/kpi judgment is on the raw value', () => {
  test('at_least / at_most / unknown', () => {
    expect(kpiOk({ target: 10, dir: 'at_least' }, 10)).toBe(true);
    expect(kpiOk({ target: 10, dir: 'at_least' }, 9.99)).toBe(false);
    expect(kpiOk({ target: 1, dir: 'at_most' }, 1)).toBe(true);
    expect(kpiOk({ target: 1, dir: 'at_most' }, 1.004)).toBe(false);
    expect(kpiOk({ target: 1, dir: 'at_most' }, null)).toBe(null);
    expect(kpiOk({ target: 1, dir: 'at_most' }, Number.NaN)).toBe(null);
    expect(kpiBreached({ target: 1, dir: 'at_most' }, 1.004)).toBe(true);
    expect(kpiBreached({ target: 1, dir: 'at_most' }, undefined)).toBe(null);
  });
  test('a value that rounds onto the target still breaches (0.696 shown as 70% is below 0.7)', () => {
    expect(pct(0.696)).toBe('70%');
    expect(kpiOk({ target: 0.7, dir: 'at_least' }, 0.696)).toBe(false);
    expect(displayRound(9.6)).toBe(10);
    expect(kpiOk({ target: 10, dir: 'at_least' }, 9.6)).toBe(false);
  });
  test('display helpers', () => {
    expect(displayRound(0.8349, 2)).toBe(0.83);
    expect(displayRound(null)).toBe(null);
    expect(pct(null)).toBe('?');
    expect(pct(0.5)).toBe('50%');
    expect(fixed(0.8349)).toBe('0.83');
    expect(fixed(null)).toBe('?');
    expect(okMark(true)).toBe('✓');
    expect(okMark(false)).toBe('✘');
    expect(okMark(null)).toBe('·');
    expect(okMark(undefined)).toBe('·');
  });
  test('median', () => {
    expect(median([])).toBe(null);
    expect(median([7])).toBe(7);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('kit/kpi windows count by event time', () => {
  test('edges: now and exactly one hour ago count · a row after now and a broken stamp never count', () => {
    expect(inWindow('2026-11-27T12:00:00.000Z', NOW, 3_600_000)).toBe(true);
    expect(inWindow('2026-11-27T11:00:00.000Z', NOW, 3_600_000)).toBe(true);
    expect(inWindow('2026-11-27T10:59:59.999Z', NOW, 3_600_000)).toBe(false);
    expect(inWindow('2026-11-27T12:00:00.001Z', NOW, 3_600_000)).toBe(false);
    expect(inWindow('not a date', NOW, 3_600_000)).toBe(false);
    expect(inWindow(undefined, NOW, 3_600_000)).toBe(false);
    expect(inWindow(NOW - 60_000, NOW, 3_600_000)).toBe(true);
  });
  test('count / filter / range / age', () => {
    const rows = [{ at: '2026-11-27T11:30:00Z' }, { at: '2026-11-27T13:00:00Z' }, { at: '2026-11-27T09:00:00Z' }, { at: '' }];
    expect(countInWindow(rows, r => r.at, NOW, 3_600_000)).toBe(1);
    expect(filterInWindow(rows, r => r.at, NOW, 4 * 3_600_000).map(r => r.at)).toEqual(['2026-11-27T11:30:00Z', '2026-11-27T09:00:00Z']);
    expect(inRange('2026-11-27T00:00:00Z', Date.parse('2026-11-27T00:00:00Z'), NOW)).toBe(true);
    expect(inRange('2026-11-26T23:59:59Z', Date.parse('2026-11-27T00:00:00Z'), NOW)).toBe(false);
    expect(ageMin('2026-11-27T11:45:00Z', NOW)).toBe(15);
    expect(ageMin('2026-11-27T12:05:00Z', NOW)).toBe(0);
    expect(ageMin(null, NOW)).toBe(null);
  });
});

describe('kit/kpi breach state machine', () => {
  test('new → ongoing → recovered; unknown changes nothing', () => {
    let s: BreachState = { ok: null, since: null };
    let r = breachStep(s, false, '2026-11-27T10:00:00.000Z');
    expect(r.event).toBe('new'); expect(r.next).toEqual({ ok: false, since: '2026-11-27T10:00:00.000Z' }); expect(r.breachMin).toBe(0);
    s = r.next;
    r = breachStep(s, null, '2026-11-27T10:10:00.000Z');
    expect(r.event).toBe(null); expect(r.next).toEqual({ ok: false, since: '2026-11-27T10:00:00.000Z' }); expect(r.breachMin).toBe(10);
    r = breachStep(s, false, '2026-11-27T10:30:00.000Z');
    expect(r.event).toBe('ongoing'); expect(r.breachMin).toBe(30); expect(r.next.since).toBe('2026-11-27T10:00:00.000Z');
    s = r.next;
    r = breachStep(s, true, '2026-11-27T10:45:00.000Z');
    expect(r.event).toBe('recovered'); expect(r.next).toEqual({ ok: true, since: null });
    r = breachStep(r.next, true, '2026-11-27T10:50:00.000Z');
    expect(r.event).toBe(null);
  });
  test('an ongoing breach that lost its start is repaired to now (so it can escalate later)', () => {
    const r = breachStep({ ok: false, since: null }, false, '2026-11-27T10:00:00.000Z');
    expect(r.event).toBe('ongoing'); expect(r.next.since).toBe('2026-11-27T10:00:00.000Z');
  });
  test('per-key debounce: speak once per window, forget on recovery', () => {
    const t0 = new Date('2026-11-27T10:00:00.000Z');
    let d = debounceKeys({}, ['lands', 'landable', 'lands'], t0, 30);
    expect(d.due).toEqual(['lands', 'landable']);
    expect(d.next).toEqual({ lands: '2026-11-27T10:00:00.000Z', landable: '2026-11-27T10:00:00.000Z' });
    d = debounceKeys(d.next, ['lands'], new Date('2026-11-27T10:29:59.000Z'), 30);
    expect(d.due).toEqual([]);
    expect(d.next).toEqual({ lands: '2026-11-27T10:00:00.000Z' });
    const again = debounceKeys(d.next, ['lands', 'landable'], new Date('2026-11-27T10:30:00.000Z'), 30);
    expect(again.due).toEqual(['lands', 'landable']);
    expect(debounceKeys({ lands: 'garbage' }, ['lands'], t0, 30).due).toEqual(['lands']);
  });
});

// ── sim: seeded event streams (≥3 seeds) ─────────────────────────────────────────────────────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('kit/kpi sim — seeded streams', () => {
  for (const seed of [1, 7, 42, 2026]) {
    test(`seed ${seed}: window count equals a brute-force count by event time, regardless of read order or skew`, () => {
      const r = rng(seed);
      // events from 3 h before now to 20 min after now (clock skew), read in shuffled order
      const offsetsMin = Array.from({ length: 200 }, () => Math.floor(r() * 200) - 20);
      const rows = offsetsMin.map(m => ({ at: new Date(NOW - m * 60_000).toISOString() }));
      let brute = 0; for (const m of offsetsMin) if (m >= 0 && m <= 60) brute++;
      expect(countInWindow(rows, x => x.at, NOW, 3_600_000)).toBe(brute);
      const shuffled = [...rows].sort(() => r() - 0.5);
      expect(countInWindow(shuffled, x => x.at, NOW, 3_600_000)).toBe(brute);
      // reading the same stream 10 minutes later shifts the window by event time, not by when rows were read
      let later = 0; for (const m of offsetsMin) if (m + 10 >= 0 && m + 10 <= 60) later++;
      expect(countInWindow(rows, x => x.at, NOW + 600_000, 3_600_000)).toBe(later);
    });
    test(`seed ${seed}: breach transitions follow the ok stream (one new per run of misses, one recovered per run end)`, () => {
      const r = rng(seed);
      const stream: Array<boolean | null> = Array.from({ length: 120 }, () => { const x = r(); return x < 0.1 ? null : x < 0.45; });
      let s: BreachState = { ok: null, since: null };
      let news = 0; let recs = 0; let expNew = 0; let expRec = 0; let lastKnown: boolean | null = null;
      for (let i = 0; i < stream.length; i++) {
        const ok = stream[i]!;
        const at = new Date(NOW + i * 60_000).toISOString();
        const step = breachStep(s, ok, at);
        if (step.event === 'new') news++;
        if (step.event === 'recovered') recs++;
        if (ok === false && lastKnown !== false) expNew++;
        if (ok === true && lastKnown === false) expRec++;
        if (ok !== null) lastKnown = ok;
        s = step.next;
        if (s.ok === false) expect(s.since).not.toBe(null); else expect(s.since).toBe(null);
      }
      expect(news).toBe(expNew);
      expect(recs).toBe(expRec);
      expect(news - recs === 0 || news - recs === 1).toBe(true);
    });
    test(`seed ${seed}: per-key debounce never speaks twice inside the window`, () => {
      const r = rng(seed);
      let stamps: Record<string, string> = {};
      const runLast: Record<string, number | null> = { lands: null, landable: null, 'no-next': null };
      let alerts = 0;
      for (let minute = 0; minute < 240; minute += 5) {
        const keys = ['lands', 'landable', 'no-next'].filter(() => r() < 0.6);
        const d = debounceKeys(stamps, keys, new Date(NOW + minute * 60_000), 30);
        for (const k of Object.keys(runLast)) {
          if (!keys.includes(k)) { expect(d.due).not.toContain(k); runLast[k] = null; continue; }
          const last = runLast[k];
          const shouldSpeak = last === null || minute - last >= 30;
          expect(d.due.includes(k)).toBe(shouldSpeak);
          if (shouldSpeak) { runLast[k] = minute; alerts++; }
        }
        expect(Object.keys(d.next).sort()).toEqual([...new Set(keys)].sort());
        stamps = d.next;
      }
      expect(alerts).toBeGreaterThan(0);
    });
  }
});
