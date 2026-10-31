import { expect, test } from 'bun:test';
import { openDeliveryDb } from './delivery-ledger.js';
import { normalizeOutbound, outboundAdapters, registerOutboundAdapter, routeOutbound, type ChannelAdapter, type OutboundMsg } from './router.js';
import type { UserConfig } from '../../user-config.js';

const cfg = (outbound?: unknown) => ({ raw: outbound ? { outbound } : {} }) as UserConfig;
const msg = { text: 'channel check', kind: 'alert', markdown: false };
const config = {
  channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://example.test/webhook' }],
  routes: { alert: ['telegram', 'discord'] },
};

const deps = () => {
  const deliveryDb = openDeliveryDb(':memory:');
  const calls: string[] = [];
  const routerDeps = {
    deliveryDb, dedup: false, spill: (text: string) => ({ text, spilled: false }),
    telegramSend: (async () => { calls.push('telegram'); return true; }) as NonNullable<Parameters<typeof routeOutbound>[2]>['telegramSend'],
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      calls.push('discord');
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };
  return { calls, deliveryDb, routerDeps };
};

test('legacy fanout stays telegram + discord and keeps result shape', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    expect(await routeOutbound(cfg(config), msg, routerDeps)).toMatchObject({
      delivered: true, channels: [{ type: 'telegram', ok: true }, { type: 'discord', ok: true }],
    });
    expect(calls).toEqual(['telegram', 'discord']);
    const row = deliveryDb.prepare('SELECT kind, text, channels FROM deliveries').get() as { kind: string; text: string; channels: string };
    expect(row).toEqual({ kind: 'alert', text: msg.text, channels: JSON.stringify([
      { type: 'telegram', ok: true }, { type: 'discord', ok: true },
    ]) });
  } finally { deliveryDb.close(); }
});

test('primary succeeds without backup; failure uses configured backup in order', async () => {
  const outbound = { ...config, primary: { alert: 'telegram' }, fallback: { alert: 'discord' } };
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    expect(normalizeOutbound(outbound)?.primary?.alert).toBe('telegram');
    expect((await routeOutbound(cfg(outbound), msg, routerDeps)).channels).toEqual([{ type: 'telegram', ok: true }]);
    expect(calls).toEqual(['telegram']);
    routerDeps.telegramSend = (async () => { calls.push('telegram'); return false; }) as typeof routerDeps.telegramSend;
    expect((await routeOutbound(cfg(outbound), msg, routerDeps)).channels).toEqual([
      { type: 'telegram', ok: false, error: 'not-configured' }, { type: 'discord', ok: true },
    ]);
    expect(calls).toEqual(['telegram', 'telegram', 'discord']);
  } finally { deliveryDb.close(); }
});

test('a main channel the route cannot carry is reported not-routed and only the backup is tried — never legacy fan-out', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const outbound = { ...config, primary: { alert: 'slack' }, fallback: { alert: 'discord' } };
    expect(normalizeOutbound(outbound)?.primary).toEqual({ alert: 'slack' });
    const result = await routeOutbound(cfg(outbound), msg, routerDeps);
    expect(result.channels).toEqual([{ type: 'slack', ok: false, error: 'not-routed' }, { type: 'discord', ok: true }]);
    expect(calls).toEqual(['discord']);
    expect(result.delivered).toBe(true);
  } finally { deliveryDb.close(); }
});

test('main outside the current route with the backup inside sends the backup alone', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const outbound = { ...config, routes: { alert: ['discord'] }, primary: { alert: 'telegram' }, fallback: { alert: 'discord' } };
    const result = await routeOutbound(cfg(outbound), msg, routerDeps);
    expect(result.channels).toEqual([{ type: 'telegram', ok: false, error: 'not-routed' }, { type: 'discord', ok: true }]);
    expect(calls).toEqual(['discord']);
  } finally { deliveryDb.close(); }
});

test('main and backup both outside the route fail without sending anywhere', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const outbound = { ...config, routes: { alert: ['telegram'] }, primary: { alert: 'slack' }, fallback: { alert: 'teams' } };
    const result = await routeOutbound(cfg(outbound), msg, routerDeps);
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([{ type: 'slack', ok: false, error: 'not-routed' }, { type: 'teams', ok: false, error: 'not-routed' }]);
    expect(calls).toEqual([]);
  } finally { deliveryDb.close(); }
});

