// ── M4 · 새벽 수면 리플레이 armer (2026-07-08 · 5+2 자율루프 세 번째 조각) ──
//
// 세 자율 루프 = 분석(event·dig-goal-armer) · 매매(event·trade-cycle) · **리플레이
// (idle·이 모듈)**. 리플레이는 단발 배치가 아니라 idle-driven 자율 루프다
// (PLAN-regime-synthesis §5.1): 새벽 창(기본 06-07 KST·미국장 마감 후·한국장 전)에
// idle 이면 리플레이 goal 을 arm → 기존 ContinuationScheduler(§5-③ 싱글턴)가 드라이브.
//
// dig-goal-armer 자매 모듈. 차이: 큐 픽업이 아니라 시간창(idle 수면 창)+일일 1회로 발화.
// 3정리(SWS 기억·REM 온톨로지·SHY 벡터)의 결정론 부분은 kg-consolidate 배치가 이미
// 수행 — 리플레이 goal 은 그 위에 **사람이 읽는 회고 요약(REPLAY.md)** 를 얹는 자율 정리다
// (중복 아님·상보). 종료조건 = REPLAY.md ≥300자.
//
// 5중 가드(dig-goal-armer 와 동형):
//   ① 이중 arming — dispatch.enabled AND finance.replay.autoGoal.enabled (기본 false)
//   ② termination preset('replay') — REPLAY.md ≥300자
//   ③ budget.json tokens cap — ContinuationDriver budgetExhausted() 화로가드
//   ④ maxTurns(기본 3·저턴) + no-progress andon(driver 기본 3×)
//   ⑤ 시간창(06-07) + 일일 1회 + 싱글턴(active면 양보) + TTL
//
// 거버넌스 불변: READ-ONLY 정리·회고만 — 매매/발송지시 도구는 continuation turn 표면에
// 없다(대표 프로필 미오염). arming 도 dispatch 게이트 하(분석 루프와 동일 축).

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSignalsDb } from '../domains/breaking-signals.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { recordAutonomousActionSafe } from '../domains/autonomy-log.js';
import { discoverObsidianVault, type ObsidianVault } from '../auto-research/obsidian-bridge.js';
import { resolveGoalPaths, ensureGoalDir, seedGoalKnowledgeFiles } from '../auto-research/goal-paths.js';
import { writeActiveMd } from '../auto-research/active-md.js';
import { BudgetMeter } from '../auto-research/budget-meter.js';
import type { TerminationRule } from '../auto-research/termination-dsl.js';
import {
  getAutoModeState,
  setAutoModeState,
  generateAutoModeSessionId,
} from '../auto-research/auto-mode/session.js';
import { INACTIVE_AUTO_MODE_STATE } from '../auto-research/auto-mode/types.js';
import type { UserConfig } from '../user-config/types.js';

/** 좀비 골 TTL — active인 채 이 시간을 넘기면 강제 해제(싱글턴 웨지 방지). 리플레이는
 *  저턴이라 dig(2h)보다 짧게. */
const REPLAY_TTL_MS = 90 * 60 * 1000;
const REPLAY_SLUG_PREFIX = 'replay-';
/** REPLAY.md 최소 길이 — termination + 정산 done 판정 공용. */
export const REPLAY_MIN_CHARS = 300;

export interface ReplayArmerDeps {
  db?: Database;
  vault?: ObsidianVault;
  now?: () => number;
  /** 테스트 seam — 기본 sendOutbound(야간무음 게이트 포함). */
  notify?: (text: string, kind?: string) => void;
}

export interface ReplayArmerTickResult {
  action: 'disarmed' | 'off-window' | 'busy' | 'daily-done' | 'armed' | 'finalized-only';
  goalSlug?: string;
  finalized: number;
}

