// ── MK · 0.2.26 칸 CATALOG-FEED — signed catalog feed ──────────────────
//
// Folds a ModelCatalog into a verifiable feed document and verifies it on
// the receiving side:
//   buildCatalogFeed  — canonicalize (models sorted by id, stable-key JSON)
//                       + sha256 content digest.
//   signCatalogFeed   — ed25519 signature over the feed document (base64).
//   verifyCatalogFeed — reject tampered / forged feeds with a reason.
//
// Design = 내부 문서 `RFC-smart-model-routing-and-catalog-2026-10-10` §판올림=카탈로그 동봉.
// This piece is the judgment only — key generation/holding, the daily
// publish cron, and fetching are the next slice.
//
// 🔎 세 얼굴 — 관측: verify 거부는 debug.log('intelligence-map.catalog-feed',
// 'verify-rejected', { reason }) 로 남는다. 판단 근거: digest 는 «정렬·키 고정
// JSON» 의 sha256 hex 라 서명과 무관하게 내용 변조를 가른다. 수복·인계: 거부
// 사유가 'digest-mismatch' 면 서명 키는 맞고 «내용»이 바뀌었다 — 발행 측 카탈로그를
// 다시 잰다; 'bad-signature' 면 키가 다르다.

import { createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { debug } from '../debug/log.js';
import type { ModelCatalog, ModelEntry } from './types.js';

export interface CatalogFeed {
  schema: 'elanous.catalog-feed/1';
  issuedAt: string;
  models: ModelEntry[];
  digest: string;
}

export interface SignedCatalogFeed {
  feed: CatalogFeed;
  signature: string;
}

export type CatalogFeedVerifyResult =
  | { ok: true; feed: CatalogFeed }
  | { ok: false; reason: 'bad-signature' | 'digest-mismatch' | 'schema' };

/** Canonical JSON — sorted object keys, deterministic spacing. Arrays keep
 *  order; `models` is sorted by `id` before this is applied. */
function canonicalJson(value: unknown): string {
  // undefined follows JSON.stringify: dropped as an object key, null in an
  // array — so a feed survives a JSON round trip with the same digest.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256 hex of the canonical (sorted, key-stable) JSON of the feed. */
function feedDigest(feed: Omit<CatalogFeed, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(feed)).digest('hex');
}

/** Fold a catalog into a signed-feed-ready document. `models` is sorted by
 *  id so byte-identical catalogs always produce the same digest. */
export function buildCatalogFeed(catalog: ModelCatalog, issuedAt: Date): CatalogFeed {
  const models = [...catalog.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const base = {
    schema: 'elanous.catalog-feed/1' as const,
    issuedAt: issuedAt.toISOString(),
    models,
  };
  return { ...base, digest: feedDigest(base) };
}

/** Sign the feed document (whole feed, digest included) with an ed25519
 *  private key (PEM). Signature is base64 over the canonical JSON of the
 *  feed. */
export function signCatalogFeed(
  feed: CatalogFeed,
  privateKeyPem: string,
): { feed: CatalogFeed; signature: string } {
  const signature = cryptoSign(null, Buffer.from(canonicalJson(feed)), privateKeyPem).toString('base64');
  return { feed, signature };
}

/** Verify a signed feed: schema → content digest (recomputed, catches
 *  tampering that keeps the original digest) → signature. Rejected feeds
 *  are logged (제1원칙 관측) so the receiver's self-cognition can see why a
 *  feed was refused. */
export function verifyCatalogFeed(signed: SignedCatalogFeed, publicKeyPem: string): CatalogFeedVerifyResult {
  if (signed === null || typeof signed !== 'object') return reject('schema');
  const { feed, signature } = signed;
  if (feed === null || typeof feed !== 'object' || feed.schema !== 'elanous.catalog-feed/1' || typeof feed.issuedAt !== 'string' || !Array.isArray(feed.models)
    || typeof feed.digest !== 'string' || typeof signature !== 'string' || !feed.models.every(isModelEntryShape)) {
    return reject('schema');
  }
  const { digest: _digest, ...body } = feed;
  if (feedDigest(body) !== feed.digest) return reject('digest-mismatch');
  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, Buffer.from(canonicalJson(feed)), publicKeyPem, Buffer.from(signature, 'base64'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return reject('bad-signature');
  return { ok: true, feed };
}

/** Required ModelEntry fields at the receiving boundary — a signed feed with
 *  a model missing any of these is a schema failure, not a usable catalog. */
function isModelEntryShape(m: unknown): boolean {
  if (m === null || typeof m !== 'object') return false;
  const e = m as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  return typeof e.id === 'string' && e.id.length > 0 && typeof e.provider === 'string' && typeof e.family === 'string'
    && finite(e.contextWindow) && finite(e.inputPerMtok) && finite(e.outputPerMtok)
    && typeof e.local === 'boolean' && strings(e.tags) && strings(e.bestFor);
}

function reject(reason: 'bad-signature' | 'digest-mismatch' | 'schema'): { ok: false; reason: typeof reason } {
  debug.log('intelligence-map.catalog-feed', 'verify-rejected', { reason });
  return { ok: false, reason };
}
