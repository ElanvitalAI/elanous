import { describe, expect, test } from 'bun:test';
import { buildReleaseManifest, type ReleaseManifestInput } from './manifest.js';
import type { ReleaseNoteFragment } from './release-note.js';

describe('buildReleaseManifest', () => {
  test('classifies five landings in order, tracks docs, defers running/later and escalates removed commands deterministically', () => {
    const input: ReleaseManifestInput = {
      version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'base' }, cutoff: { sha: 'cut' },
      landings: [
        { sha: 'docs', title: 'documented', changedFiles: ['release/public/docs/cli.md'], releaseTarget: 'next' },
        { sha: 'cli', title: 'new command', changedFiles: ['src/cli/foo.ts'], releaseTarget: 'next', prNumber: 42 },
        { sha: 'later', title: 'later', changedFiles: ['src/cli/x.ts'], goalPath: 'docs/goals/later.md', releaseTarget: 'later' },
        { sha: 'running', title: 'running', changedFiles: ['src/index.ts'], goalPath: 'docs/goals/running.md', releaseTarget: 'next' },
        { sha: 'other', title: 'ordinary', changedFiles: ['src/other.ts'], releaseTarget: 'next' },
      ],
      runningGoalPaths: ['docs/goals/running.md'],
      publicCommandsBefore: ['elanous a', 'elanous b'], publicCommandsAfter: ['elanous a'],
    };
    const result = buildReleaseManifest(input);
    expect(result).toEqual({
      version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'base' }, cutoff: { sha: 'cut' },
      in: [
        { sha: 'docs', title: 'documented', docs: 'present' },
        { sha: 'cli', title: 'new command', prNumber: 42, docs: 'missing' },
        { sha: 'other', title: 'ordinary', docs: 'n/a' },
      ],
      deferred: [{ sha: 'later', reason: 'release-target-later' }, { sha: 'running', reason: 'run-in-flight' }],
      escalate: [{ kind: 'command-removed', command: 'elanous b' }],
    });
    expect(buildReleaseManifest(input)).toEqual(result);
    expect(input.landings.map((landing) => landing.sha)).toEqual(['docs', 'cli', 'later', 'running', 'other']);
  });

  test('three landings use a fragment, defer later, and show a missing note without changing fallback classification', () => {
    const notes = new Map<number, ReleaseNoteFragment>([
      [41, { pr: 41, line: '사용자 기능', kind: 'feat', docs: { path: 'release/public/docs/feature.md' }, target: 'next', source: 'pr-body' }],
      [42, { pr: 42, line: '추후 기능', kind: 'internal', docs: { none: '아직 비공개' }, target: 'later', source: 'backfill' }],
    ]);
    const result = buildReleaseManifest({
      version: '1.0.0', baseline: { ref: 'base', sha: 'a' }, cutoff: { sha: 'b' },
      landings: [
        { sha: 'feature', title: 'title only', prNumber: 41, changedFiles: [] },
        { sha: 'later', title: 'future', prNumber: 42, changedFiles: [], releaseTarget: 'next' },
        { sha: 'without', title: 'missing title', prNumber: 43, changedFiles: ['src/cli/new.ts'] },
      ],
      notes, runningGoalPaths: [], publicCommandsBefore: [], publicCommandsAfter: [],
    });
    expect(result.in).toEqual([
      { sha: 'feature', title: 'title only', prNumber: 41, docs: 'present', line: '사용자 기능', kind: 'feat' },
      { sha: 'without', title: 'missing title', prNumber: 43, docs: 'missing', line: 'missing title', kind: 'unknown', note: 'missing' },
    ]);
    expect(result.deferred).toEqual([{ sha: 'later', reason: 'release-target-later' }]);
    expect(buildReleaseManifest({
      version: '1.0.0', baseline: { ref: 'base', sha: 'a' }, cutoff: { sha: 'b' },
      landings: [{ sha: 'running-fragment', title: 'active', prNumber: 42, goalPath: 'docs/goals/active.md', changedFiles: [] }],
      notes, runningGoalPaths: ['docs/goals/active.md'], publicCommandsBefore: [], publicCommandsAfter: [],
    }).deferred).toEqual([{ sha: 'running-fragment', reason: 'run-in-flight' }]);
    expect(buildReleaseManifest({
      version: '1.0.0', baseline: { ref: 'base', sha: 'a' }, cutoff: { sha: 'b' },
      landings: [{ sha: 'none', title: 'plain', prNumber: 9, changedFiles: [] }],
      notes: new Map([[9, { ...notes.get(41)!, pr: 9, target: 'next', docs: { none: '내부 변경' } }]]),
      runningGoalPaths: [], publicCommandsBefore: [], publicCommandsAfter: [],
    }).in[0]?.docs).toBe('n/a');
  });

  test('an unspecified target is IN (METHOD v115 ④); in-flight takes priority over explicit later', () => {
    const result = buildReleaseManifest({
      version: '1.0.0', baseline: { ref: 'base', sha: 'a' }, cutoff: { sha: 'b' },
      landings: [
        { sha: 'unspecified', title: 'unlabeled', changedFiles: [] },
        { sha: 'both', title: 'both', goalPath: 'docs/goals/x.md', changedFiles: [], releaseTarget: 'later' },
      ],
      runningGoalPaths: ['docs/goals/x.md'], publicCommandsBefore: [], publicCommandsAfter: [],
    });
    expect(result.in.map(({ sha }) => sha)).toEqual(['unspecified']);
    expect(result.deferred).toEqual([
      { sha: 'both', reason: 'run-in-flight' },
    ]);
  });
});
