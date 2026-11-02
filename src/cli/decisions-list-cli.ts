import type { Command } from 'commander';
import { dirname, join } from 'node:path';
import { DecisionLedger, type DecisionCategory, type DecisionLedgerOptions } from '../decisions/decision-ledger.js';
import { readQueryCache } from '../storage/short-lived-read-cache.js';
import { writeStdoutFully } from './stdout-flush.js';
import { formatDecisionRow } from './decision-list-format.js';
import { decisionListSince, filterDecisionListSince } from './decision-list-since.js';

/** Read-only list registration kept outside the consensus, Linear, and write command graph. */
export function registerDecisionsListCommand(program: Command, config: DecisionLedgerOptions = {}): void {
  const root = program.command('decisions').description('대표 결정 원장 · 로컬 전용')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  root.command('list').description('결정 목록 (기본 열린 것)')
    .option('--status <open|decided|all>', '기본 open', 'open').option('--since <date>').option('--version <version>')
    .option('--decided-by <human|auto>').option('--category <category>').option('--json')
    .action(async (o: { status: 'open' | 'decided' | 'all'; since?: string; version?: string; decidedBy?: 'human' | 'auto'; category?: DecisionCategory; json?: boolean }) => {
      try {
        const ledger = new DecisionLedger(config);
        const filters = { status: o.status, since: decisionListSince(o.since), version: o.version, decidedBy: o.decidedBy, category: o.category };
        const { since, ...stableFilters } = filters;
        const cachedRows = readQueryCache({ root: join(dirname(ledger.path), '..', 'cache', 'cli-read-query'),
          key: { command: 'decisions-list', filters: { ...stableFilters, since: o.since ?? null } }, sourcePaths: [ledger.path], ttlMs: 500,
          load: () => ledger.list(stableFilters) });
        const rows = filterDecisionListSince(cachedRows, since);
        const line = o.json ? JSON.stringify(rows) : rows.length ? rows.map(formatDecisionRow).join('\n') : '결정 0건';
        if (o.json) await writeStdoutFully(line);
        else console.log(line);
      } catch (error) {
        throw new Error(`decisions: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}
