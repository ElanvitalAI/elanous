import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { consumeCredentialRegistrationBearer, credentialRegistrationCompleted, issueSetupLinkToken } from '../../auth/setup-link-tokens.js';
import { handleCredentialRegistrationClaim, handleCredentialRegistrationLinkCreate, handleCredentialRegistrationLinkRevoke, handleCredentialRegistrationSubmit, handleCredentialSlotsGet } from './setup-credentials.js';
import { createFakeCred } from '../../ux-sim/fake-cred.js';
import { fileBackend } from '../config/secrets/file-backend.js';
import { hasCredentialSlotWriteReceipt, registerBackend, resetBackendRegistry, useBackend, writeCredentialSlotBatchValue } from '../config/secrets/registry.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'setup-cred-')); setElanousConfigDir(dir); });
afterEach(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

const jsonPost = (url: string, body: unknown, authorization?: string) => new Request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
  body: JSON.stringify(body),
});

const interruptionFixtureEnv = (configDir: string): NodeJS.ProcessEnv => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ELANOUS_CONFIG_DIR: configDir,
});

test('credential slots GET carries observed health without exposing the stored value or grant metadata', async () => {
  // Source: a fixed fake clock and expiry keep the observed health deterministic.
  const fake = createFakeCred({ now: () => 1_000 });
  fake.install('cred:eodhd.api_key', { permissions: ['market.read'], expiresAt: 2_000 });
  fake.install('cred:krx.api_key', { permissions: ['write'], expiresAt: 2_000 });
  const secret = 'fixture-credential-value-must-stay-private';
  writeCredentialSlotBatchValue({ 'cred:eodhd.api_key': secret, 'cred:krx.api_key': secret });
  const response = await handleCredentialSlotsGet(new Request('https://nexus.example/v1/credentials/slots'), {
    authorizeOwner: () => true,
    healthObserver: { inspect: fake.inspect, permissionFor: () => 'market.read', now: () => 1_000,
      warningWindowMs: 100 }, // Source: a short explicit warning window checks the response path.
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  const parsed = JSON.parse(body) as { credentials: Array<{ id: string; present: boolean; healthStatus?: string }> };
  expect(parsed.credentials.find((row) => row.id === 'cred:eodhd.api_key')).toMatchObject({ present: true, healthStatus: 'valid' });
  expect(parsed.credentials.find((row) => row.id === 'cred:krx.api_key')).toMatchObject({ present: true, healthStatus: 'insufficient-permission' });
  expect(parsed.credentials.find((row) => row.id === 'cred:fds.api_key')).toMatchObject({ present: false, healthStatus: 'missing' });
  expect(body).not.toContain(secret);
  expect(body).not.toContain('permissions');
  expect(body).not.toContain('expiresAt');
});

test('credential slots GET reports opaque API key expiry as unmeasured and OAuth state from the token store', async () => {
  const secret = 'private-key-not-for-response';
  writeCredentialSlotBatchValue({ 'cred:eodhd.api_key': secret });
  const storePath = join(dir, 'auth.json');
  // Source: fixed OAuth fixture timestamps and scope separate valid from expiring and insufficient permission.
  writeFileSync(storePath, JSON.stringify({ version: 1, providers: {
    'openai-codex': { tokens: { accessToken: 'private-oauth-token', refreshToken: '', expiresAt: 1_000_000,
      scope: 'openid profile email offline_access' }, lastRefresh: 'fixture' },
    anthropic: { tokens: { accessToken: 'private-anthropic-token', refreshToken: '', expiresAt: 1_000_000 }, lastRefresh: 'fixture' },
  } }));
  const response = await handleCredentialSlotsGet(new Request('https://nexus.example/v1/credentials/slots'), {
    authorizeOwner: () => true, oauthStorePath: storePath, now: () => 1_000,
  });
  const body = await response.text();
  const parsed = JSON.parse(body) as { credentials: Array<{ id: string; present: boolean; healthStatus: string; healthLabel: string }>;
    oauth: Array<{ provider: string; healthStatus: string }> };
  expect(parsed.credentials.find((row) => row.id === 'cred:eodhd.api_key')).toMatchObject({ present: true, healthStatus: 'unmeasured', healthLabel: '있음 · 만료 정보 없음(측정 안 됨)' });
  expect(parsed.credentials.find((row) => row.id === 'cred:krx.api_key')).toMatchObject({ present: false, healthStatus: 'missing' });
  expect(parsed.oauth.find((row) => row.provider === 'openai-codex')?.healthStatus).toBe('valid');
  expect(parsed.oauth.find((row) => row.provider === 'anthropic')?.healthStatus).toBe('unmeasured');
  expect(body).not.toContain(secret);
  expect(body).not.toContain('private-oauth-token');
  expect(body).not.toContain('private-anthropic-token');
});

test('oversized streamed JSON is cancelled before the full request body is read', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { cancelled = true; },
  });
  const req = new Request('https://nexus.example/v1/credentials/registration-links', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const response = await handleCredentialRegistrationLinkCreate(req, { authorizeOwner: () => true });
  expect(response.status).toBe(400);
  expect(cancelled).toBe(true);
});

