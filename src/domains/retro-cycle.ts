// ── 회고 루프 오케스트레이터 (R3 · retro-cycle · 2026-07-08) ──────────────
//
// 주/월/분기/연 회고 1회: 집계(R0)→리포트(R1)→리밸런싱 제안(R2)→저장+HITL 알림.
// 순수 오케스트레이터(deps 주입) + scripts/retro-cycle.ts 실배선. 밤·idle 리플레이.
// 대표 결정: 리밸런싱은 사전 HITL 승인(제안만·자동 적용 없음). [[ROADMAP-...]] R3.

import { aggregatePeriod, type RetroDeps, type RetroPeriod, type PeriodSummary } from './retro-aggregate.js';
import { renderReflectionMd, reflectionFilename } from './retro-report.js';
import { proposeRebalance, checkProposal, hitlNotice, type PromotionCandidate, type RebalanceProposal } from './retro-rebalance.js';
import { buildRetroFeatureProposals, renderRetroFeatureProposals, type RetroFeatureProposal, type RetroProposalSignal } from './retro-proposals.js';
import type { CheckerVerdict } from './loop-contract.js';

export interface RetroCycleDeps {
  retro: RetroDeps;                                   // R0 소스(backtest.db·regime.db·거래)
  candidates: () => PromotionCandidate[];             // 승격 후보(backtest.db promotions)
  writeReport: (filename: string, md: string) => string; // 저장 → 경로 반환
  narrate?: (summary: PeriodSummary) => Promise<string | undefined> | string | undefined; // LLM 서사 opt-in(비동기 허용)
  notify?: (text: string) => void;                    // HITL 승인 요청 발송
  featureSignals?: (from: string, to: string) => readonly RetroProposalSignal[];
  now?: () => string;
}

export interface RetroCycleReport {
  period: RetroPeriod;
  reportPath: string;
  hasProposal: boolean;
  proposalId: string;
  /** 독립 sanity check 판정(Phase C · builder≠checker 대칭). */
  sanity: CheckerVerdict;
  highlights: string[];
  featureProposals: RetroFeatureProposal[];
}

/** 회고 1회 실행(오케스트레이터). 리포트 저장 + 제안 있으면 HITL 알림. narrate 비동기 허용. */
export async function runRetroCycle(deps: RetroCycleDeps, period: RetroPeriod): Promise<RetroCycleReport> {
  const now = deps.now?.() ?? new Date().toISOString();
  const summary = aggregatePeriod(deps.retro, period, now);
  const featureProposals = buildRetroFeatureProposals(
    deps.featureSignals?.(summary.window.from, summary.window.to) ?? [],
    { from: summary.window.from, to: summary.window.to, minimumRuns: 2 },
  );
  const candidates = deps.candidates();
  const proposal: RebalanceProposal = proposeRebalance(summary, candidates);
  const sanity = checkProposal(proposal); // ★ builder(proposeRebalance)와 분리된 독립 검증
  const narrative = await deps.narrate?.(summary);
  const md = renderReflectionMd(summary, {
    narrative,
    proposalMd: proposal.proposalMd,
    featureProposalMd: renderRetroFeatureProposals(featureProposals),
  });
  const reportPath = deps.writeReport(reflectionFilename(summary), md);

  const hasProposal = proposal.deltas.length > 0;
  if (hasProposal && deps.notify) {
    // sanity 미승인이면 HITL 알림에 경고 첨부(회고는 HITL이라 차단 아님·advisory).
    const notice = sanity.approved ? hitlNotice(proposal) : `${hitlNotice(proposal)}\n\n⚠️ sanity: ${sanity.reason}`;
    deps.notify(notice);
  }

  return { period, reportPath, hasProposal, proposalId: proposal.id, sanity, highlights: summary.highlights, featureProposals };
}
