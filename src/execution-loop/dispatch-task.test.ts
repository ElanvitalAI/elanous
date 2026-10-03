import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, cardEventsPath } from '../task-cards/card-store.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { runDevPipeline, type DevPipelineSpec } from '../self-dev/dev-pipeline.js';
import { cardGoalId } from './dispatch-task.js';
import type { DecisionEvent } from '../live/detail-switch.js';
import type { SelfImplementResult, SelfImplementSeams } from '../self-implement/orchestrator.js';
import { dispatchTask, type DispatchTaskDeps, type DispatchTaskInput } from './dispatch-task.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const spec: DevPipelineSpec = { input: { text: 'Implement feature' }, humanReadableOutput: false };
const input: DispatchTaskInput = { goalId: 'goal-one', title: 'Implement feature', goalText: 'Implement feature', targetPaths: ['src/a.ts'], spec };

function fixture(root: string): DispatchTaskDeps {
  return {
    createStore: () => new CardStore(root),
    budgetGate: async () => ({ decision: { action: 'stop', reasons: ['no quota'] }, explanation: 'no quota' }),
    placementGate: () => ({ decision: { substrate: 'unknown', pool: null, source: 'unknown', poolReachability: 'unknown', localReasons: [], unknownInputs: [] }, explanation: 'unknown' }),
    relationGate: async () => ({ decision: { action: 'record', overlappingCards: [], preflightOverlaps: 'unknown', dependsOn: 'unknown', similarCards: 'unknown', sameGoalActiveRuns: [] }, explanation: 'none' }),
    memoryGate: async () => ({ decision: { action: 'record', context: 'remember', fragmentIds: [] }, explanation: 'remember' }),
    emitDecision: () => true,
    log: () => {},
  };
}

const withStore = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), 'execution-dispatch-'));
  const dispatchRecorded = process.env.ELANOUS_DISPATCH_RECORDED;
  delete process.env.ELANOUS_DISPATCH_RECORDED;
  try { await run(root); } finally {
    if (dispatchRecorded === undefined) delete process.env.ELANOUS_DISPATCH_RECORDED;
    else process.env.ELANOUS_DISPATCH_RECORDED = dispatchRecorded;
    rmSync(root, { recursive: true, force: true });
  }
};

