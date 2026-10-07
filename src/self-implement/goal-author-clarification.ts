import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { tierModel } from '../llm/model-defaults.js';
import { debug } from '../debug/log.js';
import type { LLMUsage } from '../prompt-cache/types.js';

function observeGoalAuthor(
  category: 'goal-author' | 'goal-author.clarify',
  event: string,
  data: unknown,
): void {
  debug.log(category, event, data);
  debug.log(category === 'goal-author' ? 'harness.author' : 'harness.author.clarify', event, data);
}
import type { IntakeClarification } from '../autopilot/mission-intake-clarify.js';

const CLARIFICATION_PREFIX = '- Clarification: ';
const PARENT_PREFIX = '- Parent: ';

export interface GoalAuthorParent {
  goalFile: string;
  questionId: string;
}

/** Serialize the goal and unresolved-question origin as one Markdown-safe line. */
export function serializeGoalAuthorParent(parent: GoalAuthorParent): string {
  return `${PARENT_PREFIX}${JSON.stringify(parent)}`;
}

/** Parse one authored-goal parent origin, returning null when no valid parent line exists. */
export function parseGoalAuthorParent(document: string): GoalAuthorParent | null {
  const matches = document.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(PARENT_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(PARENT_PREFIX.length)) as Partial<GoalAuthorParent>;
      return typeof value.goalFile === 'string' && value.goalFile.length > 0
        && typeof value.questionId === 'string' && value.questionId.length > 0
        ? [{ goalFile: value.goalFile, questionId: value.questionId }]
        : [];
    } catch {
      return [];
    }
  });
  return matches.length === 1 ? matches[0] : null;
}

export type GoalAuthorClarificationAnswerSource = 'injected' | 'recommended' | 'self-authored' | 'default';

export interface GoalAuthorClarificationProvenance {
  source: GoalAuthorClarificationAnswerSource;
  evidence?: string[];
}

export interface GoalAuthorClarificationResponse {
  questionId: string;
  answer: string | null;
  acceptedFormats: string[];
  status: 'ANSWERED' | `DEFERRED-UNTIL: ${string}`;
  provenance?: GoalAuthorClarificationProvenance;
}

export interface SerializedGoalAuthorClarification {
  clarification: IntakeClarification;
  response: GoalAuthorClarificationResponse;
}

export interface GoalAuthorSelfResolutionContext {
  questionId: string;
  question: string;
  kind: Exclude<IntakeClarification['kind'], 'safety'>;
  options: readonly string[];
  /** Read-verified repository grounding or bounded follow-up search evidence available to the author. */
  evidence: readonly string[];
  /**
   * The request being authored. 🩸 2026-09-24 (🅞 관측 · 무인 4판 전부 `implementation_target` DEFERRED ·
   * `self-resolve-unanswered reason=declined evidenceCount=20`): 답변기가 증거만 받고 «요청»을 못 봐서
   * 「이 요청이 어느 파일에 속하나」를 원리상 판단할 수 없었다.
   */
  ask?: string;
}

export type GoalAuthorSelfResolution =
  | { answer: string; evidence: readonly string[]; declined?: undefined }
  | { answer?: undefined; evidence?: undefined; declined?: boolean };

export interface GoalAuthorClarificationResolutionDeps {
  /** Elanousic authoring seam; it must return no answer when the available evidence is insufficient. */
  selfResolve?: (context: GoalAuthorSelfResolutionContext) => Promise<GoalAuthorSelfResolution>;
  /** Bounded repository grounding forwarded to the self-resolver, never delegated to a child agent. */
  evidence?: readonly string[];
  /** The request being authored, forwarded so the self-resolver can relate evidence to it. */
  ask?: string;
  /** Whether this authoring run explicitly selected self-resolution. */
  selfResolutionSelected?: boolean;
}

export interface GoalAuthorSelfResolveDeps {
  stream?: (prompt: string, signal: AbortSignal, onUsage: (usage: LLMUsage) => void) => Promise<string>;
  timeoutMs?: number;
}

/**
 * ⛔⭐ 대표 2026-08-22 지시로 30초 → ***10분***.
 *
 * 종전 30초는 「모델이 답을 못 낸 것」과 「시간이 모자란 것」을 갈랐어야 했는데,
 * ***그 둘이 같은 `catch` 로 접혀 있어 어느 쪽인지 볼 수 없었다***(같은 날 `self-resolve-timeout` 신설로 갈림).
 * ⇒ 이제 갈리므로 상한을 늘려도 «늘어서 나아졌는지»를 잴 수 있다 —
 *   `elanous logs --category goal-author --event self-resolve-timeout` 의 수가 그 자다.
 * ⚠️ 대가: 자동 해소가 막히면 저작이 최대 10분 늦어진다. 그 비용이 「미결로 런이 죽는 것」보다 싸다는 판단.
 */
const DEFAULT_SELF_RESOLUTION_TIMEOUT_MS = 600_000;

