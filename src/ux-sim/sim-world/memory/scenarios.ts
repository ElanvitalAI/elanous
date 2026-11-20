// M01–M12 memory world scenarios (SIM-WORLD-MEMORY · S0) — §2 «M. 기억 세계» of
// seat-state/OP/evidence/20261118/SIM-WORLD-TA-AND-SUPERVISORS-1118.md. Every scenario drives the real runGraph with
// D17 behind the proposed storage port (deps.memory — GRAPH-MEMORY-SCOPES graph-memory-port.ts); the harness seeds and
// inspects D17 directly, so only runner-made port calls count as «the runner used memory».
// Verdicts: expected red + same reason → xfail · expected red + other reason → wrong-reason-red (never xfail) · expected
// red + pass → promote-required · any store fault or crash → infra-error (never a silent pass).
// Replay: no randomness and D17 runs on a fixed logical clock, so the same scenario twice gives a byte-identical store snapshot.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decideGraphApproval, runGraph } from '../../../graph-runner/runner.js';
import type { GraphRunOptions, GraphRunState } from '../../../graph-runner/runner-types.js';
import type { InProcessHandler, InProcessHandlerContext, InProcessHandlerResult } from '../../../graph-runner/in-process-registry.js';
import { createLogicalClock, MemoryStoreError, SimMemoryStore, type GraphMemoryStorePort, type MemoryClock, type MemoryEvent } from './store.js';
import type { SimWorldDeviceDef, SimWorldRecorder, SimWorldScenario } from '../types.js';

export type MemoryVerdictKind = 'pass' | 'xfail' | 'fail' | 'wrong-reason-red' | 'promote-required' | 'infra-error';
export interface MemoryVerdict {
  readonly id: string; readonly verdict: MemoryVerdictKind; readonly reason: string;
  readonly observed?: Readonly<Record<string, unknown>>; readonly runnerPortCalls: number; readonly events: readonly MemoryEvent[];
  /** The literal red reason actually observed (fail outcomes); the kernel compares it with the table's redReason. */
  readonly observedReason?: string;
  /** observed-vs-expected text for the kernel diff (fail outcomes). */
  readonly diff?: string;
  /** D17 snapshot() after the run — the record/replay comparison value. */
  readonly storeSnapshot?: string;
}
/** D17 as the kernel creates it: one store on one fixed logical clock (D7) per scenario run. */
export interface MemoryDevice { readonly clock: MemoryClock & { advance(ms: number): void }; readonly store: SimMemoryStore }
export const MEMORY_CLOCK_START = '2026-11-19T00:00:00.000Z';
export function createMemoryDevice(): MemoryDevice {
  const clock = createLogicalClock(MEMORY_CLOCK_START);
  return { clock, store: new SimMemoryStore(clock) };
}
export interface MemoryScenario {
  readonly id: string; readonly title: string; readonly checks: string;
  readonly expected: 'red' | 'green'; readonly reason: string; readonly greenBy: string;
  readonly expect: Readonly<Record<string, unknown>>;
  run(world: MemoryWorld): Promise<Record<string, unknown>>;
}
/** What the runner receives as deps.memory (proposal). */
export interface MemoryBinding { readonly port: GraphMemoryStorePort; readonly tenant: string; readonly seatKey?: string }
interface Line { key: string; text: string; ttlMs?: number }
interface MemoryRequest { write?: Line[]; promote?: { key: string; to: 'template' | 'global'; approvalNode?: string }[] }
/** An approval step may bind a memory item: `source` = the writer node, `key` = the line, `target` = the layer shown to the approver
 * (the runner honours a promote only when the approval node it names recorded exactly this item and target). */
type Step = { id: string; handler: string } | { id: string; approval: 'promote' | 'pause'; source?: string; key?: string; target?: 'template' | 'global' };

const GREEN_BY = 'GRAPH-MEMORY-SCOPES';
const DAY = 86_400_000;
const SEED_RUN = 'seed-run';
const SEED_NODE = 'seed-node';
const REMEMBER_UNIT = resolve(import.meta.dir, '../../../../graphs/units/verbs/remember.yaml');

