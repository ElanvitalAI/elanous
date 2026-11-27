// SIM-WORLD supervisors · the delegated bodies (decision 11-27 «3 planes: guardian = infra · land-steward = landing»):
//   SUP-MACROPHAGE    — the macrophage card reaps through the guardian reaper (real planReap) · a target the guardian already
//                       reaped is never reaped again · an unkillable orphan cards RES once.
//   SUP-REAP-OVERLAP  — guardian sanitize and the macrophage card on the same orphans, both orders: one kill per target.
//   SUP-TRAIN-MANAGER — the train-manager card proposes a lane pin for the land-steward policy pack (mail only) · a pinned
//                       lane is left alone · churn that outlives escalate_after_min cards TC once.
//   SUP-LANE-POLICY   — the land graph honours the pack: the real tickLand with the pack's order lands the pinned PR of a
//                       hot-file lane first; no pack → the body's own order (PR number).
// Five seeds per run (inside each scenario) · literal expectations (rule 11) · no network · no real process.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planReap, type Proc, type ReapCandidate } from '../../../guardian-agent/reaper.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, runGuardian, type GuardianPorts } from '../../../guardian-agent/body.js';
import { fileMemory as butlerFileMemory } from '../../../judge-butler/memory.js';
import { tickLand, type LandDeps, type LedgerRow, type PrInfo, type Receipt } from '../../../land-graph/land-graph.js';
import { loadLandPolicy, parseLandPolicy, pinOrder } from '../../../land-steward/policy.js';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentPorts } from '../../../loop-agent/runtime.js';
import { createBody as macrophageBody, type MacrophageDeps } from '../../../loop-agent/bodies/macrophage.js';
import { createBody as trainBody, type TrainManagerDeps } from '../../../loop-agent/bodies/train-manager.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [0, 1, 2, 3, 4].map(i => ctx.seed + i);
const T0 = Date.parse('2026-11-27T10:00:00Z');
const at = (min: number): Date => new Date(T0 + min * 60_000); // 출처: #delegates — minutes on the scenario clock (not a bound)

function ports(stateRoot: string, id: string, supervisor: string) {
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const p: AgentPorts = { memory: fileAgentMemory(stateRoot, id, supervisor), post: (key, to, body) => { if (posts.some(x => x.key === key)) return null; posts.push({ key, to, body }); return posts.length; }, beat: () => undefined, llm: null };
  return { p, posts };
}

