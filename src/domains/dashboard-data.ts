// ── R4 · PWA 대시보드 데이터 조립 (2026-07-07 · ROADMAP-organic-signal-engine) ──
//
// `/v1/dashboard/*` read API 의 데이터층. 원칙: **캐시·로컬 SQLite 만 읽는다**
// (라이브 네트워크/스킬 shell-out 없음 — PWA 폴링에 안전한 <50ms 응답).
// 소스: breaking_signals.db(신호·디깅) · us_pulse.db(US 섹터·종목) ·
// scores.db(cross-asset 매력도) · capstone_regime.json(국면 캐시) ·
// alpha_reports/(주간 알파). 전 섹션 fail-soft — 소스 없으면 null 섹션.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSignalsDb, SIGNALS_DB_PATH, periodStats } from './breaking-signals.js';
import { US_PULSE_DB, openPulseDb, loadUniverse, sectorWrap, detectNotables, SECTOR_ETFS, ANCHOR_ETFS } from './us-pulse.js';
import { KR_SECTOR_ETFS, readLiveSnapshot } from './market-live.js';
import { openSchedulesDb, inventoryCrontab, inventoryInternalSchedules, listSchedules, scheduleHealth } from './schedule-registry.js';
import { getUserConfig } from '../user-config/reader.js';
import { opsSnapshot, opsHealth, opsTimeline, opsMissionDetail } from './ops-status.js';
import { conatusPath } from './conatus-data-dir.js';
import { tradeMandatePath } from './trade-mandate.js';
import { daysAgo, within } from '../time/db-window.js';

/** asset_class/섹터 태그 → 한글 레이블 (대표 피드백 2026-07-07: 영문 약자 구분 불가).
 *  미등록 키는 원문 유지 — PWA 가 그대로 표기. */
export const ASSET_LABELS_KO: Record<string, string> = {
  // 자산군
  equities_us: '미국주식', equities_kr: '한국주식', equities_dm: '선진국주식', equities_em: '신흥국주식',
  crypto: '크립토', gold: '금', commodities: '원자재', cash: '현금', dollar: '달러',
  bonds_ust: '미국채', bonds_tips: '물가채', bonds_hy: '하이일드', bonds_em: 'EM채권',
  bonds_ig: 'IG크레딧', credit_ig: 'IG크레딧', bonds_lt: '장기국채', bonds_st: '단기국채',
  reits: '리츠', real_estate: '부동산', oil: '원유', silver: '은',
  // 국가
  us: '미국', kr: '한국', jp: '일본', eu: '유럽', de: '독일', in: '인도', cn: '중국', uk: '영국', tw: '대만',
  br: '브라질', za: '남아공',
  // 섹터 (GICS + 뉴스 태그)
  technology: '테크', financials: '금융', industrials: '산업재', healthcare: '헬스케어',
  energy: '에너지', materials: '소재', utilities: '유틸리티', consumer_staples: '필수소비',
  consumer_disc: '경기소비', comm_services: '커뮤니케이션', semis: '반도체', sw: '소프트웨어',
  power: '전력기기', defense: '방산', commodity: '원자재', bonds: '채권', fx: '환율',
  consumer: '소비재', macro: '매크로', other: '기타',
};

/** 복합 태그(semis,sw)도 한글화. */
export function labelKo(key: string): string {
  return String(key).split(',').map(k => ASSET_LABELS_KO[k.trim()] ?? k.trim()).join('·');
}

const HOME = homedir();
const SCORES_DB = join(HOME, '.cache/asset-attractiveness/scores.db');
const CAPSTONE_REGIME = conatusPath('capstone_regime.json');
const ALPHA_DIR = conatusPath('alpha_reports');

export interface DashboardPaths {
  signalsDb?: string; pulseDb?: string; scoresDb?: string;
  capstoneRegime?: string; capstoneSignals?: string; alphaDir?: string; liveSnapshot?: string;
  schedulesDb?: string;
}

function soft<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

// ── summary ──

