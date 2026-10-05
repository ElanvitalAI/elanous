import { readFileSync } from 'node:fs';
import { plannedSelfImplBranch } from '../harness/worktree-branch-prefix.js';
import { test, expect, describe } from 'bun:test';
import { classifyFailure, classifyFailures, classifyResumeDisposition, dependencyOnMain, hasDelivered, hasLanded, failureFromDeployFindings, formatShardHandoffInput, goalCauseObservedFromFailureClassification, withOrchestrateGoalKey, orchestrateSelfDev, prMergedOnMain, queryPreflightWarning, resolveOrchestrateConcurrency, resumeKey, summarizeFailureKinds, summarizeResults, triageRun, triageActionFor } from './orchestrate.js';
import type { SelfDevJobResult } from './orchestrate.js';
import { parseRunShardIdentity } from '../self-implement/run-ledger.js';
import type { WorkingMemoryEntry } from '../agent-substrate/working-memory-format.js';
import { debug } from '../debug/log.js';
import { decideNextRun } from './run-supervisor.js';
import type { SelfImplementJobSpawn, SelfImplementJobDone } from '../task-orchestrator/surfaces/self-implement.js';
import type { LogRecord } from '../mss/logging/record.js';

test('pushed harvestable child crosses the disposition boundary and is not relaunched on resume', async () => {
  const disposition = { stage: 'timed-out', branch: 'self-impl/finished', harvestable: true as const, ok: false };
  const [result] = await orchestrateSelfDev({
    goals: [{ feature: 'finished merge timeout' }],
    spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 1, output: '', disposition }) }),
  });
  expect(result).toMatchObject({ branch: disposition.branch, harvestable: true, stage: 'timed-out' });
  expect(classifyResumeDisposition(result!)).toBe('skip');
  expect(decideNextRun({ results: [result!] })).toMatchObject({ action: 'stop', stopReason: 'harvestable-awaiting-human' });
});

test('terminal results emit one metadata-only observation per merged, review-budget PR and failed run', async () => {
  const records: LogRecord[] = [];
  const off = debug.registerSink({ name: 'self-implement-result-test', emit: (record) => {
    if (record.category === 'self-implement.result' && record.event === 'final') records.push(record);
  } });
  const secret = 'PRIVATE_RESULT_BODY_DO_NOT_LOG';
  const dispositions = [
    { stage: 'merged', merged: true, runId: 'run-merged', prNumber: 11 },
    { stage: 'pr-opened', mergeReason: 'review-budget-follow-up-required', runId: 'run-review', prNumber: 12 },
    { stage: 'gate-failed', failureClassification: 'run-deadline-exceeded' as const, runId: 'run-failed' },
  ];
  try {
    const results = await orchestrateSelfDev({
      goals: dispositions.map((_, i) => ({ feature: `result-${i}: ${secret}` })),
      concurrency: 3,
      spawn: (input) => {
        const i = Number(input.feature.match(/^result-(\d+)/)?.[1]);
        return { address: input.spaceId, done: Promise.resolve({
          exitCode: i === 2 ? 1 : 0,
          output: secret,
          disposition: dispositions[i],
        }) };
      },
    });
    expect(results).toHaveLength(3);
    expect(records).toHaveLength(3);
    for (let i = 0; i < dispositions.length; i++) {
      expect(results[i]).toMatchObject({
        runId: dispositions[i]!.runId,
        stage: dispositions[i]!.stage,
        status: i === 2 ? 'failed' : 'done',
      });
      expect(records[i]?.data).toMatchObject({
        runId: dispositions[i]!.runId,
        taskId: results[i]!.taskId,
        stage: dispositions[i]!.stage,
        mergeReason: 'mergeReason' in dispositions[i]! ? dispositions[i]!.mergeReason : null,
        failureClassification: 'failureClassification' in dispositions[i]! ? dispositions[i]!.failureClassification : null,
        prNumber: 'prNumber' in dispositions[i]! ? dispositions[i]!.prNumber : null,
      });
      expect(JSON.stringify(records[i])).not.toContain(secret);
    }
  } finally { off(); }
});

test('orchestrated goal carries after through task surface and adapter into Pod spawn', async () => {
  const seen: Array<string | number | undefined> = [];
  const results = await orchestrateSelfDev({
    goals: [{ feature: 'goal with prerequisite', after: 'previous-goal' }, { feature: 'goal after PR', after: 123 }, { feature: 'independent' }],
    concurrency: 3,
    spawn: (input) => {
      seen.push(input.after);
      return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '' }) };
    },
  });
  expect(results).toHaveLength(3);
  expect(seen).toHaveLength(3);
  expect(seen).toContain('previous-goal');
  expect(seen).toContain(123);
  expect(seen).toContain(undefined);
});

