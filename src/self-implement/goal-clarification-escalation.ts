import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  dispatchAskUserQuestion,
  type AskUserQuestionDispatchContext,
  type AskUserQuestionDispatchResult,
} from '../ask-user-question/tool.js';
import {
  createPendingQuestion,
  readPendingQuestionAnswer,
  writePendingQuestion,
} from '../ask-user-question/pending-questions.js';
import { debug } from '../debug/log.js';
import {
  applyClarificationReply,
  parseGoalDocumentClarifications,
} from './goal-author-clarification.js';
import type { HitlDelivery } from '../hitl/types.js';

export const GOAL_CLARIFICATION_ESCALATION_CATEGORY = 'self-implement.clarification-escalation';
export const GOAL_CLARIFICATION_DELIVERY_SOURCES = ['origin', 'input', 'none'] as const;

type GoalClarificationDelivery = Exclude<HitlDelivery, 'all'>;
type GoalClarificationObservedDelivery = HitlDelivery | 'file';
type GoalClarificationEscalationOutcome = 'skipped' | 'delivered' | 'fallback' | 'no-response' | 'failed' | 'timeout';
type GoalClarificationObservationEvent = GoalClarificationEscalationOutcome | 'answered-from-store';
type GoalClarificationFallbackSurface = 'terminal';
/** ⭐ 집계 provenance. wire(`AskUserQuestionResult.answeredBy`)는 «답 하나»의 출처라 2값이지만,
 *  한 골이 여러 배치로 갈리므로 집계는 «네 값»이어야 진실을 안 잃는다:
 *    none  아무 배치도 답을 못 받았다
 *    human 답이 있었고 전부 사람이다        agent 답이 있었고 전부 에이전트다
 *    mixed ⭐ 둘 다 있었다 — ⛔ 이걸 한쪽으로 접으면 「L2 와 사람을 가른다」는 목적 자체가 무너진다
 *          (무인 리뷰 R4 가 「근거 없는 미결 정책을 고정하지 마라」로 이 결정을 강제했다) */
type GoalClarificationAnsweredBy = 'human' | 'agent' | 'none' | 'mixed';

export interface GoalClarificationEscalationInput {
  goalFile: string;
  /** Explicit provenance for isolated test fixtures; never inferred from goalFile. */
  testOrigin?: true;
  delivery?: GoalClarificationDelivery;
  resolvedDelivery?: GoalClarificationObservedDelivery;
  dispatch?: (
    request: Record<string, unknown>,
    dispatchContext?: AskUserQuestionDispatchContext,
  ) => Promise<AskUserQuestionDispatchResult>;
  /** Per-dispatch affinity for an ACP peer or other resolver surface. */
  dispatchContext?: AskUserQuestionDispatchContext;
  /** Resolves the active session's origin surface without coupling this module to session storage. */
  resolveOriginDelivery?: (sessionId: string) => HitlDelivery | undefined;
  /** Non-blocking terminal fallback for a non-TUI delivery with no installed resolver. */
  fallback?: (message: string) => void;
  /** Fail-soft pending persistence for terminal fallbacks; injectable for focused tests. */
  pendingQuestionPersistence?: {
    create: typeof createPendingQuestion;
    write: typeof writePendingQuestion;
    readAnswer?: typeof readPendingQuestionAnswer;
  };
}

export interface GoalClarificationEscalationResult {
  unanswered: number;
  escalated: number;
  delivery: GoalClarificationObservedDelivery;
  outcome: GoalClarificationEscalationOutcome;
  answeredBy: GoalClarificationAnsweredBy;
  fallbackSurface?: GoalClarificationFallbackSurface;
  error?: string;
}

const SUPERVISOR_PLAN_REVISIONS_HEADER = '## SUPERVISOR PLAN REVISIONS';

export interface SupervisorPlanRevisionRelaxation {
  target: string;
  expected: string;
  replacement: string;
}

interface SupervisorPlanRevisionRecord {
  reason: string;
  round: number;
  relaxation?: SupervisorPlanRevisionRelaxation;
}

