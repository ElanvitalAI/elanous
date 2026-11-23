import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitmentLedger } from '../dashboard/input/commitment-ledger.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';
import { armMessageFollowUp, FOLLOW_UP_MS } from './msg-follow-up.js';
import { MsgStore } from './msg-store.js';
import { evaluateWaker, listWakers, type SelfTimerDeps } from './self-timer-watch.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('request arms one 30-minute reply watcher, dedupes, and wakes sender on expiry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'msg-follow-up-')); roots.push(root);
  let clock = Date.parse('2026-11-24T00:00:00Z');
  let launched = 0;
  const notices: string[] = [];
  const now = () => new Date(clock);
  const ledger = new CommitmentLedger({ root: join(root, 'ledger'), now });
  const timer: SelfTimerDeps = { root: join(root, 'wakers'), ledger, now,
    probes: { mailReplied: async () => false, prMerged: async () => false, reviewArrived: async () => false, fileExists: async () => false },
    postNotice: async (seat, body) => { notices.push(`${seat}:${body}`); return 1; } };
  const deps = { openStore: () => new MsgStore(join(root, 'messages.db')),
    followUp: (message: Parameters<typeof armMessageFollowUp>[0], pr: number | undefined) => armMessageFollowUp(message, pr, { ledger, timer, launch: async () => { launched++; } }) };
  const args = { from: 'TC', to: 'CX-5', body: 'Please investigate', intent: 'request' };
  const first = await dispatchMsgPost(args, deps);
  expect(first.message.intent).toBe('request');
  expect(first.followUp).toMatchObject({ condition: `mail-reply:${first.message.id}`, merged: false });
  const second = await dispatchMsgPost(args, deps);
  expect(second.message.id).toBe(first.message.id);
  expect(second.followUp).toMatchObject({ merged: true });
  expect(launched).toBe(1);
  const [waker] = listWakers('TC', timer);
  expect(Date.parse(waker!.deadlineAt) - Date.parse(waker!.armedAt)).toBe(FOLLOW_UP_MS);
  clock += FOLLOW_UP_MS;
  expect((await evaluateWaker('TC', waker!.id, timer)).outcome).toBe('expired');
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('TC:');
  expect(notices[0]).toContain(`mail-reply:${first.message.id}`);
});

test('decision can watch a PR and launch failure leaves a visible, retryable post', async () => {
  const root = mkdtempSync(join(tmpdir(), 'msg-follow-up-')); roots.push(root);
  const ledger = new CommitmentLedger({ root: join(root, 'ledger') });
  const timer: SelfTimerDeps = { root: join(root, 'wakers'), ledger };
  let attempts = 0;
  const deps = { openStore: () => new MsgStore(join(root, 'messages.db')),
    followUp: (message: Parameters<typeof armMessageFollowUp>[0], pr: number | undefined) => armMessageFollowUp(message, pr, { ledger, timer, launch: async () => { if (++attempts === 1) throw new Error('launch failed'); } }) };
  const args = { from: 'TC', to: 'CX-5', body: 'Land the change', intent: 'decision', waitForPr: 39789 };
  const first = await dispatchMsgPost(args, deps);
  expect(first.ok).toBe(true);
  expect(first.followUp).toEqual({ error: 'launch failed' });
  expect(first.output).toContain('follow-up failed');
  const retry = await dispatchMsgPost(args, deps);
  expect(retry.message.id).toBe(first.message.id);
  expect(retry.followUp).toMatchObject({ condition: 'pr-merged:39789', merged: true });
  expect(attempts).toBe(2);
});