test('a route naming only unconfigured channels records not-routed for the selection instead of an empty success-less result', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const outbound = { ...config, routes: { alert: ['slack'] }, primary: { alert: 'slack' }, fallback: { alert: 'teams' } };
    const result = await routeOutbound(cfg(outbound), msg, routerDeps);
    expect(result.channels).toEqual([{ type: 'slack', ok: false, error: 'not-routed' }, { type: 'teams', ok: false, error: 'not-routed' }]);
    expect(calls).toEqual([]);
  } finally { deliveryDb.close(); }
});

test('a backup without a main never reaches a channel outside the allowed route, even when the fan-out failed', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const failing = { ...routerDeps, telegramSend: (async () => { calls.push('telegram'); return false; }) as typeof routerDeps.telegramSend };
    const outbound = { ...config, roleRoutes: { OP: ['telegram'] }, fallback: { OP: 'discord', alert: 'discord' } };
    const role = await routeOutbound(cfg(outbound), { ...msg, role: 'OP' }, failing);
    expect(role.channels.map(c => [c.type, c.ok])).toEqual([['telegram', false]]);
    expect(calls).toEqual(['telegram']);
    calls.length = 0;
    const kind = await routeOutbound(cfg({ ...config, routes: { alert: ['telegram'] }, fallback: { alert: 'discord' } }), msg, failing);
    expect(kind.channels.map(c => c.type)).toEqual(['telegram']);
    expect(calls).toEqual(['telegram']);
  } finally { deliveryDb.close(); }
});

test('role route and role main/backup override only messages carrying that role', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  const outbound = { ...config, roleRoutes: { OP: ['discord', 'telegram'] },
    primary: { OP: 'discord' }, fallback: { OP: 'telegram' } };
  try {
    expect(normalizeOutbound(outbound)?.roleRoutes?.OP).toEqual(['discord', 'telegram']);
    expect((await routeOutbound(cfg(outbound), { ...msg, role: 'OP' }, routerDeps)).channels).toEqual([{ type: 'discord', ok: true }]);
    expect(calls).toEqual(['discord']);
    expect((await routeOutbound(cfg(outbound), msg, routerDeps)).channels).toEqual([
      { type: 'telegram', ok: true }, { type: 'discord', ok: true },
    ]);
  } finally { deliveryDb.close(); }
});

test('explicitly empty role route suppresses primary and backup without changing kind route', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const outbound = { ...config, roleRoutes: { OP: [] }, primary: { OP: 'telegram' }, fallback: { OP: 'discord' } };
    expect((await routeOutbound(cfg(outbound), { ...msg, role: 'OP' }, routerDeps)).channels).toEqual([]);
    expect(calls).toEqual([]);
    expect((await routeOutbound(cfg(outbound), msg, routerDeps)).channels).toEqual([
      { type: 'telegram', ok: true }, { type: 'discord', ok: true },
    ]);
  } finally { deliveryDb.close(); }
});

test('explicitly empty route suppresses both primary and fallback', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const result = await routeOutbound(cfg({ ...config, routes: { alert: [] }, primary: { alert: 'telegram' }, fallback: { alert: 'discord' } }), msg, routerDeps);
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([]);
    expect(calls).toEqual([]);
  } finally { deliveryDb.close(); }
});

test('a connector exception containing a credential-bearing webhook URL is not returned or recorded', async () => {
  const { deliveryDb, routerDeps } = deps();
  const secret = 'https://example.test/webhook/secret-token';
  try {
    routerDeps.fetchImpl = (async () => { throw new Error(`fetch failed for ${secret}`); }) as unknown as typeof fetch;
    const result = await routeOutbound(cfg({ channels: [{ type: 'discord', webhookUrl: secret }] }), msg, routerDeps);
    expect(result.channels).toEqual([{ type: 'discord', ok: false, error: 'delivery-failed' }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(deliveryDb.prepare('SELECT * FROM deliveries').all())).not.toContain(secret);
  } finally { deliveryDb.close(); }
});

test('built-in connectors declare receive only for existing bot paths, never for pushcut', () => {
  expect([...outboundAdapters.keys()]).toEqual(['telegram', 'discord', 'pushcut']);
  const expectedKeys = ['send', 'receive', 'thread', 'topic', 'persona', 'channelLifecycle', 'permissions', 'commands',
    'attachments', 'buttons', 'choices', 'deliveryConfirmation', 'rateLimit'].sort();
  for (const adapter of outboundAdapters.values()) {
    expect(Object.keys(adapter.capabilities).sort()).toEqual(expectedKeys);
    expect(Object.values(adapter.capabilities).every(value => typeof value === 'boolean')).toBe(true);
    expect(adapter.capabilities.send).toBe(true);
    expect(adapter.capabilities.receive).toBe(adapter.type !== 'pushcut');
    expect(adapter.capabilities.buttons).toBe(false);
    expect(typeof adapter.receive).toBe(adapter.type === 'pushcut' ? 'undefined' : 'function');
  }
});

test('a failed primary without a configured fallback returns the original failure', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    routerDeps.telegramSend = (async () => { calls.push('telegram'); return false; }) as typeof routerDeps.telegramSend;
    const result = await routeOutbound(cfg({ ...config, primary: { alert: 'telegram' } }), msg, routerDeps);
    expect(result).toMatchObject({ delivered: false, channels: [{ type: 'telegram', ok: false, error: 'not-configured' }] });
    expect(calls).toEqual(['telegram']);
  } finally { deliveryDb.close(); }
});

