import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintGroundingToken, revokeGroundingRun, verifyGroundingToken } from '../../grounding/token.js';
import {
  POD_CREDENTIAL_GLOBAL_PER_MIN,
  handlePodGrokCredential,
  resetPodCredentialRateForTesting,
} from './pod-credential-api.js';

const KEY = async () => 'pod-cred-test-key';

function tokenDeps(now = 1_000_000) {
  return {
    key: KEY,
    now: () => now,
    revokedPath: join(mkdtempSync(join(tmpdir(), 'podcred-')), 'revoked.jsonl'),
  };
}

function homeWithExpiringAccess(now: number): { home: string; expiresAt: string } {
  const home = mkdtempSync(join(tmpdir(), 'podcred-home-'));
  mkdirSync(join(home, '.grok'), { recursive: true });
  const expiresAt = new Date(now + 5 * 60 * 1000).toISOString();
  writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
    's::c': {
      key: 'host-access-before',
      expires_at: expiresAt,
      refresh_token: 'host-refresh-secret',
      user_id: 'acct-should-not-leak',
    },
  }), 'utf-8');
  return { home, expiresAt };
}

function post(token: string): Request {
  return new Request('http://127.0.0.1/v1/pod/credential/grok', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  resetPodCredentialRateForTesting();
});

describe('POST /v1/pod/credential/grok', () => {
  test('valid llm-credential token refreshes inside 10 minutes and returns only key and expires_at', async () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const d = tokenDeps(now);
    const { home } = homeWithExpiringAccess(now);
    const minted = await mintGroundingToken({ runId: 'run-1', job: 'job-1', ttlMs: 60_000, scope: 'llm-credential' }, d);
    let refreshed = false;
    const res = await handlePodGrokCredential(post(minted.token), {
      token: d,
      now: () => now,
      home,
      refreshExec: () => {
        refreshed = true;
        const later = new Date(now + 6 * 60 * 60 * 1000).toISOString();
        writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
          's::c': {
            key: 'host-access-after',
            expires_at: later,
            refresh_token: 'host-refresh-secret',
            user_id: 'acct-should-not-leak',
          },
        }), 'utf-8');
      },
    });
    expect(res.status).toBe(200);
    expect(refreshed).toBe(true);
    const raw = await res.text();
    expect(raw.includes('refresh')).toBe(false);
    expect(raw.includes('acct-should-not-leak')).toBe(false);
    expect(raw.includes(home)).toBe(false);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'key']);
    expect(body.key).toBe('host-access-after');
    expect(typeof body.expires_at).toBe('string');
  });

  test('a grounding-scope token is rejected with scope', async () => {
    const d = tokenDeps();
    const minted = await mintGroundingToken({ runId: 'run-g', job: 'job-g', ttlMs: 60_000 }, d);
    const res = await handlePodGrokCredential(post(minted.token), { token: d, now: () => 1_000_000 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ reason: 'scope' });
  });

  test('a revoked run is rejected with revoked', async () => {
    const d = tokenDeps();
    const minted = await mintGroundingToken({ runId: 'run-r', job: 'job-r', ttlMs: 60_000, scope: 'llm-credential' }, d);
    revokeGroundingRun('run-r', d);
    const res = await handlePodGrokCredential(post(minted.token), { token: d, now: () => 1_000_000 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ reason: 'revoked' });
  });

  test('a second request for the same runId inside one minute is rate', async () => {
    const now = 2_000_000;
    const d = tokenDeps(now);
    const minted = await mintGroundingToken({ runId: 'run-rate', job: 'job-rate', ttlMs: 120_000, scope: 'llm-credential' }, d);
    const deps = {
      token: d,
      now: () => now,
      loadAccess: () => ({ key: 'k', expiresAt: '2026-09-26T18:00:00.000Z' }),
    };
    expect((await handlePodGrokCredential(post(minted.token), deps)).status).toBe(200);
    const again = await handlePodGrokCredential(post(minted.token), deps);
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ reason: 'rate' });
  });

  test('distinct runIds past the global per-minute cap are rate', async () => {
    const now = 3_000_000;
    const d = tokenDeps(now);
    const deps = {
      token: d,
      now: () => now,
      loadAccess: () => ({ key: 'k', expiresAt: '2026-09-26T18:00:00.000Z' }),
    };
    for (let i = 0; i < POD_CREDENTIAL_GLOBAL_PER_MIN; i += 1) {
      const minted = await mintGroundingToken({
        runId: `run-g-${i}`, job: 'job', ttlMs: 120_000, scope: 'llm-credential',
      }, d);
      expect((await handlePodGrokCredential(post(minted.token), deps)).status).toBe(200);
    }
    const overflow = await mintGroundingToken({
      runId: 'run-g-overflow', job: 'job', ttlMs: 120_000, scope: 'llm-credential',
    }, d);
    const res = await handlePodGrokCredential(post(overflow.token), deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: 'rate' });
  });

  test('the grounding door rejects an llm-credential token with scope and leaks nothing', async () => {
    const d = tokenDeps();
    const minted = await mintGroundingToken({ runId: 'run-x', job: 'job-x', ttlMs: 60_000, scope: 'llm-credential' }, d);
    const verdict = await verifyGroundingToken(minted.token, d);
    expect(verdict).toEqual({ ok: false, reason: 'scope' });
    const surface = JSON.stringify(verdict);
    expect(surface.includes('refresh')).toBe(false);
    expect(surface.includes('/')).toBe(false);
    expect(surface.includes('acct')).toBe(false);
  });
});
