import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { approvalModalRouter } from '../../src/approval-modal.js';
import { DisplayCoordinator } from '../../src/display/index.js';
import {
  ASK_USER_QUESTION_OBSERVABILITY_CATEGORY,
  createFileAskUserQuestionResolver,
  dispatchAskUserQuestion,
  setAskUserQuestionDeps,
  setAskUserQuestionResolver,
} from '../../src/ask-user-question/index.js';
import { setPendingQuestionPersistenceForTesting } from '../../src/ask-user-question/tool.js';
import { debug } from '../../src/debug/log.js';
import {
  addPendingQuestionWaiting,
  createPendingQuestion,
  formatPendingQuestions,
  readPendingQuestionAnswer,
  readPendingQuestions,
  removePendingQuestion,
  removePendingQuestionAnswer,
  writePendingQuestion,
  writePendingQuestionAnswer,
} from '../../src/ask-user-question/pending-questions.js';
import { isPendingQuestionCliAnswerable, registerPendingQuestionsCommand } from '../../src/cli/pending-questions-cli.js';
import { Command } from 'commander';

const request = {
  questions: [{
    id: 'format', header: 'Format', question: 'Use Prettier?',
    options: [{ label: 'Yes', description: 'Format it' }, { label: 'No', description: 'Leave it' }],
  }],
};

function coordinator(): DisplayCoordinator {
  return new DisplayCoordinator({
    frameMs: 16,
    schedule: (fn, delayMs) => setTimeout(fn, delayMs),
    termSize: () => ({ rows: 30, cols: 120 }),
  });
}

function withStateRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'elanous-pending-question-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

afterEach(() => {
  setAskUserQuestionDeps(null);
  setAskUserQuestionResolver(null);
  setPendingQuestionPersistenceForTesting(null);
  approvalModalRouter._resetForTesting();
});

