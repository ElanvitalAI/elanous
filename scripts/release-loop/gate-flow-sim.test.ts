// GATE-FLOW-SIM — L2 대본 실행기. S1 (0.2.30 백업 shard 로그의 첫 사건): 컷 조각 하나가 실패를 보고하고, 격리
// 재확인이 그 실패를 그대로 재현하며, 기준선은 그 파일에서 깨끗하다 → gate 노드 verdict fail → 그래프 전이 gate → failed.
//
// 한 대본에서 세 장치가 동시에 물린다:
//   ① 저장소의 fake clock (`src/ux-sim/fake-clock.ts` · 새 시계를 발명하지 않는다) — Pod 의 벽시계가 이 시계로만 흐른다.
//   ② 가짜 Pod (`gate-pod-lifecycle.test.ts` 의 무대): 진짜 `gateShardShell` 을 fake `bun`/`timeout` 으로 돌려
//      outbox 를 만든다 — 조각 셸·부품 로그·junit·rc 는 생산 경로가 만든 것 그대로다.
//   ③ 가짜 kubectl/ssh/remoteRun: 호출을 세고, 실제 원격 호출은 0 이어야 한다(PATH tripwire 로도 확인).
//
// 생산 진입점은 그대로다: 그래프 노드 → deps.runBash → `runGateNode(['--json'], env, runner)`.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, runGateNode, type GateRunner, type GateTools } from './gate-node';
import { savePassingGateFileReceipts } from './gate-runtime';
import { withSimClock } from '../../src/ux-sim/fake-clock';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { runGraph } from '../../src/graph-runner/runner.js';
import { correlateGateLog } from '../../src/mss/logging/gate-correlation.js';
import { debug } from '../../src/debug/log.js';
import type { PodCommandResult, RunPodCommandOptions } from '../../src/task-orchestrator/surfaces/pod-command-job.js';

setDefaultTimeout(60_000);
const initialCwd = process.cwd();
afterEach(() => { if (process.cwd() !== initialCwd) process.chdir(initialCwd); });

const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const FILES = ['src/broken.test.ts', 'src/ok.test.ts'];
/** The one new failure this scenario reproduces — the S1 node transition's payload. */
const FAILURE = 'src/broken.test.ts > breaks';
const RUN_ID = 'run-1e3d9b2a-2ca0-4c29-8703-242f751c4c1d';
/** Wall time the fake Pod reports for every Job; the fake clock advances exactly this much per Pod. */
const POD_SECONDS = 90;
const SIM_EPOCH = Date.parse('2026-10-16T00:00:00.000Z');
const REPOSITORY_ROOT = join(import.meta.dir, '../..');

const dirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetElanousConfigDir();
});

/**
 * The fake Pod's tools: `bun install` succeeds and `bun run …` writes the junit the gate reads plus the console summary
 * it counts. `GATE_SIM_FAIL_FILE` is the one file this Job reports as failing — set by the fake Pod from the Job's
 * source binding, so the cut Jobs fail and the baseline Job passes without any clock or randomness.
 */
const FAKE_BUN = `#!/bin/bash
if [ "$1" = install ]; then echo "1 package installed [1ms]"; exit 0; fi
shift 2
files=(); out=
for a in "$@"; do
  case "$a" in
    --reporter-outfile=*) out="\${a#--reporter-outfile=}" ;;
    --*) ;;
    *) files+=("\${a#./}") ;;
  esac
done
fails=0
{ echo '<testsuites>'
  for f in "\${files[@]}"; do
    if [ "$GATE_SIM_FAIL_FILE" = "$f" ]; then
      printf '<testsuite name="%s" file="%s"><testcase name="breaks" file="%s"><failure message="boom"/></testcase></testsuite>\\n' "$f" "$f" "$f"
      fails=$((fails + 1))
    else
      printf '<testsuite name="%s" file="%s"><testcase name="works" file="%s"></testcase></testsuite>\\n' "$f" "$f" "$f"
    fi
  done
  echo '</testsuites>'
} > "$out"
for f in "\${files[@]}"; do
  if [ "$GATE_SIM_FAIL_FILE" = "$f" ]; then echo "$f:"; echo "(fail) breaks [1.00ms]"; fi
done
echo "$(( \${#files[@]} - fails )) pass"
echo "$fails fail"
echo "Ran \${#files[@]} tests across \${#files[@]} files."
[ "$fails" -eq 0 ]
`;

