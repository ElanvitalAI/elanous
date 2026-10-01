/**
 * 🖥️ 원격 무료 생성 — ***node-b 의 로컬 모델을 「이 기계의 노드」처럼 부른다.***
 *
 * ⛔⭐⭐ 이 파일이 답하는 것은 «하나»다:
 *   「무료 구현이 «다른 기계»에 있을 때, 파이프라인이 그것을 «자기 노드»로 쓸 수 있나」.
 *   ⇒ 그래야 RFC 의 주장(「유료는 품질·속도를 산다」)이 ***생성 축에서도*** 선다.
 *
 * ⛔ 실패 갈래를 «셋»으로 가른다 — 이 저장소의 상시 규율이다:
 *   ok            만들었다
 *   error         붙었는데 «실패»했다(모델 없음·인자 틀림 등)
 *   unmeasurable  ***못 물어봤다***(호스트 꺼짐·네트워크) — 「실패」가 «아니다»
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './ffmpeg.js';

export interface RemoteResult {
  readonly kind: 'ok' | 'error' | 'unmeasurable';
  readonly out?: string;
  readonly why?: string;
  readonly seconds?: number;
}

/** ⛔ 셸 인용은 «한 곳»에서만 만든다 — 손으로 두 번 쓰면 반드시 한쪽이 샌다. */
export const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * ⛔⭐ ***경로는 `shq` 로 인용하면 안 된다*** — 인용이 «틸데를 죽인다».
 *   `'~/a/b'` 는 확장되지 않고 ***`~` 라는 이름의 디렉토리***를 찾다가 조용히 「없다」가 된다.
 *   ⇒ `~/` 만 인용 «밖»에 두고 나머지를 인용한다. 그 외 경로는 `shq` 와 같다.
 * 🔎 반증: `shqPath('~/a b/c')` ⇒ `"$HOME"/'a b/c'` · `shqPath('/a b')` ⇒ `'/a b'`
 */
export const shqPath = (v: string): string =>
  v.startsWith('~/') ? `"$HOME"/${shq(v.slice(2))}` : shq(v);

/**
 * ⛔ 원격 명령의 «세 갈래»를 여기 한 곳에서만 만든다.
 *
 * ⛔⭐⭐ ***로그인 셸로 실행한다***(`bash -lc`) — 대표 정정 2026-09-22.
 *   🩸 계기: 비-로그인 ssh 는 `~/.zprofile`(brew shellenv)을 «안 읽어서» PATH 가 좁다.
 *      그래서 ***설치되어 있는 python 3.11 을 「없다」고 답했다.***
 *   ⇒ 여기 종전 문면은 `~/tts-venv/bin/python` 처럼 «경로를 박아» 그 함정을 피해 갔는데,
 *      brew 가 붙이는 것(`audiocpp_cli`)은 ***기계마다 자리가 달라 박을 수가 없다.***
 *   ⇒ 그래서 «피하기»가 아니라 «고치기»로 간다. `sshProbe` 와 «같은 규율»이다.
 */
export function sshRun(host: string, cmd: string, timeoutMs = 1_800_000): RemoteResult {
  const t0 = Date.now();
  const r = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
    `bash -lc ${shq(cmd)}`], timeoutMs);
  const seconds = Math.round((Date.now() - t0) / 1000);
  if (r.ok) return { kind: 'ok', seconds };
  if (r.code == null && r.signal == null) {
    return { kind: 'unmeasurable', why: `${host} 에 «못 붙었다» — ssh 를 실행할 수 없다(${r.err || '종료 코드 없음'})`, seconds };
  }
  // ⛔ ssh 자신이 못 붙은 것(255)과 «원격 명령이 실패한 것»을 섞지 않는다.
  if (r.code === 255 || r.signal !== null) {
    return { kind: 'unmeasurable', why: `${host} 에 «못 붙었다» — ${r.err.split('\n')[0] || `code=${r.code} signal=${r.signal}`}`, seconds };
  }
  return { kind: 'error', why: r.err.split('\n').filter(Boolean).slice(-2).join(' / ') || `code=${r.code}`, seconds };
}