export function dashboardSummary(p: DashboardPaths = {}) {
  const capstone = soft(() => {
    // A~E 상세 스냅샷 우선(capstone-alert 매 실행 기록 — 대표 지시: 사이드바 카드).
    const snapPath = p.capstoneSignals ?? conatusPath('capstone_signals.json');
    if (existsSync(snapPath)) {
      const s = JSON.parse(readFileSync(snapPath, 'utf-8'));
      return {
        target: s.target ?? null, updatedAt: s.ts ?? null, regime: s.regime ?? null,
        label: s.label ?? null, targetExposure: s.targetExposure ?? null,
        samsung: s.samsung ?? null, r3Level: s.r3Level ?? null, reliable: s.reliable ?? null, signals: s.signals ?? null,
      };
    }
    const path = p.capstoneRegime ?? CAPSTONE_REGIME;
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    return { target: j.lastTarget ?? null, updatedAt: j.updatedAt ?? null };
  });
  const signals = soft(() => {
    const path = p.signalsDb ?? SIGNALS_DB_PATH;
    if (!existsSync(path)) return null;
    const db = openSignalsDb(path);
    try {
      return { day: periodStats(db, 1), week: periodStats(db, 7) };
    } finally { db.close(); }
  });
  const digs = soft(() => {
    const path = p.signalsDb ?? SIGNALS_DB_PATH;
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    try {
      const has = (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='dig_reports'`).get() as any)?.n > 0;
      if (!has) return null;
      const r = db.prepare(`SELECT COUNT(*) n, MAX(ts) last FROM dig_reports WHERE ${within('ts')}`).get(daysAgo(7)) as any;
      return { week: r?.n ?? 0, lastAt: r?.last ?? null };
    } finally { db.close(); }
  });
  const alpha = soft(() => {
    const dir = p.alphaDir ?? ALPHA_DIR;
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    return files.length ? { latest: files[files.length - 1] } : null;
  });
  return { capstone, signals, digs, alpha, generatedAt: new Date().toISOString() };
}

// ── timeline (신호 — 최근 N시간·floor 이상) ──

export function dashboardTimeline(hours = 48, floor = 6, p: DashboardPaths = {}) {
  return soft(() => {
    const path = p.signalsDb ?? SIGNALS_DB_PATH;
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true });
    try {
      return db.prepare(`
        SELECT id, ts, author, text, url, urgency, market, kr, sector, impact, reason, alerted
        FROM signals
        WHERE ${within('ts')}
          AND MAX(COALESCE(urgency,0), COALESCE(market,0), COALESCE(impact,0)) >= ?
        ORDER BY ts DESC LIMIT 80
      `).all(`-${Math.min(Math.max(hours, 1), 24 * 14)} hours`, floor) as any[];
    } finally { db.close(); }
  }) ?? [];
}

// ── heatmap (자산군 × 국가 × 섹터 — cross-asset 매력도 + US 섹터 일간) ──

/** cross_asset_scores 의 asset_class → 그룹 분류 (symbol 휴리스틱). */
export function classifyAssetRow(assetClass: string, symbol: string): 'sector' | 'country' | 'asset' {
  if (/^XL[A-Z]\.US$/.test(symbol)) return 'sector';
  if (/^(EW[A-Z]{1,2}|EZU|INDA|FXI|EEM|VGK|MCHI)\.US$/.test(symbol)) return 'country';
  if (/^(us|kr|jp|eu|de|in|cn|uk|tw)$/.test(assetClass)) return 'country';
  return 'asset';
}

export function dashboardHeatmap(p: DashboardPaths = {}) {
  // 매력도 (cross-asset — 최신 as_of + 직전 as_of 대비 Δ방향 · 대표 지시 2026-07-07)
  const attractiveness = soft(() => {
    const path = p.scoresDb ?? SCORES_DB;
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    try {
      const asOf = (db.prepare(`SELECT MAX(as_of) d FROM cross_asset_scores`).get() as any)?.d ?? null;
      if (!asOf) return null;
      const prevAsOf = (db.prepare(`SELECT MAX(as_of) d FROM cross_asset_scores WHERE as_of < ?`).get(asOf) as any)?.d ?? null;
      const latest = db.prepare(`
        SELECT asset_class, symbol, MAX(score) AS score, signal
        FROM cross_asset_scores WHERE as_of = ? GROUP BY asset_class ORDER BY score DESC
      `).all(asOf) as any[];
      const prev = new Map<string, number>();
      if (prevAsOf) {
        for (const r of db.prepare(`SELECT asset_class, MAX(score) AS score FROM cross_asset_scores WHERE as_of = ? GROUP BY asset_class`).all(prevAsOf) as any[]) {
          prev.set(String(r.asset_class), Number(r.score));
        }
      }
      const groups: Record<string, any[]> = { asset: [], country: [], sector: [] };
      for (const r of latest) {
        const p0 = prev.get(String(r.asset_class));
        const delta = p0 == null ? null : Math.round((r.score - p0) * 10) / 10;
        groups[classifyAssetRow(String(r.asset_class), String(r.symbol))]!.push({
          key: r.asset_class, label: labelKo(String(r.asset_class)), symbol: r.symbol,
          score: Math.round(r.score * 10) / 10, signal: r.signal,
          delta, dir: delta == null ? null : delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat',
        });
      }
      return { asOf, prevAsOf, ...groups };
    } finally { db.close(); }
  });
  // US/KR 섹터 (us_pulse.db 누적 — 일간+주간·스트릭)
  const pulse = soft(() => {
    const path = p.pulseDb ?? US_PULSE_DB;
    if (!existsSync(path)) return null;
    const db = openPulseDb(path);
    try {
      const date = (db.prepare(`SELECT MAX(date) d FROM bars`).get() as any)?.d ?? null;
      if (!date) return null;
      const u = loadUniverse();
      return {
        date,
        anchors: sectorWrap(db, u.anchors, ANCHOR_ETFS),
        sectors: sectorWrap(db, u.sectors, SECTOR_ETFS),
        krSectors: sectorWrap(db, Object.keys(KR_SECTOR_ETFS), KR_SECTOR_ETFS),
        notables: detectNotables(db, u.stocks, u.criteria).slice(0, 12)
          .map(n => ({ symbol: n.symbol, dayPct: Math.round(n.dayPct * 10) / 10, weekPct: n.weekPct == null ? null : Math.round(n.weekPct * 10) / 10, streak: n.streak, high20: n.high20, flags: n.flags })),
      };
    } finally { db.close(); }
  });
  const usSectors = pulse ? { date: pulse.date, anchors: pulse.anchors, sectors: pulse.sectors, notables: pulse.notables } : null;
  const krSectors = pulse && pulse.krSectors.length ? { date: pulse.date, sectors: pulse.krSectors } : null;
  // 라이브 오버레이 (장중 2h 수집 — 신선(<150분)할 때만·아니면 null=EOD 폴백)
  const live = soft(() => readLiveSnapshot(150, p.liveSnapshot));
  // 뉴스 신호 섹터 분포 (7일 — 머니무브먼트 관찰 · 한글 레이블)
  const newsSectors = soft(() => {
    const path = p.signalsDb ?? SIGNALS_DB_PATH;
    if (!existsSync(path)) return null;
    const db = openSignalsDb(path);
    try {
      return periodStats(db, 7).bySector.map(s => ({ ...s, label: labelKo(s.sector) }));
    } finally { db.close(); }
  });
  return { attractiveness, usSectors, krSectors, live, newsSectors, generatedAt: new Date().toISOString() };
}

// ── digs (디깅 리포트 피드) ──

export function dashboardDigs(limit = 20, p: DashboardPaths = {}) {
  return soft(() => {
    const path = p.signalsDb ?? SIGNALS_DB_PATH;
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true });
    try {
      const has = (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='dig_reports'`).get() as any)?.n > 0;
      if (!has) return [];
      return db.prepare(`
        SELECT id, ts, queue_id, topic, sector, verdict, confidence
        FROM dig_reports ORDER BY ts DESC LIMIT ?
      `).all(Math.min(Math.max(limit, 1), 100)) as any[];
    } finally { db.close(); }
  }) ?? [];
}

