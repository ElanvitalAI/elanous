import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { addSource, canonicalSeat, dueSources, expiredSource, listSources, removeSource, runDue, type RunDueDeps, type SourceKind } from '../intake-plane/intake-sources.js';
import { projectTopicBriefing, subscribeTopicSearch, type SubscribeTopicSearchInput } from '../intake-plane/actions.js';
import { runIntakeIssueBriefing } from '../intake-plane/actions.js';

export function registerIntakeSourceCommands(intake: Command, root: () => string = effectiveInstanceRoot,
  deps: { subscribeTopicSearch?: (input: SubscribeTopicSearchInput, options?: { stateDir?: string; runDeps?: RunDueDeps }) => ReturnType<typeof subscribeTopicSearch> } = {}): void {
  const source = intake.command('source').description('자리별 흡수 원천과 주기 등록·조회·실행');
  const fail = (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; };
  source.command('add')
    .requiredOption('--seat <id>', '자리 id 또는 별칭')
    .requiredOption('--kind <kind>', 'github-query | rss | command | topic-search')
    .requiredOption('--spec <spec>', 'GitHub 질의 · 피드 URL · 명령')
    .requiredOption('--every <cadence>', 'Nh | Nd | Nw')
    .option('--until <date>', '만료 시작 날짜 YYYY-MM-DD (UTC)')
    .option('--why <reason>', '등록 이유')
    .option('--id <id>', '원천 id')
    .option('--linear-issue-id <uuid>', 'topic-search parent Linear issue UUID')
    .option('--schedule-cron <expression>', 'topic-search schedule registry cron (e.g. 0 8 * * 1)')
    .option('--telegram-dry-run-file <path>', 'Telegram 브리핑 본문을 이 파일에 기록하고 실제 발송은 하지 않음 (topic-search)')
    .action(async (opts: { seat: string; kind: string; spec: string; every: string; until?: string; why?: string; id?: string; linearIssueId?: string; scheduleCron?: string; telegramDryRunFile?: string }) => {
      try {
        if (opts.kind === 'topic-search') {
          if (!opts.linearIssueId || !opts.scheduleCron) throw new Error('topic-search 는 --linear-issue-id 와 --schedule-cron 이 필요하다');
          const telegramDryRunFile = opts.telegramDryRunFile ? resolve(opts.telegramDryRunFile) : undefined;
          const result = await (deps.subscribeTopicSearch ?? subscribeTopicSearch)({ seat: opts.seat, topic: opts.spec,
            linearIssueId: opts.linearIssueId, every: opts.every, scheduleCron: opts.scheduleCron,
            ...(telegramDryRunFile ? { telegramDryRunFile } : {}) },
          { stateDir: root(), runDeps: { projectTopicBriefing: telegramDryRunFile
            ? (registered, items, stateDir) => projectTopicBriefing(registered, items, stateDir, { telegramDryRunFile })
            : projectTopicBriefing } });
          console.log(`${result.source.id}  ${result.source.seat}  topic-search  ${result.source.every}  schedule=${result.scheduleId}  immediate=${result.immediate.ran.map(row => row.items).join(',')}`);
          return;
        }
        const added = addSource({ id: opts.id ?? `src-${randomUUID().slice(0, 8)}`, seat: opts.seat, kind: opts.kind as SourceKind,
          spec: opts.spec, every: opts.every, ...(opts.until ? { until: opts.until } : {}), ...(opts.why ? { why: opts.why } : {}),
          ...(opts.linearIssueId ? { linearIssueId: opts.linearIssueId } : {}),
          ...(opts.scheduleCron ? { scheduleCron: opts.scheduleCron } : {}) }, root());
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
    .option('--source-id <id>', '단일 입력원만 실행 (스케줄 레지스트리 호출용)')
    .option('--project-issue-briefing', 'topic-search 결과를 관련 Linear 이슈의 Telegram·코멘트에 투영')
    .option('--telegram-dry-run-file <path>', 'Telegram 브리핑 본문을 이 파일에 기록하고 실제 발송은 하지 않음')
    .option('--dry-run', '기한 원천 목록만 · 수집·원장·마지막 실행 시각 무변')
    .option('--json', 'JSON 출력')
    .action(async (opts: { seat?: string; sourceId?: string; projectIssueBriefing?: boolean; telegramDryRunFile?: string; dryRun?: boolean; json?: boolean }) => {
      try {
        const seat = opts.seat === undefined ? undefined : canonicalSeat(opts.seat);
        if (opts.dryRun) {
          const sources = dueSources(new Date(), root(), opts.sourceId).filter((entry) => seat === undefined || entry.seat === seat);
          if (opts.json) console.log(JSON.stringify(sources));
          else for (const entry of sources) console.log(`${entry.id}  ${entry.seat}  ${entry.kind}  ${entry.every}`);
          return;
        }
        const telegramDryRunFile = opts.telegramDryRunFile ? resolve(opts.telegramDryRunFile) : undefined;
        const result = await runDue({ seat, sourceId: opts.sourceId, deps: { stateDir: root(),
          ...(opts.projectIssueBriefing || telegramDryRunFile ? { projectTopicBriefing: telegramDryRunFile
            ? (registered, items, stateDir) => projectTopicBriefing(registered, items, stateDir, { telegramDryRunFile })
            : projectTopicBriefing } : {}),
          onCollected: async (source, raws) => {
          if (!source.issueRef) return;
          await runIntakeIssueBriefing({
            issueRef: source.issueRef, topic: source.spec, state: 'open', collected: true,
            evidence: raws.filter(raw => typeof raw.url === 'string' && raw.url.trim().length > 0)
              .map(raw => ({ title: raw.title || source.spec, url: raw.url!, summary: raw.text || raw.title || source.spec })),
          }, { stateDir: root() });
        } } });
        if (opts.json) console.log(JSON.stringify(result));
        else for (const row of result.ran) console.log(`${row.id}  ${row.items}${row.error ? `  실패: ${row.error}` : ''}`);
        if (result.ran.some((row) => row.error)) process.exitCode = 1;
      } catch (error) { fail(error); }
    });
}
