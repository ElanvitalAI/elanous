// SIM-WORLD machine-infra · kit/heartbeat (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-10 · CEO 11-27 «시뮬레이션 월드에서 다 충분히 검증»).
// Device KIT-HEARTBEAT-LEDGER = the real kit writing into this scenario's universe (beats.jsonl truth ⊕ loop_signals mirror).
// Every scenario runs 5 seeds derived from ctx.seed; expected states come from a hand oracle with the multipliers written out.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMsgStore } from '../../../msg/msg-store.js';
import { beat, beatLedgerPath, emitSignal, extendSignalLease, judgeWatchers, lastBeat, readBeats, staleness } from '../../../kit/heartbeat/index.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE = 'KIT-HEARTBEAT-LEDGER';
const SEEDS_PER_RUN = 5;
const T0 = Date.parse('2026-11-27T03:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);

interface HeartbeatDevice { root(tag: string): string }

export const simWorldDevices: readonly SimWorldDeviceDef<HeartbeatDevice>[] = [{
  id: DEVICE,
  title: 'kit/heartbeat on a scenario-owned instance root — beats.jsonl truth and the loop_signals mirror (LLM 0 · fs only)',
  create(ctx) {
    return { root(tag) { const r = join(ctx.universeRoot, 'kit-heartbeat', tag); mkdirSync(r, { recursive: true }); return r; } };
  },
}];

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const seeds = (base: number) => Array.from({ length: SEEDS_PER_RUN }, (_, k) => (base * 7919 + k * 104729 + 1) >>> 0);
function oracle(lastAtMin: number | null, cadence: number, nowMin: number, leaseEndMin: number | null): string {
  if (lastAtMin === null) return 'missing';
  if (leaseEndMin !== null) return leaseEndMin > nowMin ? 'fresh' : 'dead';
  const age = nowMin - lastAtMin;
  return age > cadence * 2 ? 'dead' : age > cadence ? 'late' : 'fresh';
}
const mirror = (r: string, id: string) => {
  const store = openMsgStore(join(r, 'msg', 'messages.db'));
  try {
    if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='loop_signals'").get()) return null;
    return store.db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?').get(id) as { at: string; health: string; ends_at: string | null } | null;
  }
  finally { store.close(); }
};

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'KIT-HB-STALENESS',
    title: 'staleness by SLA over 5 seeded beat streams (shuffled append order): fresh/late/dead/missing == oracle · judgeWatchers DEAD == staleness dead',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<HeartbeatDevice>(DEVICE);
      const tally: Record<string, number> = { fresh: 0, late: 0, dead: 0, missing: 0 };
      for (const seed of seeds(ctx.seed)) {
        const rnd = prng(seed);
        const r = d.root(`stale-${seed}`);
        const cadence = [1, 5, 10, 15][Math.floor(rnd() * 4)]!;
        const leased = rnd() < 0.4;
        const times: number[] = [];
        for (let t = rnd() * 5; t < 240; t += Math.max(0.5, Math.round(rnd() * cadence * 3.5 * 2) / 2)) times.push(Math.round(t * 2) / 2);
        const leaseFor = (m: number) => (leased ? m + cadence * 2 : null);
        for (const m of [...times].sort(() => rnd() - 0.5)) {
          if (leased) emitSignal(r, 'sim-loop', 'healthy', at(m), at(leaseFor(m)!).toISOString(), cadence);
          else beat('sim-loop', { root: r, everyMin: cadence, now: at(m) });
        }
        const all = readBeats(beatLedgerPath(r));
        for (let i = 0; i < 30; i++) {
          const nowMin = Math.round(rnd() * 260 * 2) / 2;
          const upTo = all.filter(b => Date.parse(b.at) <= at(nowMin).getTime());
          const last = times.filter(m => m <= nowMin).reduce<number | null>((a, m) => (a === null || m > a ? m : a), null);
          const want = oracle(last, cadence, nowMin, last === null ? null : leaseFor(last));
          const got = staleness(lastBeat('sim-loop', { beats: upTo }), at(nowMin)).state;
          if (got !== want) return fail('staleness-mismatch', `seed ${seed} cadence ${cadence} leased ${leased} t=${nowMin}: got ${got}, want ${want}`);
          if (upTo.length) {
            const v = judgeWatchers(upTo, at(nowMin), () => null, { includeSignals: true })[0]!;
            if ((v.status === 'DEAD') !== (want === 'dead')) return fail('watchers-disagree', `seed ${seed} t=${nowMin}: judgeWatchers ${v.status} vs staleness ${want}`);
          }
          tally[got] = (tally[got] ?? 0) + 1;
        }
      }
      ctx.recorder.event('kit-heartbeat:staleness', tally);
      if (tally.fresh === 0 || tally.dead === 0) return fail('degenerate-sample', `5 seeds never produced both fresh and dead: ${JSON.stringify(tally)}`);
      return { ok: true };
    },
  },
  {
    id: 'KIT-HB-ONE-TRUTH',
    title: 'seat loops beating out of order: the loop_signals mirror always equals the truth ledger (at · health · lease) — lease renewals included',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<HeartbeatDevice>(DEVICE);
      const ids = ['op-seat', 'tc-seat', 'cmo-seat', 'ux-seat', 'orchestrator'];
      let renewed = 0;
      for (const seed of seeds(ctx.seed)) {
        const rnd = prng(seed);
        const r = d.root(`truth-${seed}`);
        const events = Array.from({ length: 40 }, () => ({ id: ids[Math.floor(rnd() * ids.length)]!, min: Math.round(rnd() * 120), degraded: rnd() < 0.15 }));
        for (const e of events) emitSignal(r, e.id, e.degraded ? 'degraded' : 'healthy', at(e.min), at(e.min + 30).toISOString(), 15);
        // steward triage: renew leases that ended while the loop is still beating healthy (≤ 15 min old)
        const probe = at(125 + Math.round(rnd() * 20));
        for (const id of ids) if (extendSignalLease(r, id, probe)) renewed++;
        for (const id of ids) {
          const truth = lastBeat(id, { root: r });
          const row = mirror(r, id);
          if (!truth && !row) continue;
          const t = truth ? { at: truth.at, health: truth.health ?? null, ends_at: truth.endsAt ?? null } : null;
          if (JSON.stringify(t) !== JSON.stringify(row)) return fail('mirror-diverged', `seed ${seed} ${id}: truth ${JSON.stringify(t)} vs mirror ${JSON.stringify(row)}`);
        }
      }
      ctx.recorder.event('kit-heartbeat:one-truth', { seeds: SEEDS_PER_RUN, renewed });
      return { ok: true };
    },
  },
  {
    id: 'KIT-HB-WATCHER-VIEW',
    title: 'idle seats between turns stay out of watcher cards (loop-signal beats skipped by default) while a stopped watcher is DEAD at 2× cadence',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<HeartbeatDevice>(DEVICE);
      for (const seed of seeds(ctx.seed)) {
        const rnd = prng(seed);
        const r = d.root(`view-${seed}`);
        const cadence = [2, 5, 10][Math.floor(rnd() * 3)]!;
        const stopAt = 10 + Math.round(rnd() * 30);
        for (let m = 0; m <= stopAt; m += cadence) beat('res-patrol', { root: r, everyMin: cadence, now: at(m) });
        emitSignal(r, 'tc-seat', 'healthy', at(1), at(31).toISOString(), 15);
        const lastAt = Math.floor(stopAt / cadence) * cadence;
        const probe = lastAt + cadence * 2 + 1;
        const v = judgeWatchers(readBeats(beatLedgerPath(r)), at(probe));
        const names = v.map(x => `${x.name}:${x.status}`).join(',');
        if (names !== 'res-patrol:DEAD') return fail('watcher-view', `seed ${seed} cadence ${cadence} probe ${probe}: ${names}`);
        const before = judgeWatchers(readBeats(beatLedgerPath(r)), at(lastAt + cadence * 2));
        if (before[0]?.status !== 'OK') return fail('dead-too-early', `seed ${seed}: at exactly 2× cadence the watcher is ${before[0]?.status}`);
      }
      return { ok: true };
    },
  },
  {
    id: 'KIT-HB-FAIL-SOFT',
    title: 'an unwritable ledger never breaks a watcher (beat is fail-soft); a leased loop beat fails before touching the mirror',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<HeartbeatDevice>(DEVICE);
      for (const seed of seeds(ctx.seed)) {
        const r = d.root(`soft-${seed}`);
        writeFileSync(join(r, 'watchers'), 'a file where the watcher dir should be');
        try { beat('judge-butler', { root: r, everyMin: 10, saw: seed % 7, now: at(0) }); }
        catch (e) { return fail('beat-threw', `seed ${seed}: ${String(e)}`); }
        let threw = false;
        try { emitSignal(r, 'op-seat', 'healthy', at(0), at(30).toISOString()); } catch { threw = true; }
        if (!threw) return fail('signal-swallowed', `seed ${seed}: emitSignal did not report the failed truth write`);
        mkdirSync(join(r, 'msg'), { recursive: true });
        if (mirror(r, 'op-seat') !== null) return fail('mirror-ahead-of-truth', `seed ${seed}: mirror row written although the truth append failed`);
      }
      return { ok: true };
    },
  },
];
