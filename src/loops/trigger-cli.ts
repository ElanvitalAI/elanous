/**
 * `eln loop trigger …` — the operator surface of the graph trigger registry (src/loops/trigger-registry.ts).
 *
 *   register <graph.yaml…> [--update]   declare → registry row (single registration; conflicting re-register refused)
 *   list / fires [id]                    registry rows (stage · shadow count · last run) and per-window fires
 *   tick [--only id]                     one pass: fire due windows · goal checks · retries · cards · cutover
 *   install [--yes]                      one crontab entry for `loop trigger tick` through the schedule CRUD
 *   promote <id> [--reason …]            shadow → live now: legacy marker/schedule off first, then live
 *   rollback|demote <id> [--yes]         live → shadow, legacy path re-enabled first
 *   retry <id> --window <iso>            re-arm an exception window
 */
import type { Command } from 'commander';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { appendLoopLog } from './registry.js';
import { beatSafe } from '../kit/heartbeat/index.js';
import { defaultConditionProbes, type ConditionProbes } from './trigger-conditions.js';
import { liveOutcomeProbes } from './outcome-alarms.js';
import { listFires, listOutcomes, listTriggers, openTriggerRegistry, promoteTrigger, readTriggerDecl, registerTrigger, retryWindow, rollbackTrigger,
  tickTriggers, triggerDeclSha, type TriggerRow, type TriggerTickDeps } from './trigger-registry.js';

/** Marker on the one crontab line that drives every registered trigger. */
export const TRIGGER_TICK_LOOP_ID = 'graph-trigger-tick';
export const TRIGGER_TICK_MARKER = `elanous-loop=${TRIGGER_TICK_LOOP_ID}`;
/** Source: condition triggers (retro «by :15», idle ≥ 10 min) need a few-minute evaluation grain; every 2 min keeps
 *  edge latency ≤ 2 min with one short bun start per tick and no resident daemon (대표 11-25 condition triggers). */
export const TRIGGER_TICK_CRON = '*/2 * * * *';

