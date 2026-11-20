import { afterAll, afterEach, describe, expect, test } from "bun:test";
// (출처: #39104) ⓑ1 리터럴 — 실경로 relay/커넥터 직접 구동
import {
  generateKeyPairSync,
  randomUUID,
  sign as ed25519Sign,
} from "node:crypto"; // (출처: #39104) ⓑ1 리터럴 — 실경로 host WS 챌린지 서명
import { generateDaemonKeyPair, serverIdFromPublicKey } from "../../relay/channel.js";
import { connectRelayHost } from "../../relay/host-connector.js"; // (출처: #39104) JUD must ⓑ — 실경로 커넥터(시험 ④)
import {
  challengeMessage,
  startRelayServer,
} from "../../relay/relay-server.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRelayWebChatLedger,
  membersApiWebChatServingGate,
  restoreWebChatHandlePins, // 출처: OP #104299/#104391 — 재연결 재핀 심
  routeBareWebChatHostRequest,
  createWebChatHandoffLedger, // 출처: #39056 — ⓒ1 원장(파생 세션)
} from "./http-server.js";
import { createMemberStore } from "../members/member-store.js"; // 출처: #39056 — 파생 토큰 member-store 수준 검증

// 출처: OP #107132 — 넘김 토큰은 HMAC-SHA256 서명으로 발급된다. 시험용 더미 키(≥32바이트 — 출처: OP #107132).
process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY ??= "x".repeat(32);

/*
 * 출처: #39003 — JUD must ⓐ/ⓑ 실경로 시험.
 * ⓐ: 핀된 bare `<handle>.elanous.app` 원점이 실제 http-server 라우팅 분기와
 *     실제 static-app 핸들러를 지난다 (가짜 host 소켓 아님 — JUD 지적).
 * ⓑ: webChatServing 핀 레저는 pin 성공 뒤에만 기록 · 실패 시 제거 · 끊김 시 clear.
 */

const BARE_ORIGIN_HOST = "user.elanous.app"; // 출처: #39003 — 핀된 회원 bare 원점
const APP_ORIGIN_HOST = "myapp--user.elanous.app"; // 출처: #39003 — app 공개 호스트(회귀용)
const STATIC_DIR = mkdtempSync(join(tmpdir(), "bare-webchat-pwa-")); // 출처: #39003
const PINNED_HANDLES = new Set<string>(["user", "muse"]); // 출처: #39003 — 성공 핀 레저

mkdirSync(join(STATIC_DIR, "chat", "assets"), { recursive: true });
writeFileSync(
  join(STATIC_DIR, "chat", "index.html"),
  "<!doctype html><title>webchat</title>bare-webchat-entry", // 출처: #39003
  "utf8",
);
writeFileSync(
  join(STATIC_DIR, "chat", "assets", "app.js"),
  "console.log('bare-webchat-app')", // 출처: #39003
  "utf8",
);
afterAll(() => {
  rmSync(STATIC_DIR, { recursive: true, force: true });
});

function originRequest(path: string, hostname: string): Request {
  return new Request(`https://${hostname}${path}`);
}

function bareOrigin(path: string): Request {
  return originRequest(path, BARE_ORIGIN_HOST);
}

describe("HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓐ bare origin routing (출처: #39003)", () => {
  test("① pinned bare origin GET /app/chat/ serves the real static-app PWA entry", async () => {
    const response = await routeBareWebChatHostRequest(
      bareOrigin("/app/chat/"),
      { pinnedHandles: PINNED_HANDLES, staticDir: STATIC_DIR },
    );
    expect(response?.status).toBe(200); // 출처: #39003
    expect(await response?.text()).toContain("bare-webchat-entry"); // 출처: #39003
  });

  test("② bare origin `/` and `/app/chat` redirect 303 to the chat entry", async () => {
    for (const path of ["/", "/app/chat"]) { // 출처: #39003
      const response = await routeBareWebChatHostRequest(bareOrigin(path), {
        pinnedHandles: PINNED_HANDLES,
        staticDir: STATIC_DIR,
      });
      expect([path, response?.status]).toEqual([path, 303]); // 출처: #39003
      expect([path, response?.headers.get("location")]).toEqual([ // 출처: #39003
        path,
        "/app/chat/",
      ]);
    }
  });

  test("③ a different (unpinned) bare handle stays 404 — no un-pinned origin is exposed", async () => {
    const response = await routeBareWebChatHostRequest(
      originRequest("/app/chat/", "othermember.elanous.app"), // 출처: #39003
      { pinnedHandles: PINNED_HANDLES, staticDir: STATIC_DIR },
    );
    expect(response?.status).toBe(404); // 출처: #39003
    expect(await response?.text()).toContain("handle-not-pinned"); // 출처: #39003
  });

  test("④+⑤ anonymous GET table on the pinned bare origin — PWA static only, /v1 all 404", async () => {
    const anonymousGetTable: ReadonlyArray<readonly [string, number]> = [
      ["/", 303], // 출처: #39003
      ["/app/chat", 303], // 출처: #39003
      ["/app/chat/", 200], // 출처: #39003
      ["/app/chat/assets/app.js", 200], // 출처: #39003
      ["/v1/health", 404], // 출처: #39003 — JUD must ⓒ: bare 원점에 /v1 노출 0
      ["/v1/nexus", 404], // 출처: #39003
      ["/v1/me", 404], // 출처: #39003
      ["/v1/sessions/active", 404], // 출처: #39003
      ["/v1/members/home", 404], // 출처: #39003
      ["/v1/apps/chat", 404], // 출처: #39003 — appRoutes 경로도 bare 원점에선 404
      ["/_app-storage/upload", 404], // 출처: #39003
      ["/app", 404], // 출처: #39003
      ["/app/other/", 404], // 출처: #39003
      ["/app/chatx", 404], // 출처: #39003
    ];
    for (const [path, expectedStatus] of anonymousGetTable) {
      const response = await routeBareWebChatHostRequest(bareOrigin(path), {
        pinnedHandles: PINNED_HANDLES,
        staticDir: STATIC_DIR,
      });
      expect([path, response?.status]).toEqual([path, expectedStatus]); // 출처: #39003
    }
  });

  test("④ POST to /v1 on the bare origin is 404 too (no method bypass)", async () => {
    const response = await routeBareWebChatHostRequest(
      new Request(`https://${BARE_ORIGIN_HOST}/v1/nexus/admin/mcp-reload`, {
        method: "POST",
      }), // 출처: #39003
      { pinnedHandles: PINNED_HANDLES, staticDir: STATIC_DIR },
    );
    expect(response?.status).toBe(404); // 출처: #39003
  });

  test("bare origin without a PWA build fails closed (static-not-wired)", async () => {
    const response = await routeBareWebChatHostRequest(
      bareOrigin("/app/chat/"),
      { pinnedHandles: PINNED_HANDLES },
    );
    expect(response?.status).toBe(404); // 출처: #39003
    expect(await response?.text()).toContain("static-not-wired"); // 출처: #39003
  });

  test("⑥ app `--` public hosts and non-app hostnames defer to appHost.handle (undefined)", () => {
    expect(
      routeBareWebChatHostRequest(originRequest("/app/chat/", APP_ORIGIN_HOST), {
        pinnedHandles: PINNED_HANDLES,
        staticDir: STATIC_DIR,
      }),
    ).toBeUndefined(); // 출처: #39003
    expect(
      routeBareWebChatHostRequest(originRequest("/v1/health", "127.0.0.1"), {
        pinnedHandles: PINNED_HANDLES,
        staticDir: STATIC_DIR,
      }),
    ).toBeUndefined(); // 출처: #39003
  });
});

