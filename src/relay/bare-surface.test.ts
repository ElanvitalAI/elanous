import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BARE_CAPABILITIES_META_NAME,
  BARE_WEBCHAT_FORWARDED_API_PATHS,
  BARE_WEBCHAT_SESSION_ITEM_CAPABILITY,
  bareCapabilitiesContent,
  bareCapabilitiesMetaTag,
  isBareForwardedApiPath,
  parseBareCapabilities,
} from "./bare-surface.js";

test("meta content round-trips the single forwarded set", () => {
  expect(parseBareCapabilities(bareCapabilitiesContent())).toEqual([...BARE_WEBCHAT_FORWARDED_API_PATHS, BARE_WEBCHAT_SESSION_ITEM_CAPABILITY]);
  expect(bareCapabilitiesMetaTag()).toBe(`<meta name="${BARE_CAPABILITIES_META_NAME}" content="${bareCapabilitiesContent()}">`);
  expect(isBareForwardedApiPath('/v1/sessions/store/:id')).toBe(false);
});

test("relay-server derives its bare path check from the shared constant, not literals", () => {
  const src = readFileSync(new URL("./relay-server.ts", import.meta.url), "utf8");
  expect(src).toContain("isBareForwardedApiPath(bareEntryPath)");
  const start = src.indexOf("const bareWebChatNexusPath =");
  const block = src.slice(start, src.indexOf("isBareStaticAssetRequest(req.method", start));
  expect(block).not.toContain('"/v1/chat/events"');
  expect(block).not.toContain('"/v1/prompt/stream"');
});
