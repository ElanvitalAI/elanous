// 출처: OP #107132(승인 설계) · HANDLE-BARE-HOST-WEBCCHAT-PROXY — 웹채팅 넘김
// HMAC-SHA256 서명 토큰의 시험 원장. 발급(GCP · app 원점)과 교환(minim5 ·
// bare 핸들 원점)이 같은 비밀(env)로 서명·검증하는 «appHost 2개» 모형.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createWebChatHandoffLedger,
  routeBareWebChatHostRequest,
} from "./http-server.js";

// 출처: OP #107132 — 토큰 TTL 60초(60_000ms).
const HANDOFF_TTL_MS = 60_000;
// 출처: OP #107132 — 주입 시계 기준점(임의 값, 제품 상한 아님).
const HANDOFF_CLOCK_BASE_MS = 2_500_000_000_000;
// 출처: OP #107132 — 서명 비밀 최소 길이 32바이트(fail-closed 경계).
const HMAC_KEY_MIN_BYTES = 32;
const DUMMY_KEY = "k".repeat(HMAC_KEY_MIN_BYTES);
const MEMBER_ID = "member-user";
const HANDLE = "bare";

function makeLedger(clock: () => number) {
  // appHost 2개 모형: 발급 원점(app)과 교환 원점(bare)이 서로 다른
  // appHost 로 원장을 만들어도 같은 비밀이면 서명이 통과한다.
  return createWebChatHandoffLedger({ host: "app.elanous.test" }, clock);
}