describe("HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓑ pin ledger (출처: #39003)", () => {
  test("① pin success records the handle — webChatServing true direction", async () => {
    const ledger = createRelayWebChatLedger({});
    ledger.recordPin("user", "member-owner", Promise.resolve()); // 출처: #39003 · #39024 — recordPin(handle, memberId, pin)
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39003
    expect(ledger.handles.has("user")).toBe(true); // 출처: #39003
  });

  test("② pin failure records nothing — the serving link never appears", async () => {
    const ledger = createRelayWebChatLedger({});
    ledger.recordPin(
      "user",
      "member-owner", // 출처: #39024 — recordPin(handle, memberId, pin)
      Promise.reject(new Error("relay refused the pin")), // 출처: #39003
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39003
    expect(ledger.handles.has("user")).toBe(false); // 출처: #39003
  });

  test("②b a failed re-pin removes the stale record (dead origin must not stay linked)", async () => {
    const ledger = createRelayWebChatLedger({});
    ledger.recordPin("user", "member-owner", Promise.resolve()); // 출처: #39003 · #39024 — recordPin(handle, memberId, pin)
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39003
    ledger.recordPin(
      "user",
      "member-owner", // 출처: #39024 — recordPin(handle, memberId, pin)
      Promise.reject(new Error("relay refused the re-pin")), // 출처: #39003
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39003
    expect(ledger.handles.has("user")).toBe(false); // 출처: #39003
  });

  test("③ relay connection close clears every recorded handle", async () => {
    const ledger = createRelayWebChatLedger({});
    ledger.recordPin("user", "member-owner", Promise.resolve()); // 출처: #39003 · #39024 — recordPin(handle, memberId, pin)
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39003
    ledger.onConnectionClosed();
    expect(ledger.handles.size).toBe(0); // 출처: #39003
  });

  test("reconnect get-or-creates the same ledger set for the host", () => {
    const appHostKey = {}; // 출처: #39003 — appHost WeakMap 키
    const first = createRelayWebChatLedger(appHostKey);
    const second = createRelayWebChatLedger(appHostKey);
    expect(second.handles).toBe(first.handles); // 출처: #39003
  });

  test("ⓑ×ⓐ interlock: ledger-pinned handle routes 200, failed pin routes 404", async () => {
    const ledger = createRelayWebChatLedger({});
    ledger.recordPin("user", "member-owner", Promise.resolve()); // 출처: #39003 · #39024 — recordPin(handle, memberId, pin)
    ledger.recordPin(
      "failedpin",
      "member-owner", // 출처: #39024 — recordPin(handle, memberId, pin)
      Promise.reject(new Error("relay refused the pin")), // 출처: #39003
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39003
    const okResponse = await routeBareWebChatHostRequest(
      bareOrigin("/app/chat/"),
      { pinnedHandles: ledger.handles, staticDir: STATIC_DIR },
    );
    expect(okResponse?.status).toBe(200); // 출처: #39003
    const failedResponse = await routeBareWebChatHostRequest(
      originRequest("/app/chat/", "failedpin.elanous.app"), // 출처: #39003
      { pinnedHandles: ledger.handles, staticDir: STATIC_DIR },
    );
    expect(failedResponse?.status).toBe(404); // 출처: #39003
  });
});

describe("HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓒ serving gate — appHost 없는 해상 (OP #103381)", () => {
  test("① candidate 없는 해상도 핀 성공 핸들이면 true — 홈 webChatUrl 링크 노출", async () => {
    const appHostKey = {}; // OP #103381 — 릴레이 배선이 채우는 appHost 원장 키
    const ledger = createRelayWebChatLedger(appHostKey);
    ledger.recordPin("user", "member-owner", Promise.resolve()); // OP #103381
    ledger.setPinQueryChannel(async () => true); // OP #105017 ⓐ① — 질의 채널 배선(없으면 fail-closed false)
    await new Promise((resolve) => setTimeout(resolve, 0));
    const gate = membersApiWebChatServingGate(undefined, appHostKey); // OP #103381 — candidate 없는 해상
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(true); // OP #103381 — recordPin 이 캐시를 예열
    expect(gate({ appSlug: "myapp", handle: "unpinned", memberId: "member-owner" })).toBe(false); // OP #103381 — 첫 질의는 fail-closed, 다음 틱에 true 캐시
  });

  test("② 핀 실패 핸들은 원장에 남지 않는다 — false, 홈 링크 숨김", async () => {
    const appHostKey = {}; // OP #103381
    const ledger = createRelayWebChatLedger(appHostKey);
    ledger.recordPin(
      "failedpin",
      "member-owner",
      Promise.reject(new Error("relay refused the pin")), // OP #103381
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const gate = membersApiWebChatServingGate(undefined, appHostKey); // OP #103381
    expect(gate({ appSlug: "myapp", handle: "failedpin", memberId: "member-owner" })).toBe(false); // OP #103381 — 실패 핸들은 회답 전이라도 false
  });

  test("③ candidate 있는 해상은 candidate 원장을 우선 읽는다 — 기존 동작 회귀", async () => {
    const candidateHost = {}; // OP #103381
    const fallbackHost = {}; // OP #103381
    const candidateLedger = createRelayWebChatLedger(candidateHost);
    candidateLedger.setPinQueryChannel(async () => true); // OP #105017 ⓐ① — candidate 질의 채널 배선
    createRelayWebChatLedger(fallbackHost).recordPin(
      "user",
      "member-owner",
      Promise.resolve(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const gate = membersApiWebChatServingGate(candidateHost, fallbackHost); // OP #103381
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(false); // OP #103381 — candidate 캐시엔 없다
    candidateLedger.recordPin(
      "user",
      "member-owner",
      Promise.resolve(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(true); // OP #103381 — recordPin 이 candidate 캐시를 예열
  });

  test("④ 원장 키가 아예 없으면 false — 기본은 숨김", () => {
    const gate = membersApiWebChatServingGate(undefined, undefined); // OP #103381
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(false); // OP #103381
  });
});

/*
 * 출처: OP #105017 ⓐ — 회원 서버→relay «핀 질의» 게이트 리터럴 시험.
 * (1) 살아 있음→링크 보임 (2) 끊김→숨김 (3) 위조 질의→false —
 * 회답은 불리언만, 첫 회답 전·미배선·끊김은 false(fail-closed), 캐시 ≤30s.
 */
describe("HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓐ relay «핀 질의» 게이트 리터럴 (OP #105017)", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0)); // OP #105017 — 채널 회답 캐시 반영 대기

  test("(1) 살아 있음→링크 보임 — 첫 회답 전 false(fail-closed), tick 후 true", async () => {
    const appHostKey = {}; // OP #103381 — 릴레이 배선이 채우는 appHost 원장 키
    const ledger = createRelayWebChatLedger(appHostKey);
    ledger.setPinQueryChannel(async () => true); // OP #105017 ⓐ① — relay 회답은 불리언 true
    const gate = membersApiWebChatServingGate(undefined, appHostKey); // OP #103381 — candidate 없는 해상
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(false); // 첫 회답 전 — fail-closed
    await settle();
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(true); // tick 후 캐시 회답 — 링크 보임
  });

  test("(2) 끊김→숨김 — onConnectionClosed() 가 채널·캐시를 지우면 즉시 false", async () => {
    const appHostKey = {}; // OP #105017
    const ledger = createRelayWebChatLedger(appHostKey);
    ledger.setPinQueryChannel(async () => true); // OP #105017 ⓐ①
    ledger.recordPin("user", "member-owner", Promise.resolve()); // OP #105017 — 소유자 true 캐시 예열
    await settle();
    const gate = membersApiWebChatServingGate(undefined, appHostKey); // OP #103381
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(true); // 살아 있음 — 링크 보임
    ledger.onConnectionClosed(); // OP #105017 ⓐ② — 채널·캐시 삭제
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(false); // 즉시 false — fail-closed
    await settle();
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(false); // 채널이 지워져 회답은 오지 않는다
  });

  test("(3) 위조 질의→false — 회답 반영 후에도 false, 소유자 엔트리·원장 무오염", async () => {
    const appHostKey = {}; // OP #105017
    const ledger = createRelayWebChatLedger(appHostKey);
    ledger.setPinQueryChannel(async (_handle, memberId) => memberId === "member-owner"); // OP #105017 ⓐ③ — relay 소유 대조 이중 흉내(남의 memberId → false)
    ledger.recordPin("user", "member-owner", Promise.resolve()); // OP #105017 — 소유자 true 유지(캐시 예열)
    await settle();
    const gate = membersApiWebChatServingGate(undefined, appHostKey); // OP #103381
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(true); // 소유자 — true 유지
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-forger" })).toBe(false); // 위조 질의 — 첫 회답 전 fail-closed
    await settle(); // 위조 회답 캐시 반영 대기
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-forger" })).toBe(false); // 회답 반영 후에도 false — 소유 대조 이중
    expect(gate({ appSlug: "myapp", handle: "user", memberId: "member-owner" })).toBe(true); // 소유자 엔트리 무오염
    expect(ledger.pinOwners.get("user")).toBe("member-owner"); // 원장도 무오염
  });
});

/*
 * (출처: #39104) JUD must ⓑ1 수리 — 중앙 회원 서버(연결 소유자 1명)가 타 회원
 * 홈을 내줄 때 relay «핀 질의»가 그 회원 전부 rejected 되던 결함. 회원 서버는
 * «회원 서버 역할» 서비스 토큰(ems_, env 또는 0600 파일 회전)으로 연결하고
 * «아무 회원의 핸들 핀 여부 불리언 읽기»만 허용된다 — 쓰기는 0.
 * 실경로: 실제 startRelayServer + 실제 host WS 챌린지 서명(#39024 ⓑ2 흐름),
 * 가짜 host 소켓 아님(JUD #39003 지적 준수).
 */
describe("HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓑ1 서비스 토큰 «핀 질의» 리터럴 (#39104)", () => {
  const RELAY_MEMBER_SERVICE_TOKEN = "ems_pool4_member_service_token_39104"; // (출처: #39104)
  const relayServers: Array<ReturnType<typeof startRelayServer>> = []; // (출처: #39104)
  // (출처: #39104) JUD must ⓑ(#105847) — 시험 ④ 가 env 를 delete 하기 «전» 앞값을
  // 여기 저장하고 afterEach 에서 원상 복원한다(interference-ratchet: 복원 없는 delete 금지).
  let savedMemberServiceEnv: Array<[string, string | undefined]> | null = null;
  afterEach(() => {
    for (const server of relayServers.splice(0)) server.stop(); // (출처: #39104)
    if (savedMemberServiceEnv) {
      // (출처: #39104) #105847 — env 원상 복원(undefined 였으면 delete, 값이면 재설정).
      for (const [envKey, envValue] of savedMemberServiceEnv) {
        if (envValue === undefined) delete process.env[envKey];
        else process.env[envKey] = envValue;
      }
      savedMemberServiceEnv = null;
    }
  });

  // (출처: #39104) 실경로 fixture — 시험 회원 2명(MK·elanoustest) 호스트 + 서비스 연결.
  async function pinQueryRelayFixture(hangMemberQueries = false) {
    const signingKeys = [0, 1, 2].map(() => generateKeyPairSync("ed25519"));
    const hostSigningPublicKeys = signingKeys.map(
      (pair) =>
        pair.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64url"),
    );
    const daemonSeeds = [41, 42, 43];
    // (출처: #39104) JUD must ⓑ — 시험 ④ connectRelayHost 실경로 신원용 보존.
    const daemonKeyPairs = await Promise.all(
      daemonSeeds.map((seed) =>
        generateDaemonKeyPair(new Uint8Array(32).fill(seed)),
      ),
    );
    const serverIds = await Promise.all(
      daemonKeyPairs.map((pair) => serverIdFromPublicKey(pair.publicKey)),
    );
    const pinRows: Array<{ user: string; serverId: string; ownerId: string }> =
      []; // (출처: #39104) relay가 위임받은 서버 소유 원장
    const serviceQueries: Array<{ user: string; memberId: string }> =
      []; // (출처: #39104) JUD must ⓑ — queryHandlePinByMember 발화 기록(시험 ④)
    const relayServer = startRelayServer({
      trustedHostKeys: new Map(
        serverIds.map((serverId, index) => [
          serverId,
          hostSigningPublicKeys[index],
        ]),
      ),
      memberRequired: true,
      validateMemberToken: async (token) =>
        token === "emt_mk_39104"
          ? { memberId: "MK" } // (출처: #39104) 시험 회원 2명 리터럴
          : { memberId: "elanoustest" },
      hostOwnerMemberIds: new Map([
        [serverIds[0], "MK"],
        [serverIds[1], "elanoustest"],
        [serverIds[2], "member-server"],
      ]),
      memberServiceToken: RELAY_MEMBER_SERVICE_TOKEN,
      autoAppRegistration: {
        register: () => undefined,
        unregister: () => undefined,
        pinHandle: (serverId, ownerId, input) => {
          pinRows.push({ user: input.user, serverId, ownerId: input.memberId }); // (출처: #39104)
        },
        queryHandlePin: (serverId, ownerId, input) =>
          ownerId === input.memberId &&
          pinRows.some(
            (row) =>
              row.user === input.user &&
              row.serverId === serverId &&
              row.ownerId === ownerId,
          ),
        queryHandlePinByMember: (input) => {
          serviceQueries.push({
            user: input.user,
            memberId: input.memberId,
          }); // (출처: #39104) JUD must ⓑ — 발화 기록(시험 ④)
          if (hangMemberQueries) {
            // (출처: #39104 FU #105876) 회답 없는 relay — 프레임은 도착, 회답은 영원히 없음
            return new Promise<boolean>(() => {});
          }
          return pinRows.some(
            (row) => row.user === input.user && row.ownerId === input.memberId,
          );
        }, // (출처: #39104) 회원별 원장 읽기
      },
    });
    relayServers.push(relayServer);
    const nextMessage = async (socket: WebSocket) => {
      const event = await new Promise<MessageEvent>((resolve) => {
        socket.addEventListener("message", resolve, { once: true }); // (출처: #39104)
      });
      return JSON.parse(String(event.data)) as {
        type?: string;
        nonce?: string;
        requestId?: string;
        result?: unknown;
      };
    };
    // (출처: #39104) 실경로 host WS — 챌린지 → 서명 → auth → authenticated.
    const openHostSocket = async (index: number, memberTokens: string[]) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${relayServer.port}/host?serverId=${serverIds[index]}`,
        memberTokens.length ? memberTokens : undefined,
      );
      const challenge = await nextMessage(socket);
      expect(challenge.type).toBe("challenge");
      const signature = ed25519Sign(
        null,
        challengeMessage(serverIds[index], challenge.nonce!),
        signingKeys[index].privateKey,
      );
      socket.send(
        JSON.stringify({
          type: "auth",
          publicKey: hostSigningPublicKeys[index],
          signature: Buffer.from(signature).toString("base64url"),
        }),
      );
      const reply = await nextMessage(socket);
      expect(reply.type).toBe("authenticated");
      return socket;
    };
    // (출처: #39104) app-control 왕복 — 요청·응답은 requestId 로 대응.
    const appControl = async (
      socket: WebSocket,
      type: string,
      registration: { user: string; memberId: string },
    ) => {
      const requestId = randomUUID();
      socket.send(JSON.stringify({ type, requestId, registration }));
      for (;;) {
        const reply = await nextMessage(socket);
        if (reply.requestId === requestId) return reply; // (출처: #39104)
      }
    };
    // (출처: #39104) JUD must ⓑ — 시험 ④ connectRelayHost 실경로 신원·발화 기록.
    const hostIdentity = (index: number) => ({
      daemonKeys: daemonKeyPairs[index],
      hostSigningKey: signingKeys[index].privateKey,
    });
    return {
      relayServer,
      serverIds,
      openHostSocket,
      appControl,
      serviceQueries,
      hostIdentity,
    };
  }

  test("① 회원 서버 서비스 자격(ems_) — MK·elanoustest 질의 모두 정확", async () => {
    const { openHostSocket, appControl } = await pinQueryRelayFixture();
    const mkSocket = await openHostSocket(0, ["emt_mk_39104"]);
    const elanoustestSocket = await openHostSocket(1, ["emt_elanoustest_39104"]);
    const mkPin = await appControl(mkSocket, "public-handle-pin", {
      user: "mk",
      memberId: "MK",
    });
    expect(mkPin.type).toBe("public-app-accepted"); // (출처: #39104) 실제 핀 쓰기
    const elanoustestPin = await appControl(
      elanoustestSocket,
      "public-handle-pin",
      { user: "elanoustest", memberId: "elanoustest" },
    );
    expect(elanoustestPin.type).toBe("public-app-accepted");
    // 회원 서버 — 서비스 토큰(ems_)만으로 연결(호스트 신원은 챌린지 서명).
    const memberServer = await openHostSocket(2, [RELAY_MEMBER_SERVICE_TOKEN]);
    const mkQuery = await appControl(
      memberServer,
      "public-handle-pin-query",
      { user: "mk", memberId: "MK" },
    );
    expect(mkQuery.type).toBe("public-app-accepted");
    expect(mkQuery.result).toBe(true); // (출처: #39104) 연결 소유자 아닌 회원 질의 회답
    const elanoustestQuery = await appControl(
      memberServer,
      "public-handle-pin-query",
      { user: "elanoustest", memberId: "elanoustest" },
    );
    expect(elanoustestQuery.type).toBe("public-app-accepted");
    expect(elanoustestQuery.result).toBe(true);
    const unpinnedQuery = await appControl(
      memberServer,
      "public-handle-pin-query",
      { user: "not-pinned", memberId: "MK" },
    );
    expect(unpinnedQuery.type).toBe("public-app-accepted");
    expect(unpinnedQuery.result).toBe(false); // 없는 핀 → false(정확성)
    // 서비스 자격의 쓰기는 0 — public-handle-pin 거부.
    const serviceWrite = await appControl(memberServer, "public-handle-pin", {
      user: "member-server",
      memberId: "member-server",
    });
    expect(serviceWrite.type).toBe("public-app-rejected"); // (출처: #39104) 쓰기 0
  });

  test("② 일반 호스트(emt_) 자격 — 남의 회원 질의 rejected → false", async () => {
    const { openHostSocket, appControl } = await pinQueryRelayFixture();
    const mkSocket = await openHostSocket(0, ["emt_mk_39104"]);
    const elanoustestSocket = await openHostSocket(1, ["emt_elanoustest_39104"]);
    const elanoustestPin = await appControl(
      elanoustestSocket,
      "public-handle-pin",
      { user: "elanoustest", memberId: "elanoustest" },
    );
    expect(elanoustestPin.type).toBe("public-app-accepted");
    const foreign = await appControl(mkSocket, "public-handle-pin-query", {
      user: "elanoustest",
      memberId: "elanoustest",
    });
    expect(foreign.type).toBe("public-app-rejected"); // (출처: #39104) 남의 회원 질의 rejected
    const mkPin = await appControl(mkSocket, "public-handle-pin", {
      user: "mk",
      memberId: "MK",
    });
    expect(mkPin.type).toBe("public-app-accepted");
    const own = await appControl(mkSocket, "public-handle-pin-query", {
      user: "mk",
      memberId: "MK",
    });
    expect(own.type).toBe("public-app-accepted");
    expect(own.result).toBe(true); // 소유자 질의는 그대로 정확(무변경)
  });

  test("③ 토큰 없음 — 회원 게이트 4401 → 연결 실패(fail-closed)", async () => {
    const { relayServer, serverIds } = await pinQueryRelayFixture();
    const socket = new WebSocket( // (출처: #39104) emt_·ems_ 모두 없음
      `ws://127.0.0.1:${relayServer.port}/host?serverId=${serverIds[0]}`,
    );
    const closeCode = await new Promise((resolve) => {
      socket.addEventListener("close", (event) => {
        resolve((event as CloseEvent).code); // (출처: #39104)
      });
    });
    expect(closeCode).toBe(4401); // (출처: #39104) OP 마지막 1줄 — 401→4401
  });

  // (출처: #39104) JUD must ⓑ(#105797) — 서비스 토큰 env 없이 connectRelayHost:
  // 연결은 성립하고 «핀 질의»만 자격 없음 fail-closed 로 귀결된다.
  test("④ 서비스 토큰 없이 connectRelayHost — 연결 성립 + 서비스 질의 fail-closed", async () => {
    // (출처: #39104) JUD must ⓑ — 회전 경로 env 가 없으면 http-server 는
    // getMemberServiceToken 옵션을 아예 배선하지 않는다(조건부 배선).
    // (출처: #39104) JUD must ⓑ(#105847) — delete «앞값 저장» → afterEach 원상 복원.
    savedMemberServiceEnv = [
      [
        "ELANOUS_RELAY_MEMBER_SERVICE_TOKEN",
        process.env.ELANOUS_RELAY_MEMBER_SERVICE_TOKEN,
      ],
      [
        "ELANOUS_RELAY_MEMBER_SERVICE_TOKEN_FILE",
        process.env.ELANOUS_RELAY_MEMBER_SERVICE_TOKEN_FILE,
      ],
    ];
    delete process.env.ELANOUS_RELAY_MEMBER_SERVICE_TOKEN;
    delete process.env.ELANOUS_RELAY_MEMBER_SERVICE_TOKEN_FILE;
    const {
      relayServer,
      hostIdentity,
      openHostSocket,
      appControl,
      serviceQueries,
    } = await pinQueryRelayFixture();
    // 질의 대상: elanoustest 핀을 먼저 찍는다 — 살아 있는 핀이어도 자격 없으면 false.
    const elanoustestSocket = await openHostSocket(1, ["emt_elanoustest_39104"]);
    const elanoustestPin = await appControl(
      elanoustestSocket,
      "public-handle-pin",
      { user: "elanoustest", memberId: "elanoustest" },
    );
    expect(elanoustestPin.type).toBe("public-app-accepted");
    // MK 회원 기기 — emt_ 만 제시(ems_ 없음). 이전 throw 는 여기서 연결을 죽였다.
    const identity = hostIdentity(0);
    const connection = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relayServer.port}`,
      daemonKeys: identity.daemonKeys,
      hostSigningKey: identity.hostSigningKey,
      handleRequest: () => undefined, // (출처: #39104) 이 시험은 호스트 API 요청을 다루지 않는다
      getMemberToken: () => "emt_mk_39104",
      // (출처: #39104) JUD must ⓑ — getMemberServiceToken 없음 = 조건부 배선 상태
    });
    expect(connection.readyState).toBe(WebSocket.OPEN); // ① 연결 성립 신호(호스트 established)
    // ② «핀 질의» — 서비스 자격이 배선되지 않으면 질의 프레임 자체가 나가지 않아
    // 회답은 영원히 오지 않는다(#105847 JUD 초과 원인). 5초 원정 왕복을 기다리지
    // 않고: 미발화 확인 창(250ms) 뒤 «즉시 false» 로 귀결 단언한다. 시간 상한(5s) 은
    // 늘리지 않는다.
    const foreignPin = await Promise.race([
      connection.publicHandlePinQuery("elanoustest", "elanoustest"),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 250); // (출처: #39104) 즉시 false 회답 창
      }),
    ]);
    expect(foreignPin).toBe(false); // (출처: #39104) fail-closed — 타 회원 핀 질의 false
    expect(serviceQueries.length).toBe(0); // ③ 서비스 질의 미발화(queryHandlePinByMember)
    connection.close();
  });

  // (출처: #39104 FU #105876) — 회답 없는 relay: 질의 프레임은 도착하지만 원장이 영원히 회답하지 않는다 → 2초 상한 false.
  test("⑤ 회답 없는 relay — 핀 질의 2초 상한 false·늦은 회답 무시(누적 0)", async () => {
    const { relayServer, hostIdentity, serviceQueries } =
      await pinQueryRelayFixture(true);
    const connection = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relayServer.port}`,
      daemonKeys: hostIdentity(2).daemonKeys,
      hostSigningKey: hostIdentity(2).hostSigningKey,
      handleRequest: () => undefined,
      getMemberToken: () => "emt_mk_39104",
      getMemberServiceToken: () => RELAY_MEMBER_SERVICE_TOKEN,
    });
    const startedAt = Date.now();
    const pinned = await connection.publicHandlePinQuery("elanoustest", "elanoustest");
    expect(serviceQueries.length).toBe(1); // 질의 프레임은 relay 원장에 도착(회답만 없음)
    expect(pinned).toBe(false); // 타임아웃 뒤 늦은 회답은 no-op 로 무시된다
    expect(Date.now() - startedAt).toBeLessThan(3_000); // 출처: #105876 — 제품 2초 상한(2_000ms) 위 1초 여유
    connection.close();
  });
});