export function ensureReplayRunTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS replay_runs(
    goal_slug TEXT PRIMARY KEY, armed_at TEXT NOT NULL, status TEXT DEFAULT 'running'
  )`);
}

/** arming 이중 게이트 — finance.replay.autoGoal.enabled (dispatch.enabled은 데몬 wire에서
 *  이미 게이트됨 — 이 armer는 dispatch 블록 안에서만 생성). */
export function replayAutoGoalEnabled(cfg: UserConfig): boolean {
  return cfg.finance?.replay?.autoGoal?.enabled === true;
}

/** ★ 리플레이 골 종료조건('replay' preset) — REPLAY.md ≥300자. goalKind 클로즈드 유니언을
 *  건드리지 않고 명시 rule 로 주입(dig 의 digTerminationRule 선례와 동일 패턴). */
export function replayTerminationRule(): TerminationRule {
  return { kind: 'summary_written', path: 'REPLAY.md', minChars: REPLAY_MIN_CHARS };
}

/** 지금이 새벽 리플레이 창(기본 06-07시·로컬)인가. [start, end) 반개구간. */
export function inReplayWindow(now: number, startHour = 6, endHour = 7): boolean {
  const h = new Date(now).getHours();
  return h >= startHour && h < endHour;
}

function replaySlug(now: number): string {
  const d = new Date(now);
  return `${REPLAY_SLUG_PREFIX}${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 종료된(비활성) 리플레이 run 정산: REPLAY.md ≥300자면 done + 요약 알림, 아니면
 *  abandoned. active인데 TTL 초과면 강제 해제(expired). 정산 건수 반환. */
export function finalizeReplayRuns(db: Database, vault: ObsidianVault, deps: ReplayArmerDeps = {}): number {
  const now = deps.now?.() ?? Date.now();
  const notify = deps.notify ?? sendOutbound;
  const rows = db.prepare(`SELECT * FROM replay_runs WHERE status='running'`).all() as any[];
  let n = 0;
  for (const row of rows) {
    const state = getAutoModeState();
    const stillActive = state.active && state.goalSlug === row.goal_slug;
    if (stillActive) {
      if (now - Date.parse(row.armed_at) < REPLAY_TTL_MS) continue; // 정상 진행 중
      // 좀비 — 싱글턴 웨지 방지 강제 해제.
      setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE, exitReason: 'manual', exitDiagnostic: `replay goal TTL expired (${row.goal_slug})` });
      db.prepare(`UPDATE replay_runs SET status='expired' WHERE goal_slug=?`).run(row.goal_slug);
      n++;
      continue;
    }
    // 더 이상 active 아님 — REPLAY.md 확인.
    const paths = resolveGoalPaths(vault, row.goal_slug);
    const replayPath = join(paths.goalRoot, 'REPLAY.md');
    let replay = '';
    try { if (existsSync(replayPath)) replay = readFileSync(replayPath, 'utf-8').trim(); } catch { /* fail-soft */ }
    if (replay.length >= REPLAY_MIN_CHARS) {
      db.prepare(`UPDATE replay_runs SET status='done' WHERE goal_slug=?`).run(row.goal_slug);
      try {
        notify(`🌙 새벽 리플레이 완료 — 24h 기억 정리·회고\n\n${replay.slice(0, 1500)}`, 'report');
      } catch { /* fail-soft */ }
      // Autopilot P0.2 — 자율행동(새벽 리플레이 완료) 회상 로깅. 24h 기억 공고화 회고.
      recordAutonomousActionSafe({
        loop: 'replay',
        action: `새벽 리플레이 완료 (${row.goal_slug})`,
        rationale: 'idle 새벽창 — 24h 발송·속보·디깅·온톨로지 공고화 회고(READ-ONLY)',
        outcome: `REPLAY.md ${replay.length}자 요약`,
        refs: { goalSlug: row.goal_slug },
      });
    } else {
      db.prepare(`UPDATE replay_runs SET status='abandoned' WHERE goal_slug=?`).run(row.goal_slug);
    }
    n++;
  }
  return n;
}

/** 리플레이 goal 셋업 — goal dir + ACTIVE.md + budget.json + termination('replay').
 *  실제 턴은 ContinuationScheduler가 idle 시 드라이브. */
