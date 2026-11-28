// CURRENT-RELEASE-ONE-SOURCE (11-28) — the cycle-safe door to «the current board» for library modules that sit inside
// checklist.ts's own import graph. It is `activeBoardVersion()` (ops-dashboard/current-version.ts) and nothing else:
// current-board record → release.graph.version → package checklist version. Never derive the board from the package
// dev version directly — test/board-pointer-ratchet.test.ts refuses new direct uses.

/** The board every reader works on, read fresh on every call. */
export function boardVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js')).activeBoardVersion();
}
