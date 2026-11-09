// ── Autonomous opportunity analysis (P5b, 2026-07-05) ──────────────────
//
// The "arm" half of the Layer-2 loop: take a high-severity OpportunitySignal
// from the policy (finance-opportunity.ts) and run ONE bounded autonomous
// analysis turn to investigate it. The agent has Bash + WebSearch (via
// makeContinuationRunTurn), so it can query the local DBs and — crucially —
// WebSearch the "why" (recent events/news behind the divergence), then
// synthesise a cautious read.
//
// SAFETY (P5c): analysis-only. The agent surface here carries NO trade/
// execution tools, and the prompt hard-forbids trade directives. This runner
// is only reached when finance.autoLoop.enabled is true OR an operator passes
// --arm-once; disarmed is the default. Bounded to one turn per signal.

import type { UserConfig } from '../user-config/types.js';
import { makeContinuationRunTurn } from '../dispatch/continuation-turn-runner.js';
import type { OpportunitySignal } from './finance-opportunity.js';

export interface OpportunityAnalysis {
  subject: string;
  kind: string;
  headline: string;
  /** The agent's synthesised analysis text (empty on failure). */
  analysis: string;
  usedTokens?: number;
  error?: string;
}

const GUARDRAIL =
  '\n\n[제약] 관찰·유의점·질문만. 매매 지시(사라/팔라/비중) 금지. 실측(backbone/가격)이 1급 근거·13F는 45일 지연·센티는 color-only. ' +
  '최근 촉발 이벤트는 WebSearch로 확인하고 출처를 밝혀라. 한국어 5~8문장.';

/** Run one bounded autonomous analysis for a single opportunity signal.
 *  Never throws — failures come back as { error }. */
export async function runOpportunityAnalysis(
  signal: OpportunitySignal,
  cfg: UserConfig,
  runTurn?: (prompt: string) => Promise<{ text: string; usedTokens?: number }>,
): Promise<OpportunityAnalysis> {
  const run = runTurn ?? makeContinuationRunTurn(cfg);
  // The signal already carries the numbers, so the agent spends its turn on
  // the WHY (WebSearch) rather than re-fetching. suggestedFocus is the task.
  const prompt = `${signal.suggestedFocus}\n\n현재 수치: ${signal.detail}${GUARDRAIL}`;
  try {
    const res = await run(prompt);
    return {
      subject: signal.subject,
      kind: signal.kind,
      headline: signal.headline,
      analysis: (res.text ?? '').trim(),
      usedTokens: res.usedTokens,
    };
  } catch (err) {
    return {
      subject: signal.subject,
      kind: signal.kind,
      headline: signal.headline,
      analysis: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Render one analysis as a report section. */
export function renderOpportunityAnalysis(a: OpportunityAnalysis): string {
  const head = `\n🔎 *자율 기회분석* — ${a.headline}`;
  if (a.error) return `${head}\n  (분석 실패: ${a.error.slice(0, 80)})`;
  if (!a.analysis) return `${head}\n  (빈 응답)`;
  return `${head}\n${a.analysis}`;
}
