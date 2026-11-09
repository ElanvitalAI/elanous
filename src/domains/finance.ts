// ── Finance / Conatus domain pack (A0, 2026-07-05) ──────────────────
//
// The investment capability is an OPTIONAL domain pack gated by
// `cfg.finance.enabled`. Core stays generic; when disabled, none of this
// loads and the agent is a plain assistant. When enabled, the pack
// contributes (today) an analyst orientation + a per-deployment resource
// map, and (A1, later) first-class finance tool rules registered through
// this same module. See docs/ROADMAP-conatus-elanous-knowledge-absorption.
//
// This is the single seam where finance/Conatus capability attaches to
// the core — keep additions here so the pack stays cleanly removable.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserConfig } from '../user-config/types.js';
import { elanousDaemonDir } from '../elanous-daemon.js';
import { isKrHoliday, isUsHoliday, isUsEarlyClose, US_MARKET_TIME_ZONE } from './market-holidays.js';

/** Master gate for the finance/Conatus domain pack. */
export function financeEnabled(cfg: UserConfig): boolean {
  return cfg.finance?.enabled === true;
}

/** Optional per-deployment resource map (concrete DB/skill/Conatus paths +
 *  copy-paste commands) so the agent goes straight to the data instead of
 *  slow `find`/`ls` discovery. Portable: committed code just reads the file
 *  if present; absent = discovery mode. */
export const FINANCE_RESOURCE_MAP_BASENAME = 'finance-resources.md';

export function loadFinanceResourceMap(dir: string = elanousDaemonDir()): string {
  try {
    const p = join(dir, FINANCE_RESOURCE_MAP_BASENAME);
    if (existsSync(p)) return readFileSync(p, 'utf-8').trim();
  } catch { /* optional — absence just means discovery mode */ }
  return '';
}

/** Analyst orientation — the finance pack's system-prompt contribution.
 *  Portable (no machine paths; the resource map supplies specifics). Hard-
 *  guards trades: pull real data, read-only on Conatus, NEVER execute. */
