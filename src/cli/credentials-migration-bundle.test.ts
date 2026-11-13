import { expect, test } from 'bun:test';
import { decryptMigrationBundle, encryptMigrationBundle } from './credentials-migration-bundle.js';
import { encryptSecretBundle } from '../nexus/config/secrets/transfer.js';

const passphrase = 'test-only-long-passphrase';

test('migration bundle encrypts static keys and Telegram settings without plaintext in the artifact', async () => {
  const encrypted = await encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: { exa: 'fake-exa-secret' },
    telegram: { botToken: 'fake-bot-token', homeChannel: -1001, allowedUsers: [42] } }, passphrase);
  expect(encrypted).not.toContain('fake-exa-secret');
  expect(encrypted).not.toContain('fake-bot-token');
  expect(await decryptMigrationBundle(encrypted, passphrase)).toEqual({ sourceHost: 'mbp',
    staticSecrets: { exa: 'fake-exa-secret' }, telegram: { botToken: 'fake-bot-token', homeChannel: -1001, allowedUsers: [42] } });
});

test('rotating OAuth material cannot enter or leave a migration bundle', async () => {
  await expect(encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: { 'openai-codex': 'fake-refresh' } }, passphrase))
    .rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  const poisoned = await encryptSecretBundle({ version: 1, secrets: { 'migration:manifest': JSON.stringify({ version: 1, sourceHost: 'mbp' }),
    'openai-codex': 'fake-refresh' } }, passphrase);
  await expect(decryptMigrationBundle(poisoned, passphrase)).rejects.toThrow('INVALID_MIGRATION_CONTENTS');
});

test('plain secret export and malformed Telegram setup are refused', async () => {
  const ordinary = await encryptSecretBundle({ version: 1, secrets: { exa: 'fake-secret' } }, passphrase);
  await expect(decryptMigrationBundle(ordinary, passphrase)).rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  await expect(encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: {}, telegram: {
    botToken: 'fake-bot', allowedUsers: [-1],
  } }, passphrase)).rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  await expect(encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: {}, telegram: null } as never, passphrase))
    .rejects.toThrow('INVALID_MIGRATION_CONTENTS');
});


test('static aliases cannot both enter a bundle, while separate service fields remain distinct', async () => {
  await expect(encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: {
    exa: 'fake-one', EXA_API_KEY: 'fake-two',
  } }, passphrase)).rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  const poisoned = await encryptSecretBundle({ version: 1, secrets: {
    'migration:manifest': JSON.stringify({ version: 1, sourceHost: 'mbp' }),
    exa: 'fake-one', EXA_API_KEY: 'fake-two',
  } }, passphrase);
  await expect(decryptMigrationBundle(poisoned, passphrase)).rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  await expect(encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: {
    toss: 'fake-aggregate', TOSSINVEST_CLIENT_ID: 'fake-field',
  } }, passphrase)).rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  await expect(encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: {
    ELANOUS_TELEGRAM_BOT_TOKEN: 'fake-other-bot',
  }, telegram: { botToken: 'fake-bot', allowedUsers: [] } }, passphrase))
    .rejects.toThrow('INVALID_MIGRATION_CONTENTS');
  const separate = await encryptMigrationBundle({ sourceHost: 'mbp', staticSecrets: {
    'higgsfield.key_id': 'fake-id', 'higgsfield.secret': 'fake-secret',
  } }, passphrase);
  expect((await decryptMigrationBundle(separate, passphrase)).staticSecrets).toEqual({
    'higgsfield.key_id': 'fake-id', 'higgsfield.secret': 'fake-secret',
  });
});