// ── schedules (B1 — 스케줄러 대시보드 카드) ──
// 전체 예약(crontab + 데몬 내부)을 카테고리/소스별 집계 + 잡 리스트로. 스케줄러
// 트랙(prospective memory)을 대시보드에 시각화 — 이름·타임(cron)·last_run·enable.

export function dashboardSchedules(p: DashboardPaths = {}) {
  return soft(() => {
    const db = openSchedulesDb(p.schedulesDb);
    try {
      inventoryCrontab(db);            // 최신 crontab 반영
      inventoryInternalSchedules(db);  // 데몬 내부 스케줄 통합(B2)
      const rows = listSchedules(db);
      const byCategory: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const byRunVia: Record<string, number> = {};
      let adopted = 0;
      for (const r of rows) {
        byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
        bySource[r.source] = (bySource[r.source] ?? 0) + 1;
        // 실행 주체 분해(Mission Fabric 통합 U4 이관 가시성):
        // crontab(시스템 cron)·elanous(schedule-runner·은퇴)·trigger(fabric Schedule
        // Trigger)·daemon(내부 스케줄). adopted 만으로는 trigger 이관이 안 보임.
        byRunVia[r.run_via] = (byRunVia[r.run_via] ?? 0) + 1;
        if (r.run_via === 'elanous') adopted++;
      }
      const health = scheduleHealth(rows);
      const staleIds = new Set(health.stale.map(s => s.id));
      return {
        total: rows.length,
        adopted,                       // elanous 데몬(schedule-runner·은퇴)이 발화하는 잡 수
        byRunVia,                      // 실행 주체 분해(trigger 이관 가시성·U4)
        byCategory, bySource,
        // 실행 헬스(P2) — 밀린/실패 잡 요약(대표 관측성 지시).
        health: {
          elanousTotal: health.elanousTotal,
          staleCount: health.stale.length,
          erroredCount: health.errored.length,
          stale: health.stale.slice(0, 20),
          errored: health.errored.slice(0, 20),
        },
        jobs: rows.map(r => ({
          id: r.id, name: r.name, cron: r.cron, intervalMs: r.interval_ms,
          category: r.category, domain: r.domain, source: r.source,
          enabled: !!r.enabled, runVia: r.run_via, lastRun: r.last_run,
          // 실행 결과(P1 컬럼) — 성공/실패·소요·경로·에러 가시화.
          lastStatus: r.last_status ?? null, lastExit: r.last_exit ?? null,
          lastDurationMs: r.last_duration_ms ?? null, lastVia: r.last_via ?? null,
          lastError: r.last_error ?? null, stale: staleIds.has(r.id),
          autopilotId: r.autopilot_id ?? null,   // 오토파일럿 계보(AL2)
          command: (r.command ?? '').slice(0, 100),
          note: r.note ?? null,   // 사람용 설명(툴팁)
        })),
        generatedAt: new Date().toISOString(),
      };
    } finally { db.close(); }
  });
}

