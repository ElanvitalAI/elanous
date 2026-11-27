// KIT mail-route · dormant reroute — the sender entrances (CLI `msg post` · MsgPost tool) reroute through HERE, and a
// reroute always passes the live probe (LA-R2 · #40389): an address a live pane / session / tab reads is never rerouted.
// The census table, the reroute rule and the probe stay in msg/dormant-reroute.ts; this module is the one entrance call.
import type { WakeDeps } from '../../loops/msg-wake.js';
import { dormantReroute, liveByWake, REROUTED_FROM_REF, type Reroute, type RerouteInput } from '../../msg/dormant-reroute.js';
import { readHandRoutes } from './hand-routes.js';

// The live probe is msg/dormant-reroute.liveByWake (#40389) — re-exported here; the kit adds the resource and sender rules.
export { liveByWake };

/** Resource addresses (hand-routes.yaml `dormant.resourceAddresses`): their mail goes to the guardian's postoffice (or a
 *  live RES-INFRA), never to the OP digest. */

/**
 * The reroute for a post (null = deliver to its address). `isLive` overrides the wake probe (tests · sims).
 *
 * #191271 (11-27 10:44): OP's own mail to a dormant RES was rerouted to the OP digest — OP woke itself and nobody got the
 * mail. Two rules here: RES / RES-INFRA → a live RES-INFRA, else GUARDIAN (never OP); and a reroute target is never the
 * sender — then the mail stays at its address (the OP digest «잠든 수신처» section only takes mail from someone else).
 */
export function routeDormant(m: RerouteInput, opts: { isLive?: (address: string) => boolean; wakeDeps?: WakeDeps } = {}): Reroute | null {
  const isLive = opts.isLive ?? liveByWake(opts.wakeDeps);
  const to = m.to.trim().toUpperCase();
  const from = m.from.trim().toUpperCase();
  const dormant = readHandRoutes().dormant;
  if (dormant.resourceAddresses.has(to)) {
    if (from === to || isLive(to)) return null;
    const reader = dormant.routes[to] ?? 'GUARDIAN';
    const target = to === 'RES' && from !== 'RES-INFRA' && isLive('RES-INFRA') ? 'RES-INFRA' : reader;
    if (target === from) return null;
    return {
      to: target,
      refs: [...(m.refs ?? []).filter((r) => !r.startsWith(REROUTED_FROM_REF)), `${REROUTED_FROM_REF}${to}`],
      body: `[rerouted from ${to} · no live tab] ${m.body}`,
      digest: false,
      note: `${to} has no live tab — rerouted to ${target}`,
    };
  }
  const r = dormantReroute(m, { isLive });
  return r && r.to.trim().toUpperCase() === from ? null : r;
}
