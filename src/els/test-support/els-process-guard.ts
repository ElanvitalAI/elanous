// ELS-TEST-PTY-LEAK-FU — els tests that start servers or pane holders must not leave them behind (each holder pins a PTY;
// node-b hit 510/511). Structural registry, not a ps scan: holders come from holder.ts's own spawn ledger
// (liveHoldersSpawnedHere), server child processes are registered by the test that spawned them (trackElsServer).
// reapElsProcesses = the cleanup a test runs in afterEach/afterAll · guardElsProcesses = the file-level check that FAILS
// the run (and still reaps) when anything is alive at the end.

import { liveHoldersSpawnedHere } from '../holder.js';

interface Killable { readonly pid: number; kill(signal?: NodeJS.Signals): void }
interface ChildLike extends Killable { readonly exitCode: number | null; readonly signalCode?: string | null }

const servers = new Set<ChildLike>();
// bun test runs every file in one process: what was already alive when this file registered its guard is an earlier
// file's leak — not this file's to reap or to fail on. The process-exit hook still sees (and fails on) all of it.
let fileBaseline = new Set<number>();
const REAP_WAIT_MS = 5_000; // holder SIGTERM path = snapshot flush + child kill + unlink; well under this
const REAP_POLL_MS = 50;

/** A test that spawns an els server as a child process registers it here. */
export function trackElsServer(child: ChildLike): void { servers.add(child); }

export interface LiveElsProcess { readonly pid: number; readonly kind: 'holder' | 'server' }

function liveEntries(all = false): { readonly kind: LiveElsProcess['kind']; readonly proc: Killable }[] {
  const liveServers = [...servers].filter((child) => child.exitCode === null && !child.signalCode);
  for (const child of servers) if (!liveServers.includes(child)) servers.delete(child);
  return [...liveHoldersSpawnedHere().map((proc) => ({ kind: 'holder' as const, proc })), ...liveServers.map((proc) => ({ kind: 'server' as const, proc }))]
    .filter(({ proc }) => all || !fileBaseline.has(proc.pid));
}

/** Every els server/holder this process spawned that is still alive. */
export function liveElsProcesses(): LiveElsProcess[] { return liveEntries().map(({ kind, proc }) => ({ pid: proc.pid, kind })); }

/** SIGTERM everything still alive (a holder then kills its pane child and removes its socket/meta), SIGKILL what remains. */
export async function reapElsProcesses(waitMs = REAP_WAIT_MS): Promise<LiveElsProcess[]> {
  const doomed = liveEntries();
  for (const { proc } of doomed) { try { proc.kill('SIGTERM'); } catch { /* already gone */ } }
  const stop = Date.now() + waitMs;
  while (liveEntries().length > 0 && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, REAP_POLL_MS));
  for (const { proc } of liveEntries()) { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
  return doomed.map(({ kind, proc }) => ({ pid: proc.pid, kind }));
}

/** Throws (listing them) when any els server/holder is alive. */
export function assertNoElsLeaks(live: readonly LiveElsProcess[] = liveElsProcesses()): void {
  if (live.length === 0) return;
  throw new Error(`els test leak: ${live.length} process(es) still alive — ${live.map((row) => `${row.kind} pid ${row.pid}`).join(', ')}`);
}

let exitHooked = false;
/** File-level guard: after all tests, anything still alive fails the run (and is reaped so the PTY comes back). */
export function guardElsProcesses(): void {
  if (!exitHooked) {
    exitHooked = true;
    // Last line of defence at process exit (sync only): list, kill and fail.
    process.once('exit', () => {
      const live = liveEntries(true);
      if (live.length === 0) return;
      process.stderr.write(`els test leak at exit: ${live.map(({ kind, proc }) => `${kind} pid ${proc.pid}`).join(', ')}\n`);
      for (const { proc } of live) { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
      process.exitCode = 1;
    });
  }
  fileBaseline = new Set(liveEntries(true).map(({ proc }) => proc.pid));
  const { afterAll } = require('bun:test') as typeof import('bun:test');
  afterAll(async () => {
    const leaked = liveElsProcesses();
    await reapElsProcesses();
    assertNoElsLeaks(leaked);
  }, REAP_WAIT_MS * 3);
}
