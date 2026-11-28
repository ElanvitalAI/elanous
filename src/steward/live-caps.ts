/** Strict, fresh capacity observation. Existing fail-soft pool consumers remain unchanged. */
import { homedir } from 'node:os';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { resolveSeatStateRoot } from '../loops/msg-wake.js';
import { declaredFederationSeatsStrict } from '../msg/seat-mail-trust.js';
import { loadFederationLadderStrict } from '../msg/hand-raise-ladder.js';
import { poolHands } from '../seat/hand-pool.js';
import { federationPanesForPool } from '../cli/els-cli.js';
import { loadStewardCapsPolicy, stewardCaps, type StewardCaps } from './caps-policy.js';

export function verifiedHandCount(seats: ReadonlySet<string> | null, ladder: Parameters<typeof poolHands>[1] | null, panes: readonly { seat?: unknown; status?: unknown }[] | null): number | null {
  if (!seats || !ladder || !panes) return null;
  const hands = new Set(poolHands(seats, ladder));
  const active = new Set<string>();
  for (const pane of panes) {
    if (typeof pane.seat !== 'string' || !hands.has(pane.seat.trim().toUpperCase())) continue;
    const status = pane.status as { state?: unknown; since?: unknown } | null;
    if (!status || typeof status.state !== 'string' || !status.state || typeof status.since !== 'number' || !Number.isFinite(status.since)) return null;
    if (status.state.toUpperCase() !== 'EXITED') active.add(pane.seat.trim().toUpperCase());
  }
  return active.size;
}

export async function liveStewardCaps(): Promise<StewardCaps | null> {
  try {
    const root = effectiveInstanceRoot();
    const home = root === prodInstanceRoot() ? homedir() : root;
    const cwd = process.cwd();
    const seats = declaredFederationSeatsStrict({ stateRoot: resolveSeatStateRoot(), cwd, home });
    const ladder = loadFederationLadderStrict({ cwd, home });
    const count = verifiedHandCount(seats, ladder, await federationPanesForPool());
    return stewardCaps(loadStewardCapsPolicy(), count);
  } catch { return null; }
}