test('registered connector is selected as main, backs up on failure, and is removed on deactivation', async () => {
  const { deliveryDb, routerDeps } = deps();
  let calls = 0;
  let succeed = true;
  const adapter: ChannelAdapter = {
    ...outboundAdapters.get('telegram')!, type: 'slack',
    parseConfig: raw => raw.type === 'slack' && typeof raw.target === 'string'
      ? { type: 'slack', target: raw.target } : undefined,
    send: async () => { calls++; return { type: 'slack', ok: succeed }; },
  };
  const outbound = { channels: [{ type: 'slack', target: 'demo' }, { type: 'telegram' }],
    routes: { alert: ['slack', 'telegram'] }, primary: { alert: 'slack' }, fallback: { alert: 'telegram' } };
  try {
    expect(normalizeOutbound(outbound)?.channels).toEqual([{ type: 'telegram' }]);
    const dispose = registerOutboundAdapter(adapter);
    try {
      expect(() => registerOutboundAdapter(adapter)).toThrow('duplicate');
      expect(() => registerOutboundAdapter({ ...adapter, type: 'telegram' })).toThrow('duplicate');
      expect(() => registerOutboundAdapter({ ...adapter, type: 'invalid-receiver', receive: undefined,
        capabilities: { ...adapter.capabilities, receive: true } })).toThrow('invalid');
      const missingCapability = { ...adapter.capabilities };
      delete (missingCapability as Partial<ChannelAdapter['capabilities']>).choices;
      const malformedCapabilities: ChannelAdapter['capabilities'][] = [
        missingCapability as ChannelAdapter['capabilities'],
        { ...adapter.capabilities, unexpected: false } as ChannelAdapter['capabilities'],
        { ...adapter.capabilities, buttons: 'yes' } as unknown as ChannelAdapter['capabilities'],
      ];
      malformedCapabilities.forEach((capabilities, index) => {
        expect(() => registerOutboundAdapter({ ...adapter, type: `invalid-capabilities-${index}`, capabilities }))
          .toThrow('invalid');
      });
      const accessorCapabilities = { ...adapter.capabilities };
      Object.defineProperty(accessorCapabilities, 'thread', { enumerable: true, get: () => false });
      expect(() => registerOutboundAdapter({ ...adapter, type: 'invalid-capabilities-accessor',
        capabilities: accessorCapabilities })).toThrow('invalid');
      const inheritedCapabilities = Object.assign(Object.create({ inherited: false }), adapter.capabilities);
      const disposeInherited = registerOutboundAdapter({ ...adapter, type: 'valid-capabilities-inherited',
        capabilities: inheritedCapabilities });
      disposeInherited();
      const symbolCapabilities = { ...adapter.capabilities, [Symbol('unexpected')]: false };
      expect(() => registerOutboundAdapter({ ...adapter, type: 'invalid-capabilities-symbol',
        capabilities: symbolCapabilities })).toThrow('invalid');
      const throwingProxy = new Proxy({ ...adapter.capabilities }, { ownKeys: () => { throw new Error('proxy trap'); } });
      expect(() => registerOutboundAdapter({ ...adapter, type: 'invalid-capabilities-proxy',
        capabilities: throwingProxy })).toThrow('invalid');
      const throwingAdapterGetter = { ...adapter, type: 'invalid-capabilities-getter' };
      Object.defineProperty(throwingAdapterGetter, 'capabilities', { get: () => { throw new Error('getter trap'); } });
      expect(() => registerOutboundAdapter(throwingAdapterGetter as ChannelAdapter)).toThrow('invalid');
      expect(normalizeOutbound(outbound)?.channels.map(ch => ch.type)).toEqual(['slack', 'telegram']);
      expect((await routeOutbound(cfg(outbound), msg, routerDeps)).channels).toEqual([{ type: 'slack', ok: true }]);
      succeed = false;
      expect((await routeOutbound(cfg(outbound), msg, routerDeps)).channels).toEqual([
        { type: 'slack', ok: false, error: 'delivery-failed' }, { type: 'telegram', ok: true },
      ]);
      expect(calls).toBe(2);
    } finally { dispose(); }
    expect(normalizeOutbound(outbound)?.channels).toEqual([{ type: 'telegram' }]);
  } finally { deliveryDb.close(); }
});

