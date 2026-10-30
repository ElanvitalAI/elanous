import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const projectRoot = new URL('../..', import.meta.url).pathname;
function executeActualRecipe(body: string, env?: Record<string, string | undefined>) {
  const output = execFileSync('/bin/bash', ['-c', body], {
    cwd: projectRoot,
    env: { ...process.env, ...env, ELANOUS_GRAPH_DIR: join(projectRoot, 'graphs/units/verbs') },
    encoding: 'utf8',
  });
  return { stdout: output, stderr: '', exitCode: 0 };
}

test('verb-make-doc receives the previous result and routes its named rework exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verbs-runner-compat-'));
  roots.push(root);
  const units = join(root, 'units');
  mkdirSync(units, { recursive: true });

  const unitPath = join(units, 'verb-make-doc.yaml');
  writeFileSync(unitPath, readFileSync(new URL('../../graphs/units/verbs/make-doc.yaml', import.meta.url), 'utf8'));
  writeFileSync(join(root, 'recipes.yaml'), 'seed:\n  command: seed\n');
  writeFileSync(join(units, 'recipes.yaml'), readFileSync(new URL('../../graphs/units/verbs/recipes.yaml', import.meta.url), 'utf8'));

  const graph = join(root, 'parent.yaml');
  writeFileSync(graph, 'graph_id: verbs-parent\nversion: 1\nentry_node: seed\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: seed, kind: agent, recipe: \'cmd:seed\', max_visits: 1 }\n  - node_id: make-doc\n    kind: subgraph\n    recipe: none\n    max_visits: 1\n    call: verb-make-doc@1\n    budget: { inner_steps: 10 }\n    contract: { inputs: [ask, context, prior], tools: worktree-write, outputs: [result, evidence] }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: observe, max_visits: 1 }\nedges:\n  - { from: seed, to: make-doc }\n  - from: make-doc\n    on: outcome\n    map: { done: done, rework: done, needs-human: failed, failed: failed }\n');

  let receivedPrior: unknown;
  const run = await runGraph(graph, {
    input: {
      ask: 'Write the feature documentation',
      context: { goal: ' ', worktree: '/tmp/verb-doc', branch: 'ux/verb-doc', 'review-intent': 'docs only' },
      prior: { result: 'prior-from-parent', evidence: { source: 'previous-proof' } },
    },
    deps: {
      root,
      runBash: async (body, opts) => {
        const contextPath = opts.env?.ELANOUS_GRAPH_CONTEXT;
        if (!contextPath) throw new Error('missing graph context for ' + body);
        const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
          input?: Record<string, unknown>;
          outputs?: Record<string, Record<string, unknown>>;
        };

        if (body.includes('seed')) return { stdout: '{"result":"seed-output"}', stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) {
          if (body.includes('make-doc-input')) receivedPrior = context.input?.prior;
          return executeActualRecipe(body, opts.env);
        }
        if (body.includes('headless-goal-loop.ts')) {
          const prepared = context.outputs?.prepare;
          return {
            stdout: JSON.stringify({ outcome: 'rework', result: 'draft kept', evidence: { prior: prepared?.prior } }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error('unexpected graph command: ' + body);
      },
    },
  });

  expect(receivedPrior).toEqual({ result: 'prior-from-parent', evidence: { source: 'previous-proof' } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['seed', 'make-doc', 'done']);
  expect(run.unitCalls?.[0]).toMatchObject({ unit: 'verb-make-doc', version: 1, exit: 'rework' });
  expect(run.nodes.find(node => node.nodeId === 'make-doc')?.output)
    .toContain('"outcome":"rework"');
  const childId = run.unitCalls![0]!.childRunId;
  const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-make-doc', childId + '.json'), 'utf8'));
  expect(child.input.prior).toEqual({ result: 'prior-from-parent', evidence: { source: 'previous-proof' } });
  expect(run.nodes.find(node => node.nodeId === 'make-doc')?.output).toContain('"source":"previous-proof"');

  for (const exit of ['done', 'needs-human', 'failed'] as const) {
    const routed = await runGraph(graph, {
      input: { ask: `Exercise make-doc ${exit}`, context: { worktree: '/tmp/verb-doc' }, prior: { evidence: { source: 'prior-proof' } } },
      deps: {
        root,
        runBash: async (body, opts) => {
          if (body.includes('seed')) return { stdout: '{"result":"seed-output"}', stderr: '', exitCode: 0 };
          if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
          if (body.includes('headless-goal-loop.ts')) return { stdout: JSON.stringify({ outcome: exit, result: `draft-${exit}`, evidence: { draft: exit } }), stderr: '', exitCode: 0 };
          throw new Error('unexpected make-doc exit command: ' + body);
        },
      },
    });
    const routedChildId = routed.unitCalls![0]!.childRunId;
    const routedChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-make-doc', routedChildId + '.json'), 'utf8'));
    expect(routed.unitCalls?.[0]?.exit).toBe(exit);
    expect(routedChild.path).toEqual(['prepare', 'document-draft', exit]);
    expect(routed.nodes.find(node => node.nodeId === 'make-doc')?.output).toContain(`"result":"draft-${exit}"`);
  }
});

test('runGraph resolves and executes the repository nested-unit fallback recipe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verbs-nested-fallback-'));
  roots.push(root);
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  mkdirSync(join(root, 'units'), { recursive: true });
  writeFileSync(join(root, 'units', 'recipes.yaml'), readFileSync(new URL('../../graphs/units/verbs/recipes.yaml', import.meta.url), 'utf8'));
  const graph = join(root, 'parent.yaml');
  writeFileSync(graph, `graph_id: nested-fallback-parent
version: 1
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: 1
    call: verb-make-doc@1
    budget: { inner_steps: 10 }
    contract: { inputs: [ask, context, prior], tools: worktree-write, outputs: [result, evidence] }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: invoke, on: outcome, map: { done: done, rework: done, needs-human: failed, failed: failed } }
`);

  const run = await runGraph(graph, {
    input: { ask: 'Exercise nested fallback', context: {}, prior: null },
    deps: { root, runBash: async (body, opts) => {
      if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
      if (body.includes('headless-goal-loop.ts')) return { stdout: JSON.stringify({ outcome: 'done', result: 'fallback executed', evidence: { exercised: true } }), stderr: '', exitCode: 0 };
      throw new Error('unexpected nested fallback command: ' + body);
    } },
  });

  expect(run.status).toBe('done');
  expect(run.unitCalls?.[0]).toMatchObject({ unit: 'verb-make-doc', exit: 'done' });
  expect(run.nodes.find(node => node.nodeId === 'invoke')?.output).toContain('"exercised":true');
});