/*
 * (출처: #106092) ⓑ — relay 정책 member-service 결속 리터럴(OP #106092 ·
 * OP #106129 ①). 결속 서비스 키는 owner 없이 기동이 유효하고(회원 서버
 * 역할), ems_ 서비스 연결의 «public-handle-pin-query» 가
 * queryHandlePinByMember 에 도달해야 하며(RED 영수증
 * 39112-32a041add8e-minim5-003302 시험⑤ — 2004ms 조용히 미도달), 같은
 * 키의 일반 호스트 연결(ems_ 없음)은 403/4401 로 fail-closed 이다.
 */
describe("HANDLE-BARE-HOST-WEBCAT-PROXY ⓑ member-service 결속 리터럴 (#106092)", () => {
  const MEMBER_SERVICE_BINDING_TOKEN = "ems_106092_member_service_token"; // (출처: #106092) fixture 상수 문양
  const relayServers: Array<ReturnType<typeof startRelayServer>> = [];
  afterEach(() => {
    for (const server of relayServers.splice(0)) server.stop();
  });

  // (출처: #106092) ⓑ — 결속 서비스 키 1개(owner 없음 — 결속 면제) +
  // 일반 호스트 1개(owner 결속 — 기존 강제 유지).
  async function memberServiceBindingFixture() {
    const signingKeys = [0, 1].map(() => generateKeyPairSync("ed25519"));
    const hostSigningPublicKeys = signingKeys.map(
      (pair) =>
        pair.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64url"),
    );
    const daemonKeyPairs = await Promise.all(
      [21, 22].map((seed) =>
        generateDaemonKeyPair(new Uint8Array(32).fill(seed)),
      ),
    );
    const serverIds = await Promise.all(
      daemonKeyPairs.map((pair) => serverIdFromPublicKey(pair.publicKey)),
    );
    const serviceQueries: Array<{ user: string; memberId: string }> = []; // (출처: #106129) ① 도달 기록
    const relayServer = startRelayServer({
      trustedHostKeys: new Map(
        serverIds.map((serverId, index) => [
          serverId,
          hostSigningPublicKeys[index],
        ]),
      ),
      memberRequired: true,
      validateMemberToken: async () => ({ memberId: "MK" }), // (출처: #106092) emt_ 게이트
      hostOwnerMemberIds: new Map([[serverIds[1], "MK"]]), // 결속 키(0)는 owner 없음
      memberServiceServerIds: new Set([serverIds[0]]), // (출처: #106092) ⓑ 정책 결속
      memberServiceToken: MEMBER_SERVICE_BINDING_TOKEN,
      autoAppRegistration: {
        register: () => undefined,
        unregister: () => undefined,
        pinHandle: () => undefined,
        queryHandlePin: () => false,
        queryHandlePinByMember: (input) => {
          // (출처: #106129) ① queryHandlePinByMember 도달 단얨 지점.
          serviceQueries.push({ user: input.user, memberId: input.memberId });
          return input.user === "elanoustest";
        },
      },
    });
    relayServers.push(relayServer);
    const hostIdentity = (index: number) => ({
      daemonKeys: daemonKeyPairs[index],
      hostSigningKey: signingKeys[index].privateKey,
    });
    return { relayServer, serverIds, serviceQueries, hostIdentity };
  }

  test("① 결속 서비스 키 + connectRelayHost(ems_) — publicHandlePinQuery → queryHandlePinByMember 도달 1", async () => {
    const { relayServer, serviceQueries, hostIdentity } =
      await memberServiceBindingFixture();
    const identity = hostIdentity(0); // 결속 서비스 키(owner 없음)
    const connection = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relayServer.port}`,
      daemonKeys: identity.daemonKeys,
      hostSigningKey: identity.hostSigningKey,
      handleRequest: () => undefined,
      getMemberServiceToken: async () => MEMBER_SERVICE_BINDING_TOKEN, // (출처: #106092) ⓑ 순수 서비스 연결
    });
    const pinned = await connection.publicHandlePinQuery(
      "elanoustest",
      "elanoustest",
    );
    expect(pinned).toBe(true); // (출처: #106129) ① 도달 회답 — RED 2004ms 수리
    expect(serviceQueries.length).toBe(1); // (출처: #106129) ① 도달 1
    expect(serviceQueries[0]).toEqual({
      user: "elanoustest",
      memberId: "elanoustest",
    });
    connection.close();
  });

  test("② 같은 서비스 키 — 일반 호스트 연결(ems_ 없음) 403/4401 fail-closed", async () => {
    const { relayServer, serverIds } = await memberServiceBindingFixture();
    // (출처: #106092) ⓑ — (a) 비-WS: HTTP 403 «member service required».
    const response = await fetch(
      `http://127.0.0.1:${relayServer.port}/host?serverId=${serverIds[0]}`,
    );
    expect(response.status).toBe(403); // 일반 호스트 슬롯 불가
    expect(await response.text()).toBe("member service required");
    // (출처: #106092) ⓑ — (b) WS: 유효한 emt_ 회원 자격이라도 결속 키는
    // 일반 호스트 슬롯으로 쓸 수 없다 → 업그레이드 뒤 4401 «unauthorized».
    const socket = new WebSocket(
      `ws://127.0.0.1:${relayServer.port}/host?serverId=${serverIds[0]}`,
      ["emt_mk_106092"],
    );
    const closeCode = await new Promise((resolve) => {
      socket.addEventListener("close", (event) => {
        resolve((event as CloseEvent).code);
      });
    });
    expect(closeCode).toBe(4401); // 결속 키는 ems_ 서비스 연결로만
  });
});


