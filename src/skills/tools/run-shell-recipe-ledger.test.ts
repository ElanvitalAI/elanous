import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { parseRecipeJson, recipeHash, recipeSigningBytes, verifyRecipeEvent, verifySignedRecipeGrant,
  recipeEpochSigningBytes, verifyRecipeEpochEvent, verifySignedRecipeEpochGrant } from './run-shell-recipe-ledger.js';

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const recipe = freeze({ id: 'op-30m', version: 1, argvTemplate: ['eln', 'ops', 'check-30m'] });

describe('RunShell recipe signature foundation', () => {
  const jud = generateKeyPairSync('ed25519');
  const attacker = generateKeyPairSync('ed25519');
  const trusted = jud.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const unsigned = { v: 1 as const, kind: 'grant' as const, recipeId: recipe.id,
    recipeSha256: recipeHash(recipe), signer: 'JUD' as const, at: '2026-11-22T00:00:00.000Z' };
  const signed = (privateKey: KeyObject, event: typeof unsigned | (Omit<typeof unsigned, 'kind'> & { kind: 'revoke' }) = unsigned) => ({ ...event,
    signature: sign(null, recipeSigningBytes(event), privateKey).toString('base64') });

  test('rejects missing trust before considering a self-declared signer', () => {
    expect(verifySignedRecipeGrant(recipe, signed(jud.privateKey), undefined))
      .toEqual({ allowed: false, reason: 'missing-trust-key' });
  });

  test('accepts only an exact Ed25519 signature and recipe hash', () => {
    expect(verifySignedRecipeGrant(recipe, signed(attacker.privateKey), trusted))
      .toEqual({ allowed: false, reason: 'invalid-signature' });
    expect(verifySignedRecipeGrant(freeze({ ...recipe, argvTemplate: ['eln', 'other'] }), signed(jud.privateKey), trusted))
      .toEqual({ allowed: false, reason: 'recipe-mismatch' });
    expect(verifySignedRecipeGrant(recipe, signed(jud.privateKey), trusted))
      .toEqual({ allowed: true, signer: 'JUD', at: unsigned.at, recipeSha256: unsigned.recipeSha256 });
  });

  test('canonical hashes reject non-JSON and ambiguous structures', () => {
    const hole = Array(1);
    const extra = Object.assign([1], { extra: true });
    const hidden = Object.defineProperty({}, 'x', { value: 1 });
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 });
    const symbol = { [Symbol('x')]: 1 };
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    for (const value of [hole, extra, hidden, getter, symbol, cycle, new Date(), new Map()]) Object.freeze(value);
    for (const value of [hole, extra, hidden, getter, symbol, cycle, new Date(), new Map(),
      undefined, NaN, Infinity, -0, 1n, () => 1]) {
      expect(() => recipeHash(value)).toThrow();
    }
    expect(recipeHash(freeze({ b: [null, 1], a: true }))).toBe(recipeHash(freeze({ a: true, b: [null, 1] })));
    expect(recipeHash(freeze([]))).not.toBe(recipeHash(freeze([null])));
    expect(verifySignedRecipeGrant({ ...recipe, argvTemplate: hole }, signed(jud.privateKey), trusted))
      .toEqual({ allowed: false, reason: 'invalid-recipe' });
  });


  test('rejects proxy, accessor, and mutable recipe graphs without invoking traps or getters', () => {
    let calls = 0;
    const getter = Object.freeze({ get id() { calls++; return recipe.id; }, version: 1 });
    const proxy = new Proxy(recipe, { get() { calls++; return recipe.id; },
      ownKeys() { calls++; throw new Error('trap'); } });
    const nestedProxy = Object.freeze({ ...recipe, argvTemplate: new Proxy(recipe.argvTemplate, {
      ownKeys() { calls++; throw new Error('trap'); },
    }) });
    const revoked = Proxy.revocable(recipe, {}); revoked.revoke();
    const shallow = Object.freeze({ ...recipe, argvTemplate: ['eln'] });
    for (const bad of [getter, proxy, nestedProxy, revoked.proxy, shallow, { ...recipe }]) {
      expect(() => recipeHash(bad)).toThrow();
      expect(verifySignedRecipeGrant(bad, signed(jud.privateKey), trusted))
        .toEqual({ allowed: false, reason: 'invalid-recipe' });
    }
    expect(calls).toBe(0);
  });

  test('bounds expanded shared DAGs, depth, and text while preserving small shared graphs', () => {
    const shared = Object.freeze({ value: 'ok' });
    expect(recipeHash(Object.freeze({ a: shared, b: shared })))
      .toBe(recipeHash(freeze({ a: { value: 'ok' }, b: { value: 'ok' } })));
    let dag: unknown = Object.freeze({ value: 1 });
    for (let i = 0; i < 15; i++) dag = Object.freeze({ a: dag, b: dag });
    const candidate = Object.freeze({ id: recipe.id, dag });
    expect(() => recipeHash(candidate)).toThrow('recipe limit');
    expect(verifySignedRecipeGrant(candidate, signed(jud.privateKey), trusted))
      .toEqual({ allowed: false, reason: 'recipe limit: nodes' });
    let deep: unknown = null;
    for (let i = 0; i < 80; i++) deep = Object.freeze({ next: deep });
    expect(() => recipeHash(deep)).toThrow('recipe limit');
    expect(() => recipeHash(Object.freeze({ x: 'x'.repeat(1_000_000) }))).toThrow('recipe limit: text');
  });

  test('exact and plus-one limits for expanded nodes, depth and text', () => {
    expect(() => recipeHash(Object.freeze(Array(9_999).fill(null)))).not.toThrow();
    expect(() => recipeHash(Object.freeze(Array(10_000).fill(null)))).toThrow('recipe limit: nodes');
    let value: unknown = null;
    for (let i = 0; i < 64; i++) value = Object.freeze([value]);
    expect(() => recipeHash(value)).not.toThrow();
    expect(() => recipeHash(Object.freeze([value]))).toThrow('recipe limit: depth');
    expect(() => recipeHash('x'.repeat(1_000_000))).not.toThrow();
    expect(() => recipeHash('x'.repeat(1_000_001))).toThrow('recipe limit: text');
    expect(() => recipeHash(Object.freeze({ a: 'x'.repeat(999_999) }))).not.toThrow();
    expect(() => recipeHash(Object.freeze({ a: 'x'.repeat(1_000_000) }))).toThrow('recipe limit: text');
  });

  test('raw JSON limit checked before decode and parse; valid nested output is frozen', () => {
    const exact = Buffer.from('null' + ' '.repeat(1_000_000 - 4));
    const over = Buffer.from('null' + ' '.repeat(1_000_001 - 4));
    expect(parseRecipeJson(exact)).toBeNull();
    expect(() => parseRecipeJson(over)).toThrow('recipe limit: raw bytes');
    const parsed = parseRecipeJson(Buffer.from('{"id":"x","nested":[1]}')) as { nested: unknown[] };
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.nested)).toBe(true);
    expect(() => parseRecipeJson(Uint8Array.of(0xff))).toThrow();
    const tricky = Object.freeze(JSON.parse('{"__proto__":1,"constructor":2,"toString":3}'));
    expect(recipeHash(tricky)).toBe(recipeHash(Object.freeze({ ['__proto__']: 1, constructor: 2, toString: 3 })));
  });

  test('rejects non-extensible but writable properties and oversized sparse arrays', () => {
    const writable = Object.preventExtensions({ id: recipe.id });
    const configurable = Object.preventExtensions(Object.defineProperty({}, 'id', {
      value: recipe.id, enumerable: true, configurable: true,
    }));
    const writableLength = Object.preventExtensions([]);
    for (const bad of [writable, configurable, writableLength]) {
      expect(() => recipeHash(bad)).toThrow();
    }
    const sparse = Object.freeze(new Array(1_000_000_000));
    const ownKeys = Reflect.ownKeys;
    let enumerations = 0;
    try {
      Reflect.ownKeys = (target) => { enumerations++; return ownKeys(target); };
      expect(() => recipeHash(sparse)).toThrow('recipe limit');
      expect(enumerations).toBe(0);
    } finally { Reflect.ownKeys = ownKeys; }
    const wide = Object.freeze(Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [String(i), i])));
    expect(() => recipeHash(wide)).toThrow('recipe limit');
    // SHA-256 of the original sorted canonical JSON, independently calculated.
    expect(recipeHash(recipe)).toBe('40d38f9510622b4201b717b6f7590b867a63f16cc82eee007175488bc574bc41');
    expect(verifySignedRecipeGrant(recipe, signed(jud.privateKey), trusted).allowed).toBe(true);
  });

  test('compares both id and hash against the same frozen snapshot', () => {
    const event = signed(jud.privateKey);
    const differentId = freeze({ ...recipe, id: 'other' });
    const matchingHashWrongId = signed(jud.privateKey, { ...unsigned, recipeSha256: recipeHash(differentId) });
    expect(verifySignedRecipeGrant(differentId, matchingHashWrongId, trusted))
      .toEqual({ allowed: false, reason: 'recipe-mismatch' });
    expect(verifySignedRecipeGrant(differentId, event, trusted))
      .toEqual({ allowed: false, reason: 'recipe-mismatch' });
    const protoKey = Object.freeze(JSON.parse('{"id":"op-30m","__proto__":{"x":1}}'));
    Object.freeze(protoKey.__proto__);
    expect(recipeHash(protoKey)).not.toBe(recipeHash(freeze({ id: 'op-30m' })));
  });

  test('rejects malformed records, wrong keys, and signed revocation as grants', () => {
    expect(verifySignedRecipeGrant(recipe, { ...signed(jud.privateKey), extra: true }, trusted))
      .toEqual({ allowed: false, reason: 'invalid-event' });
    expect(verifySignedRecipeGrant(recipe, signed(jud.privateKey), 'not a public key'))
      .toEqual({ allowed: false, reason: 'invalid-trust-key' });
    const revoke = { ...unsigned, kind: 'revoke' as const };
    expect(verifySignedRecipeGrant(recipe, signed(jud.privateKey, revoke), trusted))
      .toEqual({ allowed: false, reason: 'not-grant' });
  });
  test('rejects malformed unknown events and noncanonical signature encodings', () => {
    const valid = signed(jud.privateKey);
    const signatures = [valid.signature.slice(0, -2), valid.signature + '\n',
      valid.signature.replace(/\+/g, '-').replace(/\//g, '_'), 'x'.repeat(86) + '=='];
    for (const value of [null, undefined, 1, [], {}, { ...valid, at: 'not-a-date' },
      ...signatures.filter(signature => signature !== valid.signature).map(signature => ({ ...valid, signature }))]) {
      expect(verifyRecipeEvent(value, trusted)).toBe(false);
      expect(verifySignedRecipeGrant(recipe, value, trusted)).toEqual({ allowed: false, reason: 'invalid-event' });
    }
    expect(verifyRecipeEvent(valid, trusted)).toBe(true);
  });

  test('rejects hostile and changing event objects without invoking accessors', () => {
    const valid = signed(jud.privateKey);
    let reads = 0;
    const getter = { ...valid, get kind() { reads++; return reads === 1 ? 'grant' : 'revoke'; } };
    const throws = new Proxy(valid, { ownKeys() { throw new Error('hostile'); } });
    const changes = new Proxy(valid, { get(target, key, receiver) {
      return key === 'kind' && ++reads > 1 ? 'revoke' : Reflect.get(target, key, receiver);
    } });
    const revoked = Proxy.revocable(valid, {}); revoked.revoke();
    for (const value of [getter, throws, changes, revoked.proxy]) {
      expect(verifyRecipeEvent(value, trusted)).toBe(false);
      expect(verifySignedRecipeGrant(recipe, value, trusted)).toEqual({ allowed: false, reason: 'invalid-event' });
    }
    expect(reads).toBe(0);
  });

  test('accepts an OpenSSL Ed25519 vector and rejects noncanonical base64 pad bits', () => {
    // Independently signed with openssl pkeyutl -sign -rawin, not recipeSigningBytes.
    const key = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3IIzr8mExfpSaol/E/mqmBI256qEhpVP4R2Uq2xO7vs=\n-----END PUBLIC KEY-----\n';
    const event = { v: 1, kind: 'grant', recipeId: 'external', recipeSha256: '0'.repeat(64),
      signer: 'JUD', at: '2026-11-22T00:00:00.000Z',
      signature: 'rHMWXmCLU5uhhBJMGP6JJ2H3rh5V6k9TLzD5oR9YoMqEQEExBOoFbfdJcywIbaWy3SUYEPBudhqCOsUhPhonDA==' };
    expect(verifyRecipeEvent(event, key)).toBe(true);
    const altered = { ...event, signature: event.signature.slice(0, -3) + 'B==' };
    expect(Buffer.from(altered.signature, 'base64').equals(Buffer.from(event.signature, 'base64'))).toBe(true);
    expect(verifyRecipeEvent(altered, key)).toBe(false);
    expect(verifySignedRecipeGrant(recipe, altered, key)).toEqual({ allowed: false, reason: 'invalid-event' });
  });

});

