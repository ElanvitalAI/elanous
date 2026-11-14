import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync, copyFileSync, mkdirSync, cpSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createSharedSolarDecideTransport } from './upstage-solar-decide.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFakeUpstageServer } from '../../../test/fixtures/fake-upstage-server.js';
import { currentBackendId, useBackend } from '../../nexus/config/secrets/index.js';
import { getElanousConfigDirOverride, setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import plugin, { createSolarDecideProvider, SOLAR_DECIDE, type DecideInput, type DecideWireContract, type SharedUpstageTransport } from '../../../plugins/upstage-solar-decide/plugin.js';
import { PluginHost } from '../../plugins/core/host.js';
import { parsePluginManifest } from '../../plugins/core/manifest.js';

const input: DecideInput = {
  state: { approval: 'pending' }, question: 'Which branch?', choices: ['review', 'continue'],
  enableBeta: true, consentToSend: true,
};
// Fixture names are deliberately unlike an assumed upstream choice/probability envelope.
const wire: DecideWireContract = {
  kind: 'fixture', evidence: 'local-fixture-only; upstream schema unverified',
  encode: value => ({ fixture_state: value.state, fixture_question: value.question, fixture_choices: value.choices }),
  decode: raw => {
    const value = raw as { fixture_branch?: unknown; fixture_calibration?: unknown };
    return { choice: value.fixture_branch, probability: value.fixture_calibration };
  },
};
function fixture(options: { key?: boolean; response?: unknown; universe?: 'test' | 'production'; error?: string } = {}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const refs: string[] = [];
  // This is an injected transport double, not a second fake-server listener or credential store.
  const transport: SharedUpstageTransport = {
    universe: options.universe ?? 'test',
    hasCredential: async ref => { refs.push(ref); return options.key !== false; },
    postJson: async (path, body) => {
      calls.push({ path, body });
      if (options.error) throw new Error(options.error);
      return options.response ?? { fixture_branch: 'review', fixture_calibration: 0.875 };
    },
  };
  return { transport, calls, refs };
}

test('P6 plugin is visibly beta, advertises only the shared credential and registers no default graph', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/upstage-solar-decide/plugin.json', import.meta.url), 'utf8'));
  expect(() => parsePluginManifest(manifest)).not.toThrow();
  expect(manifest.description).toContain('beta');
  expect(manifest.main).toBe('./plugin.ts');
  expect(plugin.initialState()).toEqual({ beta: true, defaultGraphProvider: false });
  expect(plugin.llmTools?.map(tool => tool.name)).toEqual(['SolarDecideBeta']);
  expect(manifest.activationEvents).toEqual(['onRoute']);
  expect(manifest.contributes.skills[0].path).toBe('./skills/decide/SKILL.md');
  expect(manifest.extensions['ai.elanous']).toMatchObject({ beta: true, defaultGraphProvider: false, credentialRefs: ['cred:upstage.api_key'] });
  expect(manifest.extensions['ai.elanous'].capabilities).toEqual(['net:api.upstage.ai', 'secret:upstage']);
  expect(manifest.extensions['ai.elanous'].graphs).toEqual([]);
  expect(manifest.extensions['ai.elanous'].graphProviders).toBeUndefined();
  expect(SOLAR_DECIDE).toMatchObject({ model: 'solar-decide', path: '/v1/systemone', beta: true });
});

test('fixed /v1/systemone fixture yields stable normalized choice and probability without guessing wire fields', async () => {
  const f = fixture();
  const decide = createSolarDecideProvider({ transport: f.transport, wire });
  const expected = { status: 'ok', beta: true, model: 'solar-decide', choice: 'review', probability: 0.875 } as const;
  expect(await decide(input)).toEqual(expected);
  expect(await decide(input)).toEqual(expected);
  expect(f.refs).toEqual(['cred:upstage.api_key', 'cred:upstage.api_key']);
  expect(f.calls).toEqual([0, 1].map(() => ({ path: '/v1/systemone', body: {
    fixture_state: input.state, fixture_question: input.question, fixture_choices: input.choices,
  } })));
});

