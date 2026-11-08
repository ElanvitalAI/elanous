import { textOnly } from '../llm/stream-text.js';
// ── US 머니무브 펄스 (2026-07-06 대표 지시) ─────────────────────────────
//
// "팔란티어가 6일째 오르고 있는데 … 미국장 머니무브·섹터 순환 체크가 원활하게
//  되어야 기회 포착" — 섹터 결산 + 눈에 띄는 종목(연속상승·급등락·거래량·신고가)
//  + LLM 해석을 두 시점에 발송:
//   ① 개장+30분 스냅샷 (섹터 ETF 라이브 — 결정론·해석 없음·빠르게)
//   ② 아침 결산 (US 마감 후 KST 06:35 — EOD 결산 + 종목 포착 + LLM 해석)
//
// 데이터: omni-market `bulk US --symbols <유니버스>` 1콜/일 → us_pulse.db 누적
// (스트릭/신고가/거래량 z 는 누적 히스토리에서 계산 · 백필 = --from 과거일 반복).
// 유니버스: ~/.elanous/conatus/us_universe.json (텔레그램 자연어 관리 가능).
// READ-ONLY 관찰 — 매매는 verify+HITL.

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getUserConfig } from '../user-config.js';
import { getProviderForConfig, anyProviderAvailable, type LLMMessage } from '../llm.js';
import { conatusPath } from './conatus-data-dir.js';

export const US_PULSE_DB = conatusPath('us_pulse.db');
export const US_UNIVERSE_PATH = conatusPath('us_universe.json');
export const PULSE_REPORTS_DIR = conatusPath('us_pulse');
const OMNI_SKILL = join(homedir(), '.claude/skills/omni-market');
const OMNI_MAIN = join(OMNI_SKILL, 'scripts/main.ts');

/** 섹터 SPDR 11종 — 결산·스냅샷의 축. */
export const SECTOR_ETFS: Record<string, string> = {
  XLK: '테크', XLC: '커뮤니케이션', XLY: '경기소비', XLF: '금융', XLI: '산업재',
  XLE: '에너지', XLV: '헬스케어', XLP: '필수소비', XLB: '소재', XLU: '유틸리티', XLRE: '리츠',
};
export const ANCHOR_ETFS: Record<string, string> = { SPY: 'S&P500', QQQ: '나스닥100', IWM: '러셀2000' };

/** 기본 종목 유니버스 — 메가캡·유동성·테마(AI/전력/방산/크립토) 대표주.
 *  대표 관심 순환축(semis|sw|power|crypto|commodity|defense) 커버. */
const DEFAULT_STOCKS = [
  // 메가캡/AI
  'NVDA', 'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'PLTR',
  // 반도체/하드웨어
  'TSM', 'MU', 'QCOM', 'ARM', 'SMCI', 'ANET', 'INTC', 'MRVL',
  // 소프트웨어
  'CRM', 'ORCL', 'ADBE', 'NOW', 'SNOW', 'CRWD', 'PANW', 'DDOG', 'NFLX',
  // 전력/인프라 (power)
  'VRT', 'ETN', 'GEV', 'CEG', 'VST',
  // 방산 (defense)
  'LMT', 'RTX', 'NOC', 'GD',
  // 금융/소비
  'JPM', 'GS', 'BAC', 'V', 'UBER', 'ABNB', 'HOOD', 'COIN',
  // 크립토/원자재/채권 프록시
  'MSTR', 'IBIT', 'GLD', 'SLV', 'USO', 'TLT', 'HYG',
  // 헬스/에너지 대표
  'LLY', 'UNH', 'XOM', 'CVX', 'CAT', 'DE', 'BA',
  // KR 프록시
  'EWY', 'KORU',
];

/** "눈에 띄는" 판별 기준 (대표 지시 2026-07-06 — 명시 기준·매일 축적 전제).
 *  us_universe.json 의 criteria 로 조정 가능 (텔레그램 자연어 관리). */
