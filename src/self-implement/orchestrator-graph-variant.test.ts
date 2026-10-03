import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { runLedgerPath } from './run-ledger.js';

const root = mkdtempSync(join(tmpdir(), 'orchestrator-graph-variant-'));
const previous = process.env.ELANOUS_STATE_DIR;
beforeAll(() => { process.env.ELANOUS_STATE_DIR = root; });
afterAll(() => {
  if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const runId = (digit: string) => `run-${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;

test('orchestrator executes two validated run-local variants and writes distinct graphs beside their ledgers', async () => {
  const paths: string[] = [];
  for (const [index, visits] of [5, 7].entries()) {
    const id = runId(String(index + 1));
    const entries: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await runSelfImplement({
      runId: id, feature: `variant fixture ${index}`, memory: false, completion: 'worktree-only',
      graphOverlays: [], graphVariantPlan: { maxVisits: { implement: visits } },
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        writeRunLedger: entry => { entries.push({ event: entry.event, data: entry.data }); },
        implement: async () => ({ ok: true, summary: 'fake implementation' }),
      }),
    });
    expect(result.runId).toBe(id);
    expect(result.ok).toBe(true);
    expect(entries.map(entry => entry.event)).toContain('graph-authority-resolved');
    expect(entries.find(entry => entry.event === 'graph-variant-applied')?.data).toMatchObject({ graphId: 'self-implement', graphFile: `${runLedgerPath(id)}.graph.yaml` });
    const { graphVersionHash } = await import('./graph-yaml.js');
    const savedVariant = parseYaml(readFileSync(`${runLedgerPath(id)}.graph.yaml`, 'utf8'));
    const { parseGraphTemplateYaml } = await import('./graph-yaml.js');
    const parsed = parseGraphTemplateYaml(readFileSync(`${runLedgerPath(id)}.graph.yaml`, 'utf8'));
    expect(parsed.errors).toEqual([]);
    expect(savedVariant.nodes.find((node: { node_id: string }) => node.node_id === 'implement').max_visits).toBe(visits);
    expect(entries.find(entry => entry.event === 'graph-run-contract-resolved')?.data.graphVersion).toBe(graphVersionHash(parsed.template!));
    expect(entries.some(entry => entry.event === 'graph-visit-budget' && entry.data.node === 'implement' && entry.data.maxVisits === visits)).toBe(true);
    const path = `${runLedgerPath(id)}.graph.yaml`;
    paths.push(path);
    expect(existsSync(path)).toBe(true);
    const saved = parseYaml(readFileSync(path, 'utf8'));
    expect(saved.nodes.find((node: { node_id: string }) => node.node_id === 'implement').max_visits).toBe(visits);
    expect(saved.graph_id).toBe('self-implement');
  }
  expect(readFileSync(paths[0]!, 'utf8')).not.toBe(readFileSync(paths[1]!, 'utf8'));
}, 30_000);

test('orchestrator rejects an invalid variant before a worktree is created or graph file is written', async () => {
  const id = runId('3');
  let worktrees = 0;
  await expect(runSelfImplement({
    runId: id, feature: 'invalid variant fixture', memory: false, completion: 'worktree-only',
    graphOverlays: [], graphVariantPlan: { routes: [{ from: 'review', outcome: 'invented', to: 'merge' }] },
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({ createWorktree: async () => { worktrees++; throw new Error('must not create a worktree'); } }),
  })).rejects.toThrow('graph variant rejected');
  expect(worktrees).toBe(0);
  expect(existsSync(`${runLedgerPath(id)}.graph.yaml`)).toBe(false);
}, 30_000);