describe('dispatchTask observation', () => {
  test('four gate decisions persist across three sections, reuse an open card and keep stop observational', async () => withStore(async (root) => {
    const deps = fixture(root);
    const observed: string[] = [];
    const emitted: string[] = [];
    deps.emitDecision = (event) => { emitted.push(event.what); return true; };
    deps.log = (name, data) => { observed.push(`${name}:${data.verdict}`); expect(data.cardId).toBeTruthy(); expect(data.ms).toBeGreaterThanOrEqual(0); };
    const first = await dispatchTask({ ...input, runKey: 'run-first' }, deps);
    const second = await dispatchTask({ ...input, runKey: 'run-second' }, deps);
    expect(first.mode).toBe('observe');
    expect(first.decisions.budget.decision).toMatchObject({ action: 'stop' });
    expect(second.cardId).toBe(first.cardId);
    for (const offset of [0, 4]) {
      expect(observed.slice(offset, offset + 4).sort()).toEqual(['budget:stop', 'placement:unknown', 'relation:record', 'memory:record'].sort());
      expect(emitted.slice(offset, offset + 4).sort()).toEqual(['budget', 'placement', 'relation', 'memory'].map((name) => `execution-loop ${name} gate`).sort());
    }
    const store = new CardStore(root);
    try {
      const card = store.getCard(first.cardId)!;
      expect(card.sections.map((section) => section.key)).toEqual([
        'gates:run-first', 'relations:run-first', 'memory:run-first',
        'gates:run-second', 'relations:run-second', 'memory:run-second',
      ]);
      expect(JSON.parse(card.sections[0]!.content)).toEqual({ budget: first.decisions.budget, placement: first.decisions.placement });
      expect(JSON.parse(card.sections[1]!.content)).toEqual(first.decisions.relation);
      expect(JSON.parse(card.sections[2]!.content)).toEqual(first.decisions.memory);
    } finally { store.close(); }
  }));

  test('memory recall marker never reaches emitDecision but remains in the original card section', async () => withStore(async (root) => {
    const marker = 'MARKER-7f3a';
    const deps = fixture(root);
    const emitted: DecisionEvent[] = [];
    deps.memoryGate = async () => ({
      decision: { action: 'record', context: `recalled conversation ${marker}`, fragmentIds: ['fragment-1'] },
      explanation: `memory=${marker}`,
    });
    deps.emitDecision = (event) => { emitted.push(event); return true; };
    const result = await dispatchTask({ ...input, runKey: 'memory-marker' }, deps);
    expect(emitted).toHaveLength(4);
    expect(emitted.map((event) => event.what).sort()).toEqual(
      ['budget', 'placement', 'relation', 'memory'].map((gate) => `execution-loop ${gate} gate`).sort(),
    );
    for (const event of emitted) {
      expect(JSON.stringify(event)).not.toContain(marker);
      expect(event.reason.length).toBeLessThanOrEqual(250);
    }
    expect(emitted.find((event) => event.what === 'execution-loop memory gate')?.reason).toBe('context=recalled · fragments=1');
    const store = new CardStore(root);
    try {
      const sections = store.getCard(result.cardId)!.sections;
      expect(sections.map((section) => section.key)).toEqual(['gates:memory-marker', 'relations:memory-marker', 'memory:memory-marker']);
      expect(JSON.parse(sections[0]!.content)).toEqual({ budget: result.decisions.budget, placement: result.decisions.placement });
      expect(JSON.parse(sections[1]!.content)).toEqual(result.decisions.relation);
      expect(JSON.parse(sections[2]!.content)).toEqual(result.decisions.memory);
      expect(sections[2]!.content).toContain(marker);
    } finally { store.close(); }
  }));

  test('unavailable memory explanation with recalled text first stays out of every live event but remains on the card', async () => withStore(async (root) => {
    const marker = 'MARKER-7f3a';
    const deps = fixture(root);
    const emitted: DecisionEvent[] = [];
    deps.memoryGate = async () => ({ decision: '측정 불가', explanation: `${marker} recalled conversation` });
    deps.emitDecision = (event) => { emitted.push(event); return true; };
    const result = await dispatchTask({ ...input, runKey: 'memory-unavailable' }, deps);
    expect(emitted).toHaveLength(4);
    for (const event of emitted) {
      expect(JSON.stringify(event)).not.toContain(marker);
      expect(event.reason.length).toBeLessThanOrEqual(250);
    }
    expect(emitted.find((event) => event.what === 'execution-loop memory gate')?.reason).toBe('unavailable');
    const store = new CardStore(root);
    try {
      const sections = store.getCard(result.cardId)!.sections;
      expect(sections.map((section) => section.key)).toEqual(['gates:memory-unavailable', 'relations:memory-unavailable', 'memory:memory-unavailable']);
      expect(JSON.parse(sections[2]!.content)).toEqual(result.decisions.memory);
      expect(sections[2]!.content).toContain(marker);
    } finally { store.close(); }
  }));

  test('thrown memory gate error with recalled text stays out of live events but remains on the card', async () => withStore(async (root) => {
    const marker = 'MARKER-7f3a';
    const deps = fixture(root);
    const emitted: DecisionEvent[] = [];
    deps.memoryGate = async () => { throw new Error(`${marker} recalled conversation`); };
    deps.emitDecision = (event) => { emitted.push(event); return true; };
    const result = await dispatchTask({ ...input, runKey: 'memory-error' }, deps);
    expect(emitted).toHaveLength(4);
    for (const event of emitted) expect(JSON.stringify(event)).not.toContain(marker);
    expect(emitted.find((event) => event.what === 'execution-loop memory gate')?.reason).toBe('unavailable');
    const store = new CardStore(root);
    try {
      const sections = store.getCard(result.cardId)!.sections;
      expect(sections.map((section) => section.key)).toEqual(['gates:memory-error', 'relations:memory-error', 'memory:memory-error']);
      expect(JSON.parse(sections[2]!.content)).toEqual(result.decisions.memory);
      expect(sections[2]!.content).toContain(marker);
    } finally { store.close(); }
  }));

  test('all four gates start before the first pending gate resolves', async () => withStore(async (root) => {
    const deps = fixture(root);
    const started: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    deps.budgetGate = async () => {
      started.push('budget');
      await pending;
      return { decision: { action: 'stop', reasons: [] }, explanation: 'stop' };
    };
    deps.placementGate = () => {
      started.push('placement');
      return { decision: { substrate: 'unknown', pool: null, source: 'unknown', poolReachability: 'unknown', localReasons: [], unknownInputs: [] }, explanation: 'unknown' };
    };
    deps.relationGate = async () => {
      started.push('relation');
      return { decision: { action: 'record', overlappingCards: [], preflightOverlaps: 'unknown', dependsOn: 'unknown', similarCards: 'unknown', sameGoalActiveRuns: [] }, explanation: 'none' };
    };
    deps.memoryGate = async () => {
      started.push('memory');
      return { decision: { action: 'record', context: '', fragmentIds: [] }, explanation: 'none' };
    };
    const work = dispatchTask({ ...input, runKey: 'parallel' }, deps);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started.sort()).toEqual(['budget', 'placement', 'relation', 'memory'].sort());
    } finally { release(); }
    expect((await work).mode).toBe('observe');
  }));

  test('a thrown gate and a timed-out gate remain unavailable; the others persist', async () => withStore(async (root) => {
    const deps = fixture(root);
    deps.timeoutMs = 20;
    deps.budgetGate = async () => { throw new Error('quota read failed'); };
    deps.memoryGate = async () => new Promise(() => {});
    const started = Date.now();
    const result = await dispatchTask({ ...input, runKey: 'run-errors' }, deps);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.decisions.budget).toEqual({ decision: '측정 불가', explanation: '측정 불가: quota read failed' });
    expect(result.decisions.memory).toEqual({ decision: '측정 불가', explanation: '측정 불가: timeout after 20ms' });
    const store = new CardStore(root);
    try {
      expect(store.getCard(result.cardId)!.sections).toHaveLength(3);
      expect(JSON.parse(store.getCard(result.cardId)!.sections[0]!.content).placement.decision.substrate).toBe('unknown');
    } finally { store.close(); }
  }));

  test('unobserved active runs stay unknown rather than an empty observed set, while the rest of the relation is measured', async () => withStore(async (root) => {
    const deps = fixture(root);
    delete deps.relationGate;
    const result = await dispatchTask({ ...input, runKey: 'unknown-active-runs' }, deps);
    const relation = result.decisions.relation.decision as { sameGoalActiveRuns: unknown; overlappingCards: unknown; action: unknown };
    expect(relation.sameGoalActiveRuns).toBe('unknown');
    expect(relation.overlappingCards).toEqual([]);
    expect(relation.action).toBe('record');
    expect(result.decisions.relation.explanation).toContain('active=unknown');
    const store = new CardStore(root);
    try {
      expect(JSON.parse(store.getCard(result.cardId)!.sections[1]!.content)).toEqual(result.decisions.relation);
      expect(store.getCard(result.cardId)!.sections).toHaveLength(3);
    } finally { store.close(); }
  }));

  test('secret-shaped gate decisions and explanations are redacted on disk', async () => withStore(async (root) => {
    const secret = 'sk-abcdefghijklmnopqrs0123456789';
    const deps = fixture(root);
    deps.memoryGate = async () => ({ decision: { action: 'record', context: secret, fragmentIds: [] }, explanation: `recalled ${secret}` });
    const result = await dispatchTask({ ...input, runKey: 'secret' }, deps);
    const bytes = readFileSync(cardEventsPath(result.cardId, root), 'utf8');
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain('<redacted>');
  }));
});

