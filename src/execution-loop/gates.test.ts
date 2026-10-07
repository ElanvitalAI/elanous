import { describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import type { TaskCard } from '../task-cards/card-store.js';
import type { BudgetInputs } from '../self-implement/budget-gate.js';
import { CONTEXT_CARD_SCREEN_CHARS } from '../context-card/index.js';
import { budgetGate, memoryGate, placementGate, relationGate } from './gates.js';

const card: TaskCard = {
  id: 'card-a', goalId: 'goal-a', title: 'Implement card', status: 'open', createdAt: '2026-09-29', sections: [],
};

// The budget gate uses the production decision algorithm with injected measurements.
describe('execution-loop gates', () => {
  test('budget preserves proceed, next-provider, wait-reset and stop with their measured reasons', async () => {
    const inputs = {
      preference: { mode: 'auto' as const, chain: [{ provider: 'openai-codex' }, { provider: 'grok' }], budgetGate: { minHeadroomPercent: 15, onShortfall: 'next-provider' as const }, source: { mode: 'inferred' as const, chain: 'fallbackChain' as const } },
      codexCandidates: [{ name: 'default', usedPercent: 85, reached: false }],
      grokUsedPercent: 7,
      maxUsedPercent: { 'openai-codex': 95, grok: 48 },
    };
    const { decideBudget } = await import('../self-implement/budget-gate.js');
    const run = (input: BudgetInputs) => budgetGate({ readInputs: async () => input, decide: decideBudget });
    const proceed = await run(inputs);
    expect(proceed.decision.action).toBe('proceed');
    expect(proceed.decision.provider).toBe('openai-codex');
    expect(proceed.explanation).toContain('85%');

    const exhausted = { ...inputs, codexCandidates: [{ name: 'default', usedPercent: 100, reached: true }] };
    const next = await run(exhausted);
    expect(next.decision.action).toBe('next-provider');
    expect(next.decision.provider).toBe('grok');
    expect(next.explanation).toContain('grok: 7% < 48');

    const shortfall = { ...exhausted, grokUsedPercent: 49 };
    expect((await run(shortfall)).decision.action).toBe('stop');
    expect((await run(shortfall)).explanation).toContain('grok: 49% ≥ 48');
    const wait = { ...shortfall, preference: { ...shortfall.preference, budgetGate: { ...shortfall.preference.budgetGate, onShortfall: 'wait-reset' as const } } };
    expect((await run(wait)).decision.action).toBe('wait-reset');
  });

  test('placement honors local-only requirements and never probes pool reachability', () => {
    let calls = 0;
    const deps = {
      resolveSubstrate: ({ flag }: { flag?: { substrate?: 'local' | 'pod'; podPool?: string } }) => {
        calls++;
        return flag?.substrate === 'local'
          ? { substrate: 'local' as const, pool: null, source: 'flag' as const }
          : { substrate: 'pod' as const, pool: 'node-b', source: 'flag' as const };
      },
      memoryLimit: () => ({ limit: '8Gi', tier: 'large', source: 'goal' }),
    };
    const pod = placementGate({ goal: 'implement', needsBrowser: false, needsVideo: false, needsAppSigning: false, localFiles: [], flag: { substrate: 'pod' } }, deps);
    expect(pod.decision).toMatchObject({ substrate: 'pod', pool: 'node-b', poolReachability: 'unknown', memory: { limit: '8Gi', tier: 'large' }, unknownInputs: [] });
    expect(pod.explanation).toContain('reachability=unknown (not checked)');
    const local = placementGate({ goal: 'test', needsBrowser: true, localFiles: ['~/temp/input.txt'], flag: { substrate: 'pod' } }, deps);
    expect(local.decision).toMatchObject({ substrate: 'local', poolReachability: 'not-applicable', localReasons: ['browser', 'local files: ~/temp/input.txt'], unknownInputs: ['needsVideo', 'needsAppSigning'] });
    expect(local.explanation).toContain('browser');
    expect(calls).toBe(2);
  });

  test('omitted local needs and substrate remain unknown without probing or inventing a pod', () => {
    const query = spyOn(childProcess, 'spawnSync');
    let resolved = 0;
    try {
      const result = placementGate({ goal: 'implement' }, {
        resolveSubstrate: () => { resolved++; return { substrate: 'pod', pool: 'node-b', source: 'flag' }; },
        memoryLimit: () => { throw new Error('unmeasured placement must not estimate pod memory'); },
      });
      expect(result.decision).toEqual({ substrate: 'unknown', pool: null, source: 'unknown', poolReachability: 'unknown', localReasons: [], unknownInputs: ['needsBrowser', 'needsVideo', 'needsAppSigning', 'localFiles', 'substrate'] });
      expect(result.explanation).toContain('placement=unknown; unmeasured=needsBrowser, needsVideo, needsAppSigning, localFiles, substrate');
      expect(result.explanation).not.toContain('pod:');
      const requestedPod = placementGate({ goal: 'implement', flag: { substrate: 'pod' } }, {
        resolveSubstrate: () => { resolved++; return { substrate: 'pod', pool: 'node-b', source: 'flag' }; },
        memoryLimit: () => { throw new Error('unmeasured local needs must not estimate pod memory'); },
      });
      expect(requestedPod.decision).toMatchObject({ substrate: 'unknown', unknownInputs: ['needsBrowser', 'needsVideo', 'needsAppSigning', 'localFiles'] });
      expect(requestedPod.explanation).toContain('placement=unknown');
      expect(resolved).toBe(0);
      expect(query).toHaveBeenCalledTimes(0);
    } finally {
      query.mockRestore();
    }
  });

  test('known pod requirements with an unconfigured pool leave reachability unknown without querying kubectl', () => {
    const original = process.env.ELANOUS_POD_POOL;
    const query = spyOn(childProcess, 'spawnSync');
    try {
      delete process.env.ELANOUS_POD_POOL;
      const result = placementGate({ goal: 'implement', needsBrowser: false, needsVideo: false, needsAppSigning: false, localFiles: [], flag: { substrate: 'pod' } });
      expect(result.decision).toMatchObject({ substrate: 'pod', pool: null, poolReachability: 'unknown', unknownInputs: [] });
      expect(result.explanation).toContain('reachability=unknown (not checked)');
      expect(query).toHaveBeenCalledTimes(0);
    } finally {
      query.mockRestore();
      if (original === undefined) delete process.env.ELANOUS_POD_POOL;
      else process.env.ELANOUS_POD_POOL = original;
    }
  });

  test('unknown pod pool stays unknown without querying cluster reachability', () => {
    const podInput = { goal: 'implement', needsBrowser: false, needsVideo: false, needsAppSigning: false, localFiles: [], flag: { substrate: 'pod' as const } };
    const decision = placementGate(podInput, {
      resolveSubstrate: () => { throw new Error('harness.substrate=pod: Pod 풀 또는 현재 컨텍스트에 닿지 못했다 — 풀을 설정하라'); },
      memoryLimit: () => ({ limit: '4Gi', tier: 'standard', source: 'goal' }),
    });
    expect(decision.decision).toMatchObject({ substrate: 'pod', pool: null, poolReachability: 'unknown' });
    expect(decision.explanation).toContain('pool=unknown');
    expect(() => placementGate(podInput, {
      resolveSubstrate: () => { throw new Error('unexpected resolver failure'); },
      memoryLimit: () => ({ limit: '4Gi', tier: 'standard', source: 'goal' }),
    })).toThrow('unexpected resolver failure');
  });

  test('relations record open overlapping cards and existing runs without blocking', async () => {
    const other: TaskCard = {
      ...card, id: 'card-b', goalId: 'goal-b',
      sections: [{ key: 'workspace:r1', owner: 'executor', content: JSON.stringify({ targetPaths: ['src/a.ts'] }), createdAt: '2026-09-29' }],
    };
    const r = await relationGate(card, ['src/a.ts'], {
      openCards: () => [card, other, { ...other, id: 'closed', status: 'closed' }],
      priorTermination: () => 'abandoned', activeRuns: () => ['run-1'],
      preflightOverlaps: () => ['src/a.ts'], dependsOn: () => ['goal-prerequisite'], similarCards: () => ['card-c'],
    });
    expect(r.decision).toEqual({ action: 'record', overlappingCards: ['card-b'], preflightOverlaps: ['src/a.ts'], dependsOn: ['goal-prerequisite'], similarCards: ['card-c'], sameGoalActiveRuns: ['run-1'], priorTermination: 'abandoned' });
    expect(r.explanation).toContain('overlaps do not block launch');
  });

  test('unmeasured relations stay unknown while measured empty relations say none', async () => {
    const base = { openCards: () => [card], priorTermination: () => undefined, activeRuns: () => [] };
    const missing = await relationGate(card, [], base);
    expect(missing.decision).toMatchObject({
      preflightOverlaps: 'unknown', dependsOn: 'unknown', similarCards: 'unknown',
    });
    expect(missing.explanation).toContain('preflight=unknown; dependsOn=unknown; similar=unknown');

    const measured = await relationGate(card, [], {
      ...base, preflightOverlaps: () => [], dependsOn: () => [], similarCards: () => [],
    });
    expect(measured.decision).toMatchObject({ preflightOverlaps: [], dependsOn: [], similarCards: [] });
    expect(measured.explanation).toContain('preflight=none; dependsOn=none; similar=none');
  });

  test('memory puts prior must-fix before recall and truncates to the screen code-point budget', async () => {
    const goalIds: string[] = [];
    const result = await memoryGate(card, {
      recall: async (query) => { expect(query).toBe(card.title); return 'x'.repeat(3_000); },
      priorAbandonment: () => undefined,
      priorMustFix: (goalId) => { goalIds.push(goalId); return ['A 를 고쳐라', 'B 시험 추가']; },
    });
    expect(goalIds).toEqual([card.goalId]);
    expect(result.decision.context.startsWith('앞선 must-fix:\n- A 를 고쳐라\n- B 시험 추가\n')).toBe(true);
    expect([...result.decision.context].length).toBeLessThanOrEqual(CONTEXT_CARD_SCREEN_CHARS);
    expect(result.explanation).toContain('truncated');
    expect(result.explanation).toContain('chars=1600/1600');
    expect(result.decision).toMatchObject({ action: 'record', fragmentIds: [] });
    expect(result.decision).not.toHaveProperty('priorAbandonment');
  });

  test('memory keeps short recall unchanged without prior must-fix', async () => {
    const result = await memoryGate(card, { recall: async () => 'r1', priorAbandonment: () => undefined });
    expect(result.decision.context).toBe('r1');
    expect(result.explanation).not.toContain('truncated');
  });

  test('memory keeps context empty when recall and prior must-fix are both empty', async () => {
    const result = await memoryGate(card, {
      recall: async () => '', priorAbandonment: () => undefined, priorMustFix: () => [],
    });
    expect(result.decision.context).toBe('');
    expect(result.explanation).not.toContain('truncated');
  });

  test('memory keeps prior must-fix when recall is empty', async () => {
    const result = await memoryGate(card, {
      recall: async () => '', priorAbandonment: () => undefined, priorMustFix: () => ['previous fix', 'second fix'],
    });
    expect(result.decision.context).toBe('앞선 must-fix:\n- previous fix\n- second fix');
    expect(result.explanation).toContain('memory=none or unavailable');
    expect(result.explanation).not.toContain('truncated');
  });

  test('memory propagates a recall error instead of swallowing it', async () => {
    await expect(memoryGate(card, {
      recall: async () => { throw new Error('recall unavailable'); },
      priorAbandonment: () => undefined, priorMustFix: () => ['previous fix'],
    })).rejects.toThrow('recall unavailable');
  });

  test('memory truncates by code points without splitting a surrogate pair', async () => {
    const result = await memoryGate(card, {
      recall: async () => '🎯'.repeat(CONTEXT_CARD_SCREEN_CHARS + 1), priorAbandonment: () => undefined,
    });
    expect([...result.decision.context]).toHaveLength(CONTEXT_CARD_SCREEN_CHARS);
    expect(result.decision.context).toBe('🎯'.repeat(CONTEXT_CARD_SCREEN_CHARS));
    expect(result.explanation).toContain('truncated');
  });

  test('memory records recall and historical abandonment without modifying the goal', async () => {
    const query: string[] = [];
    const result = await memoryGate(card, {
      recall: async (q) => { query.push(q); return '[elanous 기억] previous implementation'; },
      priorAbandonment: () => 'quota-exhausted',
    });
    expect(query).toEqual(['Implement card']);
    expect(result.decision).toEqual({ action: 'record', context: '[elanous 기억] previous implementation', fragmentIds: [], priorAbandonment: 'quota-exhausted' });
    expect(result.explanation).toContain('fragment IDs unavailable');
    expect(card.title).toBe('Implement card');
  });
});
