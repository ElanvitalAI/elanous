import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { formatGoalAuthorSelfInspection, formatGoalInterviewRound, inspectDecisionObservations, inspectDecisionSignalKinds, runGoalAuthorCli, type GoalAuthorCliDeps } from './goal-author-cli.js';
import { writeAuthoredGoal, type GoalAuthorDeps, type GoalFileLintFinding } from './goal-author.js';
import type { LaunchPreflightResult } from '../self-dev/launch-preflight.js';

test('say-first records the shared self-answer observation without a second resolver call', async () => {
  const observed = spyOn(debug, 'log').mockImplementation(() => undefined);
  let resolverCalls = 0;
  try {
    const document = [
      '- Clarification:', '  - id: q', '  - header: Clarification', '  - question: Which contract?',
      '  - options:', '    - label: Keep API', '      description: Verified.', '  - includeOther: true',
      '  - answer: Keep API', '  - provenance.source: self-authored', '  - evidence: src/api.ts:12', '',
    ].join('\n');
    await runGoalAuthorCli(['new goal'], { cwd: '/tmp', selfResolveClarifications: true }, {
      write: async () => ({ path: '/tmp/GOAL.txt', authored: { document, authorRunId: 'author-first', grounded: false, facts: null } }),
      selfResolveClarification: async () => { resolverCalls++; return {}; },
      recordAsk: () => true,
    });
    expect(resolverCalls).toBe(0);
    expect(observed).toHaveBeenCalledWith('self-implement.clarification-escalation', 'self-answer', {
      path: 'say-first', asked: 1, answered: 1, unanswered: 0, reason: 'answered',
    });
  } finally { observed.mockRestore(); }
});

