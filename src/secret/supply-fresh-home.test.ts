import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueStaticLease } from './static-lease.js';
import { staticLeaseCopyPath } from './static-lease-consumer.js';
import { readSupplyLedger, supply, SUPPLY_POLICY_FILE } from './supply.js';

test('CLI command subprocess delegates a synthetic key without exposing it on stdout or stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-home-supply-cli-'));
  try {
    const home = join(root, 'home');
    const issuer = join(root, 'issuer');
    const target = join(home, '.elanous');
    mkdirSync(target, { recursive: true });
    mkdirSync(issuer, { recursive: true });
    writeFileSync(join(issuer, SUPPLY_POLICY_FILE), JSON.stringify({ version: 1, allow: [{ item: 'openrouter', targets: ['config-dir'] }] }), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./supply-fresh-home-cli-fixture.ts', import.meta.url)), 'supply', 'openrouter', '--to', target, '--json'], {
      env: { ...process.env, HOME: home, FIXTURE_HOME: home, FIXTURE_ISSUER: issuer }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(readFileSync(staticLeaseCopyPath(target, 'openrouter_api_key'), 'utf8').trim()).toBe('synthetic-canary-not-a-real-credential');
    expect(stdout + stderr).not.toContain('synthetic-canary-not-a-real-credential');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh HOME config-dir: supply delegates one synthetic key without logging its value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-home-supply-'));
  try {
    const home = join(root, 'home');
    const issuer = join(root, 'issuer');
    const target = join(home, '.elanous');
    mkdirSync(target, { recursive: true });
    mkdirSync(issuer, { recursive: true });
    writeFileSync(join(issuer, SUPPLY_POLICY_FILE), JSON.stringify({ version: 1, allow: [{ item: 'openrouter', targets: ['config-dir'] }] }), { mode: 0o600 });
    const canary = 'synthetic-canary-not-a-real-credential';
    const events: unknown[] = [];
    const result = await supply({ item: 'openrouter', to: target }, {
      configDir: issuer,
      who: () => 'synthetic-test',
      delegates: {
        oauthIssue: async () => { throw new Error('unexpected OAuth'); },
        oauthRevoke: async () => false,
        staticRevoke: async () => false,
        staticIssue: async (item, to, ttlMs) => {
          const lease = await issueStaticLease({ id: item, to, ...(ttlMs === undefined ? {} : { ttlMs }) }, {
            configDir: () => issuer,
            knownConfigRoots: () => [home],
            readSourceValue: async () => canary,
            log: (_category, event, data) => { events.push({ event, data }); },
          });
          return lease.ok ? { ok: true, leaseId: lease.record.leaseId, expiresAt: Date.parse(lease.record.expiresAt) } : { ok: false, reason: lease.reason };
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`supply refused: ${result.reason} ${result.detail}`);
    expect(result.via).toBe('static-lease');
    const copy = staticLeaseCopyPath(target, 'openrouter_api_key');
    expect(readFileSync(copy, 'utf8').trim()).toBe(canary);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(JSON.stringify([result, events, readSupplyLedger(issuer)])).not.toContain(canary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