function selfResolutionTimeoutMs(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : DEFAULT_SELF_RESOLUTION_TIMEOUT_MS;
}

/** 요청 원문 상한 — 증거(최대 수십 줄)보다 커서 프롬프트를 지배하지 않게. */
const SELF_RESOLUTION_ASK_LIMIT = 4_000;

function truncateAsk(ask: string): string {
  return ask.length <= SELF_RESOLUTION_ASK_LIMIT ? ask : `${ask.slice(0, SELF_RESOLUTION_ASK_LIMIT)}\n…(truncated ${ask.length - SELF_RESOLUTION_ASK_LIMIT} chars)`;
}

function selfResolutionPrompt(context: GoalAuthorSelfResolutionContext): string {
  return [
    'Answer this goal-author clarification using only the supplied repository evidence.',
    'Do not delegate to an implementation agent. If the evidence cannot justify one single-line answer, return {"answer":null}.',
    'Return JSON only: {"answer":"..."} or {"answer":null}.',
    ...(context.ask?.trim() ? [`Request being authored:\n${truncateAsk(context.ask.trim())}`] : []),
    `Question: ${context.question}`,
    `Options: ${context.options.join(' | ') || '(free input)'}`,
    `Evidence:\n${context.evidence.map((item) => `- ${item}`).join('\n') || '(none)'}`,
  ].join('\n');
}

const SELF_RESOLUTION_TIMEOUT_MESSAGE = 'self-resolution timeout';

function isSelfResolutionTimeout(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const isTimeoutReason = (value: unknown): boolean =>
    value instanceof Error && value.message === SELF_RESOLUTION_TIMEOUT_MESSAGE;
  return isTimeoutReason(signal.reason) || isTimeoutReason(error);
}

function safeTokens(value: number | undefined): number {
  return Number.isFinite(value) && value! >= 0 ? value! : 0;
}

function deriveUsage(usages: readonly LLMUsage[]): { contextTokens: number; totalTokens: number } | 'unmeasured' {
  if (usages.length === 0 || usages.some((usage) => usage.provider === undefined)) return 'unmeasured';
  return usages.reduce((total, usage) => {
    const contextTokens = usage.provider === 'anthropic'
      ? safeTokens(usage.inputTokens)
        + safeTokens(usage.cacheReadInputTokens)
        + safeTokens(usage.cacheCreationInputTokens)
      : safeTokens(usage.inputTokens);
    const outputTokens = safeTokens(usage.outputTokens);
    return {
      contextTokens: total.contextTokens + contextTokens,
      totalTokens: total.totalTokens + contextTokens + outputTokens,
    };
  }, { contextTokens: 0, totalTokens: 0 });
}

function observeSelfResolve(
  result: string,
  context: GoalAuthorSelfResolutionContext,
  startedAt: number,
  extra?: {
    answerLength?: number;
    usage?: ReturnType<typeof deriveUsage>;
    reason?: 'declined' | 'shape-mismatch';
    evidenceCount?: number;
  },
): void {
  observeGoalAuthor('goal-author', result, {
    questionId: context.questionId,
    elapsedMs: Date.now() - startedAt,
    ...(extra?.answerLength !== undefined ? { answerLength: extra.answerLength } : {}),
    ...(extra?.usage === 'unmeasured' ? { usage: 'unmeasured' } : extra?.usage ? extra.usage : {}),
    ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra?.evidenceCount !== undefined ? { evidenceCount: extra.evidenceCount } : {}),
  });
}

export async function defaultGoalAuthorSelfResolve(
  context: GoalAuthorSelfResolutionContext,
  deps: GoalAuthorSelfResolveDeps = {},
): Promise<GoalAuthorSelfResolution> {
  const startedAt = Date.now();
  const usages: LLMUsage[] = [];
  if (context.evidence.length === 0) {
    observeSelfResolve('self-resolve-no-evidence', context, startedAt, { usage: deriveUsage(usages) });
    return context.questionId === 'preservation_contract' ? { declined: true } : {};
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(SELF_RESOLUTION_TIMEOUT_MESSAGE)),
    selfResolutionTimeoutMs(deps.timeoutMs),
  );
  const prompt = selfResolutionPrompt(context);
  const onUsage = (usage: LLMUsage) => { usages.push(usage); };
  try {
    const result = await (deps.stream ?? (async (input, signal, reportUsage) => {
      const { streamLLM } = await import('../llm.js');
      return streamLLM([{ role: 'user', content: input }], () => {}, {
        model: process.env.ELANOUS_GOAL_AUTHOR_MODEL || tierModel('better'),
        reasoningEffort: 'high',
        signal,
        onUsage: reportUsage,
      });
    }))(prompt, controller.signal, onUsage);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      observeSelfResolve('self-resolve-parse-failed', context, startedAt, { usage: deriveUsage(usages) });
      return {};
    }
    const answer = parsed !== null && typeof parsed === 'object'
      ? (parsed as { answer?: unknown }).answer
      : undefined;
    if (typeof answer === 'string') {
      observeSelfResolve('self-resolve-answered', context, startedAt, {
        answerLength: answer.length,
        usage: deriveUsage(usages),
      });
      return { answer, evidence: context.evidence };
    }
    observeSelfResolve('self-resolve-unanswered', context, startedAt, {
      reason: answer === null ? 'declined' : 'shape-mismatch',
      evidenceCount: context.evidence.length,
      usage: deriveUsage(usages),
    });
    return answer === null && context.questionId === 'preservation_contract' ? { declined: true } : {};
  } catch (error) {
    observeSelfResolve(
      isSelfResolutionTimeout(error, controller.signal) ? 'self-resolve-timeout' : 'self-resolve-error',
      context,
      startedAt,
      { usage: deriveUsage(usages) },
    );
    return {};
  } finally {
    clearTimeout(timeout);
  }
}


