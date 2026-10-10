import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOutbound, routeOutbound } from '../../nexus/outbound/router.js';
import type { UserConfig } from '../../user-config.js';
import { PluginHost } from './host.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hooks = { log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} };
const raw = { channels: [{ type: 'channel-test', target: 'demo' }, { type: 'telegram' }],
  routes: { alert: ['channel-test', 'telegram'] }, primary: { alert: 'channel-test' }, fallback: { alert: 'telegram' } };

function plugin(root: string, id: string, connectors: string[]): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, contributes: { connectors: connectors.map(type => ({ id: type })) } }));
  writeFileSync(join(dir, 'plugin.ts'), `export default {
    name: '${id}', version: '1', initialState: () => ({}), panes: {},
    channelAdapters: [{ type: 'channel-test', capabilities: { send: true },
      parseConfig: (raw) => raw.type === 'channel-test' && typeof raw.target === 'string'
        ? { type: 'channel-test', target: raw.target } : undefined,
      send: async () => ({ type: 'channel-test', ok: true }) }],
  };`);
}

test('discovered plugin connector registers on activation, routes from config, and disposes on deactivation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-channel-host-'));
  roots.push(root);
  plugin(root, 'channel-provider', ['channel-test']);
  const host = new PluginHost(hooks, null, { userDir: root, packsDir: join(root, 'packs') });
  await host.discover();
  expect(normalizeOutbound(raw)?.channels.map(ch => ch.type)).toEqual(['telegram']);
  await host.activate('channel-provider');
  try {
    expect(normalizeOutbound(raw)?.channels.map(ch => ch.type)).toEqual(['channel-test', 'telegram']);
    const result = await routeOutbound({ raw: { outbound: raw } } as unknown as UserConfig,
      { text: 'plugin dispatch', kind: 'alert', markdown: false },
      { dedup: false, spill: text => ({ text, spilled: false }),
        telegramSend: async () => { throw new Error('backup must not be sent'); } });
    expect(result.channels).toEqual([{ type: 'channel-test', ok: true }]);
  } finally { await host.deactivate(); }
  expect(normalizeOutbound(raw)?.channels.map(ch => ch.type)).toEqual(['telegram']);
});

test('undeclared connector fails activation and leaves registry untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-channel-host-'));
  roots.push(root);
  plugin(root, 'undeclared-provider', []);
  const host = new PluginHost(hooks, null, { userDir: root, packsDir: join(root, 'packs') });
  await host.discover();
  expect(host.activate('undeclared-provider')).rejects.toThrow('must be declared');
  expect(normalizeOutbound(raw)?.channels.map(ch => ch.type)).toEqual(['telegram']);
});
