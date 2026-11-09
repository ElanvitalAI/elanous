// W7-후속 (2026-05-12) — Outbound substrate boot helper.
//
// Reads `notifications.apns` from user-config + .p8 PEM from disk, then
// wires the OutboundRouter substrate (token store + iOS push channel
// behind a production APNs transport). The resulting handle exposes
// the pieces the nexus boot needs:
//
//   - `tokenStore`: passed to `/v1/devices/tokens` REST endpoint
//     (`OutboundTokenRouteOpts`) so PWA / iOS clients can register
//     device push tokens.
//   - `channels`: list of channels the router knows about. ios-push
//     is registered with a real transport when apns is configured;
//     otherwise the channel registers with `transport=undefined` so
//     `send()` resolves to `{ok:false, reason:'transport-not-configured'}`
//     (visible · loud misconfig rather than silent skip).
//   - `router`: `OutboundRouter` instance. Currently no production
//     consumer routes events through it — future intent-prediction
//     push + showroom outbound dispatch will. Holding the instance in
//     the runtime keeps the substrate single-instance + side-effect-
//     free at boot.
//
// The helper is side-effect-free apart from one synchronous file read
// (the .p8). Errors during read / parse surface as `reason` strings on
// the handle — caller logs but doesn't crash boot.
//
// Cross-ref:
//   src/user-config.ts (`notifications.apns` schema)
//   src/notification-apns.ts (`createApnsTransport`)
//   src/showroom/outbound/channels/ios-push.ts (`createIosPushChannel`)
//   src/showroom/outbound/router.ts (`OutboundRouter`)
//   src/nexus/index.ts (boot wire site)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createApnsTransport } from '../notification-apns.js';
import type { ApnsTransportOpts } from '../notification-apns.js';
import type { ApnsUserConfig } from '../user-config/types.js';
import {
  createIosPushChannel,
  type ApnsTransport,
} from '../showroom/outbound/channels/ios-push.js';
import {
  createWebPushChannel,
  type WebPushChannelDeps,
} from '../showroom/outbound/channels/web-push.js';
import { OutboundRouter } from '../showroom/outbound/router.js';
import {
  InMemoryDeviceTokenStore,
  type DeviceTokenStore,
} from '../showroom/outbound/token-store.js';
import type { OutboundChannel } from '../showroom/outbound/types.js';

export interface OutboundSubstrate {
  tokenStore: DeviceTokenStore;
  channels: OutboundChannel[];
  router: OutboundRouter;
  /** Diagnostic — present when ios-push transport could not be wired
   *  from the supplied config (file missing / PEM unreadable). The
   *  channel still registers so the router knows about it, but its
   *  `send()` returns `transport-not-configured`. */
  apnsBootSkippedReason?: string;
}

export interface BuildOutboundSubstrateOpts {
  /** Pass `cfg.notifications?.apns` directly (sparse). When undefined
   *  the substrate boots with `transport=undefined`. */
  apnsConfig?: ApnsUserConfig;
  /** Override the disk read — tests pass a function that returns the
   *  PEM string for a given path. Defaults to `node:fs.readFileSync`
   *  + `~`-expansion. */
  readKeyFile?: (path: string) => string;
  /** Override the transport factory (tests inject a fake transport
   *  without exercising the real createApnsTransport path). */
  createApnsTransportFn?: (opts: ApnsTransportOpts) => ApnsTransport;
  /** G1 (2026-05-12) — Web Push channel injection seam. Production
   *  passes nothing so the channel uses the live VAPID sender +
   *  listSubscriptions(). Tests inject fakes via `WebPushChannelDeps`
   *  so the substrate constructs without touching `src/web-push/`. */
  webPushDeps?: WebPushChannelDeps;
}

/** Expand a leading `~/` to the user's home directory; absolute paths
 *  pass through unchanged. Tests can pre-resolve and skip expansion. */
export function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function defaultReadKeyFile(path: string): string {
  return readFileSync(expandHome(path), 'utf8');
}

/** Build the outbound substrate from user-config. Never throws — disk
 *  read failures surface as `apnsBootSkippedReason` so the daemon
 *  boots even with a misconfigured APNs key. */
export function buildOutboundSubstrate(
  opts: BuildOutboundSubstrateOpts = {},
): OutboundSubstrate {
  const tokenStore = new InMemoryDeviceTokenStore();
  const readKeyFile = opts.readKeyFile ?? defaultReadKeyFile;
  const transportFactory = opts.createApnsTransportFn ?? createApnsTransport;

  let apnsTransport: ApnsTransport | undefined;
  let apnsBootSkippedReason: string | undefined;
  if (opts.apnsConfig) {
    try {
      const keyPem = readKeyFile(opts.apnsConfig.keyPath);
      apnsTransport = transportFactory({
        keyId: opts.apnsConfig.keyId,
        teamId: opts.apnsConfig.teamId,
        bundleId: opts.apnsConfig.bundleId,
        keyPem,
        ...(opts.apnsConfig.environment ? { environment: opts.apnsConfig.environment } : {}),
      });
    } catch (err) {
      apnsBootSkippedReason = err instanceof Error ? err.message : String(err);
    }
  } else {
    apnsBootSkippedReason = 'apns-config-absent';
  }

  const iosPushChannel = createIosPushChannel({
    tokenStore,
    ...(apnsTransport ? { transport: apnsTransport } : {}),
  });
  // G1 (2026-05-12) — register web-push alongside ios-push so the
  // router can fan out to PWA subscribers (Chrome desktop · Firefox ·
  // Safari macOS · iOS 16.4+ home-screen PWA). Sender + subscription
  // count default to the production VAPID surface; tests inject via
  // `opts.webPushDeps`. The channel's `available()` returns false
  // until the first PushSubscription registers, so an empty subscriber
  // list is silently skipped by the router (not an error).
  const webPushChannel = createWebPushChannel(opts.webPushDeps ?? {});
  const channels: OutboundChannel[] = [iosPushChannel, webPushChannel];
  const router = new OutboundRouter({ channels });

  return {
    tokenStore,
    channels,
    router,
    ...(apnsBootSkippedReason ? { apnsBootSkippedReason } : {}),
  };
}
