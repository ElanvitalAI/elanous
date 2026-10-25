/**
 * ANOMALY-CLUSTER-PRODUCT — repeated failure signatures hold relaunches.
 *
 * Reference contract (read-only, unchanged): `seat-state/OP/tools/anomaly-cluster.{sh,py}` groups the same
 * failures for an OP seat by eye and never holds anything automatically. This module is the product
 * transfer of that reading contract: it computes a signature and turns it into a hold/release decision.
 *
 * Boundary: when the SAME signature shows up in 3+ DIFFERENT runs, relaunches of that goal·host are held
 * automatically until a cause verdict (`release`) clears them. The host is a hold key, never part of the
 * signature. When there is nothing measured for a goal·host, the hold reason says so ("원천 미측정").
 *
 * Pure module: no fs, no network, no clock reads unless a `now` seam is injected.
 */

/** Runs of the same signature required before relaunches are held. */
export const ANOMALY_HOLD_THRESHOLD = 3;

/** Signature components: failure kind · container exit · stage · tail of `lastLines` reason. */
export interface FailureObservation {
  /** Goal identifier — a hold key, not part of the signature. */
  goal: string;
  /** Host (seat / surface / launch host) — a hold key, not part of the signature. */
  host: string;
  /** Run identifier — the unit counted as "a different run". */
  runId: string;
  /** Failure kind (`preflight` · `exit` · `timeout` · adapter name …). */
  kind: string;
  /** Container exit code when observed; `null`/absent when the failure never reached a container. */
  containerExit?: number | null;
  /** Stage the failure was observed at (`launch` · `delegate` · `monitor` …). */
  stage: string;
  /** Tail lines of the failure; the last non-empty line is the "reason tail" that splits signatures. */
  lastLines?: readonly string[];
  at?: string;
}

export interface HoldDecision {
  /** `true` when relaunches of this goal·host are held. */
  hold: boolean;
  /** Korean explanation — includes "원천 미측정" when nothing was measured. */
  reason: string;
  signature?: string;
  /** Distinct runs counted for the holding signature. */
  runs?: number;
}

export interface ReleaseDecision {
  released: boolean;
  reason: string;
}

const REASON_TAIL_LIMIT = 160;

/** Collapse whitespace and cap length — the reason tail is a signature component, not a payload. */
function reasonTail(lines: readonly string[] | undefined): string {
  if (!lines || lines.length === 0) return 'none';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').replace(/\s+/g, ' ').trim().replace(/^reason\s*[:=]\s*/i, '');
    if (line) return line.slice(0, REASON_TAIL_LIMIT);
  }
  return 'none';
}

