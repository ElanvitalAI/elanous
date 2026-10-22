import { describe, expect, test } from 'bun:test';
import { blockedDraftDisposition, blockedDraftTargetFor, decideDraftOnStop, nextMoveFor, parseDraftOnStopMode, repairSalvageLinkComment, salvageBranchForRun, stopClassFor, syntheticRepairBasePr } from './blocked-draft-policy.js';
import { runSuffixKey, selectRunSalvageRefs } from './salvage-branches.js';
import type { AbandonedClassification } from './abandoned-classification.js';

describe('blocked draft disposition', () => {
  for (const classification of ['provider-error', 'quota-exhausted', 'credential-failure'] as const) {
    test(`${classification} preserves a branch`, () => {
      expect(blockedDraftDisposition(classification)).toBe('preserve-branch');
    });
  }
  for (const classification of ['implementation-deficit', 'report-deficit', 'goal-unconvergeable-candidate', undefined] as const satisfies readonly (AbandonedClassification | undefined)[]) {
    test(`${classification ?? 'undefined'} opens a draft`, () => {
      expect(blockedDraftDisposition(classification)).toBe('open-draft');
    });
  }
});

describe('DRAFT-NOT-ARCHIVE policy', () => {
  test('always keeps the draft with no owner label', () => {
    expect(decideDraftOnStop({ mode: 'always', classification: 'implementation-deficit', seat: 'TC' })).toEqual({ action: 'open-draft', stopClass: 'harvestable', mode: 'always' });
  });
  test('needs-owner-only salvages harvestable stops', () => {
    for (const classification of ['implementation-deficit', 'report-deficit', 'run-deadline-exceeded', 'quota-exhausted'] as const) {
      expect(decideDraftOnStop({ mode: 'needs-owner-only', classification }).action).toBe('salvage-branch');
    }
  });
  test('needs-owner-only keeps the draft with the owner seat label; unknown seat → no seat label (not guessed); unknown class → needs-owner', () => {
    expect(decideDraftOnStop({ mode: 'needs-owner-only', classification: 'contract-conflict', seat: 'ux' })).toEqual({ action: 'open-draft', stopClass: 'needs-owner', mode: 'needs-owner-only', ownerLabel: 'elanous:seat-UX' });
    expect(decideDraftOnStop({ mode: 'needs-owner-only', classification: 'goal-unconvergeable-candidate', seat: 'session-x' })).toEqual({ action: 'open-draft', stopClass: 'needs-owner', mode: 'needs-owner-only' });
    expect(decideDraftOnStop({ mode: 'needs-owner-only', classification: 'pr-declined' })).not.toHaveProperty('ownerLabel');
    expect(stopClassFor('unclassified')).toBe('needs-owner');
    expect(stopClassFor(undefined)).toBe('needs-owner');
  });
  test('merge-approved-abandoned is landable: it stays a draft PR (next move is pr land), never a salvage branch', () => {
    expect(stopClassFor('merge-approved-abandoned')).toBe('landable');
    expect(decideDraftOnStop({ mode: 'needs-owner-only', classification: 'merge-approved-abandoned', seat: 'TC' })).toEqual({ action: 'open-draft', stopClass: 'landable', mode: 'needs-owner-only', ownerLabel: 'elanous:seat-TC' });
    expect(nextMoveFor('merge-approved-abandoned')).toContain('pr land');
  });
  test('salvage branch name carries the run key so selectRunSalvageRefs finds it', () => {
    const name = salvageBranchForRun('run-bfe2b5c1-0000', 'self-impl/my-goal-rbfe2b5');
    expect(name).toBe('salvage/run-bfe2b5/self-impl-my-goal-rbfe2b5');
    expect(selectRunSalvageRefs([{ branch: name, sha: 'a'.repeat(40) }], runSuffixKey('run-bfe2b5c1-0000')!)).toHaveLength(1);
  });
  test('config parse: unknown values fall back to always and are flagged', () => {
    expect(parseDraftOnStopMode(undefined)).toEqual({ mode: 'always', invalid: false });
    expect(parseDraftOnStopMode('needs-owner-only')).toEqual({ mode: 'needs-owner-only', invalid: false });
    expect(parseDraftOnStopMode('never')).toEqual({ mode: 'always', invalid: true });
  });
  test('every stop has a next move', () => {
    expect(nextMoveFor('implementation-deficit')).toContain('수확 가지');
    expect(nextMoveFor(undefined)).toContain('주인 자리');
  });
});

describe('REPAIR-BLOCKED-DRAFT-LINK-ORIGINAL', () => {
  test('a synthetic local base pr-<N> names the original PR; real branches do not', () => {
    expect(syntheticRepairBasePr('pr-123')).toBe(123);
    for (const base of [undefined, '', 'main', 'origin/main', 'pr-0', 'pr-12a', 'feature/pr-123', 'pr-123/x']) {
      expect(syntheticRepairBasePr(base)).toBeUndefined();
    }
  });
  test('blocked draft on a pr-<N> base links the original PR instead of opening a new draft', () => {
    expect(blockedDraftTargetFor('pr-123')).toEqual({ action: 'link-original', originalPr: 123 });
    expect(blockedDraftTargetFor('main')).toEqual({ action: 'open-draft' });
    expect(blockedDraftTargetFor(undefined)).toEqual({ action: 'open-draft' });
  });
  test('the link comment is one line naming the salvage ref and sha', () => {
    const body = repairSalvageLinkComment({ salvageRef: 'salvage/run-abc123/self-impl-x', sha: 'f'.repeat(40), runId: 'run-abc123', stage: 'review-blocked' });
    expect(body.split('\n')).toHaveLength(1);
    expect(body).toContain('수리 산출물 salvage salvage/run-abc123/self-impl-x');
    expect(body).toContain('f'.repeat(12));
    expect(body).toContain('run-abc123');
    expect(repairSalvageLinkComment({ salvageRef: 'salvage/run-abc123/x', runId: 'run-abc123', stage: 'gate-failed' })).not.toContain('undefined');
  });
});