export class MemoryWorld {
  readonly clock: MemoryDevice['clock'];
  readonly store: SimMemoryStore;
  readonly portCalls: { op: string; error?: string }[] = [];
  constructor(readonly root: string, device: MemoryDevice = createMemoryDevice(), private readonly recorder?: SimWorldRecorder) {
    this.clock = device.clock;
    this.store = device.store;
  }
  /** The port handed to the runner: D17 plus a call log. */
  readonly port: GraphMemoryStorePort = {
    read: input => this.logged('read', () => this.store.read(input)),
    write: input => this.logged('write', () => this.store.write(input)),
    promote: input => this.logged('promote', () => this.store.promote(input)),
    expire: () => this.logged('expire', () => this.store.expire()),
  };
  private async logged<T>(op: string, call: () => Promise<T>): Promise<T> {
    try { const value = await call(); this.portCalls.push({ op }); this.recorder?.seam(`memory.${op}`, null, 'ok'); return value; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.portCalls.push({ op, error: message });
      this.recorder?.seam(`memory.${op}`, null, message);
      throw error;
    }
  }
  graph(graphId: string, steps: readonly Step[]): string {
    const node = (step: Step) => 'handler' in step
      ? `  - { node_id: ${step.id}, kind: agent, recipe: 'handler:${step.handler}', max_visits: 1 }`
      : `  - { node_id: ${step.id}, kind: hitl, recipe: 'approval:${step.approval}', max_visits: 1${step.source
        ? `, input: { memorySourceNode: ${step.source}, memoryKey: ${step.key}, memoryTarget: ${step.target} }` : ''} }`;
    const edge = (step: Step, index: number) => {
      const next = steps[index + 1]?.id ?? 'done';
      return 'handler' in step ? `  - { from: ${step.id}, on: outcome, map: { done: ${next}, failed: failed } }`
        : `  - { from: ${step.id}, on: outcome, map: { approved: ${next}, rejected: failed } }`;
    };
    return this.file(graphId, `graph_id: ${graphId}\nversion: 1\nentry_node: ${steps[0]!.id}\nterminal_nodes: [done, failed]\nnodes:\n` +
      `${steps.map(node).join('\n')}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n` +
      `edges:\n${steps.map(edge).join('\n')}\n`);
  }
  file(graphId: string, source: string): string {
    const path = join(this.root, `${graphId}.yaml`);
    writeFileSync(path, source);
    return path;
  }
  run(path: string, handlers: Record<string, InProcessHandler>, options: { runId?: string; resumeRunId?: string; tenant?: string; seatKey?: string; input?: unknown } = {}): Promise<GraphRunState> {
    const deps: NonNullable<GraphRunOptions['deps']> & { memory: MemoryBinding } = {
      root: this.root, inProcessHandlers: handlers, memory: { port: this.port, tenant: options.tenant ?? 't-x', ...(options.seatKey ? { seatKey: options.seatKey } : {}) },
      runBash: async () => { throw new Error('memory world escaped to shell'); },
      ...(this.recorder ? { nodeLifecycle: this.recorder.nodeLifecycle } : {}),
    };
    return runGraph(path, { ...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : { runId: options.runId }),
      ...(options.input === undefined ? {} : { input: options.input }), deps });
  }
  approve(state: GraphRunState): void { decideGraphApproval(state.graphId, state.runId, 'approved', 'sim-approver', this.root); }
  /** Harness-side seeding (not counted as a runner call): an approved template row. */
  async seedTemplate(graphId: string, key: string, text: string): Promise<void> {
    const source = await this.store.write({ tenant: 't-x', graphId, runId: SEED_RUN, nodeId: SEED_NODE, key, text });
    await this.store.promote({ tenant: 't-x', graphId, runId: SEED_RUN, nodeId: SEED_NODE, sourceId: source.id, to: 'template',
      approval: { by: 'sim-approver' } });
  }
  count(predicate: (row: ReturnType<SimMemoryStore['all']>[number]) => boolean): number { return this.store.all().filter(predicate).length; }
}

