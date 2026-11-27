// WORLD-REGISTRY discovery sweep — LLM 0 · per host · writes deltas into the lease ledger (world-actor ⊕ world-sweep lines).
// Sources: one probe script per host (launchctl · LaunchAgents plists + log mtime · crontab · elanous processes), run
//   locally with `sh -s` and on remote hosts over `ssh <host> sh -s` (same text, same parser); host-registry (hosts);
//   `listAllLoops` (graph loops); watch beats; `els pane list` (panes on all registered hosts).
// Faces: observe = one `world-sweep` line per scope (ok · error · appeared · gone · moved beats · counts) ⊕ debug
//        `world-registry sweep-scope` · judge = world-registry.judgeActor in the fold ·
//        heal = every reader fails open (a dead source is a failed scope, never a throw); a failed scope keeps its rows'
//        last presence (no false zombies from a network blip) and is itself an `unreachable` anomaly.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { debug, redactSecretText } from '../debug/log.js';
import { cronEntryId, parseCronLine, parseDisabledCronLine, scriptName, unwrapCronCommand } from '../domains/schedule-registry.js';
import { readResourceLedger, recordWorldEvents, resourceLedgerPath } from './resource-ledger.js';
import type { WorldActorFields, WorldLedgerEvent } from './world-ledger-events.js';
import { applyActor, declarationChanges, foldWorld, HOST_SWEPT_KINDS, REGISTRIES_SCOPE } from './world-registry.js';
import type { WorldActor } from './world-types.js';


export const PROBE_SCRIPT = [
  'echo "@@LAUNCHCTL"',
  'launchctl list 2>/dev/null | grep -i elanous',
  'echo "@@PLIST"',
  'for f in "$HOME"/Library/LaunchAgents/*.plist; do',
  '  case "$f" in *elanous*) ;; *) continue ;; esac',
  '  l=$(plutil -extract Label raw "$f" 2>/dev/null); o=$(plutil -extract StandardOutPath raw "$f" 2>/dev/null)',
  '  i=$(plutil -extract StartInterval raw "$f" 2>/dev/null); m=""',
  '  if [ -n "$o" ] && [ -f "$o" ]; then m=$(stat -f %m "$o" 2>/dev/null); fi',
  '  printf "%s\\t%s\\t%s\\t%s\\n" "$l" "$i" "$m" "$f"',
  'done',
  'echo "@@CRON"',
  'crontab -l 2>/dev/null',
  'echo "@@PS"',
  'ps -axo pid=,etime=,command= 2>/dev/null | grep -E "elanous|holder-main" | grep -v grep',
  'echo "@@END"',
].join('\n');

export interface LaunchdJob { label: string; pid: number | null; lastExit: number | null }
export interface PlistInfo { label: string; intervalSec: number | null; logMtimeSec: number | null; file: string }
export interface CronLine { cron: string; command: string; enabled: boolean }
export interface ProcessLine { pid: number; elapsedSec: number; command: string }
export interface ProbeResult { launchd: LaunchdJob[]; plists: PlistInfo[]; cron: CronLine[]; processes: ProcessLine[]; complete: boolean }

function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^@@([A-Z]+)\s*$/.exec(line);
    if (m) { cur = m[1]!; out.set(cur, []); continue; }
    if (cur) out.get(cur)!.push(line);
  }
  return out;
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/** Pure: probe output → typed rows. `complete` = the script ran to its end marker. */
export function parseProbe(text: string): ProbeResult {
  const s = sections(text);
  const launchd: LaunchdJob[] = [];
  for (const line of s.get('LAUNCHCTL') ?? []) {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) continue;
    const pid = /^\d+$/.test(p[0]!) ? Number(p[0]) : null;
    const lastExit = /^-?\d+$/.test(p[1]!) ? Number(p[1]) : null;
    launchd.push({ label: p.slice(2).join(' '), pid, lastExit });
  }
  const plists: PlistInfo[] = [];
  for (const line of s.get('PLIST') ?? []) {
    const [label, iv, mt, file] = line.split('\t');
    if (!label || !file) continue;
    plists.push({ label, intervalSec: iv && /^\d+$/.test(iv) ? Number(iv) : null, logMtimeSec: mt && /^\d+$/.test(mt) ? Number(mt) : null, file });
  }
  const cron: CronLine[] = [];
  for (const line of s.get('CRON') ?? []) {
    const on = parseCronLine(line);
    if (on) { cron.push({ ...on, enabled: true }); continue; }
    const off = parseDisabledCronLine(line);
    if (off) cron.push({ ...off, enabled: false });
  }
  const processes: ProcessLine[] = [];
  for (const line of s.get('PS') ?? []) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m) processes.push({ pid: Number(m[1]), elapsedSec: parseEtime(m[2]!), command: m[3]! });
  }
  return { launchd, plists, cron, processes, complete: s.has('END') };
}

