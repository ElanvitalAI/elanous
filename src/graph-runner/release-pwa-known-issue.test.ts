import { expect, spyOn, test } from 'bun:test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assertPwaOutputBoundToChild, assertSignedT6PwaBranchWaiver, T6_PWA_WAIVER } from './release-pwa-known-issue.js';
import { runGraph, type GraphRunState } from './runner.js';
import { Command } from 'commander';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { signedT6PwaKnownIssue, type GraphContext } from '../../scripts/release-loop/node-verdict.js';

const hq = join(homedir(), 'elanous-hq/seat-state');
const live = join(homedir(), `.elanous/graph-runs/release-loop/${T6_PWA_WAIVER.runId}.json`);
const evidence = [
  'OP/evidence/20261113/T6-PWA-KNOWN-ISSUE-OP.md',
  'JUD/evidence/doorbell-30984/T6-PWA-JUD-confirmation.json',
  'REL/evidence/T6-PWA-PAIR-0314-1335/paired.log',
  'JUD/evidence/doorbell-30954/independent-pair-proof.json',
] as const;
const fixture = existsSync(live) && evidence.every((file) => existsSync(join(hq, file))) ? test : test.skip;

test('the pinned child state binds every byte of the PWA output in CI', () => {
  const output = JSON.stringify({ outcome: 'fail', cells: [{ id: 'N1', first: 'fail', final: 'fail' }], tail: 'original' });
  const child = Buffer.from(JSON.stringify({ graphId: 'release-loop', runId: 'fixture-child', status: 'failed',
    nodes: [{ nodeId: 'pwa', output }] }));
  const pinned = createHash('sha256').update(child).digest('hex');
  expect(() => assertPwaOutputBoundToChild(output, child, pinned, 'fixture-child')).not.toThrow();
  expect(() => assertPwaOutputBoundToChild(output.replace('"first":"fail"', '"first":"pass"'), child, pinned, 'fixture-child'))
    .toThrow('whole output differs');
  expect(() => assertPwaOutputBoundToChild(output, Buffer.concat([child, Buffer.from(' ')]), pinned, 'fixture-child'))
    .toThrow('child state SHA differs');
});

