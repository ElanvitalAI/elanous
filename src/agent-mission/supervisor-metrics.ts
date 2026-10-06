// X2 — 외부 에이전트 미션 슈퍼바이저 품질 지표. 읽기 전용.
// 새 기록을 만들지 않는다. 이미 남는 미션 로그(logs.db)만 집계한다.
// 기록이 없는 지표는 0 이 아니라 «못 잼 · 이유»다. 창 안 미션이 0 이면 «미션 없음».

import { existsSync } from 'node:fs';
import { LogStore, logsDbPath, type LogStoreRow } from '../mss/logging/log-store.js';

export const SUPERVISOR_METRICS_DEFAULT_SINCE = '7d';

const RESULT_CATEGORY = 'agent-mission';
const RESULT_EVENT = 'result';
const DECISION_CATEGORY = 'pty.decision';
const ANSWER_EVENT = 'answer';
const CONTROL_CATEGORY = 'autopilot.control';
const CONTROL_END_EVENT = 'end';
const STALL_CATEGORY = 'self-implement';
const STALL_EVENT = 'frame-stall';
const LADDER_CATEGORY = 'agent-mission.resources';

const LADDER_STEPS = ['needs', 'have', 'official-index', 'backend', 'discover'] as const;

export interface MetricRow {
  readonly id: 'completion' | 'questionsAnswered' | 'unnecessaryInterventions' | 'stall' | 'ladderHits';
  readonly label: string;
  readonly status: 'measured' | 'unmeasured' | 'no-missions';
  readonly reason?: string;
  readonly value?: number | string;
  readonly detail?: Record<string, number | string>;
}

export interface SupervisorMetricsReport {
  readonly since: string;
  readonly sinceMs: number;
  readonly missions: number;
  readonly status: 'measured' | 'no-missions';
  readonly metrics: readonly MetricRow[];
}

export interface SupervisorLogRow {
  readonly tsMs: number;
  readonly category: string;
  readonly event: string;
  readonly data: Record<string, unknown> | null;
}

export interface ReadSupervisorLogs {
  (sinceMs: number, nowMs: number): readonly SupervisorLogRow[];
}

