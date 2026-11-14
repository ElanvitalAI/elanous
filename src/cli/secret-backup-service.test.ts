import { expect, test } from 'bun:test';
import { chmodSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { createMemberCloudBackupRoute } from '../nexus/members/member-cloud-backup-route.js';
import { MAX_BACKUP_WIRE_BYTES } from '../nexus/members/cloud-backup-e2e.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { pushSecretBackup, restoreSecretBackup, statusSecretBackup } from './secret-backup-service.js';

test('member route and secret backup CLI service keep values client-side and enforce member ownership and rollback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-cli-'));
  const dbPath = join(dir, 'cloud-backups.sqlite');
  const store = createMemberStore({ path: join(dir, 'members.sqlite') });
  const route = createMemberCloudBackupRoute({ memberStore: store, dbPath });
  try {
    const api = createMembersApi({ store, cloudBackupRoute: route,
      google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
      successRedirectUri: 'https://app.example.test/member', webOrigin: 'https://app.example.test' });
    const httpOptions = { membersApi: api } as NexusHttpServerOpts;
    const throughNexus = (request: Request) => routeRequest(request, httpOptions, {} as never,
      null, createDevProxyRuntimeRef());
    const member = (name: string) => {
      const profile = store.register({ sub: `synthetic-${name}`, email: `${name}@example.test`,
        emailVerified: true, name }, { consents: { privacy: 'v1', terms: 'v1' } });
      return { profile, token: store.createSession(profile.id, '2026-11-14T00:00:00Z').token };
    };
    const alice = member('alice');
    const bob = member('bob');
    const aliceSession = join(dir, 'alice.session');
    const bobSession = join(dir, 'bob.session');
    const identityFile = join(dir, 'backup.identity');
    writeFileSync(aliceSession, alice.token, { mode: 0o600 });
    writeFileSync(bobSession, bob.token, { mode: 0o600 });
    let loseFirstPostResponse = true;
    let postCount = 0;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await throughNexus(request);
      if (!response) throw new Error('fake member route not handled');
      if (request.method === 'POST' && new URL(request.url).pathname === '/v1/members/secret-backups') {
        postCount += 1;
        if (loseFirstPostResponse) {
          loseFirstPostResponse = false;
          throw new Error('SYNTHETIC_LOST_RESPONSE_AFTER_COMMIT');
        }
      }
      return response;
    }) as typeof fetch;
    const options = { baseUrl: 'https://api.example.test', sessionFile: aliceSession, identityFile };
    const imported: Record<string, string> = {};
    let importCount = 0;
    const deps = { fetch: fakeFetch,
      listSecrets: async () => ['OPENAI_API_KEY', 'app/not-backed-up', 'cred:unsupported'],
      getSecret: async (id: string) => id === 'OPENAI_API_KEY' ? 'SYNTHETIC-STATIC-KEY' : 'never-read',
      importSecrets: async (secrets: Readonly<Record<string, string>>) => {
        importCount += 1;
        Object.assign(imported, secrets);
        return { imported: true, conflicts: [], changedSinceConfirmation: false };
      } };
    const unauth = await throughNexus(new Request('https://api.example.test/v1/members/secret-backups'));
    expect(unauth?.status).toBe(401);
    const adminOnly = await throughNexus(new Request('https://api.example.test/v1/members/secret-backups',
      { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC-ADMIN' } }));
    expect(adminOnly?.status).toBe(401);
    await expect(pushSecretBackup(options, deps)).rejects.toThrow('SYNTHETIC_LOST_RESPONSE_AFTER_COMMIT');
    expect((JSON.parse(readFileSync(identityFile, 'utf8')) as { generation: number }).generation).toBe(0);
    const first = await pushSecretBackup(options, deps);
    expect(first.generation).toBe(1);
    expect(postCount).toBe(1);
    expect(statSync(identityFile).mode & 0o077).toBe(0);
    expect(readFileSync(identityFile, 'utf8')).not.toContain('SYNTHETIC-STATIC-KEY');
    const db = new Database(dbPath);
    let priorEnvelope: string;
    try {
      const row = db.query('SELECT owner,envelope FROM member_backup WHERE id=?').get(first.id) as { owner: string; envelope: string };
      expect(row.owner).toBe(alice.profile.id);
      expect(row.envelope).not.toContain('SYNTHETIC-STATIC-KEY');
      priorEnvelope = row.envelope;
    } finally { db.close(); }
    const otherMember = await throughNexus(new Request(`https://api.example.test/v1/members/secret-backups/${first.id}`,
      { headers: { cookie: `__Host-elanous_member_session=${bob.token}` } }));
    expect(otherMember?.status).toBe(404);
    expect((await statusSecretBackup(options, deps)).generation).toBe(1);
    expect((await restoreSecretBackup(options, deps)).count).toBe(1);
    expect(imported).toEqual({ OPENAI_API_KEY: 'SYNTHETIC-STATIC-KEY' });
    await expect(restoreSecretBackup({ ...options, sessionFile: bobSession }, deps)).rejects.toThrow('BACKUP_RECOVERY_DENIED');
    const second = await pushSecretBackup(options, deps);
    expect(second.generation).toBe(2);
    const currentDb = new Database(dbPath);
    let secondEnvelope: string;
    try {
      secondEnvelope = (currentDb.query('SELECT envelope FROM member_backup WHERE id=?').get(first.id) as { envelope: string }).envelope;
    } finally { currentDb.close(); }
    const behind = JSON.parse(readFileSync(identityFile, 'utf8')) as { generation: number };
    behind.generation = 1;
    writeFileSync(identityFile, JSON.stringify(behind), { mode: 0o600 });
    let failedUploads = 0;
    await expect(pushSecretBackup(options, { ...deps,
      getSecret: async () => 'SYNTHETIC-CHANGED-KEY',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          failedUploads += 1;
          return Response.json({ error: 'synthetic unavailable' }, { status: 503 });
        }
        return fakeFetch(input, init);
      }) as typeof fetch,
    })).rejects.toThrow('BACKUP_UPLOAD_FAILED');
    expect(failedUploads).toBe(1);
    expect((JSON.parse(readFileSync(identityFile, 'utf8')) as { generation: number }).generation).toBe(2);
    const replayDb = new Database(dbPath);
    try {
      replayDb.query('UPDATE member_backup SET generation=1,envelope=?,sha256=? WHERE owner=? AND id=?')
        .run(priorEnvelope, JSON.parse(priorEnvelope).sha256, alice.profile.id, first.id);
    } finally { replayDb.close(); }
    await expect(restoreSecretBackup(options, deps)).rejects.toThrow('BACKUP_RECOVERY_DENIED');
    const resumeDb = new Database(dbPath);
    try {
      resumeDb.query('UPDATE member_backup SET generation=2,envelope=?,sha256=? WHERE owner=? AND id=?')
        .run(secondEnvelope, JSON.parse(secondEnvelope).sha256, alice.profile.id, first.id);
    } finally { resumeDb.close(); }
    writeFileSync(identityFile, JSON.stringify(behind), { mode: 0o600 });
    const importsBeforeFailure = importCount;
    let restoreSyncCalls = 0;
    await expect(restoreSecretBackup(options, { ...deps, fsyncIdentity: fd => {
      fsyncSync(fd);
      restoreSyncCalls += 1;
      if (restoreSyncCalls === 4) throw new Error('SYNTHETIC_RESTORE_FLOOR_FSYNC_FAIL');
    } })).rejects.toThrow('SYNTHETIC_RESTORE_FLOOR_FSYNC_FAIL');
    expect(restoreSyncCalls).toBe(4);
    expect(importCount).toBe(importsBeforeFailure);
    expect((await restoreSecretBackup(options, deps)).generation).toBe(2);
    expect(importCount).toBe(importsBeforeFailure + 1);
    const rollback = new Database(dbPath);
    try {
      rollback.query('UPDATE member_backup SET generation=1,envelope=?,sha256=? WHERE owner=? AND id=?')
        .run(priorEnvelope, JSON.parse(priorEnvelope).sha256, alice.profile.id, first.id);
    } finally { rollback.close(); }
    await expect(restoreSecretBackup(options, deps)).rejects.toThrow('BACKUP_RECOVERY_DENIED');
  } finally { route.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('untrusted storage cannot stream an oversized or indefinitely stalled response into the client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-bounds-'));
  try {
    const sessionFile = join(dir, 'session');
    writeFileSync(sessionFile, 'SYNTHETIC-MEMBER-SESSION', { mode: 0o600 });
    const options = { baseUrl: 'https://api.example.test', sessionFile, identityFile: join(dir, 'missing-identity') };
    chmodSync(sessionFile, 0o644);
    await expect(statusSecretBackup(options, { fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ backups: [] })) as typeof fetch })).rejects.toThrow('BACKUP_PRIVATE_FILE_REQUIRED');
    chmodSync(sessionFile, 0o600);
    expect((await statusSecretBackup(options, { fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ backups: [{ id: 'other-member-backup', generation: 1 }] })) as typeof fetch })).remote).toBe('unknown');
    expect((await statusSecretBackup(options, { fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ backups: [] })) as typeof fetch })).remote).toBe('absent');
    // 출처: #36826 E2E wire cap plus response wrapper budget; one extra byte must be rejected while streaming.
    const oversized = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_BACKUP_WIRE_BYTES + 1025));
      controller.close();
    } }), { status: 200 });
    await expect(statusSecretBackup(options, { fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => oversized) as typeof fetch }))
      .rejects.toThrow('BACKUP_RESPONSE_TOO_LARGE');
    const stalled = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }),
      { status: 200 });
    // 출처: #36826 untrusted-storage deadline regression; the small synthetic timeout tests abort, not elapsed wall time.
    await expect(statusSecretBackup(options, { timeoutMs: 20,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => stalled) as typeof fetch }))
      .rejects.toThrow('BACKUP_TIMEOUT');
    // 출처: #36826 the same synthetic deadline must also abort a fetch that never returns headers.
    await expect(statusSecretBackup(options, { timeoutMs: 20,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {})) as typeof fetch }))
      .rejects.toThrow('BACKUP_TIMEOUT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identity durability failure stops before any member upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-durable-'));
  try {
    const sessionFile = join(dir, 'session');
    writeFileSync(sessionFile, 'SYNTHETIC-MEMBER-SESSION', { mode: 0o600 });
    let fetches = 0;
    let syncCalls = 0;
    const options = { baseUrl: 'https://api.example.test', sessionFile, identityFile: join(dir, 'identity') };
    await expect(pushSecretBackup(options, {
      fsyncIdentity: fd => {
        fsyncSync(fd);
        syncCalls += 1;
        if (syncCalls === 2) throw new Error('SYNTHETIC_DIRECTORY_FSYNC_FAIL');
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        fetches += 1;
        return Response.json({ backups: [] });
      }) as typeof fetch,
    })).rejects.toThrow('SYNTHETIC_DIRECTORY_FSYNC_FAIL');
    expect(syncCalls).toBe(2);
    expect(fetches).toBe(0);
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
    await expect(pushSecretBackup(options, {
      fsyncIdentity: fd => {
        fsyncSync(fd);
        syncCalls += 1;
        if (syncCalls === 3) throw new Error('SYNTHETIC_RETRY_FILE_FSYNC_FAIL');
      },
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => { fetches += 1; return Response.json({ backups: [] }); }) as typeof fetch,
      listSecrets: async () => ['OPENAI_API_KEY'], getSecret: async () => 'SYNTHETIC-KEY',
    })).rejects.toThrow('SYNTHETIC_RETRY_FILE_FSYNC_FAIL');
    expect(fetches).toBe(0);
    const recovered = await pushSecretBackup(options, {
      fsyncIdentity: fd => { fsyncSync(fd); syncCalls += 1; },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetches += 1;
        if (new URL(input.toString()).pathname === '/v1/members/secret-backups' && init?.method === 'POST') {
          const envelope = JSON.parse(String(init.body)) as { id: string; generation: number; sha256: string };
          return Response.json({ id: envelope.id, generation: envelope.generation, sha256: envelope.sha256 });
        }
        return Response.json({ error: 'missing' }, { status: 404 });
      }) as typeof fetch,
      listSecrets: async () => ['OPENAI_API_KEY'], getSecret: async () => 'SYNTHETIC-KEY',
    });
    expect(recovered.generation).toBe(1);
    expect(fetches).toBe(2);
    expect(syncCalls).toBe(7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a listed secret disappearing or failing to read never replaces the complete remote bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-partial-'));
  try {
    const sessionFile = join(dir, 'session');
    writeFileSync(sessionFile, 'SYNTHETIC-MEMBER-SESSION', { mode: 0o600 });
    const options = { baseUrl: 'https://api.example.test', sessionFile, identityFile: join(dir, 'identity') };
    let remote: { id: string; generation: number; sha256: string } | null = null;
    let requests = 0;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      const request = new Request(input, init);
      if (request.method === 'GET')
        return remote ? Response.json({ backup: remote }) : Response.json({ error: 'missing' }, { status: 404 });
      const envelope = JSON.parse(String(init?.body)) as { id: string; generation: number; sha256: string };
      remote = envelope;
      return Response.json({ id: envelope.id, generation: envelope.generation, sha256: envelope.sha256 });
    }) as typeof fetch;
    const listSecrets = async () => ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
    expect((await pushSecretBackup(options, { fetch: fakeFetch, listSecrets,
      getSecret: async id => `SYNTHETIC-${id}` })).generation).toBe(1);
    const completeEnvelope = JSON.stringify(remote);
    const completeRequests = requests;
    await expect(pushSecretBackup(options, { fetch: fakeFetch, listSecrets,
      getSecret: async id => id === 'OPENAI_API_KEY' ? undefined : `SYNTHETIC-${id}` }))
      .rejects.toThrow('BACKUP_LISTED_SECRET_MISSING');
    expect(requests).toBe(completeRequests);
    expect(JSON.stringify(remote)).toBe(completeEnvelope);
    await expect(pushSecretBackup(options, { fetch: fakeFetch, listSecrets,
      getSecret: async id => {
        if (id === 'OPENAI_API_KEY') throw new Error('SYNTHETIC_READ_FAILURE');
        return `SYNTHETIC-${id}`;
      } })).rejects.toThrow('SYNTHETIC_READ_FAILURE');
    expect(requests).toBe(completeRequests);
    expect(JSON.stringify(remote)).toBe(completeEnvelope);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cross-process push waits until restore imports the authenticated generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-backup-process-race-'));
  const sessionFile = join(dir, 'session');
  const identityFile = join(dir, 'identity');
  writeFileSync(sessionFile, 'SYNTHETIC-MEMBER-SESSION', { mode: 0o600 });
  let remote: { id: string; generation: number; sha256: string } | null = null;
  let putCount = 0;
  const server = Bun.serve({ hostname: 'localhost', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.headers.get('cookie') !== '__Host-elanous_member_session=SYNTHETIC-MEMBER-SESSION')
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (request.method === 'GET' && path.startsWith('/v1/members/secret-backups/'))
      return remote ? Response.json({ backup: remote }) : Response.json({ error: 'missing' }, { status: 404 });
    if (request.method === 'POST' || request.method === 'PUT') {
      const next = await request.json() as typeof remote;
      if (!next) return Response.json({ error: 'missing' }, { status: 400 });
      if (request.method === 'PUT') putCount += 1;
      remote = next;
      return Response.json({ id: next.id, generation: next.generation, sha256: next.sha256 });
    }
    return Response.json({ error: 'missing' }, { status: 404 });
  } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const options = { baseUrl: `http://localhost:${server.port}`, sessionFile, identityFile };
    expect((await pushSecretBackup(options, {
      listSecrets: async () => ['OPENAI_API_KEY'], getSecret: async () => 'SYNTHETIC-OLD',
    })).generation).toBe(1);
    let signalRead: (() => void) | undefined;
    const readStarted = new Promise<void>(resolve => { signalRead = resolve; });
    let releaseRead: (() => void) | undefined;
    const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(input.toString()).pathname.endsWith((remote as { id: string }).id)) {
        signalRead?.();
        return new Promise<Response>(resolve => { releaseRead = () => { void fetch(input, init).then(resolve); }; });
      }
      return fetch(input, init);
    }) as typeof fetch;
    let importedAtGeneration: number | undefined;
    const restoring = restoreSecretBackup(options, { fetch: delayedFetch,
      importSecrets: async () => {
        importedAtGeneration = remote?.generation;
        return { imported: true, conflicts: [], changedSinceConfirmation: false };
      },
    });
    await readStarted;
    const childScript = join(dir, 'push-child.ts');
    writeFileSync(childScript, `import { pushSecretBackup } from ${JSON.stringify(new URL('./secret-backup-service.ts', import.meta.url).href)};\n`
      + `await pushSecretBackup(${JSON.stringify(options)}, { listSecrets: async () => ['OPENAI_API_KEY'],`
      + ` getSecret: async () => 'SYNTHETIC-NEW', onIdentityLockWait: () => process.stdout.write('WAIT\\n') });\n`
      + `process.stdout.write('DONE\\n');\n`);
    child = Bun.spawn([process.execPath, childScript], { cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', HOME: dir, ELANOUS_STATE_DIR: dir },
      stdout: 'pipe', stderr: 'pipe' });
    const stdout = child.stdout;
    if (!stdout || typeof stdout === 'number') throw new Error('CHILD_STDOUT_PIPE_REQUIRED');
    const reader = stdout.getReader();
    let childOutput = '';
    while (!childOutput.includes('WAIT\n')) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`CHILD_EXITED_BEFORE_LOCK_WAIT:${childOutput}`);
      childOutput += new TextDecoder().decode(value);
    }
    expect(putCount).toBe(0);
    releaseRead?.();
    expect((await restoring).generation).toBe(1);
    expect(importedAtGeneration).toBe(1);
    expect(await child.exited).toBe(0);
    expect(putCount).toBe(1);
    expect((remote as { generation: number } | null)?.generation).toBe(2);
  } finally {
    child?.kill();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
