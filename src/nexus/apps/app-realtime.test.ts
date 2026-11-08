import { describe, expect, test } from 'bun:test';
import { handleSseEvents } from '../api/events.js';
import { NexusEventBus } from '../api/event-bus.js';
import { appRealtimeSnapshotCursor, handleAppRealtimeEvents } from './app-realtime.js';
import type { NexusEvent } from '../state/state.js';

function publish(bus: NexusEventBus, appSlug: string, rowId: string): void {
  bus.publish({
    ts: Date.now(),
    kind: 'app.row.insert' as NexusEvent['kind'],
    detail: { appSlug, rowId, row: { id: rowId } },
  });
}

async function nextText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return new TextDecoder().decode(chunk.value);
}

function cursorOf(frame: string): string {
  const value = /^id: (.+)$/m.exec(frame)?.[1];
  if (!value) throw new Error(`SSE frame has no id: ${frame}`);
  return value;
}

describe('app-scoped realtime SSE', () => {
  test('delivers only the requested app row events on the real event bus', async () => {
    const bus = new NexusEventBus();
    const noCursor = handleAppRealtimeEvents(bus, 'app-a', null);
    expect(noCursor.status).toBe(409);
    expect(await noCursor.json()).toMatchObject({ reason: 'snapshot-cursor-required' });
    const cursor = appRealtimeSnapshotCursor(bus, 'app-a');
    const reader = handleAppRealtimeEvents(bus, 'app-a', cursor).body!.getReader();
    expect(await nextText(reader)).toContain(': app row events stream');

    publish(bus, 'app-b', 'foreign');
    publish(bus, 'app-a', 'visible');
    const frame = await nextText(reader);
    expect(frame).toMatch(/^id: [0-9a-f-]{36}:[0-9a-f-]{36}:1\nevent: app\.row\.insert\n/);
    expect(frame).toContain('"appSlug":"app-a"');
    expect(frame).toContain('"rowId":"visible"');
    expect(frame).not.toContain('foreign');

    await reader.cancel();
    expect(bus.size()).toBe(1); // only the bounded replay observer remains
  });

  test('Last-Event-ID replays missed events from that app only', async () => {
    const bus = new NexusEventBus();
    const snapshotCursor = appRealtimeSnapshotCursor(bus, 'app-a');
    const first = handleAppRealtimeEvents(bus, 'app-a', snapshotCursor).body!.getReader();
    await nextText(first);
    publish(bus, 'app-a', 'seen');
    const seen = await nextText(first);
    const cursor = cursorOf(seen);
    expect(seen).toContain('event: app.row.insert');
    await first.cancel();

    publish(bus, 'app-a', 'missed');
    publish(bus, 'app-b', 'other-app');
    const resumed = handleAppRealtimeEvents(bus, 'app-a', cursor).body!.getReader();
    await nextText(resumed);
    const replay = await nextText(resumed);
    expect(replay).toMatch(/^id: [0-9a-f-]{36}:[0-9a-f-]{36}:2\nevent: app\.row\.insert\n/);
    expect(replay).toContain('"rowId":"missed"');
    expect(replay).not.toContain('other-app');
    await resumed.cancel();
  });

  test('the unauthenticated generic event stream never exposes app row data', async () => {
    const bus = new NexusEventBus();
    const reader = handleSseEvents(bus, new URL('http://nexus.test/v1/events')).body!.getReader();
    expect(await nextText(reader)).toContain(': nexus events stream');
    publish(bus, 'app-a', 'secret-row');
    bus.publish({ ts: Date.now(), kind: 'nexus.boot', detail: { phase: 'test' } });
    const ordinary = await nextText(reader);
    expect(ordinary).toContain('event: nexus.boot');
    expect(ordinary).not.toContain('secret-row');
    await reader.cancel();
    expect(bus.size()).toBe(0); // generic listener was removed; no app stream was opened
  });

  test('stale, evicted, and previous-process cursors request a full resync', async () => {
    const bus = new NexusEventBus();
    const initial = handleAppRealtimeEvents(bus, 'app-a', appRealtimeSnapshotCursor(bus, 'app-a')).body!.getReader();
    await nextText(initial);
    publish(bus, 'app-a', 'oldest');
    const oldCursor = cursorOf(await nextText(initial));
    await initial.cancel();
    for (let index = 0; index < 257; index++) publish(bus, 'app-a', `new-${index}`);

    const expired = handleAppRealtimeEvents(bus, 'app-a', oldCursor);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: 'app-events-resync-required', reason: 'history-window-expired' });

    const [epoch, generation] = oldCursor.split(':');
    if (!epoch || !generation) throw new Error('generated cursor has malformed structure');
    const previousProcess = handleAppRealtimeEvents(bus, 'app-a', `00000000-0000-4000-8000-000000000000:${generation}:1`);
    expect(previousProcess.status).toBe(409);
    expect(await previousProcess.json()).toMatchObject({ reason: 'process-epoch-changed' });
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('LRU app history has a global cap and evicted apps receive resync', async () => {
    const bus = new NexusEventBus();
    const first = handleAppRealtimeEvents(bus, 'app-0', appRealtimeSnapshotCursor(bus, 'app-0')).body!.getReader();
    await nextText(first);
    publish(bus, 'app-0', 'row-0');
    const cursor = cursorOf(await nextText(first));
    await first.cancel();
    for (let index = 1; index < 257; index++) publish(bus, `app-${index}`, `row-${index}`);
    const evicted = handleAppRealtimeEvents(bus, 'app-0', cursor);
    expect(evicted.status).toBe(409);
    expect(await evicted.json()).toMatchObject({ error: 'app-events-resync-required', reason: 'app-history-evicted' });
  });

  test('emits heartbeat frames while idle and clears its timer on cancellation', async () => {
    const bus = new NexusEventBus();
    const cursor = appRealtimeSnapshotCursor(bus, 'app-a');
    let timerCleared = 0;
    const clearTimer: typeof clearInterval = (timer) => {
      timerCleared++;
      globalThis.clearInterval(timer as never);
    };
    const reader = handleAppRealtimeEvents(bus, 'app-a', cursor, { heartbeatMs: 5,
      clearInterval: clearTimer }).body!.getReader();
    await nextText(reader);
    expect(await nextText(reader)).toContain(': ping');
    await reader.cancel();
    expect(bus.size()).toBe(1);
    expect(timerCleared).toBe(1);
  });

  test('snapshot cursor closes the read-snapshot-subscribe gap', async () => {
    const bus = new NexusEventBus();
    const snapshotCursor = appRealtimeSnapshotCursor(bus, 'app-a');
    // A row changes after the cursor is captured but before snapshot completion and stream open.
    publish(bus, 'app-a', 'changed-during-snapshot');
    const reader = handleAppRealtimeEvents(bus, 'app-a', snapshotCursor).body!.getReader();
    await nextText(reader);
    const replay = await nextText(reader);
    expect(replay).toContain('"rowId":"changed-during-snapshot"');
    await reader.cancel();
  });

  test('overflow before a delivered event ID closes safely and reconnect requests full resync', async () => {
    const bus = new NexusEventBus();
    const snapshotCursor = appRealtimeSnapshotCursor(bus, 'app-a');
    const slowReader = handleAppRealtimeEvents(bus, 'app-a', snapshotCursor).body!.getReader();
    for (let index = 0; index < 257; index++) publish(bus, 'app-a', `queued-${index}`);
    expect(await nextText(slowReader)).toContain(': app row events stream');
    expect((await slowReader.read()).done).toBe(true);

    const reconnect = handleAppRealtimeEvents(bus, 'app-a', snapshotCursor);
    expect(reconnect.status).toBe(409);
    expect(await reconnect.json()).toMatchObject({ error: 'app-events-resync-required', reason: 'history-window-expired' });
  });
});
