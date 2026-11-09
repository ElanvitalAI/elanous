import { expect, test } from 'bun:test';
import { loadCutKeyDiffCommits, lookupMainSameKeyReceipts, triageFailureKeyDiff, type FileCasKey } from './gate-key-diff.js';
import { triageRegressionKeyDiffs } from './gate-triage-node.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateFileReceiptIdentityFromClosure, gateFileReceiptKey } from './gate-file-receipts.js';
import { saveGateFileReceipt } from './gate-shard-receipts.js';
import { gitClosureTree } from './gate-closure.js';

const hash = (char: string) => char.repeat(64);
const commit = (char: string) => char.repeat(40);
const base: FileCasKey = { file: 'test/regression.test.ts', imageDigest: `sha256:${hash('a')}`,
  closure: { 'test/regression.test.ts': hash('1'), 'src/one.ts': hash('2'), 'src/two.ts': hash('3') } };
const cut: FileCasKey = { ...base, closure: { ...base.closure, 'src/one.ts': hash('4'), 'src/two.ts': hash('5') } };

test('key-diff simulation: two appended commits identify their changed closure inputs and PRs', () => {
  const result = triageFailureKeyDiff({ failureId: 'test/regression.test.ts > fails', base, cut,
    commits: [
      { commit: commit('a'), prNumber: 101, changedFiles: ['src/one.ts', 'docs/unrelated.md'] },
      { commit: commit('b'), prNumber: 102, changedFiles: ['src/two.ts'] },
    ], mainReceipts: [{ key: cut, status: 'pass', verified: true }] });
  expect(result).toEqual({ status: 'attributed', failureId: 'test/regression.test.ts > fails',
    changedInputs: ['src/one.ts', 'src/two.ts'], candidates: [
      { commit: commit('a'), prNumber: 101, changedInputs: ['src/one.ts'] },
      { commit: commit('b'), prNumber: 102, changedInputs: ['src/two.ts'] },
    ], mainSameKey: 'pass' });
});

test('same-key main fix requires verified and consistent receipts', () => {
  const input = { failureId: 'test/regression.test.ts > fails', base, cut,
    commits: [{ commit: commit('a'), prNumber: 101, changedFiles: ['src/one.ts', 'src/two.ts'] }] };
  expect(triageFailureKeyDiff({ ...input, mainReceipts: [{ key: cut, status: 'pass', verified: false }] }))
    .toMatchObject({ mainSameKey: 'absent' });
  expect(triageFailureKeyDiff({ ...input, mainReceipts: [
    { key: cut, status: 'pass', verified: true }, { key: cut, status: 'fail', verified: true },
  ] })).toMatchObject({ mainSameKey: 'absent' });
});

test('opaque is the only bisect fallback; missing attribution fails closed', () => {
  const input = { failureId: 'test/regression.test.ts > fails', base, cut,
    commits: [{ commit: commit('a'), prNumber: 101, changedFiles: ['src/one.ts'] }], mainReceipts: [] };
  expect(triageFailureKeyDiff({ ...input, cut: { ...cut, opaqueReason: 'dynamic fixture read' } }))
    .toMatchObject({ status: 'opaque', fallback: 'bisect' });
  expect(triageFailureKeyDiff(input)).toMatchObject({ status: 'unmeasured',
    reason: 'changed key inputs lack complete commit attribution' });
  expect(triageFailureKeyDiff({ ...input, cut: base })).toMatchObject({ status: 'unmeasured',
    reason: 'same key cannot explain an introduced failure' });
  expect(triageFailureKeyDiff({ ...input, commits: [{ commit: commit('a'), changedFiles: ['src/one.ts', 'src/two.ts'] }] }))
    .toMatchObject({ status: 'unmeasured', reason: 'changed key inputs lack complete commit attribution' });
  expect(triageFailureKeyDiff({ ...input, commits: [
    { commit: commit('a'), prNumber: 101, changedFiles: ['src/one.ts', 'src/two.ts'] },
    { commit: commit('b'), changedFiles: ['src/one.ts'] },
  ] })).toMatchObject({ status: 'unmeasured', reason: 'changed key inputs lack complete commit attribution' });
});

test('regression triage requires exactly one comparison for each failed identity', () => {
  const failureId = 'test/regression.test.ts > fails';
  const row = { failureId, base, cut, commits: [{ commit: commit('a'), prNumber: 101, changedFiles: ['src/one.ts', 'src/two.ts'] }],
    mainReceipts: [] };
  expect(triageRegressionKeyDiffs([failureId], [row])).toMatchObject([{ status: 'attributed' }]);
  expect(triageRegressionKeyDiffs([failureId], [row, row])).toMatchObject([{ status: 'unmeasured' }]);
  expect(triageRegressionKeyDiffs([failureId], [])).toMatchObject([{ status: 'unmeasured' }]);
});

