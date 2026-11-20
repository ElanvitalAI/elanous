import { createHash } from "node:crypto";
import { debug } from "../debug/log.js";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildPublicDispatchRoutes,
  loadPublicDispatchRoutes,
  type PublicDispatchRoute,
} from "./public-dispatch.js";
import { loadPublicAppReadConfig } from "./public-app-read.js";
import {
  loadPublicAppVisitorWriteConfig,
  validateVisitorWritePolicy,
  type PublicAppVisitorWritePolicy,
} from "./public-app-visitor-write.js";

/** A complete candidate is checked before the running relay swaps any policy. */
export interface RelayPublicPolicySnapshot {
  readonly trustedHostKeys: ReadonlyMap<string, string>;
  readonly hostOwnerMemberIds: ReadonlyMap<string, string>;
  readonly publicDispatchRoutes: ReadonlyMap<string, PublicDispatchRoute>;
  readonly publicReadableApps: ReadonlySet<string>;
  /** Request-time expiry remains effective even if a later file reload fails. */
  readonly publicReadExpiresAt?: ReadonlyMap<string, number>;
  /** handle -> owning member id; unset claims reject auto pins (fail-closed). */
  readonly publicHandleClaimOwners?: ReadonlyMap<string, string>;
  /** (출처: #106092) ⓑ — member-service 결속 키 집합(회원 서버 역할). owner
   * 없이 정책이 유효하고, ems_ 없는 연결은 일반 호스트 슬롯으로도 fail-closed. */
  readonly memberServiceServerIds?: ReadonlySet<string>;
  readonly publicVisitorWritePolicies: readonly PublicAppVisitorWritePolicy[];
}

export interface RelayPublicPolicyFiles {
  readonly trustedHostKeys: string;
  readonly hostOwnerMembers: string;
  readonly publicDispatch: string;
  readonly publicRead: string;
  /** (출처: #106092) ⓑ — 선택 결속 파일(JSON serverId→true). 등재 키는
   * trustedHostKeys 필수이며 owner 결속이 있으면 로드가 거부된다. */
  readonly memberServiceHosts?: string;
  readonly visitorWrite?: string;
  readonly publicHandleClaims?: string;
  readonly autoRegistrations?: string;
}

export interface AutoPublicAppRegistration {
  readonly ownerId: string;
  readonly serverId: string;
  readonly user: string;
  readonly app: string;
  readonly deploymentId: string;
  readonly grantId: string;
  readonly expiresAt: string;
}

/** A durable handle claim: routes one public user label to one authenticated host. */
export interface AutoPublicHandlePin {
  readonly ownerId: string;
  readonly serverId: string;
  readonly user: string;
}

function validHandlePin(value: unknown): AutoPublicHandlePin {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid auto public handle pin");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "ownerId,serverId,user")
    throw new Error("invalid auto public handle pin");
  if (
    typeof row.ownerId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.ownerId) ||
    typeof row.serverId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.serverId) ||
    typeof row.user !== "string" ||
    !validPublicUserLabel(row.user)
  ) {
    throw new Error("invalid auto public handle pin");
  }
  return { ownerId: row.ownerId, serverId: row.serverId, user: row.user };
}

function validPublicUserLabel(user: string): boolean {
  return (
    user.length >= 3 &&
    user.length <= 20 &&
    !user.includes("--") &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(user)
  );
}

function validRegistration(
  value: unknown,
  now: number,
): AutoPublicAppRegistration | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid auto public registration");
  const row = value as Record<string, unknown>;
  const fields = Object.keys(row).sort().join();
  if (fields !== "app,deploymentId,expiresAt,grantId,ownerId,serverId,user") {
    throw new Error("invalid auto public registration");
  }
  if (
    typeof row.ownerId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.ownerId) ||
    typeof row.serverId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.serverId) ||
    typeof row.user !== "string" ||
    typeof row.app !== "string" ||
    !validPublicPair(row.user, row.app, "elanous.app") ||
    typeof row.deploymentId !== "string" ||
    !/^dyn-[0-9a-f-]{36}$/.test(row.deploymentId) ||
    typeof row.grantId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.grantId) ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    Date.parse(row.expiresAt) > now + 24 * 60 * 60 * 1000
  ) {
    throw new Error("invalid auto public registration");
  }
  if (Date.parse(row.expiresAt) <= now) return null;
  return row as unknown as AutoPublicAppRegistration;
}

export function loadAutoPublicAppRegistrations(
  path: string,
  now = Date.now(),
): readonly AutoPublicAppRegistration[] {
  return loadAutoPublicAppStore(path, now).apps;
}

