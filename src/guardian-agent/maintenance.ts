// 수호자 — rotating maintenance windows (임대관 schedules · 대식세포 sanitizes) · CEO 11-27 11:3x
// «머신 자원들은 정비 작업을 위해 2시간씩 유휴 시간을 갖춰야 한다 · 이 케이던스는 수호자가 가져야 할 덕목».
//
// S: hosts ran heavy work around the clock; residue (worktrees · branches · docker layers · caches · /tmp · orphans) piled up
//    until a host fell over, and host-gc.sh is suspended pending a non-destructive audit (OP #98313).
// C: nobody owned a cadence — sanitize happened only after an incident.
// A: each local host gets a 2 h window on a staggered schedule (policy data · default every 24 h):
//      T-15m  drain    — the host's world row says maintenance; host-pick stops granting new work (in-flight runs finish)
//      start  begin    — once in-flight work is 0: sanitize steps · health checks · rail check
//      end    finish   — healthy → the row goes back to pool; one digest line
//    Rules: at most one local host draining/in maintenance at a time; never overlapping the cut window (03:00–06:30) or
//    while the host holds the only gate lease; when capacity is tight the window is deferred (1 h step) at most
//    `maxDefers` times, then forced. Destructive sanitize steps run as a dry count until RES/OP sets `apply: true`
//    (shadow first — the same rule as the reaper and host-gc's audit).
// State lives in the host's WORLD-REGISTRY row (`meta.maintenance`) — no new ledger.
import { recordWorldEvents } from '../resource-ledger/resource-ledger.js';
import type { WorldActorEvent } from '../resource-ledger/world-ledger-events.js';

/** The maintenance policy (RES data · code defaults when missing). */
export interface MaintenancePolicy {
  readonly everyH: number;
  readonly blockH: number;
  readonly leadMin: number;
  /** local time HH:MM — the release cut window */
  readonly cutStart: string;
  readonly cutEnd: string;
  readonly maxDefers: number;
  readonly deferStepMin: number;
  /** local hosts that must stay in the pool (capacity need) */
  readonly minLocalInPool: number;
  /** keep the host out for the whole block (idle time is the point) — false = re-enter as soon as steps + health pass */
  readonly holdFullBlock: boolean;
  /** destructive sanitize steps really run (false = dry count only) */
  readonly apply: boolean;
  readonly hosts: Readonly<Record<string, { readonly everyH?: number; readonly blockH?: number; readonly skip?: boolean }>>;
}

export const DEFAULT_MAINTENANCE_POLICY: MaintenancePolicy = {
  // Source: #40411 — CEO 11-27 11:3x: 2 h block · every 24 h · defer ≤ 2× then force · 2 local hosts stay in the pool.
  everyH: 24, blockH: 2, leadMin: 15, cutStart: '03:00', cutEnd: '06:30', maxDefers: 2, deferStepMin: 60, minLocalInPool: 2,
  holdFullBlock: true, apply: false, hosts: {},
};

const posNum = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const nonNeg = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d);
const hhmm = (v: unknown, d: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(v) ? v : d);

