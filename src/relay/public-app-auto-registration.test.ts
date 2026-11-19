import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  realpathSync,
  fsyncSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { generateDaemonKeyPair, serverIdFromPublicKey } from "./channel.js";
import { connectRelayHost } from "./host-connector.js";
import {
  createRelayAutoAppRegistrar,
  loadAutoPublicAppRegistrations,
  loadRelayPublicPolicySnapshot,
  createRelayPublicPolicyReloader,
  validatedRelayPublicPolicySnapshot,
  type RelayPublicPolicySnapshot,
} from "./public-app-auto-registration.js";
import { startRelayServer } from "./relay-server.js";

const serverId = "a".repeat(64);
const key = Buffer.alloc(32, 1).toString("base64url");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-auto-policy-"));
  roots.push(root);
  const files = {
    trustedHostKeys: join(root, "keys.json"),
    hostOwnerMembers: join(root, "owners.json"),
    publicDispatch: join(root, "routes.json"),
    publicRead: join(root, "read.json"),
    publicHandleClaims: join(root, "claims.json"),
  };
  const put = (path: string, value: unknown) => {
    writeFileSync(path, JSON.stringify(value));
    chmodSync(path, 0o600);
  };
  put(files.trustedHostKeys, { [serverId]: key });
  put(files.hostOwnerMembers, { [serverId]: "owner-1" });
  put(files.publicDispatch, {
    routes: [{ user: "alice", serverId, ownerMemberId: "owner-1" }],
  });
  put(files.publicRead, { apps: [{ user: "alice", app: "tickets" }] });
  // No handle claims by default: every auto pin fails closed until a host
  // owner seeds the claim for a handle it owns.
  put(files.publicHandleClaims, {});
  return { files, put };
}