/** A handler that asks the runner to write/promote memory through its result (proposed field `memory`). */
function writer(request: MemoryRequest, sink?: string[][]): InProcessHandler {
  return context => {
    sink?.push(seen(context));
    return Object.assign<InProcessHandlerResult, { memory: MemoryRequest }>({ ok: true, outcome: 'done', result: 'wrote',
      evidence: { world: 'sim-memory' } }, { memory: request });
  };
}
function reader(sink: string[][]): InProcessHandler {
  return context => { sink.push(seen(context)); return { ok: true, outcome: 'done', result: 'read', evidence: { world: 'sim-memory' } }; };
}
/** Proposed context field `memory`: the rows the runner read for this node. */
function seen(context: InProcessHandlerContext): string[] {
  const memory = (context as InProcessHandlerContext & { memory?: readonly { text?: unknown }[] }).memory;
  return Array.isArray(memory) ? memory.map(row => String(row.text)) : [];
}

const scenario = (id: string, title: string, checks: string, expect: Record<string, unknown>,
  run: MemoryScenario['run'], greenBy = GREEN_BY): MemoryScenario => ({ id, title, checks, expected: 'green', reason: '', greenBy, expect, run });
/** A scenario the product does not satisfy yet: the red reason is the literal `expectation-mismatch: <first mismatching key>` the judge observes. */
const red = (mismatch: string, base: MemoryScenario): MemoryScenario => ({ ...base, expected: 'red', reason: `expectation-mismatch: ${mismatch}` });

