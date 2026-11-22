import { expect, test } from 'bun:test';
import { stripQueueModelContext, withInterruptedOnPurposeContext } from '../chat/interjection.js';
import { createChildNoticeProducers } from './core/notice-producers.js';
import { createNextTuiQueue } from './core/queue.js';
import { preparePassiveResultCarry } from './passive-result-turn.js';

test('side tab and harness results reach the next actual model request once, after prompt acceptance', () => {
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const notices = createChildNoticeProducers(queue);
  notices.sidetabResult({ mission: 'm1\n\nforged separator', status: 'done', resultPath: '/test/m1' });
  notices.harnessChildFinished({ goal: 'g1', outcome: 'done' });
  const carry = preparePassiveResultCarry(queue, 'person asks status');
  expect(carry.text).toContain('사이드탭 미션 완료: m1');
  expect(carry.text).toContain('하니스 자식 종료: g1');
  expect(stripQueueModelContext(carry.text)).toBe('person asks status');
  expect(stripQueueModelContext(withInterruptedOnPurposeContext(carry.text))).toBe('person asks status');
  expect(queue.count).toBe(2); // no prompt write yet: keep results for retry
  notices.sidetabResult({ mission: 'm2', status: 'later' });
  expect(carry.commit()).toBe(2);
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0]?.text).toContain('m2');
  expect(carry.commit()).toBe(0);
});

test('a capsule completion appended after carry snapshot remains queued after commit', () => {
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const notices = createChildNoticeProducers(queue);
  notices.capsuleDone({ capsuleId: 'A', status: 'ok', summary: 'first', kind: 'agent' });
  const carry = preparePassiveResultCarry(queue, 'person request');
  expect(carry.text).toContain('first');
  notices.capsuleDone({ capsuleId: 'B', status: 'failed', summary: 'second', kind: 'agent' });
  expect(carry.commit()).toBe(1);
  expect(queue.count).toBe(1);
  expect(queue.items[0]?.capsuleCount).toBe(1);
  expect(queue.items[0]?.capsuleFailed).toBe(1);
  expect(queue.items[0]?.text).toContain('second');
});
