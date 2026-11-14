import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCredentialSlotId } from '../src/nexus/config/secrets/cred-slot-schema.js';
import { currentBackendId, registerBackend, resetBackendRegistry, setCredentialSlotAsync, useBackend } from '../src/nexus/config/secrets/index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';
import { credentialSlotWizardPlan } from '../src/nexus/config/secrets/cred-slot-wizard.js';
import { registerSetupCommand } from '../src/cli/setup-cli.js';
import { UpstageProvider, resolveUpstageApiKey, resolveUpstageApiKeyAsync, runUpstageOcr, upstageBaseUrl } from '../src/ocr/upstage.js';
import { startFakeUpstageServer } from './fixtures/fake-upstage-server.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalBase = process.env.UPSTAGE_BASE_URL;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalBase === undefined) delete process.env.UPSTAGE_BASE_URL;
  else process.env.UPSTAGE_BASE_URL = originalBase;
});

test('Upstage has exactly one typed shared credential slot', () => {
  expect(parseCredentialSlotId('cred:upstage.api_key')).toEqual({ service: 'upstage', field: 'api_key' });
  expect(parseCredentialSlotId('cred:upstage.apiKey')).toBeUndefined();
  expect(credentialSlotWizardPlan('upstage')?.slots).toEqual(['cred:upstage.api_key']);
});

