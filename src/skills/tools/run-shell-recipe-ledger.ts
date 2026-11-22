import { createHash, createPublicKey, verify } from 'node:crypto';
import { types } from 'node:util';

type Kind = 'grant' | 'revoke';
export type RecipeEvent = { v: 1; kind: Kind; recipeId: string; recipeSha256: string;
  signer: 'JUD'; at: string; signature: string };
export type RecipeGrant = { allowed: true; signer: 'JUD'; at: string; recipeSha256: string }
  | { allowed: false; reason: string };

// Only deeply frozen, non-proxy JSON data is accepted at the recipe boundary.
// The runtime's node:util.types.isProxy must correctly identify proxies; if absent,
// fail closed. Hostile modifications of JS intrinsics are outside this module's boundary.
// Count expanded occurrences, not distinct objects: shared DAGs must not amplify work.
// Text budget counts UTF-16 code units in string values and object keys.
const MAX_RECIPE_NODES = 10_000, MAX_RECIPE_DEPTH = 64, MAX_RECIPE_TEXT = 1_000_000;
function recipeSnapshot(value: unknown, ancestors = new Set<object>(),
  budget = { nodes: 0, text: 0 }, depth = 0): unknown {
  if (++budget.nodes > MAX_RECIPE_NODES) throw new Error('recipe limit: nodes');
  if (depth > MAX_RECIPE_DEPTH) throw new Error('recipe limit: depth');
  if (typeof value === 'string') {
    budget.text += value.length;
    if (budget.text > MAX_RECIPE_TEXT) throw new Error('recipe limit: text');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== 'object' || value === null) throw new Error('unsupported recipe value');
  if (typeof types.isProxy !== 'function' || types.isProxy(value)) throw new Error('proxy recipe');
  // Check individual descriptors below instead of Object.isFrozen: the latter
  // enumerates every property before the budget can reject a wide object.
  if (Object.isExtensible(value)) throw new Error('mutable recipe');
  if (ancestors.has(value)) throw new Error('recipe cycle');
  ancestors.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error('non-JSON recipe object');
    // Array length is available without enumerating its elements, even if sparse.
    const lengthDescriptor = array ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
    const length = lengthDescriptor?.value;
    if (array && (!Number.isSafeInteger(length) || length < 0 || length > MAX_RECIPE_NODES - budget.nodes))
      throw new Error('recipe limit: nodes');
    // JS has no bounded own-key enumeration. Callers accepting external bytes must
    // limit them *before* parsing; arbitrary in-memory objects are not bounded here.
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_RECIPE_NODES - budget.nodes + (array ? 1 : 0)) throw new Error('recipe limit: nodes');
    if (keys.some(key => typeof key !== 'string')) throw new Error('symbol key');
    if (!array) for (const key of keys as string[]) {
      budget.text += key.length;
      if (budget.text > MAX_RECIPE_TEXT) throw new Error('recipe limit: text');
    }
    const data = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
        || descriptor.configurable || descriptor.writable)
        throw new Error('hole, accessor, hidden, or mutable property');
      return recipeSnapshot(descriptor.value, ancestors, budget, depth + 1);
    };
    if (array) {
      if (!lengthDescriptor || lengthDescriptor.configurable || lengthDescriptor.writable
        || lengthDescriptor.enumerable || keys.length !== length + 1)
        throw new Error('sparse, mutable, or extended array');
      return Array.from({ length }, (_, i) => data(String(i)));
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) result[key] = data(key);
    return result;
  } finally { ancestors.delete(value); }
}

// Called only with locally constructed plain data, never with caller-owned values.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hashSnapshot(snapshot: unknown): string {
  return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

// Future JSON ingress must call this before any object enumeration. The caller must
// also bound the stream while reading; a pre-existing oversized buffer is already allocated.
export const MAX_RECIPE_JSON_BYTES = 1_000_000;
export function parseRecipeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_RECIPE_JSON_BYTES) throw new Error('recipe limit: raw bytes');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const root: unknown = JSON.parse(text);
  // Iterative freeze avoids recursion in the parser on hostile nesting. The byte
  // bound caps every per-object key enumeration before snapshot validation.
  const pending: unknown[] = [root];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === 'object') {
      for (const key of Object.keys(item)) pending.push((item as Record<string, unknown>)[key]);
      Object.freeze(item);
    }
  }
  recipeSnapshot(root); // enforce expanded node/depth/text contract before returning
  return root;
}

