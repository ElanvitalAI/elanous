/**
 * TOX Integration E2E tests.
 *
 * Origin: ROADMAP-task-orchestrator.md §7 E5 Cortex evolution.
 *
 * These exercise wireToxForDashboard + real graph + real dispatcher +
 * real generator + real feedback-loop + real RetryPolicy through a
 * stubbed LLM + stubbed surface callable. Each case is a small
 * scenario rather than one long path, so a regression points to a
 * specific seam.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { wireToxForDashboard, type ToxBootHandle } from '../src/task-orchestrator/boot.ts';
import { resetToxRuntimeDepsForTest } from '../src/task-orchestrator/runtime-deps.ts';
import { dispatchTaskCreate } from '../src/task-orchestrator/runtimes/create.ts';
import { dispatchTaskDecompose, dispatchTaskDecomposeApply } from '../src/task-orchestrator/runtimes/decompose.ts';
import type { DecomposeCallable } from '../src/task-orchestrator/generator.ts';
import type { TaskSurface, TaskExecution, Task } from '../src/task-orchestrator/types.ts';
import type { TaskEvent } from '../src/task-orchestrator/events.ts';
import type {
  AndonSignalLike,
  AndonSubscriberKind,
} from '../src/task-orchestrator/andon-bridge.ts';

// ───────────────── Harness helpers ──────────────────────────────

const surfaceLlm: TaskSurface = { kind: 'llm-direct', prompt: 'p' };

function makeSimpleProposal(titles: string[]) {
  return {
    rationale: 'split',
    tasks: titles.map((title, index) => ({
      index,
      title,
      surface: { kind: 'llm-direct' as const, prompt: `t${index}` },
      // first is root, others depend on previous — serial chain
      dependsOn: index === 0 ? [] : [index - 1],
    })),
  };
}

function stubDecomposeCallable(proposal: unknown): DecomposeCallable {
  return async () => ({ text: JSON.stringify(proposal), modelId: 'stub', costUsd: 0.01 });
}

async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface HarnessOpts {
  decompose?: DecomposeCallable;
  terminationCheck?: (slug: string) => Promise<{ shouldTerminate: boolean; reason?: string }>;
  budgetCheck?: (slug: string, est?: number) => Promise<{ canAfford: boolean; tripped: readonly string[] }>;
  hasPendingCritical?: () => boolean;
  regenerateObjective?: (slug: string) => string | null;
  andon?: {
    subscribe: (fn: (s: AndonSignalLike, k: AndonSubscriberKind) => void) => () => void;
    hasPendingCritical?: () => boolean;
  };
  /** Override the llm-direct stub so individual tests can control
   *  output / cost / failure per task. Defaults to always-complete. */
  llmCallable?: Parameters<typeof wireToxForDashboard>[0] extends infer T
    ? T extends { surfaces?: infer S }
      ? S extends { llmDirect?: infer L }
        ? L
        : never
      : never
    : never;
}

function bootHarness(opts: HarnessOpts = {}): ToxBootHandle {
  const defaultLlm = async () => ({ text: 'ok', costUsd: 0.001 });
  return wireToxForDashboard({
    surfaces: { llmDirect: opts.llmCallable ?? defaultLlm },
    decompose: opts.decompose,
    terminationCheck: opts.terminationCheck,
    // The TOX loop's default gate reads live provider usage (~2s, and `stop` with no LLM chain) — tests admit by default.
    budgetCheck: opts.budgetCheck ?? (async () => ({ canAfford: true, tripped: [] })),
    hasPendingCritical: opts.hasPendingCritical,
    regenerateObjective: opts.regenerateObjective,
    andon: opts.andon,
  });
}

afterEach(() => {
  resetToxRuntimeDepsForTest();
});

// ───────────────── E1: single root task → done ──────────────────

describe('TOX integration — single path', () => {
  test('E1: root task → dispatch → done via monitor', async () => {
    const tox = bootHarness();
    const created = await dispatchTaskCreate({ title: 'solo', surface: surfaceLlm });
    expect(created.taskId).toBeTruthy();

    tox.dispatcher.tick();
    await settle();

    expect(tox.graph.getTask(created.taskId!)!.status).toBe('done');
    tox.dispose();
  });
});

// ───────────────── E2: 2-task dep chain ─────────────────────────

describe('TOX integration — dep chain', () => {
  test('E2: A → B chain runs sequentially', async () => {
    const tox = bootHarness();
    const a = await dispatchTaskCreate({ title: 'A', surface: surfaceLlm });
    const b = await dispatchTaskCreate({
      title: 'B',
      surface: surfaceLlm,
      dependsOn: [a.taskId!],
    });

    // B should be blocked (via promoteReady inside TaskCreate).
    expect(tox.graph.getTask(b.taskId!)!.status).toBe('blocked');

    // Tick dispatches A; its completion unblocks B.
    tox.dispatcher.tick();
    await settle();
    // Feedback loop's bus subscription should have promoted B and
    // dispatched it.
    await settle();
    expect(tox.graph.getTask(a.taskId!)!.status).toBe('done');
    expect(tox.graph.getTask(b.taskId!)!.status).toBe('done');
    tox.dispose();
  });
});

