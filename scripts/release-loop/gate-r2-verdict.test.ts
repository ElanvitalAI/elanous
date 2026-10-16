import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGateR2Verdict, gateR2JunitCases, gateR2Main, type GateR2Input } from './gate-r2-verdict.js';

const tempDirs = new Set<string>();
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); tempDirs.add(dir); return dir; };
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FILE = 'src/a.test.ts';
const ID = `${FILE} > suite > target`;
const xml = (status: 'pass' | 'fail' | 'error', name = 'target') => `<testsuites><testsuite name="${FILE}" file="${FILE}"><testsuite name="suite"><testcase name="${name}">${status === 'pass' ? '' : `<${status === 'fail' ? 'failure' : 'error'}/>`}</testcase></testsuite></testsuite></testsuites>`;

function fixture(solo: 'pass' | 'fail' | 'error', base: 'pass' | 'fail' | 'error', baseName = 'target'): GateR2Input {
  const dir = tempDir('gate-r2-');
  const paths = ['batch.xml', 'solo.xml', 'base.xml'].map((name) => join(dir, name));
  writeFileSync(paths[0]!, xml('fail'));
  writeFileSync(paths[1]!, xml(solo));
  writeFileSync(paths[2]!, xml(base, baseName));
  const run = (head40: string, cohort: string[], rc: number, junitPath: string) => {
    const result = { runId: `run-${junitPath.split('/').at(-1)!.replace('.xml', '')}-001`, head40,
      envKey: 'linux-pod:bun1.4.2:TZ=UTC', cohort, rc, junitPath, resultPath: `${junitPath}.result.json` };
    writeFileSync(result.resultPath, JSON.stringify(result));
    return result;
  };
  return { stableTestId: ID, head40: HEAD, base40: BASE, envKey: 'linux-pod:bun1.4.2:TZ=UTC', shards: 4,
    cohort: [FILE, 'src/b.test.ts'], batch: run(HEAD, [FILE, 'src/b.test.ts'], 1, paths[0]!),
    solo: run(HEAD, [FILE], solo === 'pass' ? 0 : 1, paths[1]!),
    baseline: run(BASE, [FILE], base === 'pass' ? 0 : 1, paths[2]!) };
}

