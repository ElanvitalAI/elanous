// 현장(field) 업로드 폴더 계약 — HTTP 입구(`/v1/field/uploads`)와 텔레그램 `#현장` 이 «같은» 저장 함수를 쓴다.
//
// 폴더 계약(2026-09-30 합의 · 소비자 = reel 파이프라인):
//   <configDir>/field/<event>/<ISO 기본형 타임스탬프>-<device>-<원래 이름>
//   타임스탬프 = 클라이언트가 준 촬영 시각(있으면) · 없으면 업로드 시각 · UTC · `20261015T193012Z`(ISO 8601 기본형 —
//   파일 이름에 콜론을 넣지 않으려고 기본형을 쓴다. 사전순 = 시간순).
//   배치가 끝나면 `<folder>/.ready` 를 한 줄(= 폴더의 미디어 파일 수)로 덮어쓴다.

import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FIELD_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const FIELD_MAX_FILE_BYTES = 100 * 1024 * 1024; // 폰 현장 사진·짧은 영상 — 데몬 전역 요청 한도를 과하게 올리지 않으려고 낮게(2026-09-30)
export const FIELD_MAX_REQUEST_BYTES = 250 * 1024 * 1024;
export const FIELD_READY_FILE = '.ready';
const MAX_ORIGINAL_NAME = 80;

/** 허용 MIME → 대표 확장자. heif 는 heic 의 별칭으로 받는다. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
  webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime',
};

export type FieldUploadErrorCode = 'bad-slug' | 'unsupported-media-type' | 'too-large' | 'no-files' | 'bad-request';

export class FieldUploadError extends Error {
  constructor(readonly code: FieldUploadErrorCode, message: string) {
    super(message);
    this.name = 'FieldUploadError';
  }
  get status(): number {
    if (this.code === 'unsupported-media-type') return 415;
    if (this.code === 'too-large') return 413;
    return 400;
  }
}

export interface FieldMediaInput {
  originalName: string;
  mimeType?: string;
  bytes: Uint8Array;
  /** 촬영 시각(ISO 문자열·epoch ms). 못 읽으면 업로드 시각. */
  capturedAt?: string | number | Date;
}

export interface FieldSaveOptions {
  /** config 뿌리(`~/.elanous` 또는 격리 뿌리). 폴더 = `<rootDir>/field/<event>`. */
  rootDir: string;
  event: string;
  device: string;
  now?: () => Date;
  /** 사람이 쓴 한 줄(텔레그램 캡션·앱 입력칸) — 있으면 `captions.txt` 에 «<첫 파일 이름> | <글>» 로 덧붙인다(reel 자막 · MK 2026-09-30). */
  caption?: string;
}

export interface FieldSaveResult {
  event: string;
  dir: string;
  saved: Array<{ name: string; bytes: number }>;
  /** 저장 «후» 폴더의 미디어 파일 수(= `.ready` 에 쓴 값). */
  count: number;
}

export function isFieldSlug(value: unknown): value is string {
  return typeof value === 'string' && FIELD_SLUG_RE.test(value);
}

export function fieldEventDir(rootDir: string, event: string): string {
  if (!isFieldSlug(event)) throw new FieldUploadError('bad-slug', 'event slug must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  return join(rootDir, 'field', event);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 허용 MIME 이면 정규화한 MIME, 아니면 null. MIME 이 비었거나 octet-stream 이면 확장자로 추정한다. */
export function resolveFieldMime(mimeType: string | undefined, originalName: string): string | null {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream') return MIME_EXT[mime] ? mime : null;
  return EXT_MIME[extOf(originalName)] ?? null;
}

/** basename · `[A-Za-z0-9._-]` 외는 `_` · 앞 점 제거 · 최대 80자(확장자 보존) · 확장자가 MIME 과 안 맞으면 붙인다. */
export function sanitizeFieldName(originalName: string, mime?: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? '';
  let name = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^\.+/, '');
  const wantExt = mime ? MIME_EXT[mime] : undefined;
  const ext = extOf(name);
  if (wantExt && EXT_MIME[ext] === undefined) name = name ? `${name}.${wantExt}` : `media.${wantExt}`;
  if (!name) name = 'media';
  if (name.length > MAX_ORIGINAL_NAME) {
    const e = extOf(name);
    const suffix = e && e.length < 10 ? `.${e}` : '';
    name = name.slice(0, MAX_ORIGINAL_NAME - suffix.length) + suffix;
  }
  return name;
}

/** `20261015T193012Z` — ISO 8601 기본형 UTC(초 단위). */
export function fieldTimestamp(capturedAt: FieldMediaInput['capturedAt'], now: Date): string {
  let at: Date | null = null;
  if (capturedAt instanceof Date) at = capturedAt;
  else if (typeof capturedAt === 'number') at = new Date(capturedAt);
  else if (typeof capturedAt === 'string' && capturedAt.trim()) {
    const trimmed = capturedAt.trim();
    at = /^\d{10,13}$/.test(trimmed) ? new Date(Number(trimmed) * (trimmed.length === 10 ? 1000 : 1)) : new Date(trimmed);
  }
  if (!at || Number.isNaN(at.getTime())) at = now;
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function isMediaFile(name: string): boolean {
  return !name.startsWith('.') && EXT_MIME[extOf(name)] !== undefined;
}

export function listFieldMedia(dir: string): Array<{ name: string; bytes: number }> {
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: Array<{ name: string; bytes: number }> = [];
  for (const name of names.sort()) {
    if (!isMediaFile(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.push({ name, bytes: st.size });
    } catch { /* 사이에 지워졌다 */ }
  }
  return out;
}

function atomicWrite(dir: string, name: string, bytes: Uint8Array | string): void {
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(dir, name));
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 없음 */ }
    throw error;
  }
}

