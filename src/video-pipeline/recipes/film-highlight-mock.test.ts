// 모의 하이라이트 — 합성 영상 입력으로 기존 렌더 연결만 확인한다.
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ffmpeg } from './ffmpeg.js';
import { assembleMaster, masterSpanGate, type PlanRow } from './film.js';
import type { RecipeCtx } from './types.js';

let root = '';
const ctxOf = (workdir: string, state: Record<string, unknown>): RecipeCtx => ({ workdir, state, log: () => {} });

function rgbAt(path: string, seconds: number, output: string): number[] {
  const result = ffmpeg(['-ss', String(seconds), '-i', path, '-frames:v', '1', '-vf', 'scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', output]);
  if (!result.ok) throw new Error(`프레임 픽셀을 못 읽었다: ${result.err}`);
  const pixel = [...readFileSync(output)];
  if (pixel.length !== 3) throw new Error(`RGB 샘플 길이가 3이 아니다: ${pixel.length}`);
  return pixel;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [relative(root, path)];
  }).sort();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'film-highlight-mock-'));
  for (const [name, color] of [['briefing-mock', 'blue'], ['browser-mock', 'green']] as const) {
    const generated = ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:r=24:d=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, `${name}.mp4`)]);
    if (!generated.ok) throw new Error(`${name} 모의 입력 생성 실패: ${generated.err}`);
  }
}, 60_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('두 독립 장면의 합성 영상을 만들고 ffprobe 실측 길이가 계획과 맞는다', async () => {
  const plan: PlanRow[] = [['briefing-mock', 0, 1], ['browser-mock', 1, 1]];
  const workdir = join(root, 'work');
  const assembled = await assembleMaster(ctxOf(workdir, {
    plan,
    shot_sources: {
      'briefing-mock': join(root, 'briefing-mock.mp4'),
      'browser-mock': join(root, 'browser-mock.mp4'),
    },
    fps: 24,
  }));
  expect(assembled.outcome).toBe('ok');
  expect(assembled.produced?.engine).toBe('ffmpeg');
  expect(assembled.produced?.expected_seconds).toBe(2);
  const masterPath = String(assembled.produced?.master_path);
  expect(existsSync(masterPath)).toBe(true);

  // The two inputs must both reach the real assembled master; duration alone would also pass for a duplicated or blank clip.
  const probeDir = join(root, 'probes');
  mkdirSync(probeDir, { recursive: true });
  const firstPixel = rgbAt(masterPath, 0.5, join(probeDir, 'first.rgb'));
  const secondPixel = rgbAt(masterPath, 1.5, join(probeDir, 'second.rgb'));
  expect(firstPixel[2]!).toBeGreaterThan(firstPixel[0]! + 40); // first clip is blue
  expect(firstPixel[2]!).toBeGreaterThan(firstPixel[1]! + 40);
  expect(secondPixel[1]!).toBeGreaterThan(secondPixel[0]! + 40); // second clip is green
  expect(secondPixel[1]!).toBeGreaterThan(secondPixel[2]! + 40);

  // Canonicalize the actual output and make the renderer's complete on-disk output set explicit.
  const realRoot = realpathSync(root);
  const realMaster = realpathSync(masterPath);
  const masterRelative = relative(realRoot, realMaster);
  expect(masterRelative.startsWith(`..${sep}`) || masterRelative === '..').toBe(false);
  expect(masterRelative).toBe(join('work', 'master', 'master_16x9.mp4'));
  const measured = await masterSpanGate(ctxOf(workdir, {
    master_path: assembled.produced?.master_path,
    expected_seconds: assembled.produced?.expected_seconds,
    fps: 24,
  }));
  expect(measured.outcome).toBe('spans');
  expect(measured.produced?.span_ok).toBe(true);
  expect(measured.produced?.measured_seconds).toBeCloseTo(2, 2);
  expect(filesUnder(root)).toEqual([
    'briefing-mock.mp4',
    'browser-mock.mp4',
    'probes/first.rgb',
    'probes/second.rgb',
    'work/master/master_16x9.mp4',
  ]);
}, 60_000);
