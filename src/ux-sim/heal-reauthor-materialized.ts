// HEAL-REAUTHOR-FROM-MATERIALIZED — production heal-intake + heal-loop 재현 장치.
// 외부 LLM·TUI·TA·Pod 없이 실제 graph runner와 scripts/heal/run-role.ts를 호출한다.
// 임시 state root에만 inbox/ledger를 쓰고, materialized 경로가 실제 경로와 다르면 골을 고쳐
// goal-refined → reauthor-relaunch-request → reauthor-relaunch-result 이벤트가 한 번씩 남는지 본다.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHealLoop, type FailureEvent, type HealRelaunch } from '../self-implement/heal-intake.js';
import { makeRunObserver } from '../self-implement/orchestrator.js';
import { appendRunLedgerEntry, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';

export type HealReauthorScenario = 'materialized-mismatch' | 'zero-materialized-paths';

export interface HealReauthorObservation {
  readonly runId: string;
  readonly scenario: HealReauthorScenario;
  readonly outcome: string;
  readonly healGraphRunId: string | null;
  readonly reauthor: string | null;
  readonly revisedGoal: string | null;
  readonly relaunchCount: number;
  readonly goalRefinedEvents: readonly { runId: string; data: Record<string, unknown> }[];
  readonly relaunchRequestEvents: readonly { runId: string; data: Record<string, unknown> }[];
  readonly relaunchResultEvents: readonly { runId: string; data: Record<string, unknown> }[];
  readonly relaunchCalls: readonly Parameters<HealRelaunch>[0][];
}

function ledgerEntries(root: string): RunLedgerEntry[] {
  const dir = runLedgerDir(root);
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.jsonl')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as RunLedgerEntry));
}

/** 진짜 heal-loop와 role 스크립트를 돌린다. 재작성 뒤 dispatch만 가짜로 받아 외부 구현 런은 만들지 않는다. */
export async function simHealReauthorMaterialized(
  scenario: HealReauthorScenario,
  opts: { runId?: string } = {},
): Promise<HealReauthorObservation> {
  const runId = opts.runId ?? `uxsim-heal-${randomUUID()}`;
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-heal-reauthor-'));
  try {
    // Pass the isolated state root through the intake env argument. Mutating
    // process.env here races with other async work in this process.
    const env = { ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(root) };
    const goalId = `sim-cell-${randomUUID()}`;
    const goalText = '목표: 실패한 구현을 실체 근거에 맞춰 재작성한다\n대상 경로: src/expected.ts\n검증 무대: 지정 시험';
    const event: FailureEvent = {
      source: 'harness-run', kind: 'no-progress', ref: `${runId}-failure`, summary: 'no-progress after materialized attempt',
      goalText, goalId, at: new Date().toISOString(),
    };
    const writeLedger = (entry: RunLedgerEntry) => appendRunLedgerEntry(entry, runLedgerDir(root));
    const observe = makeRunObserver(event.ref, undefined, () => {}, writeLedger);
    const materializedPaths = scenario === 'materialized-mismatch' ? ['src/actual.ts'] : [];
    observe('implemented', { ok: false, round: 0, materializedPaths });
    observe('review-round-triage', { round: 1, rawMustFix: ['same finding repeated', 'same finding repeated'] });
    writeLedger({ timestamp: new Date().toISOString(), runId: event.ref, event: 'stop',
      data: { terminationReason: 'no-progress', cause: 'no-progress' } });

    const inbox = join(root, 'heal', 'inbox.jsonl');
    mkdirSync(join(root, 'heal'), { recursive: true });
    appendFileSync(inbox, `${JSON.stringify(event)}\n`);
    const relaunches: Parameters<HealRelaunch>[0][] = [];
    const runGraph = async (file: string, options: Parameters<typeof startHealLoop>[1]) => {
      const { runGraph: executeGraph } = await import('../graph-runner/runner.js');
      return executeGraph(file, { ...options, pinChildUniverse: true, deps: { root } });
    };
    const relaunch: HealRelaunch = async (input) => {
      relaunches.push(input);
      return { runId: `${runId}-outer-relaunch` };
    };
    const result = await startHealLoop(join(import.meta.dir, '../../graphs/heal/heal-loop.yaml'),
      { runId, input: { failureEvent: event }, deps: { root } }, env, runGraph, relaunch);
    const graphResult = result && typeof result === 'object' ? (result as { result?: unknown }).result : undefined;
    const entries = ledgerEntries(root);
    const forFailure = entries.filter((entry) => entry.runId === event.ref || entry.runId === runId);
    const byEvent = (name: string) => forFailure.filter((entry) => entry.event === name)
      .map((entry) => ({ runId: entry.runId, data: entry.data ?? {} }));
    const observation: HealReauthorObservation = {
      runId, scenario, outcome: String((graphResult as { status?: unknown } | undefined)?.status ?? 'unknown'),
      healGraphRunId: typeof (graphResult as { runId?: unknown } | undefined)?.runId === 'string'
        ? String((graphResult as { runId: string }).runId) : null,
      reauthor: typeof (result as { reauthor?: unknown } | undefined)?.reauthor === 'string'
        ? String((result as { reauthor: string }).reauthor) : null,
      revisedGoal: typeof byEvent('reauthor-relaunch-request')[0]?.data.revisedGoal === 'string'
        ? String(byEvent('reauthor-relaunch-request')[0]!.data.revisedGoal) : null,
      relaunchCount: relaunches.length,
      goalRefinedEvents: byEvent('goal-refined'),
      relaunchRequestEvents: byEvent('reauthor-relaunch-request'),
      relaunchResultEvents: byEvent('reauthor-relaunch-result'),
      relaunchCalls: relaunches,
    };
    writeLedger({ timestamp: new Date().toISOString(), runId, event: 'ux-sim.heal-reauthor/completed', data: observation as unknown as Record<string, unknown> });
    return observation;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderHealReauthor(o: HealReauthorObservation): string[] {
  return [
    `heal-reauthor-materialized · runId ${o.runId} · scenario ${o.scenario} · graph ${o.outcome} · reauthor ${o.reauthor ?? 'none'}`,
    `  goal-refined ${o.goalRefinedEvents.length} · relaunch-request ${o.relaunchRequestEvents.length} · relaunch-result ${o.relaunchResultEvents.length} · actual relaunch calls ${o.relaunchCount}`,
    ...(o.revisedGoal ? [`  revised goal: ${o.revisedGoal.replace(/\n/g, ' · ')}`] : []),
    `  receipt: bun test src/ux-sim/heal-reauthor-materialized.test.ts ⊕ ${o.runId}`,
  ];
}
