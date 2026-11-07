// ── 종합 아침 브리핑 · 밤사이 소스 종합 데이터층 (2026-07-10) ──────────────────
//
// 대표 지시: "밤사이 여기저기 쌓인 리포트들을 종합". 07:45 아침 브리핑을 즉석 테이블
// 덤프에서 "밤사이 자율 루프 산출물을 읽어 종합"으로 승격. 이 모듈은 순수 수집층 —
// 모든 소스를 하나의 구조화 번들(MorningSources)로 모으고, 렌더/LLM 종합은 상위
// (morning-detail·morning-report)이 담당한다. 소스별 fail-soft(한 소스 실패가 전체를
// 막지 않음). 재사용: collectSignalBoard(버즈/디깅/신호/회고) · finance dispatch(backbone/
// rotation/13F) · us-pulse 저장분 · kg-semis(반도체 밸류체인).

import { buildFinanceTools, omniQuote, omniUst10y } from './finance-tools.js';
import { buildMacro, formatMacroBriefing } from './macro-briefing.js';
import { openMacroDb, recordMacroSnapshot, macroTrend, formatMacroTrend } from './macro-store.js';
import { renderFinvizMap } from './finviz-map.js';
import { computeAndStoreRegime } from './regime-store.js';
import { summarizeRegime, type RegimeVector } from './regime-synth.js';
import { computeAndStoreKrSectors, computeAndStoreUsSectors } from './sector-store.js';
import { computeDislocations, renderDislocationSection } from './dislocation.js';
import { regimeTransitionContext, renderRegimeTransition } from './kg-regime.js';
import { openKgDb } from './kg-store.js';
import { collectSemisView, type SemisView } from './kg-semis.js';
import { readLatestClosePulse } from './us-pulse.js';
import { collectSignalBoard } from '../nexus/api/signal-board-api.js';
import type { SignalBoard } from './signal-board.js';
import { dateKey } from '../time/calendar.js';

export interface MorningSources {
  nowIso: string;
  dateKr: string;
  regime: RegimeVector | null;
  regimeSummary: string;     // 국면 한 줄(summarizeRegime)
  regimeRipple: string;      // 큰 전환 시 온톨로지 파장(평시 '')
  macro: string;             // 매크로 핵심 + N일 추세
  finviz: string;            // S&P 히트맵 텍스트(breadth+무버)
  backbone: string;          // 시장 backbone 풀 테이블
  rotation: string;          // 자산군 회전 풀 테이블
  country: string;           // 국가 매력도 풀 테이블
  sector: string;            // 섹터 로테이션 풀 테이블
  movers13f: string;         // 13F 컨센서스 풀 테이블
  dislocation: string;       // 센티-실측 괴리(있을 때만)
  semis: SemisView | null;   // 반도체 밸류체인(대표 관심사)
  usPulse: { date: string; report: string } | null;  // 밤사이 US 결산(06:35)
  board: SignalBoard;        // 버즈/디깅/신호/회고 통합 feed
}

/** dispatch 결과에서 지정 필드의 테이블 문자열을 안전 추출. 실패/부재 시 ''. */
async function safeTable(fn: () => Promise<unknown>, field: string): Promise<string> {
  try {
    const r = await fn();
    if (r && typeof r === 'object') {
      if ('error' in r) return '';
      const v = (r as Record<string, unknown>)[field];
      return typeof v === 'string' ? v : '';
    }
    return '';
  } catch { return ''; }
}

