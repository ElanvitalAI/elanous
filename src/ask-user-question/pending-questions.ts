import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { elanousStateRoot } from '../autopilot/state-paths.js';
import { assertNotTestWritingOps } from '../instance/test-write-guard.js';
import { ASK_USER_QUESTION_DELIVERY_VALUES } from './types.js';
import type { AskUserQuestionRequest, AskUserQuestionResult, HitlDelivery, Question, QuestionOption } from './types.js';

export interface PendingQuestion {
  id: string;
  sessionId?: string;
  runId?: string;
  /** Explicit provenance for isolated test questions; a temporary goal path alone is not proof. */
  testOrigin?: true;
  questions: Array<Pick<Question, 'id' | 'question' | 'options' | 'impact' | 'recommendedIndex'>>;
  startedAt: string;
  expiresAt?: string;
  surface: 'tui' | 'file';
  delivery: HitlDelivery | 'file';
}

interface PendingQuestionPresentation {
  surface: PendingQuestion['surface'];
  delivery: PendingQuestion['delivery'];
  expiresAt?: string;
}

type PendingQuestionExpiryStatus = 'no-expiry' | 'active' | 'expired';

interface PendingQuestionWithWait extends PendingQuestion {
  waitingMs: number;
  expiryStatus: PendingQuestionExpiryStatus;
}

interface PendingQuestionAnswer {
  id: string;
  result: AskUserQuestionResult;
}

type PendingQuestionReadResult =
  | { ok: true; questions: PendingQuestion[] }
  | { ok: false; error: string };

type PendingQuestionQueryResult =
  | { ok: true; questions: PendingQuestionWithWait[] }
  | { ok: false; error: string };

type PendingQuestionAnswerReadResult =
  | { ok: true; answer: PendingQuestionAnswer | null }
  | { ok: false; error: string };

interface PendingQuestionStoreDeps {
  root?: () => string;
  now?: () => Date;
  writeFile?: typeof writeFileSync;
  renameFile?: typeof renameSync;
  removeFile?: typeof rmSync;
  readDir?: typeof readdirSync;
  readFile?: typeof readFileSync;
  exists?: typeof existsSync;
  makeDir?: typeof mkdirSync;
}

function isQuestionOption(value: unknown): value is QuestionOption {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  return typeof option.label === 'string'
    && typeof option.description === 'string'
    && (option.preview === undefined || typeof option.preview === 'string');
}

function isPendingQuestionDelivery(value: unknown): value is PendingQuestion['delivery'] {
  return value === 'file'
    || (typeof value === 'string'
      && (ASK_USER_QUESTION_DELIVERY_VALUES as readonly string[]).includes(value));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  return typeof pending.id === 'string'
    && (pending.sessionId === undefined || typeof pending.sessionId === 'string')
    && (pending.runId === undefined || typeof pending.runId === 'string')
    && (pending.testOrigin === undefined || pending.testOrigin === true)
    && Array.isArray(pending.questions)
    && pending.questions.every((question) => {
      if (question === null || typeof question !== 'object' || Array.isArray(question)) return false;
      const record = question as Record<string, unknown>;
      return typeof record.id === 'string'
        && typeof record.question === 'string'
        && Array.isArray(record.options)
        && record.options.every(isQuestionOption)
        && (record.impact === undefined || record.impact === 'low' || record.impact === 'medium' || record.impact === 'high' || record.impact === 'critical')
        && (record.recommendedIndex === undefined || (typeof record.recommendedIndex === 'number'
          && Number.isInteger(record.recommendedIndex)));
    })
    && isIsoTimestamp(pending.startedAt)
    && (pending.surface === 'tui' || pending.surface === 'file')
    // File-surface records back the CLI answer path: the operator cannot judge
    // whether a `file/file` wait is still open without a concrete deadline, so
    // `expiresAt` is required (and must be a valid ISO timestamp) on that surface.
    // The TUI modal blocks the local turn, so its `expiresAt` stays optional.
    && (pending.surface === 'file'
      ? isIsoTimestamp(pending.expiresAt)
      : pending.expiresAt === undefined || isIsoTimestamp(pending.expiresAt))
    && isPendingQuestionDelivery(pending.delivery)
    && ((pending.surface === 'file') === (pending.delivery === 'file'));
}

