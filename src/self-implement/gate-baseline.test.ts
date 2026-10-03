import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewIntent } from '../agent-substrate/review-intent.js';
import type { GateResult } from '../autopilot/build/integrity-gate.js';
import {
  allowsBaselineOnlyFailure,
  baselineTimeoutForFiles,
  buildBunSingleTestPattern,
  classifyBunSingleTestRerun,
  buildGateBaselineReport,
  calculateGateTestCountChange,
  canExemptChildForTimeoutFailures,
  classifyAgainstBaseline,
  classifyBaselineProcess,
  classifyTimeoutRerunVariability,
  decideGateChildResponsibility,
  classifyGateTestFailures,
  extractGateTestFailures,
  extractJUnitPassedTests,
  formatVerifyByBreakingNote,
  formatVerifyByBreakingSkipNote,
  formatVerifyByBreakingScopeSkipNote,
  isTimeoutDiagnostic,
  INTRODUCED_RERUN_CAP,
  runGateBaseline,
  rerunBunSingleTest,
  rerunBunTimeoutFailures,
  runReverseVerifyByBreaking,
  runVerifyByBreaking,
  gateBaselineLogLevel,
  formatGateBaselineNote, hasModuleLoadFailure } from './gate-baseline.js';
import { defaultSeams } from './seams.js';
import { gateEvidenceNote } from '../harness/review-adapter.js';
import { debug } from '../debug/log.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
const originalEnv = { ...process.env };
const failLog = (file: string, ...names: string[]) => `${file}:\n${names.map((name) => `(fail) ${name}`).join('\n')}\n\n${names.length} fail`;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-baseline-test-'));
  roots.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'gate@test.local');
  git(cwd, 'config', 'user.name', 'Gate Test');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', 'base');
  return cwd;
}

