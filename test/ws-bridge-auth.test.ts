// /v1/acp upgrade-time auth: header, subprotocol, first-line handshake.
//
// Drives createWsBridge through a fake BunServerLike so the tests do
// not bind a real port. Reuses createAuthVerifier from
// src/acp/transport/auth.ts (constant-time token compare).

import { connect } from 'node:net';
import { describe, expect, test } from 'bun:test';

import { createAuthVerifier } from '../src/acp/transport/auth.js';
import {
  createWsBridge,
  offeredAcpTokenFromUpgrade,
  WS_ACP_PATH,
  WS_VOICE_PATH,
  type BunServerLike,
  type WsLike,
} from '../src/boot/ws-bridge.js';
import type { AcpTransportConnection } from '../src/acp/transport/types.js';
import {
  PWA_VOICE_FRAME_KIND,
  type PwaVoiceAdapter,
  type PwaVoiceSession,
} from '../src/voice/channel-adapters/pwa-voice-adapter.js';

const GOOD_TOKEN = 'good-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const BAD_TOKEN = 'bad-token-bbbbbbbbbbbbbbbbbbbbbbbbb';

function makeVerifier() {
  return createAuthVerifier([{ token: GOOD_TOKEN, issuedAt: 0, label: 'default' }]);
}

function makeFakeSocket(): WsLike & {
  sent: string[];
  closed: { code?: number; reason?: string } | null;
} {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    sent,
    get closed() { return closed; },
    send(data) { sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); },
    close(code, reason) { closed = { code, reason }; },
  };
}

function makeServer(): BunServerLike & {
  lastUpgrade: { req: Request; opts?: { data?: unknown; headers?: HeadersInit } } | null;
  upgradeCalls: number;
} {
  const state: {
    lastUpgrade: { req: Request; opts?: { data?: unknown; headers?: HeadersInit } } | null;
    upgradeCalls: number;
  } = { lastUpgrade: null, upgradeCalls: 0 };
  return {
    get lastUpgrade() { return state.lastUpgrade; },
    get upgradeCalls() { return state.upgradeCalls; },
    upgrade(req, opts) {
      state.upgradeCalls += 1;
      state.lastUpgrade = { req, opts };
      return true;
    },
  };
}

function acpRequest(init?: {
  authorization?: string;
  protocol?: string;
}): Request {
  const headers = new Headers();
  headers.set('upgrade', 'websocket');
  headers.set('connection', 'Upgrade');
  if (init?.authorization) headers.set('authorization', init.authorization);
  if (init?.protocol) headers.set('sec-websocket-protocol', init.protocol);
  return new Request(`http://127.0.0.1:31415${WS_ACP_PATH}`, { headers });
}

function voiceRequest(): Request {
  const headers = new Headers();
  headers.set('upgrade', 'websocket');
  headers.set('connection', 'Upgrade');
  headers.set('authorization', `Bearer ${BAD_TOKEN}`);
  headers.set('sec-websocket-protocol', `bearer.${BAD_TOKEN}`);
  return new Request(`http://127.0.0.1:31415${WS_VOICE_PATH}`, { headers });
}

function makeVoiceAdapter(pushed?: Buffer[]): PwaVoiceAdapter {
  const session: PwaVoiceSession = {
    pushUpstream: (frame: { pcm: Buffer }) => { pushed?.push(frame.pcm); },
    finalize: async () => { /* noop */ },
    close: async () => { /* noop */ },
    onDownstream: () => () => { /* noop */ },
    onStateChange: () => () => { /* noop */ },
  } as unknown as PwaVoiceSession;
  return {
    available: true,
    openSession: async () => session,
  } as unknown as PwaVoiceAdapter;
}

function encodeVoiceFrame(kind: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, kind);
  view.setUint8(1, 0);
  view.setUint16(2, 0, false);
  out.set(payload, 4);
  return out;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function socketFromUpgrade(
  server: ReturnType<typeof makeServer>,
): ReturnType<typeof makeFakeSocket> & { data?: unknown } {
  const ws = makeFakeSocket() as ReturnType<typeof makeFakeSocket> & { data?: unknown };
  ws.data = server.lastUpgrade?.opts?.data;
  return ws;
}

