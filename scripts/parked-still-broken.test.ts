import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_LIMIT, auditParked, findGoalDocument, parkedItems, parseLimit, selfCheck, targetTests, type ParkedItem } from './parked-still-broken.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function withFixture(run: (fixture: string, goals: string) => void): void {
  const fixture = mkdtempSync(join(tmpdir(), 'parked-still-broken-'));
  const goals = join(fixture, 'goals');
  try {
    mkdirSync(goals, { recursive: true });
    writeFileSync(join(fixture, 'pass.test.ts'), "import { expect, test } from 'bun:test'; test('passes', () => expect(Bun.file('pass.test.ts').size).toBeGreaterThan(0));\n");
    writeFileSync(join(fixture, 'fail.test.ts'), "import { expect, test } from 'bun:test'; test('fails', () => expect(true).toBe(false));\n");
    writeFileSync(join(fixture, 'source.ts'), '');
    writeFileSync(join(goals, 'pass.md'), '대상 경로: pass.test.ts\n- GoalId: pass\n');
    writeFileSync(join(goals, 'fail.md'), '대상 경로: fail.test.ts\n- GoalId: fail\n');
    writeFileSync(join(goals, 'mixed.md'), '대상 경로: pass.test.ts · fail.test.ts\n- GoalId: mixed\n');
    writeFileSync(join(goals, 'none.md'), '대상 경로: source.ts\n- GoalId: none\n');
    run(fixture, goals);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}

describe('parked-still-broken', () => {
  test('각 판정을 구분하고 실제 Bun 시험의 다른 종료 코드로 통과와 실패를 판정한다', () => withFixture((fixture, goals) => {
    const statuses: number[] = [];
    const items: ParkedItem[] = [{ goalId: 'pass' }, { goalId: 'fail' }, { goalId: 'missing' }, { goalId: 'none' }, { goalId: 'pass' }];
    const rows = auditParked(items, goals, fixture, path => {
      const result = spawnSync(process.execPath, ['test', join(fixture, path)], { cwd: fixture, encoding: 'utf8' });
      if (result.status !== null) statuses.push(result.status);
      return { status: result.status, ...(result.error ? { error: result.error.message } : {}) };
    }, 2);
    expect(statuses).toEqual([0, 1]);
    expect(rows.map(row => row.classification)).toEqual(['currently-passing', 'still-failing', 'missing-goal-document', 'no-target-test', 'test-execution-unavailable']);
  }));

  test('복수 대상 시험을 모두 실행해 하나라도 실패하면 still-failing으로 종합한다', () => withFixture((fixture, goals) => {
    const calls: string[] = [];
    const rows = auditParked([{ goalId: 'mixed' }], goals, fixture, path => {
      calls.push(path);
      return { status: path === 'fail.test.ts' ? 1 : 0 };
    }, 2);
    expect(calls).toEqual(['pass.test.ts', 'fail.test.ts']);
    expect(rows).toMatchObject([{ classification: 'still-failing', testPath: 'fail.test.ts' }]);
  }));

  test('GoalId는 완전 일치만 찾고 기본과 명시 상한은 유한하며 첫 줄 대상 경로의 실재 시험만 고른다', () => withFixture((fixture, goals) => {
    writeFileSync(join(goals, 'foobar.md'), '대상 경로: fail.test.ts\nGoalId: foobar\n');
    expect(findGoalDocument(goals, 'foo')).toBeUndefined();
    expect(findGoalDocument(goals, 'foobar')).toBe('foobar.md');
    expect(parseLimit([])).toBe(DEFAULT_LIMIT);
    expect(parseLimit(['--limit=2'])).toBe(2);
    expect(() => parseLimit(['--limit=-1'])).toThrow('--limit must be a non-negative integer');
    expect(targetTests('대상 경로: pass.test.ts · missing.test.ts\n다음 줄: fail.test.ts', fixture)).toEqual(['pass.test.ts']);
  }));

  test('운영 기본 호출은 --test 없이 parked 재고를 읽고 self-check는 실제 종료 코드와 분류를 출력한다', () => {
    let args: readonly string[] = [];
    expect(parkedItems([], received => { args = received; return { status: 0, stdout: '[]' }; })).toEqual([]);
    expect(args).toEqual(['self', 'parked', '--json']);
    const lines: string[] = [];
    expect(selfCheck(line => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toContain('실제 Bun 시험 종료 코드 · 통과 0 · 실패 1');
    expect(lines.at(-1)).toContain('✅');
  });
});
