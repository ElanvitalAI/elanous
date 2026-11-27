// FED-ORG-SIM experiments — the tables the report shows, all from simulate()/simulateBodies() over seeds. Pure, LLM 0.
// `bun src/ux-sim/sim-world/fed-org/experiments.ts [seeds]` prints the JSON the report is built from.
import { BODY_VARIANTS, simulateBodies, type BodyResult, type BodyVariant } from './body.js';
import { simulate, STRESSES, STRUCTURES, type SimResult, type StressId, type Structure, type StructureId } from './model.js';

export const SCENARIOS: readonly StructureId[] = ['S0', 'S1', 'S2', 'S3', 'S4'];
export const TARGET = { landsPerH: 10, greensPerH: 10 } as const;

/** Observed 11-26 night (fed-chatlog 2322 window · `eln loop trigger list` · origin/main land log · op-turn-enforce). */
export const OBSERVED = {
  mailsPerH: 549, askMailsPerH: 74, tcInboundPerH: 168, landsPerH: 10.5, greensPerH: 0.04, idleHands: 15,
  pingPong: 0.23, opNoop: 1, overdue: 1039,
} as const;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
export const seedList = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

export interface Row { readonly id: string; readonly label: string; readonly m: Record<string, number>; readonly sd: Record<string, number> }
const KEYS = ['landsPerH', 'greensPerH', 'mailsPerH', 'askMailsPerH', 'askWaitP50', 'askWaitP95', 'handUtil', 'idleHandsAvg', 'readyAvg',
  'pingPongRatio', 'opNoopRatio', 'staleRefusals', 'ceoInterrupts', 'llmCallsPerH', 'tcInboundPerH', 'asksHandledPerH', 'domainsInSla', 'agentItemsPerH', 'agentSlaShare', 'overdueEnd'] as const;

function summarize(id: string, label: string, rs: SimResult[]): Row {
  const m: Record<string, number> = {}; const s: Record<string, number> = {};
  for (const k of KEYS) { const xs = rs.map((x) => x[k] as number); m[k] = mean(xs); s[k] = sd(xs); }
  for (const k of ['pregate', 'judge', 'land', 'hands', 'agents'] as const) m[`util.${k}`] = mean(rs.map((x) => x.util[k]));
  m.meetsTarget = rs.filter((x) => x.landsPerH >= TARGET.landsPerH && x.greensPerH >= TARGET.greensPerH).length / rs.length;
  return { id, label, m, sd: s };
}

/** Headroom variants the sim proposes on top of S3/S4: burst pregate early (queue > 2) and a 3-car merge train per hot file. */
export const HEADROOM: Partial<Structure> = { burstAtQueue: 0, laneWidth: 3, errScale: 0.6, wipCapPregateQ: 8 };
export const PROPOSALS: readonly { id: string; from: StructureId; label: string; patch: Partial<Structure> }[] = [
  { id: 'S3★', from: 'S3', label: 'S3★ S3 + 헤드룸(버스트 호스트 상시 · 3량 열차 · 재작업 −40% · WIP 상한)', patch: HEADROOM },
  { id: 'S4★', from: 'S4', label: 'S4★ S4 + 헤드룸', patch: HEADROOM },
];

export function scenarioTable(seeds: readonly number[]): Row[] {
  return [
    ...SCENARIOS.map((id) => summarize(id, STRUCTURES[id].label, seeds.map((seed) => simulate({ structure: id, seed })))),
    ...PROPOSALS.map((p) => summarize(p.id, p.label, seeds.map((seed) => simulate({ structure: p.from, seed, patch: p.patch })))),
  ];
}