/** Strip GNU timeout options for both gate shards and bounded Git metadata reads. */
const FAKE_TIMEOUT = `#!/bin/bash
while :; do
  case "$1" in
    -k|--kill-after) shift 2 ;;
    --kill-after=*) shift ;;
    *) break ;;
  esac
done
shift
exec "$@"
`;

/** Any real kubectl/ssh child leaves a line here — the flow sim asserts this file never appears. */
const TRIPWIRE = `#!/bin/bash\necho "$(basename "$0") $*" >> "$GATE_SIM_TRIPWIRE"\nexit 97\n`;

function writeTools(bin: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bun'), FAKE_BUN);
  writeFileSync(join(bin, 'timeout'), FAKE_TIMEOUT);
  writeFileSync(join(bin, 'kubectl'), TRIPWIRE);
  writeFileSync(join(bin, 'ssh'), TRIPWIRE);
  for (const name of ['bun', 'timeout', 'kubectl', 'ssh']) chmodSync(join(bin, name), 0o755);
}

/** A checkout the gate's own shells can clone: the isolated parts really run `git clone --shared`. */
function fakeCheckout(repo: string): { base: string; cut: string } {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  mkdirSync(join(repo, 'apps/pwa/node_modules'), { recursive: true });
  writeFileSync(join(repo, 'apps/pwa/.sim-pwa'), '');
  mkdirSync(join(repo, 'scripts/release-loop'), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, 'scripts/release-loop/remote-worktree-setup.sh'), join(repo, 'scripts/release-loop/remote-worktree-setup.sh'));
  writeFileSync(join(repo, 'src/broken.test.ts'), "test('breaks', () => { throw new Error('boom'); });\n");
  writeFileSync(join(repo, 'src/ok.test.ts'), "test('works', () => {});\n");
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  expect(git('init', '-q').status).toBe(0);
  expect(git('add', '.').status).toBe(0);
  expect(git('-c', 'user.name=Sim', '-c', 'user.email=sim@example.invalid', 'commit', '-qm', 'base').status).toBe(0);
  const base = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(repo, '.sim-cut'), 'cut\n');
  expect(git('add', '.sim-cut').status).toBe(0);
  expect(git('-c', 'user.name=Sim', '-c', 'user.email=sim@example.invalid', 'commit', '-qm', 'cut').status).toBe(0);
  return { base, cut: git('rev-parse', 'HEAD').stdout.trim() };
}

