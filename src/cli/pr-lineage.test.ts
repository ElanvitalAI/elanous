import { describe, expect, it } from 'bun:test';
import { branchGoalId, branchLineageSlug, findSiblingPrs } from './pr-lineage.js';

describe('branchLineageSlug', () => {
  it('keeps the legacy path-slug string after stripping the trailing hash', () => {
    expect(branchLineageSlug('self-impl/src-cli-pr-cli-ts-test-cli-pr-cli-test-t-c8cbedac'))
      .toBe('src-cli-pr-cli-ts-test-cli-pr-cli-test-t');
  });

  it('strips a run suffix before the legacy hash without changing the goal lineage', () => {
    const legacy = 'self-impl/goalid-4b852b3a0f863ad2-shared-prefix-0486e54f';
    expect(branchLineageSlug(`${legacy}-rc41218`)).toBe(branchLineageSlug(legacy));
    expect(branchLineageSlug(`${legacy}-r0557cd`)).toBe(branchLineageSlug(legacy));
    expect(branchLineageSlug('self-impl/src-cli-pr-cli-ts-test-cli-pr-cli-test-t-c8cbedac-rc41218'))
      .toBe('src-cli-pr-cli-ts-test-cli-pr-cli-test-t');
  });

  it('returns null for a non-self-impl branch', () => {
    expect(branchLineageSlug('feat/land')).toBeNull();
  });
});

describe('branchGoalId', () => {
  it('reads the value immediately after goalid-, not the trailing hash', () => {
    expect(branchGoalId('self-impl/200-goalid-c969c242a28942b0-rootintent-s-73733e18'))
      .toBe('c969c242a28942b0');
    expect(branchGoalId('self-impl/200-goalid-c969c242a28942b0-rootintent-s-73733e18'))
      .not.toBe('73733e18');
  });

  it('reads the same goal id with and without a run suffix', () => {
    const legacy = 'self-impl/goalid-4b852b3a0f863ad2-shared-prefix-0486e54f';
    expect(branchGoalId(legacy)).toBe('4b852b3a0f863ad2');
    expect(branchGoalId(`${legacy}-rc41218`)).toBe('4b852b3a0f863ad2');
  });

  it('does not reconstruct a goal id from a legacy path-slug branch', () => {
    expect(branchGoalId('self-impl/src-cli-pr-cli-ts-test-cli-pr-cli-test-t-c8cbedac')).toBeNull();
  });

  it('does not treat a mygoalid-foo substring as a formal -goalid-<id>- segment', () => {
    expect(branchGoalId('self-impl/src-cli-mygoalid-foo-c8cbedac')).toBeNull();
    expect(branchGoalId('self-impl/x-mygoalid-abc-rootintent-s-73733e18')).toBeNull();
    expect(branchLineageSlug('self-impl/src-cli-mygoalid-foo-c8cbedac'))
      .toBe('src-cli-mygoalid-foo');
  });

  it('returns null when the self-impl prefix is absent', () => {
    expect(branchGoalId('200-goalid-c969c242a28942b0-rootintent-s-73733e18')).toBeNull();
  });
});

describe('findSiblingPrs', () => {
  it('keeps same-slug open PRs and drops a different slug', () => {
    expect(findSiblingPrs('self-impl/x-1111aaaa', [
      { number: 101, headRefName: 'self-impl/x-2222bbbb' },
      { number: 102, headRefName: 'self-impl/y-3333cccc' },
    ])).toEqual([{ number: 101, headRefName: 'self-impl/x-2222bbbb' }]);
  });

  it('groups run-suffixed and legacy branches as siblings for superseded PR selection', () => {
    const legacy = 'self-impl/goalid-4b852b3a0f863ad2-shared-prefix-0486e54f';
    const first = `${legacy}-rc41218`;
    const second = `${legacy}-r0557cd`;
    const prs = [
      { number: 101, headRefName: first },
      { number: 102, headRefName: second },
      { number: 103, headRefName: legacy },
      { number: 104, headRefName: 'self-impl/other-0486e54f-r0557cd' },
    ];
    expect(findSiblingPrs(first, prs)).toEqual(prs.slice(1, 3));
    expect(findSiblingPrs(legacy, prs)).toEqual(prs.slice(0, 2));
  });

  it('excludes the current branch from siblings', () => {
    expect(findSiblingPrs('self-impl/x-1111aaaa', [
      { number: 101, headRefName: 'self-impl/x-1111aaaa' },
      { number: 102, headRefName: 'self-impl/x-2222bbbb' },
    ])).toEqual([{ number: 102, headRefName: 'self-impl/x-2222bbbb' }]);
  });

  it('returns an empty list when the current branch has no lineage slug', () => {
    expect(findSiblingPrs('feat/land', [
      { number: 101, headRefName: 'self-impl/x-2222bbbb' },
    ])).toEqual([]);
  });
});
