import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── Finance domain pack — first-class tools (A1, 2026-07-05) ────────
//
// Upgrades the Bash-ad-hoc queries the T1 agent ran (sqlite/scripts,
// error-prone: wrong invocation, missing paths) into structured tools
// with clean return shapes. Registered into the telegram agent's tool
// surface ONLY when the finance pack is enabled (src/telegram-agent.ts).
// Read-only; no execution tools here (trade = verify+HITL flow, not a
// tool). Each dispatch fails soft — returns {error} instead of throwing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { knowledge13fDbPath } from './sec-13f.js';
import { join } from 'node:path';
import { openBacktestDb, listExperiments, latestResult, BACKTEST_DB_PATH } from './backtest-store.js';
import { dashboardLoops } from './dashboard-data.js';
import { summarizePaper } from './backtest-paper.js';
import { oosStats, gateConfidence } from './backtest-oos.js';

import { computeDislocations, renderDislocationSection } from './dislocation.js';
import { computeSectorFusion, renderSectorFusion } from './sector-fusion.js';
import { evaluateOpportunities, renderOpportunities } from './finance-opportunity.js';
import { computeAbcdeSignals, fetchLiveQuote, fetchEodCloses, decideTarget } from './capstone-signals.js';
import { fetchTossQuote } from './toss-quote.js';
import { marketQuote, formatMarketQuote } from './market-quote.js';
import { decideLeverage, allocateLegs } from './capstone-leverage.js';
import { listActiveOverrides, resolveCapstoneRegime, addOverride, cancelOverride, type OverrideKind } from './capstone-override.js';
import { evaluateKoruSwing, formatOrderPlan } from './koru-trailing.js';
import { conatusEnv, CONATUS_DIR } from './conatus-env.js';
import { dispatchKrFlow, buildKrFlowTool } from '../skills/tools/kr-flow.js';
import { marketSessions } from './finance.js';
import { knowledgeDbPath, openKnowledgeDb, queryKnowledge, renderKnowledgeMatches, knowledgeStats } from './knowledge.js';
import { openKgDb, listNodes, getEdges, getNode } from './kg-store.js';
import { recallCluster, recallHybrid } from './kg-recall.js';
import { blastRadius } from './kg-infer.js';
import { screenerPreset, formatScreenerRows, parseScreenerJson } from './screener-presets.js';
import { getUserConfig } from '../user-config/reader.js';
import { loadFullPanel, backtest as conatusBacktest, factorResearch as conatusFactorResearch } from './conatus-backtest.js';
import { runScreens, reportMd as conatusScreenReportMd } from './conatus-screen.js';
import { computeTrend, render as conatusTrendRender } from './conatus-trend.js';
import { dateKey } from '../time/calendar.js';
import { conatusDataDir } from './conatus-data-dir.js';

const HOME = homedir();
const X_ASSET_DB = join(HOME, '.claude/skills/apify-x-asset-sentiment/data/x_asset.db');
const SCORES_DB = join(HOME, '.cache/asset-attractiveness/scores.db');
const ASA_SKILL = join(HOME, '.claude/skills/asset-attractiveness');
const CONATUS = CONATUS_DIR;  // 단일 출처(conatus-env·dated-path landmine 근본수정 2026-07-22)
/** elanous 소유 Conatus 데이터(백필 DB/캐시 물리이전, 2026-07-06). backtest/backfill이
 *  CONATUS_DATA_DIR로 읽는다(data.py/db.py env 지원). 없으면 스크립트가 자기 위치 fallback. */
const ELANOUS_CONATUS = conatusDataDir();  // 2026-07-24 — 하드코딩 제거(#5262 리뷰): backtest/backfill 이 cwd 로 쓰므로 테스트 격리 대상이다.
/** ⛔ 절대경로를 박지 않는다 — 이 상수는 ***꾸러미에 실려서 남의 기계에서 돌아간다.***
 *  📏 2026-09-21 실측: `bun pm pack` 한 tgz 의 4,378 파일 중 94개가 `/Users/user` 을 담았고,
 *     `src/` 의 여섯 중 ***이 한 줄만 «살아 있는 코드»***였다(나머지 다섯은 참조 경로 주석).
 *  ⭐ 이 파일의 이웃은 전부 `join(HOME, …)` 이다 — 이것만 예외였다.
 *     그리고 선례도 같은 파일에 있다: `ELANOUS_CONATUS = conatusDataDir()` (2026-07-24 하드코딩 제거 `#5262`).
 *  ⇒ 홈 상대로 두고, 다른 자리에 둔 사람은 env 로 덮는다. */
const REGION_DIR = process.env.ELANOUS_REGION_REPORTS_DIR?.trim()
  || join(HOME, 'obsidian/ElanvitalAI/40. Project/EMBA_Field_Project/Crawling/X-regions');
const PANEL_DIR = join(HOME, '.claude/skills/attractiveness-panel/panels');
const OMNI_SKILL = join(HOME, '.claude/skills/omni-market');
const OMNI_MAIN = join(OMNI_SKILL, 'scripts/main.ts');

/** finance_alerts 가 read-only `--status`/`--gap` 로 조회하는 Conatus 알림 뷰
 *  (P7a). SoT — 뷰가 늘면 여기만 고치면 finance_alerts.test 의 개수 단언이
 *  자동 추종한다(매직넘버 드리프트 방지). 스크립트 4종이지만 koru_tp_alert 는
 *  --status(익절/지지) + --gap(월요일 갭예측) 2뷰라 총 5뷰.
 *  ⚠️ 안전: 각 스크립트의 --status/--gap 분기는 print 후 return(주문/매도 경로
 *  미진입). lev_stop 만 집행 스크립트지만 --status 는 조회 후 early-return(무인자
 *  실행에서만 자동매도) — 여기서는 항상 --status 로만 부른다. */
export const FINANCE_ALERT_VIEWS: ReadonlyArray<{ s: string; label: string; args: string[] }> = [
  { s: 'swing_alert', label: '스윙 급변동(KORU/COIN)', args: ['--status'] },
  { s: 'koru_tp_alert', label: 'KORU 익절/지지 레벨', args: ['--status'] },
  { s: 'koru_tp_alert', label: 'KORU 월요일 갭 예측(EWY)', args: ['--gap'] },
  { s: 'lev_stop', label: '레버리지 스톱(집행 스크립트·조회만)', args: ['--status'] },
  { s: 'catalyst_watch', label: '촉매/이벤트', args: ['--status'] },
];

/** Region → objective anchor symbols. index routes to Yahoo (free, global) via
 *  omni-market; fx is an EODHD forex pair. US is USD-based so no fx pair. */
const REGION_ANCHORS: Record<string, { name: string; index: string; fx?: string }> = {
  US: { name: '🇺🇸 US (S&P 500)', index: 'GSPC.INDX' },
  KR: { name: '🇰🇷 Korea (KOSPI)', index: 'KS11.INDX', fx: 'USDKRW.FOREX' },
  JP: { name: '🇯🇵 Japan (Nikkei 225)', index: 'N225.INDX', fx: 'USDJPY.FOREX' },
  CN: { name: '🇨🇳 China (Shanghai Comp)', index: 'SSEC.INDX', fx: 'USDCNY.FOREX' },
  EU: { name: '🇪🇺 Europe (DAX)', index: 'GDAXI.INDX', fx: 'EURUSD.FOREX' },
  BR: { name: '🇧🇷 Brazil (Bovespa)', index: 'BVSP.INDX', fx: 'USDBRL.FOREX' },
  IN: { name: '🇮🇳 India (Sensex)', index: 'BSESN.INDX', fx: 'USDINR.FOREX' },
  ZA: { name: '🇿🇦 South Africa (JSE All Share)', index: '^J203.JO', fx: 'USDZAR.FOREX' },
};

/** finance.conatusNativePort flag — 파리티 검증된 Conatus TS 포트로 라우팅할지.
 *  LAZY 읽기(buildFinanceTools 시그니처 불변): dispatch 시점에 user-config 를 읽되
 *  fail-soft — config 읽기가 던지면 false(python 경로) 로 폴백해 라이브 불변 보장. */
export function conatusNativePortEnabled(): boolean {
  try {
    return getUserConfig().finance?.conatusNativePort === true;
  } catch {
    return false;
  }
}

/** Run omni-market (npx tsx — Node native, NOT bun). Fail-soft: returns '' on error. */
function omniMarket(...args: string[]): string {
  try {
    return execFileSync('npx', ['tsx', OMNI_MAIN, ...args],
      { cwd: OMNI_SKILL, env: process.env, encoding: 'utf-8', timeout: 45_000, maxBuffer: 4_000_000 }).trim();
  } catch { return ''; }
}

/** Latest close + daily %change + 오늘 세션 고가 via `quote --json` (works for
 *  indices AND fx pairs — all return {close, change_p, high}). `high` = EODHD
 *  real-time 의 당일 고가(트레일링 highwater 교정에 사용). Fail-soft null. */
export function omniQuote(symbol: string): { close: number; changePct: number; high: number; previousClose: number } | null {
  const out = omniMarket('quote', symbol, '--json');
  const m = /\{[\s\S]*?"close"[\s\S]*?\}/.exec(out);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.close !== 'number') return null;
    const high = Number(j.high);
    const prev = Number(j.previousClose);
    return { close: j.close, changePct: Number(j.change_p) || 0, high: high > 0 ? high : j.close, previousClose: prev > 0 ? prev : j.close };
  } catch { return null; }
}

/** 미 10년물 최신 수익률(%) via omni-market `ust`. tenor='10Y' 최신 date. Fail-soft null. */
export function omniUst10y(): number | null {
  const out = omniMarket('ust', '--json');
  const m = /\{[\s\S]*"data"[\s\S]*\}/.exec(out);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const rows = (Array.isArray(j.data) ? j.data : []).filter((r: any) => r?.tenor === '10Y');
    if (!rows.length) return null;
    rows.sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    const rate = Number(rows[rows.length - 1].rate);
    return rate > 0 ? rate : null;
  } catch { return null; }
}

/** Symbol → sector preset (mirrors the attractiveness-panel SKILL.md mapping).
 *  Unmapped symbols fall back to the sector-agnostic _default panel. */
const SYMBOL_SECTOR: Record<string, string> = {
  '005930.KO': 'semis', '000660.KO': 'semis',
  '097950.KO': 'food-bio', '373220.KO': 'battery',
};

/** Reject anything that isn't a plain symbol/preset token — these are
 *  interpolated into read-only SQL, so keep them to a safe charset. */
const safeToken = (s: string, extra = '') =>
  new RegExp(`^[A-Za-z0-9.${extra}]{1,24}$`).test(s);

function sqlite(db: string, query: string): string {
  return execFileSync('sqlite3', ['-header', '-column', db, query], {
    encoding: 'utf-8', timeout: 15_000, maxBuffer: 2_000_000,
  }).trim();
}

function runConatus(script: string, ...args: string[]): string {
  return execFileSync('python3', [join(CONATUS, 'screener', script), ...args], {
    cwd: CONATUS, encoding: 'utf-8', timeout: 30_000, maxBuffer: 1_000_000,
  }).trim();
}

