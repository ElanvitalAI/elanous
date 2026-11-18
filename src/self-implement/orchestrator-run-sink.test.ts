// 0b (SELF-IMPLEMENT-DECOMPOSE W0) — RunSink parity through the outermost entry.
// runSelfImplementInner used to take 37 loose positional values (35 callbacks ⊕ observe ⊕ startedAtMs);
// they now travel as one RunSink object. These cases drive runSelfImplement only and pin, as
// hand-written literals, the order and arguments of every sink effect visible from outside:
// opts.onNodeEntry (sink.onNodeEntry → observeNodeEntry), the pipeline-node-entry ledger rows,
// registerLoopAgent status (sink.onWorktreeCreated), the pass-through seam
// reworkBudgetReviewFindingRecurrence, and result fields carried by sink setters.
// The literals were written from the case table, then confirmed against origin/main cb407dfcd7.
import { describe, expect, test } from 'bun:test';
import { runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';

type Trace = {
  nodes: string[];
  ledger: string[];
  nodeRows: string[];
  loopStatuses: string[];
  recurrenceCalls: number;
  result: Awaited<ReturnType<typeof runSelfImplement>>;
};

const reviewPass = async () => ({ verdict: 'pass' as const, mustFix: [], shouldFix: [], summary: 'review pass', reviewed: true, diffTruncated: false });
const reviewMustFix = async () => ({ verdict: 'fail' as const, mustFix: ['fix the sink'], shouldFix: [], summary: 'review fail', reviewed: true, diffTruncated: false });

async function drive(input: {
  runId: string;
  gateResults?: boolean[];
  review?: SelfImplementSeams['reviewDiff'];
  maxReworkRounds?: number;
  onNodeEntry?: ((node: string, round: number) => void) | 'absent';
  registerLoopAgentThrows?: boolean;
  recurrence?: 'null' | 'throws';
  autoMerge?: boolean;
}): Promise<Trace> {
  const nodes: string[] = [];
  const ledger: string[] = [];
  const nodeRows: string[] = [];
  const loopStatuses: string[] = [];
  let recurrenceCalls = 0;
  const result = await runSelfImplement({
    feature: `run sink parity ${input.runId}`,
    runId: input.runId,
    maxReworkRounds: input.maxReworkRounds ?? 0,
    memory: false,
    ...(input.autoMerge ? { autoMerge: true } : {}),
    ...(input.onNodeEntry === 'absent' ? {} : {
      onNodeEntry: (node: string, round: number) => {
        nodes.push(`${node}@${round}`);
        if (typeof input.onNodeEntry === 'function') input.onNodeEntry(node, round);
      },
    }),
    seams: seams({
      gateResults: input.gateResults ?? [true],
      currentProviderName: () => 'openai-codex',
      inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'],
      reviewDiff: input.review ?? reviewPass,
      writeRunLedger: (entry) => {
        ledger.push(entry.event);
        if (entry.event === 'pipeline-node-entry') nodeRows.push(`${String(entry.data?.node)}@${String(entry.data?.round)}`);
      },
      registerLoopAgent: (agent) => {
        loopStatuses.push(String(agent.status));
        if (input.registerLoopAgentThrows) throw new Error('registry down');
      },
      ...(input.recurrence ? {
        reworkBudgetReviewFindingRecurrence: () => {
          recurrenceCalls++;
          if (input.recurrence === 'throws') throw new Error('recurrence boom');
          return null;
        },
      } : {}),
    }),
  });
  return { nodes, ledger, nodeRows, loopStatuses, recurrenceCalls, result };
}

// 출처: src/self-implement/orchestrator.ts maxReworkRounds — rework 노드를 정확히 한 바퀴 밟게 하는 예산
const ONE_REWORK_ROUND = 1;

const SINK_EVENTS = new Set(['worktree', 'pipeline-node-entry', 'gated', 'reviewed', 'pr-opened', 'loop-agent-registration-failed', 'stop']);
const sinkLedger = (t: Trace): string[] => t.ledger.filter((event) => SINK_EVENTS.has(event));

const HAPPY_NODES = ['implement@0', 'gate@0', 'review@0', 'open-pr@0'];
const HAPPY_LEDGER = ['worktree', 'pipeline-node-entry', 'pipeline-node-entry', 'gated', 'pipeline-node-entry', 'reviewed', 'pipeline-node-entry', 'pr-opened', 'stop'];

describe('RunSink parity (0b) — runSelfImplement outermost entry', () => {
  test('C1 present · succeeds · first and second block: node entries, worktree hook, PR, terminal', async () => {
    const t = await drive({ runId: 'sink-c1' });
    expect(t.nodes).toEqual(['implement@0', 'gate@0', 'review@0', 'open-pr@0']);
    expect(t.nodeRows).toEqual(['implement@0', 'gate@0', 'review@0', 'open-pr@0']);
    expect(sinkLedger(t)).toEqual(['worktree', 'pipeline-node-entry', 'pipeline-node-entry', 'gated', 'pipeline-node-entry', 'reviewed', 'pipeline-node-entry', 'pr-opened', 'stop']);
    expect(t.loopStatuses).toEqual(['active', 'ended']);
    expect(t.result).toMatchObject({ outcome: 'completed', stage: 'pr-opened', node: 'open-pr', prNumber: 7 });
    expect(t.result.mergeApprovalReceived).toBeUndefined();
  }, 30_000);

  test('C2 gate fail → rework: onNodeEntry order and round arguments across two rounds', async () => {
    const t = await drive({ runId: 'sink-c2', gateResults: [false, true], maxReworkRounds: ONE_REWORK_ROUND });
    expect(t.nodes).toEqual(['implement@0', 'gate@0', 'rework@1', 'implement@1', 'gate@1', 'review@1', 'open-pr@1']);
    expect(t.nodeRows).toEqual(['implement@0', 'gate@0', 'rework@1', 'implement@1', 'gate@1', 'review@1', 'open-pr@1']);
    expect(t.result).toMatchObject({ outcome: 'completed', node: 'open-pr' });
  }, 30_000);

  test('C3 review must-fix with no budget: onReviewFindings/onFailureVerdict path ends budget-exhausted', async () => {
    const t = await drive({ runId: 'sink-c3', review: reviewMustFix });
    expect(t.nodes).toEqual(['implement@0', 'gate@0', 'review@0', 'rework@1']);
    expect(sinkLedger(t)).toEqual(['worktree', 'pipeline-node-entry', 'pipeline-node-entry', 'gated', 'pipeline-node-entry', 'reviewed', 'pipeline-node-entry', 'stop']);
    expect(t.result.outcome).toBe('budget-exhausted');
    expect(t.result.rework).toEqual({ trend: 'unmeasured', signature: 'implementation-deficit:MF-ebb1909e', rounds: 1 });
  }, 30_000);

  test('C4 sink consumer throws synchronously (opts.onNodeEntry): swallowed, walk identical to C1', async () => {
    const t = await drive({ runId: 'sink-c4', onNodeEntry: () => { throw new Error('consumer boom'); } });
    expect(t.nodes).toEqual(HAPPY_NODES);
    expect(sinkLedger(t)).toEqual(HAPPY_LEDGER);
    expect(t.result.outcome).toBe('completed');
  }, 30_000);

  test('C5 sink member onWorktreeCreated → registerLoopAgent throws: warned, not fatal, walk identical', async () => {
    const t = await drive({ runId: 'sink-c5', registerLoopAgentThrows: true });
    expect(t.nodes).toEqual(HAPPY_NODES);
    expect(sinkLedger(t)).toEqual(['loop-agent-registration-failed', 'worktree', 'pipeline-node-entry', 'pipeline-node-entry', 'gated', 'pipeline-node-entry', 'reviewed', 'pipeline-node-entry', 'pr-opened', 'stop', 'loop-agent-registration-failed']);
    expect(t.loopStatuses).toEqual(['active', 'ended']);
    expect(t.result.outcome).toBe('completed');
  }, 30_000);

  test('C6 pass-through seam reworkBudgetReviewFindingRecurrence returning null vs throwing: same walk', async () => {
    const ok = await drive({ runId: 'sink-c6', review: reviewMustFix, maxReworkRounds: ONE_REWORK_ROUND, recurrence: 'null' });
    const boom = await drive({ runId: 'sink-c6t', review: reviewMustFix, maxReworkRounds: ONE_REWORK_ROUND, recurrence: 'throws' });
    for (const t of [ok, boom]) {
      expect(t.nodes).toEqual(['implement@0', 'gate@0', 'review@0', 'rework@1', 'implement@1', 'gate@1', 'review@1', 'rework@2']);
      expect(t.result.outcome).toBe('budget-exhausted');
      expect(t.result.rework).toEqual({ trend: 'stable', signature: 'implementation-deficit:MF-ebb1909e', rounds: 2 });
    }
    expect(boom.recurrenceCalls).toBe(ok.recurrenceCalls);
  }, 60_000);

  test('C7 consumer absent (no opts.onNodeEntry): no-op, ledger rows unchanged', async () => {
    const t = await drive({ runId: 'sink-c7', onNodeEntry: 'absent' });
    expect(t.nodes).toEqual([]);
    expect(t.nodeRows).toEqual(['implement@0', 'gate@0', 'review@0', 'open-pr@0']);
    expect(sinkLedger(t)).toEqual(HAPPY_LEDGER);
  }, 30_000);

  test('C8 auto-merge: onMergeApprovalReceived setter reaches the result', async () => {
    const t = await drive({ runId: 'sink-c8', autoMerge: true });
    expect(t.nodes).toEqual(HAPPY_NODES);
    expect(t.result.mergeApprovalReceived).toBe(true);
    expect(t.result.outcome).toBe('completed');
  }, 30_000);
});
