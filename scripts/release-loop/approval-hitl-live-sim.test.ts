import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, runGraph } from '../../src/graph-runner/runner.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('release HITL approval waits inside the live orchestration and continues the same graph run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-hitl-live-sim-'));
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const commands: string[] = [];
  const events: string[] = [];
  const lifecycle: Array<{ event: string; graphId: string; runId: string; nodeId?: string; ok?: boolean; continuation: boolean }> = [];
  let continuationStarted = false;
  let lifecycleScope: { graphId: string; runId: string } | undefined;
  let completedBeforeHitl: string[] = [];
  const parked = deferred<Awaited<ReturnType<typeof runGraph>>>();
  const answer = deferred<'approved' | 'rejected'>();
  const waitForApproval = (event: { graphId: string; runId: string; nodeId: string }) => {
    events.push(`hitl-wait:${event.graphId}:${event.runId}:${event.nodeId}`);
    return answer.promise;
  };

  const runBash = async (body: string) => {
    commands.push(body);
    const autoApproval = body.includes('auto-approve-node.ts');
    const node = body.includes('version-node.ts release') ? 'version-release'
      : body.includes('prepare-node.ts') ? 'prepare'
        : body.includes('docs-node.ts') ? 'docs'
          : body.includes('publish-node.ts') ? 'publish' : 'other';
    const fields = node === 'version-release' ? { commit: 'a'.repeat(40) }
      : node === 'prepare' ? { commit: 'a'.repeat(40), candidate: join(root, 'elanous.tgz'), out: join(root, 'prepared') }
        : node === 'docs' ? { branch: 'release-docs/9.9.9', worktree: join(root, 'docs-tree') }
          : node === 'publish' ? { tag: 'v9.9.9' } : {};
    return {
      exitCode: autoApproval ? 1 : 0,
      stdout: JSON.stringify({ outcome: autoApproval ? 'fail' : 'ok', verdict: autoApproval ? 'fail' : 'pass', summary: node, ...fields }) + '\n',
      stderr: '',
    };
  };
  const deps = {
    root,
    runBash,
    log: (event: string, data: Record<string, unknown>) => {
      events.push(event);
      if (event === 'node-start' || event === 'node-end') {
        lifecycle.push({ event, graphId: String(data.graphId), runId: String(data.runId), nodeId: String(data.nodeId),
          ok: data.ok === true, continuation: continuationStarted });
      }
      if (event === 'approval-pending') events.push(`pending:${String(data.runId)}:${String(data.nodeId)}`);
      if (event === 'node-start' && data.nodeId === 'publish') events.push(`publish:${String(data.runId)}`);
    },
  };

  try {
    // The live controller stays pending at the HITL boundary while waiting for the simulated human event.
    const liveRun = (async () => {
      const first = await runGraph(graph, { input: { version: '9.9.9', previousVersion: '0.2.3' }, deps });
      parked.resolve(first);
      if (first.status !== 'awaiting-approval' || !first.pending) return first;
      lifecycleScope = { graphId: first.graphId, runId: first.runId };
      completedBeforeHitl = [...new Set(lifecycle
        .filter((item) => item.graphId === first.graphId && item.runId === first.runId && item.event === 'node-end' && item.ok)
        .map((item) => item.nodeId!))];

      const decision = await waitForApproval({ graphId: first.graphId, runId: first.runId, nodeId: first.pending.nodeId });
      decideGraphApproval(first.graphId, first.runId, decision, 'simulated-approver', root);
      events.push(`answer:${first.runId}:${decision}`);
      continuationStarted = true;
      return runGraph(graph, { resumeRunId: first.runId, deps });
    })();
    void liveRun.catch((error: unknown) => parked.reject(error));

    const pending = await parked.promise;
    expect(pending.status).toBe('awaiting-approval');
    expect(pending.pending).toMatchObject({ nodeId: 'approve-publish' });
    expect(pending.path.at(-1)).toBe('approve-publish');
    expect(commands.some((command) => command.includes('publish-node.ts'))).toBe(false);
    expect(events).toContain('approval-pending');
    expect(events).toContain(`hitl-wait:${pending.graphId}:${pending.runId}:approve-publish`);
    expect(events.some((event) => event.startsWith('publish:'))).toBe(false);

    let completed = false;
    void liveRun.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    answer.resolve('approved');

    const done = await liveRun;
    expect(done.status).toBe('done');
    expect(done.graphId).toBe(pending.graphId);
    expect(done.runId).toBe(pending.runId);
    expect(done.path.slice(done.path.indexOf('approve-publish'))).toEqual([
      'approve-publish', 'publish', 'npm-publish', 'traffic-npm-published', 'release-post-publish-join',
      'verify', 'traffic-verify-complete', 'vault-note', 'release-story', 'ops-upgrade', 'done',
    ]);
    expect(events.filter((event) => event === `publish:${pending.runId}`)).toHaveLength(1);
    expect(events.indexOf('approval-pending')).toBeLessThan(events.findIndex((event) => event.startsWith(`answer:${pending.runId}:`)));
    expect(events.findIndex((event) => event.startsWith(`answer:${pending.runId}:`))).toBeLessThan(events.findIndex((event) => event.startsWith(`publish:${pending.runId}`)));
    expect(commands.some((command) => command.includes('graph-cli.ts') && command.includes('resume'))).toBe(false);

    const inSameRun = (item: typeof lifecycle[number]) => item.graphId === lifecycleScope?.graphId && item.runId === lifecycleScope?.runId;
    const resumedNodeIds = new Set(lifecycle.filter((item) => inSameRun(item) && item.continuation && item.event === 'node-start').map((item) => item.nodeId));
    const skippedNodeIds = completedBeforeHitl.filter((nodeId) => !resumedNodeIds.has(nodeId));
    const rerunNodeIds = lifecycle
      .filter((item) => inSameRun(item) && item.continuation && item.event === 'node-start' && completedBeforeHitl.includes(item.nodeId!))
      .map((item) => item.nodeId);
    const cutMeasurement = {
      graphId: done.graphId,
      runId: done.runId,
      reused: skippedNodeIds.length,
      rerun: rerunNodeIds.length,
      rerunNodeIds,
      skippedNodeIds,
    };
    console.info(`[release-cut-measurement] ${JSON.stringify(cutMeasurement)}`);
    expect(cutMeasurement.reused).toBe(14);
    expect(skippedNodeIds).toHaveLength(14);
    expect(cutMeasurement.rerun).toBe(0);
    expect(skippedNodeIds).toEqual([
      'version-release', 'traffic-cut-start', 'cutoff', 'export-check', 'pre-gate-join', 'gate',
      'traffic-gate-passed', 'pre-prepare-join', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues', 'notes-check',
    ]);
    expect(rerunNodeIds).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
