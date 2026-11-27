// `eln world …` — WORLD-REGISTRY: every actor in the world, folded from the lease ledger (resource-ledger/events.jsonl).
//   ls [--kind k] [--state s] [--host h] [--owner o] [--json]   rows (state judged against now)
//   show <id> [--json]                                         one row ⊕ its ledger lines (audit trail)
//   anomalies [--json]                                         unregistered · zombie · no-owner · unreachable scope
//   sweep [--host h] [--by who] [--json]                       discovery sweep (LLM 0 · the guardian runs it)
//   register <id> --kind k [fields]                            an owner declares an actor (registered=true)
//   update <id> [fields]                                       an owner changes fields of an existing actor
//   control <id> pause|resume|demote --reason r [--to lvl]     state through the ledger where a control path exists (audited · reversible)
//   summary                                                    the one-line world summary (fed snapshot · pulse)
//   facts get <key> | facts ls                                 resource facts (kit/resource-facts) for ops scripts
// Writers: guardian (loop:guardian) and its sub-agents, RES, OP write any row; other owners only their own rows.
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import type { WorldActorFields } from './world-ledger-events.js';
import type { SweepReport, SweepSources, PaneLike } from './world-discover.js';
import type { WorldView } from './world-registry.js';
import type { WorldActor } from './world-types.js';

async function ledger(): Promise<{ path: string; events: import('./resource-ledger.js').ResourceLedgerEvent[] }> {
  const r = await import('./resource-ledger.js');
  const path = r.resourceLedgerPath();
  return { path, events: r.readResourceLedger(path) };
}

async function viewNow(now = new Date()): Promise<WorldView & { events: import('./resource-ledger.js').ResourceLedgerEvent[] }> {
  const { events } = await ledger();
  const { foldWorld } = await import('./world-registry.js');
  return { ...foldWorld(events, now), events };
}

