import { describe, expect, test } from 'bun:test';
import { parseShardIdentity, shardBoundaryBlock, shardReviewContractBlock, withoutShardIdentity } from './shard-boundary-intent.js';

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

  test('review contract carries declared scope and hands sibling findings off with a refutation check', () => {
    const goal = '대상 경로: src/handler.ts\n보존 계약: route 등록은 바꾸지 않는다';
    const block = shardReviewContractBlock(goal, identity, ['화면은 이 조각에서 만들지 않는다']);
    for (const value of ['대상 경로: src/handler.ts', '형제 조각이 맡는 일:', '- task:route: Register the route',
      '- task:screen: Build the screen', '보존 계약: route 등록은 바꾸지 않는다',
      '의도적 경계: 화면은 이 조각에서 만들지 않는다', 'out-of-scope → 담당 형제 조각 <id>',
      'must-fix마다', '반증 확인 한 줄']) expect(block).toContain(value);
    expect(block.length).toBeLessThanOrEqual(1400);
  });

  test('authored goal with verbatim ask keeps its original identity while rendering declared scope', () => {
    const ask = ['대상 경로: src/handler.ts', '보존 계약: 화면 기본 동작 유지',
      '## Shard identity', JSON.stringify(identity)].join('\n');
    const goal = `## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n\`\`\`\n${ask}\n\`\`\`\n## SCOPE BOUNDARY\n- 의도적 경계: 화면은 task:screen 담당`;
    expect(parseShardIdentity(goal)).toMatchObject(identity);
    expect(withoutShardIdentity(goal)).toBe(goal);
    const suffixGoal = `${goal}\n## Shard identity\n${JSON.stringify(identity)}`;
    expect(withoutShardIdentity(suffixGoal)).toBe(goal);
    const block = shardReviewContractBlock(goal, parseShardIdentity(goal)!, ['의도적 경계: 화면은 task:screen 담당']);
    for (const text of ['대상 경로: src/handler.ts', '보존 계약: 화면 기본 동작 유지',
      '- task:route: Register the route', '- task:screen: Build the screen',
      '의도적 경계: 화면은 task:screen 담당', 'out-of-scope → 담당 형제 조각 <id>', '반증 확인 한 줄']) expect(block).toContain(text);
    expect(block.length).toBeLessThanOrEqual(1400);
  });

  test('an invalid top-level footer does not fall back to the identity quoted in the original ask', () => {
    const ask = ['대상 경로: src/handler.ts', '## Shard identity', JSON.stringify(identity)].join('\n');
    const goal = `## WHAT TO BUILD\nOriginal ask (verbatim, unmodified):\n\`\`\`\n${ask}\n\`\`\`\n## Shard identity\n{"shardId":`;
    expect(parseShardIdentity(goal)).toBeUndefined();
  });

  test('review contract gives sibling-owned work one classification (out-of-scope), not should-fix', () => {
    const block = shardReviewContractBlock('대상 경로: src/handler.ts', identity, []);
    expect(block).toContain('out-of-scope → 담당 형제 조각 <id>');
    expect(block).not.toContain('should-fix 로 «형제 조각');
    expect(shardBoundaryBlock(identity)).toContain('should-fix 로 «형제 조각');
  });

  test('a long boundary does not truncate declared target paths while space remains', () => {
    const paths = Array.from({ length: 14 }, (_, index) => `src/area/module-${index}.ts`);
    const goal = `대상 경로: ${paths.join(' · ')}\n보존 계약: 원장 형식 유지`;
    const block = shardReviewContractBlock(goal, identity, ['긴 경계 '.repeat(400)]);
    for (const path of paths) expect(block).toContain(path);
    expect(block).toContain('보존 계약: 원장 형식 유지');
    expect(block).toContain('의도적 경계: 긴 경계');
    expect(block.length).toBeLessThanOrEqual(1400);
  });

  test('single-shard identity does not invent a sibling owner', () => {
    const single = { ...identity, shardId: 'task:9c668ef09056', position: 1, totalShards: 1, siblings: [] };
    const goal = `대상 경로: src/handler.ts\n## Shard identity\n${JSON.stringify(single)}`;
    const parsed = parseShardIdentity(goal);
    expect(parsed?.siblings).toEqual([]);
    const block = shardReviewContractBlock(goal, parsed!, []);
    expect(block).toContain('형제 샤드: 없음(단일 조각)');
    expect(block).toContain('담당을 특정할 수 없으면 미지정으로 적고 추측하지 말 것');
  });

  test('ordinary quoted identity does not create a shard contract', () => {
    const quoted = `## Background\n\`\`\`json\n## Shard identity\n${JSON.stringify(identity)}\n\`\`\``;
    expect(parseShardIdentity(quoted)).toBeUndefined();
    expect(withoutShardIdentity(quoted)).toBe(quoted);
  });

  test('unprovided scope is not invented and the rules survive a long declaration', () => {
    const block = shardReviewContractBlock('Plain goal', identity, ['boundary '.repeat(800)], ['src/handler.ts']);
    expect(block).toContain('대상 경로(변경 파일 관측 · 골 선언 아님): src/handler.ts');
    expect(block).toContain('보존 계약: 골에 명시되지 않음');
    expect(block).toContain('의도적 경계: boundary');
    expect(block).toContain('out-of-scope → 담당 형제 조각 <id>');
    expect(block).toContain('반증 확인 한 줄');
    expect(block.length).toBeLessThanOrEqual(1400);
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