test('say-first self-answers a question the authoring pass left unanswered and writes the goal file', async () => {
  const observed = spyOn(debug, 'log').mockImplementation(() => undefined);
  const written: Array<{ path: string; document: string }> = [];
  try {
    const document = [
      '- evidence: src/api.ts:12: contract',
      '- Clarification:', '  - id: preservation_contract', '  - header: Clarification', '  - question: Which behavior must stay?',
      '  - options:', '    - label: Keep API', '      description: Verified.', '  - includeOther: true',
      '  - answer: DEFERRED-UNTIL: Which behavior must stay?', '',
    ].join('\n');
    await runGoalAuthorCli(['new goal'], { cwd: '/tmp', selfResolveClarifications: true }, {
      write: async () => ({ path: '/tmp/GOAL.txt', authored: { document, authorRunId: 'author-first', grounded: false, facts: null } }),
      selfResolveClarification: async ({ evidence }) => ({ answer: 'Keep API', evidence }),
      writeFile: (path, next) => { written.push({ path, document: next }); },
      recordAsk: () => true,
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe('/tmp/GOAL.txt');
    expect(written[0]!.document).toContain('  - answer: Keep API');
    expect(observed).toHaveBeenCalledWith('self-implement.clarification-escalation', 'self-answer', {
      path: 'say-first', asked: 1, answered: 1, unanswered: 0, reason: 'answered',
    });
  } finally { observed.mockRestore(); }
});

test('supersedes reauthor invokes the shared self-answer after writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-author-rework-'));
  const source = join(root, 'GOAL-parent.md');
  const ask = '대상 경로: src/example.ts\nPreserve the contract.';
  const question = '- Clarification:\n  - id: contract\n  - header: Clarification\n  - question: What is the contract?\n  - options:\n    - label: Focused test\n      description: Test file.\n  - includeOther: true\n  - answer: DEFERRED-UNTIL: What is the contract?\n';
  const document = `- GoalId: 0123456789abcdef\nOriginal ask (verbatim, unmodified):\n\`\`\`\n${ask}\n\`\`\`\n\n- evidence: src/example.ts: contract\n${question}`;
  const calls: string[] = [];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(source, document);
  try {
    await runGoalAuthorCli([], { cwd: root, supersedes: 'GOAL-parent.md', selfResolveClarifications: true }, {
      write: async () => ({ path: join(root, 'GOAL-child.md'), authored: { document, authorRunId: 'author-rework', grounded: false, facts: null } }),
      readFile: (() => document) as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
      writeFile: (_path, value) => { calls.push(value); },
      selfResolveClarification: async ({ evidence }) => { calls.push('resolver'); return { answer: 'Focused test', evidence }; },
      recordAsk: () => true,
    });
    expect(calls[0]).toBe('resolver');
    expect(calls[1]).toContain('  - answer: Focused test');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('runGoalAuthorCli clarification self-resolution selection', () => {
  const document = '- GoalId: 0123456789abcdef\n';
  const write: NonNullable<GoalAuthorCliDeps['write']> = async (_ask, _cwd, deps = {}) => {
    const resolver = deps.selfResolveClarification;
    const answer = resolver ? await resolver({ questionId: 'q', question: 'Which evidence?', kind: 'term', options: [], evidence: ['src/example.ts: contract'] }) : {};
    return {
      path: 'docs/goals/GOAL-test.md',
      authored: {
        document: answer.answer ? `- answer: ${answer.answer}\n` : '- answer: DEFERRED-UNTIL: Which evidence?\n',
        authorRunId: 'author-test', facts: null, grounded: false,
      },
    };
  };

  test('keeps clarifications unresolved without the opt-in and injects the resolver only with it', async () => {
    const resolver = spyOn({ resolve: async () => ({ answer: 'resolved evidence', evidence: ['src/example.ts: contract'] }) }, 'resolve');
    const defaultResult = await runGoalAuthorCli(['ask'], { cwd: process.cwd() }, { write, selfResolveClarification: resolver });
    const optedInResult = await runGoalAuthorCli(['ask'], { cwd: process.cwd(), selfResolveClarifications: true }, { write, selfResolveClarification: resolver });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(defaultResult.authored.document).toContain('DEFERRED-UNTIL');
    expect(optedInResult.authored.document).toContain('resolved evidence');
  });
});

describe('runGoalAuthorCli author grade forwarding', () => {
  test('passes flag grade to the existing writeAuthoredGoal call without creating decomposition', async () => {
    const write = spyOn({ call: async (_ask: string, _cwd: string, authorDeps?: Partial<GoalAuthorDeps>) => {
      expect(authorDeps?.authorGrade).toEqual({ grade: 'lite', source: 'flag' });
      expect(authorDeps?.decomposeSteps).toBeUndefined();
      return { path: 'docs/goals/GOAL-test.md', authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test', facts: null, grounded: false } };
    } }, 'call');
    await runGoalAuthorCli(['대상 경로: src/example.ts'], { cwd: process.cwd(), authorGrade: { grade: 'lite', source: 'flag' } }, { write, recordAsk: () => true });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('runGoalAuthorCli grounding root forwarding', () => {
  test('forwards groundingCwd as writeAuthoredGoal groundingRoot while retaining cwd', async () => {
    const write: NonNullable<GoalAuthorCliDeps['write']> = async () => ({
      path: 'docs/goals/GOAL-test.md',
      authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test', facts: null, grounded: false },
    });
    const deps = { write, recordAsk: () => true };
    const writeSpy = spyOn(deps, 'write');

    await runGoalAuthorCli(['ask'], { cwd: '/launch-root', groundingCwd: '/grounding-root' }, deps);

    expect(writeSpy).toHaveBeenCalledWith('ask', '/launch-root', expect.any(Object), undefined, '/grounding-root');
  });
});

describe('runGoalAuthorCli progress callback', () => {
  const write: NonNullable<GoalAuthorCliDeps['write']> = async () => ({
    path: 'docs/goals/GOAL-test.md',
    authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test', facts: null, grounded: false },
  });

  test('forwards the provided progress callback by reference to the author', async () => {
    const onProgress: NonNullable<GoalAuthorDeps['onProgress']> = () => {};
    const recordAsk = spyOn({ record: () => true }, 'record');
    const deps = { write, recordAsk };
    const writeSpy = spyOn(deps, 'write');

    await runGoalAuthorCli(['ask'], { cwd: process.cwd(), onProgress }, deps);

    expect(writeSpy).toHaveBeenCalledWith(
      'ask',
      process.cwd(),
      expect.objectContaining({ onProgress }),
      undefined,
    );
    expect(recordAsk).toHaveBeenCalledTimes(1);
  });

  test('preserves author dependencies and result when no progress callback is supplied', async () => {
    const recordAsk = spyOn({ record: () => true }, 'record');
    const deps = { write, recordAsk };
    const writeSpy = spyOn(deps, 'write');

    const result = await runGoalAuthorCli(['ask'], { cwd: process.cwd() }, deps);
    const authorDeps = writeSpy.mock.calls[0]?.[2];

    expect(Object.prototype.hasOwnProperty.call(authorDeps, 'onProgress')).toBeFalse();
    expect(result).toMatchObject({
      path: 'docs/goals/GOAL-test.md',
      authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test' },
    });
    expect(recordAsk).toHaveBeenCalledTimes(1);
  });
});

describe('runGoalAuthorCli launch preflight forwarding', () => {
  const launchPreflight: LaunchPreflightResult = {
    // ⛔ 2026-08-23: `missingDeclaredPathCount` 가 «필수»로 추가됐다(#pathexists).
    //   bun test 는 타입-블라인드라 이 목이 안 따라가도 «초록»으로 보인다 — tsc 전수에서만 잡힌다.
    paths: ['src/self-implement/goal-author-cli.ts'], blockers: [], warnings: [],
    missingDeclaredPathCount: 0,
    openPrs: { state: 'checked', count: 0 }, liveRuns: { state: 'checked', count: 0 },
    completedRuns: { state: 'checked', count: 1 }, completedRunMatches: [],
    interruptedRuns: { state: 'checked', count: 0 }, interruptedRunMatches: [],
    activeUnfinishedRuns: { state: 'checked', count: 0 }, inactiveUnfinishedRuns: { state: 'checked', count: 0 },
    unreadableUnfinishedRunAges: { state: 'checked', count: 0 }, recentChanges: { state: 'checked', count: 0 },
    preexistingFailures: { state: 'checked', files: [] }, recentChangeWindowDays: 7,
    unreadableRuns: 0, liveRunWindowMs: 60_000,
  };
  const write: NonNullable<GoalAuthorCliDeps['write']> = async () => ({
    path: 'docs/goals/GOAL-test.md',
    authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test', facts: null, grounded: false },
  });

  test('forwards supplied preflight by reference in direct and parent-goal branches while omitting it otherwise', async () => {
    const deps = { write, recordAsk: () => true };
    const writeSpy = spyOn(deps, 'write');
    const parentGoalFile = 'docs/goals/GOAL-parent.md';
    const parentQuestionId = 'question-1';

    await runGoalAuthorCli(['direct'], { cwd: process.cwd(), launchPreflight }, deps);
    await runGoalAuthorCli(['child'], { cwd: process.cwd(), parentGoalFile, parentQuestionId, launchPreflight }, {
      ...deps,
      readFile: (() => '- GoalId: 0123456789abcdef\n') as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
      realpath: ((path: string) => path) as NonNullable<GoalAuthorCliDeps['realpath']>,
    });
    await runGoalAuthorCli(['without preflight'], { cwd: process.cwd() }, deps);

    expect(writeSpy.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ launchPreflight }));
    expect(writeSpy.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ launchPreflight }));
    expect(Object.prototype.hasOwnProperty.call(writeSpy.mock.calls[2]?.[2], 'launchPreflight')).toBeFalse();
  });
});

describe('runGoalAuthorCli ask provenance', () => {
  const document = '- GoalId: 0123456789abcdef\n';
  const write: GoalAuthorCliDeps['write'] = async () => ({
    path: 'docs/goals/GOAL-test.md',
    authored: { document, authorRunId: 'author-test', facts: null, grounded: false },
  });

  test('records the exact post-write ask with its author run and output path', async () => {
    const records: unknown[] = [];
    await runGoalAuthorCli(['ask', '원문'], { cwd: process.cwd() }, { write, recordAsk: (entry) => { records.push(entry); return true; } });

    expect(records).toEqual([{
      authorRunId: 'author-test',
      goalFile: 'docs/goals/GOAL-test.md',
      ask: 'ask 원문',
      document,
    }]);
  });

  test('observes distinct success and failure events without blocking authoring', async () => {
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'goal-author' && event.startsWith('ask-provenance-')) events.push(event);
    }) as never);
    try {
      await expect(runGoalAuthorCli(['success'], { cwd: process.cwd() }, { write, recordAsk: () => true }))
        .resolves.toMatchObject({ path: 'docs/goals/GOAL-test.md' });
      await expect(runGoalAuthorCli(['failure'], { cwd: process.cwd() }, { write, recordAsk: () => { throw new Error('ledger unavailable'); } }))
        .resolves.toMatchObject({ path: 'docs/goals/GOAL-test.md' });
      expect(events).toEqual(['ask-provenance-recorded', 'ask-provenance-record-failed']);
    } finally {
      log.mockRestore();
    }
  });

  test('records clarification-child provenance for successful and failed ledger writes', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'goal-author' && event.startsWith('ask-provenance-')) events.push({ event, data });
    }) as never);
    const parentGoalFile = 'docs/goals/GOAL-parent.md';
    const parentQuestionId = 'question-1';
    try {
      await runGoalAuthorCli(['child'], { cwd: process.cwd(), parentGoalFile, parentQuestionId }, {
        readFile: (() => document) as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
        realpath: ((path: string) => path) as NonNullable<GoalAuthorCliDeps['realpath']>,
        write,
        recordAsk: () => true,
      });
      await runGoalAuthorCli(['child'], { cwd: process.cwd(), parentGoalFile, parentQuestionId }, {
        readFile: (() => document) as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
        realpath: ((path: string) => path) as NonNullable<GoalAuthorCliDeps['realpath']>,
        write,
        recordAsk: () => false,
      });
      expect(events).toEqual([
        { event: 'ask-provenance-recorded', data: { authorRunId: 'author-test', goalFile: 'docs/goals/GOAL-test.md', askChars: 5, origin: 'clarification-child', parentGoalFile, parentQuestionId } },
        { event: 'ask-provenance-record-failed', data: { authorRunId: 'author-test', goalFile: 'docs/goals/GOAL-test.md', askChars: 5, origin: 'clarification-child', parentGoalFile, parentQuestionId } },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('records answered-clarification reauthor provenance without parent fields', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'goal-author' && event.startsWith('ask-provenance-')) events.push({ event, data });
    }) as never);
    try {
      await runGoalAuthorCli(['reauthor'], { cwd: process.cwd(), reauthorFromAnsweredClarification: true }, { write, recordAsk: () => true });
      expect(events).toEqual([
        { event: 'ask-provenance-recorded', data: { authorRunId: 'author-test', goalFile: 'docs/goals/GOAL-test.md', askChars: 8, origin: 'answered-clarification-reauthor' } },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('records direct-request provenance when no parent or reauthor input is supplied', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'goal-author' && event.startsWith('ask-provenance-')) events.push({ event, data });
    }) as never);
    try {
      await runGoalAuthorCli(['direct'], { cwd: process.cwd() }, { write, recordAsk: () => true });
      expect(events).toEqual([
        { event: 'ask-provenance-recorded', data: { authorRunId: 'author-test', goalFile: 'docs/goals/GOAL-test.md', askChars: 6, origin: 'direct-request' } },
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('runGoalAuthorCli superseded original ask extraction', () => {
  const write: NonNullable<GoalAuthorCliDeps['write']> = async (ask) => ({
    path: 'docs/goals/GOAL-test.md',
    authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test', facts: null, grounded: false },
  });

  test('delegates a valid fenced CRLF ask to verbatimOriginalAsk without changing its line endings', async () => {
    const document = [
      '## PROBLEM',
      'Original ask (verbatim, unmodified):',
      '```',
      'first line',
      'second line',
      '```',
    ].join('\r\n');
    const writeSpy = spyOn({ write }, 'write');

    await runGoalAuthorCli([], { cwd: process.cwd(), supersedes: 'docs/goals/GOAL-parent.md' }, {
      readFile: (() => document) as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
      write: writeSpy,
      recordAsk: () => true,
    });

    expect(writeSpy).toHaveBeenCalledWith(
      'first line\r\nsecond line',
      process.cwd(),
      expect.objectContaining({ clarificationAnswers: {}, decomposeSteps: expect.any(Function) }),
      { supersedes: { path: expect.stringContaining('docs/goals/GOAL-parent.md') } },
    );
  });

  test.each([
    ['missing marker', '## PROBLEM\nbody', 'superseded goal original ask marker not found'],
    ['missing fence', 'Original ask (verbatim, unmodified):\nbody', 'superseded goal original ask fence missing'],
    ['unclosed fence', 'Original ask (verbatim, unmodified):\n```\nbody', 'superseded goal original ask fence not closed'],
  ])('preserves the distinct %s error', async (_case, document, error) => {
    let caught: unknown;
    try {
      await runGoalAuthorCli([], { cwd: process.cwd(), supersedes: 'docs/goals/GOAL-parent.md' }, {
        readFile: (() => document) as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
        write,
      });
    } catch (reason) {
      caught = reason;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(error);
  });
});

describe('runGoalAuthorCli interview round observation', () => {
  test('links an interview-round classification to the authored goal and run', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'goal-author') events.push({ event, data });
    }) as never);
    try {
      await runGoalAuthorCli(['next ask'], { cwd: process.cwd(), supersedes: 'docs/goals/GOAL-parent.md' }, {
        readFile: (() => '- GoalId: parent\n') as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
        write: async () => ({
          path: 'docs/goals/GOAL-next.md',
          authored: { document: '- GoalId: next\n', authorRunId: 'author-next', facts: null, grounded: false },
        }),
        recordAsk: () => true,
      });
      expect(events).toContainEqual({
        event: 'interview-round-classified',
        data: {
          authorRunId: 'author-next',
          goalFile: 'docs/goals/GOAL-next.md',
          status: 'converged',
          previousClarifications: 0,
          nextClarifications: 0,
          previousEvidence: 0,
          nextEvidence: 0,
        },
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe('runGoalAuthorCli ask prose title forwarding', () => {
  const titledAsk = ['대상 경로: src/a.ts', '제목: 무언가를 고친다', '', '본문'].join('\n');
  const untitledAsk = ['대상 경로: src/a.ts', '', '본문'].join('\n');
  const write: NonNullable<GoalAuthorCliDeps['write']> = async () => ({
    path: 'docs/goals/GOAL-test.md',
    authored: { document: '- GoalId: 0123456789abcdef\n', authorRunId: 'author-test', facts: null, grounded: false },
  });
  const parentGoalFile = 'docs/goals/GOAL-parent.md';
  const parentQuestionId = 'question-1';
  const parentRead = {
    readFile: (() => '- GoalId: 0123456789abcdef\n') as unknown as NonNullable<GoalAuthorCliDeps['readFile']>,
    realpath: ((path: string) => path) as NonNullable<GoalAuthorCliDeps['realpath']>,
  };

  test('forwards the extracted prose title on the direct branch', async () => {
    const deps = { write, recordAsk: () => true };
    const writeSpy = spyOn(deps, 'write');
    await runGoalAuthorCli([titledAsk], { cwd: process.cwd() }, deps);
    expect(writeSpy.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ goalTitle: '무언가를 고친다' }));
  });

  test('forwards the extracted prose title on the parent-goal branch', async () => {
    const deps = { write, recordAsk: () => true, ...parentRead };
    const writeSpy = spyOn(deps, 'write');
    await runGoalAuthorCli([titledAsk], { cwd: process.cwd(), parentGoalFile, parentQuestionId }, deps);
    expect(writeSpy.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ goalTitle: '무언가를 고친다' }));
  });

  test('omits the goalTitle key when the ask has no prose title and does not forward the full ask', async () => {
    const deps = { write, recordAsk: () => true };
    const writeSpy = spyOn(deps, 'write');
    await runGoalAuthorCli([untitledAsk], { cwd: process.cwd() }, deps);
    const authorDeps = writeSpy.mock.calls[0]?.[2];
    expect(Object.prototype.hasOwnProperty.call(authorDeps, 'goalTitle')).toBeFalse();
    expect(authorDeps?.goalTitle).toBeUndefined();
    expect(writeSpy.mock.calls[0]?.[0]).toBe(untitledAsk);
    expect(JSON.stringify(authorDeps)).not.toContain(untitledAsk);
  });

  test('authors a document whose first line is the extracted prose title instead of the path header', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-cli-title-'));
    try {
      const result = await runGoalAuthorCli([titledAsk], { cwd }, {
        recordAsk: () => true,
        decomposeSteps: async () => [],
        write: (ask, authorCwd, authorDeps, supersedes) => writeAuthoredGoal(ask, authorCwd, {
          ground: async () => ({ grounded: false, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
          enhance: async (verbatimAsk) => ({ original: verbatimAsk, checklist: [], verbatimPreserved: true }),
          slugFn: async () => 'prose-title',
          ...authorDeps,
        }, supersedes),
      });
      const firstLine = readFileSync(result.path, 'utf8').split(/\r?\n/, 1)[0];
      expect(firstLine).toBe('무언가를 고친다');
      expect(firstLine.startsWith('대상 경로:')).toBeFalse();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('observes distinct values when a prose title is forwarded versus omitted', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'goal-author' && event === 'goal-title-forwarded') events.push({ event, data });
    }) as never);
    try {
      await runGoalAuthorCli([titledAsk], { cwd: process.cwd() }, { write, recordAsk: () => true });
      await runGoalAuthorCli([untitledAsk], { cwd: process.cwd() }, { write, recordAsk: () => true });
      expect(events).toEqual([
        { event: 'goal-title-forwarded', data: { passed: true, titleChars: '무언가를 고친다'.length } },
        { event: 'goal-title-forwarded', data: { passed: false } },
      ]);
      expect(events[0]?.data).not.toEqual(events[1]?.data);
    } finally {
      log.mockRestore();
    }
  });

  test('preserves preexisting parent-branch authorDeps keys and values when a title is forwarded', async () => {
    const decomposeSteps = async () => [];
    const deps = { write, recordAsk: () => true, decomposeSteps, ...parentRead };
    const writeSpy = spyOn(deps, 'write');
    const opts = { cwd: process.cwd(), parentGoalFile, parentQuestionId, rootIntent: 'keep parent keys', goalType: 'implement' as const };

    await runGoalAuthorCli([untitledAsk], opts, deps);
    await runGoalAuthorCli([titledAsk], opts, deps);

    const withoutTitle = writeSpy.mock.calls[0]?.[2] as Record<string, unknown>;
    const withTitle = writeSpy.mock.calls[1]?.[2] as Record<string, unknown>;
    const withoutKeys = Object.keys(withoutTitle).sort();
    expect(withoutKeys).not.toContain('goalTitle');
    expect(Object.keys(withTitle).sort()).toEqual([...withoutKeys, 'goalTitle'].sort());
    for (const key of withoutKeys) {
      expect(withTitle[key]).toEqual(withoutTitle[key]);
    }
    expect(withTitle).toEqual(expect.objectContaining({
      parent: { goalFile: parentGoalFile, questionId: parentQuestionId },
      parentDocument: '- GoalId: 0123456789abcdef\n',
      clarificationAnswers: undefined,
      decomposeSteps,
      rootIntent: 'keep parent keys',
      goalType: 'implement',
      goalTitle: '무언가를 고친다',
    }));
  });
});

describe('runGoalAuthorCli goal type', () => {
  const write: NonNullable<GoalAuthorCliDeps['write']> = async (_ask, _cwd, authorDeps) => ({
    path: 'docs/goals/GOAL-test.md',
    authored: { document: `- GoalType: ${authorDeps?.goalType ?? 'implement'}\n`, authorRunId: 'author-test', facts: null, grounded: false },
  });

  test('forwards a canonical goal type to the author', async () => {
    const deps = { write };
    const writeSpy = spyOn(deps, 'write');
    await runGoalAuthorCli(['research ask'], { cwd: process.cwd(), goalType: 'research' }, deps);
    expect(writeSpy).toHaveBeenCalledWith('research ask', process.cwd(), expect.objectContaining({ goalType: 'research', decomposeSteps: expect.any(Function) }), undefined);
  });

  test('preserves omitted goal type by omitting it from author dependencies', async () => {
    const deps = { write };
    const writeSpy = spyOn(deps, 'write');
    await runGoalAuthorCli(['default ask'], { cwd: process.cwd() }, deps);
    expect(writeSpy).toHaveBeenCalledWith('default ask', process.cwd(), expect.objectContaining({ decomposeSteps: expect.any(Function) }), undefined);
  });

  test('uses an injected decomposition seam to render STEPS without invoking the default LLM seam', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-cli-decompose-'));
    const decomposeSteps = async () => ['inspect shared seam', 'write regression test'];
    try {
      const result = await runGoalAuthorCli(['implement ask'], { cwd }, {
        decomposeSteps,
        write: (ask, authorCwd, authorDeps, supersedes) => writeAuthoredGoal(ask, authorCwd, {
          ground: async () => ({ grounded: false, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
          enhance: async (verbatimAsk) => ({ original: verbatimAsk, checklist: [], verbatimPreserved: true }),
          slugFn: async () => 'decompose',
          ...authorDeps,
        }, supersedes),
      });
      expect(readFileSync(result.path, 'utf8')).toContain('## STEPS\n- inspect shared seam\n- write regression test');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('preserves omitted adversarial review and forwards explicit CLI selections and source to the shared decomposition seam', async () => {
    const received: Array<{ adversarialReview?: boolean; adversarialReviewSource?: 'cli' | 'default' | 'unknown'; recentStepCounts?: readonly number[] }> = [];
    const createDecomposeSteps: NonNullable<GoalAuthorCliDeps['createDecomposeSteps']> = (_signal, config = {}) => {
      received.push(config);
      return async () => [];
    };
    const write: NonNullable<GoalAuthorCliDeps['write']> = async () => ({
      path: 'docs/goals/GOAL-test.md',
      authored: { document: '', authorRunId: 'author-test', facts: null, grounded: false },
    });

    await runGoalAuthorCli(['default ask'], { cwd: process.cwd() }, { createDecomposeSteps, write, recentStepCountReader: () => [] });
    await runGoalAuthorCli(['forced ask'], { cwd: process.cwd(), adversarialReview: true }, { createDecomposeSteps, write, recentStepCountReader: () => [] });
    await runGoalAuthorCli(['disabled ask'], { cwd: process.cwd(), disableAdversarialReview: true }, { createDecomposeSteps, write, recentStepCountReader: () => [] });

    expect(received).toEqual([
      { recentStepCounts: [] },
      { adversarialReview: true, adversarialReviewSource: 'cli', recentStepCounts: [] },
      { adversarialReview: false, adversarialReviewSource: 'cli', recentStepCounts: [] },
    ]);
  });

  test('forwards below-threshold recent step counts to the shared unreachable-observation seam', async () => {
    const received: Record<string, unknown>[] = [];
    await runGoalAuthorCli(['ask'], { cwd: process.cwd() }, {
      recentStepCountReader: () => [3, 2],
      createDecomposeSteps: (_signal, config = {}) => {
        received.push(config);
        return async () => [];
      },
      write: async () => ({ path: 'docs/goals/GOAL-test.md', authored: { document: '', authorRunId: 'author-test', facts: null, grounded: false } }),
    });
    expect(received).toEqual([expect.objectContaining({ recentStepCounts: [3, 2] })]);
  });

  test('forwards threshold-reaching recent step counts to let the shared seam suppress the observation', async () => {
    const received: Record<string, unknown>[] = [];
    await runGoalAuthorCli(['ask'], { cwd: process.cwd() }, {
      recentStepCountReader: () => [3, 10],
      createDecomposeSteps: (_signal, config = {}) => {
        received.push(config);
        return async () => [];
      },
      write: async () => ({ path: 'docs/goals/GOAL-test.md', authored: { document: '', authorRunId: 'author-test', facts: null, grounded: false } }),
    });
    expect(received).toEqual([expect.objectContaining({ recentStepCounts: [3, 10] })]);
  });

  test('continues authoring and omits recent step counts when the reader throws', async () => {
    const received: Record<string, unknown>[] = [];
    const createDecomposeSteps: NonNullable<GoalAuthorCliDeps['createDecomposeSteps']> = (_signal, config = {}) => {
      received.push(config);
      return async () => [];
    };
    const result = await runGoalAuthorCli(['ask'], { cwd: process.cwd() }, {
      recentStepCountReader: () => { throw new Error('log store unavailable'); },
      createDecomposeSteps,
      write: async () => ({ path: 'docs/goals/GOAL-test.md', authored: { document: '', authorRunId: 'author-test', facts: null, grounded: false } }),
    });
    expect(result.path).toBe('docs/goals/GOAL-test.md');
    expect(received).toEqual([{}]);
    expect(Object.hasOwn(received[0] ?? {}, 'recentStepCounts')).toBeFalse();
    expect(Object.hasOwn(received[0] ?? {}, 'adversarialReview')).toBeFalse();
    expect(Object.hasOwn(received[0] ?? {}, 'adversarialReviewSource')).toBeFalse();
  });

  test('rejects conflicting adversarial review CLI selections before authoring', async () => {
    const write = spyOn({ write: async () => ({ path: 'docs/goals/GOAL-test.md', authored: { document: '', authorRunId: 'author-test', facts: null, grounded: false } }) }, 'write');
    await expect(runGoalAuthorCli(['ask'], {
      cwd: process.cwd(),
      adversarialReview: true,
      disableAdversarialReview: true,
    }, { write })).rejects.toThrow('--adversarial-review and --disable-adversarial-review cannot be supplied together');
    expect(write).not.toHaveBeenCalled();
  });

  test('forwards the seam for research without invoking it', async () => {
    const decomposeSteps = async () => {
      throw new Error('research must not decompose');
    };
    await runGoalAuthorCli(['research ask'], { cwd: process.cwd(), goalType: 'research' }, {
      decomposeSteps,
      write: async (_ask, _cwd, authorDeps) => {
        expect(authorDeps?.goalType).toBe('research');
        expect(authorDeps?.decomposeSteps).toBe(decomposeSteps);
        return { path: 'docs/goals/GOAL-test.md', authored: { document: '', authorRunId: 'author-test', facts: null, grounded: false } };
      },
    });
  });

  test('rejects an invalid goal type before authoring and lists canonical values', async () => {
    const deps = { write };
    const writeSpy = spyOn(deps, 'write');
    await expect(runGoalAuthorCli(['invalid ask'], { cwd: process.cwd(), goalType: 'invalid' }, deps))
      .rejects.toThrow('invalid goal type "invalid"; expected one of: implement, research, document, operate');
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('formatGoalInterviewRound', () => {
  const convergedRound = {
    status: 'converged' as const,
    previousClarifications: 1,
    nextClarifications: 0,
    previousEvidence: 5,
    nextEvidence: 2,
  };

  test('shows a lint-blocked re-authored goal despite converged interview status', () => {
    expect(formatGoalInterviewRound(convergedRound, 1)).toBe(
      'interview round: converged — 열린 질문이 없어져 좁아진 인터뷰가 끝났습니다. · evidence: 5 → 2 · launch: blocked (1 lint error)',
    );
  });

  test('shows evidence counts and launch readiness with the unchanged converged meaning', () => {
    expect(formatGoalInterviewRound(convergedRound, 0)).toBe(
      'interview round: converged — 열린 질문이 없어져 좁아진 인터뷰가 끝났습니다. · evidence: 5 → 2 · launch: ready (0 lint errors)',
    );
  });
});

describe('formatGoalAuthorSelfInspection', () => {
  test('passes existing decision classifiers into the production press policy', () => {
    const kinds = inspectDecisionSignalKinds('## 판정 신호\n- Condition: c\n- Observation: o\n- Expected result: e');
    const observations = inspectDecisionObservations(kinds);

    expect(kinds).toEqual({ condition: true, observation: true, expected: true });
    expect(observations).toEqual({ extracted: true });
    expect(formatGoalAuthorSelfInspection('## 판정 신호\n- Condition: c\n- Observation: o\n- Expected result: e', [])).toContain(
      'decision signal: extracted=true · condition=true · observation=true · expected=true',
    );
  });

  test('preserves every lint finding and reports plan signals plus extracted decision-signal fields', () => {
    const document = [
      '- Checkable requested criterion: inspect the authored document',
      '- UNVERIFIABLE: pending evidence',
      '## 판정 신호',
      '- Candidate decision signal:',
      '  - Condition: author without --supersedes',
      '  - Observation: complete command output',
      '  - Expected result: inspection output',
    ].join('\n');
    const findings: GoalFileLintFinding[] = [
      { level: 'ERROR', tag: 'evidence-section', message: 'required evidence missing' },
      { level: 'WARN', tag: 'boundary-size', message: 'boundary is broad' },
    ];

    expect(formatGoalAuthorSelfInspection(document, findings)).toBe([
      'ERROR [evidence-section] required evidence missing — origin: goal documents omitted required evidence per acceptance criterion (reference: git:dfe0b41a9 (#6387))',
      'WARN [boundary-size] boundary is broad — origin: unselected candidate lists inflated scope boundaries (reference: git:c28fd5fbe (#6406))',
      JSON.stringify({
        goalId: null,
        persistentEvidenceTargetPathCount: null,
        persistentEvidenceOutsideTargetPathCount: null,
        tracedPathMissing: 0,
        tracedPathOutside: 0,
        unansweredClarification: 0,
        unverifiable: 1,
        unverifiableInvariantCandidates: 0,
        normalizedMarkerSuccess: 0,
        normalizedMarkerFailure: 0,
        requestedCriteria: 1,
        contradiction: 0,
        unverifiableLines: ['- UNVERIFIABLE: pending evidence'],
        contradictionLines: [],
      }),
      'launch: blocked (1 blocking lint error; 1 informational unverifiable item)',
      'decision signal: extracted=true · condition=true · observation=true · expected=true',
    ].join('\n'));
  });

  test('reports unverifiable plan-gate items as informational when no lint error blocks launch', () => {
    const document = '- UNVERIFIABLE: pending evidence';

    expect(formatGoalAuthorSelfInspection(document, [])).toContain(
      'launch: ready (0 blocking lint errors; 1 informational unverifiable item)',
    );
  });

  test.each([
    ['an inline signal outside the section', '판정 신호: condition = c; observation = o; expected result = e', 'decision signal: extracted=false · condition=false · observation=false · expected=false'],
    ['a document without the decision-signal heading', '- Candidate decision signal:\n  - Condition: c\n  - Observation: o\n  - Expected result: e', 'decision signal: extracted=false · condition=false · observation=false · expected=false'],
    ['fields outside an empty decision-signal section', '- Candidate decision signal:\n  - Condition: c\n  - Observation: o\n  - Expected result: e\n\n## 판정 신호\n\n## 다음 절\ntext', 'decision signal: extracted=false · condition=false · observation=false · expected=false'],
    ['a section with a missing condition field', '## 판정 신호\n- Candidate decision signal:\n  - Observation: o\n  - Expected result: e', 'decision signal: extracted=false · condition=false · observation=true · expected=true'],
    ['a section with a missing observation field', '## 판정 신호\n- Candidate decision signal:\n  - Condition: c\n  - Expected result: e', 'decision signal: extracted=false · condition=true · observation=false · expected=true'],
    ['a section with a missing expected-result field', '## 판정 신호\n- Candidate decision signal:\n  - Condition: c\n  - Observation: o', 'decision signal: extracted=false · condition=true · observation=true · expected=false'],
  ])('reports the independent decision-signal fields for %s', (_case, document, expected) => {
    expect(formatGoalAuthorSelfInspection(document, [])).toContain(expected);
  });
});
