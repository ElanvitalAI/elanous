import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateFileReceiptIdentityFromClosure, gateFileReceiptClosureDigest, gateFileReceiptKey } from './gate-file-receipts.js';
import { gitClosureTree } from './gate-closure.js';
import { saveGateFileReceipt } from './gate-shard-receipts.js';
import { buildJudgedRunInventory, loadPriorJudgedRun, selectJudgedCutRadius } from './gate-radius-judged-run.js';
import { planGateRadiusWinnowAtCut } from './gate-radius-winnow.js';

test('canonical judged run loads the exact receipt and refuses a replaced CAS latest', () => {
  const repo = mkdtempSync(join(tmpdir(), 'winnow-judged-repo-'));
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'winnow-judged-ledger-'));
  const receiptRoot = join(ledgerRoot, 'receipts');
  const imageDigest = `sha256:${'c'.repeat(64)}`;
  const version = '0.3.12';
  const runId = 'prior-run';
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'TF'); git('config', 'user.email', 'tf@example.invalid');
    mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
    writeFileSync(join(repo, 'bun.lock'), 'root lock');
    writeFileSync(join(repo, 'apps/pwa/bun.lock'), 'pwa lock');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src/a.test.ts'), "import { a } from './a';\ntest('a', () => a);\n");
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'src/b.test.ts'), "import { b } from './b';\ntest('b', () => b);\n");
    git('add', '.'); git('commit', '-qm', 'prior');
    const priorCutSha = git('rev-parse', 'HEAD');
    const file = 'src/a.test.ts';
    const identity = gateFileReceiptIdentityFromClosure(gitClosureTree(repo, priorCutSha), file, imageDigest)!;
    const saved = saveGateFileReceipt(receiptRoot, { file, closureFiles: [...identity.closureFiles],
      closureDigest: gateFileReceiptClosureDigest(identity), imageDigest, key: gateFileReceiptKey(identity)!,
      sourceHead40: priorCutSha, outcome: 'pass', lane: 'cut',
      evidence: { runId, shardId: 'pod-0', testIds: [`${file} > a`] } });
    const otherFile = 'src/b.test.ts';
    const otherIdentity = gateFileReceiptIdentityFromClosure(gitClosureTree(repo, priorCutSha), otherFile, imageDigest)!;
    const otherSaved = saveGateFileReceipt(receiptRoot, { file: otherFile, closureFiles: [...otherIdentity.closureFiles],
      closureDigest: gateFileReceiptClosureDigest(otherIdentity), imageDigest, key: gateFileReceiptKey(otherIdentity)!,
      sourceHead40: priorCutSha, outcome: 'pass', lane: 'cut',
      evidence: { runId, shardId: 'pod-1', testIds: [`${otherFile} > b`] } });
    const inventory = buildJudgedRunInventory({ repo, receiptRoot, runId, cutSha: priorCutSha,
      imageDigest, measuredFiles: [file, otherFile], failures: [], errors: [] });
    expect(inventory?.files).toMatchObject([{ file, outcome: 'pass', recordSha256: saved.recordSha256 },
      { file: otherFile, outcome: 'pass', recordSha256: otherSaved.recordSha256 }]);
    const verdictDir = join(ledgerRoot, 'release', version);
    mkdirSync(verdictDir, { recursive: true });
    const verdictPath = join(verdictDir, 'gate-verdict.json');
    writeFileSync(verdictPath, JSON.stringify({ runId, commit: priorCutSha, outcome: 'ok', radiusJudgedRun: inventory }));
    const loaded = loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId });
    expect(loaded?.files[0]).toMatchObject({ file, judgedReceiptSha256: saved.recordSha256, sourceRunId: runId });
    writeFileSync(verdictPath, JSON.stringify({ runId, commit: priorCutSha, outcome: 'ok',
      radiusJudgedRun: { ...inventory!, lockfileHash: 'f'.repeat(64) } }));
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId })).toBeNull();
    writeFileSync(verdictPath, JSON.stringify({ runId, commit: priorCutSha, outcome: 'ok',
      radiusJudgedRun: { ...inventory!, files: [inventory!.files[0]!, { file: otherFile, outcome: 'fail' }] } }));
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId })).toBeNull();
    writeFileSync(verdictPath, JSON.stringify({ runId, commit: priorCutSha, outcome: 'ok', radiusJudgedRun: inventory }));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    git('add', '.'); git('commit', '-qm', 'new cut');
    const newCutSha = git('rev-parse', 'HEAD');
    expect(planGateRadiusWinnowAtCut({ repo, priorRunId: loaded!.runId, priorCutSha: loaded!.cutSha,
      priorVerdict: loaded!.verdict, priorExpectedFiles: loaded!.expectedFiles, priorFiles: loaded!.files,
      priorImageDigest: loaded!.imageDigest, priorLockfileHash: loaded!.lockfileHash,
      newCutSha, currentImageDigest: imageDigest })).toMatchObject({ action: 'radius', measure: [file],
        carry: [{ file: otherFile, sourceRunId: runId, sourceCutSha: priorCutSha }], reuseRatio: 0.5 });
    const selected = selectJudgedCutRadius({ ledgerRoot, receiptRoot, repo, version, priorRunId: runId,
      newCutSha, currentImageDigest: imageDigest });
    expect(selected).toMatchObject({
      decision: { action: 'radius', reuseRatio: 0.5 },
      plan: { priorCommit: priorCutSha, forCommit: newCutSha, files: [file], priorFailures: [], priorErrors: [] },
    });
    const newRunId = 'new-run';
    const partialInput = { repo, receiptRoot, runId: newRunId, cutSha: newCutSha, imageDigest,
      measuredFiles: [file], carriedRows: selected.carryRows, strictPassReceipts: true,
      failures: [], errors: [] };
    expect(buildJudgedRunInventory(partialInput)).toBeNull();
    const newIdentity = gateFileReceiptIdentityFromClosure(gitClosureTree(repo, newCutSha), file, imageDigest)!;
    saveGateFileReceipt(receiptRoot, { file, closureFiles: [...newIdentity.closureFiles],
      closureDigest: gateFileReceiptClosureDigest(newIdentity), imageDigest, key: gateFileReceiptKey(newIdentity)!,
      sourceHead40: newCutSha, outcome: 'pass', lane: 'cut',
      evidence: { runId: newRunId, shardId: 'pod-2', testIds: [`${file} > a`] } });
    const final = buildJudgedRunInventory(partialInput);
    expect(final?.files.map((row) => row.outcome)).toEqual(['pass', 'pass']);
    expect(final?.files.map((row) => row.file)).toEqual(inventory?.expectedFiles);
    saveGateFileReceipt(receiptRoot, { file: otherFile, closureFiles: [...otherIdentity.closureFiles],
      closureDigest: gateFileReceiptClosureDigest(otherIdentity), imageDigest, key: gateFileReceiptKey(otherIdentity)!,
      sourceHead40: newCutSha, outcome: 'pass', lane: 'cut',
      evidence: { runId: newRunId, shardId: 'pod-full', testIds: [`${otherFile} > b`] } });
    const full = buildJudgedRunInventory({ repo, receiptRoot, runId: newRunId, cutSha: newCutSha,
      imageDigest, measuredFiles: [file, otherFile], failures: [], errors: [] });
    expect(full?.files.map(({ file, outcome }) => ({ file, outcome })))
      .toEqual(final?.files.map(({ file, outcome }) => ({ file, outcome })));
    expect(full?.lockfileHash).toBe(final?.lockfileHash);
    const priorVerdict = { runId, commit: priorCutSha, outcome: 'ok', radiusJudgedRun: inventory };
    const partialVerdict = { runId: newRunId, commit: newCutSha, outcome: 'ok', radiusJudgedRun: final };
    const attemptsPath = join(verdictDir, 'gate-verdict-attempts.jsonl');
    writeFileSync(attemptsPath, `${JSON.stringify(priorVerdict)}\n${JSON.stringify(partialVerdict)}\n`);
    writeFileSync(verdictPath, JSON.stringify(partialVerdict));
    const second = loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId: newRunId });
    expect(second?.files.find((row) => row.file === otherFile)).toMatchObject({
      sourceRunId: runId, sourceJudgedVerified: true,
    });
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n');
    git('add', '.'); git('commit', '-qm', 'third cut');
    const thirdCutSha = git('rev-parse', 'HEAD');
    expect(selectJudgedCutRadius({ ledgerRoot, receiptRoot, repo, version, priorRunId: newRunId,
      newCutSha: thirdCutSha, currentImageDigest: imageDigest })).toMatchObject({
      decision: { action: 'radius', carry: [{ file: otherFile, sourceRunId: runId }], measure: [file] },
    });
    const sourceFailed = { ...priorVerdict, outcome: 'regression',
      radiusJudgedRun: { ...inventory!, files: [inventory!.files[0]!, { file: otherFile, outcome: 'fail' }] } };
    writeFileSync(attemptsPath, `${JSON.stringify(priorVerdict)}\n${JSON.stringify(partialVerdict)}\n${JSON.stringify(sourceFailed)}\n`);
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId: newRunId })).toBeNull();
    writeFileSync(attemptsPath, `${JSON.stringify(priorVerdict)}\n${JSON.stringify(partialVerdict)}\n${JSON.stringify({ ...sourceFailed, outcome: 'ok' })}\n`);
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId: newRunId })).toBeNull();
    writeFileSync(attemptsPath, `${JSON.stringify(partialVerdict)}\n`);
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId: newRunId })).toBeNull();
    writeFileSync(verdictPath, JSON.stringify(priorVerdict));
    expect(selectJudgedCutRadius({ ledgerRoot, receiptRoot, repo, version, priorRunId: runId,
      newCutSha, currentImageDigest: `sha256:${'d'.repeat(64)}` })).toMatchObject({
      decision: { action: 'full' }, plan: null,
    });
    // Replacing the latest CAS record archives the judged receipt. The exact hash still resolves.
    saveGateFileReceipt(receiptRoot, { file, closureFiles: [...identity.closureFiles],
      closureDigest: gateFileReceiptClosureDigest(identity), imageDigest, key: gateFileReceiptKey(identity)!,
      sourceHead40: priorCutSha, outcome: 'pass', lane: 'cut',
      evidence: { runId: 'other-run', shardId: 'pod-1', testIds: [`${file} > a`] } });
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId })?.files[0]?.judgedReceiptSha256)
      .toBe(saved.recordSha256);
    const forged = { ...inventory!, files: [{ ...inventory!.files[0]!, recordSha256: createHash('sha256').update('forged').digest('hex') }, inventory!.files[1]!] };
    writeFileSync(verdictPath, JSON.stringify({ runId, commit: priorCutSha, outcome: 'ok', radiusJudgedRun: forged }));
    expect(loadPriorJudgedRun({ ledgerRoot, receiptRoot, repo, version, runId })).toBeNull();
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(ledgerRoot, { recursive: true, force: true }); }
});
