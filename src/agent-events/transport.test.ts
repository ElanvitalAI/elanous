import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEventFrame } from './protocol.js';
import { parseEventFrame } from './protocol.js';
import { sendFrameOverSocket } from './transport.js';

// 출처: #38499 수용기준 - parseEventFrame 은 unknown 입력에서도 예외를 던지지 않는다: getter 가 던지는 프레임도 reason 로 끝난다.
test('a frame that throws from a field read (a getter) ends as a reason - it never escapes into the caller', () => {
  const hostile = { get op() { throw new Error('boom'); } };
  expect(() => parseEventFrame(hostile)).not.toThrow();
  expect(parseEventFrame(hostile)).toEqual({ ok: false, ignore: false, reason: 'frame could not be read' });
});

// 출처: #38499 수용기준 - reason 문자열 전체는 64자 상한(측정값 자체는 40자): 아무리 긴 v 도 reason 이 그 길이를 넘지 않는다.
test('the reason for an unknown version bounds the measured string', () => {
  const frame = parseEventFrame({ op: 'event', v: 2, ws: 'OP', sid: 's', seq: 1, at: 1, event: { kind: 'meta' } });
  const long = parseEventFrame({ op: 'event', v: `${'x'.repeat(500)}`, ws: 'OP', sid: 's', seq: 1, at: 1, event: { kind: 'meta' } });
  expect(frame).toEqual({ ok: false, ignore: true, reason: 'unknown protocol version 2' });
  if (long.ok || !long.ignore) throw new Error('expected an ignored frame');
  expect(long.reason.length).toBeLessThanOrEqual(64); // 출처: #38499 수용기준 — reason 전체 64자 상한
  expect(long.reason).toBe(`unknown protocol version ${'x'.repeat(39)}`); // 64자 상한: 25자 접두어 + 39자
});

test('a frame that cannot serialize fails that frame only - it never escapes the connect callback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-events-transport-'));
  const socketPath = join(dir, 'host.sock');
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (data) => { received.push(String(data)); socket.end(`${JSON.stringify({ exitCode: 0, message: 'ok' })}\n`); });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const hostile = { op: 'event', v: 1, ws: 'OP', sid: 's', seq: 1, at: 1, event: { kind: 'meta', queue: 10n } } as unknown as AgentEventFrame; // 출처: #38499 - terra must 3: a BigInt in the frame breaks JSON.stringify
    expect(await sendFrameOverSocket(socketPath, hostile)).toEqual({ exitCode: 1, message: 'event frame failed to serialize' });
    expect(received).toEqual([]); // nothing ever reached the host
    const good: AgentEventFrame = { op: 'event', v: 1, ws: 'OP', sid: 's', seq: 2, at: 1, event: { kind: 'meta', title: 't' } }; // 출처: #38499 - terra must 3: the very next well-formed frame still reaches the host
    expect(await sendFrameOverSocket(socketPath, good)).toEqual({ exitCode: 0, message: 'ok' });
    expect(received).toEqual([`${JSON.stringify(good)}\n`]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
