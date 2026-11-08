// ── 매크로 시계열 스토어 (2026-07-08 · B) ────────────────────────────────
//
// 대표 지시: 아침 브리핑의 매크로(유가·달러·원달러·미10년)는 표시로 끝이 아니라
// 분석 루프에서 시계열 추적관찰돼야 한다. 이 모듈이 그 영속층 — 일별 스냅샷을
// regime.db(macro_snapshots)에 upsert 하고 추세(N일 변화)를 낸다.
//
// ★ 분석 추적관찰 = 이 스토어. 매매 신호(regime macro_rates 축)는 후속(대표 가중치
//   확인 — live 자율매매 composite 재조정 영향). 순수 함수 + db 주입(테스트 결정론).
//
// 근거: 대표 지시 2026-07-08(매크로 인덱스 추적관찰+매매 신호).

import { Database } from 'bun:sqlite';
import { REGIME_DB_PATH } from './regime-db-path.js';

export interface MacroSnapshot {
  asOf: string;          // YYYY-MM-DD
  oilPct?: number;       // 유가(WTI 프록시) 일간 %
  dxyPct?: number;       // 달러(DXY 프록시) 일간 %
  usdkrw?: number;       // 원/달러 환율(실값)
  ust10y?: number;       // 미 10년물 수익률 %(실값)
}

export function openMacroDb(path: string = REGIME_DB_PATH): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS macro_snapshots(
    as_of TEXT PRIMARY KEY, oil_pct REAL, dxy_pct REAL, usdkrw REAL, ust10y REAL, created_at TEXT)`);
  return db;
}

/** 일별 스냅샷 upsert(같은 날짜 = 덮어씀·중복 방지). */
export function recordMacroSnapshot(db: Database, s: MacroSnapshot): void {
  db.prepare(
    `INSERT OR REPLACE INTO macro_snapshots(as_of, oil_pct, dxy_pct, usdkrw, ust10y, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(s.asOf, s.oilPct ?? null, s.dxyPct ?? null, s.usdkrw ?? null, s.ust10y ?? null, new Date().toISOString());
}

export interface MacroRow { as_of: string; oil_pct: number | null; dxy_pct: number | null; usdkrw: number | null; ust10y: number | null }

/** 최근 N개 스냅샷(최신순). */
export function recentMacro(db: Database, limit = 10): MacroRow[] {
  return db.prepare(`SELECT as_of, oil_pct, dxy_pct, usdkrw, ust10y FROM macro_snapshots ORDER BY as_of DESC LIMIT ?`).all(limit) as MacroRow[];
}

export interface MacroTrend {
  days: number;
  usdkrwChange?: number;   // 원/달러 절대 변화(원)
  ust10yChange?: number;   // 미10년 절대 변화(%p)
  samples: number;
}

/** 최신 vs N일 전(가장 가까운 과거) 변화. 데이터 부족 시 samples로 표시. */
export function macroTrend(db: Database, days = 5): MacroTrend {
  const rows = recentMacro(db, 60);
  if (rows.length < 2) return { days, samples: rows.length };
  const latest = rows[0]!;
  const cutoff = new Date(Date.parse(latest.as_of) - days * 86400_000).toISOString().slice(0, 10);
  // N일 전 이하 중 가장 최근(없으면 가장 오래된 것).
  const past = rows.find(r => r.as_of <= cutoff) ?? rows[rows.length - 1]!;
  const diff = (a: number | null, b: number | null): number | undefined =>
    (typeof a === 'number' && typeof b === 'number') ? Math.round((a - b) * 100) / 100 : undefined;
  return {
    days,
    ...(diff(latest.usdkrw, past.usdkrw) !== undefined ? { usdkrwChange: diff(latest.usdkrw, past.usdkrw) } : {}),
    ...(diff(latest.ust10y, past.ust10y) !== undefined ? { ust10yChange: diff(latest.ust10y, past.ust10y) } : {}),
    samples: rows.length,
  };
}

/** 추세 한 줄(브리핑·분석용). 유의 변화 없으면 ''. */
export function formatMacroTrend(t: MacroTrend): string {
  if (t.samples < 2) return '';
  const parts: string[] = [];
  if (typeof t.ust10yChange === 'number' && Math.abs(t.ust10yChange) >= 0.05) {
    parts.push(`미10년 ${t.ust10yChange >= 0 ? '+' : ''}${t.ust10yChange.toFixed(2)}%p`);
  }
  if (typeof t.usdkrwChange === 'number' && Math.abs(t.usdkrwChange) >= 3) {
    parts.push(`원/달러 ${t.usdkrwChange >= 0 ? '+' : ''}${t.usdkrwChange.toFixed(0)}원`);
  }
  return parts.length ? `  (${t.days}일: ${parts.join(' · ')})` : '';
}