function setAuthoritativeDefaultBranch(cwd: string): void {
  git(cwd, 'remote', 'add', 'origin', cwd);
  git(cwd, 'fetch', '-q', 'origin');
  git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  if (git(cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD') !== 'refs/remotes/origin/main') {
    throw new Error('failed to configure authoritative origin/HEAD symbolic ref');
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('gate baseline case attribution', () => {
  test('Bun 단일 시험 패턴은 > 세그먼트를 공백으로 바꾸고 각각 정규식 이스케이프한 앵커다', () => {
    expect(buildBunSingleTestPattern('outer suite > nested [pass].$')).toBe('^outer suite nested \\[pass\\]\\.\\$$');
  });

  test('Bun 1.3 요약은 단수·복수 형태 모두 정확히 한 시험·한 파일일 때만 관측한다', () => {
    expect(classifyBunSingleTestRerun({ status: 0, stdout: 'Ran 1 test across 1 file. [5.00ms]' })).toBe('pass');
    expect(classifyBunSingleTestRerun({ status: 0, stdout: 'Ran 2 tests across 1 file. [5.00ms]' })).toBeUndefined();
    expect(classifyBunSingleTestRerun({ status: 0, stdout: 'Ran 1 test across 2 files. [5.00ms]' })).toBeUndefined();
  });

  test('matched 0 tests는 요약보다 먼저 관측 불가로 처리한다', () => {
    expect(classifyBunSingleTestRerun({ status: 0, stdout: 'matched 0 tests\nRan 1 test across 1 file. [5.00ms]' })).toBeUndefined();
  });

  test('Bun 시험 타임아웃 진단과 정상적인 비영 종료를 timeout 관측으로 분류한다', () => {
    expect(classifyBunSingleTestRerun({
      status: 1,
      stdout: '(fail) outer suite nested pass [5000ms]\n  ^ this test timed out after 5000ms.\n\nRan 1 test across 1 file. [5.00ms]',
    })).toBe('timeout');
  });

  test('한 시험 요약 뒤 강제 종료·실행 오류·불명확한 종료 상태는 관측하지 않는다', () => {
    const stdout = '(fail) outer suite nested pass\n\nRan 1 test across 1 file. [5.00ms]';
    expect(classifyBunSingleTestRerun({ status: 1, signal: 'SIGTERM', stdout })).toBeUndefined();
    expect(classifyBunSingleTestRerun({ status: 1, error: new Error('spawn failed'), stdout })).toBeUndefined();
    expect(classifyBunSingleTestRerun({ status: null, stdout })).toBeUndefined();
  });

  test('정상적인 비영 종료의 한 시험 요약은 일반 실패로 분류한다', () => {
    expect(classifyBunSingleTestRerun({
      status: 1,
      stdout: '(fail) outer suite nested pass\n\nRan 1 test across 1 file. [5.00ms]',
    })).toBe('failure');
  });

  test('실제 Bun 중첩 스위트의 단일 재실행은 outer 대상만 실행한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gate-rerun-test-'));
    roots.push(cwd);
    const file = 'rerun.test.ts';
    writeFileSync(join(cwd, file), [
      "import { describe, test } from 'bun:test';",
      "test('nested pass', () => console.log('top marker'));",
      "describe('outer suite', () => { test('nested pass', () => console.log('outer marker')); });",
      "describe('other', () => { test('nested pass', () => console.log('other marker')); });",
      '',
    ].join('\n'));

    expect(rerunBunSingleTest(cwd, file, 'outer suite > nested pass', 30_000)).toBe('pass');
    const output = spawnSync('bun', ['test', '--test-name-pattern', buildBunSingleTestPattern('outer suite > nested pass'), file], { cwd, encoding: 'utf8' });
    expect(`${output.stdout}${output.stderr}`).toContain('outer marker');
    expect(`${output.stdout}${output.stderr}`).not.toContain('top marker');
    expect(`${output.stdout}${output.stderr}`).not.toContain('other marker');
  });

  test('같은 테스트가 통과·일반 실패와 시간 초과를 두 번 이상 보이면 달라질 수 있다', () => {
    expect(classifyTimeoutRerunVariability(['pass', 'timeout'])).toBe('달라질 수 있다');
    expect(classifyTimeoutRerunVariability(['timeout', 'pass', 'timeout'])).toBe('달라질 수 있다');
    expect(classifyTimeoutRerunVariability(['failure', 'timeout'])).toBe('달라질 수 있다');
    expect(classifyTimeoutRerunVariability(['timeout', 'failure'])).toBe('달라질 수 있다');
  });

  test('같은 테스트가 재실행에서 두 번 모두 시간 초과하면 항상 시간 초과다', () => {
    expect(classifyTimeoutRerunVariability(['timeout', 'timeout'])).toBe('항상 시간 초과');
  });

  test('한 번 이하의 관측과 통과만의 반복은 관측 부족이다', () => {
    expect(classifyTimeoutRerunVariability([])).toBe('관측 부족');
    expect(classifyTimeoutRerunVariability(['timeout'])).toBe('관측 부족');
    expect(classifyTimeoutRerunVariability(['pass', 'pass'])).toBe('관측 부족');
  });

  test('base의 테스트 3개 중 2개가 사라지면 감소 2를 보고한다', () => {
    const base = "test('one', () => {});\nit('two', () => {});\ntest('three', () => {});";
    const current = "test('one', () => {});";
    expect(calculateGateTestCountChange(base, current)).toEqual({ base: 3, current: 1, decrease: 2 });
  });

  test('세 분류가 각각 값으로 나온다', () => {
    const child = failLog('test/a.test.ts', 'old case', 'new case');
    const base = failLog('test/a.test.ts', 'old case');
    expect(classifyGateTestFailures(child, base).map((failure) => failure.attribution))
      .toEqual(['preexisting', 'introduced']);
    expect(classifyGateTestFailures(child, undefined).map((failure) => failure.attribution))
      .toEqual(['unknown', 'unknown']);
  });

  test('다른 파일의 동일 시험 이름과 소스 위치·진단이 확인될 때만 preexisting으로 귀속한다', () => {
    const path = 'harness orchestrate canonical entrance capability > primary help exposes only the promoted harness orchestrate options from the self-only gap';
    const original = 'src/index.test.ts';
    const added = 'src/cli/new-thing.test.ts';
    const baseline = `${original}:\n    at ${original}:12:3\n(fail) ${path}`;
    const candidate = `${added}:\n    at ${original}:12:3\n(fail) ${path}`;
    expect(classifyGateTestFailures(candidate, baseline, [added])).toMatchObject([{
      file: added, attribution: 'preexisting', attributedBy: 'name-across-files', baselinePresence: 'missing',
    }]);
    expect(buildGateBaselineReport(candidate, { status: 'test-fail', output: baseline, log: 'base red', missingAtBase: [added] }))
      .toMatchObject({ introduced: 0, preexisting: 1, missingAtBase: 1 });
    expect(classifyGateTestFailures(candidate, `${original}:\n(pass) ${path}`, [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(classifyGateTestFailures(candidate, failLog(original, 'different path'), [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(classifyGateTestFailures(candidate, baseline))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'present' }]);
    expect(classifyGateTestFailures(failLog(added, path), failLog(original, path), [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(buildGateBaselineReport(failLog(added, path), { status: 'test-fail', output: failLog(original, path), log: 'base red', missingAtBase: [added] }))
      .toMatchObject({ introduced: 1, preexisting: 0, missingAtBase: 1 });
    expect(classifyGateTestFailures(`${added}:\n    at ${added}:12:3\n(fail) ${path}`, baseline, [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(classifyGateTestFailures(`${added}:\n    at ${original}:99:3\n(fail) ${path}`, baseline, [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(classifyGateTestFailures(`${added}:\n    at ${original}:12:3\nerror: different failure\n(fail) ${path}`, baseline, [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(classifyGateTestFailures(candidate, `${baseline}\nsrc/other.test.ts:\n    at src/other.test.ts:4:2\n(fail) ${path}`, [added]))
      .toMatchObject([{ attribution: 'introduced', baselinePresence: 'missing' }]);
    expect(classifyGateTestFailures(`${candidate}\n${candidate}`, baseline, [added]))
      .toMatchObject([{ attribution: 'introduced' }, { attribution: 'introduced' }]);
  });

  test('파일 간 동일 시험 증거가 있을 때만 귀속 로그에 기준선 파일을 기록한다', () => {
    const original = debug.log;
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const base = 'src/index.test.ts:\n    at src/index.test.ts:12:3\n(fail) suite > case';
      const child = 'src/cli/new-thing.test.ts:\n    at src/index.test.ts:12:3\n(fail) suite > case';
      classifyGateTestFailures(child, base, ['src/cli/new-thing.test.ts']);
      expect(events).toContainEqual({ category: 'self-implement.gate', event: 'attributed-across-files', data: {
        name: 'suite > case', file: 'src/cli/new-thing.test.ts', baselineFile: 'src/index.test.ts',
      } });
      events.length = 0;
      classifyGateTestFailures(failLog('src/cli/new-thing.test.ts', 'suite > case'), base, ['src/cli/new-thing.test.ts']);
      expect(events).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('같은 파일의 base 실패와 child 신규 실패를 케이스별로 갈라 신규 실패를 숨기지 않는다', () => {
    const child = failLog('test/mixed.test.ts', 'base red', 'child regression');
    const baseline = { status: 'test-fail' as const, output: failLog('test/mixed.test.ts', 'base red'), log: 'base failed' };
    const report = buildGateBaselineReport(child, baseline);
    expect(report).toMatchObject({ introduced: 1, preexisting: 1, unknown: 0 });
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('같은 실행에서 통과한 단언 실패는 기준선에 없어도 introduced로 확정하지 않는다', () => {
    const log = [
      'test/a.test.ts:',
      '(pass) intermittent assertion',
      '(fail) intermittent assertion',
      'error: expect(received).toBe(expected)',
      '',
      '1 pass',
      '1 fail',
    ].join('\n');

    expect(classifyGateTestFailures(log, '0 fail')).toMatchObject([
      { attribution: 'unknown', timeoutVariability: 'may-vary' },
    ]);
  });

  test('같은 실행의 통과 기록이 없는 단언 실패는 종전처럼 introduced다', () => {
    const log = failLog('test/a.test.ts', 'child assertion regression');

    const [failure] = classifyGateTestFailures(log, '0 fail');
    expect(failure?.attribution).toBe('introduced');
    expect(failure?.timeoutVariability).toBeUndefined();
  });

  test('재실행에서 회복한 timeout은 기존 classifier를 거쳐 child attribution에서 제외한다', () => {
    const log = [
      'test/a.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const baseline = { status: 'pass' as const, output: '0 fail', log: 'base clean' };

    const report = buildGateBaselineReport(log, baseline, {
      'test/a.test.ts > intermittent timeout': ['pass'],
    });

    expect(report.failures).toMatchObject([{ attribution: 'flaky-timeout', timeoutVariability: 'may-vary' }]);
    expect(report.timeoutVariabilityCounts).toEqual({ mayVary: 1, same: 0, unknown: 0 });
    expect(report.childResponsibility).toBe('none');
    expect(canExemptChildForTimeoutFailures(report.failures)).toBe(true);
  });

  test('may-vary 관측은 unknown과 함께 있어도 면책하고 same 관측은 면책을 막는다', () => {
    const failure = (timeoutVariability: 'may-vary' | 'same' | 'unknown') => ({
      name: timeoutVariability,
      file: 'test/a.test.ts',
      attribution: 'flaky-timeout' as const,
      baselinePresence: 'present' as const,
      timeoutVariability,
    });

    expect(canExemptChildForTimeoutFailures([failure('may-vary'), failure('unknown')])).toBe(true);
    expect(canExemptChildForTimeoutFailures([failure('may-vary'), failure('same')])).toBe(false);
  });

  test('base에서 통과한 정확한 timeout은 재실행 회복보다 먼저 introduced로 귀속하고 면책을 막는다', () => {
    const head = [
      'a.test.ts:',
      '(fail) t1',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const base = ['a.test.ts:', '(pass) t1', '', '1 pass'].join('\n');

    const report = buildGateBaselineReport(head, { status: 'pass', output: base, log: 'base passed' }, {
      'a.test.ts > t1': ['pass'],
    });

    expect(report.failures).toMatchObject([{ attribution: 'introduced', timeoutRegression: 'passed-at-base' }]);
    expect(report).toMatchObject({ introduced: 1, timedOut: 0, timeoutPassedAtBase: 1 });
    expect(report.childResponsibility).toBeUndefined();
    expect(canExemptChildForTimeoutFailures(report.failures)).toBe(false);
  });

  test('base timeout, missing baseline, and missing-at-base timeout retain flaky-timeout attribution', () => {
    const head = ['a.test.ts:', '(fail) t1', '^ this test timed out after 5000ms.', '', '1 fail'].join('\n');
    const baseTimeout = ['a.test.ts:', '(fail) t1', '^ this test timed out after 5000ms.', '', '1 fail'].join('\n');
    expect(classifyGateTestFailures(head, baseTimeout, [], { 'a.test.ts > t1': ['pass'] }))
      .toMatchObject([{ attribution: 'flaky-timeout', timeoutVariability: 'may-vary' }]);
    expect(classifyGateTestFailures(head, undefined)).toMatchObject([{ attribution: 'flaky-timeout' }]);
    expect(classifyGateTestFailures(head, ['a.test.ts:', '(pass) t1'].join('\n'), ['a.test.ts']))
      .toMatchObject([{ attribution: 'flaky-timeout' }]);
  });

  test('precondition-unmet remains ahead of a base-passed timeout', () => {
    const head = [
      'a.test.ts:',
      'error: Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.',
      '(fail) t1',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const base = ['a.test.ts:', '(pass) t1', '', '1 pass'].join('\n');

    expect(classifyGateTestFailures(head, base)).toMatchObject([{ attribution: 'precondition-unmet' }]);
  });

  test('같은 실행의 비타임아웃 통과와 관측 가능한 재실행 회복을 보고서와 노트에 함께 낸다', () => {
    const nonTimeoutLog = [
      'test/a.test.ts:',
      '(pass) intermittent assertion',
      '(fail) intermittent assertion',
      'error: expect(received).toBe(expected)',
      '',
      '1 pass',
      '1 fail',
    ].join('\n');
    const timeoutLog = [
      'test/a.test.ts:',
      '(fail) recovered timeout',
      '^ this test timed out after 5000ms.',
      '(fail) unobserved timeout',
      '^ this test timed out after 5000ms.',
      '',
      '2 fail',
    ].join('\n');
    const report = buildGateBaselineReport(
      `${nonTimeoutLog}\n${timeoutLog}`,
      { status: 'pass', output: '0 fail', log: 'base clean' },
      { 'test/a.test.ts > recovered timeout': ['pass'] },
    );

    expect(report).toMatchObject({ mayVaryNonTimeout: 1, rerunAttempted: 1, rerunRecovered: 1 });
    const note = formatGateBaselineNote(report, 0);
    expect(note).toContain('[gate-baseline] may-vary-non-timeout=1: test/a.test.ts > intermittent assertion');
    expect(note).toContain('[gate-baseline] rerun attempted=1 recovered=1');
  });

  test('변동성과 재실행 관측이 없으면 새 노트 줄을 생략한다', () => {
    const report = buildGateBaselineReport(
      failLog('test/a.test.ts', 'ordinary failure'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );

    expect(report).toMatchObject({ mayVaryNonTimeout: 0, rerunAttempted: 0, rerunRecovered: 0 });
    expect(formatGateBaselineNote(report, 0)).not.toMatch(/may-vary-non-timeout=|rerun attempted=/);
  });

  test('base에서 통과한 현재 timeout을 timeoutPassedAtBase로 집계한다', () => {
    const worktreeLog = [
      'test/a.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const baselineLog = [
      'test/a.test.ts:',
      '(pass) intermittent timeout',
      '',
      '1 pass',
    ].join('\n');

    expect(buildGateBaselineReport(worktreeLog, { status: 'pass', output: baselineLog, log: 'base clean' }))
      .toMatchObject({ introduced: 1, preexisting: 0, timedOut: 0, timeoutPassedAtBase: 1 });
  });

  test('다른 파일의 동명 기준선 timeout은 현재 파일에서 base 통과한 timeout을 가리지 않는다', () => {
    const worktreeLog = [
      'test/current.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const baselineLog = [
      'test/current.test.ts:',
      '(pass) intermittent timeout',
      '',
      'test/other.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 pass, 1 fail',
    ].join('\n');

    expect(buildGateBaselineReport(worktreeLog, { status: 'test-fail', output: baselineLog, log: 'other file timed out' }))
      .toMatchObject({ introduced: 1, preexisting: 0, timedOut: 0, timeoutPassedAtBase: 1 });
  });

  test('기준선에도 같은 timeout 실패가 있으면 timeoutPassedAtBase로 세지 않는다', () => {
    const timeoutLog = [
      'test/a.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const baselineLog = [
      'test/a.test.ts:',
      '(pass) intermittent timeout',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 pass, 1 fail',
    ].join('\n');

    expect(buildGateBaselineReport(timeoutLog, { status: 'test-fail', output: baselineLog, log: 'base timed out' }))
      .toMatchObject({ preexisting: 0, timedOut: 1, timeoutPassedAtBase: 0 });
  });

  test('재실행 관측이 없으면 unknown timeout은 자식 면책 근거가 되지 않는다', () => {
    const log = [
      'test/a.test.ts:',
      '(fail) intermittent timeout',
      '^ this test timed out after 5000ms.',
      '',
      '1 fail',
    ].join('\n');
    const baseline = { status: 'pass' as const, output: '0 fail', log: 'base clean' };

    const report = buildGateBaselineReport(log, baseline);

    expect(report.failures).toMatchObject([{ attribution: 'flaky-timeout', timeoutVariability: 'unknown' }]);
    expect(report.timeoutVariabilityCounts).toEqual({ mayVary: 0, same: 0, unknown: 1 });
    expect(report.childResponsibility).toBeUndefined();
    expect(canExemptChildForTimeoutFailures(report.failures)).toBe(false);
  });

  // ⛔⭐ **계약 변경(리뷰 must-fix 4R)**: 종전 이 테스트는 *"baseline 이 unknown 이어도 introduced 가
  //    0이면 통과"* 를 고정하고 있었고, **그것이 정확히 구멍이었다** — baseline 판정이 깨지는 모든
  //    경로(로더 오류·미파싱·checkout 실패)가 자식 회귀를 **면책**했다.
  //    ⇒ `unknown` 은 여전히 **유죄가 아니다**(귀속은 unknown 으로 보존한다). 다만 **무죄의 근거도
  //    아니므로** 게이트를 열지 않는다. 이는 이 기능 도입 이전 동작과 같다(회귀 없음).
  test('unknown 귀속은 보존하되, baseline 이 못 돌았으면 게이트를 열지 않는다', () => {
    const report = buildGateBaselineReport(failLog('test/a.test.ts', 'unverified'), {
      status: 'unknown', log: 'baseline checkout failed',
    });
    expect(report).toMatchObject({ introduced: 0, preexisting: 0, unknown: 1 });
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('Bun loader 오류와 1 fail 집계가 함께 있어도 unknown이다', () => {
    const result = classifyBaselineProcess({
      status: 1,
      stdout: 'error: Cannot find package "left-pad" from "/tmp/base/test/a.test.ts"\n\n1 fail',
    });
    expect(result.status).toBe('unknown');
  });

  test('파일 헤더와 테스트명을 안정 식별자로 추출한다', () => {
    expect(extractGateTestFailures(failLog('src/x.test.ts', 'suite > case'))).toEqual([
      { file: 'src/x.test.ts', name: 'src/x.test.ts > suite > case' },
    ]);
  });

  // ⛔⭐ **반례**: 하니스가 처음 쓴 이 테스트는 전제 문구를 **테스트 이름**에 넣어서 통과했다.
  //    실제 bun 출력에는 그런 이름이 없고(문구는 `error:` 줄에 온다) 그래서 판별을 진단행에
  //    앵커한 뒤로는 **여기서 걸리지 않는 것이 옳다.** ⇒ 통과 테스트를 **반례**로 바꾼다.
  //    ⭐ 이것이 앵커가 실제로 좁다는 증거다 — 문구가 아무 데나 있으면 분류하지 않는다.
  test('⛔ 전제 문구가 error: 진단행이 아니라 테스트 이름에만 있으면 분류하지 않는다', () => {
    const nameOnly = failLog('test/tool.test.ts', 'Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.');
    const report = buildGateBaselineReport(nameOnly, { status: 'test-fail', output: nameOnly, log: 'base reproduced' });
    expect(report).toMatchObject({ preconditionUnmet: 0, preexisting: 1 });
    expect(report.failures[0]?.precondition).toBeUndefined();
  });

  // ⛔ 리뷰 관찰 항목(#6064): 진단문 **40줄 예산**과 **경계 종료**는 핵심 안전장치인데 직접
  //    테스트가 없었다 — 파서를 바꾸면 **무제한 캡처**나 **진단문 누출**(다음 실패로 넘어감)이
  //    조용히 들어온다. ⇒ 둘을 각각 고정한다.
  test('진단문은 40줄 예산을 넘기지 않는다 (무제한 캡처 금지)', () => {
    const noise = Array.from({ length: 200 }, (_unused, i) => `    at frame-${i} (/x/y.ts:${i}:1)`);
    const log = ['test/a.test.ts:', ...noise, '✗ huge stack [1ms]', '', '1 fail'].join('\n');
    const [failure] = extractGateTestFailures(log);
    expect(failure?.diagnostic).toBeDefined();
    expect((failure?.diagnostic ?? '').split('\n').length).toBeLessThanOrEqual(40);
    // ⭐ 앞부분이 잡혀야 한다 — 전제·오류 메시지는 `(fail)` 앞 블록의 앞머리에 온다.
    expect(failure?.diagnostic ?? '').toContain('at frame-0 ');
    expect(failure?.diagnostic ?? '').not.toContain('at frame-40 ');
  });

  test('진단문은 다음 실패·파일 헤더·요약줄에서 닫힌다 (다음 실패로 누출 금지)', () => {
    const log = [
      'test/a.test.ts:',
      'error: first boom',
      '✗ first [1ms]',
      'error: second boom',
      '✗ second [1ms]',
      'test/b.test.ts:',
      'error: third boom',
      '✗ third [1ms]',
      '',
      '3 fail',
    ].join('\n');
    const failures = extractGateTestFailures(log);
    expect(failures).toHaveLength(3);
    expect(failures[0]?.diagnostic).toBe('error: first boom');
    expect(failures[1]?.diagnostic).toBe('error: second boom');
    expect(failures[2]?.diagnostic).toBe('error: third boom');
    // ⛔ 요약줄(`3 fail`)이 진단문에 섞이지 않는다.
    expect(failures[2]?.diagnostic ?? '').not.toContain('3 fail');
    // ⛔ 파일 귀속도 경계를 따른다.
    expect(failures.map((f) => f.file)).toEqual(['test/a.test.ts', 'test/a.test.ts', 'test/b.test.ts']);
  });

  describe('extractGateTestFailures — bun 단정 오류는 (fail) 앞, 타임아웃 표지는 뒤', () => {
    const shiftedPair = [
      '<소스발췌>',
      'error: A',
      '(fail) 시험1',
      '<소스발췌>',
      'error: B',
      '(fail) 시험2',
      '',
      '1 pass',
      '2 fail',
    ].join('\n');

    test('인접 실패: 시험1 진단은 error: A 이고 error: B 를 안 담는다', () => {
      const [first] = extractGateTestFailures(shiftedPair);
      expect(first?.name).toBe('시험1');
      expect(first?.diagnostic ?? '').toContain('error: A');
      expect(first?.diagnostic ?? '').not.toContain('error: B');
    });

    test('마지막 실패 진단은 error: B 를 담고 비어 있지 않다', () => {
      const failures = extractGateTestFailures(shiftedPair);
      expect(failures).toHaveLength(2);
      expect(failures[1]?.name).toBe('시험2');
      expect(failures[1]?.diagnostic).toBeDefined();
      expect(failures[1]?.diagnostic ?? '').toContain('error: B');
      expect(failures[1]?.diagnostic ?? '').not.toBe('');
      expect(failures[1]?.diagnostic ?? '').not.toContain('error: A');
    });

    test('타임아웃만 있으면 timed out 표지를 담는다', () => {
      const log = '(fail) 시험1\n^ this test timed out after 10000ms.\n\n1 fail';
      const [failure] = extractGateTestFailures(log);
      expect(failure?.name).toBe('시험1');
      expect(failure?.diagnostic ?? '').toContain('timed out');
    });

    test('앞 오류와 뒤 타임아웃 표지를 둘 다 담는다', () => {
      const log = 'error: C\n(fail) 시험1\n^ this test timed out after 5000ms.\n\n1 fail';
      const [failure] = extractGateTestFailures(log);
      expect(failure?.diagnostic ?? '').toContain('error: C');
      expect(failure?.diagnostic ?? '').toContain('timed out');
    });

    test('실패 셋의 개수·이름 순서·파일 귀속이 유지된다', () => {
      const log = [
        'test/a.test.ts:',
        'error: one',
        '(fail) alpha',
        'error: two',
        '(fail) beta',
        'test/b.test.ts:',
        'error: three',
        '(fail) gamma',
        '',
        '3 fail',
      ].join('\n');
      const failures = extractGateTestFailures(log);
      expect(failures).toHaveLength(3);
      expect(failures.map((failure) => failure.name)).toEqual([
        'test/a.test.ts > alpha',
        'test/a.test.ts > beta',
        'test/b.test.ts > gamma',
      ]);
      expect(failures.map((failure) => failure.file)).toEqual([
        'test/a.test.ts',
        'test/a.test.ts',
        'test/b.test.ts',
      ]);
    });

    test('앞 블록이 예산을 넘으면 뒤에서 잘라 앞부분을 남긴다', () => {
      const noise = Array.from({ length: 80 }, (_unused, i) => `preamble-${i}`);
      const timeoutMarker = '^ this test timed out after 10000ms.';
      const log = ['test/a.test.ts:', ...noise, '(fail) over budget', timeoutMarker, '', '1 fail'].join('\n');
      const [failure] = extractGateTestFailures(log);
      const lines = (failure?.diagnostic ?? '').split('\n');
      expect(lines).toHaveLength(40);
      expect(lines[0]).toBe('preamble-0');
      expect(lines[38]).toBe('preamble-38');
      expect(lines[39]).toBe(timeoutMarker);
      expect(failure?.diagnostic ?? '').not.toContain('preamble-39');
      expect(failure?.diagnostic ?? '').not.toContain('preamble-40');
      expect(isTimeoutDiagnostic(failure?.diagnostic)).toBe(true);
      expect(classifyGateTestFailures(log, log)[0]?.attribution).toBe('flaky-timeout');
    });

    test('(fail) 앞뒤가 비면 진단문을 두지 않고 이웃을 끌어오지 않는다', () => {
      const log = [
        'test/a.test.ts:',
        '(fail) 시험1',
        'error: neighbor',
        '(fail) 시험2',
        '',
        '2 fail',
      ].join('\n');
      const failures = extractGateTestFailures(log);
      expect(failures).toHaveLength(2);
      expect(failures[0]?.diagnostic).toBeUndefined();
      expect(failures[1]?.diagnostic).toBe('error: neighbor');
    });

    test('요약줄 뒤의 다음 실패 진단에 이전 요약과 후행 줄이 섞이지 않는다', () => {
      const log = [
        'test/a.test.ts:',
        'error: A',
        '(fail) 시험1',
        '',
        '1 fail',
        'Ran 1 tests across 1 file.',
        'trailing-after-summary',
        'error: B',
        '(fail) 시험2',
        '',
        '1 fail',
      ].join('\n');
      const failures = extractGateTestFailures(log);
      expect(failures).toHaveLength(2);
      expect(failures.map((failure) => failure.name)).toEqual([
        'test/a.test.ts > 시험1',
        'test/a.test.ts > 시험2',
      ]);
      expect(failures.map((failure) => failure.file)).toEqual([
        'test/a.test.ts',
        'test/a.test.ts',
      ]);
      expect(failures[0]?.diagnostic ?? '').toContain('error: A');
      expect(failures[0]?.diagnostic ?? '').not.toContain('error: B');
      expect(failures[0]?.diagnostic ?? '').not.toContain('trailing-after-summary');
      expect(failures[1]?.diagnostic ?? '').toContain('error: B');
      expect(failures[1]?.diagnostic ?? '').not.toContain('error: A');
      expect(failures[1]?.diagnostic ?? '').not.toContain('1 fail');
    });

    test('요약줄 뒤 SyntaxError 앞 블록은 후속 실패 진단에 보존된다', () => {
      const log = [
        'test/a.test.ts:',
        'error: A',
        '(fail) first',
        '',
        '1 fail',
        'SyntaxError: boom',
        '(fail) second',
        '',
        '1 fail',
      ].join('\n');
      const failures = extractGateTestFailures(log);
      expect(failures).toHaveLength(2);
      expect(failures[0]?.name).toBe('test/a.test.ts > first');
      expect(failures[1]?.name).toBe('test/a.test.ts > second');
      expect(failures[0]?.diagnostic ?? '').toContain('error: A');
      expect(failures[0]?.diagnostic ?? '').not.toContain('SyntaxError: boom');
      expect(failures[1]?.diagnostic ?? '').toContain('SyntaxError: boom');
      expect(failures[1]?.diagnostic ?? '').not.toContain('error: A');
      expect(failures[1]?.diagnostic ?? '').not.toContain('1 fail');
    });

    test('요약줄 뒤 AssertionError 앞 블록은 후속 실패 진단에 보존된다', () => {
      const log = [
        'test/a.test.ts:',
        'error: A',
        '(fail) first',
        '',
        '1 fail',
        'AssertionError: expected true to be false',
        '(fail) second',
        '',
        '1 fail',
      ].join('\n');
      const failures = extractGateTestFailures(log);
      expect(failures).toHaveLength(2);
      expect(failures[0]?.diagnostic ?? '').toContain('error: A');
      expect(failures[0]?.diagnostic ?? '').not.toContain('AssertionError:');
      expect(failures[1]?.diagnostic ?? '').toContain('AssertionError: expected true to be false');
      expect(failures[1]?.diagnostic ?? '').not.toContain('error: A');
      expect(failures[1]?.diagnostic ?? '').not.toContain('1 fail');
    });

    test('요약줄 뒤 일반 메시지 앞 블록은 후속 실패 진단에 보존된다', () => {
      const log = [
        'test/a.test.ts:',
        'error: A',
        '(fail) first',
        '',
        '1 fail',
        'expected 1 to equal 2',
        '(fail) second',
        '',
        '1 fail',
      ].join('\n');
      const failures = extractGateTestFailures(log);
      expect(failures).toHaveLength(2);
      expect(failures[0]?.diagnostic ?? '').toContain('error: A');
      expect(failures[0]?.diagnostic ?? '').not.toContain('expected 1 to equal 2');
      expect(failures[1]?.diagnostic ?? '').toContain('expected 1 to equal 2');
      expect(failures[1]?.diagnostic ?? '').not.toContain('error: A');
      expect(failures[1]?.diagnostic ?? '').not.toContain('1 fail');
    });
  });

  // ⛔⭐ **반례 2**: bun 의 **소스 발췌** 줄에 문구가 있어도 분류하지 않는다(리뷰 R2 must-fix).
  //    그 오류를 단정하는 테스트가 **다른 이유로** 깨지면 발췌에 문구가 그대로 실려 온다.
  test('⛔ 소스 발췌에만 문구가 있고 실제 오류가 다르면 분류하지 않는다', () => {
    const excerptOnly = [
      'test/tool-cwd.test.ts:',
      '',
      "56 |     throw new Error('Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.');",
      '',
      'error: expect(received).toThrow(expected)',
      '',
      '✗ throws when the tool cwd is absent [4ms]',
      '',
      '1 fail',
    ].join('\n');
    const report = buildGateBaselineReport(excerptOnly, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report).toMatchObject({ introduced: 1, preconditionUnmet: 0 });
    expect(report.failures[0]?.precondition).toBeUndefined();
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  // (아래 두 블록이 공유한다)
  const REAL_TOOL_CWD_LOG = [
    "test/daemon-tools-runtime.test.ts:",
    '',
    "56 |     throw new Error('Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.');",
    '',
    'error: Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.',
    '',
    "✗ toolSurface(kind) > 'chat' exposes readonly + Edit + Bash, no WebTerminal* tools [27.51ms]",
    '',
    '1 fail',
  ].join('\n');

  test('⭐ 실측 모양 — 전제 메시지가 테스트 이름이 아니라 진단문에 있어도 분류된다', () => {
    const failures = extractGateTestFailures(REAL_TOOL_CWD_LOG);
    // ① 진단문이 실제로 실려 온다(이것이 없으면 판별할 재료가 없다).
    expect(failures[0]?.diagnostic ?? '').toContain('ELANOUS_TOOL_CWD');
    // ② 그리고 이름에는 없다 — 이 테스트가 검사하는 조건 자체다.
    expect(failures[0]?.name ?? '').not.toContain('ELANOUS_TOOL_CWD');

    const report = buildGateBaselineReport(
      REAL_TOOL_CWD_LOG,
      { status: 'test-fail', output: REAL_TOOL_CWD_LOG, log: 'base reproduced' },
    );
    expect(report).toMatchObject({ introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 1 });
    expect(report.failures[0]?.precondition?.name).toBe('ELANOUS_TOOL_CWD 미설정');
    // ③ 그래도 게이트는 통과하지 않는다 — 이것은 면책이 아니다.
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  // ⛔⛔ **이 골의 최대 위험을 고정한다**: 패턴을 넉넉하게 잡으면 **실제 회귀가 전제 미충족으로
  //    조용히 넘어간다.** 실측(뮤테이션 M3): 패턴을 `/ELANOUS_TOOL_CWD/i` 로 넓혀도 28개가 전부
  //    통과했다 — 즉 그 위험에 가드가 **없었다**.
  //    ⇒ 그 환경변수를 **본문에서 언급**하지만 **다른 이유로** 실패하는 케이스를 넣는다.
  // ⛔ 리뷰 must-fix(#6064 R3): 수용 기준 6 의 *"이유·충족방법"* 이 미검증이었다 —
  //    `precondition.name` 만 보고 **remediation 값도, 노트 출력도** 단정하지 않았다.
  //    ⇒ 값과 **사람이 읽는 문장** 둘 다 고정한다. ⭐ 분류만 바꾸고 충족 방법을 안 내면
  //      받는 사람에게 **행동이 되지 않는다** — 그것이 이 골 수용 기준 2 의 요점이다.
  test('전제 미충족은 충족 방법을 값으로도, 게이트 노트 문장으로도 낸다', () => {
    const report = buildGateBaselineReport(REAL_TOOL_CWD_LOG, { status: 'test-fail', output: REAL_TOOL_CWD_LOG, log: 'base reproduced' });
    expect(report.failures[0]?.precondition).toEqual({
      name: 'ELANOUS_TOOL_CWD 미설정',
      remediation: 'ELANOUS_TOOL_CWD를 대상 작업 디렉터리로 설정한 뒤 게이트를 다시 실행하세요.',
    });
    const note = formatGateBaselineNote(report, 0);
    expect(note).toContain('precondition-unmet=1');
    expect(note).toContain('- precondition-unmet: ');
    expect(note).toContain('(ELANOUS_TOOL_CWD 미설정; ELANOUS_TOOL_CWD를 대상 작업 디렉터리로 설정한 뒤 게이트를 다시 실행하세요.)');
  });

  test('⭐ 전제가 아닌 실패의 노트에는 충족 방법 괄호가 붙지 않는다 (과잉 출력 금지)', () => {
    const plain = buildGateBaselineReport(failLog('test/a.test.ts', 'x'), { status: 'pass', output: '0 fail', log: 'base clean' });
    const note = formatGateBaselineNote(plain, 0);
    expect(note).toContain('precondition-unmet=0');
    expect(note).not.toContain('ELANOUS_TOOL_CWD');
  });

  // ⛔ 리뷰 must-fix(#6064 R2): 종전 판은 `seams.ts` 를 **문자열로 읽어 토큰만** 확인하는
  //    Goodhart 테스트였다 — 실제 방출 레벨을 검증하지 않았다. ⇒ 판정을 술어가 사는 곳으로
  //    옮기고(`gateBaselineLogLevel`) **행동으로** 단정한다. `seams.ts` 는 통과만 시킨다.
  //    ⭐ 이 함수가 막는 것은 **조건이 둘로 갈라져 드리프트하는 것**이다: 차단은
  //      `allowsBaselineOnlyFailure` 가 정하고 레벨은 **같은 그 함수**에서 파생된다.
  describe('gateBaselineLogLevel — 관측 심각도가 차단 판정을 따른다', () => {
    const clean = buildGateBaselineReport(failLog('test/a.test.ts', 'x'), { status: 'pass', output: '0 fail', log: 'base clean' });
    const preconditionOnly = buildGateBaselineReport(REAL_TOOL_CWD_LOG, { status: 'test-fail', output: REAL_TOOL_CWD_LOG, log: 'base reproduced' });
    const preexistingOnly = buildGateBaselineReport(failLog('test/a.test.ts', 'x'), { status: 'test-fail', output: failLog('test/a.test.ts', 'x'), log: 'base reproduced' });

    test('⛔ 전제 미충족만 있어도 차단이므로 warn 이다 (info 로 숨지 않는다)', () => {
      expect(allowsBaselineOnlyFailure(preconditionOnly)).toBe(false);
      expect(gateBaselineLogLevel(preconditionOnly, true)).toBe('warn');
    });

    test('✅ base 에서도 나는 실패만 있으면 통과이므로 info 다', () => {
      expect(allowsBaselineOnlyFailure(preexistingOnly)).toBe(true);
      expect(gateBaselineLogLevel(preexistingOnly, true)).toBe('info');
    });

    test('⛔ introduced 가 있으면 warn 이다', () => {
      expect(gateBaselineLogLevel(clean, true)).toBe('warn');
    });

    test('⛔ test 밖 단계가 실패하면 baseline 이 깨끗해도 warn 이다', () => {
      expect(gateBaselineLogLevel(preexistingOnly, false)).toBe('warn');
    });
  });

  test('⛔ 환경변수 이름만 언급하고 다른 이유로 실패하면 전제 미충족이 아니다 (과잉 분류 금지)', () => {
    const log = [
      'test/config.test.ts:',
      '',
      'error: expect(received).toBe(expected)',
      '',
      '✗ reads ELANOUS_TOOL_CWD from user config [3ms]',
      '',
      '1 fail',
    ].join('\n');
    const report = buildGateBaselineReport(log, { status: 'pass', output: '0 fail', log: 'base clean' });
    // 전제로 분류되지 않고, base 가 깨끗하므로 **introduced** 다.
    expect(report).toMatchObject({ introduced: 1, preexisting: 0, unknown: 0, preconditionUnmet: 0 });
    expect(report.failures[0]?.precondition).toBeUndefined();
    // ⭐ 그러므로 게이트도 통과하지 않는다 — 회귀가 전제로 위장되지 않는다.
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('전제 패턴에 맞지 않는 실패는 기존 귀속을 유지한다', () => {
    const child = failLog('test/ordinary.test.ts', 'ordinary failure');
    const base = failLog('test/ordinary.test.ts', 'ordinary failure');
    const report = buildGateBaselineReport(child, { status: 'test-fail', output: base, log: 'base reproduced' });
    expect(report).toMatchObject({ introduced: 0, preexisting: 1, unknown: 0, preconditionUnmet: 0 });
    expect(report.failures[0]?.precondition).toBeUndefined();
  });

  test('기준선 존재 상태는 귀속과 독립적으로 실패·요약·사람용 노트에 나온다', () => {
    const child = [
      'test/existing.test.ts:',
      '(fail) base red',
      'test/new.test.ts:',
      '(fail) old defect exposed by new test',
      '',
      '2 fail',
    ].join('\n');
    const report = buildGateBaselineReport(child, {
      status: 'test-fail',
      output: failLog('test/existing.test.ts', 'base red'),
      log: 'base reproduced',
      missingAtBase: ['test/new.test.ts'],
    });

    expect(report).toMatchObject({ introduced: 1, preexisting: 1, unknown: 0, preconditionUnmet: 0, missingAtBase: 1 });
    expect(report.failures.map((failure) => [failure.attribution, failure.baselinePresence])).toEqual([
      ['preexisting', 'present'],
      ['introduced', 'missing'],
    ]);
    expect(formatGateBaselineNote(report, 0)).toContain('- preexisting: test/existing.test.ts > base red [baseline=present]');
    expect(formatGateBaselineNote(report, 0)).toContain('- introduced: test/new.test.ts > old defect exposed by new test [baseline=missing]');
  });

  test('기준선 산출이 없으면 상태만 unknown이며 귀속과 종료 판정은 바꾸지 않는다', () => {
    const report = buildGateBaselineReport(failLog('test/a.test.ts', 'unverified'), {
      status: 'unknown',
      log: 'baseline checkout failed',
      missingAtBase: ['test/a.test.ts'],
    });

    expect(report).toMatchObject({ introduced: 1, preexisting: 0, unknown: 0, preconditionUnmet: 0, missingAtBase: 0 });
    expect(report.failures[0]).toMatchObject({ attribution: 'introduced', baselinePresence: 'unknown' });
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
    expect(formatGateBaselineNote(report, 0)).toContain('- introduced: test/a.test.ts > unverified [baseline=unknown]');
  });

  test('runId를 주면 머리에 싣고, 생략하면 종전 노트와 문자 동등하다', () => {
    const report = buildGateBaselineReport(
      failLog('test/a.test.ts', 'child regression'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    const legacy = [
      '[gate-baseline] introduced=1, preexisting=0, unknown=0, precondition-unmet=0',
      '- introduced: test/a.test.ts > child regression',
      'base clean',
    ].join('\n');
    const withoutRun = formatGateBaselineNote(report, 0);
    const withRun = formatGateBaselineNote(report, 0, 'run-relaunch-42');

    expect(withoutRun).toBe(legacy);
    expect(withRun).toBe(`${legacy.replace('precondition-unmet=0', 'precondition-unmet=0, run=run-relaunch-42')}`);
    const withRunEvidence = gateEvidenceNote({ passed: false, log: `${withRun}\nVerify-by-breaking: skipped; reason=test-step-not-ok` });
    const withoutRunEvidence = gateEvidenceNote({ passed: false, log: `${withoutRun}\nVerify-by-breaking: skipped; reason=test-step-not-ok` });

    expect(withRunEvidence).toContain('[gate-baseline] introduced=1, preexisting=0, unknown=0, precondition-unmet=0, run=run-relaunch-42');
    expect(withRunEvidence).toContain('Verify-by-breaking: skipped; reason=test-step-not-ok');
    expect(withoutRunEvidence).toContain('[gate-baseline] introduced=1, preexisting=0, unknown=0, precondition-unmet=0');
    expect(withoutRunEvidence).toContain('Verify-by-breaking: skipped; reason=test-step-not-ok');
    expect(withoutRunEvidence).not.toContain('run=');
  });

  test('기준선이 unknown이면 머리글이 새로 생긴 실패 0을 단정하지 않는다', () => {
    const report = buildGateBaselineReport(failLog('test/a.test.ts', 'unverified'), {
      status: 'unknown',
      log: 'baseline infrastructure failure: loader/resolve/timeout',
    });
    const note = formatGateBaselineNote(report, 0);
    const [head, ...rest] = note.split('\n');
    expect(head).toBe('[gate-baseline] introduced=uncomputed, preexisting=0, unknown=1, precondition-unmet=0');
    expect(head).not.toContain('introduced=0');
    expect(rest.join('\n')).toBe([
      '- unknown: test/a.test.ts > unverified [baseline=unknown]',
      'baseline infrastructure failure: loader/resolve/timeout',
    ].join('\n'));
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('기준선이 정상이고 새로 생긴 실패가 없으면 머리글이 글자 그대로 0이다', () => {
    const output = failLog('test/a.test.ts', 'base red');
    const report = buildGateBaselineReport(output, { status: 'test-fail', output, log: 'base reproduced' });
    expect(formatGateBaselineNote(report, 0)).toBe([
      '[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0',
      '- preexisting: test/a.test.ts > base red',
      'base reproduced',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
    ].join('\n'));
  });

  test('기준선이 정상이고 기존 실행 식별자가 있으면 레거시 문면이 run=까지 글자 그대로다', () => {
    const output = failLog('test/a.test.ts', 'base red');
    const report = buildGateBaselineReport(output, { status: 'test-fail', output, log: 'base reproduced' });
    expect(formatGateBaselineNote(report, 0, 'run-legacy-7')).toBe([
      '[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0, run=run-legacy-7',
      '- preexisting: test/a.test.ts > base red',
      'base reproduced',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
    ].join('\n'));
  });

  test('기준선이 정상이고 새로 생긴 실패가 있으며 실행 식별자가 있으면 레거시 문면이 run=까지 글자 그대로다', () => {
    const report = buildGateBaselineReport(
      failLog('test/a.test.ts', 'child regression'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(formatGateBaselineNote(report, 0, 'run-relaunch-42')).toBe([
      '[gate-baseline] introduced=1, preexisting=0, unknown=0, precondition-unmet=0, run=run-relaunch-42',
      '- introduced: test/a.test.ts > child regression',
      'base clean',
    ].join('\n'));
  });

  test('미실행 importer 가 0이면 요약 첫 줄이 종전과 완전히 같다', () => {
    const report = {
      introduced: 0,
      preexisting: 0,
      unknown: 0,
      preconditionUnmet: 0,
      missingAtBase: 0,
      timedOut: 0,
      timeoutPassedAtBase: 0,
      mayVaryNonTimeout: 0,
      rerunAttempted: 0,
      rerunRecovered: 0,
      flakyRerun: 0,
      rerunNotRun: 0,
      timeoutVariabilityCounts: { mayVary: 0, same: 0, unknown: 0 },
      worktreeFailuresParsed: true,
      failures: [],
      files: [],
      baselineStatus: 'pass' as const,
      log: '',
    };
    const [head] = formatGateBaselineNote(report, 0).split('\n');
    expect(head).toBe('[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0');
  });

  test('미실행 importer 가 9이면 첫 줄에 수와 안 돌린 importer 시험 표지가 둘 다 있다', () => {
    const report = {
      introduced: 0,
      preexisting: 0,
      unknown: 0,
      preconditionUnmet: 0,
      missingAtBase: 0,
      timedOut: 0,
      timeoutPassedAtBase: 0,
      mayVaryNonTimeout: 0,
      rerunAttempted: 0,
      rerunRecovered: 0,
      flakyRerun: 0,
      rerunNotRun: 0,
      timeoutVariabilityCounts: { mayVary: 0, same: 0, unknown: 0 },
      worktreeFailuresParsed: true,
      failures: [],
      files: [],
      baselineStatus: 'pass' as const,
      log: '',
    };
    const [head, ...rest] = formatGateBaselineNote(report, 9).split('\n');
    expect(head).toBe('[gate-baseline] introduced=0 (unrun importer tests: 9), preexisting=0, unknown=0, precondition-unmet=0');
    expect(head).toContain('9');
    expect(head).toContain('unrun importer tests');
    expect(rest.join('\n')).not.toContain('unrun importer tests');
  });
});

describe('gate baseline — 시험 타임아웃은 introduced 회귀가 아니다', () => {
  const timeoutFailLog = (file: string, name: string) =>
    `${file}:\n(fail) ${name}\n^ this test timed out after 10000ms\n\n1 fail`;

  test('isTimeoutDiagnostic: timed out 진단은 참이고 일반 실패·빈 값은 거짓이다', () => {
    expect(isTimeoutDiagnostic('^ this test timed out after 10000ms')).toBe(true);
    expect(isTimeoutDiagnostic('TIMEOUT exceeded')).toBe(true);
    expect(isTimeoutDiagnostic('expected 1 to be 2')).toBe(false);
    expect(isTimeoutDiagnostic(undefined)).toBe(false);
    expect(isTimeoutDiagnostic('')).toBe(false);
  });

  test('baseline 에 없고 현재에만 있는 타임아웃은 introduced 가 비고 timedOut 에 그 하나가 있다', () => {
    const current = [{ name: 'flaky timeout', diagnostic: '^ this test timed out after 10000ms' }];
    const comparison = classifyAgainstBaseline([], current, (entry) => entry.name);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.preexisting).toEqual([]);
    expect(comparison.timedOut).toEqual(current);
  });

  test('baseline 에 없고 현재에만 있는 비타임아웃은 introduced 에 있고 timedOut 이 비었다', () => {
    const current = [{ name: 'real regression', diagnostic: 'expected 1 to be 2' }];
    const comparison = classifyAgainstBaseline([], current, (entry) => entry.name);
    expect(comparison.introduced).toEqual(current);
    expect(comparison.timedOut).toEqual([]);
  });

  test('baseline 에도 있고 현재에도 있는 비타임아웃은 preexisting 이고 introduced·timedOut 이 비었다', () => {
    const failure = { name: 'ordinary failure', diagnostic: 'expected 1 to be 2' };
    const comparison = classifyAgainstBaseline([failure], [failure], (entry) => entry.name);
    expect(comparison.preexisting).toEqual([failure]);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.timedOut).toEqual([]);
  });

  test('타임아웃이 baseline 에 있어도 timedOut 이지 preexisting/introduced 가 아니다', () => {
    const failure = { name: 'always slow', diagnostic: '^ this test timed out after 10000ms' };
    const comparison = classifyAgainstBaseline([failure], [failure], (entry) => entry.name);
    expect(comparison.timedOut).toEqual([failure]);
    expect(comparison.preexisting).toEqual([]);
    expect(comparison.introduced).toEqual([]);
  });

  test('baseline 타임아웃은 remaining 에서 빠져 같은 이름 현재 비타임아웃을 preexisting 으로 면책하지 않는다', () => {
    const baseline = [{ name: 'same case', diagnostic: '^ this test timed out after 10000ms' }];
    const current = [{ name: 'same case', diagnostic: 'expected 1 to be 2' }];
    const comparison = classifyAgainstBaseline(baseline, current, (entry) => entry.name);
    expect(comparison.preexisting).toEqual([]);
    expect(comparison.introduced).toEqual(current);
    expect(comparison.timedOut).toEqual([]);
  });

  test('전제 미충족 timeout은 baseline 통과보다 먼저 precondition-unmet으로 귀속한다', () => {
    const worktree = [
      'test/daemon-tools-runtime.test.ts:',
      'error: Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.',
      '(fail) tool surface',
      '^ this test timed out after 10000ms',
      '',
      '1 fail',
    ].join('\n');
    const baseline = [
      'test/daemon-tools-runtime.test.ts:',
      '(pass) tool surface',
      '',
      '1 pass',
    ].join('\n');

    const report = buildGateBaselineReport(worktree, { status: 'pass', output: baseline, log: 'base passed' });

    expect(report).toMatchObject({ preconditionUnmet: 1, preexisting: 0, timedOut: 0 });
    expect(report.failures).toMatchObject([{ attribution: 'precondition-unmet', baselinePresence: 'present' }]);
  });

  test('JUnit parser는 성공 testcase만 gate identity 형태로 만들고 XML 엔티티를 복원한다', () => {
    const xml = [
      '<testsuite>',
      '<testcase name="plain pass" file="test/a.test.ts"/>',
      '<testcase name="A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;" file="test/entity&amp;name.test.ts"/>',
      '<testcase name="failed" file="test/a.test.ts"><system-out/><failure/></testcase>',
      '<testcase name="errored" file="test/a.test.ts"><system-out/><error/></testcase>',
      '<testcase name="skipped" file="test/a.test.ts"><system-out/><skipped/></testcase>',
      '</testsuite>',
    ].join('');
    expect(extractJUnitPassedTests(xml)).toEqual([
      { file: 'test/a.test.ts', name: 'test/a.test.ts > plain pass' },
      { file: 'test/entity&name.test.ts', name: 'test/entity&name.test.ts > A & B <C> "D" \'E\'' },
    ]);
  });

  test('available JUnit base evidence takes precedence over the console pass parser for timeout attribution', () => {
    const worktree = timeoutFailLog('test/a.test.ts', 'intermittent');
    const failures = classifyGateTestFailures(worktree, '0 pass', [], undefined, {
      status: 'available',
      tests: [{ file: 'test/a.test.ts', name: 'test/a.test.ts > intermittent' }],
    });
    expect(failures).toMatchObject([{ attribution: 'introduced', timeoutRegression: 'passed-at-base' }]);
  });

  test('unavailable JUnit base evidence does not become an empty passed set for timeout attribution', () => {
    const worktree = timeoutFailLog('test/a.test.ts', 'intermittent');
    const failures = classifyGateTestFailures(worktree, '(pass) intermittent', [], undefined, {
      status: 'unavailable', reason: 'JUnit passed-test evidence unavailable: reporter outfile was not created',
    });
    expect(failures).toMatchObject([{ attribution: 'flaky-timeout' }]);
  });

  test('runGateBaseline uses real Bun JUnit base evidence, excludes failed and skipped tests, and cleans its report', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/evidence.test.js'), [
      "import { expect, test } from 'bun:test';",
      "test('plain pass', () => expect(Bun.file('package.json').size).toBeGreaterThan(0));",
      "test('entity & pass', () => expect(Bun.file('package.json').size).toBeGreaterThan(0));",
      "test('failed', () => expect(true).toBe(false));",
      "test.skip('skipped', () => expect(Bun.file('package.json').size).toBeGreaterThan(0));",
    ].join('\n'));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base junit evidence');
    const baseline = runGateBaseline(cwd, ['test/evidence.test.js']);
    expect(baseline.status).toBe('test-fail');
    expect(baseline.output).toContain('(fail) failed');
    expect(baseline.passedTestEvidence).toMatchObject({ status: 'available' });
    expect(baseline.passedTestEvidence?.tests).toEqual([
      { file: 'test/evidence.test.js', name: 'test/evidence.test.js > plain pass' },
      { file: 'test/evidence.test.js', name: 'test/evidence.test.js > entity & pass' },
    ]);
  });

  test('runGateBaseline reports unavailable JUnit evidence from the actual reporter path and keeps timeout attribution conservative', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/timeout.test.js'), [
      "import { test } from 'bun:test';",
      "test('slow only on head', () => {});",
    ].join('\n'));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base timeout pass without junit directory');
    const unavailableParent = join(cwd, 'not-a-directory');
    writeFileSync(unavailableParent, 'file\n');
    process.env.ELANOUS_GATE_JUNIT_TMPDIR = unavailableParent;

    const baseline = runGateBaseline(cwd, ['test/timeout.test.js']);
    expect(baseline).toMatchObject({
      status: 'pass',
      passedTestEvidence: { status: 'unavailable' },
    });
    expect(baseline.log).toContain('JUnit passed-test evidence unavailable: could not create reporter directory');
    const report = buildGateBaselineReport(timeoutFailLog('test/timeout.test.js', 'slow only on head'), baseline);
    expect(report.failures).toMatchObject([{ attribution: 'flaky-timeout' }]);
  });

  test('real Bun base pass then head timeout is introduced and passed-at-base while retaining console timeout parsing', () => {
    const junitReportsBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('elanous-gate-junit-')).sort();
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    const testFile = join(cwd, 'test/timeout.test.js');
    writeFileSync(testFile, [
      "import { expect, test } from 'bun:test';",
      "test('slow only on head', () => expect(Bun.file('package.json').size).toBeGreaterThan(0));",
    ].join('\n'));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base timeout pass');
    writeFileSync(testFile, [
      "import { test } from 'bun:test';",
      "test('slow only on head', async () => { await Bun.sleep(1500); }, 100);",
    ].join('\n'));
    const head = spawnSync('bun', ['test', 'test/timeout.test.js'], { cwd, encoding: 'utf8' });
    expect(head.status).toBe(1);
    const baseline = runGateBaseline(cwd, ['test/timeout.test.js']);
    expect(baseline).toMatchObject({ status: 'pass', passedTestEvidence: { status: 'available' } });
    expect(baseline.output).toContain('1 pass');
    const report = buildGateBaselineReport(`${head.stdout}\n${head.stderr}`, baseline);
    expect(report).toMatchObject({ introduced: 1, timeoutPassedAtBase: 1 });
    expect(report.failures).toMatchObject([{ attribution: 'introduced', timeoutRegression: 'passed-at-base' }]);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('elanous-gate-junit-')).sort()).toEqual(junitReportsBefore);
  });

  test('baseline에서 통과한 같은 파일·시험의 timeout은 introduced로 요약하고 passed-at-base를 붙인다', () => {
    const worktree = timeoutFailLog('test/a.test.ts', 'intermittent');
    const baseline = [
      'test/a.test.ts:',
      '(pass) intermittent',
      '',
      '1 pass',
    ].join('\n');

    const report = buildGateBaselineReport(worktree, { status: 'pass', output: baseline, log: 'base passed' });

    expect(report).toMatchObject({ introduced: 1, preexisting: 0, timedOut: 0, timeoutPassedAtBase: 1 });
    expect(report.failures).toMatchObject([{ attribution: 'introduced', timeoutRegression: 'passed-at-base', baselinePresence: 'present' }]);
  });

  test('missingAtBase 파일의 baseline 통과 timeout은 preexisting으로 귀속하지 않는다', () => {
    const worktree = timeoutFailLog('test/a.test.ts', 'intermittent');
    const baseline = [
      'test/a.test.ts:',
      '(pass) intermittent',
      '',
      '1 pass',
    ].join('\n');

    const failures = classifyGateTestFailures(worktree, baseline, ['test/a.test.ts']);

    expect(failures).toMatchObject([{ attribution: 'flaky-timeout', baselinePresence: 'missing' }]);
  });

  test('게이트 실행에서 타임아웃 두 건은 timed-out=2 줄을 내고 두 이름을 담는다', () => {
    const child = [
      'test/a.test.ts:',
      '(fail) slow one',
      '^ this test timed out after 10000ms',
      'test/b.test.ts:',
      '(fail) also slow',
      '^ this test timed out after 10000ms',
      '',
      '2 fail',
    ].join('\n');
    const report = buildGateBaselineReport(child, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report.introduced).toBe(0);
    expect(report.timedOut).toBe(2);
    expect(report.failures.map((failure) => failure.attribution)).toEqual(['flaky-timeout', 'flaky-timeout']);
    const note = formatGateBaselineNote(report, 0);
    const timedOutLine = note.split('\n').find((line) => line.startsWith('[gate-baseline] timed-out=2'));
    expect(timedOutLine).toBeDefined();
    expect(timedOutLine).toContain('unknown=2');
    expect(timedOutLine).toContain('test/a.test.ts > slow one');
    expect(timedOutLine).toContain('test/b.test.ts > also slow');
    expect(timedOutLine).toContain('⚠ 회귀 아님 — 실행마다 다름');
    expect(report.childResponsibility).toBeUndefined();
    expect(note).not.toContain('자식이 고칠 수 없음');
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('통과한 단언 실패 하나와 타임아웃 넷은 introduced가 0이다', () => {
    const timeout = (name: string) => [
      `test/${name}.test.ts:`,
      `(fail) ${name}`,
      '^ this test timed out after 10000ms',
    ].join('\n');
    const log = [
      'test/assertion.test.ts:',
      '(pass) intermittent assertion',
      '(fail) intermittent assertion',
      'error: expect(received).toBe(expected)',
      timeout('slow-one'),
      timeout('slow-two'),
      timeout('slow-three'),
      timeout('slow-four'),
      '',
      '1 pass',
      '5 fail',
    ].join('\n');

    const report = buildGateBaselineReport(log, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report).toMatchObject({ introduced: 0, unknown: 1, timedOut: 4 });
    expect(report.failures[0]).toMatchObject({ attribution: 'unknown', timeoutVariability: 'may-vary' });
    expect(report.failures.slice(1).map((failure) => failure.attribution)).toEqual([
      'flaky-timeout', 'flaky-timeout', 'flaky-timeout', 'flaky-timeout',
    ]);
  });

  test('같은 시험의 통과와 타임아웃이 함께 관측되면 timeout에만 may-vary를 붙이고 면책한다', () => {
    const log = [
      'test/a.test.ts:',
      '(pass) intermittent',
      '(fail) intermittent',
      '^ this test timed out after 10000ms',
      '',
      '1 pass',
      '1 fail',
    ].join('\n');
    const report = buildGateBaselineReport(log, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ attribution: 'flaky-timeout', timeoutVariability: 'may-vary' });
    expect(formatGateBaselineNote(report, 0)).toContain('may-vary=1');
    expect(report.childResponsibility).toBe('none');
  });

  test('같은 시험의 일반 실패와 타임아웃이 함께 관측되면 timeout에만 may-vary를 붙인다', () => {
    const log = [
      'test/a.test.ts:',
      '(fail) intermittent',
      'Expected 1 to be 2',
      '(fail) intermittent',
      '^ this test timed out after 10000ms',
      '',
      '2 fail',
    ].join('\n');
    const report = buildGateBaselineReport(log, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toMatchObject({ attribution: 'introduced' });
    expect(report.failures[0]?.timeoutVariability).toBeUndefined();
    expect(report.failures[1]).toMatchObject({ attribution: 'flaky-timeout', timeoutVariability: 'may-vary' });
  });

  test('같은 시험의 타임아웃과 일반 실패가 역순으로 관측돼도 timeout에 may-vary를 붙인다', () => {
    const log = [
      'test/a.test.ts:',
      '(fail) intermittent',
      '^ this test timed out after 10000ms',
      '(fail) intermittent',
      'Expected 1 to be 2',
      '',
      '2 fail',
    ].join('\n');
    const report = buildGateBaselineReport(log, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report.failures[0]).toMatchObject({ attribution: 'flaky-timeout', timeoutVariability: 'may-vary' });
    expect(report.failures[1]).toMatchObject({ attribution: 'introduced' });
    expect(report.failures[1]?.timeoutVariability).toBeUndefined();
  });

  test('같은 시험의 반복 타임아웃은 unknown으로 남기고 자식 면책을 막는다', () => {
    const report = buildGateBaselineReport(
      `${timeoutFailLog('test/a.test.ts', 'always slow')}\n${timeoutFailLog('test/a.test.ts', 'always slow')}`,
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(report.failures.map((failure) => failure.timeoutVariability)).toEqual(['unknown', 'unknown']);
    expect(formatGateBaselineNote(report, 0)).toContain('unknown=2');
    expect(report.childResponsibility).toBeUndefined();
  });

  test('단일 타임아웃은 unknown을 붙이고 자식 면책을 막는다', () => {
    const report = buildGateBaselineReport(
      timeoutFailLog('test/a.test.ts', 'unmeasured slow'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(report.failures[0]).toMatchObject({ attribution: 'flaky-timeout', timeoutVariability: 'unknown' });
    expect(report.childResponsibility).toBeUndefined();
  });

  test('재실행 변동성 세 값은 production classifier가 각각 보존한다', () => {
    const log = timeoutFailLog('test/a.test.ts', 'rerun variability');
    const baseline = { status: 'pass' as const, output: '0 fail', log: 'base clean' };
    const name = 'test/a.test.ts > rerun variability';

    expect(classifyGateTestFailures(log, baseline.output, [], { [name]: ['timeout', 'pass'] }))
      .toMatchObject([{ timeoutVariability: 'may-vary' }]);
    expect(classifyGateTestFailures(log, baseline.output, [], { [name]: ['timeout', 'timeout'] }))
      .toMatchObject([{ timeoutVariability: 'same' }]);
    expect(classifyGateTestFailures(log, baseline.output))
      .toMatchObject([{ timeoutVariability: 'unknown' }]);
  });

  test('재실행에서 반복 시간 초과한 실패는 same으로 생산되어 자식 면책을 막는다', () => {
    const name = 'test/a.test.ts > repeatedly slow';
    const report = buildGateBaselineReport(
      timeoutFailLog('test/a.test.ts', 'repeatedly slow'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
      { [name]: ['timeout', 'timeout'] },
    );

    expect(report.failures).toMatchObject([{ attribution: 'flaky-timeout', timeoutVariability: 'same' }]);
    expect(report.childResponsibility).toBeUndefined();
    expect(canExemptChildForTimeoutFailures(report.failures)).toBe(false);
  });

  test('재실행 변동성 관측은 기존 gate.baseline 노트에 세 범주의 건수를 모두 싣는다', () => {
    const report = buildGateBaselineReport(
      [
        timeoutFailLog('test/a.test.ts', 'recovered'),
        timeoutFailLog('test/a.test.ts', 'repeatedly slow'),
        timeoutFailLog('test/a.test.ts', 'unmeasured slow'),
      ].join('\n'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
      {
        'test/a.test.ts > recovered': ['pass'],
        'test/a.test.ts > repeatedly slow': ['timeout', 'timeout'],
      },
    );

    expect(formatGateBaselineNote(report, 0)).toContain('may-vary=1, same=1, unknown=1');
  });

  test('same 또는 unknown 타임아웃 변동성은 면책하지 않고 may-vary만 면책한다', () => {
    const timeout = {
      name: 'observed slow',
      file: 'test/a.test.ts',
      attribution: 'flaky-timeout' as const,
      baselinePresence: 'present' as const,
    };
    expect(canExemptChildForTimeoutFailures([{ ...timeout, timeoutVariability: 'same' }])).toBe(false);
    expect(canExemptChildForTimeoutFailures([{ ...timeout, timeoutVariability: 'unknown' }])).toBe(false);
    expect(canExemptChildForTimeoutFailures([{ ...timeout, timeoutVariability: 'may-vary' }])).toBe(true);
    expect(canExemptChildForTimeoutFailures([{ ...timeout, timeoutVariability: 'same' }, { ...timeout, timeoutVariability: 'unknown' }])).toBe(false);
  });

  test('baseline childResponsibility=none도 same 타임아웃 면책을 덮어쓰지 않는다', () => {
    const sameTimeout = {
      name: 'observed slow',
      file: 'test/a.test.ts',
      attribution: 'flaky-timeout' as const,
      baselinePresence: 'unknown' as const,
      timeoutVariability: 'same' as const,
    };
    expect(decideGateChildResponsibility({ childResponsibility: 'none' }, 0, [sameTimeout])).toBeUndefined();
  });

  test('baseline childResponsibility=none은 build report의 새 실패를 면책하지 않는다', () => {
    const report = buildGateBaselineReport(
      failLog('test/a.test.ts', 'child regression'),
      { status: 'test-fail', output: '0 fail', log: 'base infrastructure failure', childResponsibility: 'none' },
    );
    expect(report).toMatchObject({ introduced: 1 });
    expect(report.childResponsibility).toBeUndefined();
  });

  test('타임아웃과 자식 회귀가 함께 있으면 자식 책임 없음을 내지 않는다', () => {
    const report = buildGateBaselineReport(
      `${failLog('test/a.test.ts', 'child regression')}\n${timeoutFailLog('test/b.test.ts', 'flaky')}`,
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(report.introduced).toBe(1);
    expect(report.timedOut).toBe(1);
    expect(report.failures.find((failure) => failure.attribution === 'introduced')?.timeoutVariability).toBeUndefined();
    expect(report.childResponsibility).toBeUndefined();
    expect(formatGateBaselineNote(report, 0)).not.toContain('자식이 고칠 수 없음');
  });

  test('타임아웃이 없는 보고서는 자식 책임 칸을 추가하지 않는다', () => {
    const report = buildGateBaselineReport(
      failLog('test/a.test.ts', 'child regression'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(Object.keys(report)).not.toContain('childResponsibility');
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('timedOut 이 비면 timed-out= 줄을 내지 않는다', () => {
    const report = buildGateBaselineReport(
      failLog('test/a.test.ts', 'child regression'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(report.timedOut).toBe(0);
    expect(formatGateBaselineNote(report, 0)).not.toContain('timed-out=');
  });

  test('머리 줄이 timed-out 수를 «차단 사유와 나란히» 싣는다', () => {
    // ⛔⭐ 2026-09-12 실측이 낸 칸 — 한 런이 `introduced=1 · timedOut=23` 으로 실패했는데
    //   머리 줄은 timedOut 을 «안 말했다». 그래서 사람이 --json 까지 가야 그 23 을 봤다.
    const report = buildGateBaselineReport(
      `${failLog('test/a.test.ts', 'child regression')}\n${timeoutFailLog('test/b.test.ts', 'flaky')}`,
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    const note = formatGateBaselineNote(report, 0);
    const head = note.split('\n')[0]!;
    expect(head).toContain('introduced=');
    expect(head).toContain('timed-out=');
    expect(head).toContain(`timed-out=${report.timedOut}`);
  });

  test('타임아웃만 있어도 게이트는 통과하지 않는다', () => {
    const report = buildGateBaselineReport(
      timeoutFailLog('test/a.test.ts', 'flaky'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(report.introduced).toBe(0);
    expect(report.timedOut).toBe(1);
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('base 에 없고 현재에만 있는 타임아웃의 최종 attribution 은 flaky-timeout 이지 introduced 가 아니다', () => {
    const report = buildGateBaselineReport(
      timeoutFailLog('test/a.test.ts', 'flaky timeout'),
      { status: 'pass', output: '0 fail', log: 'base clean' },
    );
    expect(report.failures[0]?.attribution).toBe('flaky-timeout');
    expect(report.failures[0]?.attribution).not.toBe('introduced');
    expect(report.introduced).toBe(0);
    expect(report.timedOut).toBe(1);
  });

  test('baseline 로그의 타임아웃은 같은 이름 현재 비타임아웃 실패를 preexisting 으로 두지 않는다', () => {
    const report = buildGateBaselineReport(
      ['test/a.test.ts:', '(fail) same case', 'expected 1 to be 2', '', '1 fail'].join('\n'),
      { status: 'test-fail', output: timeoutFailLog('test/a.test.ts', 'same case'), log: 'base timed out' },
    );
    expect(report.failures[0]?.attribution).toBe('introduced');
    expect(report.preexisting).toBe(0);
    expect(report.introduced).toBe(1);
    expect(report.timedOut).toBe(0);
  });

  // 🔄 2026-08-27 🅣 — 이 시험의 «기대를 뒤집었다». 원판은 「타임아웃이 전제보다 앞선다」였다.
  //   ⛔ 그러면 `error: … requires an explicit tool cwd …` 같은 «진짜 전제 실패»가 remediation 을 잃는다.
  //   🔑 두 갈래 다 「네 탓이 아니다」지만 ***`precondition-unmet` 만 「무엇을 하면 되나」를 담는다***.
  //   ⇒ 실행 가능한 정보를 버리는 쪽이 더 나쁘다. 그래서 전제가 먼저다.
  //   ⚠️ 대가: 진짜 타임아웃에 전제 문구가 «우연히» 섞이면 관계없는 remediation 이 붙는다(무해한 잡음).
  test('timeout 문구와 전제 문구가 함께 있으면 precondition-unmet 이 이긴다 (remediation 을 잃지 않는다)', () => {
    const mixed = [
      'test/a.test.ts:',
      'error: Isolated instance requires an explicit tool cwd; pass --tool-cwd <path> or set ELANOUS_TOOL_CWD.',
      '(fail) mixed timeout and cwd',
      '^ this test timed out after 10000ms',
      '',
      '1 fail',
    ].join('\n');
    const report = buildGateBaselineReport(mixed, { status: 'pass', output: '0 fail', log: 'base clean' });
    expect(report.failures[0]?.attribution).toBe('precondition-unmet');
    expect(report.failures[0]?.precondition?.remediation).toBeTruthy();
    expect(report.timedOut).toBe(0);
    expect(report.preconditionUnmet).toBe(1);
    expect(report.introduced).toBe(0);
  });
});

describe('hasModuleLoadFailure — 정합 뒤 실패가 «모듈 로드»인지 값으로 답한다 (OBS-T96 🅐)', () => {
  // ⛔ 이 판정이 있어야 「산출이 상했다」와 「그 순간 트리가 불일치했다」가 갈린다.
  //   실물(106차): 리뷰를 통과한 산출이 `Export named 'tierModel' not found` 로 통째로 버려졌고,
  //   리베이스 뒤 387 pass 0 fail 이었다 — 산출은 «멀쩡했다».
  test('실물 문면(Export named … not found in module)을 문다', () => {
    expect(hasModuleLoadFailure("❌ Export named 'tierModel' not found in module 'src/llm/model-defaults.ts'")).toBe(true);
  });

  test('다른 표현(does not provide an export named …)도 문다', () => {
    expect(hasModuleLoadFailure("SyntaxError: The requested module 'x.ts' does not provide an export named 'y'")).toBe(true);
  });

  test('평범한 테스트 실패는 «안» 문다 — 그래야 두 사인이 갈린다', () => {
    expect(hasModuleLoadFailure('1 fail\n  expect(received).toBe(expected)')).toBe(false);
    expect(hasModuleLoadFailure('')).toBe(false);
  });
});

describe('defaultSeams gate blocking', () => {
  function failedGate(output: string): GateResult {
    return {
      passed: false,
      steps: [{ name: 'test', ok: false, skipped: false, summary: 'fail', output }],
      log: '[test] FAIL',
    };
  }

  function changedRepo(): string {
    const cwd = repo();
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/a.test.js'), 'changed');
    return cwd;
  }

  test('base에서도 실패한 케이스만 있으면 child를 차단하지 않고 결과를 표면화한다', async () => {
    const cwd = changedRepo();
    const output = failLog('test/a.test.js', 'base red');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(output),
      runGateBaseline: () => ({ status: 'test-fail', output, log: 'base reproduced' }),
    }).gate(cwd);
    expect(gate.passed).toBe(true);
    expect(gate.baselineFailures?.[0]?.attribution).toBe('preexisting');
    expect(gate.log).toContain('이 PR의 책임이 아니다');
  });

  test('gate 적색인데 introduced=0이면 음성 대조 스킵 줄과 reader가 child-responsibility=none을 보존한다', async () => {
    const cwd = changedRepo();
    const output = failLog('test/a.test.js', 'base red');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(output),
      runGateBaseline: () => ({ status: 'test-fail', output, log: 'base reproduced' }),
    }).gate(cwd);
    expect(gate.passed).toBe(true);
    const line = 'Verify-by-breaking: skipped; reason=test-step-not-ok; child-responsibility=none';
    expect(gate.log).toContain(line);
    expect(gateEvidenceNote(gate)).toContain(line);
  });

  test('defaultSeams.gate는 timeout-only 보고서의 child 책임 없음을 reflectGateFacts로 전파한다', async () => {
    const cwd = changedRepo();
    const output = [
      'test/a.test.js:',
      '(fail) flaky',
      '^ this test timed out after 10000ms',
      '',
      '1 fail',
    ].join('\n');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(output),
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
    }).gate(cwd);
    expect(gate.passed).toBe(false);
    expect(gate.reflectGateFacts).toMatchObject({
      introduced: 0,
      timedOut: 1,
      childResponsibility: 'none',
    });
  });

  test('child가 만든 실패가 하나라도 있으면 차단한다', async () => {
    const cwd = changedRepo();
    const child = failLog('test/a.test.js', 'base red', 'child regression');
    const base = failLog('test/a.test.js', 'base red');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(child),
      runGateBaseline: () => ({ status: 'test-fail', output: base, log: 'base reproduced' }),
    }).gate(cwd);
    expect(gate.passed).toBe(false);
    expect(gate.baselineFailures?.map((failure) => failure.attribution))
      .toEqual(['preexisting', 'introduced']);
  });

  test('introduced 실패면 실제 gate.log가 종전 실패 경로와 문자 동등하다', async () => {
    const cwd = changedRepo();
    const child = failLog('test/a.test.js', 'base red', 'child regression');
    const base = failLog('test/a.test.js', 'base red');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(child),
      runGateBaseline: () => ({ status: 'test-fail', output: base, log: 'base reproduced' }),
    }).gate(cwd);
    expect(gate.log).toBe([
      '[test] FAIL',
      '',
      '[gate-baseline] introduced=1, preexisting=1, unknown=0, precondition-unmet=0',
      '- preexisting: test/a.test.js > base red',
      '- introduced: test/a.test.js > child regression',
      'base reproduced',
      '[gate-baseline] rerun attempted=1 recovered=0 not-run=0',
      '⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.',
    ].join('\n'));
  });

  test('gate 호출의 runId를 baseline 머리에 배선한다', async () => {
    const cwd = changedRepo();
    const child = failLog('test/a.test.js', 'child regression');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(child),
      runGateBaseline: () => ({ status: 'pass', output: '0 fail', log: 'base clean' }),
    }).gate(cwd, { runId: 'run-relaunch-42' });
    expect(gate.log).toContain('[gate-baseline] introduced=1, preexisting=0, unknown=0, precondition-unmet=0, run=run-relaunch-42');
  });

  test('귀속 보고서가 없으면 음성 대조 스킵 줄은 종전과 문자 동등하다', () => {
    expect(formatVerifyByBreakingSkipNote('test-step-not-ok'))
      .toBe('Verify-by-breaking: skipped; reason=test-step-not-ok');
  });

  test('문서 전용과 변경 없음 스킵은 판정한 변경 경로를 구별한다', () => {
    expect(formatVerifyByBreakingScopeSkipNote('docs-only', ['README.md']))
      .toBe('Verify-by-breaking: skipped; reason=docs-only; evaluated-changes=[README.md]; test-step=scope-skipped');
    expect(formatVerifyByBreakingScopeSkipNote('no-changes', []))
      .toBe('Verify-by-breaking: skipped; reason=no-changes; evaluated-changes=[]; test-step=scope-skipped');
  });

  test('timeout 이름의 정상 baseline 실패는 test-fail 이고 child 회귀를 차단한다', async () => {
    const cwd = changedRepo();
    const base = failLog('test/a.test.js', 'timeout(자식 무응답) → kill + null');
    const child = failLog('test/a.test.js', 'timeout(자식 무응답) → kill + null', 'child regression');
    expect(classifyBaselineProcess({ status: 1, stdout: base }).status).toBe('test-fail');
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(child),
      runGateBaseline: () => classifyBaselineProcess({ status: 1, stdout: base }),
    }).gate(cwd);
    expect(gate.baselineFailures?.map((failure) => failure.attribution))
      .toEqual(['preexisting', 'introduced']);
    expect(gate.passed).toBe(false);
  });

  // ⛔ 계약 변경(4R) — baseline 이 못 돌면(worktree add 실패 등) **면책 근거가 없다.**
  //    귀속은 `unknown` 으로 정직하게 남기되 게이트는 종전대로 막는다(이 기능 이전과 동일).
  test('baseline 이 못 돌면 unknown 으로 남기되 게이트는 막는다', async () => {
    const cwd = changedRepo();
    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(failLog('test/a.test.js', 'unknown case')),
      runGateBaseline: () => ({ status: 'unknown', log: 'worktree add failed' }),
    }).gate(cwd);
    expect(gate.passed).toBe(false);
    expect(gate.baselineFailures?.[0]?.attribution).toBe('unknown');
  });

  test('실제 module-load baseline 결과의 child-responsibility=none을 seam reflect facts까지 보존한다', async () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'subject.js'), 'export const present = true;\n');
    writeFileSync(join(cwd, 'test/a.test.js'), "import { missing } from '../subject.js';\nimport { test } from 'bun:test';\ntest('needs missing export', () => missing);\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base missing export');
    const baseline = runGateBaseline(cwd, ['test/a.test.js']);
    expect(baseline).toMatchObject({
      status: 'unknown',
      unknownReason: 'module-load-error',
      childResponsibility: 'none',
    });

    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(failLog('test/a.test.js', 'needs missing export')),
      runGateBaseline: (dir, files, baseRef) => runGateBaseline(dir, files, baseRef),
    }).gate(cwd);
    expect(gate.reflectGateFacts).toEqual({
      introduced: 0,
      preexisting: 0,
      unknown: 1,
      // ⏱️ 넷째 바구니 — 타임아웃으로 분류된 실패 수. 이 경우엔 0 이고, «키가 있다»는 것이 계약이다
      //    (`JDG-T79` ⓐ: 이 칸이 없으면 타임아웃«뿐»인 실패가 0·0·0 으로 보인다).
      timedOut: 0,
      unknownReason: 'module-load-error',
      childResponsibility: 'none',
    });
  });

  test('runGateBaseline gives bun test an isolated deterministic environment and cleans it', () => {
    const cwd = repo();
    process.env.ANTHROPIC_API_KEY = 'parent-secret';
    process.env.ELANOUS_STATE_DIR = '/parent/state';
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/env.test.js'), [
      "import { test, expect } from 'bun:test';",
      "test('captures env', () => {",
      "  expect({",
      "    secret: process.env.ANTHROPIC_API_KEY ?? null,",
      "    home: process.env.HOME,",
      "    xdg: process.env.XDG_CONFIG_HOME,",
      "    state: process.env.ELANOUS_STATE_DIR,",
      "    config: process.env.ELANOUS_CONFIG_DIR,",
      "  }).toEqual({ expected: true });",
      "});",
    ].join('\n'));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base env capture');

    const baseline = runGateBaseline(cwd, ['test/env.test.js']);
    expect(baseline.status).toBe('test-fail');
    const output = baseline.output ?? '';
    expect(output).not.toContain('parent-secret');
    expect(output).toContain('"secret": null');
    const root = output.match(/"home": "([^"]*elanous-gate-test-env-[^"]*)"/)?.[1];
    expect(root).toBeDefined();
    expect(output).toContain(`"xdg": "${root}/.config"`);
    expect(output).toContain(`"state": "${root}/state"`);
    expect(output).toContain(`"config": "${root}/config"`);
    expect(existsSync(root!)).toBe(false);
  });

  test('범위 파일 수에 따라 baseline 예산을 늘리되 총 상한을 넘지 않는다', () => {
    const oneFile = baselineTimeoutForFiles(1);
    const eightFiles = baselineTimeoutForFiles(8);
    expect(oneFile).toBe(300_000);
    expect(eightFiles).toBeGreaterThan(oneFile);
    expect(eightFiles).toBe(600_000);
    expect(eightFiles).toBeLessThanOrEqual(600_000);
  });

  test('process-wide baseline ETIMEDOUT은 budget-exceeded로 예산과 파일 수를 남기고 자식 책임을 면제한다', async () => {
    const budget = { timeoutMs: baselineTimeoutForFiles(8), fileCount: 8 };
    const baseline = classifyBaselineProcess({
      status: null,
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    }, budget);
    expect(baseline).toMatchObject({
      status: 'unknown',
      unknownReason: 'budget-exceeded',
      baselineBudgetMs: 600_000,
      baselineFileCount: 8,
      childResponsibility: 'none',
    });

    const gate = await defaultSeams({
      runIntegrityGate: () => failedGate(failLog('test/a.test.js', 'unmeasured case')),
      runGateBaseline: () => baseline,
    }).gate(changedRepo());
    expect(gate.reflectGateFacts).toMatchObject({
      unknownReason: 'budget-exceeded',
      baselineBudgetMs: 600_000,
      baselineFileCount: 8,
      childResponsibility: 'none',
    });
  });

  test('서로 다른 unknown 사유도 생산 분류에서 child-responsibility=none을 보존한다', () => {
    const infrastructure = classifyBaselineProcess({
      status: 1,
      stderr: 'error: Cannot find package "unavailable-runner"',
    });
    const unavailable = classifyBaselineProcess({
      status: 1,
      stdout: 'process exited before producing test output',
    });
    expect(infrastructure).toMatchObject({
      status: 'unknown',
      unknownReason: 'infrastructure-failure',
      childResponsibility: 'none',
    });
    expect(unavailable).toMatchObject({
      status: 'unknown',
      unknownReason: 'test-result-unavailable',
      childResponsibility: 'none',
    });
  });

  test('통과한 test 스텝은 Verify-by-breaking 생산자를 실행하고 reader가 원문 한 줄만 보존한다', async () => {
    const cwd = changedRepo();
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
      runVerifyByBreaking: () => ({
        baseStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
        files: [{ file: 'test/a.test.js', classification: 'distinguishes', base: { status: 'test-fail', output: 'Expected: true\nReceived: false\n1 fail', log: 'base failed' } }],
      }),
    }).gate(cwd);
    const line = 'Verify-by-breaking: distinguishes=1, does-not-distinguish=0, unknown=0, missing-at-base=0; files=[test/a.test.js=distinguishes]; test/a.test.js=distinguishes; base=test-fail; output=Expected: true ⏎ Received: false ⏎ 1 fail';
    expect(gate.log).toContain(line);
    expect(gate.log).toContain('Reverse verify-by-breaking: ran=false; head-pass=0, head-test-fail=0, head-unknown=1');
    expect(gateEvidenceNote(gate)).toContain(line);
    expect(gateEvidenceNote(gate)).toContain('Reverse verify-by-breaking: ran=false');
  });

  test('정방향 판정 불가 사유를 기존 관측 이벤트에 종류별 수로 싣고 gate 결과와 기존 note를 보존한다', async () => {
    const cwd = changedRepo();
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'verify-by-breaking-unknown-reasons',
      emit: (record) => { records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }); },
    });
    try {
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
        runVerifyByBreaking: () => ({
          baseStatuses: { pass: 0, 'test-fail': 0, unknown: 3 },
          files: [
            { file: 'test/missing-export.test.js', classification: 'unknown', base: { status: 'unknown', unknownReason: 'module-load-error', log: 'base lacks export' } },
            { file: 'test/unavailable.test.js', classification: 'unknown', base: { status: 'unknown', unknownReason: 'test-result-unavailable', log: 'runner exited' } },
            { file: 'test/unspecified.test.js', classification: 'unknown', base: { status: 'unknown', log: 'setup failed' } },
          ],
        }),
      }).gate(cwd);
      const observation = records.find((record) => record.category === 'self-implement' && record.event === 'gate.verify-by-breaking');
      expect(gate.passed).toBe(true);
      expect(gate.log).toContain('Verify-by-breaking: distinguishes=0, does-not-distinguish=0, unknown=3, missing-at-base=0;');
      expect(observation?.data?.unknownReasons).toEqual({
        'module-load-error': 1,
        'test-result-unavailable': 1,
        unspecified: 1,
      });
    } finally {
      off();
    }
  });

  test('판정 불가가 없으면 기존 관측 이벤트의 사유 집계는 비어 있다', async () => {
    const cwd = changedRepo();
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'verify-by-breaking-no-unknown-reasons',
      emit: (record) => { records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }); },
    });
    try {
      await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
        runVerifyByBreaking: () => ({
          baseStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
          files: [{ file: 'test/a.test.js', classification: 'distinguishes', base: { status: 'test-fail', log: 'base failed' } }],
        }),
      }).gate(cwd);
      const observation = records.find((record) => record.category === 'self-implement' && record.event === 'gate.verify-by-breaking');
      expect(observation?.data?.unknownReasons).toEqual({});
    } finally {
      off();
    }
  });

  test('전체 gate가 실패하면 통과한 test 스텝이 있어도 음성 대조를 실행하거나 로그를 바꾸지 않는다', async () => {
    const cwd = changedRepo();
    let calls = 0;
    const output = failLog('test/a.test.js', 'base red');
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: false, steps: [
        { name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' },
        { name: 'typecheck', ok: false, skipped: false, summary: 'fail', output },
      ], log: '[typecheck] FAIL' }),
      runGateBaseline: () => ({ status: 'test-fail', output, log: 'base reproduced' }),
      runVerifyByBreaking: () => { calls += 1; return { files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }; },
    }).gate(cwd);
    expect(calls).toBe(0);
    expect(gate.log).toBe('[typecheck] FAIL');
  });

  // ⛔⭐ seam 미호출만 단언하면 **조용한 스킵과 구별되지 않는다**(리뷰 1R) — 스킵도
  //   `gate.log` 에 사유가 남아야 리뷰어가 *"왜 음성 대조가 없나"* 에 답할 수 있다.
  test('skipTestStep이면 seam을 실행하지 않고 gate.log에 사유를 남긴다', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'README.md'), 'docs only\n');
    let calls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: true, steps: [], log: '[test] SKIPPED' }),
      runVerifyByBreaking: () => { calls += 1; return { files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }; },
    }).gate(cwd);
    expect(gate.passed).toBe(true);
    expect(calls).toBe(0);
    // ⭐ 사유가 원문으로 남고, 기존 reader 가 그 줄을 집어 간다(= 리뷰어에게 도달한다).
    //   ⚠️ 완전일치로 고정하지 않는다 — 같은 경로에 `[gate-scope]` 주석이 뒤따르고, 그것을
    //   계약으로 삼으면 무관한 문면 변경이 이 테스트를 깬다(재는 것은 **스킵 사유의 도달**이다).
    const line = 'Verify-by-breaking: skipped; reason=docs-only; evaluated-changes=[README.md]; test-step=scope-skipped';
    expect(gate.log).toContain(line);
    expect(gateEvidenceNote(gate)).toContain(line);
  });

  // ⛔⭐ `does-not-distinguish` 는 **리뷰어가 물어야 할 자리**(Goodhart 후보)다 — 그 파일 이름이
  //   `gate.log` 를 거쳐 **reader 까지** 가는지 직접 잰다(리뷰 2R should-fix). 개수만 가고
  //   파일 이름이 빠지면 리뷰어는 *"어느 테스트인가"* 를 물을 수 없다.
  test('⭐ does-not-distinguish 파일 이름과 역방향 대조가 gate.log 와 reader 까지 간다', async () => {
    const cwd = changedRepo();
    let reverseCalls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
      runVerifyByBreaking: () => ({
        baseStatuses: { pass: 1, 'test-fail': 0, unknown: 0 },
        files: [{ file: 'test/nodiff.test.js', classification: 'does-not-distinguish', base: { status: 'pass', output: '1 pass', log: 'base passed too' } }],
      }),
      runReverseVerifyByBreaking: (_cwd, files) => {
        reverseCalls += 1;
        expect(files).toEqual(['test/nodiff.test.js']);
        return { ran: true, files: [{ file: 'test/nodiff.test.js', head: { status: 'test-fail', output: '1 fail', log: 'head failed' } }], headStatuses: { pass: 0, 'test-fail': 1, unknown: 0 } };
      },
    }).gate(cwd);
    expect(reverseCalls).toBe(1);
    expect(gate.log).toContain('does-not-distinguish=1');
    expect(gate.log).toContain('test/nodiff.test.js=does-not-distinguish');
    expect(gate.log).toContain('Reverse verify-by-breaking: ran=true; head-pass=0, head-test-fail=1, head-unknown=0');
    // ⭐ 핵심 — 기존 reader 가 그 줄을 집어 간다(= 리뷰어 프롬프트에 도달한다).
    expect(gateEvidenceNote(gate)).toContain('Reverse verify-by-breaking: ran=true; head-pass=0, head-test-fail=1, head-unknown=0');
    // ⭐ 복원이 성공한 경우엔 게이트를 **막지 않는다**(아래 차단 테스트의 대조군이다).
    expect(gate.passed).toBe(true);
  });

  // ⛔⭐ **없어진 시험 하나** — 「복원 실패가 게이트를 막는다」(R1·R2 로 만든 것)는 R4 설계 정정으로
  //   ***계약 자체가 사라졌다***(격리 실행이라 오염이 불가능하다). 그 자리는 아래 「작업 트리를
  //   한 바이트도 안 건드린다」가 대체한다 — 더 강한 단언이다.

  test('⭐ gate 통과 시 정방향 네 분류 모두를 한 번의 역방향 대조에 요청하고 결과를 남긴다', async () => {
    const cwd = changedRepo();
    let reverseCalls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
      runVerifyByBreaking: () => ({
        baseStatuses: { pass: 1, 'test-fail': 1, unknown: 1 },
        files: [
          { file: 'test/distinguishes.test.js', classification: 'distinguishes', base: { status: 'test-fail', output: '1 fail', log: 'base failed' } },
          { file: 'test/nodiff.test.js', classification: 'does-not-distinguish', base: { status: 'pass', output: '1 pass', log: 'base passed too' } },
          { file: 'test/unknown.test.js', classification: 'unknown', base: { status: 'unknown', output: 'module load failed', log: 'module load failed', unknownReason: 'module-load-error' } },
          { file: 'test/new-file.test.js', classification: 'missing-at-base', base: { status: 'test-fail', output: 'base lacks file', log: 'base lacks file' } },
        ],
      }),
      runReverseVerifyByBreaking: (_cwd, files, sources) => {
        reverseCalls += 1;
        expect(files).toEqual([
          'test/distinguishes.test.js',
          'test/nodiff.test.js',
          'test/unknown.test.js',
          'test/new-file.test.js',
        ]);
        expect(sources).toEqual([]);
        return {
          ran: true,
          files: files.map((file) => ({ file, head: { status: file === 'test/nodiff.test.js' ? 'test-fail' as const : 'unknown' as const, output: `${file} reverse result`, log: `${file} reverse result` } })),
          headStatuses: { pass: 0, 'test-fail': 1, unknown: 3 },
        };
      },
    }).gate(cwd);
    expect(reverseCalls).toBe(1);
    expect(gate.passed).toBe(true);
    expect(gate.log).toContain('Reverse verify-by-breaking: ran=true; head-pass=0, head-test-fail=1, head-unknown=3');
    expect(gate.log).not.toContain('status=not-requested');
  });

  test('gate 미통과 시 정방향 분류와 무관하게 역방향을 요청하지 않는다', async () => {
    const cwd = changedRepo();
    let forwardCalls = 0;
    let reverseCalls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: false, steps: [{ name: 'test', ok: false, skipped: false, summary: 'fail', output: '1 fail' }], log: '[test] FAIL' }),
      runVerifyByBreaking: () => { forwardCalls += 1; return { files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }; },
      runReverseVerifyByBreaking: () => { reverseCalls += 1; return { ran: false, files: [], headStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }; },
    }).gate(cwd);
    expect(gate.passed).toBe(false);
    expect(forwardCalls).toBe(0);
    expect(reverseCalls).toBe(0);
  });


  // ⛔⭐⭐ **절단이 역방향 절을 죽이지 않는다**(리뷰 must-fix R2) — forward 가 상한을 넘길 만큼
  //   커도 `Reverse verify-by-breaking:` 표지와 카운트는 «살아남아야» 한다. 종전 판은 합친
  //   문자열의 끝을 잘라서 그 절이 통째로 사라졌다.
  test('⭐ forward note 가 상한을 넘겨도 역방향 절이 살아남는다', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      file: `test/very-long-name-to-blow-the-note-limit-${i}.test.js`,
      classification: 'does-not-distinguish' as const,
      base: { status: 'pass' as const, output: 'x'.repeat(200), log: 'base passed too' },
    }));
    const note = formatVerifyByBreakingNote(
      { baseStatuses: { pass: many.length, 'test-fail': 0, unknown: 0 }, files: many },
      { ran: true, files: [{ file: 'test/nodiff.test.js', head: { status: 'test-fail', output: '1 fail', log: 'head failed' } }], headStatuses: { pass: 0, 'test-fail': 1, unknown: 0 } },
    );
    expect(note).toContain('Reverse verify-by-breaking: ran=true');
    expect(note).toContain('head-test-fail=1');
    expect(note).not.toContain('\n');

  });


  // ⛔⭐ **조용한 스킵 0 의 회귀 가드**(리뷰 3R should-fix) — 네 사유가 각각 `gate.log` 에 남고
  //   reader 까지 가는지 **사유별로** 잰다. 하나라도 빠지면 리뷰어는 *"왜 음성 대조가 없나"* 에
  //   답할 수 없고, 그 침묵이 *"대조했고 아무것도 없었다"* 로 읽힌다.
  test('⭐ test 스텝이 없거나 skip 이면 사유가 gate.log 와 reader 에 남는다', async () => {
    const cases: Array<{ steps: GateResult['steps']; why: string }> = [
      { steps: [], why: 'no-test-step' },
      { steps: [{ name: 'test', ok: true, skipped: true, summary: 'skipped', output: '' }], why: 'test-step-skipped' },
    ];
    for (const { steps, why } of cases) {
      const cwd = changedRepo();
      let calls = 0;
      const gate = await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps, log: '[test] ?' }),
        runVerifyByBreaking: () => { calls += 1; return { files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }; },
      }).gate(cwd);
      expect(calls).toBe(0);
      expect(gate.log).toContain(`Verify-by-breaking: skipped; reason=${why}`);
      expect(gateEvidenceNote(gate)).toContain(`reason=${why}`);
    }
  });

  // ⛔⭐⭐ `derived` 는 **자식이 테스트를 하나도 안 건드린 경우**다 — 그때 base 에 돌리면 당연히
  //   통과해 `does-not-distinguish` 라는 **거짓 증거**가 난다. 실행 없이 사유를 남겨야 한다(6R·7R).
  test('⭐ derived 스코프면 seam 을 안 부르고 no-edited-tests 사유가 reader 까지 간다', async () => {
    const cwd = repo();
    // 소스만 바꾸고 그 연관 테스트가 실존 ⇒ scope.reason='derived'
    // ⚠️ `deriveRelatedTests` 는 **`src/` 아래 소스**의 co-located 테스트만 유도한다(실측).
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/value.js'), 'export const value = 1;\n');
    writeFileSync(join(cwd, 'src/value.test.js'), "import { test } from 'bun:test'; test('v', () => {});\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'with test');
    writeFileSync(join(cwd, 'src/value.js'), 'export const value = 2;\n');   // 소스만 변경
    let calls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
      runVerifyByBreaking: () => { calls += 1; return { files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } }; },
    }).gate(cwd);
    expect(calls).toBe(0);                                        // ⇒ base 를 안 돌렸다
    expect(gate.log).toContain('Verify-by-breaking: skipped; reason=no-edited-tests');
    expect(gate.log).toContain('scope=derived');
    expect(gateEvidenceNote(gate)).toContain('reason=no-edited-tests');   // ⭐ reader 도달
  });

  test('gate 통과 경로에서는 기존 baseline을 재지 않는다', async () => {
    const cwd = changedRepo();
    let baselineCalls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({
        passed: true,
        steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }],
        log: '[test] PASS',
      }),
      runGateBaseline: () => {
        baselineCalls += 1;
        return { status: 'pass', output: '1 pass', log: 'unused' };
      },
    }).gate(cwd);
    expect(gate.passed).toBe(true);
    expect(baselineCalls).toBe(0);
  });
});