export interface SupervisorPlanRevisionResult {
  status: 'not-requested' | 'applied' | 'already-applied' | 'failed';
  detail?: string;
}

interface SupervisorPlanRevisionFileSystem {
  readFile: (goalFile: string) => string;
  writeFile: (goalFile: string, document: string) => void;
  renameFile: (from: string, to: string) => void;
  removeFile: (path: string) => void;
  temporaryFile: (goalFile: string) => string;
}

interface GoalDocumentHeading {
  index: number;
  text: string;
}

function goalDocumentHeadings(document: string): GoalDocumentHeading[] {
  const headings: GoalDocumentHeading[] = [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | undefined;
  while (offset < document.length) {
    const nextNewline = document.indexOf('\n', offset);
    const end = nextNewline === -1 ? document.length : nextNewline;
    const line = document.slice(offset, end).replace(/\r$/, '');
    const fenceMatch = /^([ \t]{0,3})(`{3,}|~{3,})/.exec(line);
    const fenceMarker = fenceMatch?.[2];
    if (fence) {
      const closingFence = fenceMarker
        && fenceMarker[0] === fence.marker
        && fenceMarker.length >= fence.length
        && /^[ \t]*$/.test(line.slice(fenceMatch![1].length + fenceMarker.length));
      if (closingFence) fence = undefined;
    } else if (fenceMarker) {
      fence = { marker: fenceMarker[0] as '`' | '~', length: fenceMarker.length };
    } else if (/^##\s+\S/.test(line)) {
      headings.push({ index: offset, text: line });
    }
    offset = nextNewline === -1 ? document.length : nextNewline + 1;
  }
  return headings;
}

function supervisorPlanRevisionSection(document: string): { start: number; end: number } | undefined {
  const headers = goalDocumentHeadings(document);
  const revisions = headers.filter((header) => header.text === SUPERVISOR_PLAN_REVISIONS_HEADER);
  if (revisions.length > 1) throw new Error('goal document has ambiguous supervisor plan revision sections');
  if (revisions.length === 0) return undefined;
  const start = revisions[0]!.index;
  const next = headers.find((header) => header.index > start);
  return { start, end: next?.index ?? document.length };
}

function acceptanceCriteriaSection(document: string): { start: number; end: number } | undefined {
  const headers = goalDocumentHeadings(document);
  const criteria = headers.filter((header) => header.text === '## ACCEPTANCE CRITERIA');
  if (criteria.length !== 1) return undefined;
  const start = criteria[0]!.index + criteria[0]!.text.length + (document.slice(criteria[0]!.index + criteria[0]!.text.length).startsWith('\r\n') ? 2 : 1);
  const next = headers.find((header) => header.index > criteria[0]!.index);
  return { start, end: next?.index ?? document.length };
}

interface AcceptanceCriterionRow {
  line: string;
  start: number;
  end: number;
}

function acceptanceCriterionRows(document: string): AcceptanceCriterionRow[] | undefined {
  const criteria = acceptanceCriteriaSection(document);
  if (!criteria) return undefined;
  const rows: AcceptanceCriterionRow[] = [];
  let offset = criteria.start;
  while (offset < criteria.end) {
    const newline = document.indexOf('\n', offset);
    const end = newline === -1 || newline >= criteria.end ? criteria.end : newline;
    const lineEnd = document[end - 1] === '\r' ? end - 1 : end;
    rows.push({ line: document.slice(offset, lineEnd), start: offset, end: lineEnd });
    offset = newline === -1 || newline >= criteria.end ? criteria.end : newline + 1;
  }
  return rows;
}

function isSupervisorRelaxationCriterionLine(value: string): boolean {
  return /^- \S/.test(value) && !/^##\s+/.test(value);
}

function hasAppliedSupervisorRelaxationAudit(document: string, relaxation: SupervisorPlanRevisionRelaxation): boolean {
  const section = supervisorPlanRevisionSection(document);
  if (!section) return false;
  const lines = document.slice(section.start, section.end).split(/\r?\n/);
  for (let index = 0; index < lines.length - 3; index += 1) {
    if (
      lines[index] === `  - target: ${relaxation.target}`
      && lines[index + 1] === `  - previous: ${relaxation.expected}`
      && lines[index + 2] === `  - replacement: ${relaxation.replacement}`
      // ⛔ 증거는 «applied» 기록뿐이다 — 단독 `already-applied` 는 「적용했다」의 증거가 «아니다».
      //   🔑 그것을 증거로 받으면, 실제 적용 이력 «없이» 선재 replacement 행 하나만으로
      //     다시 `already-applied` 를 내주는 고리가 생긴다(리뷰 must-fix 2026-08-21 round 2).
      && lines[index + 3] === '  - application: applied'
    ) {
      return true;
    }
  }
  return false;
}

function relaxationResult(document: string, record: SupervisorPlanRevisionRecord): SupervisorPlanRevisionResult {
  const relaxation = record.relaxation;
  if (!relaxation) return { status: 'not-requested' };
  if (![relaxation.target, relaxation.expected, relaxation.replacement].every((value) => value.trim() && !/[\r\n]/.test(value) && isSupervisorRelaxationCriterionLine(value))) {
    return { status: 'failed', detail: 'invalid-relaxation-fields' };
  }
  const rows = acceptanceCriterionRows(document);
  if (!rows) return { status: 'failed', detail: 'acceptance-criteria-section-not-found' };
  const expectedRows = rows.filter(({ line }) => line === relaxation.expected);
  const targetRows = rows.filter(({ line }) => line === relaxation.target);
  const replacementRows = rows.filter(({ line }) => line === relaxation.replacement);
  if (expectedRows.length === 0) {
    if (targetRows.length === 0 && replacementRows.length === 1 && hasAppliedSupervisorRelaxationAudit(document, relaxation)) return { status: 'already-applied' };
    if (replacementRows.length > 1 || (targetRows.length > 0 && replacementRows.length > 0)) return { status: 'failed', detail: 'target-does-not-identify-replacement-criterion' };
    return { status: 'failed', detail: 'expected-text-not-found' };
  }
  if (expectedRows.length !== 1) return { status: 'failed', detail: 'expected-text-ambiguous' };
  if (targetRows.length !== 1 || expectedRows[0] !== targetRows[0]) {
    return { status: 'failed', detail: 'target-does-not-identify-expected-criterion' };
  }
  return { status: 'applied' };
}

function replaceAcceptanceCriterion(document: string, relaxation: SupervisorPlanRevisionRelaxation): string {
  const row = acceptanceCriterionRows(document)!.find(({ line }) => line === relaxation.target)!;
  return `${document.slice(0, row.start)}${relaxation.replacement}${document.slice(row.end)}`;
}

/** Append a supervisor-only audit record and, when verified, replace exactly one authored acceptance criterion. */
export function appendSupervisorPlanRevision(
  document: string,
  record: SupervisorPlanRevisionRecord,
): string {
  const reason = record.reason.trim();
  if (!reason || /[\r\n]/.test(reason)) throw new Error('supervisor plan revision reason must be a non-empty single line');
  if (!Number.isInteger(record.round) || record.round < 1) throw new Error('supervisor plan revision round must be a positive integer');
  if (document.trim() === '') throw new Error('goal document is empty');

  const originalHeadings = goalDocumentHeadings(document).filter((heading) => heading.text !== SUPERVISOR_PLAN_REVISIONS_HEADER).map((heading) => heading.text);
  const result = relaxationResult(document, record);
  const revisedDocument = result.status === 'applied'
    ? replaceAcceptanceCriterion(document, record.relaxation!)
    : document;
  const newline = revisedDocument.includes('\r\n') ? '\r\n' : '\n';
  const relaxationAudit = record.relaxation
    ? `  - target: ${record.relaxation.target}${newline}  - previous: ${record.relaxation.expected}${newline}  - replacement: ${record.relaxation.replacement}${newline}  - application: ${result.status}${result.detail ? ` (${result.detail})` : ''}${newline}`
    : '';
  const entry = `- verdict: CONTRACT-CONFLICT${newline}  - round: ${record.round}${newline}  - reason: ${reason}${newline}${relaxationAudit}`;
  const existingSection = supervisorPlanRevisionSection(revisedDocument);
  const updated = existingSection
    ? (() => {
      const section = revisedDocument.slice(existingSection.start, existingSection.end);
      const trailingNewlines = section.match(/(?:\r?\n)*$/)?.[0] ?? '';
      const content = section.slice(0, section.length - trailingNewlines.length);
      return `${revisedDocument.slice(0, existingSection.start)}${content}${newline}${entry}${trailingNewlines.slice(newline.length)}${revisedDocument.slice(existingSection.end)}`;
    })()
    : `${revisedDocument.endsWith(newline) ? revisedDocument : `${revisedDocument}${newline}`}${newline}${SUPERVISOR_PLAN_REVISIONS_HEADER}${newline}${entry}`;
  const updatedHeadings = goalDocumentHeadings(updated).filter((heading) => heading.text !== SUPERVISOR_PLAN_REVISIONS_HEADER).map((heading) => heading.text);
  if (JSON.stringify(updatedHeadings) !== JSON.stringify(originalHeadings)) {
    throw new Error('supervisor plan revision changed authored goal headings');
  }
  if (!updated.includes(`- verdict: CONTRACT-CONFLICT${newline}  - round: ${record.round}${newline}  - reason: ${reason}${newline}`)) {
    throw new Error('supervisor plan revision round-trip verification failed');
  }
  return updated;
}

/** Persist a supervisor verdict and its verified relaxation in one atomic document replacement. */
export function recordSupervisorPlanRevision(
  goalFile: string,
  record: SupervisorPlanRevisionRecord,
  fileSystem: SupervisorPlanRevisionFileSystem = {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, document) => writeFileSync(path, document),
    renameFile: renameSync,
    removeFile: unlinkSync,
    temporaryFile: (path) => `${path}.${randomUUID()}.tmp`,
  },
): SupervisorPlanRevisionResult {
  const document = fileSystem.readFile(goalFile);
  const result = relaxationResult(document, record);
  const updated = appendSupervisorPlanRevision(document, record);
  const temporaryFile = fileSystem.temporaryFile(goalFile);
  try {
    fileSystem.writeFile(temporaryFile, updated);
    fileSystem.renameFile(temporaryFile, goalFile);
  } catch (error) {
    try { fileSystem.removeFile(temporaryFile); } catch { /* Original goal document remains untouched. */ }
    throw error;
  }
  debug.log(GOAL_CLARIFICATION_ESCALATION_CATEGORY, 'supervisor-plan-revision-recorded', {
    goalFile,
    round: record.round,
    reason: record.reason.trim(),
    application: result.status,
    ...(result.detail ? { applicationDetail: result.detail } : {}),
  });
  return result;
}