const FINANCE_TOOL_SPECS: LLMToolSpec[] = [
  {
    name: 'finance_market_backbone',
    description: 'Latest asset-class market backbone signals (deterministic, X-lag-free) from the local sentiment DB. Use FIRST for 동향/센티먼트/risk-on-off questions. Returns bonds/cash/commodities/crypto/equities/gold with score(-100..100)/direction/confidence. NOTE: asset-class only — no regions or individual stocks here.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_attractiveness',
    description: 'Attractiveness score for a stock from the local scores.db (semis=005930.KO 삼성/000660.KO 하이닉스, food-bio=097950.KO CJ, battery=373220.KO LGES, auto-mobility, bio-pharma, finance). The DB read is fast but can be days old (a daily refresh keeps it current); the tool flags staleness. Set fresh:true to recompute TODAY on demand (slower, ~1min) — use when the exact current score matters.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'EODHD symbol e.g. 005930.KO. Omit to list the top rows for the preset.' },
        preset: { type: 'string', description: 'semis|food-bio|battery|auto-mobility|bio-pharma|finance|cross-asset-global. Default semis.' },
        fresh: { type: 'boolean', description: 'Recompute today\'s score live (needs symbol). Default false = fast DB read.' },
      },
      required: [],
    },
  },
  {
    name: 'finance_trend',
    description: 'Time-series TREND / history over the accumulated 5-year data (reliable, no API). scope="asset" → market backbone trend for an asset class (key=equities/crypto/bonds/commodities/gold/cash). scope="attractiveness" → a stock\'s score history (key=symbol e.g. 005930.KO, preset=semis). scope="rotation" → latest cross-asset ranking (자산군 자금회전). scope="country" → 국가 매력도 랭킹(US/JP/KR/CN/DE/EU/BR/IN/ZA). scope="sector" → US GICS 11섹터 로테이션 매력도(가격 기반 · finance_13f_sectors 기관자금과 상보). Use for "추세 / 회전 / 국가 랭킹 / 섹터 로테이션" questions.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: "'asset' | 'attractiveness' | 'rotation' | 'country' | 'sector' (default rotation)." },
        key: { type: 'string', description: "asset class (equities/gold/…) for scope=asset, or symbol (005930.KO) for scope=attractiveness." },
        preset: { type: 'string', description: 'preset for scope=attractiveness (default semis).' },
        days: { type: 'number', description: 'lookback window (default 90, 7–730).' },
      },
      required: [],
    },
  },
  {
    name: 'conatus_position',
    description: "READ-ONLY status of the user's live Conatus trading system: current positions (vs expected manifest) + risk-gate invariants. Never executes anything. Use for '내 포지션/노출/리스크게이트' questions.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_screener',
    description: 'US 종목 스크리너(EODHD /screener). preset 또는 filters 로 미국 시장 스크리닝 → 상위 매치(코드·1일/5일%·시총·섹터). preset: us-gainers(대형 상승)·us-losers(대형 하락)·us-momentum(5일 모멘텀)·us-value(배당가치). "미국 종목 스크리닝 / 오늘 급등주 / 모멘텀 종목 / 배당주 스크린" 류에 사용. 스크리닝=관찰 · 매매는 verify+HITL.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', description: 'us-gainers | us-losers | us-momentum | us-value (기본 us-gainers).' },
        filters: { type: 'string', description: '고급 — EODHD 필터 JSON([["field","op",value],...]). 지정 시 preset 무시.' },
        limit: { type: 'number', description: '결과 수(기본 15·최대 50).' },
      },
      required: [],
    },
  },
  {
    name: 'finance_13f',
    description: "Hedge-fund / institution 13F portfolio from SEC EDGAR (free, reliable): top holdings + quarter-over-quarter MOVES (new buys / sold-out / size changes = money movement). Give a fund name (berkshire, bridgewater, scion=Michael Burry, ark, or any 13F filer) or a raw CIK. Live SEC fetch (~5-10s, 45-day filing lag). US institutions only.",
    parameters: {
      type: 'object',
      properties: { fund: { type: 'string', description: 'Fund name (e.g. berkshire, scion) or numeric CIK.' } },
      required: ['fund'],
    },
  },
  {
    name: 'finance_13f_movers',
    description: 'Cross-fund CONSENSUS from the accumulated 13F knowledge DB (~/.elanous/knowledge_13f.db, populated by the periodic 13f ingest): which issuers are held by the MOST funds in their latest filing. Use for "여러 헤지펀드가 공통 보유/매수한 종목". Complements finance_13f (single fund) with the aggregate picture. Fast (local DB).',
    parameters: { type: 'object', properties: { min_funds: { type: 'number', description: 'min distinct funds holding (default 2).' } }, required: [] },
  },
  {
    name: 'finance_13f_sectors',
    description: 'SECTOR-level money movement across ALL tracked 13F funds (knowledge.db): QoQ net inflow/outflow rolled up by GICS sector (from the cached dim_security classifier) + the latest-quarter sector allocation. Use for "섹터별 자금이동 / 어느 업종으로 기관자금이 돈다". This is the aggregate/rotation view — the third money-movement lens after finance_13f (one fund) and finance_13f_movers (consensus names). Pass sector="Energy" (or any GICS sector name) to DRILL DOWN into the individual issuers driving that sector\'s QoQ flow ("Energy 순유입 누가 이끌었나"). Fast (local DB). Reports classification coverage so undecided flow ("Unknown") is never hidden.',
    parameters: {
      type: 'object',
      properties: { sector: { type: 'string', description: 'GICS sector name (e.g. Energy, Technology, Financial Services) to list its driving issuers. Omit for the sector-level rollup.' } },
      required: [],
    },
  },
  {
    name: 'finance_panel',
    description: "Expert-PANEL deliberation factsheet for a stock (A3 심의). Returns the sector-specific expert roster (semis 15명 / food-bio 12 / battery 12 / _default 10 · each persona owns one capstone tier with a consensus_weight) + the live attractiveness framework score with per-tier breakdown. YOU (the agent) then run the deliberation: for each persona judge action(BUY/HOLD/SELL)+confidence from their frame and their tier's current score, then report the WEIGHTED consensus (action_score = Σ weight×confidence×sign) + key agreements/divergences. Use for '패널 분석 / 전문가 패널 의견 / 기관 합의 / 종합 의견'. Deterministic factsheet (local skill JSON + scores.db) — no live spawn.",
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'EODHD symbol e.g. 005930.KO(삼성)/000660.KO(하이닉스)/097950.KO(CJ)/373220.KO(LGES).' },
        preset: { type: 'string', description: 'Override sector preset (semis|food-bio|battery). Default inferred from symbol.' },
        mode: { type: 'string', description: "'investor'(default) or 'buyback'(자사주, semis만 전용 8인 패널).' " },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'finance_region',
    description: 'Region/country view (US/CN/JP/KR/EU/BR/IN/ZA). WITHOUT region → the full X-derived sentiment dashboard (🟢강세/🔴약세/🟡중립 + key issues, color only). WITH region="JP" (etc) → that country\'s sentiment color ANCHORED to OBJECTIVE market data: the benchmark index level + daily %change and the USD FX rate (live via omni-market). Use region= for "일본/브라질 시장 지금 어때" — the objective anchor corrects the X-sentiment (which alone is color-only, validated worse-than-random).',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'US|CN|JP|KR|EU|BR|IN|ZA — attaches objective index/FX anchor for that country. Omit for the full sentiment dashboard.' },
        date: { type: 'string', description: 'YYYYMMDD KST. Omit for the latest available.' },
      },
      required: [],
    },
  },
  {
    name: 'finance_monitor',
    description: "SINGLE-CALL combined market snapshot (P3a 종합 모니터링). Gathers, in one shot: asset-class backbone + 자산군 회전(top/bottom) + 국가 매력도 + 섹터 로테이션 + 13F 기관 컨센서스. Use FIRST for broad '지금 시장 종합 어때 / 오늘 전반 / 큰 그림' questions — one call instead of 5 separate tools. For a specific slice (한 자산군 시계열, 특정 종목, 한 국가 앵커) call the focused tool instead. Read-only, each section fail-soft.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_dislocation',
    description: "Dislocation 탐지(P3b): 자산군별로 결정론 backbone(실측·market_yahoo)과 X-크라우드 센티(tweets_md_score)가 얼마나 어긋나는지. 부호 반대·큰 gap = '크라우드와 시장이 다른 이야기' → 관찰 포인트(매매 신호 아님·backbone이 1급). Use for '괴리/디스로케이션/센티 vs 실측/크라우드 과열·공포/어디가 이상' 질문. Read-only, fail-soft. 센티가 신선해야 유효(collect-x-sentiment scoring).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_capstone',
    description: "캡스톤 레버리지 운영안 §4.1 통합 LV형(READ-ONLY 판단·주문 없음). ABCDE 신호(A 원화약세·B 동적DD·C R3회복·D PSD 미국4신호·E 충격반등슬리브)를 omni-market 실데이터로 산출 → 국면 판정 → 권장 레버리지 배수 + KRX ETF 합성비율(본주+2×레버/인버스+cash). 국면: 강세/중립 1.5× · 약세R3회복 1.75× · 약세비회복 -0.25× · PSD K≥2 -1.25×. Use for '캡스톤 레버리지 국면/삼성 LV 몇배/지금 배수/ABCDE 신호/레버리지 운영안'. 삼성전자 005930 단일종목. 실집행은 verify게이트+HITL 별도(에이전트 주문 못 냄). netAssetKrw 주면 leg별 금액분해.",
    parameters: { type: 'object', properties: { netAssetKrw: { type: 'number', description: '순자산(KRW). 주면 각 leg(본주/레버/인버스/cash) 목표 금액분해 포함.' } }, required: [] },
  },
  {
    name: 'finance_capstone_override',
    description: "캡스톤 자동 신호 위에 대표(사람) 재량 오버라이드를 걸고/조회/취소 — **우선순위 사람>자동**. 베어장 판단·매수 시점·진입 금지·홀드를 자동 ABCDE보다 우선 적용. kind: force_regime(regime=BULL/BEAR 국면강제)·arm_entry(매수 무장)·block_entry(진입 금지)·hold_position(현 포지션 홀드)·pause_auto(자동 정지). scope: next_decision·until_date(expiresAt=YYYY-MM-DD)·until_event(event)·until_cancelled. Use for '베어장으로 봐/강세로 보고 매수해/7/11까지 진입금지/이번 포지션 홀드/자동 멈춰/오버라이드 목록/취소'. SQLite 감사(~/.elanous/conatus/capstone.db). 저장·조회만·주문 없음(집행은 verify+HITL).",
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['set', 'list', 'cancel'], description: 'set(추가)·list(active 조회)·cancel(취소)' },
      kind: { type: 'string', enum: ['force_regime', 'arm_entry', 'block_entry', 'hold_position', 'pause_auto'], description: 'set 시 오버라이드 종류' },
      regime: { type: 'string', description: 'force_regime 시 BULL 또는 BEAR' },
      scope: { type: 'string', enum: ['next_decision', 'until_date', 'until_event', 'until_cancelled'], description: '유효 범위(기본 until_cancelled)' },
      expiresAt: { type: 'string', description: 'until_date 시 YYYY-MM-DD' },
      event: { type: 'string', description: 'until_event 시 이벤트명(예: 삼성 잠정실적)' },
      reason: { type: 'string', description: '대표 근거(감사·설명)' },
      priority: { type: 'number', description: '충돌 시 우선순위(높을수록 먼저·기본 0)' },
      id: { type: 'string', description: 'cancel 시 대상 오버라이드 id' },
    }, required: ['action'] },
  },
  {
    name: 'finance_backtest',
    description: "가격기반 신호 정직 백테스트(READ-ONLY 연구·검증도구). Conatus backtest.py/factor_research.py를 elanous 소유 데이터(~/.elanous/conatus: screener.db + bulk EOD 캐시)로 실행. 신호(대세후보·상승율상위·상한가·아웃퍼포머)의 forward 수익을 익일시가 진입 ρ=0 정직체결로 시장 대비 초과수익 평가(룩어헤드 방지). factor=true면 factor_research.py(저변동성+단기반전 5분위 롱숏). Use for '백테스트/신호 검증/전략 성과/알파 확인/팩터 IC'. 주문 없음·비실시간 연구용.",
    parameters: { type: 'object', properties: { factor: { type: 'boolean', description: 'true면 factor_research.py(저변동·단기반전 팩터). 기본 backtest.py.' } }, required: [] },
  },
  {
    name: 'finance_kfutures',
    description: "KOSPI200 선물(근월물) 실시간 현재가(P7c 이관·READ-ONLY·KIS OpenAPI). 장 사이(정규 15:45~야간 18:00·야간 05:00~주간 09:00)엔 데이터 공백 가능. KR 개장 전/야간 방향 참고용(context recipe의 '선물' 신호). Use for '코스피200 선물/K200 선물/선물 현재가/야간 선물'. 조회 전용·주문 없음. fail-soft.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_quote',
    description: "⭐ 통합 시세 — 심볼+마켓클락(세션·휴일) 보고 **그 순간 맞는 API 자동선택**. **모든 가격 질문의 단일 권위 도구**(omni-market/kr-flow 직접 호출보다 이걸 우선). KR 주식은 정규/NXT 진행중이면 토스 라이브(omni Yahoo·한투 J코드는 NXT 미커버라 직전 종가), US 주식은 ET세션 EODHD·주간거래(Blue Ocean) 토스, 지수/FX는 omni. 출처·세션·신선도(실시간/종가)·휴일 catch-up(예: US 휴장 다음날 US상장 한국ETF는 여러날 반영)까지 라벨. Use for '삼성 현재가/KORU 시세/지금 얼마/코스피 지수' 등 모든 시세. fail-soft.",
    parameters: { type: 'object', properties: { symbol: { type: 'string', description: '심볼(005930.KO·005930·KORU.US·KS11.INDX·USDKRW.FOREX 등)' } }, required: ['symbol'] },
  },
  {
    name: 'finance_koru_swing',
    description: "별도계좌 KORU 550주 스윙 운영안(§1 익절 래더 + §4 동적 트레일링 손절·READ-ONLY). 현재가로 최근 고가(highwater) 추적 → 손절선을 **동적 갱신**(고가 −5%/−8%/−11.5% 3단·본전 $539.5 아래 금지)·주가가 오르면 손절선도 따라 상향. 익절 래더(시나리오C): $655(25주)/$680(35)/$700(40)→450 유지/$750(50)/$800(150)→250 코어 — 현재가가 레벨 돌파 시 해당 물량 익절 트리거. Use for 'KORU 스윙/손절 레벨/익절 래더/트레일링/지금 몇 주 팔아/KORU 현재 판단/목표 6.93억'. current 미지정 시 omni-market KORU 시세 자동조회. 주문 없음·실 매도는 verify+HITL 승인.",
    parameters: { type: 'object', properties: { current: { type: 'number', description: 'KORU 현재가(USD). 생략 시 omni-market(KORU.US) 자동조회.' } }, required: [] },
  },
  {
    name: 'finance_verify_gate',
    description: "매매 verify 하드게이트 상태(P8c·READ-ONLY·fail-closed): Conatus 검증 사다리 3관문(리스크 불변식 본전/손절·포지션 정합 브로커대조·주문 체결 정합)을 실행해 CLEARED/BLOCKED 판정. 3관문 전부 exit0일 때만 CLEARED — 브로커 조회 실패·no-creds도 BLOCKED(검증 못 하면 거부). Use for '매매 게이트/검증 통과했나/지금 매매해도 되나/리스크 확인'. ⚠️ 게이트 상태 조회만·주문 집행 절대 없음. 실 매매는 게이트 CLEARED + 사람(HITL) 승인 필수(에이전트는 주문 못 냄).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_signals',
    description: "Conatus 데이터/신호 스크립트 조회(P7b 이관·read-only). kind: sector_flow(한국 KIS 업종지수+미국 SPDR 세부 섹터 자금흐름)·trend(일별 추세 신호 — 신규진입/이탈·연속 와칭·외국인 연속순매수)·screen(KOSPI+KOSDAQ 스크리닝 규칙엔진 — 모멘텀 와칭 등)·factor(저변동성+단기반전 팩터 연구). Use for '섹터 자금흐름/추세 신호/오늘 스크리닝/급등주 와칭/팩터'. 리포트 반환·발송 없음(screen은 --no-send). KIS 의존(sector_flow)은 세션 없으면 fail-soft. 매매는 verify+HITL.",
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', description: 'sector_flow | trend | screen | factor' } },
      required: ['kind'],
    },
  },
  {
    name: 'finance_alerts',
    description: "Conatus 알림 5뷰 현재 상태(P7a 이관·스크립트 4종): 스윙 급변동(KORU/COIN)·KORU 익절/지지 레벨·KORU 월요일 갭 예측(EWY)·레버리지 스톱·촉매/이벤트를 read-only `--status`/`--gap`으로 조회. Use for '지금 알림 상태/걸린 알림/스윙 어때/스톱 근처/촉매 임박/월요일 갭' 질문. 실 알림은 크론이 /v1/outbound(L5)로 발송하고, 이 도구는 온디맨드 현황 조회. 주문/발송 없음(조회 전용)·매매는 verify+HITL. Read-only, 스크립트별 fail-soft.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_opportunity',
    description: "기회 신호 보드(P5a 자율루프 정책): 현재 시장에서 '자율 분석할 가치가 있는' 기회를 종합 — dislocation(센티 vs 실측 괴리)+섹터 발산(가격 vs 기관자금)을 심각도로 랭킹하고, high-severity(⚙️자율분석 후보)엔 자율 goal이 실행할 분석 프롬프트(suggestedFocus)를 붙임. Use for '지금 주목할/기회/이상 신호/뭘 봐야 하나/자율분석 후보' 질문. 탐지 전용(자동 기동 아님·매매 아님·verify+HITL). Read-only, fail-soft.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_sector',
    description: "섹터 융합 뷰(P3c 심화): 11 GICS 섹터를 두 렌즈로 교차 — 가격 momentum(sector-global 로테이션 rank)과 기관 실자금(13F QoQ net_B)을 자산군 dislocation처럼 섹터 단위로 융합. 분류: 확증(가격강+기관매수)·분산(가격강+기관매도·주의)·축적(가격약+기관매수·스마트머니 선행)·동반약세. 발산(분산/축적)이 핵심 인사이트. Use for '섹터 종합/어느 섹터/섹터 로테이션 vs 기관/기관이 담는 섹터/가격과 기관 괴리' 질문. finance_trend(scope:sector)=가격만·finance_13f_sectors=기관만인데 이건 둘을 합침. Read-only, fail-soft.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finance_knowledge',
    description: "과거 유사국면 벡터 검색(R3 지식레이어·READ-ONLY): 유의 뉴스신호(6+)·심층 디깅 리포트·주간 알파 리포트를 임베딩해 영속한 knowledge.db에서 시맨틱 검색. Use for '과거 유사사례/전에 비슷한 일/지난번 OSP 인상 때/과거 이 섹터 신호' 질문 — 현재 신호에 과거 맥락을 붙일 때. kind로 signal|dig|alpha 필터, sector로 섹터 태그(semis|energy|crypto 등) 필터 가능. 임베딩=로컬 LM Studio(폴백 OpenAI)·일1회 크론 인제스트. 90일 휘발되는 raw와 달리 여긴 영속. 매매는 verify+HITL.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '유사국면을 찾을 자연어 질의 (예: "사우디 OSP 인상 에너지주 영향").' },
        k: { type: 'number', description: '반환 건수 1~20 (기본 5).' },
        kind: { type: 'string', description: 'signal(뉴스신호)|dig(디깅)|alpha(주간알파)|outbound(내가 발송한 유의 알림) 필터(선택).' },
        sector: { type: 'string', description: '섹터 태그 부분일치 필터(선택 — semis|energy|crypto|…).' },
        domain: { type: 'string', description: '도메인 필터(선택·GEN — finance 등·비-Conatus 대비).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'finance_dig',
    description: "온디맨드 심층 디깅(R2 수동 트리거·READ-ONLY): 사용자가 지목한 주제를 크론 디깅 러너와 같은 레시피(웹 심층검색 tavily + 섹터융합/수급/캡스톤 국면 + R3 과거 유사국면)로 즉시 분석 — 국면판단·영향경로·매매함의(관찰 포인트)·확신도 구조화 리포트. Use for '이거 디깅해줘/심층분석해줘/파봐/왜 이런지 조사해줘' 류 명시적 분석 요청. 크론 자동디깅과 달리 시간당 가드를 우회(사용자 요청이므로)하되 결과는 같은 dig_reports에 적재되어 지식레이어로 영속. 소요 ~1분(웹검색+LLM). 매매 지시 아님 — verify+HITL.",
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '디깅할 주제 (자연어 — 예: "TSMC 애리조나 증설 지연이 국내 소부장에 미치는 영향").' },
        sector: { type: 'string', description: '주영향 섹터 태그(선택 — semis|energy|financials|kr|crypto|macro 등). 레시피 라우팅에 사용, 기본 other.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'finance_kr_flow',
    description: "⭐ 한국 시장 투자자 수급 + 파생 디깅 단일 권위 — 한국투자증권/KRX API(T+0·장중). **한국 종목의 외국인/기관 수급·순매수·보유비중·공매도·선물/옵션 질문은 반드시 이 도구**(kr-flow 스킬 직접 Bash 호출 금지). 개별종목(6자리 symbol 필수): foreign-net(외국인 일별 순매수·누적)·investor(5/10/20일 매매동향)·price(현재가+PER/PBR+외국인보유비중)·ohlcv(일별 OHLCV)·short-sale(공매도 추이)·member(거래원/외국계 추정)·estimate(외인/기관 차수별 장중 추정 09:30~14:30). 시장 전체(symbol 불필요): market-flow(시장별 투자자매매동향·target KSP|KSQ)·frgn-institution(외국인/기관 매매종목 장중 가집계)·investor-time(KOSPI 12주체 세분류 장중)·krx-market/krx-kosdaq/krx-etf(거래소 일별매매 TOP20). ⭐파생(레버리지 디깅): krx-futures(KOSPI200 선물 미결제약정)·krx-options(옵션 미결제+풋콜레이쇼 심리)·krx-index(KOSPI 시리즈 지수)·krx-deriv-index(파생지수). **레버리지 판단 시 현물수급(frgn-institution/estimate)과 파생(krx-futures OI+krx-options 풋콜)을 교차 확인** — 현물 외국인 수급만 보면 속을 수 있음(선물발 프로그램 매도는 파생에만 잡힘·현물 투자자별엔 안 나옴). Use for '삼성 외국인 순매수/외국인 수급/기관 매수/코스피 수급/공매도/선물 미결제/풋콜 비율/차수별 외인/거래원'. default command=investor. date=특정일(YYYYMMDD·파생/인덱스)·json=구조화 출력. KIS .env 자체 로드(데몬 env 무관)·조회 전용·fail-soft.",
    // ★ turn 조립기 통일 C-①(2026-07-22) — 파라미터는 canonical buildKrFlowTool()에서 상속(단일 출처).
    //   command enum 이 dispatch 상수(VALID_COMMANDS)에서 자동 파생 → 명령 추가/변경 시 한 곳만 수정
    //   (종전 인라인 하드코딩 목록은 드리프트 원천). 이름(finance_kr_flow)·rich 한글 description 은 이
    //   서피스 계약이라 유지. dispatch 는 이미 dispatchKrFlow 단일 공유.
    parameters: buildKrFlowTool().parameters,
  },
  {
    name: 'finance_ontology',
    description: "⭐ 국면 온톨로지 인과추론 — 산업 클러스터(반도체·로봇 등 체인)·밸류체인 상하류·한미 크로스마켓·시계열 상관(±)·영향 범위를 그래프로 회상. **'반도체 체인 보여줘' '이 이벤트/정책 영향 범위' '삼성 한미 관계' '마이크론이랑 뭐가 엮여있나' 'P7 M7 관계' 같은 구조/인과 질문에 사용.** op: cluster(체인/그룹 멤버·서브체인) | blast(트리거 노드 영향 범위·부호·거리·시차) | recall(자연어 hybrid 회상) | corr(측정된 상관 목록) | list(노드 종류별). node= 'chain:반도체'·'group:P7'·'policy:us-export-control'·'company:005930' 형식. READ-ONLY 판단(매매 아님·verify+HITL).",
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'cluster | blast | recall | corr | list (기본 recall).' },
        node: { type: 'string', description: 'cluster/blast 대상 노드 id(예: chain:반도체·group:P7·policy:us-export-control).' },
        query: { type: 'string', description: 'recall 자연어 질의(예: "반도체 전망").' },
        regime: { type: 'string', description: 'blast/recall 국면 매칭(선택·RISK_ON 등).' },
        kind: { type: 'string', description: 'list 노드 종류(chain|company|group|subchain 등).' },
      },
      required: [],
    },
  },
  {
    name: 'finance_bt_loop',
    description: "⭐ 백테스팅 루프 조회 — 그날 정보로 장중에 실험한 포트폴리오(모멘텀 TS/XS·주간/월간 스윙)·학술 게이트 검증(CPCV·DSR·PBO·WRC) 결과·승격 후보·페이퍼 성과(ρ 실측). **'백테스트 실험 뭐 도나' '승격 후보 보여줘' '페이퍼 성과 어때' '오늘 백테스트 루프' 질문에 사용.** (과거 데이터 단일 백테스트는 finance_backtest.) op: experiments(최근 실험·verdict) | promotions(승격 이력) | paper(특정 실험 페이퍼 ρ·expId 필요) | summary(오늘 종합·기본). READ-ONLY·페이퍼(실집행은 대표 arm 게이트·매매 격리).",
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'experiments | promotions | paper | oos | summary (기본 summary). oos=페이퍼 예측 vs 실제 forward 검증(과최적화 실증·hitRate).' },
        expId: { type: 'string', description: 'paper op 대상 실험 id.' },
        limit: { type: 'number', description: '반환 건수(기본 10).' },
      },
      required: [],
    },
  },
  {
    name: 'finance_loops',
    description: "⭐ 자율 루프 관측 — 세 자율 루프(자율 디깅 dig goal · 새벽 리플레이 · 백테스팅)가 실제로 돌고 있나 한 눈에. arming 상태(armed/disarmed)·오늘 발화 횟수·상태 분포(running/done/abandoned/expired)·마지막 run. **'자율루프 상태' '디깅 돌고 있나' '리플레이 발화했나' '루프 관측' '자율 매매/분석 루프 상태' 질문에 사용.** (백테스트 실험 상세는 finance_bt_loop · 디깅 산출물은 dig 리포트.) READ-ONLY 관측.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  // schedule_manage·memory_recall 은 L2 코어 앱 도구(core-tools.ts)로 이관(2026-07-08).
  // finance 팩은 finance_* 도메인 도구만 — 코어 도구는 전 서피스가 L2 에서 상속.
];

