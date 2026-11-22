/**
 * TA-SWEEP-PERIODIC(FU of TA-LAUNCH-RESULT-LOOP · 칸 0.3.33) — 15분 무진척 발사 회수를 주기로 돈다.
 *
 * 관측 고리(`tasks show`)의 회수는 «누가 볼 때만» 도돌아간다 — 이 노드가 스튜어드 그래프 틱(15분,
 * graphs/steward/steward.yaml)에 편승해 전체 카드 원장을 훑으면 무진척 발사가 관측 없이도
 * 한 틱 안에 회수 후보로 오른다. TA-REJUDGE-PERIODIC(rejudge-tick.ts)와 같은 결:
 * 신규 상주 루프 없음 · 스탬프 선점 · fail-soft · 매 틱 관측 한 줄.
 *
 * - Off by default: `taskAgent.sweepEveryMinutes` absent/0 → one `disabled` line per tick and nothing else.
 *   회수는 카드 원장에 skip-note 를 남긴다(재발사 판단은 사람/판단부 몫) — 사람이 켠다.
 * - Cadence: due when the last started sweep is ≥ interval − 2 min ago (tick start jitter must not skip a whole tick).
 *   지연 주장의 가동 창 한정: 스튜어드 틱은 cron 심박 «08:00~23:59 동 매 15분»(graphs/steward/steward.yaml
 *   의 8-23시 · 15분 간격) 안에서만 돈다. «심박 15분 + 무진척 임계 15분 → 최악 <30분»은 이 창 «안»의
 *   최악이다 — 00:00~07:59 야간에는 틱이 없어 스윕도 없다(야간 무진척 발사는 다음 08:00 틱의 회수 후보).
 * - No load guard: rejudge needed one for its 600 s `tasks rejudge` child; this sweep is inline ledger reads
 *   plus one stop line per stalled card — no child processes.
 * - Fail-soft: every outcome exits 0 — a sweep problem never stops the steward's own stages.
 *   카드 읽기는 주장(stamp) 전에 한다 — 원장 읽기 실패가 cadence claim 을 태우지 않는다(다음 틱 재시도).
 * - Observation: one `debug.log('loop.steward', 'ta-sweep-tick', …)` line per tick.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig } from '../user-config/reader.js';
import { readTaskAgentState, taskAgentStatePath } from '../task-agent/task-card-state.js';
import { recycleStalledLaunches, runLedgerReasonCodeFor, type TaRecycleOutcome } from '../task-agent/launch-result-loop.js';
import type { TaskCard } from '../task-agent/task-hand.js';

export const TA_SWEEP_TICK_EVENT = 'ta-sweep-tick';
/** Tick start jitter — a sweep due inside the interval by less than this still fires (same number as REJUDGE_JITTER_MS). */
export const SWEEP_JITTER_MS = 2 * 60_000;

export type TaSweepTickDecision = 'disabled' | 'not-due' | 'ran' | 'failed';

export interface TaSweepTickResult {
  decision: TaSweepTickDecision;
  everyMinutes: number | null;
  /** Cards seen in the ledger when due. */
  cards?: number;
  /** Recycled (skip-noted) launches this sweep — 성공(stopRecorded=true) outcome 만 센다. */
  recycled?: number;
  /** Stop 시도 중 run 원장 stop 기록에 실패한 수(outcome.stopRecorded=false) — recycled 와 별개 관측치. */
  stopRecordFailed?: number;
  outcomes?: TaRecycleOutcome[];
  lastStartedAt?: string | null;
  ms?: number;
  reason?: string;
}

export interface TaSweepTickDeps {
  now?: () => Date;
  /** `taskAgent.sweepEveryMinutes` — default reads the user config. */
  config?: () => { sweepEveryMinutes?: number } | undefined;
  stampPath?: string;
  /** 카드 원장 경로(기본 = 이 우주 task-agent-actions.json). */
  statePath?: string;
  /** 전체 카드 판독기(기본 = 원장 tasks 전체). */
  cards?: () => readonly TaskCard[];
  /** 회수 실행부(기본 = recycleStalledLaunches, 원인 정본 = 런 원장 stop 기록). */
  recycle?: (cards: readonly TaskCard[], nowMs: number) => TaRecycleOutcome[];
  log?: (event: string, data: Record<string, unknown>) => void;
}

