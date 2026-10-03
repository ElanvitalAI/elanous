// self-dev 실행-맥락 맹점 보강(2026-07-25) — cli-smoke 게이트 스텝. test/tsc 가 못 잡는 로드타임
// 크래시(커맨드 중복 등록·import 순환·부팅 throw)를 CLI 기동(--help)으로 결정론 차단한다.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  runIntegrityGate,
  renderGateEvidence,
  DEFAULT_GATE_STEPS,
  type RunCmd,
} from './integrity-gate.js';

describe('cli-smoke 게이트 스텝', () => {
  let presentCwd = '';
  let absentCwd = '';

  beforeAll(() => {
    presentCwd = mkdtempSync(join(tmpdir(), 'cli-smoke-present-'));
    mkdirSync(join(presentCwd, 'bin'));
    writeFileSync(join(presentCwd, 'bin', 'elanous.mjs'), 'export {};\n');
    absentCwd = mkdtempSync(join(tmpdir(), 'cli-smoke-absent-'));
  });

  afterAll(() => {
    rmSync(presentCwd, { recursive: true, force: true });
    rmSync(absentCwd, { recursive: true, force: true });
  });

  test('DEFAULT_GATE_STEPS 에 cli-smoke 포함 — 모든 코드 골이 로드 무결성 검증', () => {
    expect(DEFAULT_GATE_STEPS).toContain('cli-smoke');
    expect(DEFAULT_GATE_STEPS).toContain('test');
  });

  test('exit 0 → pass · 정확히 `bun bin/elanous.mjs --help` 를 호출한다', async () => {
    const calls: Array<[string, string[]]> = [];
    const runCmd: RunCmd = async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: 'Usage: elanous …', stderr: '', timedOut: false }; };
    const r = await runIntegrityGate(presentCwd, { steps: ['cli-smoke'], runCmd });
    expect(r.passed).toBe(true);
    expect(r.steps[0]?.name).toBe('cli-smoke');
    expect(r.steps[0]?.ok).toBe(true);
    expect(r.steps[0]?.skipped).toBe(false);
    expect(calls).toEqual([['bun', ['bin/elanous.mjs', '--help']]]); // 실제 CLI 기동 인자 단언(mock 과장 방지·review)
  });

  test('로드 크래시(커맨드 중복 등 non-0) → fail — 정적 게이트가 못 잡던 결함 차단', async () => {
    const runCmd: RunCmd = async (_cmd, args) => (args.includes('--help')
      ? { code: 1, stdout: '', stderr: "cannot add command 'agent' as already have command 'agent|codex'", timedOut: false }
      : { code: 0, stdout: '1 pass', stderr: '', timedOut: false });
    const r = await runIntegrityGate(presentCwd, { steps: ['cli-smoke'], runCmd });
    expect(r.passed).toBe(false);
    expect(r.steps[0]?.ok).toBe(false);
    expect(r.steps[0]?.skipped).toBe(false);
    expect(r.steps[0]?.summary).toContain('fail');
  });

  test('test 는 통과해도 cli-smoke 로드 크래시면 전체 gate fail(로드 결함이 test 를 통과해도 차단)', async () => {
    const runCmd: RunCmd = async (_cmd, args) => (args.includes('--help')
      ? { code: 1, stdout: '', stderr: 'boot throw', timedOut: false }
      : { code: 0, stdout: 'Ran 5 across 1', stderr: '5 pass 0 fail', timedOut: false });
    const r = await runIntegrityGate(presentCwd, { steps: ['test', 'cli-smoke'], runCmd });
    expect(r.passed).toBe(false); // test pass 여도 cli-smoke fail → 전체 fail
  });

  test('명시 steps(nocturnal 경로)는 cli-smoke 를 타지 않는다 — DEFAULT 변경 무회귀', async () => {
    // nocturnal-deps 는 runIntegrityGate(wt, { steps: ['test'] }) 로 명시 호출(DEFAULT 미사용).
    // DEFAULT 에 cli-smoke 를 넣어도 명시 steps 경로는 정확히 지정 스텝만 돈다는 회귀 보증.
    const seen: string[] = [];
    const runCmd: RunCmd = async (_cmd, args) => { seen.push(args[0] ?? ''); return { code: 0, stdout: 'Ran 1 across 1', stderr: '1 pass', timedOut: false }; };
    const r = await runIntegrityGate('/wt', { steps: ['test'], runCmd });
    expect(r.steps.map((s) => s.name)).toEqual(['test']); // cli-smoke 미포함
    expect(seen).toEqual(['test']); // --help 를 기동하지 않음
  });

  test('필터 test PASS 로그는 같은 판정 줄에 실행 명령, 모든 필터, 실행 요약을 보존한다', async () => {
    const runCmd: RunCmd = async () => ({
      code: 0, stdout: '95 pass\n0 fail\nRan 95 tests across 2 files. [3.21s]', stderr: '', timedOut: false,
    });
    const r = await runIntegrityGate('/wt', {
      steps: ['test'], testArgs: ['a/b.test.ts', 'c/d.test.ts'], runCmd,
    });
    expect(r.log).toContain('bun test a/b.test.ts c/d.test.ts');
    expect(r.log).toMatch(/\[test\] PASS .*Ran 95 tests across 2 files/);
    expect(r.steps[0]).toMatchObject({ name: 'test', ok: true, skipped: false });
    expect(r.steps[0]?.summary).toStartWith('pass (');
    expect(r.passed).toBe(true);
  });

  test('필터 test FAIL 로그도 같은 판정 줄에 실행 명령과 실행 요약을 보존한다', async () => {
    const runCmd: RunCmd = async () => ({
      code: 1, stdout: '4 pass\n1 fail\nRan 5 tests across 2 files. [1.21s]', stderr: '', timedOut: false,
    });
    const r = await runIntegrityGate('/wt', {
      steps: ['test'], testArgs: ['a/b.test.ts', 'c/d.test.ts'], runCmd,
    });
    expect(r.log).toContain('bun test a/b.test.ts c/d.test.ts');
    expect(r.log).toMatch(/\[test\] FAIL .*1 fail.*Ran 5 tests across 2 files/);
    expect(r.steps[0]).toMatchObject({ name: 'test', ok: false, skipped: false });
    expect(r.passed).toBe(false);
  });

  test('필터 없는 스텝은 기존 tail과 판정을 보존하면서 명령만 추가한다', async () => {
    const runCmd: RunCmd = async () => ({
      code: 0, stdout: 'first\nsecond\nthird\nfourth', stderr: '', timedOut: false,
    });
    const r = await runIntegrityGate(presentCwd, { steps: ['cli-smoke'], runCmd });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ name: 'cli-smoke', ok: true, skipped: false });
    expect(r.steps[0]?.summary).toStartWith('pass (');
    expect(r.passed).toBe(true);
    expect(r.log).toBe('[cli-smoke] PASS bun bin/elanous.mjs --help — second | third | fourth');
  });

  test('긴 test 필터 로그는 생략 수를 명시한다', async () => {
    const testArgs = Array.from({ length: 10 }, (_, index) => `test/${index}.test.ts`);
    const runCmd: RunCmd = async () => ({
      code: 0, stdout: '10 pass\nRan 10 tests across 10 files.', stderr: '', timedOut: false,
    });
    const r = await runIntegrityGate('/wt', { steps: ['test'], testArgs, runCmd });
    expect(r.log).toContain('test/5.test.ts');
    expect(r.log).toContain('…(+4 more)');
  });

  test('깨뜨린 명령 로그 표현은 필터 증거 단정을 실패시킨다', async () => {
    const runCmd: RunCmd = async () => ({
      code: 0, stdout: '2 pass\nRan 2 tests across 2 files.', stderr: '', timedOut: false,
    });
    const r = await runIntegrityGate('/wt', {
      steps: ['test'], testArgs: ['a/b.test.ts', 'c/d.test.ts'], runCmd,
    });
    const brokenLog = r.log.replace('bun test a/b.test.ts c/d.test.ts — ', '');
    expect(brokenLog).not.toContain('a/b.test.ts');
    expect(brokenLog).not.toContain('c/d.test.ts');
  });

  test('bin/elanous.mjs 가 없는 cwd 에서 cli-smoke 는 실패가 아니라 건너뜀이고 이유가 비어 있지 않다', async () => {
    const calls: Array<[string, string[]]> = [];
    const runCmd: RunCmd = async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 1, stdout: '', stderr: 'Module not found "bin/elanous.mjs"', timedOut: false };
    };
    const r = await runIntegrityGate(absentCwd, { steps: ['cli-smoke'], runCmd });
    expect(r.steps[0]).toMatchObject({ name: 'cli-smoke', skipped: true, ok: true });
    expect(r.steps[0]?.summary).toContain('skipped');
    expect(r.steps[0]?.summary.replace('skipped', '').trim().length).toBeGreaterThan(0);
    expect(r.log).toContain('[cli-smoke] SKIP');
    expect(r.log).not.toContain('[cli-smoke] PASS');
    expect(r.log).not.toContain('[cli-smoke] FAIL');
    expect(calls).toEqual([]);
  });

  test('bin/elanous.mjs 가 있는 cwd 에서 cli-smoke 는 종전대로 실행되고 통과 또는 실패로 기록된다', async () => {
    const passCmd: RunCmd = async () => ({ code: 0, stdout: 'Usage: elanous …', stderr: '', timedOut: false });
    const pass = await runIntegrityGate(presentCwd, { steps: ['cli-smoke'], runCmd: passCmd });
    expect(pass.steps[0]).toMatchObject({ name: 'cli-smoke', skipped: false, ok: true });
    expect(pass.passed).toBe(true);

    const failCmd: RunCmd = async () => ({ code: 1, stdout: '', stderr: 'boot throw', timedOut: false });
    const fail = await runIntegrityGate(presentCwd, { steps: ['cli-smoke'], runCmd: failCmd });
    expect(fail.steps[0]).toMatchObject({ name: 'cli-smoke', skipped: false, ok: false });
    expect(fail.passed).toBe(false);
    expect(fail.steps[0]?.summary).toContain('fail');
  });

  test('cli-smoke 만 건너뛴 게이트 결과에서 통과한 스텝 수는 그 스텝을 포함하지 않는다', async () => {
    const runCmd: RunCmd = async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false });
    const r = await runIntegrityGate(absentCwd, { steps: ['cli-smoke'], runCmd });
    expect(r.steps.filter((step) => step.skipped)).toHaveLength(1);
    expect(r.steps[0]?.status).toBe('skipped');
    expect(r.passedStepCount).toBe(0);
    const evidence = renderGateEvidence(r);
    expect(evidence).toContain('0 passed steps');
    expect(evidence).toContain('⚠️ 1 skipped step — not counted as passed');
    expect(evidence).toContain('⚠️ SKIP cli-smoke');
    expect(evidence).not.toMatch(/✅ cli-smoke/);
  });

  test('status 없는 기존 GateStep도 렌더러가 passed와 skipped를 운영 집계로 구분한다', () => {
    const skipOnly = renderGateEvidence({
      passed: true,
      log: '',
      steps: [{ name: 'cli-smoke', ok: true, skipped: true, summary: 'skipped: entrypoint absent' }],
    });
    expect(skipOnly).toContain('0 passed steps');
    expect(skipOnly).toContain('⚠️ 1 skipped step — not counted as passed');
    expect(skipOnly).toContain('⚠️ SKIP cli-smoke');

    const passOnly = renderGateEvidence({
      passed: true,
      log: '',
      steps: [{ name: 'test', ok: true, skipped: false, summary: 'pass' }],
    });
    expect(passOnly).toContain('1 passed step');
    expect(passOnly).not.toContain('skipped step');
    expect(passOnly).toContain('✅ test');

    const passAndSkip = renderGateEvidence({
      passed: true,
      log: '',
      steps: [
        { name: 'test', ok: true, skipped: false, summary: 'pass' },
        { name: 'cli-smoke', ok: true, skipped: true, summary: 'skipped: entrypoint absent' },
      ],
    });
    expect(passAndSkip).toContain('1 passed step');
    expect(passAndSkip).toContain('⚠️ 1 skipped step — not counted as passed');
    expect(passAndSkip).toContain('✅ test');
    expect(passAndSkip).toContain('⚠️ SKIP cli-smoke');
  });

  test('다른 스텝이 전부 통과하고 cli-smoke 만 건너뛰면 게이트 passed 는 참이다', async () => {
    const runCmd: RunCmd = async () => ({
      code: 0, stdout: '1 pass\n0 fail\nRan 1 test across 1 file.', stderr: '', timedOut: false,
    });
    const r = await runIntegrityGate(absentCwd, { steps: ['test', 'cli-smoke'], runCmd });
    expect(r.passed).toBe(true);
    expect(r.steps.find((step) => step.name === 'test')).toMatchObject({ ok: true, skipped: false });
    expect(r.steps.find((step) => step.name === 'cli-smoke')).toMatchObject({ status: 'skipped', skipped: true, ok: true });
    expect(r.passedStepCount).toBe(1);
    const evidence = renderGateEvidence(r);
    expect(evidence).toContain('1 passed step');
    expect(evidence).toContain('⚠️ 1 skipped step — not counted as passed');
    expect(evidence).toContain('✅ test');
    expect(evidence).toContain('⚠️ SKIP cli-smoke');
  });
});

