// MAIL-ANTI-FLOOD E·F·G — policy tables with independent literals (never the module's own constants).
import { describe, expect, test } from 'bun:test';
import { backpressureVerdict, canonicalPostKind, isUrgentPost, postDestination, postKindHint, postKindlessWarning, resolvePostShape } from './post-discipline.js';

describe('E — structured post', () => {
  test('CLI stores a kind-less post as passive info (rule kindless) and has a one-line warning for it', () => {
    expect(resolvePostShape({ from: 'TC', to: 'OP' }, 'cli')).toEqual({ ok: true, kind: 'info', cls: 'info', needsReply: false, rule: 'kindless' });
    expect(postKindlessWarning()).toBe('msg post warning (no --kind): stored as --kind info (passive · needsReply=false · no turn) — add --kind <request|question|decision|alert|info|notice|status|report|announce|coord|ack|receipt|goal> and --needs-reply when you wait for an answer');
  });
  test('CLI refuses a kind outside the closed set and names it', () => {
    const r = resolvePostShape({ from: 'TC', to: 'OP', kind: 'memo' }, 'cli');
    expect(r).toEqual({ ok: false, error: postKindHint('memo') });
    expect(postKindHint('memo').startsWith('msg post refused (unknown --kind "memo")')).toBe(true);
  });
  test('explicit kinds: asking kinds default needsReply true, the rest false; the flag overrides', () => {
    expect(resolvePostShape({ from: 'TC', to: 'OP', kind: 'question' }, 'cli')).toEqual({ ok: true, kind: 'question', cls: 'question', needsReply: true, rule: 'explicit' });
    expect(resolvePostShape({ from: 'TC', to: 'OP', kind: 'Info' }, 'cli')).toEqual({ ok: true, kind: 'info', cls: 'info', needsReply: false, rule: 'explicit' });
    expect(resolvePostShape({ from: 'TC', to: 'OP', kind: 'request', needsReply: false }, 'cli')).toEqual({ ok: true, kind: 'request', cls: 'request', needsReply: false, rule: 'explicit' });
    expect(resolvePostShape({ from: 'TC', to: 'OP', kind: 'notice', needsReply: true }, 'tool')).toEqual({ ok: true, kind: 'notice', cls: 'notice', needsReply: true, rule: 'explicit' });
  });
  test('an A217 request (due ⊕ done) is waited on by default; a bare request is not', () => {
    expect(resolvePostShape({ from: 'OP', to: 'TC', intent: 'request', doneWhen: 'PR open', deadlineAt: '2026-11-25T10:00:00.000Z' }, 'cli')).toEqual({ ok: true, kind: 'request', cls: 'request', needsReply: true, rule: 'intent' });
    expect(resolvePostShape({ from: 'OP', to: 'TC', kind: 'request' }, 'cli')).toEqual({ ok: true, kind: 'request', cls: 'request', needsReply: false, rule: 'explicit' });
  });
  test('legacy kinds stay as written and map to a class', () => {
    expect(resolvePostShape({ from: 'RES', to: 'OP', kind: 'incident' }, 'cli')).toEqual({ ok: true, kind: 'incident', cls: 'alert', needsReply: false, rule: 'explicit' });
    expect(canonicalPostKind('status-card')).toBe('status');
    expect(canonicalPostKind('stall-alert')).toBe('alert');
    expect(canonicalPostKind('memo')).toBe(null);
    expect(canonicalPostKind('')).toBe(null);
  });
  test('structured signals name the class on the CLI too (crown · ✋ · intent)', () => {
    expect(resolvePostShape({ from: 'OP', to: 'TC', crownDirective: 'D-1' }, 'cli')).toEqual({ ok: true, kind: 'request', cls: 'request', needsReply: true, rule: 'crown' });
    expect(resolvePostShape({ from: 'TC-H2', to: 'TC', refs: ['block:B-1', 'reason:BUDGET'] }, 'cli')).toEqual({ ok: true, kind: 'alert', cls: 'alert', needsReply: true, rule: 'hand' });
    expect(resolvePostShape({ from: 'TC', to: 'OP', intent: 'decision' }, 'cli')).toEqual({ ok: true, kind: 'decision', cls: 'decision', needsReply: true, rule: 'intent' });
  });
  test('tool path auto-tags kind-less posts from replyTo · refs · sender role (never the body)', () => {
    expect(resolvePostShape({ from: 'TC', to: 'OP', replyTo: 12 }, 'tool')).toEqual({ ok: true, kind: 'status', cls: 'status', needsReply: false, rule: 'reply' });
    expect(resolvePostShape({ from: 'TC', to: 'OP', refs: ['pr:50001'] }, 'tool')).toEqual({ ok: true, kind: 'status', cls: 'status', needsReply: false, rule: 'refs' });
    expect(resolvePostShape({ from: 'CLAUDE-OP', to: 'OP' }, 'tool')).toEqual({ ok: true, kind: 'info', cls: 'info', needsReply: false, rule: 'coach' });
    expect(resolvePostShape({ from: 'TC', to: 'TC-H1', senderAbove: true }, 'tool')).toEqual({ ok: true, kind: 'request', cls: 'request', needsReply: false, rule: 'order' });
    expect(resolvePostShape({ from: 'TC-H1', to: 'TC', senderAbove: false }, 'tool')).toEqual({ ok: true, kind: 'info', cls: 'info', needsReply: false, rule: 'default' });
  });
  test('legacy callers read as passive info', () => {
    expect(resolvePostShape({ from: 'X', to: 'OP' }, 'legacy')).toEqual({ ok: true, kind: 'info', cls: 'info', needsReply: false, rule: 'legacy' });
  });
});

