import { expect, test } from 'bun:test';
import { RELEASE_PATH_HOLD_MARKER, RELEASE_PATH_PREFIXES, RELEASE_PATH_LABEL, releaseGitDiffPaths, releasePrFilePaths, releasePathHold, releasePathHoldAlreadyPosted, releasePathHoldComment, releasePathHoldShouldPost } from './release-path-guard.js';
import { runDevPipeline } from './dev-pipeline.js';
import type { SelfImplementResult, SelfImplementSeams } from '../self-implement/orchestrator.js';

test('each release subtree holds a changed PR file, and the comment identifies that file for OP', () => {
  expect(RELEASE_PATH_PREFIXES).toEqual(['scripts/release-loop/', 'graphs/release/', 'src/release-loop/manifest', 'src/release-loop/release-note', 'src/release-loop/release-schedule',
    'src/task-orchestrator/surfaces/pod-command-job.ts', 'src/task-orchestrator/surfaces/pod-pool.ts', 'src/task-orchestrator/surfaces/pod-lease.ts',
    'src/task-orchestrator/surfaces/pod-bun-cache.ts', 'src/task-orchestrator/surfaces/pod-install-slots.ts', 'src/release-loop/gate-shards.ts']);
  for (const prefix of RELEASE_PATH_PREFIXES) {
    const path = prefix.endsWith('.ts') ? prefix : `${prefix}publish.ts`;
    expect(releasePathHold(['src/ordinary.ts', path])).toBe(path);
    expect(releasePathHoldComment(path)).toBe(`OP approval required: automatic merge held because this PR changes ${path}.`);
  }
  expect(RELEASE_PATH_LABEL).toBe('elanous:release-path');
});

const gateFiles = [
  'src/task-orchestrator/surfaces/pod-command-job.ts',
  'src/task-orchestrator/surfaces/pod-pool.ts',
  'src/task-orchestrator/surfaces/pod-lease.ts',
  'src/task-orchestrator/surfaces/pod-bun-cache.ts',
  'src/task-orchestrator/surfaces/pod-install-slots.ts',
  'src/release-loop/gate-shards.ts',
];

test('each gate execution module changed by a PR is held before the cut', () => {
  for (const path of gateFiles) {
    const prFiles = releasePrFilePaths([[{ filename: 'src/ordinary.ts' }, { filename: path }]]);
    expect(releasePathHold(prFiles)).toBe(path);
    expect(releasePathHoldComment(path)).toBe(`OP approval required: automatic merge held because this PR changes ${path}.`);
    expect(releasePathHold([`${path}.bak`])).toBeUndefined();
    expect(releasePathHold([path.replace(/\.ts$/, '.tsx')])).toBeUndefined();
  }
});

// Existing caller: dev-pipeline.ts inspectReleasePathBeforeMerge → releasePathHold, reached through runDevPipeline's mergePr seam.
test('cut-window auto-merge checks each gate execution module in the PR and annotates the hold', async () => {
  for (const path of gateFiles) {
    let merged = 0;
    const labels: string[] = [];
    const comments: string[] = [];
    await runDevPipeline({ input: { text: 'gate path' }, completion: 'auto-merge', humanReadableOutput: false }, {
      runGit: () => ({ status: 0, stdout: 'origin\n', stderr: '' }),
      buildSelfImplementSeams: () => ({
        readPrFiles: async () => [path],
        addPrLabel: async ({ label }: { label: string }) => { labels.push(label); },
        postPrComment: async ({ body }: { body: string }) => { comments.push(body); },
        mergePr: async () => { merged++; return { merged: true }; },
      } as unknown as SelfImplementSeams),
      runSelfImplement: async ({ seams }) => {
        expect(await seams.mergePr!({ number: 7, cwd: process.cwd() })).toMatchObject({ merged: false, detail: `OP approval required: ${path}` });
        return { ok: true, stage: 'pr-opened' } as SelfImplementResult;
      },
    });
    expect(merged).toBe(0);
    expect(labels).toEqual([RELEASE_PATH_LABEL]);
    expect(comments).toEqual([releasePathHoldComment(path)]);
  }
});

test('renames inspect the source and destination on GitHub and in the host git diff', () => {
  for (const prefix of RELEASE_PATH_PREFIXES) {
    const oldPath = prefix.endsWith('.ts') ? prefix : `${prefix}publish.ts`;
    expect(releasePathHold(releasePrFilePaths([[{ filename: 'src/ordinary.ts', status: 'renamed', previous_filename: oldPath }]]))).toBe(oldPath);
    expect(releasePathHold(releaseGitDiffPaths(`R100\0${oldPath}\0src/ordinary.ts\0`))).toBe(oldPath);
  }
  expect(releasePathHold(releasePrFilePaths([[{ filename: 'src/new.ts', status: 'renamed', previous_filename: 'src/old.ts' }]]))).toBeUndefined();
  expect(releasePathHold(releaseGitDiffPaths('R100\0src/old.ts\0src/new.ts\0'))).toBeUndefined();
  expect(() => releasePrFilePaths([[{ filename: 'src/new.ts', status: 'renamed' }]])).toThrow('invalid file list');
});

test('only descendants of release subtrees hold; unrelated PR files preserve normal merge eligibility', () => {
  expect(releasePathHold(['src/release-notes/a.ts', 'graphs/release-extra/x.yaml', 'scripts/release-loop-extra/a.ts', 'src/ordinary.ts'])).toBeUndefined();
  expect(releasePathHold([])).toBeUndefined();
});

test('the release-loop ledger code is a release path, and the hold comment is posted once per PR', () => {
  expect(releasePathHold(['src/release-loop/manifest.ts'])).toBe('src/release-loop/manifest.ts');
  expect(releasePathHold(['src/release-loop/release-schedule.ts'])).toBe('src/release-loop/release-schedule.ts');
  expect(releasePathHold(['src/release-loop/checklist.ts', 'src/release-loop/feature-store.ts', 'src/release/x.ts'])).toBeUndefined();
  expect(releasePathHold(['src/release-loopy/other.ts', 'src/releases.ts'])).toBeUndefined();
  expect(releasePathHoldAlreadyPosted([[{ body: 'review round 1' }], [{ body: releasePathHoldComment('graphs/release/a.yaml') }]])).toBe(true);
  expect(releasePathHoldAlreadyPosted([[{ body: 'review round 1' }], []])).toBe(false);
  expect(() => releasePathHoldAlreadyPosted({})).toThrow('invalid list');
  expect(RELEASE_PATH_HOLD_MARKER.length).toBeGreaterThan(0);
  expect(releasePathHoldShouldPost(() => { throw new Error('gh down'); })).toBe(true);
  expect(releasePathHoldShouldPost(() => [[{ body: releasePathHoldComment('src/release-loop/manifest.ts') }]])).toBe(false);
});
