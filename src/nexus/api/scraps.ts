import { debug } from '../../debug/log.js';
import { buildAbsorbSummaryCard, extractAbsorbScrap, type AbsorbCardLlm, type AbsorbExtraction, type AbsorbExtractorAdapters } from '../../intake-plane/absorb-extract.js';
import { ingestAbsorbScrap, listAbsorbScraps, updateAbsorbScrap, type AbsorbScrapKind, type AbsorbScrapPayload } from '../../intake-plane/items.js';
import { createScrapFolder, findScrapFolder, listScrapFolders, updateScrapFolder, validScrapFolderName } from './scrap-folders.js';
import { handleVoiceNoteExport } from './scrap-export.js';

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
/** Live extraction claims for this server process; a restart leaves only the durable ledger. */
const processingScraps = new Set<string>();

export interface ScrapsRouteOptions {
  instanceRoot: string;
  /** Must resolve identity from the authenticated server session; body memberId is ignored. */
  resolveOwner: (request: Request) => Promise<{ memberId: string } | null>;
  extractors: AbsorbExtractorAdapters;
  byokCard?: AbsorbCardLlm;
  now?: () => Date;
  writeVaultFile?: (input: { path: string; content: string; createOnly: boolean }) => Promise<Response>;
  readVaultFile?: (path: string) => Promise<Response>;
  /** Notify durable follow-up requests after the absorb ledger reaches a terminal state. */
  onSettled?: (memberId: string, scrapId: string) => Promise<void>;
  /** Durable acceptance hook, before extraction; used by a connected Telegram DM receipt. */
  onAccepted?: (memberId: string, scrapId: string) => Promise<void>;
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

function recordingDate(instant: unknown, timeZone: unknown): string | null {
  if (typeof instant !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)) return null;
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== instant || typeof timeZone !== 'string') return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return null; }
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseScrap(value: unknown, memberId: string, now: string): AbsorbScrapPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!KINDS.includes(input.kind as AbsorbScrapKind) || !SOURCES.includes(input.source as AbsorbScrapPayload['source'])) return null;
  if (!input.raw || typeof input.raw !== 'object' || Array.isArray(input.raw)) return null;
  const candidate = input.raw as Record<string, unknown>;
  const raw: AbsorbScrapPayload['raw'] = {};
  for (const field of ['text', 'transcript', 'url', 'mediaRef', 'mime'] as const) {
    if (candidate[field] !== undefined) {
      if (typeof candidate[field] !== 'string' || candidate[field].length > MAX_SCRAP_FIELD_CHARS) return null;
      raw[field] = candidate[field] as string;
    }
  }
  const kind = input.kind as AbsorbScrapKind;
  if (raw.transcript !== undefined && (kind !== 'voice' || !raw.transcript.trim())) return null;
  if (input.folderId !== undefined && input.folderId !== null && typeof input.folderId !== 'string') return null;
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
      if (entry.kind === 'marker') {
        if (kind !== 'voice' || typeof entry.label !== 'string' || !entry.label.trim()
          || entry.label.length > 80 || /[\\/\x00-\x1f\x7f]/.test(entry.label)
          || entry.mediaRef !== undefined || entry.mime !== undefined) return null;
        timeline.push({ t: entry.t as number, kind: 'marker', label: entry.label });
        continue;
      }
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
  if (candidate.recordedAt !== undefined || candidate.recordedTimeZone !== undefined) {
    if (kind !== 'voice') return null;
    const day = recordingDate(candidate.recordedAt, candidate.recordedTimeZone);
    if (!day) return null;
    raw.recordedAt = candidate.recordedAt as string;
    raw.recordedTimeZone = candidate.recordedTimeZone as string;
    raw.recordedDate = day;
  }
  if (candidate.classDate !== undefined) {
    if (kind !== 'voice' || !validCalendarDate(candidate.classDate)) return null;
    raw.classDate = candidate.classDate;
  }
  return {
    schema: 'absorb/v0', memberId, kind, source: input.source as AbsorbScrapPayload['source'], raw,
    ...(input.folderId !== undefined ? { folderId: input.folderId as string | null } : {}),
    status: 'new', createdAt: now,
  };
}

async function withScrapFlight(instanceRoot: string, id: string, work: () => Promise<Response>): Promise<Response> {
  const claim = JSON.stringify([instanceRoot, id]);
  if (processingScraps.has(claim)) return json({ error: 'scrap-extracting' }, HTTP_CONFLICT);
  processingScraps.add(claim);
  try { return await work(); }
  finally { processingScraps.delete(claim); }
}

