// ── R5 · 자율루프 편입 — dig goal armer (2026-07-07 · ROADMAP-organic-signal-engine) ──
//
// DigTrigger(dig_queue) → auto-mode goal 자동 셋업. v1 크론 러너(dig-runner
// 결정론)는 그대로 두고, 이 모듈은 같은 큐 위에서 "goal로 승격"하는 v2 경로.
// 실행 자체는 이미 배선된 ContinuationScheduler 싱글턴(§5-③)이 담당 —
// OpportunisticLauncher(TOX 그래프 결합)는 미기동 유지, RESEARCH-loop-engineering
// §2 표 및 L182("Layer2 wire와 termination preset은 같은 PR") 준수.
//
// 5중 가드 (전부 이 PR에 포함):
//   ① 이중 arming 게이트 — `dispatch.enabled` AND `finance.dig.autoGoal.enabled`
//      (둘 다 기본 false · strict-true · 대표 명시 결정 관례)
//   ② termination preset('analysis') — ANALYSIS.md ≥300자 (골 목적 달성 게이트)
//   ③ goal budget.json tokens cap — ContinuationDriver budgetExhausted() 화로가드
//   ④ maxTurns(기본 6·클램프 12) + no-progress andon(driver 기본 3×)
//   ⑤ dig-engine 비용가드 재사용(시간당 2회·섹터 6h 쿨다운) + maxPerDay + TTL 만료
//
// 거버넌스 불변: 분석만(READ-ONLY) — goal 프롬프트는 분석 산출물 작성이 목적이며
// 매매 도구는 continuation turn 표면에 없음. 매매는 verify게이트+HITL 별도.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSignalsDb } from '../domains/breaking-signals.js';
import { ensureDigTables, nextDiggable, type DigItem } from '../domains/dig-engine.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { discoverObsidianVault, type ObsidianVault } from '../auto-research/obsidian-bridge.js';
import { resolveGoalPaths, ensureGoalDir, seedGoalKnowledgeFiles } from '../auto-research/goal-paths.js';
import { writeActiveMd } from '../auto-research/active-md.js';
import { BudgetMeter } from '../auto-research/budget-meter.js';
import { terminationPresetFor } from '../conductor/termination-presets.js';
import { withIndependentChecker } from '../conductor/termination-checker.js';
import type { TerminationRule } from '../auto-research/termination-dsl.js';
import {
  getAutoModeState,
  setAutoModeState,
  generateAutoModeSessionId,
} from '../auto-research/auto-mode/session.js';
import { INACTIVE_AUTO_MODE_STATE } from '../auto-research/auto-mode/types.js';
import type { UserConfig } from '../user-config/types.js';

/** 골당 토큰 캡 — driver의 budgetExhausted() 화로가드가 읽는 budget.json spec. */
const GOAL_TOKEN_CAP = 150_000;
/** 좀비 골 TTL — active인 채 이 시간을 넘기면 강제 해제(싱글턴 웨지 방지). */
const GOAL_TTL_MS = 2 * 60 * 60 * 1000;
const DIG_SLUG_PREFIX = 'dig-';

export interface DigArmerDeps {
  db?: Database;
  vault?: ObsidianVault;
  now?: () => number;
  /** 테스트 seam — 기본 sendOutbound(야간무음 게이트 포함). */
  notify?: (text: string, kind?: string) => void;
}

export interface DigArmerTickResult {
  action: 'disarmed' | 'busy' | 'daily-cap' | 'no-item' | 'armed' | 'finalized-only';
  goalSlug?: string;
  finalized: number;
}

