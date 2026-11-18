import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { routeRequest } from "../api/http-server.js";
import { createDevProxyRuntimeRef } from "../api/admin-dev-proxy.js";
import { createNexusState } from "../state/state.js";
import { TabRegistry } from "../state/tab-registry.js";
import { NexusEventBus } from "../api/event-bus.js";
import { createMemberStore } from "./member-store.js";
import { createConfiguredMembersApi, createMembersApi } from "./members-api.js";
import {
  loadNexusAppHost,
  resolveVerifiedMemberOwner,
} from "../apps/app-host.js";

test("verified app-session handle migrates its public slot once, rejects cross-member collisions and masks the retired host", async () => {
  const root = mkdtempSync(join(tmpdir(), "member-public-handle-"));
  const now = () => Date.parse("2026-11-14T09:00:00.000Z");
  const store = createMemberStore({ path: join(root, "members.sqlite"), now });
  const register = (name: string) =>
    store.register(
      { sub: name, email: name + "@example.test", emailVerified: true, name },
      { consents: { privacy: "v1", terms: "v1" } },
    );
  const owner = register("fixture-owner");
  const other = register("fixture-other");
  const slot = store.ensureNativeAppSlotForMember(owner.id)!;
  const apps = join(root, "apps");
  const directory = join(apps, slot.appSlug);
  mkdirSync(join(directory, "out"), { recursive: true });
  writeFileSync(
    join(directory, "out/index.html"),
    "<main>ticket queue fixture</main>",
  );
  writeFileSync(
    join(directory, "app.yaml"),
    [
      "apiVersion: elanous.app/v0",
      "slug: " + slot.appSlug,
      "title: Ticket queue",
      "frontend:",
      "  kind: static-export",
      "  out: out",
      "roles:",
      "  owner: { via: nexus-session }",
      "  public: { via: public-read }",
    ].join("\n"),
  );
  const loaded = loadNexusAppHost(
    apps,
    undefined,
    {
      dir: join(root, "auth"),
      databaseDirectory: join(root, "app-db"),
      key: "synthetic-member-public-handle-key-with-256-bits",
      now,
    },
    "legacyfixture",
  );
  const host = loaded.appHost;
  const session = host.issueOwnerSession(slot.appSlug, owner.id);
  const api = createMembersApi({
    store,
    now,
    google: {
      redirectUri: "https://api.example.test/v1/members/oauth/google/callback",
    } as never,
    successRedirectUri: "https://app.example.test/signup/complete",
    publicAppUrl: (current) =>
      "https://" + current.appSlug + "--legacyfixture.elanous.app/",
    resolveVerifiedMemberOwner: (credential, members) =>
      resolveVerifiedMemberOwner(host, credential, members, "legacyfixture"),
  });
  host.setPublicUserSlugResolver!((slug) => api.publicUserSlugForApp!(slug));
  const state = createNexusState({ nexusVersion: "test", phase: "test" });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const routerOptions = {
    state,
    eventBus,
    registry: new TabRegistry(state),
    membersApi: api,
    metaApi: { bearerToken: "fixture-operator-only", noAuth: false },
  };
  const proxyRef = createDevProxyRuntimeRef();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, listener) =>
      (await routeRequest(
        request,
        routerOptions,
        listener as unknown as Parameters<typeof routeRequest>[2],
        null,
        proxyRef,
      )) ?? new Response("not found", { status: 404 }),
  });
  const put = (handle: string, headers: Record<string, string>) =>
    fetch(new URL("/v1/members/handle", server.url), {
      method: "PUT",
      headers,
      body: JSON.stringify({ handle }),
    });
  const publicRead = (user: string) => {
    const hostname = slot.appSlug + "--" + user + ".elanous.app";
    return host.handle(
      new Request("https://" + hostname + "/", { headers: { host: hostname } }),
    );
  };
  try {
    expect(loaded.issues).toEqual([]);
    expect((await publicRead("legacyfixture"))?.status).toBe(200);
    const cookie = {
      cookie: "__Host-elanous_member_session=" + owner.session.token,
    };
    const app = { authorization: "Bearer " + session.sessionToken };
    expect(
      (await put("fixtureowner", { authorization: "Bearer aps_forged" }))
        ?.status,
    ).toBe(401);
    expect(
      (await put("fixtureowner", { authorization: "Bearer arbitrary" }))
        ?.status,
    ).toBe(401);
    expect(
      (
        await put("fixtureowner", {
          ...app,
          cookie: "__Host-elanous_member_session=" + other.session.token,
        })
      )?.status,
    ).toBe(401);
    expect(
      (
        await put("fixtureowner", {
          ...app,
          cookie: "__Host-elanous_member_session=forged",
        })
      )?.status,
    ).toBe(401);
    expect(
      (
        await put("fixtureowner", {
          ...app,
          cookie: "__Host-elanous_member_session=",
        })
      )?.status,
    ).toBe(401);
    expect(
      (
        await put("fixtureowner", {
          ...app,
          cookie: cookie.cookie + "; " + cookie.cookie,
        })
      )?.status,
    ).toBe(401);
    expect(
      (await put("fixtureowner", { ...cookie, authorization: "" }))?.status,
    ).toBe(401);
    expect((await put("invalid_name", app))?.status).toBe(400);
    const claimed = await put("fixtureowner", app);
    expect(claimed?.status).toBe(200);
    const result = await claimed!.json();
    expect(result.appSlot.userSlug).toBe("fixtureowner");
    expect(result.appSlot.url).toBe(
      "https://" + slot.appSlug + "--fixtureowner.elanous.app/",
    );
    expect(store.memberForPublicUserSlug("legacyfixture")).toBeNull();
    expect((await publicRead("legacyfixture"))?.status).toBe(404);
    expect((await publicRead("fixtureowner"))?.status).toBe(200);
    expect((await put("fixtureowner", app))?.status).toBe(200);
    expect((await put("changedowner", app))?.status).toBe(409);
    expect(
      (
        await put("fixtureowner", {
          cookie: "__Host-elanous_member_session=" + other.session.token,
        })
      )?.status,
    ).toBe(409);
    expect(
      (
        await put("legacyfixture", {
          cookie: "__Host-elanous_member_session=" + other.session.token,
        })
      )?.status,
    ).toBe(409);
    expect(
      resolveVerifiedMemberOwner(
        host,
        session.sessionToken,
        store,
        "legacyfixture",
      )?.userSlug,
    ).toBe("fixtureowner");
    const profile = await api.handle(
      new Request("https://api.example.test/v1/members", { headers: cookie }),
    );
    expect((await profile!.json()).appSlot.userSlug).toBe("fixtureowner");
    const legacy = register("legacy-private-owner");
    store.claimHandle(legacy.id, "legacy_owner");
    store.ensureNativeAppSlotForMember(legacy.id);
    expect(store.publicUserSlugForMember(legacy.id)).toBeNull();
    const migrated = await put("newlegacyowner", {
      cookie: "__Host-elanous_member_session=" + legacy.session.token,
    });
    expect(migrated.status).toBe(200);
    expect((await migrated.json()).appSlot.userSlug).toBe("newlegacyowner");
    expect(store.publicUserSlugForMember(legacy.id)).toBe("newlegacyowner");
    expect(
      (
        await put("newlegacyowner", {
          cookie: "__Host-elanous_member_session=" + legacy.session.token,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put("changedagain", {
          cookie: "__Host-elanous_member_session=" + legacy.session.token,
        })
      ).status,
    ).toBe(409);
    expect(() => store.claimHandle(other.id, "legacy_owner")).toThrow(
      "already taken",
    );
    const longLegacy = register("legacy-long-owner");
    store.claimHandle(longLegacy.id, "legacyownernameover20chars");
    store.ensureNativeAppSlotForMember(longLegacy.id);
    const longMigrated = await put("newlongowner", {
      cookie: "__Host-elanous_member_session=" + longLegacy.session.token,
    });
    expect(longMigrated.status).toBe(200);
    expect((await longMigrated.json()).appSlot.userSlug).toBe("newlongowner");
    expect(store.handleForMember(longLegacy.id)).toBe("newlongowner");
    expect(() =>
      store.claimHandle(other.id, "legacyownernameover20chars"),
    ).toThrow("already taken");
    const collision = register("legacy-collision-owner");
    store.claimHandle(collision.id, "legacy_collision");
    const taken = register("legacy-taken-owner");
    store.claimHandle(taken.id, "takenowner");
    expect(() =>
      store.claimHandle(collision.id, "takenowner", "freshlabel"),
    ).toThrow("already taken");
    expect(store.handleForMember(collision.id)).toBe("legacy_collision");
    expect(store.publicUserSlugForMember(collision.id)).toBeNull();
    expect(store.claimHandle(collision.id, "freshlabel")).toBe("freshlabel");
  } finally {
    server.stop(true);
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy DNS handle claim atomically retires the trusted old label", () => {
  const root = mkdtempSync(join(tmpdir(), "member-public-handle-legacy-dns-"));
  const path = join(root, "members.sqlite");
  let store = createMemberStore({ path });
  try {
    const owner = store.register(
      {
        sub: "legacy-dns-owner",
        email: "legacy-dns-owner@example.test",
        emailVerified: true,
        name: "Owner",
      },
      { consents: { privacy: "v1", terms: "v1" } },
    );
    store.close();
    const db = new Database(path);
    db.query(
      "INSERT INTO member_handles (member_id, handle) VALUES (?, ?)",
    ).run(owner.id, "oldowner");
    db.query(
      "INSERT INTO member_public_user_slugs (user_slug, member_id, retired) VALUES (?, ?, 0)",
    ).run("oldfixture", owner.id);
    db.close();
    store = createMemberStore({ path });
    expect(store.publicUserSlugForMember(owner.id)).toBe("oldfixture");
    expect(store.claimHandle(owner.id, "oldowner", "oldfixture")).toBe(
      "oldowner",
    );
    expect(store.publicUserSlugForMember(owner.id)).toBe("oldowner");
    expect(store.memberForPublicUserSlug("oldfixture")).toBeNull();
    expect(store.memberForPublicUserSlug("oldowner")).toBe(owner.id);
    expect(store.claimHandle(owner.id, "oldowner", "oldfixture")).toBe(
      "oldowner",
    );
    expect(() =>
      store.claimHandle(owner.id, "changedowner", "oldfixture"),
    ).toThrow("cannot be changed");
    store.close();
    store = createMemberStore({ path });
    expect(store.publicUserSlugForMember(owner.id)).toBe("oldowner");
    expect(store.memberForPublicUserSlug("oldfixture")).toBeNull();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy DNS handle without canonical reservation does not become a public slug on read", () => {
  const root = mkdtempSync(join(tmpdir(), "member-public-handle-unbound-"));
  const path = join(root, "members.sqlite");
  let store = createMemberStore({ path });
  try {
    const owner = store.register(
      {
        sub: "legacy-unbound",
        email: "legacy-unbound@example.test",
        emailVerified: true,
        name: "Owner",
      },
      { consents: { privacy: "v1", terms: "v1" } },
    );
    store.close();
    const db = new Database(path);
    db.query(
      "INSERT INTO member_handles (member_id, handle) VALUES (?, ?)",
    ).run(owner.id, "oldowner");
    db.close();
    store = createMemberStore({ path });
    expect(store.publicUserSlugForMember(owner.id)).toBeNull();
    expect(store.claimHandle(owner.id, "oldowner", "oldfixture")).toBe(
      "oldowner",
    );
    expect(store.publicUserSlugForMember(owner.id)).toBe("oldowner");
    expect(store.memberForPublicUserSlug("oldfixture")).toBeNull();
    const other = store.register(
      {
        sub: "legacy-unbound-other",
        email: "legacy-unbound-other@example.test",
        emailVerified: true,
        name: "Other",
      },
      { consents: { privacy: "v1", terms: "v1" } },
    );
    expect(() => store.claimHandle(other.id, "oldfixture")).toThrow(
      "already taken",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration rolls back old-label retirement when old private handle is owned elsewhere", () => {
  const root = mkdtempSync(join(tmpdir(), "member-public-handle-rollback-"));
  const path = join(root, "members.sqlite");
  const store = createMemberStore({ path });
  try {
    const register = (name: string) =>
      store.register(
        { sub: name, email: name + "@example.test", emailVerified: true, name },
        { consents: { privacy: "v1", terms: "v1" } },
      );
    const owner = register("legacy-rollback-owner");
    const other = register("legacy-rollback-other");
    store.claimHandle(owner.id, "legacy_private");
    const db = new Database(path);
    db.query(
      "INSERT INTO member_public_user_slugs (user_slug, member_id, retired) VALUES (?, ?, 1)",
    ).run("legacy_private", other.id);
    db.close();
    expect(() => store.claimHandle(owner.id, "newowner", "oldfixture")).toThrow(
      "already taken",
    );
    expect(store.handleForMember(owner.id)).toBe("legacy_private");
    expect(store.publicUserSlugForMember(owner.id)).toBeNull();
    expect(store.claimHandle(other.id, "oldfixture")).toBe("oldfixture");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a handle chosen before slot creation becomes the new slot default and retired labels survive reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "member-public-handle-persist-"));
  const path = join(root, "members.sqlite");
  let store = createMemberStore({ path });
  try {
    const member = store.register(
      {
        sub: "future-slot",
        email: "future-slot@example.test",
        emailVerified: true,
        name: "Fixture",
      },
      { consents: { privacy: "v1", terms: "v1" } },
    );
    store.claimHandle(member.id, "futureowner", "retiredfixture");
    const slot = store.ensureNativeAppSlotForMember(member.id)!;
    expect(store.publicUserSlugForApp(slot.appSlug)).toBe("futureowner");
    store.close();
    store = createMemberStore({ path });
    expect(store.publicUserSlugForApp(slot.appSlug)).toBe("futureowner");
    expect(store.memberForPublicUserSlug("retiredfixture")).toBeNull();
    const other = store.register(
      {
        sub: "next-member",
        email: "next-member@example.test",
        emailVerified: true,
        name: "Other",
      },
      { consents: { privacy: "v1", terms: "v1" } },
    );
    expect(() => store.claimHandle(other.id, "retiredfixture")).toThrow(
      "already taken",
    );
    expect(store.claimHandle(other.id, "anotherowner", "retiredfixture")).toBe(
      "anotherowner",
    );
    expect(() => store.claimHandle(other.id, "futureowner")).toThrow(
      "cannot be changed",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("claiming a handle pins it to the relay and a failing pin never fails the claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "member-handle-pin-"));
  const now = () => Date.parse("2026-11-16T10:00:00.000Z");
  const store = createMemberStore({ path: join(root, "members.sqlite"), now });
  const register = (name: string) =>
    store.register(
      { sub: name, email: name + "@example.test", emailVerified: true, name },
      { consents: { privacy: "v1", terms: "v1" } },
    );
  const owner = register("fixture-pin-owner");
  const other = register("fixture-pin-other");
  const pins: Array<{ handle: string; memberId: string }> = [];
  let failNextPin = true;
  const previousRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    "https://api.example.test/v1/members/oauth/google/callback";
  const api = createConfiguredMembersApi({
    store,
    now,
    google: {
      redirectUri: "https://api.example.test/v1/members/oauth/google/callback",
    } as never,
    publicAppUrl: (current) =>
      "https://" + current.appSlug + "--legacyfixture.elanous.app/",
    pinPublicHandle: (handle, memberId) => {
      pins.push({ handle, memberId });
      if (failNextPin) {
        failNextPin = false;
        throw new Error("synthetic relay pin failure");
      }
    },
  });
  if (!api)
    throw new Error(
      "createConfiguredMembersApi returned null (GOOGLE_OAUTH_REDIRECT_URI missing)",
    );
  const state = createNexusState({ nexusVersion: "test", phase: "test" });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const routerOptions = {
    state,
    eventBus,
    registry: new TabRegistry(state),
    membersApi: api,
    metaApi: { bearerToken: "fixture-operator-only", noAuth: false },
  };
  const proxyRef = createDevProxyRuntimeRef();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, listener) =>
      (await routeRequest(
        request,
        routerOptions,
        listener as unknown as Parameters<typeof routeRequest>[2],
        null,
        proxyRef,
      )) ?? new Response("not found", { status: 404 }),
  });
  const put = (handle: string, token: string) =>
    fetch(new URL("/v1/members/handle", server.url), {
      method: "PUT",
      headers: {
        cookie: `__Host-elanous_member_session=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle }),
    });
  try {
    const first = await put("pinowner", owner.session.token);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { handle: string }).handle).toBe(
      "pinowner",
    );
    const second = await put("otherpin", other.session.token);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { handle: string }).handle).toBe(
      "otherpin",
    );
    expect(pins).toEqual([
      { handle: "pinowner", memberId: owner.id },
      { handle: "otherpin", memberId: other.id },
    ]);
  } finally {
    process.env.GOOGLE_OAUTH_REDIRECT_URI = previousRedirectUri;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
