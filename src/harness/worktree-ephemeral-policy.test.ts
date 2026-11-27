import { describe, expect, test } from 'bun:test';
import { classifyEphemeralWorktree, type EphemeralFacts } from './worktree-ephemeral-policy.js';

const HOUR = 60 * 60 * 1000;
const safe: EphemeralFacts = { ownerKnown: true, trackedClean: true, untrackedAbsent: true, ignoredAbsent: true, ptyInactive: true, merged: true, lastActivityMs: 0, nowMs: 48 * HOUR };

describe('ephemeral worktree preservation policy', () => {
  test('a known, clean, merged, inactive tree after 48 hours is eligible', () => {
    expect(classifyEphemeralWorktree(safe)).toEqual({ eligible: true, reasons: [] });
  });
  test.each([
    ['owner-unknown', { ownerKnown: false }], ['tracked-dirty-or-unknown', { trackedClean: undefined }],
    ['untracked-present-or-unknown', { untrackedAbsent: false }], ['ignored-present-or-unknown', { ignoredAbsent: false }],
    ['pty-active-or-unknown', { ptyInactive: false }], ['not-merged-or-unknown', { merged: false }],
    ['idle-under-48h-or-unknown', { nowMs: 48 * HOUR - 1 }], ['idle-under-48h-or-unknown', { lastActivityMs: undefined }],
  ] as const)('%s preserves the tree', (reason, changes) => {
    const result = classifyEphemeralWorktree({ ...safe, ...changes });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(reason);
  });
});