/** 원격에서 만든 파일을 «이리로» 가져온다. ⛔ 못 가져오면 만든 것도 «없는 것»이다. */
export function scpFrom(host: string, remotePath: string, localPath: string): RemoteResult {
  mkdirSync(join(localPath, '..'), { recursive: true });
  const r = run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${host}:${remotePath}`, localPath], 600_000);
  if (r.ok) return { kind: 'ok', out: localPath };
  if (r.code == null && r.signal == null) {
    return { kind: 'unmeasurable', why: `${host} 에 «못 붙었다» — scp 를 실행할 수 없다(${r.err || '종료 코드 없음'})` };
  }
  if (r.code === 255 || r.signal !== null) return { kind: 'unmeasurable', why: `${host} 에 «못 붙었다»` };
  return { kind: 'error', why: `가져오기 실패: ${r.err.split('\n')[0]}` };
}

/** 🖼️ 이미지 — Qwen-Image-2.1 (mflux · MLX) */
export function genImage(host: string, opts: {
  prompt: string; outRemote: string; width: number; height: number; steps?: number; seed?: number;
}): RemoteResult {
  // ⛔ 프롬프트를 셸에 «그대로» 넣지 않는다 — 따옴표 하나로 명령이 갈린다(2026-09-22 에 데었다).
  const cmd = [
    '~/mflux-venv/bin/mflux-generate-qwen-2.1',
    '--prompt', shq(opts.prompt),
    '--quantize', '8',
    '--width', String(opts.width), '--height', String(opts.height),
    '--steps', String(opts.steps ?? 20),
    '--seed', String(opts.seed ?? 42),
    '--output', shqPath(opts.outRemote),
  ].join(' ');
  return sshRun(host, cmd);
}

/** 🔊 나레이션 — Qwen3-TTS VoiceDesign (mlx-audio · MLX) */
export function genVoice(host: string, opts: {
  text: string; instruct: string; outDirRemote: string; prefix: string; lang?: string;
}): RemoteResult {
  // ⛔ VoiceDesign 은 `--instruct` 가 «필수»다 — 안 주면 모델이 거부한다(실측).
  const cmd = [
    '~/tts-venv/bin/python -m mlx_audio.tts.generate',
    '--model mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit',
    '--text', shq(opts.text),
    '--instruct', shq(opts.instruct),
    '--lang_code', opts.lang ?? 'ko',
    '--output_path', shqPath(opts.outDirRemote),
    '--file_prefix', shq(opts.prefix),
    '--audio_format wav',
  ].join(' ');
  return sshRun(host, cmd);
}

/** 🎵 음악 — MiniMax-Music3 (mlx-audio · MLX) */
export function genMusic(host: string, opts: {
  caption: string; lyrics: string; outRemote: string; duration?: number; steps?: number; seed?: number;
}): RemoteResult {
  const cmd = [
    '~/tts-venv/bin/python -m mlx_audio.music.generate',
    '--model mlx-community/MiniMax-Music3-4bit',
    '--caption', shq(opts.caption),
    '--lyrics', shq(opts.lyrics),
    '--duration', String(opts.duration ?? 30),
    '--steps', String(opts.steps ?? 30),
    '--seed', String(opts.seed ?? 42),
    '--output', shqPath(opts.outRemote),
  ].join(' ');
  return sshRun(host, cmd);
}

/**
 * 🎵 음악 — 무료 엔진이 «셋»이고 ***런타임이 서로 다르다***(MLX · GGML×2).
 *
 * 🩸 2026-09-22 정정 — 종전에 나는 이 셋을 «한 칸»(`yue2-acestep`)으로 접어 놨었다. 둘 다 틀렸다:
 *   ⓐ acestep.cpp 최신 master 에 YuE2 지원은 **0건**이다 — YuE2 GGUF 는 «다른 엔진» audio.cpp 용.
 *   ⓑ *"YuE2 의 MLX 판은 없다"* 도 거짓 — `ahmadw/YuE2-3B-MLX` 가 있다(내 검색이 좁았다).
 * ⇒ 🔑 ***「무료 구현」을 런타임 하나로 가정하지 않는다.*** 엔진마다 한 칸을 둔다.
 */
export type MusicEngine = 'minimax-mlx' | 'yue2-audiocpp' | 'acestep-cpp';

/**
 * 🎤 YuE2-3B — audio.cpp(GGUF · Metal). ***가사가 있는 «노래»를 만드는 유일한 칸.***
 *
 * ⛔ 인자 계약을 «지어내지 않는다» — 이 꼴은 `audio-cpp/Yue2-3B-GGUF` README 의 실행 예에서 왔다
 *   (`graphs/video/README.md` §베낀 뒤 «먼저» 할 것 ③ — *"없는 인자를 지어내면 예산만 헛돈다"*).
 * ⚠️ `--model` 은 «파일이 아니라 디렉토리»다. gguf 는 `--session-option` 으로 «이름»만 준다.
 *
 * ⛔⭐⭐ ***이 엔진은 「길이」를 «못 시킨다».*** 📏 실측 2026-09-22:
 * ```
 * 요청 없음                 ⇒ 67.96s   (그중 가사는 44.0s 까지)
 * 요청 duration=40(미전달)  ⇒ 104.32s  (그중 가사는 40.2s 까지 — ***61%가 가사 밖***)
 * --duration-seconds 40     ⇒  60.16s  ← ***플래그를 「받아들이고» 무시한다***
 * ```
 * 🩸 ⇒ `--duration-seconds` 는 ***exit 0 을 내고 아무 일도 안 한다.*** 인자가 «있다»가 «먹는다»가 아니다.
 * 🔑 그래서 이 함수는 길이를 «약속하지 않는다». 부르는 쪽이 ***재서 자른다***
 *   (`probeSoundEnd` ⊕ `lyricFidelity().onScriptEnd`).
 * ⛔ 길이 인자를 받지 «않는» 것도 계약이다 — 받아 놓고 안 쓰면 「시켰는데 왜 안 되나」가 된다.
 */
export function genMusicYue2(host: string, opts: {
  lyrics: string; style: string; outRemote: string;
  modelDir?: string; steps?: number; seed?: number; cot?: 'off' | 'full' | 'melody';
}): RemoteResult {
  const cmd = [
    'audiocpp_cli --task gen --family yue2',
    '--model', shqPath(opts.modelDir ?? '~/yue2-models'),
    '--backend metal --threads 8',
    '--text', shq(opts.lyrics),
    '--request-option', shq(`style=${opts.style}`),
    '--request-option', `cot=${opts.cot ?? 'off'}`,
    '--request-option', `seed=${opts.seed ?? 42}`,
    '--request-option', `num_inference_steps=${opts.steps ?? 8}`,
    '--session-option yue2.model_gguf=yue2-3b-q8_0.gguf',
    '--session-option yue2.vae_gguf=yue2-vae-f16.gguf',
    '--out', shqPath(opts.outRemote),
    '--metrics',
  ].join(' ');
  return sshRun(host, cmd);
}

/**
 * 🎹 ACE-Step 1.5 — acestep.cpp(GGUF · Metal). ***가사 없는 «기악 배경»이 이쪽이다.***
 *
 * ⛔ 이 엔진은 «두 걸음»이다 — `ace-lm`(코드 생성) → `ace-synth`(소리로 굽기).
 *   한 걸음만 돌고 「됐다」고 하면 ***파일이 없다***.
 * ✅ 실측 2026-09-22: lm 17초 + synth 4초 ⇒ 19.2s / 48kHz / stereo (144x realtime).
 */
export function genMusicAcestep(host: string, opts: {
  caption: string; outRemote: string; lyrics?: string;
  duration?: number; bpm?: number; seed?: number; lang?: string; root?: string;
}): RemoteResult {
  const root = opts.root ?? '~/acestep.cpp';
  // ⛔⭐⭐ ***요청 스키마에 `lyrics` 가 «있는데» 1판은 안 보냈다.***
  //   🩸 실측 2026-09-22: 가사 4줄을 주고 불렀더니 받아쓰기가 이렇게 나왔다:
  //     "We are a young girl, young girl, bang집"  ×4  ⇒ 준 가사와 «한 줄도» 안 맞았다.
  //   ⇒ 나는 그것을 ***「이 엔진은 기악 전용인가 보다」로 읽을 뻔했다.*** 엔진 한계가 «아니라» 내 누락이다.
  //   🔎 반증: ssh node-b 'cat ~/acestep.cpp/tests/request0.json' ⇒ `lyrics`·`vocal_language` 칸이 «있다».
  //   🔑 ***「엔진이 못 한다」고 쓰기 전에 「내가 시켰나」를 먼저 재라.***
  //   ⛔ 빈 문자열을 보내지 않는다 — 기악을 원할 때 «빈 가사»는 다른 뜻이 될 수 있다.
  const req = JSON.stringify({
    caption: opts.caption,
    ...(opts.lyrics !== undefined && opts.lyrics.trim().length > 0
      ? { lyrics: opts.lyrics, vocal_language: opts.lang ?? 'en' }
      : {}),
    duration: opts.duration ?? 20, bpm: opts.bpm ?? 72, seed: opts.seed ?? 42,
  });
  // ⛔ 요청 JSON 을 heredoc 으로 넣지 않는다 — 중첩되면 따옴표가 «조용히» 벗겨진다(2026-09-22 실측).
  // ⛔⭐⭐ ***이 엔진은 «MP3 만» 낸다*** — 그런데 부르는 쪽은 `.wav` 를 달라고 한다.
  //
  // 🩸 실측 2026-09-22 (대표 께서 *"뮤직 생성 모델이 두가지가 있으니 둘다 테스트"* 하라 하셔서 잡혔다):
  //   1판은 `cp .pipeline-req00.mp3 <outRemote>` 였다 — ***이름만 .wav 이고 내용은 MP3***였다.
  //   ffmpeg 는 내용으로 읽으니 «합성은 됐고», 그래서 ***아무 데서도 안 터졌다.***
  //   터진 곳은 확장자를 믿는 곳이었다:
  // ```
  //   whisper(mlx-audio) ⇒ miniaudio.DecodeError: could not open/decode file
  //   ⇒ 가사 축이 «못 쟀다»로 떨어졌고, 그 이유가 ***「기악이라서」로 보였다***(아니었다)
  // ```
  // 🔑 ***확장자가 거짓말을 하면 「내용으로 읽는 도구」는 통과시키고 「이름으로 읽는 도구」만 죽는다.***
  //   ⇒ 한 엔진만 시험했으면 «영영» 못 봤다. 대표 의 「둘 다 테스트」가 그것을 드러냈다.
  const wantWav = /\.wav$/i.test(opts.outRemote);
  const tail = wantWav
    // ⛔ 확장자가 약속하는 «내용»으로 맞춘다 — 이름을 고치는 게 아니라 «변환»한다.
    ? `ffmpeg -hide_banner -loglevel error -y -i .pipeline-req00.mp3 -ar 48000 -ac 2 -c:a pcm_s16le ${shqPath(opts.outRemote)}`
    : `cp .pipeline-req00.mp3 ${shqPath(opts.outRemote)}`;
  const cmd = [
    `cd ${shqPath(root)} &&`,
    `printf %s ${shq(req)} > .pipeline-req.json &&`,
    './build/ace-lm --models ./models --request .pipeline-req.json &&',
    './build/ace-synth --models ./models --request .pipeline-req0.json &&',
    tail,
  ].join(' ');
  return sshRun(host, cmd);
}

