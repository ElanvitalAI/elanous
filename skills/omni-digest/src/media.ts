/**
 * 첨부 영상 다운로드 + STT 전사
 *
 * 엔진 우선순위:
 *   1. 로컬 whisper CLI (무료·오프라인, `whisper` 설치 시)
 *   2. youtube-master 의 transcribeChunks (ElevenLabs / OpenAI / Gemini 폴백 체인)
 *
 * X 는 media.variants 로 MP4 직링크를 주므로 yt-dlp 없이 curl 로 바로 받는다.
 */

import { execFile as execFileCb } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { accessSync, constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { env } from './env.js';
import type { TweetMedia } from './types.js';

const execFile = promisify(execFileCb);

/** STT 대상으로 삼을 최대 재생 길이 (기본 20분) */
const MAX_DURATION_MS = Number(env('OMNI_DIGEST_MEDIA_MAX_MS', String(20 * 60 * 1000)));
/** 오디오 분할 단위 (초) — 긴 영상에서 API 업로드 한도 회피 */
const CHUNK_SECONDS = 600;

function has(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { accessSync(join(dir, bin), constants.X_OK); return true; } catch { /* try next directory */ }
  }
  return false;
}

const missingEngines = new Set<string>();

export function mediaEngineAvailable(engine: 'ffmpeg' | 'whisper'): boolean {
  if (has(engine)) return true;
  if (!missingEngines.has(engine)) {
    missingEngines.add(engine);
    if (engine === 'ffmpeg') console.error('ffmpeg 없음 — 영상 오디오 추출·전사 빠짐 · 설치하면 영상 전사 켜짐');
    else console.error('whisper 없음 — 로컬 음성 전사 빠짐 · 설치하면 오프라인 전사 켜짐 (youtube-master 폴백은 계속)');
  }
  return false;
}

async function run(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** MP4 직링크를 내려받는다. */
export async function downloadVideo(url: string, outdir: string): Promise<string> {
  await mkdir(outdir, { recursive: true });
  const out = join(outdir, 'media.mp4');
  await run('curl', ['-sL', '--fail', '-o', out, url]);
  if (!existsSync(out)) throw new Error('영상 다운로드 실패');
  return out;
}

/** 영상에서 16kHz 모노 mp3 를 추출한다 (STT 엔진 공통 입력 규격). */
export async function extractAudio(videoPath: string, outdir: string): Promise<string> {
  if (!mediaEngineAvailable('ffmpeg')) throw new Error('ffmpeg 가 필요합니다 (brew install ffmpeg)');
  const out = join(outdir, 'audio.mp3');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4',
    out,
  ]);
  if (!existsSync(out)) throw new Error('오디오 추출 실패');
  return out;
}

