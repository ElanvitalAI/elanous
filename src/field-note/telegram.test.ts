import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot } from '../telegram.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const date = new Date('2026-10-01T09:00:00.000Z');
const update = (id: number, extra: Record<string, unknown>, chat = 10, thread = 7) => ({
  update_id: id, message: { message_id: id, date: Math.floor(date.getTime() / 1000),
    from: { id: 10 }, chat: { id: chat, type: 'private' }, message_thread_id: thread, ...extra },
});

function botFor(updates: unknown[], withEngine = true) {
  const root = mkdtempSync(join(tmpdir(), 'note-bot-'));
  roots.push(root);
  const sent: string[] = [];
  const normal: string[] = [];
  let polls = 0;
  let bot: TelegramBot;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    const method = url.split('/').at(-1);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (method === 'getUpdates') {
      if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: updates });
    }
    if (method === 'getFile') return Response.json({ ok: true, result: { file_path: `media/${body.file_id}.bin` } });
    if (method === 'sendMessage') sent.push(String(body.text));
    return Response.json({ ok: true, result: { message_id: 100 } });
  }) as typeof fetch;
  bot = new TelegramBot({ token: '123:test', allowedUsers: [10], fetchImpl, perChatGapMs: 0,
    log: () => {}, fieldRootDir: () => root, nowImpl: () => date.getTime(),
    fieldReel: { quietMs: 20_000, runner: async () => ({ ok: false, seconds: 0, error: 'not rendered' }) },
    ...(withEngine ? { fieldNoteEngine: { transcribe: async () => [{ startSeconds: 0, endSeconds: 0.01, text: '세미나 발언', speaker: 'A' }] },
      fieldNoteDecodeAudio: (_file: string, recordedAt: string) => ({ samples: new Float32Array(160), sampleRate: 16000, recordedAt }) } : {}),
    onMessage: async (ctx) => { normal.push(ctx.text); },
  });
  return { bot, root, sent, normal, ledger: join(root, 'field-notes', 'telegram', '123', '10', '7', '10', 'window.json') };
}

