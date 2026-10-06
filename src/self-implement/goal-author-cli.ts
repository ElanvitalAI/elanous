import { readFileSync, realpathSync } from 'node:fs';
import { writeGoalDocumentAtomic } from './goal-document-write.js';
import { isAbsolute, relative, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { parseAskProseTitle } from '../self-dev/launch-preflight.js';
import { createGoalAuthorDecomposeSteps, readRecentStepCountsFailOpen, type RecentStepCountReader } from './goal-author-decompose.js';
import { defaultGoalAuthorSelfResolve, parseGoalDocumentClarifications, seedGoalAuthorFromAnsweredClarification, seedGoalAuthorFromClarification, selfAnswerGoalDocumentClarifications } from './goal-author-clarification.js';
import { classifyGoalInterviewRound, type GoalInterviewRoundStatus } from './goal-author-closure.js';
import { recordGoalAsk } from './goal-ask-store.js';
import { pressDecisionSignal } from './decision-signal-press.js';
import {
  formatGoalFileLintFinding,
  ORIGINAL_ASK_MARKER,
  GOAL_TYPES,
  planGateSignals,
  verbatimOriginalAsk,
  writeAuthoredGoal,
  type GoalAuthorDeps,
  type GoalAuthorGradeSelection,
  resolveGoalAuthorGrade,
  type GoalType,
  type GoalFileLintFinding,
} from './goal-author.js';

function decisionSignalSection(document: string): string {
  const lines = document.split(/\r\n|[\n\r\u2028\u2029]/);
  const start = lines.findIndex((line) => /^##\s+판정 신호\s*$/.test(line));
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

export interface DecisionSignalKinds {
  readonly condition: boolean;
  readonly observation: boolean;
  readonly expected: boolean;
}

export interface DecisionObservations {
  readonly extracted: boolean;
}

/** Classifies the independently declared fields in the authored decision-signal section. */
export function inspectDecisionSignalKinds(document: string): DecisionSignalKinds {
  const section = decisionSignalSection(document);
  return {
    condition: /^\s*- Condition:\s*\S/m.test(section),
    observation: /^\s*- Observation:\s*\S/m.test(section),
    expected: /^\s*- Expected result:\s*\S/m.test(section),
  };
}

/** Classifies whether the declared decision-signal fields form a complete observation. */
export function inspectDecisionObservations(kinds: DecisionSignalKinds): DecisionObservations {
  return { extracted: kinds.condition && kinds.observation && kinds.expected };
}

export function formatGoalAuthorSelfInspection(document: string, findings: readonly GoalFileLintFinding[]): string {
  const kinds = inspectDecisionSignalKinds(document);
  const observations = inspectDecisionObservations(kinds);
  const lintErrorCount = findings.filter((finding) => finding.level === 'ERROR').length;
  const informationCount = planGateSignals(document, findings).unverifiable;
  const launch = lintErrorCount === 0 ? 'ready' : 'blocked';
  return [
    ...findings.map(formatGoalFileLintFinding),
    JSON.stringify(planGateSignals(document, findings)),
    `launch: ${launch} (${lintErrorCount} blocking lint error${lintErrorCount === 1 ? '' : 's'}; ${informationCount} informational unverifiable item${informationCount === 1 ? '' : 's'})`,
    pressDecisionSignal({ kinds, observations }, ({ kinds, observations }) =>
      `decision signal: extracted=${observations.extracted} · condition=${kinds.condition} · observation=${kinds.observation} · expected=${kinds.expected}`),
  ].join('\n');
}

interface GoalAuthorCliOptions {
  cwd: string;
  groundingCwd?: string;
  parentGoalFile?: string;
  parentQuestionId?: string;
  fromClarification?: string;
  reauthorFromAnsweredClarification?: boolean;
  supersedes?: string;
  rootIntent?: string;
  goalType?: string;
  authorGrade?: GoalAuthorGradeSelection;
  selfResolveClarifications?: boolean;
  adversarialReview?: boolean;
  disableAdversarialReview?: boolean;
  onProgress?: GoalAuthorDeps['onProgress'];
  launchPreflight?: GoalAuthorDeps['launchPreflight'];
}

export interface GoalAuthorCliDeps {
  readFile?: typeof readFileSync;
  realpath?: typeof realpathSync;
  resolvePath?: typeof resolve;
  write?: typeof writeAuthoredGoal;
  /** Optional decomposition seam; test and caller injections take precedence over the shared default. */
  decomposeSteps?: GoalAuthorDeps['decomposeSteps'];
  /** Optional shared decomposition factory injection for CLI option propagation tests. */
  createDecomposeSteps?: typeof createGoalAuthorDecomposeSteps;
  /** Optional recent-count reader injection; thrown reads omit the optional config field. */
  recentStepCountReader?: RecentStepCountReader;
  /** Resolver supplied only by the explicit CLI self-resolution opt-in. */
  selfResolveClarification?: NonNullable<GoalAuthorDeps['selfResolveClarification']>;
  writeFile?: (path: string, document: string) => void;
  recordAsk?: typeof recordGoalAsk;
}

interface GoalAuthorCliResult {
  path: string;
  authored: Awaited<ReturnType<typeof writeAuthoredGoal>>['authored'];
  interviewRound?: {
    status: GoalInterviewRoundStatus;
    previousClarifications: number;
    nextClarifications: number;
    previousEvidence: number;
    nextEvidence: number;
  };
}

export function formatGoalInterviewRound(
  interviewRound: NonNullable<GoalAuthorCliResult['interviewRound']>,
  lintErrorCount: number,
): string {
  const meaning = interviewRound.status === 'converged'
    ? '열린 질문이 없어져 좁아진 인터뷰가 끝났습니다.'
    : interviewRound.status === 'narrowed'
      ? '더 좁아졌지만 열린 질문이 남아 있습니다.'
      : '인터뷰가 더 좁아지지 않았습니다.';
  const launch = lintErrorCount === 0 ? 'ready' : 'blocked';
  return `interview round: ${interviewRound.status} — ${meaning} · evidence: ${interviewRound.previousEvidence} → ${interviewRound.nextEvidence} · launch: ${launch} (${lintErrorCount} lint error${lintErrorCount === 1 ? '' : 's'})`;
}

function interviewRoundCounts(document: string): { clarifications: number; evidence: number } {
  const clarifications = parseGoalDocumentClarifications(document).filter((clarification) => !clarification.answered).length;
  const lines = document.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^(?:- )?Persistent grounding evidence\b/.test(line));
  let evidence = 0;
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      if (!/^  - /.test(line)) break;
      evidence += 1;
    }
  }
  return { clarifications, evidence };
}