test('research-report permits a second verify visit after the first verify exits for rework', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-report-verify-rework-'));
  roots.push(root);
  const units = join(root, 'units');
  mkdirSync(units, { recursive: true });
  for (const unit of ['research', 'make-doc', 'verify']) {
    writeFileSync(join(units, `verb-${unit}.yaml`), readFileSync(new URL(`../../graphs/units/verbs/${unit}.yaml`, import.meta.url), 'utf8'));
  }
  writeFileSync(join(units, 'recipes.yaml'), readFileSync(new URL('../../graphs/units/verbs/recipes.yaml', import.meta.url), 'utf8'));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const graph = join(root, 'research-report.yaml');
  writeFileSync(graph, readFileSync(new URL('../../graphs/work/research-report.yaml', import.meta.url), 'utf8'));

  let gateCalls = 0;
  let reviewCalls = 0;
  let failedReworkCalls = 0;
  const run = await runGraph(graph, {
    input: { ask: 'Write a short research report.', context: { worktree: '/tmp/research-report-rehearsal', branch: 'work/research-report' }, prior: null },
    deps: {
      root,
      runBash: async (body, opts) => {
        const contextPath = opts.env?.ELANOUS_GRAPH_CONTEXT;
        const context = contextPath ? JSON.parse(readFileSync(contextPath, 'utf8')) as { graphId?: string } : {};
        if (body.includes('make-doc-input')) return { stdout: JSON.stringify({ goal: 'Write the report', worktree: '/tmp/research-report-rehearsal', branch: 'work/research-report', 'review-intent': 'Review the report', prior: null }), stderr: '', exitCode: 0 };
        if (body.includes('verify-envelope')) return { stdout: JSON.stringify({ outcome: 'gate', worktree: '/tmp/research-report-rehearsal', 'changed-files': ['docs/research-report.md'], diff: 'report diff', 'review-intent': 'Review the report' }), stderr: '', exitCode: 0 };
        if (body.includes('verify-stage.ts') && body.includes(' gate')) {
          gateCalls += 1;
          return { stdout: JSON.stringify({ outcome: gateCalls === 1 ? 'fail' : 'pass', passed: gateCalls !== 1, 'gate-log': `gate-${gateCalls}` }), stderr: '', exitCode: 0 };
        }
        if (body.includes('verify-stage.ts') && body.includes(' review')) {
          reviewCalls += 1;
          return { stdout: JSON.stringify({ outcome: 'pass', verdict: 'pass', reviewed: true, 'must-fix': [], 'review-summary': 'clean' }), stderr: '', exitCode: 0 };
        }
        if (body.includes('/scripts/graph-units/verbs/research.ts')) return { stdout: JSON.stringify({ outcome: 'done', result: { result: { title: 'Write a short research report.', collectedAt: '2026-10-29T00:00:00Z', facts: ['source notes'], sources: ['https://example.test/source'] }, evidence: { sources: ['https://example.test/source'] } }, evidence: { outcome: 'complete' } }), stderr: '', exitCode: 0 };
        if (body.includes('headless-goal-loop.ts')) {
          if (context.graphId === 'verb-make-doc') return { stdout: JSON.stringify({ outcome: 'done', result: 'draft written', evidence: { 'document-drafts': ['docs/research-report.md'] } }), stderr: '', exitCode: 0 };
          failedReworkCalls += 1;
          return { stdout: JSON.stringify({ outcome: 'failed', result: 'first verification rework could not converge', evidence: { attempt: failedReworkCalls } }), stderr: '', exitCode: 0 };
        }
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected research-report command: ' + body);
      },
    },
  });

  expect(run.status).toBe('done');
  expect(run.path).toEqual(['research', 'make-doc', 'verify', 'make-doc', 'verify', 'done']);
  expect(run.unitCalls?.filter((call) => call.unit === 'verb-verify').map((call) => call.exit)).toEqual(['rework', 'done']);
  expect(gateCalls).toBe(2);
  expect(reviewCalls).toBe(1);
  expect(failedReworkCalls).toBe(1);
});

