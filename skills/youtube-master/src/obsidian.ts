import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { env } from './env.js';
import { safeName, dateStamp, stamp, nowISO, nowFull, escapeQuotes, slugify } from './util.js';
import type { ArtifactInfo, SttEngine, VideoMeta } from './types.js';

/* ── Save directory resolution ── */

export function getSaveDir(subdir?: string): string | null {
  const vaultRoot = env('OBSIDIAN_VAULT_ROOT');
  if (!vaultRoot) return null;
  const sub = subdir || env('YOUTUBE_SAVE_SUBDIR', '00. Inbox/02. Youtube Summary');
  return join(vaultRoot, ...sub.split('/'));
}

export function getStudyNoteSaveDir(): string | null {
  const vaultRoot = env('OBSIDIAN_VAULT_ROOT');
  if (!vaultRoot) return null;
  const sub = env('YOUTUBE_STUDY_NOTE_SUBDIR') || env('YOUTUBE_SAVE_SUBDIR', '00. Inbox/02. Youtube Summary');
  return join(vaultRoot, ...sub.split('/'));
}

/* ── Artifact persistence (Cloud STT path) ── */

export async function prepareRunDir(saveDir: string, meta: VideoMeta, videoId: string): Promise<string> {
  const folder = join(saveDir, '_youtube-cloud-stt', `${stamp()}_${videoId}_${slugify(meta.title).slice(0, 50)}`);
  await mkdir(folder, { recursive: true });
  return folder;
}

export async function persistArtifacts(
  runDir: string,
  meta: VideoMeta,
  videoUrl: string,
  audioPath: string,
  chunks: string[],
  transcript: string,
  chunkTexts: string[],
  sttEngine: SttEngine,
): Promise<ArtifactInfo> {
  const audioDir = join(runDir, 'audio');
  const chunksDir = join(runDir, 'chunks');
  const transcriptsDir = join(runDir, 'transcripts');
  await Promise.all([
    mkdir(audioDir, { recursive: true }),
    mkdir(chunksDir, { recursive: true }),
    mkdir(transcriptsDir, { recursive: true }),
  ]);

  const savedAudio = join(audioDir, `full_audio${extname(audioPath)}`);
  await copyFile(audioPath, savedAudio);

  const savedChunks: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const target = join(chunksDir, `${String(i + 1).padStart(3, '0')}_${basename(chunks[i])}`);
    await copyFile(chunks[i], target);
    savedChunks.push(target);
  }

  const transcriptPath = join(transcriptsDir, 'full_transcript.txt');
  await writeFile(transcriptPath, transcript, 'utf-8');

  for (let i = 0; i < chunkTexts.length; i++) {
    await writeFile(join(transcriptsDir, `chunk_${String(i + 1).padStart(3, '0')}.txt`), chunkTexts[i].trim() + '\n', 'utf-8');
  }

  const manifest = {
    video_title: meta.title,
    channel: meta.channel,
    video_url: videoUrl,
    saved_at: nowFull(),
    audio_file: savedAudio,
    chunk_files: savedChunks,
    transcript_file: transcriptPath,
    stt_engine: sttEngine,
  };
  await writeFile(join(runDir, 'artifacts.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  return { runDir, audioFile: savedAudio, chunkFiles: savedChunks, transcriptFile: transcriptPath, sttEngine };
}

/* ── Default summary markdown save ── */

export interface SaveMarkdownOptions {
  meta: VideoMeta;
  videoUrl: string;
  videoId: string;
  summaryBody: string;
  genre: string;
  keywords: string[];
  saveDir: string;
  artifacts?: ArtifactInfo;
  cloudStt?: boolean;
  /** 인박스 스테이징 domain(frontmatter category 로 명시 — 피드 domain 진실원). */
  domain?: string;
}

export async function saveMarkdown(opts: SaveMarkdownOptions): Promise<string> {
  await mkdir(opts.saveDir, { recursive: true });
  const ds = dateStamp();
  const base = `${ds}_${safeName(opts.meta.title)}`;
  let filePath = join(opts.saveDir, `${base}.md`);
  let seq = 1;
  while (existsSync(filePath)) {
    filePath = join(opts.saveDir, `${base}_${seq}.md`);
    seq++;
  }

  const genreTags = opts.genre.split('#').map((g) => g.trim().replace(/\s+/g, '_')).filter(Boolean);
  const keywordTags = opts.keywords.map((k) => k.replace(/\s+/g, '_'));
  const allTags = ['YouTube', 'AI요약', ...(opts.cloudStt ? ['Cloud_STT'] : []), ...genreTags, ...keywordTags];

  let artifactsBlock = '';
  if (opts.artifacts) {
    artifactsBlock = `

## Saved Artifacts

- Run directory: \`${opts.artifacts.runDir}\`
- Full audio: \`${opts.artifacts.audioFile}\`
- Chunk count: ${opts.artifacts.chunkFiles.length}
- Full transcript: \`${opts.artifacts.transcriptFile}\`
- STT engine: \`${opts.artifacts.sttEngine}\`
`;
  }

  const content = `---
title: "${escapeQuotes(opts.meta.title)}"
created: ${nowISO()}${opts.domain ? `\ncategory: "${opts.domain}"` : ''}
tags:
${allTags.map((t) => `  - "${t}"`).join('\n')}
youtube_url: "${opts.videoUrl}"
video_id: "${opts.videoId}"
channel: "${escapeQuotes(opts.meta.channel)}"
views: ${opts.meta.views}
likes: ${opts.meta.likes}
uploaded: "${opts.meta.uploaded}"
duration: "${opts.meta.duration}"
genre: "${opts.genre}"
keywords: "${opts.keywords.join(', ')}"
ai_generated: true
generated_at: "${nowFull()}"
---

${opts.summaryBody}${artifactsBlock}

---

> 원문: ${opts.videoUrl}
`;

  await writeFile(filePath, content, 'utf-8');
  return filePath;
}
