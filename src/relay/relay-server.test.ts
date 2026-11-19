import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acceptDaemonChannel,
  generateDaemonKeyPair,
  MAX_FRAME_BYTES,
  serverIdFromPublicKey,
} from "./channel.js";
import { MuxDecoder, MuxEncoder, MuxStreamState } from "./mux.js";
import {
  challengeMessage,
  loadRelayCustomDomainRoutes,
  loadTrustedHostKeys,
  parsePublicAppHost,
  resolvePublicAppUserId,
  startRelayServer,
} from "./relay-server.js";
import { validateRelayPublicOptions } from "./relay-cli.js";

type Relay = ReturnType<typeof startRelayServer>;
type RelayOptions = NonNullable<Parameters<typeof startRelayServer>[0]>;
type Message = string | Uint8Array;
const servers: Relay[] = [];
const openSockets: WebSocket[] = [];
const inbox = new WeakMap<WebSocket, Message[]>();
const waiters = new WeakMap<WebSocket, (value: Message) => void>();
const closeEvents = new WeakMap<WebSocket, CloseEvent>();
const closeWaiters = new WeakMap<WebSocket, (value: CloseEvent) => void>();
// Source: RFC 9110 §15.5.5 defines 404 as Not Found for an unregistered custom host.
const CUSTOM_HOST_NOT_FOUND_STATUS = 404;
// Source: RFC 9110 §15.3.1 defines the successful HTTP response used by this relay fixture.
const CUSTOM_HOST_OK_STATUS = 200;
// Source: MuxStreamState fixtures begin with stream id one in this test module.
const CUSTOM_HOST_FIRST_STREAM_ID = 1;
const signing = () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  return {
    pair,
    publicKey,
    id: serverIdFromPublicKey(
      new Uint8Array(
        generateKeyPairSync("x25519")
          .publicKey.export({ format: "der", type: "spki" })
          .subarray(-32),
      ),
    ),
  };
};
function relay(key: ReturnType<typeof signing>) {
  const instance = startRelayServer({
    trustedHostKeys: new Map([[key.id, key.publicKey]]),
  });
  servers.push(instance);
  return instance;
}
// 출처: #39024 — memberRequired 서버는 WS 업그레이드 자체가 회원 게이트를
// 지나므로, host WS 는 emt_ 프로토콜 자격증명으로 연결한다.
function connected(url: string, protocols?: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    openSockets.push(ws);
    ws.binaryType = "arraybuffer";
    inbox.set(ws, []);
    ws.addEventListener("message", (event) => {
      const value =
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer);
      const waiter = waiters.get(ws);
      if (waiter) {
        waiters.delete(ws);
        waiter(value);
      } else inbox.get(ws)!.push(value);
    });
    ws.addEventListener("close", (event) => {
      closeEvents.set(ws, event);
      closeWaiters.get(ws)?.(event);
      closeWaiters.delete(ws);
    });
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("connection failed")), {
      once: true,
    });
  });
}
function next(ws: WebSocket): Promise<Message> {
  const queued = inbox.get(ws)?.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 2000);
    waiters.set(ws, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
function closed(ws: WebSocket): Promise<CloseEvent> {
  const event = closeEvents.get(ws);
  if (event) return Promise.resolve(event);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("close timeout")), 2000);
    closeWaiters.set(ws, (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}
async function host(server: Relay, key: ReturnType<typeof signing>) {
  const ws = await connected(
    `ws://127.0.0.1:${server.port}/host?serverId=${key.id}`,
  );
  const challenge = JSON.parse((await next(ws)) as string) as {
    type: string;
    nonce: string;
  };
  expect(challenge.type).toBe("challenge");
  const signature = sign(
    null,
    challengeMessage(key.id, challenge.nonce),
    key.pair.privateKey,
  ).toString("base64url");
  ws.send(
    JSON.stringify({ type: "auth", publicKey: key.publicKey, signature }),
  );
  expect(JSON.parse((await next(ws)) as string)).toEqual({
    type: "authenticated",
  });
  return { ws, key };
}
// HANDLE-BARE-HOST-WEBCCHAT-PROXY: shared fixture — an authenticated host channel
// with the single pinned readable app a bare member host routes to.
async function bareHostFixture(
  publicUserId: string,
  extra?: (serverId: string) => Partial<RelayOptions>,
  wsProtocols?: string[],
) {
  const signingKey = generateKeyPairSync("ed25519");
  const signingPublicKey = signingKey.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(31));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const server = startRelayServer({
    trustedHostKeys: new Map([[serverId, signingPublicKey]]),
    publicDomain: "elanous.app",
    publicServerId: serverId,
    publicUserId,
    publicReadableApps: new Set([`${publicUserId}/chat`]),
    ...(extra ? extra(serverId) : {}),
  });
  servers.push(server);
  const hostSocket = await connected(
    `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`,
    wsProtocols,
  );
  const challenge = JSON.parse((await next(hostSocket)) as string) as {
    nonce: string;
  };
  hostSocket.send(
    JSON.stringify({
      type: "auth",
      publicKey: signingPublicKey,
      signature: sign(
        null,
        challengeMessage(serverId, challenge.nonce),
        signingKey.privateKey,
      ).toString("base64url"),
    }),
  );
  expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
    type: "authenticated",
    capabilities: ["public-http-v1"],
  });
  hostSocket.send(
    JSON.stringify({
      type: "host-public-key",
      publicKey: Buffer.from(daemonKeys.publicKey).toString("base64url"),
    }),
  );
  expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
    type: "host-public-key-accepted",
  });
  return { server, serverId, daemonKeys, hostSocket };
}
afterEach(() => {
  for (const ws of openSockets.splice(0)) ws.close();
  for (const server of servers.splice(0)) server.stop();
});