describe('RunShell signed recipe epoch v2', () => {
  const jud = generateKeyPairSync('ed25519');
  const attacker = generateKeyPairSync('ed25519');
  const trusted = jud.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const unsigned = { v: 2 as const, kind: 'grant' as const, recipeId: recipe.id,
    recipeSha256: recipeHash(recipe), epoch: 7, signer: 'JUD' as const, at: '2026-11-22T00:00:00.000Z' };
  const signed = (event = unsigned, key = jud.privateKey) => ({ ...event,
    signature: sign(null, recipeEpochSigningBytes(event), key).toString('base64') });

  test('uses a distinct canonical signature domain and binds epoch, id and hash', () => {
    expect(recipeEpochSigningBytes(unsigned).toString()).toBe(
      'elanous:runshell-recipe:v2\n' + JSON.stringify({ at: unsigned.at, epoch: 7, kind: 'grant',
        recipeId: recipe.id, recipeSha256: unsigned.recipeSha256, signer: 'JUD', v: 2 }));
    const event = signed();
    expect(verifyRecipeEpochEvent(event, trusted)).toBe(true);
    expect(verifySignedRecipeEpochGrant(recipe, event, trusted, 7)).toEqual({ allowed: true,
      signer: 'JUD', at: unsigned.at, recipeSha256: unsigned.recipeSha256, epoch: 7 });
    expect(verifySignedRecipeEpochGrant(recipe, event, trusted, 8).allowed).toBe(false);
    expect(verifySignedRecipeEpochGrant(recipe, event, trusted, 6).allowed).toBe(false);
    expect(verifyRecipeEpochEvent({ ...event, epoch: 8 }, trusted)).toBe(false);
    expect(verifyRecipeEpochEvent({ ...event, recipeId: 'other' }, trusted)).toBe(false);
    expect(verifyRecipeEpochEvent({ ...event, recipeSha256: '0'.repeat(64) }, trusted)).toBe(false);
    const changed = freeze({ ...recipe, id: 'other' });
    expect(verifySignedRecipeEpochGrant(changed, signed({ ...unsigned, recipeSha256: recipeHash(changed) }), trusted, 7))
      .toEqual({ allowed: false, reason: 'recipe-mismatch' });
    expect(verifySignedRecipeEpochGrant(freeze({ ...recipe, version: 2 }), event, trusted, 7).allowed).toBe(false);
    expect(verifyRecipeEvent(event, trusted)).toBe(false);
    const old = { v: 1 as const, kind: 'grant' as const, recipeId: recipe.id,
      recipeSha256: unsigned.recipeSha256, signer: 'JUD' as const, at: unsigned.at };
    expect(verifyRecipeEpochEvent({ ...old, signature: sign(null, recipeSigningBytes(old), jud.privateKey).toString('base64') }, trusted)).toBe(false);
    const wrongDomain = { ...event, signature: sign(null, recipeSigningBytes({ ...old }), jud.privateKey).toString('base64') };
    expect(verifyRecipeEpochEvent(wrongDomain, trusted)).toBe(false);
  });

  test('fails closed on keys, signatures, epochs, revocations and malformed events', () => {
    const event = signed();
    expect(verifySignedRecipeEpochGrant(recipe, event, undefined, 7)).toEqual({ allowed: false, reason: 'missing-trust-key' });
    for (const key of ['bad', jud.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()]) {
      expect(verifyRecipeEpochEvent(event, key)).toBe(false);
      expect(verifySignedRecipeEpochGrant(recipe, event, key, 7).allowed).toBe(false);
    }
    expect(verifySignedRecipeEpochGrant(recipe, signed(unsigned, attacker.privateKey), trusted, 7).allowed).toBe(false);
    for (const epoch of [-1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(verifySignedRecipeEpochGrant(recipe, event, trusted, epoch).allowed).toBe(false);
      expect(verifyRecipeEpochEvent({ ...event, epoch }, trusted)).toBe(false);
    }
    const revoke = { ...unsigned, kind: 'revoke' as const };
    const revoked = { ...revoke, signature: sign(null, recipeEpochSigningBytes(revoke), jud.privateKey).toString('base64') };
    expect(verifyRecipeEpochEvent(revoked, trusted)).toBe(true);
    expect(verifySignedRecipeEpochGrant(recipe, revoked, trusted, 7)).toEqual({ allowed: false, reason: 'not-grant' });
    for (const bad of [{ ...event, extra: true }, { ...event, signature: event.signature + '\n' },
      { ...event, at: 'invalid' }, { ...event, epoch: '7' }]) {
      expect(verifyRecipeEpochEvent(bad, trusted)).toBe(false);
    }
  });

  test('snapshots event descriptors without invoking traps or getters and rejects mutable recipes', () => {
    const event = signed();
    let reads = 0;
    const getter = { ...event, get epoch() { reads++; return 7; } };
    const proxy = new Proxy(event, { ownKeys() { reads++; throw new Error('trap'); } });
    const revoked = Proxy.revocable(event, {}); revoked.revoke();
    for (const bad of [getter, proxy, revoked.proxy]) {
      expect(verifyRecipeEpochEvent(bad, trusted)).toBe(false);
      expect(verifySignedRecipeEpochGrant(recipe, bad, trusted, 7).allowed).toBe(false);
    }
    expect(reads).toBe(0);
    expect(verifySignedRecipeEpochGrant({ ...recipe }, event, trusted, 7))
      .toEqual({ allowed: false, reason: 'invalid-recipe' });
  });
});