function withoutShardIdentity(feature: string): string {
  return feature.replace(/\n\n## Shard identity\n[^\n]*/, '');
}

/** Fake spawn that resolves each job after a macrotask, tracking how many
 *  jobs are simultaneously in-flight so we can assert the concurrency cap. */
function makeTrackingSpawn(opts: { failFeatures?: Set<string>; delayMs?: number } = {}) {
  let live = 0;
  let maxLive = 0;
  const spawn: SelfImplementJobSpawn = (input) => {
    live++;
    maxLive = Math.max(maxLive, live);
    const done = new Promise<SelfImplementJobDone>((resolve) => {
      setTimeout(() => {
        live--;
        const feature = withoutShardIdentity(input.feature);
        if (opts.failFeatures?.has(feature)) resolve({ exitCode: 1, output: `fail ${feature}` });
        else resolve({ exitCode: 0, output: `ok ${feature}` });
      }, opts.delayMs ?? 5);
    });
    return { address: `self-impl:${input.spaceId}`, done };
  };
  return { spawn, maxLive: () => maxLive };
}

function memoryEntry(overrides: Partial<WorkingMemoryEntry> = {}): WorkingMemoryEntry {
  return {
    phaseId: 'phase-1',
    phaseTitle: 'Upstream shard',
    kind: 'implementation',
    at: '2026-08-15T00:00:00.000Z',
    summary: 'Completed upstream work.',
    reusables: [],
    decisions: [],
    ...overrides,
    artifacts: overrides.artifacts ?? [],
  };
}

describe('formatShardHandoffInput', () => {
  test('carries reusable-item and decision entries from populated upstream memory', () => {
    expect(JSON.parse(formatShardHandoffInput([memoryEntry({
      reusables: ['src/contract.ts#format'],
      decisions: ['Preserve the existing contract.'],
    })]))).toEqual({
      upstream: 'available',
      upstreamOutcome: 'unknown',   // ⭐ 추가 칸 — 생략 호출자는 「모른다」
      reusables: ['src/contract.ts#format'],
      decisions: ['Preserve the existing contract.'],
      truncated: false,
    });
  });

  test('distinguishes a completed upstream shard with no entries', () => {
    expect(JSON.parse(formatShardHandoffInput([]))).toEqual({
      upstream: 'empty',
      upstreamOutcome: 'unknown',   // ⭐ 추가 칸 — 생략 호출자는 「모른다」
      reusables: [],
      decisions: [],
      truncated: false,
    });
  });

  test('represents an unreadable upstream result without throwing', () => {
    expect(() => formatShardHandoffInput(null)).not.toThrow();
    expect(JSON.parse(formatShardHandoffInput(undefined))).toEqual({
      upstream: 'unreadable',
      upstreamOutcome: 'unknown',   // ⭐ 추가 칸 — 생략 호출자는 「모른다」
      reusables: [],
      decisions: [],
      truncated: false,
    });
  });

  test('applies structured truncation to empty and unreadable upstream states', () => {
    for (const entries of [[], undefined] as const) {
      const handoff = formatShardHandoffInput(entries, 9);
      expect(() => JSON.parse(handoff)).not.toThrow();
      expect(JSON.parse(handoff)).toEqual({ truncated: true });
    }
  });

  test('deduplicates entries and their reusable-item and decision values through the working-memory contract', () => {
    expect(JSON.parse(formatShardHandoffInput([
      memoryEntry({ reusables: ['old reusable'], decisions: ['old decision'] }),
      memoryEntry({ reusables: [' newest reusable ', 'newest reusable'], decisions: [' newest decision ', 'newest decision'] }),
    ]))).toEqual({
      upstream: 'available',
      upstreamOutcome: 'unknown',   // ⭐ 추가 칸 — 생략 호출자는 「모른다」
      reusables: ['newest reusable'],
      decisions: ['newest decision'],
      truncated: true,
    });
  });

  test('bounds over-limit inputs and renders truncation explicitly', () => {
    const entries = Array.from({ length: 61 }, (_, index) => memoryEntry({
      phaseId: `phase-${index}`,
      reusables: [`reusable-${index}`],
      decisions: [`decision-${index}`],
    }));
    const handoff = JSON.parse(formatShardHandoffInput(entries));

    expect(handoff).toMatchObject({ upstream: 'available', truncated: true });
    expect(handoff.reusables).toEqual(Array.from({ length: 40 }, (_, index) => `reusable-${index + 1}`));
    expect(handoff.decisions).toEqual(Array.from({ length: 40 }, (_, index) => `decision-${index + 1}`));
  });

  test('keeps valid structured truncation below a ten-character limit', () => {
    const handoff = formatShardHandoffInput([memoryEntry({
      reusables: ['a reusable value that cannot fit'],
      decisions: ['a decision value that cannot fit'],
    })], 9);
    expect(() => JSON.parse(handoff)).not.toThrow();
    expect(JSON.parse(handoff)).toEqual({ truncated: true });
  });

  test('does not mark fitting multiple handoffs truncated or discard later values', () => {
    const entries = [
      memoryEntry({ phaseId: 'one', reusables: ['first reusable'], decisions: ['first decision'] }),
      memoryEntry({ phaseId: 'two', reusables: ['second reusable'], decisions: ['second decision'] }),
    ];
    const unbounded = formatShardHandoffInput(entries);
    const handoff = JSON.parse(formatShardHandoffInput(entries, unbounded.length));
    expect(handoff).toEqual({
      upstream: 'available',
      upstreamOutcome: 'unknown',   // ⭐ 추가 칸 — 생략 호출자는 「모른다」
      reusables: ['first reusable', 'second reusable'],
      decisions: ['first decision', 'second decision'],
      truncated: false,
    });
  });
});

describe('resolveOrchestrateConcurrency', () => {
  test('prefers an explicit concurrency value without querying runtime parallelism', () => {
    let queried = false;
    expect(resolveOrchestrateConcurrency(7, {
      availableParallelism: () => {
        queried = true;
        return 3;
      },
    })).toBe(7);
    expect(queried).toBe(false);
  });

  test('uses a usable runtime parallelism value when concurrency is omitted', () => {
    expect(resolveOrchestrateConcurrency(undefined, { availableParallelism: () => 6 })).toBe(6);
  });

  test('preserves unknown concurrency only when «both» runtime rulers fail', () => {
    // ⛔ 계약이 바뀌었다 — 자가 «둘»이다. 하나가 못 내는 것으로는 「모른다」가 되지 않는다.
    const dead = { availableParallelism: () => { throw new Error('unavailable'); }, cpuCount: () => { throw new Error('unavailable'); } };
    expect(resolveOrchestrateConcurrency(undefined, dead)).toBeUndefined();
    for (const value of [0, 0.5, NaN, Infinity, -Infinity]) {
      expect(resolveOrchestrateConcurrency(undefined, { availableParallelism: () => value, cpuCount: () => value })).toBeUndefined();
    }
  });

  test('falls back to the cpu-count ruler when the first ruler yields no usable value', () => {
    // 🔑 실물 근거: `import('pdf-parse')` 뒤에는 os.availableParallelism() 이 undefined 를 돌려주고
    //   os.cpus().length 는 멀쩡하다(실측 2026-08-21). 그 상황을 그대로 재현한다.
    expect(resolveOrchestrateConcurrency(undefined, {
      availableParallelism: () => undefined as unknown as number,
      cpuCount: () => 18,
    })).toBe(18);
    expect(resolveOrchestrateConcurrency(undefined, {
      availableParallelism: () => { throw new Error('patched away'); },
      cpuCount: () => 4,
    })).toBe(4);
  });

  test('does not query the second ruler when the first one answers', () => {
    let second = 0;
    expect(resolveOrchestrateConcurrency(undefined, {
      availableParallelism: () => 6,
      cpuCount: () => { second += 1; return 99; },
    })).toBe(6);
    expect(second).toBe(0);
  });

  test('orchestrateSelfDev exposes «both» rulers so a caller can reproduce a dead first ruler', () => {
    // 🔑 첫째만 열어 두면 호출자가 「첫째가 죽은 상황」을 재현할 수 없다(무인 리뷰 지적 2026-08-21).
    //   ⛔ 여기서는 타입 노출과 «전달»을 함께 문다 — 노출만 하고 안 넘기면 여전히 못 쓴다.
    const source = readFileSync(new URL('./orchestrate.ts', import.meta.url).pathname, 'utf8');
    const optionsBlock = source.slice(
      source.indexOf('export interface OrchestrateSelfDevOptions {'),
      source.indexOf('\n}', source.indexOf('export interface OrchestrateSelfDevOptions {')),
    );
    expect(optionsBlock).toContain('availableParallelism?: () => number;');
    expect(optionsBlock).toContain('cpuCount?: () => number;');

    const callSite = source.slice(source.indexOf('resolveOrchestrateConcurrency(opts.concurrency, {'));
    expect(callSite.slice(0, 200)).toContain('cpuCount: opts.cpuCount');
  });

  test('the real dependency side effect stays covered — resolves after pdf-parse is loaded', async () => {
    // 🔑 이것이 «통합» 회귀 시험이다. 위 seam 시험들은 주입된 자를 보므로
    //   ***「빌트인이 실제로 망가진다」는 사실을 영영 못 본다.***
    //   📏 실측 2026-08-21: import('pdf-parse') 뒤 os.availableParallelism() 이 undefined 를 돌려주고
    //     os.cpus().length 는 멀쩡했다. 그 부작용이 «바뀌거나 사라져도» 이 시험은 여전히 옳다 —
    //     계약은 「그 패키지가 있든 없든 참값을 낸다」이지 「그 패키지가 망가뜨린다」가 아니다.
    const os = await import('node:os');
    await import('pdf-parse');

    const resolved = resolveOrchestrateConcurrency(undefined);

    expect(Number.isInteger(resolved)).toBe(true);
    expect(resolved!).toBeGreaterThan(0);
    // ⛔ 그리고 「모른다」로 접히지 않았음을 «이름으로» 확인한다
    expect(resolved).not.toBeUndefined();
    // 📌 둘째 자가 살아 있는 한 그 값과 같아야 한다(첫째가 죽었을 때의 계약)
    if (!Number.isInteger(os.availableParallelism())) expect(resolved).toBe(os.cpus().length);
  });

  test('an explicit value still short-circuits «both» rulers', () => {
    let asked = 0;
    expect(resolveOrchestrateConcurrency(7, {
      availableParallelism: () => { asked += 1; return 3; },
      cpuCount: () => { asked += 1; return 3; },
    })).toBe(7);
    expect(asked).toBe(0);
  });
});

describe('orchestrateSelfDev (S1 · parallel self-dev driver)', () => {
  test('runs all independent goals to completion', async () => {
    const { spawn } = makeTrackingSpawn();
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'g1' }, { feature: 'g2' }, { feature: 'g3' }],
      spawn,
    });
    expect(results.length).toBe(3);
    expect(results.every((r) => r.status === 'done')).toBe(true);
    expect(new Set(results.map((r) => r.feature))).toEqual(new Set(['g1', 'g2', 'g3']));
  });

  test('respects the concurrency cap — never more than N in flight', async () => {
    const { spawn, maxLive } = makeTrackingSpawn({ delayMs: 8 });
    const goals = Array.from({ length: 6 }, (_, i) => ({ feature: `goal-${i}` }));
    const results = await orchestrateSelfDev({ goals, concurrency: 2, spawn });
    expect(results.length).toBe(6);
    expect(results.every((r) => r.status === 'done')).toBe(true);
    // The whole point of S1: fan-out is bounded by the cap.
    expect(maxLive()).toBeLessThanOrEqual(2);
    // And it actually parallelised (not serialised to 1).
    expect(maxLive()).toBe(2);
  });

  test('same plan branch waits while a different branch overlaps at concurrency 3', async () => {
    const active = new Set<string>();
    const launches: string[] = [];
    const releases = new Map<string, () => void>();
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'same-key-in-flight-test', emit: (record) => {
      if (record.category === 'self-dev.orchestrate' && record.event === 'same-key-in-flight') events.push(record.data as Record<string, unknown>);
    } });
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      launches.push(feature);
      active.add(feature);
      return { address: `self-impl:${input.spaceId}`, done: new Promise((resolve) => {
        releases.set(feature, () => { active.delete(feature); resolve({ exitCode: 0, output: '' }); });
      }) };
    };
    try {
      const run = orchestrateSelfDev({
        goals: [
          { feature: 'first', planBranch: 'plan/shared', goalId: 'goal-a' },
          { feature: 'second', planBranch: 'plan/shared', goalId: 'goal-b' },
          { feature: 'different', planBranch: 'plan/other', goalId: 'goal-a' },
        ], concurrency: 3, spawn,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const firstShared = active.has('first') ? 'first' : 'second';
      const nextShared = firstShared === 'first' ? 'second' : 'first';
      expect(active).toEqual(new Set([firstShared, 'different']));
      expect(launches).not.toContain(nextShared);
      expect(events).toEqual([expect.objectContaining({ key: 'plan/shared', waited: true })]);
      releases.get(firstShared)!();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(active).toEqual(new Set([nextShared, 'different']));
      releases.get(nextShared)!();
      releases.get('different')!();
      expect((await run).map((r) => r.status)).toEqual(['done', 'done', 'done']);
    } finally { off(); for (const release of releases.values()) release(); }
  });

  test('waiting for a shared key launches the next child before returning its actual address to the adapter', async () => {
    const source = readFileSync(new URL('./orchestrate.ts', import.meta.url).pathname, 'utf8');
    const wait = source.slice(source.indexOf('const keyedDevAdapter: SurfaceAdapter ='), source.indexOf('const devDefinition: JobKindDefinition ='));
    expect(wait.indexOf('await previous;')).toBeLessThan(wait.indexOf('const result = await devAdapter(task, ctx);'));
    expect(wait).toContain('return { ...result, promise: result.promise.finally(releaseKey) };');
    const capture = source.slice(source.indexOf('const capturingSpawn: SelfImplementJobSpawn ='), source.indexOf('const devAdapter ='));
    expect(capture).toContain('address: started.address,');
    expect(capture).not.toContain('started?.address ??');

    const releases = new Map<string, () => void>();
    const addresses: string[] = [];
    const active = new Set<string>();
    const spawn: SelfImplementJobSpawn = (input) => {
      const name = input.feature.split('\n')[0]!;
      active.add(name);
      const address = `pod://${name}`;
      addresses.push(address);
      return { address, done: new Promise((resolve) => {
        releases.set(name, () => { active.delete(name); resolve({ exitCode: 0, output: '' }); });
      }) };
    };
    const run = orchestrateSelfDev({ goals: [
      { feature: 'first', planBranch: 'same' }, { feature: 'second', planBranch: 'same' },
      { feature: 'other', planBranch: 'other' },
    ], concurrency: 3, spawn });
    try {
      await Bun.sleep(10);
      const firstShared = active.has('first') ? 'first' : 'second';
      const nextShared = firstShared === 'first' ? 'second' : 'first';
      expect(new Set(addresses)).toEqual(new Set([`pod://${firstShared}`, 'pod://other']));
      expect(active.has(nextShared)).toBe(false);
      releases.get(firstShared)!();
      for (let i = 0; i < 30 && !releases.has(nextShared); i++) await Bun.sleep(10);
      expect(addresses).toContain(`pod://${nextShared}`);
      expect(active).toEqual(new Set([nextShared, 'other']));
      releases.get(nextShared)!();
      releases.get('other')!();
      expect((await run).map((result) => result.status)).toEqual(['done', 'done', 'done']);
    } finally { for (const release of releases.values()) release(); }
  });

  test('same key remains reserved across three queued jobs and releases after failure', async () => {
    const active = new Set<string>();
    const releases = new Map<string, (exitCode: number) => void>();
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      active.add(feature);
      return { address: `self-impl:${input.spaceId}`, done: new Promise((resolve) => {
        releases.set(feature, (exitCode) => { active.delete(feature); resolve({ exitCode, output: '' }); });
      }) };
    };
    const run = orchestrateSelfDev({ goals: [
      { feature: 'a', goalId: 'same' }, { feature: 'b', goalId: 'same' }, { feature: 'c', goalId: 'same' },
    ], concurrency: 3, spawn });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(active.size).toBe(1);
      for (let index = 0; index < 3; index++) {
        const current = [...active][0]!;
        releases.get(current)!(index === 0 ? 1 : 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(active.size).toBe(index === 2 ? 0 : 1);
      }
      const results = await run;
      expect(results.filter((r) => r.status === 'failed')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'done')).toHaveLength(2);
    } finally { for (const release of releases.values()) release(0); }
  });

  test('separate self orchestrate calls reserve the same supplied plan branch', async () => {
    const active = new Set<string>();
    const releases: Array<() => void> = [];
    const keys: string[] = [];
    const off = debug.registerSink({ name: 'generated-branch-in-flight', emit: (record) => {
      if (record.category === 'self-dev.orchestrate' && record.event === 'same-key-in-flight') keys.push(String((record.data as { key: string }).key));
    } });
    const spawn: SelfImplementJobSpawn = (input) => {
      active.add(input.spaceId);
      return { address: `self-impl:${input.spaceId}`, done: new Promise((resolve) => {
        releases.push(() => { active.delete(input.spaceId); resolve({ exitCode: 0, output: '' }); });
      }) };
    };
    try {
      const first = orchestrateSelfDev({ goals: [{ feature: 'same CLI goal', planBranch: 'plan/shared-across-calls' }], concurrency: 3, spawn });
      const second = orchestrateSelfDev({ goals: [{ feature: 'same CLI goal', planBranch: 'plan/shared-across-calls' }], concurrency: 3, spawn });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(active.size).toBe(1);
      expect(releases).toHaveLength(1);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe('plan/shared-across-calls');
      releases[0]!();
      for (let i = 0; i < 30 && releases.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(active.size).toBe(1);
      expect(releases).toHaveLength(2);
      releases[1]!();
      expect((await Promise.all([first, second])).flat().map((r) => r.status)).toEqual(['done', 'done']);
    } finally { off(); for (const release of releases) release(); }
  });

  test('authored CLI goal identity is parsed from the actual goal text before spawn', async () => {
    const goalText = '# Goal\n- GoalId: 4b852b3a0f863ad2\n- RootIntent: same work\n\n## PROBLEM\nFix it';
    const created = withOrchestrateGoalKey({ feature: goalText });
    expect(created.goalId).toBe('4b852b3a0f863ad2');
    expect(created.planBranch).toStartWith('self-impl/');
    expect(withOrchestrateGoalKey({ feature: 'untagged CLI goal' }).planBranch).toStartWith('self-impl/');
    expect(created.planBranch).toBe(plannedSelfImplBranch(goalText, created.goalId));
    let release!: () => void;
    const held = new Promise<SelfImplementJobDone>((resolve) => { release = () => resolve({ exitCode: 0, output: '' }); });
    const launches: string[] = [];
    const events: string[] = [];
    const otherText = 'a different branch from the CLI';
    const other = withOrchestrateGoalKey({ feature: otherText });
    expect(other.planBranch).not.toBe(created.planBranch);
    const off = debug.registerSink({ name: 'authored-goal-key', emit: (record) => {
      if (record.category === 'self-dev.orchestrate' && record.event === 'same-key-in-flight') events.push(String((record.data as { key: string }).key));
    } });
    const spawn: SelfImplementJobSpawn = (input) => { launches.push(input.feature); return { address: input.spaceId, done: held }; };
    try {
      const run = orchestrateSelfDev({ goals: [created, withOrchestrateGoalKey({ feature: goalText }), other], concurrency: 3, spawn });
      expect(launches).toHaveLength(2);
      expect(launches.some((feature) => feature.startsWith(otherText))).toBe(true);
      expect(events).toEqual([created.planBranch!]);
      release();
      expect((await run).map((r) => r.status)).toEqual(['done', 'done', 'done']);
      expect(launches).toHaveLength(3);
    } finally { release(); off(); }
  });

  test('self orchestrate CLI constructs unkeyed goals and serializes their branch while another branch runs', async () => {
    const { program, setSelfOrchestrateSpawnForTesting } = await import('../index.js');
    const releases = new Map<string, () => void>();
    const active = new Set<string>();
    const features = new Map<string, string>();
    const keys: string[] = [];
    const off = debug.registerSink({ name: 'actual-cli-key', emit: (record) => {
      if (record.category === 'self-dev.orchestrate' && record.event === 'same-key-in-flight') keys.push(String((record.data as { key: string }).key));
    } });
    const text = '# Goal\n- GoalId: 4b852b3a0f863ad2\n- RootIntent: CLI actual path';
    const otherText = '# Goal\n- GoalId: 55aabbccddeeff00\n- RootIntent: different CLI branch';
    const spawn: SelfImplementJobSpawn = (input) => {
      active.add(input.spaceId);
      features.set(input.spaceId, input.feature);
      return { address: input.spaceId, done: new Promise((resolve) => {
        releases.set(input.spaceId, () => { active.delete(input.spaceId); resolve({ exitCode: 0, output: '' }); });
      }) };
    };
    setSelfOrchestrateSpawnForTesting(spawn);
    try {
      const run = program.parseAsync(['node', 'elanous', 'self', 'orchestrate', text, text, otherText, '--concurrency', '3', '--no-supervise', '--json']);
      for (let i = 0; i < 100 && releases.size < 2; i++) await Bun.sleep(10);
      expect(active.size).toBe(2);
      expect(releases.size).toBe(2);
      expect(keys).toEqual([plannedSelfImplBranch(text, '4b852b3a0f863ad2')]);
      const firstSpace = [...active].find((space) => features.get(space)?.startsWith(text))!;
      expect(firstSpace).toBeDefined();
      releases.get(firstSpace)!();
      for (let i = 0; i < 100 && releases.size < 3; i++) await Bun.sleep(10);
      expect(releases.size).toBe(3);
      expect(active.size).toBe(2);
      expect(active.has(firstSpace)).toBe(false);
      for (const space of active) releases.get(space)!();
      await run;
    } finally { for (const release of releases.values()) release(); setSelfOrchestrateSpawnForTesting(undefined); off(); }
  });

  test('goalId fallback serializes matching jobs without a plan branch', async () => {
    const { spawn, maxLive } = makeTrackingSpawn({ delayMs: 8 });
    const result = await orchestrateSelfDev({
      goals: [{ feature: 'one', goalId: 'goal-1' }, { feature: 'two', goalId: 'goal-1' }],
      concurrency: 3, spawn,
    });
    expect(result.map((r) => r.status)).toEqual(['done', 'done']);
    expect(maxLive()).toBe(1);
  });

  test('applies runtime-derived concurrency through the orchestration boundary', async () => {
    const { spawn, maxLive } = makeTrackingSpawn({ delayMs: 8 });
    const goals = Array.from({ length: 5 }, (_, i) => ({ feature: `runtime-goal-${i}` }));
    const results = await orchestrateSelfDev({
      goals,
      availableParallelism: () => 4,
      spawn,
    });
    expect(results.every((result) => result.status === 'done')).toBe(true);
    expect(maxLive()).toBe(4);
  });

  test('a failing job does not block the others (isolation)', async () => {
    const { spawn } = makeTrackingSpawn({ failFeatures: new Set(['bad']) });
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'good-1' }, { feature: 'bad' }, { feature: 'good-2' }],
      concurrency: 3,
      spawn,
    });
    const byFeature = new Map(results.map((r) => [r.feature, r]));
    expect(byFeature.get('good-1')!.status).toBe('done');
    expect(byFeature.get('good-2')!.status).toBe('done');
    expect(byFeature.get('bad')!.status).toBe('failed');
    expect(byFeature.get('bad')!.error?.code).toBe('SELF_IMPL_FAILED');
  });

  test('observes deliverables in the production reduce path before triage', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-deliverable-observation-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve({ exitCode: 0, output: 'ok' }),
    });
    try {
      const [result] = await orchestrateSelfDev({
        goals: [{ feature: 'published' }],
        spawn,
        deliverableTargets: [{ taskId: 'published', target: 'https://example.test/published' }],
        verifyDeliverable: async () => ({
          ok: false,
          url: 'https://example.test/published',
          findings: ['body missing'],
          structuredFindings: [{ kind: 'empty-body', certainty: 'confirmed', message: 'body missing' }],
        }),
      });
      const reduce = records[0]!;
      expect(reduce.data).toMatchObject({
        deliverableUnmeasured: false,
        repairable: ['published'],
      });
      expect((reduce.data as { failures: Array<{ taskId: string; errorCode: string }> }).failures).toContainEqual(
        expect.objectContaining({ taskId: 'published', errorCode: 'web|empty-body|https://example.test/published' }),
      );
    } finally {
      off();
    }
  });

  test('preserves no-cdp, verifier exceptions, and mixed measurement as unmeasured in the production reduce path', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-unmeasured-deliverable-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve({ exitCode: 0, output: 'ok' }),
    });
    try {
      await orchestrateSelfDev({
        goals: [{ id: 'no-cdp', feature: 'no cdp' }],
        spawn,
        deliverableTargets: [{ taskId: 'no-cdp', target: 'https://example.test/no-cdp' }],
        verifyDeliverable: async () => ({ ok: false, url: 'https://example.test/no-cdp', findings: [], skipped: 'no-cdp' }),
      });
      await orchestrateSelfDev({
        goals: [{ id: 'throws', feature: 'throws' }],
        spawn,
        deliverableTargets: [{ taskId: 'throws', target: 'https://example.test/throws' }],
        verifyDeliverable: async () => { throw new Error('verifier failed'); },
      });
      await orchestrateSelfDev({
        goals: [{ id: 'broken', feature: 'broken' }, { id: 'unavailable', feature: 'unavailable' }],
        spawn,
        deliverableTargets: [
          { taskId: 'broken', target: 'https://example.test/broken' },
          { taskId: 'unavailable', target: 'https://example.test/unavailable' },
        ],
        verifyDeliverable: async (target) => target.endsWith('/broken')
          ? {
              ok: false,
              url: target,
              findings: ['body missing'],
              structuredFindings: [{ kind: 'empty-body', certainty: 'confirmed', message: 'body missing' }],
            }
          : { ok: false, url: target, findings: [], skipped: 'no-cdp' },
      });

      expect(records).toHaveLength(3);
      expect(records[0]!.data).toMatchObject({
        deliverableUnmeasured: true,
        deliverableUnmeasuredTasks: [{ taskId: 'no-cdp', reason: 'no-cdp' }],
      });
      expect(records[1]!.data).toMatchObject({
        deliverableUnmeasured: true,
        deliverableUnmeasuredTasks: [{ taskId: 'throws', reason: 'verify-exception' }],
      });
      expect(records[2]!.data).toMatchObject({
        deliverableUnmeasured: true,
        deliverableUnmeasuredTasks: [{ taskId: 'unavailable', reason: 'no-cdp' }],
        repairable: ['broken'],
      });
    } finally {
      off();
    }
  });

  test('classifies code-less repairable failures with their observed message', () => {
    const classifications = classifyFailures([{
      taskId: 'code-less-repair',
      feature: 'repair feature',
      status: 'done',
      goalCauseObserved: true,
      error: { message: 'repair detail without a code' } as SelfDevJobResult['error'],
    }]);
    expect(classifications).toEqual([{
      taskId: 'code-less-repair',
      stage: null,
      kind: 'oversized-goal',
      action: 'add-repair-task',
      errorCode: 'UNKNOWN',
      errorMessage: 'repair detail without a code',
    }]);
  });

  test('projects child failure reasons into existing job.failed and orchestrate.reduce observations', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-failure-reason-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && (record.event === 'job.failed' || record.event === 'orchestrate.reduce')) records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve({ exitCode: 1, output: '', error: { code: 'CHILD_FAILED', message: 'child reported the repair target' } }),
    });
    try {
      const [result] = await orchestrateSelfDev({ goals: [{ feature: 'bad' }], spawn });
      expect(result!.error).toEqual({ code: 'CHILD_FAILED', message: 'child reported the repair target' });
      const jobFailed = records.find((record) => record.event === 'job.failed')!;
      expect(jobFailed.data).toMatchObject({ taskId: result!.taskId, errorCode: 'CHILD_FAILED', errorMessage: 'child reported the repair target' });
      const reduce = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect((reduce.data as { failures: unknown[] }).failures).toEqual([{
        taskId: result!.taskId,
        stage: null,
        kind: 'unclassified',
        action: 'needs-human',
        errorCode: 'CHILD_FAILED',
        errorMessage: 'child reported the repair target',
      }]);
    } finally {
      off();
    }
  });

  test('omits absent failure reasons and marks truncated reasons in existing failure observations', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-failure-reason-bounds-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && (record.event === 'job.failed' || record.event === 'orchestrate.reduce')) records.push(record);
      },
    });
    const longMessage = 'x'.repeat(257);
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve({
        exitCode: 1,
        output: '',
        error: withoutShardIdentity(input.feature) === 'missing' ? { code: 'MISSING_REASON', message: '' } : { code: 'LONG_REASON', message: longMessage },
      }),
    });
    try {
      await orchestrateSelfDev({ goals: [{ feature: 'missing' }, { feature: 'long' }], concurrency: 2, spawn });
      const jobFailures = records.filter((record) => record.event === 'job.failed').map((record) => record.data as Record<string, unknown>);
      expect(jobFailures.find((data) => data.errorCode === 'MISSING_REASON')).toEqual(expect.objectContaining({ errorCode: 'MISSING_REASON' }));
      expect(jobFailures.find((data) => data.errorCode === 'MISSING_REASON')).not.toHaveProperty('errorMessage');
      const longJobFailure = jobFailures.find((data) => data.errorCode === 'LONG_REASON')!;
      expect(longJobFailure).toMatchObject({ errorMessage: `${'x'.repeat(255)}…`, errorMessageTruncated: true });
      expect((longJobFailure.errorMessage as string).length).toBe(256);
      const reduce = records.find((record) => record.event === 'orchestrate.reduce')!;
      const failures = (reduce.data as { failures: Record<string, unknown>[] }).failures;
      expect(failures.find((failure) => failure.errorCode === 'MISSING_REASON')).not.toHaveProperty('errorMessage');
      const longFailure = failures.find((failure) => failure.errorCode === 'LONG_REASON')!;
      expect(longFailure).toMatchObject({ errorMessage: `${'x'.repeat(255)}…`, errorMessageTruncated: true });
      expect((longFailure.errorMessage as string).length).toBe(256);
    } finally {
      off();
    }
  });

  test('summarizes terminal statuses and empty input', () => {
    expect(summarizeResults([
      { taskId: 'done', feature: 'done', status: 'done' },
      { taskId: 'failed', feature: 'failed', status: 'failed' },
      { taskId: 'cancelled', feature: 'cancelled', status: 'cancelled' },
      { taskId: 'done-2', feature: 'done-2', status: 'done' },
    ])).toEqual({ done: 2, failed: 1, cancelled: 1, landed: 0, unlanded: 4 });
    expect(summarizeResults([])).toEqual({ done: 0, failed: 0, cancelled: 0, landed: 0, unlanded: 0 });
  });

  test('reduces every failed job by proven child stage and emits one identifiable shadow observation without retrying', async () => {
    const launched: string[] = [];
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-reduce-capture',
      emit: (record) => { if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record); },
    });
    const stages: Record<string, string> = {
      merged: 'merged',
      gate: 'gate-failed',
      review: 'review-blocked',
      aborted: 'aborted',
      timedOut: 'timed-out',
    };
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = withoutShardIdentity(input.feature);
      launched.push(feature);
      return {
        address: `self-impl:${input.spaceId}`,
        done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: '', disposition: { stage: stages[feature]!, ok: false } }),
      };
    };
    try {
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'merged' }, { feature: 'gate' }, { feature: 'review' }, { feature: 'aborted' }, { feature: 'timedOut' }],
        concurrency: 5,
        spawn,
      });
      expect(launched).toHaveLength(5);
      expect(new Set(launched)).toEqual(new Set(Object.keys(stages)));
      expect(results.every((result) => result.status === 'failed')).toBe(true);
      expect(classifyFailure(results.find((result) => result.feature === 'merged')!)).toBe('false-failure');
      expect(classifyFailure(results.find((result) => result.feature === 'aborted')!)).toBe('unclassified');
      expect(classifyFailure(results.find((result) => result.feature === 'timedOut')!)).toBe('unclassified');
      expect(summarizeFailureKinds(results)).toEqual({ falseFailure: 1, unconverged: 2, unclassified: 2, transient: 0, blockedUpstream: 0, unconvergedDecomposable: 0, mainSyncBlocked: 0 });
      expect(records).toHaveLength(1);
      expect(records[0]!.data).toMatchObject({
        total: 5,
        done: 0,
        failed: 5,
        cancelled: 0,
        falseFailure: 1,
        unconverged: 2,
        unclassified: 2,
      });
      const failures = (records[0]!.data as { failures: { taskId: string; stage: string; kind: string }[] }).failures;
      expect(failures).toHaveLength(5);
      expect(new Map(failures.map((failure) => [failure.stage, failure.kind]))).toEqual(new Map([
        ['merged', 'false-failure'],
        ['gate-failed', 'unconverged'],
        ['review-blocked', 'unconverged'],
        ['aborted', 'unclassified'],
        ['timed-out', 'unclassified'],
      ]));
      expect(new Set(failures.map((failure) => failure.taskId))).toEqual(new Set(results.map((result) => result.taskId)));
    } finally {
      off();
    }
  });

  test('empty goal list resolves immediately', async () => {
    const { spawn } = makeTrackingSpawn();
    const results = await orchestrateSelfDev({ goals: [], spawn });
    expect(results).toEqual([]);
  });

  test('emits task lifecycle events to onEvent', async () => {
    const { spawn } = makeTrackingSpawn();
    const kinds: string[] = [];
    await orchestrateSelfDev({
      goals: [{ feature: 'g1' }, { feature: 'g2' }],
      spawn,
      onEvent: (ev) => kinds.push(ev.kind),
    });
    expect(kinds).toContain('task-started');
    expect(kinds).toContain('task-completed');
  });
});

