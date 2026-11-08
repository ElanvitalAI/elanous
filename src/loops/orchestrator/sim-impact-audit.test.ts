import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../../msg/msg-store.js';
import { debug } from '../../debug/log.js';
import { simulationProofFromGoal, hasCodeTarget, goalTargetPaths, unresolvedGoalTargets } from '../../self-dev/sim-impact-wording.js';
import { formatSimImpactGaps, runSimImpactAudit, simImpactGaps } from './sim-impact-audit.js';
import { collectWork, type WorkItem } from './overlap.js';
import { runOrchestratorNode, runSimImpactAuditWorker, simImpactAuditLogPath } from './tick.js';

const pr: WorkItem = {
  kind: 'pr', ref: '#35482', seat: 'TC', files: ['scripts/release-loop/gate-node.ts'], cells: ['SIM-IMPACT'],
};

test('goal wording requires a named proof scenario for code targets', () => {
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n구현한다.')).toBeUndefined();
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n증명 시나리오: gate-entry-image-pin')).toBe('gate-entry-image-pin');
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n증명 시나리오: TODO')).toBeUndefined();
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n신설 장치: gate-entry-image-pin fixture')).toBe('신설 장치: gate-entry-image-pin fixture');
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n신설 장치: 없음')).toBeUndefined();
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n신설 장치: `TODO`')).toBeUndefined();
  expect(simulationProofFromGoal('대상 경로: src/gate.ts\n신설 장치: ` TODO `')).toBeUndefined();
  expect(hasCodeTarget(['docs/guide.md'])).toBe(false);
  expect(hasCodeTarget(['src/gate.ts'])).toBe(true);
  expect(hasCodeTarget(['Sources/Gate.swift'])).toBe(true);
  expect(hasCodeTarget(['graphs/release/recipes.yaml'])).toBe(true);
  expect(hasCodeTarget(['src/'])).toBe(true);
  expect(hasCodeTarget(['src/gate-node.test.ts'])).toBe(false);
  expect(hasCodeTarget(['test/Gate.swift'])).toBe(false);
  expect(hasCodeTarget(['tools/release-check.sh'])).toBe(true);
  expect(unresolvedGoalTargets('대상 경로: src/new.ts · tests/new-suite/', ['src/gate.ts']))
    .toEqual(['src/new.ts', 'tests/new-suite/']);
  expect(goalTargetPaths('대상 경로: ./ · lib/', ['src/gate.ts', 'lib/worker.ts', 'docs/readme.md']))
    .toEqual(['lib/worker.ts', 'src/gate.ts']);
});