/** Pure: raw RES data (`maintenance` block) → policy; anything malformed falls back to the default for that field. */
export function resolveMaintenancePolicy(raw: unknown): MaintenancePolicy {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const d = DEFAULT_MAINTENANCE_POLICY;
  const hosts: Record<string, { everyH?: number; blockH?: number; skip?: boolean }> = {};
  if (r.hosts && typeof r.hosts === 'object' && !Array.isArray(r.hosts)) {
    for (const [h, v] of Object.entries(r.hosts as Record<string, unknown>)) {
      if (!/^[\w.-]+$/u.test(h) || !v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      hosts[h] = { ...(typeof o.everyH === 'number' && o.everyH > 0 ? { everyH: o.everyH } : {}), ...(typeof o.blockH === 'number' && o.blockH > 0 ? { blockH: o.blockH } : {}), ...(o.skip === true ? { skip: true } : {}) };
    }
  }
  return {
    everyH: posNum(r.everyH, d.everyH), blockH: posNum(r.blockH, d.blockH), leadMin: nonNeg(r.leadMin, d.leadMin),
    cutStart: hhmm(r.cutStart, d.cutStart), cutEnd: hhmm(r.cutEnd, d.cutEnd), maxDefers: nonNeg(r.maxDefers, d.maxDefers),
    deferStepMin: posNum(r.deferStepMin, d.deferStepMin), minLocalInPool: nonNeg(r.minLocalInPool, d.minLocalInPool),
    holdFullBlock: typeof r.holdFullBlock === 'boolean' ? r.holdFullBlock : d.holdFullBlock, apply: r.apply === true, hosts,
  };
}

export type MaintPhase = 'pool' | 'draining' | 'maintenance';
export interface MaintState {
  readonly phase: MaintPhase;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly lastDoneAt?: string;
  readonly defers: number;
  readonly lastDeferAt?: string;
  readonly forced?: boolean;
  readonly why?: string;
}
export const POOL: MaintState = { phase: 'pool', defers: 0 };

export interface MaintHostIn {
  readonly host: string;
  readonly state: MaintState;
  /** runs in flight on the host (leases held) */
  readonly inFlight: number;
  /** the host holds the only active gate lease */
  readonly onlyGateLease: boolean;
  readonly healthy: boolean;
}
export type MaintKind = 'drain' | 'begin' | 'finish' | 'defer' | 'cancel' | 'wait';
export interface MaintAction { readonly host: string; readonly kind: MaintKind; readonly why: string; readonly next: MaintState }

const MIN = 60_000;
const minutesOf = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Pure: [startMs, endMs) overlaps the daily cut window (local time · a window crossing midnight is handled). */
export function overlapsCut(startMs: number, endMs: number, p: Pick<MaintenancePolicy, 'cutStart' | 'cutEnd'>): boolean {
  const a = minutesOf(p.cutStart); const b = minutesOf(p.cutEnd);
  for (let day = -1; day <= Math.ceil((endMs - startMs) / (24 * 60 * MIN)) + 1; day++) {
    const base = new Date(startMs); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() + day);
    const cs = base.getTime() + a * MIN; const ce = base.getTime() + (b > a ? b : b + 24 * 60) * MIN;
    if (startMs < ce && endMs > cs) return true;
  }
  return false;
}

const every = (h: string, p: MaintenancePolicy) => (p.hosts[h]?.everyH ?? p.everyH) * 60 * MIN;
const block = (h: string, p: MaintenancePolicy) => (p.hosts[h]?.blockH ?? p.blockH) * 60 * MIN;
/** ms since the last window ended (never = due now, most overdue). */
const overdueMs = (x: MaintHostIn, nowMs: number, p: MaintenancePolicy) => (x.state.lastDoneAt ? nowMs - Date.parse(x.state.lastDoneAt) - every(x.host, p) : Number.POSITIVE_INFINITY);

/**
 * Pure: one tick of the rotation for the local hosts. Returns one action per host whose state should change (`wait` rows
 * only for the due host that is held back — the digest says why). Never more than one host leaves the pool.
 */
