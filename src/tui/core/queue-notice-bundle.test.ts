import { describe, expect, test } from 'bun:test';
import { createNextTuiQueue, NEXT_TUI_NOTICE_CAP } from './queue.js';

/**
 * SEAT-NOTICE-BUNDLE-DRAIN (OP #128938, DIAG §107 «대기 88») — 실패 먼저 시험.
 * 완료선: 알림 상한 20(넘치면 원장 안내 한 줄) · 쌓인 알림 전부 한 턴 묶음 drain ·
 * 사람 줄은 묶지 않고 먼저 · 순서 보존(회귀 = 알림 50건 → 1턴 비움).
 */

describe('SEAT-NOTICE-BUNDLE-DRAIN — notice cap', () => {
  test('50 notice arrivals cap waiting notices at 20 plus ONE ledger-guide line', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    for (let i = 1; i <= 50; i += 1) queue.enqueueNotice(`알림 ${i}`, 'seat-mail');
    const waiting = queue.items.filter((item) => item.kind === 'notice' && item.status === 'queued');
    // 상한: notice 20건 + 안내 1줄 — 안내도 notice 항목이므로 총 21을 넘지 않는다.
    expect(waiting.length).toBe(NEXT_TUI_NOTICE_CAP + 1);
    // 넘친 30건은 안내 한 줄로 접힌다 — 마지막 항목이 원장 안내(msg list)를 지칭하고 초과 수를 밝힌다.
    const last = queue.items.at(-1)!;
    expect(last.kind).toBe('notice');
    expect(last.text).toContain('msg list');
    expect(last.text).toContain('30');
  });

  test('the cap counts only notices — a queued person line is never dropped nor counted', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueue('사람 줄');
    for (let i = 1; i <= 50; i += 1) queue.enqueueNotice(`알림 ${i}`, 'seat-mail');
    expect(queue.items.filter((item) => item.kind === 'user' && item.status === 'queued').length).toBe(1);
    const notices = queue.items.filter((item) => item.kind === 'notice' && item.status === 'queued');
    expect(notices.length).toBe(NEXT_TUI_NOTICE_CAP + 1);
  });
});

describe('SEAT-NOTICE-BUNDLE-DRAIN — bundle drain at the idle boundary', () => {
  test('drainNotices takes EVERY waiting notice as one bundle, order preserved', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    for (const text of ['알림 A', '알림 B', '알림 C']) queue.enqueueNotice(text, 'seat-mail');
    const bundle = queue.drainNotices();
    if (bundle.kind !== 'notices') throw new Error(`expected a notices bundle, got ${bundle.kind}`);
    expect(bundle.notices.map((notice) => notice.text)).toEqual(['알림 A', '알림 B', '알림 C']);
    expect(bundle.remaining).toBe(0);
    expect(queue.drainNotices()).toEqual({ kind: 'none' });
  });

  test('a queued person line goes first and is never bundled — the bundle is the notice run AFTER it', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueueNotice('알림 A', 'seat-mail');
    queue.enqueue('사람 줄');
    queue.enqueueNotice('알림 B', 'seat-mail');
    // deliveryOrder already puts the person's line ahead of every notice.
    const person = queue.dequeue();
    if (person.kind !== 'submit' || person.itemKind !== 'user') throw new Error('person line must leave first');
    expect(person.text).toBe('사람 줄');
    const bundle = queue.drainNotices();
    if (bundle.kind !== 'notices') throw new Error(`expected a notices bundle, got ${bundle.kind}`);
    expect(bundle.notices.map((notice) => notice.text)).toEqual(['알림 A', '알림 B']);
  });

  test('drainNotices leaves a later person line queued — notices leave, the person line stays for its own turn', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueueNotice('알림 A', 'seat-mail');
    queue.enqueueNotice('알림 B', 'event-watch');
    queue.enqueue('이후 사람 줄');
    const bundle = queue.drainNotices();
    if (bundle.kind !== 'notices') throw new Error(`expected a notices bundle, got ${bundle.kind}`);
    expect(bundle.notices.map((notice) => notice.text)).toEqual(['알림 A', '알림 B']);
    expect(queue.pendingTexts).toEqual(['이후 사람 줄']);
  });

  test('mixed sources bundle together; msgId chains survive per notice', () => {
    const queue = createNextTuiQueue({ log: () => {} });
    queue.enqueueNotice('우편 1', 'seat-mail', { msgId: 101, occurredAt: 1_000 });
    queue.enqueueNotice('감시 줄', 'event-watch', { occurredAt: 2_000 });
    const bundle = queue.drainNotices();
    if (bundle.kind !== 'notices') throw new Error(`expected a notices bundle, got ${bundle.kind}`);
    expect(bundle.notices[0]!.msgId).toBe(101); // 출처: #38804 — msgId 사슬 유지
    expect(bundle.notices[1]!.occurredAt).toBe(2_000);
  });
});
