import { describe, expect, test } from 'bun:test';
import { classifyMergeFailure, clipRegateDetail, HOST_REGATE_DETAIL_MAX, parseConflictFiles, regateFailureFacts } from './regate-detail.js';

describe('regate detail (HOST-REGATE-REASON-LOST)', () => {
  test('short detail is kept whole; long detail keeps head and tail within the cap', () => {
    expect(clipRegateDetail('Error: boom')).toBe('Error: boom');
    const long = `HEAD-${'m'.repeat(10_000)}-TAIL`;
    const clipped = clipRegateDetail(long);
    expect(clipped.length).toBeLessThanOrEqual(HOST_REGATE_DETAIL_MAX);
    expect(clipped.startsWith('HEAD-')).toBe(true);
    expect(clipped.endsWith('-TAIL')).toBe(true);
    expect(clipped).toContain('chars elided');
  });

  test('CONFLICT output parser ignores unrelated lines', () => {
    expect(parseConflictFiles([
      'Auto-merging src/a.ts',
      'CONFLICT (content): Merge conflict in src/a.ts',
      'CONFLICT (add/add): Merge conflict in docs/b.md',
      'CONFLICT (modify/delete): src/c.ts deleted in HEAD and modified in 1234.',
      'CONFLICT (modify/delete): src/has space.ts deleted in HEAD and modified in 1234.',
      'CONFLICT (content): base and head disagree',
      'warning: CONFLICT (content): Merge conflict in src/not-a-conflict.ts',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n'))).toEqual(['docs/b.md', 'src/a.ts', 'src/c.ts', 'src/has space.ts']);
    expect(parseConflictFiles('fatal: refusing to merge unrelated histories')).toEqual([]);
  });

  test('merge failure kinds', () => {
    expect(classifyMergeFailure('GraphQL: Base branch was modified. Review and try the merge again.')).toBe('base-modified');
    expect(classifyMergeFailure('GraphQL: Base branch was modified.', 'a'.repeat(40), 'b'.repeat(40))).toBe('base-modified');
    expect(classifyMergeFailure('Head branch was modified')).toBe('head-moved');
    expect(classifyMergeFailure('anything', 'a'.repeat(40), 'b'.repeat(40))).toBe('head-moved');
    expect(classifyMergeFailure('GraphQL: Pull request is not mergeable')).toBe('other');
    expect(classifyMergeFailure('GraphQL: Merge conflict in src/a.ts')).toBe('conflict');
    expect(classifyMergeFailure('GraphQL: no conflicts, but required status checks are missing')).toBe('branch-policy');
    expect(classifyMergeFailure('At least 1 approving review is required by reviewers with write access. Required status check "ci" is expected.')).toBe('branch-policy');
    expect(classifyMergeFailure('connection reset')).toBe('other');
  });

  test('facts are copied only when well-formed', () => {
    expect(regateFailureFacts({ step: 'merge', detail: 'x', expectedHead: 'a'.repeat(40), actualHead: null, mergeFailureKind: 'base-modified' }))
      .toEqual({ expectedHead: 'a'.repeat(40), actualHead: null, mergeFailureKind: 'base-modified' });
    expect(regateFailureFacts({ expectedHead: 'short', actualHead: 'nope', conflictFiles: ['a', 1], mergeFailureKind: 'weird' })).toEqual({ conflictFiles: ['a'] });
    const files = Array.from({ length: 202 }, (_, i) => `src/${i}.ts`);
    expect(regateFailureFacts({ conflictFiles: files })).toEqual({ conflictFiles: files.slice(0, 200), conflictFilesOmitted: 2 });
    expect(regateFailureFacts({ conflictFiles: files.slice(0, 200), conflictFilesOmitted: 2 })).toEqual({ conflictFiles: files.slice(0, 200), conflictFilesOmitted: 2 });
    expect(regateFailureFacts(undefined)).toEqual({});
  });
});
