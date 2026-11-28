// KIT mail-route · sender entrance — the ONE routing step both sender entrances (CLI `msg post` · MsgPost tool) run
// before the gate: ✋ hand-block routing by root (hand-routes.yaml), then dormant-address reroute (live probe). The
// envelope is updated in place; every move is returned so the entrance logs it and tells the sender one line. A first ✋
// also gets its `hand-ask:` ref here — the post layer answers the same ask inside the dedupe window by reference.
import type { WakeDeps } from '../../loops/msg-wake.js';
import type { RerouteInput } from '../../msg/dormant-reroute.js';
import { routeDormant } from './dormant.js';
import { liveHandCellLookups, liveHandParentOf, type HandCellLookups } from './hand-cells.js';
import { cheapHandClassifier } from './hand-classifier.js';
import { routeHandMail, type HandRoot, type HandRootClassifier } from './hand-route.js';
import type { HandRoutesTable } from './hand-routes.js';

export interface EntranceEnvelope extends RerouteInput {
  to: string;
  body: string;
  refs?: string[];
  readonly replyTo?: number | null;
}

export interface EntranceMove {
  readonly kind: 'hand-route' | 'dormant-reroute';
  readonly to: string;
  readonly into: string;
  readonly note: string;
  readonly digest?: boolean;
  readonly root?: HandRoot;
}

export interface EntranceOptions {
  readonly isLive?: (address: string) => boolean;
  readonly wakeDeps?: WakeDeps;
  /** Defaults to Jev, the decision model (null under bun test); `null` = structured codes only. */
  readonly classifyHand?: HandRootClassifier | null;
  /** Defaults to the live checklist (null under bun test); `null` = no cell lookups. */
  readonly cells?: HandCellLookups | null;
  readonly table?: HandRoutesTable;
  /** The federation ladder parent of a seat — hand-routes.yaml `defaultOwner: coordinator` (live ladder; null under bun test). */
  readonly parentOf?: ((seat: string) => string | null) | null;
}

export async function routeAtEntrance(envelope: EntranceEnvelope, opts: EntranceOptions = {}): Promise<EntranceMove[]> {
  const moves: EntranceMove[] = [];
  const classify = opts.classifyHand === undefined ? (text: string) => cheapHandClassifier(text) : opts.classifyHand;
  const cells = opts.cells === undefined ? liveHandCellLookups() : opts.cells;
  const parentOf = opts.parentOf === undefined ? liveHandParentOf() : opts.parentOf;
  const hand = await routeHandMail(envelope, classify, { ...(opts.table ? { table: opts.table } : {}), claimedCellOf: cells?.claimedCellOf ?? null, cellOwnerOf: cells?.cellOwnerOf ?? null, parentOf });
  if (hand) {
    if (hand.rerouted) moves.push({ kind: 'hand-route', to: envelope.to, into: hand.to, note: hand.note, root: hand.root });
    Object.assign(envelope, { to: hand.to, refs: hand.refs, body: hand.body });
  }
  const dormant = routeDormant(envelope, { ...(opts.isLive ? { isLive: opts.isLive } : {}), ...(opts.wakeDeps ? { wakeDeps: opts.wakeDeps } : {}) });
  if (dormant) {
    moves.push({ kind: 'dormant-reroute', to: envelope.to, into: dormant.to, note: dormant.note, digest: dormant.digest });
    Object.assign(envelope, { to: dormant.to, refs: dormant.refs, body: dormant.body });
  }
  return moves;
}
