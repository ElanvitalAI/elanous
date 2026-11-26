// ELS-FANOUT-GATHER CLI — `els fanout` / `els gather` registered from inside the els product (re-exported through
// control-cli.ts so the eln→els boundary does not grow). Logic lives in ./fanout.ts.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { requestEls } from './client.js';
import type { ElsResult } from './core.js';
import { elsSocketPath } from './server.js';
import { subscribeEls } from './subscribe-client.js';
import { stripScreenHeader, driveQueue, fillSlots, FANOUT_DEFAULT_PREFIX, gatherRows, isTerminal, launchItem, loadRecord, newRunId, observe, parseDuration, parseOver, planFanout, saveRecord, waitAll, type FanoutRecord, type LaunchFn, type ListedPane } from './fanout.js';

export interface FanoutCliDeps {
  readonly emit: (result: ElsResult) => void;
  readonly stateRoot: () => string;
  readonly close: (pane: string) => Promise<ElsResult>;
  /** The state-dir pin (and its provenance) for the detached queue driver — built by the caller, els stays protocol-only. */
  readonly childStateEnv: (root: string) => Record<string, string>;
}

export function registerFanoutCommands(side: Command, deps: FanoutCliDeps): void {
  // ELS-FANOUT-GATHER: one tab per item through the same authorized `new` request; gather folds them back as JSON.
  const fanoutLaunch: LaunchFn = (item, record) => requestEls(elsSocketPath(), { op: 'new', ws: record.ws, cwd: record.cwd, command: ['/bin/sh', '-c', item.command], title: item.title });
  const fanoutSubscribe = (onList: (panes: ListedPane[]) => void, onEnd: (reason: string) => void) =>
    subscribeEls(elsSocketPath(), { onList: (message) => { try { onList((JSON.parse(message) as { panes: ListedPane[] }).panes); } catch { /* malformed list: skip */ } }, onEnd });
  const readText = (path: string): string | undefined => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
  side.command('fanout')
    .description('Open one tab per item in a workspace («<prefix>·<i>»), each running the command with {item} (shell-quoted) and {i}; --max K queues the rest until earlier tabs exit. Prints the run record (runId) for `els gather`')
    .requiredOption('--ws <workspace>', 'workspace (created if missing)')
    .option('--over <file|N>', 'items: a file (one per line) or a count N (1..N)')
    .option('--name <prefix>', 'tab name prefix', FANOUT_DEFAULT_PREFIX)
    .option('--max <K>', 'at most K tabs running at once')
    .option('--cwd <folder>', 'tab working directory (default: this folder)')
    .argument('<command...>', 'command after -- with {item} {i}')
    .action(async (command: string[], opts: { ws: string; over?: string; name: string; max?: string; cwd?: string }) => {
      const over = parseOver(opts.over ?? '1', readText);
      if (!over.ok) { deps.emit({ exitCode: 2, message: over.message }); return; }
      const max = opts.max === undefined ? undefined : Number(opts.max);
      if (max !== undefined && !(Number.isInteger(max) && max > 0)) { deps.emit({ exitCode: 2, message: 'els fanout: --max must be a positive whole number' }); return; }
      const stateRoot = deps.stateRoot();
      const record = planFanout({ runId: newRunId(), ws: opts.ws, prefix: opts.name, template: command.join(' '), cwd: opts.cwd ?? process.cwd(), ...(max ? { max } : {}), items: over.items, now: Date.now() });
      // The first tab is the authorization probe: a door refusal stops the run before anything else is opened.
      const first = record.items[0]!;
      if (!(await launchItem(record, first, fanoutLaunch, Date.now))) { saveRecord(stateRoot, record); deps.emit({ exitCode: 1, message: `els fanout: ${first.error ?? 'new refused'}` }); return; }
      await fillSlots(record, 1, fanoutLaunch, Date.now);
      saveRecord(stateRoot, record);
      if (record.items.some((item) => item.state === 'queued')) {
        // The rest start as earlier tabs exit: a detached driver follows the pushed listing (same credentials in env).
        const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? '', 'side', '_fanout-drive', record.runId], { detached: true, stdio: 'ignore', env: { ...process.env, ...deps.childStateEnv(stateRoot) } });
        child.unref();
      }
      deps.emit({ exitCode: 0, message: JSON.stringify(record, null, 2) });
    });
  side.command('_fanout-drive <runId>', { hidden: true }).action(async (runId: string) => {
    const stateRoot = deps.stateRoot();
    const record = loadRecord(stateRoot, runId);
    if (!record) { process.exitCode = 1; return; }
    const result = await driveQueue(record, { launch: fanoutLaunch, subscribe: fanoutSubscribe, save: (r) => saveRecord(stateRoot, r), now: Date.now });
    process.exit(result.ok ? 0 : 1);
  });
  side.command('gather <runId>')
    .description('Fold a fanout run into JSON per tab: item · status (queued/running/exited/failed) · exit code · duration · last N screen lines (or a per-item --file)')
    .option('--wait', 'block until every tab exits or the timeout hits (partial results are marked)')
    .option('--timeout <dur>', 'with --wait: 10m · 90s · 2h', '10m')
    .option('--tail <N>', 'last N screen lines per tab', '20')
    .option('--file <pattern>', 'read this per-item file instead of the screen ({i} = index)')
    .option('--close', 'close the tabs that finished')
    .action(async (runId: string, opts: { wait?: boolean; timeout: string; tail: string; file?: string; close?: boolean }) => {
      const stateRoot = deps.stateRoot();
      const record = loadRecord(stateRoot, runId);
      if (!record) { deps.emit({ exitCode: 1, message: `els gather: unknown run ${runId}` }); return; }
      const timeoutMs = parseDuration(opts.timeout);
      if (timeoutMs === undefined) { deps.emit({ exitCode: 2, message: `els gather: bad --timeout ${opts.timeout}` }); return; }
      const save = (r: FanoutRecord): void => { const fresh = loadRecord(stateRoot, runId); if (fresh) for (const item of r.items) { const f = fresh.items[item.i - 1]; if (f && f.state !== 'queued' && item.state === 'queued') Object.assign(item, f); } saveRecord(stateRoot, r); };
      let complete = record.items.every(isTerminal); let reason: string | undefined;
      if (opts.wait && !complete) ({ complete, reason } = await waitAll(record, { subscribe: (onList, onEnd) => fanoutSubscribe((panes) => { const fresh = loadRecord(stateRoot, runId); if (fresh) for (const item of record.items) { const f = fresh.items[item.i - 1]; if (f && item.state === 'queued' && f.state !== 'queued') Object.assign(item, f); } onList(panes); }, onEnd), save, now: Date.now, timeoutMs }));
      else { const listed = await requestEls(elsSocketPath(), { op: 'ls' }); if (listed.exitCode === 0) { observe(record, (JSON.parse(listed.message) as { panes: ListedPane[] }).panes, Date.now()); save(record); complete = record.items.every(isTerminal); } }
      const tail = Math.max(0, Number(opts.tail) || 0);
      const rows = await gatherRows(record, { tail, now: Date.now(), ...(opts.file ? { file: opts.file } : {}), readFile: readText,
        readScreen: async (pane) => { const r = await requestEls(elsSocketPath(), { op: 'read', pane }); return r.exitCode === 0 ? stripScreenHeader(r.message) : undefined; } });
      const closed: string[] = [];
      if (opts.close) for (const item of record.items) if (item.done && item.pane) { const r = await deps.close(item.pane); if (r.exitCode === 0) closed.push(item.pane); }
      deps.emit({ exitCode: 0, message: JSON.stringify({ runId, ws: record.ws, complete, partial: !complete, ...(reason && !complete ? { reason } : {}), rows, ...(opts.close ? { closed } : {}) }, null, 2) });
    });
}