export const FINANCE_ANALYST_PROMPT = [
  'You are the user\'s market/investment assistant, reachable over Telegram with',
  'full shell, file, and web-search tools on their machine (a Tailscale fleet).',
  '',
  'For any market / stock / asset question:',
  '- Do NOT answer from memory. PULL REAL DATA first.',
  '- ★ 시세(현재가/등락)는 **무조건 `finance_quote` 도구** 하나로만 조회한다.',
  '  omni-market `quote`·kr-flow `price` 를 직접(Bash/스킬로) 부르지 말 것 — 그것들은',
  '  세션별로 잘못된 소스를 골라(NXT 프리에 정규장 종가·US 휴장 catch-up 오독) 시장을',
  '  오독하게 만든다. finance_quote 는 심볼+마켓클락(세션·휴일)을 보고 **그 순간 맞는',
  '  API(토스/EODHD/Yahoo)를 자동선택**하고 source·session·freshness(live/eod)·휴일',
  '  catch-up 을 라벨한다. 답변엔 finance_quote 의 freshness 와 note(NXT/catch-up)를',
  '  그대로 반영하고 세션을 명시("KR NXT 실시간", "장 마감·종가 기준")할 것.',
  '    • freshness=eod(전 세션 마감)면 "장 마감·종가 기준" 이라 밝힌다.',
  '    • Never present an EOD close as if it were live during an open session.',
  '  The clock also carries a "컨텍스트:" recipe — the dominant live session',
  '  decides WHICH signals lead (overnight US→KR open, US-live drives, etc.).',
  '  FOLLOW it: proactively pull those named sources (US 선물·USDKRW·ADR·VIX…)',
  '  before answering, rather than only the single symbol asked about.',
  '  KR NXT(넥스트트레이드) extends trading to 08:00-20:00 (프리 08:00-08:50 ·',
  '  정규 09:00-15:30 · 종가매매 15:30-16:00 · 애프터 15:40-20:00) for its ~600',
  '  eligible 우량주 — so KRX-closed does NOT mean a KR name is untradeable; check',
  '  the NXT window. But trade intent, in ANY session, still goes through the',
  '  verify + mandate gate below — session-open NEVER means auto-execute.',
  '- Prefer the first-class finance_* tools (finance_market_backbone,',
  '  finance_attractiveness, conatus_position, finance_region) over raw Bash',
  '  for those queries — they are faster + structured. Bash for anything else.',
  '- For a BROAD "지금 시장 종합/전반/큰 그림" question, call finance_monitor',
  '  ONCE (backbone+회전+국가/섹터 매력도+13F in one shot) instead of chaining',
  '  the individual tools. Use the focused tools for a specific slice.',
  '- ★ 한국 종목 투자자 수급(외국인/기관/개인 순매수·보유비중·공매도·시장별',
  '  자금흐름)은 **무조건 `finance_kr_flow` 도구**로 조회한다(한국투자증권 실시간',
  '  T+0). kr-flow 스킬을 Bash로 직접 부르지 말 것. 개별종목="외국인 순매수/수급/',
  '  기관 매수/보유비중"→command:foreign-net|investor|price(+6자리 symbol), 시장',
  '  전반="코스피 수급/외국인이 뭐 담나"→command:market-flow|frgn-institution.',
  '  13F(finance_13f·sector-fusion)는 미국 기관이고, 한국 수급은 이 도구가 유일.',
  '- ★ 과거에 **내가(elanous가) 보낸 알림/신호/통지**를 되짚는 질문("방금/아까 무슨',
  '  알림 보냈지"·"삼성 수급 관련 알림 있었나"·"전에 뭐라 알려줬지"·워치/속보/',
  '  다이제스트 회상)은 **무조건 `memory_recall` 도구 먼저**. 발송 전용 채널로 나간',
  '  것도 여기 원장에 있으니, 모른다고 반문하지 말고 먼저 회상할 것. (시세=finance_quote·',
  '  과거 유사국면 벡터검색=finance_knowledge와 구분: memory_recall은 "내가 보낸 것".)',
  '- Be ECONOMICAL on the HAPPY PATH: when the local DB / finance_* tools fully',
  '  answer the question, prefer one targeted query — do not explore aimlessly.',
  '- BUT when your data has GAPS or is possibly STALE — an empty field (Revenue/',
  '  Beta blank), a suspected earnings lag ("최근 실적 미반영?"), or the question',
  '  needs CURRENT facts (recent earnings, NAND/DRAM price, a price-moving event,',
  '  a just-listed/spun-off ticker) — CHAIN a `WebSearch` yourself in the SAME',
  '  turn to fill/verify, THEN answer. Do NOT stop and ask "웹으로 찾아드릴까요?"',
  '  — proactively verify, and if the web contradicts the DB, correct yourself',
  '  and say so. WebSearch is provider-backed (Tavily first — cheap+fast; Grok',
  '  Agent-Tools·Firecrawl fallback); pair with WebFetch/Bash for a full source body.',
  '- If a resource map is provided below, use those exact paths/commands',
  '  directly. Otherwise discover with `find`/`ls` (slower — last resort).',
  '- The user runs a live trading system ("Conatus"). You MAY READ its screener',
  '  outputs, positions, and verify-gate status. READ ONLY.',
  '- Cite what you queried (date, source) so the user can trust it. Korean by default.',
  '',
  'HARD RULE (trade execution) — do NOT place ad-hoc/one-off trades from a chat',
  'message, do NOT bypass the mandate gates, and do NOT wire unsanctioned order',
  'scripts. Autonomous execution is sanctioned ONLY through the owner-armed',
  'mandate (finance-trade-mandate.json: armed+live) via the mandate-gated cycle',
  '(scripts/trade-autonomous-cycle.ts) — which self-enforces the verify +',
  'market-clock + mandate gates on every order. When the OWNER explicitly asks,',
  'you MAY register/adopt THAT mandate-gated cycle as a schedule (schedule_manage) —',
  'it is the sanctioned path, not an ad-hoc trade. For any OTHER trade request,',
  'or to place a one-off order yourself now, stop at analysis/recommendation.',
].join('\n');

/** The finance pack's full system-prompt contribution: analyst orientation
 *  + the resource map (when the file exists). Callers fold this into the
 *  turn's system prompt ONLY when `financeEnabled(cfg)`. */
export function financeAgentSystemPrompt(): string {
  const resources = loadFinanceResourceMap();
  return resources
    ? `${FINANCE_ANALYST_PROMPT}\n\n## Resource map (this machine — use these directly, do NOT search)\n${resources}`
    : FINANCE_ANALYST_PROMPT;
}

// ── Market clock (2026-07-05) — the agent must ACTIVELY know the current
// time + which sessions are open before any timing/entry/screening call.
// Injected fresh PER TURN (a static prompt would go stale). Weekend +
// regular/extended hours + HOLIDAY calendar (src/domains/market-holidays.ts).

interface TzNow { label: string; date: string; weekday: string; minutes: number; isWeekday: boolean; }

function tzNow(now: Date, timeZone: string): TzNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some locales render midnight as 24
  const minute = parseInt(get('minute'), 10);
  const weekday = get('weekday');
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return {
    label: `${date} ${weekday} ${String(hour).padStart(2, '0')}:${get('minute')} `,
    date,
    weekday,
    minutes: hour * 60 + minute,
    isWeekday: !['Sat', 'Sun'].includes(weekday),
  };
}

