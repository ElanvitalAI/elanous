import type { Command } from 'commander';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { hqCliWriteAllowed, type HqDeps } from '../hq/hq.js';
import { isIsolatedLedgerWriteRoot } from '../hq/ledger-write-target.js';
import { closeSeatRequests, listSeatRequests, type SeatRequestStatus } from '../seat-dispatch/seat-request-ledger.js';

function duration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`invalid --older-than: ${value} (use e.g. 24h)`);
  const ms = Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]! as 'ms' | 's' | 'm' | 'h' | 'd']);
  if (!Number.isSafeInteger(ms)) throw new Error(`invalid --older-than: ${value}`);
  return ms;
}

export function registerSeatRequestsCommands(seat: Command, deps: { root?: () => string; hq?: HqDeps; now?: () => Date } = {}): void {
  const requests = seat.command('requests').description('자리 요청 원장 조회·닫기');
  requests.command('list').description('키별 최신 요청 상태 조회')
    .option('--seat <seat>', '자리 ID')
    .option('--status <status>', 'pending|queued|rejected|done')
    .option('--json', 'JSON 출력')
    .action((opts: { seat?: string; status?: string; json?: boolean }) => {
      try {
        if (opts.status && !['pending', 'queued', 'rejected', 'done'].includes(opts.status)) throw new Error(`invalid status: ${opts.status}`);
        const rows = listSeatRequests((deps.root ?? effectiveInstanceRoot)(), { seat: opts.seat, status: opts.status as SeatRequestStatus | undefined });
        if (opts.json) console.log(JSON.stringify(rows));
        else for (const row of rows) console.log(`${row.key} ${row.seat} ${row.status} ${row.queuedAt} ${row.text}`);
      } catch (error) { console.error(`seat requests list: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });
  requests.command('close <keys...>').description('열린 요청을 사유와 함께 종료 (원장에 덧붙임)')
    .requiredOption('--reason <reason>', '닫는 이유')
    .option('--status <status>', 'rejected|done', 'rejected')
    .option('--older-than <duration>', '최소 대기 시간 (예: 24h)')
    .option('--dry-run', '쓰기 없이 대상만 미리 보기')
    .action((keys: string[], opts: { reason: string; status: string; olderThan?: string; dryRun?: boolean }) => {
      try {
        if (!opts.reason.trim()) throw new Error('reason must not be empty');
        if (opts.status !== 'rejected' && opts.status !== 'done') throw new Error(`invalid close status: ${opts.status}`);
        const olderThan = opts.olderThan === undefined ? undefined : duration(opts.olderThan);
        const root = (deps.root ?? effectiveInstanceRoot)();
        const known = new Set(listSeatRequests(root).map((row) => row.key));
        const missing = keys.find((key) => !known.has(key));
        if (missing) throw new Error(`unknown key: ${missing}`);
        if (!opts.dryRun && !isIsolatedLedgerWriteRoot(root) && !hqCliWriteAllowed('seat requests close', false, deps.hq)) return;
        const rows = closeSeatRequests(root, keys, {
          reason: opts.reason, status: opts.status,
          ...(olderThan === undefined ? {} : { olderThan }),
          ...(deps.now ? { now: deps.now() } : {}), dryRun: opts.dryRun,
        });
        for (const row of rows) console.log(`${opts.dryRun ? 'would close' : 'closed'} ${row.key} ${row.status}: ${row.reason}`);
      } catch (error) { console.error(`seat requests close: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });
}
