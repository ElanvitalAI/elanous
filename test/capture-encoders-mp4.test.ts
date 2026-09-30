// ── IUL Phase V·b — mp4 encoder tests ──
//
// Two layers:
//   1. Probe + fallback semantics (no real ffmpeg required)
//   2. End-to-end encode (skipped when ffmpeg not on PATH)
//
// (1) injects `probe` and `spawnProcess` so the suite stays
// hermetic; (2) is gated on a runtime probe so CI without ffmpeg
// just skips it.

import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  encodeMp4,
  isMp4Buffer,
  probeFfmpeg,
  Mp4UnavailableError,
  Mp4EncodeError,
  __resetFfmpegProbeCache,
  readPngDims,
  buildScalePadFilter,
} from '../src/capture/encoders/mp4.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TINY_DIMS = { cols: 4, rows: 2 };

/** 최소 유효 PNG(전체 signature + IHDR 청크 타입 + dims·raster 불요) — readPngDims/pngPath 경로 테스트용. */
function fakePng(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); // 전체 signature
  b.writeUInt32BE(13, 8);          // IHDR length
  b.write('IHDR', 12, 'ascii');    // IHDR 청크 타입
  b.writeUInt32BE(w, 16);          // width
  b.writeUInt32BE(h, 20);          // height
  return b;
}

describe('mp4 · header sniff', () => {
  test('isMp4Buffer accepts a valid ftyp-prefixed buffer', () => {
    const buf = Buffer.alloc(16);
    buf.write('mock', 0);
    buf.write('ftyp', 4);
    expect(isMp4Buffer(buf)).toBe(true);
  });

  test('isMp4Buffer rejects buffers without ftyp at offset 4', () => {
    expect(isMp4Buffer(Buffer.from('GIF89a-pad'))).toBe(false);
    expect(isMp4Buffer(Buffer.alloc(8))).toBe(false);
  });
});

