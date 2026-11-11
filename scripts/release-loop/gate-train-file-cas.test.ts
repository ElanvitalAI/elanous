import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planTrainFileCas, recordTrainFileCasResult } from './gate-train-file-cas.js';
import { gateFileReceiptIdentityFromClosure } from './gate-file-receipts.js';
import type { ClosureTree } from './gate-closure.js';

const files = ['test/a.test.ts', 'test/b.test.ts'];
const imageDigest = `sha256:${'a'.repeat(64)}`;

test('file CAS identities reuse the same tip graph across test files', () => {
  const testFiles = Array.from({ length: 12 }, (_, index) => `test/case-${index}.test.ts`);
  const allFiles = [...testFiles, ...Array.from({ length: 80 }, (_, index) => `src/other-${index}.ts`)];
  let reads = 0;
  const tree: ClosureTree = { files: allFiles, preload: [], read: () => { reads++; return 'export const value = 1;'; } };
  expect(gateFileReceiptIdentityFromClosure(tree, testFiles[0]!, imageDigest)?.file).toBe(testFiles[0]);
  reads = 0;
  for (const file of testFiles) expect(gateFileReceiptIdentityFromClosure(tree, file, imageDigest)?.file).toBe(file);
  // Each independent test needs one content-hash read; a second graph build would read allFiles again.
  expect(reads).toBe(testFiles.length);
});

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test('train file CAS reuses exact closures, measures uncovered files, and remeasures a known failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'train-file-cas-'));
  const repo = join(root, 'repo');
  const receiptRoot = join(root, 'receipts');
  try {
    mkdirSync(join(repo, 'test'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, files[0]!), "import { a } from '../src/a.js'; void a;\n");
    writeFileSync(join(repo, files[1]!), "import { b } from '../src/b.js'; void b;\n");
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'CAS test'); git(repo, 'config', 'user.email', 'cas@example.invalid');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
    const firstHead = git(repo, 'rev-parse', 'HEAD');
    const initial = planTrainFileCas({ repo, commit: firstHead, imageDigest, receiptRoot, expectedFiles: files });
    expect(initial?.lane).toEqual({ action: 'run-uncovered', files, receiptKeys: [], knownNonPassingFiles: [] });
    expect(recordTrainFileCasResult({ planned: initial!, head40: firstHead, runId: 'train-1', version: '0.3.8',
      measuredFiles: files, actualImageDigests: [imageDigest], failures: [], errors: [], complete: true }))
      .toMatchObject({ ok: true, reused: 0, measured: 2 });

    const allReused = planTrainFileCas({ repo, commit: firstHead, imageDigest, receiptRoot, expectedFiles: files });
    expect(allReused?.lane).toEqual({ action: 'run-uncovered', files: [],
      receiptKeys: expect.arrayContaining([expect.any(String), expect.any(String)]), knownNonPassingFiles: [] });
    expect(recordTrainFileCasResult({ planned: allReused!, head40: firstHead, runId: 'train-2', version: '0.3.8',
      measuredFiles: [], actualImageDigests: null, failures: [], errors: [], complete: true }))
      .toMatchObject({ ok: true, reused: 2, measured: 0 });

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'change a closure');
    const changedHead = git(repo, 'rev-parse', 'HEAD');
    const changed = planTrainFileCas({ repo, commit: changedHead, imageDigest, receiptRoot, expectedFiles: files });
    expect(changed?.lane.files).toEqual(['test/a.test.ts']);
    expect(changed?.lane.receiptKeys).toHaveLength(1);
    expect(recordTrainFileCasResult({ planned: changed!, head40: changedHead, runId: 'train-3', version: '0.3.8',
      measuredFiles: ['test/a.test.ts'], actualImageDigests: [imageDigest],
      failures: ['test/a.test.ts > changed behavior'], errors: [], complete: true }))
      .toMatchObject({ ok: true, reused: 1, measured: 1 });

    const failedAgain = planTrainFileCas({ repo, commit: changedHead, imageDigest, receiptRoot, expectedFiles: files });
    expect(failedAgain?.lane.files).toEqual(['test/a.test.ts']);
    expect(failedAgain?.lane.knownNonPassingFiles).toEqual(['test/a.test.ts']);
    expect(failedAgain?.lane.receiptKeys).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('train file CAS refuses to persist receipts without executed image identity or attributed result IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'train-file-cas-guards-'));
  const repo = join(root, 'repo');
  try {
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'test/a.test.ts'), 'test("a", () => {});\n');
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'CAS test'); git(repo, 'config', 'user.email', 'cas@example.invalid');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
    const head = git(repo, 'rev-parse', 'HEAD');
    const plan = planTrainFileCas({ repo, commit: head, imageDigest, receiptRoot: join(root, 'receipts'), expectedFiles: ['test/a.test.ts'] })!;
    const input = { planned: plan, head40: head, runId: 'guard-test', version: '0.3.8', measuredFiles: ['test/a.test.ts'],
      failures: [] as string[], errors: [] as string[], complete: true };
    expect(recordTrainFileCasResult({ ...input, actualImageDigests: null })).toEqual({ ok: false, reason: 'train-file-cas-executed-image-mismatch' });
    expect(recordTrainFileCasResult({ ...input, actualImageDigests: [`sha256:${'b'.repeat(64)}`] }))
      .toEqual({ ok: false, reason: 'train-file-cas-executed-image-mismatch' });
    expect(recordTrainFileCasResult({ ...input, actualImageDigests: [imageDigest], failures: ['test/other.test.ts > unexpected'] }))
      .toEqual({ ok: false, reason: 'train-file-cas-result-outside-measured-inventory' });
    expect(recordTrainFileCasResult({ ...input, actualImageDigests: [imageDigest], errors: ['not-a-test-id'] }))
      .toEqual({ ok: false, reason: 'train-file-cas-unattributed-result-id' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