test('beta opt-in and data-transfer consent are checked before credential access or POST', async () => {
  const f = fixture();
  const decide = createSolarDecideProvider({ transport: f.transport, wire });
  expect(await decide({ ...input, enableBeta: false })).toMatchObject({ status: 'beta-opt-in-required', beta: true });
  expect(await decide({ ...input, consentToSend: false })).toMatchObject({ status: 'consent-required' });
  expect(f.refs).toEqual([]);
  expect(f.calls).toEqual([]);
});

test('absent key gives shared-slot guidance without success or POST', async () => {
  const f = fixture({ key: false });
  const result = await createSolarDecideProvider({ transport: f.transport, wire })(input);
  expect(result).toMatchObject({ status: 'key-required', beta: true });
  expect(JSON.stringify(result)).toContain('cred:upstage.api_key');
  expect(JSON.stringify(result)).toContain('eln secret slot setup upstage');
  expect(f.calls).toEqual([]);
});

test('pending U-0 and missing wire contract fail closed; familiar response names are never defaults', async () => {
  expect(await createSolarDecideProvider({})(input)).toMatchObject({ status: 'shared-transport-pending' });
  const f = fixture({ response: { choice: 'review', probability: 0.875 } });
  expect(await createSolarDecideProvider({ transport: f.transport })(input)).toMatchObject({ status: 'wire-contract-required' });
  expect(f.calls).toEqual([]);
  expect(await createSolarDecideProvider({ transport: f.transport, wire })(input)).toMatchObject({ status: 'invalid-response' });
});

test('fixture contract cannot be used in a production universe; confirmation evidence is required', async () => {
  const f = fixture({ universe: 'production' });
  expect(await createSolarDecideProvider({ transport: f.transport, wire })(input)).toMatchObject({ status: 'fixture-outside-test' });
  expect(await createSolarDecideProvider({ transport: f.transport, wire: { ...wire, kind: 'owner-verified', evidence: '' } })(input))
    .toMatchObject({ status: 'wire-contract-required' });
  expect(f.calls).toEqual([]);
});

test.each([
  { fixture_branch: 'other', fixture_calibration: 0.9 },
  { fixture_branch: 'review', fixture_calibration: -0.1 },
  { fixture_branch: 'review', fixture_calibration: 1.1 },
  { fixture_branch: 'review', fixture_calibration: NaN },
  { fixture_branch: 'review', fixture_calibration: Infinity },
  { fixture_branch: 'review', fixture_calibration: '0.9' },
  { fixture_branch: 'review' },
])('invalid wire result stays non-success %#', async response => {
  const f = fixture({ response });
  expect(await createSolarDecideProvider({ transport: f.transport, wire })(input)).toMatchObject({ status: 'invalid-response' });
});

test('invalid choices are rejected before key lookup', async () => {
  const f = fixture();
  const decide = createSolarDecideProvider({ transport: f.transport, wire });
  for (const choices of [[], ['review', 'review'], ['']]) expect(await decide({ ...input, choices })).toMatchObject({ status: 'invalid-input' });
  expect(f.refs).toEqual([]);
});

test('raw transport/adapter errors and response secrets do not escape into results', async () => {
  const secret = 'fake-secret-never-returned';
  const f = fixture({ error: secret });
  const result = await createSolarDecideProvider({ transport: f.transport, wire })(input);
  expect(result).toMatchObject({ status: 'request-failed' });
  expect(JSON.stringify(result)).not.toContain(secret);
  const decoded = await createSolarDecideProvider({ transport: fixture().transport, wire: { ...wire, decode: () => { throw new Error(secret); } } })(input);
  expect(decoded).toMatchObject({ status: 'invalid-response' });
  expect(JSON.stringify(decoded)).not.toContain(secret);
});