/** The auto registration store keeps app grants and durable handle pins in one owner-only file. */
export function loadAutoPublicAppStore(
  path: string,
  now = Date.now(),
): {
  apps: readonly AutoPublicAppRegistration[];
  pins: readonly AutoPublicHandlePin[];
} {
  assertNoPendingUpdate(path);
  return parseAutoPublicAppStore(privateFile(path).raw, now);
}

function parseAutoPublicAppStore(
  raw: Buffer,
  now: number,
): {
  apps: readonly AutoPublicAppRegistration[];
  pins: readonly AutoPublicHandlePin[];
} {
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["apps", "apps,pins"].includes(Object.keys(value).sort().join()) ||
    !Array.isArray((value as { apps?: unknown }).apps) ||
    ((value as { pins?: unknown }).pins !== undefined &&
      !Array.isArray((value as { pins?: unknown }).pins))
  ) {
    throw new Error("invalid auto public registration file");
  }
  const apps = (value as { apps: unknown[] }).apps
    .map((item) => validRegistration(item, now))
    .filter((item): item is AutoPublicAppRegistration => item !== null);
  const pins = ((value as { pins?: unknown[] }).pins ?? []).map((item) =>
    validHandlePin(item),
  );
  if (
    new Set(apps.map((item) => item.user + "/" + item.app)).size !== apps.length
  ) {
    throw new Error("duplicate auto public registration");
  }
  if (
    new Set(pins.map((item) => item.user)).size !== pins.length ||
    new Set(pins.map((item) => item.serverId)).size !== pins.length
  ) {
    throw new Error("duplicate auto public handle pin");
  }
  return { apps, pins };
}

function parseAutoPublicAppRegistrations(
  raw: Buffer,
  now: number,
): readonly AutoPublicAppRegistration[] {
  return parseAutoPublicAppStore(raw, now).apps;
}

function withRegistrations(
  staticPolicy: RelayPublicPolicySnapshot,
  apps: readonly AutoPublicAppRegistration[],
  domain: "elanous.app" | "elanous.ai",
  now: number,
  pins: readonly AutoPublicHandlePin[] = [],
): RelayPublicPolicySnapshot {
  const routes = new Map(staticPolicy.publicDispatchRoutes);
  const reads = new Set(staticPolicy.publicReadableApps);
  const readExpiresAt = new Map(staticPolicy.publicReadExpiresAt);
  const writes = [...staticPolicy.publicVisitorWritePolicies];
  for (const pin of pins) {
    // An automatic pin can only add a route the operator has not pinned, and
    // never a second route for a server that already carries one.
    if (
      routes.has(pin.user) ||
      !staticPolicy.trustedHostKeys.has(pin.serverId) ||
      staticPolicy.hostOwnerMemberIds.get(pin.serverId) !== pin.ownerId
    )
      continue;
    if ([...routes.values()].some((route) => route.serverId === pin.serverId))
      continue;
    routes.set(pin.user, {
      serverId: pin.serverId,
      ownerMemberId: pin.ownerId,
    });
    // A pinned handle routes the member's own home app for anonymous reads.
    // Every other app still needs a static operator route to register.
    if (!staticPolicy.publicReadableApps.has(pin.user + "/home"))
      reads.add(pin.user + "/home");
  }
  for (const app of apps) {
    const existing = routes.get(app.user);
    // A completed operator pin removal overrides a still-stored app grant.
    // The sweep then removes its orphan record from the owner-only file.
    if (
      !staticPolicy.trustedHostKeys.has(app.serverId) ||
      !existing ||
      staticPolicy.hostOwnerMemberIds.get(app.serverId) !== app.ownerId ||
      existing.serverId !== app.serverId ||
      existing.ownerMemberId !== app.ownerId
    )
      continue;
    const key = app.user + "/" + app.app;
    // A static public-read decision keeps its own lifetime. An unrelated
    // automatic grant cannot shorten or extend the operator's static policy.
    if (!staticPolicy.publicReadableApps.has(key)) {
      reads.add(key);
      readExpiresAt.set(key, Date.parse(app.expiresAt));
    }
  }
  return validatedRelayPublicPolicySnapshot(
    {
      ...staticPolicy,
      publicDispatchRoutes: routes,
      publicReadableApps: reads,
      publicReadExpiresAt: readExpiresAt,
      publicVisitorWritePolicies: writes,
    },
    domain,
    now,
  );
}

