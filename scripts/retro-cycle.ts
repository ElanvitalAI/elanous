#!/usr/bin/env bun
// ── 회고 루프 실배선 (R3 · 2026-07-08) ────────────────────────────────────
//
// 주/월/분기/연 회고 실행 엔트리 — 실 DB(backtest.db·regime.db)에서 기간 집계 →
// REFLECTION-<period>.md 저장 → 리밸런싱 제안(HITL 알림). 리밸런싱은 대표 승인 후.
// 사용: bun scripts/retro-cycle.ts --period weekly|monthly|quarterly|annual
// 리포트: ~/.elanous/conatus/reflections/. [[ROADMAP-...]] R3.

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { runRetroCycle } from '../src/domains/retro-cycle.js';
import type { RetroPeriod, BacktestAgg, RegimeAgg, SurfaceAgg } from '../src/domains/retro-aggregate.js';
import type { PromotionCandidate } from '../src/domains/retro-rebalance.js';
import { narrateRetro } from '../src/domains/retro-report.js';
import { BACKTEST_DB_PATH } from '../src/domains/backtest-store.js';
import { REGIME_DB_PATH } from '../src/domains/regime-store.js';
import { openSurfaceEventsDb, queryEvents, surfaceEventsDbPath } from '../src/domains/surface-events.js';
import { aggregateMissionRetros } from '../src/autopilot/mission-retrospect.js';
import { recordAutonomousActionSafe } from '../src/domains/autonomy-log.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// ⛔⭐ 거부는 «맨 앞»이다 — 이 파일은 모듈 최상위에서 argv 를 읽으므로 그 뒤면 늦다.
//   ⛔ 그리고 «한 줄»로 낸다 — 최상위 throw 는 스택 트레이스를 흘리고, 크론 로그에서 그것은 잡음이다.
//   ✅ 바로 아래 `잘못된 period` 처리와 «같은 꼴»(console.error ⊕ exit 1)로 맞춘다.
const unknownFlag = unknownCronFlag(process.argv, { boolean: ['--collect-only'], valued: ['--period'] });
if (unknownFlag) { console.error(`⛔ 모르는 플래그: ${unknownFlag}`); process.exit(1); }

const pIdx = process.argv.indexOf('--period');
const period = (pIdx >= 0 ? process.argv[pIdx + 1] : 'weekly') as RetroPeriod;
if (!['weekly', 'monthly', 'quarterly', 'annual'].includes(period)) { console.error(`잘못된 period: ${period}`); process.exit(1); }

const REPORT_DIR = join(homedir(), '.elanous/conatus/reflections');
const LOG = join(homedir(), '.elanous/conatus/retro_cycle.log');
const log = (m: string): void => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* */ } };

// backtest.db 기간 집계.
function backtestAgg(from: string, to: string): BacktestAgg {
  if (!existsSync(BACKTEST_DB_PATH)) return { experiments: 0, byVerdict: {}, confirmed: 0, promotions: 0, topStrategies: [] };
  const db = new Database(BACKTEST_DB_PATH, { readonly: true });
  try {
    const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_experiments'`).get();
    if (!has) return { experiments: 0, byVerdict: {}, confirmed: 0, promotions: 0, topStrategies: [] };
    const rows = db.query(
      `SELECT e.strategy,
         (SELECT verdict FROM experiment_results r WHERE r.exp_id=e.id ORDER BY r.ts DESC LIMIT 1) AS verdict
       FROM portfolio_experiments e WHERE e.run_date >= ? AND e.run_date <= ?`,
    ).all(from, to) as Array<{ strategy: string; verdict: string | null }>;
    const byVerdict: Record<string, number> = {};
    const byStrat: Record<string, { count: number; confirmed: number }> = {};
    for (const r of rows) {
      const v = r.verdict ?? '미검증'; byVerdict[v] = (byVerdict[v] ?? 0) + 1;
      const s = byStrat[r.strategy] ?? { count: 0, confirmed: 0 };
      s.count++; if (v === 'CONFIRMED') s.confirmed++; byStrat[r.strategy] = s;
    }
    const promotions = (db.query(`SELECT COUNT(*) c FROM promotions WHERE date(ts) >= ? AND date(ts) <= ?`).get(from, to) as { c: number }).c;
    const topStrategies = Object.entries(byStrat).map(([strategy, v]) => ({ strategy, ...v })).sort((a, b) => b.confirmed - a.confirmed || b.count - a.count);
    return { experiments: rows.length, byVerdict, confirmed: byVerdict.CONFIRMED ?? 0, promotions, topStrategies };
  } finally { db.close(); }
}