// ── ontology (추천4) — 온톨로지 그래프 요약 (READ-ONLY·캐시 knowledge.db) ──
export function dashboardOntology(p: { knowledgeDb?: string } = {}) {
  return soft(() => {
    const path = p.knowledgeDb ?? conatusPath('knowledge.db');
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    try {
      const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='kg_nodes'`).get();
      if (!has) return null;
      const nm = (id: string): string => (db.query(`SELECT name FROM kg_nodes WHERE id=?`).get(id) as { name: string } | null)?.name ?? id;
      const stats = {
        nodes: (db.query(`SELECT COUNT(*) c FROM kg_nodes`).get() as { c: number }).c,
        edges: (db.query(`SELECT COUNT(*) c FROM kg_edges WHERE invalid_at IS NULL`).get() as { c: number }).c,
        chains: (db.query(`SELECT COUNT(*) c FROM kg_nodes WHERE kind='chain'`).get() as { c: number }).c,
        companies: (db.query(`SELECT COUNT(*) c FROM kg_nodes WHERE kind='company'`).get() as { c: number }).c,
      };
      // 미국→한국 전파 top (measured batch·|weight|>=0.6·pair당 최신 관측만)
      const propagation = (db.query(
        `SELECT src, dst, weight, lead_lag FROM (
           SELECT src, dst, weight, lead_lag, ROW_NUMBER() OVER (PARTITION BY src, dst ORDER BY valid_at DESC) rn
           FROM kg_edges WHERE relation='correlates' AND source_ref='batch:leadlag' AND invalid_at IS NULL AND ABS(weight) >= 0.6
         ) WHERE rn=1 ORDER BY ABS(weight) DESC LIMIT 12`,
      ).all() as Array<{ src: string; dst: string; weight: number; lead_lag: number }>).map(e => ({
        from: nm(e.src), to: nm(e.dst), weight: e.weight, leadLag: e.lead_lag, dir: e.weight > 0 ? '동조' : '역행',
      }));
      // 체인 목록
      const chains = (db.query(`SELECT name FROM kg_nodes WHERE kind='chain' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name);
      // P7 <-> M7 최신 관측
      const p7m7 = db.query(`SELECT weight FROM kg_edges WHERE src='group:P7' AND dst='group:M7' AND relation='correlates' AND invalid_at IS NULL ORDER BY valid_at DESC LIMIT 1`).get() as { weight: number } | null;
      // LLM 인과 추출 엣지 수
      const causal = (db.query(`SELECT COUNT(*) c FROM kg_edges WHERE relation IN ('causes','affects') AND extracted_by IN ('grok-fast','local') AND invalid_at IS NULL`).get() as { c: number }).c;
      return {
        stats, chains, propagation,
        p7m7: p7m7 ? { weight: p7m7.weight, relation: p7m7.weight < 0 ? '역관계' : '동조' } : null,
        causalEdges: causal,
        generatedAt: new Date().toISOString(),
      };
    } finally { db.close(); }
  });
}

