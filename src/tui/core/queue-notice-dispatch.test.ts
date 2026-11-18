import { describe, expect, test } from 'bun:test';
import { createNextTuiQueue } from './queue.js';

describe('mf1 #38102 — dequeue names the item it delivers; a delivered notice never repeats', () => {
  test('user first, then the notice with its source; after delivery settle has nothing to re-wake', () => {
    const q = createNextTuiQueue({ log: () => {} });
    q.enqueue('person asks first');
    const notice = q.enqueueNotice('OP 우편 1건 도착', 'seat-mail');
    const first = q.dequeue();
    if (first.kind !== 'submit') throw new Error('user head expected');
    expect(first.itemKind).toBe('user');
    expect(first.source).toBeUndefined();
    const second = q.dequeue();
    if (second.kind !== 'submit') throw new Error('notice head expected');
    expect(second.itemKind).toBe('notice');
    expect(second.source).toBe('seat-mail');
    expect(second.text).toBe('OP 우편 1건 도착');
    expect(q.get(notice.id)?.status).toBe('delivered');
    expect(q.dequeue().kind).toBe('none');
    expect(q.settle('')).toEqual({ kind: 'none' });
  });

  test('ELN-EXTERNAL-EVENTS ② — seat mail during a turn stays queued and is not a steer', () => {
    const q = createNextTuiQueue({ log: () => {} });
    const mail = q.enqueueNotice('OP 우편 도착 · 안 읽은 1건', 'seat-mail');
    const sidetab = q.enqueueNotice('사이드탭 미션 완료: m — passed', 'sidetab');
    // A notice has no steer offer. Both rows wait for the idle door, mail behind nothing and sidetab after it.
    expect(q.get(mail.id)).toMatchObject({ status: 'queued', delivery: 'queue' });
    expect(q.get(mail.id)?.steerId).toBeUndefined();
    expect(q.get(sidetab.id)).toMatchObject({ status: 'queued', delivery: 'queue' });
    expect('offerSeatMailSteer' in q).toBe(false);
    // The idle door opens the mail as its own turn; the sidetab is still waiting, not delivered twice.
    const first = q.dequeue();
    if (first.kind !== 'submit') throw new Error('mail head expected');
    expect(first.source).toBe('seat-mail');
    expect(q.get(mail.id)?.status).toBe('delivered');
    const rest = q.dequeue();
    if (rest.kind !== 'submit') throw new Error('sidetab still queued');
    expect(rest.source).toBe('sidetab');
    expect(q.dequeue().kind).toBe('none');
    // A later mail is queued again, still not steered and not dropped.
    const held = q.enqueueNotice('OP 우편 도착 · 안 읽은 2건', 'seat-mail');
    expect(q.get(held.id)).toMatchObject({ status: 'queued', delivery: 'queue' });
    expect(q.get(held.id)?.steerId).toBeUndefined();
    expect(q.count).toBe(1);
  });

  test('the real steer path is enqueue(text, steerId); a seat-mail notice cannot take that handle', () => {
    const q = createNextTuiQueue({ log: () => {} });
    const steered = q.enqueue('person steers the running turn', 'steer-1');
    const mail = q.enqueueNotice('OP 우편 도착 · 안 읽은 1건', 'seat-mail');
    expect(q.get(steered.id)).toMatchObject({ kind: 'user', delivery: 'steer', steerId: 'steer-1', status: 'queued' });
    expect(q.steerIds).toEqual(['steer-1']);
    expect(q.get(mail.id)).toMatchObject({ kind: 'notice', delivery: 'queue', status: 'queued' });
    expect(q.get(mail.id)?.steerId).toBeUndefined();
    expect(q.markSteered(['steer-1'])).toBe(1);
    expect(q.get(steered.id)?.status).toBe('delivered');
    expect(q.get(mail.id)?.status).toBe('queued');
    expect(q.steerCount).toBe(0);
  });
});
