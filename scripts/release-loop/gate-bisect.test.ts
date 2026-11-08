import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../../src/debug/log.js';
import { advanceGateBisectCursor, firstParentCommitsBetween, foundGateBisectCommit, nextGateBisectCommit, planGateBisect, runGateBisect, runGateBisectLinear } from './gate-bisect.js';
import { evaluateGateBisectRun, runGateBisectSidecar } from './gate-bisect-sidecar.js';
import { GATE_NODE_SIM_SCENARIOS, judgeInjectedGateEvent } from './gate-node-sim.js';
import type { GateBisectPlan } from './gate-bisect.js';

const commits = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40)];

function samplePlan(ids = ['src/alpha.test.ts > failure', 'src/beta.test.ts > failure']) {
  return planGateBisect({ version: '0.3.6', baseCommit: 'a'.repeat(40), cutCommit: commits[3]!, firstParentCommits: commits,
    introducedIds: ids, basePass: true, cutFail: true, host: 'node-c' });
}

test('GATE-FAIL-BISECT-SIDECAR: plans only introduced files on a verified first-parent range and finds a midpoint', async () => {
  const result = samplePlan(['src/alpha.test.ts > first', 'src/alpha.test.ts > second', 'src/beta.test.ts > third']);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.files).toEqual(['src/alpha.test.ts', 'src/beta.test.ts']);
  let cursor = { low: 0, high: result.plan.commits.length };
  const failures = new Set([commits[1], commits[2], commits[3]]);
  const probes: string[] = [];
  while (nextGateBisectCommit(result.plan.commits, cursor)) {
    const commit = nextGateBisectCommit(result.plan.commits, cursor)!;
    probes.push(commit);
    cursor = advanceGateBisectCursor(cursor, result.plan.commits, failures.has(commit));
  }
  expect(foundGateBisectCommit(result.plan.commits, cursor)).toBe(commits[1]);
  expect(probes).toHaveLength(2);
  const linear = await runGateBisectLinear(result.plan, async (_file, commit) => commit === result.plan.baseCommit ? 'pass'
    : failures.has(commit) ? 'fail' : 'pass');
  expect(linear.findings[0]?.firstFailingCommit).toBe(commits[1]);
});

test('GATE-FAIL-BISECT-SIDECAR: refuses incomplete endpoints, unsafe paths, invalid history, and gate host', () => {
  const input = { version: '0.3.6', baseCommit: 'a'.repeat(40), cutCommit: commits[3]!, firstParentCommits: commits,
    introducedIds: ['src/alpha.test.ts > fails'], basePass: true, cutFail: true, host: 'node-b' };
  expect(planGateBisect(input)).toMatchObject({ ok: false, reason: 'bisect requires an eligible non-gate host' });
  expect(planGateBisect({ ...input, host: 'node-c', basePass: false })).toMatchObject({ ok: false });
  expect(planGateBisect({ ...input, host: 'node-c', introducedIds: ['../alpha.test.ts > fails'] })).toMatchObject({ ok: false });
  expect(planGateBisect({ ...input, host: 'node-c', firstParentCommits: [commits[0]!, commits[1]!] })).toMatchObject({ ok: false });
  expect(firstParentCommitsBetween([commits[3]!, commits[2]!, commits[1]!], 'a'.repeat(40), commits[3]!))
    .toMatchObject({ ok: false, reason: 'baseline is not a first-parent ancestor of cut' });
  expect(firstParentCommitsBetween([commits[3]!, commits[2]!, commits[1]!, 'a'.repeat(40)], 'a'.repeat(40), commits[3]!))
    .toEqual({ ok: true, commits: [commits[1]!, commits[2]!, commits[3]!] });
});

