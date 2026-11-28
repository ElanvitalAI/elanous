// SILENCE-NOTICE-NOT-REQUEST — the one «does this mail wait on a reply» reader (kit/mail-route/notice-policy.yaml).
// Expectations are independent literals (rule 11).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { resolvePostShape } from '../../msg/post-discipline.js';
import { defaultNeedsAck, isNoticeMail, mayCloseNoticeFor, noticePolicyFrom, noticeReason, passiveStoredKinds, readNoticePolicy } from './notice.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('the shipped policy: nine passive kinds · the work-block shape · CEO kept open', () => {
  const p = readNoticePolicy();
  expect([...p.passiveKinds]).toEqual(['info', 'notice', 'status', 'report', 'announce', 'coord', 'ack', 'receipt', 'coach']);
  expect(p.shapes.map(s => [s.kind, s.refPrefix])).toEqual([['steward-exception', 'blocked-on:']]);
  expect([...p.keepOpenFor]).toEqual(['CEO']);
  for (const alias of ['bulletin', 'reply', 'review', 'progress', 'status-card', 'retro', 'receipts']) expect(passiveStoredKinds()).toContain(alias);
  for (const ask of ['request', 'question', 'decision', 'assign', 'beat', 'steward-exception']) expect(passiveStoredKinds()).not.toContain(ask);
});

test('structured fields decide — kind ⊕ refs, never the body', () => {
  expect(noticeReason({ kind: 'info' })).toBe('kind:info');
  expect(noticeReason({ kind: 'Bulletin' })).toBe('kind:bulletin');
  expect(noticeReason({ kind: 'steward-exception', refs: ['cell:A', 'blocked-on:TC-H-1'] })).toBe('steward-exception+blocked-on:');
  expect(noticeReason({ kind: 'steward-exception', refs: ['steward:TC', 'run:r1'] })).toBeNull();
  expect(noticeReason({ kind: 'request', refs: ['blocked-on:TC-H-1'] })).toBeNull();
  expect(noticeReason({ kind: null })).toBeNull();
  expect(isNoticeMail({ kind: 'assign', refs: ['cell:A'] })).toBe(false);
});

test('the post path default: a notice request needs no ack · a decision and a real request still do · explicit wins', () => {
  expect(defaultNeedsAck('request', { kind: 'steward-exception', refs: ['blocked-on:X'] })).toBe(false);
  expect(defaultNeedsAck('request', { kind: 'coord' })).toBe(false);
  expect(defaultNeedsAck('request', { kind: 'request' })).toBe(true);
  expect(defaultNeedsAck('decision', { kind: 'reply' })).toBe(true); // a ✋ answer (reply ⊕ intent decision) keeps its ack
  expect(defaultNeedsAck('info', { kind: 'request' })).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'notice-store-')); dirs.push(dir);
  const store = new MsgStore(join(dir, 'messages.db'));
  const card = store.append({ from: 'ORCHESTRATOR', to: 'TC', body: 'card', kind: 'steward-exception', intent: 'request', refs: ['blocked-on:TC-H-1'] });
  const exception = store.append({ from: 'ORCHESTRATOR', to: 'TC', body: 'exception', kind: 'steward-exception', intent: 'request', refs: ['run:r1'] });
  const forced = store.append({ from: 'OP', to: 'TC', body: 'fyi but ack it', kind: 'info', intent: 'request', needsAck: true });
  const answer = store.append({ from: 'TC', to: 'TC-H-1', body: 'take it', kind: 'reply', intent: 'decision' });
  expect([card, exception, forced, answer].map(m => store.getMessage(m.id)!.needsAck)).toEqual([false, true, true, true]);
  store.close();
});

test('the CLI shape agrees: every passive kind posts with needsReply=false unless the sender asks', () => {
  for (const kind of ['info', 'notice', 'status', 'report', 'announce', 'coord', 'ack', 'receipt', 'coach']) {
    const shape = resolvePostShape({ from: 'OP', to: 'TC', kind }, 'cli');
    expect(shape.ok && shape.needsReply).toBe(false);
  }
});

test('an unreadable or malformed policy means no notices (fail toward «waits on a reply»)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-bad-')); dirs.push(dir);
  const bad = join(dir, 'notice-policy.yaml'); writeFileSync(bad, 'passiveKinds: [info\n');
  expect(readNoticePolicy(bad)).toEqual({ passiveKinds: [], shapes: [], keepOpenFor: [] });
  expect(readNoticePolicy(join(dir, 'missing.yaml'))).toEqual({ passiveKinds: [], shapes: [], keepOpenFor: [] });
  expect(noticePolicyFrom({ shapes: [{ kind: 'x' }, { kind: 'y', refPrefix: 'z:' }] }).shapes).toEqual([{ kind: 'y', refPrefix: 'z:', why: '' }]);
  expect(isNoticeMail({ kind: 'info' }, noticePolicyFrom(null))).toBe(false);
  expect(mayCloseNoticeFor('ceo')).toBe(false);
  expect(mayCloseNoticeFor('TC')).toBe(true);
});