export function ensureDigGoalRunTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS dig_goal_runs(
    goal_slug TEXT PRIMARY KEY, queue_id TEXT, topic TEXT, sector TEXT,
    armed_at TEXT NOT NULL, status TEXT DEFAULT 'running'
  )`);
}

/** arming 이중 게이트 — finance.dig.autoGoal.enabled (dispatch.enabled은
 *  데몬 wire에서 이미 게이트됨 — 이 armer는 dispatch 블록 안에서만 생성). */
export function digAutoGoalEnabled(cfg: UserConfig): boolean {
  return cfg.finance?.dig?.autoGoal?.enabled === true;
}

/** ★ A1 · dig 분석 골 종료조건. 기본 = analysis preset(ANALYSIS.md ≥300자).
 *  independentChecker 켜면 §5-④ 독립 checker(dig-analysis-checker.ts)를 AND 로 합성
 *  — writer 가 아닌 별도 프로세스가 품질(구조·차원)을 검증(자기채점 방지). */
export function digTerminationRule(independentChecker: boolean): TerminationRule {
  const base = terminationPresetFor('analysis');
  if (!independentChecker) return base;
  const script = join(import.meta.dir, '../../scripts/dig-analysis-checker.ts');
  return withIndependentChecker(base, { command: `bun run ${JSON.stringify(script)}`, timeoutMs: 60_000 });
}

function digGoalSlug(item: DigItem, now: number): string {
  const sector = item.sector.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${DIG_SLUG_PREFIX}${sector.slice(0, 40)}-${stamp}`;
}

/** 종료된(비활성) dig 골 run들을 정산: ANALYSIS.md가 남았으면 done +
 *  dig_reports 적재 + 알림, 아니면 abandoned. active인데 TTL 초과면 강제
 *  해제(expired). 정산 건수 반환. */
export function finalizeDigGoalRuns(db: Database, vault: ObsidianVault, deps: DigArmerDeps = {}): number {
  const now = deps.now?.() ?? Date.now();
  const notify = deps.notify ?? sendOutbound;
  const rows = db.prepare(`SELECT * FROM dig_goal_runs WHERE status='running'`).all() as any[];
  let n = 0;
  for (const row of rows) {
    const state = getAutoModeState();
    const stillActive = state.active && state.goalSlug === row.goal_slug;
    if (stillActive) {
      if (now - Date.parse(row.armed_at) < GOAL_TTL_MS) continue; // 정상 진행 중
      // 좀비 — 싱글턴 웨지 방지 강제 해제 (driver는 isActive()=false로 즉시 침묵)
      setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE, exitReason: 'manual', exitDiagnostic: `dig goal TTL expired (${row.goal_slug})` });
      db.prepare(`UPDATE dig_goal_runs SET status='expired' WHERE goal_slug=?`).run(row.goal_slug);
      db.prepare(`UPDATE dig_queue SET status='queued' WHERE id=?`).run(row.queue_id); // 재시도 허용
      n++;
      continue;
    }
    // 더 이상 active 아님 (ExitAutoMode 또는 driver 종말 outcome 후 수동/외부 해제)
    const paths = resolveGoalPaths(vault, row.goal_slug);
    const analysisPath = join(paths.goalRoot, 'ANALYSIS.md');
    let analysis = '';
    try { if (existsSync(analysisPath)) analysis = readFileSync(analysisPath, 'utf-8').trim(); } catch { /* fail-soft */ }
    if (analysis.length >= 300) {
      db.prepare(`INSERT INTO dig_reports(ts, queue_id, topic, sector, verdict, confidence) VALUES (?,?,?,?,?,?)`)
        .run(new Date(now).toISOString(), row.queue_id, row.topic, row.sector, analysis.slice(0, 2000), 'goal-v2');
      db.prepare(`UPDATE dig_goal_runs SET status='done' WHERE goal_slug=?`).run(row.goal_slug);
      db.prepare(`UPDATE dig_queue SET status='done' WHERE id=?`).run(row.queue_id);
      try {
        notify(`⚙️ 자율 디깅(goal) 완료 — ${row.topic}\n\n${analysis.slice(0, 1500)}`, 'report');
      } catch { /* fail-soft */ }
    } else {
      db.prepare(`UPDATE dig_goal_runs SET status='abandoned' WHERE goal_slug=?`).run(row.goal_slug);
      db.prepare(`UPDATE dig_queue SET status='queued' WHERE id=?`).run(row.queue_id); // 재시도 허용
    }
    n++;
  }
  return n;
}

/** 큐 최상위 트리거를 auto-mode goal로 승격. goal dir + ACTIVE.md +
 *  budget.json + termination preset을 셋업하고 AutoModeState를 점화 —
 *  실제 턴은 ContinuationScheduler가 idle 시 드라이브. */
