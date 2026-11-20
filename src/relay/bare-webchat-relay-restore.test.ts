// 출처: WEBCHAT-PIN-RESTORE (#39175) — 실 relay(startRelayServer + 실 createRelayAutoAppRegistrar)
// ↔ 실 connectRelayHost 로, 정적 dispatch 핸들의 핀 쓰기 거부(전제)와 읽기 전용 재생 복원을
// 끝-끝 실측한다. 하니스 선례: public-app-auto-registration.test.ts · bare-webchat-relay-member.test.ts.
import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import {
  createRelayAutoAppRegistrar,
  type RelayPublicPolicySnapshot,
} from './public-app-auto-registration.js';
import { startRelayServer } from './relay-server.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createRelayWebChatLedger, restoreWebChatHandlePins } from '../nexus/api/http-server.js';

const OWNER = 'owner-demo';
const DEMO = 'demohandle';
const FOREIGN = 'foreignhandle';

async function harness(withRegistrar: boolean) {
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(7));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signingKeys = generateKeyPairSync('ed25519');
  const publicKey = (signingKeys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32)
    .toString('base64url');
  const policy: RelayPublicPolicySnapshot = {
    trustedHostKeys: new Map([[serverId, publicKey]]),
    hostOwnerMemberIds: new Map([[serverId, OWNER]]),
    publicDispatchRoutes: new Map([[DEMO, { serverId, ownerMemberId: OWNER }]]), // 정적 dispatch — 동적 핀 영구 거부 대상
    publicReadableApps: new Set<string>(),
    publicVisitorWritePolicies: [],
    publicHandleClaimOwners: new Map([
      [DEMO, OWNER],
      [FOREIGN, 'owner-other'],
    ]),
  };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-restore-')));
  let registrar: ReturnType<typeof createRelayAutoAppRegistrar>;
  const relay = startRelayServer({
    port: 0,
    hostname: '127.0.0.1',
    publicDomain: 'elanous.app',
    memberRequired: true,
    validateMemberToken: async () => ({ memberId: OWNER }),
    ...policy,
    ...(withRegistrar
      ? {
          autoAppRegistration: {
            register: (h: string, o: string, i: never) => registrar.register(h, o, i),
            unregister: (h: string, o: string, i: never) => registrar.unregister(h, o, i),
            pinHandle: (h: string, o: string, i: never) => registrar.pinHandle(h, o, i),
            queryHandleClaims: (s: string, o: string) => registrar.queryHandleClaims(s, o),
          },
        }
      : {}),
  } as never);
  registrar = createRelayAutoAppRegistrar({
    file: join(dir, 'auto-apps.json'),
    domain: 'elanous.app',
    staticPolicy: () => policy,
    apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
  });
  const connection = await connectRelayHost({
    relayUrl: `ws://127.0.0.1:${relay.port}/host`,
    daemonKeys,
    hostSigningKey: signingKeys.privateKey,
    getMemberToken: async () => 'emt_fake_test_member',
    handleRequest: async () => new Response('ok', { status: 200 }),
  });
  return { relay, connection, dir };
}

const emptyStore = () => createMemberStore({ path: ':memory:', now: () => Date.parse('2026-11-20T00:00:00.000Z') });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('실 relay: 정적 dispatch 핸들 핀 쓰기는 영구 거부 · 읽기 전용 재생은 소유 claim 만 복원', async () => {
  const { relay, connection, dir } = await harness(true);
  try {
    // (i) 전제 — 실 pinPublicHandle 이 dispatch 충돌로 거부된다(쓰기 경로 불가).
    await expect(connection.pinPublicHandle(DEMO, OWNER)).rejects.toThrow();
    // (ii) 새 원장 + 빈 로컬 스토어 + 실 relay claims 질의 → demo 만 기록.
    const ledger = createRelayWebChatLedger({});
    ledger.setPinQueryChannel(async () => true);
    let writes = 0;
    restoreWebChatHandlePins(
      ledger,
      async () => {
        writes++;
      },
      emptyStore(),
      connection.publicHandleClaimsQuery.bind(connection),
    );
    await settle();
    expect(ledger.pinOwners.get(DEMO)).toBe(OWNER);
    expect(ledger.pinOwners.has(FOREIGN)).toBe(false);
    expect(writes).toBe(0);
  } finally {
    connection.close();
    relay.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('실 relay: autoAppRegistration 없음 → 2s 상한 빈 목록 · 아무것도 기록되지 않음(fail-closed)', async () => {
  const { relay, connection, dir } = await harness(false);
  try {
    const ledger = createRelayWebChatLedger({});
    const startedAt = Date.now();
    restoreWebChatHandlePins(ledger, async () => undefined, emptyStore(), connection.publicHandleClaimsQuery.bind(connection));
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect(ledger.pinOwners.size).toBe(0);
  } finally {
    connection.close();
    relay.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