test('registration receipt reconciliation reads the file receipt regardless of active secret backend', () => {
  const id = 'b'.repeat(64);
  const valueHash = 'a'.repeat(64);
  writeCredentialSlotBatchValue({ 'cred:openai.api_key': 'receipt-value' }, { id, valueHash });
  registerBackend({
    id: 'gcp', async get() { return undefined; }, async set() {}, async delete() { return false; },
    async list() { return []; }, async isAvailable() { return { ok: true }; },
  });
  try {
    useBackend('gcp');
    expect(hasCredentialSlotWriteReceipt(id, valueHash)).toBe(true);
  } finally { resetBackendRegistry(); }
});

test('one-time web registration is slot scoped, verified, single use, and never returns the credential value', async () => {
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }, 'Bearer owner'),
    { authorizeOwner: (req) => req.headers.get('authorization') === 'Bearer owner', now: () => 1_000 },
  );
  expect(create.status).toBe(200);
  const created = await create.json() as { slot: string; url: string; expiresAt: string };
  expect(created.slot).toBe('cred:openai.api_key');
  expect(created.url).toMatch(/^https:\/\/nexus\.example\/app\/credentials\/register\/claim\/#t=els_/);
  expect(created.expiresAt).toBe(new Date(601_000).toISOString());
  expect((await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:higgsfield.secret' }, 'Bearer owner'),
    { authorizeOwner: () => true, now: () => 1_000 },
  )).status).toBe(400);
  expect((await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { authorizeOwner: () => false, now: () => 1_000 },
  )).status).toBe(401);

  const linkToken = new URL(created.url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(
    jsonPost('https://nexus.example/v1/setup/credential-claim', { t: linkToken }),
    { dir, now: () => 2_000 },
  );
  expect(claim.status).toBe(200);
  const claimed = await claim.json() as { slot: string; bearer: string; label: string; setupUrl: string };
  expect(claimed).toMatchObject({ slot: 'cred:openai.api_key', label: 'OpenAI', setupUrl: 'https://platform.openai.com/api-keys' });
  expect(claimed.bearer).toMatch(/^elcr_/);

  const secret = 'sk-test-private-value-not-for-output';
  const verifyCalls: Array<[string, string]> = [];
  const deps = {
    dir,
    now: () => 3_000,
    verify: async (service: string, value: string) => { verifyCalls.push([service, value]); return { result: 'verified' as const, httpStatus: 200 }; },
  };
  const wrongSlot = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:elevenlabs.api_key', value: secret }, `Bearer ${claimed.bearer}`), deps,
  );
  expect(wrongSlot.status).toBe(403);
  const success = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: claimed.slot, value: secret }, `Bearer ${claimed.bearer}`), deps,
  );
  expect(success.status).toBe(200);
  const response = await success.text();
  expect(response).toContain('"saved":true');
  expect(response).not.toContain(secret);
  expect(verifyCalls).toEqual([['openai-api', secret]]);
  expect(await fileBackend.get('cred:openai.api_key')).toBe(secret);
  const reused = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: claimed.slot, value: secret }, `Bearer ${claimed.bearer}`), deps,
  );
  expect(reused.status).toBe(401);
  expect((await reused.text())).not.toContain(secret);
});

