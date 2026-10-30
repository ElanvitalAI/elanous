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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateRunner, runGateNode, type GateRunner, type GateTools } from './gate-node';
import { withSimClock } from '../../src/ux-sim/fake-clock';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { runGraph } from '../../src/graph-runner/runner.js';
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

/** `timeout -k 10 <n> <cmd…>` → `<cmd…>`: the shell's own deadline math is real time; the fake Pod never waits. */
const FAKE_TIMEOUT = '#!/bin/bash\n[ "$1" = -k ] && shift 2\nshift\nexec "$@"\n';

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
  writeFileSync(join(repo, 'src/broken.test.ts'), "import { test } from 'bun:test';\ntest('breaks', () => { throw new Error('boom'); });\n");
  writeFileSync(join(repo, 'src/ok.test.ts'), "import { test } from 'bun:test';\ntest('works', () => {});\n");
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
        const home = join(root, `pod-home-${podCalls.length}`);
        mkdirSync(home, { recursive: true });
        const run = spawnSync('bash', ['-c', shell.replace(/^(pod_age|boot_age)=\$\(awk.*$/gm, (_line, name: string) => `${name}=0`)], {
          cwd: repo, encoding: 'utf8', timeout: 30_000,
          env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: home, GATE_SIM_FAIL_FILE: commit === CUT ? 'src/broken.test.ts' : '' },
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
          gatePodInstallSlots: 0, gatePodStallSeconds: 0, gatePodMidRunStallSeconds: 0 },
        deps: {
          root: instanceRoot,
          runBash: async (_body, opts) => {
            const rc = await runGateNode(['--json'], opts.env!, runner, undefined, () => IMAGE_DIGEST);
            return { exitCode: rc, stdout: JSON.stringify(emitted.at(-1) ?? {}), stderr: '' };
          },
        },
        }); } finally { process.chdir(previousCwd); }
      })();

      // ── the gate node transition, verbatim ──────────────────────────────────────────────────────────────
      expect(run.status).toBe('failed');
      expect(run.path).toEqual(['gate', 'failed']);
      const gateRecord = run.nodes.find((node) => node.nodeId === 'gate')!;
      expect(gateRecord).toMatchObject({ nodeId: 'gate', ok: false, exit: 1, executed: true });
      const line = emitted.at(-1)!;
      expect(line).toEqual({
        outcome: 'fail', verdict: 'fail', commit: CUT,
        introduced: [FAILURE], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [],
        autoheal: { action: 'hitl', cause: 'true-regression', signature: expect.any(String), shardKey: 'gate', reason: 'measured regression requires a human decision', shardElapsedMs: POD_SECONDS * 1000 * 3, overallElapsedMs: POD_SECONDS * 1000 * 3 },
        stalledEnv: [], rcNonzeroNoFailures: [],
        // ① exactly three Pods, each ninety seconds on the injected clock: no real (or global) clock produces this.
        durationMs: POD_SECONDS * 1000 * 3,
        baselineSource: 'instance', baselineCache: { hits: 0, misses: 1 }, selectionMs: 0,
        trainReceiptReuse: { carried: 0, total: 2, receipts: 0, reasons: ['gate receipt registry empty'] },
        summary: '게이트 regression: 1 new regressions · 환경 알려진 실패 0',
        executor: 'pod', host: null,
      });
      expect(JSON.parse(String(gateRecord.output))).toEqual(line);
      const progressPath = join(instanceRoot, 'graph-runs/release-loop', `${RUN_ID}.json.contexts/gate-progress.jsonl`);
      const progress = readFileSync(progressPath, 'utf8').trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>);
      expect(progress.some((event) => Array.isArray(event.groups)
        && (event.groups as Array<Record<string, unknown>>).some((group) => group.state === 'running' && group.elapsedMs === POD_SECONDS * 1000))).toBe(true);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((event) => event.runId === RUN_ID && event.executor === 'pod' && event.total === 1)).toBe(true);
      expect(progressLogSpy.mock.calls.some(([category, event, data]) => category === 'release-loop.gate' && event === 'progress'
        && (data as Record<string, unknown> | undefined)?.runId === RUN_ID)).toBe(true);

      // ── the Pod stage this scenario ran, and the ledger it left ────────────────────────────────────────
      expect(podCalls).toEqual([
        { commit: CUT, files: FILES }, { commit: CUT, files: ['src/broken.test.ts'] }, { commit: BASE, files: ['src/broken.test.ts'] },
      ]);
      expect(shells[0]).toContain("'./src/broken.test.ts'");
      const shard = JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-logs/cut/pod-0.json'), 'utf8')) as
        { durationMs: number; rc: number; files: string[]; commit: string };
      expect(shard).toMatchObject({ durationMs: POD_SECONDS * 1000, rc: 1, files: FILES, commit: CUT });
      expect(JSON.parse(readFileSync(join(instanceRoot, 'release/1.0.1/gate-verdict.json'), 'utf8')))
        .toMatchObject({ version: '1.0.1', commit: CUT, outcome: 'regression', introduced: [FAILURE], knownEnv: [] });
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
