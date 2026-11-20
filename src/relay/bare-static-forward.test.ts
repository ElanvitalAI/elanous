import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { serverIdFromPublicKey } from './channel.js';
import { startRelayServer } from './relay-server.js';
import { isBareStaticAssetRequest } from './bare-static-path.js';

test('every static asset referenced by the deployed chat document is allowed', () => {
  // Snapshot of the actual minim5 3aef2c5a7775 PWA chat document's src/href
  // static references, captured 2026-11-20; no request or credential data.
  const refs = readFileSync(new URL('./fixtures/bare-webchat-real-assets.txt', import.meta.url), 'utf8').trim().split('\n');
  expect(refs.length).toBe(29);
  for (const path of refs) expect([path, isBareStaticAssetRequest('GET', path)]).toEqual([path, true]);
});

// MK #109530 — bare 핸들 호스트: 익명 GET/HEAD /app/_next/static/** 만 회원 Nexus 로 포워드.
// 호스트 미연결이면 «게이트 통과 = 503 Host unavailable», «게이트 차단 = 401», «미핀/미지 = 404».
test('isBareStaticAssetRequest: allowlist, methods, traversal', () => {
  const ok = (m: string, p: string) => isBareStaticAssetRequest(m, p);
  expect(ok('GET', '/app/_next/static/chunks/a-12345678.js')).toBe(true);
  expect(ok('HEAD', '/app/_next/static/css/b-12345678.css')).toBe(true);
  expect(ok('GET', '/app/_next/static/test-build-Id/_buildManifest.js')).toBe(true);
  expect(ok('HEAD', '/app/_next/static/test-build-Id/_ssgManifest.js')).toBe(true);
  expect(ok('GET', '/app/_next/static/test-build-Id/_otherManifest.js')).toBe(false);
  expect(ok('GET', '/app/icons/elanous-32.png')).toBe(true);
  expect(ok('GET', '/app/manifest.webmanifest')).toBe(true);
  expect(ok('GET', '/app/fonts/inter.ttf')).toBe(true);
  expect(ok('HEAD', '/app/fonts/inter.ttf')).toBe(true);
  expect(ok('POST', '/app/fonts/inter.ttf')).toBe(false);
  expect(ok('GET', '/app/fonts/')).toBe(false);
  expect(ok('GET', '/app/fonts/../secret')).toBe(false);
  expect(ok('GET', '/app/fontsx/a.ttf')).toBe(false);
  expect(ok('POST', '/app/_next/static/chunks/a-12345678.js')).toBe(false);
  expect(ok('GET', '/app/_next/static/chunks/a.js')).toBe(false);
  expect(ok('GET', '/app/_next/static/chunks/a-12345678.js.map')).toBe(false);
  expect(ok('GET', '/app/_next/static/')).toBe(false);
  expect(ok('GET', '/app/_next/data/x.json')).toBe(false);
  expect(ok('GET', '/app/chat/')).toBe(false);
  expect(ok('GET', '/app/_next/static/../../secret')).toBe(false);
  expect(ok('GET', '/app/_next/static/%2e%2e/secret')).toBe(false);
  expect(ok('GET', '/app/_next/static/a%2fb')).toBe(false);
  expect(ok('GET', '/app/_next/static/..\\secret')).toBe(false);
  expect(ok('GET', '/app/_next/static//x')).toBe(false);
});

test('relay bare host: anonymous static GET/HEAD forwarded; everything else unchanged', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const now = Date.parse('2026-11-20T00:00:00.000Z');
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, publicKey]]), memberRequired: true,
    hostOwnerMemberIds: new Map([[serverId, 'owner-id']]), validateMemberToken: (async () => null) as never,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'owner', now: () => now } as never);
  const address = `http://127.0.0.1:${relay.port}`;
  const get = (path: string, init: RequestInit & { host?: string } = {}) =>
    fetch(`${address}${path}`, { ...init, headers: { host: init.host ?? 'owner.elanous.app', ...(init.headers as object) } });
  try {
    const asset = '/app/_next/static/chunks/main-app-12345678.js';
    // 익명 GET/HEAD → 게이트 통과(호스트 미연결 503 = 포워드 지점 도달).
    expect((await get(asset)).status).toBe(503);
    expect((await get(asset, { method: 'HEAD' })).status).toBe(503);
    // POST → 포워드 안 됨(공개 앱 0개 bare: 기존 404 그대로).
    expect((await get(asset, { method: 'POST', body: 'x' })).status).toBe(404);
    // 경로 탈출 → 포워드 안 됨.
    for (const bad of ['/app/_next/static/%2e%2e%2fchat/x', '/app/_next/static/a%5cb', '/app/_next/static/..%2f..%2fsecret'])
      expect([bad, (await get(bad)).status]).not.toEqual([bad, 503]);
    // 비정적 경로 불변: 쿠키 없는 /app/other, /v1/me 는 회원 게이트 401/404 그대로.
    expect((await get('/app/other/x.js')).status).not.toBe(503);
    expect((await get('/v1/me')).status).not.toBe(503);
    // 미핀 호스트 → 포워드 안 됨(404).
    expect((await get(asset, { host: 'stranger.elanous.app' })).status).toBe(404);
  } finally { relay.stop(); }
});
