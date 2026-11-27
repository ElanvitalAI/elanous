/** Rolling, side-effect-free seat surge assessment. Input is an observed event, not a proposed post. */
export const SEAT_SURGE_WINDOW_MS = 30 * 60_000;

export type SeatSurgeEvent =
  | { at: number; type: 'self-wake'; seat: string }
  | { at: number; type: 'mail'; from: string; to: string };

export interface SeatSurgeThresholds {
  selfWakes: number;
  sent: number;
  received: number;
  /** Alternating directed messages for the same pair. */
  pingPong: number;
}

export const DEFAULT_SEAT_SURGE_THRESHOLDS: SeatSurgeThresholds = {
  selfWakes: 10, sent: 20, received: 20, pingPong: 6,
};

export interface SeatSurgeStatus {
  seat: string;
  selfWakes: number;
  sent: number;
  received: number;
  pingPong: { peer: string; alternations: number }[];
  triggers: string[];
}

const canonical = (seat: string) => seat.trim().toUpperCase();

/** Window includes its lower boundary and excludes future observations. Other pairs do not break a pair's sequence. */
export function assessSeatSurge(seat: string, events: readonly SeatSurgeEvent[], now: number,
  limits: SeatSurgeThresholds = DEFAULT_SEAT_SURGE_THRESHOLDS): SeatSurgeStatus {
  const id = canonical(seat);
  const status: SeatSurgeStatus = { seat: id, selfWakes: 0, sent: 0, received: 0, pingPong: [], triggers: [] };
  const pairs = new Map<string, { previous: boolean | null; run: number; max: number }>();
  const recent = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => Number.isFinite(event.at) && event.at >= now - SEAT_SURGE_WINDOW_MS && event.at <= now)
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index);
  for (const { event } of recent) {
    if (event.type === 'self-wake') { if (canonical(event.seat) === id) status.selfWakes++; continue; }
    const from = canonical(event.from), to = canonical(event.to);
    if (from === to) continue;
    if (from === id) status.sent++;
    if (to === id) status.received++;
    if (from !== id && to !== id) continue;
    const peer = from === id ? to : from;
    if (!peer) continue;
    const outgoing = from === id;
    const pair = pairs.get(peer) ?? { previous: null, run: 0, max: 0 };
    pair.run = pair.previous === null || pair.previous === outgoing ? 1 : pair.run + 1;
    pair.previous = outgoing;
    pair.max = Math.max(pair.max, pair.run);
    pairs.set(peer, pair);
  }
  status.pingPong = [...pairs].map(([peer, p]) => ({ peer, alternations: p.max })).sort((a, b) => b.alternations - a.alternations || a.peer.localeCompare(b.peer));
  if (status.selfWakes >= limits.selfWakes) status.triggers.push('self-wakes');
  if (status.sent >= limits.sent) status.triggers.push('sent');
  if (status.received >= limits.received) status.triggers.push('received');
  for (const pair of status.pingPong) if (pair.alternations >= limits.pingPong) status.triggers.push(`ping-pong:${pair.peer}`);
  return status;
}
