/** ⛔ ffmpeg 를 «부르는 한 자리» — 각 레시피가 따로 부르면 함정도 따로 밟는다. */
import { spawnSync } from 'node:child_process';

export interface RunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  /** ⛔ stderr 를 버리지 않는다 — ffmpeg 는 «거기»에 이유를 적는다. */
  readonly err: string;
  readonly out: string;
}

export function run(bin: string, args: readonly string[], timeoutMs = 180_000): RunResult {
  const r = spawnSync(bin, [...args], { encoding: 'utf8', timeout: timeoutMs });
  // ⛔ 「죽었다」와 「거부했다」를 섞지 않는다 — 시그널로 죽으면 status 가 null 이다.
  return {
    ok: r.status === 0,
    code: r.status,
    signal: r.signal ?? null,
    err: r.stderr?.trim() || r.error?.message || '',
    out: (r.stdout ?? '').trim(),
  };
}

export const ffmpeg = (args: readonly string[], t?: number): RunResult =>
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], t);

/**
 * ⛔⭐⭐ 되읽기의 «단 하나의» 자 — 길이를 «컨테이너 헤더»가 아니라 ***센 프레임***으로 읽는다.
 *   🩸 계기(2026-09-16 · 이 저장소의 기록): `zoompan` 의 `d` 는 ***입력 프레임당 출력 프레임***이라
 *      `-loop 1 -t 2.4` 가 151.6초를 냈다. ***컨테이너가 말하는 duration 은 그때도 「맞는 값」이었다.***
 *   ⇒ 그래서 `-count_frames` 로 «실제 프레임»을 세고 fps 로 나눈다.
 */
export function probeDuration(path: string): { dur: number | null; frames: number | null; fps: number | null; why?: string } {
  const r = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames,avg_frame_rate,duration',
    '-of', 'default=noprint_wrappers=1:nokey=0', path,
  ]);
  if (!r.ok) return { dur: null, frames: null, fps: null, why: `ffprobe 실패: ${r.err.split('\n')[0]}` };
  const get = (k: string): string | undefined => r.out.split('\n').find((l) => l.startsWith(`${k}=`))?.split('=')[1];
  const frames = Number(get('nb_read_frames'));
  const rate = get('avg_frame_rate') ?? '0/1';
  const [n, d] = rate.split('/').map(Number);
  const fps = d ? n / d : null;
  if (!Number.isFinite(frames) || frames <= 0 || fps === null || !Number.isFinite(fps) || fps <= 0) {
    // ⛔ 「0」을 「길이 0」으로 읽지 않는다 — 「못 쟀다」다.
    return { dur: null, frames: null, fps: null, why: `프레임/fps 를 못 읽었다(frames=${get('nb_read_frames')} rate=${rate})` };
  }
  return { dur: frames / fps, frames, fps };
}

/**
 * 🔇⭐ ***「파일이 몇 초냐」와 「소리가 몇 초까지 나냐」는 다른 값이다.***
 *
 * 🩸 계기 2026-09-22 — ACE-Step 1.5(GGUF)에 40초를 시켰더니 파일은 39.60초인데
 *   ***마지막 3.03초가 무음***이었다. 20초를 시켰던 판은 ***4.95초(26%)가 무음***이었다.
 *   ⇒ 「길이 39.6초 ✅」만 보면 ***음악이 3초 일찍 끝나는 광고***가 그대로 나간다.
 *   ⛔ 그리고 꼬리 무음은 «비례하지 않는다»(4.95s vs 3.03s) — 상수로 빼도 틀린다.
 *
 * 🔑 그래서 이 함수는 «재기만» 한다 — 고치는 것(여유를 더 달라고 하기·자르기)은 부르는 쪽 몫이다.
 *
 * ⛔ 반환 셋: 잰 값 · `null`(***못 쟀다***) · `end === dur`(꼬리 무음 «없다»).
 *   「못 쟀다」를 0 으로 접지 않는다 — 0 은 「통째로 무음」이라는 «다른 사실»이다.
 */