describe('mp4 · probe + unavailable path', () => {
  test('throws Mp4UnavailableError when probe returns undefined', async () => {
    await expect(
      encodeMp4({
        frames: [{ ansi: 'hi' }],
        dims: TINY_DIMS,
        probe: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(Mp4UnavailableError);
  });

  test('throws Mp4EncodeError on empty frame list', async () => {
    await expect(
      encodeMp4({ frames: [], probe: async () => '/usr/bin/ffmpeg' }),
    ).rejects.toBeInstanceOf(Mp4EncodeError);
  });

  test('ANSI frame without dims is rejected before ffmpeg spawn', async () => {
    const spawnFn: typeof spawn = (() => {
      throw new Error('spawn must not be called');
    }) as never;
    await expect(
      encodeMp4({
        frames: [{ ansi: 'hi' }],
        probe: async () => '/usr/bin/ffmpeg',
        spawnProcess: spawnFn,
      }),
    ).rejects.toBeInstanceOf(Mp4EncodeError);
  });

  test('frame missing both svg and ansi is rejected before spawn', async () => {
    const spawnFn: typeof spawn = (() => {
      throw new Error('spawn must not be called');
    }) as never;
    await expect(
      encodeMp4({
        frames: [{} as never],
        dims: TINY_DIMS,
        probe: async () => '/usr/bin/ffmpeg',
        spawnProcess: spawnFn,
      }),
    ).rejects.toBeInstanceOf(Mp4EncodeError);
  });
});

describe('mp4 · probe caching', () => {
  test('probeFfmpeg returns a string when ffmpeg is on PATH (smoke)', async () => {
    __resetFfmpegProbeCache();
    const result = await probeFfmpeg();
    // Either ffmpeg exists (string path) or it doesn't (undefined) —
    // both are valid; the assertion is just that the call resolves.
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  test('cached probe returns same value without re-running which', async () => {
    __resetFfmpegProbeCache();
    const a = await probeFfmpeg();
    const b = await probeFfmpeg();
    expect(a).toBe(b);
  });
});

// ── End-to-end (gated) — runs only when ffmpeg is available ─────

const ffmpegAvailable = await probeFfmpeg().then(p => !!p, () => false);
const endToEndTest = ffmpegAvailable ? test : test.skip;

describe('mp4 · end-to-end (ffmpeg present)', () => {
  endToEndTest('encodes 3 ANSI frames into a valid MP4 buffer', async () => {
    const mp4 = await encodeMp4({
      frames: [
        { ansi: 'aa\n--' },
        { ansi: 'bb\n--' },
        { ansi: 'cc\n--' },
      ],
      dims: TINY_DIMS,
      fps: 5,
    });
    expect(Buffer.isBuffer(mp4)).toBe(true);
    expect(mp4.length).toBeGreaterThan(100);
    expect(isMp4Buffer(mp4)).toBe(true);
  });

  endToEndTest('rejects with Mp4EncodeError when ffmpeg arg list is invalid', async () => {
    // Force an invalid codec to make ffmpeg exit non-zero.
    await expect(
      encodeMp4({
        frames: [{ ansi: 'a' }, { ansi: 'b' }],
        dims: TINY_DIMS,
        codec: 'definitely-not-a-codec',
      }),
    ).rejects.toBeInstanceOf(Mp4EncodeError);
  });

  // ⭐ pngPath 실 프레임(keyframe 하이라이트릴 경로) — 서로 다른 해상도 실 PNG → 해상도 통일 → 실 ffmpeg → 유효 MP4.
  endToEndTest('pngPath 실 프레임(다른 해상도) → 유효 MP4(mock 아닌 실 인코딩·must-fix)', async () => {
    const { svgToPng } = await import('../src/capture/encoders/png.js');
    const dir = mkdtempSync(join(tmpdir(), 'mp4-e2e-png-'));
    try {
      const p1 = join(dir, 'a.png');
      const p2 = join(dir, 'b.png');
      // 이모지 없는 단순 도형 SVG — sharp 안전(Pango abort 무관)·서로 다른 dims(해상도 통일 경로 실증).
      writeFileSync(p1, await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="16"><rect width="20" height="16" fill="#111"/></svg>', { background: '#000' }));
      writeFileSync(p2, await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#222"/></svg>', { background: '#000' }));
      const mp4 = await encodeMp4({ frames: [{ pngPath: p1 }, { pngPath: p2 }], fps: 1 });
      expect(isMp4Buffer(mp4)).toBe(true);
      expect(mp4.length).toBeGreaterThan(100);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});

// ── PNG 직접 프레임(pngPath) + 해상도 통일 — keyframe 하이라이트릴 경로 회귀 가드(2026-07-26) ──
describe('mp4 · readPngDims (순수·헤더만)', () => {
  test('유효 PNG → dims', () => {
    expect(readPngDims(fakePng(800, 600))).toEqual({ w: 800, h: 600 });
  });
  test('비-PNG/짧은 버퍼 → null', () => {
    expect(readPngDims(Buffer.from('not a png'))).toBeNull();
    expect(readPngDims(Buffer.alloc(10))).toBeNull();
  });
  test('signature 만 있고 IHDR 청크 타입 아님 → null(손상 임의바이트 오해석 방지)', () => {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.write('XXXX', 12, 'ascii'); // IHDR 아님
    b.writeUInt32BE(999, 16); b.writeUInt32BE(999, 20);
    expect(readPngDims(b)).toBeNull();
  });
  test('거대 dims(상한 초과) → null(ffmpeg 캔버스 폭주 방지)', () => {
    expect(readPngDims(fakePng(200000, 10))).toBeNull();
  });
});

describe('mp4 · buildScalePadFilter (공통 해상도 통일)', () => {
  test('다중 해상도 → 공통 짝수 박스로 scale+pad(최대 dims)', () => {
    const vf = buildScalePadFilter([fakePng(800, 600), fakePng(1024, 768), fakePng(640, 480)]);
    // 최대 1024x768(이미 짝수) 박스로 통일 — libx264 프레임크기 불일치 방지.
    expect(vf).toContain('scale=1024:768:force_original_aspect_ratio=decrease');
    expect(vf).toContain('pad=1024:768');
  });
  test('홀수 dims → 짝수로 올림(libx264 요건)', () => {
    const vf = buildScalePadFilter([fakePng(801, 599)]);
    expect(vf).toContain('scale=802:600');
  });
  test('dims 파싱 실패 → 짝수-스케일 폴백', () => {
    expect(buildScalePadFilter([Buffer.from('x')])).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  });
});

describe('mp4 · pngPath 프레임 입력(encoder-level)', () => {
  test('pngPath 를 실제로 읽는다 — 존재하지 않는 경로면 인코딩 실패(입력 경로 실행 증명)', async () => {
    // pngPath 브랜치가 readFile 를 타는지 = 없는 파일이면 reject. spawn 은 프레임 준비 실패로 도달 안 함.
    const spawnFn: typeof spawn = (() => { throw new Error('spawn must not be reached'); }) as never;
    await expect(
      encodeMp4({
        frames: [{ pngPath: '/nonexistent/kf-000.png' }],
        probe: async () => '/usr/bin/ffmpeg',
        spawnProcess: spawnFn,
      }),
    ).rejects.toBeInstanceOf(Mp4EncodeError);
  });

  test('실 pngPath 파일을 읽어 프레임 준비까지 도달(spawn 직전) — readFile 경로 실검증', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp4-png-'));
    try {
      const p = join(dir, 'kf.png');
      writeFileSync(p, fakePng(100, 80));
      let reachedSpawn = false;
      const spawnFn: typeof spawn = (() => { reachedSpawn = true; throw new Error('stop at spawn'); }) as never;
      await expect(
        encodeMp4({ frames: [{ pngPath: p }], probe: async () => '/usr/bin/ffmpeg', spawnProcess: spawnFn }),
      ).rejects.toBeInstanceOf(Mp4EncodeError);
      expect(reachedSpawn).toBe(true); // 프레임(pngPath) 읽기 성공 → ffmpeg spawn 까지 도달
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
