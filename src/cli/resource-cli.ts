import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { TRAFFIC_SEATS, type TrafficResult } from '../loops/orchestrator/traffic.js';
import { observeLoopResources } from '../nexus/api/loop-resources.js';
import { writeStdoutJson } from './stdout-json.js';

/** 칸 제목은 여러 줄(«대상 경로:»·«신설:» …)이다 — 표의 한 칸에는 첫 줄만, 상한을 넘으면 «…» 로 자른 것을 표시한다. */
export const RESOURCE_TITLE_MAX_CHARS = 60;
export function oneLineTitle(title: string): string {
  const first = (title.split(/\r?\n/).find((line) => line.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return first.length > RESOURCE_TITLE_MAX_CHARS ? `${first.slice(0, RESOURCE_TITLE_MAX_CHARS - 1)}…` : first;
}

/** Read-only CLI view of the same traffic snapshot returned by the Nexus resource GET. */
export function registerResourceCommands(program: Command, observe: () => TrafficResult = observeLoopResources): void {
  program.command('resource').description('자리별 루프 자원 관측 (읽기 전용)')
    .command('status').description('자리별 공급·다음 칸·임대 상태')
    .option('--json', '관측 스냅샷 JSON 출력')
    .action(async (opts: { json?: boolean }) => {
      let resource: TrafficResult;
      try { resource = observe(); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        debug.log('resource.loop', 'status-read', { readStatus: 'unreadable', seats: null, cells: null });
        process.exitCode = 1;
        if (opts.json) await writeStdoutJson(JSON.stringify({ readStatus: 'unreadable', reason }) + '\n');
        else console.error(`resource status: 못 읽음 — ${reason}`);
        return;
      }
      debug.log('resource.loop', 'status-read', {
        readStatus: 'ok', seats: resource.seats.length,
        cells: resource.seats.filter(row => row.nextCell !== null).length,
      });
      if (opts.json) {
        await writeStdoutJson(JSON.stringify({ resource, readStatus: 'ok' }) + '\n');
        return;
      }
      console.log('자리\t쓰는 자리/공급\t다음 칸\t임대(빌림/빌려줌)\t대기 이유');
      for (const seat of TRAFFIC_SEATS) {
        const row = resource.seats.find(item => item.seat === seat);
        if (!row) { console.log(`${seat}\t못 읽음\t못 읽음\t못 읽음\t자리 관측 없음`); continue; }
        const cell = row.nextCell;
        const reason = !cell ? '다음 칸 없음' : row.launchCap <= row.running ? '발사 자리 없음' : '다음 칸 대기';
        console.log(`${seat}\t${row.running}/${row.cap}\t${cell ? `1 · ${cell.id} ${oneLineTitle(cell.title)}` : '0'}\t${row.borrowed}/${row.lent}\t${reason}`);
      }
      if (resource.unassigned > 0) console.log(`미배정\t${resource.unassigned}`);
    });
}