test('the existing live report node invokes the audit at 08 and 18 but not at 12', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-impact-orchestrator-'));
  try {
    for (const window of ['08', '12', '18'] as const) {
      const runId = `sim-impact-${window}`;
      const stateDir = join(root, 'loop', 'orchestrator');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
        runId, window, mode: 'live', day: '2026-11-07', cards: [], skippedCards: [], cells: [], placed: 0, delegated: 0,
        wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 }, steps: [], nodes: { reconcile: 'ok' }, missing: [],
      }));
      let audits = 0;
      await runOrchestratorNode('report', {
        root, runId, window, mode: 'live', now: new Date('2026-11-07T00:00:00.000Z'),
        coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }),
        directiveAudit: { readFile: () => null, listFiles: () => [], log: () => {} },
        simImpactAudit: () => { audits += 1; return []; },
        observe: () => {}, print: () => {},
      });
      expect(audits).toBe(window === '08' || window === '18' ? 1 : 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the live report node schedules its default census after the tick state is saved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-impact-orchestrator-deferred-'));
  const scheduled: string[] = [];
  try {
    for (const window of ['08', '12', '18'] as const) {
      const runId = `sim-impact-deferred-${window}`;
      const stateDir = join(root, 'loop', 'orchestrator');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
        runId, window, mode: 'live', day: '2026-11-07', cards: [], skippedCards: [], cells: [], placed: 0, delegated: 0,
        wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 }, steps: [], nodes: { reconcile: 'ok' }, missing: [],
      }));
      await runOrchestratorNode('report', {
        root, runId, window, mode: 'live', now: new Date('2026-11-07T00:00:00.000Z'),
        coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }),
        directiveAudit: { readFile: () => null, listFiles: () => [], log: () => {} },
        scheduleSimImpactAudit: (scheduledWindow, stateRoot) => {
          const state = JSON.parse(readFileSync(join(stateRoot, 'loop', 'orchestrator', `${runId}.json`), 'utf8')) as { nodes: Record<string, string> };
          expect(state.nodes.report).toBe('ok');
          scheduled.push(scheduledWindow);
          return { scheduled: true, logPath: 'test-log' };
        },
        observe: () => {}, print: () => {},
      });
    }
    expect(scheduled).toEqual(['08', '18']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the detached audit worker persists output and its exit code in file and debug logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-impact-worker-log-'));
  const logs = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const passCode = runSimImpactAuditWorker('08', root, 'worker-pass', () => simImpactGaps([pr]));
    const passLog = simImpactAuditLogPath(root, 'worker-pass');
    expect(passCode).toBe(0);
    expect(readFileSync(passLog, 'utf8')).toContain('"event":"exited"');
    expect(readFileSync(passLog, 'utf8')).toContain('"exitCode":0');
    expect(logs).toHaveBeenCalledWith('loop.orchestrator', 'sim-impact-audit-exited', expect.objectContaining({
      runId: 'worker-pass', exitCode: 0, gapCount: 1, logPath: passLog,
    }));

    const failCode = runSimImpactAuditWorker('18', root, 'worker-fail', () => { throw new Error('fixture audit failure'); });
    const failLog = simImpactAuditLogPath(root, 'worker-fail');
    expect(failCode).toBe(1);
    expect(readFileSync(failLog, 'utf8')).toContain('"exitCode":1');
    expect(readFileSync(failLog, 'utf8')).toContain('fixture audit failure');
    expect(logs).toHaveBeenCalledWith('loop.orchestrator', 'sim-impact-audit-exited', expect.objectContaining({
      runId: 'worker-fail', exitCode: 1, error: expect.stringContaining('fixture audit failure'), logPath: failLog,
    }), { level: 'error' });
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('the scheduled graph wires report into the existing 08/12/18 resident loop', () => {
  const graph = readFileSync('graphs/orchestrator/orchestrator.yaml', 'utf8');
  const recipes = readFileSync('graphs/orchestrator/recipes.yaml', 'utf8');
  expect(graph).toContain("cron: '0 8,12,18 * * *'");
  expect(graph).toMatch(/node_id: report[\s\S]*?recipe: cmd:orchestrator-report/);
  expect(recipes).toContain('orchestrator-report:');
  expect(recipes).toContain('tick.ts" report');
});

test('the coordinator report connects open PR collection to the OP message ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-impact-collect-report-'));
  try {
    const collected = collectWork({
      runGh: () => JSON.stringify([{
        number: 35482, title: '[TC] guard work', body: '코드 가드 변경', headRefName: 'tc/gate',
        files: [{ path: 'scripts/release-loop/gate-node.ts' }], isDraft: false, labels: [],
      }]),
      listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
      config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
    });
    const runId = 'sim-impact-collect-report';
    const stateDir = join(root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
      runId, window: '08', mode: 'live', day: '2026-11-07', cards: [], skippedCards: [], cells: [], placed: 0, delegated: 0,
      wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 }, steps: [], nodes: { reconcile: 'ok' }, missing: [],
    }));
    await runOrchestratorNode('report', {
      root, runId, window: '08', mode: 'live', now: new Date('2026-11-07T00:00:00.000Z'),
      coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }),
      directiveAudit: { readFile: () => null, listFiles: () => [], log: () => {} },
      simImpactAudit: (window, stateRoot) => runSimImpactAudit(window, stateRoot, { work: () => collected.work }),
      observe: () => {}, print: () => {},
    });
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      const messages = store.list('OP');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ from: 'ORCHESTRATOR', kind: 'report' });
      expect(messages[0]?.body).toContain('#35482');
      expect(messages[0]?.body).toContain('scripts/release-loop/gate-node.ts');
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a declared but absent PR scenario remains in the census', () => {
  const collected = collectWork({
    runGh: () => JSON.stringify([{
      number: 35483, title: '[TC] code work', body: '증명 시나리오: absent-scenario', headRefName: 'tc/work',
      files: [{ path: 'src/example.ts' }], isDraft: false, labels: [],
    }]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
    scenarioExists: () => false,
  });
  expect(collected.work[0]).toMatchObject({ proofScenario: 'absent-scenario', proofScenarioFound: false });
  expect(simImpactGaps(collected.work)).toMatchObject([{ ref: '#35483', reason: 'unknown-proof-scenario' }]);
});

