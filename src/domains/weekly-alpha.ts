import { textOnly } from '../llm/stream-text.js';
// ── R1 · 주간 알파 추천 리포트 (2026-07-06 · ROADMAP-organic-signal-engine) ──
//
// 대표 지시: "주당 한번씩 머니무브먼트·펀더멘털·수급 변화를 가지고 매매 추천".
// 토탈 알파 — 반도체 고정 없이 자산군×국가×섹터 순환을 따라간다(BTC/SW/전력/원자재/레버리지).
//
// 구성(아침리포트 패턴 상속 — 결정론 조립 + LLM 종합, 섹션별 fail-soft):
//   ① finance_monitor  — backbone·자산군 회전·국가/섹터 매력도·13F (1콜 종합)
//   ② finance_sector   — 섹터 융합(가격 momentum × 기관 실자금)
//   ③ breaking_signals — 주간 뉴스 신호 섹터 분포 + 상위 신호 (R0 산출물)
//   ④ finance_kr_flow  — KOSPI 주간 투자자 수급
//   ⑤ conatus_position + capstone 국면 — 현 포지션·레버리지 컨텍스트 (READ-ONLY)
//   → LLM 종합: 추천 3~5건 (대상·방향·비중·레버리지·근거·무효화 조건)
//
// 거버넌스: READ-ONLY 추천 — 집행은 verify게이트+HITL+대표 승인. 노출 150% 정책 언급.
// 산출물은 ~/.elanous/conatus/alpha_reports/ 에 영속 (R3 지식레이어 인제스트 대상).

import { buildFinanceTools } from './finance-tools.js';
import { openSignalsDb, periodStats, topSignals } from './breaking-signals.js';
import { getUserConfig } from '../user-config/reader.js';
import { getProviderForConfig, anyProviderAvailable, type LLMMessage } from '../llm.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { conatusPath } from './conatus-data-dir.js';

const REPORTS_DIR = conatusPath('alpha_reports');

async function section(label: string, fn: () => Promise<unknown>, render: (r: any) => string): Promise<string> {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'error' in r) return `${label}\n- (${String((r as any).error).slice(0, 80)})`;
    return `${label}\n${render(r)}`;
  } catch (e) {
    return `${label}\n- (skip: ${e instanceof Error ? e.message.slice(0, 60) : String(e)})`;
  }
}

function clip(s: unknown, n: number): string {
  return String(s ?? '').split('\n').slice(0, n).join('\n');
}

/** 주간 신호 섹터 분포 + 상위 신호 (breaking_signals — R0). */
function breakingSection(): string {
  try {
    const db = openSignalsDb();
    const st = periodStats(db, 7);
    const top = topSignals(db, 7, 6).filter(s => Math.max(s.urgency ?? 0, s.market ?? 0, s.impact ?? 0) >= 6);
    db.close();
    if (st.total === 0) return '📡 주간 뉴스 신호\n- (신호 없음)';
    const dist = st.bySector.length ? st.bySector.map(s => `${s.sector} ${s.n}`).join(' · ') : '유의 신호 없음';
    const lines = top.map(s =>
      `- [${s.sector ?? '?'}${s.impact ?? 0}·시장${s.market ?? 0}] ${s.text.slice(0, 100)} (${s.author})`);
    return `📡 주간 뉴스 신호 (${st.total}건 판정 · 초긴급 ${st.alerted})\n섹터 분포(6+): ${dist}\n${lines.join('\n')}`;
  } catch (e) {
    return `📡 주간 뉴스 신호\n- (skip: ${e instanceof Error ? e.message.slice(0, 60) : String(e)})`;
  }
}

