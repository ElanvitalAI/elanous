import { textOnly } from '../llm/stream-text.js';
// ── 회고 리포트 생성 (R1 · retro-report · 2026-07-08) ─────────────────────
//
// PeriodSummary(R0) → REFLECTION-<period>-<date>.md. 결정론 base(순수 렌더) +
// LLM 서사 opt-in(daily-reflection 패턴). 대표 결정: 회고=리포트+제안+HITL.
// 리밸런싱 제안은 R2(retro-rebalance)가 붙임. [[ROADMAP-...]] R1.

import type { PeriodSummary, RetroPeriod } from './retro-aggregate.js';
import { getUserConfig } from '../user-config.js';
import { getProviderForConfig, anyProviderAvailable, type LLMMessage } from '../llm.js';

const PERIOD_KO: Record<RetroPeriod, string> = { weekly: '주간', monthly: '월간', quarterly: '분기', annual: '연간' };

/** 리포트 파일명(REFLECTION-<period>-<to>.md). */
export function reflectionFilename(summary: PeriodSummary): string {
  return `REFLECTION-${summary.window.period}-${summary.window.to}.md`;
}

/** 결정론 마크다운 리포트(순수). LLM 서사는 opts.narrative 로 주입(opt-in). */
export function renderReflectionMd(summary: PeriodSummary, opts: { narrative?: string; proposalMd?: string; featureProposalMd?: string } = {}): string {
  const { window: w, backtest: b, regime: r, trades: t, highlights } = summary;
  const L: string[] = [];
  L.push(`# ${PERIOD_KO[w.period]} 회고 — ${w.from} ~ ${w.to}`);
  L.push('');
  L.push(`> 생성 ${summary.generatedAt} · READ-ONLY 관찰 · 리밸런싱은 HITL 승인 필수`);
  L.push('');

  // 핵심 관찰(deterministic)
  L.push('## 핵심 관찰');
  for (const h of highlights) L.push(`- ${h}`);
  L.push('');

  // LLM 서사(opt-in)
  if (opts.narrative && opts.narrative.trim()) {
    L.push('## 종합 서사');
    L.push(opts.narrative.trim());
    L.push('');
  }

  // 백테스팅 성과
  L.push('## 백테스팅 루프');
  L.push(`- 실험 ${b.experiments}건 · CONFIRMED ${b.confirmed} · 승격 ${b.promotions}`);
  if (Object.keys(b.byVerdict).length) {
    L.push(`- verdict: ${Object.entries(b.byVerdict).map(([v, n]) => `${v} ${n}`).join(' · ')}`);
  }
  if (b.topStrategies.length) {
    L.push('- 전략별 검증:');
    for (const s of b.topStrategies.slice(0, 5)) L.push(`  - ${s.strategy}: ${s.count}건(CONFIRMED ${s.confirmed})`);
  }
  L.push('');

  // 국면
  if (r) {
    L.push('## 국면');
    L.push(`- 현재 ${r.current} · 평균강도 ${r.meanComposite.toFixed(2)} · 전환 ${r.transitions}회 · 표본 ${r.samples}`);
    if (Object.keys(r.distribution).length) {
      L.push(`- 분포: ${Object.entries(r.distribution).sort((a, b2) => b2[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    }
    L.push('');
  }

  // 매매
  if (t && t.cycles > 0) {
    L.push('## 매매');
    L.push(`- 사이클 ${t.cycles}회 · 주문 ${t.orders}건${t.note ? ` · ${t.note}` : ''}`);
    L.push('');
  }

  // 크로스서피스 기억(미엘린) — 무엇을 발송했고 무엇이 재참조됐나.
  if (summary.surface && summary.surface.outbound > 0) {
    const sf = summary.surface;
    L.push('## 발송·기억 (미엘린)');
    L.push(`- 발송 ${sf.outbound}건 · 재참조 ${sf.recalled}건`);
    if (Object.keys(sf.byKind).length) {
      L.push(`- 종류: ${Object.entries(sf.byKind).sort((a, b2) => b2[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    }
    for (const it of sf.topImportant.slice(0, 3)) L.push(`  - [${it.kind}·${it.importance}] ${it.summary}`);
    L.push('');
  }

  // 리밸런싱 제안(R2 주입)
  if (opts.proposalMd && opts.proposalMd.trim()) {
    L.push('## 리밸런싱·목표 제안 (HITL 승인 필요)');
    L.push(opts.proposalMd.trim());
    L.push('');
  }

  if (opts.featureProposalMd && opts.featureProposalMd.trim()) {
    L.push(opts.featureProposalMd.trim());
    L.push('');
  }

  L.push('---');
  L.push(`_${PERIOD_KO[w.period]} 회고 · 페이퍼·disarmed · 실집행/리밸런싱은 대표 HITL 승인_`);
  return L.join('\n');
}

const RETRO_NARRATIVE_SYSTEM = `너는 Conatus 회고 리포트 편집자다. 아래 정량 회고(기간 집계·백테스팅·국면·매매·발송/기억)를 읽고, 이번 주기의 핵심 성과와 유의점을 한국어 2~3문장으로 종합하라.

규칙:
- 리포트에 실제로 담긴 데이터에서만 근거를 끌어라. 없는 수치·전략·이벤트를 지어내지 마라.
- 백테스팅 검증 추세(CONFIRMED/승격), 국면 전환, 발송·재참조(미엘린) 패턴 중 눈에 띄는 변화를 짚어라.
- 절대 매매 지시(사라/팔라/비중 조절)를 하지 마라. 관찰·질문·유의점만. 리밸런싱은 대표 HITL 승인.
- 담백하고 신중한 톤. 불릿·머리말 없이 문장만. 이모지 금지.`;

/** 회고 정량 리포트 위에 정성 서사(종합)를 LLM 으로 합성(morning-report 패턴).
 *  Fail-soft: provider 없거나 오류 → undefined(호출측은 정량 base 그대로). */
export async function narrateRetro(summary: PeriodSummary): Promise<string | undefined> {
  if (!anyProviderAvailable()) return undefined;
  try {
    const provider = getProviderForConfig(getUserConfig());
    if (!provider.streamChat) return undefined;
    const base = renderReflectionMd(summary); // 서사 없는 정량 base 를 입력으로
    const messages: LLMMessage[] = [
      { role: 'system', content: RETRO_NARRATIVE_SYSTEM },
      { role: 'user', content: base },
    ];
    let text = '';
    for await (const delta of textOnly(provider.streamChat(messages, { temperature: 0.3, maxTokens: 320 }))) {
      text += delta;
    }
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}