describe('orchestrateSelfDev — multi-shard identity context', () => {
  test('sends each of three shards its shared parent, distinct one-based position, and bounded sibling summaries without changing concurrency', async () => {
    const received = new Map<string, string>();
    let live = 0;
    let maxLive = 0;
    const longFeature = `alpha ${'detail '.repeat(80)}`;
    const spawn: SelfImplementJobSpawn = (input) => {
      received.set(input.spaceId, input.feature);
      live++;
      maxLive = Math.max(maxLive, live);
      return {
        address: `self-impl:${input.spaceId}`,
        done: new Promise((resolve) => setTimeout(() => { live--; resolve({ exitCode: 0, output: '' }); }, 5)),
      };
    };

    await orchestrateSelfDev({
      parentRequest: 'Implement the three coordinated shards.',
      goals: [
        { id: 'alpha', feature: longFeature },
        { id: 'beta', feature: 'beta owns the runtime boundary' },
        { id: 'gamma', feature: 'gamma owns the focused tests' },
      ],
      concurrency: 3,
      spawn,
    });

    const identities = [...received.values()].map((feature) => {
      const marker = '\n\n## Shard identity\n';
      const markerAt = feature.indexOf(marker);
      expect(markerAt).toBeGreaterThan(0);
      return { feature: feature.slice(0, markerAt), identity: JSON.parse(feature.slice(markerAt + marker.length)) as {
        orchestrationId: string; parentRequest: string; shardId: string; totalShards: number; position: number; summary: string;
        siblings: Array<{ shardId: string; summary: string }>;
      } };
    });

    expect(maxLive).toBe(3);
    expect(new Set(identities.map(({ identity }) => identity.orchestrationId)).size).toBe(1);
    expect(identities[0]!.identity.orchestrationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identities.map(({ identity }) => identity.parentRequest)).toEqual([
      'Implement the three coordinated shards.',
      'Implement the three coordinated shards.',
      'Implement the three coordinated shards.',
    ]);
    expect(new Set(identities.map(({ identity }) => identity.position))).toEqual(new Set([1, 2, 3]));
    expect(identities.every(({ identity }) => identity.totalShards === 3 && identity.siblings.length === 2)).toBe(true);
    expect(identities.every(({ identity }) => identity.shardId.startsWith('task:'))).toBe(true);
    expect(identities.find(({ feature }) => feature === longFeature)!.identity.summary.startsWith('alpha')).toBe(true);
    const beta = identities.find(({ feature }) => feature === 'beta owns the runtime boundary')!.identity;
    expect(beta.siblings.map((sibling) => sibling.summary)).toEqual([
      `${longFeature.trim().replace(/\s+/g, ' ').slice(0, 239)}…`,
      'gamma owns the focused tests',
    ]);
    expect(beta.siblings[0]!.summary.length).toBeLessThanOrEqual(240);
  });

  test('carries one parsed goal release note into every shard identity', async () => {
    const received: string[] = [];
    const parentRequest = '# Goal\n## Situation\nwork\n## 릴리스 노트\n- 한 줄: New public action\n- 종류: feat\n- 문서: 없음(사용 설명)\n- 대상: next\n';
    await orchestrateSelfDev({
      parentRequest, goals: [{ feature: 'first shard' }, { feature: 'second shard' }],
      spawn: (input) => { received.push(input.feature); return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '' }) }; },
    });
    expect(received).toHaveLength(2);
    for (const feature of received) {
      const identity = JSON.parse(feature.split('## Shard identity\n')[1]!) as { releaseNote: unknown };
      expect(identity.releaseNote).toEqual({ line: 'New public action', kind: 'feat', docs: { none: '사용 설명' }, target: 'next' });
    }
  });

  test('legacy goal boundary excludes release notes outside ## 목표 from shard identity', async () => {
    const received: string[] = [];
    const outside = '## 릴리스 노트\n- 한 줄: Outside goal\n- 종류: feat\n- 문서: 없음(예시)\n- 대상: next\n';
    await orchestrateSelfDev({
      parentRequest: `${outside}\n## 목표\nwork\n## 검증\n${outside}`,
      goals: [{ feature: 'first shard' }, { feature: 'second shard' }],
      spawn: (input) => { received.push(input.feature); return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '' }) }; },
    });
    expect(received).toHaveLength(2);
    for (const feature of received) {
      const identity = JSON.parse(feature.split('## Shard identity\n')[1]!) as { releaseNote?: unknown };
      expect(identity.releaseNote).toBeUndefined();
    }
  });

  test('legacy goal boundary carries only the inside release note to each shard', async () => {
    const received: string[] = [];
    const outside = '## 릴리스 노트\n- 한 줄: Outside goal\n- 종류: feat\n- 문서: 없음(예시)\n- 대상: next\n';
    const inside = '## 릴리스 노트\n- 한 줄: Inside goal\n- 종류: fix\n- 문서: docs/fix.md\n- 대상: next\n';
    await orchestrateSelfDev({
      parentRequest: `${outside}\n## 목표\nwork\n${inside}\n## 검증\n${outside}`,
      goals: [{ feature: 'first shard' }, { feature: 'second shard' }],
      spawn: (input) => { received.push(input.feature); return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '' }) }; },
    });
    expect(received).toHaveLength(2);
    for (const feature of received) {
      const identity = JSON.parse(feature.split('## Shard identity\n')[1]!) as { releaseNote?: unknown };
      expect(identity.releaseNote).toEqual({ line: 'Inside goal', kind: 'fix', docs: { path: 'docs/fix.md' }, target: 'next' });
    }
  });

  test('groups a no-parentRequest { goals, concurrency } fan-out in the run ledger identity', async () => {
    const received: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      received.push(input.feature);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };

    await orchestrateSelfDev({
      goals: [{ feature: 'pipeline shard' }, { feature: 'runtime shard' }],
      concurrency: 2,
      spawn,
    });

    expect(received).toHaveLength(2);
    expect(received.every((feature) => feature.includes('\n\n## Shard identity\n'))).toBe(true);
    expect(received.every((feature) => !feature.includes('"parentRequest"'))).toBe(true);
    const identities = received.map(parseRunShardIdentity);
    expect(identities.map(({ pieceTotal }) => pieceTotal)).toEqual([2, 2]);
    expect(identities.map(({ orchestrationId }) => orchestrationId)).toEqual([
      identities[0]!.orchestrationId,
      identities[0]!.orchestrationId,
    ]);
    expect(identities[0]!.orchestrationId).toBeTruthy();
    expect(new Set(identities.map(({ pieceIndex }) => pieceIndex)).size).toBe(2);
    expect(identities.map(({ pieceIndex }) => pieceIndex).sort()).toEqual([0, 1]);
  });

  test('mints different orchestration ids for separate multi-shard fan-outs', async () => {
    const orchestrationIds: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      const marker = '\n\n## Shard identity\n';
      orchestrationIds.push((JSON.parse(input.feature.slice(input.feature.indexOf(marker) + marker.length)) as { orchestrationId: string }).orchestrationId);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };

    await orchestrateSelfDev({ parentRequest: 'first', goals: [{ feature: 'a' }, { feature: 'b' }], spawn });
    await orchestrateSelfDev({ parentRequest: 'second', goals: [{ feature: 'c' }, { feature: 'd' }], spawn });

    expect(orchestrationIds.slice(0, 2)).toEqual([orchestrationIds[0], orchestrationIds[0]]);
    expect(orchestrationIds.slice(2)).toEqual([orchestrationIds[2], orchestrationIds[2]]);
    expect(orchestrationIds[0]).not.toBe(orchestrationIds[2]);
  });

  test('resume keeps the original three-shard positions and task identities when only one shard runs', async () => {
    const received: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      received.push(input.feature);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };

    await orchestrateSelfDev({
      parentRequest: 'three original shards',
      goals: [
        { id: '0', feature: 'first complete' },
        { id: 'middle', feature: 'second rerun' },
        { id: 'last', feature: 'third complete' },
      ],
      resumeFrom: [
        { taskId: 'previous-first', feature: 'first complete', status: 'done' },
        { taskId: 'previous-last', feature: 'third complete', status: 'done' },
      ],
      spawn,
    });

    expect(received).toHaveLength(1);
    const marker = '\n\n## Shard identity\n';
    const markerAt = received[0]!.indexOf(marker);
    expect(markerAt).toBeGreaterThan(0);
    const identity = JSON.parse(received[0]!.slice(markerAt + marker.length)) as {
      shardId: string; totalShards: number; position: number; siblings: Array<{ shardId: string; summary: string }>;
    };
    expect(identity.totalShards).toBe(3);
    expect(identity.position).toBe(2);
    expect(identity.siblings.map((sibling) => sibling.summary)).toEqual(['first complete', 'third complete']);
    expect(identity.siblings.map((sibling) => sibling.shardId)).toEqual(['previous-first', 'previous-last']);
    expect(identity.siblings.map((sibling) => sibling.shardId)).not.toContain(identity.shardId);
  });

  test('attaches a complete singleton identity for parent-request and legacy callers', async () => {
    const received: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      received.push(input.feature);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };

    await orchestrateSelfDev({ parentRequest: 'one parent request', goals: [{ feature: 'singleton feature' }], spawn });
    await orchestrateSelfDev({ goals: [{ feature: 'legacy feature' }], spawn });

    expect(received).toHaveLength(2);
    const identities = received.map((feature) => {
      const marker = '\n\n## Shard identity\n';
      const markerAt = feature.indexOf(marker);
      expect(markerAt).toBeGreaterThan(0);
      return JSON.parse(feature.slice(markerAt + marker.length)) as {
        orchestrationId: string; parentRequest?: string; totalShards: number; position: number;
        siblings: Array<{ shardId: string; summary: string }>;
      };
    });
    expect(identities.map(({ orchestrationId }) => orchestrationId)).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(identities.map(({ totalShards, position, siblings }) => ({ totalShards, position, siblings }))).toEqual([
      { totalShards: 1, position: 1, siblings: [] },
      { totalShards: 1, position: 1, siblings: [] },
    ]);
    expect(identities.map(({ parentRequest }) => parentRequest)).toEqual(['one parent request', undefined]);
    expect(received.filter((feature) => feature.includes('\n\n## Shard identity\n'))).toHaveLength(received.length);
  });

  test('attaches identity to every task across singleton and three-shard executions', async () => {
    const received: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      received.push(input.feature);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };

    await orchestrateSelfDev({ goals: [{ feature: 'singleton' }], spawn });
    await orchestrateSelfDev({ goals: [{ feature: 'first' }, { feature: 'second' }, { feature: 'third' }], spawn });

    const identities = received.map((feature) => {
      const marker = '\n\n## Shard identity\n';
      const markerAt = feature.indexOf(marker);
      expect(markerAt).toBeGreaterThan(0);
      return JSON.parse(feature.slice(markerAt + marker.length)) as {
        orchestrationId: string; totalShards: number; position: number;
      };
    });
    expect(identities).toHaveLength(received.length);
    expect(identities[0]).toMatchObject({ totalShards: 1, position: 1, orchestrationId: expect.any(String) });
    expect(identities.slice(1).map(({ totalShards }) => totalShards)).toEqual([3, 3, 3]);
    // ⛔ spawn 순서는 «비결정적»이다 — 동시 실행이라 수집 순서가 position 순서와 다를 수 있다(실측: [1,3,2]).
    //   판별력은 유지된다: 1·2·3 이 «각각 하나씩» 있어야 통과한다.
    expect(identities.slice(1).map(({ position }) => position).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(identities.slice(1).map(({ orchestrationId }) => orchestrationId)).size).toBe(1);
  });
});

/** Spawn that records, at each job's launch, the set of features already
 *  completed — lets us assert topological ordering + concurrency. */
function makeOrderTrackingSpawn(delayMs = 5) {
  const completed = new Set<string>();
  const completedAtSpawn = new Map<string, string[]>();
  let live = 0;
  let maxLive = 0;
  const spawn: SelfImplementJobSpawn = (input) => {
    const feature = input.feature.split('\n')[0]!;
    completedAtSpawn.set(feature, [...completed]);
    live++; maxLive = Math.max(maxLive, live);
    const done = new Promise<SelfImplementJobDone>((resolve) => {
      setTimeout(() => { live--; completed.add(feature); resolve({ exitCode: 0, output: '' }); }, delayMs);
    });
    return { address: `self-impl:${input.spaceId}`, done };
  };
  return { spawn, completedAtSpawn, maxLive: () => maxLive };
}