export const MEMORY_SCENARIOS: readonly MemoryScenario[] = [
  scenario('M01', '같은 런 쓰기→읽기', 'node a writes, node b of the same run reads it as instance memory',
    { bSees: ['m01-line'], scope: ['instance'] }, async world => {
      const seenByB: string[][] = [];
      await world.run(world.graph('g-m01', [{ id: 'a', handler: 'mem-write' }, { id: 'b', handler: 'mem-read' }]),
        { 'mem-write': writer({ write: [{ key: 'fact', text: 'm01-line' }] }), 'mem-read': reader(seenByB) }, { runId: 'm01-r1' });
      return { bSees: seenByB[0] ?? [], scope: world.store.all().map(row => row.scope) };
    }),
  scenario('M02', '인스턴스→템플릿 promote(승인 관문)', 'no template row before approval; one row with the approver after it',
    { templateBefore: 0, templateAfter: 1, approvedBy: 'sim-approver' }, async world => {
      const path = world.graph('g-m02', [{ id: 'a', handler: 'mem-write' }, { id: 'approve', approval: 'promote', source: 'a', key: 'lesson', target: 'template' },
        { id: 'p', handler: 'mem-promote' }]);
      const handlers = { 'mem-write': writer({ write: [{ key: 'lesson', text: 'm02-line' }] }),
        'mem-promote': writer({ promote: [{ key: 'lesson', to: 'template', approvalNode: 'approve' }] }) };
      const paused = await world.run(path, handlers, { runId: 'm02-r1' });
      const templateBefore = world.count(row => row.scope === 'template');
      world.approve(paused);
      await world.run(path, handlers, { resumeRunId: paused.runId });
      return { templateBefore, templateAfter: world.count(row => row.scope === 'template'),
        approvedBy: world.store.all().find(row => row.scope === 'template')?.approvedBy ?? null };
    }),
  scenario('M03', '광역 promote 는 승인 뒤에만', 'a global promote without approval is refused with the literal text; 0 global rows',
    { globalRows: 0, refusalInRun: true }, async world => {
      const state = await world.run(world.graph('g-m03', [{ id: 'a', handler: 'mem-write' }]),
        { 'mem-write': writer({ write: [{ key: 'fact', text: 'm03-line' }], promote: [{ key: 'fact', to: 'global' }] }) }, { runId: 'm03-r1' });
      return { globalRows: world.count(row => row.scope === 'global'),
        refusalInRun: JSON.stringify(state).includes('memory promote refused: approval-required') };
    }),
  scenario('M04', '같은 템플릿 다음 런', 'an approved template row reaches the first node of the next run of that graph only',
    { sameTemplate: ['m04-promoted'], otherTemplate: [] }, async world => {
      await world.seedTemplate('g-m04', 'lesson', 'm04-promoted');
      const same: string[][] = [];
      const other: string[][] = [];
      await world.run(world.graph('g-m04', [{ id: 'first', handler: 'mem-read' }]), { 'mem-read': reader(same) }, { runId: 'm04-r2' });
      await world.run(world.graph('g-m04-other', [{ id: 'first', handler: 'mem-read' }]), { 'mem-read': reader(other) }, { runId: 'm04-o1' });
      return { sameTemplate: same[0] ?? [], otherTemplate: other[0] ?? [] };
    }),
  scenario('M05', '그래프·테넌트 격리', 'tenants x and y write the same key; each sees only its own line; no key collision',
    { xSees: ['x-line'], ySees: ['y-line'], keyCollisions: 0 }, async world => {
      const path = world.graph('g-m05', [{ id: 'a', handler: 'mem-write' }, { id: 'b', handler: 'mem-read' }]);
      const xs: string[][] = [];
      const ys: string[][] = [];
      await world.run(path, { 'mem-write': writer({ write: [{ key: 'shared', text: 'x-line' }] }), 'mem-read': reader(xs) }, { runId: 'm05-x', tenant: 't-x' });
      await world.run(path, { 'mem-write': writer({ write: [{ key: 'shared', text: 'y-line' }] }), 'mem-read': reader(ys) }, { runId: 'm05-y', tenant: 't-y' });
      return { xSees: xs[0] ?? [], ySees: ys[0] ?? [],
        keyCollisions: world.store.events().filter(event => event.data.code === 'key-claimed').length };
    }),
  // Resumes run one after the other: overlapping runGraph calls would make the recorded walk order nondeterministic
  // (kernel quality bar 1). D17's own case table covers truly interleaved promotes (store.test «concurrent same key»).
  scenario('M06', '동시 쓰기', 'two runs promote the same template key: one claim, one key-claimed refusal, no source lost',
    { templateRows: 1, keyClaimedRefusals: 1, instanceRows: 2 }, async world => {
      const path = world.graph('g-m06', [{ id: 'a', handler: 'mem-write' }, { id: 'approve', approval: 'promote', source: 'a', key: 'policy', target: 'template' },
        { id: 'p', handler: 'mem-promote' }]);
      const handlers = (text: string) => ({ 'mem-write': writer({ write: [{ key: 'policy', text }] }),
        'mem-promote': writer({ promote: [{ key: 'policy', to: 'template', approvalNode: 'approve' }] }) });
      const one = await world.run(path, handlers('from-r1'), { runId: 'm06-r1' });
      const two = await world.run(path, handlers('from-r2'), { runId: 'm06-r2' });
      world.approve(one);
      world.approve(two);
      await world.run(path, handlers('from-r1'), { resumeRunId: one.runId });
      await world.run(path, handlers('from-r2'), { resumeRunId: two.runId });
      return { templateRows: world.count(row => row.scope === 'template'),
        keyClaimedRefusals: world.store.events().filter(event => event.data.code === 'key-claimed').length,
        instanceRows: world.count(row => row.scope === 'instance') };
    }),
  scenario('M07', '쓰기 중 사망', 'the writer dies mid-write: no partial record, one writer-died event',
    { rows: 0, writerDied: 1 }, async world => {
      world.store.armDeathMidWrite();
      await world.run(world.graph('g-m07', [{ id: 'a', handler: 'mem-write' }]),
        { 'mem-write': writer({ write: [{ key: 'fact', text: 'm07-line' }] }) }, { runId: 'm07-r1' });
      return { rows: world.count(row => row.text === 'm07-line'),
        writerDied: world.store.events().filter(event => event.type === 'memory.writer-died').length };
    }),
  scenario('M08', '재개가 기억 보존', 'stop at an approval node and resume: the instance memory hash is unchanged and b reads it',
    { sameDigest: true, instanceRows: 1, bSees: ['m08-line'] }, async world => {
      const path = world.graph('g-m08', [{ id: 'a', handler: 'mem-write' }, { id: 'stop', approval: 'pause' }, { id: 'b', handler: 'mem-read' }]);
      const seenByB: string[][] = [];
      const handlers = { 'mem-write': writer({ write: [{ key: 'fact', text: 'm08-line' }] }), 'mem-read': reader(seenByB) };
      const paused = await world.run(path, handlers, { runId: 'm08-r1' });
      const before = world.store.instanceDigest('t-x', 'g-m08', 'm08-r1');
      world.approve(paused);
      await world.run(path, handlers, { resumeRunId: paused.runId });
      return { sameDigest: before === world.store.instanceDigest('t-x', 'g-m08', 'm08-r1'),
        instanceRows: world.count(row => row.scope === 'instance' && row.runId === 'm08-r1'), bSees: seenByB[0] ?? [] };
    }),
  red('tick2SeesTick1', scenario('M09', '감독자 자기 범위', 'silence-watch tick n reads tick n-1; another supervisor sees none of it',
    { tick2SeesTick1: true, tick3SeesTick2: true, otherSupervisorSees: 0 }, async world => {
      const path = world.graph('sup-silence-watch', [{ id: 'tick', handler: 'sup-tick' }]);
      const ticks: string[][] = [];
      for (const n of [1, 2, 3])
        await world.run(path, { 'sup-tick': writer({ write: [{ key: `tick-${n}`, text: `tick-${n}` }] }, ticks) }, { runId: `m09-t${n}` });
      const other: string[][] = [];
      await world.run(world.graph('sup-disk-watch', [{ id: 'tick', handler: 'sup-tick' }]), { 'sup-tick': reader(other) }, { runId: 'm09-o1' });
      return { tick2SeesTick1: (ticks[1] ?? []).includes('tick-1'), tick3SeesTick2: (ticks[2] ?? []).includes('tick-2'),
        otherSupervisorSees: (other[0] ?? []).length };
    }, 'GRAPH-MEMORY-SCOPES + SIM-WORLD-SUP 감독자 범위 바인딩')),
  red('recalled', scenario('M10', '⑦remember 단위 쓰기 + 회상', 'the remember unit writes a sentence; recall returns it; evidence carries the store id',
    { recalled: ['m10 sentence'], evidenceHasStoreId: true }, async world => {
      mkdirSync(join(world.root, 'units'), { recursive: true });
      copyFileSync(REMEMBER_UNIT, join(world.root, 'units', 'verb-remember.yaml'));
      writeFileSync(join(world.root, 'units', 'recipes.yaml'), '{}\n');
      const path = world.file('g-m10', `graph_id: g-m10\nversion: 1\nentry_node: invoke\nterminal_nodes: [done, failed]\nnodes:\n` +
        `  - { node_id: invoke, kind: subgraph, recipe: none, max_visits: 1, call: verb-remember@1, budget: { inner_steps: 2 }, ` +
        `contract: { inputs: [ask, context, prior], tools: none, outputs: [result, evidence] } }\n` +
        `  - { node_id: recall, kind: agent, recipe: 'handler:mem-read', max_visits: 1 }\n` +
        `  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n` +
        `  - { from: invoke, on: outcome, map: { done: recall, rework: failed, needs-human: failed, failed: failed } }\n` +
        `  - { from: recall, on: outcome, map: { done: done, failed: failed } }\n`);
      const recalled: string[][] = [];
      const state = await world.run(path, { 'ta-remember': writer({ write: [{ key: 'note', text: 'm10 sentence' }] }), 'mem-read': reader(recalled) },
        { runId: 'm10-r1', input: { ask: 'remember m10', context: {}, prior: {} } });
      const stored = world.store.all().find(row => row.text === 'm10 sentence');
      return { recalled: recalled[0] ?? [], evidenceHasStoreId: stored !== undefined && JSON.stringify(state.nodes).includes(stored.id) };
    }, 'GRAPH-MEMORY-SCOPES + ta-remember 운영 처리기(V8)')),
  scenario('M11', '보존·만료', 'at +8d both instance lines (1d scope TTL) are tombstoned; the promoted template line (30d) is kept',
    { expiredTexts: ['m11-short', 'm11-keep'], liveTemplate: ['m11-keep'] }, async world => {
      const path = world.graph('g-m11', [{ id: 'a', handler: 'mem-write' }, { id: 'approve', approval: 'promote', source: 'a', key: 'keep', target: 'template' },
        { id: 'p', handler: 'mem-promote' }]);
      const handlers = { 'mem-write': writer({ write: [{ key: 'short', text: 'm11-short' }, { key: 'keep', text: 'm11-keep' }] }),
        'mem-promote': writer({ promote: [{ key: 'keep', to: 'template', approvalNode: 'approve' }] }) };
      const paused = await world.run(path, handlers, { runId: 'm11-r1' });
      world.approve(paused);
      await world.run(path, handlers, { resumeRunId: paused.runId });
      world.clock.advance(8 * DAY);
      await world.store.expire();
      const rows = world.store.all();
      return { expiredTexts: rows.filter(row => row.expired).map(row => row.text),
        liveTemplate: rows.filter(row => !row.expired && row.scope === 'template').map(row => row.text) };
    }),
  scenario('M12', 'TA 노하우 주입', 'a promoted template know-how line reaches the next run of that graph as the implement node context.memory (the real TA prompt text and its H1 injection are not measured here)',
    { promptHasKnowhow: true }, async world => {
      await world.seedTemplate('ta-si', 'knowhow', 'm12: run pregate before ready');
      const prompts: string[] = [];
      const implement: InProcessHandler = context => {
        prompts.push(['implement the goal', ...seen(context)].join('\n'));
        return { ok: true, outcome: 'done', result: 'implemented', evidence: { world: 'sim-memory' } };
      };
      await world.run(world.graph('ta-si', [{ id: 'implement', handler: 'ta-implement' }]), { 'ta-implement': implement }, { runId: 'm12-r1' });
      return { promptHasKnowhow: (prompts[0] ?? '').includes('m12: run pregate before ready') };
    }, 'GRAPH-MEMORY-SCOPES + TA implement 프롬프트 주입(H1)'),
  scenario('M25', '자리 키 template promote (seat:<SEAT>)', 'with seatKey TC an approved promote lands in template key {seat, TC}; only seat TC reads it (also from another graph); seat OP reads nothing; an unapproved promote is refused',
    { templateKey: 'seat:TC', tcSees: ['m25-line'], opSees: [], unapprovedRefused: true, templateRowsAfterRefusal: 1 }, async world => {
      const path = world.graph('g-m25', [{ id: 'a', handler: 'mem-write' }, { id: 'approve', approval: 'promote', source: 'a', key: 'seat-lesson', target: 'template' },
        { id: 'p', handler: 'mem-promote' }]);
      const handlers = { 'mem-write': writer({ write: [{ key: 'seat-lesson', text: 'm25-line' }] }),
        'mem-promote': writer({ promote: [{ key: 'seat-lesson', to: 'template', approvalNode: 'approve' }] }) };
      const paused = await world.run(path, handlers, { runId: 'm25-r1', seatKey: 'TC' });
      world.approve(paused);
      await world.run(path, handlers, { resumeRunId: paused.runId, seatKey: 'TC' });
      const landed = world.store.all().find(row => row.scope === 'template');
      const tc: string[][] = [];
      const op: string[][] = [];
      const readPath = world.graph('g-m25-read', [{ id: 'first', handler: 'mem-read' }]);
      await world.run(readPath, { 'mem-read': reader(tc) }, { runId: 'm25-r2', seatKey: 'TC' });
      await world.run(readPath, { 'mem-read': reader(op) }, { runId: 'm25-r3', seatKey: 'OP' });
      const refused = await world.run(world.graph('g-m25-un', [{ id: 'a', handler: 'mem-write' }]),
        { 'mem-write': writer({ write: [{ key: 'seat-lesson', text: 'm25-other' }], promote: [{ key: 'seat-lesson', to: 'template' }] }) },
        { runId: 'm25-r4', seatKey: 'TC' });
      return { templateKey: landed?.templateSeat === undefined ? 'none' : `seat:${landed.templateSeat}`, tcSees: tc[0] ?? [], opSees: op[0] ?? [],
        unapprovedRefused: JSON.stringify(refused).includes('memory promote refused: approval-required'),
        templateRowsAfterRefusal: world.count(row => row.scope === 'template') };
    }, 'GRAPH-MEMORY-SCOPES seatKey 포트(#39196·#39199)'),
];