test('GATE-FAIL-BISECT-SIDECAR: actual sidecar evaluator transitions after three agreeing two-file runs without changing gate verdict', async () => {
  const yaml = parseYaml(readFileSync(resolve(import.meta.dir, '../../scenarios/ux-sim/release-sim-rig.yaml'), 'utf8')) as {
    cases: Array<{ id: string; fault?: { evidence?: { introducedFiles?: string[]; sidecar?: string } } }>;
  };
  const evidence = yaml.cases.find((item) => item.id === 'gate-three-new-regressions')?.fault?.evidence;
  expect(evidence).toMatchObject({ introducedFiles: ['scripts/release-loop/gate-node.test.ts', 'scripts/release-loop/gate-bisect.test.ts'], sidecar: 'gate-fail-bisect' });
  if (!evidence?.introducedFiles) throw new Error('release graph YAML is missing bisect regression evidence');
  const gateScenario = GATE_NODE_SIM_SCENARIOS.find((scenario) => scenario.id === 'reroute-planner-gate-regression')!;
  let launchedPlan: GateBisectPlan | undefined;
  let sidecarRecord: { status: string; ownerMailStatus: string; findings: Array<{ file: string; firstFailingCommit: string; ownerMail?: { status: string; ownerSeat: string | null } }>; ownerMail: Array<{ status: string; ownerSeat: string | null; landQueueEvidence: string }>; unmeasured: unknown[] } | undefined;
  const sentOwnerMail: Array<{ seat: string; body: string }> = [];
  const pendingBeforeOwnerMail: string[] = [];
  let modeState: { mode: string; agreements: number } | undefined;
  let gateVerdictBeforeSidecar: string | undefined;
  const gateVerdict = await judgeInjectedGateEvent(gateScenario, { introducedFiles: evidence.introducedFiles, onLaunch: async (rawInput, gateOutcome) => {
    gateVerdictBeforeSidecar = gateOutcome;
    const input = rawInput as { plan: GateBisectPlan; repo: string; ledger: string; path: string; runId: string;
      alternatePool: string; pod: { pool: string } };
    launchedPlan = input.plan;
    const modePath = join(input.ledger, 'release', input.plan.version, 'gate-bisect-mode.json');
    mkdirSync(dirname(modePath), { recursive: true });
    writeFileSync(modePath, JSON.stringify({ schema: 1, state: { mode: 'shadow', agreements: 0 } }));
    for (let index = 0; index < 3; index++) {
      await runGateBisectSidecar({ ...input, runId: `sim-run-${index}` }, async (_file, commit) =>
        commit === input.plan.baseCommit || commit === 'c'.repeat(40) ? 'pass' : 'fail', {
        resolveOwner: (finding) => ({ pullRequest: finding.file.includes('bisect') ? 401 : 402,
          owner: 'fake-github-owner', ownerSeat: finding.file.includes('bisect') ? 'TC' : 'OPT' }),
        ownerMail: { post: async (seat, body) => {
          pendingBeforeOwnerMail.push((JSON.parse(readFileSync(input.path, 'utf8')) as { ownerMailStatus: string }).ownerMailStatus);
          sentOwnerMail.push({ seat, body }); return { id: `sim-${sentOwnerMail.length}` };
        } },
      });
    }
    sidecarRecord = JSON.parse(readFileSync(input.path, 'utf8')) as typeof sidecarRecord;
    modeState = (JSON.parse(readFileSync(join(input.ledger, 'release', input.plan.version, 'gate-bisect-mode.json'), 'utf8')) as {
      state: { mode: string; agreements: number };
    }).state;
  } });
  if (gateVerdict.outcome !== 'regression') throw new Error(`judgeGate outcome=${gateVerdict.outcome}: ${gateVerdict.error ?? 'no error detail'}`);
  expect(launchedPlan?.files).toEqual([...evidence.introducedFiles].sort());
  expect(launchedPlan?.host).toBe('mshq');
  if (!launchedPlan) throw new Error('judgeGate did not launch the connected bisect sidecar');
  expect(sidecarRecord).toMatchObject({ status: 'complete', ownerMailStatus: 'delivered', unmeasured: [] });
  expect(sidecarRecord?.ownerMail).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'delivered', ownerSeat: 'TC', landQueueEvidence: expect.stringContaining('PR #401') }),
    expect.objectContaining({ status: 'delivered', ownerSeat: 'OPT', landQueueEvidence: expect.stringContaining('PR #402') }),
  ]));
  expect(sidecarRecord?.findings.every((item) => item.ownerMail?.status === 'delivered')).toBe(true);
  expect(sentOwnerMail).toHaveLength(2); // notices are sent only on the third run after operational transition
  expect(sentOwnerMail.some((item) => item.body.includes('land-queue 근거: gate-failure PR #401'))).toBe(true);
  expect(sentOwnerMail.some((item) => item.body.includes('bun test ./scripts/release-loop/gate-node.test.ts')
    && item.body.includes("worktree remove \"$tree\"' EXIT"))).toBe(true);
  expect(pendingBeforeOwnerMail).toEqual(['pending', 'pending']);
  expect(sidecarRecord?.findings.map(({ file, firstFailingCommit }) => ({ file, firstFailingCommit }))).toEqual([
    { file: 'scripts/release-loop/gate-bisect.test.ts', firstFailingCommit: launchedPlan.cutCommit },
    { file: 'scripts/release-loop/gate-node.test.ts', firstFailingCommit: launchedPlan.cutCommit },
  ]);
  expect(modeState).toEqual({ mode: 'operational', agreements: 3 });
  expect(gateVerdictBeforeSidecar).toBe(gateVerdict.outcome);
  expect(gateVerdict.outcome).toBe('regression');
  console.log(JSON.stringify({ gateVerdictBefore: gateVerdictBeforeSidecar, gateVerdictAfter: gateVerdict.outcome,
    sidecarStatus: sidecarRecord?.status, findings: sidecarRecord?.findings, mode: modeState }));
});