describe('PR-completion dependency landing', () => {
  test('default PR probe rejects merges into a non-main base, and only accepts merges into main', () => {
    const pr = (state: string, baseRefName: string) => (number: number) => {
      expect(number).toBe(1);
      return JSON.stringify({ state, baseRefName });
    };
    expect(prMergedOnMain(1, pr('MERGED', 'feature/stack'))).toBe(false);
    expect(prMergedOnMain(1, pr('OPEN', 'main'))).toBe(false);
    expect(prMergedOnMain(1, pr('MERGED', 'main'))).toBe(true);
    expect(dependencyOnMain({ stage: 'pr-opened', merged: false, prNumber: 1 }, {
      prMerged: (number) => prMergedOnMain(number, pr('MERGED', 'feature/stack')),
      commitOnMain: () => false,
    })).toBe(false);
  });

  test('a parent PR merged into another branch does not launch its dependent', async () => {
    const launches: string[] = [];
    const results = await orchestrateSelfDev({
      goals: [{ id: 'a', feature: 'A', openPr: true, autoMerge: false }, { id: 'b', feature: 'B', dependsOn: ['a'] }],
      spawn: (input) => {
        launches.push(input.feature.split('\n')[0]!);
        return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
          stage: 'pr-opened', merged: false, prNumber: 1,
        } }) };
      },
      landingProbe: {
        prMerged: (number) => prMergedOnMain(number, () => JSON.stringify({ state: 'MERGED', baseRefName: 'feature/stack' })),
        commitOnMain: () => false,
      },
      emitDispatchDecision: () => true,
    });
    expect(launches).toEqual(['A']);
    expect(results.find((result) => result.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
  });

  test('goals sharing only hotPaths are serialized but not blocked on an unlanded PR', async () => {
    const launches: string[] = [];
    const results = await orchestrateSelfDev({
      goals: [
        { id: 'a', feature: 'A', openPr: true, autoMerge: false, hotPaths: ['src/shared.ts'] },
        { id: 'b', feature: 'B', hotPaths: ['src/shared.ts'] },
      ],
      spawn: (input) => {
        launches.push(input.feature.split('\n')[0]!);
        return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
          stage: 'pr-opened', merged: false, prNumber: 1,
        } }) };
      },
      landingProbe: { prMerged: () => false, commitOnMain: () => false },
      emitDispatchDecision: () => true,
    });
    expect(launches).toEqual(['A', 'B']);
    expect(results.find((result) => result.feature === 'B')?.blockReason).toBeUndefined();
  });

  test('merged disposition alone is not main landing evidence for a PR-completion parent', async () => {
    const launches: string[] = [];
    const results = await orchestrateSelfDev({
      goals: [{ id: 'a', feature: 'A', openPr: true, autoMerge: false }, { id: 'b', feature: 'B', dependsOn: ['a'] }],
      spawn: (input) => {
        launches.push(input.feature.split('\n')[0]!);
        return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
          stage: 'merged', merged: true, prNumber: 1,
        } }) };
      },
      landingProbe: { prMerged: (number) => prMergedOnMain(number, () => JSON.stringify({ state: 'MERGED', baseRefName: 'feature/stack' })), commitOnMain: () => false },
      emitDispatchDecision: () => true,
    });
    expect(launches).toEqual(['A']);
    expect(results.find((result) => result.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
  });

  test('PR merge or commit ancestry proves landing; an open PR alone does not', () => {
    let merged = false;
    const probe = { prMerged: () => merged, commitOnMain: (commit: string) => commit === 'ancestor' };
    const parent = { prNumber: 1, stage: 'pr-opened', merged: false };
    expect(dependencyOnMain(parent, probe)).toBe(false);
    merged = true;
    expect(dependencyOnMain(parent, probe)).toBe(true);
    merged = false;
    expect(dependencyOnMain({ ...parent, checkedHeadCommit: 'ancestor' }, probe)).toBe(true);
    expect(dependencyOnMain({ ...parent, checkedHeadCommit: 'not-an-ancestor' }, probe)).toBe(false);
    expect(dependencyOnMain({ ...parent, checkedHeadCommit: undefined }, probe)).toBe(false);
    expect(dependencyOnMain({ ...parent, stage: 'merged', merged: true, checkedHeadCommit: undefined }, probe)).toBe(false);
  });

  test('fake graph blocks unmerged PR, checkpoints and reports it, then resumes after merge without re-opening parent', async () => {
    const launches: string[] = [];
    const checkpoints: SelfDevJobResult[][] = [];
    const records: LogRecord[] = [];
    let merged = false;
    const off = debug.registerSink({ name: 'parent-landing-test', emit: (record) => {
      if (record.category === 'self-dev.orchestrate' && (record.event === 'parent-unlanded' || record.event === 'done')) records.push(record);
    } });
    const goals = [
      { id: 'a', feature: 'A', openPr: true, autoMerge: false },
      { id: 'b', feature: 'B', dependsOn: ['a'], openPr: true, autoMerge: false },
    ];
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      launches.push(feature);
      return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
        stage: 'pr-opened', prNumber: 1, merged: false,
      } }) };
    };
    const landingProbe = { prMerged: () => merged, commitOnMain: () => false };
    const decisions: unknown[] = [];
    try {
      const first = await orchestrateSelfDev({ goals, spawn, landingProbe, checkpoint: (r) => checkpoints.push(r),
        emitDispatchDecision: (event) => { decisions.push(event); return true; } });
      expect(launches).toEqual(['A']);
      expect(decisions).toEqual([expect.objectContaining({ kind: 'ESCALATE', what: '조각 B 대기', reason: '앞 조각 PR #1 이 main 에 없다', purpose: '없는 토대 위에 짓지 않는다', target: '사람(부모 승인·병합)', phase: 'dispatch', refs: { pr: 1 } })]);
      expect(first.find((r) => r.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
      expect(checkpoints.at(-1)!.find((r) => r.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
      expect(records.find((r) => r.event === 'parent-unlanded')?.data).toMatchObject({ blockReason: 'parent-unlanded', parentPrNumber: 1, progress: '[supervisor] ⏸ 조각 B 대기 — 앞 조각 PR #1 미병합' });
      expect(decideNextRun({ results: first })).toMatchObject({ action: 'stop', stopReason: 'needs-human', why: '[supervisor] ⏸ 조각 B 대기 — 앞 조각 PR #1 미병합' });
      expect(summarizeFailureKinds(first).unclassified).toBe(summarizeFailureKinds(first.filter((r) => r.feature === 'A')).unclassified);
      expect(triageRun(first).classifications).toContainEqual(expect.objectContaining({ kind: 'parent-unlanded', action: 'needs-human', errorCode: 'PARENT_UNLANDED' }));
      expect((records.find((r) => r.event === 'done')!.data as { outcomes: unknown[] }).outcomes).toContainEqual(expect.objectContaining({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 }));
      const waiting = await orchestrateSelfDev({ goals, spawn, landingProbe, resumeFrom: first,
        emitDispatchDecision: () => true });
      expect(launches).toEqual(['A']);
      expect(waiting.find((r) => r.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
      merged = true;
      const second = await orchestrateSelfDev({ goals, spawn, landingProbe, resumeFrom: waiting });
      expect(launches).toEqual(['A', 'B']);
      expect(second.find((r) => r.feature === 'B')?.status).toBe('done');
    } finally { off(); }
  });

  test('mixed settings: an unmerged parent blocks children that auto-merge or do not open a PR, then resumes after landing', async () => {
    for (const childOptions of [{ autoMerge: true, openPr: true }, { autoMerge: false, openPr: false }]) {
      const goals = [
        { id: 'a', feature: 'A', openPr: true, autoMerge: false },
        { id: 'b', feature: 'B', dependsOn: ['a'], ...childOptions },
      ];
      let merged = false;
      const launches: string[] = [];
      const decisions: unknown[] = [];
      const spawn: SelfImplementJobSpawn = (input) => {
        const feature = input.feature.split('\n')[0]!;
        launches.push(feature);
        return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: feature === 'A'
          ? { stage: 'pr-opened', prNumber: 1, merged: false }
          : { stage: 'merged', merged: true } }) };
      };
      const landingProbe = { prMerged: () => merged, commitOnMain: () => false };
      const first = await orchestrateSelfDev({ goals, spawn, landingProbe,
        emitDispatchDecision: (event) => { decisions.push(event); return true; } });
      expect(launches).toEqual(['A']);
      expect(first.find((r) => r.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
      expect(decisions).toEqual([expect.objectContaining({ kind: 'ESCALATE', refs: { pr: 1 }, phase: 'dispatch' })]);
      merged = true;
      const second = await orchestrateSelfDev({ goals, spawn, landingProbe, resumeFrom: first });
      expect(launches).toEqual(['A', 'B']);
      expect(second.find((r) => r.feature === 'B')?.status).toBe('done');
    }
  });

  test('worktree-only parent without PR blocks a PR child; ancestry unlocks it on resume', async () => {
    const launches: string[] = [];
    const decisions: Array<{ reason: string; refs?: Readonly<Record<string, string | number>> }> = [];
    const records: LogRecord[] = [];
    const off = debug.registerSink({ name: 'worktree-parent-landing-test', emit: (record) => {
      if (record.category === 'self-dev.orchestrate' && record.event === 'parent-unlanded') records.push(record);
    } });
    let onMain = false;
    const goals = [
      { id: 'a', feature: 'A', openPr: false },
      { id: 'b', feature: 'B', dependsOn: ['a'], openPr: true, autoMerge: false },
    ];
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      launches.push(feature);
      return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: feature === 'A'
        ? { stage: 'worktree-completed', checkedHeadCommit: 'ancestor' }
        : { stage: 'merged', merged: true } }) };
    };
    const landingProbe = { prMerged: () => false, commitOnMain: (commit: string) => onMain && commit === 'ancestor' };
    try {
      const first = await orchestrateSelfDev({ goals, spawn, landingProbe,
        emitDispatchDecision: (event) => { decisions.push(event); return true; } });
      expect(launches).toEqual(['A']);
      expect(first.find((r) => r.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded' });
      expect(first.find((r) => r.feature === 'B')?.parentPrNumber).toBeUndefined();
      expect(first.find((r) => r.feature === 'B')?.parentNoPr).toBe(true);
      expect(records[0]?.data).toMatchObject({ progress: '[supervisor] ⏸ 조각 B 대기 — 앞 조각 커밋 main 미착지', parentPrNumber: null, parentNoPr: true });
      expect(decisions).toEqual([expect.objectContaining({ reason: '앞 조각 커밋이 main 에 없다' })]);
      expect(decisions[0]?.refs).toBeUndefined();
      expect(decideNextRun({ results: first }).why).toBe('[supervisor] ⏸ 조각 B 대기 — 앞 조각 커밋 main 미착지');
      onMain = true;
      const second = await orchestrateSelfDev({ goals, spawn, landingProbe, resumeFrom: first });
      expect(launches).toEqual(['A', 'B']);
      expect(second.find((r) => r.feature === 'B')?.status).toBe('done');
    } finally { off(); }
  });

  test('an auto-merge parent that actually leaves an unmerged PR still blocks a non-PR child', async () => {
    const launches: string[] = [];
    const results = await orchestrateSelfDev({
      goals: [
        { id: 'a', feature: 'A', openPr: true, autoMerge: true },
        { id: 'b', feature: 'B', dependsOn: ['a'], openPr: false },
      ],
      spawn: (input) => {
        const feature = input.feature.split('\n')[0]!;
        launches.push(feature);
        return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
          stage: 'pr-opened', prNumber: 1, merged: false,
        } }) };
      },
      landingProbe: { prMerged: () => false, commitOnMain: () => false },
      emitDispatchDecision: () => true,
    });
    expect(launches).toEqual(['A']);
    expect(results.find((r) => r.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 1 });
  });

  test('missing PR number remains unknown and is never invented in an escalation ref', async () => {
    const decisions: Array<{ refs?: Readonly<Record<string, string | number>> }> = [];
    const result = await orchestrateSelfDev({
      goals: [
        { id: 'a', feature: 'A', openPr: true },
        { id: 'b', feature: 'B', dependsOn: ['a'], openPr: true },
      ],
      spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: { stage: 'pr-opened', merged: false } }) }),
      landingProbe: { prMerged: () => false, commitOnMain: () => false },
      emitDispatchDecision: (event) => { decisions.push(event); return true; },
    });
    expect(result.find((entry) => entry.feature === 'B')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded' });
    expect(result.find((entry) => entry.feature === 'B')?.parentPrNumber).toBeUndefined();
    expect(decisions[0]?.refs).toBeUndefined();
    expect(decisions[0]).toMatchObject({ reason: '앞 조각 PR 번호를 알 수 없고 main 착지가 확인되지 않았다' });
  });

  test('two upstream PRs must both be merged before the dependent starts', async () => {
    const launches: string[] = [];
    const goals = [
      { id: 'a', feature: 'A', openPr: true, autoMerge: false },
      { id: 'b', feature: 'B', openPr: true, autoMerge: false },
      { id: 'c', feature: 'C', dependsOn: ['a', 'b'], openPr: true, autoMerge: false },
    ];
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      launches.push(feature);
      return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
        stage: 'pr-opened', merged: false, prNumber: feature === 'A' ? 1 : 2,
      } }) };
    };
    const first = await orchestrateSelfDev({ goals, spawn, landingProbe: { prMerged: (n) => n === 1, commitOnMain: () => false },
      emitDispatchDecision: () => true });
    expect(new Set(launches)).toEqual(new Set(['A', 'B']));
    expect(first.find((r) => r.feature === 'C')).toMatchObject({ status: 'blocked', blockReason: 'parent-unlanded', parentPrNumber: 2 });
    const second = await orchestrateSelfDev({ goals, spawn, resumeFrom: first, landingProbe: { prMerged: () => true, commitOnMain: () => false } });
    expect(launches).toHaveLength(3);
    expect(launches[2]).toBe('C');
    expect(second.find((r) => r.feature === 'C')?.status).toBe('done');
  });

  test('a child starts when its parent commit is on origin/main even if the PR remains open', async () => {
    const launches: string[] = [];
    const results = await orchestrateSelfDev({
      goals: [
        { id: 'a', feature: 'A', openPr: true, autoMerge: false },
        { id: 'b', feature: 'B', dependsOn: ['a'], openPr: true, autoMerge: false },
      ],
      spawn: (input) => {
        const name = input.feature.split('\n')[0]!;
        launches.push(name);
        return { address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: {
          stage: 'pr-opened', merged: false, prNumber: 1, checkedHeadCommit: 'ancestor',
        } }) };
      },
      landingProbe: { prMerged: () => false, commitOnMain: (commit) => commit === 'ancestor' },
    });
    expect(launches).toEqual(['A', 'B']);
    expect(results.find((result) => result.feature === 'A')?.checkedHeadCommit).toBe('ancestor');
    expect(results.find((result) => result.feature === 'B')?.status).toBe('done');
  });

  test('default auto-merge schedule remains A then B without consulting the PR probe', async () => {
    const { spawn, completedAtSpawn } = makeOrderTrackingSpawn();
    const results = await orchestrateSelfDev({
      goals: [{ id: 'a', feature: 'A', autoMerge: true, openPr: true }, { id: 'b', feature: 'B', dependsOn: ['a'], autoMerge: true, openPr: true }],
      spawn,
      landingProbe: { prMerged: () => { throw new Error('default schedule queried PR'); }, commitOnMain: () => { throw new Error('default schedule queried ancestry'); } },
    });
    expect(results.map((result) => result.status)).toEqual(['done', 'done']);
    expect(completedAtSpawn.get('B')).toContain('A');
  });
});