/*
 * 출처: #39056 — HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓒ1 파생 세션 실경로 시험.
 * 교환 성공 시 원본 세션 토큰은 절대 쿠키로 심히지 않는다: 파생 wcs_ 토큰을
 * __Secure- 3-Path(착지 + 채팅 쌍) 쿠키로 심고, 비-웹채팅 경로 응답은 쿠키를
 * 지운다(백스톱).
 */

// 출처: #39056 — 핀 소유자 memberId · 원본 세션 토큰(쿠키 미포함 단언 대상).
const HANDOFF_MEMBER_ID = "member-owner-1";
const HANDOFF_ORIGINAL_SESSION_TOKEN = "member-session-token-original";
const HANDOFF_CLOCK_BASE_MS = 1_700_000_000_000; // 출처: #39056 — 만료 시험 가속 기준

describe("HANDLE-BARE-HOST-WEBCCHAT-PROXY ⓒ1 derived webchat session (출처: #39056)", () => {
  function handoffLedger(clock: () => number = () => HANDOFF_CLOCK_BASE_MS) {
    return createWebChatHandoffLedger({}, clock); // 출처: #39056 — appHost 키 격리
  }

  function handoffExchangeRequest(
    token: string,
    hostname: string = BARE_ORIGIN_HOST,
  ): Request {
    return originRequest( // 출처: #39056 — 교환 경로 + 일회용 토큰
      `/app/chat/handoff?handoff-token=${encodeURIComponent(token)}`,
      hostname,
    );
  }

  async function exchangeOn(
    ledger: ReturnType<typeof createWebChatHandoffLedger>,
    token: string,
    hostname: string = BARE_ORIGIN_HOST,
  ) {
    return await routeBareWebChatHostRequest(
      handoffExchangeRequest(token, hostname),
      {
        pinnedHandles: PINNED_HANDLES,
        pinOwners: new Map<string, string>([["user", HANDOFF_MEMBER_ID]]), // 출처: #39056 — 핀 소유자 결속
        staticDir: STATIC_DIR,
        webChatHandoff: ledger,
      },
    );
  }

  test("① 같은 토큰 2회 교환 — 두 번째는 401 webchat-handoff-unknown(일회용)", async () => {
    const ledger = handoffLedger();
    const token = ledger.issue(HANDOFF_MEMBER_ID, "user")!; // 출처: #39056 — 발급
    const first = await exchangeOn(ledger, token);
    expect(first?.status).toBe(303); // 출처: #39056 — 첫 교환은 성공
    const second = await exchangeOn(ledger, token);
    expect(second?.status).toBe(401); // 출처: #39056
    expect(await second?.json()).toEqual({ error: "webchat-handoff-unknown" }); // 출처: #39056
  });

  test("② 타 핸들 원점 교환 — 401 webchat-handoff-handle-mismatch", async () => {
    const ledger = handoffLedger();
    const token = ledger.issue(HANDOFF_MEMBER_ID, "user")!; // 출처: #39056 — user 핀에 발급
    const response = await exchangeOn(ledger, token, "muse.elanous.app"); // 출처: #39056 — 타 핸들 원점
    expect(response?.status).toBe(401); // 출처: #39056
    expect(await response?.json()).toEqual({
      error: "webchat-handoff-handle-mismatch",
    }); // 출처: #39056
  });

  test("③ clock +61s 교환 — 401 webchat-handoff-expired(60초 만료)", async () => {
    let clockMs = HANDOFF_CLOCK_BASE_MS; // 출처: #39056
    const ledger = handoffLedger(() => clockMs);
    const token = ledger.issue(HANDOFF_MEMBER_ID, "user")!; // 출처: #39056
    clockMs += 61_000; // 출처: #39056 — 만료 시험 가속(+61초)
    const response = await exchangeOn(ledger, token);
    expect(response?.status).toBe(401); // 출처: #39056
    expect(await response?.json()).toEqual({ error: "webchat-handoff-expired" }); // 출처: #39056
  });

  test("④ 교환 성공 — 303 + __Secure- 3-Path Set-Cookie, 값은 wcs_ 파생 토큰(원본 미포함)", async () => {
    const ledger = handoffLedger();
    const token = ledger.issue(HANDOFF_MEMBER_ID, "user")!; // 출처: #39056
    const response = await exchangeOn(ledger, token);
    expect(response?.status).toBe(303); // 출처: #39056
    expect(response?.headers.get("Location")).toBe("/app/chat/"); // 출처: #39056
    const cookies = response?.headers.getSetCookie() ?? []; // 출처: #39056
    expect(cookies.length).toBe(3); // 출처: #39056 — 착지 + 채팅 쌍 2경로
    expect(
      cookies.map((cookie) => /Path=([^;]+)/.exec(cookie)?.[1]),
    ).toEqual(["/app/chat", "/v1/prompt/stream", "/v1/chat/events"]); // 출처: #39056
    for (const cookie of cookies) {
      expect(cookie.startsWith("__Secure-elanous_webchat_session=wcs_")).toBe(true); // 출처: #39056 — __Host- 아님 + 파생 wcs_ 값
      expect(cookie).toContain("; Secure; HttpOnly; SameSite=Lax"); // 출처: #39056 — Domain 없음(호스트 전용)
      expect(cookie).not.toContain(HANDOFF_ORIGINAL_SESSION_TOKEN); // 출처: #39056 — 원본 세션 토큰 절대 미포함
    }
  });

  test("⑤ 비-웹채팅 경로(/) 응답 — 삭제 Set-Cookie 백스톱(파생 3-Path + 레거시 중화)", async () => {
    const rootResponse = await routeBareWebChatHostRequest(bareOrigin("/"), {
      pinnedHandles: PINNED_HANDLES,
      staticDir: STATIC_DIR,
    }); // 출처: #39056 — 비-웹채팅 경로("/")
    expect(rootResponse?.status).toBe(303); // 출처: #39056 — 착지 리다이렉트 유지
    const rootCookies = rootResponse?.headers.getSetCookie() ?? []; // 출처: #39056
    expect(rootCookies).toContain("__Secure-elanous_webchat_session=; Path=/app/chat; Max-Age=0; Secure"); // 출처: #39056
    expect(rootCookies).toContain("__Secure-elanous_webchat_session=; Path=/v1/prompt/stream; Max-Age=0; Secure"); // 출처: #39056
    expect(rootCookies).toContain("__Secure-elanous_webchat_session=; Path=/v1/chat/events; Max-Age=0; Secure"); // 출처: #39056
    expect(rootCookies).toContain("__Host-elanous_member_session=; Path=/; Max-Age=0; Secure"); // 출처: #39056 — 레거시 원본 쿠키 중화
    const forwardedResponse = await routeBareWebChatHostRequest(bareOrigin("/v1/health"), {
      pinnedHandles: PINNED_HANDLES,
      staticDir: STATIC_DIR,
      forwardApi: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }); // 출처: #39056 — forwardApi 폴스루도 동일(응답 복제)
    expect(forwardedResponse?.status).toBe(200); // 출처: #39056
    expect(forwardedResponse?.headers.getSetCookie()).toContain("__Secure-elanous_webchat_session=; Path=/app/chat; Max-Age=0; Secure"); // 출처: #39056
  });

  test("⑥ 파생 wcs_ 토큰은 member-store 세션이 아니다 — memberForSession = null", async () => {
    const ledger = handoffLedger();
    const token = ledger.issue(HANDOFF_MEMBER_ID, "user")!; // 출처: #39056
    const response = await exchangeOn(ledger, token);
    const cookies = response?.headers.getSetCookie() ?? []; // 출처: #39056
    const derivedToken = /__Secure-elanous_webchat_session=(wcs_[^;]+)/.exec(
      cookies[0] ?? "",
    )?.[1]; // 출처: #39056
    expect(typeof derivedToken).toBe("string"); // 출처: #39056
    const store = createMemberStore(); // 출처: #39056 — 실제 member-store 수준 검증
    const resolved = store.memberForSession(
      derivedToken!,
      new Date().toISOString(),
    ); // 출처: #39056
    expect(resolved === null || resolved === undefined).toBe(true); // 출처: #39056 — 파생 토큰은 member-store 세션이 아니다
  });

  // ⑦ «FU ⓑ 발급 전 활성 핀 확인» 폐지 — 출처: OP #107132. 신 설계는 «핀 소유 대조는 교환 쪽에서만»
  // 이므로 발급 검문이 원장 3인자 시그니처에 의존했다. 커버리지(핀 불일치 → 401 pin-mismatch)는
  // 신규 webchat-handoff-hmac.test.ts ⓕ 로 이전됐다.

  test("⑧ FU 만료 정리·상한 — 발급 시 만료 레코드 소거, 상한 512 치환", () => {
    let clockMs = HANDOFF_CLOCK_BASE_MS; // 출처: #39056
    const ledger = handoffLedger(() => clockMs);
    ledger.issue(HANDOFF_MEMBER_ID, "user"); // 출처: #39056 — 1건 발급
    clockMs += 61_000; // 출처: #39056 — 만료 경과
    ledger.issue(HANDOFF_MEMBER_ID, "user"); // 출처: #39056 — 만료 레코드 정리 후 재발급
    expect(ledger.stats().handoffs).toBe(1); // 출처: #39056 — 만료 레코드 소거
    for (let i = 0; i < 600; i += 1)
      ledger.issue(HANDOFF_MEMBER_ID, "user"); // 출처: #39056 — 상한 초과 발급
    expect(ledger.stats().handoffs).toBeLessThanOrEqual(512); // 출처: #39056 — 상한(오래된 것부터 치환)
    ledger.issueDerivedSession(HANDOFF_MEMBER_ID, "user"); // 출처: #39056 — 파생 1건
    clockMs += 2 * 60 * 60_000 + 1_000; // 출처: JUD #104249 ⓑ — 파생 유휴 창 2시간 + 1초 경과
    ledger.issueDerivedSession(HANDOFF_MEMBER_ID, "user"); // 출처: #39056 — 파생 만료 정리 후 재발급
    expect(ledger.stats().derivedSessions).toBe(1); // 출처: #39056 — 파생 만료 레코드 소거
  });

  test("⑨ FU 원장 메모리 최소화 — 교환 레코드에 원본 세션 토큰 없음", () => {
    const ledger = handoffLedger();
    const token = ledger.issue(HANDOFF_MEMBER_ID, "user")!; // 출처: #39056
    const consumed = ledger.consume(token, "user", HANDOFF_MEMBER_ID); // 출처: #39056 — 성공 교환
    expect(consumed.ok).toBe(true); // 출처: #39056
    if (consumed.ok)
      expect("sessionToken" in consumed.record).toBe(false); // 출처: #39056 — 원본 세션 토큰 미보관
  });
});