function deferredResponse(clarification: IntakeClarification): GoalAuthorClarificationResponse {
  return {
    questionId: clarification.questionId,
    answer: null,
    acceptedFormats: clarification.options.map((option) => option.label),
    status: `${DEFERRED_ANSWER}${clarification.question}`,
  };
}

function responseFor(clarification: IntakeClarification, observe = false, selfResolutionSelected = false): GoalAuthorClarificationResponse {
  const injectedAnswer = clarification.answer !== undefined && clarification.answer.length > 0
    ? clarification.answer
    : undefined;
  if (injectedAnswer !== undefined) {
    return { ...deferredResponse(clarification), answer: injectedAnswer, status: 'ANSWERED', provenance: { source: 'injected' } };
  }
  if (clarification.kind === 'safety') return deferredResponse(clarification);

  const recommended = clarification.options.filter((option) => option.recommended);
  if (recommended.length !== 1) return deferredResponse(clarification);
  const automaticAnswer = recommended[0].label;
  if (observe) {
    observeGoalAuthor('goal-author.clarify', 'auto-answered', {
      questionId: clarification.questionId,
      kind: clarification.kind,
      label: automaticAnswer,
      selfResolutionSelected,
    });
  }
  return {
    ...deferredResponse(clarification),
    answer: automaticAnswer,
    status: 'ANSWERED',
    provenance: { source: 'recommended' },
  };
}

/** Resolve an eligible clarification with the author itself, preserving human and safety precedence. */
export async function resolveGoalAuthorClarification(
  clarification: IntakeClarification,
  deps: GoalAuthorClarificationResolutionDeps = {},
): Promise<GoalAuthorClarificationResponse> {
  const selfResolutionSelected = deps.selfResolutionSelected ?? Boolean(deps.selfResolve);
  const deterministic = responseFor(clarification, false, selfResolutionSelected);
  if (deterministic.answer !== null) {
    observeGoalAuthor('goal-author.clarify', deterministic.provenance?.source === 'injected' ? 'answer-injected' : 'auto-answered', {
      questionId: clarification.questionId,
      kind: clarification.kind,
      answer: deterministic.answer,
      selfResolutionSelected,
    });
    return deterministic;
  }
  if (clarification.kind === 'safety') {
    observeGoalAuthor('goal-author.clarify', 'unresolved', {
      questionId: clarification.questionId,
      kind: clarification.kind,
      selfResolutionSelected,
    });
    return deterministic;
  }
  if (!deps.selfResolve) {
    observeGoalAuthor('goal-author.clarify', 'unresolved', {
      questionId: clarification.questionId,
      kind: clarification.kind,
      selfResolutionSelected,
    });
    return deterministic;
  }
  try {
    const resolution = await deps.selfResolve({
      questionId: clarification.questionId,
      question: clarification.question,
      kind: clarification.kind,
      options: clarification.options.map((option) => option.label),
      evidence: deps.evidence ?? [],
      ...(deps.ask !== undefined ? { ask: deps.ask } : {}),
    });
    const answer = resolution.answer?.trim();
    const evidence = [...new Set((resolution.evidence ?? []).filter((item) => item.trim().length > 0))];
    if (!answer || /[\r\n]/.test(answer) || evidence.length === 0) {
      return deterministic;
    }
    const response: GoalAuthorClarificationResponse = {
      ...deferredResponse(clarification),
      answer,
      status: 'ANSWERED',
      provenance: { source: 'self-authored', evidence },
    };
    observeGoalAuthor('goal-author.clarify', 'self-answered', {
      questionId: clarification.questionId,
      kind: clarification.kind,
      answer,
      evidence,
      selfResolutionSelected: deps.selfResolutionSelected ?? Boolean(deps.selfResolve),
    });
    return response;
  } catch (error) {
    observeGoalAuthor('goal-author.clarify', 'self-answer-deferred', {
      questionId: clarification.questionId,
      kind: clarification.kind,
      reason: error instanceof Error ? error.message : String(error),
      selfResolutionSelected: deps.selfResolutionSelected ?? Boolean(deps.selfResolve),
    });
    return deterministic;
  }
}

