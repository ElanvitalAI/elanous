import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeBareWebChatHostRequest } from "./http-server.js";
import { handleStaticAppRequest } from "./static-app.js";

// MK #109530 — Nexus 쪽: 핀된 bare 원점의 /app/_next/static/** 는 wcs_ 쿠키 없이 staticDir 아래만 서빙.
const ROOT = mkdtempSync(join(tmpdir(), "bare-static-"));
const STATIC_DIR = join(ROOT, "pwa");
mkdirSync(join(STATIC_DIR, "_next", "static", "chunks"), { recursive: true });
writeFileSync(join(STATIC_DIR, "_next", "static", "chunks", "a-12345678.js"), "console.log('hashed')");
writeFileSync(join(ROOT, "secret.txt"), "TOP-SECRET");
symlinkSync(join(ROOT, "secret.txt"), join(STATIC_DIR, "_next", "static", "chunks", "escape-12345678.js"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const pinned = new Set(["user"]);
const call = (path: string, host = "user.elanous.app", init?: RequestInit) =>
  routeBareWebChatHostRequest(new Request(`https://${host}${path}`, init), {
    pinnedHandles: pinned,
    staticDir: STATIC_DIR,
  });

test("anonymous GET/HEAD hashed static on pinned bare origin serves the file (no cookie)", async () => {
  const get = await call("/app/_next/static/chunks/a-12345678.js");
  expect(get?.status).toBe(200);
  expect(await get?.text()).toContain("hashed");
  expect((await call("/app/_next/static/chunks/a-12345678.js", undefined, { method: "HEAD" }))?.status).toBe(200);
});

test("POST static, traversal, and unpinned host are not served", async () => {
  const post = await call("/app/_next/static/chunks/a-12345678.js", undefined, { method: "POST", body: "x" });
  expect(post?.status).toBe(404);
  for (const p of ["/app/_next/static/../../../secret.txt", "/app/_next/static/%2e%2e%2f%2e%2e%2fsecret.txt"]) {
    const r = await call(p);
    expect([p, r?.status]).toEqual([p, 404]);
    expect(await r?.text()).not.toContain("TOP-SECRET");
  }
  const unpinned = await call("/app/_next/static/chunks/a-12345678.js", "stranger.elanous.app");
  expect(unpinned?.status).toBe(404);
  expect(await unpinned?.text()).toContain("handle-not-pinned");
});

test("a hashed symlink pointing outside the static root remains closed", async () => {
  expect((await call("/app/_next/static/chunks/escape-12345678.js"))?.status).toBe(404);
});

test("static root prefix cannot admit a sibling directory sharing its name", async () => {
  const sibling = `${STATIC_DIR}-sibling`;
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "leak.txt"), "outside");
  const synthetic = { pathname: "/app/../pwa-sibling/leak.txt" } as URL;
  const response = handleStaticAppRequest(synthetic, { staticDir: STATIC_DIR });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("outside");
});

test("non-static paths keep prior behavior", async () => {
  expect((await call("/app/other/x.js"))?.status).toBe(404);
  expect((await call("/v1/me"))?.status).toBe(404);
  expect((await call("/app/chat"))?.status).toBe(303);
});
