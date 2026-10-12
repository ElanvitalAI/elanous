// ── MK · 0.2.26 칸 CATALOG-FEED — signed catalog feed tests ─────────────

import { describe, test, expect } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  BUILTIN_CATALOG,
} from './model-catalog';
import {
  buildCatalogFeed,
  signCatalogFeed,
  verifyCatalogFeed,
  type CatalogFeed,
} from './catalog-feed';
import type { ModelEntry } from './types';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const other = generateKeyPairSync('ed25519');
const otherPublicPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const ISSUED = new Date('2026-10-12T00:00:00.000Z');

function signSmall(models: CatalogFeed['models']): { feed: CatalogFeed; signature: string } {
  const feed = buildCatalogFeed(
    { version: 1, updated: 0, models },
    ISSUED,
  );
  return signCatalogFeed(feed, privatePem);
}

function entry(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    provider: 'other',
    family: 'test-family',
    contextWindow: 1000,
    inputPerMtok: 1,
    outputPerMtok: 2,
    local: false,
    tags: ['test'],
    bestFor: [],
    ...overrides,
  };
}

describe('CATALOG-FEED — signed catalog feed', () => {
  test('sign → verify ok', () => {
    const { feed, signature } = signSmall([entry('model-a'), entry('model-b')]);
    const result = verifyCatalogFeed({ feed, signature }, publicPem);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feed.schema).toBe('elanous.catalog-feed/1');
      expect(result.feed.digest).toBe(feed.digest);
      expect(result.feed.models.map((m) => m.id)).toEqual(['model-a', 'model-b']);
    }
  });

  test('«변조된 카탈로그 피드는 digest-mismatch 로 거부된다» — price tamper', () => {
    const { feed, signature } = signSmall([entry('model-a', { inputPerMtok: 1 })]);
    const forged: CatalogFeed = {
      ...feed,
      models: [{ ...feed.models[0]!, inputPerMtok: 99 }],
    };
    const result = verifyCatalogFeed({ feed: forged, signature }, publicPem);
    expect(result).toEqual({ ok: false, reason: 'digest-mismatch' });
  });

  test('verify with a different key → bad-signature', () => {
    const { feed, signature } = signSmall([entry('model-a')]);
    const result = verifyCatalogFeed({ feed, signature }, otherPublicPem);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('schema mismatch → rejected as schema', () => {
    const { feed, signature } = signSmall([entry('model-a')]);
    const result = verifyCatalogFeed(
      { feed: { ...feed, schema: 'other.schema/9' as CatalogFeed['schema'] }, signature },
      publicPem,
    );
    expect(result).toEqual({ ok: false, reason: 'schema' });
  });

  test('BUILTIN_CATALOG feed: same input → same digest (deterministic)', () => {
    const a = buildCatalogFeed(BUILTIN_CATALOG, ISSUED);
    const b = buildCatalogFeed(BUILTIN_CATALOG, ISSUED);
    expect(a.digest).toBe(b.digest);
    expect(a.models.map((m) => m.id)).toEqual([...a.models.map((m) => m.id)].sort());
    const wire = JSON.parse(JSON.stringify(signCatalogFeed(a, privatePem))) as ReturnType<typeof signCatalogFeed>;
    expect(verifyCatalogFeed(wire, publicPem).ok).toBe(true);
  });

  test('a null or feed-less document is rejected as schema, not thrown', () => {
    expect(verifyCatalogFeed(JSON.parse('null'), publicPem)).toEqual({ ok: false, reason: 'schema' });
    expect(verifyCatalogFeed(JSON.parse('{"feed":null,"signature":"x"}'), publicPem)).toEqual({ ok: false, reason: 'schema' });
  });

  test('a signed feed whose model lacks a required field is rejected as schema', () => {
    const broken = { id: 'x', provider: 'other', family: 'f', contextWindow: 1 } as unknown as ModelEntry;
    expect(verifyCatalogFeed(signSmall([broken]), publicPem)).toEqual({ ok: false, reason: 'schema' });
  });

  test('a signed feed survives a JSON round trip (undefined fields dropped like JSON.stringify)', () => {
    const signed = signSmall([entry('a', { notes: undefined } as Partial<ModelEntry>)]);
    const wire = JSON.parse(JSON.stringify(signed)) as typeof signed;
    expect(verifyCatalogFeed(wire, publicPem)).toMatchObject({ ok: true });
  });

  test('models are sorted by id regardless of catalog order', () => {
    const feed = buildCatalogFeed(
      { version: 1, updated: 0, models: [entry('zzz'), entry('aaa')] as never },
      ISSUED,
    );
    expect(feed.models.map((m) => m.id)).toEqual(['aaa', 'zzz']);
  });
});