export interface Criteria {
  streakDays: number;   // 연속 상승/하락 일수 (기본 4)
  dailyPct: number;     // 일간 등락 % (기본 4)
  weeklyPct: number;    // 주간(5거래일) 등락 % (기본 8)
  volZ: number;         // 거래량 z-score 20d (기본 2.5 · 일간 ±2% 동반 시)
}
export const DEFAULT_CRITERIA: Criteria = { streakDays: 4, dailyPct: 4, weeklyPct: 8, volZ: 2.5 };

export interface Universe { sectors: string[]; anchors: string[]; stocks: string[]; criteria: Criteria }

export function loadUniverse(path: string = US_UNIVERSE_PATH): Universe {
  const def: Universe = { sectors: Object.keys(SECTOR_ETFS), anchors: Object.keys(ANCHOR_ETFS), stocks: DEFAULT_STOCKS, criteria: DEFAULT_CRITERIA };
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      return { ...def, ...raw, criteria: { ...DEFAULT_CRITERIA, ...(raw.criteria ?? {}) } };
    }
  } catch { /* fall through */ }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(def, null, 2));
  return def;
}

export function allSymbols(u: Universe): string[] {
  return [...new Set([...u.sectors, ...u.anchors, ...u.stocks])];
}

// ── DB (일별 바 누적 — 멱등) ──

export function openPulseDb(path: string = US_PULSE_DB): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS bars(
    symbol TEXT NOT NULL, date TEXT NOT NULL,
    close REAL NOT NULL, volume REAL,
    PRIMARY KEY(symbol, date)
  )`);
  return db;
}

export interface Bar { symbol: string; date: string; close: number; volume: number | null }

export type BulkFetcher = (symbols: string[], date?: string) => Bar[];

/** omni-market `bulk US --symbols` 1콜 — date 지정 시 과거일(백필). */
export const fetchBulkEod: BulkFetcher = (symbols, date) => {
  const args = ['tsx', OMNI_MAIN, 'bulk', 'US', '--symbols', symbols.join(','), '--json'];
  if (date) args.push('--from', date);
  let out: string;
  try {
    out = execFileSync('npx', args, { cwd: OMNI_SKILL, env: process.env, encoding: 'utf-8', timeout: 90_000, maxBuffer: 16_000_000 });
  } catch { return []; }
  const m = /\[\s*\{[\s\S]*\}\s*\]/.exec(out);
  if (!m) return [];
  try {
    const rows = JSON.parse(m[0]) as any[];
    return rows
      // adjusted_close 우선 — 분할/배당 조정(실측: CRWD 4:1 분할이 raw close론 -75% 왜곡)
      .map(r => ({ symbol: String(r.code ?? ''), date: String(r.date ?? ''), close: Number(r.adjusted_close ?? r.close), volume: Number.isFinite(Number(r.volume)) ? Number(r.volume) : null }))
      .filter(b => b.symbol && b.date && Number.isFinite(b.close) && b.close > 0);
  } catch { return []; }
};

/** 벌크 1콜 적재(멱등). 신규 적재된 세션 날짜 반환 — 이미 있던 날짜면 null(결산 skip 신호). */
export function ingestDay(db: Database, symbols: string[], fetch: BulkFetcher = fetchBulkEod, date?: string): { date: string; added: number } | null {
  const bars = fetch(symbols, date);
  if (bars.length === 0) return null;
  const day = bars[0]!.date;
  const before = (db.prepare(`SELECT COUNT(*) n FROM bars WHERE date = ?`).get(day) as any)?.n ?? 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO bars(symbol, date, close, volume) VALUES (?,?,?,?)`);
  let added = 0;
  for (const b of bars) added += ins.run(b.symbol, b.date, b.close, b.volume).changes;
  return before > 0 && added === 0 ? null : { date: day, added };
}

// ── 탐지 (결정론 — 누적 히스토리 기반) ──