fixture('signed PWA fan-out waiver rejects absent signature and different run or cut', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-waiver-reject-'));
  try {
    const state = JSON.parse(readFileSync(live, 'utf8')) as GraphRunState;
    expect(() => assertSignedT6PwaBranchWaiver(state, root)).toThrow();
    for (const file of evidence) {
      const dest = join(root, 'seat-state', file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(hq, file), dest);
    }
    for (const file of [
      'JUD/evidence/doorbell-30434/T6-op-waiver-v2-30582.json',
      'JUD/evidence/doorbell-30434/T6-known-issues-v2-final-30564.tsv',
      'JUD-C/evidence/t6-636f9e96/T6-raw-supplement-30163.tsv',
    ]) {
      const dest = join(root, 'seat-state', file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(hq, file), dest);
    }
    mkdirSync(join(root, 'release/0.3.15'), { recursive: true });
    symlinkSync(join(homedir(), '.elanous/release/0.3.15/gate-logs'), join(root, 'release/0.3.15/gate-logs'));
    mkdirSync(join(root, 'graph-runs/release-loop'), { recursive: true });
    copyFileSync(join(homedir(), `.elanous/graph-runs/release-loop/${T6_PWA_WAIVER.childRun}.json`),
      join(root, 'graph-runs/release-loop', `${T6_PWA_WAIVER.childRun}.json`));
    expect(() => assertSignedT6PwaBranchWaiver(state, root)).not.toThrow();
    expect(() => assertSignedT6PwaBranchWaiver({ ...state, runId: 'other-run' }, root)).toThrow('exact failed T6');
    expect(() => assertSignedT6PwaBranchWaiver({ ...state, input: { ...(state.input as object), cutCommit: 'a'.repeat(40) } }, root)).toThrow('exact failed T6');
    const changed = structuredClone(state);
    const branch = changed.fanOuts!['traffic-gate-passed:ok']!.branches.pwa!;
    const output = JSON.parse(String(branch.output)) as { cells: Array<{ id: string; first: string }> };
    output.cells.find((cell) => cell.id === 'N1')!.first = 'pass';
    branch.output = JSON.stringify(output);
    expect(() => assertSignedT6PwaBranchWaiver(changed, root)).toThrow('whole output differs');
    rmSync(join(root, 'seat-state/JUD/evidence/doorbell-30984/T6-PWA-JUD-confirmation.json'));
    expect(() => assertSignedT6PwaBranchWaiver(state, root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

fixture('real graph resume counts the signed PWA branch as waived and preserves its failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-waiver-resume-'));
  const graphPath = join(root, 'graphs/release/release-loop.yaml');
  const statePath = join(root, 'graph-runs/release-loop', `${T6_PWA_WAIVER.runId}.json`);
  const cutCheckout = join(root, 'cut-checkout');
  try {
    const original = JSON.parse(readFileSync(live, 'utf8')) as GraphRunState;
    mkdirSync(dirname(statePath), { recursive: true });
    mkdirSync(dirname(graphPath), { recursive: true });
    mkdirSync(join(cutCheckout, 'graphs/release'), { recursive: true });
    mkdirSync(join(cutCheckout, 'apps/pwa'), { recursive: true });
    const state = { ...original, statePath, graphPath };
    writeFileSync(statePath, JSON.stringify(state));
    cpSync(`${live}.graph`, `${statePath}.graph`, { recursive: true });
    copyFileSync(`${live}.12.decision.json`, `${statePath}.12.decision.json`);
    copyFileSync(`${live}.graph/graph.yaml`, graphPath);
    copyFileSync(`${live}.graph/graph.yaml`, join(cutCheckout, 'graphs/release/release-loop.yaml'));
    copyFileSync(`${live}.graph/recipes.yaml`, join(cutCheckout, 'graphs/release/recipes.yaml'));
    for (const file of evidence) {
      const dest = join(root, 'seat-state', file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(hq, file), dest);
    }
    for (const file of [
      'JUD/evidence/doorbell-30434/T6-op-waiver-v2-30582.json',
      'JUD/evidence/doorbell-30434/T6-known-issues-v2-final-30564.tsv',
      'JUD-C/evidence/t6-636f9e96/T6-raw-supplement-30163.tsv',
    ]) {
      const dest = join(root, 'seat-state', file);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(hq, file), dest);
    }
    mkdirSync(join(root, 'release/0.3.15'), { recursive: true });
    symlinkSync(join(homedir(), '.elanous/release/0.3.15/gate-logs'), join(root, 'release/0.3.15/gate-logs'));
    copyFileSync(join(homedir(), `.elanous/graph-runs/release-loop/${T6_PWA_WAIVER.childRun}.json`),
      join(root, 'graph-runs/release-loop', `${T6_PWA_WAIVER.childRun}.json`));
    symlinkSync(join(homedir(), 'source/elanous-agent/node_modules'), join(cutCheckout, 'node_modules'));
    symlinkSync(join(homedir(), 'source/elanous-agent/apps/pwa/node_modules'), join(cutCheckout, 'apps/pwa/node_modules'));
    const trafficFile = join(root, 'traffic.json');
    writeFileSync(trafficFile, '{}\n');
    const beforeCli = readFileSync(statePath, 'utf8');
    const cli = new Command();
    const git = (args: string[]) => args[0] === 'rev-parse' ? T6_PWA_WAIVER.cut : '';
    setElanousConfigDir(root);
    registerReleaseCommands(cli, {}, {}, {}, {}, {}, {
      root, repo: cutCheckout, trafficFile, git, commandRootGit: git,
    });
    const lines: string[] = [];
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
    try {
      await cli.parseAsync(['release', 'resume', '--run', T6_PWA_WAIVER.runId, '--from', 'pwa', '--waive', 'pwa',
        '--reason', 'Some web checks still fail. Existing users can retry later.', '--command-root', cutCheckout, '--dry-run', '--json'], { from: 'user' });
    } finally { stdout.mockRestore(); }
    expect(JSON.parse(lines[0]!) as { ok: boolean; error?: string }).toMatchObject({ ok: true });
    expect(readFileSync(statePath, 'utf8')).toBe(beforeCli);
    let pwaCalls = 0;
    const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string };
      if (context.nodeId === 'pwa') pwaCalls++;
      if (context.nodeId === 'traffic-gate-passed') return { exitCode: 0,
        stdout: String(original.nodes.find((node) => node.nodeId === 'traffic-gate-passed')?.output) + '\n', stderr: '' };
      return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    };
    await expect(runGraph(graphPath, { resumeRunId: T6_PWA_WAIVER.runId, fromNodeId: 'traffic-gate-passed',
      releasePwaFanOutWaiver: { reason: 'Some web checks still fail. Existing users can retry later.' },
      releaseCommandSource: { root: cutCheckout, cutTip: T6_PWA_WAIVER.cut, git: (args) => args[0] === 'rev-parse' ? T6_PWA_WAIVER.cut : '' },
      deps: { root, runBash, beforeNode: () => {
        const current = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
        if (current.nodes.some((node) => node.nodeId === 'pre-prepare-join' && node.ok)) throw new Error('join passed; stop before prepare');
      } } })).rejects.toThrow('join passed; stop before prepare');
    const resumed = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
    const pwa = resumed.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa;
    expect(resumed.nodes.find((node) => node.nodeId === 'pre-prepare-join')?.ok).toBe(true);
    expect(JSON.parse(String(resumed.nodes.find((node) => node.nodeId === 'pre-prepare-join')?.output)).branchVerdicts)
      .toMatchObject({ pwa: 'waived', 'export-check': 'pass', 'mac-smoke': 'pass' });
    expect(pwa?.status).toBe('failed');
    expect(pwa?.output).toBe(original.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa?.output);
    expect(pwa?.waiver?.verdict).toBe('waived');
    expect(pwaCalls).toBe(0);
    const context: GraphContext = { graphId: 'release-loop', runId: T6_PWA_WAIVER.runId,
      input: { version: '0.3.15', previousVersion: '0.3.14' }, outputs: {
        'version-release': { commit: T6_PWA_WAIVER.cut },
        pwa: JSON.parse(String(pwa?.output)) as Record<string, unknown>,
      } };
    expect(signedT6PwaKnownIssue(context, root)).toBe(true);
    expect(signedT6PwaKnownIssue({ ...context, runId: 'other-run' }, root)).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