export function recipeHash(recipe: unknown): string {
  return hashSnapshot(recipeSnapshot(recipe));
}

export function recipeSigningBytes(event: Omit<RecipeEvent, 'signature'>): Buffer {
  return Buffer.from(`elanous:runshell-recipe:v1\n${canonical({ v: event.v, kind: event.kind,
    recipeId: event.recipeId, recipeSha256: event.recipeSha256, signer: event.signer, at: event.at })}`);
}

function eventSnapshot(value: unknown): RecipeEvent | undefined {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 7 || keys.some(key => typeof key !== 'string') || keys.sort().join(',') !==
      'at,kind,recipeId,recipeSha256,signature,signer,v') return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return;
      record[key] = descriptor.value;
    }
    const event = record as RecipeEvent;
    if (event.v !== 1 || (event.kind !== 'grant' && event.kind !== 'revoke') || event.signer !== 'JUD'
      || typeof event.recipeId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(event.recipeId)
      || typeof event.recipeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.recipeSha256)
      || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))
      || new Date(event.at).toISOString() !== event.at
      || typeof event.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(event.signature)
      || Buffer.from(event.signature, 'base64').toString('base64') !== event.signature) return;
    return event;
  } catch { return; }
}

/** A boolean check only; callers must not trust later reads from the original mutable object. */
export function verifyRecipeEvent(value: unknown, trustedJudPublicKeyPem: string | undefined): value is RecipeEvent {
  const event = eventSnapshot(value);
  if (!event || !trustedJudPublicKeyPem) return false;
  try {
    const key = createPublicKey(trustedJudPublicKeyPem);
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, recipeSigningBytes(event), key, Buffer.from(event.signature, 'base64'));
  } catch { return false; }
}

/** Pure verification only. The caller in the FU must bind ledger state, epoch and effects. */
export function verifySignedRecipeGrant<T extends { id: string }>(recipe: T, candidate: unknown,
  trustedJudPublicKeyPem: string | undefined): RecipeGrant {
  if (!trustedJudPublicKeyPem) return { allowed: false, reason: 'missing-trust-key' };
  let key;
  try {
    key = createPublicKey(trustedJudPublicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch { return { allowed: false, reason: 'invalid-trust-key' }; }
  const event = eventSnapshot(candidate);
  if (!event) return { allowed: false, reason: 'invalid-event' };
  if (!verify(null, recipeSigningBytes(event), key, Buffer.from(event.signature, 'base64')))
    return { allowed: false, reason: 'invalid-signature' };
  if (event.kind !== 'grant') return { allowed: false, reason: 'not-grant' };
  let snapshot: unknown;
  try { snapshot = recipeSnapshot(recipe); } catch (error) {
    return { allowed: false, reason: error instanceof Error && error.message.startsWith('recipe limit: ')
      ? error.message : 'invalid-recipe' };
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return { allowed: false, reason: 'invalid-recipe' };
  const hash = hashSnapshot(snapshot);
  if (event.recipeId !== (snapshot as Record<string, unknown>).id || event.recipeSha256 !== hash)
    return { allowed: false, reason: 'recipe-mismatch' };
  return { allowed: true, signer: 'JUD', at: event.at, recipeSha256: hash };
}

/** V2 is a distinct signature protocol; it never upgrades or accepts a V1 event. */
export type RecipeEpochEvent = { v: 2; kind: Kind; recipeId: string; recipeSha256: string;
  epoch: number; signer: 'JUD'; at: string; signature: string };
export type RecipeEpochGrant = { allowed: true; signer: 'JUD'; at: string; recipeSha256: string; epoch: number }
  | { allowed: false; reason: string };

export function recipeEpochSigningBytes(event: Omit<RecipeEpochEvent, 'signature'>): Buffer {
  return Buffer.from(`elanous:runshell-recipe:v2\n${canonical({ v: event.v, kind: event.kind,
    recipeId: event.recipeId, recipeSha256: event.recipeSha256, epoch: event.epoch,
    signer: event.signer, at: event.at })}`);
}

// Read own data descriptors once, without executing proxies or accessors. The
// resulting local frozen record is the only event used after verification.
function epochEventSnapshot(value: unknown): Readonly<RecipeEpochEvent> | undefined {
  try {
    if (!value || typeof value !== 'object' || typeof types.isProxy !== 'function'
      || types.isProxy(value) || Array.isArray(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 8 || keys.some(key => typeof key !== 'string') || keys.sort().join(',') !==
      'at,epoch,kind,recipeId,recipeSha256,signature,signer,v') return;
    const record: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return;
      record[key] = descriptor.value;
    }
    const event = record as RecipeEpochEvent;
    if (event.v !== 2 || (event.kind !== 'grant' && event.kind !== 'revoke') || event.signer !== 'JUD'
      || typeof event.recipeId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(event.recipeId)
      || typeof event.recipeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.recipeSha256)
      || !Number.isSafeInteger(event.epoch) || event.epoch < 0 || Object.is(event.epoch, -0)
      || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))
      || new Date(event.at).toISOString() !== event.at
      || typeof event.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(event.signature)
      || Buffer.from(event.signature, 'base64').toString('base64') !== event.signature) return;
    return Object.freeze(event);
  } catch { return; }
}

