import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { debug } from '../debug/log.js';
import { buildUserConfig } from '../user-config.js';
import type { ClarificationCandidate } from '../hitl/clarification-policy.js';
import type { PendingQuestion } from '../ask-user-question/pending-questions.js';
import { askAtExecution } from './execution-clarification.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { DecisionCardService, type CardView } from '../decisions/decision-cards.js';
import { readPendingQuestionAnswer, writePendingQuestion, removePendingQuestion, removePendingQuestionAnswer } from '../ask-user-question/pending-questions.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { mapStageToRunStatus } from './run-status-mapping.js';
import type { RunLedgerEntry } from './run-ledger.js';

const candidate = (impact: ClarificationCandidate['impact']): ClarificationCandidate => ({
  id: 'scope_change', decision: 'scope', prompt: 'Choose scope', whyNow: 'Scope changes implementation.', impact,
  options: [
    { label: 'a', description: 'Stay in scope.', recommended: true },
    { label: 'b', description: 'Expand scope.' },
  ],
});

const start = Date.parse('2026-10-02T12:00:00.000Z');

// A clean throwaway git repo — the real changed-file detection runs against it, never against this checkout.
function scratchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'execution-scope-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/inside.ts'), 'export const inside = 1;\n');
  writeFileSync(join(repo, 'LICENSE'), 'license\n');
  writeFileSync(join(repo, 'README.md'), 'readme\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return repo;
}
let clock: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn<typeof debug, 'log'>>;
afterEach(() => { clock?.mockRestore(); log?.mockRestore(); });

function setup(impact: ClarificationCandidate['impact'], minutes?: number, answer?: string) {
  let now = start;
  clock = spyOn(Date, 'now').mockImplementation(() => now);
  log = spyOn(debug, 'log').mockImplementation(() => {});
  const written: PendingQuestion[] = [];
  const ledger: RunLedgerEntry[] = [];
  let reads = 0;
  const ctx = { runId: 'run-execution-1', config: { hitl: { executionDeadlineMinutes: minutes } } };
  const deps = {
    now: () => now,
    createId: () => 'pending-execution-1',
    writeRunLedger: (entry: RunLedgerEntry) => { ledger.push(entry); },
    resolverDeps: {
      write: (pending: PendingQuestion) => { written.push(pending); },
      readAnswer: () => {
        reads++;
        return { ok: true as const, answer: answer && reads === 1
          ? { id: 'pending-execution-1', result: { answers: { scope_change: answer } } }
          : null };
      },
      remove: () => {}, removeAnswer: () => {},
      sleep: async (ms: number) => { now += Math.max(ms, 60_000); },
    },
  };
  return { ctx, deps, written, ledger };
}

