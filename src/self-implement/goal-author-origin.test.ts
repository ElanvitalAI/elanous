import { describe, expect, test } from 'bun:test';

import {
  formatGoalFileLintFinding,
  GOAL_FILE_LINT_ORIGINS,
  lintGoalFile,
  type GoalFileLintFinding,
  type GoalFileLintTag,
} from './goal-author.js';

type Origin = typeof GOAL_FILE_LINT_ORIGINS[GoalFileLintTag];

const knownOriginTags = (Object.entries(GOAL_FILE_LINT_ORIGINS) as [GoalFileLintTag, Origin][])
  .filter((entry): entry is [GoalFileLintTag, Extract<Origin, { kind: 'known-incident' }>] => entry[1].kind === 'known-incident')
  .map(([tag]) => tag);

const preservedUnknownOriginTags: readonly GoalFileLintTag[] = [
  'launch-branch',
  'grounding-evidence',
  'empty-result-population',
  'self-question-subject',
  'all-negative-signals',
  'unreadable-signals',
  'alternative-signals',
  'count-observation',
  'release-note',
];

const sampleFinding = (tag: GoalFileLintTag): GoalFileLintFinding => ({
  level: 'WARN',
  tag,
  message: 'origin contract fixture',
});

function assertOriginContract(origins: Record<GoalFileLintTag, Origin>): void {
  const knownEntries = knownOriginTags.map((tag) => [tag, origins[tag]] as const);

  expect(knownEntries.length).toBeGreaterThanOrEqual(1);
  for (const [tag, origin] of knownEntries) {
    expect(origin.kind).toBe('known-incident');
    if (origin.kind !== 'known-incident') throw new Error(`known origin regressed to unknown: ${tag}`);
    const rendered = formatGoalFileLintFinding(sampleFinding(tag));
    expect(origin.incident.trim()).not.toBe('');
    expect(origin.reference.trim()).not.toBe('');
    expect(rendered).toBe(`WARN [${tag}] origin contract fixture — origin: ${origin.incident} (reference: ${origin.reference})`);
    expect(rendered).not.toContain('ORIGIN-UNKNOWN');
  }

  for (const [tag, origin] of Object.entries(origins) as [GoalFileLintTag, Origin][]) {
    if (origin.kind !== 'unknown-origin') continue;
    expect(formatGoalFileLintFinding(sampleFinding(tag))).toBe(`WARN [${tag}] origin contract fixture — origin: ORIGIN-UNKNOWN`);
  }
}

describe('goal file lint origins', () => {
  test('promotes artifact-launch-declaration to the measured incident', () => {
    expect(GOAL_FILE_LINT_ORIGINS['artifact-launch-declaration']).toEqual({
      kind: 'known-incident',
      incident: 'artifact launch declarations appeared only on the feature landing day and never afterward, including goals with executable-artifact signals',
      reference: 'git:e3a4b32235 (#10532)',   // 비공개 문서 경로는 뺐다(#20484 · 공개본 유출 0)
    });
  });

  test('observes the documented-incident origin count once per lint result', () => {
    const knownIncidentOriginTagCount = Object.values(GOAL_FILE_LINT_ORIGINS)
      .filter((origin) => origin.kind === 'known-incident').length;
    const result = lintGoalFile('', 'main');

    expect(result.knownIncidentOriginTagCount).toBe(knownIncidentOriginTagCount);
    expect(Object.getOwnPropertyDescriptor(result, 'knownIncidentOriginTagCount')?.enumerable).toBe(false);
    expect(result.knownOriginTagCount).toBe(knownIncidentOriginTagCount);
  });

  test('preserves every non-target unknown origin as explicitly unknown', () => {
    const actualUnknownOriginTags = (Object.entries(GOAL_FILE_LINT_ORIGINS) as [GoalFileLintTag, Origin][]).filter(([, origin]) => origin.kind === 'unknown-origin').map(([tag]) => tag).sort();

    const expectedUnknownOriginTags = [...preservedUnknownOriginTags].sort();
    const addedUnknownOriginTags = actualUnknownOriginTags.filter((tag) => !expectedUnknownOriginTags.includes(tag));
    const removedUnknownOriginTags = expectedUnknownOriginTags.filter((tag) => !actualUnknownOriginTags.includes(tag));

    if (addedUnknownOriginTags.length > 0 || removedUnknownOriginTags.length > 0) {
      throw new Error(
        `Unknown-origin ratchet mismatch. Added tags: ${addedUnknownOriginTags.join(', ') || '(none)'}. `
        + `Removed tags: ${removedUnknownOriginTags.join(', ') || '(none)'}. `
        + 'Assign each added tag a known-incident origin, or add it to preservedUnknownOriginTags.',
      );
    }

    expect(actualUnknownOriginTags).toEqual(expectedUnknownOriginTags);
    for (const tag of preservedUnknownOriginTags) {
      expect(GOAL_FILE_LINT_ORIGINS[tag]).toEqual({ kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' });
    }
  });

  test('renders known incidents and references and preserves explicit unknown formatting', () => {
    assertOriginContract(GOAL_FILE_LINT_ORIGINS);
  });

  test('fails the origin contract when a populated known origin mutates back to unknown', () => {
    const [knownTag, knownOrigin] = Object.entries(GOAL_FILE_LINT_ORIGINS)
      .find((entry): entry is [GoalFileLintTag, Extract<Origin, { kind: 'known-incident' }>] => entry[1].kind === 'known-incident')!;
    const mutatedOrigins = {
      ...GOAL_FILE_LINT_ORIGINS,
      [knownTag]: { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
    } as Record<GoalFileLintTag, Origin>;

    expect(knownOrigin.incident).not.toBe('');
    expect(() => assertOriginContract(mutatedOrigins)).toThrow();
  });
});