test('canonical slot wins over a legacy environment value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upstage-slot-'));
  const previousBackend = currentBackendId();
  const previousEnv = process.env.UPSTAGE_API_KEY;
  try {
    setElanousConfigDir(root);
    useBackend('file');
    await setCredentialSlotAsync('cred:upstage.api_key', 'fake-upstage-key');
    process.env.UPSTAGE_API_KEY = 'legacy-synthetic-key';
    expect(resolveUpstageApiKey()).toBe('fake-upstage-key');
    expect(await resolveUpstageApiKeyAsync()).toBe('fake-upstage-key');
    expect(await new UpstageProvider().isAvailable()).toBe(true);
  } finally {
    useBackend(previousBackend);
    resetElanousConfigDir();
    if (previousEnv === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-file backend wins over legacy env and missing/error preserve read-only env fallback', async () => {
  const previousBackend = currentBackendId();
  const previousEnv = process.env.UPSTAGE_API_KEY;
  let mode: 'present' | 'missing' | 'error' = 'present';
  registerBackend({
    id: 'gcp', async get(id) {
      expect(id).toBe('cred:upstage.api_key');
      if (mode === 'error') throw new Error('synthetic backend detail');
      return mode === 'present' ? 'fake-upstage-key' : undefined;
    },
    async set() { throw new Error('no writes'); }, async delete() { throw new Error('no writes'); },
    async list() { return []; }, async isAvailable() { return { ok: true }; },
  });
  const fake = await startFakeUpstageServer();
  try {
    useBackend('gcp');
    process.env.UPSTAGE_API_KEY = 'legacy-synthetic-key';
    process.env.NODE_ENV = 'test';
    process.env.UPSTAGE_BASE_URL = fake.baseUrl;
    expect(await resolveUpstageApiKeyAsync()).toBe('fake-upstage-key');
    expect(await new UpstageProvider().isAvailable()).toBe(true);
    expect((await runUpstageOcr({ file: new Uint8Array([1]), filename: 'synthetic.pdf' })).ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    for (mode of ['missing', 'error'] as const) {
      expect(await resolveUpstageApiKeyAsync()).toBe('legacy-synthetic-key');
      expect(await new UpstageProvider().isAvailable()).toBe(true);
    }
    expect(fake.requests.every(request => request.authorized)).toBe(true);
  } finally {
    await fake.close();
    useBackend(previousBackend);
    resetBackendRegistry();
    if (previousEnv === undefined) delete process.env.UPSTAGE_API_KEY;
    else process.env.UPSTAGE_API_KEY = previousEnv;
  }
});

test('setup upstage can skip, or store one hidden value without rendering it', async () => {
  const output: string[] = [];
  const saved: Array<[string, string]> = [];
  const program = new Command();
  registerSetupCommand(program, {
    isStdinTty: () => true,
    promptSecret: async () => 'fake-upstage-key',
    setCredentialSlotAsync: async (id, value) => { saved.push([id, value]); },
    out: { log: (value) => output.push(value), error: (value) => output.push(value) },
    setExitCode: () => {},
  });
  await program.parseAsync(['node', 'elanous', 'setup', 'upstage', '--skip']);
  expect(saved).toEqual([]);
  await program.parseAsync(['node', 'elanous', 'setup', 'upstage']);
  expect(saved).toEqual([['cred:upstage.api_key', 'fake-upstage-key']]);
  expect(output.join('\n')).not.toContain('fake-upstage-key');
});

test('one loopback fake covers parse, Solar, IE, embeddings and Decide', async () => {
  const fake = await startFakeUpstageServer();
  process.env.NODE_ENV = 'test';
  process.env.UPSTAGE_BASE_URL = fake.baseUrl;
  try {
    const parsed = await runUpstageOcr({ file: new Uint8Array([1]), filename: 'synthetic.pdf', apiKey: 'fake-upstage-key' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.markdown).toBe('# Synthetic document');
    for (const [path, payload] of [
      ['chat/completions', { model: 'solar-pro4', messages: [{ role: 'user', content: 'synthetic' }] }],
      ['information-extraction', { response_format: { type: 'json_schema', json_schema: { name: 'synthetic', schema: { type: 'object' } } } }],
      ['embeddings', { model: 'solar-embedding-2-query', input: 'synthetic' }],
      ['systemone', { input: 'synthetic' }],
    ] as const) {
      const response = await fetch(`${fake.baseUrl}/${path}`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer fake-upstage-key', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBeTruthy();
    }
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/v1/document-digitization', '/v1/chat/completions', '/v1/information-extraction', '/v1/embeddings', '/v1/systemone',
    ]);
    expect(fake.requests.every((request) => request.authorized)).toBe(true);
  } finally { await fake.close(); }
});

test('fake rejects legacy embedding alias and missing IE schema', async () => {
  const fake = await startFakeUpstageServer();
  try {
    for (const [path, payload] of [
      ['embeddings', { model: 'embedding-query', input: 'synthetic' }],
      ['information-extraction', { input: 'synthetic' }],
    ] as const) {
      const response = await fetch(`${fake.baseUrl}/${path}`, {
        method: 'POST', headers: { Authorization: 'Bearer fake-upstage-key', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }
  } finally { await fake.close(); }
});

test('production OCR ignores a test base URL', async () => {
  process.env.NODE_ENV = 'production';
  process.env.UPSTAGE_BASE_URL = 'http://127.0.0.1:1/v1';
  let url = '';
  await runUpstageOcr({ file: new Uint8Array([1]), filename: 'synthetic.pdf', apiKey: 'fake-upstage-key',
    fetchImpl: (async (input) => {
      url = String(input);
      return new Response(JSON.stringify({ text: 'synthetic' }), { status: 200 });
    }) as typeof fetch,
  });
  expect(url).toBe('https://api.upstage.ai/v1/document-digitization');
});

test('OCR rejects non-loopback and malformed test overrides, and never follows a redirect', async () => {
  process.env.NODE_ENV = 'test';
  for (const base of ['https://outside.invalid/v1', 'http://127.0.0.1:1/v1?key=x', 'http://user@127.0.0.1:1/v1']) {
    process.env.UPSTAGE_BASE_URL = base;
    expect(() => upstageBaseUrl()).toThrow();
  }
  process.env.UPSTAGE_BASE_URL = 'http://127.0.0.1:1/v1';
  let redirect: RequestRedirect | undefined;
  const result = await runUpstageOcr({ file: new Uint8Array([1]), filename: 'synthetic.pdf', apiKey: 'fake-upstage-key',
    fetchImpl: (async (_input, init) => {
      redirect = init?.redirect;
      return new Response('', { status: 302, headers: { location: 'https://outside.invalid/' } });
    }) as typeof fetch,
  });
  expect(redirect).toBe('error');
  expect(result).toMatchObject({ ok: false, stage: 'http', status: 302 });
  expect(JSON.stringify(result)).not.toContain('fake-upstage-key');
});
