import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export interface MarketplaceIndex {
  name: string;
  interface: { displayName: string };
  sequence: number;
  generatedAt?: string;
  plugins: Array<{
    name: string;
    source: { source: string; [key: string]: unknown };
    policy?: { installation: string; authentication: string };
    category?: string;
    version: string;
    description?: string;
    artifact: { sha256: string; bytes: number; key: string };
    'ai.elanous': {
      capabilities: string[];
      connectors: Array<{ id: string; kind: string; userConfig: Array<{ key: string; label: string; secret: boolean }> }>;
      graphs?: string[];
      vocab?: string[];
      requires?: { elanous?: string; tools?: string[] };
      pricing: { model: 'free' | 'one-time' | 'subscription'; amount?: number; currency?: string; period?: string };
    };
  }>;
}

export type VerifyIndexResult =
  | { ok: true; keyId: string; sequence: number; index: MarketplaceIndex }
  | { ok: false; reason: 'bad-signature' | 'unknown-key' | 'sequence-rollback' | 'malformed'; detail: string };

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const decoder = new TextDecoder('utf-8', { fatal: true });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function rawBase64(value: unknown, length: number): Buffer | null {
  if (!string(value) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === length && bytes.toString('base64') === value ? bytes : null;
}

function invalidIndex(value: unknown): string | null {
  if (!record(value)) return 'index: expected object';
  if (!string(value.name)) return 'name: expected string';
  if (!record(value.interface) || !string(value.interface.displayName)) return 'interface.displayName: expected string';
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) return 'sequence: expected non-negative integer';
  if (value.generatedAt !== undefined && !string(value.generatedAt)) return 'generatedAt: expected string';
  if (!Array.isArray(value.plugins)) return 'plugins: expected array';

  for (const [i, plugin] of value.plugins.entries()) {
    const field = (name: string) => `plugins[${i}] (${record(plugin) && string(plugin.name) ? plugin.name : 'unnamed'}).${name}`;
    if (!record(plugin)) return field('expected object');
    if (!string(plugin.name)) return field('name: expected string');
    if (!record(plugin.source) || !string(plugin.source.source)) return field('source.source: expected string');
    if (plugin.policy !== undefined && (!record(plugin.policy) || !string(plugin.policy.installation) || !string(plugin.policy.authentication))) return field('policy: expected installation and authentication strings');
    if (plugin.category !== undefined && !string(plugin.category)) return field('category: expected string');
    if (!string(plugin.version)) return field('version: expected string');
    if (plugin.description !== undefined && !string(plugin.description)) return field('description: expected string');
    if (!record(plugin.artifact)) return field('artifact: expected object');
    if (!string(plugin.artifact.sha256) || !/^[a-fA-F0-9]{64}$/.test(plugin.artifact.sha256)) return field('artifact.sha256: expected 64 hex characters');
    if (!Number.isSafeInteger(plugin.artifact.bytes) || (plugin.artifact.bytes as number) < 0) return field('artifact.bytes: expected non-negative integer');
    if (!string(plugin.artifact.key)) return field('artifact.key: expected string');
    const ai = plugin['ai.elanous'];
    if (!record(ai)) return field('ai.elanous: expected object');
    if (!stringArray(ai.capabilities)) return field('ai.elanous.capabilities: expected string array');
    if (!Array.isArray(ai.connectors)) return field('ai.elanous.connectors: expected array');
    for (const [j, connector] of ai.connectors.entries()) {
      if (!record(connector) || !string(connector.id) || !string(connector.kind) || !Array.isArray(connector.userConfig)) return field(`ai.elanous.connectors[${j}]: expected id, kind, userConfig`);
      for (const [k, config] of connector.userConfig.entries()) {
        if (!record(config) || !string(config.key) || !string(config.label) || typeof config.secret !== 'boolean') return field(`ai.elanous.connectors[${j}].userConfig[${k}]: expected key, label, secret`);
      }
    }
    if (ai.graphs !== undefined && !stringArray(ai.graphs)) return field('ai.elanous.graphs: expected string array');
    if (ai.vocab !== undefined && !stringArray(ai.vocab)) return field('ai.elanous.vocab: expected string array');
    if (ai.requires !== undefined && (!record(ai.requires) || (ai.requires.elanous !== undefined && !string(ai.requires.elanous)) || (ai.requires.tools !== undefined && !stringArray(ai.requires.tools)))) return field('ai.elanous.requires: expected elanous string and tools string array');
    if (!record(ai.pricing) || !['free', 'one-time', 'subscription'].includes(ai.pricing.model as string)) return field('ai.elanous.pricing.model: expected free, one-time or subscription');
    if (ai.pricing.amount !== undefined && (typeof ai.pricing.amount !== 'number' || !Number.isFinite(ai.pricing.amount))) return field('ai.elanous.pricing.amount: expected number');
    if (ai.pricing.currency !== undefined && !string(ai.pricing.currency)) return field('ai.elanous.pricing.currency: expected string');
    if (ai.pricing.period !== undefined && !string(ai.pricing.period)) return field('ai.elanous.pricing.period: expected string');
  }
  return null;
}