// ───────────────── E3: decompose + apply + dispatch → done ─────

describe('TOX integration — decompose arc', () => {
  test('E3: TaskDecompose → Apply → 2 tasks run → both done', async () => {
    const tox = bootHarness({
      decompose: stubDecomposeCallable(makeSimpleProposal(['read', 'summarize'])),
    });
    const decomposed = await dispatchTaskDecompose({
      objective: 'Read file and summarize',
      goalSlug: 'g1',
    });
    expect(decomposed.applyToken).toBeTruthy();
    expect(decomposed.requiresApproval).toBe(false);

    const applied = await dispatchTaskDecomposeApply({
      applyToken: decomposed.applyToken!,
    });
    expect(applied.taskIds).toHaveLength(2);

    tox.dispatcher.tick();
    await settle();
    await settle(); // second tick via feedback-loop

    for (const id of applied.taskIds!) {
      expect(tox.graph.getTask(id)!.status).toBe('done');
    }
    tox.dispose();
  });
});

// ───────────────── E4: regenerate path ─────────────────────────

describe('TOX integration — regenerate', () => {
  test('E4: feedback-loop fires regenerate when idle+incomplete', async () => {
    // Proposal for the regeneration path returns a single new task.
    const tox = bootHarness({
      decompose: stubDecomposeCallable({
        rationale: 'follow',
        tasks: [
          { index: 0, title: 'next', surface: { kind: 'llm-direct', prompt: 'f' } },
        ],
      }),
      regenerateObjective: () => 'continue',
    });

    // Seed: one goal-bound task, already done (so goal idle), plus one
    // blocked task with a dangling dep (keeps goal "incomplete").
    const seed = await dispatchTaskCreate({
      title: 'seed',
      surface: surfaceLlm,
      goalSlug: 'g1',
    });
    // Move seed to done via dispatch.
    tox.dispatcher.tick();
    await settle();
    expect(tox.graph.getTask(seed.taskId!)!.status).toBe('done');

    // Add a blocked task that keeps the goal live.
    const blocked = await dispatchTaskCreate({
      title: 'blocked',
      surface: surfaceLlm,
      goalSlug: 'g1',
      dependsOn: ['task:never'],
    });
    // blocked stays backlog since dep unknown.

    const rg = await tox.loop.maybeRegenerate('g1');
    expect(rg.kind).toBe('applied');
    if (rg.kind === 'applied') {
      expect(rg.taskIds.length).toBe(1);
      expect(tox.graph.hasTask(rg.taskIds[0]!)).toBe(true);
    }

    tox.dispose();
  });
});

// ───────────────── E5: budget tripped ─────────────────────────

describe('TOX integration — budget gate', () => {
  test('E5: budget tripped pauses loop', async () => {
    let tripped = false;
    const tox = bootHarness({
      budgetCheck: async () => ({
        canAfford: !tripped,
        tripped: tripped ? ['usd'] : [],
      }),
    });
    const t = await dispatchTaskCreate({
      title: 'paid',
      surface: surfaceLlm,
      goalSlug: 'gx',
    });
    tripped = true; // trip the budget before completion

    tox.dispatcher.tick();
    await settle();

    // Completed but the feedback loop observed the budget trip and
    // paused.
    expect(tox.graph.getTask(t.taskId!)!.status).toBe('done');
    expect(tox.loop.isPaused()).toBe(true);
    expect(tox.loop.stats().pausedReason).toBe('budget');
    tox.dispose();
  });
});

// ───────────────── E6: Andon emit pauses, resolve resumes ─────

describe('TOX integration — andon bridge', () => {
  test('E6: CRITICAL emit pauses, resolve (no pending) resumes', async () => {
    let andonHandler: ((s: AndonSignalLike, k: AndonSubscriberKind) => void) | null =
      null;
    let pending = false;
    const tox = bootHarness({
      andon: {
        subscribe: (fn) => {
          andonHandler = fn;
          return () => {
            andonHandler = null;
          };
        },
        hasPendingCritical: () => pending,
      },
    });

    expect(andonHandler).not.toBeNull();
    pending = true;
    andonHandler!({ severity: 'CRITICAL' }, 'emit');
    expect(tox.loop.isPaused()).toBe(true);

    pending = false;
    andonHandler!({ severity: 'CRITICAL' }, 'resolve');
    expect(tox.loop.isPaused()).toBe(false);

    tox.dispose();
  });
});

// ───────────────── E7/E8: acceptance pass + fail ─────────────

