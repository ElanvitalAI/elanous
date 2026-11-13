import { expect, test } from 'bun:test';
import { planCredentialMigration, renderCredentialMigrationDryRun } from './credentials-migration-plan.js';

test('11-11 move plan separates encrypted static restore, access mirror and single-use refresh handoff', () => {
  const plan = planCredentialMigration([
    { id: 'telegram', kind: 'telegram-bot', ownerHost: 'mbp', sourcePollerActive: true },
    { id: 'codex-team-access', kind: 'oauth-access', ownerHost: 'mbp', accessMirrorReady: true },
    { id: 'codex-team-refresh', kind: 'single-use-refresh', ownerHost: 'mbp', ownerFenceHeld: true, accessMirrorReady: true },
    { id: 'claude-op', kind: 'setup-token', ownerHost: 'mbp' },
    { id: 'exa', kind: 'static-key', destinationPresent: true },
  ], 'mshq');
  expect(plan.map((row) => [row.id, row.action, row.blocker])).toEqual([
    ['telegram', 'encrypted-restore', 'bot-poller-active'],
    ['codex-team-access', 'access-mirror', null],
    ['codex-team-refresh', 'relogin-and-transfer', null],
    ['claude-op', 'reissue-on-destination', 'setup-token-reissue-required'],
    ['exa', 'encrypted-restore', 'destination-conflict'],
  ]);
  expect(renderCredentialMigrationDryRun(plan)).toContain('telegram\ttelegram-bot\tencrypted-restore\tmbp -> mshq\tbot-poller-active');
  expect(renderCredentialMigrationDryRun(plan)).not.toContain('refresh_token');
});

test('single-use refresh transfer fails closed without owner fence and access mirror', () => {
  expect(planCredentialMigration([{ id: 'codex', kind: 'single-use-refresh', ownerHost: 'mbp' }], 'mshq')[0]?.blocker).toBe('owner-fence-missing');
  expect(planCredentialMigration([{ id: 'codex', kind: 'single-use-refresh', ownerHost: 'mbp', ownerFenceHeld: true }], 'mshq')[0]?.blocker).toBe('access-mirror-missing');
});

test('printable plan rejects malformed identifiers and duplicate rows', () => {
  expect(() => planCredentialMigration([{ id: 'a\nsecret', kind: 'static-key' }], 'mshq')).toThrow('INVALID_CREDENTIAL_ID');
  expect(() => planCredentialMigration([{ id: 'a', kind: 'static-key' }, { id: 'a', kind: 'static-key' }], 'mshq')).toThrow('INVALID_CREDENTIAL_ID');
});

test('unmeasured owner, destination and poller state stay unknown in the printable plan', () => {
  const rows = planCredentialMigration([
    { id: 'exa', kind: 'static-key' },
    { id: 'telegram-config', kind: 'telegram-bot', ownerHost: 'mbp' },
  ], 'mshq');
  expect(rows[0]).toMatchObject({ ownerChange: 'unknown', blocker: 'destination-state-unknown' });
  expect(rows[1]).toMatchObject({ ownerChange: 'mbp -> mshq', blocker: 'source-poller-unknown' });
  expect(renderCredentialMigrationDryRun(rows)).toContain('destination-state-unknown');
});


test('unmeasured OAuth access owner remains unknown in the value-free plan', () => {
  const [row] = planCredentialMigration([{ id: 'codex-access', kind: 'oauth-access' }], 'mshq');
  expect(row).toMatchObject({ ownerChange: 'unknown', blocker: 'access-mirror-missing' });
});
