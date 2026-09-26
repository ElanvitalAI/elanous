import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visitBudgetOf } from '../src/self-implement/graph-authority.js';
import { loadGraphTemplatesFrom, defaultGraphsDir, GRAPH_SPECS, type GraphTemplate } from '../src/self-implement/graph-templates.js';
import type { GraphEdgeSpec } from '../src/self-implement/graph-yaml.js';
import { runSelfImplement } from '../src/self-implement/orchestrator.js';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../src/self-implement/run-ledger.js';
import type { GraphOverlaySpec } from '../src/self-implement/graph-overlay-yaml.js';
import { seams } from '../src/self-implement/test-seams.js';

/** ⭐ RFC §5 — `max_visits` 를 실행이 «읽게» 한 뒤의 반증.
 *
 *  🩸 2026-09-08 실측: `maxVisits` 를 «읽는» 실행 코드가 `src/` 에 «하나도 없었다» —
 *    선언·파싱뿐이라 오버레이가 그 값을 바꿔도 ***관측 가능한 차이를 못 냈다***(사다리 ④).
 *  ⛔ 이 판은 **관측만** 한다 — 막지 않는다. 「얼마나 물지」를 먼저 재야 한다. */
describe('노드 방문 예산 판독', () => {
  const t = loadGraphTemplatesFrom(defaultGraphsDir()).templates['self-implement']!;

  it('첫 진입은 1회차다 — 걸음이 비어도 «0」이 아니다', () => {
    const r = visitBudgetOf(t, [], 'implement');
    expect(r).not.toBeNull();
    expect(r!.visits).toBe(1);
    expect(r!.exceeded).toBe(false);
  });

  it('같은 노드를 다시 밟으면 «이번 진입까지» 센다', () => {
    const r = visitBudgetOf(t, ['implement', 'gate', 'implement'], 'implement');
    expect(r!.visits).toBe(3);
  });

  it('⛔ 예산을 넘으면 exceeded 가 참이다 — ⛔ 그래도 «막지 않는다»(이 판은 관측)', () => {
    const max = t.nodes.find((n) => n.nodeId === 'implement')!.maxVisits;
    const walk = Array.from({ length: max }, () => 'implement');
    const r = visitBudgetOf(t, walk, 'implement');
    expect(r!.visits).toBe(max + 1);
    expect(r!.exceeded).toBe(true);
  });

  it('⛔ 선언에 «없는» 노드는 null — 예산을 «지어내지» 않는다', () => {
    expect(visitBudgetOf(t, [], 'no-such-node')).toBeNull();
  });

  it('⛔ 반증 — 이 자가 «항상 exceeded」를 내지 않는다(예산 안쪽은 거짓)', () => {
    const max = t.nodes.find((n) => n.nodeId === 'gate')!.maxVisits;
    expect(max).toBeGreaterThan(0);
    expect(visitBudgetOf(t, ['gate'], 'gate')!.exceeded).toBe(false);
  });

  it('⛔ 다른 노드의 걸음은 «안 센다» — 노드별로 갈린다', () => {
    const r = visitBudgetOf(t, ['implement', 'implement', 'implement'], 'gate');
    expect(r!.visits).toBe(1);
  });
});

/** 이 노드로 «되돌아오는» 선언 간선 수. 라운드당 방문 수는 이 값에서만 파생한다.
 *  폴백·전진 간선은 세지 않는다 — `map` 의 실패 결과와 `to` 만 되돌아옴이다.
 *  ⛔ `visits ≤ round + 1` 은 되돌아오는 간선이 «하나»인 그래프에만 참이다.
 *    self-implement 의 implement ← rework 는 하나라 그 식이 성립하고,
 *    research-loop 의 investigate ← judge ⊕ gate 는 둘이라 한 라운드에 두 번 들어간다. */
function returningEdgeCount(template: GraphTemplate, nodeId: string): number {
  const edges = GRAPH_SPECS[template.graphId]?.edges ?? [];
  const targetsOf = (edge: GraphEdgeSpec): string[] => [
    ...(edge.to === undefined ? [] : [edge.to]),
    ...Object.values(edge.map ?? {}),
    ...(edge.fallback ?? []).map((item) => item.node),
  ];
  const reachable = new Set<string>();
  const queue = [template.entryNode];
  while (queue.length > 0) {
    const from = queue.shift()!;
    if (reachable.has(from)) continue;
    reachable.add(from);
    for (const edge of edges) {
      if (edge.from !== from) continue;
      for (const target of targetsOf(edge)) if (!reachable.has(target)) queue.push(target);
    }
  }
  const order = [...reachable];
  return edges.filter((edge) => {
    if (!reachable.has(edge.from) || edge.from === nodeId) return false;
    const failed = Object.entries(edge.map ?? {}).some(([outcome, target]) => outcome === 'fail' && target === nodeId);
    const directBack = edge.map === undefined && edge.to === nodeId && order.indexOf(edge.from) > order.indexOf(nodeId);
    return failed || directBack;
  }).length;
}

describe('되돌아오는 간선 수에서 라운드당 방문을 파생한다', () => {
  const loaded = loadGraphTemplatesFrom(defaultGraphsDir()).templates;

  it('self-implement 의 implement 는 1 · research-loop 의 investigate 는 2', () => {
    const implement = loaded['self-implement']!;
    const research = loaded['research-loop']!;
    expect(returningEdgeCount(implement, 'implement')).toBe(1);
    expect(returningEdgeCount(research, 'investigate')).toBe(2);
    expect(research.nodes.find((node) => node.nodeId === 'investigate')!.maxVisits).toBe(7);
    expect(research.edges.judge?.includes('investigate') && research.edges.gate?.includes('investigate')).toBe(true);
  });
});

