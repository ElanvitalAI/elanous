import { expect, test } from 'bun:test';
import { podCodexLeaseCredential } from './pod-codex-lease.js';

const lease = () => ({ version: 1, providers: { 'openai-codex': {
  source: 'mirror', authMode: 'chatgpt', chatGPT: { accountId: 'fake-account' }, tokens: { accessToken: 'fake-access', expiresAt: 9000, refreshToken: '', refresh_token: '' },
  lease: { leaseId: 'job-lease', kind: 'oauth', provider: 'codex', owner: 'owner', issuedAt: 1000, expiresAt: 9000 },
} } });

test('official lease supplies an access-only pair for the full Job lifetime', () => {
  const result = podCodexLeaseCredential(JSON.stringify(lease()), 2000, 8000);
  expect(JSON.parse(result.elanousAuth).providers['openai-codex'].tokens.refreshToken).toBe('');
  expect(result.codexAuth).toBe(''); // eln Responses HTTP provider, not Codex CLI
});

test('refuses owner credentials, refresh authority, expired and short leases', () => {
  const owner = lease(); owner.providers['openai-codex'].source = 'owner';
  const refresh = lease(); refresh.providers['openai-codex'].tokens.refreshToken = 'fake-refresh';
  for (const row of [owner, refresh]) expect(() => podCodexLeaseCredential(JSON.stringify(row), 2000, 8000)).toThrow('codex-mirror-missing');
  expect(() => podCodexLeaseCredential(JSON.stringify(lease()), 2000, 10000)).toThrow('codex-mirror-missing');
  expect(() => podCodexLeaseCredential(JSON.stringify(lease()), 9000, 9001)).toThrow('codex-mirror-missing');
});

test('Job credential is obtained from and revoked through the official lease seam', async () => {
  const { issuePodCodexLease } = await import('./pod-codex-lease.js');
  const calls: unknown[][] = [];
  const value = lease();
  value.providers['openai-codex'].tokens.expiresAt = 400_000;
  value.providers['openai-codex'].lease.expiresAt = 400_000;
  const transport = {
    issue: async (...args: [string, string, number]) => { calls.push(['issue', ...args]); return { leaseId: 'job-lease' }; },
    read: async (path: string) => { calls.push(['read', path]); return JSON.stringify(value); },
    revoke: async (id: string) => { calls.push(['revoke', id]); },
  };
  const result = await issuePodCodexLease('si-card', 'default', 5, transport, 1000, 'nonce'); // 출처: secret oauth-lease 5m 하한
  expect(result.leaseId).toBe('job-lease');
  expect(calls).toEqual([['issue', '~/elanous-hq/seat-state/RES/pod-oauth-leases/si-card-nonce', 'default', 5], ['read', '~/elanous-hq/seat-state/RES/pod-oauth-leases/si-card-nonce']]);
  value.providers['openai-codex'].tokens.refreshToken = 'fake-refresh';
  await expect(issuePodCodexLease('si-card', 'default', 5, transport, 1000, 'nonce')).rejects.toThrow('codex-mirror-missing');
  expect(calls.at(-1)).toEqual(['revoke', 'job-lease']);
});

test('owner transport uses the existing lease and revoke CLI without putting credential values in commands', async () => {
  const { ownerPodLeaseTransport } = await import('./pod-codex-lease.js');
  const commands: string[] = [];
  const transport = ownerPodLeaseTransport('mshq', (host, command) => {
    expect(host).toBe('mshq'); commands.push(command);
    return { status: 0, stdout: command.includes(' oauth-lease codex ') ? '{"ok":true,"leaseId":"lease-abc"}' : '{}' };
  });
  await transport.issue('~/elanous-hq/seat-state/RES/pod-oauth-leases/si-card-nonce', 'default', 5); // 출처: secret oauth-lease 5m 하한
  await transport.revoke('lease-abc');
  expect(commands[0]).toContain('eln secret oauth-lease codex');
  expect(commands[1]).toContain('eln secret oauth-lease revoke');
  expect(commands.join('\n')).not.toContain('fake-access');
});

test('an owner or team credential path cannot be used as a lease account', async () => {
  const { issuePodCodexLease } = await import('./pod-codex-lease.js');
  const transport = { issue: async () => { throw new Error('must-not-issue'); }, read: async () => '', revoke: async () => {} };
  await expect(issuePodCodexLease('si-card', '~/.codex-team-owner/auth.json', 5, transport, 1000, 'nonce')).rejects.toThrow('pod-lease-identity-invalid'); // 출처: secret oauth-lease 5m 하한
});