/**
 * 🎛️ 엔진을 골라 부른다. ⛔ ***「못 쟀다」를 「실패」로 접지 않는다*** — 다음 엔진으로 가되 «왜»를 들고 간다.
 *   ⇒ 산출이 「어느 엔진이 만들었나」와 「어느 엔진을 못 물어봤나」를 «둘 다» 말한다.
 */
export function genMusicAny(host: string, order: readonly MusicEngine[], opts: {
  caption: string; lyrics: string; outRemote: string; duration?: number; seed?: number;
}): RemoteResult & { engine?: MusicEngine; skipped?: { engine: MusicEngine; why: string }[] } {
  const skipped: { engine: MusicEngine; why: string }[] = [];
  for (const engine of order) {
    const r =
      engine === 'yue2-audiocpp'
        ? genMusicYue2(host, { lyrics: opts.lyrics, style: opts.caption, outRemote: opts.outRemote, seed: opts.seed })
        : engine === 'acestep-cpp'
          // ⛔ 가사를 «넘긴다» — 1판은 여기서 떨어뜨렸고, 그래서 엔진이 딴 가사를 불렀다.
          ? genMusicAcestep(host, { caption: opts.caption, lyrics: opts.lyrics, outRemote: opts.outRemote, duration: opts.duration, seed: opts.seed })
          : genMusic(host, opts);
    if (r.kind === 'ok') return { ...r, engine, skipped };
    skipped.push({ engine, why: `${r.kind}: ${r.why ?? '(이유 없음)'}` });
  }
  // ⛔ 마지막 갈래를 «실패»로 고정하지 않는다 — 전부 「못 쟀다」였으면 그것이 답이다.
  const allUnmeasurable = skipped.every((s) => s.why.startsWith('unmeasurable'));
  return {
    kind: allUnmeasurable ? 'unmeasurable' : 'error',
    why: skipped.map((s) => `${s.engine} ⇒ ${s.why}`).join(' · '),
    skipped,
  };
}

