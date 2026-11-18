import { expect, test } from 'bun:test';
import { createNextTuiQueue } from './queue.js';
import {
  createChildNoticeProducers,
  eventWatchNotice,
  eventWatchStatusLine,
  harnessChildNotice,
  seatMailNotice,
  sidetabResultNotice,
} from './notice-producers.js';

const quietQueue = () => createNextTuiQueue({ log: () => {} });

test('생산자 문구 — 소스별 한 줄 요약(경로·안 읽은 수는 있을 때만)', () => {
  expect(sidetabResultNotice({ mission: '리팩터 조사', status: 'passed', resultPath: '/tmp/r.md' }))
    .toBe('사이드탭 미션 완료: 리팩터 조사 — passed · 결과 /tmp/r.md');
  expect(sidetabResultNotice({ mission: '조사', status: 'failed' }))
    .toBe('사이드탭 미션 완료: 조사 — failed');
  expect(harnessChildNotice({ goal: '큐 결함 수리', outcome: 'done' }))
    .toBe('하니스 자식 종료: 큐 결함 수리 — done');
  expect(seatMailNotice({ seat: 'OP', unread: 2 }))
    .toBe('OP 우편 도착 · 안 읽은 2건');
});

test('세 생산자는 각자의 source 로 notice 항목을 만들고 조향하지 않는다', () => {
  const queue = quietQueue();
  const producers = createChildNoticeProducers(queue);
  const sidetab = producers.sidetabResult({ mission: 'm', status: 'passed' });
  const child = producers.harnessChildFinished({ goal: 'g', outcome: 'done' });
  const mail = producers.seatMailArrived({ seat: 'OP', unread: 1 });
  expect([sidetab?.source, child?.source, mail?.source]).toEqual(['sidetab', 'harness-child', 'seat-mail']);
  expect(queue.items.every((item) => item.kind === 'notice' && item.delivery === 'queue')).toBe(true);
});

test('같은 사건이 아직 대기 중이면 두 번 넣지 않고, 내용이 달라지면 별도 항목', () => {
  const queue = quietQueue();
  const producers = createChildNoticeProducers(queue);
  producers.seatMailArrived({ seat: 'OP', unread: 2 });
  const firstCount = queue.count;
  expect(producers.seatMailArrived({ seat: 'OP', unread: 2 })).toBe(null);
  expect(queue.count).toBe(firstCount);
  producers.seatMailArrived({ seat: 'OP', unread: 2 + 1 });
  expect(queue.count).toBe(firstCount + 1);
});

test('감시 줄 — 빈 줄은 버리고, 긴 줄은 자르고, 같은 줄은 한 번만', () => {
  expect(eventWatchNotice('  ')).toBe(null);
  expect(eventWatchNotice('deploy green\n')).toBe('deploy green');
  const queue = quietQueue();
  const producers = createChildNoticeProducers(queue);
  expect(producers.eventWatchLine('   ')).toBe(null);
  const first = producers.eventWatchLine('deploy green');
  expect(first?.source).toBe('event-watch');
  expect(producers.eventWatchLine('deploy green')).toBe(null);
  expect(queue.count).toBe(1);
  const long = 'x'.repeat(200 + 5);
  expect(eventWatchNotice(long)?.endsWith('…')).toBe(true);
  expect(eventWatchNotice(long)?.length).toBe(200);
});

test('종료·읽기 실패는 명령만 줄이고 접미어는 남긴다', () => {
  const command = 'c'.repeat(200);
  expect(eventWatchStatusLine('감시 종료: ', command, '종료 코드 1')).toBe(
    `감시 종료: ${'c'.repeat(200 - '감시 종료: '.length - ' — 종료 코드 1'.length - 1)}… — 종료 코드 1`,
  );
  expect(eventWatchStatusLine('감시 종료: ', command, '종료 코드 1').length).toBe(200);
  expect(eventWatchStatusLine('감시 읽기 실패: ', command, 'ENOENT').endsWith(' — ENOENT')).toBe(true);
  expect(eventWatchStatusLine('감시 읽기 실패: ', command, 'ENOENT').length).toBe(200);
  expect(eventWatchStatusLine('감시 종료: ', 'deploy.sh', '종료 코드 1')).toBe('감시 종료: deploy.sh — 종료 코드 1');
  expect(eventWatchStatusLine('감시 만료: ', command, '시한').endsWith(' — 시한')).toBe(true);
  expect(eventWatchStatusLine('감시 만료: ', command, '시한').length).toBe(200);
  expect(eventWatchStatusLine('감시 만료: ', 'sleep 999', '시한')).toBe('감시 만료: sleep 999 — 시한');
  const longReason = `${'R'.repeat(210)}TAIL-GONE`;
  const longLine = eventWatchStatusLine('감시 읽기 실패: ', command, longReason);
  expect(longLine.length).toBe(200);
  expect(longLine.endsWith('…')).toBe(true);
  expect(longLine.includes('TAIL-GONE')).toBe(false);
  expect(longLine.includes(longReason.slice(0, 40))).toBe(true);
  expect(longLine.startsWith('감시 읽기 실패: ')).toBe(true);
  // A suffix that fills the line still leaves the command mark.
  expect(longLine.includes('… — ')).toBe(true);
  const oneColumn = eventWatchStatusLine('감시 읽기 실패: ', 'deploy.sh', 'R'.repeat(200));
  expect(oneColumn.length).toBe(200);
  expect(oneColumn.startsWith('감시 읽기 실패: … — ')).toBe(true);
  expect(oneColumn.includes('deploy')).toBe(false);
});

test('알림은 사람 입력 뒤로 — 경계 소비 순서는 큐가 이미 정한다', () => {
  const queue = quietQueue();
  const producers = createChildNoticeProducers(queue);
  producers.harnessChildFinished({ goal: 'g', outcome: 'done' });
  queue.enqueue('사람 입력');
  const head = queue.dequeue();
  expect(head.kind).toBe('submit');
  if (head.kind === 'submit') expect(head.text).toBe('사람 입력');
});
