// AskUserQuestion tool — Phase WF1.
//
// LLM calls this when it needs a structured decision from the user
// before proceeding. Dispatcher opens the TUI modal, awaits answers,
// publishes the result on the events bus (so trace/log subscribers
// pick up the answer out-of-band), and returns a JSON string payload
// the LLM can read back on its next turn.
//
// Wiring uses the same approvalModalRouter singleton as
// src/approval-modal.ts — only one interactive prompt on screen at a
// time. When an approval is already open, AskUserQuestion rejects
// with a clear error the LLM can retry later.

import type { LLMToolSpec } from '../llm.js';
import type { DisplayCoordinator } from '../display/coordinator.js';
import { approvalModalRouter } from '../approval-modal.js';
import { createAskUserQuestionModal } from './modal.js';
import { ASK_USER_QUESTION_DELIVERY_VALUES, parseQuestionRequest } from './types.js';
import { publishQuestionResult } from './events.js';
import { debug } from '../debug/log.js';
import {
  createPendingQuestion,
  readPendingQuestionAnswer,
  removePendingQuestion,
  removePendingQuestionAnswer,
  writePendingQuestion,
} from './pending-questions.js';
import type {
  AskUserQuestionDispatchAbsenceReason,
  AskUserQuestionResult,
  HitlDelivery,
} from './types.js';

// AXON F4 — delivery values that the built-in TUI path can honour
// without a resolver. Non-modal values require a resolver that
// inspects `req.delivery` to fan out to HITL channels.
const TUI_COMPATIBLE_DELIVERY: readonly HitlDelivery[] = ['modal', 'terminal'];

export interface AskUserQuestionDeps {
  coordinator: DisplayCoordinator;
  termSize: () => { cols: number; rows: number };
}

let deps: AskUserQuestionDeps | null = null;

interface PendingQuestionPersistence {
  write(question: ReturnType<typeof createPendingQuestion>): void;
  remove(id: string): void;
}

let pendingQuestionPersistence: PendingQuestionPersistence = {
  write: writePendingQuestion,
  remove: removePendingQuestion,
};

/** Test seam for fail-soft pending-question persistence failures. */
export function setPendingQuestionPersistenceForTesting(persistence: PendingQuestionPersistence | null): void {
  pendingQuestionPersistence = persistence ?? { write: writePendingQuestion, remove: removePendingQuestion };
}

export function setAskUserQuestionDeps(d: AskUserQuestionDeps | null): void {
  deps = d;
}

export function getAskUserQuestionDeps(): AskUserQuestionDeps | null {
  return deps;
}

// ── AU4 — non-TUI resolver (skill / ACP / headless) ─────────────
//
// codex mode-gates request_user_input at the tool handler
// (core/src/tools/handlers/request_user_input.rs:43-54). Elanous's
// equivalent: if the caller isn't on the dashboard surface (no
// coordinator / termSize), they can install a resolver hook that
// takes the parsed request and returns an AskUserQuestionResult
// asynchronously. Without a hook, the dispatcher returns a
// structured error the LLM can react to — matches codex's
// "unavailable in this mode" signal.
//
// Example hosts:
//   • Skill runner in interactive mode: plug a resolver that prompts
//     the user via the terminal it owns.
//   • ACP bridge (AU5): resolver forwards the question over the ACP
//     session_update event and awaits the response.
//   • Test harness: resolver returns a canned answer.

import type { AskUserQuestionRequest } from './types.js';
import { getDefaultQuestionChannels, requestQuestion } from '../hitl/question.js';

/** Per-dispatch context threaded from the ToolRuntime caller. Resolvers
 *  that need to push the question to a specific surface — the ACP
 *  `elanous/ask/*` bridge routes to the peer attached to `sessionId` —
 *  read this to pick the right outbound channel. Absent fields mean
 *  the caller didn't have that affinity (e.g. CLI / startup script). */
export interface AskUserQuestionDispatchContext {
  /** Chat session id when the dispatch comes from inside a turn. The
   *  ACP bridge uses this to fan the request out to peers registered
   *  for that session only. */
  sessionId?: string;
  /** AbortSignal — caller turn cancellation. Resolvers that wait on
   *  an external response (HITL channel, ACP peer) should reject when
   *  this fires so the LLM doesn't block on a dead prompt. */
  signal?: AbortSignal;
}

