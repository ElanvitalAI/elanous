#!/usr/bin/env bun
// ── 스케줄 헬스 텔레그램 리포트 (P3) ──────────────────────────────────
// 대표 지시: "실제 실행이 제대로 모니터링 되도록." schedule_registry 의 실행
// 결과(P1)를 판정(P2 scheduleHealth)해 텔레그램으로 발송.
//   --digest : 매일 아침 요약(밀림 없어도 "정상 N개" 발송)
//   --alert  : 문제(밀림/실패) 있을 때만 발송(없으면 무음)
// cron 예: 0 8 * * * (digest) · 0 9-20 * * 1-5 (alert · 장중 시간별).

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { openSchedulesDb, listSchedules, inventoryCrontab, repoRoot, scheduleHealth, unwrapCronCommand, type ScheduleRow } from '../src/domains/schedule-registry.js';
import { formatHealthReport, type StandaloneSinkCoverage } from '../src/domains/schedule-health-report.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
// 크론 최소 PATH 엔 node/npx 없음 → 하위 조회 실패 방지(capstone-alert 교훈).
import { ensureCronNodePath } from '../src/domains/cron-path.js';

/** 크론 명령에서 대상 스크립트 경로를 뽑는다. 래퍼(`cron-run.ts`)는 벗기고 안쪽 대상을 본다. */
export function cronTargetPath(command: string | null | undefined): string | null {
  const inner = unwrapCronCommand(command ?? '');
  const match = inner.match(/(?:^|[\s'"`])((?:\/|\.\.?\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|bash|zsh))\b/);
  return match?.[1] ?? null;
}

function resolveTarget(target: string, repo: string): string {
  return isAbsolute(target) ? target : join(repo, target);
}

/**
 * 이미 읽은 스케줄 목록에서 잡마다 대상 파일을 읽어 독립 싱크 등록 여부를 잰다.
 * `.ts` 이고 `registerStandaloneLogSink` 호출이 있으면 닿는 것(목록에서 뺀다).
 * 호출이 없으면 sinkLoss. 파일이 없거나 `.ts` 가 아니면 unmeasurable.
 * 잡 목록은 인자로만 받는다 — 파일에 박지 않는다.
 */
export function measureStandaloneSinkCoverage(
  rows: readonly Pick<ScheduleRow, 'name' | 'command'>[],
  opts: { repo?: string; readFile?: (path: string) => string | null } = {},
): StandaloneSinkCoverage {
  const repo = opts.repo ?? repoRoot();
  const readFile = opts.readFile ?? ((path: string) => {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  });
  const sinkLoss: { name: string }[] = [];
  const unmeasurable: { name: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.name || seen.has(row.name)) continue;
    seen.add(row.name);
    const target = cronTargetPath(row.command);
    if (!target || !target.endsWith('.ts')) {
      unmeasurable.push({ name: row.name });
      continue;
    }
    const body = readFile(resolveTarget(target, repo));
    if (body == null) {
      unmeasurable.push({ name: row.name });
      continue;
    }
    if (!/\bregisterStandaloneLogSink\s*\(/.test(body)) sinkLoss.push({ name: row.name });
  }
  return { sinkLoss, unmeasurable };
}

/** 잰 커버리지를 포맷에 넘긴 보고서 본문. 문제 없으면 null(alert 무음). */
export function renderScheduleHealthReport(
  health: Parameters<typeof formatHealthReport>[0],
  opts: { mode: 'digest' | 'alert'; nowLabel: string; sinkCoverage: StandaloneSinkCoverage },
): string | null {
  return formatHealthReport(health, { mode: opts.mode, nowLabel: opts.nowLabel, sinkCoverage: opts.sinkCoverage });
}

function main(): void {
  ensureCronNodePath();
  const mode: 'digest' | 'alert' = process.argv.includes('--digest') ? 'digest' : 'alert';
  const dryRun = process.argv.includes('--dry-run');
  const db = openSchedulesDb();
  try {
    inventoryCrontab(db); // 최신 crontab 반영(레지스트리 정합)
    const rows = listSchedules(db);
    const health = scheduleHealth(rows, { repo: repoRoot(), bun: process.execPath });
    const sinkCoverage = measureStandaloneSinkCoverage(rows);
    const nowLabel = new Date().toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const msg = renderScheduleHealthReport(health, { mode, nowLabel, sinkCoverage });
    if (!msg) {
      console.log(`[schedule-health] ${mode}: 문제 없음 — 무음 (대상 ${health.elanousTotal})`);
      return;
    }
    if (dryRun) {
      console.log(msg);
      return;
    }
    const ok = sendOutbound(msg, 'ops-alert');
    console.log(`[schedule-health] ${mode}: ${ok ? '발송' : '발송 실패'} — 밀림 ${health.stale.length}·실패 ${health.errored.length}`);
  } finally {
    db.close();
  }
}

if (import.meta.main) main();
