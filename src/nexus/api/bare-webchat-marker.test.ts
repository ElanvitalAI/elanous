import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareCapabilitiesMetaTag } from "../../relay/bare-surface.js";
import {
  BARE_WEBCHAT_META_TAG,
  markBareWebChatDocument,
  routeBareWebChatHostRequest,
} from "./http-server.js";

// MK #109711 — the bare document tells the PWA (server-delivered) to skip ACP WS.
const STATIC_DIR = mkdtempSync(join(tmpdir(), "bare-marker-"));
mkdirSync(join(STATIC_DIR, "chat"), { recursive: true });
writeFileSync(
  join(STATIC_DIR, "chat", "index.html"),
  '<!doctype html><html><head lang="ko"><title>c</title></head><body>x</body></html>',
);
afterAll(() => rmSync(STATIC_DIR, { recursive: true, force: true }));

describe("bare webchat document marker", () => {
  test("pinned bare /app/chat/ HTML carries the meta tag after <head>", async () => {
    const res = await routeBareWebChatHostRequest(
      new Request("https://alice.elanous.app/app/chat/"),
      { pinnedHandles: new Set(["alice"]), staticDir: STATIC_DIR },
    );
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain(`<head lang="ko">${BARE_WEBCHAT_META_TAG}${bareCapabilitiesMetaTag()}<title>`);
    expect(html).toContain('<meta name="elanous-bare-capabilities" content="/v1/prompt/stream,/v1/chat/events,/v1/sessions/store/:id">');
  });

  test("non-HTML and error responses pass through untouched", async () => {
    const js = new Response("x", { headers: { "content-type": "text/javascript" } });
    expect(await markBareWebChatDocument(js)).toBe(js);
    const nf = new Response("<head>", { status: 404, headers: { "content-type": "text/html" } });
    expect(await markBareWebChatDocument(nf)).toBe(nf);
  });
});