function writeEscalationObservation(
  event: GoalClarificationObservationEvent,
  data: Record<string, unknown>,
): void {
  debug.log(
    GOAL_CLARIFICATION_ESCALATION_CATEGORY,
    event,
    data,
    event === 'failed' || event === 'timeout' ? { level: 'warn' } : undefined,
  );
}

function failedOutcome(output: string): Extract<GoalClarificationEscalationOutcome, 'failed' | 'timeout'> {
  return /timeout|timed out/i.test(output) ? 'timeout' : 'failed';
}

function isMissingDeliveryResolver(
  dispatched: Pick<AskUserQuestionDispatchResult, 'output' | 'absenceReason'>,
): boolean {
  return dispatched.absenceReason === 'no-capable-peer'
    || dispatched.absenceReason === 'no-delivery-resolver'
    || dispatched.absenceReason === 'no-tui-deps-no-resolver'
    // Compatibility for dispatch implementations that predate absenceReason.
    || /requires a HITL resolver, but none is installed in this surface/i.test(dispatched.output);
}

/** ⭐ 답 하나의 출처를 «더한다». 덮어쓰지 않는 것이 요점이다 — 덮어쓰면 앞 배치가 사라진다.
 *  ⭐ 「표시 없는 답」은 «따로» 센 뒤 집계에서 «한 출처»(legacy=사람 경로)로 더한다 —
 *     레포 안 리졸버는 이제 전부 명시하므로 표시 없음은 legacy/외부다.
 *  ⛔ 그것을 명시값에 «흡수»시키면 안 된다: agent ⊕ 표시없음 을 agent 라 하면
 *     「전부 에이전트가 답했다」는 더 강한 거짓이 된다(무인 리뷰 R6). ⇒ 그 경우는 mixed 다. */
