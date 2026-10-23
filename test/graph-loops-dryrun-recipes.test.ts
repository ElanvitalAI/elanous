import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateUnitCalls } from '../src/graph-runner/runner';
import { parseGraphTemplateYaml } from '../src/self-implement/graph-yaml';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'bin', 'elanous.mjs');
const LOOPS = ['default', 'research', 'document', 'operate'] as const;

interface DryRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function dryRunLoop(name: string): DryRunResult {
  const proc = Bun.spawnSync({
    cmd: [
      'bun',
      CLI,
      '--test',
      'graph',
      'run',
      join(ROOT, 'graphs', `${name}-loop.yaml`),
      '--dry-run',
      '--json',
    ],
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

describe('four loop recipes wiring · dry-run rc0', () => {
  test('each loop dry-runs rc0 to landed with the shared recipes bundle', () => {
    const recipesShas: string[] = [];
    for (const name of LOOPS) {
      const proc = dryRunLoop(name);
      if (proc.exitCode !== 0) {
        throw new Error(`${name}-loop dry-run exit=${proc.exitCode}: ${proc.stderr.slice(-400) || proc.stdout.slice(-400)}`);
      }
      expect(proc.exitCode).toBe(0);
      const run = lastJsonLine(proc.stdout);
      expect(run.graphId).toBe(`${name}-loop`);
      expect(run.status).toBe('done');
      expect(run.dryRun).toBe(true);
      expect(run.executed).toBe(0);
      expect(run.path.at(-1)).toBe('landed');
      const sha: unknown = run.graphSnapshot?.recipesSha;
      expect(typeof sha).toBe('string');
      expect(sha as string).toMatch(/^[0-9a-f]{64}$/);
      recipesShas.push(sha as string);
    }
    if (new Set(recipesShas).size !== 1) {
      throw new Error(`four loops resolved different recipes bundles: ${recipesShas.join(', ')}`);
    }
    expect(new Set(recipesShas).size).toBe(1);
  }, 120_000);

  test('default-loop recover@1: a merge land-refusal drives the checked-in recover unit through the production graph CLI', () => {
    // Wiring — the same production load path the graph CLI uses (real parser +
    // real unit-call validator), not a source-string scan:
    const path = join(ROOT, 'graphs', 'default-loop.yaml');
    const parsed = parseGraphTemplateYaml(readFileSync(path, 'utf8'), path);
    expect(parsed.errors).toEqual([]);
    const graph = parsed.template!;
    expect(graph.edges.find((edge) => edge.from === 'merge')?.map).toMatchObject({
      merged: 'cleanup', 'land-refused': 'recover',
    });
    expect(graph.edges.find((edge) => edge.from === 'cleanup')?.to).toBe('landed');
    expect(validateUnitCalls(graph, path).get('recover')?.template.graphId).toBe('recover');
    expect(graph.edges.find((edge) => edge.from === 'recover')?.map).toMatchObject({
      done: 'cleanup', rework: 'merge', 'needs-human': 'stopped', failed: 'stopped',
    });
    // Real run — the exact recover@1 unit executed through the production
    // entry point with a land refusal (gate-host-busy) as the failed step:
    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        CLI,
        '--test',
        'graph',
        'run',
        join(ROOT, 'graphs', 'units', 'recover.yaml'),
        '--input',
        JSON.stringify({
          ask: 'Classify the PR landing refusal',
          context: {
            refusal: '✗ heavy-remote: 원격 게이트 gate-host-busy',
            pr: 29103,
            head: 'a'.repeat(40),
          },
        }),
        '--json',
      ],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      throw new Error(`recover unit run exit=${proc.exitCode}: ${proc.stderr.toString().slice(-400) || proc.stdout.toString().slice(-400)}`);
    }
    const run = lastJsonLine(proc.stdout.toString());
    expect(run.graphId).toBe('recover');
    expect(run.status).toBe('done');
    expect(run.dryRun).toBe(false);
    expect(run.executed).toBe(1);
    expect(run.path).toEqual(['plan', 'rework']);
    const planNode = run.nodes.find((node: { nodeId: string }) => node.nodeId === 'plan');
    expect(planNode?.executed).toBe(true);
    expect(planNode?.exit).toBe(0);
    const plan = JSON.parse(String(planNode?.output));
    expect(plan).toMatchObject({
      outcome: 'rework',
      result: { action: 'wait-retry', pr: 29103, head: 'a'.repeat(40) },
      evidence: { label: 'gate-host-busy', route: 'next-move', source: 'graph' },
    });
  }, 60_000);
});