describe('orchestrateSelfDev — S2 dependency DAG + hot-file serialization', () => {
  test('dependent goal starts only after its dependency completes', async () => {
    const { spawn, completedAtSpawn } = makeOrderTrackingSpawn();
    const results = await orchestrateSelfDev({
      goals: [
        { id: 'a', feature: 'A' },
        { id: 'b', feature: 'B', dependsOn: ['a'] },
      ],
      concurrency: 4, // ample — proves ordering comes from deps, not the cap
      spawn,
    });
    expect(results.every((r) => r.status === 'done')).toBe(true);
    // B launched only after A had already completed.
    expect(completedAtSpawn.get('B')).toContain('A');
    // A launched before A completed (nothing done yet).
    expect(completedAtSpawn.get('A')).toEqual([]);
  });

  test('passes landed paths unchanged and names unlanded dependency outcomes', async () => {
    const received = new Map<string, string>();
    const spawn: SelfImplementJobSpawn = (input) => {
      received.set(input.feature.split('\n')[0]!, input.feature);
      const dispositions: Record<string, SelfImplementJobDone['disposition']> = {
        research: { stage: 'merged', worktreePath: '/wt/research', merged: true },
        'review-blocked': { stage: 'review-blocked', worktreePath: '/wt/review' },
        aborted: { stage: 'aborted' },
      };
      return {
        address: `self-impl:${input.spaceId}`,
        done: Promise.resolve<SelfImplementJobDone>({
          exitCode: 0,
          output: '',
          ...(dispositions[input.feature.split('\n')[0]!] ? { disposition: dispositions[input.feature.split('\n')[0]!] } : {}),
        }),
      };
    };
    await orchestrateSelfDev({
      goals: [
        { id: 'research', feature: 'research' },
        { id: 'implement', feature: 'implement', dependsOn: ['research'] },
        { id: 'review', feature: 'review-blocked' },
        { id: 'after-review', feature: 'after-review', dependsOn: ['review'] },
        { id: 'aborted', feature: 'aborted' },
        { id: 'after-aborted', feature: 'after-aborted', dependsOn: ['aborted'] },
        { id: 'independent', feature: 'independent' },
        { id: 'no-output', feature: 'no-output' },
        { id: 'missing-output-dependent', feature: 'missing-output-dependent', dependsOn: ['no-output'] },
      ],
      concurrency: 4,
      spawn,
    });
    const withoutDependencyHandoff = (feature: string | undefined): string => withoutShardIdentity(feature!).split('\n\n## Dependency handoff\n')[0]!;
    expect(withoutDependencyHandoff(received.get('implement'))).toBe('implement\n\n## Dependency outputs\n- research: /wt/research');
    expect(withoutDependencyHandoff(received.get('after-review'))).toBe('after-review\n\n## Dependency outputs\n- review-blocked: /wt/review (outcome: review-blocked)');
    expect(withoutDependencyHandoff(received.get('after-aborted'))).toBe('after-aborted\n\n## Dependency outputs\n- aborted: (no worktree) (outcome: aborted)');
    expect(withoutShardIdentity(received.get('independent')!)).toBe('independent');
    expect(withoutDependencyHandoff(received.get('missing-output-dependent'))).toBe('missing-output-dependent');
    expect(received.get('missing-output-dependent')).not.toContain('## Dependency outputs');
  });

  test('instructs only upstream shards to emit working memory and hands emitted boundaries and decisions to dependents', async () => {
    const received = new Map<string, string>();
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-working-memory-instruction-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'working-memory.instruction') records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      received.set(feature, input.feature);
      const output = feature === 'upstream' && input.feature.includes('[WORKING-MEMORY]')
        ? '[WORKING-MEMORY]\n{"summary":"Upstream contract mapped","reusables":["src/reuse.ts"],"decisions":["keep API"]}'
        : '';
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output }) };
    };
    try {
      await orchestrateSelfDev({
        goals: [
          { id: 'upstream', feature: 'upstream' },
          { id: 'downstream', feature: 'downstream', dependsOn: ['upstream'] },
          { id: 'independent', feature: 'independent' },
        ],
        spawn,
      });

      expect(received.get('upstream')).toContain('## Working-memory handoff');
      expect(received.get('upstream')).toContain('[WORKING-MEMORY]');
      const independent = received.get('independent')!;
      expect(independent).not.toContain('## Working-memory handoff');
      expect(independent).not.toContain('[WORKING-MEMORY]');
      expect(withoutShardIdentity(independent)).toBe('independent');
      const downstream = received.get('downstream')!;
      expect(downstream).toContain('## Dependency handoff');
      expect(downstream).toContain('- upstream: {"upstream":"available","upstreamOutcome":"landed","reusables":["src/reuse.ts"],"decisions":["keep API"],"truncated":false}');
      expect(records.map((record) => record.data)).toEqual([
        expect.objectContaining({ feature: 'upstream', downstreamCount: 1 }),
      ]);
    } finally {
      off();
    }
  });

  test('orchestrateSelfDev harvests front-loaded working memory from the full screen transcript and records its source', async () => {
    const received = new Map<string, string>();
    const spaceByFeature = new Map<string, string>();
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-full-transcript-working-memory-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'dependency.handoff') records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      received.set(feature, input.feature);
      spaceByFeature.set(feature, input.spaceId);
      return {
        address: `self-impl:${input.spaceId}`,
        done: Promise.resolve({ exitCode: 0, output: 'tail without working memory' }),
      };
    };
    try {
      await orchestrateSelfDev({
        goals: [
          { id: 'front-loaded', feature: 'front-loaded' },
          { id: 'no-marker', feature: 'no-marker' },
          { id: 'downstream', feature: 'downstream', dependsOn: ['front-loaded', 'no-marker'] },
        ],
        spawn,
        readScreenTranscript: (spaceId) => spaceId === spaceByFeature.get('front-loaded')
          ? `[WORKING-MEMORY]\n${JSON.stringify({ summary: 'front-loaded', reusables: ['src/reuse.ts#boundary'], decisions: ['preserve full transcript harvest'] })}\n${'x'.repeat(4_097)}`
          : spaceId === spaceByFeature.get('no-marker') ? 'screen output without a working-memory marker' : null,
      });

      const downstream = received.get('downstream')!;
      expect(downstream).toContain('- front-loaded: {"upstream":"available","upstreamOutcome":"landed","reusables":["src/reuse.ts#boundary"],"decisions":["preserve full transcript harvest"],"truncated":false}');
      expect(downstream).toContain('- no-marker: {"upstream":"empty","upstreamOutcome":"landed","reusables":[],"decisions":[],"truncated":false}');
      expect(records.map((record) => record.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({ upstreamFeature: 'front-loaded', status: 'present', harvestSource: 'screen-transcript' }),
        expect.objectContaining({ upstreamFeature: 'no-marker', status: 'empty', harvestSource: 'screen-transcript' }),
      ]));
    } finally {
      off();
    }
  });

  test('keeps empty and unreadable completed output distinct without blocking dependents', async () => {
    const received = new Map<string, string>();
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      received.set(feature, input.feature);
      const output = feature === 'broken'
        ? '[WORKING-MEMORY]\n{broken\n{"phaseId":"fallback","summary":"must not mask marker","reusables":["wrong"],"decisions":[],"artifacts":[]}'
        : '';
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output }) };
    };
    const results = await orchestrateSelfDev({
      goals: [
        { id: 'empty', feature: 'empty' },
        { id: 'broken', feature: 'broken' },
        { id: 'downstream', feature: 'downstream', dependsOn: ['empty', 'broken'] },
      ],
      spawn,
    });

    expect(results.every((result) => result.status === 'done')).toBe(true);
    const downstream = received.get('downstream')!;
    expect(downstream).toContain('- empty: {"upstream":"empty","upstreamOutcome":"landed","reusables":[],"decisions":[],"truncated":false}');
    expect(downstream).toContain('- broken: {"upstream":"unreadable","upstreamOutcome":"landed","reusables":[],"decisions":[],"truncated":false}');
  });

  test('observes no-upstream plus each upstream handoff state without changing dependent prompts', async () => {
    const records: LogRecord[] = [];
    const received = new Map<string, string>();
    const off = debug.registerSink({
      name: 'orchestrate-dependency-handoff-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'dependency.handoff') records.push(record);
      },
    });
    const values = Array.from({ length: 40 }, (_, index) => `${index}-${'x'.repeat(240)}`);
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = input.feature.split('\n')[0]!;
      received.set(feature, input.feature);
      const output = feature === 'present'
        ? `[WORKING-MEMORY]\n${JSON.stringify({ summary: 'present', reusables: ['src/reuse.ts'], decisions: ['keep API'] })}`
        : feature === 'truncated'
          ? `[WORKING-MEMORY]\n${JSON.stringify({ summary: 'truncated', reusables: values, decisions: values })}`
          : feature === 'unreadable'
            ? '[WORKING-MEMORY]\n{broken'
            : '';
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output }) };
    };
    try {
      await orchestrateSelfDev({
        goals: [
          { id: 'present', feature: 'present' },
          { id: 'empty', feature: 'empty' },
          { id: 'unreadable', feature: 'unreadable' },
          { id: 'truncated', feature: 'truncated' },
          { id: 'downstream', feature: 'downstream', dependsOn: ['present', 'empty', 'unreadable', 'truncated'] },
          { id: 'independent', feature: 'independent' },
        ],
        concurrency: 6,
        spawn,
      });
      const handoffs = records.map((record) => record.data as Record<string, unknown>);
      expect(handoffs).toEqual(expect.arrayContaining([
        expect.objectContaining({ feature: 'independent', upstreamTaskId: null, status: 'no-upstream', truncated: false }),
        expect.objectContaining({ feature: 'downstream', upstreamTaskId: expect.any(String), upstreamFeature: 'present', status: 'present', truncated: false }),
        expect.objectContaining({ feature: 'downstream', upstreamTaskId: expect.any(String), upstreamFeature: 'empty', status: 'empty', truncated: false }),
        expect.objectContaining({ feature: 'downstream', upstreamTaskId: expect.any(String), upstreamFeature: 'unreadable', status: 'unreadable', truncated: false }),
        expect.objectContaining({ feature: 'downstream', upstreamTaskId: expect.any(String), upstreamFeature: 'truncated', status: 'present', truncated: true }),
      ]));
      const downstream = received.get('downstream')!;
      expect(downstream).toContain('- present: {"upstream":"available","upstreamOutcome":"landed","reusables":["src/reuse.ts"],"decisions":["keep API"],"truncated":false}');
      expect(downstream).toContain('- empty: {"upstream":"empty","upstreamOutcome":"landed","reusables":[],"decisions":[],"truncated":false}');
      expect(downstream).toContain('- unreadable: {"upstream":"unreadable","upstreamOutcome":"landed","reusables":[],"decisions":[],"truncated":false}');
      expect(downstream).toContain('## Dependency handoff');
    } finally {
      off();
    }
  });

  test('goals sharing a hot path are serialized (never concurrent)', async () => {
    const { spawn, completedAtSpawn, maxLive } = makeOrderTrackingSpawn(8);
    await orchestrateSelfDev({
      goals: [
        { id: 'x', feature: 'X', hotPaths: ['src/harness/harness-seams.ts'] },
        { id: 'y', feature: 'Y', hotPaths: ['src/harness/harness-seams.ts'] },
      ],
      concurrency: 4,
      spawn,
    });
    // Y depends implicitly on X (shared hot path) → never overlap.
    expect(maxLive()).toBe(1);
    expect(completedAtSpawn.get('Y')).toContain('X');
  });

  test('independent hot paths still run in parallel', async () => {
    const { spawn, maxLive } = makeOrderTrackingSpawn(8);
    await orchestrateSelfDev({
      goals: [
        { id: 'x', feature: 'X', hotPaths: ['src/a.ts'] },
        { id: 'y', feature: 'Y', hotPaths: ['src/b.ts'] },
      ],
      concurrency: 4,
      spawn,
    });
    expect(maxLive()).toBe(2);
  });

  test('dependency cycle is rejected synchronously', () => {
    const { spawn } = makeOrderTrackingSpawn();
    expect(() => orchestrateSelfDev({
      goals: [
        { id: 'a', feature: 'A', dependsOn: ['b'] },
        { id: 'b', feature: 'B', dependsOn: ['a'] },
      ],
      spawn,
    })).toThrow(/cycle/i);
  });
});

describe('orchestrateSelfDev — S3 disposition · cascade · teardown', () => {
  test('carries providerErrors from child disposition to SelfDevJobResult without changing legacy missing fields', async () => {
    const providerErrors = { count: 5, provider: 'grok', category: 'quota' as const };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'quota' }, { feature: 'legacy' }],
      spawn: (input) => ({
        address: `self-impl:${input.spaceId}`,
        done: Promise.resolve({ exitCode: 1, output: '', disposition: {
          stage: 'timed-out', failureClassification: 'provider-error',
          ...(input.feature.startsWith('quota') ? { providerErrors } : {}),
        } }),
      }),
    });
    expect(results.find((result) => result.feature === 'quota')!.providerErrors).toEqual(providerErrors);
    expect(results.find((result) => result.feature === 'legacy')).not.toHaveProperty('providerErrors');
  });

  test('captures --json disposition (stage/prUrl/merged) into results', async () => {
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve<SelfImplementJobDone>({
        exitCode: 0,
        output: '',
        disposition: { stage: 'merged', ok: true, prUrl: 'https://x/pr/1', prNumber: 1, merged: true, branch: 'b', worktreePath: '/wt/a' },
      }),
    });
    const [r] = await orchestrateSelfDev({ goals: [{ feature: 'g', openPr: true }], spawn });
    expect(r).toMatchObject({ status: 'done', stage: 'merged', prUrl: 'https://x/pr/1', prNumber: 1, merged: true, branch: 'b' });
  });

  test('requires both merged stage and landing marker for a landed outcome', () => {
    expect(summarizeResults([
      { taskId: 'landed', feature: 'landed', status: 'done', stage: 'merged', merged: true },
      { taskId: 'missing-marker', feature: 'missing-marker', status: 'done', stage: 'merged' },
    ])).toEqual({ done: 2, failed: 0, cancelled: 0, landed: 1, unlanded: 1 });
  });

  test('counts landed outcomes separately from completed processes in both terminal summaries', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-landing-summary-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && (record.event === 'orchestrate.reduce' || record.event === 'done')) records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => {
      const feature = withoutShardIdentity(input.feature);
      const disposition = feature === 'landed'
        ? { stage: 'merged', ok: true, merged: true }
        : { stage: 'review-blocked', ok: false, merged: false };

      return {
        address: `self-impl:${input.spaceId}`,
        done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '', disposition }),
      };
    };
    try {
      const results = await orchestrateSelfDev({ goals: [{ feature: 'landed' }, { feature: 'review-blocked' }], concurrency: 2, spawn });
      expect(results.map((result) => result.status)).toEqual(['done', 'done']);
      expect(classifyFailure(results.find((result) => result.feature === 'review-blocked')!)).toBe('unconverged');
      expect(summarizeFailureKinds(results)).toEqual({ falseFailure: 0, unconverged: 1, unclassified: 0, transient: 0, blockedUpstream: 0, unconvergedDecomposable: 0, mainSyncBlocked: 0 });
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.data).toMatchObject({ total: 2, landed: 1, unlanded: 1 });
      }
      const reduce = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect(reduce.data).toMatchObject({ done: 2, failed: 0, cancelled: 0, unconverged: 1 });
      expect((reduce.data as { failures: Array<{ stage: string; kind: string }> }).failures).toEqual([
        expect.objectContaining({ stage: 'review-blocked', kind: 'unconverged' }),
      ]);
      const done = records.find((record) => record.event === 'done')!;
      expect(done.data).toMatchObject({ completed: 2, failed: 0, cancelled: 0, landed: 1, unlanded: 1 });
    } finally {
      off();
    }
  });

  test('emits additive terminal outcomes from the actual done event without collapsing failed dispositions', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-done-outcomes-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'done') records.push(record);
      },
    });
    const spawn: SelfImplementJobSpawn = (input) => {
      const dispositionByFeature: Record<string, SelfImplementJobDone['disposition']> = {
        complete: { stage: 'merged', ok: true, merged: true, prUrl: 'https://x/pr/complete' },
        review: { stage: 'review-blocked', ok: false, merged: false, prUrl: 'https://x/pr/review' },
        transport: { stage: 'merged', ok: true, merged: true, prUrl: 'https://x/pr/transport' },
      };
      const feature = withoutShardIdentity(input.feature);
      const exitCode = feature === 'complete' ? 0 : 1;
      return {
        address: `self-impl:${input.spaceId}`,
        done: Promise.resolve({ exitCode, output: '', disposition: dispositionByFeature[feature] }),
      };
    };
    try {
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'complete' }, { feature: 'review' }, { feature: 'transport' }, { feature: 'missing' }],
        concurrency: 4,
        spawn,
      });
      expect(records).toHaveLength(1);
      const data = records[0]!.data as {
        total: number; completed: number; failed: number; cancelled: number; landed: number; unlanded: number; promoted: number;
        outcomes: Array<{ taskId: string; status: string; stage: string | null; merged: boolean | null; prUrl: string | null }>;
      };
      expect(data).toMatchObject({ total: 4, completed: 1, failed: 3, cancelled: 0, landed: 2, unlanded: 2, promoted: 3 });
      expect(data.outcomes).toHaveLength(data.total);
      expect(new Set(data.outcomes.map((outcome) => outcome.taskId)).size).toBe(data.total);
      const outcomeByTask = new Map(data.outcomes.map((outcome) => [outcome.taskId, outcome]));
      for (const result of results) {
        expect(outcomeByTask.get(result.taskId)).toMatchObject({
          status: result.status,
          stage: result.stage ?? null,
          merged: result.merged ?? null,
          prUrl: result.prUrl ?? null,
        });
      }
      expect(results.find((result) => result.feature === 'review')).toMatchObject({
        status: 'failed', stage: 'review-blocked', merged: false, prUrl: 'https://x/pr/review',
      });
      expect(results.find((result) => result.feature === 'transport')).toMatchObject({
        status: 'failed', stage: 'merged', merged: true, prUrl: 'https://x/pr/transport',
      });
      expect(results.find((result) => result.feature === 'missing')).toMatchObject({ status: 'failed' });
      expect(outcomeByTask.get(results.find((result) => result.feature === 'missing')!.taskId)).toMatchObject({
        stage: null, merged: null, prUrl: null,
      });
    } finally {
      off();
    }
  });

  test('failed dependency cascades cancel to dependents (DEP_FAILED)', async () => {
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: 'x',
      done: new Promise<SelfImplementJobDone>((resolve) =>
        setTimeout(() => resolve(input.feature.split('\n')[0] === 'A' ? { exitCode: 1, output: 'boom' } : { exitCode: 0, output: '' }), 5)),
    });
    const results = await orchestrateSelfDev({
      goals: [{ id: 'a', feature: 'A' }, { id: 'b', feature: 'B', dependsOn: ['a'] }, { id: 'c', feature: 'C', dependsOn: ['b'] }],
      concurrency: 4,
      spawn,
    });
    const byF = new Map(results.map((r) => [r.feature, r]));
    expect(byF.get('A')!.status).toBe('failed');
    // B (direct dep) AND C (transitive dep) both cascade-cancelled.
    expect(byF.get('B')!.status).toBe('cancelled');
    expect(byF.get('B')!.error?.code).toBe('DEP_FAILED');
    expect(byF.get('C')!.status).toBe('cancelled');
  });

  test('teardown (opt-in) removes non-PR worktrees, preserves PR-opened', async () => {
    const removed: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: 'x',
      done: Promise.resolve<SelfImplementJobDone>({
        exitCode: 0,
        output: '',
        disposition: withoutShardIdentity(input.feature) === 'withpr'
          ? { stage: 'pr-opened', worktreePath: '/wt/pr', prUrl: 'https://x/pr/2' }
          : { stage: 'pr-declined', worktreePath: '/wt/plain' },
      }),
    });
    await orchestrateSelfDev({
      goals: [{ feature: 'plain' }, { feature: 'withpr' }],
      concurrency: 2,
      spawn,
      teardown: true,
      removeWorktree: (p) => removed.push(p),
    });
    expect(removed).toEqual(['/wt/plain']); // PR-opened worktree preserved
  });

  test('teardown default OFF — worktrees preserved (inspect-before-destroy)', async () => {
    const removed: string[] = [];
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'x',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '', disposition: { worktreePath: '/wt/x' } }),
    });
    await orchestrateSelfDev({ goals: [{ feature: 'g' }], spawn, removeWorktree: (p) => removed.push(p) });
    expect(removed).toEqual([]);
  });
});