/** Processes younger than this are CLI invocations, not actors. */
export const PROCESS_MIN_AGE_SEC = 600;


const short = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** The isolated state dir a process runs in (test universe), or null for the operating universe. */
export function universeDirOf(command: string): string | null {
  const m = /--(?:state-root|config-dir|test-state-dir)(?:=|\s+)(\S+)/.exec(command);
  if (m) return m[1]!;
  const t = /(\S*\.elanous-test\S*)/.exec(command);
  return t ? t[1]!.replace(/\/(?:nexus|logs|state)(?:\/.*)?$/, '') : null;
}

/** Stable signature of a long-running process: version dirs and pids stripped. */
export function processSignature(command: string): string {
  return command.replace(/\/versions\/[^/\s]+\//g, '/versions/*/').replace(/\b\d{4,}\b/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** One observation: static declaration (written only when it changes) ⊕ presence ⊕ a heartbeat reading from `beatSource`. */
export interface Observation { decl: WorldActorFields; present: boolean; beat?: { source: string; at: string } }

const D = (decl: Omit<WorldActorFields, 'mode'>): WorldActorFields => ({ mode: 'discover', ...decl });

/** Pure: one host's probe → observations. Volatile facts (pids · ages) stay out of declarations so quiet sweeps stay tiny. */
export function observeProbe(host: string, probe: ProbeResult, now: Date): Observation[] {
  const at = now.toISOString();
  const out: Observation[] = [];
  const plistBy = new Map(probe.plists.map(p => [p.label, p]));
  const loaded = new Set<string>();
  for (const j of probe.launchd) {
    loaded.add(j.label);
    const pl = plistBy.get(j.label);
    const logAt = pl?.logMtimeSec ? new Date(pl.logMtimeSec * 1000).toISOString() : null;
    out.push({
      decl: D({ id: `launchd:${j.label}@${host}`, kind: 'launchd', host,
        wake: pl?.intervalSec ? `every ${pl.intervalSec}s` : j.pid !== null ? 'always (resident)' : null,
        heartbeatSource: j.pid !== null ? 'seen' : logAt ? 'log' : null, ...(pl ? { meta: { plist: pl.file } } : {}) }),
      present: true,
      ...(j.pid !== null ? { beat: { source: 'seen', at } } : logAt ? { beat: { source: 'log', at: logAt } } : {}),
    });
  }
  for (const pl of probe.plists) {
    if (loaded.has(pl.label)) continue;
    // A plist on disk that launchd has not loaded: present as a file, never runs.
    out.push({ decl: D({ id: `launchd:${pl.label}@${host}`, kind: 'launchd', host, meta: { plist: pl.file, loaded: false } }), present: true });
  }
  for (const c of probe.cron) {
    const effective = unwrapCronCommand(c.command);
    const shown = redactSecretText(effective).slice(0, 400); // the id hashes the raw line; the ledger keeps only the redacted text
    out.push({ decl: D({ id: `cron:${cronEntryId(c.cron, effective)}@${host}`, kind: 'cron', host, wake: c.cron, purpose: scriptName(c.command),
      meta: { command: shown } }), present: c.enabled });
  }
  const universes = new Map<string, ProcessLine[]>();
  for (const p of probe.processes) {
    const dir = universeDirOf(p.command);
    if (dir) { const l = universes.get(dir) ?? []; l.push(p); universes.set(dir, l); continue; }
    if (p.elapsedSec < PROCESS_MIN_AGE_SEC) continue;
    const sig = redactSecretText(processSignature(p.command));
    out.push({ decl: D({ id: `process:${short(sig)}@${host}`, kind: 'process', host, heartbeatSource: 'seen', purpose: sig.slice(0, 160), meta: { signature: sig } }),
      present: true, beat: { source: 'seen', at } });
  }
  for (const [dir, procs] of universes) {
    out.push({ decl: D({ id: `test-universe:${short(dir)}@${host}`, kind: 'test-universe', host, heartbeatSource: 'seen', purpose: `isolated universe ${dir}`,
      meta: { dir, processes: procs.length } }), present: true, beat: { source: 'seen', at } });
  }
  return out;
}

// ── registry-level sources (pure mappers) ────────────────────────────────────────────────────

export interface LoopLike { id: string; kind?: string; title?: string; owner?: string | null; purpose?: string | null; stage?: string | null; mode?: string | null; enabled: boolean; registered: boolean; cron?: string; wake?: string; lastRunAt?: string; expectEveryMinutes?: number; host?: string }

/** A graph loop is declared in the loop registry → registered by construction (its YAML is the registration). */
export function observeLoops(loops: readonly LoopLike[]): Observation[] {
  const out: Observation[] = [];
  for (const l of loops) {
    if (l.kind && l.kind !== 'graph' && l.kind !== 'orchestrator') continue; // cron-shell/seat rows come from the host crontab sweep
    const live = l.enabled && l.mode !== 'shadow' && l.stage !== 'shadow';
    const purpose = l.purpose ?? l.title;
    out.push({
      decl: { id: `loop:${l.id}`, kind: 'loop', mode: 'owner', registered: true, declaredState: !l.enabled ? 'off' : live ? 'live' : 'shadow',
        // Only facts the registry knows — a missing owner/purpose must not erase a seeded/registered one.
        ...(purpose ? { purpose } : {}), ...(l.owner ? { owner: l.owner } : {}), ...(l.cron ? { wake: l.cron } : {}),
        heartbeatSource: 'loop', slaMin: l.enabled && l.expectEveryMinutes ? l.expectEveryMinutes * 2 : null, ...(l.host ? { host: l.host } : {}),
        meta: { stage: l.stage ?? null, mode: l.mode ?? null, wakePath: l.wake ?? null } },
      present: true,
      ...(l.lastRunAt ? { beat: { source: 'loop', at: l.lastRunAt } } : {}),
    });
  }
  return out;
}

export interface BeatLike { name: string; at: string; everyMin: number }

/** Latest beat per name — the heartbeat for any actor whose source is `watch:<name>`. */
export function latestBeatAt(beats: readonly BeatLike[]): Map<string, BeatLike> {
  const m = new Map<string, BeatLike>();
  for (const b of beats) { const p = m.get(b.name); if (!p || Date.parse(b.at) > Date.parse(p.at)) m.set(b.name, b); }
  return m;
}

/** A watcher that beats is elanous-aware: its beat is its registration (it still needs an owner). */
export function observeBeats(beats: readonly BeatLike[]): Observation[] {
  return [...latestBeatAt(beats).values()].map(b => ({
    decl: { id: `watcher:${b.name}`, kind: 'watcher', mode: 'owner', registered: true, heartbeatSource: `watch:${b.name}`, slaMin: b.everyMin * 2, wake: `every ${b.everyMin}m` },
    present: true, beat: { source: `watch:${b.name}`, at: b.at },
  }));
}

export interface PaneLike { pane_id: string; workspace?: string; title?: string; host?: string; state?: string; cwd?: string }

/** els registers its panes itself (an elanous tool) → registered, owned by the workspace; keyed workspace/title so restarts keep the row. */
export function observePanes(panes: readonly PaneLike[]): Observation[] {
  return panes.map(p => ({
    decl: { id: `pane:${p.workspace ?? '?'}/${p.title ?? p.pane_id}@${p.host ?? '?'}`, kind: 'pane', mode: 'owner', registered: true, owner: p.workspace ?? null,
      host: p.host ?? null, heartbeatSource: 'seen', ...(p.title ? { purpose: p.title } : {}), ...(p.cwd ? { meta: { cwd: p.cwd } } : {}) },
    present: true,
  }));
}

export interface HostLike { host: string; aliases?: string[]; seat?: string; lastHeartbeatMs: number }

export function observeHosts(hosts: readonly HostLike[]): Observation[] {
  return hosts.map(h => ({
    decl: { id: `host:${h.host}`, kind: 'host', mode: 'owner', registered: true, host: h.host, owner: h.seat ?? 'RES',
      purpose: `machine ${h.host}${h.aliases?.length ? ` (${h.aliases.join(', ')})` : ''}`, heartbeatSource: 'host-registry', slaMin: 24 * 60 },
    present: true,
    ...(h.lastHeartbeatMs > 0 ? { beat: { source: 'host-registry', at: new Date(h.lastHeartbeatMs).toISOString() } } : {}),
  }));
}

/** Host keys are host-registry names (mshq · node-b …); els and ps report machine names — fold them onto the key. */
export function normalizeHost(name: string | undefined | null, hosts: readonly HostLike[]): string | null {
  if (!name) return null;
  const lc = name.toLowerCase(); const shortLc = lc.split('.')[0]!;
  const hit = hosts.find(h => h.host.toLowerCase() === lc || h.host.toLowerCase() === shortLc || (h.aliases ?? []).some(a => a.toLowerCase() === lc || a.toLowerCase() === shortLc));
  return hit?.host ?? name;
}

/** The host-registry key for this machine, else the short hostname. */
export function localHostKey(hosts: readonly HostLike[], machine: string = hostname()): string {
  return normalizeHost(machine, hosts) === machine ? machine.split('.')[0]! : normalizeHost(machine, hosts)!;
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────

export interface ProbeOutcome { ok: boolean; stdout: string; error: string | null }
export type ProbeRunner = (host: string, local: boolean) => ProbeOutcome;

export const defaultProbeRunner: ProbeRunner = (host, local) => {
  const r = local
    ? spawnSync('sh', ['-s'], { input: PROBE_SCRIPT, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
    : spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, 'sh -s'], { input: PROBE_SCRIPT, encoding: 'utf8', timeout: 25_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, stdout: '', error: r.error.message };
  const stdout = r.stdout ?? '';
  if (!stdout.includes('@@END')) return { ok: false, stdout, error: `probe incomplete (exit ${r.status ?? 'signal'}) ${(r.stderr ?? '').trim().slice(0, 200)}` };
  return { ok: true, stdout, error: null };
};

export interface SweepSources {
  localHost: string;
  /** Hosts to probe (local included). */
  hosts: readonly string[];
  probe: ProbeRunner;
  loops: () => LoopLike[];
  beats: () => BeatLike[];
  panes: () => PaneLike[];
  hostRecords: () => HostLike[];
}

export interface SweepReport { at: string; scopes: Array<{ scope: string; ok: boolean; error: string | null; seen: number; appeared: number; gone: number; declared: number }>; lines: number }

function tryRead<T>(name: string, f: () => T[]): { ok: boolean; rows: T[]; error: string | null } {
  try { return { ok: true, rows: f(), error: null }; } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    debug.log('world-registry', 'source-failed', { source: name, error });
    return { ok: false, rows: [], error: `${name}: ${error}` };
  }
}

/**
 * Pure: turn one scope's observations into ledger lines against the current fold.
 * `kinds` = which kinds this scope is authoritative for (absent ⇒ gone). Declarations are emitted only when they change;
 * beats only when they move past the folded heartbeat and come from the source the actor's (owner-chosen) heartbeat uses.
 */
export function scopeEvents(byId: Map<string, WorldActor>, scope: string, obs: readonly Observation[] | null, error: string | null,
  kinds: readonly string[], scopeHost: string | null, at: string, by: string): WorldLedgerEvent[] {
  if (!obs) return [{ event: 'world-sweep', at, by, scope, ok: false, ...(error ? { error: error.slice(0, 900) } : {}), appeared: [], gone: [], beats: {}, counts: {} }];
  const lines: WorldLedgerEvent[] = [];
  const appeared: string[] = []; const beats: Record<string, string> = {}; const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const o of obs) {
    const prev = byId.get(o.decl.id);
    if (declarationChanges(prev, o.decl)) lines.push({ event: 'world-actor', at, by, actor: o.decl });
    const after = applyActor(prev ? { ...prev, scope: null, registeredBy: null } : undefined, o.decl, at, by);
    counts[o.decl.kind] = (counts[o.decl.kind] ?? 0) + 1;
    if (o.present) { seen.add(o.decl.id); if (!prev?.present) appeared.push(o.decl.id); }
    if (o.beat && o.beat.source !== 'seen' && (after.heartbeatSource ?? o.beat.source) === o.beat.source
      && (!prev?.heartbeatAt || Date.parse(o.beat.at) > Date.parse(prev.heartbeatAt))) beats[o.decl.id] = o.beat.at;
  }
  const gone: string[] = [];
  for (const a of byId.values()) {
    if (!a.present || seen.has(a.id) || !kinds.includes(a.kind)) continue;
    if (scopeHost !== null && a.host !== scopeHost) continue;
    gone.push(a.id);
  }
  // A cron line commented out is still observed (present=false) — it went away from «running».
  for (const o of obs) if (!o.present && byId.get(o.decl.id)?.present && !gone.includes(o.decl.id)) gone.push(o.decl.id);
  lines.push({ event: 'world-sweep', at, by, scope, ok: true, appeared, gone, beats, counts });
  return lines;
}

/** Beats for actors whose owner chose `watch:<name>` (seeded supervisors, train-manager …). */
function watchBeats(byId: Map<string, WorldActor>, beats: readonly BeatLike[]): Record<string, string> {
  const latest = latestBeatAt(beats); const out: Record<string, string> = {};
  for (const a of byId.values()) {
    if (!a.heartbeatSource?.startsWith('watch:') || a.kind === 'watcher') continue;
    const b = latest.get(a.heartbeatSource.slice('watch:'.length));
    if (b && (!a.heartbeatAt || Date.parse(b.at) > Date.parse(a.heartbeatAt))) out[a.id] = b.at;
  }
  return out;
}

export function runSweep(src: SweepSources, now: Date, opts: { by?: string; path?: string } = {}): SweepReport {
  const at = now.toISOString(); const by = opts.by ?? 'loop:guardian'; const path = opts.path ?? resourceLedgerPath();
  const report: SweepReport = { at, scopes: [], lines: 0 };
  const commit = (scope: string, lines: WorldLedgerEvent[]) => {
    recordWorldEvents(lines, path);
    report.lines += lines.length;
    const sw = lines.find((l): l is Extract<WorldLedgerEvent, { event: 'world-sweep' }> => l.event === 'world-sweep')!;
    const entry = { scope, ok: sw.ok, error: sw.error ?? null, seen: Object.values(sw.counts).reduce((x, y) => x + y, 0), appeared: sw.appeared.length, gone: sw.gone.length, declared: lines.length - 1 };
    report.scopes.push(entry);
    debug.log('world-registry', 'sweep-scope', entry);
  };
  const view = () => new Map(foldWorld(readResourceLedger(path), now).actors.map(a => [a.id, a] as const));

  // Registries scope: host-registry · loops · watch beats · els panes (els answers for every registered host).
  const hosts = tryRead('hosts', src.hostRecords); const loops = tryRead('loops', src.loops);
  const beats = tryRead('beats', src.beats); const panes = tryRead('panes', src.panes);
  const paneRows = panes.rows.map(p => ({ ...p, host: normalizeHost(p.host, hosts.rows) ?? undefined }));
  const obs = [...observeHosts(hosts.rows), ...observeLoops(loops.rows), ...observeBeats(beats.rows), ...observePanes(paneRows)];
  const failed = [hosts, loops, beats, panes].filter(r => !r.ok).map(r => r.error).join(' · ');
  // A failed source must not mark its kinds gone: only kinds whose source answered are authoritative.
  const authoritative = [...(panes.ok ? ['pane'] : [])];
  let byId = view();
  const regLines = scopeEvents(byId, REGISTRIES_SCOPE, obs, null, authoritative, null, at, by);
  const sw = regLines[regLines.length - 1] as Extract<WorldLedgerEvent, { event: 'world-sweep' }>;
  if (failed) sw.error = failed.slice(0, 900);
  commit(REGISTRIES_SCOPE, regLines);

  for (const host of src.hosts) {
    let outcome: ProbeOutcome;
    try { outcome = src.probe(host, host === src.localHost); } catch (e) { outcome = { ok: false, stdout: '', error: e instanceof Error ? e.message : String(e) }; }
    byId = view();
    commit(host, outcome.ok
      ? scopeEvents(byId, host, observeProbe(host, parseProbe(outcome.stdout), now), null, HOST_SWEPT_KINDS, host, at, by)
      : scopeEvents(byId, host, null, outcome.error, HOST_SWEPT_KINDS, host, at, by));
  }
  // Owner-chosen watch beats for non-watcher actors ride one more registries line (only if any moved).
  const wb = watchBeats(view(), beats.rows);
  if (Object.keys(wb).length) commit(REGISTRIES_SCOPE, [{ event: 'world-sweep', at, by, scope: REGISTRIES_SCOPE, ok: true, appeared: [], gone: [], beats: wb, counts: {} }]);
  return report;
}