describe("WEBCHAT-PIN-LEDGER-RECONNECT — relay 재연결 시 핀 원장 재구성 (OP #104299/#104391)", () => {
  const NOW = Date.parse("2026-11-18T00:00:00.000Z"); // 출처: #39024 — 선례 relay 시험과 같은 고정 시계
  const storeDir = mkdtempSync(join(tmpdir(), "webchat-pin-ledger-reconnect-")); // 내구 스토어 — 재연결마다 새 인스턴스로 같은 파일을 다시 연다
  const storePath = join(storeDir, "members.sqlite");
  afterAll(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  const openStore = () => createMemberStore({ path: storePath, now: () => NOW });

  function seedDurableClaims(handleA: string, handleB: string) {
    const store = openStore();
    const register = (sub: string, handle: string) => {
      const member = store.register(
        { sub, email: `${sub}@example.test`, emailVerified: true, name: sub }, // 출처: #39024 — 선례 relay 시험과 같은 가입 인자
        { consents: { privacy: "v1", terms: "v1" } },
      );
      store.claimHandle(member.id, handle);
      return member.id;
    };
    const memberA = register(`member-of-${handleA}`, handleA);
    const memberB = register(`member-of-${handleB}`, handleB);
    store.close();
    return { memberA, memberB };
  }

  test("(a) onConnectionClosed() 뒤 재연결 재핀 — 원장 복원·게이트 true", async () => {
    const { memberA: alphaMemberId, memberB: betaMemberId } = seedDurableClaims("alpha", "beta");
    const appHost = {}; // 릴레이 배선이 createRelayWebChatLedger(opts.appHost) 로 채우는 원장 키
    const ledger = createRelayWebChatLedger(appHost);
    ledger.setPinQueryChannel(async () => true); // OP #105017 — relay «핀 질의» 채널(재핀 회답)
    const okPin = async () => undefined; // 릴레이 핀 성공

    restoreWebChatHandlePins(ledger, okPin, openStore()); // 1차 연결 — 스토어 내구 claim 전부 핀
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39024 — 핀 프라미스 결과 반영 대기
    const gate = membersApiWebChatServingGate(undefined, appHost); // OP #103381 — candidate 없는 해상(릴레이 배선과 같은 읽기)
    expect(gate({ appSlug: "myapp", handle: "alpha", memberId: alphaMemberId })).toBe(true); // 핀 성공 → 서빙
    expect(gate({ appSlug: "myapp", handle: "beta", memberId: betaMemberId })).toBe(true);
    expect(ledger.pinOwners.get("alpha")).toBe(alphaMemberId); // 소유자 memberId 기록
    expect(ledger.pinOwners.get("beta")).toBe(betaMemberId);

    ledger.onConnectionClosed(); // 릴레이 끊김 — onClose 가 원장을 clear (버그의 전제 상황 재현)
    expect(gate({ appSlug: "myapp", handle: "alpha", memberId: alphaMemberId })).toBe(false); // 끊기면 서빙 아님 — 기존 fail-closed 유지
    expect(gate({ appSlug: "myapp", handle: "beta", memberId: betaMemberId })).toBe(false);

    ledger.setPinQueryChannel(async () => true); // OP #105017 — 재연결 배선이 채널을 다시 묶는다
    restoreWebChatHandlePins(ledger, okPin, openStore()); // 재연결 — 내구 claim 재핀으로 원장 재구성
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39024 — 핀 프라미스 결과 반영 대기
    expect(gate({ appSlug: "myapp", handle: "alpha", memberId: alphaMemberId })).toBe(true); // MEMBER-HOME-WEBCHAT-LINK-WRONG 재발 방지
    expect(gate({ appSlug: "myapp", handle: "beta", memberId: betaMemberId })).toBe(true);
    expect(ledger.pinOwners.get("alpha")).toBe(alphaMemberId); // 소유자도 함께 복원
    expect(ledger.pinOwners.get("beta")).toBe(betaMemberId);
  });

  test("(b) 일부 claim 핀 거부 — 그 핸들만 원장 밖(fail-closed)", async () => {
    const { memberA: gammaMemberId, memberB: deltaMemberId } = seedDurableClaims("gamma", "delta");
    const appHost = {}; // OP #104299/#104391
    const ledger = createRelayWebChatLedger(appHost);
    ledger.setPinQueryChannel(async (handle) => handle !== "gamma"); // OP #105017 — 거부된 gamma 는 살아 있지 않다
    const pin = async (handle: string) => {
      if (handle === "gamma") throw new Error("relay refused the re-pin"); // 릴레이가 gamma 핀만 거부
    };

    restoreWebChatHandlePins(ledger, pin, openStore()); // 재연결 재핀 — 일부 거부 포함
    await new Promise((resolve) => setTimeout(resolve, 0)); // 출처: #39024 — 핀 프라미스 결과 반영 대기
    const gate = membersApiWebChatServingGate(undefined, appHost); // OP #103381 — candidate 없는 해상
    expect(gate({ appSlug: "myapp", handle: "gamma", memberId: gammaMemberId })).toBe(false); // 거부된 재핀 → 원장 밖·링크 숨김(fail-closed)
    expect(ledger.pinOwners.get("gamma")).toBeUndefined(); // 소유자도 기록 안 됨
    expect(gate({ appSlug: "myapp", handle: "delta", memberId: deltaMemberId })).toBe(true); // 성공한 재핀만 서빙
    expect(ledger.pinOwners.get("delta")).toBe(deltaMemberId);
  });

  test("(d) relay 정적 claim 질의 실패 → 재생 원천 없음(fail-closed) · 로컬 claim 은 그대로 재핀", async () => {
    const { memberA } = seedDurableClaims("epsilon", "zeta");
    const appHost = {};
    const ledger = createRelayWebChatLedger(appHost);
    ledger.setPinQueryChannel(async () => true);
    restoreWebChatHandlePins(ledger, async () => undefined, openStore(), async () => {
      throw new Error("relay query failed");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.pinOwners.get("epsilon")).toBe(memberA);
  });
});