function assertNoPendingUpdate(path: string): void {
  try {
    lstatSync(path + ".pending");
    throw new Error("auto registration update requires recovery");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function pendingRecoveryRaw(marker: string, now: number): Buffer {
  const raw = privateFile(marker, 128 * 1024).raw;
  // A marker written by the first file format has no prior image. Retire all
  // automatic reads instead of guessing which unacknowledged row was live.
  if (raw.equals(Buffer.from("pending\n"))) return Buffer.from('{"apps":[]}\n');
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "raw,version" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { raw?: unknown }).raw !== "string"
  ) {
    throw new Error("invalid auto registration recovery marker");
  }
  const encoded = (value as { raw: string }).raw;
  const recovered = Buffer.from(encoded, "base64");
  if (
    recovered.length > 64 * 1024 ||
    recovered.toString("base64") !== encoded
  ) {
    throw new Error("invalid auto registration recovery image");
  }
  parseAutoPublicAppRegistrations(recovered, now);
  return recovered;
}

function recoverPendingUpdate(
  path: string,
  syncDirectory: (fd: number) => void = fsyncSync,
  applyRecovered?: (raw: Buffer) => void,
  now = Date.now(),
): boolean {
  const marker = path + ".pending";
  try {
    lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const recovered = pendingRecoveryRaw(marker, now);
  const finish = atomicPrivateFile(path, recovered, syncDirectory, true);
  applyRecovered?.(recovered);
  finish();
  assertNoPendingUpdate(path);
  return true;
}

function atomicPrivateFile(
  path: string,
  raw: Buffer,
  syncDirectory: (fd: number) => void = fsyncSync,
  existingMarker = false,
  recoveryRaw?: Buffer,
): () => void {
  const parent = dirname(path);
  const marker = path + ".pending";
  const temporary = join(
    parent,
    ".auto-apps-" + process.pid + "-" + Math.random().toString(16).slice(2),
  );
  const syncParent = () => {
    const directory = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      syncDirectory(directory);
    } finally {
      closeSync(directory);
    }
  };
  // The marker is durable before rename. A persistent post-rename fsync fault
  // therefore blocks reload and restart instead of exposing an unacknowledged row.
  if (existingMarker) lstatSync(marker);
  else {
    if (!recoveryRaw || recoveryRaw.length > 64 * 1024)
      throw new Error("auto registration recovery image bound");
    const markerRaw = Buffer.from(
      JSON.stringify({ version: 1, raw: recoveryRaw.toString("base64") }) +
        "\n",
    );
    const mark = openSync(
      marker,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < markerRaw.length) {
        const wrote = writeSync(
          mark,
          markerRaw,
          offset,
          markerRaw.length - offset,
        );
        if (wrote <= 0)
          throw new Error("auto registration recovery marker write failed");
        offset += wrote;
      }
      fsyncSync(mark);
    } finally {
      closeSync(mark);
    }
  }
  let renamed = false;
  try {
    syncParent();
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < raw.length) {
        const wrote = writeSync(fd, raw, offset, raw.length - offset);
        if (wrote <= 0) throw new Error("auto registration write failed");
        offset += wrote;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    renamed = true;
    try {
      syncParent();
    } catch {
      syncParent();
    } // a transient sync fault is safe to retry
    // Keep the marker until the running snapshot has also been applied.
    return () => {
      try {
        unlinkSync(marker);
      } catch {
        return; /* stale marker fails closed */
      }
      try {
        syncParent();
      } catch {
        /* new file was already durably synced */
      }
    };
  } catch (error) {
    if (!renamed && !existingMarker) {
      try {
        unlinkSync(marker);
        syncParent();
      } catch {
        /* stale marker fails closed */
      }
    }
    // A successful rename with persistent fsync failure keeps the durable
    // marker. The caller may remove a route in memory, but cannot add one.
    throw error;
  }
}