/** Pure verdict rule; the kernel's expectation table can call it with its own expected/reason. */
export function judgeMemoryScenario(scenario: Pick<MemoryScenario, 'id' | 'expected' | 'reason' | 'expect'>,
  outcome: { observed?: Record<string, unknown>; crash?: string; faults: readonly string[]; runnerPortCalls: number; events?: readonly MemoryEvent[] }): MemoryVerdict {
  const base = { id: scenario.id, runnerPortCalls: outcome.runnerPortCalls, events: outcome.events ?? [],
    ...(outcome.observed ? { observed: outcome.observed } : {}) };
  if (outcome.faults.length > 0) return { ...base, verdict: 'infra-error', reason: `store-fault: ${outcome.faults[0]}` };
  if (outcome.crash !== undefined || !outcome.observed) return { ...base, verdict: 'infra-error', reason: `scenario-crashed: ${outcome.crash ?? 'no observation'}` };
  const observed = outcome.observed;
  const mismatch = Object.keys(scenario.expect).find(key => !isDeepStrictEqual(observed[key], scenario.expect[key]));
  if (mismatch === undefined) return scenario.expected === 'green' ? { ...base, verdict: 'pass', reason: 'as expected' }
    : { ...base, verdict: 'promote-required', reason: 'expected red is green: flip the expectation row in this PR' };
  const actual = outcome.runnerPortCalls === 0 ? 'runner made no memory port call' : `expectation-mismatch: ${mismatch}`;
  const red = { observedReason: actual,
    diff: `${scenario.id}: expected ${JSON.stringify(scenario.expect)} · observed ${JSON.stringify(observed)}` };
  if (scenario.expected === 'green') return { ...base, ...red, verdict: 'fail', reason: actual };
  return actual === scenario.reason ? { ...base, ...red, verdict: 'xfail', reason: actual }
    : { ...base, ...red, verdict: 'wrong-reason-red', reason: `wrong-reason-red: ${actual}` };
}

