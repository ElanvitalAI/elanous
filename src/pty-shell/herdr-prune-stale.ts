import type { HerdrRunResult, HerdrRunner } from './herdr-agent-report.js';

const PRUNE_TIMEOUT_MS = 300;

/** Best-effort removal of a prior custom agent left behind in this pane. */
export function pruneStaleHerdrAgent(
  paneId: string,
  seq: string,
  run: HerdrRunner,
): HerdrRunResult {
  const result = run([
    'pane', 'release-agent', paneId,
    '--source', 'custom:elanous', '--agent', 'elanous', '--seq', seq,
  ], { sync: true, timeoutMs: PRUNE_TIMEOUT_MS });
  if (result instanceof Promise) throw new Error('startup prune requires a synchronous herdr runner');
  return result;
}