test('GATE-FAIL-BISECT-SIDECAR simulation: missing or corrupt mode state runs operational; corruption is logged', async () => {
  const gateScenario = GATE_NODE_SIM_SCENARIOS.find((scenario) => scenario.id === 'reroute-planner-gate-regression')!;
  for (const modeFile of ['missing', 'corrupt'] as const) {
    let modeState: { mode: string; agreements: number } | undefined;
    let findings: unknown[] | undefined;
    let unreadableEventSeen = false;
    const gateVerdict = await judgeInjectedGateEvent(gateScenario, { introducedFiles: ['scripts/release-loop/gate-bisect.test.ts'],
      onLaunch: async (rawInput) => {
        const input = rawInput as { plan: GateBisectPlan; repo: string; ledger: string; path: string; runId: string;
          alternatePool: string; pod: { pool: string } };
        const modePath = join(input.ledger, 'release', input.plan.version, 'gate-bisect-mode.json');
        if (modeFile === 'corrupt') {
          mkdirSync(dirname(modePath), { recursive: true });
          writeFileSync(modePath, '{ malformed mode state');
        }
        await runGateBisectSidecar({ ...input, runId: `sim-${modeFile}` }, async (_file, commit) =>
          commit === input.plan.baseCommit ? 'pass' : 'fail', {
          resolveOwner: () => ({ pullRequest: null, owner: null, ownerSeat: null }),
        });
        modeState = (JSON.parse(readFileSync(modePath, 'utf8')) as { state: { mode: string; agreements: number } }).state;
        findings = (JSON.parse(readFileSync(input.path, 'utf8')) as { findings: unknown[] }).findings;
        unreadableEventSeen = debug.events(500).some((event) => event.category === 'release-loop.gate'
          && event.event === 'bisect-mode-unmeasured'
          && (event.data as { reason?: string; path?: string } | undefined)?.reason === 'mode-state-unreadable'
          && (event.data as { path?: string } | undefined)?.path === modePath);
      } });
    expect(gateVerdict.outcome).toBe('regression');
    expect(modeState).toEqual({ mode: 'operational', agreements: 0 });
    expect(findings?.length).toBeGreaterThan(0);
    if (modeFile === 'corrupt') expect(unreadableEventSeen).toBe(true);
  }
});

test('GATE-FAIL-BISECT-SIDECAR: non-monotonic history stays shadow and uses the exact linear first failure', async () => {
  const plan = samplePlan(['src/alpha.test.ts > failure']);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  const measure = async (_file: string, commit: string) => commit === plan.plan.baseCommit ? 'pass'
    : commit === commits[0] || commit === commits[3] ? 'fail' : 'pass';
  const evaluation = await evaluateGateBisectRun(plan.plan, { mode: 'shadow', agreements: 0 }, measure);
  expect(evaluation.event).toBe('shadow');
  expect(evaluation.state.agreements).toBe(0);
  expect(evaluation.findings).toEqual([]);
  expect(evaluation.shadow.findings[0]?.firstFailingCommit).toBe(commits[3]);
  expect(evaluation.operational.findings[0]?.firstFailingCommit).toBe(commits[0]);
});
