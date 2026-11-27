/**
 * RELEASE-TRAFFIC (Cell: SCHEDULER-TO-GRAPH-RUNNER · CEO 11-25 23:5x «release-window traffic control through the graph
 * runner, not by hand»). Command node of graphs/triggers/release-traffic.yaml (`cmd:release-traffic-tick`).
 *
 * The trigger fires on the compound condition (T−2h ∧ rehearsal scheduled/started/passed/failed · publish-confirmed ·
 * lease/host facts · timeout); this node CONVERGES the pregate-slot policy to the phase the facts say, so a re-fire,
 * a duplicate fire or a restart mid-window is a no-op:
 *   reserve  (now ≥ min(cutAt − 2h, rehearsalAt − 15m), not published) → node-b slots 1 · aws1 slots 5 (absorb) ·
 *            absorb capacity checked; a missing live lease → `eln res lease request`-equivalent (planCapacity, local
 *            first; cloud only when RES policy budget already allows it, else a CEO card — never a paid start here)
 *   hold     T−0 through publish; publish slipping past publishAt + 30m → one card, hold until publishAt + 2h
 *   restore  publish confirmed → node-b back to its baseline (5 if the window was adopted) · update-all once (skipped when
 *            the release graph's own update-all step already ran) · aws1 back only if we changed it
 *   abort    release hard-stop + 30m, or publishAt + 2h without publish → restore + card
 * Adopts the current state (node-b = 1 / aws1 = 5 set by hand) instead of fighting it. At restore, a value changed by
 * hand since our write is LEFT and carded. Every change = one audit row with its undo command. Single-flight lock.
 *
 * 세 얼굴: 관측 = audit.jsonl + one JSON line per run + the registry fire log / 판단 근거 = release.* facts
 * (trigger-facts.ts) / 수복과 인계 = converge + undo rows + cards to the release-supervision owner (REL steward).
 */
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { elanousCliArgv, installedBin } from '../instance/cli-bin.js';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveFacts, type Facts } from '../loops/trigger-facts.js';

export const RESERVE: Record<string, number> = { 'node-b': 1, 'aws1': 5 };
/** Restore value when the window was adopted (baseline unknown) — CEO 11-25 «restore node-b=5». 'aws1': left as is. */
export const RESTORE_DEFAULT: Record<string, number> = { 'node-b': 5 };
export const RESERVE_LEAD_MIN = 120;
export const REHEARSAL_LEAD_MIN = 15;
export const SLIP_CARD_MIN = 30;
export const PUBLISH_TIMEOUT_MIN = 120;
export const ABORT_RESTORE_MIN = 30;
export const LOCK_STALE_MS = 10 * 60_000;
const ABSORB_HOST = 'aws1';
const RELEASE_HOST = 'node-b';

export type Phase = 'idle' | 'reserve' | 'restore' | 'abort';
export interface TrafficState {
  version: string; phase: Phase; adopted: string[];
  baseline: Record<string, number | null>; applied: Record<string, number>;
  cards: string[]; leaseRequested: boolean; updateAll: 'pending' | 'done' | 'skipped' | 'failed'; restoredAt?: string;
}
export interface TrafficDeps {
  root: string; live: boolean; now: () => Date; facts: () => Facts;
  getSlots: (host: string) => number | null;
  setSlots: (host: string, n: number) => boolean;
  hostUp: (host: string) => boolean;
  /** Ask RES for absorb capacity (local first). Returns a one-line outcome. */
  requestCapacity: (reason: string) => string;
  updateAll: () => boolean;
  card: (body: string, to: string) => void;
  owner: () => string;
}
export interface TickResult { outcome: 'ok' | 'busy' | 'fail'; phase: Phase; version: string | null; changes: string[]; cards: string[]; why: string }

const statePath = (root: string, v: string) => join(root, 'release-traffic', `${v}.json`);
const auditPath = (root: string) => join(root, 'release-traffic', 'audit.jsonl');