export async function runMemoryScenario(scenario: MemoryScenario, options: { injectStoreFault?: boolean; root?: string;
  device?: MemoryDevice; recorder?: SimWorldRecorder } = {}): Promise<MemoryVerdict> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), `sim-memory-${scenario.id.toLowerCase()}-`));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  const world = new MemoryWorld(root, options.device, options.recorder);
  writeFileSync(join(root, 'recipes.yaml'), 'promote:\n  approval: Promote this memory?\npause:\n  approval: Resume?\n');
  if (options.injectStoreFault) world.store.injectStoreFault();
  let observed: Record<string, unknown> | undefined;
  let crash: string | undefined;
  try { observed = await scenario.run(world); }
  catch (error) { crash = error instanceof MemoryStoreError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error); }
  finally {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    if (!options.root) rmSync(root, { recursive: true, force: true });
  }
  for (const event of world.store.events()) options.recorder?.event(event.type, { ...event.data, at: event.at, seq: event.seq });
  return { ...judgeMemoryScenario(scenario, { ...(observed ? { observed } : {}), ...(crash === undefined ? {} : { crash }),
    faults: world.store.faults(), runnerPortCalls: world.portCalls.length, events: world.store.events() }), storeSnapshot: world.store.snapshot() };
}

// ── kernel hook (seat-state/TC/SIM-KERNEL-API.md §1) ───────────────────────────────────────────────────────────────
export const simWorldDevices: readonly SimWorldDeviceDef[] = [
  { id: 'D17', title: 'sim-memory (three-layer memory store behind the graph memory port)', create: () => createMemoryDevice() },
];
/**
 * Any red → `{ ok: false, diff, reason: <observed literal> }`; the kernel's expect table (redReason) decides xfail vs
 * wrong-reason-red. A match → `{ ok: true }` (the kernel asks for promote). Store fault or crash → throw → infra-error.
 * Engine-agnostic: the memory world does not depend on the si engine, so it runs once per requested engine.
 */
export const simWorldScenarios: readonly SimWorldScenario[] = MEMORY_SCENARIOS.map(scenario => ({
  id: scenario.id, title: scenario.title, devices: ['D17'],
  async run(ctx) {
    const verdict = await runMemoryScenario(scenario, { root: ctx.universeRoot, device: ctx.device<MemoryDevice>('D17'), recorder: ctx.recorder });
    if (verdict.verdict === 'infra-error') throw new Error(verdict.reason);
    return verdict.observedReason !== undefined && verdict.diff !== undefined
      ? { ok: false, diff: verdict.diff, reason: verdict.observedReason } : { ok: true };
  },
}));
