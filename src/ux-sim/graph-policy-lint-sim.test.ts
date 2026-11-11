import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const safeGraph = `apiVersion: elanous.dev/graph/v2
graph: { id: lint-demo, version: 1.0.0, layer: flow, purpose: lint demo }
entry: begin
nodes:
  - id: begin
    type: store
    with: { op: list, collection: demo }
  - id: done
    type: store
    with: { op: list, collection: demo }
edges: [{ from: begin, to: done }]
terminal: [done]
`;
const legacyGraph = join(import.meta.dir, '../../graphs/video/video-production-pipeline.declaration.yaml');

test('GRAPH-POLICY-LINT sim: declaration checker accepts safe v2 and rejects lowerGraphV2 safety restrictions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-policy-lint-sim-'));
  try {
    const file = join(dir, 'graph.yaml');
    const lint = (source: string, ...args: string[]) => {
      writeFileSync(file, source);
      return spawnSync('bun', ['scripts/check-graph-declaration.ts', file, ...args], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8',
      });
    };

    const safe = lint(safeGraph);
    expect(safe.status).toBe(0);
    expect(safe.stdout).toContain('✅ 파싱됨');

    const mixed = lint(safeGraph, legacyGraph);
    expect(mixed.status).toBe(0);
    expect(mixed.stdout).toContain('graph.yaml');
    expect(mixed.stdout).toContain('video-production-pipeline.declaration.yaml');

    const wrongVersion = lint(safeGraph.replace('elanous.dev/graph/v2', 'elanous.dev/graph/v1'));
    expect(wrongVersion.status).toBe(1);
    expect(wrongVersion.stdout).toContain('파싱 실패');
    const malformed = lint('apiVersion: [\n');
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toContain('파싱 실패');

    const indexed = lint(safeGraph, '--index');
    expect(indexed.status).toBe(0);
    expect(indexed.stdout).toContain('begin');
    const overlayDir = join(dir, 'overlays');
    mkdirSync(overlayDir);
    writeFileSync(join(overlayDir, 'lint.yaml'), `overlay_id: lint-overlay
target: lint-demo
stage: runtime
applies_when: selected_demo >= 1
patch:
  - op: replace
    path: /nodes/0/maxVisits # begin
    value: 2
`);
    const withOverlay = lint(safeGraph, '--index', '--check-overlays', overlayDir);
    expect(withOverlay.status).toBe(0);
    expect(withOverlay.stdout).toContain('lint.yaml — /nodes/0 = begin');

    const denied = [
      { name: 'cap', source: safeGraph.replace('entry: begin', 'cap: L1\nentry: begin'), path: '/cap' },
      { name: 'allow', source: safeGraph.replace('terminal: [done]', 'allow: { skills: [demo/*] }\nterminal: [done]'), path: '/allow' },
      { name: 'hitl', source: safeGraph.replace('terminal: [done]', 'policy: { hitl: [approve] }\nterminal: [done]'), path: '/policy/hitl' },
      { name: 'forbid recipes', source: safeGraph.replace('terminal: [done]', 'policy: { forbid_recipes: [unsafe] }\nterminal: [done]'), path: '/policy' },
      { name: 'ext bypass', source: safeGraph.replace('purpose: lint demo', 'purpose: lint demo, ext: { acme.cap_override: true }'), path: '/ext' },
    ];
    for (const scenario of denied) {
      const result = lint(scenario.source);
      expect(result.status, scenario.name).toBe(1);
      expect(result.stdout, scenario.name).toContain(scenario.path);
      const expectedMessage = scenario.name === 'ext bypass' ? '금지된다'
        : scenario.name === 'hitl' ? 'policy.hitl 과 type: hitl 노드 목록은 정확히 같아야 한다' : '안전 거부';
      expect(result.stdout, scenario.name).toContain(expectedMessage);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
