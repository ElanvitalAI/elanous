/**
 * Command nodes for the RES graphs (graphs/triggers/res-ready-pool · res-burst-lease · res-reservation).
 * Run by the graph runner as `cmd:` recipes; context from $ELANOUS_GRAPH_CONTEXT (same shape as trigger-nodes.ts).
 *
 * Machines are touched ONLY through one actuator seam: `$ELANOUS_RES_ACTUATOR <step> <host> <leaseId>` (default
 * scripts/res/res-actuator.sh → cloud-vm.sh with the cost ledger · ssh sanitize · rail-catchup.py · codex mirror push ·
 * pregate.py --light · inflight count). The sim world and the test universe swap the actuator for a fake shim.
 * Stage ≠ live never calls the actuator and never writes pool state: it writes a shadow receipt (what it would do).
 *
 * Run-scoped state (which host/lease this run is about) lives in `{root}/runs/<runId>.json`, written by the pick/route
 * node and read by the step nodes. Every node prints one JSON line `{ outcome, ... }`.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BURST_HOSTS, DRAIN_GRACE_MIN, READY_MAX_AGE_DAYS, dueLeases, isReady, issuePermit, loadLeases, markReady, receipt, registerBurstHost,
  releasePhase, resRoot, revokePermit, saveLeases, spentUsd, staleHosts, syncReservation, unregisterBurstHost, updateLease, writeBoard, type Lease,
} from './burst.js';

export interface NodeContext {
  graphId?: string; runId?: string;
  input?: { window?: string; stage?: string; reason?: string; vars?: { stateRoot?: string; seatState?: string }; shadowDir?: string };
  nodeInput?: Record<string, unknown>;
}
export interface NodeDeps {
  now?: () => Date;
  actuate?: (step: string, host: string, leaseId: string) => { status: number | null; stdout: string; stderr: string };
}
type Out = Record<string, unknown> & { outcome: string };

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ACTUATOR = join(HERE, '..', '..', 'scripts', 'res', 'res-actuator.sh');
/** Per-step actuator timeout (catchup = rail ≤ 25 min + ssh wait). */
const STEP_TIMEOUT_MS: Record<string, number> = { start: 600_000, stop: 600_000, sanitize: 300_000, catchup: 1_900_000, auth: 300_000, smoke: 2_700_000, inflight: 60_000 };