function recordProvenance(
  acc: { explicit: Set<'human' | 'agent'>; unmarkedAnswer: boolean },
  result: { answers: Record<string, unknown>; answeredBy?: 'human' | 'agent' },
): void {
  // ⛔ 답이 «0개»면 아무것도 기록하지 않는다 — 명시값이 있어도 마찬가지다.
  //    「아무 답도 없음 ⇒ none」이 무너지면 이 값으로 아무것도 못 센다(무인 리뷰 R5).
  if (Object.keys(result.answers).length === 0) return;
  if (result.answeredBy !== undefined) { acc.explicit.add(result.answeredBy); return; }
  acc.unmarkedAnswer = true;
}

function terminalFallbackMessage(questions: readonly { header: string; question: string; options: readonly { label: string; description: string }[] }[]): string {
  return [
    '[self-implement] Goal clarification fallback (terminal; non-blocking)',
    'The configured HITL delivery has no resolver in this surface. Continue the unattended run; review these unanswered questions:',
    ...questions.flatMap((question, index) => [
      `${index + 1}. ${question.header}: ${question.question}`,
      `   Options: ${question.options.map((option) => option.label).join(' | ')}`,
    ]),
  ].join('\n');
}

type ClarificationWithQuestionId = { questionId: string };

export interface ClarificationDeliveryId<T extends ClarificationWithQuestionId> {
  clarification: T;
  deliveryId: string;
  clarificationOccurrence: number;
}

