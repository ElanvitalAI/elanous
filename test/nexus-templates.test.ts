// NEXUS · templates loader + apply + HTTP API tests (Phase N-3 PR κ)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEMPLATE_VERSION,
  isBuiltinTemplate,
  listBuiltinTemplates,
  listTemplates,
  loadTemplate,
  saveTemplate,
  type NexusTemplate,
} from '../src/nexus/templates/loader.js';
import { applyTemplate, snapshotRegistryAsEntries } from '../src/nexus/templates/apply.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import { makeTestSpawnBackend } from '../src/nexus/supervisor/spawn.js';
import { getElanousConfigDir, setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

const bearerToken = 'nexus-templates-test-token';

let tmpRoot: string;
let prevNexus: string | undefined;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n3-tpl-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  setElanousConfigDir(tmpRoot);
  writeFileSync(join(getElanousConfigDir(), 'acp-token'), bearerToken, { mode: 0o600 });
});
afterEach(() => {
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  resetElanousConfigDir();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('builtin templates', () => {
  test('4 builtins exist with stable names', () => {
    const names = listBuiltinTemplates().map((t) => t.name);
    expect(names).toEqual(['default', 'voice', 'family-channel', 'dev']);
  });

  test('isBuiltinTemplate identifies bundled names', () => {
    expect(isBuiltinTemplate('default')).toBe(true);
    expect(isBuiltinTemplate('voice')).toBe(true);
    expect(isBuiltinTemplate('mine')).toBe(false);
  });

  test('default template = chat + webterm + daemon', () => {
    const t = loadTemplate('default')!;
    expect(t.tabs.map((e) => e.kind)).toEqual(['chat', 'webterm', 'daemon']);
  });

  test('family-channel template includes channel-bot with platform', () => {
    const t = loadTemplate('family-channel')!;
    const bot = t.tabs.find((e) => e.kind === 'channel-bot');
    expect(bot?.kindOpts?.platform).toBe('telegram');
  });

  test('dev template has 6 tabs (2 chat + 2 webterm + daemon + pwa)', () => {
    const t = loadTemplate('dev')!;
    expect(t.tabs).toHaveLength(6);
  });

  test('listBuiltinTemplates returns clones (mutation safe)', () => {
    const t1 = listBuiltinTemplates()[0];
    t1.tabs.push({ kind: 'chat', id: 'chat:99' });
    const t2 = listBuiltinTemplates()[0];
    expect(t2.tabs).not.toContainEqual({ kind: 'chat', id: 'chat:99' });
  });
});

describe('listTemplates · merge user + builtin', () => {
  test('only builtins when no user dir', () => {
    const list = listTemplates();
    expect(list.map((s) => s.name)).toEqual(['default', 'voice', 'family-channel', 'dev']);
    expect(list.every((s) => s.source === 'builtin')).toBe(true);
  });

  test('user file shows up alongside builtins', () => {
    mkdirSync(join(tmpRoot, 'nexus', 'templates'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'nexus', 'templates', 'mine.json'),
      JSON.stringify({
        version: TEMPLATE_VERSION,
        name: 'mine',
        description: 'my custom',
        tabs: [{ kind: 'chat', id: 'chat:1' }],
      }),
      { mode: 0o600 },
    );
    const list = listTemplates();
    const mine = list.find((s) => s.name === 'mine');
    expect(mine).toBeDefined();
    expect(mine!.source).toBe('user');
    expect(mine!.tabCount).toBe(1);
  });

  test('user file with same name as builtin overrides (single entry)', () => {
    mkdirSync(join(tmpRoot, 'nexus', 'templates'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'nexus', 'templates', 'voice.json'),
      JSON.stringify({
        version: TEMPLATE_VERSION,
        name: 'voice',
        description: 'overridden voice',
        tabs: [{ kind: 'chat', id: 'chat:1' }],
      }),
      { mode: 0o600 },
    );
    const list = listTemplates();
    const voiceEntries = list.filter((s) => s.name === 'voice');
    expect(voiceEntries).toHaveLength(1);
    expect(voiceEntries[0].source).toBe('user');
    expect(voiceEntries[0].description).toBe('overridden voice');
  });
});

describe('loadTemplate', () => {
  test('returns null for unknown', () => {
    expect(loadTemplate('does-not-exist')).toBeNull();
  });

  test('user file beats builtin', () => {
    mkdirSync(join(tmpRoot, 'nexus', 'templates'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'nexus', 'templates', 'default.json'),
      JSON.stringify({
        version: TEMPLATE_VERSION,
        name: 'default',
        description: 'override',
        tabs: [{ kind: 'chat', id: 'chat:only' }],
      }),
      { mode: 0o600 },
    );
    const t = loadTemplate('default')!;
    expect(t.tabs).toEqual([{ kind: 'chat', id: 'chat:only' }]);
  });

  test('invalid JSON falls back to builtin (or null)', () => {
    mkdirSync(join(tmpRoot, 'nexus', 'templates'), { recursive: true });
    writeFileSync(join(tmpRoot, 'nexus', 'templates', 'voice.json'), '{not json', { mode: 0o600 });
    const t = loadTemplate('voice')!;
    // builtin voice = chat + daemon + pwa-host
    expect(t.tabs.map((e) => e.kind)).toEqual(['chat', 'daemon', 'pwa-host']);
  });

  test('wrong version skipped', () => {
    mkdirSync(join(tmpRoot, 'nexus', 'templates'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'nexus', 'templates', 'mine.json'),
      JSON.stringify({ version: 99, name: 'mine', description: '', tabs: [] }),
      { mode: 0o600 },
    );
    expect(loadTemplate('mine')).toBeNull();
  });
});

describe('saveTemplate', () => {
  test('writes 0o600 file under templates dir', () => {
    const result = saveTemplate({
      version: TEMPLATE_VERSION,
      name: 'my-save',
      description: 'first save',
      tabs: [{ kind: 'chat', id: 'chat:1' }],
    });
    expect(result.outcome).toBe('saved');
    expect(existsSync(result.path!)).toBe(true);
    const parsed = JSON.parse(readFileSync(result.path!, 'utf-8'));
    expect(parsed.name).toBe('my-save');
    expect(parsed.tabs).toHaveLength(1);
  });

  test('refuses builtin name → outcome=builtin-conflict', () => {
    expect(saveTemplate({ version: TEMPLATE_VERSION, name: 'default', description: '', tabs: [] }).outcome).toBe('builtin-conflict');
    expect(saveTemplate({ version: TEMPLATE_VERSION, name: 'voice', description: '', tabs: [] }).outcome).toBe('builtin-conflict');
  });

  test('refuses unsafe name → outcome=invalid-name', () => {
    expect(saveTemplate({ version: TEMPLATE_VERSION, name: '../escape', description: '', tabs: [] }).outcome).toBe('invalid-name');
    expect(saveTemplate({ version: TEMPLATE_VERSION, name: '', description: '', tabs: [] }).outcome).toBe('invalid-name');
    expect(saveTemplate({ version: TEMPLATE_VERSION, name: 'a'.repeat(65), description: '', tabs: [] }).outcome).toBe('invalid-name');
  });
});

describe('applyTemplate · register + start', () => {
  test('registers all tabs into registry', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const result = await applyTemplate(loadTemplate('dev')!, { registry, autoStart: false });
    expect(result.registered).toHaveLength(6);
    expect(registry.list()).toHaveLength(6);
    expect(registry.has('chat:1')).toBe(true);
    expect(registry.has('chat:2')).toBe(true);
    expect(registry.has('webterm:1')).toBe(true);
    expect(registry.has('daemon:1')).toBe(true);
    expect(registry.has('pwa-host:1')).toBe(true);
  });

  test('id-conflict tabs skipped with reason', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    // Pre-register one of dev's tab ids
    const { createChatTabSpec } = await import('../src/nexus/kinds/chat.js');
    registry.register(createChatTabSpec({ id: 'chat:1' }));
    const result = await applyTemplate(loadTemplate('dev')!, { registry, autoStart: false });
    expect(result.registered.find((r) => r.id === 'chat:1')).toBeUndefined();
    expect(result.skipped.find((s) => s.id === 'chat:1' && s.reason === 'id-conflict')).toBeDefined();
  });

  test('channel-bot without platform skipped (unbuildable)', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const tpl: NexusTemplate = {
      version: TEMPLATE_VERSION,
      name: 'bad',
      description: '',
      tabs: [{ kind: 'channel-bot', id: 'tg:bad' }], // no platform
    };
    const result = await applyTemplate(tpl, { registry, autoStart: false });
    expect(result.registered).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('unbuildable');
  });

  test('autoStart=true + supervisor → spawn-able tabs get started', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const { createSupervisor } = await import('../src/nexus/supervisor/index.js');
    const backend = makeTestSpawnBackend();
    const sup = createSupervisor({ state, registry, spawnBackend: backend });
    const result = await applyTemplate(loadTemplate('default')!, { registry, supervisor: sup, autoStart: true });
    expect(result.registered).toHaveLength(3);
    expect(result.started).toContain('daemon:1'); // spawn-able
    expect(result.started).not.toContain('chat:1'); // view-only
    expect(backend.spawned).toHaveLength(1);
    await sup.shutdown({ graceMs: 0 });
  });

  test('start=false on entry suppresses startTab', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const { createSupervisor } = await import('../src/nexus/supervisor/index.js');
    const backend = makeTestSpawnBackend();
    const sup = createSupervisor({ state, registry, spawnBackend: backend });
    const tpl: NexusTemplate = {
      version: TEMPLATE_VERSION,
      name: 'no-start',
      description: '',
      tabs: [{ kind: 'daemon', id: 'd:noauto', start: false }],
    };
    const result = await applyTemplate(tpl, { registry, supervisor: sup, autoStart: true });
    expect(result.registered).toHaveLength(1);
    expect(result.started).toHaveLength(0);
    expect(backend.spawned).toHaveLength(0);
    await sup.shutdown({ graceMs: 0 });
  });
});