function seatState(ctx: NodeContext): string { return ctx.input?.vars?.seatState ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state'); }
function stateRoot(ctx: NodeContext): string { return ctx.input?.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? process.cwd(); }
function root(ctx: NodeContext): string { const r = ctx.nodeInput?.root; return typeof r === 'string' ? r.replaceAll('{seatState}', seatState(ctx)) : resRoot(seatState(ctx)); }
const live = (ctx: NodeContext) => ctx.input?.stage === 'live';

function runFile(ctx: NodeContext): string { return join(root(ctx), 'runs', `${(ctx.runId ?? 'manual').replace(/[^\w.-]/g, '_')}.json`); }
interface RunRec { host: string; leaseId: string; purpose: 'ready-pool' | 'lease'; drainWhy?: string }
function saveRun(ctx: NodeContext, rec: RunRec): void { mkdirSync(dirname(runFile(ctx)), { recursive: true }); writeFileSync(runFile(ctx), `${JSON.stringify(rec)}\n`); }
function loadRun(ctx: NodeContext): RunRec {
  const p = runFile(ctx);
  if (!existsSync(p)) throw new Error(`no run record ${p} (pick/route node did not run)`);
  return JSON.parse(readFileSync(p, 'utf8')) as RunRec;
}

function shadow(ctx: NodeContext, would: Record<string, unknown>, now: Date): Out {
  const dir = ctx.input?.shadowDir ?? join(stateRoot(ctx), 'loops', 'shadow', ctx.graphId ?? 'res');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${(ctx.input?.window ?? 'manual').replace(/[^\w.-]/g, '_')}.json`);
  writeFileSync(file, `${JSON.stringify({ would, runId: ctx.runId, at: now.toISOString() })}\n`);
  return { outcome: 'shadow', shadow: true, receipt: file, would };
}

function actuate(deps: NodeDeps, step: string, host: string, leaseId: string) {
  if (deps.actuate) return deps.actuate(step, host, leaseId);
  const act = process.env.ELANOUS_RES_ACTUATOR || DEFAULT_ACTUATOR;
  const r = spawnSync(act, [step, host, leaseId], { encoding: 'utf8', timeout: STEP_TIMEOUT_MS[step] ?? 600_000 });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? (r.error ? String(r.error) : '')) };
}

function ledgerRate(host: string, seat: string): number | null {
  // cloud-vm.sh map → type, cloud-rates.tsv → usd/hour. Unknown = null (no budget enforcement, never invented).
  try {
    const map = spawnSync(join(seat, 'OP', 'tools', 'cloud-vm.sh'), ['map'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
    const type = map.split('\n').map(l => l.split('\t')).find(c => c[0] === host)?.[4];
    const rates = readFileSync(join(seat, 'OP', 'cloud-rates.tsv'), 'utf8').split('\n').map(l => l.split('\t'));
    const usd = Number(rates.find(c => c[0] === 'vm' && c[1] === type)?.[4]);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch { return null; }
}

// ── ready pool ───────────────────────────────────────────────────────────────
export function readyPick(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx);
  const hosts = Array.isArray(ctx.nodeInput?.hosts) ? ctx.nodeInput!.hosts as string[] : [...BURST_HOSTS];
  const maxAge = typeof ctx.nodeInput?.max_age_days === 'number' ? ctx.nodeInput.max_age_days : READY_MAX_AGE_DAYS;
  const stale = staleHosts(r, hosts, maxAge, now);
  if (!stale.length) return { outcome: 'none', evidence: 'no stale burst host' };
  const pick = stale[0]!;
  if (!live(ctx)) return shadow(ctx, { readyPool: pick.host, why: pick.why, steps: ['start', 'sanitize', 'catchup', 'auth', 'smoke', 'mark', 'stop'] }, now);
  // The ready run holds an internal 90-minute lease: one permit/budget/drain model, and a crashed run is drained at ttl.
  const ttlMin = 90;
  const lease: Lease = { id: `R-${pick.host}-${now.toISOString().replace(/[-:]/g, '').slice(0, 13)}`, host: pick.host, ttlMin, budgetUsd: null,
    reason: `ready-pool: ${pick.why}`, requester: 'res-ready-pool', state: 'active', requestedAt: now.toISOString(), startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + ttlMin * 60_000).toISOString(), ratePerHourUsd: ledgerRate(pick.host, seatState(ctx)) };
  saveLeases(r, [...loadLeases(r), lease]);
  saveRun(ctx, { host: pick.host, leaseId: lease.id, purpose: 'ready-pool' });
  receipt(r, { kind: 'ready-run', lease: lease.id, host: pick.host, why: pick.why }, now);
  return { outcome: 'picked', host: pick.host, lease: lease.id, why: pick.why };
}

/** One actuator step for this run's host. `catchup` first issues the graph's rail permit (no hand-written file). */
export function step(ctx: NodeContext, name: string, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx); const run = loadRun(ctx);
  if (name === 'catchup') {
    const lease = loadLeases(r).find(l => l.id === run.leaseId);
    if (!lease) return { outcome: 'fail', error: `lease ${run.leaseId} vanished` };
    issuePermit(r, lease, ctx.graphId ?? 'res');
  }
  const res = actuate(deps, name, run.host, run.leaseId);
  const tail = (res.stdout.trim().split('\n').at(-1) ?? '').slice(0, 300);
  receipt(r, { kind: `step-${name}`, host: run.host, lease: run.leaseId, exit: res.status, tail }, now);
  if (res.status !== 0) return { outcome: 'fail', step: name, host: run.host, exit: res.status, error: (res.stderr.trim() || tail).slice(-400) };
  return { outcome: 'ok', step: name, host: run.host, tail };
}

export function readyMark(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const run = loadRun(ctx);
  markReady(root(ctx), run.host, 'ready', `graph ${ctx.graphId} run ${ctx.runId} · start→sanitize→catchup→auth→smoke ok`, now);
  // Golden image hook: TODO actuator — when `image: true` and the actuator implements `image`, snapshot after ready.
  if (ctx.nodeInput?.image === true) {
    const res = actuate(deps, 'image', run.host, run.leaseId);
    receipt(root(ctx), { kind: 'image', host: run.host, exit: res.status, note: res.status === 0 ? 'snapshot requested' : 'image actuator not wired (TODO)' }, now);
  }
  return { outcome: 'ok', host: run.host };
}

/** A failed ready/activation run: mark failed, card-worthy evidence, and always stop the host it started. */
export function runFail(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx); const run = loadRun(ctx);
  markReady(r, run.host, 'failed', `graph ${ctx.graphId} run ${ctx.runId} failed (see receipts.jsonl)`, now);
  const stopped = stopLease(ctx, run, 'failed', deps, now);
  return { outcome: 'ok', host: run.host, stopped };
}

function stopLease(ctx: NodeContext, run: RunRec, final: 'stopped' | 'failed', deps: NodeDeps, now: Date): boolean {
  const r = root(ctx);
  const isLocal = loadLeases(r).find(l => l.id === run.leaseId)?.local === true;
  const res = isLocal ? { status: 0, stdout: 'local lease: no stop', stderr: '' } : actuate(deps, 'stop', run.host, run.leaseId);
  revokePermit(r, run.host); unregisterBurstHost(r, run.host);
  const lease = loadLeases(r).find(l => l.id === run.leaseId);
  const spent = lease ? spentUsd(lease, now) : null;
  if (lease) updateLease(r, lease.id, { state: res.status === 0 ? final : 'draining', ...(res.status === 0 ? { stoppedAt: now.toISOString() } : { note: `stop exit ${res.status}` }) });
  receipt(r, { kind: res.status === 0 ? 'lease-stopped' : 'lease-stop-failed', lease: run.leaseId, host: run.host, exit: res.status,
    spentUsd: spent === null ? null : Math.round(spent * 100) / 100, final }, now);
  writeBoard(r, now);
  return res.status === 0;
}

export function runStop(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const run = loadRun(ctx);
  return stopLease(ctx, run, 'stopped', deps, now) ? { outcome: 'ok', host: run.host } : { outcome: 'fail', host: run.host, error: 'stop failed; lease left draining (re-fires)' };
}

// ── burst lease ──────────────────────────────────────────────────────────────
export function leaseRoute(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx);
  const due = dueLeases(r, now);
  if (!due.length) return { outcome: 'none' };
  const d = due[0]!;
  if (!live(ctx)) { const s = shadow(ctx, { action: d.action, lease: d.lease.id, host: d.lease.host, ...(d.action === 'drain' ? { why: d.why } : {}) }, now); return { ...s, outcome: 'none' }; }
  saveRun(ctx, { host: d.lease.host, leaseId: d.lease.id, purpose: 'lease', ...(d.action === 'drain' ? { drainWhy: d.why } : {}) });
  return { outcome: d.action, lease: d.lease.id, host: d.lease.host, ...(d.action === 'drain' ? { why: d.why } : {}) };
}

export function leaseStart(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx); const run = loadRun(ctx);
  const lease = loadLeases(r).find(l => l.id === run.leaseId);
  if (!lease) return { outcome: 'fail', error: `lease ${run.leaseId} vanished` };
  const res = lease.local ? { status: 0, stdout: 'local lease: no start', stderr: '' } : actuate(deps, 'start', run.host, run.leaseId);
  receipt(r, { kind: 'step-start', host: run.host, lease: lease.id, exit: res.status }, now);
  if (res.status !== 0) { updateLease(r, lease.id, { state: 'failed', note: `start exit ${res.status}` }); return { outcome: 'fail', error: res.stderr.slice(-300) }; }
  const started = updateLease(r, lease.id, { state: 'active', startedAt: now.toISOString(), endsAt: new Date(now.getTime() + lease.ttlMin * 60_000).toISOString(),
    ratePerHourUsd: lease.ratePerHourUsd ?? ledgerRate(run.host, seatState(ctx)) });
  issuePermit(r, started, ctx.graphId ?? 'res-burst-lease');
  return { outcome: lease.local || isReady(r, run.host, READY_MAX_AGE_DAYS, now) ? 'ready' : 'stale', host: run.host, endsAt: started.endsAt };
}

export function leaseRegister(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx); const run = loadRun(ctx);
  const lease = loadLeases(r).find(l => l.id === run.leaseId);
  if (!lease) return { outcome: 'fail', error: `lease ${run.leaseId} vanished` };
  const slots = typeof ctx.nodeInput?.pregate_slots === 'number' ? ctx.nodeInput.pregate_slots : 2;
  registerBurstHost(r, lease, slots);
  receipt(r, { kind: 'lease-registered', lease: lease.id, host: lease.host, pregateSlots: slots, until: lease.endsAt }, now);
  writeBoard(r, now);
  return { outcome: 'ok', host: lease.host, until: lease.endsAt };
}

/** Drain: no new pregates (unregister), wait for inflight ones until ttl + grace (budget: no wait), then stop. */
export function leaseDrain(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date(); const r = root(ctx); const run = loadRun(ctx);
  const lease = loadLeases(r).find(l => l.id === run.leaseId);
  if (!lease) return { outcome: 'fail', error: `lease ${run.leaseId} vanished` };
  if (lease.state !== 'draining') { updateLease(r, lease.id, { state: 'draining' }); receipt(r, { kind: 'lease-draining', lease: lease.id, why: run.drainWhy }, now); }
  unregisterBurstHost(r, lease.host);
  const inf = actuate(deps, 'inflight', lease.host, lease.id);
  const inflight = inf.status === 0 ? Number.parseInt(inf.stdout.trim().split('\n').at(-1) ?? '0', 10) || 0 : 0;
  const hardEnd = Date.parse(lease.endsAt ?? now.toISOString()) + DRAIN_GRACE_MIN * 60_000;
  if (inflight > 0 && run.drainWhy !== 'budget' && now.getTime() < hardEnd) {
    return { outcome: 'wait', host: lease.host, inflight, stopBy: new Date(hardEnd).toISOString() };
  }
  return { outcome: 'stop', host: lease.host, inflight };
}

// ── reservation ──────────────────────────────────────────────────────────────
export function reservationSync(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date();
  if (!live(ctx)) {
    return { ...shadow(ctx, { reservation: releasePhase(stateRoot(ctx), now) }, now), outcome: 'ok' };
  }
  const { change, reservation } = syncReservation(root(ctx), stateRoot(ctx), now);
  return { outcome: 'ok', change, active: reservation.active, phase: reservation.phase, version: reservation.version };
}

/** Goal line: every successful path ends here so the registry's ledger-line goal sees this window. */
export function windowDone(ctx: NodeContext, deps: NodeDeps = {}): Out {
  const now = deps.now?.() ?? new Date();
  const ledger = typeof ctx.nodeInput?.ledger === 'string' ? ctx.nodeInput.ledger.replaceAll('{stateRoot}', stateRoot(ctx))
    : join(stateRoot(ctx), 'loops', `${ctx.graphId ?? 'res'}.jsonl`);
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify({ window: ctx.input?.window ?? 'manual', graph: ctx.graphId, runId: ctx.runId, stage: ctx.input?.stage ?? 'manual', at: now.toISOString() })}\n`);
  return { outcome: 'ok', ledger };
}

export function runNode(command: string, ctx: NodeContext, deps: NodeDeps = {}): Out {
  switch (command) {
    case 'window-done': return windowDone(ctx, deps);
    case 'ready-pick': return readyPick(ctx, deps);
    case 'ready-mark': return readyMark(ctx, deps);
    case 'run-fail': return runFail(ctx, deps);
    case 'run-stop': return runStop(ctx, deps);
    case 'lease-route': return leaseRoute(ctx, deps);
    case 'lease-start': return leaseStart(ctx, deps);
    case 'lease-register': return leaseRegister(ctx, deps);
    case 'lease-drain': return leaseDrain(ctx, deps);
    case 'reservation-sync': return reservationSync(ctx, deps);
    default:
      if (command.startsWith('step:')) return step(ctx, command.slice(5), deps);
      return { outcome: 'error', error: `unknown res node: ${command}` };
  }
}

if (import.meta.main) {
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    const ctx = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as NodeContext : {};
    console.log(JSON.stringify(runNode(process.argv[2] ?? '', ctx)));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
