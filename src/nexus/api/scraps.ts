import { debug } from '../../debug/log.js';
import { buildAbsorbSummaryCard, extractAbsorbScrap, type AbsorbCardLlm, type AbsorbExtraction, type AbsorbExtractorAdapters } from '../../intake-plane/absorb-extract.js';
import { ingestAbsorbScrap, listAbsorbScraps, updateAbsorbScrap, type AbsorbScrapKind, type AbsorbScrapPayload } from '../../intake-plane/items.js';

const KINDS: readonly AbsorbScrapKind[] = ['text', 'web', 'x', 'youtube', 'voice', 'video', 'photo'];
const SOURCES: readonly AbsorbScrapPayload['source'][] = ['android-share', 'android-record', 'flutter-share', 'flutter-record', 'tui', 'pwa', 'telegram'];
// Source: initial intake contract caps each submitted text-like field at 20 KB.
const MAX_SCRAP_FIELD_CHARS = 20_000;
// Source: store keys are opaque UUID-like client tokens, bounded to prevent header abuse.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
// Source: media object IDs are client-generated opaque path components, bounded to 128 characters.
const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Source: Android note timeline keys use scraps/<note-id>/timeline/<slot>.<ext> (four path segments including "scraps").
const MAX_MEDIA_REF_SEGMENTS = 4;
// Source: the optional timeline contract accepts at most 128 ordered media entries.
const MAX_TIMELINE_ITEMS = 128;
// Source: HTTP method not allowed response contract.
const HTTP_METHOD_NOT_ALLOWED = 405;
// Source: HTTP unauthorized response contract.
const HTTP_UNAUTHORIZED = 401;
// Source: HTTP successful read/replay response contract.
const HTTP_OK = 200;
// Source: HTTP invalid input response contract.
const HTTP_BAD_REQUEST = 400;
// Source: HTTP idempotency conflict response contract.
const HTTP_CONFLICT = 409;
// Source: HTTP upstream extraction failure response contract.
const HTTP_EXTRACTION_FAILED = 502;
// Source: HTTP newly created resource response contract.
const HTTP_CREATED = 201;

export interface ScrapsRouteOptions {
  instanceRoot: string;
  /** Must resolve identity from the authenticated server session; body memberId is ignored. */
  resolveOwner: (request: Request) => Promise<{ memberId: string } | null>;
  extractors: AbsorbExtractorAdapters;
  byokCard?: AbsorbCardLlm;
  now?: () => Date;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function memberScopedMediaRef(value: string, memberId: string): string | null {
  const segments = value.split('/');
  const legacyObjectRef = segments.length === 2;
  const slotWithExtension = /^([0-9]{1,3})\.[A-Za-z0-9]{1,8}$/.exec(segments[3] ?? '');
  const timelineObjectRef = segments.length === MAX_MEDIA_REF_SEGMENTS
    && segments[2] === 'timeline'
    && slotWithExtension !== null
    && Number(slotWithExtension[1]) < MAX_TIMELINE_ITEMS;
  if (segments[0] !== 'scraps' || (!legacyObjectRef && !timelineObjectRef)) return null;
  if (segments.slice(1).some((segment) => !MEDIA_ID_PATTERN.test(segment))) return null;
  return `${memberId}/${value}`;
}

function parseScrap(value: unknown, memberId: string, now: string): AbsorbScrapPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!KINDS.includes(input.kind as AbsorbScrapKind) || !SOURCES.includes(input.source as AbsorbScrapPayload['source'])) return null;
  if (!input.raw || typeof input.raw !== 'object' || Array.isArray(input.raw)) return null;
  const candidate = input.raw as Record<string, unknown>;
  const raw: AbsorbScrapPayload['raw'] = {};
  for (const field of ['text', 'url', 'mediaRef', 'mime'] as const) {
    if (candidate[field] !== undefined) {
      if (typeof candidate[field] !== 'string' || candidate[field].length > MAX_SCRAP_FIELD_CHARS) return null;
      raw[field] = candidate[field] as string;
    }
  }
  const kind = input.kind as AbsorbScrapKind;
  const hasContent = kind === 'text' ? Boolean(raw.text?.trim())
    : kind === 'web' || kind === 'x' || kind === 'youtube' ? Boolean(raw.url?.trim())
      : Boolean(raw.mediaRef?.trim());
  if (!hasContent) return null;
  if (raw.url) {
    try { const url = new URL(raw.url); if (!['http:', 'https:'].includes(url.protocol)) return null; }
    catch { return null; }
  }
  if (raw.mediaRef) {
    const scopedMediaRef = memberScopedMediaRef(raw.mediaRef, memberId);
    if (!scopedMediaRef) return null;
    raw.mediaRef = scopedMediaRef;
  }
  if (candidate.timeline !== undefined) {
    if (!Array.isArray(candidate.timeline) || candidate.timeline.length > MAX_TIMELINE_ITEMS) return null;
    const timeline: NonNullable<AbsorbScrapPayload['raw']['timeline']> = [];
    for (const value of candidate.timeline) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const entry = value as Record<string, unknown>;
      if (!Number.isSafeInteger(entry.t) || (entry.t as number) < 0) return null;
      if (entry.kind !== 'voice' && entry.kind !== 'photo' && entry.kind !== 'video') return null;
      if (typeof entry.mediaRef !== 'string' || typeof entry.mime !== 'string') return null;
      const scopedMediaRef = memberScopedMediaRef(entry.mediaRef, memberId);
      if (!scopedMediaRef) return null;
      const expectedMimePrefix = entry.kind === 'voice' ? 'audio/' : entry.kind === 'photo' ? 'image/' : 'video/';
      if (entry.mime.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(entry.mime) || !entry.mime.toLowerCase().startsWith(expectedMimePrefix)) return null;
      timeline.push({ t: entry.t as number, kind: entry.kind, mediaRef: scopedMediaRef, mime: entry.mime });
    }
    raw.timeline = timeline;
  }
  return {
    schema: 'absorb/v0', memberId, kind, source: input.source as AbsorbScrapPayload['source'], raw,
    status: 'new', createdAt: now,
  };
}

