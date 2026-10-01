import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../../user-config.js';
import { handleChatFastPathConfig } from './chat-fast-path-config.js';
import { startNexusHttpServer } from './http-server.js';
import { NexusEventBus } from './event-bus.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';

const root = mkdtempSync(join(tmpdir(), 'fast-path-config-'));
const priorXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = root;
const configPath = join(root, 'elanous', 'config.json');
beforeEach(() => {
  mkdirSync(join(root, 'elanous'), { recursive: true });
  rmSync(configPath, { force: true });
});
afterAll(() => {
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorXdg;
  rmSync(root, { recursive: true, force: true });
});

const url = 'http://localhost/v1/config/chat-fast-path';
const request = (method: string, body?: unknown) => new Request(url, {
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
});

test('empty config defaults true; PUT false persists and GET reflects it without losing sibling keys', async () => {
  expect(buildUserConfig(configPath).chat.fastPath).toBe(true);
  writeFileSync(configPath, JSON.stringify({ chat: { fastPath: 'false', autoCopyQaToClipboard: true }, custom: 17 }));
  expect(buildUserConfig(configPath).chat.fastPath).toBe(false);
  expect((await (await handleChatFastPathConfig(request('GET'))).json())).toEqual({ enabled: false });
  expect((await (await handleChatFastPathConfig(request('PUT', { enabled: true }))).json())).toEqual({ enabled: true });
  expect((await (await handleChatFastPathConfig(request('PUT', { enabled: false }))).json())).toEqual({ enabled: false });
  expect((await (await handleChatFastPathConfig(request('GET'))).json())).toEqual({ enabled: false });
  const stored = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(stored.chat.fastPath).toBe(false);
  expect(stored.chat.autoCopyQaToClipboard).toBe(true);
  expect(stored.custom).toBe(17);
});

test('HTTP route requires owner on both methods and round-trips the switch', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({ state, eventBus, registry: new TabRegistry(state),
    startPort: 48000 + Math.floor(Math.random() * 1000), portProbe: () => 'available',
    metaApi: { bearerToken: 'owner-secret', noAuth: false } });
  try {
    const endpoint = `${server.url}/v1/config/chat-fast-path`;
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    expect((await fetch(endpoint, { headers: crossSite })).status).toBe(401);
    expect((await fetch(endpoint, { method: 'PUT', headers: crossSite, body: '{' })).status).toBe(401);
    const headers = { ...crossSite, authorization: 'Bearer owner-secret', 'content-type': 'application/json' };
    expect(await (await fetch(endpoint, { headers })).json()).toEqual({ enabled: true });
    expect(await (await fetch(endpoint, { method: 'PUT', headers, body: '{"enabled":false}' })).json()).toEqual({ enabled: false });
    expect(await (await fetch(endpoint, { headers })).json()).toEqual({ enabled: false });
  } finally {
    server.stop();
  }
});

test('invalid PUT is rejected without changing config', async () => {
  writeFileSync(configPath, JSON.stringify({ chat: { fastPath: true } }));
  const response = await handleChatFastPathConfig(request('PUT', { enabled: 'false' }));
  expect(response.status).toBe(400);
  expect((await (await handleChatFastPathConfig(request('GET'))).json())).toEqual({ enabled: true });
});