test('OpenRouter phone registration completes only its issued link after a verified Nexus write', async () => {
  const created = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openrouter.api_key' }),
    { dir, now: () => 1_000, authorizeOwner: () => true },
  );
  expect(created.status).toBe(200);
  const { url } = await created.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  expect(credentialRegistrationCompleted(token, 'cred:openrouter.api_key', { dir })).toBe(false);
  const claim = await handleCredentialRegistrationClaim(
    jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => 1_001 },
  );
  expect(claim.status).toBe(200);
  const { bearer } = await claim.json() as { bearer: string };
  const secret = 'sk-or-v1-phone-private-value';
  const saved = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openrouter.api_key', value: secret }, `Bearer ${bearer}`),
    { dir, now: () => 1_002, verify: async (service, value) => {
      expect(service).toBe('openrouter'); expect(value).toBe(secret); return { result: 'verified' };
    } },
  );
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain(secret);
  expect(credentialRegistrationCompleted(token, 'cred:openrouter.api_key', { dir })).toBe(true);
  expect(await fileBackend.get('cred:openrouter.api_key')).toBe(secret);
});

test('owner cancellation revokes the issued link and any bearer already exchanged from it', async () => {
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => 10_000, authorizeOwner: () => true },
  );
  const created = await create.json() as { url: string };
  const token = new URL(created.url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => 10_001 });
  expect(claim.status).toBe(200);
  const { bearer } = await claim.json() as { bearer: string };
  const revoke = await handleCredentialRegistrationLinkRevoke(
    jsonPost('https://nexus.example/v1/credentials/registration-links/revoke', { t: token }, 'Bearer owner'),
    { dir, now: () => 10_002, authorizeOwner: (req) => req.headers.get('authorization') === 'Bearer owner' },
  );
  expect(revoke.status).toBe(200);
  const denied = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private' }, `Bearer ${bearer}`),
    { dir, now: () => 10_003, verify: async () => ({ result: 'verified' }) },
  );
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain('private');
});

test('owner cancellation during provider verification prevents the pending credential write', async () => {
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => 20_000, authorizeOwner: () => true },
  );
  const { url } = await create.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(
    jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => 20_001 },
  );
  const { bearer } = await claim.json() as { bearer: string };

  let verificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  let finishVerification!: (result: { result: 'verified' }) => void;
  const verification = new Promise<{ result: 'verified' }>((resolve) => { finishVerification = resolve; });
  const submit = handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private-during-cancel' }, `Bearer ${bearer}`),
    { dir, now: () => 20_002, verify: async () => { verificationStarted(); return verification; } },
  );
  await started;

  const revoked = await handleCredentialRegistrationLinkRevoke(
    jsonPost('https://nexus.example/v1/credentials/registration-links/revoke', { t: token }, 'Bearer owner'),
    { dir, now: () => 20_003, authorizeOwner: () => true },
  );
  expect(revoked.status).toBe(200);
  finishVerification({ result: 'verified' });
  const submitResult = await submit;
  expect(submitResult.status).toBe(401);
  expect(await submitResult.text()).not.toContain('private-during-cancel');
  expect(await fileBackend.get('cred:openai.api_key')).toBeUndefined();
});