test('GATE-FLOW-SIM S1: fake clock ⊕ fake Pod reproduce the gate node transition, and the real remote calls are 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-flow-sim-'));
  dirs.push(root);
  const repo = join(root, 'work', 'repo');
  const { base: BASE, cut: CUT } = fakeCheckout(repo);
  const instanceRoot = join(root, 'instance');
  mkdirSync(join(instanceRoot, 'release/1.0.0'), { recursive: true });
  writeFileSync(join(instanceRoot, 'release/1.0.0/release.json'), JSON.stringify({ sourceCommit: BASE }));
  // The previous release's measured baseline: clean — so the cut's one failure is new.
  writeFileSync(join(instanceRoot, 'release/1.0.0/gate-failures.json'), JSON.stringify({ commit: BASE, failures: [] }));
  setElanousConfigDir(instanceRoot);

  writeTools(join(root, 'bin'));
  const tripwire = join(root, 'real-remote-calls.log');

  // ③ the injected remote tools: they count, and they can never reach a cluster or a host.
  const kubectlCalls: string[][] = [];
  const kubectl: NonNullable<GateTools['kubectl']> = (args) => { kubectlCalls.push([...args]); return { status: 0, stdout: '', stderr: '' }; };
  const sshCalls: string[] = [];
  const ssh: NonNullable<GateTools['ssh']> = (host) => { sshCalls.push(host); return { rc: 255, output: 'ssh is not part of the flow sim' }; };
  const remoteRunCalls: string[] = [];
  const remoteRun: NonNullable<GateTools['remoteRun']> = (host) => { remoteRunCalls.push(host); return { status: 255, stdout: '', stderr: 'ssh is not part of the flow sim' }; };

  const previousPath = process.env.PATH;
  const previousTripwire = process.env.GATE_SIM_TRIPWIRE;
  process.env.PATH = `${join(root, 'bin')}:${previousPath ?? ''}`;
  process.env.GATE_SIM_TRIPWIRE = tripwire;
  try {
    // gateGitSync uses this GNU form on Linux. If the fake consumes only -k,
    // Git inventory reads silently fail and the file-CAS plan disappears.
    const boundedGit = spawnSync('timeout', ['--kill-after=1s', '5s', 'git', 'rev-parse', 'HEAD'],
      { cwd: repo, encoding: 'utf8' });
    expect(boundedGit.status).toBe(0);
    expect(boundedGit.stdout.trim()).toBe(CUT);
    const emitted: Array<Record<string, unknown>> = [];
    const progressLogSpy = spyOn(debug, 'log');
    spies.push(progressLogSpy);
    spies.push(spyOn(console, 'log').mockImplementation(((line?: unknown) => {
      if (typeof line !== 'string') return;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value)) emitted.push(value as Record<string, unknown>);
      } catch { /* not the node's result line */ }
    }) as typeof console.log));

    await withSimClock(SIM_EPOCH, async (clock) => {
      // ① the fake clock. Its epoch freezes the process clock for the whole run (no scenario needs real wall time), and
      // the gate's own clock starts there — every later second comes only from the Pods below, through the seam. The
      // global clock is never advanced, so a gate that read `Date.now` instead would measure 0 ms and this fails.
      let progressTick: (() => void) | undefined;
      let heartbeatTick: (() => void) | undefined;
      // ② the fake Pod: the production shard shell, fake bun/timeout, one artifacts dir per Job.
      const podCalls: Array<{ commit: string; files: string[] }> = [];
      const shells: string[] = [];
      const pod = async (o: RunPodCommandOptions): Promise<PodCommandResult> => {
        const shell = o.command[2]!;
        const commit = /attempt=%s\\n" '([0-9a-f]{40})'/.exec(shell)?.[1] ?? CUT;
        const files = [...new Set([...shell.matchAll(/'\.\/([^']+)'/g)].map((match) => match[1]!))]
          .filter((file) => FILES.includes(file));
        podCalls.push({ commit, files });
        shells.push(shell);
        // This Pod's wall time, in the gate's clock.
        clock.tick(POD_SECONDS * 1000);
        progressTick?.();
        heartbeatTick?.();
        const home = join(root, `pod-home-${podCalls.length}`);
        mkdirSync(home, { recursive: true });
        const run = spawnSync('bash', ['-c', shell.replace(/^(pod_age|boot_age)=\$\(awk.*$/gm, (_line, name: string) => `${name}=0`)], {
          cwd: repo, encoding: 'utf8', timeout: 30_000,
          env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home,
            GATE_SIM_FAIL_FILE: commit === CUT ? 'src/broken.test.ts' : '' },
        });
        if (run.status !== 0) throw new Error(`fake Pod shell failed (rc=${run.status}): ${run.stderr || run.stdout}`);
        return { exitCode: 0, artifactsDir: join(home, 'outbox'), job: `gate-flow-sim-${podCalls.length}` };
      };

      const command: GateRunner['command'] = async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: `${CUT}\n` };
        if (cmd === 'git' && args[0] === 'ls-files') {
          return { rc: 0, output: args.includes('-z') ? `${FILES.join('\0')}\0` : `${FILES.join('\n')}\n` };
        }
        if (cmd === 'rg') return { rc: 1, output: '' };
        return { rc: 0, output: '' };
      };

      // The seam: clock + fake Pod + fake kubectl/ssh + the shard admission. No positional fake and no pool override,
      // so the gate walks its own pool-readiness path (checkPodPool) through the injected kubectl.
      const runner = createGateRunner(repo, undefined, command, undefined, undefined, undefined,
        { now: () => clock.now(), podCommand: pod, kubectl, ssh, remoteRun,
          progressScheduler: (tick, intervalMs) => { expect(intervalMs).toBe(60_000); progressTick = tick; return () => { progressTick = undefined; }; },
          heartbeatScheduler: (tick, intervalMs) => { expect(intervalMs).toBe(60_000); heartbeatTick = tick; return () => { heartbeatTick = undefined; }; },
          podImageDigest: () => IMAGE_DIGEST,
          admission: { acquire: async () => () => {}, waitReason: () => null } });

      const graph = join(root, 'gate-flow-sim.yaml');
      writeFileSync(join(root, 'recipes.yaml'), 'gate:\n  command: "gate-node"\n');
      writeFileSync(graph, `graph_id: release-gate-flow-sim
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: agent, recipe: 'cmd:gate', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: done, fail: failed }
`);

      const run = await (async () => {
        const previousCwd = process.cwd();
        process.chdir(repo);
        try { return await runGraph(graph, {
        runId: RUN_ID,
        pinChildUniverse: true,
        input: { commit: CUT, version: '1.0.1', previousVersion: '1.0.0', gatePodPool: 'pool-sim:1', gatePodShards: 1,
          gateImagePin: 'cut-commit',
          gatePodInstallSlots: 0, gatePodStallSeconds: 0, gatePodMidRunStallSeconds: 0 },
        deps: {
          root: instanceRoot,
          runBash: async (_body, opts) => {
            const previousProgressFile = process.env.ELANOUS_GATE_PROGRESS_FILE;
            if (opts.env?.ELANOUS_GATE_PROGRESS_FILE) process.env.ELANOUS_GATE_PROGRESS_FILE = opts.env.ELANOUS_GATE_PROGRESS_FILE;
            let rc: number;
            try { rc = await runGateNode(['--json'], opts.env!, runner, undefined, () => IMAGE_DIGEST); }
            finally {
              if (previousProgressFile === undefined) delete process.env.ELANOUS_GATE_PROGRESS_FILE;
              else process.env.ELANOUS_GATE_PROGRESS_FILE = previousProgressFile;
            }
            return { exitCode: rc, stdout: JSON.stringify(emitted.at(-1) ?? {}), stderr: '' };
          },
        },
        }); } finally { process.chdir(previousCwd); }
      })();

      // ── the gate node transition, verbatim ──────────────────────────────────────────────────────────────
      expect(run.status).toBe('failed');
      expect(run.path).toEqual(['gate', 'failed']);
      const phaseNames = progressLogSpy.mock.calls
        .filter(([category, event]) => category === 'release-loop.gate' && typeof event === 'string' && event.startsWith('phase-'))
        .map(([, event]) => String(event).slice('phase-'.length));
      const correlationFields = ['runId', 'invocation', 'batch', 'shard', 'attempt', 'phase', 'host', 'podJob', 'file', 'evidenceLevel'];
      const correlatedGateEvents = debug.events(500).filter((event) => event.category === 'release-loop.gate'
        && (event.data as Record<string, unknown> | undefined)?.runId === RUN_ID);
      expect(correlatedGateEvents.length).toBeGreaterThan(0);
      expect(correlatedGateEvents.filter((event) => {
        const data = event.data as Record<string, unknown> | undefined;
        return !data || correlationFields.some((field) => !Object.hasOwn(data, field));
      })).toEqual([]);
      expect(correlatedGateEvents.some((event) => event.event === 'phase-heartbeat'
        && typeof (event.data as Record<string, unknown> | undefined)?.phase === 'string')).toBe(true);
      for (const phaseName of ['shard-planning', 'shards-running', 'collection', 'classification', 'verdict'])
        expect(phaseNames).toContain(phaseName);
      expect(phaseNames.indexOf('shard-planning')).toBeLessThan(phaseNames.indexOf('shards-running'));
      expect(phaseNames.indexOf('collection')).toBeLessThan(phaseNames.indexOf('classification'));
      expect(phaseNames.indexOf('classification')).toBeLessThan(phaseNames.indexOf('verdict'));
      const gateRecord = run.nodes.find((node) => node.nodeId === 'gate')!;
      expect(gateRecord).toMatchObject({ nodeId: 'gate', ok: false, exit: 1, executed: true });
      const line = emitted.at(-1)!;
      const { autoheal: reportedAutoheal, formalReceiptDecision, ...reportedFields } = line;
      const { signature, ...reportedAutohealFields } = reportedAutoheal as Record<string, unknown>;
      expect(({ ...reportedFields, autoheal: reportedAutohealFields }) as Record<string, unknown>).toEqual({
        outcome: 'fail', verdict: 'fail', commit: CUT,
        introduced: [FAILURE], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [],
        autoheal: { action: 'hitl', cause: 'true-regression', shardKey: 'gate', reason: 'measured regression requires a human decision', shardElapsedMs: POD_SECONDS * 1000 * 3, overallElapsedMs: POD_SECONDS * 1000 * 3 },
        stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [], abortedShards: 0, rcNonzeroNoFailures: [],
        reusedWarmPods: 0,
        // ① exactly three Pods, each ninety seconds on the injected clock: no real (or global) clock produces this.
        durationMs: POD_SECONDS * 1000 * 3,
        baselineSource: 'instance', baselineCache: { hits: 0, misses: 1 }, selectionMs: 0,
        // The exact-file CAS planner is active even with no prior receipts: both uncovered files rerun, with no fallback reason.
        trainReceiptReuse: { source: 'file-cas', carried: 0, total: 2, remeasure: 2, selectedFiles: 2,
          receipts: 0, receiptKeys: [], reasons: [], reasonCounts: {}, planReasons: [] },
        summary: '게이트 regression: 1 new regressions · 환경 알려진 실패 0 · 재활용 웜 Pod 0',
        executor: 'pod', host: null,
      });
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
      expect(formalReceiptDecision).toBe('formal-receipt-set-absent');
      expect(JSON.parse(String(gateRecord.output))).toEqual(line);
      const progressPath = join(instanceRoot, 'graph-runs/release-loop', `${RUN_ID}.json.contexts/gate-progress.jsonl`);
      const progress = readFileSync(progressPath, 'utf8').trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>);
      expect(progress.some((event) => Array.isArray(event.groups)
        && (event.groups as Array<Record<string, unknown>>).some((group) => group.state === 'running' && group.elapsedMs === POD_SECONDS * 1000))).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((event) => event.runId === RUN_ID && event.executor === 'pod' && event.total === 1)).toBe(true);
      expect(progressLogSpy.mock.calls.some(([category, event, data]) => category === 'release-loop.gate' && event === 'progress'
        && (data as Record<string, unknown> | undefined)?.runId === RUN_ID)).toBe(true);
      expect(progressLogSpy.mock.calls.some(([category, event, data]) => category === 'release-loop.gate'
        && event === 'entry-guard-evaluated'
        && (data as Record<string, unknown> | undefined)?.path === 'graph'
        && (data as Record<string, unknown> | undefined)?.decision === 'allow')).toBe(true);

      // ── the Pod stage this scenario ran, and the ledger it left ────────────────────────────────────────
      expect(podCalls).toEqual([
        { commit: CUT, files: FILES }, { commit: CUT, files: ['src/broken.test.ts'] }, { commit: BASE, files: ['src/broken.test.ts'] },
      ]);
      expect(shells[0]).toContain("'./src/broken.test.ts'");
      const shard = JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-logs/cut/pod-0.json'), 'utf8')) as
        { durationMs: number; rc: number; files: string[]; commit: string };
      expect(shard).toMatchObject({ durationMs: POD_SECONDS * 1000, rc: 1, files: FILES, commit: CUT });
      const fileReceiptDirectory = join(instanceRoot, 'release/1.0.1/gate-logs/cut/receipts/files');
      // The file CAS records measured outcomes, including failures; this cut must leave one receipt per test file.
      const fileReceipts = (existsSync(fileReceiptDirectory) ? readdirSync(fileReceiptDirectory) : [])
        .map((name) => JSON.parse(readFileSync(join(fileReceiptDirectory, name), 'utf8')) as { file: string; outcome: string })
        .map(({ file, outcome }) => ({ file, outcome })).sort((a, b) => a.file.localeCompare(b.file));
      expect(fileReceipts).toEqual([
        { file: 'src/broken.test.ts', outcome: 'fail' },
        { file: 'src/ok.test.ts', outcome: 'pass' },
      ]);
      expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-verdict.json'), 'utf8')))
        .toMatchObject({ version: '1.0.1', commit: CUT, outcome: 'regression', introduced: [FAILURE], knownEnv: [] });
      const ledgerPath = join(instanceRoot, 'release/1.0.1/gate-logs/shard-ledger.jsonl');
      const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>);
      const completedReceipt = [...ledgerRows].reverse().find((row) => row.state === 'done' && row.shardId === 'pod-0')!;
      expect(completedReceipt).toMatchObject({ invocationId: expect.any(String), reuseDecision: 'rerun' });
      const ledgerSummary = progressLogSpy.mock.calls.find(([category, event]) => category === 'release-loop.gate' && event === 'shard-ledger-summary');
      expect(ledgerSummary?.[2]).toMatchObject({ invocationId: completedReceipt.invocationId, disposition: { reused: 0, rerun: 1, unmeasured: 0 } });

    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTripwire === undefined) delete process.env.GATE_SIM_TRIPWIRE;
    else process.env.GATE_SIM_TRIPWIRE = previousTripwire;
  }

  // ── zero real remote calls: every kubectl call went to the injected client, and no ssh ran at all ────────
  expect(existsSync(tripwire) ? readFileSync(tripwire, 'utf8').trim().split('\n') : []).toEqual([]);
  expect(sshCalls).toEqual([]);
  expect(remoteRunCalls).toEqual([]);
  expect(kubectlCalls.length).toBeGreaterThan(0);
  expect(kubectlCalls.every((args) => args.includes('--context'))).toBe(true);
});