/** 백테스팅 루프(S1) — 오늘 실험·verdict 분포·승격·최근 실험/페이퍼(ρ). READ-ONLY·페이퍼. */
export function dashboardBacktest(p: { backtestDb?: string } = {}) {
  return soft(() => {
    const path = p.backtestDb ?? conatusPath('backtest.db');
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    try {
      const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_experiments'`).get();
      if (!has) return null;
      const today = new Date().toISOString().slice(0, 10);
      // 최근 실험(최신 verdict/sharpe/pbo 서브쿼리).
      const recent = db.query(
        `SELECT e.id, e.run_date, e.concept, e.strategy, e.hypothesis,
           (SELECT verdict FROM experiment_results r WHERE r.exp_id=e.id ORDER BY r.ts DESC LIMIT 1) AS verdict,
           (SELECT sharpe  FROM experiment_results r WHERE r.exp_id=e.id ORDER BY r.ts DESC LIMIT 1) AS sharpe,
           (SELECT pbo     FROM experiment_results r WHERE r.exp_id=e.id ORDER BY r.ts DESC LIMIT 1) AS pbo
         FROM portfolio_experiments e ORDER BY e.created_at DESC LIMIT 15`,
      ).all() as Array<{ id: string; run_date: string; concept: string; strategy: string; hypothesis: string; verdict: string | null; sharpe: number | null; pbo: number | null }>;
      // 오늘 verdict 분포.
      const byVerdict: Record<string, number> = {};
      for (const r of recent.filter(x => x.run_date === today)) { const v = r.verdict ?? '미검증'; byVerdict[v] = (byVerdict[v] ?? 0) + 1; }
      // 승격 이력(최근).
      const promotions = (db.query(`SELECT ts, exp_id, stage, reason, fund FROM promotions ORDER BY ts DESC LIMIT 8`).all() as Array<{ ts: string; exp_id: string; stage: string; reason: string; fund: string }>);
      const stats = {
        total: (db.query(`SELECT COUNT(*) c FROM portfolio_experiments`).get() as { c: number }).c,
        today: recent.filter(x => x.run_date === today).length,
        confirmed: recent.filter(x => x.verdict === 'CONFIRMED').length,
        paperFills: (db.query(`SELECT COUNT(*) c FROM paper_fills`).get() as { c: number }).c,
      };
      return {
        stats, byVerdict,
        recent: recent.map(r => ({
          id: r.id, runDate: r.run_date, concept: r.concept, strategy: r.strategy,
          hypothesis: r.hypothesis, verdict: r.verdict ?? '미검증',
          sharpe: r.sharpe != null ? Number(r.sharpe.toFixed(2)) : null,
          pbo: r.pbo != null ? Number(r.pbo.toFixed(2)) : null,
        })),
        promotions: promotions.map(p2 => ({ ts: p2.ts, expId: p2.exp_id, stage: p2.stage, fund: p2.fund })),
        generatedAt: new Date().toISOString(),
      };
    } finally { db.close(); }
  });
}

// ── loops — 자율 루프 run 상태 (dig goal · replay · backtest) ──
//
// 방금 arm 된 두 goal-armer 루프(dig_goal_runs·replay_runs)와 백테스팅 사이클의
// run 상태를 한 뷰로. 기존 dashboardDigs(dig 산출물)·dashboardBacktest(실험)와 달리
// "루프가 실제로 돌고 있나"(armed·오늘 발화·마지막 run 상태)를 관측한다. READ-ONLY.