export async function armDigGoal(
  db: Database,
  vault: ObsidianVault,
  item: DigItem,
  cfg: UserConfig,
  deps: DigArmerDeps = {},
): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const goalSlug = digGoalSlug(item, now);
  const paths = resolveGoalPaths(vault, goalSlug);
  ensureGoalDir(paths);
  seedGoalKnowledgeFiles(paths);
  writeActiveMd(paths.goalRoot, {
    goalSlug,
    goalKind: 'analysis',
    intake: {
      raw: `[자율 디깅 · READ-ONLY 분석] ${item.topic}\n\n`
        + `목표: 위 신호의 국면판단·영향경로·매매함의(관찰 포인트)·확신도를 조사해 `
        + `goal 디렉터리의 ANALYSIS.md(300자 이상)로 작성하라. 매매 지시·주문은 금지 — 분석만.`,
      channel: 'dig-engine',
      requestedAt: now,
      requester: 'dig-goal-armer',
    },
    classifier: 'heuristic',
    confidence: 0.9,
    classifiedAt: now,
    routedAdapter: 'continuation-scheduler',
  });
  // ③ 화로가드 spec — driver의 budgetExhausted()가 budget.json caps를 읽음.
  await new BudgetMeter({ tokens: GOAL_TOKEN_CAP }).persist(paths.budgetFile);
  const maxTurns = cfg.finance?.dig?.autoGoal?.maxTurns ?? 6;

  db.prepare(`INSERT OR REPLACE INTO dig_goal_runs(goal_slug, queue_id, topic, sector, armed_at, status) VALUES (?,?,?,?,?,'running')`)
    .run(goalSlug, item.id, item.topic, item.sector, new Date(now).toISOString());
  db.prepare(`UPDATE dig_queue SET status='goal' WHERE id=?`).run(item.id);

  setAutoModeState({
    active: true,
    sessionId: generateAutoModeSessionId(),
    goalSlug,
    goalKind: 'analysis',
    startedAt: now,
    maxTurns,
    turnIndex: 0,
    phase: 'kickoff',
    // ② termination preset — ANALYSIS.md ≥300자 (+ A1 opt-in 독립 checker).
    terminationRule: digTerminationRule(cfg.finance?.dig?.autoGoal?.independentChecker === true),
  });
  return goalSlug;
}

/** 데몬 폴러 1틱: 정산 → 게이트 → 캡 → 큐 픽 → arming. */
export async function digGoalArmerTick(cfg: UserConfig, deps: DigArmerDeps = {}): Promise<DigArmerTickResult> {
  if (!digAutoGoalEnabled(cfg)) return { action: 'disarmed', finalized: 0 };
  const db = deps.db ?? openSignalsDb();
  const ownDb = !deps.db;
  try {
    ensureDigTables(db);
    ensureDigGoalRunTable(db);
    const vault = deps.vault ?? discoverObsidianVault();
    const finalized = finalizeDigGoalRuns(db, vault, deps);

    // 싱글턴 — 어떤 goal이든(dig 아니어도) active면 양보.
    if (getAutoModeState().active) return { action: 'busy', finalized };

    // maxPerDay 캡 (armed_at 기준 당일 arming 횟수 — expired/abandoned 포함:
    // 실패 루프가 캡을 소진하지 못하게 되려 안전한 방향).
    const maxPerDay = cfg.finance?.dig?.autoGoal?.maxPerDay ?? 2;
    const today = (db.prepare(`SELECT COUNT(*) AS n FROM dig_goal_runs WHERE date(armed_at) = date('now')`).get() as any)?.n ?? 0;
    if (today >= maxPerDay) return { action: 'daily-cap', finalized };

    // ⑤ dig-engine 비용가드 재사용 (시간당 2회 · 섹터 6h 쿨다운).
    const item = nextDiggable(db);
    if (!item) return { action: finalized > 0 ? 'finalized-only' : 'no-item', finalized };

    const goalSlug = await armDigGoal(db, vault, item, cfg, deps);
    return { action: 'armed', goalSlug, finalized };
  } finally {
    if (ownDb) db.close();
  }
}