describe('R2 gate verdict', () => {
  test('reads nested JUnit case identities and rejects incomplete XML', () => {
    expect(gateR2JunitCases(xml('error'))?.get(ID)).toBe('error');
    expect(gateR2JunitCases(xml('pass'))?.get(ID)).toBe('pass');
    expect(gateR2JunitCases('<testsuite file="src/a.test.ts"><testcase name="x">')).toBeNull();
    expect(gateR2JunitCases(`<testsuite file="${FILE}"><testcase name="target"><failure></testcase></testsuite>`)).toBeNull();
    expect(gateR2JunitCases(`<?xml version="1.0" encoding="UTF-8"?>\n${xml('fail')}`)?.get(ID)).toBe('fail');
    expect(gateR2JunitCases(`<testsuites><testsuite name="${FILE}" file="${FILE}"><testsuite name="suite"><testcase name="target > variant"/></testsuite></testsuite></testsuites>`)?.get(`${ID} > variant`)).toBe('pass');
    expect(gateR2JunitCases(`<testcase file="${FILE}" name="target"/>`)).toBeNull();
    expect(gateR2JunitCases(`<testsuites tests="2"><testsuite name="${FILE}" file="${FILE}" tests="1"><testcase name="target"/></testsuite></testsuites>`)).toBeNull();
    expect(gateR2JunitCases(`<testsuites tests="1"><testsuite name="${FILE}" file="${FILE}" tests="1"><testcase/></testsuite></testsuites>`)).toBeNull();
  });

  test('batch failure and exact same-head/env solo pass stays interference candidate, never introduced waiver', () => {
    const result = classifyGateR2Verdict(fixture('pass', 'pass'));
    expect(result).toMatchObject({ verdict: 'interference-candidate', stableTestId: ID, identityStatus: 'exact' });
    expect(result.evidence.batchResultPath).toContain('batch.xml.result.json');
  });

  test('Bun spec and JavaScript test files are valid cohort members', () => {
    for (const candidate of ['src/b.spec.ts', 'src/b.test.js']) {
      const input = fixture('pass', 'pass');
      input.cohort[1] = candidate;
      input.batch.cohort[1] = candidate;
      writeFileSync(input.batch.resultPath, JSON.stringify(input.batch));
      expect(classifyGateR2Verdict(input).verdict).toBe('interference-candidate');
    }
  });

  test('solo failure is introduced only after the same baseline testcase passed; same failure is preexisting', () => {
    expect(classifyGateR2Verdict(fixture('fail', 'pass')).verdict).toBe('introduced');
    expect(classifyGateR2Verdict(fixture('error', 'fail')).verdict).toBe('preexisting');
  });

  test('rename candidate does not silently turn a missing baseline identity into preexisting', () => {
    const input = fixture('fail', 'fail', 'old target');
    input.renameCandidate = { oldTestId: `${FILE} > suite > old target`, oldDigest: 'same-body', newDigest: 'same-body', unique: true };
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'renamed-existing-candidate' });
    const absentDigests = fixture('fail', 'fail', 'old target');
    absentDigests.renameCandidate = { oldTestId: `${FILE} > suite > old target`, unique: true } as GateR2Input['renameCandidate'];
    expect(classifyGateR2Verdict(absentDigests)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('head/env mismatch or missing JUnit remains unmeasured', () => {
    const wrongEnv = fixture('fail', 'pass'); wrongEnv.solo.envKey = 'different';
    expect(classifyGateR2Verdict(wrongEnv).verdict).toBe('unmeasured');
    const missing = fixture('fail', 'pass'); missing.batch.junitPath = '/missing/r2-junit.xml';
    expect(classifyGateR2Verdict(missing).verdict).toBe('unmeasured');
    const wrongResult = fixture('fail', 'pass');
    writeFileSync(wrongResult.solo.resultPath, JSON.stringify({ ...wrongResult.solo, head40: BASE }));
    expect(classifyGateR2Verdict(wrongResult)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
    const wrongPath = fixture('fail', 'pass');
    writeFileSync(wrongPath.solo.resultPath, JSON.stringify({ ...wrongPath.solo, resultPath: '/foreign/result.json' }));
    expect(classifyGateR2Verdict(wrongPath).verdict).toBe('unmeasured');
    const mixedBase = fixture('fail', 'pass'); mixedBase.baseline.cohort.push('src/b.test.ts');
    expect(classifyGateR2Verdict(mixedBase).verdict).toBe('unmeasured');
  });

  test('solo pass without exact baseline testcase identity stays unmeasured', () => {
    const input = fixture('pass', 'pass', 'old target');
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('solo and baseline must have separate JUnit artifacts', () => {
    const input = fixture('pass', 'pass');
    input.baseline.junitPath = input.solo.junitPath;
    writeFileSync(input.baseline.resultPath, JSON.stringify(input.baseline));
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
    const alias = `${input.solo.junitPath}.alias`;
    symlinkSync(input.solo.junitPath, alias);
    input.baseline.junitPath = alias;
    writeFileSync(input.baseline.resultPath, JSON.stringify(input.baseline));
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('solo JUnit cannot contain a testcase outside its declared file', () => {
    const input = fixture('pass', 'pass');
    writeFileSync(input.solo.junitPath, `<testsuites><testsuite name="${FILE}" file="${FILE}"><testsuite name="suite"><testcase name="target"/></testsuite></testsuite><testsuite name="src/foreign.test.ts" file="src/foreign.test.ts"><testcase name="other"/></testsuite></testsuites>`);
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('a zero exit code contradicting another JUnit failure is unmeasured', () => {
    const input = fixture('pass', 'pass');
    writeFileSync(input.solo.junitPath, `<testsuites><testsuite name="${FILE}" file="${FILE}"><testsuite name="suite"><testcase name="target"/><testcase name="other"><failure/></testcase></testsuite></testsuite></testsuites>`);
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('a skipped baseline testcase cannot establish interference', () => {
    const input = fixture('pass', 'pass');
    writeFileSync(input.baseline.junitPath, `<testsuites><testsuite name="${FILE}" file="${FILE}"><testsuite name="suite"><testcase name="target"><skipped/></testcase></testsuite></testsuite></testsuites>`);
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('independent infrastructure signature precedes testcase preexisting; contradictory base rc is unmeasured', () => {
    const input = fixture('fail', 'fail');
    const dir = tempDir('gate-r2-infra-');
    const batchStatusPath = join(dir, 'batch-status.json');
    const baselineStatusPath = join(dir, 'base-status.json');
    const status = (head40: string, runId: string) => JSON.stringify({ kind: 'pod-infrastructure', head40,
      envKey: input.envKey, signature: 'POD_INFRA_FAILURE', runId });
    writeFileSync(batchStatusPath, status(HEAD, input.batch.runId));
    writeFileSync(baselineStatusPath, status(BASE, input.baseline.runId));
    input.environmentProof = { signature: 'POD_INFRA_FAILURE', batchStatusPath, baselineStatusPath };
    expect(classifyGateR2Verdict(input).verdict).toBe('environment-failure');
    input.environmentProof.baselineStatusPath = batchStatusPath;
    expect(classifyGateR2Verdict(input).verdict).toBe('unmeasured');
    input.environmentProof.baselineStatusPath = baselineStatusPath;
    writeFileSync(baselineStatusPath, status(BASE, input.batch.runId));
    expect(classifyGateR2Verdict(input).verdict).toBe('unmeasured');
    writeFileSync(baselineStatusPath, status(BASE, input.baseline.runId));
    writeFileSync(batchStatusPath, status(HEAD, 'run-foreign-001'));
    expect(classifyGateR2Verdict(input).verdict).toBe('unmeasured');
    writeFileSync(batchStatusPath, status(HEAD, input.batch.runId));
    input.baseline.rc = 0;
    writeFileSync(input.baseline.resultPath, JSON.stringify(input.baseline));
    expect(classifyGateR2Verdict(input).verdict).toBe('unmeasured');
    const missingSolo = fixture('fail', 'fail');
    missingSolo.environmentProof = input.environmentProof;
    writeFileSync(missingSolo.solo.junitPath, xml('pass', 'other'));
    expect(classifyGateR2Verdict(missingSolo)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('CLI rejects Pod status from another execution with the same head and environment', async () => {
    const input = fixture('fail', 'fail');
    const dir = tempDir('gate-r2-foreign-pod-');
    const batchStatusPath = join(dir, 'batch-status.json');
    const baselineStatusPath = join(dir, 'base-status.json');
    writeFileSync(batchStatusPath, JSON.stringify({ kind: 'pod-infrastructure', head40: HEAD,
      envKey: input.envKey, signature: 'POD_INFRA_FAILURE', runId: 'run-foreign-001' }));
    writeFileSync(baselineStatusPath, JSON.stringify({ kind: 'pod-infrastructure', head40: BASE,
      envKey: input.envKey, signature: 'POD_INFRA_FAILURE', runId: input.baseline.runId }));
    input.environmentProof = { signature: 'POD_INFRA_FAILURE', batchStatusPath, baselineStatusPath };
    const path = join(dir, 'input.json');
    writeFileSync(path, JSON.stringify(input));
    const lines: string[] = [];
    expect(await gateR2Main(['--input', path, '--json'], (line) => lines.push(line))).toBe(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('Pod infrastructure proof cannot explain a baseline target that passed', () => {
    const input = fixture('fail', 'pass');
    writeFileSync(input.baseline.junitPath, `<testsuites><testsuite name="${FILE}" file="${FILE}"><testsuite name="suite"><testcase name="target"/><testcase name="other"><failure/></testcase></testsuite></testsuite></testsuites>`);
    input.baseline.rc = 1;
    writeFileSync(input.baseline.resultPath, JSON.stringify(input.baseline));
    const dir = tempDir('gate-r2-base-other-');
    const batchStatusPath = join(dir, 'batch-status.json');
    const baselineStatusPath = join(dir, 'base-status.json');
    for (const [path, run] of [[batchStatusPath, input.batch], [baselineStatusPath, input.baseline]] as const)
      writeFileSync(path, JSON.stringify({ kind: 'pod-infrastructure', head40: run.head40, envKey: input.envKey,
        signature: 'POD_INFRA_FAILURE', runId: run.runId }));
    input.environmentProof = { signature: 'POD_INFRA_FAILURE', batchStatusPath, baselineStatusPath };
    expect(classifyGateR2Verdict(input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured' });
  });

  test('missing required input and CLI parse failure retain the full unmeasured contract', async () => {
    expect(classifyGateR2Verdict({} as GateR2Input)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured', evidence: { reason: expect.any(String) } });
    const path = join(tempDir('gate-r2-invalid-'), 'input.json');
    writeFileSync(path, '{invalid');
    const lines: string[] = [];
    expect(await gateR2Main(['--input', path, '--json'], (line) => lines.push(line))).toBe(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ verdict: 'unmeasured', identityStatus: 'identity-unmeasured', evidence: { reason: expect.any(String) } });
  });

  test('actual Bun JUnit reporter and CLI classify a cohort-only failure', () => {
    const dir = tempDir('gate-r2-bun-');
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, FILE), `import { test, expect } from 'bun:test';\nimport { existsSync } from 'node:fs';\ntest('target', () => expect(existsSync('cohort-marker')).toBe(false));\n`);
      writeFileSync(join(dir, 'src/b.test.ts'), `import { test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\ntest('other', () => writeFileSync('cohort-marker', 'present'));\n`);
      const input = fixture('pass', 'pass');
      input.stableTestId = `${FILE} > target`;
      for (const [name, run, files, expectedRc] of [
        ['batch', input.batch, ['src/b.test.ts', FILE], 1],
        ['solo', input.solo, [FILE], 0],
        ['base', input.baseline, [FILE], 0],
      ] as const) {
        rmSync(join(dir, 'cohort-marker'), { force: true });
        // A cohort-only failure must not depend on which test file Bun starts first.
        if (name === 'batch') writeFileSync(join(dir, 'cohort-marker'), 'present');
        run.junitPath = join(dir, `${name}.xml`);
        run.resultPath = join(dir, `${name}.json`);
        const result = spawnSync(process.execPath, ['test', ...files, '--reporter=junit', `--reporter-outfile=${run.junitPath}`],
          { cwd: dir, encoding: 'utf8', timeout: 30_000 });
        expect(result.status).toBe(expectedRc);
        writeFileSync(run.resultPath, JSON.stringify(run));
      }
      const path = join(dir, 'input.json');
      writeFileSync(path, JSON.stringify(input));
      const cli = spawnSync(process.execPath, [join(import.meta.dir, 'gate-r2-verdict.ts'), '--input', path, '--json'],
        { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      if (cli.status !== 0) throw new Error(JSON.stringify({ status: cli.status, stdout: cli.stdout, stderr: cli.stderr }));
      expect(cli.status).toBe(0);
      expect(JSON.parse(cli.stdout).verdict).toBe('interference-candidate');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('CLI reads a result file and emits the same JSON verdict', async () => {
    const input = fixture('pass', 'pass');
    const path = join(tempDir('gate-r2-cli-'), 'input.json');
    writeFileSync(path, JSON.stringify(input));
    const lines: string[] = [];
    expect(await gateR2Main(['--input', path, '--json'], (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[0]!).verdict).toBe('interference-candidate');
  });
});
