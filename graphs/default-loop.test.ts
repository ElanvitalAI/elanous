import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateUnitCalls } from '../src/graph-runner/runner';
import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'bin', 'elanous.mjs');
const DEFAULT_LOOP = join(ROOT, 'graphs', 'default-loop.yaml');
const LOOPS = ['default', 'research', 'document', 'operate'] as const;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGraphYaml(path: string, extra: string[]): RunResult {
  const proc = Bun.spawnSync({
    cmd: ['bun', CLI, '--test', 'graph', 'run', path, ...extra],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function lastJsonLine(text: string): any {
  const lines = text.trim().split('\n').filter((line) => line.startsWith('{'));
  if (lines.length === 0) throw new Error(`no JSON line in output: ${text.slice(-400)}`);
  return JSON.parse(lines[lines.length - 1]!);
}

function loadDefaultLoop() {
  const parsed = parseGraphTemplateYaml(readFileSync(DEFAULT_LOOP, 'utf8'), DEFAULT_LOOP);
  expect(parsed.errors).toEqual([]);
  return parsed.template!;
}

describe('default-loop · four loop recipes wiring', () => {
  test('the four loops load one shared recipes bundle and each dry-runs rc0 to landed', () => {
    const recipesShas: string[] = [];
    for (const name of LOOPS) {
      const proc = runGraphYaml(join(ROOT, 'graphs', `${name}-loop.yaml`), ['--dry-run', '--json']);
      if (proc.exitCode !== 0) {
        throw new Error(`${name}-loop dry-run exit=${proc.exitCode}: ${proc.stderr.slice(-400) || proc.stdout.slice(-400)}`);
      }
      const run = lastJsonLine(proc.stdout);
      expect(run.graphId).toBe(`${name}-loop`);
      expect(run.status).toBe('done');
      expect(run.path.at(-1)).toBe('landed');
      const sha: unknown = run.graphSnapshot?.recipesSha;
      expect(typeof sha).toBe('string');
      recipesShas.push(sha as string);
    }
    expect(new Set(recipesShas).size).toBe(1);
  }, 180_000);

  test('every recipe the default loop names is wired: no orphan node, and the unit call validates', () => {
    const graph = loadDefaultLoop();
    const wired = new Set<string>();
    for (const edge of graph.edges) {
      wired.add(edge.from);
      if (edge.to) wired.add(edge.to);
      for (const target of Object.values(edge.map ?? {})) wired.add(target);
    }
    const orphans = graph.nodes
      .map((node) => node.nodeId)
      .filter((nodeId) => nodeId !== graph.entryNode && !wired.has(nodeId));
    expect(orphans).toEqual([]);
    expect(graph.nodes.every((node) => typeof node.recipe === 'string' && node.recipe.length > 0)).toBe(true);
    // The production loader resolves `call: recover@1` against the checked-in unit.
    expect(validateUnitCalls(graph, DEFAULT_LOOP).get('recover')?.template.graphId).toBe('recover');
  });
});

describe('default-loop · recover@1 integration', () => {
  test('a land refusal re-enters the landing step it aborted, and that step can reach landed', () => {
    const graph = loadDefaultLoop();

    // A refused merge hands the step to recover@1 (the unit that classifies the refusal).
    expect(graph.edges.find((edge) => edge.from === 'merge')?.map).toMatchObject({ 'land-refused': 'recover' });

    // The refusal classification really runs through the production entry point — not a source scan.
    const recover = graph.nodes.find((node) => node.nodeId === 'recover')!;
    expect(recover.call).toBe('recover@1');
    const proc = runGraphYaml(join(ROOT, 'graphs', 'units', 'recover.yaml'), [
      '--input',
      JSON.stringify({
        ask: 'Classify the PR landing refusal',
        context: { refusal: '✗ heavy-remote: 원격 게이트 gate-host-busy', pr: 29103, head: 'b'.repeat(40) },
      }),
      '--json',
    ]);
    if (proc.exitCode !== 0) {
      throw new Error(`recover unit run exit=${proc.exitCode}: ${proc.stderr.slice(-400) || proc.stdout.slice(-400)}`);
    }
    const unitRun = lastJsonLine(proc.stdout);
    expect(unitRun.graphId).toBe('recover');
    expect(unitRun.status).toBe('done');
    expect(unitRun.executed).toBe(1);
    const plan = JSON.parse(String(unitRun.nodes.find((node: { nodeId: string }) => node.nodeId === 'plan')?.output));
    expect(plan).toMatchObject({ outcome: 'rework', result: { action: 'wait-retry', pr: 29103 } });

    // That produced outcome must route back into the aborted landing step (one re-entry), not to a dead stop.
    const recoverEdge = graph.edges.find((edge) => edge.from === 'recover')!;
    const produced = plan.outcome as string;
    const next = recoverEdge.map?.[produced];
    expect(next).toBe('merge');

    // The re-entry fits the visit budget of the landing step (one retry) …
    const merge = graph.nodes.find((node) => node.nodeId === 'merge')!;
    expect(merge.maxVisits).toBeGreaterThanOrEqual(2);
    // … and a successful retry converges: merge → cleanup → landed.
    expect(graph.edges.find((edge) => edge.from === 'merge')?.map?.merged).toBe('cleanup');
    expect(graph.edges.find((edge) => edge.from === 'cleanup')?.to).toBe('landed');
    expect(graph.terminalNodes).toContain('landed');

    // A resolved refusal finishes the landing, a human/failure refusal still exits the loop.
    expect(recoverEdge.map).toMatchObject({ done: 'cleanup', 'needs-human': 'stopped', failed: 'stopped' });
  }, 60_000);

  test('default-loop dry-run ends rc0 at landed through the production graph CLI', () => {
    const proc = runGraphYaml(DEFAULT_LOOP, ['--dry-run', '--json']);
    if (proc.exitCode !== 0) {
      throw new Error(`default-loop dry-run exit=${proc.exitCode}: ${proc.stderr.slice(-400) || proc.stdout.slice(-400)}`);
    }
    const run = lastJsonLine(proc.stdout);
    expect(run.graphId).toBe('default-loop');
    expect(run.dryRun).toBe(true);
    expect(run.status).toBe('done');
    expect(run.path.at(-1)).toBe('landed');
  }, 120_000);
});