/** `.ready` 를 «지금» 폴더의 미디어 파일 수로 덮어쓴다. */
export function refreshFieldReady(dir: string): number {
  const count = listFieldMedia(dir).length;
  atomicWrite(dir, FIELD_READY_FILE, `${count}\n`);
  return count;
}

/** 검증(전부) → 쓰기(전부, 원자적) → `.ready` 갱신. 하나라도 검증에 걸리면 아무것도 안 쓴다. */
export function saveFieldMedia(inputs: FieldMediaInput[], opts: FieldSaveOptions): FieldSaveResult {
  const dir = fieldEventDir(opts.rootDir, opts.event);
  if (!isFieldSlug(opts.device)) throw new FieldUploadError('bad-slug', 'device slug must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  if (inputs.length === 0) throw new FieldUploadError('no-files', 'at least one file is required');
  const now = (opts.now ?? (() => new Date()))();
  let total = 0;
  const planned = inputs.map((input) => {
    const mime = resolveFieldMime(input.mimeType, input.originalName);
    if (!mime) throw new FieldUploadError('unsupported-media-type', 'only jpeg/png/heic/webp images and mp4/mov videos are accepted');
    const size = input.bytes.byteLength;
    if (size === 0) throw new FieldUploadError('bad-request', 'empty file');
    if (size > FIELD_MAX_FILE_BYTES) throw new FieldUploadError('too-large', 'a file exceeds 100 MB');
    total += size;
    if (total > FIELD_MAX_REQUEST_BYTES) throw new FieldUploadError('too-large', 'the request exceeds 250 MB');
    const name = `${fieldTimestamp(input.capturedAt, now)}-${opts.device}-${sanitizeFieldName(input.originalName, mime)}`;
    return { name, bytes: input.bytes };
  });

  mkdirSync(dir, { recursive: true });
  const taken = new Set<string>();
  const saved: FieldSaveResult['saved'] = [];
  for (const item of planned) {
    const name = uniqueName(dir, item.name, item.bytes.byteLength, taken);
    taken.add(name);
    atomicWrite(dir, name, item.bytes);
    saved.push({ name, bytes: item.bytes.byteLength });
  }
  const line = normalizeFieldCaption(opts.caption);
  if (line && saved[0]) appendFileSync(join(dir, FIELD_CAPTIONS_FILE), `${saved[0].name} | ${line}\n`);
  const count = refreshFieldReady(dir);
  return { event: opts.event, dir, saved, count };
}

/** 같은 이름·같은 크기면 재전송으로 보고 덮는다(중복 방지). 크기가 다르면 `-1`,`-2`… 를 붙인다. */
function uniqueName(dir: string, name: string, size: number, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; ; i += 1) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`;
    if (taken.has(candidate)) continue;
    let existing: number | null = null;
    try { existing = statSync(join(dir, candidate)).size; } catch { existing = null; }
    if (existing === null || existing === size) return candidate;
  }
}

// ── 텔레그램 캡션 문법 ──────────────────────────────────────────────

export const FIELD_CAPTION_TAG = '#현장';

/** 캡션에 독립 토큰 `#현장` 이 있으면 `{ event? }`, 없으면 null.
 *  `#현장 <slug>` — 바로 다음 토큰을 소문자로 바꿔 슬러그 규칙에 맞으면 행사 이름, 아니면 기본 행사. */
export function parseFieldCaption(caption: string | undefined | null): { event?: string; text?: string } | null {
  if (!caption) return null;
  const tokens = caption.trim().split(/\s+/);
  const at = tokens.indexOf(FIELD_CAPTION_TAG);
  if (at < 0) return null;
  const next = tokens[at + 1]?.toLowerCase();
  const hasEvent = !!next && isFieldSlug(next);
  // 태그·행사 이름을 뺀 나머지가 «글»(자막) — 태그 앞에 쓴 글도 같이.
  const rest = tokens.filter((_, i) => i !== at && !(hasEvent && i === at + 1)).join(' ');
  const text = normalizeFieldCaption(rest);
  return { ...(hasEvent ? { event: next } : {}), ...(text ? { text } : {}) };
}

export const FIELD_CAPTIONS_FILE = 'captions.txt';

/** 자막 한 줄 — 줄바꿈은 공백으로, `|` 는 구분자라 전각 `｜` 로, 280자까지. 비면 빈 값. */
export function normalizeFieldCaption(value: string | undefined | null): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim().slice(0, 280);
}

/** 기본 행사 = 유효한 config 값 · 없으면 `field-<로컬 YYYY-MM-DD>`. */
export function defaultFieldEvent(configured: string | undefined, now: Date = new Date()): string {
  if (configured && isFieldSlug(configured)) return configured;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `field-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
