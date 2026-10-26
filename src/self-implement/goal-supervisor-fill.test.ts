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
    const command = 'bun test src/task-agent/judge.test.ts';
    expect(await fillUnverifiableGoalSlots({ path, round: 1, gate: { passed: true, log: gateLog },
      authoredSignal: { command, exitCode: 0, stdout: '10 pass | 0 fail', stderr: '' },
      review: { verdict: 'pass' }, independentlyCheck: defaultSeams().independentlyCheckGoalSlots! })).toBe('filled');
    const filled = readFileSync(path, 'utf8');
    expect(filled).toContain('Candidate decision signal:');
    expect(filled).toContain('숫자 출처: UNVERIFIABLE: no numeric source evidence');
    expect(filled).toContain('filled-by: supervisor@round-1');
    expect(filled).toContain('관측 — `bun test src/task-agent/judge.test.ts`');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · independently executed authored test may differ from gate tests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-independent-signal-'));
  const path = join(directory, 'goal.txt');
  const command = 'bun test src/a.test.ts';
  const original = `## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n`;
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 1,
      gate: { passed: true, log: '[test] PASS bun test src/b.test.ts — 0 fail' },
      authoredSignal: { command, exitCode: 0, stdout: '1 pass | 0 fail', stderr: '' },
      review: { verdict: 'pass' }, independentlyCheck: defaultSeams().independentlyCheckGoalSlots! })).toBe('filled');
    expect(readFileSync(path, 'utf8')).toContain('관측 — `bun test src/a.test.ts`');
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
        authoredSignal: { command, exitCode: 0, stdout: '12 pass | 0 fail', stderr: '' },
        review: { verdict: 'pass' }, independentlyCheck: check })).toBe('filled');
      const filled = readFileSync(path, 'utf8');
      expect(filled).toContain(authored);
      expect(filled).toContain(`- Condition: ${command}`);
      expect(filled).toContain('gate 검증 — ');
      expect(filled).toContain('이번 라운드 관측값 — exit 0');
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