export type AskUserQuestionResolver = (
  req: AskUserQuestionRequest,
  ctx?: AskUserQuestionDispatchContext,
) => Promise<AskUserQuestionResult>;

let resolver: AskUserQuestionResolver | null = null;

export function setAskUserQuestionResolver(r: AskUserQuestionResolver | null): void {
  resolver = r;
}

export function getAskUserQuestionResolver(): AskUserQuestionResolver | null {
  return resolver;
}

type FileResolverObservationState =
  | 'pending-created'
  | 'pending-removed'
  | 'answer-missing'
  | 'answer-read-failed'
  | 'pending-write-failed'
  | 'answer-remove-failed'
  | 'pending-remove-failed';

interface FileAskUserQuestionResolverDeps {
  createId?: () => string;
  write?: typeof writePendingQuestion;
  readAnswer?: typeof readPendingQuestionAnswer;
  remove?: typeof removePendingQuestion;
  removeAnswer?: typeof removePendingQuestionAnswer;
  sleep?: (ms: number) => Promise<void>;
  observe?: (state: FileResolverObservationState, data?: { pendingQuestionId: string; questionCount: number }) => void;
}

type FileResolverAnswerState = 'answer-missing' | 'answer-read-failed' | 'pending-write-failed';
const fileResolverAnswerStates = new WeakMap<AskUserQuestionResult, FileResolverAnswerState>();
const resolverPresentations = new WeakMap<AskUserQuestionResolver, { surface: 'file'; delivery: 'file' }>();

function cancelledFileResolverResult(answerState: FileResolverAnswerState): AskUserQuestionResult {
  const result = { answers: {}, cancelled: true };
  fileResolverAnswerStates.set(result, answerState);
  return result;
}

export function createFileAskUserQuestionResolver(timeoutMs: number, deps: FileAskUserQuestionResolverDeps = {}): AskUserQuestionResolver {
  const createId = deps.createId ?? (() => `auq:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`);
  const write = deps.write ?? writePendingQuestion;
  const readAnswer = deps.readAnswer ?? readPendingQuestionAnswer;
  const remove = deps.remove ?? removePendingQuestion;
  const removeAnswer = deps.removeAnswer ?? removePendingQuestionAnswer;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const observe = (state: FileResolverObservationState, data?: { pendingQuestionId: string; questionCount: number }): void => {
    try {
      deps.observe?.(state, data);
    } catch {
      // Observability must never alter the pending-record lifecycle.
    }
  };
  const fileResolver: AskUserQuestionResolver = async (req, ctx) => {
    const deadline = Date.now() + timeoutMs;
    const pending = createPendingQuestion(
      createId(),
      req,
      ctx?.sessionId,
      {},
      { surface: 'file', delivery: 'file', expiresAt: new Date(deadline).toISOString() },
    );
    let pendingWritten = false;
    try {
      try {
        write(pending);
        pendingWritten = true;
      } catch {
        // ⛔ pending 쓰기 실패는 「답이 없다」와 다른 실패다 — 대기 자체가 시작되지 못했다.
        //    answer-missing 으로 접으면 중앙 end 관측이 실패 원인을 잃는다(MF-be357c62).
        observe('pending-write-failed');
        return cancelledFileResolverResult('pending-write-failed');
      }
      observe('pending-created', { pendingQuestionId: pending.id, questionCount: pending.questions.length });
      while (Date.now() < deadline) {
        const observed = readAnswer(pending.id);
        if (!observed.ok) {
          observe('answer-read-failed');
          return cancelledFileResolverResult('answer-read-failed');
        }
        if (observed.answer !== null) return observed.answer.result;
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      }
      observe('answer-missing');
      return cancelledFileResolverResult('answer-missing');
    } finally {
      try {
        remove(pending.id);
        if (pendingWritten) {
          observe('pending-removed', { pendingQuestionId: pending.id, questionCount: pending.questions.length });
        }
      } catch {
        observe('pending-remove-failed');
      }
      try {
        removeAnswer(pending.id);
      } catch {
        observe('answer-remove-failed');
      }
    }
  };
  resolverPresentations.set(fileResolver, { surface: 'file', delivery: 'file' });
  return fileResolver;
}

