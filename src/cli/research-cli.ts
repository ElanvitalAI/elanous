import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { isLiveDetailOn } from '../live/detail-switch.js';
import { dispatchOmniSearch } from '../skills/tools/omni-search.js';
import { getAvailableWebSearchProviders } from '../web-search/index.js';

export interface ResearchCliDeps {
  readonly out?: { log: (line: string) => void; error: (line: string) => void };
  readonly search?: typeof dispatchOmniSearch;
  readonly availableEngines?: () => string[];
  readonly maxDetailOn?: (runId?: string) => boolean;
  readonly log?: typeof debug.log;
}

export function registerResearchCommand(program: Command, deps: ResearchCliDeps = {}): void {
  const out = deps.out ?? console;
  program.command('research <query...>')
    .description('여러 웹 검색 엔진으로 조사 (사용 가능한 provider 를 병렬 검색)')
    .option('--engines <ids>', '검색 엔진 ID (쉼표로 구분; 기본: 사용 가능한 전체)')
    .option('--limit <count>', '엔진당 결과 수 (1~20)', '5')
    .option('--json', '결과와 엔진별 메타데이터를 JSON 으로 출력')
    .action(async (parts: string[], opts: { engines?: string; limit: string; json?: boolean }) => {
      const query = parts.join(' ').trim();
      const limit = Number(opts.limit);
      const engines = opts.engines?.split(',').map(id => id.trim()).filter(Boolean);
      const available = (deps.availableEngines ?? (() => getAvailableWebSearchProviders().map(p => p.id)))();
      const unknown = engines?.filter(id => !available.some(p => p.toLowerCase() === id.toLowerCase())) ?? [];
      if (!query || !Number.isInteger(limit) || limit < 1 || limit > 20 || (opts.engines !== undefined && !engines?.length) || unknown.length) {
        out.error(unknown.length ? `research: 사용할 수 없는 엔진: ${unknown.join(', ')} (사용 가능: ${available.join(', ') || '없음'})`
          : 'research: 질의와 --limit (1~20), --engines (쉼표로 구분한 사용 가능한 ID)를 확인하세요.');
        process.exitCode = 2;
        return;
      }

      const log = deps.log ?? ((category: string, event: string, data?: unknown) => debug.log(category, event, data));
      const maxDetailOn = deps.maxDetailOn ?? isLiveDetailOn;
      const runId = process.env.ELANOUS_RUN_ID?.trim() || undefined;
      const started = Date.now();
      const wanted = engines?.length ? available.filter(id => engines.some(e => e.toLowerCase() === id.toLowerCase())) : available;
      const seenSources = new Set<string>();
      if (!wanted.length) log('research.query', 'query', { query, engines: [], limit });
      for (const engine of wanted) log('research.query', 'query', { query, engine, limit });
      try {
        const result = await (deps.search ?? dispatchOmniSearch)({ query, ...(engines?.length ? { engines } : {}), limit }, {
          onEngine: event => {
            if (event.phase === 'complete') log('research.result', 'result', { query, engine: event.engine, hits: event.hits, durationMs: event.durationMs, ...(event.error ? { error: event.error } : {}) });
          },
          onSource: source => {
            if (maxDetailOn(runId)) {
              const dedup = seenSources.has(source.url);
              seenSources.add(source.url);
              log('research.source', 'source', { url: source.url, title: source.title, engine: source.engine, dedup });
            }
          },
        });
        // An empty registry has no per-engine completion callback; preserve a summary observation.
        if (!Object.keys(result.metadata.perEngine).length) log('research.result', 'result', { query, engines: [], hits: 0, durationMs: Date.now() - started });
        out.log(opts.json ? JSON.stringify({ query, ...result }) : result.output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('research.result', 'result', { query, hits: 0, durationMs: Date.now() - started, error: message });
        out.error(`research: ${message}`);
        process.exitCode = 1;
      }
    });
}