describe('askAtExecution', () => {
  test('low impact assumes immediately, writes no question, and records the assumption', async () => {
    const { ctx, deps, written, ledger } = setup('low');
    expect(await askAtExecution(candidate('low'), ctx, deps)).toEqual({ choice: 'a', by: 'assumed' });
    expect(written).toHaveLength(0);
    expect(ledger.map(entry => entry.event)).toEqual(['assumed']);
    expect(log.mock.calls.filter(call => call[0] === 'hitl.execution').map(call => call[1])).toEqual(['assumed']);
  });

  test('high impact uses the answered option b before expiry, with no question prose in the execution log', async () => {
    const { ctx, deps, written } = setup('high', undefined, 'b');
    expect(await askAtExecution(candidate('high'), ctx, deps)).toEqual({ choice: 'b', by: 'owner' });
    expect(written).toHaveLength(1);
    const events = log.mock.calls.filter(call => call[0] === 'hitl.execution');
    expect(events.map(call => call[1])).toEqual(['asked', 'answered']);
    expect(events.map(call => call[2])).toEqual([
      { runId: ctx.runId, questionId: 'pending-execution-1', impact: 'high' },
      { runId: ctx.runId, questionId: 'pending-execution-1', impact: 'high' },
    ]);
  });

  test('a pending run receives the decision card answer from the shared ledger and resumes with the chosen option', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hitl-card-run-'));
    let now = start;
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    log = spyOn(debug, 'log').mockImplementation(() => {});
    const runId = 'run-card-1';
    const longQuestion = 'Choose scope ' + 'carefully '.repeat(26) + '\n\nThe release must retain all previous behavior.\nReason: the owner must see this before deciding.';
    const questionId = 'execution:run-card-1:00000000-0000-4000-8000-000000000001';
    const ledger = new DecisionLedger({ stateDir: root, now: () => new Date(now), resolveVersion: () => ({}) as never });
    const sent: CardView[] = [];
    const cards = new DecisionCardService({ ledger, ownerIds: ['owner'], now: () => new Date(now),
      transport: { platform: 'telegram', ownerChats: async () => ['owner'], send: async (_chat, view) => { sent.push(view); return { chat: 'owner', message: '1' }; }, edit: async () => {}, notify: async () => {} },
    });
    try {
      await cards.tick();
      let ticked = false;
      const wait = askAtExecution({ ...candidate('high'), prompt: longQuestion }, { runId, config: { hitl: { executionDeadlineMinutes: 5 } } }, {
        createId: () => questionId,
        resolverDeps: {
          write: pending => writePendingQuestion(pending, { root: () => root }),
          readAnswer: id => readPendingQuestionAnswer(id, { root: () => root }),
          remove: id => removePendingQuestion(id, { root: () => root }),
          removeAnswer: id => removePendingQuestionAnswer(id, { root: () => root }),
          sleep: async () => {
            if (!ticked) {
              ticked = true;
              expect((await cards.tick()).sent).toBe(1);
              const entry = ledger.list()[0]!;
              expect(entry.resume).toEqual({ questionId, runId });
              const originalQuestion = `${longQuestion}\n\nRecommended: a. Scope changes implementation.`;
              expect(entry.pendingQuestion).toBe(originalQuestion);
              expect(entry.scqa.s).not.toBe(entry.scqa.c);
              expect(sent[0]?.text).toContain(originalQuestion);
              expect(sent).toHaveLength(1);
              expect(ledger.decideWithDelivery(entry.id, 'b', { kind: 'human' }).delivery).toEqual({ ok: true, questionId });
            }
            now += 100;
          },
        },
      });
      expect(await wait).toEqual({ choice: 'b', by: 'owner' });
      expect(ledger.list({ status: 'decided' })[0]?.resume?.runId).toBe(runId);
      expect(readPendingQuestionAnswer(questionId, { root: () => root })).toEqual({ ok: true, answer: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('high impact expires and auto-recommends', async () => {
    const { ctx, deps, ledger } = setup('high');
    expect(await askAtExecution(candidate('high'), ctx, deps)).toEqual({ choice: 'a', by: 'auto-recommended' });
    expect(ledger.map(entry => entry.event)).toEqual(['auto-recommended']);
  });

  test('critical expiry parks this run, records parked, and never uses the recommendation', async () => {
    const { ctx, deps, ledger } = setup('critical');
    expect(await askAtExecution(candidate('critical'), ctx, deps)).toEqual({ parked: true, reason: 'critical-unanswered', questionId: 'pending-execution-1' });
    expect(ledger).toMatchObject([{ runId: ctx.runId, event: 'parked', data: { questionId: 'pending-execution-1', reason: 'critical-unanswered' } }]);
    expect(JSON.stringify(ledger)).not.toContain('"choice":"a"');
  });

  test('stored question carries impact, recommendedIndex, runId and a 30-minute deadline', async () => {
    const { ctx, deps, written } = setup('high');
    await askAtExecution(candidate('high'), ctx, deps);
    expect(written[0]).toMatchObject({
      id: 'pending-execution-1', runId: ctx.runId,
      startedAt: '2026-10-02T12:00:00.000Z', expiresAt: '2026-10-02T12:30:00.000Z',
      surface: 'file', delivery: 'file',
      questions: [{ id: 'scope_change', impact: 'high', recommendedIndex: 0 }],
    });
  });

  test('configured deadline of five minutes changes both pending expiry and resolver wait', async () => {
    const { ctx, deps, written } = setup('high', 5);
    expect(await askAtExecution(candidate('high'), ctx, deps)).toEqual({ choice: 'a', by: 'auto-recommended' });
    expect(written[0]?.expiresAt).toBe('2026-10-02T12:05:00.000Z');
  });

  test('user config loads hitl.executionDeadlineMinutes without affecting defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'execution-hitl-config-'));
    try {
      const path = join(directory, 'config.json');
      writeFileSync(path, JSON.stringify({ hitl: { executionDeadlineMinutes: 5 } }));
      expect(buildUserConfig(path).hitl?.executionDeadlineMinutes).toBe(5);
      writeFileSync(path, '{}');
      expect(buildUserConfig(path).hitl).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a failed answer read cannot turn into an automatic answer', async () => {
    const { ctx, deps } = setup('high');
    deps.resolverDeps.readAnswer = () => { throw new Error('answer unavailable'); };
    await expect(askAtExecution(candidate('high'), ctx, deps)).rejects.toThrow();
  });

  test('a failed pending write never becomes an automatic answer or a parked timeout', async () => {
    const { ctx, deps } = setup('critical');
    deps.resolverDeps.write = () => { throw new Error('store unavailable'); };
    await expect(askAtExecution(candidate('critical'), ctx, deps)).rejects.toThrow('could not read its answer');
  });

  test('pending question defers without writing and a malformed recommendation cannot silently bypass the policy', async () => {
    const { ctx, deps, written } = setup('high');
    expect(await askAtExecution(candidate('high'), { ...ctx, pendingQuestionCount: 1 }, deps)).toEqual({ deferred: true });
    expect(written).toHaveLength(0);
    await expect(askAtExecution({ ...candidate('critical'), options: [{ label: 'a', description: 'Only', recommended: true }] }, ctx, deps)).rejects.toThrow('2–4');
  });

  test('the actual implement path writes an owner question and uses its answer before gating an out-of-scope edit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'execution-scope-owner-'));
    const goalFile = join(directory, 'goal.txt');
    writeFileSync(goalFile, [
      '## PROBLEM', 'Original ask (verbatim, unmodified):', '```',
      '대상 경로: src/inside.ts', 'Implement the change.', '```', '',
    ].join('\n'));
    const questions: PendingQuestion[] = [];
    const events: RunLedgerEntry[] = [];
    let gateCalls = 0;
    try {
      const result = await runSelfImplement({
        runId: 'run-owner-scope', feature: 'implement scoped change', goalFile, memory: false,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: seams({
          changedFilesForGateRoute: () => ['src/outside.ts'],
          writeRunLedger: entry => { events.push(entry); },
          askExecutionClarification: (choice, ctx, deps) => askAtExecution(choice, ctx, {
            ...deps, createId: () => 'scope-owner-question',
            resolverDeps: {
              write: question => { questions.push(question); },
              readAnswer: () => ({ ok: true, answer: {
                id: 'scope-owner-question', result: { answers: { execution_scope: 'Expand scope' } },
              } }),
              remove: () => {}, removeAnswer: () => {},
            },
          }),
          gate: async () => { gateCalls++; return { passed: true, log: 'ok' }; },
        }),
      });
      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(gateCalls).toBe(1);
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({ runId: 'run-owner-scope', questions: [{ impact: 'high', recommendedIndex: 0 }] });
      expect(events.some(entry => entry.event === 'execution-scope-held')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the harness run continues to its gate after its own decision card is answered', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'execution-card-gate-'));
    const goalFile = join(directory, 'goal.txt');
    writeFileSync(goalFile, ['## PROBLEM', 'Original ask (verbatim, unmodified):', '```',
      '대상 경로: src/inside.ts', 'Implement the change.', '```', '',
    ].join('\n'));
    const runId = 'run-card-gate';
    const questionId = 'execution:run-card-gate:00000000-0000-4000-8000-000000000002';
    let now = start;
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    const ledger = new DecisionLedger({ stateDir: directory, now: () => new Date(now), resolveVersion: () => ({}) as never });
    const cards = new DecisionCardService({ ledger, ownerIds: ['owner'], now: () => new Date(now), transport: {
      platform: 'discord', ownerChats: async () => ['owner'], send: async () => ({ chat: 'owner', message: '1' }),
      edit: async () => {}, notify: async () => {},
    } });
    let gateCalls = 0;
    try {
      await cards.tick();
      let answered = false;
      const result = await runSelfImplement({ runId, feature: 'implement scoped change', goalFile, memory: false,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: seams({
          changedFilesForGateRoute: () => ['src/outside.ts'],
          writeRunLedger: () => {},
          askExecutionClarification: (candidate, context, deps) => askAtExecution(candidate, context, {
            ...deps, createId: () => questionId,
            resolverDeps: {
              write: question => writePendingQuestion(question, { root: () => directory }),
              readAnswer: id => readPendingQuestionAnswer(id, { root: () => directory }),
              remove: id => removePendingQuestion(id, { root: () => directory }),
              removeAnswer: id => removePendingQuestionAnswer(id, { root: () => directory }),
              sleep: async () => {
                now += 100;
                if (answered) return;
                answered = true;
                expect((await cards.tick()).sent).toBe(1);
                const entry = ledger.list()[0]!;
                expect(entry.resume).toEqual({ questionId, runId });
                expect((await cards.tap('owner', `dec:${entry.id}:b`)).kind).toBe('decided');
              },
            },
          }),
          gate: async () => { gateCalls++; return { passed: true, log: 'ok' }; },
        }),
      });
      expect(result).toMatchObject({ ok: true, stage: 'pr-opened' });
      expect(gateCalls).toBe(1);
      expect(ledger.list({ status: 'decided' })[0]?.resume?.runId).toBe(runId);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a real out-of-scope worktree edit triggers a stored question and blocks gate and PR without consent', async () => {
    const worktree = scratchRepo();
    const directory = mkdtempSync(join(tmpdir(), 'execution-scope-real-'));
    const goalFile = join(directory, 'goal.txt');
    writeFileSync(goalFile, ['## PROBLEM', 'Original ask (verbatim, unmodified):', '```',
      '대상 경로: src/inside.ts', 'Implement the change.', '```', '',
    ].join('\n'));
    const questions: PendingQuestion[] = [];
    let gates = 0;
    let opened = 0;
    const run = (runId: string) => runSelfImplement({
      runId, feature: 'implement scoped change', goalFile, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
        writeRunLedger: () => {},
        askExecutionClarification: (choice, ctx, deps) => askAtExecution(choice, ctx, {
          ...deps, createId: () => 'real-scope-question',
          resolverDeps: {
            write: question => { questions.push(question); },
            readAnswer: () => ({ ok: true, answer: { id: 'real-scope-question', result: { answers: { execution_scope: 'Stay in scope' } } } }),
            remove: () => {}, removeAnswer: () => {},
          },
        }),
        gate: async () => { gates++; return { passed: true, log: 'ok' }; },
        openPr: async () => { opened++; return { url: 'https://pr/7', number: 7 }; },
      }),
    });
    try {
      // In-scope edit only: default detection sees no outside file, so no question and the gate runs.
      writeFileSync(join(worktree, 'src/inside.ts'), 'export const inside = 2;\n');
      await run('run-real-scope-inside');
      expect(questions).toHaveLength(0);
      expect(gates).toBe(1);
      const gatesBefore = gates;
      const openedBefore = opened;
      // Now an edit outside the authored targets: the same default detection must ask and hold.
      writeFileSync(join(worktree, 'LICENSE'), 'license\nreal worktree change outside the authored targets\n');
      expect(execFileSync('git', ['status', '--porcelain', '--', 'LICENSE'], { cwd: worktree, encoding: 'utf8' })).toContain('LICENSE');
      const result = await run('run-real-scope');
      expect(result).toMatchObject({ ok: false, stage: 'soft-stopped' });
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({ runId: 'run-real-scope', questions: [{ id: 'execution_scope', impact: 'high', recommendedIndex: 0 }] });
      expect(gates).toBe(gatesBefore);
      expect(opened).toBe(openedBefore);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('deleting a tracked out-of-scope file is critical and parks the run when the owner does not answer', async () => {
    const worktree = scratchRepo();
    const path = join(worktree, 'README.md');
    const directory = mkdtempSync(join(tmpdir(), 'execution-scope-critical-'));
    const goalFile = join(directory, 'goal.txt');
    writeFileSync(goalFile, ['## PROBLEM', 'Original ask (verbatim, unmodified):', '```',
      '대상 경로: src/inside.ts', 'Implement the change.', '```', '',
    ].join('\n'));
    const asked: PendingQuestion[] = [];
    const ledger: RunLedgerEntry[] = [];
    let gates = 0;
    let opened = 0;
    // Pin the clock before the resolver sets its deadline (Date.now() + 30 min) and jump past it in sleep.
    // A wall-clock deadline against a fixed mocked time loops forever once the real date passes it
    // (10-03: the 0.2.10 gate OOMKilled this file at 16Gi and 32Gi — one new spy per spin).
    let t = start;
    clock = spyOn(Date, 'now').mockImplementation(() => t);
    try {
      unlinkSync(path);
      const result = await runSelfImplement({
        runId: 'run-critical-scope', feature: 'implement scoped change', goalFile, memory: false,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: seams({
          createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
          writeRunLedger: entry => { ledger.push(entry); },
          askExecutionClarification: (choice, ctx, deps) => askAtExecution(choice, ctx, {
            ...deps, now: () => start, createId: () => 'critical-scope-question',
            resolverDeps: {
              write: question => { asked.push(question); },
              readAnswer: () => ({ ok: true, answer: null }),
              remove: () => {}, removeAnswer: () => {}, sleep: async () => { t = start + 31 * 60_000; },
            },
          }),
          gate: async () => { gates++; return { passed: true, log: 'ok' }; },
          openPr: async () => { opened++; return { url: 'https://pr/7', number: 7 }; },
        }),
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ runId: 'run-critical-scope', questions: [{ impact: 'critical', recommendedIndex: 0 }] });
      expect(result).toMatchObject({ ok: false, stage: 'parked', detail: 'critical-unanswered: critical-scope-question' });
      expect(ledger).toContainEqual(expect.objectContaining({ event: 'parked', data: expect.objectContaining({ questionId: 'critical-scope-question' }) }));
      expect(mapStageToRunStatus(result.stage)).toEqual({ runStatus: 'parked' });
      expect(ledger).toContainEqual(expect.objectContaining({ event: 'run-status', data: expect.objectContaining({ stage: 'parked', runStatus: 'parked' }) }));
      expect(gates).toBe(0);
      expect(opened).toBe(0);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the actual implement boundary asks on measured edits outside declared targets and holds gate without owner consent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'execution-scope-run-'));
    const goalFile = join(directory, 'goal.txt');
    writeFileSync(goalFile, [
      '## PROBLEM', 'Original ask (verbatim, unmodified):', '```',
      '대상 경로: src/inside.ts', 'Implement the change.', '```', '',
    ].join('\n'));
    const asked: string[] = [];
    let gates = 0;
    let opened = 0;
    const runLedger: RunLedgerEntry[] = [];
    try {
      const run = async (files: string[], choice: 'Stay in scope' | 'Expand scope' | 'parked') => runSelfImplement({
        runId: 'run-execution-scope-test', feature: 'implement scoped change', goalFile, memory: false,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: seams({
          changedFilesForGateRoute: () => files,
          writeRunLedger: entry => { runLedger.push(entry); },
          askExecutionClarification: async (question, context) => {
            asked.push(`${context.runId}:${question.impact}:${question.options[0]?.label}`);
            return choice === 'parked'
              ? { parked: true, reason: 'critical-unanswered', questionId: 'scope-question-1' }
              : { choice, by: 'owner' };
          },
          gate: async () => { gates++; return { passed: true, log: 'ok' }; },
          openPr: async () => { opened++; return { url: 'https://pr/7', number: 7 }; },
        }),
      });
      const held = await run(['src/outside.ts'], 'Stay in scope');
      expect(asked).toEqual(['run-execution-scope-test:high:Stay in scope']);
      expect(held).toMatchObject({ ok: false, stage: 'soft-stopped' });
      expect(gates).toBe(0);
      expect(opened).toBe(0);
      await run(['src/inside.ts'], 'Stay in scope');
      expect(asked).toHaveLength(1);
      expect(gates).toBe(1);
      await run(['src/outside.ts'], 'Expand scope');
      expect(asked).toHaveLength(2);
      expect(gates).toBe(2);
      const parked = await run(['src/outside.ts'], 'parked');
      expect(parked).toMatchObject({ ok: false, stage: 'parked', detail: 'critical-unanswered: scope-question-1' });
      expect(mapStageToRunStatus(parked.stage)).toEqual({ runStatus: 'parked' });
      expect(runLedger).toContainEqual(expect.objectContaining({ event: 'run-status', data: expect.objectContaining({ stage: 'parked', runStatus: 'parked' }) }));
      expect(gates).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