describe('snapshotRegistryAsEntries', () => {
  test('round-trip: snapshot dev template → entries match', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    await applyTemplate(loadTemplate('dev')!, { registry, autoStart: false });
    const entries = snapshotRegistryAsEntries(registry);
    expect(entries.map((e) => e.id)).toEqual(['chat:1', 'chat:2', 'webterm:1', 'webterm:2', 'daemon:1', 'pwa-host:1']);
  });

  test('channel-bot platform recovered from meta', async () => {
    const state = createNexusState({ nexusVersion: '0.10.0', phase: 'test' });
    const registry = new TabRegistry(state);
    await applyTemplate(loadTemplate('family-channel')!, { registry, autoStart: false });
    const entries = snapshotRegistryAsEntries(registry);
    const bot = entries.find((e) => e.kind === 'channel-bot');
    expect(bot?.kindOpts?.platform).toBe('telegram');
  });
});

describe('runNexus integration · template option', () => {
  test('runNexus({template: "voice"}) registers voice tabs', async () => {
    const handle = await runNexus({
      detachForTesting: true,
      template: 'voice',
      supervisorSpawnBackend: makeTestSpawnBackend(),
    });
    expect(handle!.registry.has('chat:1')).toBe(true);
    expect(handle!.registry.has('daemon:1')).toBe(true);
    expect(handle!.registry.has('pwa-host:1')).toBe(true);
    expect(handle!.registry.has('webterm:1')).toBe(false); // not in voice
    expect(handle!.state.template).toBe('voice');
    expect(handle!.runtime.template).toBe('voice');
    handle!.release();
  });

  test('unknown template → throws', async () => {
    await expect(runNexus({
      detachForTesting: true,
      template: 'no-such',
    })).rejects.toThrow(/unknown template/);
  });

  test('default registration suppressed when template is set', async () => {
    const handle = await runNexus({
      detachForTesting: true,
      template: 'family-channel',
      supervisorSpawnBackend: makeTestSpawnBackend(),
    });
    // family-channel: chat + daemon + telegram-bot
    expect(handle!.registry.has('chat:1')).toBe(true);
    expect(handle!.registry.has('daemon:1')).toBe(true);
    expect(handle!.registry.has('telegram:1')).toBe(true);
    expect(handle!.registry.has('webterm:1')).toBe(false); // no default webterm
    handle!.release();
  });
});

function authenticatedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${bearerToken}`);
  return fetch(url, { ...init, headers });
}

describe('HTTP routes · /v1/nexus/templates', () => {
  let handle: RunNexusHandle | undefined;
  let baseUrl: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    // Isolate HOME; skipRuntimeApi:false wires metaApi so the write-route
    // gate evaluates auth rather than an unwired runtime.
    prevHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    handle = await runNexus({
      detachForTesting: true,
      skipRuntimeApi: false,
      skipHttpServer: false,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      supervisorSpawnBackend: makeTestSpawnBackend(),
      toolCwd: tmpRoot,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipDiscordChannel: true,
      skipTerminalChannel: true,
      skipIntentPrediction: true,
    });
    baseUrl = handle!.httpServer!.url;
  });

  afterEach(() => {
    handle?.release();
    handle = undefined;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  test('GET /v1/nexus/templates → 4 builtins', async () => {
    expect((await fetch(`${baseUrl}/v1/nexus/templates`)).status).toBe(401);
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toHaveLength(4);
    expect(body.templates.map((s: { name: string }) => s.name))
      .toEqual(['default', 'voice', 'family-channel', 'dev']);
  });

  test('GET /v1/nexus/templates/voice → full template', async () => {
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates/voice`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.name).toBe('voice');
    expect(body.template.tabs).toHaveLength(3);
  });

  test('GET /v1/nexus/templates/missing → 404', async () => {
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates/no-such`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('template-not-found');
  });

  test('POST /v1/nexus/templates fromRegistry → saves', async () => {
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-snapshot', description: 'live snapshot' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.saved).toBe(true);
    expect(body.name).toBe('my-snapshot');
    // Verify it's now in the list
    const list = await (await authenticatedFetch(`${baseUrl}/v1/nexus/templates`)).json();
    expect(list.templates.find((s: { name: string }) => s.name === 'my-snapshot')).toBeDefined();
  });

  test('POST builtin name → 409', async () => {
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'default' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('builtin-conflict');
  });

  test('POST without name → 400', async () => {
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'noop' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('name-required');
  });

  test('POST unsafe name → 400 invalid-name', async () => {
    const res = await authenticatedFetch(`${baseUrl}/v1/nexus/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../escape' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-name');
  });
});