export interface LoopStatus {
  name: string;
  label: string;
  armed: boolean | null;                          // config arming(null=해당없음·backtest)
  today: number;                                  // 오늘 arm/run 횟수
  byStatus: Record<string, number>;               // 상태 분포(running/done/abandoned/expired…)
  last: { at: string; status: string; detail?: string } | null;
  category?: 'exec' | 'reflect';                  // 실행축(dig·backtest·trade)/사색축(replay·retro)
  recent?: Array<{ at: string; status: string; detail?: string }>; // 활동 타임라인(최신순)
}

/** 5 루프 순환 관계(정적) — Loop Orchestra 그래프 엣지. 시계방향 데이터 흐름. */
export const LOOP_EDGES: Array<{ from: string; to: string; label: string }> = [
  { from: 'replay', to: 'dig', label: '재생·공고화' },
  { from: 'dig', to: 'backtest', label: '가설 검증' },
  { from: 'backtest', to: 'trade', label: '검증 전략' },
  { from: 'trade', to: 'retro', label: '성과' },
  { from: 'retro', to: 'replay', label: '피드백' },
];

/** 루프 arming 상태(config·fail-soft). dig/replay = finance.*.autoGoal.enabled. */
function loopArming(): { dig: boolean; replay: boolean } {
  const c = soft(() => getUserConfig());
  return {
    dig: c?.finance?.dig?.autoGoal?.enabled === true,
    replay: c?.finance?.replay?.autoGoal?.enabled === true,
  };
}

/** armed_at·status 를 갖는 run 테이블(dig_goal_runs·replay_runs)의 공통 상태 집계. */
function runsTableStatus(db: Database, table: 'dig_goal_runs' | 'replay_runs', detailCol?: string): { today: number; byStatus: Record<string, number>; last: { at: string; status: string; detail?: string } | null; recent: Array<{ at: string; status: string; detail?: string }> } | null {
  const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!has) return null;
  const byStatus: Record<string, number> = {};
  for (const r of db.query(`SELECT status, COUNT(*) c FROM ${table} GROUP BY status`).all() as Array<{ status: string; c: number }>) byStatus[r.status] = r.c;
  const today = (db.query(`SELECT COUNT(*) c FROM ${table} WHERE date(armed_at)=date('now')`).get() as { c: number }).c;
  const rows = db.query(`SELECT * FROM ${table} ORDER BY armed_at DESC LIMIT 8`).all() as Array<Record<string, unknown>>;
  const toItem = (r: Record<string, unknown>) => ({ at: String(r.armed_at), status: String(r.status), ...(detailCol && r[detailCol] ? { detail: String(r[detailCol]) } : {}) });
  const last = rows[0] ? toItem(rows[0]) : null;
  const recent = rows.map(toItem);
  return { today, byStatus, last, recent };
}

/** trade 루프 — 자율사이클 파일 로그(~/.elanous/conatus/trade_cycle.log) 파싱.
 *  db 가 아니라 타임스탬프 라인이므로 최근 N 줄을 recent 로. */
function tradeLoopStatus(): LoopStatus | null {
  return soft(() => {
    const path = conatusPath('trade_cycle.log');
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const parsed = lines.map((l) => {
      const m = l.match(/^(\S+)\s+(.*)$/);
      if (!m) return null;
      return { at: m[1]!, detail: m[2]!.replace(/^\[[^\]]+\]\s*/, '').slice(0, 120) };
    }).filter((x): x is { at: string; detail: string } => !!x);
    if (!parsed.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const recent = parsed.slice(-8).reverse().map((p) => ({ at: p.at, status: '집행', detail: p.detail }));
    // trade arming = mandate json(armed·live). config 아님(git 밖 대표 편집).
    const mandate = soft(() => JSON.parse(readFileSync(tradeMandatePath(), 'utf8')) as { armed?: boolean });
    const armed = mandate?.armed === true;
    return {
      name: 'trade', label: '매매 자율사이클', armed, category: 'exec' as const,
      today: parsed.filter((p) => p.at.slice(0, 10) === today).length,
      byStatus: {}, last: recent[0] ?? null, recent,
    };
  }) ?? null;
}

/** retro 루프 — 회고 리포트 산출물(~/.elanous/conatus/reflections/REFLECTION-*.md). */
function retroLoopStatus(): LoopStatus | null {
  return soft(() => {
    const dir = conatusPath('reflections');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.startsWith('REFLECTION-') && f.endsWith('.md'));
    if (!files.length) return null;
    const items = files.map((f) => ({
      at: statSync(join(dir, f)).mtime.toISOString(),
      status: '리포트',
      detail: f.replace(/^REFLECTION-/, '').replace(/\.md$/, ''),
    })).sort((a, b) => b.at.localeCompare(a.at));
    const today = new Date().toISOString().slice(0, 10);
    return {
      name: 'retro', label: '회고 루프', armed: null, category: 'reflect' as const,
      today: items.filter((i) => i.at.slice(0, 10) === today).length,
      byStatus: {}, last: items[0] ?? null, recent: items.slice(0, 8),
    };
  }) ?? null;
}

