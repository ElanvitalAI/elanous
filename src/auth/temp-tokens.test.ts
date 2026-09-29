import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { issueTempToken, listTempTokens, matchTempToken, parseTtl, revokeTempTokens } from './temp-tokens.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { buildNexusWsBridgeAuth } from '../nexus/index.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'elt-')); setElanousConfigDir(dir); });
afterEach(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

describe('단기 소유자 토큰 — 저장소', () => {
  test('발급하면 원문은 반환값에만 있고 저장소엔 해시만(0600)', () => {
    const issued = issueTempToken({ ttlMs: 60_000, label: 'verify' });
    expect(issued.token.startsWith('elt_')).toBe(true);
    const raw = readFileSync(join(dir, 'temp-tokens.json'), 'utf8');
    expect(raw).not.toContain(issued.token);
    expect(statSync(join(dir, 'temp-tokens.json')).mode & 0o777).toBe(0o600);
    expect(matchTempToken(issued.token)?.id).toBe(issued.id);
    expect(JSON.stringify(listTempTokens())).not.toContain(issued.token);
  });
  test('만료되면 거부 · 회수하면 거부 · 모르는 값·접두 없는 값은 거부', () => {
    const now = Date.now();
    const a = issueTempToken({ ttlMs: 1_000, now });
    expect(matchTempToken(a.token, { now: now + 2_000 })).toBeNull();
    const b = issueTempToken({ ttlMs: 60_000 });
    expect(revokeTempTokens({ id: b.id })).toBe(1);
    expect(matchTempToken(b.token)).toBeNull();
    expect(matchTempToken('elt_nope')).toBeNull();
    expect(matchTempToken('not-prefixed')).toBeNull();
  });
  test('수명 상한 24시간 · 형식', () => {
    expect(() => issueTempToken({ ttlMs: 25 * 3_600_000 })).toThrow();
    expect([parseTtl('90s'), parseTtl('15m'), parseTtl('2h'), parseTtl('1d')]).toEqual([90_000, 900_000, 7_200_000, 86_400_000]);
    expect(() => parseTtl('15')).toThrow();
  });
});

describe('단기 소유자 토큰 — 두 인증 길이 받는다(실제 라우터 · 실제 웹소켓 검증기)', () => {
  const opts = { metaApi: { bearerToken: 'owner-secret-owner-secret' } } as NexusHttpServerOpts;
  const server = { requestIP: () => ({ address: '203.0.113.1' }) } as any;
  const ref = { get: () => null } as any;
  const get = (bearer: string) => new Request('http://remote.invalid/v1/trace', { headers: { authorization: `Bearer ${bearer}` } });

  test('HTTP — 유효한 단기 토큰은 통과(401 아님) · 회수 뒤엔 401', async () => {
    const t = issueTempToken({ ttlMs: 60_000 });
    expect((await routeRequest(get(t.token), opts, server, null, ref))?.status).not.toBe(401);
    revokeTempTokens({ id: t.id });
    expect((await routeRequest(get(t.token), opts, server, null, ref))?.status).toBe(401);
    expect((await routeRequest(get('elt_forged'), opts, server, null, ref))?.status).toBe(401);
  });

  test('ACP 웹소켓 — 단기 토큰 허용 · 회수 뒤 거부 · 소유자 토큰은 그대로', () => {
    const t = issueTempToken({ ttlMs: 60_000 });
    const { wsAuthVerifier } = buildNexusWsBridgeAuth('owner-secret-owner-secret', { configDir: dir });
    expect(wsAuthVerifier!.verify({ kind: 'auth', token: t.token }).ok).toBe(true);
    expect(wsAuthVerifier!.verify({ kind: 'auth', token: 'owner-secret-owner-secret' }).ok).toBe(true);
    revokeTempTokens({ all: true });
    expect(wsAuthVerifier!.verify({ kind: 'auth', token: t.token }).ok).toBe(false);
  });
});
