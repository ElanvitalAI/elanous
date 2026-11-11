import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraph } from './runner.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// GRAPH-EDGE-VOCAB-EXEC: declared healing vocabulary runs through the production graph runner.
function edgeVocabGraph(healing: string, additions: { nodes?: string; edges?: string; header?: string } = {}): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-edge-vocab-sim-'));
  dirs.push(root);
  const path = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const handlerRecipes = ['handler:accepted-a', 'handler:accepted-b', 'handler:append', 'handler:branch-a', 'handler:branch-b',
    'handler:fail-a', 'handler:fail-b', 'handler:full', 'handler:gate', 'handler:ok-a', 'handler:ok-b', 'handler:radius',
    'handler:repair', 'handler:repair-fail-a', 'handler:repair-fail-b', 'handler:repair-two', 'handler:repair-work-a',
    'handler:repair-work-b', 'handler:start'];
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'graph-edge-vocab-sim', version: '1.0.0',
    extensions: { 'ai.elanous': { identity: 'elanous.test-graph-edge-vocab', inputs: [], graphs: ['./graph.yaml'], graphManifests: { 'graph-edge-vocab-sim': {
      purpose: 'Exercise declared healing edge routes in the production runner.',
      allow: { recipes: handlerRecipes, skills: [], domainPacks: [] },
      edgeVocabulary: ['heal', 'retry', 'detour', 'append-recheck', 'accept', 'escalate'],
      hitl: additions.header?.includes('hitl: [review]') ? ['review'] : [], policy: {},
    } } } } }));
  writeFileSync(path, `graph_id: graph-edge-vocab-sim\nversion: 1\nentry_node: start\nterminal_nodes: [done, failed]\n${additions.header ?? ''}nodes:\n  - { node_id: start, kind: agent, recipe: 'handler:start', max_visits: 3 }\n  - { node_id: repair, kind: agent, recipe: 'handler:repair', max_visits: 2 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n${additions.nodes ?? ''}edges:\n  - { from: start, on: outcome, map: { ok: done, fail: failed } }\n  - { from: repair, on: outcome, map: { ok: start, fail: failed } }\n${additions.edges ?? ''}heal_edges:\n${healing}\n`);
  return { root, path };
}

