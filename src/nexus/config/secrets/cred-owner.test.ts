import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSsh } from '../../../ux-sim/fake-ssh.js';
import { collectCodexMirrorCredentials, deliverCodexMirrorAndRecord, isCodexTokenOwnerHost } from '../../../oauth/codex-owner-mirror.js';
import { loadFreshCodexAuthState } from '../../../oauth/codex.js';
import { authStorePath, saveTokens } from '../../../oauth/store.js';
import { installRemoteCodexCliMirror, type SshRunner } from '../../../task-agent/parent-host.js';
import { hostCredentials } from '../../../task-orchestrator/surfaces/self-implement-pod.js';
import { setUserConfigOverlay } from '../../../user-config.js';
import { hqFenceDecision } from '../../../hq/hq.js';
import { serializeLease } from '../../../hq/lease.js';
import { simCli } from '../../../ux-sim/in-process-cli.js';
import { credentialOwnerLedgerPath, readCredentialOwner, recordCredentialMirror, resolveCodexCredentialOwnerHost, transferCodexCredentialOwner } from './cred-owner.js';

function fakeRemoteShell(home: string, observedHosts: string[] = []): SshRunner {
  return (host, script, timeoutMs, stdin) => {
    observedHosts.push(host);
    const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: timeoutMs, input: stdin,
      env: { ...process.env, HOME: home } });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

