// NEXUS · /v1/config/* HTTP route tests (Phase N-3 PR μ)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import { makeTestSpawnBackend } from '../src/nexus/supervisor/spawn.js';
import {
  clearSwitchRegistry,
} from '../src/nexus/config/switch-registry.js';
import { reloadAllBuiltins } from '../src/nexus/config/builtins/index.js';
import { setSecret, getSecret } from '../src/nexus/config/secrets.js';
import { makeSecretRef, isSecretRef } from '../src/nexus/config/types.js';
import {
  readUserConfig,
  patchUserConfig,
  writeSwitchValue,
  readSwitchValue,
} from '../src/nexus/config/user-config.js';
import { getElanousConfigDir, setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

const bearerToken = 'nexus-config-api-test-token';

let tmpRoot: string;
let prevHome: string | undefined;
let prevTg: string | undefined;
let prevDc: string | undefined;
let prevTools: string | undefined;
let handle: RunNexusHandle | undefined;
let baseUrl: string;
let hotApplyCalls: { id: string; v: unknown }[];

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n3-cfgapi-'));
  prevHome = process.env.HOME;
  prevTg = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  prevDc = process.env.ELANOUS_DISCORD_BOT_TOKEN;
  prevTools = process.env.ELANOUS_TOOLS;
  setElanousConfigDir(tmpRoot);
  writeFileSync(join(getElanousConfigDir(), 'acp-token'), bearerToken, { mode: 0o600 });
  process.env.HOME = tmpRoot;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
  delete process.env.ELANOUS_TOOLS;
  clearSwitchRegistry();
  reloadAllBuiltins();
  hotApplyCalls = [];
  // We need a custom http server start so we can inject hotApplyHandler.
  // Use detachForTesting to prevent the SIGINT wait, then start the http
  // server manually with our context.
  // skipRuntimeApi:false wires metaApi so POST /v1/config/secrets
  // is gated on auth, not an unwired runtime.
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
  resetElanousConfigDir();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevTg === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = prevTg;
  if (prevDc === undefined) delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
  else process.env.ELANOUS_DISCORD_BOT_TOKEN = prevDc;
  if (prevTools === undefined) delete process.env.ELANOUS_TOOLS;
  else process.env.ELANOUS_TOOLS = prevTools;
  delete process.env.ELANOUS_NEXUS_DIR;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  clearSwitchRegistry();
});