/** S0 first 4 simulated hours vs tonight's observed window. */
export function calibration(seeds: readonly number[]) {
  const rs = seeds.map((seed) => simulate({ structure: 'S0', seed }).calib.first4h);
  const sim = {
    mailsPerH: mean(rs.map((x) => x.mailsPerH)), askMailsPerH: mean(rs.map((x) => x.askMailsPerH)), tcInboundPerH: mean(rs.map((x) => x.tcInboundPerH)),
    landsPerH: mean(rs.map((x) => x.landsPerH)), greensPerH: mean(rs.map((x) => x.greensPerH)), idleHands: mean(rs.map((x) => x.idleHands)),
    pingPong: mean(rs.map((x) => x.pingPong)), opNoop: mean(rs.map((x) => x.opNoop)),
  };
  return (Object.keys(sim) as (keyof typeof sim)[]).map((k) => ({ metric: k, observed: OBSERVED[k], sim: sim[k], ratio: OBSERVED[k] ? sim[k] / OBSERVED[k] : null }));
}

/** How long each stress lasts (min); instantaneous injections are 0. */
export const STRESS_DURATION_MIN: Readonly<Record<Exclude<StressId, 'none'>, number>> = {
  'coord-silence': 180, 'hot-burst': 0, 'host-down': 180, 'llm-95': 240, 'ceo-burst': 0, 'judge-backlog': 0,
};
const STRESS_AT = 8 * 60;
/**
 * Time-to-recover after the stress ends, on seed-mean backlog curves (open ✋ + queued PRs): the excess over the unstressed
 * run first stays ≤ max(3, 25 % of its peak) for 30 min. null = not within the day (no slack to drain the excess).
 */
export function recoverAfterEnd(stressed: readonly number[], base: readonly number[], stress: Exclude<StressId, 'none'>): number | null {
  const start = Math.floor(STRESS_AT / 10);
  const from = Math.ceil((STRESS_AT + STRESS_DURATION_MIN[stress]) / 10);
  const excess = stressed.map((v, i) => v - base[i]);
  const peak = Math.max(0, ...excess.slice(start));
  const limit = Math.max(3, 0.25 * peak);
  let ok = 0;
  for (let i = from; i < stressed.length; i++) {
    if (excess[i] <= limit) { ok++; if (ok >= 3) return (i - 2 - from) * 10; } else ok = 0;
  }
  return null;
}

export function stressTable(seeds: readonly number[]) {
  const out: { structure: string; stress: StressId; recoverMin: number | null; recovered: number; baseBacklog: number; landsLossPerH: number; ceo: number; peakBacklog: number }[] = [];
  const rows: { id: string; from: StructureId; patch: Partial<Structure> }[] = [...SCENARIOS.map((id) => ({ id, from: id, patch: {} })), ...PROPOSALS];
  for (const { id, from, patch } of rows) {
    const base = seeds.map((seed) => simulate({ structure: from, seed, patch }));
    for (const stress of STRESSES) {
      const rs = seeds.map((seed) => simulate({ structure: from, seed, stress, patch }));
      // seed-mean backlog curves (per-seed curves diverge once the stress changes the random stream)
      const curve = (xs: SimResult[]) => xs[0].backlog.map((_, k) => mean(xs.map((x) => x.backlog[k])));
      const rec = recoverAfterEnd(curve(rs), curve(base), stress as Exclude<StressId, 'none'>);
      const perSeed = rs.map((x, i) => recoverAfterEnd(x.backlog, base[i].backlog, stress as Exclude<StressId, 'none'>));
      out.push({
        structure: id, stress, recovered: perSeed.filter((x) => x !== null).length / rs.length,
        recoverMin: rec, baseBacklog: mean(base.map((x) => x.backlog[48])),
        landsLossPerH: mean(base.map((x) => x.landsPerH)) - mean(rs.map((x) => x.landsPerH)),
        ceo: mean(rs.map((x) => x.ceoInterrupts)),
        peakBacklog: Math.max(0, ...curve(rs).map((v, k) => (k >= 48 ? v - curve(base)[k] : 0))),
      });
    }
  }
  return out;
}

