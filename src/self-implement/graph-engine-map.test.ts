import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dir, '../..');
const mapText = readFileSync(join(repoRoot, 'seat-state/OPC/MAP-orchestrator-to-graph-1027.md'), 'utf8');
const sourceLines = readFileSync(join(repoRoot, 'src/self-implement/orchestrator.ts'), 'utf8').split('\n');
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

function sourceLine(pattern: RegExp, label: string): number {
  const index = sourceLines.findIndex((line) => pattern.test(line));
  expect(index, `${label} must exist in orchestrator.ts`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

function rangeContains(text: string, line: number): boolean {
  return [...text.matchAll(/orchestrator\.ts:(\d+)–(\d+)/g)].some((match) => {
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start <= line && line <= end && end <= sourceLines.length;
  });
}

describe('GRAPH-ENGINE-MAP', () => {
  test('YAML의 모든 노드가 대응표에 있고 실제 orchestrator 줄 범위를 가리킨다', () => {
    expect(mapText).toContain(`(${graph.nodes.length}개 노드 전부)`);
    expect([...mapRows.keys()].sort()).toEqual(graph.nodes.map((node) => node.node_id).sort());
    for (const [nodeId, cells] of mapRows) {
      expect(cells, `${nodeId} row has eight cells`).toHaveLength(8);
      expect(cells.every((cell) => cell.length > 0), `${nodeId} row has no blank cells`).toBe(true);
      for (const match of cells[2]!.matchAll(/orchestrator\.ts:(\d+)–(\d+)/g)) {
        expect(Number(match[1]), `${nodeId} range starts within source`).toBeGreaterThan(0);
        expect(Number(match[2]), `${nodeId} range ends within source`).toBeLessThanOrEqual(sourceLines.length);
      }
    }

    const runInner = sourceLine(/^async function runSelfImplementInner\(/, 'runSelfImplementInner');
    const observeEntry = sourceLine(/^\s*const observeNodeEntry\s*=/, 'observeNodeEntry');
    const runObserver = sourceLine(/^export function makeRunObserver\(/, 'makeRunObserver');
    expect(rangeContains(mapRows.get('author')![2]!, runInner)).toBe(true);
    expect(rangeContains(mapText.match(/orchestrator\.ts:\d+–\d+[^\n]*observeNodeEntry/)?.[0] ?? '', observeEntry)).toBe(true);
    expect(rangeContains(mapText.match(/orchestrator\.ts:\d+–\d+[^\n]*makeRunObserver/)?.[0] ?? '', runObserver)).toBe(true);
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
    expect(mapText).toContain('## FRONT(MK) seam — orchestrator.ts 줄 범위');
    expect(mapText).toContain('## BACK(TC) seam — orchestrator.ts 줄 범위');
    expect(mapText).toContain('## 레고 부품 후보 — graphs/units 등록 계약 초안');
    const unitRows = mapText.split('\n').filter((line) => line.startsWith('| unit:') || line.startsWith('| unit-'));
    expect(unitRows.length).toBeGreaterThanOrEqual(8);
  });
});