/** Serialize one intake clarification and its deterministic response slot as a single Markdown-safe line. */
export function serializeGoalAuthorClarification(clarification: IntakeClarification): string {
  return `${CLARIFICATION_PREFIX}${JSON.stringify({
    clarification,
    response: responseFor(clarification, true),
  } satisfies SerializedGoalAuthorClarification)}`;
}

/** Serialize one intake clarification after the author has attempted its bounded self-resolution. */
export async function serializeResolvedGoalAuthorClarification(
  clarification: IntakeClarification,
  deps: GoalAuthorClarificationResolutionDeps = {},
): Promise<string> {
  return `${CLARIFICATION_PREFIX}${JSON.stringify({
    clarification,
    response: await resolveGoalAuthorClarification(clarification, deps),
  } satisfies SerializedGoalAuthorClarification)}`;
}

function isIntakeClarification(value: unknown): value is IntakeClarification {
  if (!value || typeof value !== 'object') return false;
  const clarification = value as Partial<IntakeClarification>;
  return typeof clarification.questionId === 'string'
    && (clarification.kind === 'scope' || clarification.kind === 'arc'
      || clarification.kind === 'term' || clarification.kind === 'safety')
    && typeof clarification.header === 'string'
    && typeof clarification.question === 'string'
    && Array.isArray(clarification.options)
    && clarification.options.every((option) => option && typeof option.label === 'string')
    && (clarification.answer === undefined || typeof clarification.answer === 'string')
    && typeof clarification.blocking === 'boolean';
}

function parseRecord(raw: string): SerializedGoalAuthorClarification | null {
  try {
    const value = JSON.parse(raw) as {
      clarification?: unknown;
      response?: Partial<GoalAuthorClarificationResponse>;
    };
    if (!isIntakeClarification(value.clarification) || !value.response) return null;
    const expected = responseFor(value.clarification);
    const provenance = value.response.provenance;
    const isSelfAuthored = expected.answer === null
      && value.clarification.kind !== 'safety'
      && provenance?.source === 'self-authored'
      && typeof value.response.answer === 'string'
      && value.response.answer.length > 0
      && !/[\r\n]/.test(value.response.answer)
      && Array.isArray(provenance.evidence)
      && provenance.evidence.length > 0
      && provenance.evidence.every((item) => typeof item === 'string' && item.length > 0);
    const response = isSelfAuthored
      ? {
        ...deferredResponse(value.clarification),
        answer: value.response.answer!,
        status: 'ANSWERED' as const,
        provenance: { source: 'self-authored' as const, evidence: provenance.evidence },
      }
      : expected;
    const responseProvenance = response.provenance;
    const serializedProvenance = value.response.provenance;
    const expectedProvenanceKeys = responseProvenance === undefined
      ? []
      : responseProvenance.evidence === undefined ? ['source'] : ['evidence', 'source'];
    const serializedProvenanceKeys = serializedProvenance === undefined
      ? []
      : Object.keys(serializedProvenance).sort();
    const provenanceMatches = (serializedProvenance === undefined) === (responseProvenance === undefined)
      && serializedProvenanceKeys.length === expectedProvenanceKeys.length
      && serializedProvenanceKeys.every((key, index) => key === expectedProvenanceKeys[index])
      && serializedProvenance?.source === responseProvenance?.source
      && (responseProvenance?.evidence === undefined
        ? serializedProvenance?.evidence === undefined
        : Array.isArray(serializedProvenance?.evidence)
          && serializedProvenance.evidence.length === responseProvenance.evidence.length
          && serializedProvenance.evidence.every((item, index) => item === responseProvenance.evidence?.[index]));
    if (value.response.questionId !== response.questionId
      || value.response.answer !== response.answer
      || value.response.status !== response.status
      || !Array.isArray(value.response.acceptedFormats)
      || value.response.acceptedFormats.length !== response.acceptedFormats.length
      || value.response.acceptedFormats.some((format, index) => format !== response.acceptedFormats[index])
      || !provenanceMatches) {
      return null;
    }
    return { clarification: value.clarification, response };
  } catch {
    return null;
  }
}

/** Parse every structured clarification line from an authored goal document. */
export function parseGoalAuthorClarifications(document: string): SerializedGoalAuthorClarification[] {
  return document.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(CLARIFICATION_PREFIX)) return [];
    const parsed = parseRecord(line.slice(CLARIFICATION_PREFIX.length));
    return parsed ? [parsed] : [];
  });
}

export interface GoalDocumentClarification {
  questionId: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  includeOther: boolean;
  answer: string;
  answered: boolean;
  answerLine: number;
  provenanceSource?: GoalAuthorClarificationAnswerSource;
  provenanceLines?: number[];
}