describe("Bun encrypted-frame relay", () => {
  test("public Nexus URLs and relay binding share one validated user identity", () => {
    expect(resolvePublicAppUserId(undefined, "kaist-demo")).toBe("kaist-demo");
    expect(resolvePublicAppUserId("kaist-demo", "kaist-demo")).toBe(
      "kaist-demo",
    );
    expect(() => resolvePublicAppUserId("other-user", "kaist-demo")).toThrow(
      "--public-user-id must match ELANOUS_PUBLIC_APP_USER_ID",
    );
    expect(() => resolvePublicAppUserId(undefined, "ka--ist")).toThrow(
      "valid public app user label",
    );
  });

  test("public app hosts follow the one-label elanous.app and D2 name contract", () => {
    expect(parsePublicAppHost("notes--alice.elanous.app")).toEqual({
      app: "notes",
      user: "alice",
    });
    expect(parsePublicAppHost("voice-note--user-7.elanous.app:443")).toEqual({
      app: "voice-note",
      user: "user-7",
    });
    for (const invalid of [
      "notes.alice.elanous.app",
      "notes--al.elanous.app",
      "-notes--alice.elanous.app",
      "notes--alice-.elanous.app",
      "notes--alice--other.elanous.app",
      "www--alice.elanous.app",
      "note--s--alice.elanous.app",
      "notes--ali--ce.elanous.app",
      "notes-pr12--alice.elanous.app",
      "notes--alice.other.test",
      "notes--alice.elanous.app.evil.test",
    ])
      expect(parsePublicAppHost(invalid)).toBeUndefined();
  });

  test("relay CLI requires a complete public domain/server/user tuple", () => {
    expect(() =>
      validateRelayPublicOptions({
        publicDomain: "elanous.app",
        publicServerId: "a".repeat(64),
      }),
    ).toThrow(
      "--public-domain, --public-server-id, and --public-user-id must be supplied together",
    );
    expect(() =>
      validateRelayPublicOptions({
        publicDomain: "other.test",
        publicServerId: "a".repeat(64),
        publicUserId: "alice",
      }),
    ).toThrow("public domain must be elanous.app or elanous.ai");
    expect(() =>
      validateRelayPublicOptions({
        publicDomain: "elanous.app",
        publicServerId: "a".repeat(64),
        publicUserId: "alice",
      }),
    ).not.toThrow();
    expect(() =>
      validateRelayPublicOptions({
        publicDomain: "elanous.ai",
        publicServerId: "a".repeat(64),
        publicUserId: "alice",
      }),
    ).not.toThrow();
  });

  test("public mode requires an explicit pinned host and keeps its listener behind the TLS edge", async () => {
    const key = signing();
    expect(() =>
      startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
      }),
    ).toThrow(
      "public relay requires a pinned publicServerId and valid publicUserId",
    );
    expect(() =>
      startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
        publicServerId: key.id,
        publicUserId: "ali--ce",
      }),
    ).toThrow(
      "public relay requires a pinned publicServerId and valid publicUserId",
    );
    expect(() =>
      startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
        publicServerId: key.id,
        publicUserId: "alice",
        hostname: "0.0.0.0",
      }),
    ).toThrow("listener must stay loopback");
    const relay = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "alice",
    });
    servers.push(relay);
    expect(relay.port).toBeGreaterThan(0);
    const invalidHost = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: "evil.example.test" },
    });
    expect(invalidHost.status).toBe(404);
    const validHostOffline = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: "notes--alice.elanous.app" },
    });
    expect(validHostOffline.status).toBe(503);
  });

  test("public mode binds app Host user labels to the configured Nexus identity", async () => {
    const key = signing();
    const server = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "alice",
    });
    servers.push(server);
    const wrongUser = await fetch(`http://127.0.0.1:${server.port}/hello`, {
      headers: { host: "notes--bob.elanous.app" },
    });
    expect(wrongUser.status).toBe(404);
    const correctUserOffline = await fetch(
      `http://127.0.0.1:${server.port}/hello`,
      { headers: { host: "notes--alice.elanous.app" } },
    );
    expect(correctUserOffline.status).toBe(503);
  });

  test("bare member host proxies the single pinned public app and refuses ambiguous routes", async () => {
    const key = signing();
    const server = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "user",
      publicReadableApps: new Set(["user/notes"]),
      // Without a member requirement every request passes the gate, so the write
      // route would only ever reach the offline-host 503. Requiring membership
      // makes the member gate answer 401 for anonymous writes, as on the app host.
      memberRequired: true,
      validateMemberToken: async () => null,
      hostOwnerMemberIds: new Map([[key.id, "member-1"]]),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/hello?part=2`;
    // Read routes now proxy into the single pinned app path: with no room connected
    // the answer is the app host's 503, not a redirect. 출처: #38981
    const good = await fetch(base, {
      headers: { host: "user.elanous.app" },
    });
    expect(good.status).toBe(503);
    // Write routes flow through the app path's member gate: 401, not route-closed 404.
    expect(
      (
        await fetch(base, {
          method: "POST",
          headers: { host: "user.elanous.app" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(base, { headers: { host: "other.elanous.app" } })).status,
    ).toBe(404);
    const ambiguous = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "user",
      publicReadableApps: new Set(["user/notes", "user/tasks"]),
    });
    servers.push(ambiguous);
    expect(
      (
        await fetch(`http://127.0.0.1:${ambiguous.port}/`, {
          headers: { host: "user.elanous.app" },
        })
      ).status,
    ).toBe(404);
  });

  test("bare host reserved words never fall into the pinned app proxy", async () => {
    // JUD FU #38981 1: the routing-layer exclusion is observable even when a
    // reserved word is itself pinned as the public user with a single readable
    // app — without the exclusion every host below would proxy the member app.
    for (const word of ["www", "docs", "api", "admin", "relay", "mail"]) {
      const key = signing();
      const server = startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
        publicServerId: key.id,
        publicUserId: word,
        publicReadableApps: new Set([`${word}/webchat`]),
        memberRequired: true,
        validateMemberToken: async () => null,
        hostOwnerMemberIds: new Map([[key.id, "member-1"]]),
      });
      servers.push(server);
      const res = await fetch(`http://127.0.0.1:${server.port}/hello`, {
        headers: { host: `${word}.elanous.app` },
      });
      expect(res.status).toBe(404); // 출처: #38994
    }
  });

  test("bare host answers /.well-known/elanous/apps with the opt-in listing", async () => {
    // JUD FU #38981 2: the bare host serves the public app listing itself with
    // no connected room, and the owner opt-in stays off by default (empty list).
    const key = signing();
    const server = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "user",
      publicReadableApps: new Set(["user/webchat"]),
      publicListedApps: new Set(["webchat"]),
      memberRequired: true,
      validateMemberToken: async () => null,
      hostOwnerMemberIds: new Map([[key.id, "member-1"]]),
    });
    servers.push(server);
    const listed = await fetch(
      `http://127.0.0.1:${server.port}/.well-known/elanous/apps`,
      { headers: { host: "user.elanous.app" } },
    );
    expect(listed.status).toBe(200); // 출처: #38994
    expect(listed.headers.get("content-type")).toBe("application/json");
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.headers.get("x-robots-tag")).toBe("noindex");
    expect(await listed.json()).toEqual({
      apps: ["https://webchat--user.elanous.app"],
    });
    const unlisted = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "user",
      publicReadableApps: new Set(["user/webchat"]),
      memberRequired: true,
      validateMemberToken: async () => null,
      hostOwnerMemberIds: new Map([[key.id, "member-1"]]),
    });
    servers.push(unlisted);
    const empty = await fetch(
      `http://127.0.0.1:${unlisted.port}/.well-known/elanous/apps`,
      { headers: { host: "user.elanous.app" } },
    );
    expect(empty.status).toBe(200); // 출처: #38994
    expect(await empty.json()).toEqual({ apps: [] });
    const post = await fetch(
      `http://127.0.0.1:${unlisted.port}/.well-known/elanous/apps`,
      { method: "POST", headers: { host: "user.elanous.app" } },
    );
    expect(post.status).toBe(405); // 출처: #38994
  });

  test("member session cookies stay bound to the serving host across bare and app origins", async () => {
    // JUD FU #38981 3: the bare host and the app host are different origins, so
    // a member session cookie must stay bound to whichever host served it. The
    // stub app host answers with a Domain=elanous.app widening attempt and the
    // live HTTP responses must hand the cookie back without any domain
    // attribute — the relay keeps the session on the origin the member used.
    const signingKey = generateKeyPairSync("ed25519");
    const signingPublicKey = signingKey.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    const daemonKeys = await generateDaemonKeyPair(
      new Uint8Array(32).fill(21), // 출처: #38994 — 기존 채널 시험의 결정론적 시드 상수
    );
    const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
    const server = startRelayServer({
      trustedHostKeys: new Map([[serverId, signingPublicKey]]),
      publicDomain: "elanous.app",
      publicServerId: serverId,
      publicUserId: "user",
      publicReadableApps: new Set(["user/webchat"]),
      // 출처: #38994 — memberRequired 서버는 host WS 를 멤버 자격증명 없이 거부한다
      // (relay-server.ts memberAuthorized). 이 시험의 본체는 쿠키 오리진 결속이고
      // 도메인 속성 제거는 무조건 적용이므로 회원 게이트 옵션을 끄고 잰다.
    });
    servers.push(server);
    const hostSocket = await connected(
      `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`,
    );
    const challenge = JSON.parse((await next(hostSocket)) as string) as {
      nonce: string;
    };
    hostSocket.send(
      JSON.stringify({
        type: "auth",
        publicKey: signingPublicKey,
        signature: sign(
          null,
          challengeMessage(serverId, challenge.nonce),
          signingKey.privateKey,
        ).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "authenticated",
      capabilities: ["public-http-v1"],
    });
    hostSocket.send(
      JSON.stringify({
        type: "host-public-key",
        publicKey: Buffer.from(daemonKeys.publicKey).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "host-public-key-accepted",
    });
    const answerSessionCookie = async (
      responsePromise: ReturnType<typeof fetch>,
    ): Promise<Awaited<ReturnType<typeof fetch>>> => {
      const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
      const clientId = new DataView(
        taggedPhoneKey.buffer,
        taggedPhoneKey.byteOffset,
        4, // 출처: #38994 — 프레임 접두 id 4바이트(기존 채널 시험 관행)
      ).getUint32(0, false); // 출처: #38994 — 빅엔디안 판독(기존 채널 시험 관행)
      const channel = await acceptDaemonChannel(
        daemonKeys,
        taggedPhoneKey.subarray(4), // 출처: #38994 — 접두 4바이트 뒤 페이로드(기존 관행)
      );
      if (!channel.ok) throw new Error(channel.reason);
      const streams = new MuxStreamState();
      const decoder = new MuxDecoder(streams);
      const encoder = new MuxEncoder(streams);
      const requestOpen = (await next(hostSocket)) as Uint8Array;
      const opened = channel.value.open(requestOpen.subarray(4)); // 출처: #38994 — 접두 4바이트 뒤 프레임(기존 관행)
      if (!opened.ok) throw new Error(opened.reason);
      const openFrame = decoder.decode(opened.value);
      if (!openFrame.ok || openFrame.value.kind !== "open")
        throw new Error("expected public HTTP open frame");
      expect(openFrame.value.headers.host).toBe("webchat.app.localhost");
      const requestEnd = await next(hostSocket);
      if (!(requestEnd instanceof Uint8Array))
        throw new Error(
          `expected encrypted request end frame, received control: ${requestEnd}`,
        );
      const ended = channel.value.open(requestEnd.subarray(4)); // 출처: #38994 — 접두 4바이트 뒤 프레임(기존 관행)
      if (!ended.ok) throw new Error(ended.reason);
      expect(decoder.decode(ended.value)).toEqual({
        ok: true,
        value: { streamId: 1, kind: "end" }, // 출처: #38994 — 첫 스트림 id 1(기존 관행)
      });
      const envelope = new TextEncoder().encode(
        JSON.stringify({
          status: 200, // 출처: #38994
          headers: {
            "content-type": "text/html",
            "set-cookie":
              "member-session=stub-member-session-1; Path=/; Domain=elanous.app; HttpOnly; SameSite=Lax",
          },
          body: Buffer.from("webchat session").toString("base64"),
        }),
      );
      const responseData = encoder.encode({
        streamId: 1, // 출처: #38994 — 첫 스트림 id 1(기존 관행)
        kind: "data",
        data: envelope,
      });
      if (!responseData.ok) throw new Error(responseData.reason);
      const encryptedData = channel.value.seal(responseData.value);
      if (!encryptedData.ok) throw new Error(encryptedData.reason);
      hostSocket.send(toIdBytes(clientId, encryptedData.value));
      const responseClose = encoder.encode({
        streamId: 1, // 출처: #38994 — 첫 스트림 id 1(기존 관행)
        kind: "close",
        reason: "",
      });
      if (!responseClose.ok) throw new Error(responseClose.reason);
      const encryptedClose = channel.value.seal(responseClose.value);
      if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
      hostSocket.send(toIdBytes(clientId, encryptedClose.value));
      const response = await responsePromise;
      await response.text();
      expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
        type: "client-disconnected",
      });
      return response;
    };
    const bareResponsePromise = fetch(`http://127.0.0.1:${server.port}/session`, {
      headers: { host: "user.elanous.app" },
    });
    const bareResponse = await answerSessionCookie(bareResponsePromise);
    expect(bareResponse.status).toBe(200); // 출처: #38994
    expect(bareResponse.headers.get("set-cookie")).toBe(
      "member-session=stub-member-session-1; Path=/; HttpOnly; SameSite=Lax",
    ); // 실측(JUD FU 3): Domain=elanous.app 확장이 제거됐다 — 세션 쿠키는 bare 호스트에만 결속
    const appResponsePromise = fetch(`http://127.0.0.1:${server.port}/session`, {
      headers: { host: "webchat--user.elanous.app" },
    });
    const appResponse = await answerSessionCookie(appResponsePromise);
    expect(appResponse.status).toBe(200); // 출처: #38994
    expect(appResponse.headers.get("set-cookie")).toBe(
      "member-session=stub-member-session-1; Path=/; HttpOnly; SameSite=Lax",
    ); // 실측(JUD FU 3): app 호스트에서도 같은 쿠키는 그 호스트에만 결속 — bare 와 공유되지 않는다
  });

  test("bare member host forwards to the member Nexus default route with the path intact", async () => {
    const { server, daemonKeys, hostSocket } = await bareHostFixture("user");
    const responsePromise = fetch(
      `http://127.0.0.1:${server.port}/app/chat/?room=1`,
      { headers: { host: "user.elanous.app" } },
    );
    const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
    const clientId = new DataView(
      taggedPhoneKey.buffer,
      taggedPhoneKey.byteOffset,
      4,
    ).getUint32(0, false);
    const channel = await acceptDaemonChannel(
      daemonKeys,
      taggedPhoneKey.subarray(4),
    );
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = (await next(hostSocket)) as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== "open")
      throw new Error("expected public HTTP open frame");
    // HANDLE-BARE-HOST-WEBCCHAT-PROXY: the bare handle host forwards under the
    // member's own public host (the member Nexus default route), never a
    // synthesized <app>.app.localhost origin the member Nexus would 404.
    expect(openFrame.value.headers.host).toBe("user.elanous.app");
    expect(openFrame.value.headers.host).not.toMatch(/\.app\.localhost$/);
    expect(openFrame.value.path).toBe("/app/chat/?room=1");
    const requestEnd = await next(hostSocket);
    if (!(requestEnd instanceof Uint8Array))
      throw new Error("expected encrypted request end frame");
    const ended = channel.value.open(requestEnd.subarray(4));
    if (!ended.ok || !decoder.decode(ended.value).ok)
      throw new Error("expected request end frame");

    const envelope = new TextEncoder().encode(
      JSON.stringify({
        status: 200, // 출처: #39003
        headers: {
          "content-type": "text/plain",
          location: "http://user.elanous.app/next",
        },
        body: Buffer.from("bare host ok").toString("base64"),
      }),
    );
    const responseData = encoder.encode({
      streamId: 1, // 출처: #39003
      kind: "data",
      data: envelope,
    });
    if (!responseData.ok) throw new Error(responseData.reason);
    const encryptedData = channel.value.seal(responseData.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    hostSocket.send(toIdBytes(clientId, encryptedData.value));
    const responseClose = encoder.encode({
      streamId: 1, // 출처: #39003
      kind: "close",
      reason: "",
    });
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const encryptedClose = channel.value.seal(responseClose.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    hostSocket.send(toIdBytes(clientId, encryptedClose.value));

    const response = await responsePromise;
    expect(response.status).toBe(200); // 출처: #39003
    // The daemon's same-origin redirect surfaces as the public https bare origin.
    expect(response.headers.get("location")).toBe(
      "https://user.elanous.app/next",
    );
    expect(await response.text()).toBe("bare host ok");
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });
  });

  test("a bare webchat entry with zero public apps still flows to the member Nexus", async () => {
    // 출처: #39024 — 공개 앱 0개 게이트 리터럴: bare `/` 는 publicReadableApps
    // "정확히 1개" 선택보다 앞에서 회원 Nexus 로 흘러, 회원 측 303 `/app/chat/`
    // 리디렉션이 공개 응답에 그대로 드러난다.
    const { server, daemonKeys, hostSocket } = await bareHostFixture(
      "user",
      () => ({ publicReadableApps: new Set<string>() }),
    );
    const responsePromise = fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { host: "user.elanous.app" },
      redirect: "manual",
    });
    const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
    const clientId = new DataView(
      taggedPhoneKey.buffer,
      taggedPhoneKey.byteOffset,
      4,
    ).getUint32(0, false);
    const channel = await acceptDaemonChannel(
      daemonKeys,
      taggedPhoneKey.subarray(4),
    );
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = (await next(hostSocket)) as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== "open")
      throw new Error("expected public HTTP open frame");
    // 출처: #39024 — 공개 앱 0개여도 bare 진입 경로는 회원 Nexus 오리진으로.
    expect(openFrame.value.headers.host).toBe("user.elanous.app");
    expect(openFrame.value.path).toBe("/");
    const requestEnd = await next(hostSocket);
    if (!(requestEnd instanceof Uint8Array))
      throw new Error("expected encrypted request end frame");
    const ended = channel.value.open(requestEnd.subarray(4));
    if (!ended.ok || !decoder.decode(ended.value).ok)
      throw new Error("expected request end frame");
    const envelope = new TextEncoder().encode(
      JSON.stringify({
        status: 303, // 출처: #39024 — 회원 Nexus 진입 리디렉션
        headers: {
          "content-type": "text/plain",
          location: "http://user.elanous.app/app/chat/",
        },
        body: Buffer.from("").toString("base64"),
      }),
    );
    const responseData = encoder.encode({
      kind: "data",
      streamId: openFrame.value.streamId,
      data: envelope,
    });
    if (!responseData.ok) throw new Error(responseData.reason);
    const encryptedData = channel.value.seal(responseData.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    hostSocket.send(toIdBytes(clientId, encryptedData.value));
    const responseClose = encoder.encode({
      kind: "close",
      streamId: openFrame.value.streamId,
      reason: "",
    });
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const encryptedClose = channel.value.seal(responseClose.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    hostSocket.send(toIdBytes(clientId, encryptedClose.value));
    const response = await responsePromise;
    await response.text();
    expect(response.status).toBe(303); // 출처: #39024
    expect(response.headers.get("location")).toBe(
      "https://user.elanous.app/app/chat/",
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });
  });

  test("bare member chat API POST keeps the consumed authorization forwarded", async () => {
    // 출처: #39024 — 허용된 회원 채팅 API 2경로의 POST 는 회원 게이트가 소비한
    // Authorization 을 지우지 않고 회원 Nexus 로 그대로 전달된다.
    const { server, daemonKeys, hostSocket } = await bareHostFixture(
      "user",
      (serverId) => ({
        memberRequired: true,
        validateMemberToken: async () => ({ memberId: "member-1" }),
        hostOwnerMemberIds: new Map([[serverId, "member-1"]]),
      }),
      // 출처: #39024 — memberRequired host WS 게이트 통과용 회원 자격증명.
      ["emt_ws_member_1"],
    );
    const responsePromise = fetch(
      `http://127.0.0.1:${server.port}/v1/prompt/stream`,
      {
        method: "POST",
        headers: {
          host: "user.elanous.app",
          authorization: "Bearer emt_member_bare_chat",
        },
      },
    );
    const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
    const clientId = new DataView(
      taggedPhoneKey.buffer,
      taggedPhoneKey.byteOffset,
      4,
    ).getUint32(0, false);
    const channel = await acceptDaemonChannel(
      daemonKeys,
      taggedPhoneKey.subarray(4),
    );
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = (await next(hostSocket)) as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== "open")
      throw new Error("expected public HTTP open frame");
    // 출처: #39024 — 채팅 API 도 bare 오리진 회원 Nexus 로 흐른다.
    expect(openFrame.value.headers.host).toBe("user.elanous.app");
    expect(openFrame.value.headers.authorization).toBe(
      "Bearer emt_member_bare_chat",
    );
    const requestEnd = await next(hostSocket);
    if (!(requestEnd instanceof Uint8Array))
      throw new Error("expected encrypted request end frame");
    const ended = channel.value.open(requestEnd.subarray(4));
    if (!ended.ok || !decoder.decode(ended.value).ok)
      throw new Error("expected request end frame");
    const envelope = new TextEncoder().encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: Buffer.from("chat api ok").toString("base64"),
      }),
    );
    const responseData = encoder.encode({
      kind: "data",
      streamId: openFrame.value.streamId,
      data: envelope,
    });
    if (!responseData.ok) throw new Error(responseData.reason);
    const encryptedData = channel.value.seal(responseData.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    hostSocket.send(toIdBytes(clientId, encryptedData.value));
    const responseClose = encoder.encode({
      kind: "close",
      streamId: openFrame.value.streamId,
      reason: "",
    });
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const encryptedClose = channel.value.seal(responseClose.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    hostSocket.send(toIdBytes(clientId, encryptedClose.value));
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });
  });

  test("bare member non-chat paths still drop the consumed authorization", async () => {
    // 출처: #39024 — 허용 채팅 API 2경로 밖의 경로는 회원 게이트가 소비한
    // Authorization 을 이전과 같이 지운다(앱 백엔드로의 bearer 재생 방지).
    const { server, daemonKeys, hostSocket } = await bareHostFixture(
      "user",
      (serverId) => ({
        memberRequired: true,
        validateMemberToken: async () => ({ memberId: "member-1" }),
        hostOwnerMemberIds: new Map([[serverId, "member-1"]]),
      }),
      // 출처: #39024 — memberRequired host WS 게이트 통과용 회원 자격증명.
      ["emt_ws_member_1"],
    );
    const responsePromise = fetch(`http://127.0.0.1:${server.port}/notes`, {
      headers: {
        host: "user.elanous.app",
        authorization: "Bearer emt_member_bare_chat",
      },
    });
    const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
    const clientId = new DataView(
      taggedPhoneKey.buffer,
      taggedPhoneKey.byteOffset,
      4,
    ).getUint32(0, false);
    const channel = await acceptDaemonChannel(
      daemonKeys,
      taggedPhoneKey.subarray(4),
    );
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = (await next(hostSocket)) as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== "open")
      throw new Error("expected public HTTP open frame");
    // 출처: #39024 — 채팅 API 밖 경로는 앱 오리진으로, bearer 는 지워진다.
    expect(openFrame.value.headers.host).toBe("chat.app.localhost");
    expect(openFrame.value.headers.authorization).toBeUndefined();
    const requestEnd = await next(hostSocket);
    if (!(requestEnd instanceof Uint8Array))
      throw new Error("expected encrypted request end frame");
    const ended = channel.value.open(requestEnd.subarray(4));
    if (!ended.ok || !decoder.decode(ended.value).ok)
      throw new Error("expected request end frame");
    const envelope = new TextEncoder().encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("dropped ok").toString("base64"),
      }),
    );
    const responseData = encoder.encode({
      kind: "data",
      streamId: openFrame.value.streamId,
      data: envelope,
    });
    if (!responseData.ok) throw new Error(responseData.reason);
    const encryptedData = channel.value.seal(responseData.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    hostSocket.send(toIdBytes(clientId, encryptedData.value));
    const responseClose = encoder.encode({
      kind: "close",
      streamId: openFrame.value.streamId,
      reason: "",
    });
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const encryptedClose = channel.value.seal(responseClose.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    hostSocket.send(toIdBytes(clientId, encryptedClose.value));
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });
  });

  test("bare host reserved labels never proxy to the pinned host", async () => {
    const { server, serverId } = await bareHostFixture("user");
    const www = await fetch(`http://127.0.0.1:${server.port}/app/chat/`, {
      headers: { host: "www.elanous.app" },
    });
    expect(www.status).toBe(404); // 출처: #39003
    expect(server.stats(serverId).publicRequests).toBe(0); // 출처: #39003
  });

  test("an unpinned bare handle never reaches a connected host", async () => {
    const { server, serverId } = await bareHostFixture("user");
    const leaked = await fetch(`http://127.0.0.1:${server.port}/app/chat/`, {
      headers: { host: "eve.elanous.app" },
    });
    expect(leaked.status).toBe(404); // 출처: #39003
    expect(server.stats(serverId).publicRequests).toBe(0); // 출처: #39003
  });

  test("an anonymous write to a bare member host is rejected before proxying", async () => {
    const key = signing();
    const server = startRelayServer({
      trustedHostKeys: new Map([[key.id, key.publicKey]]),
      publicDomain: "elanous.app",
      publicServerId: key.id,
      publicUserId: "user",
      publicReadableApps: new Set(["user/chat"]),
      memberRequired: true,
      validateMemberToken: async () => null,
      hostOwnerMemberIds: new Map([[key.id, "member-1"]]),
    });
    servers.push(server);
    const write = await fetch(
      `http://127.0.0.1:${server.port}/app/chat/api/messages`,
      {
        method: "POST",
        headers: { host: "user.elanous.app" },
        body: "hello",
      },
    );
    expect(write.status).toBe(401); // 출처: #39003
    expect(server.stats(key.id).publicRequests).toBe(0); // 출처: #39003
  });

  test("custom relay hosts require verified ownership, pinned user, and a ready certificate", () => {
    const key = signing();
    expect(() =>
      startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
        publicServerId: key.id,
        publicUserId: "alice",
        customDomainRoutes: new Map([
          [
            "notes.example.test",
            {
              app: "notes",
              user: "alice",
              ownershipVerified: false,
              certificateReady: true,
            },
          ],
        ]),
      }),
    ).toThrow("invalid or unverified custom domain route");
    expect(() =>
      startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
        publicServerId: key.id,
        publicUserId: "alice",
        customDomainRoutes: new Map([
          [
            "notes.example.test",
            {
              app: "notes",
              user: "bob",
              ownershipVerified: true,
              certificateReady: true,
            },
          ],
        ]),
      }),
    ).toThrow("invalid or unverified custom domain route");
    expect(() =>
      startRelayServer({
        trustedHostKeys: new Map([[key.id, key.publicKey]]),
        publicDomain: "elanous.app",
        publicServerId: key.id,
        publicUserId: "alice",
        customDomainRoutes: new Map([
          [
            "notes--alice.elanous.app",
            {
              app: "other",
              user: "alice",
              ownershipVerified: true,
              certificateReady: true,
            },
          ],
        ]),
      }),
    ).toThrow("invalid or unverified custom domain route");
  });

  test("custom domain config loader admits only verified routes from an owner-only file", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-custom-domain-"));
    const file = join(dir, "routes.json");
    try {
      // Source: relay config files follow the owner-only mode contract used by loadRelayPublicListing.
      writeFileSync(
        file,
        JSON.stringify({
          domains: [
            {
              hostname: "notes.example.test",
              app: "notes",
              user: "alice",
              ownershipVerified: true,
              certificateReady: true,
            },
          ],
        }),
        { mode: 0o600 },
      );
      expect(
        loadRelayCustomDomainRoutes(file).get("notes.example.test"),
      ).toEqual({
        app: "notes",
        user: "alice",
        ownershipVerified: true,
        certificateReady: true,
      });
      writeFileSync(
        file,
        JSON.stringify({
          domains: [
            {
              hostname: "notes.example.test",
              app: "notes",
              user: "alice",
              ownershipVerified: false,
              certificateReady: true,
            },
          ],
        }),
        { mode: 0o600 },
      );
      expect(() => loadRelayCustomDomainRoutes(file)).toThrow(
        "custom domain route is not verified",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("routes a verified custom host to its pinned app host and fails closed on other hostnames", async () => {
    const signingKey = generateKeyPairSync("ed25519");
    const signingPublicKey = signingKey.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    // Source: deterministic test-only X25519 seed already used by public relay forwarding coverage.
    const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(21));
    const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
    const server = startRelayServer({
      trustedHostKeys: new Map([[serverId, signingPublicKey]]),
      publicDomain: "elanous.app",
      publicServerId: serverId,
      publicUserId: "alice",
      customDomainRoutes: new Map([
        [
          "notes.example.test",
          {
            app: "notes",
            user: "alice",
            ownershipVerified: true,
            certificateReady: true,
          },
        ],
      ]),
    });
    servers.push(server);
    // Source: RFC 9110 §15.5.5; custom host absent from the verified route projection is not found.
    const unknown = await fetch(`http://127.0.0.1:${server.port}/hello`, {
      headers: { host: "unknown.example.test" },
    });
    expect(unknown.status).toBe(CUSTOM_HOST_NOT_FOUND_STATUS);
    const hostSocket = await connected(
      `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`,
    );
    const challenge = JSON.parse((await next(hostSocket)) as string) as {
      nonce: string;
    };
    hostSocket.send(
      JSON.stringify({
        type: "auth",
        publicKey: signingPublicKey,
        signature: sign(
          null,
          challengeMessage(serverId, challenge.nonce),
          signingKey.privateKey,
        ).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "authenticated",
      capabilities: ["public-http-v1"],
    });
    hostSocket.send(
      JSON.stringify({
        type: "host-public-key",
        publicKey: Buffer.from(daemonKeys.publicKey).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "host-public-key-accepted",
    });

    const responsePromise = fetch(`http://127.0.0.1:${server.port}/hello`, {
      headers: {
        host: "notes.example.test",
        origin: "https://notes.example.test",
      },
    });
    const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
    const clientId = new DataView(
      taggedPhoneKey.buffer,
      taggedPhoneKey.byteOffset,
      4,
    ).getUint32(0, false);
    const channel = await acceptDaemonChannel(
      daemonKeys,
      taggedPhoneKey.subarray(4),
    );
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = (await next(hostSocket)) as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== "open")
      throw new Error("expected public HTTP open frame");
    expect(openFrame.value.headers.host).toBe("notes.app.localhost");
    expect(openFrame.value.headers["x-forwarded-host"]).toBeUndefined();
    expect(openFrame.value.headers.origin).toBe("http://notes.app.localhost");
    const requestEnd = await next(hostSocket);
    if (!(requestEnd instanceof Uint8Array))
      throw new Error("expected encrypted request end frame");
    const ended = channel.value.open(requestEnd.subarray(4));
    if (!ended.ok) throw new Error(ended.reason);
    expect(decoder.decode(ended.value)).toEqual({
      ok: true,
      value: { streamId: CUSTOM_HOST_FIRST_STREAM_ID, kind: "end" },
    });

    const envelope = new TextEncoder().encode(
      JSON.stringify({
        status: CUSTOM_HOST_OK_STATUS,
        headers: {
          "x-nexus-app-origin": "http://notes.app.localhost",
          "x-nexus-app-host": "notes.app.localhost",
          "access-control-allow-origin": "http://notes.app.localhost",
          location: "http://notes.app.localhost/result",
        },
        body: Buffer.from("custom host ok").toString("base64"),
      }),
    );
    const responseData = encoder.encode({
      streamId: CUSTOM_HOST_FIRST_STREAM_ID,
      kind: "data",
      data: envelope,
    });
    if (!responseData.ok) throw new Error(responseData.reason);
    const encryptedData = channel.value.seal(responseData.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    hostSocket.send(toIdBytes(clientId, encryptedData.value));
    const responseClose = encoder.encode({
      streamId: CUSTOM_HOST_FIRST_STREAM_ID,
      kind: "close",
      reason: "",
    });
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const encryptedClose = channel.value.seal(responseClose.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    hostSocket.send(toIdBytes(clientId, encryptedClose.value));
    const response = await responsePromise;
    expect(response.status).toBe(CUSTOM_HOST_OK_STATUS);
    expect(response.headers.get("x-nexus-app-origin")).toBe(
      "https://notes.example.test",
    );
    expect(response.headers.get("x-nexus-app-host")).toBe("notes.example.test");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://notes.example.test",
    );
    expect(response.headers.get("location")).toBe(
      "https://notes.example.test/result",
    );
    expect(await response.text()).toBe("custom host ok");
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });
  });

  test("public mode forwards a valid invited-app host request through the authenticated host channel", async () => {
    const signingKey = generateKeyPairSync("ed25519");
    const signingPublicKey = signingKey.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(21));
    const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
    const server = startRelayServer({
      trustedHostKeys: new Map([[serverId, signingPublicKey]]),
      publicDomain: "elanous.app",
      publicServerId: serverId,
      publicUserId: "alice",
      appKillSwitch: {
        isDown: (userId, appId) => userId === "alice" && appId === "blocked",
        applyIncident: () => {
          throw new Error("unexpected report");
        },
      },
    });
    servers.push(server);
    const hostSocket = await connected(
      `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`,
    );
    const challenge = JSON.parse((await next(hostSocket)) as string) as {
      nonce: string;
    };
    hostSocket.send(
      JSON.stringify({
        type: "auth",
        publicKey: signingPublicKey,
        signature: sign(
          null,
          challengeMessage(serverId, challenge.nonce),
          signingKey.privateKey,
        ).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "authenticated",
      capabilities: ["public-http-v1"],
    });
    hostSocket.send(
      JSON.stringify({
        type: "host-public-key",
        publicKey: Buffer.from(daemonKeys.publicKey).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "host-public-key-accepted",
    });
    const blocked = await fetch(`http://127.0.0.1:${server.port}/hello`, {
      headers: { host: "blocked--alice.elanous.app" },
    });
    expect(blocked.status).toBe(403);
    expect(server.stats(serverId).publicRequests).toBe(0);
    const responsePromise = fetch(`http://127.0.0.1:${server.port}/hello`, {
      headers: {
        host: "notes--alice.elanous.app",
        origin: "https://notes--alice.elanous.app:444",
        connection: "x-private-hop, keep-alive",
        "x-private-hop": "must-not-forward",
        authorization: "Bearer emt_test",
      },
    });
    const taggedPhoneKey = (await next(hostSocket)) as Uint8Array;
    const clientId = new DataView(
      taggedPhoneKey.buffer,
      taggedPhoneKey.byteOffset,
      4,
    ).getUint32(0, false);
    const channel = await acceptDaemonChannel(
      daemonKeys,
      taggedPhoneKey.subarray(4),
    );
    if (!channel.ok) throw new Error(channel.reason);
    const streams = new MuxStreamState();
    const decoder = new MuxDecoder(streams);
    const encoder = new MuxEncoder(streams);
    const requestOpen = (await next(hostSocket)) as Uint8Array;
    const opened = channel.value.open(requestOpen.subarray(4));
    if (!opened.ok) throw new Error(opened.reason);
    const openFrame = decoder.decode(opened.value);
    if (!openFrame.ok || openFrame.value.kind !== "open")
      throw new Error("expected public HTTP open frame");
    expect(openFrame.value.path).toBe("/hello");
    expect(openFrame.value.headers.host).toBe("notes.app.localhost");
    expect(openFrame.value.headers.origin).toBe(
      "https://notes--alice.elanous.app:444",
    );
    expect(openFrame.value.headers.connection).toBeUndefined();
    expect(openFrame.value.headers["x-private-hop"]).toBeUndefined();
    expect(openFrame.value.headers.authorization).toBe("Bearer emt_test");
    const requestEnd = await next(hostSocket);
    if (!(requestEnd instanceof Uint8Array))
      throw new Error(
        `expected encrypted request end frame, received control: ${requestEnd}`,
      );
    const ended = channel.value.open(requestEnd.subarray(4));
    if (!ended.ok) throw new Error(ended.reason);
    expect(decoder.decode(ended.value)).toEqual({
      ok: true,
      value: { streamId: 1, kind: "end" },
    });

    const envelope = new TextEncoder().encode(
      JSON.stringify({
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-nexus-app-origin": "http://notes.app.localhost",
          "x-nexus-app-host": "notes.app.localhost",
          "access-control-allow-origin": "http://notes.app.localhost",
          location: "http://notes.app.localhost/next?from=relay",
          "content-location":
            " //notes.app.localhost/assets/app.json?version=1",
          connection: "x-private-response",
          "x-private-response": "must-not-return",
        },
        body: Buffer.from("public host ok").toString("base64"),
      }),
    );
    const responseData = encoder.encode({
      streamId: 1,
      kind: "data",
      data: envelope,
    });
    if (!responseData.ok) throw new Error(responseData.reason);
    const encryptedData = channel.value.seal(responseData.value);
    if (!encryptedData.ok) throw new Error(encryptedData.reason);
    hostSocket.send(toIdBytes(clientId, encryptedData.value));
    const responseClose = encoder.encode({
      streamId: 1,
      kind: "close",
      reason: "",
    });
    if (!responseClose.ok) throw new Error(responseClose.reason);
    const encryptedClose = channel.value.seal(responseClose.value);
    if (!encryptedClose.ok) throw new Error(encryptedClose.reason);
    hostSocket.send(toIdBytes(clientId, encryptedClose.value));

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-nexus-app-origin")).toBe(
      "https://notes--alice.elanous.app",
    );
    expect(response.headers.get("x-nexus-app-host")).toBe(
      "notes--alice.elanous.app",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://notes--alice.elanous.app",
    );
    expect(response.headers.get("location")).toBe(
      "https://notes--alice.elanous.app/next?from=relay",
    );
    expect(response.headers.get("content-location")).toBe(
      "https://notes--alice.elanous.app/assets/app.json?version=1",
    );
    expect(response.headers.get("x-private-response")).toBeNull();
    expect(await response.text()).toBe("public host ok");
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });

    const abortController = new AbortController();
    const cancelled = fetch(`http://127.0.0.1:${server.port}/cancel`, {
      headers: { host: "notes--alice.elanous.app" },
      signal: abortController.signal,
    }).then(
      () => "resolved",
      (error) => error,
    );
    const abortTaggedKey = (await next(hostSocket)) as Uint8Array;
    const abortClientId = new DataView(
      abortTaggedKey.buffer,
      abortTaggedKey.byteOffset,
      4,
    ).getUint32(0, false);
    expect(await next(hostSocket)).toBeInstanceOf(Uint8Array);
    expect(await next(hostSocket)).toBeInstanceOf(Uint8Array);
    abortController.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId: abortClientId,
    });
  });

  test("cancelled public request resolves its response and clears its slot and timeout", async () => {
    const signingKey = generateKeyPairSync("ed25519");
    const signingPublicKey = signingKey.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(22));
    const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
    const server = startRelayServer({
      trustedHostKeys: new Map([[serverId, signingPublicKey]]),
      publicDomain: "elanous.app",
      publicServerId: serverId,
      publicUserId: "alice",
      publicRequestTimeoutMsForTesting: 2_000,
    });
    servers.push(server);
    const hostSocket = await connected(
      `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`,
    );
    const challenge = JSON.parse((await next(hostSocket)) as string) as {
      nonce: string;
    };
    hostSocket.send(
      JSON.stringify({
        type: "auth",
        publicKey: signingPublicKey,
        signature: sign(
          null,
          challengeMessage(serverId, challenge.nonce),
          signingKey.privateKey,
        ).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "authenticated",
      capabilities: ["public-http-v1"],
    });
    hostSocket.send(
      JSON.stringify({
        type: "host-public-key",
        publicKey: Buffer.from(daemonKeys.publicKey).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(hostSocket)) as string)).toEqual({
      type: "host-public-key-accepted",
    });

    const abort = new AbortController();
    const cancelledFetch = server.server.fetch(
      new Request(`http://127.0.0.1:${server.port}/cancel`, {
        headers: { host: "notes--alice.elanous.app" },
        signal: abort.signal,
      }),
    );
    const taggedPhoneKey = await next(hostSocket);
    expect(taggedPhoneKey).toBeInstanceOf(Uint8Array);
    const clientId = new DataView(
      (taggedPhoneKey as Uint8Array).buffer,
      (taggedPhoneKey as Uint8Array).byteOffset,
      4,
    ).getUint32(0, false);
    expect(await next(hostSocket)).toBeInstanceOf(Uint8Array);
    expect(await next(hostSocket)).toBeInstanceOf(Uint8Array);
    expect(server.stats(serverId)).toMatchObject({
      publicRequests: 1,
      publicSlots: 1,
    });

    abort.abort();
    expect((await cancelledFetch).status).toBe(499);
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId,
    });
    expect(server.stats(serverId)).toMatchObject({
      publicRequests: 0,
      publicSlots: 0,
    });

    await Bun.sleep(2_100);
    const nextAbort = new AbortController();
    const nextFetch = server.server.fetch(
      new Request(`http://127.0.0.1:${server.port}/after-cancel`, {
        headers: { host: "notes--alice.elanous.app" },
        signal: nextAbort.signal,
      }),
    );
    const nextTaggedPhoneKey = await next(hostSocket);
    expect(nextTaggedPhoneKey).toBeInstanceOf(Uint8Array);
    const nextClientId = new DataView(
      (nextTaggedPhoneKey as Uint8Array).buffer,
      (nextTaggedPhoneKey as Uint8Array).byteOffset,
      4,
    ).getUint32(0, false);
    expect(nextClientId).not.toBe(clientId);
    expect(await next(hostSocket)).toBeInstanceOf(Uint8Array);
    expect(await next(hostSocket)).toBeInstanceOf(Uint8Array);
    nextAbort.abort();
    expect((await nextFetch).status).toBe(499);
    expect(JSON.parse((await next(hostSocket)) as string)).toMatchObject({
      type: "client-disconnected",
      clientId: nextClientId,
    });
    expect(server.stats(serverId)).toMatchObject({
      publicRequests: 0,
      publicSlots: 0,
    });
  });
  test("relay serve starts from CLI with operator-pinned keys and rejects unregistered IDs", async () => {
    const key = signing();
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-"));
    const file = join(dir, "trusted.json");
    writeFileSync(file, JSON.stringify({ [key.id]: key.publicKey }));
    const child = spawn(
      process.execPath,
      [
        resolve(import.meta.dir, "../../bin/elanous.mjs"),
        "--test",
        "relay",
        "serve",
        "--port",
        "0",
        "--trusted-host-keys",
        file,
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          NODE_ENV: "test",
          ELANOUS_CONFIG_DIR: dir,
          ELANOUS_STATE_DIR: dir,
          ELANOUS_PUBLIC_APP_USER_ID: "kaist-demo",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const address = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(
          () => reject(new Error("relay CLI startup timeout")),
          8000,
        );
        child.stdout!.on("data", (chunk: Buffer) => {
          const match = chunk
            .toString()
            .match(/relay listening on 127\.0\.0\.1:(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolvePort(Number(match[1]));
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`relay CLI exited ${code}`));
        });
      });
      expect(
        (
          await fetch(
            `http://127.0.0.1:${address}/host?serverId=${signing().id}`,
          )
        ).status,
      ).toBe(403);
      const daemon = await connected(
        `ws://127.0.0.1:${address}/host?serverId=${key.id}`,
      );
      const challenge = JSON.parse((await next(daemon)) as string) as {
        nonce: string;
      };
      daemon.send(
        JSON.stringify({
          type: "auth",
          publicKey: key.publicKey,
          signature: sign(
            null,
            challengeMessage(key.id, challenge.nonce),
            key.pair.privateKey,
          ).toString("base64url"),
        }),
      );
      expect(JSON.parse((await next(daemon)) as string)).toEqual({
        type: "authenticated",
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) resolveExit();
        else child.once("exit", () => resolveExit());
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires a fresh correctly signed challenge bound to serverId and rejects unauthenticated traffic", async () => {
    const key = signing();
    const server = relay(key);
    const impostor = signing();
    const url = `ws://127.0.0.1:${server.port}/host?serverId=${key.id}`;
    const attacker = await connected(url);
    const first = JSON.parse((await next(attacker)) as string) as {
      nonce: string;
    };
    const invalid = closed(attacker);
    attacker.send(
      JSON.stringify({
        type: "auth",
        publicKey: key.publicKey,
        signature: sign(
          null,
          challengeMessage(key.id, first.nonce),
          impostor.pair.privateKey,
        ).toString("base64url"),
      }),
    );
    expect((await invalid).code).toBe(1008);
    const replay = await connected(url);
    const second = JSON.parse((await next(replay)) as string) as {
      nonce: string;
    };
    expect(second.nonce).not.toBe(first.nonce);
    const rejected = closed(replay);
    replay.send(
      JSON.stringify({
        type: "auth",
        publicKey: key.publicKey,
        signature: sign(
          null,
          challengeMessage(key.id, first.nonce),
          key.pair.privateKey,
        ).toString("base64url"),
      }),
    );
    expect((await rejected).code).toBe(1008);
    const unauthenticated = await connected(url);
    await next(unauthenticated);
    const dataRejected = closed(unauthenticated);
    unauthenticated.send(new Uint8Array([1]));
    expect((await dataRejected).code).toBe(1008);
    expect((await host(server, key)).ws.readyState).toBe(WebSocket.OPEN);
  });

  test("pins a separate signing key to an X25519-derived serverId", async () => {
    const key = signing();
    const other = signing();
    const serverId = key.id;
    const dir = mkdtempSync(join(tmpdir(), "relay-keys-"));
    const file = join(dir, "trusted.json");
    writeFileSync(file, JSON.stringify({ [serverId]: key.publicKey }));
    const server = startRelayServer({
      trustedHostKeys: loadTrustedHostKeys(file),
    });
    rmSync(dir, { recursive: true });
    servers.push(server);
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/host?serverId=${other.id}`))
        .status,
    ).toBe(403);
    expect(() => startRelayServer()).toThrow();
    const url = `ws://127.0.0.1:${server.port}/host?serverId=${serverId}`;
    const attacker = await connected(url);
    const challenge = JSON.parse((await next(attacker)) as string) as {
      nonce: string;
    };
    const rejected = closed(attacker);
    attacker.send(
      JSON.stringify({
        type: "auth",
        publicKey: other.publicKey,
        signature: sign(
          null,
          challengeMessage(serverId, challenge.nonce),
          other.pair.privateKey,
        ).toString("base64url"),
      }),
    );
    expect((await rejected).code).toBe(1008);
    const daemon = await connected(url);
    const fresh = JSON.parse((await next(daemon)) as string) as {
      nonce: string;
    };
    daemon.send(
      JSON.stringify({
        type: "auth",
        publicKey: key.publicKey,
        signature: sign(
          null,
          challengeMessage(serverId, fresh.nonce),
          key.pair.privateKey,
        ).toString("base64url"),
      }),
    );
    expect(JSON.parse((await next(daemon)) as string)).toEqual({
      type: "authenticated",
    });
  });

  test("routes opaque ciphertext between one authenticated host and multiple clients, then cleans up", async () => {
    const key = signing();
    const server = relay(key);
    const { ws: daemon } = await host(server, key);
    const duplicate = await connected(
      `ws://127.0.0.1:${server.port}/host?serverId=${key.id}`,
    );
    expect((await closed(duplicate)).code).toBe(1008);
    const client1 = await connected(
      `ws://127.0.0.1:${server.port}/client?serverId=${key.id}`,
    );
    const c1 = JSON.parse((await next(client1)) as string) as {
      clientId: number;
    };
    expect(JSON.parse((await next(daemon)) as string)).toEqual({
      type: "client-connected",
      clientId: c1.clientId,
    });
    const client2 = await connected(
      `ws://127.0.0.1:${server.port}/client?serverId=${key.id}`,
    );
    const c2 = JSON.parse((await next(client2)) as string) as {
      clientId: number;
    };
    expect(JSON.parse((await next(daemon)) as string)).toEqual({
      type: "client-connected",
      clientId: c2.clientId,
    });
    expect(c1.clientId).not.toBe(c2.clientId);
    const bytes = new Uint8Array([0, 255, 39, 72, 41]);
    const toDaemon = next(daemon);
    client2.send(bytes);
    const tagged = toIdBytes(c2.clientId, bytes);
    expect(await toDaemon).toEqual(tagged);
    const toClient = next(client1);
    daemon.send(toIdBytes(c1.clientId, bytes));
    expect(await toClient).toEqual(bytes);
    expect(server.stats(key.id)).toMatchObject({
      host: true,
      clients: 2,
      bytes: bytes.length * 2,
    });
    const hostClosed = closed(client1);
    daemon.close();
    expect((await hostClosed).code).toBe(1012);
    expect((await closed(client2)).code).toBe(1012);
    const replacement = await host(server, key);
    expect(server.stats(key.id).clients).toBe(0);
    const client3 = await connected(
      `ws://127.0.0.1:${server.port}/client?serverId=${key.id}`,
    );
    const c3 = JSON.parse((await next(client3)) as string) as {
      clientId: number;
    };
    expect(JSON.parse((await next(replacement.ws)) as string)).toEqual({
      type: "client-connected",
      clientId: c3.clientId,
    });
    expect(server.stats(key.id).clients).toBe(1);
    const toReplacement = next(replacement.ws);
    client3.send(bytes);
    expect(await toReplacement).toEqual(toIdBytes(c3.clientId, bytes));
  });

  test("rejects oversized client frames, plaintext, offline clients and enforces client capacity", async () => {
    const key = signing();
    const server = relay(key);
    const offline = await connected(
      `ws://127.0.0.1:${server.port}/client?serverId=${key.id}`,
    );
    expect((await closed(offline)).code).toBe(1008);
    const { ws: daemon } = await host(server, key);
    const clients: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const ws = await connected(
        `ws://127.0.0.1:${server.port}/client?serverId=${key.id}`,
      );
      await next(ws);
      await next(daemon);
      clients.push(ws);
    }
    const full = await connected(
      `ws://127.0.0.1:${server.port}/client?serverId=${key.id}`,
    );
    expect((await closed(full)).code).toBe(1008);
    const plaintextClose = closed(clients[0]!);
    clients[0]!.send("Bearer must never be relayed");
    expect((await plaintextClose).code).toBe(1003);
    const oversize = closed(clients[1]!);
    clients[1]!.send(new Uint8Array(MAX_FRAME_BYTES + 1));
    expect((await oversize).code).toBe(1009);
    expect(server.stats(key.id).failures["plaintext-data"]).toBe(1);
  });
});

function toIdBytes(id: number, payload: Uint8Array) {
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(payload, 4);
  return frame;
}
