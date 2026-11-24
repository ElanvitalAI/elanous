import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dir, '../..');
const mapText = readFileSync(join(repoRoot, 'seat-state/OPC/MAP-orchestrator-to-graph-1027.md'), 'utf8');
const orchestrator = readFileSync(join(repoRoot, 'src/self-implement/orchestrator.ts'), 'utf8');
const judge = readFileSync(join(repoRoot, 'src/task-agent/judge.ts'), 'utf8');
const graph = parse(readFileSync(join(repoRoot, 'graphs/implement-loop.yaml'), 'utf8')) as {
  nodes: Array<{ node_id: string }>;
  edges: Array<{ from: string; to?: string; map?: Record<string, string> }>;
};

function markdownCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '\\' && line[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

const mapRows = new Map(
  mapText.split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*[-| ]+\s*\|?$/.test(line))
    .map(markdownCells)
    .filter((cells) => graph.nodes.some((node) => node.node_id === cells[0]))
    .map((cells) => [cells[0]!, cells] as const),
);

const orchestratorAnchors: Readonly<Record<string, RegExp>> = {
  runSelfImplementInner: /^async function runSelfImplementInner\(/m,
  goalDocumentBody: /^function goalDocumentBody\(/m,
  goalContentHash: /^function goalContentHash\(/m,
  goalSource: /const goalSource = opts\.naturalLanguageDispatch/,
  goalClarification: /if \(opts\.goalFile && resolvedGoalFile\)/,
  implementing: /progress\('implementing', round ===/,
  implemented: /progress\('implemented', impl\.ok/,
  gateEntry: /onNodeEntry\(node\('gate'\)/,
  gated: /observe\('gated',/,
  gateFailed: /progress\('gate-failed',/,
  reviewEntry: /onNodeEntry\(node\('review'\)/,
  reviewing: /progress\('reviewing',/,
  reworkEntry: /onNodeEntry\(node\('rework'\)/,
  mainSync: /progress\('gating', `최신/,
  regate: /const regate = deferGateToLand/,
  prOpening: /progress\('pr-opening', 'PR 생성…'\)/,
  landingAdmission: /const landing = admitLandingMerge\(/,
  landingHeld: /const detail = landing\.kind === 'held'/,
  merged: /progress\('merged', formatAutoMergeSuccessMessage/,
  cleanup: /withJourneyNode\('cleanup'/,
  runPostMergeCleanup: /^async function runPostMergeCleanup\(/m,
  preserveBlockedArtifacts: /const preserveBlockedArtifacts = async/,
  salvageHardCap: /const salvageHardCap = async/,
  autohealRecordedStop: /^async function autohealRecordedStop\(/m,
  observeNodeEntry: /const observeNodeEntry\s*=/,
  makeRunObserver: /^export function makeRunObserver\(/m,
  gateSkippedByGraph: /observe\('gate-skipped-by-graph',/,
};

function resolveAnchor(file: string, anchor: string): boolean {
  if (file === 'orchestrator.ts') {
    return orchestratorAnchors[anchor]?.test(orchestrator) ?? false;
  }
  if (file === 'graphs/implement-loop.yaml') {
    return graph.nodes.some((node) => node.node_id === anchor);
  }
  return file === 'src/task-agent/judge.ts' && anchor === 'judgeNextMove'
    && /^export function judgeNextMove\(/m.test(judge);
}

describe('GRAPH-ENGINE-MAP', () => {
  test('YAML 노드 대응표가 완전하고 모든 소스 앵커가 현재 구현에 연결된다', () => {
    expect(mapText).toContain(`(${graph.nodes.length}개 노드 전부)`);
    expect([...mapRows.keys()].sort()).toEqual(graph.nodes.map((node) => node.node_id).sort());
    for (const [nodeId, cells] of mapRows) {
      expect(cells, `${nodeId} row has eight cells`).toHaveLength(8);
      expect(cells.every((cell) => cell.length > 0), `${nodeId} row has no blank cells`).toBe(true);
    }
    expect(mapText).not.toMatch(/\.(?:ts|yaml):\d+/);
    const citations = mapText.matchAll(/`([\w/.\-]+\.(?:ts|yaml))#([\w-]+)`/g);
    for (const [citation, file, anchor] of citations) {
      expect(resolveAnchor(file!, anchor!), citation).toBe(true);
    }
  });

  test('대표 노드의 출구 enum이 YAML on/map 선언과 일치하고 escaped table pipes를 보존한다', () => {
    for (const nodeId of ['author', 'dispatch', 'next-move']) {
      const row = mapRows.get(nodeId);
      expect(row, `${nodeId} map row exists`).toBeDefined();
      const exits = row![5]!;
      const labels = graph.edges
        .filter((edge) => edge.from === nodeId)
        .flatMap((edge) => edge.map ? Object.keys(edge.map) : edge.to ? [edge.to] : []);
      expect(labels.length, `${nodeId} has declared YAML exits`).toBeGreaterThan(0);
      for (const label of labels) expect(exits, `${nodeId} exit ${label} is mapped`).toContain(label);
    }
    expect(mapRows.get('dispatch')![4]).toContain('local | pod');
  });

  test('FRONT/BACK seam과 graphs/units 등록 계약 초안이 포함된다', () => {
    expect(mapText).toContain('## FRONT(MK) seam — orchestrator.ts 앵커');
    expect(mapText).toContain('## BACK(TC) seam — orchestrator.ts 앵커');
    expect(mapText).toContain('## 레고 부품 후보 — graphs/units 등록 계약 초안');
    const unitRows = mapText.split('\n').filter((line) => line.startsWith('| unit:') || line.startsWith('| unit-'));
    expect(unitRows.length).toBeGreaterThanOrEqual(8);
  });

  test('방문 예산과 실행 관측이 현재 구현을 인용한다', () => {
    const budgetCitation = mapText.split('\n').find((line) => line.startsWith('- 예산 보조:'));
    expect(budgetCitation).toContain('`orchestrator.ts#observeNodeEntry`');
    expect(mapText).toContain('`orchestrator.ts#makeRunObserver`');
    expect(mapText).toContain('`orchestrator.ts#gateSkippedByGraph`');
  });

  test('실행 단계마다 해당 경계 앵커가 있다', () => {
    const expectedAnchors = {
      dispatch: ['runSelfImplementInner'],
      author: ['runSelfImplementInner', 'goalDocumentBody', 'goalContentHash'],
      plan: ['goalSource'],
      decompose: ['goalClarification'],
      implement: ['implementing', 'implemented'],
      gate: ['gateEntry', 'gated', 'gateFailed'],
      review: ['reviewEntry', 'reviewing'],
      rework: ['reworkEntry'],
      'result-parse': ['preserveBlockedArtifacts'],
      salvage: ['salvageHardCap'],
      're-ground': ['goalContentHash'],
      'main-sync': ['mainSync'],
      regate: ['regate'],
      'open-pr': ['prOpening'],
      'freeze-check': ['landingAdmission'],
      hold: ['landingHeld'],
      merge: ['merged'],
      cleanup: ['cleanup', 'runPostMergeCleanup'],
    };
    for (const [nodeId, anchors] of Object.entries(expectedAnchors)) {
      for (const anchor of anchors) {
        expect(mapRows.get(nodeId)?.[2], nodeId).toContain(`\`orchestrator.ts#${anchor}\``);
      }
    }
  });

  test('실행 모듈 없는 후보 노드는 YAML 선언을 인용한다', () => {
    for (const nodeId of ['ready', 'pr-head-checkout']) {
      expect(mapRows.get(nodeId)?.[2]).toContain(`\`graphs/implement-loop.yaml#${nodeId}\``);
      expect(mapRows.get(nodeId)?.[2]).not.toContain('orchestrator.ts#');
    }
  });
});