describe('verify by breaking', () => {

  // ⛔⭐⭐ 위 검사는 `unknown` 을 **직접 주입**한다 — 그것만으로는 *"실행 불가가 정말 unknown 으로
  //   오나"* 를 아무것도 증명하지 않는다(리뷰 1R: Goodhart 테스트). 가장 흔한 실행 불가 경로는
  //   **base 에 없는 helper 를 새 테스트가 import** 하는 것이고, 그때 bun 은 **exit 1** 을 낸다
  //   ⇒ `status===0` 선분기를 통과해 `hasInfrastructureFailure` 까지 가야 한다.
  //   ⚠️ 아래 출력은 실측 원문이다(bun 1.3.12 · `Cannot find module`).
  test('⭐ base 에 없는 모듈을 import 한 실행 불가는 test-fail 이 아니라 unknown 으로 온다 (실제 경로)', () => {
    const loaderFailure = [
      'a.test.ts:',
      '',
      '# Unhandled error between tests',
      '-------------------------------',
      "error: Cannot find module './missing-helper.js' from '/tmp/probe/a.test.ts'",
      '-------------------------------',
      '',
      ' 0 pass',
      ' 1 fail',
      ' 1 error',
      'Ran 1 test across 1 file. [17.00ms]',
    ].join('\n');
    const base = classifyBaselineProcess({ status: 1, stdout: loaderFailure, stderr: '' });
    // ⛔ 여기가 핵심 — `test-fail` 로 오면 아래 분류가 `distinguishes` 라는 **거짓 양성**이 된다.
    expect(base.status).toBe('unknown');
    // ⊕ 음성 대조 — **진짜 테스트 실패**는 같은 exit 1 인데 `test-fail` 로 갈려야 한다.
    const realFailure = ['b.test.ts:', 'error: expect(received).toBe(expected)', '(fail) plain fail', ' 0 pass', ' 1 fail'].join('\n');
    const red = classifyBaselineProcess({ status: 1, stdout: realFailure, stderr: '' });
    expect(red.status).toBe('test-fail');
  });

  test('실제 Bun loader export 부재만 module-load-error이고 assertion에 인용된 문구는 test-fail이다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gate-baseline-module-load-'));
    roots.push(cwd);
    writeFileSync(join(cwd, 'subject.mjs'), 'export const present = true;\n');
    writeFileSync(join(cwd, 'loader.test.mjs'), "import { missing } from './subject.mjs';\nconsole.log(missing);\n");
    writeFileSync(join(cwd, 'assertion.test.ts'), [
      "import { expect, test } from 'bun:test';",
      "test('quotes a loader diagnostic after loading', () => {",
      "  expect(\"SyntaxError: Export named 'missing' not found in module './subject.ts'\").toBe('different');",
      '});',
      '',
    ].join('\n'));

    const loader = spawnSync('bun', ['test', 'loader.test.mjs'], { cwd, encoding: 'utf8' });
    const assertion = spawnSync('bun', ['test', 'assertion.test.ts'], { cwd, encoding: 'utf8' });
    const moduleLoad = classifyBaselineProcess(loader);
    const quotedDiagnostic = classifyBaselineProcess(assertion);
    const requestedModuleDiagnostic = classifyBaselineProcess({
      status: 1,
      stdout: "SyntaxError: The requested module './subject.ts' does not provide an export named 'missing'",
    });

    expect(moduleLoad).toMatchObject({ status: 'unknown', unknownReason: 'module-load-error' });
    expect(quotedDiagnostic.status).toBe('test-fail');
    expect(requestedModuleDiagnostic).toMatchObject({ status: 'unknown', unknownReason: 'module-load-error' });

    const unavailable = classifyBaselineProcess({ status: 1, stdout: 'process exited before producing test output' });
    expect(unavailable).toMatchObject({ status: 'unknown', unknownReason: 'test-result-unavailable' });
    const note = formatVerifyByBreakingNote({
      files: [
        { file: 'test/goal-author.test.ts', classification: 'unknown', base: moduleLoad },
        { file: 'test/unavailable.test.ts', classification: 'unknown', base: unavailable },
      ],
      baseStatuses: { pass: 0, 'test-fail': 0, unknown: 2 },
    });
    expect(note).toContain('Verify-by-breaking: distinguishes=0, does-not-distinguish=0, unknown=2, missing-at-base=0;');
    expect(note).toContain('test/goal-author.test.ts=unknown(module-load-error; child-responsibility=none;');
    expect(note).toContain('test/unavailable.test.ts=unknown(test-result-unavailable;');
  });

  // ⛔⭐⭐ 위 검사도 **출력을 손으로 만든다**(리뷰 2R) — 그건 *"bun 이 그런 출력을 내나"* 를
  //   증명하지 못한다. ⇒ **실제 `runVerifyByBreaking` 을 돌린다**: base 에 없는 모듈을 import 하는
  //   새 테스트를 만들면 base 워크트리에서 로더 오류가 나고, 그것이 `unknown` 으로 와야 한다.
  //   ⛔ 여기서 `test-fail` 이 오면 분류가 `distinguishes` 라는 **거짓 양성**이 되고,
  //     *"이 테스트가 실제로 가른다"* 를 리뷰어에게 잘못 보고하게 된다.
  // ⛔⭐ 파일별 상한만 있으면 편집 테스트 수에 **비례해 한 줄이 무한히** 커진다(리뷰 2R).
  // ⛔⭐ git 경로에는 **개행이 합법**이다 — 그대로 실으면 증거가 여러 물리 줄로 쪼개져
  //   reader 의 줄 단위 필터가 뒷부분을 버린다(리뷰 3R).
  test('⭐ 개행이 든 파일명도 한 줄로 접힌다 (reader 가 뒷부분을 안 버린다)', () => {
    const note = formatVerifyByBreakingNote({
      files: [{ file: 'test/we\nird.test.js', classification: 'distinguishes', base: { status: 'test-fail', output: 'x', log: 'l' } }],
      baseStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
    });
    expect(note.split('\n')).toHaveLength(1);
    expect(note).toContain('test/we ⏎ ird.test.js=distinguishes');
  });


  // ⛔⭐⭐ **roster 자체가 상한을 넘는 경우**(긴 파일명 · 많은 파일) — 8R 이 잡은 결함이다.
  //   종전엔 전체를 뒤에서 잘라 **이름이 중간에서 끊기고** 떨군 개수도 안 남았다.
  // ⛔⭐⭐ **절단돼도 거부 사유는 남아야 한다**(리뷰 9R) — 종전엔 사유가 출력 쪽에만 있어
  //   절단되면 통째로 사라졌다. 사유를 roster 로 옮긴 것이 그 처방이고 이것이 그 가드다.
  test('⭐⭐ 절단이 일어나도 unknown 의 거부 사유가 reader 까지 간다', () => {
    const many = Array.from({ length: 30 }, (_u, i) => ({
      file: `test/f${i}.test.js`,
      classification: i === 29 ? ('unknown' as const) : ('distinguishes' as const),
      base: i === 29
        ? { status: 'unknown' as const, log: 'refusing to copy outside baseline worktree: /elsewhere', output: 'refusing to copy outside baseline worktree: /elsewhere' }
        : { status: 'test-fail' as const, output: 'z'.repeat(1_500), log: 'base failed' },
    }));
    const note = formatVerifyByBreakingNote({ files: many, baseStatuses: { pass: 0, 'test-fail': 29, unknown: 1 } });
    expect(note.length).toBeLessThanOrEqual(6_000);
    expect(note).toContain('note truncated');                              // ⇒ 실제로 잘렸다
    expect(note).toContain('test/f29.test.js=unknown');                    // ⭐ 이름·분류 생존
    expect(note).toContain('refusing to copy outside baseline worktree');  // ⭐⭐ **사유 생존**
  });

  test('⭐⭐ roster 가 상한을 넘으면 이름을 중간에서 끊지 않고 떨군 개수를 남긴다', () => {
    const many = Array.from({ length: 60 }, (_u, i) => ({
      file: `test/${'very-long-directory-name/'.repeat(4)}file-${i}.test.js`,
      classification: 'distinguishes' as const,
      base: { status: 'test-fail' as const, output: 'y'.repeat(1_500), log: 'l' },
    }));
    const note = formatVerifyByBreakingNote({ files: many, baseStatuses: { pass: 0, 'test-fail': 60, unknown: 0 } });
    expect(note.length).toBeLessThanOrEqual(6_000);
    expect(note).toMatch(/\[\+\d+ files omitted\]/);           // ⛔ 떨군 개수를 반드시 남긴다
    // ⭐ 남은 이름은 **온전해야 한다** — 마지막 항목이 `…=classification]` 로 끝난다(중간 절단 없음).
    expect(note).toMatch(/file-\d+\.test\.js=distinguishes\] \[\+\d+ files omitted\]/);
    expect(note).toContain('note truncated; originalChars=');
  });

  test('⭐ 줄 전체 상한을 넘으면 자르되 원래 크기를 남긴다 (조용한 절단 금지)', () => {
    const many = Array.from({ length: 40 }, (_u, i) => ({
      file: `test/f${i}.test.js`,
      classification: 'distinguishes' as const,
      base: { status: 'test-fail' as const, output: 'x'.repeat(1_000), log: 'base failed' },
    }));
    const note = formatVerifyByBreakingNote({ files: many, baseStatuses: { pass: 0, 'test-fail': 40, unknown: 0 } });
    expect(note.startsWith('Verify-by-breaking: distinguishes=40')).toBe(true);
    expect(note).toContain('note truncated; originalChars=');
    expect(note).toContain('files=40');
    // ⛔⭐ **모든 파일의 이름·분류가 남아야 한다**(수용기준 4 · 리뷰 7R) — roster 를 출력보다
    //   앞에 두는 이유가 이것이다. 하나라도 빠지면 리뷰어가 그 파일을 지목할 수 없다.
    for (let i = 0; i < 40; i += 1) expect(note).toContain(`test/f${i}.test.js=`);
    // ⛔ 자른 뒤에도 표지를 포함해 상한 근처에 머문다(무한 성장 없음).
    expect(note.length).toBeLessThan(6_200);
  });

  // ⛔⭐⭐ **경로 봉쇄 회귀 테스트**(리뷰 4R) — base 커밋에 **밖을 가리키는 symlink 디렉터리**가
  //   있으면 `git worktree add` 가 그 symlink 를 그대로 materialize 한다. 그때 복사가
  //   **워크트리 밖에 쓰거나 지우면** 안 된다. ⚠️ 3R 판은 검사 순서가 틀려 `mkdirSync`/`rmSync` 가
  //   **검사 전에** 돌았고, 이 테스트가 그 순서를 고정한다.
  test('⭐⭐ base 의 조상이 외부 symlink 면 밖을 건드리지 않고 unknown 이다', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gate-baseline-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'victim.txt'), 'do not touch\n');
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    // base 커밋에 `test` 를 **바깥을 가리키는 symlink** 로 넣는다.
    symlinkSync(outside, join(cwd, 'test'), 'dir');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base with symlinked test dir');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // worktree(현재)에서는 그 자리에 실제 테스트가 있다고 보고 파일을 만든다.
    writeFileSync(join(outside, 'sym.test.js'), "import { expect, test } from 'bun:test'; test('t', () => expect(1).toBe(1));\n");
    const result = runVerifyByBreaking(cwd, ['test/sym.test.js'], baseRef);
    // ⚠️ **이 테스트가 재는 것의 범위**(과장 금지): 가드를 무력화하면 이 fixture 는
    //   `refusing to copy outside…` 대신 **`ENOENT`** 로 죽는다 — 즉 **실제 탈출까지 재현하지는
    //   못한다.** 재는 것은 ***"가드가 쓰기·삭제보다 먼저 돌아 거부한다"*** 와 **바깥 무손상**이고,
    //   그 둘은 3R 판(검사가 `mkdirSync`/`rmSync` 뒤에 있던 판)에서는 성립하지 않았다.
    // ⭐ 밖으로 쓰지 않았으므로 판정은 **unknown** 이다(거부가 곧 모름이다).
    expect(result.files[0]?.classification).toBe('unknown');
    expect(result.files[0]?.base.log).toContain('refusing to copy outside baseline worktree');
    // ⛔ 바깥 파일이 **그대로** 있어야 한다(삭제·덮어쓰기 0).
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('do not touch\n');
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.includes('elanous-gate-baseline-')).toBe(false);
  });

  // ⛔⭐⭐ **실제 base-pass 경로**(리뷰 11R) — 종전 `does-not-distinguish` 검사는 seam 에 **완성된
  //   결과를 주입**해 생산 분류를 우회했다 ⇒ pass 매핑이 틀려도 통과한다. 진짜로 돌린다.
  test('⭐⭐ 실제 실행 — base 에서도 통과하는 테스트는 does-not-distinguish 이면서 기준이 기본 브랜치임을 함께 낸다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    // ⭐ base 에 **소스와 테스트가 이미 있고 통과**한다 ⇒ 그 테스트는 아무것도 안 가른다.
    writeFileSync(join(cwd, 'test/weak.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('weak', () => expect(typeof value).toBe('boolean'));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base with passing test');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    setAuthoritativeDefaultBranch(cwd);
    writeFileSync(join(cwd, 'src.js'), 'export const value = false;\n');   // 소스만 바꿔도 그 테스트는 여전히 통과
    const result = runVerifyByBreaking(cwd, ['test/weak.test.js'], baseRef);
    expect(result.files[0]?.base.status).toBe('pass');
    expect(result.files[0]?.classification).toBe('does-not-distinguish');
    expect(result.baseStatuses).toEqual({ pass: 1, 'test-fail': 0, unknown: 0 });
    expect(result.baselineDefaultBranchAncestry).toBe('ancestor');
  });

  test('권위 있는 기본 브랜치 ref가 없으면 main이 존재해도 측정 기준은 unknown이다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/weak.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('weak', () => expect(value).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'main exists without origin head');
    const result = runVerifyByBreaking(cwd, ['test/weak.test.js'], 'HEAD');
    expect(result.files[0]?.classification).toBe('does-not-distinguish');
    expect(result.baselineDefaultBranchAncestry).toBe('unknown');
    expect(formatVerifyByBreakingNote(result)).toContain('baseline-default-branch=unknown');
  });

  test('⭐⭐ baseline이 비기본 브랜치면 does-not-distinguish 옆에 측정 기준 관측을 남기고 리뷰어에게 전달한다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/stacked.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('stacked', () => expect(value).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'default base');
    setAuthoritativeDefaultBranch(cwd);
    git(cwd, 'checkout', '-b', 'stacked');
    writeFileSync(join(cwd, 'stacked.js'), 'export const stacked = true;\n');
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'stacked baseline');
    const result = runVerifyByBreaking(cwd, ['test/stacked.test.js'], 'HEAD');
    const note = formatVerifyByBreakingNote(result);
    expect(result.files[0]?.classification).toBe('does-not-distinguish');
    expect(result.baselineDefaultBranchAncestry).toBe('not-ancestor');
    expect(note).toContain('does-not-distinguish=1');
    expect(note).toContain('baseline-default-branch=not-ancestor (measurement baseline is not an ancestor of the default branch)');
    expect(gateEvidenceNote({ passed: true, log: note })).toContain('baseline-default-branch=not-ancestor');
  });

  // ⛔⭐ 축소될 때 **must-see(does-not-distinguish · unknown)가 먼저 살아남는가**(리뷰 11R).
  test('⭐⭐ roster 축소 시 does-not-distinguish 와 unknown 이 먼저 남는다', () => {
    const many = Array.from({ length: 60 }, (_u, i) => {
      const long = `test/${'very-long-directory-name/'.repeat(4)}file-${i}.test.js`;
      if (i === 58) return { file: long, classification: 'does-not-distinguish' as const, base: { status: 'pass' as const, output: 'p', log: 'base passed too' } };
      if (i === 59) return { file: long, classification: 'unknown' as const, base: { status: 'unknown' as const, log: 'refusing to copy outside baseline worktree: /elsewhere', output: 'refusing to copy outside baseline worktree: /elsewhere' } };
      return { file: long, classification: 'distinguishes' as const, base: { status: 'test-fail' as const, output: 'y'.repeat(1_500), log: 'l' } };
    });
    const note = formatVerifyByBreakingNote({ files: many, baseStatuses: { pass: 1, 'test-fail': 58, unknown: 1 } });
    expect(note.length).toBeLessThanOrEqual(6_000);
    expect(note).toMatch(/\[\+\d+ files omitted\]/);
    // ⭐ 뒤에 있던 둘이 **먼저** 살아남는다.
    expect(note).toContain('file-58.test.js=does-not-distinguish');
    expect(note).toContain('file-59.test.js=unknown');
    expect(note).toContain('refusing to copy outside baseline worktree');
  });

  test('⭐⭐ 실제 실행 — base 에 없는 모듈을 import 하면 unknown 이지 distinguishes 가 아니다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    // 테스트 파일은 base에 있고 helper만 없다. 파일 부재와 모듈 부재를 분리한다.
    writeFileSync(join(cwd, 'test/needs-helper.test.js'), "import { expect, test } from 'bun:test'; import { helper } from '../helper.js'; test('uses helper', () => expect(helper()).toBe(1));\n");
    git(cwd, 'add', 'package.json', 'test/needs-helper.test.js');
    git(cwd, 'commit', '-m', 'base without helper');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'helper.js'), 'export const helper = () => 1;\n');
    expect(spawnSync('git', ['cat-file', '-e', `${baseRef}:helper.js`], { cwd }).status).toBe(128);
    const result = runVerifyByBreaking(cwd, ['test/needs-helper.test.js'], baseRef);
    const entry = result.files[0];
    expect(entry?.file).toBe('test/needs-helper.test.js');
    expect(entry?.base.status).toBe('unknown');
    expect(entry?.classification).toBe('unknown');
    expect(result.baseStatuses).toEqual({ pass: 0, 'test-fail': 0, unknown: 1 });
    // ⛔ 워크트리를 남기지 않는다.
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.includes('elanous-gate-baseline-')).toBe(false);
  });

  test('base에 없는 테스트는 missing-at-base로 따로 세고 test-fail 및 distinguishes에서 제외한다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    git(cwd, 'add', 'package.json');
    git(cwd, 'commit', '-m', 'base without test');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/new.test.js'), "import { expect, test } from 'bun:test'; test('new contract', () => expect(false).toBe(true));\n");

    const result = runVerifyByBreaking(cwd, ['test/new.test.js'], baseRef);

    expect(result.files[0]?.classification).toBe('missing-at-base');
    expect(result.files[0]?.base.status).toBe('test-fail');
    expect(result.baseStatuses).toEqual({ pass: 0, 'test-fail': 0, unknown: 0 });
    expect(formatVerifyByBreakingNote(result)).toContain('Verify-by-breaking: distinguishes=0, does-not-distinguish=0, unknown=0, missing-at-base=1;');
  });

  test('base의 다른 blob에 pathspec 와일드카드가 맞아도 literal 테스트 파일은 missing-at-base다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/literalX.test.js'), "import { test } from 'bun:test'; test('base sibling', () => {});\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base wildcard sibling');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'test/literal*.test.js'), "import { expect, test } from 'bun:test'; test('literal wildcard', () => expect(false).toBe(true));\n");

    const result = runVerifyByBreaking(cwd, ['test/literal*.test.js'], baseRef);

    expect(result.files[0]?.classification).toBe('missing-at-base');
    expect(result.files[0]?.base.status).toBe('test-fail');
    expect(result.baseStatuses).toEqual({ pass: 0, 'test-fail': 0, unknown: 0 });
    expect(formatVerifyByBreakingNote(result)).toContain('missing-at-base=1;');
  });

  test('base의 tree가 현재 테스트 파일 경로와 같아도 missing-at-base다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test/replaced.test.js'), { recursive: true });
    writeFileSync(join(cwd, 'test/replaced.test.js/nested.js'), 'export const nested = true;\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base tree at test path');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    rmSync(join(cwd, 'test/replaced.test.js'), { recursive: true });
    writeFileSync(join(cwd, 'test/replaced.test.js'), "import { expect, test } from 'bun:test'; test('replaced path', () => expect(false).toBe(true));\n");

    const result = runVerifyByBreaking(cwd, ['test/replaced.test.js'], baseRef);

    expect(result.files[0]?.classification).toBe('missing-at-base');
    expect(result.files[0]?.base.status).toBe('test-fail');
    expect(result.baseStatuses).toEqual({ pass: 0, 'test-fail': 0, unknown: 0 });
    expect(formatVerifyByBreakingNote(result)).toContain('missing-at-base=1;');
  });

  test('base ref Git 오류는 missing-at-base가 아니라 unknown으로 보존한다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/value.test.js'), "import { test } from 'bun:test'; test('value', () => {});\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base test');

    const result = runVerifyByBreaking(cwd, ['test/value.test.js'], 'missing-base-ref');

    expect(result.files[0]?.classification).toBe('unknown');
    expect(result.files[0]?.base.status).toBe('unknown');
    expect(result.baseStatuses).toEqual({ pass: 0, 'test-fail': 0, unknown: 1 });
    expect(formatVerifyByBreakingNote(result)).toContain('Verify-by-breaking: distinguishes=0, does-not-distinguish=0, unknown=1, missing-at-base=0;');
  });

  test('현재 worktree에만 있는 새 테스트를 base 코드에 복사해 실행하고 정리한다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = false;\n');
    git(cwd, 'add', 'package.json', 'src.js');
    git(cwd, 'commit', '-m', 'base source only');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    setAuthoritativeDefaultBranch(cwd);
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    writeFileSync(join(cwd, 'test/value.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('new contract', () => expect(value).toBe(true));\n");
    expect(spawnSync('git', ['cat-file', '-e', `${baseRef}:test/value.test.js`], { cwd }).status).toBe(128);
    const result = runVerifyByBreaking(cwd, ['test/value.test.js'], baseRef);
    // ⛔⭐ **버전 배너를 계약으로 고정하지 않는다**(리뷰 1R) — `bun test v1.3.12 (700fc117)` 를
    //   그대로 단언하면 **런타임 패치 업데이트만으로 이 테스트가 깨진다.** 재는 것은
    //   *"실패 출력의 의미 있는 부분이 원문 그대로 실리는가"* 이지 bun 의 버전이 아니다.
    const normalizeTiming = (text: string | undefined) => (text ?? '')
      .replace(/\[\d+\.\d+ms\]/g, '[TIME]')
      .replace(/^\(fail\) new contract$/m, '(fail) new contract [TIME]')
      .replace(/^bun test v[\d.]+ \([0-9a-f]+\)$/m, 'bun test [VERSION]');
    const normalized = {
      ...result,
      files: result.files.map((entry) => ({ ...entry, base: { ...entry.base, output: normalizeTiming(entry.base.output) } })),
    };
    const expectedOutput = [
      'bun test [VERSION]',
      '',
      '',
      'test/value.test.js:',
      'error: expect(received).toBe(expected)',
      '',
      'Expected: true',
      'Received: false',
      '',
      '(fail) new contract [TIME]',
      '',
      ' 0 pass',
      ' 1 fail',
      ' 1 expect() calls',
      'Ran 1 test across 1 file. [TIME]',
      '',
    ].join('\n');
    expect(normalized).toEqual({
      baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 },
      baselineDefaultBranchAncestry: 'ancestor',
      files: [{
        file: 'test/value.test.js',
        classification: 'missing-at-base',
        base: {
          status: 'test-fail',
          log: 'baseline tests failed with code 1',
          output: expectedOutput,
          passedTestEvidence: { status: 'available', tests: [] },
        },
      }],
    });
    const note = formatVerifyByBreakingNote(normalized);
    expect(note).toContain('Verify-by-breaking: distinguishes=0, does-not-distinguish=0, unknown=0, missing-at-base=1; baseline-default-branch=ancestor;');
    expect(note).toContain('test/value.test.js > new contract [TIME]: error: expect(received).toBe(expected)');
    expect(note).toContain('error: expect(received).toBe(expected) ⏎  ⏎ Expected: true ⏎ Received: false');
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.includes('elanous-gate-baseline-')).toBe(false);
  });

  test('test-only 변경에서 base 테스트를 «격리 워크트리의» 현재 소스에 돌려 실패를 관측한다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/value.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('old contract', () => expect(value).toBe(false));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base contract');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'test/value.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('new contract', () => expect(value).toBe(true));\n");

    const forward = runVerifyByBreaking(cwd, ['test/value.test.js'], baseRef);
    expect(forward.files[0]?.classification).toBe('does-not-distinguish');
    const reverse = runReverseVerifyByBreaking(cwd, ['test/value.test.js'], [], baseRef);
    expect(reverse).toMatchObject({ ran: true, headStatuses: { pass: 0, 'test-fail': 1, unknown: 0 } });
    expect(reverse.files[0]?.head.status).toBe('test-fail');
    expect(reverse.files[0]?.head.output).toContain('Expected: false');
    expect(readFileSync(join(cwd, 'test/value.test.js'), 'utf8')).toContain('new contract');
    const note = formatVerifyByBreakingNote(forward, reverse);
    expect(note).toContain('Reverse verify-by-breaking: ran=true; head-pass=0, head-test-fail=1, head-unknown=0');
    expect(note).toContain('output=');
    expect(note).toContain('Expected: false');
  });

  // ⛔⭐⭐⭐⭐ **새 계약 — 작업 트리를 «한 바이트도» 안 건드린다**(리뷰 R4 설계 정정).
  //   종전 판은 base 판 테스트를 «실제 작업 트리»에 덮어쓰고 되돌렸고, 리뷰가 그 길에서 결함을
  //   네 라운드에 걸쳐 여덟 냈다(mode·symlink·삭제·디렉터리·읽기전용·전-대상 스냅샷·
  //   첫 실패 중단·**비-대상 파일 오염**). 마지막 것은 «원리적으로» 못 막는다.
  //   ⇒ 이제 격리 워크트리에서 돌므로 ***base 테스트가 무슨 짓을 해도 작업 트리는 그대로다.***
  //   그 사실을 시험이 «직접» 잰다 — 이것이 복원 계약 전체를 대체하는 하나의 단언이다.
  test.each([
    ['자기 파일을 삭제', "import { rmSync } from 'node:fs'; import { test } from 'bun:test'; test('deletes', () => rmSync(new URL(import.meta.url)));"],
    ['자기 파일을 잠금', "import { chmodSync } from 'node:fs'; import { test } from 'bun:test'; test('locks', () => chmodSync(new URL(import.meta.url), 0o444));"],
    ['«남의» 소스를 덮어씀', "import { writeFileSync } from 'node:fs'; import { test } from 'bun:test'; test('writes elsewhere', () => writeFileSync(new URL('../src.js', import.meta.url), 'export const value = 999;\\n'));"],
  ])('⭐ base 테스트가 %s 해도 작업 트리의 «추적 파일»은 한 바이트도 안 바뀐다', (_label, baseSource) => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/value.test.js'), `${baseSource}\n`);
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base sabotages');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    const target = join(cwd, 'test/value.test.js');
    const edited = "import { test } from 'bun:test'; test('edited', () => {});\n";
    writeFileSync(target, edited);
    chmodSync(target, 0o644);
    const beforeStatus = git(cwd, 'status', '--porcelain');
    const beforeSource = readFileSync(join(cwd, 'src.js'), 'utf8');

    runReverseVerifyByBreaking(cwd, ['test/value.test.js'], [], baseRef);

    // ⭐ 핵심 — 편집 테스트도, «남의 소스»도, git 이 보는 상태도 그대로다.
    // ⚠️ 이 단언은 «추적 파일»에 대한 것이다 — `node_modules` 는 격리 워크트리가 원 트리로
    //   «링크»하므로 그 밖이다(리뷰 R10 · forward 대조도 같은 성질이다).
    expect(readFileSync(target, 'utf8')).toBe(edited);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(cwd, 'src.js'), 'utf8')).toBe(beforeSource);
    expect(git(cwd, 'status', '--porcelain')).toBe(beforeStatus);
    expect(git(cwd, 'diff', '--summary')).not.toContain('mode change');
    // ⊕ 임시 워크트리를 남기지 않는다.
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' }).stdout).not.toContain('elanous-gate-baseline-');
  });

  // ⛔⭐⭐ **혼합 변경 — 「현 소스」가 실제로 얹히는지 잰다**(리뷰 R3·R4). 바뀐 소스를 넘기면
  //   base 판 테스트가 «그 소스»를 보고 판정한다. 이 단언이 없으면 「옛 소스 × 옛 테스트」를
  //   돌려 놓고 「현 소스」라 부를 수 있다(= 이 대조 전체가 거짓이 된다).
  test('⭐ 바뀐 소스를 넘기면 base 테스트가 «현» 소스를 보고 판정한다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/value.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('base contract', () => expect(value).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // 소스를 «깨고» 테스트도 그에 맞춰 고친 혼합 변경.
    writeFileSync(join(cwd, 'src.js'), 'export const value = false;\n');
    writeFileSync(join(cwd, 'test/value.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('new contract', () => expect(value).toBe(false));\n");

    // ⓐ 바뀐 소스를 «안» 넘기면 base 소스가 그대로라 base 테스트가 통과한다(정보 0).
    const withoutSource = runReverseVerifyByBreaking(cwd, ['test/value.test.js'], [], baseRef);
    expect(withoutSource.files[0]?.head.status).toBe('pass');
    // ⓑ 바뀐 소스를 넘기면 base 테스트가 «현 소스»에서 깨진다 — 그것이 이 대조의 값이다.
    const withSource = runReverseVerifyByBreaking(cwd, ['test/value.test.js'], ['src.js'], baseRef);
    expect(withSource.files[0]?.head.status).toBe('test-fail');
    expect(withSource.files[0]?.head.output).toContain('Expected: true');
  });


  test('역방향 절도 최종 note의 단일 줄과 전체 길이 상한 안에 든다', () => {
    const note = formatVerifyByBreakingNote({
      baseStatuses: { pass: 1, 'test-fail': 0, unknown: 0 },
      files: [{ file: 'test/forward\nname.test.js', classification: 'does-not-distinguish', base: { status: 'pass', output: '1 pass', log: 'base passed' } }],
    }, {
      ran: true,
      headStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
      files: [{ file: `test/${'reverse-path/'.repeat(80)}\nname.test.js`, head: { status: 'test-fail', output: `error: reverse failure\n${'x'.repeat(8_000)}`, log: 'head failed' } }],
    });
    expect(note.split('\n')).toHaveLength(1);
    expect(note.length).toBeLessThanOrEqual(6_000);
    expect(note).toContain('Reverse verify-by-breaking: ran=true');
    expect(note).toContain('reverse failure');
    expect(note).toContain(' ⏎ ');
  });

  // ⛔⭐⭐ **rename 구멍**(리뷰 R5 must-fix) — `git diff --name-only` 는 rename 을 «새 경로 하나»로
  //   내므로, 경로 목록만 복사하면 ***옛 경로가 base 워크트리에 남아*** 판정이 「옛 테스트 × 혼합 소스」가
  //   된다. base 판 테스트가 «옛 파일의 존재»를 단정하게 만들어 그 차이를 관측 가능하게 잰다.
  test('⭐ rename 의 «옛 경로»가 base 워크트리에서 지워진다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/old.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    // base 판 테스트는 «옛 경로가 있다»를 단정한다 — 지워지면 실패한다.
    writeFileSync(join(cwd, 'test/value.test.js'), "import { existsSync } from 'node:fs'; import { expect, test } from 'bun:test'; test('old path exists', () => expect(existsSync(new URL('../src/old.js', import.meta.url))).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base has src/old.js');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // 작업 트리에서 rename 한다(git 은 새 경로만 낸다).
    git(cwd, 'mv', 'src/old.js', 'src/new.js');
    writeFileSync(join(cwd, 'test/value.test.js'), "import { test } from 'bun:test'; test('edited', () => {});\n");

    const reverse = runReverseVerifyByBreaking(cwd, ['test/value.test.js'], ['src/new.js'], baseRef);

    // ⭐ 핵심 — 옛 경로가 지워졌으므로 base 판 테스트가 «현 소스»에서 깨진다.
    expect(reverse.ran).toBe(true);
    expect(reverse.files[0]?.head.status).toBe('test-fail');
  });

  // ⛔⭐⭐⭐ **symlink 소스는 «거부»한다**(리뷰 R6 → R7 정정) — R6 에서 형식을 «재현»했다가
  //   R7 이 그것이 격리를 깬다고 잡았다(링크 대상이 절대 경로/저장소 밖이면 격리 안의 실행이
  //   원 작업 트리를 읽고 쓴다). ⇒ 조용히 틀린 판을 내지 않고 «못 쟀다»로 낸다.
  test('⭐ 바뀐 소스가 symlink 면 재현하지 않고 사유를 남긴다 (격리를 깨지 않는다)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/real.js'), 'export const value = true;\n');
    writeFileSync(join(cwd, 'src/link.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/value.test.js'), "import { test } from 'bun:test'; test('base', () => {});\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base has a regular link.js');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    rmSync(join(cwd, 'src/link.js'), { force: true });
    symlinkSync('/etc/hosts', join(cwd, 'src/link.js'));   // ⛔ 저장소 «밖»을 가리킨다
    writeFileSync(join(cwd, 'test/value.test.js'), "import { test } from 'bun:test'; test('edited', () => {});\n");

    const reverse = runReverseVerifyByBreaking(cwd, ['test/value.test.js'], ['src/link.js'], baseRef);

    // ⭐ 핵심 — 판정을 «내지 않는다». 그리고 왜 못 냈는지가 사유로 남는다.
    expect(reverse.ran).toBe(false);
    expect(reverse.files[0]?.head.status).toBe('unknown');
    expect(reverse.files[0]?.head.output).toContain('symlink source is not staged');
    // ⊕ 작업 트리는 그대로다(링크도 그대로).
    expect(lstatSync(join(cwd, 'src/link.js')).isSymbolicLink()).toBe(true);
  });

  // ⛔⭐⭐⭐ **교차 테스트 오염 ⊕ 실행 순서 의존**(리뷰 R9 must-fix) — base 판 테스트는 임의 코드라
  //   «다른 테스트»를 변조할 수 있고, 종전엔 모두가 «한» 워크트리를 순차로 써서 앞 테스트가 뒤
  //   판정을 오염시켰다. 첫 테스트가 둘째 테스트를 «항상 통과하게» 덮어쓰게 만들어 그것을 잰다.
  test('⭐ 앞 base 테스트가 뒤 테스트를 덮어써도 뒤 판정이 오염되지 않는다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    // a: 자기 자리에서 «b 를 항상 통과하는 것으로» 덮어쓴다.
    writeFileSync(join(cwd, 'test/a.test.js'), "import { writeFileSync } from 'node:fs'; import { test } from 'bun:test'; test('a sabotages b', () => writeFileSync(new URL('./b.test.js', import.meta.url), \"import { test } from 'bun:test'; test('always green', () => {});\\n\"));\n");
    // b: 옛 계약을 단정한다 — 현 소스에서는 «깨져야» 한다.
    writeFileSync(join(cwd, 'test/b.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('base contract', () => expect(value).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base: a sabotages b');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // 자식이 테스트 둘을 고치고 소스를 깼다(혼합 변경).
    writeFileSync(join(cwd, 'test/a.test.js'), "import { test } from 'bun:test'; test('a edited', () => {});\n");
    writeFileSync(join(cwd, 'test/b.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('new contract', () => expect(value).toBe(false));\n");
    writeFileSync(join(cwd, 'src.js'), 'export const value = false;\n');

    const reverse = runReverseVerifyByBreaking(cwd, ['test/a.test.js', 'test/b.test.js'], ['src.js'], baseRef);

    // ⭐ 핵심 — b 는 «자기 base 판»으로 돌아 깨진다. a 의 사보타주가 b 판정을 못 바꾼다.
    const b = reverse.files.find((entry) => entry.file === 'test/b.test.js');
    expect(b?.head.status).toBe('test-fail');
    expect(b?.head.output).toContain('Expected: true');
    // ⊕ 작업 트리는 그대로다.
    expect(readFileSync(join(cwd, 'test/b.test.js'), 'utf8')).toContain('new contract');
  });

  // ⛔⭐⭐ **삭제 오염 ⊕ 실행 순서 의존**(리뷰 R11 must-fix) — 종전엔 존재 검사를 «리셋 앞»에서
  //   해서 ***앞 테스트가 뒤 테스트를 지우면 「base test unavailable」로 끝났다.*** 리셋이 base 를
  //   되살리므로 존재는 그 «뒤»에 물어야 참이다.
  test('⭐ 앞 base 테스트가 뒤 테스트를 «지워도» 뒤 테스트가 돈다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/a.test.js'), "import { rmSync } from 'node:fs'; import { test } from 'bun:test'; test('a deletes b', () => rmSync(new URL('./b.test.js', import.meta.url)));\n");
    writeFileSync(join(cwd, 'test/b.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('base contract', () => expect(value).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base: a deletes b');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'test/a.test.js'), "import { test } from 'bun:test'; test('a edited', () => {});\n");
    writeFileSync(join(cwd, 'test/b.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('new contract', () => expect(value).toBe(false));\n");
    writeFileSync(join(cwd, 'src.js'), 'export const value = false;\n');

    const reverse = runReverseVerifyByBreaking(cwd, ['test/a.test.js', 'test/b.test.js'], ['src.js'], baseRef);

    // ⭐ 핵심 — b 가 «돌아서» 깨진다. 「base test unavailable」이 아니다.
    const b = reverse.files.find((entry) => entry.file === 'test/b.test.js');
    expect(b?.head.status).toBe('test-fail');
    expect(b?.head.output ?? '').not.toContain('base test unavailable');
  });

  // ⛔⭐⭐ **픽스처·스냅샷은 「테스트 자산」이다**(리뷰 R9 must-fix · 정의) — 그것을 «현재 판»으로
  //   얹으면 재는 것이 「옛 테스트 × 현 소스」가 아니라 「옛 테스트 × «현» 테스트 자산 × 현 소스」가
  //   되고, ***이 대조가 겨냥한 픽스처 수리에서 판정이 무의미해진다.***
  test('⭐ 픽스처는 얹지 않는다 — 옛 테스트가 «옛» 픽스처로 돈다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test/fixtures'), { recursive: true });
    writeFileSync(join(cwd, 'test/fixtures/data.json'), '{"expected":1}\n');
    writeFileSync(join(cwd, 'test/value.test.js'), "import { readFileSync } from 'node:fs'; import { expect, test } from 'bun:test'; test('fixture contract', () => expect(JSON.parse(readFileSync(new URL('./fixtures/data.json', import.meta.url), 'utf8')).expected).toBe(1));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base fixture expects 1');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // 픽스처 수리 — 값과 테스트를 함께 2 로 고쳤다.
    writeFileSync(join(cwd, 'test/fixtures/data.json'), '{"expected":2}\n');
    writeFileSync(join(cwd, 'test/value.test.js'), "import { readFileSync } from 'node:fs'; import { expect, test } from 'bun:test'; test('fixture contract', () => expect(JSON.parse(readFileSync(new URL('./fixtures/data.json', import.meta.url), 'utf8')).expected).toBe(2));\n");

    // ⛔ 픽스처를 「소스」라 부르고 넘겨도 얹지 않는다 — 술어가 그것을 테스트 자산으로 판정한다.
    const reverse = runReverseVerifyByBreaking(cwd, ['test/value.test.js'], ['test/fixtures/data.json'], baseRef);

    // ⭐ 옛 테스트가 «옛» 픽스처로 돌았으므로 통과한다(현 픽스처가 얹혔으면 깨졌을 것이다).
    expect(reverse.ran).toBe(true);
    expect(reverse.files[0]?.head.status).toBe('pass');
  });

  // ⛔⭐⭐ **테스트 파일 rename**(리뷰 R7 must-fix) — 새 경로는 base 에 없다. 종전엔 그래서
  //   `base test unavailable` 로 끝나 ***핵심 대조가 누락***됐다. rename 은 「같은 테스트의 이동」이므로
  //   base 판은 «옛 경로»에 있고, 그것을 돌려야 「옛 테스트 × 현 소스」가 성립한다.
  test('⭐ 테스트 파일이 rename 되면 base 의 «옛 경로»를 돌린다', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'src.js'), 'export const value = true;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/old-name.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('base contract', () => expect(value).toBe(true));\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // 테스트를 rename 하고 내용도 고친다 ⊕ 소스를 깬다(혼합 변경).
    git(cwd, 'mv', 'test/old-name.test.js', 'test/new-name.test.js');
    writeFileSync(join(cwd, 'test/new-name.test.js'), "import { expect, test } from 'bun:test'; import { value } from '../src.js'; test('new contract', () => expect(value).toBe(false));\n");
    writeFileSync(join(cwd, 'src.js'), 'export const value = false;\n');

    const reverse = runReverseVerifyByBreaking(cwd, ['test/new-name.test.js'], ['src.js'], baseRef);

    // ⭐ 핵심 — 「base test unavailable」이 아니라 «실제로 돌아» 옛 계약이 깨진 것을 낸다.
    expect(reverse.ran).toBe(true);
    expect(reverse.files[0]?.head.status).toBe('test-fail');
    expect(reverse.files[0]?.head.output).toContain('Expected: true');
  });

  // ⛔⭐ **`ran` 은 「돌렸나」다**(리뷰 R5 should-fix) — base 판에 그 테스트가 «없으면» 하나도 못 돌린다.
  test('⭐ base 에 그 테스트가 없으면 ran=false 다 (「대조했다」고 말하지 않는다)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/kept.test.js'), "import { test } from 'bun:test'; test('kept', () => {});\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base without the new test');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');
    // 자식이 «새» 테스트를 만들었다 — base 에는 없다.
    writeFileSync(join(cwd, 'test/brand-new.test.js'), "import { test } from 'bun:test'; test('new', () => {});\n");

    const reverse = runReverseVerifyByBreaking(cwd, ['test/brand-new.test.js'], [], baseRef);

    expect(reverse.ran).toBe(false);
    expect(reverse.files[0]?.head.status).toBe('unknown');
    expect(reverse.files[0]?.head.output).toContain('base test unavailable');
  });

  test('distinguishes만 있어도 seam 역방향 대조를 실행한다', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/a.test.js'), "import { test } from 'bun:test'; test('a', () => {});\n");
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'base');
    writeFileSync(join(cwd, 'test/a.test.js'), "import { test } from 'bun:test'; test('a changed', () => {});\n");
    let reverseCalls = 0;
    const gate = await defaultSeams({
      runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '1 pass' }], log: '[test] PASS' }),
      runVerifyByBreaking: () => ({
        baseStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
        files: [{ file: 'test/a.test.js', classification: 'distinguishes', base: { status: 'test-fail', output: '1 fail', log: 'base failed' } }],
      }),
      runReverseVerifyByBreaking: (_cwd, files) => {
        reverseCalls += 1;
        expect(files).toEqual(['test/a.test.js']);
        return { ran: true, files: [], headStatuses: { pass: 0, 'test-fail': 0, unknown: 0 } };
      },
    }).gate(cwd);
    expect(reverseCalls).toBe(1);
    expect(gate.log).toContain('Reverse verify-by-breaking: ran=true;');
  });

  test('gate 관측은 base 파일 부재와 단언 실패를 분리하고 reverse 실행 상태를 이름으로 남긴다', async () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/assertion.test.js'), "import { test } from 'bun:test'; test('base', () => {});\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base test');
    writeFileSync(join(cwd, 'test/assertion.test.js'), "import { test } from 'bun:test'; test('changed', () => {});\n");
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'verify-by-breaking-missing-at-base-and-reverse-status',
      emit: (record) => { records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }); },
    });
    try {
      await defaultSeams({
        runIntegrityGate: () => ({ passed: true, steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass', output: '2 pass' }], log: '[test] PASS' }),
        runVerifyByBreaking: () => ({
          baseStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
          files: [
            { file: 'test/new.test.js', classification: 'missing-at-base', base: { status: 'test-fail', log: 'base cannot run new file' } },
            { file: 'test/assertion.test.js', classification: 'distinguishes', base: { status: 'test-fail', log: 'base assertion failed' } },
          ],
        }),
      }).gate(cwd);
      const observation = records.find((record) => record.category === 'self-implement' && record.event === 'gate.verify-by-breaking');
      expect(observation?.data?.distinguishes).toBe(1);
      expect(observation?.data?.missingAtBase).toBe(1);
      expect(observation?.data?.baseStatuses).toEqual({ pass: 0, 'test-fail': 1, unknown: 0 });
      expect(observation?.data?.reverse).toEqual(expect.objectContaining({
        status: 'ran',
        headStatuses: { pass: 1, 'test-fail': 0, unknown: 1 },
        files: expect.arrayContaining([
          { file: 'test/new.test.js', head: 'unknown' },
          { file: 'test/assertion.test.js', head: 'pass' },
        ]),
      }));
    } finally {
      off();
    }
  });

  test('base 출력이 줄바꿈 때문에 변환되어도 원문 문자 수와 잘림 사실을 정확히 남긴다', () => {
    const output = `${'x\n'.repeat(600)}x`;
    const note = formatVerifyByBreakingNote({
      baseStatuses: { pass: 0, 'test-fail': 1, unknown: 0 },
      files: [{ file: 'test/long.test.ts', classification: 'distinguishes', base: { status: 'test-fail', output, log: 'failed' } }],
    });
    const expected = `Verify-by-breaking: distinguishes=1, does-not-distinguish=0, unknown=0, missing-at-base=0; files=[test/long.test.ts=distinguishes]; test/long.test.ts=distinguishes; base=test-fail; output=${'x ⏎ '.repeat(300)} [truncated; originalChars=1201]`;
    expect(note).toBe(expected);
  });
});

