// WORLD-REGISTRY seed — the 11-27 08:0x census (seat-state/OP/design-archive-1126/SUPERVISORS-AND-MESSAGING-1127.md)
// as first registrations, so the first sweep already knows owner · purpose · subject for the actors OP asked about.
// Applied once per ledger (a `seed` event marks it); later sweeps and owners overwrite freely.
import type { WorldActorFields, WorldLedgerEvent } from './world-ledger-events.js';

export const SEED_ID = 'census-1127';

type SeedPatch = Omit<WorldActorFields, 'id' | 'mode'>;
interface SeedRow { id: string; patch: SeedPatch }

/** `@HQ` in an id/host is replaced by the local host key at seed time (the census was taken on HQ). */
const S = (id: string, patch: SeedPatch): SeedRow => ({ id, patch: { registered: true, ...patch } });

export const CENSUS_SEED: readonly SeedRow[] = [
  // Code-defined supervisors (supervisor/v1 · src/supervision/definitions) — census: definitions only, 0 runs in 24h.
  // Each owes a `eln watch beat <name>`; until it beats it is judged zombie (revive, not retire — CEO).
  S('supervisor:run-supervisor', { kind: 'supervisor', purpose: 'supervise TA/agent mission run rounds', owner: 'OP', subject: 'agent-mission runs', wake: 'per run round', heartbeatSource: 'watch:run-supervisor', slaMin: 60, meta: { census: 'dormant — no runs to supervise (TA launches 0)' } }),
  S('supervisor:run-doctor', { kind: 'supervisor', purpose: 'diagnose failed runs and rebind', owner: 'OP', subject: 'release-loop / failed runs', wake: 'on run failure', heartbeatSource: 'watch:run-doctor', slaMin: 60, meta: { census: 'definition only — run-doctor.supervisor.yaml · subject release-loop stopped 11-24' } }),
  S('supervisor:autopsy', { kind: 'supervisor', purpose: '부검반 — derailments / repeats / false HOLDs → logic cells', owner: 'OP', subject: 'land refusals · derailments', wake: 'on repeat failure', heartbeatSource: 'watch:autopsy', slaMin: 60, meta: { census: 'name only — no definition file' } }),
  S('supervisor:macrophage', { kind: 'supervisor', purpose: '대식세포 — claim/repair merge-train events · GC orphans', owner: 'OP', subject: 'orphan launchd · past-date cron · worktrees', wake: 'merge-train events', heartbeatSource: 'watch:macrophage', slaMin: 60, meta: { census: 'definition only — ~40 one-off launchd orphans left' } }),
  S('supervisor:stop-autoheal', { kind: 'supervisor', purpose: 'recover stalled harness runs', owner: 'TC', subject: 'harness runs', wake: 'on stall', heartbeatSource: 'watch:stop-autoheal', slaMin: 60, meta: { census: '0 runs' } }),
  S('supervisor:heal', { kind: 'supervisor', purpose: 'supervise heal-loop', owner: 'OP', subject: 'loop:heal-loop', wake: 'heal-loop ticks', heartbeatSource: 'watch:heal', slaMin: 60, meta: { census: 'subject loop off' } }),
  S('supervisor:silence', { kind: 'supervisor', purpose: 'unanswered request/incident past SLA → escalate once to the sender’s coordinator', owner: 'OP', subject: 'mail SLA', wake: '5m', heartbeatSource: 'watch:silence', slaMin: 60, meta: { census: 'subject loop off — prescription #4 revives it' } }),
  // The world registry's write owner (GUARDIAN-CHARTER-1127): runs the sweep, keeps supervisors beating.
  S('loop:guardian', { kind: 'loop', purpose: '수호자 — holds and keeps the world’s resources healthy · write owner of this ledger', owner: 'RES', subject: 'world registry · hosts · supervisors · fuel · credentials', wake: '1m pulse + 15m upkeep + events', kpi: 'unregistered 0 · zombie 0 · orphans >2h 0', heartbeatSource: 'loop' }),
  // Graph loops / loop agents that act (census 2a) — the loop registry fills heartbeat (last run) and mode.
  S('loop:land-graph', { kind: 'loop', purpose: 'judge open non-draft PRs (receipt · focused · security4 · hold) → land', owner: 'JUD', subject: 'open PRs', wake: 'PREGATE-GREEN change or 10m', kpi: 'lands/day (42 on 11-26)', heartbeatSource: 'loop' }),
  S('loop:judge-butler', { kind: 'loop', purpose: 'auto-lift expired HOLDs · free blocked hands · 30m status', owner: 'JUD', subject: 'HOLD ledger', wake: 'ledger change + 10m', kpi: 'HOLDs lifted / 30m', heartbeatSource: 'loop' }),
  S('loop:steward-space', { kind: 'loop', purpose: '행정관 — pregate --light for heads without receipts · reclaim hands · exception cards', owner: 'OP', subject: 'cells · PRs · hands', wake: '10m + 7 events', heartbeatSource: 'loop' }),
  S('loop:board-steward', { kind: 'loop', purpose: 'BOARD 행정관 — idle hands / too few ready cells', owner: 'OP', subject: 'federation board', wake: '10m', heartbeatSource: 'loop', meta: { census: 'alert only · overlaps steward-space' } }),
  S('loop:space-advisor-tc', { kind: 'loop', purpose: 'TC-ADV — answer ✋ hand questions from precedent', owner: 'TC', subject: '✋ NEED HUMAN', wake: '2m', heartbeatSource: 'loop' }),
  S('loop:release-rocket', { kind: 'loop', purpose: 'tick L-0…L-9 for each started release run', owner: 'REL', subject: 'release runs', wake: '2m', heartbeatSource: 'loop' }),
  S('loop:res-patrol', { kind: 'loop', purpose: '수호자 — RES policy patrol · restart chain', owner: 'RES', subject: 'hosts · leases', wake: '5m', heartbeatSource: 'loop', meta: { census: 'alert only — no auto-stop' } }),
  S('loop:watchers-check', { kind: 'loop', purpose: 'judge watcher beats DEAD/BLIND', owner: 'OP', subject: 'watch beats (4 watchers)', wake: '5m', heartbeatSource: 'loop' }),
  // HQ launchd residents (census 2d).
  S('launchd:com.elanous.postoffice@HQ', { kind: 'launchd', host: '@HQ', purpose: 'mail SSE — deliver to tab TUI queues (the one real wake path)', owner: 'OP', subject: 'seat mail', wake: 'always (resident)', kpi: 'deliveries/12h' }),
  S('launchd:dev.elanous.els@HQ', { kind: 'launchd', host: '@HQ', purpose: 'els server (Elanous Side)', owner: 'TC', subject: 'els panes', wake: 'always (resident)' }),
  S('launchd:com.elanous.train-manager@HQ', { kind: 'launchd', host: '@HQ', purpose: 'legacy train manager (replaced by land-graph)', owner: 'TC', subject: 'merge train', wake: 'every 15s', heartbeatSource: 'watch:train-manager', slaMin: 30, meta: { census: 'zombie — queue=0 idle · shadow applied=0' } }),
  S('launchd:com.elanous.seat-inbox-a135@HQ', { kind: 'launchd', host: '@HQ', purpose: 'priority mail wake for 10 core seats', owner: 'OP', subject: 'seat inboxes', wake: 'every 45s', heartbeatSource: 'watch:seat-inbox', slaMin: 15, meta: { census: 'void polling — 21,720 runs/2d · cursor stuck' } }),
  S('launchd:com.elanous.tf-hq-wake@HQ', { kind: 'launchd', host: '@HQ', purpose: 'inject TF wake', owner: 'OP', subject: 'TF seat', wake: 'every 300s', heartbeatSource: 'watch:tf-hq-wake', slaMin: 30, meta: { census: 'dead — injected 0 missing 26' } }),
  S('launchd:com.elanous.op-mail-bridge@HQ', { kind: 'launchd', host: '@HQ', purpose: 'mshq/OP-MBP mail bridge', owner: 'RES', subject: 'mail relay', wake: 'every 120s', heartbeatSource: 'watch:op-mail-bridge', slaMin: 30, meta: { census: 'cursor stuck' } }),
  S('launchd:com.elanous.hq-to-remote-mail-relay@HQ', { kind: 'launchd', host: '@HQ', purpose: 'HQ → remote mail relay', owner: 'RES', subject: 'kingdom mail', wake: 'every 120s', heartbeatSource: 'watch:hq-to-remote-mail-relay', slaMin: 30, meta: { census: 'log 0B since 11-11' } }),
  S('launchd:com.elanous.res.remote-idle-nudge@HQ', { kind: 'launchd', host: '@HQ', purpose: 'wake idle remote tabs', owner: 'RES', subject: 'remote seats', heartbeatSource: 'watch:remote-idle-nudge', slaMin: 60, meta: { census: 'log stopped 11-15' } }),
  S('launchd:com.elanous.res.seat-main-liveness@HQ', { kind: 'launchd', host: '@HQ', purpose: 'seat main-line liveness', owner: 'RES', subject: 'seats', wake: 'every 180s' }),
  S('launchd:com.elanous.op-guardian-mshq@HQ', { kind: 'launchd', host: '@HQ', purpose: 'OP guardian on mshq', owner: 'OP', subject: 'mshq', heartbeatSource: 'watch:op-guardian-mshq', slaMin: 60, meta: { census: 'log stopped 11-26 21:00' } }),
  S('launchd:com.elanous.jud-doorbell@HQ', { kind: 'launchd', host: '@HQ', purpose: 'JUD doorbell', owner: 'JUD', subject: 'JUD seat', heartbeatSource: 'watch:jud-doorbell', slaMin: 60, meta: { census: 'log 11-13~11-21' } }),
  S('launchd:com.elanous.jud-ten-minute-check@HQ', { kind: 'launchd', host: '@HQ', purpose: 'JUD 10-minute check (also in cron — duplicate)', owner: 'JUD', subject: 'JUD queue', wake: 'every 600s', heartbeatSource: 'watch:jud-ten-minute-check', slaMin: 30, meta: { census: 'launchd+cron duplicate' } }),
];

/** The seed is applied once per ledger: a `world-actor` line written by the census id marks it. */
export function seedApplied(events: readonly { event: string; by?: string }[]): boolean {
  return events.some(e => e.event === 'world-actor' && e.by === SEED_ID);
}

/** Pure: the census as `world-actor` lines (owner mode · registered). */
export function seedEvents(localHost: string, now: Date): WorldLedgerEvent[] {
  return CENSUS_SEED.map(row => ({
    event: 'world-actor' as const, at: now.toISOString(), by: SEED_ID,
    actor: { ...row.patch, id: row.id.replace(/@HQ$/u, `@${localHost}`), mode: 'owner' as const, ...(row.patch.host === '@HQ' ? { host: localHost } : {}) },
  }));
}
