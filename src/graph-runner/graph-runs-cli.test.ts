import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGraphCommands } from './graph-cli.js';
import { graphRunAlive, listGraphRuns, manageGraphRun, runGraph } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); process.exitCode = 0; });

function root(): string { const dir = mkdtempSync(join(tmpdir(), 'graph-runs-cli-')); roots.push(dir); return dir; }
function save(base: string, graphId: string, runId: string, startedAt: string, extra: Record<string, unknown> = {}): string {
  const dir = join(base, 'graph-runs', graphId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  writeFileSync(path, JSON.stringify({ graphId, runId, startedAt, status: 'done', path: ['first', 'done'], nodes: [
    { nodeId: 'first', ok: true, exit: 0, executed: true, output: 'noise\n{"summary":"' + 'x'.repeat(310) + '"}' },
    { nodeId: 'done', ok: true, exit: null, executed: false },
  ], executed: 1, dryRun: false, statePath: path, ...extra }));
  return path;
}

async function cli(base: string, args: string[], processStartMs: (pid: number) => number | null = () => null) {
  const out: string[] = [], err: string[] = [];
  const previousLog = console.log, previousError = console.error, previousWrite = process.stdout.write;
  console.log = (...parts) => { out.push(parts.join(' ')); };
  console.error = (...parts) => { err.push(parts.join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    out.push(String(chunk).trimEnd());
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
  try {
    const program = new Command().exitOverride();
    registerGraphCommands(program, { root: base, processStartMs });
    await program.parseAsync(['node', 'elanous', 'graph', ...args]);
    return { out, err, exit: process.exitCode };
  } finally { console.log = previousLog; console.error = previousError; process.stdout.write = previousWrite; }
}

test('list orders all graphs, filters graph/state/limit, skips non-run files and warns once without writing', async () => {
  const base = root();
  const oldest = save(base, 'release-loop', 'run-a', '2026-10-01T00:00:00.000Z');
  const newest = save(base, 'release-loop', 'run-c', '2026-10-03T00:00:00.000Z', { status: 'failed' });
  save(base, 'other-loop', 'run-b', '2026-10-02T00:00:00.000Z');
  writeFileSync(join(base, 'graph-runs', 'release-loop', 'broken.json'), '{');
  writeFileSync(`${oldest}.1.decision.json`, JSON.stringify({ nodeId: 'approve-publish', decision: 'approved', decidedAt: '2026-10-01T00:00:00.000Z' }));
  mkdirSync(`${oldest}.contexts`);
  const before = [oldest, newest].map((file) => readFileSync(file, 'utf8'));
  const listed = await cli(base, ['runs', 'list']);
  expect(listed.out).toHaveLength(3);
  expect(listed.out.map((line) => line.split(' · ')[0])).toEqual(['run-c', 'run-b', 'run-a']);
  expect(listed.err).toContain('⚠ 못 읽은 원장 1');
  expect((await cli(base, ['runs', 'list', '--graph', 'release-loop'])).out).toHaveLength(2);
  expect((await cli(base, ['runs', 'list', '--state', 'failed', '--limit', '1'])).out).toHaveLength(1);
  expect((await cli(base, ['runs', 'list', '--limit', '0'])).exit).toBe(1);
  expect([oldest, newest].map((file) => readFileSync(file, 'utf8'))).toEqual(before);
  expect(readdirSync(join(base, 'graph-runs', 'release-loop')).sort()).toEqual(['broken.json', 'run-a.json', 'run-a.json.1.decision.json', 'run-a.json.contexts', 'run-c.json']);
  expect(listGraphRuns(base).unreadable).toBe(1);
  const json = await cli(base, ['runs', 'list', '--json']);
  expect(JSON.parse(json.out[0]!)).toHaveLength(3);
  expect(json.err).toContain('⚠ 못 읽은 원장 1');
});

test('a run id ending in .decision is a ledger, not a decision claim', async () => {
  const base = root();
  save(base, 'release-loop', 'foo.decision', '2026-10-01T00:00:00.000Z');
  const listed = await cli(base, ['runs', 'list', '--json']);
  expect(JSON.parse(listed.out[0]!)).toMatchObject([{ runId: 'foo.decision', graphId: 'release-loop' }]);
  expect(listed.err).toEqual([]);
  const detail = await cli(base, ['runs', 'status', 'foo.decision', '--json']);
  expect(detail.exit).toBe(0);
  expect(JSON.parse(detail.out[0]!)).toMatchObject({ runId: 'foo.decision', graphId: 'release-loop' });
  const claimed = save(base, 'release-loop', 'foo.json.1.decision', '2026-10-02T00:00:00.000Z');
  expect((await cli(base, ['runs', 'status', 'foo.json.1.decision', '--json'])).exit).toBe(0);
  expect(listGraphRuns(base).runs.map((state) => state.runId)).toContain('foo.json.1.decision');
  writeFileSync(claimed, '{');
  expect(listGraphRuns(base).unreadable).toBe(1);
});

test('list and status skip ledgers whose saved identity disagrees with the path or lacks runId', async () => {
  const base = root();
  const valid = save(base, 'release-loop', 'run-valid', '2026-10-01T00:00:00.000Z');
  const wrongGraph = save(base, 'release-loop', 'run-wrong-graph', '2026-10-02T00:00:00.000Z', { graphId: 'other-loop' });
  const wrongRun = save(base, 'release-loop', 'run-wrong-id', '2026-10-03T00:00:00.000Z', { runId: 'run-impersonated' });
  const missingRun = save(base, 'release-loop', 'run-missing-id', '2026-10-04T00:00:00.000Z');
  const contents = JSON.parse(readFileSync(missingRun, 'utf8'));
  delete contents.runId;
  writeFileSync(missingRun, JSON.stringify(contents));
  // Even a run id resembling a decision-claim filename remains a ledger when it has run fields.
  const disguised = save(base, 'release-loop', 'run-valid.json.1.decision', '2026-10-05T00:00:00.000Z', { runId: 'run-elsewhere' });
  const before = [valid, wrongGraph, wrongRun, missingRun, disguised].map((path) => readFileSync(path, 'utf8'));
  const listed = await cli(base, ['runs', 'list', '--json']);
  expect(JSON.parse(listed.out[0]!)).toMatchObject([{ graphId: 'release-loop', runId: 'run-valid' }]);
  expect(listed.err).toEqual(['⚠ 못 읽은 원장 4']);
  for (const id of ['run-wrong-graph', 'run-wrong-id', 'run-impersonated', 'run-missing-id', 'run-valid.json.1.decision']) {
    const status = await cli(base, ['runs', 'status', id, '--json']);
    expect(status.exit).toBe(1);
    expect(status.err).toContain(`no run: ${id}`);
    expect(status.err).toContain('⚠ 못 읽은 원장 4');
  }
  const prefix = await cli(base, ['runs', 'status', 'run-', '--json']);
  expect(prefix.exit).toBe(0);
  expect(JSON.parse(prefix.out[0]!)).toMatchObject({ runId: 'run-valid' });
  expect([valid, wrongGraph, wrongRun, missingRun, disguised].map((path) => readFileSync(path, 'utf8'))).toEqual(before);
});

test('pid 1 uses the same start-time check as any other live pid', () => {
  const base = root();
  save(base, 'g', 'container-run', '2026-10-01T00:00:00.000Z', { pid: 1, pidStartedAt: '2026-10-01T00:00:00.000Z' });
  const state = listGraphRuns(base).runs[0]!;
  expect(graphRunAlive(state, (pid) => { expect(pid).toBe(1); return Date.parse(state.pidStartedAt!); })).toBe(true);
  expect(graphRunAlive(state, () => Date.parse(state.pidStartedAt!) + 60_000)).toBe(false);
});

test('alive requires pid and matching start time; old ledgers are unknown', () => {
  const base = root();
  save(base, 'g', 'legacy', '2026-10-01T00:00:00.000Z');
  save(base, 'g', 'live', '2026-10-02T00:00:00.000Z', { pid: 123, pidStartedAt: '2026-10-02T00:00:00.000Z' });
  const [live, legacy] = listGraphRuns(base).runs;
  expect(graphRunAlive(live!, () => Date.parse(live!.pidStartedAt!))).toBe(true);
  expect(graphRunAlive(live!, () => Date.parse(live!.pidStartedAt!) + 60_000)).toBe(false);
  expect(graphRunAlive(live!, () => null)).toBe(false);
  expect(graphRunAlive(legacy!, () => { throw new Error('must not probe legacy'); })).toBe('unknown');
});

test('list exposes alive=true, false and unknown with an injected pid-start lookup', async () => {
  const base = root();
  save(base, 'g', 'match', '2026-10-03T00:00:00.000Z', { pid: 123, pidStartedAt: '2026-10-01T00:00:00.000Z' });
  save(base, 'g', 'mismatch', '2026-10-02T00:00:00.000Z', { pid: 456, pidStartedAt: '2026-10-01T00:00:00.000Z' });
  save(base, 'g', 'legacy', '2026-10-01T00:00:00.000Z');
  const result = await cli(base, ['runs', 'list', '--json'], (pid) => pid === 123 ? Date.parse('2026-10-01T00:00:00.000Z') : Date.parse('2026-10-02T00:00:00.000Z'));
  expect(JSON.parse(result.out[0]!).map(({ alive }: { alive: boolean | 'unknown' }) => alive)).toEqual([true, false, 'unknown']);
});

test('status resolves a prefix, reports node summary/pending/resume/alive and rejects ambiguous ids', async () => {
  const base = root();
  save(base, 'release-loop', 'run-ab-one', '2026-10-01T00:00:00.000Z', {
    pid: 123, pidStartedAt: '2026-10-01T00:00:00.000Z',
    pending: { nodeId: 'gate', message: 'Approve?', since: '2026-10-01T00:00:00.000Z' },
    resume: { from: 'first', at: '2026-10-02T00:00:00.000Z', previousStatus: 'failed' },
  });
  save(base, 'other-loop', 'run-ab-two', '2026-10-02T00:00:00.000Z');
  const ambiguous = await cli(base, ['runs', 'status', 'run-ab']);
  expect(ambiguous.exit).toBe(1);
  expect(ambiguous.err.join('\n')).toContain('release-loop/run-ab-one');
  expect(ambiguous.err.join('\n')).toContain('other-loop/run-ab-two');
  const detail = await cli(base, ['runs', 'status', 'run-ab-one'], () => Date.parse('2026-10-01T00:00:00.000Z'));
  expect(detail.out.join('\n')).toContain('alive=true');
  expect(detail.out.join('\n')).toContain('x'.repeat(300));
  expect(detail.out.join('\n')).not.toContain('x'.repeat(301));
  expect(detail.out.join('\n')).toContain('Approve?');
  expect(detail.out.join('\n')).toContain('"from":"first"');
  const json = await cli(base, ['runs', 'status', 'run-ab-one', '--json'], () => Date.parse('2026-10-01T00:00:00.000Z'));
  expect(JSON.parse(json.out[0]!)).toMatchObject({ runId: 'run-ab-one', alive: true, nodes: [{ nodeId: 'first', ok: true, summary: 'x'.repeat(300) }, { nodeId: 'done', ok: true, summary: null }] });
  expect((await cli(base, ['runs', 'status', 'missing'])).exit).toBe(1);
});

test('status prefers an exact run id over longer prefix matches', async () => {
  const base = root();
  save(base, 'release-loop', 'foo', '2026-10-01T00:00:00.000Z');
  save(base, 'other-loop', 'foobar', '2026-10-02T00:00:00.000Z');
  const detail = await cli(base, ['runs', 'status', 'foo', '--json']);
  expect(detail.exit).toBe(0);
  expect(detail.err).toEqual([]);
  expect(JSON.parse(detail.out[0]!)).toMatchObject({ runId: 'foo', graphId: 'release-loop' });
});

test('runs resume resolves a prefix, restarts the last failed node on the snapshot and keeps preceding output', async () => {
  const base = root();
  const graph = join(base, 'graph.yaml');
  const recipes = join(base, 'recipes.yaml');
  const marker = join(base, 'marker');
  const ready = join(base, 'ready');
  writeFileSync(recipes, `first:\n  command: "printf a >> '${marker}'"\nsecond:\n  command: "test -f '${ready}' && printf b >> '${marker}'"\n`);
  writeFileSync(graph, `graph_id: resume-cli\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, to: second }\n  - { from: second, on: outcome, map: { ok: done, fail: failed } }\n`);
  const first = await runGraph(graph, { runId: 'resume-unique', deps: { root: base } });
  expect(first.path).toEqual(['first', 'second', 'failed']);
  const oldGraph = readFileSync(graph, 'utf8');
  writeFileSync(graph, oldGraph.replace('graph_id: resume-cli', 'graph_id: newly-installed-cli'));
  const current = await cli(base, ['runs', 'resume', 'resume-uni', '--use-current-graph', '--json']);
  expect(current.exit).toBe(1);
  expect(current.err.join('\n')).toContain('graph or recipes changed since failed run');
  expect(readFileSync(marker, 'utf8')).toBe('a');
  writeFileSync(ready, 'yes');
  const resumed = await cli(base, ['runs', 'resume', 'resume-uni', '--json']);
  expect(resumed.exit).toBe(0);
  expect(JSON.parse(resumed.out[0]!)).toMatchObject({ status: 'done', path: ['first', 'second', 'done'], resume: { from: 'second', graph: 'snapshot' } });
  expect(readFileSync(marker, 'utf8')).toBe('ab');
});

test('runs resume --file cannot change a snapshot run origin or its relative graph directory', async () => {
  const base = root();
  const original = join(base, 'original');
  const replacement = join(base, 'replacement');
  mkdirSync(original);
  mkdirSync(replacement);
  const graph = join(original, 'graph.yaml');
  const otherGraph = join(replacement, 'graph.yaml');
  const marker = join(base, 'ready');
  const yaml = `graph_id: snapshot-origin\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, on: outcome, map: { ok: done, fail: failed } }\n`;
  writeFileSync(graph, yaml);
  writeFileSync(otherGraph, yaml);
  writeFileSync(join(original, 'recipes.yaml'), `first:\n  command: "test -f '${marker}'"\n`);
  writeFileSync(join(replacement, 'recipes.yaml'), 'first:\n  command: "exit 0"\n');
  const first = await runGraph(graph, { runId: 'origin-run', deps: { root: base } });
  expect(first.status).toBe('failed');
  const before = readFileSync(first.statePath, 'utf8');
  const rejected = await cli(base, ['runs', 'resume', 'origin-run', '--file', otherGraph, '--json']);
  expect(rejected.exit).toBe(1);
  expect(rejected.err.join('\n')).toContain('--file cannot change the graph path of a snapshot run');
  expect(rejected.err.join('\n')).toContain('--use-current-graph');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
  const current = await cli(base, ['runs', 'resume', 'origin-run', '--file', otherGraph, '--use-current-graph']);
  expect(current.exit).toBe(1);
  expect(current.err.join('\n')).toContain('--file cannot change the graph path of a snapshot run');
  expect(readFileSync(first.statePath, 'utf8')).toBe(before);
  writeFileSync(marker, 'repaired');
  const resumed = await cli(base, ['runs', 'resume', 'origin-run', '--file', graph, '--json']);
  expect(resumed.exit).toBe(0);
  expect(JSON.parse(resumed.out[0]!)).toMatchObject({ graphPath: graph, status: 'done', resume: { graph: 'snapshot', from: 'first' } });
});

test('runs resume reads a snapshot when the original installed graph path has disappeared', async () => {
  const base = root();
  const graph = join(base, 'graph.yaml');
  const marker = join(base, 'marker');
  writeFileSync(join(base, 'recipes.yaml'), `first:\n  command: "test -f '${marker}'"\n`);
  writeFileSync(graph, `graph_id: missing-install\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, on: outcome, map: { ok: done, fail: failed } }\n`);
  const first = await runGraph(graph, { runId: 'uninstalled-run', deps: { root: base } });
  expect(first.status).toBe('failed');
  rmSync(graph);
  writeFileSync(marker, 'repaired');
  const resumed = await cli(base, ['runs', 'resume', 'uninstalled', '--json']);
  expect(resumed.exit).toBe(0);
  expect(JSON.parse(resumed.out[0]!)).toMatchObject({ status: 'done', resume: { from: 'first', graph: 'snapshot' } });
});

test('runs resume --file still relocates a legacy run without a snapshot and uses the given recipes', async () => {
  const base = root();
  const original = join(base, 'original');
  const moved = join(base, 'moved');
  mkdirSync(original);
  mkdirSync(moved);
  const marker = join(base, 'ready');
  const yaml = `graph_id: legacy-move\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, on: outcome, map: { ok: done, fail: failed } }\n`;
  const recipes = `first:\n  command: "test -f '${marker}'"\n`;
  writeFileSync(join(original, 'graph.yaml'), yaml);
  writeFileSync(join(original, 'recipes.yaml'), recipes);
  writeFileSync(join(moved, 'graph.yaml'), yaml);
  writeFileSync(join(moved, 'recipes.yaml'), recipes);
  const first = await runGraph(join(original, 'graph.yaml'), { runId: 'legacy-run', deps: { root: base } });
  expect(first.status).toBe('failed');
  // Simulate a ledger written before snapshots existed.
  const ledger = JSON.parse(readFileSync(first.statePath, 'utf8')) as Record<string, unknown>;
  delete ledger.graphSnapshot;
  delete ledger.graphPath;
  writeFileSync(first.statePath, JSON.stringify(ledger));
  rmSync(`${first.statePath}.graph`, { recursive: true, force: true });
  rmSync(original, { recursive: true, force: true });
  writeFileSync(marker, 'repaired');
  const resumed = await cli(base, ['runs', 'resume', 'legacy-run', '--file', join(moved, 'graph.yaml'), '--json']);
  expect(resumed.exit).toBe(0);
  expect(JSON.parse(resumed.out[0]!)).toMatchObject({ status: 'done', path: ['first', 'done'], resume: { from: 'first', graph: 'current' } });
});

test('runs resume without a failed node continues an awaiting approval run', async () => {
  const base = root();
  const graph = join(base, 'graph.yaml');
  writeFileSync(join(base, 'recipes.yaml'), 'gate:\n  approval: "Proceed?"\n');
  writeFileSync(graph, `graph_id: resume-approval\nversion: 1\nentry_node: gate\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: gate, on: outcome, map: { ok: done, fail: failed } }\n`);
  const first = await runGraph(graph, { runId: 'pending-example', deps: { root: base } });
  expect(first.status).toBe('awaiting-approval');
  const again = await cli(base, ['runs', 'resume', 'pending-ex', '--json']);
  expect(again.exit).toBe(0);
  expect(JSON.parse(again.out[0]!)).toMatchObject({ status: 'awaiting-approval', pending: { nodeId: 'gate' } });
});

test('runs resume rejects an ambiguous prefix without changing any ledger', async () => {
  const base = root();
  const one = save(base, 'a', 'same-one', '2026-10-01T00:00:00.000Z', { status: 'failed' });
  const two = save(base, 'b', 'same-two', '2026-10-02T00:00:00.000Z', { status: 'failed' });
  const before = [one, two].map((file) => readFileSync(file, 'utf8'));
  const result = await cli(base, ['runs', 'resume', 'same']);
  expect(result.exit).toBe(1);
  expect(result.err.join('\n')).toContain('ambiguous run id: same');
  expect([one, two].map((file) => readFileSync(file, 'utf8'))).toEqual(before);
});

test('an orphan running node stops as failed and resumes from that node without replaying predecessors', async () => {
  const base = root();
  const graph = join(base, 'graph.yaml');
  const marker = join(base, 'marker');
  const ready = join(base, 'ready');
  writeFileSync(join(base, 'recipes.yaml'), `first:\n  command: "printf a >> '${marker}'"\nsecond:\n  command: "test -f '${ready}' && printf b >> '${marker}'"\n`);
  writeFileSync(graph, `graph_id: orphan-loop\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, to: second }\n  - { from: second, on: outcome, map: { ok: done, fail: failed } }\n`);
  const first = await runGraph(graph, { runId: 'orphan-run', deps: { root: base, runBash: async (body) => ({ exitCode: 0, stdout: body.includes('printf a') ? 'a' : 'b', stderr: '' }) } });
  const state = JSON.parse(readFileSync(first.statePath, 'utf8'));
  state.status = 'running';
  state.finishedAt = undefined;
  state.path = ['first', 'second'];
  state.nodes = [{ nodeId: 'first', ok: true, exit: 0, executed: true, output: 'a' }];
  state.executed = 1;
  state.pid = 4321;
  state.pidStartedAt = '2026-10-03T00:00:00.000Z';
  writeFileSync(first.statePath, JSON.stringify(state));
  mkdirSync(`${first.statePath}.resume.lock`);
  mkdirSync(`${first.statePath}.write.lock`);
  writeFileSync(join(`${first.statePath}.write.lock`, 'owner.json'), JSON.stringify({ pid: 4321, started: Date.parse(state.pidStartedAt) }));
  const stopped = await cli(base, ['runs', 'stop', 'orphan'], () => null);
  expect(stopped.exit).toBe(0);
  expect(stopped.out).toContain('orphan-loop orphan-run: failed');
  expect(existsSync(`${first.statePath}.resume.lock`)).toBe(false);
  expect(existsSync(`${first.statePath}.write.lock`)).toBe(false);
  expect(JSON.parse(readFileSync(first.statePath, 'utf8'))).toMatchObject({ status: 'failed', nodes: [{ nodeId: 'first', ok: true }, { nodeId: 'second', ok: false }] });
  writeFileSync(ready, 'yes');
  const resumed = await cli(base, ['runs', 'resume', 'orphan', '--from', 'second', '--json']);
  expect(resumed.exit).toBe(0);
  expect(JSON.parse(resumed.out[0]!)).toMatchObject({ status: 'done', path: ['first', 'second', 'done'], resume: { from: 'second', previousStatus: 'failed' } });
  expect(readFileSync(marker, 'utf8')).toBe('b');
});

test('stop verifies ownership and destroy removes only owned artifacts', async () => {
  const base = root();
  const file = save(base, 'g', 'owned', new Date().toISOString(), { status: 'running', pid: 42, pidStartedAt: '2026-10-03T00:00:00.000Z' });
  mkdirSync(`${file}.resume.lock`);
  const signaled: number[] = [];
  manageGraphRun('g', 'owned', 'stop', base, () => Date.parse('2026-10-03T00:00:00.000Z'), (pid) => { signaled.push(pid); });
  expect(signaled).toEqual([42]);
  expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('failed');
  writeFileSync(`${file}.1.decision.json`, JSON.stringify({ nodeId: 'first', decision: 'approved', decidedAt: new Date().toISOString() }));
  mkdirSync(`${file}.graph`);
  mkdirSync(`${file}.contexts`);
  const unrelated = join(base, 'graph-runs', 'g', 'owned-other.json');
  writeFileSync(unrelated, 'not a graph run');
  expect((await cli(base, ['runs', 'destroy', 'owned'])).exit).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(`${file}.graph`)).toBe(false);
  expect(existsSync(`${file}.contexts`)).toBe(false);
  expect(existsSync(`${file}.1.decision.json`)).toBe(false);
  expect(readFileSync(unrelated, 'utf8')).toBe('not a graph run');
  const unknown = save(base, 'g', 'unknown', new Date().toISOString(), { status: 'running' });
  expect((await cli(base, ['runs', 'stop', 'unknown'])).exit).toBe(1);
  expect(JSON.parse(readFileSync(unknown, 'utf8')).status).toBe('running');
  expect((await cli(base, ['runs', 'destroy', 'unknown'])).exit).toBe(1);
  const external = join(base, 'external');
  writeFileSync(external, 'safe');
  symlinkSync(external, `${unknown}.contexts`);
  expect(() => manageGraphRun('g', 'unknown', 'destroy', base, () => null)).toThrow('symlink');
  expect(readFileSync(external, 'utf8')).toBe('safe');
});

test('ESRCH after runner verification still removes resume lock and permits destroy', () => {
  const base = root();
  const file = save(base, 'g', 'exited', new Date().toISOString(), { status: 'running', pid: 501, pidStartedAt: '2026-10-03T00:00:00.000Z' });
  mkdirSync(`${file}.resume.lock`);
  const state = manageGraphRun('g', 'exited', 'stop', base, () => Date.parse('2026-10-03T00:00:00.000Z'), () => {
    throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
  });
  expect(state.status).toBe('failed');
  expect(existsSync(`${file}.resume.lock`)).toBe(false);
  manageGraphRun('g', 'exited', 'destroy', base, () => null);
  expect(existsSync(file)).toBe(false);
});

test('ESRCH after active node verification still fails the orphan and clears its resume lock', () => {
  const base = root();
  const started = '2026-10-03T00:00:00.000Z';
  const file = save(base, 'g', 'exited-node', new Date().toISOString(), { status: 'running', path: ['first'], nodes: [], executed: 0,
    pid: 501, pidStartedAt: started, activeNode: { nodeId: 'first', pid: 502, pidStartedAt: started } });
  mkdirSync(`${file}.resume.lock`);
  const signaled: number[] = [];
  manageGraphRun('g', 'exited-node', 'stop', base, () => Date.parse(started), (pid) => {
    signaled.push(pid);
    if (pid === 502) throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
  });
  expect(signaled).toEqual([502, 501]);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ status: 'failed', nodes: [{ nodeId: 'first', ok: false }] });
  expect(existsSync(`${file}.resume.lock`)).toBe(false);
});

