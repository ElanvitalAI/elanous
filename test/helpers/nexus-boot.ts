import { runNexus, type RunNexusHandle, type RunNexusOptions } from '../../src/nexus/index.js';
import { stopEventLoopWatchdog } from '../../src/debug/event-loop-watchdog.js';

const activeBoots: RunNexusHandle[] = [];

/** Start a Nexus instance and register it for suite-level cleanup. */
export async function bootNexus(options: RunNexusOptions = {}): Promise<RunNexusHandle | undefined> {
  const handle = await runNexus(options);
  if (handle) activeBoots.push(handle);
  return handle;
}

/** Release every instance started through bootNexus, newest first. Safe to call repeatedly. */
export function drainNexusBoots(): void {
  const errors: unknown[] = [];
  for (const handle of activeBoots.splice(0).reverse()) {
    try { handle.release(); } catch (error) { errors.push(error); }
  }
  // runNexus starts the process-wide event-loop watchdog and release does not stop it; stop it here so the
  // interval and worker do not outlive this file in a shared shard process.
  stopEventLoopWatchdog();
  if (errors.length > 0) throw new AggregateError(errors, `drainNexusBoots: ${errors.length} release(s) failed`);
}
