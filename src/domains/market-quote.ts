// ── 통합 시세 라우터 (세션·휴일 인지 · 최적 API 자동선택) ──────────────
//
// 심볼 + 마켓클락(세션·휴일)을 보고 **그 순간 맞는 API**에서 라이브 시세를 가져와
// 소스·세션·신선도·휴일 catch-up 까지 라벨링하는 **단일 권위 경로**. omni-market/
// kr-flow 를 그때그때 잘못 고르던 소동(예: NXT 프리에 정규장 종가, US 휴장 다음날
// catch-up 오독)을 끝낸다. 에이전트/도구/크론 모두 이걸로 통일.
//
// 라우팅(자동):
//   KR 주식(.KS/.KO/.KQ·6자리): 정규/NXT 진행중 → 토스 라이브 · 마감 → EODHD 종가
//   US 주식(.US·티커):          ET세션 → EODHD 실시간 · 주간거래(BO) → 토스 · 마감 → EODHD
//   지수(.INDX):                Yahoo · FX(.FOREX): EODHD  (토스 미지원 → omni)
// 토스 실패 시 EODHD fallback. 전 세션 마감이면 마지막 종가(freshness=eod 명시).

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { marketSessions, type MarketSessions } from './finance.js';
import { fetchTossQuote } from './toss-quote.js';
import { isUsHoliday, US_MARKET_TIME_ZONE } from './market-holidays.js';
import { dateKey } from '../time/calendar.js';

// 미국 시장 캘린더 시간대는 market-holidays.ts 가 계약으로 내보낸다(로컬 재정의 금지).
const US_MARKET_TZ = US_MARKET_TIME_ZONE;

const OMNI = join(homedir(), '.claude/skills/omni-market/scripts/main.ts');

export type QuoteSource = 'toss' | 'eodhd' | 'yahoo' | 'none';
export type MarketClass = 'kr-equity' | 'us-equity' | 'index' | 'fx' | 'unknown';

export interface MarketQuote {
  symbol: string;
  market: MarketClass;
  price: number | null;
  prevClose: number | null;
  changePct: number | null;
  high: number | null;
  /** 실제 데이터 출처. */
  source: QuoteSource;
  /** 현재 세션 라벨(KR/US). */
  session: string;
  /** 'live'(장중 실시간) | 'eod'(마감·종가). */
  freshness: 'live' | 'eod';
  /** 거래량 — omni(EODHD/Yahoo) 서빙 시 제공, 토스 라이브는 미제공(null). (C-②b) */
  volume?: number | null;
  /** 휴일·catch-up 등 주의. */
  note?: string;
}

/** 심볼 → 시장 분류. */
export function classify(symbol: string): MarketClass {
  const s = symbol.toUpperCase();
  const dot = s.lastIndexOf('.');
  const suf = dot >= 0 ? s.slice(dot + 1) : '';
  if (suf === 'INDX' || s.startsWith('^')) return 'index';
  if (suf === 'FOREX') return 'fx';
  if (['KS', 'KO', 'KQ', 'KRX'].includes(suf)) return 'kr-equity';
  if (/^\d{6}$/.test(s)) return 'kr-equity';        // 6자리 = KR
  if (suf === 'US') return 'us-equity';
  if (dot < 0 && /^[A-Z][A-Z0-9]*$/.test(s)) return 'us-equity'; // 순수 티커 = US
  return 'unknown';
}

/** omni-market CLI quote(toss/EODHD/Yahoo). Fail-soft null.
 *  ★ C-②a(2026-07-22) — 2건 수정:
 *   1) 런처 `npx tsx` → `bun`: 콜드스타트 0.55s→0.10s(실측 5배)·계약(stdout JSON) 불변. elanous 는
 *      이미 bun 구동·PATH 에 bun 존재. npx 캐시 소실 시 tsx 다운로드→네트워크 행(45s 타임아웃) 취약성 제거.
 *   2) provider 라벨 버그: 종전 `[provider]` 브래킷 regex 는 `--json` stdout 에 없어 **항상 'eodhd' 오라벨**
 *      (실측 AAPL.US·005930.KS 는 toss 서빙인데 eodhd 로 표기). 실제 출처는 JSON `session` 필드
 *      (예: "toss-live"·"yahoo-*")에 있으므로 그걸로 판별 — 제1원칙 자기 관측성(출처 정확). */
function omniQuote(symbol: string): { close: number; prevClose: number; changePct: number; high: number; volume: number | null; provider: QuoteSource } | null {
  try {
    const out = execFileSync('bun', [OMNI, 'quote', symbol, '--json'],
      { cwd: join(homedir(), '.claude/skills/omni-market'), env: process.env, encoding: 'utf-8', timeout: 45_000, maxBuffer: 4_000_000 });
    const m = /\{[\s\S]*?"close"[\s\S]*?\}/.exec(out);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (typeof j.close !== 'number') return null;
    // provider 판별 우선순위(C-②a2): omni-market `--json` provider 필드(정확·지수/FX 포함) →
    //   session 휴리스틱(provider 필드 없는 구버전 스킬 호환·주식 toss/yahoo) → eodhd 기본.
    const p = typeof j.provider === 'string' ? j.provider.toLowerCase() : '';
    const sess = typeof j.session === 'string' ? j.session.toLowerCase() : '';
    const src = p || sess;
    const provider: QuoteSource = src.includes('toss') ? 'toss' : src.includes('yahoo') ? 'yahoo' : 'eodhd';
    return {
      close: j.close,
      prevClose: Number(j.previousClose) || j.close,
      changePct: Number(j.change_p) || 0,
      high: Number(j.high) || j.close,
      volume: typeof j.volume === 'number' ? j.volume : null,
      provider,
    };
  } catch { return null; }
}

