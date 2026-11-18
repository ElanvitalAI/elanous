/** Shared guardrails for every core-turn research surface. */
export const RESEARCH_TURN_MAX_TOOL_TURNS = 20;
export const RESEARCH_TURN_FIRST_REPLY_BUDGET_MS = 15_000;
/** Research returns its best partial evidence before the parent has to abort the turn. */
export const RESEARCH_TURN_FINAL_ANSWER_DEADLINE_MS = 8 * 60_000;
export const RESEARCH_TURN_DEEP_BUDGET_MS = 9 * 60_000;
export const RESEARCH_TURN_SHALLOW_BUDGET_MS = 3 * 60_000;
/** Leave time for shallow partial-answer synthesis before the unchanged parent timeout. */
export const RESEARCH_TURN_SHALLOW_FINAL_ANSWER_DEADLINE_MS = RESEARCH_TURN_SHALLOW_BUDGET_MS - 10_000;
export const RESEARCH_TURN_DEADLINE_STOP_ERROR = 'research stopped by its deadline';
/**
 * Forced synthesis runs only after the research budget is spent, so it answers at a light reasoning effort unless
 * the caller chose one. 출처: RES OP81990 (main 2151f484, 2026-11-17) — GLM forced synthesis was sent with
 * `reasoningEffort: null` (server-default thinking) and was aborted 3/3 in the window left after the 120s research
 * budget; the same turn's question plan already runs at 'low' (`RESEARCH_QUESTION_PLAN_REASONING_EFFORT`, #38041).
 */
export const RESEARCH_FORCED_SYNTHESIS_REASONING_EFFORT = 'low' as const;

/**
 * 1121 FIRST-CITED-30S — the grounding-first early answer (partial, provisional, replaced by the full synthesis)
 * answers at a light reasoning effort unless the caller chose one. 출처: RES GROUNDING-MAIN1409-FIRSTCHUNK-82186
 * (main 1409e570, GLM, 2026-11-17) — the early answer already started 0.6–1.8s after the original-question search
 * (`grounding-first-early-answer-started` right after `original-question-search-settled {beforePlan:true}`), but
 * the call ran with no effort (server-default thinking) and took 24.4s / 32.5s / 38.8s
 * (`grounding-first-early-answer-ready.durationMs`); the first body text of Q3 arrived only at 30.2s. Same pattern as
 * the question plan (#38043) and the forced synthesis (#38061). Grounding, evidence and the citation guard are unchanged.
 */
export const RESEARCH_EARLY_ANSWER_REASONING_EFFORT = 'low' as const;

/**
 * 1121 FIRST-ANSWER-30S — output cap of the grounding-first early answer (a caller cap: no auto-continuation).
 * 출처: REHEARSAL-0328 U2b (candidate dfe56f7, grok-4.7, effort low, 2026-11-17 14:32Z ·
 * seat-state/UX/evidence/20261117/REHEARSAL-0328/U2/nexus-debug.jsonl): the original-question evidence arrived at
 * +2.5s and the early answer started at once, but it ran under the deep-Bloom L4·L5 instruction and wrote 1,679 chars
 * in 51.7s (`first-cited-text` at +49.2s). The light early answer is ≤ 4 sentences (≈ 400 Korean chars ≈ ≤ 400
 * tokens); the same order again is kept as headroom for low-effort reasoning, rounded up to a power of two → 1,024.
 */
export const RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS = 1_024;

/**
 * 1121 FIRST-ANSWER-30S — the early answer's own instruction: Bloom remember/understand only (what the evidence
 * says), short, cited first. Deep analysis/evaluation (Bloom L4·L5) runs only AFTER it, in the synthesis.
 */
export const RESEARCH_EARLY_ANSWER_INSTRUCTION = [
  'Research is still running. Give a short first answer now: at most 4 sentences, in the user\'s language.',
  'Only state what the partial evidence above directly says (recall and plain explanation); no scenario analysis,',
  'no weighing of alternatives, no counterarguments — a deeper pass follows after this answer.',
  'Put a source URL from that evidence in the first sentence. Say which parts are not yet confirmed.',
  'Do not call tools. Do not add facts or URLs that are not in that evidence.',
].join(' ');

