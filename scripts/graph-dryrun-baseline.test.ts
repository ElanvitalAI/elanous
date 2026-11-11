import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = join(import.meta.dir, 'graph-dryrun-baseline.ts');

describe('graph dry-run baseline entrypoint', () => {
  test('runs a selected graph, pins a checkout root and reports changed condition with rc 1', () => {
    const temp = mkdtempSync(join(tmpdir(), 'graph-baseline-contract-'));
    const checkoutA = join(temp, 'checkout-a');
    const checkoutB = join(temp, 'checkout-b');
    const unrelatedCwd = join(temp, 'caller-cwd');
    const baselinePath = join(temp, 'baseline.json');
    for (const checkout of [checkoutA, checkoutB]) {
      mkdirSync(checkout, { recursive: true });
      for (const name of ['graphs', 'samples/workflows', 'workflows']) cpSync(join(root, name), join(checkout, name), { recursive: true });
      symlinkSync(join(root, 'src'), join(checkout, 'src'), 'dir');
    }
    mkdirSync(unrelatedCwd, { recursive: true });
    const args = ['--only-graph', 'graphs/demo/inside-seed.yaml'];
    const run = (checkout: string, extra: string[] = []) => spawnSync(process.execPath,
      [script, '--root', checkout, ...args, ...extra], {
        cwd: unrelatedCwd,
        encoding: 'utf8',
        // Source: .rules/30-harness/testing-gates.md R-TST36 · bound for graph inventory and dry-run fixture work.
        timeout: 60_000,
        // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded JSON output from graph inventory.
        maxBuffer: 4 * 1024 * 1024,
      });
    try {
      const base = run(checkoutA);
      expect(base.status).toBe(0);
      const result = JSON.parse(base.stdout) as {
        fiveConditions: Record<string, unknown> & { dryRun: Array<{ terminal: string }> };
        inventory: { graphRuns: Array<Record<string, unknown>> };
      };
      expect(Object.keys(result.fiveConditions).sort()).toEqual(['canonicalAndHash', 'declarationErrors', 'dryRun', 'loops', 'workflowValidation']);
      expect(result.inventory.graphRuns[0]).toMatchObject({ path: 'graphs/demo/inside-seed.yaml', kind: 'graph', rc: 0, terminal: 'done' });
      expect(result.inventory.graphRuns[0]?.runPath).toEqual(['plan', 'build', 'review', 'publish', 'done']);
      writeFileSync(baselinePath, JSON.stringify(result));
      const pristineBaseline = JSON.stringify(result);

      const same = run(checkoutB, ['--compare', baselinePath]);
      expect(same.status).toBe(0);
      expect(same.stdout).toContain('GRAPH-DRYRUN-BASELINE same');

      result.fiveConditions.dryRun[0]!.terminal = 'changed-fixture';
      writeFileSync(baselinePath, JSON.stringify(result));
      const changed = run(checkoutB, ['--compare', baselinePath]);
      expect(changed.status).toBe(1);
      expect(changed.stdout).toContain('GRAPH-DRYRUN-BASELINE changed: dryRun@');

      for (const condition of ['declarationErrors', 'canonicalAndHash', 'loops', 'workflowValidation']) {
        const baselineResult = JSON.parse(pristineBaseline) as { fiveConditions: Record<string, unknown> };
        baselineResult.fiveConditions[condition] = [...(baselineResult.fiveConditions[condition] as unknown[] ?? []), { changed: true }];
        writeFileSync(baselinePath, JSON.stringify(baselineResult));
        const conditionChanged = run(checkoutB, ['--compare', baselinePath]);
        expect(conditionChanged.status).toBe(1);
        expect(conditionChanged.stdout).toContain(`changed: ${condition}@`);
      }

      writeFileSync(join(checkoutA, 'graphs', 'invalid-yaml.yaml'), 'graph_id: [broken\n');
      // Source: isolated malformed-graph contract fixture for the following bounded process call.
      const invalid = spawnSync(process.execPath, [script, '--root', checkoutA, '--only-graph', 'graphs/invalid-yaml.yaml'],
        {
          cwd: unrelatedCwd,
          encoding: 'utf8',
          // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded time for one invalid-graph scan.
          timeout: 60_000,
          // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded JSON diagnostics.
          maxBuffer: 4 * 1024 * 1024,
        });
      expect(invalid.status).toBe(0);
      const invalidResult = JSON.parse(invalid.stdout) as { fiveConditions: { declarationErrors: Array<{ path: string; errors: unknown[] }> } };
      expect(invalidResult.fiveConditions.declarationErrors).toContainEqual(expect.objectContaining({ path: 'graphs/invalid-yaml.yaml' }));
      // Source: .rules/30-harness/testing-gates.md R-TST36 · malformed YAML must yield at least one declaration diagnostic.
      expect(invalidResult.fiveConditions.declarationErrors[0]?.errors.length).toBeGreaterThan(0);

      writeFileSync(join(checkoutA, 'graphs', 'invalid-shape.yaml'), 'graph_id: 42\nnodes: not-a-list\n');
      // Source: isolated invalid-shape contract fixture for the following bounded process call.
      const invalidShape = spawnSync(process.execPath, [script, '--root', checkoutA, '--only-graph', 'graphs/invalid-shape.yaml'],
        {
          cwd: unrelatedCwd,
          encoding: 'utf8',
          // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded time for one invalid-shape scan.
          timeout: 60_000,
          // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded JSON diagnostics.
          maxBuffer: 4 * 1024 * 1024,
        });
      expect(invalidShape.status).toBe(0);
      const shapeResult = JSON.parse(invalidShape.stdout) as { inventory: { graphs: Array<{ path: string; kind: string; errors: unknown[] }> } };
      expect(shapeResult.inventory.graphs).toContainEqual(expect.objectContaining({ path: 'graphs/invalid-shape.yaml', kind: 'graph' }));
      // Source: .rules/30-harness/testing-gates.md R-TST36 · invalid graph shape must yield at least one schema diagnostic.
      expect(shapeResult.inventory.graphs.find(row => row.path === 'graphs/invalid-shape.yaml')?.errors.length).toBeGreaterThan(0);

      // Source: isolated missing-graph contract fixture for the following bounded process call.
      const missingGraph = spawnSync(process.execPath, [script, '--root', checkoutA, '--only-graph', 'graphs/missing.yaml'],
        {
          cwd: unrelatedCwd,
          encoding: 'utf8',
          // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded time for one missing-graph validation.
          timeout: 60_000,
          // Source: .rules/30-harness/testing-gates.md R-TST36 · bounded JSON diagnostics.
          maxBuffer: 4 * 1024 * 1024,
        });
      expect(missingGraph.status).not.toBe(0);
      expect(missingGraph.stderr).toContain('--only-graph must select exactly one');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    // Source: .rules/30-harness/testing-gates.md R-TST36 · test timeout bounds the per-child command timeout.
  }, 30_000);
});