export function probeSoundEnd(path: string, thresholdDb = -45, minGap = 0.6):
  { dur: number | null; soundEnd: number | null; tailSilence: number | null; why?: string } {
  const d = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path]);
  const dur = d.ok ? Number(d.out.trim()) : NaN;
  if (!Number.isFinite(dur) || dur <= 0) {
    return { dur: null, soundEnd: null, tailSilence: null, why: `길이를 못 쟀다: ${d.err.split('\n')[0] || d.out.trim()}` };
  }
  // ⛔ silencedetect 는 «stderr» 로 낸다 — stdout 만 읽으면 언제나 「구간 0」이 된다.
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', path,
    '-af', `silencedetect=n=${thresholdDb}dB:d=${minGap}`, '-f', 'null', '-']);
  // ⛔⭐⭐ ***fail-open 을 막는다*** — 1판은 여기서 `r.ok` 를 «안 봤다».
  //   ffmpeg 가 죽으면 무음 줄이 «한 줄도» 안 나오고, 그 상태가 아래에서
  //   ***「무음 구간 0 ⇒ 꼬리무음 0 ⇒ 정상」***으로 읽힌다.
  //   🔑 ***「못 쟀다」가 「깨끗하다」와 «같은 얼굴»이 되는*** 이 저장소의 1번 결함 가족이다.
  if (!r.ok) {
    return { dur, soundEnd: null, tailSilence: null,
      why: `무음 검사가 실패했다(code=${r.code} signal=${r.signal}): ${r.err.split('\n').filter(Boolean).slice(-1)[0] ?? ''}` };
  }
  // ⛔⭐⭐ ***소리가 «아예 없는» 파일을 「끝까지 소리가 난다」고 답하고 있었다.***
  //
  // 🩸 실측 2026-09-22 — 오디오 스트림이 «없는» 영상에 대고:
  // ```
  //   { dur: 2, soundEnd: 2, tailSilence: 0 }   ⇐ ***「정상」으로 읽힌다***
  // ```
  //   ⛔ `silencedetect` 는 «오디오가 없으면» 아무 줄도 안 낸다 — 그리고 아래 로직은
  //     「무음 줄이 없다 = 끝까지 소리가 있다」로 읽었다. ***두 사실이 같은 산출을 낸다.***
  //   🔑 ***「무음이 없다」와 「소리가 없다」는 «정반대»인데 증거가 같다.***
  //     ⇒ 그래서 ***오디오 스트림이 있나를 «따로» 묻는다.***
  //   🔎 이 결함은 fail-open 시험을 쓰다 나왔다 — 그 가지를 못 만들어 헤매던 중에
  //     ***더 큰 것이 옆에 있었다.***
  const hasAudio = run('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', path]);
  if (!hasAudio.ok) {
    return { dur, soundEnd: null, tailSilence: null, why: '오디오 스트림을 «못 물어봤다»' };
  }
  if (hasAudio.out.trim().length === 0) {
    return { dur, soundEnd: null, tailSilence: null, why: '오디오 스트림이 «없다» — 잴 소리가 없다' };
  }
  const text = `${r.err}\n${r.out}`;
  // 파일 «끝까지 이어지는» 무음만 꼬리다 — 중간 무음은 꼬리가 아니다.
  const starts = [...text.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  if (starts.length === 0) return { dur, soundEnd: dur, tailSilence: 0 };
  const lastStart = starts[starts.length - 1]!;
  const lastEnd = ends.length >= starts.length ? ends[ends.length - 1]! : dur;
  // 마지막 무음이 «파일 끝에 닿지 않으면» 꼬리가 아니다(0.05s 여유).
  if (lastEnd < dur - 0.05) return { dur, soundEnd: dur, tailSilence: 0 };
  return { dur, soundEnd: lastStart, tailSilence: dur - lastStart };
}