const ALPHA_SYSTEM = `너는 Conatus의 주간 알파 전략가다. 아래 정량 브리핑(자산군 회전·국가/섹터 매력도·섹터 융합(가격×기관 13F)·주간 뉴스 신호 섹터 분포·KOSPI 수급·현 포지션/캡스톤 국면)을 읽고 주간 매매 추천을 작성하라.

원칙:
- 토탈 알파: 반도체에 갇히지 마라. 자산군(주식/크립토/원자재/채권)·국가(US/KR/기타)·섹터(SW/전력기기/에너지 등) 어디든 머니무브먼트가 향하는 곳을 따른다.
- 브리핑에 실제로 담긴 데이터에서만 근거를 끌어라. 없는 수치·종목을 지어내지 마라. 데이터가 얇은 축은 "관찰"로 강등하라.
- 추천 3~5건. 각 건 형식:
  **N. [매수/매도/관찰] 대상 (티커/자산)** — 방향과 기간(스윙/포지션)
  근거: 머니무브먼트·펀더멘털·수급 중 어느 렌즈가 가리키는지 1~2문장
  비중: 포트 대비 % 가이드 (레버리지 쓸 경우 명시 — 계좌 노출 150% 상한 준수)
  무효화: 이 조건이 깨지면 추천 철회 (구체 가격/지표)
- 현 포지션과의 충돌/중복을 명시하라.
- 마지막 줄: "⚠️ READ-ONLY 추천 — 집행은 verify게이트+HITL+대표 승인."
- 한국어. 이모지는 헤더 정도만. 전체 900자 이내.`;

export interface WeeklyAlphaResult {
  report: string;        // 텔레그램 발송용 전체 (정량 요약 + 추천)
  savedPath: string | null;
  narrated: boolean;
}

/** 주간 알파 리포트 조립 + LLM 추천 종합. fail-soft — LLM 불가 시 정량부만. */
export async function buildWeeklyAlphaReport(): Promise<WeeklyAlphaResult> {
  const { dispatch } = buildFinanceTools();

  const [monitor, sector, krFlow, position, capstone] = await Promise.all([
    section('📊 시장 종합 (backbone·회전·매력도·13F)',
      () => dispatch('finance_monitor', {}),
      r => [
        clip(r?.backbone, 10),
        clip(r?.asset_rotation, 14),
        clip(r?.country_attractiveness, 8),
        clip(r?.sector_rotation, 8),
        clip(r?.institutional_consensus, 8),
      ].filter(Boolean).join('\n')),
    section('🔀 섹터 융합 (가격 × 기관 13F)',
      () => dispatch('finance_sector', {}),
      r => clip(r?.table ?? '', 16)),
    section('🇰🇷 KOSPI 주간 수급',
      () => dispatch('finance_kr_flow', { command: 'market-flow', target: 'KSP' }),
      r => clip(r?.report ?? '', 14)),
    section('💼 현 포지션 (READ-ONLY)',
      () => dispatch('conatus_position', {}),
      r => clip(r?.positions ?? '', 10)),
    section('🧭 캡스톤 국면',
      () => dispatch('finance_capstone', {}),
      r => `국면 ${r?.regime ?? '?'} · ${r?.leverage?.label ?? '?'} · 목표노출 ${r?.leverage?.target_exposure ?? '?'}`),
  ]);
  const breaking = breakingSection();

  const structured = [
    `🗂 주간 알파 브리핑 · ${new Date().toISOString().slice(0, 10)}`,
    '', monitor, '', sector, '', breaking, '', krFlow, '', position, '', capstone,
  ].join('\n');

  // LLM 종합 추천 (fail-soft)
  let recommendation = '';
  if (anyProviderAvailable()) {
    try {
      const provider = getProviderForConfig(getUserConfig());
      if (provider.streamChat) {
        const messages: LLMMessage[] = [
          { role: 'system', content: ALPHA_SYSTEM },
          { role: 'user', content: structured.slice(0, 14_000) },
        ];
        for await (const delta of textOnly(provider.streamChat(messages, { temperature: 0.4, maxTokens: 1100 }))) {
          recommendation += delta;
        }
        recommendation = recommendation.trim();
      }
    } catch { recommendation = ''; }
  }

  const report = recommendation
    ? `📈 주간 알파 추천 (${new Date().toISOString().slice(0, 10)})\n\n${recommendation}\n\n${'─'.repeat(24)}\n(정량 브리핑 원문은 alpha_reports/ 저장)`
    : `${structured}\n\n(LLM 종합 불가 — 정량 브리핑만 발송)`;

  // R3 지식레이어 인제스트 대상 영속 (정량+추천 전문)
  let savedPath: string | null = null;
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    savedPath = join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10)}-weekly-alpha.md`);
    writeFileSync(savedPath, `${structured}\n\n## LLM 추천\n\n${recommendation || '(불가)'}\n`);
  } catch { savedPath = null; }

  return { report, savedPath, narrated: !!recommendation };
}