/** An edge-local owner-only file. Its contents are never accepted from the public HTTP surface. */
export function ensureRelayAutoRegistrationFile(
  path: string,
  syncDirectory: (fd: number) => void = fsyncSync,
): void {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(dirname(path)) !== dirname(path)
  ) {
    throw new Error("auto registration path is not canonical");
  }
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o022 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw new Error("auto registration parent refused");
  recoverPendingUpdate(path, syncDirectory);
  try {
    privateFile(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, Buffer.from('{"apps":[]}\n'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Only an already authenticated host owner can add an app to its pinned handle. */
export function createRelayAutoAppRegistrar(options: {
  readonly file: string;
  readonly domain: "elanous.app" | "elanous.ai";
  readonly staticPolicy: () => RelayPublicPolicySnapshot;
  readonly apply: (candidate: RelayPublicPolicySnapshot) => void;
  readonly now?: () => number;
  readonly syncDirectory?: (fd: number) => void;
}) {
  ensureRelayAutoRegistrationFile(options.file, options.syncDirectory);
  const now = options.now ?? Date.now;
  // A broken static file must not turn exact grant retirement into a no-op.
  // Registration and the periodic sweep still require a fresh validated read.
  let lastStaticPolicy = options.staticPolicy();
  const loadRows = () => {
    recoverPendingUpdate(
      options.file,
      options.syncDirectory,
      (raw) => {
        const staticPolicy = options.staticPolicy();
        lastStaticPolicy = staticPolicy;
        const store = parseAutoPublicAppStore(raw, now());
        options.apply(
          withRegistrations(
            staticPolicy,
            store.apps,
            options.domain,
            now(),
            store.pins,
          ),
        );
      },
      now(),
    );
    return loadAutoPublicAppStore(options.file, now());
  };
  const applyRows = (
    rows: readonly AutoPublicAppRegistration[],
    retiring = false,
    pins: readonly AutoPublicHandlePin[] | undefined = undefined,
  ) => {
    let staticPolicy: RelayPublicPolicySnapshot;
    try {
      staticPolicy = options.staticPolicy();
      lastStaticPolicy = staticPolicy;
    } catch (error) {
      if (!retiring) throw error;
      staticPolicy = lastStaticPolicy;
    }
    const previous = loadRows();
    let nextPins = pins ?? previous.pins;
    const candidate = withRegistrations(
      staticPolicy,
      rows,
      options.domain,
      now(),
      nextPins,
    );
    const priorRaw = privateFile(options.file).raw;
    const nextRaw = Buffer.from(
      JSON.stringify({ apps: rows, pins: nextPins }) + "\n",
    );
    if (nextRaw.length > 64 * 1024)
      throw new Error("auto registration file bound");
    let finish: () => void;
    try {
      finish = atomicPrivateFile(
        options.file,
        nextRaw,
        options.syncDirectory,
        false,
        retiring ? nextRaw : priorRaw,
      );
    } catch (error) {
      if (retiring) options.apply(candidate); // never keep a withdrawn GET live
      throw error;
    }
    try {
      options.apply(candidate);
      finish();
    } catch (error) {
      try {
        const finishRollback = atomicPrivateFile(
          options.file,
          priorRaw,
          options.syncDirectory,
          true,
        );
        options.apply(
          withRegistrations(
            staticPolicy,
            previous.apps,
            options.domain,
            now(),
            previous.pins,
          ),
        );
        finishRollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "auto registration rollback incomplete",
        );
      }
      throw error;
    }
  };
  return {
    register(
      authenticatedServerId: string,
      authenticatedOwnerId: string,
      input: AutoPublicAppRegistration,
    ) {
      const row = validRegistration(input, now());
      if (
        !row ||
        row.serverId !== authenticatedServerId ||
        row.ownerId !== authenticatedOwnerId
      ) {
        throw new Error("auto registration authenticated binding refused");
      }
      const staticPolicy = options.staticPolicy();
      if (
        staticPolicy.hostOwnerMemberIds.get(authenticatedServerId) !==
          authenticatedOwnerId ||
        !staticPolicy.trustedHostKeys.has(authenticatedServerId) ||
        staticPolicy.publicDispatchRoutes.get(row.user)?.serverId !==
          authenticatedServerId
      ) {
        throw new Error("auto registration host or handle is not pinned");
      }
      const store = loadRows();
      const rows = [...store.apps];
      const existing = rows.find(
        (item) => item.user === row.user && item.app === row.app,
      );
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(row)) return;
        throw new Error("auto registration app collision");
      }
      rows.push(row);
      applyRows(rows, false, store.pins);
    },
    pinHandle(
      authenticatedServerId: string,
      authenticatedOwnerId: string,
      input: { user: string; memberId: string },
    ) {
      if (
        typeof input.memberId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.memberId)
      )
        throw new Error("invalid auto public handle pin");
      // The pinning member must be the owner the handle is claimed for.
      if (input.memberId !== authenticatedOwnerId)
        throw new Error("auto handle pin member is not the handle owner");
      const staticPolicy = options.staticPolicy();
      // A host may only pin a handle that its own owner member has claimed.
      const claimOwnerId = staticPolicy.publicHandleClaimOwners?.get(
        input.user,
      );
      if (claimOwnerId !== authenticatedOwnerId)
        throw new Error("auto handle pin member has not claimed the handle");
      const pin = validHandlePin({
        user: input.user,
        serverId: authenticatedServerId,
        ownerId: authenticatedOwnerId,
      });
      // The authenticated binding stays server-supplied: only a trusted host
      // claiming for its pinned owner member may add a route for its own handle.
      if (
        staticPolicy.hostOwnerMemberIds.get(authenticatedServerId) !==
          authenticatedOwnerId ||
        !staticPolicy.trustedHostKeys.has(authenticatedServerId)
      ) {
        throw new Error("auto handle pin host is not pinned");
      }
      if (staticPolicy.publicDispatchRoutes.has(pin.user)) {
        throw new Error(
          "auto handle pin collides with the operator dispatch table",
        );
      }
      if (
        [...staticPolicy.publicDispatchRoutes.values()].some(
          (route) => route.serverId === pin.serverId,
        )
      )
        throw new Error("auto handle pin server already routes a handle");
      const store = loadRows();
      const userCollision = store.pins.find((item) => item.user === pin.user);
      if (userCollision) {
        if (userCollision.serverId === pin.serverId) return; // idempotent re-pin
        throw new Error("auto handle pin user is already routed");
      }
      const serverCollision = store.pins.find(
        (item) => item.serverId === pin.serverId,
      );
      if (serverCollision)
        throw new Error("auto handle pin server already routes a handle");
      applyRows(store.apps, false, [...store.pins, pin]);
    },
    // OP #105017 ⓐ①③ — 인증된 «핀 읽기»: store.pins 에서 이 인증 호스트가
    // 회원 M 소유로 핀한 라이브 라우트인지만 불리언으로 답한다(남의 핸들 → false).
    queryHandlePin(
      authenticatedServerId: string,
      authenticatedOwnerId: string,
      input: { user: string; memberId: string },
    ) {
      if (input.memberId !== authenticatedOwnerId) return false;
      const store = loadRows();
      return store.pins.some(
        (item) =>
          item.user === input.user &&
          item.serverId === authenticatedServerId &&
          item.ownerId === authenticatedOwnerId,
      );
    },
    // WEBCHAT-PIN-RESTORE — 인증 호스트가 «자기 소유 회원» 몫으로 갖는 정적 claim 열거.
    // 재시작한 핸들 Nexus 가 메모리 원장(핀)을 재구성하는 재생 원천. 호스트가
    // 소유 회원에 결속·신뢰 등재된 경우에만 답하고 남의 claim 은 절대 싣지 않는다.
    queryHandleClaims(authenticatedServerId: string, authenticatedOwnerId: string) {
      const staticPolicy = options.staticPolicy();
      // 값 없는 사유 코드 — 빈 목록의 원인(ⓐ 클레임 없음 · ⓒ 소유자 불일치)을 가른다.
      if (staticPolicy.hostOwnerMemberIds.get(authenticatedServerId) !== authenticatedOwnerId) {
        debug.log("relay.claims", "claims-query-empty", { reason: "host-owner-mismatch" });
        return [];
      }
      if (!staticPolicy.trustedHostKeys.has(authenticatedServerId)) {
        debug.log("relay.claims", "claims-query-empty", { reason: "host-key-untrusted" });
        return [];
      }
      const claims = [...(staticPolicy.publicHandleClaimOwners ?? [])]
        .filter(([, owner]) => owner === authenticatedOwnerId)
        .map(([handle]) => ({ handle, memberId: authenticatedOwnerId }));
      if (claims.length === 0)
        debug.log("relay.claims", "claims-query-empty", { reason: "no-owner-claims" });
      return claims;
    },
    // (출처: #39104) 회원 서버 서비스 자격 «핀 읽기» — 인증 주체(연결 소유자)와
    // 무관하게 회원 M 소유의 핀 여부만 불리언으로 답한다. 핀 쓰기는 이 자격으로
    // 절대 열리지 않는다(쓰기는 emt_ 소유자 대조만 지난다).
    // (출처: #39121 · OP #106416) 정적 public-dispatch 경로가 있는 핸들은 pinHandle 이
    // «collides with the operator dispatch table» 으로 동적 핀을 정책상 거부하므로
    // store.pins(동적 핀)만 읽으면 소유 확인된 정적 claim(운영자 확인 회원 소유)이
    // 영원히 «안 핀됨» 으로 답해 회원 홈 웹채팅 링크가 죽는다. 동적 핀이 없으면 정적
    // claim 소유자 대조로 답한다: claim memberId 가 조회 회원과 일치할 때만 true —
    // 남의 핸들·다른 회원은 false.
    queryHandlePinByMember(input: { user: string; memberId: string }) {
      const store = loadRows();
      if (
        store.pins.some(
          (item) =>
            item.user === input.user && item.ownerId === input.memberId,
        )
      )
        return true;
      const staticPolicy = options.staticPolicy();
      return (
        staticPolicy.publicHandleClaimOwners?.get(input.user) ===
        input.memberId
      );
    },
    unregister(
      authenticatedServerId: string,
      authenticatedOwnerId: string,
      identity: Pick<
        AutoPublicAppRegistration,
        "user" | "app" | "deploymentId" | "grantId"
      >,
    ) {
      const store = loadRows();
      const rows = [...store.apps];
      const existing = rows.find(
        (item) => item.user === identity.user && item.app === identity.app,
      );
      if (!existing) return;
      if (
        existing.serverId !== authenticatedServerId ||
        existing.ownerId !== authenticatedOwnerId ||
        existing.deploymentId !== identity.deploymentId ||
        existing.grantId !== identity.grantId
      ) {
        throw new Error("auto registration undo binding refused");
      }
      applyRows(
        rows.filter((item) => item !== existing),
        true,
      );
    },
    sweepExpired() {
      const staticPolicy = options.staticPolicy();
      lastStaticPolicy = staticPolicy;
      const store = loadRows();
      const rows = store.apps.filter(
        (item) =>
          staticPolicy.trustedHostKeys.has(item.serverId) &&
          staticPolicy.hostOwnerMemberIds.get(item.serverId) === item.ownerId &&
          staticPolicy.publicDispatchRoutes.get(item.user)?.serverId ===
            item.serverId,
      );
      const pins = store.pins.filter(
        (item) =>
          staticPolicy.trustedHostKeys.has(item.serverId) &&
          staticPolicy.hostOwnerMemberIds.get(item.serverId) === item.ownerId &&
          !staticPolicy.publicDispatchRoutes.has(item.user) &&
          ![...staticPolicy.publicDispatchRoutes.values()].some(
            (route) => route.serverId === item.serverId,
          ),
      );
      const raw = privateFile(options.file).raw;
      if (JSON.stringify({ apps: rows, pins }) + "\n" !== raw.toString("utf8"))
        applyRows(rows, true, pins);
    },
  };
}

