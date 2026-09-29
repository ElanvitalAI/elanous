import { describe, expect, test } from 'bun:test';
import type { PtyEvent } from '../../pty-shell/registry.js';
import { handleTerminalControl, handleTerminalStream, parseTerminalStreamPath } from './terminals.js';

const OPTS = { noAuth: true } as never;
const req = (path: string) => new Request(`http://nexus.test${path}`);

async function readEvents(res: Response, until: (events: Array<{ event: string; data: unknown }>) => boolean, ms = 2000): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: Array<{ event: string; data: unknown }> = [];
  const deadline = Date.now() + ms;
  // ⛔ 읽기 약속은 «하나»만 들고 간다 — 타임아웃이 이길 때마다 새 read() 를 부르면 앞 read() 의 값이 버려진다(두 번째 화면을 놓쳤다).
  let pending: ReturnType<typeof reader.read> | null = null;
  let finished = false;
  while (Date.now() < deadline && !until(events) && !finished) {
    pending ??= reader.read();
    const r = await Promise.race([pending, new Promise<null>((res) => setTimeout(() => res(null), 100))]);
    if (r === null) continue;
    pending = null;
    if (r.done) finished = true;
    if (r.value) buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe('GET /v1/terminals/:id/stream', () => {
  test('path matcher', () => {
    expect(parseTerminalStreamPath('/v1/terminals/pty_1/stream')).toBe('pty_1');
    expect(parseTerminalStreamPath('/v1/terminals/pty_1/scrollback')).toBeNull();
  });

  test('daemon-owned PTY: reset with the current screen, then output bytes batched, then end on exit', async () => {
    const listeners = new Set<(ev: PtyEvent) => void>();
    const res = handleTerminalStream(req('/v1/terminals/p1/stream'), OPTS, 'p1', {
      getPty: () => ({ renderScreen: async () => 'SCREEN' }),
      onPtyEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
      flushMs: 5,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    setTimeout(() => {
      for (const cb of listeners) { cb({ type: 'output', id: 'p1', chunk: 'ab' }); cb({ type: 'output', id: 'other', chunk: 'X' }); cb({ type: 'output', id: 'p1', chunk: 'c\x1b[1m' }); }
      setTimeout(() => { for (const cb of listeners) cb({ type: 'exit', id: 'p1', exitCode: 0 }); }, 30);
    }, 30);
    const events = await readEvents(res, (e) => e.some((x) => x.event === 'end'));
    expect(events[0]).toEqual({ event: 'mode', data: { mode: 'bytes' } });
    expect(events).toContainEqual({ event: 'reset', data: { screen: 'SCREEN' } });
    expect(events.filter((e) => e.event === 'data').map((e) => e.data).join('')).toBe('abc\x1b[1m');
    expect(events.at(-1)).toEqual({ event: 'end', data: { reason: 'exit' } });
    expect(listeners.size).toBe(0);
  });

  test('foreign PTY: server-side snapshots, only changes are sent, sourceRoot goes to the manifest', async () => {
    const screens = ['A', 'A', 'B'];
    const seen: Array<string | undefined> = [];
    let n = 0;
    const res = handleTerminalStream(req('/v1/terminals/p2/stream?sourceRoot=/db/x'), OPTS, 'p2', {
      isAllowedSourceRoot: (p) => p === '/db/x',
      requestRemotePtyControl: async (_id, _a, _p, o) => {
        seen.push(o?.manifestDbPath);
        const s = screens[n++];
        return s ? { status: 'success', screen: s } as never : { status: 'unknown-pty' } as never;
      },
      pollMs: 150,
    });
    const events = await readEvents(res, (e) => e.some((x) => x.event === 'end'), 3000);
    expect(events[0]).toEqual({ event: 'mode', data: { mode: 'screen', pollMs: 150 } });
    expect(events.filter((e) => e.event === 'screen').map((e) => (e.data as { screen: string }).screen)).toEqual(['A', 'B']);
    expect(events.at(-1)).toEqual({ event: 'end', data: { reason: 'unknown-pty' } });
    expect(seen.every((p) => p === '/db/x')).toBe(true);
  });

  test('an unknown sourceRoot is refused', () => {
    const res = handleTerminalStream(req('/v1/terminals/p3/stream?sourceRoot=/nope'), OPTS, 'p3', { isAllowedSourceRoot: () => false });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/terminals/:id/control — sourceRoot', () => {
  test('the manifest root from ?sourceRoot reaches the owner request (it was ignored)', async () => {
    let got: string | undefined;
    const res = await handleTerminalControl(new Request('http://nexus.test/v1/terminals/p4/control?sourceRoot=/db/y', { method: 'POST', body: JSON.stringify({ action: 'snapshot', ansi: true }) }), OPTS, 'p4', {
      isAllowedSourceRoot: (p) => p === '/db/y',
      requestRemotePtyControl: async (_id, _a, _p, o) => { got = o?.manifestDbPath; return { status: 'success', screen: 'S' } as never; },
    });
    expect(res.status).toBe(200);
    expect(got).toBe('/db/y');
  });
});
