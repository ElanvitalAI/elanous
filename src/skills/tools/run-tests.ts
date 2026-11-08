import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── run_tests — multi-filter test tool (OH8 follow-up · PR-1) ──
//
// 발단(INCIDENT-2026-07-24 타임존 트랙): `bun test <filter>` 는 **substring 필터**라
// 오타 필터가 0개 파일을 매칭해도 exit 0 · 경고 0 으로 **거짓 통과**한다("33 pass/exit 0").
// 실측(2026-07-24): 매칭 필터 + 오타 필터를 **한 번에** 돌리면 bun 은 오타 필터를 조용히
// 흡수하고 "Ran 15 tests across 1 file" 만 찍는다 — 어느 필터가 미매칭인지 출력만으로 알 수 없다.
//
// 그래서 이 툴은 **필터마다 개별 spawn**(option a)한다. 매칭 필터는 "Ran N across M(M>0)"
// 요약을 내고, 미매칭 필터는 요약 없이 exit 0 이 되므로 필터별로 정확히 구분된다. 요청한 필터
// 중 하나라도 매칭이 0 이면 `unmatchedFilters` 에 실려 `ok=false` — OH8 이 프롬프트 문구로만
// 막던 거짓 통과를 코드 계약으로 차단한다.
//
// ⭐ 제1원칙(관측): dispatch 결과를 debug.log('run-tests.dispatch', ...) 로 남긴다.

import { spawnSync } from 'node:child_process';

import { parseTestOutput, type TestOutcome } from '../../agent-mission/parse.js';
import { debug } from '../../debug/log.js';

export interface RunTestsArgs {
  /** 테스트 필터 배열(경로 또는 substring). 단일 필터도 배열 하나로. */
  filters: string[];
  /** 실행 디렉토리. 생략 시 process.cwd(). */
  cwd?: string;
  /** 필터 하나당 타임아웃(ms). 기본 120_000. */
  timeoutMs?: number;
}

export interface RunTestsResult {
  /** 호출자가 요청한 필터(정규화 후). */
  requestedFilters: string[];
  /** 전 필터에서 실제 실행된 파일 수 합계. */
  filesRan: number;
  /** 아무 파일도 매칭하지 못한 필터(오타·no-match). 비어 있지 않으면 거짓 통과 후보. */
  unmatchedFilters: string[];
  /** 통과 개수 합계. */
  pass: number;
  /** 실패 개수 합계. */
  fail: number;
  /** ok = 실패 0 · 통과>0 · 미매칭 필터 0. */
  ok: boolean;
}

/** `bun test <filter>` 를 한 번 spawn 하고 stdout+stderr 를 합쳐 반환. 테스트 주입용. */
export type TestSpawn = (filter: string, cwd: string, timeoutMs: number) => string;

const defaultTestSpawn: TestSpawn = (filter, cwd, timeoutMs) => {
  // integrity-gate 와 동형 — event-loop-watchdog 를 끄고(ELANOUS_NO_WATCHDOG) 서브프로세스
  // stall 로그가 파싱 출력을 오염시키지 않게 한다.
  const r = spawnSync('bun', ['test', filter], {
    cwd, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ELANOUS_NO_WATCHDOG: '1' },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

/** 한 필터가 실제로 파일을 매칭했나. 매칭 필터는 항상 "Ran N across M(M>0)" 요약을 낸다.
 *  미매칭 필터는 요약 없이 exit 0 이 되므로 `hasRunSummary && ranFiles>0` 가 매칭의 유일한 증거. */
export function filterMatched(outcome: TestOutcome): boolean {
  return outcome.hasRunSummary && outcome.ranFiles > 0;
}

export interface FilterRun {
  filter: string;
  outcome: TestOutcome;
}

/** 필터별 TestOutcome 을 run_tests 판정으로 집계(순수).
 *  ok = 실패 0 · 통과>0 · 모든 필터가 최소 1개 파일 매칭. */
export function aggregateFilterRuns(runs: FilterRun[]): RunTestsResult {
  const requestedFilters = runs.map(r => r.filter);
  const unmatchedFilters = runs.filter(r => !filterMatched(r.outcome)).map(r => r.filter);
  const filesRan = runs.reduce((s, r) => s + r.outcome.ranFiles, 0);
  const pass = runs.reduce((s, r) => s + r.outcome.pass, 0);
  const fail = runs.reduce((s, r) => s + r.outcome.fail, 0);
  const ok = fail === 0 && pass > 0 && unmatchedFilters.length === 0;
  return { requestedFilters, filesRan, unmatchedFilters, pass, fail, ok };
}

/** 코어 — 필터마다 개별 실행·파싱·집계. 주입 spawn(기본 실제 `bun test`) 외엔 순수. */
export function runTestsMultiFilter(
  filters: string[],
  cwd: string,
  timeoutMs: number,
  spawn: TestSpawn = defaultTestSpawn,
): RunTestsResult {
  const runs: FilterRun[] = filters.map(filter => ({
    filter,
    outcome: parseTestOutput(spawn(filter, cwd, timeoutMs)),
  }));
  return aggregateFilterRuns(runs);
}

export function buildRunTestsTool(): LLMToolSpec {
  return {
    name: 'run_tests',
    description:
      'Run one or more test filters and report which ones matched NO files. ' +
      '`bun test` uses SUBSTRING filters: a typo / no-match filter exits 0 with zero warnings, ' +
      'so a filter that ran nothing looks identical to a pass ("33 pass / exit 0" false-pass). ' +
      'This tool spawns each filter individually and returns `unmatchedFilters` — any requested ' +
      'filter that matched no files. ok = fail===0 AND pass>0 AND unmatchedFilters is empty. ' +
      'Prefer this over `Bash bun test <a> <b>` when you pass multiple filters and need to know ' +
      'that each one actually ran.',
    parameters: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test filters (paths or substrings). Pass a single filter as a one-element array.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory to run tests in. Defaults to the process cwd.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-filter timeout in milliseconds. Defaults to 120000.',
        },
      },
      required: ['filters'],
    },
  };
}

export async function dispatchRunTests(args: RunTestsArgs): Promise<RunTestsResult> {
  const filters = Array.isArray(args.filters)
    ? args.filters.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : [];
  if (filters.length === 0) {
    throw new Error('run_tests: filters must be a non-empty array of strings');
  }
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd();
  const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 120_000;
  const result = runTestsMultiFilter(filters, cwd, timeoutMs);
  debug.log('run-tests.dispatch', 'multifilter', {
    requested: result.requestedFilters.length,
    filesRan: result.filesRan,
    unmatched: result.unmatchedFilters,
    pass: result.pass,
    fail: result.fail,
    ok: result.ok,
  });
  return result;
}
