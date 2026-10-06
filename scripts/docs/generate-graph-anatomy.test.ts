import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diffAnatomy, renderGraphAnatomy, type AnatomySnapshot } from './generate-graph-anatomy.js';

const COMMIT = 'abc1234fixed';
const GENERATED_AT = '2026-10-05T00:00:00.000Z';

const TWO_NODE = `graph_id: sample-loop
version: 1
entry_node: alpha
terminal_nodes: [beta]
nodes:
  - node_id: alpha
    kind: agent
    recipe: cmd:alpha
    max_visits: 1
  - node_id: beta
    kind: gate
    recipe: cmd:beta
    max_visits: 1
edges:
  - from: alpha
    to: beta
`;

function withGraph(yaml: string, run: (root: string, markdown: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-'));
  try {
    writeFileSync(join(root, 'sample.yaml'), yaml);
    const markdown = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
    run(root, markdown);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('renderGraphAnatomy', () => {
  test('임시 YAML(노드 2 · 간선 1)의 graph_id · nodeId · from → to · 주입 커밋이 보인다', () => {
    withGraph(TWO_NODE, (_root, markdown) => {
      expect(markdown).toContain('sample-loop');
      expect(markdown).toContain('alpha');
      expect(markdown).toContain('beta');
      expect(markdown).toContain('alpha → beta');
      expect(markdown).toContain(COMMIT);
      expect(markdown).toContain(GENERATED_AT);
      expect(markdown).toContain('이 문서는 생성물이다 — 손으로 고치지 마라');
      expect(markdown).toContain('| harness | agent | core |');
      expect(markdown).toContain('| workflow | prompt | core |');
    });
  });

  test('같은 디렉터리에 노드를 하나 더 쓰면 그 nodeId 가 추가로 보인다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-'));
    try {
      writeFileSync(join(root, 'sample.yaml'), TWO_NODE);
      const before = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
      expect(before).not.toContain('gamma');
      const extra = TWO_NODE.replace(
        '  - node_id: beta\n    kind: gate\n    recipe: cmd:beta\n    max_visits: 1\n',
        '  - node_id: beta\n    kind: gate\n    recipe: cmd:beta\n    max_visits: 1\n  - node_id: gamma\n    kind: observe\n    recipe: cmd:gamma\n    max_visits: 1\n',
      ).replace('terminal_nodes: [beta]', 'terminal_nodes: [beta, gamma]').replace(
        '  - from: alpha\n    to: beta\n',
        '  - from: alpha\n    to: beta\n  - from: beta\n    to: gamma\n',
      );
      writeFileSync(join(root, 'sample.yaml'), extra);
      const after = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
      expect(after).toContain('gamma');
      expect(after).not.toBe(before);
      expect(after).toContain('| gamma | observe |');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('없는 디렉터리는 «0개 읽음»이 아니라 «디렉토리 없음»이다', () => {
    const missing = join(tmpdir(), `graph-anatomy-missing-${process.pid}-no-such`);
    const markdown = renderGraphAnatomy({ graphsRoot: missing, commit: COMMIT, generatedAt: GENERATED_AT });
    expect(markdown).toContain('디렉토리 없음');
    expect(markdown).toContain('scannedFiles: 0');
    expect(markdown).not.toContain('(0개 읽음)');
  });

  test('빈 디렉터리는 0개 읽음이고 디렉토리 없음이 아니다', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-empty-'));
    try {
      const markdown = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
      expect(markdown).toContain('(0개 읽음)');
      expect(markdown).not.toContain('디렉토리 없음');
      expect(markdown).toContain('scannedFiles: 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('실제 저장소 graphs/ 에 implement-loop · orchestrator · rhythm 이 표로 나온다', () => {
    const graphsRoot = join(import.meta.dir, '..', '..', 'graphs');
    const markdown = renderGraphAnatomy({ graphsRoot, commit: COMMIT, generatedAt: GENERATED_AT });
    expect(markdown).toContain('self-implement');
    expect(markdown).toContain('implement-loop.yaml');
    expect(markdown).toContain('| implement-loop.yaml | self-implement |');
    expect(markdown).toContain('| orchestrator/orchestrator.yaml |');
    expect(markdown).toContain('| rhythm/daily.yaml |');
    expect(markdown).toContain('| rhythm/weekly.yaml |');
    expect(markdown).toContain(COMMIT);
    const committed = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'generated', 'graph-anatomy.md'), 'utf8');
    expect(committed).toContain('self-implement');
    expect(committed).toContain('orchestrator');
    expect(committed).toContain('implement-loop.yaml');
    expect(committed).toContain('orchestrator/orchestrator.yaml');
    expect(committed).toContain('rhythm/daily.yaml');
    expect(committed).toContain('이 문서는 생성물이다 — 손으로 고치지 마라');
  });
});

test('a workflow-graph directory (recipes.yaml beside it) reads recipe-less gate nodes as the runner does and skips recipes.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-anatomy-runner-'));
  try {
    mkdirSync(join(root, 'announce'));
    writeFileSync(join(root, 'announce', 'recipes.yaml'), "gather:\n  command: 'echo hi'\n");
    writeFileSync(join(root, 'announce', 'announce-loop.yaml'), `graph_id: announce-loop
version: 1
entry_node: gather
terminal_nodes: [done, failed]
nodes:
  - { node_id: gather, kind: agent, recipe: 'cmd:gather', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: gather, on: outcome, map: { ok: done, fail: failed, error: failed } }
`);
    const markdown = renderGraphAnatomy({ graphsRoot: root, commit: COMMIT, generatedAt: GENERATED_AT });
    expect(markdown).toContain('announce-loop');
    expect(markdown).toContain('gather → failed (fail)');
    expect(markdown).not.toContain("'failed' 는 선언된 노드가 아니다");
    expect(markdown).not.toContain('recipe 가 없다');
    expect(markdown).not.toContain('recipes.yaml/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const PREV: AnatomySnapshot = {
  generatedAt: '2026-10-04T00:00:00.000Z',
  commit: 'prev',
  graphs: { 'sample-loop': ['alpha', 'beta'], 'gone-loop': ['only'] },
};
const NEXT: AnatomySnapshot = {
  generatedAt: GENERATED_AT,
  commit: COMMIT,
  graphs: { 'sample-loop': ['alpha', 'beta', 'gamma'], 'fresh-loop': ['start'] },
};

describe('diffAnatomy', () => {
  test('더해진 그래프·노드와 빠진 그래프·노드를 graph_id/nodeId 로 낸다', () => {
    const diff = diffAnatomy(PREV, NEXT);
    expect(diff.addedGraphs).toEqual(['fresh-loop']);
    expect(diff.removedGraphs).toEqual(['gone-loop']);
    // A new or removed graph lists its nodes too (ACP must-fix).
    expect(diff.addedNodes).toEqual(['fresh-loop/start', 'sample-loop/gamma']);
    expect(diff.removedNodes).toEqual(['gone-loop/only']);
  });

  test('같은 스냅샷이면 네 목록이 모두 비다', () => {
    const diff = diffAnatomy(PREV, PREV);
    expect(diff.addedGraphs).toEqual([]);
    expect(diff.removedGraphs).toEqual([]);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
  });
});

describe('main --out 어제 대비', () => {
  const script = join(import.meta.dir, 'generate-graph-anatomy.ts');
  const THREE = TWO_NODE.replace(
    '  - node_id: beta\n    kind: gate\n    recipe: cmd:beta\n    max_visits: 1\n',
    '  - node_id: beta\n    kind: gate\n    recipe: cmd:beta\n    max_visits: 1\n  - node_id: gamma\n    kind: observe\n    recipe: cmd:gamma\n    max_visits: 1\n',
  ).replace('terminal_nodes: [beta]', 'terminal_nodes: [beta, gamma]').replace(
    '  - from: alpha\n    to: beta\n',
    '  - from: alpha\n    to: beta\n  - from: beta\n    to: gamma\n',
  );

  function runMain(graphs: string, out: string, repo: string): string {
    const result = spawnSync('bun', [script, '--graphs', graphs, '--out', out, '--repo', repo], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(out, 'utf8');
  }

  test('첫 판은 «이전 판 없음», 노드를 더한 둘째 판은 + graph_id/nodeId 한 줄과 json 에 그 nodeId', () => {
    const graphs = mkdtempSync(join(tmpdir(), 'graph-anatomy-main-'));
    const outDir = mkdtempSync(join(tmpdir(), 'graph-anatomy-out-'));
    const out = join(outDir, 'a.md');
    try {
      writeFileSync(join(graphs, 'sample.yaml'), TWO_NODE);
      const first = runMain(graphs, out, graphs);
      expect(first).toContain('## 어제 대비');
      expect(first).toContain('이전 판 없음(첫 생성)');
      const firstJson = JSON.parse(readFileSync(`${out}.json`, 'utf8')) as AnatomySnapshot;
      expect(firstJson.graphs['sample-loop']).toEqual(['alpha', 'beta']);
      expect(firstJson.graphs['sample-loop']).not.toContain('gamma');

      writeFileSync(join(graphs, 'sample.yaml'), THREE);
      const second = runMain(graphs, out, graphs);
      const yesterday = second.split('## 표 1')[0] ?? '';
      expect(yesterday).toContain('## 어제 대비');
      expect(yesterday).toContain('+ sample-loop/gamma');
      expect(yesterday).not.toContain('변화 없음');
      const secondJson = JSON.parse(readFileSync(`${out}.json`, 'utf8')) as AnatomySnapshot;
      expect(secondJson.graphs['sample-loop']).toContain('gamma');
    } finally {
      rmSync(graphs, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('git 이 없는 디렉토리를 뿌리로 하면 commit 이 «(설치본 v» 로 시작하고 죽지 않는다', () => {
    const graphs = mkdtempSync(join(tmpdir(), 'graph-anatomy-nongit-'));
    const outDir = mkdtempSync(join(tmpdir(), 'graph-anatomy-nongit-out-'));
    try {
      writeFileSync(join(graphs, 'package.json'), '{"name":"installed","version":"9.9.9"}\n');
      writeFileSync(join(graphs, 'sample.yaml'), TWO_NODE);
      const markdown = runMain(graphs, join(outDir, 'a.md'), graphs);
      expect(markdown).toContain('commit: (설치본 v9.9.9)');
    } finally {
      rmSync(graphs, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

test('graphs/doc-gen/doc-gen.yaml 을 graph run --dry-run 이 경로로 미리 보여 준다', () => {
  const bin = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
  const graph = join(import.meta.dir, '..', '..', 'graphs', 'doc-gen', 'doc-gen.yaml');
  const result = spawnSync('bun', [bin, '--test', 'graph', 'run', graph, '--dry-run'], { encoding: 'utf8' });
  const text = `${result.stdout}\n${result.stderr}`;
  expect(result.status, text).toBe(0);
  expect(text).toContain('doc-gen-daily');
  expect(text).toMatch(/generate\s*→\s*done/);
});