test('make-doc unit recipe resolves from its graph directory when caller cwd is empty', async () => {
  const callerCwd = mkdtempSync(join(tmpdir(), 'verbs-empty-cwd-'));
  roots.push(callerCwd);
  const graph = new URL('../../graphs/units/verbs/make-doc.yaml', import.meta.url).pathname;
  const run = await runGraph(graph, {
    input: { ask: 'Write the requested document.', context: { worktree: '/tmp/research-report' }, prior: null },
    deps: {
      root: callerCwd,
      runBash: async (body, opts) => {
        if (body.includes('/scripts/graph-units/verbs/headless-goal-loop.ts')) {
          return { stdout: JSON.stringify({ outcome: 'needs-human', result: 'test stop', evidence: { reason: 'test' } }), stderr: '', exitCode: 0 };
        }
        try {
          const result = execFileSync('/bin/bash', ['-c', body], {
            cwd: callerCwd,
            env: { ...process.env, ...opts.env },
            encoding: 'utf8',
          });
          return { stdout: result, stderr: '', exitCode: 0 };
        } catch (error) {
          const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
          return { stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? failed.message), exitCode: failed.status ?? 1 };
        }
      },
    },
  });

  expect(run.status).toBe('done');
  expect(run.path).toEqual(['prepare', 'document-draft', 'needs-human']);
  expect(run.nodes[0]?.error).toBeUndefined();
  expect(run.unitCalls).toBeUndefined();
});

test('research unit recipe starts its graph-root script from an empty caller cwd', async () => {
  const callerCwd = mkdtempSync(join(tmpdir(), 'verbs-research-empty-cwd-'));
  roots.push(callerCwd);
  const graph = new URL('../../graphs/units/verbs/research.yaml', import.meta.url).pathname;
  const run = await runGraph(graph, {
    input: { ask: '' },
    deps: {
      root: callerCwd,
      runBash: async (body, opts) => {
        try {
          const stdout = execFileSync('/bin/bash', ['-c', body], {
            cwd: callerCwd,
            env: { ...process.env, ...opts.env },
            encoding: 'utf8',
          });
          return { stdout, stderr: '', exitCode: 0 };
        } catch (error) {
          const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
          return { stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? failed.message), exitCode: failed.status ?? 1 };
        }
      },
    },
  });

  expect(run.status).toBe('failed');
  expect(run.nodes[0]?.error).toContain('verb-research input missing: ask');
  expect(run.nodes[0]?.error).not.toContain('Module not found');
});