function age(iso: string | null, now: Date): string {
  if (!iso) return '-';
  const m = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  return m < 120 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function line(a: WorldActor, now: Date): string {
  return [a.state.padEnd(12), a.kind.padEnd(13), a.id, `owner ${a.owner ?? '-'}`, `beat ${age(a.heartbeatAt, now)}`, a.purpose ? `· ${a.purpose.slice(0, 80)}` : ''].filter(Boolean).join('  ');
}

/** Live sources for a sweep (each fails open inside runSweep). */
export async function liveSweepSources(onlyHost?: string): Promise<SweepSources> {
  const d = await import('./world-discover.js');
  const { readHostLedger } = await import('../nexus/host-registry/store.js');
  const hostRecords = () => Object.values(readHostLedger()?.hosts ?? {}).map(h => ({ host: h.host, aliases: h.aliases, seat: h.seat, lastHeartbeatMs: h.lastHeartbeatMs }));
  const records = (() => { try { return hostRecords(); } catch { return []; } })();
  const localHost = d.localHostKey(records);
  const all = [...new Set([localHost, ...records.map(r => r.host)])];
  return {
    localHost,
    hosts: onlyHost ? [onlyHost] : all,
    probe: d.defaultProbeRunner,
    hostRecords,
    loops: () => { const { listAllLoops } = require('../loops/registry.js') as typeof import('../loops/registry.js'); return listAllLoops(); },
    beats: () => { const { readBeats } = require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js'); return readBeats(); },
    panes: () => {
      const r = spawnSync('els', ['pane', 'list'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`els pane list exit ${r.status ?? 'signal'}`);
      return (JSON.parse(r.stdout) as { result?: { panes?: PaneLike[] } }).result?.panes ?? [];
    },
  };
}

/** Sweep with the census seed applied first (once per ledger). */
export async function sweepNow(onlyHost?: string, now = new Date(), by = 'loop:guardian'): Promise<SweepReport & { seeded: number }> {
  const r = await import('./resource-ledger.js');
  const { runSweep } = await import('./world-discover.js');
  const { seedApplied, seedEvents } = await import('./world-seed.js');
  const src = await liveSweepSources(onlyHost);
  const path = r.resourceLedgerPath();
  let seeded = 0;
  if (!seedApplied(r.readResourceLedger(path))) { const lines = seedEvents(src.localHost, now); r.recordWorldEvents(lines, path); seeded = lines.length; }
  const report = { ...runSweep(src, now, { by, path }), seeded };
  markSwept(report, now);
  return report;
}

/** The sweep's own proof of life: the trigger goal file ⊕ one `eln watch beat world-sweep` (fail-open — never fails a sweep). */
export function markSwept(report: SweepReport & { seeded: number }, now: Date): void {
  try {
    const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = join(effectiveInstanceRoot(), 'loop-agents', 'guardian');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'world-sweep.json'), JSON.stringify({ at: report.at, lines: report.lines, seeded: report.seeded, scopes: report.scopes }));
  } catch { /* the trigger goal misses and the registry cards the owner */ }
  try {
    const { appendBeat, makeBeat } = require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js');
    // A stopped paid VM is a normal «unreachable» row, not a broken sweeper: err only when no scope answered at all.
    const anyOk = report.scopes.some(s => s.ok);
    appendBeat(makeBeat({ name: 'world-sweep', saw: report.scopes.reduce((n, s) => n + s.seen, 0), last: report.at, everyMin: 15,
      ...(anyOk ? {} : { err: 'no scope answered' }) }, now));
  } catch { /* watchers-check reports the missing beat */ }
}

type FieldOpts = Record<string, string | undefined> & { json?: boolean };

function declFrom(id: string, o: FieldOpts): Omit<WorldActorFields, 'kind'> & { kind?: WorldActorFields['kind'] } {
  const d: Record<string, unknown> = { id, mode: 'owner' };
  for (const k of ['kind', 'purpose', 'owner', 'subject', 'wake', 'kpi', 'host'] as const) if (o[k] !== undefined) d[k] = o[k];
  if (o.heartbeat !== undefined) d.heartbeatSource = o.heartbeat;
  if (o.sla !== undefined) { const n = Number(o.sla); if (!Number.isFinite(n) || n < 0) throw new Error('--sla must be minutes ≥ 0'); d.slaMin = n === 0 ? null : n; }
  if (o.state !== undefined) d.declaredState = o.state;
  return d as Omit<WorldActorFields, 'kind'>;
}

function addFields(c: Command): Command {
  return c.option('--purpose <text>', 'one line: why it exists').option('--owner <seat>', 'owner seat / L0').option('--subject <text>', 'what it supervises or serves')
    .option('--wake <trigger>', 'cron expr · interval · event · always').option('--kpi <text>', 'what success is measured by')
    .option('--heartbeat <source>', 'watch:<name> · loop · seen · log').option('--sla <min>', 'heartbeat SLA in minutes (0 = none)')
    .option('--host <name>', 'host key').option('--state <s>', 'declared state: live · shadow · off').option('--by <who>', 'writer (default ELANOUS_TRACK, else OP)').option('--json');
}

export function registerWorldCommands(program: Command): void {
  const world = program.command('world').description('World registry — every actor (seats · loops · supervisors · launchd · cron · hosts · processes · fuel · credentials) on the lease ledger');

  world.command('ls').description('List actors (state judged against now)')
    .option('--kind <k>').option('--state <s>').option('--host <h>').option('--owner <o>').option('--json')
    .action(async (o: { kind?: string; state?: string; host?: string; owner?: string; json?: boolean }) => {
      const t = await import('./world-types.js'); const w = await import('./world-registry.js');
      if (o.kind && !t.isWorldKind(o.kind)) { console.error(`world ls: unknown kind ${o.kind} (${t.WORLD_KINDS.join(' · ')})`); process.exitCode = 2; return; }
      if (o.state && !t.isWorldState(o.state)) { console.error(`world ls: unknown state ${o.state} (${t.WORLD_STATES.join(' · ')})`); process.exitCode = 2; return; }
      const now = new Date(); const v = await viewNow(now);
      const rows = v.actors.filter(a => (!o.kind || a.kind === o.kind) && (!o.state || a.state === o.state) && (!o.host || a.host === o.host) && (!o.owner || a.owner === o.owner));
      if (o.json) { console.log(JSON.stringify(rows)); return; }
      console.log(w.summaryLine(w.summarize(v.actors)));
      console.log(v.sweeps.length ? `last sweep: ${v.sweeps.map(s => `${s.scope} ${age(s.at, now)}${s.ok ? '' : ' ✗'}`).join(' · ')}` : 'never swept — run `eln world sweep`');
      console.log(rows.length ? rows.map(a => line(a, now)).join('\n') : 'no actors match');
    });

  world.command('show <id>').description('One actor ⊕ its ledger lines').option('--json')
    .action(async (id: string, o: { json?: boolean }) => {
      const w = await import('./world-registry.js'); const v = await viewNow();
      const a = v.actors.find(x => x.id === id);
      if (!a) { console.error(`world show: no actor ${id}`); process.exitCode = 1; return; }
      const trail = w.eventsFor(v.events, id).slice(-20);
      if (o.json) { console.log(JSON.stringify({ actor: a, events: trail })); return; }
      console.log(JSON.stringify(a, null, 2));
      console.log(trail.map(e => e.event === 'world-actor' ? `${e.at} declare(${e.actor.mode}) by ${e.by}` : e.event === 'world-control' ? `${e.at} control ${e.action}${e.to ? `→${e.to}` : ''} ${e.result} by ${e.by} — ${e.reason}${e.undo ? ` (undo: ${e.undo})` : ''}` : `${e.at} sweep ${e.scope} by ${e.by}${e.appeared.includes(id) ? ' appeared' : ''}${e.gone.includes(id) ? ' gone' : ''}${id in e.beats ? ` beat ${e.beats[id]}` : ''}`).join('\n') || 'no lines');
    });

  world.command('anomalies').description('What OP must look at: unregistered · zombie · no-owner · unreachable').option('--json')
    .action(async (o: { json?: boolean }) => {
      const w = await import('./world-registry.js'); const v = await viewNow();
      const list = w.anomaliesOf(v);
      if (o.json) { console.log(JSON.stringify(list)); return; }
      if (!list.length) { console.log(v.sweeps.length ? 'no anomalies' : 'never swept — run `eln world sweep`'); return; }
      const by = new Map<string, typeof list>();
      for (const a of list) { const k = `${a.kind} · ${a.actorKind}`; by.set(k, [...(by.get(k) ?? []), a]); }
      for (const [k, rows] of [...by].sort((x, y) => y[1].length - x[1].length)) {
        console.log(`${k} (${rows.length})`);
        const purpose = new Map(v.actors.map(a => [a.id, a.purpose] as const));
        for (const r of rows.slice(0, 15)) console.log(`  ${r.id}  — ${r.reason}${purpose.get(r.id) ? ` · ${purpose.get(r.id)!.slice(0, 90)}` : ''}`);
        if (rows.length > 15) console.log(`  … ${rows.length - 15} more (eln world anomalies --json)`);
      }
    });

  world.command('sweep').description('Discovery sweep (LLM 0): launchd · crontab · processes per host ⊕ loops · watch beats · els panes · host registry')
    .option('--host <h>', 'only this host').option('--by <who>', 'sweeper identity (the guardian runs it)').option('--json')
    .action(async (o: { host?: string; by?: string; json?: boolean }) => {
      const w = await import('./world-registry.js');
      const r = await sweepNow(o.host, new Date(), o.by ?? 'loop:guardian');
      if (o.json) { console.log(JSON.stringify(r)); return; }
      console.log(`swept ${r.scopes.length} scope(s) · ${r.lines} ledger line(s)${r.seeded ? ` · census seed ${r.seeded}` : ''}`);
      for (const s of r.scopes) console.log(`  ${s.ok ? '✓' : '✗'} ${s.scope}  ${s.ok ? `seen ${s.seen} · appeared ${s.appeared} · gone ${s.gone} · declared ${s.declared}` : ''}${s.error ? ` ${s.error}` : ''}`);
      const v = await viewNow();
      console.log(w.summaryLine(w.summarize(v.actors)));
    });

  const write = async (mode: 'register' | 'update', id: string, o: FieldOpts) => {
    const t = await import('./world-types.js'); const w = await import('./world-registry.js'); const r = await import('./resource-ledger.js');
    let decl: ReturnType<typeof declFrom>;
    try { decl = declFrom(id, o); } catch (e) { console.error(`world ${mode}: ${(e as Error).message}`); process.exitCode = 2; return; }
    if (decl.kind !== undefined && !t.isWorldKind(decl.kind)) { console.error(`world ${mode}: unknown kind ${String(decl.kind)}`); process.exitCode = 2; return; }
    if (decl.declaredState !== undefined && !t.isDeclaredState(decl.declaredState)) { console.error(`world ${mode}: --state must be live · shadow · off`); process.exitCode = 2; return; }
    const { path, events } = await ledger();
    const prev = w.foldWorld(events, new Date()).actors.find(a => a.id === id);
    if (mode === 'update' && !prev) { console.error(`world update: no actor ${id} (register it first)`); process.exitCode = 1; return; }
    const kind = decl.kind ?? prev?.kind;
    if (!kind) { console.error('world register: --kind is required for a new actor'); process.exitCode = 2; return; }
    const by = o.by ?? process.env.ELANOUS_TRACK ?? 'OP';
    if (!t.mayWrite(by, prev?.owner ?? null) || (decl.owner && !t.mayWrite(by, decl.owner))) {
      console.error(`world ${mode}: ${by} may not write ${id} (owner ${prev?.owner ?? decl.owner}) — owners write their own rows; guardian/RES/OP write any`); process.exitCode = 3; return;
    }
    const actor: WorldActorFields = { ...decl, kind, ...(mode === 'register' ? { registered: true } : {}) };
    r.recordWorldEvents([{ event: 'world-actor', at: new Date().toISOString(), by, actor }], path);
    const a = w.foldWorld(r.readResourceLedger(path), new Date()).actors.find(x => x.id === id)!;
    console.log(o.json ? JSON.stringify(a) : `${mode === 'register' ? 'registered' : 'updated'} ${a.id} · ${a.state} — ${a.reason}`);
  };
  addFields(world.command('register <id>').description('An owner declares an actor (elanous tools call this when they create loops/launchd/cron)').option('--kind <k>', 'actor kind'))
    .action(async (id: string, o: FieldOpts) => write('register', id, o));
  addFields(world.command('update <id>').description('An owner changes fields of an existing actor (no deletes — retire=never)'))
    .action(async (id: string, o: FieldOpts) => write('update', id, o));

  world.command('control <id> <action>').description('pause · resume · demote an actor where a control path exists (loop trigger/agent · elanous launchd · cron) — audited, reversible, no deletes')
    .requiredOption('--reason <text>', 'why (audited)').option('--to <level>', 'demote level for loop agents: L1 · shadow · off').option('--by <who>', 'controller (default ELANOUS_TRACK, else OP)').option('--json')
    .action(async (id: string, action: string, o: { reason: string; to?: string; by?: string; json?: boolean }) => {
      const c = await import('./world-control.js'); const e = await import('./world-ledger-events.js'); const w = await import('./world-registry.js');
      const r = await import('./resource-ledger.js'); const reg = await import('./world-register.js');
      if (!(e.WORLD_CONTROL_ACTIONS as readonly string[]).includes(action)) { console.error(`world control: action must be ${e.WORLD_CONTROL_ACTIONS.join(' · ')}`); process.exitCode = 2; return; }
      const { path, events } = await ledger(); const now = new Date();
      const actor = w.foldWorld(events, now).actors.find(a => a.id === id);
      const out = c.controlActor(actor, id, action as import('./world-ledger-events.js').WorldControlAction, { by: o.by ?? process.env.ELANOUS_TRACK ?? 'OP', reason: o.reason,
        ...(o.to ? { to: o.to } : {}), localHost: reg.localWorldHost(), uid: process.getuid?.() ?? 501, now });
      r.recordWorldEvents(out.lines, path);
      if (o.json) console.log(JSON.stringify(out));
      else console.log(`${out.result} · ${id} ${action}${o.to ? `→${o.to}` : ''} — ${out.detail}`);
      if (out.result !== 'applied') process.exitCode = out.result === 'refused' ? 3 : 1;
    });

  world.command('summary').description('One line: 세계 live · zombie · unregistered · no-owner')
    .action(async () => { const w = await import('./world-registry.js'); const v = await viewNow(); console.log(w.summaryLine(w.summarize(v.actors))); });
  // RESOURCE-FACTS-FROM-LEDGER — `eln world facts get|ls` (hosts · roles · caps · review routing · expiries).
  (require('../kit/resource-facts/cli.js') as typeof import('../kit/resource-facts/cli.js')).registerFactsSubcommands(world);
}