function handoffRequest(token: string): Request {
  return new Request(
    `https://${HANDLE}.elanous.app/app/chat/handoff?handoff-token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
}

function routeOpts(ledger: ReturnType<typeof makeLedger>) {
  return {
    pinnedHandles: new Set([HANDLE]),
    pinOwners: new Map([[HANDLE, MEMBER_ID]]),
    webChatHandoff: ledger,
  };
}

describe("WEBCHAT-SESSION-HANDOFF HMAC 서명 토큰 (OP #107132)", () => {
  test("ⓐ 위조 서명 → 401 invalid-signature (서명 검증 실패는 401 로 닫는다)", () => {
    let clockMs = HANDOFF_CLOCK_BASE_MS;
    const ledger = makeLedger(() => clockMs);
    const token = ledger.issue(MEMBER_ID, HANDLE);
    expect(typeof token).toBe("string");
    const parts = (token as string).split("."); // wch_<payload>.<sig> — 출처: OP #107132 토큰 포맷
    expect(parts.length).toBe(2);
    // 서명 세그먼트를 조작 → 위조.
    const forged = `${parts[0]}.${parts[1]}A`; // 서명 끝에 1바이트 추가 → 위조
    const consumed = ledger.consume(forged, HANDLE, MEMBER_ID);
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.reason).toBe("webchat-handoff-invalid-signature");
    // 교환 라우트도 같은 사유로 401.
    const res = routeBareWebChatHostRequest(
      handoffRequest(forged),
      routeOpts(ledger),
    ) as Response;
    expect(res.status).toBe(401);
  });

  test("ⓑ 만료 토큰 → 401 expired (주입 clock 사용, sleep 금지)", () => {
    let clockMs = HANDOFF_CLOCK_BASE_MS;
    const ledger = makeLedger(() => clockMs);
    const token = ledger.issue(MEMBER_ID, HANDLE) as string;
    // 경계 +1ms — 60s TTL, 출처: OP #107132.
    clockMs = HANDOFF_CLOCK_BASE_MS + HANDOFF_TTL_MS + 1;
    const consumed = ledger.consume(token, HANDLE, MEMBER_ID);
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.reason).toBe("webchat-handoff-expired");
    const res = routeBareWebChatHostRequest(
      handoffRequest(token),
      routeOpts(ledger),
    ) as Response;
    expect(res.status).toBe(401);
  });

  test("ⓒ 남의 handle → 401 handle-mismatch (토큰은 발급된 핸들에만 유효)", () => {
    const ledger = makeLedger(() => HANDOFF_CLOCK_BASE_MS);
    const token = ledger.issue(MEMBER_ID, "other-handle") as string;
    const consumed = ledger.consume(token, HANDLE, MEMBER_ID);
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.reason).toBe("webchat-handoff-handle-mismatch");
  });

  test("ⓓ nonce 재사용 → 401 (일회용 토큰, 두 번째 교환은 실패)", () => {
    const ledger = makeLedger(() => HANDOFF_CLOCK_BASE_MS);
    const token = ledger.issue(MEMBER_ID, HANDLE) as string;
    const first = ledger.consume(token, HANDLE, MEMBER_ID);
    expect(first.ok).toBe(true);
    const second = ledger.consume(token, HANDLE, MEMBER_ID);
    expect(second.ok).toBe(false);
  });

  describe("ⓔ 비밀 미설정 → 발급 undefined → 503 fail-closed", () => {
    const KEY_ENV = "ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY";
    const KEY_FILE_ENV = "ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY_FILE";
    let savedKey: string | undefined;
    let savedKeyFile: string | undefined;
    beforeEach(() => {
      savedKey = process.env[KEY_ENV];
      savedKeyFile = process.env[KEY_FILE_ENV];
      delete process.env[KEY_ENV];
      delete process.env[KEY_FILE_ENV];
    });
    afterEach(() => {
      if (savedKey === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = savedKey;
      if (savedKeyFile === undefined) delete process.env[KEY_FILE_ENV];
      else process.env[KEY_FILE_ENV] = savedKeyFile;
    });
    test("issue()는 undefined — 발급 라우트(진입)는 이를 503 로 닫는다", () => {
      const ledger = makeLedger(() => HANDOFF_CLOCK_BASE_MS);
      expect(ledger.issue(MEMBER_ID, HANDLE)).toBeUndefined();
      // 짧은 비밀(<32바이트)도 없는 값 취급 — 출처: OP #107132(제안 #107122).
      process.env[KEY_ENV] = "short"; // 5바이트 < 32바이트 — 출처: OP #107132
      expect(ledger.issue(MEMBER_ID, HANDLE)).toBeUndefined();
    });
  });

  test("ⓕ 핀 불일치 → 401 pin-mismatch (⑦ 이전분 — 핀 소유 대조는 교환 쪽에서만)", () => {
    const ledger = makeLedger(() => HANDOFF_CLOCK_BASE_MS);
    const token = ledger.issue(MEMBER_ID, HANDLE) as string;
    // 활성 핀이 다른 회원을 가리키면 교환 실패.
    const consumed = ledger.consume(token, HANDLE, "member-other");
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.reason).toBe("webchat-handoff-pin-mismatch");
  });

  test("ⓖ 정상 교환 → 303 + wcs_ 파생 쿠키 (GCP 발급 · minim5 교환 모형)", () => {
    // GCP(app 원점)에서 발급.
    let clockMs = HANDOFF_CLOCK_BASE_MS;
    const ledgerGcp = makeLedger(() => clockMs);
    const token = ledgerGcp.issue(MEMBER_ID, HANDLE) as string;
    expect(token.startsWith("wch_")).toBe(true); // 출처: OP #107132 토큰 포맷
    // minim5(bare 핸들 원점)에서 교환 — 같은 비밀이면 다른 appHost 로도 검증 통과.
    // (교환 원장 인스턴스는 라우트가 소비하므로, 사전 대조는 «다른 인스턴스»로.)
    const ledgerMinim5 = makeLedger(() => clockMs);
    const consumed = ledgerGcp.consume(token, HANDLE, MEMBER_ID);
    expect(consumed.ok).toBe(true);
    const res = routeBareWebChatHostRequest(
      handoffRequest(token),
      routeOpts(ledgerMinim5),
    ) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/app/chat/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.join("\n")).toContain("wcs_");
  });
});

// 더미 키 보증 — 출처: OP #107132(≥32바이트). 실 env 오염 없이 원장만 쓴다.
process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY ??= DUMMY_KEY;
