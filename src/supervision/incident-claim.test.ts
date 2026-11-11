import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { acquireLockAsync } from '../storage/file-lock.js';
import { claimIncident, createFileIncidentClaimStore, createMemoryIncidentClaimStore, withIncidentClaim } from './incident-claim.js';

const ownerOrder = ['loop:rla@1', 'loop:macrophage@1', 'loop:gate-autoheal@1'] as const;

test('simulates one incident owner at a time and escalates to the next owner after lease expiry', async () => {
  const store = createMemoryIncidentClaimStore();
  const incidentId = 'release:run-42:gate-event-9';
  const first = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[0], ownerOrder, now: () => 1_000, leaseMs: 500 });
  expect(first.disposition).toBe('claimed');
  expect(await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[1], ownerOrder, now: () => 1_001, leaseMs: 500 }))
    .toMatchObject({ disposition: 'denied', reason: 'another owner holds the active incident lease' });

  const beforeExpiry = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[1], ownerOrder, now: () => 1_499, leaseMs: 500 });
  expect(beforeExpiry.disposition).toBe('denied');
  const escalated = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[1], ownerOrder, now: () => 1_500, leaseMs: 500 });
  if (escalated.disposition !== 'escalated') throw new Error('expected macrophage escalation after the RLA lease expires');
  expect(escalated.claim.ownerLoopRef).toBe('loop:macrophage@1');
  expect((await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[0], ownerOrder, now: () => 1_501, leaseMs: 500 })).disposition)
    .toBe('denied');

  const finalOwner = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[2], ownerOrder, now: () => 2_000, leaseMs: 500 });
  if (finalOwner.disposition !== 'escalated') throw new Error('expected gate-autoheal escalation after the macrophage lease expires');
  expect(finalOwner.claim.ownerLoopRef).toBe('loop:gate-autoheal@1');
  expect(finalOwner.claim.history.map(({ ownerLoopRef }) => ownerLoopRef)).toEqual([...ownerOrder]);
});

test('file-backed claims survive store recreation, enforce expiry and fail closed on unreadable state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'incident-claim-'));
  const incidentId = 'release:run-persisted:gate-1';
  try {
    const first = await claimIncident(createFileIncidentClaimStore(root), {
      incidentId, ownerLoopRef: ownerOrder[0], ownerOrder, now: () => 2_000, leaseMs: 500,
    });
    expect(first.disposition).toBe('claimed');
    const ledgerPath = join(root, 'supervision', 'incident-claims', readdirSync(join(root, 'supervision', 'incident-claims'))
      .find((entry) => entry.endsWith('.json'))!);
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({ ownerLoopRef: 'loop:rla@1', expiresAtMs: 2_500 });
    expect((await claimIncident(createFileIncidentClaimStore(root), {
      incidentId, ownerLoopRef: ownerOrder[1], ownerOrder, now: () => 2_001, leaseMs: 500,
    })).disposition).toBe('denied');
    expect((await claimIncident(createFileIncidentClaimStore(root), {
      incidentId, ownerLoopRef: ownerOrder[1], ownerOrder, now: () => 2_500, leaseMs: 500,
    })).disposition).toBe('escalated');
    writeFileSync(ledgerPath, '{');
    await expect(claimIncident(createFileIncidentClaimStore(root), {
      incidentId, ownerLoopRef: ownerOrder[2], ownerOrder, now: () => 3_000, leaseMs: 500,
    })).rejects.toThrow('incident claim ledger is unreadable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claim expiry is rechecked after waiting to acquire the file lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'incident-claim-lock-wait-'));
  const store = createFileIncidentClaimStore(root);
  const incidentId = 'release:run-lock-wait:gate-1';
  let nowMs = 2_000;
  try {
    const claimed = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[0], ownerOrder,
      now: () => nowMs, leaseMs: 500 });
    if (claimed.disposition !== 'claimed') throw new Error('expected first owner claim');
    const lockPath = join(root, 'supervision', 'incident-claims',
      `${createHash('sha256').update(incidentId).digest('hex')}.json.lock`);
    const heldLock = await acquireLockAsync(lockPath);
    let actions = 0;
    const waiting = withIncidentClaim(store, { incidentId, claimToken: claimed.claim.claimToken,
      now: () => nowMs }, () => { actions += 1; });
    nowMs = claimed.claim.expiresAtMs;
    heldLock.release();
    await expect(waiting).resolves.toMatchObject({ current: false });
    expect(actions).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('successor lease starts at the time the claim lock is acquired', async () => {
  const root = mkdtempSync(join(tmpdir(), 'incident-claim-successor-time-'));
  const store = createFileIncidentClaimStore(root);
  const incidentId = 'release:run-successor-time:gate-1';
  let nowMs = 2_000;
  try {
    const first = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[0], ownerOrder,
      now: () => nowMs, leaseMs: 500 });
    if (first.disposition !== 'claimed') throw new Error('expected first owner claim');
    const lockPath = join(root, 'supervision', 'incident-claims',
      `${createHash('sha256').update(incidentId).digest('hex')}.json.lock`);
    const heldLock = await acquireLockAsync(lockPath);
    const successor = claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[1], ownerOrder,
      now: () => nowMs, leaseMs: 500 });
    nowMs = 5_000;
    heldLock.release();
    const escalated = await successor;
    expect(escalated).toMatchObject({ disposition: 'escalated', claim: { claimedAtMs: 5_000, expiresAtMs: 5_500 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a successful in-lock action that crosses expiry completes the incident before handoff', async () => {
  const store = createMemoryIncidentClaimStore();
  let nowMs = 2_000;
  const incidentId = 'release:run-completed:gate-1';
  const first = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[0], ownerOrder,
    now: () => nowMs, leaseMs: 500 });
  if (first.disposition !== 'claimed') throw new Error('expected first owner claim');
  const action = withIncidentClaim(store, { incidentId, claimToken: first.claim.claimToken, now: () => nowMs },
    async () => { nowMs = first.claim.expiresAtMs; return 'verified'; }, value => value === 'verified');
  await expect(action).resolves.toMatchObject({ current: true, value: 'verified' });
  const successor = await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[1], ownerOrder,
    now: () => nowMs, leaseMs: 500 });
  expect(successor).toMatchObject({ disposition: 'denied', reason: 'incident already completed' });
});

test('rejects invalid lease windows and owner orders', async () => {
  const store = createMemoryIncidentClaimStore();
  await expect(claimIncident(store, { incidentId: 'event', ownerLoopRef: ownerOrder[0], ownerOrder,
    now: () => 100, leaseMs: 0 })).rejects.toThrow('positive safe lease');
  await expect(claimIncident(store, { incidentId: 'event', ownerLoopRef: ownerOrder[0],
    ownerOrder: ['loop:rla@1', 'loop:rla@1'], now: () => 100, leaseMs: 1 })).rejects.toThrow('unique owner order');
});