describe("complete relay policy reload", () => {
  test("bad intermediate files keep the prior route, then a complete new snapshot swaps it", async () => {
    const { files, put } = fixture();
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const get = async (user: string) =>
      (
        await fetch(`http://127.0.0.1:${relay.port}/`, {
          headers: { host: `tickets--${user}.elanous.app` },
        })
      ).status;
    try {
      expect(await get("alice")).toBe(503);
      expect(await get("bobby")).toBe(404);
      put(files.publicDispatch, {
        routes: [{ user: "bobby", serverId, ownerMemberId: "owner-1" }],
      });
      expect(() =>
        loadRelayPublicPolicySnapshot(files, "elanous.app"),
      ).toThrow();
      expect(await get("alice")).toBe(503);
      put(files.publicRead, { apps: [{ user: "bobby", app: "tickets" }] });
      relay.reloadPublicPolicySnapshot(
        loadRelayPublicPolicySnapshot(files, "elanous.app"),
      );
      expect(await get("alice")).toBe(404);
      expect(await get("bobby")).toBe(503);
      expect(() =>
        relay.reloadPublicPolicySnapshot(
          validatedRelayPublicPolicySnapshot(
            {
              ...initial,
              hostOwnerMemberIds: new Map([[serverId, "owner-2"]]),
            },
            "elanous.app",
          ),
        ),
      ).toThrow();
      expect(await get("bobby")).toBe(503);
    } finally {
      relay.stop();
    }
  });

  test("private file symlink and owner-mode drift refuse before touching a live snapshot", () => {
    const { files } = fixture();
    chmodSync(files.publicRead, 0o644);
    expect(() => loadRelayPublicPolicySnapshot(files, "elanous.app")).toThrow();
  });

  test("existing owner and pinned handle register GET, reject foreign authority, and undo exact grant", async () => {
    const { files } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const registration = {
      ownerId: "owner-1",
      serverId,
      user: "alice",
      app: "booking",
      deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
      grantId: "grant-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const request = (method: string) =>
      fetch(`http://127.0.0.1:${relay.port}/reserve`, {
        method,
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      expect((await request("GET")).status).toBe(401);
      expect(() =>
        registrar.register(serverId, "foreign-owner", registration),
      ).toThrow();
      expect(() =>
        registrar.register("b".repeat(64), "owner-1", registration),
      ).toThrow();
      expect(() =>
        registrar.register(serverId, "owner-1", {
          ...registration,
          user: "bobby",
        }),
      ).toThrow();
      expect(() =>
        registrar.register(serverId, "owner-1", {
          ...registration,
          visitorWrite: { user: "alice", app: "booking" },
        } as never),
      ).toThrow();
      expect((await request("GET")).status).toBe(401);
      registrar.register(serverId, "owner-1", registration);
      expect((await request("GET")).status).toBe(503);
      expect((await request("POST")).status).toBe(401);
      expect(() =>
        registrar.unregister(serverId, "owner-1", {
          user: "alice",
          app: "booking",
          deploymentId: registration.deploymentId,
          grantId: "wrong-grant",
        }),
      ).toThrow();
      expect((await request("GET")).status).toBe(503);
      registrar.unregister(serverId, "owner-1", {
        user: "alice",
        app: "booking",
        deploymentId: registration.deploymentId,
        grantId: registration.grantId,
      });
      expect((await request("GET")).status).toBe(401);
    } finally {
      relay.stop();
    }
  });

  test("authenticated product host control registers its app and anonymous GET reaches the app", async () => {
    const { files, put } = fixture();
    const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(13));
    const actualServerId = serverIdFromPublicKey(daemonKeys.publicKey);
    const signingKeys = generateKeyPairSync("ed25519");
    const der = signingKeys.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    const actualKey = der.subarray(-32).toString("base64url");
    put(files.trustedHostKeys, { [actualServerId]: actualKey });
    put(files.hostOwnerMembers, { [actualServerId]: "owner-1" });
    put(files.publicDispatch, {
      routes: [
        { user: "alice", serverId: actualServerId, ownerMemberId: "owner-1" },
      ],
    });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    let registrar: ReturnType<typeof createRelayAutoAppRegistrar>;
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => ({ memberId: "owner-1" }),
      ...initial,
      autoAppRegistration: {
        register: (host, owner, input) =>
          registrar.register(host, owner, input),
        unregister: (host, owner, input) =>
          registrar.unregister(host, owner, input),
      },
    });
    registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const host = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}/host`,
      daemonKeys,
      hostSigningKey: signingKeys.privateKey,
      getMemberToken: async () => "emt_fake_test_member",
      handleRequest: async () =>
        new Response("booking served", { status: 200 }),
    });
    const request = (method: string) =>
      fetch(`http://127.0.0.1:${relay.port}/reserve`, {
        method,
        headers: { host: "booking--alice.elanous.app" },
      });
    const registration = {
      ownerId: "owner-1",
      user: "alice",
      app: "booking",
      deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
      grantId: "grant-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    try {
      expect((await request("GET")).status).toBe(401);
      await expect(
        host.registerPublicApp({ ...registration, ownerId: "foreign" }),
      ).rejects.toThrow();
      expect((await request("GET")).status).toBe(401);
      await host.registerPublicApp(registration);
      const response = await request("GET");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("booking served");
      expect((await request("POST")).status).toBe(401);
      await host.unregisterPublicApp({
        user: "alice",
        app: "booking",
        deploymentId: registration.deploymentId,
        grantId: registration.grantId,
      });
      expect((await request("GET")).status).toBe(401);
    } finally {
      host.close();
      relay.stop();
    }
  });

  test("claimed handle pins respect trust boundaries and collisions at the registrar level", () => {
    const { files, put } = fixture();
    const pinServerId = "b".repeat(64);
    put(files.trustedHostKeys, { [serverId]: key, [pinServerId]: key });
    put(files.hostOwnerMembers, {
      [serverId]: "owner-1",
      [pinServerId]: "owner-2",
    });
    put(files.publicHandleClaims, { fixturehome: "owner-2" });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-pins.json",
    );
    const applied: unknown[] = [];
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => {
        applied.push(candidate);
      },
    });
    expect(() =>
      registrar.pinHandle(pinServerId, "foreign-owner", {
        user: "fixturehome",
        memberId: "foreign-owner",
      }),
    ).toThrow();
    expect(() =>
      registrar.pinHandle("0".repeat(64), "owner-2", {
        user: "fixturehome",
        memberId: "owner-2",
      }),
    ).toThrow();
    expect(() =>
      registrar.pinHandle(pinServerId, "owner-2", {
        user: "fixturehome",
        memberId: "owner-1",
      }),
    ).toThrow("auto handle pin member is not the handle owner");
    expect(() =>
      registrar.pinHandle(pinServerId, "owner-2", {
        user: "alice",
        memberId: "owner-2",
      }),
    ).toThrow();
    expect(() =>
      registrar.pinHandle(pinServerId, "owner-2", {
        user: "UP",
        memberId: "owner-2",
      }),
    ).toThrow();
    registrar.pinHandle(pinServerId, "owner-2", {
      user: "fixturehome",
      memberId: "owner-2",
    });
    registrar.pinHandle(pinServerId, "owner-2", {
      user: "fixturehome",
      memberId: "owner-2",
    });
    expect(() =>
      registrar.pinHandle(pinServerId, "owner-2", {
        user: "secondhome",
        memberId: "owner-2",
      }),
    ).toThrow();
    expect(() =>
      registrar.pinHandle(serverId, "owner-1", {
        user: "fixturehome",
        memberId: "owner-1",
      }),
    ).toThrow();
    const store = JSON.parse(readFileSync(autoRegistrations, "utf8")) as {
      pins: unknown[];
    };
    expect(store.pins).toEqual([
      { ownerId: "owner-2", serverId: pinServerId, user: "fixturehome" },
    ]);
    const snapshot = loadRelayPublicPolicySnapshot(
      { ...files, autoRegistrations },
      "elanous.app",
    );
    expect(snapshot.publicDispatchRoutes.get("fixturehome")).toEqual({
      serverId: pinServerId,
      ownerMemberId: "owner-2",
    });
    registrar.sweepExpired();
    const swept = JSON.parse(readFileSync(autoRegistrations, "utf8")) as {
      pins: unknown[];
    };
    expect(swept.pins).toEqual([
      { ownerId: "owner-2", serverId: pinServerId, user: "fixturehome" },
    ]);
    expect(applied).toHaveLength(1);
  });

  test("a server already carrying an operator dispatch route cannot claim a pin", () => {
    const { files, put } = fixture();
    put(files.trustedHostKeys, { [serverId]: key });
    put(files.hostOwnerMembers, { [serverId]: "owner-1" });
    put(files.publicDispatch, {
      routes: [{ user: "ophome", serverId, ownerMemberId: "owner-1" }],
    });
    put(files.publicRead, { apps: [{ user: "ophome", app: "tickets" }] });
    put(files.publicHandleClaims, { memberhome: "owner-1" });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-pins-static.json",
    );
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: () => {},
    });
    expect(() =>
      registrar.pinHandle(serverId, "owner-1", {
        user: "memberhome",
        memberId: "owner-1",
      }),
    ).toThrow("auto handle pin server already routes a handle");
  });

  test("sweepExpired drops pins whose server gained an operator dispatch route", () => {
    const { files, put } = fixture();
    const pinServerId = "c".repeat(64);
    put(files.trustedHostKeys, { [serverId]: key, [pinServerId]: key });
    put(files.hostOwnerMembers, {
      [serverId]: "owner-1",
      [pinServerId]: "owner-2",
    });
    put(files.publicHandleClaims, { memberhome: "owner-2" });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-pins-sweep.json",
    );
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: () => {},
    });
    registrar.pinHandle(pinServerId, "owner-2", {
      user: "memberhome",
      memberId: "owner-2",
    });
    put(files.publicDispatch, {
      routes: [
        { user: "alice", serverId, ownerMemberId: "owner-1" },
        { user: "ophome", serverId: pinServerId, ownerMemberId: "owner-2" },
      ],
    });
    registrar.sweepExpired();
    const store = JSON.parse(readFileSync(autoRegistrations, "utf8")) as {
      pins: unknown[];
    };
    expect(store.pins).toEqual([]);
  });

  test("a failed pins store write stays unapplied and the next registrar run recovers", () => {
    const { files, put } = fixture();
    const pinServerId = "b".repeat(64);
    const pinKey = Buffer.alloc(32, 2).toString("base64url");
    put(files.trustedHostKeys, { [serverId]: key, [pinServerId]: pinKey });
    put(files.hostOwnerMembers, {
      [serverId]: "owner-1",
      [pinServerId]: "owner-2",
    });
    put(files.publicHandleClaims, { fixturehome: "owner-2" });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-pin-write.json",
    );
    const applied: RelayPublicPolicySnapshot[] = [];
    let directorySyncs = 0;
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => applied.push(candidate),
      syncDirectory: (fd) => {
        directorySyncs += 1;
        // The marker is durable after the first sync; the rename has already
        // happened when the post-rename directory sync faults twice.
        if (directorySyncs === 2 || directorySyncs === 3)
          throw new Error("synthetic directory sync failure");
        fsyncSync(fd);
      },
    });
    expect(() =>
      registrar.pinHandle(pinServerId, "owner-2", {
        user: "fixturehome",
        memberId: "owner-2",
      }),
    ).toThrow("synthetic directory sync failure");
    expect(existsSync(autoRegistrations + ".pending")).toBe(true);
    expect(applied).toEqual([]);
    // An unacknowledged pin is never exposed: the next registrar run first
    // recovers the pre-fault store image, then the retry pin applies cleanly.
    const recovered = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => applied.push(candidate),
    });
    expect(existsSync(autoRegistrations + ".pending")).toBe(false);
    expect(applied).toEqual([]);
    recovered.pinHandle(pinServerId, "owner-2", {
      user: "fixturehome",
      memberId: "owner-2",
    });
    expect(
      applied[applied.length - 1]!.publicDispatchRoutes.get("fixturehome"),
    ).toEqual({ serverId: pinServerId, ownerMemberId: "owner-2" });
    expect(
      applied[applied.length - 1]!.publicReadableApps.has("fixturehome/home"),
    ).toBe(true);
  });

  test("authenticated product host pins its claimed handle and the public route follows the pin", async () => {
    const { files, put } = fixture();
    const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(19));
    const actualServerId = serverIdFromPublicKey(daemonKeys.publicKey);
    const signingKeys = generateKeyPairSync("ed25519");
    const der = signingKeys.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    const actualKey = der.subarray(-32).toString("base64url");
    put(files.trustedHostKeys, {
      [serverId]: key,
      [actualServerId]: actualKey,
    });
    put(files.hostOwnerMembers, {
      [serverId]: "owner-1",
      [actualServerId]: "owner-4",
    });
    put(files.publicHandleClaims, { fixturehome: "owner-4" });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-pins.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    let registrar: ReturnType<typeof createRelayAutoAppRegistrar>;
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => ({ memberId: "owner-4" }),
      ...initial,
      autoAppRegistration: {
        register: (host, owner, input) =>
          registrar.register(host, owner, input),
        unregister: (host, owner, input) =>
          registrar.unregister(host, owner, input),
        pinHandle: (host, owner, input) =>
          registrar.pinHandle(host, owner, input),
      },
    });
    registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const host = await connectRelayHost({
      relayUrl: `ws://127.0.0.1:${relay.port}/host`,
      daemonKeys,
      hostSigningKey: signingKeys.privateKey,
      getMemberToken: async () => "emt_fake_test_member",
      handleRequest: async () => new Response("home served", { status: 200 }),
    });
    const appRequest = () =>
      fetch(`http://127.0.0.1:${relay.port}/reserve`, {
        headers: { host: "home--fixturehome.elanous.app" },
      });
    try {
      expect((await appRequest()).status).toBe(404);
      await expect(host.pinPublicHandle("alice", "owner-4")).rejects.toThrow();
      await expect(host.pinPublicHandle("UP", "owner-4")).rejects.toThrow();
      await host.pinPublicHandle("fixturehome", "owner-4");
      const response = await appRequest();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("home served");
      const store = JSON.parse(readFileSync(autoRegistrations, "utf8")) as {
        pins: unknown[];
      };
      expect(store.pins).toEqual([
        { ownerId: "owner-4", serverId: actualServerId, user: "fixturehome" },
      ]);
      await host.pinPublicHandle("fixturehome", "owner-4");
      await expect(
        host.pinPublicHandle("secondhome", "owner-4"),
      ).rejects.toThrow();
      const snapshot = loadRelayPublicPolicySnapshot(
        { ...files, autoRegistrations },
        "elanous.app",
      );
      expect(snapshot.publicDispatchRoutes.get("fixturehome")).toEqual({
        serverId: actualServerId,
        ownerMemberId: "owner-4",
      });
    } finally {
      host.close();
      relay.stop();
    }
  });

  test("grant expiry denies anonymous read even while a broken static file prevents reload", async () => {
    const { files } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const request = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 40).toISOString(),
      });
      expect((await request()).status).toBe(503);
      chmodSync(files.publicRead, 0o644);
      expect(() =>
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      ).toThrow();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await request()).status).toBe(401);
    } finally {
      relay.stop();
    }
  });

  test("automatic grant expiry does not override an existing static public read", async () => {
    const { files, put } = fixture();
    put(files.publicRead, {
      apps: [
        { user: "alice", app: "tickets" },
        { user: "alice", app: "booking" },
      ],
    });
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const get = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 40).toISOString(),
      });
      expect((await get()).status).toBe(503);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await get()).status).toBe(503);
    } finally {
      relay.stop();
    }
  });

  test("exact grant removal closes anonymous GET while a static policy file is corrupt", async () => {
    const { files } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const registration = {
      ownerId: "owner-1",
      serverId,
      user: "alice",
      app: "booking",
      deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
      grantId: "grant-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const get = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", registration);
      expect((await get()).status).toBe(503);
      chmodSync(files.publicRead, 0o644);
      expect(() =>
        registrar.register(serverId, "owner-1", {
          ...registration,
          app: "another",
        }),
      ).toThrow();
      registrar.unregister(serverId, "owner-1", {
        user: "alice",
        app: "booking",
        deploymentId: registration.deploymentId,
        grantId: registration.grantId,
      });
      expect((await get()).status).toBe(401);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
    } finally {
      relay.stop();
    }
  });

  test("persistent post-rename sync failure blocks reload and restart; retirement closes live GET", async () => {
    const { files } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    let fault = false;
    let syncCount = 0;
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: (fd) => {
        if (fault && ++syncCount >= 2)
          throw new Error("synthetic directory sync failure");
        fsyncSync(fd);
      },
    });
    const registration = {
      ownerId: "owner-1",
      serverId,
      user: "alice",
      app: "booking",
      deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
      grantId: "grant-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const get = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", registration);
      expect((await get()).status).toBe(503);
      fault = true;
      syncCount = 0;
      expect(() =>
        registrar.unregister(serverId, "owner-1", {
          user: "alice",
          app: "booking",
          deploymentId: registration.deploymentId,
          grantId: registration.grantId,
        }),
      ).toThrow();
      expect(existsSync(autoRegistrations + ".pending")).toBe(true);
      expect(() =>
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      ).toThrow();
      expect((await get()).status).toBe(401);
      expect(() =>
        registrar.unregister(serverId, "owner-1", {
          user: "alice",
          app: "booking",
          deploymentId: registration.deploymentId,
          grantId: registration.grantId,
        }),
      ).toThrow("synthetic directory sync failure");
      expect(existsSync(autoRegistrations + ".pending")).toBe(true);
      expect((await get()).status).toBe(401);
      fault = false;
      registrar.unregister(serverId, "owner-1", {
        user: "alice",
        app: "booking",
        deploymentId: registration.deploymentId,
        grantId: registration.grantId,
      });
      expect(existsSync(autoRegistrations + ".pending")).toBe(false);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      relay.reloadPublicPolicySnapshot(
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      );
      expect((await get()).status).toBe(401);
    } finally {
      relay.stop();
    }
  });

  test("post-rename registration sync failure never opens an unacknowledged GET", async () => {
    const { files } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    let syncCount = 0;
    let fault = true;
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: (fd) => {
        if (fault && ++syncCount >= 2)
          throw new Error("synthetic directory sync failure");
        fsyncSync(fd);
      },
    });
    try {
      expect(() =>
        registrar.register(serverId, "owner-1", {
          ownerId: "owner-1",
          serverId,
          user: "alice",
          app: "booking",
          deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
          grantId: "grant-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).toThrow();
      expect(existsSync(autoRegistrations + ".pending")).toBe(true);
      expect(() =>
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      ).toThrow();
      expect(
        (
          await fetch(`http://127.0.0.1:${relay.port}/`, {
            headers: { host: "booking--alice.elanous.app" },
          })
        ).status,
      ).toBe(401);
      // A separate process runs the same startup loader after the fault clears.
      fault = false;
      const startup = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { ensureRelayAutoRegistrationFile, loadRelayPublicPolicySnapshot } from
          ${JSON.stringify(new URL("./public-app-auto-registration.ts", import.meta.url).href)};
        const path = ${JSON.stringify(autoRegistrations)};
        const files = ${JSON.stringify({ ...files, autoRegistrations })};
        ensureRelayAutoRegistrationFile(path);
        const policy = loadRelayPublicPolicySnapshot(files, 'elanous.app');
        if (policy.publicReadableApps.has('alice/booking')) process.exit(2);
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await startup.exited).toBe(0);
      expect(existsSync(autoRegistrations + ".pending")).toBe(false);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      const restarted = loadRelayPublicPolicySnapshot(
        { ...files, autoRegistrations },
        "elanous.app",
      );
      relay.reloadPublicPolicySnapshot(restarted);
      expect(
        (
          await fetch(`http://127.0.0.1:${relay.port}/`, {
            headers: { host: "booking--alice.elanous.app" },
          })
        ).status,
      ).toBe(401);
    } finally {
      relay.stop();
    }
  });

  test("registrar apply updates timer fingerprint before a file reverts to its prior policy", async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const allFiles = { ...files, autoRegistrations };
    // The same reloader methods are used by relay-cli registrar.apply and its timer.
    const reloader = createRelayPublicPolicyReloader(
      initial,
      () => loadRelayPublicPolicySnapshot(allFiles, "elanous.app"),
      (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    );
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: reloader.apply,
    });
    const get = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await get()).status).toBe(503);
      put(autoRegistrations, { apps: [] });
      expect(reloader.refresh()).toBe(true);
      expect((await get()).status).toBe(401);
      expect(reloader.refresh()).toBe(false);
    } finally {
      relay.stop();
    }
  });

  test("removing the pinned handle retires its app registration before a later pin can reuse it", async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const request = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await request()).status).toBe(503);
      put(files.publicDispatch, {
        routes: [{ user: "bobby", serverId, ownerMemberId: "owner-1" }],
      });
      put(files.publicRead, { apps: [{ user: "bobby", app: "tickets" }] });
      registrar.sweepExpired();
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect((await request()).status).toBe(404);
      put(files.publicDispatch, {
        routes: [{ user: "alice", serverId, ownerMemberId: "owner-1" }],
      });
      put(files.publicRead, { apps: [{ user: "alice", app: "tickets" }] });
      relay.reloadPublicPolicySnapshot(
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      );
      expect((await request()).status).toBe(401);
    } finally {
      relay.stop();
    }
  });

  test("completed owner rotation revokes an old auto app instead of retaining the old snapshot", async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
    });
    const request = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      const registration = {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      registrar.register(serverId, "owner-1", registration);
      expect((await request()).status).toBe(503);
      put(files.hostOwnerMembers, { [serverId]: "owner-2" });
      put(files.publicDispatch, {
        routes: [{ user: "alice", serverId, ownerMemberId: "owner-2" }],
      });
      registrar.sweepExpired();
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect((await request()).status).toBe(401);
      expect(() =>
        registrar.register(serverId, "owner-1", registration),
      ).toThrow();
    } finally {
      relay.stop();
    }
  });

  test("owner rotation plus post-rename sync failure withdraws live GET and recovers the exact retirement", async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    let fault = false;
    let syncCount = 0;
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: (fd) => {
        if (fault && ++syncCount >= 2)
          throw new Error("synthetic directory sync failure");
        fsyncSync(fd);
      },
    });
    const request = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await request()).status).toBe(503);
      put(files.hostOwnerMembers, { [serverId]: "owner-2" });
      put(files.publicDispatch, {
        routes: [{ user: "alice", serverId, ownerMemberId: "owner-2" }],
      });
      fault = true;
      syncCount = 0;
      expect(() => registrar.sweepExpired()).toThrow(
        "synthetic directory sync failure",
      );
      expect(existsSync(autoRegistrations + ".pending")).toBe(true);
      expect((await request()).status).toBe(401);
      expect(() =>
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      ).toThrow();
      fault = false;
      registrar.sweepExpired();
      expect(existsSync(autoRegistrations + ".pending")).toBe(false);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect((await request()).status).toBe(401);
      relay.reloadPublicPolicySnapshot(
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ),
      );
      expect((await request()).status).toBe(401);
    } finally {
      relay.stop();
    }
  });

  test("removed handle pin plus post-rename sync failure cannot keep the former app reachable", async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-apps.json",
    );
    const initial = loadRelayPublicPolicySnapshot(files, "elanous.app");
    const relay = startRelayServer({
      port: 0,
      hostname: "127.0.0.1",
      publicDomain: "elanous.app",
      memberRequired: true,
      validateMemberToken: async () => null,
      ...initial,
    });
    let fault = false;
    let syncCount = 0;
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: (candidate) => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: (fd) => {
        if (fault && ++syncCount >= 2)
          throw new Error("synthetic directory sync failure");
        fsyncSync(fd);
      },
    });
    const request = () =>
      fetch(`http://127.0.0.1:${relay.port}/`, {
        headers: { host: "booking--alice.elanous.app" },
      });
    try {
      registrar.register(serverId, "owner-1", {
        ownerId: "owner-1",
        serverId,
        user: "alice",
        app: "booking",
        deploymentId: "dyn-12345678-1234-4123-8123-123456789abc",
        grantId: "grant-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await request()).status).toBe(503);
      put(files.publicDispatch, {
        routes: [{ user: "bobby", serverId, ownerMemberId: "owner-1" }],
      });
      put(files.publicRead, { apps: [{ user: "bobby", app: "tickets" }] });
      fault = true;
      syncCount = 0;
      expect(() => registrar.sweepExpired()).toThrow(
        "synthetic directory sync failure",
      );
      expect((await request()).status).toBe(404);
      expect(existsSync(autoRegistrations + ".pending")).toBe(true);
      fault = false;
      registrar.sweepExpired();
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect(existsSync(autoRegistrations + ".pending")).toBe(false);
      expect((await request()).status).toBe(404);
    } finally {
      relay.stop();
    }
  });

  describe("auto handle pin claims", () => {
    const setup = (claims: Record<string, string>) => {
      const { files, put } = fixture();
      const pinServerId = "b".repeat(64);
      const bobServerId = "c".repeat(64);
      put(files.trustedHostKeys, {
        [serverId]: key,
        [pinServerId]: key,
        [bobServerId]: key,
      });
      put(files.hostOwnerMembers, {
        [serverId]: "owner-1",
        [pinServerId]: "owner-2",
        [bobServerId]: "owner-3",
      });
      put(files.publicHandleClaims, claims);
      const autoRegistrations = join(
        realpathSync(roots[roots.length - 1]!),
        "auto-pins-claims.json",
      );
      const registrar = createRelayAutoAppRegistrar({
        file: autoRegistrations,
        domain: "elanous.app",
        staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
        apply: () => {},
      });
      return { registrar, files, autoRegistrations, bobServerId };
    };

    test("P1: a handle claimed by another owner refuses the pin while the claiming owner pins cleanly", () => {
      const { registrar, files, autoRegistrations, bobServerId } = setup({
        bobhandle: "owner-3",
      });
      const pinServerId = "b".repeat(64);
      expect(() =>
        registrar.pinHandle(pinServerId, "owner-2", {
          user: "bobhandle",
          memberId: "owner-2",
        }),
      ).toThrow("auto handle pin member has not claimed the handle");
      expect(() =>
        registrar.pinHandle(bobServerId, "owner-3", {
          user: "bobhandle",
          memberId: "owner-3",
        }),
      ).not.toThrow();
      expect(
        loadRelayPublicPolicySnapshot(
          { ...files, autoRegistrations },
          "elanous.app",
        ).publicDispatchRoutes.get("bobhandle"),
      ).toEqual({ serverId: bobServerId, ownerMemberId: "owner-3" });
    });

    test("P2: without a claim every auto pin fails closed", () => {
      const { registrar } = setup({});
      const pinServerId = "b".repeat(64);
      expect(() =>
        registrar.pinHandle(pinServerId, "owner-2", {
          user: "nobodyclaimed",
          memberId: "owner-2",
        }),
      ).toThrow("auto handle pin member has not claimed the handle");
    });

    test("P3b: a claim owned by a different member cannot be spoofed via a multi-member host", () => {
      const { registrar } = setup({ xhandle: "member-x" });
      const pinServerId = "b".repeat(64);
      expect(() =>
        registrar.pinHandle(pinServerId, "owner-2", {
          user: "xhandle",
          memberId: "owner-2",
        }),
      ).toThrow("auto handle pin member has not claimed the handle");
    });
  });
});