export interface StockSignal {
  symbol: string;
  dayPct: number;        // 최근 세션 등락 %
  weekPct: number | null; // 주간(5거래일) 등락 %
  streak: number;        // 연속 상승(+)/하락(−) 일수
  volZ: number | null;   // 거래량 z (20d)
  high20: boolean;       // 20일 신고가
  flags: string[];       // 사람이 읽는 태그 (기준 통과분만)
}

/** 종목별 시그널 계산. closes/vols = 날짜 오름차순. */
export function computeStockSignal(symbol: string, closes: number[], vols: Array<number | null>, c: Criteria = DEFAULT_CRITERIA): StockSignal | null {
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1]!;
  const prev = closes[closes.length - 2]!;
  const dayPct = (last / prev - 1) * 100;
  // 데이터 아티팩트 가드 — 일간 ±40%는 분할 미반영/오류 개연성이 압도적 (실주가면
  // 속보 파이프라인이 따로 잡는다). 오탐 발송 방지 위해 신호에서 제외.
  if (Math.abs(dayPct) >= 40) return null;
  // 주간 = 5거래일 수익률 (매일 축적된 히스토리 전제 — 백필로 즉시 가동)
  const wkBase = closes.length >= 6 ? closes[closes.length - 6]! : null;
  const weekPct = wkBase && wkBase > 0 ? (last / wkBase - 1) * 100 : null;

  let streak = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    const d = closes[i]! - closes[i - 1]!;
    if (streak === 0) streak = d > 0 ? 1 : d < 0 ? -1 : 0;
    else if (streak > 0 && d > 0) streak++;
    else if (streak < 0 && d < 0) streak--;
    else break;
    if (streak === 0) break;
  }

  let volZ: number | null = null;
  const v = vols[vols.length - 1];
  const hist = vols.slice(-21, -1).filter((x): x is number => x != null && x > 0);
  if (v != null && v > 0 && hist.length >= 10) {
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
    volZ = sd > 0 ? (v - mean) / sd : null;
  }

  const high20 = closes.length >= 5 && last >= Math.max(...closes.slice(-20));

  // ── 판별 기준표 (criteria — 명시 기준·조정 가능) ──
  const flags: string[] = [];
  if (streak >= c.streakDays) flags.push(`${streak}일 연속↑`);
  if (streak <= -c.streakDays) flags.push(`${-streak}일 연속↓`);
  if (Math.abs(dayPct) >= c.dailyPct) flags.push(`일간 ${dayPct > 0 ? '+' : ''}${dayPct.toFixed(1)}%`);
  if (weekPct != null && Math.abs(weekPct) >= c.weeklyPct) flags.push(`주간 ${weekPct > 0 ? '+' : ''}${weekPct.toFixed(1)}%`);
  if (volZ != null && volZ >= c.volZ && Math.abs(dayPct) >= 2) flags.push(`거래량 ${volZ.toFixed(1)}σ`);
  if (high20 && dayPct > 0) flags.push('20일 신고가');

  return { symbol, dayPct, weekPct, streak, volZ, high20, flags };
}

/** 유니버스 스캔 — 기준 통과 종목만, 강한 순(스트릭 > 주간 > 일간). */
export function detectNotables(db: Database, stockSymbols: string[], c: Criteria = DEFAULT_CRITERIA): StockSignal[] {
  const out: StockSignal[] = [];
  const q = db.prepare(`SELECT close, volume FROM bars WHERE symbol = ? ORDER BY date ASC`);
  for (const s of stockSymbols) {
    const rows = q.all(s) as Array<{ close: number; volume: number | null }>;
    const sig = computeStockSignal(s, rows.map(r => r.close), rows.map(r => r.volume), c);
    if (sig && sig.flags.length > 0) out.push(sig);
  }
  const score = (n: StockSignal) => Math.abs(n.streak) * 2 + Math.abs(n.weekPct ?? 0) / 2 + Math.abs(n.dayPct);
  out.sort((a, b) => score(b) - score(a));
  return out;
}

