import type { Command } from 'commander';
import { parseSince } from '../cli/logs-cli.js';
import {
  SUPERVISOR_METRICS_DEFAULT_SINCE,
  formatSupervisorMetrics,
  loadSupervisorMetrics,
  type ReadSupervisorLogs,
} from './supervisor-metrics.js';

export interface SupervisorMetricsCliDeps {
  readonly read?: ReadSupervisorLogs;
  readonly write?: (text: string) => void;
  readonly nowMs?: number;
}

export function registerSupervisorMetricsCommand(parent: Command, deps: SupervisorMetricsCliDeps = {}): Command {
  return parent.command('metrics')
    .description('외부 에이전트 미션 슈퍼바이저 품질 지표 — 이미 남은 미션 기록만 읽는다')
    .option('--since <window>', '조회 창 (30s/15m/2h/7d · 기본 7d)', SUPERVISOR_METRICS_DEFAULT_SINCE)
    .option('--json', 'JSON 출력')
    .action((opts: { since?: string; json?: boolean }) => {
      const since = opts.since?.trim() || SUPERVISOR_METRICS_DEFAULT_SINCE;
      const nowMs = deps.nowMs ?? Date.now();
      const relative = /^(\d+)(s|m|h|d)$/.exec(since);
      const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
      // parseSince returns an absolute epoch (including for relative inputs); anchor relative windows to this invocation's clock.
      const sinceMs = relative
        ? nowMs - Number(relative[1]) * unitMs[relative[2] as keyof typeof unitMs]
        : parseSince(since);
      const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
      if (sinceMs === null || !Number.isFinite(sinceMs)) {
        write(`--since 를 읽지 못함: ${since}\n`);
        process.exitCode = 2;
        return;
      }
      const report = loadSupervisorMetrics(since, sinceMs, nowMs, deps.read);
      if (opts.json) write(`${JSON.stringify(report)}\n`);
      else write(`${formatSupervisorMetrics(report)}\n`);
    });
}