async function readAcpChunk(conn: AcpTransportConnection, ms = 80): Promise<string> {
  const reader = conn.readable.getReader();
  return await Promise.race([
    reader.read().then((r) => r.value ? new TextDecoder().decode(r.value) : ''),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), ms)),
  ]);
}

describe('offeredAcpTokenFromUpgrade', () => {
  test('Authorization: Bearer wins over subprotocol', () => {
    const req = acpRequest({
      authorization: `Bearer ${GOOD_TOKEN}`,
      protocol: `bearer.${BAD_TOKEN}`,
    });
    expect(offeredAcpTokenFromUpgrade(req)).toBe(GOOD_TOKEN);
  });

  test('reads bearer. from Sec-WebSocket-Protocol when no header', () => {
    const req = acpRequest({ protocol: `chat, bearer.${GOOD_TOKEN}` });
    expect(offeredAcpTokenFromUpgrade(req)).toBe(GOOD_TOKEN);
  });

  test('tokenless request returns undefined', () => {
    expect(offeredAcpTokenFromUpgrade(acpRequest())).toBeUndefined();
  });
});

describe('/v1/acp upgrade auth', () => {
  test('header auth: Authorization Bearer good token auths before first message', async () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(acpRequest({ authorization: `Bearer ${GOOD_TOKEN}` }), server);
    expect(res).toBeUndefined();
    expect(server.upgradeCalls).toBe(1);
    expect(server.lastUpgrade?.opts?.headers).toBeUndefined();

    const ws = socketFromUpgrade(server);
    bridge.websocket.open?.(ws);
    expect(conns.length).toBe(1);

    bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(ws.closed).toBeNull();
    expect(await readAcpChunk(conns[0]!)).toContain('initialize');
    await conns[0]!.close();
  });

  test('subprotocol auth: bearer.<token> auths before first message', async () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(acpRequest({ protocol: `bearer.${GOOD_TOKEN}` }), server);
    expect(res).toBeUndefined();
    expect(server.lastUpgrade?.opts?.headers).toBeUndefined();

    const ws = socketFromUpgrade(server);
    bridge.websocket.open?.(ws);
    expect(conns.length).toBe(1);

    bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(ws.closed).toBeNull();
    expect(await readAcpChunk(conns[0]!)).toContain('initialize');
    await conns[0]!.close();
  });

  // 0.2.5 회귀(2026-09-30): 토큰을 저장하지 않은 PWA 가 이 데몬이 내준 페이지에서 연 ACP 소켓 — HTTP 와 같은 same-origin 면제.
  function sameOriginAcpRequest(extra?: Record<string, string>): Request {
    const headers = new Headers({
      upgrade: 'websocket', connection: 'Upgrade',
      host: '127.0.0.1:31415', origin: 'http://127.0.0.1:31415', 'sec-fetch-site': 'same-origin',
      ...extra,
    });
    return new Request(`http://127.0.0.1:31415${WS_ACP_PATH}`, { headers });
  }
  function serverWithPeer(address: string | null) {
    const server = makeServer();
    return Object.assign(server, { requestIP: () => (address ? { address } : null) });
  }

  test('same-origin PWA socket from loopback is authed without a token (0.2.5 PWA regression)', async () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1', port: 31415, wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); }, trace: () => {},
    });
    const server = serverWithPeer('127.0.0.1');
    expect(bridge.tryUpgrade(sameOriginAcpRequest(), server)).toBeUndefined();
    const ws = socketFromUpgrade(server);
    bridge.websocket.open?.(ws);
    bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(ws.closed).toBeNull();
    expect(await readAcpChunk(conns[0]!)).toContain('initialize');
    await conns[0]!.close();
  });

  test('same-origin exemption does not open for proxied, remote, cross-site or unknown peers', () => {
    const cases: Array<[string, Request, string | null]> = [
      ['tailscale serve proxy', sameOriginAcpRequest({ 'x-forwarded-for': '100.1.2.3' }), '127.0.0.1'],
      ['remote peer', sameOriginAcpRequest(), '100.81.37.51'],
      ['cross-site page', sameOriginAcpRequest({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }), '127.0.0.1'],
      ['unknown peer', sameOriginAcpRequest(), null],
    ];
    for (const [label, req, peer] of cases) {
      const bridge = createWsBridge({
        hostname: '127.0.0.1', port: 31415, wsAuthVerifier: makeVerifier(),
        acpOnConnection: () => {}, trace: () => {},
      });
      const server = serverWithPeer(peer);
      bridge.tryUpgrade(req, server);
      const ws = socketFromUpgrade(server);
      bridge.websocket.open?.(ws);
      bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
      expect({ label, code: ws.closed?.code }).toEqual({ label, code: 1008 });
    }
  });

  test('tokenless first-message auth: {"kind":"auth","token"} → {"ok":true} then ACP', async () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(acpRequest(), server);
    expect(res).toBeUndefined();
    expect(server.upgradeCalls).toBe(1);

    const ws = socketFromUpgrade(server) as ReturnType<typeof makeFakeSocket> & { data?: unknown };
    bridge.websocket.open?.(ws);
    expect(conns.length).toBe(0);

    bridge.websocket.message?.(ws, JSON.stringify({ kind: 'auth', token: GOOD_TOKEN }));
    expect(ws.sent).toEqual([JSON.stringify({ ok: true })]);
    expect(conns.length).toBe(1);

    bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(ws.closed).toBeNull();
    expect(await readAcpChunk(conns[0]!)).toContain('initialize');
    await conns[0]!.close();
  });

  test('unauthenticated ACP bytes are blocked until handshake', () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); },
    });
    const server = makeServer();
    bridge.tryUpgrade(acpRequest(), server);
    const ws = socketFromUpgrade(server) as ReturnType<typeof makeFakeSocket> & { data?: unknown };
    bridge.websocket.open?.(ws);
    bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(conns.length).toBe(0);
    expect(ws.closed).toEqual({ code: 1008, reason: 'auth_failed' });
    expect(ws.closed?.reason).not.toContain(GOOD_TOKEN);
    expect(ws.closed?.reason).not.toContain(BAD_TOKEN);
  });

  test('malformed first-message handshake closes with a distinct safe reason', () => {
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: async () => { /* unused */ },
    });
    const server = makeServer();
    bridge.tryUpgrade(acpRequest(), server);
    const ws = socketFromUpgrade(server) as ReturnType<typeof makeFakeSocket> & { data?: unknown };
    bridge.websocket.open?.(ws);
    bridge.websocket.message?.(ws, 'not-json');

    expect(ws.closed).toEqual({ code: 1008, reason: 'malformed_handshake' });
    expect(ws.closed?.reason).not.toBe('auth_failed');
    expect(ws.closed?.reason).not.toContain(GOOD_TOKEN);
    expect(ws.closed?.reason).not.toContain(BAD_TOKEN);
  });

  test('invalid Authorization token is rejected before upgrade (not 101)', () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(acpRequest({ authorization: `Bearer ${BAD_TOKEN}` }), server);
    expect(res).toBeDefined();
    expect(res!.status).not.toBe(101);
    expect(res!.status).toBe(401);
    expect(server.upgradeCalls).toBe(0);
    expect(conns.length).toBe(0);
  });

  test('invalid subprotocol token is rejected before upgrade', () => {
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: async () => { /* unused */ },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(acpRequest({ protocol: `bearer.${BAD_TOKEN}` }), server);
    expect(res).toBeDefined();
    expect(res!.status).not.toBe(101);
    expect(server.upgradeCalls).toBe(0);
  });

  test('verifier-free legacy: tokenless /v1/acp processes ACP immediately', async () => {
    const conns: AcpTransportConnection[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      acpOnConnection: (c) => { conns.push(c); },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(acpRequest(), server);
    expect(res).toBeUndefined();
    const ws = socketFromUpgrade(server);
    bridge.websocket.open?.(ws);
    expect(conns.length).toBe(1);
    bridge.websocket.message?.(ws, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(ws.closed).toBeNull();
    expect(await readAcpChunk(conns[0]!)).toContain('initialize');
    await conns[0]!.close();
  });

  test('Bun ECHOES the offered subprotocol on the 101 — the token comes back (measured)', async () => {
    const conns: AcpTransportConnection[] = [];
    const upgradeOpts: Array<{ headers?: HeadersInit } | undefined> = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 0,
      wsAuthVerifier: makeVerifier(),
      acpOnConnection: (c) => { conns.push(c); },
    });
    const bunServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const wrapped: BunServerLike = {
          upgrade(r, opts) {
            upgradeOpts.push(opts);
            return (srv.upgrade as (req: Request, opts?: { data?: unknown; headers?: HeadersInit }) => boolean)(r, opts);
          },
        };
        const res = bridge.tryUpgrade(req, wrapped);
        if (res !== undefined) return res;
        return undefined as unknown as Response;
      },
      websocket: {
        open(ws) { bridge.websocket.open?.(ws as unknown as WsLike); },
        message(ws, msg) { bridge.websocket.message?.(ws as unknown as WsLike, msg); },
        close(ws, code, reason) { bridge.websocket.close?.(ws as unknown as WsLike, code, reason); },
      },
    });
    const protocol = `bearer.${GOOD_TOKEN}`;
    try {
      const handshake = await new Promise<{ status: number; headerBlock: string }>((resolve, reject) => {
        const sock = connect(Number(bunServer.port), '127.0.0.1', () => {
          const key = Buffer.from('0123456789abcdef').toString('base64');
          sock.write(
            `GET ${WS_ACP_PATH} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${bunServer.port}\r\n` +
            `Connection: Upgrade\r\n` +
            `Upgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Protocol: ${protocol}\r\n` +
            `\r\n`,
          );
        });
        let buf = '';
        sock.setEncoding('utf8');
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error('upgrade timeout'));
        }, 2_000);
        sock.on('data', (chunk) => {
          buf += chunk;
          if (!buf.includes('\r\n\r\n')) return;
          clearTimeout(timer);
          sock.destroy();
          const headerBlock = buf.split('\r\n\r\n')[0] ?? '';
          const statusLine = headerBlock.split('\r\n')[0] ?? '';
          const status = Number(statusLine.split(' ')[1] ?? '0');
          resolve({ status, headerBlock });
        });
        sock.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      expect(handshake.status).toBe(101);
      expect(upgradeOpts.length).toBeGreaterThanOrEqual(1);
      expect(upgradeOpts[0]?.headers).toBeUndefined();
      const selected = handshake.headerBlock
        .split('\r\n')
        .filter((line) => /^sec-websocket-protocol:/i.test(line))
        .map((line) => line.slice(line.indexOf(':') + 1).trim());
      for (const value of selected) {
        expect(value === '' || value === protocol).toBe(true);
      }

      const ws = new WebSocket(`ws://127.0.0.1:${bunServer.port}${WS_ACP_PATH}`, protocol);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws open timeout')), 2_000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
      });
      // ⛔ 「'' 이거나 protocol 이거나」는 «둘 다 통과»시켜 아무것도 안 문다.
      //    실측(raw 101)으로 «어느 쪽인지» 확정했으므로 그 값을 단정한다:
      //    Bun 은 클라이언트가 제시한 서브프로토콜을 «되돌려 보낸다».
      //    ⇒ 이 줄이 깨지면 Bun 의 동작이 바뀐 것이고, 그때 이 판의
      //      「토큰이 101 에 되비친다」 주석도 같이 다시 재야 한다.
      expect(ws.protocol).toBe(protocol);
      expect(conns.length).toBeGreaterThanOrEqual(1);
      ws.close();
    } finally {
      bunServer.stop(true);
      await Promise.all(conns.map((c) => c.close().catch(() => { /* already */ })));
    }
  }, 20_000);
});

