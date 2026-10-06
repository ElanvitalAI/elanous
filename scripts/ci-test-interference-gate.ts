#!/usr/bin/env bun
import {
  detectTestInterference,
  formatIsolatedFailureSummary,
  runBunTest,
  type InterferenceReport,
  type TestRunner,
} from './detect-test-interference.js';

export const MAX_INSPECTED_TEST_FILES = 8;
const TEST_FILE = /\.test\.tsx?$/;

export type TestInterferenceGateIo = {
  args?: readonly string[];
  /** Landing tree. `bun test` of the changed files runs here, not in process.cwd(). */
  cwd?: string;
  log?: (message: string) => void;
  detect?: (files: readonly string[], runner?: TestRunner) => Promise<InterferenceReport>;
  runner?: TestRunner;
};

export function parseChangedFiles(args: readonly string[]): string[] | null {
  const at = args.indexOf('--changed-files');
  if (at < 0) return null;
  const files: string[] = [];
  for (const arg of args.slice(at + 1)) {
    if (arg.startsWith('--')) break;
    for (const file of arg.split(/[\s,]+/)) {
      if (file) files.push(file);
    }
  }
  return files;
}

export function selectedTestFiles(files: readonly string[]): string[] {
  return files.filter((file) => TEST_FILE.test(file));
}

export async function runTestInterferenceGate(io: TestInterferenceGateIo = {}): Promise<number> {
  const args = io.args ?? process.argv.slice(2);
  const log = io.log ?? console.log;
  const cwd = io.cwd ?? process.cwd();
  const changed = parseChangedFiles(args);
  const tests = selectedTestFiles(changed ?? []);
  if (tests.length < 2) {
    log(`[test-interference-gate] 해당 없음 — 변경 시험 파일 ${tests.length}개 (간섭 검사는 2개 이상 필요).`);
    return 0;
  }

  const inspected = tests.slice(0, MAX_INSPECTED_TEST_FILES);
  const omitted = tests.length - inspected.length;
  const capNotice = omitted > 0 ? ` · 상한 ${MAX_INSPECTED_TEST_FILES}개 적용, ${omitted}개 미검사.` : '';
  let report: InterferenceReport;
  try {
    report = await (io.detect ?? detectTestInterference)(inspected, io.runner ?? ((files) => runBunTest(files, undefined, cwd)));
  } catch {
    log(`[test-interference-gate] 경고: 측정 불가 — 판정기 실행 실패, 간섭 없음으로 처리하지 않음.${capNotice}`);
    return 0;
  }
  if (report.status === 'interference') {
    log(`[test-interference-gate] 경고: 간섭 감지 — 차이 ${report.difference} (격리 실패 ${report.isolatedFailures}; 함께 실패 ${report.combinedFailures})${formatIsolatedFailureSummary(report)}.${capNotice}`);
  } else if (report.status === 'unmeasurable') {
    log(`[test-interference-gate] 경고: 측정 불가 — 간섭 없음으로 처리하지 않음.${capNotice}`);
  } else {
    log(`[test-interference-gate] 간섭 없음 — 격리 실패 ${report.isolatedFailures}; 함께 실패 ${report.combinedFailures}; 차이 ${report.difference}${formatIsolatedFailureSummary(report)}.${capNotice}`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await runTestInterferenceGate();
