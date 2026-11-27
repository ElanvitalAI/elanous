// SIM-WORLD machine-infra · WORLD-REGISTRY (대표 11-27 «시뮬레이션 월드에서 다 충분히 검증»).
// Drives the REAL world-registry code on main — `runSweep` (probe parser · observations · delta lines), the REAL lease
// ledger writer/parser (`recordWorldEvents` / `readResourceLedger`) and the REAL fold/judge (`foldWorld` · `anomaliesOf`
// · `worldDigest`). Only the outside is faked: host probe text, ssh reachability, loop/beat/pane sources and the clock.
// The ledger lives under ctx.universeRoot; no real resource ledger is ever opened. Each scenario varies its world by
// ctx.random (seeded), so `--seed N` gives N different hosts / counts / cadences with the same verdict.
import { join } from 'node:path';
import { readResourceLedger, recordWorldEvents } from '../../../resource-ledger/resource-ledger.js';
import { runSweep, type BeatLike, type ProbeOutcome, type SweepSources } from '../../../resource-ledger/world-discover.js';
import { anomaliesOf, foldWorld } from '../../../resource-ledger/world-registry.js';
import { worldDigest } from '../../../resource-ledger/world-summary.js';
import { controlActor, type ControlRunner } from '../../../resource-ledger/world-control.js';
import { registerCronQuietly } from '../../../resource-ledger/world-register.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-27T03:00:00Z');
const MIN = 60_000;
const HOSTS = ['node-b', 'minim5', 'node-c', 'mbp'] as const;

const fail = (reason: string, diff: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof diff === 'string' ? diff : JSON.stringify(diff) });
const pick = <T>(ctx: SimWorldScenarioContext, xs: readonly T[]): T => xs[Math.floor(ctx.random() * xs.length) % xs.length]!;
const between = (ctx: SimWorldScenarioContext, lo: number, hi: number) => lo + Math.floor(ctx.random() * (hi - lo + 1));
const at = (min: number) => new Date(T0 + min * MIN);

export function worldLedger(ctx: SimWorldScenarioContext): string { return join(ctx.universeRoot, 'resource-ledger', 'events.jsonl'); }

export const probeText = (ps: readonly string[], launchd: readonly string[] = [], plists: readonly string[] = []) =>
  ['@@LAUNCHCTL', ...launchd, '@@PLIST', ...plists, '@@CRON', '@@PS', ...ps, '@@END'].join('\n');
const ok = (stdout: string): ProbeOutcome => ({ ok: true, stdout, error: null });

export function simSources(probes: Record<string, ProbeOutcome>, over: Partial<Omit<SweepSources, 'beats'>> & { beats?: BeatLike[] } = {}): SweepSources {
  const { beats, ...rest } = over;
  return {
    localHost: 'mshq', hosts: Object.keys(probes), probe: (h) => probes[h] ?? { ok: false, stdout: '', error: 'no route' },
    loops: () => [], beats: () => beats ?? [], panes: () => [], hostRecords: () => [], ...rest,
  };
}

export const view = (ctx: SimWorldScenarioContext, now: Date) => foldWorld(readResourceLedger(worldLedger(ctx)), now);

/** WORLD-UNREGISTERED — N long-running processes appear on a host nobody registered → N anomalies; an owner registers one → it is live, N-1 remain. */
const unregistered: SimWorldScenario = {
  id: 'WORLD-UNREGISTERED', title: 'unregistered processes appear → one anomaly each; an owner registers one → live',
  async run(ctx) {
    const host = pick(ctx, HOSTS); const n = between(ctx, 1, 5);
    const ps = Array.from({ length: n }, (_, i) => `  ${4000 + i} 0${between(ctx, 1, 9)}:00:00 /bun /x/bin/elanous.mjs mystery-${i} serve`);
    runSweep(simSources({ [host]: ok(probeText(ps)) }), at(0), { path: worldLedger(ctx) });
    const first = anomaliesOf(view(ctx, at(0))).filter(a => a.kind === 'unregistered' && a.host === host).map(a => a.id).sort();
    ctx.recorder.event('world-unregistered', { host, n, first });
    if (first.length !== n) return fail('unregistered not flagged', { host, n, first });
    recordWorldEvents([{ event: 'world-actor', at: at(1).toISOString(), by: 'TC', actor: { id: first[0]!, kind: 'process', mode: 'owner', registered: true, owner: 'TC' } }], worldLedger(ctx));
    runSweep(simSources({ [host]: ok(probeText(ps)) }), at(2), { path: worldLedger(ctx) });
    const v = view(ctx, at(2));
    const after = anomaliesOf(v).filter(a => a.kind === 'unregistered').length;
    const state = v.actors.find(a => a.id === first[0])!.state;
    if (state === 'live' && after === n - 1) return { ok: true };
    return fail('registration did not clear the anomaly', { state, after, expected: n - 1 });
  },
};

