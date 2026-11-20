import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serverIdFromPublicKey } from './channel.js';
import { RELAY_HTTP_IDLE_TIMEOUT_SECONDS, startRelayServer } from './relay-server.js';

// MK #109818 — relay 의 Bun.serve 가 기본 10초 idleTimeout 이면 조용한 SSE 가 끊긴다.
test('relay HTTP listener idleTimeout is Bun max (255s), not the 10s default', () => {
  expect(RELAY_HTTP_IDLE_TIMEOUT_SECONDS).toBe(255);
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  // Bun.serve 가 255(최대 허용값)를 거부하지 않고 뜬다.
  const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', trustedHostKeys: new Map([[serverId, publicKey]]) });
  try {
    expect(Number.isInteger(relay.port)).toBe(true);
  } finally {
    relay.stop();
  }
});