/** research-loop 을 orchestrator 실행 경로로 걷고 «원장(JSONL)»을 다시 읽어 돌려준다.
 *  짝수 번째 gate 는 실패(gate --fail--> investigate), 홀수 번째는 통과 뒤 judge must-fix
 *  (judge --fail--> investigate) — 둘 다 실패면 판정 노드에 닿지 않는다.
 *  ⛔ 판정 신호는 «원장의 값»이다 — 콜백 배열이 아니라 실제 원장 기록기를 지나게 한다. */
async function walkResearchLoop(graphOverlays: readonly GraphOverlaySpec[] | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'research-visit-budget-'));
  const goalFile = join(dir, 'GOAL.md');
  writeFileSync(goalFile, [
    '대상 경로: src/example.ts',
    '- GoalId: 8890a94958dde35e',
    '- GoalType: research',
    '',
    '# research visit budget',
  ].join('\n'));
  const ledgerDir = runLedgerDir(join(dir, 'state'));
  const runId = 'run-research-visit-budget';
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = join(dir, 'state');
  let gateCalls = 0;
  let gateFailures = 0;
  let judgeMustFixes = 0;
  try {
    const result = await runSelfImplement({
      feature: 'research-loop visit budget observation',
      goalFile,
      goalId: '8890a94958dde35e',
      runId,
      ...(graphOverlays === undefined ? {} : { graphOverlays }),
      maxReworkRounds: 4,
      seams: seams({
        gate: async () => {
          const fail = gateCalls % 2 === 0;
          gateCalls += 1;
          if (fail) gateFailures += 1;
          return { passed: !fail, log: fail ? 'gate fail' : 'gate pass' };
        },
        changedFilesForGateRoute: () => ['src/example.ts'],
        reviewDiff: async () => {
          judgeMustFixes += 1;
          return {
            verdict: 'fail',
            mustFix: ['keep both returning edges and do not enforce the visit budget'],
            shouldFix: [],
            summary: 'must-fix',
            reviewed: true,
            diffTruncated: false,
          };
        },
        writeRunLedger: (entry) => appendRunLedgerEntry(entry, ledgerDir),
      }),
    });
    const ledgerFile = runLedgerPath(runId, ledgerDir);
    const ledgerExists = existsSync(ledgerFile);
    // ⚠️ data 가 문자열로 오는 표면이 있어 한 겹 더 푼다(ASK 의 되재는 명령과 같은 규칙).
    const events = ledgerExists
      ? readFileSync(ledgerFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => {
        const row = JSON.parse(line) as { event: string; data: unknown };
        const data = typeof row.data === 'string' ? JSON.parse(row.data) as Record<string, unknown> : row.data as Record<string, unknown>;
        return { event: row.event, data };
      })
      : [];
    const budgets = events.filter((row) => row.event === 'graph-visit-budget').map((row) => row.data);
    const entries = events.filter((row) => row.event === 'pipeline-node-entry').map((row) => String(row.data.node));
    const transitions: Array<[string, string]> = [];
    for (let index = 1; index < entries.length; index += 1) transitions.push([entries[index - 1]!, entries[index]!]);
    const transitionCount = (from: string, to: string): number =>
      transitions.filter(([left, right]) => left === from && right === to).length;
    return { result, ledgerExists, budgets, transitionCount, gateFailures, judgeMustFixes };
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('research-loop 실행 경로가 예산 7 을 관측으로 넘긴다', () => {
  it('선언 YAML 그대로(오버레이 없음) · maxRounds 4 · gate 실패 ⊕ judge must-fix 가 investigate 를 8회 밟고 원장에 exceeded=true 를 남긴다', async () => {
    const walk = await walkResearchLoop([]);
    expect(walk.ledgerExists).toBe(true);
    expect(walk.transitionCount('gate', 'investigate')).toBeGreaterThan(0);
    expect(walk.transitionCount('judge', 'investigate')).toBeGreaterThan(0);
    expect(walk.transitionCount('gate', 'investigate')).toBe(walk.gateFailures);
    expect(walk.transitionCount('judge', 'investigate')).toBe(walk.judgeMustFixes);
    const atEight = walk.budgets.find((row) => row.node === 'investigate' && row.visits === 8);
    expect(atEight).toMatchObject({ node: 'investigate', visits: 8, maxVisits: 7, exceeded: true, graphId: 'research-loop' });
    expect(atEight?.round).toBe(4);
    expect(walk.result.stage).not.toBe('aborted');
    expect(walk.budgets.every((row) => row.graphId === 'research-loop')).toBe(true);
  });

  it('⭐ 운영 런치 오버레이(research-wide-launch · investigate 예산 12)가 얹히면 같은 걸음이 예산 «안»이다 — 운영의 「0」은 이 오버레이 몫이다', async () => {
    const walk = await walkResearchLoop(undefined);
    const atEight = walk.budgets.find((row) => row.node === 'investigate' && row.visits === 8);
    expect(atEight).toMatchObject({ node: 'investigate', visits: 8, maxVisits: 12, exceeded: false });
    expect(walk.budgets.some((row) => row.node === 'investigate' && row.exceeded === true)).toBe(false);
  });
});