function epochTrustKey(pem: string | undefined) {
  if (typeof pem !== 'string' || !/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\s*$/.test(pem)) return;
  try {
    const key = createPublicKey(pem);
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch { return; }
}

/** Signature validation only: does not establish current epoch or permission to execute. */
export function verifyRecipeEpochEvent(value: unknown, trustedJudPublicKeyPem: string | undefined): boolean {
  const event = epochEventSnapshot(value);
  const key = epochTrustKey(trustedJudPublicKeyPem);
  if (!event || !key) return false;
  try { return verify(null, recipeEpochSigningBytes(event), key, Buffer.from(event.signature, 'base64')); }
  catch { return false; }
}

/** Pure check against a caller-provided current epoch; caller must reread trusted state at the execution gate. */
export function verifySignedRecipeEpochGrant<T extends { id: string }>(recipe: T, candidate: unknown,
  trustedJudPublicKeyPem: string | undefined, currentEpoch: number): RecipeEpochGrant {
  if (!trustedJudPublicKeyPem) return { allowed: false, reason: 'missing-trust-key' };
  const key = epochTrustKey(trustedJudPublicKeyPem);
  if (!key) return { allowed: false, reason: 'invalid-trust-key' };
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0 || Object.is(currentEpoch, -0))
    return { allowed: false, reason: 'invalid-epoch' };
  const event = epochEventSnapshot(candidate);
  if (!event) return { allowed: false, reason: 'invalid-event' };
  try {
    if (!verify(null, recipeEpochSigningBytes(event), key, Buffer.from(event.signature, 'base64')))
      return { allowed: false, reason: 'invalid-signature' };
  } catch { return { allowed: false, reason: 'invalid-signature' }; }
  if (event.kind !== 'grant') return { allowed: false, reason: 'not-grant' };
  if (event.epoch !== currentEpoch) return { allowed: false, reason: 'epoch-mismatch' };
  let snapshot: unknown;
  try { snapshot = recipeSnapshot(recipe); } catch (error) {
    return { allowed: false, reason: error instanceof Error && error.message.startsWith('recipe limit: ')
      ? error.message : 'invalid-recipe' };
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return { allowed: false, reason: 'invalid-recipe' };
  const hash = hashSnapshot(snapshot);
  if (event.recipeId !== (snapshot as Record<string, unknown>).id || event.recipeSha256 !== hash)
    return { allowed: false, reason: 'recipe-mismatch' };
  return { allowed: true, signer: 'JUD', at: event.at, recipeSha256: hash, epoch: event.epoch };
}
