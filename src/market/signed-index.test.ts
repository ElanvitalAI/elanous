import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { generateIndexKeyPair, signIndex, verifyIndex, type MarketplaceIndex } from './signed-index';

const bytes = (text: string) => new TextEncoder().encode(text);
const validIndex = {
  name: 'elanous',
  interface: { displayName: 'Elanous' },
  sequence: 42,
  generatedAt: '2026-10-01T00:00:00Z',
  plugins: [{
    name: 'video-broll',
    source: { source: 'git-subdir', url: 'https://example.com/plugins.git', path: 'plugins/video-broll', sha: 'a'.repeat(40) },
    policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
    category: 'Productivity',
    version: '0.1.0',
    description: 'B-roll plugin',
    artifact: { sha256: 'a'.repeat(64), bytes: 183422, key: 'video-broll/0.1.0/archive.tgz' },
    'ai.elanous': {
      capabilities: ['fs:workdir'], connectors: [{ id: 'video', kind: 'api', userConfig: [{ key: 'token', label: 'Token', secret: true }] }],
      graphs: ['broll-line'], vocab: ['video-broll:broll-align-words'], requires: { elanous: '>=0.3.0', tools: ['ffmpeg'] },
      pricing: { model: 'free' },
    },
  }],
};

function fixture(index: unknown = validIndex) {
  const pair = generateIndexKeyPair();
  const marketplaceBytes = bytes(JSON.stringify(index));
  const signatureText = signIndex(marketplaceBytes, pair.privateKeyPem, pair.keyId);
  return { marketplaceBytes, signatureText, trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }], pair };
}

describe('signed marketplace index', () => {
  test('generates raw public key and its SHA-256 keyId, signs and verifies sequence 42', () => {
    const f = fixture();
    expect(Buffer.from(f.pair.publicKey, 'base64')).toHaveLength(32);
    expect(f.pair.keyId).toBe(createHash('sha256').update(Buffer.from(f.pair.publicKey, 'base64')).digest('hex').slice(0, 8));
    expect(f.signatureText).not.toContain('\n');
    const result = verifyIndex(f);
    expect(result).toMatchObject({ ok: true, keyId: f.pair.keyId, sequence: 42, index: validIndex });
  });

  test('one changed byte fails signature verification', () => {
    const f = fixture();
    const changed = Uint8Array.from(f.marketplaceBytes);
    changed[0] ^= 1;
    expect(verifyIndex({ ...f, marketplaceBytes: changed })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  test('one trailing space fails signature verification without reserialization', () => {
    const f = fixture();
    expect(verifyIndex({ ...f, marketplaceBytes: bytes(`${new TextDecoder().decode(f.marketplaceBytes)} `) }))
      .toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  test('unknown keyId fails before index parsing', () => {
    const f = fixture();
    expect(verifyIndex({ ...f, trustedKeys: [] })).toMatchObject({ ok: false, reason: 'unknown-key' });
  });

  test('rejects rollback from 43 to 42 but permits equal sequence', () => {
    const f = fixture();
    expect(verifyIndex({ ...f, lastSequence: 43 })).toMatchObject({ ok: false, reason: 'sequence-rollback' });
    expect(verifyIndex({ ...f, lastSequence: 42 })).toMatchObject({ ok: true, sequence: 42 });
  });

  test('rejects unsupported algorithm', () => {
    const f = fixture();
    const signatureText = JSON.stringify({ ...JSON.parse(f.signatureText), alg: 'rsa' });
    expect(verifyIndex({ ...f, signatureText })).toMatchObject({ ok: false, reason: 'malformed' });
  });

  test('rejects signed but invalid marketplace JSON only after successful signature verification', () => {
    const f = fixture();
    const marketplaceBytes = bytes('{invalid');
    expect(verifyIndex({ ...f, marketplaceBytes, signatureText: signIndex(marketplaceBytes, f.pair.privateKeyPem, f.pair.keyId) }))
      .toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyIndex({ ...f, marketplaceBytes })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  test('invalid sha256 names the plugin and field', () => {
    const index = structuredClone(validIndex);
    index.plugins[0]!.artifact.sha256 = 'a'.repeat(63);
    const result = verifyIndex(fixture(index));
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
    if (!result.ok) expect(result.detail).toContain('video-broll).artifact.sha256');
  });

  test('paid elanous source is format-valid (publication policy is separate)', () => {
    const index = structuredClone(validIndex);
    const paidIndex: MarketplaceIndex = { ...index, plugins: [{ ...index.plugins[0]!, source: { source: 'elanous', id: 'video-broll', version: '0.1.0' }, 'ai.elanous': { ...index.plugins[0]!['ai.elanous'], pricing: { model: 'one-time' } } }] };
    expect(verifyIndex(fixture(paidIndex))).toMatchObject({ ok: true, sequence: 42 });
  });

  test('rejects invalid signature envelope and raw-key lengths', () => {
    const f = fixture();
    expect(verifyIndex({ ...f, signatureText: `${f.signatureText}\n` })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyIndex({ ...f, signatureText: JSON.stringify({ ...JSON.parse(f.signatureText), sig: Buffer.alloc(63).toString('base64') }) }))
      .toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyIndex({ ...f, trustedKeys: [{ keyId: f.pair.keyId, publicKey: Buffer.alloc(31).toString('base64') }] }))
      .toMatchObject({ ok: false, reason: 'malformed' });
  });
});
