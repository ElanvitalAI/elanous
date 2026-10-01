import { describe, expect, test } from 'bun:test';
import { parseShardIdentity, shardBoundaryBlock, withoutShardIdentity } from './shard-boundary-intent.js';

const identity = {
  orchestrationId: 'orchestration-1', shardId: 'task:handler', totalShards: 3, position: 1,
  summary: 'Implement the handler', siblings: [
    { shardId: 'task:route', summary: 'Register the route' },
    { shardId: 'task:screen', summary: 'Build the screen' },
  ],
};

describe('shard boundary intent', () => {
  test('reads the emitted JSON footer and describes both sibling owners', () => {
    const goal = `Implement a handler\n\n## Shard identity\n${JSON.stringify(identity)}`;
    expect(parseShardIdentity(goal)).toMatchObject(identity);
    expect(withoutShardIdentity(goal)).toBe('Implement a handler\n');
    const block = shardBoundaryBlock(parseShardIdentity(goal)!);
    expect(block).toContain('조각 1/3(task:handler): Implement the handler');
    expect(block).toContain('형제 조각이 맡는 일:');
    expect(block).toContain('- task:route: Register the route');
    expect(block).toContain('- task:screen: Build the screen');
    expect(block).toContain('must-fix 를 내지 말 것');
    expect(block).toContain('should-fix 로 «형제 조각 <id> 에 의존»');
    expect(block.length).toBeLessThanOrEqual(800);
  });

  test('missing or malformed identity fails soft without deleting the goal', () => {
    for (const goal of ['Plain goal', 'Plain goal\n\n## Shard identity\n{"shardId":',
      'Plain goal\n\n## Shard identity\n{"shardId":"x","summary":"s","siblings":"wrong"}']) {
      expect(parseShardIdentity(goal)).toBeUndefined();
      expect(withoutShardIdentity(goal)).toBe(goal);
    }
  });

  test('an unusually long identity header still respects the block cap', () => {
    const block = shardBoundaryBlock({ ...identity, shardId: 'x'.repeat(200), summary: 'y'.repeat(1000), siblings: [] });
    expect(block.length).toBeLessThanOrEqual(800);
    expect(block).toContain('must-fix 를 내지 말 것');
  });

  test('long sibling summaries are capped at 240 and an over-budget list ends with the omission count', () => {
    const long = { ...identity, siblings: Array.from({ length: 8 }, (_, index) => ({
      shardId: `task:${index}`, summary: `sibling-${index}-${'x'.repeat(400)}`,
    })) };
    const block = shardBoundaryBlock(long);
    expect(block.length).toBeLessThanOrEqual(800);
    expect(block).toContain('sibling-0-');
    expect(block).not.toContain('x'.repeat(241));
    const retained = [...block.matchAll(/^- task:\d+:/gm)].length;
    expect(retained).toBeGreaterThan(0);
    expect(block).toEndWith(`…외 ${long.siblings.length - retained}`);
  });
});
