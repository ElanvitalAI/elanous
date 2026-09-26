import { describe, expect, test } from 'bun:test';
import { buildReleaseManifest, type ReleaseLanding } from './release-manifest.js';

const landing = (sha: string, changes: Partial<ReleaseLanding> = {}): ReleaseLanding => ({
  sha, title: sha, kind: 'feat', gate: 'passed', docs: 'paired', releaseTarget: 'next', ...changes,
});

describe('buildReleaseManifest', () => {
  test('uses landing position, not lexical SHA order; preserves IN and DEFER landing order', () => {
    const result = buildReleaseManifest({
      version: '0.3.0', cutoff: 'a', landings: [
        landing('z'), landing('d', { gate: 'failed' }), landing('a'), landing('0'), landing('b'),
      ],
    });
    expect(result).toEqual({
      version: '0.3.0', cutoff: 'a',
      in: [
        { sha: 'z', title: 'z', kind: 'feat', docs: 'paired' },
        { sha: 'a', title: 'a', kind: 'feat', docs: 'paired' },
      ],
      deferred: [
        { ref: 'd', reason: 'gate-not-passed' },
        { ref: '0', reason: 'after-cutoff' },
        { ref: 'b', reason: 'after-cutoff' },
      ], escalate: [],
    });
  });

  test('goals default to later, explicit next is eligible, and in-flight goals defer even if marked next', () => {
    const result = buildReleaseManifest({
      version: '0.3.0', cutoff: 'c',
      landings: [
        landing('a', { goalRef: 'goal-default', releaseTarget: undefined }),
        landing('b', { goalRef: 'goal-next', releaseTarget: undefined }),
        landing('c', { goalRef: 'goal-running', releaseTarget: 'next' }),
      ],
      goals: [
        { ref: 'goal-default', status: 'landed' },
        { ref: 'goal-next', status: 'landed', releaseTarget: 'next' },
        { ref: 'goal-running', status: 'running', releaseTarget: 'next' },
        { ref: 'unlanded-running', status: 'running' },
      ],
    });
    expect(result.in.map((entry) => entry.sha)).toEqual(['b']);
    expect(result.deferred).toEqual([
      { ref: 'a', reason: 'release-target-later' },
      { ref: 'c', reason: 'in-flight' },
      { ref: 'unlanded-running', reason: 'in-flight' },
    ]);
  });

  test('an unmarked landing defaults to later, but an explicit next is included', () => {
    const result = buildReleaseManifest({ version: '0.3.0', cutoff: 'b', landings: [
      landing('a', { releaseTarget: undefined }), landing('b'),
    ] });
    expect(result.in.map((entry) => entry.sha)).toEqual(['b']);
    expect(result.deferred).toEqual([{ ref: 'a', reason: 'release-target-later' }]);
  });

  test('docs status is retained for paired and exempt; missing docs, failed gates and reverts defer', () => {
    const result = buildReleaseManifest({
      version: '0.3.0', cutoff: 'e', landings: [
        landing('a', { docs: 'paired' }),
        landing('b', { docs: 'exempt' }),
        landing('c', { docs: 'missing' }),
        landing('d', { gate: 'unknown' }),
        landing('e', { reverted: true }),
      ],
    });
    expect(result.in.map((entry) => entry.docs)).toEqual(['paired', 'exempt']);
    expect(result.deferred).toEqual([
      { ref: 'c', reason: 'docs-missing' },
      { ref: 'd', reason: 'gate-not-passed' },
      { ref: 'e', reason: 'reverted' },
    ]);
  });

  test('escalates breaking changes and each removed public command in landing order', () => {
    const result = buildReleaseManifest({ version: '0.3.0', cutoff: 'b', landings: [
      landing('a', { breaking: true, removedPublicCommands: ['elanous old', 'elanous legacy'] }),
      landing('b', { removedPublicCommands: ['elanous second'] }),
      landing('c', { removedPublicCommands: ['elanous after'] }),
    ] });
    expect(result.escalate).toEqual([
      { sha: 'a', reason: 'breaking' },
      { sha: 'a', reason: 'removed-public-command', command: 'elanous old' },
      { sha: 'a', reason: 'removed-public-command', command: 'elanous legacy' },
      { sha: 'b', reason: 'removed-public-command', command: 'elanous second' },
    ]);
  });

  test('is deterministic and leaves frozen input untouched', () => {
    const first = Object.freeze(landing('a', { removedPublicCommands: Object.freeze(['elanous old']) }));
    const second = Object.freeze(landing('b'));
    const input = Object.freeze({ version: '0.3.0', cutoff: 'b', landings: Object.freeze([first, second]) });
    const before = JSON.stringify(input);
    expect(buildReleaseManifest(input)).toEqual(buildReleaseManifest(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  test('rejects missing or ambiguous cutoff and landing references without inventing evidence', () => {
    expect(() => buildReleaseManifest({ version: '0.3.0', cutoff: 'absent', landings: [landing('a')] })).toThrow('정확히 한 번');
    expect(() => buildReleaseManifest({ version: '0.3.0', cutoff: 'a', landings: [landing('a'), landing('a')] })).toThrow('정확히 한 번');
    expect(() => buildReleaseManifest({ version: '0.3.0', cutoff: 'a', landings: [landing('a', { goalRef: 'absent' })] })).toThrow('골을 찾을 수 없다');
  });
});