interface GoalAuthorClarificationSeed {
  ask: string;
  parent: GoalAuthorParent;
}

const PRESERVATION_DEFAULT = '대상 경로의 기존 공개 동작(내보내는 함수 시그니처 · CLI 인자·출력·종료 코드)은 그대로 유지한다 · 바뀌는 것은 골이 명시한 동작뿐';

function preservationDefault(ask: string): { answer: string; exportCount: number } {
  const request = /Original ask \(verbatim, unmodified\):\s*```\r?\n([\s\S]*?)\r?\n```/.exec(ask)?.[1] ?? ask;
  // Every `대상 경로:` line counts, plain or as a Markdown list item; backticks around a path are cosmetic.
  const paths = [...new Set(request.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?대상 경로:\s*(.*)$/.exec(line);
    return match ? match[1].split(/\s*[,·]\s*/).map((path) => path.trim().replace(/^`|`$/g, '')) : [];
  }))];
  const exports: string[] = [];
  for (const path of paths) {
    if (!/^[\w./-]+\.[cm]?[jt]sx?$/.test(path) || path.startsWith('/') || path.split('/').includes('..')) continue;
    const absolute = resolve(process.cwd(), path);
    try {
      const actual = realpathSync(absolute);
      const withinRepo = relative(realpathSync(process.cwd()), actual);
      if (withinRepo === '..' || withinRepo.startsWith('../') || isAbsolute(withinRepo)) continue;
      const source = ts.createSourceFile(path, readFileSync(actual, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) exports.push(`${path}: ${element.name.text}`);
          } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
            exports.push(`${path}: ${statement.exportClause.name.text}`);
          } else if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            // Names re-exported by `export *` are not resolved here; record the re-export itself so the preserved surface is explicit.
            exports.push(`${path}: * from ${statement.moduleSpecifier.text}`);
          }
        } else if (ts.isExportAssignment(statement)) {
          exports.push(`${path}: ${statement.isExportEquals ? 'export =' : 'default'}`);
        } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          if (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
            exports.push(`${path}: default`);
          } else if (ts.isVariableStatement(statement)) {
            const bindingNames = (name: ts.BindingName): string[] => ts.isIdentifier(name)
              ? [name.text]
              : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
            for (const declaration of statement.declarationList.declarations) {
              for (const exported of bindingNames(declaration.name)) exports.push(`${path}: ${exported}`);
            }
          } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
            exports.push(`${path}: ${(statement.name as ts.Identifier).text}`);
          }
        }
      }
    } catch { /* An unavailable target cannot supply verified export names. */ }
  }
  const names = [...new Set(exports)];
  return { answer: names.length ? `${PRESERVATION_DEFAULT} · export 이름: ${names.join(', ')}` : PRESERVATION_DEFAULT, exportCount: names.length };
}

const DEFERRED_ANSWER = 'DEFERRED-UNTIL: ';
const DEFERRED_ANSWER_PREFIX = 'DEFERRED-UNTIL';

function isDeferredGoalDocumentAnswer(answer: string): boolean {
  return answer.startsWith(DEFERRED_ANSWER_PREFIX);
}

/** Parse the multiline clarification blocks emitted by the authored-goal document writer. */
export function parseGoalDocumentClarifications(document: string): GoalDocumentClarification[] {
  const lines = document.split(/\r?\n/);
  const clarifications: GoalDocumentClarification[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start] !== '- Clarification:') continue;
    const fields = new Map<string, string>();
    const options: Array<{ label: string; description: string }> = [];
    let answerLine = -1;
    const provenanceLines: number[] = [];
    let readingOptions = false;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '') break;
      const field = /^  - (id|header|question|answer): (.*)$/.exec(line);
      if (field) {
        fields.set(field[1], field[2]);
        if (field[1] === 'answer') answerLine = index;
        readingOptions = false;
        continue;
      }
      if (line === '  - options:') {
        readingOptions = true;
        continue;
      }
      const option = readingOptions ? /^    - label: (.*)$/.exec(line) : null;
      if (option && lines[index + 1]?.startsWith('      description: ')) {
        options.push({ label: option[1], description: lines[index + 1].slice('      description: '.length) });
        index += 1;
        continue;
      }
      const includeOther = /^  - includeOther: (true|false)$/.exec(line);
      if (includeOther) {
        fields.set('includeOther', includeOther[1]);
        readingOptions = false;
        continue;
      }
      const provenanceSource = /^  - provenance\.source: (injected|recommended|self-authored|default)$/.exec(line);
      if (provenanceSource) {
        fields.set('provenanceSource', provenanceSource[1]);
        provenanceLines.push(index);
        readingOptions = false;
        continue;
      }
      if (/^  - evidence: /.test(line)) {
        provenanceLines.push(index);
        readingOptions = false;
        continue;
      }
      break;
    }
    const questionId = fields.get('id');
    const header = fields.get('header');
    const question = fields.get('question');
    const answer = fields.get('answer');
    if (!questionId || !header || question === undefined || answer === undefined || answerLine < 0) continue;
    clarifications.push({
      questionId,
      header,
      question,
      options,
      includeOther: fields.get('includeOther') === 'true',
      answer,
      answered: !isDeferredGoalDocumentAnswer(answer),
      answerLine,
      provenanceSource: fields.get('provenanceSource') as GoalAuthorClarificationAnswerSource | undefined,
      provenanceLines,
    });
  }
  return clarifications;
}

