#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareIsolatedTestEnv } from './lib/deterministic-env.js';

export const EXIT_NO_INTERFERENCE = 0;
export const EXIT_INTERFERENCE = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_UNMEASURABLE = 3;

export type RunnerResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
};

/** Runs `bun test` with one or more test-file arguments. */
export type TestRunner = (files: readonly string[]) => Promise<RunnerResult>;
export type BunTestChild = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  signalCode: string | null;
};
export type BunSpawn = (options: { cmd: string[]; cwd: string; env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' }) => BunTestChild;

export type MeasuredRun = {
  files: string[];
  fail: number | null;
  status: 'measured' | 'unmeasurable';
  reason?: string;
  /** Names observed in Bun's failed-test output. Absent names must not be inferred from the selected files. */
  failedFiles?: string[];
  failedTests?: string[];
};

export type InterferenceReport = {
  order: string[];
  isolated: MeasuredRun[];
  combined: MeasuredRun;
  status: 'no-interference' | 'interference' | 'unmeasurable';
  isolatedFailures: number | null;
  combinedFailures: number | null;
  difference: number | null;
};

export const MAX_ISOLATED_FAILURE_FILES = 8;

const defaultBunSpawn: BunSpawn = (options) => Bun.spawn(options) as unknown as BunTestChild;

/**
 * ⛔ 2026-10-16 사고(R7 · OP #8751) — 이 러너가 `bun test` 를 env 지정 없이 띄워 호스트 재게이트가 mbp 의 실 HOME·운영
 * config 를 시험에 물려줬다. seam 이 빠진 시험 둘(tasks-cli · COORD-ONE)이 운영 `taskAgent.parentHost` 목록으로 진짜 ssh
 * 발사를 해 원격 prod 런 25 · draft PR 11 이 생겼다.
 * ⇒ 시험은 «게이트와 같은» 격리 env 로 띄운다(`prepareIsolatedTestEnv` — 임시 HOME ⊕ 임시 ELANOUS_STATE_DIR ⊕ 자격·실행
 *   정체성·`ELANOUS_STATE_DIR_SOURCE` 제거 · PATH 보존) ⊕ 원격 부모 끔(`ELANOUS_TA_PARENT_HOST=off`).
 */
export async function isolatedBunTestEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => void }> {
  // ⛔ Import the side-effect-free lib, never `test-deterministic.ts`: that file pulls `typescript` and Bun stream
  //    types into every graph that reaches this runner — the PWA tsc program failed on it (#28474 train · 10-16).
  const root = mkdtempSync(join(tmpdir(), 'elanous-interference-test-'));
  const cleanup = (): void => {
    try { rmSync(root, { recursive: true, force: true }); }
    catch (error) {
      // 판정은 막지 않되 숨기지 않는다 — 남은 임시 뿌리는 경로로 찾을 수 있게 한 줄 남긴다(리뷰 should-fix).
      try { process.stderr.write(`[detect-test-interference] temp env root cleanup failed: ${root}: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* ignore */ }
    }
  };
  try {
    return { env: { ...prepareIsolatedTestEnv(sourceEnv, root), ELANOUS_TA_PARENT_HOST: 'off' }, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export async function runBunTest(files: readonly string[], spawn: BunSpawn = defaultBunSpawn, cwd: string = process.cwd(), sourceEnv: NodeJS.ProcessEnv = process.env): Promise<RunnerResult> {
  const isolated = await isolatedBunTestEnv(sourceEnv);
  try {
    const child = spawn({ cmd: [process.execPath, 'test', ...files], cwd, env: isolated.env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode, signal: child.signalCode };
  } finally {
    isolated.cleanup();
  }
}

export function parseFailureCount(output: string): number | null {
  const lines = output.split(/\r?\n/);
  const summaries = lines
    .map((line) => /^\s*Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\.?\s*(?:\[[^\]]+\]\s*)?$/i.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  if (summaries.length !== 1 || Number(summaries[0]![2]) === 0) return null;
  const failures = lines
    .map((line) => /^\s*(\d+)\s+fail\s*$/i.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  if (failures.length !== 1) return null;
  return Number(failures[0]![1]);
}

/** Bun prints a file heading before its `(fail) name` lines. Only retain names actually printed by that run. */
export function parseFailedTestNames(output: string): { files: string[]; tests: string[] } {
  const files = new Set<string>();
  const tests = new Set<string>();
  let currentFile: string | undefined;
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:\d+\s+(?:pass|fail|skip)|Ran\s+\d+\s+tests?|Bun test v)/i.test(line)) { currentFile = undefined; continue; }
    const failure = /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (failure) {
      tests.add(failure[1]!.trim());
      if (currentFile) files.add(currentFile);
      continue;
    }
    const heading = /^(.+):$/.exec(line);
    if (heading) currentFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(heading[1]!) ? heading[1] : undefined;
  }
  return { files: [...files], tests: [...tests] };
}

export function failedNamesFromStreams(result: RunnerResult): { files: string[]; tests: string[] } {
  const stdout = parseFailedTestNames(result.stdout);
  const stderr = parseFailedTestNames(result.stderr);
  return { files: [...new Set([...stdout.files, ...stderr.files])], tests: [...new Set([...stdout.tests, ...stderr.tests])] };
}

async function measure(files: readonly string[], runner: TestRunner): Promise<MeasuredRun> {
  try {
    const result = await runner(files);
    if (result.signal || result.exitCode === null) {
      return { files: [...files], fail: null, status: 'unmeasurable', reason: result.signal ? `runner terminated by ${result.signal}` : 'runner exit code unavailable' };
    }
    const fail = parseFailureCount(`${result.stdout}${result.stderr}`);
    const names = fail !== null && fail > 0 ? failedNamesFromStreams(result) : undefined;
    return fail === null
      ? { files: [...files], fail: null, status: 'unmeasurable', reason: 'test summary unavailable, ambiguous, or ran zero files' }
      : { files: [...files], fail, status: 'measured', ...(names?.files.length ? { failedFiles: names.files } : {}), ...(names?.tests.length ? { failedTests: names.tests } : {}) };
  } catch (error) {
    return { files: [...files], fail: null, status: 'unmeasurable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function detectTestInterference(files: readonly string[], runner: TestRunner = runBunTest): Promise<InterferenceReport> {
  const order = [...files];
  const isolated = [] as MeasuredRun[];
  for (const file of order) isolated.push(await measure([file], runner));
  const combined = await measure(order, runner);
  if (isolated.some((run) => run.status === 'unmeasurable') || combined.status === 'unmeasurable') {
    return { order, isolated, combined, status: 'unmeasurable', isolatedFailures: null, combinedFailures: null, difference: null };
  }
  const isolatedFailures = isolated.reduce((total, run) => total + run.fail!, 0);
  const combinedFailures = combined.fail!;
  const difference = combinedFailures - isolatedFailures;
  return { order, isolated, combined, status: difference === 0 ? 'no-interference' : 'interference', isolatedFailures, combinedFailures, difference };
}

export function formatIsolatedFailureSummary(report: InterferenceReport): string {
  const failures = report.isolated.filter((run) => run.status === 'measured' && run.fail! > 0);
  const listed = failures.slice(0, MAX_ISOLATED_FAILURE_FILES).map((run) => `${run.files.join(' ')} (${run.fail} fail)`);
  const remainder = failures.length - listed.length;
  return listed.length === 0
    ? ''
    : `; isolated failing files: ${listed.join(', ')}${remainder > 0 ? `; ${remainder} more` : ''}`;
}

export function formatReport(report: InterferenceReport): string {
  if (report.status === 'unmeasurable') {
    const order = report.order.join(' ');
    const affected = [...report.isolated, report.combined]
      .filter((run) => run.status === 'unmeasurable')
      .map((run) => `${run.files.join(' ')} (${run.reason})`)
      .join('; ');
    return `UNMEASURABLE test-interference order: ${order}\naffected runs: ${affected}`;
  }
  return `${report.status === 'interference' ? 'INTERFERENCE' : 'NO INTERFERENCE'} test-interference\nisolated failures: ${report.isolatedFailures}; combined failures: ${report.combinedFailures}; difference: ${report.difference}${formatIsolatedFailureSummary(report)}`;
}

export async function main(args: readonly string[] = process.argv.slice(2), runner: TestRunner = runBunTest, write: (line: string) => void = console.log): Promise<number> {
  if (args.length === 0) {
    write('Usage: bun scripts/detect-test-interference.ts <test-file> [test-file...]');
    return EXIT_INVALID_INPUT;
  }
  const report = await detectTestInterference(args, runner);
  write(formatReport(report));
  if (report.status === 'unmeasurable') return EXIT_UNMEASURABLE;
  return report.status === 'interference' ? EXIT_INTERFERENCE : EXIT_NO_INTERFERENCE;
}

if (import.meta.main) process.exitCode = await main();
