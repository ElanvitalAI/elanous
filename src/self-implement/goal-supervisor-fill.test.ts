import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillUnverifiableGoalSlots, type SupervisorGoalDeficit } from './goal-supervisor-fill.js';
import { repairNextMove } from '../task-agent/repair-next-move.js';
import { defaultSeams } from './seams.js';

test('sectionless goal with a passing gate stays unverifiable without deficit or rewrite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-sectionless-'));
  const path = join(directory, 'goal.txt');
  const original = 'One-line goal with no sections.\n';
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 0, gate: { passed: true, log: 'ok' },
      review: { verdict: 'pass' }, independentlyCheck: async () => true, observeDeficit: (d) => deficits.push(d) })).toBe('unverifiable');
    expect(deficits).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing section with an actual UNVERIFIABLE slot still reports a deficit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-missing-section-slot-'));
  const path = join(directory, 'goal.txt');
  const original = '## 불변식\n- UNVERIFIABLE\n';
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 0, gate: { passed: true, log: 'ok' },
      review: { verdict: 'pass' }, independentlyCheck: async () => true, observeDeficit: (d) => deficits.push(d) })).toBe('unverifiable');
    expect(deficits.map((d) => d.reason)).toEqual(['missing-section']);
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-DOCS-ONLY-PASS · scoped docs-only gate leaves authored slots byte-identical without a test measurement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-docs-only-'));
  const path = join(directory, 'goal.txt');
  const original = '## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- UNVERIFIABLE\n';
  const log = '[cli-smoke] PASS bun bin/elanous.mjs --help\n[gate-scope] docs-only — test 스텝을 건너뛰었다(변경파일 tsc 만 검증).';
  const deficits: SupervisorGoalDeficit[] = [];
  let checks = 0;
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 0,
      gate: { passed: true, testStepExecuted: false, scopeReason: 'docs-only', log },
      review: { verdict: 'pass' }, independentlyCheck: async () => { checks++; return true; },
      observeDeficit: (deficit) => deficits.push(deficit),
    })).toBe('not-applicable');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(checks).toBe(0);
    expect(deficits).toEqual([]);

    for (const gate of [
      { passed: true, testStepExecuted: true, scopeReason: 'changed-tests', log },
      { passed: true, testStepExecuted: false, scopeReason: 'changed-tests', log },
      { passed: false, testStepExecuted: false, scopeReason: 'docs-only', log },
    ]) {
      expect(await fillUnverifiableGoalSlots({ path, round: 0, gate,
        review: { verdict: 'pass' }, independentlyCheck: async () => true,
      })).toBe('unverifiable');
      expect(readFileSync(path, 'utf8')).toBe(original);
    }
    expect(await fillUnverifiableGoalSlots({ path, round: 0,
      gate: { passed: true, testStepExecuted: false, scopeReason: 'docs-only', log },
      wiring: 'unwired', review: { verdict: 'pass' }, independentlyCheck: async () => true,
    })).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-REMEASURE-ABANDON · 실측 PASS 로그 두 건은 baseline 미실행을 정직하게 기록하고 독립 검사된다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-pass-without-baseline-'));
  const path = join(directory, 'goal.txt');
  const original = '## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- UNVERIFIABLE\n';
  const check = defaultSeams().independentlyCheckGoalSlots!;
  // node-b 자식 run-8bd05c9d 및 run-01e1f72b의 gate.log 첫 PASS 행.
  const passLines = [
    '[test] PASS bun test scripts/dead-code/report.test.ts —  0 fail |  13 expect() calls | Ran 3 tests across 1 file. [548.00ms]',
    '[test] PASS bun test src/task-agent/green-sweep.test.ts —  0 fail |  104 expect() calls | Ran 14 tests across 1 file. [628.00ms]',
  ];
  try {
    for (const log of passLines) {
      writeFileSync(path, original);
      expect(await fillUnverifiableGoalSlots({ path, round: 0, gate: { passed: true, log }, review: { verdict: 'pass' }, independentlyCheck: check })).toBe('filled');
      const filled = readFileSync(path, 'utf8');
      expect(filled).toContain('baseline not run (test PASS)');
      expect(filled).not.toContain('introduced=0');
    }
    for (const log of [
      passLines[0]!.replace('0 fail', '1 fail'),
      `${passLines[1]}\n[gate-baseline] introduced=0, preexisting=1, unknown=0, precondition-unmet=0`,
    ]) {
      writeFileSync(path, original);
      expect(await fillUnverifiableGoalSlots({ path, round: 0, gate: { passed: true, log }, review: { verdict: 'pass' }, independentlyCheck: check })).toBe('unverifiable');
      expect(readFileSync(path, 'utf8')).toBe(original);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('report-deficit keeps the original evidence and identifies unmeasured versus unwired', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-'));
  const path = join(directory, 'goal.txt');
  const original = '## 불변식\n- UNVERIFIABLE: no measurement\n- previous evidence: run-1\n\n## 판정 신호\n- UNVERIFIABLE: not connected\n- previous signal: ledger-1\n';
  try {
    writeFileSync(path, original);
    const observations: SupervisorGoalDeficit[] = [];
    const unmeasured = await fillUnverifiableGoalSlots({ path, round: 1, gate: { passed: false }, independentlyCheck: async () => false, observeDeficit: (observation) => observations.push(observation) });
    expect(unmeasured).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(observations).toEqual([expect.objectContaining({ kind: 'unmeasured', previousEvidence: original, evidenceId: expect.any(String) })]);
    const unwired = await fillUnverifiableGoalSlots({ path, round: 1, gate: { passed: true, log: '[test] PASS bun test a — 1 pass | 0 fail\n[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0' }, review: { verdict: 'pass' }, wiring: 'unwired', independentlyCheck: async () => false, observeDeficit: (observation) => observations.push(observation) });
    expect(unwired).toBe('unverifiable');
    let checkedUnwired = 0;
    const stillUnwired = await fillUnverifiableGoalSlots({ path, round: 1,
      gate: { passed: true, log: '[test] PASS bun test a — 1 pass | 0 fail\n[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0' },
      review: { verdict: 'pass' }, wiring: 'unwired',
      independentlyCheck: async () => { checkedUnwired++; return true; },
      observeDeficit: (observation) => observations.push(observation) });
    expect(stillUnwired).toBe('unverifiable');
    expect(checkedUnwired).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original);
    const unverified = await fillUnverifiableGoalSlots({ path, round: 1,
      gate: { passed: true, log: '[test] PASS bun test a — 1 pass | 0 fail\n[gate-baseline] introduced=0, preexisting=0, unknown=0, precondition-unmet=0' },
      review: { verdict: 'pass' }, independentlyCheck: async () => false,
      observeDeficit: (observation) => observations.push(observation) });
    expect(unverified).toBe('rejected');
    expect(observations[2]).toMatchObject({ kind: 'unwired' });
    expect(observations[3]).toMatchObject({ kind: 'unverified' });
    expect(observations[1]).toEqual(expect.objectContaining({ kind: 'unwired', previousEvidence: original, evidenceId: observations[0]?.evidenceId }));
    expect(repairNextMove({ supervisorDeficit: observations[0]! })).toMatchObject({ kind: 'grounding', action: 'remeasure' });
    expect(repairNextMove({ supervisorDeficit: observations[1]! })).toMatchObject({ kind: 'grounding', action: 'connect-goal' });
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('GOAL-SLOT-UNVERIFIABLE-2 · authored signal remains intact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-authored-'));
  const path = join(directory, 'goal.txt');
  const original = `## 불변식
- UNVERIFIABLE: no evidence

## 판정 신호
- Candidate decision signal:
  - Condition: bun test src/task-agent/judge.test.ts
  - Expected result: 0 fail
  - 숫자 출처: UNVERIFIABLE: no numeric source evidence
`;
  const gateLog = '[test] PASS bun test src/task-agent/judge.test.ts —  0 fail | 10 expect() calls';
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 1, gate: { passed: true, log: gateLog },
      review: { verdict: 'pass' }, independentlyCheck: defaultSeams().independentlyCheckGoalSlots! })).toBe('filled');
    const filled = readFileSync(path, 'utf8');
    expect(filled).toContain('Candidate decision signal:');
    expect(filled).toContain('숫자 출처: UNVERIFIABLE: no numeric source evidence');
    expect(filled).toContain('filled-by: supervisor@round-1');
    expect(filled).toContain('관측 — `bun test src/task-agent/judge.test.ts`');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · authored numeric source remains unmeasured', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-production-shapes-'));
  const path = join(directory, 'goal.txt');
  const check = defaultSeams().independentlyCheckGoalSlots!;
  const cases = [
    ['bun test src/task-agent/rejudge-on-head.test.ts', '  - Observation: rejection cases and history'],
    ['bun test src/seat-loop/seat-loop.test.ts src/decisions/decision-cards.test.ts', '  - 숫자 출처: UNVERIFIABLE: no numeric source evidence was supplied'],
    ['bun test src/task-agent/repair-next-move.test.ts src/task-agent/judge.test.ts src/task-agent/rejudge-on-head.test.ts', '  - 숫자 적용 범위: UNVERIFIABLE: no numeric coverage evidence was supplied'],
  ] as const;
  try {
    for (const [command, authored] of cases) {
      const original = `## 불변식\n- UNVERIFIABLE: no invariant evidence\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n${authored}\n`;
      writeFileSync(path, original);
      expect(await fillUnverifiableGoalSlots({ path, round: 0,
        gate: { passed: true, log: `[test] PASS ${command} —  0 fail | 12 expect() calls` },
        review: { verdict: 'pass' }, independentlyCheck: check })).toBe('filled');
      const filled = readFileSync(path, 'utf8');
      expect(filled).toContain(authored);
      expect(filled).toContain(`- Condition: ${command}`);
      expect(filled).toContain('이번 라운드 관측값 — fail 0');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · invalid gate keeps authored goal unchanged and names the reason', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-invalid-'));
  const path = join(directory, 'goal.txt');
  const original = '## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: bun test a\n';
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    for (const log of ['[test] PASS bun test a — 1 fail', '[test] PASS bun test a — 0 fail\n[gate-baseline] introduced=1, preexisting=0, unknown=0, precondition-unmet=0']) {
      writeFileSync(path, original);
      expect(await fillUnverifiableGoalSlots({ path, round: 0, gate: { passed: true, log }, review: { verdict: 'pass' },
        independentlyCheck: async () => true, observeDeficit: (d) => deficits.push(d) })).toBe('unverifiable');
      expect(readFileSync(path, 'utf8')).toBe(original);
    }
    expect(deficits.map((d) => d.reason)).toEqual(['gate-evidence-unverified', 'gate-evidence-unverified']);
    expect(deficits[0]?.inputSummary).toMatchObject({ gatePassed: true, hasGateLog: true, invariantSlot: true, signalSlot: false });
    expect(deficits[0]?.gateLogRef).toStartWith('sha256:');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('GOAL-SLOT-UNVERIFIABLE-2 · unrelated PASS cannot certify authored condition', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-condition-mismatch-'));
  const path = join(directory, 'goal.txt');
  const original = `## 불변식
- UNVERIFIABLE

## 판정 신호
- Candidate decision signal:
  - Condition: bun test src/a.test.ts 를 실행한다
`;
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 1, gate: { passed: true,
      log: '[test] PASS bun test src/b.test.ts — 0 fail' }, review: { verdict: 'pass' },
      independentlyCheck: async () => true, observeDeficit: (d) => deficits.push(d) })).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(deficits[0]?.reason).toBe('authored-signal-command-mismatch');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
