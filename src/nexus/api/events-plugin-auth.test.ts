import { expect, test } from 'bun:test';
import { createNexusState, type NexusEvent } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { handleSseEvents } from './events.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

function fixture(meta: NexusHttpServerOpts['metaApi'] = { bearerToken: 'test-operator-token', noAuth: false }) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts: NexusHttpServerOpts = { state, registry: new TabRegistry(state), eventBus: bus, metaApi: meta,
    membersApi: { handle: async () => Response.json({ error: 'unauthorized' }, { status: 401 }) } };
  const call = (query: string, headers: HeadersInit = {}) => routeRequest(new Request(`https://nexus.test/v1/events${query}`, { headers }),
    opts, {} as never, null, createDevProxyRuntimeRef());
  return { bus, call };
}
const operator = { authorization: 'Bearer test-operator-token' };
const plugin = (deviceId: unknown, commandId: string, kind = 'plugin.event') => ({ ts: 1, kind,
  detail: { data: { deviceId, commandId } } } as unknown as NexusEvent);

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  while (!out.includes(marker)) {
    const next = await reader.read();
    if (next.done) break;
    out += decoder.decode(next.value);
  }
  return out;
}

test.each(['plugin.event', 'plugin.event.logs', 'plugin', 'p', 'plugin.event,hud.segment'])
  ('anonymous plugin topic/prefix/mixed subscription is denied: %s', async topics => {
    // The topic boundary must survive a deployment's relaxed global API auth mode.
    const f = fixture({ noAuth: true });
    const response = await f.call(`?topics=${encodeURIComponent(topics)}&deviceId=device-a`);
    try {
      expect(response?.status).toBe(401);
      expect(f.bus.size()).toBe(0);
    } finally { await response?.body?.cancel(); }
  });

test.each(['', '?topics=', '?topics=hud.segment,pluginOther'])('public streams suppress plugin events independent of requested filters: %s', async query => {
  const bus = new NexusEventBus();
  const response = handleSseEvents(bus, new URL(`https://nexus.test/v1/events${query}`));
  const reader = response.body!.getReader();
  try {
    await reader.read();
    bus.publish(plugin('device-a', 'private-command'));
    bus.publish(plugin('device-b', 'private-nested', 'plugin.event.logs'));
    bus.publish({ ts: 2, kind: 'hud.segment', detail: { text: 'public-sentinel' } });
    const payload = await readUntil(reader, 'public-sentinel');
    expect(payload).toContain('public-sentinel');
    expect(payload).not.toContain('private-command');
    expect(payload).not.toContain('private-nested');
  } finally { await reader.cancel(); }
  expect(bus.size()).toBe(0);
});

test('configured operator bearer plus one explicit device receives only that device plugin namespace', async () => {
  const f = fixture();
  const response = await f.call('?topics=plugin.event&deviceId=device-a', operator);
  expect(response?.status).toBe(200);
  const reader = response!.body!.getReader();
  try {
    await reader.read();
    f.bus.publish(plugin('device-b', 'other-device-secret'));
    f.bus.publish(plugin(undefined, 'unbound-secret'));
    f.bus.publish(plugin(['device-a'], 'malformed-device-secret'));
    f.bus.publish({ ts: 1, kind: 'plugin.event', detail: { data: Object.assign(Object.create({ deviceId: 'device-a' }), { commandId: 'inherited-device-secret' }) } } as unknown as NexusEvent);
    f.bus.publish(plugin('device-a', 'chosen-command', 'plugin.event.logs'));
    const payload = await readUntil(reader, 'chosen-command');
    expect(payload).toContain('chosen-command');
    expect(payload).not.toContain('other-device-secret');
    expect(payload).not.toContain('unbound-secret');
    expect(payload).not.toContain('malformed-device-secret');
    expect(payload).not.toContain('inherited-device-secret');
  } finally { await reader.cancel(); }
  expect(f.bus.size()).toBe(0);
});

test.each(['', '&deviceId=', '&deviceId=device-a&deviceId=device-b', '&deviceId=%20device-a', '&deviceId=device-a%0A', '&deviceId=../device-a'])
  ('operator without an unambiguous device scope is denied: %s', async scope => {
    const f = fixture();
    const response = await f.call(`?topics=plugin.event${scope}`, operator);
    try { expect(response?.status).toBe(400); expect(f.bus.size()).toBe(0); }
    finally { await response?.body?.cancel(); }
  });

test('same-origin headers, member cookie, wrong bearer and noAuth never become private operator authority', async () => {
  const f = fixture();
  const deniedHeaders: HeadersInit[] = [
    { 'sec-fetch-site': 'same-origin' },
    { cookie: 'member-session=valid' },
    { authorization: 'Bearer wrong-token' },
  ];
  for (const headers of deniedHeaders) {
    const response = await f.call('?topics=plugin.event&deviceId=device-a', headers);
    try { expect(response?.status).toBe(401); expect(f.bus.size()).toBe(0); }
    finally { await response?.body?.cancel(); }
  }
  const noAuth = fixture({ noAuth: true, bearerToken: 'test-operator-token' });
  const response = await noAuth.call('?topics=plugin.event&deviceId=device-a', operator);
  try { expect(response?.status).toBe(401); expect(noAuth.bus.size()).toBe(0); }
  finally { await response?.body?.cancel(); }
});

test('member and existing operator-briefing scopes cannot subscribe to private device events implicitly', async () => {
  for (const scope of ['member-a', { operatorBriefings: true as const }]) {
    const bus = new NexusEventBus();
    const response = handleSseEvents(bus, new URL('https://nexus.test/v1/events'), scope);
    const reader = response.body!.getReader();
    try {
      await reader.read(); bus.publish(plugin('device-a', 'implicit-private'));
      bus.publish({ ts: 2, kind: 'hud.segment', detail: { text: 'public-sentinel' } });
      expect(await readUntil(reader, 'public-sentinel')).not.toContain('implicit-private');
    } finally { await reader.cancel(); }
  }
});