describe('runDevPipeline observation wiring', () => {
  test('one dispatch records its card in the run ledger without changing the launch options', async () => withStore(async (root) => {
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const calls: DispatchTaskInput[] = [];
    let launched = 0;
    try {
      const result = await runDevPipeline({ ...spec, runId: 'run-card-observe' }, {
        dispatchTask: async (args) => { calls.push(args); return { cardId: 'card-one', decisions: {} as never, mode: 'observe' }; },
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async (opts) => { launched++; expect(opts.runId).toBe('run-card-observe'); return { ok: true } as SelfImplementResult; },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ goalText: 'Implement feature', runKey: 'run-card-observe' });
      expect(loadRunLedger('run-card-observe', runLedgerDir(root))?.filter((row) => row.event === 'execution-loop-card')).toEqual([
        expect.objectContaining({ data: { cardId: 'card-one' } }),
      ]);
      expect(launched).toBe(1);
      expect(result.kind).toBe('self');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  }));

  test('pipeline observes real gate decisions without applying stop to the launch', async () => withStore(async (root) => {
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const gates = fixture(root);
    const childLlm = { provider: 'grok', model: 'test-model', source: 'flag' as const };
    const launchSpec: DevPipelineSpec = { ...spec, completion: 'worktree-only', self: { childLlm } };
    let launched = 0;
    try {
      const result = await runDevPipeline(launchSpec, {
        dispatchTaskDeps: gates,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async (options) => {
          launched++;
          expect(options.childLlm).toEqual(childLlm);
          expect(options.completion).toBe('worktree-only');
          return { ok: true } as SelfImplementResult;
        },
      });
      expect(result.kind).toBe('self');
      expect(result.plan.executor).toEqual({ kind: 'self' });
      expect(launched).toBe(1);
      const store = new CardStore(root);
      try {
        const cards = store.listCards();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.sections.map((section) => section.key.split(':')[0])).toEqual(['gates', 'relations', 'memory']);
        expect(JSON.parse(cards[0]!.sections[0]!.content).budget.decision.action).toBe('stop');
        const cli = spawnSync('bun', ['bin/elanous.mjs', '--test-state-dir', root, 'card', 'list', '--json'], {
          cwd: process.cwd(),
          env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: root },
          encoding: 'utf8', timeout: 15_000,
        });
        expect(cli.status).toBe(0);
        const listed = JSON.parse(cli.stdout) as Array<{ sections: Array<{ key: string }> }>;
        expect(listed).toHaveLength(1);
        expect(listed[0]!.sections.map((section) => section.key.split(':')[0])).toEqual(['gates', 'relations', 'memory']);
      } finally { store.close(); }
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  }));

  test('pipeline without relationDeps records unknown active runs rather than none', async () => withStore(async (root) => {
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const gates = fixture(root);
    delete gates.relationGate;
    try {
      const result = await runDevPipeline(spec, {
        dispatchTaskDeps: gates,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => ({ ok: true } as SelfImplementResult),
      });
      expect(result.kind).toBe('self');
      const store = new CardStore(root);
      try {
        const card = store.listCards()[0]!;
        expect(JSON.parse(card.sections[1]!.content).decision.sameGoalActiveRuns).toBe('unknown');
      } finally { store.close(); }
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  }));

  test('gate deadline persists unavailable sections and records the card ID before launch', async () => withStore(async (root) => {
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const gates = fixture(root);
    gates.timeoutMs = 20;
    gates.memoryGate = async () => new Promise(() => {});
    try {
      let launched = 0;
      const result = await runDevPipeline({ ...spec, runId: 'run-gate-deadline' }, {
        dispatchTaskDeps: gates,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched++; return { ok: true } as SelfImplementResult; },
      });
      expect(result.kind).toBe('self');
      expect(launched).toBe(1);
      const store = new CardStore(root);
      try {
        const card = store.listCards()[0]!;
        expect(card.sections).toHaveLength(3);
        expect(JSON.parse(card.sections[2]!.content).decision).toBe('측정 불가');
        expect(loadRunLedger('run-gate-deadline', runLedgerDir(root))?.filter((row) => row.event === 'execution-loop-card')).toEqual([
          expect.objectContaining({ data: { cardId: card.id } }),
        ]);
      } finally { store.close(); }
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  }));

  test('at the five-second gate deadline, the ledger and unavailable card sections precede launch', async () => withStore(async (root) => {
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const gates = fixture(root);
    gates.memoryGate = async () => new Promise(() => {});
    const started = Date.now();
    try {
      let checkedAtLaunch = false;
      const result = await runDevPipeline({ ...spec, runId: 'run-five-second-gate' }, {
        dispatchTaskDeps: gates,
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => {
          const store = new CardStore(root);
          try {
            const card = store.listCards()[0]!;
            expect(card.sections).toHaveLength(3);
            expect(JSON.parse(card.sections[2]!.content).decision).toBe('측정 불가');
            expect(loadRunLedger('run-five-second-gate', runLedgerDir(root))?.filter((row) => row.event === 'execution-loop-card')).toEqual([
              expect.objectContaining({ data: { cardId: card.id } }),
            ]);
            checkedAtLaunch = true;
          } finally { store.close(); }
          return { ok: true } as SelfImplementResult;
        },
      });
      expect(result.kind).toBe('self');
      expect(checkedAtLaunch).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_800);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  }), 7_500);

  test('a non-settling injected dispatch records its created card and cannot delay launch beyond five seconds', async () => withStore(async (root) => {
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const started = Date.now();
    let launched = 0;
    try {
      const result = await runDevPipeline({ ...spec, runId: 'run-stalled-dispatch' }, {
        dispatchTask: async (_input, deps) => {
          deps?.onCardCreated?.('card-before-timeout');
          return new Promise(() => {});
        },
        buildSelfImplementSeams: () => ({} as SelfImplementSeams),
        runSelfImplement: async () => { launched++; return { ok: true } as SelfImplementResult; },
      });
      expect(Date.now() - started).toBeLessThan(5_800);
      expect(launched).toBe(1);
      expect(result.kind).toBe('self');
      expect(loadRunLedger('run-stalled-dispatch', runLedgerDir(root))?.filter((row) => row.event === 'execution-loop-card')).toEqual([
        expect.objectContaining({ data: { cardId: 'card-before-timeout' } }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
    }
  }), 7_000);

  test('dispatch failure does not stop the pipeline', async () => {
    let launched = 0;
    const result = await runDevPipeline(spec, {
      dispatchTask: async () => { throw new Error('card unavailable'); },
      buildSelfImplementSeams: () => ({} as SelfImplementSeams),
      runSelfImplement: async () => { launched++; return { ok: true } as SelfImplementResult; },
    });
    expect(launched).toBe(1);
    expect(result.kind).toBe('self');
  });
});

describe('card goal ids', () => {
  test('long hex request ids stay distinct instead of collapsing into one redacted card', async () => withStore(async (root) => {
    const a = `request-${'a'.repeat(32)}`;
    const b = `request-${'b'.repeat(32)}`;
    expect(cardGoalId(a)).toBe(a);
    const deps = fixture(root);
    const first = await dispatchTask({ ...input, goalId: a, runKey: 'r1' }, deps);
    const second = await dispatchTask({ ...input, goalId: b, runKey: 'r2' }, fixture(root));
    expect(first.cardId).not.toBe(second.cardId);
    const store = new CardStore(root);
    try {
      expect(store.listCards().map((card) => card.goalId).sort()).toEqual([a, b]);
      expect(JSON.stringify(store.listCards())).not.toContain('<redacted>');
    } finally { store.close(); }
  }));

  test('ids outside the identifier alphabet become a stable hash', () => {
    expect(cardGoalId('has space')).toMatch(/^goal-[0-9a-f]{32}$/);
    expect(cardGoalId('has space')).toBe(cardGoalId('has space'));
  });
});
