import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { isBlankFrame, parseArgs } from './demo-rehearsal.js';
import { judgeScene, type SceneObservation } from './lib/rehearsal-verdict.js';

const required = ['--url', 'http://127.0.0.1:31415', '--out', '/tmp/rehearsal'];

test('import is inert and defaults to 20 seconds, 1920x1080 and demo mode', () => {
  expect(parseArgs(required)).toEqual({ url: 'http://127.0.0.1:31415', out: '/tmp/rehearsal', secs: 20, width: 1920, height: 1080, demo: true, tokenStdin: false });
});

test('no-demo includes scene 5, size and seconds parse explicitly', () => {
  expect(parseArgs([...required, '--no-demo', '--size', '1280x720', '--secs', '2.5', '--token-stdin'])).toMatchObject({ secs: 2.5, width: 1280, height: 720, demo: false, tokenStdin: true });
});

test('whole captured frame distinguishes dark or grey blank from content at the top above empty space', async () => {
  const width = 320;
  const height = 180;
  const blank = async (color: number) => (await sharp({ create: { width, height, channels: 3, background: { r: color, g: color, b: color } } }).jpeg({ quality: 92 }).toBuffer()).toString('base64');
  const content = Buffer.alloc(width * height * 3, 255);
  // Visible scene content occupies the top; the entire bottom is blank.
  for (let y = 12; y < 48; y++) for (let x = 20; x < 170; x++) {
    if (x % 12 < 6 && y % 9 < 5) content.fill(20, (y * width + x) * 3, (y * width + x + 1) * 3);
  }
  const topContent = (await sharp(content, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()).toString('base64');
  const obs: SceneObservation = { scene: 3, title: '루프 에이전트', hiddenByDemo: false, secs: 1, frames: 1, exceptions: [], failedRequests: [], textLength: 40, leaks: [], sectionsInDom: 6, visibleScene: 3 };
  const rect = { x: 0, y: 0, width, height };
  for (const color of [0, 120, 255]) {
    expect(judgeScene({ ...obs, blankFrames: Number(await isBlankFrame(await blank(color), rect)) }).verdict).toBe('broken');
  }
  expect(judgeScene({ ...obs, blankFrames: Number(await isBlankFrame(topContent, rect)) }).verdict).toBe('ok');
  const pageChrome = Buffer.alloc(width * height * 3, 0);
  for (let y = 0; y < 30; y++) for (let x = 0; x < width; x++) {
    if (x % 12 < 6) pageChrome.fill(255, (y * width + x) * 3, (y * width + x + 1) * 3);
  }
  const chromeOnly = (await sharp(pageChrome, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()).toString('base64');
  expect(await isBlankFrame(chromeOnly, { x: 0, y: 45, width, height: 135 })).toBe(true);
  expect(await isBlankFrame(topContent, null)).toBe(true);
});

test('invalid seconds and dimensions fail before launch', () => {
  for (const value of ['0', '-2', 'NaN', 'Infinity', 'abc']) expect(() => parseArgs([...required, '--secs', value])).toThrow();
  expect(() => parseArgs([...required, '--size', '0x720'])).toThrow();
  expect(() => parseArgs([...required, '--size', '720'])).toThrow();
  expect(() => parseArgs(['--out', '/tmp/rehearsal'])).toThrow();
});
