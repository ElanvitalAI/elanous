import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseGoalDocumentClarifications } from '../src/self-implement/goal-author-clarification.js';
import { GoalRunStore } from '../src/self-implement/goal-run-store.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const temporaryDirectories: string[] = [];

function goalDocument(answer = 'DEFERRED-UNTIL: choose one'): string {
  return `## PROBLEM
- Clarification:
  - id: target
  - header: Target
  - question: Which target?
  - options:
    - label: First option
      description: First description
    - label: Second option
      description: Second description
  - includeOther: true
  - answer: ${answer}

- Clarification:
  - id: already_answered
  - header: Existing
  - question: Keep this answer.
  - options:
    - label: Keep
      description: Keep it
    - label: Replace
      description: Do not replace it
  - includeOther: false
  - answer: Keep

## WHAT TO BUILD
Unchanged section.
`;
}

function run(...args: string[]) {
  return runWithState(join(tmpdir(), `goal-author-clarify-state-${crypto.randomUUID()}`), ...args);
}

function runWithState(stateDir: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: ['bun', 'bin/elanous.mjs', `--test=${stateDir}`, 'self', 'clarify', ...args],
    cwd: process.cwd(),
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function pendingSummary(scanned: number, withUnansweredClarifications: number): string {
  return `summary: ${scanned} goal documents scanned; ${withUnansweredClarifications} with unanswered clarifications — this lists records written in goal documents, not live waits; live waits: questions pending`;
}

function answeredGoalDocument(answer: string): string {
  return goalDocument(answer).replace(`  - answer: ${answer}\n`, `  - answer: ${answer}\n  - provenance.source: injected\n`);
}

function groupedPendingLines(nowAnswerable: readonly string[], past: readonly string[], summary: string): string[] {
  return ['now answerable:', ...nowAnswerable, 'past:', ...past, summary];
}

function displayedGoalPath(path: string): string {
  return relative(process.cwd(), path) || '.';
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'goal-author-clarify-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'GOAL-test.txt');
  writeFileSync(path, goalDocument());
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('self clarify CLI', () => {
  test('lists only pending clarifications and injects one answer without changing other sections', () => {
    const path = fixture();

    const listed = run('list', path);
    expect(listed.exitCode).toBe(0);
    expect(text(listed.stdout)).toContain('id: target');
    expect(text(listed.stdout)).toContain('option: First option — First description');
    expect(text(listed.stdout)).toContain('includeOther: true');
    expect(text(listed.stdout)).not.toContain('already_answered');

    const answered = run('answer', path, 'target', '1');
    expect(answered.exitCode).toBe(0);
    expect(text(answered.stdout)).toContain('answered: target');
    expect(readFileSync(path, 'utf8')).toBe(answeredGoalDocument('Second option'));
  });

  test('lists only documents with pending clarifications across a directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-author-clarify-pending-'));
    temporaryDirectories.push(directory);
    const pendingPath = join(directory, 'GOAL-pending.md');
    const secondPendingPath = join(directory, 'GOAL-second-pending.md');
    const answeredPath = join(directory, 'GOAL-answered.md');
    const ignoredPath = join(directory, 'notes.txt');
    const pendingDocument = `${goalDocument()}\n- Clarification:\n  - id: second_pending\n  - header: Second\n  - question: Choose the second target.\n  - options:\n    - label: Alpha\n      description: Alpha description\n    - label: Beta\n      description: Beta description\n  - includeOther: false\n  - answer: DEFERRED-UNTIL: choose another\n`;
    const answeredDocument = goalDocument('First option');
    writeFileSync(pendingPath, pendingDocument);
    writeFileSync(secondPendingPath, goalDocument());
    writeFileSync(answeredPath, answeredDocument);
    writeFileSync(ignoredPath, pendingDocument);

    const stateDir = join(directory, 'state');
    const result = runWithState(stateDir, 'pending', '--dir', directory);

    expect(result.exitCode).toBe(0);
    const lines = text(result.stdout).trim().split('\n').filter(Boolean);
    expect(lines).toEqual(groupedPendingLines([
      `${displayedGoalPath(pendingPath)}: 2 pending — target, second_pending — run: no-record`,
      `${displayedGoalPath(secondPendingPath)}: 1 pending — target — run: no-record`,
    ], [], `${pendingSummary(3, 2)} — scope: population goal-run-store path=${join(stateDir, 'self-implement', 'goal-runs.db')} records=0 state=missing; unfinished-run-ledger directory=${join(stateDir, 'run-ledger')} entries=0 state=missing`));
    expect(lines.at(-1)).toStartWith(pendingSummary(3, 2));

    for (const equivalentDirectory of [`${directory}/`, `./${relative(process.cwd(), directory)}`, directory]) {
      const equivalent = runWithState(stateDir, 'pending', '--dir', equivalentDirectory);
      expect(equivalent.exitCode).toBe(0);
      expect(text(equivalent.stdout)).toBe(text(result.stdout));
    }
    expect(text(result.stdout)).not.toContain(answeredPath);
    expect(readFileSync(pendingPath, 'utf8')).toBe(pendingDocument);
    expect(readFileSync(answeredPath, 'utf8')).toBe(answeredDocument);

    writeFileSync(pendingPath, answeredDocument);
    writeFileSync(secondPendingPath, answeredDocument);
    const empty = run('pending', '--dir', directory);
    expect(empty.exitCode).toBe(0);
    expect(text(empty.stdout).trim().split('\n')).toEqual(groupedPendingLines([], [], pendingSummary(3, 0)));
  });

  test('prints both empty partitions before the final zero summary when the directory has no goal documents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-author-clarify-empty-'));
    temporaryDirectories.push(directory);

    const result = run('pending', '--dir', directory);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).trim().split('\n')).toEqual(groupedPendingLines([], [], pendingSummary(0, 0)));
  });

  test('renders finished and unfinished latest run status columns without changing pending rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-author-clarify-run-status-'));
    temporaryDirectories.push(directory);
    const finished = join(directory, 'GOAL-finished.md');
    const unfinished = join(directory, 'GOAL-unfinished.md');
    writeFileSync(finished, goalDocument());
    writeFileSync(unfinished, goalDocument());
    const stateDir = join(directory, 'state');
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    const store = new GoalRunStore(databasePath);
    try {
      store.insert(finished, {
        runId: 'run-finished', stage: 'pr-opened', outcome: 'completed', ok: true,
        startedAt: '2026-08-10T00:00:00.000Z', rounds: 1, model: 'test-model',
      }, 'goal-finished');
    } finally {
      store.close();
    }
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const unfinishedRunId = 'run-11111111-1111-4111-8111-111111111111';
    writeFileSync(join(ledgerDir, `${unfinishedRunId}.jsonl`), `${JSON.stringify({
      timestamp: '2026-08-11T00:00:00.000Z', runId: unfinishedRunId, event: 'start', data: { goalFile: unfinished },
    })}\n`);

    const result = runWithState(stateDir, 'pending', '--dir', directory);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).trim().split('\n')).toEqual(groupedPendingLines([
      `${displayedGoalPath(unfinished)}: 1 pending — target — run: unfinished`,
    ], [
      `${displayedGoalPath(finished)}: 1 pending — target — run: finished (completed)`,
    ], pendingSummary(2, 2)));
  });

  test('keeps every pending row and marks status unavailable when the run store cannot open', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-author-clarify-unavailable-'));
    temporaryDirectories.push(directory);
    const first = join(directory, 'GOAL-first.md');
    const second = join(directory, 'GOAL-second.md');
    writeFileSync(first, goalDocument());
    writeFileSync(second, goalDocument());
    const stateDir = join(directory, 'state');
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    mkdirSync(databasePath, { recursive: true });

    const result = runWithState(stateDir, 'pending', '--dir', directory);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).trim().split('\n')).toEqual(groupedPendingLines([
      `${displayedGoalPath(first)}: 1 pending — target — run: unavailable`,
      `${displayedGoalPath(second)}: 1 pending — target — run: unavailable`,
    ], [], pendingSummary(2, 2)));
  });

  test('keeps every pending row and marks status unavailable when an opened store query fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-author-clarify-query-unavailable-'));
    temporaryDirectories.push(directory);
    const first = join(directory, 'GOAL-first.md');
    writeFileSync(first, goalDocument());
    const stateDir = join(directory, 'state');
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    mkdirSync(join(stateDir, 'self-implement'), { recursive: true });
    writeFileSync(databasePath, '');

    const result = runWithState(stateDir, 'pending', '--dir', directory);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).trim().split('\n')).toEqual(groupedPendingLines([
      `${displayedGoalPath(first)}: 1 pending — target — run: unavailable`,
    ], [], pendingSummary(1, 1)));
  });

  test('reports one start and two follow-ups from the same follow-up population, then closes when their pending questions are answered', () => {
    const repository = mkdtempSync(join(tmpdir(), 'goal-author-closure-repository-'));
    temporaryDirectories.push(repository);
    const goals = join(repository, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const ancestor = join(goals, 'GOAL-ancestor.txt');
    const start = join(goals, 'GOAL-start.txt');
    const childOpen = join(goals, 'GOAL-child-open.txt');
    const childClosed = join(goals, 'GOAL-child-closed.txt');
    const sibling = join(goals, 'GOAL-sibling.txt');
    const parentLine = (path: string) => `- Parent: ${JSON.stringify({ goalFile: relative(repository, path).replaceAll('\\', '/'), questionId: 'target' })}\n`;
    writeFileSync(ancestor, goalDocument('answered'));
    writeFileSync(start, `${parentLine(ancestor)}${goalDocument('DEFERRED-UNTIL: start remains unresolved')}`);
    writeFileSync(childOpen, `${parentLine(start)}${goalDocument()}`);
    writeFileSync(childClosed, `${parentLine(start)}${goalDocument('answered')}`);
    writeFileSync(sibling, `${parentLine(ancestor)}${goalDocument()}`);

    const goalFile = relative(repository, start).replaceAll('\\', '/');
    const open = run('closure', goalFile, '--dir', goals);
    const openLines = text(open.stdout).trim().split('\n');

    expect(open.exitCode).toBe(0);
    expect(openLines).toEqual([
      `start: ${goalFile}: 1 pending (excluded from follow-up closure)`,
      `${relative(repository, childClosed).replaceAll('\\', '/')}: 0 pending`,
      `${relative(repository, childOpen).replaceAll('\\', '/')}: 1 pending`,
      'total: 3 documents (1 start, 2 follow-ups), 1 pending — open',
    ]);
    expect(openLines.slice(1, -1).reduce((sum, line) => sum + Number(/: (\d+) pending$/.exec(line)?.[1] ?? 0), 0)).toBe(1);
    expect(text(open.stdout)).not.toContain('GOAL-ancestor.txt');
    expect(text(open.stdout)).not.toContain('GOAL-sibling.txt');

    const cwdDecoy = join(repository, 'cwd-decoy');
    mkdirSync(cwdDecoy);
    writeFileSync(join(cwdDecoy, 'GOAL-start.txt'), goalDocument());
    const fromDifferentCwd = Bun.spawnSync({
      cmd: ['bun', join(process.cwd(), 'bin', 'elanous.mjs'), `--test=${join(repository, '.elanous-test')}`, 'self', 'clarify', 'closure', goalFile, '--dir', goals],
      cwd: cwdDecoy,
      env: { ...process.env, ELANOUS_STATE_DIR: join(tmpdir(), `goal-author-closure-state-${crypto.randomUUID()}`) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(fromDifferentCwd.exitCode).toBe(0);
    expect(text(fromDifferentCwd.stdout)).toBe(text(open.stdout));

    writeFileSync(childOpen, readFileSync(childOpen, 'utf8').replace('DEFERRED-UNTIL: choose one', 'First option'));
    const closed = run('closure', goalFile, '--dir', goals);
    expect(closed.exitCode).toBe(0);
    expect(text(closed.stdout)).toContain('total: 3 documents (1 start, 2 follow-ups), 0 pending — closed');
  });

  test('uses repository-relative provenance in a custom directory and recursively finds nested follow-ups', () => {
    const repository = mkdtempSync(join(tmpdir(), 'goal-author-custom-closure-repository-'));
    temporaryDirectories.push(repository);
    const goals = join(repository, 'custom-goal-store');
    const nested = join(goals, 'nested');
    mkdirSync(nested, { recursive: true });
    const start = join(goals, 'GOAL-start.txt');
    const child = join(goals, 'GOAL-child.txt');
    const grandchild = join(nested, 'GOAL-grandchild.txt');
    const parentLine = (path: string) => `- Parent: ${JSON.stringify({ goalFile: relative(repository, path).replaceAll('\\', '/'), questionId: 'target' })}\n`;
    writeFileSync(start, goalDocument('DEFERRED-UNTIL: start remains unresolved'));
    writeFileSync(child, `${parentLine(start)}${goalDocument('answered')}`);
    writeFileSync(grandchild, `${parentLine(child)}${goalDocument('answered')}`);

    const goalFile = relative(repository, start).replaceAll('\\', '/');
    const result = run('closure', goalFile, '--dir', goals);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout).trim().split('\n')).toEqual([
      `start: ${goalFile}: 1 pending (excluded from follow-up closure)`,
      `${relative(repository, child).replaceAll('\\', '/')}: 0 pending`,
      `${relative(repository, grandchild).replaceAll('\\', '/')}: 0 pending`,
      'total: 3 documents (1 start, 2 follow-ups), 0 pending — closed',
    ]);
  });

  test('keeps the closure closed when only the start goal is pending', () => {
    const repository = mkdtempSync(join(tmpdir(), 'goal-author-start-pending-closure-'));
    temporaryDirectories.push(repository);
    const goals = join(repository, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const start = join(goals, 'GOAL-start.txt');
    const child = join(goals, 'GOAL-child.txt');
    const parentLine = `- Parent: ${JSON.stringify({ goalFile: relative(repository, start).replaceAll('\\', '/'), questionId: 'target' })}\n`;
    writeFileSync(start, goalDocument());
    writeFileSync(child, `${parentLine}${goalDocument('answered')}`);

    const result = run('closure', relative(repository, start).replaceAll('\\', '/'), '--dir', goals);

    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain('total: 2 documents (1 start, 1 follow-ups), 0 pending — closed');
  });

  test('terminates a cyclic follow-up graph and rejects a missing start goal', () => {
    const repository = mkdtempSync(join(tmpdir(), 'goal-author-closure-cycle-'));
    temporaryDirectories.push(repository);
    const goals = join(repository, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const first = join(goals, 'GOAL-first.txt');
    const second = join(goals, 'GOAL-second.txt');
    const parentLine = (path: string) => `- Parent: ${JSON.stringify({ goalFile: relative(repository, path).replaceAll('\\', '/'), questionId: 'target' })}\n`;
    writeFileSync(first, `${parentLine(second)}${goalDocument('answered')}`);
    writeFileSync(second, `${parentLine(first)}${goalDocument()}`);

    const start = relative(repository, first).replaceAll('\\', '/');
    const cyclic = run('closure', start, '--dir', goals);
    expect(cyclic.exitCode).toBe(0);
    expect(text(cyclic.stdout)).toContain('total: 2 documents (1 start, 1 follow-ups), 1 pending — open');

    const missing = run('closure', 'docs/goals/GOAL-missing.txt', '--dir', goals);
    expect(missing.exitCode).not.toBe(0);
    expect(`${text(missing.stdout)}${text(missing.stderr)}`).toContain('closure goal file not found: docs/goals/GOAL-missing.txt');
  });

  test('injects a free-form answer into an includeOther clarification without changing other content', () => {
    const path = fixture();
    const before = readFileSync(path, 'utf8');
    const freeFormAnswer = 'test/goal-author-clarify-cli.test.ts';

    const answered = run('answer', path, 'target', '--other', freeFormAnswer);

    expect(answered.exitCode).toBe(0);
    const updated = readFileSync(path, 'utf8');
    expect(updated).toBe(answeredGoalDocument(freeFormAnswer));
    expect(updated
      .replace(`  - answer: ${freeFormAnswer}`, '  - answer: DEFERRED-UNTIL: choose one')
      .replace('  - provenance.source: injected\n', '')).toBe(before);
    expect(parseGoalDocumentClarifications(updated).map(({ questionId, answer, answered: isAnswered }) => ({ questionId, answer, answered: isAnswered }))).toEqual([
      { questionId: 'target', answer: freeFormAnswer, answered: true },
      { questionId: 'already_answered', answer: 'Keep', answered: true },
    ]);
  });

  test('rejects free-form answers when disallowed, empty, reserved, or combined with an option without changing the document', () => {
    const path = fixture();
    const original = readFileSync(path, 'utf8');

    for (const [args, message] of [
      [['answer', path, 'already_answered', '--other', 'replacement'], 'goal clarification already answered: already_answered'],
      [['answer', path, 'target', '--other', '   '], 'free-form clarification answer must be non-empty'],
      [['answer', path, 'target', '--other', 'DEFERRED-UNTIL: still pending'], 'clarification answer must not use reserved unresolved status: DEFERRED-UNTIL:'],
      [['answer', path, 'target', '0', '--other', 'replacement'], 'specify either an option index or --other, not both'],
    ] as const) {
      const result = run(...args);
      expect(result.exitCode).not.toBe(0);
      expect(text(result.stdout)).not.toContain('answered: target');
      expect(`${text(result.stdout)}${text(result.stderr)}`).toContain(message);
      expect(readFileSync(path, 'utf8')).toBe(original);
    }

    const disallowed = goalDocument().replace('  - includeOther: true', '  - includeOther: false');
    writeFileSync(path, disallowed);
    const result = run('answer', path, 'target', '--other', 'replacement');
    expect(result.exitCode).not.toBe(0);
    expect(`${text(result.stdout)}${text(result.stderr)}`).toContain('goal clarification does not allow a free-form answer: target');
    expect(readFileSync(path, 'utf8')).toBe(disallowed);
  });

  test('rejects missing, duplicate, answered, and malformed answers without changing the document', () => {
    const path = fixture();
    const original = readFileSync(path, 'utf8');

    for (const [questionId, optionIndex, message] of [
      ['missing', '0', 'goal clarification not found: missing'],
      ['already_answered', '1', 'goal clarification already answered: already_answered'],
      ['target', 'x', 'goal clarification option index must be a non-negative integer: x'],
      ['target', '2', 'goal clarification option index out of range: 2'],
    ]) {
      const result = run('answer', path, questionId, optionIndex);
      expect(result.exitCode).not.toBe(0);
      expect(`${text(result.stdout)}${text(result.stderr)}`).toContain(message);
      expect(readFileSync(path, 'utf8')).toBe(original);
    }

    writeFileSync(path, `${original}\n- Clarification:\n  - id: target\n  - header: Duplicate\n  - question: Duplicate target.\n  - options:\n    - label: One\n      description: One\n    - label: Two\n      description: Two\n  - includeOther: false\n  - answer: DEFERRED-UNTIL: duplicate\n`);
    const duplicate = run('answer', path, 'target', '0');
    expect(duplicate.exitCode).not.toBe(0);
    expect(`${text(duplicate.stdout)}${text(duplicate.stderr)}`).toContain('goal clarification is ambiguous: target');
    expect(readFileSync(path, 'utf8')).toContain('DEFERRED-UNTIL: duplicate');
  });

  test('does not join an answer outside a blank-line-terminated clarification block', async () => {
    const { parseGoalDocumentClarifications } = await import('../src/self-implement/goal-author-clarification.js');
    const document = `- Clarification:
  - id: incomplete
  - header: Incomplete
  - question: Missing answer?

  - answer: unrelated
`;

    expect(parseGoalDocumentClarifications(document)).toEqual([]);
  });
});
