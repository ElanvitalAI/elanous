import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { constantTimeTokenEqual } from "./member-service-token.js"; // (출처: #39104) 상수시간 대조
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import type { ServerWebSocket } from "bun";
import { debug } from "../debug/log.js";
import {
  challengeMessage,
  createPhoneChannel,
  MAX_FRAME_BYTES,
  serverIdFromPublicKey,
} from "./channel.js";
export { challengeMessage } from "./channel.js";
import {
  MAX_MUX_FRAME_BYTES,
  MuxDecoder,
  MuxEncoder,
  MuxStreamState,
} from "./mux.js";
import {
  buildPublicDispatchRoutes,
  type PublicDispatchRoute,
} from "./public-dispatch.js";
import { isAnonymousPublicAppRead } from "./public-app-read.js";
/** WEBCHAT-SESSION-HANDOFF — the member Nexus's derived web-chat session cookie (http-server.ts
 * WEBCHAT_SESSION_COOKIE_NAME · value `wcs_<uuid>`). Shape only; the member Nexus validates it. */
const WEBCHAT_SESSION_COOKIE =
  /(?:^|;\s*)__Secure-elanous_webchat_session=wcs_[0-9a-f-]{36}(?:;|$)/i;
import {
  validatedRelayPublicPolicySnapshot,
  type AutoPublicAppRegistration,
  type RelayPublicPolicySnapshot,
} from "./public-app-auto-registration.js";
import {
  createPublicAppVisitorWriteGate,
  validateVisitorWritePolicy,
  type PublicAppVisitorWritePolicy,
  type VisitorWriteLedger,
} from "./public-app-visitor-write.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_CLIENTS_PER_SERVER = 8;
// Public HTTP requests are short-lived and must admit a 50-person audience burst.
// Keep the independent private WebSocket client limit at eight.
// Source: OP #92435 approves a bounded 64-slot public cap for KAIST-APP-SERVE-LOAD-50.
const MAX_PUBLIC_REQUESTS_PER_SERVER = 64;
// Source: #36294 relay member gate; the cap covers the existing public burst,
// eight private clients and one host without unbounded Nexus introspection.
const MAX_MEMBER_CHECKS =
  MAX_PUBLIC_REQUESTS_PER_SERVER + MAX_CLIENTS_PER_SERVER + 1;
const BYTES_PER_SECOND = 1024 * 1024;
const BURST_BYTES = 2 * BYTES_PER_SECOND;
const PING_INTERVAL_MS = 30_000;
const DEAD_PEER_MS = 90_000;
const AUTH_TIMEOUT_MS = 10_000;

export type RelayTrafficCapConfig =
  | {
      readonly free: {
        readonly memberBytesPerMinute: number;
        readonly connectionBytesPerMinute: number;
      };
    }
  | { readonly mode: "measure-only" };

export type RelayTrafficDirection = "ingress" | "egress";
export interface RelayTrafficUsage {
  readonly minute: number;
  readonly ingressBytes: number;
  readonly egressBytes: number;
}
export interface RelayTrafficStore {
  read(
    memberId: string,
    minute: number,
  ): { readonly ingressBytes: number; readonly egressBytes: number };
  /** Atomically compare the persisted member total with the cap, then add accepted bytes. */
  charge(
    event: {
      readonly memberId: string;
      readonly connectionId: string;
      readonly minute: number;
      readonly direction: RelayTrafficDirection;
      readonly bytes: number;
    },
    memberLimit?: number,
  ): {
    readonly status: "allowed" | "limited";
    readonly usage: {
      readonly ingressBytes: number;
      readonly egressBytes: number;
    };
  };
  close?(): void;
}

export interface RelayCustomDomainRoute {
  readonly app: string;
  readonly user: string;
  /** Set only after TXT ownership proof and CNAME target have been observed. */
  readonly ownershipVerified: boolean;
  /** The TLS edge must have an active certificate before requests are routed. */
  readonly certificateReady: boolean;
}

/** Owner-controlled opt-in file for the single pinned public user. */
export function loadRelayPublicListing(path: string): ReadonlySet<string> {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    throw new Error("relay public listing safe open is unavailable");
  }
  // Source: POSIX nonblocking open prevents a swapped FIFO from hanging relay startup before fstat.
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let raw: string;
  try {
    const stat = fstatSync(fd);
    // Source: loadRelayTrafficCap owner-only file policy; POSIX mode 0600 keeps app selection private until published.
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(
        "relay public listing config must be owner-only regular file",
      );
    raw = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).join() !== "apps" ||
    !Array.isArray((parsed as { apps?: unknown }).apps) ||
    !(parsed as { apps: unknown[] }).apps.every(
      (app) => typeof app === "string",
    )
  ) {
    throw new Error("invalid relay public listing config");
  }
  const apps = (parsed as { apps: string[] }).apps;
  if (new Set(apps).size !== apps.length)
    throw new Error("duplicate public listing app id");
  return new Set(apps);
}

/** Owner-only projection of domains whose DNS ownership and TLS certificate are already verified. */
export function loadRelayCustomDomainRoutes(
  path: string,
): ReadonlyMap<string, RelayCustomDomainRoute> {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    throw new Error("relay custom domain safe open is unavailable");
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error(
        "relay custom domain config must be owner-only regular file",
      );
    }
    raw = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).join() !== "domains" ||
    !Array.isArray((parsed as { domains?: unknown }).domains)
  )
    throw new Error("invalid relay custom domain config");
  const routes = new Map<string, RelayCustomDomainRoute>();
  for (const entry of (parsed as { domains: unknown[] }).domains) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join() !==
        "app,certificateReady,hostname,ownershipVerified,user"
    ) {
      throw new Error("invalid relay custom domain route entry");
    }
    const route = entry as RelayCustomDomainRoute & { hostname: string };
    if (
      typeof route.hostname !== "string" ||
      typeof route.app !== "string" ||
      typeof route.user !== "string" ||
      route.ownershipVerified !== true ||
      route.certificateReady !== true
    )
      throw new Error("custom domain route is not verified");
    const hostname = route.hostname.trim().toLowerCase().replace(/\.$/, "");
    if (!hostname || routes.has(hostname))
      throw new Error("duplicate or invalid custom domain route");
    routes.set(hostname, {
      app: route.app,
      user: route.user,
      ownershipVerified: true,
      certificateReady: true,
    });
  }
  return routes;
}

export function loadRelayTrafficCap(path: string): RelayTrafficCapConfig {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("relay traffic cap config must be owner-only regular file");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid relay traffic cap config");
  }
  if (
    Object.keys(parsed).join() === "mode" &&
    (parsed as { mode?: unknown }).mode === "measure-only"
  ) {
    return { mode: "measure-only" };
  }
  if (Object.keys(parsed).join() !== "free")
    throw new Error("invalid relay traffic cap config");
  const free = (parsed as { free?: unknown }).free;
  if (
    !free ||
    typeof free !== "object" ||
    Array.isArray(free) ||
    Object.keys(free).sort().join() !==
      "connectionBytesPerMinute,memberBytesPerMinute"
  ) {
    throw new Error("invalid relay traffic cap config");
  }
  const config = {
    free: free as Extract<RelayTrafficCapConfig, { free: unknown }>["free"],
  };
  createRelayTrafficMeter(config);
  return config;
}

/** Fixed UTC minute windows; limit values come from operator config, never a public response. */
export function createRelayTrafficMeter(
  config: RelayTrafficCapConfig,
  now: () => number = Date.now,
  store?: RelayTrafficStore,
) {
  const limits = "free" in config ? config.free : undefined;
  const memberBytesPerMinute = limits?.memberBytesPerMinute;
  const connectionBytesPerMinute = limits?.connectionBytesPerMinute;
  if (
    limits &&
    ![memberBytesPerMinute, connectionBytesPerMinute].every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error("invalid relay traffic cap config");
  }
  if (
    !limits &&
    (!("mode" in config) || config.mode !== "measure-only" || !store)
  ) {
    throw new Error("measure-only relay traffic requires a ledger");
  }
  let minute = -1;
  const members = new Map<string, number>();
  const connections = new Map<string, number>();
  const usage = new Map<
    string,
    { ingressBytes: number; egressBytes: number }
  >();
  const currentMinute = () => Math.floor(now() / 60_000);
  const rollWindow = () => {
    const current = currentMinute();
    if (current !== minute) {
      minute = current;
      members.clear();
      connections.clear();
      usage.clear();
    }
  };
  return {
    charge(
      memberId: string | null | undefined,
      connectionId: string,
      bytes: number,
      direction: RelayTrafficDirection = "ingress",
    ): "allowed" | "limited" | "member-required" | "ledger-unavailable" {
      if (!memberId) return "member-required";
      if (
        !connectionId ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        !["ingress", "egress"].includes(direction)
      ) {
        throw new Error("invalid relay traffic measurement");
      }
      rollWindow();
      const connectionTotal = connections.get(connectionId) ?? 0;
      if (
        connectionBytesPerMinute !== undefined &&
        connectionTotal + bytes > connectionBytesPerMinute
      )
        return "limited";
      if (store) {
        let result: ReturnType<RelayTrafficStore["charge"]>;
        try {
          result = store.charge(
            { memberId, connectionId, minute, direction, bytes },
            memberBytesPerMinute,
          );
        } catch {
          return "ledger-unavailable";
        }
        if (result.status === "limited") return "limited";
        usage.set(memberId, { ...result.usage });
      } else {
        const memberTotal = members.get(memberId) ?? 0;
        if (
          memberBytesPerMinute !== undefined &&
          memberTotal + bytes > memberBytesPerMinute
        )
          return "limited";
        members.set(memberId, memberTotal + bytes);
        const currentUsage = usage.get(memberId) ?? {
          ingressBytes: 0,
          egressBytes: 0,
        };
        currentUsage[
          direction === "ingress" ? "ingressBytes" : "egressBytes"
        ] += bytes;
        usage.set(memberId, currentUsage);
      }
      connections.set(connectionId, connectionTotal + bytes);
      return "allowed";
    },
    usage(memberId: string): RelayTrafficUsage {
      rollWindow();
      const value = store?.read(memberId, minute) ?? usage.get(memberId);
      return {
        minute,
        ingressBytes: value?.ingressBytes ?? 0,
        egressBytes: value?.egressBytes ?? 0,
      };
    },
    forgetConnection(connectionId: string): void {
      connections.delete(connectionId);
    },
  };
}