function findGoalDocumentClarification(document: string, questionId: string): GoalDocumentClarification {
  const matches = parseGoalDocumentClarifications(document).filter((entry) => entry.questionId === questionId);
  if (matches.length === 0) throw new Error(`goal clarification not found: ${questionId}`);
  if (matches.length > 1) throw new Error(`goal clarification is ambiguous: ${questionId}`);
  return matches[0];
}

function findHumanOverridableGoalDocumentClarification(document: string, questionId: string): GoalDocumentClarification {
  const clarification = findGoalDocumentClarification(document, questionId);
  if (!clarification.answered || clarification.provenanceSource === 'self-authored') return clarification;
  throw new Error(`goal clarification already answered: ${questionId}`);
}

function findUnansweredGoalDocumentClarification(document: string, questionId: string): GoalDocumentClarification {
  const clarification = findGoalDocumentClarification(document, questionId);
  if (clarification.answered) throw new Error(`goal clarification already answered: ${questionId}`);
  return clarification;
}

function clarificationSeed(clarification: GoalDocumentClarification, goalFile: string): GoalAuthorClarificationSeed {
  return {
    ask: clarification.question,
    parent: { goalFile, questionId: clarification.questionId },
  };
}

/** Resolve one pending document clarification into the ask and parent provenance for child-goal authoring. */
export function seedGoalAuthorFromClarification(document: string, goalFile: string, questionId: string): GoalAuthorClarificationSeed {
  return clarificationSeed(findUnansweredGoalDocumentClarification(document, questionId), goalFile);
}

/** Resolve one answered document clarification into the ask and parent provenance for reauthoring. */
export function seedGoalAuthorFromAnsweredClarification(document: string, goalFile: string, questionId: string): GoalAuthorClarificationSeed {
  const clarification = findGoalDocumentClarification(document, questionId);
  if (!clarification.answered) throw new Error(`goal clarification not answered: ${questionId}`);
  return clarificationSeed(clarification, goalFile);
}

function updateWhatToBuildRenderAnswers(lines: string[], questionId: string, answer: string): void {
  const unansweredRenderAnswer = `Answer: UNANSWERED — ${questionId}`;
  let inWhatToBuild = false;
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^## /.test(line)) inWhatToBuild = line === '## WHAT TO BUILD';
    if (!inWhatToBuild) continue;
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || line !== unansweredRenderAnswer) continue;
    const questionStatus = /^Question: ([A-Z-]+) — /.exec(lines[index - 1] ?? '')?.[1];
    if (!questionStatus) continue;
    lines[index] = `Answer: ${questionStatus} — ${answer}`;
  }
}

function hasWhatToBuildUnansweredRenderAnswer(lines: readonly string[], questionId: string): boolean {
  const unansweredRenderAnswer = `Answer: UNANSWERED — ${questionId}`;
  let inWhatToBuild = false;
  let inCodeFence = false;

  return lines.some((line, index) => {
    if (/^## /.test(line)) inWhatToBuild = line === '## WHAT TO BUILD';
    if (!inWhatToBuild) return false;
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      return false;
    }
    return !inCodeFence
      && line === unansweredRenderAnswer
      && /^Question: [A-Z-]+ — /.test(lines[index - 1] ?? '');
  });
}

/** Replace exactly one unanswered clarification answer while preserving every other document line. */
export function injectGoalDocumentClarificationAnswer(document: string, questionId: string, answer: string): string {
  if (!answer || /[\r\n]/.test(answer)) throw new Error('clarification answer must be a non-empty single line');
  if (isDeferredGoalDocumentAnswer(answer)) throw new Error(`clarification answer must not use reserved unresolved status: ${DEFERRED_ANSWER.trim()}`);
  const clarification = findHumanOverridableGoalDocumentClarification(document, questionId);
  const newline = document.includes('\r\n') ? '\r\n' : '\n';
  const lines = document.split(/\r?\n/);
  const provenanceLines = clarification.provenanceLines ?? [];
  for (const line of [...provenanceLines].sort((left, right) => right - left)) lines.splice(line, 1);
  const removedBeforeAnswer = provenanceLines.filter((line) => line < clarification.answerLine).length;
  const answerLine = clarification.answerLine - removedBeforeAnswer;
  lines[answerLine] = `  - answer: ${answer}`;
  lines.splice(answerLine + 1, 0, '  - provenance.source: injected');
  updateWhatToBuildRenderAnswers(lines, questionId, answer);
  const updated = lines.join(newline);
  const roundTripMatches = parseGoalDocumentClarifications(updated).filter((entry) => entry.questionId === questionId);
  if (roundTripMatches.length !== 1 || !roundTripMatches[0].answered || roundTripMatches[0].answer !== answer) {
    throw new Error(`goal clarification answer round-trip verification failed: ${questionId}`);
  }
  if (hasWhatToBuildUnansweredRenderAnswer(updated.split(/\r?\n/), questionId)) {
    throw new Error(`goal clarification render-surface verification failed: ${questionId}`);
  }
  observeGoalAuthor('goal-author.clarify', 'answer-injected', {
    questionId,
    source: 'cli',
    selfResolutionSelected: false,
  });
  return updated;
}