function resolveRepositoryRelativePath(goalFile: string, cwd: string, deps: GoalAuthorCliDeps, option: string): string {
  if (isAbsolute(goalFile)) throw new Error(`${option} goal file must be repository-relative`);
  const resolvePath = deps.resolvePath ?? resolve;
  const repositoryRoot = resolvePath(cwd);
  const sourcePath = resolvePath(repositoryRoot, goalFile);
  const relation = relative(repositoryRoot, sourcePath);
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new Error(`${option} goal file must stay within --cwd`);
  }
  return sourcePath;
}

function resolveRepositoryGoalFile(goalFile: string, cwd: string, deps: GoalAuthorCliDeps): string {
  const sourcePath = resolveRepositoryRelativePath(goalFile, cwd, deps, '--from-clarification');
  const realpath = deps.realpath ?? realpathSync;
  const realRepositoryRoot = realpath((deps.resolvePath ?? resolve)(cwd));
  const realSourcePath = realpath(sourcePath);
  const realRelation = relative(realRepositoryRoot, realSourcePath);
  if (realRelation === '..' || realRelation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRelation)) {
    throw new Error('--from-clarification goal file must stay within --cwd');
  }
  return sourcePath;
}

function extractOriginalAsk(document: string): string {
  const ask = verbatimOriginalAsk(document);
  if (ask !== null) return ask;

  const lines = [...document.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => ({ text: match[1], start: match.index!, end: match.index! + match[0].length, contentEnd: match.index! + match[1].length }));
  const markerLine = lines.findIndex(({ text }) => text === ORIGINAL_ASK_MARKER);
  if (markerLine === -1) throw new Error('superseded goal original ask marker not found');
  if (lines[markerLine + 1] === undefined || !/^`+$/.test(lines[markerLine + 1].text)) {
    throw new Error('superseded goal original ask fence missing');
  }
  const fence = lines[markerLine + 1].text;
  const closingLine = lines.findIndex(({ text }, index) => index > markerLine + 1 && text === fence);
  if (closingLine === -1) throw new Error('superseded goal original ask fence not closed');
  return document.slice(
    lines[markerLine + 1].end,
    closingLine === markerLine + 2 ? lines[closingLine].start : lines[closingLine - 1].contentEnd,
  );
}

function resolveGoalType(goalType: string | undefined): GoalType | undefined {
  if (goalType === undefined) return undefined;
  if (GOAL_TYPES.includes(goalType as GoalType)) return goalType as GoalType;
  throw new Error(`invalid goal type "${goalType}"; expected one of: ${GOAL_TYPES.join(', ')}`);
}

function resolveAdversarialReview(opts: GoalAuthorCliOptions): boolean | undefined {
  if (opts.adversarialReview && opts.disableAdversarialReview) {
    throw new Error('--adversarial-review and --disable-adversarial-review cannot be supplied together');
  }
  if (opts.adversarialReview) return true;
  if (opts.disableAdversarialReview) return false;
  return undefined;
}

/** Resolve author CLI input without changing the user-visible parent provenance spelling. */
export async function runGoalAuthorCli(
  parts: string[],
  opts: GoalAuthorCliOptions,
  deps: GoalAuthorCliDeps = {},
): Promise<GoalAuthorCliResult> {
  const goalType = resolveGoalType(opts.goalType);
  const adversarialReview = resolveAdversarialReview(opts);
  let ask = parts.join(' ');
  let parentGoalFile = opts.parentGoalFile;
  let parentQuestionId = opts.parentQuestionId;
  let clarificationAnswers: Record<string, string> | undefined;
  const superseded = opts.supersedes
    ? { path: resolveRepositoryRelativePath(opts.supersedes, opts.cwd, deps, '--supersedes') }
    : undefined;
  const supersededDocument = superseded
    ? (deps.readFile ?? readFileSync)(superseded.path, 'utf8')
    : undefined;
  if (opts.fromClarification) {
    if (ask.trim()) throw new Error('ask and --from-clarification cannot be supplied together');
    if (parentGoalFile || parentQuestionId) {
      throw new Error('--from-clarification cannot be supplied with parent goal options');
    }
    const separator = opts.fromClarification.lastIndexOf('#');
    if (separator <= 0 || separator === opts.fromClarification.length - 1) {
      throw new Error('--from-clarification must be <goalFile>#<questionId>');
    }
    const goalFile = opts.fromClarification.slice(0, separator);
    const questionId = opts.fromClarification.slice(separator + 1);
    const sourcePath = resolveRepositoryGoalFile(goalFile, opts.cwd, deps);
    const sourceDocument = (deps.readFile ?? readFileSync)(sourcePath, 'utf8');
    const seed = opts.reauthorFromAnsweredClarification
      ? seedGoalAuthorFromAnsweredClarification(sourceDocument, goalFile, questionId)
      : seedGoalAuthorFromClarification(sourceDocument, goalFile, questionId);
    clarificationAnswers = Object.fromEntries(
      parseGoalDocumentClarifications(sourceDocument)
        .filter((clarification) => clarification.answered)
        .map((clarification) => [clarification.questionId, clarification.answer]),
    );
    // ⛔ 두 길의 ask 는 «다르다» — 같은 시드를 쓰면 재저작이 「원래 문제」를 잃는다(72차 실측).
    //   ⑴ 미답 질문 → «자식 골»: ask 는 그 질문이다. 그 골이 답하려는 것이 «질문 자체»이기 때문이다.
    //   ⑵ 답한 질문 → «재저작»: ask 는 ***부모의 원래 ask***여야 한다. 사람이 답한 것은 그 문제의
    //      한 칸을 채운 것이지 문제를 «바꾼» 것이 아니다. 답 자체는 아래 clarificationAnswers 로 실린다.
    // 📏 안 그러면: 재저작 골의 ORIGINAL_ASK_MARKER 아래에 «저작기 자신의 질문»이 원래 ask 로 적히고,
    //   그 골은 접지가 비어(대상 경로 0) 전제 검사에 막힌다 — 72차에 실물로 났다.
    ask = opts.reauthorFromAnsweredClarification ? extractOriginalAsk(sourceDocument) : seed.ask;
    parentGoalFile = seed.parent.goalFile;
    parentQuestionId = seed.parent.questionId;
  }
  if (!ask.trim() && opts.supersedes) {
    ask = extractOriginalAsk(supersededDocument!);
    clarificationAnswers = Object.fromEntries(
      parseGoalDocumentClarifications(supersededDocument!)
        .filter((clarification) => clarification.answered)
        .map((clarification) => [clarification.questionId, clarification.answer]),
    );
  }
  if (!ask.trim()) throw new Error('ask required');
  if (Boolean(parentGoalFile) !== Boolean(parentQuestionId)) {
    throw new Error('parent goal file and parent question id must be supplied together');
  }
  const parentDocument = parentGoalFile
    ? (deps.readFile ?? readFileSync)(resolveRepositoryGoalFile(parentGoalFile, opts.cwd, deps), 'utf8')
    : undefined;
  const askProvenance = parentGoalFile && parentQuestionId
    ? { origin: 'clarification-child', parentGoalFile, parentQuestionId }
    : opts.reauthorFromAnsweredClarification
      ? { origin: 'answered-clarification-reauthor' }
      : { origin: 'direct-request' };
  const authorGrade = opts.authorGrade ?? resolveGoalAuthorGrade(undefined, getUserConfig().harness?.authorGrade);
  const recentStepCounts = authorGrade.grade === 'lite' ? undefined : readRecentStepCountsFailOpen(deps.recentStepCountReader);
  const decomposeSteps = authorGrade.grade === 'lite' ? undefined : deps.decomposeSteps ?? (deps.createDecomposeSteps ?? createGoalAuthorDecomposeSteps)(undefined, {
    ...(adversarialReview !== undefined ? { adversarialReview, adversarialReviewSource: 'cli' as const } : {}),
    ...(recentStepCounts !== undefined ? { recentStepCounts } : {}),
  });
  const selfResolutionDeps = opts.selfResolveClarifications
    ? { selfResolveClarification: deps.selfResolveClarification ?? defaultGoalAuthorSelfResolve }
    : {};
  const progressDeps = opts.onProgress ? { onProgress: opts.onProgress } : {};
  const launchPreflightDeps = opts.launchPreflight ? { launchPreflight: opts.launchPreflight } : {};
  const proseTitle = parseAskProseTitle(ask);
  const goalTitleDeps = proseTitle === undefined ? {} : { goalTitle: proseTitle };
  debug.log('goal-author', 'goal-title-forwarded', proseTitle === undefined
    ? { passed: false }
    : { passed: true, titleChars: proseTitle.length });
  const gradeDeps = authorGrade.grade === 'lite' || opts.authorGrade ? { authorGrade } : {};
  const authorDeps: Partial<GoalAuthorDeps> = parentGoalFile && parentQuestionId
    ? { parent: { goalFile: parentGoalFile, questionId: parentQuestionId }, parentDocument, clarificationAnswers, ...(decomposeSteps ? { decomposeSteps } : {}), ...gradeDeps, ...selfResolutionDeps, ...progressDeps, ...launchPreflightDeps, ...(opts.rootIntent !== undefined && { rootIntent: opts.rootIntent }), ...(goalType !== undefined && { goalType }), ...goalTitleDeps }
    : { ...(clarificationAnswers && { clarificationAnswers }), ...(decomposeSteps ? { decomposeSteps } : {}), ...gradeDeps, ...selfResolutionDeps, ...progressDeps, ...launchPreflightDeps, ...(opts.rootIntent !== undefined && { rootIntent: opts.rootIntent }), ...(goalType !== undefined && { goalType }), ...goalTitleDeps };
  const write = deps.write ?? writeAuthoredGoal;
  const result = opts.groundingCwd === undefined
    ? await write(ask, opts.cwd, authorDeps, superseded ? { supersedes: superseded } : undefined)
    : await write(ask, opts.cwd, authorDeps, superseded ? { supersedes: superseded } : undefined, opts.groundingCwd);
  if (opts.selfResolveClarifications) {
    const rework = Boolean(supersededDocument || opts.reauthorFromAnsweredClarification);
    {
      try {
        const resolved = await selfAnswerGoalDocumentClarifications(result.authored.document, {
          path: rework ? 'rework' : 'say-first', ask, resolver: deps.selfResolveClarification ?? defaultGoalAuthorSelfResolve,
          evidence: result.authored.facts
            ? [...(result.authored.facts.persistentEvidence ?? []), ...result.authored.facts.codeFacts, ...result.authored.facts.documentFacts]
            : undefined,
        });
        if (resolved.newlyAnswered > 0) {
          (deps.writeFile ?? writeGoalDocumentAtomic)(result.path, resolved.document);
          result.authored.document = resolved.document;
        }
      } catch (error) {
        // The previous goal file is left intact (atomic replace); implementation proceeds from it with the questions deferred.
        debug.log('goal-author.clarify', 'self-answer-deferred', { reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  try {
    const recorded = (deps.recordAsk ?? recordGoalAsk)({
      authorRunId: result.authored.authorRunId,
      goalFile: result.path,
      ask,
      document: result.authored.document,
    });
    if (!recorded) {
      debug.log('goal-author', 'ask-provenance-record-failed', {
        authorRunId: result.authored.authorRunId,
        goalFile: result.path,
        askChars: ask.length,
        ...askProvenance,
      });
    } else {
      debug.log('goal-author', 'ask-provenance-recorded', {
        authorRunId: result.authored.authorRunId,
        goalFile: result.path,
        askChars: ask.length,
        ...askProvenance,
      });
    }
  } catch (error) {
    debug.log('goal-author', 'ask-provenance-record-failed', {
      authorRunId: result.authored.authorRunId,
      goalFile: result.path,
      askChars: ask.length,
      ...askProvenance,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!supersededDocument) return result;

  const previous = interviewRoundCounts(supersededDocument);
  const next = interviewRoundCounts(result.authored.document);
  const status = classifyGoalInterviewRound(supersededDocument, result.authored.document);
  debug.log('goal-author', 'interview-round-classified', {
    authorRunId: result.authored.authorRunId,
    goalFile: result.path,
    status,
    previousClarifications: previous.clarifications,
    nextClarifications: next.clarifications,
    previousEvidence: previous.evidence,
    nextEvidence: next.evidence,
  });
  return { ...result, interviewRound: { status, previousClarifications: previous.clarifications, nextClarifications: next.clarifications, previousEvidence: previous.evidence, nextEvidence: next.evidence } };
}
