// AskUserQuestion types — Phase WF1 + AXON F4.
//
// Blends Claude Code's QuestionOption shape (label / description /
// preview / multiSelect) with Codex's auto-Other free-form escape.
// The LLM invokes the tool with 1–3 questions; the TUI modal collects
// answers and returns them as a structured object.
//
// AXON F4 (2026-04-20) — adds an optional `delivery: HitlDelivery`
// field so callers can hint where the prompt should be routed
// (modal TUI default, or a HITL channel like Telegram/Discord when
// the host has wired a delivery-aware resolver). The schema stays
// backward-compatible; absent `delivery` preserves the pre-F4 TUI
// behaviour exactly.

import type { HitlDelivery } from '../hitl/types.js';
import type { ClarificationImpact } from '../hitl/clarification-policy.js';
export type { HitlDelivery };

export interface QuestionOption {
  /** 1–5 words — shown in the list. */
  label: string;
  /** One short sentence explaining the tradeoff. */
  description: string;
  /** Optional markdown — when present, rendered in a right-pane
   *  preview so the user can compare options visually. Rare; reserve
   *  for "show me the snippet" style questions. */
  preview?: string;
}

export interface Question {
  /** Stable snake_case id — used as the key in AskUserQuestionResult
   *  so the LLM can ask about the same topic across turns and match
   *  answers to its own slot names. */
  id: string;
  /** ≤12 chars — shown as a pill/chip above the question text. */
  header: string;
  /** Full natural-language prompt. */
  question: string;
  /** 2–4 pre-defined choices. */
  options: QuestionOption[];
  impact?: ClarificationImpact;
  /** Zero-based position in options; an out-of-range value is ignored. */
  recommendedIndex?: number;
  /** When true, user can pick more than one option; Space toggles,
   *  Enter submits. Default false. */
  multiSelect?: boolean;
  /** When true, a trailing "Other (type your own)" option is added
   *  and picking it opens a free-form input at the bottom of the
   *  modal. Default true — mirrors Codex's auto-Other so the model
   *  never boxes the user in. */
  includeOther?: boolean;
}

export interface AskUserQuestionRequest {
  questions: Question[];   // 1–3
  runId?: string;
  /** AXON F4 — optional routing hint. When set, callers with HITL
   *  resolvers can fan the prompt out to Telegram/Discord/etc;
   *  omitted (or `'modal'` / `'terminal'`) keeps the existing TUI
   *  behaviour. Non-modal delivery requires a resolver that reads
   *  `req.delivery` — the dispatcher will error clearly when only
   *  the TUI path is wired. */
  delivery?: HitlDelivery;
}

/** Why a question could not reach any answer-capable surface. */
export type AskUserQuestionDispatchAbsenceReason =
  | 'no-capable-peer'
  | 'no-delivery-resolver'
  | 'no-tui-deps-no-resolver';

export interface AskUserQuestionResult {
  /** Per-question answers. For single-select, the value is the
   *  chosen option's label (or "Other"); for multi-select, an array
   *  of labels. */
  answers: Record<string, string | string[]>;
  /** When a question's Other option was chosen, the free-form text
   *  keyed by question id. Absent otherwise. */
  otherText?: Record<string, string>;
  /** True when the user hit Esc or closed the modal before answering
   *  all questions. Any earlier answers are still returned so the
   *  LLM can partially infer the user's direction. */
  cancelled?: boolean;
  /** Optional provenance declared by the resolver that produced this result. */
  answeredBy?: 'human' | 'agent';
}

/** Validation error surfaced back to the LLM via the tool's output
 *  string. The tool itself never throws — malformed input comes back
 *  as `{ output: "AskUserQuestion failed: <reason>" }`. */
export interface AskUserQuestionError {
  ok: false;
  reason: string;
}

export const MAX_QUESTIONS = 3;
export const MAX_OPTIONS_PER_QUESTION = 4;
export const MIN_OPTIONS_PER_QUESTION = 2;
export const MAX_HEADER_LENGTH = 12;

/** AXON F4 — allowed values for `AskUserQuestionRequest.delivery`.
 *  Mirrors `HitlDelivery` from `src/hitl/types.ts`; kept as an
 *  explicit const here so the tool schema's `enum` stays in sync
 *  without importing a value the JSON schema can't serialise. */