/** WORLD-ZOMBIE — a watcher beating every k minutes is live; past 2k minutes without a beat it is zombie; one new beat revives it. */
const zombie: SimWorldScenario = {
  id: 'WORLD-ZOMBIE', title: 'a heartbeat that lapses past its SLA turns zombie; one new beat revives it (retire never)',
  async run(ctx) {
    const every = between(ctx, 1, 10); const name = `w${between(ctx, 1, 99)}`;
    const beats: BeatLike[] = [{ name, at: at(0).toISOString(), everyMin: every }];
    runSweep(simSources({}, { beats }), at(0), { path: worldLedger(ctx) });
    const s0 = view(ctx, at(0)).actors.find(a => a.id === `watcher:${name}`)?.state;
    const lapse = 2 * every + 1;
    runSweep(simSources({}, { beats }), at(lapse), { path: worldLedger(ctx) });
    const s1 = view(ctx, at(lapse)).actors.find(a => a.id === `watcher:${name}`)?.state;
    beats.push({ name, at: at(lapse + 1).toISOString(), everyMin: every });
    runSweep(simSources({}, { beats }), at(lapse + 1), { path: worldLedger(ctx) });
    const s2 = view(ctx, at(lapse + 1)).actors.find(a => a.id === `watcher:${name}`)?.state;
    ctx.recorder.event('world-zombie', { every, lapse, states: [s0, s1, s2] });
    if (s0 === 'live' && s1 === 'zombie' && s2 === 'live') return { ok: true };
    return fail('heartbeat judgement wrong', { every, states: [s0, s1, s2], expected: ['live', 'zombie', 'live'] });
  },
};

/** WORLD-UNREACHABLE — a host stops answering: its rows keep their presence (no false zombies), the host is an anomaly, and recovers when it answers. */
const unreachable: SimWorldScenario = {
  id: 'WORLD-UNREACHABLE', title: 'an unreachable host keeps its rows and is itself an anomaly until it answers again',
  async run(ctx) {
    const host = pick(ctx, HOSTS); const label = `com.elanous.job${between(ctx, 1, 50)}`;
    const ld = [`${between(ctx, 100, 999)}\t0\t${label}`];
    runSweep(simSources({ [host]: ok(probeText([], ld)) }), at(0), { path: worldLedger(ctx) });
    const id = `launchd:${label}@${host}`;
    recordWorldEvents([{ event: 'world-actor', at: at(0).toISOString(), by: 'RES', actor: { id, kind: 'launchd', mode: 'owner', registered: true, owner: 'RES' } }], worldLedger(ctx));
    runSweep(simSources({ [host]: { ok: false, stdout: '', error: 'ssh: connect timed out' } }), at(15), { path: worldLedger(ctx) });
    const down = view(ctx, at(15));
    const row = down.actors.find(a => a.id === id)!;
    const flags = anomaliesOf(down).map(a => `${a.kind}:${a.id}`);
    const line = worldDigest(down, at(15)).line;
    runSweep(simSources({ [host]: ok(probeText([], ld)) }), at(30), { path: worldLedger(ctx) });
    const back = anomaliesOf(view(ctx, at(30))).map(a => a.kind);
    ctx.recorder.event('world-unreachable', { host, present: row.present, state: row.state, flags, back });
    if (row.present && row.state === 'live' && flags.includes(`unreachable:host:${host}`) && line.includes(`unreachable ${host}`) && !back.includes('unreachable')) return { ok: true };
    return fail('unreachable host handled wrong', { present: row.present, state: row.state, flags, line, back });
  },
};

/** WORLD-QUIET — a sweep where nothing changed writes one line per scope and no declarations (the lease ledger stays small). */
const quiet: SimWorldScenario = {
  id: 'WORLD-QUIET', title: 'a quiet re-sweep writes only one sweep line per scope — no declarations',
  async run(ctx) {
    const hosts = HOSTS.slice(0, between(ctx, 1, HOSTS.length));
    const probes = Object.fromEntries(hosts.map((h, i) => [h, ok(probeText([`  ${700 + i} 03:00:00 /bun /x/src/els/holder-main.ts --state-root /tmp/u${i} --pane p`], [`${800 + i}\t0\tcom.elanous.r${i}`]))]));
    runSweep(simSources(probes), at(0), { path: worldLedger(ctx) });
    const before = readResourceLedger(worldLedger(ctx)).length;
    const r = runSweep(simSources(probes), at(15), { path: worldLedger(ctx) });
    const added = readResourceLedger(worldLedger(ctx)).length - before;
    ctx.recorder.event('world-quiet', { hosts: hosts.length, added, declared: r.scopes.map(s => s.declared) });
    if (added === hosts.length + 1 && r.scopes.every(s => s.declared === 0)) return { ok: true };
    return fail('quiet sweep wrote more than one line per scope', { scopes: hosts.length + 1, added, declared: r.scopes.map(s => s.declared) });
  },
};

