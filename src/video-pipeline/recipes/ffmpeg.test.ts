/**
 * ⛔⭐ ***이 자들은 「못 쟀다」를 «가르는» 것이 일이다.*** 그 갈래가 시험 없이 살면 안 된다.
 *
 * 🩸 2026-09-22 — `probeSoundEnd` 에 ***fail-open*** 이 있었다:
 *   `silencedetect` 가 죽어도 무음 줄이 «한 줄도» 안 나오고, 그 상태가
 *   ***「무음 0 ⇒ 꼬리무음 0 ⇒ 정상」***으로 읽혔다.
 *   내가 손으로 한 번 눌러 고쳤고 ***그 누름을 버렸다.*** ⇒ 여기 옮긴다.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, probeDuration, probeSoundEnd, run } from './ffmpeg.js';

test('ffmpeg uses an explicit binary and otherwise resolves PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-bin-'));
  const override = join(dir, 'override');
  const pathBin = join(dir, 'ffmpeg');
  for (const bin of [override, pathBin]) {
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\n" "$0" >&2\nexit 0\n');
    chmodSync(bin, 0o755);
  }
  const oldOverride = process.env.ELANOUS_FFMPEG_BIN;
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}:${oldPath ?? ''}`;
    process.env.ELANOUS_FFMPEG_BIN = override;
    expect(ffmpeg(['-version']).err).toContain(override);
    delete process.env.ELANOUS_FFMPEG_BIN;
    expect(ffmpeg(['-version']).err).toContain(pathBin);
  } finally {
    if (oldOverride === undefined) delete process.env.ELANOUS_FFMPEG_BIN;
    else process.env.ELANOUS_FFMPEG_BIN = oldOverride;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 앞 `sound` 초는 소리, 뒤 `tail` 초는 «무음»인 파일. */
function makeAudio(dir: string, sound: number, tail: number): string {
  const p = join(dir, `a-${sound}-${tail}.wav`);
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sound}`,
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${tail}`,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', p], 60_000);
  if (!r.ok) throw new Error(`픽스처를 못 만들었다: ${r.err.split('\n')[0]}`);
  return p;
}

describe('probeSoundEnd — 「파일이 몇 초냐」와 「소리가 몇 초 나냐」는 다른 값이다', () => {
  const T = 60_000;

  test('⭐ 꼬리 무음을 «초로» 낸다', () => {
    const d = mkdtempSync(join(tmpdir(), 'fx-'));
    try {
      const r = probeSoundEnd(makeAudio(d, 3, 2));
      expect(r.dur).toBeGreaterThan(4.5);
      expect(r.soundEnd).toBeGreaterThan(2.5);
      expect(r.soundEnd).toBeLessThan(3.6);        // 소리는 3초쯤에서 끝난다
      expect(r.tailSilence).toBeGreaterThan(1.4);  // 꼬리 2초쯤
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('꼬리 무음이 «없으면» 0 이다 — null 이 아니다', () => {
    const d = mkdtempSync(join(tmpdir(), 'fx-'));
    try {
      const r = probeSoundEnd(makeAudio(d, 3, 0));
      expect(r.tailSilence).toBe(0);
      expect(r.soundEnd).toBe(r.dur);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  // ⛔⭐ ***이 시험은 「의도한 가지」에 «못 닿는다».*** 그 사실을 숨기지 않는다.
  //   `probeSoundEnd` 의 `!r.ok`(무음 검사 «실패») 가지는 ***자연 픽스처로 못 만든다***:
  //     ⓐ 오디오가 «아닌» 파일 ⇒ «길이» 단계에서 먼저 걸린다(이 가지까지 못 간다)
  //     ⓑ 오디오가 «없는» 영상 ⇒ silencedetect 이 rc=0 으로 «성공»한다
  //   🔑 ***그래서 이 시험이 지키는 것은 「무음 검사 실패」가 아니라 「못 쟀다를 통과로 안 읽는다」다.***
  //     ⛔ 「fail-open 을 시험이 막는다」고 말하면 «거짓»이다 — 그 가지는 여전히 방어적 코드다.
  //   ⊕ 그 대신 ⓑ 를 파다가 ***더 큰 결함***이 나왔다(바로 아래 시험).
  test('⛔ 오디오가 «아닌» 파일은 「정상」이 아니라 «못 쟀다» (길이 단계에서 걸린다)', () => {
    const d = mkdtempSync(join(tmpdir(), 'fx-'));
    try {
      const p = join(d, 'notaudio.wav');
      writeFileSync(p, 'this is not audio at all', 'utf8');
      const r = probeSoundEnd(p);
      // ⛔ 여기서 tailSilence 가 0 이면 ***「못 쟀다」가 「깨끗하다」로 샌 것***이다.
      expect(r.tailSilence).toBeNull();
      expect(r.dur).toBeNull();
      expect(r.why ?? '').not.toBe('');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('⛔⭐⭐ ***소리가 «아예 없는» 파일을 「끝까지 소리가 난다」고 하지 않는다***', () => {
    // 🩸 실측: 오디오 스트림이 없는 영상에 `{dur:2, soundEnd:2, tailSilence:0}` 를 냈다 — ***「정상」***이다.
    //   ⛔ `silencedetect` 는 오디오가 없으면 «아무 줄도» 안 낸다.
    //     ⇒ 「무음이 없다」와 「소리가 없다」가 ***같은 증거***를 남긴다 — 정반대인데.
    const d = mkdtempSync(join(tmpdir(), 'fx-'));
    try {
      const p = join(d, 'noaudio.mp4');
      const r0 = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=black:s=64x64:d=2:r=30', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', p], 60_000);
      expect(r0.ok).toBe(true);
      const r = probeSoundEnd(p);
      expect(r.dur).toBeCloseTo(2, 1);          // 길이는 «잰다»
      expect(r.soundEnd).toBeNull();            // ⛔ 2 라고 하면 거짓이다
      expect(r.tailSilence).toBeNull();
      expect(r.why ?? '').toContain('오디오 스트림이 «없다»');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('⛔ 없는 파일도 «못 쟀다»다', () => {
    const r = probeSoundEnd('/없는/경로/x.wav');
    expect(r.dur).toBeNull();
    expect(r.why ?? '').toContain('못 쟀다');
  }, T);
});

describe('probeDuration — ⛔ 컨테이너가 말하는 길이가 아니라 «프레임을 센다»', () => {
  const T = 60_000;

  test('프레임 수 ÷ fps 로 답한다', () => {
    const d = mkdtempSync(join(tmpdir(), 'fx-'));
    try {
      const p = join(d, 'v.mp4');
      const r0 = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=black:s=64x64:d=2:r=30', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', p], 60_000);
      expect(r0.ok).toBe(true);
      const r = probeDuration(p);
      expect(r.frames).toBe(60);
      expect(r.fps).toBe(30);
      expect(r.dur).toBeCloseTo(2, 1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('⛔ 못 재면 «0」이 아니라 null 이고, «왜»를 말한다', () => {
    const r = probeDuration('/없는/경로/x.mp4');
    expect(r.dur).toBeNull();
    expect(r.frames).toBeNull();
    expect(r.why ?? '').not.toBe('');
  }, T);
});
