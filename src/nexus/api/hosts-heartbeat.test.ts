import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleHostsHeartbeatPost } from './hosts-heartbeat.js';
import { readHostLedgerStrict, writeHostLedgerAtomic, toHostMap } from '../host-registry/store.js';
import type { HostRecord } from '../host-registry/types.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW_ISO = '2026-11-23T08:00:00.000Z';
const NOW = Date.parse(NOW_ISO);

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'hosts-hb-')); }

test('installed-sha heartbeat: host identity comes from the machine token, never the body', async () => {
  const recorded: Array<{ host: string; installedSha: string; now: number }> = [];
  const record = (host: string, installedSha: string, now: number) => { recorded.push({ host, installedSha, now }); return { host, channel: 'unknown', installedSha, lastHeartbeatMs: now, state: 'unknown' } as HostRecord; };
  const mismatch = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
    method: 'POST', body: JSON.stringify({ host: 'aws1', installedSha: SHA_A, at: NOW_ISO }),
  }), 'node-b', { record, desiredSha: () => SHA_A, now: () => NOW });
  expect(mismatch.status).toBe(403);
  expect(await (mismatch.json() as Promise<{ error?: string }>)).toEqual({ error: 'host-token-mismatch' });
  expect(recorded).toEqual([]);

  const accepted = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
    method: 'POST', body: JSON.stringify({ installedSha: SHA_A, seat: 'TC-H-CC-1', channel: 'dev', at: NOW_ISO }),
  }), 'node-b', { record, desiredSha: () => SHA_A, now: () => NOW });
  expect(accepted.status).toBe(201);
  expect(accepted.headers.get('cache-control')).toBe('no-store');
  expect(recorded).toEqual([{ host: 'node-b', installedSha: SHA_A, now: NOW }]);
});

test('remote heartbeat lands in the CENTRAL hosts list registry (real recordHeartbeat)', async () => {
  const dir = tempDir();
  const ledgerPath = join(dir, 'host-registry.json');
  try {
    const behind = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
      method: 'POST', body: JSON.stringify({ host: 'node-b', installedSha: SHA_A, seat: 'TC-H-CC-1', channel: 'dev', at: NOW_ISO }),
    }), 'node-b', { ledgerPath, desiredSha: () => SHA_B, now: () => NOW });
    expect(behind.status).toBe(201);
    const behindBody = await behind.json() as { ok?: boolean; host?: string; state?: string; at?: string };
    expect(behindBody).toEqual({ ok: true, host: 'node-b', state: 'behind', at: NOW_ISO });

    const current = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
      method: 'POST', body: JSON.stringify({ host: 'node-b', installedSha: SHA_B.toUpperCase(), at: '2026-11-23T08:01:00.000Z' }),
    }), 'node-b', { ledgerPath, desiredSha: () => SHA_B, now: () => NOW });
    expect(current.status).toBe(201);
    expect(await current.json() as Promise<{ state?: string }>).toMatchObject({ state: 'current' });

    const central = readHostLedgerStrict(ledgerPath);
    expect(central?.hosts['node-b']).toMatchObject({
      host: 'node-b', seat: 'TC-H-CC-1', channel: 'dev', installedSha: SHA_B, lastHeartbeatMs: Date.parse('2026-11-23T08:01:00.000Z'),
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('re-heartbeat preserves previous aliases/seat/channel; omitted at uses server now', async () => {
  const dir = tempDir();
  const ledgerPath = join(dir, 'host-registry.json');
  try {
    writeHostLedgerAtomic({
      version: 1,
      hosts: toHostMap([['node-c', { host: 'node-c', aliases: ['MacStudio-mini'], seat: 'OP', channel: 'release', installedSha: 'c'.repeat(40), lastHeartbeatMs: NOW - 60_000, state: 'behind' }]]),
    }, ledgerPath);
    const response = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
      method: 'POST', body: JSON.stringify({ host: 'node-c', installedSha: SHA_A }),
    }), 'node-c', { ledgerPath, desiredSha: () => SHA_B, now: () => NOW });
    expect(response.status).toBe(201);
    const central = readHostLedgerStrict(ledgerPath);
    expect(central?.hosts['node-c']).toMatchObject({ aliases: ['MacStudio-mini'], seat: 'OP', channel: 'release', installedSha: SHA_A, lastHeartbeatMs: NOW });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid heartbeat bodies are rejected without touching the central registry', async () => {
  const dir = tempDir();
  const ledgerPath = join(dir, 'host-registry.json');
  try {
    const cases: Array<[string, unknown, string]> = [
      ['installed-sha-required', { host: 'node-b', at: NOW_ISO }, 'sha missing'],
      ['installed-sha-required', { host: 'node-b', installedSha: 'not-a-sha', at: NOW_ISO }, 'sha not 40-hex'],
      ['invalid-channel', { host: 'node-b', installedSha: SHA_A, channel: 'beta', at: NOW_ISO }, 'channel not dev|release'],
      ['invalid-seat', { host: 'node-b', installedSha: SHA_A, seat: 7, at: NOW_ISO }, 'seat not a string'],
      ['invalid-at', { host: 'node-b', installedSha: SHA_A, at: 'yesterday' }, 'at not ISO'],
      ['heartbeat-required', 'a string body', 'body not an object'],
    ];
    for (const [expected, body] of cases) {
      const response = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
        method: 'POST', body: JSON.stringify(body),
      }), 'node-b', { ledgerPath, desiredSha: () => SHA_B, now: () => NOW });
      expect(response.status).toBe(400);
      expect(await (response.json() as Promise<{ error?: string }>)).toEqual({ error: expected });
    }
    const invalidJson = await handleHostsHeartbeatPost(new Request('https://nexus.test/v1/hosts/heartbeat', {
      method: 'POST', body: '{not json',
    }), 'node-b', { ledgerPath, desiredSha: () => SHA_B, now: () => NOW });
    expect(invalidJson.status).toBe(400);
    expect(await (invalidJson.json() as Promise<{ error?: string }>)).toEqual({ error: 'invalid-json' });
    expect(readHostLedgerStrict(ledgerPath)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