async function output(value: unknown, json: boolean): Promise<void> {
  if (json) await writeStdoutJson(JSON.stringify(value) + '\n');
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function handle(action: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(action).catch(error => {
    console.error(`loop trigger: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export function seatStateRoot(): string {
  return process.env.ELANOUS_SEAT_STATE ?? join(homedir(), 'elanous-hq', 'seat-state');
}

function quote(value: string): string {
  if (/[\r\n%\0]/.test(value)) throw new Error('invalid cron command path');
  return /^[\w./@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The single crontab line; `--config-dir` is carried so a test universe tick stays in its universe.
 *  No shell-opened log (JUD #117698): the tick appends its own result to loop-logs through the guarded open. */
export function triggerTickCommand(root: string, stateRoot: string, bun = process.execPath, configDir?: string): string {
  const seatState = process.env.ELANOUS_SEAT_STATE ? `ELANOUS_SEAT_STATE=${quote(process.env.ELANOUS_SEAT_STATE)} ` : '';
  return `cd ${quote(root)} && ${seatState}${quote(bun)} bin/elanous.mjs${configDir ? ` --config-dir ${quote(configDir)}` : ''} loop trigger tick --state-root ${quote(stateRoot)} --json >/dev/null 2>&1 # ${TRIGGER_TICK_MARKER}`;
}

export interface TriggerCliDeps {
  root?: string;
  stateRoot?: string;
  configDir?: string;
  scheduleManage?: (args: Record<string, unknown>) => Promise<unknown>;
  runGraph?: TriggerTickDeps['runGraph'];
  postCard?: TriggerTickDeps['postCard'];
  now?: () => Date;
  probes?: ConditionProbes;
  /** Test seam for `loops.trigger.cutoverAfter`; default reads the user config (fail-soft). */
  cutoverAfterOverride?: () => number | undefined;
  /** Seam: the loop-tabs reconcile after register/promote/rollback. Default = reconcileLoopTabs, skipped under `bun test` (NODE_ENV=test). */
  reconcileTabs?: (root: string, stateRoot: string) => Promise<void>;
  /** OUTCOME-DONE-ALARMS seam. Default = the live probes (land ledger · release schedules · BULLETIN-NOW.md), skipped under `bun test`. */
  outcomes?: TriggerTickDeps['outcomes'];
}

/** OUTCOME-DONE-ALARMS: the live outcome probes for land-graph · release-rocket · op-bulletin. */
export function liveOutcomes(stateRoot: string, seatState: string): NonNullable<TriggerTickDeps['outcomes']> {
  return liveOutcomeProbes({ stateRoot, seatState, releases: () => {
    const { listSchedules } = require('../release-loop/release-schedule.js') as typeof import('../release-loop/release-schedule.js');
    const { releasedVersion } = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
    return { released: releasedVersion(), schedules: listSchedules() };
  } });
}

/** `loops.trigger.cutoverAfter` from the user config; unreadable or unset → undefined (declarations decide). */
export function configCutoverAfter(): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../user-config.js') as typeof import('../user-config.js');
    const v = (m.getUserConfig() as { loops?: { trigger?: { cutoverAfter?: unknown } } }).loops?.trigger?.cutoverAfter;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  } catch { return undefined; }
}

async function scheduleManage(deps: TriggerCliDeps, args: Record<string, unknown>): Promise<unknown> {
  if (deps.scheduleManage) return deps.scheduleManage(args);
  const { dispatchScheduleManage } = await import('../domains/schedule-manage-tool.js');
  return dispatchScheduleManage(args);
}

function triggerGraphFiles(root: string): string[] {
  const dir = join(root, 'graphs', 'triggers');
  return readdirSync(dir).filter(f => /\.ya?ml$/.test(f) && f !== 'recipes.yaml' && !f.endsWith('.rhythm.yaml')).map(f => relative(root, join(dir, f))).sort();
}

/** Report declarations missing from the registry without changing it or stopping the tick. */
export function triggerRegistrationAnomalies(root: string, rows: readonly Pick<TriggerRow, 'graphId' | 'declSha'>[]): Array<{ file: string; graphId?: string; error?: string }> {
  const registered = new Map(rows.map(row => [row.graphId, row.declSha]));
  let files: string[];
  try { files = triggerGraphFiles(root); }
  catch (error) { return [{ file: 'graphs/triggers', error: error instanceof Error ? error.message : String(error) }]; }
  return files.flatMap<{ file: string; graphId?: string; error?: string }>(file => {
    try {
      const decl = readTriggerDecl(file, root);
      if (!registered.has(decl.graphId)) return [{ file, graphId: decl.graphId }];
      return registered.get(decl.graphId) === triggerDeclSha(decl) ? [] : [{ file, graphId: decl.graphId, error: 'registered declaration differs from source' }];
    } catch (error) {
      return [{ file, error: error instanceof Error ? error.message : String(error) }];
    }
  });
}

export function tickDeps(deps: TriggerCliDeps, root: string, stateRoot: string): TriggerTickDeps {
  return {
    now: deps.now ?? (() => new Date()),
    vars: { seatState: seatStateRoot(), stateRoot },
    probes: deps.probes ?? defaultConditionProbes(),
    cutoverAfterOverride: (deps.cutoverAfterOverride ?? configCutoverAfter)(),
    ...((): Pick<TriggerTickDeps, 'outcomes'> => {
      const outcomes = deps.outcomes ?? (process.env.NODE_ENV === 'test' ? undefined : liveOutcomes(stateRoot, seatStateRoot()));
      return outcomes ? { outcomes } : {};
    })(),
    runGraph: deps.runGraph ?? (async (decl, input, runId) => {
      const { runGraph } = await import('../graph-runner/runner.js');
      const state = await runGraph(resolve(root, decl.file), { input, runId, quiet: true, deps: { root: stateRoot } });
      return { status: state.status, runId: state.runId, ...(state.status === 'done' ? {} : { error: state.reason ?? `ended at ${state.path.at(-1) ?? '?'}` }) };
    }),
    postCard: deps.postCard ?? (async (owner, body) => {
      const { openMsgStore } = await import('../msg/msg-store.js');
      const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
      try {
        const posted = store.post({ from: 'graph-trigger', to: owner, kind: 'request', body } as Parameters<typeof store.post>[0]);
        return `msg#${posted.id}`;
      } finally { store.close(); }
    }),
    scheduleAction: async (action, id) => {
      const result = await scheduleManage(deps, { action, id });
      if (result && typeof result === 'object' && 'error' in result) throw new Error(String((result as { error: unknown }).error));
    },
  };
}

export interface LoopTabsResult { open: { ws: string; count: number }[]; close: { tab: string; id: string }[]; done: string[] }

/**
 * SIDETAB-LOOP-AGENTS-UNDER-SPACE · FU: the loop-tabs reconciler. Reads the registry and the org map, lists els tabs, and keeps
 * ONE «↻ loops (N)» tab per space (it runs `loop trigger loops <space>` — a read-only list, Enter opens one loop's watch in
 * the same tab · 대표 11-26 11:1x). Per-loop «↻ <id>» tabs it opened before and stale list tabs are closed. Children carry this universe's
 * stamp (spawnElanousSync), so a test universe never reaches the production els server. Idempotent.
 */
export async function reconcileLoopTabs(root: string, stateRoot: string, opts: { dryRun?: boolean } = {}): Promise<LoopTabsResult> {
  const { spawnElanousSync } = await import('../instance/spawn-elanous.js');
  const { loadOrgMap } = await import('../org/org-map.js');
  const { loopsBySeat, loopsListTitle, planLoopTabs } = await import('../els/loop-agents.js');
  const db = openTriggerRegistry(stateRoot);
  const agents = (() => { try { return listTriggers(db).map((row) => ({ id: row.graphId, owner: row.owner, stage: row.stage, lastStatus: row.lastStatus, lastAt: row.lastAt })); } finally { db.close(); } })();
  const bySeat = loopsBySeat(agents, loadOrgMap().org.duties);
  const bin = join(root, 'bin', 'elanous.mjs');
  const els = (args: string[]) => spawnElanousSync(['side', ...args], { bin, stateDir: stateRoot, encoding: 'utf8', timeout: 20_000 }) as { status: number | null; stdout: string; stderr: string };
  const listed = els(['ls']);
  let panes: { tab: string; title: string; workspace: string }[] = [];
  try { panes = ((JSON.parse(listed.stdout) as { panes?: { tab?: string; title?: string; workspace?: string }[] }).panes ?? []).filter((one) => one.tab && one.title && one.workspace).map((one) => ({ tab: one.tab!, title: one.title!, workspace: one.workspace! })); }
  catch { throw new Error(`els ls unreadable (is the els server running?): ${listed.stderr?.trim() ?? ''}`); }
  const plan = planLoopTabs(bySeat, panes);
  const done: string[] = [];
  if (!opts.dryRun) {
    for (const one of plan.close) { const r = els(['tab', 'close', '--yes', one.tab]); done.push(`close ${one.id} ${r.status === 0 ? 'ok' : r.stderr.trim()}`); }
    for (const one of plan.open) {
      const r = els(['new', '--ws', one.ws, '--cwd', root, '--title', loopsListTitle(one.count), '--', process.execPath, bin, 'loop', 'trigger', 'loops', one.ws, '--state-root', stateRoot]);
      done.push(`open loops (${one.count}) in ${one.ws} ${r.status === 0 ? 'ok' : r.stderr.trim()}`);
    }
  }
  return { ...plan, done };
}

/** After a registry change: reconcile, never failing the command (no els server = nothing to do; logged to stderr). */
async function reconcileLoopTabsQuietly(root: string, stateRoot: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;   // unit runs never spawn an els child
  try { await reconcileLoopTabs(root, stateRoot); } catch (error) { process.stderr.write(`loop tabs: ${error instanceof Error ? error.message : String(error)}\n`); }
}

export function registerTriggerCommands(loop: Command, deps: TriggerCliDeps = {}): void {
  const trigger = loop.command('trigger').description('Graph trigger registry — one SSOT for cron-fired graphs (dedupe · goal · retry · shadow→live)');
  const roots = (opts: { stateRoot?: string }) => {
    // Do not use cronRepoRoot: it can substitute an unrelated checkout for the running package.
    return { root: resolve(deps.root ?? resolve(import.meta.dir, '../..')), stateRoot: resolve(opts.stateRoot ?? deps.stateRoot ?? effectiveInstanceRoot()) };
  };
  trigger.command('register [files...]').description('Register graph trigger declarations (default: every graphs/triggers/*.yaml)')
    .option('--update', 'Replace a changed declaration').option('--state-root <dir>').option('--json')
    .action((files: string[], opts: { update?: boolean; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const db = openTriggerRegistry(stateRoot);
      try {
        const results = (files.length ? files : triggerGraphFiles(root)).map(file => {
          const { created, updated, row, retired } = registerTrigger(db, readTriggerDecl(file, root), { update: !!opts.update });
          return { graphId: row.graphId, created, updated, stage: row.stage, trigger: row.cron ?? 'condition', owner: row.owner, ...(retired.length ? { retired } : {}) };
        });
        await output(results, !!opts.json);
      } finally { db.close(); }
      await (deps.reconcileTabs ?? reconcileLoopTabsQuietly)(root, stateRoot);
    }));
  trigger.command('list').option('--state-root <dir>').option('--json')
    .action((opts: { stateRoot?: string; json?: boolean }) => handle(async () => {
      const db = openTriggerRegistry(roots(opts).stateRoot);
      try {
        const rows = listTriggers(db);
        if (opts.json) { await output(rows, true); return; }
        console.log('graph\tstage\ttrigger\towner\tshadow ok\tlast window\tlast status\tlegacy');
        for (const r of rows) console.log([r.graphId, r.stage, r.cron ?? `condition (cooldown ${r.condition?.cooldownMin}m)`, r.owner, `${r.shadowSuccesses}/${r.cutoverAfter}`, r.lastWindow ?? '—', r.lastStatus ?? '—', r.legacy ? `${r.legacy.kind}:${'id' in r.legacy ? r.legacy.id : r.legacy.path}` : '—'].join('\t'));
      } finally { db.close(); }
    }));
  trigger.command('fires [id]').option('--limit <n>', 'Rows', '20').option('--state-root <dir>').option('--json')
    .action((id: string | undefined, opts: { limit: string; stateRoot?: string; json?: boolean }) => handle(async () => {
      const db = openTriggerRegistry(roots(opts).stateRoot);
      try { await output(listFires(db, id, Number(opts.limit) || 20), !!opts.json); } finally { db.close(); }
    }));
  // SIDETAB-LOOP-AGENTS-UNDER-SPACE (대표 11-26 07:5x): a loop agent is a read-only els tab running this view. The pane
  // re-reads the registry only when its file changes (mtime of the db and its -wal), at most every 2 s — no polling els.
  trigger.command('watch <id>').description('Live read-only view of one loop agent (its els tab): header and fire timeline')
    .option('--once', 'Print one screen and exit').option('--state-root <dir>')
    .action((id: string, opts: { once?: boolean; stateRoot?: string }) => handle(async () => {
      const { readFileSync, statSync } = await import('node:fs');
      const { loopTabLines, runNodesOf, LOOP_STEP_FIRES } = await import('../els/loop-agents.js');
      const stateRoot = roots(opts).stateRoot;
      const path = join(stateRoot, 'graph-trigger-registry.db');
      // Graph node steps: the run state file of each of the newest fires (graph-runs/<graph>/<runId>.json) — its mtime joins
      // the stamp, so a node finishing redraws the tab without any polling of els.
      const runDir = join(stateRoot, 'graph-runs', id.replace(/[^A-Za-z0-9._-]/g, '_'));
      const runFile = (runId: string): string => join(runDir, `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
      let watchedRuns: string[] = [];
      const mtime = (one: string): string => { try { return String(statSync(one).mtimeMs); } catch { return '-'; } };
      const stamp = (): string => [path, `${path}-wal`, runDir, ...watchedRuns.map(runFile)].map(mtime).join('|');
      const screen = (): string => {
        const db = openTriggerRegistry(stateRoot);
        try {
          const row = listTriggers(db).find((one) => one.graphId === id);
          const width = process.stdout.columns || 100;
          if (!row) return `↻ ${id} · not registered\n`;
          const agent = { id, owner: row.owner, stage: row.stage, lastStatus: row.lastStatus, lastAt: row.lastAt, ...(row.cron ? { cron: row.cron } : {}), ...(row.timeZone ? { timeZone: row.timeZone } : {}) };
          const height = process.stdout.rows || 30;
          // the header stays on screen: the newest fires fill what is left (a fire can take three lines)
          const fires = listFires(db, id, height);
          watchedRuns = fires.slice(0, LOOP_STEP_FIRES).flatMap((fire) => fire.runId ? [fire.runId] : []);
          const runs = new Map(watchedRuns.map((runId) => { let text = ''; try { text = readFileSync(runFile(runId), 'utf8'); } catch { /* not written yet */ } return [runId, runNodesOf(text)] as const; }));
          return loopTabLines(agent, fires, Date.now(), width, !opts.once, runs).slice(0, Math.max(5, height - 1)).join('\n') + '\n';
        } finally { db.close(); }
      };
      if (opts.once) { process.stdout.write(screen()); return; }
      let last = '';
      let minute = -1;
      for (;;) {
        const now = stamp();
        const tick = Math.floor(Date.now() / 60_000);
        if (now !== last || tick !== minute) { last = now; minute = tick; process.stdout.write(`\u001b[H\u001b[2J${screen()}`); }
        await new Promise((done) => setTimeout(done, 2_000));
      }
    }));
  // 대표 11-26 11:1x «루프 탭이 너무 많다»: a space's loops share ONE read-only tab — this list. One line per loop (heartbeat ·
  // last fire · red dot on exception); Enter runs `loop trigger watch <id>` in the same tab, Ctrl-C there comes back here.
  trigger.command('loops <space>').description('Read-only list of one space\'s loop agents (its «↻ loops (N)» els tab): Enter opens a loop\'s watch')
    .option('--once', 'Print one screen and exit').option('--state-root <dir>')
    .action((space: string, opts: { once?: boolean; stateRoot?: string }) => handle(async () => {
      const { statSync } = await import('node:fs');
      const { loadOrgMap } = await import('../org/org-map.js');
      const { loopsBySeat, loopsListLines } = await import('../els/loop-agents.js');
      const { spawnElanous } = await import('../instance/spawn-elanous.js');
      const { root, stateRoot } = roots(opts);
      const path = join(stateRoot, 'graph-trigger-registry.db');
      const seat = space.trim().toUpperCase();
      let ids: string[] = [];
      let selected = 0;
      const screen = (colour: boolean): string => {
        const db = openTriggerRegistry(stateRoot);
        try {
          const rows = listTriggers(db);
          const outcomes = listOutcomes(db);
          const agents = rows.map((row) => { const outcome = outcomes.get(row.graphId); return { id: row.graphId, owner: row.owner, stage: row.stage, lastStatus: row.lastStatus, lastAt: row.lastAt, ...(row.cron ? { cron: row.cron } : {}), ...(row.timeZone ? { timeZone: row.timeZone } : {}),
            ...(outcome ? { outcome: { summary: outcome.summary, bad: outcome.bad } } : {}) }; });
          const mine = loopsBySeat(agents, loadOrgMap().org.duties).get(seat) ?? [];
          ids = mine.map((agent) => agent.id);
          selected = Math.max(0, Math.min(selected, ids.length - 1));
          const entries = mine.map((agent) => ({ agent, fireAtMs: listFires(db, agent.id, 50).map((fire) => Date.parse(fire.dispatchedAt ?? fire.window)).filter(Number.isFinite) }));
          const width = process.stdout.columns || 100;
          const height = process.stdout.rows || 30;
          return loopsListLines(seat, entries, selected, Date.now(), width, colour).slice(0, Math.max(4, height - 1)).join('\n') + '\n';
        } finally { db.close(); }
      };
      if (opts.once || !process.stdin.isTTY) {
        process.stdout.write(screen(!opts.once));
        if (opts.once) return;
      }
      const mtime = (one: string): string => { try { return String(statSync(one).mtimeMs); } catch { return '-'; } };
      const stamp = (): string => [path, `${path}-wal`].map(mtime).join('|');
      let last = '';
      let minute = -1;
      let child: import('node:child_process').ChildProcess | undefined;
      const draw = (): void => { last = stamp(); minute = Math.floor(Date.now() / 60_000); process.stdout.write(`\u001b[H\u001b[2J${screen(true)}`); };
      // Ctrl-C while a watch runs ends only the watch (the terminal signals the whole group); here it ends the list.
      process.on('SIGINT', () => { if (!child) process.exit(130); });
      const stdin = process.stdin;
      if (stdin.isTTY) {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', (chunk: Buffer) => {
          if (child) return;
          const key = chunk.toString('utf8');
          if (key === '\u0003') process.exit(130);
          if (key === '\u001b[A' || key === 'k') { selected = Math.max(0, selected - 1); draw(); return; }
          if (key === '\u001b[B' || key === 'j') { selected = Math.min(Math.max(0, ids.length - 1), selected + 1); draw(); return; }
          if ((key === '\r' || key === '\n') && ids[selected]) {
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write('\u001b[H\u001b[2J');
            // the watch child carries this universe's stamp (spawnElanous), like the reconciler's els children
            child = spawnElanous(['loop', 'trigger', 'watch', ids[selected]!, '--state-root', stateRoot], { bin: join(root, 'bin', 'elanous.mjs'), stateDir: stateRoot, stdio: 'inherit' });
            const back = (): void => { child = undefined; stdin.setRawMode(true); stdin.resume(); draw(); };
            child.on('exit', back);
            child.on('error', back);
          }
          // every other key is ignored: the list is read-only
        });
      }
      draw();
      for (;;) {
        await new Promise((done) => setTimeout(done, 2_000));
        if (child) continue;
        if (stamp() !== last || Math.floor(Date.now() / 60_000) !== minute) draw();
      }
    }));
  // The loop-tabs reconciler: ONE «↻ loops (N)» tab per space with registered triggers (REL/RES → OP when their supervision
  // duty moved); per-loop tabs it opened before and stale list tabs closed. Idempotent; also runs after register/promote/
  // rollback and at els start.
  trigger.command('tabs').description('Reconcile loop-agent els tabs with the registry (one read-only «↻ loops (N)» tab per space)')
    .option('--dry-run').option('--state-root <dir>').option('--json')
    .action((opts: { dryRun?: boolean; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const result = await reconcileLoopTabs(root, stateRoot, { dryRun: !!opts.dryRun });
      if (opts.json) { await output(result, true); return; }
      for (const one of result.open) console.log(`open\t${one.ws}\t↻ loops (${one.count})`);
      for (const one of result.close) console.log(`close\t${one.tab}\t↻ ${one.id}`);
      for (const line of result.done) console.log(line);
      if (!result.open.length && !result.close.length) console.log('loop tabs in sync');
    }));
  trigger.command('tick').description('One pass over every registered trigger (crontab entry point)')
    .option('--only <id>').option('--state-root <dir>').option('--json')
    .action((opts: { only?: string; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const db = openTriggerRegistry(stateRoot);
      const at = (deps.now?.() ?? new Date()).toISOString();
      try {
        const anomalies = triggerRegistrationAnomalies(root, listTriggers(db));
        const events = await tickTriggers(db, tickDeps(deps, root, stateRoot), opts.only ? { only: opts.only } : {});
        appendLoopLog(TRIGGER_TICK_LOOP_ID, `${JSON.stringify({ at, events, anomalies })}\n`, stateRoot);
        beatSafe({ name: 'trigger-tick', saw: events.length, everyMin: 2, last: at, ...(anomalies.length ? { err: `${anomalies.length} unregistered, stale or invalid trigger declaration(s)` } : {}) });
        await output({ at, events, anomalies }, !!opts.json);
      } catch (error) {
        appendLoopLog(TRIGGER_TICK_LOOP_ID, `${JSON.stringify({ at, error: error instanceof Error ? error.message : String(error) })}\n`, stateRoot);
        beatSafe({ name: 'trigger-tick', saw: 0, everyMin: 2, last: at, err: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally { db.close(); }
    }));
  trigger.command('install').description('Install the one tick crontab entry through the schedule CRUD (idempotent)')
    .option('--yes', 'Apply (otherwise preview)').option('--state-root <dir>').option('--json')
    .action((opts: { yes?: boolean; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const listed = await scheduleManage(deps, { action: 'list' }) as { schedules?: Array<{ id: string; command?: string | null; command_full?: string | null; raw?: string }> };
      // `command` is truncated to 120 chars in the list view — the marker sits at the end, so read command_full.
      const existing = (listed.schedules ?? []).filter(row => `${row.command_full ?? row.command ?? ''} ${row.raw ?? ''}`.includes(TRIGGER_TICK_MARKER));
      const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
      const configDir = deps.configDir ?? getElanousConfigDirOverride();
      const command = triggerTickCommand(root, stateRoot, process.execPath, configDir);
      if (existing.length) {
        await output({ installed: false, reason: 'already installed (single registration)', ids: existing.map(row => row.id) }, !!opts.json);
        return;
      }
      if (!opts.yes) { await output({ dryRun: true, create: { cron: TRIGGER_TICK_CRON, command }, note: 'Apply with --yes (crontab backup).' }, !!opts.json); return; }
      const result = await scheduleManage(deps, { action: 'create', cron: TRIGGER_TICK_CRON, command });
      if (result && typeof result === 'object' && 'error' in result) throw new Error(String((result as { error: unknown }).error));
      await output({ installed: true, cron: TRIGGER_TICK_CRON, command, result }, !!opts.json);
    }));
  trigger.command('promote <id>').description('Promote shadow → live now (legacy off first, then live) — no shadow wait')
    .option('--reason <text>').option('--state-root <dir>').option('--json')
    .action((id: string, opts: { reason?: string; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const db = openTriggerRegistry(stateRoot);
      try {
        const { row, events } = await promoteTrigger(db, id, tickDeps(deps, root, stateRoot), opts.reason);
        appendLoopLog(TRIGGER_TICK_LOOP_ID, `${JSON.stringify({ at: (deps.now?.() ?? new Date()).toISOString(), promote: id, events })}\n`, stateRoot);
        await output({ graphId: row.graphId, stage: row.stage, events }, !!opts.json);
      } finally { db.close(); }
      await (deps.reconcileTabs ?? reconcileLoopTabsQuietly)(root, stateRoot);
    }));
  trigger.command('rollback <id>').alias('demote').option('--yes').option('--state-root <dir>').option('--json')
    .action((id: string, opts: { yes?: boolean; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      if (!opts.yes) { await output({ dryRun: true, id, note: 'Re-enables the legacy path, then sets the trigger back to shadow. Apply with --yes.' }, !!opts.json); return; }
      const db = openTriggerRegistry(stateRoot);
      try { await output(await rollbackTrigger(db, id, tickDeps(deps, root, stateRoot)), !!opts.json); } finally { db.close(); }
      await (deps.reconcileTabs ?? reconcileLoopTabsQuietly)(root, stateRoot);
    }));
  trigger.command('retry <id>').requiredOption('--window <iso>').option('--state-root <dir>').option('--json')
    .action((id: string, opts: { window: string; stateRoot?: string; json?: boolean }) => handle(async () => {
      const db = openTriggerRegistry(roots(opts).stateRoot);
      try {
        const ok = retryWindow(db, id, opts.window, deps.now?.() ?? new Date());
        if (!ok) throw new Error(`no exception window ${opts.window} for ${id}`);
        await output({ rearmed: true, id, window: opts.window }, !!opts.json);
      } finally { db.close(); }
    }));
}
