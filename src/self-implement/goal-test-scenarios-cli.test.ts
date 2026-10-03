import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const directories: string[] = [];
const stateDirectories: string[] = [];
const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BIN = resolve(REPO_ROOT, 'bin/elanous.mjs');

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const directory of stateDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'goal-test-scenarios-cli-'));
  directories.push(directory);
  mkdirSync(join(directory, 'docs', 'goals'), { recursive: true });
  return directory;
}

function writeGoal(directory: string, name: string, document: string, modifiedAt: string): void {
  const path = join(directory, 'docs', 'goals', name);
  writeFileSync(path, document);
  const timestamp = new Date(modifiedAt);
  utimesSync(path, timestamp, timestamp);
}

function runSelfCommand(directory: string, args: string[]) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'goal-test-scenarios-state-'));
  stateDirectories.push(stateDirectory);
  return Bun.spawnSync({
    cmd: [process.execPath, BIN, `--test=${stateDirectory}`, 'self', ...args],
    cwd: directory,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function runScenarios(directory: string, args: string[]) {
  return runSelfCommand(directory, ['goal-test-scenarios', ...args]);
}

function clarification(id: string): string {
  return [
    '- Clarification:',
    `  - id: ${id}`,
    '  - header: Scope',
    '  - question: Choose a scope',
    '  - options:',
    '    - label: A',
    '      description: First scope',
    '  - includeOther: false',
    '  - answer: DEFERRED-UNTIL: Choose a scope',
  ].join('\n');
}

describe('self goal-test-scenarios', () => {
  test('uses the default docs/goals directory in the working directory', () => {
    const directory = createWorkingDirectory();
    writeGoal(directory, 'GOAL-present.md', '---\n- GoalId: 0000000000000001\n## 검증 시나리오\npreserved scenario content\n', '2026-01-01T00:00:00.000Z');
    writeGoal(directory, 'GOAL-empty.md', '---\n- GoalId: 0000000000000002\n## 검증 시나리오\n## Next\n', '2026-01-02T00:00:00.000Z');
    writeGoal(directory, 'GOAL-missing.md', '---\n- GoalId: 0000000000000003\n## Other\nno scenario\n', '2026-01-03T00:00:00.000Z');
    const goals = realpathSync(join(directory, 'docs', 'goals'));

    const human = runScenarios(directory, ['--limit', '3']);
    expect(human.exitCode, human.stderr.toString()).toBe(0);
    expect(human.stdout.toString()).toBe([
      'summary: 3 goal documents viewed; 2 with ## 검증 시나리오',
      '',
      `0000000000000003 · ${join(goals, 'GOAL-missing.md')}\n검증 시나리오: 없음`,
      '',
      `0000000000000002 · ${join(goals, 'GOAL-empty.md')}\n검증 시나리오: 비어 있음`,
      '',
      `0000000000000001 · ${join(goals, 'GOAL-present.md')}\n검증 시나리오:\npreserved scenario content\n`,
      '',
    ].join('\n'));

    const json = runScenarios(directory, ['--limit', '2', '--json']);
    expect(json.exitCode, json.stderr.toString()).toBe(0);
    expect(JSON.parse(json.stdout.toString())).toEqual({
      viewedGoalCount: 2,
      sectionPresentCount: 1,
      samples: [
        { path: join(goals, 'GOAL-missing.md'), goalId: '0000000000000003', scenario: null },
        { path: join(goals, 'GOAL-empty.md'), goalId: '0000000000000002', scenario: '' },
      ],
    });
  }, 60_000);

  test('uses an explicitly selected goal directory outside the working directory', () => {
    const goalsDirectory = createWorkingDirectory();
    writeGoal(goalsDirectory, 'GOAL-selected.md', '---\n- GoalId: 0000000000000004\n## 검증 시나리오\nselected directory scenario\n', '2026-01-01T00:00:00.000Z');
    const emptyWorkingDirectory = createWorkingDirectory();
    const selectedGoals = realpathSync(join(goalsDirectory, 'docs', 'goals'));

    const selected = runScenarios(emptyWorkingDirectory, ['--dir', selectedGoals, '--json']);
    expect(selected.exitCode, selected.stderr.toString()).toBe(0);
    expect(JSON.parse(selected.stdout.toString())).toEqual({
      viewedGoalCount: 1,
      sectionPresentCount: 1,
      samples: [{ path: join(selectedGoals, 'GOAL-selected.md'), goalId: '0000000000000004', scenario: 'selected directory scenario\n' }],
    });

    const defaultDirectory = runScenarios(emptyWorkingDirectory, ['--json']);
    expect(defaultDirectory.exitCode, defaultDirectory.stderr.toString()).toBe(0);
    expect(JSON.parse(defaultDirectory.stdout.toString())).toEqual({ viewedGoalCount: 0, sectionPresentCount: 0, samples: [] });
  }, 60_000);

  test('resolves a relative --dir against the isolated working directory before reporting paths', () => {
    const directory = createWorkingDirectory();
    const relativeGoals = join('nested', 'goals');
    mkdirSync(join(directory, relativeGoals), { recursive: true });
    writeFileSync(join(directory, relativeGoals, 'GOAL-relative.md'), '---\n- GoalId: 0000000000000005\n## 검증 시나리오\nrelative directory scenario\n');
    const expectedGoals = realpathSync(join(directory, relativeGoals));

    const selected = runScenarios(directory, ['--dir', relativeGoals, '--json']);
    expect(selected.exitCode, selected.stderr.toString()).toBe(0);
    expect(JSON.parse(selected.stdout.toString())).toEqual({
      viewedGoalCount: 1,
      sectionPresentCount: 1,
      samples: [{ path: join(expectedGoals, 'GOAL-relative.md'), goalId: '0000000000000005', scenario: 'relative directory scenario\n' }],
    });
  }, 60_000);

  test('reports a missing explicitly selected goal directory as a failure', () => {
    const directory = createWorkingDirectory();
    const missingDirectory = join(directory, 'missing-goals');

    const missing = runScenarios(directory, ['--dir', missingDirectory]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain('unable to sample goal test scenarios:');
    expect(missing.stderr.toString()).toContain(missingDirectory);
  }, 60_000);

  test('ledger lint resolves a relative --dir directory before reporting ledger paths', () => {
    const directory = createWorkingDirectory();
    const relativeLedger = join('nested', 'harness');
    const issuesDirectory = join(directory, relativeLedger);
    mkdirSync(issuesDirectory, { recursive: true });
    writeFileSync(join(issuesDirectory, 'ISSUES.md'), [
      '### F-1 sample failure **open**',
      '**근본**: root cause',
      '**근거**: evidence',
      'Links I-1',
      '### I-1 sample fix **fixed**',
      '**근본**: root cause',
      '**근거**: evidence',
      'Fixes F-1',
      '### missing status',
      '**근본**: root cause',
      '**근거**: evidence',
      'Links F-1',
      '',
    ].join('\n'));
    const expectedIssues = realpathSync(join(issuesDirectory, 'ISSUES.md'));

    const result = runSelfCommand(directory, ['ledger', 'lint', '--dir', relativeLedger]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain(`${expectedIssues}:missing status status-vocab`);
    expect(result.stdout.toString()).toContain('summary total=3 status-vocab=1 four-lines=0 linkage=0 violations=1 unremediated=0');
    expect(result.stdout.toString().split('\n').some((line) => line.startsWith(`${relativeLedger}:missing status`))).toBe(false);

    const fileResult = runSelfCommand(directory, ['ledger', 'lint', '--dir', join(relativeLedger, 'ISSUES.md')]);
    expect(fileResult.exitCode, fileResult.stderr.toString()).toBe(0);
    expect(fileResult.stdout.toString()).toContain(`${expectedIssues}:missing status status-vocab`);
    expect(fileResult.stdout.toString().split('\n').some((line) => line.startsWith(`${join(relativeLedger, 'ISSUES.md')}:missing status`))).toBe(false);
  }, 60_000);

  test('clarify pending resolves a relative --dir before reporting pending goal paths', () => {
    const directory = createWorkingDirectory();
    const relativeGoals = join('nested', 'goals');
    const goalsDirectory = join(directory, relativeGoals);
    mkdirSync(goalsDirectory, { recursive: true });
    writeFileSync(join(goalsDirectory, 'GOAL-pending.md'), `# Pending\n${clarification('relative-pending')}\n`);
    const expectedGoals = realpathSync(goalsDirectory);

    const result = runSelfCommand(directory, ['clarify', 'pending', '--dir', relativeGoals]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const rows = result.stdout.toString().trim().split('\n');
    expect(rows).toContain(`${join(expectedGoals, 'GOAL-pending.md')}: 1 pending — relative-pending — run: no-record`);
    expect(rows.at(-1)).toContain('summary: 1 goal documents scanned; 1 with unanswered clarifications');
  }, 60_000);

  test('clarify closure resolves a relative --dir before collecting follow-up documents', () => {
    const directory = createWorkingDirectory();
    const relativeRoot = 'nested';
    const relativeGoals = join(relativeRoot, 'docs', 'goals');
    const goalsDirectory = join(directory, relativeGoals);
    mkdirSync(goalsDirectory, { recursive: true });
    writeFileSync(join(goalsDirectory, 'GOAL-parent.md'), '# Parent\n');
    writeFileSync(join(goalsDirectory, 'GOAL-child.md'), [
      '# Child',
      clarification('child-pending'),
      '- Parent: {"goalFile":"docs/goals/GOAL-parent.md","questionId":"parent-question"}',
      '',
    ].join('\n'));

    const result = runSelfCommand(directory, ['clarify', 'closure', 'docs/goals/GOAL-parent.md', '--dir', relativeGoals]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe([
      'start: docs/goals/GOAL-parent.md: 0 pending (excluded from follow-up closure)',
      'docs/goals/GOAL-child.md: 1 pending',
      'total: 2 documents (1 start, 1 follow-ups), 1 pending — open',
      '',
    ].join('\n'));
    expect(readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf8')).toContain('collectGoalClarificationClosure(goalFile, resolveCliDirOption(opts.dir))');
  }, 60_000);
});
