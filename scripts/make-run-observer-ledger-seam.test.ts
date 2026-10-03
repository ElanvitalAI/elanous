import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

/**
 * `makeRunObserver` 테스트 호출의 원장 writer 심을 센다 — 고치는 게 아니라 다시 자라지 못하게 한다.
 *
 * 네 번째 인자를 생략하면 production 기본값 `appendRunLedgerEntry`가 실제 run-ledger에 fixture를
 * 쓴다. production 호출은 정상이라 세지 않고, repository의 `*.test.ts` 호출만 0으로 ratchet한다.
 */
const ROOT = join(import.meta.dir, '..');
const TEST_FILE = /\.test\.ts$/;
const CALLEE = 'makeRunObserver';
const LEDGER_EFFECT_TEST = 'src/self-implement/run-ledger-cli.test.ts';
const LEDGER_EFFECT_PATTERN = '종결 기록 부재와 읽지 못한 원장을 구분하고, 마지막 브랜치 마디로 찾은 골의 경로와 탐색 범위를 낸다';
const ZERO_TEST_PATTERN = 'makeRunObserver-ledger-writer-seam-pattern-must-never-match';
const decoder = new TextDecoder();

interface ChildTestResult {
  exitCode: number;
  output: string;
  executed: number;
}

function runChildTest(pattern: string): ChildTestResult {
  const child = Bun.spawnSync({
    cmd: ['bun', 'test', LEDGER_EFFECT_TEST, '--test-name-pattern', pattern],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${decoder.decode(child.stdout)}${decoder.decode(child.stderr)}`;
  const match = output.match(/Ran (\d+) tests? across \d+ files?\./);
  return { exitCode: child.exitCode, output, executed: Number(match?.[1] ?? 0) };
}

function expectSuccessfulLedgerEffect(result: ChildTestResult): void {
  expect(result.exitCode, result.output).toBe(0);
  expect(result.executed, result.output).toBeGreaterThan(0);
  expect(result.output).toContain('1 pass');
}

function expectNoTestsRejected(result: ChildTestResult): void {
  expect(result.exitCode, result.output).not.toBe(0);
  expect(result.executed, result.output).toBe(0);
  expect(result.output).toMatch(/matched 0 tests|0 pass|Ran 0 tests/);
}

interface Violation {
  path: string;
  line: number;
}

function testFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : testFiles(path);
    return entry.isFile() && TEST_FILE.test(entry.name) ? [path] : [];
  });
}

function seamlessCalls(): Violation[] {
  const violations: Violation[] = [];
  for (const path of testFiles()) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === CALLEE && node.arguments.length < 4) {
        const { line } = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
        violations.push({ path: relative(ROOT, path), line: line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

describe('makeRunObserver ledger-writer seam exposure', () => {
  test('every test call explicitly supplies the fourth ledger writer argument', () => {
    const violations = seamlessCalls();
    expect(violations.map(({ path, line }) => `${path}:${line}`)).toEqual([]);
  });

  test('the ratchet has a non-empty repository test-file denominator and a passing ledger-writer effect', () => {
    expect(testFiles().length).toBeGreaterThan(0);
    expectSuccessfulLedgerEffect(runChildTest(LEDGER_EFFECT_PATTERN));
  });

  test('rejects a ledger-effect child invocation that executes zero tests', () => {
    expectNoTestsRejected(runChildTest(ZERO_TEST_PATTERN));
  });
});