// (출처: #39121 · OP #106416) Literal tests for the member «pin read» query: a
// handle carrying an operator dispatch route never gains a dynamic pin
// (pinHandle refuses it as a dispatch-table collision), so the query must
// answer «pinned» from the operator-verified static claim alone (①) while
// another member (②) and unclaimed handles (③) stay unpinned; an existing
// dynamic pin (④) keeps answering pinned.
describe("member handle pin query honors operator-verified static claims", () => {
  const setupPinQuery = (claims: Record<string, string>) => {
    const { files, put } = fixture();
    const pinServerId = "b".repeat(64);
    put(files.trustedHostKeys, { [serverId]: key, [pinServerId]: key });
    put(files.hostOwnerMembers, {
      [serverId]: "owner-1",
      [pinServerId]: "owner-2",
    });
    put(files.publicDispatch, {
      routes: [{ user: "ophome", serverId, ownerMemberId: "owner-1" }],
    });
    put(files.publicRead, { apps: [{ user: "ophome", app: "tickets" }] });
    put(files.publicHandleClaims, claims);
    const autoRegistrations = join(
      realpathSync(roots[roots.length - 1]!),
      "auto-pin-query.json",
    );
    const registrar = createRelayAutoAppRegistrar({
      file: autoRegistrations,
      domain: "elanous.app",
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, "elanous.app"),
      apply: () => {},
    });
    return { files, put, registrar, pinServerId };
  };

  test("① operator-verified static claim answers pinned without a dynamic pin", () => {
    const { registrar } = setupPinQuery({ ophome: "owner-1" });
    expect(
      registrar.queryHandlePinByMember({
        user: "ophome",
        memberId: "owner-1",
      }),
    ).toBe(true);
  });

  test("② the same claimed handle queried as another member answers unpinned", () => {
    const { registrar } = setupPinQuery({ ophome: "owner-1" });
    expect(
      registrar.queryHandlePinByMember({
        user: "ophome",
        memberId: "owner-2",
      }),
    ).toBe(false);
  });

  test("③ a handle without a claim and without a dynamic pin answers unpinned", () => {
    const { registrar } = setupPinQuery({ ophome: "owner-1" });
    expect(
      registrar.queryHandlePinByMember({
        user: "nobodyclaimed",
        memberId: "owner-1",
      }),
    ).toBe(false);
  });

  test("④ an existing dynamic pin keeps answering pinned", () => {
    const { files, put, registrar, pinServerId } = setupPinQuery({
      memberhome: "owner-2",
    });
    registrar.pinHandle(pinServerId, "owner-2", {
      user: "memberhome",
      memberId: "owner-2",
    });
    // Drop the claim after the pin: the dynamic pin alone must answer true.
    put(files.publicHandleClaims, {});
    expect(
      registrar.queryHandlePinByMember({
        user: "memberhome",
        memberId: "owner-2",
      }),
    ).toBe(true);
  });
});
