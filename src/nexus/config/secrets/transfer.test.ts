import { expect, test } from 'bun:test';
import { decryptSecretBundle, encryptSecretBundle } from './transfer.js';

const fakePassphrase = 'fake-transfer-passphrase';

test('encrypted secret bundle round-trips without containing fake key material', async () => {
  const secret = 'api-key-ELANOUS_CANARY_V1:exa/fake00001';
  const bundle = await encryptSecretBundle({ version: 1, secrets: { exa: secret } }, fakePassphrase);
  expect(bundle).not.toContain(secret);
  expect(bundle).toContain('aes-256-gcm');
  await expect(decryptSecretBundle(bundle, fakePassphrase)).resolves.toEqual({ version: 1, secrets: { exa: secret } });
});

test('wrong passphrases and modified ciphertext are rejected without plaintext diagnostics', async () => {
  const bundle = await encryptSecretBundle({ version: 1, secrets: { exa: 'fake-canary-value' } }, fakePassphrase);
  await expect(decryptSecretBundle(bundle, 'other-fake-passphrase')).rejects.toThrow('encrypted secret bundle could not be opened');
  const changed = JSON.parse(bundle) as { cipher: { ciphertext: string } };
  changed.cipher.ciphertext = `${changed.cipher.ciphertext.slice(0, -4)}AAAA`;
  await expect(decryptSecretBundle(JSON.stringify(changed), fakePassphrase)).rejects.toThrow('encrypted secret bundle could not be opened');
});

test('invalid ids, empty values, and weak passphrases cannot be exported', async () => {
  await expect(encryptSecretBundle({ version: 1, secrets: { '../bad': 'fake' } }, fakePassphrase)).rejects.toThrow('invalid secret bundle contents');
  await expect(encryptSecretBundle({ version: 1, secrets: { exa: '' } }, fakePassphrase)).rejects.toThrow('invalid secret bundle contents');
  await expect(encryptSecretBundle({ version: 1, secrets: { exa: 'fake' } }, 'short')).rejects.toThrow('passphrase must be at least 12 characters');
});

test('exports larger than the import limit are rejected before writing an unusable bundle', async () => {
  await expect(encryptSecretBundle({ version: 1, secrets: { exa: 'x'.repeat(6 * 1024 * 1024) } }, fakePassphrase))
    .rejects.toThrow('secret bundle exceeds the supported size');
});