type SocketData = {
  role: "host" | "client";
  serverId: string;
  clientId?: number;
  challenge?: string;
  authenticated: boolean;
  lastSeen: number;
  tokens: number;
  refillAt: number;
  memberId?: string;
  /** (출처: #39104) 회원 서버 서비스 자격(ems_)으로 승인된 연결 — 핀 읽기 게이트만 읽는다. */
  memberService?: boolean;
  /** (출처: #106092) ⓑ — 정책 member-service 결속 키로 온 연결(ems_ 서비스 자격 필수). */
  memberServiceBound?: boolean;
  connectionId: string;
  authTimer?: ReturnType<typeof setTimeout>;
};
type Socket = ServerWebSocket<SocketData>;

// (출처: #39104) 회원 서버 역할 서비스 토큰(ems_) 자격 증명 — WS 업그레이드
// 프로토콜 목록에서만 운반된다. 공개 HTTP 회원 경로(memberAuthorized)에는
// 효력이 없다: 서비스 자격은 host 연결 심사일 뿐이고 «아무 회원의 핸들 핀
// 불리언 읽기» 외 권한은 0이다(쓰기 포함).
const memberServiceCredential = (req: Request): string | undefined =>
  req.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => /^ems_[A-Za-z0-9_-]+$/.test(value));
type PublicResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  /**
   * 출처: #39009 — true 면 `body` 는 빈 헤더-only scaffold 이고 실제 바디는
   * 뒤따르는 `{chunk:"<base64>"}` 데이터 프레임으로 흘러온다(SSE 스트리밍).
   */
  stream?: boolean;
};
const publicNotFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * WEBCHAT-401-LOGIN-PAGE — bare 핸들 호스트(회원 webchat 원점)에서 세션 없는
 * «문서 요청»(GET + Accept: text/html)에 내려 줄 로그인 안내 본문. 401 상태·
 * 쿠키·리다이렉트는 그대로 두고 401 본문 렌더만 교체한다(데모 빈 화면 RED 수리).
 */
const BARE_WEBCHAT_LOGIN_GUIDE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>엘라누스 회원 로그인</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; text-align: center">
<main>
  <h1>엘라누스 회원 로그인 → 내 엘라누스에서 웹채팅 열기</h1>
  <p>이 핸들 주소는 회원 로그인 후 이용할 수 있습니다.</p>
  <p><a href="https://elanous.ai/members/"><button>엘라누스 회원 로그인</button></a></p>
</main>
</body>
</html>`;
const isBareWebchatDocumentRequest = (request: Request) =>
  request.method === "GET" &&
  (request.headers.get("accept") ?? "").includes("text/html");
type PublicRequest = {
  channel: import("./channel.js").EncryptedChannel;
  decoder: MuxDecoder;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  publicHost: string;
  internalHost: string;
  memberId?: string;
  connectionId: string;
  releaseSlot: () => void;
  response?: PublicResponse;
  /**
   * 출처: #39009 — 스트리밍 scaffold Response 의 바디 컨트롤러. `stream:true`
   * envelope 프레임에서 채워지고, `{chunk}` 프레임으로 append 하다가 close
   * 프레임에서 EOF 를 낸다.
   */
  streamController?: ReadableStreamDefaultController<Uint8Array>;
};
type AppKillSwitch = Pick<
  ReturnType<typeof import("./app-kill-switch.js").createAppKillSwitch>,
  "applyIncident" | "isDown" | "close"
>;
type Room = {
  host?: Socket;
  hostPublicKey?: Uint8Array;
  /**
   * (출처: #39104) ⓑ1 수리 — 서비스 자격(ems_) 연결 목록. 호스트 슬롯
   * (host)과 분리되어 duplicate-host 검사·퇴거 대상이 아니고
   * hostPublicKey 도 쓸 수 없다(«핀 읽기 질의» 전용).
   */
  services: Set<Socket>;
  clients: Map<number, Socket>;
  publicRequests: Map<number, PublicRequest>;
  publicSlots: number;
  nextId: number;
  bytes: number;
  failures: Record<string, number>;
};

export interface RelayServerOptions {
  port?: number;
  hostname?: string;
  /** Ed25519 signing public keys (base64url raw 32 bytes), pinned by X25519-derived serverId. */
  trustedHostKeys?: ReadonlyMap<string, string>;
  /** Rollout switch. Existing relay behavior remains active until enabled. */
  memberRequired?: boolean;
  /** Server IDs are pinned to the owning Nexus member, independent of caller claims. */
  hostOwnerMemberIds?: ReadonlyMap<string, string>;
  /** (출처: #106092) ⓑ — 정책 member-service 결속 키 집합(선택). 등재
   * serverId 는 owner 없이 유효(회원 서버 역할)하며 ems_ 없는 연결은
   * fail-closed(비-WS 403 · WS 4401). */
  memberServiceServerIds?: ReadonlySet<string>;
  /** Introspects relay.connect on every connection, so expiry and revocation take effect. */
  validateMemberToken?: (
    token: string,
    serverId: string,
  ) => Promise<{ memberId: string } | null>;
  /**
   * (출처: #39104) 회원 서버 역할 서비스 토큰(ems_ 접두 단일 시크릿). 회전은
   * env(ELANOUS_RELAY_MEMBER_SERVICE_TOKEN) 또는 0600 권한 파일
   * (ELANOUS_RELAY_MEMBER_SERVICE_TOKEN_FILE)로 한다. 이 자격은 «아무 회원의
   * 핸들 핀 여부 불리언 읽기»만 허용하고 public-handle-pin 쓰기는 전부
   * 거부된다(쓰기는 emt_ 소유자 대조만 지난다).
   */
  memberServiceToken?: string;
  /** Operator-provided private free-tier limits. The server never returns these values. */
  trafficCap?: RelayTrafficCapConfig;
  /** Optional synchronous private usage store; read/write failure rejects the measured frame. */
  trafficStore?: RelayTrafficStore;
  /** @internal Deterministic clock for traffic-window simulations. */
  trafficNowForTesting?: () => number;
  /** Durable app stop ledger used by the public report route and request gate. */
  appKillSwitch?: Pick<AppKillSwitch, "applyIncident" | "isDown"> &
    Partial<Pick<AppKillSwitch, "close">>;
  /** Apps whose owner explicitly opted in to public search; the default is empty. */
  publicListedApps?: ReadonlySet<string>;
  /** Explicit user/app pairs allowed anonymous GET/HEAD; absent means private. */
  publicReadableApps?: ReadonlySet<string>;
  /** Dynamic public read expiry checked on each request, independent of reload health. */
  publicReadExpiresAt?: ReadonlyMap<string, number>;
  /** Authenticated existing host only; server-owned store verifies the pinned route. */
  autoAppRegistration?: {
    register(
      serverId: string,
      ownerId: string,
      input: AutoPublicAppRegistration,
    ): void | Promise<void>;
    unregister(
      serverId: string,
      ownerId: string,
      input: Pick<
        AutoPublicAppRegistration,
        "user" | "app" | "deploymentId" | "grantId"
      >,
    ): void | Promise<void>;
    pinHandle?(
      serverId: string,
      ownerId: string,
      input: { user: string; memberId: string },
    ): void | Promise<void>;
    /** OP #105017 ⓐ① — 인증된 «핀 읽기» 질의: 살아 있는 핀 여부만 불리언으로 답한다(다른 값 노출 없음). */
    queryHandlePin?(
      serverId: string,
      ownerId: string,
      input: { user: string; memberId: string },
    ): boolean | Promise<boolean>;
    /** (출처: #39104) 회원 서버 서비스 자격 «핀 읽기» — 연결 소유자가 아닌 회원의 살아 있는 핀도 불리언으로 답한다(쓰기 경로 없음). */
    queryHandlePinByMember?(
      input: { user: string; memberId: string },
    ): boolean | Promise<boolean>;
  };
  /** Separate expiring app/path POST opt-in; never extends member or control authority. */
  publicVisitorWritePolicies?: readonly PublicAppVisitorWritePolicy[];
  /** Durable replay/rate store, required whenever visitor writes are enabled. */
  publicVisitorWriteLedger?: VisitorWriteLedger;
  /** Opt in to the invited-app reverse proxy for exactly this public domain. */
  publicDomain?: "elanous.app" | "elanous.ai";
  /** Legacy single-user public host pin. */
  publicServerId?: string;
  /** Legacy single-user public label. */
  publicUserId?: string;
  /** Operator-pinned public labels for multiple authenticated Nexus hosts. */
  publicDispatchRoutes?: ReadonlyMap<string, PublicDispatchRoute>;
  /** Verified custom hostnames from the domain/certificate control plane; absent entries fail closed. */
  customDomainRoutes?: ReadonlyMap<string, RelayCustomDomainRoute>;
  /** @internal Short timeout for focused relay lifecycle tests. */
  publicRequestTimeoutMsForTesting?: number;
}

export function parsePublicAppHost(
  value: string,
  domain = "elanous.app",
): { app: string; user: string } | undefined {
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const label = hostname.slice(0, -suffix.length);
  if (!label || label.includes(".")) return undefined;
  const parts = label.split("--");
  if (parts.length !== 2) return undefined;
  const [app, user] = parts as [string, string];
  const valid = (part: string, max: number) =>
    part.length <= max &&
    !part.includes("--") &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part);
  if (
    !valid(app, 24) ||
    !valid(user, 20) ||
    user.length < 3 ||
    /-pr\d+$/.test(app)
  )
    return undefined;
  if (["www", "docs", "api", "admin", "relay", "mail"].includes(app))
    return undefined;
  return { app, user };
}

/** Public app URLs and the relay must use one configured user label. */
export function resolvePublicAppUserId(
  explicit?: string,
  environmentValue = process.env.ELANOUS_PUBLIC_APP_USER_ID,
): string | undefined {
  const shared = environmentValue?.trim();
  if (shared && explicit && shared !== explicit)
    throw new Error("--public-user-id must match ELANOUS_PUBLIC_APP_USER_ID");
  const userId = shared || explicit;
  if (
    userId !== undefined &&
    (userId.length < 3 ||
      userId.length > 20 ||
      userId.includes("--") ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(userId))
  ) {
    throw new Error(
      "ELANOUS_PUBLIC_APP_USER_ID must be a valid public app user label",
    );
  }
  return userId;
}

function responseFromPublicEnvelope(
  value: PublicResponse | undefined,
  publicHost: string,
  internalHost: string,
  // 출처: #39009 — 스트리밍 scaffold 의 바디 컨트롤러를 돌려받을 싱크.
  streamSink?: { streamController?: ReadableStreamDefaultController<Uint8Array> },
): Response {
  if (
    !value ||
    !Number.isInteger(value.status) ||
    value.status < 200 ||
    value.status > 599 ||
    typeof value.body !== "string" ||
    !/^(?:[A-Za-z0-9+/]*={0,2})$/.test(value.body)
  ) {
    return new Response("Bad gateway", { status: 502 });
  }
  const connectionTokens = new Set(
    (
      Object.entries(value.headers).find(
        ([name]) => name.toLowerCase() === "connection",
      )?.[1] ?? ""
    )
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token)),
  );
  const headers = new Headers();
  for (const [name, raw] of Object.entries(value.headers)) {
    const lower = name.toLowerCase();
    if (
      [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
      ].includes(lower) ||
      connectionTokens.has(lower)
    )
      continue;
    if (lower === "set-cookie") {
      for (const cookie of raw.split(/,(?=[^;,]+=)/))
        headers.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/gi, ""));
    } else if (
      lower === "x-nexus-app-origin" ||
      lower === "access-control-allow-origin"
    ) {
      headers.set(
        name,
        raw === `http://${internalHost}` ? `https://${publicHost}` : raw,
      );
    } else if (lower === "x-nexus-app-host") headers.set(name, publicHost);
    else if (lower === "location" || lower === "content-location") {
      try {
        const candidate = raw.trim();
        if (candidate.startsWith("//")) {
          const url = new URL(`http:${candidate}`);
          if (url.host.toLowerCase() === internalHost) {
            headers.set(
              name,
              `https://${publicHost}${url.pathname}${url.search}${url.hash}`,
            );
          } else headers.set(name, raw);
          continue;
        }
        const url = new URL(candidate);
        if (
          url.protocol === "http:" &&
          url.host.toLowerCase() === internalHost
        ) {
          url.protocol = "https:";
          url.host = publicHost;
          headers.set(name, url.toString());
        } else headers.set(name, raw);
      } catch {
        headers.set(name, raw);
      }
    } else headers.set(name, raw);
  }
  if (value.stream) {
    // 출처: #39009 — 헤더-only 스트리밍 scaffold: 바디는 지금 비어 있고
    // 뒤따르는 `{chunk:"<base64>"}` 데이터 프레임으로 채워진다. 컨트롤러는
    // streamSink 로 넘겨 조기 resolve 된 Response 가 계속 흐르게 한다.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (streamSink) streamSink.streamController = controller;
        else controller.close();
      },
    });
    return new Response(body, { status: value.status, headers });
  }
  const body = Buffer.from(value.body, "base64");
  if (body.byteLength > MAX_MUX_FRAME_BYTES)
    return new Response("Response too large", { status: 502 });
  return new Response([204, 205, 304].includes(value.status) ? null : body, {
    status: value.status,
    headers,
  });
}