/** Pull a container exit code out of free text (`exited with code 137`, `exit status 1`, `exit=137`). */
export function extractContainerExit(text: string): number | null {
  const match = /(?:exit(?:ed)?(?: with)?(?: code| status)?|exit=)\s*[:=]?\s*(\d+)/i.exec(text ?? '');
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Signature = kind · exit · stage · reason tail. Host and run are deliberately excluded: the host is a
 * hold key and the run is the counter.
 */
export function failureSignature(obs: FailureObservation): string {
  const exit = obs.containerExit === undefined || obs.containerExit === null ? 'none' : String(obs.containerExit);
  return `kind=${obs.kind}|exit=${exit}|stage=${obs.stage}|reason=${reasonTail(obs.lastLines)}`;
}

interface ClusterState {
  goal: string;
  host: string;
  signature: string;
  runs: Set<string>;
  held: boolean;
  /** First `FailureObservation.at` read into this cluster — the observation window shown in the reason. */
  firstAt?: string;
  /** Latest `FailureObservation.at` read into this cluster. */
  lastAt?: string;
}

function keyOf(goal: string, host: string): string {
  return `${goal}\u0000${host}`;
}

/** In-memory grouping state — written by the failure observation point, read by the relaunch point. */
export class AnomalyCluster {
  private readonly threshold: number;
  private readonly now: () => Date;
  private readonly clusters = new Map<string, ClusterState>();
  /**
   * Observations of a DIFFERENT signature that arrived while its goal·host was held. They are kept
   * counting in a side bucket so a late-arriving observation can never drop a hold before a cause
   * verdict — the hold is only ever cleared by `release`.
   */
  private readonly parked = new Map<string, ClusterState>();

  constructor(opts: { threshold?: number; now?: () => Date } = {}) {
    this.threshold = Math.max(1, Math.trunc(opts.threshold ?? ANOMALY_HOLD_THRESHOLD));
    this.now = opts.now ?? (() => new Date());
  }

  /** Record one failure observation and return the resulting hold decision for its goal·host. */
  record(obs: FailureObservation): { signature: string; runs: number; hold: HoldDecision } {
    const signature = failureSignature(obs);
    const key = keyOf(obs.goal, obs.host);
    const at = typeof obs.at === 'string' && obs.at.trim() ? obs.at.trim() : undefined;
    let cluster = this.clusters.get(key);
    if (cluster && cluster.signature !== signature && cluster.held) {
      // Held: the signature is frozen until a cause verdict. A late observation of another signature is
      // counted in the parked bucket — replacing the cluster here would silently drop the hold.
      const parkedKey = keyOf(key, signature);
      let parked = this.parked.get(parkedKey);
      if (!parked) {
        parked = { goal: obs.goal, host: obs.host, signature, runs: new Set(), held: false };
        this.parked.set(parkedKey, parked);
      }
      this.touch(parked, obs.runId, at);
      const held = this.describe(cluster);
      return {
        signature: cluster.signature,
        runs: cluster.runs.size,
        hold: {
          ...held,
          reason: `${held.reason} · 보류 중 도착한 다른 서명 ${parked.runs.size}건은 해제 없이 별도 보관(판정 뒤 재판정)`,
        },
      };
    }
    if (!cluster || cluster.signature !== signature) {
      // Not held: a different signature takes over. A parked bucket of that same signature keeps its runs.
      const parkedKey = keyOf(key, signature);
      const resumed = this.parked.get(parkedKey);
      for (const stale of [...this.parked.keys()]) {
        if (stale !== parkedKey && stale.startsWith(`${key}\u0000`)) this.parked.delete(stale);
      }
      if (resumed) this.parked.delete(parkedKey);
      cluster = resumed ?? { goal: obs.goal, host: obs.host, signature, runs: new Set(), held: false };
      this.clusters.set(key, cluster);
    }
    this.touch(cluster, obs.runId, at);
    return { signature, runs: cluster.runs.size, hold: this.describe(cluster) };
  }

  /** Relaunch gate. A hold is decided before any cause verdict; the reason names an unmeasured source. */
  hold(goal: string, host: string): HoldDecision {
    const cluster = this.clusters.get(keyOf(goal, host));
    if (!cluster) {
      return { hold: false, reason: `원천 미측정: ${goal}·${host} 의 실패 관측이 없다 — 보류 판정 근거 없음` };
    }
    return this.describe(cluster);
  }

  isHeld(goal: string, host: string): boolean {
    return this.clusters.get(keyOf(goal, host))?.held ?? false;
  }

  /** Cause verdict — clears the hold. Returns `released: false` when nothing was held. */
  release(goal: string, host: string, cause: string): ReleaseDecision {
    const key = keyOf(goal, host);
    const cluster = this.clusters.get(key);
    if (!cluster || !cluster.held) {
      return { released: false, reason: `${goal}·${host} 는 보류 상태가 아니다` };
    }
    const judged = cluster.signature;
    const judgedRuns = cluster.runs.size;
    cluster.held = false;
    cluster.runs.clear();
    cluster.firstAt = undefined;
    cluster.lastAt = undefined;
    const promoted = this.takeStrongestParked(key);
    if (promoted) this.clusters.set(key, promoted);
    const head = `보류 해제: ${cause} (${this.now().toISOString()}) — 판정한 서명 ${judged} ${judgedRuns}건`;
    return {
      released: true,
      reason: promoted
        ? `${head} · 보류 중 보관한 다른 서명 ${promoted.signature} ${promoted.runs.size}건을 재판정 대상으로 승격${promoted.held ? ' (임계 도달 — 새 서명 기준 재보류)' : ''}`
        : head,
    };
  }

  private touch(cluster: ClusterState, runId: string, at: string | undefined): void {
    cluster.runs.add(runId);
    if (at) {
      cluster.firstAt ??= at;
      cluster.lastAt = at;
    }
    if (cluster.runs.size >= this.threshold) cluster.held = true;
  }

  /** The parked bucket of this goal·host with the most runs — the next signature to judge. */
  private takeStrongestParked(key: string): ClusterState | undefined {
    let best: ClusterState | undefined;
    let bestKey: string | undefined;
    for (const [parkedKey, state] of this.parked) {
      if (!parkedKey.startsWith(`${key}\u0000`)) continue;
      if (!best || state.runs.size > best.runs.size) {
        best = state;
        bestKey = parkedKey;
      }
    }
    if (best && bestKey) this.parked.delete(bestKey);
    return best;
  }

  private describe(cluster: ClusterState): HoldDecision {
    const runs = cluster.runs.size;
    const window = cluster.firstAt ? ` · 관측 ${cluster.firstAt}${cluster.lastAt && cluster.lastAt !== cluster.firstAt ? `..${cluster.lastAt}` : ''}` : '';
    if (cluster.held) {
      return {
        hold: true,
        reason: `같은 서명 ${runs}건(임계 ${this.threshold}) — 원인 판정 전 ${cluster.goal}·${cluster.host} 재발사 보류${window}`,
        signature: cluster.signature,
        runs,
      };
    }
    return {
      hold: false,
      reason: `같은 서명 ${runs}건 < 임계 ${this.threshold} — 보류하지 않는다${window}`,
      signature: cluster.signature,
      runs,
    };
  }
}

/** Process-wide cluster shared by the tick failure record point and the dispatcher relaunch gate. */
let shared: AnomalyCluster | undefined;

/** Lazily created shared instance — no fs side effects, process-wide by design. */
export function defaultAnomalyCluster(): AnomalyCluster {
  shared ??= new AnomalyCluster();
  return shared;
}