function parsePendingQuestion(contents: string, file: string): PendingQuestion {
  const value: unknown = JSON.parse(contents);
  if (!isPendingQuestion(value)) throw new Error(`Invalid pending question record: ${file}`);
  return {
    ...value,
    questions: value.questions.map((question) => ({
      ...question,
      ...(question.recommendedIndex !== undefined
        && (question.recommendedIndex < 0 || question.recommendedIndex >= question.options.length)
        ? { recommendedIndex: undefined } : {}),
    })),
  };
}

export function isAskUserQuestionResult(value: unknown): value is AskUserQuestionResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.answers === null || typeof result.answers !== 'object' || Array.isArray(result.answers)) return false;
  return Object.values(result.answers).every((answer) => typeof answer === 'string' || (Array.isArray(answer) && answer.every((item) => typeof item === 'string')))
    && (result.otherText === undefined || (result.otherText !== null && typeof result.otherText === 'object' && !Array.isArray(result.otherText) && Object.values(result.otherText).every((item) => typeof item === 'string')))
    && (result.cancelled === undefined || typeof result.cancelled === 'boolean');
}

function parsePendingQuestionAnswer(contents: string, file: string): PendingQuestionAnswer {
  const value: unknown = JSON.parse(contents);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid pending question answer: ${file}`);
  const answer = value as Record<string, unknown>;
  if (typeof answer.id !== 'string' || !isAskUserQuestionResult(answer.result)) throw new Error(`Invalid pending question answer: ${file}`);
  return { id: answer.id, result: answer.result };
}

function pendingQuestionDir(root = elanousStateRoot()): string {
  return join(root, 'ask-user-question', 'pending');
}

function pendingQuestionAnswerDir(root = elanousStateRoot()): string {
  return join(root, 'ask-user-question', 'answers');
}

function pendingQuestionPath(id: string, root?: string): string {
  return join(pendingQuestionDir(root), `${encodeURIComponent(id)}.json`);
}

function pendingQuestionAnswerPath(id: string, root?: string): string {
  return join(pendingQuestionAnswerDir(root), `${encodeURIComponent(id)}.json`);
}

function writeAtomicRecord(id: string, value: unknown, dir: string, target: string, deps: PendingQuestionStoreDeps): void {
  const temp = join(dir, `.${encodeURIComponent(id)}.${process.pid}.${(deps.now ?? (() => new Date()))().getTime()}.${Math.random().toString(36).slice(2)}.tmp`);
  assertNotTestWritingOps(target, 'write a pending question record');
  const remove = deps.removeFile ?? rmSync;
  try {
    (deps.makeDir ?? mkdirSync)(dir, { recursive: true });
    (deps.writeFile ?? writeFileSync)(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    (deps.renameFile ?? renameSync)(temp, target);
  } catch (error) {
    try { remove(temp, { force: true }); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

export function createPendingQuestion(
  id: string,
  request: AskUserQuestionRequest,
  sessionId?: string,
  deps: Pick<PendingQuestionStoreDeps, 'now'> = {},
  presentation: PendingQuestionPresentation = { surface: 'tui', delivery: request.delivery ?? 'modal' },
  provenance: { testOrigin?: true } = {},
): PendingQuestion {
  // File-surface waits must carry a concrete deadline so the CLI answer path can
  // reject an expired record (see isPendingQuestion). Fail loudly at creation
  // rather than persisting a record the reader will treat as structurally invalid.
  if (presentation.surface === 'file' && !isIsoTimestamp(presentation.expiresAt)) {
    throw new Error('File-surface pending question requires a valid expiresAt timestamp.');
  }
  return {
    id,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(provenance.testOrigin ? { testOrigin: true as const } : {}),
    questions: request.questions.map(({ id, question, options, impact, recommendedIndex }) => ({
      id, question, options,
      ...(impact === undefined ? {} : { impact }),
      ...(recommendedIndex !== undefined && Number.isInteger(recommendedIndex) && recommendedIndex >= 0 && recommendedIndex < options.length
        ? { recommendedIndex } : {}),
    })),
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
    ...(presentation.expiresAt === undefined ? {} : { expiresAt: presentation.expiresAt }),
    surface: presentation.surface,
    delivery: presentation.delivery,
  };
}

/** Best-effort lifecycle observation: callers deliberately ignore failures. */
export function writePendingQuestion(question: PendingQuestion, deps: PendingQuestionStoreDeps = {}): void {
  const root = (deps.root ?? elanousStateRoot)();
  writeAtomicRecord(question.id, question, pendingQuestionDir(root), pendingQuestionPath(question.id, root), deps);
}

export function writePendingQuestionAnswer(answer: PendingQuestionAnswer, deps: PendingQuestionStoreDeps = {}): void {
  const root = (deps.root ?? elanousStateRoot)();
  writeAtomicRecord(answer.id, answer, pendingQuestionAnswerDir(root), pendingQuestionAnswerPath(answer.id, root), deps);
}

export function readPendingQuestionAnswer(id: string, deps: PendingQuestionStoreDeps = {}): PendingQuestionAnswerReadResult {
  try {
    const root = (deps.root ?? elanousStateRoot)();
    const target = pendingQuestionAnswerPath(id, root);
    if (!(deps.exists ?? existsSync)(target)) return { ok: true, answer: null };
    const answer = parsePendingQuestionAnswer((deps.readFile ?? readFileSync)(target, 'utf8'), target);
    if (answer.id !== id) throw new Error(`Pending question answer id does not match file: ${target}`);
    return { ok: true, answer };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function removePendingQuestionAnswer(id: string, deps: PendingQuestionStoreDeps = {}): void {
  const root = (deps.root ?? elanousStateRoot)();
  const path = pendingQuestionAnswerPath(id, root);
  assertNotTestWritingOps(path, 'remove a pending question answer');
  (deps.removeFile ?? rmSync)(path, { force: true });
}

/** Best-effort lifecycle observation: callers deliberately ignore failures. */
export function removePendingQuestion(id: string, deps: PendingQuestionStoreDeps = {}): void {
  const root = (deps.root ?? elanousStateRoot)();
  const path = pendingQuestionPath(id, root);
  assertNotTestWritingOps(path, 'remove a pending question');
  (deps.removeFile ?? rmSync)(path, { force: true });
}

export function readPendingQuestions(deps: PendingQuestionStoreDeps = {}): PendingQuestionReadResult {
  try {
    const root = (deps.root ?? elanousStateRoot)();
    const dir = pendingQuestionDir(root);
    if (!(deps.exists ?? existsSync)(dir)) return { ok: true, questions: [] };
    const questions: PendingQuestion[] = [];
    for (const entry of (deps.readDir ?? readdirSync)(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        questions.push(parsePendingQuestion((deps.readFile ?? readFileSync)(join(dir, entry.name), 'utf8'), entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    questions.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return { ok: true, questions };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function pendingQuestionExpiryStatus(expiresAt: string | undefined, now = Date.now()): PendingQuestionExpiryStatus {
  if (expiresAt === undefined) return 'no-expiry';
  return Date.parse(expiresAt) <= now ? 'expired' : 'active';
}

export function addPendingQuestionWaiting(result: PendingQuestionReadResult, now = Date.now()): PendingQuestionQueryResult {
  if (!result.ok) return result;
  return {
    ok: true,
    questions: result.questions.map((question) => ({
      ...question,
      waitingMs: Math.max(0, now - Date.parse(question.startedAt)),
      expiryStatus: pendingQuestionExpiryStatus(question.expiresAt, now),
    })),
  };
}

export function formatPendingQuestions(result: PendingQuestionReadResult, now = Date.now()): string {
  if (!result.ok) return `Unable to read pending questions: ${result.error}`;
  if (result.questions.length === 0) return 'No pending questions.';
  const observed = addPendingQuestionWaiting(result, now);
  if (!observed.ok) return `Unable to read pending questions: ${observed.error}`;
  return observed.questions.map((pending) => {
    const prompts = pending.questions.map((question) => question.question).join(' | ');
    return `${pending.id}  waiting=${Math.floor(pending.waitingMs / 1000)}s  expiry=${pending.expiryStatus}  surface=${pending.surface}  questions=${prompts}`;
  }).join('\n');
}
