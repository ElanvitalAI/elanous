// ── 온톨로지 새벽 공고화 (후속3+4 · M4.2 REM 정리 · 2026-07-08) ───────────
//
// 새벽 수면 리플레이(RESEARCH §3.4 REM 온톨로지 정리)의 실체: 하루치 데이터를
// 온톨로지로 공고화. 3단계를 한 배치로:
//   1) build   — seed(구조) + correlate(측정 상관·시변)          [무비용]
//   2) extract — dig/breaking → LLM 인과 추출                    [config 게이트·후속2]
//   3) anomaly — 예측 vs 실측 이상치 → dig 후보(자동 arming 게이트)  [후속3]
//
// 거버넌스: build/anomaly 관측은 무비용. LLM 추출·이상치 자동 dig 는 config 게이트
// (기본 off·대표 arming). READ-ONLY 판단·매매 격리.

import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openKgDb, pruneEdges } from './kg-store.js';
import { buildOntology, detectAnomalies, enqueueAnomalyDigs, type AnomalyCandidate } from './kg-build.js';
import { correlateCrossMarketBatch } from './kg-crossmarket.js';
import { extractAndStore, type ChatFn } from './kg-extract.js';
import { loadKrPrices, loadUsPrices } from './kg-correlation.js';
import { getUserConfig } from '../user-config/reader.js';
import { conatusPath } from './conatus-data-dir.js';

export const BREAKING_DB_PATH = conatusPath('breaking_signals.db');

/** 종목 실측 % 이동 resolver(레이지 로드·캐시). KR=6자리코드·그 외 US. etaDays 전 대비. */
export function buildPriceResolver(fromDate: string): (symbol: string, etaDays: number) => number | null {
  const cache = new Map<string, { date: string; close: number }[]>();
  return (symbol, etaDays) => {
    let bars = cache.get(symbol);
    if (!bars) {
      const m = /^\d{6}$/.test(symbol) ? loadKrPrices([symbol], fromDate) : loadUsPrices([symbol], fromDate);
      bars = m.get(symbol) ?? [];
      cache.set(symbol, bars);
    }
    if (bars.length < 2) return null;
    const lag = Math.max(1, etaDays);
    const i = bars.length - 1, j = Math.max(0, i - lag);
    const a = bars[i]!.close, b = bars[j]!.close;
    return b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;
  };
}

function cfgBool(path: string[]): boolean {
  let cur: unknown = getUserConfig();
  for (const k of path) { if (!cur || typeof cur !== 'object') return false; cur = (cur as Record<string, unknown>)[k]; }
  return Boolean(cur);
}

export interface ConsolidateOpts {
  db?: Database;
  regime?: string;
  fromDate?: string;
  minAbsCorr?: number;
  extractEnabled?: boolean;      // 미지정 시 config kg.extract.enabled
  extractChat?: ChatFn;
  armAnomalyDig?: boolean;       // 미지정 시 config kg.anomalyDig.enabled
  actualResolver?: (symbol: string, etaDays: number) => number | null;  // 주입 seam
  digDb?: Database;              // 주입 seam(테스트)
  now?: string;
}

export interface ConsolidateResult {
  build: { nodes: number; edges: number; activeEdges: number };
  correlate: { crossMarket: number; groups: number };
  crossBatch: { pairs: number; edges: number };
  extract: { processed: number; edges: number };
  anomalies: AnomalyCandidate[];
  digsEnqueued: number;
  pruned: { invalidPruned: number; dupPruned: number };
}

/** 새벽 공고화 배치 — build + extract + anomaly. 게이트 미충족 단계는 no-op. */
export async function consolidateOntology(opts: ConsolidateOpts = {}): Promise<ConsolidateResult> {
  const now = opts.now ?? new Date().toISOString();
  const fromDate = opts.fromDate ?? isoDaysBefore(now, 180);
  const db = opts.db ?? openKgDb();

  // 1) build (무비용) + 한미 lead-lag 전종목 배치(추천3)
  const built = buildOntology(now, { db, regime: opts.regime, fromDate, minAbsCorr: opts.minAbsCorr ?? 0.2 });
  const crossBatch = correlateCrossMarketBatch(db, { now, regime: opts.regime, fromDate, minAbsCorr: 0.4 });

  // 2) extract (config 게이트)
  const extract = await extractAndStore(db, BREAKING_DB_PATH, {
    enabled: opts.extractEnabled ?? cfgBool(['finance', 'kg', 'extract', 'enabled']),
    chat: opts.extractChat, now,
  });

  // 3) anomaly (관측은 항상·자동 dig 는 게이트)
  const resolver = opts.actualResolver ?? buildPriceResolver(fromDate);
  const anomalies = detectAnomalies(db, { regime: opts.regime, actualResolver: resolver });
  let digsEnqueued = 0;
  const arm = opts.armAnomalyDig ?? cfgBool(['finance', 'kg', 'anomalyDig', 'enabled']);
  if (arm && anomalies.length) {
    const digDb = opts.digDb ?? new Database(BREAKING_DB_PATH);
    try { digsEnqueued = enqueueAnomalyDigs(digDb, anomalies, now); } finally { if (!opts.digDb) digDb.close(); }
  }

  // 4) SHY 정리(수면 하향정규화) — 누적 correlates 관측 prune + 오래된 무효 삭제.
  const pruned = pruneEdges(db, { now });

  return { build: built.stats, correlate: built.correlate, crossBatch, extract, anomalies, digsEnqueued, pruned };
}

function isoDaysBefore(now: string, days: number): string {
  const d = new Date(`${now.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