describe('detached baseline worktree dependency access', () => {
  test('node_modules를 연결해 외부 패키지를 import하는 실패 테스트만 base에서 재실행한다', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'test'), { recursive: true });
    mkdirSync(join(cwd, 'node_modules/tiny-gate-dep'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'node_modules/tiny-gate-dep/package.json'), '{"name":"tiny-gate-dep","type":"module","exports":"./index.js"}\n');
    writeFileSync(join(cwd, 'node_modules/tiny-gate-dep/index.js'), 'export const value = 7;\n');
    writeFileSync(join(cwd, 'test/external.test.js'), [
      "import { expect, test } from 'bun:test';",
      "import { value } from 'tiny-gate-dep';",
      "test('base red through dependency', () => expect(value).toBe(8));",
      '',
    ].join('\n'));
    git(cwd, 'add', 'package.json', 'test/external.test.js');
    git(cwd, 'commit', '-m', 'base failing integration test');
    const baseRef = git(cwd, 'rev-parse', 'HEAD');

    const baseline = runGateBaseline(cwd, ['test/external.test.js'], baseRef);
    expect(baseline.status).toBe('test-fail');
    expect(baseline.output).toContain('base red through dependency');
    expect(baseline.output).not.toContain('Cannot find package');
  });
});

describe('review intent baseline visibility', () => {
  test('preexisting 실패를 PR 책임 제외 문구와 함께 리뷰어에게 전달한다', () => {
    const intent = buildReviewIntent({
      goal: '기능 구현',
      preexistingTestFailures: ['test/a.test.ts > base red'],
    });
    expect(intent).toContain('이 실패들은 base에서도 실패한다 — 이 PR의 책임이 아니다');
    expect(intent).toContain('test/a.test.ts > base red');
  });
});