describe('TOX integration — acceptance', () => {
  test('E7: acceptance pass → done with note', async () => {
    const tox = bootHarness({
      llmCallable: async () => ({ text: 'all good output', costUsd: 0.001 }),
    });
    const t = await dispatchTaskCreate({
      title: 'acc-pass',
      surface: surfaceLlm,
    });
    // Manually attach acceptance to the task (TaskCreate doesn't expose
    // the field yet; set it directly — integration test only).
    const obj = tox.graph.getTask(t.taskId!)! as Task & {
      acceptance?: { criteria: string[]; checks: unknown[] };
    };
    obj.acceptance = { criteria: [], checks: [{ kind: 'output-matches', pattern: 'good' }] };

    tox.dispatcher.tick();
    await settle();

    const final = tox.graph.getTask(t.taskId!)!;
    expect(final.status).toBe('done');
    expect(final.notes.some((n) => n.includes('1/1 passed'))).toBe(true);
    tox.dispose();
  });

  test('E8: acceptance fail → task-failed event (retry observable)', async () => {
    const tox = bootHarness({
      llmCallable: async () => ({ text: 'unrelated output', costUsd: 0.001 }),
    });
    const events: TaskEvent[] = [];
    tox.bus.subscribe((e) => events.push(e));

    const t = await dispatchTaskCreate({ title: 'acc-fail', surface: surfaceLlm });
    const obj = tox.graph.getTask(t.taskId!)! as Task & {
      acceptance?: { criteria: string[]; checks: unknown[] };
    };
    obj.acceptance = { criteria: [], checks: [{ kind: 'output-matches', pattern: 'MISSING' }] };

    tox.dispatcher.tick();
    await settle();

    const failed = events.find(
      (e) => e.kind === 'task-failed' && e.taskId === t.taskId,
    );
    expect(failed).toBeDefined();
    tox.dispose();
  });
});

// ───────────────── E9: retry timing ────────────────────────────

describe('TOX integration — retry event', () => {
  test('E9: failing adapter triggers task-retry-scheduled then ready', async () => {
    // Surface adapter that fails for the first call, passes on retry.
    let call = 0;
    const tox = bootHarness({
      llmCallable: async () => {
        call++;
        if (call === 1) throw new Error('transient');
        return { text: 'ok', costUsd: 0 };
      },
    });
    const retryEvents: TaskEvent[] = [];
    tox.bus.subscribe((e) => {
      if (e.kind === 'task-retry-scheduled') retryEvents.push(e);
    });

    const t = await dispatchTaskCreate({ title: 'flaky', surface: surfaceLlm });
    tox.dispatcher.tick();
    await settle();

    // RetryPolicy observes task-failed and schedules retry.
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    if (retryEvents[0]!.kind === 'task-retry-scheduled') {
      expect(retryEvents[0]!.attempt).toBe(1);
      expect(retryEvents[0]!.delayMs).toBeGreaterThan(0);
    }

    tox.dispose();
  });
});

// ───────────────── E10: termination short-circuits dispatch ──

describe('TOX integration — termination', () => {
  test('E10: shouldTerminate=true prevents further dispatch', async () => {
    let dispatched = 0;
    const tox = bootHarness({
      terminationCheck: async () => ({ shouldTerminate: true, reason: 'goal met' }),
    });

    // Observe tick via wrapping tox.dispatcher manually isn't trivial;
    // we check via outcome of onTaskCompleted.
    const t = await dispatchTaskCreate({
      title: 'term',
      surface: surfaceLlm,
      goalSlug: 'g-term',
    });
    tox.dispatcher.tick();
    await settle();

    // After first completion, feedback-loop hit termination → returns
    // terminate outcome. We can verify by trying a manual call.
    const outcome = await tox.loop.onTaskCompleted(t.taskId!);
    expect(outcome.kind).toBe('terminate');
    if (outcome.kind === 'terminate') {
      expect(outcome.reason).toContain('goal');
    }
    tox.dispose();
  });
});

// ───────────────── E11: parallel dispatch same surface ──────

describe('TOX integration — parallel same-surface', () => {
  test('E11: two llm-direct tasks dispatch under cap (cap=2)', async () => {
    const tox = bootHarness();
    await dispatchTaskCreate({ title: 'p1', surface: surfaceLlm });
    await dispatchTaskCreate({ title: 'p2', surface: surfaceLlm });
    const result = tox.dispatcher.tick();
    expect(result.dispatched.length).toBe(2);
    await settle();
    tox.dispose();
  });
});

// ───────────────── E12: dispose ignores further events ──────

describe('TOX integration — dispose lifecycle', () => {
  test('E12: dispose detaches loop + retry + andon', async () => {
    let andonFn: ((s: AndonSignalLike, k: AndonSubscriberKind) => void) | null = null;
    const tox = bootHarness({
      andon: {
        subscribe: (fn) => {
          andonFn = fn;
          return () => {
            andonFn = null;
          };
        },
      },
    });
    expect(andonFn).not.toBeNull();
    tox.dispose();
    expect(andonFn).toBeNull();
    // feedback-loop should not be counting further completions.
    tox.bus.emit({
      kind: 'task-completed',
      taskId: 'task:none',
      executionId: 'exec:x',
    });
    await settle();
    expect(tox.loop.stats().completedTotal).toBe(0);
  });
});