/** Select an offered option by zero-based index and inject its label as the answer. */
export function injectGoalDocumentClarificationOption(document: string, questionId: string, optionIndex: string): string {
  if (!/^\d+$/.test(optionIndex)) throw new Error(`goal clarification option index must be a non-negative integer: ${optionIndex}`);
  const clarification = findHumanOverridableGoalDocumentClarification(document, questionId);
  const option = clarification.options[Number(optionIndex)];
  if (!option) throw new Error(`goal clarification option index out of range: ${optionIndex}`);
  return injectGoalDocumentClarificationAnswer(document, questionId, option.label);
}

/** Inject a free-form answer only when the clarification explicitly allows it. */
export function injectGoalDocumentClarificationOtherAnswer(document: string, questionId: string, answer: string): string {
  const clarification = findHumanOverridableGoalDocumentClarification(document, questionId);
  if (!clarification.includeOther) throw new Error(`goal clarification does not allow a free-form answer: ${questionId}`);
  return injectGoalDocumentClarificationAnswer(document, questionId, answer);
}

/** ⛔⭐⭐⭐ 되묻기 «수신» 판정 — 대표 2026-08-11: *"시드가 부실하면 보강을 피드백으로 받아야 하지 않나"*.
 *
 *  🔎 그때까지의 실물: 저작기는 «묻는데» 답을 받을 창구가 없어
 *    `The configured HITL delivery has no resolver in this surface` 로 끝나고
 *    골에 `answer: DEFERRED-UNTIL: …` 이 박힌 채 그대로 발사됐다.
 *  ⛔ 그래서 「미답 유무가 착지율을 안 가른다(82% vs 85%)」는 그날 측정도 ***「묻는 게 값이 없다」가 아니라
 *    「답이 한 번도 안 들어가서 효과를 못 쟀다」***일 수 있다 — 두 무리 다 «답이 없는» 무리였다.
 *  ⛔ 무인 계약은 유지한다 — 대화형이 아니면 종전대로 지나가되 «그 사실을 값으로» 낸다.
 */
export type GoalClarificationSelfAnswerPath = 'say-first' | 'ask' | 'rework';
export type GoalClarificationSelfResolver = NonNullable<GoalAuthorClarificationResolutionDeps['selfResolve']>;

