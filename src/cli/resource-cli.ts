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
  const resource = program.command('resource').description('자리별 루프 자원 관측 · 매시 자원 최적화 표(RESOURCE-OPT-HOURLY)');
  registerResourceOptCommands(resource);
  resource.command('status').description('자리별 공급·다음 칸·임대 상태')
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

/**
 * RESOURCE-OPT-HOURLY (L1) · RELEASE-GOAL-FROM-LEDGER (L4).
 *   resource optimize            — print the matching table the OP TUI turns into its hourly assignment turn (no LLM)
 *   resource optimize --now      — on demand: the running OP TUI opens the assignment turn now (trigger file)
 *   resource optimize --last     — the last closed table: idle · unowned · assigned · rejected · unhandled
 *   resource goal-line           — the current release goal line (plan/schedule ledgers) for shell ticks
 */
export function registerResourceOptCommands(resource: Command): void {
  resource.command('optimize').description('Hourly matching table: idle seats × unowned/2h-stalled cells · PRs without same-head pregate · judge queue')
    .option('--now', 'ask the running OP TUI to open the assignment turn now')
    .option('--exceptions <tableJson>', 'LOOP-TRAFFIC R1: open the assignment turn for only these rows (a table JSON from --json, rows = the ones R1 could not assign)')
    .option('--last', 'show the last closed table record')
    .option('--seat <seat>', 'the HQ coordinator seat', 'OP')
    .option('--json', 'JSON')
    .action(async (opts: { now?: boolean; exceptions?: string; last?: boolean; seat: string; json?: boolean }) => {
      const gate = await import('../resource-opt/assignment-gate.js');
      if (opts.last) {
        const record = gate.readResourceOptRecord(gate.resourceOptDir());
        if (opts.json) { await writeStdoutJson(`${JSON.stringify(record)}\n`); return; }
        console.log(gate.resourceOptBoardLine(record) ?? 'resource optimize: no table closed yet');
        return;
      }
      if (opts.now || opts.exceptions) {
        const { writeResourceOptTrigger } = await import('../resource-opt/gather.js');
        let table: import('../resource-opt/matching-table.js').MatchingTable | undefined;
        if (opts.exceptions) {
          const { readFileSync } = await import('node:fs');
          try { table = JSON.parse(readFileSync(opts.exceptions, 'utf8')) as typeof table; }
          catch (error) { console.error(`resource optimize --exceptions: unreadable table (${String(error).slice(0, 120)})`); process.exitCode = 1; return; }
          if (!table || !Array.isArray(table.rows) || !table.summary) { console.error('resource optimize --exceptions: not a matching table'); process.exitCode = 1; return; }
        }
        const path = writeResourceOptTrigger(gate.resourceOptDir(), process.env.ELANOUS_TRACK || 'cli', table);
        debug.log('resource', 'optimize-trigger', { path });
        console.log(`Asked the OP TUI to open the assignment turn now (${path}).`);
        return;
      }
      const { gatherMatchingTable } = await import('../resource-opt/gather.js');
      const { formatAssignmentPrompt } = await import('../resource-opt/matching-table.js');
      const table = await gatherMatchingTable({ seat: opts.seat.toUpperCase() });
      if (!table) { console.error(`resource optimize: ${opts.seat} is not the HQ coordinator seat in the els listing`); process.exitCode = 1; return; }
      if (opts.json) { await writeStdoutJson(`${JSON.stringify(table)}\n`); return; }
      console.log(formatAssignmentPrompt(table));
    });
  resource.command('goal-line').description('The current release goal line from the ledgers (PLAN status: current → schedule → package)')
    .option('--json', 'JSON')
    .action(async (opts: { json?: boolean }) => {
      const { deriveReleaseGoal, releaseGoalLine } = await import('../ops-dashboard/release-goal.js');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const goal = deriveReleaseGoal({ hqRoot: join(homedir(), 'elanous-hq') });
      if (opts.json) { await writeStdoutJson(`${JSON.stringify({ ...goal, line: releaseGoalLine(goal, Date.now()) })}\n`); return; }
      console.log(releaseGoalLine(goal, Date.now()));
    });
}
