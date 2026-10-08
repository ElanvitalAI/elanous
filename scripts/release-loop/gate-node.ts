#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { landingFreezeMessage, readLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { diffFailures, junitFailures, parseFailures, parseTimedOutFailures } from './gate-diff';
import { loadEnvKnownFailures, splitKnownEnv } from './env-known-failures';
import { baselineFromCutLogs } from './baseline-from-logs';
import { mergePartialFailures, readPartialPlan, testFileOfId } from './gate-partial';
import { logPlanWalltime, planDurations, planShards, readFileMemory } from './shard-plan';
import { deriveCdpTestPatterns } from '../test-deterministic';
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { runPodCommand, parsePodCpu, resolvePodCpu, type RunPodCommandOptions, type PodCommandResult, type PodCpu } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { POD_BUN_CACHE_HOST_PATH, parseInstallSeconds, podBunCacheVolume } from '../../src/task-orchestrator/surfaces/pod-bun-cache.js';
import { PodPoolScheduler, parsePodPool, checkPodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { POD_INSTALL_SLOTS_DEFAULT, POD_INSTALL_SLOTS_HOST_PATH, installSlotScript } from '../../src/task-orchestrator/surfaces/pod-install-slots.js';
import { gateShardsPath, writeGateShards, type GateShard } from '../../src/release-loop/gate-shards.js';
import { defaultKubectl } from '../../src/task-orchestrator/surfaces/self-implement-pod.js';

interface CommandResult { rc: number; output: string; passedIds?: string[]; stalledEnv?: Array<{ file: string; reason: 'no-output' }>; timedOut?: boolean }
export interface GateRunner {
  command(cmd: string, args: string[], cwd: string, limitMs?: number): Promise<CommandResult>;
  localCommand(cmd: string, args: string[], cwd: string, limitMs?: number): Promise<CommandResult>;
  /** `only` (GATE-PARTIAL) restricts the sweep to these test files; absent = every test file. */
  sweep(tree: string, logDir?: string, pod?: GateOptions['pod'], only?: readonly string[]): Promise<CommandResult>;
  add(tree: string, commit: string): Promise<void>;
  remove(tree: string): Promise<void>;
  snapshot(tree: string, commit: string): Promise<void>;
  removeSnapshot(tree: string): Promise<void>;
  /** Absolute remote bare mirror path, set before preparing the remote trees. */
  remoteMirror?: string;
}
export interface GateOptions {
  commit: string;
  forceFreeze?: boolean;
  version: string;
  baselineVersion?: string;
  baselineCommit?: string;
  remote?: string;
  remoteMirror?: string;
  instanceRoot?: string;
  ledgerRoot?: string;
  repo?: string;
  /** freshShards — GATE-SHARD-RESUME off: every shard starts a Pod even when this logDir already holds its result. */
  pod?: { pool: string; shards?: number; shardTimeoutSeconds?: number; durationSource?: string; bunCache?: string; freshShards?: boolean;
    /** GATE-SKIP-KNOWN-RETRY — failure ids the previous release already had (and env-known ones): a shard that fails only
     *  with these is not re-run in isolation; the verdict still classifies them against the baseline as before. */
    knownFailures?: readonly string[];
    /** GATE-SPEED A3① — shard Pod CPU request/limit (`release.loop.gatePodCpu`); omitted = request 1 / limit 4. */
    cpu?: PodCpu;
    /** GATE-INSTALL-CACHE — concurrent `bun install`s per node (`release.loop.gatePodInstallSlots`); omitted = 4 · 0 = off. */
    installSlots?: number;
    /** GATE-MEM-ADMIT — seconds a shard waits for pool admission (memory headroom) before it launches anyway with
     *  `admission-timeout` (`release.loop.gatePodAdmissionWaitSeconds`); omitted = {@link GATE_ADMISSION_WAIT_SECONDS_DEFAULT} · 0 = off. */
    admissionWaitSeconds?: number;
    /** GATE-MEM-ADMIT — an injected admission (tests · embedders); config never sets it. Absent = the gate's own pool's. */
    admission?: GateAdmission;
    /** GATE-LIVE-OBS — the shard state file (`gateShardsPath(version)`) this sweep keeps current; absent = not written. */
    shardsFile?: { path: string; version: string } };
}
export interface GateResult {
  outcome: 'ok' | 'regression' | 'error';
  commit: string;
  introduced: string[];
  preexisting: number;
  /** null = not counted (GATE-SPEED A4: the swept baseline ran only the cut's failing files). */
  fixed: number | null;
  knownEnv: number;
  knownEnvCleared: string[];
  stalledEnv: Array<{ file: string; reason: 'no-output' | 'isolated-timeout'; local: 'passed' | 'failed' | 'timeout' }>;
  baselineSource?: 'ledger' | 'instance' | 'cut-logs' | 'swept';
  /** GATE-BASELINE-CACHE — isolated baseline files answered from the ledger (hits) or run now (misses). */
  baselineCache?: { hits: number; misses: number };
  /** GATE-SPEED A4 — a swept baseline ran only the cut's failing files that exist at the previous release. */
  baselineDeferred?: { cutFiles: number; swept: number };
  durationMs: number;
  error?: string;
  stalledShards?: Array<{ shard: number; files: string[]; reason: 'incomplete' | 'no-output' | 'job-failed' | 'unattributed' | 'timeout'; lastFile?: string; summaryFailures?: number; namedFailures?: number; detail?: string }>;
  partialSummary?: { pass: number; fail: number; errors: number; ran: number; files: number };
  /** GATE-PARTIAL — this verdict re-ran only these files and carried the prior gate's results for the rest. */
  partial?: { priorCommit: string; files: number };
  /** GATE-INTRO-RECHECK — new failures that were only the «timed out» shape and passed one isolated re-run with a
   *  {@link GATE_TIMEOUT_RECHECK_MS} per-test limit: a warning (flaky under load), not an introduced regression. */
  loadFlaky?: string[];
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
/** A Pod path (`~/repo/src/…` · `../..~/repo/src/…`) as a repository-relative one. */
const podRelative = (path: string) => path.replace(/^(?:\.\.\/)*\/?home\/ubuntu\/repo\//, '');
/** `file > [error]` ids of bun's «Unhandled error between tests» blocks, or undefined when one cannot be attributed. */
function unhandledErrorIds(output: string): string[] | undefined {
  const errors: string[] = [];
  let file: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):/.exec(raw.trim());
    if (header) file = header[1];
    if (/^# Unhandled error between tests/.test(raw.trim())) {
      if (!file) return undefined;
      errors.push(`${file} > [error]`);
      file = undefined;
    }
  }
  return errors;
}
/**
 * GATE-SKIP-KNOWN-RETRY / GATE-ISOLATE-FAILED-FILES — the failing ids of one Pod shard, but only when every failure the
 * summary counts is named (junit first, else the console `(fail)` lines) and every unhandled error is attributed.
 * Anything less returns undefined, and the shard keeps the old retry path.
 */
export function shardFailureIds(clean: string, junit: string | undefined, fails: number, errors: number): { failures: string[]; errors: string[] } | undefined {
  if (!Number.isFinite(fails)) return undefined;
  const stripped = stripPodRepoRoot(clean);
  let failures: string[];
  try { failures = junit !== undefined ? [...new Set(junitFailures(junit).map(podRelative))].sort() : parseFailures(stripped); }
  catch { return undefined; }
  if (failures.length !== fails) return undefined;
  const errorIds = unhandledErrorIds(stripped);
  if (!errorIds || errorIds.length !== (Number.isNaN(errors) ? 0 : errors)) return undefined;
  return { failures, errors: [...new Set(errorIds)].sort() };
}
/** The console form `failuresOf` reads back, for failures named from junit (same shape as `pod-shard-junit-attribution`). */
const failureOutput = (failures: readonly string[], errors: readonly string[]) => [
  ...failures.map((id) => { const cut = id.indexOf(' > '); return `${id.slice(0, cut)}:\n(fail) ${id.slice(cut + 3)}`; }),
  ...errors.map((id) => `${testFileOfId(id)}:\n# Unhandled error between tests`),
].join('\n');
/** Repository-relative test files with at least one passed or failed junit testcase (an empty suite is no result). */
function junitFiles(xml: string): Set<string> {
  const files = new Set<string>();
  for (const id of [...junitPassedIds(xml), ...junitFailures(xml)]) {
    try { files.add(testFileOfId(podRelative(id))); } catch { /* an unreadable id proves nothing about its file */ }
  }
  return files;
}
/**
 * GATE-ISOLATE-FAILED-FILES — the files of a failed shard worth re-running: those with a failing test or an unhandled
 * error, and those with no junit result at all (crashed or never reached). undefined = cannot tell (fallback: whole shard).
 */
export function retryFiles(paths: readonly string[], clean: string | undefined, junit: string | undefined, fails: number, errors: number): string[] | undefined {
  if (junit === undefined || clean === undefined) return undefined;
  const ids = shardFailureIds(clean, junit, fails, errors);
  if (!ids) return undefined;
  const failing = new Set([...ids.failures, ...ids.errors].map((id) => { try { return testFileOfId(id); } catch { return id; } }));
  if ([...failing].some((file) => !paths.includes(file))) return undefined;
  const reported = junitFiles(junit);
  return paths.filter((file) => failing.has(file) || !reported.has(file));
}
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

/** GATE-TIMEOUT-HEAL (0.2.20) — the per-shard Job deadline is the shard's planned wall-clock × 1.5, never under the
 *  configured floor (`release.loop.gatePodShardTimeoutSeconds` · default 1200 s) and never over the cap (or the floor,
 *  if that is higher). 0.2.19: the largest shard was planned at 18.9 min, ran 20–27 min (install 220–340 s under load)
 *  and 11 of 24 shards were cut at the flat 1200 s with nothing left to read. */
export const POD_SHARD_TIMEOUT_FLOOR_SECONDS = 1200;
export const POD_SHARD_TIMEOUT_CAP_SECONDS = 3600;
export function shardDeadlineSeconds(plannedSeconds: number, configured?: number): number {
  const floor = configured ?? POD_SHARD_TIMEOUT_FLOOR_SECONDS;
  const scaled = Number.isFinite(plannedSeconds) && plannedSeconds > 0 ? Math.ceil(plannedSeconds * 1.5) : 0;
  return Math.min(Math.max(floor, POD_SHARD_TIMEOUT_CAP_SECONDS), Math.max(floor, scaled));
}
/** Seconds the Pod keeps after the in-shell soft deadline: kill grace, artifact emission, and slack for what the Job
 *  deadline counts before the shell starts and the shell cannot see (scheduling · init containers). */
export const POD_SHARD_EMIT_RESERVE_SECONDS = 120;
export const softDeadlineSeconds = (deadline: number) => deadline > 2 * POD_SHARD_EMIT_RESERVE_SECONDS
  ? deadline - POD_SHARD_EMIT_RESERVE_SECONDS : Math.max(1, Math.floor(deadline * 0.8));
/** GATE-TIMEOUT-HEAL ② — a shard runs as consecutive parts of about this many planned seconds (at most
 *  {@link POD_SHARD_FILE_CAP} files), each with its own log and junit, so a shard cut by its deadline still leaves the
 *  results of every part that finished (F1/F2 read them) instead of nothing. */
export const POD_SHARD_PART_SECONDS = 120;
export function shardParts(paths: readonly string[], seconds: (file: string) => number, target = POD_SHARD_PART_SECONDS): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let sum = 0;
  for (const file of paths) {
    current.push(file);
    sum += seconds(file);
    if (sum >= target || current.length >= POD_SHARD_FILE_CAP) { parts.push(current); current = []; sum = 0; }
  }
  if (current.length) parts.push(current);
  return parts;
}
/**
 * The shard's Pod shell. Install once (behind the node's install slots), then run each part under the soft deadline,
 * leaving `install.log`/`install.rc`, `part-<i>.log`/`.rc`/`.junit.xml`, and `shard.timeout` (the part index) when the
 * deadline cut the shard. A part without `.rc` did not finish. The shell itself always exits 0 (as before).
 */