test('unsupported outbound metadata is rejected before a connector can silently drop it', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const result = await routeOutbound(cfg(config), { ...msg, threadId: 'thread-7', attachments: [{ url: 'https://example.test/file' }] }, routerDeps);
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([
      { type: 'telegram', ok: false, error: 'unsupported-capability' },
      { type: 'discord', ok: false, error: 'unsupported-capability' },
    ]);
    expect(calls).toEqual([]);
  } finally { deliveryDb.close(); }
});

test('explicit empty metadata still requires connector capabilities', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  const cases: Array<Partial<OutboundMsg>> = [
    { attachments: [] },
    { buttons: [] },
    { choices: [] },
    { threadId: '' },
  ];
  try {
    for (const metadata of cases) {
      const result = await routeOutbound(cfg(config), { ...msg, ...metadata }, routerDeps);
      expect(result.delivered).toBe(false);
      expect(result.channels).toEqual([
        { type: 'telegram', ok: false, error: 'unsupported-capability' },
        { type: 'discord', ok: false, error: 'unsupported-capability' },
      ]);
    }
    expect(calls).toEqual([]);
  } finally { deliveryDb.close(); }
});

test('invalid permission actions and permission-check errors fail closed before send', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  const checked: string[] = [];
  const base = outboundAdapters.get('telegram')!;
  const adapter: ChannelAdapter = {
    ...base,
    type: 'permission-test',
    capabilities: { ...base.capabilities, permissions: true },
    parseConfig: raw => raw.type === 'permission-test' ? { type: 'permission-test' } : undefined,
    checkPermission: async action => { checked.push(action); throw new Error('sensitive permission detail'); },
    send: async () => { calls.push('permission-test'); return { type: 'permission-test', ok: true }; },
  };
  const dispose = registerOutboundAdapter(adapter);
  try {
    const outbound = { channels: [{ type: 'permission-test' }] };
    const invalid = await routeOutbound(cfg(outbound), { ...msg, permissionAction: '  ' }, routerDeps);
    expect(invalid.channels).toEqual([{ type: 'permission-test', ok: false, error: 'invalid-permission-action' }]);
    const failed = await routeOutbound(cfg(outbound), { ...msg, permissionAction: 'delete-channel' }, routerDeps);
    expect(failed.channels).toEqual([{ type: 'permission-test', ok: false, error: 'permission-check-failed' }]);
    expect(checked).toEqual(['delete-channel']);
    expect(calls).toEqual([]);
  } finally { dispose(); deliveryDb.close(); }
});

test('unsupported permission action is reported before validating its payload', async () => {
  const { calls, deliveryDb, routerDeps } = deps();
  try {
    const result = await routeOutbound(cfg({ channels: [{ type: 'telegram' }] }),
      { ...msg, permissionAction: '  ' }, routerDeps);
    expect(result.channels).toEqual([{ type: 'telegram', ok: false, error: 'unsupported-capability' }]);
    expect(calls).toEqual([]);
  } finally { deliveryDb.close(); }
});