export function buildAskUserQuestionTool(): LLMToolSpec {
  return {
    name: 'AskUserQuestion',
    description:
      'Ask the user 1–3 structured multiple-choice questions to clarify requirements. '
      + 'Use when the request is ambiguous and the answer materially changes your approach '
      + '(architecture choice, scope trade-off, preference between valid alternatives). '
      + 'Do NOT use for information you can find by reading files (Read/Grep/Glob first). '
      + 'Do NOT use to ask "should I proceed?" — use your normal text output or the plan-mode '
      + 'exit flow for approvals. Each question gets 2–4 options; a free-form "Other" row is '
      + 'auto-added unless includeOther:false. Use multiSelect:true when multiple answers are '
      + 'valid. '
      + 'Surfaces: dashboard opens a modal; skill / sub-agent / headless modes use a resolver '
      + 'hook installed by the host. If NEITHER is available, the tool returns a structured '
      + 'error like "AskUserQuestion failed: not available in this surface …". When you see '
      + 'that error, stop retrying — pick a reasonable default and make the assumption explicit '
      + 'in your final reply so the caller can correct you. '
      + 'Optional delivery field (AXON F4) routes the prompt via a HITL channel — set to '
      + '"telegram" / "discord" / "pushcut" / "all" when the host has wired a delivery-aware '
      + 'resolver (e.g. the user stepped away from the terminal). "modal" / "terminal" keep '
      + 'the TUI path; delivery defaults to the TUI path when omitted. '
      + 'Returns JSON: { answers: { <id>: "label" | ["label", ...] }, otherText?: { <id>: "..." }, cancelled?: bool }.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1–3 questions. Prefer 1 unless the decisions are logically independent.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'snake_case stable identifier (used as key in the answer map).' },
              header: { type: 'string', description: '≤12 characters — shown as a pill/chip above the question.' },
              question: { type: 'string', description: 'Full natural-language prompt.' },
              options: {
                type: 'array',
                description: '2–4 predefined choices.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '1–5 words — the choice name.' },
                    description: { type: 'string', description: 'One short sentence on the tradeoff.' },
                    preview: { type: 'string', description: 'Optional markdown shown in a right pane when picking.' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
                minItems: 2,
                maxItems: 4,
              },
              multiSelect: { type: 'boolean', description: 'Default false. Space toggles; Enter submits.' },
              includeOther: { type: 'boolean', description: 'Default true — adds "Other" free-form escape.' },
            },
            required: ['id', 'header', 'question', 'options'],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 3,
        },
        delivery: {
          type: 'string',
          enum: [...ASK_USER_QUESTION_DELIVERY_VALUES],
          description:
            'AXON F4 — optional routing hint. "modal" (default) or "terminal" opens the TUI '
            + 'modal; "telegram" / "discord" / "pushcut" / "all" route via a HITL resolver when '
            + 'the host has wired one. Non-TUI values without a resolver return a clear error.',
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  };
}

export interface AskUserQuestionDispatchResult {
  output: string;
  result?: AskUserQuestionResult;
  /** Present only when no answer-capable destination exists; resolver errors remain failures. */
  absenceReason?: AskUserQuestionDispatchAbsenceReason;
}

export const ASK_USER_QUESTION_OBSERVABILITY_CATEGORY = 'ask-user-question.dispatch';

type AskUserQuestionDispatchOutcome =
  | 'answered'
  | 'parse-failed'
  | 'no-resolver'
  | 'cancelled'
  | 'failed'
  | 'busy'
  | 'other';

function observeAskUserQuestion(event: 'start' | 'end', data: Record<string, unknown>): void {
  try {
    debug.log(ASK_USER_QUESTION_OBSERVABILITY_CATEGORY, event, data);
  } catch {
    // Observability must never alter the interactive dispatch path.
  }
}

async function resolveViaSseQuestionChannels(
  req: AskUserQuestionRequest,
  ctx?: AskUserQuestionDispatchContext,
): Promise<AskUserQuestionResult | null> {
  const channels = getDefaultQuestionChannels();
  if (channels.length === 0) return null;
  const raced = await requestQuestion({
    request: req,
    channels,
    requestId: ctx?.sessionId,
  });
  if (raced.channel === 'all-failed' || raced.channel === 'timeout') return null;
  return raced.result;
}

