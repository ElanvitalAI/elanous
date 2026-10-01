import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { addSource, canonicalSeat, dueSources, expiredSource, listSources, removeSource, runDue, type SourceKind } from '../intake-plane/intake-sources.js';

export function registerIntakeSourceCommands(intake: Command, root: () => string = effectiveInstanceRoot): void {
  const source = intake.command('source').description('자리별 흡수 원천과 주기 등록·조회·실행');
  const fail = (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; };
  source.command('add')
    .requiredOption('--seat <id>', '자리 id 또는 별칭')
    .requiredOption('--kind <kind>', 'github-query | rss | command')
    .requiredOption('--spec <spec>', 'GitHub 질의 · 피드 URL · 명령')
    .requiredOption('--every <cadence>', 'Nh | Nd | Nw')
    .option('--until <date>', '만료 시작 날짜 YYYY-MM-DD (UTC)')
    .option('--why <reason>', '등록 이유')
    .option('--id <id>', '원천 id')
    .action((opts: { seat: string; kind: string; spec: string; every: string; until?: string; why?: string; id?: string }) => {
      try {
        const added = addSource({ id: opts.id ?? `src-${randomUUID().slice(0, 8)}`, seat: opts.seat, kind: opts.kind as SourceKind,
          spec: opts.spec, every: opts.every, ...(opts.until ? { until: opts.until } : {}), ...(opts.why ? { why: opts.why } : {}) }, root());
        console.log(`${added.id}  ${added.seat}  ${added.kind}  ${added.every}`);
      } catch (error) { fail(error); }
    });
  source.command('list')
    .option('--seat <id>', '자리 id 또는 별칭')
    .option('--json', 'JSON 출력')
    .action((opts: { seat?: string; json?: boolean }) => {
      try {
        const now = new Date();
        const sources = listSources({ seat: opts.seat }, root()).map((entry) => ({ ...entry, expired: expiredSource(entry, now) }));
        if (opts.json) console.log(JSON.stringify(sources));
        else for (const entry of sources) console.log(`${entry.id}  ${entry.seat}  ${entry.kind}  ${entry.every}  ${entry.expired ? '만료' : '활성'}  ${entry.spec}`);
      } catch (error) { fail(error); }
    });
  source.command('remove <id>').action((id: string) => {
    try { if (!removeSource(id, root())) { console.error(`원천 id 없음: ${id}`); process.exitCode = 2; return; } console.log(`removed ${id}`); }
    catch (error) { fail(error); }
  });
  source.command('run-due')
    .option('--seat <id>', '자리 id 또는 별칭')
    .option('--dry-run', '기한 원천 목록만 · 수집·원장·마지막 실행 시각 무변')
    .option('--json', 'JSON 출력')
    .action(async (opts: { seat?: string; dryRun?: boolean; json?: boolean }) => {
      try {
        const seat = opts.seat === undefined ? undefined : canonicalSeat(opts.seat);
        if (opts.dryRun) {
          const sources = dueSources(new Date(), root()).filter((entry) => seat === undefined || entry.seat === seat);
          if (opts.json) console.log(JSON.stringify(sources));
          else for (const entry of sources) console.log(`${entry.id}  ${entry.seat}  ${entry.kind}  ${entry.every}`);
          return;
        }
        const result = await runDue({ seat, deps: { stateDir: root() } });
        if (opts.json) console.log(JSON.stringify(result));
        else for (const row of result.ran) console.log(`${row.id}  ${row.items}${row.error ? `  실패: ${row.error}` : ''}`);
        if (result.ran.some((row) => row.error)) process.exitCode = 1;
      } catch (error) { fail(error); }
    });
}