/** WORLD-CONTROL — OP pauses then resumes an elanous launchd job through the ledger: each act audited with its undo,
 *  the fold shows off → live; an unauthorised seat is refused and a failing command is recorded as failed — neither moves state. */
const control: SimWorldScenario = {
  id: 'WORLD-CONTROL', title: 'pause/resume an elanous launchd job through the ledger — audited, reversible; refusal and failure change nothing',
  async run(ctx) {
    const host = pick(ctx, HOSTS); const label = `com.elanous.tm${between(ctx, 1, 50)}`;
    const plist = `/Users/u/Library/LaunchAgents/${label}.plist`;
    runSweep(simSources({ [host]: ok(probeText([], [`${between(ctx, 100, 999)}\t0\t${label}`], [`${label}\t15\t\t${plist}`])) }), at(0), { path: worldLedger(ctx) });
    const id = `launchd:${label}@${host}`;
    recordWorldEvents([{ event: 'world-actor', at: at(0).toISOString(), by: 'TC', actor: { id, kind: 'launchd', mode: 'owner', registered: true, owner: 'TC' } }], worldLedger(ctx));
    const calls: string[] = [];
    const run: ControlRunner = (argv, h) => { calls.push(`${h ?? 'local'}: ${argv.join(' ')}`); return { ok: true, output: '' }; };
    const act = (by: string, action: 'pause' | 'resume', min: number, r: ControlRunner = run) => {
      const a = view(ctx, at(min)).actors.find(x => x.id === id);
      const out = controlActor(a, id, action, { by, reason: `sim ${action}`, localHost: 'mshq', uid: 501, now: at(min), run: r });
      recordWorldEvents(out.lines, worldLedger(ctx));
      return { result: out.result, state: view(ctx, at(min)).actors.find(x => x.id === id)!.state };
    };
    const refused = act('MK', 'pause', 1);
    const failed = act('OP', 'pause', 2, () => ({ ok: false, output: 'Boot-out failed: 5: Input/output error' }));
    const paused = act('OP', 'pause', 3);
    const resumed = act('loop:guardian', 'resume', 4);
    const audit = readResourceLedger(worldLedger(ctx)).filter(e => e.event === 'world-control').map(e => e.event === 'world-control' ? `${e.by}:${e.action}:${e.result}${e.undo ? ':undo' : ''}` : '');
    ctx.recorder.event('world-control', { host, refused, failed, paused, resumed, calls, audit });
    const want = [`${host}: launchctl bootout gui/501/${label}`, `${host}: launchctl bootstrap gui/501 ${plist}`];
    if (refused.result === 'refused' && refused.state === 'live' && failed.result === 'failed' && failed.state === 'live'
      && paused.state === 'off' && resumed.state === 'live' && JSON.stringify(calls) === JSON.stringify(want)
      && JSON.stringify(audit) === JSON.stringify(['MK:pause:refused', 'OP:pause:failed', 'OP:pause:applied:undo', 'loop:guardian:resume:applied:undo'])) return { ok: true };
    return fail('control not audited/reversible', { refused, failed, paused, resumed, calls, want, audit });
  },
};

/** WORLD-AUTOREG — a cron line made through the schedule CRUD registers itself; the next sweep finds it live, not unregistered. */
const autoreg: SimWorldScenario = {
  id: 'WORLD-AUTOREG', title: 'a cron line made by the schedule CRUD arrives registered — the sweep shows it live, owned by the calling seat',
  async run(ctx) {
    const seat = pick(ctx, ['TC', 'UX', 'JUD', 'MK'] as const);
    const cron = `${between(ctx, 0, 59)} * * * *`; const command = `/bin/sh /x/tools/job${between(ctx, 1, 99)}.sh`;
    const { cronEntryId } = await import('../../../domains/schedule-registry.js');
    const scheduleId = cronEntryId(cron, command);
    registerCronQuietly({ scheduleId, cron, name: 'job', command }, { path: worldLedger(ctx), now: at(0), host: 'mshq', env: { ELANOUS_TRACK: seat } });
    const text = ['@@LAUNCHCTL', '@@PLIST', '@@CRON', `${cron} ${command}`, '@@PS', '@@END'].join('\n');
    runSweep(simSources({ mshq: ok(text) }), at(1), { path: worldLedger(ctx) });
    const v = view(ctx, at(1));
    const row = v.actors.find(a => a.id === `cron:${scheduleId}@mshq`);
    const unreg = anomaliesOf(v).filter(a => a.kind === 'unregistered').length;
    ctx.recorder.event('world-autoreg', { seat, scheduleId, state: row?.state, owner: row?.owner, unreg });
    if (row?.state === 'live' && row.owner === seat && row.registered && unreg === 0) return { ok: true };
    return fail('auto-registered cron not live', { row: row ? { state: row.state, owner: row.owner, registered: row.registered } : null, unreg });
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [unregistered, zombie, unreachable, quiet, control, autoreg];