test('the bearer expiry is rechecked after provider verification completes', async () => {
  let now = 30_000;
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => now, authorizeOwner: () => true },
  );
  const { url } = await create.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => now });
  const { bearer, expiresAt } = await claim.json() as { bearer: string; expiresAt: string };
  let verificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  let finishVerification!: (result: { result: 'verified' }) => void;
  const verification = new Promise<{ result: 'verified' }>((resolve) => { finishVerification = resolve; });
  const submit = handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private-expired' }, `Bearer ${bearer}`),
    { dir, now: () => now, verify: async () => { verificationStarted(); return verification; } },
  );
  await started;
  now = Date.parse(expiresAt);
  finishVerification({ result: 'verified' });
  const response = await submit;
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'expired' });
  expect(await fileBackend.get('cred:openai.api_key')).toBeUndefined();
});

test('a failed credential save leaves the one-time bearer retryable', async () => {
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => 40_000, authorizeOwner: () => true },
  );
  const { url } = await create.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => 40_001 });
  const { bearer } = await claim.json() as { bearer: string };
  const failed = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private-retry' }, `Bearer ${bearer}`),
    { dir, now: () => 40_002, verify: async () => ({ result: 'verified' }), saveCredential: () => { throw new Error('simulated atomic writer failure'); } },
  );
  expect(failed.status).toBe(503);
  expect(await fileBackend.get('cred:openai.api_key')).toBeUndefined();
  const retried = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private-retry' }, `Bearer ${bearer}`),
    { dir, now: () => 40_003, verify: async () => ({ result: 'verified' }) },
  );
  expect(retried.status).toBe(200);
  expect(await fileBackend.get('cred:openai.api_key')).toBe('private-retry');
  expect(readFileSync(join(dir, 'setup-link-tokens.json'), 'utf8')).not.toContain('private-retry');
});

test('a writer error after the atomic save is resolved by its durable receipt', async () => {
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => 45_000, authorizeOwner: () => true },
  );
  const { url } = await create.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => 45_001 });
  const { bearer } = await claim.json() as { bearer: string };
  const saved = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private-written-before-error' }, `Bearer ${bearer}`),
    {
      dir, now: () => 45_002, verify: async () => ({ result: 'verified' }),
      saveCredential: (slot, value, receipt) => {
        writeCredentialSlotBatchValue({ [slot]: value }, receipt);
        throw new Error('simulated lost acknowledgement after atomic write');
      },
    },
  );
  expect(saved.status).toBe(200);
  expect(await fileBackend.get('cred:openai.api_key')).toBe('private-written-before-error');
});

test('an interrupted after-write save is reconciled before revocation', async () => {
  const now = 50_000;
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => now, authorizeOwner: () => true },
  );
  const { url } = await create.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => now + 1 });
  const { bearer } = await claim.json() as { bearer: string };
  const submittedValue = 'private-after-interruption';
  expect(consumeCredentialRegistrationBearer(bearer, 'cred:openai.api_key', { dir, now: now + 2, submissionValue: submittedValue }))
    .toEqual({ ok: true, slot: 'cred:openai.api_key' });

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'setup-credentials.fixture.ts'), dir, bearer, 'cred:openai.api_key', submittedValue, String(now + 3), 'after-write'],
    { stdout: 'pipe', stderr: 'pipe', env: interruptionFixtureEnv(dir) },
  );
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).not.toBe(0);
  expect(stderr).toBe('');
  expect(await fileBackend.get('cred:openai.api_key')).toBe(submittedValue);
  expect(readFileSync(join(dir, 'setup-link-tokens.json'), 'utf8')).not.toContain(submittedValue);
  expect(consumeCredentialRegistrationBearer(bearer, 'cred:openai.api_key', { dir, now: now + 4, submissionValue: 'different-private-value' }))
    .toEqual({ ok: false, reason: 'used' });

  writeCredentialSlotBatchValue({ 'cred:openai.api_key': 'newer-owner-value' });

  const retryAfterCrash = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: submittedValue }, `Bearer ${bearer}`),
    { dir, now: () => now + 4, verify: async () => ({ result: 'verified' }) },
  );
  expect(retryAfterCrash.status).toBe(200);
  expect(await fileBackend.get('cred:openai.api_key')).toBe('newer-owner-value');

  const revokeWhileRecoverable = await handleCredentialRegistrationLinkRevoke(
    jsonPost('https://nexus.example/v1/credentials/registration-links/revoke', { t: token }, 'Bearer owner'),
    { dir, now: () => now + 4, authorizeOwner: () => true },
  );
  expect(revokeWhileRecoverable.status).toBe(404);
  const retry = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: submittedValue }, `Bearer ${bearer}`),
    { dir, now: () => now + 5, verify: async () => ({ result: 'verified' }) },
  );
  expect(retry.status).toBe(401);
  expect(await fileBackend.get('cred:openai.api_key')).toBe('newer-owner-value');
});