function parseData(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function missionKey(data: Record<string, unknown> | null): string | null {
  const runId = data?.runId;
  if (typeof runId === 'string' && runId.trim()) return runId.trim();
  const missionId = data?.missionId;
  if (typeof missionId === 'string' && missionId.trim()) return missionId.trim();
  return null;
}

function linkedRows(rows: readonly SupervisorLogRow[], missionIds: ReadonlySet<string>): { linked: SupervisorLogRow[]; unlinked: boolean } {
  const linked: SupervisorLogRow[] = [];
  let unlinked = false;
  for (const row of rows) {
    const key = missionKey(row.data);
    if (key && missionIds.has(key)) linked.push(row);
    else unlinked = true;
  }
  return { linked, unlinked };
}

const UNLINKED_REASON = '못 잼 · 미션과 연결 불가';

function unmeasured(id: MetricRow['id'], label: string, reason: string): MetricRow {
  return { id, label, status: 'unmeasured', reason };
}

/** 주입된 로그만으로 다섯 지표를 집계한다. 스토어를 열지 않는다. */
export function aggregateSupervisorMetrics(
  rows: readonly SupervisorLogRow[],
  opts: { since?: string; sinceMs: number },
): SupervisorMetricsReport {
  const since = opts.since ?? SUPERVISOR_METRICS_DEFAULT_SINCE;
  const results = rows.filter((row) => row.category === RESULT_CATEGORY && row.event === RESULT_EVENT);
  const missionIds = new Set(results.map((row) => missionKey(row.data)).filter((key): key is string => key !== null));
  const missions = results.length;
  if (missions === 0) {
    const reason = '미션 없음';
    return {
      since,
      sinceMs: opts.sinceMs,
      missions: 0,
      status: 'no-missions',
      metrics: [
        { id: 'completion', label: '완주율', status: 'no-missions', reason },
        { id: 'questionsAnswered', label: '대화형 질문에 답해 넘긴 수', status: 'no-missions', reason },
        { id: 'unnecessaryInterventions', label: '불필요했던 슈퍼바이저 개입', status: 'no-missions', reason },
        { id: 'stall', label: '멈춤 감지 · 실제 멈춤', status: 'no-missions', reason },
        { id: 'ladderHits', label: '사다리 단계별 적중', status: 'no-missions', reason },
      ],
    };
  }

  const completed = results.filter((row) => row.data?.ok === true).length;
  const completion: MetricRow = {
    id: 'completion',
    label: '완주율',
    status: 'measured',
    value: `${completed}/${missions}`,
    detail: { completed, missions, rate: completed / missions },
  };

  const answerCandidates = rows.filter((row) => row.category === DECISION_CATEGORY && row.event === ANSWER_EVENT);
  const answers = linkedRows(answerCandidates, missionIds);
  const questionsAnswered: MetricRow = answers.unlinked
    ? unmeasured('questionsAnswered', '대화형 질문에 답해 넘긴 수', UNLINKED_REASON)
    : answers.linked.length === 0
    ? unmeasured('questionsAnswered', '대화형 질문에 답해 넘긴 수', '못 잼 · pty.decision answer 기록 없음')
    : {
      id: 'questionsAnswered',
      label: '대화형 질문에 답해 넘긴 수',
      status: 'measured',
      value: answers.linked.length,
      detail: { answered: answers.linked.length },
    };

  const endCandidates = rows.filter((row) => row.category === CONTROL_CATEGORY && row.event === CONTROL_END_EVENT && row.data?.interventionLevel !== undefined);
  const ends = linkedRows(endCandidates, missionIds);
  // 종료 상태와 verdict 는 개입이 불필요했다는 인과 근거가 아니다.
  const unnecessaryInterventions: MetricRow = unmeasured('unnecessaryInterventions', '불필요했던 슈퍼바이저 개입', ends.unlinked
    ? UNLINKED_REASON
    : ends.linked.length === 0
      ? '못 잼 · autopilot.control end 개입 기록 없음'
      : '못 잼 · 개입 불필요성 근거 기록 없음');

  const stallCandidates = rows.filter((row) => row.category === STALL_CATEGORY && row.event === STALL_EVENT);
  const stalls = linkedRows(stallCandidates, missionIds);
  // frame-stall is a detector stage, not a record that a mission actually stopped.
  const stall: MetricRow = unmeasured('stall', '멈춤 감지 · 실제 멈춤', stalls.unlinked
    ? UNLINKED_REASON
    : stalls.linked.length === 0
      ? '못 잼 · self-implement frame-stall 기록 없음'
      : '못 잼 · 실제 멈춤 근거 기록 없음');

  const ladderCandidates = rows.filter((row) => row.category === LADDER_CATEGORY && LADDER_STEPS.includes(row.event as typeof LADDER_STEPS[number]));
  const ladderRows = linkedRows(ladderCandidates, missionIds);
  // VERIFY/ROUTE are decisions. No outcome record connects a step to an observed success.
  const ladderHits: MetricRow = unmeasured('ladderHits', '사다리 단계별 적중', ladderRows.unlinked
    ? UNLINKED_REASON
    : ladderRows.linked.length === 0
      ? '못 잼 · agent-mission.resources 사다리 기록 없음'
      : '못 잼 · 사다리 적중 근거 기록 없음');

  return {
    since,
    sinceMs: opts.sinceMs,
    missions,
    status: 'measured',
    metrics: [completion, questionsAnswered, unnecessaryInterventions, stall, ladderHits],
  };
}

export function readSupervisorLogsFromStore(path: string = logsDbPath()): ReadSupervisorLogs {
  return (sinceMs, nowMs) => {
    if (!existsSync(path)) return [];
    const store = LogStore.openReadOnly(path);
    try {
      const queried: LogStoreRow[] = store.queryAll({
        exactCategories: [RESULT_CATEGORY, DECISION_CATEGORY, CONTROL_CATEGORY, STALL_CATEGORY, LADDER_CATEGORY],
        sinceMs,
        untilMs: nowMs,
      });
      return queried
        .filter((row) => row.ts_ms >= sinceMs && row.ts_ms <= nowMs)
        .filter((row) =>
          (row.category === RESULT_CATEGORY && row.event === RESULT_EVENT)
          || (row.category === DECISION_CATEGORY && row.event === ANSWER_EVENT)
          || (row.category === CONTROL_CATEGORY && row.event === CONTROL_END_EVENT)
          || (row.category === STALL_CATEGORY && row.event === STALL_EVENT)
          || (row.category === LADDER_CATEGORY && (LADDER_STEPS as readonly string[]).includes(row.event)))
        .map((row) => ({ tsMs: row.ts_ms, category: row.category, event: row.event, data: parseData(row.data) }));
    } finally {
      store.close();
    }
  };
}

export function loadSupervisorMetrics(
  since: string,
  sinceMs: number,
  nowMs: number,
  read: ReadSupervisorLogs = readSupervisorLogsFromStore(),
): SupervisorMetricsReport {
  return aggregateSupervisorMetrics(read(sinceMs, nowMs), { since, sinceMs });
}

export function formatSupervisorMetrics(report: SupervisorMetricsReport): string {
  const lines = [`agent-mission metrics · since ${report.since} · 미션 ${report.missions}`];
  if (report.status === 'no-missions') {
    lines.push('미션 없음');
    return lines.join('\n');
  }
  for (const metric of report.metrics) {
    if (metric.status === 'unmeasured') {
      lines.push(`${metric.label}: ${metric.reason}`);
      continue;
    }
    lines.push(`${metric.label}: ${metric.value}`);
  }
  return lines.join('\n');
}