export function planMaintenance(hosts: readonly MaintHostIn[], now: Date, p: MaintenancePolicy): MaintAction[] {
  const nowMs = now.getTime(); const at = now.toISOString();
  const out: MaintAction[] = [];
  // ① hosts already out of the pool move forward
  for (const x of hosts) {
    const s = x.state;
    if (s.phase === 'draining') {
      const ws = Date.parse(s.windowStart ?? at); const we = Date.parse(s.windowEnd ?? at);
      if (nowMs >= we) out.push({ host: x.host, kind: 'cancel', why: `in-flight work never drained (${x.inFlight} left at window end)`, next: { phase: 'pool', defers: s.defers + 1, lastDeferAt: at, ...(s.lastDoneAt ? { lastDoneAt: s.lastDoneAt } : {}), why: 'drain timed out' } });
      else if (nowMs >= ws && x.inFlight === 0) out.push({ host: x.host, kind: 'begin', why: 'drained — sanitize · health · rail check', next: { ...s, phase: 'maintenance' } });
    } else if (s.phase === 'maintenance') {
      const we = Date.parse(s.windowEnd ?? at);
      const doneEarly = !p.holdFullBlock && x.healthy;
      if (nowMs >= we || doneEarly) out.push({ host: x.host, kind: 'finish', why: x.healthy ? 'healthy — back to pool' : 'window over · unhealthy (health facts keep it out of routing)', next: { phase: 'pool', defers: 0, lastDoneAt: at } });
    }
  }
  const changed = new Map(out.map(a => [a.host, a.next]));
  const phaseOf = (x: MaintHostIn) => (changed.get(x.host) ?? x.state).phase;
  // ② one new window at most — only when nobody else is out
  if (hosts.some(x => phaseOf(x) !== 'pool')) return out;
  // a host whose window just ended / was cancelled this tick is not re-planned in the same tick
  const due = hosts.filter(x => !changed.has(x.host) && phaseOf(x) === 'pool' && !p.hosts[x.host]?.skip && overdueMs(x, nowMs, p) >= 0)
    .sort((a, b) => overdueMs(b, nowMs, p) - overdueMs(a, nowMs, p) || a.host.localeCompare(b.host));
  const x = due[0];
  if (!x) return out;
  const s = changed.get(x.host) ?? x.state;
  const ws = nowMs + p.leadMin * MIN; const we = ws + block(x.host, p);
  if (overlapsCut(nowMs, we, p)) return [...out, { host: x.host, kind: 'wait', why: `window ${fmt(ws)}–${fmt(we)} would overlap the cut window ${p.cutStart}–${p.cutEnd}`, next: s }];
  const recentlyDeferred = s.lastDeferAt !== undefined && nowMs - Date.parse(s.lastDeferAt) < p.deferStepMin * MIN;
  const poolAfter = hosts.filter(h => h.host !== x.host && phaseOf(h) === 'pool' && h.healthy).length;
  const blocker = x.onlyGateLease ? 'holds the only gate lease' : poolAfter < p.minLocalInPool ? `capacity tight (pool would be ${poolAfter} < ${p.minLocalInPool})` : null;
  if (blocker && x.onlyGateLease) {
    // the only gate lease is never taken away — not even when forced; it is a wait, not a counted defer
    return [...out, { host: x.host, kind: 'wait', why: blocker, next: s }];
  }
  if (blocker && s.defers < p.maxDefers) {
    if (recentlyDeferred) return [...out, { host: x.host, kind: 'wait', why: `deferred ${s.defers}/${p.maxDefers} · ${blocker}`, next: s }];
    return [...out, { host: x.host, kind: 'defer', why: `${blocker} — deferred ${s.defers + 1}/${p.maxDefers}`, next: { ...s, defers: s.defers + 1, lastDeferAt: at, why: blocker } }];
  }
  const forced = blocker !== null;
  return [...out, { host: x.host, kind: 'drain', why: `${forced ? `forced after ${s.defers} defers (${blocker}) · ` : ''}window ${fmt(ws)}–${fmt(we)} · no new work`, next: { phase: 'draining', defers: s.defers, windowStart: new Date(ws).toISOString(), windowEnd: new Date(we).toISOString(), ...(s.lastDoneAt ? { lastDoneAt: s.lastDoneAt } : {}), ...(forced ? { forced: true } : {}) } }];
}

const fmt = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Pure: the schedule line per host for `eln loop guardian world` (next due time · phase · defers). */
export function scheduleLines(hosts: readonly Pick<MaintHostIn, 'host' | 'state'>[], now: Date, p: MaintenancePolicy): string[] {
  return hosts.map(x => {
    const s = x.state;
    if (s.phase !== 'pool') return `${x.host.padEnd(8)} ${s.phase.padEnd(11)} ${s.windowStart ? fmt(Date.parse(s.windowStart)) : '?'}–${s.windowEnd ? fmt(Date.parse(s.windowEnd)) : '?'}${s.forced ? ' (forced)' : ''}`;
    if (p.hosts[x.host]?.skip) return `${x.host.padEnd(8)} pool        maintenance skipped by policy`;
    const dueMs = s.lastDoneAt ? Date.parse(s.lastDoneAt) + every(x.host, p) : now.getTime();
    const dueIn = Math.round((dueMs - now.getTime()) / MIN);
    return `${x.host.padEnd(8)} pool        next window ${dueIn <= 0 ? 'due now' : `in ${dueIn >= 120 ? `${Math.round(dueIn / 60)}h` : `${dueIn}m`}`}${s.defers ? ` · deferred ${s.defers}/${p.maxDefers}` : ''}${s.lastDoneAt ? ` · last ${fmt(Date.parse(s.lastDoneAt))}` : ' · never'}`;
  });
}