async function processClaimedScrap(id: string, payload: AbsorbScrapPayload, options: ScrapsRouteOptions, successStatus: number): Promise<Response> {
  updateAbsorbScrap(options.instanceRoot, id, { status: 'extracting', failure: undefined });
  let extracted: AbsorbExtraction | undefined;
  try { extracted = await extractAbsorbScrap(payload, options.extractors); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateAbsorbScrap(options.instanceRoot, id, { status: 'failed', failure: { stage: 'extract', reason } });
    debug.log('absorb.extract', 'extract-failed', { id, memberId: payload.memberId, kind: payload.kind, reason });
  }
  if (extracted) {
    try {
      const card = await buildAbsorbSummaryCard(extracted, options.byokCard ? { byok: options.byokCard } : {});
      updateAbsorbScrap(options.instanceRoot, id, { status: 'absorbed', card, failure: undefined,
        extractedBody: extracted.body.slice(0, MAX_SCRAP_FIELD_CHARS),
        absorbedAt: (options.now ?? (() => new Date()))().toISOString() });
      debug.log('absorb.card', 'card-built', { id, memberId: payload.memberId, kind: payload.kind });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateAbsorbScrap(options.instanceRoot, id, { status: 'failed', failure: { stage: 'card', reason } });
      debug.log('absorb.card', 'card-failed', { id, memberId: payload.memberId, kind: payload.kind, reason });
    }
  }
  const result = listAbsorbScraps(options.instanceRoot, payload.memberId).find((scrap) => scrap.id === id);
  if (result?.absorb?.status === 'absorbed' || result?.absorb?.status === 'failed') await options.onSettled?.(payload.memberId, id);
  return json(result ? { id: result.id, ...result.absorb } : { error: 'scrap-not-found' }, result?.absorb?.status === 'failed' ? HTTP_EXTRACTION_FAILED : successStatus);
}