test('bot opens a timed ledger, collects two photos and one voice, then replies with NOTE1 file path without chat turns', async () => {
  const { bot, sent, normal, ledger } = botFor([
    update(1, { text: '노트: 세미나 18:00~20:00' }),
    update(2, { photo: [{ file_id: 'p1', width: 100, height: 100 }] }),
    update(3, { photo: [{ file_id: 'p2', width: 100, height: 100 }] }),
    update(4, { voice: { file_id: 'v1', mime_type: 'audio/ogg' } }),
    update(5, { text: '노트 만들기' }),
  ]);
  await bot.start();
  const window = JSON.parse(readFileSync(ledger, 'utf8')) as { start: string; end: string; status: string; media: Array<{ kind: string; file: string }>; notePath: string };
  expect([window.start, window.end, window.status]).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-01T11:00:00.000Z', 'done']);
  expect(window.media.map((m) => m.kind)).toEqual(['photo', 'photo', 'voice']);
  expect(window.media.every((m) => existsSync(m.file))).toBe(true);
  expect(readFileSync(window.notePath, 'utf8')).toContain('세미나 발언');
  expect(readFileSync(window.notePath, 'utf8').match(/!\[/g)).toHaveLength(2);
  expect(sent.at(-1)).toBe(`노트 생성 · ${window.notePath}`);
  expect(normal).toEqual([]);
});

test('no engine explains the missing dependency and preserves the open ledger and audio', async () => {
  const { bot, sent, ledger } = botFor([
    update(1, { text: '노트: 세미나 18:00~20:00' }), update(2, { voice: { file_id: 'v1' } }), update(3, { text: '노트 만들기' }),
  ], false);
  await bot.start();
  const window = JSON.parse(readFileSync(ledger, 'utf8')) as { status: string; media: Array<{ file: string }> };
  expect(sent.at(-1)).toContain('전사 엔진 없음');
  expect(window.status).toBe('open');
  expect(existsSync(window.media[0]!.file)).toBe(true);
});

test('a second start cannot discard already collected files', async () => {
  const { bot, ledger, sent } = botFor([
    update(1, { text: '노트: 세미나 18:00~20:00' }),
    update(2, { photo: [{ file_id: 'first', width: 4, height: 4 }] }),
    update(3, { text: '노트: 새 세미나 18:00~20:00' }),
  ]);
  await bot.start();
  const window = JSON.parse(readFileSync(ledger, 'utf8')) as { title: string; media: unknown[] };
  expect(window.title).toBe('세미나');
  expect(window.media).toHaveLength(1);
  expect(sent.at(-1)).toContain('열린 노트 창이 있습니다');
});

test('existing #현장 upload keeps its own bot route while a note window is open', async () => {
  const { bot, ledger, sent, normal, root } = botFor([
    update(1, { text: '노트: 세미나 18:00~20:00' }),
    update(2, { caption: '#현장 meetup', photo: [{ file_id: 'tagged', width: 4, height: 4 }] }),
  ]);
  await bot.start();
  expect((JSON.parse(readFileSync(ledger, 'utf8')) as { media: unknown[] }).media).toEqual([]);
  expect(sent).toContain('현장 폴더에 저장 · meetup · 지금 1장');
  expect(existsSync(join(root, 'field', 'meetup', '.ready'))).toBe(true);
  expect(normal).toEqual([]);
});

test('out-of-window media is not collected', async () => {
  const { bot, ledger } = botFor([
    update(1, { text: '노트: 세미나 18:00~20:00' }),
    update(2, { date: Math.floor(date.getTime() / 1000) - 60, photo: [{ file_id: 'early', width: 4, height: 4 }] }),
    update(3, { date: Math.floor(date.getTime() / 1000) + 3 * 3600, voice: { file_id: 'late' } }),
  ]);
  await bot.start();
  expect((JSON.parse(readFileSync(ledger, 'utf8')) as { media: unknown[] }).media).toEqual([]);
});

test('a bot restart resumes an open window from the on-disk ledger', async () => {
  const { bot, root, ledger, sent } = botFor([update(1, { text: '노트: 세미나 18:00~20:00' })]);
  await bot.start();
  const updates = [update(2, { photo: [{ file_id: 'restart', width: 4, height: 4 }] }), update(3, { text: '노트 만들기' })];
  let polls = 0;
  let resumed: TelegramBot;
  resumed = new TelegramBot({ token: '123:test', allowedUsers: [10], fieldRootDir: () => root, perChatGapMs: 0,
    nowImpl: () => date.getTime(), log: () => {}, onMessage: async () => { throw new Error('must not enter session'); },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
      const method = url.split('/').at(-1);
      if (method === 'getUpdates') {
        if (++polls > 1) { resumed.stop(); return Response.json({ ok: true, result: [] }); }
        return Response.json({ ok: true, result: updates });
      }
      if (method === 'getFile') return Response.json({ ok: true, result: { file_path: 'media/restart.bin' } });
      if (method === 'sendMessage') sent.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
      return Response.json({ ok: true, result: { message_id: 100 } });
    }) as typeof fetch,
  });
  await resumed.start();
  const window = JSON.parse(readFileSync(ledger, 'utf8')) as { status: string; media: unknown[]; notePath: string };
  expect(window.media).toHaveLength(1);
  expect(window.status).toBe('done');
  expect(existsSync(window.notePath)).toBe(true);
  expect(sent.at(-1)).toBe(`노트 생성 · ${window.notePath}`);
});

test('non-note messages and other chats do not join the open note window', async () => {
  const { bot, ledger, normal } = botFor([
    update(1, { text: '노트: 세미나 18:00~20:00' }),
    update(2, { photo: [{ file_id: 'other', width: 4, height: 4 }] }, 11),
    update(3, { text: 'hello' }),
  ]);
  await bot.start();
  expect((JSON.parse(readFileSync(ledger, 'utf8')) as { media: unknown[] }).media).toEqual([]);
  expect(normal).toContain('hello');
});