/** 통합 시세 — 세션·휴일 보고 최적 API 자동선택. now 주입 가능(결정성). */
export function marketQuote(symbol: string, now = new Date()): MarketQuote {
  const market = classify(symbol);
  const mkt: MarketSessions = marketSessions(now);
  const base: MarketQuote = { symbol, market, price: null, prevClose: null, changePct: null, high: null, source: 'none', session: '', freshness: 'eod' };

  // 지수·FX → omni(Yahoo/EODHD)
  if (market === 'index' || market === 'fx') {
    const q = omniQuote(symbol);
    if (!q) return { ...base, note: '조회 실패' };
    return { ...base, price: q.close, prevClose: q.prevClose, changePct: q.changePct, high: q.high, volume: q.volume,
      source: q.provider, session: market === 'index' ? '지수' : 'FX',
      freshness: (market === 'index' ? (mkt.usLive || mkt.krLive) : mkt.usLive) ? 'live' : 'eod' };
  }

  // KR 주식: 정규/NXT 진행중 → 토스 라이브, 마감 → EODHD 종가
  if (market === 'kr-equity') {
    if (mkt.krLive) {
      const t = fetchTossQuote(symbol);
      if (t) return { ...base, price: t.last, prevClose: t.prevClose ?? null, high: t.high,
        changePct: t.prevClose ? (t.last / t.prevClose - 1) * 100 : null,
        source: 'toss', session: `KR ${mkt.kr}`, freshness: 'live',
        note: mkt.kr !== 'OPEN' ? 'NXT(넥스트트레이드) — omni/한투J는 미커버·토스 라이브' : undefined };
    }
    const q = omniQuote(symbol);
    return q ? { ...base, price: q.close, prevClose: q.prevClose, changePct: q.changePct, high: q.high, volume: q.volume,
      source: q.provider, session: `KR ${mkt.kr}`, freshness: 'eod', note: mkt.krHoliday ? 'KRX 휴장' : '장 마감·종가' }
      : { ...base, session: `KR ${mkt.kr}`, note: '조회 실패' };
  }

  // US 주식: ET세션 → EODHD 실시간, 주간거래(BO) → 토스, 마감 → EODHD 종가
  if (market === 'us-equity') {
    // US 휴장 다음날 catch-up 인지(예: 07-03 휴장 → 월요일 US상장 한국ETF catch-up)
    //
    // 2026-07-24 — 종전 `now - 4h` 수동 오프셋은 두 가지로 틀렸다:
    //   (a) EST(겨울)는 -5h 라 11~3월에 하루 어긋날 수 있고,
    //   (b) 그 뒤 `toISOString().slice(0,10)` 이 다시 **UTC** 날짜를 뽑아 보정이 무의미했다.
    // `isUsHoliday` 계약은 America/New_York 날짜를 요구한다(market-holidays.ts:50).
    // ⚠️ 여기는 KST 가 아니라 **ET** 가 정답이다 — 사용자 시간대로 바꾸면 오히려 악화된다.
    // 전날 계산은 ET 날짜 문자열 위에서 UTC 산술로 — 날짜만 다루므로 DST 무손실.
    const etToday = dateKey(now, { timeZone: US_MARKET_TZ });
    const prevEt = new Date(`${etToday}T00:00:00Z`);
    prevEt.setUTCDate(prevEt.getUTCDate() - 1);
    const prevWasHoliday = isUsHoliday(prevEt.toISOString().slice(0, 10));
    const catchup = prevWasHoliday ? ' · ⚠️ 직전 US 휴장 → 오늘 catch-up(여러날 반영)' : '';
    if (mkt.usLive) {
      const q = omniQuote(symbol);
      if (q) return { ...base, price: q.close, prevClose: q.prevClose, changePct: q.changePct, high: q.high, volume: q.volume,
        source: q.provider, session: `US ${mkt.us}`, freshness: 'live', note: catchup || undefined };
    }
    if (mkt.usOvernight) {
      const t = fetchTossQuote(symbol);
      if (t) return { ...base, price: t.last, prevClose: t.prevClose ?? null, high: t.high,
        changePct: t.prevClose ? (t.last / t.prevClose - 1) * 100 : null,
        source: 'toss', session: 'US 주간거래(Blue Ocean)', freshness: 'live',
        note: `EODHD 미커버·토스 라이브${catchup}` };
    }
    const q = omniQuote(symbol);
    return q ? { ...base, price: q.close, prevClose: q.prevClose, changePct: q.changePct, high: q.high, volume: q.volume,
      source: q.provider, session: `US ${mkt.us}`, freshness: 'eod', note: (mkt.usHoliday ? 'NYSE 휴장' : '장 마감·종가') + catchup }
      : { ...base, session: `US ${mkt.us}`, note: '조회 실패' };
  }

  return { ...base, note: '심볼 분류 불가' };
}

/** 사람이 읽는 한 줄 요약. */
export function formatMarketQuote(q: MarketQuote): string {
  if (q.price == null) return `${q.symbol}: 조회 실패${q.note ? ` (${q.note})` : ''}`;
  const chg = q.changePct != null ? ` (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)` : '';
  const fresh = q.freshness === 'live' ? '🟢실시간' : '⚪종가';
  return `${q.symbol} ${q.price.toLocaleString()}${chg} · ${fresh}[${q.source}] · ${q.session}${q.note ? ` · ${q.note}` : ''}`;
}