test('verb-verify executes actual unit YAML, recipes and CLI through the default gate path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verbs-verify-runner-'));
  roots.push(root);
  const units = join(root, 'units');
  mkdirSync(units, { recursive: true });

  writeFileSync(join(units, 'verb-verify.yaml'), readFileSync(new URL('../../graphs/units/verbs/verify.yaml', import.meta.url), 'utf8'));
  writeFileSync(join(root, 'recipes.yaml'), 'seed:\n  command: seed\n');
  writeFileSync(join(units, 'recipes.yaml'), readFileSync(new URL('../../graphs/units/verbs/recipes.yaml', import.meta.url), 'utf8'));

  const graph = join(root, 'parent.yaml');
  writeFileSync(graph, `graph_id: verify-parent\nversion: 1\nentry_node: invoke\nterminal_nodes: [done, failed]\nnodes:\n  - node_id: invoke\n    kind: subgraph\n    recipe: none\n    max_visits: 1\n    call: verb-verify@1\n    budget: { inner_steps: 10 }\n    contract: { inputs: [ask, context, prior], tools: read-and-run-tests, outputs: [result, evidence] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - from: invoke\n    on: outcome\n    map: { done: done, rework: failed, 'needs-human': failed, failed: failed }\n`);

  let reviewIntentAtReviewer: unknown;
  const run = await runGraph(graph, {
    input: { ask: 'Verify the pinned change', context: { worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: { 'gate-log': 'earlier-gate.log', preserved: 'prior-proof' } } },
    deps: {
      root,
      runBash: async (body, opts) => {
        const contextPath = opts.env?.ELANOUS_GRAPH_CONTEXT;
        if (!contextPath) throw new Error('missing graph context for ' + body);
        const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
          input?: Record<string, unknown>;
          outputs?: Record<string, Record<string, unknown>>;
        };
        if (body.includes('verify-stage.ts') && body.includes(' gate')) return { stdout: JSON.stringify({ outcome: 'pass', passed: true, 'gate-log': 'fresh-gate.log' }), stderr: '', exitCode: 0 };
        if (body.includes('verify-stage.ts') && body.includes(' review')) {
          reviewIntentAtReviewer = context.outputs?.prepare?.['review-intent'];
          return { stdout: JSON.stringify({ outcome: 'pass', verdict: 'pass', 'review-summary': 'reviewed', 'must-fix': [] }), stderr: '', exitCode: 0 };
        }
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected verify graph command: ' + body);
      },
    },
  });

  expect(run.status).toBe('done');
  expect(reviewIntentAtReviewer).toBe('Verify the pinned change');
  expect(run.path).toEqual(['invoke', 'done']);
  expect(run.unitCalls?.[0]).toMatchObject({ unit: 'verb-verify', version: 1, exit: 'done' });
  expect(run.nodes.find(node => node.nodeId === 'invoke')?.output)
    .toContain('"gate-log":"fresh-gate.log"');
  expect(run.nodes.find(node => node.nodeId === 'invoke')?.output).toContain('"preserved":"prior-proof"');
  expect(run.nodes.find(node => node.nodeId === 'invoke')?.output)
    .toContain('"must-fix":[]');
  const childId = run.unitCalls![0]!.childRunId;
  const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', childId + '.json'), 'utf8'));
  expect(child.path).toEqual(['prepare', 'gate', 'review', 'done']);
  expect(child.status).toBe('done');
  expect(child.nodes.find((node: { nodeId: string }) => node.nodeId === 'done')?.output).toContain('"preserved":"prior-proof"');

  // start_at: review is the intentional resume path; the default-path run above proves gate is not skipped by default.
  const resumed = await runGraph(graph, {
    input: { ask: 'Resume review for the pinned change', context: { start_at: 'review', worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: { preserved: 'resume-proof' } } },
    deps: {
      root,
      runBash: async (body, opts) => {
        if (body.includes('verify-stage.ts') && body.includes(' review')) return { stdout: JSON.stringify({ outcome: 'pass', verdict: 'pass', review_summary: 'resumed review' }), stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected resume graph command: ' + body);
      },
    },
  });
  expect(resumed.status).toBe('done');
  const resumedChildId = resumed.unitCalls![0]!.childRunId;
  const resumedChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', resumedChildId + '.json'), 'utf8'));
  expect(resumedChild.path).toEqual(['prepare', 'review', 'done']);
  expect(resumed.nodes.find(node => node.nodeId === 'invoke')?.output).toContain('"preserved":"resume-proof"');

  let reviewCalls = 0;
  const retried = await runGraph(graph, {
    input: { ask: 'Retry after rework', context: { start_at: 'review', worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: {} } },
    deps: {
      root,
      runBash: async (body, opts) => {
        if (body.includes('verify-stage.ts') && body.includes(' review')) {
          reviewCalls += 1;
          return { stdout: JSON.stringify({ outcome: reviewCalls === 1 ? 'fail' : 'pass', verdict: reviewCalls === 1 ? 'fail' : 'pass', review_summary: `review-${reviewCalls}`, 'must-fix': reviewCalls === 1 ? ['fix me'] : [] }), stderr: '', exitCode: 0 };
        }
        if (body.includes('headless-goal-loop.ts')) return { stdout: JSON.stringify({ outcome: 'done', diff: 'reworked diff', 'must-fix': [], evidence: { 'rework-note': 'updated' } }), stderr: '', exitCode: 0 };
        if (body.includes('verify-stage.ts') && body.includes(' gate')) return { stdout: JSON.stringify({ outcome: 'pass', passed: true, 'gate-log': reviewCalls > 0 ? 'gate-after-rework' : 'test gate' }), stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected retry graph command: ' + body);
      },
    },
  });
  expect(retried.status).toBe('done');
  const retriedChildId = retried.unitCalls![0]!.childRunId;
  const retriedChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', retriedChildId + '.json'), 'utf8'));
  expect(retriedChild.path).toEqual(['prepare', 'review', 'rework-loop', 'gate', 'review', 'done']);
  const retriedOutput = retried.nodes.find(node => node.nodeId === 'invoke')?.output ?? '';
  expect(retriedOutput).toContain('"review-summary":"review-2"');
  expect(retriedOutput).toContain('"gate-log":"gate-after-rework"');
  expect(retriedChild.nodes.find((node: { nodeId: string }) => node.nodeId === 'done')?.output).toContain('"review-summary":"review-2"');
  expect(retriedChild.nodes.find((node: { nodeId: string }) => node.nodeId === 'done')?.output).toContain('"gate-log":"gate-after-rework"');

  const reworked = await runGraph(graph, {
    input: { ask: 'Resume failed review', context: { start_at: 'review', worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: { preserved: 'rework-proof', 'must-fix': ['old issue'] } } },
    deps: {
      root,
      runBash: async (body, opts) => {
        if (body.includes('verify-stage.ts') && body.includes(' review')) return { stdout: JSON.stringify({ outcome: 'fail', verdict: 'fail', 'must-fix': ['review issue'] }), stderr: '', exitCode: 0 };
        if (body.includes('headless-goal-loop.ts')) return { stdout: JSON.stringify({ outcome: 'failed', 'must-fix': ['updated issue'], evidence: { 'rework-log': 'fresh-rework.log' } }), stderr: '', exitCode: 0 };
        if (body.includes('verify-stage.ts') && body.includes(' gate')) return { stdout: JSON.stringify({ outcome: 'pass', passed: true, 'gate-log': 'test gate' }), stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected rework graph command: ' + body);
      },
    },
  });
  expect(reworked.status).toBe('failed');
  const reworkedChildId = reworked.unitCalls![0]!.childRunId;
  const reworkedChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', reworkedChildId + '.json'), 'utf8'));
  expect(reworkedChild.path).toEqual(['prepare', 'review', 'rework-loop', 'rework']);
  const reworkOutput = reworked.nodes.find(node => node.nodeId === 'invoke')?.output ?? '';
  expect(reworkOutput).toContain('"outcome":"rework"');
  expect(reworkOutput).toContain('"must-fix":["updated issue"]');
  expect(reworkOutput).toContain('"rework-log":"fresh-rework.log"');
  expect(reworkOutput).toContain('"preserved":"rework-proof"');

  const needsHuman = await runGraph(graph, {
    input: { ask: 'Escalate the review', context: { start_at: 'review', worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: {} } },
    deps: {
      root,
      runBash: async (body, opts) => {
        if (body.includes('verify-stage.ts') && body.includes(' review')) return { stdout: JSON.stringify({ outcome: 'needs-human', verdict: 'needs-human', review_summary: 'human decision required' }), stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected needs-human graph command: ' + body);
      },
    },
  });
  const needsHumanChildId = needsHuman.unitCalls![0]!.childRunId;
  const needsHumanChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', needsHumanChildId + '.json'), 'utf8'));
  expect(needsHuman.unitCalls?.[0]?.exit).toBe('needs-human');
  expect(needsHumanChild.path).toEqual(['prepare', 'review', 'needs-human']);
  expect(needsHuman.nodes.find(node => node.nodeId === 'invoke')?.output).toContain('"result":"needs-human"');

  let escalationReviewCalls = 0;
  const gateNeedsHumanAfterRework = await runGraph(graph, {
    input: { ask: 'Escalate after a retry gate', context: { start_at: 'review', worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: {} } },
    deps: {
      root,
      runBash: async (body, opts) => {
        if (body.includes('verify-stage.ts') && body.includes(' review')) {
          escalationReviewCalls += 1;
          return { stdout: JSON.stringify({ outcome: 'fail', verdict: 'fail', review_summary: 'review before retry', 'must-fix': ['retry'] }), stderr: '', exitCode: 0 };
        }
        if (body.includes('headless-goal-loop.ts')) return { stdout: JSON.stringify({ outcome: 'done', diff: 'retry diff', 'must-fix': [], evidence: { 'gate-log': 'stale-rework-gate', 'rework-note': 'done' } }), stderr: '', exitCode: 0 };
        if (body.includes('verify-stage.ts') && body.includes(' gate')) return { stdout: JSON.stringify({ outcome: 'needs-human', passed: false, 'gate-log': 'human-gate.log' }), stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected gate needs-human command: ' + body);
      },
    },
  });
  const gateNeedsHumanChildId = gateNeedsHumanAfterRework.unitCalls![0]!.childRunId;
  const gateNeedsHumanChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', gateNeedsHumanChildId + '.json'), 'utf8'));
  expect(gateNeedsHumanChild.path).toEqual(['prepare', 'review', 'rework-loop', 'gate', 'needs-human']);
  expect(gateNeedsHumanChild.nodes.find((node: { nodeId: string }) => node.nodeId === 'needs-human')?.output).toContain('"gate-log":"human-gate.log"');
  expect(gateNeedsHumanChild.nodes.find((node: { nodeId: string }) => node.nodeId === 'needs-human')?.output).not.toContain('stale-rework-gate');

  const failed = await runGraph(graph, {
    input: { ask: 'Stop on a failed gate', context: { worktree: '/tmp/verify-tree', diff: 'diff' }, prior: { evidence: {} } },
    deps: {
      root,
      runBash: async (body, opts) => {
        if (body.includes('verify-stage.ts') && body.includes(' gate')) return { stdout: JSON.stringify({ outcome: 'failed', passed: false, 'gate-log': 'gate crashed' }), stderr: '', exitCode: 0 };
        if (body.includes('/scripts/graph-units/verbs-envelope.ts')) return executeActualRecipe(body, opts.env);
        throw new Error('unexpected failed graph command: ' + body);
      },
    },
  });
  const failedChildId = failed.unitCalls![0]!.childRunId;
  const failedChild = JSON.parse(readFileSync(join(root, 'graph-runs', 'verb-verify', failedChildId + '.json'), 'utf8'));
  expect(failed.unitCalls?.[0]?.exit).toBe('failed');
  expect(failedChild.path).toEqual(['prepare', 'gate', 'failed']);
  expect(failed.nodes.find(node => node.nodeId === 'invoke')?.output).toContain('"result":"failed"');
});
