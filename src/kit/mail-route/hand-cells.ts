// KIT mail-route · the cell a ✋ is about and who owns it — the live lookups behind hand-routes.yaml `cell-owner` and
// the `hand-ask:<root>:<cell>` dedupe identity. One checklist read per process per minute (the active board version).
// Under bun test there is no live lookup (a test must never open the real ledger); every caller can inject its own.
import { claimedCellOf } from '../../seat/hand-tab-title.js';

export interface HandCellLookups {
  /** The yellow cell `seat` holds (null = none / unknown). */
  readonly claimedCellOf: (seat: string) => string | null;
  /** The checklist owner of `cell` (null = unknown cell). */
  readonly cellOwnerOf: (cell: string) => string | null;
}

interface Row { readonly id: string; readonly status: string; readonly owner?: string; readonly updatedAt?: string }

/** Lookups over a fixed cell list. Pure. */
export function handCellLookupsFrom(cells: () => readonly Row[]): HandCellLookups {
  return {
    claimedCellOf: (seat) => { try { return claimedCellOf(seat, cells()) ?? null; } catch { return null; } },
    cellOwnerOf: (cell) => { try { return cells().find((c) => c.id.toUpperCase() === cell.trim().toUpperCase())?.owner ?? null; } catch { return null; } },
  };
}

const CACHE_MS = 60_000;
let cached: { at: number; rows: readonly Row[] } | null = null;

/** The live lookups (null under bun test). Read failures answer «unknown», never throw. */
export function liveHandCellLookups(): HandCellLookups | null {
  if (process.env.BUN_TEST !== undefined || process.env.NODE_ENV === 'test') return null;
  return handCellLookupsFrom(() => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.rows;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { listChecklist } = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
    const { activeBoardVersion } = require('../../ops-dashboard/current-version.js') as typeof import('../../ops-dashboard/current-version.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    let rows: readonly Row[] = [];
    try { rows = listChecklist(activeBoardVersion()).items; } catch { rows = []; }
    cached = { at: Date.now(), rows };
    return rows;
  });
}