export async function armReplayGoal(
  db: Database,
  vault: ObsidianVault,
  cfg: UserConfig,
  deps: ReplayArmerDeps = {},
): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const goalSlug = replaySlug(now);
  const paths = resolveGoalPaths(vault, goalSlug);
  ensureGoalDir(paths);
  seedGoalKnowledgeFiles(paths);
  writeActiveMd(paths.goalRoot, {
    goalSlug,
    goalKind: 'analysis', // 클로즈드 유니언 미변경 — READ-ONLY 회고 산출물(analysis 계열)
    intake: {
      raw: `[새벽 리플레이 · READ-ONLY 회고] 지난 24시간 기억 공고화 정리\n\n`
        + `목표: 최근 24h 의 발송(surface_events)·속보(breaking)·자율 디깅(dig_reports)·`
        + `온톨로지 공고화(kg-consolidate 산출)를 읽고, 무엇이 기억으로 남았고(SWS)·`
        + `어떤 인과/스키마가 통합됐고(REM)·무엇이 중복/노후로 정리됐는지(SHY)를 회고해 `
        + `goal 디렉터리의 REPLAY.md(${REPLAY_MIN_CHARS}자 이상)로 요약하라. `
        + `READ-ONLY 정리·회고만 — 매매 지시·주문·발송 지시는 금지.`,
      channel: 'replay-scheduler',
      requestedAt: now,
      requester: 'replay-goal-armer',
    },
    classifier: 'heuristic',
    confidence: 0.95,
    classifiedAt: now,
    routedAdapter: 'continuation-scheduler',
  });
  // ③ 화로가드 spec — driver의 budgetExhausted()가 budget.json caps를 읽음.
  const tokenCap = cfg.finance?.replay?.autoGoal?.tokenCap ?? 80_000;
  await new BudgetMeter({ tokens: tokenCap }).persist(paths.budgetFile);
  const maxTurns = cfg.finance?.replay?.autoGoal?.maxTurns ?? 3;

  db.prepare(`INSERT OR REPLACE INTO replay_runs(goal_slug, armed_at, status) VALUES (?,?,'running')`)
    .run(goalSlug, new Date(now).toISOString());

  setAutoModeState({
    active: true,
    sessionId: generateAutoModeSessionId(),
    goalSlug,
    goalKind: 'analysis',
    startedAt: now,
    maxTurns,
    turnIndex: 0,
    phase: 'kickoff',
    // ② termination preset 'replay' — REPLAY.md ≥300자.
    terminationRule: replayTerminationRule(),
  });
  return goalSlug;
}

/** 데몬 폴러 1틱: 정산 → 게이트 → 시간창 → 싱글턴 → 일일1회 → arming. */
export async function replayGoalArmerTick(cfg: UserConfig, deps: ReplayArmerDeps = {}): Promise<ReplayArmerTickResult> {
  if (!replayAutoGoalEnabled(cfg)) return { action: 'disarmed', finalized: 0 };
  const db = deps.db ?? openSignalsDb();
  const ownDb = !deps.db;
  try {
    ensureReplayRunTable(db);
    const vault = deps.vault ?? discoverObsidianVault();
    const finalized = finalizeReplayRuns(db, vault, deps);

    // 시간창 밖(장중 등) → 양보. 정산만 하고 반환.
    const now = deps.now?.() ?? Date.now();
    const startHour = cfg.finance?.replay?.autoGoal?.windowStartHour ?? 6;
    const endHour = cfg.finance?.replay?.autoGoal?.windowEndHour ?? 7;
    if (!inReplayWindow(now, startHour, endHour)) {
      return { action: finalized > 0 ? 'finalized-only' : 'off-window', finalized };
    }

    // 싱글턴 — 어떤 goal이든 active면 양보.
    if (getAutoModeState().active) return { action: 'busy', finalized };

    // 일일 1회 — 오늘 이미 arm 했으면 스킵(재시도 무한루프 방지·실패도 소진).
    const today = (db.prepare(`SELECT COUNT(*) AS n FROM replay_runs WHERE date(armed_at) = date('now')`).get() as any)?.n ?? 0;
    if (today >= 1) return { action: 'daily-done', finalized };

    const goalSlug = await armReplayGoal(db, vault, cfg, deps);
    return { action: 'armed', goalSlug, finalized };
  } finally {
    if (ownDb) db.close();
  }
}
