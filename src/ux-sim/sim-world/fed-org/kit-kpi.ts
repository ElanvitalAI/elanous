// SIM-WORLD fed-org · kit/kpi (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-13 · 대표 11-27 «시뮬레이션 월드에서 다 충분히 검증»).
// The device is the real kit (src/kit/kpi) every loop agent of the federation now judges its KPI with. Each scenario walks
// ≥5 seeded event streams derived from ctx.seed (never Math.random) and compares the kit with an independent brute force.
import * as kpi from '../../../kit/kpi/index.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE = 'KIT-KPI';
type KitKpi = typeof kpi;

export const simWorldDevices: readonly SimWorldDeviceDef<KitKpi>[] = [{
  id: DEVICE,
  title: 'kit/kpi — raw KPI judgment, event-time windows, breach state machine and per-key debounce (pure · LLM 0)',
  create: () => kpi,
}];

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const SEEDS = 6;
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** mulberry32 — a per-seed stream so each derived seed is reproducible on its own. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const derived = (base: number): number[] => Array.from({ length: SEEDS }, (_, i) => (base * 1_000_003 + i * 7919 + 1) >>> 0);

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'KIT-KPI-WINDOW-EVENT-TIME',
    title: 'per-hour counts follow each event\'s own time: read order and clock-skewed (future) rows never change the count',
    devices: [DEVICE],
    async run(ctx) {
      const k = ctx.device<KitKpi>(DEVICE);
      const rows: Array<{ seed: number; count: number; brute: number }> = [];
      for (const seed of derived(ctx.seed)) {
        const r = rng(seed);
        const offsetsMin = Array.from({ length: 300 }, () => Math.floor(r() * 220) - 30); // 30 min of future skew
        const events = offsetsMin.map(m => ({ at: new Date(NOW - m * 60_000).toISOString() }));
        let brute = 0; for (const m of offsetsMin) if (m >= 0 && m <= 60) brute++;
        const count = k.countInWindow(events, e => e.at, NOW, k.HOUR_MS);
        const shuffled = events.map(e => ({ e, key: r() })).sort((a, b) => a.key - b.key).map(x => x.e);
        rows.push({ seed, count, brute });
        if (count !== brute) return fail('window-by-read-time', `seed ${seed}: kit ${count} vs event-time ${brute}`);
        if (k.countInWindow(shuffled, e => e.at, NOW, k.HOUR_MS) !== brute) return fail('window-order-dependent', `seed ${seed}`);
        let later = 0; for (const m of offsetsMin) if (m + 15 >= 0 && m + 15 <= 60) later++;
        if (k.countInWindow(events, e => e.at, NOW + 15 * 60_000, k.HOUR_MS) !== later) return fail('window-not-sliding', `seed ${seed}: +15 min`);
        const future = offsetsMin.filter(m => m < 0).length;
        if (future > 0 && k.countInWindow(events, e => e.at, NOW, 400 * 60_000) !== offsetsMin.length - future) return fail('future-rows-counted', `seed ${seed}: ${future} future rows`);
      }
      ctx.recorder.event('kit-kpi:window', { rows });
      return { ok: true };
    },
  },
  {
    id: 'KIT-KPI-RAW-JUDGMENT',
    title: 'targets are judged on the raw value: a value that only rounds onto the target is still a breach',
    devices: [DEVICE],
    async run(ctx) {
      const k = ctx.device<KitKpi>(DEVICE);
      let disagreements = 0;
      for (const seed of derived(ctx.seed)) {
        const r = rng(seed);
        for (let i = 0; i < 200; i++) {
          const target = 1 + Math.floor(r() * 20);
          const value = target - 0.5 + r() * 0.98; // [target-0.5, target+0.48): rounds to target almost always
          const atLeast = value >= target; const atMost = value <= target;
          if (k.kpiOk({ target, dir: 'at_least' }, value) !== atLeast) return fail('judged-rounded', `seed ${seed}: ${value} ≥ ${target}`);
          if (k.kpiOk({ target, dir: 'at_most' }, value) !== atMost) return fail('judged-rounded', `seed ${seed}: ${value} ≤ ${target}`);
          if (k.displayRound(value) === target && !atLeast) disagreements++;
        }
        if (k.kpiOk({ target: 1, dir: 'at_most' }, Number.NaN) !== null) return fail('unknown-judged', 'NaN');
      }
      ctx.recorder.event('kit-kpi:raw', { disagreements });
      if (disagreements === 0) return fail('scenario-vacuous', 'no value rounded onto its target while below it');
      return { ok: true };
    },
  },
  {
    id: 'KIT-KPI-BREACH-DEBOUNCE',
    title: 'a breach speaks once when it starts, once on recovery, re-alerts per key only after the window, and unknown readings change nothing',
    devices: [DEVICE],
    async run(ctx) {
      const k = ctx.device<KitKpi>(DEVICE);
      const rows: Array<{ seed: number; news: number; recs: number; alerts: number }> = [];
      for (const seed of derived(ctx.seed)) {
        const r = rng(seed);
        let s: kpi.BreachState = { ok: null, since: null };
        let news = 0; let recs = 0; let expNew = 0; let expRec = 0; let lastKnown: boolean | null = null;
        for (let i = 0; i < 180; i++) {
          const x = r(); const ok = x < 0.1 ? null : x < 0.5;
          const step = k.breachStep(s, ok, new Date(NOW + i * 60_000).toISOString());
          if (step.event === 'new') news++;
          if (step.event === 'recovered') recs++;
          if (ok === false && lastKnown !== false) expNew++;
          if (ok === true && lastKnown === false) expRec++;
          if (ok !== null) lastKnown = ok;
          if (ok === null && JSON.stringify(step.next) !== JSON.stringify(s)) return fail('unknown-moved-state', `seed ${seed} minute ${i}`);
          s = step.next;
          if ((s.ok === false) !== (s.since !== null)) return fail('since-inconsistent', `seed ${seed} minute ${i}: ${JSON.stringify(s)}`);
        }
        if (news !== expNew || recs !== expRec) return fail('breach-transitions', `seed ${seed}: new ${news}/${expNew} recovered ${recs}/${expRec}`);
        let stamps: Record<string, string> = {}; let alerts = 0;
        const runLast: Record<string, number | null> = { lands: null, landable: null, 'finisher-wait': null, 'no-next': null };
        for (let minute = 0; minute < 360; minute += 5) {
          const keys = Object.keys(runLast).filter(() => r() < 0.65);
          const d = k.debounceKeys(stamps, keys, new Date(NOW + minute * 60_000), 30);
          for (const key of Object.keys(runLast)) {
            if (!keys.includes(key)) { if (d.due.includes(key)) return fail('alert-without-breach', `seed ${seed} ${key}`); runLast[key] = null; continue; }
            const last = runLast[key];
            const should = last === null || minute - last >= 30;
            if (d.due.includes(key) !== should) return fail('debounce-window', `seed ${seed} ${key} minute ${minute}: due ${d.due.includes(key)} expected ${should}`);
            if (should) { runLast[key] = minute; alerts++; }
          }
          stamps = d.next;
        }
        rows.push({ seed, news, recs, alerts });
      }
      ctx.recorder.event('kit-kpi:breach', { rows });
      return { ok: true };
    },
  },
];
