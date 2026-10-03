import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphTemplatesFrom, defaultGraphsDir } from '../src/self-implement/graph-templates.js';
import { appendRunLedgerEntry } from '../src/self-implement/run-ledger.js';
import { measureGraphVisitBudgetDrift, renderGraphVisitBudgetDrift } from '../scripts/measure-graph-visit-budget-drift.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const measureScript = join(sourceRoot, 'scripts', 'measure-graph-visit-budget-drift.ts');

/** ⭐ 「선언된 예산」이 «관측된 실물»보다 좁지 않은가.
 *
 *  🩸 실측 2026-09-08 — 아래 상수는 당시 원장 표본의 스냅샷이다. 같은 계산은
 *    `bun scripts/measure-graph-visit-budget-drift.ts --ledger-dir <원장-디렉터리> --graphs-dir graphs`
 *    로 현재 지정 입력을 다시 재며, 이 명령은 기간 필터를 적용하지 않는다.
 *    당시 `pipeline-node-entry` 걸음 **191개**의 노드별 런별 최대 방문을 소급 계산했다:
 *    ```
 *    걸음 191 · 예산을 넘긴 걸음 ***3*** (1%) — ⛔ 전부 `open-pr`·`merge` (당시 선언 max_visits: 1)
 *    그 밖의 노드(implement 6/6 · rework 6/6 · gate 6/8 · review 6/8)는 «0건»
 *    ```
 *    ⇒ 🔑 ***선언이 실물보다 좁았다.*** 재시도는 정상인데 선언이 그것을 「초과」로 만들었다.
 *
 *  ⛔ 이 시험은 「예산이 크다」를 요구하지 않는다 — ***관측된 최대치를 담는가***만 묻는다.
 *    다시 좁히려면 «새 표본»을 대고 아래 수를 같이 고쳐라. */
const OBSERVED_MAX_VISITS: Readonly<Record<string, number>> = {
  // 📏 2026-09-08 원장 소급(걸음 191). 다시 잴 땐 이 파일 머리말의 명령으로 같은 입력을 지정한다.
  implement: 6, gate: 6, review: 6, rework: 6, 'main-sync': 2, regate: 2, 'open-pr': 2, merge: 2,
};

/** research-loop 은 노드 이름이 다르다 — ⛔ 한 표로 묶으면 「선언에 없는 노드」로 «조용히» 걸러진다.
 *  🩸 1차 소급이 정확히 그렇게 investigate 를 놓쳤다(관측 7 ↔ 선언 4 · 여유 −3). */
const OBSERVED_MAX_VISITS_RESEARCH: Readonly<Record<string, number>> = {
  investigate: 7, judge: 3, gate: 6, 'main-sync': 2, regate: 2, 'open-pr': 2, merge: 2,
};

describe('선언된 예산이 관측을 담는가', () => {
  const t = loadGraphTemplatesFrom(defaultGraphsDir()).templates['self-implement']!;

  it('⛔ 실물에서 «본» 최대 방문보다 좁은 선언이 없다', () => {
    const tooTight = t.nodes
      .filter((n) => OBSERVED_MAX_VISITS[n.nodeId] !== undefined && n.maxVisits < OBSERVED_MAX_VISITS[n.nodeId]!)
      .map((n) => `${n.nodeId}: 선언 ${n.maxVisits} < 관측 ${OBSERVED_MAX_VISITS[n.nodeId]}`);
    expect(tooTight).toEqual([]);
  });

  it('⛔ research-loop 도 «같은 자»로 문다 — 이름이 다르다고 빠지지 않는다', () => {
    const r = loadGraphTemplatesFrom(defaultGraphsDir()).templates['research-loop']!;
    const tooTight = r.nodes
      .filter((n) => OBSERVED_MAX_VISITS_RESEARCH[n.nodeId] !== undefined
        && n.maxVisits < OBSERVED_MAX_VISITS_RESEARCH[n.nodeId]!)
      .map((n) => `${n.nodeId}: 선언 ${n.maxVisits} < 관측 ${OBSERVED_MAX_VISITS_RESEARCH[n.nodeId]}`);
    expect(tooTight).toEqual([]);
  });

  it('⛔ 반증 — 이 자가 «항상 통과»하지 않는다(좁은 선언을 넣으면 잡는다)', () => {
    const fake = [{ nodeId: 'open-pr', maxVisits: 1 }];
    const tooTight = fake.filter((n) => n.maxVisits < OBSERVED_MAX_VISITS[n.nodeId]!);
    expect(tooTight.length).toBe(1);   // 🔑 옛 선언(1)이 바로 이 경우였다
  });

  it('관측표의 노드가 «선언에 실재»한다 — 없는 노드를 지키고 있지 않다', () => {
    const declared = new Set(t.nodes.map((n) => n.nodeId));
    for (const node of Object.keys(OBSERVED_MAX_VISITS)) expect(declared.has(node)).toBe(true);
  });
});

