// JUD jud-39564-225ca0a55d12 회귀(OP #132035) — 공유 링크 진입점(링크 해석 핸들러) 계약.
// 회귀 두 줄: 남의 객체 링크 → 거부(403 상당 — 라우트가 상태로 매핑할 오류) ·
// 버전 바뀐 객체 → 고정 버전만(교체된 최신은 절대 내주지 않는다).
// 실패 먼저(§35): 진입점이 없는 지금 diff 에서는 이 파일이 module-not-found 로 전면 RED 다.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createMemberShareLink,
  revokeMemberShareLink,
  type MemberShareLedger,
} from './member-share-link.js';
import { createObjectStore, type ObjectStore, type StorageConfig } from './object-store.js';
import { readMemberShareObject } from './member-share-read.js';

const NOW = 1_736_000_000_000;
const TTL = 60_000;

function memLedger(): MemberShareLedger {
  let state: Record<string, unknown> | null = null;
  return {
    load: () => state,
    update: (mutate) => {
      const { newState, result } = mutate(state);
      state = newState;
      return result;
    },
  };
}

function localStore(): { store: ObjectStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'member-share-read-'));
  const cfg: StorageConfig = { provider: 'local', localDir: dir, bucket: '', publicBucket: '', prefix: 'monad' };
  return { store: createObjectStore(cfg), dir };
}

function outPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'member-share-out-')), name);
}

/** get 호출을 지켜보는 데코레이터 — 남의 링크 거부 시 바이트 미제공·고정 get 강제를 검증한다. */
function spyGet(store: ObjectStore): { spy: ObjectStore; calls: Array<{ key: string; localPath: string; generation?: string }> } {
  const calls: Array<{ key: string; localPath: string; generation?: string }> = [];
  const spy: ObjectStore = {
    provider: store.provider,
    put: (k, b, o) => store.put(k, b, o),
    delete: (k) => store.delete(k),
    get: (key, localPath, opts) => {
      calls.push({ key, localPath, generation: opts?.generation });
      store.get(key, localPath, opts);
    },
    head: (k) => store.head(k),
    list: (p) => store.list(p),
    publicUrl: (k) => store.publicUrl(k),
  };
  return { spy, calls };
}