// ── reaper world (real planReap · fake ps / kill / audit) ─────────────────────────────────────────────────────────────
function reaperWorld(seed: number, opts: { unkillable?: boolean; slowDeath?: boolean } = {}) {
  const HOST = 'node-b';
  const orphan = 4100 + seed; const youngOrphan = 4200 + seed; const seat = 4300 + seed;
  let procs: Proc[] = [
    { pid: orphan, ppid: 1, pgid: orphan, ageMs: 3 * 3_600_000, cpu: 40, command: `bun bin/elanous.mjs --state-root /tmp/sim-${seed} --tui` },
    { pid: youngOrphan, ppid: 1, pgid: youngOrphan, ageMs: 20 * 60_000, cpu: 5, command: `bun bin/elanous.mjs --state-root /tmp/young-${seed} --tui` },
    { pid: seat, ppid: 1, pgid: seat, ageMs: 9 * 3_600_000, cpu: 2, command: 'bun bin/elanous.mjs --tui' },
  ];
  const audit: Array<{ at: string; host: string; pid: number; by: string }> = [];
  let locked = false;
  const kills: Array<{ pid: number; by: string }> = [];
  const killAs = (by: string) => (host: string, cands: readonly ReapCandidate[]): { killed: number[]; skipped: number[] } => {
    if (opts.unkillable) return { killed: [], skipped: cands.map(c => c.pid) };
    const killed = cands.filter(c => procs.some(p => p.pid === c.pid)).map(c => c.pid);
    for (const pid of killed) kills.push({ pid, by });
    // slowDeath: SIGTERM sent, the process is still in `ps` a moment later (Terra #40447 must-fix 2 race)
    if (!opts.slowDeath) procs = procs.filter(p => !killed.includes(p.pid));
    void host;
    return { killed, skipped: [] };
  };
  const deps: MacrophageDeps = {
    hosts: () => [HOST], procs: () => procs, registry: () => [], self: () => new Set<number>(),
    plan: (ps, reg, nowMs, self) => planReap(ps, reg, nowMs, { self }),
    recentReaps: (nowMs) => new Set(audit.filter(a => nowMs - Date.parse(a.at) < 30 * 60_000).map(a => `${a.host}:${a.pid}`)),
    kill: (host, cand) => killAs('MACROPHAGE')(host, [cand]),
    audit: (row) => { audit.push(row as { at: string; host: string; pid: number; by: string }); },
    lock: (fn) => { if (locked) throw new Error('reaper lock held twice'); locked = true; try { return fn(); } finally { locked = false; } },
  };
  /** The REAL guardian sanitize (guardian-agent/body.ts runGuardian · step sanitize) with only ps / kill / audit faked. */
  const guardianSanitize = (now: Date, stateRoot: string) => {
    const gp: GuardianPorts = {
      memory: butlerFileMemory(stateRoot, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS }),
      kill: (host, cands) => killAs('GUARDIAN')(host, cands),
      writeRoute: () => {}, post: () => null,
      audit: (row) => { audit.push(row as { at: string; host: string; pid: number; by: string }); },
      reapLock: (fn) => deps.lock(fn),
      recentReaps: (nowMs) => deps.recentReaps(nowMs),
    };
    runGuardian({ now, probes: [], procs: new Map([[HOST, procs]]), registry: new Map(), ready: null, hands: null }, gp, new Set(['sanitize']));
  };
  return { HOST, orphan, youngOrphan, seat, deps, kills, audit, guardianSanitize };
}

