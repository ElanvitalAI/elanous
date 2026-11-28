// SIM-WORLD supervisors — SUPERVISORS-EXECUTE-NOT-PROPOSE (대표 11-28 17:3x «자동으로 돌아가게 = 루프 에이전트들이 본인 임무를 문제없이
// 해내는 것»). L4 measured 17:2x: train-manager / judge-butler / hand-steward DETECTED, then only mailed a coordinator who never
// acted — hot_file_churn_refusals 2 → 10/60 min · greens 4/h · idle hands with ready cells 4. Each scene drives the REAL body
// (the REAL runtime with the agent.yaml authority gate · the REAL runtime-pin kit · the REAL land graph · the REAL butler wake)
// with only the outside faked (gh · the hand pool · the claim door · the sim run · mail):
//   TRAIN-PIN   churn 2 on a hot lane → the pin is APPLIED (runtime pin · TTL) · TC gets one FYI line, no proposal · the land
//               graph walks it · 70 min on KPI 0 · past the TTL it is gone · a closed lane releases it
//   TRAIN-GUARD a wildcard HOLD → nothing applied (journal «held») · 6 hot lanes → 3 per tick (max_per_tick), 4 at most (pins_active_max)
//   HAND-CLAIM  a hint untaken 20 min (grace 15) → the steward claims the cell for the hand and wakes it once · no second hint · KPI 0
//   HAND-GUARD  a HOLD naming the cell → no hint, no claim · 4 untaken hints → 3 claims per tick (max_per_tick)
//   BUTLER-RUN  a criterion naming a sim scene without a receipt → the butler runs the scene itself and signs in the same tick ·
//               4 such cells → 3 runs per tick (e4_runs_per_tick), the 4th waits
//   BUTLER-GUARD a security-4 cell → JUD, never self-signed, no run · a cell a HOLD names → not signed, no run
//   BUTLER-FU-LINE a new FU cell has NO evidence — the first line is written (the old '' snapshot was refused every tick) ·
//               the done-when's test file is the E4 command when the title has none
//   BUTLER-FU-FALLBACK the FU line cannot be written at all (17:4x · 25 refusals «판정 FU 근거 줄 쓰기 실패») → the sign still lands,
//               the line rides on the parent's sign line («FU <cell>-E4: …» · revocable with the sign by a JUD veto)
// Five seeds per scene, both engines (legacy = the v2 step order with the agent.yaml card · graph = supervisorTick, the path
// the trigger runs). Expectations are independent literals (rule 11).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import type { Hold } from '../../../hold-ledger/hold-ledger.js';
import type { SimSummaryIn } from '../../../kit/requirement-judge/sim-evidence.js';
import { loadLivePolicy, readRuntimePins } from '../../../kit/lane-pins/index.js';
import { putRuntimePin, releaseRuntimePin } from '../../../kit/lane-pins/index.js';
import { classifyBoardRequirements } from '../../../kit/requirement-judge/index.js';
import { tickLand, type LedgerRow, type PrInfo } from '../../../land-graph/land-graph.js';
import { pinOrder } from '../../../land-graph/lane-order.js';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentBody, type AgentPorts, type TickReport } from '../../../loop-agent/runtime.js';
import { cardFromCompiled, lintSupervisor, supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { createBody as trainBody, type TrainManagerDeps } from '../../../loop-agent/bodies/train-manager.js';
import { createBody as handBody, type Cell, type Hand, type HandStewardDeps, type Hint } from '../../../loop-agent/bodies/hand-steward.js';
import { addItem, appendEvidenceLine, criterionEvidenceCommand, listChecklist, setItemIfSnapshot } from '../../../release-loop/checklist.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';
import { landWorld, pr } from './delegates.js';
import { head, row, same, wake, yellow } from './judge-binding.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [0, 1, 2, 3, 4].map(i => ctx.seed + i);
const T0 = Date.parse('2026-11-28T09:00:00Z');
const at = (min: number): Date => new Date(T0 + min * 60_000);

interface Rig { readonly p: AgentPorts; readonly posts: Array<{ key: string; to: string; body: string }> }
function rig(root: string, id: string, l0: string, holdOn?: (target: string) => string | null): Rig {
  const posts: Rig['posts'] = [];
  const p: AgentPorts = { memory: fileAgentMemory(root, id, l0), post: (key, to, body) => { if (posts.some(x => x.key === key)) return null; posts.push({ key, to, body }); return 800 + posts.length; },
    beat: () => undefined, llm: null, ...(holdOn ? { holdOn: (t: string) => holdOn(t) } : {}) };
  return { p, posts };
}
/** legacy = the v2 step order with the agent.yaml card (authority · policies) · graph = supervisorTick (the trigger's path). */
async function tick(engine: SimWorldEngine, id: string, body: AgentBody, p: AgentPorts, t: Date): Promise<TickReport> {
  const card = loadCard(id);
  if (engine === 'graph') return (await supervisorTick(card, body, p, t)).report;
  const c = lintSupervisor(id).compiled;
  if (!c) throw new Error(`${id} agent.yaml refused`);
  return tickAgent(cardFromCompiled(card, c), body, p, t, { policies: c.policies });
}
const scene = async (ctx: SimWorldScenarioContext, tag: string, body: (seed: number) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> => {
  for (const seed of seedsOf(ctx)) { const out = await body(seed); if (out) return out; }
  ctx.recorder.event(`sup:exec:${tag}`, { engine: ctx.engine, seeds: 5 });
  return { ok: true };
};

// ── train-manager world: open PRs on hot files ⊕ churn refusals 10 / 20 min before T0 ─────────────────────────────────
function trainWorld(root: string, lanes: ReadonlyArray<readonly number[]>, file: (i: number) => string) {
  let open = lanes.flatMap((nums, i) => nums.map(n => pr(n, [file(i)])));
  const rows: LedgerRow[] = lanes.flatMap(nums => [
    { at: at(-10).toISOString(), pr: nums[1]!, head: 'old', mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'x' } as LedgerRow,
    { at: at(-20).toISOString(), pr: nums[2] ?? nums[0]!, head: 'old', mode: 'live', event: 'refused', cls: 'merge-conflict', why: 'x' } as LedgerRow,
  ]);
  const deps: TrainManagerDeps = {
    readLedger: () => rows, listPrs: async () => open, policy: () => null,
    post: () => false, // the rig's runtime ports carry the agent's mail (the body's own FYI goes through deps.post — see below)
    runtimePins: nowMs => readRuntimePins(root, nowMs),
    putPin: (pin, nowMs) => { putRuntimePin(root, pin, nowMs); },
    releasePin: (f, nowMs) => releaseRuntimePin(root, f, nowMs),
  };
  return { deps, close: (keep: readonly number[]) => { open = open.filter(p => keep.includes(p.number)); }, prs: () => open as PrInfo[] };
}

// ── hand-steward world: idle hands ⊕ unowned ready cells ⊕ the claim door (claim = owner) ─────────────────────────────
function handWorld(n: number) {
  const hands: Hand[] = Array.from({ length: n }, (_, i) => ({ seat: `UX-H${i + 1}`, state: 'idle' as const, since: at(-40).getTime() }));
  const cells: Cell[] = Array.from({ length: n }, (_, i) => ({ id: `EXEC-SIM-${i + 1}`, title: `ready ${i + 1}`, status: 'yellow', priority: 'P0', paths: ['docs/sim.md'] }));
  const hints: Record<string, Hint> = {}; const mails: Array<{ key: string; to: string; body: string }> = []; const claims: string[] = []; const wakes: string[] = [];
  const deps: HandStewardDeps = {
    readHands: () => hands.slice(), readCells: () => ({ version: '0.3.39', cells: cells.slice() }), readHints: () => ({ ...hints }),
    hint: (cell, seat) => { hints[cell] = { seat, until: at(45).toISOString() }; },
    unhint: cell => { if (!hints[cell]) return false; delete hints[cell]; return true; },
    modelFor: () => ({ line: 'model: easy', tier: 'easy' }),
    post: (key, to, body) => { if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 600 + mails.length; },
    wake: (seat) => { wakes.push(seat); return 'wake typed'; },
    // the claim door (`eln work next` for this hand): its hinted cell first — the cell becomes the hand's
    claimFor: (seat) => {
      const cell = Object.entries(hints).find(([, h]) => h.seat === seat)?.[0];
      const c = cells.findIndex(x => x.id === cell);
      if (c < 0) return { ok: false, line: 'rc 3 — 일감 0' };
      cells[c] = { ...cells[c]!, owner: seat }; claims.push(`${cell}@${seat}`);
      return { ok: true, cell: cell!, line: 'work next' };
    },
    unclaim: (cell, seat) => { const c = cells.findIndex(x => x.id === cell && x.owner === seat); if (c < 0) return false; const { owner: _o, ...rest } = cells[c]!; void _o; cells[c] = rest; return true; },
  };
  return { deps, hints, mails, claims, wakes, cells };
}

const activeHold = (id: string, owner: string, cells: string[]): Hold => ({ id, owner, cells, reason: 'sim', unlock: 'expiry', createdAt: at(-5).toISOString(), createdBy: owner, expiresAt: at(240).toISOString(), state: 'active', narrowed: 0 });
/** One recorded sim run per seed for `scene` bound to <pr>-<head12> (the shape `eln --test sim world run` writes). */
const sceneRuns = (prN: number, sha: string, scenario: string): SimSummaryIn[] => [1, 2, 3, 4, 5].map(seed => ({
  runId: `${prN}-${sha.slice(0, 12)}-s${seed}`,
  summary: { schema: 'sim-world.summary/1', seed, engine: 'both', scenarios: (['legacy', 'graph'] as const).map(engine => ({ world: 'supervisors', scenario, engine, seed, expected: 'green', actual: 'pass', verdict: 'pass',
    diffFirstLine: null, observedReason: null, dir: `${scenario}/${engine}-s${seed}`, wallMs: 5 })) },
}) as SimSummaryIn);
const declared = (n: number, cell: string) => ({ pr: n, title: `fix(x): ${cell.toLowerCase()}`, body: `칸: ${cell} (0.3.39 P0 · owner TC)`, headRef: `fix/${cell.toLowerCase()}` });

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-EXEC-TRAIN-PIN',
    title: 'train-manager: churn 2 on a hot lane → the pin is APPLIED (runtime pin · TTL 120) with one FYI line to TC, no proposal · the land graph walks it · 70 min on KPI 0 · past the TTL it is gone · a closed lane releases it',
    async run(ctx) {
      return scene(ctx, 'train-pin', async (seed) => {
        const base = 40700 + seed * 10; const nums = [base + 1, base + 2, base + 3]; const file = `src/hot/x${seed}.ts`;
        const root = join(ctx.universeRoot, `tp-${ctx.engine}-${seed}`); mkdirSync(root, { recursive: true });
        const w = trainWorld(root, [nums], () => file);
        const mails: Array<{ key: string; to: string; body: string }> = [];
        const deps: TrainManagerDeps = { ...w.deps, post: (key, to, body) => { if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 700 + mails.length; } };
        const g = rig(root, 'train-manager', 'TC', () => null);
        const body = trainBody({ stateRoot: root, card: loadCard('train-manager') }, deps);
        const r0 = await tick(ctx.engine, 'train-manager', body, g.p, at(0));
        if (r0.kpi !== 2 || !same(r0.acted, [`apply-pin:lane:${file}`])) return fail('not-applied', `seed ${seed} ${ctx.engine}: kpi ${r0.kpi} acted ${JSON.stringify(r0.acted)} failed ${JSON.stringify(r0.failed)}`);
        const pins = readRuntimePins(root, at(1).getTime()).map(p => ({ file: p.file, prs: p.prs, until: p.until }));
        if (!same(pins, [{ file, prs: [base + 2, base + 3, base + 1], until: at(120).toISOString() }])) return fail('pin-row', `seed ${seed} ${ctx.engine}: ${JSON.stringify(pins)}`);
        if (mails.length !== 1 || mails[0]!.to !== 'TC' || !mails[0]!.key.startsWith('train-pin-applied:') || !mails[0]!.body.includes('회신 불필요')) return fail('fyi-mail', `seed ${seed} ${ctx.engine}: ${JSON.stringify(mails.map(m => [m.key, m.to]))}`);
        if (mails.some(m => m.key.startsWith('train-pin:'))) return fail('still-proposing', `seed ${seed} ${ctx.engine}`);
        // the land graph walks the runtime pin (no pack): the lane's pinned head lands first
        const lw = landWorld(join(root, 'land'), w.prs(), pinOrder(loadLivePolicy(root, at(1).getTime(), join(root, 'no-pack.yaml'))) ?? undefined);
        await tickLand(lw.deps);
        if (!same(lw.landed, [base + 2])) return fail('pin-not-walked', `seed ${seed} ${ctx.engine}: landed ${JSON.stringify(lw.landed)}`);
        const r1 = await tick(ctx.engine, 'train-manager', body, g.p, at(70));
        if (r1.kpi !== 0 || r1.acted.length) return fail('kpi-not-moved', `seed ${seed} ${ctx.engine}: kpi ${r1.kpi} acted ${JSON.stringify(r1.acted)}`);
        if (readRuntimePins(root, at(125).getTime()).length !== 0 || loadLivePolicy(root, at(125).getTime(), join(root, 'no-pack.yaml')) !== null) return fail('ttl-ignored', `seed ${seed} ${ctx.engine}`);
        // a second world: the lane closes (two of three merged) while the pin is live → release-pin
        const root2 = join(ctx.universeRoot, `tr-${ctx.engine}-${seed}`); mkdirSync(root2, { recursive: true });
        const w2 = trainWorld(root2, [nums], () => file); const g2 = rig(root2, 'train-manager', 'TC', () => null);
        const b2 = trainBody({ stateRoot: root2, card: loadCard('train-manager') }, { ...w2.deps, post: () => 1 });
        await tick(ctx.engine, 'train-manager', b2, g2.p, at(0));
        w2.close([base + 1]);
        const r2 = await tick(ctx.engine, 'train-manager', b2, g2.p, at(30));
        if (!same(r2.acted, [`release-pin:lane:${file}`]) || readRuntimePins(root2, at(31).getTime()).length !== 0) return fail('closed-lane-kept', `seed ${seed} ${ctx.engine}: ${JSON.stringify(r2.acted)}`);
        if (g.posts.some(p => p.key.startsWith('kpi-breach:'))) return fail('in-policy-escalation', `seed ${seed} ${ctx.engine}`);
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-TRAIN-GUARD',
    title: 'train-manager: an active wildcard HOLD → no pin (journal «held» · retried next tick) · 6 hot lanes → 3 pins per tick (max_per_tick) and 4 at most (pins_active_max)',
    async run(ctx) {
      return scene(ctx, 'train-guard', async (seed) => {
        const base = 40800 + seed * 100;
        const rootH = join(ctx.universeRoot, `th-${ctx.engine}-${seed}`); mkdirSync(rootH, { recursive: true });
        const wh = trainWorld(rootH, [[base + 1, base + 2, base + 3]], () => `src/held/h${seed}.ts`);
        const gh = rig(rootH, 'train-manager', 'TC', () => 'HOLD-OP-1 (OP · * · ~13:00Z)');
        const rh = await tick(ctx.engine, 'train-manager', trainBody({ stateRoot: rootH, card: loadCard('train-manager') }, { ...wh.deps, post: () => 1 }), gh.p, at(0));
        if (rh.acted.length || !(rh.deferred ?? []).some(d => d.includes('HOLD HOLD-OP-1'))) return fail('hold-ignored', `seed ${seed} ${ctx.engine}: acted ${JSON.stringify(rh.acted)} deferred ${JSON.stringify(rh.deferred)}`);
        if (readRuntimePins(rootH, at(1).getTime()).length || !gh.p.memory.cases(50).some(c => c.kind === 'act-held')) return fail('hold-wrote', `seed ${seed} ${ctx.engine}`);
        const rootC = join(ctx.universeRoot, `tc-${ctx.engine}-${seed}`); mkdirSync(rootC, { recursive: true });
        const lanes = [0, 1, 2, 3, 4, 5].map(i => [base + 10 + i * 3 + 1, base + 10 + i * 3 + 2, base + 10 + i * 3 + 3]);
        const wc = trainWorld(rootC, lanes, i => `src/cap/c${seed}-${i}.ts`);
        const gc = rig(rootC, 'train-manager', 'TC', () => null);
        const bc = trainBody({ stateRoot: rootC, card: loadCard('train-manager') }, { ...wc.deps, post: () => 1 });
        const counts: number[] = [];
        for (const m of [0, 5, 10]) counts.push((await tick(ctx.engine, 'train-manager', bc, gc.p, at(m))).acted.length);
        if (!same(counts, [3, 1, 0]) || readRuntimePins(rootC, at(11).getTime()).length !== 4) return fail('cap-ignored', `seed ${seed} ${ctx.engine}: acted per tick ${JSON.stringify(counts)} pins ${readRuntimePins(rootC, at(11).getTime()).length} (want [3,1,0] · 4)`);
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-HAND-CLAIM',
    title: 'hand-steward: hint at 0 · untaken at 10 (grace 15 · no second hint) · at 20 the steward claims the cell for the hand through the claim door and wakes it once · at 25 KPI 0',
    async run(ctx) {
      return scene(ctx, 'hand-claim', async (seed) => {
        const root = join(ctx.universeRoot, `hc-${ctx.engine}-${seed}`);
        const w = handWorld(1); const g = rig(root, 'hand-steward', 'OP', () => null);
        const body = handBody({ stateRoot: root, card: loadCard('hand-steward') }, w.deps);
        const r0 = await tick(ctx.engine, 'hand-steward', body, g.p, at(0));
        if (r0.kpi !== 1 || !same(r0.acted, ['assign:EXEC-SIM-1@UX-H1'])) return fail('no-hint', `seed ${seed} ${ctx.engine}: kpi ${r0.kpi} acted ${JSON.stringify(r0.acted)}`);
        const r1 = await tick(ctx.engine, 'hand-steward', body, g.p, at(10));
        const sent = (): number => w.mails.length; // re-read each time (TS narrows the property after a comparison)
        if (r1.acted.length || sent() !== 1) return fail('second-hint', `seed ${seed} ${ctx.engine}: acted ${JSON.stringify(r1.acted)} mails ${w.mails.length}`);
        const r2 = await tick(ctx.engine, 'hand-steward', body, g.p, at(20));
        if (!same(r2.acted, ['claim-for:EXEC-SIM-1@UX-H1']) || !same(w.claims, ['EXEC-SIM-1@UX-H1'])) return fail('not-claimed', `seed ${seed} ${ctx.engine}: acted ${JSON.stringify(r2.acted)} failed ${JSON.stringify(r2.failed)} claims ${JSON.stringify(w.claims)}`);
        if (w.hints['EXEC-SIM-1'] || sent() !== 2 || w.mails[1]!.to !== 'UX-H1' || !w.mails[1]!.body.includes('대신 잡음') || !same(w.wakes, ['UX-H1', 'UX-H1'])) return fail('claim-handoff', `seed ${seed} ${ctx.engine}: hints ${JSON.stringify(w.hints)} mails ${w.mails.length} wakes ${JSON.stringify(w.wakes)}`);
        const r3 = await tick(ctx.engine, 'hand-steward', body, g.p, at(25));
        if (r3.kpi !== 0 || r3.acted.length) return fail('kpi-not-moved', `seed ${seed} ${ctx.engine}: kpi ${r3.kpi} acted ${JSON.stringify(r3.acted)}`);
        if (!g.p.memory.cases(80).some(c => c.kind === 'act' && c.subject === 'claim-for:EXEC-SIM-1@UX-H1' && (c.extra as { undo?: string } | undefined)?.undo === 'unclaim EXEC-SIM-1@UX-H1')) return fail('journal-undo', `seed ${seed} ${ctx.engine}`);
        if (g.posts.some(p => p.key.startsWith('kpi-breach:'))) return fail('in-policy-escalation', `seed ${seed} ${ctx.engine}`);
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-HAND-GUARD',
    title: 'hand-steward: a HOLD naming the cell → no hint and no claim (journal «held») · 4 untaken hints → 3 claims per tick (max_per_tick)',
    async run(ctx) {
      return scene(ctx, 'hand-guard', async (seed) => {
        const rootH = join(ctx.universeRoot, `hh-${ctx.engine}-${seed}`);
        const wh = handWorld(1); const gh = rig(rootH, 'hand-steward', 'OP', t => (t.startsWith('EXEC-SIM-1@') ? 'HOLD-OP-2 (OP · EXEC-SIM-1 · ~13:00Z)' : null));
        const bh = handBody({ stateRoot: rootH, card: loadCard('hand-steward') }, wh.deps);
        const rh = await tick(ctx.engine, 'hand-steward', bh, gh.p, at(0));
        if (rh.acted.length || Object.keys(wh.hints).length || !(rh.deferred ?? []).some(d => d.includes('HOLD HOLD-OP-2'))) return fail('hold-ignored', `seed ${seed} ${ctx.engine}: acted ${JSON.stringify(rh.acted)} hints ${JSON.stringify(wh.hints)}`);
        const rootC = join(ctx.universeRoot, `hk-${ctx.engine}-${seed}`);
        const wc = handWorld(4); const gc = rig(rootC, 'hand-steward', 'OP', () => null);
        const bc = handBody({ stateRoot: rootC, card: loadCard('hand-steward') }, wc.deps);
        const a0 = await tick(ctx.engine, 'hand-steward', bc, gc.p, at(0));
        const a1 = await tick(ctx.engine, 'hand-steward', bc, gc.p, at(5));
        const a2 = await tick(ctx.engine, 'hand-steward', bc, gc.p, at(20));
        const kinds = [a0, a1, a2].map(r => r.acted.map(x => x.split(':')[0]!));
        if (!same(kinds, [['assign', 'assign', 'assign'], ['assign'], ['claim-for', 'claim-for', 'claim-for']]) || wc.claims.length !== 3) return fail('cap-ignored', `seed ${seed} ${ctx.engine}: ${JSON.stringify(kinds)} claims ${wc.claims.length}`);
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-BUTLER-RUN',
    title: 'judge-butler: a criterion naming a sim scene with no receipt → the butler runs the scene itself (5 seeds · both engines · bound to the PR head) and signs in the same tick · 4 such cells → 3 runs per tick, the 4th waits',
    async run(ctx) {
      return scene(ctx, 'butler-run', async (seed) => {
        const { stem, pr: base } = row(seed);
        const crit = 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록';
        const ids = ['A', 'B', 'C', 'D'].map(x => `${stem}-RUN${x}`);
        const summaries: SimSummaryIn[] = []; const runs: string[] = [];
        const out = await wake(ctx, `exec-run-${ctx.engine}-s${seed}`, ctx.engine, ids.map((id, i) => ({ ...yellow(id, `#${base + i}`), doneCriterion: crit })), ids.map((id, i) => declared(base + i, id)), [], undefined,
          { simSummaries: () => summaries },
          { ports: { runSimScene: (world, sc, n, sha) => { runs.push(`${world}/${sc}#${n}@${sha.slice(0, 12)}`); summaries.push(...sceneRuns(n, sha, sc)); return { rc: 0, out: 's1 rc 0 · s2 rc 0 · s3 rc 0 · s4 rc 0 · s5 rc 0' }; } } });
        const want = [0, 1, 2].map(i => `supervisors/JB-CRIT-EMPTY#${base + i}@${head(base + i).slice(0, 12)}`);
        if (!same(runs, want)) return fail('runs', `seed ${seed} ${ctx.engine}: ${JSON.stringify(runs)} (want ${JSON.stringify(want)})`);
        if (!same(out.signed, ids.slice(0, 3).sort())) return fail('not-signed', `seed ${seed} ${ctx.engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)}`);
        if (!out.evidence[ids[0]!]!.includes('sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0')) return fail('sign-line', `seed ${seed} ${ctx.engine}: ${out.evidence[ids[0]!]}`);
        if (out.refused[ids[3]!] !== '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary)') return fail('fourth', `seed ${seed} ${ctx.engine}: ${out.refused[ids[3]!] ?? 'no refusal'}`);
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-BUTLER-GUARD',
    title: 'judge-butler: a security-4 cell (src/els/server-auth.ts) → JUD, never self-signed, no run · a cell a registered HOLD names → not signed, no run',
    async run(ctx) {
      return scene(ctx, 'butler-guard', async (seed) => {
        const { stem, pr: base } = row(seed);
        const crit = 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록';
        const [sec, held] = [`${stem}-SEC4`, `${stem}-HELD`];
        const posts: Array<{ key: string; to: string }> = []; const runs: string[] = [];
        const out = await wake(ctx, `exec-guard-${ctx.engine}-s${seed}`, ctx.engine, [{ ...yellow(sec, `#${base}`), doneCriterion: crit }, { ...yellow(held, `#${base + 1}`), doneCriterion: crit }],
          [declared(base, sec), declared(base + 1, held)], [], undefined, { simSummaries: () => [] },
          { files: n => (n === base ? ['src/els/server-auth.ts'] : [`src/sim-${n}.ts`]), holds: [activeHold('HOLD-OP-3', 'OP', [held])],
            ports: { runSimScene: (_w, sc) => { runs.push(sc); return { rc: 0, out: '' }; }, post: (key, to) => { posts.push({ key, to }); return posts.length; } } });
        if (out.signed.length || runs.length) return fail('guard-broken', `seed ${seed} ${ctx.engine}: signed ${JSON.stringify(out.signed)} runs ${JSON.stringify(runs)}`);
        if (!same(posts.filter(p => p.key === `security:${sec}`).map(p => p.to), ['JUD'])) return fail('security-not-jud', `seed ${seed} ${ctx.engine}: ${JSON.stringify(posts)}`);
        const hw = out.why[held] ?? 'none';
        if (!hw.startsWith(`a registered HOLD names this cell — #${base + 1}@${head(base + 1).slice(0, 12)} ${base + 1}-${head(base + 1).slice(0, 12)}-`) || !hw.endsWith(' focused 7/0 · E4 없음 → FU')) return fail('hold-line', `seed ${seed} ${ctx.engine}: ${hw}`);
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-BUTLER-FU-LINE',
    title: 'judge-butler: a new FU cell has NO evidence — the first line is written (the old \'\' snapshot was refused «판정 중 칸 변경» every tick) · a done-when naming src/…/x.test.ts is the E4 command when the title has none',
    async run(ctx) {
      return scene(ctx, 'butler-fu-line', async (seed) => {
        const prev = getElanousConfigDirOverride();
        setElanousConfigDir(join(ctx.universeRoot, `fu-${ctx.engine}-${seed}`), 'programmatic');
        try {
          const v = '9.9.9'; const id = `EXEC-FU-${seed}-E4`; const line = `판정 미확인 부분 ${seed}: sim scene`;
          addItem(v, { id, title: `${id} — E4 FU`, priority: 'P2', source: 'judge-butler' });
          const before = listChecklist(v).items.find(i => i.id === id)!;
          let oldRefused = '';
          try { setItemIfSnapshot(v, id, { evidence: line }, 'JUDGE-BUTLER', { title: before.title, status: before.status, evidence: '' }); } catch (e) { oldRefused = e instanceof Error ? e.message : String(e); }
          if (!oldRefused.startsWith('판정 중 칸 변경')) return fail('old-snapshot', `seed ${seed} ${ctx.engine}: «${oldRefused}»`);
          if (!appendEvidenceLine(v, id, line, 'JUDGE-BUTLER') || listChecklist(v).items.find(i => i.id === id)!.evidence !== line) return fail('fu-line', `seed ${seed} ${ctx.engine}`);
          if (!appendEvidenceLine(v, id, line, 'JUDGE-BUTLER') || listChecklist(v).items.find(i => i.id === id)!.evidence !== line) return fail('fu-line-twice', `seed ${seed} ${ctx.engine}`);
          const cmd = criterionEvidenceCommand(`#40586 착지 · src/loop/cond-${seed}.test.ts focused 0 fail · condition-watch.test.ts · 합성 주입`);
          if (cmd !== `bun test src/loop/cond-${seed}.test.ts`) return fail('e4-command', `seed ${seed} ${ctx.engine}: ${cmd}`);
          if (criterionEvidenceCommand('focused 0 fail · 합성 주입') !== null) return fail('e4-command-none', `seed ${seed} ${ctx.engine}`);
          return null;
        } finally { resetElanousConfigDir(); if (prev) setElanousConfigDir(prev, 'programmatic'); }
      });
    },
  },
  {
    id: 'SUP-EXEC-BUTLER-FU-FALLBACK',
    title: 'judge-butler: the «<cell>-E4» FU line cannot be written → the sign is NOT refused · the line rides on the parent\'s sign line «FU <cell>-E4: 판정 미확인 — …» (revocable with the sign)',
    async run(ctx) {
      return scene(ctx, 'butler-fu-fallback', async (seed) => {
        const { stem, pr: base } = row(seed); const cell = `${stem}-NOLINE`;
        const uncited = async () => JSON.stringify({ requirements: [{ id: 'R1', classification: 'must', fulfilled: false, evidenceIds: [], reason: 'not shown', gap: 'not-shown', clause: '' }] });
        const out = await wake(ctx, `exec-fu-${ctx.engine}-s${seed}`, ctx.engine, [yellow(cell, `#${base}`)], [declared(base, cell)], [], undefined,
          { decomposeCriterion: async () => ({ trusted: true, requirements: [{ id: 'R1', text: 'core works', classification: 'must' }] }), judgeCriterion: input => classifyBoardRequirements(input, { callLLM: uncited }), fus: new Map() },
          { ports: { appendEvidence: () => false } });
        if (!same(out.signed, [cell]) || Object.keys(out.refused).length) return fail('fu-line-blocks-sign', `seed ${seed} ${ctx.engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)}`);
        if (!out.evidence[cell]!.includes(`FU ${cell}-E4: 판정 미확인 — `)) return fail('fu-memo', `seed ${seed} ${ctx.engine}: ${out.evidence[cell]}`);
        return null;
      });
    },
  },
];
