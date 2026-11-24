// ELN-AGENT-EVENT-PROTOCOL residual — the notice production door, measured:
// 1) unit: every producer's notice reaches the bridge exactly once, queue semantics untouched (the JUD-B HOLD note
//    said only a synthetic bridge test existed — this wires the real door and proves it);
// 2) real wire: a REAL emitter (getAgentEventEmitter) + REAL transport (sendFrameOverSocket) over a REAL unix
//    socket carry the exact frame the production made — the line on the wire parses (neutral protocol) as the
//    notice that was enqueued. The els-side reader (src/els/agent-events.ts decodeEventLine) is the frame side of
//    the boundary and is covered by its own tests; this file must not import els (boundary guard).
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentEventBridge, type AgentEventBridge } from './agent-event-bridge.js';
import { wireNoticeEvents } from './agent-event-notice-wire.js';
import { createNextTuiQueue } from './core/queue.js';
import { getAgentEventEmitter } from '../agent-events/emit.js';
import { parseEventFrame } from '../agent-events/protocol.js';

const recordingBridge = (): { bridge: AgentEventBridge; seen: { level: string; text: string }[] } => {
  const seen: { level: string; text: string }[] = [];
  return { seen, bridge: { busy: () => {}, attention: () => {}, blocked: () => {}, resume: () => {}, approval: () => {}, notice: (level: 'info' | 'warn' | 'alert', text: string) => { seen.push({ level, text }); } } };
};

test('every notice the queue accepts is emitted once, and the queue item is untouched', () => {
  const queue = createNextTuiQueue();
  const { bridge, seen } = recordingBridge();
  wireNoticeEvents(queue, bridge);
  const item = queue.enqueueNotice('OP: one', 'seat-mail', { msgId: 5 });
  expect(item.status).toBe('queued');
  expect(queue.get(item.id)?.text).toBe('OP: one');
  expect(queue.count).toBe(1);
  expect(seen).toEqual([{ level: 'info', text: 'OP: one' }]);
});

test('urgent seat mail emits alert; the capsule summary row emits through the same door (this.enqueueNotice)', () => {
  const queue = createNextTuiQueue();
  const { bridge, seen } = recordingBridge();
  wireNoticeEvents(queue, bridge);
  queue.enqueueNotice('OP: 긴급', 'seat-mail', { urgent: true });
  const row = queue.enqueueCapsuleDoneNotice('캡슐 완료 1건', 'cap-1', 'ok');
  expect(row?.status).toBe('queued');
  expect(seen.map((one) => one.level)).toEqual(['alert', 'info']);
  expect(seen[1]?.text).toBe('캡슐 완료 1건');
});

test('a throwing bridge never changes the queue answer', () => {
  const queue = createNextTuiQueue();
  wireNoticeEvents(queue, { busy: () => {}, attention: () => {}, blocked: () => {}, resume: () => {}, approval: () => {}, notice: () => { throw new Error('sink down'); } });
  const item = queue.enqueueNotice('still queued', 'event-watch');
  expect(item.status).toBe('queued');
  expect(queue.count).toBe(1);
});

test('the real wire: a real emitter over a real unix socket carries exactly the notice production made', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-wire-'));
  const sockPath = join(dir, 'events.sock');
  const lines: string[] = [];
  const server = createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let index = buf.indexOf('\n');
      while (index >= 0) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        if (line.trim()) { lines.push(line); socket.write(JSON.stringify({ exitCode: 0, message: 'event: accepted' }) + '\n'); }
        index = buf.indexOf('\n');
      }
    });
    socket.on('end', () => { if (buf.trim()) lines.push(buf.trim()); });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  const emitter = getAgentEventEmitter({ ELANOUS_EVENT_SOCKET: sockPath, ELANOUS_EVENT_WS: 'TEST' });
  expect(emitter).toBeDefined();
  const queue = createNextTuiQueue();
  wireNoticeEvents(queue, createAgentEventBridge(emitter));
  queue.enqueueNotice('OP: 실측 알림', 'seat-mail', { msgId: 7 });
  await emitter!.flush();
  expect(lines.length).toBe(1);
  const parsed = parseEventFrame(JSON.parse(lines[0]!));
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.frame.event).toEqual({ kind: 'notice', level: 'info', text: 'OP: 실측 알림' });
  expect(parsed.frame.ws).toBe('TEST');
  server.close();
  rmSync(dir, { recursive: true, force: true });
}, 20_000);