test('GATE-FLOW-SIM: an absent seam keeps the real tools — the production default is unchanged', () => {
  const runner = createGateRunner(process.cwd());
  expect(runner.now).toBe(Date.now);
  expect(runner.recheckPod).toBeFunction();
  expect(runner.recheckPodBatch).toBeFunction();
});

test('RELEASE-SIM-ALS-SUCCESS: successful in-process gate execution keeps its graph correlation scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-sim-als-success-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const graph = join(root, 'als-success.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'gate:\n  command: "bun scripts/release-loop/gate-node.ts --json"\n');
  writeFileSync(graph, `graph_id: release-loop
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: agent, recipe: 'cmd:gate', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: done, fail: failed }
`);

  const previousCwd = process.cwd();
  process.chdir(repo);
  const observations: Array<Record<string, unknown>> = [];
  const gateEnvironment: Array<{ runId?: string; batchId?: string; invocation?: string }> = [];
  let run: Awaited<ReturnType<typeof runGraph>>;
  try {
    run = await runGraph(graph, {
      runId: RUN_ID,
      pinChildUniverse: true,
      input: { commit: 'a'.repeat(40), version: '0.3.9-rc.1', previousVersion: '0.3.8',
        gateExecutor: 'pod', gatePodPool: 'pool-sim:1', gatePodShards: 1, gateImagePin: 'cut-commit' },
      deps: {
        root: join(root, 'instance'),
        runBash: async (_body, options) => {
          gateEnvironment.push({ runId: options.env?.ELANOUS_GRAPH_RUN_ID,
            batchId: options.env?.ELANOUS_BATCH_ID, invocation: options.env?.ELANOUS_GATE_INVOCATION });
          observations.push(correlateGateLog('release-loop.gate', 'runner-als-probe', { decision: 'allow' }) as Record<string, unknown>);
          return { exitCode: 0, stdout: '{"outcome":"ok"}', stderr: '' };
        },
      },
    });
  } finally { process.chdir(previousCwd); }

  expect(run!.status).toBe('done');
  expect(run!.path).toEqual(['gate', 'done']);
  expect(gateEnvironment).toHaveLength(1);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ runId: RUN_ID, invocation: gateEnvironment[0]?.invocation,
    batch: gateEnvironment[0]?.batchId, decision: 'allow' });
});