function privateFile(
  path: string,
  maxBytes = 64 * 1024,
): { raw: Buffer; stamp: string } {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    throw new Error("relay policy safe open unavailable");
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      (process.getuid && before.uid !== process.getuid()) ||
      before.size > maxBytes
    ) {
      throw new Error("relay policy file metadata refused");
    }
    const raw = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      raw.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("relay policy file changed while reading");
    }
    const digest = createHash("sha256").update(raw).digest("hex");
    return {
      raw,
      stamp: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${digest}`,
    };
  } finally {
    closeSync(fd);
  }
}

/** Double-read all private files; an incomplete multi-file update keeps the old policy. */
export function loadRelayPublicPolicySnapshot(
  files: RelayPublicPolicyFiles,
  domain: "elanous.app" | "elanous.ai",
): RelayPublicPolicySnapshot {
  if (files.autoRegistrations) assertNoPendingUpdate(files.autoRegistrations);
  const names = [
    files.trustedHostKeys,
    files.hostOwnerMembers,
        files.publicDispatch,
        files.publicRead,
        ...(files.memberServiceHosts ? [files.memberServiceHosts] : []),
        ...(files.visitorWrite ? [files.visitorWrite] : []),
    ...(files.publicHandleClaims ? [files.publicHandleClaims] : []),
    ...(files.autoRegistrations ? [files.autoRegistrations] : []),
  ];
  const first = names.map((name) => privateFile(name));
  const keysValue: unknown = JSON.parse(first[0]!.raw.toString("utf8"));
  const ownersValue: unknown = JSON.parse(first[1]!.raw.toString("utf8"));
  if (
    !keysValue ||
    typeof keysValue !== "object" ||
    Array.isArray(keysValue) ||
    !ownersValue ||
    typeof ownersValue !== "object" ||
    Array.isArray(ownersValue)
  ) {
    throw new Error("invalid relay policy key or owner file");
  }
  const keys = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const [id, key] of Object.entries(keysValue)) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      typeof key !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      Buffer.from(key, "base64url").toString("base64url") !== key
    )
      throw new Error("invalid relay policy host key");
    keys.set(id, key);
  }
  for (const [id, owner] of Object.entries(ownersValue)) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      typeof owner !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(owner)
    ) {
      throw new Error("invalid relay policy host owner");
    }
    owners.set(id, owner);
  }
  const claimsValue: unknown = files.publicHandleClaims
    ? JSON.parse(
        first[names.indexOf(files.publicHandleClaims)]!.raw.toString("utf8"),
      )
    : {};
  if (
    !claimsValue ||
    typeof claimsValue !== "object" ||
    Array.isArray(claimsValue)
  ) {
    throw new Error("invalid relay policy handle claims");
  }
  const claims = new Map<string, string>();
  for (const [handle, memberId] of Object.entries(claimsValue)) {
    if (
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(handle) ||
      typeof memberId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(memberId)
    ) {
      throw new Error("invalid relay policy handle claim");
    }
    claims.set(handle, memberId);
  }
  // (출처: #106092) ⓑ — 선택 member-service 결속 파일(serverId→true 집합).
  // 없으면 빈 집합(기존 정책 무변경).
  const memberServiceHostsValue: unknown = files.memberServiceHosts
    ? JSON.parse(
        first[names.indexOf(files.memberServiceHosts)]!.raw.toString("utf8"),
      )
    : {};
  if (
    !memberServiceHostsValue ||
    typeof memberServiceHostsValue !== "object" ||
    Array.isArray(memberServiceHostsValue)
  ) {
    throw new Error("invalid relay policy member service host");
  }
  const memberServiceServerIds = new Set<string>();
  for (const [serverId, enabled] of Object.entries(
    memberServiceHostsValue as Record<string, unknown>,
  )) {
    if (!/^[a-f0-9]{64}$/.test(serverId) || enabled !== true)
      throw new Error("invalid relay policy member service host");
    memberServiceServerIds.add(serverId);
  }
  const staticCandidate = validatedRelayPublicPolicySnapshot(
    {
      trustedHostKeys: keys,
      hostOwnerMemberIds: owners,
      publicDispatchRoutes: loadPublicDispatchRoutes(files.publicDispatch),
      publicReadableApps: loadPublicAppReadConfig(files.publicRead),
      ...(claims.size ? { publicHandleClaimOwners: claims } : {}),
      ...(memberServiceServerIds.size
        ? { memberServiceServerIds }
        : {}), // (출처: #106092) ⓑ
      publicVisitorWritePolicies: files.visitorWrite
        ? loadPublicAppVisitorWriteConfig(files.visitorWrite)
        : [],
    },
    domain,
  );
  const autoStore = files.autoRegistrations
    ? loadAutoPublicAppStore(files.autoRegistrations)
    : undefined;
  const candidate = autoStore
    ? withRegistrations(
        staticCandidate,
        autoStore.apps,
        domain,
        Date.now(),
        autoStore.pins,
      )
    : staticCandidate;
  const last = names.map((name) => privateFile(name));
  if (first.some((item, index) => item.stamp !== last[index]!.stamp)) {
    throw new Error("relay policy files changed during candidate validation");
  }
  return candidate;
}

export function validatedRelayPublicPolicySnapshot(
  input: RelayPublicPolicySnapshot,
  domain: "elanous.app" | "elanous.ai",
  now = Date.now(),
): RelayPublicPolicySnapshot {
  if (!input.trustedHostKeys.size || !Number.isSafeInteger(now))
    throw new Error("invalid relay policy snapshot");
  const keys = new Map(input.trustedHostKeys);
  const owners = new Map(input.hostOwnerMemberIds);
  // (출처: #106092) ⓑ — 결속 서비스 키는 trustedHostKeys 필수(①). owner
  // 결속이 있으면 정책가 거부된다(② — 임시 owner 우회 구조적 차단).
  const memberServiceServerIds = input.memberServiceServerIds
    ? new Set(input.memberServiceServerIds)
    : undefined;
  for (const memberServiceServerId of memberServiceServerIds ?? []) {
    if (!keys.get(memberServiceServerId))
      throw new Error("invalid relay policy member service binding");
  }
  for (const [serverId, publicKey] of keys) {
    if (
      !/^[a-f0-9]{64}$/.test(serverId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(publicKey)
    )
      throw new Error("invalid relay policy host binding");
    // (출처: #106092) ⓑ — 서비스 키는 owner 없음이 허용된다(③). 비-서비스
    // 키는 기존 owner 강제를 그대로 유지한다.
    if (memberServiceServerIds?.has(serverId)) {
      if (owners.get(serverId))
        throw new Error("invalid relay policy member service binding");
    } else if (!owners.get(serverId)) {
      throw new Error("invalid relay policy host binding");
    }
  }
  const routes = buildPublicDispatchRoutes(
    new Map(input.publicDispatchRoutes),
    new Set(keys.keys()),
    owners,
  );
  const reads = new Set(input.publicReadableApps);
  const readExpiresAt = new Map(input.publicReadExpiresAt);
  for (const key of reads) {
    const parts = key.split("/");
    if (
      parts.length !== 2 ||
      !routes.has(parts[0]!) ||
      !validPublicPair(parts[0]!, parts[1]!, domain)
    )
      throw new Error("invalid relay policy read binding");
  }
  for (const [key, expiry] of readExpiresAt) {
    if (!reads.has(key) || !Number.isFinite(expiry))
      throw new Error("invalid relay policy read expiry");
  }
  const writes = input.publicVisitorWritePolicies.map((policy) =>
    validateVisitorWritePolicy(policy, now),
  );
  const claimOwners: Map<string, string> | undefined =
    input.publicHandleClaimOwners
      ? new Map(input.publicHandleClaimOwners)
      : undefined;
  if (claimOwners) {
    for (const [handle, memberId] of claimOwners) {
      if (
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(handle) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(memberId)
      )
        throw new Error("invalid relay policy handle claim");
    }
  }
  if (
    new Set(writes.map((policy) => policy.user + "/" + policy.app)).size !==
    writes.length
  ) {
    throw new Error("duplicate relay policy write binding");
  }
  for (const policy of writes) {
    if (
      !reads.has(policy.user + "/" + policy.app) ||
      routes.get(policy.user)?.serverId !== policy.serverId
    )
      throw new Error("invalid relay policy write binding");
  }
  return {
    trustedHostKeys: keys,
    hostOwnerMemberIds: owners,
    publicDispatchRoutes: routes,
    publicReadableApps: reads,
    publicReadExpiresAt: readExpiresAt,
    ...(claimOwners?.size ? { publicHandleClaimOwners: claimOwners } : {}),
    ...(memberServiceServerIds?.size
      ? { memberServiceServerIds }
      : {}), // (출처: #106092) ⓑ — 결속 집합은 재검증·재적재에서 유지된다.
    publicVisitorWritePolicies: writes,
  };
}

function validPublicPair(user: string, app: string, domain: string): boolean {
  return (
    domain.length > 0 &&
    user.length >= 3 &&
    user.length <= 20 &&
    !user.includes("--") &&
    app.length >= 1 &&
    app.length <= 24 &&
    !app.includes("--") &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(user) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(app) &&
    !/-pr\d+$/.test(app) &&
    !["www", "docs", "api", "admin", "relay", "mail"].includes(app)
  );
}

/** A private digest for change detection; neither keys nor owner IDs are logged. */
export function relayPublicPolicyFingerprint(
  input: RelayPublicPolicySnapshot,
): string {
  const ordered = {
    keys: [...input.trustedHostKeys].sort(([a], [b]) => a.localeCompare(b)),
    owners: [...input.hostOwnerMemberIds].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    routes: [...input.publicDispatchRoutes].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    reads: [...input.publicReadableApps].sort(),
    readExpiries: [...(input.publicReadExpiresAt ?? [])].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    writes: [...input.publicVisitorWritePolicies].sort((a, b) =>
      (a.user + "/" + a.app).localeCompare(b.user + "/" + b.app),
    ),
    memberServices: [...(input.memberServiceServerIds ?? [])].sort(), // (출처: #106092) ⓑ
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Registrar writes and the periodic file reader share one applied fingerprint. */
export function createRelayPublicPolicyReloader(
  initial: RelayPublicPolicySnapshot,
  load: () => RelayPublicPolicySnapshot,
  apply: (candidate: RelayPublicPolicySnapshot) => void,
) {
  let appliedFingerprint = relayPublicPolicyFingerprint(initial);
  const applySnapshot = (candidate: RelayPublicPolicySnapshot) => {
    const fingerprint = relayPublicPolicyFingerprint(candidate);
    apply(candidate);
    appliedFingerprint = fingerprint;
  };
  return {
    apply: applySnapshot,
    refresh: () => {
      const candidate = load();
      const fingerprint = relayPublicPolicyFingerprint(candidate);
      if (fingerprint === appliedFingerprint) return false;
      applySnapshot(candidate);
      return true;
    },
  };
}