describe('orchestrateSelfDev — S3 resume + checkpoint', () => {
  test('resumeKey folds trim, whitespace runs, and case but not different wording', () => {
    expect(resumeKey('  Build   Resume Key  ')).toBe(resumeKey('build resume key'));
    expect(resumeKey('build resume key')).not.toBe(resumeKey('build checkpoint key'));
  });

  test('resumeKey stays locale-independent when locale lowercasing would split I and i', () => {
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function mockedTurkishLowercase() {
      return String(this).replace(/I/g, 'ı').toLowerCase();
    };
    try {
      expect(resumeKey('IMPLEMENT I')).toBe(resumeKey('implement i'));
    } finally {
      String.prototype.toLocaleLowerCase = original;
    }
  });

  test('resume skips a done goal despite locale-sensitive I casing', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function mockedTurkishLowercase() {
      return String(this).replace(/I/g, 'ı').toLowerCase();
    };
    try {
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'IMPLEMENT I' }],
        resumeFrom: [{ taskId: 't', feature: 'implement i', status: 'done' }],
        spawn,
      });
      expect(spawned).toEqual([]);
      expect(results).toEqual([{ taskId: 't', feature: 'implement i', status: 'done', resumeDisposition: 'skip' }]);
    } finally {
      String.prototype.toLocaleLowerCase = original;
    }
  });

  test('resume skips done goals whose feature differs only by whitespace and case', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: '  Build   Resume Key  ' }],
      resumeFrom: [{ taskId: 't', feature: 'build resume key', status: 'done' }],
      spawn,
    });
    expect(spawned).toEqual([]);
    expect(results).toEqual([{ taskId: 't', feature: 'build resume key', status: 'done', resumeDisposition: 'skip' }]);
  });

  test('resume preserves last done result for duplicate normalized checkpoint keys', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'build resume key' }],
      resumeFrom: [
        { taskId: 'first', feature: 'Build Resume Key', status: 'done' },
        { taskId: 'last', feature: '  build   resume key  ', status: 'done' },
      ],
      spawn,
    });
    expect(spawned).toEqual([]);
    expect(results).toEqual([{ taskId: 'last', feature: '  build   resume key  ', status: 'done', resumeDisposition: 'skip' }]);
  });

  test('resume preserves last done result for duplicate exact checkpoint features', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'build resume key' }],
      resumeFrom: [
        { taskId: 'first', feature: 'build resume key', status: 'done' },
        { taskId: 'last', feature: 'build resume key', status: 'done' },
      ],
      spawn,
    });
    expect(spawned).toEqual([]);
    expect(results).toEqual([{ taskId: 'last', feature: 'build resume key', status: 'done', resumeDisposition: 'skip' }]);
  });

  test('resume runs a different feature instead of treating it as done', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    await orchestrateSelfDev({
      goals: [{ feature: 'build checkpoint key' }],
      resumeFrom: [{ taskId: 't', feature: 'build resume key', status: 'done' }],
      spawn,
    });
    expect(spawned).toEqual(['build checkpoint key']);
  });

  test('resume skips done goals (not re-run) and carries their result', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'A' }, { feature: 'B' }],
      resumeFrom: [{ taskId: 't', feature: 'A', status: 'done', prUrl: 'https://x/1' }],
      spawn,
    });
    expect(spawned).toEqual(['B']); // A skipped — only B ran
    const byF = new Map(results.map((r) => [r.feature, r]));
    expect(byF.get('A')!.status).toBe('done');
    expect(byF.get('A')!.prUrl).toBe('https://x/1'); // carried from prior run
    expect(byF.get('B')!.status).toBe('done');
  });

  test('resume re-runs failed and cancelled priors with their rerun disposition', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'failed' }, { feature: 'cancelled' }],
      resumeFrom: [
        { taskId: 'failed-prior', feature: 'failed', status: 'failed' },
        { taskId: 'cancelled-prior', feature: 'cancelled', status: 'cancelled' },
      ],
      spawn,
    });
    expect(spawned.sort()).toEqual(['failed', 'cancelled'].sort());
    expect(results.map((result) => result.resumeDisposition)).toEqual(['rerun', 'rerun']);
  });

  test('new goals without a matching prior do not claim a resume disposition', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'x',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }),
    });
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'new without resume' }],
      spawn,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.resumeDisposition).toBeUndefined();
  });

  test('resume dispositions distinguish landed skips, known unlanded reruns, and PR duplicate risk', () => {
    expect(classifyResumeDisposition({ taskId: 'landed', feature: 'A', status: 'done', stage: 'merged', merged: true })).toBe('skip');
    expect(classifyResumeDisposition({ taskId: 'failed-landed', feature: 'FL', status: 'failed', stage: 'merged', merged: true })).toBe('skip');
    expect(classifyResumeDisposition({ taskId: 'failed-pr', feature: 'FP', status: 'failed', stage: 'pr-opened', merged: false })).toBe('rerun-duplicate-risk');
    for (const stage of ['review-blocked', 'gate-failed', 'merge-conflict', 'timed-out', 'aborted', 'pr-declined']) {
      expect(classifyResumeDisposition({ taskId: stage, feature: stage, status: 'done', stage })).toBe('rerun');
    }
    expect(classifyResumeDisposition({ taskId: 'unmerged', feature: 'U', status: 'done', stage: 'merged', merged: false })).toBe('rerun');
    expect(classifyResumeDisposition({ taskId: 'explicit-unlanded', feature: 'EU', status: 'done', merged: false })).toBe('rerun');
    expect(classifyResumeDisposition({ taskId: 'new-stage-unlanded', feature: 'NS', status: 'done', stage: 'new-stage', merged: false })).toBe('rerun');
    expect(classifyResumeDisposition({ taskId: 'pr', feature: 'P', status: 'done', stage: 'pr-opened', merged: false })).toBe('rerun-duplicate-risk');
    expect(classifyResumeDisposition({ taskId: 'legacy', feature: 'L', status: 'done' })).toBe('skip');
  });

  test('resumeHold carries a needs-human prior instead of rerunning it (supervisor relaunch)', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const resumeFrom: SelfDevJobResult[] = [
      { taskId: 'pr', feature: 'opened a pr', status: 'done', stage: 'pr-opened', merged: false },
      { taskId: 'boom', feature: 'transient', status: 'failed', stage: 'error' },
    ];
    const goals = [{ feature: 'opened a pr' }, { feature: 'transient' }];
    // 대조군 — 보류가 없으면 pr-opened 는 duplicate-risk 로 다시 돈다(종전 동작 · 사람의 --resume 에는 그대로 둔다)
    await orchestrateSelfDev({ goals, resumeFrom, spawn });
    expect(spawned.sort()).toEqual(['opened a pr', 'transient']);
    spawned.length = 0;
    const results = await orchestrateSelfDev({ goals, resumeFrom, resumeHold: ['pr'], spawn });
    expect(spawned).toEqual(['transient']);
    expect(results.find((r) => r.taskId === 'pr')).toMatchObject({ stage: 'pr-opened', resumeDisposition: 'skip' });
  });

  test('resume skips landed work but re-runs known unlanded work and preserves duplicate risk', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'landed' }, { feature: 'failed landed' }, { feature: 'review' }, { feature: 'gate' }, { feature: 'aborted' }, { feature: 'declined' }, { feature: 'pr opened' }],
      resumeFrom: [
        { taskId: 'landed-prior', feature: 'landed', status: 'done', stage: 'merged', merged: true },
        { taskId: 'failed-landed-prior', feature: 'failed landed', status: 'failed', stage: 'merged', merged: true },
        { taskId: 'review-prior', feature: 'review', status: 'done', stage: 'review-blocked' },
        { taskId: 'gate-prior', feature: 'gate', status: 'done', stage: 'gate-failed' },
        { taskId: 'aborted-prior', feature: 'aborted', status: 'done', stage: 'aborted' },
        { taskId: 'declined-prior', feature: 'declined', status: 'done', stage: 'pr-declined' },
        { taskId: 'pr-prior', feature: 'pr opened', status: 'failed', stage: 'pr-opened', merged: false, prUrl: 'https://x/1' },
      ],
      spawn,
    });
    expect(spawned.sort()).toEqual(['review', 'gate', 'aborted', 'declined', 'pr opened'].sort());
    expect(results.find((result) => result.feature === 'landed')).toMatchObject({ taskId: 'landed-prior', status: 'done', stage: 'merged', merged: true, resumeDisposition: 'skip' });
    expect(results.find((result) => result.feature === 'failed landed')).toMatchObject({ taskId: 'failed-landed-prior', status: 'failed', stage: 'merged', merged: true, resumeDisposition: 'skip' });
    expect(results.find((result) => result.feature === 'review')!.resumeDisposition).toBe('rerun');
    expect(results.find((result) => result.feature === 'pr opened')!.resumeDisposition).toBe('rerun-duplicate-risk');
  });

  test('resume runs explicitly unlanded done results without a recognized stage', async () => {
    const spawned: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      spawned.push(withoutShardIdentity(input.feature));
      return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'missing landing marker' }, { feature: 'new unlanded stage' }],
      resumeFrom: [
        { taskId: 'missing-marker-prior', feature: 'missing landing marker', status: 'done', merged: false },
        { taskId: 'new-stage-prior', feature: 'new unlanded stage', status: 'done', stage: 'future-stage', merged: false },
      ],
      spawn,
    });
    expect(spawned.sort()).toEqual(['missing landing marker', 'new unlanded stage'].sort());
    expect(results.map((result) => result.resumeDisposition)).toEqual(['rerun', 'rerun']);
  });

  test('checkpoint is invoked with the running result set', async () => {
    const sizes: number[] = [];
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'x',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }),
    });
    const final = await orchestrateSelfDev({
      goals: [{ feature: 'A' }, { feature: 'B' }],
      spawn,
      checkpoint: (rs) => sizes.push(rs.length),
    });
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBe(final.length); // last checkpoint has all
  });

  test('all-resumed (nothing to run) resolves with the carried results', async () => {
    let spawnedAny = false;
    const spawn: SelfImplementJobSpawn = () => { spawnedAny = true; return { address: 'x', done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) }; };
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'A' }],
      resumeFrom: [{ taskId: 't', feature: 'A', status: 'done' }],
      spawn,
    });
    expect(spawnedAny).toBe(false);
    expect(results).toEqual([{ taskId: 't', feature: 'A', status: 'done', resumeDisposition: 'skip' }]);
  });
});

describe('orchestrateSelfDev — 화면 관측 + false-failure 조정(2026-07-21 대표 co-design)', () => {
  // exit=1 인데 자식 goal-loop 화면은 GOAL-COMPLETE = 스폰 신호 단절(detached PTY). 재현 없이 감지.
  const failSpawn: SelfImplementJobSpawn = (input) => ({
    address: `self-impl:${input.spaceId}`,
    done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: '' }),
  });

  test('실패 잡: 화면 outcome=complete → reconcileMismatch + screenTail 회수', async () => {
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'S4 계측' }],
      spawn: failSpawn,
      readScreenTail: () => ({ text: 'grep...\nEdit...\nGOAL-COMPLETE', outcome: 'complete', path: '/x.screen' }),
    });
    const r = results[0]!;
    expect(r.status).toBe('failed');            // exit-code 는 여전히 실패
    expect(r.reconcileMismatch).toBe(true);     // 그러나 화면은 성공 → false-failure 플래그
    expect(r.screenOutcome).toBe('complete');
    expect(r.screenTail).toContain('GOAL-COMPLETE');
    expect(r.screenSpace).toBeTruthy();
  });

  test('A 정밀화: 화면=complete 지만 disposition=gate-failed → 정당 실패(reconcile 아님)', async () => {
    // goal-loop 은 GOAL-COMPLETE 했으나 이후 gate 가 정당하게 실패 → exit≠0. false-failure 아님(오탐 차단).
    const gateFailSpawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: '', disposition: { stage: 'gate-failed', ok: false } }),
    });
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'legit gate fail' }],
      spawn: gateFailSpawn,
      readScreenTail: () => ({ text: 'GOAL-COMPLETE', outcome: 'complete', path: '/x.screen' }),
    });
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.reconcileMismatch).toBeUndefined();  // 정당한 gate 실패 = false-failure 아님
    expect(results[0]!.screenOutcome).toBe('complete');
  });

  test('A: 화면=complete + disposition=성공(merged)인데 exit=fail → 진짜 단절(reconcile)', async () => {
    const disconnectSpawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: '', disposition: { stage: 'merged', ok: true, merged: true } }),
    });
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'disconnect' }],
      spawn: disconnectSpawn,
      readScreenTail: () => ({ text: 'GOAL-COMPLETE', outcome: 'complete', path: '/x.screen' }),
    });
    expect(results[0]!.reconcileMismatch).toBe(true);   // 성공 stage 인데 exit fail = 진짜 단절
  });

  test('실패 잡: 화면 outcome=incomplete → 조정 플래그 없음(진짜 실패)', async () => {
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'real fail' }],
      spawn: failSpawn,
      readScreenTail: () => ({ text: '타임아웃 true', outcome: 'incomplete', path: '/x.screen' }),
    });
    expect(results[0]!.reconcileMismatch).toBeUndefined();
    expect(results[0]!.screenOutcome).toBe('incomplete');
  });

  test('성공 잡도 화면 outcome 을 carry', async () => {
    const okSpawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }),
    });
    const results = await orchestrateSelfDev({
      goals: [{ feature: 'ok' }],
      spawn: okSpawn,
      readScreenTail: () => ({ text: 'GOAL-COMPLETE', outcome: 'complete', path: '/x.screen' }),
    });
    expect(results[0]!.status).toBe('done');
    expect(results[0]!.screenOutcome).toBe('complete');
  });
});

// ── U4: 막힌 상류의 맥락 (2026-08-19 · 대표 「직접 수정」) ──────────────────────
//
// ⛔ 리뷰어 지적을 계약으로 박는다: 새 optional 의 기본은 ***'unknown'*** 이다.
//   기본을 'landed' 로 두면 «상태를 모르는» 기존 호출자가 생략했을 때
//   하류가 그 기억을 「이미 된 것」으로 읽는다.
describe('formatShardHandoffInput — 상류 결말', () => {
  const mem = [{ reusables: ['r1'], decisions: ['d1'] }] as never;

  test('⛔ 생략하면 「모른다」다 — 「착지」로 «단정하지 않는다»', () => {
    const got = JSON.parse(formatShardHandoffInput(mem)) as { upstreamOutcome: string; upstream: string };
    expect(got.upstreamOutcome).toBe('unknown');
    expect(got.upstream).toBe('available');   // ⭐ 「기억을 읽었나」는 그대로
  });

  test('착지·막힘·모름이 서로 «다른 값»이다', () => {
    const outcomes = (['landed', 'blocked', 'unknown'] as const)
      .map((o) => (JSON.parse(formatShardHandoffInput(mem, undefined, o)) as { upstreamOutcome: string }).upstreamOutcome);
    expect(outcomes).toEqual(['landed', 'blocked', 'unknown']);
  });

  test('⛔ 결말을 upstream 에 «접지 않는다» — 두 축이 독립이다', () => {
    const blockedButHasMemory = JSON.parse(formatShardHandoffInput(mem, undefined, 'blocked')) as { upstream: string; upstreamOutcome: string };
    expect(blockedButHasMemory.upstream).toBe('available');      // 기억은 읽혔다
    expect(blockedButHasMemory.upstreamOutcome).toBe('blocked'); // 그런데 상류는 막혔다

    const landedButEmpty = JSON.parse(formatShardHandoffInput([], undefined, 'landed')) as { upstream: string; upstreamOutcome: string };
    expect(landedButEmpty.upstream).toBe('empty');
    expect(landedButEmpty.upstreamOutcome).toBe('landed');
  });

  test('기억을 «못 읽어도» 결말은 남는다', () => {
    const got = JSON.parse(formatShardHandoffInput(null, undefined, 'blocked')) as { upstream: string; upstreamOutcome: string };
    expect(got.upstream).toBe('unreadable');
    expect(got.upstreamOutcome).toBe('blocked');
  });

  test('⛔ 잘려도 결말을 «잃지 않는다»', () => {
    const big = [{ reusables: Array.from({ length: 200 }, (_, i) => `reuse-${i}-${'x'.repeat(40)}`), decisions: [] }] as never;
    const got = JSON.parse(formatShardHandoffInput(big, 300, 'blocked')) as { truncated: boolean; upstreamOutcome: string };
    expect(got.truncated).toBe(true);
    expect(got.upstreamOutcome).toBe('blocked');
  });
});