function writeJson(p: string, v: unknown): void {
  mkdirSync(join(p, '..'), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 1)}\n`); renameSync(tmp, p);
}
export function loadTrafficState(root: string, v: string): TrafficState | null {
  try { return JSON.parse(readFileSync(statePath(root, v), 'utf8')) as TrafficState; } catch { return null; }
}
export function readAudit(root: string): Array<Record<string, unknown>> {
  if (!existsSync(auditPath(root))) return [];
  return readFileSync(auditPath(root), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
}

/** Single-flight: O_EXCL lock; a lock older than LOCK_STALE_MS (crashed run) is broken. */
function lock(root: string, now: Date): (() => void) | null {
  const p = join(root, 'release-traffic', '.lock'); mkdirSync(join(root, 'release-traffic'), { recursive: true });
  try { if (existsSync(p) && Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS) unlinkSync(p); } catch { /* raced */ }
  try { closeSync(openSync(p, 'wx')); } catch { return null; }
  return () => { try { unlinkSync(p); } catch { /* gone */ } };
}

/** The phase the facts say. Pure. */
export function decidePhase(f: Facts, now: Date): { phase: Phase; why: string; slipCard: boolean } {
  const v = f['release.version']; const t = now.getTime();
  const ms = (k: string) => { const x = f[k]; return typeof x === 'string' ? Date.parse(x) : NaN; };
  if (typeof v !== 'string') return { phase: 'idle', why: 'no active release', slipCard: false };
  if (f['release.published'] === true) return { phase: 'restore', why: `published ${String(f['release.publishedAt'] ?? '')}`.trim(), slipCard: false };
  const cut = ms('release.cutAt'); const pub = ms('release.publishAt'); const reh = ms('release.rehearsalAt');
  if (f['release.aborted'] === true) {
    const at = ms('release.abortedAt');
    if (!Number.isFinite(at) || t >= at + ABORT_RESTORE_MIN * 60_000) return { phase: 'abort', why: `release hard-stopped ${String(f['release.abortedAt'])} + ${ABORT_RESTORE_MIN}m`, slipCard: false };
    return { phase: 'reserve', why: `hard-stopped ${String(f['release.abortedAt'])} — holding ${ABORT_RESTORE_MIN}m for a resume`, slipCard: false };
  }
  if (Number.isFinite(pub) && t >= pub + PUBLISH_TIMEOUT_MIN * 60_000) return { phase: 'abort', why: `not published by publishAt + ${PUBLISH_TIMEOUT_MIN}m`, slipCard: false };
  const start = Math.min(cut - RESERVE_LEAD_MIN * 60_000, Number.isFinite(reh) ? reh - REHEARSAL_LEAD_MIN * 60_000 : Infinity);
  if (t >= start) return { phase: 'reserve', why: t >= pub ? 'T−0 hold through publish' : t >= cut - RESERVE_LEAD_MIN * 60_000 ? 'T−2h reserve' : 'rehearsal reserve',
    slipCard: Number.isFinite(pub) && t >= pub + SLIP_CARD_MIN * 60_000 };
  return { phase: 'idle', why: `before reserve (${new Date(start).toISOString()})`, slipCard: false };
}

export function trafficTick(d: TrafficDeps): TickResult {
  const now = d.now(); const f = d.facts(); const v = typeof f['release.version'] === 'string' ? f['release.version'] as string : null;
  const { phase, why, slipCard } = decidePhase(f, now);
  const changes: string[] = []; const cards: string[] = [];
  if (!v) return { outcome: 'ok', phase, version: null, changes, cards, why };
  const unlock = lock(d.root, now);
  if (!unlock) return { outcome: 'busy', phase, version: v, changes, cards, why: 'another run holds the lock (single-flight)' };
  try {
    const st: TrafficState = loadTrafficState(d.root, v) ?? { version: v, phase: 'idle', adopted: [], baseline: {}, applied: {}, cards: [], leaseRequested: false, updateAll: 'pending' };
    const owner = d.owner();
    const cardOnce = (id: string, body: string) => {
      if (st.cards.includes(id)) return; st.cards.push(id); cards.push(body);
      if (d.live) d.card(`[release-traffic ${v}] ${body}`, owner);
    };
    const audit = (row: Record<string, unknown>) => {
      mkdirSync(join(d.root, 'release-traffic'), { recursive: true });
      appendFileSync(auditPath(d.root), `${JSON.stringify({ at: now.toISOString(), version: v, phase, live: d.live, ...row })}\n`);
    };
    const set = (host: string, to: number, from: number | null, reason: string): boolean => {
      const ok = d.live ? d.setSlots(host, to) : true;
      audit({ host, key: `res.policy.pregateSlots.${host}`, from, to, reason, ok, shadow: !d.live,
        undo: from === null ? `eln config unset res.policy.pregateSlots.${host}` : `eln config set res.policy.pregateSlots.${host} ${from}` });
      changes.push(`${host} ${from ?? '∅'}→${to}${d.live ? '' : ' (shadow)'}${ok ? '' : ' FAILED'}`);
      return ok;
    };
    let failed = false; const failures: string[] = []; // LOOP-EXCEPTION-WATCH: a fail always says why
    if (phase === 'reserve') {
      if (st.phase === 'idle' || !st.phase) st.phase = 'reserve';
      for (const [host, want] of Object.entries(RESERVE)) {
        const cur = d.getSlots(host);
        if (st.applied[host] !== undefined && cur === st.applied[host]) continue; // converged
        if (cur === want) { // adopt (hand-set before us, or our own write after a restart)
          if (!st.adopted.includes(host) && st.applied[host] === undefined) { st.adopted.push(host); st.baseline[host] ??= null; audit({ host, adopt: want, reason: 'already at reserve value — adopted, not rewritten' }); changes.push(`${host} adopted=${want}`); }
          st.applied[host] = want; continue;
        }
        if (st.applied[host] !== undefined && cur !== st.applied[host]) { // changed by hand mid-window
          cardOnce(`hand-${host}-${cur}`, `${host} pregate slots changed by hand to ${cur} during the window (we set ${st.applied[host]}) — respecting it, not fighting.`);
          continue;
        }
        if (!(host in st.baseline)) st.baseline[host] = cur;
        if (set(host, want, cur, why)) st.applied[host] = want; else { failed = true; failures.push(`set ${host} pregateSlots ${cur ?? '?'}→${want} failed`); }
      }
      if (!d.hostUp(RELEASE_HOST)) cardOnce(`down-${RELEASE_HOST}`, `release host ${RELEASE_HOST} is not reachable during the reserve window — release graph needs it; absorb host ${ABSORB_HOST} keeps ${RESERVE[ABSORB_HOST]} slots.`);
      const absorb = f[`res.lease.${ABSORB_HOST}.live`];
      if (absorb !== true && !st.leaseRequested) {
        st.leaseRequested = true;
        const out = d.live ? d.requestCapacity(`release ${v} traffic window: absorb non-release pregates off ${RELEASE_HOST}`) : 'shadow: would request absorb capacity (local first)';
        audit({ capacity: out, reason: `${ABSORB_HOST} lease not live` }); changes.push(`capacity: ${out}`);
        if (/needs-ceo|refused|fail/i.test(out)) cardOnce('capacity', `absorb capacity not granted (${out}) — non-release pregates will queue; no paid VM started.`);
      }
      if (absorb === true) st.leaseRequested = false; // a later expiry asks again (edge per expiry)
      if (slipCard) cardOnce('slip', `publish slipped past publishAt + ${SLIP_CARD_MIN}m — holding the reservation until publishAt + ${PUBLISH_TIMEOUT_MIN}m, then restore.`);
    }
    if (phase === 'restore' || phase === 'abort') {
      if (!st.restoredAt) {
        for (const [host, applied] of Object.entries(st.applied)) {
          const cur = d.getSlots(host);
          const target = st.baseline[host] ?? RESTORE_DEFAULT[host] ?? null;
          if (target === null) { audit({ host, keep: cur, reason: 'baseline unknown (adopted) and no default — left as is' }); continue; }
          if (cur !== applied) { cardOnce(`restore-hand-${host}`, `${host} slots are ${cur} (changed by hand after our ${applied}) — NOT restoring to ${target}; leave or undo by hand.`); audit({ host, keep: cur, reason: 'hand-changed since our write — not overwritten' }); continue; }
          if (cur === target) continue;
          if (!set(host, target, cur, `${phase}: ${why}`)) { failed = true; failures.push(`restore ${host} pregateSlots ${cur ?? '?'}→${target} failed`); }
        }
        if (!failed) st.restoredAt = now.toISOString();
        if (phase === 'abort') cardOnce('abort', `window closed without publish (${why}) — slots restored. Check the release graph.`);
      }
      if (phase === 'restore' && st.updateAll === 'pending') {
        if (f['release.updateAll'] === 'done' || f['release.updateAll'] === 'running') { st.updateAll = 'skipped'; audit({ updateAll: 'skipped', reason: `release graph update-all ${String(f['release.updateAll'])}` }); }
        else { const ok = d.live ? d.updateAll() : true; st.updateAll = ok ? 'done' : 'failed'; audit({ updateAll: st.updateAll, shadow: !d.live, undo: 'none (update is forward-only)' }); changes.push(`update-all ${st.updateAll}`); if (!ok) cardOnce('update-all', 'update-all after publish failed — run `els update-all` by hand.'); }
      }
      st.phase = phase;
    }
    writeJson(statePath(d.root, v), st);
    return { outcome: failed ? 'fail' : 'ok', phase, version: v, changes, cards, why: failed ? `fail: ${failures.join('; ')} · phase ${phase}: ${why}` : why };
  } finally { unlock(); }
}

// ── live wiring ─────────────────────────────────────────────────────────────
export function elnArgv(): string[] {
  // ELANOUS_TRAFFIC_ELN = the eln command (test universe: «bun bin/elanous.mjs --config-dir <scratch>»). Default: the running
  // code's own CLI by absolute path — never a bare `eln` (the trigger tick's cron PATH has no eln · cwd is the package dir).
  const raw = process.env.ELANOUS_TRAFFIC_ELN?.trim();
  return raw ? raw.split(/\s+/) : elanousCliArgv();
}
function eln(args: string[], timeout = 60_000) {
  const [cmd, ...pre] = elnArgv();
  // env: the live process.env (Bun's spawnSync without it keeps the start-up environ — a stamp set later would not reach the child)
  return spawnSync(cmd!, [...pre, ...args], { encoding: 'utf8', timeout, env: process.env });
}

export function trafficOwner(): string {
  // orgDuty('release-supervision') (#40179) is not on main yet → config loops.releaseTraffic.owner, else REL.
  try {
    const r = eln(['config', 'get', 'loops.releaseTraffic.owner'], 20_000);
    const o = String(r.stdout ?? '').trim();
    if (r.status === 0 && /^[A-Z][A-Z0-9-]*$/i.test(o)) return o.toUpperCase();
  } catch { /* default */ }
  return 'REL';
}

export function liveTrafficDeps(input: { live: boolean; root: string; stateRoot: string; seatState: string }): TrafficDeps {
  return {
    root: input.root, live: input.live, now: () => new Date(),
    facts: () => liveFacts(input.stateRoot, input.seatState, new Date()),
    getSlots: (host) => { const r = eln(['config', 'get', `res.policy.pregateSlots.${host}`]); const n = Number(String(r.stdout).trim()); return r.status === 0 && String(r.stdout).trim() !== '' && Number.isFinite(n) ? n : null; },
    setSlots: (host, n) => eln(['config', 'set', `res.policy.pregateSlots.${host}`, String(n)]).status === 0,
    hostUp: (host) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'true'], { timeout: 15_000 }).status === 0,
    requestCapacity: (reason) => { const r = eln(['res', 'lease', 'request', '--ram', '64G', '--ttl', '6h', '--requester', 'REL', '--reason', reason], 120_000); return `${r.status === 0 ? 'ok' : 'fail'}: ${String(r.stdout || r.stderr).trim().split('\n')[0] ?? ''}`; },
    // ELANOUS_TRAFFIC_UPDATE_ALL overrides the command (test universe: «true»).
    updateAll: () => { const [c, ...a] = (process.env.ELANOUS_TRAFFIC_UPDATE_ALL ?? `${installedBin('els')} update-all`).trim().split(/\s+/); return spawnSync(c!, a, { encoding: 'utf8', timeout: 1_800_000 }).status === 0; },
    card: (body, to) => { eln(['msg', 'post', '--from', 'ORCHESTRATOR', '--to', to, '--kind', 'coord', '--body', body], 30_000); },
    owner: trafficOwner,
  };
}

interface Ctx { graphId?: string; runId?: string; input?: { window?: string; stage?: string; shadowDir?: string; vars?: { stateRoot?: string; seatState?: string } } }

export function runTrafficNode(ctx: Ctx, deps?: TrafficDeps): Record<string, unknown> {
  const input = ctx.input ?? {};
  // the canonical instance root — never process.cwd() (a node runs with cwd = the installed package · #40570 class)
  const stateRoot = input.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot();
  const seatState = input.vars?.seatState ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state');
  const live = input.stage === 'live';
  const root = live ? join(seatState, 'RES', 'graph-state') : (input.shadowDir ?? join(stateRoot, 'loops', 'shadow', 'release-traffic'));
  const r = trafficTick(deps ?? liveTrafficDeps({ live, root, stateRoot, seatState }));
  mkdirSync(join(stateRoot, 'loops'), { recursive: true });
  if (r.outcome !== 'fail') appendFileSync(join(stateRoot, 'loops', 'release-traffic.jsonl'), `${JSON.stringify({ goal: 'met', window: input.window ?? 'manual', live, phase: r.phase, version: r.version, changes: r.changes })}\n`);
  // a fail says why AND where it looked (the resolved state root · the CLI it spawned)
  const why = r.outcome === 'fail' ? `${r.why} · stateRoot ${stateRoot} · eln ${elnArgv().join(' ')}` : r.why;
  return { ...r, why, outcome: r.outcome === 'busy' ? 'ok' : r.outcome, live, stateRoot };
}

if (import.meta.main) {
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    const ctx = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ctx : {};
    console.log(JSON.stringify(runTrafficNode(ctx)));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