// Marker: hotApplyCalls is populated by the apply handler when wired
// directly. The runNexus boot wires no handler by default — we test
// hot-apply via the standalone applySwitchChange unit instead. The
// HTTP tests here just verify that PUT persists + returns outcome.
void (() => hotApplyCalls);

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${bearerToken}`);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: body as any };
}

describe('Tailscale Serve ghost preflight', () => {
  test('runs once before bind and still starts HTTP when cleanup fails', async () => {
    handle?.release();
    const requestedPort = 47000 + Math.floor(Math.random() * 1000);
    const calls: number[] = [];
    handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      httpStartPort: requestedPort,
      skipSupervisor: true,
      cleanGhostTailscaleServeFn: async (port) => {
        calls.push(port);
        throw new Error('cleanup unavailable');
      },
    });
    expect(calls).toEqual([requestedPort]);
    expect(handle!.httpServer?.port).toBe(requestedPort);
  });
});

describe('GET /v1/config', () => {
  test('requires the token before returning the config', async () => {
    expect((await fetch(`${baseUrl}/v1/config`)).status).toBe(401);
    expect((await call('/v1/config')).status).toBe(200);
  });

  test('returns full UserConfig', async () => {
    patchUserConfig((c) => writeSwitchValue(c, 'global.tools', 'webterm'));
    const res = await call('/v1/config');
    expect(res.status).toBe(200);
    expect(res.body.config.global.tools).toBe('webterm');
  });

  test('redacts secret-ref values in tab config', async () => {
    setSecret('tg', 'PLAIN-TOKEN');
    patchUserConfig((c) => writeSwitchValue(c, 'tabs.telegram:1.tokenRef', makeSecretRef('tg')));
    const res = await call('/v1/config');
    expect(res.body.config.tabs['telegram:1'].tokenRef).toBe('[redacted]');
  });
});

describe('GET /v1/config/switches', () => {
  test('returns the SwitchRegistry as a list', async () => {
    const res = await call('/v1/config/switches');
    expect(res.status).toBe(200);
    const ids = res.body.switches.map((s: { id: string }) => s.id);
    expect(ids).toContain('global.tools');
    expect(ids).toContain('tabs.telegram:1.tokenRef');
    expect(ids).toContain('tabs.discord:1.tokenRef');
  });

  test('switch entries include hotApplicable + envName + redact flag', async () => {
    const res = await call('/v1/config/switches');
    const tools = res.body.switches.find((s: { id: string }) => s.id === 'global.tools');
    expect(tools.hotApplicable).toBe(false);
    expect(tools.envName).toBe('ELANOUS_TOOLS');
    expect(tools.value).toBeUndefined(); // unset

    const tgToken = res.body.switches.find((s: { id: string }) => s.id === 'tabs.telegram:1.tokenRef');
    expect(tgToken.redactInLogs).toBe(true);
    expect(tgToken.envName).toBe('ELANOUS_TELEGRAM_BOT_TOKEN');
  });
});

describe('GET /v1/config/switches/:id', () => {
  test('global switch returns single', async () => {
    const res = await call('/v1/config/switches/global.tools');
    expect(res.status).toBe(200);
    expect(res.body.switch.id).toBe('global.tools');
  });

  test('tab-scope literal id resolves through template', async () => {
    const res = await call('/v1/config/switches/tabs.telegram:1.tokenRef');
    expect(res.status).toBe(200);
    expect(res.body.switch.id).toBe('tabs.telegram:1.tokenRef');
    expect(res.body.switch.kind).toBe('secret-ref');
  });

  test('unknown switch → 404', async () => {
    const res = await call('/v1/config/switches/global.bogus');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('switch-not-found');
  });

  test('current value returned for set switch', async () => {
    patchUserConfig((c) => writeSwitchValue(c, 'global.tools', 'all'));
    const res = await call('/v1/config/switches/global.tools');
    expect(res.body.switch.value).toBe('all');
  });
});

describe('PUT /v1/config/switches/:id', () => {
  test('hot switch → outcome=hot, persists', async () => {
    const res = await call('/v1/config/switches/global.debug.enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('hot');
    expect(readSwitchValue(readUserConfig(), 'global.debug.enabled')).toBe(true);
  });

  test('non-hot switch with daemon registered → outcome=restart', async () => {
    // Production runNexus auto-registers daemon when !detachForTesting · we passed
    // detachForTesting=true, so daemon isn't registered. Add it explicitly.
    handle!.registry.register({ id: 'daemon:1', kind: 'daemon', label: 'd' });
    await handle!.supervisor!.startTab('daemon:1');
    const res = await call('/v1/config/switches/global.tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'readonly' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('restart');
    expect(res.body.restartedTabs).toContain('daemon:1');
  });

  test('non-hot without target tab → outcome=no-op (still persists)', async () => {
    const res = await call('/v1/config/switches/global.tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'readonly' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('no-op');
    expect(readSwitchValue(readUserConfig(), 'global.tools')).toBe('readonly');
  });

  test('invalid value → 400 invalid-value', async () => {
    const res = await call('/v1/config/switches/global.tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'mystery' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-value');
  });

  test('unknown switch → 404', async () => {
    const res = await call('/v1/config/switches/global.bogus', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x' }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('switch-not-found');
  });

  test('missing value field → 400 value-required', async () => {
    const res = await call('/v1/config/switches/global.tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('value-required');
  });

  test('invalid JSON → 400 invalid-json', async () => {
    const res = await call('/v1/config/switches/global.tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-json');
  });
});

describe('Secrets API', () => {
  test('POST /v1/config/secrets stores + returns ref', async () => {
    const res = await call('/v1/config/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'my-tg', value: 'SECRET-A' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toBe('ref:secret:my-tg');
    expect(getSecret('my-tg')).toBe('SECRET-A');
    expect(isSecretRef(res.body.ref)).toBe(true);
  });

  test('POST invalid id → 400', async () => {
    const res = await call('/v1/config/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '../escape', value: 'X' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-secret-id');
  });

  test('POST missing value → 400', async () => {
    const res = await call('/v1/config/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('value-required');
  });

  test('GET /v1/config/secrets lists ids only (no values)', async () => {
    setSecret('a', 'AAA');
    setSecret('b', 'BBB');
    const res = await call('/v1/config/secrets');
    expect(res.status).toBe(200);
    expect(res.body.secrets.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    // No `value` field anywhere
    for (const s of res.body.secrets) expect((s as Record<string, unknown>).value).toBeUndefined();
  });

  test('DELETE /v1/config/secrets/:id removes', async () => {
    setSecret('victim', 'X');
    const res = await call('/v1/config/secrets/victim', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(getSecret('victim')).toBeUndefined();
  });

  test('DELETE missing → 404', async () => {
    const res = await call('/v1/config/secrets/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('runNexus boot · env auto-migrate (D-13)', () => {
  test('ELANOUS_TOOLS env at boot → migrated to UserConfig', async () => {
    handle?.release();
    process.env.ELANOUS_TOOLS = 'all';
    handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      supervisorSpawnBackend: makeTestSpawnBackend(),
      toolCwd: tmpRoot,
    });
    baseUrl = handle!.httpServer!.url;
    expect(readSwitchValue(readUserConfig(), 'global.tools')).toBe('all');
    // Event surfaced
    expect(handle!.state.events.some((e) =>
      e.kind === 'config.changed' && (e.detail as { reason?: string })?.reason === 'env-migrate'
    )).toBe(true);
  });

  test('ELANOUS_TELEGRAM_BOT_TOKEN env → secret + ref (with telegram tab registered)', async () => {
    handle?.release();
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'BOT-FROM-ENV';
    handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      enableChannelBots: ['telegram'],
      autoStartChannelBots: false,
      supervisorSpawnBackend: makeTestSpawnBackend(),
      toolCwd: tmpRoot,
    });
    baseUrl = handle!.httpServer!.url;
    const ref = readSwitchValue(readUserConfig(), 'tabs.telegram:1.tokenRef');
    expect(isSecretRef(ref)).toBe(true);
  });

  test('skipEnvMigration=true preserves raw env behavior', async () => {
    handle?.release();
    process.env.ELANOUS_TOOLS = 'readonly';
    handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      skipEnvMigration: true,
      supervisorSpawnBackend: makeTestSpawnBackend(),
      toolCwd: tmpRoot,
    });
    baseUrl = handle!.httpServer!.url;
    // Switch NOT migrated
    expect(readSwitchValue(readUserConfig(), 'global.tools')).toBeUndefined();
  });
});