/** `POST/GET /v1/scraps`, scoped only to the server-authenticated member. */
export async function handleScraps(req: Request, options: ScrapsRouteOptions): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return json({ error: 'method not allowed' }, HTTP_METHOD_NOT_ALLOWED);
  const owner = await options.resolveOwner(req);
  if (!owner?.memberId) return json({ error: 'unauthorized' }, HTTP_UNAUTHORIZED);
  if (method === 'GET') return json({ scraps: listAbsorbScraps(options.instanceRoot, owner.memberId).map((item) => ({ id: item.id, ...item.absorb })) });
  const idempotencyKey = req.headers.get('idempotency-key')?.trim() ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return json({ error: 'idempotency-key-required' }, HTTP_BAD_REQUEST);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'invalid-json' }, HTTP_BAD_REQUEST); }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const payload = parseScrap(body, owner.memberId, now);
  if (!payload) return json({ error: 'invalid-scrap' }, HTTP_BAD_REQUEST);
  let ingested: ReturnType<typeof ingestAbsorbScrap>;
  try { ingested = ingestAbsorbScrap(options.instanceRoot, payload, idempotencyKey, now); }
  catch (error) {
    if (error instanceof Error && error.message === 'idempotency-conflict') return json({ error: 'idempotency-conflict' }, HTTP_CONFLICT);
    throw error;
  }
  const item = ingested.item;
  if (ingested.replayed) return json({ id: item.id, ...item.absorb }, item.absorb?.status === 'failed' ? HTTP_EXTRACTION_FAILED : HTTP_OK);
  if (item.absorb?.status === 'absorbed') return json({ id: item.id, ...item.absorb }, 200);
  updateAbsorbScrap(options.instanceRoot, item.id, { status: 'extracting' });
  let extracted: AbsorbExtraction | undefined;
  try {
    extracted = await extractAbsorbScrap(payload, options.extractors);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateAbsorbScrap(options.instanceRoot, item.id, { status: 'failed', failure: { stage: 'extract', reason } });
    debug.log('absorb.extract', 'extract-failed', { id: item.id, memberId: owner.memberId, kind: payload.kind, reason });
  }
  if (extracted) {
    try {
      const card = await buildAbsorbSummaryCard(extracted, options.byokCard ? { byok: options.byokCard } : {});
      updateAbsorbScrap(options.instanceRoot, item.id, { status: 'absorbed', card, absorbedAt: (options.now ?? (() => new Date()))().toISOString() });
      debug.log('absorb.card', 'card-built', { id: item.id, memberId: owner.memberId, kind: payload.kind });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateAbsorbScrap(options.instanceRoot, item.id, { status: 'failed', failure: { stage: 'card', reason } });
      debug.log('absorb.card', 'card-failed', { id: item.id, memberId: owner.memberId, kind: payload.kind, reason });
    }
  }
  const result = listAbsorbScraps(options.instanceRoot, owner.memberId).find((scrap) => scrap.id === item.id);
  return json(result ? { id: result.id, ...result.absorb } : { error: 'scrap-not-found' }, result?.absorb?.status === 'failed' ? HTTP_EXTRACTION_FAILED : HTTP_CREATED);
}
