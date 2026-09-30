import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintGroundingToken, revokeGroundingRun, verifyGroundingToken } from '../../grounding/token.js';
import {
  POD_CREDENTIAL_GLOBAL_PER_MIN,
  handlePodGrokCredential,
  handlePodGithubCredential,
  installationRepositories,
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

function githubPost(token?: string, body?: string): Request {
  return new Request('http://127.0.0.1/v1/pod/credential/github', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body ? { body } : {}),
  });
}

describe('POST /v1/pod/credential/github', () => {
  // 🅢 09-30 01:25 must-fix 급 넷 중 ③④ — 토큰 값은 관측 로그에 0 번 · 런 폐기 뒤 같은 런 토큰은 거절.
  test('the issued installation token never reaches the debug log, and a revoked run token is refused', async () => {
    const now = 4_200_000;
    const d = tokenDeps(now);
    const signed = await mintGroundingToken({ runId: 'run-leak', job: 'job-leak', ttlMs: 120_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
    const logged: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    try {
      const deps = { token: d, now: () => now, installationRepositories: async () => ['owner/repo'],
        mintInstallation: () => ({ token: 'ghs_SECRET_MARK', expires_at: '2026-09-26T18:00:00.000Z' }) };
      const ok = await handlePodGithubCredential(githubPost(signed.token), deps);
      expect(ok.status).toBe(200);
      expect((await ok.json() as { token: string }).token === 'ghs_SECRET_MARK').toBe(true);
      expect(logged.length).toBeGreaterThan(0);
      expect(JSON.stringify(logged).includes('ghs_SECRET_MARK')).toBe(false);
      revokeGroundingRun('run-leak', d);
      resetPodCredentialRateForTesting();
      const refused = await handlePodGithubCredential(githubPost(signed.token), deps);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ reason: 'revoked' });
      expect(JSON.stringify(logged).includes('ghs_SECRET_MARK')).toBe(false);
    } finally { spy.mockRestore(); }
  });

  test('signed run repository selects fresh installation tokens and exposes only token and expiry', async () => {
    const now = 4_000_000;
    const d = tokenDeps(now);
    const signed = await mintGroundingToken({ runId: 'run-gh', job: 'job-gh', ttlMs: 120_000, scope: 'gh-credential', repository: 'ElanvitalAI/elanous' }, d);
    const repositories: string[] = [];
    let issued = 0;
    const deps = { token: d, now: () => now + issued * 60_000, installationRepositories: async () => ['ElanvitalAI/elanous'], mintInstallation: (repository: string) => {
      repositories.push(repository);
      return { token: `installation-${++issued}`, expires_at: '2026-09-26T18:00:00.000Z' };
    } };
    const first = await handlePodGithubCredential(githubPost(signed.token, JSON.stringify({ repository: 'other-repo' })), deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ token: 'installation-1', expires_at: '2026-09-26T18:00:00.000Z' });
    const second = await handlePodGithubCredential(githubPost(signed.token), deps);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ token: 'installation-2', expires_at: '2026-09-26T18:00:00.000Z' });
    expect(repositories).toEqual(['ElanvitalAI/elanous', 'ElanvitalAI/elanous']);
    expect(await verifyGroundingToken(signed.token, d)).toEqual({ ok: false, reason: 'scope' });
  });

  test('same-name installation under a different owner cannot serve the signed run', async () => {
    const now = 4_100_000;
    const d = tokenDeps(now);
    const signed = await mintGroundingToken({ runId: 'owner-bound', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'expected/shared' }, d);
    let requested = '';
    const res = await handlePodGithubCredential(githubPost(signed.token), {
      token: d, now: () => now,
      mintInstallation: (repository) => { requested = repository; return { token: 'wrong-owner-secret', expires_at: '2026-09-26T18:00:00.000Z' }; },
      installationRepositories: async () => ['other/shared'],
    });
    expect(requested).toBe('expected/shared');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: 'unavailable' });
  });

  test('GitHub listing requires exactly one repository, including the reported total count', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json({ total_count: 2, repositories: [{ full_name: 'owner/repo' }] })) as unknown as typeof fetch;
      expect(await installationRepositories('opaque-app-token')).toBeNull();
      globalThis.fetch = (async () => Response.json({ total_count: 1, repositories: [{ full_name: 'owner/repo' }] })) as unknown as typeof fetch;
      expect(await installationRepositories('opaque-app-token')).toEqual(['owner/repo']);
    } finally { globalThis.fetch = original; }
  });

  test('multi-repository installation token is not handed to a run even when its repository is present', async () => {
    const now = 4_150_000;
    const d = tokenDeps(now);
    const signed = await mintGroundingToken({ runId: 'multi-repo', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
    const response = await handlePodGithubCredential(githubPost(signed.token), {
      token: d, now: () => now, mintInstallation: () => ({ token: 'overbroad', expires_at: '2026-09-26T18:00:00.000Z' }),
      installationRepositories: async () => ['owner/repo', 'owner/other'],
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ reason: 'unavailable' });
  });

  test('invalid signed repository cannot select a different installation', async () => {
    const now = 4_250_000;
    const d = tokenDeps(now);
    const signed = await mintGroundingToken({ runId: 'run-gh', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo-one' }, d);
    const [payload] = signed.token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims.repository = 'repo-two';
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signed.token.split('.')[1]}`;
    let calls = 0;
    const deps = { token: d, now: () => now, mintInstallation: () => { calls++; return { token: 'secret', expires_at: '2026-09-26T18:00:00.000Z' }; } };
    expect((await handlePodGithubCredential(githubPost(forged), deps)).status).toBe(401);
    expect(calls).toBe(0);
  });

  test('the grok rate counter is independent of the GitHub rate counter', async () => {
    const now = 4_500_000;
    const d = tokenDeps(now);
    const grok = await mintGroundingToken({ runId: 'shared-run', job: 'job', ttlMs: 60_000, scope: 'llm-credential' }, d);
    const github = await mintGroundingToken({ runId: 'shared-run', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
    expect((await handlePodGrokCredential(post(grok.token), { token: d, now: () => now, loadAccess: () => ({ key: 'access', expiresAt: 'later' }) })).status).toBe(200);
    expect((await handlePodGithubCredential(githubPost(github.token), { token: d, now: () => now, mintInstallation: () => ({ token: 'app', expires_at: '2026-09-26T18:00:00.000Z' }), installationRepositories: async () => ['owner/repo'] })).status).toBe(200);
  });

  test('missing, wrong-scope, expired and revoked tokens never mint', async () => {
    const now = 5_000_000;
    const d = tokenDeps(now);
    let calls = 0;
    const deps = { token: d, now: () => now, mintInstallation: () => { calls++; return { token: 'secret', expires_at: '2026-09-26T18:00:00.000Z' }; } };
    expect((await handlePodGithubCredential(githubPost(), deps)).status).toBe(401);
    const unbound = await mintGroundingToken({ runId: 'no-repository', job: 'job', ttlMs: 60_000, scope: 'gh-credential' }, d);
    expect((await handlePodGithubCredential(githubPost(unbound.token), deps)).status).toBe(401);
    const wrong = await mintGroundingToken({ runId: 'wrong', job: 'job', ttlMs: 60_000, scope: 'llm-credential' }, d);
    expect(await (await handlePodGithubCredential(githubPost(wrong.token), deps)).json()).toEqual({ reason: 'scope' });
    const expired = await mintGroundingToken({ runId: 'expired', job: 'job', ttlMs: 0, scope: 'gh-credential', repository: 'owner/repo' }, d);
    expect(await (await handlePodGithubCredential(githubPost(expired.token), deps)).json()).toEqual({ reason: 'expired' });
    const revoked = await mintGroundingToken({ runId: 'revoked', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
    revokeGroundingRun('revoked', d);
    expect(await (await handlePodGithubCredential(githubPost(revoked.token), deps)).json()).toEqual({ reason: 'revoked' });
    expect(calls).toBe(0);
  });

  test('per-run and global minute limits deny before mint; failure is unavailable without secrets', async () => {
    const now = 6_000_000;
    const d = tokenDeps(now);
    const deps = { token: d, now: () => now, mintInstallation: () => ({ token: 'secret', expires_at: '2026-09-26T18:00:00.000Z' }), installationRepositories: async () => ['owner/repo'] };
    const signed = await mintGroundingToken({ runId: 'same', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
    expect((await handlePodGithubCredential(githubPost(signed.token), deps)).status).toBe(200);
    expect(await (await handlePodGithubCredential(githubPost(signed.token), deps)).json()).toEqual({ reason: 'rate' });
    for (let i = 1; i < POD_CREDENTIAL_GLOBAL_PER_MIN; i++) {
      const next = await mintGroundingToken({ runId: `gh-${i}`, job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
      expect((await handlePodGithubCredential(githubPost(next.token), deps)).status).toBe(200);
    }
    const overflow = await mintGroundingToken({ runId: 'overflow', job: 'job', ttlMs: 60_000, scope: 'gh-credential', repository: 'owner/repo' }, d);
    expect(await (await handlePodGithubCredential(githubPost(overflow.token), deps)).json()).toEqual({ reason: 'rate' });
    resetPodCredentialRateForTesting();
    expect(await (await handlePodGithubCredential(githubPost(overflow.token), { token: d, now: () => now, mintInstallation: () => null })).json()).toEqual({ reason: 'unavailable' });
    resetPodCredentialRateForTesting();
    expect(await (await handlePodGithubCredential(githubPost(overflow.token), { token: d, now: () => now, mintInstallation: () => ({ token: 'secret', expires_at: 'invalid' }) })).json()).toEqual({ reason: 'unavailable' });
  });
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