test('RELEASE-SIM-REAL-GATE-ENTRY: graph launches the real gate CLI and records its graph-path guard decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-sim-real-gate-entry-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const instanceRoot = join(root, 'instance');
  mkdirSync(instanceRoot, { recursive: true });
  const graph = join(root, 'real-gate-entry.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'gate:\n  command: "bun scripts/release-loop/gate-node.ts --json"\n');
  writeFileSync(graph, `graph_id: release-loop
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: agent, recipe: 'cmd:gate', max_visits: 1 }
  - { node_id: residual-run, kind: agent, recipe: 'cmd:gate', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: done, fail: residual-run }
  - from: residual-run
    on: outcome
    map: { ok: done, fail: failed }
`);

  const previousCwd = process.cwd();
  process.chdir(repo);
  let run: Awaited<ReturnType<typeof runGraph>>;
  const gateEnvironment: Array<{ runId?: string; batchId?: string; invocation?: string }> = [];
  try {
    run = await runGraph(graph, {
      runId: RUN_ID,
      pinChildUniverse: true,
      input: { commit: 'a'.repeat(40), version: '0.3.7-rc.1', previousVersion: '0.3.6',
        gateExecutor: 'pod', gatePodPool: 'pool-sim:1', gatePodShards: 1, gateImagePin: 'cut-commit' },
      deps: {
        root: instanceRoot,
        runBash: async (_body, options) => {
          gateEnvironment.push({ runId: options.env?.ELANOUS_GRAPH_RUN_ID,
            batchId: options.env?.ELANOUS_BATCH_ID, invocation: options.env?.ELANOUS_GATE_INVOCATION });
          const bun = Bun.which('bun');
          if (!bun) throw new Error('Bun executable unavailable for real gate CLI simulation');
          const child = spawnSync(bun, [join(REPOSITORY_ROOT, 'scripts/release-loop/gate-node.ts'), '--json'], {
            cwd: repo, encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, ...options.env, ELANOUS_STATE_DIR: instanceRoot, ELANOUS_POD_POOL: 'pool-sim:1' },
          });
          return { exitCode: child.status ?? 2, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
        },
      },
    });
  } finally { process.chdir(previousCwd); }

  expect(run!.status).toBe('failed');
  expect(run!.path).toEqual(['gate', 'residual-run', 'failed']);
  const gateNode = run!.nodes.find((node) => node.nodeId === 'gate')!;
  const residualNode = run!.nodes.find((node) => node.nodeId === 'residual-run')!;
  expect(gateEnvironment).toHaveLength(2);
  expect(gateEnvironment[0]).toMatchObject({ runId: RUN_ID, batchId: gateNode.executionId });
  expect(gateEnvironment[1]).toMatchObject({ runId: RUN_ID, batchId: residualNode.executionId });
  expect(typeof gateEnvironment[0]?.invocation).toBe('string');
  expect(typeof gateEnvironment[1]?.invocation).toBe('string');
  expect(gateEnvironment[0]?.invocation).not.toBe(gateEnvironment[1]?.invocation);
  const debugDir = join(repo, '.elanous/debug');
  const events = readdirSync(debugDir).filter((name) => /^debug-.*\.log$/.test(name))
    .flatMap((name) => readFileSync(join(debugDir, name), 'utf8').trim().split('\n'))
    .filter(Boolean).map((line) => JSON.parse(line) as { category?: string; event?: string; data?: {
      runId?: string; invocation?: string; batch?: string; shard?: string | number | null; attempt?: string | number | null;
      phase?: string; host?: string | null; podJob?: string | null; file?: string | null; evidenceLevel?: string;
      path?: string; decision?: string;
    } });
  const invocationByBatch = new Map(gateEnvironment.map(({ batchId, invocation }) => [batchId, invocation]));
  const entryGuards = events.filter((event) => event.category === 'release-loop.gate' && event.event === 'entry-guard-evaluated');
  expect(entryGuards).toHaveLength(2);
  expect(entryGuards.every((event) => event.data?.runId === RUN_ID
    && event.data.invocation === invocationByBatch.get(event.data.batch)
    && event.data.path === 'graph' && event.data.decision === 'allow')).toBe(true);
  const graphGateEvents = events.filter((event) => event.category === 'release-loop.gate');
  expect(graphGateEvents.length).toBeGreaterThan(0);
  expect(graphGateEvents.every((event) => event.data?.runId === RUN_ID
    && typeof event.data.invocation === 'string' && event.data.invocation.length > 0
    && event.data.invocation === invocationByBatch.get(event.data.batch))).toBe(true);
  expect(String(gateNode.output)).toContain('host-not-in-pod-pool');
});