/** Attempt only unanswered document questions; retain every unanswered line if evidence is insufficient. */
export async function selfAnswerGoalDocumentClarifications(
  document: string,
  options: {
    path: GoalClarificationSelfAnswerPath;
    ask?: string;
    evidence?: readonly string[];
    resolver?: GoalClarificationSelfResolver;
    runId?: string;
  },
): Promise<{ document: string; asked: number; answered: number; unanswered: number; newlyAnswered: number }> {
  const clarifications = parseGoalDocumentClarifications(document);
  const pending = clarifications.filter((item) => !item.answered);
  // The first say pass may already have self-answered some questions while authoring: count those,
  // never re-ask them, and still attempt every question that is left unanswered.
  const alreadySelfAnswered = options.path === 'say-first'
    ? clarifications.filter((item) => item.answered && (item.provenanceSource === 'self-authored' || item.provenanceSource === 'default')).length
    : 0;
  let updated = document;
  let answered = 0;
  const evidence = options.evidence ?? document.split(/\r?\n/)
    .filter((line) => /^(?:\s*- (?:\[code:|\[document:|TRACED PATHS|evidence:|Evidence:)|\s*-?\s*`?(?:src|test|scripts)\/[^\s`]+:\d+)/i.test(line))
    .slice(0, 40);
  for (const item of pending) {
    if (parseGoalDocumentClarifications(updated).filter((entry) => entry.questionId === item.questionId).length !== 1) continue;
    let response: Awaited<ReturnType<typeof resolveGoalAuthorClarification>>;
    let declined = false;
    try { response = await resolveGoalAuthorClarification({
      questionId: item.questionId,
      kind: 'scope',
      header: item.header,
      question: item.question,
      options: item.options.map((option) => ({ label: option.label, description: option.description })),
      blocking: false,
    }, {
      selfResolve: async (context) => {
        const resolution = await (options.resolver ?? defaultGoalAuthorSelfResolve)(context);
        declined = resolution.declined === true;
        return resolution;
      },
      evidence,
      ask: options.ask,
      selfResolutionSelected: true,
    }); } catch {
      // A resolver failure leaves this question unanswered; the remaining questions are still attempted.
      continue;
    }
    let defaultExportCount: number | undefined;
    if (response.answer === null && item.questionId === 'preservation_contract'
      && declined) {
      const fallback = preservationDefault(options.ask ?? document);
      response = { ...response, answer: fallback.answer, status: 'ANSWERED', provenance: { source: 'default' } };
      defaultExportCount = fallback.exportCount;
    }
    if (response.answer === null || (response.provenance?.source !== 'self-authored' && response.provenance?.source !== 'default')
      || response.answer.startsWith(DEFERRED_ANSWER_PREFIX)) continue;
    const answerSource = response.provenance.source;
    try {
      if (!response.answer.trim() || /[\r\n]/.test(response.answer)
        || (answerSource !== 'default' && !item.includeOther && !item.options.some((option) => option.label === response.answer))) continue;
      const current = findUnansweredGoalDocumentClarification(updated, item.questionId);
      const lines = updated.split(/\r?\n/);
      const provenanceLines = current.provenanceLines ?? [];
      for (const line of [...provenanceLines].sort((left, right) => right - left)) lines.splice(line, 1);
      const answerLine = current.answerLine - provenanceLines.filter((line) => line < current.answerLine).length;
      lines[answerLine] = `  - answer: ${response.answer}`;
      lines.splice(answerLine + 1, 0,
        `  - provenance.source: ${answerSource}`,
        ...(response.provenance.evidence ?? []).map((entry) => `  - evidence: ${entry.replace(/[\r\n]/g, ' ')}`));
      updateWhatToBuildRenderAnswers(lines, item.questionId, response.answer);
      if (hasWhatToBuildUnansweredRenderAnswer(lines, item.questionId)) continue;
      const candidate = lines.join(document.includes('\r\n') ? '\r\n' : '\n');
      if (!parseGoalDocumentClarifications(candidate).some((entry) => entry.questionId === item.questionId
        && entry.answered && entry.answer === response.answer && entry.provenanceSource === answerSource)) continue;
      updated = candidate;
      answered += 1;
      if (defaultExportCount !== undefined) {
        observeGoalAuthor('goal-author', 'self-answer-default-applied', {
          runId: options.runId ?? process.env.ELANOUS_RUN_ID,
          questionId: item.questionId,
          exportCount: defaultExportCount,
        });
      }
    } catch {
      // Leave malformed or disallowed answers deferred.
    }
  }
  const asked = pending.length + alreadySelfAnswered;
  const unanswered = pending.length - answered;
  const newlyAnswered = answered;
  answered += alreadySelfAnswered;
  debug.log('self-implement.clarification-escalation', 'self-answer', {
    path: options.path, asked, answered, unanswered,
    reason: unanswered === 0 ? 'answered' : 'insufficient-evidence',
  });
  return { document: updated, asked, answered, unanswered, newlyAnswered };
}


export type ClarificationIntakeMode = 'none' | 'deferred-noninteractive' | 'ask';

export interface ClarificationIntakePlan {
  readonly pending: readonly GoalDocumentClarification[];
  readonly mode: ClarificationIntakeMode;
}

export function planClarificationIntake(document: string, interactive: boolean): ClarificationIntakePlan {
  const pending = parseGoalDocumentClarifications(document).filter((item) => !item.answered);
  if (pending.length === 0) return { pending, mode: 'none' };
  return { pending, mode: interactive ? 'ask' : 'deferred-noninteractive' };
}

/** ⛔ 사람이 준 한 줄을 «옵션»과 «자유 답» 중 어느 주입기로 보낼지 정한다.
 *  ⭐ 빈 줄은 ***답이 아니다*** — 건너뛰고 그 건은 DEFERRED 로 남는다(사람이 「모른다」를 말할 수 있어야 한다).
 *  ⛔ 숫자처럼 보여도 «옵션 범위 밖»이면 자유 답으로 보낸다 — 범위를 벗어난 인덱스로 문서를 깨뜨리지 않는다. */
export function applyClarificationReply(
  document: string,
  clarification: GoalDocumentClarification,
  reply: string,
): { readonly document: string; readonly answered: boolean; readonly kind: 'skipped' | 'option' | 'other' } {
  const trimmed = reply.trim();
  if (trimmed === '') return { document, answered: false, kind: 'skipped' };
  const asIndex = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  if (asIndex !== null && asIndex < clarification.options.length) {
    return {
      document: injectGoalDocumentClarificationOption(document, clarification.questionId, trimmed),
      answered: true,
      kind: 'option',
    };
  }
  return {
    document: injectGoalDocumentClarificationOtherAnswer(document, clarification.questionId, trimmed),
    answered: true,
    kind: 'other',
  };
}
