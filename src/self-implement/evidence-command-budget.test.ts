import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorGoal, type GoalAuthorDeps } from './goal-author.js';
import { EVIDENCE_TEST_MAX_BYTES, focusedEvidenceTestPath, narrowerEvidenceCommand, resolveEvidenceHeadCommit } from './evidence-command-budget.js';
import { createRequiredEvidenceBudget, requiredEvidenceFromGoal, runRequiredEvidenceChecks, settleUncoveredEvidence } from './off-diff-evidence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'evidence-command-budget-'));
  roots.push(root);
  const dir = join(root, 'src', 'self-implement');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orchestrator.ts'), 'export const run = () => 1;\n');
  writeFileSync(join(dir, 'orchestrator.test.ts'), 'x'.repeat(EVIDENCE_TEST_MAX_BYTES + 1));
  writeFileSync(join(dir, 'orchestrator-focused.test.ts'), "import { run } from './orchestrator.js';\n");
  writeFileSync(join(dir, 'orchestrator-unrelated.test.ts'), "import { run } from './other.js';\n");
  return root;
}

test('author uses a small direct-import test instead of the 120s+ orchestrator sibling', async () => {
  const root = fixture();
  const target = 'src/self-implement/orchestrator.ts';
  expect(focusedEvidenceTestPath(target, root)).toBe('src/self-implement/orchestrator-focused.test.ts');
  const deps: GoalAuthorDeps = {
    repositoryRoot: root,
    ground: async () => ({ grounded: true, context: '', files: [target], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
    enhance: async (original) => ({ original, checklist: ['repair the target'], verbatimPreserved: true }),
    slugFn: async () => 'evidence-budget',
  };
  const goal = await authorGoal(`Repair ${target}`, deps);
  expect(goal.document).toContain("|| bun test -- 'src/self-implement/orchestrator-focused.test.ts'");
  expect(goal.document).not.toContain("|| bun test -- 'src/self-implement/orchestrator.test.ts'");
});

test('author keeps a declared sibling command when the test is not created yet', () => {
  const root = fixture();
  rmSync(join(root, 'src', 'self-implement', 'orchestrator.test.ts'));
  expect(focusedEvidenceTestPath('src/self-implement/orchestrator.ts', root)).toBe('src/self-implement/orchestrator.test.ts');
});

test('a comment or string mentioning the target is not direct-import evidence', () => {
  const root = fixture();
  rmSync(join(root, 'src', 'self-implement', 'orchestrator-focused.test.ts'));
  writeFileSync(join(root, 'src', 'self-implement', 'orchestrator-unrelated.test.ts'),
    "// import { run } from './orchestrator.js'\nconst example = \"./orchestrator.js\";\n");
  expect(focusedEvidenceTestPath('src/self-implement/orchestrator.ts', root)).toBeNull();
});

test('a type-only import cannot stand in for runtime evidence', () => {
  const root = fixture();
  writeFileSync(join(root, 'src', 'self-implement', 'orchestrator-focused.test.ts'),
    "import type { run } from './orchestrator.js';\nexpect(typeof run).toBe('function');\n");
  expect(focusedEvidenceTestPath('src/self-implement/orchestrator.ts', root)).toBeNull();
});

test('a small symlinked sibling remains the focused evidence command', () => {
  const root = fixture();
  const dir = join(root, 'src', 'self-implement');
  rmSync(join(dir, 'orchestrator.test.ts'));
  writeFileSync(join(dir, 'orchestrator-real.test.ts'), "import { run } from './orchestrator.js';\nexpect(run()).toBe(1);\n");
  symlinkSync('orchestrator-real.test.ts', join(dir, 'orchestrator.test.ts'));
  expect(focusedEvidenceTestPath('src/self-implement/orchestrator.ts', root)).toBe('src/self-implement/orchestrator.test.ts');
});

test('a small linked direct-import candidate is measured by its target and selectable', () => {
  const root = fixture();
  const dir = join(root, 'src', 'self-implement');
  rmSync(join(dir, 'orchestrator-focused.test.ts'));
  writeFileSync(join(dir, 'underlying.test.ts'), "import { run } from './orchestrator.js';\nexpect(run()).toBe(1);\n");
  symlinkSync('underlying.test.ts', join(dir, 'orchestrator-linked.test.ts'));
  expect(focusedEvidenceTestPath('src/self-implement/orchestrator.ts', root)).toBe('src/self-implement/orchestrator-linked.test.ts');
});

test('a shell metacharacter in a candidate filename cannot become a replacement command', () => {
  const root = fixture();
  rmSync(join(root, 'src', 'self-implement', 'orchestrator-focused.test.ts'));
  writeFileSync(join(root, 'src', 'self-implement', "orchestrator-'; echo unsafe.test.ts"),
    "import { run } from './orchestrator.js';\n");
  expect(narrowerEvidenceCommand("bun test -- 'src/self-implement/orchestrator.test.ts'", root)).toBeNull();
});

test('after two timeouts the original heavy command is replaced once and observed', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const timeoutCounts = new Map<string, number>();
  const calls: string[] = [];
  const run = (command: string) => {
    calls.push(command);
    return command === heavy
      ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
      : { status: 0, stdout: '', stderr: '1 pass\n0 fail\n', error: undefined };
  };
  let third = runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  third = runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  third = runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  expect(calls).toEqual([heavy, heavy, "bun test -- 'src/self-implement/orchestrator-focused.test.ts'"]);
  expect(timeoutCounts.size).toBe(1);
  expect(third[0]?.command).toBe(heavy);
  expect(third[0]?.executedCommand).toBe("bun test -- 'src/self-implement/orchestrator-focused.test.ts'");
  expect(third[0]?.substitutedFor).toBe(heavy);
  expect(settleUncoveredEvidence(['requested'], { checks: third, required: requiredEvidenceFromGoal(goal) }).uncovered).toEqual(['requested']);
  runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  expect(calls[3]).toBe("bun test -- 'src/self-implement/orchestrator-focused.test.ts'");
});

test('required evidence decodes injected runner Buffer output before truncation and verdict', () => {
  const goal = '## REQUIRED EVIDENCE\n- [requested] focused check || bun test focused.test.ts';
  const [run] = runRequiredEvidenceChecks(goal, '.', 'buffer-run', { run: () => ({
    status: 0,
    stdout: Buffer.from('caf\u00e9', 'utf8'),
    stderr: Buffer.from('1 pass\n0 fail\n', 'utf8'),
    error: undefined,
  }) });
  expect(run?.stdout).toBe('caf\u00e9');
  expect(run?.stderr).toBe('1 pass\n0 fail\n');
  expect(settleUncoveredEvidence(['requested'], { checks: [run!], required: requiredEvidenceFromGoal(goal) }).uncovered).toEqual([]);
});

test('without a narrow direct importer a third expensive retry is suppressed', () => {
  const root = fixture();
  rmSync(join(root, 'src', 'self-implement', 'orchestrator-focused.test.ts'));
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const timeoutCounts = new Map<string, number>();
  const calls: string[] = [];
  const run = (command: string) => {
    calls.push(command);
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  };
  for (let i = 0; i < 2; i++) runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  const [third] = runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  expect(calls).toEqual([heavy, heavy]);
  expect(third?.command).toBe(heavy);
  expect(third?.stderr).toContain('no further identical test run');
});

test('the narrower replacement also stops after two timeouts', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const narrow = "bun test -- 'src/self-implement/orchestrator-focused.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const timeoutCounts = new Map<string, number>();
  const calls: string[] = [];
  const run = (command: string) => {
    calls.push(command);
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  };
  for (let i = 0; i < 5; i++) runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  expect(calls).toEqual([heavy, heavy, narrow, narrow]);
});