test('all open PRs, including drafts and parked labels, remain in the observational census', () => {
  const collected = collectWork({
    includeNonReady: true,
    runGh: () => JSON.stringify([
      { number: 35485, title: '[TC] draft code', body: '', headRefName: 'tc/draft', files: [{ path: 'src/draft.ts' }], isDraft: true, labels: [] },
      { number: 35486, title: '[TC] parked code', body: '', headRefName: 'tc/parked', files: [{ path: 'scripts/parked.sh' }], isDraft: false, labels: [{ name: 'elanous:stalled' }] },
    ]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
  });
  expect(collected.work.map((item) => item.ref)).toEqual(['#35485', '#35486']);
  expect(simImpactGaps(collected.work).map((gap) => gap.ref)).toEqual(['#35485', '#35486']);
});

test('active goal census reads every declared code path including a directory target', () => {
  const collected = collectWork({
    runGh: () => '[]',
    listProcesses: () => ({ status: 'ok', records: [{
      pid: 1, ppid: 1, cpuPercent: 0, elapsedSeconds: 30, command: 'bun bin/elanous.mjs harness ask --file ASK-SIM.txt',
      cwd: '/repo', cwdStatus: 'observed' as const,
    }], excludedCount: 0 }),
    readGoal: () => '대상 경로: src/feature/\n대상 경로: scripts/run.sh\n0.3.7 칸 SIM-GOAL',
    listTrackedPaths: () => ['src/feature/one.ts', 'src/feature/two.ts', 'scripts/run.sh', 'docs/guide.md'],
    config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
  });
  expect(collected.work[0]).toMatchObject({ files: ['scripts/run.sh', 'src/feature/one.ts', 'src/feature/two.ts'], cells: ['SIM-GOAL'] });
  expect(simImpactGaps(collected.work)).toMatchObject([{ ref: 'ASK-SIM.txt', reason: 'missing-proof-scenario' }]);
});

test('an unresolved goal target remains visible when its proof scenario is valid', () => {
  const collected = collectWork({
    runGh: () => '[]',
    listProcesses: () => ({ status: 'ok', records: [{
      pid: 1, ppid: 1, cpuPercent: 0, elapsedSeconds: 30, command: 'bun bin/elanous.mjs harness ask --file ASK-SIM.txt',
      cwd: '/repo', cwdStatus: 'observed' as const,
    }], excludedCount: 0 }),
    readGoal: () => '대상 경로: src/missing.ts\n증명 시나리오: release-sim-rig-0241',
    listTrackedPaths: () => ['src/present.ts'],
    scenarioExists: (name) => name === 'release-sim-rig-0241',
    config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
  });
  expect(collected.work[0]).toMatchObject({ files: ['src/missing.ts'], unresolvedTargets: ['src/missing.ts'], proofScenario: 'release-sim-rig-0241', proofScenarioFound: true });
  expect(collected.work[0]?.proofScenarioFound).toBe(true);
  expect(simImpactGaps(collected.work)).toEqual([{
    kind: 'goal', ref: 'ASK-SIM.txt', seat: null, files: ['src/missing.ts'], cells: [], reason: 'unknown-target',
  }]);
});

test('an unresolved code target without a proof scenario reports both coverage gaps', () => {
  const work: WorkItem = {
    kind: 'goal', ref: 'ASK-UNKNOWN-CODE.txt', seat: null, files: [],
    unresolvedTargets: ['src/new-gate.ts'], cells: [],
  };
  expect(simImpactGaps([work])).toEqual([
    { kind: 'goal', ref: 'ASK-UNKNOWN-CODE.txt', seat: null, files: ['src/new-gate.ts'], cells: [], reason: 'unknown-target' },
    { kind: 'goal', ref: 'ASK-UNKNOWN-CODE.txt', seat: null, files: ['src/new-gate.ts'], cells: [], reason: 'missing-proof-scenario' },
  ]);
});

test('an unresolved code target with an unknown proof scenario reports both coverage gaps', () => {
  const work: WorkItem = {
    kind: 'goal', ref: 'ASK-UNKNOWN-SCENARIO.txt', seat: null, files: [],
    unresolvedTargets: ['src/new-gate.ts'], proofScenario: 'scenario-does-not-exist', proofScenarioFound: false, cells: [],
  };
  expect(simImpactGaps([work])).toEqual([
    { kind: 'goal', ref: 'ASK-UNKNOWN-SCENARIO.txt', seat: null, files: ['src/new-gate.ts'], cells: [], reason: 'unknown-target' },
    { kind: 'goal', ref: 'ASK-UNKNOWN-SCENARIO.txt', seat: null, files: ['src/new-gate.ts'], cells: [], reason: 'unknown-proof-scenario' },
  ]);
});

test('an unresolved non-code target does not create a proof-scenario gap', () => {
  const work: WorkItem = {
    kind: 'goal', ref: 'ASK-UNKNOWN-DOC.txt', seat: null, files: [],
    unresolvedTargets: ['docs/new-guide.md'], cells: [],
  };
  expect(simImpactGaps([work])).toEqual([
    { kind: 'goal', ref: 'ASK-UNKNOWN-DOC.txt', seat: null, files: ['docs/new-guide.md'], cells: [], reason: 'unknown-target' },
  ]);
});
test('a readable active goal without an extracted target is reported as an audit coverage gap', () => {
  const collected = collectWork({
    runGh: () => '[]',
    listProcesses: () => ({ status: 'ok', records: [{
      pid: 1, ppid: 1, cpuPercent: 0, elapsedSeconds: 30, command: 'bun bin/elanous.mjs harness ask --file ASK-NO-TARGET.txt',
      cwd: '/repo', cwdStatus: 'observed' as const,
    }], excludedCount: 0 }),
    readGoal: () => '활성 골: SIM-IMPACT 대상 확인',
    listTrackedPaths: () => ['src/unmentioned.ts', 'docs/guide.md'],
    config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
  });
  expect(collected.work[0]).toMatchObject({ kind: 'goal', ref: 'ASK-NO-TARGET.txt', files: [], cells: [] });
  const gaps = simImpactGaps(collected.work);
  expect(gaps).toEqual([{
    kind: 'goal', ref: 'ASK-NO-TARGET.txt', seat: null, files: [], cells: [], reason: 'missing-target',
  }]);
  expect(formatSimImpactGaps(gaps)).toContain('읽을 수 있는 골에서 추적 대상 경로를 추출하지 못함');
  const posted: string[] = [];
  expect(runSimImpactAudit('08', '/repo', { work: () => collected.work, post: (body) => posted.push(body) })).toEqual(gaps);
  expect(posted).toEqual([formatSimImpactGaps(gaps)]);
  expect(posted[0]).toContain('읽을 수 있는 골에서 추적 대상 경로를 추출하지 못함');
  expect(simImpactGaps([{ kind: 'pr', ref: '#empty', seat: null, files: [], cells: [] }])).toEqual([]);
});
test('a nested YAML kind is not mistaken for a simulator scenario id', () => {
  const collected = collectWork({
    runGh: () => JSON.stringify([{
      number: 35484, title: '[TC] code work', body: '증명 시나리오: click', headRefName: 'tc/work',
      files: [{ path: 'src/example.ts' }], isDraft: false, labels: [],
    }]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: { OP: [], MK: [], TC: [], UX: [] } },
  });
  expect(collected.work[0]).toMatchObject({ proofScenario: 'click', proofScenarioFound: false });
  expect(simImpactGaps(collected.work)).toMatchObject([{ ref: '#35484', reason: 'unknown-proof-scenario' }]);
});

test('the twice-daily audit lists only code work without a proof scenario', () => {
  const work: WorkItem[] = [
    pr,
    { ...pr, ref: '#proofed', proofScenario: 'gate-entry-image-pin', proofScenarioFound: true },
    { ...pr, ref: '#unknown-proof', proofScenario: 'scenario-that-is-not-in-repo', proofScenarioFound: false },
    { kind: 'goal', ref: 'docs-only.md', seat: 'MK', files: ['docs/guide.md'], cells: [] },
  ];
  const gaps = simImpactGaps(work);
  expect(gaps).toEqual([
    { kind: 'pr', ref: '#35482', seat: 'TC', files: ['scripts/release-loop/gate-node.ts'], cells: ['SIM-IMPACT'], reason: 'missing-proof-scenario' },
    { kind: 'pr', ref: '#unknown-proof', seat: 'TC', files: ['scripts/release-loop/gate-node.ts'], cells: ['SIM-IMPACT'], reason: 'unknown-proof-scenario' },
  ]);
  expect(formatSimImpactGaps(gaps)).toContain('시뮬 월드 미고려 (관측 후보 2)');
  expect(formatSimImpactGaps(gaps)).toContain('칸 SIM-IMPACT');
});

test('the resident audit posts at 08 and 18 and skips the noon tick', () => {
  const posted: string[] = [];
  let reads = 0;
  const deps = { work: () => { reads += 1; return [pr]; }, post: (body: string) => posted.push(body) };
  expect(runSimImpactAudit('12', '/tmp/state', deps)).toEqual([]);
  expect(reads).toBe(0);
  expect(runSimImpactAudit('08', '/tmp/state', deps)).toHaveLength(1);
  expect(runSimImpactAudit('18', '/tmp/state', deps)).toHaveLength(1);
  expect(reads).toBe(2);
  expect(posted).toHaveLength(2);
  expect(posted.every((body) => body.includes('#35482'))).toBe(true);
});

test('an unreadable active goal appears as unknown instead of disappearing', () => {
  expect(simImpactGaps([{ kind: 'goal', ref: 'goal.md', seat: null, files: [], cells: [], unreadable: true }]))
    .toEqual([{ kind: 'goal', ref: 'goal.md', seat: null, files: [], cells: [], reason: 'unreadable-goal' }]);
});

test('the production audit posts the list to the OP inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-impact-mail-'));
  try {
    runSimImpactAudit('08', root, { work: () => [pr] });
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.list('OP')).toMatchObject([{ from: 'ORCHESTRATOR', to: 'OP', kind: 'report' }]);
      expect(store.list('OP')[0]?.body).toContain('시뮬 월드 미고려');
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the twice-daily report also records an empty census', () => {
  const posted: string[] = [];
  expect(runSimImpactAudit('18', '/tmp/state', { work: () => [], post: (body) => posted.push(body) })).toEqual([]);
  expect(posted).toEqual(['시뮬 월드 미고려 (관측 후보 0)\n']);
});