export interface SectorMove { symbol: string; name: string; dayPct: number; weekPct: number | null; streak: number }

/** 섹터/앵커 ETF 일간 결산 — dayPct 내림차순 (weekPct=5거래일·대시보드 토글용). */
export function sectorWrap(db: Database, symbols: string[], names: Record<string, string>): SectorMove[] {
  const q = db.prepare(`SELECT close FROM bars WHERE symbol = ? ORDER BY date ASC`);
  const out: SectorMove[] = [];
  for (const s of symbols) {
    const closes = (q.all(s) as Array<{ close: number }>).map(r => r.close);
    const sig = computeStockSignal(s, closes, closes.map(() => null));
    if (sig) out.push({ symbol: s, name: names[s] ?? s, dayPct: sig.dayPct, weekPct: sig.weekPct, streak: sig.streak });
  }
  out.sort((a, b) => b.dayPct - a.dayPct);
  return out;
}

// ── 렌더 + LLM 해석 ──

const pct = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const arrow = (x: number) => (x > 0.05 ? '▲' : x < -0.05 ? '▼' : '─');

/** 강도 게이지 — 색 5단계 (녹→황→백→주→적 · 대표 지시 2026-07-06).
 *  unit 기준: 🟢 ≥ +2×unit · 🟡 ≥ +0.3×unit · ⚪ 보합 · 🟠 ≤ -0.3×unit · 🔴 ≤ -2×unit.
 *  예: 섹터 unit=1 → +2.6% 🟢 · +1.5% 🟡 · -2.7% 🔴. */
export function gauge(x: number, unit: number): string {
  if (x >= 2 * unit) return '🟢';
  if (x >= 0.3 * unit) return '🟡';
  if (x > -0.3 * unit) return '⚪';
  if (x > -2 * unit) return '🟠';
  return '🔴';
}

/** 요일 포함 짧은 날짜 (2026-07-02 → 7/2 목). */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const yo = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${yo}`;
}

/** 종목 1줄: 강도 게이지 포함 (일간 unit 2% · 주간 unit 7%).
 *  `· PLTR  +2.8% ▲▲ | 주 +20.5% ▲▲▲ | ↑5d` */
function stockLine(n: StockSignal, c: Criteria): string {
  const parts = [`${n.symbol}  ${pct(n.dayPct)} ${gauge(n.dayPct, 2)}`];
  if (n.weekPct != null && Math.abs(n.weekPct) >= c.weeklyPct) parts.push(`주 ${pct(n.weekPct)} ${gauge(n.weekPct, 7)}`);
  if (Math.abs(n.streak) >= c.streakDays) parts.push(n.streak > 0 ? `↑${n.streak}일 연속` : `↓${-n.streak}일 연속`);
  if (n.volZ != null && n.volZ >= c.volZ) parts.push(`거래량 ${n.volZ.toFixed(0)}σ`);
  if (n.high20 && n.dayPct > 0) parts.push('🏔신고가');
  return `· ${parts.join('  |  ')}`;
}

export function renderCloseWrap(date: string, anchors: SectorMove[], sectors: SectorMove[], notables: StockSignal[], c: Criteria = DEFAULT_CRITERIA): string {
  const lines = [
    `🇺🇸 미국장 결산 · ${shortDate(date)}`,
    anchors.map(a => `${arrow(a.dayPct)} ${a.name} ${pct(a.dayPct)}`).join('  '),
    '',
    '📊 섹터 순환',
    // 섹터 1줄씩 + 강도 게이지(unit 1%) — 세로 스캔으로 로테이션 기울기가 보이게
    ...sectors.map(s => {
      const streak = Math.abs(s.streak) >= 3 ? `  (${s.streak > 0 ? '↑' : '↓'}${Math.abs(s.streak)}일)` : '';
      return `${gauge(s.dayPct, 1)} ${s.name} ${pct(s.dayPct)}${streak}`;
    }),
  ];

  if (notables.length > 0) {
    // 신호 유형별 그룹 — 같은 성격끼리 묶여야 읽힌다 (기준: 연속≥streakDays ·
    // 주간≥weeklyPct · 일간≥dailyPct/거래량σ)
    const top = notables.slice(0, 12);
    const line = (n: StockSignal) => stockLine(n, c);
    const ups = top.filter(n => n.streak >= c.streakDays);
    const downs = top.filter(n => n.streak <= -c.streakDays);
    const rest = top.filter(n => Math.abs(n.streak) < c.streakDays);
    const weekly = rest.filter(n => n.weekPct != null && Math.abs(n.weekPct) >= c.weeklyPct);
    const daily = rest.filter(n => !weekly.includes(n));
    lines.push('', `⭐ 눈에 띄는 종목 (기준: 연속${c.streakDays}일 · 주간±${c.weeklyPct}% · 일간±${c.dailyPct}% · 거래량${c.volZ}σ)`);
    if (ups.length) lines.push('', '🔥 연속상승', ...ups.map(line));
    if (downs.length) lines.push('', '📉 연속하락', ...downs.map(line));
    if (weekly.length) lines.push('', '🚀 주간강도', ...weekly.map(line));
    if (daily.length) lines.push('', '⚡ 급변동', ...daily.map(line));
  }
  return lines.join('\n');
}

const PULSE_SYSTEM = `너는 Conatus의 미국장 데스크다. 아래 결산(지수·섹터 순환·눈에 띄는 종목: 연속상승/급등락/거래량/신고가)을 읽고 해석을 작성하라.

