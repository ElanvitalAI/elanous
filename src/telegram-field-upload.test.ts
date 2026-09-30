import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot, parseUpdate } from './telegram.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

type Msg = Record<string, unknown> & { message_id: number };
const OWNER = 10;
const msg = (id: number, extra: Record<string, unknown>): { update_id: number; message: Msg } => ({
  update_id: id,
  message: { message_id: id, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, ...extra },
});

function setup(updates: unknown[]) {
  const rootDir = mkdtempSync(join(tmpdir(), 'tg-field-'));
  roots.push(rootDir);
  const sent: string[] = [];
  const turns: string[] = [];
  let polls = 0;
  let bot: TelegramBot;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    const method = url.split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (method === 'getUpdates') {
      if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: updates });
    }
    if (method === 'getFile') return Response.json({ ok: true, result: { file_id: body.file_id, file_path: `media/${String(body.file_id)}.bin` } });
    if (method === 'sendMessage') sent.push(String(body.text));
    return Response.json({ ok: true, result: { message_id: 777 } });
  }) as typeof fetch;
  bot = new TelegramBot({
    token: '123:test', allowedUsers: [OWNER], fetchImpl, perChatGapMs: 0,
    log: () => {}, fieldRootDir: () => rootDir, fieldDefaultEvent: 'default-ev',
    onMessage: async (ctx) => { turns.push(ctx.text); },
  });
  return { bot, rootDir, sent, turns };
}

describe('telegram #현장', () => {
  test('a tagged photo is saved via the shared save function and answered with one line; no LLM turn', async () => {
    const { bot, rootDir, sent, turns } = setup([
      msg(1, { caption: '#현장 marketers-night-2026-10', photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', width: 9, height: 9 }] }),
    ]);
    await bot.start();
    expect(turns).toEqual([]);
    expect(sent).toEqual(['현장 폴더에 저장 · marketers-night-2026-10 · 지금 1장']);
    const dir = join(rootDir, 'field', 'marketers-night-2026-10');
    const files = readdirSync(dir).filter((n) => !n.startsWith('.'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{6}Z-telegram-big\.bin\.jpg$/);
    expect(readFileSync(join(dir, '.ready'), 'utf8')).toBe('1\n');
  });

  test('tag without slug uses the default event; video and image documents are accepted', async () => {
    const { bot, rootDir, sent } = setup([
      msg(1, { caption: '#현장', video: { file_id: 'v1', mime_type: 'video/mp4', file_name: 'clip.mp4' } }),
      msg(2, { caption: '오프닝 #현장', document: { file_id: 'd1', mime_type: 'image/heic', file_name: 'IMG_9.HEIC' } }),
    ]);
    await bot.start();
    expect(sent).toEqual(['현장 폴더에 저장 · default-ev · 지금 1장', '현장 폴더에 저장 · default-ev · 지금 2장']);
    expect(readdirSync(join(rootDir, 'field', 'default-ev')).filter((n) => !n.startsWith('.') && n !== 'captions.txt').map((n) => n.replace(/^\d{8}T\d{6}Z-/, '')).sort())
      .toEqual(['telegram-IMG_9.HEIC', 'telegram-clip.mp4']);
    // «오프닝 #현장» 의 글은 자막 한 줄로 남는다
    expect(readFileSync(join(rootDir, 'field', 'default-ev', 'captions.txt'), 'utf8')).toMatch(/-telegram-IMG_9\.HEIC \| 오프닝\n$/);
  });

  test('untagged photo keeps the old path; untagged video stays ignored; a pdf document with the tag is not intercepted', async () => {
    const { bot, rootDir, sent, turns } = setup([
      msg(1, { caption: '그냥 사진', photo: [{ file_id: 'p', width: 1, height: 1 }] }),
      msg(2, { caption: '그냥 영상', video: { file_id: 'v', mime_type: 'video/mp4' } }),
      msg(3, { caption: '#현장', document: { file_id: 'pdf', mime_type: 'application/pdf', file_name: 'a.pdf' } }),
    ]);
    await bot.start();
    expect(turns).toEqual(['그냥 사진', '#현장']);
    expect(sent.filter((t) => t.startsWith('현장'))).toEqual([]);
    expect(() => readdirSync(join(rootDir, 'field'))).toThrow();
  });

  test('an album: the caption is on the first item only — the rest join it and one reply carries the final count', async () => {
    const { bot, rootDir, sent, turns } = setup([
      msg(1, { caption: '#현장 ev-album', media_group_id: 'g1', photo: [{ file_id: 'a', width: 1, height: 1 }] }),
      msg(2, { media_group_id: 'g1', photo: [{ file_id: 'b', width: 1, height: 1 }] }),
      msg(3, { media_group_id: 'g1', video: { file_id: 'c', mime_type: 'video/quicktime' } }),
    ]);
    await bot.start();
    await new Promise((r) => setTimeout(r, 1700));
    expect(turns).toEqual([]);
    expect(sent).toEqual(['현장 폴더에 저장 · ev-album · 지금 3장']);
    expect(readFileSync(join(rootDir, 'field', 'ev-album', '.ready'), 'utf8')).toBe('3\n');
  });

  test('parseUpdate only carries a video when tagged or in an album', () => {
    const base = { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' as const } };
    expect(parseUpdate({ update_id: 1, message: { ...base, caption: 'x', video: { file_id: 'v' } } } as never)).toBeNull();
    expect(parseUpdate({ update_id: 1, message: { ...base, caption: '#현장', video: { file_id: 'v' } } } as never)?.video?.fileId).toBe('v');
    expect(parseUpdate({ update_id: 1, message: { ...base, media_group_id: 'g', video: { file_id: 'v' } } } as never)?.mediaGroupId).toBe('g');
  });
});
