import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TelegramBot } from '../src/telegram.js';
import type { FieldReelRunner } from '../src/field/field-reel.js';
import type { UserConfig } from '../src/user-config.js';
import { debug } from '../src/debug/log.js';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function video(): Buffer {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
    '-frames:v', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
  { maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`video fixture failed: ${result.stderr.toString()}`);
  return result.stdout;
}

async function upload(caption: string, configMode?: 'standard' | 'instant', album = false, subsequentCaptions: Array<string | undefined> = [undefined]) {
  const rootDir = mkdtempSync(join(tmpdir(), 'tg-field-instant-'));
  roots.push(rootDir);
  const documents: string[] = [];
  const runnerModes: Array<string | undefined> = [];
  const subtitles: string[] = [];
  const modes: Array<{ event: string; mode: string; source: string }> = [];
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'telegram.field' && event === 'reel-mode') modes.push(data as { event: string; mode: string; source: string });
  }) as typeof debug.log;
  let polls = 0;
  let bot: TelegramBot;
  const reel = video();
  const runner: FieldReelRunner = async (dir, opts) => {
    runnerModes.push(opts.mode);
    const file = join(dir, 'reel', 'reel-9x16.mp4');
    writeFileSync(file, reel);
    return { ok: true, file, seconds: 42 };
  };
  const update = (id: number, text?: string) => ({ update_id: id, message: {
    message_id: id, from: { id: 10 }, chat: { id: 10, type: 'private' },
    ...(album ? { media_group_id: 'g1' } : {}),
    ...(text ? { caption: text } : {}),
    photo: [{ file_id: `p${id}`, width: 5, height: 5 }],
  } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    const method = url.split('/').at(-1);
    if (method === 'getUpdates') {
      if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: album
        ? [update(1, caption), ...subsequentCaptions.map((text, i) => update(i + 2, text))]
        : [update(1, caption)] });
    }
    if (method === 'getFile') return Response.json({ ok: true, result: { file_path: 'media/photo.jpg' } });
    if (method === 'sendDocument') documents.push(String((init?.body as FormData).get('caption')));
    return Response.json({ ok: true, result: { message_id: 30 } });
  }) as typeof fetch;
  bot = new TelegramBot({ token: '123:test', allowedUsers: [10], fetchImpl, perChatGapMs: 0,
    fieldRootDir: () => rootDir, fieldReel: { quietMs: 10, runner, autoFeed: false },
    ...(configMode ? { slashContext: { userConfig: { telegram: { fieldReelMode: configMode } } as UserConfig } } : {}),
    onMessage: async () => { throw new Error('field upload must not reach the LLM'); },
  });
  try {
    await bot.start();
    for (let i = 0; i < 100 && documents.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const event = modes[0]?.event;
    if (event) {
      try { subtitles.push(readFileSync(join(rootDir, 'field', event, 'captions.txt'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { modes, runnerModes, subtitles, documents };
  } finally {
    debug.log = originalLog;
  }
}

test('telegram.fieldReelMode survives config parsing and saving', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-field-config-'));
  roots.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ telegram: { fieldReelMode: 'instant' } }));
  const config = buildUserConfig(path);
  expect(config.telegram.fieldReelMode).toBe('instant');
  saveUserConfig(config, path);
  expect(JSON.parse(readFileSync(path, 'utf8')).telegram.fieldReelMode).toBe('instant');
  expect(buildUserConfig(path).telegram.fieldReelMode).toBe('instant');
  writeFileSync(path, JSON.stringify({ telegram: { fieldReelMode: 'invalid' } }));
  expect(buildUserConfig(path).telegram.fieldReelMode).toBeUndefined();
});

test('caption mode overrides config, preserves event and removes instant from subtitles and the render reply', async () => {
  const result = await upload('#현장 marketers-night 즉석 첫날 부스', 'standard');
  expect(result.modes).toEqual([{ event: 'marketers-night', mode: 'instant', source: 'caption' }]);
  expect(result.runnerModes).toEqual(['instant']);
  expect(result.subtitles[0]).toMatch(/\| 첫날 부스\n$/);
  expect(result.documents).toEqual(['현장 영상 · marketers-night · 42초 (즉석판)']);
});

test('a slugless instant caption uses the default event without a mode subtitle', async () => {
  const result = await upload('#현장 즉석');
  expect(result.modes).toMatchObject([{ mode: 'instant', source: 'caption' }]);
  expect(result.modes[0]!.event).toMatch(/^field-\d{4}-\d{2}-\d{2}$/);
  expect(result.runnerModes).toEqual(['instant']);
  expect(result.subtitles).toEqual([]);
  expect(result.documents[0]).toEndWith(' (즉석판)');
});

test('config instant applies to a caption without mode, and is inherited by other album items', async () => {
  const result = await upload('#현장 marketers-night 첫날', 'instant', true);
  expect(result.modes).toEqual([
    { event: 'marketers-night', mode: 'instant', source: 'config' },
    { event: 'marketers-night', mode: 'instant', source: 'config' },
  ]);
  expect(result.runnerModes).toEqual(['instant']);
  expect(result.subtitles[0]).toMatch(/\| 첫날\n$/);
  expect(result.documents).toEqual(['현장 영상 · marketers-night · 42초 (즉석판)']);
});

test('caption instant is retained for album items without their own caption', async () => {
  const result = await upload('#현장 marketers-night 즉석', 'standard', true);
  expect(result.modes).toEqual([
    { event: 'marketers-night', mode: 'instant', source: 'caption' },
    { event: 'marketers-night', mode: 'instant', source: 'caption' },
  ]);
  expect(result.runnerModes).toEqual(['instant']);
});

test('second album caption selects instant for the following uncaptioned item', async () => {
  const result = await upload('#현장 marketers-night 첫날', undefined, true,
    ['#현장 marketers-night 즉석 둘째 장', undefined]);
  expect(result.modes).toEqual([
    { event: 'marketers-night', mode: 'standard', source: 'default' },
    { event: 'marketers-night', mode: 'instant', source: 'caption' },
    { event: 'marketers-night', mode: 'instant', source: 'caption' },
  ]);
  expect(result.runnerModes).toEqual(['instant']);
  expect(result.subtitles[0]).toMatch(/\| 첫날\n/);
  expect(result.subtitles[0]).toMatch(/\| 둘째 장\n/);
  expect(result.documents).toEqual(['현장 영상 · marketers-night · 42초 (즉석판)']);
});

test('no mode in caption or config keeps the standard reel and unlabelled reply', async () => {
  const result = await upload('#현장 marketers-night 첫날');
  expect(result.modes).toEqual([{ event: 'marketers-night', mode: 'standard', source: 'default' }]);
  expect(result.runnerModes).toEqual(['standard']);
  expect(result.documents).toEqual(['현장 영상 · marketers-night · 42초']);
});
