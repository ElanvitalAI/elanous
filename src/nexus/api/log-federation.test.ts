import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const previousHome = process.env.HOME;
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'log-federation-test-'));
mkdirSync(join(TEST_ROOT, 'home'), { recursive: true });
process.env.ELANOUS_STATE_DIR = TEST_ROOT;
process.env.HOME = join(TEST_ROOT, 'home');
const { LogStore, logsDbPath } = await import('../../mss/logging/log-store.js');
const { configureLogFederation, disconnectLogFederation, handleLogFederationBatch, handleLogFederationRevoke, readLogFederationStatus, registerLogFederationWorker } = await import('../../mss/logging/log-federation.js');
const { issueIngestToken } = await import('./ingest-token.js');
const { resolveLogTargets } = await import('../../cli/logs-cli.js');

afterAll(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe('remote log federation ingest', () => {
  it('requires explicit consent and a secure HQ endpoint before enabling', () => {
    expect(() => configureLogFederation({ instance: 'remote-node', endpoint: 'https://hq.example', token: 'a'.repeat(40), consent: false }))
      .toThrow('explicit --consent');
    expect(() => configureLogFederation({ instance: 'remote-node', endpoint: 'http://hq.example', token: 'a'.repeat(40), consent: true }))
      .toThrow('requires HTTPS');
  });
  it('binds the token identity, redacts secrets and usernames, deduplicates retries, and exposes the HQ instance selector', async () => {
    const store = new LogStore(':memory:', { instance: 'hq' });
    const record = {
      ts: '2026-11-03T04:00:00.000Z', category: 'remote.boot', event: 'ready',
      data: { token: 'sensitive-value', path: '/Users/joosu/project', note: 'Bearer abcdefghijklmnopqrstuvwxyz123456' },
      host_id: 'remote-host-7',
      source: { platform: 'nexus' },
    };
    const token = issueIngestToken('minim5').token;
    const send = () => handleLogFederationBatch(new Request('https://hq.test/v1/log-federation/batch', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instance: 'minim5', records: [{ sourceId: 'sender-a:1', record }] }),
    }), { store: () => store });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const rows = store.query({ instances: ['minim5'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.surface).toBe('nexus');
    expect(rows[0]!.host_id).toBe('remote-host-7');
    expect(rows[0]!.data).toContain('<redacted>');
    expect(rows[0]!.data).not.toContain('sensitive-value');
    expect(rows[0]!.data).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(rows[0]!.data).not.toContain('joosu');
    expect(resolveLogTargets({ instance: 'minim5' }, { instances: [] }).targets).toEqual([
      { name: 'minim5', dbPath: logsDbPath() },
    ]);
    store.close();
  });


  it('ships the local logs.db spool periodically and advances its cursor only after HQ accepts', async () => {
    const remoteStore = new LogStore(':memory:', { instance: 'remote-node' });
    const hqStore = new LogStore(logsDbPath(), { instance: 'hq' });
    remoteStore.insertBatch([{ rec: { ts: '2026-11-03T04:00:00.000Z', category: 'remote.probe', event: 'queued', data: { path: '/home/joosu/app', token: 'sensitive-spool-token', note: 'Bearer abcdefghijklmnopqrstuvwxyz123456' } }, surface: 'nexus' }]);
    configureLogFederation({ instance: 'remote-node', endpoint: 'https://hq.example', token: 'a'.repeat(40), consent: true });
    let attempts = 0;
    const worker = registerLogFederationWorker({
      pollMs: 5, retryBaseMs: 10,
      store: () => remoteStore,
      fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(url).toBe('https://hq.example/v1/log-federation/batch');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'a'.repeat(40)}`);
        const wireBody = String(init?.body);
        expect(wireBody).not.toContain('sensitive-spool-token');
        expect(wireBody).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
        expect(wireBody).not.toContain('/home/joosu');
        expect(wireBody).toContain('/home/<redacted>/app');
        if (++attempts === 1) throw new Error('HQ offline');
        return handleLogFederationBatch(new Request(url, init), { authorize: () => 'remote-node', store: () => hqStore });
      }) as unknown as typeof fetch,
    });
    try {
      const deadline = Date.now() + 1_000;
      while (hqStore.query({ instances: ['remote-node'] }).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const rows = hqStore.query({ instances: ['remote-node'] });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data).toContain('/home/<redacted>/app');
      expect(readLogFederationStatus()?.afterId).toBe(1);
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(resolveLogTargets({ instance: 'remote-node' }, { instances: [] }).targets[0]?.dbPath).toBe(logsDbPath());
    } finally { worker(); remoteStore.close(); hqStore.close(); }
    await disconnectLogFederation((async () => new Response(JSON.stringify({ ok: true, revoked: 'remote-node' }), { status: 200 })) as unknown as typeof fetch);
  });


  it('disconnect retries after HQ revocation succeeds but its response is lost', async () => {
    const issued = issueIngestToken('revocable-node');
    configureLogFederation({ instance: 'revocable-node', endpoint: 'https://hq.example', token: issued.token, consent: true });
    await expect(disconnectLogFederation((async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as unknown as typeof fetch)).rejects.toThrow('HTTP 404');
    expect(readLogFederationStatus()).toMatchObject({ instance: 'revocable-node', enabled: false });
    await expect(disconnectLogFederation((async (url: RequestInfo | URL, init?: RequestInit) => {
      await handleLogFederationRevoke(new Request(url, init));
      throw new Error('response lost');
    }) as unknown as typeof fetch)).rejects.toThrow('local federation is paused');
    expect(readLogFederationStatus()?.enabled).toBe(false);
    const instance = await disconnectLogFederation((async (url: RequestInfo | URL, init?: RequestInit) => handleLogFederationRevoke(new Request(url, init))) as typeof fetch);
    expect(instance).toBe('revocable-node');
    expect(readLogFederationStatus()).toBeNull();
  });

  it('rejects a partially invalid batch without inserting valid records', async () => {
    const store = new LogStore(':memory:', { instance: 'hq' });
    const token = issueIngestToken('batch-check').token;
    const response = await handleLogFederationBatch(new Request('https://hq.test/v1/log-federation/batch', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instance: 'batch-check', records: [
        { sourceId: 'sender:1', record: { ts: '2026-11-03T04:00:00.000Z', category: 'valid', event: 'first' } },
        { sourceId: '', record: { ts: 42, category: 'invalid', event: 'second' } },
        null,
      ] }),
    }), { store: () => store });
    expect(response.status).toBe(400);
    expect(store.query({ instances: ['batch-check'] })).toHaveLength(0);
    store.close();
  });

  it('does not recreate federation after disconnect completes during an in-flight batch', async () => {
    const remoteStore = new LogStore(':memory:', { instance: 'race-node' });
    remoteStore.insertBatch([{ rec: { ts: '2026-11-03T04:00:00.000Z', category: 'remote.race', event: 'queued' }, surface: 'nexus' }]);
    configureLogFederation({ instance: 'race-node', endpoint: 'https://hq.example', token: 'b'.repeat(40), consent: true });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finish!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { finish = resolve; });
    const worker = registerLogFederationWorker({
      pollMs: 5, retryBaseMs: 10, store: () => remoteStore,
      fetcher: (async () => { markStarted(); return pendingResponse; }) as unknown as typeof fetch,
    });
    try {
      await started;
      const moduleUrl = new URL('../../mss/logging/log-federation.ts', import.meta.url).href;
      const childScript = `const m = await import(${JSON.stringify(moduleUrl)}); await m.disconnectLogFederation(async () => new Response(JSON.stringify({ ok: true, revoked: 'race-node' }), { status: 200 }));`;
      const child = spawnSync(process.execPath, ['-e', childScript], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
      finish(new Response(JSON.stringify({ ok: true, instance: 'race-node', accepted: 1 }), { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readLogFederationStatus()).toBeNull();
    } finally { worker(); remoteStore.close(); }
  });

  it('splits batches below the HQ byte limit and skips one oversized local row without blocking later rows', async () => {
    const remoteStore = new LogStore(':memory:', { instance: 'sized-node' });
    remoteStore.insertBatch([
      { rec: { ts: '2026-11-03T04:00:00.000Z', category: 'sized', event: 'large-a', data: { value: 'a'.repeat(480_000) } }, surface: 'nexus' },
      { rec: { ts: '2026-11-03T04:00:01.000Z', category: 'sized', event: 'too-large', data: { value: 'x'.repeat(950_000) } }, surface: 'nexus' },
      { rec: { ts: '2026-11-03T04:00:02.000Z', category: 'sized', event: 'large-b', data: { value: 'b'.repeat(480_000) } }, surface: 'nexus' },
    ]);
    configureLogFederation({ instance: 'sized-node', endpoint: 'https://hq.example', token: 'c'.repeat(40), consent: true });
    const bodies: string[] = [];
    const worker = registerLogFederationWorker({
      pollMs: 5, retryBaseMs: 10, store: () => remoteStore,
      fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe('error');
        const body = String(init?.body);
        expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(900_000);
        bodies.push(body);
        return new Response(JSON.stringify({ ok: true, instance: 'sized-node', accepted: (JSON.parse(body) as { records: unknown[] }).records.length }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    try {
      const deadline = Date.now() + 1_000;
      while ((readLogFederationStatus()?.afterId ?? 0) < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readLogFederationStatus()?.afterId).toBe(3);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      expect(bodies.every((body) => !body.includes('too-large'))).toBe(true);
      expect(remoteStore.query({ instances: ['sized-node'] })).toHaveLength(3);
    } finally {
      worker(); remoteStore.close();
      if (readLogFederationStatus()) await disconnectLogFederation((async () => new Response(JSON.stringify({ ok: true, revoked: 'sized-node' }), { status: 200 })) as unknown as typeof fetch);
    }
  });

  it('does not advance its cursor on a forged 200 receipt', async () => {
    const remoteStore = new LogStore(':memory:', { instance: 'forged-node' });
    remoteStore.insertBatch([{ rec: { ts: '2026-11-03T04:00:00.000Z', category: 'forged', event: 'queued' }, surface: 'nexus' }]);
    configureLogFederation({ instance: 'forged-node', endpoint: 'https://hq.example', token: 'e'.repeat(40), consent: true });
    const worker = registerLogFederationWorker({
      pollMs: 5, retryBaseMs: 60_000, store: () => remoteStore,
      fetcher: (async () => new Response(JSON.stringify({ ok: true, instance: 'other-node', accepted: 1 }), { status: 200 })) as unknown as typeof fetch,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readLogFederationStatus()?.afterId).toBe(0);
    } finally {
      worker(); remoteStore.close();
      if (readLogFederationStatus()) await disconnectLogFederation((async () => new Response(JSON.stringify({ ok: true, revoked: 'forged-node' }), { status: 200 })) as unknown as typeof fetch);
    }
  });

  it('sets redirect:error on cross-origin and HTTPS-to-HTTP batch redirects', async () => {
    const locations = ['https://collector.example/steal', 'http://hq.example/v1/log-federation/batch'];
    for (let index = 0; index < locations.length; index += 1) {
      const instance = index === 0 ? 'redirect-node' : 'downgrade-node';
      const remoteStore = new LogStore(':memory:', { instance });
      remoteStore.insertBatch([{ rec: { ts: '2026-11-03T04:00:00.000Z', category: 'redirect', event: 'queued' }, surface: 'nexus' }]);
      configureLogFederation({ instance, endpoint: 'https://hq.example', token: 'f'.repeat(40), consent: true });
      let attempts = 0;
      const worker = registerLogFederationWorker({
        pollMs: 5, retryBaseMs: 60_000, store: () => remoteStore,
        fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          attempts += 1;
          expect(init?.redirect).toBe('error');
          return new Response(null, { status: 307, headers: { location: locations[index]! } });
        }) as unknown as typeof fetch,
      });
      try {
        const deadline = Date.now() + 500;
        while (attempts === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(attempts).toBe(1);
        expect(readLogFederationStatus()?.afterId).toBe(0);
      } finally {
        worker(); remoteStore.close();
        if (readLogFederationStatus()) await disconnectLogFederation((async () => new Response(JSON.stringify({ ok: true, revoked: instance }), { status: 200 })) as unknown as typeof fetch);
      }
    }
  });

  it('rejects a batch whose instance differs from the scoped ingest token name', async () => {
    const store = new LogStore(':memory:', { instance: 'hq' });
    const response = await handleLogFederationBatch(new Request('https://hq.test/v1/log-federation/batch', {
      method: 'POST', body: JSON.stringify({ instance: 'other', records: [] }),
    }), { authorize: () => 'minim5', store: () => store });
    expect(response.status).toBe(400);
    store.close();
  });
});
