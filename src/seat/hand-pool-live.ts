// FEDERATION HAND POOL — live wiring. No ledger of its own: seat registry ⊕ federation.yaml (hands · home), the release
// checklist (owner · status · claim history), main's landed PRs (git log), els panes (SEAT-STATE-ENUM state · since).
// Every source is fail-soft: an unreadable one contributes nothing, so the view degrades to «fewer facts», never a throw.

import { spawnSync } from 'node:child_process';
import { buildHandPool, type HandPoolEntry, type PoolPane } from './hand-pool.js';

const LANDED_WINDOW = '48.hours';

/** `(#40072)` in main's subjects of the window → the landed PR numbers. */
export function landedPrsFromSubjects(subjects: string): Set<number> {
  const out = new Set<number>();
  for (const m of subjects.matchAll(/\(#(\d{3,6})\)/g)) out.add(Number(m[1]));
  return out;
}

/** els panes → seat → {state, since}: the busiest pane wins when a seat has two. */
export function paneStatesOf(panes: readonly { seat?: unknown; status?: unknown }[]): Map<string, PoolPane> {
  const rank = (state: string): number => (state === 'EXITED' ? 0 : state === 'IDLE' ? 1 : 2);
  const out = new Map<string, PoolPane>();
  for (const pane of panes) {
    if (typeof pane.seat !== 'string' || !pane.seat) continue;
    const status = pane.status as { state?: unknown; since?: unknown } | undefined;
    if (!status || typeof status.state !== 'string' || typeof status.since !== 'number') continue;
    const seat = pane.seat.toUpperCase();
    const prev = out.get(seat);
    if (!prev || rank(status.state) > rank(prev.state)) out.set(seat, { state: status.state, since: status.since });
  }
  return out;
}

function idleCloseHours(): number | undefined {
  try {
    const { getUserConfig } = require('../user-config/reader.js') as typeof import('../user-config/reader.js');
    const value = (getUserConfig().raw?.federation as { handPool?: { idleCloseHours?: unknown } } | undefined)?.handPool?.idleCloseHours;
    return typeof value === 'number' && value > 0 ? value : undefined;
  } catch { return undefined; }
}

export async function liveHandPool(input: { panes?: readonly { seat?: unknown; status?: unknown }[]; now?: number; cwd?: string } = {}): Promise<HandPoolEntry[]> {
  const now = input.now ?? Date.now();
  const { declaredFederationSeats } = require('../msg/seat-mail-trust.js') as typeof import('../msg/seat-mail-trust.js');
  const { loadFederationLadder } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
  const { resolveSeatStateRoot } = require('../loops/msg-wake.js') as typeof import('../loops/msg-wake.js');
  const seats = (() => { try { return declaredFederationSeats({ stateRoot: resolveSeatStateRoot() }); } catch { return new Set<string>(); } })();
  const ladder = loadFederationLadder(input.cwd ? { cwd: input.cwd } : {});
  let cells: Parameters<typeof buildHandPool>[0]['cells'] = [];
  let history: Parameters<typeof buildHandPool>[0]['history'] = [];
  try {
    const { checklistDevVersion, listChecklist } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js');
    const list = listChecklist(checklistDevVersion());
    cells = list.items;
    history = list.history;
  } catch { /* no checklist → no cells */ }
  let landedPrs = new Set<number>();
  const git = spawnSync('git', ['log', 'origin/main', `--since=${LANDED_WINDOW}`, '--format=%s'], { cwd: input.cwd ?? process.cwd(), encoding: 'utf8', timeout: 10_000 });
  if (git.status === 0) landedPrs = landedPrsFromSubjects(git.stdout);
  // OWNER-IDLE-WAKE: an unreadable pane list (null) is «unknown», not «no panes» — the ledgers alone decide then.
  let panes: readonly { seat?: unknown; status?: unknown }[] | null | undefined = input.panes;
  if (!panes) {
    try { panes = await (require('../cli/els-cli.js') as typeof import('../cli/els-cli.js')).federationPanesForPool(); } catch { panes = null; }
  }
  const hours = idleCloseHours();
  return buildHandPool({ now, seats, ladder, cells, history, landedPrs, ...(panes ? { panes: paneStatesOf(panes) } : {}), ...(hours ? { idleCloseHours: hours } : {}) });
}