describe('member share read entry (jud-39564-225ca0a55d12 · OP #132035)', () => {
  test('소유자 본인 링크 → 발급 때 세대로 고정 get, 바이트는 그 세대만', () => {
    const { store } = localStore();
    const key = 'members/alice/private/a.txt';
    store.put(key, 'v1');
    const g1 = store.head(key).generation;
    expect(typeof g1).toBe('string');
    const ledger = memLedger();
    const rec = createMemberShareLink(ledger, key, { ownerMemberId: 'alice', generation: g1!, now: NOW, ttlMs: TTL });
    const { spy, calls } = spyGet(store);
    const out = outPath('a.txt');
    const got = readMemberShareObject({ ledger, store: spy, token: rec.token, authenticatedMemberId: 'alice', now: NOW + 1_000, localPath: out });
    expect(got.objectKey).toBe(key);
    expect(got.ownerMemberId).toBe('alice');
    expect(got.generation).toBe(g1!); // head().generation 좁힘 — 68행과 같은 비원단언(TS2769 수리)
    expect(got.expiresAtMs).toBe(NOW + TTL);
    expect(readFileSync(out, 'utf8')).toBe('v1');
    // 출처: #39564 jud-39564-225ca0a55d12 — 진입점은 고정 get 을 한 곳에서만 부른다.
    expect(calls.length).toBe(1);
    expect(calls[0]!.generation).toBe(g1); // 세대 없는 읽기 경로는 이 핸들러에 없다
  });

  test('남의 객체 링크 → 거부(403 상당) · get 미호출 · 바이트 미제공', () => {
    const { store } = localStore();
    const key = 'members/alice/private/b.txt';
    store.put(key, 'secret-of-alice');
    const g1 = store.head(key).generation;
    const ledger = memLedger();
    const rec = createMemberShareLink(ledger, key, { ownerMemberId: 'alice', generation: g1!, now: NOW, ttlMs: TTL });
    const { spy, calls } = spyGet(store);
    const out = outPath('b.txt');
    expect(() => readMemberShareObject({ ledger, store: spy, token: rec.token, authenticatedMemberId: 'bob', now: NOW + 1_000, localPath: out })).toThrow(/not owned by caller/);
    // 출처: #39564 jud-39564-225ca0a55d12 — 남의 링크는 소유자 확인에서 거부, get 은 불리지 않는다.
    expect(calls.length).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  test('버전 바뀐 객체 → 고정 버전만: 교체된 최신은 절대 내주지 않는다', () => {
    const { store } = localStore();
    const key = 'members/alice/private/c.txt';
    store.put(key, 'v1');
    const g1 = store.head(key).generation;
    const ledger = memLedger();
    const rec = createMemberShareLink(ledger, key, { ownerMemberId: 'alice', generation: g1!, now: NOW, ttlMs: TTL });
    store.put(key, 'v2-attacker-swap'); // 발급 뒤 같은 경로 교체 — 세대가 갈린다(put 은 tmp+rename)
    const out = outPath('c.txt');
    expect(() => readMemberShareObject({ ledger, store, token: rec.token, authenticatedMemberId: 'alice', now: NOW + 1_000, localPath: out })).toThrow(/generation mismatch|세대/);
    expect(existsSync(out)).toBe(false); // 교체된 최신 바이트('v2')는 어디에도 남지 않는다
  });

  test('미인증 호출자(빈 memberId) → 즉시 거부(fail-closed)', () => {
    const { store } = localStore();
    const key = 'members/alice/private/d.txt';
    store.put(key, 'v1');
    const g1 = store.head(key).generation;
    const ledger = memLedger();
    const rec = createMemberShareLink(ledger, key, { ownerMemberId: 'alice', generation: g1!, now: NOW, ttlMs: TTL });
    const out = outPath('d.txt');
    expect(() => readMemberShareObject({ ledger, store, token: rec.token, authenticatedMemberId: '', now: NOW + 1_000, localPath: out })).toThrow(/invalid/);
  });

  test('만료 토큰 → 거부(resolve 계약 경유)', () => {
    const { store } = localStore();
    const key = 'members/alice/private/e.txt';
    store.put(key, 'v1');
    const g1 = store.head(key).generation;
    const ledger = memLedger();
    const rec = createMemberShareLink(ledger, key, { ownerMemberId: 'alice', generation: g1!, now: NOW, ttlMs: 1_000 });
    const out = outPath('e.txt');
    expect(() => readMemberShareObject({ ledger, store, token: rec.token, authenticatedMemberId: 'alice', now: NOW + 1_001, localPath: out })).toThrow(/expired/);
  });

  test('폐기 토큰 → 거부 · get 미호출', () => {
    const { store } = localStore();
    const key = 'members/alice/private/f.txt';
    store.put(key, 'v1');
    const g1 = store.head(key).generation;
    const ledger = memLedger();
    const rec = createMemberShareLink(ledger, key, { ownerMemberId: 'alice', generation: g1!, now: NOW, ttlMs: TTL });
    revokeMemberShareLink(ledger, rec.token, { ownerMemberId: 'alice', now: NOW + 1 });
    const { spy, calls } = spyGet(store);
    const out = outPath('f.txt');
    expect(() => readMemberShareObject({ ledger, store: spy, token: rec.token, authenticatedMemberId: 'alice', now: NOW + 1_000, localPath: out })).toThrow(/revoked/);
    // 출처: #39564 jud-39564-225ca0a55d12 — 폐기된 링크로는 get 이 불리지 않는다.
    expect(calls.length).toBe(0);
  });
});
