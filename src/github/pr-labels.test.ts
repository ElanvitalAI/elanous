import { describe, expect, test } from 'bun:test';
import { CLAIM_IDLE_HOURS, IDEA_APPROVAL_LIMIT, IDEA_STALE_DAYS, labelsForAxis, PR_LABELS, STALLED_DRAFT_HOURS, validatePrLabels } from './pr-labels.js';

const valid = ['elanous:running', 'elanous:from-harness'];

describe('PR label registry', () => {
  test('covers every policy label exactly once with sync and sweep metadata', () => {
    expect(labelsForAxis('state').map(({ name }) => name)).toEqual([
      'elanous:running', 'elanous:stalled', 'elanous:idea-approval', 'elanous:superseded',
    ]);
    expect(labelsForAxis('addon').map(({ name }) => name)).toEqual([
      'elanous:keep', 'elanous:release-hold', 'elanous:idea-stale', 'elanous:needs-rebase', 'elanous:harvestable',
    ]);
    expect(labelsForAxis('origin').map(({ name }) => name)).toEqual([
      'elanous:from-harness', 'elanous:from-intake', 'elanous:from-linear',
      'elanous:from-asana', 'elanous:from-jira', 'elanous:from-mission',
      'elanous:from-agent', 'elanous:from-release', 'elanous:from-human',
    ]);
    expect(labelsForAxis('risk').map(({ name }) => name)).toEqual([
      'elanous:risk-security', 'elanous:risk-public', 'elanous:risk-prod',
    ]);
    expect(new Set(PR_LABELS.map(({ name }) => name)).size).toBe(PR_LABELS.length);
    for (const label of PR_LABELS) {
      expect(label.color).toMatch(/^[0-9A-F]{6}$/);
      expect(label.description.length).toBeGreaterThan(0);
      expect(label.appliedBy.length).toBeGreaterThan(0);
      expect(label.sweep.action.length).toBeGreaterThan(0);
    }
    expect(IDEA_APPROVAL_LIMIT).toBe(10);
    expect(IDEA_STALE_DAYS).toBe(7);
    expect(STALLED_DRAFT_HOURS).toBe(24);
    expect(CLAIM_IDLE_HOURS).toBe(6);
    expect(PR_LABELS.find(({ name }) => name === 'elanous:stalled')?.sweep).toEqual({ action: 'close', afterHours: 24 });
    expect(PR_LABELS.find(({ name }) => name === 'elanous:harvestable')).toMatchObject({ axis: 'addon', appliedBy: ['harness'], sweep: { action: 'close', afterHours: STALLED_DRAFT_HOURS } });
    expect(PR_LABELS.find(({ name }) => name === 'elanous:idea-stale')?.sweep).toEqual({ action: 'notify', afterDays: 7 });
    expect(PR_LABELS.find(({ name }) => name === 'elanous:idea-approval')?.sweep).toEqual({ action: 'none' });
    expect(PR_LABELS.find(({ name }) => name === 'elanous:keep')?.sweep).toEqual({ action: 'exclude' });
  });

  test('accepts one state and origin, optional addons and risk, and ignores unrelated labels', () => {
    expect(validatePrLabels([...valid, 'elanous:keep', 'elanous:risk-prod', 'auto-review', 'elanous:future'], true)).toEqual([]);
    expect(validatePrLabels(['elanous:idea-approval', 'elanous:from-intake'], false)).toEqual([]);
  });

  test('rejects missing state', () => {
    expect(validatePrLabels(['elanous:from-harness'], true)).toContain('state: expected exactly one label, found 0');
  });

  test('rejects two states', () => {
    expect(validatePrLabels([...valid, 'elanous:stalled'], true)).toContain('state: expected exactly one label, found 2');
  });

  test('rejects missing origin', () => {
    expect(validatePrLabels(['elanous:running'], true)).toContain('origin: expected exactly one label, found 0');
  });

  test('rejects two origins', () => {
    expect(validatePrLabels([...valid, 'elanous:from-intake'], true)).toContain('origin: expected exactly one label, found 2');
  });

  test('rejects two risks', () => {
    expect(validatePrLabels([...valid, 'elanous:risk-prod', 'elanous:risk-security'], true)).toContain('risk: expected at most one label, found 2');
  });

  test('rejects draft idea approval without treating it as a stalled draft', () => {
    expect(validatePrLabels(['elanous:idea-approval', 'elanous:from-intake'], true)).toEqual([
      'elanous:idea-approval requires a ready PR (not draft)',
    ]);
  });
});
