import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { triageInputHash } from './triage-budget.js';

const repo = resolve(import.meta.dir, '../..');
const cli = join(repo, 'bin/elanous.mjs');
const graph = join(repo, 'graphs/steward/steward.yaml');
const issues = [
  { identifier: 'ELA-81', ref: 'ref-81', title: 'same task', body: 'same body' },
  { identifier: 'ELA-82', ref: 'ref-82', title: 'same task', body: 'same body' },
];

async function command(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, NODE_ENV: 'development' }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('spawned steward graph and node scripts store decision rows in isolated logs.db for CLI lookup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'steward-graph-logs-'));
  try {
    const dir = join(root, 'graphs', 'steward');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(repo, 'src'), join(root, 'src'));
    const installed = parse(readFileSync(graph, 'utf8')) as { nodes: Array<{ node_id: string; recipe?: string }> };
    const recipes = parse(readFileSync(join(repo, 'graphs/steward/recipes.yaml'), 'utf8')) as Record<string, { command: string; timeout_ms: number }>;
    const stages = ['sync', 'triage', 'schedule', 'report'] as const;
    expect(installed.nodes.filter(node => stages.includes(node.node_id as typeof stages[number])).map(node => [node.node_id, node.recipe])).toEqual(
      stages.map(name => [name, `cmd:steward-${name}`]));
    for (const name of stages) expect(recipes[`steward-${name}`]?.command).toContain(`src/steward/triage.ts\" ${name}`);
    writeFileSync(join(dir, 'steward.yaml'), readFileSync(graph));
    // Preserve the installed graph and recipe commands, adding only an offline preload to each node process.
    const preload = join(root, 'offline.ts');
    writeFileSync(preload, `import { mock } from 'bun:test';
const secrets = await import(${JSON.stringify(join(repo, 'src/nexus/config/secrets/index.ts'))});
mock.module(${JSON.stringify(join(repo, 'src/nexus/config/secrets/index.ts'))}, () => ({ ...secrets, getSecretAsync: async () => 'isolated-key' }));
globalThis.fetch = async (_url, init) => {
  const { query } = JSON.parse(String(init?.body));
  if (query.includes('commentCreate(')) return Response.json({ data: { commentCreate: { success: true } } });
  if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: ${JSON.stringify(issues.map(issue => ({ id: issue.ref, identifier: issue.identifier, title: issue.title, description: issue.body, url: '', priority: 2, updatedAt: '2026-10-04T00:00:00Z', state: { type: 'started' } })))}, pageInfo: { hasNextPage: false, endCursor: null } } } });
  throw new Error('unexpected external request');
};
const outbound = await import(${JSON.stringify(join(repo, 'src/domains/outbound-alert.ts'))});
mock.module(${JSON.stringify(join(repo, 'src/domains/outbound-alert.ts'))}, () => ({ ...outbound, deliver: () => true }));
`);
    writeFileSync(join(dir, 'recipes.yaml'), stringify(Object.fromEntries(stages.map(name => [
      `steward-${name}`, { ...recipes[`steward-${name}`], command: `bun --preload ${JSON.stringify(preload)} ${recipes[`steward-${name}`]!.command.slice(4)}` },
    ]))));
    const isolated = join(root, '.elanous-test');
    const stateDir = join(isolated, 'steward');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'triage.json'), JSON.stringify([{ issue: issues[0]!.identifier, rung: 4, dependsOn: [], priority: 1,
      why: 'cached', inputHash: triageInputHash(issues[0]!, issues) }]));
    const run = await command(['bun', cli, `--test=${isolated}`, 'graph', 'run', join(dir, 'steward.yaml'), '--json'], root);
    expect(run.code, `${run.stderr}\n${run.stdout}`).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { status: string; path: string[] };
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['sync', 'triage', 'schedule', 'report', 'done']);
    expect(existsSync(join(isolated, 'logs', 'logs.db')), run.stdout).toBe(true);
    const tickLookup = await command(['bun', cli, `--test=${isolated}`, 'logs', '--category', 'loop.steward', '--event', 'decision', '--json', '--json-data', '--limit', '20'], root);
    expect(tickLookup.code, `${tickLookup.stderr}\n${tickLookup.stdout}`).toBe(0);
    const tickRows = tickLookup.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { category?: string; event?: string; data?: { verdict: string; reason: string; goalId?: string } });
    expect(tickRows.filter(row => row.category === 'loop.steward' && row.event === 'decision').map(row => [row.data?.verdict, row.data?.reason, row.data?.goalId])).toEqual([
      ['reported', 'daily digest sent', undefined],
    ]);
    const lookup = await command(['bun', cli, `--test=${isolated}`, 'logs', '--category', 'steward.', '--event', 'decision', '--json', '--json-data', '--limit', '20'], root);
    expect(lookup.code, `${lookup.stderr}\n${lookup.stdout}`).toBe(0);
    const records = lookup.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { category?: string; event?: string; data?: { kind: string; target: string; wouldAct: boolean } });
    const decisions = records.filter(row => row.event === 'decision');
    expect(decisions.map(row => [row.category, row.data?.kind, row.data?.target, row.data?.wouldAct]).sort()).toEqual([
      ['steward.triage', '0', 'ELA-82', false],
      ['steward.schedule', 'now', 'ELA-81', false],
      ['steward.schedule', 'wait', 'ELA-82', false],
    ].sort());
    const triageLookup = await command(['bun', cli, `--test=${isolated}`, 'logs', '--category', 'steward.triage', '--event', 'decision', '--json', '--json-data', '--limit', '20'], root);
    expect(triageLookup.code, `${triageLookup.stderr}\n${triageLookup.stdout}`).toBe(0);
    const triageRows = triageLookup.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { category?: string; event?: string });
    expect(triageRows.filter(row => row.category === 'steward.triage' && row.event === 'decision')).toHaveLength(1);
    const distribution = await command(['bun', cli, `--test=${isolated}`, 'logs', 'fields', '--exact-category', 'steward.triage', '--event', 'decision', '--values', '10'], root);
    expect(distribution.code, `${distribution.stderr}\n${distribution.stdout}`).toBe(0);
    const fields = distribution.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { category?: string; event?: string; field?: string; total?: number; values?: Array<{ value: string; n: number }> });
    expect(fields.find(row => row.category === 'steward.triage' && row.event === 'decision' && row.field === 'kind')).toMatchObject({ total: 1, values: [{ value: '0', n: 1 }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