export function validateMarketplaceIndex(value: unknown): string | null {
  return invalidIndex(value);
}

export function verifyIndex(input: {
  marketplaceBytes: Uint8Array;
  signatureText: string;
  trustedKeys: ReadonlyArray<{ keyId: string; publicKey: string }>;
  lastSequence?: number;
}): VerifyIndexResult {
  const malformed = (detail: string): VerifyIndexResult => ({ ok: false, reason: 'malformed', detail });
  let envelope: unknown;
  try {
    if (input.signatureText.includes('\n') || input.signatureText.includes('\r')) return malformed('index.sig: expected one JSON line');
    envelope = JSON.parse(input.signatureText);
  } catch {
    return malformed('index.sig: invalid JSON');
  }
  if (!record(envelope) || !string(envelope.keyId) || !/^[a-fA-F0-9]{8}$/.test(envelope.keyId) || envelope.alg !== 'ed25519') {
    return malformed('index.sig: expected 8-hex keyId and ed25519 alg');
  }
  const trusted = input.trustedKeys.find(key => key.keyId === envelope.keyId);
  if (!trusted) return { ok: false, reason: 'unknown-key', detail: `index.sig.keyId: ${envelope.keyId}` };
  const signature = rawBase64(envelope.sig, 64);
  if (!signature) return malformed('index.sig.sig: expected base64 64-byte signature');
  const publicKey = rawBase64(trusted.publicKey, 32);
  if (!publicKey) return malformed(`trustedKeys[${envelope.keyId}].publicKey: expected base64 32-byte key`);
  let valid: boolean;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    valid = verify(null, input.marketplaceBytes, key, signature);
  } catch {
    return malformed(`trustedKeys[${envelope.keyId}].publicKey: invalid Ed25519 key`);
  }
  if (!valid) return { ok: false, reason: 'bad-signature', detail: 'marketplace.json: signature verification failed' };

  let index: unknown;
  try {
    index = JSON.parse(decoder.decode(input.marketplaceBytes));
  } catch {
    return malformed('marketplace.json: invalid UTF-8 or JSON');
  }
  const error = invalidIndex(index);
  if (error) return malformed(`marketplace.json.${error}`);
  const parsed = index as MarketplaceIndex;
  if (input.lastSequence !== undefined && parsed.sequence < input.lastSequence) {
    return { ok: false, reason: 'sequence-rollback', detail: `sequence ${parsed.sequence} < lastSequence ${input.lastSequence}` };
  }
  return { ok: true, keyId: envelope.keyId, sequence: parsed.sequence, index: parsed };
}

export function signIndex(marketplaceBytes: Uint8Array, privateKeyPem: string, keyId: string): string {
  if (!/^[a-fA-F0-9]{8}$/.test(keyId)) throw new Error('keyId: expected 8 hex characters');
  const signature = sign(null, marketplaceBytes, privateKeyPem);
  return JSON.stringify({ keyId, alg: 'ed25519', sig: signature.toString('base64') });
}

export function generateIndexKeyPair(): { keyId: string; publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const raw = der.subarray(ED25519_SPKI_PREFIX.length);
  return {
    keyId: createHash('sha256').update(raw).digest('hex').slice(0, 8),
    publicKey: raw.toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}
