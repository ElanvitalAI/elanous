import { expect, test } from 'bun:test';
import { RELEASE_PATH_HOLD_MARKER, RELEASE_PATH_PREFIXES, RELEASE_PATH_LABEL, releaseGitDiffPaths, releasePrFilePaths, releasePathHold, releasePathHoldAlreadyPosted, releasePathHoldComment, releasePathHoldShouldPost } from './release-path-guard.js';

test('each release subtree holds a changed PR file, and the comment identifies that file for OP', () => {
  expect(RELEASE_PATH_PREFIXES).toEqual(['scripts/release-loop/', 'graphs/release/', 'src/release-loop/manifest', 'src/release-loop/release-note', 'src/release-loop/release-schedule']);
  for (const prefix of RELEASE_PATH_PREFIXES) {
    const path = `${prefix}publish.ts`;
    expect(releasePathHold(['src/ordinary.ts', path])).toBe(path);
    expect(releasePathHoldComment(path)).toBe(`OP approval required: automatic merge held because this PR changes ${path}.`);
  }
  expect(RELEASE_PATH_LABEL).toBe('elanous:release-path');
});

test('renames inspect the source and destination on GitHub and in the host git diff', () => {
  for (const prefix of RELEASE_PATH_PREFIXES) {
    const oldPath = `${prefix}publish.ts`;
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
