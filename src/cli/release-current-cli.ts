// CURRENT-RELEASE-ONE-SOURCE — `eln release current` (read-only) · `eln release current set <v> --by --cause` (hand surgery).
// 관측 = the one current-board record (release/current-board.json) ⊕ which source answers readers right now ⊕ every live
// config/state that disagrees with it (release.graph.version · package checklist version · PLAN `status: current` ·
// «current board already published» = a missed flip). Exit 0 on read; a bad `set` exits 1.
import type { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activeBoardVersion, isPublishedVersion, readReleaseGraphVersion, resolveCurrentVersion } from '../ops-dashboard/current-version.js';
import { checklistDevVersion } from '../release-loop/checklist.js';
import { compareBoardVersions, readBoardRecord, setBoard, type BoardRecord } from '../release-loop/current-board.js';
import { releaseLedgerRoot } from '../instance/resolve.js';

export interface CurrentBoardReport {
  /** What every reader gets right now (`activeBoardVersion()`). */
  readonly current: string;
  readonly source: 'board' | 'graph' | 'package';
  readonly record: BoardRecord | null;
  /** Disagreements: `warn` = the board is probably wrong/lagging · `note` = expected drift, shown for orientation. */
  readonly checks: ReadonlyArray<{ readonly level: 'warn' | 'note'; readonly what: string }>;
}

export interface CurrentBoardReportDeps {
  readonly ledgerRoot?: string;
  readonly hqRoot?: string;
  readonly record?: () => BoardRecord | null;
  readonly graphVersion?: () => string | null;
  readonly packageVersion?: () => string;
  readonly published?: (v: string) => boolean;
  readonly planVersion?: () => string | null;
}

/** Pure over its deps: the record, the source readers use, and the disagreement lines. */
export function currentBoardReport(deps: CurrentBoardReportDeps = {}): CurrentBoardReport {
  const ledgerRoot = deps.ledgerRoot ?? releaseLedgerRoot();
  const record = (deps.record ?? (() => readBoardRecord(ledgerRoot)))();
  const graph = (deps.graphVersion ?? readReleaseGraphVersion)();
  const pkg = (deps.packageVersion ?? (() => checklistDevVersion()))();
  const current = activeBoardVersion(() => record?.current ?? graph, () => pkg);
  const source: CurrentBoardReport['source'] = record ? 'board' : graph ? 'graph' : 'package';
  const checks: Array<{ level: 'warn' | 'note'; what: string }> = [];
  if (!record) checks.push({ level: 'warn', what: `no current-board record (${join(ledgerRoot, 'release', 'current-board.json')}) — readers fall back to ${source === 'graph' ? `release.graph.version ${graph}` : `the package version ${pkg}`}` });
  const published = deps.published ?? ((v: string) => isPublishedVersion(v, ledgerRoot));
  if (published(current)) checks.push({ level: 'warn', what: `current board ${current} is already published — the flip after its publish is missing (hand: eln release current set <next> --by OP --cause <why>)` });
  if (graph && graph !== current) {
    checks.push(compareBoardVersions(graph, current) > 0
      ? { level: 'warn', what: `release.graph.version ${graph} is newer than the board ${current} — a run for ${graph} is approved while readers work on ${current}` }
      : { level: 'note', what: `release.graph.version ${graph} = the graph run approval (the publish tail of ${graph} / next run not approved yet) — not a board pointer` });
  }
  if (/^\d+\.\d+\.\d+$/u.test(pkg) && pkg !== current) {
    checks.push(compareBoardVersions(pkg, current) > 0
      ? { level: 'warn', what: `package dev version ${pkg} is ahead of the board ${current} — dev-bump landed but the board did not flip` }
      : { level: 'note', what: `package dev version ${pkg} (installed CLI / main dev-bump lag) — not a board pointer` });
  }
  const plan = (deps.planVersion ?? (() => {
    try { const r = resolveCurrentVersion({ hqRoot: deps.hqRoot ?? join(homedir(), 'elanous-hq'), ledgerRoot, boardVersion: null, graphVersion: null }); return r.source === 'plan' ? r.version : null; } catch { return null; }
  }))();
  if (plan && plan !== current) checks.push({ level: 'warn', what: `PLAN-${plan}.md says status: current but the board is ${current} — the plan mark is stale (readers ignore it while a board exists)` });
  return { current, source, record, checks };
}

export function renderCurrentBoard(r: CurrentBoardReport): string {
  const lines = [`현재 판 (current board) = ${r.current} · source ${r.source}`];
  if (r.record) lines.push(`  previous ${r.record.previous ?? '-'} · flippedAt ${r.record.flippedAt} · by ${r.record.by} · cause ${r.record.cause} · seq ${r.record.seq}`);
  for (const c of r.checks) lines.push(`  ${c.level === 'warn' ? '⚠' : '·'} ${c.what}`);
  if (!r.checks.some(c => c.level === 'warn')) lines.push('  ✓ no live config/state disagrees with the board');
  return lines.join('\n');
}

export function registerReleaseCurrentCommands(release: Command): void {
  const current = release.command('current').description('현재 판(current board) 하나 — 기록 · 출처 · 어긋난 설정/상태 (CURRENT-RELEASE-ONE-SOURCE)');
  current.command('show', { isDefault: true }).description('현재 판 기록과 어긋남을 보인다(읽기 전용)').option('--json', 'JSON')
    .action((opts: { json?: boolean }) => {
      const r = currentBoardReport();
      console.log(opts.json ? JSON.stringify(r) : renderCurrentBoard(r));
    });
  current.command('set <version>').description('손 수술: 현재 판을 <version> 으로 옮긴다(되돌리기 포함 · 이유 기록)')
    .requiredOption('--by <seat>', '누가').requiredOption('--cause <why>', '왜')
    .action((version: string, opts: { by: string; cause: string }) => {
      try {
        const r = setBoard({ to: version, by: opts.by, cause: opts.cause });
        if (r.kind === 'flipped') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { announceBoardFlip } = require('../release-loop/current-board.js') as typeof import('../release-loop/current-board.js');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
          const sent = announceBoardFlip(r.record, { stateRoot: effectiveInstanceRoot() });
          console.log(`현재 판 ${r.record.previous ?? '-'} → ${r.record.current} (by ${r.record.by} · ${r.record.cause}) · bus ${sent.bus} · fact ${sent.fact}`);
        } else console.log(`현재 판은 이미 ${r.record.current} — 바꾸지 않았다`);
      } catch (e) {
        console.error(`release current set: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });
}
