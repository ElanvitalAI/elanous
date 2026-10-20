import { describe, expect, test } from 'bun:test';
import {
  buildKnowhowPack,
  KNOWHOW_PACK_DEFAULT_CHAR_BUDGET,
  KNOWHOW_PACK_DEFAULT_K,
  type KnowhowFragment,
  type KnowhowPackRequest,
} from './pack.js';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const request: KnowhowPackRequest = {
  target: { surface: 'tui', tool: 'ScheduleWakeup', commandClass: 'schedule', scope: 'seat:MK' },
  signature: { kind: 'tool-argument-error', stableCode: 'invalid-repeat', normalizedArgsHash: 'sha256:abc' },
  now: NOW,
};

function fragment(id: string, overrides: Partial<KnowhowFragment> = {}): KnowhowFragment {
  return {
    id,
    target: { ...request.target },
    signature: { ...request.signature },
    text: `Correction ${id}`,
    kind: 'fact',
    source: { kind: 'KNOWHOW.md', path: 'docs/roles/MK/KNOWHOW.md', ref: `K-MK-${id}` },
    status: 'verified',
    confidence: 0.9,
    verifiedAt: '2026-10-18T09:00:00.000Z',
    expiresAt: '2026-10-19T09:00:00.000Z',
    ...overrides,
  };
}

describe('buildKnowhowPack', () => {
  test('uses shared defaults and exact target/signature matching', () => {
    expect(KNOWHOW_PACK_DEFAULT_K).toBe(8);
    expect(KNOWHOW_PACK_DEFAULT_CHAR_BUDGET).toBe(32_000);
    const pack = buildKnowhowPack([
      fragment('match'),
      fragment('wrong-surface', { target: { ...request.target, surface: 'ta' } }),
      fragment('wrong-scope', { target: { ...request.target, scope: 'seat:TC' } }),
      fragment('wrong-hash', { signature: { ...request.signature, normalizedArgsHash: 'sha256:other' } }),
      fragment('wildcard', { signature: { ...request.signature, stableCode: '*' } }),
    ], request);

    expect(pack.snippets.map((item) => item.id)).toEqual(['match']);
    expect(pack.omittedCount).toBe(4);
  });

  test('requires explicit verified status and non-expired timestamps', () => {
    const pack = buildKnowhowPack([
      fragment('verified'),
      fragment('candidate', { status: 'candidate' }),
      fragment('expired', { expiresAt: new Date(NOW).toISOString() }),
      fragment('future-verification', { verifiedAt: '2026-10-19T09:00:00.000Z' }),
      fragment('malformed-date', { expiresAt: 'tomorrow' }),
    ], request);

    expect(pack.snippets.map((item) => item.id)).toEqual(['verified']);
    expect(pack.omittedCount).toBe(4);
  });

  test('enforces the shared kind-specific half-life even when expiry allows longer', () => {
    const pack = buildKnowhowPack([
      fragment('fresh-fact'),
      fragment('expired-fact', {
        verifiedAt: '2026-10-01T09:00:00.000Z',
        expiresAt: '2026-11-01T09:00:00.000Z',
      }),
      fragment('long-lived-case', {
        kind: 'case',
        verifiedAt: '2025-10-01T09:00:00.000Z',
        expiresAt: '2026-11-01T09:00:00.000Z',
      }),
    ], request);

    expect(pack.snippets.map((item) => item.id)).toEqual(['fresh-fact', 'long-lived-case']);
    expect(pack.omittedCount).toBe(1);
  });

  test('sorts deterministically and deduplicates by id independent of input order', () => {
    const rows = [
      fragment('z', { text: 'z', verifiedAt: '2026-10-18T09:00:00.000Z' }),
      fragment('b', { text: 'b', verifiedAt: '2026-10-18T09:30:00.000Z' }),
      fragment('a', { text: 'a', verifiedAt: '2026-10-18T09:30:00Z' }),
      fragment('a', { text: 'duplicate id', verifiedAt: '2026-10-18T18:30:00+09:00' }),
    ];

    const first = buildKnowhowPack(rows, request);
    const second = buildKnowhowPack([...rows].reverse(), request);
    expect(first).toEqual(second);
    expect(first.snippets.map((item) => item.id)).toEqual(['a', 'b', 'z']);
    expect(first.snippets[0]?.text).toBe('a');
    expect(first.snippets[0]?.verifiedAt).toBe('2026-10-18T09:30:00Z');
  });

  test('budgets complete serialized snippets and admits them whole', () => {
    const smallA = fragment('small-a', { text: 'abc', source: { kind: 'KNOWHOW.md', path: 'p', ref: 'r' } });
    const smallB = fragment('small-b', { text: 'def', source: { kind: 'KNOWHOW.md', path: 'p', ref: 'r' } });
    const baseline = buildKnowhowPack([smallA, smallB], request);
    const maxChars = baseline.snippets.reduce((sum, snippet) => sum + JSON.stringify(snippet).length, 0);
    const pack = buildKnowhowPack([
      fragment('long', { text: 'x'.repeat(500), source: { kind: 'KNOWHOW.md', path: 'p', ref: 'r' } }),
      smallA,
      smallB,
    ], { ...request, maxItems: 3, maxChars });

    expect(pack.snippets.map((item) => item.id)).toEqual(['small-a', 'small-b']);
    expect(pack.snippets.map((item) => item.text).join('')).toBe('abcdef');
    expect(pack.snippets.reduce((sum, snippet) => sum + JSON.stringify(snippet).length, 0)).toBe(maxChars);
    expect(pack.snippets.reduce((sum, snippet) => sum + snippet.text.length, 0)).toBeLessThan(maxChars);
    expect(pack.omittedCount).toBe(1);
  });

  test('enforces default item and serialized-character limits on selected output', () => {
    const itemLimited = buildKnowhowPack(
      Array.from({ length: KNOWHOW_PACK_DEFAULT_K + 1 }, (_, index) => fragment(`item-${index}`)),
      request,
    );
    expect(itemLimited.snippets).toHaveLength(KNOWHOW_PACK_DEFAULT_K);

    const charLimited = buildKnowhowPack(
      Array.from({ length: KNOWHOW_PACK_DEFAULT_K }, (_, index) => fragment(`large-${index}`, { text: 'x'.repeat(5_000) })),
      request,
    );
    const serializedChars = charLimited.snippets.reduce((sum, snippet) => sum + JSON.stringify(snippet).length, 0);
    expect(charLimited.snippets.length).toBeLessThan(KNOWHOW_PACK_DEFAULT_K);
    expect(serializedChars).toBeLessThanOrEqual(KNOWHOW_PACK_DEFAULT_CHAR_BUDGET);
  });

  test('rejects malformed target and signature even when fragments are empty', () => {
    for (const malformed of [
      { ...request, target: null },
      { ...request, target: { surface: 'tui' } },
      { ...request, signature: null },
      { ...request, signature: { kind: 'tool-argument-error' } },
    ]) {
      expect(buildKnowhowPack([], malformed as unknown as KnowhowPackRequest)).toEqual({
        snippets: [], omittedCount: 0, diagnostics: ['invalid-request'],
      });
    }
  });

  test('returns an empty pack with a diagnostic for invalid limits', () => {
    expect(buildKnowhowPack([fragment('a')], { ...request, maxItems: -1 })).toEqual({
      snippets: [], omittedCount: 1, diagnostics: ['invalid-request'],
    });
    expect(buildKnowhowPack([fragment('a')], null as unknown as KnowhowPackRequest)).toEqual({
      snippets: [], omittedCount: 1, diagnostics: ['invalid-request'],
    });
  });
});
