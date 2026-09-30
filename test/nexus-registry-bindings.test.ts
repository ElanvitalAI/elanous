// NEXUS · subsystem registry / bindings tests (Phase N-3.5 PR τ)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setBinding,
  getBinding,
  deleteBinding,
  listBindings,
  listChannels,
  setChannelDescription,
  deleteChannel,
} from '../src/nexus/registry/store.js';
import {
  BindingStoreError,
  validateChannel,
  validateKey,
} from '../src/nexus/registry/types.js';
import { parseBindingPath } from '../src/nexus/api/registry.js';
import { nexusBindingsDir } from '../src/nexus/paths.js';
import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import { ensureAuthToken } from '../src/auth/acp-token.js';
import { makeTestSpawnBackend } from '../src/nexus/supervisor/spawn.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

let tmpRoot: string;
let prevNexus: string | undefined;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n35-reg-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  setElanousConfigDir(tmpRoot);
});
afterEach(() => {
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  resetElanousConfigDir();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateChannel / validateKey', () => {
  test('valid channels accepted', () => {
    for (const ch of ['pushcut', 'discord', 'slack-workspace', 'a_b', 'x123']) {
      expect(validateChannel(ch)).toBeNull();
    }
  });

  test('invalid channels rejected', () => {
    for (const bad of ['UPPER', '1starts', '-dash', 'a/b', 'a.b', '../escape', '']) {
      expect(validateChannel(bad)).not.toBeNull();
    }
  });

  test('valid keys accepted (incl. URL-ish + slashes)', () => {
    for (const k of ['simple', 'webhook-token-abc-123', 'token:1', 'a/b/c', 'channel.id']) {
      expect(validateKey(k)).toBeNull();
    }
  });

  test('invalid keys rejected', () => {
    for (const bad of ['', 'has space', 'has?query', 'too' + 'x'.repeat(300)]) {
      expect(validateKey(bad)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('setBinding / getBinding / deleteBinding · file store', () => {
  test('create + read round-trip', () => {
    const r = setBinding('pushcut', 'token-abc', { sessionId: 'sess-1', label: 'iPhone Camera' });
    expect(r.outcome).toBe('created');
    expect(r.binding.sessionId).toBe('sess-1');
    expect(r.binding.label).toBe('iPhone Camera');
    expect(r.binding.updatedAt).toBeDefined();
    const got = getBinding('pushcut', 'token-abc')!;
    expect(got.sessionId).toBe('sess-1');
  });

  test('update preserves untouched fields', () => {
    setBinding('discord', 'channel-99', { sessionId: 'sess-A', label: 'team', meta: { keep: 1 } });
    const r = setBinding('discord', 'channel-99', { label: 'new-label' });
    expect(r.outcome).toBe('updated');
    expect(r.binding.sessionId).toBe('sess-A'); // preserved
    expect(r.binding.label).toBe('new-label');
    expect(r.binding.meta).toEqual({ keep: 1 }); // preserved (no replace)
  });

  test('mergeMeta combines instead of replacing', () => {
    setBinding('slack', 'wks-1', { meta: { team: 'A', region: 'us' } });
    setBinding('slack', 'wks-1', { meta: { region: 'eu' }, mergeMeta: true });
    expect(getBinding('slack', 'wks-1')!.meta).toEqual({ team: 'A', region: 'eu' });
  });

  test('replace meta when mergeMeta=false (default for setBinding)', () => {
    setBinding('slack', 'wks-2', { meta: { a: 1, b: 2 } });
    setBinding('slack', 'wks-2', { meta: { c: 3 } });
    expect(getBinding('slack', 'wks-2')!.meta).toEqual({ c: 3 });
  });

  test('deleteBinding removes + returns true once', () => {
    setBinding('pushcut', 'token-x', { sessionId: 'A' });
    expect(deleteBinding('pushcut', 'token-x')).toBe(true);
    expect(deleteBinding('pushcut', 'token-x')).toBe(false);
    expect(getBinding('pushcut', 'token-x')).toBeUndefined();
  });

  test('listBindings returns array per channel', () => {
    setBinding('pushcut', 'a', { sessionId: 'A' });
    setBinding('pushcut', 'b', { sessionId: 'B' });
    setBinding('discord', 'c', {});
    const pcut = listBindings('pushcut');
    expect(pcut.map((b) => b.key).sort()).toEqual(['a', 'b']);
    expect(listBindings('discord').map((b) => b.key)).toEqual(['c']);
    expect(listBindings('empty')).toEqual([]);
  });

  test('invalid channel throws via setBinding', () => {
    expect(() => setBinding('UPPER', 'k', {})).toThrow(BindingStoreError);
  });

  test('invalid key throws via setBinding', () => {
    expect(() => setBinding('ok', 'has space', {})).toThrow(BindingStoreError);
  });

  test('file mode 0o600', () => {
    setBinding('pushcut', 'token-mode', {});
    const path = nexusBindingsDir('pushcut');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('keys with slashes round-trip', () => {
    setBinding('webhooks', 'a/b/c', { sessionId: 'X' });
    expect(getBinding('webhooks', 'a/b/c')?.sessionId).toBe('X');
  });
});

describe('listChannels · summary view', () => {
  test('empty when no channels written', () => {
    expect(listChannels()).toEqual([]);
  });

  test('lists channels alphabetically with counts', () => {
    setBinding('pushcut', 'a', {});
    setBinding('pushcut', 'b', {});
    setBinding('discord', 'c', {});
    setBinding('zebra', 'd', {});
    const summaries = listChannels();
    expect(summaries.map((s) => s.channel)).toEqual(['discord', 'pushcut', 'zebra']);
    const pcut = summaries.find((s) => s.channel === 'pushcut')!;
    expect(pcut.bindingCount).toBe(2);
  });

  test('description set via setChannelDescription surfaces in list', () => {
    setBinding('pushcut', 'a', {});
    setChannelDescription('pushcut', 'iPhone webhooks');
    expect(listChannels().find((s) => s.channel === 'pushcut')?.description).toBe('iPhone webhooks');
  });

  test('skips files with invalid channel name', () => {
    setBinding('pushcut', 'a', {});
    // Drop a malformed file directly into the dir
    const fs = require('node:fs');
    fs.writeFileSync(nexusBindingsDir('UPPER'), '{}');
    const summaries = listChannels();
    expect(summaries.map((s) => s.channel)).toEqual(['pushcut']);
  });
});

describe('deleteChannel', () => {
  test('removes the file', () => {
    setBinding('temp', 'a', {});
    expect(existsSync(nexusBindingsDir('temp'))).toBe(true);
    expect(deleteChannel('temp')).toBe(true);
    expect(existsSync(nexusBindingsDir('temp'))).toBe(false);
  });

  test('false when missing', () => {
    expect(deleteChannel('never-existed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseBindingPath
// ---------------------------------------------------------------------------

describe('parseBindingPath', () => {
  test('root path → empty parsed', () => {
    expect(parseBindingPath('/v1/registry/bindings')).toEqual({});
    expect(parseBindingPath('/v1/registry/bindings/')).toEqual({});
  });

  test('channel only', () => {
    expect(parseBindingPath('/v1/registry/bindings/pushcut')).toEqual({ channel: 'pushcut' });
  });

  test('channel + key', () => {
    expect(parseBindingPath('/v1/registry/bindings/pushcut/token-abc')).toEqual({
      channel: 'pushcut', key: 'token-abc',
    });
  });

  test('key with slashes is preserved (rejoin)', () => {
    expect(parseBindingPath('/v1/registry/bindings/webhooks/a/b/c')).toEqual({
      channel: 'webhooks', key: 'a/b/c',
    });
  });

  test('non-binding path → null', () => {
    expect(parseBindingPath('/v1/nexus/tabs')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP routes integration
// ---------------------------------------------------------------------------

describe('HTTP /v1/registry/bindings', () => {
  let handle: RunNexusHandle | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    writeFileSync(join(tmpRoot, 'acp-token'), 'test-token');
    expect(ensureAuthToken().token).toBe('test-token');
    handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      skipRuntimeApi: false,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipDiscordChannel: true,
      skipTerminalChannel: true,
      skipIntentPrediction: true,
      toolCwd: tmpRoot,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      supervisorSpawnBackend: makeTestSpawnBackend(),
      mcpEnabled: false,
      skipEnvMigration: true,
      cleanGhostTailscaleServeFn: async () => {},
    });
    baseUrl = handle!.httpServer!.url;
  });
  afterEach(() => { handle?.release(); handle = undefined; });

  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer test-token');
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: body as any };
  }

  test('without credentials, registry route is denied before dispatch', async () => {
    const response = await fetch(`${baseUrl}/v1/registry/bindings`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  test('runNexus boots authenticated bindings route with existing bindings', async () => {
    setBinding('pushcut', 'existing', { sessionId: 'existing-session' });
    const response = await call('/v1/registry/bindings?channel=pushcut');
    expect(response.status).toBe(200);
    expect(response.body.bindings).toEqual([
      expect.objectContaining({ key: 'existing', sessionId: 'existing-session' }),
    ]);
  });

  test('GET /v1/registry/bindings → empty channels', async () => {
    const res = await call('/v1/registry/bindings');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([]);
  });

  test('POST channel + key → 201 created', async () => {
    const res = await call('/v1/registry/bindings/pushcut/token-x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-1', label: 'iPhone' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
    expect(res.body.binding.sessionId).toBe('sess-1');
  });

  test('POST same key again → 200 updated (replace meta)', async () => {
    await call('/v1/registry/bindings/pushcut/k', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { a: 1 } }),
    });
    const res = await call('/v1/registry/bindings/pushcut/k', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { b: 2 } }),
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('updated');
    expect(res.body.binding.meta).toEqual({ b: 2 }); // POST default = replace
  });

  test('PATCH defaults to mergeMeta', async () => {
    await call('/v1/registry/bindings/discord/channel-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { a: 1 } }),
    });
    const res = await call('/v1/registry/bindings/discord/channel-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { b: 2 } }),
    });
    expect(res.status).toBe(200);
    expect(res.body.binding.meta).toEqual({ a: 1, b: 2 }); // merged
  });

  test('GET single binding', async () => {
    await call('/v1/registry/bindings/pushcut/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'S', label: 'L' }),
    });
    const res = await call('/v1/registry/bindings/pushcut/x');
    expect(res.status).toBe(200);
    expect(res.body.binding.label).toBe('L');
  });

  test('GET missing → 404', async () => {
    const res = await call('/v1/registry/bindings/pushcut/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('binding-not-found');
  });

  test('GET ?channel=... lists channel bindings', async () => {
    await call('/v1/registry/bindings/pushcut/a', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    await call('/v1/registry/bindings/pushcut/b', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const res = await call('/v1/registry/bindings?channel=pushcut');
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('pushcut');
    expect(res.body.bindings.map((b: { key: string }) => b.key).sort()).toEqual(['a', 'b']);
  });

  test('GET /v1/registry/bindings/<channel> = list shorthand', async () => {
    await call('/v1/registry/bindings/pushcut/a', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const res = await call('/v1/registry/bindings/pushcut');
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('pushcut');
  });

  test('DELETE → 200', async () => {
    await call('/v1/registry/bindings/pushcut/k', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const res = await call('/v1/registry/bindings/pushcut/k', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('DELETE missing → 404', async () => {
    const res = await call('/v1/registry/bindings/pushcut/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('invalid channel → 400 invalid-channel', async () => {
    const res = await call('/v1/registry/bindings/UPPER/k', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-channel');
  });

  test('invalid key → 400 invalid-key', async () => {
    const res = await call('/v1/registry/bindings/pushcut/has%20space', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-key');
  });

  test('invalid JSON body → 400', async () => {
    const res = await call('/v1/registry/bindings/pushcut/k', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-json');
  });

  test('channelDescription set via POST surfaces in list', async () => {
    await call('/v1/registry/bindings/pushcut/k', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelDescription: 'iPhone webhooks' }),
    });
    const list = await call('/v1/registry/bindings');
    const pcut = list.body.channels.find((s: { channel: string }) => s.channel === 'pushcut');
    expect(pcut?.description).toBe('iPhone webhooks');
  });
});