test('capable connectors receive outbound metadata only after the requested permission check succeeds', async () => {
  const { deliveryDb, routerDeps } = deps();
  const received: unknown[] = [];
  const checked: string[] = [];
  const base = outboundAdapters.get('telegram')!;
  const adapter: ChannelAdapter = {
    ...base,
    type: 'contract-test',
    capabilities: { ...base.capabilities, thread: true, topic: true, persona: true, permissions: true,
      attachments: true, buttons: true, choices: true },
    parseConfig: raw => raw.type === 'contract-test' ? { type: 'contract-test' } : undefined,
    checkPermission: async action => { checked.push(action); return true; },
    send: async (_channel, message) => { received.push(message); return { type: 'contract-test', ok: true }; },
  };
  const payload = { ...msg, threadId: 'thread-7', topicId: 'topic-3', persona: { name: 'MK' },
    attachments: [{ url: 'https://example.test/file', name: 'brief.txt' }],
    buttons: [{ label: 'Open', value: 'open' }], choices: [{ label: 'Later', value: 'later' }], permissionAction: 'send:release' };
  try {
    const remove = registerOutboundAdapter(adapter);
    try {
      const result = await routeOutbound(cfg({ channels: [{ type: 'contract-test' }], routes: { alert: ['contract-test'] } }), payload, routerDeps);
      expect(result.delivered).toBe(true);
      expect(received).toEqual([payload]);
      expect(checked).toEqual(['send:release']);
    } finally { remove(); }
  } finally { deliveryDb.close(); }
});

test('denied or unavailable channel permission checks never call the connector', async () => {
  const { deliveryDb, routerDeps } = deps();
  const checked: string[] = [];
  const base = outboundAdapters.get('telegram')!;
  const adapter: ChannelAdapter = {
    ...base,
    type: 'permission-test',
    capabilities: { ...base.capabilities, permissions: true },
    parseConfig: raw => raw.type === 'permission-test' ? { type: 'permission-test' } : undefined,
    checkPermission: async action => { checked.push(action); return false; },
    send: async () => { throw new Error('send must not run'); },
  };
  try {
    const remove = registerOutboundAdapter(adapter);
    try {
      const result = await routeOutbound(cfg({ channels: [{ type: 'permission-test' }], routes: { alert: ['permission-test'] } }),
        { ...msg, permissionAction: 'send:release' }, routerDeps);
      expect(result.delivered).toBe(false);
      expect(result.channels).toEqual([{ type: 'permission-test', ok: false, error: 'permission-denied' }]);
      expect(checked).toEqual(['send:release']);
    } finally { remove(); }
  } finally { deliveryDb.close(); }
});

test('plugin-provided failure results cannot echo connector credentials to callers', async () => {
  const { deliveryDb, routerDeps } = deps();
  const adapter: ChannelAdapter = {
    ...outboundAdapters.get('telegram')!, type: 'slack',
    parseConfig: raw => raw.type === 'slack' ? { type: 'slack' } : undefined,
    send: async () => ({ type: 'slack', ok: false, error: 'secret-from-connector' }),
  };
  const dispose = registerOutboundAdapter(adapter);
  try {
    const result = await routeOutbound(cfg({ channels: [{ type: 'slack' }] }), msg, routerDeps);
    expect(result.channels).toEqual([{ type: 'slack', ok: false, error: 'delivery-failed' }]);
    expect(JSON.stringify(result)).not.toContain('secret-from-connector');
  } finally { dispose(); deliveryDb.close(); }
});

test('plugin exceptions cannot echo connector credentials to callers', async () => {
  const { deliveryDb, routerDeps } = deps();
  const adapter: ChannelAdapter = {
    ...outboundAdapters.get('telegram')!, type: 'slack',
    parseConfig: raw => raw.type === 'slack' ? { type: 'slack' } : undefined,
    send: async () => { throw new Error('secret-from-connector'); },
  };
  const dispose = registerOutboundAdapter(adapter);
  try {
    const result = await routeOutbound(cfg({ channels: [{ type: 'slack' }] }), msg, routerDeps);
    expect(result.channels).toEqual([{ type: 'slack', ok: false, error: 'delivery-failed' }]);
    expect(JSON.stringify(result)).not.toContain('secret-from-connector');
  } finally { dispose(); deliveryDb.close(); }
});

test('injected connector is reached through the same router', async () => {
  const { deliveryDb, routerDeps } = deps();
  const called: string[] = [];
  const custom: ChannelAdapter = {
    ...outboundAdapters.get('telegram')!, type: 'telegram',
    send: async () => { called.push('connector'); return { type: 'telegram', ok: true }; },
  };
  try {
    const result = await routeOutbound(cfg({ ...config, primary: { alert: 'telegram' }, fallback: { alert: 'missing' } }), msg,
      { ...routerDeps, adapters: new Map([['telegram', custom]]) });
    expect(result.channels).toEqual([{ type: 'telegram', ok: true }]);
    expect(called).toEqual(['connector']);
  } finally { deliveryDb.close(); }
});
