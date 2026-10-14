// ── 종합 아침 브리핑 오케스트레이터 (P1b 2026-07-05 · 종합 개편 2026-07-10) ──────
//
// 대표 지시(2026-07-10): 아침 브리핑을 "즉석 테이블 덤프"에서 "밤사이 자율 루프 산출물을
// 종합"으로 승격. 텔레그램엔 에센셜(국면·반도체 밸류체인·미국장·섹터·버즈·밤샘종합 서사)만,
// 풀 디테일은 S3(md+html)에 쌓고 링크만 첨부.
//
// 파이프라인:
//   collectMorningSources(밤사이 소스 종합) → assembleDetailMarkdown(풀 디테일)
//   → uploadMorningReport(S3 md+html) → synthesizeEssentialBrief(LLM 서사)
//   → buildEssentialMessage(에센셜 + 링크)
// 각 단계 fail-soft: S3/LLM 실패해도 결정론 에센셜은 나간다.

import { collectMorningSources } from './morning-synthesis.js';
import { assembleDetailMarkdown, uploadMorningReport, type UploadedReport } from './morning-detail.js';
import { synthesizeEssentialBrief, buildEssentialMessage } from './morning-essential.js';
import { dashboardHeatmap, dashboardSummary } from './dashboard-data.js';

export interface MorningReportOpts {
  /** LLM 시장서사 종합 레이어(에센셜 상단). 크론은 user-config 로 opt-in(기본 on). */
  narrate?: boolean;
  /** finviz S&P 히트맵 이미지 URL — 있으면 HTML 상세 리포트에 임베드. */
  heatmapImageUrl?: string;
  /** S3 상세 리포트 업로드 여부(기본 true). 테스트는 false 로 부작용 차단. */
  upload?: boolean;
  /** 시장서사 LLM model 명시(A/B). 미지정이면 지금과 같은 기본 provider 경로(providerFor(cfg)). */
  model?: string;
}

/** 밤사이 소스를 종합한 아침 에센셜(텔레그램) 조립. 상세는 S3 링크로. */
export async function composeMorningReport(now: Date = new Date(), opts: MorningReportOpts = {}): Promise<string> {
  const src = await collectMorningSources(now);
  const md = assembleDetailMarkdown(src);

  // KST 날짜 키(07:45 KST 는 UTC 전날 22:45 — UTC 날짜와 다름).
  const kstDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  let uploaded: UploadedReport | null = null;
  if (opts.upload !== false) {
    try { uploaded = uploadMorningReport(kstDate, md, { imageUrl: opts.heatmapImageUrl }); }
    catch { uploaded = null; }
  }

  const narrative = opts.narrate ? await synthesizeEssentialBrief(md, { model: opts.model }) : '';

  // 결론-우선 상단 블록(매력도 Δ · 섹터순환 · 캡스톤) — PWA 대시보드 데이터 재사용. fail-soft.
  let heatmap = null, capstone = null;
  try { heatmap = dashboardHeatmap(); } catch { /* 결정론 에센셜은 계속 */ }
  try { capstone = dashboardSummary().capstone; } catch { /* 국면만으로 fallback */ }

  return buildEssentialMessage(src, narrative, uploaded, { heatmap, capstone });
}