// ⭐⭐ 리뷰 must-fix(#5938) — 넷 다 "면책이 새는" 형태였다.
describe('gate baseline — 면책이 새지 않는다', () => {
  const noBaseline = { status: 'unknown' as const, log: 'n/a' };

  test('⛔ 실패를 하나도 못 읽으면 통과시키지 않는다 (fail-closed)', () => {
    // `0 files ran`·로더 오류처럼 무엇이 실패했는지 못 읽는 로그.
    const report = buildGateBaselineReport('error: Cannot find module "x"\n', noBaseline);
    expect(report.worktreeFailuresParsed).toBe(false);
    expect(report.introduced).toBe(0);              // 종전엔 이것만 보고 통과시켰다
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('실패를 읽었고 전부 preexisting 이면 통과시킨다', () => {
    const wt = 'test/a.test.ts:\n(fail) base red\n';
    const report = buildGateBaselineReport(wt, { status: 'test-fail', log: 'x', output: wt });
    expect(report.worktreeFailuresParsed).toBe(true);
    expect(report.preexisting).toBe(1);
    expect(allowsBaselineOnlyFailure(report)).toBe(true);
  });

  test('⛔ 같은 이름의 실패가 base 1건인데 자식이 하나 더 만들면 하나는 introduced 다', () => {
    const base = 'test/a.test.ts:\n(fail) dup\n';
    const wt = 'test/a.test.ts:\n(fail) dup\n(fail) dup\n';
    const report = buildGateBaselineReport(wt, { status: 'test-fail', log: 'x', output: base });
    expect(report.preexisting).toBe(1);
    expect(report.introduced).toBe(1);              // 종전 Set 비교는 둘 다 preexisting 이었다
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('⛔ src/test/tests 밖 경로도 실패 파일로 인식한다', () => {
    const wt = 'packages/x/thing.test.ts:\n(fail) outside root\n';
    const parsed = extractGateTestFailures(wt);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.file).toBe('packages/x/thing.test.ts');
  });
});

// ⭐ 리뷰 must-fix(#5938 2차) — 둘 다 "면책이 새는" 형태의 연장이었다.
describe('gate baseline — 신규 파일과 일반 경로', () => {
  test('⛔ base 에 없는 테스트 파일의 실패는 introduced 다 (baseline 이 unknown 이어도)', () => {
    const wt = 'test/new.test.ts:\n(fail) brand new\n';
    const report = buildGateBaselineReport(wt, {
      status: 'unknown', log: 'base run inconclusive', missingAtBase: ['test/new.test.ts'],
    });
    expect(report.introduced).toBe(1);              // 종전엔 unknown 이라 게이트가 통과했다
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('scope(@) 가 든 경로도 실패 파일로 읽는다', () => {
    const parsed = extractGateTestFailures('packages/@scope/pkg/x.test.ts:\n(fail) scoped\n');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.file).toBe('packages/@scope/pkg/x.test.ts');
  });
});

// ⭐ 리뷰 must-fix(#5938 3차) — 둘 다 "정상을 비정상으로 읽어 면책/오분류" 였다.
describe('gate baseline — 정상 종료와 부재 판정', () => {
  test('⛔ 통과한 테스트 이름에 timeout 이 들어 있어도 pass 다', () => {
    const r = classifyBaselineProcess({
      status: 0,
      stdout: 'test/a.test.ts:\n(pass) request timeout is retried\n 1 pass 0 fail\n',
      stderr: '',
    });
    expect(r.status).toBe('pass');   // 종전엔 인프라 정규식이 먼저라 unknown 이었다
  });

  test('인프라 실패는 여전히 unknown 이다 (exit 0 이 아닐 때만 본다)', () => {
    const r = classifyBaselineProcess({ status: 1, stdout: '', stderr: 'error: Cannot find module "x"\n' });
    expect(r.status).toBe('unknown');
  });

  test('stdout 끝과 stderr loader 오류 사이에 줄 경계를 둔다', () => {
    const r = classifyBaselineProcess({
      status: 1,
      stdout: 'test/a.test.ts:\n(fail) ordinary failure',
      stderr: 'error: Cannot find package "left-pad"',
    });
    expect(r.status).toBe('unknown');
  });

  test('테스트 진단 블록의 들여쓰기 없는 error와 SyntaxError는 인프라 근거가 아니다', () => {
    const r = classifyBaselineProcess({
      status: 1,
      stdout: [
        'test/a.test.ts:',
        '(fail) timeout diagnostic remains a test failure',
        'error: Cannot find package "fixture-only-message"',
        'SyntaxError: timeout in assertion message',
        '1 fail',
      ].join('\n'),
    });
    expect(r.status).toBe('test-fail');
  });

  test('들여쓴 오류형 줄은 실제 러너/로더 줄 머리가 아니므로 인프라 근거가 아니다', () => {
    const r = classifyBaselineProcess({
      status: 1,
      stdout: 'test/a.test.ts:\n(fail) ordinary failure\n1 fail\n  error: Cannot find package "indented-message"',
    });
    expect(r.status).toBe('test-fail');
  });
});

// ⭐⭐ 리뷰 must-fix(#5938 4차) — 구멍은 정규식이 아니라 **판정 원칙**이었다.
// baseline 이 못 돌면(unknown) worktree 실패 전부가 unknown 으로 귀속되고 introduced===0 이라
// **게이트가 통과**했다 ⇒ baseline 판정이 깨지는 모든 경로가 자식 회귀를 면책했다.
describe('gate baseline — baseline 이 못 돌면 아무것도 면책하지 않는다', () => {
  test('⛔ worktree 실패를 읽었어도 baseline 이 unknown 이면 통과시키지 않는다', () => {
    const wt = 'test/a.test.ts:\n(fail) child regression\n';
    const report = buildGateBaselineReport(wt, { status: 'unknown', log: 'baseline inconclusive' });
    expect(report.worktreeFailuresParsed).toBe(true);
    expect(report.introduced).toBe(0);              // 전부 unknown 으로 귀속된다
    expect(allowsBaselineOnlyFailure(report)).toBe(false);   // 그래도 통과시키지 않는다
  });

  test('baseline 이 실제로 돌았고 전부 preexisting 일 때만 통과시킨다', () => {
    const wt = 'test/a.test.ts:\n(fail) base red\n';
    const report = buildGateBaselineReport(wt, { status: 'test-fail', log: 'ran', output: wt });
    expect(allowsBaselineOnlyFailure(report)).toBe(true);
  });
});

describe('gate baseline — introduced 재실행 강등', () => {
  const file = 'test/check-layout.test.ts';
  const name = 'layout holds';
  const head = `${file}:\n(fail) ${name} [1.00ms]\nerror: Expected layout to hold\n`;
  const basePass = `${file}:\n(pass) ${name} [1.00ms]\n 1 pass\n 0 fail\n`;
  const baseFail = `${file}:\n(fail) ${name} [1.00ms]\nerror: Expected layout to hold\n`;
  const key = `${file} > ${name}`;

  test('기준선 통과 · 변경 후 실패 · 재실행 pass 면 flaky-rerun 이고 introduced 는 0 이다', () => {
    const report = buildGateBaselineReport(head, { status: 'pass', log: 'ran', output: basePass }, new Map([[key, ['pass']]]));
    expect(report.failures.map((failure) => failure.attribution)).toEqual(['flaky-rerun']);
    expect(report.introduced).toBe(0);
    expect(report.flakyRerun).toBe(1);
    expect(report.timedOut).toBe(0);
    const note = formatGateBaselineNote(report, 0);
    expect(note).toContain('flaky-rerun=1');
    expect(note).toContain('introduced=0');
    expect(note).not.toContain('timed-out=');
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('같은 실패의 재실행 관측이 failure 면 introduced 를 유지한다', () => {
    const report = buildGateBaselineReport(head, { status: 'pass', log: 'ran', output: basePass }, new Map([[key, ['failure']]]));
    expect(report.failures.map((failure) => failure.attribution)).toEqual(['introduced']);
    expect(report.introduced).toBe(1);
    expect(report.flakyRerun).toBe(0);
  });

  test('재실행 관측이 없으면 원래 introduced 귀속을 유지한다', () => {
    const report = buildGateBaselineReport(head, { status: 'pass', log: 'ran', output: basePass });
    expect(report.failures[0]?.attribution).toBe('introduced');
    expect(report.flakyRerun).toBe(0);
  });

  test('기존 실패 1 과 may-vary 타임아웃 1 이면 childResponsibility 는 none 이고 도입이 하나 더 있으면 없다', () => {
    const preexistingFile = 'test/old.test.ts';
    const timeoutFile = 'test/slow.test.ts';
    const timeoutName = 'may vary slow';
    const worktree = [
      `${preexistingFile}:`,
      '(fail) already red',
      'error: Expected true',
      `${timeoutFile}:`,
      `(fail) ${timeoutName}`,
      '^ this test timed out after 10000ms',
      '',
      '1 fail',
    ].join('\n');
    const baselineLog = [
      `${preexistingFile}:`,
      '(fail) already red',
      'error: Expected true',
      `${timeoutFile}:`,
      `(fail) ${timeoutName}`,
      '^ this test timed out after 10000ms',
    ].join('\n');
    const baseline = { status: 'test-fail' as const, log: 'base reproduced', output: baselineLog };
    const rerun = { [`${timeoutFile} > ${timeoutName}`]: ['pass' as const] };

    const exempt = buildGateBaselineReport(worktree, baseline, rerun);
    expect(exempt.preexisting).toBe(1);
    expect(exempt.timedOut).toBe(1);
    expect(exempt.introduced).toBe(0);
    expect(exempt.failures.map((failure) => failure.attribution).sort()).toEqual(['flaky-timeout', 'preexisting']);
    expect(exempt.failures.find((failure) => failure.attribution === 'flaky-timeout')?.timeoutVariability).toBe('may-vary');
    expect(exempt.childResponsibility).toBe('none');
    expect(canExemptChildForTimeoutFailures(exempt.failures)).toBe(true);
    expect(allowsBaselineOnlyFailure(exempt)).toBe(false);

    const withIntroduced = buildGateBaselineReport(
      `${worktree}\n${failLog('test/new.test.ts', 'child regression')}`,
      baseline,
      rerun,
    );
    expect(withIntroduced.introduced).toBe(1);
    expect(withIntroduced.childResponsibility).toBeUndefined();
    expect(canExemptChildForTimeoutFailures(withIntroduced.failures)).toBe(false);
  });

  test('기존 실패만 있으면 면책하지 않고 재실행 강등만 있으면 면책한다', () => {
    const preexistingOnly = buildGateBaselineReport(
      failLog('test/old.test.ts', 'already red'),
      { status: 'test-fail', log: 'base reproduced', output: failLog('test/old.test.ts', 'already red') },
    );
    expect(preexistingOnly.preexisting).toBe(1);
    expect(preexistingOnly.flakyRerun).toBe(0);
    expect(preexistingOnly.timedOut).toBe(0);
    expect(preexistingOnly.childResponsibility).toBeUndefined();
    expect(canExemptChildForTimeoutFailures(preexistingOnly.failures)).toBe(false);
    expect(allowsBaselineOnlyFailure(preexistingOnly)).toBe(true);

    const flaky = buildGateBaselineReport(head, { status: 'pass', log: 'ran', output: basePass }, new Map([[key, ['pass']]]));
    expect(flaky.flakyRerun).toBe(1);
    expect(flaky.childResponsibility).toBe('none');
    expect(canExemptChildForTimeoutFailures(flaky.failures)).toBe(true);
    expect(allowsBaselineOnlyFailure(flaky)).toBe(false);
  });

  test('기존 실패 1 과 흔들림 1 · introduced 0 이면 allowsBaselineOnlyFailure 는 false 다', () => {
    const preexisting = 'test/old.test.ts';
    const worktree = `${preexisting}:\n(fail) already red\n${file}:\n(fail) ${name}\n`;
    const baseline = `${preexisting}:\n(fail) already red\n${file}:\n(pass) ${name}\n`;
    const report = buildGateBaselineReport(
      worktree,
      { status: 'test-fail', log: 'ran', output: baseline },
      new Map([[key, ['pass']]]),
    );
    expect(report.preexisting).toBe(1);
    expect(report.flakyRerun).toBe(1);
    expect(report.introduced).toBe(0);
    expect(allowsBaselineOnlyFailure(report)).toBe(false);
  });

  test('기준선에서도 실패한 시험은 재실행 pass 여도 preexisting 이다', () => {
    const report = buildGateBaselineReport(head, { status: 'test-fail', log: 'ran', output: baseFail }, new Map([[key, ['pass']]]));
    expect(report.failures[0]?.attribution).toBe('preexisting');
    expect(report.flakyRerun).toBe(0);
  });

  test('타임아웃은 유지하고 introduced 만 상한까지 한 번씩 고르며 나머지는 not-run 이다', () => {
    const calls: string[] = [];
    const introduced = Array.from({ length: INTRODUCED_RERUN_CAP + 2 }, (_, index) => ({
      name: `test/b.test.ts > case ${index}`,
      file: 'test/b.test.ts',
      diagnostic: 'error: Expected true',
    }));
    const failures = [
      { name: 'test/a.test.ts > timed', file: 'test/a.test.ts', diagnostic: 'this test timed out after 5000ms' },
      ...introduced,
      { name: 'test/c.test.ts > already red', file: 'test/c.test.ts', diagnostic: 'error: Expected true' },
    ];
    const baselineLog = [
      'test/b.test.ts:',
      ...introduced.map((failure) => `(pass) ${failure.name.slice('test/b.test.ts > '.length)}`),
      'test/c.test.ts:',
      '(fail) already red',
      '',
    ].join('\n');
    const result = rerunBunTimeoutFailures('/tmp', failures, 1_000, baselineLog, [], (_cwd, filePath, testName) => {
      calls.push(`${filePath} > ${testName}`);
      return 'pass';
    });
    expect(calls[0]).toBe('test/a.test.ts > timed');
    expect(calls).toHaveLength(1 + INTRODUCED_RERUN_CAP);
    expect(result.rerunNotRun).toBe(2);
    expect(calls.includes('test/c.test.ts > already red')).toBe(false);
    expect(calls.includes(`test/b.test.ts > case ${INTRODUCED_RERUN_CAP}`)).toBe(false);
    expect(calls.includes('test/b.test.ts > case 0')).toBe(true);
    expect(result.observations.size).toBe(1 + INTRODUCED_RERUN_CAP);
  });

  test('상한 때문에 안 돌린 수는 보고 문면에 not-run 으로 남는다', () => {
    const report = buildGateBaselineReport(head, { status: 'pass', log: 'ran', output: basePass }, undefined, 3);
    expect(report.rerunNotRun).toBe(3);
    expect(formatGateBaselineNote(report, 0)).toContain('not-run=3');
    expect(formatGateBaselineNote(report, 0)).toContain('introduced=1');
  });
});

test('a rerun whose test traps SIGTERM still returns at the timeout instead of waiting for the test to finish', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-sigterm-trap-'));
  try {
    writeFileSync(join(dir, 'trap.test.ts'), [
      "import { test } from 'bun:test';",
      "process.on('SIGTERM', () => {});",
      "test('ignores SIGTERM', async () => { await new Promise((resolve) => setTimeout(resolve, 30_000)); }, 60_000);",
      '',
    ].join('\n'));
    const started = Date.now();
    const observation = rerunBunSingleTest(dir, 'trap.test.ts', 'ignores SIGTERM', 1_500);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(observation).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
