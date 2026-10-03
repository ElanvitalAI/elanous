import { setDefaultTimeout, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const documentPath = `${import.meta.dir}/../docs/RESEARCH-graph-promotion-first-live-run-2026-09-08.md`;
const runId = 'run-16dbf868-4e60-4547-bdab-15a9e6643bee';
const cutoff = '2026-09-07T22:51:16.552Z';

interface LedgerRow {
  timestamp: string;
  event: string;
  data: Record<string, unknown>;
}

async function measuredRows(): Promise<LedgerRow[]> {
  const proc = Bun.spawn([
    'bun', 'bin/elanous.mjs', '--test', 'self', 'run-ledger', runId, '--all', '--include-test', '--json',
  ], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode, stderr).toBe(0);
  const all = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerRow);
  const end = all.findIndex((row) => row.timestamp === cutoff && row.event === 'repeat-count');
  expect(end).toBeGreaterThanOrEqual(0);
  return all.slice(0, end + 1);
}

// Requires the 2026-09-08 live run ledger; rerun on a machine with that run's state dir.
const ledgerPath = join(process.env.ELANOUS_STATE_DIR ?? join(homedir(), '.elanous'), 'run-ledger', `${runId}.jsonl`);
test.skipIf(!existsSync(ledgerPath))('research graph promotion record matches the cutoff run-ledger projection', async () => {
  const documentText = await Bun.file(documentPath).text();
  const rows = await measuredRows();
  const observedNodes = rows.filter((row) => row.event === 'pipeline-node-entry').map((row) => String(row.data.node));
  const graph = rows.find((row) => row.event === 'pipeline-node-entry')?.data;
  const skipped = rows.filter((row) => row.event === 'gate-skipped-by-graph').map((row) => row.data);
  const lastIncluded = rows.at(-1);

  expect(documentText).toContain(`runId: \`${runId}\``);
  expect(documentText).toContain(`관측 컷오프: \`${cutoff}\``);
  expect(documentText).toContain(`self run-ledger ${runId} --all --include-test --json`);
  expect(lastIncluded).toMatchObject({ timestamp: cutoff, event: 'repeat-count' });
  expect(observedNodes).toEqual(['investigate', 'judge', 'investigate', 'investigate', 'judge']);
  const documentedNodes = documentText.match(/`observedNodes`는 다음과 같다\.\n\n```json\n([^\n]+)\n```/)?.[1];
  expect(documentedNodes).toBeDefined();
  expect(JSON.parse(documentedNodes!)).toEqual(observedNodes);
  expect(graph).toMatchObject({ graphId: 'self-implement', graphVersion: 'a986368aa660fe3f', node: 'investigate' });
  expect(documentText).toContain(`\"graphId\":\"${graph?.graphId}\"`);
  expect(documentText).toContain(`\"graphVersion\":\"${graph?.graphVersion}\"`);
  expect(skipped).toHaveLength(2);
  expect(skipped.every((row) => row.graphAuthoritative === true && row.graphAuthoritativeSource === 'config' && row.activeGraphId === 'research-loop')).toBe(true);
  expect(documentText).toContain('`gate-skipped-by-graph`가 2건이다');
  expect(documentText).toContain('`gate` 진입: **아니오 (0/1)**');
  expect(documentText).toContain('`investigate` 진입: **예 (1/1)**');
  expect(documentText).toContain('| `gate` 진입 | 0 | 1 | 0 |');
  expect(documentText).toContain('| `investigate` 진입 | 1 | 1 | 0 |');
  expect(documentText).toContain('같은 타임스탬프의 뒤 행과 뒤에 추가될 `open-pr`·`merge` 또는 다른 이벤트는 이번 최초 표본에서 제외된다');
  expect(documentText).toContain('REFUTE: NONE');
});
