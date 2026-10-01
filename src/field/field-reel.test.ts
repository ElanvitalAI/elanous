import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isValidFieldReelFile, readFieldReelStatus, scheduleFieldReel, type FieldReelRunner } from './field-reel.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'field-reel-'));
  dirs.push(dir);
  return dir;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(10); }
  throw new Error('reel did not reach expected state');
}
function media(dir: string, n: number) { writeFileSync(join(dir, `photo${n}.jpg`), 'image'); }
function mp4() {
  const box = (type: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom')),
    box('moov', box('mvhd', Buffer.from('metadata'))),
    box('mdat', Buffer.from('video samples')),
  ]);
}
function output(dir: string) {
  mkdirSync(join(dir, 'reel'), { recursive: true });
  const file = join(dir, 'reel', 'reel-9x16.mp4');
  const rendered = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
    '-frames:v', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
  { maxBuffer: 1024 * 1024 });
  if (rendered.status !== 0) throw new Error(`test video fixture failed: ${rendered.stderr.toString()}`);
  writeFileSync(file, rendered.stdout);
  return file;
}

test('three uploads inside quiet window render once; status waiting → rendering → done and one callback', async () => {
  const dir = fixture();
  let calls = 0;
  let delivered = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const runner: FieldReelRunner = async (folder, opts) => {
    calls++;
    expect(opts.title).toBe(dir.split('/').at(-1)!);
    await hold;
    return { ok: true, file: output(folder), seconds: 42 };
  };
  for (let i = 0; i < 3; i++) {
    media(dir, i);
    scheduleFieldReel(dir, { quietMs: 50, runner, onDone: () => { delivered++; } });
    expect(readFieldReelStatus(dir)?.state).toBe('waiting');
    await sleep(10);
  }
  await until(() => calls === 1);
  expect(readFieldReelStatus(dir)).toMatchObject({ state: 'rendering', items: 3, startedAt: expect.any(String) });
  release();
  await until(() => readFieldReelStatus(dir)?.state === 'done' && delivered === 1);
  expect(readFieldReelStatus(dir)).toMatchObject({ state: 'done', items: 3, seconds: 42,
    file: join(dir, 'reel', 'reel-9x16.mp4'), finishedAt: expect.any(String) });
  expect(JSON.parse(readFileSync(join(dir, '.reel-status.json'), 'utf8')).state).toBe('done');
  expect(calls).toBe(1);
  expect(delivered).toBe(1);
});

test('an upload during rendering is serialized and runs exactly once after quiet time', async () => {
  const dir = fixture();
  media(dir, 0);
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const runner: FieldReelRunner = async (folder) => {
    calls++;
    if (calls === 1) await hold;
    return { ok: true, file: output(folder), seconds: 1 };
  };
  let delivered = 0;
  scheduleFieldReel(dir, { quietMs: 50, runner, onDone: () => { delivered++; } });
  await until(() => calls === 1);
  media(dir, 1);
  scheduleFieldReel(dir, { quietMs: 50, runner, onDone: () => { delivered++; } });
  media(dir, 2);
  scheduleFieldReel(dir, { quietMs: 50, runner, onDone: () => { delivered++; } });
  expect(calls).toBe(1);
  release();
  await until(() => calls === 2 && readFieldReelStatus(dir)?.state === 'done' && delivered === 2);
  expect(readFieldReelStatus(dir)?.items).toBe(3);
  expect(delivered).toBe(2);
  await sleep(80);
  expect(calls).toBe(2);
});

test('ffprobe rejects a box-shaped fake but accepts a video stream with a readable frame', () => {
  const dir = fixture();
  const file = join(dir, 'fake.mp4');
  writeFileSync(file, mp4());
  expect(isValidFieldReelFile(file)).toBe(false);
  expect(isValidFieldReelFile(output(dir))).toBe(true);
});

