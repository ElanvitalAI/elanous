#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { diffFailures, junitFailures, parseFailures } from './gate-diff';
import { loadEnvKnownFailures, splitKnownEnv } from './env-known-failures';
import { baselineFromCutLogs } from './baseline-from-logs';
import { planShards, readFileDurations, readFileMemory } from './shard-plan';
import { deriveCdpTestPatterns } from '../test-deterministic';
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { runPodCommand, type RunPodCommandOptions, type PodCommandResult } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { POD_BUN_CACHE_HOST_PATH, parseInstallSeconds, podBunCacheVolume } from '../../src/task-orchestrator/surfaces/pod-bun-cache.js';
import { PodPoolScheduler, parsePodPool, checkPodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { defaultKubectl } from '../../src/task-orchestrator/surfaces/self-implement-pod.js';

interface CommandResult { rc: number; output: string; passedIds?: string[] }
export interface GateRunner {
  command(cmd: string, args: string[], cwd: string): Promise<CommandResult>;
  localCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult>;
  sweep(tree: string, logDir?: string, pod?: GateOptions['pod']): Promise<CommandResult>;
  add(tree: string, commit: string): Promise<void>;
  remove(tree: string): Promise<void>;
  snapshot(tree: string, commit: string): Promise<void>;
  removeSnapshot(tree: string): Promise<void>;
  /** Absolute remote bare mirror path, set before preparing the remote trees. */
  remoteMirror?: string;
}
export interface GateOptions {
  commit: string;
  version: string;
  baselineVersion?: string;
  baselineCommit?: string;
  remote?: string;
  remoteMirror?: string;
  instanceRoot?: string;
  ledgerRoot?: string;
  repo?: string;
  pod?: { pool: string; shards?: number; shardTimeoutSeconds?: number; durationSource?: string; bunCache?: string };
}
export interface GateResult {
  outcome: 'ok' | 'regression' | 'error';
  commit: string;
  introduced: string[];
  preexisting: number;
  fixed: number;
  knownEnv: number;
  knownEnvCleared: string[];
  baselineSource?: 'ledger' | 'instance' | 'cut-logs' | 'swept';
  durationMs: number;
  error?: string;
  stalledShards?: Array<{ shard: number; files: string[]; reason: 'incomplete' | 'no-output' | 'job-failed' | 'unattributed'; lastFile?: string; summaryFailures?: number; namedFailures?: number; detail?: string }>;
  partialSummary?: { pass: number; fail: number; errors: number; ran: number; files: number };
}

const sha = /^[0-9a-f]{7,40}$/i;
const versionPattern = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const failureFile = (root: string, version: string) => join(root, 'release', version, 'gate-failures.json');
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const defaultRemoteMirror = '~/mirror/elanous-agent.git';

function check(result: CommandResult, label: string): void {
  if (result.rc !== 0) throw new Error(`${label} failed (rc=${result.rc}): ${result.output.slice(-500)}`);
}

type SweepFailures = { failures: string[]; errors: string[] };

/** Only named, completed JUnit cases can prove a listed failure passed in this cut. */
function junitPassedIds(xml: string): string[] {
  const passed = new Set<string>();
  const suites: string[] = [];
  let file: string | undefined;
  let open: { id: string; passed: boolean } | undefined;
  const decode = (value: string) => value.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
    if (entity in named) return named[entity]!;
    const code = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
  for (const match of xml.matchAll(/<(\/?)\s*(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = match;
    const attr = (name: string) => { const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs!); return found ? decode(found[1]!) : undefined; };
    if (tag === 'testsuite') {
      if (closing) { suites.pop(); if (!suites.length) file = undefined; }
      else if (!selfClosing) { suites.push(attr('name') ?? ''); if (suites.length === 1) file = attr('file') ?? attr('name'); }
    } else if (tag === 'testcase') {
      if (closing) { if (open?.passed) passed.add(open.id); open = undefined; }
      else {
        const name = [...suites.slice(1), attr('name') ?? ''].join(' > ');
        const path = attr('file') ?? file;
        const id = path && name ? `${path} > ${name}` : undefined;
        if (selfClosing) { if (id) passed.add(id); }
        else open = id ? { id, passed: true } : undefined;
      }
    } else if (!closing && open) open.passed = false;
  }
  return [...passed].sort();
}
// A test may spawn a nested `bun test` whose own summary lines land earlier in the same output
// (09-29 0.2.4 gate: «0 fail · Ran 2 tests across 1 file» at line 6765 of a 60064-test sweep) —
// the sweep's own summary is always the «last» one, so read the last match, never the first.
const lastMatch = (output: string, pattern: RegExp): RegExpExecArray | null => {
  let last: RegExpExecArray | null = null;
  for (const m of output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) last = m as RegExpExecArray;
  return last;
};
const summaryCount = (output: string, label: string) => Number(lastMatch(output, new RegExp(`(?:^|\\n)\\s*(\\d+) ${label}s?\\s*(?=\\n|$)`))?.[1] ?? NaN);
/** bun reads a bare positional as a substring filter (`test` matches every *.test.ts); `./` makes it a path. */
const asPath = (path: string) => path.startsWith('./') || path.startsWith('/') ? path : `./${path}`;
export const POD_ISOLATION_MEMORY_LIMIT = '32Gi';
/** GT1b — a file whose measured peak is at least this runs alone at the isolation limit from the start: one such file
 *  sank a whole 203-file root shard at 16Gi (0.2.6 shard 12 · `unwired-exports` 9.9 GB) and cost two halving rounds. */
export const POD_HEAVY_FILE_MB = 4096;
/** Per-file peak memory, read from the cut tree (absent → no heavy files; the halving path still catches OOM). */
export const POD_MEMORY_SOURCE = 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv';
/** Integration tests that the Pod sweep does not run — each is judged by a real run elsewhere at the cut.
 *  0.2.7 run 5 (10-01): `scripts/install.test.ts` (real `bun pm pack` → `bun add` installs, 301 s alone on node-b)
 *  sat in a shard of its own past the 1200 s deadline with no output and stopped the whole gate. Judged on the
 *  mbp at the cut instead (TD1 moves it to the integration line). Keep this list short and explained. */
/** GT1 — files per retry chunk when a root shard fails (0.2.7: bundles of 54+ files OOMed at 16Gi, smaller passed). */
export const POD_SHARD_FILE_CAP = 27;

// review-model-ab: Pod 에서 출력 없이 멈춤 2/2(10-04 0.2.11 · 로컬 단독 4/0 · 1.7s) — GATE-STALL 수리 전까지 Pod 밖.
export const POD_SWEEP_INTEGRATION_ONLY: readonly string[] = ['scripts/install.test.ts', 'scripts/review-model-ab.test.ts'];
/** Nightly-only whole-repository cases; gate runs the fixture cases in these same files. */
export const GATE_NIGHTLY_AUDITS: readonly string[] = [
  // Replaces F12's real-repo bucket B apps/pwa scope check and its whole-repo export partition check.
  'test/f12-sweep.test.ts',
  // Replaces unwired-exports' real src/oauth caller check and its src/ad-pipeline CLI scan.
  'scripts/unwired-exports.test.ts',
  // Replaces pwa-build-typecheck's full root tsc and PWA tsc sweeps (PWA build also runs in the release loop).
  'test/pwa-build-typecheck.test.ts',
];
const tail40 = (output: string) => output.trimEnd().split(/\r?\n/).slice(-40).join('\n');
const lastStartedTestFile = (output: string, paths: string[]): string | undefined => {
  let last: string | undefined;
  for (const line of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)*[\w.-]+\.test\.tsx?):/.exec(line.trim());
    if (header && paths.includes(header[1]!)) last = header[1];
  }
  return last;
};

