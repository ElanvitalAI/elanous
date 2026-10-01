// 현장 업로드 입구 — POST/GET /v1/field/uploads (owner 전용).
// 저장 규칙은 src/field/field-media.ts 가 유일한 정본이고 텔레그램 `#현장` 도 같은 함수를 쓴다.

import { debug } from '../../debug/log.js';
import { readFieldReelStatus, scheduleFieldReel, fieldReelFile, hasFieldReelFile, type FieldReelOptions } from '../../field/field-reel.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import {
  FIELD_MAX_FILE_BYTES,
  FIELD_MAX_REQUEST_BYTES,
  FieldUploadError,
  defaultFieldEvent,
  fieldEventDir,
  isFieldSlug,
  listFieldMedia,
  saveFieldMedia,
  type FieldMediaInput,
} from '../../field/field-media.js';
import { jsonResponse } from './json-response.js';

export const FIELD_UPLOADS_PATH = '/v1/field/uploads';
export const FIELD_REEL_PATH = '/v1/field/reel';
export const FIELD_REEL_FILE_PATH = '/v1/field/reel/file';
const reelUrl = (event: string) => `${FIELD_REEL_FILE_PATH}?event=${encodeURIComponent(event)}`;

/** 멀티파트 경계·헤더 여유. */
const MULTIPART_SLACK_BYTES = 4 * 1024 * 1024;
/** JSON 본문은 base64(×4/3) 라 더 크다. */
const JSON_MAX_BODY_BYTES = Math.ceil((FIELD_MAX_REQUEST_BYTES * 4) / 3) + MULTIPART_SLACK_BYTES;
/** Bun.serve 의 `maxRequestBodySize`(기본 128 MB) — 이 입구의 JSON 상한까지 받도록 서버가 이 값을 쓴다. */
export const FIELD_SERVER_MAX_BODY_BYTES = JSON_MAX_BODY_BYTES;

interface FieldUploadsDeps {
  authorize?: (request: Request) => boolean;
  /** config 뿌리 — 기본 `getElanousConfigDir()`(데몬의 다른 저장소와 같은 해석). 시험은 temp 를 준다. */
  rootDir?: () => string;
  now?: () => Date;
  reel?: FieldReelOptions;
  /** 설정 `telegram.fieldDefaultEvent` — 앱이 «오늘» 행사 칸의 기본값으로 받는다(비면 field-<날짜>). */
  configuredEvent?: () => string | undefined;
}

function errorResponse(error: FieldUploadError): Response {
  return jsonResponse({ ok: false, error: error.code, reason: error.message }, error.status);
}

function parseCapturedAtList(values: FormDataEntryValue[]): Array<string | undefined> {
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (strings.length === 1 && strings[0]!.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(strings[0]!) as unknown;
      if (Array.isArray(arr)) return arr.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined));
    } catch { /* 배열이 아니면 단일 값으로 */ }
  }
  return strings;
}

async function readMultipart(req: Request): Promise<FieldMediaInput[]> {
  let form: FormData;
  try { form = await req.formData(); }
  catch { throw new FieldUploadError('bad-request', 'invalid multipart body'); }
  const files = form.getAll('file').filter((v): v is File => typeof v !== 'string');
  const captured = parseCapturedAtList(form.getAll('capturedAt'));
  const captions = form.getAll('caption').filter((v): v is string => typeof v === 'string');
  let total = 0;
  const inputs: FieldMediaInput[] = [];
  for (const [i, file] of files.entries()) {
    if (file.size > FIELD_MAX_FILE_BYTES) throw new FieldUploadError('too-large', 'a file exceeds 100 MB');
    total += file.size;
    if (total > FIELD_MAX_REQUEST_BYTES) throw new FieldUploadError('too-large', 'the request exceeds 250 MB');
    inputs.push({
      originalName: file.name || 'media',
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      ...(captured[i] ? { capturedAt: captured[i] } : {}),
      ...((captions.length === 1 ? i === 0 : i < captions.length) ? { caption: captions[i] } : {}),
    });
  }
  return inputs;
}

async function readJson(req: Request): Promise<FieldMediaInput[]> {
  let body: unknown;
  try { body = await req.json(); }
  catch { throw new FieldUploadError('bad-request', 'JSON body required'); }
  const files = body && typeof body === 'object' && !Array.isArray(body) ? (body as { files?: unknown }).files : undefined;
  if (!Array.isArray(files)) throw new FieldUploadError('bad-request', 'files[] required');
  return files.map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (typeof f.name !== 'string' || typeof f.dataBase64 !== 'string') {
      throw new FieldUploadError('bad-request', 'each file needs name and dataBase64');
    }
    // base64 길이로 먼저 거른다 — 파일 상한(FIELD_MAX_FILE_BYTES)을 넘는 것을 디코드하지 않는다.
    if (Math.floor((f.dataBase64.length * 3) / 4) > FIELD_MAX_FILE_BYTES + 3) {
      throw new FieldUploadError('too-large', 'a file exceeds 100 MB');
    }
    const capturedAt = typeof f.capturedAt === 'string' || typeof f.capturedAt === 'number' ? f.capturedAt : undefined;
    return {
      originalName: f.name,
      ...(typeof f.mimeType === 'string' ? { mimeType: f.mimeType } : {}),
      bytes: new Uint8Array(Buffer.from(f.dataBase64, 'base64')),
      ...(capturedAt !== undefined ? { capturedAt } : {}),
      ...(typeof f.caption === 'string' ? { caption: f.caption } : {}),
    };
  });
}