형식 — 정확히 아래 4줄(라벨 포함·한국어·각 줄 100자 이내·줄바꿈 외 마크다운 금지):
한줄 | (오늘 장을 한 문장으로 — 예: "테크→방어주 로테이션, 반도체가 진앙")
머니무브 | 자금이 어디서 어디로 갔나
주목 | 순환의 증거가 되는 종목 신호 (스트릭은 지속/과열 양면 판단)
관찰 | 다음 세션·한국장에서 확인할 조건 1~2개 (①② 번호)

규칙: 결산 데이터에서만 근거. 길게 쓰지 마라 — 한 줄에 핵심만. 매매 지시 금지(verify+HITL).`;

/** LLM 해석 — fail-soft(불가 시 빈 문자열). */
export async function interpretPulse(structured: string): Promise<string> {
  if (!anyProviderAvailable()) return '';
  try {
    const provider = getProviderForConfig(getUserConfig());
    if (!provider.streamChat) return '';
    const messages: LLMMessage[] = [
      { role: 'system', content: PULSE_SYSTEM },
      { role: 'user', content: structured.slice(0, 8_000) },
    ];
    let out = '';
    for await (const d of textOnly(provider.streamChat(messages, { temperature: 0.3, maxTokens: 600 }))) out += d;
    return out.trim();
  } catch { return ''; }
}

export interface ClosePulseResult { report: string; date: string; notable: number; savedPath: string | null }

/** 밤사이 저장된 최신 US 아침결산 리포트 읽기(브리핑 종합용·재수집 없음). 없으면 null.
 *  파일명 `YYYY-MM-DD-us-pulse.md` — 사전순 최신. maxAgeHours 넘으면 stale 로 null. */
export function readLatestClosePulse(opts: { maxAgeHours?: number; dir?: string } = {}): { date: string; report: string } | null {
  const dir = opts.dir ?? PULSE_REPORTS_DIR;
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}-us-pulse\.md$/.test(f)).sort();
    const latest = files[files.length - 1];
    if (!latest) return null;
    const date = latest.slice(0, 10);
    if (opts.maxAgeHours != null) {
      const ageMs = Date.now() - new Date(`${date}T00:00:00Z`).getTime();
      if (ageMs > opts.maxAgeHours * 3_600_000) return null;
    }
    return { date, report: readFileSync(join(dir, latest), 'utf8') };
  } catch { return null; }
}

/** 아침 결산 파이프라인: 벌크 적재 → 섹터/종목 탐지 → 해석 → 발송용 리포트.
 *  신규 세션 없으면 null(휴장/주말 — 발송 skip). force=DB 최신일자로 재결산(온디맨드). */
export async function buildClosePulse(fetch: BulkFetcher = fetchBulkEod, dbPath: string = US_PULSE_DB, opts: { force?: boolean } = {}): Promise<ClosePulseResult | null> {
  const u = loadUniverse();
  const db = openPulseDb(dbPath);
  try {
    let ing = ingestDay(db, allSymbols(u), fetch);
    if (!ing && opts.force) {
      const latest = (db.prepare(`SELECT MAX(date) d FROM bars`).get() as any)?.d;
      if (latest) ing = { date: latest, added: 0 };
    }
    if (!ing) return null; // 신규 세션 없음 (휴장·주말·이미 처리)
    const anchors = sectorWrap(db, u.anchors, ANCHOR_ETFS);
    const sectors = sectorWrap(db, u.sectors, SECTOR_ETFS);
    const notables = detectNotables(db, u.stocks, u.criteria);
    const structured = renderCloseWrap(ing.date, anchors, sectors, notables, u.criteria);
    const interp = await interpretPulse(structured);
    const report = interp
      ? `${structured}\n\n🧭 해석\n${interp}\n\n(관찰용 · 매매는 verify+HITL)`
      : `${structured}\n\n(LLM 해석 불가 — 정량만 · 관찰용)`;
    let savedPath: string | null = null;
    try {
      mkdirSync(PULSE_REPORTS_DIR, { recursive: true });
      savedPath = join(PULSE_REPORTS_DIR, `${ing.date}-us-pulse.md`);
      writeFileSync(savedPath, report);
    } catch { savedPath = null; }
    return { report, date: ing.date, notable: notables.length, savedPath };
  } finally { db.close(); }
}

// ── 개장+30분 스냅샷 (라이브 quote — 결정론·경량) ──

export type QuoteFetcher = (symbol: string) => { prevClose: number; close: number } | null;

export function buildOpenSnapshot(fetchQuote: QuoteFetcher): string | null {
  const u = loadUniverse();
  const rows: Array<{ symbol: string; name: string; dayPct: number }> = [];
  for (const s of [...u.anchors, ...u.sectors]) {
    const q = fetchQuote(`${s}.US`);
    if (!q || !(q.prevClose > 0)) continue;
    rows.push({ symbol: s, name: ANCHOR_ETFS[s] ?? SECTOR_ETFS[s] ?? s, dayPct: (q.close / q.prevClose - 1) * 100 });
  }
  if (rows.length < 6) return null; // 시세 확보 실패 — 발송 skip (fail-soft)
  const anchors = rows.filter(r => ANCHOR_ETFS[r.symbol]);
  const sectors = rows.filter(r => SECTOR_ETFS[r.symbol]).sort((a, b) => b.dayPct - a.dayPct);
  const lines = [
    `🇺🇸 개장 30분 스냅샷`,
    anchors.map(a => `${arrow(a.dayPct)} ${a.name} ${pct(a.dayPct)}`).join('  '),
    '',
    // 결산과 동일한 강도 게이지 (장중은 진폭이 작아 unit 0.5%)
    ...sectors.map(s => `${gauge(s.dayPct, 0.5)} ${s.name} ${pct(s.dayPct)}`),
    '',
    '(장중 — 결산·해석은 아침 리포트에서)',
  ];
  return lines.join('\n');
}

/** 개장+30분 게이트 — ET 09:50~10:25 & 정규장만 (DST 이동은 ET 기준이라 자동). */
export function isOpen30Window(etMinutes: number, usOpen: boolean): boolean {
  return usOpen && etMinutes >= 590 && etMinutes <= 625;
}