/** Assign deterministic AskUserQuestion IDs without changing an already-unique document questionId. */
export function mapClarificationDeliveryIds<T extends ClarificationWithQuestionId>(
  clarifications: readonly T[],
): ClarificationDeliveryId<T>[] {
  const counts = new Map<string, number>();
  for (const clarification of clarifications) {
    counts.set(clarification.questionId, (counts.get(clarification.questionId) ?? 0) + 1);
  }
  const used = new Set(
    clarifications
      .filter((clarification) => counts.get(clarification.questionId) === 1)
      .map((clarification) => clarification.questionId),
  );
  const occurrences = new Map<string, number>();
  return clarifications.map((clarification) => {
    const clarificationOccurrence = occurrences.get(clarification.questionId) ?? 0;
    occurrences.set(clarification.questionId, clarificationOccurrence + 1);
    if (counts.get(clarification.questionId) === 1) {
      return { clarification, deliveryId: clarification.questionId, clarificationOccurrence };
    }
    let deliveryOccurrence = clarificationOccurrence + 1;
    let deliveryId = `${clarification.questionId}__clarification_${deliveryOccurrence}`;
    while (used.has(deliveryId)) {
      deliveryOccurrence += 1;
      deliveryId = `${clarification.questionId}__clarification_${deliveryOccurrence}`;
    }
    used.add(deliveryId);
    return { clarification, deliveryId, clarificationOccurrence };
  });
}