test('opaque regression evidence stays on bisect fallback when git history is unavailable', () => {
  const failureId = 'test/regression.test.ts > fails';
  const row = { failureId, base, cut: { ...cut, opaqueReason: 'subprocess input is opaque' },
    commits: [], mainReceipts: [] };
  expect(triageRegressionKeyDiffs([failureId], [row], {
    repo: '/missing/repository', mainTip: '', mainReceiptRoot: '/missing/receipts',
  })).toEqual([{ status: 'opaque', failureId, reason: 'subprocess input is opaque', fallback: 'bisect' }]);
});

test('0.3.7 replay sim: all 31 introduced failures resolve through two append PRs and same-key main receipts', () => {
  const repo = mkdtempSync(join(tmpdir(), 'key-diff-31-replay-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const introducedIds = Array.from({ length: 31 }, (_, index) => {
    const file = `test/replay-${String(index + 1).padStart(2, '0')}.test.ts`;
    return `${file} > introduced failure`;
  });
  const receiptRoot = join(repo, 'receipts');
  try {
    git('init', '-q'); git('config', 'user.name', '31 failure replay'); git('config', 'user.email', 'replay@example.test');
    mkdirSync(join(repo, 'src/replay'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'src/replay/first.ts'), 'first: base\n');
    writeFileSync(join(repo, 'src/replay/second.ts'), 'second: base\n');
    for (const failureId of introducedIds) writeFileSync(join(repo, failureId.split(' > ')[0]!), 'fixture\n');
    git('add', 'src', 'test'); git('commit', '-qm', 'baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/replay/first.ts'), 'first: cut\n');
    git('add', 'src/replay/first.ts'); git('commit', '-qm', 'append first closure input (#35941)');
    writeFileSync(join(repo, 'src/replay/second.ts'), 'second: cut\n');
    git('add', 'src/replay/second.ts'); git('commit', '-qm', 'append second closure input (#35960)');
    const mainTip = git('rev-parse', 'HEAD');
    const rows = introducedIds.map((failureId, index) => {
      const file = failureId.split(' > ')[0]!;
      const changed = index % 2 === 0 ? 'src/replay/first.ts' : 'src/replay/second.ts';
      const baseKey: FileCasKey = { file, imageDigest: `sha256:${hash('a')}`,
        closure: { [file]: hash('1'), [changed]: hash('2') } };
      const cutKey: FileCasKey = { ...baseKey, closure: { ...baseKey.closure, [changed]: hash('3') } };
      const key = gateFileReceiptKey({ file, imageDigest: cutKey.imageDigest,
        closureFiles: Object.keys(cutKey.closure), contentHashes: cutKey.closure });
      if (!key) throw new Error(`receipt key missing for ${failureId}`);
      const closureFiles = Object.keys(cutKey.closure).sort();
      const closureDigest = createHash('sha256').update(JSON.stringify(closureFiles.map((path) => [path, cutKey.closure[path]]))).digest('hex');
      saveGateFileReceipt(receiptRoot, { file, closureFiles, closureDigest, imageDigest: cutKey.imageDigest,
        key, sourceHead40: mainTip, lane: 'train', outcome: 'pass', evidence: {} });
      return { failureId, base: baseKey, cut: cutKey, commits: [], mainReceipts: [], baseCommit, cutCommit: mainTip };
    });
    const results = triageRegressionKeyDiffs(introducedIds, rows, { repo, mainTip, mainReceiptRoot: receiptRoot });
    expect(results).toHaveLength(31);
    expect(results.every((result) => result.status === 'attributed' && result.mainSameKey === 'pass')).toBe(true);
    expect(results.map((result) => result.status === 'attributed' ? result.candidates[0]?.prNumber : undefined))
      .toEqual(introducedIds.map((_, index) => index % 2 === 0 ? 35941 : 35960));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('0.3.7 replay: 74 recorded identities with opaque historical closures fall back to bisect', () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/gate-0307-key-diff.json'), 'utf8')) as {
    identities?: Array<{ failureId: string; base: FileCasKey; cut: FileCasKey }>;
    commits?: Array<{ commit: string; changedFiles: string[]; prNumber?: number }>;
  };
  const identities = fixture.identities ?? [];
  const failureIds = identities.map((row) => row.failureId);
  const rows = identities.map((row) => ({ ...row, commits: fixture.commits ?? [], mainReceipts: [] }));
  const results = triageRegressionKeyDiffs(failureIds, rows);
  const counts = {
    identities: failureIds.length,
    attributed: results.filter((result) => result.status === 'attributed').length,
    opaque: results.filter((result) => result.status === 'opaque').length,
    unmeasured: results.filter((result) => result.status === 'unmeasured').length,
  };
  console.info(`[gate-key-diff 0.3.7] ${JSON.stringify(counts)}; aggregate summary=31; detailed identities=74`);
  expect(failureIds).toHaveLength(74);
  expect(results).toHaveLength(74);
  expect(counts).toEqual({ identities: 74, attributed: 0, opaque: 74, unmeasured: 0 });
  expect(results.every((result) => result.status === 'opaque' && result.fallback === 'bisect')).toBe(true);
}, 120_000);