describe('measure-graph-visit-budget-drift', () => {
  it('원장별 최대 방문을 선언·여유와 대조하고 선언 없는 노드를 별도로 낸다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-budget-drift-'));
    try {
      const ledgerDirectory = join(root, 'run-ledger');
      const graphsDirectory = join(root, 'graphs');
      mkdirSync(ledgerDirectory, { recursive: true });
      mkdirSync(graphsDirectory, { recursive: true });
      writeFileSync(join(graphsDirectory, 'loop.yaml'), [
        'graph_id: fixture-loop', 'version: 1', 'entry_node: implement', 'terminal_nodes: [implement]',
        'nodes:', '  - node_id: implement', '    kind: agent', '    recipe: fixture', '    max_visits: 2',
        'edges: []',
      ].join('\n'), 'utf8');
      const appendNodeEntry = (runId: string, node: string) => appendRunLedgerEntry({
        runId,
        event: 'pipeline-node-entry',
        data: { graphId: 'fixture-loop', node },
      }, ledgerDirectory);
      appendNodeEntry('run-11111111-1111-1111-1111-111111111111', 'implement');
      appendNodeEntry('run-11111111-1111-1111-1111-111111111111', 'implement');
      appendNodeEntry('run-11111111-1111-1111-1111-111111111111', 'unknown');
      appendNodeEntry('run-22222222-2222-2222-2222-222222222222', 'implement');
      appendNodeEntry('run-22222222-2222-2222-2222-222222222222', 'implement');
      appendNodeEntry('run-22222222-2222-2222-2222-222222222222', 'implement');
      appendNodeEntry('run-22222222-2222-2222-2222-222222222222', 'unknown');
      appendNodeEntry('run-22222222-2222-2222-2222-222222222222', 'unknown');
      const firstLedger = join(ledgerDirectory, 'run-11111111-1111-1111-1111-111111111111.jsonl');
      writeFileSync(firstLedger, `${Array.from({ length: 100 }, () => JSON.stringify({ runId: 'run-11111111-1111-1111-1111-111111111111', event: 'pipeline-node-entry', data: {} })).join('\n')}\nnot json\n${JSON.stringify({ runId: 'run-11111111-1111-1111-1111-111111111111', data: {} })}\n`, { encoding: 'utf8', flag: 'a' });
      writeFileSync(join(ledgerDirectory, 'legacy-only.jsonl'), `${JSON.stringify({ event: 'pipeline-node-entry', data: {} })}\n`, 'utf8');

      const measurement = measureGraphVisitBudgetDrift({ ledgerDirectory, graphsDirectory });
      expect(measurement.runsMeasured).toBe(3); // Production writer creates one JSONL ledger per run.
      expect(measurement.evidenceRuns).toBe(2);
      expect(measurement.legacyPipelineNodeEntriesSkipped).toBe(101);
      expect(measurement.invalidJsonLines).toBe(1);
      expect(measurement.missingEventLines).toBe(1);
      expect(measurement.rows).toEqual([{ graphId: 'fixture-loop', node: 'implement', declaredMaxVisits: 2, observedMaxVisits: 3, headroom: -1, supportingRuns: 2 }]);
      expect(measurement.missingDeclarations).toEqual([{ graphId: 'fixture-loop', node: 'unknown', observedMaxVisits: 2, supportingRuns: 2 }]);
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('ledger files scanned: 3');
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('evidence-producing runs: 2');
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('legacy pipeline-node-entry skipped: 101');
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('invalid JSON lines: 1');
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('missing event lines: 1');
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('declared max_visits=2 observed maximum=3 headroom=-1 supporting runs=2');
      expect(renderGraphVisitBudgetDrift(measurement)).toContain('missing declaration:\n  graph=fixture-loop node=unknown observed maximum=2 supporting runs=2');
      const result = spawnSync('bun', [measureScript, '--ledger-dir', ledgerDirectory, '--graphs-dir', graphsDirectory], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ledger files scanned: 3');
      expect(result.stdout).toContain('evidence-producing runs: 2');
      expect(result.stdout).toContain('legacy pipeline-node-entry skipped: 101');
      expect(result.stdout).toContain('invalid JSON lines: 1');
      expect(result.stdout).toContain('missing event lines: 1');
      expect(result.stdout).toContain('declared max_visits=2 observed maximum=3 headroom=-1 supporting runs=2');
      expect(result.stdout).toContain('missing declaration:\n  graph=fixture-loop node=unknown observed maximum=2 supporting runs=2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('신원이 없는 원장만 있어도 근거 런 0과 exit 0을 함께 낸다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-budget-drift-identity-free-'));
    try {
      const ledgerDirectory = join(root, 'run-ledger');
      const graphsDirectory = join(root, 'graphs');
      mkdirSync(ledgerDirectory, { recursive: true });
      mkdirSync(graphsDirectory, { recursive: true });
      writeFileSync(join(graphsDirectory, 'loop.yaml'), 'graph_id: fixture-loop\nversion: 1\nentry_node: implement\nterminal_nodes: [implement]\nnodes:\n  - node_id: implement\n    kind: agent\n    recipe: fixture\n    max_visits: 1\nedges: []\n', 'utf8');
      writeFileSync(join(ledgerDirectory, 'legacy-only.jsonl'), `${JSON.stringify({ event: 'pipeline-node-entry', data: {} })}\n`, 'utf8');

      const measurement = measureGraphVisitBudgetDrift({ ledgerDirectory, graphsDirectory });
      expect(measurement.runsMeasured).toBe(1);
      expect(measurement.evidenceRuns).toBe(0);
      expect(measurement.rows).toEqual([]);
      const result = spawnSync('bun', [measureScript, '--ledger-dir', ledgerDirectory, '--graphs-dir', graphsDirectory], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ledger files scanned: 1');
      expect(result.stdout).toContain('evidence-producing runs: 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('신원이 있는 원장은 건너뜀과 실제 형태 파손을 모두 0으로 낸다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-budget-drift-clean-'));
    try {
      const ledgerDirectory = join(root, 'run-ledger');
      const graphsDirectory = join(root, 'graphs');
      mkdirSync(ledgerDirectory, { recursive: true });
      mkdirSync(graphsDirectory, { recursive: true });
      writeFileSync(join(graphsDirectory, 'loop.yaml'), 'graph_id: fixture-loop\nversion: 1\nentry_node: implement\nterminal_nodes: [implement]\nnodes:\n  - node_id: implement\n    kind: agent\n    recipe: fixture\n    max_visits: 1\nedges: []\n', 'utf8');
      appendRunLedgerEntry({ runId: 'run-33333333-3333-3333-3333-333333333333', event: 'pipeline-node-entry', data: { graphId: 'fixture-loop', node: 'implement' } }, ledgerDirectory);
      const measurement = measureGraphVisitBudgetDrift({ ledgerDirectory, graphsDirectory });
      expect(measurement.legacyPipelineNodeEntriesSkipped).toBe(0);
      expect(measurement.invalidJsonLines).toBe(0);
      expect(measurement.missingEventLines).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('원장을 못 읽으면 0건으로 접지 않고 직접 Bun entrypoint가 exit 1로 말한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-budget-drift-unreadable-'));
    try {
      const graphsDirectory = join(root, 'graphs');
      mkdirSync(graphsDirectory, { recursive: true });
      writeFileSync(join(graphsDirectory, 'loop.yaml'), 'graph_id: fixture-loop\nversion: 1\nentry_node: implement\nterminal_nodes: [implement]\nnodes:\n  - node_id: implement\n    kind: agent\n    recipe: fixture\n    max_visits: 1\nedges: []\n', 'utf8');
      expect(() => measureGraphVisitBudgetDrift({ ledgerDirectory: join(root, 'missing-ledger'), graphsDirectory })).toThrow('could not read ledger directory');
      const result = spawnSync('bun', [measureScript, '--ledger-dir', join(root, 'missing-ledger'), '--graphs-dir', graphsDirectory], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('could not read ledger directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