export async function handleFieldUploads(req: Request, deps: FieldUploadsDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  if (![FIELD_UPLOADS_PATH, FIELD_REEL_PATH, FIELD_REEL_FILE_PATH].includes(url.pathname)) return jsonResponse({ error: 'not-found' }, 404);
  if (!deps.authorize?.(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  const rootDir = (deps.rootDir ?? getElanousConfigDir)();
  const event = url.searchParams.get('event') ?? '';
  // event 없는 GET = 기본 행사 이름만(앱 «오늘» 행사 칸 · 텔레그램 `#현장` 과 같은 기본).
  if (req.method === 'GET' && !url.searchParams.has('event')) {
    const defaultEvent = defaultFieldEvent((deps.configuredEvent ?? (() => undefined))(), (deps.now ?? (() => new Date()))());
    return jsonResponse({ defaultEvent });
  }
  if (!isFieldSlug(event)) return errorResponse(new FieldUploadError('bad-slug', 'event slug must match ^[a-z0-9][a-z0-9._-]{0,63}$'));

  const dir = fieldEventDir(rootDir, event);
  if (url.pathname !== FIELD_UPLOADS_PATH && req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
  if (url.pathname === FIELD_REEL_PATH) {
    const status = readFieldReelStatus(dir);
    if (!status) return jsonResponse({ error: 'not-found' }, 404);
    return jsonResponse({ event, state: status.state, items: status.items,
      ...(status.seconds !== undefined ? { seconds: status.seconds } : {}),
      ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}),
      ...(status.state === 'failed' && status.error ? { error: status.error } : {}),
      ...(status.state === 'done' && hasFieldReelFile(fieldReelFile(dir)) ? { url: reelUrl(event) } : {}) });
  }
  if (url.pathname === FIELD_REEL_FILE_PATH) {
    const status = readFieldReelStatus(dir);
    const file = fieldReelFile(dir);
    if (status?.state !== 'done' || !hasFieldReelFile(file)) return jsonResponse({ error: 'not-found' }, 404);
    return new Response(Bun.file(file), { headers: { 'content-type': 'video/mp4' } });
  }
  if (req.method === 'GET') {
    const files = listFieldMedia(dir);
    const status = readFieldReelStatus(dir);
    debug.log('field.upload', 'listed', { count: files.length });
    return jsonResponse({ event, count: files.length, files,
      ...(status ? { reel: { status: status.state, updatedAt: status.updatedAt,
        ...(status.state === 'done' && hasFieldReelFile(fieldReelFile(dir)) ? { url: reelUrl(event) } : {}) } } : {}) });
  }
  if (req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);

  const device = url.searchParams.get('device') ?? '';
  if (!isFieldSlug(device)) return errorResponse(new FieldUploadError('bad-slug', 'device slug must match ^[a-z0-9][a-z0-9._-]{0,63}$'));

  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  const isMultipart = contentType.startsWith('multipart/form-data');
  const isJson = contentType.startsWith('application/json');
  if (!isMultipart && !isJson) {
    return errorResponse(new FieldUploadError('unsupported-media-type', 'use multipart/form-data or application/json'));
  }
  const declared = Number(req.headers.get('content-length') ?? '');
  const bodyCap = isJson ? JSON_MAX_BODY_BYTES : FIELD_MAX_REQUEST_BYTES + MULTIPART_SLACK_BYTES;
  if (Number.isFinite(declared) && declared > bodyCap) {
    debug.log('field.upload', 'refused', { reason: 'too-large', declaredBytes: declared });
    return errorResponse(new FieldUploadError('too-large', 'the request exceeds 250 MB'));
  }

  try {
    const inputs = isMultipart ? await readMultipart(req) : await readJson(req);
    const caption = url.searchParams.get('caption') ?? undefined;
    const result = saveFieldMedia(inputs, { rootDir, event, device, ...(caption ? { caption } : {}), ...(deps.now ? { now: deps.now } : {}) });
    debug.log('field.upload', 'saved', {
      surface: 'http', files: result.saved.length, bytes: result.saved.reduce((n, s) => n + s.bytes, 0), count: result.count,
    });
    scheduleFieldReel(result.dir, deps.reel);
    return jsonResponse({ ok: true, event, saved: result.saved, count: result.count });
  } catch (error) {
    if (error instanceof FieldUploadError) {
      debug.log('field.upload', 'refused', { surface: 'http', reason: error.code });
      return errorResponse(error);
    }
    debug.log('field.upload', 'failed', { surface: 'http' });
    throw error;
  }
}