export function gateShardShell(o: { parts: readonly (readonly string[])[]; cdpPatterns: readonly string[]; softSeconds: number; cachePrefix: string; installSlots: number }): string {
  const run = o.parts.map((part, index) => {
    const ignores = o.cdpPatterns.filter((pattern) => part.includes(pattern)).flatMap((pattern) => ['--path-ignore-patterns', pattern]);
    return `run_part ${index} ${['bun', 'run', 'test:deterministic', ...ignores, ...part.map(asPath)].map(quote).join(' ')}`;
  }).join(' && ');
  return [
    'mkdir -p "$HOME/outbox"; O="$HOME/outbox"',
    ...(o.cachePrefix ? [o.cachePrefix] : []),
    // Seconds since this container's PID 1 started (the clone ran before this shell) — 0 when /proc cannot tell.
    `pod_age=$(awk -v t="$(cut -d' ' -f22 /proc/1/stat 2>/dev/null)" -v hz="$(getconf CLK_TCK 2>/dev/null)" '{ if (t > 0 && hz > 0) print int($1 - t / hz); else print 0 }' /proc/uptime 2>/dev/null)`,
    'case "$pod_age" in ""|*[!0-9]*) pod_age=0;; esac',
    `gate_end=$(( $(date +%s) + ${Math.max(1, Math.floor(o.softSeconds))} - pod_age ))`,
    ...(o.installSlots > 0 ? [installSlotScript({ slots: o.installSlots })] : []),
    'run_part() {',
    '  local i=$1; shift',
    '  local left=$(( gate_end - $(date +%s) ))',
    '  if [ "$left" -le 0 ]; then echo "$i" > "$O/shard.timeout"; return 1; fi',
    '  timeout -k 10 "$left" "$@" --reporter=junit --reporter-outfile="$O/part-$i.junit.xml" > "$O/part-$i.log" 2>&1',
    '  local prc=$?',
    '  if [ "$(date +%s)" -ge "$gate_end" ] && { [ "$prc" -eq 124 ] || [ "$prc" -eq 137 ] || [ "$prc" -eq 143 ]; }; then echo "$i" > "$O/shard.timeout"; return 1; fi',
    '  echo "$prc" > "$O/part-$i.rc"',
    '}',
    'if cd .. && cd repo; then',
    ...(o.installSlots > 0 ? ['  install_slot_acquire >> "$O/install.log" 2>&1'] : []),
    '  { bun install && (cd apps/pwa && bun install); } >> "$O/install.log" 2>&1; irc=$?',
    ...(o.installSlots > 0 ? ['  install_slot_release'] : []),
    '  echo "$irc" > "$O/install.rc"',
    `  if [ "$irc" -eq 0 ]; then ${run || 'true'}; fi`,
    'else echo 5 > "$O/install.rc"; fi',
    'true',
  ].join('\n');
}
/** Removes bun's own summary lines so one summary over several runs can follow (same rule as the sweep's merge). */
const stripSummary = (output: string) => output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, '');
export interface ShardArtifacts {
  /** The verdict text: install log ⊕ every finished part (its summary removed) ⊕ one summary over the finished parts. */
  output?: string;
  junit?: string;
  /** 0|1 when every part finished · the failing part's exit when one crashed · undefined when the deadline cut the shard. */
  rc?: number;
  timedOut: boolean;
  /** Files of the parts that finished with a readable summary. */
  finished: string[];
  /** Raw logs of the parts that did not finish (diagnostics · last started file). */
  unfinishedLog?: string;
}
/** Reads a shard Pod's outbox: the part layout ({@link gateShardShell}) or the older single-run one (shard.log · shard.rc · junit.xml). */
export function readShardArtifacts(dir: string, parts: readonly (readonly string[])[]): ShardArtifacts {
  const read = (name: string) => { const path = join(dir, name); return existsSync(path) ? readFileSync(path, 'utf8') : undefined; };
  const rcOf = (text: string | undefined) => { const value = text?.trim() ?? ''; return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined; };
  const installRc = rcOf(read('install.rc'));
  const install = read('install.log');
  if (installRc === undefined && install === undefined) {
    const junit = read('junit.xml');
    const rc = rcOf(read('shard.rc'));
    return { output: read('shard.log'), ...(junit !== undefined ? { junit } : {}), ...(rc !== undefined ? { rc } : {}), timedOut: false, finished: [] };
  }
  const timedOut = read('shard.timeout') !== undefined;
  if (installRc !== 0) return { output: install, ...(installRc !== undefined ? { rc: installRc } : {}), timedOut, finished: [] };
  const good: Array<{ log: string; junit?: string; rc: 0 | 1; files: readonly string[] }> = [];
  const bad: string[] = [];
  let badRc: number | undefined;
  parts.forEach((files, index) => {
    const log = read(`part-${index}.log`);
    const rc = rcOf(read(`part-${index}.rc`));
    const clean = log?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    if (clean !== undefined && (rc === 0 || rc === 1) && lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/)) {
      const junit = read(`part-${index}.junit.xml`);
      good.push({ log: clean, rc, files, ...(junit !== undefined ? { junit } : {}) });
      return;
    }
    if (log !== undefined) bad.push(`# part ${index} (${rc === undefined ? 'unfinished' : `rc=${rc}`})\n${log}`);
    // A finished part without a readable summary is not a verdict: its exit, or 2 when it claimed 0|1.
    if (rc !== undefined && badRc === undefined) badRc = rc === 0 || rc === 1 ? 2 : rc;
  });
  const total = good.reduce((sum, part) => {
    const n = (label: string) => { const value = summaryCount(part.log, label); return Number.isNaN(value) ? 0 : value; };
    const ran = lastMatch(part.log, /Ran (\d+) tests? across (\d+) files?/)!;
    return { pass: sum.pass + n('pass'), fail: sum.fail + n('fail'), errors: sum.errors + n('error'), ran: sum.ran + Number(ran[1]), files: sum.files + Number(ran[2]) };
  }, { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
  const output = [install ?? '', ...good.map((part) => stripSummary(part.log)),
    ...(good.length ? [`${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`] : [])].join('\n');
  const junits = good.flatMap((part) => part.junit !== undefined ? [part.junit] : []);
  const complete = good.length === parts.length;
  const rc = complete ? (good.some((part) => part.rc === 1) ? 1 : 0) : timedOut && badRc === undefined ? undefined : (badRc ?? 2);
  return {
    output,
    ...(junits.length ? { junit: junits.join('\n') } : {}),
    ...(rc !== undefined ? { rc } : {}),
    timedOut: !complete && timedOut && badRc === undefined,
    finished: good.flatMap((part) => [...part.files]),
    ...(bad.length ? { unfinishedLog: bad.join('\n') } : {}),
  };
}

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

/**
 * GATE-SHARD-RESUME (0.2.19) — the result a previous attempt left in this log directory for exactly this shard: same name,
 * same commit, the same files in the same order and a test exit (rc 0|1) with its log. 0.2.18: the second gate stopped
 * after 33 minutes on a tool error (unsafe test path) and the third ran all 80 minutes again although the cut commit and
 * every finished shard were unchanged. The caller re-reads the log with the current tool code; anything else is a miss.
 */
/** GATE-SHARD-RESUME — how a previous attempt went past this shard without a verdict of its own: it re-ran in a fresh Job
 *  after no output (`-retry`), or it failed here and was split (`-c0` cap chunks · `-0` halves · `-file-0` isolation). The
 *  split shape follows from depth and size alone, so the same plan reaches the same child names (TC 09:30 review ②).
 *  `runKey` hashes where and how the Pod ran the shard (pool · command · ignores · memory · deadline · Bun cache): a fix on the Pod side
 *  makes every old result a miss instead of re-reading an old failure as introduced (TC 09:48 review). */
export function previousShardDescent(logDir: string, name: string, commit: string, files: readonly string[], runKey: string, parentAttempt?: string, splitChild?: string): { way: 'retry' | 'split'; attemptId: string } | undefined {
  const meta = (file: string): { commit?: unknown; files?: unknown; rc?: unknown; runKey?: unknown; attemptId?: unknown; parentAttempt?: unknown } | undefined => {
    try { return JSON.parse(readFileSync(join(logDir, `${file}.json`), 'utf8')); } catch { return undefined; }
  };
  const own = meta(name);
  if (own?.commit !== commit || own.runKey !== runKey || !Array.isArray(own.files) || own.files.length !== files.length || own.files.some((file, index) => file !== files[index])) return undefined;
  if (typeof own.attemptId !== 'string' || (parentAttempt !== undefined && own.parentAttempt !== parentAttempt)) return undefined;
  const attemptId = own.attemptId;
  // Children are checked whatever the parent's rc was: a parent can exit 0|1 and still have gone down (no output · an
  // unreadable summary). A child counts only for this commit and only with files taken from this shard.
  const parent = new Set(files);
  const child = (file: string, whole: boolean) => {
    const row = meta(file);
    // A child counts only when the parent's latest attempt wrote it — a child left by an older attempt is not this way down.
    return row?.commit === commit && row.parentAttempt === attemptId && Array.isArray(row.files) && row.files.length > 0 && row.files.every((path) => typeof path === 'string' && parent.has(path))
      && (!whole || row.files.length === files.length);
  };
  if (child(`${name}-retry`, true)) return { way: 'retry', attemptId };
  // Only the first child of the split the caller takes now (`-file-0` · `-c0` · `-0` · review r3): a record of another
  // split shape is not followed.
  return splitChild !== undefined && child(`${name}${splitChild}`, false) ? { way: 'split', attemptId } : undefined;
}

export function previousShardResult(logDir: string, name: string, commit: string, files: readonly string[], runKey: string, parentAttempt?: string): { output: string; junit?: string; rc: 0 | 1; durationMs?: number } | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(logDir, `${name}.json`), 'utf8')) as { commit?: unknown; files?: unknown; rc?: unknown; durationMs?: unknown; runKey?: unknown; parentAttempt?: unknown; jobExitCode?: unknown; jobFailed?: unknown };
    // Only a Job that itself exited 0 — a crashed Job can still leave rc 0 and a clean-looking log (review r6).
    if (meta.jobExitCode !== 0 || meta.jobFailed !== false) return undefined;
    if (meta.commit !== commit || meta.runKey !== runKey || (parentAttempt !== undefined && meta.parentAttempt !== parentAttempt) || (meta.rc !== 0 && meta.rc !== 1) || !Array.isArray(meta.files)
      || meta.files.length !== files.length || meta.files.some((file, index) => file !== files[index])) return undefined;
    const logPath = join(logDir, `${name}.log`);
    if (!existsSync(logPath)) return undefined;
    const junitPath = join(logDir, `${name}.junit.xml`);
    return { output: readFileSync(logPath, 'utf8'), rc: meta.rc, ...(existsSync(junitPath) ? { junit: readFileSync(junitPath, 'utf8') } : {}),
      ...(typeof meta.durationMs === 'number' ? { durationMs: meta.durationMs } : {}) };
  } catch { return undefined; }
}

