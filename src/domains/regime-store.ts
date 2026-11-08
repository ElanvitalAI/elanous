// ── 국면 벡터 저장소 (C1 · M1.3 · 2026-07-07) ──────────────────────────
//
// 국면 벡터를 시계열로 영속(regime.db). transition 판정이 직전 벡터를 필요로 하고,
// "언제 국면이 틀었나"의 이력이 분석/매매 루프의 입력이므로 저장한다. append-only
// (codex no-history-rewrite) — as_of PK로 멱등.

import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectAxisSignals, type RawFetchers } from './regime-fetchers.js';
import { synthesizeRegime, type RegimeVector } from './regime-synth.js';
import { REGIME_DB_PATH } from './regime-db-path.js';
export { REGIME_DB_PATH } from './regime-db-path.js';

export function openRegimeDb(path: string = REGIME_DB_PATH): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS regime_vector(
    as_of TEXT PRIMARY KEY, composite REAL, regime_label TEXT,
    transition INT, transition_axes TEXT, axes TEXT, created_at TEXT)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_regime_asof ON regime_vector(as_of)`);
  return db;
}

/** 국면 벡터 저장(멱등·as_of PK). */
export function saveRegimeVector(db: Database, v: RegimeVector): void {
  db.run(
    `INSERT OR REPLACE INTO regime_vector(as_of, composite, regime_label, transition, transition_axes, axes, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [v.asOf, v.composite, v.regimeLabel, v.transition ? 1 : 0,
      JSON.stringify(v.transitionAxes), JSON.stringify(v.axes), v.asOf],
  );
}

/** 최근 국면 벡터(transition 판정용 prev). 없으면 null. */
export function latestRegimeVector(db: Database): RegimeVector | null {
  const r = db.query(`SELECT * FROM regime_vector ORDER BY as_of DESC LIMIT 1`).get() as
    { as_of: string; composite: number; regime_label: string; transition: number; transition_axes: string; axes: string } | null;
  if (!r) return null;
  return {
    asOf: r.as_of, composite: r.composite, regimeLabel: r.regime_label as RegimeVector['regimeLabel'],
    transition: !!r.transition,
    transitionAxes: safeParse(r.transition_axes, []),
    axes: safeParse(r.axes, []),
  };
}

/** 최근 N개 국면 벡터(이력·"언제 틀었나"). 최신순. */
export function recentRegimeVectors(db: Database, limit = 10): RegimeVector[] {
  const rows = db.query(`SELECT * FROM regime_vector ORDER BY as_of DESC LIMIT ?`).all(limit) as Array<
    { as_of: string; composite: number; regime_label: string; transition: number; transition_axes: string; axes: string }>;
  return rows.map(r => ({
    asOf: r.as_of, composite: r.composite, regimeLabel: r.regime_label as RegimeVector['regimeLabel'],
    transition: !!r.transition, transitionAxes: safeParse(r.transition_axes, []), axes: safeParse(r.axes, []),
  }));
}

/** ★ 실 파이프라인: raw 수집 → 직전 대비 합성 → 저장. now 주입(결정론). Never throws
 *  (fail-soft·store 실패는 삼킴). 반환 = 방금 계산·저장한 국면 벡터. */
export async function computeAndStoreRegime(
  now: string, opts: { raw?: RawFetchers; dbPath?: string } = {},
): Promise<RegimeVector> {
  // now 전달 → 일일 축에 신선도 감쇠(M3.4·asOfDate 기반) 적용.
  const axes = collectAxisSignals(opts.raw, now);
  let prev: RegimeVector | null = null;
  let db: Database | null = null;
  try { db = openRegimeDb(opts.dbPath); prev = latestRegimeVector(db); } catch { /* fail-soft */ }
  const v = await synthesizeRegime({ axes: async () => axes, prev, now });
  try { if (db) saveRegimeVector(db, v); } catch { /* fail-soft */ }
  finally { db?.close(); }
  return v;
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
