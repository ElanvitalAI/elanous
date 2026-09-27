/**
 * X 첨부 미디어의 «시각» 흡수 — 사진 · 영상 화면.
 *
 * 전사(media.ts)는 소리만 본다. 말 없는 모션그래픽·화면 데모·표 이미지는 전사가 «MUSIC» 한 줄로
 * 끝나 내용이 통째로 빠졌다(2026-09-27 · 저장된 메시지 X 5편 실측). 여기서:
 *   - 사진 → S3 → 노트에 삽입 ⊕ Grok 비전으로 «무엇이 보이나»(표·그래프·화면 글자까지)
 *   - 영상 → 장면이 바뀌는 프레임(최대 8장) → S3 → 프레임 띠 ⊕ Grok 비전으로 «화면에서 무슨 일이»
 * 설명 텍스트는 요약 프롬프트에도 넣어 요약이 시각 내용을 반영하게 한다. 실패는 전부 fail-soft(null).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, requireEnv } from './env.js';
import { downloadVideo } from './media.js';
import type { TweetMedia } from './types.js';

const MAX_FRAMES = 8;
const MAX_VIDEO_MS_FOR_FRAMES = Number(env('OMNI_DIGEST_FRAMES_MAX_MS', String(10 * 60 * 1000)));

export interface VisualAbsorb {
  /** 노트 부록에 붙일 마크다운(이미지·프레임 띠 ⊕ 설명). */
  markdown: string;
  /** 요약 프롬프트에 넣을 설명 텍스트. */
  promptText: string;
}

// 시각 흡수(이미지·영상 프레임 → 비전 설명)는 이미지를 «공개 URL» 로 올려야 한다 — 버킷은 사용자가 준다(기본값 없음).
// 없으면 이 항목만 건너뛰고(아래 try/catch 가 줄 하나로 알린다) 본문 요약은 그대로 간다.
function bucket(): string {
  const b = env('AWS_S3_BUCKET', '');
  if (!b) throw new Error('AWS_S3_BUCKET 미설정 — 시각 흡수 건너뜀(.env 에 공개 읽기 버킷을 주면 켜진다)');
  return b;
}

function uploadToS3(localPath: string, key: string): string {
  execFileSync('aws', ['s3', 'cp', localPath, `s3://${bucket()}/${key}`, '--quiet'], { timeout: 60_000, stdio: 'pipe', env: process.env });
  return `https://${bucket()}.s3.amazonaws.com/${key}`;
}