// ⚠️ 이름 정정(리뷰 3차): 이 절은 「unchanged」가 «아니다».
//    ⓐ «런타임» 동작은 안 바뀐다 — 이 PR 전에는 wsAuthVerifier 가 어디서도 대입되지
//       않아 voice 는 «언제나» authed:true 였다.
//    ⓑ 그러나 «잠재 관문»은 제거된다 — `authed: !opts.wsAuthVerifier` 를 `authed: true`
//       로 못 박았으므로, 검증기를 배선해도 voice 는 더 이상 잠기지 않는다.
//    ⇒ 이것은 회귀 방어가 «아니라» ***의도적인 인증 우회 계약***이다. 이유는 아래 시험 주석.
describe('/v1/voice stays OPEN by decision; dev-proxy untouched', () => {
  test('/v1/voice/ws without verifier upgrades authed and allows PCM without HELLO', async () => {
    const pushed: Buffer[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      voiceAdapter: makeVoiceAdapter(pushed),
      acpOnConnection: async () => { /* unused */ },
      trace: () => { /* silent */ },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(voiceRequest(), server);
    expect(res).toBeUndefined();
    expect(server.upgradeCalls).toBe(1);
    const data = server.lastUpgrade?.opts?.data as { state?: { kind?: string; authed?: boolean } };
    expect(data?.state?.kind).toBe('voice');
    expect(data?.state?.authed).toBe(true);

    const ws = socketFromUpgrade(server);
    bridge.websocket.open?.(ws);
    await flushMicrotasks();
    bridge.websocket.message?.(ws, encodeVoiceFrame(PWA_VOICE_FRAME_KIND.UPSTREAM_PCM, new Uint8Array([1, 2])));
    expect(pushed.length).toBe(1);
    expect(ws.closed).toBeNull();
  });

  // 🩸 이 자리엔 「verifier 면 voice 도 unauthed 로 올라가고 HELLO 로 인증한다」는 시험이
  //    있었는데, 그 HELLO 로 {kind:'auth', token} 을 넣고 있었다. ***PWA 는 그 모양을 안 보낸다.***
  //    apps/pwa/src/voice/use-voice-controller.ts:193 → hello: { surface:'pwa', userAgent }
  //    apps/pwa/src/voice/voice-websocket.ts:95      → { ...hello, ...(token ? {token} : {}) }
  //    ⇒ 실제 payload 엔 `kind` 가 «없고», createAuthVerifier.verify() 는 그것을 malformed 로
  //      되돌려 1008 로 닫는다. iOS 도 VoiceWebSocketClient.swift:139 에서 헤더를 «우회»한다.
  //    ⇒ 그래서 voice 는 검증기가 있어도 «열어 둔다». 아래가 그 회귀 방어다.
  test('DECISION: a wired verifier deliberately does NOT gate voice (real PWA hello has no kind:auth)', async () => {
    const pushed: Buffer[] = [];
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      voiceAdapter: makeVoiceAdapter(pushed),
      acpOnConnection: async () => { /* unused */ },
      trace: () => { /* silent */ },
    });
    const server = makeServer();
    const res = bridge.tryUpgrade(voiceRequest(), server);
    expect(res).toBeUndefined();
    const data = server.lastUpgrade?.opts?.data as { state?: { kind?: string; authed?: boolean } };
    expect(data?.state?.kind).toBe('voice');
    // 여기가 false 가 되면 PWA·iOS 음성이 «끊긴다».
    expect(data?.state?.authed).toBe(true);

    const ws = socketFromUpgrade(server);
    bridge.websocket.open?.(ws);
    await flushMicrotasks();
    // ⭐ «실제» PWA HELLO 모양 — kind 가 없다.
    bridge.websocket.message?.(ws, encodeVoiceFrame(
      PWA_VOICE_FRAME_KIND.UPSTREAM_HELLO,
      new TextEncoder().encode(JSON.stringify({ surface: 'pwa', userAgent: 'test', token: GOOD_TOKEN })),
    ));
    expect(ws.closed).toBeNull();
    bridge.websocket.message?.(ws, encodeVoiceFrame(PWA_VOICE_FRAME_KIND.UPSTREAM_PCM, new Uint8Array([1, 2])));
    // 잠겨 있었다면 여기가 0 이다.
    expect(pushed.length).toBe(1);
  });

  test('dev-proxy path still upgrades without consulting the ACP verifier', () => {
    const bridge = createWsBridge({
      hostname: '127.0.0.1',
      port: 31415,
      wsAuthVerifier: makeVerifier(),
      devProxyUpstream: 'http://127.0.0.1:3000',
      acpOnConnection: async () => { /* unused */ },
    });
    const server = makeServer();
    const req = new Request('http://127.0.0.1:31415/_next/webpack-hmr', {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        authorization: `Bearer ${BAD_TOKEN}`,
      },
    });
    const res = bridge.tryUpgrade(req, server);
    expect(res).toBeUndefined();
    expect(server.upgradeCalls).toBe(1);
    const data = server.lastUpgrade?.opts?.data as { state?: { kind?: string } };
    expect(data?.state?.kind).toBe('dev-proxy');
  });
});
