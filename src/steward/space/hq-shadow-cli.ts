// STEWARD-HQ — `eln steward hq shadow-report`: the §5a «shadow 1 h vs what OP did» table (read-only).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWindow } from '../../fed-state/kpi.js';
import { readFacts } from '../../fed-state/ledger.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { hqShadowReport, loadHqPolicy, type HqPolicy, readHqShadow, renderHqShadowReport, replayHqShadow } from './hq-shadow.js';
import type { Row } from './model.js';
import { stewardSpaceStatusRows } from './status.js';

export interface HqShadowReportOpts { since?: string; hq?: string; root?: string; facts?: string; replay?: boolean; json?: boolean }

export function runHqShadowReportCli(opts: HqShadowReportOpts): number {
  let policy: HqPolicy;
  try { policy = loadHqPolicy(); } catch (error) { console.error(String(error)); return 1; }
  const root = opts.root ?? effectiveInstanceRoot();
  const hq = (opts.hq ?? 'OP').toUpperCase();
  const until = new Date();
  let since: Date;
  try { since = new Date(until.getTime() - parseWindow(opts.since ?? '1h')); } catch (error) { console.error(String(error)); return 2; }
  // The shadow ledger first; an hour with no shadow line (before the hook ran) is replayed from the kept R0 snapshots.
  let ticks = opts.replay ? [] : readHqShadow(root, hq, since, until);
  if (!ticks.length) ticks = replayHqShadow(root, since, until, policy);
  const { facts } = readFacts({ since: new Date(since.getTime() - policy.matchLeadMin * 60_000), until, ...(opts.facts ? { path: opts.facts } : opts.root ? { path: join(opts.root, 'fed-state', 'facts.jsonl') } : {}) });
  const ledger = join(root, 'steward', 'space', hq, 'ledger.jsonl');
  const ledgerRows: Pick<Row, 'action' | 'reason' | 'target'>[] = [];
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      try { const r = JSON.parse(line) as Row & { at: string }; const ms = Date.parse(r.at); if (ms >= since.getTime() && ms < until.getTime()) ledgerRows.push(r); } catch { /* torn line */ }
    }
  }
  const rollups = stewardSpaceStatusRows(root, until.getTime(), hq).filter((r) => r.lastTickAt && until.getTime() - Date.parse(r.lastTickAt) <= 60 * 60_000).map((r) => r.rollup).filter(Boolean);
  const report = hqShadowReport({ hq, since, until, ticks, facts, policy, ledgerRows, rollups });
  console.log(opts.json ? JSON.stringify(report, null, 1) : renderHqShadowReport(report));
  return 0;
}
