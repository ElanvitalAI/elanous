// WORLD-REGISTRY — one ledger of every actor in the world (CEO 11-27 09:3x).
// S: to learn what runs, Claude OP needed a 9-minute subagent census (53 graph loops · ~150 launchd jobs · ~60 cron lines ·
//    4 code supervisors with 0 runs · a zombie train-manager · 300+ orphan test-universe processes) — none of it in one ledger.
// C: «OP cannot see the world, so it has no control over resources» — every registry (loops · schedules · host-registry ·
//    worker-registry · watch beats · els panes) answers one slice and nobody joins them.
// Q: what is the single row every actor gets, and what makes a row an anomaly?
// A: `WorldActor` below. A sweep (LLM 0) folds the existing slices into it; owners register what they run; a row that
//    runs but nobody registered is `unregistered`, a registered row whose heartbeat lapsed past its SLA is `zombie`.
//    Write owner = the guardian super loop agent (loop:guardian · L0 RES · GUARDIAN-CHARTER-1127) — it runs the sweep;
//    coordinators (OP · TC · JUD · UX · MK) read everything; owners register/update only their own actors.
//    `credential` rows carry names/owner/expiry only (never values); `llm-account` rows carry remaining fuel in meta.
//    Rows are never deleted (supervisors are revived, not retired — CEO): `retire` is always `never`.

export const WORLD_KINDS = [
  'seat', 'pane', 'loop', 'supervisor', 'watcher', 'launchd', 'cron', 'host', 'vm', 'credential', 'llm-account', 'run', 'test-universe', 'process',
] as const;
export type WorldKind = typeof WORLD_KINDS[number];

/** Owner-declared state. `zombie` and `unregistered` are judged, never declared. */
export const DECLARED_STATES = ['live', 'shadow', 'off'] as const;
export type DeclaredState = typeof DECLARED_STATES[number];

export const WORLD_STATES = ['live', 'shadow', 'off', 'zombie', 'unregistered'] as const;
export type WorldState = typeof WORLD_STATES[number];

export const ANOMALY_KINDS = ['unregistered', 'zombie', 'no-owner', 'unreachable'] as const;
export type AnomalyKind = typeof ANOMALY_KINDS[number];

export interface WorldActor {
  readonly id: string;
  readonly kind: WorldKind;
  /** One line: why this actor exists. */
  readonly purpose: string | null;
  /** Owner seat / L0 supervisor. */
  readonly owner: string | null;
  /** What it supervises or serves. */
  readonly subject: string | null;
  /** Trigger: cron expr · interval · event · always · manual. */
  readonly wake: string | null;
  readonly kpi: string | null;
  /** Where the heartbeat is read: `watch:<name>` · `loop` · `seen` (present in sweep) · `log` (log mtime) · null = none. */
  readonly heartbeatSource: string | null;
  readonly heartbeatAt: string | null;
  /** Heartbeat SLA in minutes; null = no SLA (never zombie by lapse). */
  readonly slaMin: number | null;
  readonly host: string | null;
  /** An owner (or an elanous tool) declared this actor. Discovery alone never sets it. */
  readonly registered: boolean;
  readonly declaredState: DeclaredState;
  /** Judged at the last sweep / write. */
  readonly state: WorldState;
  /** Why `state` is what it is (one line). */
  readonly reason: string | null;
  /** Seen running/present on its host in the last sweep that covered that host. */
  readonly present: boolean;
  readonly seenAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retire: 'never';
  readonly meta: Record<string, unknown>;
}

export interface WorldAnomaly {
  readonly id: string;
  readonly kind: AnomalyKind;
  readonly actorKind: WorldKind;
  readonly host: string | null;
  readonly reason: string;
}

export interface WorldEvent {
  readonly seq: number;
  readonly at: string;
  readonly actorId: string;
  readonly action: string;
  readonly by: string;
  readonly detail: Record<string, unknown>;
}

export function isWorldKind(v: unknown): v is WorldKind { return typeof v === 'string' && (WORLD_KINDS as readonly string[]).includes(v); }
export function isDeclaredState(v: unknown): v is DeclaredState { return typeof v === 'string' && (DECLARED_STATES as readonly string[]).includes(v); }
export function isWorldState(v: unknown): v is WorldState { return typeof v === 'string' && (WORLD_STATES as readonly string[]).includes(v); }

/** Who may write any row: the guardian (write owner), its L0 RES, and OP. Everyone else writes only rows they own. */
export const WORLD_WRITE_OWNERS = ['loop:guardian', 'guardian', 'RES', 'OP'] as const;

/** Pure: may `by` write the row currently owned by `owner` (null = unowned → the writer may claim it)? */
export function mayWrite(by: string, owner: string | null): boolean {
  const who = by.trim();
  if ((WORLD_WRITE_OWNERS as readonly string[]).some(w => w.toLowerCase() === who.toLowerCase())) return true;
  if (!owner) return true;
  return owner.toUpperCase() === who.toUpperCase();
}