function failuresOf(run: CommandResult, label: string): SweepFailures {
  const output = run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const ran = lastMatch(output, /Ran (\d+) tests? across ([1-9]\d*) files?/);
  const reportedErrors = summaryCount(output, 'error');
  const errorCount = Number.isNaN(reportedErrors) ? 0 : reportedErrors;
  const incomplete = (reason: string) => new Error(`${label} incomplete (rc=${run.rc}; Ran=${ran ? ran[0] : 'missing'}; errors=${Number.isNaN(reportedErrors) ? 'missing' : errorCount}; ${reason})\n${tail40(output)}`);
  const count = summaryCount(output, 'fail');
  const failures = parseFailures(output);
  const occurrences = [...output.matchAll(/\(fail\)\s+.+?(?:\s+\[[\d.]+(?:ms|s)\])?\s*$/gm)].length;
  // A test that leaves process.exitCode set leaks a non-zero exit into a run whose own summary is complete and clean
  // (0.2.7 gate: agent-cli at v0.2.6 · 12 pass · 0 fail · rc 2). The summary is the verdict; read that exit as clean.
  const leakedExit = !!ran && run.rc !== 0 && run.rc !== 1 && count === 0 && errorCount === 0 && occurrences === 0
    && !/^# Unhandled error between tests/m.test(output);
  const rc = leakedExit ? 0 : run.rc;
  if (!ran || (Number(ran[1]) === 0 && errorCount === 0) || (rc !== 0 && rc !== 1)) throw incomplete('summary/exit');
  // Bun reports file-level unhandled errors separately from test failures.
  const errors: string[] = [];
  let file: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):/.exec(raw.trim());
    if (header) file = header[1];
    if (/^# Unhandled error between tests/.test(raw.trim())) {
      if (!file) throw incomplete('unattributed unhandled error');
      errors.push(`${file} > [error]`);
      file = undefined;
    }
  }
  if (errors.length !== errorCount) throw incomplete(`error attribution identified=${errors.length}`);
  if (!Number.isFinite(count) || count !== occurrences || (count > 0 && failures.length === 0)
    || (rc === 1 && count === 0 && errorCount === 0) || (rc === 0 && count + errorCount > 0)) {
    throw incomplete(`failure attribution incomplete: summary=${count}, identified=${failures.length}`);
  }
  return { failures, errors: [...new Set(errors)].sort() };
}

class StalledPodShards extends Error {
  constructor(readonly stalledShards: NonNullable<GateResult['stalledShards']>, readonly partialSummary: NonNullable<GateResult['partialSummary']>) {
    super(`pod sweep incomplete: stalled shards ${stalledShards.map(({ shard }) => shard).join(', ')}`);
  }
}