/** Time-of-session → what CONTEXT to actively gather right now. This is the
 *  "알아서 컨텍스트 더 가져오는 구조": the dominant live session decides which
 *  external signals lead (overnight US → KR open, US live drives, etc.). The
 *  agent reads this and proactively pulls the named sources. */
function contextRecipe(kr: string, us: string): string {
  if (us.startsWith('OPEN')) return '컨텍스트: 미국 정규장이 지금 주 드라이버 — S&P/나스닥/다우·VIX·주도 섹터/개별주 실시간, 한국물(삼성/하이닉스 ADR·KODEX)로 익일 KR 파급 선판단.';
  if (us === 'PRE') return '컨텍스트: 미국 프리장 — 야간 선물(ES/NQ)·프리 무버·간밤 뉴스로 미국 정규 개장 방향, 한국물 영향 병행.';
  if (us === 'AFTER') return '컨텍스트: 미국 애프터장 — 실적/뉴스 반응 개별주·애프터 무버 확인, 익일 KR/US 시선.';
  if (kr === 'NXT프리' || kr === '장전동시호가') return '컨텍스트: KR 개장 앞(NXT 프리/동시호가) — 밤사이 US 종가·US 선물(ES/NQ)·USDKRW·주요 ADR(삼성/하이닉스)로 KR 개장 방향 선판단.';
  if (kr === 'OPEN') return '컨텍스트: KR 정규장 실시간 드라이버 — KR 지수·수급(외국인/기관)·US 선물(간밤 방향)·USDKRW 병행.';
  if (kr === '종가매매' || kr === 'NXT애프터') return '컨텍스트: KR 시간외(종가매매/NXT 애프터) — 정규 종가 대비 시간외 흐름 + US 선물로 익일 시선.';
  return '컨텍스트: 전 세션 마감 — 다음 개장 대비 마지막 종가·주말/야간 이벤트·경제 캘린더 확인.';
}

export interface MarketSessions {
  kr: string; us: string;
  krLive: boolean; usLive: boolean;
  /** US 주간거래(Blue Ocean ATS) 진행중 — 한국 낮 시간 US 거래 가능. EODHD 는
   *  이 세션 미커버(마지막 ET 종가만) → 라이브 시세는 토스 필요. usLive 와 배타. */
  usOvernight: boolean;
  /** KR in a continuous/auction EXECUTION window (장전동시호가 = order entry, excluded). */
  krTradeable: boolean;
  /** Any market in a tradeable window right now (KR NXT/정규/종가 or US 프리/정규/애프터). */
  anyTradeable: boolean;
  krHoliday: boolean; usHoliday: boolean;
  kstLabel: string; etLabel: string;
}

/** Structured session state — the single source of truth the clock string AND
 *  session-aware callers (e.g. the verify gate) share. Weekend + NXT extended
 *  hours + KRX/NYSE holiday calendar. */
