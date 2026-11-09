// W7-후속 (2026-05-12) — Outbound substrate boot helper tests.
//
// Cover the wire from `notifications.apns` user-config → ApnsTransport
// → iosPushChannel → OutboundRouter. Disk read + transport factory are
// both seam-injected, so the test never touches `node:fs` or `node:http2`.

import { describe, expect, test } from 'bun:test';
import {
  buildOutboundSubstrate,
  expandHome,
} from '../src/notifications/outbound-boot.js';
import type { ApnsUserConfig } from '../src/user-config/types.js';
import type { ApnsTransportOpts } from '../src/notification-apns.js';
import type { ApnsTransport } from '../src/showroom/outbound/channels/ios-push.js';

const STUB_CFG: ApnsUserConfig = {
  keyId: 'KID1234567',
  teamId: 'TID1234567',
  bundleId: 'com.elanous.app',
  keyPath: '~/.elanous/apns.p8',
};

function stubTransport(): ApnsTransport {
  return { async send() { return { ok: true }; } };
}

describe('expandHome', () => {
  test('expands leading ~/', () => {
    const out = expandHome('~/.elanous/apns.p8');
    expect(out.endsWith('/.elanous/apns.p8')).toBe(true);
    expect(out.startsWith('~')).toBe(false);
  });

  test('passes absolute path through unchanged', () => {
    expect(expandHome('/etc/apns.p8')).toBe('/etc/apns.p8');
  });
});

describe('buildOutboundSubstrate · no apns config', () => {
  test('boots with tokenStore + ios-push + web-push channels (G1)', () => {
    // G1: web-push channel registered alongside ios-push regardless of
    // APNs config — Web Push is independent of APNs cert.
    const sub = buildOutboundSubstrate({
      // Inject web-push deps so the channel doesn't reach into the real
      // VAPID surface during the test.
      webPushDeps: { subscriptionCount: () => 0 },
    });
    expect(sub.tokenStore).toBeDefined();
    expect(sub.channels.length).toBe(2);
    expect(sub.channels.map((c) => c.name)).toEqual(['ios-push', 'web-push']);
    expect(sub.router.registered()).toEqual(['ios-push', 'web-push']);
    expect(sub.apnsBootSkippedReason).toBe('apns-config-absent');
  });

  test('attempted send without transport resolves transport-not-configured', async () => {
    const sub = buildOutboundSubstrate({
      webPushDeps: { subscriptionCount: () => 0 },
    });
    // Pre-register a token so the channel's `available()` returns true.
    sub.tokenStore.upsert({
      channel: 'ios-push',
      deviceId: 'd1',
      token: 'abcd1234',
      registeredAt: 1,
    });
    const channel = sub.channels[0]!;
    const res = await channel.send({
      id: 'e1', source: 'showroom', urgency: 'normal', title: 't', ts: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('transport-not-configured');
    }
  });
});

describe('buildOutboundSubstrate · G1 · web-push channel registration', () => {
  test('web-push channel registered with injected deps', async () => {
    // The web-push channel must be wired with deps from opts so it can
    // be tested without reaching into the live VAPID surface.
    const sentPayloads: { title: string }[] = [];
    const sub = buildOutboundSubstrate({
      webPushDeps: {
        subscriptionCount: () => 2,
        sender: {
          async sendPushToAll(payload) {
            sentPayloads.push({ title: payload.title });
            return { attempted: 2, delivered: 2, removed: 0, errors: [] };
          },
        },
      },
    });
    const webPushChannel = sub.channels.find((c) => c.name === 'web-push')!;
    expect(webPushChannel).toBeDefined();
    expect(webPushChannel.available()).toBe(true);
    const res = await webPushChannel.send({
      id: 'e-g1', source: 'showroom', urgency: 'normal', title: 'hi', ts: 1,
    });
    expect(res.ok).toBe(true);
    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0]!.title).toBe('hi');
  });

  test('router.route() fans out to web-push when ios-push has no transport', async () => {
    const sentPayloads: { title: string }[] = [];
    const sub = buildOutboundSubstrate({
      webPushDeps: {
        subscriptionCount: () => 1,
        sender: {
          async sendPushToAll(payload) {
            sentPayloads.push({ title: payload.title });
            return { attempted: 1, delivered: 1, removed: 0, errors: [] };
          },
        },
      },
    });
    // No iOS token + no APNs config → ios-push not available.
    // Router falls through preference order to web-push (per
    // DEFAULT_PREFERENCE: live-activity → ios-push → web-push → …).
    const outcome = await sub.router.route({
      id: 'e1', source: 'showroom', urgency: 'normal', title: 'fallback test', ts: 1,
    });
    expect(outcome.delivered.length).toBe(1);
    expect(outcome.delivered[0]!.channel).toBe('web-push');
    expect(sentPayloads[0]!.title).toBe('fallback test');
  });

  test('web-push channel uses production sender when webPushDeps omitted', () => {
    // Production wire — caller doesn't pass webPushDeps; the channel
    // defaults internally. We can't call send() without VAPID setup
    // (would touch disk), so we only assert the channel registered.
    const sub = buildOutboundSubstrate({});
    const webPushChannel = sub.channels.find((c) => c.name === 'web-push');
    expect(webPushChannel).toBeDefined();
    expect(webPushChannel!.name).toBe('web-push');
  });
});