/** Helpers per loop agent (0/2/4) in S3/S4, normal and with LLM accounts at 95 % (llm-95 stress). */
export function helperTable(seeds: readonly number[]) {
  const out: { structure: StructureId; helpers: 0 | 2 | 4; stress: StressId; m: Record<string, number> }[] = [];
  for (const id of ['S3', 'S4'] as const) for (const stress of ['none', 'llm-95'] as const) for (const perAgent of [0, 2, 4] as const) {
    const rs = seeds.map((seed) => simulate({ structure: id, seed, stress, helpers: { perAgent, fedCapsuleCap: 8 } }));
    out.push({ structure: id, helpers: perAgent, stress, m: {
      asksHandledPerH: mean(rs.map((x) => x.asksHandledPerH)), agentItemsPerH: mean(rs.map((x) => x.agentItemsPerH)), agentStartP95: mean(rs.map((x) => x.agentStartP95)), agentSlaShare: mean(rs.map((x) => x.agentSlaShare)), draftedPerH: mean(rs.map((x) => x.draftedPerH)), askWaitP50: mean(rs.map((x) => x.askWaitP50)), askWaitP95: mean(rs.map((x) => x.askWaitP95)),
      llmCallsPerH: mean(rs.map((x) => x.llmCallsPerH)), agentUtil: mean(rs.map((x) => x.util.agents)), handUtil: mean(rs.map((x) => x.handUtil)),
      landsPerH: mean(rs.map((x) => x.landsPerH)), greensPerH: mean(rs.map((x) => x.greensPerH)), domainsInSla: mean(rs.map((x) => x.domainsInSla)),
    } });
  }
  return out;
}

/** Single-lever sensitivity: each lever applied alone on top of S1 (what one move buys from tonight's fixed state). */
export const LEVERS: readonly { id: string; label: string; patch: Partial<Structure> }[] = [
  { id: 'route', label: '✋ 도메인 라우팅 ⊕ 지문 dedupe(우편 집사)', patch: { routing: 'domain', reaskMin: Infinity, wrongAutoResolve: 0, agents: true, resolve: { hold: 0.8, env: 0.75, cell: 0.85, tech: 0.65 }, bodyReactMin: 0.5 } },
  { id: 'pull', label: '진짜 pull 풀(home=pool · 배정기)', patch: { assign: 'pull', assignLatencyMin: 1, visibleReady: 1, requestEveryMin: Infinity } },
  { id: 'supply', label: '만들 칸 공급(칸 kind · 영수 찾기 칸 → 만들기 칸)', patch: { supplyPerH: 14, makeShare: 0.8 } },
  { id: 'hold', label: 'HOLD 원장(ID·범위·만료) ⊕ 시험 우주 허용', patch: { holdMode: 'ledger', evidenceShare: 0.8, resolve: { hold: 0.6, env: 0.2, cell: 0.35, tech: 0.65 } } },
  { id: 'donewhen', label: 'done-when 필수 ⊕ 판정 집사 초록 닫기', patch: { doneWhenShare: 0.8, greenCloser: 0.95 } },
  { id: 'judge', label: '판정 집사 자동 결속(같은 head 영수)', patch: { judgeAutoShare: 0.7 } },
  { id: 'lanes', label: '핫파일 차선 ⊕ pregate 직전 merge', patch: { hotLanes: true, freshBase: true } },
  { id: 'controller', label: '처리량 제어기(버스트 호스트·슬롯·오래된 것 먼저)', patch: { controller: true } },
  { id: 'headroom', label: '헤드룸(버스트 호스트 상시 · 3량 열차 · 재작업 −40% · WIP 상한)', patch: { ...HEADROOM, hotLanes: true, controller: true } },
];

