import { describe, expect, test } from 'bun:test';
import { completionBoundaryCommands, runGreenLeg, runIsolatedTestCommand, validateIsolatedTestCommand, type CommandResult } from './green-leg.js';

const title = `대상 경로: src/release-loop/checklist.ts\n- 완료 경계 증거 명령: bun test src/release-loop/checklist.test.ts\n- 완료 경계 실물 명령: bun test scripts/train/green-leg.test.ts`;

describe('TRAIN-GREEN-LEG', () => {
  test('extracts the required evidence command and optional real command through the canonical validator', () => {
    expect(completionBoundaryCommands(title)).toEqual({
      evidence: 'bun test src/release-loop/checklist.test.ts',
      real: 'bun test scripts/train/green-leg.test.ts', errors: [],
    });
    expect(completionBoundaryCommands(title.replace('- 완료 경계 실물 명령: bun test scripts/train/green-leg.test.ts', '- 완료 경계 실물 명령:')))
      .toMatchObject({ evidence: 'bun test src/release-loop/checklist.test.ts', real: undefined, errors: [] });
    expect(completionBoundaryCommands(title.replace('bun test scripts/train/green-leg.test.ts', 'bun test x; rm -rf /'))).toMatchObject({ errors: [expect.stringContaining('셸 연산자')] });
  });

  test('only permits repo relative Bun test paths for the test universe', () => {
    expect(validateIsolatedTestCommand('bun test src/a.test.ts').args).toEqual(['bun', 'test', 'src/a.test.ts']);
    expect(validateIsolatedTestCommand('bun bin/elanous.mjs release publish')).toHaveProperty('error');
    expect(validateIsolatedTestCommand('bun test ../../outside.test.ts')).toHaveProperty('error');
    expect(validateIsolatedTestCommand('bun test src/a.test.ts --filter x')).toHaveProperty('error');
  });

  test('executes an allowed command without a shell and captures its result', async () => {
    const result = await runIsolatedTestCommand('bun test src/cli/test-state-dir-flag.test.ts', process.cwd(), 30_000);
    expect(result.rc).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTail).toContain('pass');
  }, 35_000);

  test('records failing and timed out evidence without asking for green', async () => {
    const scenarios: Array<{ rc: number | null; timedOut: boolean }> = [{ rc: 1, timedOut: false }, { rc: null, timedOut: true }];
    for (const scenario of scenarios) {
      let recorded = '', proposed = '';
      const result: CommandResult = { command: 'bun test x.test.ts', ...scenario, outputTail: 'failure detail', startedAt: 'start', endedAt: 'end' };
      const outcome = await runGreenLeg({ version: '0.2.37', cellId: 'CELL', mergeSha: 'abc', tree: process.cwd() }, {
        now: () => 'now', run: async () => result,
        resolveLandedMerge: (_tree, sha) => sha.repeat(40).slice(0, 40),
        getCell: () => ({ title, status: 'yellow' }),
        record: async (_input, evidence) => { recorded = evidence; },
        propose: async (body) => { proposed = body; },
      });
      expect(outcome.passed).toBe(false);
      expect(recorded).toContain('우주 표기(test:');
      expect(recorded).toContain('착지 merge SHA');
      expect(recorded).toContain('rc=');
      expect(recorded).toContain('failure detail');
      expect(proposed).toContain('evidence-only');
      expect(proposed).not.toContain('propose-green');
    }
  });

  test('records invalid landed merge evidence without running tests or proposing green', async () => {
    let recorded = '', proposed = '';
    let ran = false;
    const outcome = await runGreenLeg({ version: '0.2.37', cellId: 'CELL', mergeSha: 'bad-sha', tree: process.cwd() }, {
      now: () => 'now', run: async () => { ran = true; throw new Error('must not run'); },
      resolveLandedMerge: () => { throw new Error('merge commit is not an ancestor'); },
      getCell: () => ({ title, status: 'yellow' }),
      record: async (_input, evidence) => { recorded = evidence; },
      propose: async (body) => { proposed = body; },
    });
    expect(ran).toBe(false);
    expect(outcome.passed).toBe(false);
    expect(outcome.evidence).toContain('merge commit is not an ancestor');
    expect(recorded).toContain('우주 표기(test:');
    expect(recorded).toContain('결과=미측정 · green 금지');
    expect(proposed).toContain('evidence-only');
    expect(proposed).not.toContain('propose-green');
  });

  test('keeps an operational E4 cell human-collected when its optional command is blank', async () => {
    let proposed = '';
    const realBlank = title.replace('- 완료 경계 실물 명령: bun test scripts/train/green-leg.test.ts', '- 완료 경계 실물 명령:');
    const result: CommandResult = { command: 'bun test src/release-loop/checklist.test.ts', rc: 0, timedOut: false, outputTail: 'pass', startedAt: 'start', endedAt: 'end' };
    const outcome = await runGreenLeg({ version: '0.2.37', cellId: 'CELL', mergeSha: 'abc', tree: process.cwd() }, {
      now: () => 'now', run: async () => result,
      resolveLandedMerge: (_tree, sha) => sha.repeat(40).slice(0, 40),
      getCell: () => ({ title: realBlank, status: 'yellow' }),
      record: async () => {}, propose: async (body) => { proposed = body; },
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.evidence).toContain('human-collected');
    expect(proposed).toContain('evidence-only');
  });
});