export function marketSessions(now: Date = new Date()): MarketSessions {
  const kst = tzNow(now, 'Asia/Seoul');
  const et = tzNow(now, US_MARKET_TIME_ZONE);  // 계약 상수(market-holidays) — 캘린더와 동기화
  const inWin = (t: TzNow, from: number, to: number) => t.isWeekday && t.minutes >= from && t.minutes <= to;
  const krHol = isKrHoliday(kst.date);
  const usHol = isUsHoliday(et.date);
  const usEarly = isUsEarlyClose(et.date); // regular ends 13:00 ET (780)
  // KR (NXT 넥스트트레이드 08:00-20:00, 대상 우량주 ~600).
  const m = kst.minutes;
  const kr = krHol ? 'CLOSED(휴장)'
    : !kst.isWeekday ? 'CLOSED'
    : m >= 480 && m < 530 ? 'NXT프리'          // 08:00-08:50
    : m >= 530 && m < 540 ? '장전동시호가'      // 08:50-09:00
    : m >= 540 && m <= 930 ? 'OPEN'            // 09:00-15:30 정규
    : m > 930 && m <= 960 ? '종가매매'          // 15:30-16:00
    : m > 960 && m <= 1200 ? 'NXT애프터'        // 16:00-20:00
    : 'CLOSED';
  // US: 프리 04:00-09:30 · 정규 09:30-16:00(조기폐장 13:00) · 애프터 16:00-20:00 (ET).
  const usRegClose = usEarly ? 780 : 960;
  const usReg = !usHol && inWin(et, 570, usRegClose);
  const us = usHol ? 'CLOSED(휴장)'
    : usReg ? (usEarly ? 'OPEN(조기폐장13:00)' : 'OPEN')
    : (inWin(et, 240, 570) ? 'PRE' : (inWin(et, 960, 1200) && !usEarly ? 'AFTER' : 'CLOSED'));
  const usLive = !us.startsWith('CLOSED');
  const krLive = !kr.startsWith('CLOSED');
  const krTradeable = krLive && kr !== '장전동시호가';
  // Blue Ocean ATS 오버나이트(한국 낮 US 주간거래): ET 20:00-04:00 = KST 09:00-17:00
  // (DST) / 10:00-18:00 (표준시). DST 판정: US DST면 KST-ET = 13h(780분). US ET
  // 세션이 CLOSED 인 KST 낮 평일 구간(EODHD 미커버 → 토스 라이브 필요).
  const dstUs = ((kst.minutes - et.minutes + 1440) % 1440) === 780;
  const boFrom = dstUs ? 540 : 600;   // 09:00 / 10:00 KST
  const boTo = dstUs ? 1020 : 1080;   // 17:00 / 18:00 KST
  const usOvernight = kst.isWeekday && !us.startsWith('OPEN') && us !== 'PRE' && us !== 'AFTER'
    && m >= boFrom && m < boTo;
  const usDisplay = usOvernight && us.startsWith('CLOSED') ? 'OVERNIGHT(주간거래)' : us;
  return {
    kr, us: usDisplay, krLive, usLive, usOvernight, krTradeable,
    anyTradeable: krTradeable || usLive || usOvernight,
    krHoliday: krHol, usHoliday: usHol,
    kstLabel: kst.label, etLabel: et.label,
  };
}

/** Current time (KST/ET) + session state + data-freshness + context recipe.
 *  Injected fresh every finance turn (ambient PUSH — the agent never asks the
 *  time). KR includes NXT(넥스트트레이드) extended hours + KRX/NYSE holiday
 *  calendar (market-holidays.ts). */
export function marketClock(now: Date = new Date()): string {
  const s = marketSessions(now);
  const { kr, us, krLive, usLive, usOvernight, krTradeable, krHoliday: krHol, usHoliday: usHol } = s;
  // KR NXT(정규 외 라이브: 08-09시·15:30-20시) + US 주간거래는 omni-market
  // (Yahoo/EODHD) 미커버 → 그 구간 quote 는 직전 종가라 신뢰 금지. 토스가 라이브.
  const krNxtLive = krLive && kr !== 'OPEN';
  const staleWarn = (krNxtLive || usOvernight)
    ? ` ⚠️ ${[krNxtLive ? 'KR NXT' : '', usOvernight ? 'US 주간거래' : ''].filter(Boolean).join('·')}는 omni-market(Yahoo/EODHD·.KS/.US quote)·한투 정규(J) 코드가 미커버라 직전 종가를 반환(현재가 아님) → **토스 시세(kr-flow toss-price / KIS NX 코드)를 사용**. 실시간이라 착각 말 것.`
    : '';
  const dataDirective = usLive || krLive || usOvernight
    ? `데이터: ${[krLive ? `KR ${kr}` : '', usLive ? `US ${us}` : '', usOvernight ? 'US 주간거래(Blue Ocean)' : ''].filter(Boolean).join('·')} 진행중 → 실시간 시세 우선·현재가/등락 기준으로 답하고 세션을 명시.${staleWarn} 종가(EOD)만 쓰면 밝힐 것.`
    : `데이터: 전 세션 ${krHol || usHol ? '휴장/마감' : 'CLOSED'} → 마지막 종가(EOD) 기준. 답변에 "장 마감·종가 기준" 명시.`;
  const holidayNote = krHol || usHol
    ? ` · 휴장: ${[krHol ? 'KRX' : '', usHol ? 'NYSE' : ''].filter(Boolean).join('·')}`
    : '';
  // KORU(3X, NYSE) tracks the US session; KODEX(2X, KRX) tracks KR (NXT 포함).
  return [
    `⏰ 지금: ${s.kstLabel}KST / ${s.etLabel}ET`,
    `세션: KR ${kr} · US ${us} · KORU(NYSE)=${us} · KODEX(KRX)=${kr}${krTradeable ? ' · KR NXT 매매가능(대상 우량주~600)' : ''}${holidayNote}`,
    dataDirective,
    contextRecipe(kr, us),
    `(휴장 캘린더 반영: NYSE 2026-27·KRX 2026 · 그 외 연도는 미확인이니 최종 확인 · 이 세션 상태로 데이터/타이밍/수집 컨텍스트를 먼저 정함)`,
  ].join('\n');
}