// regime.db 기간 집계.
function regimeAgg(from: string, to: string): RegimeAgg | null {
  if (!existsSync(REGIME_DB_PATH)) return null;
  const db = new Database(REGIME_DB_PATH, { readonly: true });
  try {
    const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='regime_vector'`).get();
    if (!has) return null;
    const rows = db.query(`SELECT composite, regime_label, transition FROM regime_vector WHERE as_of >= ? AND as_of <= ? ORDER BY as_of`).all(from, to) as Array<{ composite: number; regime_label: string; transition: number }>;
    if (!rows.length) return null;
    const distribution: Record<string, number> = {};
    let sum = 0, transitions = 0;
    for (const r of rows) { sum += r.composite; distribution[r.regime_label] = (distribution[r.regime_label] ?? 0) + 1; if (r.transition) transitions++; }
    return { samples: rows.length, transitions, meanComposite: sum / rows.length, current: rows[rows.length - 1]!.regime_label, distribution };
  } finally { db.close(); }
}

// 승격 후보(backtest.db promotions 최신 stage).
function candidates(): PromotionCandidate[] {
  if (!existsSync(BACKTEST_DB_PATH)) return [];
  const db = new Database(BACKTEST_DB_PATH, { readonly: true });
  try {
    const has = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='promotions'`).get();
    if (!has) return [];
    const rows = db.query(
      `SELECT p.exp_id, p.stage, (SELECT strategy FROM portfolio_experiments e WHERE e.id=p.exp_id) AS strategy
       FROM promotions p WHERE p.id IN (SELECT MAX(id) FROM promotions GROUP BY exp_id)`,
    ).all() as Array<{ exp_id: string; stage: string; strategy: string | null }>;
    return rows.map(r => ({ expId: r.exp_id, stage: r.stage, strategy: r.strategy ?? 'unknown' }));
  } finally { db.close(); }
}

// 크로스서피스 기억(미엘린) 기간 집계 — 발송·종류·재참조·상위 중요.
function surfaceAgg(from: string, to: string): SurfaceAgg | null {
  if (!existsSync(surfaceEventsDbPath())) return null;
  const db = openSurfaceEventsDb();
  try {
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400_000));
    const rows = queryEvents(db, { direction: 'outbound', sinceHours: days * 24, limit: 500 });
    if (!rows.length) return null;
    const byKind: Record<string, number> = {};
    let recalled = 0;
    for (const r of rows) { const k = r.kind ?? 'etc'; byKind[k] = (byKind[k] ?? 0) + 1; if ((r.recall_count ?? 0) > 0) recalled++; }
    const topImportant = [...rows].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, 3)
      .map(r => ({ summary: (r.summary || r.text || '').slice(0, 80), kind: r.kind ?? 'etc', importance: r.importance ?? 0 }));
    return { outbound: rows.length, byKind, recalled, topImportant };
  } catch { return null; } finally { db.close(); }
}

mkdirSync(REPORT_DIR, { recursive: true });
const report = await runRetroCycle({
  // C3 (2026-07-18) — 미션 회고(C1 안착·C2 피드백) 집계를 주간 리포트에 합류(비파괴 opt-in).
  retro: { backtest: backtestAgg, regime: regimeAgg, surface: surfaceAgg, missions: (from, to) => aggregateMissionRetros(from, to) },
  candidates,
  // LLM 정성 서사(fail-soft) — provider 없으면 정량 base 그대로.
  narrate: narrateRetro,
  writeReport: (filename, md) => {
    const p = join(REPORT_DIR, filename); writeFileSync(p, md);
    // ★ B5: --collect-only 면 발송 억제(회고 리포트 영속·resolution/발굴 입력·발송만 skip).
    if (process.argv.includes('--collect-only')) log(`collect-only — 회고 리포트 영속·발송 skip`);
    else try { log(`회고 리포트 발송 ${sendOutbound(md, 'ops-report') ? 'OK' : '실패'}`); } catch (e) { log(`발송 오류: ${e instanceof Error ? e.message : String(e)}`); }
    return p;
  },
  // HITL 승인 요청 — 텔레그램 alert(collect-only 면 로그만).
  notify: (t) => { log(`[HITL] ${t.replace(/\n/g, ' ')}`); if (!process.argv.includes('--collect-only')) try { sendOutbound(t, 'ops-alert'); } catch { /* fail-soft */ } },
}, period);

log(`retro ${period}: report=${report.reportPath} · 제안=${report.hasProposal ? report.proposalId : '없음'}`);

// Autopilot P0.2 — 자율행동(회고 루프) 회상 로깅. 리밸런싱 제안은 HITL 승인 대기(자율집행 아님).
recordAutonomousActionSafe({
  loop: 'retro',
  action: `${period} 회고 리포트 발행`,
  rationale: '기간 성과 집계(백테스트·국면·발송) → 리밸런싱 제안(HITL 승인 대기)',
  outcome: report.hasProposal ? `리밸런싱 제안 ${report.proposalId}(승인 대기)` : '제안 없음',
  refs: { reportPath: report.reportPath },
});

console.log(JSON.stringify(report, null, 2));