/** Escalate every document-authored unanswered clarification before the implementation child starts. */
export async function escalateGoalDocumentClarifications(
  input: GoalClarificationEscalationInput,
): Promise<GoalClarificationEscalationResult> {
  let delivery: HitlDelivery | undefined = input.delivery;
  let deliverySource: (typeof GOAL_CLARIFICATION_DELIVERY_SOURCES)[number] = input.delivery === undefined
    ? GOAL_CLARIFICATION_DELIVERY_SOURCES[2]
    : GOAL_CLARIFICATION_DELIVERY_SOURCES[1];
  const sessionId = input.dispatchContext?.sessionId;
  if (sessionId !== undefined && input.resolveOriginDelivery !== undefined) {
    try {
      const originDelivery = input.resolveOriginDelivery(sessionId);
      if (originDelivery !== undefined) {
        delivery = originDelivery;
        deliverySource = GOAL_CLARIFICATION_DELIVERY_SOURCES[0];
      }
    } catch {
      // Origin routing is optional; retain the input delivery when resolution fails.
    }
  }
  const dispatchDelivery = delivery ?? 'modal';
  const recordedDelivery = input.resolvedDelivery ?? dispatchDelivery;
  let answersWritten = 0;
  let questionIds: string[] = [];
  const observeEscalation = (event: GoalClarificationObservationEvent, data: Record<string, unknown>): void => {
    writeEscalationObservation(event, { ...data, deliverySource, answersWritten, questionIds });
  };
  let document: string;
  let clarifications: ReturnType<typeof parseGoalDocumentClarifications>;
  let unanswered: ReturnType<typeof parseGoalDocumentClarifications>;
  let deliveryIds: ClarificationDeliveryId<ReturnType<typeof parseGoalDocumentClarifications>[number]>[];
  try {
    document = readFileSync(input.goalFile, 'utf8');
    clarifications = parseGoalDocumentClarifications(document);
    unanswered = clarifications.filter((clarification) => !clarification.answered);
    deliveryIds = mapClarificationDeliveryIds(clarifications);
    questionIds = [...new Set(unanswered.map((clarification) => clarification.questionId))];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { unanswered: 0, escalated: 0, delivery: recordedDelivery, outcome: 'failed' as const, answeredBy: 'none' as const, error: message };
    observeEscalation(result.outcome, { goalFile: input.goalFile, ...result, stage: 'read-or-parse' });
    return result;
  }
  if (unanswered.length === 0) {
    const result = { unanswered: 0, escalated: 0, delivery: recordedDelivery, outcome: 'skipped' as const, answeredBy: 'none' as const };
    observeEscalation(result.outcome, { goalFile: input.goalFile, ...result, reason: 'no-unanswered-clarifications' });
    return result;
  }

  const dispatch = input.dispatch ?? dispatchAskUserQuestion;
  const pendingQuestionPersistence = input.pendingQuestionPersistence ?? {
    create: createPendingQuestion,
    write: writePendingQuestion,
    readAnswer: readPendingQuestionAnswer,
  };
  // An injected persistence owns its read boundary too. Do not let a test or
  // alternate store accidentally consult the process-global file store.
  const readPendingAnswer = pendingQuestionPersistence.readAnswer ?? (() => ({ ok: true as const, answer: null }));
  let escalated = 0;
  let fallbackSurface: GoalClarificationFallbackSurface | undefined;
  // ⛔⭐⭐⭐ 여기서부터의 조기 반환·폴백은 이 «누적값»을 쓴다 — 'none' 을 하드코딩하면
  //  앞 배치가 답했는데 뒤 배치가 취소·실패했을 때 「아무도 안 답했다」는 «거짓»이 된다
  //  (무인 리뷰 R2 must-fix · 실측 형태: 관측이 거짓말한다).
  const seenProvenance = { explicit: new Set<'human' | 'agent'>(), unmarkedAnswer: false };
  const aggregate = (): GoalClarificationAnsweredBy => {
    const { explicit, unmarkedAnswer } = seenProvenance;
    // ⭐ 표시 없는 답도 «한 출처»로 센다 — legacy 경로는 사람이다(레포 안 리졸버는 이제 전부 명시한다).
    //  ⛔ 그것을 「이미 아는 명시값에 흡수」시키면 거짓이 된다: agent ⊕ 표시없음 을 agent 라 하면
    //     「전부 에이전트가 답했다」가 되는데 실제로는 «둘»이 답했다(무인 리뷰 R6).
    const sources = new Set(explicit);
    if (unmarkedAnswer) sources.add('human');
    if (sources.size === 2) return 'mixed';
    if (sources.size === 1) return sources.has('human') ? 'human' : 'agent';
    return 'none';
  };
  const duplicateQuestionIds = new Set(
    clarifications
      .map((clarification) => clarification.questionId)
      .filter((questionId, index, questionIds) => questionIds.indexOf(questionId) !== index),
  );
  const applyDuplicateClarificationReply = (
    updated: string,
    entry: ClarificationDeliveryId<(typeof unanswered)[number]>,
    reply: string,
  ): { document: string; answered: boolean; kind: 'skipped' | 'option' | 'other' } => {
    const { clarification, clarificationOccurrence } = entry;
    const trimmed = reply.trim();
    if (trimmed === '') return { document: updated, answered: false, kind: 'skipped' };
    const optionIndex = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    const answer = optionIndex !== null && optionIndex < clarification.options.length
      ? clarification.options[optionIndex]?.label ?? trimmed
      : trimmed;
    const current = parseGoalDocumentClarifications(updated)
      .filter((candidate) => candidate.questionId === clarification.questionId)[clarificationOccurrence];
    if (current === undefined) return { document: updated, answered: false, kind: 'skipped' };
    const answerLines = answer.split(/\r?\n/);
    const lines = updated.split(/\r?\n/);
    lines.splice(
      current.answerLine,
      1,
      `  - answer: ${answerLines[0]}`,
      ...answerLines.slice(1).map((line) => `    ${line}`),
    );
    return { document: lines.join('\n'), answered: true, kind: optionIndex !== null && optionIndex < clarification.options.length ? 'option' : 'other' };
  };
  const applyBatchAnswers = (
    batch: readonly ClarificationDeliveryId<(typeof unanswered)[number]>[],
    answers: Record<string, unknown>,
    otherText: Record<string, string> | undefined,
  ): number => {
    let updated = document;
    let answersWritten = 0;
    for (const entry of batch) {
      const { clarification, deliveryId, clarificationOccurrence } = entry;
      const answer = answers[deliveryId];
      if (typeof answer !== 'string') continue;
      const freeFormAnswer = otherText?.[deliveryId];
      const reply = clarification.includeOther && typeof freeFormAnswer === 'string' && freeFormAnswer.trim() !== ''
        ? freeFormAnswer
        : answer;
      const applied = duplicateQuestionIds.has(clarification.questionId)
        ? applyDuplicateClarificationReply(updated, { clarification, deliveryId, clarificationOccurrence }, reply)
        : applyClarificationReply(updated, clarification, reply);
      if (applied.kind === 'skipped') continue;
      updated = applied.document;
      answersWritten += 1;
    }
    if (answersWritten > 0) writeFileSync(input.goalFile, updated);
    document = updated;
    return answersWritten;
  };
  const deliveryUnanswered: ClarificationDeliveryId<(typeof unanswered)[number]>[] = [];
  for (const entry of deliveryIds.filter(({ clarification }) => !clarification.answered)) {
    const { clarification, deliveryId } = entry;
    try {
      const stored = readPendingAnswer(`goal-clarification:${input.goalFile}:${deliveryId}`);
      if (!stored.ok || stored.answer === null) {
        deliveryUnanswered.push(entry);
        continue;
      }
      const applied = applyBatchAnswers([entry], stored.answer.result.answers, stored.answer.result.otherText);
      if (applied === 0) {
        deliveryUnanswered.push(entry);
        continue;
      }
      answersWritten += applied;
      recordProvenance(seenProvenance, stored.answer.result);
      observeEscalation('answered-from-store', {
        goalFile: input.goalFile,
        questionId: clarification.questionId,
        applied,
      });
    } catch {
      deliveryUnanswered.push(entry);
    }
  }
  if (deliveryUnanswered.length === 0) {
    const result = { unanswered: 0, escalated: 0, delivery: recordedDelivery, outcome: 'skipped' as const, answeredBy: aggregate() };
    observeEscalation(result.outcome, { goalFile: input.goalFile, ...result, reason: 'answers-from-store' });
    return result;
  }
  const deliveryEntries = deliveryUnanswered;
  for (let start = 0; start < deliveryEntries.length; start += 3) {
    const batch = deliveryEntries.slice(start, start + 3);
    try {
      const dispatched = await dispatch({
        ...(delivery === undefined ? {} : { delivery }),
        questions: batch.map(({ clarification, deliveryId }) => ({
          id: deliveryId,
          header: clarification.header.slice(0, 12),
          question: clarification.question,
          options: clarification.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
          includeOther: clarification.includeOther,
        })),
      }, input.dispatchContext);
      if (dispatched.result === undefined) {
        if (input.fallback && isMissingDeliveryResolver(dispatched)) {
          input.fallback(terminalFallbackMessage(batch.map(({ clarification }) => clarification)));
          let pendingWritten = 0;
          let pendingWriteFailed = 0;
          for (const { clarification, deliveryId } of batch) {
            try {
              const pending = pendingQuestionPersistence.create(
                `goal-clarification:${input.goalFile}:${deliveryId}`,
                {
                  delivery: recordedDelivery === 'file' ? undefined : recordedDelivery,
                  questions: [{
                    id: deliveryId,
                    header: clarification.header.slice(0, 12),
                    question: clarification.question,
                    options: clarification.options,
                    includeOther: clarification.includeOther,
                  }],
                },
                input.dispatchContext?.sessionId,
                {},
                undefined,
                { testOrigin: input.testOrigin },
              );
              pendingQuestionPersistence.write(pending);
              pendingWritten += 1;
            } catch {
              pendingWriteFailed += 1;
            }
          }
          escalated += batch.length;
          fallbackSurface = 'terminal';
          observeEscalation('fallback', {
            goalFile: input.goalFile,
            unanswered: deliveryUnanswered.length,
            escalated,
            delivery: recordedDelivery,
            fallbackSurface,
            pendingWritten,
            pendingWriteFailed,
            // ⭐ 이름을 «다르게» 둔다 — 이건 「그 배치까지의 값」이지 최종값이 아니다.
            //    같은 이름을 쓰면 뒤 배치가 답했을 때 최종과 달라 「모순」으로 읽힌다(무인 리뷰 R4).
            answeredBySoFar: aggregate(),
            batchStart: start,
            reason: 'missing-delivery-resolver',
          });
          continue;
        }
        const outcome = failedOutcome(dispatched.output);
        const result = { unanswered: deliveryUnanswered.length, escalated, delivery: recordedDelivery, outcome, answeredBy: aggregate(), error: dispatched.output.slice(0, 500) };
        observeEscalation(outcome, { goalFile: input.goalFile, ...result, batchStart: start });
        return result;
      }
      escalated += batch.length;
      answersWritten += applyBatchAnswers(batch, dispatched.result.answers, dispatched.result.otherText);
      if (dispatched.result.cancelled === true) {
        // ⛔ 취소여도 «부분 답변»이 있을 수 있다(일부 문항만 답하고 닫은 경우).
        //    그때 answeredBy 를 갱신 «전»에 반환하면 실제 사람 응답이 none 으로 기록된다(R3).
        recordProvenance(seenProvenance, dispatched.result);
        const result = { unanswered: deliveryUnanswered.length, escalated, delivery: recordedDelivery, outcome: 'no-response' as const, answeredBy: aggregate() };
        observeEscalation(result.outcome, { goalFile: input.goalFile, ...result, batchStart: start });
        return result;
      }
      // ⭐ 집계는 «집합»이다 — 덮어쓰지 않으므로 앞 배치가 사라지지 않는다(mixed 참조).
      recordProvenance(seenProvenance, dispatched.result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = { unanswered: deliveryUnanswered.length, escalated, delivery: recordedDelivery, outcome: 'failed' as const, answeredBy: aggregate(), error: message };
      observeEscalation(result.outcome, { goalFile: input.goalFile, ...result, stage: 'dispatch', batchStart: start });
      return result;
    }
  }
  const result = fallbackSurface
    ? { unanswered: deliveryUnanswered.length, escalated, delivery: recordedDelivery, outcome: 'fallback' as const, answeredBy: aggregate(), fallbackSurface }
    : { unanswered: deliveryUnanswered.length, escalated, delivery: recordedDelivery, outcome: 'delivered' as const, answeredBy: aggregate() };
  observeEscalation(result.outcome, { goalFile: input.goalFile, ...result });
  return result;
}
