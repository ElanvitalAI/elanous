#!/usr/bin/env bun
/** On node-b, from a clean main checkout: bun scripts/measure-gate-shards.ts --shards 4 --measurements docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv
 * Runs the same tracked gate test files once together and once in GT2 memory-budgeted bundles.
 * Missing TSV planning rows are measured individually on this machine before either comparison run;
 * allow time for that calibration when the historical TSV is stale. No guessed RSS is used.
 * Each mode uses the same machine, Bun executable and deterministic test environment. stdout is one JSON line;
 * stderr contains diagnostics. RSS is the maximum sampled sum of process-group RSS (50 ms resolution).
 * Peak RSS is sampling-dependent and excludes memory after a process leaves its group.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planGateTestShards } from '../src/self-dev/shard-plan.js';
import { prepareIsolatedTestEnv, deriveCdpTestPatterns } from './test-deterministic.js';

export interface GateMeasurement {
  mode: 'unsharded' | 'sharded';
  durationMs: number;
  peakRssMb: number;
  // Confirmed OOMs only; an unknown termination is counted separately.
  oomCount: number;
  unknownTerminations: number;
  oomCountStatus: 'confirmed' | 'partial';
  verdict: 'passed' | 'failed' | 'unmeasured';
  cases: Record<string, 'passed' | 'failed'>;
  runs: number;
}

export interface GateComparison {
  commit: string;
  machine: string;
  files: number;
  shards: number;
  unsharded: GateMeasurement;
  sharded: GateMeasurement;
  verdictAgrees: boolean;
}

export function readGateMeasurements(path: string): { rss: Map<string, number>; seconds: Map<string, number> } {
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  const header = lines.shift()?.split('\t') ?? [];
  const fileAt = header.indexOf('file'), rssAt = header.indexOf('rss_mb'), secondsAt = header.indexOf('secs');
  if (fileAt < 0 || rssAt < 0 || secondsAt < 0) throw new Error('measurement TSV needs file, rss_mb and secs columns');
  const rss = new Map<string, number>(), seconds = new Map<string, number>();
  for (const line of lines) {
    const cells = line.split('\t');
    const file = cells[fileAt], mb = Number(cells[rssAt]), sec = Number(cells[secondsAt]);
    if (!file || rss.has(file) || !cells[rssAt] || !cells[secondsAt] || !Number.isFinite(mb) || mb <= 0 || !Number.isFinite(sec) || sec < 0) {
      throw new Error(`invalid measurement row: ${line}`);
    }
    rss.set(file, mb);
    seconds.set(file, sec);
  }
  return { rss, seconds };
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function trackedGateFiles(repo: string): { commit: string; files: string[] } {
  if (git(repo, ['rev-parse', '--show-toplevel']) !== resolve(repo)) throw new Error('run from the repository root');
  if (git(repo, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('measurement requires the main checkout');
  if (git(repo, ['status', '--porcelain'])) throw new Error('measurement requires a clean main checkout');
  const commit = git(repo, ['rev-parse', 'HEAD']);
  const files = git(repo, ['ls-files', '*.test.*']).split('\n').filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file))
    .filter((file) => !file.split('/').some((part) => part.startsWith('.'))).sort();
  if (!files.length) throw new Error('no gate tests found');
  return { commit, files };
}

/** Fill missing in-memory planning rows from actual single-file runs, never an assumed RSS. */
export async function calibrateMissingGateMeasurements(options: {
  repo: string; files: readonly string[]; rss: Map<string, number>; seconds: Map<string, number>;
}): Promise<void> {
  const { repo, files, rss, seconds } = options;
  const missing = files.filter((file) => !rss.has(file) || !seconds.has(file));
  if (!missing.length) return;
  console.error(`calibrating ${missing.length} gate files missing from the historical TSV on this machine`);
  const root = mkdtempSync(join(tmpdir(), 'gate-shards-calibrate-'));
  try {
    for (const [index, file] of missing.entries()) {
      const env = prepareIsolatedTestEnv(process.env, join(root, `env-${index}`));
      const report = join(root, `case-${index}.xml`);
      const started = performance.now();
      const child = Bun.spawn(['bun', 'test', '--reporter=junit', `--reporter-outfile=${report}`, `./${file}`], {
        cwd: repo, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', detached: true,
      });
      let peakKb = 0;
      const sample = () => {
        const ps = spawnSync('ps', ['-e', '-o', 'pgid=', '-o', 'rss='], { encoding: 'utf8' });
        if (ps.status !== 0) throw new Error(`RSS calibration sampling failed: ${file}`);
        const kb = ps.stdout.split('\n').reduce((sum, line) => {
          const [group, value] = line.trim().split(/\s+/).map(Number);
          return group === child.pid && Number.isFinite(value) ? sum + value! : sum;
        }, 0);
        peakKb = Math.max(peakKb, kb);
      };
      const interval = setInterval(sample, 50);
      let stderr: string, code: number;
      try {
        sample();
        stderr = await new Response(child.stderr).text();
        code = await child.exited;
        sample();
      } finally { clearInterval(interval); }
      let cases: Record<string, 'passed' | 'failed'>;
      try { cases = readCases(readFileSync(report, 'utf8'), [file]); }
      catch (error) { throw new Error(`calibration JUnit incomplete for ${file}: ${error}`); }
      const failed = Object.values(cases).includes('failed');
      if (child.signalCode || peakKb === 0 || (code !== 0 && code !== 1) || (code === 0 && failed) || (code === 1 && !failed)) {
        throw new Error(`calibration incomplete for ${file}: code=${code} signal=${child.signalCode ?? 'none'} ${stderr.slice(-500)}`);
      }
      rss.set(file, Math.ceil(peakKb / 1024));
      seconds.set(file, (performance.now() - started) / 1000);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Bun JUnit writes one testsuite per file. Require every expected file and every declared case,
// including failures/errors; missing or truncated output is unmeasured, never a passing verdict.
export function readCases(xml: string, files: readonly string[]): Record<string, 'passed' | 'failed'> {
  const expected = new Set(files), seen = new Set<string>();
  const cases: Record<string, 'passed' | 'failed'> = Object.create(null);
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)];
  if (!/<testsuites\b/.test(xml) || !/<\/testsuites>\s*$/.test(xml)) throw new Error('incomplete JUnit document');
  const attr = (text: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(text)?.[1];
  for (const [, attrs, body] of suites) {
    const file = attr(attrs!, 'file') ?? attr(attrs!, 'name');
    if (!file || !expected.has(file) || seen.has(file)) throw new Error(`unexpected or repeated JUnit suite: ${file}`);
    seen.add(file);
    const tests = Number(attr(attrs!, 'tests'));
    const entries = [...body!.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
    if (!Number.isSafeInteger(tests) || tests < 1 || entries.length !== tests) throw new Error(`incomplete JUnit suite: ${file}`);
    for (const [, properties, contents] of entries) {
      const name = attr(properties!, 'name'), caseFile: string = attr(properties!, 'file') ?? file;
      const className = attr(properties!, 'classname');
      if (!name || caseFile !== file || /<skipped\b/.test(contents ?? '')) throw new Error(`incomplete JUnit case: ${file}`);
      const id = `${file} > ${className && className !== file ? `${className} > ` : ''}${name}`;
      if (id in cases) throw new Error(`duplicate JUnit case: ${id}`);
      cases[id] = /<(?:failure|error)\b/.test(contents ?? '') ? 'failed' : 'passed';
    }
  }
  if (seen.size !== expected.size) throw new Error(`missing JUnit suites: ${[...expected].filter((file) => !seen.has(file)).join(', ')}`);
  return cases;
}

// A private cgroup records kernel-attributed OOM kills for exactly one test bundle.
// A host without delegated cgroup v2 write access cannot classify abnormal exits as OOM.
function oomKills(path: string): number {
  const line = readFileSync(join(path, 'memory.events'), 'utf8').split('\n').find((entry) => entry.startsWith('oom_kill '));
  const value = Number(line?.slice('oom_kill '.length));
  if (!line || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid cgroup oom_kill counter: ${path}`);
  return value;
}

interface Run { code: number | null; signal: string | null; xml: string; stderr: string; oomKills: number | null }

export async function measureGateComparison(options: {
  repo: string; files: string[]; commit: string; shards: number; rss: ReadonlyMap<string, number>;
  seconds: ReadonlyMap<string, number>; budgetGiB?: number;
  /** Fixture-only cgroup filesystem; production always uses the calling process's cgroup v2. */
  cgroupRoot?: string;
  /** Test-only creation hook for a synthetic cgroup v2 fixture. */
  onCgroupCreated?: (path: string) => void;
}): Promise<GateComparison> {
  const { repo, files, commit, shards, rss, seconds } = options;
  if (!Number.isSafeInteger(shards) || shards < 1 || files.length === 0 || new Set(files).size !== files.length) throw new Error('invalid shard count or files');
  const bundles = planGateTestShards(files, rss, seconds, options.budgetGiB ?? 8, shards);
  const root = mkdtempSync(join(tmpdir(), 'gate-shards-measure-'));
  const cgroup = options.cgroupRoot ?? (() => {
    try {
      const entry = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((line) => line.startsWith('0::'));
      if (!entry) return null;
      const path = resolve('/sys/fs/cgroup', `.${entry.slice(3)}`);
      return path.startsWith('/sys/fs/cgroup/') || path === '/sys/fs/cgroup' ? path : null;
    } catch { return null; } // macOS and hosts without cgroup v2 report partial OOM counts.
  })();
  const measure = async (mode: GateMeasurement['mode'], groups: string[][]): Promise<GateMeasurement> => {
    const started = performance.now();
    const testRoot = join(root, mode);
    mkdirSync(testRoot);
    const env = prepareIsolatedTestEnv(process.env, testRoot);
    const reports = groups.map((_, index) => join(root, `${mode}-${index}.xml`));
    // Record total RSS of the concurrently running test process groups, not the wrapper's RSS.
    const running = new Set<number>();
    let peakKb = 0;
    const sample = () => {
      if (!running.size) return;
      const ps = spawnSync('ps', ['-e', '-o', 'pgid=', '-o', 'rss='], { encoding: 'utf8' });
      if (ps.status !== 0) throw new Error('RSS sampling failed');
      const kb = ps.stdout.split('\n').reduce((sum, line) => {
        const [group, rssKb] = line.trim().split(/\s+/).map(Number);
        return running.has(group!) && Number.isFinite(rssKb) ? sum + rssKb! : sum;
      }, 0);
      peakKb = Math.max(peakKb, kb);
    };
    const runs: Run[] = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    try {
      await Promise.all(groups.map(async (group, index) => {
        // Bundles share the mode's isolated environment but have separate Bun process groups.
        const cmd = ['bun', 'test', '--reporter=junit', `--reporter-outfile=${reports[index]}`, ...group.map((file) => `./${file}`)];
        let groupPath: string | null = null;
        if (cgroup) {
          try {
            groupPath = join(cgroup, `gate-shards-${process.pid}-${index}-${mode}-${root.split('/').at(-1)}`);
            mkdirSync(groupPath);
            options.onCgroupCreated?.(groupPath);
            oomKills(groupPath);
          } catch {
            if (groupPath) { try { rmdirSync(groupPath); } catch { /* No delegated cleanup access. */ } }
            groupPath = null;
          }
        }
        // The shell blocks before exec: assign its PID to the private cgroup first.
        // exec retains the PID; descendants inherit the same group and memory.events.
        const child = Bun.spawn(groupPath ? ['bash', '-c', 'read -r _ || exit 125; exec "$@"', 'gate-shards', ...cmd] : cmd, {
          cwd: repo, env: options.cgroupRoot && groupPath ? { ...env, ELANOUS_GATE_MEASURE_CGROUP_DIR: groupPath } : env,
          stdin: groupPath ? 'pipe' : 'ignore', stdout: 'ignore', stderr: 'pipe', detached: true,
        });
        let attached = false;
        if (groupPath) {
          try {
            writeFileSync(join(groupPath, 'cgroup.procs'), String(child.pid));
            attached = true;
          } catch { /* Without attachment a cgroup OOM counter is not attributable. */ }
          if (attached) child.stdin!.write('\n');
          else child.kill(); // Fail closed rather than run an untracked wrapper.
          child.stdin!.end();
        }
        running.add(child.pid);
        if (!interval) interval = setInterval(sample, 50);
        sample();
        const stderr = await new Response(child.stderr).text();
        const code = await child.exited;
        sample();
        running.delete(child.pid);
        let count: number | null = null;
        if (groupPath) {
          try {
            if (attached) count = oomKills(groupPath);
          } catch { /* Lost attribution: do not report a definitive zero. */ }
          try { rmdirSync(groupPath); } catch { /* Another live process may still occupy it. */ }
        }
        let xml = '';
        try { xml = readFileSync(reports[index]!, 'utf8'); } catch { /* An absent JUnit is unmeasured. */ }
        runs[index] = { code, signal: child.signalCode, xml, stderr, oomKills: count };
      }));
    } finally { if (interval) clearInterval(interval); }
    const cases: Record<string, 'passed' | 'failed'> = Object.create(null);
    // Only kernel OOM kills attributed to the bundle's private cgroup count.
    // Neither test stderr nor SIGKILL/137 establishes an OOM cause.
    let oomCount = 0;
    let unknownTerminations = 0, complete = true;
    for (const [index, run] of runs.entries()) {
      if (run.oomKills !== null) oomCount += run.oomKills;
      if ((run.signal || (run.code !== 0 && run.code !== 1)) && !run.oomKills) unknownTerminations++;
      if (run.oomKills) complete = false;
      try {
        const batch = readCases(run.xml, groups[index]!);
        const hasFailure = Object.values(batch).includes('failed');
        if (![0, 1].includes(run.code ?? -1) || run.signal || (run.code === 0 && hasFailure) || (run.code === 1 && !hasFailure)) complete = false;
        Object.assign(cases, batch);
      } catch { complete = false; }
      if (run.signal || (run.code !== 0 && run.code !== 1)) console.error(`${mode} bundle ${index}: signal=${run.signal ?? 'none'} code=${run.code ?? 'null'} ${run.stderr.slice(-500)}`);
    }
    if (peakKb === 0) complete = false;
    return { mode, durationMs: Math.round(performance.now() - started), peakRssMb: Math.ceil(peakKb / 1024), oomCount, unknownTerminations, oomCountStatus: runs.some((run) => run.oomKills === null) ? 'partial' : 'confirmed',
      verdict: !complete ? 'unmeasured' : Object.values(cases).includes('failed') ? 'failed' : 'passed', cases, runs: groups.length };
  };
  try {
    const unsharded = await measure('unsharded', [files]);
    const sharded = await measure('sharded', bundles.map((bundle) => bundle.files));
    const verdictAgrees = unsharded.verdict !== 'unmeasured' && sharded.verdict !== 'unmeasured'
      && unsharded.verdict === sharded.verdict
      && JSON.stringify(Object.entries(unsharded.cases).sort()) === JSON.stringify(Object.entries(sharded.cases).sort());
    return { commit, machine: (await import('node:os')).hostname(), files: files.length, shards: bundles.length, unsharded, sharded, verdictAgrees };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export async function main(argv: string[] = process.argv.slice(2), repo = process.cwd()): Promise<number> {
  const take = (flag: string): string | undefined => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  if (argv.includes('--help')) {
    console.error('bun scripts/measure-gate-shards.ts --shards N --measurements <TSV> [--budget-gib 8] (clean main checkout on node-b)');
    return 0;
  }
  const count = Number(take('--shards'));
  const source = take('--measurements');
  if (!source || !Number.isSafeInteger(count) || count < 1) throw new Error('--shards N and --measurements TSV are required');
  const budgetGiB = take('--budget-gib') === undefined ? 8 : Number(take('--budget-gib'));
  const { commit, files: tracked } = trackedGateFiles(repo);
  const cdp = new Set(deriveCdpTestPatterns({ cwd: repo }));
  // Match the deterministic whole-gate CDP exclusion; keep every other tracked test, including install.
  const files = tracked.filter((file) => !cdp.has(file));
  const { rss, seconds } = readGateMeasurements(resolve(repo, source));
  await calibrateMissingGateMeasurements({ repo, files, rss, seconds });
  const result = await measureGateComparison({ repo, files, commit, shards: count, rss, seconds, budgetGiB });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.verdictAgrees ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error); process.exitCode = 2; }
}
