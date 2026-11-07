// ── 스케줄 헬스 리포트 포맷 (P3 프로액티브 관측성) ─────────────────────
//
// 대표 지시: "로깅 방법과 실제 실행이 제대로 모니터링 되도록." P1 이 실행 결과를
// 기록하고 P2 가 대시보드에 노출했다면, P3 는 텔레그램으로 밀어 알린다.
//   · digest: 매일 아침 요약(밀림 없어도 발송 — "정상 N개 다 돎" 확인).
//   · alert : 문제(밀림/실패) 있을 때만 발송(없으면 null — 무음).
// 포맷은 순수 함수(테스트 가능) · 발송은 scripts/schedule-health-report.ts.

import type { ScheduleHealth, JobHealth } from './schedule-registry.js';
import { formatDateTime } from '../time/calendar.js';

/** 독립 프로세스 로그 싱크 커버리지 — 스케줄 헬스(밀림/실패/정규형)와 다른 축. */
export interface StandaloneSinkTarget {
  name: string;
}

export interface StandaloneSinkCoverage {
  sinkLoss: readonly StandaloneSinkTarget[];
  unmeasurable: readonly StandaloneSinkTarget[];
}

/** ms → "3h 12m" / "12m" / "45s" 사람용 짧은 경과 표기. */
export function humanizeMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function line(j: JobHealth, kind: 'stale' | 'error'): string {
  if (kind === 'stale') {
    const last = j.lastRun ? `마지막 ${formatDateTime(j.lastRun)}` : '실행 기록 없음';
    return ` · ${j.name} (${j.cron}) — ${humanizeMs(j.overdueMs)} 지남, ${last}`;
  }
  return ` · ${j.name} (${j.cron}) — 마지막 실행 실패`;
}

function sinkCoverageOf(opts: { sinkCoverage?: StandaloneSinkCoverage }): {
  sinkLoss: readonly StandaloneSinkTarget[];
  unmeasurable: readonly StandaloneSinkTarget[];
} {
  return {
    sinkLoss: opts.sinkCoverage?.sinkLoss ?? [],
    unmeasurable: opts.sinkCoverage?.unmeasurable ?? [],
  };
}

/** 헬스 → 텔레그램 본문. alert 모드는 문제 없으면 null(무음). */
export function formatHealthReport(
  h: ScheduleHealth,
  opts: { mode: 'digest' | 'alert'; nowLabel: string; sinkCoverage?: StandaloneSinkCoverage },
): string | null {
  const { sinkLoss, unmeasurable: sinkUnmeasurable } = sinkCoverageOf(opts);
  const hasScheduleProblem = h.stale.length > 0 || h.errored.length > 0 || h.noncanonical.length > 0 || h.unmeasured.length > 0;
  const hasSinkProblem = sinkLoss.length > 0 || sinkUnmeasurable.length > 0;
  if (opts.mode === 'alert' && !hasScheduleProblem && !hasSinkProblem) return null;

  const head = `🔧 스케줄 헬스 · ${opts.nowLabel}`;
  const summary = `대상 ${h.elanousTotal} · 밀림 ${h.stale.length} · 실패 ${h.errored.length} · 비정규 ${h.noncanonical.length} · 측정 불가 ${h.unmeasured.length}`;
  const parts = [head, summary];

  if (h.stale.length > 0) {
    parts.push('', '⏰ 밀린 잡(유실 의심):');
    for (const j of h.stale.slice(0, 15)) parts.push(line(j, 'stale'));
    if (h.stale.length > 15) parts.push(` · … 외 ${h.stale.length - 15}`);
  }
  if (h.errored.length > 0) {
    parts.push('', '❌ 실패한 잡:');
    for (const j of h.errored.slice(0, 15)) parts.push(line(j, 'error'));
    if (h.errored.length > 15) parts.push(` · … 외 ${h.errored.length - 15}`);
  }
  if (h.noncanonical.length > 0) {
    parts.push('', '⚠️ 비정규 크론 줄(안전 정규형 불일치):');
    for (const j of h.noncanonical.slice(0, 15)) parts.push(` · ${j.name} (${j.cron}) — 등록 줄 점검 필요`);
    if (h.noncanonical.length > 15) parts.push(` · … 외 ${h.noncanonical.length - 15}`);
  }
  if (h.unmeasured.length > 0) {
    parts.push('', '❔ 정규형 측정 불가(repo 또는 bun 입력 없음):');
    for (const j of h.unmeasured.slice(0, 15)) parts.push(` · ${j.name} (${j.cron}) — 안전 여부 미판정`);
    if (h.unmeasured.length > 15) parts.push(` · … 외 ${h.unmeasured.length - 15}`);
  }
  if (hasSinkProblem) {
    parts.push('', `📡 독립 싱크 커버리지 · 싱크 유실 ${sinkLoss.length} · 싱크 측정 불가 ${sinkUnmeasurable.length}`);
  }
  if (sinkLoss.length > 0) {
    parts.push('', '📭 관측을 잃는 크론 잡(logs.db 미도달):');
    for (const t of sinkLoss.slice(0, 15)) parts.push(` · ${t.name}`);
    if (sinkLoss.length > 15) parts.push(` · … 외 ${sinkLoss.length - 15}`);
  }
  if (sinkUnmeasurable.length > 0) {
    parts.push('', '❔ 독립 싱크 측정 불가:');
    for (const t of sinkUnmeasurable.slice(0, 15)) parts.push(` · ${t.name}`);
    if (sinkUnmeasurable.length > 15) parts.push(` · … 외 ${sinkUnmeasurable.length - 15}`);
  }
  if (opts.mode === 'digest' && !hasScheduleProblem) {
    parts.push('', '✅ 밀림·실패·비정규 없음 — 전 잡 정상 발화');
  }
  return parts.join('\n');
}
