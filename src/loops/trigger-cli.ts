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
import { beatSafe } from '../watch/heartbeat.js';
import { defaultConditionProbes, type ConditionProbes } from './trigger-conditions.js';
import { listFires, listTriggers, openTriggerRegistry, promoteTrigger, readTriggerDecl, registerTrigger, retryWindow, rollbackTrigger,
  tickTriggers, type TriggerTickDeps } from './trigger-registry.js';

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

export function tickDeps(deps: TriggerCliDeps, root: string, stateRoot: string): TriggerTickDeps {
  return {
    now: deps.now ?? (() => new Date()),
    vars: { seatState: seatStateRoot(), stateRoot },
    probes: deps.probes ?? defaultConditionProbes(),
    cutoverAfterOverride: (deps.cutoverAfterOverride ?? configCutoverAfter)(),
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

export function registerTriggerCommands(loop: Command, deps: TriggerCliDeps = {}): void {
  const trigger = loop.command('trigger').description('Graph trigger registry — one SSOT for cron-fired graphs (dedupe · goal · retry · shadow→live)');
  const roots = (opts: { stateRoot?: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { repoRoot } = require('../domains/schedule-registry.js') as typeof import('../domains/schedule-registry.js');
    // The running code's own root (installed `current` or this checkout) — the tick must run the code that registered it.
    return { root: resolve(deps.root ?? repoRoot()), stateRoot: resolve(opts.stateRoot ?? deps.stateRoot ?? effectiveInstanceRoot()) };
  };
  trigger.command('register [files...]').description('Register graph trigger declarations (default: every graphs/triggers/*.yaml)')
    .option('--update', 'Replace a changed declaration').option('--state-root <dir>').option('--json')
    .action((files: string[], opts: { update?: boolean; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const db = openTriggerRegistry(stateRoot);
      try {
        const results = (files.length ? files : triggerGraphFiles(root)).map(file => {
          const { created, updated, row } = registerTrigger(db, readTriggerDecl(file, root), { update: !!opts.update });
          return { graphId: row.graphId, created, updated, stage: row.stage, trigger: row.cron ?? 'condition', owner: row.owner };
        });
        await output(results, !!opts.json);
      } finally { db.close(); }
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
  trigger.command('tick').description('One pass over every registered trigger (crontab entry point)')
    .option('--only <id>').option('--state-root <dir>').option('--json')
    .action((opts: { only?: string; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      const db = openTriggerRegistry(stateRoot);
      const at = (deps.now?.() ?? new Date()).toISOString();
      try {
        const events = await tickTriggers(db, tickDeps(deps, root, stateRoot), opts.only ? { only: opts.only } : {});
        appendLoopLog(TRIGGER_TICK_LOOP_ID, `${JSON.stringify({ at, events })}\n`, stateRoot);
        beatSafe({ name: 'trigger-tick', saw: events.length, everyMin: 2, last: at });
        await output({ at, events }, !!opts.json);
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
    }));
  trigger.command('rollback <id>').alias('demote').option('--yes').option('--state-root <dir>').option('--json')
    .action((id: string, opts: { yes?: boolean; stateRoot?: string; json?: boolean }) => handle(async () => {
      const { root, stateRoot } = roots(opts);
      if (!opts.yes) { await output({ dryRun: true, id, note: 'Re-enables the legacy path, then sets the trigger back to shadow. Apply with --yes.' }, !!opts.json); return; }
      const db = openTriggerRegistry(stateRoot);
      try { await output(await rollbackTrigger(db, id, tickDeps(deps, root, stateRoot)), !!opts.json); } finally { db.close(); }
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