export function createGateRunner(repo: string, remote?: string, commandOverride?: GateRunner['command'], podCommand: (options: RunPodCommandOptions) => Promise<PodCommandResult> = runPodCommand, poolOverride?: PodPoolScheduler, podLogTail?: (job: PodCommandResult) => string): GateRunner {
  let remoteMirror: string | undefined;
  const localCommand: GateRunner['command'] = async (cmd, args, cwd) => {
    const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}` };
  };
  const command: GateRunner['command'] = commandOverride ?? (remote
    ? async (cmd, args, cwd) => {
      const run = spawnSync('ssh', [remote, `PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH; export PATH; cd ${quote(cwd)} && ${[cmd, ...args].map(quote).join(' ')}`],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}` };
    }
    : localCommand);
  const podSweep = async (tree: string, logDir: string | undefined, pod: NonNullable<GateOptions['pod']>): Promise<CommandResult> => {
    const shardCount = pod.shards ?? 24;
    const deadlineSeconds = pod.shardTimeoutSeconds ?? 1200;
    if (!pod.pool || !Number.isSafeInteger(shardCount) || shardCount < 1
      || !Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1) throw new Error('invalid pod sweep options');
    const head = await command('git', ['rev-parse', 'HEAD'], tree);
    check(head, 'cut tree HEAD');
    const commit = head.output.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid cut tree HEAD');
    const listed = await command('git', ['ls-files', '*.test.*'], tree);
    check(listed, 'git ls-files tests');
    const files = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file)).sort();
    if (files.some((file) => file.startsWith('-') || file.startsWith('/') || file.startsWith('./')
      || file.split('/').some((part) => !part || part === '.' || part === '..') || /[\r\n]/.test(file))) throw new Error('unsafe pod test path');
    if (new Set(files).size !== files.length) throw new Error('duplicate pod test path');
    if (!files.length) throw new Error('sweep incomplete: no tests ran');
    const cdp = await command('rg', ['-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'], tree);
    if (cdp.rc !== 0 && cdp.rc !== 1) throw new Error(`CDP pattern discovery failed (rc=${cdp.rc}): ${tail40(cdp.output)}`);
    const cdpPatterns = cdp.output.split(/\r?\n/).filter((path) => path.endsWith('.test.ts'));
    // CDP 시험은 `test:deterministic` 이 스스로 뺀다 — 조각에 그것만 남으면 bun «시험 없음» exit 1 을 «불완전»으로 읽었다(09-30 G1d 실측 둘).
    // bun 의 탐색은 숨은 디렉터리(`.x/`)를 안 연다 — 사람의 `bun test` 가 한 번도 안 돌리는 빈 픽스처가 조각에 혼자 남아 «Ran 0 tests» 를 «불완전»으로 읽었다(09-30 G1e 5번 조각).
    const assignable = files.filter((file) => !cdpPatterns.includes(file) && !POD_SWEEP_INTEGRATION_ONLY.includes(file)
      && !file.split('/').some((part) => part.startsWith('.')));
    const integrationOnly = files.filter((file) => POD_SWEEP_INTEGRATION_ONLY.includes(file));
    if (integrationOnly.length) debug.log('release-loop.gate', 'pod-sweep-integration-only', { files: integrationOnly });
    if (!assignable.length) throw new Error('sweep incomplete: no tests ran');
    const durations = pod.durationSource ? readFileDurations(pod.durationSource) : new Map<string, number>();
    const memory = readFileMemory(join(tree, POD_MEMORY_SOURCE));
    // The TD1 measurements predate the fixture-only gate; do not isolate those five files at their old 2–13 GB peaks.
    const fixtureOnly = new Set([...GATE_NIGHTLY_AUDITS, 'test/guardian/dispatch-surface-contract.test.ts', 'test/user-config-mcp.test.ts']);
    const heavy = new Set(assignable.filter((file) => !fixtureOnly.has(file) && (memory.get(file) ?? 0) >= POD_HEAVY_FILE_MB));
    const light = assignable.filter((file) => !heavy.has(file));
    const shards = [
      ...(light.length ? planShards(light, durations, shardCount) : []),
      ...[...heavy].map((file) => ({ files: [file], plannedSeconds: durations.get(file) ?? 0 })),
    ];
    if (heavy.size) debug.log('release-loop.gate', 'pod-heavy-alone', { files: [...heavy], thresholdMb: POD_HEAVY_FILE_MB, memoryLimit: POD_ISOLATION_MEMORY_LIMIT });
    const known = assignable.filter((file) => durations.has(file)).length;
    debug.log('release-loop.gate', 'pod-shard-plan', {
      shards: shards.length, known, unknown: assignable.length - known,
      maxPlannedSeconds: Math.max(...shards.map((shard) => shard.plannedSeconds)),
      source: durations.size ? pod.durationSource : 'none',
    });
    const ready = poolOverride ? undefined : checkPodPool(parsePodPool(pod.pool), defaultKubectl);
    if (ready && !ready.ok) throw new Error('pod command: 풀의 노드가 하나도 준비되지 않았다');
    const poolScheduler = poolOverride ?? new PodPoolScheduler(ready!.ready);
    const configCache = typeof pod.bunCache === 'string' ? pod.bunCache.trim() : '';
    const envCache = process.env[POD_BUN_CACHE_HOST_PATH]?.trim();
    const bunCache = configCache || envCache || undefined;
    debug.log('release-loop.gate', 'pod-bun-cache', { source: configCache ? 'config' : envCache ? 'env' : 'none' });
    const cachePrefix = bunCache ? `${podBunCacheVolume(bunCache).shellPrefix} ` : '';
    const jobLogTail = (job: PodCommandResult): string => {
      if (podLogTail) return podLogTail(job);
      for (const member of poolScheduler.members) {
        const logs = defaultKubectl(['--context', member.context, '-n', 'elanous-test', 'logs', `job/${job.job}`, '-c', 'child', '--tail=200']);
        if (logs.status === 0 && logs.stdout) return logs.stdout;
      }
      return '';
    };
    type ShardRun = { output: string; rc: number; pass: number; fail: number; errors: number; ran: number; files: number; passedIds: string[] };
    type ShardReason = NonNullable<GateResult['stalledShards']>[number]['reason'];
    // 깊이 끝 OOM 조각은 «조각 전체»를 파일 하나씩 격리한다 — 상한 40 이면 나머지가 못 잰 채 남았다(09-30 ① 7번 조각 110 파일).
    const isolationRemaining = shards.map((item) => item.files.length);
    const estimated = (paths: string[]) => paths.reduce((sum, file) => {
      const value = durations.get(file);
      return sum + (value !== undefined && Number.isFinite(value) && value >= 0 ? value : unknownSeconds);
    }, 0);
    const knownTimes = assignable.map((file) => durations.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const unknownSeconds = knownTimes.length ? (knownTimes[Math.floor((knownTimes.length - 1) / 2)]! + knownTimes[Math.floor(knownTimes.length / 2)]!) / 2 : 1;
    const runShard = async (paths: string[], shard: number, depth = 0, branch = '', retriedNoOutput = false): Promise<{ runs: ShardRun[]; stalled: NonNullable<GateResult['stalledShards']> }> => {
      const ignores = cdpPatterns.filter((pattern) => paths.includes(pattern))
        .flatMap((pattern) => ['--path-ignore-patterns', pattern]);
      // 파일별 소요는 junit 으로 남긴다 — 콘솔 요약(판정 원천)은 그대로이고, 느린 시험 목록(K10 D4)·계층 분리(D2)의 자가 된다.
      const args = ['bun', 'run', 'test:deterministic', ...ignores, ...paths.map(asPath)].map(quote).join(' ')
        + ' --reporter=junit --reporter-outfile="$HOME/outbox/junit.xml"';
      const start = Date.now();
      let output: string | undefined;
      let junit: string | undefined;
      let rc: number | undefined;
      let jobExitCode: number | undefined;
      let lastFile: string | undefined;
      let jobFailed = false;
      try {
        const job = await podCommand({
          pool: pod.pool, poolScheduler, clone: true, source: { kind: 'commit', sha: commit }, deadlineSeconds,
          ...(bunCache ? { bunCache } : {}),
          // 실패 뒤 다시 도는 파일 하나짜리 Job 은 메모리 한도를 올린다 — 16Gi 에선 무거운 한 파일이 혼자서도 OOM 이었다(09-30 `unwired-exports`).
          ...(paths.length === 1 && (depth >= 1 || heavy.has(paths[0]!)) ? { memoryLimit: POD_ISOLATION_MEMORY_LIMIT } : {}),
          name: `gate-${randomUUID()}`,
          command: ['bash', '-lc', `mkdir -p "$HOME/outbox"; ${cachePrefix}(cd .. && cd repo && bun install && (cd apps/pwa && bun install) && ${args}) 2>&1 | tee "$HOME/outbox/shard.log"; echo \${PIPESTATUS[0]} > "$HOME/outbox/shard.rc"`],
        });
        jobExitCode = job.exitCode;
        const logPath = join(job.artifactsDir, 'shard.log');
        const rcPath = join(job.artifactsDir, 'shard.rc');
        output = existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined;
        const junitPath = join(job.artifactsDir, 'junit.xml');
        junit = existsSync(junitPath) ? readFileSync(junitPath, 'utf8') : undefined;
        const rcText = existsSync(rcPath) ? readFileSync(rcPath, 'utf8').trim() : '';
        rc = /^\d+$/.test(rcText) && Number.isSafeInteger(Number(rcText)) ? Number(rcText) : undefined;
        lastFile = output === undefined ? undefined : lastStartedTestFile(output, paths);
        if (!lastFile && (job.exitCode !== 0 || rc === undefined || (rc !== 0 && rc !== 1))) {
          try { lastFile = lastStartedTestFile(jobLogTail(job).split(/\r?\n/).slice(-200).join('\n'), paths); }
          catch { /* Log retrieval is diagnostic; do not hide the stalled shard. */ }
        }
      } catch {
        jobFailed = true;
      }
      const durationMs = Date.now() - start;
      if (logDir) {
        mkdirSync(logDir, { recursive: true });
        const destination = join(logDir, `pod-${shard}${branch}.log`);
        if (output !== undefined) writeFileSync(destination, output, { mode: 0o600 });
        else rmSync(destination, { force: true });
        writeFileSync(join(logDir, `pod-${shard}${branch}.json`), JSON.stringify({ durationMs, rc: rc ?? null, files: paths, plannedSeconds: estimated(paths), shardCount: shards.length, commit }) + '\n', { mode: 0o600 });
        const junitDestination = join(logDir, `pod-${shard}${branch}.junit.xml`);
        if (junit !== undefined) writeFileSync(junitDestination, junit, { mode: 0o600 });
        else rmSync(junitDestination, { force: true });
      }
      debug.log('release-loop.gate', 'pod-shard', { shard, files: paths, durationMs, rc: rc ?? null, attempt: depth + 1, installSeconds: parseInstallSeconds(output ?? '') });
      let clean = output?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const ran = clean && lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/);
      const passes = clean === undefined ? NaN : summaryCount(clean, 'pass');
      const fails = clean === undefined ? NaN : summaryCount(clean, 'fail');
      let reason: ShardReason | undefined;
      let namedFailures: number | undefined;
      let unattributedDetail: string | undefined;
      if (jobFailed || (jobExitCode !== undefined && jobExitCode !== 0) || (rc !== undefined && rc !== 0 && rc !== 1)) reason = 'job-failed';
      else if (!clean || rc === undefined) reason = 'no-output';
      else if (!ran || !Number.isFinite(passes) || !Number.isFinite(fails)
        || Number(ran[2]) === 0 || Number(ran[2]) > paths.length || Number(ran[1]) === 0) reason = 'incomplete';
      else {
        try {
          const attributed = failuresOf({ rc, output: clean }, `pod-${shard} shard`);
          if (attributed.failures.length !== fails) reason = 'unattributed';
        } catch (error) {
          reason = 'unattributed';
          // 어떤 수가 어긋났는지(요약·이름·오류 귀속) 첫 줄을 싣는다 — 수만으론 원인 파일을 못 찾았다(09-30 ① 1번 조각).
          unattributedDetail = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.slice(0, 300);
        }
        if (reason === 'unattributed') namedFailures = [...clean.matchAll(/\(fail\)\s+.+?(?:\s+\[[\d.]+(?:ms|s)\])?\s*$/gm)].length;
        // 콘솔 요약은 실패를 세는데 `(fail)` 이름 줄이 하나도 없으면 같은 조각의 junit 에서 이름을 가져온다
        // (10-01 0.2.6 게이트: `--dots` 로 도는 한 파일 조각이 이름 없이 끝나 게이트 전체가 error 로 멈췄다).
        if (reason === 'unattributed' && namedFailures === 0 && junit) {
          const named = junitFailures(junit);
          if (named.length === fails) {
            const patched = `${clean}\n${named.map((id) => { const cut = id.indexOf(' > '); return `${id.slice(0, cut)}:\n(fail) ${id.slice(cut + 3)}`; }).join('\n')}\n`;
            try {
              if (failuresOf({ rc, output: patched }, `pod-${shard} shard`).failures.length === fails) {
                clean = patched;
                reason = undefined;
                debug.log('release-loop.gate', 'pod-shard-junit-attribution', { shard, files: paths, failures: named });
              }
            } catch { /* 그래도 못 맞추면 원래대로 멈춘다 */ }
          }
        }
      }
      if (reason === 'no-output' && !retriedNoOutput) {
        const retry = await runShard(paths, shard, depth, `${branch}-retry`, true);
        debug.log('release-loop.gate', 'pod-shard-retry', { shard, files: paths, reason, outcome: retry.stalled[0]?.reason ?? 'ok' });
        return retry;
      }
      if (reason) {
        // 깊이 2 에서 «이름 없는 실패»·«불완전»도 파일 단위로 가른다 — 아니면 149파일 조각의 실패 하나가 끝까지 주인 없이 남는다(09-30 G1e 7번 조각: 요약 28 · 이름 27).
        // 로그 없이 죽은 조각(`no-output` · OOM)도 같다 — 09-30 G1f ② 4-0-0 은 150파일이 격리 0 으로 남았다.
        if (depth === 2 && paths.length > 1) {
          const count = Math.min(paths.length, isolationRemaining[shard]!);
          isolationRemaining[shard]! -= count;
          const children = await Promise.all(paths.slice(0, count).map(async (file, index) => {
            const child = await runShard([file], shard, depth + 1, `${branch}-file-${index}`);
            debug.log('release-loop.gate', 'pod-shard-isolate', { shard, file, outcome: child.stalled[0]?.reason ?? 'ok' });
            return child;
          }));
          return { runs: children.flatMap((child) => child.runs), stalled: [
            ...children.flatMap((child) => child.stalled),
            ...(paths.length > count ? [{ shard, files: paths.slice(count), reason,
              ...(lastFile ? { lastFile } : {}),
            }] : []),
          ] };
        }
        if (depth === 2 || paths.length === 1) return { runs: [], stalled: [{ shard, files: paths, reason,
          ...(lastFile ? { lastFile } : {}),
          ...(reason === 'unattributed' ? { summaryFailures: fails, namedFailures, ...(unattributedDetail ? { detail: unattributedDetail } : {}) } : {}),
        }] };
        // GT1 — a big shard that failed at the root goes straight to cap-sized chunks instead of halving twice: memory
        // piles up when one bun process runs many files (0.2.7: only bundles of 54+ OOMed), and each halving round costs
        // a Pod start, an install and a rerun. A failing chunk then isolates its files (depth 2), as before.
        if (depth === 0 && paths.length > POD_SHARD_FILE_CAP) {
          const chunks = Array.from({ length: Math.ceil(paths.length / POD_SHARD_FILE_CAP) }, (_, i) => paths.slice(i * POD_SHARD_FILE_CAP, (i + 1) * POD_SHARD_FILE_CAP));
          debug.log('release-loop.gate', 'pod-shard-cap-split', { shard, files: paths.length, chunks: chunks.length, cap: POD_SHARD_FILE_CAP, reason });
          const children = await Promise.all(chunks.map((chunk, i) => runShard(chunk, shard, 2, `${branch}-c${i}`)));
          return { runs: children.flatMap((child) => child.runs), stalled: children.flatMap((child) => child.stalled) };
        }
        debug.log('release-loop.gate', 'pod-shard-split', { shard, depth, files: paths, reason });
        const middle = Math.ceil(paths.length / 2);
        const children = await Promise.all([
          runShard(paths.slice(0, middle), shard, depth + 1, `${branch}-0`),
          runShard(paths.slice(middle), shard, depth + 1, `${branch}-1`),
        ]);
        return { runs: children.flatMap((child) => child.runs), stalled: children.flatMap((child) => child.stalled) };
      }
      return { runs: [{ output: clean!, rc: rc!, pass: passes, fail: fails,
        errors: Number.isNaN(summaryCount(clean!, 'error')) ? 0 : summaryCount(clean!, 'error'),
        ran: Number(ran![1]), files: Number(ran![2]), passedIds: junit ? junitPassedIds(junit) : [] }], stalled: [] };
    };
    // 모든 조각이 끝난 뒤 판정한다 — 한 조각의 예외로 먼저 돌아가면 다른 Pod 가 도는 채로 정리가 시작된다(#22002 리뷰 R3).
    const settled = await Promise.allSettled(shards.map((item, shard) => runShard(item.files, shard)));
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const stalledShards = results.flatMap((result) => result.stalled);
    const measured = results.flatMap((result) => result.runs);
    const total = measured.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
      errors: sum.errors + run.errors, ran: sum.ran + run.ran, files: sum.files + run.files }),
    { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
    if (stalledShards.length) throw new StalledPodShards(stalledShards, total);
    if (total.ran === 0 && total.errors === 0) throw new Error('sweep incomplete: no tests ran');
    const outputs = measured.map((run) => run.output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
    return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`,
      passedIds: [...new Set(measured.flatMap((run) => run.passedIds))].sort() };
  };
  return {
    command,
    localCommand: commandOverride && !remote ? commandOverride : localCommand,
    get remoteMirror() { return remoteMirror; },
    set remoteMirror(path) { remoteMirror = path; },
    async sweep(tree, logDir, pod) {
      if (pod) return podSweep(tree, logDir, pod);
      const listed = await command('git', ['ls-files', '*.test.*'], tree);
      check(listed, 'git ls-files tests');
      const files = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
      const groups = [
        { name: 'src-cli', paths: ['src/cli'] },
        { name: 'src-rest', paths: [...new Set(files.filter((f) => f.startsWith('src/') && !f.startsWith('src/cli/')).map((f) => f.split('/').length === 2 ? f : f.split('/').slice(0, 2).join('/')))] },
        { name: 'test', paths: ['test'] },
        { name: 'other', paths: [...new Set(files.filter((f) => !f.startsWith('src/') && !f.startsWith('test/')).map((f) => f.split('/')[0]!))] },
      ];
      let cdpPatterns: string[];
      if (remote) {
        const cdp = await command('rg', ['-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'], tree);
        if (cdp.rc !== 0 && cdp.rc !== 1) throw new Error(`CDP pattern discovery failed (rc=${cdp.rc}): ${tail40(cdp.output)}`);
        cdpPatterns = cdp.output.split(/\r?\n/).filter((path) => path.endsWith('.test.ts'));
      } else cdpPatterns = deriveCdpTestPatterns({ cwd: tree });
      const outputs: string[] = [];
      let total = { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 };
      for (const group of groups) {
        if (!group.paths.length || !files.some((f) => group.paths.some((p) => f === p || f.startsWith(`${p}/`)))) continue;
        const start = Date.now();
        const groupIgnores = [...new Set(cdpPatterns)]
          .filter((pattern) => files.includes(pattern) && group.paths.some((p) => pattern === p || pattern.startsWith(`${p}/`)))
          .flatMap((pattern) => ['--path-ignore-patterns', pattern]);
        const run = await command('bun', ['run', 'test:deterministic', ...groupIgnores, ...group.paths.map(asPath)], tree);
        if (logDir) {
          mkdirSync(logDir, { recursive: true });
          writeFileSync(join(logDir, `${group.name}.log`), run.output, { mode: 0o600 });
          writeFileSync(join(logDir, `${group.name}.json`), JSON.stringify({ durationMs: Date.now() - start, rc: run.rc }) + '\n', { mode: 0o600 });
        }
        debug.log('release-loop.gate', 'shard', { shard: group.name, durationMs: Date.now() - start, rc: run.rc, logDir });
        try { failuresOf(run, `${group.name} shard`); }
        catch (error) { throw new Error(`${group.name} shard: ${error instanceof Error ? error.message : String(error)}`); }
        const clean = run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        const ran = lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/)!;
        const passes = summaryCount(clean, 'pass');
        if (!Number.isFinite(passes) && Number(ran[1]) > 0) throw new Error(`${group.name} shard incomplete (rc=${run.rc}; pass summary missing)\n${tail40(clean)}`);
        total = { pass: total.pass + (Number.isNaN(passes) ? 0 : passes), fail: total.fail + summaryCount(clean, 'fail'),
          errors: total.errors + (Number.isNaN(summaryCount(clean, 'error')) ? 0 : summaryCount(clean, 'error')),
          ran: total.ran + Number(ran[1]), files: total.files + Number(ran[2]) };
        outputs.push(clean.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
      }
      if (!outputs.length || (total.ran === 0 && total.errors === 0)) throw new Error('sweep incomplete: no tests ran');
      return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n` };
    },
    async add(tree, commit) {
      if (remote) {
        if (!remoteMirror) throw new Error('remote mirror not prepared');
        check(await command('git', ['clone', '--no-checkout', remoteMirror, tree], dirname(tree)), 'remote tree clone');
        check(await command('git', ['-C', tree, 'fetch', 'origin', `refs/elanous/gate/${commit}`], dirname(tree)), 'remote tree fetch');
        check(await command('git', ['-C', tree, 'checkout', '--detach', commit], dirname(tree)), 'remote tree checkout');
      } else check(await command('git', ['worktree', 'add', '--detach', tree, commit], repo), 'git worktree add');
    },
    async remove(tree) {
      if (remote) check(await command('rm', ['-rf', '--', tree], dirname(tree)), 'remote tree cleanup');
      else check(await command('git', ['worktree', 'remove', '--force', tree], repo), 'git worktree remove');
    },
    async snapshot(tree, commit) {
      if (remote) {
        if (!remoteMirror) throw new Error('remote mirror not prepared');
        check(await command('git', ['clone', '--no-checkout', remoteMirror, tree], dirname(tree)), 'baseline snapshot clone');
        check(await command('git', ['-C', tree, 'fetch', 'origin', `refs/elanous/gate/${commit}`], dirname(tree)), 'baseline snapshot fetch');
        check(await command('git', ['-C', tree, 'checkout', '--detach', commit], dirname(tree)), 'baseline snapshot checkout');
      } else {
        check(await command('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, tree], repo), 'baseline snapshot clone');
        check(await command('git', ['checkout', '--quiet', '--detach', commit], tree), 'baseline snapshot checkout');
      }
    },
    async removeSnapshot(tree) {
      if (remote) check(await command('rm', ['-rf', '--', tree], dirname(tree)), 'baseline snapshot cleanup');
      else rmSync(tree, { recursive: true, force: true });
    },
  };
}