export function sensitivity(seeds: readonly number[]) {
  const run = (patch: Partial<Structure>, from: StructureId) => seeds.map((seed) => simulate({ structure: from, seed, patch }));
  const b1 = run({}, 'S1');
  const base = { landsPerH: mean(b1.map((x) => x.landsPerH)), greensPerH: mean(b1.map((x) => x.greensPerH)) };
  const single = LEVERS.map((l) => { const rs = run(l.patch, 'S1'); return { id: l.id, label: l.label, dLands: mean(rs.map((x) => x.landsPerH)) - base.landsPerH, dGreens: mean(rs.map((x) => x.greensPerH)) - base.greensPerH }; });
  // knock-out from S3: which lever, removed, hurts most (the binding one)
  const s1 = STRUCTURES.S1;
  const b3 = run({}, 'S3');
  const base3 = { landsPerH: mean(b3.map((x) => x.landsPerH)), greensPerH: mean(b3.map((x) => x.greensPerH)) };
  const knock = LEVERS.filter((l) => l.id !== 'headroom').map((l) => {
    const undo: Partial<Structure> = {};
    for (const k of Object.keys(l.patch) as (keyof Structure)[]) (undo as Record<string, unknown>)[k] = s1[k];
    const rs = run(undo, 'S3');
    return { id: l.id, label: l.label, dLands: mean(rs.map((x) => x.landsPerH)) - base3.landsPerH, dGreens: mean(rs.map((x) => x.greensPerH)) - base3.greensPerH };
  });
  // greedy rollout from S1: each step adds the lever with the largest gain in min(lands, greens)/10 (both targets at once)
  const greedy: { step: number; id: string; label: string; landsPerH: number; greensPerH: number }[] = [];
  let acc: Partial<Structure> = {};
  const left = [...LEVERS];
  const score = (rs: ReturnType<typeof run>) => Math.min(mean(rs.map((x) => x.landsPerH)), 10) + Math.min(mean(rs.map((x) => x.greensPerH)), 10) + 0.01 * mean(rs.map((x) => x.landsPerH));
  while (left.length) {
    let best = -1; let bestScore = -Infinity; let bestRs: ReturnType<typeof run> = [];
    left.forEach((l, i) => { const rs = run({ ...acc, ...l.patch }, 'S1'); const sc = score(rs); if (sc > bestScore) { bestScore = sc; best = i; bestRs = rs; } });
    const l = left.splice(best, 1)[0];
    acc = { ...acc, ...l.patch };
    greedy.push({ step: greedy.length + 1, id: l.id, label: l.label, landsPerH: mean(bestRs.map((x) => x.landsPerH)), greensPerH: mean(bestRs.map((x) => x.greensPerH)) });
  }
  return { base, single, base3, knock, greedy };
}

export function bodyTable(seeds: readonly number[]) {
  return BODY_VARIANTS.map((v: BodyVariant) => {
    const rs: BodyResult[] = seeds.map((seed) => simulateBodies(v, seed));
    const m: Record<string, number> = {};
    for (const k of ['latencyP50', 'latencyP95', 'latencyP95Slow', 'runsPerH', 'wastedPerH', 'wastedShare', 'missedPerDay', 'missedCap', 'missedNotIdle', 'llmPerH', 'spawnsPerH', 'cpuSecPerH', 'residentProcs', 'recoverMin', 'goalAttainment'] as const)
      m[k] = mean(rs.map((x) => x[k] as number));
    return { variant: v, m };
  });
}

/** Binding constraint of a structure: the busiest stage, or supply when ready is empty most of the time. */
export function bindingConstraint(row: Row): string {
  const stages: [string, number][] = [['손(hands)', row.m['util.hands']], ['pregate 호스트', row.m['util.pregate']], ['판정(JUD)', row.m['util.judge']], ['착지 슬롯', row.m['util.land']]];
  if (row.m.readyAvg < 1) return '칸 공급(ready≈0)';
  stages.sort((a, b) => b[1] - a[1]);
  return stages[0][0];
}

export function runAll(seedCount = 20) {
  const seeds = seedList(seedCount);
  const scen = scenarioTable(seeds);
  return {
    seeds: seedCount, target: TARGET, scenarios: scen.map((r) => ({ ...r, binding: bindingConstraint(r) })),
    calibration: calibration(seeds), stress: stressTable(seeds), helpers: helperTable(seedList(Math.min(seedCount, 10))),
    sensitivity: sensitivity(seedList(Math.min(seedCount, 10))), bodies: bodyTable(seedList(Math.min(seedCount, 10))),
    hourly: Object.fromEntries(SCENARIOS.map((id) => [id, Array.from({ length: 24 }, (_, h) => mean(seedList(Math.min(seedCount, 10)).map((seed) => simulate({ structure: id, seed }).hourlyLands[h])))])),
  };
}

if (import.meta.main) {
  const n = Number(process.argv[2] ?? 20);
  process.stdout.write(`${JSON.stringify(runAll(n), null, 1)}\n`);
}
