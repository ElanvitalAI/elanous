import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { GATE_SPAWN_LANE_FILES, isGateSpawnLaneFile, partitionGateSpawnLane, planGateSpawnSeparatedShards } from './spawn-lane';

test('the live spawn lane separates real child tests without losing or duplicating any gate file', () => {
  for (const file of GATE_SPAWN_LANE_FILES) expect(existsSync(file)).toBe(true);
  const files = ['src/ordinary.test.ts', ...GATE_SPAWN_LANE_FILES, 'test/another.test.ts'];
  const { regular, spawn } = partitionGateSpawnLane(files);
  expect(regular).toEqual(['src/ordinary.test.ts', 'test/another.test.ts']);
  expect(spawn).toEqual([...GATE_SPAWN_LANE_FILES]);
  expect([...regular, ...spawn].sort()).toEqual([...files].sort());
});

test('partial gate keeps only present live spawn files; repeated paths fail closed', () => {
  expect(partitionGateSpawnLane(['test/preview-terminal.test.ts']).spawn).toEqual(['test/preview-terminal.test.ts']);
  expect(() => partitionGateSpawnLane(['test/preview-terminal.test.ts', 'test/preview-terminal.test.ts'])).toThrow('duplicate gate test file');
});

test('a mixed gate plans separate spawn shards and keeps the configured shard budget', () => {
  const files = [...GATE_SPAWN_LANE_FILES, ...Array.from({ length: 9 }, (_, i) => `src/ordinary-${i}.test.ts`)];
  const { shards, spawnFiles, spawnShardCount } = planGateSpawnSeparatedShards(files, new Map(), 6);
  expect(spawnFiles).toEqual([...GATE_SPAWN_LANE_FILES]);
  expect(spawnShardCount).toBe(3);
  expect(shards).toHaveLength(6);
  expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...files].sort());
  expect(shards.every((shard) => shard.files.every(isGateSpawnLaneFile)
    || shard.files.every((file) => !isGateSpawnLaneFile(file)))).toBe(true);
  expect(planGateSpawnSeparatedShards(files, new Map(), 2).shards).toHaveLength(2);
  expect(() => planGateSpawnSeparatedShards(files, new Map(), 1)).toThrow('at least two shards');
});