/** Pure: the world-row meta reader (`meta.maintenance`) — malformed → pool. */
export function maintStateOf(meta: Record<string, unknown> | undefined): MaintState {
  const m = meta?.maintenance;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return POOL;
  const o = m as Record<string, unknown>;
  const phase = o.phase === 'draining' || o.phase === 'maintenance' ? o.phase : 'pool';
  const iso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined);
  const ws = iso(o.windowStart); const we = iso(o.windowEnd); const ld = iso(o.lastDoneAt); const lda = iso(o.lastDeferAt);
  return { phase, defers: nonNeg(o.defers, 0), ...(ws ? { windowStart: ws } : {}), ...(we ? { windowEnd: we } : {}), ...(ld ? { lastDoneAt: ld } : {}), ...(lda ? { lastDeferAt: lda } : {}), ...(o.forced === true ? { forced: true } : {}), ...(typeof o.why === 'string' ? { why: o.why.slice(0, 160) } : {}) };
}

/** A host out of the pool for maintenance — host-pick excludes it (in-flight runs are not touched). */
export const inMaintenance = (meta: Record<string, unknown> | undefined): boolean => maintStateOf(meta).phase !== 'pool';

// ── the window's work (대식세포) ──────────────────────────────────────────────────────────────

export interface MaintStep {
  readonly id: string;
  readonly label: string;
  /** runs when `apply` (or always for non-destructive steps) */
  readonly cmd: string;
  /** destructive steps run this instead while `apply` is false (counts only) */
  readonly dry?: string;
}

const REPOS = 'for R in "$HOME/elanous-hq/repo.git" "$HOME/source/elanous-agent"; do [ -e "$R" ] || continue;';
/** The sanitize · health · rail steps. Destructive ones carry a `dry` count; orphan reap is the reaper's (exact PID · registry). */
export const MAINT_STEPS: readonly MaintStep[] = [
  { id: 'worktrees', label: 'git worktree prune (missing dirs only)', cmd: `${REPOS} git -C "$R" worktree prune -v 2>&1 | wc -l | tr -d ' '; done`, dry: `${REPOS} git -C "$R" worktree prune -n -v 2>&1 | wc -l | tr -d ' '; done` },
  { id: 'branches', label: 'merged local branches (-d · not main · not checked out)', cmd: `${REPOS} cur=$(git -C "$R" symbolic-ref -q --short HEAD); for b in $(git -C "$R" branch --merged refs/remotes/origin/main --format='%(refname:short)'); do [ "$b" = main ] || [ "$b" = "$cur" ] || git -C "$R" worktree list | grep -q "\\[$b\\]" || git -C "$R" branch -d "$b" >/dev/null 2>&1 && echo x; done | wc -l | tr -d ' '; done`, dry: `${REPOS} git -C "$R" branch --merged refs/remotes/origin/main --format='%(refname:short)' | grep -vx main | wc -l | tr -d ' '; done` },
  { id: 'docker', label: 'docker stopped containers · dangling images · build cache · anonymous volumes', cmd: 'command -v docker >/dev/null && timeout 20 docker info >/dev/null 2>&1 && { docker container prune -f; docker image prune -f; docker builder prune -f; docker volume prune -f; } 2>&1 | grep -i "reclaimed" | tr "\\n" " " || echo "no docker"', dry: 'command -v docker >/dev/null && timeout 20 docker info >/dev/null 2>&1 && docker system df --format "{{.Type}} {{.Reclaimable}}" | tr "\\n" " " || echo "no docker"' },
  { id: 'build-cache', label: 'bun install cache', cmd: 'command -v bun >/dev/null && bun pm cache rm >/dev/null 2>&1 && echo cleared || echo "no bun"', dry: 'du -sh "$HOME/.bun/install/cache" 2>/dev/null | cut -f1 || echo 0' },
  { id: 'tmp', label: 'stale /tmp logs · raws (> 3 days)', cmd: "find /tmp -maxdepth 1 -mtime +3 \\( -name '*.log' -o -name '*.raw' -o -name '*.out' -o -name '*.bundle' \\) -print -delete 2>/dev/null | wc -l | tr -d ' '", dry: "find /tmp -maxdepth 1 -mtime +3 \\( -name '*.log' -o -name '*.raw' -o -name '*.out' -o -name '*.bundle' \\) 2>/dev/null | wc -l | tr -d ' '" },
  { id: 'logs', label: 'oversized logs (> 200 MB · report)', cmd: "find \"$HOME/.elanous\" \"$HOME/Library/Logs\" -maxdepth 3 -name '*.log' -size +200M 2>/dev/null | wc -l | tr -d ' '" },
  { id: 'disk', label: 'disk free (GB)', cmd: "df -Pk / | awk 'NR==2{print int($4/1048576)}'" },
  { id: 'rail', label: 'pending update (read-only · install stays OP/HITL)', cmd: 'command -v elanous >/dev/null && timeout 30 elanous update --auto status 2>&1 | head -1 || echo "no elanous"' },
];

