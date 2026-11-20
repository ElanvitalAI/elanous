import { DebugForwarder } from './debug';
import { afterEach, expect, test } from 'bun:test';
import { DaemonClient, SurfaceUnavailableError } from './daemon-client';
import { surfaceForwards } from './daemon-config';
import { BARE_CAPABILITIES_META_NAME, bareCapabilitiesContent, BARE_WEBCHAT_FORWARDED_API_PATHS } from '../../../../src/relay/bare-surface';
import { withFakeFetchDevice } from '../test-devices/fake-fetch';

// Fake document: bare meta + capabilities meta delivered by the server (or neither).
function setDoc(metas: Record<string, string>): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (sel: string) => {
        const m = /meta\[name="([^"]+)"\]/.exec(sel);
        const content = m ? metas[m[1]!] : undefined;
        return content === undefined ? null : { getAttribute: () => content };
      },
    },
  });
}
afterEach(() => { delete (globalThis as { document?: unknown }).document; });
const bareDoc = { 'elanous-bare-webchat': '1', [BARE_CAPABILITIES_META_NAME]: bareCapabilitiesContent() };
const client = () => new DaemonClient({ baseUrl: 'http://daemon', token: 't', provider: '' });
const json = () => new Response('{}', { headers: { 'content-type': 'application/json' } });

test('non-bare: every path is forwarded', () => {
  setDoc({});
  expect(surfaceForwards('/v1/seat-requests')).toBe(true);
});

test('bare: only the server-delivered set is forwarded; query ignored', () => {
  setDoc(bareDoc);
  expect(surfaceForwards('/v1/seat-requests')).toBe(false);
  expect(surfaceForwards('/v1/health')).toBe(false);
  for (const p of BARE_WEBCHAT_FORWARDED_API_PATHS) expect(surfaceForwards(`${p}?x=1`)).toBe(true);
});

test('bare: client call to an unforwarded path makes zero fetches and rejects typed', async () => {
  setDoc(bareDoc);
  await withFakeFetchDevice([{ url: '/v1/seat-requests', response: json }], async (device) => {
    await expect(client().fetchJson('/v1/seat-requests')).rejects.toBeInstanceOf(SurfaceUnavailableError);
    await expect(client().fetchResponse('/v1/sessions/store')).rejects.toBeInstanceOf(SurfaceUnavailableError);
    expect(device.calls()).toEqual([]);
  });
});

test('bare: the chat pair still goes through the client', async () => {
  setDoc(bareDoc);
  await withFakeFetchDevice([{ url: '/v1/chat/events', response: json }], async (device) => {
    await client().fetchJson('/v1/chat/events');
    expect(device.calls().map((c) => c.url)).toEqual(['http://daemon/v1/chat/events']);
  });
});

test('non-bare: client call to /v1/seat-requests is unchanged (reaches fetch)', async () => {
  setDoc({});
  await withFakeFetchDevice([{ url: '/v1/seat-requests', response: json }], async (device) => {
    await client().fetchJson('/v1/seat-requests');
    expect(device.calls().map((c) => c.url)).toEqual(['http://daemon/v1/seat-requests']);
  });
});

test('bare meta without capabilities meta (older server): falls back to the shared default set — pollers gated, chat pair kept', () => {
  setDoc({ 'elanous-bare-webchat': '1' });
  expect(surfaceForwards('/v1/seat-requests')).toBe(false);
  expect(surfaceForwards('/v1/prompt/stream')).toBe(true);
  expect(surfaceForwards('/v1/chat/events?sessionId=s1')).toBe(true);
});

test('bare: debug batch forwarder makes zero fetches and drains its queue (handled)', async () => {
  setDoc(bareDoc);
  await withFakeFetchDevice([{ url: '/v1/debug-logs/batch', response: json }], async (device) => {
    const f = new DebugForwarder();
    f.push({ ts: 1, level: 'info', category: 'c', message: 'm' } as never);
    await f.flush();
    f.beaconFlush();
    expect(device.calls()).toEqual([]);
    expect(f.pending).toBe(0);
  });
});

test('SurfaceUnavailableError looks like the old relay 404 failure: message Not Found, no status', async () => {
  const error = new SurfaceUnavailableError('/v1/personas/x');
  expect(error.message).toBe('Not Found');
  expect('status' in error).toBe(false);
  expect(error.message.includes('404')).toBe(false);
});
