import { describe, expect, test } from 'bun:test';
import { revalidateEphemeralSnapshot, type EphemeralSnapshot } from './worktree-ephemeral-policy';

const now = 200_000_000;
const activity = 1;
const good = (): EphemeralSnapshot => ({ targetId: 'fixture:one', ownerId: 'fixture-owner', lastActivityMs: activity, observedAtMs: now, facts: { ownerKnown: true, trackedClean: true, untrackedAbsent: true, ignoredAbsent: true, ptyInactive: true, merged: true, lastActivityMs: activity, nowMs: now } });

describe('read-only snapshot revalidation', () => {
  test('stable fresh fixture passes classification only', () => expect(revalidateEphemeralSnapshot(good(), good(), now, 1000).eligible).toBe(true));
  for (const [label, change] of [
    ['target changed', { targetId: 'fixture:other' }],
    ['owner changed', { ownerId: 'other' }],
    ['owner missing', { ownerId: undefined }],
    ['activity missing', { lastActivityMs: undefined }],
    ['activity inconsistent', { lastActivityMs: 2 }],
    ['observation stale', { observedAtMs: now - 1001 }],
    ['observation future', { observedAtMs: now + 1 }],
  ] as const) test(label, () => expect(revalidateEphemeralSnapshot(good(), { ...good(), ...change }, now, 1000).eligible).toBe(false));
  test('new activity is rejected even if both observations individually idle', () => {
    const later = good(); later.lastActivityMs = 2; later.facts.lastActivityMs = 2;
    expect(revalidateEphemeralSnapshot(good(), later, now, 1000).eligible).toBe(false);
  });
  for (const [label, mutate] of [
    ['owner changes after first revalidation', (s: EphemeralSnapshot) => { s.ownerId = 'other'; }],
    ['activity changes after first revalidation', (s: EphemeralSnapshot) => { s.lastActivityMs = 2; s.facts.lastActivityMs = 2; }],
    ['owner becomes unknown after first revalidation', (s: EphemeralSnapshot) => { s.ownerId = undefined; }],
    ['observation becomes stale after first revalidation', (s: EphemeralSnapshot) => { s.observedAtMs = now - 1001; }],
  ] as const) test(label, () => {
    const initial = good();
    const current = good();
    expect(revalidateEphemeralSnapshot(initial, current, now, 1000).eligible).toBe(true);
    mutate(current);
    expect(revalidateEphemeralSnapshot(initial, current, now, 1000).eligible).toBe(false);
  });
  test('new untracked data blocks', () => {
    const later = good(); later.facts.untrackedAbsent = false;
    expect(revalidateEphemeralSnapshot(good(), later, now, 1000).eligible).toBe(false);
  });
  test('negative freshness or missing first snapshot blocks', () => {
    expect(revalidateEphemeralSnapshot(good(), good(), now, -1).eligible).toBe(false);
    expect(revalidateEphemeralSnapshot({ ...good(), observedAtMs: undefined }, good(), now, 1000).eligible).toBe(false);
  });
});