test('SIM GRAPH-EDGE-VOCAB-EXEC: declared heal runs repair and rejoins the same node', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: heal\n    from: start\n    on: [fail]\n    classify: { classes: [broken] }\n    repair: { broken: repair }\n    attempts: 1\n    escalate: failed`);
  // Source: #95018 simulation counts start visits; the declared edge owns the retry limit.
  let attempts = 0;
  const events: Array<{ event: string; data: unknown }> = [];
  const result = await runGraph(path, { runId: 'heal-sim', deps: { root, log: (event, data) => { events.push({ event, data }); },
    inProcessHandlers: {
      start: () => ++attempts === 1 ? { ok: false, outcome: 'broken', evidence: { class: 'broken' } } : { ok: true, outcome: 'ok' },
      repair: () => ({ ok: true, outcome: 'ok' }),
    } } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['start', 'repair', 'start', 'done']);
  expect(events.some(({ event }) => event === 'graph.heal')).toBe(true);
  expect(events.some(({ event }) => event === 'graph.rejoin')).toBe(true);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: declared retry exhausts to escalation without a third attempt', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: retry\n    from: start\n    on: [fail]\n    attempts: 1\n    escalate: failed`);
  // Source: #95018 simulation distinguishes the initial failure from its retry.
  let attempts = 0;
  const result = await runGraph(path, { runId: 'retry-sim', deps: { root, inProcessHandlers: {
    start: () => { attempts++; return { ok: false, outcome: 'fail' }; },
    repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('failed');
  expect(result.path).toEqual(['start', 'start', 'failed']);
  expect(attempts).toBe(2);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: detour rejoins its declared destination', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: detour\n    from: start\n    on: [fail]\n    via: repair\n    rejoin: { to: done }`);
  writeFileSync(path, readFileSync(path, 'utf8').replace('max_visits: 3', 'max_visits: 1'));
  const result = await runGraph(path, { runId: 'detour-sim', deps: { root, inProcessHandlers: {
    start: () => ({ ok: false, outcome: 'fail' }), repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['start', 'repair', 'done']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: rejected acceptance skips the success fan-out', async () => {
  const { root, path } = edgeVocabGraph("  - kind: accept\n    from: start\n    on: [ok]\n    rules: [known-regression]\n    expiry: 2099-01-01\n    ledger: accepted.json\n    else: failed", {
    nodes: "  - { node_id: accepted-a, kind: agent, recipe: 'handler:accepted-a', max_visits: 1 }\n  - { node_id: accepted-b, kind: agent, recipe: 'handler:accepted-b', max_visits: 1 }\n  - { node_id: branch-join, kind: gate, recipe: none, max_visits: 1 }\n",
    edges: "  - { from: branch-join, on: outcome, map: { ok: done, fail: failed } }\n",
  });
  const source = readFileSync(path, 'utf8').replace('max_visits: 3', 'max_visits: 1')
    .replace("  - { from: start, on: outcome, map: { ok: done, fail: failed } }", "  - { from: start, on: outcome, branches: { ok: [accepted-a, accepted-b], fail: [failed, done] }, join: branch-join }");
  writeFileSync(path, source);
  let branchCalls = 0;
  const result = await runGraph(path, { runId: 'rejected-accept-no-branch', deps: { root, inProcessHandlers: {
    start: () => ({ ok: true, outcome: 'ok', evidence: { id: 'accept-a', rule: 'known-regression' } }),
    'accepted-a': () => { branchCalls++; return { ok: true, outcome: 'ok' }; },
    'accepted-b': () => { branchCalls++; return { ok: true, outcome: 'ok' }; },
    repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('failed');
  expect(branchCalls).toBe(0);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: accepted explicit route runs its fan-out join first', async () => {
  const { root, path } = edgeVocabGraph("  - kind: accept\n    from: start\n    rules: [known-regression]\n    expiry: 2099-01-01\n    ledger: accepted.json\n    to: accepted\n    else: failed", {
    nodes: "  - { node_id: accepted-a, kind: agent, recipe: 'handler:accepted-a', max_visits: 1 }\n  - { node_id: accepted-b, kind: agent, recipe: 'handler:accepted-b', max_visits: 1 }\n  - { node_id: branch-join, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: accepted, kind: gate, recipe: none, max_visits: 1 }\n",
    edges: "  - { from: branch-join, on: outcome, map: { ok: done, fail: failed } }\n  - { from: accepted, to: done }\n",
  });
  const source = readFileSync(path, 'utf8').replace('max_visits: 3', 'max_visits: 1')
    .replace("  - { from: start, on: outcome, map: { ok: done, fail: failed } }", "  - { from: start, on: outcome, branches: { ok: [accepted-a, accepted-b], fail: [failed, done] }, join: branch-join }");
  writeFileSync(path, source);
  writeFileSync(join(root, 'accepted.json'), JSON.stringify({ items: [{ id: 'accept-route', rule: 'known-regression', expiresAt: '2099-01-01' }] }));
  const result = await runGraph(path, { runId: 'accepted-fanout-route',
    deps: { root, inProcessHandlers: {
      start: () => ({ ok: true, outcome: 'ok', evidence: { id: 'accept-route', rule: 'known-regression' } }),
      'accepted-a': () => ({ ok: true, outcome: 'ok' }), 'accepted-b': () => ({ ok: true, outcome: 'ok' }),
      repair: () => ({ ok: true, outcome: 'ok' }),
    } } });
  expect(result.status).toBe('done');
  expect(result.path).toContain('branch-join');
  expect(result.path.indexOf('branch-join')).toBeLessThan(result.path.indexOf('accepted'));
  const failedJoin = await runGraph(path, { runId: 'accepted-fanout-route-failed-join',
    deps: { root, inProcessHandlers: {
      start: () => ({ ok: true, outcome: 'ok', evidence: { id: 'accept-route', rule: 'known-regression' } }),
      'accepted-a': () => ({ ok: true, outcome: 'ok' }), 'accepted-b': () => ({ ok: false, outcome: 'fail' }),
      repair: () => ({ ok: true, outcome: 'ok' }),
    } } });
  expect(failedJoin.status).toBe('failed');
  expect(failedJoin.path).toContain('branch-join');
  expect(failedJoin.path).toContain('failed');
  expect(failedJoin.path).not.toContain('accepted');

  const { root: defaultRoot, path: defaultPath } = edgeVocabGraph("  - kind: accept\n    from: start\n    on: [ok]\n    rules: [known-regression]\n    expiry: 2099-01-01\n    ledger: accepted.json\n    else: failed", {
    nodes: "  - { node_id: accepted-a, kind: agent, recipe: 'handler:accepted-a', max_visits: 1 }\n  - { node_id: accepted-b, kind: agent, recipe: 'handler:accepted-b', max_visits: 1 }\n  - { node_id: branch-join, kind: gate, recipe: none, max_visits: 1 }\n",
    edges: "  - { from: branch-join, on: outcome, map: { ok: done, fail: failed } }\n",
  });
  const defaultSource = readFileSync(defaultPath, 'utf8').replace('max_visits: 3', 'max_visits: 1')
    .replace("  - { from: start, on: outcome, map: { ok: done, fail: failed } }", "  - { from: start, on: outcome, branches: { ok: [accepted-a, accepted-b], fail: [failed, done] }, join: branch-join }");
  writeFileSync(defaultPath, defaultSource);
  writeFileSync(join(defaultRoot, 'accepted.json'), JSON.stringify({ items: [{ id: 'accept-default', rule: 'known-regression', expiresAt: '2099-01-01' }] }));
  const defaultRoute = await runGraph(defaultPath, { runId: 'accepted-default-join-route',
    deps: { root: defaultRoot, inProcessHandlers: {
      start: () => ({ ok: true, outcome: 'ok', evidence: { id: 'accept-default', rule: 'known-regression' } }),
      'accepted-a': () => ({ ok: true, outcome: 'ok' }), 'accepted-b': () => ({ ok: true, outcome: 'ok' }),
      repair: () => ({ ok: true, outcome: 'ok' }),
    } } });
  expect(defaultRoute.status).toBe('done');
  expect(defaultRoute.path.filter((nodeId) => nodeId === 'branch-join')).toHaveLength(1);
});
test('SIM GRAPH-EDGE-VOCAB-EXEC: resumed post-fanout recheck executes join before its destination', async () => {
  const { root, path } = edgeVocabGraph("  - kind: append-recheck\n    from: start\n    recheck: radius\n    promote: { when: [bun.lock], to: full }", {
    nodes: "  - { node_id: branch-a, kind: agent, recipe: 'handler:branch-a', max_visits: 1 }\n  - { node_id: branch-b, kind: agent, recipe: 'handler:branch-b', max_visits: 1 }\n  - { node_id: branch-join, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: radius, kind: agent, recipe: 'handler:radius', max_visits: 1 }\n  - { node_id: full, kind: agent, recipe: 'handler:full', max_visits: 1 }\n",
    edges: "  - { from: branch-join, on: outcome, map: { ok: done, fail: failed } }\n  - { from: radius, to: done }\n  - { from: full, to: done }\n",
  });
  writeFileSync(path, readFileSync(path, 'utf8').replace('max_visits: 3', 'max_visits: 1')
    .replace("  - { from: start, on: outcome, map: { ok: done, fail: failed } }", "  - { from: start, on: outcome, branches: { ok: [branch-a, branch-b], fail: [failed, done] }, join: branch-join }"));
  const handlers = {
    start: () => { writeFileSync(join(root, 'source-calls'), 'start\n', { flag: 'a' }); return { ok: true, outcome: 'ok', changedFiles: ['bun.lock'] }; },
    repair: () => ({ ok: true, outcome: 'ok' as const }),
    'branch-a': () => ({ ok: true, outcome: 'ok' as const }),
    'branch-b': () => ({ ok: true, outcome: 'ok' as const }),
    radius: () => ({ ok: true, outcome: 'ok' as const }),
    full: () => ({ ok: true, outcome: 'ok' as const }),
  };
  const statePath = join(root, 'graph-runs', 'graph-edge-vocab-sim', 'accepted-fanout-resume.json');
  // Source: #95018 process exit simulates a real cut after the transition checkpoint is persisted and before the join dispatch.
  const childSource = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { runGraph } from ${JSON.stringify(fileURLToPath(new URL('./runner.js', import.meta.url)))};
    const root = ${JSON.stringify(root)};
    const graph = ${JSON.stringify(path)};
    const statePath = ${JSON.stringify(statePath)};
    const handlers = {
      start: () => { writeFileSync(${JSON.stringify(join(root, 'source-calls'))}, 'start\\n', { flag: 'a' }); return { ok: true, outcome: 'ok', changedFiles: ['bun.lock'] }; },
      repair: () => ({ ok: true, outcome: 'ok' }),
      'branch-a': () => ({ ok: true, outcome: 'ok' }),
      'branch-b': () => ({ ok: true, outcome: 'ok' }),
      radius: () => ({ ok: true, outcome: 'ok' }),
      full: () => ({ ok: true, outcome: 'ok' }),
    };
    await runGraph(graph, { runId: 'accepted-fanout-resume', deps: { root, inProcessHandlers: handlers,
      beforeNode: () => {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        const branches = Object.values(state.fanOuts?.['start:ok']?.branches ?? []);
        if (state.healPending?.via === 'branch-join' && branches.length === 2 && branches.every((branch) => branch.status === 'done')) process.exit(86);
      },
    } });
    process.exit(0);
  `;
  const interrupted = spawnSync(process.execPath, ['-e', childSource], { encoding: 'utf8' });
  expect(interrupted.status).toBe(86);
  const checkpoint = JSON.parse(readFileSync(statePath, 'utf8')) as { healPending?: { via?: string; to?: string }; healTransitions?: Array<{ to?: string }> };
  expect(checkpoint.healPending?.via).toBe('branch-join');
  expect(checkpoint.healPending?.to).toBe('full');
  expect(checkpoint.healTransitions?.[0]?.to).toBe('branch-join');
  const resumed = await runGraph(path, { resumeRunId: 'accepted-fanout-resume', deps: { root, inProcessHandlers: handlers } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toContain('branch-join');
  expect(resumed.path.filter((nodeId) => nodeId === 'branch-join')).toHaveLength(1);
  expect(resumed.path.indexOf('branch-join')).toBeLessThan(resumed.path.indexOf('full'));
  expect(readFileSync(join(root, 'source-calls'), 'utf8')).toBe('start\n');
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: branch completion still selects its declared recheck edge', async () => {
  const { root, path } = edgeVocabGraph("  - kind: append-recheck\n    from: start\n    on: [ok]\n    recheck: radius\n    promote: { when: [bun.lock], to: full }", {
    nodes: "  - { node_id: branch-a, kind: agent, recipe: 'handler:branch-a', max_visits: 1 }\n  - { node_id: branch-b, kind: agent, recipe: 'handler:branch-b', max_visits: 1 }\n  - { node_id: branch-join, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: radius, kind: agent, recipe: 'handler:radius', max_visits: 1 }\n  - { node_id: full, kind: agent, recipe: 'handler:full', max_visits: 1 }\n",
    edges: "  - { from: branch-join, on: outcome, map: { ok: done, fail: failed } }\n  - { from: radius, to: done }\n  - { from: full, to: done }\n",
  });
  const source = readFileSync(path, 'utf8').replace('max_visits: 3', 'max_visits: 1')
    .replace("  - { from: start, on: outcome, map: { ok: done, fail: failed } }", "  - { from: start, on: outcome, branches: { ok: [branch-a, branch-b], fail: [failed, done] }, join: branch-join }");
  writeFileSync(path, source);
  const result = await runGraph(path, { runId: 'branch-edge-recheck', input: { changedFiles: ['bun.lock'] }, deps: { root, inProcessHandlers: {
    start: () => ({ ok: true, outcome: 'ok' }), 'branch-a': () => ({ ok: true, outcome: 'ok' }),
    'branch-b': () => ({ ok: true, outcome: 'ok' }), radius: () => ({ ok: true, outcome: 'ok' }),
    full: () => ({ ok: true, outcome: 'ok' }), repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('done');
  expect(result.path.indexOf('branch-join')).toBeGreaterThan(result.path.indexOf('branch-b'));
  expect(result.path.indexOf('branch-join')).toBeLessThan(result.path.indexOf('full'));
  expect(result.healTransitions?.map((transition) => transition.kind)).toEqual(['recheck', 'rejoin']);
  expect(result.healTransitions?.[0]?.to).toBe('branch-join');
  expect(result.healTransitions?.[1]?.to).toBe('full');
  const failedJoin = await runGraph(path, { runId: 'branch-edge-recheck-failed-join', input: { changedFiles: ['bun.lock'] },
    deps: { root, inProcessHandlers: {
      start: () => ({ ok: true, outcome: 'ok' }), 'branch-a': () => ({ ok: false, outcome: 'fail' }),
      'branch-b': () => ({ ok: true, outcome: 'ok' }), radius: () => ({ ok: true, outcome: 'ok' }),
      full: () => ({ ok: true, outcome: 'ok' }), repair: () => ({ ok: true, outcome: 'ok' }),
    } } });
  expect(failedJoin.status).toBe('failed');
  expect(failedJoin.path).toContain('branch-join');
  expect(failedJoin.path).toContain('failed');
  expect(failedJoin.path).not.toContain('full');
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: detour pending rejoin survives a branched repair node', async () => {
  const { root, path } = edgeVocabGraph("  - kind: detour\n    from: start\n    on: [fail]\n    via: repair\n    rejoin: { to: done }", {
    nodes: "  - { node_id: repair-work-a, kind: agent, recipe: 'handler:repair-work-a', max_visits: 1 }\n  - { node_id: repair-work-b, kind: agent, recipe: 'handler:repair-work-b', max_visits: 1 }\n  - { node_id: repair-join, kind: gate, recipe: none, max_visits: 1 }\n",
    edges: "  - { from: repair-join, on: outcome, map: { ok: done, fail: failed } }\n",
  });
  let starts = 0;
  let source = readFileSync(path, 'utf8')
    .replace('node_id: repair, kind: agent, recipe: \'handler:repair\', max_visits: 2', 'node_id: repair, kind: agent, recipe: \'handler:repair\', max_visits: 1')
    .replace("  - { from: repair, on: outcome, map: { ok: start, fail: failed } }", "  - { from: repair, on: outcome, branches: { ok: [repair-work-a, repair-work-b], fail: [failed, done] }, join: repair-join }");
  writeFileSync(path, source);
  const result = await runGraph(path, { runId: 'detour-branched-repair', deps: { root, inProcessHandlers: {
    start: () => ++starts === 1 ? { ok: false, outcome: 'fail' } : { ok: true, outcome: 'ok' },
    repair: () => ({ ok: true, outcome: 'ok' }), 'repair-work-a': () => ({ ok: true, outcome: 'ok' }), 'repair-work-b': () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('done');
  expect(result.path).toContain('repair-join');
  expect(result.healTransitions?.map((transition) => transition.kind)).toEqual(['detour', 'rejoin']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: repair node explicit edge preempts pending rejoin before fan-out', async () => {
  const { root, path } = edgeVocabGraph("  - kind: detour\n    from: start\n    on: [fail]\n    via: repair\n    rejoin: { to: done }\n  - kind: detour\n    from: repair\n    on: [ok]\n    via: repair-two\n    rejoin: { to: done }", {
    nodes: "  - { node_id: repair-work-a, kind: agent, recipe: 'handler:repair-work-a', max_visits: 1 }\n  - { node_id: repair-work-b, kind: agent, recipe: 'handler:repair-work-b', max_visits: 1 }\n  - { node_id: repair-join, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: repair-two, kind: agent, recipe: 'handler:repair-two', max_visits: 1 }\n",
    edges: "  - { from: repair-join, on: outcome, map: { ok: done, fail: failed } }\n  - { from: repair-two, on: outcome, map: { ok: done, fail: failed } }\n",
  });
  const source = readFileSync(path, 'utf8')
    .replace("node_id: repair, kind: agent, recipe: 'handler:repair', max_visits: 2", "node_id: repair, kind: agent, recipe: 'handler:repair', max_visits: 1")
    .replace("  - { from: repair, on: outcome, map: { ok: start, fail: failed } }", "  - { from: repair, on: outcome, branches: { ok: [repair-work-a, repair-work-b], fail: [failed, done] }, join: repair-join }");
  writeFileSync(path, source);
  let branchCalls = 0;
  const result = await runGraph(path, { runId: 'repair-explicit-edge-preempts-pending', deps: { root, inProcessHandlers: {
    start: () => ({ ok: false, outcome: 'fail' }),
    repair: () => ({ ok: true, outcome: 'ok' }),
    'repair-two': () => ({ ok: true, outcome: 'ok' }),
    'repair-work-a': () => { branchCalls++; return { ok: true, outcome: 'ok' }; },
    'repair-work-b': () => { branchCalls++; return { ok: true, outcome: 'ok' }; },
  } } });
  expect(result.status).toBe('done');
  expect(result.path).toContain('repair-two');
  expect(branchCalls).toBe(0);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: failed pending repair skips its failure fan-out', async () => {
  const { root, path } = edgeVocabGraph("  - kind: detour\n    from: start\n    on: [fail]\n    via: repair\n    rejoin: { to: done }", {
    nodes: "  - { node_id: repair-fail-a, kind: agent, recipe: 'handler:repair-fail-a', max_visits: 1 }\n  - { node_id: repair-fail-b, kind: agent, recipe: 'handler:repair-fail-b', max_visits: 1 }\n  - { node_id: repair-join, kind: gate, recipe: none, max_visits: 1 }\n",
    edges: "  - { from: repair-join, on: outcome, map: { ok: done, fail: failed } }\n",
  });
  const source = readFileSync(path, 'utf8')
    .replace('node_id: repair, kind: agent, recipe: \'handler:repair\', max_visits: 2', 'node_id: repair, kind: agent, recipe: \'handler:repair\', max_visits: 1')
    .replace("  - { from: repair, on: outcome, map: { ok: start, fail: failed } }", "  - { from: repair, on: outcome, branches: { ok: [done, failed], fail: [repair-fail-a, repair-fail-b] }, join: repair-join }");
  writeFileSync(path, source);
  let failBranchCalls = 0;
  const result = await runGraph(path, { runId: 'failed-pending-no-branch', deps: { root, inProcessHandlers: {
    start: () => ({ ok: false, outcome: 'fail' }), repair: () => ({ ok: false, outcome: 'repair-failed' }),
    'repair-fail-a': () => { failBranchCalls++; return { ok: true, outcome: 'ok' }; },
    'repair-fail-b': () => { failBranchCalls++; return { ok: true, outcome: 'ok' }; },
  } } });
  expect(result.status).toBe('failed');
  expect(result.healTransitions?.map((transition) => transition.kind)).toEqual(['detour', 'escalate']);
  expect(failBranchCalls).toBe(0);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: append recheck promotes only matching changed paths', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: append-recheck\n    from: start\n    recheck: radius\n    promote: { when: [bun.lock, 'src/**/package.json'], to: full }`, {
    nodes: `  - { node_id: radius, kind: agent, recipe: 'handler:radius', max_visits: 1 }\n  - { node_id: full, kind: agent, recipe: 'handler:full', max_visits: 1 }\n`,
    edges: `  - { from: radius, to: done }\n  - { from: full, to: done }\n`,
  });
  const handlers = { start: () => ({ ok: true, outcome: 'ok' }), repair: () => ({ ok: true, outcome: 'ok' }),
    radius: () => ({ ok: true, outcome: 'ok' }), full: () => ({ ok: true, outcome: 'ok' }) };
  const radius = await runGraph(path, { runId: 'radius-sim', input: { changedFiles: ['src/a.ts'] }, deps: { root, inProcessHandlers: handlers } });
  const full = await runGraph(path, { runId: 'full-sim', input: { changedFiles: ['bun.lock'] }, deps: { root, inProcessHandlers: handlers } });
  const glob = await runGraph(path, { runId: 'glob-sim', input: { changedFiles: ['src/nested/package.json'] }, deps: { root, inProcessHandlers: handlers } });
  const rootGlob = await runGraph(path, { runId: 'root-glob-sim', input: { changedFiles: ['src/package.json'] }, deps: { root, inProcessHandlers: handlers } });
  const unmeasured = await runGraph(path, { runId: 'unmeasured-sim', deps: { root, inProcessHandlers: handlers } });
  expect(radius.path).toEqual(['start', 'radius', 'done']);
  expect(full.path).toEqual(['start', 'full', 'done']);
  expect(glob.path).toEqual(['start', 'full', 'done']);
  expect(rootGlob.path).toEqual(['start', 'full', 'done']);
  expect(unmeasured.path).toEqual(['start', 'full', 'done']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: accept requires an unexpired ledger item and rule', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: accept\n    from: start\n    rules: [known-regression]\n    expiry: 2099-01-01\n    ledger: accepted.json\n    to: done\n    else: failed`);
  const handlers = { start: () => ({ ok: true, outcome: 'ok', evidence: { id: 'test-a', rule: 'known-regression' } }),
    repair: () => ({ ok: true, outcome: 'ok' }) };
  writeFileSync(join(root, 'accepted.json'), JSON.stringify({ items: [{ id: 'test-a', rule: 'known-regression', expiresAt: '2099-01-01' }] }));
  const accepted = await runGraph(path, { runId: 'accept-sim', deps: { root, inProcessHandlers: handlers } });
  expect(accepted.path).toEqual(['start', 'done']);
  writeFileSync(join(root, 'accepted.json'), JSON.stringify({ items: [{ id: 'test-a', rule: 'other', expiresAt: '2099-01-01' }] }));
  const rejected = await runGraph(path, { runId: 'reject-sim', deps: { root, inProcessHandlers: handlers } });
  expect(rejected.path).toEqual(['start', 'failed']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: version-count acceptance uses only canonical releaseOrder', async () => {
  const { root, path } = edgeVocabGraph("  - kind: accept\n    from: start\n    rules: [known-regression]\n    expiry: $policy.gate.accept.expiry\n    ledger: release/{{input.version}}/accepted.json\n    to: done\n    else: failed");
  const manifestPath = join(root, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { extensions: { 'ai.elanous': { graphManifests: Record<string, {
    policy: Record<string, unknown> }> } } };
  manifest.extensions['ai.elanous'].graphManifests['graph-edge-vocab-sim']!.policy['gate.accept.expiry'] = { type: 'versions', default: 1 };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const order = ['0.3.8', '0.4.0', '0.3.9', '0.4.1', '1.2.3-rc.1', '1.2.3+build.1'];
  const acceptedItem = { id: 'test-a', rule: 'known-regression', acceptedVersion: '0.3.8', expiresAt: '0.4.0' };
  for (const version of ['0.4.0', '0.3.9', '0.4.1']) {
    mkdirSync(join(root, 'release', version), { recursive: true });
    writeFileSync(join(root, 'release', version, 'accepted.json'), JSON.stringify({ items: [acceptedItem] }));
  }
  mkdirSync(join(root, 'release', '1.2.3+build.1'), { recursive: true });
  writeFileSync(join(root, 'release', '1.2.3+build.1', 'accepted.json'), JSON.stringify({ items: [{
    id: 'test-a', rule: 'known-regression', acceptedVersion: '1.2.3-rc.1', expiresAt: '1.2.3+build.1',
  }] }));
  mkdirSync(join(root, 'release', '01.2.3'), { recursive: true });
  writeFileSync(join(root, 'release', '01.2.3', 'accepted.json'), JSON.stringify({ items: [{
    id: 'test-a', rule: 'known-regression', acceptedVersion: '01.2.3', expiresAt: '01.2.3',
  }] }));
  const handlers = { start: () => ({ ok: true, outcome: 'ok', evidence: { id: 'test-a', rule: 'known-regression' } }),
    repair: () => ({ ok: true, outcome: 'ok' }) };
  const accepted = await runGraph(path, { runId: 'accepted-next-release', input: { version: '0.4.0', releaseOrder: order }, deps: { root, inProcessHandlers: handlers } });
  const maintenance = await runGraph(path, { runId: 'expired-maintenance-release', input: { version: '0.3.9', releaseOrder: order }, deps: { root, inProcessHandlers: handlers } });
  const missingOrder = await runGraph(path, { runId: 'missing-release-order', input: { version: '0.4.0' }, deps: { root, inProcessHandlers: handlers } });
  const malformedOrder = await runGraph(path, { runId: 'malformed-release-order', input: { version: '0.4.0', releaseOrder: ['0.3.8', '0.4.0', '0.4.0'] }, deps: { root, inProcessHandlers: handlers } });
  const prereleaseBuild = await runGraph(path, { runId: 'prerelease-build-release-order',
    input: { version: '1.2.3+build.1', releaseOrder: order }, deps: { root, inProcessHandlers: handlers } });
  const leadingZero = await runGraph(path, { runId: 'invalid-leading-zero-version',
    input: { version: '01.2.3', releaseOrder: ['01.2.3', '1.2.3'] }, deps: { root, inProcessHandlers: handlers } });
  const trailingNewline = await runGraph(path, { runId: 'invalid-release-order-trailing-newline',
    input: { version: '0.4.0', releaseOrder: ['0.3.8', '0.4.0', '0.4.0\n'] }, deps: { root, inProcessHandlers: handlers } });
  expect(accepted.path).toEqual(['start', 'done']);
  expect(maintenance.path).toEqual(['start', 'failed']);
  expect(missingOrder.path).toEqual(['start', 'failed']);
  expect(malformedOrder.path).toEqual(['start', 'failed']);
  expect(prereleaseBuild.path).toEqual(['start', 'done']);
  expect(leadingZero.path).toEqual(['start', 'failed']);
  expect(trailingNewline.path).toEqual(['start', 'failed']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: detour is selected before a failure fan-out runs', async () => {
  const { root, path } = edgeVocabGraph("  - kind: detour\n    from: start\n    on: [fail]\n    via: repair\n    rejoin: { to: computed }", {
    nodes: "  - { node_id: ok-a, kind: agent, recipe: 'handler:ok-a', max_visits: 1 }\n  - { node_id: ok-b, kind: agent, recipe: 'handler:ok-b', max_visits: 1 }\n  - { node_id: fail-a, kind: agent, recipe: 'handler:fail-a', max_visits: 1 }\n  - { node_id: fail-b, kind: agent, recipe: 'handler:fail-b', max_visits: 1 }\n  - { node_id: branch-join, kind: gate, recipe: none, max_visits: 1 }\n",
    edges: "  - { from: branch-join, on: outcome, map: { ok: done, fail: failed } }\n",
  });
  const source = readFileSync(path, 'utf8').replace('max_visits: 3', 'max_visits: 1')
    .replace("  - { from: start, on: outcome, map: { ok: done, fail: failed } }", "  - { from: start, on: outcome, branches: { ok: [ok-a, ok-b], fail: [fail-a, fail-b] }, join: branch-join }");
  writeFileSync(path, source);
  let starts = 0;
  let failureBranchCalls = 0;
  const result = await runGraph(path, { runId: 'retry-before-fanout', deps: { root, inProcessHandlers: {
    start: () => { starts++; return { ok: false, outcome: 'fail' }; },
    'ok-a': () => ({ ok: true, outcome: 'ok' }), 'ok-b': () => ({ ok: true, outcome: 'ok' }),
    'fail-a': () => { failureBranchCalls++; return { ok: true, outcome: 'ok' }; },
    'fail-b': () => { failureBranchCalls++; return { ok: true, outcome: 'ok' }; },
    repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('done');
  expect(starts).toBe(1);
  expect(failureBranchCalls).toBe(0);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: append-only edges do not require a failed terminal', async () => {
  const { root, path } = edgeVocabGraph("  - kind: append-recheck\n    from: start\n    recheck: done\n    promote: { when: [bun.lock], to: done }");
  let source = readFileSync(path, 'utf8').replace('terminal_nodes: [done, failed]', 'terminal_nodes: [done]')
    .replace("  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n", '')
    .replace('map: { ok: done, fail: failed }', 'map: { ok: done, fail: done }')
    .replace('map: { ok: start, fail: failed }', 'map: { ok: start, fail: done }');
  writeFileSync(path, source);
  const result = await runGraph(path, { runId: 'append-no-failed', deps: { root, inProcessHandlers: {
    start: () => ({ ok: true, outcome: 'ok' }), repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('done');
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: default exhaustion target must be declared before execution', async () => {
  const { root, path } = edgeVocabGraph("  - kind: retry\n    from: start\n    on: [fail]\n    attempts: 1");
  let calls = 0;
  const source = readFileSync(path, 'utf8').replace('terminal_nodes: [done, failed]', 'terminal_nodes: [done]')
    .replace("  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n", '')
    .replace('map: { ok: done, fail: failed }', 'map: { ok: done, fail: done }')
    .replace('map: { ok: start, fail: failed }', 'map: { ok: start, fail: done }');
  writeFileSync(path, source);
  await expect(runGraph(path, { deps: { root, inProcessHandlers: {
    start: () => { calls++; return { ok: false, outcome: 'fail' }; }, repair: () => ({ ok: true, outcome: 'ok' }),
  } } })).rejects.toThrow('must name a declared node');
  expect(calls).toBe(0);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: undeclared repair target fails before any node executes', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: heal\n    from: start\n    on: [fail]\n    classify: { classes: [broken] }\n    repair: { broken: outside }\n    attempts: 1`);
  let calls = 0;
  await expect(runGraph(path, { deps: { root, inProcessHandlers: {
    start: () => { calls++; return { ok: false, outcome: 'broken' }; }, repair: () => ({ ok: true, outcome: 'ok' }),
  } } })).rejects.toThrow('must name a declared node');
  expect(calls).toBe(0);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: escalate reaches only a declared HITL approval', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: escalate\n    from: start\n    on: [fail]\n    to: review\n    evidence: [failure-id]`, {
    header: 'hitl: [review]\n',
    nodes: `  - { node_id: review, kind: hitl, recipe: 'approval:repair-recovery', max_visits: 1 }\n`,
    edges: `  - { from: review, on: outcome, map: { ok: done, fail: failed } }\n`,
  });
  writeFileSync(join(root, 'recipes.yaml'), 'repair-recovery:\n  approval: "Review the failure evidence?"\n');
  const result = await runGraph(path, { runId: 'escalate-sim', deps: { root, inProcessHandlers: {
    start: () => ({ ok: false, outcome: 'fail' }), repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('awaiting-approval');
  expect(result.pending?.nodeId).toBe('review');
  expect(result.path).toEqual(['start', 'review']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC E3: executor leak diagnosis heals through a declared repair node', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: heal\n    from: start\n    on: [executor-leak]\n    classify: { classes: [executor-leak] }\n    repair: { executor-leak: repair }\n    attempts: 1`);
  let repaired = false;
  const result = await runGraph(path, { runId: 'e3-executor-leak', deps: { root, inProcessHandlers: {
    start: () => repaired ? { ok: true, outcome: 'ok' } : { ok: false, outcome: 'executor-leak', evidence: { class: 'executor-leak' } },
    repair: () => { repaired = true; return { ok: true, outcome: 'ok' }; },
  } } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['start', 'repair', 'start', 'done']);
  expect(result.healTransitions?.map((step) => step.kind)).toEqual(['heal', 'rejoin']);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC E9: aborted receipt retries without carrying an incomplete result', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: retry\n    from: start\n    on: [aborted]\n    attempts: 1`);
  let runs = 0;
  const result = await runGraph(path, { runId: 'e9-aborted-receipt', deps: { root, inProcessHandlers: {
    start: () => ++runs === 1 ? { ok: false, outcome: 'aborted' } : { ok: true, outcome: 'ok' },
    repair: () => ({ ok: true, outcome: 'ok' }),
  } } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['start', 'start', 'done']);
  expect(result.healTransitions?.map((step) => step.kind)).toEqual(['retry']);
  expect(result.nodes.filter((node) => node.nodeId === 'start').map((node) => node.ok)).toEqual([false, true]);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC post-cut small repair: append chooses radius and lockfile promotes full gate', async () => {
  const { root, path } = edgeVocabGraph('  - kind: retry\n    from: start\n    on: [fail]\n    attempts: 1');
  writeFileSync(path, `graph_id: graph-edge-vocab-sim\nversion: 1\nentry_node: cut-append\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: cut-append, kind: agent, recipe: 'handler:append', max_visits: 1 }\n  - { node_id: gate-recheck-radius, kind: agent, recipe: 'handler:radius', max_visits: 1 }\n  - { node_id: gate, kind: agent, recipe: 'handler:gate', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: cut-append, to: done }\n  - { from: gate-recheck-radius, to: done }\n  - { from: gate, to: done }\nheal_edges:\n  - kind: append-recheck\n    from: cut-append\n    recheck: gate-recheck-radius\n    promote: { when: [bun.lock], to: gate }\n`);
  const handlers = { append: () => ({ ok: true, outcome: 'ok' }), radius: () => ({ ok: true, outcome: 'ok' }),
    gate: () => ({ ok: true, outcome: 'ok' }) };
  const small = await runGraph(path, { runId: 'cut-small-fix', input: { changedFiles: ['src/fix.ts'] },
    deps: { root, inProcessHandlers: handlers } });
  const lock = await runGraph(path, { runId: 'cut-lock-fix', input: { changedFiles: ['bun.lock'] },
    deps: { root, inProcessHandlers: handlers } });
  expect(small.path).toEqual(['cut-append', 'gate-recheck-radius', 'done']);
  expect(lock.path).toEqual(['cut-append', 'gate', 'done']);
  expect(small.healTransitions?.[0]).toMatchObject({ edgeRef: 'heal_edges/0', kind: 'recheck', to: 'gate-recheck-radius' });
  expect(lock.healTransitions?.[0]).toMatchObject({ edgeRef: 'heal_edges/0', kind: 'recheck', to: 'gate' });
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: manifest allowlist and policy defaults govern healing', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: retry\n    from: start\n    on: [fail]\n    attempts: $policy.heal.maxAttempts`);
  const manifestPath = join(root, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { extensions: { 'ai.elanous': { graphManifests: Record<string, {
    edgeVocabulary: string[]; policy: Record<string, unknown> }> } } };
  const config = manifest.extensions['ai.elanous'].graphManifests['graph-edge-vocab-sim']!;
  config.policy['heal.maxAttempts'] = { type: 'int', default: 1 };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let calls = 0;
  const handlers = { start: () => { calls++; return { ok: false, outcome: 'fail' }; }, repair: () => ({ ok: true, outcome: 'ok' }) };
  const allowed = await runGraph(path, { runId: 'policy-retry', deps: { root, inProcessHandlers: handlers } });
  expect(allowed.path).toEqual(['start', 'start', 'failed']);
  expect(calls).toBe(2);
  config.edgeVocabulary = [];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await expect(runGraph(path, { runId: 'manifest-denied', deps: { root, inProcessHandlers: handlers } }))
    .rejects.toThrow('not declared in the plugin manifest');
  expect(calls).toBe(2);
  unlinkSync(manifestPath);
  await expect(runGraph(path, { runId: 'manifest-missing', deps: { root, inProcessHandlers: handlers } }))
    .rejects.toThrow('heal_edges require a plugin graph manifest');
  expect(calls).toBe(2);
});

test('SIM GRAPH-EDGE-VOCAB-EXEC: a saved rejoin resumes without repeating the repair', async () => {
  const { root, path } = edgeVocabGraph(`  - kind: heal\n    from: start\n    on: [fail]\n    classify: { classes: [broken] }\n    repair: { broken: repair }\n    attempts: 1`);
  let repaired = false;
  let repairCalls = 0;
  let arrivals = 0;
  const handlers = {
    start: () => repaired ? { ok: true, outcome: 'ok' } : { ok: false, outcome: 'broken', evidence: { class: 'broken' } },
    repair: () => { repaired = true; repairCalls++; return { ok: true, outcome: 'ok' }; },
  };
  await expect(runGraph(path, { runId: 'rejoin-resume', deps: { root, inProcessHandlers: handlers,
    beforeNode: () => { if (++arrivals === 3) throw new Error('simulated runner interruption'); },
  } })).rejects.toThrow('simulated runner interruption');
  const resumed = await runGraph(path, { resumeRunId: 'rejoin-resume', deps: { root, inProcessHandlers: handlers } });
  expect(resumed.status).toBe('done');
  expect(resumed.path).toEqual(['start', 'repair', 'start', 'done']);
  expect(repairCalls).toBe(1);
});
