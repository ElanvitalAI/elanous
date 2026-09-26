import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function spawnGraph(stateRoot: string, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'graph', ...args], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: stateRoot },
  });
  return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout), stderr: new TextDecoder().decode(proc.stderr) };
}

test('real CLI awaits approval, reports message, records decision and resumes without replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-approval-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: "printf a >> '${join(dir, 'executions')}'"\ngate:\n  approval: "Publish now?"\nb:\n  command: "printf b >> '${join(dir, 'executions')}'"\n`);
  writeFileSync(graph, `graph_id: cli-approval
version: 1
entry_node: a
terminal_nodes: [done, failed]
nodes:
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: 1 }
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: a, to: gate }
  - from: gate
    on: outcome
    map: { ok: b, fail: failed }
  - { from: b, to: done }
`);
  const first = spawnGraph(stateRoot, 'run', graph, '--json');
  expect(first.code).toBe(0);
  const pending = JSON.parse(first.stdout);
  expect(pending).toMatchObject({ graphId: 'cli-approval', status: 'awaiting-approval', pending: { nodeId: 'gate', message: 'Publish now?' } });
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('a');
  const status = spawnGraph(stateRoot, 'status', pending.graphId);
  expect(status.stdout).toContain('awaiting-approval');
  expect(status.stdout).toContain('Publish now?');
  const undecided = spawnGraph(stateRoot, 'run', graph, '--resume', pending.runId, '--json');
  expect(JSON.parse(undecided.stdout).status).toBe('awaiting-approval');
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('a');
  const approved = spawnGraph(stateRoot, 'approve', pending.graphId, pending.runId, '--by', 'operator');
  expect(approved.code).toBe(0);
  const duplicate = spawnGraph(stateRoot, 'approve', pending.graphId, pending.runId);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain('not awaiting an undecided approval');
  const resumed = spawnGraph(stateRoot, 'run', graph, '--resume', pending.runId, '--json');
  expect(resumed.code).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'done', runId: pending.runId, executed: 2 });
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('ab');
  const after = spawnGraph(stateRoot, 'approve', pending.graphId, pending.runId);
  expect(after.code).toBe(1);
  expect(after.stderr).toContain('not awaiting');
  const rejectedFirst = spawnGraph(stateRoot, 'run', graph, '--json');
  expect(rejectedFirst.code).toBe(0);
  const rejectedId = JSON.parse(rejectedFirst.stdout).runId as string;
  const rejection = spawnGraph(stateRoot, 'approve', 'cli-approval', rejectedId, '--reject', '--by', 'reviewer');
  expect(rejection.code).toBe(0);
  const failed = spawnGraph(stateRoot, 'run', graph, '--resume', rejectedId, '--json');
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout).status).toBe('failed');
  expect(JSON.parse(failed.stdout).nodes[1]).toMatchObject({ nodeId: 'gate', ok: false, decidedBy: 'reviewer' });
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('aba');
  const unnamedFirst = spawnGraph(stateRoot, 'run', graph, '--json');
  expect(unnamedFirst.code).toBe(0);
  const unnamedId = JSON.parse(unnamedFirst.stdout).runId as string;
  const unnamedApproval = spawnGraph(stateRoot, 'approve', 'cli-approval', unnamedId);
  expect(unnamedApproval.code).toBe(0);
  const unnamedStatus = spawnGraph(stateRoot, 'status', 'cli-approval', '--json');
  expect(unnamedStatus.code).toBe(0);
  expect(JSON.parse(unnamedStatus.stdout).pending).toMatchObject({ decision: 'approved' });
  expect(JSON.parse(unnamedStatus.stdout).pending).not.toHaveProperty('decidedBy');
  const unnamedResumed = spawnGraph(stateRoot, 'run', graph, '--resume', unnamedId, '--json');
  expect(unnamedResumed.code).toBe(0);
  expect(JSON.parse(unnamedResumed.stdout).nodes[1]).toMatchObject({ nodeId: 'gate', ok: true });
  expect(JSON.parse(unnamedResumed.stdout).nodes[1]).not.toHaveProperty('decidedBy');
  expect(readFileSync(join(dir, 'executions'), 'utf8')).toBe('abaab');
}, 60000);

test('spawned graph run passes JSON object input to commands and status --json reads persisted outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-dataflow-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), `first:\n  command: 'printf first-output'\nsecond:\n  command: 'cat "$ELANOUS_GRAPH_CONTEXT"'\n`);
  writeFileSync(graph, `graph_id: cli-dataflow
version: 1
entry_node: first
terminal_nodes: [done, failed]
nodes:
  - { node_id: first, kind: agent, recipe: 'cmd:first', max_visits: 1 }
  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: first, to: second }
  - { from: second, to: done }
`);
  const input = { request: 'hello', count: 2 };
  const run = spawnGraph(stateRoot, 'run', graph, '--input', JSON.stringify(input), '--json');
  expect(run.code).toBe(0);
  const state = JSON.parse(run.stdout);
  expect(state).toMatchObject({ graphId: 'cli-dataflow', status: 'done', input, executed: 2 });
  expect(state.nodes[0]).toMatchObject({ nodeId: 'first', output: 'first-output' });
  expect(JSON.parse(state.nodes[1].output)).toEqual({ graphId: 'cli-dataflow', runId: state.runId, nodeId: 'second', input, outputs: { first: 'first-output' } });
  const persisted = JSON.parse(readFileSync(state.statePath, 'utf8'));
  expect(persisted.input).toEqual(input);
  expect(persisted.nodes.slice(0, 2).map((node: { output: unknown }) => node.output)).toEqual(state.nodes.slice(0, 2).map((node: { output: unknown }) => node.output));
  const status = spawnGraph(stateRoot, 'status', 'cli-dataflow', '--json');
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toEqual(persisted);
}, 30000);