/** 0.2.18 gate: a test that changed process.cwd made bun print later test files relative to that cwd
 *  (`../..~/repo/src/…`), and the safe-path check stopped the whole gate. The Pod clone root is
 *  `~/repo`; strip it back to a repository-relative path before any id is read. */
export function stripPodRepoRoot(output: string): string {
  return output.replace(/^(\s*(?:\(fail\)\s+)?)(?:\.\.\/)*(?:\/)?home\/ubuntu\/repo\//gm, '$1');
}

function failuresOf(run: CommandResult, label: string): SweepFailures {
  const output = stripPodRepoRoot(run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
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

/** Isolated re-runs (host stall re-run · cut and baseline re-checks) are time-limited; sweeps and installs keep their full time. */
export const GATE_ISOLATED_TIMEOUT_MS = 300_000;
/** GATE-INTRO-RECHECK (0.2.19) — the per-test limit of the one re-run given to a «timed out after 5000ms» new failure.
 *  0.2.18: both first-gate introductions were 5 s limits missed at 6.04/6.06 s, and they alone cost an 84-minute re-gate. */
export const GATE_TIMEOUT_RECHECK_MS = 60_000;
/** TEST-CENSUS intake: one row per load-flaky test, in the machine ledger (read by the test census, never by the gate). */
export const loadFlakyCensusPath = (ledger: string) => join(ledger, 'release', 'test-census', 'load-flaky.jsonl');

/**
 * Runs a limited local command in its own process group. On timeout: SIGTERM the group (test-deterministic forwards it to its own
 * `bun test` group — Chrome included), SIGKILL after a grace, and return after a hard deadline even if a foreign-group process still holds the pipe.
 */
export function limitedLocalCommand(cmd: string, args: string[], cwd: string, limitMs: number, graceMs = 10_000): Promise<CommandResult> {
  return new Promise((resolveRun) => {
    const chunks: string[] = [];
    let timedOut = false;
    let done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let kept = 0;
    // Same ceiling as the unlimited spawnSync path (maxBuffer 128MB): drop the oldest output beyond it, keep the tail.
    const keep = (d: string) => { chunks.push(d); kept += d.length; while (kept > 128 * 1024 * 1024 && chunks.length > 1) kept -= chunks.shift()!.length; };
    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);
    const signalGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* group already gone */ } };
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const tail = error ? `\n${error}` : timedOut ? `\nkilled after ${limitMs}ms (process group)` : '';
      resolveRun({ rc: code ?? 2, output: `${chunks.join('')}${tail}`, ...(timedOut ? { timedOut } : {}) });
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => signalGroup('SIGKILL'), graceMs));
      timers.push(setTimeout(() => finish(null), graceMs + 5_000));
    }, limitMs));
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

/**
 * GATE-MEM-ADMIT (0.2.20) — the gate's shard Jobs ask the same pool admission harness goal Pods ask
 * (`PodPoolScheduler.acquireAdmission` · memory headroom by observed usage · `limitedBy`). 0.2.19: 8 shards sat Pending
 * for CPU (requests 31.2/32) because harness Pods held the node and the gate counted only its own Jobs (#24698).
 * The gate never deadlocks on it: after {@link GATE_ADMISSION_WAIT_SECONDS_DEFAULT} it launches anyway and records
 * `admission-timeout`; an admission error launches at once (`admission-error`). Harness launches wait without a bound,
 * so the gate keeps priority.
 */
export interface GateAdmission {
  acquire(signal: AbortSignal): Promise<() => void>;
  /** The pool-wide reading admission waits on (recommended · limitedBy · memorySlots); null before any reading. */
  waitReason(): string | null;
}
export const GATE_ADMISSION_WAIT_SECONDS_DEFAULT = 300;
export type GateAdmissionOutcome = 'granted' | 'admission-timeout' | 'admission-error' | 'off';
export interface GateAdmissionResult { outcome: GateAdmissionOutcome; waitedMs: number; reason?: string; release: () => void }
export const gateAdmissionWaitText = (reading: string | null) => `메모리 여유 대기(admission) · ${reading ?? '측정 전'}`.slice(0, 160);
export function poolGateAdmission(pool: PodPoolScheduler): GateAdmission {
  return { acquire: (signal) => pool.acquireAdmission(signal, undefined, { gate: true }), waitReason: () => pool.waitReason() };
}
export async function admitGateShard(admission: GateAdmission | undefined, o: { waitMs: number; onWait: (reason: string) => void; reasonPollMs?: number; firstReasonMs?: number }): Promise<GateAdmissionResult> {
  const noop = () => {};
  if (!admission || !(o.waitMs > 0)) return { outcome: 'off', waitedMs: 0, release: noop };
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let lastReason: string | undefined;
  const tell = () => { lastReason = gateAdmissionWaitText(admission.waitReason()); o.onWait(lastReason); };
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, o.waitMs);
  // A grant inside the first moment never touches the shard row (no flapping in shards.json).
  let ticker: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => { tell(); ticker = setInterval(tell, o.reasonPollMs ?? 15_000); }, o.firstReasonMs ?? 1_000);
  try {
    const granted = await admission.acquire(controller.signal);
    // Released at placement and again after the Job (the launch may fail before placement): only the first counts.
    let released = false;
    const release = () => { if (!released) { released = true; granted(); } };
    return { outcome: 'granted', waitedMs: Date.now() - started, ...(lastReason ? { reason: lastReason } : {}), release };
  } catch (error) {
    if (timedOut) return { outcome: 'admission-timeout', waitedMs: Date.now() - started, reason: lastReason ?? gateAdmissionWaitText(admission.waitReason()), release: noop };
    return { outcome: 'admission-error', waitedMs: Date.now() - started, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160), release: noop };
  } finally {
    clearTimeout(deadline);
    clearTimeout(first);
    if (ticker) clearInterval(ticker);
  }
}