/**
 * 📝 받아쓰기 — Whisper(mlx-audio · MLX). ***자막 타이밍을 「계획」이 아니라 「소리」에서 얻는다.***
 *
 * ⛔⭐ 이 축이 이 파이프라인의 마지막 「균등분할」을 없앤다.
 *   🩸 지금까지 `align` 은 ***내가 만든 소리를 잰 값***으로만 정렬했고, 미리 만든 나레이션이
 *      한 파일이면 ***컷 수로 균등분할***했다. 그 사실을 note 가 말하고 있었다.
 *   ⛔ 모델을 아무거나 쓰면 안 된다 — 2026-09-22 실측: `mlx-community/whisper-large-v3-turbo` 는
 *      파일이 «4개»뿐이라 `preprocessor_config.json` 이 없어 ***ValueError 로 죽는다.***
 *      ✅ `-asr-` 판(14파일)만 processor 를 갖는다.
 */
export function transcribe(host: string, opts: {
  audioRemote: string; outBaseRemote: string; lang?: string; model?: string;
}): RemoteResult {
  const cmd = [
    '~/tts-venv/bin/python -m mlx_audio.stt.generate',
    '--model', opts.model ?? 'mlx-community/whisper-large-v3-turbo-asr-4bit',
    '--audio', shqPath(opts.audioRemote),
    '--output-path', shqPath(opts.outBaseRemote),
    '--format srt',
    '--language', opts.lang ?? 'ko',
  ].join(' ');
  return sshRun(host, cmd);
}

