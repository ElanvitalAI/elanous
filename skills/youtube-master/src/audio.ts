import { execFile as execFileCb } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { which } from './util.js';

const execFile = promisify(execFileCb);

// YouTube는 미디어 URL의 n(스로틀) 파라미터를 플레이어 JS로 해독해야 정상 대역폭을 연다.
// yt-dlp가 이 해독기를 EJS(외부 JS) 원격 컴포넌트로 분리하면서 기본값으로는 내려받지 않게 됐고,
// 해독에 실패하면 약 100KB만 내려오다 HTTP 403이 난다.
//   - --remote-components ejs:github : 해독 스크립트 다운로드 허용 (deno/node 런타임 필요)
//   - player_client                  : 기본 android_vr은 서명 해독을 타지 않아 계속 403.
//                                      web_embedded가 DASH 오디오를 정상 제공.
// 참고: https://github.com/yt-dlp/yt-dlp/wiki/EJS
const YTDLP_UNTHROTTLE_ARGS = [
  '--remote-components', 'ejs:github',
  '--extractor-args', 'youtube:player_client=web_embedded,web_safari,mweb',
];

export async function downloadAudio(url: string, outdir: string): Promise<string> {
  which('yt-dlp');
  which('ffmpeg');
  const template = join(outdir, 'audio.%(ext)s');
  const baseArgs = [
    '-f', 'bestaudio[protocol^=http]/bestaudio/best',
    '-x', '--audio-format', 'mp3',
    '-o', template,
  ];
  const run = (args: string[]) =>
    execFile('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024 });

  try {
    await run([...baseArgs, ...YTDLP_UNTHROTTLE_ARGS, url]);
  } catch (err) {
    // 구버전 yt-dlp는 위 옵션을 모른다 — 기존 인자로 한 번 더 시도한다.
    console.warn(`    ⚠ yt-dlp 언스로틀 경로 실패, 기본 인자로 재시도: ${(err as Error).message.split('\n')[0]}`);
    await run(['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '-o', template, url]);
  }

  const files = (await readdir(outdir)).filter(f => f.startsWith('audio.')).sort();
  if (!files.length) throw new Error('오디오 다운로드 실패');
  return join(outdir, files[0]);
}

export async function splitAudio(audioPath: string, outdir: string, segmentSeconds: number): Promise<string[]> {
  which('ffmpeg');
  const chunksDir = join(outdir, 'chunks');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(chunksDir, { recursive: true });
  const outPattern = join(chunksDir, 'chunk_%03d.mp3');
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', audioPath,
    '-f', 'segment', '-segment_time', String(segmentSeconds),
    '-c', 'copy', outPattern,
  ]);
  const files = (await readdir(chunksDir))
    .filter(f => f.startsWith('chunk_') && f.endsWith('.mp3'))
    .sort();
  if (!files.length) throw new Error('오디오 분할 실패');
  return files.map(f => join(chunksDir, f));
}