function classifyAskUserQuestionOutcome(
  parsed: ReturnType<typeof parseQuestionRequest>,
  dispatched: AskUserQuestionDispatchResult | undefined,
  explicitOutcome?: AskUserQuestionDispatchOutcome,
): AskUserQuestionDispatchOutcome {
  if (explicitOutcome !== undefined) return explicitOutcome;
  if (parsed.ok !== true) return 'parse-failed';
  if (dispatched?.result?.cancelled === true) return 'cancelled';
  if (dispatched?.result !== undefined) return 'answered';
  if (dispatched?.absenceReason === 'no-delivery-resolver'
    || dispatched?.absenceReason === 'no-capable-peer'
    || dispatched?.absenceReason === 'no-tui-deps-no-resolver') {
    return 'no-resolver';
  }
  return 'other';
}

export async function dispatchAskUserQuestion(
  raw: Record<string, unknown>,
  dispatchCtx?: AskUserQuestionDispatchContext,
): Promise<AskUserQuestionDispatchResult> {
  const startedAt = Date.now();
  const parsed = parseQuestionRequest(raw);
  const questions = parsed.ok === true ? parsed.req.questions : [];
  observeAskUserQuestion('start', {
    sessionId: dispatchCtx?.sessionId,
    delivery: parsed.ok === true ? parsed.req.delivery ?? 'modal' : undefined,
    questionCount: questions.length,
    optionCount: questions.reduce((count, question) => count + question.options.length, 0),
    questionLengths: questions.map((question) => question.question.length),
  });

  let dispatched: AskUserQuestionDispatchResult | undefined;
  let explicitOutcome: AskUserQuestionDispatchOutcome | undefined;
  let resolvedPresentation: { surface: 'file'; delivery: 'file' } | undefined;
  let cancelledBySignal = false;
  try {
    if (parsed.ok !== true) {
      dispatched = { output: `AskUserQuestion failed: ${parsed.reason}` };
      return dispatched;
    }

  // AXON F4 — delivery hint routing.
  // 1. Non-TUI delivery ('telegram' / 'discord' / 'pushcut' / 'all'):
  //    prefer the resolver (only it can fan out to HITL channels). If
  //    no resolver is installed, return a structured error rather than
  //    silently falling through to the TUI — otherwise a Telegram-
  //    intended prompt would pop up on screen the user isn't looking at.
  // 2. TUI-compatible delivery ('modal' / 'terminal' / unset): follow
  //    the original AU4 precedence — TUI deps first, resolver fallback.
  const delivery = parsed.req.delivery;
  const wantsNonTui = delivery !== undefined && !TUI_COMPATIBLE_DELIVERY.includes(delivery);

  if (wantsNonTui) {
    if (!resolver) {
      return dispatched = {
        output:
          `AskUserQuestion failed: delivery='${delivery}' requires a HITL resolver, but none is `
          + 'installed in this surface. Either configure a delivery-aware resolver on the host, '
          + 'or drop the delivery field to use the TUI modal path.',
        absenceReason: 'no-delivery-resolver',
      };
    }
    try {
      resolvedPresentation = resolverPresentations.get(resolver);
      const result = await resolver(parsed.req, dispatchCtx);
      publishQuestionResult(result, parsed.req.questions.map((q) => q.id));
      return dispatched = { output: JSON.stringify(result), result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as { name?: string } | null)?.name === 'AskBridgeUnavailable') {
        const sseResult = await resolveViaSseQuestionChannels(parsed.req, dispatchCtx);
        if (sseResult) {
          publishQuestionResult(sseResult, parsed.req.questions.map((q) => q.id));
          return dispatched = { output: JSON.stringify(sseResult), result: sseResult };
        }
        return dispatched = {
          output: `AskUserQuestion failed (resolver): ${msg}`,
          absenceReason: 'no-capable-peer',
        };
      }
      explicitOutcome = 'failed';
      return dispatched = { output: `AskUserQuestion failed (resolver): ${msg}` };
    }
  }

  // 2026-05-13 (M2 of AskUserQuestion cross-surface arc) — when a
  // sessionId is plumbed AND a resolver is installed (typically the ACP
  // bridge), try the resolver FIRST so iOS/PWA peers receive the prompt
  // natively even when dashboard TUI deps are also wired. The bridge
  // throws an `AskBridgeUnavailable` sentinel when there's no cap-able
  // peer attached to this session — that's our signal to fall through
  // to the TUI deps / fallback resolver path below. Other errors
  // surface as `AskUserQuestion failed (resolver): …`.
  if (resolver && dispatchCtx?.sessionId) {
    try {
      resolvedPresentation = resolverPresentations.get(resolver);
      const result = await resolver(parsed.req, dispatchCtx);
      publishQuestionResult(result, parsed.req.questions.map((q) => q.id));
      return dispatched = { output: JSON.stringify(result), result };
    } catch (err) {
      const errName = (err as { name?: string } | null)?.name;
      if (errName !== 'AskBridgeUnavailable') {
        const msg = err instanceof Error ? err.message : String(err);
        explicitOutcome = 'failed';
        return dispatched = { output: `AskUserQuestion failed (resolver): ${msg}` };
      }
      const sseResult = await resolveViaSseQuestionChannels(parsed.req, dispatchCtx);
      if (sseResult) {
        publishQuestionResult(sseResult, parsed.req.questions.map((q) => q.id));
        return dispatched = { output: JSON.stringify(sseResult), result: sseResult };
      }
      // Fall through — no cap-able peer for this session and no SSE
      // question channel answered. TUI deps (if wired) still get a turn.
    }
  }

  // AU4 — prefer the TUI path when deps are wired (dashboard). Fall
  // back to the resolver hook (skill / ACP / headless) when not.
  // A structured error in both missing-paths gives the LLM a clean
  // signal to stop asking and try a different strategy.
  if (!deps) {
    if (resolver) {
      try {
        resolvedPresentation = resolverPresentations.get(resolver);
        const result = await resolver(parsed.req, dispatchCtx);
        publishQuestionResult(result, parsed.req.questions.map((q) => q.id));
        return dispatched = { output: JSON.stringify(result), result };
      } catch (err) {
        const errName = (err as { name?: string } | null)?.name;
        if (errName === 'AskBridgeUnavailable') {
          const sseResult = await resolveViaSseQuestionChannels(parsed.req, dispatchCtx);
          if (sseResult) {
            publishQuestionResult(sseResult, parsed.req.questions.map((q) => q.id));
            return dispatched = { output: JSON.stringify(sseResult), result: sseResult };
          }
          // No-context bridge call · no fallback at this surface.
          return dispatched = {
            output:
              'AskUserQuestion failed: ACP bridge has no cap-able peer for this session, and no '
              + 'other surface (TUI / readline) is wired. Proceed with a best-guess default and '
              + 'note the assumption in your reply so the caller can correct you.',
            absenceReason: 'no-capable-peer',
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        explicitOutcome = 'failed';
        return dispatched = { output: `AskUserQuestion failed (resolver): ${msg}` };
      }
    }
    return dispatched = {
      output:
        'AskUserQuestion failed: not available in this surface (no TUI deps + no resolver hook). '
        + 'This means you are running in skill / subagent / headless mode without a question resolver '
        + 'wired by the host. Proceed with a best-guess default and note the assumption in your reply '
        + 'so the caller can correct you.',
      absenceReason: 'no-tui-deps-no-resolver',
    };
  }

  // A caller that already gave up (turn cancel, doom-loop ask timeout) must
  // not pop a modal that would then sit on screen taking the operator's keys.
  const abortSignal = dispatchCtx?.signal;
  if (abortSignal?.aborted) {
    cancelledBySignal = true;
    const result: AskUserQuestionResult = { answers: {}, cancelled: true };
    return dispatched = { output: JSON.stringify(result), result };
  }

  const { cols, rows } = deps.termSize();
  const width = Math.min(90, Math.max(44, cols - 6));
  // Height: header(1) + separator(1) + Q-text(2) + gap(1) + ≤5 opts + actions(1) + border(2) ≈ 13
  const maxOptionRows = Math.max(...parsed.req.questions.map((q) =>
    q.options.length + (q.includeOther === false ? 0 : 1),
  ));
  const height = Math.min(
    Math.max(12, rows - 4),
    10 + maxOptionRows + 2,   // other-mode adds 2
  );
  const bounds = {
    row: Math.max(1, Math.floor((rows - height) / 2)),
    col: Math.max(1, Math.floor((cols - width) / 2)),
    width,
    height,
  };

  const pendingQuestionId = `auq:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
  const modal = createAskUserQuestionModal({
    id: pendingQuestionId,
    bounds,
    request: parsed.req,
  });
  // B-3c pilot #2 (2026-04-21) — typed primitive push. The typed type
  // `'ask-user-question-modal'` is registered in B-3a's
  // APP_MODAL_TYPES. Coord's mounted/disposed reverse-wiring (B-3b
  // Part 2) drives upsertSurface + closeSurface, so this call site no
  // longer needs display.pushModal(surface). Generalizes the B-3b
  // pattern from attachment-popup (popup tier) to ask-user-question
  // (dialog tier) — one more caller off the legacy coord.pushModal
  // path. Session A turf 0 touch; all edits in src/ask-user-question/.
  const primitiveHandle = deps.coordinator.modalLifecycleAPI().push(
    'ask-user-question-modal',
    { idempotencyKey: 'ask-user-question' },
    modal.surface,
  );
  const disposePrimitive = () => {
    if (primitiveHandle && !primitiveHandle.isDisposed()) {
      try { primitiveHandle.dispose(); } catch { /* ignore */ }
    }
  };
  const installed = approvalModalRouter.set(modal as any, disposePrimitive, 'askUser');
  if (!installed) {
    modal.dispose(true);
    disposePrimitive();
    explicitOutcome = 'busy';
    return dispatched = { output: 'AskUserQuestion failed: another approval/question is already open' };
  }

  const pendingQuestion = createPendingQuestion(pendingQuestionId, parsed.req, dispatchCtx?.sessionId);
  let pendingWritten = false;
  try {
    pendingQuestionPersistence.write(pendingQuestion);
    pendingWritten = true;
  } catch (error) {
    observeAskUserQuestion('start', {
      pendingQuestionId: pendingQuestion.id,
      pendingQuestionWriteFailed: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (pendingWritten) {
    observeAskUserQuestion('start', {
      pendingQuestionId: pendingQuestion.id,
      pendingQuestionCreated: true,
      questionCount: pendingQuestion.questions.length,
    });
  }

  // TUI-DOOM-ASK-TIMEOUT-STALE-MODAL — honour the caller's AbortSignal the way
  // the ACP bridge does: close the modal (resolves as cancelled, which releases
  // the approval router and disposes the surface) instead of leaving it open
  // after the caller stopped waiting. A late answer would be dropped anyway.
  const onAbort = (): void => {
    cancelledBySignal = true;
    modal.dispose(true);
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await modal.promise;
    publishQuestionResult(result, parsed.req.questions.map((q) => q.id));

    return dispatched = {
      output: JSON.stringify(result),
      result,
    };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    let pendingRemoved = false;
    try {
      pendingQuestionPersistence.remove(pendingQuestion.id);
      pendingRemoved = true;
    } catch (error) {
      observeAskUserQuestion('end', {
        pendingQuestionId: pendingQuestion.id,
        pendingQuestionRemoveFailed: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (pendingWritten && pendingRemoved) {
      observeAskUserQuestion('end', {
        pendingQuestionId: pendingQuestion.id,
        pendingQuestionRemoved: true,
        questionCount: pendingQuestion.questions.length,
      });
    }
  }
  } finally {
    const answerState = dispatched?.result === undefined ? undefined : fileResolverAnswerStates.get(dispatched.result);
    observeAskUserQuestion('end', {
      sessionId: dispatchCtx?.sessionId,
      delivery: resolvedPresentation?.delivery ?? (parsed.ok === true ? parsed.req.delivery ?? 'modal' : undefined),
      ...(resolvedPresentation === undefined ? {} : { surface: resolvedPresentation.surface }),
      outcome: classifyAskUserQuestionOutcome(parsed, dispatched, explicitOutcome),
      ...(answerState === undefined ? {} : { answerState }),
      ...(cancelledBySignal ? { cancelledBySignal: true } : {}),
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
  }
}