describe('pending AskUserQuestion observation', () => {
  test('creates a process-visible record while the TUI waits and removes it after cancellation', async () => {
    const state = withStateRoot();
    const observations: Array<[string, Record<string, unknown>]> = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === ASK_USER_QUESTION_OBSERVABILITY_CATEGORY) observations.push([event, data as Record<string, unknown>]);
    }) as typeof debug.log;
    const pending = createPendingQuestion('modal-test', request, 'session-1', { now: () => new Date('2026-08-12T00:00:00.000Z') });
    try {
      setPendingQuestionPersistenceForTesting({
        write: (entry) => writePendingQuestion(entry, { root: () => state.root }),
        remove: (id) => removePendingQuestion(id, { root: () => state.root }),
      });
      const display = coordinator();
      setAskUserQuestionDeps({ coordinator: display, termSize: () => ({ rows: 30, cols: 120 }) });
      const running = dispatchAskUserQuestion(request, { sessionId: 'session-1' });
      await Promise.resolve();

      const before = readPendingQuestions({ root: () => state.root });
      expect(before.ok).toBe(true);
      if (before.ok) {
        expect(before.questions).toHaveLength(1);
        const observed = before.questions[0]!;
        expect(observed.id).toMatch(/^auq:/);
        expect(observed.sessionId).toBe('session-1');
        expect(observed.surface).toBe('tui');
        expect(observed.delivery).toBe('modal');
        expect(observed.questions).toEqual([{ id: 'format', question: 'Use Prettier?', options: request.questions[0]!.options }]);
      }
      expect(pending.questions[0]!.question).toBe('Use Prettier?');

      approvalModalRouter._resetForTesting();
      await running;
      expect(readPendingQuestions({ root: () => state.root })).toEqual({ ok: true, questions: [] });
      const lifecycle = observations.filter(([, data]) => data.pendingQuestionId !== undefined);
      expect(lifecycle).toEqual([
        ['start', { pendingQuestionId: expect.stringMatching(/^auq:/), pendingQuestionCreated: true, questionCount: 1 }],
        ['end', { pendingQuestionId: expect.stringMatching(/^auq:/), pendingQuestionRemoved: true, questionCount: 1 }],
      ]);
      expect(lifecycle[0]![1].pendingQuestionId).toBe(lifecycle[1]![1].pendingQuestionId);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      state.cleanup();
    }
  });

  test('a persistence write failure leaves the existing TUI answer flow and failure observation unchanged', async () => {
    const observations: Array<[string, Record<string, unknown>]> = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === ASK_USER_QUESTION_OBSERVABILITY_CATEGORY) observations.push([event, data as Record<string, unknown>]);
    }) as typeof debug.log;
    setPendingQuestionPersistenceForTesting({
      write: () => { throw new Error('disk unavailable'); },
      remove: () => {},
    });
    const display = coordinator();
    setAskUserQuestionDeps({ coordinator: display, termSize: () => ({ rows: 30, cols: 120 }) });
    try {
      const running = dispatchAskUserQuestion(request);
      await Promise.resolve();
      approvalModalRouter.handleKey({ name: '1', ctrl: false, shift: false });
      await expect(running).resolves.toEqual({
        output: JSON.stringify({ answers: { format: 'Yes' } }),
        result: { answers: { format: 'Yes' } },
      });
      expect(observations).toContainEqual(['start', {
        pendingQuestionId: expect.stringMatching(/^auq:/),
        pendingQuestionWriteFailed: true,
        error: 'disk unavailable',
      }]);
      expect(observations.filter(([, data]) => data.pendingQuestionCreated === true || data.pendingQuestionRemoved === true)).toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('keeps the TUI response and cleanup intact when lifecycle observations throw', async () => {
    for (const throwingEvent of ['start', 'end'] as const) {
      const removed: string[] = [];
      const originalLog = debug.log;
      (debug as { log: typeof debug.log }).log = ((category, event) => {
        if (category === ASK_USER_QUESTION_OBSERVABILITY_CATEGORY && event === throwingEvent) {
          throw new Error('observer unavailable');
        }
      }) as typeof debug.log;
      try {
        setPendingQuestionPersistenceForTesting({
          write: () => {},
          remove: (id) => { removed.push(id); },
        });
        const display = coordinator();
        setAskUserQuestionDeps({ coordinator: display, termSize: () => ({ rows: 30, cols: 120 }) });
        const running = dispatchAskUserQuestion(request);
        await Promise.resolve();
        approvalModalRouter.handleKey({ name: '1', ctrl: false, shift: false });
        await expect(running).resolves.toEqual({
          output: JSON.stringify({ answers: { format: 'Yes' } }),
          result: { answers: { format: 'Yes' } },
        });
        expect(removed).toHaveLength(1);
      } finally {
        (debug as { log: typeof debug.log }).log = originalLog;
        approvalModalRouter._resetForTesting();
      }
    }
  });

  test('resolves a headless dispatch from the CLI-written sibling answer file and clears the pending record', async () => {
    const state = withStateRoot();
    const observations: Array<[string, { pendingQuestionId: string; questionCount: number } | undefined]> = [];
    let answered = false;
    const resolver = createFileAskUserQuestionResolver(1_000, {
      createId: () => 'file-answer',
      write: (entry) => writePendingQuestion(entry, { root: () => state.root }),
      readAnswer: (id) => readPendingQuestionAnswer(id, { root: () => state.root }),
      remove: (id) => removePendingQuestion(id, { root: () => state.root }),
      removeAnswer: (id) => removePendingQuestionAnswer(id, { root: () => state.root }),
      observe: (state, data) => observations.push([state, data]),
      sleep: async () => {
        if (answered) return;
        answered = true;
        const pending = readPendingQuestions({ root: () => state.root });
        expect(pending).toMatchObject({
          ok: true,
          questions: [{ id: 'file-answer', surface: 'file', delivery: 'file' }],
        });
        const program = new Command();
        registerPendingQuestionsCommand(program, { root: () => state.root, out: { log: () => {} } });
        await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'file-answer', '{"answers":{"format":"Yes"}}']);
      },
    });
    try {
      setAskUserQuestionDeps(null);
      setAskUserQuestionResolver(resolver);
      await expect(dispatchAskUserQuestion(request)).resolves.toEqual({
        output: JSON.stringify({ answers: { format: 'Yes' } }),
        result: { answers: { format: 'Yes' } },
      });
      expect(observations).toEqual([
        ['pending-created', { pendingQuestionId: 'file-answer', questionCount: 1 }],
        ['pending-removed', { pendingQuestionId: 'file-answer', questionCount: 1 }],
      ]);
      expect(readPendingQuestions({ root: () => state.root })).toEqual({ ok: true, questions: [] });
      expect(readPendingQuestionAnswer('file-answer', { root: () => state.root })).toEqual({ ok: true, answer: null });
    } finally {
      state.cleanup();
    }
  });

  test('distinguishes missing answers from answer read failures in the central dispatch observation', async () => {
    const states: string[] = [];
    const events: Record<string, unknown>[] = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === ASK_USER_QUESTION_OBSERVABILITY_CATEGORY && event === 'end') events.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    const missing = createFileAskUserQuestionResolver(1, {
      createId: () => 'missing', write: () => {}, remove: () => {},
      readAnswer: () => ({ ok: true, answer: null }), sleep: async () => {},
      observe: (state) => states.push(state),
    });
    const unreadable = createFileAskUserQuestionResolver(1_000, {
      createId: () => 'unreadable', write: () => {}, remove: () => {},
      readAnswer: () => ({ ok: false, error: 'bad answer file' }), sleep: async () => {},
      observe: (state) => states.push(state),
    });
    try {
      setAskUserQuestionDeps(null);
      setAskUserQuestionResolver(missing);
      await expect(dispatchAskUserQuestion(request)).resolves.toMatchObject({ result: { cancelled: true } });
      setAskUserQuestionResolver(unreadable);
      await expect(dispatchAskUserQuestion(request)).resolves.toMatchObject({ result: { cancelled: true } });
      expect(states).toEqual([
        'pending-created', 'answer-missing', 'pending-removed',
        'pending-created', 'answer-read-failed', 'pending-removed',
      ]);
      expect(events).toEqual([
        expect.objectContaining({ answerState: 'answer-missing', surface: 'file', delivery: 'file' }),
        expect.objectContaining({ answerState: 'answer-read-failed', surface: 'file', delivery: 'file' }),
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('keeps file resolver response and cleanup intact when lifecycle observers throw', async () => {
    const removed: string[] = [];
    for (const throwingState of ['pending-created', 'pending-removed'] as const) {
      const resolver = createFileAskUserQuestionResolver(1_000, {
        createId: () => `observer-${throwingState}`,
        write: () => {},
        readAnswer: (id) => ({ ok: true, answer: { id, result: { answers: { format: 'Yes' } } } }),
        remove: (id) => { removed.push(id); },
        removeAnswer: () => {},
        observe: (state) => {
          if (state === throwingState) throw new Error('observer unavailable');
        },
      });
      await expect(resolver(request)).resolves.toEqual({ answers: { format: 'Yes' } });
    }
    expect(removed).toEqual(['observer-pending-created', 'observer-pending-removed']);
  });

  test('records a pending write failure as a distinct central answerState', async () => {
    const states: string[] = [];
    const events: Record<string, unknown>[] = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === ASK_USER_QUESTION_OBSERVABILITY_CATEGORY && event === 'end') events.push(data as Record<string, unknown>);
    }) as typeof debug.log;
    const resolver = createFileAskUserQuestionResolver(1_000, {
      createId: () => 'write-fails',
      write: () => { throw new Error('disk unavailable'); },
      remove: () => {},
      readAnswer: () => ({ ok: true, answer: null }),
      sleep: async () => {},
      observe: (state) => states.push(state),
    });
    try {
      setAskUserQuestionDeps(null);
      setAskUserQuestionResolver(resolver);
      await expect(dispatchAskUserQuestion(request)).resolves.toMatchObject({ result: { cancelled: true } });
      expect(states).toEqual(['pending-write-failed']);
      expect(events).toEqual([
        expect.objectContaining({ answerState: 'pending-write-failed', surface: 'file', delivery: 'file' }),
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('rejects a file-surface pending record that has no expiresAt when read', () => {
    const state = withStateRoot();
    try {
      const dir = join(state.root, 'ask-user-question', 'pending');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'no-expiry.json'), JSON.stringify({
        id: 'no-expiry',
        questions: [],
        startedAt: '2026-08-12T00:00:00.000Z',
        surface: 'file',
        delivery: 'file',
      }));
      expect(readPendingQuestions({ root: () => state.root }).ok).toBe(false);
    } finally {
      state.cleanup();
    }
  });

  test('refuses to create a file-surface pending question without a valid expiresAt', () => {
    expect(() => createPendingQuestion('no-expiry', request, undefined, {}, { surface: 'file', delivery: 'file' }))
      .toThrow(/expiresAt/);
  });

  test('records CLI answers with the pending id', async () => {
    const writes: unknown[] = [];
    const output: string[] = [];
    const program = new Command();
    registerPendingQuestionsCommand(program, {
      read: () => ({
        ok: true,
        questions: [createPendingQuestion(
          'auq:file',
          request,
          undefined,
          { now: () => new Date('2026-08-12T00:00:00.000Z') },
          { surface: 'file', delivery: 'file', expiresAt: '2026-08-12T00:01:00.000Z' },
        )],
      }),
      now: () => Date.parse('2026-08-12T00:00:01.000Z'),
      writeAnswer: (answer) => { writes.push(answer); },
      out: { log: (line) => output.push(line) },
    });
    await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'auq:file', '{"answers":{"format":"Yes"}}']);
    expect(writes).toEqual([{ id: 'auq:file', result: { answers: { format: 'Yes' } } }]);
    expect(output).toEqual(['Recorded answer for auq:file.']);
  });

  test('shows CLI answerability and distinguishes non-file questions from missing ids', async () => {
    const file = createPendingQuestion(
      'file-question', request, undefined,
      { now: () => new Date('2026-08-12T00:00:00.000Z') },
      { surface: 'file', delivery: 'file', expiresAt: '2026-08-12T00:01:00.000Z' },
    );
    const modal = createPendingQuestion('modal-question', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') });
    const unknownPresentation = {
      ...modal,
      id: 'unknown-question',
      surface: undefined,
      delivery: 'unknown',
    } as unknown as typeof modal;
    const output: string[] = [];
    const writes: unknown[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerPendingQuestionsCommand(program, {
      read: () => ({ ok: true, questions: [file, modal, unknownPresentation] }),
      now: () => Date.parse('2026-08-12T00:00:01.000Z'),
      writeAnswer: (answer) => { writes.push(answer); },
      out: { log: (line) => output.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'elanous', 'questions', 'pending']);
    expect(output.shift()).toBe([
      'file-question  waiting=1s  expiry=active  surface=file  questions=Use Prettier?  answerable=true  answerableReason=cli-answerable',
      'modal-question  waiting=1s  expiry=no-expiry  surface=tui  questions=Use Prettier?  answerable=false  answerableReason=requires-surface:tui',
      'unknown-question  waiting=1s  expiry=no-expiry  surface=undefined  questions=Use Prettier?  answerable=false  answerableReason=requires-surface:undefined',
    ].join('\n'));
    await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'modal-question', '{"answers":{"format":"Yes"}}']);
    expect(output.shift()).toBe('Pending question modal-question exists but cannot be answered through this CLI (surface=tui, delivery=modal).');
    await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'unknown-question', '{"answers":{"format":"Yes"}}']);
    expect(output.shift()).toBe('Pending question unknown-question exists but cannot be answered through this CLI (surface=undefined, delivery=unknown).');
    await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'missing-question', '{"answers":{"format":"Yes"}}']);
    expect(output.shift()).toBe('No active file question found for missing-question.');
    expect(writes).toEqual([]);
    expect(exitCodes).toEqual([1, 1, 1]);
    expect(isPendingQuestionCliAnswerable({ surface: undefined, delivery: undefined })).toBe(false);
    expect(isPendingQuestionCliAnswerable({ surface: 'file', delivery: 'unknown' })).toBe(false);
  });

  test('rejects missing and expired pending ids without creating answer files', async () => {
    const state = withStateRoot();
    try {
      writePendingQuestion(createPendingQuestion(
        'expired',
        request,
        undefined,
        { now: () => new Date('2026-08-12T00:00:00.000Z') },
        { surface: 'file', delivery: 'file', expiresAt: '2026-08-12T00:00:01.000Z' },
      ), { root: () => state.root });
      for (const id of ['missing', 'expired']) {
        const output: string[] = [];
        const exitCodes: number[] = [];
        const program = new Command();
        registerPendingQuestionsCommand(program, {
          root: () => state.root,
          now: () => Date.parse('2026-08-12T00:00:02.000Z'),
          out: { log: (line) => output.push(line) },
          setExitCode: (code) => exitCodes.push(code),
        });
        await program.parseAsync(['node', 'elanous', 'questions', 'answer', id, '{"answers":{"format":"Yes"}}']);
        expect(exitCodes).toEqual([1]);
        expect(output[0]).toContain(id);
        expect(readPendingQuestionAnswer(id, { root: () => state.root })).toEqual({ ok: true, answer: null });
      }
    } finally {
      state.cleanup();
    }
  });

  test('removes an answer if the pending record disappears during the CLI write', async () => {
    const active = createPendingQuestion(
      'raced', request, undefined,
      { now: () => new Date('2026-08-12T00:00:00.000Z') },
      { surface: 'file', delivery: 'file', expiresAt: '2026-08-12T00:01:00.000Z' },
    );
    let reads = 0;
    const writes: unknown[] = [];
    const removals: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerPendingQuestionsCommand(program, {
      read: () => ({ ok: true, questions: reads++ === 0 ? [active] : [] }),
      now: () => Date.parse('2026-08-12T00:00:01.000Z'),
      writeAnswer: (answer) => { writes.push(answer); },
      removeAnswer: (id) => { removals.push(id); },
      out: { log: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'raced', '{"answers":{"format":"Yes"}}']);
    expect(writes).toHaveLength(1);
    expect(removals).toEqual(['raced']);
    expect(exitCodes).toEqual([1]);
  });

  test('rejects invalid CLI answer values before writing a response file', async () => {
    for (const json of ['null', '[]', '{"answers":[]}', '{"answers":{"format":1}}']) {
      const writes: unknown[] = [];
      const output: string[] = [];
      const exitCodes: number[] = [];
      const program = new Command();
      registerPendingQuestionsCommand(program, {
        read: () => ({ ok: true, questions: [] }),
        writeAnswer: (answer) => { writes.push(answer); },
        out: { log: (line) => output.push(line) },
        setExitCode: (code) => exitCodes.push(code),
      });
      await program.parseAsync(['node', 'elanous', 'questions', 'answer', 'auq:file', json]);
      expect(writes).toEqual([]);
      expect(output).toEqual(['Answer must be a valid AskUserQuestionResult.']);
      expect(exitCodes).toEqual([1]);
    }
  });

  test('timeout cleanup removes both records when a late answer races with pending removal', async () => {
    const state = withStateRoot();
    const states: string[] = [];
    try {
      const resolver = createFileAskUserQuestionResolver(0, {
        createId: () => 'timeout-race',
        write: (entry) => writePendingQuestion(entry, { root: () => state.root }),
        readAnswer: (id) => readPendingQuestionAnswer(id, { root: () => state.root }),
        remove: (id) => {
          removePendingQuestion(id, { root: () => state.root });
          writePendingQuestionAnswer({ id, result: { answers: { format: 'Late' } } }, { root: () => state.root });
        },
        removeAnswer: (id) => removePendingQuestionAnswer(id, { root: () => state.root }),
        observe: (entry) => states.push(entry),
      });
      await expect(resolver(request)).resolves.toEqual({ answers: {}, cancelled: true });
      expect(states).toEqual(['pending-created', 'answer-missing', 'pending-removed']);
      expect(readPendingQuestions({ root: () => state.root })).toEqual({ ok: true, questions: [] });
      expect(readPendingQuestionAnswer('timeout-race', { root: () => state.root })).toEqual({ ok: true, answer: null });
    } finally {
      state.cleanup();
    }
  });

  test('preserves a resolved answer when answer or pending cleanup fails', async () => {
    const states: string[] = [];
    const resolver = createFileAskUserQuestionResolver(1_000, {
      createId: () => 'cleanup-failure',
      write: () => {},
      readAnswer: () => ({ ok: true, answer: { id: 'cleanup-failure', result: { answers: { format: 'Yes' } } } }),
      removeAnswer: () => { throw new Error('answer cleanup unavailable'); },
      remove: () => { throw new Error('pending cleanup unavailable'); },
      observe: (state) => states.push(state),
    });
    setAskUserQuestionResolver(resolver);
    await expect(dispatchAskUserQuestion(request)).resolves.toMatchObject({ result: { answers: { format: 'Yes' } } });
    expect(states).toEqual(['pending-created', 'pending-remove-failed', 'answer-remove-failed']);
  });

  test('writes each record through a temporary file and atomic rename', () => {
    const state = withStateRoot();
    const renames: Array<[string, string]> = [];
    try {
      writePendingQuestion(createPendingQuestion('atomic', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') }), {
        root: () => state.root,
        renameFile: (from, to) => {
          renames.push([String(from), String(to)]);
          renameSync(from, to);
        },
      });
      expect(renames).toHaveLength(1);
      expect(renames[0]![0]).toContain('.tmp');
      expect(renames[0]![1]).toEndWith('atomic.json');
      expect(readPendingQuestions({ root: () => state.root })).toMatchObject({ ok: true, questions: [{ id: 'atomic' }] });
    } finally {
      state.cleanup();
    }
  });

  test('skips a record removed by normal cleanup after directory enumeration', () => {
    const state = withStateRoot();
    try {
      writePendingQuestion(createPendingQuestion('removed-during-read', request), { root: () => state.root });
      const result = readPendingQuestions({
        root: () => state.root,
        readFile: () => {
          removePendingQuestion('removed-during-read', { root: () => state.root });
          const error = new Error('file disappeared') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
      });
      expect(result).toEqual({ ok: true, questions: [] });
    } finally {
      state.cleanup();
    }
  });

  test('reports expired, active, and no-expiry questions without removing them', () => {
    const observedAt = Date.parse('2026-08-12T00:01:00.000Z');
    const questions = [
      createPendingQuestion('expired', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') }, { surface: 'tui', delivery: 'modal', expiresAt: '2026-08-12T00:00:59.999Z' }),
      createPendingQuestion('active', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') }, { surface: 'tui', delivery: 'modal', expiresAt: '2026-08-12T00:01:00.001Z' }),
      createPendingQuestion('no-expiry', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') }),
      createPendingQuestion('equal-boundary', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') }, { surface: 'tui', delivery: 'modal', expiresAt: '2026-08-12T00:01:00.000Z' }),
    ];
    const result = addPendingQuestionWaiting({ ok: true, questions }, observedAt);

    expect(result).toEqual({
      ok: true,
      questions: expect.arrayContaining([
        expect.objectContaining({ id: 'expired', waitingMs: 60_000, expiryStatus: 'expired' }),
        expect.objectContaining({ id: 'active', waitingMs: 60_000, expiryStatus: 'active' }),
        expect.objectContaining({ id: 'no-expiry', waitingMs: 60_000, expiryStatus: 'no-expiry' }),
        expect.objectContaining({ id: 'equal-boundary', waitingMs: 60_000, expiryStatus: 'expired' }),
      ]),
    });
    expect(result.ok && result.questions).toHaveLength(4);

    const output = formatPendingQuestions({ ok: true, questions }, observedAt);
    expect(output).toContain('expired  waiting=60s  expiry=expired');
    expect(output).toContain('active  waiting=60s  expiry=active');
    expect(output).toContain('no-expiry  waiting=60s  expiry=no-expiry');
    expect(output).toContain('equal-boundary  waiting=60s  expiry=expired');
  });

  test('query distinguishes no pending questions from malformed or structurally invalid on-disk state', async () => {
    const emptyState = withStateRoot();
    try {
      const none: string[] = [];
      const noneProgram = new Command();
      registerPendingQuestionsCommand(noneProgram, {
        root: () => emptyState.root, now: () => 0,
        out: { log: (line) => none.push(line) },
      });
      await noneProgram.parseAsync(['node', 'elanous', 'questions', 'pending']);
      expect(none).toEqual(['No pending questions.']);
    } finally {
      emptyState.cleanup();
    }

    const state = withStateRoot();
    try {
      const pendingDir = join(state.root, 'ask-user-question', 'pending');
      mkdirSync(pendingDir, { recursive: true });
      for (const [name, contents] of [
        ['malformed.json', '{'],
        ['not-array.json', JSON.stringify({ id: 'not-array', questions: {}, startedAt: '2026-08-12T00:00:00.000Z', surface: 'tui', delivery: 'modal' })],
        ['missing-field.json', JSON.stringify({ id: 'missing-field', questions: [], startedAt: '2026-08-12T00:00:00.000Z', surface: 'tui' })],
        ['invalid-date.json', JSON.stringify({ id: 'invalid-date', questions: [], startedAt: 'not-a-date', surface: 'tui', delivery: 'modal' })],
        ['non-iso-date.json', JSON.stringify({ id: 'non-iso-date', questions: [], startedAt: '0', surface: 'tui', delivery: 'modal' })],
        ['invalid-delivery.json', JSON.stringify({ id: 'invalid-delivery', questions: [], startedAt: '2026-08-12T00:00:00.000Z', surface: 'tui', delivery: 'carrier-pigeon' })],
      ]) {
        writeFileSync(join(pendingDir, name), contents);
        const direct = readPendingQuestions({ root: () => state.root });
        expect(direct.ok).toBe(false);

        const output: string[] = [];
        const exitCodes: number[] = [];
        const program = new Command();
        registerPendingQuestionsCommand(program, {
          root: () => state.root,
          now: () => Date.parse('2026-08-12T00:00:01.500Z'),
          out: { log: (line) => output.push(line) },
          setExitCode: (code) => exitCodes.push(code),
        });
        await program.parseAsync(['node', 'elanous', 'questions', 'pending', '--json']);
        const result = JSON.parse(output[0]!);
        expect(result.ok).toBe(false);
        expect(result.questions).toBeUndefined();
        expect(output[0]).not.toContain('NaN');
        expect(exitCodes).toEqual([1]);
        rmSync(join(pendingDir, name));
      }
    } finally {
      state.cleanup();
    }

    const json: string[] = [];
    const jsonProgram = new Command();
    registerPendingQuestionsCommand(jsonProgram, {
      read: () => ({ ok: true, questions: [createPendingQuestion('json-wait', request, undefined, { now: () => new Date('2026-08-12T00:00:00.000Z') })] }),
      now: () => Date.parse('2026-08-12T00:00:01.500Z'),
      out: { log: (line) => json.push(line) },
    });
    await jsonProgram.parseAsync(['node', 'elanous', 'questions', 'pending', '--json']);
    expect(JSON.parse(json[0]!)).toMatchObject({ ok: true, questions: [{ id: 'json-wait', waitingMs: 1500 }] });
  });
});

test('HITL1 H3: impact, recommended index and runId round-trip; an out-of-range index is dropped', async () => {
  const pq = await import('../../src/ask-user-question/pending-questions.js');
  const root = mkdtempSync(join(tmpdir(), 'pq-h3-'));
  try {
    const options = [{ label: 'Keep', description: 'k' }, { label: 'Widen', description: 'w' }];
    const question = pq.createPendingQuestion('auq:h3:abcde', { runId: 'run-x', questions: [{ id: 'scope', header: 'Scope', question: 'Widen?', options, impact: 'high', recommendedIndex: 1 }] },
      undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T00:00:00.000Z' });
    pq.writePendingQuestion(question, { root: () => root });
    const read = pq.readPendingQuestions({ root: () => root });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.questions[0]).toMatchObject({ runId: 'run-x', questions: [{ impact: 'high', recommendedIndex: 1 }] });
    const bad = pq.createPendingQuestion('auq:h3:fghij', { questions: [{ id: 'scope', header: 'Scope', question: 'Widen?', options, recommendedIndex: 5 }] },
      undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T00:00:00.000Z' });
    expect(bad.questions[0]).not.toHaveProperty('recommendedIndex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
