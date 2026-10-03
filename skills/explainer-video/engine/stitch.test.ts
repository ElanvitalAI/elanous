import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const { ensureCards, stitch } = require('./stitch.mjs') as {
  ensureCards: (options: { title: string; sub: string; cacheDir: string; render: (paths: { intro: string; end: string }) => void }) => Promise<{ intro: string; end: string; cardsCache: 'hit' | 'miss' }>;
  stitch: (options: { intro: string; body: string; end: string; bgm: string; out: string }) => string;
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'stitch-')); dirs.push(dir); return dir; }
function command(bin: string, args: string[]) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${bin}: ${result.stderr}`);
  return result.stdout;
}
function decoded(args: string[]) {
  const result = spawnSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.toString()}`);
  return result.stdout;
}
function pixel(file: string, at: number) {
  const rgb = decoded(['-ss', String(at), '-i', file, '-vf', 'crop=1:1:540:960,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
  expect(rgb.length).toBe(3);
  return [...rgb];
}
function volume(file: string, at: number) {
  const pcm = decoded(['-ss', String(at), '-i', file, '-t', '0.12', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  expect(pcm.length).toBeGreaterThan(1000);
  let amplitude = 0;
  for (let i = 0; i < pcm.length; i += 2) amplitude += Math.abs(pcm.readInt16LE(i));
  return amplitude / (pcm.length / 2);
}
function clip(file: string, color: string, seconds: number) {
  command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1080x1920:r=30:d=${seconds}`,
    '-threads', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

test('cards are keyed by title/sub/dimensions/version and reused without rendering', async () => {
  const dir = fixture();
  let calls = 0;
  const render = ({ intro, end }: { intro: string; end: string }) => {
    calls++;
    writeFileSync(intro, 'intro');
    writeFileSync(end, 'end');
  };
  const first = await ensureCards({ title: '현장', sub: '날짜', cacheDir: dir, render });
  const second = await ensureCards({ title: '현장', sub: '날짜', cacheDir: dir, render });
  expect(calls).toBe(1);
  expect(second).toEqual({ ...first, cardsCache: 'hit' });
  expect(first.cardsCache).toBe('miss');
  const key = createHash('sha256').update(JSON.stringify(['현장', '날짜', 1080, 1920, 1])).digest('hex').slice(0, 16);
  expect(first.intro).toBe(join(dir, key, 'intro.mp4'));
  expect(first.end).toBe(join(dir, key, 'end.mp4'));
});

test('card cache does not collide when title and subtitle contain separators', async () => {
  const dir = fixture();
  let calls = 0;
  const render = ({ intro, end }: { intro: string; end: string }) => {
    calls++;
    writeFileSync(intro, 'intro');
    writeFileSync(end, 'end');
  };
  const first = await ensureCards({ title: '서울|밤', sub: '2026', cacheDir: dir, render });
  const second = await ensureCards({ title: '서울', sub: '밤|2026', cacheDir: dir, render });
  expect(first.intro).not.toBe(second.intro);
  expect(second.cardsCache).toBe('miss');
  expect(calls).toBe(2);
});

test('concurrent callers wait for both cards to be atomically published', async () => {
  const dir = fixture();
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const rendering = new Promise<void>((resolve) => { started = resolve; });
  const render = async ({ intro, end }: { intro: string; end: string }) => {
    calls++;
    writeFileSync(intro, 'unfinished intro');
    started();
    await hold;
    writeFileSync(end, 'finished end');
  };
  const first = ensureCards({ title: 'product-launch', sub: 'date', cacheDir: dir, render });
  await rendering;
  const second = ensureCards({ title: 'product-launch', sub: 'date', cacheDir: dir, render });
  const key = createHash('sha256').update(JSON.stringify(['현장 스케치', 'date', 1080, 1920, 1])).digest('hex').slice(0, 16);
  expect(existsSync(join(dir, key, 'intro.mp4'))).toBe(false);
  let settled = false;
  void second.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(settled).toBe(false);
  expect(calls).toBe(1);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect([a.cardsCache, b.cardsCache].sort()).toEqual(['hit', 'miss']);
  expect(a.intro).toBe(b.intro);
  expect(readFileSync(b.end, 'utf8')).toBe('finished end');
});

test('orphaned card lock is reclaimed without taking over a live renderer', async () => {
  const dir = fixture();
  const key = createHash('sha256').update(JSON.stringify(['현장', '날짜', 1080, 1920, 1])).digest('hex').slice(0, 16);
  const lock = join(dir, `${key}.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  let calls = 0;
  const render = ({ intro, end }: { intro: string; end: string }) => {
    calls++;
    writeFileSync(intro, 'intro');
    writeFileSync(end, 'end');
  };
  const pending = ensureCards({ title: '현장', sub: '날짜', cacheDir: dir, render });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(calls).toBe(0);
  // A dead process ID belongs to no live renderer; the next contender reclaims its lock.
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  const contender = ensureCards({ title: '현장', sub: '날짜', cacheDir: dir, render });
  const [result, reused] = await Promise.all([pending, contender]);
  expect([result.cardsCache, reused.cardsCache].sort()).toEqual(['hit', 'miss']);
  expect(result.intro).toBe(reused.intro);
  expect(calls).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

test('warm-card slug and instant body resolve to the same title and cache key', async () => {
  const dir = fixture();
  const cache = join(dir, 'cache');
  mkdirSync(join(cache, 'fonts'), { recursive: true });
  for (const name of ['Pretendard-Bold.woff2', 'Pretendard-ExtraBold.woff2', 'Pretendard-Black.woff2']) writeFileSync(join(cache, 'fonts', name), 'font');
  writeFileSync(join(cache, 'gsap.min.js'), 'window.gsap = {};');
  let calls = 0;
  const render = ({ intro, end }: { intro: string; end: string }) => {
    calls++;
    writeFileSync(intro, 'intro');
    writeFileSync(end, 'end');
  };
  const warm = await ensureCards({ title: 'product-launch', sub: 'date', cacheDir: join(dir, 'cards'), render });
  const project = join(dir, 'project');
  mkdirSync(project);
  const photo = join(project, '20261002T193012Z-phone-photo.jpg');
  command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', '-update', '1', photo]);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const sips = join(bin, 'sips');
  writeFileSync(sips, '#!/bin/sh\ncase "$1" in\n  -g) printf "pixelWidth: 32\\npixelHeight: 32\\n" ;;\n  *) for arg do [ "$arg" = "--out" ] && next=1 && continue; if [ "${next:-0}" = 1 ]; then dest=$arg; next=0; elif [ "${arg##*.}" = jpg ]; then src=$arg; fi; done; cp "$src" "$dest" ;;\nesac\n');
  chmodSync(sips, 0o755);
  const result = spawnSync('node', ['skills/explainer-video/engine/reel.mjs', project, '--part', 'body', '--title', 'product-launch', '--sub', 'date'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIELD_REEL_VISION: '0', EXPLAINER_CACHE: cache },
  });
  expect(result.status).toBe(0);
  const timeline = JSON.parse(readFileSync(join(project, 'reel', 'timeline.json'), 'utf8')) as { title: string; sub: string; part: string; items: unknown[] };
  expect(timeline.part).toBe('body');
  expect(timeline.items).toHaveLength(1);
  expect(timeline.title).toBe('현장 스케치');
  expect(timeline.sub).toBe('date');
  const instant = await ensureCards({ ...timeline, cacheDir: join(dir, 'cards'), render });
  expect(instant.intro).toBe(warm.intro);
  expect(instant.cardsCache).toBe('hit');
  expect(calls).toBe(1);
});

test('card-only reel composition needs no photos and keeps original card markup and duration', () => {
  const dir = fixture();
  const cache = join(dir, 'cache');
  mkdirSync(join(cache, 'fonts'), { recursive: true });
  for (const name of ['Pretendard-Bold.woff2', 'Pretendard-ExtraBold.woff2', 'Pretendard-Black.woff2']) writeFileSync(join(cache, 'fonts', name), 'font');
  writeFileSync(join(cache, 'gsap.min.js'), 'window.gsap = {};');
  for (const [part, seconds] of [['intro', 3], ['end', 3.4]] as const) {
    const project = join(dir, part);
    mkdirSync(project);
    const result = spawnSync('node', ['skills/explainer-video/engine/reel.mjs', project, '--part', part, '--title', '현장', '--sub', '날짜'], {
      encoding: 'utf8', env: { ...process.env, EXPLAINER_CACHE: cache },
    });
    expect(result.status).toBe(0);
    const timeline = JSON.parse(readFileSync(join(project, 'reel', 'timeline.json'), 'utf8')) as { total: number; items: unknown[] };
    expect(timeline.total).toBe(seconds);
    expect(timeline.items).toHaveLength(0);
    const html = readFileSync(join(project, 'reel', 'hf', 'index.html'), 'utf8');
    expect(html).toContain(part === 'intro' ? '현장 스케치</div>' : 'elanous.ai</p>');
  }
});

test('two 0.3s xfades and a single faded music stream produce an 11.8s vertical reel', () => {
  const dir = fixture();
  const intro = join(dir, 'intro.mp4'), body = join(dir, 'body.mp4'), end = join(dir, 'end.mp4');
  const bgm = join(dir, 'field.wav'), out = join(dir, 'out.mp4');
  clip(intro, 'red', 3.0);
  clip(body, 'blue', 6.0);
  clip(end, 'black', 3.4);
  command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=13', bgm]);
  expect(stitch({ intro, body, end, bgm, out })).toBe(out);
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,codec_name', '-of', 'json', out])) as {
    format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
  expect(Math.abs(Number(probe.format.duration) - 11.8)).toBeLessThanOrEqual(0.2);
  expect(probe.streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(1);
  expect(probe.streams.find((stream) => stream.codec_type === 'audio')?.codec_name).toBe('aac');
  expect(probe.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920, r_frame_rate: '30/1' });
  // Mid-transition frames must contain both input colours, not a hard cut.
  const redBlue = pixel(out, 2.85);
  expect(redBlue[0]).toBeGreaterThan(30);
  expect(redBlue[2]).toBeGreaterThan(30);
  const blueBlack = pixel(out, 8.55);
  expect(blueBlack[2]).toBeGreaterThan(30);
  expect(blueBlack[2]).toBeLessThan(210);
  const middleVolume = volume(out, 5);
  expect(volume(out, 0)).toBeLessThan(middleVolume * 0.45);
  expect(volume(out, 11.55)).toBeLessThan(middleVolume * 0.45);
}, 180_000);
