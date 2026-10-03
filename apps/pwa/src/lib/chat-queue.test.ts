import { expect, test } from 'bun:test';
import { CHAT_QUEUE_LIMIT, clearChatQueue, dequeueChat, enqueueChat, removeChat } from './chat-queue';

test('FIFO insert and take, remove one and clear all without mutating prior queue', () => {
  const first = enqueueChat([], { id: 1, text: ' first ' }).queue;
  const both = enqueueChat(first, { id: 2, text: 'second' }).queue;
  expect(first).toEqual([{ id: 1, text: 'first' }]);
  expect(dequeueChat(both)).toEqual({ entry: { id: 1, text: 'first' }, queue: [{ id: 2, text: 'second' }] });
  expect(removeChat(both, 1)).toEqual([{ id: 2, text: 'second' }]);
  expect(clearChatQueue()).toEqual([]);
  expect(dequeueChat([])).toEqual({ entry: undefined, queue: [] });
});

test('blank text is not enqueued and sixth entry is rejected with capacity message', () => {
  let queue = enqueueChat([], { id: 0, text: ' \n ' }).queue;
  expect(queue).toEqual([]);
  for (let id = 1; id <= CHAT_QUEUE_LIMIT; id++) queue = enqueueChat(queue, { id, text: `line ${id}` }).queue;
  expect(queue).toHaveLength(5);
  expect(enqueueChat(queue, { id: 6, text: 'six' })).toEqual({ queue, error: '줄이 찼습니다' });
});