test('empty, malformed and box-only output fail even when the runner reports success', async () => {
  for (const content of ['', 'not an mp4', mp4()]) {
    const dir = fixture();
    media(dir, 0);
    let delivered = 0;
    scheduleFieldReel(dir, { quietMs: 10, runner: async (folder) => {
      mkdirSync(join(folder, 'reel'), { recursive: true });
      const file = join(folder, 'reel', 'reel-9x16.mp4');
      writeFileSync(file, content);
      return { ok: true, file, seconds: 1 };
    }, onDone: (result) => { expect(result.ok).toBe(false); delivered++; } });
    await until(() => readFieldReelStatus(dir)?.state === 'failed');
    expect(readFieldReelStatus(dir)).toMatchObject({ state: 'failed', error: expect.any(String) });
    expect(readFieldReelStatus(dir)?.file).toBeUndefined();
    await until(() => delivered === 1);
  }
});

test('a stuck delivery cannot block a subsequent render or its notification', async () => {
  const dir = fixture();
  media(dir, 0);
  let calls = 0;
  let startedDelivery = 0;
  let nextDelivery = 0;
  const never = new Promise<void>(() => {});
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const runner: FieldReelRunner = async (folder) => {
    calls++;
    if (calls === 1) await hold;
    return { ok: true, file: output(folder), seconds: calls };
  };
  scheduleFieldReel(dir, { quietMs: 20, runner, onDone: () => { startedDelivery++; return never; } });
  await until(() => calls === 1);
  media(dir, 1);
  scheduleFieldReel(dir, { quietMs: 20, runner, onDone: () => { nextDelivery++; } });
  release();
  await until(() => startedDelivery === 1 && calls === 2 && nextDelivery === 1);
  expect(readFieldReelStatus(dir)).toMatchObject({ state: 'done', items: 2 });
});

test('title.txt supplies title and subtitle; without it the slug and local date are used', async () => {
  const dir = fixture();
  media(dir, 0);
  writeFileSync(join(dir, 'title.txt'), '마케터의 밤\n함께 만드는 현장');
  const labels: Array<{ title: string; sub: string }> = [];
  const runner: FieldReelRunner = async (folder, opts) => {
    labels.push(opts);
    return { ok: true, file: output(folder), seconds: 1 };
  };
  scheduleFieldReel(dir, { quietMs: 10, runner, title: 'ignored title', sub: 'ignored subtitle' });
  await until(() => labels.length === 1);
  expect(labels[0]).toEqual({ title: '마케터의 밤', sub: '함께 만드는 현장' });
  rmSync(join(dir, 'title.txt'));
  media(dir, 1);
  scheduleFieldReel(dir, { quietMs: 10, runner });
  await until(() => labels.length === 2);
  const date = new Date();
  expect(labels[1]).toEqual({ title: dir.split('/').at(-1)!,
    sub: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` });
});

test('a failing runner records failed status and sends its result once', async () => {
  const dir = fixture();
  media(dir, 0);
  let delivered = 0;
  scheduleFieldReel(dir, { quietMs: 10, runner: async () => ({ ok: false, seconds: 3, error: 'bad render' }),
    onDone: (result) => { expect(result.error).toBe('bad render'); delivered++; } });
  await until(() => readFieldReelStatus(dir)?.state === 'failed');
  expect(readFieldReelStatus(dir)).toMatchObject({ state: 'failed', error: 'bad render', seconds: 3 });
  await until(() => delivered === 1);
});

// 리뷰 R3: reel.sh 는 시작할 때 reel/ 을 지운다 — 상태 파일이 그 안에 있으면 렌더 중 상태 API 가 404 가 된다.
test('status survives the renderer deleting reel/ mid-render', async () => {
  const dir = fixture();
  media(dir, 0);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  const runner: FieldReelRunner = async (folder) => {
    rmSync(join(folder, 'reel'), { recursive: true, force: true });
    started = true;
    await hold;
    return { ok: true, file: output(folder), seconds: 1 };
  };
  scheduleFieldReel(dir, { quietMs: 10, runner });
  await until(() => started);
  expect(readFieldReelStatus(dir)).toMatchObject({ state: 'rendering', items: 1 });
  release();
  await until(() => readFieldReelStatus(dir)?.state === 'done');
});
