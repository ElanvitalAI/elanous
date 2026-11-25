/**
 * `eln watch …` — the watch-the-watchers surface (src/watch/heartbeat.ts).
 *
 *   beat <name> --saw n [--last id|ts] [--err msg] [--every min] [--source msg]   one heartbeat line
 *   status [--json]                                                                every watcher: age · saw · error · cadence · verdict
 *   check [--json] [--no-post]                                                     judge + one deduped card to CLAUDE-OP (5-min trigger graph)
 */
import type { Command } from 'commander';
import { alertStatePath, alertStep, appendBeat, beatLedgerPath, beatSafe, judgeWatchers, makeBeat, readAlertState, readBeats,
  writeAlertState, type SourceHead, type WatcherVerdict } from '../watch/heartbeat.js';

export const ALERT_TO = 'CLAUDE-OP';
export const ALERT_FROM = 'OP';

export interface WatchCliDeps {
  ledger?: string;
  alertState?: string;
  now?: () => Date;
  sourceHead?: SourceHead;
  post?: (args: string[]) => { status: number | null; stderr: string };
}

export function defaultSourceHead(): SourceHead {
  let msgHead: number | null | undefined;
  return (source) => {
    if (source !== 'msg') return null;
    if (msgHead !== undefined) return msgHead;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { defaultMsgStorePath, openMsgStoreReadOnly } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStoreReadOnly(defaultMsgStorePath());
      try { msgHead = store.latestId(); } finally { store.close(); }
    } catch { msgHead = null; }
    return msgHead;
  };
}

function defaultPost(args: string[]): { status: number | null; stderr: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnElanousSync } = require('../instance/spawn-elanous.js') as typeof import('../instance/spawn-elanous.js');
  const r = spawnElanousSync(args, { encoding: 'utf8' });
  return { status: r.status, stderr: String(r.stderr ?? '') };
}

function table(verdicts: readonly WatcherVerdict[]): string {
  if (!verdicts.length) return 'no watcher has beaten yet';
  const rows = verdicts.map(v => [v.status, v.name, `${v.ageMin}m`, `/${v.everyMin}m`, `saw ${v.sawLastWindow}`, `last ${v.last ?? '-'}`,
    v.sourceHead !== null ? `src ${v.source}=${v.sourceHead}` : '', v.lastError ? `err ${v.lastError.slice(0, 60)}` : '', v.status === 'OK' ? '' : `— ${v.reason}`]
    .filter(Boolean).join('  '));
  return rows.join('\n');
}

/** One check pass: judge, card the deduped changes, beat for itself (so a dead checker is itself visible). */
export function runWatchCheck(deps: WatchCliDeps = {}, opts: { post?: boolean } = {}): { verdicts: WatcherVerdict[]; card: string | null; posted: boolean; error: string | null } {
  const now = deps.now?.() ?? new Date();
  const verdicts = judgeWatchers(readBeats(deps.ledger ?? beatLedgerPath()), now, deps.sourceHead ?? defaultSourceHead());
  const statePath = deps.alertState ?? alertStatePath();
  const { card, next } = alertStep(readAlertState(statePath), verdicts, now);
  let posted = false; let error: string | null = null;
  if (card && opts.post !== false) {
    const r = (deps.post ?? defaultPost)(['msg', 'post', '--from', ALERT_FROM, '--to', ALERT_TO, '--kind', 'coord', '--body', card]);
    if (r.status === 0) posted = true;
    else error = `msg post exit ${r.status}: ${r.stderr.trim().slice(0, 300)}`;
  }
  // Only remember the alert as sent when it was sent — a failed post retries next pass instead of going silent.
  if (!card || posted || opts.post === false) writeAlertState(next, statePath);
  if (error) process.stderr.write(`watch check: card post failed — ${error}\n`);
  beatSafe({ name: 'watchers-check', saw: verdicts.length, everyMin: 5, ...(error ? { err: error } : {}) }, deps.ledger ?? beatLedgerPath());
  return { verdicts, card, posted, error };
}

export function registerWatchCommands(program: Command, deps: WatchCliDeps = {}): void {
  const watch = program.command('watch').description('Watch the watchers: heartbeats, DEAD/BLIND/BROKEN verdicts, deduped OP cards');
  watch.command('beat <name>').description('Record one watcher heartbeat')
    .requiredOption('--saw <n>', 'items seen this window')
    .option('--last <id>', 'last item id or timestamp the watcher reached')
    .option('--err <msg>', 'error this window')
    .option('--every <min>', 'expected cadence in minutes', '5')
    .option('--source <kind>', 'source to compare for BLIND (msg = msg store max id)')
    .action((name: string, o: { saw: string; last?: string; err?: string; every: string; source?: string }) => {
      try {
        appendBeat(makeBeat({ name, saw: Number(o.saw), everyMin: Number(o.every), ...(o.last !== undefined ? { last: o.last } : {}),
          ...(o.err ? { err: o.err } : {}), ...(o.source ? { source: o.source } : {}) }, deps.now?.() ?? new Date()), deps.ledger ?? beatLedgerPath());
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });
  watch.command('status').description('Every watcher: last beat age, seen last window, last error, cadence, verdict').option('--json')
    .action((o: { json?: boolean }) => {
      const verdicts = judgeWatchers(readBeats(deps.ledger ?? beatLedgerPath()), deps.now?.() ?? new Date(), deps.sourceHead ?? defaultSourceHead());
      console.log(o.json ? JSON.stringify(verdicts, null, 2) : table(verdicts));
      if (verdicts.some(v => v.status !== 'OK')) process.exitCode = 3;
    });
  watch.command('check').description('Judge every watcher and send one deduped card to CLAUDE-OP').option('--json').option('--no-post', 'judge only')
    .action((o: { json?: boolean; post?: boolean }) => {
      const r = runWatchCheck(deps, { post: o.post });
      console.log(o.json ? JSON.stringify({ outcome: r.error ? 'fail' : 'ok', ...r }) : `${table(r.verdicts)}${r.card ? `\ncard ${r.posted ? 'posted' : 'NOT posted'}` : ''}`);
      if (r.error) process.exitCode = 1;
    });
}
