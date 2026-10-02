// SC1 반증 시험(받는 쪽) — PNG 메타(tEXt·iTXt·zTXt·eXIf·tIME)에 심은 주소·토큰이 저장 파일에 남지 않는다.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { handleShareCaptures, stripPngMetadata } from './share-captures.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const meta = { bearerToken: 'owner-secret', noAuth: false };

const TOKEN = 'elt_FAKEinPNGmetadata1234567890';
const ADDRESS = 'user-mbp.tail1a2b3c.ts.net';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real 1×1 RGBA PNG carrying the planted values in every metadata chunk kind. */
function pngWithMetadata(): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0token ${TOKEN}`, 'latin1')),
    chunk('iTXt', Buffer.from(`Source\0\0\0\0\0https://${ADDRESS}/app/`, 'utf8')),
    chunk('zTXt', Buffer.concat([Buffer.from('Note\0\0', 'latin1'), deflateSync(Buffer.from(ADDRESS))])),
    chunk('eXIf', Buffer.from(`MM\0*${TOKEN}`, 'latin1')),
    chunk('tIME', Buffer.from([7, 234, 10, 2, 3, 0, 0])),
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const req = (path: string, method = 'GET', body?: Uint8Array, auth = true) => new Request(`http://localhost${path}`, {
  method, headers: { ...(auth ? { authorization: 'Bearer owner-secret' } : {}), 'sec-fetch-site': 'cross-site', 'content-type': 'image/png' },
  ...(body ? { body: Buffer.from(body) as unknown as BodyInit } : {}),
});

test('stripPngMetadata keeps only drawing chunks; malformed input is refused', () => {
  const cleaned = stripPngMetadata(pngWithMetadata())!;
  expect(cleaned.dropped.sort()).toEqual(['eXIf', 'iTXt', 'tEXt', 'tIME', 'zTXt']);
  const text = cleaned.png.toString('latin1');
  for (const type of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']) expect(text).not.toContain(type);
  for (const type of ['IHDR', 'sRGB', 'IDAT', 'IEND']) expect(text).toContain(type);
  expect(stripPngMetadata(Buffer.from('not a png at all, just text'))).toBeNull();
  expect(stripPngMetadata(pngWithMetadata().subarray(0, 60))).toBeNull(); // truncated, no IEND
});

test('POST stores a cleaned PNG (no planted token/address bytes, even compressed); GET lists and serves it; auth required', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc1-')); dirs.push(dir);
  const deps = { configDir: dir, now: () => new Date(2026, 9, 2, 3, 4, 5) };
  expect((await handleShareCaptures(req('/v1/captures', 'POST', pngWithMetadata(), false), meta, deps)).status).toBe(401);
  expect((await handleShareCaptures(req('/v1/captures', 'POST', new TextEncoder().encode(`<svg>${TOKEN}</svg>`)), meta, deps)).status).toBe(400);

  const res = await handleShareCaptures(req('/v1/captures', 'POST', pngWithMetadata()), meta, deps);
  expect(res.status).toBe(201);
  const { id, droppedChunks } = await res.json() as { id: string; droppedChunks: string[] };
  expect(id).toMatch(/^share-20261002-030405-[0-9a-f]{6}$/);
  expect(droppedChunks.length).toBe(5);

  const files = readdirSync(join(dir, 'captures'));
  expect(files).toEqual([`${id}.png`]);
  const stored = readFileSync(join(dir, 'captures', files[0]!));
  for (const secret of [TOKEN, ADDRESS, 'tail1a2b3c', 'FAKE']) expect(stored.includes(Buffer.from(secret))).toBe(false);
  expect(stored.includes(deflateSync(Buffer.from(ADDRESS)))).toBe(false);

  const list = await (await handleShareCaptures(req('/v1/captures'), meta, deps)).json() as { items: Array<{ id: string }> };
  expect(list.items.map((i) => i.id)).toEqual([id]);
  const served = await handleShareCaptures(req(`/v1/captures/${id}`), meta, deps);
  expect(served.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await served.arrayBuffer()).equals(stored)).toBe(true);
  expect((await handleShareCaptures(req('/v1/captures/../../config'), meta, deps)).status).toBe(404);
});