test('file receipt writer requires every file PASS ID and records fresh and carried heads atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-file-receipt-writer-sim-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const { base, cut } = fakeCheckout(repo);
  const passedIds = ['src/broken.test.ts > works', 'src/ok.test.ts > works'];
  const input = (receiptRoot: string, sourceHead40?: string, ids = passedIds) => ({
    repo, root: receiptRoot, files: FILES, commit: cut, ...(sourceHead40 ? { sourceHead40 } : {}),
    imageDigest: IMAGE_DIGEST, runs: [{ rc: 0, pass: ids.length, fail: 0, errors: 0, passedIds: ids }],
    shardId: 'pod-0', attempt: 1, host: 'sim-host', runtimeIdentity: { os: 'linux', bunVersion: 'sim' },
  });

  const freshRoot = join(root, 'fresh');
  expect(savePassingGateFileReceipts(input(freshRoot))).toBe(FILES.length);
  const fresh = readdirSync(join(freshRoot, 'files')).map((name) => JSON.parse(readFileSync(join(freshRoot, 'files', name), 'utf8')) as Record<string, unknown>);
  expect(fresh).toHaveLength(FILES.length);
  expect(fresh.every((receipt) => receipt.outcome === 'pass' && receipt.sourceHead40 === cut && !receipt.carriedToHead40)).toBe(true);

  const carriedRoot = join(root, 'carried');
  expect(savePassingGateFileReceipts(input(carriedRoot, base))).toBe(FILES.length);
  const carried = readdirSync(join(carriedRoot, 'files')).map((name) => JSON.parse(readFileSync(join(carriedRoot, 'files', name), 'utf8')) as Record<string, unknown>);
  expect(carried).toHaveLength(FILES.length);
  expect(carried.every((receipt) => receipt.outcome === 'pass' && receipt.sourceHead40 === base && receipt.carriedToHead40 === cut)).toBe(true);

  const incompleteRoot = join(root, 'incomplete');
  expect(savePassingGateFileReceipts(input(incompleteRoot, undefined, ['src/broken.test.ts > works']))).toBe(0);
  expect(existsSync(join(incompleteRoot, 'files'))).toBe(false);
});