test('U-0 shared fake /systemone yields stable fixture choice/probability with env-only credential fallback', async () => {
  const fake = await startFakeUpstageServer();
  const root = mkdtempSync(join(tmpdir(), 'solar-decide-u0-'));
  const priorConfig = getElanousConfigDirOverride();
  const priorBackend = currentBackendId();
  const keys = ['UPSTAGE_API_KEY', 'UPSTAGE_BASE_URL', 'NODE_ENV'] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    setElanousConfigDir(root);
    useBackend('file');
    process.env.NODE_ENV = 'test';
    process.env.UPSTAGE_BASE_URL = fake.baseUrl;
    process.env.UPSTAGE_API_KEY = 'fake-upstage-key';
    // Source: #35843 fixture-only deadline/byte cap above the tiny loopback payload; not upstream limits.
    const transport = createSharedSolarDecideTransport({ signal: AbortSignal.timeout(5_000), maxResponseBytes: 1_024 });
    const fixtureWire: DecideWireContract = {
      kind: 'fixture', evidence: 'U-0 fake-upstage-server only; not the upstream schema',
      encode: () => ({ input: 'synthetic' }),
      decode: raw => {
        const fixture = raw as Record<string, unknown>;
        return { choice: fixture.choice, probability: fixture.fixture_probability };
      },
    };
    const decide = createSolarDecideProvider({ transport, wire: fixtureWire });
    const fixtureInput = { ...input, choices: ['synthetic-option'] };
    const result = await decide(fixtureInput);
    expect(result).toEqual({ status: 'ok', beta: true, model: 'solar-decide', choice: 'synthetic-option', probability: 0.875 });
    expect(await decide(fixtureInput)).toEqual(result);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toMatchObject({ path: '/v1/systemone', authorized: true });
    expect(JSON.stringify(result)).not.toContain('fake-upstage-key');
    // Source: #35843 same fixture-only transport budget; absence must prevent the POST.
    const absent = createSharedSolarDecideTransport({ signal: AbortSignal.timeout(5_000), maxResponseBytes: 1_024, resolveApiKey: async () => null });
    expect(await createSolarDecideProvider({ transport: absent, wire: fixtureWire })(input)).toMatchObject({ status: 'key-required' });
    expect(fake.requests).toHaveLength(2);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    useBackend(priorBackend);
    resetElanousConfigDir();
    if (priorConfig !== undefined) setElanousConfigDir(priorConfig);
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('shared adapter deadline stops a pending credential lookup before any HTTP request', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const credentialStarted = new Promise<void>(resolve => { entered = resolve; });
  let posts = 0;
  const transport = createSharedSolarDecideTransport({
    // Source: #35843 fixture-only byte cap; this case aborts before any response exists.
    signal: controller.signal, maxResponseBytes: 1_024,
    resolveApiKey: () => { entered(); return new Promise<null>(() => {}); },
    fetchImpl: (async () => { posts++; return new Response('{}'); }),
  });
  const pending = createSolarDecideProvider({ transport, wire })(input);
  await credentialStarted;
  controller.abort();
  expect(await pending).toMatchObject({ status: 'request-failed' });
  expect(posts).toBe(0);
});

test('shared adapter refuses redirects and caps response bytes without leaking the body', async () => {
  let options: RequestInit | undefined;
  const transport = createSharedSolarDecideTransport({
    // Source: #35843 synthetic eight-byte cap intentionally rejects the larger private fixture body.
    signal: AbortSignal.timeout(5_000), maxResponseBytes: 8,
    resolveApiKey: async () => 'fake-upstage-key',
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      options = init;
      return new Response('oversized-private-response');
    }),
  });
  const result = await createSolarDecideProvider({ transport, wire })(input);
  expect(result).toMatchObject({ status: 'request-failed' });
  expect(options?.redirect).toBe('error');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(result)).not.toContain('oversized-private-response');
});