test('timeout budget is scoped by exact head and command', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const other = "bun test -- 'src/self-implement/another.test.ts'";
  const timeoutCounts = new Map<string, number>();
  const calls: string[] = [];
  const run = (command: string) => {
    calls.push(command);
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  };
  const runGoal = (command: string, headCommit: string) => runRequiredEvidenceChecks(`## REQUIRED EVIDENCE\n- [requested] target check || ${command}`, root, 'budget-run', { timeoutCounts, headCommit, run });
  runGoal(heavy, 'head-a');
  runGoal(heavy, 'head-a');
  runGoal(heavy, 'head-b');
  runGoal(other, 'head-a');
  expect(calls).toEqual([heavy, heavy, heavy, other]);
});

test('an unresolved head has a timeout cap within one run but no cross-run pooling', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const calls: string[] = [];
  const runBudgetedEvidenceChecks = createRequiredEvidenceBudget({ run: (command) => {
    calls.push(command);
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  } });
  for (let i = 0; i < 3; i++) runBudgetedEvidenceChecks(goal, root, 'budget-run', undefined);
  expect(calls).toEqual([heavy, heavy, "bun test -- 'src/self-implement/orchestrator-focused.test.ts'"]);
  runBudgetedEvidenceChecks(goal, root, 'budget-run', 'head-a');
  expect(calls[3]).toBe(heavy);
  const independentRun = createRequiredEvidenceBudget({ run: (command) => {
    calls.push(command);
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  } });
  independentRun(goal, root, 'another-run', undefined);
  expect(calls[4]).toBe(heavy);
});

