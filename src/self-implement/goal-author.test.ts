import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { authorGoal, resolveGoalAuthorGrade, boundaryLinesVerbatim, classifyAbsentFirstPathPresence, defaultGoalAuthorDeps, PARENT_BOUNDARY_HEADER, parentBoundaryLines, _setGoalAuthorPersistentGroundingDepsForTesting, resolveGoalAuthorPersistentGrounding, rfcGoalProseSection, classifyAcceptanceCriterionEvidence, classifyGoalCommandExecution, classifyGroundingFailure, countAuthoredGroundingPathSections, countMissingAuthoredConstraintMarkers, goalFileName, goalContextEvidence, groundForGoalAuthor, GOAL_RULES_POLICY, EVIDENCE_LOCATION_REQUIREMENT, IMPLEMENTATION_TARGET_CLARIFICATION, inspectArtifactLaunchDeclaration, linesOutsideFencedCode, inspectAskBoundaryMarker, inspectAskDecisionSignalMarker, inspectAskInvariantMarker, inspectTestScenarioDeclaration, lintGoalFile, markUntranscribedCriteria, markdownSection, parseArtifactLaunchDeclaration, parseAskFile, parseGoalId, parseRootIntent, parseTestScenarioDeclaration, planGateSignals, requiresImplementationTargetClarification, tracedPathReferences, writeAuthoredGoal, type GoalAuthorDeps, ASK_INVARIANT_MARKER, ASK_DECISION_SIGNAL_MARKER, ASK_BOUNDARY_MARKER, askSectionCountInformation, hasUnmetRequirementOutsidePreservationClause, WIRING_CRITERION_LINE, extractVerbatimOriginalAsk, verbatimOriginalAsk, ORIGINAL_ASK_MARKER, GOAL_FILE_LINT_ORIGINS, formatGoalFileLintFinding, allNegativeSignalsLintMessage, unreadableSignalsLintMessage, type GoalFileLintTag, summarizeGroundingFileKinds} from './goal-author.js';
import { groundMissionInCodebase } from '../autopilot/mission-codebase-gate.js';
import { REQUIRED_EVIDENCE_COMMAND_SEPARATOR, requiredEvidenceFromGoal } from './off-diff-evidence.js';
import { setMissionSlugStreamForTest } from '../autopilot/mission-registry.js';
import { debug } from '../debug/log.js';
import { parseReleaseNoteSection } from '../release-loop/release-note.js';
import { applyHarnessPolicy } from './harness-policy.js';
import { requestTestScenario, type TestScenarioLaunchInput } from './test-scenario-request.js';
import { parseGoalAuthorClarifications, parseGoalAuthorParent, parseGoalDocumentClarifications, serializeGoalAuthorClarification } from './goal-author-clarification.js';
import type { IntakeClarification } from '../autopilot/mission-intake-clarify.js';
import type { SkillIndexEntry } from '../skills/index.js';

const ask = 'Preserve this exact ask: <&> keep every character.';
const IMPLEMENT_PRESERVATION_REFERENCE = '- Checkable preservation criterion: Current-state observation from grounding is listed in the traced-path section; if it conflicts with this goal\'s requested criteria, the requested criteria take priority.';
// ⭐ 2026-09-25 — 저장소 뿌리 점 파일(`.artifact-launch-inspection-fixture.md`)을 읽던 것을 «내용»으로 옮겼다 — 공개본엔 그 파일이 없다(🅣 공개 시험 대조).
const ARTIFACT_LAUNCH_INSPECTION_FIXTURE_TEXT = '## 산출물을 어떻게 켜나\nEntrypoint: src/server.ts\nPort: 4310\nEnvironment: API_TOKEN, LOG_LEVEL\n';   // 끝 줄바꿈까지 원 파일과 같다(줄 번호가 문다)

const GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION = `## PROBLEM
content

## WHAT TO BUILD
content

## ACCEPTANCE CRITERIA
content

## REQUIRED EVIDENCE
- [requested] focused test output

## TRACED PATHS
1. src/example.ts — existing path

## SCOPE BOUNDARY
- Boundary decision: only this document is inspected.

## 답하지 못하는 것
- 없다.

## 불변식
- Invariant candidate: existing markers remain unchanged.

## 판정 신호
- Candidate decision signal:
  - Condition: inspect the established document
  - Observation: lintGoalFile receives it
  - Expected result: established output remains unchanged

대상 경로: src/example.ts`;

/**
 * ⭐ 근거는 이제 **집계기 산출(CodebaseGrounding)** 이다 — 종류별로 갈려 있고 배열이 아니다.
 * ⛔ 2026-07-28 실측: #5823 이 헬퍼만 새 계약으로 바꾸고 호출부·테스트를 안 고쳐
 *   `elanous self author` 가 `ReferenceError` 로 크래시한 채 **자동 머지**됐다.
 *   이 fixture 가 그 반쪽 상태를 다시 통과시키지 않는다.
 */
const facts = {
  grounded: true, context: '',
  files: ['src/example.ts'],
  persistentEvidence: ['src/example.ts:42 — authorGoal receives this Read-verified call path.'],
  codeFacts: ['[code:src/example.ts] exampleExport'],
  skillFacts: ['[skill:absorb] SKILL.md 계약'],
  memoryFacts: ['[memory] 전에 비슷한 일을 했다'],
  documentFacts: ['docs/example.md'],
  documentMatches: [{ path: 'docs/example.md', score: 11, matchedTerms: ['example'], excerpt: 'Example author contract.' }],
  searchTerms: ['example'],
  genericSearchScope: false,
  refFacts: ['[ref] 로컬 문서 요약'],
  ptyFacts: [],
};
/** 근거 없음 — 집계기의 미grounded 산출. */
const noFacts = { grounded: false, context: '', files: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] };
const deps: GoalAuthorDeps = {
  ground: async () => facts,
  enhance: async (raw) => ({
    original: raw,
    checklist: ['embed the exact ask in the authored document'],
    verbatimPreserved: true,
  }),
  slugFn: async () => 'readable-goal-summary',
};
const temporaryDirectories: string[] = [];

/** Existing-ledger fixture: these tests assert the historical docs/goals placement. */
function existingGoalDocumentsRoot(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
  return cwd;
}

afterEach(() => {
  _setGoalAuthorPersistentGroundingDepsForTesting();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('goal author grade', () => {
  test('flag overrides config; absent and malformed configuration preserve full', () => {
    expect(resolveGoalAuthorGrade('lite', 'full')).toEqual({ grade: 'lite', source: 'flag' });
    expect(resolveGoalAuthorGrade(undefined, 'lite')).toEqual({ grade: 'lite', source: 'config' });
    expect(resolveGoalAuthorGrade(undefined, 'unknown')).toEqual({ grade: 'full', source: 'default' });
    expect(resolveGoalAuthorGrade()).toEqual({ grade: 'full', source: 'default' });
  });

  test('AUTHOR-LITE2-POD: env ELANOUS_AUTHOR_GRADE sits between flag and config; invalid env is ignored', () => {
    expect(resolveGoalAuthorGrade(undefined, 'full', 'lite')).toEqual({ grade: 'lite', source: 'env' });
    expect(resolveGoalAuthorGrade('full', 'lite', 'lite')).toEqual({ grade: 'full', source: 'flag' });
    expect(resolveGoalAuthorGrade(undefined, 'lite', undefined)).toEqual({ grade: 'lite', source: 'config' });
    expect(resolveGoalAuthorGrade(undefined, undefined, 'bogus')).toEqual({ grade: 'full', source: 'default' });
  });

  test('same ask: lite omits three phases and retains falsifiable signal and pointers; default full runs them', async () => {
    const sentence = '대상 경로: src/example.ts · 체크리스트 칸 AUTHOR-LITE2. 판정선(반증): output contains signal.';
    const run = async (grade?: 'lite' | 'full') => {
      const progress: Array<{ phase: string; event: string }> = [];
      const ground = mock(async () => facts);
      const decomposeSteps = mock(async () => ['Investigate and implement the requested change.']);
      const authored = await authorGoal(sentence, {
        ...deps,
        ground,
        decomposeSteps,
        ...(grade ? { authorGrade: { grade, source: 'flag' } as const } : {}),
        onProgress: (phase, event) => progress.push({ phase, event }),
      });
      return { authored, progress, ground, decomposeSteps };
    };
    const gradeEvents: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const originalLog = debug.log;
    debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (event === 'author-grade' && category === 'harness.author') gradeEvents.push({ category, event, data });
    }) as typeof debug.log;
    let lite: Awaited<ReturnType<typeof run>>;
    let full: Awaited<ReturnType<typeof run>>;
    try {
      lite = await run('lite');
      full = await run();
    } finally {
      debug.log = originalLog;
    }
    expect(gradeEvents).toEqual([
      { category: 'harness.author', event: 'author-grade', data: { authorRunId: lite.authored.authorRunId, grade: 'lite', source: 'flag', skippedPhases: ['adversarial-review', 'goal-steps-decomposed', 'persistent-grounding'] } },
      { category: 'harness.author', event: 'author-grade', data: { authorRunId: full.authored.authorRunId, grade: 'full', source: 'default', skippedPhases: [] } },
    ]);
    expect(lite.progress.filter((event) => event.event === 'end').length).toBeLessThan(full.progress.filter((event) => event.event === 'end').length);
    for (const phase of ['adversarial-review', 'goal-steps-decomposed', 'persistent-grounding']) {
      expect(lite.progress.filter((event) => event.phase === phase)).toHaveLength(0);
    }
    expect(lite.ground).not.toHaveBeenCalled();
    expect(lite.decomposeSteps).not.toHaveBeenCalled();
    expect(full.ground).toHaveBeenCalled();
    expect(full.decomposeSteps).toHaveBeenCalled();
    expect(lite.authored.document).toContain('## 판정 신호');
    expect(lite.authored.document).not.toContain('## 검증 시나리오');
    expect(lintGoalFile(lite.authored.document, 'main').filter((finding) => finding.level === 'ERROR')).toEqual([]);
    expect(lite.authored.document).toContain('output contains signal');
    expect(lite.authored.document).toContain('src/example.ts');
    expect(lite.authored.document).toContain('AUTHOR-LITE2');
    expect(lite.authored.document).toContain(`\`\`\`\n${sentence}\n\`\`\``);
    expect(full.authored.document).toContain('## PROBLEM');
  });
});

describe('goal author grounding failure classifier', () => {
  test('classifies completed repository grounding with no persistent evidence as a request needing current behavior', () => {
    const result = classifyGroundingFailure({
      categorizedEvidenceCount: 0,
      persistentEvidenceCount: 0,
      persistentStopReason: 'goal_complete',
      codeChannel: 'ok',
      workingDirectory: 'repository',
    });

    expect(result.root).toBe('request-needs-current-behavior');
    expect(result.prescription).toContain('Revise the request');
  });

  test.each([
    [{ categorizedEvidenceCount: 0, persistentEvidenceCount: 0, persistentStopReason: 'goal_complete', codeChannel: 'ok', workingDirectory: 'outside-repository' }, 'working-directory-not-repository', 'do not revise the request'],
    [{ categorizedEvidenceCount: 0, persistentEvidenceCount: 0, codeChannel: 'failed' }, 'grounding-query-failed', 'do not revise the request'],
    [{ categorizedEvidenceCount: 0, persistentEvidenceCount: 0, persistentStopReason: 'end_turn', codeChannel: 'incomplete' }, 'grounding-query-incomplete', 'do not revise the request'],
  ] as const)('classifies the observed non-request root %#', (input, root, prescription) => {
    const result = classifyGroundingFailure(input);

    expect(result.root).toBe(root);
    expect(result.prescription).toContain(prescription);
  });

  test('does not prescribe a request rewrite when completed repository grounding found categorized evidence', () => {
    const result = classifyGroundingFailure({
      categorizedEvidenceCount: 3,
      persistentEvidenceCount: 0,
      persistentStopReason: 'goal_complete',
      codeChannel: 'ok',
      workingDirectory: 'repository',
    });

    expect(result.root).toBe('undifferentiated');
    expect(result.prescription).not.toContain('Revise the request');
    expect(result.prescription).toContain('only the persistent channel is empty');
  });

  test.each([
    { categorizedEvidenceCount: 0, persistentEvidenceCount: 0 },
    { categorizedEvidenceCount: 3, persistentEvidenceCount: 0, persistentStopReason: 'goal_complete', codeChannel: 'ok' as const },
    { categorizedEvidenceCount: 0, persistentEvidenceCount: 0, persistentStopReason: 'goal_complete', codeChannel: 'failed' as const, workingDirectory: 'repository' as const },
    { categorizedEvidenceCount: 0, persistentEvidenceCount: 0, persistentStopReason: 'goal_complete', codeChannel: 'incomplete' as const, workingDirectory: 'repository' as const },
  ])('leaves missing or contradictory signals undifferentiated', (input) => {
    const result = classifyGroundingFailure(input);

    expect(result.root).toBe('undifferentiated');
    expect(result.prescription).toMatch(/^Evidence unavailable — grounding found/);
  });

  test('retains the legacy categorized-evidence prescription for undifferentiated input', () => {
    const result = classifyGroundingFailure({ categorizedEvidenceCount: 2, persistentEvidenceCount: 0 });

    expect(result.prescription).toBe('Evidence unavailable — grounding found 2 categorized evidence items, but no persistent evidence; only the persistent channel is empty. Strengthening the ask\'s prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md');
  });
});

describe('goal author persistent grounding decision', () => {
  test.each([
    [{ persistent: false }, undefined, { enabled: false, source: 'flag' }],
    [undefined, false, { enabled: false, source: 'config' }],
    [undefined, undefined, { enabled: true, source: 'default' }],
  ] as const)('resolves %p with config %p', (direct, configured, expected) => {
    const observed: unknown[] = [];
    _setGoalAuthorPersistentGroundingDepsForTesting(() => configured, (decision) => observed.push(decision));

    const resolved = resolveGoalAuthorPersistentGrounding(direct);

    expect(resolved.decision).toEqual(expected);
    expect(resolved.deps.persistent).toBe(expected.enabled ? undefined : false);
    expect(observed).toEqual([expected]);
  });
});

describe('goal author', () => {
  test('classifies a Commander unknown command as missing-command', () => {
    expect(classifyGoalCommandExecution({ status: 1, stderr: "error: unknown command 'frobnicate'" })).toMatchObject({
      kind: 'missing-command',
      log: expect.stringContaining('not yet implemented'),
    });
  });

  test('classifies a Commander missing required argument as argument-problem', () => {
    expect(classifyGoalCommandExecution({ status: 1, stderr: "error: missing required argument 'runId'" }).kind).toBe('argument-problem');
  });

  test('classifies a clean exit as success', () => {
    expect(classifyGoalCommandExecution({ status: 0, stderr: '' }).kind).toBe('success');
  });

  test('classifies an unmatched nonzero exit as execution-failure', () => {
    expect(classifyGoalCommandExecution({ status: 1, stderr: 'error: command failed unexpectedly' }).kind).toBe('execution-failure');
  });

  test('keeps missing-command and argument-problem distinct', () => {
    expect(classifyGoalCommandExecution({ status: 1, stderr: "error: unknown command 'frobnicate'" }).kind)
      .not.toBe(classifyGoalCommandExecution({ status: 1, stderr: "error: missing required argument 'runId'" }).kind);
  });

  test('prioritizes a clean exit over unknown-command stderr text', () => {
    expect(classifyGoalCommandExecution({ status: 0, stderr: "error: unknown command 'frobnicate'" }).kind).toBe('success');
  });

  test('records successful inline elanous command help probes in Complication', async () => {
    const runHelpProbe = mock(async (argv: readonly string[]) => {
      expect(argv).toEqual(['bun', 'bin/elanous.mjs', 'self', 'author', '--help']);
      return { status: 0, stderr: '' };
    });
    const authored = await authorGoal('Run `bun bin/elanous.mjs self author`.', { ...deps, runHelpProbe });
    expect(runHelpProbe).toHaveBeenCalledTimes(1);
    expect(authored.document).toContain('`bun bin/elanous.mjs self author --help` — success — command completed successfully.');
  });

  test('records a missing inline elanous command as potentially not yet implemented', async () => {
    const authored = await authorGoal('Run `bun bin/elanous.mjs frobnicate`.', {
      ...deps,
      runHelpProbe: async () => ({ status: 1, stderr: "error: unknown command 'frobnicate'" }),
    });
    expect(authored.document).toContain('`bun bin/elanous.mjs frobnicate --help` — missing-command');
    expect(authored.document).toContain('this may be not yet implemented rather than a defect');
  });

  test('does not probe elanous command text outside inline code', async () => {
    const runHelpProbe = mock(async () => ({ status: 0, stderr: '' }));
    const authored = await authorGoal('Run bun bin/elanous.mjs self author.', { ...deps, runHelpProbe });
    expect(runHelpProbe).not.toHaveBeenCalled();
    expect(authored.document).toContain('no inline `bun bin/elanous.mjs` command was named');
  });

  test('probes only fence-outside inline elanous commands', async () => {
    const runHelpProbe = mock(async (argv: readonly string[]) => {
      expect(argv).toEqual(['bun', 'bin/elanous.mjs', 'self', 'author', '--help']);
      return { status: 0, stderr: '' };
    });
    const authored = await authorGoal([
      '```sh',
      '`bun bin/elanous.mjs fenced-backtick`',
      '```',
      '~~~sh',
      'bun bin/elanous.mjs tilde-fenced',
      '~~~',
      '    `bun bin/elanous.mjs indented`',
      'Run `bun bin/elanous.mjs self author`.',
    ].join('\n'), { ...deps, runHelpProbe });

    expect(runHelpProbe).toHaveBeenCalledTimes(1);
    expect(authored.document).toContain('`bun bin/elanous.mjs self author --help` — success');
    expect(authored.document).not.toContain('fenced-backtick --help');
    expect(authored.document).not.toContain('tilde-fenced --help');
    expect(authored.document).not.toContain('indented --help');
  });

  test('does not treat a fenced content line with a suffix as a closing fence', async () => {
    const runHelpProbe = mock(async () => ({ status: 0, stderr: '' }));
    const authored = await authorGoal([
      '```sh',
      '```not-a-close',
      '`bun bin/elanous.mjs still-fenced`',
      '```',
    ].join('\n'), { ...deps, runHelpProbe });

    expect(runHelpProbe).not.toHaveBeenCalled();
    expect(authored.document).toContain('no inline `bun bin/elanous.mjs` command was named');
    expect(authored.document).not.toContain('still-fenced --help');
  });

  test('does not probe inline code that does not start with bun bin/elanous.mjs', async () => {
    const runHelpProbe = mock(async () => ({ status: 0, stderr: '' }));
    const authored = await authorGoal('Run `bun test src/self-implement/goal-author.test.ts`.', { ...deps, runHelpProbe });
    expect(runHelpProbe).not.toHaveBeenCalled();
    expect(authored.document).toContain('no inline `bun bin/elanous.mjs` command was named');
  });

  test('records a thrown probe failure and continues probing subsequent commands', async () => {
    const runHelpProbe = mock(async (argv: readonly string[]) => {
      if (argv.includes('first-command')) throw new Error('probe executor unavailable');
      return { status: 0, stderr: '' };
    });
    const authored = await authorGoal('Run `bun bin/elanous.mjs first-command` then `bun bin/elanous.mjs self author`.', { ...deps, runHelpProbe });
    expect(runHelpProbe).toHaveBeenCalledTimes(2);
    expect(authored.document).toContain('`bun bin/elanous.mjs first-command --help` — probe-failure');
    expect(authored.document).toContain('`bun bin/elanous.mjs self author --help` — success');
  });

  test('rejects unsafe inline elanous command syntax without invoking the argv probe', async () => {
    const runHelpProbe = mock(async () => ({ status: 0, stderr: '' }));
    const unsafeCommands = [
      'bun bin/elanous.mjs self author; touch /tmp/pwned',
      'bun bin/elanous.mjs self author && touch /tmp/pwned',
      'bun bin/elanous.mjs self author | cat',
      'bun bin/elanous.mjs self author > /tmp/pwned',
      'bun bin/elanous.mjs self $(touch /tmp/pwned)',
      'bun bin/elanous.mjs self author\ntouch /tmp/pwned',
      'bun bin/elanous.mjs -- --help',
      'bun bin/elanous.mjs self -- --help',
      'bun bin/elanous.mjs self author -- --help',
    ];
    for (const command of unsafeCommands) {
      const authored = await authorGoal(`Run \`${command}\`.`, { ...deps, runHelpProbe });
      expect(authored.document).toContain('— rejected — command contains unsafe shell syntax and was not executed.');
    }
    expect(runHelpProbe).not.toHaveBeenCalled();
  });

  test('records unavailable capability when no help probe is supplied', async () => {
    const authored = await authorGoal('Run `bun bin/elanous.mjs self author`.', deps);
    expect(authored.document).toContain('`bun bin/elanous.mjs self author --help` — unavailable — no execution capability was provided.');
  });

  // Observed focused callback duration: 1.63s (one run); the 5s child timeout leaves 3.37s headroom.
  // The explicit 10s test budget remains 5s above the child timeout for assertions and cleanup.
  test('uses the default help probe from the authoring repository cwd outside that repository process', () => {
    const externalCwd = mkdtempSync(join(tmpdir(), 'goal-author-default-help-probe-process-'));
    temporaryDirectories.push(externalCwd);
    const moduleUrl = pathToFileURL(join(import.meta.dir, 'goal-author.ts')).href;
    const script = `import { writeAuthoredGoal } from ${JSON.stringify(moduleUrl)};
const facts = { grounded: true, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] };
const deps = { ground: async () => facts, enhance: async (ask) => ({ original: ask, checklist: [], verbatimPreserved: true }), slugFn: async () => 'default-help-probe' };
const result = await writeAuthoredGoal('Run \`bun bin/elanous.mjs self author\`.', ${JSON.stringify(process.cwd())}, deps, { mkdir: () => {}, write: () => {} });
console.log(result.authored.document);`;
    // Measured callback: 1.63s; 5s grants 3.37s child headroom.
    const document = execFileSync(process.execPath, ['-e', script], { cwd: externalCwd, encoding: 'utf8', timeout: 5_000 });

    expect(document).toContain('`bun bin/elanous.mjs self author --help` — success — command completed successfully.');
  // Observed child probe completes within 5s; 10s leaves assertion headroom.
  }, 10_000);

  test('records execution-failure but continues authoring when the authoring cwd is not a repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-author-default-help-probe-non-repository-'));
    temporaryDirectories.push(directory);
    const result = await writeAuthoredGoal('Run `bun bin/elanous.mjs self author`.', directory, {
      ground: async () => facts,
      enhance: deps.enhance,
      slugFn: deps.slugFn,
    }, {
      mkdir: (path) => mkdirSync(path, { recursive: true }),
      write: (path, document) => writeFileSync(path, document, { flag: 'wx' }),
    });

    expect(result.authored.document).toContain('`bun bin/elanous.mjs self author --help` — execution-failure — command execution failed with code 1.');
  });

  test('classifies explicit evidence commands with a per-kind default fallback table', () => {
    const cases = [
      ['run bun run scripts/ci-typecheck-changed.ts', 'tsc'],
      ['compile the changed source without a named command', 'default'],
      ['run bun test src/self-implement/goal-author.test.ts', 'test'],
      ['verify the focused check without a named command', 'default'],
      ['run elanous dev with the isolated TUI', 'live'],
      ['inspect the user interface without a named command', 'default'],
      ['query elanous logs for the emitted event', 'log'],
      ['inspect emitted events without a named command', 'default'],
      ['perform a mutation check and report the failure', 'mutation'],
      ['break the rule and report the failure', 'default'],
    ] as const;

    for (const [criterion, expected] of cases) {
      expect(classifyAcceptanceCriterionEvidence(criterion)).toBe(expected);
    }
  });

  test('저장소 root 밖 cwd도 단일 집계 경로로 다섯 비코드 채널을 보존한다', async () => {
    const cwd = '/tmp/author-worktree';
    const selected = await groundForGoalAuthor('ground all channels', cwd, {
      groundMission: async (_ask, options) => {
        expect(options.cwd).toBe(cwd);
        return {
          grounded: true, context: '', files: [], codeFacts: [],
          skillFacts: ['[skill:x] contract'], memoryFacts: ['[memory:x] history'], documentFacts: ['docs/context.md'],
          refFacts: ['[ref:x] reference'], ptyFacts: ['[pty:x] upstream'],
        };
      },
    });
    expect(selected.path).toBe('groundMissionInCodebase');
    expect(selected.facts.skillFacts).toHaveLength(1);
    expect(selected.facts.memoryFacts).toHaveLength(1);
    expect(selected.facts.documentFacts).toHaveLength(1);
    expect(selected.facts.refFacts).toHaveLength(1);
    expect(selected.facts.ptyFacts).toHaveLength(1);
  });

  // Observed focused callback duration: 602ms (one run); each 5s git child timeout leaves at least 4.398s headroom.
  // 자식이 «둘»(git init · git add)이라 최악은 5s×2=10s ⇒ 바깥 예산은 20s (최악의 합 + 여유 10s).
  test('forwards persistent grounding disablement while preserving ask-named seed paths and disabled observation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-grounding-'));
    try {
      mkdirSync(join(cwd, 'src/self-implement'), { recursive: true });
      writeFileSync(join(cwd, 'src/self-implement/goal-author.ts'), 'export {};\n');
      writeFileSync(join(cwd, 'src/self-implement/goal-author.test.ts'), 'export {};\n');
      // Measured callback: 602ms; each 5s git child timeout leaves at least 4.398s headroom.
      execFileSync('git', ['init'], { cwd, timeout: 5_000 });
      execFileSync('git', ['add', '.'], { cwd, timeout: 5_000 });
      let persistentLoopCalls = 0;
      let forwardedPersistent: false | undefined;
      const selected = await groundForGoalAuthor('Update src/self-implement/goal-author.ts and src/self-implement/goal-author.test.ts.', cwd, {
        persistent: false,
        groundMission: (goal, options) => {
          forwardedPersistent = options.persistent;
          return groundMissionInCodebase(goal, {
            ...options,
            searchTerms: async () => [], skillIndex: () => [], pickSkills: async () => [],
            recallMemory: () => [], recallSelf: async () => [], refDigest: () => '', listCapsules: () => [],
            persistent: options.persistent === false ? false : {
              runGoalLoop: async () => {
                persistentLoopCalls += 1;
                return { goalComplete: true, stopReason: 'goal_complete', iterations: 1, finalText: '' };
              },
            },
          });
        },
      });

      expect(forwardedPersistent).toBe(false);
      expect(selected.path).toBe('groundMissionInCodebase');
      expect(selected.facts.files).toContain('src/self-implement/goal-author.ts');
      expect(selected.facts.files).toContain('src/self-implement/goal-author.test.ts');
      expect(persistentLoopCalls).toBe(0);
      expect(selected.facts.codeChannel).toBe('disabled');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  // ⛔ 자식이 «둘»(git init · git add)이라 최악은 5s+5s=10s — 바깥이 10s 면 «바깥이 먼저» 끊는다.
  //    ⇒ 바깥 예산 = 최악의 자식 합(10s) + 여유(10s). 실측 callback 602ms.
  }, 20_000);

  // Observed focused callback duration: 585ms (one run); the 5s git child timeout leaves 4.415s headroom.
  // The explicit 10s test budget remains 5s above the child timeout for cleanup and assertions.
  test('omitting persistent grounding forwards undefined and runs the enabled channel for no candidates', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-grounding-'));
    try {
      // Measured callback: 585ms; the 5s git child timeout leaves 4.415s headroom.
      execFileSync('git', ['init'], { cwd, timeout: 5_000 });
      let persistentLoopCalls = 0;
      let forwardedPersistent: unknown = Symbol('not-called');
      const selected = await groundForGoalAuthor('Update src/not-a-candidate.ts.', cwd, {
        groundMission: (goal, options) => {
          forwardedPersistent = options.persistent;
          return groundMissionInCodebase(goal, {
            ...options,
            searchTerms: async () => [], skillIndex: () => [], pickSkills: async () => [],
            recallMemory: () => [], recallSelf: async () => [], refDigest: () => '', listCapsules: () => [],
            persistent: {
              runGoalLoop: async () => {
                persistentLoopCalls += 1;
                return { goalComplete: true, stopReason: 'goal_complete', iterations: 1, finalText: '' };
              },
            },
          });
        },
      });

      expect(forwardedPersistent).toBeUndefined();
      expect(selected.facts.files).toEqual([]);
      expect(persistentLoopCalls).toBe(1);
      expect(selected.facts.codeChannel).toBe('ok');
      expect(selected.facts.codeChannel).not.toBe('disabled');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  // Observed child call completes within 5s; 10s leaves cleanup and assertion headroom.
  }, 10_000);

  // Observed focused callback duration: 609ms (one run); the 5s git child timeout leaves 4.391s headroom.
  // The explicit 10s test budget remains 5s above the child timeout for cleanup and assertions.
  test('keeps no-candidate observation distinct from disabled persistent grounding', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-grounding-'));
    try {
      // Measured callback: 609ms; the 5s git child timeout leaves 4.391s headroom.
      execFileSync('git', ['init'], { cwd, timeout: 5_000 });
      const noCandidates = await groundForGoalAuthor('Update src/not-a-candidate.ts.', cwd, {
        groundMission: (goal, options) => groundMissionInCodebase(goal, {
          ...options,
          searchTerms: async () => [], skillIndex: () => [], pickSkills: async () => [],
          recallMemory: () => [], recallSelf: async () => [], refDigest: () => '', listCapsules: () => [],
          persistent: {
            runGoalLoop: async () => ({ goalComplete: true, stopReason: 'goal_complete', iterations: 1, finalText: '' }),
          },
        }),
      });
      const disabled = await groundForGoalAuthor('Update src/not-a-candidate.ts.', cwd, {
        persistent: false,
        groundMission: (goal, options) => groundMissionInCodebase(goal, {
          ...options,
          searchTerms: async () => [], skillIndex: () => [], pickSkills: async () => [],
          recallMemory: () => [], recallSelf: async () => [], refDigest: () => '', listCapsules: () => [],
        }),
      });

      expect(noCandidates.facts.files).toEqual([]);
      expect(noCandidates.facts.codeChannel).toBe('ok');
      expect(disabled.facts.files).toEqual([]);
      expect(disabled.facts.codeChannel).toBe('disabled');
      expect(disabled.facts.codeChannel).not.toBe(noCandidates.facts.codeChannel);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  // Observed child call completes within 5s; 10s leaves cleanup and assertion headroom.
  }, 10_000);

  const groundingDecisionCases: Array<[
    string,
    { persistent?: false } | undefined,
    boolean | undefined,
    { enabled: boolean; source: 'default' | 'flag' | 'config' },
    unknown,
  ]> = [
    ['default', undefined, undefined, { enabled: true, source: 'default' }, undefined],
    ['disabled direct flag', { persistent: false }, undefined, { enabled: false, source: 'flag' }, false],
    ['disabled config', undefined, false, { enabled: false, source: 'config' }, false],
  ];

  test.each(groundingDecisionCases)('emits persistent grounding result metrics from the resolved %s decision through the existing observeGoalAuthor path', async (_name, persistentGrounding, configured, expected, expectedForwardedPersistent) => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const observed: unknown[] = [];
    _setGoalAuthorPersistentGroundingDepsForTesting(() => configured, (decision) => observed.push(decision));
    let forwardedGroundingDeps: unknown = Symbol('not-called');
    try {
      await authorGoal(ask, {
        ...deps,
        ...(persistentGrounding === undefined ? {} : { persistentGrounding }),
        ground: async (_ask, groundingDeps) => {
          forwardedGroundingDeps = groundingDeps?.persistent;
          return facts;
        },
      });
      const observations = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && event === 'persistent-grounding-decision')
        .map(([, , data]) => data);

      expect(observed).toEqual([
        expected,
        {
          ...expected,
          authorRunId: expect.any(String),
          grounded: true,
          groundingError: false,
          fileCount: 1,
          // ⭐ 접지가 «어떤 종류»를 봤나 — 합은 fileCount 와 같아야 한다(분모로 쓰려면).
          fileKinds: { '.ts': 1 },
          persistentEvidenceCount: 1,
          contextChars: 0,
        },
      ]);
      expect(observations).toEqual([]);
      expect(forwardedGroundingDeps).toEqual(expectedForwardedPersistent);
    } finally {
      _setGoalAuthorPersistentGroundingDepsForTesting();
      log.mockRestore();
    }
  });

  test('emits persistent grounding result metrics through the existing observeGoalAuthor execution path', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await authorGoal(ask, deps);
      const observations = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && event === 'persistent-grounding-decision')
        .map(([, , data]) => data);

      expect(observations).toContainEqual({
        enabled: true,
        source: 'default',
        authorRunId: expect.any(String),
        grounded: true,
        groundingError: false,
        fileCount: 1,
        // ⭐ 접지가 «어떤 종류»를 봤나 — 합은 fileCount 와 같아야 한다(분모로 쓰려면).
        fileKinds: { '.ts': 1 },
        persistentEvidenceCount: 1,
        contextChars: 0,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('emits persistent grounding failure metrics without changing phase-end observations', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await authorGoal(ask, { ...deps, ground: async () => { throw new Error('ground failed'); } });
      const result = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && event === 'persistent-grounding-decision')
        .map(([, , data]) => data)
        .find((data) => (data as { groundingError?: boolean }).groundingError === true);
      const phaseEnds = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && event === 'phase-end')
        .map(([, , data]) => data as { phase: string })
        .filter(({ phase }) => ['ground', 'enhance', 'assemble', 'lint'].includes(phase));

      expect(result).toEqual({
        enabled: true,
        source: 'default',
        authorRunId: expect.any(String),
        grounded: false,
        groundingError: true,
        fileCount: 0,
        // ⭐ 접지가 «어떤 종류»를 봤나 — 합은 fileCount 와 같아야 한다(분모로 쓰려면).
        fileKinds: {},
        persistentEvidenceCount: 0,
        contextChars: 0,
      });
      expect(phaseEnds).toHaveLength(4);
    } finally {
      log.mockRestore();
    }
  });

  test('emits ordered phase observations with durations and keeps progress off stdout', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const authored = await authorGoal(ask, {
        ...deps,
        ground: async (raw) => {
          expect(raw).toBe(ask);
          return facts;
        },
        enhance: async (raw) => ({
          original: raw,
          checklist: ['preserve the exact ask'],
          verbatimPreserved: true,
        }),
      });
      const phases = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && (event === 'phase-start' || event === 'phase-end'))
        .map(([, event, data]) => ({ event, ...(data as { phase: string; authorRunId?: string; elapsedMs?: number; inputTokens?: number | null; outputTokens?: number | null }) }))
        .filter(({ phase }) => ['ground', 'enhance', 'assemble', 'lint'].includes(phase));

      // ⭐ 2026-08-07 — 조인 키(authorRunId)가 «전 페이즈»에 실린다(T2). 순서·소요 계약은 그대로다.
      expect(phases).toEqual([
        { event: 'phase-start', phase: 'ground', authorRunId: expect.any(String) },
        { event: 'phase-end', phase: 'ground', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
        { event: 'phase-start', phase: 'enhance', authorRunId: expect.any(String) },
        { event: 'phase-end', phase: 'enhance', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
        { event: 'phase-start', phase: 'assemble', authorRunId: expect.any(String) },
        { event: 'phase-end', phase: 'assemble', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
        { event: 'phase-start', phase: 'lint', authorRunId: expect.any(String) },
        { event: 'phase-end', phase: 'lint', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
      ]);
      // ⛔ 그리고 여덟이 «같은» id 여야 한다 — 갈리면 곡선이 저작 하나를 여럿으로 센다.
      expect(new Set(phases.map((p) => (p as { authorRunId?: string }).authorRunId)).size).toBe(1);
      expect(phases.filter(({ event }) => event === 'phase-end').every(({ elapsedMs }) => typeof elapsedMs === 'number' && Number.isInteger(elapsedMs) && elapsedMs >= 0)).toBe(true);
      expect(stderr.mock.calls.map(([message]) => message)).toEqual([
        '[goal-author] ground started\n',
        expect.stringMatching(/^\[goal-author\] ground ended in \d+ms\n$/),
        '[goal-author] enhance started\n',
        expect.stringMatching(/^\[goal-author\] enhance ended in \d+ms\n$/),
        '[goal-author] assemble started\n',
        expect.stringMatching(/^\[goal-author\] assemble ended in \d+ms\n$/),
        '[goal-author] lint started\n',
        expect.stringMatching(/^\[goal-author\] lint ended in \d+ms\n$/),
      ]);
      expect(stdout).not.toHaveBeenCalled();
      expect(authored.document).toContain(ask);
    } finally {
      log.mockRestore();
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  test('persists a summary beside phase-end for a fake LLM authoring run', async () => {
    const originalLevel = debug.level();
    debug.setLevel('trail');
    try {
      const authored = await authorGoal('Create a test goal with a fake LLM response.', {
        ...deps,
        enhance: async (raw) => ({ original: raw, checklist: ['preserve the exact ask'], verbatimPreserved: true, enhancedBy: 'llm' }),
      });
      debug.flush();
      const rows = readFileSync(debug.path(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
        category: string; event: string; data?: { authorRunId?: string; phase?: string; elapsedMs?: number; goalChars?: number; sectionChars?: Record<string, number> };
      }).filter((row) => row.category === 'goal-author' && row.data?.authorRunId === authored.authorRunId);
      expect(rows.filter((row) => row.event === 'phase-end' && row.data?.phase === 'lint')).toHaveLength(1);
      const summaries = rows.filter((row) => row.event === 'summary');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.data).toMatchObject({
        authorRunId: authored.authorRunId,
        elapsedMs: expect.any(Number),
        goalChars: [...authored.document].length,
        sectionChars: expect.objectContaining({ PROBLEM: expect.any(Number), 'WHAT TO BUILD': expect.any(Number) }),
      });
    } finally {
      debug.setLevel(originalLevel);
    }
  });

  test('persists summary when a fake LLM goal fails lint after phase-end', async () => {
    const originalLevel = debug.level();
    debug.setLevel('trail');
    const ask = 'Generate a goal with an invalid extra heading.';
    debug.flush();
    const logStart = existsSync(debug.path()) ? readFileSync(debug.path(), 'utf8').length : 0;
    try {
      await expect(authorGoal(ask, {
        ...deps,
        enhance: async (raw) => ({ original: raw, checklist: ['line one\n## EXTRA\nline two'], verbatimPreserved: true, enhancedBy: 'llm' }),
      })).rejects.toThrow(/required blocks are not contiguous and ordered/);
      debug.flush();
      const rows = readFileSync(debug.path(), 'utf8').slice(logStart).trim().split('\n').map((line) => JSON.parse(line) as {
        category: string; event: string; data?: { authorRunId?: string; phase?: string; outcome?: string; elapsedMs?: number; goalChars?: number; sectionChars?: Record<string, number> };
      }).filter((row) => row.category === 'goal-author');
      const lintEnds = rows.filter((row) => row.event === 'phase-end' && row.data?.phase === 'lint');
      expect(lintEnds.length).toBeGreaterThan(0);
      const authorRunId = lintEnds.at(-1)?.data?.authorRunId;
      const summaries = rows.filter((row) => row.event === 'summary' && row.data?.authorRunId === authorRunId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.data).toMatchObject({ authorRunId, outcome: 'lint-failed', elapsedMs: expect.any(Number), goalChars: expect.any(Number), sectionChars: expect.objectContaining({ PROBLEM: expect.any(Number) }) });
    } finally {
      debug.setLevel(originalLevel);
    }
  });

  test('attributes reported enhancement usage to its phase and reconciles summary characters with the unchanged document', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal('What 😀\n## SCOPE BOUNDARY is quoted inside this ask', {
        ...deps,
        enhance: async (raw, opts) => {
          opts?.onUsage?.({ inputTokens: 11, outputTokens: 7 });
          opts?.onUsage?.({ inputTokens: 3, outputTokens: 2 });
          return { original: raw, checklist: [], verbatimPreserved: true };
        },
      });
      const events = log.mock.calls.filter(([category]) => category === 'goal-author');
      const phaseEnds = events.filter(([, event]) => event === 'phase-end')
        .map(([, , data]) => data as { phase: string; inputTokens: number | null; outputTokens: number | null });
      expect(phaseEnds.find(({ phase }) => phase === 'enhance')).toMatchObject({ inputTokens: 14, outputTokens: 9 });
      expect(phaseEnds.filter(({ phase }) => phase !== 'enhance').every(({ inputTokens, outputTokens }) => inputTokens === null && outputTokens === null)).toBe(true);
      const summaries = events.filter(([, event]) => event === 'summary');
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]![2] as {
        authorRunId: string; elapsedMs: number; inputTokens: number; outputTokens: number; totalTokens: number;
        goalChars: number; sectionChars: Record<string, number>;
      };
      expect(summary.authorRunId).toBe(authored.authorRunId);
      expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(summary).toMatchObject({ inputTokens: 14, outputTokens: 9, totalTokens: 23 });
      expect(summary.goalChars).toBe([...authored.document].length);
      expect(Object.values(summary.sectionChars).reduce((sum, chars) => sum + chars, 0)).toBe(summary.goalChars);
      for (const section of ['PROBLEM', 'WHAT TO BUILD', 'ACCEPTANCE CRITERIA', 'TRACED PATHS', 'SCOPE BOUNDARY', 'STEPS', '답하지 못하는 것']) {
        expect(summary.sectionChars).toHaveProperty(section);
      }
    } finally {
      log.mockRestore();
    }
  });

  test('keeps unavailable usage null in both phase-end and summary', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await authorGoal(ask, deps);
      const events = log.mock.calls.filter(([category]) => category === 'goal-author');
      const enhanceEnd = events.find(([, event, data]) => event === 'phase-end' && (data as { phase?: string }).phase === 'enhance');
      expect(enhanceEnd?.[2]).toMatchObject({ inputTokens: null, outputTokens: null });
      const summary = events.find(([, event]) => event === 'summary');
      expect(summary?.[2]).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
    } finally {
      log.mockRestore();
    }
  });

  test('R-TST19 names an unfinished lint phase instead of allowing its authoring cycle to hang', async () => {
    let lintTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectLintDeadline: ((reason?: unknown) => void) | undefined;
    const lintDeadline = new Promise<never>((_, reject) => {
      rejectLintDeadline = reject;
    });
    const observed: Array<{ phase: string; event: string }> = [];
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const authored = await Promise.race([
        authorGoal(ask, {
          ...deps,
          onProgress: (phase, event) => {
            observed.push({ phase, event });
            if (phase !== 'lint') return;
            if (event === 'start') {
              lintTimer = setTimeout(() => rejectLintDeadline?.(new Error('R-TST19: lint phase did not end within 1000ms')), 1_000);
            } else {
              clearTimeout(lintTimer);
            }
          },
        }),
        lintDeadline,
      ]);

      expect(authored.document).toContain(ask);
      expect(observed.filter(({ phase }) => phase === 'lint')).toEqual([
        { phase: 'lint', event: 'start' },
        { phase: 'lint', event: 'end' },
      ]);
      expect(stderr.mock.calls.filter(([message]) => typeof message === 'string' && message.startsWith('[goal-author] '))).toHaveLength(0);
    } finally {
      clearTimeout(lintTimer);
      stderr.mockRestore();
    }
  });

  test('warns about malformed dedicated markers before ground while continuing authoring and preserving late diagnostics', async () => {
    const cases = [
      ['판정 신호: 조건 = only condition', '판정 신호:', '- UNVERIFIABLE: Ask contains a decision-signal marker, but at least one entry did not match the required condition/observation/expected result format.'],
      ['불변식은 형식 오류다.', '불변식:', '- UNVERIFIABLE: Ask contains an invariant marker, but at least one entry did not match the required invariant format.'],
      ['경계:', '경계:', '- UNVERIFIABLE: Ask contains a boundary marker, but at least one entry did not match the required boundary format.'],
    ] as const;
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const [malformedAsk, marker, lateDiagnostic] of cases) {
        const authored = await authorGoal(malformedAsk, deps);
        const messages = stderr.mock.calls.map(([message]) => message);

        expect(messages.at(-9)).toContain(`[goal-author] marker warning: ${marker} marker is present but could not be extracted; required format:`);
        expect(messages.at(-9)).toContain('corrected example:');
        if (marker === '판정 신호:') {
          expect(messages.at(-9)).toContain('판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>');
        }
        expect(messages.at(-8)).toBe('[goal-author] ground started\n');
        expect(authored.document).toContain(lateDiagnostic);
      }
    } finally {
      stderr.mockRestore();
    }
  });

  test('reuses the document diagnostic required format and corrected example in malformed early warnings', async () => {
    const malformedAsk = '판정 신호: 조건 = only condition';
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const authored = await authorGoal(malformedAsk, deps);
      const warning = stderr.mock.calls.map(([message]) => message)
        .find((message) => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      const diagnostic = authored.document.split('\n').find((line) => line.startsWith('- UNVERIFIABLE: Ask contains a decision-signal marker'));

      expect(warning).toBeDefined();
      expect(diagnostic).toBeDefined();
      for (const guidance of [
        'required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>',
        'corrected example: 판정 신호: 조건 = malformed marker exists; 관측 = bun test src/example.test.ts; 기대 = diagnostic is rendered.',
      ]) {
        expect(warning).toContain(guidance);
        expect(diagnostic).toContain(guidance);
      }
    } finally {
      stderr.mockRestore();
    }
  });

  test('distinguishes extracted heading-form invariants, heading-only invariants, and genuine extraction failures before ground', async () => {
    const extractedHeadingAsk = '## 불변식\nheading-only diagnostic.\n불변식: src/example.ts remains unchanged.';
    const headingOnlyAsk = '## 불변식\nsrc/example.ts remains unchanged.';
    const malformedAsk = '불변식은 형식 오류다.';
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(inspectAskInvariantMarker(extractedHeadingAsk, null)).toMatchObject({ marker: true, extracted: true });
      const extracted = await authorGoal(extractedHeadingAsk, deps);
      const extractedWarnings = stderr.mock.calls.map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      expect(extractedWarnings).toEqual([
        '[goal-author] marker warning: 감싼 마커 — ## 불변식; 버려지는 문면: heading-only diagnostic.\n',
      ]);
      expect(extractedWarnings[0]).not.toContain('could not be extracted');
      expect(lintGoalFile(extracted.document, 'main')).toContainEqual(expect.objectContaining({
        level: 'WARN',
        tag: 'heading-form-marker',
        message: expect.stringContaining('heading-form invariant'),
      }));
      expect(extracted.document).toContain('corrected example: 불변식: src/example.ts remains unchanged.');
      expect(stderr.mock.calls.map(([message]) => message)).toContain('[goal-author] ground started\n');

      stderr.mockClear();
      expect(inspectAskInvariantMarker(headingOnlyAsk, null)).toMatchObject({ marker: false, extracted: false });
      const headingOnly = await authorGoal(headingOnlyAsk, deps);
      const headingOnlyWarnings = stderr.mock.calls.map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      expect(headingOnlyWarnings).toEqual([
        '[goal-author] marker warning: 감싼 마커 — ## 불변식; 버려지는 문면: src/example.ts remains unchanged.\n',
      ]);
      expect(lintGoalFile(headingOnly.document, 'main')).toContainEqual(expect.objectContaining({
        level: 'WARN',
        tag: 'heading-form-marker',
        message: expect.stringContaining('heading-form invariant'),
      }));
      expect(headingOnly.document).toContain('corrected example: 불변식: src/example.ts remains unchanged.');
      expect(stderr.mock.calls.map(([message]) => message)).toContain('[goal-author] ground started\n');

      stderr.mockClear();
      await authorGoal(malformedAsk, deps);
      const malformedWarning = stderr.mock.calls.map(([message]) => message)
        .find((message) => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      expect(malformedWarning).toContain('불변식: marker is present but could not be extracted; required format:');
      expect(malformedWarning).toContain('corrected example: 불변식: src/example.ts remains unchanged.');
      expect(malformedWarning).not.toContain('감싼 마커');
      expect(stderr.mock.calls.map(([message]) => message)).toContain('[goal-author] ground started\n');
    } finally {
      stderr.mockRestore();
    }
  });

  test('preserves wrapped-marker WARN diagnostics and leaves complete inline invariants unblocked', async () => {
    const wrappedAsk = '## 불변식\n불변식: src/example.ts remains unchanged.\n버려지는 안전 조항.';
    const completeInlineAsk = '불변식: src/example.ts remains unchanged.';
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const wrapped = await authorGoal(wrappedAsk, deps);
      const wrappedWarnings = stderr.mock.calls.map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      expect(wrappedWarnings).toEqual([
        '[goal-author] marker warning: 감싼 마커 — ## 불변식; 버려지는 문면: 버려지는 안전 조항.\n',
      ]);
      expect(lintGoalFile(wrapped.document, 'main')).toContainEqual(expect.objectContaining({
        level: 'WARN', tag: 'heading-form-marker', message: expect.stringContaining('heading-form invariant'),
      }));
      expect(stderr.mock.calls.map(([message]) => message)).toContain('[goal-author] ground started\n');

      stderr.mockClear();
      await authorGoal(completeInlineAsk, deps);
      expect(stderr.mock.calls.map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'))).toEqual([]);
      expect(stderr.mock.calls.map(([message]) => message)).toContain('[goal-author] ground started\n');
    } finally {
      stderr.mockRestore();
    }
  });

  test('keeps malformed invariant extraction guidance distinct from wrapped-marker WARNs', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await authorGoal('불변식은 형식 오류다.', deps);
      const warnings = stderr.mock.calls.map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      expect(warnings).toEqual([
        '[goal-author] marker warning: 불변식: marker is present but could not be extracted; required format: 불변식: <preservation statement>; corrected example: 불변식: src/example.ts remains unchanged.\n',
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  test('keeps a fully extracted inline invariant outside wrapped-marker WARNs', async () => {
    const inlineAsk = '불변식:\n버려지는 안전 조항.';
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(inspectAskInvariantMarker(inlineAsk, null)).toMatchObject({ marker: true, extracted: true });
      await authorGoal(inlineAsk, deps);
      const warnings = stderr.mock.calls.map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'));
      expect(warnings).toEqual([]);
      expect(stderr.mock.calls.map(([message]) => message)).toContain('[goal-author] ground started\n');
    } finally {
      stderr.mockRestore();
    }
  });

  test('does not warn before ground for absent or fully extracted dedicated markers', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const validAsk = [
      '판정 신호: 조건 = valid condition; 관측 = bun test src/example.test.ts; 기대 = valid result',
      '불변식: src/example.ts remains unchanged.',
      '경계: src/self-implement/goal-author.ts만 고친다.',
    ].join('\n');
    try {
      await authorGoal('No dedicated markers are present.', deps);
      await authorGoal(validAsk, deps);

      expect(stderr.mock.calls.map(([message]) => message)).toEqual([
        '[goal-author] ground started\n',
        expect.stringMatching(/^\[goal-author\] ground ended in \d+ms\n$/),
        '[goal-author] enhance started\n',
        expect.stringMatching(/^\[goal-author\] enhance ended in \d+ms\n$/),
        '[goal-author] assemble started\n',
        expect.stringMatching(/^\[goal-author\] assemble ended in \d+ms\n$/),
        '[goal-author] lint started\n',
        expect.stringMatching(/^\[goal-author\] lint ended in \d+ms\n$/),
        '[goal-author] ground started\n',
        expect.stringMatching(/^\[goal-author\] ground ended in \d+ms\n$/),
        '[goal-author] enhance started\n',
        expect.stringMatching(/^\[goal-author\] enhance ended in \d+ms\n$/),
        '[goal-author] assemble started\n',
        expect.stringMatching(/^\[goal-author\] assemble ended in \d+ms\n$/),
        '[goal-author] lint started\n',
        expect.stringMatching(/^\[goal-author\] lint ended in \d+ms\n$/),
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  test('emits malformed marker warnings exactly once through both authoring entries and none without markers', async () => {
    const markerAsk = '판정 신호: 조건 = only condition';
    const warning = '[goal-author] marker warning: 판정 신호: marker is present but could not be extracted; required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>; corrected example: 판정 신호: 조건 = malformed marker exists; 관측 = bun test src/example.test.ts; 기대 = diagnostic is rendered.\n';
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-early-marker-warning-'));
    temporaryDirectories.push(cwd);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const markerWarningObservations = () => log.mock.calls
      .filter(([category, event]) => category === 'goal-author' && event === 'early-marker-warning')
      .map(([, , data]) => data as { markers: string[]; count: number });
    try {
      await authorGoal(markerAsk, deps);
      expect(stderr.mock.calls.filter(([message]) => message === warning)).toHaveLength(1);
      expect(markerWarningObservations()).toEqual([{ markers: ['판정 신호:'], count: 1 }]);
      expect(JSON.stringify(markerWarningObservations())).not.toContain(markerAsk);

      stderr.mockClear();
      log.mockClear();
      await writeAuthoredGoal(markerAsk, cwd, deps, { now: () => STAMP_AT });
      expect(stderr.mock.calls.filter(([message]) => message === warning)).toHaveLength(1);
      expect(markerWarningObservations()).toEqual([{ markers: ['판정 신호:'], count: 1 }]);

      stderr.mockClear();
      log.mockClear();
      await authorGoal('No dedicated markers are present.', deps);
      expect(stderr.mock.calls.filter(([message]) => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'))).toHaveLength(0);
      expect(markerWarningObservations()).toHaveLength(0);

      stderr.mockClear();
      log.mockClear();
      await writeAuthoredGoal('No dedicated markers are present.', cwd, deps, { now: () => STAMP_AT });
      expect(stderr.mock.calls.filter(([message]) => typeof message === 'string' && message.startsWith('[goal-author] marker warning:'))).toHaveLength(0);
      expect(markerWarningObservations()).toHaveLength(0);
    } finally {
      log.mockRestore();
      stderr.mockRestore();
    }
  });

  test('continues authoring and preserves malformed marker stderr output when early-marker observation fails', async () => {
    const markerAsk = '판정 신호: 조건 = only condition';
    const warning = '[goal-author] marker warning: 판정 신호: marker is present but could not be extracted; required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>; corrected example: 판정 신호: 조건 = malformed marker exists; 관측 = bun test src/example.test.ts; 기대 = diagnostic is rendered.\n';
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(debug, 'log').mockImplementation((_category, event) => {
      if (event === 'early-marker-warning') throw new Error('log unavailable');
    });
    try {
      const authored = await authorGoal(markerAsk, deps);
      expect(authored.document).toContain(markerAsk);
      expect(stderr.mock.calls.filter(([message]) => message === warning)).toHaveLength(1);
    } finally {
      log.mockRestore();
      stderr.mockRestore();
    }
  });

  test('times contiguous assemble subphases with the shared author run, identifies growing work, and preserves outer phase observations', async () => {
    const subphases = ['assemble-inputs', 'assemble-sections', 'assemble-document'];
    const observeRun = async (timestamps: number[]) => {
      const log = spyOn(debug, 'log').mockImplementation(() => undefined);
      const now = spyOn(Date, 'now').mockImplementation(() => {
        const timestamp = timestamps.shift();
        if (timestamp === undefined) throw new Error('test clock exhausted');
        return timestamp;
      });
      try {
        await authorGoal(ask, deps);
        return log.mock.calls
          .filter(([category, event]) => category === 'goal-author' && (event === 'phase-start' || event === 'phase-end'))
          .map(([, event, data]) => ({ event, ...(data as { phase: string; authorRunId: string; elapsedMs?: number }) }));
      } finally {
        now.mockRestore();
        log.mockRestore();
      }
    };
    const first = await observeRun([0, 0, 1, 2, 3, 4, 5, 15, 15, 50, 50, 70, 70, 71, 72, 72]);
    const second = await observeRun([100, 100, 101, 102, 103, 104, 105, 115, 115, 170, 170, 190, 190, 191, 192, 192]);
    const outer = first.filter(({ phase }) => ['ground', 'enhance', 'assemble', 'lint'].includes(phase));
    const assemble = first.filter(({ phase }) => phase.startsWith('assemble'));
    type AssembleDurations = Record<(typeof subphases)[number], number>;
    const durations = (observations: typeof first): AssembleDurations => Object.fromEntries(subphases.map((phase) => {
      const elapsedMs = observations.find((observation) => observation.event === 'phase-end' && observation.phase === phase)?.elapsedMs;
      if (typeof elapsedMs !== 'number') throw new Error(`missing elapsedMs for ${phase}`);
      return [phase, elapsedMs];
    })) as AssembleDurations;

    expect(outer.map(({ event, phase }) => ({ event, phase }))).toEqual([
      { event: 'phase-start', phase: 'ground' },
      { event: 'phase-end', phase: 'ground' },
      { event: 'phase-start', phase: 'enhance' },
      { event: 'phase-end', phase: 'enhance' },
      { event: 'phase-start', phase: 'assemble' },
      { event: 'phase-end', phase: 'assemble' },
      { event: 'phase-start', phase: 'lint' },
      { event: 'phase-end', phase: 'lint' },
    ]);
    expect(assemble.map(({ event, phase }) => ({ event, phase }))).toEqual([
      { event: 'phase-start', phase: 'assemble' },
      ...subphases.flatMap((phase) => [{ event: 'phase-start', phase }, { event: 'phase-end', phase }]),
      { event: 'phase-end', phase: 'assemble' },
    ]);
    const authorRunId = assemble[0]!.authorRunId;
    expect(assemble.every((observation) => observation.authorRunId === authorRunId)).toBe(true);
    expect(durations(first)).toEqual({ 'assemble-inputs': 10, 'assemble-sections': 35, 'assemble-document': 20 });
    expect(durations(second)).toEqual({ 'assemble-inputs': 10, 'assemble-sections': 55, 'assemble-document': 20 });
    expect(durations(first)['assemble-sections']).toBeGreaterThan(durations(first)['assemble-document']);
    expect(durations(second)['assemble-sections'] - durations(first)['assemble-sections']).toBe(20);
    const subphaseElapsedMs = Object.values(durations(first)).reduce((sum, elapsedMs) => sum + (elapsedMs ?? -1), 0);
    const assembleElapsedMs = assemble.find(({ event, phase }) => event === 'phase-end' && phase === 'assemble')!.elapsedMs!;
    expect(Math.abs(assembleElapsedMs - subphaseElapsedMs)).toBeLessThanOrEqual(1);
  });

  test('closes the active assemble subphase when assembly fails', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await expect(authorGoal(ask, { ...deps, goalTitle: '   ' })).rejects.toThrow('goalTitle must contain non-whitespace text');
      const assemble = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && (event === 'phase-start' || event === 'phase-end'))
        .map(([, event, data]) => ({ event, ...(data as { phase: string; authorRunId: string; elapsedMs?: number }) }))
        .filter(({ phase }) => phase.startsWith('assemble'));

      expect(assemble.map(({ event, phase }) => ({ event, phase }))).toEqual([
        { event: 'phase-start', phase: 'assemble' },
        { event: 'phase-start', phase: 'assemble-inputs' },
        { event: 'phase-end', phase: 'assemble-inputs' },
        { event: 'phase-end', phase: 'assemble' },
      ]);
      expect(new Set(assemble.map(({ authorRunId }) => authorRunId)).size).toBe(1);
      expect(assemble.filter(({ event }) => event === 'phase-end').every(({ elapsedMs }) => Number.isInteger(elapsedMs) && elapsedMs! >= 0)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('observes ask export names that are absent from or present in grounded code facts without changing the document', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const missing = await authorGoal('Compare `missingExport`, `src/example.ts`, and `two words`.', deps);
      const matched = await authorGoal('Compare `exampleExport`.', deps);
      const withoutGrounding = await authorGoal('Compare `missingExport`.', { ...deps, ground: async () => noFacts });
      const observations = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && event === 'ask-export-grounding')
        .map(([, , data]) => data as { missingCount: number; missingNames: string[]; authorRunId: string });

      expect(observations).toEqual([
        { authorRunId: expect.any(String), missingCount: 1, missingNames: ['missingExport'] },
        { authorRunId: expect.any(String), missingCount: 0, missingNames: [] },
      ]);
      expect(missing.document).toContain('`missingExport`');
      expect(matched.document).toContain('`exampleExport`');
      expect(withoutGrounding.document).toContain('`missingExport`');
    } finally {
      log.mockRestore();
    }
  });

  test('notifies injected progress of every phase start and end without stderr output', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const progress: Array<{ phase: string; event: string }> = [];
    try {
      await authorGoal(ask, {
        ...deps,
        onProgress: (phase, event) => progress.push({ phase, event }),
      });

      expect(progress).toEqual([
        { phase: 'ground', event: 'start' },
        { phase: 'ground', event: 'end' },
        { phase: 'enhance', event: 'start' },
        { phase: 'enhance', event: 'end' },
        { phase: 'assemble', event: 'start' },
        { phase: 'assemble', event: 'end' },
        { phase: 'lint', event: 'start' },
        { phase: 'lint', event: 'end' },
      ]);
      expect(stderr).not.toHaveBeenCalled();
      expect(log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && (event === 'phase-start' || event === 'phase-end'))
        .map(([, event, data]) => ({ event, ...(data as { phase: string; authorRunId?: string; elapsedMs?: number; inputTokens?: number | null; outputTokens?: number | null }) }))
        .filter(({ phase }) => ['ground', 'enhance', 'assemble', 'lint'].includes(phase)))
        .toEqual([
          { event: 'phase-start', phase: 'ground', authorRunId: expect.any(String) },
          { event: 'phase-end', phase: 'ground', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
          { event: 'phase-start', phase: 'enhance', authorRunId: expect.any(String) },
          { event: 'phase-end', phase: 'enhance', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
          { event: 'phase-start', phase: 'assemble', authorRunId: expect.any(String) },
          { event: 'phase-end', phase: 'assemble', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
          { event: 'phase-start', phase: 'lint', authorRunId: expect.any(String) },
          { event: 'phase-end', phase: 'lint', authorRunId: expect.any(String), elapsedMs: expect.any(Number), inputTokens: null, outputTokens: null },
        ]);
    } finally {
      log.mockRestore();
      stderr.mockRestore();
    }
  });

  test('renders persistent evidence by explicit source association, retains unassociated text as unknown, and records every source-kind count', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const sharedEvidence = 'same literal evidence from independent producers.';
    const unknownEvidence = 'memory://opaque: unassociated evidence remains verbatim.';
    try {
      const authored = await authorGoal(ask, {
        ...deps,
        ground: async () => ({
          ...facts,
          persistentEvidence: [sharedEvidence, sharedEvidence, unknownEvidence],
          persistentEvidenceItems: [
            { text: sharedEvidence, sourceKind: 'code' },
            { text: sharedEvidence, sourceKind: 'memory' },
            { text: unknownEvidence },
          ],
        }),
      });
      const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));
      expect(tracedPaths).toBe(`## TRACED PATHS\n1. [code] ${sharedEvidence}\n2. [memory] ${sharedEvidence}\n3. [unknown] ${unknownEvidence}\n\n`);
      expect(log).toHaveBeenCalledWith('goal-author', 'persistent-grounding-evidence-source-count', {
        authorRunId: expect.any(String),
        counts: { code: 1, skill: 0, memory: 1, doc: 0, pty: 0, unknown: 1 },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('merges partially synchronized persistent evidence fields without losing legacy-only occurrences', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const sharedEvidence = 'shared evidence carries its structured source association.';
    const associatedOnlyEvidence = 'structured-only evidence remains present.';
    const legacyOnlyEvidence = 'legacy-only memory://opaque evidence remains present.';
    try {
      const authored = await authorGoal(ask, {
        ...deps,
        ground: async () => ({
          ...facts,
          persistentEvidence: [sharedEvidence, legacyOnlyEvidence],
          persistentEvidenceItems: [
            { text: sharedEvidence, sourceKind: 'code' },
            { text: associatedOnlyEvidence, sourceKind: 'memory' },
          ],
        }),
      });
      const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));

      expect(tracedPaths).toBe(`## TRACED PATHS\n1. [code] ${sharedEvidence}\n2. [memory] ${associatedOnlyEvidence}\n3. [unknown] ${legacyOnlyEvidence}\n\n`);
      expect(log).toHaveBeenCalledWith('goal-author', 'persistent-grounding-evidence-source-count', {
        authorRunId: expect.any(String),
        counts: { code: 1, skill: 0, memory: 1, doc: 0, pty: 0, unknown: 1 },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('preserves duplicate legacy evidence occurrences after matching structured associations', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const duplicatedEvidence = 'duplicate evidence must remain two occurrences.';
    try {
      const authored = await authorGoal(ask, {
        ...deps,
        ground: async () => ({
          ...facts,
          persistentEvidence: [duplicatedEvidence, duplicatedEvidence],
          persistentEvidenceItems: [{ text: duplicatedEvidence, sourceKind: 'code' }],
        }),
      });
      const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));

      expect(tracedPaths).toBe(`## TRACED PATHS\n1. [code] ${duplicatedEvidence}\n2. [unknown] ${duplicatedEvidence}\n\n`);
      expect(log).toHaveBeenCalledWith('goal-author', 'persistent-grounding-evidence-source-count', {
        authorRunId: expect.any(String),
        counts: { code: 1, skill: 0, memory: 0, doc: 0, pty: 0, unknown: 1 },
      });
    } finally {
      log.mockRestore();
    }
  });

  // 시계 유도 `submitted` 의 기대값 — 테스트가 실제 시각에 의존하지 않게 고정한다(KST 표기).
  const STAMP_AT = new Date(Date.UTC(2026, 6, 29, 0, 30));
  const STAMPED = '2026-07-29 09:30 KST';
  test('emits eight ordered sections, evidence-kind required evidence, verbatim ask, grounded problem facts, traced paths, candidates, generic focused-test wording, and a non-provenance first line', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal(ask, deps);
      expect(authored.document).toContain(ask);
      expect(authored.facts).toEqual(facts);
      const problem = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('## WHAT TO BUILD'));
      expect(problem).not.toContain('Repository implementation-candidate evidence (file presence only):');
      expect(problem).toContain('Persistent grounding evidence is listed in the traced-path section below.');
      expect(problem).not.toContain(facts.persistentEvidence[0]);
      expect(problem).not.toContain('Code evidence (repository export facts):');
      expect(problem).toContain('Local document evidence (reference knowledge; not a repository file-existence claim):');
      expect(problem).not.toContain('Repository document reference evidence (background only; not implementation candidates):');
      expect(problem).not.toContain('Skill evidence (skill contract facts):');
      expect(problem).not.toContain('Memory evidence (reference knowledge; not a repository file-existence claim):');
      expect(problem).not.toContain('Upstream PTY evidence (reference knowledge; not a repository file-existence claim):');
      expect(problem).not.toContain('docs/example.md');
      expect(problem).not.toContain(facts.skillFacts[0]);
      expect(problem).not.toContain(facts.memoryFacts[0]);
      expect(log).toHaveBeenCalledWith('goal-author', 'problem-background-evidence', {
        authorRunId: expect.any(String),
        documentFacts: { count: 1, identifiers: facts.documentFacts },
        skillFacts: { count: 1, identifiers: facts.skillFacts },
        memoryFacts: { count: 1, identifiers: facts.memoryFacts },
        ptyFacts: { count: 0, identifiers: facts.ptyFacts },
        implementationCandidates: { count: 1, identifiers: ['src/example.ts'] },
        codeFacts: { count: 1, identifiers: facts.codeFacts },
      });
      const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));
      expect(tracedPaths).toBe(`## TRACED PATHS\n1. [unknown] ${facts.persistentEvidence[0]}\n\n`);
      expect(authored.document).not.toContain('Candidate requiring path tracing:');
      expect(authored.document).not.toContain('Ask-provenance notice:');
      expect(authored.document).not.toContain('Information: ask contains');
      expect(authored.document).toMatch(/## PROBLEM[\s\S]*## WHAT TO BUILD[\s\S]*## ACCEPTANCE CRITERIA[\s\S]*## REQUIRED EVIDENCE[\s\S]*## TRACED PATHS[\s\S]*## SCOPE BOUNDARY[\s\S]*## 불변식[\s\S]*## 판정 신호/);
      // A previously authored RULES section consumed 1,215 characters per document.
      // New artifacts omit that duplicate while the unchanged policy remains available
      // to child entrypoints through ELANOUS_HARNESS_POLICY.
      expect(authored.document).not.toContain('## RULES');
      expect(GOAL_RULES_POLICY).toHaveLength(14);
      const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));
      const requiredEvidence = authored.document.slice(authored.document.indexOf('## REQUIRED EVIDENCE'), authored.document.indexOf('## TRACED PATHS'));
      expect(requiredEvidence).toContain('- [requested] Evidence that the requested acceptance criteria are met as a group.');
      for (const instruction of [
        'If this change touches code: name the focused test file(s) it adds or touches',
        'Verify by breaking it: change the one rule that matters for THIS goal',
        EVIDENCE_LOCATION_REQUIREMENT,
        'In the child completion summary, write `EVIDENCE: [requested] <claim> || <verify command>`.',
        'In the child completion summary, write `EVIDENCE: [preservation] <claim> || <verify command>`.',
        'Immediately next, write `RESULT: <the one-line result from that verify command>`.',
        'Fill `<claim>` with what this tag proves and `<verify command>` with the command or query that reproduces it; neither may be empty.',
      ]) {
        expect(GOAL_RULES_POLICY.some((policy) => policy.includes(instruction))).toBe(true);
        expect(acceptance).not.toContain(instruction);
        expect(requiredEvidence).not.toContain(instruction);
      }
      expect(log).toHaveBeenCalledWith('goal-author', 'constant-instruction-placement', {
        authorRunId: expect.any(String),
        lines: 8,
        chars: expect.any(Number),
      });
      expect(lintGoalFile(authored.document, 'main')).not.toContainEqual(expect.objectContaining({ tag: 'evidence-section' }));
      expect(Array.from(lintGoalFile(authored.document, 'main'))).toEqual([
        {
          level: 'WARN',
          tag: 'boundary-size',
          message: '## SCOPE BOUNDARY contains unselected scope-boundary candidates; select decisions before evaluating boundary size',
        },
      ]);
      // ⭐ 저작기 자신의 테스트·불변식을 남의 골에 박지 않는다(2026-07-28 리뷰 실측).
      expect(authored.document).not.toContain('goal-author.test.ts');
      expect(authored.document).not.toContain('authoring entry point writes');
      expect(GOAL_RULES_POLICY).toHaveLength(14);
      const firstLine = authored.document.split('\n', 1)[0];
      expect(firstLine).toBe(ask);
      expect(firstLine).not.toBe('Grounded goal specification');
      expect(Array.from(firstLine)).toHaveLength(72 > Array.from(ask).length ? Array.from(ask).length : 72);
      expect(firstLine).not.toMatch(/^(agent|session|submitted):/i);
    } finally {
      log.mockRestore();
    }
  });

  test('appends exported and safely quoted consumer commands for sibling tests while preserving unsupported output and lint findings', async () => {
    const expectedLintFindings = [{
      level: 'WARN' as const,
      tag: 'boundary-size' as const,
      message: '## SCOPE BOUNDARY contains unselected scope-boundary candidates; select decisions before evaluating boundary size',
    }];
    const withSibling = await authorGoal(ask, deps);
    const withSiblingEvidence = markdownSection(withSibling.document, 'REQUIRED EVIDENCE')!;
    expect(withSiblingEvidence.match(/^- \[[^\]]+\]/gm)).toHaveLength(3);
    expect(withSiblingEvidence).toContain(`- [requested] Evidence that the requested acceptance criteria are met as a group. ${REQUIRED_EVIDENCE_COMMAND_SEPARATOR} bun test -- 'src/example.test.ts'`);
    expect(requiredEvidenceFromGoal(withSibling.document)).toContainEqual(expect.objectContaining({
      tag: 'requested',
      verifyCommand: "bun test -- 'src/example.test.ts'",
    }));
    expect(Array.from(lintGoalFile(withSibling.document, 'main'))).toEqual(expectedLintFindings);

    const specialPathFacts = { ...facts, files: ["src/space $meta '-leading'.ts"] };
    const withSpecialPath = await authorGoal(ask, { ...deps, ground: async () => specialPathFacts });
    expect(markdownSection(withSpecialPath.document, 'REQUIRED EVIDENCE')).toContain(
      `${REQUIRED_EVIDENCE_COMMAND_SEPARATOR} bun test -- 'src/space $meta '\\''-leading'\\''.test.ts'`,
    );
    expect(requiredEvidenceFromGoal(withSpecialPath.document)).toContainEqual(expect.objectContaining({
      verifyCommand: "bun test -- 'src/space $meta '\\''-leading'\\''.test.ts'",
    }));

    const unsupportedFacts = { ...facts, files: ['docs/example.md'] };
    const withoutSibling = await authorGoal(ask, { ...deps, ground: async () => unsupportedFacts });
    const withoutSiblingEvidence = markdownSection(withoutSibling.document, 'REQUIRED EVIDENCE')!;
    expect(withoutSiblingEvidence).toBe([
      '- [requested] Evidence that the requested acceptance criteria are met as a group.',
      '- [preservation] Evidence that the grounded preservation criteria remain true as a group.',
      '- [wiring] Evidence that the changed unit is reached from an existing execution path: name the caller (file and function) and show that call in the diff.',
    ].join('\n') + '\n');
    expect(withoutSiblingEvidence).not.toContain(REQUIRED_EVIDENCE_COMMAND_SEPARATOR);
    expect(Array.from(lintGoalFile(withoutSibling.document, 'main'))).toEqual(expectedLintFindings);
  });

  test('observes derived and appended sibling-test counts, including zero-derived paths, without changing evidence output', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const withSibling = await authorGoal(ask, deps);
      const withoutSibling = await authorGoal(ask, {
        ...deps,
        ground: async () => ({ ...facts, files: ['docs/example.md'] }),
      });
      const observations = log.mock.calls
        .filter(([category, event]) => category === 'goal-author' && event === 'required-evidence-sibling-test-count')
        .map(([, , data]) => data as {
          authorRunId: string;
          targetPathCount: number;
          derivedSiblingTestCount: number;
          appendedSiblingTestCount: number;
        });

      expect(observations).toContainEqual({
        authorRunId: withSibling.authorRunId,
        targetPathCount: 1,
        derivedSiblingTestCount: 1,
        appendedSiblingTestCount: 1,
      });
      expect(observations).toContainEqual({
        authorRunId: withoutSibling.authorRunId,
        targetPathCount: 1,
        derivedSiblingTestCount: 0,
        appendedSiblingTestCount: 0,
      });
      expect(markdownSection(withoutSibling.document, 'REQUIRED EVIDENCE')).toBe([
        '- [requested] Evidence that the requested acceptance criteria are met as a group.',
        '- [preservation] Evidence that the grounded preservation criteria remain true as a group.',
        '- [wiring] Evidence that the changed unit is reached from an existing execution path: name the caller (file and function) and show that call in the diff.',
      ].join('\n') + '\n');
    } finally {
      log.mockRestore();
    }
  });

  test('keeps authoring fail-soft when required-evidence sibling-test observation fails', async () => {
    const log = spyOn(debug, 'log').mockImplementation((category, event) => {
      if (category === 'goal-author' && event === 'required-evidence-sibling-test-count') throw new Error('observation unavailable');
    });
    try {
      const authored = await authorGoal(ask, deps);
      expect(markdownSection(authored.document, 'REQUIRED EVIDENCE')).toContain(
        `${REQUIRED_EVIDENCE_COMMAND_SEPARATOR} bun test -- 'src/example.test.ts'`,
      );
    } finally {
      log.mockRestore();
    }
  });

  test('keeps sibling-test evidence commands on the authorGoalWithSupersededRootIntent write path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-sibling-evidence-'));
    temporaryDirectories.push(cwd);
    const original = await writeAuthoredGoal('Original goal.', cwd, deps, { now: () => STAMP_AT });
    const successor = await writeAuthoredGoal('Revised goal.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
    });

    expect(markdownSection(successor.authored.document, 'REQUIRED EVIDENCE')).toContain(
      `${REQUIRED_EVIDENCE_COMMAND_SEPARATOR} bun test -- 'src/example.test.ts'`,
    );
  });

  test('renders only ask-mentioned code-fact symbol declarations with their path and line', async () => {
    const authored = await authorGoal('Use mentionedSymbol, not unrelatedSymbolish.', {
      ...deps,
      ground: async () => ({
        ...facts,
        codeFacts: ['[code:src/symbols.ts] mentionedSymbol, unrelatedSymbol'],
      }),
      readSourceFile: () => [
        'const unrelatedSymbol = 1;',
        'export function mentionedSymbol(',
        '  input: string,',
        '  retries: number,',
        '): string { return input; }',
      ].join('\n'),
    });
    const complication = authored.document.slice(authored.document.indexOf('Complication:'), authored.document.indexOf('## WHAT TO BUILD'));

    const signatures = complication.split('\n').filter((line) => line.startsWith('- Signature ')).join('\n');
    expect(signatures).toContain('Signature declaration `src/symbols.ts:2` — export function mentionedSymbol(');
    expect(signatures).not.toContain('unrelatedSymbol');
  });

  test('stops a simple variable declaration at its semicolon', async () => {
    const authored = await authorGoal('Use simpleValue.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/simple-value.ts] simpleValue'] }),
      readSourceFile: () => [
        'export const simpleValue = 1;',
        'const unrelated = 2;',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/simple-value.ts:1` — export const simpleValue = 1;');
    expect(authored.document).not.toContain('const unrelated = 2;');
  });

  // ⛔⭐⭐ 리뷰가 초판의 「선언 «끝» 계산기」에서 낸 결함 «둘»을 그대로 무는 회귀다.
  //   초판은 class/interface/type/enum 에 종료 경계가 없어 «파일 끝까지» 삼켰고,
  //   객체 반환 타입 `: { x: string } {` 의 첫 중괄호를 «본문 시작»으로 오인했다.
  //   ⇒ 수리는 「끝을 계산하지 않는다」였고, 이 둘은 그 수리가 «되돌려지면» 다시 깨진다.
  // ⛔⭐⭐⭐ 라이브가 잡은 결함의 회귀 — 단위 테스트가 «구조적으로» 못 잡던 자리다.
  //   초판은 주석·문자열 마스커로 가린 줄에서 찾았는데, 그 마스커가 ***정규식 리터럴 안의 backtick***
  //   을 문자열 시작으로 읽어 그 뒤 «수백 줄»을 통째로 가렸다(실측: goal-author.ts 자신에서 L303→L654).
  //   ⇒ 존재하는 `export function` 이 「declaration line was not found」로 나왔다.
  //   ⚠️ fixture 가 작고 정규식이 없으면 이 결함이 «안 재현된다» — 그래서 이 fixture 는 정규식 리터럴을 «든다».
  test('finds a declaration that appears after a regex literal containing quote characters', async () => {
    const authored = await authorGoal('Use afterRegexSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/after-regex.ts] afterRegexSymbol'] }),
      readSourceFile: () => [
        'const fence = /^(?: {0,3})([`~]{3,})/;',
        "const quoted = /[\"']/g;",
        'export function afterRegexSymbol(input: string): string {',
        '  return input;',
        '}',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/after-regex.ts:3` — export function afterRegexSymbol(input: string): string {');
    expect(authored.document).not.toContain('declaration line was not found');
  });

  test('emits only the declaration line for kinds that have no closing boundary', async () => {
    const authored = await authorGoal('Use ShapeContract.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/shape.ts] ShapeContract'] }),
      readSourceFile: () => [
        'export interface ShapeContract {',
        '  first: string;',
        '  second: string;',
        '}',
        'export const trailingSentinel = 1;',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/shape.ts:1` — export interface ShapeContract {');
    // ⭐ 초판은 종료 경계가 없어 여기까지 삼켰다 — 「파일 끝까지」가 이 단언의 반증 대상이다.
    expect(authored.document).not.toContain('trailingSentinel');
    expect(authored.document).not.toContain('second: string;');
  });

  test('does not mistake an object return type brace for the function body', async () => {
    const authored = await authorGoal('Use objectReturning.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/object-return.ts] objectReturning'] }),
      readSourceFile: () => [
        'export function objectReturning(input: string): { value: string } {',
        '  return { value: input };',
        '}',
      ].join('\n'),
    });

    // ⭐ 반환 타입이 «통째로» 보여야 한다 — 초판은 `: {` 에서 잘라 `{ value: string }` 를 잃었다.
    expect(authored.document).toContain('Signature declaration `src/object-return.ts:1` — export function objectReturning(input: string): { value: string } {');
    expect(authored.document).not.toContain('return { value: input };');
  });

  test('stops a simple function declaration at its body opening brace', async () => {
    const authored = await authorGoal('Use simpleFunction.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/simple-function.ts] simpleFunction'] }),
      readSourceFile: () => [
        'export function simpleFunction(input = 1) {',
        '  return input;',
        '}',
        'const unrelated = 2;',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/simple-function.ts:1` — export function simpleFunction(input = 1) {');
    expect(authored.document).not.toContain('return input;');
    expect(authored.document).not.toContain('const unrelated = 2;');
  });

  test('renders default-exported function signatures across multiple lines', async () => {
    const authored = await authorGoal('Use defaultSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/default.ts] defaultSymbol'] }),
      readSourceFile: () => [
        'export default function defaultSymbol(',
        '  document: string,',
        '): void {}',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/default.ts:1` — export default function defaultSymbol(');
  });

  test('renders a multi-line arrow declaration through its parameter and arrow boundary', async () => {
    const authored = await authorGoal('Use arrowSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/arrow.ts] arrowSymbol'] }),
      readSourceFile: () => [
        'export const arrowSymbol = (',
        '  input: string,',
        ') => input;',
        'const after = true;',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/arrow.ts:1` — export const arrowSymbol = (');
    expect(authored.document).not.toContain('const after = true;');
  });

  test('ignores parentheses in comments and strings while finding a multi-line declaration boundary', async () => {
    const authored = await authorGoal('Use maskedSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/masked.ts] maskedSymbol'] }),
      readSourceFile: () => [
        'export function maskedSymbol(',
        '  input: string, // ) comment',
        '): string {',
        '  return "( string )" + input;',
        '}',
        'const after = true;',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/masked.ts:1` — export function maskedSymbol(');
    expect(authored.document).not.toContain('return "( string )" + input;');
    expect(authored.document).not.toContain('const after = true;');
  });

  test('matches dollar and Unicode symbols without matching adjacent identifiers', async () => {
    const authored = await authorGoal('Use foo$ and 한글심볼.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/unicode.ts] foo$, 한글심볼, foo$Extra, 한글심볼Extra'] }),
      readSourceFile: () => [
        'export const foo$ = (input: string) => input;',
        'export const 한글심볼 = (input: string) => input;',
        'export const foo$Extra = (input: string) => input;',
        'export const 한글심볼Extra = (input: string) => input;',
      ].join('\n'),
    });

    const signatures = authored.document.split('\n').filter((line) => line.startsWith('- Signature ')).join('\n');
    expect(signatures).toContain('Signature declaration `src/unicode.ts:1` — export const foo$ = (input: string) => input;');
    expect(signatures).toContain('Signature declaration `src/unicode.ts:2` — export const 한글심볼 = (input: string) => input;');
    expect(signatures).not.toContain('foo$Extra');
    expect(signatures).not.toContain('한글심볼Extra');
  });

  test('skips comment and string lookalikes before rendering the actual declaration', async () => {
    const authored = await authorGoal('Use actualSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/lookalikes.ts] actualSymbol'] }),
      readSourceFile: () => [
        '// export function actualSymbol(forged: string): void {}',
        'const example = "export function actualSymbol(forged: string): void {}";',
        '/* export function actualSymbol(forged: string): void {} */',
        'export function actualSymbol(input: string): void {}',
      ].join('\n'),
    });

    expect(authored.document).toContain('Signature declaration `src/lookalikes.ts:4` — export function actualSymbol(input: string): void {');
    expect(authored.document).not.toContain('forged: string');
  });

  test('handles every ReferencedFileReadResult kind when rendering signatures', async () => {
    const cases = [
      {
        symbol: 'okSymbol',
        result: { kind: 'ok' as const, contents: 'export function okSymbol(input: string): void {}' },
        expected: 'Signature declaration `src/result.ts:1` — export function okSymbol(input: string): void {',
      },
      {
        symbol: 'missingSymbol',
        result: { kind: 'missing' as const },
        expected: 'Signature unavailable for `missingSymbol` in `src/result.ts`: file was not found.',
      },
      {
        symbol: 'outsideSymbol',
        result: { kind: 'outside-repository' as const },
        expected: 'Signature unavailable for `outsideSymbol` in `src/result.ts`: path is outside the repository.',
      },
      {
        symbol: 'errorSymbol',
        result: { kind: 'read-error' as const },
        expected: 'Signature unavailable for `errorSymbol` in `src/result.ts`: file could not be read.',
      },
    ];

    for (const { symbol, result, expected } of cases) {
      const authored = await authorGoal(`Use ${symbol}.`, {
        ...deps,
        ground: async () => ({ ...facts, codeFacts: [`[code:src/result.ts] ${symbol}`] }),
        readSourceFile: () => result,
      });
      expect(authored.document).toContain(expected);
    }
  });

  test('reports an unavailable signature when the source reader returns null', async () => {
    const authored = await authorGoal('Use missingSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/missing.ts] missingSymbol'] }),
      readSourceFile: () => null,
    });

    expect(authored.document).toContain('Signature unavailable for `missingSymbol` in `src/missing.ts`: file was not found.');
  });

  test('reports an unavailable signature when the source reader is omitted', async () => {
    const authored = await authorGoal('Use unreadableSymbol.', {
      ...deps,
      ground: async () => ({ ...facts, codeFacts: ['[code:src/unreadable.ts] unreadableSymbol'] }),
    });

    expect(authored.document).toContain('Signature unavailable for `unreadableSymbol` in `src/unreadable.ts`: source reader was not supplied, so the signature could not be read.');
  });

  test('lists grounded files absent from the ask with their count in Complication', async () => {
    const authored = await authorGoal('Update src/mentioned.ts only.', {
      ...deps,
      ground: async () => ({
        ...facts,
        files: ['src/mentioned.ts', 'src/unmentioned.ts', 'docs/also-unmentioned.md'],
      }),
    });
    const complication = authored.document.slice(authored.document.indexOf('Complication:'), authored.document.indexOf('## WHAT TO BUILD'));

    expect(complication).toContain('Grounding files not mentioned in ask (2)');
    expect(complication).toContain('`src/unmentioned.ts`');
    expect(complication).toContain('`docs/also-unmentioned.md`');
  });

  test('excludes ask-mentioned grounded paths from the Complication comparison', async () => {
    const authored = await authorGoal('Update src/mentioned.ts only.', {
      ...deps,
      ground: async () => ({
        ...facts,
        files: ['src/mentioned.ts', 'src/unmentioned.ts'],
      }),
    });
    const comparison = authored.document.match(/Grounding files not mentioned in ask \(\d+\):[^\n]*/)?.[0] ?? '';

    expect(comparison).not.toContain('`src/mentioned.ts`');
    expect(comparison).toContain('`src/unmentioned.ts`');
  });

  test('explicitly reports 없다 when every grounded file is mentioned in the ask', async () => {
    const authored = await authorGoal('Update src/mentioned.ts and docs/mentioned.md.', {
      ...deps,
      ground: async () => ({
        ...facts,
        files: ['src/mentioned.ts', 'docs/mentioned.md'],
      }),
    });

    expect(authored.document).toContain('Grounding files not mentioned in ask (0): 없다.');
  });

  test('keeps persistent evidence out of invariants while retaining it in traced paths, acceptance, and strict decision-signal parsing', async () => {
    const ordinaryEvidence = [
      'src/example.ts:42 — authorGoal receives this Read-verified call path.',
      'src/other.ts:7 — writeAuthoredGoal preserves collision-safe output.',
    ];
    const decisionSignalEvidence = 'Decision signal: condition = the author receives Read-verified evidence; observation = the decision-signal section is rendered; expected result = only strict evidence becomes a decision signal';
    const evidence = [...ordinaryEvidence, decisionSignalEvidence];
    const authored = await authorGoal(ask, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
    });

    expect(authored.document.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
    ]);
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## TRACED PATHS'));
    const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));
    expect(invariants).toBe('## 불변식\n- UNVERIFIABLE: No Read-verified invariant evidence with condition, observation, and expected result is available.\n\n');
    expect(tracedPaths).toBe(`## TRACED PATHS\n${evidence.map((statement, index) => `${index + 1}. [unknown] ${statement}`).join('\n')}\n\n`);
    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
    expect(acceptance).toContain('- Checkable requested criterion: embed the exact ask in the authored document');
    expect(signals).toContain('- Candidate decision signal:');
    expect(signals).toContain('  - Expected result: only strict evidence becomes a decision signal');
    for (const statement of ordinaryEvidence) expect(signals).not.toContain(statement);
  });

  test('preserves colon-delimited persistent evidence without inferring its source', async () => {
    const cases = [
      ['src/example.ts: Read-verified producer evidence.', 'src/example.ts: Read-verified producer evidence.'],
      ['src/example.ts: parser — formatter', 'src/example.ts: parser — formatter'],
      ['src/example.ts: 4 cases', 'src/example.ts: 4 cases'],
      ['src/example.ts:42: 4 cases', 'src/example.ts:42: 4 cases'],
    ];

    for (const [evidence, expected] of cases) {
      const authored = await authorGoal(ask, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [evidence] }),
      });
      const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));
      const findings = lintGoalFile(authored.document, 'main', { readReferencedFile: (path) => path === 'src/example.ts' ? Array.from({ length: 42 }, () => 'present').join('\n') : null });

      expect(tracedPaths).toBe(`## TRACED PATHS\n1. [unknown] ${expected}\n\n`);
      expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR', tag: 'traced-path' }));
      expect(planGateSignals(authored.document, findings).tracedPathMissing).toBe(0);
    }
  });

  test('preserves an em-dash-delimited traced path', async () => {
    const evidence = 'src/example.ts — Read-verified producer evidence.';
    const authored = await authorGoal(ask, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [evidence] }),
    });
    const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));
    const findings = lintGoalFile(authored.document, 'main', { readReferencedFile: (path) => path === 'src/example.ts' ? 'present' : null });

    expect(tracedPaths).toBe(`## TRACED PATHS\n1. [unknown] ${evidence}\n\n`);
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR', tag: 'traced-path' }));
  });

  test('preserves a traced path line number', async () => {
    const authored = await authorGoal(ask, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: ['src/example.ts:42'] }),
    });
    const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));
    const findings = lintGoalFile(authored.document, 'main', { readReferencedFile: (path) => path === 'src/example.ts' ? Array.from({ length: 42 }, () => 'present').join('\n') : null });

    expect(tracedPaths).toBe('## TRACED PATHS\n1. [unknown] src/example.ts:42\n\n');
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR', tag: 'traced-path' }));
  });

  test('keeps the dated elapsed-time requests verbatim when grounding observes no elapsed time output', async () => {
    const elapsedTimeRequests = [
      '2026-08-04: output execution time in seconds.',
      'Report the elapsed time in seconds after the command completes.',
    ];
    const actualAsk = elapsedTimeRequests.join('\n');
    const currentStateObservation = 'src/self-implement/goal-author.ts — checkableCriteria currently ends with and no elapsed time output';
    const authored = await authorGoal(actualAsk, {
      ...deps,
      enhance: async (raw) => {
        expect(raw).toBe(actualAsk);
        return {
          original: raw,
          checklist: raw.split('\n').filter((line) => elapsedTimeRequests.includes(line)),
          verbatimPreserved: true,
        };
      },
      ground: async () => ({ ...facts, persistentEvidence: [currentStateObservation] }),
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );

    for (const request of elapsedTimeRequests) {
      const requestedLine = `- Checkable requested criterion: ${request}`;
      expect(acceptance).toContain(requestedLine);
      expect(acceptance.split(requestedLine)).toHaveLength(2);
    }
    expect(acceptance).toContain(IMPLEMENT_PRESERVATION_REFERENCE);
    expect(authored.document).toContain(currentStateObservation);
    expect(authored.document).toContain('and no elapsed time output');
  });

  test('renders ask invariants without duplicating persistent evidence while decision signals remain strict', async () => {
    const invariant = '저작기는 문장을 지어내지 않는다.';
    const condition = 'ask 에 불변식 문장이 담긴 골을 저작한다';
    const observation = '산출 골 파일의 불변식 절';
    const expectedResult = 'UNVERIFIABLE 이 아니라 그 문장이 실려 있다';
    const authored = await authorGoal([
      '사람이 쓴 씨앗만 보존한다.',
      `불변식: ${invariant}`,
      `판정 신호: condition = ${condition}; observation = ${observation}; expected result = ${expectedResult}`,
    ].join(' '), {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: ['src/example.ts:42 — ordinary Read-verified completion evidence.'] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    expect(invariants).toBe(`## 불변식\n- Invariant candidate: ${invariant}\n  - UNVERIFIABLE: No persistent evidence mentions a path named by this invariant; human or child must confirm new evidence.\n\n`);
    expect(signals).toContain(`  - Condition: ${condition}`);
    expect(signals).toContain(`  - Observation: ${observation}`);
    expect(signals).toContain(`  - Expected result: ${expectedResult}`);
    expect(invariants).not.toContain('ordinary Read-verified completion evidence');
    expect(signals).not.toContain('ordinary Read-verified completion evidence');
  });

  test('keeps dedicated source spans out of enhancer input while preserving ordinary requirements and dedicated output', async () => {
    const invariant = '전용 불변식은 요구 칸에 넣지 않는다.';
    const boundary = '전용 경계는 이 골에서 바꾸지 않는다.';
    const limitation = '전용 한계는 이 골에서 판별하지 않는다.';
    const signal = '판정 신호: condition = 전용 신호; observation = 전용 출력; expected result = 한 번만 나타난다.';
    const requested = '일반 요구는 다듬기 입력과 요구 칸에 남는다.';
    const seen: string[] = [];
    const authored = await authorGoal([
      `불변식: ${invariant}`,
      `경계: ${boundary}`,
      `답하지 못하는 것: ${limitation}`,
      signal,
      requested,
    ].join('\n'), {
      ...deps,
      enhance: async (original) => {
        seen.push(original);
        const checklist = [requested];
        if (original.includes(boundary)) checklist.push(`경계: ${boundary} (라벨이 붙은 변형)`);
        if (original.includes(invariant)) checklist.push(`불변식: ${invariant.replace('않는다.', '않으며, 요구가 아니다.')}`);
        if (original.includes(limitation)) checklist.push(`${limitation} (어미가 변형됨)`);
        return { original, checklist, verbatimPreserved: true };
      },
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );
    const limitations = authored.document.slice(authored.document.indexOf('## 답하지 못하는 것'), authored.document.indexOf('### 수용 구별 관측'));
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const boundaries = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'), authored.document.indexOf('## 답하지 못하는 것'));

    expect(seen).toEqual([requested]);
    expect(seen[0]).toContain(requested);
    expect(seen[0]).not.toContain(invariant);
    expect(seen[0]).not.toContain(boundary);
    expect(seen[0]).not.toContain(limitation);
    expect(seen[0]).not.toContain(signal);
    expect(acceptance).toContain(`- Checkable requested criterion: ${requested}`);
    expect(acceptance).not.toContain(invariant);
    expect(acceptance).not.toContain(boundary);
    expect(acceptance).not.toContain(limitation);
    expect(invariants).toContain(`- Invariant candidate: ${invariant}`);
    expect(boundaries).toContain(`- Boundary decision: ${boundary}`);
    expect(limitations).toContain(`- Author limitation: ${limitation}`);
  });

  test('skips enhancement for adjacent dedicated-only sections while retaining each output', async () => {
    const invariant = '전용 불변식만 있는 요청이다.';
    const boundary = '인접 전용 경계도 함께 제외한다.';
    const enhance = mock(async (original: string) => ({ original, checklist: ['unexpected'], verbatimPreserved: true }));
    const authored = await authorGoal(`불변식: ${invariant}\n경계: ${boundary}`, { ...deps, enhance });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const boundaries = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'), authored.document.indexOf('## 답하지 못하는 것'));

    expect(enhance).not.toHaveBeenCalled();
    expect(acceptance).not.toContain('unexpected');
    expect(invariants).toContain(`- Invariant candidate: ${invariant}`);
    expect(boundaries).toContain(`- Boundary decision: ${boundary}`);
  });

  test('keeps dedicated invariant, decision-signal, and boundary content once while retaining distinct requested criteria', async () => {
    const invariant = '절 제목과 순서를 유지한다.';
    const signal = '판정 신호: condition = 전용 절을 포함한 요청; observation = 문서의 동일 문장 수; expected result = 한 번만 나타난다.';
    const boundary = 'PR 본문 생성은 이 착지의 대상이 아니다.';
    const similarInvariant = '절 제목과 순서를 유지한다. 단, 수용 기준에서 검증한다.';
    const requested = '비중복 수용 기준은 그대로 소비한다.';
    const authored = await authorGoal([
      `불변식: ${invariant}`,
      signal,
      `경계: ${boundary}`,
      similarInvariant,
      requested,
    ].join('\n'), {
      ...deps,
      enhance: async (original) => ({
        original,
        checklist: [`불변식: ${invariant}`, signal, `경계: ${boundary}`, similarInvariant, requested],
        verbatimPreserved: true,
      }),
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );
    const consumerLines = acceptance.match(/^- Checkable requested criterion: .+$/gm) ?? [];

    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));
    const boundaries = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'), authored.document.indexOf('## 불변식'));

    expect(invariants).toContain(`- Invariant candidate: ${invariant}`);
    expect(signals).toContain('  - Condition: 전용 절을 포함한 요청');
    expect(boundaries).toContain(`- Boundary decision: ${boundary}`);
    expect(acceptance).not.toContain(`- Checkable requested criterion: 불변식: ${invariant}`);
    expect(acceptance).not.toContain(`- Checkable requested criterion: ${signal}`);
    expect(acceptance).not.toContain(`- Checkable requested criterion: 경계: ${boundary}`);
    expect(consumerLines).toEqual([
      `- Checkable requested criterion: ${similarInvariant}`,
      `- Checkable requested criterion: ${requested}`,
    ]);
    expect(authored.document).toMatch(/## ACCEPTANCE CRITERIA[\s\S]*## REQUIRED EVIDENCE[\s\S]*## TRACED PATHS[\s\S]*## SCOPE BOUNDARY[\s\S]*## 불변식[\s\S]*## 판정 신호/);
  });

  test('retains an external-path boundary outside requested criteria while keeping an in-target request', async () => {
    const boundary = '능력 선언과 `src/unrelated-settings.ts`는 이 골에서 만들지 않는다.';
    const requested = '`src/self-implement/goal-author.ts`에서 경계 문장을 검증 가능한 요구에서 제외한다.';
    const authored = await authorGoal([
      `경계: ${boundary}`,
      requested,
    ].join('\n'), {
      ...deps,
      enhance: async (original) => ({
        original,
        checklist: [`- 경계: ${boundary}`, requested],
        verbatimPreserved: true,
      }),
    });
    const originalAsk = authored.document.slice(
      authored.document.indexOf(ORIGINAL_ASK_MARKER),
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
    );
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );
    const boundaries = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 답하지 못하는 것'),
    );

    expect(originalAsk).toContain(`경계: ${boundary}`);
    expect(boundaries).toContain(`- Boundary decision: ${boundary}`);
    expect(acceptance).not.toContain(boundary);
    expect(acceptance).not.toContain('src/unrelated-settings.ts');
    expect(acceptance).toContain(`- Checkable requested criterion: ${requested}`);
  });

  test('renders author limitations distinctly from absent, empty, and heading-form markers without changing boundary or invariant sections', async () => {
    const limitation = '대상 안의 두 상태는 같은 값으로 도착하므로 이 골에서 구별할 수 없다.';
    const boundary = '발사 흐름은 이 착지의 대상이 아니다.';
    const invariant = 'src/self-implement/goal-author.ts의 경계와 불변식 마커는 그대로 둔다.';
    const [specified, absent, empty, headingForm] = await Promise.all([
      authorGoal(`답하지 못하는 것: ${limitation}\n경계: ${boundary}\n불변식: ${invariant}`, deps),
      authorGoal(`경계: ${boundary}\n불변식: ${invariant}`, deps),
      authorGoal('답하지 못하는 것:', deps),
      authorGoal(`# 답하지 못하는 것\n${limitation}`, deps),
    ]);
    const section = (document: string) => document.slice(document.indexOf('## 답하지 못하는 것'), document.indexOf('### 수용 구별 관측'));
    const boundaries = specified.document.slice(specified.document.indexOf('## SCOPE BOUNDARY'), specified.document.indexOf('## 답하지 못하는 것'));
    const invariants = specified.document.slice(specified.document.indexOf('## 불변식'), specified.document.indexOf('## 판정 신호'));

    expect(section(specified.document)).toBe(`## 답하지 못하는 것\n- Author limitation: ${limitation}\n\n`);
    expect(section(absent.document)).toBe('## 답하지 못하는 것\n- 없다.\n\n');
    expect(section(empty.document)).toContain('Ask contains a limitation marker');
    expect(section(empty.document)).not.toContain('- 없다.');
    expect(section(headingForm.document)).toContain('Ask uses a heading-form limitation; headings are diagnostic only');
    expect(section(headingForm.document)).not.toContain(`- Author limitation: ${limitation}`);
    expect(lintGoalFile(headingForm.document, 'main')).toContainEqual(expect.objectContaining({
      level: 'WARN', tag: 'heading-form-marker', message: expect.stringContaining('heading-form limitation'),
    }));
    expect(boundaries).toContain(`- Boundary decision: ${boundary}`);
    expect(invariants).toContain(`- Invariant candidate: ${invariant}`);
    expect(specified.document).toMatch(/## SCOPE BOUNDARY[\s\S]*## 답하지 못하는 것[\s\S]*## 불변식[\s\S]*## 판정 신호/);
  });

  test('keeps both limitation-section aliases, including qualified markers, out of requested criteria while retaining separate requests', async () => {
    for (const label of ['답하지 못하는 것', '한계로 두는 것']) {
      const limitation = `${label} 절의 문장은 요구가 아니다.`;
      const requested = `${label} 절 밖의 문장은 요구로 남는다.`;
      const authored = await authorGoal(`${label} (저자 선언): ${limitation}\n${requested}`, {
        ...deps,
        enhance: async (original) => ({ original, checklist: [limitation, requested], verbatimPreserved: true }),
      });
      const acceptance = authored.document.slice(
        authored.document.indexOf('## ACCEPTANCE CRITERIA'),
        authored.document.indexOf('## REQUIRED EVIDENCE'),
      );
      const limitations = authored.document.slice(
        authored.document.indexOf('## 답하지 못하는 것'),
        authored.document.indexOf('### 수용 구별 관측'),
      );

      expect(limitations).toContain(`- Author limitation: ${limitation}`);
      expect(acceptance).not.toContain(`- Checkable requested criterion: ${limitation}`);
      expect(acceptance).toContain(`- Checkable requested criterion: ${requested}`);
    }
  });

  test('keeps acceptance criteria and enhancer input byte-identical when no dedicated-section marker is present', async () => {
    const raw = '  표지가 없는 요청\n\n마지막 줄도 보존한다.  \n';
    const criterion = '비표지 수용 기준은 기존 접두로 남는다.';
    const seen: string[] = [];
    const authored = await authorGoal(raw, {
      ...deps,
      enhance: async (original) => {
        seen.push(original);
        return { original, checklist: [criterion], verbatimPreserved: true };
      },
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(raw);
    expect(acceptance).toContain(`- Checkable requested criterion: ${criterion}`);
    expect(acceptance.match(/^- Checkable requested criterion: .+$/gm)).toEqual([
      `- Checkable requested criterion: ${criterion}`,
    ]);
  });

  test('inspects decision-signal marker and extraction separately before authoring', () => {
    expect(inspectAskDecisionSignalMarker('판정 신호: condition = c; observation = o; expected result = e')).toEqual({
      matched: true,
      marker: true,
      extracted: true,
      matches: [{ match: '판정 신호:', expectsPresence: 'unreadable', expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
      allNegative: true,
      unreadableCount: 1,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
      condition: 'c',
      observation: 'o',
      expectedResult: 'e',
      expectedResultClassification: 'indeterminate',
    });
    expect(inspectAskDecisionSignalMarker('판정 신호 (설명): condition = c; observation = o; expected result = e')).toEqual({
      matched: true,
      marker: true,
      extracted: false,
      matches: [{ match: '판정 신호 (설명):', expectsPresence: null, expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
      allNegative: true,
      unreadableCount: 0,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
    });
    expect(inspectAskDecisionSignalMarker('판정 신호 condition = c; observation = o; expected result = e')).toEqual({
      matched: false,
      marker: false,
      extracted: false,
      matches: [],
      allNegative: true,
      unreadableCount: 0,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
    });
  });

  test('annotates inspect-decision-signal matches with expected presence and all-negative observation', () => {
    const negativeAsk = [
      '판정 신호: 조건 = 인자 누락 호출; 관측 = JSON 의 allNegative; 기대 = 없다',
      '판정 신호: 조건 = 실패 칸; 관측 = 통과 여부; 기대 = 0',
      '판정 신호: 조건 = 제거된 경로; 관측 = 산출; 기대 = 사라졌다',
    ].join(' ');
    const negative = inspectAskDecisionSignalMarker(negativeAsk);
    expect(negative.matched).toBe(true);
    expect(negative.extracted).toBe(true);
    expect(negative.matches).toHaveLength(3);
    expect(negative.matches.map((match) => match.match.trim())).toEqual(['판정 신호:', '판정 신호:', '판정 신호:']);
    expect(negative.matches.map((match) => match.expectsPresence)).toEqual([false, false, false]);
    expect(negative.matches.map((match) => match.expectsAlternatives)).toEqual([false, false, false]);
    expect(negative.matches.map((match) => match.observesCount)).toEqual([false, false, false]);
    expect(negative.allNegative).toBe(true);
    expect(negative.unreadableCount).toBe(0);
    expect(negative.anyAlternatives).toBe(false);
    expect(negative.anyObservesCount).toBe(false);

    const knownPositiveAsk = `${negativeAsk} 판정 신호: 조건 = 평범한 새 경로; 관측 = 선언; 기대 = 여전히 있다`;
    const knownPositive = inspectAskDecisionSignalMarker(knownPositiveAsk);
    expect(knownPositive.matched).toBe(true);
    expect(knownPositive.extracted).toBe(true);
    expect(knownPositive.matches).toHaveLength(4);
    expect(knownPositive.matches.map((match) => match.match.trim())).toEqual(['판정 신호:', '판정 신호:', '판정 신호:', '판정 신호:']);
    expect(knownPositive.matches.map((match) => match.expectsPresence)).toEqual([false, false, false, true]);
    expect(knownPositive.matches.map((match) => match.expectsAlternatives)).toEqual([false, false, false, false]);
    expect(knownPositive.matches.map((match) => match.observesCount)).toEqual([false, false, false, false]);
    expect(knownPositive.allNegative).toBe(false);
    expect(knownPositive.unreadableCount).toBe(0);
    expect(knownPositive.anyAlternatives).toBe(false);
    expect(knownPositive.anyObservesCount).toBe(false);
  });

  test('distinguishes both-matched presence from unreadability and counts unreadables beside allNegative', () => {
    const inspect = (expectedResult: string) => inspectAskDecisionSignalMarker(
      `판정 신호: 조건 = 요청문; 관측 = 프로브 반환값; 기대 = ${expectedResult}`,
    );

    const bothMatched = inspect('0 이 아닌 코드로 멈추고 산출에 그 이름과 대안 이름이 둘 다 있다');
    const neitherMatched = inspect('성공이고 별명이 그 문자열이 된다');
    const presenceOnly = inspect('여전히 있다');

    expect(bothMatched.matches[0]?.expectsPresence).toBeNull();
    expect(neitherMatched.matches[0]?.expectsPresence).toBe('unreadable');
    expect(bothMatched.matches[0]?.expectsPresence).not.toBe(neitherMatched.matches[0]?.expectsPresence);
    expect(presenceOnly.matches[0]?.expectsPresence).toBe(true);
    expect(presenceOnly.allNegative).toBe(false);
    expect(presenceOnly.unreadableCount).toBe(0);

    const unreadablesOnly = inspectAskDecisionSignalMarker([
      '판정 신호: 조건 = 별명; 관측 = 산출 문자열; 기대 = 성공이고 별명이 그 문자열이 된다',
      '판정 신호: 조건 = 통과; 관측 = 결과; 기대 = 성공이다',
    ].join(' '));
    expect(unreadablesOnly.matches.map((match) => match.expectsPresence)).toEqual(['unreadable', 'unreadable']);
    expect(unreadablesOnly.unreadableCount).toBe(2);
    expect(unreadablesOnly.allNegative).toBe(true);

    const mixedReadable = inspectAskDecisionSignalMarker([
      '판정 신호: 조건 = 양면; 관측 = 산출; 기대 = 0 이 아닌 코드로 멈추고 산출에 그 이름이 있다',
      '판정 신호: 조건 = 별명; 관측 = 산출 문자열; 기대 = 성공이고 별명이 그 문자열이 된다',
      '판정 신호: 조건 = 부재; 관측 = JSON; 기대 = 없다',
    ].join(' '));
    expect(mixedReadable.matches.map((match) => match.expectsPresence)).toEqual([null, 'unreadable', false]);
    expect(mixedReadable.unreadableCount).toBe(1);
    expect(mixedReadable.allNegative).toBe(true);

    const source = readFileSync(new URL('./goal-author.ts', import.meta.url), 'utf8');
    expect(source).toContain('const ABSENCE_EXPECTATION = /없다|(?<!\\d)0(?!\\d)|아니다|사라졌다/u;');
    expect(source).toContain('const PRESENCE_EXPECTATION = /있다|여전히|유지|크다|이상/u;');
  });

  test('keeps classifier results intact while lint separates unreadable expectations from absence expectations', () => {
    const absence = inspectAskDecisionSignalMarker('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 없다');
    const presence = inspectAskDecisionSignalMarker('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 여전히 있다');
    const both = inspectAskDecisionSignalMarker('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 0 이 아닌 코드가 있다');
    const unreadable = inspectAskDecisionSignalMarker('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 성공이고 별명이 그 문자열이 된다');

    expect(absence.matches[0]?.expectsPresence).toBe(false);
    expect(presence.matches[0]?.expectsPresence).toBe(true);
    expect(both.matches[0]?.expectsPresence).toBeNull();
    expect(unreadable.matches[0]?.expectsPresence).toBe('unreadable');
    expect(allNegativeSignalsLintMessage()).toContain('explicitly expects only absence');
    expect(allNegativeSignalsLintMessage()).toContain('revise the signal');
    expect(allNegativeSignalsLintMessage()).toContain('`여전히`');
    expect(unreadableSignalsLintMessage()).toContain('`없다`, `0`, `아니다`, `사라졌다`');
    expect(unreadableSignalsLintMessage()).toContain('`있다`, `여전히`, `유지`, `크다`, `이상`');
    expect(unreadableSignalsLintMessage()).toContain('do not insert this vocabulary');
    expect(unreadableSignalsLintMessage()).toContain('report the classifier limitation instead');

    const base = '## PROBLEM\nproblem\n\n## WHAT TO BUILD\nbuild\n\n## ACCEPTANCE CRITERIA\ncriteria\n\n## REQUIRED EVIDENCE\n- [proof] command\n\n## TRACED PATHS\npaths\n\n## SCOPE BOUNDARY\nboundary\n\n## 답하지 못하는 것\nnone\n\n## 불변식\nkeep\n\n## 판정 신호\n';
    const lintTags = (signal: string) => lintGoalFile(`${base}${signal}`, 'main').map((finding) => finding.tag);
    expect(lintTags('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 없다')).toContain('all-negative-signals');
    expect(lintTags('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 성공이고 별명이 그 문자열이 된다')).toContain('unreadable-signals');
    expect(lintTags('판정 신호: 조건 = 종료; 관측 = 종료 코드; 기대 = 0\n판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 성공이고 별명이 그 문자열이 된다')).not.toContain('all-negative-signals');
    expect(lintTags('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 0 이 아닌 코드가 있다')).not.toContain('all-negative-signals');
    expect(lintTags('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 0 이 아닌 코드가 있다')).not.toContain('unreadable-signals');
    expect(lintTags('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 여전히 있다')).not.toContain('all-negative-signals');
    expect(lintTags('판정 신호: 조건 = 요청문; 관측 = 출력; 기대 = 여전히 있다')).not.toContain('unreadable-signals');
  });

  test('treats exit-code zero assertions as values while retaining zero-count absence expectations', () => {
    const inspect = (expectedResult: string) => inspectAskDecisionSignalMarker(
      `판정 신호: 조건 = 요청문; 관측 = 프로브 반환값; 기대 = ${expectedResult}`,
    );

    expect(inspect('종료 코드가 0 이다').matches[0]?.expectsPresence).toBe('unreadable');
    expect(inspect('종료 코드가 0이 아니다').matches[0]?.expectsPresence).toBe('unreadable');
    expect(inspect('종료 코드가 0 이다. 재시도 종료 코드는 0이다').matches[0]?.expectsPresence).toBe('unreadable');
    expect(inspect('값은 0이다').matches[0]?.expectsPresence).toBe('unreadable');
    expect(inspect('0을 반환한다').matches[0]?.expectsPresence).toBe('unreadable');
    expect(inspect('종료 코드는 0이다. 결과가 없다').matches[0]?.expectsPresence).toBe(false);
    expect(inspect('결과가 0건이다').matches[0]?.expectsPresence).toBe(false);
    expect(inspect('결과값이 0건이다').matches[0]?.expectsPresence).toBe(false);
    expect(inspect('아무 결과도 없다').matches[0]?.expectsPresence).toBe(false);
  });

  test('treats numeric 0 as absence only when it is an independent value', () => {
    const inspect = (expectedResult: string) => inspectAskDecisionSignalMarker(
      `판정 신호: 조건 = 요청문; 관측 = 프로브 반환값; 기대 = ${expectedResult}`,
    );

    const standaloneZero = inspect('0');
    expect(standaloneZero.matched).toBe(true);
    expect(standaloneZero.matches).toHaveLength(1);
    expect(standaloneZero.matches[0]?.expectsPresence).toBe(false);
    expect(standaloneZero.matches[0]?.expectsAlternatives).toBe(false);
    expect(standaloneZero.allNegative).toBe(true);
    expect(standaloneZero.anyAlternatives).toBe(false);

    const zeroCount = inspect('0개');
    expect(zeroCount.matched).toBe(true);
    expect(zeroCount.matches).toHaveLength(1);
    expect(zeroCount.matches[0]?.expectsPresence).toBe(false);
    expect(zeroCount.matches[0]?.expectsAlternatives).toBe(false);
    expect(zeroCount.allNegative).toBe(true);
    expect(zeroCount.anyAlternatives).toBe(false);

    const tenOrMore = inspect('10개 이상');
    expect(tenOrMore.matched).toBe(true);
    expect(tenOrMore.matches).toHaveLength(1);
    expect(tenOrMore.matches[0]?.expectsPresence).toBe(true);
    expect(tenOrMore.matches[0]?.expectsAlternatives).toBe(false);
    expect(tenOrMore.allNegative).toBe(false);
    expect(tenOrMore.anyAlternatives).toBe(false);

    const hundredGreater = inspect('100보다 크다');
    expect(hundredGreater.matched).toBe(true);
    expect(hundredGreater.matches).toHaveLength(1);
    expect(hundredGreater.matches[0]?.expectsPresence).toBe(true);
    expect(hundredGreater.matches[0]?.expectsAlternatives).toBe(false);
    expect(hundredGreater.allNegative).toBe(false);
    expect(hundredGreater.anyAlternatives).toBe(false);

    const combinedPresence = inspect('10개 이상 여전히 있다');
    expect(combinedPresence.matched).toBe(true);
    expect(combinedPresence.matches).toHaveLength(1);
    expect(combinedPresence.matches[0]?.expectsPresence).toBe(true);
    expect(combinedPresence.matches[0]?.expectsAlternatives).toBe(false);
    expect(combinedPresence.allNegative).toBe(false);
    expect(combinedPresence.anyAlternatives).toBe(false);
  });

  test('annotates inspect-decision-signal matches with alternative-branch observation', () => {
    const inspect = (expectedResult: string) => inspectAskDecisionSignalMarker(
      `판정 신호: 조건 = 요청문; 관측 = 프로브 반환값; 기대 = ${expectedResult}`,
    );

    const alternatives = inspect('A 거나 B 거나 C 중 하나가 있다');
    expect(alternatives.matched).toBe(true);
    expect(alternatives.matches).toHaveLength(1);
    expect(alternatives.matches[0]?.expectsPresence).toBe(true);
    expect(alternatives.matches[0]?.expectsAlternatives).toBe(true);
    expect(alternatives.matches[0]?.observesCount).toBe(false);
    expect(alternatives.allNegative).toBe(false);
    expect(alternatives.anyAlternatives).toBe(true);
    expect(alternatives.anyObservesCount).toBe(false);

    const knownNegative = inspect('X 가 있다');
    expect(knownNegative.matched).toBe(true);
    expect(knownNegative.matches).toHaveLength(1);
    expect(knownNegative.matches[0]?.expectsPresence).toBe(true);
    expect(knownNegative.matches[0]?.expectsAlternatives).toBe(false);
    expect(knownNegative.allNegative).toBe(false);
    expect(knownNegative.anyAlternatives).toBe(false);

    const conjunction = inspect('A 하고 B 한다');
    expect(conjunction.matched).toBe(true);
    expect(conjunction.matches).toHaveLength(1);
    expect(conjunction.matches[0]?.expectsAlternatives).toBe(false);
    expect(conjunction.anyAlternatives).toBe(false);

    expect(inspect('A 또는 B 가 있다').matches[0]?.expectsAlternatives).toBe(true);
    expect(inspect('아무거나 있다').matches[0]?.expectsAlternatives).toBe(true);

    // 실측 오탐: 한 낱말 안의 어미 `거나`는 대안 갈래가 아니다.
    expect(inspect('[ledger-gate] PASS — 이 브랜치가 더하거나 고친 원장 항목이 없다.').matches[0]?.expectsAlternatives).toBe(false);
    // 판정 신호가 이름으로 댄 진짜 대안. 원문 「아래 진짜 사례」의 구체 문면은 제공되지 않음 (visible omission).
    expect(inspect('통과하거나 실패한다').matches[0]?.expectsAlternatives).toBe(true);
  });

  test('annotates inspect-decision-signal matches when observation measures a count', () => {
    const inspect = (observation: string, expectedResult = '줄지 않는다') => inspectAskDecisionSignalMarker(
      `판정 신호: 조건 = 요청문; 관측 = ${observation}; 기대 = ${expectedResult}`,
    );

    const testCount = inspect('시험 «개수»');
    expect(testCount.matched).toBe(true);
    expect(testCount.extracted).toBe(true);
    expect(testCount.matches).toHaveLength(1);
    expect(testCount.matches[0]?.observesCount).toBe(true);
    expect(testCount.anyObservesCount).toBe(true);
    expect(testCount.matches[0]?.expectsPresence).toBe('unreadable');
    expect(testCount.matches[0]?.expectsAlternatives).toBe(false);
    expect(testCount.allNegative).toBe(true);
    expect(testCount.unreadableCount).toBe(1);
    expect(testCount.anyAlternatives).toBe(false);

    const failCount = inspect('fail 수', '0');
    expect(failCount.matches[0]?.observesCount).toBe(true);
    expect(failCount.anyObservesCount).toBe(true);
    expect(failCount.matches[0]?.expectsPresence).toBe(false);
    expect(failCount.allNegative).toBe(true);

    expect(inspect('건수').matches[0]?.observesCount).toBe(true);
    expect(inspect('count').matches[0]?.observesCount).toBe(true);
    expect(inspect('N').matches[0]?.observesCount).toBe(true);

    const content = inspect('산출 `document` 안의 문면', '없다');
    expect(content.matched).toBe(true);
    expect(content.extracted).toBe(true);
    expect(content.matches).toHaveLength(1);
    expect(content.matches[0]?.observesCount).toBe(false);
    expect(content.anyObservesCount).toBe(false);
    expect(content.matches[0]?.expectsPresence).toBe(false);
    expect(content.matches[0]?.expectsAlternatives).toBe(false);
    expect(content.allNegative).toBe(true);
    expect(content.anyAlternatives).toBe(false);

    const mixed = inspectAskDecisionSignalMarker([
      '판정 신호: 조건 = 시험 개수; 관측 = 시험 «개수»; 기대 = 줄지 않는다',
      '판정 신호: 조건 = 산출 문면; 관측 = 산출 `document` 안의 문면; 기대 = 없다',
    ].join(' '));
    expect(mixed.matched).toBe(true);
    expect(mixed.extracted).toBe(true);
    expect(mixed.matches).toHaveLength(2);
    expect(mixed.matches.map((match) => match.observesCount)).toEqual([true, false]);
    expect(mixed.anyObservesCount).toBe(true);
    expect(mixed.matches.map((match) => match.expectsPresence)).toEqual(['unreadable', false]);
    expect(mixed.matches.map((match) => match.expectsAlternatives)).toEqual([false, false]);
    expect(mixed.allNegative).toBe(true);
    expect(mixed.unreadableCount).toBe(1);
    expect(mixed.anyAlternatives).toBe(false);
  });

  test('parses the optional artifact launch declaration and exposes it through inspection', () => {
    const document = `## WHAT TO BUILD\ncontent\n\n${ARTIFACT_LAUNCH_INSPECTION_FIXTURE_TEXT}\n\n## ACCEPTANCE CRITERIA\ncontent`;

    expect(parseArtifactLaunchDeclaration(document)).toEqual({
      entrypoint: 'src/server.ts',
      port: 4310,
      environment: ['API_TOKEN', 'LOG_LEVEL'],
      errors: [],
    });
    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: {
        entrypoint: 'src/server.ts',
        port: 4310,
        environment: ['API_TOKEN', 'LOG_LEVEL'],
        errors: [],
      },
      stoppedAt: { line: 10, text: '## ACCEPTANCE CRITERIA' },
    });
  });

  test('keeps goals without an artifact launch declaration unchanged and visible as absent', () => {
    const document = GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION;
    const establishedProcessing = {
      lint: lintGoalFile(document, 'main'),
      requiredSections: ['PROBLEM', 'WHAT TO BUILD', 'ACCEPTANCE CRITERIA', 'REQUIRED EVIDENCE', 'TRACED PATHS', 'SCOPE BOUNDARY', '답하지 못하는 것', '불변식', '판정 신호']
        .map((title) => [title, markdownSection(document, title)] as const),
      targetPaths: tracedPathReferences(document),
      decisionSignal: markdownSection(document, '판정 신호'),
    };

    expect(parseArtifactLaunchDeclaration(document)).toBeNull();
    expect(inspectArtifactLaunchDeclaration(document)).toEqual({ declared: false, extracted: false });
    expect(establishedProcessing).toEqual({
      lint: [] as unknown as ReturnType<typeof lintGoalFile>,
      requiredSections: [
        ['PROBLEM', 'content\n'],
        ['WHAT TO BUILD', 'content\n'],
        ['ACCEPTANCE CRITERIA', 'content\n'],
        ['REQUIRED EVIDENCE', '- [requested] focused test output\n'],
        ['TRACED PATHS', '1. src/example.ts — existing path\n'],
        ['SCOPE BOUNDARY', '- Boundary decision: only this document is inspected.\n'],
        ['답하지 못하는 것', '- 없다.\n'],
        ['불변식', '- Invariant candidate: existing markers remain unchanged.\n'],
        ['판정 신호', '- Candidate decision signal:\n  - Condition: inspect the established document\n  - Observation: lintGoalFile receives it\n  - Expected result: established output remains unchanged\n\n대상 경로: src/example.ts'],
      ],
      targetPaths: [{ path: 'src/example.ts', line: null, endLine: null }],
      decisionSignal: '- Candidate decision signal:\n  - Condition: inspect the established document\n  - Observation: lintGoalFile receives it\n  - Expected result: established output remains unchanged\n\n대상 경로: src/example.ts',
    });
  });

  test('classifies only structured server entries and boundary-safe loopback addresses as missing artifact-launch declaration signals', () => {
    const serverEntry = GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION.replace('src/example.ts', 'src/server.ts');
    const loopbackAddress = `${GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION}\nhttp://localhost:4310`;
    const prefixedHostname = `${GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION}\nhttp://api.localhost:4310`;
    const prefixedNumericAddress = `${GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION}\nhttp://x127.0.0.1:4310`;
    const declared = `${GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION}\n\n## 산출물을 어떻게 켜나\nPort: 4310\n`;

    for (const document of [serverEntry, loopbackAddress]) {
      const findings = lintGoalFile(document, 'main');
      expect(findings.artifactLaunchDeclarationClassification).toBe('absent-with-signal');
      expect(findings).toContainEqual({
        level: 'WARN',
        tag: 'artifact-launch-declaration',
        message: 'goal has a structured server entry path or loopback address with port but no artifact launch declaration',
      });
    }
    for (const document of [prefixedHostname, prefixedNumericAddress]) {
      const findings = lintGoalFile(document, 'main');
      expect(findings.artifactLaunchDeclarationClassification).toBe('absent-without-signal');
      expect(findings).not.toContainEqual(expect.objectContaining({ tag: 'artifact-launch-declaration' }));
    }
    const declaredFindings = lintGoalFile(declared, 'main');
    expect(declaredFindings.artifactLaunchDeclarationClassification).toBe('declared');
    expect(declaredFindings).not.toContainEqual(expect.objectContaining({ tag: 'artifact-launch-declaration' }));
  });

  test('observes missing artifact-launch declaration classification during authoring without changing declared output', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const declaredAsk = [
      '대상 경로: src/server.ts',
      '## 산출물을 어떻게 켜나',
      'Entrypoint: src/server.ts',
      'Port: 4310',
    ].join('\n');
    try {
      await authorGoal('대상 경로: src/server.ts', deps);
      const declared = await authorGoal(declaredAsk, deps);

      expect(log).toHaveBeenCalledWith('goal-author', 'artifact-launch-declaration-classification', {
        authorRunId: expect.any(String),
        classification: 'absent-with-signal',
      });
      expect(log).toHaveBeenCalledWith('goal-author', 'artifact-launch-declaration-classification', {
        authorRunId: expect.any(String),
        classification: 'declared',
      });
      expect(markdownSection(declared.document, '산출물을 어떻게 켜나')).toBe('Entrypoint: src/server.ts\nPort: 4310\n');
    } finally {
      log.mockRestore();
    }
  });

  // ⭐ 2026-09-25 — 실물 docs/goals 골 문서를 읽는 시험은 goal-author-real-goal-docs.test.ts 로 옮겼다(원본 전용 · 공개본 exclude).

  test('reports an empty artifact launch declaration as unextracted', () => {
    const document = '## 산출물을 어떻게 켜나\n\n## ACCEPTANCE CRITERIA\ncontent';

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: false,
      declaration: {
        environment: [],
        errors: ['launch declaration must contain an Entrypoint, Port, or Environment entry'],
      },
      stoppedAt: { line: 3, text: '## ACCEPTANCE CRITERIA' },
    });
  });

  test('reports malformed artifact launch declarations instead of silently accepting them', () => {
    const document = `## 산출물을 어떻게 켜나\nEntrypoint: \nPort: 70000\nEnvironment: API_TOKEN, API_TOKEN, secret=value\nEnvironment：IGNORED\n`;

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: false,
      declaration: {
        environment: ['API_TOKEN'],
        errors: [
          'Entrypoint must not be empty',
          'Port must be an integer from 1 through 65535',
          'Environment must not repeat: API_TOKEN',
          'Environment must name a variable, not a value: secret=value',
        ],
      },
      stoppedAt: { line: 5, text: 'Environment：IGNORED' },
    });
  });

  test('stops declaration parsing at prose after recognized labels while preserving the stop position', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      '',
      'Entrypoint: npm start',
      '',
      'The service exposes the health endpoint after startup.',
      'This following prose is not a declaration either.',
    ].join('\n');

    expect(parseArtifactLaunchDeclaration(document)).toEqual({ port: 43999, entrypoint: 'npm start', environment: [], errors: [] });
    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 6, text: 'The service exposes the health endpoint after startup.' },
    });
  });

  test('makes a typo observable through the declaration stop position without treating following prose as errors', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      'Entrypiont: npm start',
      'More prose after the typo.',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, environment: [], errors: [] },
      stoppedAt: { line: 3, text: 'Entrypiont: npm start' },
    });
  });

  test('stops at an opening fence and does not consume labels after its fenced example', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      'Entrypoint: npm start',
      '```sh',
      'Port: 4312',
      'Entrypoint: npm run example',
      '```',
      'Port: 9876',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 4, text: '```sh' },
    });
  });

  test('preserves an unclosed opening fence as the H2 declaration stop position', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      'Entrypoint: npm start',
      '```sh',
      'Port: 4312',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 4, text: '```sh' },
    });
  });

  test('preserves an unclosed opening fence as the colon-label declaration stop position', () => {
    const document = [
      '산출물을 어떻게 켜나:',
      'Port: 43999',
      'Entrypoint: npm start',
      '~~~',
      'Port: 4312',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 4, text: '~~~' },
    });
  });

  test('stops a colon-label declaration at an opening fence before later labels', () => {
    const document = [
      '산출물을 어떻게 켜나:',
      'Port: 43999',
      '~~~',
      'Entrypoint: npm run example',
      '~~~',
      'Entrypoint: npm start',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, environment: [], errors: [] },
      stoppedAt: { line: 3, text: '~~~' },
    });
  });

  test('reports a stop position for colon-label declarations that end at prose', () => {
    const document = [
      '산출물을 어떻게 켜나:',
      'Port: 43999',
      '',
      'Entrypoint: npm start',
      'The declaration prose begins here.',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 5, text: 'The declaration prose begins here.' },
    });
  });

  test('reports the same H2 declaration stop line for CRLF input', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      '',
      'Entrypoint: npm start',
      'The declaration prose begins here.',
    ].join('\r\n');

    expect(inspectArtifactLaunchDeclaration(document)).toMatchObject({
      declared: true,
      extracted: true,
      stoppedAt: { line: 5, text: 'The declaration prose begins here.' },
    });
  });

  test('stops an H2 declaration at prose without emitting declaration errors', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      '',
      'Entrypoint: npm start',
      'The declaration prose begins here.',
      'This later prose is not parsed as a declaration.',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 5, text: 'The declaration prose begins here.' },
    });
  });

  test('preserves the H1/H2 heading where declaration parsing stops', () => {
    const document = [
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      'Entrypoint: npm start',
      '## ACCEPTANCE CRITERIA',
      'The declaration section has ended.',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, entrypoint: 'npm start', environment: [], errors: [] },
      stoppedAt: { line: 4, text: '## ACCEPTANCE CRITERIA' },
    });
  });

  test('does not close fenced code with mixed markers or a non-whitespace suffix', () => {
    const document = [
      '```',
      '산출물을 어떻게 켜나:',
      'Port: 4312',
      '~~~',
      'Port: 4313',
      '```oops',
      'Port: 4314',
      '```',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({ declared: false, extracted: false });
  });

  // ⭐ 2026-09-25 — 실물 docs/goals 골 문서를 읽는 시험은 goal-author-real-goal-docs.test.ts 로 옮겼다(원본 전용 · 공개본 exclude).

  test('reports the document line where parsing stops in an original-ask fallback', () => {
    const document = [
      '# Authored goal',
      '',
      '## PROBLEM',
      'Generated context before the preserved ask.',
      '',
      ORIGINAL_ASK_MARKER,
      '```',
      '## 산출물을 어떻게 켜나',
      'Port: 43999',
      '',
      'The original ask prose begins here.',
      '```',
      '',
      '## ACCEPTANCE CRITERIA',
      'Generated context after the preserved ask.',
    ].join('\n');

    expect(inspectArtifactLaunchDeclaration(document)).toEqual({
      declared: true,
      extracted: true,
      declaration: { port: 43999, environment: [], errors: [] },
      stoppedAt: { line: 11, text: 'The original ask prose begins here.' },
    });
  });

  test('promotes an artifact launch declaration outside verbatim provenance without changing its values or ask markers', async () => {
    const ask = [
      '대상 경로: src/server.ts',
      '불변식: parser contract remains unchanged.',
      '경계: declarations are not interpreted.',
      '판정 신호: condition = author the goal; observation = parse the document; expected result = values remain available.',
      '',
      '## 산출물을 어떻게 켜나',
      'Entrypoint: src/server.ts',
      'Port: 31416',
      'Environment: API_TOKEN, LOG_LEVEL',
    ].join('\n');
    const authored = await authorGoal(ask, deps);

    expect(parseArtifactLaunchDeclaration(authored.document)).toEqual({
      entrypoint: 'src/server.ts',
      port: 31416,
      environment: ['API_TOKEN', 'LOG_LEVEL'],
      errors: [],
    });
    expect(markdownSection(authored.document, '산출물을 어떻게 켜나')).toBe('Entrypoint: src/server.ts\nPort: 31416\nEnvironment: API_TOKEN, LOG_LEVEL\n');
    expect(verbatimOriginalAsk(authored.document)).toBe(ask);
    expect(authored.document.split(ORIGINAL_ASK_MARKER)).toHaveLength(2);
    const withoutPromotion = authored.document.replace(
      '## 산출물을 어떻게 켜나\nEntrypoint: src/server.ts\nPort: 31416\nEnvironment: API_TOKEN, LOG_LEVEL\n',
      '',
    );
    expect(inspectAskInvariantMarker(authored.document)).toEqual(inspectAskInvariantMarker(withoutPromotion));
    expect(inspectAskBoundaryMarker(authored.document)).toEqual(inspectAskBoundaryMarker(withoutPromotion));
    expect(inspectAskDecisionSignalMarker(authored.document)).toEqual(inspectAskDecisionSignalMarker(withoutPromotion));
  });

  test('promotes colon-label artifact launch declarations, observes their input form, and supplies the same declaration to scenario authoring', async () => {
    const request = [
      '대상 경로: src/server.ts',
      '산출물을 어떻게 켜나:',
      'Port: 41999',
      'Entrypoint: npm start',
      '## SCOPE BOUNDARY',
      'Port: 1',
    ].join('\n');
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    let scenarioLaunch: TestScenarioLaunchInput | null | undefined;
    try {
      const authored = await authorGoal(request, {
        ...deps,
        requestTestScenario: (input) => {
          scenarioLaunch = input.launch;
          return requestTestScenario(input);
        },
      });

      expect(markdownSection(authored.document, '산출물을 어떻게 켜나')).toBe('Port: 41999\nEntrypoint: npm start\n');
      expect(inspectArtifactLaunchDeclaration(authored.document)).toMatchObject({
        declared: true,
        extracted: true,
        declaration: { port: 41999, entrypoint: 'npm start', environment: [], errors: [] },
        stoppedAt: { text: '## 검증 시나리오' },
      });
      expect(scenarioLaunch).toBeDefined();
      expect(scenarioLaunch!).toMatchObject({ port: 41999, entrypoint: 'npm start' });
      expect(log).toHaveBeenCalledWith('goal-author', 'artifact-launch-declaration-source', {
        authorRunId: expect.any(String), source: 'label',
      });
      expect(verbatimOriginalAsk(authored.document)).toBe(request);
    } finally {
      log.mockRestore();
    }
  });

  test('stops label-form launch declarations before the next declaration label or prose just as H2 declarations do', async () => {
    const labelRequest = [
      '산출물을 어떻게 켜나:',
      'Port: 41999',
      'Entrypoint: npm start',
      '불변식: the following label remains outside the launch declaration.',
      'This prose remains outside the launch declaration.',
    ].join('\n');
    const headingRequest = [
      '## 산출물을 어떻게 켜나',
      'Port: 41999',
      'Entrypoint: npm start',
      '## 불변식',
      'the following label remains outside the launch declaration.',
      'This prose remains outside the launch declaration.',
    ].join('\n');

    const labelAuthored = await authorGoal(labelRequest, deps);
    const headingAuthored = await authorGoal(headingRequest, deps);

    const expectedLaunch = 'Port: 41999\nEntrypoint: npm start\n';
    expect(markdownSection(labelAuthored.document, '산출물을 어떻게 켜나')).toBe(expectedLaunch);
    expect(markdownSection(headingAuthored.document, '산출물을 어떻게 켜나')).toBe(expectedLaunch);
    expect(parseArtifactLaunchDeclaration(labelRequest)).toEqual({ port: 41999, entrypoint: 'npm start', environment: [], errors: [] });
    expect(inspectArtifactLaunchDeclaration(labelAuthored.document)).toMatchObject({ declared: true, extracted: true });
    expect(markdownSection(labelAuthored.document, '불변식')).toContain('the following label remains outside the launch declaration.');
    expect(markdownSection(labelAuthored.document, '산출물을 어떻게 켜나')).not.toContain('This prose remains outside the launch declaration.');
    expect(verbatimOriginalAsk(labelAuthored.document)).toBe(labelRequest);
  });

  test('does not bridge a fenced block when extracting a colon-label artifact launch declaration', async () => {
    const request = [
      '산출물을 어떻게 켜나:',
      'Port: 41999',
      '```sh',
      'Port: 1',
      'Entrypoint: should-not-be-promoted',
      '```',
      'Entrypoint: npm start',
    ].join('\n');
    let scenarioLaunch: TestScenarioLaunchInput | null | undefined;
    const authored = await authorGoal(request, {
      ...deps,
      requestTestScenario: (input) => {
        scenarioLaunch = input.launch;
        return requestTestScenario(input);
      },
    });

    expect(parseArtifactLaunchDeclaration(request)).toEqual({ port: 41999, environment: [], errors: [] });
    expect(markdownSection(authored.document, '산출물을 어떻게 켜나')).toBe('Port: 41999\n');
    expect(inspectArtifactLaunchDeclaration(authored.document)).toMatchObject({
      declared: true,
      extracted: true,
      declaration: { port: 41999, environment: [], errors: [] },
      stoppedAt: { text: '## 검증 시나리오' },
    });
    expect(scenarioLaunch).toMatchObject({ port: 41999 });
    expect(markdownSection(authored.document, '산출물을 어떻게 켜나')).not.toContain('should-not-be-promoted');
    expect(verbatimOriginalAsk(authored.document)).toBe(request);
  });

  test('preserves H2 artifact launch declarations and gives them precedence over colon-label declarations', async () => {
    const request = [
      '산출물을 어떻게 켜나:',
      'Port: 41999',
      '## 산출물을 어떻게 켜나',
      'Port: 31416',
    ].join('\n');
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal(request, deps);

      expect(markdownSection(authored.document, '산출물을 어떻게 켜나')).toBe('Port: 31416\n');
      expect(parseArtifactLaunchDeclaration(request)).toEqual({ port: 31416, environment: [], errors: [] });
      expect(log).toHaveBeenCalledWith('goal-author', 'artifact-launch-declaration-source', {
        authorRunId: expect.any(String), source: 'heading',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('keeps empty and malformed colon-label declarations observable without treating fenced labels as declarations', async () => {
    const empty = '산출물을 어떻게 켜나:';
    const malformed = '산출물을 어떻게 켜나:\nPort: 70000';
    const fenced = ['```', '산출물을 어떻게 켜나:', 'Port: 41999', '```'].join('\n');

    expect(inspectArtifactLaunchDeclaration(empty)).toEqual({
      declared: true,
      extracted: false,
      declaration: { environment: [], errors: ['launch declaration must contain an Entrypoint, Port, or Environment entry'] },
    });
    expect(inspectArtifactLaunchDeclaration(malformed)).toEqual({
      declared: true,
      extracted: false,
      declaration: { environment: [], errors: ['Port must be an integer from 1 through 65535'] },
    });
    expect(inspectArtifactLaunchDeclaration(fenced)).toEqual({ declared: false, extracted: false });
  });

  test('does not invent an artifact launch declaration when the ask omits it or places it only in fenced code', async () => {
    const absent = await authorGoal('대상 경로: src/server.ts\nNo launch declaration is provided.', deps);
    const fencedOnly = await authorGoal(['```', '## 산출물을 어떻게 켜나', 'Port: 31416', '```'].join('\n'), deps);

    for (const authored of [absent, fencedOnly]) {
      expect(markdownSection(authored.document, '산출물을 어떻게 켜나')).toBeNull();
      expect(parseArtifactLaunchDeclaration(authored.document)).toBeNull();
    }
  });

  test('promotes malformed artifact launch declarations so their existing parser errors remain observable', async () => {
    const ask = '## 산출물을 어떻게 켜나\nEnvironment: TOKEN=abc';
    const authored = await authorGoal(ask, deps);

    expect(parseArtifactLaunchDeclaration(authored.document)).toEqual({
      environment: [],
      errors: ['Environment must name a variable, not a value: TOKEN=abc'],
    });
    expect(verbatimOriginalAsk(authored.document)).toBe(ask);
  });

  test('accepts the registered deliverable-verify methodology while preserving unmeasured scenarios', () => {
    const unmeasured = [
      '> **산출물 종류**: `unknown`', '', '## L. 라이브', '### 상태 `unmeasured`',
      '- 사유: `no-methodology`', '- 무엇이 있었으면 됐나: `methodology registry`', '',
      '## 결과 보고 양식', '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `1`**',
    ].join('\n');
    const measured = [
      '> **산출물 종류**: `deliverable-verify`', '', '## L. 라이브', '### 상태 `measured`',
      '- 방법론: `deliverable-verify`', '- 명령 출처: `src/harness/deliverable-verify-cli.ts:verifyGoalDeliverable`',
      '- 기동: `existing deployed surface`', '- 눈: `observeDeliverables`', '- 기대: `measurement: clean`', '',
      '## 결과 보고 양식', '**집계**: 초록 `1` / 빨강 `0` / **못 잼 `0`**',
    ].join('\n');
    const notApplicable = [
      '> **산출물 종류**: `deliverable-verify`', '', '## L. 라이브', '### 상태 `n/a`',
      '- 방법론: `deliverable-verify`', '', '## 결과 보고 양식',
      '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `0`**',
    ].join('\n');

    expect(parseTestScenarioDeclaration(unmeasured)).toEqual({
      deliverableType: 'unknown',
      liveStatus: 'unmeasured',
      aggregate: { green: 0, red: 0, unmeasured: 1, state: 'measured' },
      reason: 'no-methodology',
      prerequisite: 'methodology registry',
      candidates: [],
      errors: [],
    });
    expect(inspectTestScenarioDeclaration(unmeasured)).toEqual({
      declared: true,
      extracted: true,
      declaration: expect.objectContaining({ errors: [] }),
    });
    expect(parseTestScenarioDeclaration(measured)).toMatchObject({
      deliverableType: 'deliverable-verify',
      liveStatus: 'measured',
      methodology: 'deliverable-verify',
      errors: [],
    });
    expect(parseTestScenarioDeclaration(notApplicable)).toMatchObject({
      deliverableType: 'deliverable-verify',
      liveStatus: 'n/a',
      methodology: 'deliverable-verify',
      errors: [],
    });
  });

  test('keeps unregistered methodologies rejected for measured, n/a, and ambiguous-methodology scenarios', () => {
    const scenario = (status: 'measured' | 'n/a', methodology: string) => [
      `> **산출물 종류**: \`${methodology}\``, '', '## L. 라이브', `### 상태 \`${status}\``,
      `- 방법론: \`${methodology}\``,
      ...(status === 'measured'
        ? ['- 명령 출처: `src/harness/unknown.ts:verify`', '- 기동: `existing surface`', '- 눈: `observer`', '- 기대: `clean`']
        : []),
      '', '## 결과 보고 양식', '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `0`**',
    ].join('\n');

    for (const status of ['measured', 'n/a'] as const) {
      expect(parseTestScenarioDeclaration(scenario(status, 'cli-smoke')).errors).toEqual([
        `deliverable type must be a registered methodology or reserved value: cli-smoke`,
        `${status} live scenario requires a registered Methodology: cli-smoke`,
      ]);
    }
    const ambiguous = parseTestScenarioDeclaration([
      '> **산출물 종류**: `ambiguous`', '', '## L. 라이브', '### 상태 `unmeasured`',
      '- 사유: `ambiguous-methodology`', '- 후보 목록: `deliverable-verify, cli-smoke`', '- 무엇이 있었으면 됐나: `methodology registry`', '',
      '## 결과 보고 양식', '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `1`**',
    ].join('\n'));
    expect(ambiguous.errors).toEqual([
      'ambiguous-methodology Candidates must be registered methodologies: deliverable-verify, cli-smoke',
    ]);
  });

  test('preserves unexecuted, measured zero, positive, and partial result-report aggregate states', () => {
    const scenario = (report: string) => `> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: no-methodology
- 무엇이 있었으면 됐나: methodology registry

## 결과 보고 양식
${report}`;

    expect(parseTestScenarioDeclaration(scenario('**집계**: 초록 `-` / 빨강 `-` / **못 잼 `-`**'))).toMatchObject({
      aggregate: { green: 'unexecuted', red: 'unexecuted', unmeasured: 'unexecuted', state: 'unexecuted' },
      errors: [],
    });
    expect(parseTestScenarioDeclaration(scenario('**집계**: 초록 `0` / 빨강 `0` / **못 잼 `0`**'))).toMatchObject({
      aggregate: { green: 0, red: 0, unmeasured: 0, state: 'measured' },
      errors: [],
    });
    expect(parseTestScenarioDeclaration(scenario('**집계**: 초록 `2` / 빨강 `1` / **못 잼 `3`**'))).toMatchObject({
      aggregate: { green: 2, red: 1, unmeasured: 3, state: 'measured' },
      errors: [],
    });
    expect(parseTestScenarioDeclaration(scenario('**집계**: 초록 `1` / 빨강 `-` / **못 잼 `0`**'))).toMatchObject({
      aggregate: { green: 1, red: 'unexecuted', unmeasured: 0, state: 'partial' },
      errors: [],
    });

    for (const report of [
      '**집계**: 초록 `-` / 빨강 `0` / **못 잼 `<K>`**',
      '**집계**: 초록 `-` / 빨강 `0` / **못 잼**',
      '**집계**: 초록 `-` / 빨강 `0` / **못 잼 `0`**\n**집계**: 초록 `0` / 빨강 `0` / **못 잼 `0`**',
    ]) {
      const declaration = parseTestScenarioDeclaration(scenario(report));
      expect(declaration.aggregate).toBeUndefined();
      expect(declaration.errors).toContain('result report must contain an Unmeasured aggregate field');
    }
  });

  test('accepts only safe-integer result-report aggregate tokens', () => {
    const scenario = (green: string) => `> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: no-methodology
- 무엇이 있었으면 됐나: methodology registry

## 결과 보고 양식
**집계**: 초록 \`${green}\` / 빨강 \`0\` / **못 잼 \`0\`**`;

    expect(parseTestScenarioDeclaration(scenario('9007199254740991'))).toMatchObject({
      aggregate: { green: Number.MAX_SAFE_INTEGER, red: 0, unmeasured: 0, state: 'measured' },
      errors: [],
    });
    for (const unsafe of ['9007199254740992', '9'.repeat(400)]) {
      const declaration = parseTestScenarioDeclaration(scenario(unsafe));
      expect(declaration.aggregate).toBeUndefined();
      expect(declaration.errors).toContain('result report must contain an Unmeasured aggregate field');
    }
  });

  test('accumulates test scenario contract failures instead of stopping at the first one', () => {
    const document = [
      '> **산출물 종류**: `cli`', '', '## L. 라이브', '### 상태 `measured`',
      '- 방법론: `cli`', '- 기동: `bun run cli`', '', '## 결과 보고 양식',
      '**집계**: 초록 `1` / 빨강 `0` / **못 잼 `0`**',
    ].join('\n');

    expect(inspectTestScenarioDeclaration(document)).toEqual({
      declared: true,
      extracted: false,
      declaration: expect.objectContaining({
        deliverableType: 'cli',
        liveStatus: 'measured',
        errors: [
          'deliverable type must be a registered methodology or reserved value: cli',
          'measured live scenario requires Command source',
          'measured live scenario requires Observer',
          'measured live scenario requires Expectation',
          'measured live scenario requires a registered Methodology: cli',
        ],
      }),
    });
  });

  test('accumulates independent document errors when the live section is missing', () => {
    const missing = inspectTestScenarioDeclaration('> **산출물 종류**: unknown\n\n## 결과 보고 양식\n**못 잼**');
    expect(missing).toEqual({
      declared: false,
      extracted: false,
      declaration: expect.objectContaining({
        deliverableType: 'unknown',
        errors: [
          'test scenario must contain an L. 라이브 section',
          'result report aggregate must appear exactly once',
          'result report must contain an Unmeasured aggregate field',
        ],
      }),
    });
  });

  test('rejects every prohibited status field and incomplete ambiguous candidates', () => {
    const prohibitedByStatus = [
      ['measured', 'unknown', 'no-methodology', ['- 사유: no-methodology', '- 후보 목록: first, second', '- 무엇이 있었으면 됐나: registry'], ['Reason', 'Candidates', 'Prerequisite']],
      ['unmeasured', 'unknown', 'no-methodology', ['- 방법론: cli', '- 명령 출처: package.json:scripts.dev', '- 기동: bun run cli', '- 눈: terminal', '- 기대: 0 failures'], ['Methodology', 'Command source', 'Startup', 'Observer', 'Expectation']],
      ['n/a', 'ambiguous', '', ['- 명령 출처: package.json:scripts.dev', '- 기동: bun run cli', '- 눈: terminal', '- 기대: 0 failures', '- 사유: no-methodology', '- 후보 목록: first, second', '- 무엇이 있었으면 됐나: registry'], ['Command source', 'Startup', 'Observer', 'Expectation', 'Reason', 'Candidates', 'Prerequisite']],
    ] as const;

    for (const [status, deliverableType, reason, fields, prohibited] of prohibitedByStatus) {
      const scenario = inspectTestScenarioDeclaration([
        `> **산출물 종류**: ${deliverableType}`, '', '## L. 라이브', `### 상태 ${status}`,
        ...(status === 'n/a' ? ['- 방법론: cli'] : []),
        ...(status === 'unmeasured' ? [`- 사유: ${reason}`, '- 무엇이 있었으면 됐나: registry'] : []),
        ...fields, '', '## 결과 보고 양식', '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `0`**',
      ].join('\n'));
      for (const label of prohibited) expect(scenario.declaration.errors).toContain(`${status} live scenario must not contain ${label}`);
    }

    const ambiguous = inspectTestScenarioDeclaration(`> **산출물 종류**: ambiguous

## L. 라이브
### 상태 unmeasured
- 사유: ambiguous-methodology
- 후보 목록: cli
- 무엇이 있었으면 됐나: methodology registry

## 결과 보고 양식
**집계**: 초록 \`0\` / 빨강 \`0\` / **못 잼 \`1\`**`);
    expect(ambiguous.declaration.errors).toEqual([
      'ambiguous reason requires at least two distinct Candidates',
      'ambiguous-methodology Candidates must be registered methodologies: cli',
    ]);
  });

  test('preserves empty Candidate declarations for prohibited-field and ambiguous-item validation', () => {
    const report = '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `1`**';
    for (const [status, deliverableType, required] of [
      ['measured', 'unknown', ['- 방법론: cli', '- 명령 출처: package.json:scripts.dev', '- 기동: bun run cli', '- 눈: terminal', '- 기대: 0 failures']],
      ['unmeasured', 'unknown', ['- 사유: no-methodology', '- 무엇이 있었으면 됐나: registry']],
      ['n/a', 'ambiguous', ['- 방법론: cli']],
    ] as const) {
      const declaration = parseTestScenarioDeclaration([
        `> **산출물 종류**: ${deliverableType}`, '', '## L. 라이브', `### 상태 ${status}`,
        ...required, '- 후보 목록: ,', '', '## 결과 보고 양식', report,
      ].join('\n'));
      expect(declaration.errors).toContain(`${status} live scenario must not contain Candidates`);
      expect(declaration.errors).toContain('Candidates must not contain empty entries');
    }

    const ambiguous = parseTestScenarioDeclaration([
      '> **산출물 종류**: ambiguous', '', '## L. 라이브', '### 상태 unmeasured',
      '- 사유: ambiguous-command-source', '- 후보 목록: file:a, , file:b', '- 무엇이 있었으면 됐나: command source', '',
      '## 결과 보고 양식', report,
    ].join('\n'));
    expect(ambiguous.errors).toContain('Candidates must not contain empty entries');
    expect(ambiguous.errors).toContain('ambiguous-command-source Candidates must be file:key values: file:a, , file:b');
  });

  test('validates ambiguous command-source candidates and the structured Unmeasured aggregate field', () => {
    const validCandidates = parseTestScenarioDeclaration(`> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: ambiguous-command-source
- 후보 목록: scripts.ts:task, package.json:scripts.dev
- 무엇이 있었으면 됐나: command source

## 결과 보고 양식
**집계**: 초록 \`0\` / 빨강 \`0\` / **못 잼 \`1\`**`);
    expect(validCandidates.errors).toEqual([]);

    for (const candidates of [' :key, package.json:scripts.dev', 'file: , package.json:scripts.dev', 'only-one:source, second:']) {
      const declaration = parseTestScenarioDeclaration(`> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: ambiguous-command-source
- 후보 목록: ${candidates}
- 무엇이 있었으면 됐나: command source

## 결과 보고 양식
**집계**: 초록 \`0\` / 빨강 \`0\` / **못 잼 \`1\`**`);
      expect(declaration.errors).toContainEqual(expect.stringContaining('ambiguous-command-source Candidates must be file:key values'));
    }

    for (const report of ['**못 잼**', '**집계**: 초록 `0` / 빨강 `0` / 못 잼 `1`']) {
      const declaration = parseTestScenarioDeclaration(`> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: no-methodology
- 무엇이 있었으면 됐나: registry

## 결과 보고 양식
${report}`);
      expect(declaration.errors).toContain('result report must contain an Unmeasured aggregate field');
    }
  });

  test('rejects repeated scenario declarations and duplicate ambiguous candidates', () => {
    const declaration = parseTestScenarioDeclaration(`> **산출물 종류**: unknown
> **산출물 종류**: ambiguous

## L. 라이브
### 상태 unmeasured
### 상태 n/a
- 사유: ambiguous-command-source
- 후보 목록: package.json:scripts.dev, package.json:scripts.dev
- 무엇이 있었으면 됐나: command source

## 결과 보고 양식
**집계**: 초록 \`0\` / 빨강 \`0\` / **못 잼 \`1\`**
**집계**: not an aggregate`);

    expect(declaration.errors).toEqual(expect.arrayContaining([
      'deliverable type must appear exactly once',
      'live scenario Status must appear exactly once',
      'ambiguous reason requires at least two distinct Candidates',
      'result report aggregate must appear exactly once',
      'result report must contain an Unmeasured aggregate field',
    ]));
  });

  // Observed focused callback duration: 1.82s (one run); each 5s CLI child timeout leaves at least 3.18s headroom.
  // `scenario()` 를 «두 번» 부른다 — 최악은 5s×2=10s ⇒ 바깥 예산은 20s (최악의 합 + 여유 10s).
  test('exposes unexecuted and measured-zero aggregate states through the read-only CLI path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-test-scenario-aggregate-'));
    try {
      const scenario = (name: string, report: string) => {
        const file = join(directory, name);
        writeFileSync(file, `> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: no-methodology
- 무엇이 있었으면 됐나: methodology registry

## 결과 보고 양식
${report}`);
        // Measured callback: 1.82s for both inspections; each 5s CLI child timeout leaves at least 3.18s headroom.
        return JSON.parse(execFileSync('bun', ['bin/elanous.mjs', 'self', 'author', '--inspect-test-scenario', file], { encoding: 'utf8', timeout: 5_000 }));
      };
      expect(scenario('unexecuted.md', '**집계**: 초록 `-` / 빨강 `-` / **못 잼 `-`**')).toMatchObject({
        extracted: true,
        declaration: { aggregate: { state: 'unexecuted' }, errors: [] },
      });
      expect(scenario('zero.md', '**집계**: 초록 `0` / 빨강 `0` / **못 잼 `0`**')).toMatchObject({
        extracted: true,
        declaration: { aggregate: { state: 'measured', green: 0, red: 0, unmeasured: 0 }, errors: [] },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  // ⛔ `scenario()` 를 «두 번» 부른다 — 최악은 5s×2=10s. ⇒ 바깥 = 10s + 여유(10s). 실측 1.82s.
  }, 20_000);

  // Observed focused CLI aggregate callback duration: 1.82s (one run); the 5s child timeout leaves 3.18s headroom.
  // The explicit 10s test budget remains 5s above the child timeout for cleanup and assertions.
  test('runs test scenario inspection through the read-only CLI path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'elanous-test-scenario-'));
    const file = join(directory, 'scenario.md');
    try {
      writeFileSync(file, `> **산출물 종류**: unknown

## L. 라이브
### 상태 unmeasured
- 사유: no-methodology
- 무엇이 있었으면 됐나: methodology registry

## 결과 보고 양식
**집계**: 초록 \`0\` / 빨강 \`0\` / **못 잼 \`1\`**`);
      // Measured CLI aggregate callback: 1.82s; the 5s child timeout leaves 3.18s headroom.
      const output = execFileSync('bun', ['bin/elanous.mjs', 'self', 'author', '--inspect-test-scenario', file], { encoding: 'utf8', timeout: 5_000 });
      expect(JSON.parse(output)).toEqual({
        declared: true,
        extracted: true,
        declaration: expect.objectContaining({ errors: [] }),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  // Observed CLI inspection completes within 5s; 10s leaves cleanup and assertion headroom.
  }, 10_000);

  test('inspects invariant and boundary markers separately without authoring or grounding', () => {
    const invariant = '불변식: src/example.ts remains unchanged.';
    expect(inspectAskInvariantMarker(invariant)).toEqual({
      matched: true,
      marker: true,
      extracted: true,
      matches: ['불변식:'],
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: ['src/example.ts'],
      groundingInspection: 'not-attempted',
      invariantPathStatus: 'inspection-not-attempted',
      absentDeclaredNewTargetPaths: [],
    });
    expect(inspectAskInvariantMarker(invariant, facts)).toEqual({
      matched: true,
      marker: true,
      extracted: true,
      matches: ['불변식:'],
      pathEvidence: true,
      unmatchedEvidencePaths: [],
      groundingInspection: 'attempted',
      invariantPathStatus: 'all-supplied-paths-matched',
      absentDeclaredNewTargetPaths: [],
    });
    expect(inspectAskInvariantMarker('불변식 설명: src/example.ts remains unchanged.', facts)).toEqual({
      matched: true,
      marker: true,
      extracted: false,
      matches: ['불변식 설명:'],
      pathEvidence: false,
      unmatchedEvidencePaths: [],
      groundingInspection: 'attempted',
      invariantPathStatus: 'zero-invariants',
      absentDeclaredNewTargetPaths: [],
    });
    expect(inspectAskInvariantMarker('불변식: src/missing.ts remains unchanged.', facts).pathEvidence).toBe(false);
    expect(inspectAskBoundaryMarker('경계: src/self-implement/goal-author.ts만 고친다.')).toEqual({
      matched: true,
      marker: true,
      extracted: true,
      matches: ['경계:'],
      pathEvidence: 'not-applicable',
    });
    expect(inspectAskBoundaryMarker('경계 설명: src/self-implement/goal-author.ts만 고친다.')).toEqual({
      matched: true,
      marker: true,
      extracted: false,
      matches: ['경계 설명:'],
      pathEvidence: 'not-applicable',
    });
  });

  test('names absent declared new-target invariant paths without changing pathEvidence or legacy branches', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-absent-declared-new-target-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'existing.ts'), 'export {};\n');
    const unmatchedFacts = {
      ...facts,
      files: ['src/existing.ts'],
      persistentEvidence: ['src/existing.ts:1 — Read-verified evidence.'],
    };
    const existingFacts = {
      ...facts,
      files: ['src/existing.ts'],
      persistentEvidence: ['src/existing.ts:1 — Read-verified evidence.'],
    };
    const absentDeclaredAsk = [
      '대상 경로: src/brand-new.ts',
      '불변식: src/brand-new.ts remains unchanged.',
    ].join('\n');
    const existingDeclaredAsk = [
      '대상 경로: src/existing.ts',
      '불변식: src/existing.ts remains unchanged.',
    ].join('\n');
    const absentNonTargetAsk = '불변식: src/unrelated-missing.ts remains unchanged.';
    const escapingAsk = [
      '대상 경로: ../outside.ts',
      '불변식: ../outside.ts remains unchanged.',
    ].join('\n');
    const symlinkOutside = mkdtempSync(join(tmpdir(), 'goal-author-absent-declared-escape-'));
    temporaryDirectories.push(symlinkOutside);
    symlinkSync(symlinkOutside, join(cwd, 'escape-link'), 'dir');
    const symlinkAsk = [
      '대상 경로: escape-link/missing.ts',
      '불변식: escape-link/missing.ts remains unchanged.',
    ].join('\n');

    const absentDeclared = inspectAskInvariantMarker(absentDeclaredAsk, unmatchedFacts, cwd);
    expect(absentDeclared.pathEvidence).toBe(false);
    expect(absentDeclared.unmatchedEvidencePaths).toEqual(['src/brand-new.ts']);
    expect(absentDeclared.groundingInspection).toBe('attempted');
    expect(absentDeclared.invariantPathStatus).toBe('absent-declared-new-target-paths');
    expect(absentDeclared.absentDeclaredNewTargetPaths).toEqual(['src/brand-new.ts']);
    expect(absentDeclared.absentDeclaredNewTargetPaths).toContain('src/brand-new.ts');

    const existingDeclared = inspectAskInvariantMarker(existingDeclaredAsk, existingFacts, cwd);
    expect(existingDeclared.pathEvidence).toBe(true);
    expect(existingDeclared.unmatchedEvidencePaths).toEqual([]);
    expect(existingDeclared.invariantPathStatus).toBe('all-supplied-paths-matched');
    expect(existingDeclared.absentDeclaredNewTargetPaths).toEqual([]);

    const absentNonTarget = inspectAskInvariantMarker(absentNonTargetAsk, unmatchedFacts, cwd);
    expect(absentNonTarget.pathEvidence).toBe(false);
    expect(absentNonTarget.unmatchedEvidencePaths).toEqual(['src/unrelated-missing.ts']);
    expect(absentNonTarget.invariantPathStatus).toBe('invariant-grounding-mismatch');
    expect(absentNonTarget.absentDeclaredNewTargetPaths).toEqual([]);

    const escaping = inspectAskInvariantMarker(escapingAsk, unmatchedFacts, cwd);
    expect(escaping.pathEvidence).toBe(false);
    expect(escaping.invariantPathStatus).toBe('invariant-grounding-mismatch');
    expect(escaping.absentDeclaredNewTargetPaths).toEqual([]);

    const symlinkEscaped = inspectAskInvariantMarker(symlinkAsk, unmatchedFacts, cwd);
    expect(symlinkEscaped.pathEvidence).toBe(false);
    expect(symlinkEscaped.invariantPathStatus).toBe('invariant-grounding-mismatch');
    expect(symlinkEscaped.absentDeclaredNewTargetPaths).toEqual([]);

    expect(inspectAskInvariantMarker('불변식: src/example.ts remains unchanged.', facts)).toMatchObject({
      pathEvidence: true,
      invariantPathStatus: 'all-supplied-paths-matched',
      absentDeclaredNewTargetPaths: [],
    });
    expect(inspectAskInvariantMarker('불변식: src/missing.ts remains unchanged.', facts)).toMatchObject({
      pathEvidence: false,
      unmatchedEvidencePaths: ['src/missing.ts'],
      invariantPathStatus: 'invariant-grounding-mismatch',
      absentDeclaredNewTargetPaths: [],
    });
    expect(inspectAskInvariantMarker('불변식: src/example.ts remains unchanged.')).toMatchObject({
      pathEvidence: 'unknown',
      invariantPathStatus: 'inspection-not-attempted',
      absentDeclaredNewTargetPaths: [],
    });
  });

  test('fails the existing-target and absent-non-target signals when the new branch is forced', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-forced-new-target-branch-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'existing.ts'), 'export {};\n');
    const existingFacts = {
      ...facts,
      files: ['src/existing.ts'],
      persistentEvidence: ['src/existing.ts:1 — Read-verified evidence.'],
    };
    const unmatchedFacts = {
      ...facts,
      files: ['src/existing.ts'],
      persistentEvidence: ['src/existing.ts:1 — Read-verified evidence.'],
    };
    const existingDeclaredAsk = [
      '대상 경로: src/existing.ts',
      '불변식: src/existing.ts remains unchanged.',
    ].join('\n');
    const absentNonTargetAsk = '불변식: src/unrelated-missing.ts remains unchanged.';
    const forceNewBranch = (inspection: ReturnType<typeof inspectAskInvariantMarker>) => ({
      ...inspection,
      invariantPathStatus: 'absent-declared-new-target-paths' as const,
    });

    expect(forceNewBranch(inspectAskInvariantMarker(existingDeclaredAsk, existingFacts, cwd)).invariantPathStatus)
      .not.toBe('all-supplied-paths-matched');
    expect(forceNewBranch(inspectAskInvariantMarker(absentNonTargetAsk, unmatchedFacts, cwd)).invariantPathStatus)
      .not.toBe('invariant-grounding-mismatch');
    expect(inspectAskInvariantMarker(existingDeclaredAsk, existingFacts, cwd).invariantPathStatus)
      .toBe('all-supplied-paths-matched');
    expect(inspectAskInvariantMarker(absentNonTargetAsk, unmatchedFacts, cwd).invariantPathStatus)
      .toBe('invariant-grounding-mismatch');
  });

  test('recognizes empty exact H2 invariant and boundary headings without creating candidates', () => {
    expect(inspectAskInvariantMarker('## 불변식\n## 다음 절')).toEqual({
      matched: false,
      marker: false,
      extracted: false,
      matches: [],
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: [],
      // 🆕 진단 필드는 «모든» 반환에 실린다 — 마커가 없는 이 경로도 예외가 아니다.
      //    ⭐ pathEvidence 의 «뜻»은 그대로다('unknown'). 가르는 정보를 «더해서» 낼 뿐이다.
      groundingInspection: 'not-attempted',
      invariantPathStatus: 'zero-invariants',
      absentDeclaredNewTargetPaths: [],
    });
    expect(inspectAskBoundaryMarker('## 경계\n## 다음 절')).toEqual({
      matched: false,
      marker: false,
      extracted: false,
      matches: [],
      pathEvidence: 'not-applicable',
    });
  });

  test('preserves mixed-newline multi-line exact H2 heading source through the next heading', async () => {
    const invariant = '## 불변식\r\nsrc/first.ts remains unchanged.\nlast invariant character Z\r\n## 다음 절\nignored';
    const boundary = '## 경계\r\nsrc/first.ts만 고친다.\nlast boundary character Q\r\n## 다음 절\nignored';
    const authored = await authorGoal(`${invariant}\n${boundary}`, deps);
    const invariantSection = markdownSection(authored.document, '불변식') ?? '';
    const boundarySection = markdownSection(authored.document, 'SCOPE BOUNDARY') ?? '';

    expect(inspectAskInvariantMarker(invariant)).toMatchObject({
      matched: false,
      extracted: false,
      matches: [],
    });
    expect(inspectAskBoundaryMarker(boundary)).toMatchObject({
      matched: false,
      extracted: false,
      matches: [],
    });
    expect(invariantSection).toContain('Ask uses a heading-form invariant; headings are diagnostic only');
    expect(invariantSection).toContain(`source=${JSON.stringify('## 불변식\r\nsrc/first.ts remains unchanged.\nlast invariant character Z')}`);
    expect(invariantSection).not.toContain('- Invariant candidate:');
    expect(invariantSection).not.toContain('ignored');
    expect(boundarySection).toContain('Ask uses a heading-form boundary; headings are diagnostic only');
    expect(boundarySection).toContain(`source=${JSON.stringify('## 경계\r\nsrc/first.ts만 고친다.\nlast boundary character Q')}`);
    expect(boundarySection).not.toContain('- Boundary decision:');
    expect(boundarySection).not.toContain('ignored');
    expect(planGateSignals(authored.document, lintGoalFile(authored.document, 'main'))).toMatchObject({
      normalizedMarkerSuccess: 0,
      normalizedMarkerFailure: 0,
    });
  });

  test('reports H1–H3 invariant and boundary headings without promoting them while preserving inline extraction', async () => {
    const headingInvariant = '# 불변식\nsrc/heading-invariant.ts remains unchanged.';
    const headingBoundary = '# 경계\nsrc/heading-boundary.ts만 고친다.';
    const h2HeadingInvariant = '## 불변식\nsrc/h2-heading-invariant.ts remains unchanged.';
    const h2HeadingBoundary = '## 경계\nsrc/h2-heading-boundary.ts만 고친다.';
    const h3HeadingInvariant = '### 불변식\nsrc/h3-heading-invariant.ts remains unchanged.';
    const h3HeadingBoundary = '### 경계\nsrc/h3-heading-boundary.ts만 고친다.';
    const tabH1Invariant = '#\t불변식\nsrc/tab-h1-invariant.ts remains unchanged.';
    const tabH2Invariant = '##\t불변식\nsrc/tab-h2-invariant.ts remains unchanged.';
    const tabH3Boundary = '###\t경계\nsrc/tab-h3-boundary.ts만 고친다.';
    const inlineInvariant = '불변식: src/inline-invariant.ts remains unchanged.';
    const inlineBoundary = '경계: src/inline-boundary.ts만 고친다.';
    const duplicateHeadingInvariant = '# 불변식\nsrc/duplicate.ts remains unchanged.';
    const duplicateHeadingBoundary = '# 경계\nsrc/duplicate.ts만 고친다.';
    const duplicateInlineInvariant = '불변식: src/duplicate.ts remains unchanged.';
    const duplicateInlineBoundary = '경계: src/duplicate.ts만 고친다.';
    const blankLineHeadingInvariant = '# 불변식\n\nsrc/blank-line-invariant.ts remains unchanged.';
    const blankLineHeadingBoundary = '# 경계\n\nsrc/blank-line-boundary.ts만 고친다.';
    const multilineHeadingInvariant = '# 불변식\nsrc/shared.ts remains unchanged.\nsrc/unique-heading.ts remains unchanged.';
    const multilineHeadingBoundary = '# 경계\nsrc/shared.ts만 고친다.\nsrc/unique-heading.ts만 고친다.';
    const sharedInlineInvariant = '불변식: src/shared.ts remains unchanged.';
    const sharedInlineBoundary = '경계: src/shared.ts만 고친다.';
    const [headings, h2Headings, h3Headings, tabHeadings, mixed, inline, duplicate, blankLines, multiline, prose] = await Promise.all([
      authorGoal(`${headingInvariant}\n\n${headingBoundary}`, deps),
      authorGoal(`${h2HeadingInvariant}\n\n${h2HeadingBoundary}`, deps),
      authorGoal(`${h3HeadingInvariant}\n\n${h3HeadingBoundary}`, deps),
      authorGoal(`${tabH1Invariant}\n\n${tabH2Invariant}\n\n${tabH3Boundary}`, deps),
      authorGoal(`${headingInvariant}\n${inlineInvariant}\n\n${headingBoundary}\n${inlineBoundary}`, deps),
      authorGoal(`${inlineInvariant}\n${inlineBoundary}`, deps),
      authorGoal(`${duplicateHeadingInvariant}\n${duplicateInlineInvariant}\n\n${duplicateHeadingBoundary}\n${duplicateInlineBoundary}`, deps),
      authorGoal(`${blankLineHeadingInvariant}\n\n${blankLineHeadingBoundary}`, deps),
      authorGoal(`${multilineHeadingInvariant}\n${sharedInlineInvariant}\n\n${multilineHeadingBoundary}\n${sharedInlineBoundary}`, deps),
      authorGoal('불변식과 경계는 여기서 산문으로만 언급한다.\n#### 불변식\n저작 문서 절 제목은 요청 표지가 아니다.', deps),
    ]);
    const headingInvariants = headings.document.slice(headings.document.indexOf('## 불변식'), headings.document.indexOf('## 판정 신호'));
    const headingBoundaries = headings.document.slice(headings.document.indexOf('## SCOPE BOUNDARY'), headings.document.indexOf('## 불변식'));
    const h2HeadingDocument = h2Headings.document;
    const h3HeadingDocument = h3Headings.document;
    const tabHeadingInvariants = tabHeadings.document.slice(tabHeadings.document.indexOf('## 불변식'), tabHeadings.document.indexOf('## 판정 신호'));
    const tabHeadingBoundaries = tabHeadings.document.slice(tabHeadings.document.indexOf('## SCOPE BOUNDARY'), tabHeadings.document.indexOf('## 불변식'));
    const mixedInvariants = mixed.document.slice(mixed.document.indexOf('## 불변식'), mixed.document.indexOf('## 판정 신호'));
    const mixedBoundaries = mixed.document.slice(mixed.document.indexOf('## SCOPE BOUNDARY'), mixed.document.indexOf('## 불변식'));
    const inlineInvariants = inline.document.slice(inline.document.indexOf('## 불변식'), inline.document.indexOf('## 판정 신호'));
    const inlineBoundaries = inline.document.slice(inline.document.indexOf('## SCOPE BOUNDARY'), inline.document.indexOf('## 불변식'));
    const duplicateInvariants = duplicate.document.slice(duplicate.document.indexOf('## 불변식'), duplicate.document.indexOf('## 판정 신호'));
    const duplicateBoundaries = duplicate.document.slice(duplicate.document.indexOf('## SCOPE BOUNDARY'), duplicate.document.indexOf('## 불변식'));
    const blankLineInvariants = blankLines.document.slice(blankLines.document.indexOf('## 불변식'), blankLines.document.indexOf('## 판정 신호'));
    const blankLineBoundaries = blankLines.document.slice(blankLines.document.indexOf('## SCOPE BOUNDARY'), blankLines.document.indexOf('## 불변식'));
    const multilineInvariants = multiline.document.slice(multiline.document.indexOf('## 불변식'), multiline.document.indexOf('## 판정 신호'));
    const multilineBoundaries = multiline.document.slice(multiline.document.indexOf('## SCOPE BOUNDARY'), multiline.document.indexOf('## 불변식'));
    const proseInvariants = prose.document.slice(prose.document.indexOf('## 불변식'), prose.document.indexOf('## 판정 신호'));
    const proseBoundaries = prose.document.slice(prose.document.indexOf('## SCOPE BOUNDARY'), prose.document.indexOf('## 불변식'));

    expect(inspectAskInvariantMarker(headingInvariant)).toMatchObject({ matched: false, extracted: false, matches: [] });
    expect(inspectAskBoundaryMarker(headingBoundary)).toMatchObject({ matched: false, extracted: false, matches: [] });
    expect(headingInvariants).toContain('Ask uses a heading-form invariant; headings are diagnostic only');
    expect(headingInvariants).toContain(`source=${JSON.stringify(headingInvariant)}`);
    expect(headingInvariants).not.toContain('- Invariant candidate:');
    expect(headingBoundaries).toContain('Ask uses a heading-form boundary; headings are diagnostic only');
    expect(headingBoundaries).toContain(`source=${JSON.stringify(headingBoundary)}`);
    expect(headingBoundaries).not.toContain('- Boundary decision:');
    expect(h2HeadingDocument).toContain('Ask uses a heading-form invariant; headings are diagnostic only');
    expect(h2HeadingDocument).toContain(`source=${JSON.stringify(h2HeadingInvariant)}`);
    expect(h2HeadingDocument).not.toContain(`- Invariant candidate: ${h2HeadingInvariant.split('\n')[1]}`);
    expect(h2HeadingDocument).toContain('Ask uses a heading-form boundary; headings are diagnostic only');
    expect(h2HeadingDocument).toContain(`source=${JSON.stringify(h2HeadingBoundary)}`);
    expect(h2HeadingDocument).not.toContain(`- Boundary decision: ${h2HeadingBoundary.split('\n')[1]}`);
    for (const [document, invariant, boundary] of [[h3HeadingDocument, h3HeadingInvariant, h3HeadingBoundary]] as const) {
      expect(document).toContain('Ask uses a heading-form invariant; headings are diagnostic only');
      expect(document).toContain(`source=${JSON.stringify(invariant)}`);
      expect(document).not.toContain(`- Invariant candidate: ${invariant.split('\n')[1]}`);
      expect(document).toContain('Ask uses a heading-form boundary; headings are diagnostic only');
      expect(document).toContain(`source=${JSON.stringify(boundary)}`);
      expect(document).not.toContain(`- Boundary decision: ${boundary.split('\n')[1]}`);
    }
    expect(tabHeadingInvariants).not.toContain('heading-form invariant');
    expect(tabHeadingInvariants).not.toContain('src/tab-h1-invariant.ts');
    expect(tabHeadingInvariants).not.toContain('src/tab-h2-invariant.ts');
    expect(tabHeadingBoundaries).not.toContain('heading-form boundary');
    expect(tabHeadingBoundaries).not.toContain('src/tab-h3-boundary.ts');
    expect(mixedInvariants).toContain('- Invariant candidate: src/inline-invariant.ts remains unchanged.');
    expect(mixedInvariants).toContain('Ask uses a heading-form invariant; headings are diagnostic only');
    expect(mixedInvariants).toContain(`source=${JSON.stringify(headingInvariant)}`);
    expect(mixedBoundaries).toContain('- Boundary decision: src/inline-boundary.ts만 고친다.');
    expect(mixedBoundaries).toContain('Ask uses a heading-form boundary; headings are diagnostic only');
    expect(mixedBoundaries).toContain(`source=${JSON.stringify(headingBoundary)}`);
    expect(duplicateInvariants).toContain('- Invariant candidate: src/duplicate.ts remains unchanged.');
    expect(duplicateInvariants.match(/- Invariant candidate:/gu)).toHaveLength(1);
    expect(duplicateInvariants).not.toContain('heading-form invariant');
    expect(duplicateBoundaries).toContain('- Boundary decision: src/duplicate.ts만 고친다.');
    expect(duplicateBoundaries.match(/- Boundary decision:/gu)).toHaveLength(1);
    expect(duplicateBoundaries).not.toContain('heading-form boundary');
    expect(blankLineInvariants).toContain(`source=${JSON.stringify('# 불변식\nsrc/blank-line-invariant.ts remains unchanged.')}`);
    expect(blankLineBoundaries).toContain(`source=${JSON.stringify('# 경계\nsrc/blank-line-boundary.ts만 고친다.')}`);
    expect(multilineInvariants).toContain('- Invariant candidate: src/shared.ts remains unchanged.');
    expect(multilineInvariants).toContain(`source=${JSON.stringify('# 불변식\nsrc/unique-heading.ts remains unchanged.')}`);
    expect(multilineInvariants).not.toContain('source="# 불변식\\nsrc/shared.ts remains unchanged.');
    expect(multilineBoundaries).toContain('- Boundary decision: src/shared.ts만 고친다.');
    expect(multilineBoundaries).toContain(`source=${JSON.stringify('# 경계\nsrc/unique-heading.ts만 고친다.')}`);
    expect(multilineBoundaries).not.toContain('source="# 경계\\nsrc/shared.ts만 고친다.');
    expect(inlineInvariants).not.toContain('heading-form invariant');
    expect(inlineBoundaries).not.toContain('heading-form boundary');
    expect(proseInvariants).not.toContain('heading-form invariant');
    expect(proseBoundaries).not.toContain('heading-form boundary');
  });

  test('extracts English and Korean decision-signal markers without crossing repeated signal boundaries', async () => {
    expect(inspectAskDecisionSignalMarker('decision signal: condition = English condition; observation = English observation; expected result = English expected result')).toEqual({
      matched: true,
      marker: true,
      extracted: true,
      matches: [{ match: 'decision signal:', expectsPresence: 'unreadable', expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
      allNegative: true,
      unreadableCount: 1,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
      condition: 'English condition',
      observation: 'English observation',
      expectedResult: 'English expected result',
      expectedResultClassification: 'indeterminate',
    });
    expect(inspectAskDecisionSignalMarker('판정 신호: 조건 = 한국어 조건; 관측 = 한국어 관측; 기대 = 한국어 기대')).toEqual({
      matched: true,
      marker: true,
      extracted: true,
      matches: [{ match: '판정 신호:', expectsPresence: 'unreadable', expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
      allNegative: true,
      unreadableCount: 1,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
      condition: '한국어 조건',
      observation: '한국어 관측',
      expectedResult: '한국어 기대',
      expectedResultClassification: 'indeterminate',
    });

    const mixedAsk = 'decision signal: condition = first condition; observation = first observation; expected result = first expected result 판정 신호: condition = second condition; observation = second observation; expected result = second expected result';
    const authored = await authorGoal(mixedAsk, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));
    expect(signals.match(/^- Candidate decision signal:$/gm)).toHaveLength(2);
    expect(signals).toContain('  - Condition: first condition');
    expect(signals).toContain('  - Observation: first observation');
    expect(signals).toContain('  - Expected result: first expected result');
    expect(signals).toContain('  - Condition: second condition');
    expect(signals).toContain('  - Observation: second observation');
    expect(signals).toContain('  - Expected result: second expected result');
    expect(signals).not.toContain('first expected result 판정 신호:');

    expect(inspectAskDecisionSignalMarker('decision signal: this is marker-only prose')).toEqual({
      matched: true,
      marker: true,
      extracted: false,
      matches: [{ match: 'decision signal:', expectsPresence: null, expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
      allNegative: true,
      unreadableCount: 0,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
    });
    expect(inspectAskDecisionSignalMarker('decision signal: CONDITION = c; OBSERVATION = o; EXPECTED RESULT = e')).toEqual({
      matched: true,
      marker: true,
      extracted: false,
      matches: [{ match: 'decision signal:', expectsPresence: null, expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
      allNegative: true,
      unreadableCount: 0,
      anyAlternatives: false,
      anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
    });
  });

  test('classifies extracted expected-result predicates across the Korean decision-signal boundary cases', () => {
    const inspect = (expectedResult: string) => inspectAskDecisionSignalMarker(
      `판정 신호: 조건 = 요청문; 관측 = 프로브 반환값; 기대 = ${expectedResult}`,
    ).expectedResultClassification;

    expect(inspect('그 함수가 캐시를 부른다.')).toBe('structural');
    expect(inspect('증분 경로로 불린다.')).toBe('structural');
    expect(inspect('그 산출에 지난 이력 절이 뜬다.')).toBe('output');
    expect(inspect('조회 시간이 줄어든다.')).toBe('output');
    expect(inspect('관측에 그 칸이 실린다.')).toBe('output');
    expect(inspect('그 동작이 올바르게 처리된다.')).toBe('indeterminate');
  });

  test('inspects from the start even after the deployed global marker was used', () => {
    const ask = '판정 신호: condition = c; observation = o; expected result = e';
    try {
      ASK_DECISION_SIGNAL_MARKER.test(ask);
      expect(ASK_DECISION_SIGNAL_MARKER.lastIndex).toBeGreaterThan(0);

      expect(inspectAskDecisionSignalMarker(ask)).toEqual({
        matched: true,
        marker: true,
        extracted: true,
        matches: [{ match: '판정 신호:', expectsPresence: 'unreadable', expectsAlternatives: false, observesCount: false, observesIdentifierNames: false, observesSelfReportedField: false }],
        allNegative: true,
        unreadableCount: 1,
        anyAlternatives: false,
        anyObservesCount: false,
      anyObservesIdentifierNames: false,
      anyObservesSelfReportedField: false,
        condition: 'c',
        observation: 'o',
        expectedResult: 'e',
        expectedResultClassification: 'indeterminate',
      });
    } finally {
      ASK_DECISION_SIGNAL_MARKER.lastIndex = 0;
    }
  });

  test('accepts explanatory prose before Korean decision-signal fields while preserving legacy output and rejecting partial signals', async () => {
    const koreanSignal = {
      condition: '한글 필드 ask를 저작한다',
      observation: '산출 골 파일의 판정 신호 절',
      expectedResult: 'UNVERIFIABLE 이 아니라 세 축이 각각 실린다',
    };
    const englishSignal = {
      condition: 'English field ask is authored',
      observation: 'the same decision-signal section',
      expectedResult: 'the output remains byte-for-byte unchanged',
    };
    const koreanFields = `조건 = ${koreanSignal.condition}; 관측 = ${koreanSignal.observation}; 기대 = ${koreanSignal.expectedResult}`;
    const legacyAsk = `판정 신호: ${koreanFields}`;
    const [explainedAuthored, koreanAuthored, englishAuthored, partialAuthored, separatedAxesAuthored, prefixedEnglishAuthored, prefixedKoreanAuthored] = await Promise.all([
      authorGoal(`판정 신호: 작성자가 읽을 설명 문장이다. ${koreanFields}`, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal(legacyAsk, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal(`판정 신호: condition = ${englishSignal.condition}; observation = ${englishSignal.observation}; expected result = ${englishSignal.expectedResult}`, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal('판정 신호: 조건 = 일부만 있다; 관측 = 아직 기대가 없다', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal(`판정 신호: 조건 = 일부만 있다; 관측 = 아직 기대가 없다\n${koreanFields}`, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal('판정 신호: precondition = c; observation = o; expected result = e', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal('판정 신호: 무조건 = c; 관측 = o; 기대 = e', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
    ]);
    const explainedSignals = explainedAuthored.document.slice(explainedAuthored.document.indexOf('## 판정 신호'), explainedAuthored.document.indexOf('\n## 검증 시나리오'));
    const koreanSignals = koreanAuthored.document.slice(koreanAuthored.document.indexOf('## 판정 신호'), koreanAuthored.document.indexOf('\n## 검증 시나리오'));
    const englishSignals = englishAuthored.document.slice(englishAuthored.document.indexOf('## 판정 신호'), englishAuthored.document.indexOf('\n## 검증 시나리오'));
    const partialSignals = partialAuthored.document.slice(partialAuthored.document.indexOf('## 판정 신호'), partialAuthored.document.indexOf('\n## 검증 시나리오'));
    const separatedAxesSignals = separatedAxesAuthored.document.slice(separatedAxesAuthored.document.indexOf('## 판정 신호'), separatedAxesAuthored.document.indexOf('\n## 검증 시나리오'));
    const prefixedEnglishSignals = prefixedEnglishAuthored.document.slice(prefixedEnglishAuthored.document.indexOf('## 판정 신호'), prefixedEnglishAuthored.document.indexOf('\n## 검증 시나리오'));
    const prefixedKoreanSignals = prefixedKoreanAuthored.document.slice(prefixedKoreanAuthored.document.indexOf('## 판정 신호'), prefixedKoreanAuthored.document.indexOf('\n## 검증 시나리오'));
    const expectedKoreanSignals = `## 판정 신호\n- Candidate decision signal:\n  - Condition: ${koreanSignal.condition}\n  - Observation: ${koreanSignal.observation}\n  - Expected result: ${koreanSignal.expectedResult}\n`;

    expect(explainedSignals).toBe(expectedKoreanSignals);
    expect(koreanSignals).toBe(expectedKoreanSignals);
    expect(englishSignals).toBe(`## 판정 신호\n- Candidate decision signal:\n  - Condition: ${englishSignal.condition}\n  - Observation: ${englishSignal.observation}\n  - Expected result: ${englishSignal.expectedResult}\n`);
    const unparsed = '## 판정 신호\n- UNVERIFIABLE: Ask contains a decision-signal marker, but at least one entry did not match the required condition/observation/expected result format. source="판정 신호: 조건 = 일부만 있다; 관측 = 아직 기대가 없다" truncated=false; required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>; corrected example: 판정 신호: 조건 = malformed marker exists; 관측 = bun test src/example.test.ts; 기대 = diagnostic is rendered.\n';
    expect(partialSignals).toBe(unparsed);
    expect(separatedAxesSignals).toBe(unparsed.replace('1 time(s)', '2 time(s)'));
    expect(prefixedEnglishSignals).toContain('source="판정 신호: precondition = c; observation = o; expected result = e"');
    expect(prefixedEnglishSignals).toContain('required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>');
    expect(prefixedKoreanSignals).toContain('source="판정 신호: 무조건 = c; 관측 = o; 기대 = e"');
    expect(prefixedKoreanSignals).toContain('required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>');
  });

  test('renders numeric decision-signal source and coverage slots that satisfy the unchanged lint contract', async () => {
    const numericAsk = '판정 신호: 조건 = 숫자 후보를 저작한다; 관측 = 렌더된 문서를 lintGoalFile에 넣는다; 기대 = 2 numeric slots are rendered';
    const numericAuthored = await authorGoal(numericAsk, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const numericSignals = numericAuthored.document.slice(numericAuthored.document.indexOf('## 판정 신호'), numericAuthored.document.indexOf('\n## 검증 시나리오'));
    const numericFindings = lintGoalFile(numericAuthored.document, 'main');

    expect(numericSignals).toContain(`  - 숫자 출처: ${numericAsk}`);
    expect(numericSignals).toContain('  - 숫자 적용 범위: UNVERIFIABLE: no numeric coverage evidence was supplied for this decision signal.');
    expect(numericFindings).not.toContainEqual(expect.objectContaining({ tag: 'decision-signal-numeric-source' }));
    expect(numericFindings).not.toContainEqual(expect.objectContaining({ tag: 'decision-signal-numeric-coverage' }));

    const withoutSlots = numericAuthored.document
      .replace(/^  - 숫자 출처:.*\n/m, '')
      .replace(/^  - 숫자 적용 범위:.*\n/m, '');
    expect(lintGoalFile(withoutSlots, 'main')).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'decision-signal-numeric-source' }),
      expect.objectContaining({ tag: 'decision-signal-numeric-coverage' }),
    ]));

    const groundedAuthored = await authorGoal('숫자 근거가 있는 강화 후보를 저작한다.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
      enhance: async (original) => ({
        original,
        checklist: [],
        verbatimPreserved: true,
        decisionSignal: {
          condition: '강화 후보를 렌더한다',
          observation: '판정 신호 절을 확인한다',
          expectedResult: '2 grounded slots are rendered',
          numericSource: 'measured candidate fixture',
          numericCoverage: 'all authored decision-signal candidates',
        },
      }),
    });
    const groundedSignals = groundedAuthored.document.slice(groundedAuthored.document.indexOf('## 판정 신호'), groundedAuthored.document.indexOf('\n## 검증 시나리오'));
    expect(groundedSignals).toContain('  - 숫자 출처: measured candidate fixture');
    expect(groundedSignals).toContain('  - 숫자 적용 범위: all authored decision-signal candidates');
    expect(lintGoalFile(groundedAuthored.document, 'main')).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'decision-signal-numeric-source' }),
      expect.objectContaining({ tag: 'decision-signal-numeric-coverage' }),
    ]));

    const blankEvidenceAuthored = await authorGoal('빈 숫자 근거를 가진 강화 후보를 저작한다.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
      enhance: async (original) => ({
        original,
        checklist: [],
        verbatimPreserved: true,
        decisionSignal: {
          condition: '빈 근거 후보를 렌더한다',
          observation: '판정 신호 절을 확인한다',
          expectedResult: '2 blank slots are explained',
          numericSource: '',
          numericCoverage: '   ',
        },
      }),
    });
    const blankEvidenceSignals = blankEvidenceAuthored.document.slice(blankEvidenceAuthored.document.indexOf('## 판정 신호'), blankEvidenceAuthored.document.indexOf('\n## 검증 시나리오'));
    expect(blankEvidenceSignals).toContain(`  - 숫자 출처: UNVERIFIABLE: no numeric source evidence was supplied for this decision signal.`);
    expect(blankEvidenceSignals).toContain(`  - 숫자 적용 범위: UNVERIFIABLE: no numeric coverage evidence was supplied for this decision signal.`);
    expect(blankEvidenceSignals).not.toMatch(/^  - 숫자 (?:출처|적용 범위):\s*$/m);

    const plainAuthored = await authorGoal('판정 신호: 조건 = 숫자 없는 후보를 저작한다; 관측 = 판정 신호 절을 본다; 기대 = slots are absent', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const plainSignals = plainAuthored.document.slice(plainAuthored.document.indexOf('## 판정 신호'), plainAuthored.document.indexOf('\n## 검증 시나리오'));
    expect(plainSignals).not.toContain('숫자 출처:');
    expect(plainSignals).not.toContain('숫자 적용 범위:');
  });

  test('renders each repeated Korean invariant and decision-signal ask label as a separate section item', async () => {
    const firstInvariant = '첫 번째 불변식 문장';
    const secondInvariant = '두 번째 불변식 문장';
    const firstSignal = {
      condition: '첫 번째 조건',
      observation: '첫 번째 관측',
      expectedResult: '첫 번째 기대 결과',
    };
    const secondSignal = {
      condition: '두 번째 조건',
      observation: '두 번째 관측',
      expectedResult: '두 번째 기대 결과',
    };
    const authored = await authorGoal([
      `불변식: ${firstInvariant}`,
      `불변식: ${secondInvariant}`,
      `판정 신호: condition = ${firstSignal.condition}; observation = ${firstSignal.observation}; expected result = ${firstSignal.expectedResult}`,
      `판정 신호: condition = ${secondSignal.condition}; observation = ${secondSignal.observation}; expected result = ${secondSignal.expectedResult}`,
    ].join(' '), {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    expect(invariants.match(/^- Invariant candidate: /gm)).toHaveLength(2);
    expect(invariants).toContain(`- Invariant candidate: ${firstInvariant}`);
    expect(invariants).toContain(`- Invariant candidate: ${secondInvariant}`);
    expect(invariants).not.toContain(`${firstInvariant} 불변식: ${secondInvariant}`);
    expect(signals.match(/^- Candidate decision signal:$/gm)).toHaveLength(2);
    for (const signal of [firstSignal, secondSignal]) {
      expect(signals).toContain(`  - Condition: ${signal.condition}`);
      expect(signals).toContain(`  - Observation: ${signal.observation}`);
      expect(signals).toContain(`  - Expected result: ${signal.expectedResult}`);
    }
    expect(signals).not.toContain(`${firstSignal.expectedResult} 판정 신호:`);
  });

  test('adds informational ask-to-section counts only when a parenthesized decision-signal label is not rendered', async () => {
    const signal = {
      condition: '입력 조건',
      observation: '출력 관측',
      expectedResult: '항목이 실린다',
    };
    const normalAsk = `판정 신호: 조건 = ${signal.condition}; 관측 = ${signal.observation}; 기대 = ${signal.expectedResult}`;
    const parenthesizedAsk = `(판정 신호): 조건 = ${signal.condition}; 관측 = ${signal.observation}; 기대 = ${signal.expectedResult}`;
    const [normal, parenthesized] = await Promise.all([normalAsk, parenthesizedAsk].map((input) => authorGoal(input, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    })));
    const normalSignals = normal.document.slice(normal.document.indexOf('## 판정 신호'), normal.document.indexOf('\n## 검증 시나리오'));
    const parenthesizedSignals = parenthesized.document.slice(parenthesized.document.indexOf('## 판정 신호'), parenthesized.document.indexOf('\n## 검증 시나리오'));

    expect(normalSignals.match(/^- Candidate decision signal:$/gm)).toHaveLength(1);
    expect(normalSignals).not.toContain('Information: ask contains "판정 신호"');
    expect(parenthesizedSignals).not.toContain('- Candidate decision signal:');
    expect(parenthesizedSignals).toContain('- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.');
  });

  test('reports merged clarification and grounding candidates as rendered section items', async () => {
    const evidenceSignal = 'Decision signal: condition = evidence condition; observation = evidence observation; expected result = evidence result';
    const authored = await authorGoal('불변식: ask invariant', {
      ...deps,
      clarificationAnswers: {
        [IMPLEMENTATION_TARGET_CLARIFICATION]: undefined,
        preservation_contract: 'Clarification invariant',
      },
      ground: async () => ({ ...facts, persistentEvidence: [evidenceSignal] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    expect(invariants).toContain('- Invariant candidate: Clarification-grounded preservation contract: Clarification invariant');
    expect(signals).toContain('- Candidate decision signal:');
  });

  test('reports observed unparsed decision-signal markers separately from an absent marker without inventing content', async () => {
    const malformedAsks = [
      '불변식은 이 문장이다. 판정 신호: 이것은 서술문이다.',
      '불변식은 이 문장이다. 판정 신호는 이것이다.',
      '불변식은 이 문장이다. Decision signal: this is prose.',
      '불변식은 이 문장이다. Decision signal is this prose.',
      '불변식은 이 문장이다. 판정 신호: 조건 = c; 관측 = o; 기대 결과 = e',
      '불변식은 이 문장이다. 판정 신호: 조건 = c, 관측 = o, 기대 = e',
    ];
    const [malformed, absent] = await Promise.all([
      Promise.all(malformedAsks.map((malformedAsk) => authorGoal(malformedAsk, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }))),
      authorGoal('The author does not invent sentences; inspect the invariant section after authoring.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
    ]);
    const absentInvariants = absent.document.slice(absent.document.indexOf('## 불변식'), absent.document.indexOf('## 판정 신호'));
    const absentSignals = absent.document.slice(absent.document.indexOf('## 판정 신호'), absent.document.indexOf('\n## 검증 시나리오'));
    for (const [index, unparsed] of malformed.entries()) {
      const unparsedInvariants = unparsed.document.slice(unparsed.document.indexOf('## 불변식'), unparsed.document.indexOf('## 판정 신호'));
      const unparsedSignals = unparsed.document.slice(unparsed.document.indexOf('## 판정 신호'), unparsed.document.indexOf('\n## 검증 시나리오'));
      expect(unparsedInvariants).toContain('- UNVERIFIABLE: Ask contains an invariant marker, but at least one entry did not match the required invariant format. source=');
      expect(unparsedInvariants).toContain('required format: 불변식: <preservation statement>; corrected example: 불변식: src/example.ts remains unchanged.');
      expect(unparsedSignals).toContain('- UNVERIFIABLE: Ask contains a decision-signal marker, but at least one entry did not match the required condition/observation/expected result format. source=');
      expect(unparsedSignals).toContain('required format: 판정 신호: 조건 = <condition>; 관측 = <command>; 기대 = <result>; corrected example:');
      if (malformedAsks[index].includes('판정 신호')) {
      } else {
        expect(unparsedSignals).not.toContain('Information: ask contains "판정 신호"');
      }
      const markerStart = malformedAsks[index].search(/(?:판정 신호|Decision signal)/i);
      expect(unparsedSignals).toContain(JSON.stringify(malformedAsks[index].slice(markerStart)));
    }
    expect(absentInvariants).toContain('- UNVERIFIABLE: No Read-verified invariant evidence with condition, observation, and expected result is available.');
    expect(absentSignals).toContain('- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.');
  });

  test('preserves a valid same-line decision signal while reporting only one malformed marker source', async () => {
    const validSignal = {
      condition: '형식을 맞춘 ask를 준다',
      observation: '저작된 골의 signal section',
      expectedResult: '세 하위 필드가 경고 없이 유지된다',
    };
    const validSource = `판정 신호: 조건 = ${validSignal.condition}; 관측 = ${validSignal.observation}; 기대 = ${validSignal.expectedResult}`;
    const malformedSource = '판정 신호: 이것은 형식을 맞추지 않은 서술문이다.';
    const authored = await authorGoal(`${validSource} ${malformedSource}`, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));
    const diagnostics = signals.split('\n').filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains a decision-signal marker'));

    expect(signals).toContain(`  - Condition: ${validSignal.condition}`);
    expect(signals).toContain(`  - Observation: ${validSignal.observation}`);
    expect(signals).toContain(`  - Expected result: ${validSignal.expectedResult}`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(`source=${JSON.stringify(malformedSource)}`);
    expect(diagnostics[0]).not.toContain(validSource);
  });

  test('reports only an incomplete same-line boundary marker once beside a valid boundary decision', async () => {
    const validSource = '경계: src/self-implement/goal-author.ts만 고친다.';
    const malformedSource = '경계:';
    const authored = await authorGoal(`${validSource} ${malformedSource}`, deps);
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );
    const diagnostics = boundary.split('\n').filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains a boundary marker'));

    expect(boundary).toContain('- Boundary decision: src/self-implement/goal-author.ts만 고친다.');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(`source=${JSON.stringify(malformedSource)}`);
    expect(diagnostics[0]).not.toContain(validSource);
  });

  test('preserves source order when ordinary and parenthesized invariant and boundary markers interleave', async () => {
    const authored = await authorGoal([
      '불변식: FIRST_INVARIANT remains unchanged.',
      '불변식 (수식어): MIDDLE_INVARIANT remains unchanged.',
      '불변식: LAST_INVARIANT remains unchanged.',
      '경계: FIRST_BOUNDARY remains unchanged.',
      '경계 (수식어): MIDDLE_BOUNDARY remains unchanged.',
      '경계: LAST_BOUNDARY remains unchanged.',
    ].join('\n'), deps);
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );

    for (const [first, middle, last] of [
      ['FIRST_INVARIANT', 'MIDDLE_INVARIANT', 'LAST_INVARIANT'],
      ['FIRST_BOUNDARY', 'MIDDLE_BOUNDARY', 'LAST_BOUNDARY'],
    ]) {
      const section = first.includes('INVARIANT') ? invariants : boundary;
      expect(section.indexOf(first)).toBeLessThan(section.indexOf(middle));
      expect(section.indexOf(middle)).toBeLessThan(section.indexOf(last));
    }
    for (const value of ['FIRST_INVARIANT', 'MIDDLE_INVARIANT', 'LAST_INVARIANT']) {
      expect(invariants.match(new RegExp(`^- Invariant candidate: ${value} remains unchanged\\.$`, 'gm'))).toHaveLength(1);
    }
    for (const value of ['FIRST_BOUNDARY', 'MIDDLE_BOUNDARY', 'LAST_BOUNDARY']) {
      expect(boundary.match(new RegExp(`^- Boundary decision: ${value} remains unchanged\\.$`, 'gm'))).toHaveLength(1);
    }
    expect(invariants).toContain('original="불변식 (수식어): MIDDLE_INVARIANT remains unchanged."');
    expect(boundary).toContain('original="경계 (수식어): MIDDLE_BOUNDARY remains unchanged."');
  });

  test('normalizes only single-line parenthesized invariant and boundary modifiers through unchanged parsers', async () => {
    const invariantSource = '불변식 (보존): PARENTHESIZED_INVARIANT remains unchanged.';
    const boundarySource = '경계 (파서 계약): PARENTHESIZED_BOUNDARY remains unchanged.';
    const nonParenthesizedInvariant = '불변식 위반: NEGATED_INVARIANT must remain unverifiable.';
    const nonParenthesizedBoundary = '경계 아님: NEGATED_BOUNDARY must remain unverifiable.';
    const boundaryMemo = '경계 관련 메모: BOUNDARY_MEMO must remain unverifiable.';
    const multilineInvariant = '불변식 \n(수식어): MULTILINE_INVARIANT must remain unverifiable.';
    const failedBoundarySource = '경계:';
    const authored = await authorGoal([
      invariantSource,
      boundarySource,
      nonParenthesizedInvariant,
      nonParenthesizedBoundary,
      boundaryMemo,
      multilineInvariant,
      failedBoundarySource,
    ].join('\n'), deps);
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );
    const findings = lintGoalFile(authored.document, 'test');
    const signals = planGateSignals(authored.document, findings);

    expect(invariants.match(/^- Invariant candidate: PARENTHESIZED_INVARIANT remains unchanged\.$/gm)).toHaveLength(1);
    expect(invariants).toContain('- Invariant candidate: PARENTHESIZED_INVARIANT remains unchanged.');
    expect(invariants).toContain(`- Normalized ask marker: original=${JSON.stringify(invariantSource)}; normalized=${JSON.stringify('불변식: PARENTHESIZED_INVARIANT remains unchanged.')}`);
    expect(invariants).not.toContain('- Invariant candidate: NEGATED_INVARIANT');
    expect(invariants).not.toContain('- Invariant candidate: MULTILINE_INVARIANT');
    expect(invariants).toContain(`source=${JSON.stringify(nonParenthesizedInvariant)}`);
    expect(invariants).toContain('source="불변식"');
    expect(boundary.match(/^- Boundary decision:/gm)).toHaveLength(1);
    expect(boundary).toContain('- Boundary decision: PARENTHESIZED_BOUNDARY remains unchanged.');
    expect(boundary).toContain(`- Normalized ask marker: original=${JSON.stringify(boundarySource)}; normalized=${JSON.stringify('경계: PARENTHESIZED_BOUNDARY remains unchanged.')}`);
    expect(boundary).not.toContain('- Boundary decision: NEGATED_BOUNDARY');
    expect(boundary).not.toContain('- Boundary decision: BOUNDARY_MEMO');
    expect(boundary).toContain(`source=${JSON.stringify(nonParenthesizedBoundary)}`);
    expect(boundary).toContain(`source=${JSON.stringify(boundaryMemo)}`);
    expect(boundary).toContain(`source=${JSON.stringify(failedBoundarySource)}`);
    expect(signals.normalizedMarkerSuccess).toBe(2);
    expect(signals.normalizedMarkerFailure).toBe(5);
    // ⭐ 무인 리뷰 3R should-fix — 비괄호 수식어는 «정규화되지 않을 뿐 아니라» 종전 진단 두 칸을
    //    «그대로» 유지해야 한다. source= 만 보면 그 두 칸이 사라져도 통과하므로 직접 단언한다.
    expect(invariants).toContain('required format: 불변식: <preservation statement>; corrected example: 불변식: src/example.ts remains unchanged.');
    expect(boundary).toContain('required format: 경계: <intentional boundary decision>; corrected example: 경계: src/example.ts만 고친다.');
  });

  test('preserves normal invariant and decision-signal candidates beside malformed markers and counts rendered slots', async () => {
    const matchingEvidence = 'src/self-implement/goal-author.ts — Read-verified rendering path.';
    const validSignal = '판정 신호: 조건 = 정상 조건; 관측 = 정상 관측; 기대 = 정상 기대';
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal([
        '불변식: src/self-implement/goal-author.ts keeps the candidate evidence bounded.',
        '불변식은 형식을 맞추지 않은 별도 문장이다.',
        validSignal,
        '판정 신호: 형식을 맞추지 않은 별도 문장이다.',
      ].join('\n'), {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [matchingEvidence] }),
      });
      const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
      const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

      expect(invariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${matchingEvidence}`);
      expect(invariants).toContain('UNVERIFIABLE: Ask contains an invariant marker');
      expect(signals).toContain('  - Condition: 정상 조건');
      expect(signals).toContain('UNVERIFIABLE: Ask contains a decision-signal marker');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', {
        slots: 4,
        filled: 2,
        unfilled: 2,
        unfilledReasons: [
          'an invariant marker did not render as an invariant candidate',
          'a decision-signal marker did not render as a complete decision signal',
        ],
        invariantBranches: { 'path-evidence': 1, 'pathless-preservation': 0, 'pathless-unclassified': 0 },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('keeps hidden invariant-marker diagnostics out of the matching slot count when clarification supplies the contract', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal('불변식은 형식을 맞추지 않은 문장이다.', {
        ...deps,
        clarificationAnswers: { preservation_contract: 'Clarification preservation contract.' },
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      });
      const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));

      expect(invariants).toContain('Clarification-grounded preservation contract: Clarification preservation contract.');
      expect(invariants).not.toContain('Ask contains an invariant marker');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', {
        slots: 2,
        filled: 1,
        unfilled: 1,
        unfilledReasons: ['no persistent evidence contains an observation path candidate'],
        invariantBranches: { 'path-evidence': 0, 'pathless-preservation': 0, 'pathless-unclassified': 0 },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('keeps a following valid cross-kind marker out of an unparsed invariant diagnostic source', async () => {
    const malformedInvariant = '불변식은 오류다.';
    const validSignal = '판정 신호: 조건 = c; 관측 = o; 기대 = e';
    const authored = await authorGoal(`${malformedInvariant} ${validSignal}`, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));
    const diagnostics = invariants.split('\n').filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains an invariant marker'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(`source=${JSON.stringify(malformedInvariant)}`);
    expect(diagnostics[0]).not.toContain(validSignal);
    expect(signals).toContain('  - Condition: c');
    expect(signals).toContain('  - Observation: o');
    expect(signals).toContain('  - Expected result: e');
  });

  test('keeps a following valid signal separate from an empty same-line boundary', async () => {
    const malformedBoundary = '경계:';
    const validSignal = '판정 신호: 조건 = c; 관측 = o; 기대 = e';
    const authored = await authorGoal(`${malformedBoundary} ${validSignal}`, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));
    const diagnostics = boundary.split('\n').filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains a boundary marker'));
    const gateSignals = planGateSignals(authored.document, []);

    expect(boundary).not.toContain('- Boundary decision:');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(`source=${JSON.stringify(malformedBoundary)}`);
    expect(diagnostics[0]).not.toContain(validSignal);
    expect(signals).toContain('  - Condition: c');
    expect(signals).toContain('  - Observation: o');
    expect(signals).toContain('  - Expected result: e');
    expect(gateSignals.unverifiableLines).toContain(diagnostics[0]);
    expect(gateSignals.unverifiable).toBe(gateSignals.unverifiableLines.length);
  });

  test('counts indented unverifiable diagnostics belonging to invariant candidates without changing legacy unverifiable', () => {
    const document = [
      '- Invariant candidate: first preservation contract.',
      '  - UNVERIFIABLE: first evidence is pending.',
      '- Invariant candidate: second preservation contract.',
      '  - UNVERIFIABLE: second evidence is pending.',
      '- Invariant candidate: third preservation contract.',
      '  - UNVERIFIABLE: third evidence is pending.',
      '- Boundary decision: counting only.',
      '  - UNVERIFIABLE: unrelated nested diagnostic.',
    ].join('\n');

    const signals = planGateSignals(document, []);

    expect(signals.unverifiableInvariantCandidates).toBe(3);
    expect(signals.unverifiable).toBe(0);
    expect(signals.unverifiableLines).toEqual([]);
  });

  test('counts unique normalized persistent-evidence paths against labeled targets without changing lint outcomes', () => {
    const document = [
      'Original ask (verbatim, unmodified):',
      '```',
      '대상 경로: src/target.ts · src/other.ts',
      '```',
      '## PROBLEM',
      '- Persistent grounding evidence (verbatim Read-verified completion statements):',
      '  - src/target.ts:10 — matching evidence.',
      '  - ./src/other.ts:20 — normalized matching evidence.',
      '  - src/target.ts:30 — duplicate matching path.',
      '  - src/outside.ts:40 — outside evidence.',
      '## TRACED PATHS',
      '1. src/target.ts:10 — target.',
      '2. src/other.ts:20 — target.',
    ].join('\n');
    const findings = lintGoalFile(document, 'main', { readReferencedFile: () => 'present' });
    const signals = planGateSignals(document, findings);

    expect(signals).toMatchObject({
      persistentEvidenceTargetPathCount: 2,
      persistentEvidenceOutsideTargetPathCount: 1,
      tracedPathMissing: 0,
    });
    expect(planGateSignals(document, findings).tracedPathMissing).toBe(
      findings.filter((finding) => finding.tag === 'traced-path' && finding.message.includes('does not exist')).length,
    );
  });

  test('counts all persistent evidence as overlapping when every path matches a labeled target', async () => {
    const authored = await authorGoal('대상 경로: src/target.ts · src/other.ts\nCount grounding overlap.', {
      ...deps,
      ground: async () => ({
        ...facts,
        persistentEvidence: [
          'src/target.ts:10 — matching evidence.',
          './src/other.ts:20 — normalized matching evidence.',
          'src/target.ts:30 — duplicate matching path.',
        ],
      }),
    });

    expect(planGateSignals(authored.document, [])).toMatchObject({
      persistentEvidenceTargetPathCount: 2,
      persistentEvidenceOutsideTargetPathCount: 0,
    });
  });

  test('counts persistent evidence against traced targets when the verbatim ask has no target-path label', () => {
    const document = [
      'No labeled target path.',
      '## PROBLEM',
      '- Persistent grounding evidence (verbatim Read-verified completion statements):',
      '  - ./src/target.ts:10 — matching persistent evidence.',
      '  - src/other.ts:20 — matching persistent evidence.',
      '## TRACED PATHS',
      '1. ./src/target.ts:10 — traced target.',
      '2. src/other.ts:20 — traced target.',
    ].join('\n');

    expect(planGateSignals(document, [])).toMatchObject({
      persistentEvidenceTargetPathCount: 2,
      persistentEvidenceOutsideTargetPathCount: 0,
    });
  });

  test('combines labeled and traced targets while counting only persistent evidence paths', () => {
    const document = [
      'Original ask (verbatim, unmodified):',
      '```',
      '대상 경로: src/labeled.ts',
      '```',
      '## PROBLEM',
      '- Persistent grounding evidence (verbatim Read-verified completion statements):',
      '  - src/labeled.ts:10 — labeled matching persistent evidence.',
      '  - ./src/traced.ts:20 — traced matching persistent evidence.',
      '  - src/outside.ts:30 — outside persistent evidence.',
      '## TRACED PATHS',
      '1. src/traced.ts:20 — traced target.',
    ].join('\n');

    expect(planGateSignals(document, [])).toMatchObject({
      persistentEvidenceTargetPathCount: 2,
      persistentEvidenceOutsideTargetPathCount: 1,
    });
  });

  test('distinguishes absent persistent evidence from all-outside persistent evidence', () => {
    const document = (persistentEvidence: string[]) => [
      'Original ask (verbatim, unmodified):',
      '```',
      '대상 경로: src/target.ts',
      '```',
      '## PROBLEM',
      '- Persistent grounding evidence (verbatim Read-verified completion statements):',
      ...persistentEvidence.map((entry) => `  - ${entry}`),
      '## TRACED PATHS',
      '1. src/target.ts:10 — target.',
    ].join('\n');

    expect(planGateSignals(document([]), [])).toMatchObject({
      persistentEvidenceTargetPathCount: 0,
      persistentEvidenceOutsideTargetPathCount: 0,
    });
    expect(planGateSignals(document(['src/outside.ts — outside evidence.']), [])).toMatchObject({
      persistentEvidenceTargetPathCount: 0,
      persistentEvidenceOutsideTargetPathCount: 1,
    });
  });

  test('reports missing target sources as unknown rather than zero overlap', () => {
    const document = 'No labeled target path or traced paths.';

    expect(planGateSignals(document, [])).toMatchObject({
      persistentEvidenceTargetPathCount: null,
      persistentEvidenceOutsideTargetPathCount: null,
    });
  });

  test('keeps a valid same-line boundary value separate from a following valid signal', async () => {
    const validBoundary = '경계: src만.';
    const validSignal = '판정 신호: 조건 = c; 관측 = o; 기대 = e';
    const authored = await authorGoal(`${validBoundary} ${validSignal}`, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    expect(boundary).toContain('- Boundary decision: src만.');
    expect(boundary).not.toContain(`- Boundary decision: src만. ${validSignal}`);
    expect(boundary).not.toContain('Ask contains a boundary marker');
    expect(signals).toContain('  - Condition: c');
    expect(signals).toContain('  - Observation: o');
    expect(signals).toContain('  - Expected result: e');
  });

  test('reports every repeated malformed marker occurrence without collapsing equal source text', async () => {
    const malformedInvariant = '불변식은 반복된 형식 오류다.';
    const malformedSignal = '판정 신호: 반복된 형식 오류다.';
    const malformedBoundary = '경계:';
    const authored = await authorGoal([
      malformedInvariant,
      malformedInvariant,
      malformedSignal,
      malformedSignal,
      malformedBoundary,
      malformedBoundary,
    ].join('\n'), {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const diagnostics = authored.document.split('\n');

    expect(diagnostics.filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains an invariant marker'))).toHaveLength(2);
    expect(diagnostics.filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains a decision-signal marker'))).toHaveLength(2);
    expect(diagnostics.filter((line) => line.startsWith('- UNVERIFIABLE: Ask contains a boundary marker'))).toHaveLength(2);
  });

  test('does not report marker-like prose inside a parsed decision signal while reporting a separate malformed marker', async () => {
    const validSignal = {
      condition: '판정 신호는 필드 값이어도 소비된 범위 안에 있다',
      observation: 'decision signal: 역시 관측 필드 값 안에 있다',
      expectedResult: '유효 항목은 유지하고 범위 밖 malformed 표지만 경고한다',
    };
    const validAsk = `판정 신호: 조건 = ${validSignal.condition}; 관측 = ${validSignal.observation}; 기대 = ${validSignal.expectedResult}`;
    const [valid, mixed] = await Promise.all([
      authorGoal(validAsk, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal(`${validAsk}\n판정 신호: 형식을 맞추지 않은 별도 문장이다.`, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
    ]);
    const validSignals = valid.document.slice(valid.document.indexOf('## 판정 신호'), valid.document.indexOf('\n## 검증 시나리오'));
    const mixedSignals = mixed.document.slice(mixed.document.indexOf('## 판정 신호'), mixed.document.indexOf('\n## 검증 시나리오'));

    expect(validSignals).toBe(`## 판정 신호\n- Candidate decision signal:\n  - Condition: ${validSignal.condition}\n  - Observation: ${validSignal.observation}\n  - Expected result: ${validSignal.expectedResult}\n`);
    expect(validSignals).not.toContain('at least one entry did not match');
    expect(mixedSignals).toContain(`  - Condition: ${validSignal.condition}`);
    expect(mixedSignals).toContain('- UNVERIFIABLE: Ask contains a decision-signal marker, but at least one entry did not match the required condition/observation/expected result format.');
  });

  test('reports malformed invariant markers separately from absent invariant markers without inventing content', async () => {
    const [unparsed, absent] = await Promise.all([
      authorGoal('불변식은 이것이다.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
      authorGoal('The author does not invent sentences; inspect the invariant section after authoring.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      }),
    ]);
    const unparsedInvariants = unparsed.document.slice(unparsed.document.indexOf('## 불변식'), unparsed.document.indexOf('## 판정 신호'));
    const absentInvariants = absent.document.slice(absent.document.indexOf('## 불변식'), absent.document.indexOf('## 판정 신호'));

    expect(unparsedInvariants).toContain('- UNVERIFIABLE: Ask contains an invariant marker, but at least one entry did not match the required invariant format. source="불변식은 이것이다." truncated=false; required format: 불변식: <preservation statement>; corrected example: 불변식: src/example.ts remains unchanged.');
    expect(absentInvariants).toBe('## 불변식\n- UNVERIFIABLE: No Read-verified invariant evidence with condition, observation, and expected result is available.\n\n');
  });

  test('keeps ask prose without the required labels UNVERIFIABLE rather than inventing a section candidate', async () => {
    const authored = await authorGoal('The author does not invent sentences; inspect the invariant section after authoring.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    expect(invariants).toContain('- UNVERIFIABLE: No Read-verified invariant evidence with condition, observation, and expected result is available.');
    expect(signals).toContain('- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.');
  });

  test('keeps ordinary persistent evidence out of invariants while decision signals remain UNVERIFIABLE', async () => {
    const authored = await authorGoal('Do not promote ordinary completion evidence to a decision signal.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: ['src/example.ts:42 — ordinary Read-verified completion evidence.'] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    expect(invariants).toBe('## 불변식\n- UNVERIFIABLE: No Read-verified invariant evidence with condition, observation, and expected result is available.\n\n');
    expect(signals).toContain('- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.');
    expect(signals).not.toContain('Candidate observation');
    expect(signals).not.toContain('ordinary Read-verified completion evidence.');
  });

  test('fills only matching invariant evidence, preserves ask-supplied signals, and records deterministic slot outcomes', async () => {
    const matchingEvidence = 'src/self-implement/goal-author.ts — Read-verified rendering path.';
    const unmatchedInvariant = 'src/not-in-evidence.ts must remain untouched.';
    const suppliedSignal = '판정 신호: condition = supplied condition; observation = supplied observation; expected result = supplied result';
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal([
        '불변식: src/self-implement/goal-author.ts only uses persistent evidence.',
        `불변식: ${unmatchedInvariant}`,
        suppliedSignal,
      ].join('\n'), {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [matchingEvidence] }),
      });
      const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
      const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

      expect(invariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${matchingEvidence}`);
      expect(invariants).not.toContain('Candidate evidence (unverified; human or child must confirm): src/not-in-evidence.ts');
      expect(invariants).toContain(`- Invariant candidate: ${unmatchedInvariant}`);
      expect(invariants).toContain('  - UNVERIFIABLE: No persistent evidence mentions a path named by this invariant; human or child must confirm new evidence.');
      expect(signals).toContain('  - Condition: supplied condition');
      expect(signals).toContain('  - Observation: supplied observation');
      expect(signals).toContain('  - Expected result: supplied result');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', {
        slots: 3,
        filled: 2,
        unfilled: 1,
        unfilledReasons: [`no persistent evidence mentions a path named by invariant: ${unmatchedInvariant}`],
        invariantBranches: { 'path-evidence': 2, 'pathless-preservation': 0, 'pathless-unclassified': 0 },
      });
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    '기존 절 이름과 순서는 안 바뀐다.',
    '새 규칙은 프롬프트에만 더해지고 판정 로직을 새로 만들지 않는다.',
    '자식이 아무 줄도 안 적어도 런은 안 죽는다.',
  ])('classifies pathless preservation invariant %s without treating it as filled path evidence', async (preservationInvariant) => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal(`불변식: ${preservationInvariant}`, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      });
      const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));

      expect(invariants).toContain('UNVERIFIABLE: Pathless preservation invariant was classified without path evidence');
      expect(invariants).not.toContain('UNVERIFIABLE: No persistent evidence mentions a path named by this invariant');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', expect.objectContaining({
        slots: 2,
        filled: 0,
        unfilled: 2,
        unfilledReasons: expect.arrayContaining([`pathless preservation invariant classified without path evidence: ${preservationInvariant}`]),
        invariantBranches: { 'path-evidence': 0, 'pathless-preservation': 1, 'pathless-unclassified': 0 },
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('matches punctuation-delimited evidence paths exactly and records rendered slots conservatively', async () => {
    const matchingEvidence = 'src/foo.ts — first Read-verified completion. src/foo.ts — second Read-verified completion.';
    const partialPathEvidence = 'src/foo.tsx — unrelated Read-verified completion.';
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const matched = await authorGoal('불변식: src/foo.ts. must be confirmed.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [matchingEvidence, partialPathEvidence] }),
      });
      const matchedInvariants = matched.document.slice(matched.document.indexOf('## 불변식'), matched.document.indexOf('## 판정 신호'));
      expect(matchedInvariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${matchingEvidence}`);
      expect(matchedInvariants).not.toContain(`Candidate evidence (unverified; human or child must confirm): ${partialPathEvidence}`);
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', expect.objectContaining({
        slots: 2,
        filled: 1,
        unfilled: 1,
        unfilledReasons: ['no persistent evidence contains an observation path candidate'],
      }));

      log.mockClear();
      const unmatched = await authorGoal('불변식: src/foo.ts must be confirmed.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [partialPathEvidence] }),
      });
      const unmatchedInvariants = unmatched.document.slice(unmatched.document.indexOf('## 불변식'), unmatched.document.indexOf('## 판정 신호'));
      expect(unmatchedInvariants).toContain('UNVERIFIABLE: No persistent evidence mentions a path named by this invariant');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', expect.objectContaining({
        slots: 2,
        filled: 0,
        unfilled: 2,
        unfilledReasons: [
          'no persistent evidence mentions a path named by invariant: src/foo.ts must be confirmed.',
          'no persistent evidence contains an observation path candidate',
        ],
      }));

      log.mockClear();
      const malformed = await authorGoal('불변식은 malformed marker다.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      });
      const malformedInvariants = malformed.document.slice(malformed.document.indexOf('## 불변식'), malformed.document.indexOf('## 판정 신호'));
      expect(malformedInvariants).toContain('UNVERIFIABLE: Ask contains an invariant marker');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', expect.objectContaining({
        slots: 2,
        filled: 0,
        unfilled: 2,
        unfilledReasons: expect.arrayContaining([
          'an invariant marker did not render as an invariant candidate',
          'no persistent evidence contains an observation path candidate',
        ]),
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('renders matching repository-root evidence only beneath its ask invariant', async () => {
    const rootEvidence = 'README.md and package.json — Read-verified repository-root contracts.';
    const packageEvidence = 'package.json — earlier Read-verified package contract.';
    const similarEvidence = 'README.mdx and package-lock.json — unrelated completion evidence.';
    const authored = await authorGoal('불변식: README.md and package.json must remain grounded.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [packageEvidence, rootEvidence, similarEvidence] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));

    expect(invariants.split(rootEvidence)).toHaveLength(2);
    expect(invariants.indexOf(packageEvidence)).toBeLessThan(invariants.indexOf(rootEvidence));
    expect(invariants).not.toContain(similarEvidence);
    expect(invariants).not.toContain('UNVERIFIABLE: No persistent evidence mentions a path named by this invariant');
  });

  test('keeps a multi-path invariant UNVERIFIABLE until every named path has exact persistent evidence', async () => {
    const firstPathEvidence = 'src/first.ts — Read-verified first contract.';
    const secondPathEvidence = 'src/second.ts — Read-verified second contract.';
    const ask = '불변식: src/first.ts and src/second.ts must remain grounded.';
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const partial = await authorGoal(ask, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [firstPathEvidence] }),
      });
      const partialInvariants = partial.document.slice(partial.document.indexOf('## 불변식'), partial.document.indexOf('## 판정 신호'));
      expect(partialInvariants).toContain('UNVERIFIABLE: No persistent evidence mentions a path named by this invariant');
      expect(partialInvariants).not.toContain(`- Invariant candidate: ${firstPathEvidence}`);
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', expect.objectContaining({
        slots: 2,
        filled: 0,
        unfilled: 2,
        unfilledReasons: expect.arrayContaining([`no persistent evidence mentions a path named by invariant: src/first.ts and src/second.ts must remain grounded.`]),
      }));

      log.mockClear();
      const complete = await authorGoal(ask, {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [firstPathEvidence, secondPathEvidence] }),
      });
      const completeInvariants = complete.document.slice(complete.document.indexOf('## 불변식'), complete.document.indexOf('## 판정 신호'));
      expect(completeInvariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${firstPathEvidence}`);
      expect(completeInvariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${secondPathEvidence}`);
      expect(completeInvariants).not.toContain('UNVERIFIABLE: No persistent evidence mentions a path named by this invariant');
      expect(log).toHaveBeenCalledWith('goal-author', 'section-slot-fill', expect.objectContaining({
        slots: 2,
        filled: 1,
        unfilled: 1,
        unfilledReasons: ['no persistent evidence contains an observation path candidate'],
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('falls back to safe codeFact symbols after path evidence misses while preserving path priority and diagnostics', async () => {
    const pathEvidence = 'src/priority.ts — Read-verified path contract.';
    const codeFact = '[code:src/a/b.ts] doThing, accessMode, id, data';
    const authored = await authorGoal([
      '불변식: src/priority.ts doThing remains grounded.',
      '불변식: doThing remains grounded without naming a path.',
      '불변식: accessMode remains grounded without naming a path.',
      '불변식: id remains grounded without naming a path.',
      '불변식: data remains grounded without naming a path.',
      '불변식: handle.missingMode remains grounded.',
      '불변식: no named evidence remains grounded.',
    ].join('\n'), {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [pathEvidence], codeFacts: [codeFact] }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));

    expect(invariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${pathEvidence}`);
    expect(invariants).toContain(`Candidate evidence (unverified; human or child must confirm): ${codeFact}`);
    expect(invariants.indexOf(pathEvidence)).toBeLessThan(invariants.indexOf(codeFact));
    expect(invariants.match(new RegExp(codeFact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(invariants).toMatch(/- Invariant candidate: data remains grounded without naming a path\.\n  - UNVERIFIABLE: No persistent evidence mentions a path named by this invariant/);
    expect(invariants).toContain('UNVERIFIABLE: A dotted expression was interpreted as a path candidate, but no persistent path or code-symbol evidence matched this invariant');
    expect(invariants).toContain('UNVERIFIABLE: No persistent evidence mentions a path named by this invariant; human or child must confirm new evidence.');
  });

  test('rejects decision-signal evidence whose condition, observation, or expected result is whitespace-only', async () => {
    const malformedEvidence = [
      'Decision signal: condition =   ; observation = observed; expected result = preserved',
      'Decision signal: condition = checked; observation =   ; expected result = preserved',
      'Decision signal: condition = checked; observation = observed; expected result =   ',
    ];
    const authored = await authorGoal('Reject incomplete invariant evidence.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: malformedEvidence }),
    });
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const signals = authored.document.slice(authored.document.indexOf('## 판정 신호'), authored.document.indexOf('\n## 검증 시나리오'));

    // Whitespace-only fields cannot form decision signals or standalone invariant candidates.
    expect(signals).toContain('- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.');
    for (const evidence of malformedEvidence) {
      expect(invariants).not.toContain(evidence);
      expect(signals).not.toContain(evidence);
    }
  });

  test('points SCQA fallbacks to the canonical verbatim ask without repeating its first line', async () => {
    const firstAsk = 'Fix the session exporter so it preserves attachment filenames.\n\nKeep the target path unchanged.';
    const secondAsk = 'Add a retry budget to the notification dispatcher.';
    const first = await authorGoal(firstAsk, deps);
    const second = await authorGoal(secondAsk, deps);
    const firstProblem = first.document.slice(first.document.indexOf('## PROBLEM') + '## PROBLEM\n'.length, first.document.indexOf('## WHAT TO BUILD'));
    const firstBuild = first.document.slice(first.document.indexOf('## WHAT TO BUILD') + '## WHAT TO BUILD\n'.length, first.document.indexOf('## ACCEPTANCE CRITERIA'));
    const secondProblem = second.document.slice(second.document.indexOf('## PROBLEM') + '## PROBLEM\n'.length, second.document.indexOf('## WHAT TO BUILD'));
    const secondBuild = second.document.slice(second.document.indexOf('## WHAT TO BUILD') + '## WHAT TO BUILD\n'.length, second.document.indexOf('## ACCEPTANCE CRITERIA'));
    const firstProblemParagraphs = firstProblem.split('\n\n')[0].split('\n');
    const firstBuildParagraphs = firstBuild.split('\n\n')[0].split('\n');
    const firstLine = firstAsk.split('\n', 1)[0];

    expect(firstProblemParagraphs).toHaveLength(3);
    expect(firstBuildParagraphs).toHaveLength(2);
    expect(firstProblemParagraphs.slice(0, 2).every((line) => !line.startsWith('- '))).toBe(true);
    expect(firstProblemParagraphs[2]).toBe('- Grounding files not mentioned in ask (1): `src/example.ts`');
    expect(firstBuildParagraphs.every((line) => !line.startsWith('- '))).toBe(true);
    expect(firstProblem).toContain('the canonical verbatim request block below (Original ask)');
    expect(firstProblem).not.toContain(firstLine);
    expect(secondProblem).toContain('the canonical verbatim request block below (Original ask)');
    expect(secondBuild).toContain('Same as Complication');
    expect(firstProblemParagraphs).not.toEqual(firstBuildParagraphs);
    expect(first.document).toContain(`\n${firstAsk}\n`);
    expect(first.document.match(new RegExp(firstLine, 'g'))).toHaveLength(3);
    expect(firstProblem.match(/^  - /gm)).toHaveLength(1);
    expect(firstBuild).not.toContain('Candidate requiring path tracing:');
    expect(firstBuild).toContain('Implementation target narrowed by rule one: src/example.ts');
    expect(first.document).not.toContain('Build standalone sentences');
    expect(first.document).not.toContain('authored PROBLEM block has no standalone sentence');
  });

  test('marks both no-clarification SCQA fallback branches unanswered instead of repeating Complication or Original ask', async () => {
    const ask = 'Describe an ungrounded request.';
    const persistentEvidence = 'opaque-persistent-evidence';
    const grounded = await authorGoal(ask, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [persistentEvidence] }),
    });
    const ungrounded = await authorGoal(ask, {
      ...deps,
      ground: async () => noFacts,
    });
    const slots = (document: string) => document.slice(document.indexOf('## PROBLEM'), document.indexOf('Original ask (verbatim, unmodified):'))
      .split('\n').filter((line) => /^(Situation|Complication|Question|Answer):/.test(line));

    // ⛔ GROUNDED 두 줄의 기대가 낡은 이유(2026-08-08): 종전 `Situation` 은 접지 «개수»를 보고했고
    //   `Complication` 은 근거 «전문»을 이어 붙였다. 요약(`enhance` 산출)이 그 자리를 받고,
    //   이 픽스처처럼 요약이 없으면 «근거를 다시 싣지 않는» 폴백이 온다.
    //   ⭐ `request` 는 폴백에도 남는다 — 없으면 이 절이 골마다 같아진다.
    expect(slots(grounded.document)).toEqual([
      'Situation: GROUNDED — The request is preserved verbatim in the canonical verbatim request block below (Original ask); no authored state summary was produced for this revision, so the grounded state remains recorded as 1 Read-verified evidence item in the Persistent grounding evidence section below.',
      'Complication: GROUNDED — No authored problem summary was produced for this revision; read the Persistent grounding evidence section below to determine what is wrong. This line does not restate that evidence.',
      'Question: UNANSWERED — Same as Complication; Read-verified evidence adds no distinct question.',
      'Answer: UNANSWERED — Same as Complication; Read-verified evidence adds no distinct answer.',
    ]);
    expect(slots(ungrounded.document)).toEqual([
      'Situation: NOT-GROUNDED — The request is preserved verbatim in the canonical verbatim request block below (Original ask); no repository facts were grounded, so the reported repository state remains unverified.',
      'Complication: NOT-GROUNDED — No qualifying evidence was found, so a recipient cannot determine the reported failure beyond the verbatim request.',
      'Question: UNANSWERED — Same as Original ask; no distinct question was grounded.',
      'Answer: UNANSWERED — Same as Original ask; no distinct answer was grounded.',
    ]);
    // `Complication`과 불변식 독립 항목은 접지 근거를 되풀이하지 않는다.
    // 비traced 근거는 사실별 보존 기준과 Persistent grounding evidence에 각각 한 번 나타난다.
    expect(grounded.document.match(new RegExp(persistentEvidence, 'g'))).toHaveLength(2);
  });

  test('asks for an implementation identifier anchor when grounding observes zero code candidates without blocking authoring', async () => {
    const observedZero = { ...facts, files: [], codeFacts: [], persistentEvidence: [] };
    const authored = await authorGoal('Fix the named target without an identifier anchor.', {
      ...deps,
      ground: async () => observedZero,
    });
    const clarifications = parseGoalDocumentClarifications(authored.document);
    const scqa = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('Original ask (verbatim, unmodified):'));

    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]).toMatchObject({
      questionId: 'implementation_anchor',
      question: expect.stringContaining('which function, which constant, or which line'),
      answered: false,
      answer: expect.stringContaining('DEFERRED-UNTIL:'),
    });
    expect(scqa).toContain('Answer: UNANSWERED — implementation_anchor');
    expect(authored.document).toContain('## ACCEPTANCE CRITERIA');
  });

  test('asks with anchor-specific wording and options when a nonexistent named path is absent from nonempty repository-vocabulary candidates without blocking authoring', async () => {
    const authored = await authorGoal('Create src/self-implement/new-anchor-target.ts with goal-author behavior.', {
      ...deps,
      ground: async () => ({ ...facts, files: ['src/self-implement/goal-author.ts'] }),
    });
    const clarifications = parseGoalDocumentClarifications(authored.document);
    const anchor = clarifications.find(({ questionId }) => questionId === 'implementation_anchor');

    expect(anchor).toMatchObject({
      questionId: 'implementation_anchor',
      question: expect.stringContaining('did not find a code candidate matching a path named in the ask'),
      answered: false,
      answer: expect.stringContaining('DEFERRED-UNTIL:'),
    });
    expect(authored.document).not.toContain('zero code candidates');
    expect(authored.document).toContain('label: Function or constant');
    expect(authored.document).toContain('label: Relevant source line');
    expect(authored.document).not.toContain('label: Failing test filename');
    expect(authored.document).toContain('## ACCEPTANCE CRITERIA');
  });

  // ⛔ 2026-08-11 72차: 제공자 과부하로 코드 접지 «채널»이 죽은 저작이 절반이었는데(persistent failed ⟺ code=0 · 17/17),
  //   도구는 그것을 *"Provide an identifier anchor"* 로 말했고 두 트랙이 그 문면을 믿고 같은 ask 를 여러 번 다시 썼다.
  //   ⇒ 채널 실패는 «사람의 ask 결손»이 아니다. 위 1833 시험(채널 미실패)이 그대로 대조군이다.
  // ⛔ 「완주 못 함」(stopReason !== goal_complete)도 «사람 탓이 아니다» — 72차 전수에서
  //   후보 0인 finished 다섯이 «전부» end_turn 이었다(「성공인데 0」은 없는 수수께끼였다).
  test('does not blame the ask when the code grounding channel stopped without completing', async () => {
    const authored = await authorGoal('Create src/self-implement/new-anchor-target.ts with goal-author behavior.', {
      ...deps,
      ground: async () => ({ ...facts, files: ['src/self-implement/goal-author.ts'], codeChannel: 'incomplete' as const }),
    });
    const ids = parseGoalDocumentClarifications(authored.document).map(({ questionId }) => questionId);

    expect(ids).toContain('code_channel_failed');
    expect(ids).not.toContain('implementation_anchor');
    expect(authored.document).toContain('did NOT complete');
  });

  test('does not blame the ask when the code grounding channel failed — it names the channel and says re-run', async () => {
    const authored = await authorGoal('Create src/self-implement/new-anchor-target.ts with goal-author behavior.', {
      ...deps,
      ground: async () => ({ ...facts, files: ['src/self-implement/goal-author.ts'], codeChannel: 'failed' as const }),
    });
    const ids = parseGoalDocumentClarifications(authored.document).map(({ questionId }) => questionId);

    expect(ids).toContain('code_channel_failed');
    expect(ids).not.toContain('implementation_anchor');
    // 처방이 «반대»여야 한다 — 고치지 말고 다시 친다.
    expect(authored.document).toContain('Do NOT rewrite the ask');
    expect(authored.document).toContain('grounding.persistent');
    expect(authored.document).not.toContain('Provide an identifier anchor');
  });

  test('keeps default clarification options for questions without custom options', async () => {
    const authored = await authorGoal('Create src/self-implement/new-anchor-target.ts with goal-author behavior.', {
      ...deps,
      ground: async () => ({ ...facts, files: ['src/self-implement/goal-author.ts'], genericSearchScope: true }),
    });
    const targetStart = authored.document.indexOf('  - id: implementation_target');
    const targetEnd = authored.document.indexOf('  - includeOther:', targetStart);
    const target = authored.document.slice(targetStart, targetEnd);

    expect(target).toContain('label: Failing test filename');
    expect(target).toContain('label: One error-message line');
    expect(target).not.toContain('label: Function or constant');
  });

  test('does not ask for an implementation identifier anchor when a named path matches a nonempty candidate', async () => {
    const authored = await authorGoal('Fix src/self-implement/goal-author.ts with this behavior.', {
      ...deps,
      ground: async () => ({ ...facts, files: ['src/self-implement/goal-author.ts'] }),
    });

    expect(parseGoalDocumentClarifications(authored.document).map(({ questionId }) => questionId)).not.toContain('implementation_anchor');
  });

  test('does not turn unmeasured grounding into a zero-candidate identifier clarification', async () => {
    const authored = await authorGoal('Fix an unmeasured target.', {
      ...deps,
      ground: async () => noFacts,
    });

    expect(parseGoalDocumentClarifications(authored.document).map(({ questionId }) => questionId)).not.toContain('implementation_anchor');
  });

  test('renders SCQA Question and Answer from the first rendered clarification and marks an unanswered answer by ID', async () => {
    const persistentEvidence = 'opaque-persistent-evidence';
    const clarificationQuestion = IMPLEMENTATION_TARGET_CLARIFICATION;
    const unanswered = await authorGoal('Describe a grounded request.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [persistentEvidence], genericSearchScope: true }),
    });
    const answered = await authorGoal('Describe a grounded request.', {
      ...deps,
      clarificationAnswers: { implementation_target: 'src/example.test.ts' },
      ground: async () => ({ ...facts, persistentEvidence: [persistentEvidence], genericSearchScope: true }),
    });
    const scqaSlots = (document: string) => document.slice(document.indexOf('## PROBLEM'), document.indexOf('Original ask (verbatim, unmodified):'))
      .split('\n').filter((line) => /^(Situation|Complication|Question|Answer):/.test(line));

    expect(scqaSlots(unanswered.document)).toContain(`Question: GROUNDED — ${clarificationQuestion}`);
    expect(scqaSlots(unanswered.document)).toContain('Answer: UNANSWERED — implementation_target');
    expect(scqaSlots(answered.document)).toContain(`Question: GROUNDED — ${clarificationQuestion}`);
    expect(scqaSlots(answered.document)).toContain('Answer: GROUNDED — src/example.test.ts');
    expect(scqaSlots(answered.document)).not.toContain(`Question: GROUNDED — What change is required by this Read-verified evidence: ${persistentEvidence}?`);
    expect(scqaSlots(answered.document)).not.toContain(`Answer: GROUNDED — Deliver the outcome established by this Read-verified evidence: ${persistentEvidence}.`);
  });

  test('uses the first rendered clarification for SCQA across target, contract, and ambiguity answers during reauthoring', async () => {
    const ask = 'Describe a grounded request.';
    const cases = [
      {
        name: 'implementation target',
        facts: { ...facts, persistentEvidence: ['target evidence'], genericSearchScope: true },
        id: 'implementation_target',
        answer: 'src/example.test.ts',
      },
      {
        name: 'preservation contract',
        facts: { ...facts, persistentEvidence: [], genericSearchScope: false },
        id: 'preservation_contract',
        answer: 'Preserve the established response shape.',
      },
      {
        name: 'preservation ambiguity',
        facts: {
          ...facts,
          persistentEvidence: ['src/example.ts:42 — implementation must add the proven behavior.'],
          genericSearchScope: false,
        },
        id: 'preservation_ambiguity',
        answer: 'Implement the explicit requirement without weakening the contract.',
      },
    ];
    const scqaSlots = (document: string) => document.slice(document.indexOf('## PROBLEM'), document.indexOf('Original ask (verbatim, unmodified):'))
      .split('\n').filter((line) => /^(Situation|Complication|Question|Answer):/.test(line));

    for (const entry of cases) {
      const unanswered = await authorGoal(ask, { ...deps, ground: async () => entry.facts });
      const rendered = parseGoalDocumentClarifications(unanswered.document);
      const first = rendered[0];
      const deferredAnswer = `DEFERRED-UNTIL: ${entry.answer}`;
      const deferred = await authorGoal(ask, {
        ...deps,
        ground: async () => entry.facts,
        clarificationAnswers: { [entry.id]: deferredAnswer },
      });
      const answered = await authorGoal(ask, {
        ...deps,
        ground: async () => entry.facts,
        clarificationAnswers: { [entry.id]: entry.answer },
      });

      const status = entry.facts.persistentEvidence.length ? 'GROUNDED' : 'NOT-GROUNDED';
      const unansweredScqaAnswer = `Answer: UNANSWERED — ${entry.id}`;
      const answeredScqaAnswer = `Answer: ${status} — ${entry.answer}`;
      expect(first?.questionId, entry.name).toBe(entry.id);
      expect(scqaSlots(unanswered.document), entry.name).toContain(`Question: ${status} — ${first?.question}`);
      expect(scqaSlots(unanswered.document), entry.name).toContain(unansweredScqaAnswer);
      expect(scqaSlots(deferred.document), entry.name).toContain(`Question: ${status} — ${first?.question}`);
      expect(scqaSlots(deferred.document), entry.name).toContain(unansweredScqaAnswer);
      expect(deferred.document, entry.name).toContain(`answer: ${deferredAnswer}`);
      expect(scqaSlots(answered.document), entry.name).toContain(`Question: ${status} — ${first?.question}`);
      expect(scqaSlots(answered.document), entry.name).toEqual(expect.arrayContaining([answeredScqaAnswer]));
      expect(scqaSlots(answered.document), entry.name).not.toContain(unansweredScqaAnswer);
      expect(scqaSlots(answered.document).filter((line) => line.startsWith('Answer:')), entry.name).toEqual([answeredScqaAnswer]);
    }
  });

  test('marks an unanswered clarification in SCQA while distinguishing the Complication from non-empty evidence', async () => {
    const ask = 'Describe a request without persistent evidence.';
    const withPersistentEvidence = { ...facts, persistentEvidence: ['opaque-persistent-evidence'] };
    const withoutPersistentEvidence = { ...facts, persistentEvidence: [] };
    const [persistent, withoutPersistent] = await Promise.all([
      authorGoal(ask, { ...deps, ground: async () => withPersistentEvidence }),
      authorGoal(ask, { ...deps, ground: async () => withoutPersistentEvidence }),
    ]);
    const complicationFor = (document: string) => document.split('\n').find((line) => line.startsWith('Complication:'));
    const slots = withoutPersistent.document.slice(withoutPersistent.document.indexOf('## PROBLEM'), withoutPersistent.document.indexOf('Original ask (verbatim, unmodified):'))
      .split('\n').filter((line) => /^(Situation|Complication|Question|Answer):/.test(line));

    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.split(' — ', 1)[0])).toEqual([
      'Situation: NOT-GROUNDED',
      'Complication: NOT-GROUNDED',
      'Question: NOT-GROUNDED',
      'Answer: UNANSWERED',
    ]);
    // ⛔ 이 기대가 낡은 이유(2026-08-08): 종전 GROUNDED `Complication` 은 `persistentEvidence.join(' ')`
    //   였다. 접지 5건 저작에서 그 한 줄이 1,236자였고 근거 절·TRACED PATHS 와 글자 그대로 중복이었다.
    //   ⇒ 이제 요약(`enhance` 산출)이 그 자리를 채우고, 요약이 없으면 «근거를 다시 싣지 않는» 폴백이 온다.
    //   이 픽스처는 요약을 주지 않으므로 폴백 문면을 기대한다.
    expect(complicationFor(persistent.document)).toBe('Complication: GROUNDED — No authored problem summary was produced for this revision; read the Persistent grounding evidence section below to determine what is wrong. This line does not restate that evidence.');
    expect(complicationFor(withoutPersistent.document)).toBe('Complication: NOT-GROUNDED — The available evidence identifies locations and exported facts, but it does not establish the reported behavior, causation, or call path.');
    expect(complicationFor(persistent.document)).not.toBe(complicationFor(withoutPersistent.document));
  });

  test('marks no-clarification grounded SCQA Question and Answer as duplicates of Complication', async () => {
    const persistentEvidence = 'opaque-persistent-evidence';
    const authored = await authorGoal('Describe a request without clarification.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [persistentEvidence], genericSearchScope: false }),
    });

    expect(authored.document).toContain('Question: UNANSWERED — Same as Complication; Read-verified evidence adds no distinct question.');
    expect(authored.document).toContain('Answer: UNANSWERED — Same as Complication; Read-verified evidence adds no distinct answer.');
    // 비traced 근거는 사실별 보존 기준과 Persistent grounding evidence에 각각 한 번 나타난다.
    expect(authored.document.match(new RegExp(persistentEvidence, 'g'))).toHaveLength(2);
  });

  test('states an honest unverified situation and complication when grounding has no evidence', async () => {
    const ungroundedAsk = 'Describe an ungrounded request.';
    const authored = await authorGoal(ungroundedAsk, {
      ...deps,
      ground: async () => noFacts,
    });
    const problem = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('## WHAT TO BUILD'));

    expect(problem).toContain('Situation: NOT-GROUNDED — The request is preserved verbatim in the canonical verbatim request block below (Original ask); no repository facts were grounded, so the reported repository state remains unverified.');
    expect(problem).not.toContain(ungroundedAsk);
    expect(problem).toContain('Complication: NOT-GROUNDED — No qualifying evidence was found, so a recipient cannot determine the reported failure beyond the verbatim request.');
  });

  test('auto-answers exactly one recommended non-safety option while preserving the clarification round trip', () => {
    const clarification = (overrides: Partial<IntakeClarification> = {}): IntakeClarification => ({
      questionId: 'q-auto',
      kind: 'scope',
      header: 'Clarification',
      question: 'Choose a repository target.',
      options: [
        { label: 'Recommended target', recommended: true },
        { label: 'Alternative target' },
      ],
      blocking: true,
      ...overrides,
    });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);

    const autoAnswered = parseGoalAuthorClarifications(serializeGoalAuthorClarification(clarification()))[0];
    const safetyDeferred = parseGoalAuthorClarifications(serializeGoalAuthorClarification(clarification({ kind: 'safety' })))[0];
    const ambiguousDeferred = parseGoalAuthorClarifications(serializeGoalAuthorClarification(clarification({
      options: [
        { label: 'Recommended target', recommended: true },
        { label: 'Also recommended', recommended: true },
      ],
    })))[0];
    const injected = parseGoalAuthorClarifications(serializeGoalAuthorClarification(clarification({ answer: 'Injected answer' })))[0];

    expect(autoAnswered.response).toMatchObject({ answer: 'Recommended target', status: 'ANSWERED' });
    expect(log).toHaveBeenCalledWith('goal-author.clarify', 'auto-answered', {
      questionId: 'q-auto', kind: 'scope', label: 'Recommended target', selfResolutionSelected: false,
    });
    expect(safetyDeferred.response).toMatchObject({ answer: null, status: 'DEFERRED-UNTIL: Choose a repository target.' });
    expect(ambiguousDeferred.response).toMatchObject({ answer: null, status: 'DEFERRED-UNTIL: Choose a repository target.' });
    expect(injected.response).toMatchObject({ answer: 'Injected answer', status: 'ANSWERED' });
    expect(log).toHaveBeenCalledWith('harness.author.clarify', 'auto-answered', {
      questionId: 'q-auto', kind: 'scope', label: 'Recommended target', selfResolutionSelected: false,
    });
    expect(log).toHaveBeenCalledTimes(2);
  });

  test('renders each existing clarification as an IntakeClarification-shaped response slot and preserves unanswered state', async () => {
    const genericFacts = { ...facts, persistentEvidence: [], genericSearchScope: true };
    const unanswered = await authorGoal('Clarify generic implementation evidence.', {
      ...deps,
      ground: async () => genericFacts,
    });

    expect(unanswered.document).toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
    expect(unanswered.document).toContain('id: implementation_target');
    expect(unanswered.document).toContain('id: preservation_contract');
    expect(unanswered.document).toContain('options:\n    - label: Failing test filename\n      description: Provide the focused test file that demonstrates the failure.\n    - label: One error-message line\n      description: Provide one error line that identifies the existing contract.\n    - label: Command and its current output\n      description: Use the Other free-form response to provide one command and the current output it produces; selecting this label alone is not an answer.');
    expect(unanswered.document).toContain('includeOther: true');
    expect(unanswered.document).toContain(`DEFERRED-UNTIL: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
    expect(unanswered.document).toContain('DEFERRED-UNTIL: Clarification required before adding a preservation criterion: grounded code facts identify exported symbols only');
    expect(unanswered.document).toContain('If nothing currently fails, provide the current contract as a command and its output, for example `bun test src/self-implement/goal-author.test.ts` → `0 fail`.');
    expect(unanswered.document.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
    ]);
  });

  test('renders each preservation clarification with its stable ID, ordered options, and free-form answer wiring', async () => {
    const contract = await authorGoal('Clarify a preservation contract.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [], genericSearchScope: false }),
    });
    const ambiguity = await authorGoal('Clarify a preservation ambiguity.', {
      ...deps,
      ground: async () => ({
        ...facts,
        persistentEvidence: ['src/example.ts — implementation must add the proven behavior.'],
        genericSearchScope: false,
      }),
    });
    const expectedOptions = [
      { label: 'Failing test filename', description: 'Provide the focused test file that demonstrates the failure.' },
      { label: 'One error-message line', description: 'Provide one error line that identifies the existing contract.' },
      {
        label: 'Command and its current output',
        description: 'Use the Other free-form response to provide one command and the current output it produces; selecting this label alone is not an answer.',
      },
    ];

    for (const [name, document, questionId] of [
      ['contract', contract.document, 'preservation_contract'],
      ['ambiguity', ambiguity.document, 'preservation_ambiguity'],
    ] as const) {
      const clarification = parseGoalDocumentClarifications(document).find((entry) => entry.questionId === questionId);

      expect(clarification, name).toEqual(expect.objectContaining({
        questionId,
        includeOther: true,
        options: expectedOptions,
      }));
    }
  });

  test('renders injected clarification answers instead of deferred markers without changing clarification triggers', async () => {
    const genericFacts = { ...facts, persistentEvidence: [], genericSearchScope: true };
    const answered = await authorGoal('Clarify generic implementation evidence.', {
      ...deps,
      ground: async () => genericFacts,
      clarificationAnswers: {
        'implementation_target': 'src/self-implement/goal-author.test.ts',
        'preservation_contract': 'Existing contract error line',
      },
    });
    const clear = await authorGoal('Do not request clarification for a clear request.', {
      ...deps,
      ground: async () => facts,
    });

    expect(answered.document).toContain('id: implementation_target');
    expect(answered.document).toContain('answer: src/self-implement/goal-author.test.ts');
    expect(answered.document).toContain('answer: Existing contract error line');
    expect(answered.document).not.toContain('DEFERRED-UNTIL:');
    expect(clear.document).not.toContain('id: implementation_target');
    expect(clear.document).not.toContain('id: preservation_contract');
    expect(clear.document).toContain(IMPLEMENT_PRESERVATION_REFERENCE);
    expect(clear.document.split(facts.persistentEvidence[0])).toHaveLength(2);
  });

  test('preserves legacy boolean and omitted calls while accepting an ask for target narrowing', () => {
    const candidates = { ...facts, files: ['src/a.ts', 'src/b.ts'], genericSearchScope: false };
    const genericCandidates = { ...candidates, genericSearchScope: true };

    expect(requiresImplementationTargetClarification(candidates, true)).toBe(false);
    expect(requiresImplementationTargetClarification(candidates, false)).toBe(false);
    expect(requiresImplementationTargetClarification(candidates)).toBe(false);
    expect(requiresImplementationTargetClarification(genericCandidates, false)).toBe(true);
    expect(requiresImplementationTargetClarification(candidates, 'Implement `src/a.ts`.')).toBe(false);
  });

  test('narrows implementation targets by candidate count or the first ask path token and preserves unanswered clarification text otherwise', async () => {
    const clarification = `question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`;
    const target = (rule: 'rule two' | 'rule three', path: string) => `- Implementation target narrowed by ${rule}: ${path}`;
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const candidates = ['src/a.ts', 'src/dir/a.ts', 'src/foo.ts'];
    const author = (
      input: string,
      files: string[],
      genericSearchScope = false,
      clarificationAnswers?: GoalAuthorDeps['clarificationAnswers'],
    ) => authorGoal(input, {
      ...deps,
      clarificationAnswers,
      ground: async () => ({ ...facts, files, genericSearchScope }),
    });
    try {
      const [single, oneToken, absentFirstPath, absentFirstPathAnswered, suffixCollision, nestedPath, twoTokens, askOrderNotListOrder, noTokens, generic] = await Promise.all([
        author('No repository path is named.', ['src/only.ts']),
        author('Implement `src/dir/a.ts`.', candidates),
        author('Implement (`src/missing.ts`), then `src/foo.ts`.', candidates),
        author('Implement (`src/missing.ts`), then `src/foo.ts`.', candidates, false, {
          implementation_target: 'src/foo.ts',
        }),
        author('Implement `src/foo.tsx`.', ['src/foo.ts', 'src/bar.ts']),
        author('Implement `src/dir/a.ts`.', ['src/a.ts', 'src/dir/a.ts']),
        author('Implement `src/a.ts` and `src/dir/a.ts`.', candidates),
        // rule three 는 "ask 에서 가장 먼저" 를 뜻한다. 위 twoTokens 는 ask 순서와 candidates 배열 순서가
        // 같아서 둘을 구별하지 못한다 — 이 입력은 배열 마지막 후보를 ask 맨 앞에 둬서 그 축을 가른다.
        author('Implement `src/foo.ts` and `src/a.ts`.', candidates),
        author('Implement the selected behavior.', candidates),
        author('Implement `src/only.ts`.', ['src/only.ts'], true),
      ]);

      expect(single.document).toContain('- Implementation target narrowed by rule one: src/only.ts');
      expect(single.document).not.toContain(clarification);
      expect(oneToken.document).toContain(target('rule two', 'src/dir/a.ts'));
      expect(oneToken.document).not.toContain(clarification);
      expect(absentFirstPath.document).toContain('- Implementation target not narrowed: ask names src/missing.ts first, but it is not among grounded candidates; repository existence could not be inspected.');
      expect(absentFirstPath.document).toContain(clarification);
      expect(absentFirstPath.document).not.toContain('Implementation target narrowed');
      expect(absentFirstPathAnswered.document).toContain('- Implementation target not narrowed: ask names src/missing.ts first, but it is not among grounded candidates; repository existence could not be inspected.');
      expect(absentFirstPathAnswered.document).toContain('- Clarification-grounded implementation target: src/foo.ts');
      expect(absentFirstPathAnswered.document).not.toContain('Implementation target narrowed');
      expect(suffixCollision.document).toContain(clarification);
      expect(suffixCollision.document).not.toContain('Implementation target narrowed');
      expect(nestedPath.document).toContain(target('rule two', 'src/dir/a.ts'));
      expect(nestedPath.document).not.toContain(target('rule two', 'src/a.ts'));
      expect(twoTokens.document).toContain(target('rule three', 'src/a.ts'));
      expect(twoTokens.document).not.toContain(target('rule three', 'src/dir/a.ts'));
      expect(twoTokens.document).not.toContain(clarification);
      expect(askOrderNotListOrder.document).toContain(target('rule three', 'src/foo.ts'));
      expect(askOrderNotListOrder.document).not.toContain(target('rule three', 'src/a.ts'));
      expect(askOrderNotListOrder.document).not.toContain(clarification);
      for (const authored of [noTokens, generic]) {
        expect(authored.document).toContain(clarification);
        expect(authored.document).toContain(`DEFERRED-UNTIL: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
        expect(authored.document).not.toContain('Implementation target narrowed');
      }
      expect(log).toHaveBeenCalledWith('goal-author', 'implementation-target-narrowing', {
        authorRunId: expect.any(String),
        attempted: true,
        rule: 'single-candidate',
        path: 'src/only.ts',
      });
      expect(log).toHaveBeenCalledWith('goal-author', 'implementation-target-absent-first-path', {
        path: 'src/missing.ts',
        candidateCount: 3,
        presence: 'uninspectable',
      });
      expect(log).toHaveBeenCalledWith('goal-author', 'implementation-target-narrowing', {
        authorRunId: expect.any(String),
        attempted: true,
        rule: null,
        candidateCount: 3,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('treats only repository-internal missing paths as observable new targets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-new-target-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'existing.ts'), 'export {};\n');
    const candidates = { ...facts, files: ['src/a.ts', 'src/b.ts'], genericSearchScope: false };
    const author = (input: string) => authorGoal(input, {
      ...deps,
      repositoryRoot: cwd,
      ground: async () => candidates,
    });

    const [newTarget, existingTarget, outsideTarget, multipleNewTargets, mixedTargets] = await Promise.all([
      author('Implement `src/new-target.ts`.'),
      author('Implement `src/existing.ts`.'),
      author('Implement `../outside.ts`.'),
      author('Implement `src/one.ts` and `src/nested/two.ts`.'),
      author('Implement `src/new-target.ts` using `src/existing.ts`.'),
    ]);

    for (const authored of [newTarget, multipleNewTargets, mixedTargets]) {
      expect(authored.document).not.toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
      expect(authored.document).toContain('id: implementation_anchor');
    }
    expect(newTarget.document).toContain('- Implementation target is a new repository file: src/new-target.ts');
    expect(multipleNewTargets.document).toContain('- Implementation target is a new repository file: src/one.ts');
    expect(multipleNewTargets.document).toContain('- Implementation target is a new repository file: src/nested/two.ts');
    expect(mixedTargets.document).toContain('- Implementation target is a new repository file: src/new-target.ts');
    expect(mixedTargets.document).not.toContain('- Implementation target is a new repository file: src/existing.ts');
    for (const authored of [existingTarget, outsideTarget]) {
      expect(authored.document).toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
    }
  });

  // 🆕 2026-09-24(🅞 표본) — 산문의 백틱 조각이 «새 구현 대상 파일»로 뽑히던 것.
  test('prose fragments with backticks, Hangul, parentheses or globs are not new repository targets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-new-token-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    const candidates = { ...facts, files: ['src/a.ts', 'src/b.ts'], genericSearchScope: false };
    const authored = await authorGoal(
      '원장(`docs/backlog/BACKLOG-x-2026-09-23.md`)이 docs/`·`*.md 를 말한다. Implement `src/new-file.ts`.',
      { ...deps, repositoryRoot: cwd, ground: async () => candidates },
    );
    const targets = authored.document.split('\n').filter((line) => line.startsWith('- Implementation target is a new repository file:'));
    expect(targets).toEqual(['- Implementation target is a new repository file: src/new-file.ts']);
  });

  test('does not classify dangling, outside, or file-parent symbolic-link paths as new repository targets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-new-target-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'goal-author-outside-target-'));
    temporaryDirectories.push(cwd, outside);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'regular-file'), 'not a directory\n');
    writeFileSync(join(cwd, 'src', 'linked-file-target'), 'not a directory\n');
    symlinkSync(join(outside, 'missing-parent'), join(cwd, 'src', 'dangling'));
    symlinkSync(outside, join(cwd, 'src', 'outside'));
    symlinkSync(join(cwd, 'src', 'linked-file-target'), join(cwd, 'src', 'linked-file'));
    const candidates = { ...facts, files: ['src/a.ts', 'src/b.ts'], genericSearchScope: false };
    const author = (input: string) => authorGoal(input, {
      ...deps,
      repositoryRoot: cwd,
      ground: async () => candidates,
    });

    const [dangling, outsideTarget, regularFileParent, linkedFileParent] = await Promise.all([
      author('Implement `src/dangling/new-target.ts`.'),
      author('Implement `src/outside/new-target.ts`.'),
      author('Implement `src/regular-file/new-target.ts`.'),
      author('Implement `src/linked-file/new-target.ts`.'),
    ]);

    for (const authored of [dangling, outsideTarget, regularFileParent, linkedFileParent]) {
      expect(authored.document).toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
      expect(authored.document).not.toContain('- Implementation target is a new repository file:');
    }
  });

  test('characterizes how askPathTokens currently drives selectImplementationTarget, absentFirstImplementationPath, firstAskPathTokenIndex, and newTargetFiles', async () => {
    // Characterization-only: authorGoal is the existing execution path that already
    // calls the four consumers. This plate does not export or rewire them.
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-ask-path-tokens-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'foo.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'src', 'bar.ts'), 'export {};\n');
    const candidates = { ...facts, files: ['src/foo.ts', 'src/bar.ts'], genericSearchScope: false };
    const author = (input: string) => authorGoal(input, {
      ...deps,
      repositoryRoot: cwd,
      ground: async () => candidates,
    });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const [
        colonLine,
        colonLineThenReal,
        realThenColonLine,
        refPath,
        backtickColonLine,
        backtickNormal,
        normalPath,
        directoryLess,
        directoryLessWithReal,
        brandNewThing,
        colonOnMissing,
      ] = await Promise.all([
        author('Implement src/foo.ts:2472'),
        author('Implement src/foo.ts:10 and src/bar.ts'),
        author('Implement src/foo.ts and src/bar.ts:20'),
        author('See ref:src/foo.ts'),
        author('Implement `src/foo.ts:2472`'),
        author('Implement `src/foo.ts`.'),
        author('Implement src/foo.ts'),
        author('Implement foo.ts'),
        author('Implement foo.ts and src/bar.ts'),
        author('Implement src/brand-new-thing.ts'),
        author('Implement src/brand-new-thing.ts:2472'),
      ]);

      // 경로:줄 — askPathTokens keeps the `:2472` suffix.
      // firstAskPathTokenIndex does not exact-match `src/foo.ts`.
      // selectImplementationTarget therefore does not narrow.
      // absentFirstImplementationPath reports the colon-line token as not-a-path.
      // newTargetFiles discards the colon-decorated token; it does not normalize to src/foo.ts.
      expect(colonLine.document).not.toContain('- Implementation target is a new repository file: src/foo.ts:2472');
      expect(colonLine.document).toContain('- Implementation target not narrowed: ask names src/foo.ts:2472 first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.');
      expect(colonLine.document).not.toContain('Implementation target narrowed');
      expect(colonLine.document).toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
      expect(log).toHaveBeenCalledWith('goal-author', 'implementation-target-absent-first-path', {
        path: 'src/foo.ts:2472',
        candidateCount: 2,
        presence: 'not-a-path',
      });

      // First token is 경로:줄, so absentFirstImplementationPath still fires even
      // though a later real path would match via firstAskPathTokenIndex.
      // selectImplementationTarget does not react.
      expect(colonLineThenReal.document).not.toContain('- Implementation target is a new repository file: src/foo.ts:10');
      expect(colonLineThenReal.document).not.toContain('- Implementation target is a new repository file: src/bar.ts');
      expect(colonLineThenReal.document).toContain('- Implementation target not narrowed: ask names src/foo.ts:10 first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.');
      expect(colonLineThenReal.document).not.toContain('Implementation target narrowed');

      // First token is a normal path, so firstAskPathTokenIndex matches `src/foo.ts`
      // and selectImplementationTarget narrows by rule two. The later 경로:줄 is
      // discarded by newTargetFiles (not normalized). absentFirstImplementationPath does not react.
      expect(realThenColonLine.document).toContain('- Implementation target narrowed by rule two: src/foo.ts');
      expect(realThenColonLine.document).not.toContain('- Implementation target is a new repository file: src/bar.ts:20');
      expect(realThenColonLine.document).not.toContain('Implementation target not narrowed');

      // ref:경로 — the `ref:` prefix stays on the token.
      // firstAskPathTokenIndex does not match `src/foo.ts`.
      // selectImplementationTarget does not narrow.
      // absentFirstImplementationPath still reacts as not-a-path; newTargetFiles discards the colon token.
      expect(refPath.document).not.toContain('- Implementation target is a new repository file: ref:src/foo.ts');
      expect(refPath.document).not.toContain('new repository file: ref:src/foo.ts');
      expect(refPath.document).toContain('- Implementation target not narrowed: ask names ref:src/foo.ts first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.');
      expect(refPath.document).not.toContain('Implementation target narrowed');

      // Backtick 경로:줄 — edge punctuation strips the backticks; same as bare 경로:줄.
      expect(backtickColonLine.document).not.toContain('- Implementation target is a new repository file: src/foo.ts:2472');
      expect(backtickColonLine.document).toContain('- Implementation target not narrowed: ask names src/foo.ts:2472 first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.');
      expect(backtickColonLine.document).not.toContain('Implementation target narrowed');

      // Ordinary missing path remains a new-file declaration (over-detection guard).
      expect(brandNewThing.document).toContain('- Implementation target is a new repository file: src/brand-new-thing.ts');
      expect(brandNewThing.document).not.toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);

      // Discard, do not normalize: a colon suffix on a missing path is not revived as that path.
      // The locator token is not a file path, so existence inspection does not apply.
      expect(colonOnMissing.document).not.toContain('- Implementation target is a new repository file: src/brand-new-thing.ts:2472');
      expect(colonOnMissing.document).not.toContain('- Implementation target is a new repository file: src/brand-new-thing.ts');
      expect(colonOnMissing.document).toContain('- Implementation target not narrowed: ask names src/brand-new-thing.ts:2472 first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.');
      expect(colonOnMissing.document).not.toContain('repository existence could not be inspected');
      expect(colonOnMissing.document).not.toContain('new-file target');

      // Backtick normal path — firstAskPathTokenIndex matches.
      // selectImplementationTarget narrows by rule two.
      // newTargetFiles and absentFirstImplementationPath do not react.
      expect(backtickNormal.document).toContain('- Implementation target narrowed by rule two: src/foo.ts');
      expect(backtickNormal.document).not.toContain('Implementation target is a new repository file:');
      expect(backtickNormal.document).not.toContain('Implementation target not narrowed');

      // Normal path — same consumer reactions as the backtick-stripped path.
      expect(normalPath.document).toContain('- Implementation target narrowed by rule two: src/foo.ts');
      expect(normalPath.document).not.toContain('Implementation target is a new repository file:');
      expect(normalPath.document).not.toContain('Implementation target not narrowed');

      // Directory-less filename is dropped by askPathTokens (no `/`).
      // selectImplementationTarget, absentFirstImplementationPath,
      // firstAskPathTokenIndex, and newTargetFiles all do not react.
      expect(directoryLess.document).toContain(`question: ${IMPLEMENTATION_TARGET_CLARIFICATION}`);
      expect(directoryLess.document).not.toContain('Implementation target narrowed');
      expect(directoryLess.document).not.toContain('Implementation target is a new repository file:');
      expect(directoryLess.document).not.toContain('Implementation target not narrowed');

      // Directory-less token is ignored; the later real path still reaches
      // firstAskPathTokenIndex and selectImplementationTarget as the sole match.
      expect(directoryLessWithReal.document).toContain('- Implementation target narrowed by rule two: src/bar.ts');
      expect(directoryLessWithReal.document).not.toContain('Implementation target not narrowed');
      expect(directoryLessWithReal.document).not.toContain('Implementation target is a new repository file:');
    } finally {
      log.mockRestore();
    }
  });

  test('splits absent-first wording by exists, missing, uninspectable, and not-a-path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-absent-first-presence-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'existing.ts'), 'export {};\n');
    const candidates = { ...facts, files: ['src/a.ts', 'src/b.ts'], genericSearchScope: false };
    const author = (input: string, repositoryRoot?: string) => authorGoal(input, {
      ...deps,
      repositoryRoot,
      ground: async () => candidates,
    });
    const existsLine = '- Implementation target not narrowed: ask names src/existing.ts first, and that path exists in the repository, but it lost grounded-candidate selection.';
    const missingLine = '- Implementation target not narrowed: ask names src/brand-new.ts first, which does not exist in the repository, so there is nothing to narrow; this is a new-file target.';
    const uninspectableLine = '- Implementation target not narrowed: ask names src/missing.ts first, but it is not among grounded candidates; repository existence could not be inspected.';
    const notAPathLine = '- Implementation target not narrowed: ask names src/foo.ts:2472 first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.';

    const [exists, missing, uninspectable, notAPath] = await Promise.all([
      author('Implement `src/existing.ts`.', cwd),
      author('Implement `src/brand-new.ts`.', cwd),
      author('Implement (`src/missing.ts`), then `src/foo.ts`.'),
      author('Implement src/foo.ts:2472', cwd),
    ]);

    expect(exists.document).toContain(existsLine);
    expect(exists.document).not.toContain(missingLine);
    expect(exists.document).not.toContain('new-file target');
    expect(exists.document).not.toContain('could not be inspected');
    expect(exists.document).not.toContain('not a file path');

    expect(missing.document).toContain(missingLine);
    expect(missing.document).toContain('- Implementation target is a new repository file: src/brand-new.ts');
    expect(missing.document).not.toContain(existsLine);
    expect(missing.document).not.toContain('lost grounded-candidate selection');
    expect(missing.document).not.toContain('could not be inspected');
    expect(missing.document).not.toContain('not a file path');

    expect(uninspectable.document).toContain(uninspectableLine);
    expect(uninspectable.document).not.toContain('lost grounded-candidate selection');
    expect(uninspectable.document).not.toContain('new-file target');
    expect(uninspectable.document).not.toContain('not a file path');

    expect(notAPath.document).toContain(notAPathLine);
    expect(notAPath.document).not.toContain('lost grounded-candidate selection');
    expect(notAPath.document).not.toContain('new-file target');
    expect(notAPath.document).not.toContain('could not be inspected');

    expect(new Set([existsLine, missingLine, uninspectableLine, notAPathLine]).size).toBe(4);
  });

  test('does not classify absolute or repository-escaping paths as new-file targets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-absent-first-escape-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'existing.ts'), 'export {};\n');
    const candidates = { ...facts, files: ['src/a.ts', 'src/b.ts'], genericSearchScope: false };
    const author = (input: string) => authorGoal(input, {
      ...deps,
      repositoryRoot: cwd,
      ground: async () => candidates,
    });
    const missingLine = '- Implementation target not narrowed: ask names src/brand-new.ts first, which does not exist in the repository, so there is nothing to narrow; this is a new-file target.';
    const escapedLine = '- Implementation target not narrowed: ask names src/../../outside.ts first, but it is not among grounded candidates; repository existence could not be inspected.';

    expect(classifyAbsentFirstPathPresence('src/brand-new.ts', cwd)).toBe('missing');
    expect(classifyAbsentFirstPathPresence('src/existing.ts', cwd)).toBe('exists');
    expect(classifyAbsentFirstPathPresence('/tmp/goal-author-outside.ts', cwd)).toBe('uninspectable');
    expect(classifyAbsentFirstPathPresence('../outside.ts', cwd)).toBe('uninspectable');
    expect(classifyAbsentFirstPathPresence('src/../../outside.ts', cwd)).toBe('uninspectable');

    // 🚨 ⛔ 어휘적 포함만으로는 «부재»를 단정할 수 없다 — 중간 조상이 저장소 «밖»으로 나가는
    //    심볼릭 링크면 resolve() 는 «안쪽처럼 보이는» 문자열을 내고 lstatSync 는 ENOENT 를 낸다.
    //    그 둘을 합쳐 'missing' 이라 하면 ***저장소 밖 경로를 「이 골이 만들 새 파일」이라고 자신 있게 말한다.***
    const outside = mkdtempSync(join(tmpdir(), 'goal-author-escape-'));
    temporaryDirectories.push(outside);
    symlinkSync(outside, join(cwd, 'escape-link'), 'dir');
    expect(classifyAbsentFirstPathPresence('escape-link/missing.ts', cwd)).toBe('uninspectable');
    // ⭐ 알려진 «음성» 대조 — 진짜 저장소 안의 부재는 «여전히» missing 이어야 한다(과탐 방지).
    expect(classifyAbsentFirstPathPresence('src/still-missing.ts', cwd)).toBe('missing');

    const symlinkEscapedLine = '- Implementation target not narrowed: ask names escape-link/missing.ts first, but it is not among grounded candidates; repository existence could not be inspected.';
    const [missing, escaped, symlinkEscaped] = await Promise.all([
      author('Implement `src/brand-new.ts`.'),
      author('Implement `src/../../outside.ts`.'),
      // ⛔ 분류기가 옳아도 그 «문면이 문서로 흐르는지»는 다른 값이다 — 배선을 직접 문다.
      author('Implement `escape-link/missing.ts`.'),
    ]);

    expect(missing.document).toContain(missingLine);
    expect(escaped.document).toContain(escapedLine);
    expect(escaped.document).not.toContain('new-file target');
    expect(escaped.document).not.toContain('lost grounded-candidate selection');
    expect(escaped.document).not.toContain(missingLine);
    // 🚨 심볼릭 링크 이탈이 «저작된 문서»에서도 「새 파일 대상」으로 안 새는가.
    expect(symlinkEscaped.document).toContain(symlinkEscapedLine);
    expect(symlinkEscaped.document).not.toContain('new-file target');
    expect(symlinkEscaped.document).not.toContain(missingLine);
  });

  test('changes the grounded, invariant, and acceptance sections when clarification answers reauthor the same ask', async () => {
    const ask = '불변식 malformed marker: preserve the proven behavior.';
    const ambiguousEvidence = 'src/example.ts:42 — implementation must add the proven behavior.';
    const reauthorFacts = {
      ...facts,
      genericSearchScope: true,
      persistentEvidence: [ambiguousEvidence],
    };
    const section = (document: string, heading: string, nextHeading: string) => {
      const start = document.indexOf(heading);
      const end = document.indexOf(nextHeading, start);
      return document.slice(start, end);
    };
    const unanswered = await authorGoal(ask, {
      ...deps,
      ground: async () => reauthorFacts,
    });
    const answered = await authorGoal(ask, {
      ...deps,
      ground: async () => reauthorFacts,
      clarificationAnswers: {
        implementation_target: 'src/self-implement/goal-author.test.ts',
        preservation_contract: 'The existing failure contract remains unchanged.',
        preservation_ambiguity: 'Preserve the failure contract while implementing its explicit requirement.',
      },
    });
    const unansweredGrounding = section(unanswered.document, '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA');
    const answeredGrounding = section(answered.document, '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA');
    const unansweredAcceptance = section(unanswered.document, '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE');
    const answeredAcceptance = section(answered.document, '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE');
    const unansweredInvariants = section(unanswered.document, '## 불변식', '## 판정 신호');
    const answeredInvariants = section(answered.document, '## 불변식', '## 판정 신호');

    expect(answeredGrounding).not.toBe(unansweredGrounding);
    expect(answeredGrounding).toContain('- Clarification-grounded implementation target: src/self-implement/goal-author.test.ts');
    expect(answeredInvariants).not.toBe(unansweredInvariants);
    expect(unansweredInvariants).toBe('## 불변식\n- UNVERIFIABLE: Ask contains an invariant marker, but at least one entry did not match the required invariant format. source="불변식 malformed marker: preserve the proven behavior." truncated=false; required format: 불변식: <preservation statement>; corrected example: 불변식: src/example.ts remains unchanged.\n\n');
    expect(answeredInvariants).toEqual('## 불변식\n- Invariant candidate: Clarification-grounded preservation contract: The existing failure contract remains unchanged.\n\n');
    expect(answeredAcceptance).not.toBe(unansweredAcceptance);
    expect(answeredAcceptance.split('\n').filter((line) => line.startsWith('- Checkable clarification criterion:'))).toEqual([
      '- Checkable clarification criterion: resolve the preservation ambiguity according to: Preserve the failure contract while implementing its explicit requirement.',
    ]);
    expect(answered.document.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
    ]);
  });

  test('collapses short and long asks into closed evidence kinds without transcribing criteria into evidence descriptions', async () => {
    const shortRequested = ['short requested behavior'];
    const longRequested = [
      'first requested behavior', 'second requested behavior', 'third requested behavior',
      'fourth requested behavior', 'fifth requested behavior', 'sixth requested behavior',
    ];
    const author = (requested: string[]) => authorGoal(`Keep ${requested.length} requested criteria traceable.`, {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: requested, verbatimPreserved: true }),
    });
    const [short, long] = await Promise.all([author(shortRequested), author(longRequested)]);
    const acceptanceLines = (document: string) => document.slice(
      document.indexOf('## ACCEPTANCE CRITERIA'), document.indexOf('## REQUIRED EVIDENCE'),
    ).split('\n').filter((line) => line.startsWith('- Checkable '));
    const evidenceEntries = (document: string) => document.slice(
      document.indexOf('## REQUIRED EVIDENCE'), document.indexOf('## TRACED PATHS'),
    ).split('\n').flatMap((line) => {
      const match = /^- \[([^\]]+)] (.+)$/.exec(line);
      return match ? [{ tag: match[1], description: match[2].split(REQUIRED_EVIDENCE_COMMAND_SEPARATOR, 1)[0]!.trimEnd() }] : [];
    });
    const shortCriteria = acceptanceLines(short.document);
    const longCriteria = acceptanceLines(long.document);
    const shortEvidence = evidenceEntries(short.document);
    const longEvidence = evidenceEntries(long.document);

    // ⛔ 2026-08-11 72차: 계약에 «배선» 기준이 하나 늘었다(B5) — 접지된 코드 후보가 있고
    //   ask 가 문서만 가리키지 않으면 «항상» 붙는다. 태그 순서는 EVIDENCE_KIND_DESCRIPTIONS 가 정한다.
    expect(shortCriteria).toEqual([
      '- Checkable requested criterion: short requested behavior',
      IMPLEMENT_PRESERVATION_REFERENCE,
      WIRING_CRITERION_LINE,   // ⛔ 문자열 복사 금지 — 배포 상수를 문다(복사본은 소스가 바뀌어도 조용히 낡는다)
    ]);
    expect(longCriteria).toEqual([
      ...longRequested.map((item) => `- Checkable requested criterion: ${item}`),
      IMPLEMENT_PRESERVATION_REFERENCE,
      WIRING_CRITERION_LINE,   // ⛔ 문자열 복사 금지 — 배포 상수를 문다(복사본은 소스가 바뀌어도 조용히 낡는다)
    ]);
    expect(shortCriteria).not.toEqual(longCriteria);
    expect(shortEvidence).toEqual(longEvidence);
    expect(longEvidence).toEqual([
      { tag: 'requested', description: 'Evidence that the requested acceptance criteria are met as a group.' },
      { tag: 'preservation', description: 'Evidence that the grounded preservation criteria remain true as a group.' },
      { tag: 'wiring', description: 'Evidence that the changed unit is reached from an existing execution path: name the caller (file and function) and show that call in the diff.' },
    ]);
    expect(new Set(longCriteria)).not.toEqual(new Set(longEvidence.map(({ description }) => description)));
    for (const { description } of longEvidence) {
      expect(longCriteria).not.toContain(`- Checkable requested criterion: ${description}`);
      expect(longCriteria).not.toContain(`- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${description}`);
    }
    expect(short.document.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
    ]);
  });

  test('adds classified requested evidence counts without changing closed tags and omits default-only information', async () => {
    const author = (checklist: string[]) => authorGoal('Render classified evidence information.', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist, verbatimPreserved: true }),
    });
    const evidenceSection = (document: string) => document.slice(
      document.indexOf('## REQUIRED EVIDENCE'), document.indexOf('## TRACED PATHS'),
    );
    const tags = (section: string) => Array.from(section.matchAll(/^- \[([^\]]+)]/gm), ([, tag]) => tag);
    const [classified, defaultOnly] = await Promise.all([
      author([
        'run bun test test/goal-author-runtime.test.ts',
        'run bun test test/goal-author-lint-cli.test.ts',
        'run bun test test/goal-author-clarify-cli.test.ts',
        'query elanous logs for the emitted event',
      ]),
      author(['preserve ordinary behavior']),
    ]);
    const classifiedEvidence = evidenceSection(classified.document);
    const defaultEvidence = evidenceSection(defaultOnly.document);

    expect(tags(classifiedEvidence)).toEqual(['requested', 'preservation', 'wiring']);
    expect(tags(defaultEvidence)).toEqual(['requested', 'preservation', 'wiring']);
    expect(classifiedEvidence).toContain('- Information: acceptance-criterion evidence kinds: test 3, log 1.');
    expect(defaultEvidence).not.toContain('acceptance-criterion evidence kinds:');
  });

  test('keeps transcription correct when the verbatim ask imitates all eight section names', async () => {
    const criterion = 'retain the assembly-owned acceptance criterion.';
    const nineSectionAsk = [
      'The ask quotes every generated section name without becoming document structure.',
      '## PROBLEM',
      '## WHAT TO BUILD',
      '## ACCEPTANCE CRITERIA',
      '## REQUIRED EVIDENCE',
      '## TRACED PATHS',
      '## SCOPE BOUNDARY',
      '## 답하지 못하는 것',
      '## 불변식',
      '## 판정 신호',
    ].join('\n');

    const authored = await authorGoal(nineSectionAsk, {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: [criterion], verbatimPreserved: true }),
    });

    expect(authored.document).toContain(nineSectionAsk);
    expect(authored.document).toContain(`- Checkable requested criterion: ${criterion}`);
    expect(authored.document).not.toContain(`- UNTRANSCRIBED requested criterion: ${criterion}`);
    expect(lintGoalFile(authored.document, 'main')).not.toContainEqual(expect.objectContaining({ tag: 'required-blocks' }));
  });

  test('counts constraint markers across every authored constraint section while excluding provenance', () => {
    const askWithMarkers = '해야 한다. 하지 않는다. 일 때만. 기본값. 정확히 한 번.';
    const document = [
      '## WHAT TO BUILD',
      '해야 한다. 하지 않는다.',
      '## ACCEPTANCE CRITERIA',
      '일 때만. 기본값.',
      '## 불변식',
      '## ORIGINAL ASK',
      '```',
      askWithMarkers,
      '```',
    ].join('\n');

    expect(countMissingAuthoredConstraintMarkers(askWithMarkers, document)).toEqual({
      totalMarkers: 5,
      missingMarkers: 1,
    });
  });

  test('counts markers authored only in limitation and scope-boundary sections', () => {
    const resultFor = (askWithMarkers: string, authoredSections: string[]) => countMissingAuthoredConstraintMarkers(askWithMarkers, [
      ...authoredSections,
      '## ORIGINAL ASK',
      '```',
      askWithMarkers,
      '```',
    ].join('\n'));

    // Before the authored-section expansion, each single-marker case returned missingMarkers: 1.
    expect(resultFor('해야 한다.', ['## 답하지 못하는 것', '해야 한다.'])).toEqual({ totalMarkers: 1, missingMarkers: 0 });
    expect(resultFor('하지 않는다.', ['## SCOPE BOUNDARY', '하지 않는다.'])).toEqual({ totalMarkers: 1, missingMarkers: 0 });
    expect(resultFor('해야 한다. 하지 않는다.', [
      '## 답하지 못하는 것',
      '해야 한다.',
      '## SCOPE BOUNDARY',
      '하지 않는다.',
    ])).toEqual({ totalMarkers: 2, missingMarkers: 0 });
  });

  test('keeps absent and provenance-only constraint markers missing', () => {
    const absent = countMissingAuthoredConstraintMarkers('해야 한다.', '## WHAT TO BUILD\nNo constraint marker.');
    const provenanceOnly = countMissingAuthoredConstraintMarkers('해야 한다.', [
      '## ORIGINAL ASK',
      '```',
      '해야 한다.',
      '```',
    ].join('\n'));

    // Both cases returned missingMarkers: 1 before the authored-section expansion and remain so after it.
    expect(absent).toEqual({ totalMarkers: 1, missingMarkers: 1 });
    expect(provenanceOnly).toEqual({ totalMarkers: 1, missingMarkers: 1 });
  });

  test('observes authored constraint-marker counts after writing without changing the document', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-constraint-markers-'));
    temporaryDirectories.push(cwd);
    const markerAsk = '이 저작은 해야 한다. 압축은 하지 않는다. 기본값. 정확히 한 번.';
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await writeAuthoredGoal(markerAsk, cwd, {
        ...deps,
        enhance: async (raw) => ({
          original: raw,
          checklist: ['저작은 해야 한다.'],
          verbatimPreserved: true,
        }),
      }, { now: () => STAMP_AT });

      expect(readFileSync(result.path, 'utf8')).toBe(result.authored.document);
      expect(log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'authored-constraint-marker-count')).toEqual([
        ['goal-author', 'authored-constraint-marker-count', {
          authorRunId: result.authored.authorRunId,
          totalMarkers: 4,
          missingMarkers: 3,
        }],
      ]);
      const assigned = log.mock.calls.find(([category, event]) => category === 'goal-author' && event === 'goal-id-assigned');
      expect(assigned?.[2]).toMatchObject({ authorRunId: result.authored.authorRunId });
    } finally {
      log.mockRestore();
    }
  });

  test('observes zero authored constraint-marker counts when the ask has no markers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-no-constraint-markers-'));
    temporaryDirectories.push(cwd);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await writeAuthoredGoal('표지가 없는 저작 요청입니다.', cwd, deps, { now: () => STAMP_AT });

      expect(readFileSync(result.path, 'utf8')).toBe(result.authored.document);
      expect(log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'authored-constraint-marker-count')).toEqual([
        ['goal-author', 'authored-constraint-marker-count', {
          authorRunId: result.authored.authorRunId,
          totalMarkers: 0,
          missingMarkers: 0,
        }],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('counts grounded paths across authored level-two sections with exact aggregate values', () => {
    const document = [
      '## PROBLEM',
      'src/one.ts',
      '## WHAT TO BUILD',
      'src/one.ts',
      'src/two.ts',
      '## ACCEPTANCE CRITERIA',
      'src/two.ts',
      'src/three.ts',
    ].join('\n');

    expect(countAuthoredGroundingPathSections(document, ['src/one.ts', 'src/two.ts', 'src/three.ts'])).toEqual({
      averageSectionsPerPath: 5 / 3,
      multiSectionPathCount: 2,
      countedPaths: 3,
    });
    expect(countAuthoredGroundingPathSections(document, ['', ''])).toEqual({
      averageSectionsPerPath: 0,
      multiSectionPathCount: 0,
      countedPaths: 0,
    });
  });

  test('observes grounded-path section counts after writing, including an empty filtered path list', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-grounding-path-sections-'));
    temporaryDirectories.push(cwd);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await writeAuthoredGoal('Grounded path observation.', cwd, {
        ...deps,
        ground: async () => ({ ...facts, files: ['', ''] }),
      }, { now: () => STAMP_AT });

      expect(readFileSync(result.path, 'utf8')).toBe(result.authored.document);
      expect(log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'authored-grounding-path-section-count')).toEqual([
        ['goal-author', 'authored-grounding-path-section-count', {
          authorRunId: result.authored.authorRunId,
          averageSectionsPerPath: 0,
          multiSectionPathCount: 0,
          countedPaths: 0,
        }],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('marks untranscribed criteria in their assembled section without throwing or accepting prefix and explanatory matches', () => {
    const shortCriterion = 'retain criterion';
    const acceptance = [
      '- Checkable requested criterion: retained criterion',
      '- Checkable requested criterion: retain criterion with a longer suffix',
      '- Explanation: retain criterion is only discussed here.',
    ];
    const boundary = ['- Scope-boundary candidates selected by document relevance:'];

    expect(markUntranscribedCriteria([shortCriterion, 'missing criterion'], acceptance, boundary)).toEqual([shortCriterion, 'missing criterion']);
    expect(acceptance).toContain(`- UNTRANSCRIBED requested criterion: ${shortCriterion}`);
    expect(acceptance).toContain('- UNTRANSCRIBED requested criterion: missing criterion');
  });

  test('recognizes only the canonical assembled criterion and boundary lines as transcribed', () => {
    const acceptanceCriterion = 'retain exact acceptance criterion';
    const boundaryCriterion = 'TUI 나 화면을 띄운다.';
    const acceptance = [`- Checkable requested criterion: ${acceptanceCriterion}`];
    const boundary = [`- Boundary decision: ${boundaryCriterion} — Reason: this exact live-surface form requires a surface outside the child worktree.`];

    expect(markUntranscribedCriteria([acceptanceCriterion, boundaryCriterion], acceptance, boundary)).toEqual([]);
  });

  test('moves only the four exact live-surface forms to scope boundary while retaining every other requested criterion', async () => {
    const codeCriterion = 'src/example.ts에 순수 코드 변경을 구현한다.';
    const liveCriteria = [
      'TUI 나 화면을 띄운다.',
      '키를 넣는다.',
      '화면을 눈으로 본다.',
      '실행 중인 외부 표면을 조회한다.',
    ];
    const authored = await authorGoal('Author code changes and live-surface checks.', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: [codeCriterion, ...liveCriteria], verbatimPreserved: true }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));
    const boundary = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'), authored.document.indexOf('## 불변식'));

    expect(acceptance).toContain(`- Checkable requested criterion: ${codeCriterion}`);
    expect(acceptance.match(/^- Checkable requested criterion: /gm)).toHaveLength(1);
    for (const criterion of liveCriteria) {
      expect(acceptance).not.toContain(criterion);
      expect(boundary).toContain(`- Boundary decision: ${criterion} — Reason: this exact live-surface form requires a surface outside the child worktree.`);
    }
    expect([...acceptance.matchAll(/src\/example\.ts에 순수 코드 변경을 구현한다\.|TUI 나 화면을 띄운다\.|키를 넣는다\.|화면을 눈으로 본다\.|실행 중인 외부 표면을 조회한다\./g)]).toHaveLength(1);
    expect([...boundary.matchAll(/src\/example\.ts에 순수 코드 변경을 구현한다\.|TUI 나 화면을 띄운다\.|키를 넣는다\.|화면을 눈으로 본다\.|실행 중인 외부 표면을 조회한다\./g)]).toHaveLength(4);
  });

  test('keeps quoted or documented live-surface phrases in acceptance criteria', async () => {
    const nonLiveCriteria = [
      '‘TUI 나 화면을 띄운다’는 문구를 문서화한다.',
      '‘키를 넣는다’는 문구를 문서화한다.',
      '‘화면을 눈으로 본다’는 문구를 문서화한다.',
      '‘실행 중인 외부 표면을 조회한다’는 문구를 문서화한다.',
    ];
    const authored = await authorGoal('Document live-surface wording without requiring live interaction.', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: nonLiveCriteria, verbatimPreserved: true }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));
    const boundary = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'), authored.document.indexOf('## 불변식'));

    expect(acceptance.match(/^- Checkable requested criterion: /gm)).toHaveLength(nonLiveCriteria.length);
    for (const criterion of nonLiveCriteria) {
      expect(acceptance).toContain(`- Checkable requested criterion: ${criterion}`);
      expect(boundary).not.toContain(criterion);
    }
    expect(boundary).not.toContain('Boundary decision:');
  });

  test('keeps pure-code requested-criterion counts nonzero across three authorings', async () => {
    const requested = ['src/example.ts에 순수 코드 변경을 구현한다.'];
    const authored = await Promise.all(Array.from({ length: 3 }, () => authorGoal('Author a pure code change.', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: requested, verbatimPreserved: true }),
    })));

    for (const result of authored) {
      const acceptance = result.document.slice(result.document.indexOf('## ACCEPTANCE CRITERIA'), result.document.indexOf('## REQUIRED EVIDENCE'));
      expect(acceptance.match(/^- Checkable requested criterion: /gm)).toHaveLength(1);
      expect(acceptance).toContain(`- Checkable requested criterion: ${requested[0]}`);
    }
  });

  test('omits the ask-provenance notice when no requested criterion was extracted', async () => {
    const authored = await authorGoal('Do not create an empty requested-criteria provenance contract.', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## TRACED PATHS'),
    );

    expect(acceptance).not.toContain('Ask-provenance notice:');
    expect(acceptance).toContain('- Checkable requested criterion: no additional acceptance criterion was extracted; retain the verbatim ask as the authority.');
  });

  test('keeps a conflicting requested criterion verbatim while a preservation observation declares requested priority', async () => {
    const requested = 'emit elapsed time in seconds';
    const preservation = 'src/self-implement/goal-author.ts — the current output ends with and no elapsed time output.';
    const authored = await authorGoal('Add elapsed-time output without reversing the ask.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [preservation] }),
      enhance: async (raw) => ({ original: raw, checklist: [requested], verbatimPreserved: true }),
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );

    expect(acceptance).toContain(`- Checkable requested criterion: ${requested}`);
    expect(acceptance).toContain(IMPLEMENT_PRESERVATION_REFERENCE);
    expect(authored.document).toContain(preservation);
    expect(acceptance).not.toContain('- Checkable requested criterion: do not emit elapsed time output');
    expect(acceptance).not.toContain('- Checkable requested criterion: retain no elapsed time output');
  });

  test('uses each Read-verified persistent evidence statement verbatim as a preservation criterion', async () => {
    const requested = ['deliver the requested behavior'];
    const evidence = [
      'src/example.ts: authorGoal receives this Read-verified call path.',
      'src/other.ts: writeAuthoredGoal persists only collision-safe goal files.',
    ];
    const authored = await authorGoal('Preserve grounded behavior.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
      enhance: async (raw) => ({ original: raw, checklist: requested, verbatimPreserved: true }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'));

    expect(acceptance).toContain(`- Checkable requested criterion: ${requested[0]}`);
    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
    for (const statement of evidence) expect(authored.document).toContain(`[unknown] ${statement}`);
    expect(acceptance).not.toContain('Clarification required before adding a preservation criterion');
    expect(acceptance).not.toContain(facts.codeFacts[0]);
  });

  test('keeps traced-path preservation wording once for multiple facts', async () => {
    const evidence = [
      'src/example.ts: authorGoal receives this Read-verified call path.',
      'src/other.ts: writeAuthoredGoal persists only collision-safe goal files.',
    ];
    const authored = await authorGoal('Preserve multiple grounded facts.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));

    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
  });

  test('keeps traced-path preservation wording once for one fact', async () => {
    const authored = await authorGoal('Preserve one grounded fact.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [facts.persistentEvidence[0]] }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));

    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
  });

  test('keeps non-traced preservation criteria fact-specific', async () => {
    const evidence = [
      'src/example.ts: authorGoal receives this Read-verified call path.',
      'src/other.ts: writeAuthoredGoal persists only collision-safe goal files.',
    ];
    const authored = await authorGoal('Preserve grounded behavior.', {
      ...deps,
      goalType: 'research',
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));

    expect(acceptance.match(/^- Checkable preservation criterion: /gm)).toHaveLength(evidence.length);
    for (const statement of evidence) {
      expect(acceptance).toContain(`- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${statement}`);
    }
  });

  test('keeps one traced-path preservation criterion alongside fact-specific rejected criteria', async () => {
    const tracedEvidence = 'src/example.ts: authorGoal receives this Read-verified call path.';
    const rejectedEvidence = [
      'src/other.ts declares Other and owns the 2-entry catalog',
      'src/third.ts declares Third and owns the 3-entry catalog',
    ];
    const authored = await authorGoal('Preserve mixed grounded behavior.', {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: ['Change src/other.ts Other', 'Change src/third.ts Third'],
        verbatimPreserved: true,
      }),
      ground: async () => ({ ...facts, persistentEvidence: [tracedEvidence, ...rejectedEvidence] }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));

    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
    expect(acceptance).toContain(`- Preservation criterion rejected: ${rejectedEvidence[0]} — overlaps requested coordinate(s): src/other.ts#Other.`);
    expect(acceptance).toContain(`- Preservation criterion rejected: ${rejectedEvidence[1]} — overlaps requested coordinate(s): src/third.ts#Third.`);
  });

  test('keeps one traced-path preservation criterion alongside fact-specific non-traced criteria', async () => {
    const tracedEvidence = 'src/example.ts: authorGoal receives this Read-verified call path.';
    const nonTracedEvidence = [
      'The existing response retains the first independent preservation contract.',
      'The existing response retains the second independent preservation contract.',
    ];
    const authored = await authorGoal('Preserve mixed grounded behavior.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [tracedEvidence, ...nonTracedEvidence] }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));

    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
    expect(acceptance.match(/^- Checkable preservation criterion: /gm)).toHaveLength(nonTracedEvidence.length + 1);
    for (const statement of nonTracedEvidence) {
      expect(acceptance).toContain(`- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${statement}`);
    }
  });

  test('omits traced-path preservation wording when every fact is rejected', async () => {
    const rejectedEvidence = [
      'src/other.ts declares Other and owns the 2-entry catalog',
      'src/third.ts declares Third and owns the 3-entry catalog',
    ];
    const authored = await authorGoal('Reject every grounded fact.', {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: ['Change src/other.ts Other', 'Change src/third.ts Third'],
        verbatimPreserved: true,
      }),
      ground: async () => ({ ...facts, persistentEvidence: rejectedEvidence }),
    });
    const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'), authored.document.indexOf('## REQUIRED EVIDENCE'));

    expect(acceptance).not.toContain(IMPLEMENT_PRESERVATION_REFERENCE);
    for (const statement of rejectedEvidence) expect(acceptance).toContain(`- Preservation criterion rejected: ${statement}`);
  });

  test('reports explicit unmet requirements in preservation evidence without reclassifying or changing preservation contracts', async () => {
    const ambiguousEvidence = 'src/example.ts — the author must surface the classifier result on this traced call path.';
    const compoundEvidence = 'src/example.ts — Preserve the compatibility contract, but the author must surface the classifier result.';
    const andCompoundEvidence = 'src/example.ts — the author must preserve X and add wiring.';
    const commaCompoundEvidence = 'src/example.ts — the author must retain X, surface classifier status, and implement wiring.';
    const orCompoundEvidence = 'src/example.ts — the author must keep X or wire the classifier result to the surface.';
    const compatibilityCompoundEvidence = 'src/example.ts — Preserve X, but the author must surface compatibility status.';
    const ordinaryEvidence = 'src/example.ts — the author must preserve the existing compatibility contract.';
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const [ambiguous, compound, andCompound, commaCompound, orCompound, compatibilityCompound, ordinary, failed] = await Promise.all([
        authorGoal('Report ambiguous preservation evidence.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [ambiguousEvidence] }),
        }),
        authorGoal('Report a separately stated unmet requirement alongside preservation evidence.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [compoundEvidence] }),
        }),
        authorGoal('Report an and-connected unmet wiring requirement alongside preservation evidence.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [andCompoundEvidence] }),
        }),
        authorGoal('Report comma-connected unmet requirements that share a preservation modal.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [commaCompoundEvidence] }),
        }),
        authorGoal('Report an or-connected unmet wiring requirement that shares a preservation modal.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [orCompoundEvidence] }),
        }),
        authorGoal('Report an unmet compatibility-status requirement alongside preservation evidence.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [compatibilityCompoundEvidence] }),
        }),
        authorGoal('Do not flag ordinary preservation evidence.', {
          ...deps,
          ground: async () => ({ ...facts, persistentEvidence: [ordinaryEvidence] }),
        }),
        authorGoal('Do not report unavailable grounding.', {
          ...deps,
          ground: async () => { throw new Error('grounding unavailable'); },
        }),
      ]);
      const acceptanceFor = (authored: { document: string }) => authored.document.slice(
        authored.document.indexOf('## ACCEPTANCE CRITERIA'),
        authored.document.indexOf('## REQUIRED EVIDENCE'),
      );
      const evidenceFor = (authored: { document: string }) => authored.document.slice(
        authored.document.indexOf('## REQUIRED EVIDENCE'),
        authored.document.indexOf('## TRACED PATHS'),
      );
      const preservationCriteriaFor = (authored: { document: string }) => acceptanceFor(authored)
        .match(/^- Checkable preservation criterion: .+$/gm) ?? [];
      const ambiguityClarificationsFor = (authored: { document: string }) => parseGoalDocumentClarifications(authored.document)
        .filter((clarification) => clarification.questionId === 'preservation_ambiguity');

      expect(preservationCriteriaFor(ambiguous)).toEqual([IMPLEMENT_PRESERVATION_REFERENCE]);
      expect(acceptanceFor(ambiguous)).toContain(`- Preservation ambiguity: this item remains a preservation criterion, but its explicit unmet requirement must be addressed rather than silently treated as preservation only: ${ambiguousEvidence}`);
      expect(acceptanceFor(ambiguous)).not.toContain(`- Checkable requested criterion: ${ambiguousEvidence}`);
      expect(evidenceFor(ambiguous)).toContain('- [preservation] Evidence that the grounded preservation criteria remain true as a group.');
      expect(ambiguityClarificationsFor(ambiguous)).toEqual([expect.objectContaining({
        question: expect.stringContaining(ambiguousEvidence),
        answer: expect.stringContaining('Persistent grounding evidence contains an explicit unmet requirement'),
        answered: false,
      })]);
      expect(ambiguityClarificationsFor(ambiguous)[0]?.answer).toContain('If nothing currently fails, provide the current contract as a command and its output, for example `bun test src/self-implement/goal-author.test.ts` → `0 fail`.');
      expect(preservationCriteriaFor(compound)).toEqual([IMPLEMENT_PRESERVATION_REFERENCE]);
      expect(acceptanceFor(compound)).toContain(`- Preservation ambiguity: this item remains a preservation criterion, but its explicit unmet requirement must be addressed rather than silently treated as preservation only: ${compoundEvidence}`);
      expect(acceptanceFor(compound)).not.toContain(`- Checkable requested criterion: ${compoundEvidence}`);
      expect(evidenceFor(compound)).toContain('- [preservation] Evidence that the grounded preservation criteria remain true as a group.');
      expect(ambiguityClarificationsFor(compound)).toEqual([expect.objectContaining({
        question: expect.stringContaining(compoundEvidence),
        answer: expect.stringContaining('Persistent grounding evidence contains an explicit unmet requirement'),
        answered: false,
      })]);
      for (const [evidence, authored] of [
        [andCompoundEvidence, andCompound],
        [commaCompoundEvidence, commaCompound],
        [orCompoundEvidence, orCompound],
        [compatibilityCompoundEvidence, compatibilityCompound],
      ] as const) {
        expect(preservationCriteriaFor(authored)).toEqual([IMPLEMENT_PRESERVATION_REFERENCE]);
        expect(acceptanceFor(authored)).toContain(`- Preservation ambiguity: this item remains a preservation criterion, but its explicit unmet requirement must be addressed rather than silently treated as preservation only: ${evidence}`);
        expect(acceptanceFor(authored)).not.toContain(`- Checkable requested criterion: ${evidence}`);
        expect(evidenceFor(authored)).toContain('- [preservation] Evidence that the grounded preservation criteria remain true as a group.');
        expect(ambiguityClarificationsFor(authored)).toEqual([expect.objectContaining({
          question: expect.stringContaining(evidence),
          answer: expect.stringContaining('Persistent grounding evidence contains an explicit unmet requirement'),
          answered: false,
        })]);
      }
      expect(preservationCriteriaFor(ordinary)).toEqual([IMPLEMENT_PRESERVATION_REFERENCE]);
      expect(acceptanceFor(ordinary)).not.toContain('Preservation ambiguity:');
      expect(ambiguityClarificationsFor(ordinary)).toEqual([]);
      expect(preservationCriteriaFor(failed)).toEqual([]);
      expect(acceptanceFor(failed)).not.toContain('Preservation ambiguity:');
      expect(ambiguityClarificationsFor(failed)).toEqual([]);
      expect(log).toHaveBeenCalledWith('goal-author', 'preservation-ambiguity', {
        count: 1,
        evidence: [ambiguousEvidence],
      });
      expect(log).toHaveBeenCalledWith('goal-author', 'preservation-ambiguity', {
        count: 1,
        evidence: [compoundEvidence],
      });
      for (const evidence of [andCompoundEvidence, commaCompoundEvidence, orCompoundEvidence, compatibilityCompoundEvidence]) {
        expect(log).toHaveBeenCalledWith('goal-author', 'preservation-ambiguity', {
          count: 1,
          evidence: [evidence],
        });
      }
      expect(log).toHaveBeenCalledWith('goal-author', 'preservation-ambiguity', {
        count: 0,
        evidence: [],
      });
    } finally {
      log.mockRestore();
    }
  });

  test('keeps the preservation clarification when persistent evidence is empty and emits none when grounding is absent or fails', async () => {
    const groundedWithoutPersistentEvidence = await authorGoal('Do not invent preservation targets.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
    });
    const ungrounded = await authorGoal('Do not invent ungrounded preservation targets.', {
      ...deps,
      ground: async () => noFacts,
    });
    const failedGrounding = await authorGoal('Do not invent failed-grounding preservation targets.', {
      ...deps,
      ground: async () => { throw new Error('grounding unavailable'); },
    });
    const groundedAcceptance = groundedWithoutPersistentEvidence.document.slice(groundedWithoutPersistentEvidence.document.indexOf('## ACCEPTANCE CRITERIA'));
    const tracedPaths = groundedWithoutPersistentEvidence.document.slice(groundedWithoutPersistentEvidence.document.indexOf('## TRACED PATHS'), groundedWithoutPersistentEvidence.document.indexOf('## SCOPE BOUNDARY'));
    const ungroundedTracedPaths = ungrounded.document.slice(ungrounded.document.indexOf('## TRACED PATHS'), ungrounded.document.indexOf('## SCOPE BOUNDARY'));
    const persistentChannelUnavailable = 'Evidence unavailable — grounding found 6 categorized evidence items, but no persistent evidence; only the persistent channel is empty. Strengthening the ask\'s prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
    const completeUnavailable = 'Evidence unavailable — grounding found no persistent evidence and the cause remains undifferentiated. Grounding needs behavior and causation, not only locations: state what the target code does today and why that is a problem, and name a function, constant, or type that the target file exports. A pure-addition ask ("also record field X") often fails here because it names no current behavior to ground. Re-authoring the same input may also produce different evidence, but try that first. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
    expect(tracedPaths).toBe(`## TRACED PATHS\n- ${persistentChannelUnavailable}\n\n`);
    expect(ungroundedTracedPaths).toBe(`## TRACED PATHS\n- ${completeUnavailable}\n\n`);
    const fallbackFindings = lintGoalFile(groundedWithoutPersistentEvidence.document, 'main', { readReferencedFile: () => null });
    const completeUnavailableFindings = lintGoalFile(ungrounded.document, 'main', { readReferencedFile: () => null });
    const researchDocument = groundedWithoutPersistentEvidence.document.replace('- GoalType: implement', '- GoalType: research');
    const researchFindings = lintGoalFile(researchDocument, 'main', { readReferencedFile: () => null });
    expect(tracedPathReferences(groundedWithoutPersistentEvidence.document)).toEqual([]);
    expect(fallbackFindings).toContainEqual(expect.objectContaining({
      level: 'ERROR',
      tag: 'grounding-evidence',
      message: persistentChannelUnavailable,
    }));
    expect(completeUnavailableFindings).toContainEqual(expect.objectContaining({
      level: 'ERROR',
      tag: 'grounding-evidence',
      message: completeUnavailable,
    }));
    expect(researchFindings).toContainEqual(expect.objectContaining({
      level: 'WARN',
      tag: 'grounding-evidence',
      message: expect.stringContaining('GoalType research does not require ## TRACED PATHS.'),
    }));
    expect(researchFindings).not.toContainEqual(expect.objectContaining({
      level: 'ERROR',
      tag: 'grounding-evidence',
    }));
    expect(fallbackFindings).not.toContainEqual(expect.objectContaining({
      tag: 'traced-path',
      message: expect.stringContaining('does not exist: Evidence unavailable'),
    }));
    expect(groundedAcceptance).toContain('Clarification required before adding a preservation criterion');
    expect(groundedAcceptance).not.toContain('Checkable preservation criterion:');

    for (const authored of [ungrounded, failedGrounding]) {
      const acceptance = authored.document.slice(authored.document.indexOf('## ACCEPTANCE CRITERIA'));
      expect(acceptance).not.toContain('Clarification required before adding a preservation criterion');
      expect(acceptance).not.toContain('Checkable preservation criterion:');
    }
  });

  test('uses TRACED PATHS as the sole implementation-goal owner of multiple persistent evidence lines', async () => {
    const evidence = [
      'src/example.ts:42 — Read-verified persistent evidence.',
      'src/other.ts:7 — A second Read-verified completion statement.',
    ];
    const authored = await authorGoal('Keep persistent traced paths.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
    });
    const problem = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('## WHAT TO BUILD'));
    const tracedPaths = authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'));

    expect(problem).toContain('Persistent grounding evidence is listed in the traced-path section below.');
    expect(tracedPaths).toBe(`## TRACED PATHS\n${evidence.map((line, index) => `${index + 1}. [unknown] ${line}`).join('\n')}\n\n`);
    for (const line of evidence) expect(authored.document.split(line)).toHaveLength(2);
    expect(lintGoalFile(authored.document, 'main', { readReferencedFile: () => null }))
      .not.toContainEqual(expect.objectContaining({ tag: 'grounding-evidence' }));
  });

  test('retains verbatim persistent evidence in PROBLEM for research goals without TRACED PATHS', async () => {
    const evidence = [
      'src/example.ts:42 — Read-verified persistent evidence.',
      'src/other.ts:7 — A second Read-verified completion statement.',
    ];
    const authored = await authorGoal('Keep research grounding evidence.', {
      ...deps,
      goalType: 'research',
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
    });
    const problem = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('## WHAT TO BUILD'));

    expect(authored.document).not.toContain('## TRACED PATHS');
    expect(problem).toContain('Persistent grounding evidence (verbatim Read-verified completion statements):');
    for (const line of evidence) {
      expect(problem).toContain(line);
      expect(authored.document.split(line)).toHaveLength(3);
    }
    expect(authored.document.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
    ]);
    expect(Array.from(lintGoalFile(authored.document, 'main'))).toEqual([
      {
        level: 'WARN',
        tag: 'boundary-size',
        message: '## SCOPE BOUNDARY contains unselected scope-boundary candidates; select decisions before evaluating boundary size',
      },
    ]);
  });

  test('moves constant acceptance and completion-summary instructions to the harness policy', async () => {
    const authored = await authorGoal(ask, deps);
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );
    const requiredEvidence = authored.document.slice(
      authored.document.indexOf('## REQUIRED EVIDENCE'),
      authored.document.indexOf('## TRACED PATHS'),
    );
    const requestedEvidence = 'In the child completion summary, write `EVIDENCE: [requested] <claim> || <verify command>`.';
    const preservationEvidence = 'In the child completion summary, write `EVIDENCE: [preservation] <claim> || <verify command>`.';
    const resultInstruction = 'Immediately next, write `RESULT: <the one-line result from that verify command>`.';
    const movedInstructions = [
      'If this change touches code: name the focused test file(s) it adds or touches, run only those, and report each summary-line pass count. If it does not touch code: name the artifact produced and the command or query that shows it exists.',
      'Verify by breaking it: change the one rule that matters for THIS goal, show the named check fails, restore it, show it passes. Report the failing check verbatim. If nothing can be broken, say why in one line rather than skipping this.',
      EVIDENCE_LOCATION_REQUIREMENT,
      requestedEvidence,
      preservationEvidence,
      resultInstruction,
      'Fill `<claim>` with what this tag proves and `<verify command>` with the command or query that reproduces it; neither may be empty.',
    ];

    const childInstruction = applyHarnessPolicy('implement this goal', GOAL_RULES_POLICY.join('\n'));
    expect(childInstruction).toBe([
      ...GOAL_RULES_POLICY,
      '',
      'implement this goal',
    ].join('\n'));
    expect(childInstruction).toContain(`${requestedEvidence}\n${resultInstruction}\n${preservationEvidence}\n${resultInstruction}`);

    expect(GOAL_RULES_POLICY.slice(0, 6)).toEqual([
      '- Do not run the whole test suite. If tests apply, name the focused file(s) and read only each summary line; a full suite can exhaust the implementer context window.',
      '- Do not infer a code path from a symbol grep. Trace a candidate before naming it as an implementation target.',
      '- Do not create a planner, milestones, steps, task decomposition, worktree, PR, mission, daemon call, or dev-pipeline hand-off; this artifact is authoring only.',
      '- Do not write an acceptance criterion that cannot hold at the same time as another one. Naming a field to add while demanding that same return value stay completely unchanged is a trap, not a contract: name the fields and values that must stay identical.',
      '- Do not fabricate repository evidence. Facts absent from grounding remain unverified.',
      '- Do not replace, rewrite, summarize, truncate, translate, or clean up the verbatim ask.',
    ]);
    for (const instruction of movedInstructions) {
      expect(GOAL_RULES_POLICY.some((policy) => policy.includes(instruction))).toBe(true);
      expect(acceptance).not.toContain(instruction);
      expect(requiredEvidence).not.toContain(instruction);
    }
    expect(requiredEvidence).toContain('- [requested] Evidence that the requested acceptance criteria are met as a group.');
    expect(requiredEvidence).toContain('- [preservation] Evidence that the grounded preservation criteria remain true as a group.');
  });

  test('emits an always-present SCOPE BOUNDARY block with candidate count but not candidate bodies, or an honest empty-channel marker', async () => {
    const withDocumentFacts = await authorGoal('Use adjacent document work as a scope-boundary candidate.', deps);
    const boundaryWithCandidates = withDocumentFacts.document.slice(withDocumentFacts.document.indexOf('## SCOPE BOUNDARY'));
    const whatToBuild = withDocumentFacts.document.slice(
      withDocumentFacts.document.indexOf('## WHAT TO BUILD'),
      withDocumentFacts.document.indexOf('## ACCEPTANCE CRITERIA'),
    );
    expect(boundaryWithCandidates).toContain('Scope-boundary candidates selected by document relevance:');
    expect(boundaryWithCandidates).toContain('1 scope-boundary candidate(s) were selected by document relevance; their identifiers are retained in the `scope-boundary-candidates` observation.');
    expect(boundaryWithCandidates).not.toContain('docs/example.md');
    expect(boundaryWithCandidates).not.toContain('Example author contract.');
    expect(whatToBuild).not.toContain('Scope-boundary candidates selected by document relevance:');
    expect(withDocumentFacts.document.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
    ]);

    const withoutDocumentFacts = await authorGoal('Do not create an empty scope-boundary section.', {
      ...deps,
      ground: async () => ({ ...facts, documentFacts: [] }),
    });
    const emptyBoundary = withoutDocumentFacts.document.slice(withoutDocumentFacts.document.indexOf('## SCOPE BOUNDARY'));
    expect(emptyBoundary).toContain('SCOPE-BOUNDARY-NOT-GROUNDED — No qualifying scope-boundary candidates were produced from the document channel.');
    expect(emptyBoundary).not.toContain('a human decides whether to adopt them as this goal’s boundary');
  });

  test('observes selected scope-boundary candidate paths without rendering their bodies', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const authored = await authorGoal('Observe adjacent scope-boundary candidates.', deps);
      const boundary = authored.document.slice(
        authored.document.indexOf('## SCOPE BOUNDARY'),
        authored.document.indexOf('## 불변식'),
      );

      expect(boundary).not.toContain('docs/example.md');
      expect(log).toHaveBeenCalledWith('goal-author', 'scope-boundary-candidates', {
        count: 1,
        candidatePaths: ['docs/example.md'],
        boundaryDecisionCount: 0,
        source: 'documentFacts',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('renders author boundary markers as decisions while retaining document candidates', async () => {
    const authored = await authorGoal('경계: src/self-implement/goal-author.ts와 이 회귀 테스트만 바꾼다.', deps);
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );

    expect(boundary).toContain('- Boundary decision: src/self-implement/goal-author.ts와 이 회귀 테스트만 바꾼다.');
    expect(boundary).toContain('Scope-boundary candidates selected by document relevance:');
    expect(boundary).toContain('1 scope-boundary candidate(s) were selected by document relevance');
    expect(boundary).not.toContain('docs/example.md');
  });

  test('reports zero author boundary decisions when no boundary marker is supplied', async () => {
    const authored = await authorGoal('일반 산문에서 경계 크기 경고를 설명하지만 정식 표지는 쓰지 않는다.', deps);
    const boundary = authored.document.slice(
      authored.document.indexOf('## SCOPE BOUNDARY'),
      authored.document.indexOf('## 불변식'),
    );
    expect(boundary).toContain('Scope-boundary candidates selected by document relevance:');
    expect(boundary).not.toContain('- Boundary decision:');
  });

  test('marks a completed but empty document channel as scope-boundary NOT-GROUNDED', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const authored = await authorGoal('Observe an empty document channel.', {
        ...deps,
        ground: async () => ({ ...noFacts, grounded: false }),
      });
      expect(authored.document).not.toContain('Scope-boundary candidates selected by document relevance:');
      expect(authored.document).toContain('SCOPE-BOUNDARY-NOT-GROUNDED — No qualifying scope-boundary candidates were produced from the document channel.');
      expect(log).toHaveBeenCalledWith('goal-author', 'scope-boundary-candidates', {
        count: 0,
        candidatePaths: [],
        boundaryDecisionCount: 0,
        source: 'documentFacts',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('marks failed grounding as scope-boundary NOT-GROUNDED without conflating it with an empty document channel', async () => {
    const authored = await authorGoal('Distinguish failed scope-boundary grounding.', {
      ...deps,
      ground: async () => { throw new Error('grounding unavailable'); },
    });

    expect(authored.document).toContain('SCOPE-BOUNDARY-NOT-GROUNDED — Grounding failed before scope-boundary candidates could be produced.');
    expect(authored.document).not.toContain('No qualifying scope-boundary candidates were produced from the document channel.');
  });

  test('keeps only relevant document boundaries with one-line reasons and warns when general terms make absence unknown', async () => {
    const documentFacts = [
      'docs/goal-author-boundaries.md', 'docs/goal-author-search.md', 'docs/author-contract.md',
      'docs/goal-author-history.md', 'docs/goal-author-output.md', 'docs/irrelevant-overview.md',
      'docs/another-unrelated.md', 'docs/guide.md', 'docs/plan.md', 'docs/notes.md', 'docs/index.md', 'docs/misc.md',
    ];
    const authored = await authorGoal('Improve long-running scope-boundary candidates.', {
      ...deps,
      ground: async () => ({
        ...facts, documentFacts, searchTerms: ['goal-author', 'author'], genericSearchScope: true,
        documentMatches: [
          { path: 'docs/goal-author-boundaries.md', score: 22, matchedTerms: ['goal-author', 'author'], excerpt: 'Explains author scope boundaries.' },
          { path: 'docs/goal-author-history.md', score: 21, matchedTerms: ['goal-author', 'author'], excerpt: 'Records author boundary decisions.' },
          { path: 'docs/irrelevant-overview.md', score: 4, matchedTerms: ['author'], excerpt: 'A broad overview.' },
        ],
      }),
    });
    const whatToBuild = authored.document.slice(authored.document.indexOf('## WHAT TO BUILD'), authored.document.indexOf('## ACCEPTANCE CRITERIA'));
    const boundary = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'));

    expect(whatToBuild).toContain('Search-scope notice: the ask contains no repository-specific identifier');
    expect(boundary).toContain('2 scope-boundary candidate(s) were selected by document relevance');
    expect(boundary).not.toContain('docs/goal-author-boundaries.md');
    expect(boundary).not.toContain('docs/goal-author-history.md');
    expect(boundary).not.toContain('docs/irrelevant-overview.md');
  });

  // ⛔ **왜 이 테스트가 있나**(인수 시 뮤테이션이 찾은 구멍 · 2026-07-30): `GENERIC_DOCUMENT_TERMS`
  //    필터를 지워도(`!GENERIC_DOCUMENT_TERMS.has(term)` → `true`) **한 건도 실패하지 않았다**
  //    ⇒ 일반어만 걸린 후보를 걸러내는 규칙이 회귀 가드 없이 들어왔다. 그 규칙이 이 절의 요지다 —
  //    `the`·`docs`·`code` 만 맞은 문서는 점수가 높아도 **경계 후보가 아니다**.
  test('일반어만 매치된 문서는 점수가 최고여도 경계 후보가 아니다', async () => {
    const authored = await authorGoal('Improve long-running scope-boundary candidates.', {
      ...deps,
      ground: async () => ({
        ...facts,
        documentFacts: ['docs/generic-only.md', 'docs/goal-author-boundaries.md'],
        searchTerms: ['goal-author', 'docs'],
        documentMatches: [
          // ⚠️ 점수가 **더 높다** — 임계로는 안 걸린다. 일반어 필터만이 이것을 막는다.
          { path: 'docs/generic-only.md', score: 99, matchedTerms: ['docs', 'the', 'code'], excerpt: 'Generic words only.' },
          { path: 'docs/goal-author-boundaries.md', score: 90, matchedTerms: ['goal-author'], excerpt: 'Explains author scope boundaries.' },
        ],
      }),
    });
    const boundary = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'));

    expect(boundary).toContain('1 scope-boundary candidate(s) were selected by document relevance');
    expect(boundary).not.toContain('docs/generic-only.md');
    expect(boundary).not.toContain('docs/goal-author-boundaries.md');
  });

  test('한국어 문서 범용어만 매치된 문서는 점수가 최고여도 경계 후보가 아니다', async () => {
    const authored = await authorGoal('한국어 문서의 스코프 경계를 개선한다.', {
      ...deps,
      ground: async () => ({
        ...facts,
        documentFacts: ['docs/korean-generic-only.md', 'docs/goal-author-boundaries.md'],
        searchTerms: ['문서', '구현'],
        documentMatches: [
          { path: 'docs/korean-generic-only.md', score: 99, matchedTerms: ['문서', '구현', '테스트'], excerpt: '한국어 범용어만 포함한다.' },
          { path: 'docs/goal-author-boundaries.md', score: 90, matchedTerms: ['goal-author'], excerpt: 'Explains author scope boundaries.' },
        ],
      }),
    });
    const boundary = authored.document.slice(authored.document.indexOf('## SCOPE BOUNDARY'));

    expect(boundary).toContain('1 scope-boundary candidate(s) were selected by document relevance');
    expect(boundary).not.toContain('docs/korean-generic-only.md');
    expect(boundary).not.toContain('docs/goal-author-boundaries.md');
  });

  test('derives the general-search warning from grounded identifiers rather than a injected flag', async () => {
    const ask = 'Improve qzxvplm untraceable boundaries.';
    const grounded = await groundMissionInCodebase(ask, {
      searchTerms: async () => ['qzxvplm'], persistent: false, skillIndex: () => [], pickSkills: async () => [],
      recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    });
    const authored = await authorGoal(ask, {
      ground: async () => grounded,
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    expect(grounded.genericSearchScope).toBe(true);
    expect(authored.document).toContain('Search-scope notice: the ask contains no repository-specific identifier');
  });

  test('keeps skill documents in their contract channel and out of implementation candidates', async () => {
    const skillPath = '/Users/example/.claude/skills/elanous-logs/SKILL.md';
    const skillFact = '[skill:elanous-logs] Query cross-surface debug logs.';
    const authored = await authorGoal('Separate skill evidence from source candidates.', {
      ground: async () => ({
        ...facts,
        files: ['src/self-implement/goal-author.ts', skillPath],
        skillFacts: [skillFact],
      }),
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    const problem = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('## WHAT TO BUILD'));
    const whatToBuild = authored.document.slice(authored.document.indexOf('## WHAT TO BUILD'), authored.document.indexOf('## ACCEPTANCE CRITERIA'));

    expect(problem).not.toContain('Repository implementation-candidate evidence');
    expect(problem).not.toContain('Skill evidence (skill contract facts):');
    expect(problem).not.toContain(skillFact);
    expect(problem).toContain(`Grounding files not mentioned in ask (2): \`src/self-implement/goal-author.ts\`, \`${skillPath}\``);
    expect(whatToBuild).not.toContain('Candidate requiring path tracing:');
    expect(whatToBuild).toContain('Implementation target narrowed by rule one: src/self-implement/goal-author.ts');
    expect(whatToBuild).not.toContain(skillPath);
  });

  test('keeps skill documents in their contract channel when groundMissionInCodebase produces the mixed input', async () => {
    const skillPath = '/Users/example/.claude/skills/elanous-logs/SKILL.md';
    const sourcePath = 'src/self-implement/goal-author.ts';
    const skill: SkillIndexEntry = {
      name: 'elanous-logs', description: 'Query cross-surface debug logs.', triggers: [], extractedTriggers: [], triggerSource: 'none',
      autoTrigger: false, composes: [], skillDir: '/Users/example/.claude/skills/elanous-logs', rootDir: '/Users/example/.claude/skills',
    };
    const facts = await groundMissionInCodebase('Separate skill evidence from source candidates.', {
      searchTerms: async () => [],
      persistent: {
        runGoalLoop: async (ctx) => {
          await ctx.dispatchTool('Read', { file_path: sourcePath }, { callId: 'source', sessionId: ctx.sessionId, signal: ctx.signal });
          ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: `${sourcePath}: goal author renders this Read-verified source candidate separately from skill facts.` } });
          return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
        },
      },
      skillIndex: () => [skill], pickSkills: async () => ['elanous-logs'], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    });
    const authored = await authorGoal('Separate skill evidence from source candidates.', {
      ground: async () => facts,
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    const problem = authored.document.slice(authored.document.indexOf('## PROBLEM'), authored.document.indexOf('## WHAT TO BUILD'));
    const whatToBuild = authored.document.slice(authored.document.indexOf('## WHAT TO BUILD'), authored.document.indexOf('## ACCEPTANCE CRITERIA'));

    expect(facts.files).toContain(sourcePath);
    expect(facts.files).not.toContain(skillPath);
    expect(problem).toContain('Persistent grounding evidence is listed in the traced-path section below.');
    expect(authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY'))).toContain('src/self-implement/goal-author.ts');
    expect(problem).not.toContain('Skill evidence (skill contract facts):');
    expect(problem).not.toContain('[skill:elanous-logs] Query cross-surface debug logs.');
    expect(problem).not.toContain(skillPath);
    expect(whatToBuild).toContain('Candidate leads remain in the repository evidence above; do not select or implement them until the requested clarification traces a behavior and call path.');
    expect(whatToBuild).not.toContain('Candidate requiring path tracing: `src/self-implement/goal-author.ts`');
    expect(whatToBuild).not.toContain(skillPath);
  });

  test('derives a complete one-line summary from substantive request content while preserving the verbatim ask', async () => {
    const request = [
      'agent: author-123',
      'session: session-456',
      '  Implement   the requested   goal summary behavior with whitespace normalization and a deliberately long trailing detail  ',
      'submitted: today',
    ].join('\n');
    const authored = await authorGoal(request, deps);
    const firstLine = authored.document.split('\n', 1)[0];
    expect(firstLine).toBe('Implement the requested goal summary behavior with whitespace normalization and a deliberately long trailing detail');
    expect(Array.from(firstLine)).toHaveLength(115);
    expect(firstLine).not.toContain('\n');
    expect(firstLine).not.toMatch(/^(agent|session|submitted):/i);
    const verbatimStart = authored.document.indexOf('Original ask (verbatim, unmodified):');
    const verbatimEnd = authored.document.indexOf('\n- Candidate requiring path tracing:', verbatimStart);
    expect(authored.document.slice(verbatimStart, verbatimEnd)).toContain(request);
  });

  test('uses distinct request content rather than repeated structured headers for goal summaries', async () => {
    const aggregator = await authorGoal(['agent: author-123', 'Context:', 'replace the old aggregator later', '## 요청', 'Swap the aggregator retry strategy'].join('\n'), deps);
    const grounding = await authorGoal(['agent: author-456', 'Context:', 'collect repository facts later', 'Request:', 'Add three grounding sources'].join('\n'), deps);
    const aggregatorSummary = aggregator.document.split('\n', 1)[0];
    const groundingSummary = grounding.document.split('\n', 1)[0];
    expect(aggregatorSummary).toBe('Swap the aggregator retry strategy');
    expect(groundingSummary).toBe('Add three grounding sources');
    expect(aggregatorSummary).not.toBe(groundingSummary);
    expect(aggregatorSummary).not.toMatch(/^(?:목표|요청|context|request):?$/i);
    expect(groundingSummary).not.toMatch(/^(?:목표|요청|context|request):?$/i);
  });

  test('uses labeled request content and falls back only when structured input has no substantive content', async () => {
    const inline = await authorGoal('목표: 실제 요청을 요약한다', deps);
    const request = await authorGoal(['Context:', 'background only', 'Request:', 'Extract the actual request'].join('\n'), deps);
    const headingsOnly = await authorGoal(['agent: author-123', '## 요청', '---', 'Context:'].join('\n'), deps);
    expect(inline.document.split('\n', 1)[0]).toBe('실제 요청을 요약한다');
    expect(request.document.split('\n', 1)[0]).toBe('Extract the actual request');
    expect(headingsOnly.document.split('\n', 1)[0]).toBe('Untitled goal request');
  });

  test('stops an empty goal section at the next section and prefers the later request section', async () => {
    const authored = await authorGoal(['Goal:', 'Context:', 'background', 'Request:', 'actual'].join('\n'), deps);
    expect(authored.document.split('\n', 1)[0]).toBe('actual');
  });

  test('retains substantive Markdown heading content as the summary', async () => {
    const english = await authorGoal('## Add retries', deps);
    const korean = await authorGoal('## 목표: 재시도 추가', deps);
    const englishSummary = english.document.split('\n', 1)[0];
    const koreanSummary = korean.document.split('\n', 1)[0];
    expect(englishSummary).toBe('Add retries');
    expect(koreanSummary).toBe('재시도 추가');
    expect(englishSummary).not.toBe('Untitled goal request');
    expect(koreanSummary).not.toBe('Untitled goal request');
  });

  test('uses a non-identity fallback summary when no request body remains after identity headers', async () => {
    for (const request of ['', '   \n\t ', 'agent: author-123', 'session: session-456\nagent: author-123\n  \t  ']) {
      const authored = await authorGoal(request, deps);
      const firstLine = authored.document.split('\n', 1)[0];
      expect(firstLine).toBe('Untitled goal request');
      expect(firstLine).not.toBe('');
      expect(firstLine).not.toMatch(/^(agent|session|submitted|authored-by|track|roadmap):/i);
      expect(authored.document).toContain(request);
    }
  });

  test('consults injected grounding and never fabricates a path when it returns nothing', async () => {
    let consulted = false;
    const authored = await authorGoal('thin ask', {
      ground: async () => { consulted = true; return noFacts; },
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    expect(consulted).toBe(true);
    expect(authored.document).toContain('Not grounded: grounding found no repository facts');
    expect(authored.document).not.toContain('src/example.ts');
  });

  test('fails soft on grounding and transcribes requested criteria without embedding harness policy', async () => {
    const failSoft = await authorGoal('grounding outage', {
      ground: async () => { throw new Error('grounding unavailable'); },
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    expect(failSoft.document).toContain('Not grounded: grounding failed');
    const withTrap = await authorGoal('impossible criterion', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: ['add a field while the return value is completely unchanged'], verbatimPreserved: true }),
    });
    expect(withTrap.document).toContain('add a field while the return value is completely unchanged');
    expect(withTrap.document).not.toContain('## RULES');
    // ⭐ 거부는 **좁아야** 한다: 추가 요구가 없는 "완전히 unchanged" 는 정상 계약이므로 통과한다.
    //    (넓게 잡으면 정상 골까지 거부한다 — 리뷰 지적 2026-07-28)
    const legitimate = await authorGoal('narrow rejection', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: ['the public API stays completely unchanged'], verbatimPreserved: true }),
    });
    expect(legitimate.document).toContain('the public API stays completely unchanged');

    // ⭐ 전사(轉寫) 계약: 요청에서 뽑힌 각 수용기준이 ACCEPTANCE 블록에 **그대로** 실린다.
    //    (종전 테스트는 "산출물이 요구를 충족했나" 를 LLM 으로 묻는 verifyCoverage 를 겨냥했는데,
    //     골 문서는 요구를 **서술**할 뿐 충족한 적이 없어 구체적 요청일수록 반드시 거부됐다.)
    const requested = ['0건일 때 이유를 함께 출력한다', 'stdout 형식을 바꾸지 않는다'];
    const transcribed = await authorGoal('coverage transcription', {
      ...deps,
      enhance: async (raw) => ({ original: raw, checklist: requested, verbatimPreserved: true }),
    });
    const acceptance = transcribed.document.slice(transcribed.document.indexOf('## ACCEPTANCE CRITERIA'));
    for (const item of requested) expect(acceptance).toContain(item);
  });

  test('writes only collision-safe files and touches no boundary beyond that one write', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    // ⭐ 부작용 부재를 **실제 경계**로 검사한다. 종전 테스트는 구현이 소비하지 않는
    //    `pipeline` spy 가 안 불린 것을 단언했는데, 호출 경로가 애초에 없어 **자명하게 통과**했다
    //    (Goodhart · 2026-07-28 리뷰 지적). 이제 쓰기 횟수와 산출 파일 수로 본다.
    let writes = 0;
    const countingDeps: GoalAuthorDeps = { ...deps, ground: async (raw) => { expect(raw).toBe(ask); return facts; } };
    const first = await writeAuthoredGoal(ask, cwd, countingDeps, {
      write: (path, document) => { writeFileSync(path, document, { flag: 'wx' }); writes += 1; },
    });
    const second = await writeAuthoredGoal(ask, cwd, countingDeps, {
      write: (path, document) => { writeFileSync(path, document, { flag: 'wx' }); writes += 1; },
    });
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path, 'utf8')).toContain(ask);
    expect(existsSync(second.path)).toBe(true);
    // 저작 두 번 = 성공한 쓰기 두 번. 그 밖의 파일은 만들지 않는다.
    // 저작 횟수 == 성공한 쓰기 == 산출 파일 수. 그 밖의 파일은 만들지 않는다.
    expect(writes).toBe(2);
    expect(readdirSync(join(cwd, 'docs', 'goals')).length).toBe(writes);
  });

  test('observes top-level ask-directory counts for Korean quantity words without changing authored documents', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-directory-count-'));
    temporaryDirectories.push(cwd);
    const target = join(cwd, 'fixtures', 'count-target');
    mkdirSync(join(target, 'child'), { recursive: true });
    writeFileSync(join(target, 'top-level.txt'), 'file');
    writeFileSync(join(target, 'child', 'nested.txt'), 'nested file');
    symlinkSync(join(target, 'top-level.txt'), join(target, 'linked-file'));
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const asks = ['모든', '무조건', '전부', '아래의'].map((quantity) => `${quantity} fixtures/count-target fixtures/ignored를 관측한다.`);
      for (const askWithQuantity of asks) {
        const result = await writeAuthoredGoal(askWithQuantity, cwd, deps, { now: () => STAMP_AT });
        expect(readFileSync(result.path, 'utf8')).toContain(askWithQuantity);
      }
      const counts = log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'ask-directory-count');

      expect(counts).toEqual(asks.map(() => ['goal-author', 'ask-directory-count', {
        path: 'fixtures/count-target',
        fileCount: 1,
        directoryCount: 1,
        symlinkCount: 1,
      }]));

      log.mockClear();
      await writeAuthoredGoal('fixtures/count-target에는 파일이 있다.', cwd, deps, { now: () => STAMP_AT });
      await writeAuthoredGoal('전부 fixtures/missing를 센다.', cwd, deps, { now: () => STAMP_AT });
      await writeAuthoredGoal('무조건 "fixtures/count-target"를 센다.', cwd, deps, { now: () => STAMP_AT });
      expect(log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'ask-directory-count')).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  test('forwards counted directory measurements to enhancement without adding them to the authored document', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-directory-measurement-'));
    temporaryDirectories.push(cwd);
    const target = join(cwd, 'fixtures', 'count-target');
    mkdirSync(join(target, 'child'), { recursive: true });
    writeFileSync(join(target, 'top-level.txt'), 'file');
    symlinkSync(join(target, 'top-level.txt'), join(target, 'linked-file'));
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const enhance = mock(async (raw: string, opts?: { directoryMeasurement?: string }) => ({
      original: raw,
      checklist: [],
      verbatimPreserved: true,
    }));
    try {
      const result = await writeAuthoredGoal('모든 fixtures/count-target 를 관측한다.', cwd, { ...deps, enhance }, { now: () => STAMP_AT });
      const forwarded = log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'ask-directory-measurement-forwarded');

      // ⊕ `groundedFacts` 가 늘었다(2026-08-08) — 접지 사실을 인핸싱에 넘겨 SCQA 요약을 만든다.
      //   이 단정의 의도는 여전히 「`directoryMeasurement` 가 전달된다」이고, 그 키가 여기 있다.
      const [enhancedAsk, enhancedOpts] = enhance.mock.calls[0]!;
      expect(enhancedAsk).toBe('모든 fixtures/count-target 를 관측한다.');
      expect(enhancedOpts?.directoryMeasurement).toBe('fixtures/count-target: top-level files 1, direct directories 1, symbolic links 1');
      expect(enhancedOpts).toMatchObject({ groundedFacts: facts.persistentEvidence });
      expect(forwarded).toEqual([['goal-author', 'ask-directory-measurement-forwarded', { count: 1 }]]);
      expect(readFileSync(result.path, 'utf8')).not.toContain('top-level files 1, direct directories 1, symbolic links 1');
    } finally {
      log.mockRestore();
    }
  });

  test('does not forward a directory measurement when the ask has no quantity word', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-no-directory-measurement-'));
    temporaryDirectories.push(cwd);
    const target = join(cwd, 'fixtures', 'count-target');
    mkdirSync(target, { recursive: true });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const enhance = mock(async (raw: string, opts?: { directoryMeasurement?: string }) => ({
      original: raw,
      checklist: [],
      verbatimPreserved: true,
    }));
    try {
      await writeAuthoredGoal('fixtures/count-target에는 파일이 있다.', cwd, { ...deps, enhance }, { now: () => STAMP_AT });
      const forwarded = log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'ask-directory-measurement-forwarded');

      // ⛔ 종전 기대는 `undefined` 였다 — 그때는 저작기가 인핸싱에 아무것도 안 넘겼다.
      //   이제 접지 사실은 «항상» 넘어가므로, 이 단정의 의도(「수량어가 없으면 directoryMeasurement 를
      //   전달하지 않는다」)는 ***그 키가 «없다»는 것***으로 유지한다.
      const [enhancedAsk, enhancedOpts] = enhance.mock.calls[0]!;
      expect(enhancedAsk).toBe('fixtures/count-target에는 파일이 있다.');
      expect(enhancedOpts).toMatchObject({ groundedFacts: facts.persistentEvidence });
      expect(enhancedOpts).not.toHaveProperty('directoryMeasurement');
      expect(forwarded).toEqual([['goal-author', 'ask-directory-measurement-forwarded', { count: 0 }]]);
    } finally {
      log.mockRestore();
    }
  });

  test('does not count directory paths that resolve through symlinks outside the repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-directory-boundary-'));
    const outside = mkdtempSync(join(tmpdir(), 'goal-author-directory-outside-'));
    temporaryDirectories.push(cwd, outside);
    const internal = join(cwd, 'fixtures', 'internal');
    mkdirSync(join(internal, 'child'), { recursive: true });
    writeFileSync(join(internal, 'inside.txt'), 'inside');
    writeFileSync(join(outside, 'outside.txt'), 'outside');
    mkdirSync(join(outside, 'nested'));
    writeFileSync(join(outside, 'nested', 'outside-nested.txt'), 'outside nested');
    symlinkSync(outside, join(cwd, 'fixtures', 'outside-link'));
    symlinkSync(outside, join(cwd, 'fixtures', 'middle-link'));
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      expect(existsSync(join(outside, 'nested', 'outside-nested.txt'))).toBe(true);
      await writeAuthoredGoal('모든 fixtures/outside-link 를 센다.', cwd, deps, { now: () => STAMP_AT });
      await writeAuthoredGoal('전부 fixtures/middle-link/nested 를 센다.', cwd, deps, { now: () => STAMP_AT });
      await writeAuthoredGoal('아래의 fixtures/internal 를 센다.', cwd, deps, { now: () => STAMP_AT });

      const counts = log.mock.calls.filter(([category, event]) => category === 'goal-author' && event === 'ask-directory-count');
      expect(counts).toEqual([['goal-author', 'ask-directory-count', {
        path: 'fixtures/internal',
        fileCount: 1,
        directoryCount: 1,
        symlinkCount: 0,
      }]]);
    } finally {
      log.mockRestore();
    }
  });

  /**
   * ⛔⭐⭐⭐ 계약이 «의도적으로» 뒤집혔다(대표 2026-08-08) — 이 테스트는 원래
   *   *"goal-context 를 PROBLEM 에 그대로 싣는다"* 를 물었다. 이제 ***싣지 않는다***.
   *
   * ⛔ 그래서 «지우지 않고» 새 계약으로 «뒤집어» 둔다 — 지우면 「수집은 여전히 도는가」를
   *   아무도 안 재게 된다(파일 열거·정렬·하위 디렉토리 배제는 «그대로» 살아 있어야 한다).
   * 🚨 그리고 이 테스트가 «어떻게 놓쳤는지»가 이 PR 의 교훈이다 — 계약을 바꾼 커밋이
   *   이 «테스트 파일»을 안 건드려서 `elanous self gate --changed` 가 아예 «안 돌렸다».
   *   ⇒ [T] 의 #7736(지워진 테스트는 「실패」가 아니라 「없음」)과 기전은 달라도 뿌리가 같다.
   */
  test('collects top-level goal-context Markdown but keeps it out of the authored document', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-context-'));
    temporaryDirectories.push(cwd);
    const context = join(cwd, 'docs', 'goal-context');
    mkdirSync(join(context, 'nested'), { recursive: true });
    writeFileSync(join(context, 'zeta.md'), '# Zeta\n\nunaltered zeta context');
    writeFileSync(join(context, 'alpha.md'), '# Alpha\n\nunaltered alpha context');
    writeFileSync(join(context, 'nested', 'ignored.md'), 'nested context must not be included');

    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    let document: string;
    // ⛔ `mockRestore()` 는 기록된 호출도 버린다 — 관측 판정은 «복원 전»에 읽는다.
    let placement: { items: number; chars: number; placement: string } | undefined;
    try {
      const result = await writeAuthoredGoal('Include mandatory authoring context.', cwd, deps, { now: () => STAMP_AT });
      document = result.authored.document;
      placement = log.mock.calls
        .find((call) => call[0] === 'goal-author' && call[1] === 'goal-context-placement')?.[2] as typeof placement;
    } finally {
      log.mockRestore();
    }

    expect(document).not.toContain('Mandatory goal-context reference knowledge (deterministic; not relevance-ranked):');
    expect(document).not.toContain('[goal-context:alpha.md]');
    expect(document).not.toContain('unaltered alpha context');
    expect(document).not.toContain('[goal-context:zeta.md]');
    expect(document).not.toContain('unaltered zeta context');
    expect(document).not.toContain('nested context must not be included');
    // ⭐ 수집 자체는 «그대로» 돈다 — 둘을 읽고 하위 디렉토리는 배제한다. 관측이 그것을 증명한다.
    // ⚠️ `items` 는 «파일 수»가 아니라 «렌더된 줄 수»다 — 파일당 4줄(표제·펜스·본문·펜스).
    //   ⇒ 파일 둘 = 8. 하위 디렉토리가 섞였다면 12가 된다.
    expect(placement).toMatchObject({ items: 8, placement: 'omitted' });
    expect(placement?.chars).toBeGreaterThan(0);
    // ⛔⭐ 무인 리뷰 지적(2026-08-08): 초판은 «총계»만 봐서 ***정렬 계약을 잃었다*** —
    //   원래 이 테스트가 `alpha.md` 가 `zeta.md` «앞»임을 물었다. 문서가 그것을 더는 못 보여 주므로
    //   수집기(`goalContextEvidence`)를 «직접» 불러 결정론적 파일명 순서를 못 박는다.
    //   🧩 이것이 이 PR 이 배운 형태다 — 「있던 것이 그대로 있나」를 총계로 재면 «없어진 줄»이 안 보인다.
    const collected = goalContextEvidence(cwd);
    const alphaAt = collected.findIndex((line) => line.includes('[goal-context:alpha.md]'));
    const zetaAt = collected.findIndex((line) => line.includes('[goal-context:zeta.md]'));
    expect(alphaAt).toBeGreaterThanOrEqual(0);
    expect(alphaAt).toBeLessThan(zetaAt);
    expect(collected.join('\n')).toContain('# Alpha\n\nunaltered alpha context');
    expect(collected.join('\n')).not.toContain('nested context must not be included');
  });

  test('continues authoring without goal-context when the directory is absent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-no-context-'));
    temporaryDirectories.push(cwd);

    const result = await writeAuthoredGoal('Author without optional local context.', cwd, deps, { now: () => STAMP_AT });

    expect(existsSync(result.path)).toBe(true);
    expect(result.authored.document).not.toContain('Mandatory goal-context reference knowledge');
    expect(result.authored.document).not.toContain('[goal-context:');
  });

  test('propagates non-ENOENT goal-context filesystem failures instead of authoring without required context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-invalid-context-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'goal-context'), 'not a directory');

    await expect(writeAuthoredGoal('Author with unreadable mandatory context.', cwd, deps, { now: () => STAMP_AT }))
      .rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  test('keeps a fenced suffix line inside the fence when scanning declaration candidates', () => {
    const document = [
      'visible before',
      '```ts',
      'fenced content',
      '```oops',
      'Port: 43999',
      '```',
      'visible after',
    ].join('\n');

    expect(linesOutsideFencedCode(document).map(({ text }) => text)).toEqual(['visible before', 'visible after']);
  });

  test('closes a promoted artifact launch declaration before preserving the identity tail', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-artifact-launch-tail-'));
    temporaryDirectories.push(cwd);
    const request = [
      '---',
      'agent: claude-code',
      'track: S',
      'session: session-456',
      'submitted: 2026-07-29 09:10 KST',
      '---',
      'Launch declaration identity-tail regression.',
      '',
      '## 산출물을 어떻게 켜나',
      'Port: 31415',
    ].join('\n');

    const result = await writeAuthoredGoal(request, cwd, deps, { now: () => STAMP_AT });
    const document = readFileSync(result.path, 'utf8');

    expect(parseArtifactLaunchDeclaration(document)).toEqual({ port: 31415, environment: [], errors: [] });
    expect(inspectArtifactLaunchDeclaration(document)).toMatchObject({
      declared: true,
      extracted: true,
      declaration: { port: 31415, environment: [], errors: [] },
      stoppedAt: { text: '## 검증 시나리오' },
    });
    expect(markdownSection(document, '산출물을 어떻게 켜나')).toBe('Port: 31415\n');
    expect(document).toContain('## 메타데이터\n\n---\nagent: claude-code\ntrack: S\nsession: session-456\nsubmitted: 2026-07-29 09:10 KST\n');
    expect(document.match(/^## 메타데이터$/gm)).toHaveLength(1);
    expect(verbatimOriginalAsk(document)).toBe(request);
  });

  test('writes a complete title, English-summary local-dated filename, and populated identity header', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const request = [
      '---',
      'agent: claude-code',
      'track: S',
      'session: session-456',
      'submitted: 2026-07-29 09:10 KST',
      '---',
      '한국어 Author 계약 42!',
    ].join('\n');
    const localDate = new Date(2026, 6, 29, 0, 30);
    const result = await writeAuthoredGoal(request, cwd, {
      ...deps,
      slugFn: async (goal) => { expect(goal).toBe('한국어 Author 계약 42!'); return 'readable-goal-author-contract'; },
    }, { now: () => localDate });
    const document = readFileSync(result.path, 'utf8');
    expect(document.split('\n', 1)[0]).toBe('한국어 Author 계약 42!');
    expect(result.path).toMatch(/GOAL-author-42-readable-goal-author-contract-[a-f0-9]{8}-2026-07-29\.md$/);
    expect(result.path).not.toContain('hangukeo');
    expect(result.path).not.toContain('gyeyak');
    // ⛔⭐ 머리말은 **파일 끝**이다 — 둘째 줄에 두면 `elanous dev --file` 이 그것을 PR 제목·브랜치명으로
    //   집는다(실측 2026-07-29: `track: S` 가 브랜치가 되어 자식이 어긋난 제목을 받고 런이 죽었다).
    // ⭐ 2026-08-09 — 「왜」 절이 «은퇴»했다(대표 · 파싱 0 · 읽는 표면 0). 머리 계약 자체는 그대로고,
    //   이제 머리 블록 «바로 뒤»에 첫 골 절이 온다. 그 순서가 깨지면 goalId 파싱이 죽는다.
    // ⛔ 이 단언이 「왜」 절의 재등장을 막는 자리다 — 정규식이 머리와 `## PROBLEM` 사이를 «붙여» 문다.
    expect(document).toMatch(/^한국어 Author 계약 42!\n- GoalId: [0-9a-f]{16}\n- RootIntent: 한국어 Author 계약 42!\n- GoalType: implement\n\n## PROBLEM\n/);
    expect(document).not.toContain('## 왜 이 골인가');
    expect(document.match(/^## .+$/gm)).toEqual([
      '## PROBLEM',
      '## WHAT TO BUILD',
      '## ACCEPTANCE CRITERIA',
      '## REQUIRED EVIDENCE',
      '## TRACED PATHS',
      '## SCOPE BOUNDARY',
      '## 답하지 못하는 것',
      '## 불변식',
      '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
      '## 메타데이터',
    ]);
    expect(document).toEndWith([
      '',
      '---',
      'agent: claude-code',
      'track: S',
      'session: session-456',
      'submitted: 2026-07-29 09:10 KST',
      '',
    ].join('\n'));
  });

  test('uses the default mission slug generator for a Korean goal filename', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const stream = mock(async (_messages: unknown, onUpdate: (_delta: string, full: string) => void) => {
      onUpdate('', 'readable-korean-goal-filename');
    });
    setMissionSlugStreamForTest(stream as never);
    try {
      const { slugFn: _slugFn, ...defaultDeps } = deps;
      const result = await writeAuthoredGoal('한국어 골 파일명 생성 계약', cwd, defaultDeps, { now: () => STAMP_AT });
      const filename = result.path.split('/').at(-1)!;

      expect(stream).toHaveBeenCalledTimes(1);
      expect(existsSync(result.path)).toBe(true);
      expect(filename).toMatch(/^GOAL-readable-korean-goal-filename-[a-f0-9]{8}-2026-07-29\.md$/);
      expect(filename).not.toMatch(/(?:hangukeo|pailmyeong|saengseong)/);
    } finally {
      setMissionSlugStreamForTest();
    }
  });

  test('keeps authoring when the injected English-summary slug generator throws', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const result = await writeAuthoredGoal('한국어 골 파일명 생성 계약', cwd, {
      ...deps,
      slugFn: async () => { throw new Error('luna unavailable'); },
    }, { now: () => STAMP_AT });
    const filename = result.path.split('/').at(-1)!;

    expect(existsSync(result.path)).toBe(true);
    expect(filename).toMatch(/^GOAL-goal-[a-f0-9]{8}-2026-07-29\.md$/);
  });

  test('omits each unpopulated identity header line and derives track only from a recognized tree path', async () => {
    const cases = [
      { name: 'agent absent', cwd: '/tmp/unknown-tree', request: 'track: S\nsession: run-1\nsubmitted: now\nWrite goal', expected: ['track: S', 'session: run-1', 'submitted: now'], absent: ['agent:'] },
      { name: 'track absent', cwd: '/tmp/unknown-tree', request: 'agent: author\nsession: run-1\nsubmitted: now\nWrite goal', expected: ['agent: author', 'session: run-1', 'submitted: now'], absent: ['track:'] },
      { name: 'session absent', cwd: '/tmp/unknown-tree', request: 'agent: author\ntrack: S\nsubmitted: now\nWrite goal', expected: ['agent: author', 'track: S', 'submitted: now'], absent: ['session:'] },
      // ⭐ `submitted` 는 이제 **시계에서 스스로 만든다** — ask 에 없으면 생성된다(부재가 아니다).
      { name: 'submitted derived from clock', cwd: '/tmp/unknown-tree', request: 'agent: author\ntrack: S\nsession: run-1\nWrite goal', expected: ['agent: author', 'track: S', 'session: run-1', `submitted: ${STAMPED}`], absent: [] },
      { name: 'multiple absent', cwd: '/tmp/unknown-tree', request: 'agent: author\nWrite goal', expected: ['agent: author', `submitted: ${STAMPED}`], absent: ['track:', 'session:'] },
      // ⛔ 빈 값은 **줄을 안 쓴다** — 부재와 미지를 같은 값으로 만들지 않기 위해서다. `submitted` 만 시계에서 온다.
      { name: 'all blank', cwd: '/tmp/unknown-tree', request: '---\nagent: \ntrack:\nsession:   \nsubmitted:\n---\nWrite goal', expected: [`submitted: ${STAMPED}`], absent: ['agent:', 'track:', 'session:'] },
      { name: 'track inferred', cwd: '/work/pilot/elanous', request: 'Write goal', expected: ['track: S', `submitted: ${STAMPED}`], absent: ['agent:', 'session:'] },
      // ⭐ 환경에서 온다 — 주입한 env 만 본다(실제 프로세스 env 가 새면 테스트가 비결정이 된다).
      { name: 'agent and session from env', cwd: '/tmp/unknown-tree', request: 'Write goal', env: { AI_AGENT: 'env-agent', CLAUDE_CODE_SESSION_ID: 'env-session' }, expected: ['agent: env-agent', 'session: env-session', `submitted: ${STAMPED}`], absent: ['track:'] },
    ];
    for (const entry of cases) {
      const root = existingGoalDocumentsRoot('goal-author-');
      const result = await writeAuthoredGoal(entry.request, join(root, entry.cwd), deps, { now: () => STAMP_AT, env: entry.env ?? {} });
      const document = readFileSync(result.path, 'utf8');
      // 머리말은 파일 끝의 `---` 뒤에 온다. 제목 줄에는 절대 섞이지 않는다.
      const tail = document.slice(document.lastIndexOf('\n---\n') + 5).split('\n').filter(Boolean);
      expect(tail).toEqual(entry.expected);
      const header = tail;
      for (const line of entry.absent) expect(tail.some((entryLine) => entryLine.startsWith(line))).toBe(false);
      expect(document.split('\n', 1)[0]).not.toContain(':');
    }
  });

  test('keeps generated English slugs portable ASCII and within the 64-byte cap', () => {
    const date = new Date(2026, 6, 29);
    const englishSource = {
      title: 'Add readable goal filenames with a deliberately long title that exceeds the sixty four byte slug budget.',
      document: 'generated English result: filename readability contract',
    };
    const englishCandidate = 'add-readable-goal-filenames-with-a-deliberately-long-title-that-exceeds-the-sixty-four-byte-slug-budget';
    const english = goalFileName(englishSource, date);
    expect(Buffer.byteLength(englishCandidate, 'utf8')).toBeGreaterThan(64);
    expect(english).toBe('GOAL-add-readable-goal-filenames-with-a-deliberately-long-title-that-ca61ca1f-2026-07-29.md');
    expect(english).toMatch(/^GOAL-[a-z0-9-]+-2026-07-29\.md$/);
    expect(Buffer.byteLength(english, 'utf8')).toBeLessThanOrEqual(255);
    expect(english.match(/^GOAL-(.+)-[a-f0-9]{8}-2026/)?.[1].length).toBeLessThanOrEqual(64);
  });

  test('prefixes Korean authored filenames with all ask identifiers, not requested criteria', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const askWithReorderedCriteria = [
      'buildGoalFileName TUI S5A src/self-implement/goal-author.ts에서 한글 파일명 가독성을 고친다.',
      'Checkable requested criterion: criterion-zebra를 확인한다.',
      'Checkable requested criterion: criterion-alpha를 확인한다.',
    ].join('\n');
    const reorderedCriteria = [
      'buildGoalFileName TUI S5A src/self-implement/goal-author.ts에서 한글 파일명 가독성을 고친다.',
      'Checkable requested criterion: criterion-alpha를 확인한다.',
      'Checkable requested criterion: criterion-zebra를 확인한다.',
    ].join('\n');
    const result = await writeAuthoredGoal(askWithReorderedCriteria, cwd, deps, { now: () => STAMP_AT });
    const reordered = await writeAuthoredGoal(reorderedCriteria, cwd, deps, { now: () => STAMP_AT });
    const filename = result.path.split('/').at(-1)!;
    const reorderedFilename = reordered.path.split('/').at(-1)!;
    const identifierPrefix = 'buildgoalfilename-tui-s5a-src-self-implement-goal-author-ts';

    expect(filename).toMatch(new RegExp(`^GOAL-${identifierPrefix}-`));
    expect(reorderedFilename).toMatch(new RegExp(`^GOAL-${identifierPrefix}-`));
    for (const criterionToken of ['criterion-zebra', 'criterion-alpha']) {
      expect(filename).not.toContain(criterionToken);
      expect(reorderedFilename).not.toContain(criterionToken);
    }
    const slug = filename.match(/^GOAL-(.+)-[a-f0-9]{8}-\d{4}-\d{2}-\d{2}\.md$/)?.[1];
    const reorderedSlug = reorderedFilename.match(/^GOAL-(.+)-[a-f0-9]{8}-\d{4}-\d{2}-\d{2}\.md$/)?.[1];
    expect(slug?.slice(0, identifierPrefix.length)).toBe(reorderedSlug?.slice(0, identifierPrefix.length));
  }, 30_000);

  test('uses generated documents for meaningful same-ask fingerprints and reserves copy numbering for identical artifacts', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const sameAsk = '목표: PTY shell spawn 통합 계약을 문서화한다';
    const alteredDeps: GoalAuthorDeps = {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: ['document the successful spawn contract', 'document the failure recovery contract'],
        verbatimPreserved: true,
      }),
    };
    const first = await writeAuthoredGoal(sameAsk, cwd, { ...deps, goalId: '0123456789abcdef' }, { now: () => STAMP_AT });
    const revised = await writeAuthoredGoal(sameAsk, cwd, { ...alteredDeps, goalId: '0123456789abcdef' }, { now: () => STAMP_AT });
    const duplicate = await writeAuthoredGoal(sameAsk, cwd, { ...deps, goalId: '0123456789abcdef' }, { now: () => STAMP_AT });
    const firstName = first.path.split('/').at(-1)!;
    const revisedName = revised.path.split('/').at(-1)!;
    const duplicateName = duplicate.path.split('/').at(-1)!;

    const repositoryIdentifiers = ['PTY', 'shell', 'spawn'];
    expect(firstName).toBe(goalFileName({ title: 'readable-goal-summary', document: readFileSync(first.path, 'utf8'), repositoryIdentifiers }, STAMP_AT));
    expect(revisedName).toBe(goalFileName({ title: 'readable-goal-summary', document: readFileSync(revised.path, 'utf8'), repositoryIdentifiers }, STAMP_AT));
    expect(firstName).not.toBe(revisedName);
    expect(revisedName).not.toContain('-copy-');
    expect(duplicateName).toBe(firstName.replace(/-2026-07-29\.md$/, '-copy-2-2026-07-29.md'));
    for (const name of [firstName, revisedName, duplicateName]) expect(name).toMatch(/-2026-07-29\.md$/);
  });

  test('creates distinct GoalIds for new documents and inherits an explicitly superseded GoalId once', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const first = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const second = await writeAuthoredGoal('Author another goal.', cwd, deps, { now: () => STAMP_AT });
    const firstDocument = readFileSync(first.path, 'utf8');
    const firstId = parseGoalId(firstDocument);
    const secondId = parseGoalId(readFileSync(second.path, 'utf8'));
    expect(firstId).toMatch(/^[0-9a-f]{16}$/);
    expect(secondId).toMatch(/^[0-9a-f]{16}$/);
    expect(secondId).not.toBe(firstId);

    const successor = await writeAuthoredGoal('Rewrite the original goal.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: first.path },
    });
    expect(parseGoalId(readFileSync(successor.path, 'utf8'))).toBe(firstId);
    const superseded = readFileSync(first.path, 'utf8');
    expect(superseded.match(/^- Superseded-By: /gm)).toHaveLength(1);
    expect(superseded).toContain(`- Superseded-By: docs/goals/${successor.path.split('/').at(-1)!}`);
    await expect(writeAuthoredGoal('Rewrite again.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: first.path },
    })).rejects.toThrow('superseded goal file already has Superseded-By');
  });

  test('warns without blocking when a supersession receives a goal-shaped input and its source has answered clarifications', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-supersession-warning-'));
    temporaryDirectories.push(cwd);
    const quietDeps = { ...deps, onProgress: () => undefined };
    const original = await writeAuthoredGoal('Author an original goal.', cwd, quietDeps, { now: () => STAMP_AT });
    const originalDocument = readFileSync(original.path, 'utf8');
    const source = `${originalDocument.replace(/\n*$/, '\n')}\n- Clarification:\n  - id: answered-question\n  - header: Answered question\n  - question: Was this already resolved?\n  - answer: yes\n  - options:\n    - label: yes\n      description: resolved\n  - includeOther: false\n`;
    writeFileSync(original.path, source);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const successor = await writeAuthoredGoal(source, cwd, {
        ...quietDeps,
        enhance: async (raw) => ({
          original: raw,
          checklist: ['first new requested criterion', 'second new requested criterion'],
          verbatimPreserved: true,
        }),
      }, {
        now: () => STAMP_AT,
        supersedes: { path: original.path },
      });

      expect(existsSync(successor.path)).toBe(true);
      expect(successor.authored.document).toContain('first new requested criterion');
      expect(stderr).toHaveBeenCalledWith('[goal-author] supersession warning: input-goal-document=yes; answered-clarifications=yes; requested-criteria old=1 new=2\n');
      expect(log).toHaveBeenCalledWith('goal-author', 'supersession-warning', {
        inputGoalDocument: true,
        answeredClarifications: true,
        oldRequestedCriteria: 1,
        newRequestedCriteria: 2,
      });
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }
  });

  test('keeps a completed supersession when warning detection or stderr notification fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-supersession-warning-fail-soft-'));
    temporaryDirectories.push(cwd);
    const quietDeps = { ...deps, onProgress: () => undefined };
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('stderr unavailable'); });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const stderrSource = await writeAuthoredGoal('Original stderr source.', cwd, quietDeps, { now: () => STAMP_AT });
      const stderrSuccessor = await writeAuthoredGoal('Success despite stderr failure.', cwd, quietDeps, {
        now: () => STAMP_AT,
        supersedes: { path: stderrSource.path },
      });
      expect(existsSync(stderrSuccessor.path)).toBe(true);
      expect(readFileSync(stderrSource.path, 'utf8')).toContain('- Superseded-By: ');

      const detectorSource = await writeAuthoredGoal('Original detector source.', cwd, quietDeps, { now: () => STAMP_AT });
      const detectorSuccessor = await writeAuthoredGoal('Success despite detector failure.', cwd, quietDeps, {
        now: () => STAMP_AT,
        supersedes: { path: detectorSource.path },
        emitSupersessionWarning: () => { throw new Error('detector unavailable'); },
      });
      expect(existsSync(detectorSuccessor.path)).toBe(true);
      expect(readFileSync(detectorSource.path, 'utf8')).toContain('- Superseded-By: ');
      expect(log).toHaveBeenCalledWith('goal-author', 'supersession-warning-detection-failed', {});
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }
  });

  test('excludes language-tagged fenced criterion examples from supersession counts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-supersession-warning-fence-'));
    temporaryDirectories.push(cwd);
    const quietDeps = { ...deps, onProgress: () => undefined };
    const original = await writeAuthoredGoal('Original fenced source.', cwd, quietDeps, { now: () => STAMP_AT });
    const source = original.authored.document.replace(
      '## REQUIRED EVIDENCE',
      '```markdown\n- Checkable requested criterion: example only\n```\n## REQUIRED EVIDENCE',
    );
    writeFileSync(original.path, source);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const successor = await writeAuthoredGoal('Successor with one criterion.', cwd, {
        ...quietDeps,
        enhance: async (raw) => ({ original: raw, checklist: ['actual successor criterion'], verbatimPreserved: true }),
      }, {
        now: () => STAMP_AT,
        supersedes: { path: original.path },
      });

      expect(existsSync(successor.path)).toBe(true);
      expect(stderr).toHaveBeenCalledWith('[goal-author] supersession warning: input-goal-document=no; answered-clarifications=no; requested-criteria old=1 new=1\n');
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }
  });

  test('does not emit a supersession warning for ordinary authoring', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-author-ordinary-no-supersession-warning-'));
    temporaryDirectories.push(cwd);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await writeAuthoredGoal('Author an ordinary goal.', cwd, { ...deps, onProgress: () => undefined }, { now: () => STAMP_AT });

      expect(existsSync(result.path)).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
      expect(log.mock.calls.some(([category, event]) => category === 'goal-author' && event === 'supersession-warning')).toBe(false);
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }
  });

  test('writes AskFile immediately after GoalType and reads it back without changing GoalId', async () => {
    const withoutAskFile = await authorGoal('Lineage key stays off the header.', { ...deps, goalId: '0123456789abcdef' });
    expect(withoutAskFile.document).toMatch(/^- GoalId: 0123456789abcdef\n- RootIntent: .*\n- GoalType: implement\n\n## PROBLEM\n/m);
    expect(withoutAskFile.document).not.toContain('- AskFile:');
    expect(parseAskFile(withoutAskFile.document)).toBeNull();

    const withAskFile = await authorGoal('Lineage key sits beside GoalId.', {
      ...deps,
      goalId: '0123456789abcdef',
      askFile: 'docs/goals/ASK-x.md',
    });
    expect(withAskFile.document).toMatch(/^- GoalId: 0123456789abcdef\n- RootIntent: .*\n- GoalType: implement\n- AskFile: docs\/goals\/ASK-x\.md\n/m);
    expect(parseAskFile(withAskFile.document)).toBe('docs/goals/ASK-x.md');
    expect(parseGoalId(withAskFile.document)).toBe(parseGoalId(withoutAskFile.document));
  });

  test('records a root RootIntent once and inherits it literally through descendant documents', async () => {
    const root = await authorGoal('The root purpose must survive every descendant.', deps);
    const rootIntent = parseRootIntent(root.document);
    expect(rootIntent).toBe('The root purpose must survive every descendant.');

    const child = await authorGoal('Narrow child ask.', {
      ...deps,
      parent: { goalFile: 'docs/goals/root.txt', questionId: 'child' },
      parentDocument: root.document,
    });
    const grandchild = await authorGoal('Narrow grandchild ask.', {
      ...deps,
      parent: { goalFile: 'docs/goals/child.txt', questionId: 'grandchild' },
      parentDocument: child.document,
    });
    expect(parseRootIntent(child.document)).toBe(rootIntent);
    expect(parseRootIntent(grandchild.document)).toBe(rootIntent);
    expect(grandchild.document.match(/^- RootIntent: /gm)).toHaveLength(1);
  });

  test('appends a parent document 경계: lines verbatim under one header when the fragment has a parent', async () => {
    const first = '  경계: src/self-implement/goal-author.ts만 고친다.  ';
    const second = '경계:  부모 경계의  내부 공백과 punctuation: 그대로.';
    const parent = [
      'Parent goal',
      '- GoalId: 0123456789abcdef',
      '- RootIntent: Parent root purpose',
      '- GoalType: implement',
      '',
      '## SCOPE BOUNDARY',
      '- Boundary decision: rewritten parent decision must not be copied.',
      first,
      'not a boundary: 경계 가 줄 가운데 있다',
      second,
      '경계 : malformed spacing is not a boundary line',
      '',
    ].join('\n');
    const fragment = await authorGoal('Child fragment.', {
      ...deps,
      parent: { goalFile: 'docs/goals/parent.txt', questionId: 'child' },
      parentDocument: parent,
    });
    const scope = fragment.document.slice(
      fragment.document.indexOf('## SCOPE BOUNDARY'),
      fragment.document.indexOf('## 답하지 못하는 것'),
    );
    const headerAt = scope.indexOf(PARENT_BOUNDARY_HEADER);
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(scope.indexOf(PARENT_BOUNDARY_HEADER, headerAt + 1)).toBe(-1);
    const copied = scope.slice(headerAt).split('\n').slice(1, 3);
    expect(copied).toEqual([first.trim(), second.trim()]);
    expect(scope).not.toContain('rewritten parent decision');
    expect(scope).not.toContain('malformed spacing');
    expect(boundaryLinesVerbatim(parent)).toEqual([first.trim(), second.trim()]);
    expect(parentBoundaryLines(undefined)).toEqual([]);
    expect(parentBoundaryLines('Parent goal\n- RootIntent: Parent root purpose\n')).toEqual([]);
  });

  test('rejects incomplete or caller-supplied parent RootIntent inputs and requires an explicit legacy value', async () => {
    const parent = await authorGoal('Original root purpose.', deps);
    const parentRef = { goalFile: 'docs/goals/parent.txt', questionId: 'child' };
    await expect(authorGoal('Child.', { ...deps, parent: parentRef })).rejects.toThrow('parent and parentDocument must be supplied together');
    await expect(authorGoal('Child.', { ...deps, parentDocument: parent.document })).rejects.toThrow('parent and parentDocument must be supplied together');
    for (const rootIntent of ['Original root purpose.', 'override']) {
      await expect(authorGoal('Child.', { ...deps, parent: parentRef, parentDocument: parent.document, rootIntent }))
        .rejects.toThrow('rootIntent must not be supplied when parent document has RootIntent');
    }

    const legacyParent = parent.document.replace(/^- RootIntent: .*\n/m, '');
    await expect(authorGoal('Child.', { ...deps, parent: parentRef, parentDocument: legacyParent }))
      .rejects.toThrow('legacy parent document has no RootIntent; rootIntent is required');
    const legacyChild = await authorGoal('Child.', { ...deps, parent: parentRef, parentDocument: legacyParent, rootIntent: 'Recorded legacy root purpose.' });
    expect(parseRootIntent(legacyChild.document)).toBe('Recorded legacy root purpose.');
  });

  test('rejects a blank or malformed parent RootIntent instead of treating it as legacy', async () => {
    const parent = await authorGoal('Original root purpose.', deps);
    const parentRef = { goalFile: 'docs/goals/parent.txt', questionId: 'child' };
    for (const rootIntentLine of ['- RootIntent:\n', '- RootIntent: \n', '- RootIntent:   \n', '- RootIntent malformed\n']) {
      const malformedParent = parent.document.replace(/^- RootIntent: .*\n/m, rootIntentLine);
      expect(() => parseRootIntent(malformedParent)).toThrow('goal file has invalid RootIntent');
      await expect(authorGoal('Child.', {
        ...deps,
        parent: parentRef,
        parentDocument: malformedParent,
        rootIntent: 'Caller must not override a malformed declaration.',
      })).rejects.toThrow('goal file has invalid RootIntent');
    }
  });

  test('keeps every metadata line boundary out of titles for explicit, parent, and supersession paths', async () => {
    const assertSingleLineHeader = (document: string, rootIntent: string) => {
      const [title, goalId, intent, goalType] = document.split('\n', 4);
      expect(title).toBe('Normalize this authored goal title. The second ask line must not become metadata.');
      expect(goalId).toMatch(/^- GoalId: [0-9a-f]{16}$/);
      expect(intent).toBe(`- RootIntent: ${rootIntent}`);
      expect(goalType).toBe('- GoalType: implement');
    };

    for (const boundary of ['\r', '\u2028', '\u2029']) {
      const ask = `Normalize this authored goal title.${boundary}The second ask line must not become metadata.`;
      const explicit = await authorGoal(ask, { ...deps, rootIntent: 'Explicit root purpose.' });
      assertSingleLineHeader(explicit.document, 'Explicit root purpose.');

      const parent = await authorGoal('Parent root purpose.', deps);
      const inherited = await authorGoal(ask, {
        ...deps,
        parent: { goalFile: 'docs/goals/parent.txt', questionId: 'child' },
        parentDocument: parent.document,
      });
      assertSingleLineHeader(inherited.document, 'Parent root purpose.');

      const cwd = existingGoalDocumentsRoot('goal-author-');
      const original = await writeAuthoredGoal('Original root purpose.', cwd, deps, { now: () => STAMP_AT });
      const superseded = await writeAuthoredGoal(ask, cwd, deps, {
        now: () => STAMP_AT,
        supersedes: { path: original.path },
      });
      assertSingleLineHeader(superseded.authored.document, 'Original root purpose.');
    }
  });

  test('rejects blank, every metadata line boundary, or surrounding-whitespace rootIntent before metadata assembly', async () => {
    for (const rootIntent of ['', '   ', ' purpose ', 'first\nsecond', 'first\rsecond', 'first\u2028second', 'first\u2029second']) {
      await expect(authorGoal('Root intent validation.', { ...deps, rootIntent }))
        .rejects.toThrow('rootIntent must be a non-blank single line without surrounding whitespace');
    }
  });

  test('normalizes Unicode metadata boundaries in a new root RootIntent synthesized from the ask summary', async () => {
    for (const boundary of ['\u2028', '\u2029']) {
      const ask = `Root summary${boundary}must not cross metadata lines`;
      const authored = await authorGoal(ask, {
        ...deps,
        enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
      });
      expect(authored.document).toStartWith('Root summary must not cross metadata lines\n');
      expect(parseRootIntent(authored.document)).toBe('Root summary must not cross metadata lines');
    }
  });

  test('round-trips a valid RootIntent literally through write and parse', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const rootIntent = 'Literal root purpose.';
    const written = await writeAuthoredGoal('Different ask.', cwd, { ...deps, rootIntent }, { now: () => STAMP_AT });
    expect(parseRootIntent(readFileSync(written.path, 'utf8'))).toBe(rootIntent);
  });

  test('rejects a caller-supplied supersessionRootIntent so only the locked source document can supply it', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Original root purpose.', cwd, deps, { now: () => STAMP_AT });
    const injectedDeps: GoalAuthorDeps & { supersessionRootIntent: string } = {
      ...deps,
      supersessionRootIntent: 'forged root purpose',
    };
    await expect(authorGoal('Forged successor.', injectedDeps))
      .rejects.toThrow('supersessionRootIntent is reserved for the superseded document reader');
    await expect(writeAuthoredGoal('Forged successor.', cwd, injectedDeps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
    })).rejects.toThrow('supersessionRootIntent is reserved for the superseded document reader');
  });

  test('preserves supersede rootIntent input for matching validation instead of silently discarding it', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Original root purpose.', cwd, deps, { now: () => STAMP_AT });

    const matching = await writeAuthoredGoal('Matching revision.', cwd, { ...deps, rootIntent: 'Original root purpose.' }, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
    });
    expect(parseRootIntent(matching.authored.document)).toBe('Original root purpose.');

    const second = await writeAuthoredGoal('Second root purpose.', cwd, deps, { now: () => STAMP_AT });
    await expect(writeAuthoredGoal('Conflicting revision.', cwd, { ...deps, rootIntent: 'different root purpose' }, {
      now: () => STAMP_AT,
      supersedes: { path: second.path },
    })).rejects.toThrow('rootIntent must match superseded document RootIntent');
  });

  test('requires an explicit RootIntent before superseding a legacy goal and writes it literally', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const goals = join(cwd, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const legacyPath = join(goals, 'GOAL-legacy.txt');
    writeFileSync(legacyPath, 'Legacy goal\n- GoalId: 0123456789abcdef\n');

    await expect(writeAuthoredGoal('New revision ask must not become legacy intent.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: legacyPath },
    })).rejects.toThrow('legacy superseded goal file has no RootIntent; rootIntent is required');
    expect(readdirSync(goals).filter((name) => name.endsWith('.txt'))).toEqual(['GOAL-legacy.txt']);

    const rootIntent = 'Recorded legacy root purpose.';
    const successor = await writeAuthoredGoal('New revision ask must not become legacy intent.', cwd, { ...deps, rootIntent }, {
      now: () => STAMP_AT,
      supersedes: { path: legacyPath },
    });
    expect(parseRootIntent(readFileSync(successor.path, 'utf8'))).toBe(rootIntent);
  });

  test('inherits the parent RootIntent when superseding a legacy goal', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const goals = join(cwd, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const legacyPath = join(goals, 'GOAL-legacy.txt');
    writeFileSync(legacyPath, 'Legacy goal\n- GoalId: 0123456789abcdef\n');
    const parent = await authorGoal('Parent root purpose.', deps);

    const successor = await writeAuthoredGoal('Successor preserves its parent root purpose.', cwd, {
      ...deps,
      parent: { goalFile: 'docs/goals/parent.txt', questionId: 'revision' },
      parentDocument: parent.document,
    }, {
      now: () => STAMP_AT,
      supersedes: { path: legacyPath },
    });

    expect(parseRootIntent(successor.authored.document)).toBe('Parent root purpose.');
  });

  test('rejects conflicting parent and superseded RootIntents', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const goals = join(cwd, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const conflictingPath = join(goals, 'GOAL-conflicting.txt');
    writeFileSync(conflictingPath, 'Conflicting goal\n- GoalId: fedcba9876543210\n- RootIntent: Superseded root.\n');
    const clarificationParent = await authorGoal('Clarification parent root.', deps);
    const parent = { goalFile: 'docs/goals/clarification-parent.txt', questionId: 'clarification-7' };

    await expect(writeAuthoredGoal('Conflicting clarification parent.', cwd, {
      ...deps,
      parent,
      parentDocument: clarificationParent.document,
    }, {
      now: () => STAMP_AT,
      supersedes: { path: conflictingPath },
    })).rejects.toThrow('parent document RootIntent must match superseded document RootIntent');
  });

  test('atomically records a byte-identical Superseded-By backlink', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const originalDocument = readFileSync(original.path, 'utf8');

    const successor = await writeAuthoredGoal('Rewrite the original goal.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
    });

    const expected = originalDocument.replace(
      /^(- GoalId: [0-9a-f]{16})$/m,
      `$1\n- Superseded-By: docs/goals/${successor.path.split('/').at(-1)!}`,
    );
    expect(readFileSync(original.path, 'utf8')).toBe(expected);
  });

  // Observed focused callback duration: 1.106s (one run); the crash child timeout of 5s leaves 3.894s headroom.
  // The explicit 10s test budget remains 5s above the child timeout for stale-lock recovery and assertions.
  test('keeps the predecessor byte-identical across a process crash after temporary backlink write and permits stale-lock retry', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const goals = join(cwd, 'docs', 'goals');
    mkdirSync(goals, { recursive: true });
    const originalPath = join(goals, 'GOAL-original.txt');
    const originalDocument = 'Original goal\n- GoalId: 0123456789abcdef\n- RootIntent: Original root purpose\n';
    writeFileSync(originalPath, originalDocument);
    const moduleUrl = pathToFileURL(join(import.meta.dir, 'goal-author.ts')).href;
    const script = `import { writeAuthoredGoal } from ${JSON.stringify(moduleUrl)};
const deps = { ground: async () => ({ grounded: true, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }), enhance: async (ask) => ({ original: ask, checklist: [], verbatimPreserved: true }), slugFn: async () => 'crash-successor' };
await writeAuthoredGoal('Crash after temporary backlink write.', ${JSON.stringify(cwd)}, deps, { supersedes: { path: ${JSON.stringify(originalPath)} }, rename: () => process.kill(process.pid, 'SIGKILL') });`;
    // Measured callback: 1.106s; the crash child timeout of 5s leaves 3.894s headroom.
    expect(() => execFileSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: 5_000 })).toThrow();

    expect(readFileSync(originalPath, 'utf8')).toBe(originalDocument);
    const temporaryFiles = readdirSync(goals).filter((name) => name.includes('.tmp.'));
    expect(temporaryFiles).toHaveLength(1);
    expect(readFileSync(join(goals, temporaryFiles[0]), 'utf8')).not.toBe(originalDocument);
    const lockPath = `${originalPath}.supersede-lock`;
    const staleAt = new Date(Date.now() - 31_000);
    utimesSync(lockPath, staleAt, staleAt);
    const successor = await writeAuthoredGoal('Retry after a crashed backlink write.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: originalPath },
    });
    expect(readFileSync(originalPath, 'utf8')).toContain(`- Superseded-By: docs/goals/${successor.path.split('/').at(-1)!}`);
  // Observed crash child is bounded at 5s; 10s leaves recovery and assertion headroom.
  }, 10_000);

  test('recovers a stale shared lock but preserves a live shared lock', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const staleOriginal = await writeAuthoredGoal('Author a stale-lock goal.', cwd, deps, { now: () => STAMP_AT });
    const staleLock = `${staleOriginal.path}.supersede-lock`;
    writeFileSync(staleLock, `${process.pid}\n`, { flag: 'wx' });
    const staleAt = new Date(Date.now() - 31_000);
    utimesSync(staleLock, staleAt, staleAt);

    const successor = await writeAuthoredGoal('Recover stale lock.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: staleOriginal.path },
    });
    expect(readFileSync(staleOriginal.path, 'utf8')).toContain(`- Superseded-By: docs/goals/${successor.path.split('/').at(-1)!}`);
    expect(existsSync(staleLock)).toBe(false);

    const liveOriginal = await writeAuthoredGoal('Author a live-lock goal.', cwd, deps, { now: () => STAMP_AT });
    const liveLock = `${liveOriginal.path}.supersede-lock`;
    writeFileSync(liveLock, `${process.pid}\n`, { flag: 'wx' });
    await expect(writeAuthoredGoal('Must retain live lock.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: liveOriginal.path },
    })).rejects.toThrow('superseded goal file is being superseded');
    expect(readFileSync(liveLock, 'utf8')).toBe(`${process.pid}\n`);
  });

  test('serializes concurrent stale-lock recovery so one owner enters the critical section', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author a stale-lock goal.', cwd, deps, { now: () => STAMP_AT });
    const lockPath = `${original.path}.supersede-lock`;
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    const staleAt = new Date(Date.now() - 31_000);
    utimesSync(lockPath, staleAt, staleAt);
    let releaseGrounding!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGrounding = resolve; });
    const blockedDeps: GoalAuthorDeps = { ...deps, ground: async () => { await gate; return facts; } };

    const first = writeAuthoredGoal('Recover the stale lock once.', cwd, blockedDeps, { now: () => STAMP_AT, supersedes: { path: original.path } });
    await Promise.resolve();
    const second = writeAuthoredGoal('Recover the stale lock twice.', cwd, blockedDeps, { now: () => STAMP_AT, supersedes: { path: original.path } });
    releaseGrounding();
    const attempts = await Promise.allSettled([first, second]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(readFileSync(original.path, 'utf8').match(/^- Superseded-By: /gm)).toHaveLength(1);
  });

  test('does not release a replacement shared lock after stale recovery', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author a goal.', cwd, deps, { now: () => STAMP_AT });
    const lockPath = `${original.path}.supersede-lock`;
    let releaseGrounding!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGrounding = resolve; });
    const pausedDeps: GoalAuthorDeps = { ...deps, ground: async () => { await gate; return facts; } };

    const succession = writeAuthoredGoal('Pause while holding lock.', cwd, pausedDeps, { now: () => STAMP_AT, supersedes: { path: original.path } });
    await Promise.resolve();
    const staleAt = new Date(Date.now() - 31_000);
    utimesSync(lockPath, staleAt, staleAt);
    rmSync(lockPath);
    writeFileSync(lockPath, 'replacement-owner\n', { flag: 'wx' });
    releaseGrounding();
    await succession;

    expect(readFileSync(lockPath, 'utf8')).toBe('replacement-owner\n');
  });

  test('rejects duplicate Superseded-By metadata without creating a successor', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const duplicated = readFileSync(original.path, 'utf8').replace(
      /^(- GoalId: [0-9a-f]{16})$/m,
      '$1\n- Superseded-By: docs/goals/first.txt\n- Superseded-By: docs/goals/second.txt',
    );
    writeFileSync(original.path, duplicated);

    await expect(writeAuthoredGoal('Must not supersede duplicate metadata.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
    })).rejects.toThrow('superseded goal file has duplicate Superseded-By');
    expect(readdirSync(join(cwd, 'docs', 'goals')).filter((name) => name.endsWith('.md'))).toEqual([
      original.path.split('/').at(-1)!,
    ]);
  });

  test('requires the locked source to remain readable before creating a superseding goal', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    let writes = 0;

    await expect(writeAuthoredGoal('Do not recreate a deleted original.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
      acquireSupersessionLock: () => () => undefined,
      read: (path) => {
        rmSync(path);
        return readFileSync(path, 'utf8');
      },
      write: () => { writes += 1; },
    })).rejects.toMatchObject({ code: 'ENOENT' });

    expect(writes).toBe(0);
    expect(existsSync(original.path)).toBe(false);
    expect(readdirSync(join(cwd, 'docs', 'goals')).filter((name) => name.endsWith('.md'))).toHaveLength(0);
  });

  test('ignores Superseded-By examples outside leading goal metadata', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const documentWithBodyExample = `${readFileSync(original.path, 'utf8').replace(/\n*$/, '\n')}Example only:\n- Superseded-By: docs/goals/not-a-backlink.txt\n`;
    writeFileSync(original.path, documentWithBodyExample);

    const successor = await writeAuthoredGoal('Rewrite despite a body example.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
    });
    const superseded = readFileSync(original.path, 'utf8');

    expect(parseGoalId(readFileSync(successor.path, 'utf8'))).toBe(parseGoalId(documentWithBodyExample));
    expect(superseded.match(/^- Superseded-By: /gm)).toHaveLength(2);
    expect(superseded.split('\n').slice(0, 3)).toContain(`- Superseded-By: docs/goals/${successor.path.split('/').at(-1)!}`);
  });

  test('serializes concurrent supersessions so exactly one successor and backlink exist', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });

    const attempts = await Promise.allSettled([
      writeAuthoredGoal('Rewrite the original goal once.', cwd, deps, { now: () => STAMP_AT, supersedes: { path: original.path } }),
      writeAuthoredGoal('Rewrite the original goal twice.', cwd, deps, { now: () => STAMP_AT, supersedes: { path: original.path } }),
    ]);
    const fulfilled = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof writeAuthoredGoal>>> => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/being superseded|already has Superseded-By/);
    const superseded = readFileSync(original.path, 'utf8');
    const backlink = superseded.match(/^- Superseded-By: (.+)$/m)?.[1];
    expect(superseded.match(/^- Superseded-By: /gm)).toHaveLength(1);
    expect(backlink).toBe(`docs/goals/${fulfilled[0].value.path.split('/').at(-1)!}`);
    expect(readdirSync(join(cwd, 'docs', 'goals')).filter((name) => name.endsWith('.md'))).toHaveLength(2);
  });

  test('locks by canonical realpath so two symlink aliases of one source yield exactly one successor and one backlink', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const aliasA = join(cwd, 'alias-a.txt');
    const aliasB = join(cwd, 'alias-b.txt');
    symlinkSync(original.path, aliasA);
    symlinkSync(original.path, aliasB);

    const attempts = await Promise.allSettled([
      writeAuthoredGoal('Rewrite through alias A.', cwd, deps, { now: () => STAMP_AT, supersedes: { path: aliasA } }),
      writeAuthoredGoal('Rewrite through alias B.', cwd, deps, { now: () => STAMP_AT, supersedes: { path: aliasB } }),
    ]);
    const fulfilled = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof writeAuthoredGoal>>> => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/being superseded|already has Superseded-By/);
    const superseded = readFileSync(original.path, 'utf8');
    expect(superseded.match(/^- Superseded-By: /gm)).toHaveLength(1);
    expect(superseded).toContain(`- Superseded-By: docs/goals/${fulfilled[0].value.path.split('/').at(-1)!}`);
    expect(readdirSync(join(cwd, 'docs', 'goals')).filter((name) => name.endsWith('.md'))).toHaveLength(2);
  });

  test('rolls back a successor when recording its Superseded-By backlink fails', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const originalDocument = readFileSync(original.path, 'utf8');

    let rewrites = 0;
    await expect(writeAuthoredGoal('Rewrite the original goal.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
      rewrite: (path, document) => {
        writeFileSync(path, document);
        rewrites += 1;
        if (rewrites === 1) throw new Error('backlink write failed');
      },
    })).rejects.toThrow('backlink write failed');
    expect(rewrites).toBe(2);

    expect(readFileSync(original.path, 'utf8')).toBe(originalDocument);
    expect(readdirSync(join(cwd, 'docs', 'goals'))).toEqual([original.path.split('/').at(-1)!]);
  });

  test('does not retry a successor filename when backlink rewrite reports EEXIST', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const original = await writeAuthoredGoal('Author an original goal.', cwd, deps, { now: () => STAMP_AT });
    const originalDocument = readFileSync(original.path, 'utf8');
    const writes: string[] = [];
    const rewriteError = Object.assign(new Error('backlink already exists'), { code: 'EEXIST' });
    let rewrites = 0;

    await expect(writeAuthoredGoal('Rewrite the original goal.', cwd, deps, {
      now: () => STAMP_AT,
      supersedes: { path: original.path },
      write: (path, document) => { writes.push(path); writeFileSync(path, document, { flag: 'wx' }); },
      rewrite: (path, document) => {
        rewrites += 1;
        if (rewrites === 1) throw rewriteError;
        writeFileSync(path, document);
      },
    })).rejects.toThrow('backlink already exists');
    expect(rewrites).toBe(2);

    expect(writes).toHaveLength(1);
    expect(readdirSync(join(cwd, 'docs', 'goals'))).toEqual([original.path.split('/').at(-1)!]);
    expect(readFileSync(original.path, 'utf8')).toBe(originalDocument);
  });

  test('parses legacy goal documents as null and rejects superseding one without GoalId', async () => {
    const legacy = 'Legacy goal document\n';
    const bodyOnlyGoalId = ['Legacy goal document', '', 'Example:', '- GoalId: 0123456789abcdef'].join('\n');
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const legacyPath = join(cwd, 'docs', 'goals', 'GOAL-legacy.txt');
    mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
    writeFileSync(legacyPath, legacy);
    expect(parseGoalId(legacy)).toBeNull();
    expect(parseGoalId(bodyOnlyGoalId)).toBeNull();
    await expect(writeAuthoredGoal('Cannot inherit legacy.', cwd, deps, {
      supersedes: { path: legacyPath },
    })).rejects.toThrow('superseded goal file has no GoalId');
  });

  test('reads identity only from an explicit leading metadata block and ignores body examples', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-author-'));
    temporaryDirectories.push(root);
    const request = [
      '---',
      'agent: trusted-author',
      'submitted: 2026-07-29 09:10 KST',
      '---',
      'Implement identity provenance.',
      'Example only:',
      'agent: forged-body-author',
      'track: T',
      'session: forged-session',
      'submitted: tomorrow',
    ].join('\n');
    const result = await writeAuthoredGoal(request, join(root, 'unknown-tree'), deps, { now: () => STAMP_AT, env: {} });
    const document = readFileSync(result.path, 'utf8');
    const header = document.slice(document.lastIndexOf('\n---\n') + 5).split('\n').filter(Boolean);
    expect(header).toEqual(['agent: trusted-author', 'submitted: 2026-07-29 09:10 KST']);
    expect(header).not.toContain('agent: forged-body-author');
    expect(header).not.toContain('track: T');
    expect(header).not.toContain('session: forged-session');
    expect(header).not.toContain('submitted: tomorrow');
  });

  // Observed focused callback duration: 1.043s (one run); the one-shot date child timeout of 5s leaves 3.957s headroom.
  // The existing explicit 10s test budget remains 5s above the child timeout for assertions.
  test('uses the local calendar date rather than the UTC date at a non-UTC timezone boundary', () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, 'goal-author.ts')).href;
    const script = `import { goalFileName } from ${JSON.stringify(moduleUrl)}; console.log(goalFileName({ title: 'Use local date.', document: 'Use local date.' }, new Date('2026-07-28T15:30:00.000Z')));`;
    // Measured callback: 1.043s; the one-shot date child timeout of 5s leaves 3.957s headroom.
    const filename = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Seoul' },
      timeout: 5_000,
    }).trim();
    expect(filename).toBe('GOAL-use-local-date-826c5ec1-2026-07-29.md');
    expect(filename).not.toContain('2026-07-28');
  }, 10_000);

  test('a racing author cannot overwrite: the write seam is atomic exclusive-create', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const racingDeps: GoalAuthorDeps = { ...deps, ground: async () => facts };
    const first = await writeAuthoredGoal(ask, cwd, racingDeps);
    const original = readFileSync(first.path, 'utf8');
    // ⭐ 경합자를 흉내낸다: 두 번째 저작이 고르려는 후보 이름을 **먼저 점유**해 둔다.
    //    배타 생성이 아니면 이 파일이 덮여 사라진다(= 조용한 유실).
    const squatted = first.path.replace(/-\d{4}-\d{2}-\d{2}\.md$/, '-copy-2$&');
    writeFileSync(squatted, 'racing author already wrote here', { flag: 'wx' });
    const second = await writeAuthoredGoal(ask, cwd, racingDeps);
    expect(second.path).not.toBe(first.path);
    expect(second.path).not.toBe(squatted);
    expect(readFileSync(first.path, 'utf8')).toBe(original);
    expect(readFileSync(squatted, 'utf8')).toBe('racing author already wrote here');
  });

  test('keeps output byte-identical when steps are omitted, but renders externally injected and empty steps distinctly', async () => {
    const stableGoalId = '0123456789abcdef';
    const baseline = await authorGoal(ask, { ...deps, goalId: stableGoalId });
    const omitted = await authorGoal(ask, { ...deps, goalId: stableGoalId, steps: undefined });
    const injected = await authorGoal(ask, { ...deps, goalId: stableGoalId, steps: ['Reuse the external decomposition seam.', 'Render its result without generating steps.'] });
    const empty = await authorGoal(ask, { ...deps, goalId: stableGoalId, steps: [] });

    expect(omitted.document).toBe(baseline.document);
    expect(omitted.document).not.toContain('## STEPS');
    expect(injected.document).toContain('## STEPS\n- Reuse the external decomposition seam.\n- Render its result without generating steps.');
    expect(lintGoalFile(injected.document, 'main')).toEqual(lintGoalFile(baseline.document, 'main'));
    expect(empty.document).toContain('## STEPS\n- No externally injected steps.');
    expect(empty.document).not.toBe(baseline.document);
  });

  test('decomposes only injected implement seams, preserves direct and empty inputs, and observes the result fail-soft', async () => {
    const stableGoalId = '0123456789abcdef';
    const decomposeSteps = mock(async () => [
      'Inspect src/self-implement/goal-author.ts.',
      'Keep failure handling fail-soft during retries.',
      'Propagate ledger verdict classifications in `run-store`.',
      'Verify the emitted document.',
    ]);
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const decomposed = await authorGoal(ask, { ...deps, goalId: stableGoalId, decomposeSteps });
      expect(decomposeSteps).toHaveBeenCalledTimes(1);
      expect(decomposed.document).toContain('## STEPS\n- Inspect src/self-implement/goal-author.ts.\n- Keep failure handling fail-soft during retries.\n- Propagate ledger verdict classifications in `run-store`.\n- Verify the emitted document.');
      const decomposition = log.mock.calls.find(([category, event]) =>
        category === 'goal-author' && event === 'goal-steps-decomposed',
      )?.[2] as { authorRunId: string; goalType: string; stepCount: number; codeNamedStepCount: number; elapsedMs: number; failed: boolean };
      const assembleInputs = log.mock.calls.find(([category, event, data]) =>
        category === 'goal-author' && event === 'phase-end' && (data as { phase?: string }).phase === 'assemble-inputs',
      )?.[2] as { authorRunId: string; elapsedMs: number };
      expect(decomposition).toEqual(expect.objectContaining({ authorRunId: expect.any(String), goalType: 'implement', stepCount: 4, codeNamedStepCount: 2, elapsedMs: expect.any(Number), failed: false }));
      expect(decomposition.authorRunId).toBe(assembleInputs.authorRunId);

      decomposeSteps.mockClear();
      const direct = await authorGoal(ask, { ...deps, goalId: stableGoalId, steps: ['Caller-provided step.'], decomposeSteps });
      expect(decomposeSteps).not.toHaveBeenCalled();
      expect(direct.document).toContain('## STEPS\n- Caller-provided step.');

      const empty = await authorGoal(ask, { ...deps, goalId: stableGoalId, decomposeSteps: async () => [] });
      const baseline = await authorGoal(ask, { ...deps, goalId: stableGoalId });
      expect(empty.document).toBe(baseline.document);
      expect(empty.document).not.toContain('## STEPS');

      const noSeam = await authorGoal(ask, { ...deps, goalId: stableGoalId });
      expect(noSeam.document).toBe(baseline.document);
      expect(noSeam.document).not.toContain('## STEPS');

      const researchSeam = mock(async () => ['Must not run.']);
      const research = await authorGoal(ask, { ...deps, goalId: stableGoalId, goalType: 'research', decomposeSteps: researchSeam });
      expect(researchSeam).not.toHaveBeenCalled();
      expect(research.document).not.toContain('## STEPS');

      const failed = await authorGoal(ask, { ...deps, goalId: stableGoalId, decomposeSteps: async () => { throw new Error('decomposition unavailable'); } });
      expect(failed.document).toBe(baseline.document);
      expect(failed.document).not.toContain('## STEPS');
      expect(log.mock.calls).toContainEqual(['goal-author', 'goal-steps-decomposed', expect.objectContaining({ goalType: 'implement', stepCount: 0, codeNamedStepCount: 0, elapsedMs: expect.any(Number), failed: true })]);
    } finally {
      log.mockRestore();
    }
  });

  test('accepts STEPS only once immediately after WHAT TO BUILD and rejects every other placement', async () => {
    const authored = await authorGoal(ask, {
      ...deps,
      goalId: '0123456789abcdef',
      steps: ['Use the externally decomposed plan.'],
    });
    const canonicalFinding = expect.objectContaining({
      level: 'ERROR',
      tag: 'canonical-structure',
      message: expect.stringContaining('required sections must appear in canonical order'),
    });
    const steps = '## STEPS\n- Use the externally decomposed plan.\n\n';
    const withoutSteps = authored.document.replace(steps, '');
    const malformed = [
      withoutSteps.replace('## PROBLEM', `${steps}## PROBLEM`),
      withoutSteps.replace('## REQUIRED EVIDENCE', `${steps}## REQUIRED EVIDENCE`),
      `${withoutSteps}\n${steps}`,
      authored.document.replace(steps, `${steps}${steps}`),
      // ⛔⭐ **정상 위치를 «유지한 채» 앞·뒤에 하나 더 두는 경우** — 무인 리뷰 must-fix ①②.
      //   위 넷은 전부 정상 STEPS 를 «지우거나» 인접 중복만 만들어서, 고정 길이 `slice` 창이
      //   여전히 canonical 과 일치했다. 즉 ***결함을 피해 가는 회귀 테스트***였다.
      //   ⇒ 창 «밖»(앞·끝)에 놓아야 개수 검사가 유일한 방어선이 된다.
      authored.document.replace('## PROBLEM', `${steps}## PROBLEM`),
      `${authored.document}\n${steps}`,
    ];

    expect(lintGoalFile(authored.document, 'main')).not.toContainEqual(canonicalFinding);
    for (const document of malformed) {
      expect(lintGoalFile(document, 'main')).toContainEqual(canonicalFinding);
    }
    // ⭐ 그리고 「개수와 위치」를 «전체 heading 에서» 직접 단언한다(must-fix ③) —
    //   위 루프는 「거부하는가」만 답하고 「무엇을 세는가」는 안 답한다.
    const headingsOf = (document: string): string[] =>
      document.split('\n').filter((line) => /^#{2}(?:[ \t]|$)/.test(line)).map((line) => line.trim());
    const authoredHeadings = headingsOf(authored.document);
    expect(authoredHeadings.filter((heading) => heading === '## STEPS')).toHaveLength(1);
    expect(authoredHeadings.indexOf('## STEPS')).toBe(authoredHeadings.indexOf('## WHAT TO BUILD') + 1);
    expect(headingsOf(`${authored.document}\n${steps}`).filter((heading) => heading === '## STEPS')).toHaveLength(2);
  });

  test('scaffold blob is never embedded, so no top-level block or planner step can leak', async () => {
    // prompt-enhance 는 실제로 `## 목표`·`## 실행 제약`·`## 커버리지 체크리스트` 를 갖고 온다
    // (2026-07-28 라이브 실측). 그대로 끼우면 최상위 블록이 넷을 넘는다 ⇒ 강등해서 봉합한다.
    // prompt-enhance 의 조립 블롭(`enhanced`)은 `## 목표`·`## 실행 제약` 헤딩과 단계형 문장을
    // 갖고 온다(2026-07-28 라이브 실측). 이 장치는 그것을 **싣지 않고** 구조화 필드만 쓴다.
    // ⭐ `#` 하나만 쓰면 구현이 검사하지 않는 것을 검사하는 Goodhart 테스트다(리뷰 지적).
    //    문서 구조와 **같은 모양**(`## `)과 코드펜스 구분자까지 원문에 넣어 본다.
    // ⭐ 원문이 **문서 펜스와 같은 길이의** 백틱 줄을 품으면 고정 3백틱 펜스는 조기에 닫히고
    //    그 뒤 원문 줄이 문서 구조로 오독된다 ⇒ 내용보다 긴 울타리를 써야 한다(CommonMark).
    // ⭐ 백틱 줄이 **홀수 개**여야 조기 종료가 재현된다(짝수면 상쇄돼 안 드러난다).
    const askWithHash = ['# 해시 한 개', '```', '## PROBLEM 처럼 보이는 원문 줄'].join('\n');
    const authored = await authorGoal(askWithHash, {
      ...deps,
      ground: async () => facts,
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    // ① 저작이 성공했다는 것 자체가 4블록 불변식 통과다 — 그리고 **펜스 안의 `## ` 는
    //    구조가 아니다**(원문이므로). 순진한 정규식으로 세면 그것까지 세어 오답이 난다.
    // 오라클도 CommonMark 규칙을 따라야 한다 — 여는 울타리보다 짧은 백틱 줄은 닫지 못한다.
    // (순진한 토글은 구현과 같은 버그를 갖고 있어 검사가 거짓말을 한다)
    const structural: string[] = [];
    let openFence = 0;
    let openMarker = '';
    for (const line of authored.document.split('\n')) {
      const run = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (run) {
        const marker = run[1][0];
        if (openFence === 0) { openFence = run[1].length; openMarker = marker; }
        else if (marker === openMarker && run[1].length >= openFence) { openFence = 0; openMarker = ''; }
        continue;
      }
      if (openFence === 0 && /^#{2}(?:[ \t]|$)/.test(line)) structural.push(line.replace(/[ \t]+/g, ' ').trim());
    }
    // ⭐ 2026-08-09 — 「왜」 절 은퇴 뒤로 구조 블록은 `REQUIRED_BLOCKS` 와 같은 «여덟»뿐이다(대표).
    expect(structural).toEqual(['## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호', '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식']);

    // ⭐ CommonMark 변형(`##` 단독 · `##\tEXTRA`)이 checklist 로 들어오면 **다섯째 블록**으로
    //    거부돼야 한다. `/^## /` 만 보면 이 둘을 놓친다(리뷰 지적 · 구현·오라클 둘 다 고쳤다).
    // ⭐ 혼합 펜스 격리: **원문 안**의 `~~~` 는 백틱 문서 펜스를 닫지 못한다(CommonMark).
    //    마커를 안 보면 그것이 펜스를 닫아 뒤따르는 `## …` 가 다섯째 블록으로 오인돼 **거부**된다.
    //    ⇒ 마커를 추적하면 저작이 **성공**해야 한다. (마커 추적을 빼면 이 단언이 깨진다)
    const mixed = await authorGoal(['원문 안 물결표', '~~~', '## 이건 원문의 일부다'].join('\n'), {
      ...deps,
      ground: async () => facts,
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    });
    expect(mixed.document).toContain('## 이건 원문의 일부다');
    for (const variant of ['##', '##\tEXTRA']) {
      await expect(authorGoal('h2 variant', {
        ...deps,
        ground: async () => facts,
        enhance: async (raw) => ({ original: raw, checklist: [`line one\n${variant}\nline two`], verbatimPreserved: true }),
      })).rejects.toThrow(/required blocks are not contiguous and ordered/);
    }
    // ② ⭐ 원문 안의 `#` 줄이 **글자 그대로** 살아 있다(헤딩 강등이 이것을 깨뜨렸었다)
    expect(authored.document).toContain(askWithHash);
  });

  test('fails loudly when writing fails after fail-soft grounding', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    await expect(writeAuthoredGoal('write failure', cwd, {
      // ⛔ slugFn 을 «안» 주면 기본값 generateMissionSlug 가 돌고, 그것이
      //   mission-registry.ts:190 에서 실물 streamLLM 을 부른다(네트워크 대기).
      //   📏 2026-08-29 실측: 주입 «전» 611초·매달림 → 주입 «후» ***494ms***.  R-TST25.
      slugFn: async () => 'write-failure-slug',
      ground: async () => { throw new Error('grounding unavailable'); },
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
    }, { write: () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
  }, 10_000);

  test('renders both existing clarifications with IDs, response shape, and a deferred state when unanswered', async () => {
    const authored = await authorGoal('Tests fail when the daemon starts.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [], genericSearchScope: true }),
    });
    const implementationQuestion = IMPLEMENTATION_TARGET_CLARIFICATION;
    const preservationQuestion = 'Clarification required before adding a preservation criterion: grounded code facts identify exported symbols only, not the behavior, signature, compatibility, or call path that must remain unchanged. Provide a failing test filename or one line from the error message that identifies the existing contract.';

    expect(authored.document.match(/^- Clarification:$/gm)).toHaveLength(2);
    expect(authored.document).toContain('  - id: implementation_target');
    expect(authored.document).toContain(`  - question: ${implementationQuestion}`);
    expect(authored.document).toContain('  - options:\n    - label: Failing test filename\n      description: Provide the focused test file that demonstrates the failure.\n    - label: One error-message line\n      description: Provide one error line that identifies the existing contract.');
    expect(authored.document).toContain(`  - answer: DEFERRED-UNTIL: ${implementationQuestion}`);
    expect(authored.document).toContain('  - id: preservation_contract');
    expect(authored.document).toContain(`  - question: ${preservationQuestion}`);
    expect(authored.document).toContain(`  - answer: DEFERRED-UNTIL: ${preservationQuestion}`);
    expect(authored.document.indexOf('  - id: implementation_target')).toBeLessThan(authored.document.indexOf('## PROBLEM'));
    expect(authored.document.indexOf('  - id: preservation_contract')).toBeGreaterThan(authored.document.indexOf('## ACCEPTANCE CRITERIA'));
  });

  test('renders injected answers in the existing clarification structures without deferred state', async () => {
    const authored = await authorGoal('Tests fail when the daemon starts.', {
      ...deps,
      clarificationAnswers: {
        'implementation_target': 'src/daemon-start.test.ts',
        'preservation_contract': 'Expected daemon start to reject invalid config',
      },
      ground: async () => ({ ...facts, persistentEvidence: [], genericSearchScope: true }),
    });

    expect(authored.document).toContain('  - id: implementation_target');
    expect(authored.document).toContain('  - answer: src/daemon-start.test.ts');
    expect(authored.document).toContain('  - id: preservation_contract');
    expect(authored.document).toContain('  - answer: Expected daemon start to reject invalid config');
    expect(authored.document).not.toContain('DEFERRED-UNTIL:');
  });

  test('persists structured slots through file reload and escapes multiline answers without changing their value', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-');
    const unsafeAnswer = 'src/daemon-start.test.ts\n## injected heading\n- injected list item';
    const result = await writeAuthoredGoal('Persist clarification slots.', cwd, {
      ...deps,
      clarificationAnswers: {
        implementation_target: unsafeAnswer,
        preservation_contract: '',
      },
      ground: async () => ({ ...facts, persistentEvidence: [], genericSearchScope: true }),
    }, { now: () => STAMP_AT });
    const persisted = readFileSync(result.path, 'utf8');

    expect(persisted).toContain('  - id: implementation_target');
    expect(persisted).toContain(`  - answer: ${JSON.stringify(unsafeAnswer)}`);
    expect(persisted).toContain('  - id: preservation_contract');
    expect(persisted).toContain('  - answer: ');
    expect(persisted).not.toContain('DEFERRED-UNTIL:');
    expect(persisted.match(/^## .+$/gm)?.filter((heading) => heading !== '## 왜 이 골인가')).toEqual([
      '## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호',
      '## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식',
      '## 메타데이터',
    ]);
  });

  test('emits no clarification structure or deferred state when no clarification is required', async () => {
    const authored = await authorGoal('Change src/example.ts.', {
      ...deps,
      ground: async () => ({ ...facts, grounded: false, codeFacts: [] }),
    });

    expect(authored.document).not.toContain('- Clarification:');
    expect(authored.document).not.toContain('  - id:');
    expect(authored.document).not.toContain('DEFERRED-UNTIL:');
  });

  test('writes real goal files, round-trips the parent origin, preserves clarification parsers, and omits Parent when absent', async () => {
    const parent = { goalFile: 'docs/goals/GOAL-parent.txt', questionId: 'implementation_target' };
    const withParentCwd = mkdtempSync(join(tmpdir(), 'goal-author-parent-'));
    const withoutParentCwd = mkdtempSync(join(tmpdir(), 'goal-author-no-parent-'));
    temporaryDirectories.push(withParentCwd, withoutParentCwd);
    const [withParentResult, withoutParentResult] = await Promise.all([
      writeAuthoredGoal('Trace the origin.', withParentCwd, { ...deps, parent, parentDocument: 'Parent goal\n- GoalId: 0123456789abcdef\n- RootIntent: Parent root purpose\n' }, { now: () => STAMP_AT }),
      writeAuthoredGoal('Trace the origin.', withoutParentCwd, deps, { now: () => STAMP_AT }),
    ]);
    const withParent = readFileSync(withParentResult.path, 'utf8');
    const withoutParent = readFileSync(withoutParentResult.path, 'utf8');

    expect(parseGoalAuthorParent(withParent)).toEqual(parent);
    expect(parseGoalAuthorParent(withoutParent)).toBeNull();
    expect(withoutParent.match(/^- Parent:/gm) ?? []).toHaveLength(0);
    expect(parseGoalAuthorClarifications(withParent)).toEqual(parseGoalAuthorClarifications(withoutParent));
    expect(parseGoalDocumentClarifications(withParent)).toEqual(parseGoalDocumentClarifications(withoutParent));
  });

  // Observed focused callback duration: 1.75s (one run); each validation child timeout of 5s leaves at least 3.25s headroom.
  // 인자 두 가지를 «루프»로 돈다 — 최악은 5s×2=10s ⇒ 바깥 예산은 20s (최악의 합 + 여유 10s).
  test('self author CLI rejects either parent option when its pair is missing', () => {
    for (const args of [
      ['--parent-goal-file', 'docs/goals/GOAL-parent.txt'],
      ['--parent-question-id', 'implementation_target'],
    ]) {
      // Measured callback: 1.75s for both argument cases; each 5s validation child timeout leaves at least 3.25s headroom.
      const result = Bun.spawnSync({
        cmd: ['bun', 'bin/elanous.mjs', '--test', 'self', 'author', 'Trace the origin.', ...args],
        cwd: process.cwd(),
        env: { ...process.env, ELANOUS_STATE_DIR: join(tmpdir(), `goal-author-parent-state-${crypto.randomUUID()}`) },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5_000,
      });
      const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain('parent goal file and parent question id must be supplied together');
    }
  // ⛔ 인자 두 가지를 «루프»로 돈다 — 최악은 5s×2=10s. ⇒ 바깥 = 10s + 여유(10s). 실측 1.75s.
  }, 20_000);

  test('puts a concrete clarification at the first generic-search body line, labels later candidates as unverified guesses, and preserves identified output', async () => {
    const generic = await authorGoal('Tests fail when the daemon starts.', {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [], genericSearchScope: true }),
    });
    const clarification = IMPLEMENTATION_TARGET_CLARIFICATION;
    const label = 'Unverified guesses from general search terms (not implementation targets until traced):';
    const candidate = 'Candidate requiring path tracing: `src/example.ts`';
    const firstGenericBodyLine = generic.document.split('\n').slice(5).find((line) => line.trim().length > 0);

    expect(firstGenericBodyLine).toBe('- Clarification:');
    expect(generic.document).toContain('  - id: implementation_target');
    expect(generic.document).toContain(`  - question: ${clarification}`);
    expect(generic.document).toContain('  - options:\n    - label: Failing test filename\n      description: Provide the focused test file that demonstrates the failure.\n    - label: One error-message line\n      description: Provide one error line that identifies the existing contract.');
    expect(generic.document).toContain(`  - answer: DEFERRED-UNTIL: ${clarification}`);
    expect(generic.document.indexOf(clarification)).toBeLessThan(generic.document.indexOf('## PROBLEM'));
    expect(generic.document.indexOf(clarification)).toBeLessThan(generic.document.indexOf('Original ask (verbatim, unmodified):'));
    expect(generic.document).not.toContain(label);
    expect(generic.document).not.toContain(candidate);
    expect(generic.document).toContain('Candidate leads remain in the repository evidence above; do not select or implement them until the requested clarification traces a behavior and call path.');
    expect(generic.document).toMatch(/failing test filename|error message/);
    expect(generic.document).toContain('grounded: 1 unverified code candidate (general search scope)');

    const identified = await authorGoal('Change src/example.ts.', deps);
    const identifiedWhatToBuild = identified.document.slice(identified.document.indexOf('## WHAT TO BUILD'), identified.document.indexOf('## ACCEPTANCE CRITERIA'));
    expect(identifiedWhatToBuild).not.toContain('Candidate requiring path tracing:');
    expect(identified.document).not.toContain(clarification);
    expect(identified.document).not.toContain(label);
    expect(identified.document).not.toContain('grounded: 1 unverified code candidate (general search scope)');
  });
});

// ⭐ 73차 — 판정기(무인 리뷰 위험 등)가 「사람의 ask 만」 볼 수 있게 export 한 seam.
//   📏 그 판정의 riskHits 643 중 442(68.7%)가 «저작기·접지가 쓴 절»에서 왔다(사람 의도가 아니다).
describe('verbatimOriginalAsk — 골 문서에서 «사람의 ask 만» 떼어 낸다', () => {
  const doc = [
    '## PROBLEM',
    'Situation: GROUNDED — verified production authoring path.',
    '',
    ORIGINAL_ASK_MARKER,
    '```',
    '대상 경로: src/a.ts',
    '이 함수를 고친다.',
    '```',
    '',
    '## ACCEPTANCE CRITERIA',
    '- Do not replace, rewrite, summarize the verbatim ask.',
  ].join('\n');

  test('ask 블록만 돌려준다 — 접지 프로즈·저작기 정책은 «안» 섞인다', () => {
    const ask = verbatimOriginalAsk(doc);
    expect(ask).toBe('대상 경로: src/a.ts\n이 함수를 고친다.');
    expect(ask).not.toContain('production');
    expect(ask).not.toContain('rewrite');
  });

  test('추출 시점의 문서 범위를 함께 돌려주되 문자열 API는 보존한다', () => {
    const extracted = extractVerbatimOriginalAsk(doc);
    expect(extracted).toEqual({
      ask: '대상 경로: src/a.ts\n이 함수를 고친다.',
      range: { start: doc.indexOf('대상 경로: src/a.ts'), end: doc.indexOf('대상 경로: src/a.ts') + '대상 경로: src/a.ts\n이 함수를 고친다.'.length },
    });
    expect(verbatimOriginalAsk(doc)).toBe(extracted!.ask);
  });

  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('preserves %s source ask line endings and its range', (_name, newline) => {
    const ask = `first line${newline}second line`;
    const document = [
      '## PROBLEM',
      ORIGINAL_ASK_MARKER,
      '```',
      ask,
      '```',
      '## ACCEPTANCE CRITERIA',
    ].join(newline);

    const extracted = extractVerbatimOriginalAsk(document);
    expect(extracted).toEqual({
      ask,
      range: { start: document.indexOf(ask), end: document.indexOf(ask) + ask.length },
    });
    expect(verbatimOriginalAsk(document)).toBe(ask);
  });

  test('표지가 없으면 «던지지 않고» null 을 준다', () => {
    expect(verbatimOriginalAsk('## PROBLEM\n본문뿐')).toBeNull();
    expect(extractVerbatimOriginalAsk('## PROBLEM\n본문뿐')).toBeNull();
  });
});

describe('goal-file lint origins', () => {
  const tags: readonly GoalFileLintTag[] = [
    'canonical-structure', 'evidence-section', 'boundary-size', 'launch-branch', 'unanswered-clarification',
    'shell-damage', 'traced-path', 'grounding-evidence', 'empty-result-population',
    'decision-signal-numeric-source', 'decision-signal-numeric-coverage', 'decision-signal-proxy-expectation',
    'out-of-target-requirement', 'heading-form-marker', 'blanket-invariant', 'self-question-subject',
    'artifact-launch-declaration', 'all-negative-signals', 'unreadable-signals', 'alternative-signals', 'count-observation',
    'identifier-name-observation', 'self-reported-observation', 'default-invocation-observation', 'release-note',
  ];

  test('has one explicit origin entry for every existing lint tag', () => {
    expect(Object.keys(GOAL_FILE_LINT_ORIGINS).sort()).toEqual([...tags].sort());
    expect(Object.values(GOAL_FILE_LINT_ORIGINS).filter((origin) => origin.kind === 'known-incident')).toHaveLength(16);
    expect(Object.values(GOAL_FILE_LINT_ORIGINS).filter((origin) => origin.kind === 'unknown-origin')).toHaveLength(9);
    for (const origin of Object.values(GOAL_FILE_LINT_ORIGINS)) {
      if (origin.kind === 'known-incident') {
        expect(origin.incident).not.toHaveLength(0);
      } else {
        expect(origin).toEqual({ kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' });
      }
    }
  });

  // ⭐ 2026-09-25 — git 이력을 읽는 출처 시험은 `goal-author-origins.test.ts` 로 옮겼다(공개본엔 이력·내부 문서가 없다 · release/public-export.yaml exclude).

  test('renders a repository-backed known incident without changing the lint judgment', () => {
    const finding = lintGoalFile('## PROBLEM', 'main').find(({ tag }) => tag === 'canonical-structure');
    expect(finding).toEqual(expect.objectContaining({ level: 'WARN', tag: 'canonical-structure', message: expect.any(String) }));
    expect(formatGoalFileLintFinding(finding!)).toContain('origin: nine required sections blocked handwritten goals (reference: git:d2c18dd58 (#6789))');
  });

  test('keeps unverified origins explicitly unknown', () => {
    expect(formatGoalFileLintFinding({ level: 'WARN', tag: 'launch-branch', message: 'branch warning' })).toContain('origin: ORIGIN-UNKNOWN');
  });

  test('falsifies known-incident provenance: mutating canonical-structure to unknown fails this assertion', () => {
    expect(GOAL_FILE_LINT_ORIGINS['canonical-structure']).toEqual({
      kind: 'known-incident',
      incident: 'nine required sections blocked handwritten goals',
      reference: 'git:d2c18dd58 (#6789)',
    });
  });
});

describe('lintGoalFile · release notes', () => {
  const releaseFindings = (section: string) => lintGoalFile(`${GOAL_WITHOUT_ARTIFACT_LAUNCH_DECLARATION}\n\n${section}`, 'main')
    .filter((finding) => finding.tag === 'release-note');
  const valid = '## 릴리스 노트\n- 한 줄: Improve goal lint\n- 종류: feat\n- 문서: 없음(internal tooling)\n- 대상: next';

  test('accepts a section the release parser accepts', () => {
    expect(parseReleaseNoteSection(valid).problems).toEqual([]);
    expect(releaseFindings(valid)).toEqual([]);
  });

  test('warns about an unrecognized kind and suggests feat instead of feature without blocking launch', () => {
    const invalid = valid.replace('종류: feat', '종류: feature');
    expect(parseReleaseNoteSection(invalid).problems).toEqual(['종류']);
    const findings = releaseFindings(invalid);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.level).toBe('WARN');
    expect(findings[0]!.message).toInclude('종류');
    expect(findings[0]!.message).toInclude('feature → feat');
  });

  test('warns about missing documentation and target fields', () => {
    const invalid = valid.replace('- 문서: 없음(internal tooling)\n- 대상: next', '');
    expect(parseReleaseNoteSection(invalid).problems).toEqual(['문서', '대상']);
    const findings = releaseFindings(invalid);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.message)).toEqual([expect.stringContaining('문서'), expect.stringContaining('대상')]);
    expect(findings.every((finding) => finding.level === 'WARN')).toBe(true);
  });

  test('warns for the referenced fix goal shape without documentation or target', () => {
    const findings = releaseFindings('## 릴리스 노트\n- 한 줄: Fix model doctor disagreement\n- 종류: fix');
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.level === 'WARN')).toBe(true);
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('문서 invalid or missing'), expect.stringContaining('대상 invalid or missing'),
    ]);
  });

  test('warns when a public release line contains Korean', () => {
    for (const kind of ['feat', 'fix', 'security']) {
      const findings = releaseFindings(valid.replace('종류: feat', `종류: ${kind}`).replace('Improve goal lint', '골 린트 개선'));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ level: 'WARN', message: expect.stringContaining('영어로') });
    }
  });

  test('warns about Korean in a public line even when the parser also reports missing fields', () => {
    const findings = releaseFindings('## 릴리스 노트\n- 한 줄: 골 린트 개선\n- 종류: fix');
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('문서 invalid or missing'),
      expect.stringContaining('대상 invalid or missing'),
      expect.stringContaining('영어로'),
    ]);
  });

  test('ignores a release-note heading inside a fenced example', () => {
    expect(releaseFindings('```md\n## 릴리스 노트\n- 종류: feature\n```')).toEqual([]);
  });

  test('allows a Korean line for internal changes', () => {
    expect(releaseFindings(valid.replace('종류: feat', '종류: internal').replace('Improve goal lint', '골 린트 개선'))).toEqual([]);
  });

  test('leaves a goal without a release-note section silent', () => {
    expect(releaseFindings('')).toEqual([]);
  });
});

describe('lintGoalFile · goal types', () => {
  const typedDocument = (goalType: string | null, sections: readonly string[]) => [
    'Goal title', '- GoalId: 0123456789abcdef', '- RootIntent: test',
    ...(goalType === null ? [] : [`- GoalType: ${goalType}`]),
    '', ...sections,
  ].join('\n');
  const researchSections = [
    '## PROBLEM', 'problem', '', '## WHAT TO BUILD', 'build', '',
    '## ACCEPTANCE CRITERIA', 'criteria', '', '## REQUIRED EVIDENCE', '- [proof] present', '',
    '## SCOPE BOUNDARY', 'boundary', '', '## 불변식', 'invariant', '', '## 판정 신호', 'signal', '',
  ];

  test('does not require TRACED PATHS for research, document, or operate goals', () => {
    for (const goalType of ['research', 'document', 'operate']) {
      expect(lintGoalFile(typedDocument(goalType, researchSections), 'main')).not.toContainEqual(expect.objectContaining({ message: 'missing required section: ## TRACED PATHS' }));
    }
  });

  test('defaults untyped goals to implement and still requires TRACED PATHS', () => {
    expect(lintGoalFile(typedDocument(null, researchSections), 'main')).toContainEqual({
      level: 'WARN', tag: 'canonical-structure', message: 'missing required section: ## TRACED PATHS',
    });
  });

  test('warns for unavailable traced-path evidence only when a non-implement goal type does not require the section', () => {
    const unavailableEvidence = 'Evidence unavailable — grounding found no persistent evidence and the cause remains undifferentiated. Grounding needs behavior and causation, not only locations: state what the target code does today and why that is a problem, and name a function, constant, or type that the target file exports. A pure-addition ask ("also record field X") often fails here because it names no current behavior to ground. Re-authoring the same input may also produce different evidence, but try that first. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
    const sectionsWithUnavailableEvidence = [
      ...researchSections.slice(0, 8),
      '## TRACED PATHS', `- ${unavailableEvidence}`, '',
      ...researchSections.slice(8),
    ];
    const cases = [
      { goalType: 'research', level: 'WARN' as const, message: `${unavailableEvidence} GoalType research does not require ## TRACED PATHS.` },
      { goalType: 'implement', level: 'ERROR' as const, message: unavailableEvidence },
      { goalType: null, level: 'ERROR' as const, message: unavailableEvidence },
    ];

    for (const { goalType, level, message } of cases) {
      expect(lintGoalFile(typedDocument(goalType, sectionsWithUnavailableEvidence), 'main')).toContainEqual({
        level,
        tag: 'grounding-evidence',
        message,
      });
    }
  });

  test('keeps PROBLEM an ERROR for research goals', () => {
    expect(lintGoalFile(typedDocument('research', researchSections.slice(2)), 'main')).toContainEqual({
      level: 'ERROR', tag: 'canonical-structure', message: 'missing required section: ## PROBLEM',
    });
  });

  test('rejects unknown goal types', () => {
    expect(lintGoalFile(typedDocument('unknown', researchSections), 'main')).toContainEqual({
      level: 'ERROR', tag: 'canonical-structure', message: 'GoalType must be one of: implement, research, document, operate',
    });
  });

  test('distinguishes canonical-structure checks without changing tags, levels, messages, or readable output', () => {
    const missingProblem = typedDocument('research', researchSections.slice(2));
    const reversedSections = [...researchSections];
    [reversedSections[0], reversedSections[2]] = [reversedSections[2], reversedSections[0]];
    const cases = [
      {
        document: typedDocument('unknown', researchSections),
        expected: { level: 'ERROR', tag: 'canonical-structure', message: 'GoalType must be one of: implement, research, document, operate', check: 'invalid-goal-type' },
      },
      {
        document: missingProblem,
        expected: { level: 'ERROR', tag: 'canonical-structure', message: 'missing required section: ## PROBLEM', check: 'missing-required-section' },
      },
      {
        document: typedDocument('research', reversedSections),
        expected: { level: 'ERROR', tag: 'canonical-structure', message: expect.stringContaining('required sections must appear in canonical order'), check: 'required-section-order' },
      },
    ] as const;

    for (const { document, expected } of cases) {
      const finding = lintGoalFile(document, 'main').find((candidate) => candidate.check === expected.check);
      expect(finding).toMatchObject(expected);
      expect(formatGoalFileLintFinding(finding!)).toContain(`[canonical-structure] ${finding!.message}`);
    }
  });

  test('classifies ask-section information findings without changing their compatible enumerable shape', () => {
    const document = [
      'GoalType: research', '',
      ORIGINAL_ASK_MARKER, '```', '경계: 유지 범위', '```', '',
      '## PROBLEM', 'problem', '',
      '## WHAT TO BUILD', 'build', '',
      '## ACCEPTANCE CRITERIA', 'criteria', '',
      '## REQUIRED EVIDENCE', 'evidence', '',
      '## TRACED PATHS', 'paths', '',
      '## SCOPE BOUNDARY', '',
      '## 답하지 못하는 것', 'limits', '',
      '## 불변식', 'keep', '',
      '## 판정 신호', 'signals',
    ].join('\n');
    const finding = lintGoalFile(document, 'main').find((candidate) => candidate.message.startsWith('Information: ask has 1 format-matching "경계"'));

    expect(finding).toMatchObject({
      level: 'WARN',
      tag: 'canonical-structure',
      message: expect.stringMatching(/^Information: ask has 1 format-matching "경계"/),
      check: 'ask-section-relationship',
    });
    expect(Object.keys(finding!)).toEqual(['level', 'tag', 'message']);
    expect(Object.getOwnPropertyDescriptor(finding!, 'check')).toMatchObject({
      value: 'ask-section-relationship',
      enumerable: false,
    });
  });

  test('falsifies canonical check detail: removing a branch detail fails this assertion', () => {
    expect(lintGoalFile(typedDocument('unknown', researchSections), 'main')).toContainEqual(expect.objectContaining({ check: 'invalid-goal-type' }));
  });
});

describe('lintGoalFile · out-of-target requested requirements', () => {
  const canonicalDocument = (targetLabel: string, criteria: readonly string[]) => [
    targetLabel,
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', ...criteria, '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '', '## 판정 신호', 'x', '',
  ].join('\n');
  const outOfTargetFindings = (document: string) => lintGoalFile(document, 'main')
    .filter((finding) => finding.tag === 'out-of-target-requirement');

  test('warns once with every out-of-target path from requested criteria without creating an ERROR', () => {
    const findings = outOfTargetFindings(canonicalDocument('대상 경로: src/a.ts', [
      '- Checkable requested criterion: src/b.ts와 src/c.ts를 고친다.',
    ]));

    expect(findings).toEqual([{
      level: 'WARN',
      tag: 'out-of-target-requirement',
      message: expect.stringContaining('src/b.ts'),
    }]);
    expect(findings[0]?.message).toContain('src/c.ts');
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR' }));
  });

  test('ignores out-of-target paths in preservation criteria while requested criteria remain present', () => {
    const document = canonicalDocument('대상 경로: src/a.ts', [
      '- Checkable requested criterion: src/a.ts를 고친다.',
      '- Checkable preservation criterion: src/b.ts는 유지한다.',
    ]);

    expect(document.match(/^- Checkable requested criterion:/gm)).toHaveLength(1);
    expect(outOfTargetFindings(document)).toEqual([]);
  });

  test('does not warn when requested criteria name only target paths', () => {
    const document = canonicalDocument('대상 경로: src/a.ts · src/b.ts', [
      '- Checkable requested criterion: src/a.ts와 src/b.ts를 고친다.',
    ]);

    expect(document.match(/^- Checkable requested criterion:/gm)).toHaveLength(1);
    expect(outOfTargetFindings(document)).toEqual([]);
  });

  test('does not warn without a target-path label', () => {
    expect(outOfTargetFindings(canonicalDocument('goal title', [
      '- Checkable requested criterion: src/b.ts를 고친다.',
    ]))).toEqual([]);
  });
});

describe('lintGoalFile · all-negative-signals presence vocabulary', () => {
  const canonicalDocument = (askSignals: string) => [
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '',
    '## 판정 신호', askSignals, '',
  ].join('\n');
  const allNegativeAsk = [
    '판정 신호: 조건 = 인자 누락 호출; 관측 = JSON 의 allNegative; 기대 = 없다',
    '판정 신호: 조건 = 실패 칸; 관측 = 통과 여부; 기대 = 0',
    '판정 신호: 조건 = 제거된 경로; 관측 = 산출; 기대 = 사라졌다',
  ].join('\n');
  const presenceTermsFromSource = () => {
    const source = readFileSync(new URL('./goal-author.ts', import.meta.url), 'utf8');
    const presenceSource = /const PRESENCE_EXPECTATION = \/([^/\n]+)\/u;/.exec(source)?.[1];
    expect(presenceSource).toBeTruthy();
    return presenceSource!.split('|').filter((term) => term.length > 0);
  };
  const allNegativeFinding = (document: string) => lintGoalFile(document, 'main')
    .find((candidate) => candidate.tag === 'all-negative-signals');

  test('lists source-derived presence terms on an all-negative decision-signal warning', () => {
    const terms = presenceTermsFromSource();
    const finding = allNegativeFinding(canonicalDocument(allNegativeAsk));
    expect(finding).toEqual({
      level: 'WARN',
      tag: 'all-negative-signals',
      message: expect.stringContaining('## 판정 신호 explicitly expects only absence; revise the signal'),
    });
    expect(terms.some((term) => finding?.message.includes(term))).toBe(true);
    for (const term of terms) {
      expect(finding?.message).toContain(`\`${term}\``);
    }
    expect(finding?.message).toBe(allNegativeSignalsLintMessage());
    expect(formatGoalFileLintFinding(finding!)).toContain(`[all-negative-signals] ${finding!.message}`);
    expect(formatGoalFileLintFinding(finding!)).toContain('origin: ORIGIN-UNKNOWN');
  });

  test('drops the all-negative warning when one expected result uses a source presence term', () => {
    const [presenceTerm] = presenceTermsFromSource();
    const positive = `${allNegativeAsk}\n판정 신호: 조건 = 평범한 새 경로; 관측 = 선언; 기대 = ${presenceTerm}`;
    expect(allNegativeFinding(canonicalDocument(positive))).toBeUndefined();
    expect(allNegativeFinding(canonicalDocument(allNegativeAsk))).toEqual(expect.objectContaining({
      tag: 'all-negative-signals',
    }));
  });

  test('carries an added presence term from the classifier regex into the warning copy', () => {
    const added = '늘어난낱말';
    const extended = new RegExp([...presenceTermsFromSource(), added].join('|'), 'u');
    expect(allNegativeSignalsLintMessage(extended)).toContain(added);
    expect(allNegativeFinding(canonicalDocument(allNegativeAsk))?.message).toBe(allNegativeSignalsLintMessage());
  });

  test('falsifies a handwritten all-negative message: a fixed string misses an added presence term', () => {
    const added = '늘어난낱말';
    const extended = new RegExp([...presenceTermsFromSource(), added].join('|'), 'u');
    const handwritten = '## 판정 신호 has no presence or persistence expectation';
    expect(allNegativeSignalsLintMessage(extended)).toContain(added);
    expect(handwritten.includes(added)).toBe(false);
  });

  // ⛔⭐ 실물 사건(2026-09-07 · PR #15791): 판정 신호에
  //    「관측 = 그 파일이 «등록한 시험 이름 목록»」이라 적었더니 자식이
  //    `for (const name of preserved) expect(src).toContain(name)` 을 만들었다.
  //    ⇒ 그 이름이 붙은 시험들의 «본문을 전부 비워도» 통과한다.
  //    📏 그 문면이 골 문서 3,164개 중 «59개»에 있었다.
  test('flags an observation that measures identifier names, and does not flag a behavioral one', () => {
    const names = '판정 신호: 조건 = 시험 파일을 돌린다; 관측 = 그 파일이 등록한 시험 이름 목록; 기대 = 전부 여전히 있다';
    expect(lintGoalFile(canonicalDocument(names), 'main')).toContainEqual({
      level: 'WARN',
      tag: 'identifier-name-observation',
      message: '## 판정 신호 observation measures the presence of identifier names (test/function/field names) rather than behavior; a child satisfies it most cheaply with a test that greps its own source, which passes even if every named test body is emptied. Observe what those names are supposed to do instead.',
    });
    // ⭐ 음성 — 같은 축을 «행동»으로 재면 잡지 않는다. 이 줄이 없으면 「전부 잡는 자」와 구별이 안 된다.
    const behavior = '판정 신호: 조건 = 넓은 배치와 좁은 배치를 그린다; 관측 = 그 두 자리가 읽는 상태 변수; 기대 = 같은 하나다';
    expect(lintGoalFile(canonicalDocument(behavior), 'main')
      .filter((finding) => finding.tag === 'identifier-name-observation')).toEqual([]);
    // ⭐ 그리고 「이름」이 «조건» 칸에 있는 것은 문제가 아니다 — 관측 칸만 본다.
    const nameInCondition = '판정 신호: 조건 = renderDigest 라는 이름의 함수를 부른다; 관측 = 그 반환값; 기대 = 비어 있지 않다';
    expect(lintGoalFile(canonicalDocument(nameInCondition), 'main')
      .filter((finding) => finding.tag === 'identifier-name-observation')).toEqual([]);
  });

  test('leaves neighboring decision-signal lint copy unchanged', () => {
    const alternatives = '판정 신호: 조건 = 요청문; 관측 = 프로브 반환값; 기대 = A 거나 B 거나 C 중 하나가 있다';
    const count = '판정 신호: 조건 = 요청문; 관측 = 시험 «개수»; 기대 = 줄지 않는다';
    expect(lintGoalFile(canonicalDocument(alternatives), 'main')).toContainEqual({
      level: 'WARN',
      tag: 'alternative-signals',
      message: '## 판정 신호 expected result opens alternative branches',
    });
    expect(lintGoalFile(canonicalDocument(count), 'main')).toContainEqual({
      level: 'WARN',
      tag: 'count-observation',
      message: '## 판정 신호 observation measures a count rather than content',
    });
    expect(lintGoalFile(canonicalDocument('0건이면 통과한다.'), 'main')).toContainEqual({
      level: 'WARN',
      tag: 'empty-result-population',
      message: '## 판정 신호 permits an empty result to pass without declaring a population',
    });
  });
});

describe('lintGoalFile · alternative-signals 거나 isolation', () => {
  const canonicalDocument = (askSignals: string) => [
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '',
    '## 판정 신호', askSignals, '',
  ].join('\n');
  const tagsOf = (expectedResult: string) => lintGoalFile(
    canonicalDocument(`판정 신호: 조건 = 요청문; 관측 = 산출에 붙은 lint 태그 목록; 기대 = ${expectedResult}`),
    'main',
  ).map((finding) => finding.tag);
  const alternativeFinding = (expectedResult: string) => lintGoalFile(
    canonicalDocument(`판정 신호: 조건 = 요청문; 관측 = 산출에 붙은 lint 태그 목록; 기대 = ${expectedResult}`),
    'main',
  ).find((finding) => finding.tag === 'alternative-signals');

  test('does not warn when 거나 is an intra-word ending in 더하거나 고친', () => {
    expect(tagsOf('[ledger-gate] PASS — 이 브랜치가 더하거나 고친 원장 항목이 없다.')).not.toContain('alternative-signals');
    expect(alternativeFinding('[ledger-gate] PASS — 이 브랜치가 더하거나 고친 원장 항목이 없다.')).toBeUndefined();
  });

  test('still warns on named alternative expected results including attached 거나', () => {
    // visible omission: 원문 「아래 진짜 사례」의 구체 문면은 제공되지 않았다.
    // 기존 fixture(또는·중 하나·아무거나·standalone 거나)와 판정 신호가 이름으로 댄 「통과하거나 실패한다」만 쓴다.
    expect(alternativeFinding('통과하거나 실패한다')).toEqual({
      level: 'WARN',
      tag: 'alternative-signals',
      message: '## 판정 신호 expected result opens alternative branches',
    });
    expect(tagsOf('통과하거나 실패한다')).toContain('alternative-signals');
    expect(tagsOf('A 또는 B 가 있다')).toContain('alternative-signals');
    expect(tagsOf('C 중 하나가 있다')).toContain('alternative-signals');
    expect(tagsOf('아무거나 있다')).toContain('alternative-signals');
    expect(tagsOf('A 거나 B 가 있다')).toContain('alternative-signals');
  });

  test('falsifies an always-false alternative classifier: 통과하거나 실패한다 would then miss the warning', () => {
    expect(tagsOf('통과하거나 실패한다')).toContain('alternative-signals');
  });

  test('leaves PRESENCE_EXPECTATION and neighboring lint copy unchanged', () => {
    const source = readFileSync(new URL('./goal-author.ts', import.meta.url), 'utf8');
    expect(source).toContain('const PRESENCE_EXPECTATION = /있다|여전히|유지|크다|이상/u;');
    expect(lintGoalFile(canonicalDocument('판정 신호: 조건 = 요청문; 관측 = 시험 «개수»; 기대 = 줄지 않는다'), 'main')).toContainEqual({
      level: 'WARN',
      tag: 'count-observation',
      message: '## 판정 신호 observation measures a count rather than content',
    });
    expect(lintGoalFile(canonicalDocument('판정 신호: 조건 = 인자 누락 호출; 관측 = JSON 의 allNegative; 기대 = 없다'), 'main')).toContainEqual({
      level: 'WARN',
      tag: 'all-negative-signals',
      message: allNegativeSignalsLintMessage(),
    });
  });
});

describe('lintGoalFile · empty-result decision-signal populations', () => {
  const canonicalDocument = (decisionSignal: string) => [
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '', '## 판정 신호', decisionSignal, '',
  ].join('\n');

  test('warns without blocking when a zero-result pass signal omits its population', () => {
    const findings = lintGoalFile(canonicalDocument('0건이면 통과한다.'), 'main');
    expect(findings).toContainEqual({
      level: 'WARN',
      tag: 'empty-result-population',
      message: '## 판정 신호 permits an empty result to pass without declaring a population',
    });
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR', tag: 'empty-result-population' }));
  });

  test('does not warn when a zero-result pass signal declares one or more candidates', () => {
    expect(lintGoalFile(canonicalDocument('후보가 하나 이상인 상태에서 0건이면 통과한다.'), 'main'))
      .not.toContainEqual(expect.objectContaining({ tag: 'empty-result-population' }));
  });

  test('does not warn for a decision signal without an empty-result pass claim', () => {
    expect(lintGoalFile(canonicalDocument('검증 명령이 성공하면 통과한다.'), 'main'))
      .not.toContainEqual(expect.objectContaining({ tag: 'empty-result-population' }));
  });
});

describe('lintGoalFile · decision-signal numeric source provenance', () => {
  const canonicalDocument = (decisionSignal: string, followingSection = '') => [
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '',
    ...(decisionSignal ? ['## 판정 신호', decisionSignal, ''] : []),
    followingSection,
  ].join('\n');

  const numericSourceFindings = (document: string) => lintGoalFile(document, 'main')
    .filter((finding) => finding.tag === 'decision-signal-numeric-source');

  const numericCoverageFindings = (document: string) => lintGoalFile(document, 'main')
    .filter((finding) => finding.tag === 'decision-signal-numeric-coverage');

  test('warns independently when Arabic Expected-result numbers omit author-provided source or coverage', () => {
    const document = canonicalDocument('- Expected result: 1 matching document remains.');
    expect(numericSourceFindings(document)).toEqual([{
      level: 'WARN',
      tag: 'decision-signal-numeric-source',
      message: '## 판정 신호 uses Arabic digits in Expected result without a non-empty source entry (for example, `- 숫자 출처: measurement output`).',
    }]);
    expect(numericCoverageFindings(document)).toEqual([{
      level: 'WARN',
      tag: 'decision-signal-numeric-coverage',
      message: '## 판정 신호 uses Arabic digits in Expected result without a non-empty coverage entry (for example, `- 숫자 적용 범위: all matching documents`).',
    }]);
  });

  test('accepts independently authored source and coverage entries', () => {
    const sourceOnly = canonicalDocument('- Expected result: 1 matching document remains.\n- 숫자 출처: measurement output');
    const coverageOnly = canonicalDocument('- Expected result: 1 matching document remains.\n- 숫자 적용 범위: all matching documents');
    const both = canonicalDocument('- Expected result: 1 matching document remains.\n- 숫자 출처: measurement output\n- 숫자 적용 범위: all matching documents');
    expect(numericSourceFindings(sourceOnly)).toEqual([]);
    expect(numericCoverageFindings(sourceOnly)).toHaveLength(1);
    expect(numericSourceFindings(coverageOnly)).toHaveLength(1);
    expect(numericCoverageFindings(coverageOnly)).toEqual([]);
    expect(numericSourceFindings(both)).toEqual([]);
    expect(numericCoverageFindings(both)).toEqual([]);
  });

  test('does not inspect non-acceptance digits or entries outside the decision-signal section', () => {
    const document = canonicalDocument('- Observation: src/example.ts:7 is inspected.\n- Command: `bun test --retry 3`', '## 다음 절\n- Expected result: 7 matching documents remain.');
    expect(numericSourceFindings(document)).toEqual([]);
    expect(numericCoverageFindings(document)).toEqual([]);
  });

  test('preserves the unrelated empty-result-population finding when numeric evidence is added', () => {
    const withoutResponse = lintGoalFile(canonicalDocument('- Expected result: 0건이면 통과한다.'), 'main');
    const withResponse = lintGoalFile(canonicalDocument('- Expected result: 0건이면 통과한다.\n- 숫자 출처: measurement output\n- 숫자 적용 범위: all matching documents'), 'main');
    const populationFinding = {
      level: 'WARN',
      tag: 'empty-result-population',
      message: '## 판정 신호 permits an empty result to pass without declaring a population',
    } as const;
    expect(withoutResponse).toContainEqual(populationFinding);
    expect(withResponse).toContainEqual(populationFinding);
  });

  test('warns exactly once when an Expected result contains multiple Arabic digits', () => {
    expect(numericSourceFindings(canonicalDocument('- Expected result: 2 states and 3 events yield 6 cells.'))).toHaveLength(1);
  });

  test('does not inspect Korean numerals without Arabic digits', () => {
    const document = canonicalDocument('- Expected result: 행 두 개가 존재하는지 확인한다.');
    expect(numericSourceFindings(document)).toEqual([]);
    expect(numericCoverageFindings(document)).toEqual([]);
  });

  test('does not warn when the decision-signal section is absent', () => {
    expect(numericSourceFindings(canonicalDocument('', '## 다음 절\n검사 대상은 7개다.'))).toEqual([]);
  });

  test('does not warn for digits after the next peer heading', () => {
    expect(numericSourceFindings(canonicalDocument('검사 대상이 존재하는지 확인한다.', '## 다음 절\n검사 대상은 7개다.'))).toEqual([]);
  });
});

describe('lintGoalFile · heading-form author markers', () => {
  const canonicalDocument = (askLines: readonly string[]) => [
    '## PROBLEM', 'x', '',
    '## WHAT TO BUILD', 'Original ask (verbatim, unmodified):', '````', ...askLines, '````', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '', '## 판정 신호', 'x', '',
  ].join('\n');
  const headingFindings = (document: string) => lintGoalFile(document, 'main')
    .filter((finding) => finding.tag === 'heading-form-marker');

  test('emits non-blocking findings for ineffective H1 and exact H2 headings without promoting either', () => {
    const findings = headingFindings(canonicalDocument([
      '# 불변식', 'src/heading-invariant.ts remains unchanged.',
      '## 경계', 'src/heading-boundary.ts만 고친다.',
    ]));

    expect(findings).toEqual([
      {
        level: 'WARN',
        tag: 'heading-form-marker',
        message: 'Ask uses a heading-form invariant; headings are diagnostic only and do not create a invariant candidate. source="# 불변식\\nsrc/heading-invariant.ts remains unchanged." truncated=false; corrected example: 불변식: src/example.ts remains unchanged.',
      },
      {
        level: 'WARN',
        tag: 'heading-form-marker',
        message: 'Ask uses a heading-form boundary; headings are diagnostic only and do not create a boundary candidate. source="## 경계\\nsrc/heading-boundary.ts만 고친다." truncated=false; corrected example: 경계: src/example.ts만 고친다.',
      },
    ]);
    expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR' }));
  });

  test('distinguishes valid inline or absent markers from ineffective headings and deduplicates inline content from mixed headings', () => {
    expect(headingFindings(canonicalDocument([
      '불변식: src/inline-invariant.ts remains unchanged.',
      '경계: src/inline-boundary.ts만 고친다.',
    ]))).toEqual([]);
    expect(headingFindings(canonicalDocument(['경계와 불변식은 산문으로만 언급한다.']))).toEqual([]);
    expect(headingFindings(canonicalDocument([
      '# 불변식', 'src/inline-invariant.ts remains unchanged.', '불변식: src/inline-invariant.ts remains unchanged.',
      '# 경계', 'src/inline-boundary.ts만 고친다.', '경계: src/inline-boundary.ts만 고친다.',
      '### 경계', 'src/second-heading-boundary.ts만 고친다.',
    ]))).toEqual([{
      level: 'WARN',
      tag: 'heading-form-marker',
      message: 'Ask uses a heading-form boundary; headings are diagnostic only and do not create a boundary candidate. source="### 경계\\nsrc/second-heading-boundary.ts만 고친다." truncated=false; corrected example: 경계: src/example.ts만 고친다.',
    }]);
  });

  test('reports only parser-recognized inline invariants, preserving heading-form diagnostics and candidate semantics', () => {
    const cases = [
      { label: 'inline-only', ask: ['불변식: src/one.ts remains unchanged.', '불변식: src/two.ts remains unchanged.'], count: 2, headingWarnings: 0 },
      { label: 'heading-only', ask: ['## 불변식', '- src/heading.ts remains unchanged.'], count: 0, headingWarnings: 1 },
      { label: 'mixed-form', ask: ['불변식: src/inline.ts remains unchanged.', '## 불변식', '- src/heading.ts remains unchanged.'], count: 1, headingWarnings: 1 },
      { label: 'absent', ask: ['no invariant marker'], count: 0, headingWarnings: 0 },
    ];

    for (const { label, ask, count, headingWarnings } of cases) {
      const findings = lintGoalFile(canonicalDocument(ask), 'main');
      expect(findings.recognizedInvariantCount, label).toBe(count);
      expect(findings.filter((finding) => finding.tag === 'heading-form-marker'), label).toHaveLength(headingWarnings);
    }
  });

  test('does not treat already-extracted peer marker lines under a heading as discarded prose', () => {
    const wrappedWarnings = (askLines: readonly string[]) => headingFindings(canonicalDocument(askLines));

    expect(wrappedWarnings([
      '## 불변식',
      '불변식: src/example.ts remains unchanged.',
      '판정 신호: 조건 = 거짓 경보가 사라진다; 관측 = bun test src/self-implement/goal-author.test.ts; 기대 = 감싼 마커 경고가 0개다',
    ])).toHaveLength(0);

    expect(wrappedWarnings([
      '## 불변식',
      '- 수집은 멱등이다.',
    ]).length).toBeGreaterThanOrEqual(1);

    expect(wrappedWarnings([
      '불변식: src/example.ts remains unchanged.',
      '경계: src/example.ts만 고친다.',
      '판정 신호: 조건 = 제목이 없다; 관측 = lintGoalFile; 기대 = 감싼 마커 경고가 0개다',
    ])).toHaveLength(0);

    expect(wrappedWarnings([
      '## 불변식',
      '경계: src/example.ts만 고친다.',
    ])).toHaveLength(0);
    expect(wrappedWarnings([
      '## 불변식',
      '답하지 못하는 것: 이 골의 대상 안에서는 판별할 수 없다.',
    ])).toHaveLength(0);
    expect(wrappedWarnings([
      '## 불변식',
      '대상 경로: src/example.ts',
    ])).toHaveLength(0);
  });

  test('adds lint visibility without replacing the generated-document UNVERIFIABLE diagnostic', async () => {
    const headingBoundary = '# 경계\nsrc/heading-boundary.ts만 고친다.';
    const authored = await authorGoal(headingBoundary, deps);
    const findings = headingFindings(authored.document);

    expect(authored.document).toContain(`- UNVERIFIABLE: Ask uses a heading-form boundary; headings are diagnostic only and do not create a boundary candidate. source=${JSON.stringify(headingBoundary)} truncated=false; corrected example: 경계: src/example.ts만 고친다.`);
    expect(findings).toEqual([{
      level: 'WARN',
      tag: 'heading-form-marker',
      message: `Ask uses a heading-form boundary; headings are diagnostic only and do not create a boundary candidate. source=${JSON.stringify(headingBoundary)} truncated=false; corrected example: 경계: src/example.ts만 고친다.`,
    }]);
  });

  test('reports heading-form labels only when no inline invariant is recognized, without treating prose as a heading', () => {
    const headingOnly = lintGoalFile(canonicalDocument([
      '## 불변식', '- preserve first.', '- preserve second.', '- preserve third.',
      '### 경계', '- remain scoped.',
      '## 불변식', '- preserve repeated heading.',
    ]), 'main');
    const inline = lintGoalFile(canonicalDocument([
      '불변식: src/one.ts remains unchanged.', '불변식: src/two.ts remains unchanged.', '불변식: src/three.ts remains unchanged.',
      '## 경계', '- remain scoped.',
    ]), 'main');
    const absent = lintGoalFile(canonicalDocument(['불변식과 경계는 산문으로만 언급한다.']), 'main');

    expect(headingOnly.recognizedInvariantCount).toBe(0);
    expect(headingOnly.headingFormMarkerLabels).toEqual(['불변식', '경계']);
    expect(inline.recognizedInvariantCount).toBe(3);
    expect(inline.headingFormMarkerLabels).toEqual([]);
    expect(absent.recognizedInvariantCount).toBe(0);
    expect(absent.headingFormMarkerLabels).toEqual([]);
  });

  test('treats exact ## invariant and boundary heading sections as diagnostic-only, stops at the next heading, rejects empty bodies, and preserves CRLF sources', async () => {
    const headingInvariant = ['## 불변식', 'src/heading-invariant.ts remains unchanged.', '## 다음 제목', 'ignored invariant content.'].join('\n');
    const headingBoundary = ['## 경계', 'src/heading-boundary.ts만 고친다.', '### 다음 제목', 'ignored boundary content.'].join('\n');
    const emptyInvariant = '## 불변식\n## 다음 제목';
    const emptyBoundary = '## 경계\n## 다음 제목';
    const crlfInvariant = ['## 불변식', 'src/crlf-invariant.ts remains unchanged.', '## 다음 제목', 'ignored CRLF invariant content.'].join('\r\n');
    const crlfBoundary = ['## 경계', 'src/crlf-boundary.ts만 고친다.', '## 다음 제목', 'ignored CRLF boundary content.'].join('\r\n');
    const authored = await authorGoal([headingInvariant, headingBoundary, emptyInvariant, emptyBoundary, crlfInvariant, crlfBoundary].join('\n'), deps);
    const invariants = authored.document.slice(authored.document.indexOf('## 불변식'), authored.document.indexOf('## 판정 신호'));
    const boundary = authored.document;
    const signals = planGateSignals(authored.document, []);
    const findings = lintGoalFile(authored.document, 'main').filter((finding) => finding.tag === 'heading-form-marker');

    expect(inspectAskInvariantMarker(headingInvariant)).toMatchObject({ matched: false, extracted: false });
    expect(inspectAskBoundaryMarker(headingBoundary)).toMatchObject({ matched: false, extracted: false });
    expect(invariants).toContain('Ask uses a heading-form invariant; headings are diagnostic only');
    expect(invariants).toContain(`source=${JSON.stringify('## 불변식\nsrc/heading-invariant.ts remains unchanged.')}`);
    expect(invariants).not.toContain('- Invariant candidate:');
    expect(invariants).not.toContain('- Invariant candidate: ignored invariant content.');
    expect(boundary).toContain('Ask uses a heading-form boundary; headings are diagnostic only');
    expect(boundary).toContain(`source=${JSON.stringify('## 경계\nsrc/heading-boundary.ts만 고친다.')}`);
    expect(boundary).not.toContain('- Boundary decision:');
    expect(boundary).not.toContain('- Boundary decision: ignored boundary content.');
    expect(invariants).toContain(`source=${JSON.stringify('## 불변식\r\nsrc/crlf-invariant.ts remains unchanged.')}`);
    expect(boundary).toContain(`source=${JSON.stringify('## 경계\r\nsrc/crlf-boundary.ts만 고친다.')}`);
    expect(invariants).toContain(`- UNVERIFIABLE: invariant marker heading has an empty body and did not create a candidate. source=${JSON.stringify('## 불변식\n')}`);
    expect(boundary).toContain(`- UNVERIFIABLE: boundary marker heading has an empty body and did not create a candidate. source=${JSON.stringify('## 경계\n')}`);
    expect(findings.some((finding) => finding.message.includes('source="## 불변식\\n## 다음 제목"'))).toBe(false);
    expect(findings.some((finding) => finding.message.includes('source="## 경계\\n## 다음 제목"'))).toBe(false);
    expect(signals).toMatchObject({ normalizedMarkerSuccess: 0, normalizedMarkerFailure: 2 });
  });
});

describe('lintGoalFile · blanket invariant clauses', () => {
  const canonicalDocument = (ask: string) => [
    '## PROBLEM', 'x', '',
    '## WHAT TO BUILD', 'Original ask (verbatim, unmodified):', '````', ask, '````', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 답하지 못하는 것', '- 없다.', '',
    '## 불변식', 'x', '', '## 판정 신호', 'x', '',
  ].join('\n');
  const blanketFindings = (ask: string) => lintGoalFile(canonicalDocument(ask), 'main')
    .filter((finding) => finding.tag === 'blanket-invariant');

  test('warns for a blanket preservation clause beside a named preservation clause in the same sentence', () => {
    const mixed = blanketFindings('모든 동작을 그대로 유지하며 `repoRoot` 키를 보존한다.');
    const separated = blanketFindings('모든 동작을 그대로 유지한다. `repoRoot` 키를 보존한다.');
    const blanket = blanketFindings('모든 동작을 그대로 유지한다.');
    const namedOnly = blanketFindings('`repoRoot` 키를 보존한다.');

    for (const findings of [mixed, separated, blanket]) {
      expect(findings).toContainEqual(expect.objectContaining({
        level: 'WARN',
        tag: 'blanket-invariant',
        message: expect.stringContaining('이름으로 한정한 보존 대상'),
      }));
    }
    expect(namedOnly).toEqual([]);
  });

  test('falsifies clause-level blanket detection: exempting the whole mixed sentence would fail this assertion', () => {
    expect(blanketFindings('모든 동작을 그대로 유지하며 `repoRoot` 키를 보존한다.')).toHaveLength(1);
  });

  test('observes author-known shapes with mutually exclusive named and blanket behavior preservation counts without adding findings', () => {
    const named = lintGoalFile(canonicalDocument('전수로 모두 찾고 빠짐없이 확인한다.\n불변식: `src/x.ts`의 모든 행동을 바꾸지 않는다.\n판정 신호: 조건 = 캐시를 제거한 뒤 부른다; 관측 = 반환; 기대 = 유지된다'), 'main');
    const blanket = lintGoalFile(canonicalDocument('불변식: 모든 행동을 바꾸지 않는다.\n판정 신호: 조건 = 캐시를 추가한다; 관측 = 반환; 기대 = 유지된다'), 'main');

    expect(named.exhaustiveRequestWordingCount).toBe(3);
    expect(named.namedPreservationTargetCount).toBe(1);
    expect(named.blanketBehaviorPreservationCount).toBe(0);
    expect(named.removalFormDecisionConditionCount).toBe(1);
    expect(blanket.exhaustiveRequestWordingCount).toBe(0);
    expect(blanket.namedPreservationTargetCount).toBe(0);
    expect(blanket.blanketBehaviorPreservationCount).toBe(1);
    expect(blanket.removalFormDecisionConditionCount).toBe(0);
    expect(Array.from(named)).toEqual(Array.from(blanket));
    expect(named.some((finding) => finding.level === 'ERROR')).toBe(false);
  });
});

describe('lintGoalFile · authored ask section counts', () => {
  const canonicalDocument = (lineEnding: string, askLines: readonly string[]) => [
    '## PROBLEM', 'x', '',
    '## WHAT TO BUILD', 'Original ask (verbatim, unmodified):', '````', ...askLines, '````', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', '- Boundary decision: first', '',
    '## 답하지 못하는 것', '- 없다.', '', '## 불변식', 'x', '', '## 판정 신호', 'x', '',
  ].join(lineEnding);

  test('moves an ask marker/count mismatch into an exact non-blocking canonical-structure WARN without weakening other lint findings', () => {
    const document = canonicalDocument('\n', ['경계: first', '경계: second']);
    expect(Array.from(lintGoalFile(document, 'main'))).toEqual([
      {
        level: 'WARN',
        tag: 'canonical-structure',
        message: 'Information: ask has 2 format-matching "경계" item(s); this section contains 1 item(s).',
      },
    ]);
  });

  test('does not mistake a shorter internal fence for the matching closing fence and finds markers after it', () => {
    const document = canonicalDocument('\n', ['```', 'example', '```', '경계: first', '경계: second']);
    expect(Array.from(lintGoalFile(document, 'main'))).toEqual([
      {
        level: 'WARN',
        tag: 'canonical-structure',
        message: 'Information: ask has 2 format-matching "경계" item(s); this section contains 1 item(s).',
      },
    ]);
  });

  test('produces identical marker WARNs for LF and CRLF authored documents', () => {
    const askLines = ['```', 'example', '```', '경계: first', '경계: second'];
    expect(lintGoalFile(canonicalDocument('\n', askLines), 'main')).toEqual(lintGoalFile(canonicalDocument('\r\n', askLines), 'main'));
  });
});

describe('ask-section count wording distinguishes format items from phrase occurrences', () => {
  const documentWithAsk = (askLines: readonly string[], sections: Readonly<Record<string, readonly string[]>>) => [
    '## PROBLEM', 'x', '',
    '## WHAT TO BUILD', ORIGINAL_ASK_MARKER, '````', ...askLines, '````', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '',
    '## SCOPE BOUNDARY', ...(sections['SCOPE BOUNDARY'] ?? ['x']), '',
    '## 답하지 못하는 것', ...(sections['답하지 못하는 것'] ?? ['x']), '',
    '## 불변식', ...(sections['불변식'] ?? ['x']), '',
    '## 판정 신호', ...(sections['판정 신호'] ?? ['x']), '',
  ].join('\n');
  const relationship = (document: string) => lintGoalFile(document, 'main')
    .filter((finding) => finding.check === 'ask-section-relationship');

  test('ask-section count wording reports informal phrase presence when format-matching items are 0', () => {
    const findings = relationship(documentWithAsk(
      ['5. 판정 신호 — 조건과 관측을 적는다'],
      { '판정 신호': ['- Candidate decision signal:'] },
    ));
    expect(findings).toEqual([{
      level: 'WARN',
      tag: 'canonical-structure',
      message: 'Information: ask has 0 format-matching "판정 신호" item(s) (the phrase "판정 신호" appears 1 time(s) but not in marker form); this section contains 1 item(s).',
    }]);
    expect(findings[0]?.message).not.toContain('ask contains "판정 신호" 0 time(s)');
  });

  test('ask-section count wording reports a different sentence when the phrase itself is absent', () => {
    const informal = relationship(documentWithAsk(
      ['5. 판정 신호 — 조건과 관측을 적는다'],
      { '판정 신호': ['- Candidate decision signal:'] },
    ));
    const absent = relationship(documentWithAsk(
      ['조건과 관측만 적고 표지 이름은 쓰지 않는다'],
      { '판정 신호': ['- Candidate decision signal:'] },
    ));
    expect(absent).toEqual([{
      level: 'WARN',
      tag: 'canonical-structure',
      message: 'Information: ask has 0 format-matching "판정 신호" item(s) (the phrase "판정 신호" does not appear); this section contains 1 item(s).',
    }]);
    expect(absent[0]?.message).not.toBe(informal[0]?.message);
  });

  test('ask-section count wording emits no sentence when format-matching count equals section item count', () => {
    expect(relationship(documentWithAsk(
      ['경계: first'],
      { 'SCOPE BOUNDARY': ['- Boundary decision: first'] },
    ))).toEqual([]);
  });

  test('ask-section count wording says it counted the phrase when called without a marker regex', () => {
    expect(askSectionCountInformation('판정 신호', '판정 신호 한 번, 다시 판정 신호', 0)).toEqual([
      '- Information: ask contains the phrase "판정 신호" 2 time(s); this section contains 0 item(s).',
    ]);
  });

  test('ask-section count wording applies the same wording rule to 경계, 답하지 못하는 것, 불변식, and 판정 신호', () => {
    const findings = relationship(documentWithAsk(
      [
        '5. 경계 — 저작 시점만 고친다.',
        '5. 답하지 못하는 것 — 다음 작업에서 본다.',
        '5. 불변식 — pty 증명이 회차마다 선다.',
        '5. 판정 신호 — 조건과 관측을 적는다.',
      ],
      {
        'SCOPE BOUNDARY': ['- Boundary decision: first'],
        '답하지 못하는 것': ['- Author limitation: next work.'],
        '불변식': ['- Invariant candidate: keep the marker regex.'],
        '판정 신호': ['- Candidate decision signal:'],
      },
    ));
    const expected = ['경계', '답하지 못하는 것', '불변식', '판정 신호'] as const;
    expect(findings).toHaveLength(expected.length);
    for (const [index, label] of expected.entries()) {
      expect(findings[index]).toMatchObject({
        level: 'WARN',
        tag: 'canonical-structure',
        message: `Information: ask has 0 format-matching "${label}" item(s) (the phrase "${label}" appears 1 time(s) but not in marker form); this section contains 1 item(s).`,
      });
    }
  });
});

// ⭐ 자 결함(2026-08-02 실측) — 린터가 **실재하는 파일**을 `does not exist` 로 판정했다.
//   저작기는 TRACED PATHS 를 맨 경로(`1. src/x.ts — 설명`)로 쓰지만, 사람이 쓴 골과 이 레포의 다른
//   문서는 **백틱**을 쓴다. 백틱이 경로에 붙은 채 reader 로 넘어가 항상 missing 이 됐다.
//   ⇒ 이 자가 이 창의 발사 관문이라 거짓 ERROR 는 "린트를 무시한다" 는 습관을 만든다.
describe('lintGoalFile · TRACED PATHS 의 인라인 코드 표기', () => {
  const canonical = (tracedPaths: string) => [
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] 설명', '',
    '## TRACED PATHS', tracedPaths, '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '', '## 판정 신호', 'x', '',
  ].join('\n');
  const present = 'line one\nline two\n';
  const reader = (path: string) => (path === 'src/present.ts' ? present : null);
  const tracedFindings = (tracedPaths: string) =>
    lintGoalFile(canonical(tracedPaths), 'main', { readReferencedFile: reader }).filter((f) => f.tag === 'traced-path');

  test('exported parser keeps fenced headings out and yields repository paths without line suffixes', () => {
    const document = [
      '## TRACED PATHS',
      '- `src/first.ts`:10-12 — first',
      '2. src/second.ts — second',
      '```md',
      '## TRACED PATHS',
      '- src/ignored.ts',
      '```',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(markdownSection(document, 'TRACED PATHS')).toContain('src/first.ts');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/first.ts', line: 10, endLine: 12 },
      { path: 'src/second.ts', line: null, endLine: null },
    ]);
  });

  test('백틱으로 감싼 경로를 실재로 읽는다 — 불릿·번호 두 표기 모두', () => {
    expect(tracedFindings('- `src/present.ts` — 설명')).toEqual([]);
    expect(tracedFindings('1. `src/present.ts` — 설명')).toEqual([]);
  });

  test('맨 경로(저작기 산출 표기)는 그대로 통과한다 — 회귀 방지', () => {
    expect(tracedFindings('1. src/present.ts — 설명')).toEqual([]);
  });

  test('공백으로 둘러싼 하이픈은 설명 구분자로 보고 경로만 읽는다', () => {
    expect(tracedPathReferences(canonical('1. src/present.ts - 설명'))).toEqual([
      { path: 'src/present.ts', line: null, endLine: null },
    ]);
    expect(tracedFindings('1. src/present.ts - 설명')).toEqual([]);
  });

  test('파일명 안의 하이픈은 설명 구분자로 보지 않는다', () => {
    const document = [
      '## TRACED PATHS',
      '1. src/some-file.ts',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/some-file.ts', line: null, endLine: null },
    ]);
  });

  test('기존 표기 변형은 설명 구분자 확장 후에도 같은 경로로 읽는다', () => {
    const document = [
      '## TRACED PATHS',
      '1. `src/first.ts`:10-12 · `src/second.ts:2` — 설명',
      '2. `src/third.ts:3` - 설명',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/first.ts', line: 10, endLine: 12 },
      { path: 'src/second.ts', line: 2, endLine: null },
      { path: 'src/third.ts', line: 3, endLine: null },
    ]);
  });

  test('줄번호가 백틱 안이든 밖이든 같은 경로·같은 줄로 읽는다', () => {
    expect(tracedFindings('- `src/present.ts:2` — 설명')).toEqual([]);
    expect(tracedFindings('- `src/present.ts`:2 — 설명')).toEqual([]);
    // ⛔ "오류 없음" 만으로는 줄번호가 **읽혔다**를 못 보인다 — 무시돼도 통과하기 때문이다(리뷰 should-fix).
    //   그래서 범위 밖 줄로 **같은 메시지**가 나는 것을 두 표기 각각에 대해 고정한다.
    const outOfRange = expect.objectContaining({ tag: 'traced-path', message: 'traced path line 9 is out of range: src/present.ts' });
    expect(tracedFindings('- `src/present.ts:9` — 설명')).toContainEqual(outOfRange);
    expect(tracedFindings('- `src/present.ts`:9 — 설명')).toContainEqual(outOfRange);
  });

  // ⭐ `[T]` 원장 GOAL-T10 (2026-08-02) — 행 **범위** 표기가 경로에 붙어 실재 파일이 missing 으로 읽혔다.
  //   T 의 표현: *"정확히 쓸수록 벌받는다"* — 표기를 흐리게 하니 exit 0 이었다.
  test('행 범위(:start-end) 를 경로에서 갈라 읽고 양 끝을 다 검사한다', () => {
    expect(tracedFindings('- `src/present.ts:1-2` — 설명')).toEqual([]);
    expect(tracedFindings('- src/present.ts:1-2 — 설명')).toEqual([]);
    // 끝만 범위 밖이어도 잡는다(시작만 보면 통과해 버린다)
    expect(tracedFindings('- `src/present.ts:1-9` — 설명')).toContainEqual(
      expect.objectContaining({ tag: 'traced-path', message: 'traced path line 9 is out of range: src/present.ts' }),
    );
    expect(tracedFindings('- `src/present.ts:2-1` — 설명')).toContainEqual(
      expect.objectContaining({ tag: 'traced-path', message: 'traced path line range 2-1 is inverted: src/present.ts' }),
    );
  });

  // ⛔ 리뷰 must-fix(2026-08-02) — 벗기기가 **검사를 건너뛰는 길**을 만들면 안 된다.
  //   빈 인라인 코드를 빈 경로로 만들면 `if (!path) continue` 에 걸려 조용히 통과한다(도입 전에는 ERROR 였다).
  test('빈 인라인 코드는 검사를 건너뛰지 않고 ERROR 로 남는다', () => {
    for (const item of ['- `` — 설명', '- ``:2 — 설명']) {
      expect(tracedFindings(item)).toContainEqual(expect.objectContaining({ tag: 'traced-path' }));
    }
  });

  test('⛔ 실제로 없는 경로는 백틱을 벗겨도 여전히 ERROR 다 — 벗기기가 검사를 무르게 하지 않는다', () => {
    expect(tracedFindings('- `src/missing.ts` — 설명')).toContainEqual(
      expect.objectContaining({ tag: 'traced-path', message: 'traced path does not exist: src/missing.ts' }),
    );
  });

  test('한 항목의 경로 칸을 공백으로 둘러싼 가운뎃점으로 잇으면 참조가 둘이다', () => {
    const document = [
      '## TRACED PATHS',
      '3. src/harness/harness-cli-sink.ts · src/harness/harness-cli-sink.test.ts — 설명',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/harness/harness-cli-sink.ts', line: null, endLine: null },
      { path: 'src/harness/harness-cli-sink.test.ts', line: null, endLine: null },
    ]);
  });

  test('한 항목에 경로가 하나면 종전처럼 참조가 하나다', () => {
    const document = [
      '## TRACED PATHS',
      '1. src/index.ts — 설명',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/index.ts', line: null, endLine: null },
    ]);
  });

  test('가운뎃점으로 이은 실재 경로 둘은 각각 존재성 검사를 통과하고 결합 문자열은 경로가 아니다', () => {
    const bothPresent = (path: string) => (
      path === 'src/present.ts' || path === 'src/also.ts' ? present : null
    );
    const findings = lintGoalFile(
      canonical('3. src/present.ts · src/also.ts — 설명'),
      'main',
      { readReferencedFile: bothPresent },
    ).filter((f) => f.tag === 'traced-path');
    expect(findings).toEqual([]);
    expect(findings).not.toContainEqual(expect.objectContaining({
      message: expect.stringContaining('src/present.ts · src/also.ts'),
    }));
  });

  test('각 조각에 백틱 벗기기와 줄번호 떼기를 독립적으로 적용한다', () => {
    const document = [
      '## TRACED PATHS',
      '9. `src/first.ts`:10-12 · `src/second.ts:2` — 설명',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/first.ts', line: 10, endLine: 12 },
      { path: 'src/second.ts', line: 2, endLine: null },
    ]);
  });

  test('공백으로 둘러싸지 않은 가운뎃점은 경로 구분자로 보지 않는다', () => {
    const document = [
      '## TRACED PATHS',
      '1. src/file·name.ts — 설명',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/file·name.ts', line: null, endLine: null },
    ]);
  });

  test('분리 후 빈 조각은 버린다', () => {
    const document = [
      '## TRACED PATHS',
      '1. src/present.ts ·  · src/also.ts — 설명',
      '## SCOPE BOUNDARY',
      '- boundary',
    ].join('\n');
    expect(tracedPathReferences(document)).toEqual([
      { path: 'src/present.ts', line: null, endLine: null },
      { path: 'src/also.ts', line: null, endLine: null },
    ]);
  });

  test('rejects only measured preservation evidence at a real requested path-and-symbol coordinate', async () => {
    const lowerCamelPath = 'src/self-implement/goal-author.ts';
    const evidence = [
      'src/a.ts declares A and src/b.ts declares B',
      'src/foo.ts currently preserves the Bar contract',
      'src/foo.ts declares Bar and owns the 193-entry catalog',
      'src/other.ts declares Other and owns the 2-entry catalog',
      `${lowerCamelPath}#checkableCriteria owns the 193-entry catalog`,
      `${lowerCamelPath} contains checkableCriteria and owns the 193-entry catalog`,
      `${lowerCamelPath} contains code and owns the 193-entry catalog`,
    ];
    const authored = await authorGoal('Change the requested coordinates.', {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: [
          'Change src/a.ts B',
          'Change src/foo.ts Bar',
          'Change src/other.ts Different',
          `Change ${lowerCamelPath}#checkableCriteria`,
          `Change ${lowerCamelPath}#code`,
        ],
        verbatimPreserved: true,
      }),
      ground: async () => ({ ...facts, persistentEvidence: evidence }),
    });
    const reverseAuthored = await authorGoal('Change the requested coordinates with bare symbols.', {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: [`Change ${lowerCamelPath} contains checkableCriteria`],
        verbatimPreserved: true,
      }),
      ground: async () => ({ ...facts, persistentEvidence: [evidence[4]] }),
    });
    const acceptance = authored.document.slice(
      authored.document.indexOf('## ACCEPTANCE CRITERIA'),
      authored.document.indexOf('## REQUIRED EVIDENCE'),
    );
    const reverseAcceptance = reverseAuthored.document.slice(
      reverseAuthored.document.indexOf('## ACCEPTANCE CRITERIA'),
      reverseAuthored.document.indexOf('## REQUIRED EVIDENCE'),
    );

    expect(acceptance).toContain(IMPLEMENT_PRESERVATION_REFERENCE);
    expect(authored.document).toContain(evidence[0]);
    expect(acceptance.match(new RegExp(IMPLEMENT_PRESERVATION_REFERENCE, 'g'))).toHaveLength(1);
    expect(acceptance).not.toContain(`- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${evidence[2]}`);
    expect(acceptance).not.toContain(`- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${evidence[4]}`);
    expect(acceptance).not.toContain(`- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${evidence[5]}`);
    expect(acceptance).toContain(`- Preservation criterion rejected: ${evidence[2]} — overlaps requested coordinate(s): src/foo.ts#Bar.`);
    expect(acceptance).toContain(`- Preservation criterion rejected: ${evidence[4]} — overlaps requested coordinate(s): ${lowerCamelPath}#checkableCriteria.`);
    expect(acceptance).toContain(`- Preservation criterion rejected: ${evidence[5]} — overlaps requested coordinate(s): ${lowerCamelPath}#checkableCriteria.`);
    expect(reverseAcceptance).toContain(`- Preservation criterion rejected: ${evidence[4]} — overlaps requested coordinate(s): ${lowerCamelPath}#checkableCriteria.`);
  });
});

// ⛔⭐⭐⭐ 종전 회귀는 정규식을 **테스트 안에 복사**해 두어 vacuous 였다 — 수리를 되돌려도 92 pass 였다.
//    `[T]` 의 「반증 자기검증」이 잡았다. 이제 **배포 상수를 import** 해서 되돌리면 빨개진다.
describe('ask marker detection — 배포 코드를 직접 문다', () => {
  const hit = (re: RegExp, text: string): boolean => { re.lastIndex = 0; return re.test(text); };

  test('불변식 <이름>: 형태를 표지로 본다', () => {
    expect(hit(ASK_INVARIANT_MARKER, '불변식 rotation-proof: pty 증명이 회차마다 선다.')).toBe(true);
    expect(hit(ASK_INVARIANT_MARKER, '불변식: pty 증명이 회차마다 선다.')).toBe(true);
  });

  test('평범한 산문은 표지로 보지 않는다', () => {
    expect(hit(ASK_INVARIANT_MARKER, '이 골은 불변식을 지킨다는 뜻이다')).toBe(false);
    expect(hit(ASK_INVARIANT_MARKER, '불변식 넷을 아래에 둔다')).toBe(false);
    expect(hit(ASK_DECISION_SIGNAL_MARKER, '판정 신호를 어떻게 쓰나 설명한다')).toBe(false);
    expect(hit(ASK_BOUNDARY_MARKER, '이 골의 경계 크기 경고를 설명한다')).toBe(false);
  });

  test('경계: 및 경계 (수식어): 형태를 경계 표지로 본다', () => {
    expect(hit(ASK_BOUNDARY_MARKER, '경계: 저작 시점만 고친다.')).toBe(true);
    expect(hit(ASK_BOUNDARY_MARKER, '경계 (파서 계약): ASK_BOUNDARY는 넓히지 않는다.')).toBe(true);
    expect(hit(ASK_BOUNDARY_MARKER, '경계 rotation-proof: 첫 경계 선언을 보존한다.')).toBe(true);
  });

  test('경계 제목이 바로 아래 경계 선언을 소비하지 않는다', () => {
    const decision = 'src/self-implement/goal-author.ts만 고친다.';
    const heading = `## 경계

경계: ${decision}`;
    const bare = `경계: ${decision}`;
    const qualifiedHeading = `## 경계 — 결정

경계: ${decision}`;

    for (const [label, ask] of [['heading', heading], ['bare', bare], ['qualified heading', qualifiedHeading]] as const) {
      expect(inspectAskBoundaryMarker(ask), label).toMatchObject({
        matched: true,
        marker: true,
        extracted: true,
      });
    }
  });

  test('판정 신호는/판정 신호 <이름>: 둘 다 표지로 본다', () => {
    expect(hit(ASK_DECISION_SIGNAL_MARKER, '판정 신호는 이것이다. 조건 = A; 관측 = B')).toBe(true);
    expect(hit(ASK_DECISION_SIGNAL_MARKER, '판정 신호: 조건 = A; 관측 = B; 기대 = C')).toBe(true);
  });
});

// ⛔⭐ 수동태 보존 오탐은 clarification 을 만들고, 미답 clarification 은 `RUN-S13` 경로를 태운다.
describe('preservation ambiguity — 배포 코드를 직접 문다', () => {
  test('수동태·능동 보존은 요구가 아니다', () => {
    expect(hasUnmetRequirementOutsidePreservationClause('this behavior should be preserved across releases')).toBe(false);
    expect(hasUnmetRequirementOutsidePreservationClause('the public API must be unchanged')).toBe(false);
    expect(hasUnmetRequirementOutsidePreservationClause('the exported signature must remain unchanged')).toBe(false);
    expect(hasUnmetRequirementOutsidePreservationClause('src/foo.ts exports bar and baz')).toBe(false);
  });

  test('보존이 아니면 수동태라도 요구다', () => {
    expect(hasUnmetRequirementOutsidePreservationClause('the result must be surfaced to the caller')).toBe(true);
    expect(hasUnmetRequirementOutsidePreservationClause('proving the production pre-create path that must surface the classifier orphan result')).toBe(true);
    expect(hasUnmetRequirementOutsidePreservationClause('the caller must wire the new flag and must keep the old default')).toBe(true);
  });
});


// ⛔⭐⭐⭐ T2 조인 키 — 「탐색 비용 ↔ 오판 비용」 곡선을 그리려면 두 축이 «서로를 알아야» 한다.
//   📏 2026-08-07 실측: phase-end 83건 중 goalId 보유 «0» · plan-signals 는 43 중 31.
//      ⇒ 저작 소요(elapsedMs)를 «어느 골»에 붙일지가 어디에도 없었다.
//   ⛔ goalId 를 그대로 못 쓴다 — assemble «중»에 정해지므로 ground·enhance 시점엔 원리상 없다.
describe('goal-author 조인 키 (authorRunId ⊕ goal-id-assigned)', () => {
  test('전 페이즈가 «같은» authorRunId 를 싣고, 그 id 가 goalId 와 한 줄로 이어진다', async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'goal-author' && data) seen.push({ event, data });
    }) as never);
    try {
      const authored = await authorGoal(ask, deps);
      const phases = seen.filter((e) => e.event === 'phase-start' || e.event === 'phase-end');
      expect(phases.length).toBeGreaterThan(0);
      const ids = new Set(phases.map((e) => e.data.authorRunId));
      // ⭐ 하나여야 한다 — 저작 «한 번»이 한 id 다.
      expect(ids.size).toBe(1);
      const authorRunId = [...ids][0] as string;
      expect(typeof authorRunId).toBe('string');
      expect(authorRunId.length).toBeGreaterThan(0);

      const join = seen.find((e) => e.event === 'goal-id-assigned');
      expect(join).toBeDefined();
      expect(join!.data.authorRunId).toBe(authorRunId);
      // ⭐ 그 goalId 가 «문서에 실제로 실린» 것과 같아야 한다 — 조인이 거짓이면 곡선이 거짓이 된다.
      const documentGoalId = authored.document.match(/^- GoalId: (\S+)$/m)?.[1];
      expect(documentGoalId).toBeDefined();
      expect(join!.data.goalId).toBe(documentGoalId);
      expect(join!.data.superseded).toBe(false);

      // ⭐ 후보 수(탐색 비용의 둘째 축)도 같은 id 로 묶인다.
      const narrowing = seen.find((e) => e.event === 'implementation-target-narrowing');
      if (narrowing) expect(narrowing.data.authorRunId).toBe(authorRunId);
    } finally {
      log.mockRestore();
    }
  });

  test('두 번 저작하면 authorRunId 가 «갈린다» (런끼리 안 섞인다)', async () => {
    const ids: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'goal-author' && event === 'goal-id-assigned' && data) ids.push(data.authorRunId as string);
    }) as never);
    try {
      await authorGoal(ask, deps);
      await authorGoal(ask, deps);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      log.mockRestore();
    }
  });
});


// ⭐⭐ rfc-goal 의 «빠진 절반» — 사람이 읽는 「왜」 절을 저작기가 낸다(대표 지시).
//   ⛔ 배치가 계약이다 — 골 절 «앞»이어야 한다. 사이에 두면 그 절의 본문이 거기서 잘린다.
describe('rfcGoalProseSection — 사람이 읽는 「왜」 절', () => {
  const base = { ask: '짧은 요청', groundedFiles: ['src/a.ts'], grounded: true, narrowedPath: 'src/a.ts', narrowedRule: 'single-candidate', boundaryDecisionCount: 2 };

  test('저작기가 «아는 것»만 적는다 — 원문·접지·좁힘·경계 수', () => {
    const lines = rfcGoalProseSection(base).join('\n');
    expect(lines).toContain('## 왜 이 골인가');
    expect(lines).toContain('`rfc-goal`');
    expect(lines).toContain('짧은 요청');
    expect(lines).toContain('접지가 연 파일: 1개');
    expect(lines).toContain('`src/a.ts`');
    expect(lines).toContain('single-candidate');
    expect(lines).toContain('2개를 아래에 결정으로 적었다');
  });

  test('긴 원문은 «잘렸다는 사실»을 값으로 말한다 (조용히 안 자른다)', () => {
    const ask = 'ㄱ'.repeat(500);
    const lines = rfcGoalProseSection({ ...base, ask }).join('\n');
    // ⭐ 이 표본은 공백이 없어 «안 폈다». 그러나 «잘렸다» — 그러므로 「원문 그대로」가 아니다(4R must-fix).
    expect(lines).toContain('앞 300자');
    expect(lines).toContain('원문 500자');
    expect(lines).toContain('앞부분만');
    expect(lines).not.toContain('(원문 그대로)');
    expect(lines).not.toContain('ㄱ'.repeat(400));
  });

  test('모르는 칸은 «모른다»로 적는다 — 접지 없음 · 안 좁힘 · 경계 0', () => {
    const lines = rfcGoalProseSection({ ask: 'x', groundedFiles: [], grounded: false, narrowedPath: null, narrowedRule: null, boundaryDecisionCount: 0 }).join('\n');
    expect(lines).toContain('근거 없음');
    expect(lines).toContain('«안 좁혔다»');
    expect(lines).toContain('사람이 경계를 안 적었다');
  });

  // ⛔⭐⭐ 무인 리뷰가 잡은 Goodhart 테스트의 수리 — 위 검사는 «안 좁힌» 갈래만 물어서,
  //   「좁혔는데 규칙을 모른다」는 갈래에서 규칙이 «조용히 생략»되는 것을 통과시켰다.
  //   ⇒ 그 갈래를 «직접» 문다: 값이 없으면 「모름」이라는 낱말이 실제로 나와야 한다.
  test('좁혔는데 규칙을 모르면 «규칙 모름»을 값으로 적는다 (조용히 생략 금지)', () => {
    const lines = rfcGoalProseSection({ ...base, narrowedPath: 'src/a.ts', narrowedRule: null }).join('\n');
    expect(lines).toContain('`src/a.ts`');
    expect(lines).toContain('규칙 모름');
  });

  // ⛔⭐⭐ 「원문 그대로」는 «참일 때만» 쓴다 — 이 함수는 공백을 편다.
  test('공백을 편 경우 「원문 그대로」라고 «말하지 않는다»', () => {
    const multiline = rfcGoalProseSection({ ...base, ask: '첫 줄\n둘째 줄' }).join('\n');
    expect(multiline).toContain('공백을 한 줄로 폈다');
    expect(multiline).not.toContain('(원문 그대로)');
    const single = rfcGoalProseSection({ ...base, ask: '한 줄짜리' }).join('\n');
    expect(single).toContain('(원문 그대로)');
    // ⛔ 앞뒤 «공백만» 있는 경우도 「그대로」가 아니다 — trim 과 비교하면 이 갈래를 놓친다(2R must-fix).
    const padded = rfcGoalProseSection({ ...base, ask: '  한 줄짜리  ' }).join('\n');
    expect(padded).toContain('공백을 한 줄로 폈다');
    expect(padded).not.toContain('(원문 그대로)');
  });

  // ⛔⭐ 5R must-fix — String.length 는 UTF-16 단위라 이모지를 2로 세고 slice 가 «쌍을 쪼갠다».
  test('이모지는 «한 자»로 세고 잘라도 «안 깨진다» (코드 포인트 기준)', () => {
    const ask = '⭐'.repeat(200);            // UTF-16 으로는 400 · 코드 포인트로는 200
    const lines = rfcGoalProseSection({ ...base, ask }).join('\n');
    // 200자는 상한(300) 이하이므로 «안 잘린다» — UTF-16 으로 셌으면 400 이라 잘렸을 것이다.
    expect(lines).toContain('(원문 그대로)');
    expect(lines).not.toContain('앞부분만');
    // ⛔ 그리고 깨진 반쪽 글자가 없다.
    expect(lines).not.toContain('\uFFFD');
    expect(lines.split('⭐').length - 1).toBe(200);
  });

  test('상한을 «코드 포인트로» 넘으면 잘리고 그 수를 정직하게 적는다', () => {
    const ask = '⭐'.repeat(400);
    const lines = rfcGoalProseSection({ ...base, ask }).join('\n');
    expect(lines).toContain('편 뒤 400자 중 앞 300자');
    expect(lines).toContain('원문 400자');
    expect(lines).toContain('앞부분만');
  });

  test('폈고 «동시에» 잘렸으면 표기가 둘 다 말한다', () => {
    const lines = rfcGoalProseSection({ ...base, ask: `${'ㄱ '.repeat(400)}` }).join('\n');
    expect(lines).toContain('공백을 폈고 앞부분만');
  });

  test('편 것과 자른 것이 «겹칠 때» 두 길이를 따로 적는다 (원문 길이를 편 길이로 부르지 않는다)', () => {
    const ask = `${'ㄱ '.repeat(400)}`;   // 편 뒤 800자 안팎 · 원문은 그보다 길다
    const lines = rfcGoalProseSection({ ...base, ask }).join('\n');
    expect(lines).toContain(`원문 ${ask.length}자`);
    expect(lines).toContain(`앞 300자`);
    expect(lines).toContain('편 뒤');
  });

  test('안 좁힌 경우 «보장 없는 문장»을 단언하지 않는다', () => {
    const lines = rfcGoalProseSection({ ...base, narrowedPath: null, narrowedRule: null }).join('\n');
    expect(lines).toContain('«안 좁혔다»');
    expect(lines).not.toContain('아래 절들이 대상을 이름으로 말한다');
  });

  test('접지는 돌았는데 파일이 0개인 경우를 «근거 없음»과 가른다', () => {
    const lines = rfcGoalProseSection({ ...base, groundedFiles: [], grounded: true }).join('\n');
    expect(lines).toContain('파일 0개');
    expect(lines).not.toContain('근거 없음');
  });

  test('사람용 선행 제목을 만들되 골 절 이름을 쓰지 않는다', () => {
    const lines = rfcGoalProseSection(base);
    const joined = lines.join('\n');
    expect(joined).toContain('## 왜 이 골인가');
    expect(joined).toContain('판정층이 본문 안의 이름도 계약으로 읽을 수 있다');
    expect(lines.filter((line) => /^##(?:[ \t]|$)/.test(line))).toEqual(['## 왜 이 골인가']);
  });

  test('골 절 «이름»을 쓰지 않는다 — 판정층이 본문 안의 이름도 계약으로 읽는다', () => {
    const lines = rfcGoalProseSection(base).join('\n');
    for (const name of ['PROBLEM', 'WHAT TO BUILD', 'RULES', 'ACCEPTANCE CRITERIA', 'REQUIRED EVIDENCE', 'TRACED PATHS', 'SCOPE BOUNDARY']) {
      expect(lines).not.toContain(name);
    }
  });
});

// ⭐⭐⭐ 2026-08-09 — 「왜」 절이 «은퇴»했다(대표 · 소비자 전수 감사: 파싱 «0» · 읽는 표면 «0»).
// ⛔ 이 describe 는 옛 계약(*"산문이 골 절 앞에 온다"*)을 **삭제하지 않고 «뒤집은»** 것이다 —
//   같은 경계 사례(절 순서 · 제목 중복 · 머리 블록 · goalId 파싱)를 그대로 문다.
// ⛔⭐ 저작을 «두 번»만 돌린다 — `authorGoal` 은 이 스위트에서 가장 비싼 호출이고,
//   test 마다 새로 돌리면 옆 테스트가 5초 벽에 걸린다(실측: 넷을 돌렸더니 둘이 타임아웃).
describe('저작 산출에서 「왜」 절이 «은퇴»했다 — 그 값은 관측으로 간다', () => {
  const omitted: Record<string, unknown>[] = [];
  const LONG_ASK = `${ask}\n경계: 저작 시점만 고친다.`;
  const SHORT_ASK = 'x';
  let longAsk: Awaited<ReturnType<typeof authorGoal>>;
  let shortAsk: Awaited<ReturnType<typeof authorGoal>>;

  beforeAll(async () => {
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'goal-author' && event === 'goal-summary-omitted' && data) omitted.push(data);
    }) as never);
    try {
      longAsk = await authorGoal(LONG_ASK, deps);
      shortAsk = await authorGoal(SHORT_ASK, deps);
    } finally {
      log.mockRestore();
    }
  });

  test('그 절이 없고 골 절 여덟이 «정확히 한 번»씩 남는다', () => {
    const doc = longAsk.document;
    expect(doc).not.toContain('## 왜 이 골인가');
    // ⛔ 머리 블록 «바로 뒤»가 첫 골 절이다 — 그 사이에 어떤 `##` 도 끼지 않는다.
    expect(doc).toMatch(/\n- RootIntent: [^\n]*\n- GoalType: implement\n\n## PROBLEM\n/);
    // ⛔ 존재만 보면 «중복»을 못 잡는다 — 각 제목이 «정확히 한 번»인지 센다.
    for (const heading of ['## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호']) {
      const times = doc.split('\n').filter((line) => line.trim() === heading).length;
      expect({ heading, times }).toEqual({ heading, times: 1 });
    }
    // ⭐ 머리 블록이 안 밀렸다 — goalId 는 여전히 파싱된다.
    expect(parseGoalId(doc)).toMatch(/^[0-9a-f]{16}$/);
  });

  // ⛔⭐⭐ 오라클 설계 — production 의 «식»을 복제하면 계산이 틀려도 오라클이 같이 틀려 통과한다
  //   (이 골의 0R·1R must-fix 가 정확히 그것이었다: `expect.any(Number)` ⊕ 계산 복제).
  //   ⇒ 대신 ***관측이 자기 필드로 자기 값을 재구성할 수 있는가***를 문다. 재구성 입력은 전부
  //     관측에 실린 것(`narrowedPath`·`narrowedRule`·`boundaryDecisionCount`)과 fixture 다.
  //     이러면 `ask.length` 같은 «그럴듯한 동적 값»도 통과 못 한다.
  test('없앤 글자 수가 관측 필드로 «재구성»된다 — 임의의 동적 값이 아니다', () => {
    expect(omitted).toHaveLength(2);
    for (const [index, source] of [LONG_ASK, SHORT_ASK].entries()) {
      const data = omitted[index]!;
      const rebuilt = [...rfcGoalProseSection({
        ask: source,
        groundedFiles: facts.files,
        grounded: true,
        narrowedPath: data.narrowedPath as string | null,
        narrowedRule: data.narrowedRule as string | null,
        boundaryDecisionCount: data.boundaryDecisionCount as number,
      }).join('\n')].length;
      expect({ index, count: data.omittedCharacterCount }).toEqual({ index, count: rebuilt });
      expect(data.omittedCharacterCount as number).toBeGreaterThan(0);
      // ⛔ ask 길이를 그대로 쓴 배선을 배제한다 — 절은 고정 문구를 품으므로 항상 ask 보다 길다.
      expect(data.omittedCharacterCount as number).not.toBe([...source].length);
    }
    expect(omitted[0]!.omittedCharacterCount).not.toBe(omitted[1]!.omittedCharacterCount);
  });

  test('접지 파일 수와 경계 개수가 «실측»으로 실린다 — 상수 배선이면 갈린다', () => {
    // ⛔ 타입만 보면 0 같은 잘못된 상수 배선이 통과한다 ⇒ fixture 의 «아는 값»으로 문다.
    //   fixture 는 접지 파일 «하나»(src/example.ts)를 준다.
    expect(omitted.map((data) => data.groundedFileCount)).toEqual([facts.files.length, facts.files.length]);
    // ⭐ 경계는 두 입력이 «갈린다» — 긴 ask 만 「경계:」 표지를 하나 갖는다. 상수면 이 줄이 깨진다.
    expect(omitted.map((data) => data.boundaryDecisionCount)).toEqual([1, 0]);
    // ⛔ 「안 좁혔다」와 「좁혔는데 규칙을 모른다」를 한 값으로 뭉치지 않는다 — 둘이 따로 실린다.
    for (const data of omitted) {
      expect(data).toHaveProperty('narrowedPath');
      expect(data).toHaveProperty('narrowedRule');
    }
    // ⭐ 조인 축 — 이 관측이 그 골의 것임을 문서와 대조한다(둘 다 갈린다).
    expect(omitted[0]!.goalId).toBe(parseGoalId(longAsk.document));
    expect(omitted[1]!.goalId).toBe(parseGoalId(shortAsk.document));
    expect(omitted[0]!.goalId).not.toBe(omitted[1]!.goalId);
  });
});

// ⭐⭐ SCQA 요약이 `Situation`/`Complication` 을 대체한다 — 그리고 ***폴백이 근거를 다시 싣지 않는다***.
//
// ⛔ 이 절이 있는 이유(무인 리뷰 must-fix · 2026-08-08): 초안의 폴백은 종전 문면
//   (`persistentEvidence.join(' ')`)으로 돌아갔다. 그것이 바로 이 변경이 없애려던 것이라
//   ***폴백이 목표를 되돌렸다.*** 리뷰 문면: *"echo 가드가 버린 직후 호출자가 동일 근거 원문을
//   다시 삽입하는 구조라서 코드 수준 중복 방지가 실제로는 보장되지 않는다."*
describe('goal author — SCQA 요약과 비중복 폴백', () => {
  const EVIDENCE = 'src/example.ts:42 — authorGoal receives this Read-verified call path.';
  const situationLine = (doc: string): string => doc.split('\n').find((l) => l.startsWith('Situation:')) ?? '';
  const complicationLine = (doc: string): string => doc.split('\n').find((l) => l.startsWith('Complication:')) ?? '';

  test('요약이 오면 두 줄이 그 요약이고 근거 원문이 들어가지 않는다', async () => {
    const authored = await authorGoal('수용 기준을 간략하게 줄여라.', {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: ['줄인다'],
        verbatimPreserved: true,
        situation: '한 자리가 항목마다 줄을 만든다',
        complication: '그래서 문서가 무거워진다',
      }),
    });
    expect(situationLine(authored.document)).toBe('Situation: GROUNDED — 한 자리가 항목마다 줄을 만든다');
    expect(complicationLine(authored.document)).toBe('Complication: GROUNDED — 그래서 문서가 무거워진다');
    // ⭐ 근거는 «아래 절»에 그대로 남는다 — 잃는 것이 없다는 것이 이 변경의 전제다.
    expect(authored.document).toContain(EVIDENCE);
  });

  test('⛔ 요약이 없으면 폴백도 근거를 «다시 싣지 않는다»', async () => {
    const authored = await authorGoal('수용 기준을 간략하게 줄여라.', { ...deps });
    const situation = situationLine(authored.document);
    const complication = complicationLine(authored.document);
    expect(situation).not.toContain(EVIDENCE);
    expect(complication).not.toContain(EVIDENCE);
    // 「요약이 없었다」가 문면으로 구별된다 ⇒ 문서만 보고 배선 상태를 안다.
    expect(complication).toContain('No authored problem summary was produced');
    expect(situation).toContain('no authored state summary was produced');
    expect(situation).toContain('the canonical verbatim request block below (Original ask)');
    expect(situation).not.toContain('수용 기준을 간략하게 줄여라');
    // 그리고 근거 자체는 여전히 문서 안에 «한 번» 있다.
    expect(authored.document).toContain(EVIDENCE);
  });

  test('한쪽 요약만 왔으면 그쪽만 요약이고 다른 쪽 폴백도 근거를 안 싣는다', async () => {
    const authored = await authorGoal('수용 기준을 간략하게 줄여라.', {
      ...deps,
      enhance: async (raw) => ({
        original: raw,
        checklist: ['줄인다'],
        verbatimPreserved: true,
        complication: '문서가 무거워진다',
      }),
    });
    expect(complicationLine(authored.document)).toBe('Complication: GROUNDED — 문서가 무거워진다');
    expect(situationLine(authored.document)).not.toContain(EVIDENCE);
  });

  test('접지가 없으면 NOT-GROUNDED 문면은 그대로다 (요약이 와도 대체하지 않는다)', async () => {
    const authored = await authorGoal('수용 기준을 간략하게 줄여라.', {
      ...deps,
      ground: async () => noFacts,
      enhance: async (raw) => ({
        original: raw,
        checklist: ['줄인다'],
        verbatimPreserved: true,
        situation: '이 요약은 쓰이지 않아야 한다',
        complication: '이 요약도 쓰이지 않아야 한다',
      }),
    });
    expect(situationLine(authored.document)).toContain('NOT-GROUNDED');
    expect(situationLine(authored.document)).not.toContain('쓰이지 않아야 한다');
    expect(complicationLine(authored.document)).toContain('NOT-GROUNDED');
  });
});

/**
 * ⛔⭐⭐ 무인 리뷰(2026-08-08)가 이 절을 요구했다 — goal-context 를 골 문서에서 «빼는» 동작 변경과
 *   그 신규 관측에 테스트가 «하나도» 없었다. ⇒ 실렸는지 안 실렸는지를 아무도 재지 않았다.
 *
 * ⭐ 그리고 이 절은 «두 부재»를 «둘 다» 문다 — 대표 정정(2026-08-08)이 그 둘을 갈랐기 때문이다:
 *   ⓐ 골 «문서»에 안 실린다   ⓑ 저작 «프롬프트»에도 안 간다(「추후 필요시 쓰는 내용」이다)
 *   ⛔ ⓐ만 재면 초판(문서에서 빼서 프롬프트로)도 통과한다.
 */
describe('goal author — goal-context 규범은 문서에도 저작 프롬프트에도 «안» 실린다', () => {
  const GOAL_CONTEXT = [
    '- [goal-context:01-goal-authoring-checks]',
    '```',
    '① 이 골이 손대는 자리에 «기존 계약»이 있나',
    '```',
  ];
  const contextDeps: GoalAuthorDeps & { mandatoryGoalContextEvidence?: readonly string[] } = {
    ...deps,
    mandatoryGoalContextEvidence: GOAL_CONTEXT,
  };

  test('골 문서 어디에도 goal-context 문면이 없다', async () => {
    const authored = await authorGoal('평범한 요청이다.', contextDeps);

    expect(authored.document).not.toContain('goal-context:01-goal-authoring-checks');
    expect(authored.document).not.toContain('① 이 골이 손대는 자리에');
    expect(authored.document).not.toContain('Mandatory goal-context reference knowledge');
  });

  /** ⛔ 이 테스트가 «초판»(프롬프트로 옮긴다)을 기각한다 — 대표 정정을 코드가 아니라 «테스트»가 쥔다. */
  test('저작 프롬프트(enhance 인자)에도 goal-context 문면이 «안» 간다', async () => {
    // ⛔⭐ 무인 리뷰 지적(2026-08-08): 초판은 `opts` «만» 기록해서 goal-context 가 «첫 인자」(raw
    //   프롬프트)로 주입되는 회귀를 통과시켰다. ⇒ 두 인자를 «둘 다» 본다.
    const seen: { raw: string; opts: unknown }[] = [];
    await authorGoal('평범한 요청이다.', {
      ...contextDeps,
      enhance: async (raw: string, opts?: unknown) => {
        seen.push({ raw, opts: opts ?? null });
        return { original: raw, checklist: [], verbatimPreserved: true };
      },
    });

    expect(seen).toHaveLength(1);
    const wholeCall = JSON.stringify(seen[0]);
    expect(wholeCall).not.toContain('goal-context');
    expect(wholeCall).not.toContain('이 골이 손대는 자리에');
    // ⭐ 첫 인자를 «따로» 한 번 더 못 박는다 — 합친 직렬화만 보면 어느 인자였는지 안 갈린다.
    expect(seen[0]?.raw).not.toContain('goal-context');
    expect(seen[0]?.raw).toBe('평범한 요청이다.');
  });

  /** ⭐ 「빠졌다」와 「애초에 없다」를 가르는 자리 — 관측이 그 둘을 «다른 값»으로 낸다. */
  test('goal-context-placement 관측이 items·chars·placement 를 낸다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await authorGoal('평범한 요청이다.', contextDeps);

      expect(log).toHaveBeenCalledWith('goal-author', 'goal-context-placement', {
        authorRunId: expect.any(String),
        items: GOAL_CONTEXT.length,
        chars: GOAL_CONTEXT.reduce((sum, line) => sum + line.length, 0),
        placement: 'omitted',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('goal-context 가 «애초에 없는» 판은 items 0 으로 갈린다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await authorGoal('평범한 요청이다.', deps);

      expect(log).toHaveBeenCalledWith('goal-author', 'goal-context-placement', {
        authorRunId: expect.any(String),
        items: 0,
        chars: 0,
        placement: 'omitted',
      });
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * ⛔⭐⭐ 무인 리뷰(2026-08-08)가 이 절을 요구했다 — 저작 후보의 «배선·우선순위·출처 관측»에
 *   테스트가 «하나도» 없었다. 그래서 `fromAuthoring` 이 「채택」이 아니라 「생성」을 세고 있었는데도
 *   아무 테스트도 안 깨졌다. ⇒ ***자가 거짓을 말해도 게이트가 침묵했다.***
 */
describe('goal author — 수용 구별 관측', () => {
  const request = '수용 구별: producer states must have distinct values.';
  const observation = (state: string, value: string, source = 'producer') =>
    `Acceptance distinction: state = ${state}; value = ${value}; source = ${source}`;

  test.each([
    ['not-requested', 'ordinary request', [], 'not-requested'],
    ['supported', request, [observation('cold', '0'), observation('warm', '1')], 'supported'],
    ['missing-value', request, [], 'missing-value'],
    ['same-value', request, [observation('cold', '0'), observation('warm', '0')], 'same-value'],
    ['ambiguous-or-conflicting', request, [observation('cold', '0'), observation('cold', '1')], 'ambiguous-or-conflicting'],
    ['ambiguous-or-conflicting', request, [observation('cold', '0'), observation('warm', '1'), observation('hot', '1')], 'ambiguous-or-conflicting'],
  ] as const)('renders %s without semantic inference', async (_name, ask, evidence, status) => {
    const authored = await authorGoal(ask, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [...evidence] }),
    });
    expect(authored.document).toContain(`### 수용 구별 관측\n- Status: ${status}`);
  });

  test('renders unsupported same-value observations, forwards unchanged grounded facts, and does not gate authoring', async () => {
    const seen: unknown[] = [];
    const authored = await authorGoal(request, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [observation('cold', '0'), observation('warm', '0')] }),
      enhance: async (raw, opts) => {
        seen.push(opts);
        return { original: raw, checklist: [], verbatimPreserved: true, enhancedBy: 'fallback' };
      },
    });

    expect(seen).toEqual([{ groundedFacts: [observation('cold', '0'), observation('warm', '0')], onUsage: expect.any(Function) }]);
    expect(authored.document).toContain('### 수용 구별 관측\n- Status: same-value');
    expect(authored.document).toContain('must not invent a discriminator or manual input absent from the producer observations.');
    expect(authored.document).toContain('## 판정 신호');
  });

  test.each([
    ['fallback', { enhancedBy: 'fallback' as const }, 'enhancer-fallback'],
    ['no response', {}, 'enhancer-no-response'],
    ['response', { enhancedBy: 'llm' as const }, 'enhancer-response'],
  ])('preserves enhancer %s as a distinct advisory observation', async (_name, enhancement, expectedStatus) => {
    const authored = await authorGoal(request, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [] }),
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true, ...enhancement }),
    });

    expect(authored.document).toContain(`Status: missing-value — a distinction was requested but no explicit state/value/source producer observation was grounded. ${expectedStatus}.`);
    expect(authored.document).toContain('## ACCEPTANCE CRITERIA');
  });

  test('preserves existing human decision-signal priority while rendering supported observations', async () => {
    const authored = await authorGoal(`${request}\n판정 신호: 조건 = human condition; 관측 = human observation; 기대 = human result`, {
      ...deps,
      ground: async () => ({ ...facts, persistentEvidence: [observation('cold', '0'), observation('warm', '1')] }),
      enhance: async (raw) => ({
        original: raw, checklist: [], verbatimPreserved: true,
        decisionSignal: { condition: 'LLM condition', observation: 'LLM observation', expectedResult: 'LLM result' },
      }),
    });

    expect(authored.document).toContain('### 수용 구별 관측\n- Status: supported');
    expect(authored.document).toContain('  - Condition: human condition');
    expect(authored.document).not.toContain('  - Condition: LLM condition');
  });
});

describe('goal author — 판정 신호의 «셋째 출처»(저작 LLM) 배선·우선순위·출처 관측', () => {
  const AUTHORED = {
    condition: '저작 LLM 이 세 칸을 만든다',
    observation: 'bun test src/self-implement/goal-author.test.ts',
    expectedResult: '판정 신호 절에 저작 후보가 실린다',
  };
  const authoringDeps = {
    ...deps,
    enhance: async (raw: string) => ({
      original: raw,
      checklist: [],
      verbatimPreserved: true,
      decisionSignal: AUTHORED,
    }),
  };
  const ABSENT = '- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.';
  const signalsOf = (document: string) => document.slice(document.indexOf('## 판정 신호'));
  const sourceCall = (log: { mock: { calls: unknown[][] } }) => log.mock.calls
    .find((call) => call[0] === 'goal-author' && call[1] === 'decision-signal-source')?.[2];

  test('사람·접지 후보가 «없을 때» 저작 후보가 실리고 출처가 저작으로 관측된다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal('판정 신호를 안 쓴 평범한 요청이다.', {
        ...authoringDeps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      });
      const signals = signalsOf(authored.document);

      expect(signals).toContain(`  - Condition: ${AUTHORED.condition}`);
      expect(signals).toContain(`  - Observation: ${AUTHORED.observation}`);
      expect(signals).toContain(`  - Expected result: ${AUTHORED.expectedResult}`);
      expect(signals).not.toContain('UNVERIFIABLE');
      expect(sourceCall(log)).toMatchObject({ fromAsk: 0, fromEvidence: 0, authoringOffered: 1, fromAuthoring: 1 });
    } finally {
      log.mockRestore();
    }
  });

  /**
   * ⭐⭐ 이 테스트가 무인 리뷰가 잡은 «그 버그»를 문다 — 초판은 저작 후보가 «버려진» 이 판에서도
   *   `fromAuthoring: 1` 을 냈다. 「만들었나」와 「쓰였나」가 한 값이었기 때문이다.
   */
  test('사람이 ask 에 쓴 신호가 있으면 저작 후보는 «제외»되고 fromAuthoring 이 0 이다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal('판정 신호: 조건 = 사람이 썼다; 관측 = 사람이 준 명령; 기대 = 사람 것이 남는다\n일반 요구는 다듬는다.', {
        ...authoringDeps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      });
      const signals = signalsOf(authored.document);

      expect(signals).toContain('  - Condition: 사람이 썼다');
      expect(signals).not.toContain(AUTHORED.condition);
      expect(sourceCall(log)).toMatchObject({ fromAsk: 1, fromEvidence: 0, authoringOffered: 1, fromAuthoring: 0 });
    } finally {
      log.mockRestore();
    }
  });

  test('접지 근거에 신호가 있으면 저작 후보는 «제외»되고 fromAuthoring 이 0 이다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const evidence = 'Decision signal: condition = grounding carries a signal; observation = the decision-signal section; expected result = the grounded candidate is rendered';
    try {
      const authored = await authorGoal('판정 신호를 안 쓴 평범한 요청이다.', {
        ...authoringDeps,
        ground: async () => ({ ...facts, persistentEvidence: [evidence] }),
      });
      const signals = signalsOf(authored.document);

      expect(signals).toContain('  - Condition: grounding carries a signal');
      expect(signals).not.toContain(AUTHORED.condition);
      expect(sourceCall(log)).toMatchObject({ fromAsk: 0, fromEvidence: 1, authoringOffered: 1, fromAuthoring: 0 });
    } finally {
      log.mockRestore();
    }
  });

  test('한국어와 영어 키의 접지 신호만 렌더링하고 저작 fallback을 억제한다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const koreanEvidence = '판정 신호: 조건 = 한국어 조건; 관측 = 한국어 관측; 기대 = 한국어 기대';
    const englishEvidence = 'Decision signal: condition = English condition; observation = English observation; expected result = English result';
    const keylessEvidence = '판정 신호: 한국어 조건; 한국어 관측; 한국어 기대';
    try {
      const authored = await authorGoal('판정 신호를 안 쓴 평범한 요청이다.', {
        ...authoringDeps,
        ground: async () => ({ ...facts, persistentEvidence: [koreanEvidence, englishEvidence, keylessEvidence] }),
      });
      const signals = signalsOf(authored.document);

      expect(signals).toContain('  - Condition: 한국어 조건');
      expect(signals).toContain('  - Observation: 한국어 관측');
      expect(signals).toContain('  - Expected result: 한국어 기대');
      expect(signals).toContain('  - Condition: English condition');
      expect(signals).toContain('  - Observation: English observation');
      expect(signals).toContain('  - Expected result: English result');
      expect(signals).not.toContain(keylessEvidence);
      expect(signals).not.toContain(AUTHORED.condition);
      expect(sourceCall(log)).toMatchObject({ fromAsk: 0, fromEvidence: 2, authoringOffered: 1, fromAuthoring: 0 });
    } finally {
      log.mockRestore();
    }
  });

  /** ⛔ 「저작기가 안 만들었다」와 「만들었는데 안 쓰였다」가 «다른 값»이어야 한다. */
  test('저작기가 아무것도 안 만들면 두 축이 «둘 다» 0 이고 종전 UNVERIFIABLE 이 남는다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const authored = await authorGoal('판정 신호를 안 쓴 평범한 요청이다.', {
        ...deps,
        ground: async () => ({ ...facts, persistentEvidence: [] }),
      });

      expect(signalsOf(authored.document)).toContain(ABSENT);
      expect(sourceCall(log)).toMatchObject({ fromAsk: 0, fromEvidence: 0, authoringOffered: 0, fromAuthoring: 0 });
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * ⛔⭐⭐ 배선 회귀 — ***저작 경로가 `checklistUse: 'authoring'` 을 «실제로» 넘기는가.***
 *
 * 🚨 무인 리뷰(2026-08-09)가 잡았다: `enhance.test.ts` 는 `enhancePrompt` 를 «직접» 부르므로
 *   `defaultGoalAuthorDeps` 가 그 인자를 안 넘겨도 «한 줄도 안 깨진다».
 *   ⇒ 그 한 줄이 사라지면 저작 경로가 조용히 `coverage-gate` 로 돌아가고
 *     `ACCEPTANCE CRITERIA` 가 다시 문서의 19.9% 를 먹는다 — 아무 테스트도 안 물면서.
 * 📚 이 저장소가 이미 아는 형태다: 「의존 주입 심은 «배선»까지 물어야 한다」.
 */
describe('goal author — 저작 경로가 enhance 에 checklistUse 를 넘긴다 (배선)', () => {
  test('defaultGoalAuthorDeps leaves clarification self-resolution disabled', () => {
    expect(defaultGoalAuthorDeps(process.cwd()).selfResolveClarification).toBeUndefined();
  });

  test('defaultGoalAuthorDeps().enhance 가 authoring 을 실어 부른다', async () => {
    const seen: unknown[] = [];
    const mod = await import('../prompt-enhance/enhance.js');
    const spy = spyOn(mod, 'enhancePrompt').mockImplementation(async (raw: string, opts?: unknown) => {
      seen.push(opts);
      return { original: raw, enhanced: raw, checklist: [], verbatimPreserved: true, enhancedBy: 'fallback' as const, model: null };
    });
    try {
      await defaultGoalAuthorDeps(process.cwd()).enhance('ask', { deliverableHint: 'x' });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ checklistUse: 'authoring' });
      // ⭐ 호출자가 준 다른 칸을 «먹지 않는다» — 스프레드가 아니라 덮어쓰기면 이 단언이 깨진다.
      expect(seen[0]).toMatchObject({ deliverableHint: 'x' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('writeAuthoredGoal grounding root separation', () => {
  test('grounds against a distinct root while writing the goal beneath the authoring cwd', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-document-root-');
    const groundingRoot = mkdtempSync(join(tmpdir(), 'goal-author-grounding-root-'));
    temporaryDirectories.push(groundingRoot);
    const groundedRoots: string[] = [];

    const result = await writeAuthoredGoal('Author from a distinct grounding repository.', cwd, {
      persistentGrounding: {
        groundMission: async (_ask, { cwd: observedRoot }) => {
          groundedRoots.push(observedRoot);
          return facts;
        },
      },
      enhance: deps.enhance,
      slugFn: async () => 'grounding-root-separation',
    }, undefined, groundingRoot);

    expect(groundedRoots).toEqual([groundingRoot]);
    expect(result.path).toStartWith(join(cwd, 'docs', 'goals'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).not.toStartWith(join(groundingRoot, 'docs', 'goals'));
  });

  test('defaults grounding and goal document placement to cwd when no grounding root is supplied', async () => {
    const cwd = existingGoalDocumentsRoot('goal-author-default-root-');
    const groundedRoots: string[] = [];

    const result = await writeAuthoredGoal('Author from the default repository.', cwd, {
      persistentGrounding: {
        groundMission: async (_ask, { cwd: observedRoot }) => {
          groundedRoots.push(observedRoot);
          return facts;
        },
      },
      enhance: deps.enhance,
      slugFn: async () => 'default-grounding-root',
    });

    expect(groundedRoots).toEqual([cwd]);
    expect(result.path).toStartWith(join(cwd, 'docs', 'goals'));
    expect(existsSync(result.path)).toBe(true);
  });
});

describe('goal file lint — blanket invariant clauses', () => {
  const lintAsk = (ask: string) => lintGoalFile([
    ORIGINAL_ASK_MARKER,
    '```',
    ask,
    '```',
  ].join('\n'), 'main');
  const blanketWarnings = (ask: string) => lintAsk(ask)
    .filter((finding) => finding.level === 'WARN' && finding.tag === 'blanket-invariant');

  test('warns for unnamed preservation clauses even when same-sentence named clauses use 하고, 하며, or commas', () => {
    for (const ask of [
      '모든 동작을 그대로 유지하고 `repoRoot` 키를 보존한다.',
      '모든 동작을 그대로 유지하며 `repoRoot` 키를 보존한다.',
      '모든 동작을 그대로 유지하며, `repoRoot` 키를 보존한다.',
    ]) {
      expect(blanketWarnings(ask)).toHaveLength(1);
    }
  });

  test('preserves warning and finding-array contracts for separated and unnamed blanket invariants', () => {
    const separated = lintAsk('모든 동작을 그대로 유지한다. `repoRoot` 키를 보존한다.');
    const unnamed = lintAsk('모든 동작을 그대로 유지한다.');

    for (const findings of [separated, unnamed]) {
      expect(Array.isArray(findings)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(findings, 'recognizedInvariantCount')).toMatchObject({ enumerable: false });
      expect(findings).toContainEqual(expect.objectContaining({
        level: 'WARN',
        tag: 'blanket-invariant',
        message: expect.any(String),
      }));
      expect(findings).not.toContainEqual(expect.objectContaining({ level: 'ERROR', tag: 'blanket-invariant' }));
    }
  });

  test('does not warn when an explicit named scope precedes its preservation clause', () => {
    for (const ask of [
      '`repoRoot`에 한해서, 모든 동작을 유지한다.',
      '`repoRoot`에 한해, 모든 동작을 유지한다.',
      '`repoRoot`만, 모든 동작을 유지한다.',
      '`repoRoot`를 대상으로 하고 모든 동작을 유지한다.',
      '`repoRoot`를 대상으로 하며, 모든 동작을 유지한다.',
      '`repoRoot`를 대상으로 하고, 모든 동작을 유지한다.',
    ]) {
      expect(blanketWarnings(ask)).toHaveLength(0);
    }
  });

  test('does not split connector text inside named code spans', () => {
    for (const ask of [
      '`repoRoot` 키를 보존한다.',
      '`설정.루트`의 모든 동작을 유지한다.',
      '`설정하고루트`의 모든 동작을 유지한다.',
      '`설정하며루트`의 모든 동작을 유지한다.',
    ]) {
      expect(blanketWarnings(ask)).toHaveLength(0);
    }
  });

  test('falsifies named-scope propagation and code-span masking: removing either protection fails these assertions', () => {
    expect(blanketWarnings('`repoRoot`에 한해서, 모든 동작을 유지한다.')).toHaveLength(0);
    expect(blanketWarnings('`설정하고루트`의 모든 동작을 유지한다.')).toHaveLength(0);
  });
});

describe('summarizeGroundingFileKinds — ⛔ 「접지가 Kotlin 을 읽기는 했나」를 «답할 수 있게» 한다', () => {
  test('확장자별로 «센다» — 합이 파일 수와 같아야 분모로 쓸 수 있다', () => {
    const files = ['a/b.ts', 'a/c.ts', 'x/D.kt', 'y/e.KT', 'Makefile'];
    const kinds = summarizeGroundingFileKinds(files);
    expect(kinds).toEqual({ '.ts': 2, '.kt': 2, '(no extension)': 1 });
    expect(Object.values(kinds).reduce((a, b) => a + b, 0)).toBe(files.length);
  });

  test('⛔ 확장자 «없는» 파일을 버리지 않는다 — 버리면 합이 fileCount 와 어긋난다', () => {
    expect(summarizeGroundingFileKinds(['LICENSE', 'Dockerfile'])).toEqual({ '(no extension)': 2 });
  });

  test('숨김 파일의 앞 점을 «확장자로 읽지 않는다»', () => {
    // `.gitignore` 는 확장자 `.gitignore` 인 파일이 아니라 «이름»이다.
    expect(summarizeGroundingFileKinds(['.gitignore', 'dir/.env'])).toEqual({ '(no extension)': 2 });
  });

  test('파일이 없으면 빈 객체 — ⛔ 「안 쟀다」와 「0개였다」를 같은 값으로 접지 않는다', () => {
    expect(summarizeGroundingFileKinds([])).toEqual({});
  });
});

// ── self-reported-observation — 🩸 이 창의 골이 «두 번» 초록으로 죽은 자리 ────────────
describe('self-reported-observation lint', () => {
  const doc = (signals: string) => [
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '',
    '## 판정 신호', signals, '',
  ].join('\n');
  const tags = (signals: string) => lintGoalFile(doc(signals), 'main').map((f) => f.tag);

  /** 내가 실제로 발사한 문면. 두 판의 «다른» 구현이 둘 다 이 신호를 통과했다. */
  const MINE = '판정 신호: 조건 = `measure-fidelity.ts <url> --full-page --json` 를 친다; '
    + '관측 = 산출 JSON 의 captureScope 필드; 기대 = 그 값이 `full-page` 이다.';

  test('🩸 내가 쓴 그 문면을 «문다»', () => {
    expect(tags(MINE)).toContain('self-reported-observation');
  });

  test('⛔ 형제 규칙은 이 문면을 «안 물었다» — 그래서 이 규칙이 있다', () => {
    expect(inspectAskDecisionSignalMarker(MINE).anyObservesIdentifierNames).toBe(false);
  });

  test('✅ 「거짓으로 못 내는 결과」를 보는 문면은 «안» 잡힌다', () => {
    const fixed = '판정 신호: 조건 = 그 명령을 친다; 관측 = 저장된 스크린샷의 픽셀 높이; 기대 = 뷰포트 높이보다 크다';
    expect(tags(fixed)).not.toContain('self-reported-observation');
  });

  test('⛔ 게이트가 아니라 관측이다 — WARN 이고 ERROR 가 아니다', () => {
    const found = lintGoalFile(doc(MINE), 'main').find((f) => f.tag === 'self-reported-observation');
    expect(found?.level).toBe('WARN');
  });

  test('⭐ 메시지가 «무엇을 대신 보라»를 말한다 — 금지만 주면 자식이 멈춘다', () => {
    const msg = lintGoalFile(doc(MINE), 'main').find((f) => f.tag === 'self-reported-observation')?.message ?? '';
    expect(msg).toContain('cannot fake');
    expect(msg).toMatch(/pixel height|byte count|exit code/);
  });
});

describe('default-invocation-observation lint', () => {
  const doc = (target: string, signals: string) => [
    `대상 경로: ${target}`,
    '## PROBLEM', 'x', '', '## WHAT TO BUILD', 'x', '',
    '## ACCEPTANCE CRITERIA', 'x', '', '## REQUIRED EVIDENCE', '- [t] proof', '',
    '## TRACED PATHS', 'x', '', '## SCOPE BOUNDARY', 'x', '', '## 불변식', 'x', '',
    '## 판정 신호', signals, '',
  ].join('\n');
  const findings = (target: string, signals: string) => lintGoalFile(doc(target, signals), 'main')
    .filter((finding) => finding.tag === 'default-invocation-observation');

  test('fires when a scripts/*.ts target is judged only by bun test', () => {
    const found = findings('scripts/x.ts · scripts/x.test.ts', '판정 신호: 조건 = 픽스처; 관측 = bun test scripts/x.test.ts; 기대 = 그 단언이 통과한다');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('WARN');
    expect(found[0]?.message).toContain('`scripts/x.ts`');
    expect(found[0]?.message).not.toContain('scripts/x.test.ts');
    expect(found[0]?.message).toContain('인자 없이 저장소 루트에서 돌려 나온 수를 판정 신호로 둔다');
  });

  test('does not fire when the same document also requires the no-arg count', () => {
    const signals = [
      '판정 신호: 조건 = 픽스처; 관측 = bun test scripts/x.test.ts; 기대 = 그 단언이 통과한다',
      '판정 신호: 조건 = bun scripts/x.ts 를 인자 없이 돌려 나온 수를 판정 신호로 둔다; 관측 = bun scripts/x.ts; 기대 = 그 수가 있다',
    ].join('\n');
    expect(findings('scripts/x.ts · scripts/x.test.ts', signals)).toEqual([]);
  });

  test('fires for the English twin and stays quiet when that twin records the count', () => {
    const bare = 'decision signal: condition = fixture only; observation = bun test scripts/x.test.ts; expected result = the assertion passes';
    expect(findings('scripts/x.ts', bare)).toHaveLength(1);
    const covered = [
      bare,
      'decision signal: condition = run bun scripts/x.ts with no args at the repo root; observation = bun scripts/x.ts; expected result = the count is recorded',
    ].join('\n');
    expect(findings('scripts/x.ts', covered)).toEqual([]);
  });

  // ⭐ 2026-09-25 — 실물 docs/goals 골 문서를 읽는 시험은 goal-author-real-goal-docs.test.ts 로 옮겼다(원본 전용 · 공개본 exclude).

  test('lite refuses an ask without any falsifiable signal line instead of emitting a goal without one', async () => {
    await expect(authorGoal('대상 경로: src/a.ts\n그냥 고쳐 주세요', { authorGrade: { grade: 'lite', source: 'flag' } } as never)).rejects.toThrow('falsifiable signal');
  });
});