describe('missing dependencies are installed before measuring (10-02 Pod «commander» resolve failures)', () => {
  const tree = (withCommander: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-deps-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'elanous.mjs'), '');
    writeFileSync(join(dir, 'bun.lock'), '{}');
    if (withCommander) {
      mkdirSync(join(dir, 'node_modules', 'commander'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'commander', 'package.json'), '{}');
    }
    return dir;
  };
  const recorder = () => {
    const calls: string[] = [];
    const runCmd: RunCmd = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '', timedOut: false }; };
    return { calls, runCmd };
  };

  test('no node_modules → one frozen install before cli-smoke', async () => {
    const dir = tree(false);
    try {
      const { calls, runCmd } = recorder();
      const r = await runIntegrityGate(dir, { steps: ['cli-smoke'], runCmd });
      expect(calls).toEqual(['bun install --frozen-lockfile', 'bun bin/elanous.mjs --help']);
      expect(r.log).toContain('[deps] INSTALLED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('commander already resolvable → no install', async () => {
    const dir = tree(true);
    try {
      const { calls, runCmd } = recorder();
      await runIntegrityGate(dir, { steps: ['cli-smoke'], runCmd });
      expect(calls).toEqual(['bun bin/elanous.mjs --help']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('install failure is logged and the steps still run (their failure is the evidence)', async () => {
    const dir = tree(false);
    try {
      const calls: string[] = [];
      const runCmd: RunCmd = async (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        return args[0] === 'install' ? { code: 1, stdout: '', stderr: 'lockfile had changes', timedOut: false } : { code: 1, stdout: '', stderr: 'boom', timedOut: false };
      };
      const r = await runIntegrityGate(dir, { steps: ['cli-smoke'], runCmd });
      expect(calls).toHaveLength(2);
      expect(r.log).toContain('[deps] FAIL');
      expect(r.passed).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
