// WORLD-REGISTRY one-liner for OP surfaces (`eln fed snapshot` · OP pulse table) and the Nexus read API.
// Reads the lease ledger, folds the world, and says how fresh the last sweep is (a stale ledger must not read as «all well»).
// Faces: observe = the line itself names sweep age · judge = `staleSweep` (no sweep newer than WORLD_SWEEP_STALE_MIN) ·
//        heal = fail open to null (callers print «unmeasured world»); never throws into the snapshot or the pulse.
import { readResourceLedger, resourceLedgerPath } from './resource-ledger.js';
import { anomaliesOf, foldWorld, summarize, summaryLine, type WorldSummary, type WorldView } from './world-registry.js';
import type { WorldAnomaly } from './world-types.js';

/** The guardian sweeps every 15 min; two missed sweeps make the world view stale. */
export const WORLD_SWEEP_STALE_MIN = 35;

export interface WorldDigest {
  readonly at: string;
  readonly summary: WorldSummary;
  readonly lastSweepAt: string | null;
  readonly sweepAgeMin: number | null;
  readonly stale: boolean;
  readonly unreachable: readonly string[];
  readonly line: string;
}

/** Pure: the digest of a folded world at `now`. */
export function worldDigest(view: WorldView, now: Date): WorldDigest {
  const summary = summarize(view.actors);
  const okAts = view.sweeps.filter(s => s.ok).map(s => Date.parse(s.at)).filter(Number.isFinite);
  const last = okAts.length ? Math.max(...okAts) : null;
  const sweepAgeMin = last === null ? null : Math.max(0, Math.round((now.getTime() - last) / 60_000));
  const stale = sweepAgeMin === null || sweepAgeMin > WORLD_SWEEP_STALE_MIN;
  const unreachable = view.sweeps.filter(s => !s.ok).map(s => s.scope);
  const tail = sweepAgeMin === null ? ' · never swept (eln world sweep)' : ` · sweep ${sweepAgeMin}m ago${stale ? ' ⚠ stale' : ''}`;
  const line = `${summaryLine(summary)}${tail}${unreachable.length ? ` · unreachable ${unreachable.join(',')}` : ''}`;
  return { at: now.toISOString(), summary, lastSweepAt: last === null ? null : new Date(last).toISOString(), sweepAgeMin, stale, unreachable, line };
}

/** Live: digest from the lease ledger (null when the ledger cannot be read). */
export function liveWorldDigest(now: Date = new Date(), path: string = resourceLedgerPath()): WorldDigest | null {
  try { return worldDigest(foldWorld(readResourceLedger(path), now), now); } catch { return null; }
}

export interface WorldApiBody { digest: WorldDigest; actors?: WorldView['actors']; anomalies?: WorldAnomaly[] }

/** Pure: the read API body (filters by kind/state/owner/host; `anomalies` view on request). */
export function worldApiBody(view: WorldView, now: Date, q: { kind?: string | null; state?: string | null; owner?: string | null; host?: string | null; view?: 'actors' | 'anomalies' | 'summary' }): WorldApiBody {
  const digest = worldDigest(view, now);
  if (q.view === 'summary') return { digest };
  if (q.view === 'anomalies') return { digest, anomalies: anomaliesOf(view) };
  const actors = view.actors.filter(a => (!q.kind || a.kind === q.kind) && (!q.state || a.state === q.state) && (!q.owner || a.owner === q.owner) && (!q.host || a.host === q.host));
  return { digest, actors };
}
