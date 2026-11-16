import { afterEach, expect, test } from 'bun:test';
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRelayMemberKeyId, writeRelayMemberKeyBinding } from './member-key-binding.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = '11111111-1111-4111-8111-111111111111';
const key = 'emk_SyntheticPrivateOnly';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'member-key-binding-'))); roots.push(root);
  const keyPath = join(root, 'relay-member.key');
  writeFileSync(keyPath, key + '\n', { flag: 'wx', mode: 0o600 });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ nexus: { relay: {
    memberNexusUrl: 'https://api.elanous.ai', memberKeyFile: keyPath,
  } } }), { flag: 'wx', mode: 0o600 });
  return { root, keyPath, configPath, bindingPath: keyPath + '.binding.json' };
}

test('official issue key ID binds only to the current private key and issuer', () => {
  const f = fixture();
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
  writeRelayMemberKeyBinding(f.keyPath, id, key);
  expect(readRelayMemberKeyId(f.root)).toBe(id);
  const binding = JSON.parse(readFileSync(f.bindingPath, 'utf8'));
  expect(binding).toEqual({ schemaVersion: 1, keyId: id, issuerOrigin: 'https://api.elanous.ai',
    keySha256: createHash('sha256').update(key).digest('hex') });
  expect(readFileSync(f.bindingPath, 'utf8')).not.toContain(key);
  expect(() => writeRelayMemberKeyBinding(f.keyPath, id, key)).toThrow();
  writeFileSync(f.keyPath, 'emk_ReplacedPrivateOnly\n');
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
});

test('stale, foreign, permissive or linked binding metadata cannot supply a relay key ID', () => {
  const f = fixture();
  writeRelayMemberKeyBinding(f.keyPath, id, key);
  const original = readFileSync(f.bindingPath, 'utf8');
  const replaced = (body: unknown) => writeFileSync(f.bindingPath, JSON.stringify(body) + '\n');
  const value = JSON.parse(original);
  replaced({ ...value, issuerOrigin: 'https://foreign.invalid' });
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
  replaced({ ...value, ownerId: 'forged' });
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
  replaced(value); chmodSync(f.bindingPath, 0o644);
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
  chmodSync(f.bindingPath, 0o600);
  linkSync(f.bindingPath, join(f.root, 'other-link'));
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
});

test('a symlinked key or nonofficial configured origin is refused without discovery', () => {
  const f = fixture();
  writeRelayMemberKeyBinding(f.keyPath, id, key);
  writeFileSync(f.configPath, JSON.stringify({ nexus: { relay: {
    memberNexusUrl: 'https://foreign.invalid', memberKeyFile: f.keyPath,
  } } }));
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
  writeFileSync(f.configPath, JSON.stringify({ nexus: { relay: {
    memberNexusUrl: 'https://api.elanous.ai', memberKeyFile: f.keyPath,
  } } }));
  const other = join(f.root, 'other.key');
  writeFileSync(other, key + '\n', { mode: 0o600 });
  rmSync(f.keyPath); symlinkSync(other, f.keyPath);
  expect(readRelayMemberKeyId(f.root)).toBeUndefined();
});