/** 밤사이 소스를 하나의 구조화 번들로 종합. 소스별 fail-soft. */
export async function collectMorningSources(now: Date = new Date()): Promise<MorningSources> {
  const nowIso = now.toISOString();
  const { dispatch } = buildFinanceTools();
  const dateKr = now.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });

  // 섹터 매력도(rolling) 최신화 — regime kr_sector 입력. fail-soft.
  try { computeAndStoreKrSectors(nowIso); computeAndStoreUsSectors(nowIso); } catch { /* fail-soft */ }

  // 국면 벡터 — 계산·저장. 전환 시 온톨로지 파장.
  let regime: RegimeVector | null = null;
  let regimeSummary = '';
  let regimeRipple = '';
  try {
    regime = await computeAndStoreRegime(nowIso);
    regimeSummary = summarizeRegime(regime);
    if (regime.transition) {
      try {
        const kg = openKgDb();
        try { regimeRipple = renderRegimeTransition(kg, regimeTransitionContext(kg, regime)) || ''; }
        finally { kg.close(); }
      } catch { /* fail-soft */ }
    }
  } catch { /* fail-soft */ }

  // 매크로 핵심 + 추세(regime.db 영속).
  let macro = '';
  try {
    const { items, snapshot } = buildMacro({
      quote: (s) => { const q = omniQuote(s); return q ? { close: q.close, changePct: q.changePct } : null; },
      ust10y: omniUst10y,
    });
    macro = formatMacroBriefing(items) || '';
    if (macro) {
      try {
        const mdb = openMacroDb();
        try {
          // 2026-07-24 — as_of 를 **사용자 시간대 날짜**로. 종전 `nowIso.slice(0,10)` 은
          // UTC 날짜라, 07:45 KST 크론이 쓰면 항상 하루 뒤쳐졌다(저장된 13행 중 12행이
          // 그렇게 어긋나 있었다). 게다가 같은 파이프라인의 morning-report.ts:33 은
          // KST 날짜로 S3 키를 만들어, **한 브리핑의 두 산출물이 하루 다르게 라벨링**됐다.
          recordMacroSnapshot(mdb, { asOf: dateKey(now), ...snapshot });
          const trend = formatMacroTrend(macroTrend(mdb, 5));
          if (trend) macro += `\n${trend}`;
        } finally { mdb.close(); }
      } catch { /* fail-soft */ }
    }
  } catch { /* fail-soft */ }

  // 나머지 소스 — 각 fail-soft.
  let finviz = '';
  try { finviz = (await renderFinvizMap()) || ''; } catch { /* fail-soft */ }

  const [backbone, rotation, country, sector, movers13f] = await Promise.all([
    safeTable(() => dispatch('finance_market_backbone', {}), 'table'),
    safeTable(() => dispatch('finance_trend', { scope: 'rotation' }), 'table'),
    safeTable(() => dispatch('finance_trend', { scope: 'country' }), 'table'),
    safeTable(() => dispatch('finance_trend', { scope: 'sector' }), 'table'),
    safeTable(() => dispatch('finance_13f_movers', {}), 'consensus_holdings'),
  ]);

  let dislocation = '';
  try { dislocation = renderDislocationSection(computeDislocations()) || ''; } catch { /* fail-soft */ }

  let semis: SemisView | null = null;
  try { semis = collectSemisView(); } catch { /* fail-soft */ }

  let usPulse: MorningSources['usPulse'] = null;
  try { usPulse = readLatestClosePulse({ maxAgeHours: 30 }); } catch { /* fail-soft */ }

  let board: SignalBoard;
  try { board = collectSignalBoard({ feedLimit: 40, nowIso }); }
  catch { board = { generatedAt: nowIso, regime: null, capstone: null, feed: [], bySource: {} }; }

  return {
    nowIso, dateKr, regime, regimeSummary, regimeRipple, macro, finviz,
    backbone, rotation, country, sector, movers13f, dislocation, semis, usPulse, board,
  };
}

/** feed 를 소스별로 분리(렌더/LLM 편의). */
export function feedBySource(board: SignalBoard) {
  const buzz = board.feed.filter(d => d.source === 'buzz');
  const dig = board.feed.filter(d => d.source === 'dig');
  const signal = board.feed.filter(d => d.source === 'signal');
  const reflection = board.feed.filter(d => d.source === 'reflection');
  return { buzz, dig, signal, reflection };
}
