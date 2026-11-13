import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayMemberTokenProvider, readRelayMemberKeyFile } from './member-token-provider';

const serverId = 'a'.repeat(64);
// 출처: src/relay/member-token-provider.ts mintTimeoutMsForTesting의 abort-timer 계약. 이 값은 시험용 짧은 타이머다.
const RELAY_MINT_TEST_TIMEOUT_MS = 15;

test('mints a fresh relay.connect token bound to the requested host without URL credential leakage', async () => {
  const requests: Request[] = [];
  let keysRead = 0;
  const provider = createRelayMemberTokenProvider({ nexusUrl: 'https://hq.example.test/',
    readMemberKey: () => { keysRead++; return 'emk_private'; },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ token: 'emt_fresh' }), { status: 201 });
    }) as typeof fetch,
  });
  expect(await provider(serverId)).toBe('emt_fresh');
  expect(await provider(serverId)).toBe('emt_fresh');
  expect(keysRead).toBe(2);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.url).toBe('https://hq.example.test/v1/tokens');
    expect(request.headers.get('authorization')).toBe('Bearer emk_private');
    expect(await request.json()).toEqual({ scopes: ['relay.connect'], ttlSec: 600, audience: serverId });
  }
});

test('fails closed on unsafe origins, invalid audience, and rejected mint without echoing a key', async () => {
  expect(() => createRelayMemberTokenProvider({ nexusUrl: 'http://hq.example.test/', readMemberKey: () => 'emk_private' })).toThrow('HTTPS origin');
  const rejected = createRelayMemberTokenProvider({ nexusUrl: 'https://hq.example.test/', readMemberKey: () => 'emk_private',
    fetchImpl: (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch });
  await expect(rejected('wrong')).rejects.toThrow('invalid relay serverId');
  await expect(rejected(serverId)).rejects.toThrow('relay member token mint rejected');
});

test('a stalled member-token mint is bounded and cancellation aborts the request', async () => {
  const signals: AbortSignal[] = [];
  const provider = createRelayMemberTokenProvider({ nexusUrl: 'https://hq.example.test/',
    readMemberKey: () => 'emk_private', mintTimeoutMsForTesting: RELAY_MINT_TEST_TIMEOUT_MS,
    fetchImpl: (async (_input, init) => {
      signals.push(init!.signal!);
      return await new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  await expect(provider(serverId)).rejects.toThrow('relay member token mint failed');
  expect(signals[0]?.aborted).toBe(true);

  const controller = new AbortController();
  const pending = provider(serverId, controller.signal);
  for (let attempt = 0; attempt < 10 && signals.length < 2; attempt += 1) await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow('relay member token mint failed');
  expect(signals[1]?.aborted).toBe(true);
});

test('reads only a private regular member key file', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-member-key-'));
  try {
    const key = join(root, 'key');
    writeFileSync(key, 'emk_testMemberKey\n', { mode: 0o600 });
    expect(readRelayMemberKeyFile(key)).toBe('emk_testMemberKey');
    const link = join(root, 'link');
    symlinkSync(key, link);
    expect(() => readRelayMemberKeyFile(link)).toThrow('relay member key unavailable');
    const broad = join(root, 'broad');
    writeFileSync(broad, 'emk_testMemberKey\n', { mode: 0o644 });
    expect(() => readRelayMemberKeyFile(broad)).toThrow('relay member key unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