// ── land world (real tickLand · fake gh / receipts / land) ────────────────────────────────────────────────────────────
const hx = (n: number): string => `${String(n).padStart(6, '0')}${'b'.repeat(34)}`;
function landWorld(stateRoot: string, prs: PrInfo[], order: LandDeps['order'] | undefined): { deps: LandDeps; landed: number[] } {
  const org = join(stateRoot, 'federation.yaml');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(org, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
  const landed: number[] = [];
  const receipt = (n: number, head: string): Receipt | null => (prs.some(p => p.number === n && p.head === head) ? { dir: `/r/${n}-${head.slice(0, 12)}-minim5`, head, host: 'minim5', focused: [`src/f${n}.test.ts`], rawDir: '', focusedExit: 0 } : null);
  const deps: LandDeps = {
    now: () => at(0), stateRoot, mode: 'live', slots: 4, org: { path: org },
    listPrs: async () => prs.filter(p => !landed.includes(p.number)).map(p => ({ ...p })),
    prNow: async (n) => { const p = prs.find(x => x.number === n); return p ? { ...p, state: landed.includes(n) ? 'MERGED' : p.state } : null; },
    receipt, olderReceiptHead: () => null, focused: () => ({ pass: 5, fail: 0 }), security: () => [],
    land: async (p) => { landed.push(p.number); return { rc: 0, text: 'merged' }; },
    post: () => {}, record: () => {},
    finisher: { launchPregate: () => ({ ok: true, pid: 9 }), alive: () => true, refresh: () => ({ result: 'error' }) },
    ...(order ? { order } : {}),
  };
  return { deps, landed };
}
const pr = (n: number, files: string[]): PrInfo => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files, headRef: `b${n}`, createdAt: '2026-11-27T05:00:00Z' });

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-MACROPHAGE',
    title: 'macrophage card → guardian reaper: the 3 h test-universe orphan is reaped once by exact PID (young orphan and seat untouched) · an unkillable orphan cards RES once',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const w = reaperWorld(seed);
        const root = join(ctx.universeRoot, `mac-s${seed}`);
        const card = loadCard('macrophage');
        const { p, posts } = ports(root, 'macrophage', 'RES');
        const body = macrophageBody({ stateRoot: root, card }, w.deps);
        const r1 = await tickAgent(card, body, p, at(0));
        const r2 = await tickAgent(card, body, p, at(31));
        if (JSON.stringify(r1.acted) !== JSON.stringify([`reap:node-b:${4100 + seed}`])) return fail('wrong-reap', `seed ${seed}: acted ${JSON.stringify(r1.acted)}`);
        if (JSON.stringify(w.kills) !== JSON.stringify([{ pid: 4100 + seed, by: 'MACROPHAGE' }])) return fail('wrong-kill', `seed ${seed}: ${JSON.stringify(w.kills)}`);
        if (r1.kpi !== 1 || r2.kpi !== 0) return fail('kpi-stuck', `seed ${seed}: kpi ${r1.kpi} → ${r2.kpi}`);
        if (!p.memory.cases(50).some(c => c.kind === 'tick' && c.why.includes('orphans_over_2h 1'))) return fail('kpi-line-missing', `seed ${seed}`);
        if (posts.length) return fail('in-policy-escalation', `seed ${seed}: ${JSON.stringify(posts)}`);
        // fault: the reaper cannot kill it → one card to RES after escalate_after_min
        const f = reaperWorld(seed, { unkillable: true });
        const fr = join(ctx.universeRoot, `mac-f${seed}`);
        const fp = ports(fr, 'macrophage', 'RES');
        const fb = macrophageBody({ stateRoot: fr, card }, f.deps);
        for (let i = 0; i < 6; i++) await tickAgent(card, fb, fp.p, at(i * 31));
        const cards = fp.posts.filter(x => x.key.startsWith('kpi-breach:'));
        if (cards.length !== 1 || cards[0]!.to !== 'RES') return fail('escalation', `seed ${seed}: ${JSON.stringify(cards.map(c => c.to))}`);
      }
      ctx.recorder.event('sup:macrophage', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-REAP-OVERLAP',
    title: 'the real guardian sanitize (runGuardian) and the macrophage card on the same orphan, both orders and a slow death (still in ps after SIGTERM), under the shared reaper lock: exactly one signal and one audit row per target',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('macrophage');
        // order A: guardian first, then the card
        const a = reaperWorld(seed);
        a.guardianSanitize(at(0), join(ctx.universeRoot, `ov-ga${seed}`));
        const ra = join(ctx.universeRoot, `ov-a${seed}`); const pa = ports(ra, 'macrophage', 'RES');
        const tA = await tickAgent(card, macrophageBody({ stateRoot: ra, card }, a.deps), pa.p, at(1));
        if (JSON.stringify(a.kills) !== JSON.stringify([{ pid: 4100 + seed, by: 'GUARDIAN' }]) || tA.acted.length) return fail('double-reap', `seed ${seed} A: kills ${JSON.stringify(a.kills)} · acted ${JSON.stringify(tA.acted)}`);
        // order B: the card first, then the guardian
        const b = reaperWorld(seed);
        const rb = join(ctx.universeRoot, `ov-b${seed}`); const pb = ports(rb, 'macrophage', 'RES');
        await tickAgent(card, macrophageBody({ stateRoot: rb, card }, b.deps), pb.p, at(0));
        b.guardianSanitize(at(1), join(ctx.universeRoot, `ov-gb${seed}`));
        if (JSON.stringify(b.kills) !== JSON.stringify([{ pid: 4100 + seed, by: 'MACROPHAGE' }])) return fail('double-reap', `seed ${seed} B: ${JSON.stringify(b.kills)}`);
        if (b.audit.filter(x => x.pid === 4100 + seed).length !== 1) return fail('double-audit', `seed ${seed} B: ${JSON.stringify(b.audit)}`);
        // order C (Terra #40447 must-fix 2): the card signals first and the orphan is STILL in ps when the guardian plans —
        // the guardian re-checks the shared audit inside the lock and skips it: one signal, one audit row
        const c = reaperWorld(seed, { slowDeath: true });
        const rc = join(ctx.universeRoot, `ov-c${seed}`); const pc = ports(rc, 'macrophage', 'RES');
        await tickAgent(card, macrophageBody({ stateRoot: rc, card }, c.deps), pc.p, at(0));
        c.guardianSanitize(at(1), join(ctx.universeRoot, `ov-gc${seed}`));
        if (JSON.stringify(c.kills) !== JSON.stringify([{ pid: 4100 + seed, by: 'MACROPHAGE' }])) return fail('double-signal', `seed ${seed} C: ${JSON.stringify(c.kills)}`);
        if (c.audit.filter(x => x.pid === 4100 + seed).length !== 1) return fail('double-audit', `seed ${seed} C: ${JSON.stringify(c.audit)}`);
      }
      ctx.recorder.event('sup:reap-overlap', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-TRAIN-MANAGER',
    title: 'train-manager card → land-steward: a hot-file storm (3 PRs · 2 churn refusals) → one pin proposal to TC (mail only) · a pinned lane is left alone · churn past escalate_after_min → TC once',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('train-manager');
        const file = `src/hot/f${seed}.ts`;
        const nums = [40401 + seed * 10, 40402 + seed * 10, 40403 + seed * 10];
        const prs = nums.map(n => pr(n, [file]));
        const rows = (min: number): LedgerRow[] => [
          { at: at(min - 20).toISOString(), pr: nums[2]!, head: 'old', mode: 'live', event: 'refused', cls: 'merge-conflict', why: 'x' },
          { at: at(min - 10).toISOString(), pr: nums[1]!, head: 'old', mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'x' },
        ];
        let clock = 0;
        const sent: string[] = [];
        const mails: Array<{ to: string; body: string }> = [];
        const deps = (pins: Array<{ file: string; prs: number[] }>, o: { gh?: false; mailDown?: true } = {}): TrainManagerDeps => ({
          readLedger: () => rows(clock), listPrs: async () => (o.gh === false ? null : prs), policy: () => ({ laneOrder: { mode: 'train', pins } }),
          post: (key, to, body) => { if (o.mailDown) return false; if (sent.includes(key)) return null; sent.push(key); mails.push({ to, body }); return sent.length; },
        });
        const root = join(ctx.universeRoot, `tm-s${seed}`); const { p, posts } = ports(root, 'train-manager', 'TC');
        const r = await tickAgent(card, trainBody({ stateRoot: root, card }, deps([])), p, at(0));
        if (JSON.stringify(r.acted) !== JSON.stringify([`propose-pin:lane:${file}`])) return fail('no-proposal', `seed ${seed}: ${JSON.stringify(r.acted)}`);
        if (sent.length !== 1 || !sent[0]!.startsWith(`train-pin:${file}:`)) return fail('wrong-proposal', `seed ${seed}: ${JSON.stringify(sent)}`);
        if (mails[0]?.to !== 'TC' || !mails[0].body.includes(`{ file: ${file}, prs: [`) || !mails[0].body.includes('policies.yaml')) return fail('proposal-body', `seed ${seed}: ${JSON.stringify(mails[0]).slice(0, 200)}`);
        // gh down: the churn KPI still comes from the land ledger (escalation not hidden) · no lane, no proposal
        const rg = join(ctx.universeRoot, `tm-gh${seed}`); const g = ports(rg, 'train-manager', 'TC');
        const rGh = await tickAgent(card, trainBody({ stateRoot: rg, card }, deps([], { gh: false })), g.p, at(0));
        if (rGh.kpi !== 2 || rGh.acted.length) return fail('gh-outage', `seed ${seed}: kpi ${rGh.kpi} acted ${JSON.stringify(rGh.acted)}`);
        // mail down: the proposal is a failure (recorded), never «already sent»
        const rm = join(ctx.universeRoot, `tm-md${seed}`); const md = ports(rm, 'train-manager', 'TC');
        const rMd = await tickAgent(card, trainBody({ stateRoot: rm, card }, deps([], { mailDown: true })), md.p, at(0));
        if (JSON.stringify(rMd.failed) !== JSON.stringify([`propose-pin:lane:${file}`])) return fail('mail-failure-hidden', `seed ${seed}: failed ${JSON.stringify(rMd.failed)} acted ${JSON.stringify(rMd.acted)}`);
        if (r.kpi !== 2 || !p.memory.cases(20).some(c => c.kind === 'tick' && c.why.includes('hot_file_churn_refusals 2'))) return fail('kpi-line', `seed ${seed}: kpi ${r.kpi}`);
        if (posts.length) return fail('in-policy-escalation', `seed ${seed}`);
        // pinned lane: nothing to propose
        const root2 = join(ctx.universeRoot, `tm-p${seed}`); const q = ports(root2, 'train-manager', 'TC');
        const r2 = await tickAgent(card, trainBody({ stateRoot: root2, card }, deps([{ file, prs: nums }])), q.p, at(0));
        if (r2.acted.length || r2.subjects !== 0) return fail('pinned-lane-touched', `seed ${seed}: ${JSON.stringify(r2.acted)}`);
        // churn that keeps coming (pinned or not) past escalate_after_min → one TC card
        const root3 = join(ctx.universeRoot, `tm-f${seed}`); const f = ports(root3, 'train-manager', 'TC');
        const b3 = trainBody({ stateRoot: root3, card }, deps([{ file, prs: nums }]));
        for (const m of [0, 31, 62, 93, 124]) { clock = m; await tickAgent(card, b3, f.p, at(m)); }
        const cards = f.posts.filter(x => x.key.startsWith('kpi-breach:'));
        if (cards.length !== 1 || cards[0]!.to !== 'TC') return fail('escalation', `seed ${seed}: ${JSON.stringify(cards.map(c => c.to))}`);
      }
      ctx.recorder.event('sup:train-manager', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-LANE-POLICY',
    title: 'land graph honours the land-steward policy pack: a pinned hot-file lane lands its pinned PR first; no pins (the shipped pack · mode train) or no pack → PR-number order exactly',
    async run(ctx) {
      if (!loadLandPolicy()) return fail('pack-missing', 'graphs/loop-agents/land-steward/policies.yaml did not parse');
      for (const seed of seedsOf(ctx)) {
        const file = `src/lane/l${seed}.ts`;
        const nums = [40501 + seed * 10, 40502 + seed * 10, 40503 + seed * 10];
        const prs = nums.map(n => pr(n, [file]));
        const pinned = [nums[2]!, nums[0]!, nums[1]!];
        const pack = parseLandPolicy(`lane_order:\n  mode: pr-number\n  pins:\n    - { file: ${file}, prs: [${pinned.join(', ')}] }\n`);
        if (!pack) return fail('pack-parse', `seed ${seed}`);
        const withPack = landWorld(mkdtempSync(join(ctx.universeRoot, `lp-a${seed}-`)), prs, pinOrder(pack) ?? undefined);
        await tickLand(withPack.deps);
        if (JSON.stringify(withPack.landed) !== JSON.stringify([nums[2]])) return fail('pin-not-honoured', `seed ${seed}: landed ${JSON.stringify(withPack.landed)} (want [${nums[2]}] — one per hot file per tick, pinned first)`);
        const noPack = landWorld(mkdtempSync(join(ctx.universeRoot, `lp-b${seed}-`)), prs, undefined);
        await tickLand(noPack.deps);
        if (JSON.stringify(noPack.landed) !== JSON.stringify([nums[0]])) return fail('default-order-changed', `seed ${seed}: landed ${JSON.stringify(noPack.landed)} (want [${nums[0]}])`);
        // Terra #40447 must-fix 1: the shipped pack (mode train · pins []) must not change a land run's order
        const shipped = pinOrder(loadLandPolicy());
        if (shipped !== null) return fail('mode-applied-globally', `seed ${seed}: the shipped pack without pins produced an order function`);
        const trainNoPins = pinOrder(parseLandPolicy('lane_order:\n  mode: train\n  pins: []\n'));
        if (trainNoPins !== null) return fail('mode-applied-globally', `seed ${seed}: mode train without pins produced an order function`);
      }
      ctx.recorder.event('sup:lane-policy', { seeds: 5 });
      return { ok: true };
    },
  },
];
