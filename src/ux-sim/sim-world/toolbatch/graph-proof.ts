import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGraph } from '../../../graph-runner/runner.js';
import { dispatchRunShell } from '../../../skills/tools/shell.js';
import type { SimWorldScenario } from '../types.js';

// The graph is real; the executables are intentionally isolated fixtures, never a live cluster.
export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'RUNSHELL-GRAPH-READ', title: 'graph lifecycle drives RunShell local and approval-gated cluster reads', engines: ['graph'],
  async run(ctx) {
    const root = join(ctx.universeRoot, 'graph-runshell');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = join(root, 'calls');
    for (const name of ['eln', 'hostname', 'kubectl']) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${calls}'\nprintf '{"kind":"${name}"}'\n`);
      chmodSync(join(bin, name), 0o700);
    }
    // The v1 runner snapshots a sibling recipe file even for in-process handlers.
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const graph = join(root, 'graph.yaml');
    writeFileSync(graph, `graph_id: runshell-proof\nversion: 1\nentry_node: local\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: local, kind: agent, recipe: 'handler:local', max_visits: 1 }\n  - { node_id: cluster, kind: agent, recipe: 'handler:cluster', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: local, on: outcome, map: { done: cluster, failed: failed } }\n  - { from: cluster, on: outcome, map: { done: done, failed: failed } }\n`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    let localOK = false, clusterOK = false;
    try {
      const state = await runGraph(graph, { runId: 'proof', deps: { root, nodeLifecycle: ctx.recorder.nodeLifecycle,
        runBash: async () => { throw new Error('unexpected graph shell'); },
        inProcessHandlers: {
          local: async () => {
            const script = [ { id: 'memory', command: ['eln', 'memory', 'index'], select: ['kind'] },
              { id: 'host', command: ['hostname'], select: ['kind'] } ];
            const result = await dispatchRunShell({ script }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
            ctx.recorder.seam('RunShell.local', { script }, result);
            const selected = (JSON.parse(result.stdout) as { steps: Array<{ selected?: { kind?: string } }> }).steps.map(s => s.selected?.kind);
            localOK = result.outcome === 'exit' && selected.join(',') === 'eln,hostname';
            return { ok: localOK, outcome: localOK ? 'done' : 'failed' };
          },
          cluster: async () => {
            const script = [{ id: 'cluster', command: ['kubectl', 'get', 'pods', '-n', 'default', '-o', 'json'], select: ['kind'] }];
            const denied = await dispatchRunShell({ script }, { scriptApproval: async () => ({ allowed: false, priorHumanApproval: false }) });
            const withoutApproval = await dispatchRunShell({ script });
            const before = readFileSync(calls, 'utf8');
            const approved = await dispatchRunShell({ script }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }) });
            const unsafe = [{ id: 'local', command: ['hostname'] }, { id: 'unsafe', command: ['kubectl', 'get', 'secrets', '--raw', '/api/v1'] }];
            let rejection = '';
            try { await dispatchRunShell({ script: unsafe }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }) }); }
            catch (error) { rejection = error instanceof Error ? error.message : String(error); }
            const after = readFileSync(calls, 'utf8');
            ctx.recorder.seam('RunShell.denied', { script }, denied);
            ctx.recorder.seam('RunShell.no-approval', { script }, withoutApproval);
            ctx.recorder.seam('RunShell.approved', { script }, approved);
            ctx.recorder.seam('RunShell.unsafe', { script: unsafe }, { rejection });
            ctx.recorder.event('fixture-executions', { before, after });
            const selected = (JSON.parse(approved.stdout) as { steps: Array<{ selected?: { kind?: string } }> }).steps[0]?.selected?.kind;
            clusterOK = denied.outcome === 'denied' && withoutApproval.outcome === 'denied' && before === 'eln\nhostname\n'
              && approved.outcome === 'exit' && selected === 'kubectl' && after === 'eln\nhostname\nkubectl\n' && rejection.length > 0;
            return { ok: clusterOK, outcome: clusterOK ? 'done' : 'failed' };
          },
        },
      } });
      ctx.recorder.event('graph-result', { status: state.status, localOK, clusterOK });
      return state.status === 'done' && localOK && clusterOK ? { ok: true } : { ok: false, reason: 'graph runshell failed', diff: JSON.stringify({ status: state.status, localOK, clusterOK }) };
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  },
}];