export const ASK_USER_QUESTION_DELIVERY_VALUES: readonly HitlDelivery[] = [
  'modal',
  'terminal',
  'telegram',
  'discord',
  'pushcut',
  'all',
];

function isValidDelivery(raw: unknown): raw is HitlDelivery {
  return typeof raw === 'string' && (ASK_USER_QUESTION_DELIVERY_VALUES as readonly string[]).includes(raw);
}

/** Shape-check + coerce raw tool args. Callers hand the return value
 *  straight to the modal when ok:true, or format the reason into the
 *  tool output when ok:false. */
export function parseQuestionRequest(
  raw: Record<string, unknown>,
): { ok: true; req: AskUserQuestionRequest } | AskUserQuestionError {
  const q = raw.questions;
  if (!Array.isArray(q) || q.length === 0) {
    return { ok: false, reason: 'questions must be a non-empty array' };
  }
  if (q.length > MAX_QUESTIONS) {
    return { ok: false, reason: `at most ${MAX_QUESTIONS} questions per call (got ${q.length})` };
  }

  const parsed: Question[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < q.length; i++) {
    const item = q[i] as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) return { ok: false, reason: `question ${i}: id required (snake_case)` };
    if (seenIds.has(id)) return { ok: false, reason: `question ${i}: id "${id}" is duplicated` };
    seenIds.add(id);

    const header = typeof item.header === 'string' ? item.header : '';
    if (!header) return { ok: false, reason: `question ${i}: header required` };
    if (header.length > MAX_HEADER_LENGTH) {
      return { ok: false, reason: `question ${i}: header must be ≤${MAX_HEADER_LENGTH} chars (got ${header.length})` };
    }

    const question = typeof item.question === 'string' ? item.question : '';
    if (!question.trim()) return { ok: false, reason: `question ${i}: question text required` };

    const rawOpts = Array.isArray(item.options) ? item.options : [];
    if (rawOpts.length < MIN_OPTIONS_PER_QUESTION || rawOpts.length > MAX_OPTIONS_PER_QUESTION) {
      return {
        ok: false,
        reason: `question ${i}: ${MIN_OPTIONS_PER_QUESTION}–${MAX_OPTIONS_PER_QUESTION} options required (got ${rawOpts.length})`,
      };
    }
    const options: QuestionOption[] = [];
    for (let j = 0; j < rawOpts.length; j++) {
      const o = rawOpts[j] as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      const description = typeof o.description === 'string' ? o.description.trim() : '';
      if (!label) return { ok: false, reason: `question ${i}, option ${j}: label required` };
      if (!description) return { ok: false, reason: `question ${i}, option ${j}: description required` };
      const preview = typeof o.preview === 'string' ? o.preview : undefined;
      options.push({ label, description, ...(preview ? { preview } : {}) });
    }

    parsed.push({
      id,
      header,
      question,
      options,
      ...(item.impact === 'low' || item.impact === 'medium' || item.impact === 'high' || item.impact === 'critical' ? { impact: item.impact } : {}),
      ...(typeof item.recommendedIndex === 'number' && Number.isInteger(item.recommendedIndex)
        && item.recommendedIndex >= 0 && item.recommendedIndex < options.length ? { recommendedIndex: item.recommendedIndex } : {}),
      multiSelect: item.multiSelect === true,
      includeOther: item.includeOther !== false,  // default true
    });
  }

  // AXON F4 — delivery is optional. Strict validation: a present-but-
  // invalid value is an error (prevents typos like 'telegarm' from
  // silently dropping the hint and landing on the modal path).
  let delivery: HitlDelivery | undefined;
  if (raw.delivery !== undefined) {
    if (!isValidDelivery(raw.delivery)) {
      return {
        ok: false,
        reason: `delivery must be one of ${ASK_USER_QUESTION_DELIVERY_VALUES.join(', ')} (got ${JSON.stringify(raw.delivery)})`,
      };
    }
    delivery = raw.delivery;
  }

  const req: AskUserQuestionRequest = { questions: parsed };
  if (delivery !== undefined) req.delivery = delivery;
  if (typeof raw.runId === 'string') req.runId = raw.runId;
  return { ok: true, req };
}
