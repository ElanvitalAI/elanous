import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { OFFICIAL_INDEX_KEYS } from './official-keys.js';

describe('official index keys', () => {
  test('each key is a raw 32-byte Ed25519 public key whose keyId is its sha256 prefix', () => {
    expect(OFFICIAL_INDEX_KEYS.length).toBeGreaterThan(0);
    for (const key of OFFICIAL_INDEX_KEYS) {
      const raw = Buffer.from(key.publicKey, 'base64');
      expect(raw.length).toBe(32);
      expect(key.keyId).toBe(createHash('sha256').update(raw).digest('hex').slice(0, 8));
    }
  });
});
