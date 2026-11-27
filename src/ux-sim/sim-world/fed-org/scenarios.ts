// SIM-WORLD fed-org — federation org structure simulation on the kernel contract (CEO 11-27 00:0x · 00:1x · 00:2x).
// The device is the policy model itself (seats · loop agents · hands · pregate · judge · land graph · mail bus · bodies),
// deterministic and LLM 0. Each scenario pins one conclusion the report draws, so a model change that flips it turns red.
import { BODY_VARIANTS, simulateBodies } from './body.js';
import { calibration, HEADROOM, recoverAfterEnd, seedList, TARGET } from './experiments.js';
import { simulate, type SimResult } from './model.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE = 'FED-ORG-POLICY-MODEL';
interface FedOrgDevice { readonly simulate: typeof simulate; readonly simulateBodies: typeof simulateBodies }

export const simWorldDevices: readonly SimWorldDeviceDef<FedOrgDevice>[] = [{
  id: DEVICE,
  title: 'federation org policy model — seats, sub-coordinator loop agents with helpers, hand pool, pregate hosts, judge, land graph, mail bus, 14 loop bodies (seeded · LLM 0)',
  create: () => ({ simulate, simulateBodies }),
}];

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const meets = (r: SimResult) => r.landsPerH >= TARGET.landsPerH && r.greensPerH >= TARGET.greensPerH;

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'FED-ORG-DETERMINISM',
    title: 'same seed ⇒ the same simulated day; another seed ⇒ another day',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<FedOrgDevice>(DEVICE);
      const a = JSON.stringify(d.simulate({ structure: 'S3', seed: ctx.seed, stress: 'judge-backlog' }));
      const b = JSON.stringify(d.simulate({ structure: 'S3', seed: ctx.seed, stress: 'judge-backlog' }));
      const c = JSON.stringify(d.simulate({ structure: 'S3', seed: ctx.seed + 1, stress: 'judge-backlog' }));
      const ba = JSON.stringify(d.simulateBodies('D-shared', ctx.seed));
      const bb = JSON.stringify(d.simulateBodies('D-shared', ctx.seed));
      ctx.recorder.event('fed-org:determinism', { same: a === b, differs: a !== c, bodySame: ba === bb });
      if (a !== b || ba !== bb) return fail('nondeterministic', 'two runs with one seed differ');
      if (a === c) return fail('seed-ignored', 'seed+1 produced the identical day');
      return { ok: true };
    },
  },
  {
    id: 'FED-ORG-CALIBRATION',
    title: 'S0 first 4 simulated hours stay within the calibration band of the 11-26 night (fed-chatlog 2322)',
    devices: [DEVICE],
    async run(ctx) {
      const rows = calibration(seedList(10));
      ctx.recorder.event('fed-org:calibration', { rows });
      // ratio band: the model must reproduce the order of magnitude and the shape, not the exact count
      const band: Record<string, [number, number]> = {
        mailsPerH: [0.6, 1.4], askMailsPerH: [0.5, 1.5], tcInboundPerH: [0.7, 1.6], landsPerH: [0.5, 1.4], idleHands: [0.8, 1.3], pingPong: [0.5, 1.5], opNoop: [0.5, 1.1],
      };
      for (const row of rows) {
        const b = band[row.metric];
        if (!b || row.ratio === null) continue;
        if (row.ratio < b[0] || row.ratio > b[1]) return fail('calibration-drift', `${row.metric}: sim ${row.sim.toFixed(2)} vs observed ${row.observed} (ratio ${row.ratio.toFixed(2)} ∉ [${b[0]}, ${b[1]}])`);
      }
      const greens = rows.find((r) => r.metric === 'greensPerH')!;
      if (greens.sim > 1) return fail('calibration-drift', `S0 greens/h ${greens.sim.toFixed(2)} — tonight was green 1 / yellow 112`);
      return { ok: true };
    },
  },
  {
    id: 'FED-ORG-TARGET',
    title: 'only the loop-agent structures (S3, S4) reach 10 lands/h + 10 greens/h; tonight\'s fixes alone (S1) do not',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<FedOrgDevice>(DEVICE);
      const share: Record<string, number> = {};
      for (const s of ['S0', 'S1', 'S2', 'S3', 'S4'] as const) share[s] = mean(seedList(5).map((seed) => (meets(d.simulate({ structure: s, seed })) ? 1 : 0)));
      ctx.recorder.event('fed-org:target', share);
      for (const s of ['S0', 'S1', 'S2'] as const) if (share[s] > 0) return fail('target-met-too-early', `${s} met the target on ${share[s] * 100}% of seeds`);
      for (const s of ['S3', 'S4'] as const) if (share[s] < 0.8) return fail('target-missed', `${s} met the target on only ${share[s] * 100}% of seeds`);
      return { ok: true };
    },
  },
  {
    id: 'FED-ORG-HEADROOM',
    title: 'S4 runs pregate at ρ≈1 and never drains a 40-PR judge backlog; S4★ (headroom) drains it within the day',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<FedOrgDevice>(DEVICE);
      const seeds = seedList(10);
      const curve = (xs: SimResult[]) => xs[0].backlog.map((_, k) => mean(xs.map((x) => x.backlog[k])));
      const rec = (patch: object) => recoverAfterEnd(
        curve(seeds.map((seed) => d.simulate({ structure: 'S4', seed, stress: 'judge-backlog', patch }))),
        curve(seeds.map((seed) => d.simulate({ structure: 'S4', seed, patch }))), 'judge-backlog');
      const plain = rec({}); const head = rec(HEADROOM);
      ctx.recorder.event('fed-org:headroom', { plain, head });
      if (plain !== null) return fail('headroom-not-needed', `S4 drained the judge backlog in ${plain} min`);
      if (head === null || head > 6 * 60) return fail('headroom-ineffective', `S4★ recovery ${head} min`);
      return { ok: true };
    },
  },
  {
    id: 'FED-ORG-HELPERS',
    title: 'helpers (collector graph + capsules) lift loop-agent SLA coverage at a visible LLM cost; 0 helpers miss the 10-min SLA',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<FedOrgDevice>(DEVICE);
      const run = (perAgent: 0 | 2 | 4) => seedList(5).map((seed) => d.simulate({ structure: 'S4', seed, helpers: { perAgent, fedCapsuleCap: 8 } }));
      const h0 = run(0); const h2 = run(2);
      const sla0 = mean(h0.map((x) => x.agentSlaShare)); const sla2 = mean(h2.map((x) => x.agentSlaShare));
      const llm0 = mean(h0.map((x) => x.llmCallsPerH)); const llm2 = mean(h2.map((x) => x.llmCallsPerH));
      ctx.recorder.event('fed-org:helpers', { sla0, sla2, llm0, llm2 });
      if (sla0 > 0.8) return fail('helpers-unneeded', `0 helpers already serve ${(sla0 * 100).toFixed(0)}% within SLA`);
      if (sla2 - sla0 < 0.2) return fail('helpers-ineffective', `SLA share ${sla0.toFixed(2)} → ${sla2.toFixed(2)}`);
      if (llm2 <= llm0) return fail('helper-cost-hidden', `LLM calls/h ${llm0.toFixed(1)} → ${llm2.toFixed(1)}`);
      return { ok: true };
    },
  },
  {
    id: 'FED-ORG-BODY',
    title: 'body variants: cron bodies waste ticks and miss windows; the shared reactive runtime misses none and spawns no process per tick',
    devices: [DEVICE],
    async run(ctx) {
      const d = ctx.device<FedOrgDevice>(DEVICE);
      const by = Object.fromEntries(BODY_VARIANTS.map((v) => [v, seedList(3).map((seed) => d.simulateBodies(v, seed))]));
      const m = (v: string, k: 'wastedShare' | 'missedPerDay' | 'spawnsPerH' | 'goalAttainment' | 'recoverMin') => mean(by[v].map((x) => x[k]));
      const view = Object.fromEntries(BODY_VARIANTS.map((v) => [v, { wasted: m(v, 'wastedShare'), missed: m(v, 'missedPerDay'), spawns: m(v, 'spawnsPerH'), goal: m(v, 'goalAttainment'), recover: m(v, 'recoverMin') }]));
      ctx.recorder.event('fed-org:body', view);
      if (m('A-cron', 'wastedShare') < 0.4) return fail('cron-waste-absent', `A-cron wasted share ${m('A-cron', 'wastedShare').toFixed(2)}`);
      if (m('D-shared', 'missedPerDay') !== 0 || m('D-shared', 'spawnsPerH') !== 0) return fail('shared-runtime-misses', JSON.stringify(view['D-shared']));
      if (m('D-shared', 'goalAttainment') <= m('A-cron', 'goalAttainment')) return fail('goal-node-no-gain', JSON.stringify(view));
      if (m('B-event', 'recoverMin') <= m('C-reactive', 'recoverMin')) return fail('cursor-no-gain', JSON.stringify(view));
      return { ok: true };
    },
  },
];
