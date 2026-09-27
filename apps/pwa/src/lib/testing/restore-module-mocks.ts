// `mock.module` is process-global in `bun test` — a file that swaps a module and never
// swaps it back hands its fake to every file that runs after it (R-TST23).
//
// ⭐ Why this exists. On 2026-09-27 the full suite failed `IntakeFrontDoor.test.tsx` six
// times while it passed alone: four files (`XtermView`, `TerminalChatDock`, `TuiMirrorView`,
// `EmbeddingVisionTierCard` tests) mocked `DaemonProvider` and friends without restoring,
// and the intake page picked up their fake `useDaemon()`. Each file had grown its own
// half-restore or none; this is the one place that does it.
//
// Call it BEFORE the `mock.module(...)` lines, passing the same specifiers and an importer
// written in the test file itself (`(s) => import(s)`).
// ⛔ Only bare or alias specifiers (`@xterm/xterm`, `@/components/terminal/XtermView`). A relative one
// (`./XtermView`) would load correctly through the test file's importer, but the restoring
// `mock.module` call below runs HERE and would resolve it against this helper — the fake was
// never put back (2026-09-27: `XtermView.test.tsx` and `TerminalPanel.test.tsx` broke 23 later tests).
import { afterAll, mock } from 'bun:test';

export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

/** Snapshot each module's real exports now and put them back in `afterAll`.
 *  A module that cannot be imported outside a browser (e.g. xterm) has no snapshot and is skipped. */
export async function restoreModuleMocksAfterAll(
  specifiers: readonly string[],
  load: ModuleLoader,
): Promise<ReadonlySet<string>> {
  const relative = specifiers.filter((specifier) => specifier.startsWith('.'));
  if (relative.length > 0) {
    throw new Error(`restoreModuleMocksAfterAll: use an alias instead of a relative specifier (${relative.join(', ')}) — mock with the same alias`);
  }
  const originals = new Map<string, Record<string, unknown>>();
  for (const specifier of specifiers) {
    try {
      originals.set(specifier, { ...(await load(specifier)) });
    } catch {
      // no snapshot — nothing to restore
    }
  }
  afterAll(() => {
    for (const [specifier, original] of originals) mock.module(specifier, () => original);
  });
  return new Set(originals.keys());
}