/** 로컬 whisper CLI 전사. 미설치면 null 을 반환해 폴백을 유도한다. */
async function transcribeLocalWhisper(audioPath: string, outdir: string, lang: string): Promise<string | null> {
  if (!mediaEngineAvailable('whisper')) return null;
  const model = env('OMNI_DIGEST_WHISPER_MODEL', 'small');
  try {
    await run('whisper', [
      audioPath,
      '--model', model,
      '--language', lang,
      '--output_format', 'txt',
      '--output_dir', outdir,
    ]);
    const txt = (await readdir(outdir)).find((f: string) => f.endsWith('.txt'));
    if (!txt) return null;
    const text = (await readFile(join(outdir, txt), 'utf-8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

/** youtube-master 의 STT 체인(ElevenLabs → OpenAI → Gemini)으로 폴백. */
export async function transcribeViaYoutubeMaster(audioPath: string, outdir: string): Promise<string | null> {
  const skillRoot = env('YOUTUBE_MASTER_ROOT', join(process.env.HOME || '', '.claude/skills/youtube-master'));
  const script = join(skillRoot, 'scripts/transcribe-local.ts');
  if (!existsSync(script)) return null;

  if (!mediaEngineAvailable('ffmpeg')) return null;
  // transcribe-local.ts 는 chunk_%03d.mp3 가 든 디렉터리를 입력으로 받는다
  const chunksDir = join(outdir, 'chunks');
  await mkdir(chunksDir, { recursive: true });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', audioPath,
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    '-c', 'copy', join(chunksDir, 'chunk_%03d.mp3'),
  ]);

  const outFile = join(outdir, 'transcript.txt');
  try {
    await run(process.execPath, [script, chunksDir, outFile]);
    const text = (await readFile(outFile, 'utf-8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

export interface MediaTranscript {
  transcript: string;
  engine: 'local-whisper' | 'youtube-master-stt';
  durationMs?: number;
}

/**
 * 트윗 첨부 영상을 받아 전사한다.
 * 영상이 없거나 너무 길거나 모든 엔진이 실패하면 null (요약은 그대로 진행).
 */
/** 오디오 스트림이 있나 — X 데모 영상은 무음이 많고, 그때 ffmpeg -vn 은 «Invalid argument» 로 죽는다. 못 재면 있다고 본다. */
async function hasAudioStream(videoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath]);
    return stdout.trim().length > 0;
  } catch { return true; }
}

export async function transcribeTweetMedia(
  media: TweetMedia[],
  opts: { lang?: string } = {},
): Promise<MediaTranscript | null> {
  const video = media.find(m => (m.type === 'video' || m.type === 'animated_gif') && (m.sttMp4Url || m.bestMp4Url));
  // 전사는 오디오만 쓰므로 최저 화질 변형을 받는다 (최고 화질은 수백 MB가 될 수 있음)
  const srcUrl = video?.sttMp4Url || video?.bestMp4Url;
  if (!video || !srcUrl) return null;

  if (video.durationMs && video.durationMs > MAX_DURATION_MS) {
    console.log(`  영상 ${Math.round(video.durationMs / 1000)}s — 상한(${Math.round(MAX_DURATION_MS / 1000)}s) 초과로 전사 생략`);
    return null;
  }
  if (!mediaEngineAvailable('ffmpeg')) return null;

  const workdir = join(tmpdir(), `omni-digest-media-${video.mediaKey}`);
  try {
    console.log(`  영상 다운로드 (${video.durationMs ? Math.round(video.durationMs / 1000) + 's' : '길이 미상'}, STT용 저화질 변형)...`);
    const videoPath = await downloadVideo(srcUrl, workdir);
    if (!(await hasAudioStream(videoPath))) {
      console.log('  소리 트랙 없음(무음 영상) — 전사 생략, 화면은 시각 흡수가 본다');
      return null;
    }
    const audioPath = await extractAudio(videoPath, workdir);

    const lang = opts.lang || env('OMNI_DIGEST_STT_LANG', 'en');
    console.log(`  STT 전사 중 (lang=${lang})...`);

    const local = await transcribeLocalWhisper(audioPath, workdir, lang);
    if (local) {
      console.log(`  전사 완료 (local-whisper, ${local.length}자)`);
      return { transcript: local, engine: 'local-whisper', durationMs: video.durationMs };
    }

    const remote = await transcribeViaYoutubeMaster(audioPath, workdir);
    if (remote) {
      console.log(`  전사 완료 (youtube-master STT, ${remote.length}자)`);
      return { transcript: remote, engine: 'youtube-master-stt', durationMs: video.durationMs };
    }

    console.log('  전사 실패 — 모든 STT 엔진 사용 불가. 텍스트만으로 요약합니다.');
    return null;
  } catch (e: any) {
    console.log(`  미디어 처리 실패 (${e.message}) — 텍스트만으로 요약합니다.`);
    return null;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 전사문을 Obsidian 부록용 블록으로 만든다. */
export function transcriptAppendix(t: MediaTranscript): string {
  const dur = t.durationMs ? ` (${Math.round(t.durationMs / 1000)}초)` : '';
  return `# 영상 전사${dur}\n> 엔진: ${t.engine}\n\n${t.transcript}`;
}