export function dashboardLoops(p: { signalsDb?: string; backtestDb?: string } = {}): { loops: LoopStatus[]; generatedAt: string } | null {
  return soft(() => {
    const arm = loopArming();
    const loops: LoopStatus[] = [];

    // dig goal · replay — signals db.
    const sigPath = p.signalsDb ?? SIGNALS_DB_PATH;
    if (existsSync(sigPath)) {
      const db = new Database(sigPath, { readonly: true });
      try {
        const dig = runsTableStatus(db, 'dig_goal_runs', 'topic');
        if (dig) loops.push({ name: 'dig', label: '자율 디깅(goal)', armed: arm.dig, category: 'exec', ...dig });
        const replay = runsTableStatus(db, 'replay_runs');
        if (replay) loops.push({ name: 'replay', label: '새벽 리플레이', armed: arm.replay, category: 'reflect', ...replay });
      } finally { db.close(); }
    }

    // backtest — 오늘 실험 수 + 최근 run + verdict 분포.
    const btPath = p.backtestDb ?? conatusPath('backtest.db');
    if (existsSync(btPath)) {
      const db = new Database(btPath, { readonly: true });
      try {
        const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_experiments'`).get();
        if (has) {
          const today = new Date().toISOString().slice(0, 10);
          const rows = db.query(
            `SELECT e.run_date, e.strategy,
               (SELECT verdict FROM experiment_results r WHERE r.exp_id=e.id ORDER BY r.ts DESC LIMIT 1) AS verdict
             FROM portfolio_experiments e ORDER BY e.created_at DESC LIMIT 50`,
          ).all() as Array<{ run_date: string; strategy: string; verdict: string | null }>;
          const byStatus: Record<string, number> = {};
          for (const r of rows.filter(x => x.run_date === today)) { const v = r.verdict ?? '미검증'; byStatus[v] = (byStatus[v] ?? 0) + 1; }
          const last = rows[0] ? { at: rows[0].run_date, status: rows[0].verdict ?? '미검증', detail: rows[0].strategy } : null;
          const recent = rows.slice(0, 8).map(r => ({ at: r.run_date, status: r.verdict ?? '미검증', detail: r.strategy }));
          loops.push({ name: 'backtest', label: '백테스팅 루프', armed: null, category: 'exec', today: rows.filter(x => x.run_date === today).length, byStatus, last, recent });
        }
      } finally { db.close(); }
    }

    // trade(자율사이클 파일 로그) · retro(회고 리포트) — db 아닌 파일 소스.
    const trade = tradeLoopStatus();
    if (trade) loops.push(trade);
    const retro = retroLoopStatus();
    if (retro) loops.push(retro);

    return { loops, generatedAt: new Date().toISOString() };
  });
}

// ── ops (운영 상황판 · P4) ──
//
// P1 집계(opsSnapshot/opsHealth/opsTimeline)를 PWA 운영 상황판용으로 조합. aggregate-only·
// fail-soft(각 함수가 이미 fail-soft). "지금 무엇이 어떤 상태로 도나 + 이상 + 전이 이력".
/** 미션 1건 상세(apm_id) — 내용 + 관련 태스크/스케줄/자율행동 fan-in + 전이. PWA 클릭 상세. */
export function dashboardOpsMission(id: string) {
  return soft(() => opsMissionDetail(id));
}

export function dashboardOps() {
  return soft(() => {
    const snap = opsSnapshot();
    const health = opsHealth();
    const timeline = opsTimeline({ limit: 40 });
    return {
      missions: snap.missions,
      tasks: snap.tasks,
      loops: snap.loops,
      orchestration: snap.orchestration,
      schedules: snap.schedules
        ? { elanousTotal: snap.schedules.elanousTotal, staleCount: snap.schedules.stale.length, erroredCount: snap.schedules.errored.length }
        : null,
      health,
      timeline,
      generatedAt: snap.generatedAt,
    };
  });
}
