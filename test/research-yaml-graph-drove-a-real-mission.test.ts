import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const documentPath = `${import.meta.dir}/../docs/RESEARCH-yaml-graph-drove-a-real-mission-2026-09-08.md`;
const graphPath = `${import.meta.dir}/../graphs/research-loop.yaml`;
const runId = 'run-16dbf868-4e60-4547-bdab-15a9e6643bee';
const goalId = 'f0c2064644ab2cc7';

interface LedgerRow {
  event: string;
  data: Record<string, unknown>;
}

async function measuredRows(): Promise<LedgerRow[]> {
  const proc = Bun.spawn([
    'bun', 'bin/elanous.mjs', '--test', 'self', 'run-ledger', runId, '--all', '--include-test', '--json',
  ], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerRow);
}

// Requires the 2026-09-08 live run ledger; rerun on a machine with that run's state dir.
const ledgerPath = join(process.env.ELANOUS_STATE_DIR ?? join(homedir(), '.elanous'), 'run-ledger', `${runId}.jsonl`);
test.skipIf(!existsSync(ledgerPath))('YAML graph research record preserves the real run ledger values and mismatch', async () => {
  const [documentText, graphText, rows] = await Promise.all([
    Bun.file(documentPath).text(),
    Bun.file(graphPath).text(),
    measuredRows(),
  ]);
  const nodes = rows.filter((row) => row.event === 'pipeline-node-entry').map((row) => String(row.data.node));
  const entries = rows.filter((row) => row.event === 'pipeline-node-entry').map((row) => row.data);
  const skips = rows.filter((row) => row.event === 'gate-skipped-by-graph').map((row) => row.data);

  expect(graphText).toContain('graph_id: research-loop');
  expect(graphText).toContain('version: 5');
  expect(documentText).toContain(`완료 런 \`${runId}\` (GoalId \`${goalId}\`)`);
  expect(documentText).toContain(`self run-ledger ${runId} --all --include-test --json`);
  expect(nodes).toEqual(['investigate', 'judge', 'investigate', 'investigate', 'judge', 'investigate', 'investigate', 'judge', 'main-sync', 'regate', 'open-pr', 'merge']);
  expect(documentText).toContain(JSON.stringify(nodes));
  expect(entries).toHaveLength(12);
  expect(entries.every((entry) => entry.graphId === 'self-implement' && entry.graphVersion === 'a986368aa660fe3f')).toBe(true);
  expect(documentText).toContain('`graphId=self-implement`, `graphVersion=a986368aa660fe3f`');
  expect(documentText).toContain('`graph_id=research-loop`, `version=5`와 일치하지 않는다');
  expect(skips).toHaveLength(3);
  expect(skips).toEqual([
    { graphAuthoritative: true, graphAuthoritativeSource: 'config', activeGraphId: 'research-loop', round: 0, runId, goalId },
    { graphAuthoritative: true, graphAuthoritativeSource: 'config', activeGraphId: 'research-loop', round: 1, runId, goalId },
    { graphAuthoritative: true, graphAuthoritativeSource: 'config', activeGraphId: 'research-loop', round: 2, runId, goalId },
  ]);
  expect(documentText).toContain('`gate-skipped-by-graph` 3건의 원문 `data`');
  expect(documentText).toContain('`gate-skipped-by-graph.data.activeGraphId=research-loop` 3/3');
  expect(documentText).toContain('REFUTE: NONE');
});
