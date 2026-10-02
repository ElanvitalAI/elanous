import { describe, expect, test } from 'bun:test';
import { buildReleaseManifest, parseNextMdNotes, type ReleaseManifestInput } from './manifest.js';
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

describe('release/next.md note lines (REL7)', () => {
  const base = (over: Partial<ReleaseManifestInput>): ReleaseManifestInput => ({
    version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'base' }, cutoff: { sha: 'cut' }, landings: [], notes: new Map(),
    runningGoalPaths: [], publicCommandsBefore: [], publicCommandsAfter: [], ...over,
  });

  test('parses the kind from the heading or the «- kind — » prefix and drops Documentation/Target fields and later lines', () => {
    expect(parseNextMdNotes([
      '# Next', '', '## Internal', '', '- 내부 도구. Documentation: none. Target: next.', '',
      '## Feat', '', '- feat — Setup offers Tailscale. Documentation: none (setup). Target: next.', '- Seats register intake sources.',
      '- Deferred thing. Documentation: none. Target: later.', '', '## Fix', '', '- Over SSH no browser opens. Documentation: none. Target: next.',
    ].join('\n')).map(({ kind, line }) => ({ kind, line }))).toEqual([
      { kind: 'internal', line: '내부 도구.' },
      { kind: 'feat', line: 'Setup offers Tailscale.' },
      { kind: 'feat', line: 'Seats register intake sources.' },
      { kind: 'fix', line: 'Over SSH no browser opens.' },
    ]);
  });

  test('three landings that added next.md lines render those lines; only the rest stay unknown', () => {
    const result = buildReleaseManifest(base({
      landings: [
        { sha: 'a', title: 'A (no PR fragment)', changedFiles: ['release/next.md'], prNumber: 1 },
        { sha: 'b', title: 'B', changedFiles: ['release/next.md'], prNumber: 2 },
        { sha: 'c', title: 'C', changedFiles: ['release/next.md'] },
        { sha: 'd', title: 'D internal', changedFiles: ['src/x.ts'], prNumber: 4 },
      ],
      nextMd: [{ kind: 'feat', line: 'One', sha: 'a' }, { kind: 'feat', line: 'Two', sha: 'b' }, { kind: 'fix', line: 'Three', sha: 'c' }],
    }));
    expect(result.in.map((entry) => [entry.sha, entry.kind, entry.line])).toEqual([['a', 'feat', 'One'], ['b', 'feat', 'Two'], ['c', 'fix', 'Three'], ['d', 'unknown', 'D internal']]);
    expect(result.fragments).toEqual({ byPr: 0, byNextMd: 3, unlinked: 0, unknown: 1 });
    expect(result.escalate).toEqual([]);
  });

  test('a PR fragment wins over the next.md line of the same landing', () => {
    const fragment: ReleaseNoteFragment = { pr: 1, line: 'From PR', kind: 'fix', docs: { none: 'x' }, target: 'next', source: 'pr-body' };
    const result = buildReleaseManifest(base({
      landings: [{ sha: 'a', title: 'A', changedFiles: ['release/next.md'], prNumber: 1 }],
      notes: new Map([[1, fragment]]), nextMd: [{ kind: 'feat', line: 'From next.md', sha: 'a' }],
    }));
    expect(result.in).toEqual([{ sha: 'a', title: 'A', prNumber: 1, docs: 'n/a', line: 'From PR', kind: 'fix' }]);
    expect(result.fragments).toEqual({ byPr: 1, byNextMd: 0, unlinked: 0, unknown: 0 });
  });

  test('a next.md line no landing claims is still IN, counted as unlinked', () => {
    const result = buildReleaseManifest(base({ landings: [{ sha: 'a', title: 'A', changedFiles: [] }], nextMd: [{ kind: 'feat', line: 'Orphan' }] }));
    expect(result.in.at(-1)).toEqual({ sha: '', title: 'Orphan', docs: 'n/a', line: 'Orphan', kind: 'feat' });
    expect(result.fragments?.unlinked).toBe(1);
  });

  test('feat/fix landings with no user line at all escalate notes-empty', () => {
    const result = buildReleaseManifest(base({
      landings: [{ sha: 'a', title: 'feat: one', changedFiles: [] }, { sha: 'b', title: 'fix: two', changedFiles: [] }], nextMd: [],
    }));
    expect(result.escalate).toEqual([{ kind: 'notes-empty', featFixLandings: 2, nextMdLines: 0 }]);
  });

  test('without next.md input the manifest shape is unchanged (no fragments, no notes-empty)', () => {
    const result = buildReleaseManifest(base({ landings: [{ sha: 'a', title: 'feat: one', changedFiles: [] }] }));
    expect(result.fragments).toBeUndefined();
    expect(result.escalate).toEqual([]);
  });
});