async function download(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

/** Grok 비전 — 이미지 여러 장 ⊕ 지시. 응답 텍스트(한국어). */
async function describeImages(imageUrls: string[], instruction: string): Promise<string> {
  const apiKey = requireEnv('XAI_API_KEY');
  const model = env('GROK_VISION_MODEL', env('GROK_MODEL', 'grok-4-1-fast-reasoning'));
  const content = [
    { type: 'input_text', text: instruction },
    ...imageUrls.map((u) => ({ type: 'input_image', image_url: u, detail: 'high' })),
  ];
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: [{ role: 'user', content }], temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`Grok vision ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  for (const item of data.output || []) for (const c of item.content || []) if ((c.type === 'output_text' || c.type === 'text') && c.text) return c.text.trim();
  throw new Error('비전 응답 파싱 실패');
}

/** 장면 전환 프레임을 뽑는다(모자라면 균등 간격으로 채운다). */
function extractFrames(videoPath: string, outdir: string, durationMs?: number): string[] {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vf', "select='eq(n\\,0)+gt(scene\\,0.3)',scale='min(1280,iw)':-2",
    '-fps_mode', 'vfr', '-frames:v', String(MAX_FRAMES), '-q:v', '3', join(outdir, 'scene_%02d.jpg')], { timeout: 180_000, stdio: 'pipe' });
  let frames = readdirSync(outdir).filter((f) => f.startsWith('scene_')).sort();
  if (frames.length < 4 && durationMs && durationMs > 0) {
    const n = Math.min(6, MAX_FRAMES);
    const fps = (n / (durationMs / 1000)).toFixed(4);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vf', `fps=${fps},scale='min(1280,iw)':-2`, '-frames:v', String(n), '-q:v', '3',
      join(outdir, 'even_%02d.jpg')], { timeout: 180_000, stdio: 'pipe' });
    frames = readdirSync(outdir).filter((f) => f.startsWith('even_')).sort();
  }
  return frames.map((f) => join(outdir, f));
}

const PHOTO_INSTRUCTION = '이 이미지(X 게시물 첨부)에 무엇이 보이는지 한국어로 정확히 설명하라. 표·그래프·벤치마크면 수치와 항목을 빠짐없이 옮기고, 화면 캡처면 화면의 글자·버튼·구성을 옮겨라. 추측은 «추정»이라고 표시. 5~12줄.';
const FRAMES_INSTRUCTION = '다음은 X 게시물 첨부 영상에서 시간 순서로 뽑은 프레임이다. 영상에서 화면에 무슨 일이 일어나는지 한국어로 설명하라 — 장면 흐름, 화면 속 글자·UI·코드·도구 이름, 보여 주려는 결과물. 소리는 모른다. 프레임 번호를 붙여 6~15줄.';

export async function absorbTweetVisuals(media: TweetMedia[], opts: { tweetId: string; log?: (s: string) => void }): Promise<VisualAbsorb | null> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const md: string[] = [];
  const prompt: string[] = [];
  const work = mkdtempSync(join(tmpdir(), `omni-visual-${opts.tweetId}-`));
  try {
    const photos = media.filter((m) => m.type === 'photo' && m.previewImageUrl);
    for (const [i, p] of photos.entries()) {
      try {
        const local = join(work, `photo_${i + 1}.jpg`);
        await download(`${p.previewImageUrl}${p.previewImageUrl!.includes('?') ? '' : '?name=large'}`, local);
        const url = uploadToS3(local, `x/media/${opts.tweetId}/photo_${i + 1}.jpg`);
        const desc = await describeImages([url], PHOTO_INSTRUCTION);
        md.push(`## 이미지 ${i + 1}\n![이미지 ${i + 1}](${url})\n\n${desc}`);
        prompt.push(`[첨부 이미지 ${i + 1} 설명]\n${desc}`);
        log(`  [시각] 이미지 ${i + 1} 흡수`);
      } catch (e) { log(`  [시각] 이미지 ${i + 1} 실패: ${String(e).slice(0, 120)}`); }
    }
    const videos = media.filter((m) => (m.type === 'video' || m.type === 'animated_gif') && (m.bestMp4Url || m.sttMp4Url));
    for (const [i, v] of videos.entries()) {
      if (v.durationMs && v.durationMs > MAX_VIDEO_MS_FOR_FRAMES) { log(`  [시각] 영상 ${i + 1} 길어서 프레임 생략`); continue; }
      try {
        const dir = join(work, `v${i + 1}`);
        execFileSync('mkdir', ['-p', dir]);
        const path = await downloadVideo((v.bestMp4Url || v.sttMp4Url)!, dir);
        const frames = extractFrames(path, dir, v.durationMs);
        if (!frames.length) continue;
        const urls = frames.map((f, j) => uploadToS3(f, `x/media/${opts.tweetId}/v${i + 1}_f${String(j + 1).padStart(2, '0')}.jpg`));
        const desc = await describeImages(urls, FRAMES_INSTRUCTION);
        md.push(`## 영상 ${i + 1} 화면 (${urls.length}프레임)\n${urls.map((u, j) => `![프레임 ${j + 1}](${u})`).join(' ')}\n\n${desc}`);
        prompt.push(`[첨부 영상 ${i + 1} 화면 설명 — 프레임 ${urls.length}장 기반]\n${desc}`);
        log(`  [시각] 영상 ${i + 1} 프레임 ${urls.length}장 흡수`);
      } catch (e) { log(`  [시각] 영상 ${i + 1} 실패: ${String(e).slice(0, 120)}`); }
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
  if (!md.length) return null;
  return { markdown: `# 첨부 미디어 (시각)\n\n${md.join('\n\n')}`, promptText: prompt.join('\n\n') };
}

/** 시험·재흡수용 — 로컬 이미지 한 장을 읽어 data URL 로. */
export function dataUrl(path: string): string {
  return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`;
}
