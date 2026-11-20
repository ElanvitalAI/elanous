import { expect, test } from 'bun:test';
import { createElsFeed } from './els-subscribe.js';

// ELS-DESKTOP-SIDETAB-SUBSCRIBE gap (a), S1 mock: the TUI side panel follows the els server by push; the 1 s timer is
// only the fallback when the subscription is not live (and a slow heartbeat for the federated/remote part).
function harness(heartbeatTicks = 10) {
  const log = { subscribes: 0, closes: 0, changes: 0 };
  let handlers!: { onList: (m: string) => void; onEnd: (r: string) => void };
  const feed = createElsFeed({
    subscribe: (h) => { log.subscribes++; handlers = h; return { close: () => { log.closes++; } }; },
    onChange: () => { log.changes++; },
    heartbeatTicks, retryTicks: 3,
  });
  return { feed, log, push: (m: string) => handlers.onList(m), end: (r: string) => handlers.onEnd(r) };
}

test('before the first push the feed is not live: every tick asks for a poll (the 1 s fallback)', () => {
  const h = harness();
  expect(h.feed.tick().poll).toBe(true);
  expect(h.feed.live()).toBe(false);
  expect(h.feed.tick().poll).toBe(true);
  expect(h.log.subscribes).toBe(1);
});

test('once the server pushes, ticks stop polling except a slow heartbeat; each push is one change', () => {
  const h = harness(5);
  h.feed.tick();
  h.push('{"panes":[]}');
  expect(h.feed.live()).toBe(true);
  expect(h.log.changes).toBe(1);
  const polls = Array.from({ length: 10 }, () => h.feed.tick().poll);
  expect(polls.filter(Boolean).length).toBe(2);
  h.push('{"panes":[1]}');
  expect(h.log.changes).toBe(2);
});

test('when the subscription ends the feed falls back to polling and resubscribes after the retry delay', () => {
  const h = harness();
  h.feed.tick();
  h.push('{}');
  h.end('els: the els server closed the connection');
  expect(h.feed.live()).toBe(false);
  expect(h.feed.tick().poll).toBe(true);
  expect(h.log.subscribes).toBe(1);   // retry not due yet
  h.feed.tick(); h.feed.tick();
  expect(h.log.subscribes).toBe(2);
});

test('an unsupported server (ended before any list) never goes live: it polls every tick', () => {
  const h = harness();
  h.feed.tick();
  h.end('els: unknown request');
  for (let i = 0; i < 6; i++) expect(h.feed.tick().poll).toBe(true);
  expect(h.feed.live()).toBe(false);
});

test('stop closes the subscription and a late push is ignored', () => {
  const h = harness();
  h.feed.tick();
  h.push('{}');
  h.feed.stop();
  expect(h.log.closes).toBe(1);
  h.push('{"x":1}');
  expect(h.log.changes).toBe(1);
  expect(h.feed.tick().poll).toBe(true);
  expect(h.log.subscribes).toBe(1);   // a stopped feed does not reconnect
});