export function createGateRunner(repo: string, remote?: string, commandOverride?: GateRunner['command'], podCommand: (options: RunPodCommandOptions) => Promise<PodCommandResult> = runPodCommand, poolOverride?: PodPoolScheduler, podLogTail?: (job: PodCommandResult) => string): GateRunner {
  let remoteMirror: string | undefined;
  const localCommand: GateRunner['localCommand'] = async (cmd, args, cwd, limitMs) => {
    if (limitMs) return limitedLocalCommand(cmd, args, cwd, limitMs);
    const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}` };
  };
  const command: GateRunner['command'] = commandOverride ?? (remote
    ? async (cmd, args, cwd, limitMs) => {
      // A limited remote run is killed on the remote host; the local ssh deadline is a backstop.
      // GNU timeout signals its own process group: -s KILL would kill timeout too (ssh 255), so TERM first then KILL after 10s (124 / 137).
      // No coreutils timeout on the remote → run unlimited there and rely on the local ssh deadline.
      const limitPrefix = limitMs ? `$(command -v timeout >/dev/null 2>&1 && echo 'timeout -k 10 ${Math.ceil(limitMs / 1000)}') ` : '';
      // Start in /tmp, not the caller checkout. macOS resolves that symlink to /private/tmp before the child sees it;
      // the remote command still `cd`s to the quoted path, so either spelling is the same directory.
      const run = spawnSync('ssh', [remote, `PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH; export PATH; cd ${quote(cwd)} && ${limitPrefix}${[cmd, ...args].map(quote).join(' ')}`],
        { cwd: '/tmp', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...(limitMs ? { timeout: limitMs + 60_000, killSignal: 'SIGKILL' as const } : {}) });
      const timedOut = !!limitMs && (run.status === 124 || run.status === 137 || (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
      return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}`, ...(timedOut ? { timedOut } : {}) };
    }
    : localCommand);
  const podSweep = async (tree: string, logDir: string | undefined, pod: NonNullable<GateOptions['pod']>, only?: readonly string[]): Promise<CommandResult> => {
    const shardCount = pod.shards ?? 24;
    // GATE-TIMEOUT-HEAL ①: the configured value is the floor; each shard's own deadline is shardDeadlineSeconds(planned).
    const deadlineSeconds = pod.shardTimeoutSeconds ?? POD_SHARD_TIMEOUT_FLOOR_SECONDS;
    if (!pod.pool || !Number.isSafeInteger(shardCount) || shardCount < 1
      || !Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1) throw new Error('invalid pod sweep options');
    const head = await command('git', ['rev-parse', 'HEAD'], tree);
    check(head, 'cut tree HEAD');
    const commit = head.output.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid cut tree HEAD');
    const listed = await command('git', ['ls-files', '*.test.*'], tree);
    check(listed, 'git ls-files tests');
    const allFiles = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file)).sort();
    const onlySet = only ? new Set(only) : undefined;
    // GATE-PARTIAL: every planned file must exist at this commit — a deleted/renamed failing file would otherwise «pass»
    // by not running. Fail closed (gate error), never a smaller sweep than planned.
    const missing = only?.filter((file) => !allFiles.includes(file)) ?? [];
    if (missing.length) throw new Error(`partial plan file missing at this commit: ${missing.slice(0, 5).join(', ')}`);
    const files = onlySet ? allFiles.filter((file) => onlySet.has(file)) : allFiles;
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
    const { durations, wall: planWall } = planDurations(pod.durationSource);
    const memory = readFileMemory(join(tree, POD_MEMORY_SOURCE));
    // The TD1 measurements predate the fixture-only gate; do not isolate those five files at their old 2–13 GB peaks.
    const fixtureOnly = new Set([...GATE_NIGHTLY_AUDITS, 'test/guardian/dispatch-surface-contract.test.ts', 'test/user-config-mcp.test.ts']);
    const heavy = new Set(assignable.filter((file) => !fixtureOnly.has(file) && (memory.get(file) ?? 0) >= POD_HEAVY_FILE_MB));
    const light = assignable.filter((file) => !heavy.has(file));
    const shards = [
      ...(light.length ? planShards(light, durations, shardCount) : []),
      ...[...heavy].map((file) => ({ files: [file], plannedSeconds: durations.get(file) ?? 0 })),
    ];
    logPlanWalltime(planWall, shards);
    if (heavy.size) debug.log('release-loop.gate', 'pod-heavy-alone', { files: [...heavy], thresholdMb: POD_HEAVY_FILE_MB, memoryLimit: POD_ISOLATION_MEMORY_LIMIT });
    const known = assignable.filter((file) => durations.has(file)).length;
    debug.log('release-loop.gate', 'pod-shard-plan', {
      shards: shards.length, known, unknown: assignable.length - known,
      maxPlannedSeconds: Math.max(...shards.map((shard) => shard.plannedSeconds)),
      source: durations.size ? pod.durationSource : 'none',
    });
    // GATE-SPEED A3①: shard Pod CPU (`release.loop.gatePodCpu` · default request 1 / limit 4) — shards × request must fit the pool.
    const cpu = resolvePodCpu(pod.cpu);
    debug.log('release-loop.gate', 'shard-resources', { shards: shards.length, cpuRequest: cpu.request, cpuLimit: cpu.limit, cpuSource: pod.cpu ? 'config' : 'default' });
    const ready = poolOverride ? undefined : checkPodPool(parsePodPool(pod.pool), defaultKubectl);
    if (ready && !ready.ok) throw new Error('pod command: 풀의 노드가 하나도 준비되지 않았다');
    const poolScheduler = poolOverride ?? new PodPoolScheduler(ready!.ready);
    const configCache = typeof pod.bunCache === 'string' ? pod.bunCache.trim() : '';
    const envCache = process.env[POD_BUN_CACHE_HOST_PATH]?.trim();
    const bunCache = configCache || envCache || undefined;
    debug.log('release-loop.gate', 'pod-bun-cache', { source: configCache ? 'config' : envCache ? 'env' : 'none' });
    const cachePrefix = bunCache ? podBunCacheVolume(bunCache).shellPrefix : '';
    // GATE-INSTALL-CACHE: node-wide install slots (see pod-install-slots.ts for the measured cause and the safety argument).
    const installSlots = pod.installSlots ?? POD_INSTALL_SLOTS_DEFAULT;
    if (!Number.isSafeInteger(installSlots) || installSlots < 0) throw new Error('invalid pod sweep options');
    debug.log('release-loop.gate', 'pod-install-slots', { slots: installSlots, source: pod.installSlots !== undefined ? 'config' : 'default' });
    // GATE-MEM-ADMIT: every shard Job (retries and splits too) asks pool admission before it is placed.
    const admissionWaitSeconds = pod.admissionWaitSeconds ?? GATE_ADMISSION_WAIT_SECONDS_DEFAULT;
    if (!Number.isSafeInteger(admissionWaitSeconds) || admissionWaitSeconds < 0) throw new Error('invalid pod sweep options');
    // An injected pool (tests) runs without admission unless `pod.admission` is passed; the gate's own pool asks it.
    const gateAdmission = pod.admission ?? (poolOverride ? undefined : poolGateAdmission(poolScheduler));
    debug.log('release-loop.gate', 'pod-admission', { waitSeconds: admissionWaitSeconds, source: pod.admissionWaitSeconds !== undefined ? 'config' : 'default', enabled: !!gateAdmission && admissionWaitSeconds > 0 });
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
    const knownFailures = new Set(pod.knownFailures ?? []);
    const estimated = (paths: string[]) => paths.reduce((sum, file) => {
      const value = durations.get(file);
      return sum + (value !== undefined && Number.isFinite(value) && value >= 0 ? value : unknownSeconds);
    }, 0);
    const knownTimes = assignable.map((file) => durations.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const unknownSeconds = knownTimes.length ? (knownTimes[Math.floor((knownTimes.length - 1) / 2)]! + knownTimes[Math.floor(knownTimes.length / 2)]!) / 2 : 1;
    // GATE-LIVE-OBS — one row per root shard in the release ledger's shards.json (UX contract · src/release-loop/gate-shards.ts).
    // Retries and splits of a shard update its row. A write failure is logged and never stops the gate.
    const board: GateShard[] = shards.map((item, index) => ({ id: `pod-${index}`, state: 'pending', plannedMin: Math.round(item.plannedSeconds / 6) / 10 }));
    const flushBoard = () => {
      if (!pod.shardsFile) return;
      try { writeGateShards(pod.shardsFile.path, { v: 1, version: pod.shardsFile.version, updatedAt: new Date().toISOString(), shards: board }); }
      catch (error) { debug.log('release-loop.gate', 'shards-write-failed', { path: pod.shardsFile.path, error: String(error) }); }
    };
    const markShard = (shard: number, patch: Partial<GateShard>, clear: Array<keyof GateShard> = []) => {
      const row = board[shard];
      if (!row) return;
      const next: GateShard = { ...row, ...patch };
      for (const key of clear) delete next[key];
      if (JSON.stringify(next) === JSON.stringify(row)) return;
      board[shard] = next;
      flushBoard();
    };
    flushBoard();
    /** The gate's scheduler, seen through one shard: a slot wait and the Pod start become row states. */
    // GATE-MEM-ADMIT: `placed` releases the shard's admission once a member is chosen — from then on the Job is
    // Pending/Running in the cluster and the next admission reading counts it, so holding the lease would count it twice.
    const trackedPool = (shard: number, retry: boolean, placed: () => void = () => {}): PodPoolScheduler => ({
      members: poolScheduler.members,
      tryAcquire: async (...args: Parameters<PodPoolScheduler['tryAcquire']>) => {
        const member = await poolScheduler.tryAcquire(...args);
        if (member) placed();
        if (member) markShard(shard, { state: retry ? 'retry' : 'running', startedAt: board[shard]?.startedAt ?? new Date().toISOString() }, ['waitReason']);
        else markShard(shard, { waitReason: 'Pod 자리 대기' });
        return member;
      },
      release: (member: Parameters<PodPoolScheduler['release']>[0]) => poolScheduler.release(member),
    }) as unknown as PodPoolScheduler;
    const runShard = async (paths: string[], shard: number, depth = 0, branch = '', retriedNoOutput = false, fresh = pod.freshShards === true, parentAttempt?: string): Promise<{ runs: ShardRun[]; stalled: NonNullable<GateResult['stalledShards']> }> => {
      // 파일별 소요는 junit 으로 남긴다 — 콘솔 요약(판정 원천)은 그대로이고, 느린 시험 목록(K10 D4)·계층 분리(D2)의 자가 된다.
      // GATE-TIMEOUT-HEAL: parts (each with its own junit) under a soft deadline inside this shard's own Job deadline.
      const shardDeadline = shardDeadlineSeconds(estimated(paths), deadlineSeconds);
      const parts = shardParts(paths, (file) => estimated([file]));
      const memoryLimit = paths.length === 1 && (depth >= 1 || heavy.has(paths[0]!)) ? POD_ISOLATION_MEMORY_LIMIT : undefined;
      const podShell = gateShardShell({ parts, cdpPatterns, softSeconds: softDeadlineSeconds(shardDeadline), cachePrefix, installSlots });
      const runKey = createHash('sha256').update(JSON.stringify({ pool: pod.pool, podShell, memoryLimit: memoryLimit ?? null, deadlineSeconds: shardDeadline, bunCache: bunCache ?? null })).digest('hex');
      let start = Date.now();
      let admitted: GateAdmissionResult | undefined;
      let output: string | undefined;
      let junit: string | undefined;
      let rc: number | undefined;
      let jobExitCode: number | undefined;
      let lastFile: string | undefined;
      let jobFailed = false;
      let timedOut = false;
      let finished: string[] = [];
      let unfinishedLog: string | undefined;
      // The way down a previous attempt took wins over its own log: that log was not a verdict, or it would have no children.
      // The split this shard would take if it failed here — the same rule as the split code below (isolation at depth 2 ·
      // cap chunks for a big root shard · halves otherwise · none for one file).
      // Isolation follows only while this shard's isolation budget still covers every file (review r7) — the budget is the
      // shard's file count and isolations take disjoint files, so this holds unless the plan changed; if not, run the Pod.
      const splitChild = depth === 2 && paths.length > 1 ? (isolationRemaining[shard]! >= paths.length ? '-file-0' : undefined)
        : depth < 2 && paths.length > 1 ? (depth === 0 && paths.length > POD_SHARD_FILE_CAP ? '-c0' : '-0') : undefined;
      const found = !fresh && logDir ? previousShardDescent(logDir, `pod-${shard}${branch}`, commit, paths, runKey, parentAttempt, splitChild) : undefined;
      const descent = found?.way;
      const reused = !fresh && !descent && logDir ? previousShardResult(logDir, `pod-${shard}${branch}`, commit, paths, runKey, parentAttempt) : undefined;
      // This shard's attempt id: the recorded one when its way down is followed, a new one when a Pod runs. Children carry it.
      const attemptId = found?.attemptId ?? randomUUID();
      if (descent === 'retry') {
        // «descend» is only the way down; «resumed» comes from each leaf whose log reads cleanly (review r4).
        debug.log('release-loop.gate', 'pod-shard-descend', { shard, branch, files: paths.length, via: 'retry' });
        return runShard(paths, shard, depth, `${branch}-retry`, true, undefined, attemptId);
      }
      if (descent === 'split') {
        output = undefined;
        debug.log('release-loop.gate', 'pod-shard-descend', { shard, branch, files: paths.length, via: 'split' });
      } else if (reused) {
        output = reused.output;
        junit = reused.junit;
        rc = reused.rc;
        jobExitCode = 0;
        lastFile = lastStartedTestFile(output, paths);
      } else try {
        admitted = await admitGateShard(gateAdmission, { waitMs: admissionWaitSeconds * 1000, onWait: (reason) => markShard(shard, { waitReason: reason }) });
        if (admitted.outcome !== 'off') debug.log('release-loop.gate', 'shard-admission', { shard, branch, outcome: admitted.outcome, waitedMs: admitted.waitedMs, ...(admitted.reason ? { reason: admitted.reason } : {}) },
          admitted.outcome === 'granted' ? undefined : { level: 'warn' });
        // The admission wait is not the shard's run time: deadline/timeout judgment and the measured duration start here.
        start = Date.now();
        const job = await podCommand({
          pool: pod.pool, poolScheduler: trackedPool(shard, depth > 0 || branch !== '', admitted.release), clone: true, source: { kind: 'commit', sha: commit }, deadlineSeconds: shardDeadline,
          ...(bunCache ? { bunCache } : {}),
          ...(installSlots > 0 ? { installSlots: POD_INSTALL_SLOTS_HOST_PATH } : {}),
          ...(pod.cpu ? { cpu: pod.cpu } : {}),
          // 실패 뒤 다시 도는 파일 하나짜리 Job 은 메모리 한도를 올린다 — 16Gi 에선 무거운 한 파일이 혼자서도 OOM 이었다(09-30 `unwired-exports`).
          ...(memoryLimit ? { memoryLimit } : {}),
          name: `gate-${randomUUID()}`,
          command: ['bash', '-lc', podShell],
        });
        jobExitCode = job.exitCode;
        const read = readShardArtifacts(job.artifactsDir, parts);
        ({ output, junit, rc, timedOut, finished, unfinishedLog } = read);
        // A Job the cluster cut at its own deadline leaves no outbox at all: past the deadline with nothing is a timeout too.
        if (!timedOut && output === undefined && job.exitCode !== 0 && Date.now() - start >= shardDeadline * 1000) timedOut = true;
        lastFile = output === undefined && unfinishedLog === undefined ? undefined : lastStartedTestFile(`${output ?? ''}\n${unfinishedLog ?? ''}`, paths);
        if (!lastFile && (job.exitCode !== 0 || rc === undefined || (rc !== 0 && rc !== 1))) {
          try { lastFile = lastStartedTestFile(jobLogTail(job).split(/\r?\n/).slice(-200).join('\n'), paths); }
          catch { /* Log retrieval is diagnostic; do not hide the stalled shard. */ }
        }
      } catch {
        jobFailed = true;
      }
      // A launch that failed before placement still gives its admission back (release is idempotent).
      admitted?.release();
      const durationMs = Date.now() - start;
      // A reused shard keeps its files as they are — rewriting would replace the measured durationMs the next release plans by.
      if (logDir && !reused && !descent) {
        mkdirSync(logDir, { recursive: true });
        // GATE-SHARD-RESUME: the json is what makes a log reusable, so it goes first and comes back last — a stop between
        // the new log and the new json leaves no json, never the old Job's exit paired with the new log (review r8).
        rmSync(join(logDir, `pod-${shard}${branch}.json`), { force: true });
        const destination = join(logDir, `pod-${shard}${branch}.log`);
        if (output !== undefined) writeFileSync(destination, output, { mode: 0o600 });
        else rmSync(destination, { force: true });
        const junitDestination = join(logDir, `pod-${shard}${branch}.junit.xml`);
        if (junit !== undefined) writeFileSync(junitDestination, junit, { mode: 0o600 });
        else rmSync(junitDestination, { force: true });
        const unfinishedDestination = join(logDir, `pod-${shard}${branch}.unfinished.log`);
        if (unfinishedLog !== undefined) writeFileSync(unfinishedDestination, unfinishedLog, { mode: 0o600 });
        else rmSync(unfinishedDestination, { force: true });
        writeFileSync(join(logDir, `pod-${shard}${branch}.json`), JSON.stringify({ durationMs, rc: rc ?? null, ...(timedOut ? { reason: 'timeout', finishedFiles: finished.length } : {}), files: paths, plannedSeconds: estimated(paths), deadlineSeconds: shardDeadline, shardCount: shards.length, commit, runKey, attemptId, ...(parentAttempt ? { parentAttempt } : {}), jobExitCode: jobExitCode ?? null, jobFailed,
          ...(admitted && admitted.outcome !== 'off' ? { admission: admitted.outcome, admissionWaitMs: admitted.waitedMs } : {}) }) + '\n', { mode: 0o600 });
      }
      const installSeconds = parseInstallSeconds(output ?? '');
      // GATE-TIMEOUT-HEAL ③: a cut shard is «reason: timeout» (with the files that still finished), not a bare rc=null.
      if (!reused && !descent) debug.log('release-loop.gate', 'pod-shard', { shard, files: paths, durationMs, rc: rc ?? null, attempt: depth + 1, installSeconds, deadlineSeconds: shardDeadline, parts: parts.length,
        ...(timedOut ? { reason: 'timeout', finishedFiles: finished.length } : {}) });
      if (!reused && !descent) markShard(shard, { ...(installSeconds !== null ? { installSec: installSeconds } : {}), ...(rc !== undefined ? { rc } : {}), ...(timedOut ? { state: 'timeout' as const } : {}) });
      let clean = output?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const ran = clean && lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/);
      const passes = clean === undefined ? NaN : summaryCount(clean, 'pass');
      const fails = clean === undefined ? NaN : summaryCount(clean, 'fail');
      const errors = clean === undefined ? NaN : summaryCount(clean, 'error');
      let reason: ShardReason | undefined;
      let namedFailures: number | undefined;
      let unattributedDetail: string | undefined;
      if (descent === 'split') reason = 'incomplete';
      else if (timedOut) reason = 'timeout';
      else if (jobFailed || (jobExitCode !== undefined && jobExitCode !== 0) || (rc !== undefined && rc !== 0 && rc !== 1)) reason = 'job-failed';
      else if (!clean || rc === undefined) reason = 'no-output';
      else if (!ran || !Number.isFinite(passes) || !Number.isFinite(fails)
        || Number(ran[2]) === 0 || Number(ran[2]) > paths.length
        || (Number(ran[1]) === 0 && !(errors > 0))) reason = 'incomplete';
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
      // A reused result that the current tool cannot read cleanly is not a verdict: run that shard for real.
      if (reused && reason) {
        debug.log('release-loop.gate', 'pod-shard-resume-miss', { shard, branch, reason });
        return runShard(paths, shard, depth, branch, retriedNoOutput, true, parentAttempt);
      }
      // GATE-TIMEOUT-HEAL ④: a Pod that died before any test ran (no outbox · jobExitCode≠0 — 0.2.19: isolated retries
      // ending with exit 5, the source checkout) gets the same one fresh retry as «no output» instead of stalling the sweep.
      // 137 (killed · OOM) keeps the isolation path: re-running an OOM file only re-measures the same kill.
      const diedBeforeTests = reason === 'job-failed' && output === undefined && !jobFailed && jobExitCode !== undefined && jobExitCode !== 0
        && jobExitCode !== 137 && (paths.length === 1 || jobExitCode === 5);
      if ((reason === 'no-output' || diedBeforeTests) && !retriedNoOutput) {
        const retry = await runShard(paths, shard, depth, `${branch}-retry`, true, undefined, attemptId);
        debug.log('release-loop.gate', 'pod-shard-retry', { shard, files: paths, reason, outcome: retry.stalled[0]?.reason ?? 'ok' });
        return retry;
      }
      if (reason) {
        // GATE-SKIP-KNOWN-RETRY — a shard whose summary is complete but whose failures could not be read back (unattributed)
        // and whose every named failure is one the previous release already had is not re-run: re-running only re-measures
        // known failures (0.2.18 cut: 109 retry Pods · 1,840 shard-minutes, 4x the first pass). Those failures go to the
        // verdict as they are, so it still classifies them against the baseline (preexisting) — never silently dropped.
        if (reason === 'unattributed' && knownFailures.size && clean && ran) {
          const ids = shardFailureIds(clean, junit, fails, errors);
          const all = ids ? [...ids.failures, ...ids.errors] : [];
          if (ids && all.length && all.every((id) => knownFailures.has(id))) {
            debug.log('release-loop.gate', 'retry-skipped-known', { shard, failures: all.length });
            return { runs: [{ output: `${failureOutput(ids.failures, ids.errors)}\n`, rc: 1, pass: Number.isFinite(passes) ? passes : 0,
              fail: ids.failures.length, errors: ids.errors.length, ran: Number(ran[1]), files: Number(ran[2]),
              passedIds: junit ? junitPassedIds(junit) : [] }], stalled: [] };
          }
        }
        // GATE-ISOLATE-FAILED-FILES — with this shard's junit, only the files with a failing test or an unhandled error and
        // the files with no junit result (crashed · never reached) are re-run; the rest passed here and keep that result.
        // The narrowed set runs under its own branch (`-n`) at the same depth, so the usual split/isolation rules still apply
        // to it, and a resumed gate finds this shard's own log (not a `-c0`/`-0` child) and narrows the same way again.
        const narrowed = !descent ? retryFiles(paths, clean, junit, fails, errors) : undefined;
        if (narrowed && narrowed.length && narrowed.length < paths.length) {
          debug.log('release-loop.gate', 'retry-narrowed', { shard, before: paths.length, after: narrowed.length });
          const kept = new Set(paths.filter((file) => !narrowed.includes(file)));
          const passedIds = junitPassedIds(junit!).map(podRelative).filter((id) => { try { return kept.has(testFileOfId(id)); } catch { return false; } });
          const child = await runShard(narrowed, shard, depth, `${branch}-n`, false, undefined, attemptId);
          return { runs: [{ output: '', rc: 0, pass: passedIds.length, fail: 0, errors: 0, ran: passedIds.length, files: kept.size, passedIds },
            ...child.runs], stalled: child.stalled };
        }
        // 깊이 2 에서 «이름 없는 실패»·«불완전»도 파일 단위로 가른다 — 아니면 149파일 조각의 실패 하나가 끝까지 주인 없이 남는다(09-30 G1e 7번 조각: 요약 28 · 이름 27).
        // 로그 없이 죽은 조각(`no-output` · OOM)도 같다 — 09-30 G1f ② 4-0-0 은 150파일이 격리 0 으로 남았다.
        if (depth === 2 && paths.length > 1) {
          const count = Math.min(paths.length, isolationRemaining[shard]!);
          isolationRemaining[shard]! -= count;
          const children = await Promise.all(paths.slice(0, count).map(async (file, index) => {
            const child = await runShard([file], shard, depth + 1, `${branch}-file-${index}`, false, undefined, attemptId);
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
          const children = await Promise.all(chunks.map((chunk, i) => runShard(chunk, shard, 2, `${branch}-c${i}`, false, undefined, attemptId)));
          return { runs: children.flatMap((child) => child.runs), stalled: children.flatMap((child) => child.stalled) };
        }
        debug.log('release-loop.gate', 'pod-shard-split', { shard, depth, files: paths, reason });
        const middle = Math.ceil(paths.length / 2);
        const children = await Promise.all([
          runShard(paths.slice(0, middle), shard, depth + 1, `${branch}-0`, false, undefined, attemptId),
          runShard(paths.slice(middle), shard, depth + 1, `${branch}-1`, false, undefined, attemptId),
        ]);
        return { runs: children.flatMap((child) => child.runs), stalled: children.flatMap((child) => child.stalled) };
      }
      if (reused) debug.log('release-loop.gate', 'pod-shard-resumed', { shard, branch, files: paths.length, rc, durationMs: reused.durationMs ?? null });
      return { runs: [{ output: clean!, rc: rc!, pass: passes, fail: fails,
        errors: Number.isNaN(errors) ? 0 : errors,
        ran: Number(ran![1]), files: Number(ran![2]), passedIds: junit ? junitPassedIds(junit) : [] }], stalled: [] };
    };
    // 모든 조각이 끝난 뒤 판정한다 — 한 조각의 예외로 먼저 돌아가면 다른 Pod 가 도는 채로 정리가 시작된다(#22002 리뷰 R3).
    const settled = await Promise.allSettled(shards.map(async (item, shard) => {
      try {
        const done = await runShard(item.files, shard);
        const state = !done.stalled.length ? 'done' as const : done.stalled.some((stall) => stall.reason === 'timeout') ? 'timeout' as const : 'failed' as const;
        markShard(shard, { state, endedAt: new Date().toISOString() }, ['waitReason']);
        return done;
      } catch (error) {
        markShard(shard, { state: 'failed', endedAt: new Date().toISOString() }, ['waitReason']);
        throw error;
      }
    }));
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const stalledShards = results.flatMap((result) => result.stalled);
    const measured = results.flatMap((result) => result.runs);
    const total = measured.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
      errors: sum.errors + run.errors, ran: sum.ran + run.ran, files: sum.files + run.files }),
    { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
    if (stalledShards.some((item) => item.reason !== 'no-output' || item.files.length !== 1)) throw new StalledPodShards(stalledShards, total);
    if (total.ran === 0 && total.errors === 0 && !stalledShards.length) throw new Error('sweep incomplete: no tests ran');
    const outputs = measured.map((run) => run.output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
    return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`,
      passedIds: [...new Set(measured.flatMap((run) => run.passedIds))].sort(),
      stalledEnv: stalledShards.flatMap((item) => item.files.map((file) => ({ file, reason: 'no-output' as const }))) };
  };
  return {
    command,
    localCommand: commandOverride && !remote ? commandOverride : localCommand,
    get remoteMirror() { return remoteMirror; },
    set remoteMirror(path) { remoteMirror = path; },
    async sweep(tree, logDir, pod, only) {
      if (pod) return podSweep(tree, logDir, pod, only);
      const listed = await command('git', ['ls-files', '*.test.*'], tree);
      check(listed, 'git ls-files tests');
      const allFiles = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
      const onlySet = only ? new Set(only) : undefined;
      const missing = only?.filter((file) => !allFiles.includes(file)) ?? [];
      if (missing.length) throw new Error(`partial plan file missing at this commit: ${missing.slice(0, 5).join(', ')}`);
      const files = onlySet ? allFiles.filter((file) => onlySet.has(file)) : allFiles;
      const groups = onlySet ? [{ name: 'partial', paths: files }] : [
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

const fileOf = testFileOfId;

/**
 * GATE-BASELINE-CACHE (0.2.18) — the isolated `bun run test:deterministic <file>` result of one test file at one commit,
 * kept in the machine ledger so a later gate does not run it again (0.2.17: the failing files were re-run on the previous
 * release commit although that release had already measured them). Cache format harvested from draft #24500.
 * `host` is where the result was measured (`local` or the ssh host) — a result from another host is a miss.
 * Timeouts are never stored: an environment stall is measured again, not remembered.
 */
export interface BaselineFileResult { commit: string; file: string; host: string; failures: string[]; errors: string[]; missing: boolean }
export const baselineCachePath = (ledger: string, commit: string) => join(ledger, 'gate-baseline-cache', `${commit}.jsonl`);
function validFileResult(value: unknown, commit: string): value is BaselineFileResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BaselineFileResult>;
  if (row.commit !== commit || typeof row.file !== 'string' || typeof row.host !== 'string' || !row.host.trim()
    || typeof row.missing !== 'boolean' || !Array.isArray(row.failures) || !Array.isArray(row.errors)
    || (row.missing && (row.failures.length || row.errors.length))) return false;
  try {
    fileOf(`${row.file} > case`);
    return [...row.failures, ...row.errors].every((id) => typeof id === 'string' && fileOf(id) === row.file);
  } catch { return false; }
}
/** A missing cache file is empty; any unreadable or invalid row discards the whole file — it is never read as a pass. */
export function readBaselineFileCache(ledger: string, commit: string): Map<string, BaselineFileResult> {
  const entries = new Map<string, BaselineFileResult>();
  if (!sha.test(commit)) return entries;
  const path = baselineCachePath(ledger, commit);
  if (!existsSync(path)) return entries;
  try {
    // The writer always ends with one newline and never writes an empty line — anything else is a damaged file.
    const text = readFileSync(path, 'utf8');
    if (!text.endsWith('\n')) throw new Error('missing final newline');
    for (const line of text.slice(0, -1).split('\n')) {
      if (!line.trim()) throw new Error('empty line');
      const row: unknown = JSON.parse(line);
      if (!validFileResult(row, commit)) throw new Error('invalid row');
      entries.set(`${row.file}\0${row.host}`, row);
    }
  } catch (error) {
    debug.log('release.gate', 'baseline-cache-corrupt', { path, error: String(error) });
    entries.clear();
  }
  return entries;
}
export function saveBaselineFileCache(ledger: string, commit: string, rows: BaselineFileResult[]): void {
  if (!rows.length || !sha.test(commit)) return;
  const entries = readBaselineFileCache(ledger, commit);
  for (const row of rows) entries.set(`${row.file}\0${row.host}`, row);
  const path = baselineCachePath(ledger, commit);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.gate-baseline-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, [...entries.values()].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp); }
}

export async function judgeGate(opts: GateOptions, runner: GateRunner = createGateRunner(opts.repo ?? process.cwd(), opts.remote)): Promise<GateResult> {
  const start = Date.now();
  const explicitConfig = getElanousConfigDirOverride();
  const root = explicitConfig ? effectiveInstanceRoot() : (opts.instanceRoot ?? effectiveInstanceRoot());
  // The freeze is read from the same root the gate runs in (a config-dir override must not move it elsewhere).
  const frozen = readLandingFreeze(root);
  if (frozen) {
    debug.log('release.run', opts.forceFreeze ? 'freeze-forced' : 'frozen', { version: opts.version, reason: frozen.reason, until: frozen.until, node: 'gate' });
    if (!opts.forceFreeze) throw new Error(landingFreezeMessage(frozen));
  }
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
  const result: GateResult = { outcome: 'error', commit: opts.commit, introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], durationMs: 0 };
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
    // GATE-PARTIAL: a plan made by `release resume --from gate --partial` for exactly this commit re-runs only its files.
    // Its logs go to cut-partial/ — the full cut/ logs stay whole (the next release reads them as a baseline source).
    const partial = readPartialPlan(roots, opts.version, opts.commit);
    if (partial) debug.log('release-loop.gate', 'partial-regate', { version: opts.version, priorCommit: partial.priorCommit, commit: opts.commit, files: partial.files.length });
    // GATE-SKIP-KNOWN-RETRY — the ids the verdict will not count as introduced (the recorded baseline ⊕ env-known), read
    // before the sweep so a shard failing only with them skips its isolation retries. No recorded baseline = no skip.
    let knownFailures: string[] = [];
    if (opts.pod) {
      try {
        const knownSha = opts.baselineCommit ?? baselineReleaseCommit(opts.baselineVersion);
        const saved = cachedBaseline(opts.baselineVersion, knownSha)?.saved;
        const recorded = saved ? undefined : baselineFromCutLogs(join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut'), knownSha);
        const trustedKnown = saved ?? (recorded?.complete ? recorded : undefined);
        if (trustedKnown) knownFailures = [...trustedKnown.failures, ...(trustedKnown.errors ?? []), ...loadEnvKnownFailures(repo)];
      } catch (error) { debug.log('release-loop.gate', 'known-failures-unavailable', { error: String(error) }); }
    }
    const cutRun = await runner.sweep(cutTree, join(root, 'release', opts.version, 'gate-logs', partial ? 'cut-partial' : 'cut'),
      opts.pod ? { ...opts.pod, durationSource: join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut'), ...(knownFailures.length ? { knownFailures } : {}),
        // GATE-LIVE-OBS: the release ledger's shards.json (UX #24782) — never the run tree's universe; an explicit
        // --ledger-root (tests) keeps it in that ledger.
        shardsFile: { path: opts.ledgerRoot ? gateShardsPath(opts.version, opts.ledgerRoot) : gateShardsPath(opts.version), version: opts.version } } : undefined,
      partial?.files);
    const localStalled = async (run: CommandResult, tree: string, commit: string, label: string) => {
      const stalled = run.stalledEnv ?? [];
      const noCompletedShard = stalled.length && run.rc === 0
        && /(?:^|\n)0 pass\n0 fail\n0 errors\nRan 0 tests across 0 files\./.test(run.output);
      const measured: SweepFailures = noCompletedShard ? { failures: [], errors: [] } : failuresOf(run, `${label} sweep`);
      if (!stalled.length) return measured;
      let hostTree = tree;
      const local: GateResult['stalledEnv'] = [];
      try {
        if (opts.remote) {
          hostTree = join(mkdtempSync(join(tmpdir(), 'release-gate-local-')), 'cut');
          check(await runner.localCommand('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, hostTree], repo), 'host cut clone');
          check(await runner.localCommand('git', ['checkout', '--quiet', '--detach', commit], hostTree), 'host cut checkout');
          for (const dir of [hostTree, join(hostTree, 'apps/pwa')]) check(await runner.localCommand('bun', ['install'], dir), `host bun install ${dir}`);
        }
        for (const { file, reason } of stalled) {
          if (!/^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`unsafe test path: ${file}`);
          // 0.2.15: InsidePage.test.tsx gave no Pod output and then hung on the host with headless Chrome — the run could only fail.
          const isolated = await runner.localCommand('bun', ['run', 'test:deterministic', asPath(file)], hostTree, GATE_ISOLATED_TIMEOUT_MS);
          // A file that stalls in its Pod shard and again on the host is an environment stall: record it, measure nothing from it.
          if (isolated.timedOut) {
            // Grandchildren (e.g. headless Chrome) can outlive the kill — the event lets the next release see a repeat.
            debug.log('release-loop.gate', 'isolated-timeout', { file, label, limitMs: GATE_ISOLATED_TIMEOUT_MS });
            local.push({ file, reason, local: 'timeout' });
            continue;
          }
          const parsed = failuresOf(isolated, `${label} host isolated ${file}`);
          if ([...parsed.failures, ...parsed.errors].some((id) => fileOf(id) !== file)) throw new Error(`host isolated run attributed to another file: ${file}`);
          measured.failures.push(...parsed.failures);
          measured.errors.push(...parsed.errors);
          local.push({ file, reason, local: parsed.failures.length || parsed.errors.length ? 'failed' : 'passed' });
        }
      } finally {
        if (opts.remote && hostTree !== tree) rmSync(dirname(hostTree), { recursive: true, force: true });
      }
      result.stalledEnv.push(...local);
      debug.log('release-loop.gate', 'pod-shard-stalled-env', { files: stalled.map(({ file, reason }) => ({ file, reason })), local });
      return measured;
    };
    const measuredCut = await localStalled(cutRun, cutTree, opts.commit, 'cut');
    const cut = partial ? mergePartialFailures(partial, measuredCut) : measuredCut;
    if (partial) result.partial = { priorCommit: partial.priorCommit, files: partial.files.length };
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
      // GATE-SPEED A4 (RFC-release-gate-under-30min §A4) — with no recorded baseline only the files that failed at the cut
      // are swept at the previous release; a passing cut file needs no comparison. Files absent there stay new failures.
      const cutFiles = [...new Set([...cut.failures, ...cut.errors].map(fileOf))].sort();
      let present: string[] = [];
      if (cutFiles.length) {
        const tree = await getBaseTree();
        // -z: the default output quotes paths with special characters, which would read as absent.
        const listed = await runner.command('git', ['ls-files', '-z', '--', ...cutFiles], tree);
        check(listed, 'baseline ls-files');
        const known = new Set(listed.output.split('\0'));
        present = cutFiles.filter((file) => known.has(file));
      }
      result.baselineDeferred = { cutFiles: cutFiles.length, swept: present.length };
      debug.log('release-loop.gate', 'baseline-deferred', { version: opts.baselineVersion, commit: baseSha, cutFiles: cutFiles.length, swept: present.length });
      if (present.length) {
        // K9b — the baseline is swept on the same Pod pool as the cut, not on this host (0.2.6: an hour of local baseline
        // after a 23-minute Pod cut).
        const baseRun = await runner.sweep(baseTree!, join(root, 'release', opts.version, 'gate-logs', 'baseline'),
          opts.pod ? { ...opts.pod, durationSource: join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut') } : undefined,
          present);
        baseline = await localStalled(baseRun, baseTree!, baseSha, 'baseline');
      } else baseline = { failures: [], errors: [] };
    }
    for (const id of [...baseline.failures, ...baseline.errors, ...cut.failures, ...cut.errors]) fileOf(id);
    const known = opts.pod ? loadEnvKnownFailures(repo) : new Set<string>();
    const cutIds = [...cut.failures, ...cut.errors];
    const cutHostFailed = new Set(cutRun.stalledEnv?.map(({ file }) => file) ?? []);
    const baselineIds = [...baseline.failures, ...baseline.errors];
    const countedCut = splitKnownEnv(cutIds, known);
    const countedBaseline = splitKnownEnv(baselineIds, known);
    result.knownEnv = countedCut.knownEnv.length;
    result.knownEnvCleared = [...new Set(cutRun.passedIds ?? [])].filter((id) => known.has(id) && !cutIds.includes(id) && !cutRun.stalledEnv?.some(({ file }) => fileOf(id) === file)).sort();
    const diff = diffFailures(countedCut.counted, countedBaseline.counted);
    result.fixed = result.baselineDeferred ? null : diff.fixed.length;
    result.preexisting = diff.common.length;
    // GATE-BASELINE-CACHE — only the files whose new failures reproduce in isolation reach the baseline, and each
    // (commit, file, host) is run at most once across gates: this gate's cut results also seed the next gate's baseline.
    const cacheHost = opts.remote ?? 'local';
    const newFailureFiles = new Set(diff.newFailures.map(fileOf));
    const baseCache = newFailureFiles.size ? readBaselineFileCache(ledger, baseSha) : new Map<string, BaselineFileResult>();
    const cacheStats = { hits: 0, misses: 0 };
    const remember = (row: BaselineFileResult) => {
      // Only a row the reader would accept is stored; an unstorable result skips the cache and leaves the verdict alone.
      const { commit, file } = row;
      if (!validFileResult(row, commit)) {
        debug.log('release.gate', 'baseline-cache-skip', { commit, file });
        return;
      }
      try { saveBaselineFileCache(ledger, row.commit, [row]); }
      catch (error) { debug.log('release.gate', 'baseline-cache-write-failed', { commit: row.commit, file: row.file, error: String(error) }); }
    };
    for (const file of newFailureFiles) {
      // 0.2.15: the cut re-check of a new-failure file (InsidePage.test.tsx · headless Chrome) hung for good — limit it like the host re-run.
      const cutCheck = cutHostFailed.has(file) ? undefined : await runner.command('bun', ['run', 'test:deterministic', asPath(file)], cutTree, GATE_ISOLATED_TIMEOUT_MS);
      if (cutCheck?.timedOut) {
        debug.log('release-loop.gate', 'isolated-timeout', { file, label: 'cut isolated', limitMs: GATE_ISOLATED_TIMEOUT_MS });
        result.stalledEnv.push({ file, reason: 'isolated-timeout', local: 'timeout' });
        continue;
      }
      const isolatedCut = cutCheck === undefined
        ? { failures: cut.failures.filter((id) => fileOf(id) === file), errors: cut.errors.filter((id) => fileOf(id) === file) }
        : failuresOf(cutCheck, `cut isolated ${file}`);
      if (cutCheck !== undefined) remember({ commit: opts.commit, file, host: cacheHost, failures: isolatedCut.failures, errors: isolatedCut.errors, missing: false });
      const reproduced = new Set([...isolatedCut.failures, ...isolatedCut.errors]);
      let candidates = diff.newFailures.filter((id) => fileOf(id) === file && reproduced.has(id));
      // GATE-INTRO-RECHECK — a new failure that is only bun's «timed out» shape gets one more isolated run with a generous
      // per-test limit, on the same runner (node-b when the gate is remote). Passing there = flaky under load (warning);
      // an assertion failure, a failure again, or a run that cannot be read stays introduced.
      const timedOut = cutCheck === undefined ? new Set<string>() : new Set(parseTimedOutFailures(stripPodRepoRoot(cutCheck.output)));
      const shaped = candidates.filter((id) => timedOut.has(id) && isolatedCut.failures.includes(id));
      if (shaped.length) {
        const relaxed = await runner.command('bun', ['run', 'test:deterministic', asPath(file), '--timeout', String(GATE_TIMEOUT_RECHECK_MS)], cutTree, GATE_ISOLATED_TIMEOUT_MS);
        let flaky: string[] = [];
        let recheck: 'read' | 'timeout' | 'unreadable' = 'read';
        if (relaxed.timedOut) recheck = 'timeout';
        else {
          try {
            const again = failuresOf(relaxed, `cut timeout recheck ${file}`);
            const still = new Set([...again.failures, ...again.errors]);
            flaky = again.errors.length ? [] : shaped.filter((id) => !still.has(id));
          } catch { recheck = 'unreadable'; }
        }
        debug.log('release-loop.gate', 'timeout-recheck', { file, shaped: shaped.length, flaky: flaky.length, recheck, remote: opts.remote ?? 'local', limitMs: GATE_TIMEOUT_RECHECK_MS });
        if (flaky.length) {
          (result.loadFlaky ??= []).push(...flaky);
          candidates = candidates.filter((id) => !flaky.includes(id));
          try {
            const path = loadFlakyCensusPath(ledger);
            mkdirSync(dirname(path), { recursive: true });
            const at = new Date().toISOString();
            appendFileSync(path, flaky.map((id) => JSON.stringify({ at, version: opts.version, commit: opts.commit, id, host: cacheHost, limitMs: GATE_TIMEOUT_RECHECK_MS }) + '\n').join(''), { mode: 0o600 });
          } catch (error) { debug.log('release-loop.gate', 'load-flaky-census-write-failed', { file, error: String(error) }); }
        }
      }
      if (candidates.length === 0) continue;
      let oldFailures: Set<string>;
      const hit = baseCache.get(`${file}\0${cacheHost}`);
      if (hit) {
        cacheStats.hits++;
        oldFailures = new Set([...hit.failures, ...hit.errors]);
      } else {
        cacheStats.misses++;
        const baselineTree = await getBaseTree();
        const previous = await runner.command('bun', ['run', 'test:deterministic', asPath(file)], baselineTree, GATE_ISOLATED_TIMEOUT_MS);
        if (previous.timedOut) {
          debug.log('release-loop.gate', 'isolated-timeout', { file, label: 'baseline isolated', limitMs: GATE_ISOLATED_TIMEOUT_MS });
          result.stalledEnv.push({ file, reason: 'isolated-timeout', local: 'timeout' });
          continue;
        }
        if (/No tests found|had no matches/i.test(previous.output) && previous.rc === 1) {
          const lookup = await runner.command('git', ['ls-tree', '--name-only', baseSha, '--', file], opts.remote ? baselineTree : repo);
          if (lookup.rc !== 0 || lookup.output.trim()) throw new Error(`baseline isolated run incomplete: ${file}`);
          oldFailures = new Set();
          remember({ commit: baseSha, file, host: cacheHost, failures: [], errors: [], missing: true });
        } else {
          const prior = failuresOf(previous, `baseline isolated ${file}`);
          oldFailures = new Set([...prior.failures, ...prior.errors]);
          remember({ commit: baseSha, file, host: cacheHost, failures: prior.failures, errors: prior.errors, missing: false });
        }
      }
      for (const id of candidates) {
        if (oldFailures.has(id)) result.preexisting++;
        else result.introduced.push(id);
      }
    }
    result.baselineCache = cacheStats;
    debug.log('release.gate', 'baseline-cache', { hits: cacheStats.hits, misses: cacheStats.misses, commit: baseSha });
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
  if (cutFailures && !result.stalledShards?.length && !result.stalledEnv.length) {
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
    summary: (result.partial ? `부분 재검 ${result.partial.files}파일(앞 게이트 ${result.partial.priorCommit.slice(0, 9)} 결과 이음) · ` : '')
      + (result.outcome === 'ok' ? `새 회귀 ${result.introduced.length} · 기존 ${result.preexisting} · 고침 ${result.fixed ?? '못 셈(기준선 미루기)'}` : `게이트 ${result.outcome}: ${result.error ?? result.introduced.length + ' new regressions'}`) + ` · 환경 알려진 실패 ${result.knownEnv}`
      + (result.loadFlaky?.length ? ` · ⚠ 부하 흔들림 ${result.loadFlaky.length}(시간 초과 꼴 · ${GATE_TIMEOUT_RECHECK_MS / 1000}s 재실행 통과 · 막지 않음)` : '')
      + (result.stalledEnv.length ? ` · 환경 멈춤 ${result.stalledEnv.length} (Pod 밖 통과 ${result.stalledEnv.filter((item) => item.local === 'passed').length})` : '') };
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
    forceFreeze: fromGraph.forceFreeze === true,
    baselineCommit: typeof fromGraph.previousCommit === 'string' ? fromGraph.previousCommit : undefined,
    remote: typeof fromGraph.gateRemote === 'string' ? fromGraph.gateRemote : undefined,
    remoteMirror: typeof fromGraph.gateRemoteMirror === 'string' ? fromGraph.gateRemoteMirror : undefined,
    pod: typeof fromGraph.gatePodPool === 'string' ? {
      pool: fromGraph.gatePodPool,
      ...(fromGraph.gatePodShards !== undefined ? { shards: Number(fromGraph.gatePodShards) } : {}),
      ...(fromGraph.gatePodShardTimeoutSeconds !== undefined ? { shardTimeoutSeconds: Number(fromGraph.gatePodShardTimeoutSeconds) } : {}),
      ...(typeof fromGraph.gatePodBunCache === 'string' && fromGraph.gatePodBunCache.trim() ? { bunCache: fromGraph.gatePodBunCache } : {}),
      ...(fromGraph.gatePodInstallSlots !== undefined ? { installSlots: Number(fromGraph.gatePodInstallSlots) } : {}),
      ...(fromGraph.gatePodAdmissionWaitSeconds !== undefined ? { admissionWaitSeconds: Number(fromGraph.gatePodAdmissionWaitSeconds) } : {}),
      ...(fromGraph.gatePodFreshShards === true ? { freshShards: true } : {}),
      ...((cpu) => cpu ? { cpu } : {})(parsePodCpu(fromGraph.gatePodCpu, 'release.loop.gatePodCpu')),
    } : undefined,
  };
  let freshShards = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return 'help';
    if (arg === '--json') continue;
    // Applied after the loop and only to a Pod gate — on its own it must not turn a local gate into a Pod one (review r5).
    if (arg === '--fresh-shards') { freshShards = true; continue; }
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
  if (freshShards && opts.pod) opts.pod = { ...opts.pod, freshShards: true };
  return opts;
}

if (import.meta.main) {
  const start = Date.now();
  // The graph spawns this file as its own process, which inherits no daemon sink — without this every
  // `release-loop.gate`/`release.gate`/`pod.pool` event stayed in the file trail and `elanous logs` read 0 rows.
  await registerStandaloneLogSink('release-loop');
  let result: GateResult;
  let version = '';
  try {
    const opts = parseOptions(process.argv.slice(2), process.env);
    if (opts === 'help') {
      console.log('Usage: bun scripts/release-loop/gate-node.ts --commit <sha> --version <v> [--baseline-version <prev>] [--baseline-commit <sha>] [--remote <ssh-host>] [--remote-mirror <path>] [--pod-pool <pool>] [--pod-shards <n>] [--pod-shard-timeout-seconds <n>] [--fresh-shards] [--json]\nWithout flags, input.commit, input.version and input.previousVersion come from the JSON file at ELANOUS_GRAPH_CONTEXT.');
      process.exit(0);
    }
    version = opts.version;
    result = await judgeGate(opts);
  } catch (error) {
    result = { outcome: 'error', commit: '', introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], durationMs: Date.now() - start, error: String(error) };
  }
  if (result.error) console.error(result.error);
  debug.log('release-loop.gate', 'result', { version, outcome: result.outcome });
  emitNodeResult(graphGateResult(result, !!process.env.ELANOUS_GRAPH_CONTEXT));
  process.exitCode = result.outcome === 'ok' ? 0 : result.outcome === 'regression' ? 1 : 2;
}
