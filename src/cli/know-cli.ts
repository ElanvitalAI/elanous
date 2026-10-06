import type { Command } from 'commander';
import { knowFind, type KnowFindDeps } from '../knowledge/know-find.js';
import { writeStdoutJson } from './stdout-json.js';

export function registerKnowCommand(program: Command, deps: Partial<KnowFindDeps> = {}, out: Pick<Console, 'log' | 'error'> = console): void {
  program.command('know <words...>').description('대표 지시 · 결정 · 판 칸 · 교훈을 한 질문으로 검색')
    .option('--json', 'JSON 출력').option('--limit <N>', '최대 결과 수', '20')
    .action(async (words: string[], opts: { json?: boolean; limit: string }) => {
      const limit = Number(opts.limit);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      const result = knowFind(words.join(' '), deps);
      const rows = result.rows.slice(0, limit);
      if (opts.json) {
        await writeStdoutJson(JSON.stringify({ rows, unavailable: result.unavailable }) + '\n');
        return;
      }
      for (const row of rows) out.log(`[${row.source}] ${row.id} · ${row.title} · ${row.status}${row.current ? ' · (지금 유효)' : ''}`);
      for (const item of result.unavailable) out.error(`[${item.source}] 못 읽음 · ${item.reason}`);
    });
}