function readBaseline(root: string, version: string): { commit: string; failures: string[]; errors?: string[] } | undefined {
  const path = failureFile(root, version);
  if (!existsSync(path)) return undefined;
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || !('failures' in data) || !Array.isArray(data.failures)
    || !data.failures.every((id: unknown) => typeof id === 'string')
    || ('errors' in data && (!Array.isArray(data.errors) || !data.errors.every((id: unknown) => typeof id === 'string')))
    || !('commit' in data) || typeof data.commit !== 'string' || !sha.test(data.commit)) {
    throw new Error(`invalid baseline failure ledger: ${path}`);
  }
  const record = data as { commit: string; failures: string[]; errors?: string[] };
  for (const id of [...record.failures, ...(record.errors ?? [])]) fileOf(id);
  return record;
}

export function baselineCommit(root: string, version: string): string {
  const path = join(root, 'release', version, 'release.json');
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const commit = manifest && typeof manifest === 'object' && 'sourceCommit' in manifest ? manifest.sourceCommit : undefined;
  if (typeof commit !== 'string' || !sha.test(commit)) throw new Error(`missing sourceCommit in ${path}`);
  return commit;
}

function fileOf(id: string): string {
  const file = id.split(' > ', 1)[0]!;
  if (!id.includes(' > ') || !/^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`unsafe test path: ${file}`);
  return file;
}