test('GOAL-SLOT-UNVERIFIABLE-2 · non-test authored condition requires matching successful execution evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-non-test-condition-'));
  const path = join(directory, 'goal.txt');
  const original = `## 불변식
- UNVERIFIABLE

## 판정 신호
- Candidate decision signal:
  - Condition: eslint 통과
`;
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 2,
      gate: { passed: true, log: '[test] PASS bun test src/dashboard/index.test.ts — 0 fail' },
      review: { verdict: 'pass' }, independentlyCheck: async () => true,
      observeDeficit: (deficit) => deficits.push(deficit),
    })).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(deficits[0]).toMatchObject({
      reason: 'authored-signal-command-mismatch',
      reasonDetail: 'authored command has no matching successful execution evidence',
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · executed authored rg signal is independently verified and recorded', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-authored-rg-'));
  const path = join(directory, 'goal.txt');
  const check = defaultSeams().independentlyCheckGoalSlots!;
  const command = 'rg -n 미측정 src/example.md';
  const original = `## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n  - Observation: matching line\n`;
  try {
    writeFileSync(path, original);
    const result = await fillUnverifiableGoalSlots({ path, round: 5,
      gate: { passed: true, log: '[test] PASS bun test src/tg.test.ts — 0 fail' },
      authoredSignal: { command, exitCode: 0, stdout: '12:미측정', stderr: '' },
      review: { verdict: 'warn' }, independentlyCheck: check });
    expect(result).toBe('filled');
    expect(readFileSync(path, 'utf8')).toContain('이번 라운드 관측값 — exit 0');
    expect(readFileSync(path, 'utf8')).toContain('12:미측정');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · authored signal with absent or failing execution remains byte-identical', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-authored-rg-unmeasured-'));
  const path = join(directory, 'goal.txt');
  const command = 'rg -n 미측정 docs/plans/plan.md';
  const original = `## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: ${command}\n`;
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    writeFileSync(path, original);
    for (const authoredSignal of [undefined, { command, exitCode: 1, stdout: '', stderr: 'not found' }]) {
      expect(await fillUnverifiableGoalSlots({ path, round: 6,
        gate: { passed: true, log: '[test] PASS bun test src/tg.test.ts — 0 fail' },
        ...(authoredSignal ? { authoredSignal } : {}), review: { verdict: 'pass' },
        independentlyCheck: defaultSeams().independentlyCheckGoalSlots!, observeDeficit: (d) => deficits.push(d),
      })).toBe('unverifiable');
      expect(readFileSync(path, 'utf8')).toBe(original);
    }
    expect(deficits.every((d) => d.reason === 'authored-signal-command-mismatch')).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · measured gate command may include the authored test among additional files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-covered-signal-'));
  const path = join(directory, 'goal.txt');
  const check = defaultSeams().independentlyCheckGoalSlots!;
  const samples = [
    {
      authored: 'bun test src/dashboard/index.test.ts를 실행한다.',
      measured: 'bun test src/dashboard/index.test.ts',
      runId: 'run-0500d2c5',
    },
    {
      authored: '`bun test src/dashboard/index.test.ts`를 실행한다.',
      measured: 'bun test src/dashboard/index.test.ts',
      runId: 'quoted-condition',
    },
    {
      authored: 'bun test src/self-dev/draft-sweep.test.ts를 실행한다',
      measured: 'bun test src/seat-loop/seat-report.test.ts src/self-dev/draft-sweep.test.ts',
      runId: 'run-8171898a',
    },
    {
      authored: 'bun test src/cli/msg-cli.test.ts',
      measured: 'bun test src/cli/msg-cli.test.ts src/cli/release-cli.test.ts',
      runId: 'run-6e20f879',
    },
  ];
  try {
    for (const sample of samples) {
      const original = `## 불변식\n- UNVERIFIABLE: no measured invariant\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: ${sample.authored}\n  - Observation: gate summary\n  - Expected result: 0 fail\n`;
      writeFileSync(path, original);
      const signalCommand = sample.authored.replace(/^`([^`]+)`(?=\s|를|$)/, '$1').replace(/\s*를\s*실행한다[.。]?$/, '').replace(/[.。]$/, '').trim();
      const deficits: SupervisorGoalDeficit[] = [];
      const result = await fillUnverifiableGoalSlots({ path, round: 3,
        gate: { passed: true, log: `[test] PASS ${sample.measured} — 0 fail | 19 expect() calls` },
        authoredSignal: { command: signalCommand, exitCode: 0, stdout: 'signal observed', stderr: '' },
        review: { verdict: 'pass' }, independentlyCheck: check, observeDeficit: (d) => deficits.push(d) });
      expect(result, sample.runId).toBe('filled');
      const filled = readFileSync(path, 'utf8');
      expect(filled).toContain(`- Condition: ${sample.authored}`);
      expect(filled).toContain(`조건 — ${sample.measured} 가 실패 없이 끝난다`);
      expect(filled).toContain('이번 라운드 관측값 — exit 0');
      expect(filled).toContain('gate 검증 — ');
      expect(filled).not.toContain('UNVERIFIABLE');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GOAL-SLOT-UNVERIFIABLE-2 · mismatch names each authored test file missing from the measured command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-fill-missing-signal-file-'));
  const path = join(directory, 'goal.txt');
  const original = `## 불변식\n- UNVERIFIABLE\n\n## 판정 신호\n- Candidate decision signal:\n  - Condition: bun test src/a.test.ts src/b.test.ts\n`;
  const deficits: SupervisorGoalDeficit[] = [];
  try {
    writeFileSync(path, original);
    expect(await fillUnverifiableGoalSlots({ path, round: 4,
      gate: { passed: true, log: '[test] PASS bun test src/a.test.ts src/c.test.ts — 0 fail' },
      review: { verdict: 'pass' }, independentlyCheck: defaultSeams().independentlyCheckGoalSlots!,
      observeDeficit: (deficit) => deficits.push(deficit) })).toBe('unverifiable');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(deficits[0]).toMatchObject({
      reason: 'authored-signal-command-mismatch',
      reasonDetail: 'authored test file(s) absent from passing gate command: src/b.test.ts',
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