test('spawned graph run rejects --input unless it is a JSON object before writing a run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-invalid-input-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(graph, 'unused');
  for (const input of ['{bad', '[]', 'null', '42', '"text"']) {
    const run = spawnGraph(stateRoot, 'run', graph, '--input', input, '--json');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('graph run: --input must be a JSON object');
    expect(run.stdout).toBe('');
  }
  expect(existsSync(join(stateRoot, 'graph-runs'))).toBe(false);
}, 30000);

test('concurrent CLI approval and rejection claim only one immutable decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-race-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), 'gate:\n  approval: "Publish now?"\n');
  writeFileSync(graph, `graph_id: race-approval
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: done, fail: failed }
`);
  const first = spawnGraph(stateRoot, 'run', graph, '--json');
  expect(first.code).toBe(0);
  const pending = JSON.parse(first.stdout);
  expect(pending.status).toBe('awaiting-approval');
  const env = { ...process.env, ELANOUS_STATE_DIR: stateRoot };
  const approve = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', 'graph', 'approve', pending.graphId, pending.runId, '--by', 'first'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const reject = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', 'graph', 'approve', pending.graphId, pending.runId, '--reject', '--by', 'second'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [approvedCode, rejectedCode] = await Promise.all([approve.exited, reject.exited]);
  expect([approvedCode, rejectedCode].sort()).toEqual([0, 1]);
  const winner = approvedCode === 0 ? 'approved' : 'rejected';
  const winnerBy = approvedCode === 0 ? 'first' : 'second';
  const loserError = await new Response((approvedCode === 0 ? reject : approve).stderr).text();
  expect(loserError).toContain('not awaiting an undecided approval');
  const status = spawnGraph(stateRoot, 'status', pending.graphId, '--json');
  expect(JSON.parse(status.stdout).pending).toMatchObject({ decision: winner, decidedBy: winnerBy });
  expect(spawnGraph(stateRoot, 'approve', pending.graphId, pending.runId, '--reject').code).toBe(1);
  const resume = spawnGraph(stateRoot, 'run', graph, '--resume', pending.runId, '--json');
  expect(JSON.parse(resume.stdout).status).toBe(winner === 'approved' ? 'done' : 'failed');
  expect(JSON.parse(resume.stdout).nodes[0]).toMatchObject({ ok: winner === 'approved', decidedBy: winnerBy });
}, 60000);

test('two spawned resumes cannot both execute the approved downstream command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-cli-resume-race-'));
  dirs.push(dir);
  const stateRoot = join(dir, 'state');
  const graph = join(dir, 'graph.yaml');
  const marker = join(dir, 'started');
  const count = join(dir, 'count');
  const release = join(dir, 'release');
  writeFileSync(join(dir, 'recipes.yaml'), `gate:\n  approval: "Publish?"\nb:\n  command: "touch '${marker}'; while [ ! -f '${release}' ]; do sleep 0.1; done; printf b >> '${count}'"\n`);
  writeFileSync(graph, `graph_id: resume-race
version: 1
entry_node: gate
terminal_nodes: [done, failed]
nodes:
  - { node_id: gate, kind: judge, recipe: 'approval:gate', max_visits: 1 }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: gate
    on: outcome
    map: { ok: b, fail: failed }
  - { from: b, to: done }
`);
  const first = JSON.parse(spawnGraph(stateRoot, 'run', graph, '--json').stdout);
  expect(first.status).toBe('awaiting-approval');
  expect(spawnGraph(stateRoot, 'approve', first.graphId, first.runId).code).toBe(0);
  const env = { ...process.env, ELANOUS_STATE_DIR: stateRoot };
  const firstResume = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', 'graph', 'run', graph, '--resume', first.runId, '--json'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  try {
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    const secondResume = spawnGraph(stateRoot, 'run', graph, '--resume', first.runId, '--json');
    expect(secondResume.code).toBe(1);
    expect(secondResume.stderr).toContain('already being resumed');
  } finally { writeFileSync(release, 'go'); await firstResume.exited; }
  expect(firstResume.exitCode).toBe(0);
  expect(JSON.parse(await new Response(firstResume.stdout).text()).status).toBe('done');
  expect(readFileSync(count, 'utf8')).toBe('b');
}, 60000);

test('real CLI walks docs publication in dry-run mode without executing commands', () => {
  const proc = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'graph', 'run', 'graphs/ops/docs-publish.yaml', '--dry-run', '--json'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: resolve(root, '.elanous-test') },
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain('unknown command');
  expect(proc.exitCode).toBe(0);
  const state = JSON.parse(new TextDecoder().decode(proc.stdout));
  expect(state.path).toEqual(['build', 'deploy', 'done']);
  expect(state.executed).toBe(0);
  expect(state.dryRun).toBe(true);
  const status = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'graph', 'status', 'docs-publish', '--json'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: resolve(root, '.elanous-test') },
  });
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(status.stdout))).toMatchObject({ runId: state.runId, path: state.path, executed: 0 });
}, 30000);