export async function judgeGate(opts: GateOptions, runner: GateRunner = createGateRunner(opts.repo ?? process.cwd(), opts.remote)): Promise<GateResult> {
  const start = Date.now();
  const explicitConfig = getElanousConfigDirOverride();
  const root = explicitConfig ? effectiveInstanceRoot() : (opts.instanceRoot ?? effectiveInstanceRoot());
  const ledger = explicitConfig ? root : (opts.ledgerRoot ?? releaseLedgerRoot());
  const roots = [...new Set([ledger, root])];
  const cachedBaseline = (version: string, commit: string) => {
    for (const [index, location] of roots.entries()) {
      const saved = readBaseline(location, version);
      if (saved?.commit === commit) return { saved, source: index === 0 && location !== root ? 'ledger' as const : 'instance' as const };
    }
    return undefined;
  };
  const baselineReleaseCommit = (version: string) => {
    for (const location of roots) {
      const path = join(location, 'release', version, 'release.json');
      if (existsSync(path)) return baselineCommit(location, version);
    }
    return baselineCommit(root, version);
  };
  const repo = resolve(opts.repo ?? process.cwd());
  const result: GateResult = { outcome: 'error', commit: opts.commit, introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], durationMs: 0 };
  let work: string | undefined;
  let baseSnapshot = false;
  let cutFailures: SweepFailures | undefined;
  const trees: string[] = [];
  try {
    if (!sha.test(opts.commit) || !versionPattern.test(opts.version)
      || (opts.baselineVersion && !versionPattern.test(opts.baselineVersion))
      || (opts.baselineCommit && !sha.test(opts.baselineCommit))) throw new Error('invalid commit or version');
    if (!opts.baselineVersion) throw new Error('previous release version required (--baseline-version)');
    if (opts.pod && (!opts.pod.pool || !Number.isSafeInteger(opts.pod.shards ?? 24) || (opts.pod.shards ?? 24) < 1
      || !Number.isSafeInteger(opts.pod.shardTimeoutSeconds ?? 1200) || (opts.pod.shardTimeoutSeconds ?? 1200) < 1)) throw new Error('invalid pod sweep options');
    if (opts.remote && !/^(?:[\w.-]+@)?[\w.-]+$/.test(opts.remote)) throw new Error('invalid ssh host');
    if (opts.remote) {
      runner.remoteMirror = undefined;
      const configured = opts.remoteMirror ?? defaultRemoteMirror;
      if (!/^(?:\/|~\/)[\w./-]+$/.test(configured) || configured.split('/').includes('..')) throw new Error('invalid remote mirror path');
      const home = configured.startsWith('~/') ? await runner.command('sh', ['-c', 'printf "%s\\n" "$HOME"'], '/tmp') : undefined;
      if (home) check(home, 'remote home');
      const homePath = home?.output.split(/\r?\n/).find((line) => line.startsWith('/'));
      if (home && (!homePath || !/^\/[^\r\n]*$/.test(homePath))) throw new Error('invalid remote home');
      const mirror = configured.startsWith('~/') ? join(homePath!, configured.slice(2)) : configured;
      const baseSha = opts.baselineCommit ?? baselineReleaseCommit(opts.baselineVersion);
      cachedBaseline(opts.baselineVersion, baseSha);
      const present = await runner.command('test', ['-d', mirror], '/tmp');
      if (present.rc === 1) {
        check(await runner.command('mkdir', ['-p', dirname(mirror)], '/tmp'), 'remote mirror parent');
        check(await runner.command('git', ['init', '--bare', mirror], '/tmp'), 'remote mirror init');
      } else check(present, 'remote mirror lookup');
      const bare = await runner.command('git', ['--git-dir', mirror, 'rev-parse', '--is-bare-repository'], '/tmp');
      check(bare, 'remote mirror inspection');
      if (!bare.output.split(/\r?\n/).includes('true')) throw new Error('remote mirror is not bare');
      for (const commit of new Set([opts.commit, baseSha])) {
        const ref = `refs/elanous/gate/${commit}`;
        const found = await runner.command('git', ['--git-dir', mirror, 'show-ref', '--verify', '--quiet', ref], '/tmp');
        if (found.rc === 1) check(await runner.localCommand('git', ['push', `${opts.remote}:${mirror}`, `${commit}:${ref}`], repo), `remote push ${commit}`);
        else check(found, `remote mirror ref ${commit}`);
      }
      runner.remoteMirror = mirror;
      const temporary = await runner.command('mktemp', ['-d', '/tmp/release-gate-XXXXXXXX'], '/tmp');
      check(temporary, 'remote mktemp');
      const paths = temporary.output.split(/\r?\n/).filter((line) => /^\/tmp\/release-gate-[\w-]+$/.test(line));
      if (paths.length !== 1) throw new Error('could not create temporary work directory');
      work = paths[0]!;
    } else work = mkdtempSync(join(tmpdir(), 'release-gate-'));
    const cutTree = join(work, 'cut');
    trees.push(cutTree);
    await runner.add(cutTree, opts.commit);
    for (const dir of [cutTree, join(cutTree, 'apps/pwa')]) check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
    const cutRun = await runner.sweep(cutTree, join(root, 'release', opts.version, 'gate-logs', 'cut'),
      opts.pod ? { ...opts.pod, durationSource: join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut') } : undefined);
    const cut = failuresOf(cutRun, 'cut sweep');
    cutFailures = cut;
    const baseSha = opts.baselineCommit ?? baselineReleaseCommit(opts.baselineVersion);
    const cached = cachedBaseline(opts.baselineVersion, baseSha);
    const recorded = cached ? undefined : baselineFromCutLogs(join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut'), baseSha);
    const trusted = cached?.saved ?? (recorded?.complete ? recorded : undefined);
    result.baselineSource = cached ? cached.source : recorded?.complete ? 'cut-logs' : 'swept';
    debug.log('release-loop.gate', 'baseline', { version: opts.baselineVersion, source: result.baselineSource, commit: baseSha });
    let baseTree: string | undefined;
    const getBaseTree = async () => {
      if (!baseTree) {
        baseTree = join(work!, 'baseline');
        if (trusted) {
          baseSnapshot = true;
          await runner.snapshot(baseTree, baseSha);
        } else {
          trees.push(baseTree);
          await runner.add(baseTree, baseSha);
        }
        for (const dir of [baseTree, join(baseTree, 'apps/pwa')]) check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
      }
      return baseTree;
    };
    let baseline: SweepFailures | undefined = trusted ? { failures: trusted.failures, errors: trusted.errors ?? [] } : undefined;
    if (!baseline) {
      // K9b — with no reusable ledger the baseline is swept on the same Pod pool as the cut, not on this host (0.2.6: an
      // hour of local baseline after a 23-minute Pod cut).
      const baseRun = await runner.sweep(await getBaseTree(), join(root, 'release', opts.version, 'gate-logs', 'baseline'),
        opts.pod ? { ...opts.pod, durationSource: join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut') } : undefined);
      baseline = failuresOf(baseRun, 'baseline sweep');
    }
    for (const id of [...baseline.failures, ...baseline.errors, ...cut.failures, ...cut.errors]) fileOf(id);
    const known = opts.pod ? loadEnvKnownFailures(repo) : new Set<string>();
    const cutIds = [...cut.failures, ...cut.errors];
    const baselineIds = [...baseline.failures, ...baseline.errors];
    const countedCut = splitKnownEnv(cutIds, known);
    const countedBaseline = splitKnownEnv(baselineIds, known);
    result.knownEnv = countedCut.knownEnv.length;
    result.knownEnvCleared = [...new Set(cutRun.passedIds ?? [])].filter((id) => known.has(id) && !cutIds.includes(id)).sort();
    const diff = diffFailures(countedCut.counted, countedBaseline.counted);
    result.fixed = diff.fixed.length;
    result.preexisting = diff.common.length;
    for (const file of new Set(diff.newFailures.map(fileOf))) {
      const isolated = await runner.command('bun', ['run', 'test:deterministic', asPath(file)], cutTree);
      const isolatedCut = failuresOf(isolated, `cut isolated ${file}`);
      const reproduced = new Set([...isolatedCut.failures, ...isolatedCut.errors]);
      const candidates = diff.newFailures.filter((id) => fileOf(id) === file && reproduced.has(id));
      if (candidates.length === 0) continue;
      const baselineTree = await getBaseTree();
      const previous = await runner.command('bun', ['run', 'test:deterministic', asPath(file)], baselineTree);
      let oldFailures: Set<string>;
      if (/No tests found|had no matches/i.test(previous.output) && previous.rc === 1) {
        const lookup = await runner.command('git', ['ls-tree', '--name-only', baseSha, '--', file], opts.remote ? baselineTree : repo);
        if (lookup.rc !== 0 || lookup.output.trim()) throw new Error(`baseline isolated run incomplete: ${file}`);
        oldFailures = new Set();
      } else {
        const prior = failuresOf(previous, `baseline isolated ${file}`);
        oldFailures = new Set([...prior.failures, ...prior.errors]);
      }
      for (const id of candidates) {
        if (oldFailures.has(id)) result.preexisting++;
        else result.introduced.push(id);
      }
    }
    result.outcome = result.introduced.length ? 'regression' : 'ok';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error instanceof StalledPodShards) {
      result.stalledShards = error.stalledShards;
      result.partialSummary = error.partialSummary;
    }
  } finally {
    if (baseSnapshot && work) {
      try { await runner.removeSnapshot(join(work, 'baseline')); }
      catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    for (const tree of trees.reverse()) {
      try { await runner.remove(tree); }
      catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    if (work) {
      try {
        if (opts.remote) check(await runner.command('rm', ['-rf', '--', work], '/tmp'), 'remote temporary directory cleanup');
        else rmSync(work, { recursive: true, force: true });
      } catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    if (opts.remote) runner.remoteMirror = undefined;
    result.durationMs = Date.now() - start;
  }
  if (cutFailures && !result.stalledShards?.length) {
    try {
      for (const location of roots) {
        const path = failureFile(location, opts.version);
        mkdirSync(dirname(path), { recursive: true });
        const temp = join(dirname(path), `.gate-failures-${process.pid}-${randomUUID()}.tmp`);
        try {
          writeFileSync(temp, JSON.stringify({ commit: opts.commit, failures: cutFailures.failures, ...(cutFailures.errors.length ? { errors: cutFailures.errors } : {}) }, null, 2) + '\n', { mode: 0o600 });
          chmodSync(temp, 0o600);
          renameSync(temp, path);
        } finally { if (existsSync(temp)) rmSync(temp); }
      }
    } catch (error) {
      result.outcome = 'error';
      result.error = `baseline persistence: ${String(error)}`;
    }
  }
  if (result.outcome !== 'error') debug.log('release-loop.gate', 'judged', { version: opts.version, commit: opts.commit, introduced: result.introduced.length, preexisting: result.preexisting });
  return result;
}

export function graphGateResult(result: GateResult, graph: boolean) {
  return { ...result, ...(graph && result.outcome === 'regression' ? { outcome: 'fail' as const } : {}),
    verdict: result.outcome === 'ok' ? 'pass' as const : 'fail' as const,
    summary: (result.outcome === 'ok' ? `새 회귀 ${result.introduced.length} · 기존 ${result.preexisting} · 고침 ${result.fixed}` : `게이트 ${result.outcome}: ${result.error ?? result.introduced.length + ' new regressions'}`) + ` · 환경 알려진 실패 ${result.knownEnv}` };
}

export function parseOptions(args: string[], env: NodeJS.ProcessEnv): GateOptions | 'help' {
  const context = env.ELANOUS_GRAPH_CONTEXT && args.every((arg) => arg === '--json') ? readGraphContext(env) : undefined;
  const fromGraph: Record<string, unknown> = context?.input ?? {};
  const graphCommit = context?.outputs['version-release']?.commit;
  if (typeof graphCommit === 'string') fromGraph.commit = graphCommit;
  const baselineCommit = context?.outputs.cutoff?.baseline as { sha?: unknown } | undefined;
  if (typeof baselineCommit?.sha === 'string') fromGraph.previousCommit = baselineCommit.sha;
  const opts: GateOptions = {
    commit: typeof fromGraph.commit === 'string' ? fromGraph.commit : '',
    version: typeof fromGraph.version === 'string' ? fromGraph.version : '',
    baselineVersion: typeof fromGraph.previousVersion === 'string' ? fromGraph.previousVersion : undefined,
    baselineCommit: typeof fromGraph.previousCommit === 'string' ? fromGraph.previousCommit : undefined,
    remote: typeof fromGraph.gateRemote === 'string' ? fromGraph.gateRemote : undefined,
    remoteMirror: typeof fromGraph.gateRemoteMirror === 'string' ? fromGraph.gateRemoteMirror : undefined,
    pod: typeof fromGraph.gatePodPool === 'string' ? {
      pool: fromGraph.gatePodPool,
      ...(fromGraph.gatePodShards !== undefined ? { shards: Number(fromGraph.gatePodShards) } : {}),
      ...(fromGraph.gatePodShardTimeoutSeconds !== undefined ? { shardTimeoutSeconds: Number(fromGraph.gatePodShardTimeoutSeconds) } : {}),
      ...(typeof fromGraph.gatePodBunCache === 'string' && fromGraph.gatePodBunCache.trim() ? { bunCache: fromGraph.gatePodBunCache } : {}),
    } : undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return 'help';
    if (arg === '--json') continue;
    const key = ({ '--commit': 'commit', '--version': 'version', '--baseline-version': 'baselineVersion', '--baseline-commit': 'baselineCommit', '--remote': 'remote', '--remote-mirror': 'remoteMirror', '--pod-pool': 'pod', '--pod-shards': 'pod', '--pod-shard-timeout-seconds': 'pod' } as Record<string, keyof GateOptions>)[arg!];
    if (!key) throw new Error(`unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`value required for ${arg}`);
    if (arg === '--pod-pool') opts.pod = { ...opts.pod, pool: value };
    else if (arg === '--pod-shards') opts.pod = { pool: opts.pod?.pool ?? '', ...opts.pod, shards: Number(value) };
    else if (arg === '--pod-shard-timeout-seconds') opts.pod = { pool: opts.pod?.pool ?? '', ...opts.pod, shardTimeoutSeconds: Number(value) };
    else if (key === 'commit') opts.commit = value;
    else if (key === 'version') opts.version = value;
    else if (key === 'baselineVersion') opts.baselineVersion = value;
    else if (key === 'baselineCommit') opts.baselineCommit = value;
    else if (key === 'remote') opts.remote = value;
    else if (key === 'remoteMirror') opts.remoteMirror = value;
  }
  return opts;
}

if (import.meta.main) {
  const start = Date.now();
  let result: GateResult;
  let version = '';
  try {
    const opts = parseOptions(process.argv.slice(2), process.env);
    if (opts === 'help') {
      console.log('Usage: bun scripts/release-loop/gate-node.ts --commit <sha> --version <v> [--baseline-version <prev>] [--baseline-commit <sha>] [--remote <ssh-host>] [--remote-mirror <path>] [--pod-pool <pool>] [--pod-shards <n>] [--pod-shard-timeout-seconds <n>] [--json]\nWithout flags, input.commit, input.version and input.previousVersion come from the JSON file at ELANOUS_GRAPH_CONTEXT.');
      process.exit(0);
    }
    version = opts.version;
    result = await judgeGate(opts);
  } catch (error) {
    result = { outcome: 'error', commit: '', introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], durationMs: Date.now() - start, error: String(error) };
  }
  if (result.error) console.error(result.error);
  debug.log('release-loop.gate', 'result', { version, outcome: result.outcome });
  emitNodeResult(graphGateResult(result, !!process.env.ELANOUS_GRAPH_CONTEXT));
  process.exitCode = result.outcome === 'ok' ? 0 : result.outcome === 'regression' ? 1 : 2;
}