export interface StepResult { readonly id: string; readonly ok: boolean; readonly out: string; readonly dry: boolean }
/** Live: run the steps on one host through `run` (ssh or local sh · bounded by the caller). Never throws. */
export function runMaintenanceSteps(host: string, p: Pick<MaintenancePolicy, 'apply'>, run: (host: string, cmd: string) => { ok: boolean; out: string }): StepResult[] {
  return MAINT_STEPS.map(s => {
    const dry = !p.apply && s.dry !== undefined;
    try { const r = run(host, dry ? s.dry! : s.cmd); return { id: s.id, ok: r.ok, out: r.out.trim().split('\n').join(' ').slice(0, 120), dry }; } catch (e) { return { id: s.id, ok: false, out: (e as Error).message.slice(0, 120), dry }; }
  });
}

/** Pure: one digest line per finished/begun window. */
export function digestLine(a: MaintAction, steps: readonly StepResult[] = []): string {
  const st = steps.length ? ` · ${steps.map(s => `${s.id}${s.dry ? '(dry)' : ''} ${s.ok ? s.out || 'ok' : `FAIL ${s.out}`}`).join(' · ')}` : '';
  return `[정비] ${a.host} ${a.kind} — ${a.why}${st}`;
}

// ── one tick (the 임대관 schedules · the 대식세포 does the window's work) ─────────────────────────────────────────────

export interface MaintPorts {
  policy(): MaintenancePolicy;
  /** local pool hosts with their world-row maintenance state, in-flight leases, gate lease and health */
  hosts(): MaintHostIn[];
  /** write `meta.maintenance` into the host's world row */
  save(host: string, state: MaintState, at: string): void;
  run(host: string, cmd: string): { ok: boolean; out: string };
  /** exact-PID orphan reap on the host (the reaper · registry · probation caps) → one line */
  reap(host: string): string;
  digest(line: string): void;
}

/** One tick: plan → save state changes → on `begin` run the window's work → one digest line per begin/finish/cancel/defer. */
export function runMaintenanceTick(ports: MaintPorts, now: Date): { actions: MaintAction[]; lines: string[] } {
  const p = ports.policy();
  const actions = planMaintenance(ports.hosts(), now, p);
  const lines: string[] = [];
  for (const a of actions) {
    if (a.kind === 'wait') continue;
    ports.save(a.host, a.next, now.toISOString());
    let steps: StepResult[] = [];
    if (a.kind === 'begin') {
      steps = runMaintenanceSteps(a.host, p, ports.run);
      let reaped = ''; let reapOk = true;
      try { reaped = ports.reap(a.host); } catch (e) { reapOk = false; reaped = (e as Error).message.slice(0, 80); }
      steps = [...steps, { id: 'orphans', ok: reapOk, out: reaped, dry: false }];
    }
    if (a.kind === 'drain' || a.kind === 'begin' || a.kind === 'finish' || a.kind === 'cancel' || a.kind === 'defer') {
      const line = digestLine(a, steps);
      lines.push(line);
      try { ports.digest(line); } catch { /* the digest is best effort */ }
    }
  }
  return { actions, lines };
}

/** Pure: the world-actor event that stores a host's maintenance state in its WORLD-REGISTRY row (`meta.maintenance`). */
export function maintStateEvent(host: string, state: MaintState, at: string, by = 'loop:guardian/lease'): WorldActorEvent {
  return { event: 'world-actor', at, by, actor: { id: `host:${host}`, kind: 'host', mode: 'owner', registered: true, host,
    // a window takes the host out of kit/resource-facts routing at once (health reserved); back in pool, the next 임대관 facts
    // write recomputes health from the probe
    meta: { maintenance: { ...state }, ...(state.phase === 'pool' ? {} : { health: 'reserved', healthNote: 'maintenance window' }) } } };
}
/** Live: append it to the lease ledger (the 임대관's save port). Throws on a write failure — the tick re-plans next pulse. */
export function saveMaintState(host: string, state: MaintState, at: string, path?: string): void {
  recordWorldEvents([maintStateEvent(host, state, at)], path);
}
