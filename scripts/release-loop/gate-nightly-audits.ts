/** Nightly-only whole-repository cases; gate runs the fixture cases in these same files. */
export const GATE_NIGHTLY_AUDITS: readonly string[] = [
  // Replaces F12's real-repo bucket B apps/pwa scope check and its whole-repo export partition check.
  'test/f12-sweep.test.ts',
  // Replaces unwired-exports' real src/oauth caller check and its src/ad-pipeline CLI scan.
  'scripts/unwired-exports.test.ts',
  // Replaces pwa-build-typecheck's full root tsc and PWA tsc sweeps (PWA build also runs in the release loop).
  'test/pwa-build-typecheck.test.ts',
  // Whole-repository credential scan runs through test-diet's nightly audit flag; gate uses bounded fixtures.
  'scripts/resource-map-check.test.ts',
];
