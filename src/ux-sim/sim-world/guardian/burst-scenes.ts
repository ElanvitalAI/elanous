// SIM-WORLD guardian · BURST-ACTUATOR-WIRED (0.3.40 P1 · 11-28 burst-20261128T1409 beat «손 +0 · VM 0» for ~5 h).
// Device BURST-WORLD = a seat-state ⊕ state root inside the scenario universe, the incident's burst.json (preset targets in
// `levels`, launches []), and a fake els-new door that records every pane it opens — driven through the real pulse runner
// (runPulse → planScale → actuateBurst). Expected values are literals from the scene, never re-derived from src/loops.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PulseMeasure } from '../../../loops/op-pulse.js';
import type { BurstState } from '../../../loops/op-pulse-burst.js';
import type { BurstActuators } from '../../../loops/op-pulse-burst-actuate.js';
import { runPulse, type PulseExtra, type PulseProbes } from '../../../loops/op-pulse-run.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

export const BURST_DEVICE = 'BURST-WORLD';
const REPO = resolve(import.meta.dir, '../../../..');
const RHYTHM = join(REPO, 'graphs/triggers/op-pulse.rhythm.yaml');
const T0 = Date.parse('2026-11-28T14:09:47.927Z'); // 23:09 KST — `eln pulse burst start --goal land --preset 4h`
const STOP_AT = '2026-11-29T04:15:00+09:00'; // the incident burst's end (KST)

export interface BurstWorld {
  readonly seatState: string; readonly stateRoot: string; readonly burstPath: string;
  /** Panes the fake els-new door opened, in order. */
  readonly opened: string[];
  writeIncidentBurst(): void;
  readBurst(): BurstState;
  doors(mode: 'ok' | 'throws'): BurstActuators;
}

export const burstWorldDevice: SimWorldDeviceDef<BurstWorld> = {
  id: BURST_DEVICE,
  title: 'BURST-ACTUATOR-WIRED — the 11-28 burst.json (targets in levels · launches []) under the real pulse runner with a recording fake els-new door (LLM 0)',
  create: (ctx) => {
    const seatState = join(ctx.universeRoot, 'seat-state'); const stateRoot = join(ctx.universeRoot, 'state');
    const burstPath = join(seatState, 'OP', 'pulse', 'burst.json');
    const opened: string[] = [];
    let n = 0;
    return {
      seatState, stateRoot, burstPath, opened,
      writeIncidentBurst() {
        mkdirSync(join(seatState, 'OP', 'pulse'), { recursive: true });
        // The record as it sat on disk on 11-28 (written by the pre-fix startBurst): preset targets as «levels».
        writeFileSync(burstPath, JSON.stringify({ id: 'burst-20261128T1409', status: 'active', goal: 'land', preset: '4h', scope: ['ALL'], startedAt: new Date(T0).toISOString(),
          until: STOP_AT, by: 'OP', budgetUsd: 80, spentUsd: 0, cloudApprovedUsd: 0, levels: { hands: 4, ta: 4, remote: 4, review: 2, pregate: 2, land: 1 },
          lastChangeAt: {}, launches: [], baseline: { landed: null, green: null }, trigger: 'manual:OP', allIn: false }));
      },
      readBurst: () => JSON.parse(readFileSync(burstPath, 'utf8')) as BurstState,
      doors: (mode) => ({
        up: { hands: async ({ count }) => {
          if (mode === 'throws') throw new Error('els: server socket not found');
          const units = Array.from({ length: count }, () => { n += 1; return { id: `wB:p${n}`, host: `HAND-SIM-${n}` }; });
          opened.push(...units.map(u => u.id));
          return { units };
        } },
      }),
    };
  },
};

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const between = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export const burstScenarios: readonly SimWorldScenario[] = [
  {
    id: 'BURST-ACTUATES',
    title: 'the 11-28 burst.json (4h · targets in levels · launches []) under a backlog of 150–260 ready cells: the first pulse 1–14 min after start opens ≥ 1 hand pane through the door, records its exact id, and the beat counts that launch (not the target); a door that throws stays «손 +0» with the error named — never a fake +k',
    devices: [BURST_DEVICE],
    async run(ctx) {
      const w = ctx.device<BurstWorld>(BURST_DEVICE);
      const backlog = between(ctx.random, 150, 260); const hands = between(ctx.random, 10, 20); const firstMin = between(ctx.random, 1, 14);
      let clock = new Date(T0 + firstMin * 60_000);
      const measure = (): PulseMeasure => ({ at: clock.toISOString(), version: '0.3.40', landedPerH: 2, greenPerH: 0, judgeQueue: 0, judgeWaitMedianMin: null, budget: [], unmeasured: [],
        spaces: [{ space: 'TC', landedPerH: 2, greenPerH: 0, hands, idleWithWork: 3, readyCells: backlog, blockedCells: 0 }] });
      const extra = (): PulseExtra => ({ landed3hPerH: 2, green3hPerH: null, readyBacklog: backlog, openInScope: backlog,
        demand: { newP0PerH: 0, baselineP0PerH: null, activeRequirements: null, readyBacklogGrowthPerH: null }, gateWaitMin: null, reviewWaitMin: null, landQueue: null });
      const probes = (mode: 'ok' | 'throws'): PulseProbes => ({ now: () => clock, localHour: () => 23, schedules: () => [], crownMails: () => [],
        measure: async () => ({ measure: measure(), extra: extra() }), burstActuators: () => w.doors(mode) });
      const io = { rhythmPath: RHYTHM, seatState: w.seatState, stateRoot: w.stateRoot, stage: 'live' };

      // ① the incident record, a door that throws (els server down) → no launch, the error is on the beat.
      w.writeIncidentBurst();
      const down = await runPulse(probes('throws'), { ...io, window: clock.toISOString() });
      const afterDown = w.readBurst();
      // ② the same burst, the door works → the first pulse launches.
      clock = new Date(clock.getTime() + 60_000);
      const up = await runPulse(probes('ok'), { ...io, window: clock.toISOString() });
      const s = w.readBurst();
      const launched = s.launches.map(l => l.id);
      ctx.recorder.event('burst:actuates', { backlog, hands, firstMin, downLaunches: afterDown.launches.length, launched, levels: s.levels, opened: [...w.opened] });

      if (afterDown.launches.length !== 0) return fail('throwing-door-recorded-a-launch', JSON.stringify(afterDown.launches));
      if (!down.brief?.includes('실행(이번 펄스): 손 +0 · VM +0 · 가동 중 0')) return fail('down-beat-not-zero', down.brief ?? '-');
      if (!down.brief.includes('(failed · els: server socket not found)')) return fail('door-error-not-named', down.brief);
      if (JSON.stringify(afterDown.targets) !== JSON.stringify({ hands: 4, ta: 4, remote: 4, review: 2, pregate: 2, land: 1 })) return fail('legacy-targets-lost', JSON.stringify(afterDown.targets));
      if (launched.length < 1) return fail('no-actuator-raised', JSON.stringify(s));
      if (launched.join(',') !== w.opened.join(',')) return fail('ids-not-the-doors', `${launched.join(',')} vs ${w.opened.join(',')}`);
      if (s.levels.hands !== launched.length) return fail('level-not-executed', JSON.stringify(s.levels));
      if (!up.brief?.includes(`실행(이번 펄스): 손 +${launched.length} · VM +0 · 가동 중 ${launched.length} (손 ${launched.length})`)) return fail('beat-not-executed-count', up.brief ?? '-');
      if (up.brief.includes('손 +4')) return fail('beat-reads-target', up.brief);
      return { ok: true };
    },
  },
];