// ⭐⭐⭐ 2026-08-19 — 런 슈퍼바이저의 «입력». 북극성 런 run-ecd7cf73 의 실물 결과가 이 절의 근거다.
//   📏 그 런은 7조각 중 ③이 git 락 경합으로 죽고 하류 ⑤⑥가 취소됐다 — «한 번의 경합이 셋을 먹었다».
//   ⛔ 그런데 종전 트리아지 산출은 cancelled=2 인데 failures 에 «셋만»(⓪①③) 실었고,
//     다시 걸면 풀리는 ③을 `unclassified`(=사람이 본다)로 떨어뜨렸다.
//   ⇒ 📌 ***끝까지 돌려야 하는 자가 「무엇을 다시 걸면 되는지」를 못 읽었다.***
describe('triageRun — 실패를 «다음 행동»으로 옮긴다', () => {
  // 실물 그대로(logs.db · orchestrate.reduce 산출).
  const NORTHSTAR = [
    { taskId: 'task:3084781ff15f', feature: '0-research', status: 'done', stage: 'pr-opened' },
    { taskId: 'task:d0090d1dd4c7', feature: '1-consolidate', status: 'done', stage: 'pr-opened' },
    { taskId: 'task:5e448dcbdbba', feature: '2-foundation', status: 'done', stage: 'merged', merged: true },
    {
      taskId: 'task:0cb530a5264b', feature: '3', status: 'failed', stage: 'error',
      error: {
        code: 'SELF_IMPL_FAILED',
        message: "git worktree base sync failed — origin/main exists but fetch failed: error: cannot lock ref 'refs/remotes/origin/main': is at c33b79d99",
      },
    },
    { taskId: 'task:6e8b7f21094a', feature: '4-services', status: 'done', stage: 'merged', merged: true },
    { taskId: 'task:3628aa60ed63', feature: '5', status: 'cancelled', error: { code: 'DEP_FAILED', message: 'dependency task:0cb530a5264b failed' } },
    { taskId: 'task:fdd78ae151c0', feature: '6', status: 'cancelled', error: { code: 'DEP_FAILED', message: 'dependency task:0cb530a5264b failed' } },
  ] as never[];

  test('⭐ 락 경합은 transient → rerun (종전엔 unclassified = 사람이 봤다)', () => {
    expect(classifyFailure(NORTHSTAR[3]!)).toBe('transient');
    expect(triageActionFor('transient')).toBe('rerun');
  });

  test('gate·review의 일시적 실행 실패는 기존 판정으로 transient → rerun 이다', () => {
    for (const stage of ['gate-failed', 'review-blocked']) {
      const result = {
        taskId: stage,
        feature: stage,
        status: 'failed',
        stage,
        error: { code: 'SELF_IMPL_FAILED', message: "fatal: Unable to create '/r/.git/index.lock': File exists." },
      } as never;
      expect(classifyFailure(result)).toBe('transient');
      expect(triageRun([result]).rerunnable).toEqual([stage]);
    }
  });

  test('gate·review의 비일시적 실패는 unconverged 로 남는다', () => {
    for (const stage of ['gate-failed', 'review-blocked']) {
      expect(classifyFailure({
        taskId: stage,
        feature: stage,
        status: 'failed',
        stage,
        error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' },
      } as never)).toBe('unconverged');
    }
  });

  test('주입된 전제 검사 경고는 원장 분류가 비어 있는 수렴 실패만 가른다', () => {
    const base = {
      taskId: 'preflight-warning', feature: 'preflight-warning', status: 'failed', stage: 'review-blocked',
      error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' },
    } as never;
    const warningRows = () => [{ data: JSON.stringify({ taskId: 'preflight-warning', warnings: [{ kind: 'open-pr' }] }) }] as never[];
    const cleanRows = () => [{ data: JSON.stringify({ taskId: 'preflight-warning', warnings: [] }) }] as never[];
    expect(triageRun([base], undefined, false, warningRows).classifications[0]?.kind).toBe('preflight-warning');
    expect(triageRun([base], undefined, false, cleanRows).classifications[0]?.kind).toBe('unconverged');
    expect(triageRun([base], undefined, false, () => []).classifications[0]?.kind).toBe('unconverged');
    expect(triageRun([base]).classifications[0]?.kind).toBe('unconverged');
    expect(triageRun([base], undefined, false, () => { throw new Error('logs unavailable'); }).classifications[0]?.kind).toBe('unconverged');
    const ledgerWarningRows = () => [{
      data: JSON.stringify({ taskId: 'ledger-wins', warnings: [{ kind: 'open-pr' }] }),
    }] as never[];
    expect(triageRun([{
      taskId: 'ledger-wins', feature: 'ledger-wins', status: 'failed', stage: 'review-blocked',
      error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' }, failureClassification: 'quota-exhausted',
    } as never], undefined, false, ledgerWarningRows).classifications[0]?.kind).toBe('transient');
  });

  test('incomplete matched preflight observations remain unknown rather than clean', () => {
    const base = {
      taskId: 'preflight-incomplete', feature: 'preflight-incomplete', status: 'failed', stage: 'review-blocked',
      error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' },
    } as never;
    const missingWarnings = () => [{ data: JSON.stringify({ taskId: 'preflight-incomplete' }) }] as never[];
    const invalidWarnings = () => [{ data: JSON.stringify({ taskId: 'preflight-incomplete', warnings: 'open-pr' }) }] as never[];

    expect(queryPreflightWarning(['preflight-incomplete'], missingWarnings)).toBe('unknown');
    expect(queryPreflightWarning(['preflight-incomplete'], invalidWarnings)).toBe('unknown');
    expect(triageRun([base], undefined, false, missingWarnings).classifications[0]?.kind).toBe('unconverged');
    expect(triageRun([base], undefined, false, invalidWarnings).classifications[0]?.kind).toBe('unconverged');
  });

  test('matches a preflight warning recorded under taskId when the failed result also has a runId', () => {
    const failedWithBothIds = {
      runId: 'run:preflight-warning', taskId: 'task:preflight-warning', feature: 'preflight-warning',
      status: 'failed', stage: 'review-blocked',
      error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' },
    } as never;
    const taskIdWarning = () => [{
      data: JSON.stringify({ taskId: 'task:preflight-warning', warnings: [{ kind: 'open-pr' }] }),
    }] as never[];

    const failedWithoutMatchingTaskId = {
      runId: 'run:preflight-warning', taskId: 'task:clean', feature: 'preflight-warning',
      status: 'failed', stage: 'review-blocked',
      error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' },
    } as never;

    expect(triageRun([failedWithBothIds], undefined, false, taskIdWarning).classifications[0]?.kind).toBe('preflight-warning');
    expect(triageRun([failedWithoutMatchingTaskId], undefined, false, taskIdWarning).classifications[0]?.kind).toBe('unconverged');
  });

  test('⭐ 상류 실패로 취소된 조각을 «본다» (종전엔 분류 자체가 null 이라 산출에서 사라졌다)', () => {
    expect(classifyFailure(NORTHSTAR[5]!)).toBe('blocked-upstream');
    expect(classifyFailure(NORTHSTAR[6]!)).toBe('blocked-upstream');
    expect(triageActionFor('blocked-upstream')).toBe('rerun-after-upstream');
  });

  test('⛔ 취소인데 상류 실패가 «아니면» 모른다고 말한다(아는 척하지 않는다)', () => {
    expect(classifyFailure({ taskId: 't', feature: 'f', status: 'cancelled' } as never)).toBe('unclassified');
    expect(classifyFailure({ taskId: 't', feature: 'f', status: 'cancelled', error: { code: 'USER_ABORT', message: 'x' } } as never)).toBe('unclassified');
  });

  test('📏 실물 7조각 — 분류가 3 → 5 로 늘고, 사람이 볼 것은 «0»이었다', () => {
    const t = triageRun(NORTHSTAR);
    expect(t.classifications.length).toBe(5);        // 종전 3
    expect(t.rerunnable.sort()).toEqual(['task:0cb530a5264b', 'task:3628aa60ed63', 'task:fdd78ae151c0'].sort());
    expect(t.reworkable.sort()).toEqual(['task:3084781ff15f', 'task:d0090d1dd4c7'].sort());
    expect(t.needsHuman).toEqual([]);
    expect(t.actionable).toBe(true);
  });

  test('worktree-only 완료 조각은 전달됐지만 병합되지 않았고 실패 조각만 남는다', () => {
    const delivered: SelfDevJobResult = { taskId: 'delivered', feature: 'delivered', status: 'done', stage: 'worktree-completed' };
    const blocked: SelfDevJobResult = { taskId: 'blocked', feature: 'blocked', status: 'failed', stage: 'review-blocked' };
    const gateFailed: SelfDevJobResult = { taskId: 'gate', feature: 'gate', status: 'failed', stage: 'gate-failed' };
    expect(hasLanded(delivered)).toBe(false);
    expect(hasDelivered(delivered)).toBe(true);
    expect(summarizeResults([delivered])).toEqual({ done: 1, failed: 0, cancelled: 0, landed: 0, unlanded: 1 });
    expect(classifyFailure(delivered)).toBeNull();
    expect(classifyResumeDisposition(delivered)).toBe('skip');
    expect(classifyResumeDisposition({ ...delivered, merged: false })).toBe('skip');
    const triage = triageRun([delivered, blocked]);
    expect(triage.classifications.map(({ taskId }) => taskId)).toEqual(['blocked']);
    expect(triage.reworkable).toEqual(['blocked']);
    expect(classifyFailure(gateFailed)).toBe('unconverged');
    expect(classifyResumeDisposition(gateFailed)).toBe('rerun');
    expect(classifyResumeDisposition(blocked)).toBe('rerun');
    expect(hasDelivered({ ...delivered, status: 'failed' })).toBe(false);
    expect(classifyFailure({ ...delivered, status: 'failed' })).toBe('unclassified');
  });

  test('착지한 조각만 있으면 다시 걸 것이 «없다» — 루프가 여기서 선다', () => {
    const t = triageRun([
      { taskId: 'a', feature: 'a', status: 'done', stage: 'merged', merged: true },
      { taskId: 'b', feature: 'b', status: 'done', stage: 'merged', merged: true },
    ] as never[]);
    expect(t.classifications).toEqual([]);
    expect(t.actionable).toBe(false);
  });

  test('done · pr-opened · 미병합 · PR 번호는 awaiting-human / needs-human 이고 번호와 mergeReason 을 싣는다', () => {
    const result = {
      taskId: 'open-pr', feature: 'open-pr', status: 'done', stage: 'pr-opened', merged: false,
      prNumber: 19915, mergeReason: 'decision-signal-red',
    } as never;
    expect(classifyFailure(result)).toBe('awaiting-human');
    expect(triageActionFor('awaiting-human')).toBe('needs-human');
    const [classified] = classifyFailures([result]);
    expect(classified?.action).toBe('needs-human');
    expect(classified?.kind).toBe('awaiting-human');
    expect(classified?.errorMessage).toContain('19915');
    expect(classified?.errorMessage).toContain('decision-signal-red');
    expect(classified?.kind).not.toBe('unconverged');
    expect(classified?.kind).not.toBe('preflight-warning');
    expect(classified?.kind).not.toBe('oversized-goal');
  });
  test('no-auto-flag 도 같은 awaiting-human 이다 — 사유 화이트리스트로 갈라지 않는다', () => {
    const reasons = [
      'no-auto-flag', 'decision-signal-red', 'signal-incomplete', 'required-evidence-uncovered',
      'no-real-review', 'review-must-fix', 'review-diff-truncated', 'review-diff-budget-unknown',
    ];
    for (const mergeReason of reasons) {
      const result = {
        taskId: mergeReason, feature: mergeReason, status: 'done', stage: 'pr-opened', merged: false,
        prUrl: 'https://example.test/pull/7', mergeReason,
      } as never;
      expect(classifyFailure(result)).toBe('awaiting-human');
      expect(classifyFailures([result])[0]?.errorMessage).toContain(mergeReason);
      expect(classifyFailures([result])[0]?.errorMessage).toContain('https://example.test/pull/7');
    }
  });
  test('mergeReason 이 없으면 「사유 모름」을 싣고 값을 짓지 않는다', () => {
    const result = {
      taskId: 'no-reason', feature: 'no-reason', status: 'done', stage: 'pr-opened', merged: false,
      prNumber: 42,
    } as never;
    expect(classifyFailure(result)).toBe('awaiting-human');
    expect(classifyFailures([result])[0]?.errorMessage).toContain('사유 모름');
    expect(classifyFailures([result])[0]?.errorMessage).toContain('42');
  });
  test('PR 포인터가 없는 done · pr-opened 는 지금처럼 unconverged 다', () => {
    expect(classifyFailure({
      taskId: 'bare', feature: 'bare', status: 'done', stage: 'pr-opened', merged: false,
    } as never)).toBe('unconverged');
  });
  test('done · gate-failed · PR 없음은 여전히 rework 다 — awaiting-human 이 수렴 실패를 삼키지 않는다', () => {
    const result = { taskId: 'gate', feature: 'gate', status: 'done', stage: 'gate-failed' } as never;
    expect(classifyFailure(result)).toBe('unconverged');
    expect(triageActionFor(classifyFailure(result)!)).toBe('rework');
    expect(classifyFailures([result])[0]?.action).toBe('rework');
  });
  test('failed · pr-opened 는 여전히 false-failure / no-action 이다', () => {
    const result = {
      taskId: 'failed-pr', feature: 'failed-pr', status: 'failed', stage: 'pr-opened', merged: false, prNumber: 9,
    } as never;
    expect(classifyFailure(result)).toBe('false-failure');
    expect(triageActionFor(classifyFailure(result)!)).toBe('no-action');
  });
  test('failed · merge-conflict · report-deficit 는 needs-human 이고 reworkable 은 비어 있다', () => {
    const result = {
      taskId: 'main-sync',
      feature: 'main-sync',
      status: 'failed',
      stage: 'merge-conflict',
      failureClassification: 'report-deficit',
    } as never;
    expect(classifyFailure(result)).toBe('main-sync-blocked');
    expect(triageActionFor('main-sync-blocked')).toBe('needs-human');
    const t = triageRun([result]);
    expect(t.needsHuman).toEqual(['main-sync']);
    expect(t.reworkable).toEqual([]);
    expect(summarizeFailureKinds([result])).toEqual({
      falseFailure: 0, unconverged: 0, unclassified: 0, transient: 0, blockedUpstream: 0, unconvergedDecomposable: 0, mainSyncBlocked: 1,
    });
  });

  test('같은 결과인데 stage review-blocked 는 지금처럼 reworkable 이다', () => {
    const result = {
      taskId: 'review',
      feature: 'review',
      status: 'failed',
      stage: 'review-blocked',
      failureClassification: 'report-deficit',
    } as never;
    expect(classifyFailure(result)).toBe('unconverged');
    const t = triageRun([result]);
    expect(t.reworkable).toEqual(['review']);
    expect(t.needsHuman).toEqual([]);
  });

  test('모르는 실패는 needs-human 으로 남는다 — 무한 재실행을 만들지 않는다', () => {
    const t = triageRun([
      { taskId: 'x', feature: 'x', status: 'failed', stage: 'error', error: { code: 'BOOM', message: 'TypeError: undefined is not a function' } },
    ] as never[]);
    expect(t.needsHuman).toEqual(['x']);
    expect(t.actionable).toBe(false);
  });

  test('새 종류는 수리 조각을 추가하고 기존 종류의 처방은 보존한다', () => {
    expect(triageActionFor('deliverable-broken')).toBe('add-repair-task');
    expect(triageActionFor('oversized-goal')).toBe('add-repair-task');
    expect(Object.fromEntries([
      'false-failure', 'unconverged', 'transient', 'blocked-upstream', 'unconverged-decomposable', 'unclassified',
    ].map((kind) => [kind, triageActionFor(kind as never)]))).toEqual({
      'false-failure': 'no-action',
      unconverged: 'rework',
      transient: 'rerun',
      'blocked-upstream': 'rerun-after-upstream',
      'unconverged-decomposable': 'decompose-and-retry',
      unclassified: 'needs-human',
    });
  });

  test('골 원인 관측은 기존 수렴 실패 판정이 모두 불발된 뒤에만 골 과대로 더 구체화된다', () => {
    expect(classifyFailure({ taskId: 'goal', feature: 'goal', status: 'done', stage: 'review-blocked', goalCauseObserved: true } as never)).toBe('oversized-goal');
    expect(classifyFailure({ taskId: 'legacy', feature: 'legacy', status: 'done', stage: 'review-blocked' } as never)).toBe('unconverged');
    expect(classifyFailure({
      taskId: 'legacy-decomposable', feature: 'legacy', status: 'done', stage: 'review-blocked', goalCauseObserved: true,
      decomposeProposal: { pieces: [{ id: 'one', feature: 'one', dependsOn: [] }, { id: 'two', feature: 'two', dependsOn: [] }] },
    } as never)).toBe('unconverged-decomposable');
  });

  test('강한 상태 신호는 stale 원장 분류보다 우선한다', () => {
    const cases = [
      [{
        taskId: 'decomposable', feature: 'decomposable', status: 'failed', stage: 'review-blocked',
        error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' }, failureClassification: 'implementation-deficit',
        decomposeProposal: { pieces: [{ id: 'one', feature: 'one', dependsOn: [] }, { id: 'two', feature: 'two', dependsOn: [] }] },
      }, 'unconverged-decomposable', 'decompose-and-retry'],
      [{
        taskId: 'merged', feature: 'merged', status: 'failed', stage: 'merged',
        failureClassification: 'quota-exhausted',
      }, 'false-failure', 'no-action'],
      [{
        taskId: 'pr-opened', feature: 'pr-opened', status: 'failed', stage: 'pr-opened',
        failureClassification: 'provider-error',
      }, 'false-failure', 'no-action'],
    ] as const;

    for (const [result, kind, action] of cases) {
      expect(classifyFailure(result as never)).toBe(kind);
      expect(triageActionFor(kind)).toBe(action);
    }
  });

  test('원장 abandoned 분류 여덟 값은 의미별 트리아지와 다음 행동으로 간다', () => {
    const cases = [
      ['implementation-deficit', 'unconverged', 'rework'],
      ['report-deficit', 'unconverged', 'rework'],
      ['contract-conflict', 'unconverged', 'rework'],
      ['goal-unconvergeable-candidate', 'oversized-goal', 'add-repair-task'],
      ['quota-exhausted', 'transient', 'rerun'],
      ['provider-error', 'transient', 'rerun'],
      ['merge-approved-abandoned', 'false-failure', 'no-action'],
      ['pr-declined', 'false-failure', 'no-action'],
    ] as const;

    for (const [failureClassification, kind, action] of cases) {
      const result = {
        taskId: failureClassification,
        feature: failureClassification,
        status: 'failed',
        stage: 'review-blocked',
        error: { code: 'SELF_IMPL_FAILED', message: 'tsc: 12 errors' },
        failureClassification,
      } as never;
      expect(classifyFailure(result)).toBe(kind);
      expect(triageActionFor(kind)).toBe(action);
    }

    expect(classifyFailure({
      taskId: 'unknown-ledger-classification',
      feature: 'unknown-ledger-classification',
      status: 'failed',
      stage: 'error',
      error: { code: 'UNKNOWN', message: 'unknown failure' },
    } as never)).toBe('unclassified');
  });

  test('run-deadline-exceeded 는 transient 가 아니다 — 브랜치/PR 이면 수확, 없으면 재분해', () => {
    const base = {
      status: 'failed',
      stage: 'aborted',
      error: { code: 'pod-deadline-exceeded', message: 'Job si 이 수명 상한 10800초에 닿았다' },
      failureClassification: 'run-deadline-exceeded',
    } as const;
    expect(classifyFailure({ ...base, taskId: 'bare', feature: 'bare' } as never)).toBe('unconverged-decomposable');
    expect(triageActionFor('unconverged-decomposable')).toBe('decompose-and-retry');
    for (const extra of [{ branch: 'si/deadline' }, { prUrl: 'https://github.com/o/r/pull/3' }, { prNumber: 3 }]) {
      expect(classifyFailure({ ...base, taskId: 'kept', feature: 'kept', ...extra } as never)).toBe('false-failure');
    }
    expect(triageActionFor('false-failure')).toBe('no-action');
    expect(classifyFailure({ ...base, taskId: 'quota', feature: 'quota', failureClassification: 'quota-exhausted' } as never)).toBe('transient');
  });

  test('자식 disposition의 failureClassification은 buildResults를 거쳐 트리아지 입력으로 전달된다', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-ledger-classification-propagation-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    const cases = [
      ['implementation-deficit', 'unconverged', 'rework'],
      ['report-deficit', 'unconverged', 'rework'],
      ['contract-conflict', 'unconverged', 'rework'],
      ['goal-unconvergeable-candidate', 'oversized-goal', 'add-repair-task'],
      ['quota-exhausted', 'transient', 'rerun'],
      ['provider-error', 'transient', 'rerun'],
      ['merge-approved-abandoned', 'false-failure', 'no-action'],
      ['pr-declined', 'false-failure', 'no-action'],
    ] as const;
    try {
      const results = await orchestrateSelfDev({
        goals: cases.map(([failureClassification]) => ({ feature: failureClassification })),
        spawn: (goal) => ({
          address: `self-impl:${goal.feature}`,
          done: Promise.resolve({
            exitCode: 1,
            output: '',
            disposition: { stage: 'review-blocked', failureClassification: withoutShardIdentity(goal.feature) as never },
          }),
        }),
      });
      expect(results.map((result) => result.failureClassification)).toEqual(cases.map(([failureClassification]) => failureClassification));
      const reduced = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect(((reduced.data as { failures: Array<{ kind: string; action: string }> }).failures)
        .slice(0, 6)
        .map(({ kind, action }) => [kind, action]))
        .toEqual(cases.slice(0, 6).map(([, kind, action]) => [kind, action]));
    } finally {
      off();
    }
  });

  test('failureClassification 의 골 수렴 불가 후보는 실제 오케스트레이션 결과에서 골 과대로 분류한다', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-ledger-goal-candidate-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    try {
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'oversized' }],
        spawn: () => ({
          address: 'self-impl:test',
          done: Promise.resolve({
            exitCode: 1,
            output: '',
            disposition: {
              stage: 'review-blocked',
              runId: 'run-observed',
              mergeReason: 'review-diff-truncated',
              stopReason: 'rework-budget',
              completionDisposition: 'completed-without-changes',
              failureClassification: 'goal-unconvergeable-candidate',
            },
          }),
        }),
      });
      expect(results[0]).toMatchObject({
        goalCauseObserved: true,
        mergeReason: 'review-diff-truncated',
        stopReason: 'rework-budget',
        completionDisposition: 'completed-without-changes',
        failureClassification: 'goal-unconvergeable-candidate',
      });
      const reduced = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect((reduced.data as { failures: unknown[] }).failures).toEqual([expect.objectContaining({
        kind: 'oversized-goal', action: 'add-repair-task',
      })]);
    } finally {
      off();
    }
  });

  test('분류가 없거나 비매칭이면 트리아지 행은 goalCauseObserved 칸을 생략한다', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-unknown-goal-cause-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    try {
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'unknown-disposition' }],
        spawn: () => ({
          address: 'self-impl:test',
          done: Promise.resolve({
            exitCode: 1,
            output: '',
            disposition: {
              stage: 'review-blocked',
              runId: 'run-missing',
              mergeReason: 'review-diff-truncated',
              stopReason: 'rework-budget',
              completionDisposition: 'completed-without-changes',
              failureClassification: 'implementation-deficit',
            },
          }),
        }),
      });
      expect(results[0]).not.toHaveProperty('goalCauseObserved');
      expect(results[0]).toMatchObject({
        mergeReason: 'review-diff-truncated',
        stopReason: 'rework-budget',
        completionDisposition: 'completed-without-changes',
        failureClassification: 'implementation-deficit',
      });
      const reduced = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect((reduced.data as { failures: unknown[] }).failures).toEqual([expect.objectContaining({
        kind: 'unconverged', action: 'rework',
      })]);
    } finally {
      off();
    }
  });

  test('자식 완료 처분만으로는 골 원인 신호를 만들지 않는다 — failureClassification 만 본다', () => {
    expect(goalCauseObservedFromFailureClassification(undefined)).toBeUndefined();
    expect(goalCauseObservedFromFailureClassification('implementation-deficit')).toBeUndefined();
    expect(goalCauseObservedFromFailureClassification('goal-unconvergeable-candidate')).toBe(true);
    // @ts-expect-error completionDisposition 어휘는 failureClassification 칸에 살지 않는다
    expect(goalCauseObservedFromFailureClassification('completed-without-changes')).toBeUndefined();
    const asString: string = 'goal-unconvergeable-candidate';
    // @ts-expect-error 인자 타입은 string 이 아니다
    expect(goalCauseObservedFromFailureClassification(asString)).toBe(true);
  });

  test('생산 가능한 완료 처분은 실제 오케스트레이션 결과에서 골 원인 신호를 만들지 않는다', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-goal-cause-capture',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    try {
      const results = await orchestrateSelfDev({
        goals: [{ feature: 'oversized' }],
        spawn: () => ({
          address: 'self-impl:test',
          done: Promise.resolve({
            exitCode: 1,
            output: 'log echo: {"stage":"review-blocked","completionDisposition":"completed-without-changes"}',
            disposition: { stage: 'review-blocked', completionDisposition: 'completed-without-changes' },
          }),
        }),
      });
      expect(results[0]).not.toHaveProperty('goalCauseObserved');
      expect(results[0]!.completionDisposition).toBe('completed-without-changes');
      const reduced = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect((reduced.data as { failures: unknown[] }).failures).toEqual([expect.objectContaining({
        kind: 'unconverged', action: 'rework',
      })]);
    } finally {
      off();
    }
  });

  test('로그·에코 JSON의 골 원인 플래그는 정식 완료 disposition이 아니므로 무시한다', async () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'orchestrate-goal-cause-output-ignored',
      emit: (record) => {
        if (record.category === 'self-dev.orchestrate' && record.event === 'orchestrate.reduce') records.push(record);
      },
    });
    try {
      await orchestrateSelfDev({
        goals: [{ feature: 'output-echo' }],
        spawn: () => ({
          address: 'self-impl:test',
          done: Promise.resolve({
            exitCode: 1,
            output: 'log: {"stage":"review-blocked","goalCauseObserved":true}',
            disposition: { stage: 'review-blocked' },
          }),
        }),
      });
      const reduced = records.find((record) => record.event === 'orchestrate.reduce')!;
      expect((reduced.data as { failures: unknown[] }).failures).toEqual([expect.objectContaining({
        kind: 'unconverged', action: 'rework',
      })]);
    } finally {
      off();
    }
  });

  test('확정 화면 문제는 메시지·수치·쿼리·run ID와 무관한 안정 지문으로 산출물 결함이 된다', () => {
    const first = failureFromDeployFindings('task:web', '/f/123?runId=abc12345-1234-1234-1234-123456789abc&at=12:00', [{ kind: 'javascript-error', message: 'JavaScript 오류: run=1 at 12:00', certainty: 'confirmed' }]);
    const second = failureFromDeployFindings('task:web', '/f/999?runId=def12345-1234-1234-1234-123456789abc&at=13:00', [{ kind: 'javascript-error', message: '다른 문면 999 at 13:00 run=2', certainty: 'confirmed' }]);
    expect(first).toEqual([{ taskId: 'task:web', stage: null, kind: 'deliverable-broken', action: 'add-repair-task', errorCode: 'web|javascript-error|/f/:n' }]);
    expect(second).toEqual(first);
  });

  test('⛔⭐ 로컬 포트가 «다르면» 지문도 달라야 한다 — 지문은 「같은 것을 묶는」 장치다', () => {
    // 📏 2026-08-20 실측 결함: 숫자 마스킹을 URL «전체»에 걸어 아래 셋이 «같은 지문»이었다.
    //   ⇒ 로컬에 뜬 서로 다른 앱이 한 지문으로 묶였고, 수리 조각은 «지문당 1개»가 상한이라
    //     둘째·셋째 앱의 수리가 «조용히» 버려졌다.
    const fingerprint = (target: string): string =>
      failureFromDeployFindings('task:web', target, [{ kind: 'empty-body', message: 'x', certainty: 'confirmed' }])[0]!.errorCode;

    const ports = ['http://127.0.0.1:31415/', 'http://127.0.0.1:8080/', 'http://127.0.0.1:5173/'];
    const seen = ports.map(fingerprint);
    expect(new Set(seen).size).toBe(ports.length);          // ⛔ 셋이 «서로 달라야» 한다
    expect(seen[0]).toBe('web|empty-body|http://127.0.0.1:31415/');

    // ⭐ 그리고 «경로»의 마스킹은 그대로다 — 매번 달라지는 값이 새 지문을 만들면 안 된다.
    expect(fingerprint('http://127.0.0.1:31415/run/9f2c8a1b-1111-2222-3333-444455556666/'))
      .toBe('web|empty-body|http://127.0.0.1:31415/run/:id/');
    expect(fingerprint('http://127.0.0.1:31415/f/123'))
      .toBe(fingerprint('http://127.0.0.1:31415/f/999'));
  });

  test('의심·빈 목록은 산출물 결함을 만들지 않고 복수 확정 문제는 모두 보존한다', () => {
    expect(failureFromDeployFindings('task:web', '/f/a', [{ kind: 'empty-body', message: '본문 0자', certainty: 'suspected' }])).toEqual([]);
    expect(failureFromDeployFindings('task:web', '/f/a', undefined)).toEqual([]);
    expect(triageRun([], new Map([['task:web', {
      target: '/f/a',
      findings: [
        { kind: 'empty-title', message: 'title=0', certainty: 'confirmed' },
        { kind: 'unloaded-image', message: 'image=2', certainty: 'confirmed' },
      ],
    }]])).classifications.map(({ errorCode }) => errorCode)).toEqual([
      'web|empty-title|/f/a',
      'web|unloaded-image|/f/a',
    ]);
  });
});