function defaultStampPath(): string {
  // Resolved at call time, in the node process's own universe (prod cron vs --test graph run).
  return join(effectiveInstanceRoot(), 'steward', 'ta-sweep-tick.json');
}

function readStamp(path: string): string | null {
  try {
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { startedAt?: unknown }).startedAt;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      throw new Error(`invalid steward stamp startedAt: ${path}`);
    }
    return value;
  } catch (error) {
    // A missing stamp is the first tick. A corrupt or unreadable existing stamp is not:
    // claiming it would overwrite the evidence and could launch an overlapping sweep.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 전체 카드 — 원장 tasks 객체를 값 목록으로(관측 고리의 한 카드가 아니라 전부). */
function defaultCards(statePath: string | undefined): () => readonly TaskCard[] {
  return () => {
    const state = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(statePath ?? taskAgentStatePath());
    return Object.values(state.tasks ?? {});
  };
}

/** 회수 실행부 — 관측 고리(tasks-card-show)와 같은 provider 결합(원인 정본 = 런 원장 stop 기록). */
function defaultRecycle(statePath: string | undefined): (cards: readonly TaskCard[], nowMs: number) => TaRecycleOutcome[] {
  return (cards, nowMs) => recycleStalledLaunches(cards, {
    nowMs,
    reasonCodeFor: runLedgerReasonCodeFor,
    ...(statePath !== undefined ? { statePath } : {}),
  });
}

export function taSweepTick(deps: TaSweepTickDeps = {}): TaSweepTickResult {
  const log = deps.log ?? ((event, data) => debug.log('loop.steward', event, data));
  const emit = (result: TaSweepTickResult): TaSweepTickResult => {
    try { log(TA_SWEEP_TICK_EVENT, { ...result }); } catch { /* fail-soft */ }
    return result;
  };
  try {
    const cfg = (deps.config ?? (() => getUserConfig().taskAgent))();
    const everyMinutes = positive(cfg?.sweepEveryMinutes);
    if (everyMinutes === null) return emit({ decision: 'disabled', everyMinutes: null, reason: 'taskAgent.sweepEveryMinutes unset' });
    const now = (deps.now ?? (() => new Date()))();
    const stampPath = deps.stampPath ?? defaultStampPath();
    const lastStartedAt = readStamp(stampPath);
    if (lastStartedAt && now.getTime() - Date.parse(lastStartedAt) < everyMinutes * 60_000 - SWEEP_JITTER_MS) {
      return emit({ decision: 'not-due', everyMinutes, lastStartedAt });
    }
    // 카드는 주장 전에 읽는다 — 원장 읽기 실패가 cadence claim 을 태우지 않는다(다음 틱 재시도).
    const cards = (deps.cards ?? defaultCards(deps.statePath))();
    // 주장은 스윕 전 — best-effort 중복 완충(비원자 check-then-write 라 겹친 틱을 완전히 막지는 못함). 완전 방어는 카드 원장 잠금 ⊕ runId 멱등(launch-result-loop).
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ startedAt: now.toISOString() }));
    const started = Date.now();
    const outcomes = (deps.recycle ?? defaultRecycle(deps.statePath))(cards, now.getTime());
    // 집계 — 회수 성공(recycled)은 run 원장 stop 이 «기록된» outcome 만 센다. recordStop 이 false 를
    // 돌려준 실패 stop 시도(launch-result-loop: ta-stop-record-failed)도 outcome 으로 오지만, 이를
    // recycled 에 세면 정지 기록 실패가 회수 성공으로 오표시된다(JUD-C #39483) — 별도 관측치로 노출.
    const recycled = outcomes.filter((row) => row.stopRecorded);
    const stopRecordFailed = outcomes.length - recycled.length;
    return emit({
      decision: 'ran', everyMinutes, cards: cards.length,
      recycled: recycled.length, stopRecordFailed, outcomes, lastStartedAt,
      ms: Date.now() - started,
    });
  } catch (error) {
    return emit({ decision: 'failed', everyMinutes: null, reason: (error instanceof Error ? error.message : String(error)).slice(-300) });
  }
}

if (import.meta.main) {
  try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('steward'); }
  catch (error) { console.error(`steward ta-sweep: log sink registration failed — ${error instanceof Error ? error.message : String(error)}`); }
  const result = taSweepTick();
  console.log(`steward ta-sweep: ${result.decision}${result.reason ? ` — ${result.reason}` : ''}`);
  process.exitCode = 0;
}