describe('buildOutboundSubstrate · with apns config', () => {
  test('reads PEM via injected fn + creates transport via factory', () => {
    const reads: string[] = [];
    const factoryCalls: ApnsTransportOpts[] = [];
    const sub = buildOutboundSubstrate({
      apnsConfig: STUB_CFG,
      readKeyFile: (p) => { reads.push(p); return '----- PEM CONTENT -----'; },
      createApnsTransportFn: (opts) => { factoryCalls.push(opts); return stubTransport(); },
    });
    expect(reads).toEqual(['~/.elanous/apns.p8']);
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0]!.keyId).toBe('KID1234567');
    expect(factoryCalls[0]!.teamId).toBe('TID1234567');
    expect(factoryCalls[0]!.bundleId).toBe('com.elanous.app');
    expect(factoryCalls[0]!.keyPem).toBe('----- PEM CONTENT -----');
    expect(sub.apnsBootSkippedReason).toBeUndefined();
  });

  test('forwards environment when present', () => {
    const calls: ApnsTransportOpts[] = [];
    buildOutboundSubstrate({
      apnsConfig: { ...STUB_CFG, environment: 'sandbox' },
      readKeyFile: () => 'pem',
      createApnsTransportFn: (opts) => { calls.push(opts); return stubTransport(); },
    });
    expect(calls[0]!.environment).toBe('sandbox');
  });

  test('disk read failure surfaces as apnsBootSkippedReason (no throw)', () => {
    const sub = buildOutboundSubstrate({
      apnsConfig: STUB_CFG,
      readKeyFile: () => { throw new Error('ENOENT: missing .p8'); },
    });
    expect(sub.apnsBootSkippedReason).toContain('ENOENT');
    // Channel still registers; send returns transport-not-configured.
    expect(sub.channels[0]!.name).toBe('ios-push');
  });

  test('transport factory failure also surfaces as apnsBootSkippedReason', () => {
    const sub = buildOutboundSubstrate({
      apnsConfig: STUB_CFG,
      readKeyFile: () => 'pem',
      createApnsTransportFn: () => { throw new Error('bad PEM'); },
    });
    expect(sub.apnsBootSkippedReason).toContain('bad PEM');
  });

  // Aligns DeviceTokenRecord with the schema in src/showroom/outbound/token-store.ts.

  test('happy path · transport wired · attempted send goes through transport', async () => {
    let sent = 0;
    const sub = buildOutboundSubstrate({
      apnsConfig: STUB_CFG,
      readKeyFile: () => 'pem',
      createApnsTransportFn: () => ({
        async send() { sent += 1; return { ok: true }; },
      }),
    });
    sub.tokenStore.upsert({
      channel: 'ios-push',
      deviceId: 'd1',
      token: 'abcd1234',
      registeredAt: 1,
    });
    const res = await sub.channels[0]!.send({
      id: 'e1', source: 'showroom', urgency: 'normal', title: 't', ts: 1,
    });
    expect(res.ok).toBe(true);
    expect(sent).toBe(1);
  });
});

describe('OutboundRouter end-to-end via substrate', () => {
  test('router.route() dispatches through registered ios-push channel', async () => {
    let received: { token: string; alertTitle: string } | null = null;
    const sub = buildOutboundSubstrate({
      apnsConfig: STUB_CFG,
      readKeyFile: () => 'pem',
      createApnsTransportFn: () => ({
        async send(token, payload) {
          received = { token, alertTitle: payload.aps.alert.title };
          return { ok: true };
        },
      }),
    });
    sub.tokenStore.upsert({
      channel: 'ios-push',
      deviceId: 'iphone-a',
      token: 'cafebabe',
      registeredAt: 1,
    });
    const outcome = await sub.router.route({
      id: 'e1',
      source: 'showroom',
      urgency: 'normal',
      title: 'elanous nudge',
      body: 'continue?',
      ts: 2,
    });
    expect(outcome.delivered.length).toBe(1);
    expect(outcome.delivered[0]!.channel).toBe('ios-push');
    expect(received).not.toBeNull();
    expect(received!.token).toBe('cafebabe');
    expect(received!.alertTitle).toBe('elanous nudge');
  });
});
