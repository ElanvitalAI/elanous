// SC1 — 앱 안 «공유용 캡처»(beta) 받는 쪽. PWA 가 화면을 가린 뒤 PNG 로 올린다(티저·현장·보고용).
// POST /v1/captures          body = image/png(≤ 8 MiB) → { id, bytes, droppedChunks }
// GET  /v1/captures          → { items: [{ id, bytes, at }] } (최신 먼저 · 50개)
// GET  /v1/captures/<id>     → image/png
// ⛔ 두 번째 방어: 받은 PNG 에서 «그림 아닌» 덩어리(tEXt·iTXt·zTXt·eXIf·iCCP·tIME 등 메타)를 전부 걷고 저장한다 —
//    화면 쪽 가림이 놓친 것이 파일 메타로 새지 않게. 남기는 것은 그림을 그리는 데 필요한 덩어리뿐이다.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

export const SHARE_CAPTURES_PATH = '/v1/captures';
const MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks needed to draw the picture. Everything else (text, EXIF, ICC profile, time…) is dropped. */
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'pHYs']);
const ID = /^share-\d{8}-\d{6}-[0-9a-f]{6}$/;

export interface ShareCapturesDeps { configDir?: string; now?: () => Date }

/** Rebuild a PNG with only drawing chunks. Returns null when it is not a well-formed PNG. */
export function stripPngMetadata(input: Uint8Array): { png: Buffer; dropped: string[] } | null {
  const buf = Buffer.from(input);
  if (buf.length < 8 + 12 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const parts: Buffer[] = [PNG_SIGNATURE];
  const dropped: string[] = [];
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;
    if (end > buf.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (!sawHeader && type !== 'IHDR') return null;
    sawHeader = true;
    if (KEEP.has(type)) parts.push(buf.subarray(offset, end)); else dropped.push(type);
    offset = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) return null;
  return { png: Buffer.concat(parts), dropped };
}

function capturesDir(deps: ShareCapturesDeps): string {
  return join(deps.configDir ?? getElanousConfigDir(), 'captures');
}

function newId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `share-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomBytes(3).toString('hex')}`;
}

export async function handleShareCaptures(req: Request, metaApi: MetaApiOpts, deps: ShareCapturesDeps = {}): Promise<Response> {
  if (!checkAuth(req, metaApi)) return jsonResponse({ error: 'unauthorized' }, 401);
  const pathname = new URL(req.url).pathname;
  const dir = capturesDir(deps);

  if (pathname === SHARE_CAPTURES_PATH && req.method === 'POST') {
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return jsonResponse({ error: 'too-large', maxBytes: MAX_BYTES }, 413);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > MAX_BYTES) return jsonResponse({ error: 'too-large', maxBytes: MAX_BYTES }, 413);
    const cleaned = stripPngMetadata(body);
    if (!cleaned) return jsonResponse({ error: 'not-png' }, 400);
    const id = newId((deps.now ?? (() => new Date()))());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.png`), cleaned.png, { mode: 0o600, flag: 'wx' });
    debug.log('share-capture', 'stored', { id, bytes: cleaned.png.length, dropped: cleaned.dropped });
    return jsonResponse({ id, bytes: cleaned.png.length, droppedChunks: cleaned.dropped }, 201);
  }

  if (pathname === SHARE_CAPTURES_PATH && req.method === 'GET') {
    const items = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.png') && ID.test(f.slice(0, -4))).sort().reverse().slice(0, 50)
        .map((f) => { const s = statSync(join(dir, f)); return { id: f.slice(0, -4), bytes: s.size, at: s.mtime.toISOString() }; })
      : [];
    return jsonResponse({ items });
  }

  const id = pathname.slice(SHARE_CAPTURES_PATH.length + 1);
  if (req.method === 'GET' && ID.test(id)) {
    const file = join(dir, `${id}.png`);
    if (!existsSync(file)) return jsonResponse({ error: 'not-found' }, 404);
    return new Response(readFileSync(file), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  }
  return jsonResponse({ error: 'not-found' }, 404);
}
