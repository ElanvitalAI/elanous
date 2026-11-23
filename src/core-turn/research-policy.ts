import { CONATUS_PACK_LABEL } from '../research/conatus-pack-evidence.js';

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
 * MK stage feedback (OP #113145): answers opened with collection-process talk ("제공된 발췌에 따르면 … 기사 원문 대조는
 * 미확인입니다 … 게시일 미확인") because the evidence trace's status lines were echoed as prose. The instruction keeps the
 * process out of the answer body; verification state belongs to structured citation fields (citation ledger), not prose.
 */
export const RESEARCH_NO_PROCESS_NARRATION_RULE = [
  'Do not narrate the evidence-collection process in the answer body: no mention of excerpts, retrieved snippets, or how the sources were gathered,',
  'and no per-source verification or publication-date status lines (claim status, primary-source status, original publication date).',
  'Present the findings directly and cite the sources; verification state is carried by structured citation fields, not by prose.',
  // JUD #113291: the 미확인 label on a claim without a matching source row is NOT process narration — it is mandatory
  // (or omit that claim). Dropping it would expose an unverified number unlabeled.
  'Exception that always wins over the rule above: a claim, number or date without a matching complete source row must keep its 미확인 label (or be left out of the answer); never state it as verified.',
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

/**
 * OP #114412 · 끝 ≤60초 — the whole research turn (research phase + synthesis) is budgeted from the research turn start.
 * 출처: OP #114412 RESEARCH-LATENCY-BUDGET — cut build 70 s (stock) / 77 s+ unfinished (semiconductor) vs a9dc LKG 41 s;
 * RES WEBCHAT-A2DF-MK-113947 (candidate a2dfb4fc) took 98 s. Code default; callers/tests may inject `researchTurnBudgetMs`.
 * 55 s → 45 s: OP #114684 · real pin 4409920b (MK #114676 · RES #114681): stock 54 s ✅, semiconductor 72 s ✗ — ~12–15 s of
 * client/stream overhead sits outside the server-side turn budget, so the server budget is cut by 10 s
 * (research deadline = budget − synthesis reserve).
 */
export const RESEARCH_TURN_BUDGET_MS = 45_000;

/**
 * Time held back inside `RESEARCH_TURN_BUDGET_MS` for the final synthesis (research phase deadline = budget − reserve).
 * 출처: OP #114412 — synthesis took 6.9 s on RES WEBCHAT-A2DF-MK-113947; 12 s covers that with headroom (budget 55 s → research phase 43 s).
 */
export const RESEARCH_TURN_SYNTHESIS_RESERVE_MS = 12_000;

/**
 * Observed web-turn generation speed used to turn the synthesis time reserve into an output-token cap.
 * 출처: OP #114563 · RES 61266 타임라인 — SEMICONDUCTOR 합성 outputChars 4,789 (≈ 3,000 토큰)이 36.9 s → ≈ 80 토큰/s.
 */
export const RESEARCH_SYNTHESIS_TOKENS_PER_SECOND = 80;

/**
 * Output-token ceiling of the final web-turn synthesis: the synthesis reserve at the observed speed
 * (12 s × 80 tok/s = 960), so a long answer cannot run past the turn budget.
 * 출처: OP #114563 · RES 61266 타임라인 (RESEARCH_TURN_SYNTHESIS_RESERVE_MS × RESEARCH_SYNTHESIS_TOKENS_PER_SECOND).
 */
export const RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS = (RESEARCH_TURN_SYNTHESIS_RESERVE_MS / 1_000) * RESEARCH_SYNTHESIS_TOKENS_PER_SECOND;

/**
 * Floor of the synthesis cap when research overran the budget: still enough for a short cited answer (about three
 * sentences). 출처: OP #114563 — RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS (1,024) covers ≤ 4 sentences; a quarter of it.
 */
export const RESEARCH_SYNTHESIS_MIN_OUTPUT_TOKENS = RESEARCH_EARLY_ANSWER_MAX_OUTPUT_TOKENS / 4;

/** Synthesis output cap from the time left in the turn budget: reserve-sized normally, shrinking when research overran. */
export function resolveResearchSynthesisMaxOutputTokens(input: { budgetMs?: number; researchElapsedMs?: number }): number {
  const { budgetMs, researchElapsedMs } = input;
  if (budgetMs === undefined || researchElapsedMs === undefined || !Number.isFinite(budgetMs)) return RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS;
  const leftMs = Math.max(0, budgetMs - researchElapsedMs);
  const byTime = Math.floor((leftMs / 1_000) * RESEARCH_SYNTHESIS_TOKENS_PER_SECOND);
  return Math.max(RESEARCH_SYNTHESIS_MIN_OUTPUT_TOKENS, Math.min(RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS, byTime));
}

/**
 * The user's explicit length/format request wins over any structure added for deep continuation (Bloom instruction).
 * Appended after that instruction in the synthesis system message; no classification of the user's text is involved.
 * 출처: OP #114563 · RES 61266 타임라인 — '세 줄로' 요청에 deep-bloom 연속 합성이 4,789자·인용 38개를 썼다.
 */
export const RESEARCH_USER_FORMAT_PRECEDENCE_RULE = [
  'If the user asked for a specific length or format (for example a number of lines, sentences, a table, or a word limit),',
  'follow that request exactly: it overrides any structure, depth or section guidance given earlier for this answer.',
  'Keep the answer compact enough to end on a complete sentence.',
  // JUD #114615 ⓑ1: the requested length never swallows the evidence markers.
  'Exception: source links and the 미확인 label are not part of the requested length — keep them as one short sources line outside it.',
].join(' ');

/** When the synthesis cap is reduced (research overran), the link requirement shrinks to this many links and the sources
 * line goes FIRST so the cap cannot cut it. 출처: JUD #114615 ⓑ1. */
export const RESEARCH_COMPACT_SOURCE_LINKS = 3;

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

/**
 * ELN-RESEARCH-TURN-SEAT-REPLY: a research turn that runs on an eln seat (the turn knows its seat) may also post and
 * acknowledge seat mail, so a mail turn like «look this up and reply to MK» can reply. Non-seat research turns (human
 * chat · PWA) keep the plain allowlist above — these two tools are never implicit there.
 */
export const RESEARCH_SEAT_MAIL_TOOLS = ['MsgPost', 'MsgAck'] as const;
const SEAT_MAIL_TOOL_NAMES: ReadonlySet<string> = new Set(RESEARCH_SEAT_MAIL_TOOLS);

/** True only for a seat's research turn and only for MsgPost/MsgAck. */
export function isResearchSeatMailTool(name: string, seat: string | null | undefined): boolean {
  return Boolean(seat) && SEAT_MAIL_TOOL_NAMES.has(name);
}

/**
 * MOB-1 FINANCE-FIRST (OP #110867): read-only market-data capability tools a research turn may call. Before this the
 * research allowlist was web-only, so a configured finance pack (finance_quote EODHD/Toss · finance_kr_flow KIS/KRX 수급 ·
 * MarketQuote · KrFlowSnapshot) was filtered out of every research/webchat turn and numbers came from web search alone.
 * Presence in the pool is still decided by the surface (financeEnabled gate · credential probes) — nothing is added here
 * that the surface did not already expose; a missing credential keeps the tool absent (→ «unavailable», never invented).
 */
export const RESEARCH_MARKET_DATA_TOOLS = ['finance_quote', 'finance_kr_flow', 'MarketQuote', 'KrFlowSnapshot'] as const;
const MARKET_DATA_TOOL_NAMES: ReadonlySet<string> = new Set(RESEARCH_MARKET_DATA_TOOLS);

export function isResearchMarketDataTool(name: string): boolean { return MARKET_DATA_TOOL_NAMES.has(name); }

/** Market-data tools present in a tool pool (names only). */
export function marketDataToolNames(tools: readonly { name: string }[]): string[] {
  return tools.filter((tool) => MARKET_DATA_TOOL_NAMES.has(tool.name)).map((tool) => tool.name);
}

/**
 * g5 CONATUS-PACK: the read-only installed knowledge-pack lookup (src/boot/installed-pack-query.ts) a research turn may
 * call. Before this the research allowlist dropped KnowledgeQuery, so webchat research could never consult an installed
 * pack (e.g. the conatus-solution Korea↔US sector map). The surface still decides presence; the tool searches installed
 * or bundled packs only (no vault), and an uninstalled pack returns an explicit `pack-not-installed` reason.
 */
export const RESEARCH_KNOWLEDGE_TOOLS = ['KnowledgeQuery'] as const;
const KNOWLEDGE_TOOL_NAMES: ReadonlySet<string> = new Set(RESEARCH_KNOWLEDGE_TOOLS);

/** The installed Conatus solution pack (Korea↔US sector map · capstone backtest rules); the prepass step reads it (g6). */
export { CONATUS_SOLUTION_PACK_ID } from '../research/conatus-pack-evidence.js';

/** Tools a research turn keeps from the surface pool even when the catalog tier deferred them (ToolSearch is not allowed). */
export function isResearchCapabilityTool(name: string): boolean {
  return MARKET_DATA_TOOL_NAMES.has(name) || KNOWLEDGE_TOOL_NAMES.has(name);
}

/** The finance-first instruction, or undefined when the pool has no market-data tool (nothing to prefer; no claim made).
 * The model judges «is this an investment/market question» by meaning; the tools only exist where the surface allows.
 * g6: the conatus-solution sector map arrives as a bounded prepass evidence section («연구 근거(코나투스)»), not as a tool
 * the model must remember to call — g5's «call KnowledgeQuery first» line was measured at 0 calls. */

export function buildMarketDataInstruction(toolNames: readonly string[]): string | undefined {
  if (toolNames.length === 0) return undefined;
  return [
    `투자·시장 질문(시세·지수·재무·수급·환율)에는 웹 검색보다 시장데이터 도구(${toolNames.join(', ')})를 먼저 호출한다.`,
    `근거에 «${CONATUS_PACK_LABEL}» 절이 있으면 그 섹터 지도(한국 섹터 ↔ 미국 ETF·핵심 종목)를 «${CONATUS_PACK_LABEL}:»로 시작하는 별도 문장으로 인용하고, 시세·수급 수치와 섞지 않는다. 그 짝 미국 티커의 수치는 시장데이터 절에 있을 때만 인용한다.`,
    '팩은 연관 섹터와 과거 연구의 근거일 뿐 지금 수치의 출처가 아니다. 팩 백테스트 수치를 인용하면 가정(ρ·기간·종목)과 ρ=0 하한을 같이 적고 «과거 연구 결과(가정 포함)»로만 말하며, 매수·매도 권유로 쓰지 않는다. 그 절이 없으면 팩 내용을 지어내지 않는다.',
    '근거에 «Social sentiment (X · Reddit)» 절의 게시물이 있으면 X·레딧 여론을 그 게시물 링크와 함께 요약한다. 결과가 없다고 적힌 플랫폼만 «검색 결과 없음»으로 말한다.',

    '시세·수급·재무 수치는 그 도구 결과에서만 인용하고, 수치마다 출처 도구/데이터 소스 이름을 붙인다.',
    '웹 검색은 맥락·뉴스 보완용이며 수치의 근거로 쓰지 않는다.',
    '도구가 실패하거나 결과가 없으면 «조회 불가»라고 말하고, 수치를 추정하거나 지어내지 않는다.',
  ].join('\n');
}

const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([...RESEARCH_TOOL_ALLOWLIST, ...RESEARCH_MARKET_DATA_TOOLS, ...RESEARCH_KNOWLEDGE_TOOLS]);
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

/** MK #110816 — a research turn's model context carries earlier assistant turns verbatim (session history). Numbers
 *  stated there were never verified against this turn's fetched evidence, yet the model quoted them as findings.
 *  Added only when the context holds a prior assistant message; the citation ledger still gates what is shown. */
export const RESEARCH_PRIOR_CLAIMS_NOTICE = [
  '<unverified-prior-claims>',
  'Assistant messages from earlier turns of this conversation are unverified prior claims, not evidence.',
  'Do not restate figures, dates or quotes from them as findings. Use a number only when this turn\'s evidence rows support it with a source;',
  'otherwise verify it via search or omit it. If you must mention a prior figure, label it 미확인.',
  '</unverified-prior-claims>',
].join('\n');