export function buildFinanceTools(): {
  specs: LLMToolSpec[];
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  names: Set<string>;
} {
  const names = new Set(FINANCE_TOOL_SPECS.map(s => s.name));
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      switch (name) {
        case 'finance_market_backbone': {
          if (!existsSync(X_ASSET_DB)) return { error: `x_asset.db not found at ${X_ASSET_DB}` };
          const table = sqlite(X_ASSET_DB,
            "SELECT scope_key,score,direction,confidence FROM fact_signal_daily " +
            "WHERE signal_source='market_yahoo' AND date=(SELECT max(date) FROM fact_signal_daily WHERE signal_source='market_yahoo') " +
            'ORDER BY scope_key;');
          return { table, note: 'market_yahoo backbone = deterministic anchor. X crowd sentiment is separate (color only, validated worse-than-random alone).' };
        }
        case 'finance_attractiveness': {
          if (!existsSync(SCORES_DB)) return { error: `scores.db not found at ${SCORES_DB}` };
          const preset = String(args.preset ?? 'semis');
          const symbol = String(args.symbol ?? '');
          if (!safeToken(preset, '\\-')) return { error: `invalid preset: ${preset}` };
          if (symbol && !safeToken(symbol)) return { error: `invalid symbol: ${symbol}` };
          let freshNote = '';
          if (args.fresh === true && symbol) {
            // Recompute today's score (persists a fresh row into scores.db),
            // then the DB read below returns it. Fail-soft: on timeout/error
            // fall back to the existing (possibly stale) DB rows.
            try {
              // 2026-07-24 — `--date` 를 **명시 전달**한다. 종전엔 안 넘겨서 스킬이 자체로
              // `new Date().toISOString()`(UTC)을 썼고, 07:00 KST 크론에서 as_of 가 항상
              // 전날로 저장됐다(실측: scores.db 07:13 KST 쓰기인데 as_of=전날).
              // 시간대 결정을 호출자가 쥐는 게 계약(src/time/format.ts)에 맞다.
              execFileSync('npx', ['tsx', join(ASA_SKILL, 'scripts/main.ts'), 'score', symbol,
                '--preset', preset, '--date', dateKey(new Date())],
                { cwd: ASA_SKILL, env: process.env, encoding: 'utf-8', timeout: 120_000, maxBuffer: 4_000_000 });
              freshNote = ' (fresh score recomputed just now)';
            } catch (e) {
              freshNote = ` (fresh recompute failed, showing DB: ${e instanceof Error ? e.message.slice(0, 80) : String(e)})`;
            }
          }
          const where = symbol ? `preset='${preset}' AND symbol='${symbol}'` : `preset='${preset}'`;
          const table = sqlite(SCORES_DB,
            `SELECT symbol,as_of,round(total_score,1) AS score,z_score,signal FROM scores WHERE ${where} ORDER BY as_of DESC LIMIT ${symbol ? 3 : 12};`);
          // Staleness flag from the latest as_of in the result.
          const latest = /(\d{4}-\d{2}-\d{2})/.exec(table)?.[1] ?? '';
          // ⚠️ 종전 UTC 였다. 스킬 as_of 도 UTC 라 **둘이 같이 틀려서** 이 가드가
          // 침묵했다 — 잡아야 할 경고가 같은 시간대 오류를 공유해 은폐한 셈.
          const today = dateKey(new Date());
          const stale = latest && latest < today ? ` ⚠️ latest row = ${latest} (오늘 ${today} 아님 — 시차 감안, fresh:true로 재계산 가능)` : '';
          return { table: table || '(no rows — check preset/symbol)', note: `scores.db${freshNote}.${stale}` };
        }
        case 'finance_screener': {
          const presetName = String(args.preset ?? 'us-gainers');
          const rawFilters = typeof args.filters === 'string' ? args.filters.trim() : '';
          const limit = Math.max(1, Math.min(Number(args.limit) || 15, 50));
          const preset = screenerPreset(presetName);
          const filters = rawFilters || preset?.filters;
          if (!filters) return { error: `unknown preset: ${presetName} (us-gainers|us-losers|us-momentum|us-value)` };
          const out = omniMarket('screener', '--filters', filters, '--json');
          const rows = parseScreenerJson(out);
          if (!rows.length) return { table: '(스크리너 매치 없음 — 필터 조정)', note: 'EODHD /screener · 매매는 verify+HITL' };
          const sortKey = preset?.sortKey ?? 'refund_1d_p';
          const desc = preset?.desc ?? true;
          const label = preset?.label ?? presetName;
          return { table: formatScreenerRows(rows, sortKey, desc, limit, label), note: 'EODHD /screener · 스크리닝=관찰 · 매매는 verify+HITL' };
        }
        case 'finance_trend': {
          const scope = String(args.scope ?? 'rotation');
          const days = Math.min(Math.max(Number(args.days ?? 90) || 90, 7), 730);
          if (scope === 'asset') {
            if (!existsSync(X_ASSET_DB)) return { error: 'x_asset.db not found' };
            const key = String(args.key ?? 'equities');
            if (!safeToken(key, '_')) return { error: `invalid key: ${key}` };
            const series = sqlite(X_ASSET_DB,
              `SELECT date, round(score,0) AS score, direction FROM fact_signal_daily ` +
              `WHERE signal_source='market_yahoo' AND scope_key='${key}' AND date >= date('now','-${days} days') ` +
              `ORDER BY date DESC LIMIT 24;`);
            return { scope, key, window_days: days, series: series || '(no rows)', note: 'market backbone (deterministic). recent-first; read bottom→top for chronological trend.' };
          }
          if (scope === 'attractiveness') {
            if (!existsSync(SCORES_DB)) return { error: 'scores.db not found' };
            const symbol = String(args.key ?? '');
            const preset = String(args.preset ?? 'semis');
            if (!symbol || !safeToken(symbol)) return { error: 'scope=attractiveness needs key=symbol (e.g. 005930.KO)' };
            if (!safeToken(preset, '\\-')) return { error: `invalid preset: ${preset}` };
            const series = sqlite(SCORES_DB,
              `SELECT as_of, round(total_score,1) AS score, round(z_score,2) AS z, signal FROM scores ` +
              `WHERE preset='${preset}' AND symbol='${symbol}' AND as_of >= date('now','-${days} days') ` +
              `ORDER BY as_of DESC LIMIT 24;`);
            return { scope, symbol, preset, window_days: days, series: series || '(no rows — check symbol/preset)', note: 'attractiveness history. recent-first.' };
          }
          // rotation (asset classes) / country / sector — all live in
          // cross_asset_scores under different presets. asset_class values are
          // disjoint, so a signature class selects the right preset_hash without
          // hardcoding it: 'gold'=cross-asset, 'kr'=country, 'technology'=sector.
          if (!existsSync(SCORES_DB)) return { error: 'scores.db not found' };
          const SIG: Record<string, string> = { country: 'kr', sector: 'technology' };
          const sig = SIG[scope] ?? 'gold';
          const table = sqlite(SCORES_DB,
            `WITH h AS (SELECT preset_hash FROM cross_asset_scores WHERE asset_class='${sig}' ORDER BY as_of DESC LIMIT 1) ` +
            `SELECT rank, asset_class, symbol, round(score,1) AS score, signal FROM cross_asset_scores ` +
            `WHERE preset_hash=(SELECT preset_hash FROM h) ` +
            `AND as_of=(SELECT max(as_of) FROM cross_asset_scores WHERE preset_hash=(SELECT preset_hash FROM h)) ORDER BY rank;`);
          const NOTE: Record<string, string> = {
            country: '국가 매력도 랭킹 (country ETF·USD·추세/변동성/밸류/금리 tier). higher = 자금이 도는 국가. finance_region {region} 앵커의 정식 스코어링판.',
            sector: '섹터 로테이션 매력도 (US GICS 11섹터 ETF·가격 기반 실시간). higher = 지금 강한 섹터. finance_13f_sectors(기관 실자금·45일지연)와 상보 — 가격 momentum vs 기관 자금흐름 교차확인.',
          };
          const empty = scope === 'sector' ? 'sector-global' : 'country-global';
          return {
            scope: scope === 'country' || scope === 'sector' ? scope : 'rotation',
            table: table || `(${empty} 미계산 — cross-rank --preset ${empty} 필요)`,
            note: NOTE[scope] ?? 'cross-asset rotation (latest) — higher = more attractive asset class = where capital rotates. equities_kr = Korea.',
          };
        }
        case 'conatus_position': {
          if (!existsSync(CONATUS)) return { error: 'Conatus repo not found' };
          let positions: string, risk: string;
          try { positions = runConatus('verify_position.py', '--show'); }
          catch (e) { positions = `(verify_position failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)})`; }
          try { risk = runConatus('verify_risk_bounds.py', '--check'); }
          catch (e) { risk = `(verify_risk_bounds exit≠0 or failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)})`; }
          return { positions, risk_gate: risk, note: 'READ ONLY — no execution scripts were run.' };
        }
        case 'finance_panel': {
          const symbol = String(args.symbol ?? '').trim();
          if (!symbol || !safeToken(symbol)) return { error: 'valid symbol required (e.g. 005930.KO)' };
          const preset = String(args.preset ?? SYMBOL_SECTOR[symbol] ?? 'semis');
          if (!safeToken(preset, '\\-')) return { error: `invalid preset: ${preset}` };
          const mode = args.mode === 'buyback' ? 'buyback' : 'investor';
          // sector → panel file (only semis/food-bio/battery have bespoke panels).
          const panelSector = ['semis', 'food-bio', 'battery'].includes(preset) ? preset : '_default';
          const panelFile = mode === 'buyback' && panelSector === 'semis' ? 'semis-buyback.json' : `${panelSector}.json`;
          const panelPath = join(PANEL_DIR, panelFile);
          if (!existsSync(panelPath)) return { error: `panel not found: ${panelFile}` };
          let panelJson: any;
          try { panelJson = JSON.parse(readFileSync(panelPath, 'utf-8')); }
          catch (e) { return { error: `panel parse failed: ${e instanceof Error ? e.message.slice(0, 80) : e}` }; }
          const roster = (panelJson.panel ?? []).map((p: any) => ({
            id: p.id, name: p.name_kr ?? p.name_en, tier: p.tier_owned,
            weight: p.consensus_weight, frame: p.frame, dimension: p.dimension, emoji: p.emoji,
          }));
          // Live framework score + per-tier breakdown from scores.db (fail-soft).
          let framework: unknown = '(scores.db 부재 — 점수 없이 정성 심의)';
          let tierScores: unknown = null;
          if (existsSync(SCORES_DB)) {
            // Clean score line (no tiers_json blob — the per-tier scores go in tier_scores).
            const row = sqlite(SCORES_DB,
              `SELECT round(total_score,1) AS score, signal, round(z_score,2) AS z, as_of ` +
              `FROM scores WHERE preset='${preset}' AND symbol='${symbol}' ORDER BY as_of DESC LIMIT 1;`);
            framework = row || `(no ${preset} score for ${symbol} — 프레임워크 점수 없이 정성 심의)`;
            // Extract per-tier scores so each persona sees their tier's current value.
            const tj = sqlite(SCORES_DB,
              `SELECT tiers_json FROM scores WHERE preset='${preset}' AND symbol='${symbol}' ORDER BY as_of DESC LIMIT 1;`);
            const m = /\{.*\}/s.exec(tj);
            if (m) { try { const t = JSON.parse(m[0]); tierScores = Object.fromEntries(Object.entries(t).map(([k, v]: any) => [k, v?.score])); } catch { /* leave null */ } }
          }
          return {
            symbol, sector: panelSector, mode, panel_size: roster.length,
            framework_score: framework, tier_scores: tierScores,
            tier_weights: panelJson.tier_weight_alignment, panel: roster,
            consensus_formula: 'action_score = Σ(persona.weight × confidence × action_sign), sign: BUY=+1/HOLD=0/SELL=-1',
            instruction: '각 persona 관점(frame + 해당 tier 현재 score)에서 action(BUY/HOLD/SELL)+confidence(0~1) 판정 → weight 가중합으로 consensus action 산출. 주요 합의점·핵심 divergence·framework 대비 정렬을 함께 보고. 매매 실행은 금지(verify+HITL).',
            note: 'attractiveness-panel 스킬 로스터(결정론) + scores.db 실점수. 심의=에이전트 합성(sub-agent spawn 아님).',
          };
        }
        case 'finance_13f': {
          const fundQ = String(args.fund ?? '').trim();
          if (!fundQ) return { error: 'fund name or CIK required (e.g. berkshire, scion, or a CIK)' };
          const { resolveFundCik, fetch13F, summarize13F } = await import('./sec-13f.js');
          const fund = await resolveFundCik(fundQ);
          const filings = await fetch13F(fund.cik, 2);
          if (!filings.length) return { error: `no 13F-HR holdings found for ${fund.name} (CIK ${fund.cik})` };
          return summarize13F(filings, fund);
        }
        case 'finance_13f_movers': {
          const KDB = knowledge13fDbPath();
          if (!existsSync(KDB)) return { error: 'knowledge_13f.db not populated yet — run the 13F ingest (scripts/money-movement-report.ts) or ask to refresh.' };
          const minFunds = Math.max(2, Math.min(Number(args.min_funds ?? 2) || 2, 10));
          const table = sqlite(KDB,
            `WITH latest AS (SELECT cik, MAX(period) p FROM fact_13f_holdings GROUP BY cik) ` +
            `SELECT MAX(h.issuer) AS issuer, COUNT(DISTINCT h.cik) AS funds, round(SUM(h.value)/1e9,1) AS total_B ` +
            `FROM fact_13f_holdings h JOIN latest l ON h.cik=l.cik AND h.period=l.p ` +
            `GROUP BY substr(h.cusip,1,8) HAVING funds>=${minFunds} ORDER BY funds DESC, total_B DESC LIMIT 20;`);
          return { consensus_holdings: table || '(no data)', note: 'issuers held by 2+ funds (each fund\'s latest 13F) = institutional consensus. From knowledge.db (13F ingest).' };
        }
        case 'finance_13f_sectors': {
          const KDB = knowledge13fDbPath();
          if (!existsSync(KDB)) return { error: 'knowledge_13f.db not populated yet — run the 13F ingest (scripts/run-13f-ingest.sh) or ask to refresh.' };
          // cusip8 → sector via the cached dim_security classifier; TRIM/NULLIF
          // collapses the two 'Unknown' shapes (cached literal vs unmapped NULL).
          const SEC = "COALESCE(NULLIF(TRIM(ds.sector),''),'Unknown')";
          const C8 = "substr(replace(h.cusip,' ',''),1,8)";
          // Drill-down: the individual issuers driving one sector's QoQ flow.
          const sectorArg = String(args.sector ?? '').trim();
          if (sectorArg) {
            if (!safeToken(sectorArg, ' &/\\-')) return { error: `invalid sector: ${sectorArg}` };
            const issuers = sqlite(KDB,
              `WITH per AS (SELECT cik, period, substr(replace(cusip,' ',''),1,8) AS c8, MAX(issuer) AS issuer, SUM(value) AS v ` +
              `FROM fact_13f_holdings GROUP BY cik, period, c8), ` +
              `ranked AS (SELECT cik, c8, issuer, v, DENSE_RANK() OVER (PARTITION BY cik ORDER BY period DESC) rk FROM per), ` +
              `keys AS (SELECT DISTINCT cik, c8 FROM ranked WHERE rk<=2), ` +
              `delta AS (SELECT k.c8, ` +
              `(SELECT issuer FROM ranked WHERE cik=k.cik AND c8=k.c8 ORDER BY rk LIMIT 1) AS issuer, ` +
              `COALESCE((SELECT v FROM ranked WHERE cik=k.cik AND c8=k.c8 AND rk=1),0) ` +
              `- COALESCE((SELECT v FROM ranked WHERE cik=k.cik AND c8=k.c8 AND rk=2),0) AS d FROM keys k) ` +
              `SELECT ds.ticker AS ticker, MAX(delta.issuer) AS issuer, round(SUM(d)/1e9,2) AS net_B, COUNT(*) AS funds ` +
              `FROM delta JOIN dim_security ds ON delta.c8=ds.cusip8 ` +
              `WHERE TRIM(ds.sector)='${sectorArg}' ` +
              `GROUP BY delta.c8 HAVING abs(net_B) > 0.02 ORDER BY net_B DESC;`);
            return { sector: sectorArg, issuers: issuers || `(no QoQ movers classified into '${sectorArg}' — check the sector name via the no-arg rollup)`, note: 'net_B>0 = 이 섹터 내 순매수 종목, <0 = 순매도 (QoQ, 추적 펀드 합산). funds = 그 종목을 움직인 펀드 수.' };
          }
          // QoQ net delta per (fund, cusip8) between each fund's latest 2 periods, summed by sector.
          const flow = sqlite(KDB,
            `WITH per AS (SELECT cik, period, substr(replace(cusip,' ',''),1,8) AS c8, SUM(value) AS v ` +
            `FROM fact_13f_holdings GROUP BY cik, period, c8), ` +
            `ranked AS (SELECT cik, c8, v, DENSE_RANK() OVER (PARTITION BY cik ORDER BY period DESC) rk FROM per), ` +
            `keys AS (SELECT DISTINCT cik, c8 FROM ranked WHERE rk<=2), ` +
            `delta AS (SELECT k.c8, ` +
            `COALESCE((SELECT v FROM ranked WHERE cik=k.cik AND c8=k.c8 AND rk=1),0) ` +
            `- COALESCE((SELECT v FROM ranked WHERE cik=k.cik AND c8=k.c8 AND rk=2),0) AS d FROM keys k) ` +
            `SELECT COALESCE(NULLIF(TRIM(ds.sector),''),'Unknown') AS sector, round(SUM(d)/1e9,2) AS net_B, COUNT(*) AS positions ` +
            `FROM delta LEFT JOIN dim_security ds ON delta.c8=ds.cusip8 ` +
            // GROUP BY 1 (ordinal), NOT `sector`: the alias name collides with
            // ds.sector and SQLite would group by the raw column, splitting the
            // matched-'Unknown' rows from the unmatched-NULL rows.
            `GROUP BY 1 HAVING abs(net_B) > 0.05 ORDER BY net_B DESC;`);
          // Latest-quarter sector allocation (level, not flow) for context.
          const alloc = sqlite(KDB,
            `WITH latest AS (SELECT cik, MAX(period) p FROM fact_13f_holdings GROUP BY cik) ` +
            `SELECT ${SEC} AS sector, round(SUM(h.value)/1e9,1) AS held_B ` +
            `FROM fact_13f_holdings h JOIN latest l ON h.cik=l.cik AND h.period=l.p ` +
            `LEFT JOIN dim_security ds ON ${C8}=ds.cusip8 ` +
            `GROUP BY 1 ORDER BY held_B DESC;`);
          const cov = sqlite(KDB,
            `SELECT (SELECT count(DISTINCT substr(replace(cusip,' ',''),1,8)) FROM fact_13f_holdings) AS securities, ` +
            `(SELECT count(*) FROM dim_security WHERE TRIM(sector)!='' AND sector!='Unknown') AS classified;`);
          return {
            sector_flow_qoq: flow || '(no data)',
            sector_allocation_latest: alloc || '(no data)',
            coverage: cov,
            note: 'net_B>0 = 섹터로 순유입, <0 = 순유출 (QoQ, 추적 펀드 합산·CUSIP 기준). 분류=GICS via omni-market(dim_security 캐시). classified<securities면 미분류분이 Unknown에 집계됨 — 주간 ingest가 채움.',
          };
        }
        case 'finance_region': {
          if (!existsSync(REGION_DIR)) return { error: 'region reports dir not found' };
          let date = String(args.date ?? '');
          if (date && !/^\d{8}$/.test(date)) return { error: 'date must be YYYYMMDD' };
          if (!date) {
            const dirs = readdirSync(REGION_DIR).filter(d => /^\d{8}$/.test(d)).sort();
            date = dirs[dirs.length - 1] ?? '';
          }
          if (!date) return { error: 'no region reports found' };
          const f = join(REGION_DIR, date, `report_region_daily_${date}_draft.md`);
          if (!existsSync(f)) return { error: `no region report for ${date}` };
          const report = readFileSync(f, 'utf-8');

          const region = String(args.region ?? '').trim().toUpperCase();
          if (region) {
            const anchor = REGION_ANCHORS[region];
            if (!anchor) return { error: `unknown region: ${region}. Use one of ${Object.keys(REGION_ANCHORS).join('/')}` };
            // Objective anchor — index (Yahoo) + USD FX (EODHD), both via quote.
            const idx = omniQuote(anchor.index);
            const fx = anchor.fx ? omniQuote(anchor.fx) : null;
            const objective = {
              index: idx ? `${anchor.index}: ${idx.close.toLocaleString()} (${idx.changePct >= 0 ? '+' : ''}${idx.changePct.toFixed(2)}%)` : `${anchor.index}: (unavailable)`,
              fx: anchor.fx ? (fx ? `${anchor.fx.replace('.FOREX', '')}: ${fx.close.toLocaleString()} (${fx.changePct >= 0 ? '+' : ''}${fx.changePct.toFixed(2)}%)` : `${anchor.fx.replace('.FOREX', '')}: (unavailable)`) : '(USD base)',
            };
            // Pull just this region's lines from the sentiment report for context.
            const codeToKr: Record<string, RegExp> = {
              US: /미국|US\b/i, KR: /한국|Korea|KR\b/i, JP: /일본|Japan|JP\b/i, CN: /중국|China|CN\b/i,
              EU: /유럽|Europe|EU\b|독일/i, BR: /브라질|Brazil|BR\b/i, IN: /인도|India|IN\b/i, ZA: /남아공|남아프리카|South Africa|ZA\b/i,
            };
            const rx = codeToKr[region];
            const colorLine = report.split('\n').find(l => rx.test(l) && /[🟢🔴🟡]/.test(l)) ?? '(리포트에서 해당 지역 color 미검출)';
            return {
              region: anchor.name, date,
              objective_anchor: objective,
              sentiment_color: colorLine.trim(),
              note: '⚓ objective_anchor(실시간 index %change + USD FX·omni-market/Yahoo) = 1급 판단근거. sentiment_color(X-파생·color only)는 보조. 실측이 센티먼트와 어긋나면 objective 우선.',
            };
          }

          return { date, report: report.slice(0, 8000), note: 'X-derived sentiment dashboard (color only). 특정 국가는 region=US|JP|KR... 로 objective index/FX 앵커 동반 조회.' };
        }
        case 'finance_monitor': {
          // P3a — one-shot combined snapshot. Fan out to the focused tools in
          // parallel; each already fails soft to {error}, so a missing DB
          // degrades that one section without sinking the whole view. `sec`
          // pulls the meaningful field (table / consensus_holdings / error).
          const sec = (r: unknown): string => {
            const o = (r ?? {}) as Record<string, unknown>;
            const v = o.table ?? o.consensus_holdings ?? o.error ?? '(no data)';
            return typeof v === 'string' ? v : String(v);
          };
          const [backbone, rotation, country, sector, consensus] = await Promise.all([
            dispatch('finance_market_backbone', {}),
            dispatch('finance_trend', { scope: 'rotation' }),
            dispatch('finance_trend', { scope: 'country' }),
            dispatch('finance_trend', { scope: 'sector' }),
            dispatch('finance_13f_movers', {}),
          ]);
          return {
            backbone: sec(backbone),
            asset_rotation: sec(rotation),
            country_attractiveness: sec(country),
            sector_rotation: sec(sector),
            institutional_consensus: sec(consensus),
            note: '종합 스냅샷(P3a): backbone(결정론 앵커) + 회전/매력도(±1σ HOLD/BUY/SELL) + 13F 컨센서스. 방향 일치/괴리를 함께 읽어라(예: 자산군 강세인데 관련 국가 매력도 하락). 매매는 verify+HITL.',
          };
        }
        case 'finance_dislocation': {
          // P3b — backbone(실측) vs sentiment(크라우드) 괴리. read-only·fail-soft.
          const all = computeDislocations();
          if (all.length === 0) {
            return { error: 'no overlapping backbone+sentiment data (센티 신선도 확인: score_from_md 스코어링). x_asset.db 필요.' };
          }
          const flagged = all.filter(d => d.severity !== 'aligned');
          return {
            dislocations: all.map(d => ({
              asset: d.asset, backbone: d.backbone, backbone_dir: d.backboneDir,
              sentiment: d.sentiment, sentiment_dir: d.sentimentDir,
              gap: d.gap, sign_disagree: d.signDisagree, severity: d.severity,
            })),
            summary: renderDislocationSection(all) || '  (유의미한 괴리 없음 — 실측·센티 정렬)',
            note: `${flagged.length}개 자산군 괴리(strong/moderate). backbone(실측)이 1급 근거·괴리는 관찰 포인트(매매 아님·verify+HITL). gap=센티−실측(양수=크라우드가 더 강세).`,
          };
        }

        case 'finance_capstone': {
          // 캡스톤 레버리지 §4.1 — ABCDE 신호(omni-market) → 국면 → 권장 배수.
          // READ-ONLY 판단. hedge 지속상태는 실행부 소관이라 여기선 무hedge 기준
          // 현재 신호가 가리키는 국면을 보여준다(D 발동 시 HEDGE_1D 표시).
          const mkt = marketSessions();
          // 실시간 소스 우선순위 토스>EODHD. 토스가 전 세션 라이브 커버(KR 정규·NXT·
          // US 정규·주간거래). EODHD는 ET/정규장 fallback. 마감이면 EOD.
          const sig = computeAbcdeSignals(fetchEodCloses, fetchLiveQuote,
            { usEtLive: mkt.usLive, usOvernight: mkt.usOvernight, krRegular: mkt.kr === 'OPEN', krNxt: mkt.krLive && mkt.kr !== 'OPEN' },
            fetchTossQuote);
          // ★ fail-closed: EOD 조회 실패 시 신호가 붕괴(거짓 Bull→LONG)하므로 국면 판정 금지.
          if (!sig.reliable) return { error: 'EOD 데이터 조회 실패 — 캡스톤 신호 신뢰 불가(빈 배열이면 거짓 Bull/LONG 위험). 잠시 후 재시도.', reliable: false };
          const today = mkt.kstLabel.trim().split(' ')[0]; // YYYY-MM-DD (KST)
          const { target } = decideTarget(sig, { dHedgeActive: false, dHedgeUntil: null }, today);
          // 사람 오버라이드 우선 병합 (source=override면 자동을 누름).
          const auto = { target, bear: sig.a || sig.b, r3: sig.r3 };
          const overrides = listActiveOverrides(today);
          const resolved = resolveCapstoneRegime(auto, overrides);
          const plan = decideLeverage(resolved.target, resolved.bear, resolved.r3);
          const legs = typeof args.netAssetKrw === 'number' && args.netAssetKrw > 0
            ? allocateLegs(plan, args.netAssetKrw) : undefined;
          return {
            signals: {
              // A = XA regime OR 원화 (원 설계 복원 2026-07-07 · 대표 옵션 B)
              A_xa_krw: sig.a
                ? `Bear (${[sig.aXa?.riskOff ? 'XA 자금이탈' : '', sig.aKrw ? '원화약세' : ''].filter(Boolean).join('+')})`
                : `Bull${sig.aXa ? ` (한주식 rank ${sig.aXa.rank}·z ${sig.aXa.z})` : ' (XA 판정불가·원화만)'}`,
              B_drawdown: `${sig.b ? 'Bear' : 'Bull'} (DD ${(sig.bDd * 100).toFixed(1)}% / 임계 ${(sig.bThreshold * 100).toFixed(1)}%, ${sig.bLive ? '실시간' : 'EOD'})`,
              C_r3recovery: sig.r3,
              D_psd: `K=${sig.dK} ${sig.dFire ? '발동' : '미발동'} (${sig.dLive ? 'US실시간' : 'EOD'})`,
              D_detail: sig.dDetail,
              E_sleeve: `${sig.eFire ? '발동' : '미발동'} (vz ${sig.eVz.toFixed(2)}σ, SMH ${sig.eSmhBull ? '강세' : '약세'})`,
            },
            auto_regime: auto.target,
            decision_source: resolved.source,
            override: resolved.source === 'override'
              ? { kind: resolved.overrideKind, note: resolved.note, paused: resolved.paused ?? false, hold: resolved.hold ?? false }
              : null,
            active_overrides: overrides.length,
            regime: plan.regime,
            leverage: {
              label: plan.label,
              target_exposure: plan.targetExposure,
              effective_exposure_check: plan.effectiveExposure,
              weights: plan.weights,
            },
            ...(legs ? { legs } : {}),
            note: `캡스톤 §4.1 통합 LV형 — ABCDE(omni-market)→국면→배수. **사람 오버라이드 우선**(decision_source=override면 대표 재량이 자동을 누름·auto_regime=자동판단). READ-ONLY 판단·주문 없음. 실효노출 검산(effective==target). 실집행은 verify게이트 CLEARED + 2단계 HITL 승인 필수. 인버스=0193L0(토스전용시세).`,
          };
        }

        case 'finance_capstone_override': {
          // 사람 재량 오버라이드(자동 우선) set/list/cancel. SQLite 감사. 주문 없음.
          const action = String(args.action ?? '');
          const today = marketSessions().kstLabel.trim().split(' ')[0];
          if (action === 'list') {
            const active = listActiveOverrides(today);
            return {
              active: active.map(o => ({ id: o.id, kind: o.kind, params: o.params, reason: o.reason, scope: o.scope, expiresAt: o.expiresAt, event: o.event, priority: o.priority, createdAt: o.createdAt })),
              count: active.length,
              note: '사람 오버라이드가 자동 ABCDE보다 우선. 만료/취소는 이력 보존(감사). finance_capstone으로 최종 반영 확인.',
            };
          }
          if (action === 'cancel') {
            const id = String(args.id ?? '').trim();
            if (!id) return { error: 'cancel: id 필요(finance_capstone_override list로 확인)' };
            return { cancelled: cancelOverride(id), id };
          }
          // set
          const VALID: OverrideKind[] = ['force_regime', 'arm_entry', 'block_entry', 'hold_position', 'pause_auto'];
          const kind = String(args.kind ?? '') as OverrideKind;
          if (!VALID.includes(kind)) return { error: `set: kind 필요(${VALID.join('/')})` };
          const params: Record<string, unknown> = {};
          if (args.regime) params.regime = String(args.regime).toUpperCase();
          const scope = ['next_decision', 'until_date', 'until_event', 'until_cancelled'].includes(String(args.scope))
            ? String(args.scope) as 'next_decision' | 'until_date' | 'until_event' | 'until_cancelled' : 'until_cancelled';
          const id = `ov-${Date.now().toString(36)}-${kind}`;
          const created = addOverride({
            id, kind, params, reason: String(args.reason ?? '(대표 지시)'),
            scope, expiresAt: args.expiresAt ? String(args.expiresAt) : null,
            event: args.event ? String(args.event) : null,
            priority: Number(args.priority) || 0, createdAt: new Date().toISOString(),
          });
          return {
            set: { id: created.id, kind: created.kind, params: created.params, scope: created.scope, expiresAt: created.expiresAt, reason: created.reason },
            note: '오버라이드 저장 — 다음 판단부터 자동보다 우선. finance_capstone으로 반영 확인. 실집행은 여전히 verify게이트+HITL 승인 필요.',
          };
        }
        case 'finance_backtest': {
          // 백필 DB/캐시 물리이전(~/.elanous/conatus) 위에서 Conatus 백테스트 파이썬
          // 재사용(대표 결정: 파이썬 재사용). CONATUS_DATA_DIR env로 elanous 소유
          // 데이터를 읽게 한다. READ-ONLY·비실시간 연구용·주문 없음.
          const script = args.factor === true ? 'factor_research.py' : 'backtest.py';
          // 파리티 검증된 TS 포트 라우팅(config flag·기본 false → 아래 python 경로 불변).
          // READ-ONLY: loadFullPanel 은 캐시 JSON 만 읽음(write 없음).
          if (conatusNativePortEnabled()) {
            try {
              const r = args.factor === true
                ? conatusFactorResearch(loadFullPanel())
                : conatusBacktest(loadFullPanel());
              return {
                script,
                output: r.render().slice(-6000) || '(no output)',
                note: 'elanous 소유 데이터(~/.elanous/conatus) 정직 백테스트 — 익일시가 ρ=0·시장 대비 초과수익·룩어헤드 방지. READ-ONLY 연구용·주문 없음. 캐시 기간이 짧으면 forward 윈도 일부 공백(백필 누적으로 확장). [conatus-native TS 포트]',
              };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const dep = /EODHD|Traceback|cache|No such|empty/i.test(msg);
              return { error: dep ? `백테스트 데이터/실행 문제(EODHD 키·캐시 확인): ${msg.slice(0, 120)}` : msg.slice(0, 150) };
            }
          }
          try {
            const out = execFileSync('python3', [join(CONATUS, 'screener', script)], {
              cwd: CONATUS, encoding: 'utf-8', timeout: 120_000, maxBuffer: 8_000_000,
              env: { ...process.env, CONATUS_DATA_DIR: ELANOUS_CONATUS },
            }).trim();
            return {
              script,
              output: out.slice(-6000) || '(no output)',
              note: 'elanous 소유 데이터(~/.elanous/conatus) 정직 백테스트 — 익일시가 ρ=0·시장 대비 초과수익·룩어헤드 방지. READ-ONLY 연구용·주문 없음. 캐시 기간이 짧으면 forward 윈도 일부 공백(백필 누적으로 확장).',
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const dep = /EODHD|Traceback|cache|No such|empty/i.test(msg);
            return { error: dep ? `백테스트 데이터/실행 문제(EODHD 키·캐시 확인): ${msg.slice(0, 120)}` : msg.slice(0, 150) };
          }
        }
        case 'finance_sector': {
          // P3c — price momentum vs institutional 13F flow, fused per sector.
          const rows = computeSectorFusion();
          if (rows.length === 0) {
            return { error: 'sector-global(scores.db) 또는 13F(knowledge.db) 데이터 없음. cross-rank --preset sector-global + 13F ingest 필요.' };
          }
          const divergent = rows.filter(r => r.divergent);
          return {
            sectors: rows.map(r => ({
              sector: r.sector, price_rank: r.rank, price_score: r.price,
              institutional_net_B: r.netB, label: r.label, divergent: r.divergent,
            })),
            table: renderSectorFusion(rows),
            note: `가격 momentum(sector-global) × 기관 실자금(13F QoQ net_B) 융합. ${divergent.length}개 발산 — 분산(가격강↔기관매도)·축적(가격약↔기관매수)이 관찰 포인트. 가격이 1급·13F는 45일 지연·매매 아님(verify+HITL).`,
          };
        }
        case 'finance_kr_flow': {
          // 한국 외국인/기관/개인 수급 — kr-flow 스킬 CLI 래핑(KIS .env 자체
          // 로드, 데몬 env 무관). 개별종목 명령은 symbol 검증, 시장 명령은
          // symbol 불필요. 조회 전용·주문 없음.
          const r = await dispatchKrFlow(args);
          if (r.isError) {
            return { error: r.output, command: r.metadata.command, symbol: r.metadata.symbol };
          }
          return {
            report: r.output,
            command: r.metadata.command,
            symbol: r.metadata.symbol,
            note: '한국투자증권 API 실시간 투자자 수급(T+0). 조회 전용·매매 아님(verify+HITL).',
          };
        }
        case 'finance_knowledge': {
          // R3 — 과거 유사국면 벡터 검색(지식레이어). 임베딩은 로컬 LM Studio
          // 1순위(폴백 OpenAI) — 둘 다 불가하면 error 반환(fail-soft).
          const query = String(args.query ?? '').trim();
          if (!query) return { error: 'query 필수 — 유사국면을 찾을 자연어 질의를 넘겨라.' };
          if (!existsSync(knowledgeDbPath())) {
            return { error: 'knowledge.db 미생성 — 일1회 인제스트 크론(scripts/knowledge-ingest.ts) 첫 실행 전이거나 원료(신호/디깅/알파) 부재.' };
          }
          const kdb = openKnowledgeDb();
          try {
            const stats = knowledgeStats(kdb);
            const matches = await queryKnowledge(kdb, query, {
              ...(typeof args.k === 'number' ? { k: args.k } : {}),
              ...(typeof args.kind === 'string' && args.kind ? { kind: String(args.kind) } : {}),
              ...(typeof args.sector === 'string' && args.sector ? { sector: String(args.sector) } : {}),
              ...(typeof args.domain === 'string' && args.domain ? { domain: String(args.domain) } : {}),
            });
            return {
              matches: renderKnowledgeMatches(matches),
              corpus: `${stats.total}건 (${stats.byKind.map(k => `${k.kind} ${k.n}`).join(' · ')})`,
              note: '과거 유사국면 검색(R3) — 영속 지식·READ-ONLY. 매매는 verify+HITL.',
            };
          } catch (e) {
            return { error: `지식레이어 질의 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}` };
          } finally { kdb.close(); }
        }
        // memory_recall·schedule_manage → L2 코어 앱 도구(core-tools.ts)로 이관(2026-07-08).
        case 'finance_dig': {
          // R2 잔여 체크박스(2026-07-07) — 텔레그램 온디맨드 디깅: 같은 러너
          // (runDig 레시피·dig_reports 적재·지식레이어 영속)를 수동 트리거.
          // 사용자 명시 요청이므로 시간당 2회 가드는 우회(nextDiggable 안 거침).
          // dynamic import — dig-engine이 buildFinanceTools를 import하므로
          // 정적 import는 순환. 호출 시점 로드로 회피.
          const topic = String(args.topic ?? '').trim();
          if (!topic) return { error: 'topic 필수 — 디깅할 주제를 자연어로 넘겨라.' };
          const sector = String(args.sector ?? 'other').trim() || 'other';
          const { openSignalsDb } = await import('./breaking-signals.js');
          const { ensureDigTables, runDig } = await import('./dig-engine.js');
          const db = openSignalsDb();
          try {
            ensureDigTables(db);
            const id = `manual:${new Date().toISOString().slice(0, 16)}:${topic.slice(0, 40)}`;
            db.prepare(`INSERT OR REPLACE INTO dig_queue(id, topic, sector, score, created_at, status) VALUES (?,?,?,?,?, 'queued')`)
              .run(id, topic.slice(0, 300), sector.slice(0, 30), 10, new Date().toISOString());
            const res = await runDig(db, { id, topic: topic.slice(0, 300), sector: sector.slice(0, 30), score: 10 });
            if (!res) return { error: 'LLM 종합 불가(프로바이더 전멸 또는 빈 응답) — 잠시 후 재시도.' };
            return {
              report: res.verdict,
              confidence: res.confidence,
              note: '온디맨드 디깅(R2 수동 트리거) — dig_reports 적재·지식레이어 영속(일 20:45 인제스트). 분석만 — 매매는 verify+HITL.',
            };
          } catch (e) {
            return { error: `디깅 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
          } finally { db.close(); }
        }
        case 'finance_opportunity': {
          // P5a — opportunity policy (detection only; the autonomous launcher
          // is a separate, config-gated + disarmed-by-default step).
          const signals = evaluateOpportunities();
          const candidates = signals.filter(s => s.warrantsAnalysis);
          return {
            opportunities: signals.map(s => ({
              kind: s.kind, subject: s.subject, severity: s.severity,
              headline: s.headline, detail: s.detail,
              warrants_analysis: s.warrantsAnalysis,
              suggested_focus: s.suggestedFocus,
            })),
            board: renderOpportunities(signals),
            note: `${signals.length}개 기회 신호 · ${candidates.length}개 자율분석 후보(high). 탐지 전용 — 자율 goal 자동기동은 disarmed(대표 검증 후 arming). 매매 아님·verify+HITL.`,
          };
        }
        case 'finance_kfutures': {
          // P7c — KOSPI200 선물 현재가 read-only(KIS). 주문 코드 경로 없음.
          // conatusNativePort=true → kr-flow futures-rt(skill·Conatus DIR 이탈·토큰 lifecycle 재사용).
          // false(기본) → kis_futures.py(Conatus·불변). 실패 시 python 경로로 fall-through.
          if (conatusNativePortEnabled()) {
            try {
              const KRFLOW = join(HOME, '.claude/skills/kr-flow/scripts/main.py');
              const raw = execFileSync('python3', [KRFLOW, 'futures-rt', '--json'],
                { encoding: 'utf-8', timeout: 20_000, maxBuffer: 500_000 }).trim();
              const j = JSON.parse(raw.slice(raw.indexOf('{'))) as
                { code?: string; price?: number | null; change?: number | null; change_pct?: number | null; sign?: string };
              const note = 'KOSPI200 선물(근월물) 현재가·read-only(KIS via kr-flow skill·Conatus DIR 이탈). 장 사이엔 데이터 공백 가능.';
              if (j.price != null) {
                const arrow = j.sign === '1' || j.sign === '2' ? '🔺' : (j.sign === '4' || j.sign === '5' ? '🔻' : '');
                return { futures: `KOSPI200 선물(${j.code}): ${j.price} ${arrow}${j.change_pct ?? ''}% (대비 ${j.change ?? ''})`, note };
              }
              return { futures: `KOSPI200 선물(${j.code ?? '?'}) — 데이터 없음(장 휴장/근월물 코드 확인)`, note };
            } catch { /* fall through to Conatus python */ }
          }
          try {
            const out = execFileSync('python3', [join(CONATUS, 'screener', 'kis_futures.py')],
              { cwd: CONATUS, encoding: 'utf-8', timeout: 20_000, maxBuffer: 500_000 }).trim();
            return { futures: out || '(no data)', note: 'KOSPI200 선물(근월물) 현재가·read-only(KIS). 장 사이엔 데이터 공백 가능.' };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const dep = /KIS|credential|환경변수|Traceback/i.test(msg);
            return { error: dep ? 'KIS 세션 필요 — 크론/설정 컨텍스트에서 동작' : msg.slice(0, 120) };
          }
        }
        case 'finance_verify_gate': {
          // P8c — SESSION-AWARE read-only verify hard-gate. When no market is
          // tradeable, a broker-call failure is "장 마감"(normal), NOT a risk
          // BLOCK — so we report MARKET_CLOSED and skip the live checks. When a
          // market is open, all 3 verify_*.py must exit 0 (fail-closed: any
          // non-zero/error/no-broker-access → BLOCKED). Never executes a trade.
          const s = marketSessions();
          const runCheck = (script: string, scriptArgs: string[], label: string): { label: string; pass: boolean; detail: string } => {
            try {
              const out = execFileSync('python3', [join(CONATUS, 'screener', script), ...scriptArgs],
                { cwd: CONATUS, encoding: 'utf-8', timeout: 25_000, maxBuffer: 1_000_000 }).trim();
              return { label, pass: true, detail: (out.split('\n')[0] ?? '').slice(0, 120) };
            } catch (e) {
              const eo = e as { stdout?: string; stderr?: string; message?: string };
              return { label, pass: false, detail: String(eo.stdout || eo.stderr || eo.message || 'fail').split('\n')[0]!.slice(0, 120) };
            }
          };
          // 리스크 불변식·노출 정책은 config 기반이라 장 마감에도 유효(--show).
          const risk = runCheck('verify_risk_bounds.py', ['--show'], '리스크 불변식(본전/손절)');
          const exposurePolicy = runCheck('verify_exposure.py', ['--show'], '노출 상한 정책(effective ≤150%·계좌별)');
          if (!s.anyTradeable) {
            return {
              gate: 'MARKET_CLOSED',
              session: `KR ${s.kr} · US ${s.us}`,
              risk_invariant: risk,
              exposure_policy: exposurePolicy,
              note: `[read-only 조회] 지금은 매매 시간 아님(KR ${s.kr}·US ${s.us}) → 게이트는 개장 시 유효. 포지션/체결/노출 검증은 브로커 세션(장중)이 필요해 지금은 평가 보류(장 마감이라 정상 · 리스크 BLOCK 아님). 리스크/노출 정책(config)은 위 상태. 실 매매는 개장+CLEARED+HITL 승인 필수·에이전트는 주문 못 냄.`,
            };
          }
          // 장중: 전 관문 실행, fail-closed(4관문 전부 exit0일 때만 CLEARED).
          const position = runCheck('verify_position.py', [], '포지션 정합(브로커 대조)');
          const order = runCheck('verify_order_filled.py', [], '주문 체결 정합');
          const exposure = runCheck('verify_exposure.py', [], '노출 상한(effective 노출 ≤ 150%·계좌별)');
          const checks = [risk, position, order, exposure];
          const cleared = checks.every(c => c.pass);
          return {
            gate: cleared ? 'CLEARED' : 'BLOCKED',
            session: `KR ${s.kr} · US ${s.us}`,
            checks,
            note: `verify 하드게이트(read-only·fail-closed·장중). CLEARED = 4관문(리스크·포지션·체결·노출) 전부 통과 시에만 · BLOCKED이면 매매 불가(브로커 조회 실패·노출 초과도 BLOCKED). ⚠️ 조회 전용·주문 집행 없음. 실 매매는 CLEARED + HITL 사람 승인 필수(에이전트는 주문 못 냄).`,
          };
        }
        case 'finance_signals': {
          // P7b — Conatus 데이터/신호 스크립트 read-only 조회. 하나씩(kind)
          // 실행(4종 동시는 느림). screen은 --no-send로 발송 억제. 발송/매매
          // 없음. KIS 의존은 fail-soft.
          const kind = String(args.kind ?? '').trim();
          const MAP: Record<string, string[]> = {
            sector_flow: ['sector_flow.py'],
            trend: ['trend.py'],
            screen: ['screen.py', '--no-send'],
            factor: ['factor_research.py'],
          };
          const argv = MAP[kind];
          if (!argv) return { error: `unknown kind: '${kind}'. use sector_flow|trend|screen|factor` };
          // 파리티 검증된 TS 포트 라우팅(config flag·기본 false → python 경로 불변).
          // screen/trend/factor 만 커버 — sector_flow 는 포트 미커버라 항상 python(RETIRE-later).
          // READ-ONLY: runScreens=캐시 패널만·computeTrend=screener.db readonly·factor=캐시 JSON. write 없음.
          if (conatusNativePortEnabled() && kind !== 'sector_flow') {
            try {
              let report: string;
              if (kind === 'screen') report = conatusScreenReportMd(runScreens());
              else if (kind === 'trend') report = conatusTrendRender(computeTrend());
              else report = conatusFactorResearch(loadFullPanel()).render(); // factor
              return { kind, report: report.slice(0, 4000) || '(no output)', note: 'Conatus 신호 스크립트 read-only 조회(발송 없음). 매매는 verify+HITL. [conatus-native TS 포트]' };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const dep = /KIS|toss|credential|session|환경변수|Traceback/i.test(msg);
              return { kind, error: dep ? 'KIS/외부 세션 필요 — 크론 컨텍스트에서 동작' : msg.slice(0, 150) };
            }
          }
          try {
            const out = execFileSync('python3', [join(CONATUS, 'screener', argv[0]!), ...argv.slice(1)],
              { cwd: CONATUS, encoding: 'utf-8', timeout: 90_000, maxBuffer: 4_000_000 }).trim();
            return { kind, report: out.slice(0, 4000) || '(no output)', note: 'Conatus 신호 스크립트 read-only 조회(발송 없음). 매매는 verify+HITL.' };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const dep = /KIS|toss|credential|session|환경변수|Traceback/i.test(msg);
            return { kind, error: dep ? 'KIS/외부 세션 필요 — 크론 컨텍스트에서 동작' : msg.slice(0, 150) };
          }
        }
        case 'finance_alerts': {
          // P7a — Conatus 알림 5뷰(스크립트 4종 · koru_tp=--status/--gap 2뷰)
          // read-only 조회. 뷰 목록은 FINANCE_ALERT_VIEWS(SoT). 각 스크립트의
          // --status/--gap 경로는 print+return(주문/발송 없음) 확인됨. Toss 의존
          // 스크립트는 세션 없으면 fail-soft(크론 컨텍스트에서 동작).
          const alertEnv = { ...process.env, ...conatusEnv() }; // 토스 자격 주입
          const alerts = FINANCE_ALERT_VIEWS.map(a => {
            try {
              const out = execFileSync('python3', [join(CONATUS, 'screener', `${a.s}.py`), ...a.args],
                { cwd: CONATUS, encoding: 'utf-8', timeout: 20_000, maxBuffer: 1_000_000, env: alertEnv }).trim();
              return { alert: a.s, label: a.label, status: out.slice(0, 600) || '(no output)' };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const tossDep = /TossAPI|toss|holdings|credential|session|Traceback/i.test(msg);
              return { alert: a.s, label: a.label, status: tossDep ? '(Toss 세션 필요 — 자격/세션 확인)' : `(unavailable: ${msg.slice(0, 80)})` };
            }
          });
          return { alerts, note: 'Conatus 알림 현재 상태(read-only·주문/발송 없음). koru_tp_alert 익절($620~800)/방어($485~400)+갭예측(EWY) · swing 급변동 · catalyst 촉매 · lev_stop. Toss 자격은 CONATUS/.env 주입. 실 알림은 크론이 /v1/outbound(L5) 발송. 매매는 verify+HITL.' };
        }

        case 'finance_quote': {
          const symbol = String(args.symbol || '').trim();
          if (!symbol) return { error: 'symbol 필요(예: 005930.KO·KORU.US·KS11.INDX)' };
          const q = marketQuote(symbol);
          return {
            summary: formatMarketQuote(q),
            symbol: q.symbol, market: q.market, price: q.price, previousClose: q.prevClose,
            change_pct: q.changePct, high: q.high, source: q.source, session: q.session,
            freshness: q.freshness, ...(q.note ? { note: q.note } : {}),
            guide: '세션·휴일 보고 최적 API 자동선택한 단일 권위 시세. freshness=live면 실시간, eod면 마감 종가. note의 catch-up/NXT 주의사항을 답변에 반영할 것.',
          };
        }

        case 'finance_koru_swing': {
          // KORU 550주 스윙 §1 익절 래더 + §4 동적 트레일링 손절. 현재가로 highwater
          // 갱신(트레일링 상향) → 손절선 동적 산출 + 익절 래더 트리거. READ-ONLY.
          let current = Number(args.current);
          let sessHigh: number | undefined;  // 오늘 세션 고가(트레일링 highwater 교정)
          let refPrice: number | undefined;  // 주간거래 기준가(전일종가) → Blue Ocean ±20% 리밋
          let koruSrc = 'manual';
          const km = marketSessions();
          if (!(current > 0)) {
            // 토스 우선(전 세션 라이브: US 정규·주간거래). 실패 시 EODHD.
            if (km.usLive || km.usOvernight) {
              const t = fetchTossQuote('KORU'); if (t) { current = t.last; sessHigh = t.high; refPrice = t.prevClose; koruSrc = km.usOvernight ? '토스주간' : '토스'; }
            }
            if (!(current > 0)) { const q = omniQuote('KORU.US'); if (q) { current = q.close; sessHigh = q.high; refPrice = q.previousClose; koruSrc = 'EODHD'; } }
          }
          if (!(current > 0)) return { error: 'KORU 현재가 조회 실패 — current 인자로 지정 가능(예: {"current":544})' };
          // 주간거래 세션에서만 Blue Ocean ±20% 리밋 적용(정규장은 리밋 없음).
          const e = evaluateKoruSwing(current, new Date().toISOString(), undefined, sessHigh, km.usOvernight ? refPrice : undefined);
          return {
            current: e.current,
            price_source: koruSrc,  // 토스주간(한국 낮 Blue Ocean) · 토스 · EODHD · manual
            highwater: e.state.highwater,
            ...(e.sessionLimit ? { session_limit: { ref: Math.round(e.sessionLimit.refPrice), upper: Math.round(e.sessionLimit.upper), lower: Math.round(e.sessionLimit.lower), at_upper: e.sessionLimit.atUpper } } : {}),
            ladder: {
              triggered: e.ladder.triggered.map(r => ({ level: r.level, sellQty: r.sellQty, remaining: r.remaining, ...(r.note ? { note: r.note } : {}) })),
              next: e.ladder.nextRung ? { level: e.ladder.nextRung.level, sellQty: e.ladder.nextRung.sellQty } : null,
              already_fired: e.state.firedLadder,
            },
            trailing: {
              trim25: Math.round(e.stops.trim25), trim50: Math.round(e.stops.trim50),
              exitAll: Math.round(e.stops.exitAll), action: e.stops.action, entry_floor: e.stops.entryFloorApplied,
            },
            order_plan: formatOrderPlan(e),
            note: `${e.stops.note} | 익절 래더 발동=해당 물량 매도 후보·손절 액션은 READ-ONLY 판단. highwater는 조회마다 상향 갱신(동적 트레일링). 실 매도/청산은 증권사 예약주문/스톱로스(실시간)·verify+HITL. order_plan=삼성증권 세팅 가이드(복붙용).`,
          };
        }
        case 'finance_ontology': {
          if (!existsSync(knowledgeDbPath())) return { error: 'knowledge.db 없음 — 온톨로지 미구축(bun scripts/kg-ontology-build.ts).' };
          const db = openKgDb();
          try {
            const op = String(args.op ?? 'recall');
            const nm = (id: string): string => getNode(db, id)?.name ?? id;
            if (op === 'cluster') {
              const c = recallCluster(db, String(args.node ?? ''));
              if (!c) return { error: `클러스터 없음: ${args.node} (예: chain:반도체·group:P7)` };
              return { op, cluster: c.name, subclusters: c.subclusters.map(nm), members: c.members.map(nm), count: c.members.length, note: '산업 클러스터 서브그래프. READ-ONLY.' };
            }
            if (op === 'blast') {
              const node = String(args.node ?? '');
              if (!getNode(db, node)) return { error: `노드 없음: ${node}` };
              const hits = blastRadius(db, node, { regime: args.regime ? String(args.regime) : undefined });
              return { op, trigger: nm(node), regime: args.regime ?? null, impact: hits.slice(0, 15).map(h => ({ node: nm(h.node), dir: h.weight > 0 ? '▲' : '▼', weight: h.weight, hop: h.hop, etaDays: h.lag })), note: '영향 범위(부호 전파·거리 감쇠·시차). READ-ONLY 판단.' };
            }
            if (op === 'corr') {
              const es = getEdges(db, { relation: 'correlates', activeOnly: true });
              return { op, count: es.length, correlations: es.map(e => ({ from: nm(e.src), to: nm(e.dst), weight: e.weight, leadLag: e.leadLag ?? 0, regime: e.regimeAt ?? null })), note: '측정된 시계열 상관(±·양=동조·음=역관계).' };
            }
            if (op === 'list') {
              const kind = args.kind ? String(args.kind) : undefined;
              const nodes = listNodes(db, kind ? { kind: kind as never } : {});
              return { op, kind: kind ?? 'all', count: nodes.length, nodes: nodes.slice(0, 60).map(n => ({ id: n.id, name: n.name, market: n.market })) };
            }
            // recall (기본)
            const r = recallHybrid(db, { query: args.query ? String(args.query) : undefined, regime: args.regime ? String(args.regime) : undefined, bump: false });
            return {
              op: 'recall', query: args.query ?? null,
              seeds: r.seeds.map(nm),
              clusters: r.clusters.map(c => ({ name: c.name, members: c.members.length, subclusters: c.subclusters.length })),
              causal: r.causal.slice(0, 12).map(h => ({ node: nm(h.node), dir: h.weight > 0 ? '▲' : '▼', weight: h.weight })),
              note: '온톨로지 hybrid 회상(클러스터+인과 확장). READ-ONLY.',
            };
          } finally { db.close(); }
        }
        case 'finance_bt_loop': {
          if (!existsSync(BACKTEST_DB_PATH)) return { error: 'backtest.db 없음 — 백테스팅 루프 미실행(bun scripts/backtest-cycle.ts·평일 20:00 크론).' };
          const db = openBacktestDb();
          try {
            const op = String(args.op ?? 'summary');
            const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
            if (op === 'experiments') {
              const xs = listExperiments(db, { limit });
              return { op, count: xs.length, experiments: xs.map(x => {
                const r = latestResult(db, x.id);
                return { id: x.id, runDate: x.runDate, concept: x.concept, strategy: x.strategy, hypothesis: x.hypothesis, verdict: r?.verdict ?? '미검증', sharpe: r?.sharpe != null ? Number(r.sharpe.toFixed(2)) : null, pbo: r?.pbo != null ? Number(r.pbo.toFixed(2)) : null };
              }), note: '장중 백테스팅 실험(verdict=CONFIRMED만 페이퍼 승격). READ-ONLY.' };
            }
            if (op === 'promotions') {
              const rows = db.prepare(`SELECT * FROM promotions ORDER BY ts DESC LIMIT ?`).all(limit) as any[];
              return { op, count: rows.length, promotions: rows.map(r => ({ ts: r.ts, expId: r.exp_id, stage: r.stage, reason: r.reason, fund: r.fund, decidedBy: r.decided_by })), note: '승격 사다리(paper→live-candidate→live-armed). 실집행은 대표 arm 게이트.' };
            }
            if (op === 'paper') {
              const expId = String(args.expId ?? '');
              if (!expId) return { error: 'paper op은 expId 필요.' };
              const s = summarizePaper(db, expId);
              return { op, expId, fills: s.fills, observeDays: s.observeDays, meanRho: Number(s.meanRho.toFixed(3)), meanSlippageBps: Number(s.meanSlippageBps.toFixed(1)), meanGapBps: Number(s.meanGapBps.toFixed(1)), note: 'ρ=장중 포착률(1=완벽). 관찰 20 거래일+ρ 손익분기 시 실자금 후보.' };
            }
            if (op === 'oos') {
              const s = oosStats(db, { sinceDays: 90, now: new Date().toISOString() });
              const conf = gateConfidence(s);
              return { op, n: s.n, hitRate: Number(s.hitRate.toFixed(3)), meanForward: Number(s.meanForward.toFixed(4)), ic: Number(s.ic.toFixed(3)), hitRateByHorizon: s.hitRateByHorizon, gateConfidence: conf.level, confidenceNote: conf.note, note: 'OOS 검증(페이퍼 CONFIRMED 예측 vs 실제 forward). gateConfidence low=과최적화 확정·게이트 강화 필요. n=0=아직 horizon 미경과.' };
            }
            // summary (기본) — 오늘 실험 종합.
            const today = new Date().toISOString().slice(0, 10);
            const todayExps = listExperiments(db, { runDate: today, limit: 50 });
            const byVerdict: Record<string, number> = {};
            for (const x of todayExps) { const v = latestResult(db, x.id)?.verdict ?? '미검증'; byVerdict[v] = (byVerdict[v] ?? 0) + 1; }
            const promoCount = (db.prepare(`SELECT COUNT(*) c FROM promotions WHERE date(ts)=date('now')`).get() as any)?.c ?? 0;
            return { op: 'summary', runDate: today, experiments: todayExps.length, byVerdict, promotionsToday: promoCount, note: '백테스팅 루프 오늘 종합(페이퍼·disarmed·매매 격리). experiments op으로 상세.' };
          } finally { db.close(); }
        }
        case 'finance_loops': {
          const data = dashboardLoops();
          if (!data || data.loops.length === 0) return { loops: [], note: '자율 루프 run 기록 없음(아직 미발화·dig_goal_runs/replay_runs/backtest.db 부재).' };
          return {
            loops: data.loops.map(l => ({
              name: l.name, label: l.label,
              armed: l.armed === null ? '(해당없음)' : l.armed ? 'armed' : 'disarmed',
              today: l.today, byStatus: l.byStatus,
              last: l.last ? `${l.last.status} @ ${l.last.at}${l.last.detail ? ` (${l.last.detail})` : ''}` : '기록 없음',
            })),
            note: '세 자율 루프 run 상태(READ-ONLY). armed=대표 게이트 통과·실집행은 별도 매매 arm. dig/replay=goal-armer·backtest=장중 사이클.',
          };
        }
        default:
          return { error: `unknown finance tool: ${name}` };
      }
    } catch (e) {
      return { error: `finance tool ${name} failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
    }
  };
  return { specs: FINANCE_TOOL_SPECS, dispatch, names };
}
