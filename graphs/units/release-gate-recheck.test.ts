import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveUnit, runGraph, validateUnitCalls } from '../../src/graph-runner/runner';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml';
import { prepareGateRecheck } from '../../scripts/release-loop/gate-recheck-plan-node';

const unitPath = join(import.meta.dir, 'release-gate-recheck.yaml');

test('ARG-UNIT-LIB: release gate recheck resolves and matches a bounded done/failed call', () => {
  const unit = resolveUnit('release-gate-recheck@1', join(import.meta.dir, '..', 'release', 'release-loop.yaml'));
  expect(unit.path).toBe(unitPath);
  expect(unit.template.unit?.exits).toEqual(['done', 'failed']);
  const source = readFileSync(unitPath, 'utf8');
  expect(parseGraphTemplateYaml(source, unitPath).errors).toEqual([]);
  const call = { graphId: 'test-parent', version: 1, entryNode: 'invoke', terminalNodes: ['done', 'failed'],
    nodes: [
      { nodeId: 'invoke', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: 'release-gate-recheck@1',
        budget: { innerSteps: 3 }, contract: { inputs: unit.template.unit!.inputs, outputs: unit.template.unit!.outputs, tools: 'read-only' } },
      { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
      { nodeId: 'failed', kind: 'gate', recipe: 'none', maxVisits: 1 },
    ],
    edges: [{ from: 'invoke', on: 'outcome', map: { done: 'done', failed: 'failed' } }],
  } as const;
  expect(validateUnitCalls(call as unknown as Parameters<typeof validateUnitCalls>[0], join(import.meta.dir, '..', 'release', 'release-loop.yaml')).get('invoke')?.path).toBe(unitPath);
});

test('ARG-UNIT-LIB: shadow plan reports done only after a same-commit failed-file plan is written', () => {
  const sha = 'a'.repeat(40);
  const root = mkdtempSync(join(tmpdir(), 'release-gate-unit-'));
  try {
    const input = { version: '0.2.30', commit: sha, measuredCommit: sha,
      failures: ['src/x.test.ts > failed'], errors: [], ledgerRoot: root };
    const failed = prepareGateRecheck(input, () => false);
    expect(failed).toMatchObject({ outcome: 'fail', planPath: null, files: [] });
    const planned = prepareGateRecheck(input, () => true);
    expect(planned).toMatchObject({ outcome: 'ok', files: ['src/x.test.ts'] });
    if (planned.outcome === 'ok') expect(readFileSync(planned.planPath, 'utf8')).toContain('"kind": "recheck"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ARG-UNIT-LIB: the checked-in YAML and recipe execute cmd:plan on the measured commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-yaml-live-'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' });
  expect(head.status).toBe(0);
  const commit = head.stdout.trim();
  try {
    const run = await runGraph(unitPath, {
      input: { version: '0.2.30', commit, measuredCommit: commit,
        failures: ['graphs/units/release-gate-recheck.test.ts > failed'], errors: [], ledgerRoot: root },
      deps: { root },
    });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['plan', 'done']);
    expect(run.nodes[0]?.executed).toBe(true);
    expect(run.nodes[0]?.output).toContain('"outcome":"ok"');
    const plan = JSON.parse(readFileSync(join(root, 'release', '0.2.30', 'gate-partial.json'), 'utf8'));
    expect(plan).toMatchObject({ kind: 'recheck', priorCommit: commit, forCommit: commit,
      files: ['graphs/units/release-gate-recheck.test.ts'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
