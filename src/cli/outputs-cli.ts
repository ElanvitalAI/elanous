import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { OutputEntry } from '../outputs/ledger.js';
import { writeStdoutJson } from './stdout-json.js';

type ListOptions = { since?: string; source?: string; limit?: string; json?: boolean };

function sinceIso(value: string): string {
  if (value === '24h' || value === '7d') {
    return new Date(Date.now() - (value === '24h' ? 24 : 7 * 24) * 60 * 60 * 1000).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`invalid --since: ${value} (ISO|24h|7d)`);
  }
  return new Date(value).toISOString();
}

// listOutputs intentionally tolerates unreadable months. Detect inaccessible ledger files here so the CLI
// does not report an incomplete read as a genuine zero (including when run as root under chmod 000).
function assertReadableLedger(root: string): void {
  const dir = join(root, 'outputs');
  let names: string[];
  try {
    const info = statSync(dir);
    if (!info.isDirectory() || (info.mode & 0o444) === 0 || (info.mode & 0o111) === 0) {
      throw new Error(`outputs ledger directory unreadable: ${dir}`);
    }
    accessSync(dir, constants.R_OK | constants.X_OK);
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names.filter(name => /^outputs-\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(name) || name === 'outputs.jsonl')) {
    const file = join(dir, name);
    const info = statSync(file);
    if (!info.isFile() || (info.mode & 0o444) === 0) throw new Error(`outputs ledger file unreadable: ${file}`);
    accessSync(file, constants.R_OK);
  }
}

export function registerOutputsCommands(program: Command): void {
  program.command('outputs').description('산출물 원장 조회 (읽기 전용)')
    .command('list').description('산출물 최신순 목록과 종류별 수')
    .option('--since <ISO|24h|7d>', '이 시각 이후')
    .option('--source <source>', 'exec|field-reel|field-feed')
    .option('--limit <N>', '최대 건수 (기본 50)', '50')
    .option('--json', 'JSON 출력')
    .action(async (options: ListOptions) => {
      try {
        if (options.source !== undefined && !['exec', 'field-reel', 'field-feed'].includes(options.source)) {
          throw new Error(`invalid --source: ${options.source} (exec|field-reel|field-feed)`);
        }
        if (!options.limit || !/^[1-9]\d*$/.test(options.limit) || !Number.isSafeInteger(Number(options.limit))) {
          throw new Error(`invalid --limit: ${options.limit}`);
        }
        const scope = {
          since: options.since === undefined ? undefined : sinceIso(options.since),
          source: options.source as OutputEntry['source'] | undefined,
          limit: Number(options.limit),
        };
        const displayedScope = { since: scope.since ?? null, source: scope.source ?? null, limit: scope.limit };
        const root = effectiveInstanceRoot();
        assertReadableLedger(root);
        const { listOutputs } = await import('../outputs/ledger.js');
        const items = listOutputs(scope, root);
        const byKind: Record<string, number> = {};
        for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
        debug.log('outputs.cli', 'list', { count: items.length, source: scope.source, since: scope.since });
        if (options.json) {
          await writeStdoutJson(`${JSON.stringify({ items, count: items.length, byKind, scope: displayedScope })}\n`);
          return;
        }
        for (const item of items) {
          const at = Number.isFinite(Date.parse(item.at))
            ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(item.at))
            : item.at;
          console.log(`${at} KST · ${item.kind} · ${item.title} · ${item.source}/${item.sourceId} · ${item.seat ?? '—'} · ${item.path ?? item.url ?? '—'}`);
        }
        if (!items.length) console.log(`scope: ${JSON.stringify(displayedScope)}`);
        console.log(`${items.length}개 · 종류별 수 ${JSON.stringify(byKind)}`);
      } catch (error) {
        console.error(`outputs list: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