test('an interrupted pre-write submission can be cancelled safely', async () => {
  const now = 60_000;
  const create = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { dir, now: () => now, authorizeOwner: () => true },
  );
  const { url } = await create.json() as { url: string };
  const token = new URL(url).hash.slice('#t='.length);
  const claim = await handleCredentialRegistrationClaim(jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => now + 1 });
  const { bearer } = await claim.json() as { bearer: string };
  const submittedValue = 'private-before-write';
  expect(consumeCredentialRegistrationBearer(bearer, 'cred:openai.api_key', { dir, now: now + 2, submissionValue: submittedValue }))
    .toEqual({ ok: true, slot: 'cred:openai.api_key' });

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'setup-credentials.fixture.ts'), dir, bearer, 'cred:openai.api_key', submittedValue, String(now + 3), 'before-write'],
    { stdout: 'pipe', stderr: 'pipe', env: interruptionFixtureEnv(dir) },
  );
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).not.toBe(0);
  expect(stderr).toBe('');
  expect(await fileBackend.get('cred:openai.api_key')).toBeUndefined();

  const revoked = await handleCredentialRegistrationLinkRevoke(
    jsonPost('https://nexus.example/v1/credentials/registration-links/revoke', { t: token }, 'Bearer owner'),
    { dir, now: () => now + 4, authorizeOwner: () => true },
  );
  expect(revoked.status).toBe(200);
  const retry = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: submittedValue }, `Bearer ${bearer}`),
    { dir, now: () => now + 5, verify: async () => ({ result: 'verified' }) },
  );
  expect(retry.status).toBe(401);
  expect(await fileBackend.get('cred:openai.api_key')).toBeUndefined();
});

test('credential registration claims reject generic setup links and malformed submissions without exposing values', async () => {
  const generic = issueSetupLinkToken({ dir, now: 10_000 });
  const ordinary = await handleCredentialRegistrationClaim(
    jsonPost('https://nexus.example/v1/setup/credential-claim', { t: generic.token }), { dir, now: () => 10_001 },
  );
  expect(ordinary.status).toBe(401);
  expect(await ordinary.json()).toEqual({ error: 'unknown' });
  const expired = await handleCredentialRegistrationLinkCreate(
    jsonPost('https://nexus.example/v1/credentials/registration-links', { slot: 'cred:openai.api_key' }),
    { authorizeOwner: () => true, now: () => 1 },
  );
  const link = await expired.json() as { url: string };
  const token = new URL(link.url).hash.slice('#t='.length);
  const tooLate = await handleCredentialRegistrationClaim(
    jsonPost('https://nexus.example/v1/setup/credential-claim', { t: token }), { dir, now: () => 600_001 },
  );
  expect(tooLate.status).toBe(401);
  expect(await tooLate.json()).toEqual({ error: 'expired' });

  const errors = await handleCredentialRegistrationSubmit(
    jsonPost('https://nexus.example/v1/setup/credential-register', { slot: 'cred:openai.api_key', value: 'private' }),
  );
  expect(errors.status).toBe(401);
  expect(await errors.text()).not.toContain('private');
});