test('configured fleet owner records access-only mirror receipts without credential values', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-'));
  try {
    const path = credentialOwnerLedgerPath(root);
    const hosts = createFakeSsh({ hosts: {
      mshq: { activeSessions: 0, maxStartups: 10 }, // Source: 내부 문서 `secrets` §5.3; fixed fake host capacity.
      'host-a': { activeSessions: 0, maxStartups: 10 }, // Source: 내부 문서 `secrets` §5.3; same fixed fake host capacity.
      aws2: { activeSessions: 0, maxStartups: 10 }, // Source: 내부 문서 `secrets` §5.3; same fixed fake host capacity.
    } });
    const rawAccessValue = 'raw-simulation-access-value';
    const deliver = (host: string) => () => {
      const result = hosts.ssh(host, `install access mirror ${rawAccessValue}`);
      if (result.rc !== 0) throw new Error('fake delivery failed');
    };
    const options = { ledgerPath: path, config: { llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'mshq' } } as never, machine: 'mshq' };
    deliverCodexMirrorAndRecord('host-a', deliver('host-a'), options);
    deliverCodexMirrorAndRecord('aws2', deliver('aws2'), options);
    const row = readCredentialOwner('cred:codex-login', path);
    expect(row).toMatchObject({ slot: 'cred:codex-login', ownerHost: 'mshq', mirrors: [
      { host: 'host-a', mode: 'access-only' }, { host: 'aws2', mode: 'access-only' },
    ] });
    expect(hosts.calls.map((call) => call.host)).toEqual(['host-a', 'aws2']);
    const receipt = readCredentialOwner('cred:codex-login', path)!;
    Object.assign(receipt.mirrors[0]!, { host: 'tampered' });
    expect(readCredentialOwner('cred:codex-login', path)?.mirrors[0]?.host).toBe('host-a');
    expect(readFileSync(path, 'utf8')).not.toContain(rawAccessValue);
    expect(JSON.stringify(row)).not.toContain(rawAccessValue);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mirror push rejects non-owners and failed deliveries without writing a receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-'));
  try {
    const path = credentialOwnerLedgerPath(root);
    const owner = { ledgerPath: path, config: { llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'mshq' } } as never, machine: 'mshq' };
    let delivered = 0;
    expect(() => deliverCodexMirrorAndRecord('host-a', () => { delivered++; }, {
      ledgerPath: path, config: { llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'host-a' } } as never, machine: 'host-a',
    })).toThrow('owner host');
    expect(delivered).toBe(0);
    expect(readCredentialOwner('cred:codex-login', path)).toBeUndefined();
    expect(() => deliverCodexMirrorAndRecord('host-a', () => {
      throw Object.assign(new Error('raw-simulation-access-value'), { code: 'ETIMEDOUT', rc: 255 }); // Source: SSH process exit status is an unsigned byte; the fake error body is intentionally private.
    }, owner)).toThrow('CODEX_MIRROR_DELIVERY_FAILED (reason=ETIMEDOUT; rc=255)');
    expect(readCredentialOwner('cred:codex-login', path)).toBeUndefined();
    expect(() => deliverCodexMirrorAndRecord('mshq', () => { delivered++; }, owner)).toThrow('owner cannot be a mirror');
    expect(delivered).toBe(0);
    expect(readCredentialOwner('cred:codex-login', path)).toBeUndefined();
    expect(() => recordCredentialMirror({ slot: 'cred:unknown', ownerHost: 'mbp', mirrorHost: 'aws2' }, path))
      .toThrow('CREDENTIAL_OWNER_SLOT_INVALID');
    recordCredentialMirror({ slot: 'cred:openai.api_key', ownerHost: 'mbp', mirrorHost: 'aws2' }, path);
    expect(() => recordCredentialMirror({ slot: 'cred:openai.api_key', ownerHost: 'mshq', mirrorHost: 'node-b' }, path))
      .toThrow('credential slot already has another owner host');
    const oldOwnerReceiptPath = credentialOwnerLedgerPath(join(root, 'owner-transition'));
    recordCredentialMirror({ slot: 'cred:codex-login', ownerHost: 'mshq', mirrorHost: 'aws2' }, oldOwnerReceiptPath);
    const newOwnerReceipt = recordCredentialMirror({ slot: 'cred:codex-login', ownerHost: 'node-b', mirrorHost: 'mbp' }, oldOwnerReceiptPath);
    expect(newOwnerReceipt.mirrors.map((mirror) => mirror.host)).toEqual(['mbp']);
    writeFileSync(path, '{"version":2,"slots":[]}'); // Source: src/nexus/config/secrets/cred-owner.ts; unsupported ledger version fails closed.
    expect(() => deliverCodexMirrorAndRecord('host-a', () => { delivered++; }, owner)).toThrow('CREDENTIAL_OWNER_LEDGER_CORRUPT');
    expect(delivered).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real Codex refresh and mirror-push entrypoints keep one configured owner while mbp is offline for four hours', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-relocate-'));
  const prior = {
    xdg: process.env.XDG_CONFIG_HOME,
    state: process.env.ELANOUS_STATE_DIR,
    stateSource: process.env.ELANOUS_STATE_DIR_SOURCE,
    accessOnly: process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY,
    codexHome: process.env.CODEX_HOME,
  };
  const realDateNow = Date.now;
  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  try {
    const ownerConfigDir = join(root, 'mshq-config');
    const ownerState = join(root, 'mshq-state');
    const ownerCodexHome = join(root, 'mshq-codex');
    const mirrorConfigDir = join(root, 'node-b-config');
    const mirrorState = join(root, 'node-b-state');
    const mirrorHome = join(root, 'node-b-home');
    const mirrorPath = join(mirrorHome, '.elanous', 'remote-parent-credentials', 'cli-mirror', 'auth.json');
    const ledgerPath = credentialOwnerLedgerPath(join(root, 'owner-ledger'));
    restoreEnv('ELANOUS_REMOTE_CODEX_ACCESS_ONLY', undefined);
    restoreEnv('CODEX_HOME', undefined);
    const pushedHosts: string[] = [];
    const configFor = (hostName: string) => setUserConfigOverlay((config) => ({
      ...config, llm: { ...config.llm, codexTokenOwnerHost: 'mshq' }, hq: { ...config.hq, hostName },
    }));
    let refreshCalls = 0;
    const presentedRefreshTokens: string[] = [];
    let lastPushedAccessToken = '';
    let simulatedNow = realDateNow();
    Date.now = () => simulatedNow;
    let mirrorPushes = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshCalls++;
      presentedRefreshTokens.push(new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '');
      return new Response(JSON.stringify({ access_token: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60, chatgpt_account_id: 'simulation-account' })).toString('base64url')}.sig`, // Source: owner access expires at the four-hour continuity boundary.
        refresh_token: `rotated-${refreshCalls}`, expires_in: 4 * 60 * 60, token_type: 'Bearer' }), { // Source: OAuth expires_in is seconds and the next refresh uses the rotation.
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    process.env.XDG_CONFIG_HOME = ownerConfigDir;
    process.env.ELANOUS_STATE_DIR = ownerState;
    process.env.CODEX_HOME = ownerCodexHome;
    delete process.env.ELANOUS_STATE_DIR_SOURCE;
    configFor('mshq');
    mkdirSync(ownerCodexHome, { recursive: true });
    writeFileSync(join(ownerCodexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: 'expiring-access', refresh_token: 'initial-refresh', account_id: 'simulation-account',
    } }));
    saveTokens('openai-codex', { accessToken: 'expiring-access', refreshToken: 'initial-refresh',
      expiresAt: Date.now() + 30_000, tokenType: 'Bearer' }, { authMode: 'chatgpt', codexHome: ownerCodexHome, mirrorCodex: false }, authStorePath()); // Source: first token is expiring; later refreshes must reuse persisted rotation.
    for (let hour = 0; hour <= 4; hour++) { // Source: four-hour mbp-offline continuity scenario, sampled hourly.
      simulatedNow = realDateNow() + hour * 60 * 60_000;
      process.env.XDG_CONFIG_HOME = ownerConfigDir;
      process.env.ELANOUS_STATE_DIR = ownerState;
      process.env.CODEX_HOME = ownerCodexHome;
      delete process.env.ELANOUS_STATE_DIR_SOURCE;
      configFor('mshq');
      const refreshed = await loadFreshCodexAuthState({ fetchImpl });
      expect(refreshed).not.toBeNull();

      if (hour === 0 || hour === 4) {
        deliverCodexMirrorAndRecord('node-b', () => {
          const codex = collectCodexMirrorCredentials(['default'], (account) => hostCredentials(account, authStorePath(), () => '', {
            requireExplicitChatgptAuthMode: true,
          }));
          installRemoteCodexCliMirror({ host: 'node-b', cwd: root }, codex.mirrors, fakeRemoteShell(mirrorHome, pushedHosts));
          lastPushedAccessToken = refreshed!.tokens.accessToken;
          mirrorPushes++;
        }, { ledgerPath, config: { llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'mshq' } } as never, machine: 'mshq' });
      }
      const installed = JSON.parse(readFileSync(mirrorPath, 'utf8')) as { providers: Record<string, { tokens: { accessToken: string; refreshToken: string; refresh_token: string } }> };
      expect(installed.providers['openai-codex']?.tokens).toMatchObject({
        accessToken: lastPushedAccessToken, refreshToken: '', refresh_token: '',
      });

      process.env.XDG_CONFIG_HOME = mirrorConfigDir;
      process.env.ELANOUS_STATE_DIR = mirrorState;
      process.env.CODEX_HOME = join(mirrorHome, '.codex');
      delete process.env.ELANOUS_STATE_DIR_SOURCE;
      configFor('node-b');
      saveTokens('openai-codex', { accessToken: 'local-expiring-access', refreshToken: `local-refresh-${hour}`,
        expiresAt: Date.now() + 30_000, tokenType: 'Bearer' }, { authMode: 'chatgpt', codexHome: join(mirrorHome, '.codex') }, authStorePath()); // Source: stale local credential proves the non-owner ignores local refresh material.
      const fetchesBeforeMirrorRead = refreshCalls;
      const mirrored = await loadFreshCodexAuthState({ fetchImpl, ownerMirrorPath: mirrorPath });
      expect(mirrored?.tokens.accessToken).toBe(lastPushedAccessToken);
      expect(refreshCalls).toBe(fetchesBeforeMirrorRead);
      expect(refreshCalls).toBe(hour < 4 ? 1 : 2);
    }
    expect(mirrorPushes).toBe(2); // Source: initial mirror plus updated snapshot after the owner uses the rotated token.
    expect(refreshCalls).toBe(2); // Source: owner refreshes once at expiry buffer; mirror reads add zero.
    expect(presentedRefreshTokens).toEqual(['initial-refresh', 'rotated-1']); // Source: second owner refresh consumes first OAuth rotation.
    expect(pushedHosts).toEqual(['node-b', 'node-b']); // Source: standby receives the initial and rotated-token snapshots.
    expect(pushedHosts).not.toContain('mbp'); // Source: mbp stays unavailable for the simulation window.
  } finally {
    Date.now = realDateNow;
    setUserConfigOverlay(null);
    for (const [key, value] of Object.entries({ XDG_CONFIG_HOME: prior.xdg, ELANOUS_STATE_DIR: prior.state,
      ELANOUS_STATE_DIR_SOURCE: prior.stateSource, ELANOUS_REMOTE_CODEX_ACCESS_ONLY: prior.accessOnly, CODEX_HOME: prior.codexHome }))
      restoreEnv(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured fleet owner is the only ownership source; the local mirror receipt cannot override it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-lease-'));
  try {
    const path = credentialOwnerLedgerPath(root);
    expect(resolveCodexCredentialOwnerHost({ llm: {} })).toBeUndefined();
    expect(resolveCodexCredentialOwnerHost({ llm: { codexTokenOwnerHost: 'mshq' } })).toBe('mshq');
    recordCredentialMirror({ slot: 'cred:codex-login', ownerHost: 'mshq', mirrorHost: 'node-b' }, path);
    expect(resolveCodexCredentialOwnerHost({ llm: { codexTokenOwnerHost: 'node-b' } })).toBe('node-b');
    expect(isCodexTokenOwnerHost({ llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'mshq' } } as never)).toBe(true);
    expect(isCodexTokenOwnerHost({ llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'node-b' } } as never)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex owner transfer requires the HQ fence and an exact expected-owner CAS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-transfer-'));
  const configPath = join(root, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify({ version: 1, llm: { codexTokenOwnerHost: 'mshq', provider: 'openai-codex' }, global: { keep: true } }));
    await expect(transferCodexCredentialOwner({ newOwner: 'aws2', expectedOwner: 'mshq', configPath, hqLeaseHeld: () => false }))
      .rejects.toThrow('CREDENTIAL_OWNER_TRANSFER_HQ_LEASE_REQUIRED');
    await expect(transferCodexCredentialOwner({ newOwner: 'aws2', expectedOwner: 'mbp', configPath, hqLeaseHeld: () => true }))
      .rejects.toThrow('CREDENTIAL_OWNER_TRANSFER_EXPECTED_OWNER_MISMATCH: expected=mbp observed=mshq');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { codexTokenOwnerHost: 'mshq', provider: 'openai-codex' } });

    writeFileSync(configPath, JSON.stringify({ version: 1, llm: { codexTokenOwnerHost: 'MSHQ.local', provider: 'openai-codex' }, global: { keep: true } }));
    await expect(transferCodexCredentialOwner({ newOwner: 'aws2', expectedOwner: 'mshq', configPath, hqLeaseHeld: () => true }))
      .rejects.toThrow('CREDENTIAL_OWNER_TRANSFER_EXPECTED_OWNER_MISMATCH: expected=mshq observed=MSHQ.local');
    await expect(transferCodexCredentialOwner({ newOwner: 'aws2', expectedOwner: 'MSHQ.local', configPath, hqLeaseHeld: () => true }))
      .resolves.toEqual({ previousOwner: 'MSHQ.local', ownerHost: 'aws2' });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ llm: { codexTokenOwnerHost: 'aws2', provider: 'openai-codex' } });
    writeFileSync(configPath, JSON.stringify({ version: 1, llm: { codexTokenOwnerHost: 'mshq', provider: 'openai-codex' }, global: { keep: true } }));
    await expect(transferCodexCredentialOwner({ newOwner: 'AWS2.local', expectedOwner: 'mshq', configPath, hqLeaseHeld: () => true }))
      .resolves.toEqual({ previousOwner: 'mshq', ownerHost: 'AWS2.local' });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      version: 1, llm: { codexTokenOwnerHost: 'AWS2.local', provider: 'openai-codex' }, global: { keep: true },
    });
    await expect(transferCodexCredentialOwner({ newOwner: 'gcp2', expectedOwner: 'mshq', configPath, hqLeaseHeld: () => true }))
      .rejects.toThrow('CREDENTIAL_OWNER_TRANSFER_EXPECTED_OWNER_MISMATCH: expected=mshq observed=AWS2.local');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('codex mirror transfer-owner CLI reports success and fails with a stale expected owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-transfer-cli-'));
  const home = join(root, 'home');
  const configDir = join(root, 'config');
  const binDir = join(home, 'bin');
  const hqDir = join(home, '.elanous-hq');
  try {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(hqDir, { recursive: true });
    writeFileSync(join(hqDir, 'host'), 'mshq\n');
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ version: 1,
      llm: { codexTokenOwnerHost: 'mshq' }, hq: { hostName: 'mshq', arbiter: 'cloud-vm' } }));
    writeFileSync(join(binDir, 'ssh'), [
      '#!/bin/sh',
      'now=$(date +%s)',
      `printf '%s\\n----\\n{"holder":"mshq","generation":1,"acquiredAt":%s,"renewedAt":%s,"ttlSeconds":1500}\\n' "$now" "$now" "$now"`,
      '',
    ].join('\n'), { mode: 0o755 });
    const run = (expectedOwner: string) => simCli(['codex', 'mirror', 'transfer-owner', 'aws2', '--expected-owner', expectedOwner], {
      mode: 'spawn', allowPaths: [['codex', 'mirror', 'transfer-owner']], stateRoot: root, configRoot: configDir,
      injectTestFlag: false, timeoutMs: 15_000, // Source: CLI process-boundary regression remains bounded by the fake HQ lease.
      env: { HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    const transferred = await run('mshq');
    expect(transferred.exitCode).toBe(0);
    expect(transferred.stdout).toContain('Codex owner transfer 완료 · mshq → aws2 · HQ lease=fenced');
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))).toMatchObject({ llm: { codexTokenOwnerHost: 'aws2' } });

    const stale = await run('mshq');
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain('CREDENTIAL_OWNER_TRANSFER_EXPECTED_OWNER_MISMATCH: expected=mshq observed=aws2');
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))).toMatchObject({ llm: { codexTokenOwnerHost: 'aws2' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('relocated configured owner passes the fail-closed ledger-cli HQ fence', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-hq-fence-'));
  try {
    const now = 1_794_000_000;
    const decision = hqFenceDecision('ledger-cli', {
      config: { hostName: 'mshq', arbiter: 'cloud-vm' },
      hostPath: join(root, 'host'),
      localPath: join(root, 'hq-local.json'),
      seenPath: join(root, 'seen-generation'),
      now: () => now,
      store: {
        read: () => ({ now, raw: serializeLease({ holder: 'mshq', generation: 7, acquiredAt: now, renewedAt: now,
          ttlSeconds: 1_500 }) }),
        cas: () => false,
      },
    });
    expect(decision).toMatchObject({ run: true, reason: 'holder', holder: 'mshq', generation: 7 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