test('cut first-parent history supplies actual changed files and PR identities for two appends', () => {
  const repo = mkdtempSync(join(tmpdir(), 'key-diff-history-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'Key diff sim'); git('config', 'user.email', 'sim@example.test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/one.ts'), 'one');
    writeFileSync(join(repo, 'src/two.ts'), 'two');
    git('add', 'src/one.ts', 'src/two.ts'); git('commit', '-qm', 'base');
    const baseline = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/one.ts'), 'changed one');
    git('add', 'src/one.ts'); git('commit', '-qm', 'fix one (#101)');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/two.ts'), 'changed two');
    git('add', 'src/two.ts'); git('commit', '-qm', 'fix two (#102)');
    const second = git('rev-parse', 'HEAD');
    expect(loadCutKeyDiffCommits(repo, baseline, second)).toEqual([
      { commit: first, prNumber: 101, changedFiles: ['src/one.ts'] },
      { commit: second, prNumber: 102, changedFiles: ['src/two.ts'] },
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('actual git closure snapshots connect changed content hashes to the attributed PR', () => {
  const repo = mkdtempSync(join(tmpdir(), 'key-diff-actual-closure-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const imageDigest = `sha256:${hash('a')}`;
  const file = 'test/regression.test.ts';
  try {
    git('init', '-q'); git('config', 'user.name', 'Key diff actual closure');
    git('config', 'user.email', 'actual-closure@example.test');
    mkdirSync(join(repo, 'src/replay'), { recursive: true }); mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, file), "import { value } from '../src/replay/input.js';\nexport const result = value;\n");
    writeFileSync(join(repo, 'src/replay/input.ts'), 'export const value = 1;\n');
    git('add', 'test', 'src'); git('commit', '-qm', 'base');
    const baseCommit = git('rev-parse', 'HEAD');
    const baseIdentity = gateFileReceiptIdentityFromClosure(gitClosureTree(repo, baseCommit), file, imageDigest);
    expect(baseIdentity).not.toBeNull();
    writeFileSync(join(repo, 'src/replay/input.ts'), 'export const value = 2;\n');
    git('add', 'src/replay/input.ts'); git('commit', '-qm', 'append closure input (#103)');
    const cutCommit = git('rev-parse', 'HEAD');
    const cutIdentity = gateFileReceiptIdentityFromClosure(gitClosureTree(repo, cutCommit), file, imageDigest);
    expect(cutIdentity).not.toBeNull();
    const toKey = (identity: NonNullable<typeof baseIdentity>): FileCasKey => ({ file: identity.file, imageDigest,
      closure: identity.contentHashes });
    const verdict = triageFailureKeyDiff({ failureId: `${file} > fails`, base: toKey(baseIdentity!), cut: toKey(cutIdentity!),
      commits: loadCutKeyDiffCommits(repo, baseCommit, cutCommit)!, mainReceipts: [] });
    expect(baseIdentity!.contentHashes['src/replay/input.ts']).not.toBe(cutIdentity!.contentHashes['src/replay/input.ts']);
    expect(verdict).toMatchObject({ status: 'attributed', changedInputs: ['src/replay/input.ts'],
      candidates: [{ prNumber: 103, changedInputs: ['src/replay/input.ts'] }] });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('main same-key lookup reads checksum-verified train receipts on main ancestry', () => {
  const repo = mkdtempSync(join(tmpdir(), 'key-diff-main-'));
  const root = join(repo, 'receipts');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'Key diff sim'); git('config', 'user.email', 'sim@example.test');
    writeFileSync(join(repo, 'README.md'), 'base');
    git('add', 'README.md'); git('commit', '-qm', 'base');
    const mainTip = git('rev-parse', 'HEAD');
    const key = gateFileReceiptKey({ file: cut.file, imageDigest: cut.imageDigest,
      closureFiles: Object.keys(cut.closure), contentHashes: cut.closure });
    if (!key) throw new Error('fixture key missing');
    const closureFiles = Object.keys(cut.closure).sort();
    const closureDigest = createHash('sha256').update(JSON.stringify(closureFiles.map((file) => [file, cut.closure[file]]))).digest('hex');
    saveGateFileReceipt(root, { file: cut.file, closureFiles,
      closureDigest, imageDigest: cut.imageDigest, key,
      sourceHead40: mainTip, lane: 'train', outcome: 'pass', evidence: {} });
    expect(lookupMainSameKeyReceipts(root, cut, mainTip, repo)).toMatchObject([{ status: 'pass', verified: true }]);
    expect(lookupMainSameKeyReceipts(root, cut, commit('e'), repo)).toEqual([]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
