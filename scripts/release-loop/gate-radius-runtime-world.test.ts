import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateFileReceiptClosureDigest, gateFileReceiptIdentityFromClosure, gateFileReceiptKey } from './gate-file-receipts.js';
import { gitClosureTree } from './gate-closure.js';
import { saveGateFileReceipt } from './gate-shard-receipts.js';
import { buildJudgedRunInventory, loadPriorJudgedRun } from './gate-radius-judged-run.js';
import { judgeGate, writeGateVerdictRecord } from './gate-runtime.js';
import type { GateRunner } from './gate-types.js';

test('real judge radius verdict and full sweep agree in a two-file world', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-radius-runtime-world-'));
  const repo = join(root, 'repo');
  const ledgerRoot = join(root, 'ledger');
  const version = '1.0.1', baselineVersion = '1.0.0';
  const priorRunId = 'prior-run', newRunId = 'new-run';
  const imageDigest = `sha256:${'c'.repeat(64)}`;
  const files = ['src/a.test.ts', 'src/b.test.ts'];
  const receiptRoot = join(ledgerRoot, 'release', version, 'gate-logs', 'cut', 'receipts');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const savePass = (file: string, commit: string, runId: string) => {
    const identity = gateFileReceiptIdentityFromClosure(gitClosureTree(repo, commit), file, imageDigest)!;
    return saveGateFileReceipt(receiptRoot, { file, closureFiles: [...identity.closureFiles],
      closureDigest: gateFileReceiptClosureDigest(identity), imageDigest, key: gateFileReceiptKey(identity)!,
      sourceHead40: commit, outcome: 'pass', lane: 'cut',
      evidence: { runId, shardId: 'pod-0', testIds: [`${file} > passes`] } });
  };
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
    git('init', '-q'); git('config', 'user.name', 'TF'); git('config', 'user.email', 'tf@example.invalid');
    writeFileSync(join(repo, 'bun.lock'), 'root lock');
    writeFileSync(join(repo, 'apps/pwa/bun.lock'), 'pwa lock');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src/a.test.ts'), "import { a } from './a'; test('a', () => a);\n");
    writeFileSync(join(repo, 'src/b.test.ts'), "test('b', () => 1);\n");
    git('add', '.'); git('commit', '-qm', 'prior');
    const priorCutSha = git('rev-parse', 'HEAD');
    for (const file of files) savePass(file, priorCutSha, priorRunId);
    const priorInventory = buildJudgedRunInventory({ repo, receiptRoot, runId: priorRunId,
      cutSha: priorCutSha, imageDigest, measuredFiles: files, failures: [], errors: [] });
    expect(priorInventory?.files.map((row) => row.outcome)).toEqual(['pass', 'pass']);
    writeGateVerdictRecord(join(ledgerRoot, 'release', version, 'gate-verdict.json'),
      { runId: priorRunId, commit: priorCutSha, outcome: 'ok', radiusJudgedRun: priorInventory });
    mkdirSync(join(ledgerRoot, 'release', baselineVersion), { recursive: true });
    writeFileSync(join(ledgerRoot, 'release', baselineVersion, 'release.json'), JSON.stringify({ sourceCommit: priorCutSha }));
    writeFileSync(join(ledgerRoot, 'release', baselineVersion, 'gate-failures.json'),
      JSON.stringify({ commit: priorCutSha, failures: [], errors: [] }));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    git('add', '.'); git('commit', '-qm', 'cut');
    const newCutSha = git('rev-parse', 'HEAD');
    const sweeps: Array<readonly string[] | undefined> = [];
    let activeRunId = newRunId;
    const runner: GateRunner = {
      async command(cmd, args) {
        if (cmd === 'git' && args[0] === 'rev-parse') return { rc: 0, output: 'true\n' };
        return { rc: 0, output: '' };
      },
      async localCommand() { return { rc: 0, output: '' }; },
      async sweep(_tree, logDir, _pod, only) {
        sweeps.push(only);
        const measured = [...(only ?? files)];
        for (const file of measured) savePass(file, newCutSha, activeRunId);
        mkdirSync(logDir!, { recursive: true });
        writeFileSync(join(logDir!, 'pod-0.json'), JSON.stringify({ commit: newCutSha, files: measured,
          imageDigest, sweepId: '12345678-1234-1234-1234-123456789abc', shardCount: 1, attemptId: 'attempt-one' }));
        return { rc: 0, output: `${measured.length} pass\n0 fail\nRan ${measured.length} tests across ${measured.length} files.\n`,
          podSweep: { id: '12345678-1234-1234-1234-123456789abc', shards: 1, files: measured,
            imageDigests: [imageDigest] } };
      },
      async add() {}, async remove() {}, async snapshot() {}, async removeSnapshot() {},
    };
    const result = await judgeGate({ commit: newCutSha, version, baselineVersion, baselineCommit: priorCutSha,
      instanceRoot: ledgerRoot, ledgerRoot, scratchOnly: true, repo, graphRunId: newRunId,
      radiusWinnowOptIn: true, radiusWinnowPriorRunId: priorRunId,
      pod: { pool: 'local-pod:1', shards: 1 } }, runner, () => imageDigest);
    expect(sweeps).toEqual([['src/a.test.ts']]);
    const measuredPartialFileCount = sweeps.flat().length;
    expect(result).toMatchObject({ outcome: 'ok', radiusWinnow: { action: 'radius', reuseRatio: 0.5 },
      partial: { files: measuredPartialFileCount } });
    const verdictPath = join(ledgerRoot, 'release', version, 'gate-verdict.json');
    const partialVerdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
    expect(partialVerdict).toMatchObject({ runId: newRunId, commit: newCutSha, outcome: 'ok',
      radiusJudgedRun: { expectedFiles: files, files: [{ outcome: 'pass' }, { outcome: 'pass' }] } });
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId: newRunId })?.files)
      .toHaveLength(2);
    const fullRunId = 'full-run';
    activeRunId = fullRunId;
    const fullResult = await judgeGate({ commit: newCutSha, version, baselineVersion, baselineCommit: priorCutSha,
      instanceRoot: ledgerRoot, ledgerRoot, scratchOnly: true, repo, graphRunId: fullRunId,
      radiusWinnowOptIn: true, radiusWinnowPriorRunId: priorRunId, full: true,
      pod: { pool: 'local-pod:1', shards: 1 } }, runner, () => imageDigest);
    expect(sweeps).toEqual([['src/a.test.ts'], undefined]);
    expect(fullResult).toMatchObject({ outcome: result.outcome, introduced: result.introduced,
      preexisting: result.preexisting, radiusWinnow: { action: 'full', reuseRatio: 0 } });
    const fullInventory = buildJudgedRunInventory({ repo, receiptRoot, runId: fullRunId, cutSha: newCutSha,
      imageDigest, measuredFiles: files, failures: [], errors: [] });
    expect(fullInventory?.files.map(({ file, outcome }) => ({ file, outcome })))
      .toEqual(partialVerdict.radiusJudgedRun.files.map(({ file, outcome }: { file: string; outcome: string }) => ({ file, outcome })));
    // This minimal world has no full-gate graph pins. Its incomplete full receipt cannot replace the prior complete verdict.
    expect(JSON.parse(readFileSync(verdictPath, 'utf8'))).toMatchObject({ runId: newRunId });
    writeFileSync(verdictPath, JSON.stringify({ runId: priorRunId, commit: priorCutSha,
      outcome: 'ok', radiusJudgedRun: priorInventory }));
    activeRunId = 'contract-run';
    const previousContractSelect = process.env.ELANOUS_GATE_CONTRACT_TEST_SELECT;
    process.env.ELANOUS_GATE_CONTRACT_TEST_SELECT = '1';
    try {
      const combined = await judgeGate({ commit: newCutSha, version, baselineVersion, baselineCommit: priorCutSha,
        instanceRoot: ledgerRoot, ledgerRoot, scratchOnly: true, repo, graphRunId: activeRunId,
        radiusWinnowOptIn: true, radiusWinnowPriorRunId: priorRunId,
        pod: { pool: 'local-pod:1', shards: 1 } }, runner, () => imageDigest);
      expect(combined.radiusWinnow).toMatchObject({ action: 'full', carry: [],
        reason: 'contract test selector requires a fresh full sweep' });
      expect(sweeps.slice(2)).toHaveLength(2);
      expect(sweeps.at(-1)).toBeUndefined();
    } finally {
      if (previousContractSelect === undefined) delete process.env.ELANOUS_GATE_CONTRACT_TEST_SELECT;
      else process.env.ELANOUS_GATE_CONTRACT_TEST_SELECT = previousContractSelect;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