test('the orchestrator budget starts over when the observed head changes', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const narrow = "bun test -- 'src/self-implement/orchestrator-focused.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const calls: string[] = [];
  const runBudgetedEvidenceChecks = createRequiredEvidenceBudget({ run: (command) => {
    calls.push(command);
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  } });
  runBudgetedEvidenceChecks(goal, root, 'budget-run', 'head-a');
  runBudgetedEvidenceChecks(goal, root, 'budget-run', 'head-a');
  runBudgetedEvidenceChecks(goal, root, 'budget-run', 'head-b');
  runBudgetedEvidenceChecks(goal, root, 'budget-run', 'head-b');
  runBudgetedEvidenceChecks(goal, root, 'budget-run', 'head-b');
  expect(calls).toEqual([heavy, heavy, heavy, heavy, narrow]);
});

test('a successful run between two timeouts does not reset the same command budget', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const narrow = "bun test -- 'src/self-implement/orchestrator-focused.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const calls: string[] = [];
  const timeoutCounts = new Map<string, number>();
  const run = (command: string) => {
    calls.push(command);
    return calls.length === 2
      ? { status: 0, stdout: '', stderr: '1 pass\n0 fail\n', error: undefined }
      : { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
  };
  for (let i = 0; i < 4; i++) runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  expect(calls).toEqual([heavy, heavy, heavy, narrow]);
});

test('an intervening non-timeout failure does not erase a measured timeout on the same head', () => {
  const root = fixture();
  const heavy = "bun test -- 'src/self-implement/orchestrator.test.ts'";
  const goal = `## REQUIRED EVIDENCE\n- [requested] target check || ${heavy}`;
  const timeoutCounts = new Map<string, number>();
  const calls: string[] = [];
  const run = (command: string) => {
    calls.push(command);
    if (calls.length === 2) return { status: 1, stdout: '', stderr: 'assertion failure', error: undefined };
    return command === heavy
      ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
      : { status: 0, stdout: '', stderr: '1 pass\n0 fail\n', error: undefined };
  };
  for (let i = 0; i < 4; i++) runRequiredEvidenceChecks(goal, root, 'budget-run', { timeoutCounts, headCommit: 'head-a', run });
  expect(calls).toEqual([heavy, heavy, heavy, "bun test -- 'src/self-implement/orchestrator-focused.test.ts'"]);
});

test('empty head seam falls back to the observed HEAD before budgeting', () => {
  let reads = 0;
  expect(resolveEvidenceHeadCommit('  ', () => { reads++; return ' head-b '; })).toBe('head-b');
  expect(reads).toBe(1);
  expect(resolveEvidenceHeadCommit(' head-a ', () => { reads++; return 'head-b'; })).toBe('head-a');
  expect(reads).toBe(1);
  expect(resolveEvidenceHeadCommit(undefined, () => '')).toBeUndefined();
});