// ⛔⭐⭐ 리뷰(#10392) must-fix 둘을 «값으로» 문다 — 사람이 인수해 수리한 자리(2026-08-19).
describe('triageRun — 「안 쟀다」 보존 ⊕ 「추가」가 자동 조정에 든다', () => {
  const failed = (taskId: string): SelfDevJobResult => ({
    taskId, feature: 'f', status: 'failed', stage: 'aborted',
    error: { message: 'ETIMEDOUT while calling provider' },
  } as SelfDevJobResult);

  test('산출물 검증을 «안 주면» deliverableUnmeasured 가 참이다 — 「결함 없음」과 다른 값', () => {
    const t = triageRun([failed('a')]);
    expect(t.deliverableUnmeasured).toBe(true);
    // ⛔ 그리고 그때 「산출물 결함 0」을 «주장하지 않는다»
    expect(t.classifications.some((c) => c.kind === 'deliverable-broken')).toBe(false);
  });

  test('빈 Map 을 «주면» 잰 것이다 — deliverableUnmeasured 가 거짓', () => {
    const t = triageRun([failed('a')], new Map());
    expect(t.deliverableUnmeasured).toBe(false);
  });

  test('add-repair-task 는 repairable 로 나오고 actionable 을 «켠다»', () => {
    const t = triageRun([], new Map([['a', {
      target: 'https://x.test/f/demo',
      findings: [{ kind: 'unloaded-image' as const, message: '그림 1개', certainty: 'confirmed' as const }],
    }]]));
    expect(t.repairable).toEqual(['a']);
    expect(t.actionable).toBe(true);
    // ⛔ 「추가」는 「다시」·「치환」과 «다른 칸»이어야 한다
    expect(t.reworkable).toEqual([]);
    expect(t.decomposable).toEqual([]);
  });
});

// BACKLOG B6 — 결정적 요청 거부는 재실행하지 않는다.
import { isDeterministicRequestRejection } from '../self-implement/orchestrator.js';
import { parseSelfImplementJson } from '../task-orchestrator/surfaces/self-implement.js';
describe('provider-rejected (BACKLOG B6)', () => {
  test('deterministic 4xx request errors are recognised; rate/timeouts/5xx are not', () => {
    expect(isDeterministicRequestRejection('❌ Anthropic API 400: {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}')).toBe(true);
    expect(isDeterministicRequestRejection("Codex API 400: The 'gpt-4o-mini' model is not supported when using Codex with a ChatGPT account.")).toBe(true);
    expect(isDeterministicRequestRejection('API 429 rate_limit_error')).toBe(false);
    expect(isDeterministicRequestRejection('HTTP 503 overloaded')).toBe(false);
    expect(isDeterministicRequestRejection('')).toBe(false);
  });
  test('an aborted shard with a request rejection triages to needs-human, not rerun, even when the ledger says provider-error', () => {
    const r = { taskId: 't', feature: 'f', status: 'done', stage: 'aborted', failureClassification: 'provider-error', providerErrors: { count: 1, provider: 'anthropic', category: 'request' } } as SelfDevJobResult;
    expect(classifyFailure(r)).toBe('provider-rejected');
    expect(triageActionFor('provider-rejected')).toBe('needs-human');
    const other = { ...r, providerErrors: { count: 1, provider: 'anthropic', category: 'other' } } as SelfDevJobResult;
    expect(classifyFailure(other)).toBe('transient');   // 대조군 — 종전 동작
  });
  test('the child JSON parser keeps category request (not silently dropped)', () => {
    const parsed = parseSelfImplementJson(JSON.stringify({ ok: false, stage: 'aborted', providerErrors: { count: 1, provider: 'anthropic', category: 'request' } }));
    expect(parsed?.providerErrors?.category).toBe('request');
  });
});