/**
 * 1121 SYNTHESIS-RESERVE — time held back from research for the final synthesis, so fanout cannot spend the parent
 * turn's whole window. 출처: RES GROUNDING-MAIN2151-OP81990 (main 2151f484, 2026-11-17) — turn signal 150s, research
 * budget 120s, fanout ran to `wall-clock-budget` every run, forced synthesis started at ~120.0s: GLM 합성 ≥29.9s 미완
 * (3/3 aborted by the 150s signal) · Codex 15.7s 완료. Value = the GLM lower bound ×1.5 rounded up to whole 5s
 * (29.9s × 1.5 = 44.85s → 45s); it also covers the slowest GLM answer-class call measured in the same runs (early
 * answer without effort, 17–38s). Callers may pass their own reservation (`RunCoreTurnOptions.synthesisReservationMs`).
 */
export const RESEARCH_SYNTHESIS_RESERVATION_MS = 45_000;

export type ResearchBudgetLimit = 'research-budget' | 'synthesis-reserve';

export interface ResearchBudgetSplit {
  /** Research deadline measured from research start; never negative (research cannot end before it began). */
  researchDeadlineMs: number;
  reservationMs: number;
  limitedBy: ResearchBudgetLimit;
}

/**
 * Research stops at `min(research budget, parent deadline − reservation)`. Without a known parent deadline the
 * research budget is used unchanged. `elapsedMs` is how much of the parent window had passed when research started.
 */
export function splitResearchBudget(input: {
  researchBudgetMs: number;
  turnDeadlineMs?: number;
  elapsedMs: number;
  reservationMs?: number;
}): ResearchBudgetSplit {
  const reservationMs = Math.max(0, input.reservationMs ?? RESEARCH_SYNTHESIS_RESERVATION_MS);
  const turnDeadlineMs = input.turnDeadlineMs;
  if (turnDeadlineMs === undefined || !Number.isFinite(turnDeadlineMs)) {
    return { researchDeadlineMs: input.researchBudgetMs, reservationMs, limitedBy: 'research-budget' };
  }
  const reservedDeadlineMs = Math.max(0, turnDeadlineMs - Math.max(0, input.elapsedMs) - reservationMs);
  return reservedDeadlineMs < input.researchBudgetMs
    ? { researchDeadlineMs: reservedDeadlineMs, reservationMs, limitedBy: 'synthesis-reserve' }
    : { researchDeadlineMs: input.researchBudgetMs, reservationMs, limitedBy: 'research-budget' };
}

/** Research turns only receive these tools; unrelated writers are never implicit. */
export const RESEARCH_TOOL_ALLOWLIST = [
  'OmniSearch',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Read',
  // TUI quick-route contracts: every quick turn can recall memory, and the
  // investigation route may list (but never mutate) the seat mailbox.
  'memory_recall',
  'MsgList',
] as const;

const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(RESEARCH_TOOL_ALLOWLIST);
export const RESEARCH_DOCUMENT_WRITE_TOOLS = ['Edit', 'Write'] as const;

/** A research turn may write only when the user explicitly asks for a document at a concrete path. */
const DOCUMENT_OUTPUT_PATH = /(?:^|[\s"'\x60])(?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|txt|rst|adoc|html|json|ya?ml|csv)\b/i;
const DOCUMENT_OUTPUT_PATH_GLOBAL = /(?:^|[\s"'\x60])(?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|txt|rst|adoc|html|json|ya?ml|csv)\b/gi;
const POSITIVE_DOCUMENT_WRITE_INTENT = /\b(?:write|writes|writing|written|draft|drafts|drafting|create|creates|creating|author|authors|authoring|produce|produces|producing|save|saves|saving)\b|작성|초안|생성|기록/i;
const NEGATED_DOCUMENT_WRITE_INTENT = /\b(?:do\s+not|don['’]?t|never|must\s+not|should\s+not|avoid)\s+(?:(?:be|to)\s+)*(?:write|writes|writing|written|draft|drafts|drafting|create|creates|creating|author|authors|authoring|produce|produces|producing|save|saves|saving)\b|(?:작성|초안|생성|기록)(?:\s*(?:을|를))?\s*(?:하지\s*마|하지\s*말|하지\s*않|금지)/i;

/** A research turn may write only when the user explicitly asks for a document at a concrete path. */
export function requestsResearchDocumentWrite(text: string | undefined): boolean {
  if (!text || !DOCUMENT_OUTPUT_PATH.test(text)) return false;
  const intentText = text.replace(DOCUMENT_OUTPUT_PATH_GLOBAL, ' ');
  return POSITIVE_DOCUMENT_WRITE_INTENT.test(intentText)
    && !NEGATED_DOCUMENT_WRITE_INTENT.test(intentText);
}
export function isResearchToolAllowed(name: string): boolean {
  return RESEARCH_TOOL_NAMES.has(name);
}
