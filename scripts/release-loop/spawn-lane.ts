import { planShards } from './shard-plan';
import { isGateSpawnLaneFile } from '../../src/self-dev/spawn-lane-files.js';
export { GATE_SPAWN_LANE_FILES, isGateSpawnLaneFile } from '../../src/self-dev/spawn-lane-files.js';

/**
 * Gate tests that exercise a real process or PTY. Keep them in their own Pod
 * shards so an external CLI/terminal stall cannot consume an ordinary shard's
 * deadline. These are file paths at the cut commit, not test title patterns.
 *
 * 0.2.29 (2026-10-15): these files from the failed gate attempts launch a
 * real child. Add a file only after checking its test body, not merely because
 * its name mentions a process.
 */
export const GATE_SPAWN_LANE_SHARDS = 3;

/** Every assigned test file is returned exactly once, including a partial gate. */
export function partitionGateSpawnLane(files: readonly string[]): { regular: string[]; spawn: string[] } {
  const regular: string[] = [];
  const spawn: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) throw new Error(`duplicate gate test file: ${file}`);
    seen.add(file);
    (isGateSpawnLaneFile(file) ? spawn : regular).push(file);
  }
  return { regular, spawn };
}

/** Reserve at most three of the configured shards for real process tests.
 * Keeping those files out of ordinary shards preserves coverage and leaves
 * the total shard count unchanged when enough regular files exist. */
export function planGateSpawnSeparatedShards(files: readonly string[], durations: Map<string, number>, shardCount: number): {
  shards: Array<{ files: string[]; plannedSeconds: number }>;
  spawnFiles: string[];
  spawnShardCount: number;
} {
  const { regular, spawn } = partitionGateSpawnLane(files);
  if (regular.length && spawn.length && shardCount < 2) {
    throw new Error('gate spawn lane needs at least two shards when regular and spawn tests coexist');
  }
  const spawnShardCount = Math.min(GATE_SPAWN_LANE_SHARDS, spawn.length, shardCount - (regular.length ? 1 : 0));
  const regularCount = regular.length ? shardCount - spawnShardCount : 0;
  return {
    shards: [
      ...(regular.length ? planShards(regular, durations, regularCount) : []),
      ...(spawn.length ? planShards(spawn, durations, spawnShardCount) : []),
    ],
    spawnFiles: spawn,
    spawnShardCount,
  };
}