/** SRT 를 «구간 목록»으로 읽는다. ⛔ 구간이 0개면 「타이밍을 못 얻었다」다 — 0초가 아니다. */
let LAST_SRT_DROPPED = 0;

export function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const toSec = (t: string): number => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t);
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  const out: { start: number; end: number; text: string }[] = [];
  let dropped = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const arrow = lines.find((l) => l.includes('-->'));
    if (!arrow) continue;
    const [a, b] = arrow.split('-->').map((x) => toSec(x.trim()));
    // ⛔⭐⭐ ***버리되 「버렸다」를 «센다».***
    //   🩸 2026-09-22: 여기가 `continue` 하나로 조용히 버리고 있었다.
    //     ⇒ 부르는 쪽은 ***「13개 중 2개가 깨졌다」와 「11개였다」를 구별할 수 없었다.***
    //     🔎 계기: 실물 ASR 산출에 `61.3 → 49.2`(끝<시작)가 있었고, 그것이 «말없이» 사라졌다.
    //   🔑 ***버리는 것 자체는 옳다. 말 안 하는 것이 결함이다.***
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) { dropped++; continue; }
    const body = lines.slice(lines.indexOf(arrow) + 1).join(' ').trim();
    out.push({ start: a, end: b, text: body });
  }
  LAST_SRT_DROPPED = dropped;
  return out;
}

/**
 * ⛔ 직전 `parseSrt` 가 «버린» 구간 수.
 *   ⚠️ 모듈 전역이라 «직전 호출»만 답한다 — 여러 SRT 를 섞어 읽으면 뜻이 흐려진다.
 *     ⇒ 읽었으면 «바로» 쓴다. (계약을 바꾸지 않고 수를 내보내는 가장 싼 길이다)
 */
export function lastSrtDropped(): number { return LAST_SRT_DROPPED; }