test('legacy ownerless lock after crash is reclaimed; nonempty unknown locks are preserved', () => {
  const base = root();
  const file = save(base, 'g', 'legacy-lock', new Date().toISOString(), { status: 'running', pid: 123, pidStartedAt: '2026-10-03T00:00:00.000Z' });
  const lock = `${file}.write.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, 'unexpected'), 'leave intact');
  utimesSync(lock, new Date(0), new Date(0));
  expect(() => manageGraphRun('g', 'legacy-lock', 'stop', base, () => null)).toThrow();
  expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('running');
  expect(readFileSync(join(lock, 'unexpected'), 'utf8')).toBe('leave intact');
  rmSync(join(lock, 'unexpected'));
  utimesSync(lock, new Date(0), new Date(0));
  expect(manageGraphRun('g', 'legacy-lock', 'stop', base, () => null).status).toBe('failed');
  expect(existsSync(lock)).toBe(false);
});

test('stop signals only verified node and runner pids, never a reused node pid', () => {
  const base = root();
  const file = save(base, 'g', 'active', new Date().toISOString(), { status: 'running', path: ['first'], nodes: [], executed: 0, pid: 501, pidStartedAt: '2026-10-03T00:00:00.000Z',
    activeNode: { nodeId: 'first', pid: 502, pidStartedAt: '2026-10-03T00:00:00.000Z' } });
  const signaled: number[] = [];
  const started = Date.parse('2026-10-03T00:00:00.000Z');
  manageGraphRun('g', 'active', 'stop', base, pid => pid === 501 ? started : started + 60_000, pid => { signaled.push(pid); });
  expect(signaled).toEqual([501]);
  expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('failed');
});

test('a failed run with a crash-leftover resume lock can be destroyed; a fresh lock still means a resume is starting', () => {
  const base = root();
  const file = save(base, 'g', 'left-lock', new Date().toISOString(), { status: 'failed' });
  const lock = `${file}.resume.lock`;
  mkdirSync(lock);
  expect(() => manageGraphRun('g', 'left-lock', 'destroy', base, () => null)).toThrow('being resumed');
  expect(existsSync(file)).toBe(true);
  utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  manageGraphRun('g', 'left-lock', 'destroy', base, () => null);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(lock)).toBe(false);
});

test('stop refuses while a live runner has a node child whose start time is not verified yet', () => {
  const base = root();
  const started = '2026-10-03T00:00:00.000Z';
  const file = save(base, 'g', 'pending-node', new Date().toISOString(), { status: 'running', path: ['first'], nodes: [], executed: 0,
    pid: 501, pidStartedAt: started, activeNode: { nodeId: 'first', pid: 502, pidStartedAt: 'unverified' } });
  const signaled: number[] = [];
  expect(() => manageGraphRun('g', 'pending-node', 'stop', base, () => Date.parse(started), pid => { signaled.push(pid); })).toThrow('not verified yet');
  expect(signaled).toEqual([]);
  expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('running');
  // Runner gone (reboot): fold to failed without signaling the unverifiable node pid.
  const state = manageGraphRun('g', 'pending-node', 'stop', base, () => null, pid => { signaled.push(pid); });
  expect(state.status).toBe('failed');
  expect(signaled).toEqual([]);
});

test('destroy refuses a claim belonging to a different visit without removing the ledger or artifacts', () => {
  const base = root();
  const file = save(base, 'g', 'guarded', new Date().toISOString());
  const claim = `${file}.1.decision.json`;
  writeFileSync(claim, JSON.stringify({ nodeId: 'other', decision: 'approved', decidedAt: new Date().toISOString() }));
  expect(() => manageGraphRun('g', 'guarded', 'destroy', base, () => null)).toThrow('invalid graph run decision claim');
  expect(existsSync(file)).toBe(true);
  expect(existsSync(claim)).toBe(true);
});

test('real command execution records its node pid while running and clears it on completion', async () => {
  const base = root();
  const graph = join(base, 'graph.yaml');
  writeFileSync(join(base, 'recipes.yaml'), 'first:\n  command: "sleep 0.2"\n');
  writeFileSync(graph, `graph_id: live-node\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: first, on: outcome, map: { ok: done, fail: failed } }\n`);
  const pending = runGraph(graph, { runId: 'live-pid', deps: { root: base } });
  const file = join(base, 'graph-runs', 'live-node', 'live-pid.json');
  let recorded: { activeNode?: { pid: number; nodeId: string } } | undefined;
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) recorded = JSON.parse(readFileSync(file, 'utf8'));
    if (recorded?.activeNode) break;
    await Bun.sleep(10);
  }
  expect(recorded?.activeNode).toMatchObject({ nodeId: 'first', pid: expect.any(Number) });
  const done = await pending;
  expect(done.status).toBe('done');
  expect(JSON.parse(readFileSync(file, 'utf8')).activeNode).toBeUndefined();
});

test('a running ledger without a recorded path can be stopped after a crash before the entry node', async () => {
  const base = root();
  const file = save(base, 'g', 'early', new Date().toISOString(), { status: 'running', path: [], nodes: [], executed: 0,
    pid: 123, pidStartedAt: '2026-10-03T00:00:00.000Z' });
  const result = await cli(base, ['runs', 'stop', 'early'], () => null);
  expect(result.exit).toBe(0);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ status: 'failed', path: [], nodes: [] });
});

test('old graph status remains the latest-run command', async () => {
  const base = root();
  save(base, 'release-loop', 'only-run', '2026-10-01T00:00:00.000Z');
  const previousState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = base;
  try {
    const result = await cli(base, ['status', 'release-loop']);
    expect(result.out[0]).toContain('release-loop only-run: done');
    expect(result.exit).toBe(0);
  } finally {
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
  }
});

test('a broken file under a decision-claim name counts as unreadable even when the guessed parent run exists; a valid claim is skipped', () => {
  const base = root();
  const parent = save(base, 'release-loop', 'foo', '2026-10-01T00:00:00.000Z');
  const claimPath = `${parent}.1.decision.json`;
  writeFileSync(claimPath, JSON.stringify({ nodeId: 'approve-publish', decision: 'approved', decidedBy: 'OP', decidedAt: '2026-10-01T01:00:00.000Z' }));
  expect(listGraphRuns(base)).toMatchObject({ unreadable: 0 });
  expect(listGraphRuns(base).runs.map((state) => state.runId)).toEqual(['foo']);
  writeFileSync(claimPath, '{');
  expect(listGraphRuns(base).unreadable).toBe(1);
  writeFileSync(claimPath, JSON.stringify({ nodeId: 'approve-publish', decision: 'maybe', decidedAt: 'x' }));
  expect(listGraphRuns(base).unreadable).toBe(1);
});
