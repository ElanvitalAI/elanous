import { debug } from '../debug/log.js';

/** The neighbor fields validated by src/loops/contract/validate.ts. */
export interface Neighbor {
  id: string;
  exchange: ('status' | 'request' | 'decision' | 'blocked')[];
  heartbeat: { everyMinutes: number; missedTicks: number };
  onAbsent: { action: 'delegate' | 'defer' | 'escalate'; delegateTo: string };
}

export interface NeighborJudgment {
  state: 'present' | 'absent' | 'unknown';
  action?: Neighbor['onAbsent'];
  reason: string;
}

/** lastSeenAt is the latest ACK of a heartbeat or envelope, not the last send attempt. */
export function judgeNeighbor({ neighbor, lastSeenAt, lastSendError, now }: {
  neighbor: Neighbor;
  lastSeenAt?: string | null;
  lastSendError?: unknown;
  now: Date;
}): NeighborJudgment {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  let result: NeighborJudgment;
  if (lastSendError != null) {
    result = { state: 'unknown', reason: 'send-failed' };
  } else if (!Number.isFinite(seen) || !Number.isFinite(now.getTime()) || seen > now.getTime()) {
    result = { state: 'unknown', reason: 'last-ack-unknown' };
  } else if (now.getTime() - seen >= neighbor.heartbeat.everyMinutes * neighbor.heartbeat.missedTicks * 60_000) {
    result = { state: 'absent', action: neighbor.onAbsent, reason: 'heartbeat-missed' };
  } else {
    result = { state: 'present', reason: 'within-heartbeat-window' };
  }
  // The validated neighbor entry does not carry its owning loop id; do not invent one.
  debug.log('loop.neighbors', 'judged', {
    loop: null, neighbor: neighbor.id, state: result.state, action: result.action, reason: result.reason,
  });
  return result;
}