describe('F — destination', () => {
  test('a seat posting to itself becomes a scheduled wake; a crown relay or a person stays mail', () => {
    expect(postDestination({ from: 'OP', to: 'op' })).toBe('self-wake');
    expect(postDestination({ from: 'OP', to: 'OP', crownDirective: 'D-9' })).toBe('mailbox');
    expect(postDestination({ from: 'OP', to: 'OP', origin: { kind: 'human' } })).toBe('mailbox');
    expect(postDestination({ from: 'OP', to: 'OP', refs: ['telegram-message:77'] })).toBe('mailbox');
  });
  test('coach mail is a note unless it needs a reply or carries a crown flag', () => {
    expect(postDestination({ from: 'CLAUDE-OP', to: 'OP', needsReply: false })).toBe('coach-note');
    expect(postDestination({ from: 'CLAUDE-OP', to: 'OP', needsReply: true })).toBe('mailbox');
    expect(postDestination({ from: 'CLAUDE-OP', to: 'OP', crownDirective: 'crown TG' })).toBe('mailbox');
    expect(postDestination({ from: 'TC', to: 'OP' })).toBe('mailbox');
  });
});

describe('G — back-pressure', () => {
  test('urgent always passes; otherwise queue > 30 or turns/h > 20 folds', () => {
    expect(backpressureVerdict({ urgent: true, pendingPassive: 500, turnsLastHour: 90 })).toEqual({ fold: false, reason: 'urgent' });
    expect(backpressureVerdict({ urgent: false, pendingPassive: 30, turnsLastHour: 20 })).toEqual({ fold: false, reason: 'below' });
    expect(backpressureVerdict({ urgent: false, pendingPassive: 31, turnsLastHour: 0 })).toEqual({ fold: true, reason: 'queue' });
    expect(backpressureVerdict({ urgent: false, pendingPassive: 0, turnsLastHour: 21 })).toEqual({ fold: true, reason: 'turns' });
    expect(backpressureVerdict({ urgent: false, pendingPassive: 0, turnsLastHour: null })).toEqual({ fold: false, reason: 'below' });
    // 출처: #40082 backpressureConfigFrom — a config override replaces the code defaults (N=30 · M=20, CEO 11-25 G).
    expect(backpressureVerdict({ urgent: false, pendingPassive: 6, turnsLastHour: 0 }, { maxPendingPassive: 5, maxTurnsPerHour: 99 })).toEqual({ fold: true, reason: 'queue' });
  });
  test('urgent = ✋ (block ⊕ HQ reason) · crown · a person · alert · P0 · question/decision or HQ-reason request that needs a reply', () => {
    expect(isUrgentPost({ from: 'JUD-H1', to: 'JUD', refs: ['block:B', 'reason:HUMAN_DECISION'] })).toBe(true);
    expect(isUrgentPost({ from: 'OP', to: 'TC', crownDirective: 'x' })).toBe(true);
    expect(isUrgentPost({ from: 'OP', to: 'TC', kind: 'request', senderAbove: true })).toBe(true);
    expect(isUrgentPost({ from: 'MK', to: 'TC', kind: 'info', senderAbove: false })).toBe(false);
    expect(isUrgentPost({ from: 'TC-H1', to: 'OP', kind: 'request', senderAbove: false })).toBe(false);
    expect(isUrgentPost({ from: 'RES', to: 'OP', kind: 'incident' })).toBe(true);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'info', priority: 1 })).toBe(true);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'decision', needsReply: true })).toBe(true);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'decision', needsReply: false })).toBe(false);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'request', needsReply: true })).toBe(false);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'status' })).toBe(false);
    expect(isUrgentPost({ from: 'CEO', to: 'OP', kind: 'coord', origin: { kind: 'human' } })).toBe(true);
    expect(isUrgentPost({ from: 'X', to: 'OP', kind: 'coord', refs: ['telegram-message:5'] })).toBe(true);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'request', refs: ['reason:CROSS_SCOPE'], needsReply: true })).toBe(true);
    expect(isUrgentPost({ from: 'TC', to: 'OP', kind: 'request', refs: ['reason:CROSS_SCOPE'], needsReply: false })).toBe(false);
  });
});
