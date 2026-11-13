import { expect, test } from 'bun:test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerGraphCommands } from './graph-cli.js';
import { decideGraphApproval, runGraph, type GraphRunState } from './runner.js';

const signed = join(homedir(), 'elanous-hq/seat-state/JUD/evidence/doorbell-30434/T6-op-waiver-v2-30582.json');
const table = join(homedir(), 'elanous-hq/seat-state/JUD/evidence/doorbell-30434/T6-known-issues-v2-final-30564.tsv');
const supplement = join(homedir(), 'elanous-hq/seat-state/JUD-C/evidence/t6-636f9e96/T6-raw-supplement-30163.tsv');
const operatingRaw = join(homedir(), '.elanous/release/0.3.15/gate-logs');
const fixture = existsSync(signed) && existsSync(table) && existsSync(supplement) ? test : test.skip;
const cut = '7d951adb3163ba16a784d5b937d12732ef9be625';
const runId = '636f9e96-0aae-4cb0-babd-b509c44e2f34';
const liveSnapshot = join(homedir(), `.elanous/graph-runs/release-loop/${runId}.json`);

fixture('CLI named approval follows one adaptive edge from a pinned old release snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-waiver-edge-'));
  const graphDir = join(root, 'graphs/release');
  const graphPath = join(graphDir, 'release-loop.yaml');
  const sourceDir = join(import.meta.dir, '../../graphs/release');
  const seen: string[] = [];
  const commands: Array<{ nodeId: string; body: string; cwd?: string }> = [];
  let pwaVisits = 0;
  try {
    cpSync(sourceDir, graphDir, { recursive: true });
    const currentGraph = readFileSync(graphPath, 'utf8');
    writeFileSync(graphPath, currentGraph.replace('waived-known-issue: traffic-gate-passed, ', ''));
    for (const [source, name] of [[signed, 'T6-op-waiver-v2-30582.json'], [table, 'T6-known-issues-v2-final-30564.tsv']] as const) {
      const dest = join(root, 'seat-state/JUD/evidence/doorbell-30434', name);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    }
    const fixtureSupplement = join(root, 'seat-state/JUD-C/evidence/t6-636f9e96/T6-raw-supplement-30163.tsv');
    mkdirSync(dirname(fixtureSupplement), { recursive: true });
    copyFileSync(supplement, fixtureSupplement);
    const raw = join(root, 'release/0.3.15/gate-logs');
    mkdirSync(join(raw, 'cut'), { recursive: true });
    const unmeasuredRows = readFileSync(supplement, 'utf8').trimEnd().split(/\r?\n/).slice(1)
      .map((line) => line.split('\t')).filter((cells) => cells[6] === 'unmeasured-receipt');
    for (const cells of unmeasuredRows) {
      copyFileSync(join(operatingRaw, 'cut', `${cells[1]}.log`), join(raw, 'cut', `${cells[1]}.log`));
      copyFileSync(join(operatingRaw, 'cut', `${cells[1]}.json`), join(raw, 'cut', `${cells[1]}.json`));
    }
    for (const shard of ['pod-68', 'pod-29', 'pod-52'])
      copyFileSync(join(operatingRaw, 'cut', `${shard}.json`), join(raw, 'cut', `${shard}.json`));
    const finalEvents = new Map<string, string>();
    for (const line of readFileSync(join(operatingRaw, 'shard-ledger.jsonl'), 'utf8').trimEnd().split(/\r?\n/)) {
      const event = JSON.parse(line) as { runId?: string; invocationId?: string; phase?: string; shardId?: string };
      if (event.runId === runId && event.invocationId === '9859f332-56f0-4b96-b9fd-fa133f7b9754' &&
          event.phase === 'cut' && event.shardId &&
          (/^pod-(?:[0-9]|[1-7][0-9])$/.test(event.shardId) || ['pod-29-n', 'pod-52-n'].includes(event.shardId)))
        finalEvents.set(event.shardId, line);
    }
    const ledgerPath = join(raw, 'shard-ledger.jsonl');
    const fixtureLedger = [...finalEvents.values()].join('\n') + '\n';
    writeFileSync(ledgerPath, fixtureLedger);
    const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string };
      seen.push(ctx.nodeId);
      commands.push({ nodeId: ctx.nodeId, body, cwd: opts.cwd });
      if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: '0.3.15', commit: cut }) + '\n', stderr: '' };
      if (ctx.nodeId === 'gate') return { exitCode: 2, stdout: JSON.stringify({ outcome: 'error', commit: cut,
        introduced: [], error: 'remote gate refused: HQ shard result batch is incomplete (pod-68)' }) + '\n', stderr: '' };
      if (ctx.nodeId === 'gate-triage') return { exitCode: 0, stdout: '{"outcome":"fail"}\n', stderr: '' };
      if (ctx.nodeId === 'pwa' && ++pwaVisits === 1) return { exitCode: 2,
        stdout: '{"outcome":"fail","verdict":"fail","summary":"gate did not pass"}\n', stderr: '' };
      return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    };
    const pending = await runGraph(graphPath, { runId, input: { version: '0.3.15', previousVersion: '0.3.14', cutCommit: cut,
      publishAt: '2026-11-13T05:00:00.000Z' }, deps: { root, runBash } });
    expect(pending.status).toBe('awaiting-approval');
    expect(pending.pending?.nodeId).toBe('gate-heal-decision');
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'unlisted-route' })).toThrow('named approval outcome');
    expect(() => decideGraphApproval('release-loop', runId, 'rejected', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('named approval outcome');
    writeFileSync(graphPath, currentGraph);
    const rawLog = join(raw, 'cut', `${unmeasuredRows[0]![1]}.log`);
    const originalRawLog = readFileSync(rawLog);
    writeFileSync(rawLog, Buffer.concat([originalRawLog, Buffer.from('tampered')]));
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('raw log reference or SHA');
    writeFileSync(rawLog, originalRawLog);
    const mutateLedger = (shard: string, change: Record<string, unknown>): void => {
      writeFileSync(ledgerPath, [...finalEvents].map(([id, line]) => id === shard
        ? JSON.stringify({ ...JSON.parse(line), ...change }) : line).join('\n') + '\n');
    };
    mutateLedger('pod-0', { attribution: 'unmeasured' });
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('final ledger unmeasured set');
    mutateLedger('pod-16', { attribution: 'complete' });
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('final ledger unmeasured set');
    mutateLedger('pod-0', { attribution: 'unknown' });
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('missing or nonterminal parent shards');
    mutateLedger('pod-29-n', { attemptId: 'different-lineage' });
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('parent and child attribution proof');
    mutateLedger('pod-29', { commit: 'b'.repeat(40) });
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('cut ledger lineage');
    mutateLedger('pod-52', { runId: 'other-run' });
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('missing or nonterminal parent shards');
    writeFileSync(ledgerPath, fixtureLedger);
    const cli = new Command();
    registerGraphCommands(cli, { root, graphRoots: [graphDir], runBash });
    await cli.parseAsync(['graph', 'approve', 'release-loop', runId, '--outcome', 'waived-known-issue', '--by', 'OP'], { from: 'user' });
    const saved = JSON.parse(readFileSync(pending.statePath, 'utf8')) as GraphRunState;
    expect(saved.runId).toBe(runId);
    expect((saved.input as { publishAt: string }).publishAt).toBe('2026-11-13T05:00:00.000Z');
    expect(saved.path).toContain('traffic-gate-passed');
    expect(saved.path).not.toContain('gate-same-run-recheck');
    expect(seen.filter((node) => node === 'gate')).toHaveLength(1);
    expect(saved.adaptiveGraphEdges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'gate-heal-decision',
      to: 'traffic-gate-passed', triggerEvent: 'release.gate.waiver' })]));
    expect(saved.status).toBe('failed');
    expect(saved.nodes.find((node) => node.nodeId === 'gate')?.ok).toBe(false);
    expect(saved.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa?.status).toBe('failed');
    const cutCheckout = join(root, 'cut-checkout');
    mkdirSync(join(cutCheckout, 'graphs/release'), { recursive: true });
    writeFileSync(join(cutCheckout, 'graphs/release/release-loop.yaml'),
      currentGraph.replace('waived-known-issue: traffic-gate-passed, ', ''));
    copyFileSync(join(sourceDir, 'recipes.yaml'), join(cutCheckout, 'graphs/release/recipes.yaml'));
    const git = (args: string[]) => args[0] === 'rev-parse' ? cut : '';
    const claimPath = `${saved.statePath}.12.decision.json`;
    const originalClaim = readFileSync(claimPath);
    const badClaim = { ...JSON.parse(originalClaim.toString()), decidedBy: 'OTHER' };
    writeFileSync(claimPath, JSON.stringify(badClaim));
    await expect(runGraph(graphPath, { resumeRunId: runId, fromNodeId: 'traffic-gate-passed',
      releaseCommandSource: { root: cutCheckout, cutTip: cut, git }, deps: { root, runBash } }))
      .rejects.toThrow('cannot preserve a failed predecessor');
    writeFileSync(claimPath, originalClaim);
    const resumed = await runGraph(graphPath, { resumeRunId: runId, fromNodeId: 'traffic-gate-passed',
      releaseCommandSource: { root: cutCheckout, cutTip: cut, git }, deps: { root, runBash } });
    expect(resumed.status).toBe('done');
    expect(resumed.nodes.find((node) => node.nodeId === 'gate')?.ok).toBe(false);
    expect(resumed.nodes.find((node) => node.nodeId === 'gate-heal-decision')?.decidedAt).toBe(saved.nodes.find((node) => node.nodeId === 'gate-heal-decision')?.decidedAt);
    expect(pwaVisits).toBe(2);
    expect(commands.find((command) => command.nodeId === 'pwa' && command.body.includes(`bun '`))?.cwd).toBe(realpathSync(cutCheckout));
    expect(commands.some((command) => command.nodeId === 'auto-approve' && command.body.includes(`bun '`))).toBe(true);
    expect(commands.some((command) => command.nodeId === 'publish' && command.body.includes(`bun '`))).toBe(true);
    expect(() => decideGraphApproval('release-loop', runId, 'approved', 'OP', root,
      { nodeId: 'gate-heal-decision', visit: 1, outcome: 'waived-known-issue' })).toThrow('not awaiting an undecided approval');
    // Replay the actual saved 636f parent snapshot in this isolated universe.
    // Stop at the first node so this checks the exact resume boundary without
    // running any release command or touching the live ledger.
    const exact = JSON.parse(readFileSync(liveSnapshot, 'utf8')) as GraphRunState;
    writeFileSync(pending.statePath, JSON.stringify({ ...exact, graphPath, statePath: pending.statePath }));
    cpSync(`${liveSnapshot}.graph`, `${pending.statePath}.graph`, { recursive: true, force: true });
    copyFileSync(`${liveSnapshot}.12.decision.json`, claimPath);
    copyFileSync(`${liveSnapshot}.graph/graph.yaml`, join(cutCheckout, 'graphs/release/release-loop.yaml'));
    copyFileSync(`${liveSnapshot}.graph/recipes.yaml`, join(cutCheckout, 'graphs/release/recipes.yaml'));
    await expect(runGraph(graphPath, { resumeRunId: runId, fromNodeId: 'traffic-gate-passed',
      releaseCommandSource: { root: cutCheckout, cutTip: cut, git },
      deps: { root, runBash, beforeNode: () => { throw new Error('exact snapshot reached execution'); } } }))
      .rejects.toThrow('exact snapshot reached execution');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