test('the installed plugin entry loads without a neighboring core source tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'solar-decide-package-'));
  try {
    const entry = join(root, 'plugin.ts');
    copyFileSync(new URL('../../../plugins/upstage-solar-decide/plugin.ts', import.meta.url), entry);
    const installed = await import(pathToFileURL(entry).href) as typeof import('../../../plugins/upstage-solar-decide/plugin.js');
    expect(installed.default.initialState()).toEqual({ beta: true, defaultGraphProvider: false });
    expect(await installed.createSolarDecideProvider({})(input)).toMatchObject({ status: 'shared-transport-pending' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('installed user plugin dispatch wires U-0 transport and an explicit host fixture adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'solar-decide-installed-'));
  const fake = await startFakeUpstageServer();
  const priorConfig = getElanousConfigDirOverride();
  const priorBackend = currentBackendId();
  const keys = ['UPSTAGE_API_KEY', 'UPSTAGE_BASE_URL', 'NODE_ENV'] as const;
  const previous = keys.map(key => process.env[key]);
  const userDir = join(root, 'plugins');
  mkdirSync(userDir);
  cpSync(new URL('../../../plugins/upstage-solar-decide', import.meta.url), join(userDir, 'upstage-solar-decide'), { recursive: true });
  const fixtureWire: DecideWireContract = {
    kind: 'fixture', evidence: 'shared U-0 fixture only; real wire/probability unverified',
    encode: () => ({ input: 'synthetic' }),
    decode: raw => { const value = raw as Record<string, unknown>; return { choice: value.choice, probability: value.fixture_probability }; },
  };
  const hooks = { log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} };
  const host = new PluginHost(hooks, null, { userDir, packsDir: join(root, 'no-packs'), solarDecideWire: fixtureWire });
  const unverified = new PluginHost(hooks, null, { userDir, packsDir: join(root, 'no-packs') });
  try {
    setElanousConfigDir(join(root, 'config')); useBackend('file');
    process.env.NODE_ENV = 'test'; process.env.UPSTAGE_BASE_URL = fake.baseUrl;
    process.env.UPSTAGE_API_KEY = 'fake-upstage-key';
    await host.discover(); await host.activate('upstage-solar-decide');
    // Source: #37573 installed fixture regression only; no upstream timeout/response-size claim.
    const args = { ...input, choices: ['synthetic-option'], timeoutMs: 5_000, maxResponseBytes: 1_024 };
    expect(await host.dispatchTool('SolarDecideBeta', { ...args, consentToSend: false })).toMatchObject({ ok: true, result: { status: 'consent-required' } });
    expect(fake.requests).toHaveLength(0);
    const first = await host.dispatchTool('SolarDecideBeta', args);
    expect(first).toEqual({ ok: true, result: { status: 'ok', beta: true, model: 'solar-decide', choice: 'synthetic-option', probability: 0.875 } });
    expect(await host.dispatchTool('SolarDecideBeta', args)).toEqual(first);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every(request => request.path === '/v1/systemone' && request.authorized)).toBe(true);
    await unverified.discover(); await unverified.activate('upstage-solar-decide');
    expect(await unverified.dispatchTool('SolarDecideBeta', args)).toMatchObject({ ok: true, result: { status: 'wire-contract-required' } });
    expect(fake.requests).toHaveLength(2);
  } finally {
    await host.deactivate(); await unverified.deactivate(); await fake.close();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    useBackend(priorBackend); resetElanousConfigDir(); if (priorConfig !== undefined) setElanousConfigDir(priorConfig);
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-OK response cancels its body without reading or exposing it', async () => {
  let cancelled = false;
  const transport = createSharedSolarDecideTransport({
    // Source: #37573 synthetic cancellation regression budget only.
    signal: AbortSignal.timeout(5_000), maxResponseBytes: 1_024,
    resolveApiKey: async () => 'fake-upstage-key',
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }),
  });
  expect(await createSolarDecideProvider({ transport, wire })(input)).toMatchObject({ status: 'request-failed' });
  expect(cancelled).toBe(true);
});