/** `POST/GET /v1/scraps`, scoped only to the server-authenticated member. */
export async function handleScraps(req: Request, options: ScrapsRouteOptions): Promise<Response> {
  const method = req.method.toUpperCase();
  const owner = await options.resolveOwner(req);
  if (!owner?.memberId) return json({ error: 'unauthorized' }, HTTP_UNAUTHORIZED);
  const pathname = new URL(req.url).pathname;
  if (pathname === '/v1/scrap-folders') {
    if (method === 'GET') return json({ folders: listScrapFolders(options.instanceRoot, owner.memberId) });
    if (method !== 'POST') return json({ error: 'method not allowed' }, HTTP_METHOD_NOT_ALLOWED);
    let input: { name?: unknown; parentId?: unknown };
    try { input = await req.json() as typeof input; } catch { return json({ error: 'invalid-json' }, HTTP_BAD_REQUEST); }
    if (!validScrapFolderName(input?.name) || (input.parentId !== undefined && input.parentId !== null && typeof input.parentId !== 'string')) {
      return json({ error: 'invalid-folder' }, HTTP_BAD_REQUEST);
    }
    const parentId = typeof input.parentId === 'string' ? input.parentId : null;
    if (parentId && !findScrapFolder(options.instanceRoot, owner.memberId, parentId)) return json({ error: 'folder-not-found' }, 404);
    return json(createScrapFolder(options.instanceRoot, owner.memberId, input.name, parentId,
      (options.now ?? (() => new Date()))().toISOString()), HTTP_CREATED);
  }
  const folderAction = /^\/v1\/scrap-folders\/([a-f0-9-]{36})$/.exec(pathname);
  if (folderAction) {
    if (method !== 'PATCH') return json({ error: 'method not allowed' }, HTTP_METHOD_NOT_ALLOWED);
    const current = findScrapFolder(options.instanceRoot, owner.memberId, folderAction[1]!);
    if (!current) return json({ error: 'folder-not-found' }, 404);
    let input: { name?: unknown; parentId?: unknown };
    try { input = await req.json() as typeof input; } catch { return json({ error: 'invalid-json' }, HTTP_BAD_REQUEST); }
    if (!input || (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'parentId'))
      || (input.name !== undefined && !validScrapFolderName(input.name))
      || (input.parentId !== undefined && input.parentId !== null && typeof input.parentId !== 'string')) {
      return json({ error: 'invalid-folder' }, HTTP_BAD_REQUEST);
    }
    const parentId = input.parentId === undefined ? current.parentId : input.parentId as string | null;
    const folders = listScrapFolders(options.instanceRoot, owner.memberId);
    let ancestor = parentId;
    while (ancestor) {
      if (ancestor === current.id) return json({ error: 'folder-cycle' }, HTTP_BAD_REQUEST);
      const parent = folders.find((folder) => folder.id === ancestor);
      if (!parent) return json({ error: 'folder-not-found' }, 404);
      ancestor = parent.parentId;
    }
    return json(updateScrapFolder(options.instanceRoot, current, {
      name: input.name === undefined ? current.name : input.name as string, parentId,
    }));
  }
  const action = /^\/v1\/scraps\/([a-f0-9]{16})\/(folder|class-date|export|retry)$/.exec(pathname);
  if (action) {
    const id = action[1]!;
    if (action[2] === 'export') return handleVoiceNoteExport(req, {
      instanceRoot: options.instanceRoot, memberId: owner.memberId, id, now: options.now,
      writeVaultFile: options.writeVaultFile, readVaultFile: options.readVaultFile,
    });
    const item = listAbsorbScraps(options.instanceRoot, owner.memberId).find((candidate) => candidate.id === id);
    if (!item?.absorb) return json({ error: 'scrap-not-found' }, 404);
    if (action[2] === 'retry') {
      if (method !== 'POST') return json({ error: 'method not allowed' }, HTTP_METHOD_NOT_ALLOWED);
      return withScrapFlight(options.instanceRoot, id, async () => {
        const current = listAbsorbScraps(options.instanceRoot, owner.memberId).find((candidate) => candidate.id === id);
        if (!current?.absorb) return json({ error: 'scrap-not-found' }, 404);
        if (current.absorb.status === 'absorbed') {
          await options.onSettled?.(owner.memberId, id);
          return json({ id, ...current.absorb }, HTTP_OK);
        }
        if (!['new', 'extracting', 'failed'].includes(current.absorb.status)) return json({ error: 'scrap-not-retryable' }, HTTP_CONFLICT);
        return processClaimedScrap(id, current.absorb, options, HTTP_OK);
      });
    }
    if (method !== 'PATCH') return json({ error: 'method not allowed' }, HTTP_METHOD_NOT_ALLOWED);
    if (action[2] === 'folder') {
      let input: { folderId?: unknown };
      try { input = await req.json() as typeof input; } catch { return json({ error: 'invalid-json' }, HTTP_BAD_REQUEST); }
      if (!input || !Object.hasOwn(input, 'folderId') || (input.folderId !== null && typeof input.folderId !== 'string')) {
        return json({ error: 'invalid-folder' }, HTTP_BAD_REQUEST);
      }
      if (typeof input.folderId === 'string' && !findScrapFolder(options.instanceRoot, owner.memberId, input.folderId)) {
        return json({ error: 'folder-not-found' }, 404);
      }
      updateAbsorbScrap(options.instanceRoot, id, { folderId: input.folderId as string | null });
      return json({ id, ...item.absorb, folderId: input.folderId });
    }
    if (item.absorb.kind !== 'voice') return json({ error: 'not-voice-note' }, HTTP_CONFLICT);
    let input: { classDate?: unknown };
    try { input = await req.json() as typeof input; } catch { return json({ error: 'invalid-json' }, HTTP_BAD_REQUEST); }
    if (!validCalendarDate(input?.classDate)) return json({ error: 'invalid-class-date' }, HTTP_BAD_REQUEST);
    const raw = { ...item.absorb.raw, classDate: input.classDate };
    updateAbsorbScrap(options.instanceRoot, id, { raw });
    return json({ id, ...item.absorb, raw });
  }
  if (pathname !== '/v1/scraps') return json({ error: 'not-found' }, 404);
  if (method !== 'GET' && method !== 'POST') return json({ error: 'method not allowed' }, HTTP_METHOD_NOT_ALLOWED);
  if (method === 'GET') return json({ scraps: listAbsorbScraps(options.instanceRoot, owner.memberId).map((item) => ({ id: item.id, ...item.absorb })) });
  const idempotencyKey = req.headers.get('idempotency-key')?.trim() ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return json({ error: 'idempotency-key-required' }, HTTP_BAD_REQUEST);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: 'invalid-json' }, HTTP_BAD_REQUEST); }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const payload = parseScrap(body, owner.memberId, now);
  if (!payload) return json({ error: 'invalid-scrap' }, HTTP_BAD_REQUEST);
  if (payload.folderId !== undefined && payload.folderId !== null
    && !findScrapFolder(options.instanceRoot, owner.memberId, payload.folderId)) return json({ error: 'folder-not-found' }, 404);
  let ingested: ReturnType<typeof ingestAbsorbScrap>;
  try { ingested = ingestAbsorbScrap(options.instanceRoot, payload, idempotencyKey, now); }
  catch (error) {
    if (error instanceof Error && error.message === 'idempotency-conflict') return json({ error: 'idempotency-conflict' }, HTTP_CONFLICT);
    throw error;
  }
  const item = ingested.item;
  return withScrapFlight(options.instanceRoot, item.id, async () => {
    if (options.onAccepted) {
      try { await options.onAccepted(owner.memberId, item.id); }
      catch { debug.log('absorb.accept', 'receipt-delivery-failed', { id: item.id, memberId: owner.memberId }); }
    }
    // The receipt hook can be slow; decide from the latest ledger while holding the same flight.
    const current = listAbsorbScraps(options.instanceRoot, owner.memberId).find((candidate) => candidate.id === item.id);
    if (!current?.absorb) return json({ error: 'scrap-not-found' }, 404);
    if (current.absorb.status === 'absorbed' || (ingested.replayed && current.absorb.status === 'failed')) {
      await options.onSettled?.(owner.memberId, item.id);
      return json({ id: item.id, ...current.absorb }, current.absorb.status === 'failed' ? HTTP_EXTRACTION_FAILED : HTTP_OK);
    }
    return processClaimedScrap(item.id, current.absorb, options, ingested.replayed ? HTTP_OK : HTTP_CREATED);
  });
}