/** Load operator-provisioned pins, never keys claimed by connecting hosts. */
export function loadTrustedHostKeys(file: string): ReadonlyMap<string, string> {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid relay trusted host keys");
  const result = new Map<string, string>();
  for (const [id, key] of Object.entries(raw)) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      typeof key !== "string" ||
      !decodeKey(key)
    ) {
      throw new Error("invalid relay trusted host key entry");
    }
    result.set(id, key);
  }
  return result;
}

function decodeKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value
    ? decoded
    : undefined;
}

function encodeClientId(id: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.length + 4);
  new DataView(result.buffer).setUint32(0, id, false);
  result.set(payload, 4);
  return result;
}

/** The relay never parses or logs encrypted channel payloads. Host binary frames carry a
 * four-byte big-endian clientId prefix; phone binary frames are raw ciphertext. */
export function startRelayServer(options: RelayServerOptions = {}) {
  if (!options.trustedHostKeys?.size)
    throw new Error("relay trusted host keys required");
  let trustedHostKeys = new Map(options.trustedHostKeys);
  let hostOwnerMemberIds = options.hostOwnerMemberIds
    ? new Map(options.hostOwnerMemberIds)
    : undefined;
  // (출처: #106092) ⓑ — 정책 member-service 결속 집합(reload 시 원자 교체).
  let memberServiceServerIds = options.memberServiceServerIds
    ? new Set(options.memberServiceServerIds)
    : undefined;
  for (const [id, key] of trustedHostKeys) {
    if (!/^[a-f0-9]{64}$/.test(id) || !decodeKey(key))
      throw new Error("invalid relay trusted host key entry");
  }
  if (
    options.memberRequired &&
    (!options.validateMemberToken ||
      !options.hostOwnerMemberIds ||
      [...trustedHostKeys.keys()].some(
        (id) =>
          // (출처: #106092) ⓑ — 결속 서비스 키는 owner 없이 허용(회원 서버 역할).
          !options.hostOwnerMemberIds?.get(id) &&
          !options.memberServiceServerIds?.has(id),
      ))
  ) {
    throw new Error(
      "relay member gate requires a token verifier and owner for every trusted host",
    );
  }
  if (options.trafficCap && !options.memberRequired)
    throw new Error("relay traffic cap requires member authentication");
  if (options.trafficCap && !options.trafficStore)
    throw new Error("relay traffic cap requires a durable traffic ledger");
  if (options.trafficStore && !options.trafficCap)
    throw new Error("relay traffic store requires traffic cap");
  const trafficMeter = options.trafficCap
    ? createRelayTrafficMeter(
        options.trafficCap,
        options.trafficNowForTesting,
        options.trafficStore,
      )
    : null;
  const multiUser = options.publicDispatchRoutes !== undefined;
  if (
    multiUser &&
    (!options.publicDomain ||
      options.publicServerId ||
      options.publicUserId ||
      !options.memberRequired ||
      !options.hostOwnerMemberIds)
  ) {
    throw new Error(
      "multi-user public dispatch requires a domain and member gate without a single-user pin",
    );
  }
  let publicRoutes = multiUser
    ? buildPublicDispatchRoutes(
        options.publicDispatchRoutes!,
        new Set(trustedHostKeys.keys()),
        options.hostOwnerMemberIds!,
      )
    : undefined;
  if (options.publicDomain !== undefined) {
    if (
      !multiUser &&
      (!options.publicServerId ||
        !trustedHostKeys.has(options.publicServerId) ||
        !options.publicUserId ||
        options.publicUserId.length < 3 ||
        options.publicUserId.length > 20 ||
        options.publicUserId.includes("--") ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.publicUserId))
    ) {
      throw new Error(
        "public relay requires a pinned publicServerId and valid publicUserId",
      );
    }
    if (
      options.hostname &&
      !["127.0.0.1", "::1", "localhost"].includes(options.hostname)
    ) {
      throw new Error(
        "public relay listener must stay loopback behind the TLS edge",
      );
    }
  } else if (
    options.publicServerId !== undefined ||
    options.publicUserId !== undefined ||
    multiUser
  ) {
    throw new Error("publicServerId and publicUserId require publicDomain");
  }
  let publicReadableApps = new Set(options.publicReadableApps ?? []);
  let publicReadExpiresAt = new Map(options.publicReadExpiresAt ?? []);
  for (const key of publicReadableApps) {
    const [user, app, extra] = key.split("/");
    const parsed = parsePublicAppHost(
      `${app}--${user}.${options.publicDomain}`,
      options.publicDomain,
    );
    if (
      !options.publicDomain ||
      extra !== undefined ||
      !parsed ||
      parsed.user !== user ||
      parsed.app !== app ||
      !(publicRoutes?.has(user!) || user === options.publicUserId)
    )
      throw new Error("invalid public read binding");
  }
  let visitorPolicies = (options.publicVisitorWritePolicies ?? []).map(
    (policy) => validateVisitorWritePolicy(policy),
  );
  if (
    visitorPolicies.length &&
    (!options.memberRequired || !options.publicVisitorWriteLedger)
  ) {
    throw new Error(
      "visitor writes require pinned member hosts and a durable admission ledger",
    );
  }
  for (const policy of visitorPolicies) {
    const pinnedServer =
      publicRoutes?.get(policy.user)?.serverId ??
      (policy.user === options.publicUserId
        ? options.publicServerId
        : undefined);
    if (
      !publicReadableApps.has(policy.user + "/" + policy.app) ||
      policy.serverId !== pinnedServer
    ) {
      throw new Error("invalid visitor write binding");
    }
  }
  let visitorGate = visitorPolicies.length
    ? createPublicAppVisitorWriteGate(
        visitorPolicies,
        options.publicVisitorWriteLedger!,
      )
    : undefined;
  let activeVisitorChecks = 0;
  const publicListedApps = new Set(options.publicListedApps ?? []);
  if (publicListedApps.size && !options.publicDomain)
    throw new Error("public app listing requires public relay mode");
  if (publicListedApps.size && multiUser)
    throw new Error("multi-user public listing requires per-user opt-in");
  for (const app of publicListedApps) {
    if (
      parsePublicAppHost(
        `${app}--${options.publicUserId}.${options.publicDomain}`,
        options.publicDomain,
      )?.app !== app
    ) {
      throw new Error("invalid public listing app id");
    }
  }
  const customDomainRoutes = new Map<string, RelayCustomDomainRoute>();
  for (const [rawHostname, route] of options.customDomainRoutes ?? []) {
    const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, "");
    if (
      !hostname ||
      hostname.includes(":") ||
      hostname.includes("/") ||
      hostname.includes("..") ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) ||
      (!!options.publicDomain &&
        !!parsePublicAppHost(hostname, options.publicDomain)) ||
      !options.publicDomain ||
      !(publicRoutes?.has(route.user) || route.user === options.publicUserId) ||
      !route.ownershipVerified ||
      !route.certificateReady ||
      parsePublicAppHost(
        `${route.app}--${route.user}.${options.publicDomain}`,
        options.publicDomain,
      )?.app !== route.app
    ) {
      throw new Error("invalid or unverified custom domain route");
    }
    if (customDomainRoutes.has(hostname))
      throw new Error("duplicate custom domain route");
    customDomainRoutes.set(hostname, { ...route });
  }
  const rooms = new Map<string, Room>();
  const sockets = new Set<Socket>();
  const reloadPublicPolicySnapshot = (
    input: RelayPublicPolicySnapshot,
  ): void => {
    if (!multiUser || !options.publicDomain || !options.memberRequired)
      throw new Error("relay policy reload unavailable");
    const candidate = validatedRelayPublicPolicySnapshot(
      input,
      options.publicDomain,
    );
    if (
      candidate.publicVisitorWritePolicies.length &&
      !options.publicVisitorWriteLedger
    ) {
      throw new Error("visitor policy ledger unavailable");
    }
    for (const route of customDomainRoutes.values()) {
      if (!candidate.publicDispatchRoutes.has(route.user))
        throw new Error("custom domain route would lose owner");
    }
    // Build the gate before changing any request-visible map. It reuses the same
    // durable ledger, preserving replay and rate history across policy renewal.
    const nextVisitorGate = candidate.publicVisitorWritePolicies.length
      ? createPublicAppVisitorWriteGate(
          candidate.publicVisitorWritePolicies,
          options.publicVisitorWriteLedger!,
        )
      : undefined;
    const nextKeys = new Map(candidate.trustedHostKeys);
    const nextOwners = new Map(candidate.hostOwnerMemberIds);
    // (출처: #106092) ⓑ — reload 후보에 member-service 결속 집합도 반영한다.
    const nextMemberServiceServerIds = candidate.memberServiceServerIds
      ? new Set(candidate.memberServiceServerIds)
      : undefined;
    const replaced = new Set(
      [...trustedHostKeys.keys()].filter(
        (serverId) =>
          nextKeys.get(serverId) !== trustedHostKeys.get(serverId) ||
          nextOwners.get(serverId) !== hostOwnerMemberIds?.get(serverId) ||
          // (출처: #106092) ⓑ — 결속 등재·해제도 권한 변경: 재심사(fail-closed).
          // (출처: #106214) ⓑ 회귀 수리 — 양변 ?? false: 미구성 시 무변경.
          (nextMemberServiceServerIds?.has(serverId) ?? false) !==
            (memberServiceServerIds?.has(serverId) ?? false),
      ),
    );
    trustedHostKeys = nextKeys;
    hostOwnerMemberIds = nextOwners;
    memberServiceServerIds = nextMemberServiceServerIds;
    publicRoutes = candidate.publicDispatchRoutes;
    publicReadableApps = new Set(candidate.publicReadableApps);
    publicReadExpiresAt = new Map(candidate.publicReadExpiresAt);
    visitorPolicies = [...candidate.publicVisitorWritePolicies];
    visitorGate = nextVisitorGate;
    for (const socket of sockets)
      if (replaced.has(socket.data.serverId))
        socket.close(1008, "host authority changed");
  };
  let activeMemberChecks = 0;
  const roomFor = (id: string): Room => {
    let room = rooms.get(id);
    if (!room) {
      room = {
        // (출처: #39104) ⓑ1 — 서비스(ems_) 연결 목록(호스트 슬롯과 분리).
        services: new Set(),
        clients: new Map(),
        publicRequests: new Map(),
        publicSlots: 0,
        nextId: 1,
        bytes: 0,
        failures: {},
      };
      rooms.set(id, room);
    }
    return room;
  };
  const fail = (room: Room, reason: string) => {
    room.failures[reason] = (room.failures[reason] ?? 0) + 1;
  };
  type MemberCredential = {
    token: string;
    source: "protocol" | "authorization";
  };
  const memberCredentials = (req: Request): MemberCredential[] => {
    const credentials: MemberCredential[] = [];
    const bearer = /^Bearer\s+(emt_[A-Za-z0-9_-]+)$/i.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
    if (bearer) credentials.push({ token: bearer, source: "authorization" });
    const protocol = req.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((value) => value.trim())
      .find((value) => /^emt_[A-Za-z0-9_-]+$/.test(value));
    if (protocol) credentials.push({ token: protocol, source: "protocol" });
    return credentials;
  };
  type MemberGate =
    | { status: "allowed"; consumed: MemberCredential[] }
    | { status: "denied" | "foreign" | "busy"; consumed: [] };
  const memberAuthorized = async (
    req: Request,
    serverId: string,
  ): Promise<MemberGate> => {
    if (!options.memberRequired) return { status: "allowed", consumed: [] };
    const credentials = memberCredentials(req);
    if (!credentials.length) return { status: "denied", consumed: [] };
    if (activeMemberChecks >= MAX_MEMBER_CHECKS)
      return { status: "busy", consumed: [] };
    activeMemberChecks += 1;
    const consumed: MemberCredential[] = [];
    let foreignMember = false;
    try {
      const ownerId = hostOwnerMemberIds!.get(serverId);
      if (!ownerId) return { status: "denied", consumed: [] };
      for (const credential of credentials) {
        let member: { memberId: string } | null = null;
        try {
          member = await options.validateMemberToken!(
            credential.token,
            serverId,
          );
        } catch {
          /* fail closed */
        }
        if (member?.memberId === ownerId) consumed.push(credential);
        else if (member) foreignMember = true;
      }
    } finally {
      activeMemberChecks -= 1;
    }
    return consumed.length
      ? { status: "allowed", consumed }
      : { status: foreignMember ? "foreign" : "denied", consumed: [] };
  };
  const sendControl = (ws: Socket, value: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const drop = (ws: Socket) => {
    const data = ws.data;
    trafficMeter?.forgetConnection(data.connectionId);
    if (data.authTimer) clearTimeout(data.authTimer);
    sockets.delete(ws);
    const room = rooms.get(data.serverId);
    if (!room) return;
    if (!data.authenticated) {
      if (
        !room.host &&
        room.clients.size === 0 &&
        !Array.from(sockets).some(
          (peer) => peer.data.serverId === data.serverId,
        )
      )
        rooms.delete(data.serverId);
      return;
    }
    // (출처: #39104) ⓑ1 수리 — 서비스 자격(ems_) 연결 정리: 호스트 슬롯·
    // 공개 요청에는 영향 없이 services 목록에서만 뺀다.
    if (data.role === "host" && data.memberService === true) {
      room.services.delete(ws);
    }
    if (data.role === "host" && room.host === ws) {
      room.host = undefined;
      room.hostPublicKey = undefined;
      for (const request of room.publicRequests.values()) {
        clearTimeout(request.timer);
        request.releaseSlot();
        request.resolve(new Response("Host unavailable", { status: 502 }));
      }
      room.publicRequests.clear();
      const clients = [...room.clients.values()];
      room.clients.clear();
      for (const client of clients) client.close(1012, "host disconnected");
    } else if (
      data.role === "client" &&
      data.clientId !== undefined &&
      room.clients.get(data.clientId) === ws
    ) {
      room.clients.delete(data.clientId);
      if (room.host)
        sendControl(room.host, {
          type: "client-disconnected",
          clientId: data.clientId,
        });
    }
    if (
      !room.host &&
      room.clients.size === 0 &&
      !Array.from(sockets).some((peer) => peer.data.serverId === data.serverId)
    )
      rooms.delete(data.serverId);
  };
  const capacity = (ws: Socket, length: number): boolean => {
    const data = ws.data;
    const now = Date.now();
    data.tokens = Math.min(
      BURST_BYTES,
      data.tokens + ((now - data.refillAt) * BYTES_PER_SECOND) / 1000,
    );
    data.refillAt = now;
    if (length > data.tokens) return false;
    data.tokens -= length;
    return true;
  };
  const publicFetch = async (req: Request): Promise<Response> => {
    const hostHeader = req.headers.get("host") ?? "";
    const normalizedHost = hostHeader
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, "")
      .replace(/\.$/, "");
    const customRoute = customDomainRoutes.get(normalizedHost);
    let publicApp =
      parsePublicAppHost(hostHeader, options.publicDomain) ??
      (customRoute
        ? { app: customRoute.app, user: customRoute.user }
        : undefined);
    // HANDLE-BARE-HOST-WEBCCHAT-PROXY: marks a bare-handle hit so forwarding keeps
    // the member's own public host instead of a synthesized app origin.
    let bareHit = false;
    // 출처: #39024 — bare 고정 핸들 웹채팅 경로(진입 3종 + 회원 채팅 API 2종)는
    // publicReadableApps "정확히 1개" 게이트보다 앞에서 판정한다. 공개 앱이
    // 0개여도 bare 요청은 회원 Nexus 로 흘러야 하기 때문이다.
    const bareEntryPath = new URL(req.url).pathname;
    const bareWebChatNexusPath =
      bareEntryPath === "/" ||
      bareEntryPath === "/app/chat" ||
      bareEntryPath.startsWith("/app/chat/") ||
      bareEntryPath === "/v1/chat/events" ||
      bareEntryPath === "/v1/prompt/stream";
    if (!publicApp) {
      // A bare member host can point only to one explicitly public app on a pinned host.
      // A second app makes the destination ambiguous, so the route stays closed.
      // HANDLE-BARE-HOST-WEBCCHAT-PROXY (OP #99957): the bare handle host now proxies
      // that single public app (the member webchat) instead of 308-redirecting, so the
      // member's own address serves the chat directly and write routes flow through
      // the same per-method gates as the app host.
      const suffix = `.${options.publicDomain}`;
      const bareUser =
        options.publicDomain && normalizedHost.endsWith(suffix)
          ? normalizedHost.slice(0, -suffix.length)
          : "";
      if (
        bareUser &&
        /^[a-z][a-z0-9]{2,19}$/.test(bareUser) &&
        !["www", "docs", "api", "admin", "relay", "mail"].includes(bareUser) &&
        (publicRoutes?.has(bareUser) || bareUser === options.publicUserId)
      ) {
        const apps = [...publicReadableApps].filter((binding) =>
          binding.startsWith(bareUser + "/"),
        );
        if (apps.length === 1) {
          const app = apps[0]!.slice(bareUser.length + 1);
          const targetHost = `${app}--${bareUser}.${options.publicDomain}`;
          if (
            parsePublicAppHost(targetHost, options.publicDomain)?.app === app
          ) {
            publicApp = { app, user: bareUser };
            bareHit = true;
          }
        } else if (apps.length === 0 && bareWebChatNexusPath) {
          // 출처: #39024 — 공개 앱이 0개여도 bare 웹채팅 경로는 회원 Nexus 로
          // 흐른다. 앱 프록시가 아니므로 "정확히 1개" 게이트에 갇히지 않으며,
          // 앱 이름은 bareNexusRoute 전달에 쓰지 않는다. 복수 공개 앱(모호)은
          // 이전과 같이 닫아 둔다.
          publicApp = { app: "", user: bareUser };
          bareHit = true;
        }
      }
      if (!publicApp) {
        const legacyRoom = options.publicServerId
          ? rooms.get(options.publicServerId)
          : undefined;
        if (legacyRoom) fail(legacyRoom, "public-invalid-host");
        return publicNotFound();
      }
    }
    const serverId =
      publicRoutes?.get(publicApp.user)?.serverId ??
      (publicApp.user === options.publicUserId
        ? options.publicServerId
        : undefined);
    if (!serverId) {
      const legacyRoom = options.publicServerId
        ? rooms.get(options.publicServerId)
        : undefined;
      if (legacyRoom) fail(legacyRoom, "public-user-mismatch");
      return publicNotFound();
    }
    const room = rooms.get(serverId);
    if (new URL(req.url).pathname === "/.well-known/elanous/apps") {
      if (req.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      // Source: 내부 문서 `nexus-backend-in-a-box` APP-PUBLIC-LISTING; owner opt-in defaults off.
      const apps = [...publicListedApps]
        .filter((app) => !options.appKillSwitch?.isDown(publicApp.user, app))
        .sort()
        .map(
          (app) => `https://${app}--${publicApp.user}.${options.publicDomain}`,
        );
      return new Response(JSON.stringify({ apps }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-robots-tag": "noindex",
        },
      });
    }
    const reportPath =
      new URL(req.url).pathname === "/.well-known/elanous/report";
    if (reportPath) {
      const origin = req.headers.get("origin");
      if (origin !== "https://elanous.app" && origin !== "https://elanous.ai")
        return new Response("Forbidden", { status: 403 });
      const reportHeaders = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
        "cache-control": "no-store",
      };
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: reportHeaders });
      if (req.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: reportHeaders,
        });
      if (!options.appKillSwitch)
        return new Response("Unavailable", {
          status: 503,
          headers: reportHeaders,
        });
      // Source: 내부 문서 `nexus-backend-in-a-box` APP-ABUSE-REPORT; bounded category-only ingress.
      const maxReportBytes = 1_024;
      if (
        Number(req.headers.get("content-length") ?? 0) > maxReportBytes ||
        !req.body
      ) {
        return new Response("Invalid report", {
          status: 400,
          headers: reportHeaders,
        });
      }
      let raw = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      const reader = req.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxReportBytes) {
            await reader.cancel();
            return new Response("Invalid report", {
              status: 400,
              headers: reportHeaders,
            });
          }
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } catch {
        return new Response("Invalid report", {
          status: 400,
          headers: reportHeaders,
        });
      } finally {
        reader.releaseLock();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return new Response("Invalid report", {
          status: 400,
          headers: reportHeaders,
        });
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Object.keys(payload).join() !== "category" ||
        !["abuse", "phishing", "spam"].includes(
          (payload as { category?: unknown }).category as string,
        )
      ) {
        return new Response("Invalid report", {
          status: 400,
          headers: reportHeaders,
        });
      }
      try {
        options.appKillSwitch.applyIncident({
          userId: publicApp.user,
          appId: publicApp.app,
          incident: "abuse-report",
          reason: (payload as { category: string }).category,
          requestedBy: "public-report",
        });
        for (const [id, pending] of room?.publicRequests ?? []) {
          const target = parsePublicAppHost(
            pending.publicHost,
            options.publicDomain,
          );
          if (target?.app !== publicApp.app || target.user !== publicApp.user)
            continue;
          clearTimeout(pending.timer);
          room?.publicRequests.delete(id);
          pending.releaseSlot();
          pending.resolve(new Response("App unavailable", { status: 403 }));
          if (room?.host)
            sendControl(room.host, {
              type: "client-disconnected",
              clientId: id,
            });
        }
      } catch {
        return new Response("Unavailable", {
          status: 503,
          headers: reportHeaders,
        });
      }
      return new Response(JSON.stringify({ received: true }), {
        status: 202,
        headers: { ...reportHeaders, "content-type": "application/json" },
      });
    }
    const readKey = publicApp.user + "/" + publicApp.app;
    const readExpiry = publicReadExpiresAt.get(readKey);
    // WEBCHAT-SESSION-HANDOFF (JUD must ⓑ): after the handoff the bare-origin PWA carries
    // no emt_, only the derived wcs_ web-chat session cookie (HttpOnly, set by the member
    // Nexus on the exchange). The relay cannot read that ledger, so on the two chat routes
    // of a bare handle host only — which go to the member Nexus itself, never to an app —
    // it forwards such a request with its cookie, and the member Nexus decides (handle ·
    // expiry · revocation · pin owner; anything else is its 401).
    const bareWebChatSession =
      bareHit &&
      ((req.method === "POST" && bareEntryPath === "/v1/prompt/stream") ||
        (req.method === "GET" && bareEntryPath === "/v1/chat/events")) &&
      !memberCredentials(req).length &&
      WEBCHAT_SESSION_COOKIE.test(req.headers.get("cookie") ?? "");
    const anonymousPublicRead =
      !bareWebChatSession &&
      (readExpiry === undefined || Date.now() < readExpiry) &&
      isAnonymousPublicAppRead(
        req,
        publicApp.user,
        publicApp.app,
        publicReadableApps,
      );
    const visitorPolicy =
      visitorGate && !bareWebChatSession && !memberCredentials(req).length
        ? visitorPolicies.find(
            (policy) =>
              policy.user === publicApp.user &&
              policy.app === publicApp.app &&
              policy.method === req.method &&
              policy.paths.includes(new URL(req.url).pathname),
          )
        : undefined;
    let visitorBody: Uint8Array | undefined;
    if (visitorPolicy) {
      if (options.appKillSwitch?.isDown(publicApp.user, publicApp.app))
        return new Response("App unavailable", { status: 403 });
      if (!room?.host || !room.hostPublicKey)
        return new Response("Host unavailable", { status: 503 });
      // Reuse the established relay admission ceiling; slow bodies cannot create
      // unbounded concurrent reads before the mux/public-slot gate.
      if (activeVisitorChecks >= MAX_MEMBER_CHECKS)
        return new Response("busy", { status: 429 });
      activeVisitorChecks += 1;
      try {
        const decision = await visitorGate!(
          req,
          publicApp.user,
          publicApp.app,
          serverId,
          `https://${publicApp.app}--${publicApp.user}.${options.publicDomain}`,
        );
        if (decision.status === "refused") return decision.response;
        if (decision.status !== "allowed")
          return new Response("unauthorized", { status: 401 });
        visitorBody = decision.body;
      } finally {
        activeVisitorChecks -= 1;
      }
    }
    const anonymousVisitorWrite = visitorBody !== undefined;
    const memberGate =
      anonymousPublicRead || anonymousVisitorWrite || bareWebChatSession
        ? { status: "allowed" as const, consumed: [] }
        : await memberAuthorized(req, serverId);
    if (memberGate.status !== "allowed") {
      debug.log("relay.auth", "member-denied", { serverId, route: "public" });
      // A verified member of another host must not learn whether this app is mounted.
      // Match the app-host's missing-app response, including body and content type.
      if (memberGate.status === "foreign") return publicNotFound();
      // WEBCHAT-401-LOGIN-PAGE: bare 핸들 호스트의 세션 없는 «문서 요청»만 401 상태
      // 유지 + 로그인 안내 HTML 본문. API(JSON·SSE)·app 오리진은 기존 본문 그대로.
      // busy(429) 회원은 로그인 안내 대신 기존 busy 본문을 유지한다(JUD must ⓑ).
      if (
        bareHit &&
        memberGate.status !== "busy" &&
        isBareWebchatDocumentRequest(req)
      )
        return new Response(BARE_WEBCHAT_LOGIN_GUIDE_HTML, {
          status: 401,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      return new Response(
        memberGate.status === "busy" ? "busy" : "unauthorized",
        { status: memberGate.status === "busy" ? 429 : 401 },
      );
    }
    if (options.appKillSwitch?.isDown(publicApp.user, publicApp.app))
      return new Response("App unavailable", { status: 403 });
    const publicHost = hostHeader
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, "")
      .replace(/\.$/, "");
    // HANDLE-BARE-HOST-WEBCCHAT-PROXY: a bare handle host has no app origin of
    // its own. Only the webchat PWA entry routes the member Nexus serves on a
    // bare host (/, /app/chat, /app/chat/*) forward under the member's public
    // host — a non-app host falls through NEXUS-APP-HOST-S1 to the member Nexus
    // PWA default routes. Every other bare-handle path keeps proxying the
    // single pinned public app under its synthesized origin, so #38981/#38994
    // app-host semantics (e.g. session cookies staying bound to the serving
    // host) stay unchanged.
    const barePath = new URL(req.url).pathname;
    // 출처: #39024 — 회원 채팅 API 2종(/v1/chat/events, /v1/prompt/stream)도
    // bare 오리진에서 회원 Nexus 가 직접 받는다(SSE). 경로 집합은 위
    // bareWebChatNexusPath 분기와 같은 5종으로 유지한다.
    const bareNexusRoute = bareHit && bareWebChatNexusPath;
    const internalHost = bareNexusRoute
      ? publicHost
      : `${publicApp.app}.app.localhost`;
    if (!room?.host || !room.hostPublicKey) {
      if (room) fail(room, "public-host-offline");
      return new Response("Host unavailable", { status: 503 });
    }
    if (room.publicSlots >= MAX_PUBLIC_REQUESTS_PER_SERVER)
      return new Response("Public request capacity reached", { status: 429 });
    room.publicSlots += 1;
    const connectionId = randomUUID();
    const memberId = options.memberRequired
      ? hostOwnerMemberIds!.get(serverId)
      : undefined;
    let slotHeld = true;
    const releaseSlot = () => {
      if (slotHeld) {
        slotHeld = false;
        room.publicSlots = Math.max(0, room.publicSlots - 1);
        trafficMeter?.forgetConnection(connectionId);
      }
    };
    try {
      if (req.signal.aborted) {
        releaseSlot();
        return new Response("Request cancelled", { status: 499 });
      }
      const body = visitorBody ?? new Uint8Array(await req.arrayBuffer());
      if (req.signal.aborted) {
        releaseSlot();
        return new Response("Request cancelled", { status: 499 });
      }
      if (body.byteLength > MAX_MUX_FRAME_BYTES - 1024) {
        releaseSlot();
        return new Response("Request too large", { status: 413 });
      }
      const phoneResult = await createPhoneChannel(
        room.hostPublicKey,
        room.hostPublicKey,
      );
      if (req.signal.aborted) {
        releaseSlot();
        return new Response("Request cancelled", { status: 499 });
      }
      if (
        anonymousVisitorWrite &&
        (Date.now() >= Date.parse(visitorPolicy!.expiresAt) ||
          options.appKillSwitch?.isDown(publicApp.user, publicApp.app))
      ) {
        releaseSlot();
        return new Response("Visitor write unavailable", { status: 403 });
      }
      if (!phoneResult.ok) {
        releaseSlot();
        return new Response("Host unavailable", { status: 503 });
      }
      const phone = phoneResult.value;
      const clientId = room.nextId++;
      const streams = new MuxStreamState();
      const encoder = new MuxEncoder(streams);
      let resolve!: (response: Response) => void;
      const response = new Promise<Response>((done) => {
        resolve = done;
      });
      const pending: PublicRequest = {
        channel: phone.channel,
        decoder: new MuxDecoder(streams),
        resolve,
        timer: setTimeout(() => {
          room.publicRequests.delete(clientId);
          releaseSlot();
          if (room.host)
            sendControl(room.host, { type: "client-disconnected", clientId });
          resolve(new Response("Gateway timeout", { status: 504 }));
        }, options.publicRequestTimeoutMsForTesting ?? 30_000),
        publicHost,
        internalHost,
        memberId,
        connectionId,
        releaseSlot,
      };
      room.publicRequests.set(clientId, pending);
      req.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(pending.timer);
          room.publicRequests.delete(clientId);
          releaseSlot();
          if (room.host)
            sendControl(room.host, { type: "client-disconnected", clientId });
          pending.resolve(new Response("Request cancelled", { status: 499 }));
        },
        { once: true },
      );
      if (req.signal.aborted) {
        clearTimeout(pending.timer);
        room.publicRequests.delete(clientId);
        releaseSlot();
        return new Response("Request cancelled", { status: 499 });
      }
      let trafficFailure: "limited" | "ledger-unavailable" | undefined;
      const send = (bytes: Uint8Array): boolean => {
        if (!room.host || room.host.readyState !== WebSocket.OPEN) return false;
        if (trafficMeter) {
          const result = trafficMeter.charge(
            memberId,
            connectionId,
            bytes.byteLength,
          );
          if (result !== "allowed") {
            trafficFailure =
              result === "ledger-unavailable" ? result : "limited";
            return false;
          }
        }
        room.bytes += bytes.byteLength;
        room.host.send(encodeClientId(clientId, bytes));
        return true;
      };
      const forwardedHeaders = new Headers(req.headers);
      const connectionTokens = (forwardedHeaders.get("connection") ?? "")
        .split(",")
        .map((token) => token.trim().toLowerCase())
        .filter((token) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token));
      for (const name of [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        ...connectionTokens,
      ]) {
        forwardedHeaders.delete(name);
      }
      // 출처: #39024 — 허용된 회원 채팅 API 2경로(/v1/chat/events,
      // /v1/prompt/stream)는 회원 게이트가 소비한 Authorization 을 지우지
      // 않고 그대로 전달한다(회원 Nexus 의 checkAuth/SSE 구독이 원본 bearer
      // 를 다시 검증한다). 그 외 경로는 이전과 같이 지워 앱 백엔드로의
      // bearer 재생을 막는다.
      const bareChatApiRoute =
        bareNexusRoute &&
        (barePath === "/v1/chat/events" || barePath === "/v1/prompt/stream");
      if (
        memberGate.consumed.some(
          (credential) => credential.source === "authorization",
        ) &&
        !bareChatApiRoute
      )
        forwardedHeaders.delete("authorization");
      const relayProtocols = new Set(
        memberGate.consumed
          .filter((credential) => credential.source === "protocol")
          .map((credential) => credential.token),
      );
      if (relayProtocols.size) {
        const appProtocols = (
          forwardedHeaders.get("sec-websocket-protocol") ?? ""
        )
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value && !relayProtocols.has(value));
        if (appProtocols.length)
          forwardedHeaders.set(
            "sec-websocket-protocol",
            appProtocols.join(", "),
          );
        else forwardedHeaders.delete("sec-websocket-protocol");
      }
      // An anonymous read consumes no member credential, so the consumed-only
      // stripping above cannot protect it. Never deliver audience credentials
      // (including cookies or protocol tokens) to a public application's host.
      if (anonymousPublicRead || anonymousVisitorWrite) {
        for (const name of [
          "authorization",
          "cookie",
          "sec-websocket-protocol",
        ])
          forwardedHeaders.delete(name);
      }
      forwardedHeaders.set("host", internalHost);
      const requestOrigin = forwardedHeaders.get("origin");
      if (requestOrigin) {
        try {
          const parsedOrigin = new URL(requestOrigin);
          if (
            requestOrigin === parsedOrigin.origin &&
            parsedOrigin.origin === `https://${publicHost}`
          )
            forwardedHeaders.set("origin", `http://${internalHost}`);
        } catch {
          /* preserve malformed origins so the app-host rejects them */
        }
      }
      const opened = encoder.encode({
        streamId: 1,
        kind: "open",
        protocol: "http",
        method: req.method,
        path: `${new URL(req.url).pathname}${new URL(req.url).search}`,
        headers: Object.fromEntries(forwardedHeaders.entries()),
      });
      if (!opened.ok || !send(phone.phonePublicKey)) {
        clearTimeout(pending.timer);
        room.publicRequests.delete(clientId);
        releaseSlot();
        return new Response(
          trafficFailure === "limited" ? "Traffic limited" : "Bad gateway",
          {
            status:
              trafficFailure === "limited" ? 429 : trafficFailure ? 503 : 502,
          },
        );
      }
      const sendFrame = (
        frame: Parameters<typeof encoder.encode>[0],
      ): boolean => {
        const encoded = encoder.encode(frame);
        if (!encoded.ok) return false;
        const sealed = phone.channel.seal(encoded.value);
        return sealed.ok && send(sealed.value);
      };
      const sealedOpen = phone.channel.seal(opened.value);
      if (
        !sealedOpen.ok ||
        !send(sealedOpen.value) ||
        (body.byteLength > 0 &&
          !sendFrame({ streamId: 1, kind: "data", data: body })) ||
        !sendFrame({ streamId: 1, kind: "end" })
      ) {
        clearTimeout(pending.timer);
        room.publicRequests.delete(clientId);
        releaseSlot();
        sendControl(room.host, { type: "client-disconnected", clientId });
        return new Response(
          trafficFailure === "limited" ? "Traffic limited" : "Bad gateway",
          {
            status:
              trafficFailure === "limited" ? 429 : trafficFailure ? 503 : 502,
          },
        );
      }
      return response;
    } catch {
      releaseSlot();
      return new Response("Bad gateway", { status: 502 });
    }
  };
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: MAX_MUX_FRAME_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url);
      const isWebSocket =
        req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (options.publicDomain && !isWebSocket) return publicFetch(req);
      if (url.pathname !== "/host" && url.pathname !== "/client") {
        return new Response("not found", { status: 404 });
      }
      const serverId = url.searchParams.get("serverId");
      if (!serverId || !/^[a-f0-9]{64}$/.test(serverId))
        return new Response("invalid serverId", { status: 400 });
      if (!trustedHostKeys.has(serverId))
        return new Response("unknown serverId", { status: 403 });
      const memberGate = await memberAuthorized(req, serverId);
      // (출처: #39104) 회원 서버 역할 서비스 토큰(ems_) — host 연결 심사용
      // 단일 시크릿을 상수시간 대조로만 인정한다. 이 자격은 회원 신원
      // (data.memberId)을 주지 않는다: «아무 회원의 핸들 핀 불리언 읽기»만
      // 넓어지고 public-handle-pin 쓰기는 emt_ 소유자 대조를 그대로 지나야
      // 한다. 공개 HTTP 회원 경로에는 효력이 없다(protocol 헤더 · host WS 만).
      const serviceCredentialToken =
        url.pathname === "/host" ? memberServiceCredential(req) : undefined;
      const memberServiceAuthorized =
        serviceCredentialToken !== undefined &&
        options.memberServiceToken !== undefined &&
        constantTimeTokenEqual(
          serviceCredentialToken,
          options.memberServiceToken,
        );
      // (출처: #106092) ⓑ — 결속 키는 ems_ 서비스 연결로만: 서비스 자격 없는
      // 연결(유효한 emt_ 포함)은 일반 호스트 슬롯으로도 fail-closed(403·4401).
      const memberServiceBound =
        memberServiceServerIds?.has(serverId) === true;
      if (memberServiceBound && !memberServiceAuthorized) {
        debug.log("relay.auth", "member-service-bound", {
          serverId,
          route: url.pathname,
        });
        if (!isWebSocket)
          return new Response("member service required", { status: 403 });
      }
      if (memberGate.status !== "allowed" && !memberServiceAuthorized) {
        debug.log("relay.auth", "member-denied", {
          serverId,
          route: url.pathname,
        });
        // (출처: #39104) ⓑ1 수리 — WS 업그레이드 요청은 HTTP 401 대신
        // 업그레이드를 완료해 open() 에서 닫힘 코드 401 로 끊는다
        // (클라이언트가 «회원 게이트 401» 을 WS 닫힘 코드로 관측 —
        // fail-closed). HTTP(비-WS) 요청은 기존 그대로 401/429 본문.
        if (!isWebSocket)
          return new Response(
            memberGate.status === "busy" ? "busy" : "unauthorized",
            { status: memberGate.status === "busy" ? 429 : 401 },
          );
      }
      if (!isWebSocket)
        return new Response("upgrade required", { status: 426 });
      const role = url.pathname === "/host" ? "host" : "client";
      const now = Date.now();
      if (
        !server.upgrade(req, {
          data: {
            role,
            serverId,
            authenticated: false,
            lastSeen: now,
            tokens: BURST_BYTES,
            refillAt: now,
            memberId:
              options.memberRequired && memberGate.status === "allowed"
                ? // (출처: #39104) emt_ 소유자 자격이 소비된 연결만 회원 신원을
                  // 가진다 — 서비스(ems_) 단독 연결은 신원 없음(쓰기 0).
                  hostOwnerMemberIds!.get(serverId)
                : undefined,
            // (출처: #39104) 회원 서버 서비스 자격 — 핀 읽기 게이트만 읽는다.
            memberService: memberServiceAuthorized || undefined,
            // (출처: #106092) ⓑ — 결속 키로 온 연결 표식(ems_ 없으면 open() 4401).
            memberServiceBound: memberServiceBound || undefined,
            connectionId: randomUUID(),
          },
        })
      ) {
        return new Response("upgrade required", { status: 426 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES + 4,
      open(ws) {
        sockets.add(ws);
        const data = ws.data;
        // (출처: #39104) ⓑ1 수리 — 회원 게이트가 거부한 WS 연결(emt_·ems_
        // 모두 없음)은 업그레이드 완료 후 닫힘 코드 4401 로 끊는다(시험③
        // fail-closed 관측 · OP 마지막 1줄 401→4401). 게이트를 통과한 연결만
        // memberId 또는 memberService 를 가지므로 아래 조건은 «거부된
        // 연결»과 정확히 일치한다(busy 포함 → 401).
        // (출처: #106092) ⓑ — 결속 키는 ems_ 없으면 memberRequired 무관 4401.
        if (
          (options.memberRequired &&
            data.memberId === undefined &&
            data.memberService !== true) ||
          (data.memberServiceBound === true && data.memberService !== true)
        ) {
          ws.close(4401, "unauthorized");
          return;
        }
        const room = roomFor(data.serverId);
        if (data.role === "host") {
          // (출처: #39104) ⓑ1 수리 — 서비스 자격(ems_) 연결은 호스트 키
          // 연결 경로에서 분리한다: duplicate-host 검사·퇴거 대상이
          // 아니고 room.host 슬롯도 차지하지 않는다(auth 성공 시 아래
          // message() 에서 room.services 로 등록된다).
          if (!data.memberService && room.host) {
            fail(room, "duplicate-host");
            ws.close(1008, "host already connected");
            return;
          }
          data.challenge = randomBytes(32).toString("base64url");
          sendControl(ws, { type: "challenge", nonce: data.challenge });
        } else {
          if (!room.host || room.clients.size >= MAX_CLIENTS_PER_SERVER) {
            fail(room, !room.host ? "host-offline" : "client-limit");
            ws.close(
              1008,
              !room.host ? "host offline" : "client limit reached",
            );
            return;
          }
          const id = room.nextId++;
          data.clientId = id;
          data.authenticated = true;
          room.clients.set(id, ws);
          sendControl(ws, { type: "connected", clientId: id });
          sendControl(room.host, { type: "client-connected", clientId: id });
        }
        if (!data.authenticated)
          data.authTimer = setTimeout(
            () => ws.close(1008, "authentication timeout"),
            AUTH_TIMEOUT_MS,
          );
      },
      message(ws, message) {
        const data = ws.data;
        const room = rooms.get(data.serverId);
        if (!room) {
          ws.close(1008, "room missing");
          return;
        }
        data.lastSeen = Date.now();
        if (!data.authenticated) {
          if (data.role !== "host" || typeof message !== "string") {
            fail(room, "invalid-auth");
            ws.close(1008, "authentication required");
            return;
          }
          let auth: unknown;
          try {
            auth = JSON.parse(message);
          } catch {
            /* reject below */
          }
          const value = auth as
            | { type?: unknown; publicKey?: unknown; signature?: unknown }
            | undefined;
          const key =
            typeof value?.publicKey === "string"
              ? decodeKey(value.publicKey)
              : undefined;
          const signature =
            typeof value?.signature === "string" &&
            /^[A-Za-z0-9_-]{86}$/.test(value.signature)
              ? Buffer.from(value.signature, "base64url")
              : undefined;
          const expected = trustedHostKeys.get(data.serverId);
          let valid = false;
          if (
            value?.type === "auth" &&
            key &&
            signature?.length === 64 &&
            data.challenge &&
            value.publicKey === expected
          ) {
            try {
              valid = verify(
                null,
                challengeMessage(data.serverId, data.challenge),
                createPublicKey({
                  key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
                  format: "der",
                  type: "spki",
                }),
                signature,
              );
            } catch {
              /* invalid public key */
            }
          }
          // (출처: #39104) ⓑ1 수리 — 서비스 자격(ems_) 연결은 호스트 슬롯
          // 경쟁자가 아니므로 «이미 다른 호스트가 슬롯에 있다»는 사실만으로
          // auth 를 끊지 않는다(서명 검증 자체는 그대로 엄격하다).
          if (
            !valid ||
            (!data.memberService && room.host && room.host !== ws)
          ) {
            fail(room, "invalid-auth");
            ws.close(1008, "invalid host signature");
            return;
          }
          data.authenticated = true;
          data.challenge = undefined;
          if (data.authTimer) clearTimeout(data.authTimer);
          if (data.memberService) {
            // (출처: #39104) ⓑ1 수리 — auth 성공한 서비스 연결은
            // room.host 가 아니라 room.services 에 등록한다. host 슬롯과
            // hostPublicKey 는 전혀 건드리지 않는다(덮어쓰기 방어).
            room.services.add(ws);
          } else {
            room.host = ws;
            room.hostPublicKey = undefined;
          }
          sendControl(
            ws,
            options.publicDomain
              ? { type: "authenticated", capabilities: ["public-http-v1"] }
              : { type: "authenticated" },
          );
          return;
        }
        if (typeof message === "string") {
          // (출처: #39104) ⓑ1 수리 — app-control 프레임은 공개 도메인 relay
          // 뿐 아니라 앱 등록·핀 원장(autoAppRegistration)을 운영하는 relay
          // 에서도 유효하다. #39104 실경로 시험은 publicDomain 없이
          // host WS 챌린지·서명만으로 질의·쓰기를 왕복한다.
          if (
            data.role === "host" &&
            (options.publicDomain || options.autoAppRegistration)
          ) {
            if (message.length > 4_096) {
              ws.close(1009, "host control too large");
              return;
            }
            let value: {
              type?: unknown;
              publicKey?: unknown;
              requestId?: unknown;
              registration?: unknown;
            };
            try {
              value = JSON.parse(message) as typeof value;
            } catch {
              value = {};
            }
            const publicKey =
              typeof value.publicKey === "string"
                ? decodeKey(value.publicKey)
                : undefined;
            // (출처: #39104) ⓑ1 수리 — 서비스 자격(ems_) 연결 전용 app-control
            // 분기: 서비스 연결은 room.host 슬롯이 아니므로 아래 일반 호스트
            // 분기들(room.host === ws)에 들어갈 수 없다. public-handle-pin-query
            // 만 queryHandlePinByMember(회원별 원장 읽기)로 회답하고,
            // public-handle-pin · public-app-register/unregister 등 그 밖의
            // 프레임은 전부 rejected 로 돌려보낸다(서비스 자격 쓰기 0).
            // host-public-key 프레임은 무시한다(회신 없음) — 서비스 연결의
            // room.hostPublicKey 덮어쓰기 방어.
            if (data.memberService === true) {
              if (value.type === "host-public-key") return;
              if (
                options.autoAppRegistration?.queryHandlePinByMember &&
                typeof value.requestId === "string" &&
                /^[a-f0-9-]{36}$/.test(value.requestId) &&
                value.type === "public-handle-pin-query" &&
                value.registration &&
                typeof (value.registration as { user?: unknown }).user ===
                  "string" &&
                typeof (value.registration as { memberId?: unknown }).memberId ===
                  "string"
              ) {
                void Promise.resolve()
                  .then(() =>
                    options.autoAppRegistration!.queryHandlePinByMember!(
                      value.registration as { user: string; memberId: string },
                    ),
                  )
                  .then(
                    (pinned) => {
                      sendControl(ws, {
                        type: "public-app-accepted",
                        requestId: value.requestId,
                        // (출처: #39104) 회답은 불리언 하나만 나간다.
                        result: pinned === true,
                      });
                    },
                    () => {
                      sendControl(ws, {
                        type: "public-app-rejected",
                        requestId: value.requestId,
                      });
                    },
                  );
                return;
              }
              // (출처: #39104) 그 밖의 서비스 프레임 — 쓰기 전부 rejected.
              if (
                typeof value.requestId === "string" &&
                /^[a-f0-9-]{36}$/.test(value.requestId)
              ) {
                sendControl(ws, {
                  type: "public-app-rejected",
                  requestId: value.requestId,
                });
                return;
              }
              fail(room, "plaintext-data");
              ws.close(1003, "binary ciphertext required");
              return;
            }
            if (
              value.type === "host-public-key" &&
              publicKey &&
              serverIdFromPublicKey(publicKey) === data.serverId
            ) {
              room.hostPublicKey = publicKey;
              sendControl(ws, { type: "host-public-key-accepted" });
              return;
            }
            if (
              options.autoAppRegistration &&
              room.host === ws &&
              room.hostPublicKey &&
              typeof value.requestId === "string" &&
              /^[a-f0-9-]{36}$/.test(value.requestId) &&
              (value.type === "public-app-register" ||
                value.type === "public-app-unregister")
            ) {
              const ownerId = hostOwnerMemberIds?.get(data.serverId);
              if (!ownerId || data.memberId !== ownerId) {
                sendControl(ws, {
                  type: "public-app-rejected",
                  requestId: value.requestId,
                });
                return;
              }
              void Promise.resolve()
                .then(() =>
                  value.type === "public-app-register"
                    ? options.autoAppRegistration!.register(
                        data.serverId,
                        ownerId,
                        value.registration as AutoPublicAppRegistration,
                      )
                    : options.autoAppRegistration!.unregister(
                        data.serverId,
                        ownerId,
                        value.registration as Pick<
                          AutoPublicAppRegistration,
                          "user" | "app" | "deploymentId" | "grantId"
                        >,
                      ),
                )
                .then(
                  () => {
                    sendControl(ws, {
                      type: "public-app-accepted",
                      requestId: value.requestId,
                    });
                  },
                  () => {
                    sendControl(ws, {
                      type: "public-app-rejected",
                      requestId: value.requestId,
                    });
                  },
                );
              return;
            }
          // OP #105017 ⓐ①③ — 회원 서버의 «핀 읽기» 질의. 서비스 자격은 핀
          // 쓰기와 같은 신뢰 채널(host 챌린지 서명 + emt_ 회원 토큰 →
          // data.memberId)이고, 응답은 «핸들 H · 회원 M · 지금 살아 있는 인증
          // 호스트 핀» 불리언만 나간다. 위조(memberId ≠ owner)·남의 핸들은
          // 거부되고, 회원 서버는 거부를 false 로 해석한다(fail-closed ②).
          if (
            options.autoAppRegistration?.queryHandlePin &&
            room.host === ws &&
            // (출처: #39104) ⓑ1 수리 — 질의 회답은 불리언 하나뿐인 제어면
            // 읽기다: hostPublicKey 전제를 떼고 호스트 슬롯 인증
            // (room.host === ws)을 자격으로 삼는다. 시험②·실경로는
            // host-public-key 프레임 없이 rejected/accepted 를 기대한다.
            typeof value.requestId === "string" &&
            /^[a-f0-9-]{36}$/.test(value.requestId) &&
            value.type === "public-handle-pin-query" &&
            value.registration &&
            typeof (value.registration as { user?: unknown }).user ===
              "string" &&
            typeof (value.registration as { memberId?: unknown }).memberId ===
              "string"
          ) {
            const ownerId = hostOwnerMemberIds?.get(data.serverId);
            const claimedMemberId = (
              value.registration as { memberId: string }
            ).memberId;
            if (
              !ownerId ||
              data.memberId !== ownerId ||
              claimedMemberId !== ownerId
            ) {
              sendControl(ws, {
                type: "public-app-rejected",
                requestId: value.requestId,
              });
              return;
            }
            void Promise.resolve()
              .then(() =>
                options.autoAppRegistration!.queryHandlePin!(
                  data.serverId,
                  ownerId,
                  value.registration as { user: string; memberId: string },
                ),
              )
              .then(
                (pinned) => {
                  sendControl(ws, {
                    type: "public-app-accepted",
                    requestId: value.requestId,
                    // OP #105017 ① — 불리언만 내려보낸다.
                    result: pinned === true,
                  });
                },
                () => {
                  sendControl(ws, {
                    type: "public-app-rejected",
                    requestId: value.requestId,
                  });
                },
              );
            return;
          }
          if (
            options.autoAppRegistration?.pinHandle &&
              room.host === ws &&
              // (출처: #39104) ⓑ1 수리 — 핀 쓰기 자격도 호스트 슬롯 인증
              // (room.host === ws + emt_ 소유자 대조)으로 충분하다.
              // hostPublicKey 전제를 유지하면 host-public-key 프레임 없는
              // 실경로 호스트의 쓰기가 전부 잘려 나간다(시험①②).
              typeof value.requestId === "string" &&
              /^[a-f0-9-]{36}$/.test(value.requestId) &&
              value.type === "public-handle-pin" &&
              value.registration &&
              typeof (value.registration as { user?: unknown }).user ===
                "string" &&
              typeof (value.registration as { memberId?: unknown }).memberId ===
                "string"
            ) {
              const ownerId = hostOwnerMemberIds?.get(data.serverId);
              const claimedMemberId = (
                value.registration as {
                  memberId: string;
                }
              ).memberId;
              if (
                !ownerId ||
                data.memberId !== ownerId ||
                claimedMemberId !== ownerId
              ) {
                sendControl(ws, {
                  type: "public-app-rejected",
                  requestId: value.requestId,
                });
                return;
              }
              void Promise.resolve()
                .then(() =>
                  options.autoAppRegistration!.pinHandle!(
                    data.serverId,
                    ownerId,
                    value.registration as { user: string; memberId: string },
                  ),
                )
                .then(
                  () => {
                    sendControl(ws, {
                      type: "public-app-accepted",
                      requestId: value.requestId,
                    });
                  },
                  () => {
                    sendControl(ws, {
                      type: "public-app-rejected",
                      requestId: value.requestId,
                    });
                  },
                );
              return;
            }
          }
          fail(room, "plaintext-data");
          ws.close(1003, "binary ciphertext required");
          return;
        }
        const bytes = new Uint8Array(message);
        if (
          bytes.length > MAX_FRAME_BYTES + (data.role === "host" ? 4 : 0) ||
          bytes.length < (data.role === "host" ? 5 : 1)
        ) {
          fail(room, "invalid-frame");
          ws.close(1009, "invalid frame size");
          return;
        }
        if (!capacity(ws, bytes.length)) {
          fail(room, "rate-limit");
          ws.close(1008, "rate limit exceeded");
          return;
        }
        if (data.role === "client") {
          if (!room.host || data.clientId === undefined) {
            ws.close(1012, "host offline");
            return;
          }
          const traffic = trafficMeter?.charge(
            data.memberId,
            data.connectionId,
            bytes.length,
          );
          if (traffic && traffic !== "allowed") {
            fail(
              room,
              traffic === "ledger-unavailable"
                ? "traffic-ledger"
                : "traffic-cap",
            );
            ws.close(
              traffic === "ledger-unavailable" ? 1011 : 1008,
              traffic === "ledger-unavailable"
                ? "usage ledger unavailable"
                : "traffic limited",
            );
            return;
          }
          room.bytes += bytes.length;
          room.host.send(encodeClientId(data.clientId, bytes));
        } else {
          if (room.host !== ws) {
            ws.close(1008, "host replaced");
            return;
          }
          const clientId = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            4,
          ).getUint32(0, false);
          const client = room.clients.get(clientId);
          const pending = room.publicRequests.get(clientId);
          if (!client && !pending) {
            fail(room, "unknown-client");
            return;
          }
          const traffic = trafficMeter?.charge(
            client ? client.data.memberId : pending?.memberId,
            client ? client.data.connectionId : (pending?.connectionId ?? ""),
            bytes.length - 4,
            "egress",
          );
          if (traffic && traffic !== "allowed") {
            fail(
              room,
              traffic === "ledger-unavailable"
                ? "traffic-ledger"
                : "traffic-cap",
            );
            if (pending) {
              clearTimeout(pending.timer);
              room.publicRequests.delete(clientId);
              pending.releaseSlot();
              pending.resolve(
                new Response(
                  traffic === "ledger-unavailable"
                    ? "Bad gateway"
                    : "Traffic limited",
                  { status: traffic === "ledger-unavailable" ? 503 : 429 },
                ),
              );
            } else
              client?.close(
                traffic === "ledger-unavailable" ? 1011 : 1008,
                traffic === "ledger-unavailable"
                  ? "usage ledger unavailable"
                  : "traffic limited",
              );
            return;
          }
          room.bytes += bytes.length - 4;
          if (client) {
            client.send(bytes.subarray(4));
            return;
          }
          if (!pending) return;
          const opened = pending.channel.open(bytes.subarray(4));
          if (!opened.ok) {
            clearTimeout(pending.timer);
            room.publicRequests.delete(clientId);
            pending.releaseSlot();
            pending.resolve(new Response("Bad gateway", { status: 502 }));
            return;
          }
          const decoded = pending.decoder.decode(opened.value);
          if (!decoded.ok) {
            clearTimeout(pending.timer);
            room.publicRequests.delete(clientId);
            pending.releaseSlot();
            pending.resolve(new Response("Bad gateway", { status: 502 }));
            return;
          }
          if (decoded.value.kind === "data") {
            let parsed: unknown;
            try {
              parsed = JSON.parse(
                new TextDecoder().decode(decoded.value.data),
              );
            } catch {
              clearTimeout(pending.timer);
              room.publicRequests.delete(clientId);
              pending.releaseSlot();
              pending.resolve(new Response("Bad gateway", { status: 502 }));
              return;
            }
            if (
              parsed &&
              typeof parsed === "object" &&
              "chunk" in parsed &&
              typeof (parsed as { chunk?: unknown }).chunk === "string"
            ) {
              // 출처: #39009 — 스트리밍 chunk 프레임: scaffold 바디에 도착
              // 순서대로 base64 디코드해 이어 붙인다.
              if (pending.streamController) {
                pending.streamController.enqueue(
                  new Uint8Array(
                    Buffer.from((parsed as { chunk: string }).chunk, "base64"),
                  ),
                );
              }
              return;
            }
            pending.response = parsed as PublicResponse;
            if (pending.response && pending.response.stream) {
              // 출처: #39009 — 헤더-only `stream:true` envelope: scaffold
              // Response 로 지금 바로 조기 resolve 하되, pending 은 뒤따르는
              // `{chunk}`/close 프레임을 받기 위해 등록 상태로 남긴다.
              const scaffold = responseFromPublicEnvelope(
                pending.response,
                pending.publicHost,
                pending.internalHost,
                pending,
              );
              if (pending.streamController) {
                clearTimeout(pending.timer);
                pending.resolve(scaffold);
                return;
              }
              // 출처: #39009 — scaffold 를 못 만든 잘못된 envelope — 기존 502 정리.
              clearTimeout(pending.timer);
              room.publicRequests.delete(clientId);
              pending.releaseSlot();
              pending.resolve(scaffold);
              return;
            }
          } else if (decoded.value.kind === "close") {
            clearTimeout(pending.timer);
            room.publicRequests.delete(clientId);
            pending.releaseSlot();
            if (pending.streamController) {
              // 출처: #39009 — 스트리밍 응답 종료: scaffold 바디에 EOF 를
              // 보내 소비자 fetch 가 정상 끝맺음을 읽게 한다.
              try {
                pending.streamController.close();
              } catch {
                // 이미 닫혔으면 무시한다.
              }
            }
            pending.resolve(
              responseFromPublicEnvelope(
                pending.response,
                pending.publicHost,
                pending.internalHost,
              ),
            );
            sendControl(ws, { type: "client-disconnected", clientId });
          }
        }
      },
      pong(ws) {
        ws.data.lastSeen = Date.now();
      },
      close(ws) {
        drop(ws);
      },
    },
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (Date.now() - ws.data.lastSeen > DEAD_PEER_MS)
        ws.close(1001, "heartbeat timeout");
      else ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();
  return {
    server,
    reloadPublicPolicySnapshot,
    get port() {
      return server.port;
    },
    stats(serverId: string) {
      const room = rooms.get(serverId);
      return room
        ? {
            host: !!room.host,
            clients: room.clients.size,
            publicRequests: room.publicRequests.size,
            publicSlots: room.publicSlots,
            bytes: room.bytes,
            failures: { ...room.failures },
          }
        : {
            host: false,
            clients: 0,
            publicRequests: 0,
            publicSlots: 0,
            bytes: 0,
            failures: {} as Record<string, number>,
          };
    },
    trafficUsage(memberId: string): RelayTrafficUsage | undefined {
      return trafficMeter?.usage(memberId);
    },
    stop() {
      clearInterval(heartbeat);
      for (const ws of sockets) ws.close(1001, "relay stopping");
      for (const room of rooms.values()) {
        for (const pending of room.publicRequests.values()) {
          clearTimeout(pending.timer);
          pending.releaseSlot();
          pending.resolve(new Response("Relay stopping", { status: 503 }));
        }
        room.publicRequests.clear();
      }
      server.stop(true);
      options.trafficStore?.close?.();
      options.appKillSwitch?.close?.();
      options.publicVisitorWriteLedger?.close();
    },
  };
}
