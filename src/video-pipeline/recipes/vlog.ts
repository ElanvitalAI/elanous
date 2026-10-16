/**
 * 🎥 브이로그(찍힌 소재 → 이야기) 레시피 — `vlog-found-footage-pipeline.declaration.yaml` 의 «코드» 쪽.
 *
 * ⭐ 출처 — 전부 2026-09-19 실물 작업(`~/Movies/DKReview/03_생성/`)에서 «잰» 규칙을 옮긴 것이다.
 *   그 작업은 프로젝트 경로가 박힌 파이썬 사슬(sb_cut·sb_audio·sb_resolve·graph_run)이었다.
 *   ⇒ 여기서는 ***경로를 `ctx.state`·`ctx.workdir` 로만*** 받는다(어느 소재 폴더에서도 돈다).
 *
 * ⛔ 이 파일의 규율 셋:
 *   ① outcome 은 «선언의 간선 이름»이다(types.ts). 받는 간선이 없는 값을 내면 그 걸음이 죽는다.
 *   ② 「못 쟀다」(unmeasurable)와 「실패」(error·blocked)를 접지 않는다.
 *   ③ 대표 2026-09-23: *"무료 대안이 없는 것이 중요하진 않습니다. 능력이 더 중요합니다."*
 *      ⇒ 리졸브(owned)·AE 같은 앱을 «쓰는» 것을 피하지 않는다. 다만 앱이 없으면 «없다»고 말한다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { ffmpeg, run } from './ffmpeg.js';
import { resolvePython } from '../../python/resolve-python.js';
import { UNOBSERVED, type Recipe } from './types.js';

// ── 모양 ─────────────────────────────────────────────────────────────────
export interface Clip { readonly path: string; readonly dur: number; readonly w: number; readonly h: number; readonly fps: number; readonly audio: boolean }
export interface Seg { readonly start: number; readonly end: number; readonly text: string }
export interface ShotCut { readonly src: string; readonly in: number; readonly dur: number; readonly trans?: string; readonly text?: string }
export interface Chapter { readonly id: string; readonly title?: string; readonly text?: string; readonly cuts: readonly ShotCut[] }
export interface Shots { readonly fps: number; readonly width: number; readonly height: number; readonly target_dur: number; readonly src_dir?: string; readonly chapters: readonly Chapter[] }
export interface HandleEntry { head: number; body: number; tail: number; path: string; src: string; in: number; dur: number; trans?: string; actual?: number }
export interface HandleManifest { readonly fps: number; readonly handles: number; readonly order: string[]; readonly cuts: Record<string, HandleEntry> }

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv)$/i;
const need = (key: string) => ({ outcome: UNOBSERVED, note: `계약 입력 '${key}' 가 state 에 없다 — 앞 노드가 안 채웠다(실패가 «아니다»)` });
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** ffprobe 한 번으로 길이·크기·fps·소리 유무. ⛔ 못 읽으면 null — 0 이 아니다. */
export function probeClip(path: string): Clip | null {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', path]);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out) as { streams?: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
    const v = j.streams?.find((s) => s.codec_type === 'video');
    const dur = Number(j.format?.duration);
    if (!v || !Number.isFinite(dur)) return null;
    const [n, d] = (v.r_frame_rate ?? '30/1').split('/').map(Number);
    return { path, dur, w: v.width ?? 0, h: v.height ?? 0, fps: d ? n! / d : 30, audio: Boolean(j.streams?.some((s) => s.codec_type === 'audio')) };
  } catch { return null; }
}

// ── ① ingest · probe-sources ─────────────────────────────────────────────
export const probeSources: Recipe = async (ctx) => {
  const dir = ctx.state.source_dir as string | undefined;
  if (!dir) return need('source_dir');
  if (!existsSync(dir)) return { outcome: 'error', note: `source_dir 가 없다: ${dir}` };
  const files = readdirSync(dir).filter((f) => VIDEO_EXT.test(f)).sort().map((f) => resolvePath(dir, f));
  const clips = files.map(probeClip).filter((c): c is Clip => c !== null);
  if (clips.length === 0) return { outcome: 'error', note: `영상 소재 0개(읽힌 것 기준 · 후보 ${files.length})` };
  const has_audio = clips.some((c) => c.audio);
  const specs = { w: clips[0]!.w, h: clips[0]!.h, fps: Math.round(clips[0]!.fps) };
  ctx.log('vlog.ingest', { clips: clips.length, has_audio });
  return {
    outcome: has_audio ? 'ok' : 'no-audio',
    produced: { clips, specs, has_audio, source_files: clips.map((c) => c.path) },
    note: `소재 ${clips.length}개 · 소리 있는 것 ${clips.filter((c) => c.audio).length}개${files.length > clips.length ? ` · ⚠️ 못 읽은 것 ${files.length - clips.length}` : ''}`,
  };
};

// ── ② transcribe · whisper-korean ─────────────────────────────────────────
/** 로컬 `whisper`(openai-whisper) — 📏 이 기계에 large-v3-turbo 캐시가 있다. 모델은 state.whisper_model 로 바꾼다. */
export const whisperKorean: Recipe = async (ctx) => {
  const clips = ctx.state.clips as Clip[] | undefined;
  if (!clips) return need('clips');
  const model = String(ctx.state.whisper_model ?? 'large-v3-turbo');
  const out = join(ctx.workdir, 'transcripts');
  mkdirSync(out, { recursive: true });
  const transcripts: { clip: string; segments: Seg[] }[] = [];
  const srt: string[] = [];
  for (const c of clips.filter((x) => x.audio)) {
    const base = join(out, c.path.split('/').pop()!.replace(/\.[^.]+$/, ''));
    // ⭐ 같은 작업 디렉토리에 «소재보다 새» 전사가 있으면 다시 돌리지 않는다(되돌아온 주행이 9분씩 다시 쓰지 않게).
    //   ⛔ 모델이 바뀌었으면 재사용하지 않는다 — 표지 파일에 모델 이름을 적어 둔다.
    const tag = `${base}.model`;
    const fresh = existsSync(`${base}.json`) && existsSync(tag) && readFileSync(tag, 'utf8') === model && statSync(`${base}.json`).mtimeMs >= statSync(c.path).mtimeMs;
    const r = fresh ? { ok: true, code: 0, err: '' } : run('whisper', [c.path, '--model', model, '--language', 'ko', '--output_format', 'all', '--output_dir', out, '--fp16', 'False', '--verbose', 'False'], 1_800_000);
    if (r.ok && !fresh) writeFileSync(tag, model);
    if (!r.ok || !existsSync(`${base}.json`)) {
      return { outcome: 'error', note: `whisper 실패(${c.path.split('/').pop()}): ${(r.err || `code ${r.code}`).slice(-200)}` };
    }
    const j = readJson<{ segments?: { start: number; end: number; text: string }[] }>(`${base}.json`);
    transcripts.push({ clip: c.path, segments: (j.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text.length > 0) });
    if (existsSync(`${base}.srt`)) srt.push(`${base}.srt`);
  }
  const n = transcripts.reduce((a, t) => a + t.segments.length, 0);
  ctx.log('vlog.transcribe', { clips: transcripts.length, segments: n, model });
  return { outcome: n === 0 ? 'empty' : 'ok', produced: { transcripts, srt }, note: `전사 ${transcripts.length}개 소재 · 말 구간 ${n}개 (${model})` };
};

// ── ④ storyboard · author-shots-json ─────────────────────────────────────
/**
 * ⭐ 사람이 쓴 `shots.json` 이 있으면 «그것이 SSOT» — 다시 짓지 않는다(09-19 의 방식).
 * 없으면 구조(arc)나 소재에서 «초안»을 짓는다. ⛔ 초안은 초안이다 — note 가 그렇게 말한다.
 */
export const authorShotsJson: Recipe = async (ctx) => {
  const given = ctx.state.shots_json as string | undefined;
  if (given && existsSync(given)) {
    const s = readJson<Shots>(given);
    return { outcome: 'ok', produced: { shots_json: given, target_dur: s.target_dur }, note: `사람이 쓴 원장을 쓴다 — 장 ${s.chapters.length}` };
  }
  const clips = ctx.state.clips as Clip[] | undefined;
  if (!clips) return need('clips');
  const arc = ctx.state.arc as { clip: string; start: number; end: number; text?: string }[] | undefined;
  const fps = Number(ctx.state.target_fps ?? 30);
  const W = Number(ctx.state.target_w ?? 1080), H = Number(ctx.state.target_h ?? 1920);
  const byPath = new Map(clips.map((c) => [c.path, c]));
  const chapters: Chapter[] = [];
  if (arc && arc.length > 0) {
    arc.forEach((b, i) => {
      const clip = byPath.get(b.clip);
      if (!clip) return;
      const inT = Math.max(0, b.start - 0.3);
      const dur = Math.min(Math.max(b.end - b.start + 0.6, 1.5), 6, clip.dur - inT - 0.05);
      if (dur < 0.5) return;
      chapters.push({ id: `C${String(i + 1).padStart(2, '0')}`, text: b.text, cuts: [{ src: clip.path, in: +inT.toFixed(3), dur: +dur.toFixed(3), trans: i === 0 ? undefined : 'dissolve', text: b.text }] });
    });
  } else {
    clips.forEach((c, i) => {
      const dur = Math.min(3, Math.max(c.dur - 0.5, 0.5));
      const inT = Math.max(0, Math.min(c.dur / 3, c.dur - dur - 0.05));
      chapters.push({ id: `C${String(i + 1).padStart(2, '0')}`, cuts: [{ src: c.path, in: +inT.toFixed(3), dur: +dur.toFixed(3), trans: i === 0 ? undefined : 'dissolve' }] });
    });
  }
  if (chapters.length === 0) return { outcome: 'error', note: '초안을 못 지었다 — 쓸 구간이 0' };
  const target_dur = +chapters.flatMap((c) => c.cuts).reduce((a, c) => a + Math.round(c.dur * fps) / fps, 0).toFixed(4);
  const shots: Shots = { fps, width: W, height: H, target_dur, chapters };
  mkdirSync(join(ctx.workdir, 'storyboard'), { recursive: true });
  const p = join(ctx.workdir, 'storyboard', 'shots.json');
  writeFileSync(p, JSON.stringify(shots, null, 2));
  return { outcome: 'ok', produced: { shots_json: p, target_dur }, note: `⚠️ «초안» 원장 — 장 ${chapters.length} · ${target_dur}s (${arc ? '구조에서' : '소재 균등'})` };
};

const frames = (sec: number, fps: number): number => Math.round(sec * fps);

// ── ⑤ inpoints · verify-frames ───────────────────────────────────────────
/** ⛔ 노트를 믿지 않는다 — 📏 09-19: 제안 인점 33 중 «5»가 그 시각에 없었다. */
export const verifyFrames: Recipe = async (ctx) => {
  const sp = ctx.state.shots_json as string | undefined;
  if (!sp) return need('shots_json');
  let shots: Shots;
  try { shots = readJson<Shots>(sp); } catch (e) { return { outcome: 'unreadable', note: `shots.json 을 못 읽었다: ${String(e).slice(0, 120)}` }; }
  const cuts = shots.chapters.flatMap((c) => c.cuts);
  let drift = 0;
  const frameFiles: string[] = [];
  const dir = join(ctx.workdir, 'inpoints');
  mkdirSync(dir, { recursive: true });
  cuts.forEach((c, i) => {
    const src = existsSync(c.src) ? c.src : shots.src_dir ? join(shots.src_dir, c.src) : c.src;
    const p = existsSync(src) ? probeClip(src) : null;
    if (!p || c.in + c.dur > p.dur + 1 / shots.fps) { drift += 1; return; }
    const f = join(dir, `${String(i).padStart(3, '0')}.jpg`);
    const r = ffmpeg(['-ss', c.in.toFixed(3), '-i', src, '-frames:v', '1', '-vf', 'scale=270:-2', f]);
    if (r.ok) frameFiles.push(f);
  });
  let contact_sheet: string | null = null;
  if (frameFiles.length > 0) {
    const cols = Math.min(6, frameFiles.length), rows = Math.ceil(frameFiles.length / cols);
    const sheet = join(dir, 'contact.jpg');
    const r = ffmpeg(['-framerate', '1', '-i', join(dir, '%03d.jpg'), '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', sheet]);
    if (r.ok) contact_sheet = sheet;
  }
  return { outcome: drift > 0 ? 'drift' : 'clean', produced: { drift_count: drift, contact_sheet }, note: `인점 ${cuts.length}개 중 빗나감 ${drift}` };
};

/** 자막 한 줄의 최대 글자 수 — 세로 1080 폭에서 54px 한글이 여유 있게 들어가는 값. */
export const LINE_CHARS = 18;

/** 어절 경계로 줄을 나눈다. 넘치면 마지막 줄 끝을 «…» 로 — ⛔ 잘린 사실을 숨기지 않는다. */
export function wrapLines(text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length > max ? w.slice(0, max) : w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, max - 1)}…`;
  return kept;
}

/** 한 프레임의 알파 평균(0=투명 · 255=불투명). ⛔ 못 재면 null. */
function measureAlphaWith(bin: string, path: string, at: number): number | null {
  const r = run(bin, ['-hide_banner', '-nostats', '-ss', at.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
  const m = /YAVG=([\d.]+)/.exec(r.err);
  return m ? Number(m[1]) : null;
}

export function alphaMean(path: string, at = 0): number | null {
  return measureAlphaWith('ffmpeg', path, at);
}

/** 실물 렌더 도구를 바꿔 잴 때도 alphaMean과 같은 판정기를 쓴다. */
export function alphaMeanFor(bin: string): (path: string, at?: number) => number | null {
  return (path, at = 0) => measureAlphaWith(bin, path, at);
}

// ── ⑥ layers · build-layers ──────────────────────────────────────────────
/**
 * 무료로 «지금» 지을 수 있는 층 셋 — 스크림(하단 어둡게) · 그레인 · 자막.
 * ⛔ 지도(HyperFrames)·리크(AE)·카드(지도 캡처)는 원장이 «요구할 때만» 필요하고, 여기서 «못 지으면» null 로 둔다.
 */
export const buildLayers: Recipe = async (ctx) => {
  const sp = ctx.state.shots_json as string | undefined;
  if (!sp) return need('shots_json');
  const s = readJson<Shots>(sp);
  const dir = join(ctx.workdir, 'layers');
  mkdirSync(dir, { recursive: true });
  const W = s.width, H = s.height, F = s.fps;
  const render = typeof ctx.state.ffmpeg === 'function'
    ? ctx.state.ffmpeg as typeof ffmpeg
    : ffmpeg;
  const grain = join(dir, 'grain_loop.mp4');
  const g = render(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=${F}:d=4`, '-vf', 'noise=c0s=18:c0f=t+u,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', grain], 300_000);
  const scrim = join(dir, 'scrim.mov');
  const sc = render(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${F}:d=2`, '-vf',
    `format=argb,geq=r=0:g=0:b=0:a='if(gt(Y,H*0.55),150*(Y-H*0.55)/(H*0.45),0)'`, '-c:v', 'qtrle', scrim], 300_000);
  // 자막 — 장의 text 를 그 장의 시간에만 띄운다. ⛔ 폰트는 «있는 것»만 쓴다.
  const requestedFont = ctx.state.font_file as string | undefined;
  const font = requestedFont && existsSync(requestedFont)
    ? requestedFont
    : ['/System/Library/Fonts/AppleSDGothicNeo.ttc', '/System/Library/Fonts/Supplemental/AppleGothic.ttf'].find(existsSync);
  let t = 0;
  const draws: string[] = [];
  for (const ch of s.chapters) {
    const d = ch.cuts.reduce((a, c) => a + Math.round(c.dur * F) / F, 0);
    const txt = (ch.text ?? ch.cuts.find((c) => c.text)?.text ?? '').replace(/['\\:%]/g, ' ').trim();
    // 🩸 2026-09-23 실물: 한 줄 40자를 H/28(68px)로 그려 1080 폭을 넘겨 «양옆이 잘렸다»(QC 는 못 본다).
    //   ⇒ 어절 경계로 «두 줄»까지 나누고, 글꼴은 «폭에 맞춘다»(한글 한 자 ≈ 글꼴 크기 폭).
    const lines = wrapLines(txt, LINE_CHARS, 2);
    const fs = Math.min(Math.round(H / 28), Math.floor((0.9 * W) / Math.max(1, ...lines.map((l) => l.length))));
    if (font) lines.forEach((line, li) => draws.push(
      `drawtext=fontfile='${font}':text='${line}':fontcolor=white:fontsize=${fs}:x=(w-text_w)/2:y=h*0.78+${li}*${Math.round(fs * 1.3)}:enable='between(t,${t.toFixed(3)},${(t + d).toFixed(3)})'`));
    t += d;
  }
  let text: string | null = null;
  if (draws.length > 0) {
    text = join(dir, 'text.mov');
    // 🩸 2026-09-23 실물: `color=c=black@0.0` → `format=argb` 는 알파가 «255»였다(색 소스는 알파 없는 yuv 로 나와 @0.0 이 사라진다).
    //   그 불투명 검정판이 리졸브에서 «영상 전체»를 덮었다(QC: 0~47s 검정). ⇒ 스크림처럼 geq 로 알파를 «직접» 0 으로 쓴다.
    const tx = render(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${F}:d=${s.target_dur.toFixed(3)}`, '-vf', `format=argb,geq=r=0:g=0:b=0:a=0,${draws.join(',')}`, '-c:v', 'qtrle', text], 600_000);
    if (!tx.ok) return { outcome: 'error', note: `자막 층 실패: ${tx.err.slice(-200)}` };
  }
  if (!g.ok || !sc.ok) return { outcome: 'error', note: `층 실패: ${(g.err || sc.err).slice(-200)}` };
  // ⛔⭐ 덮는 층(스크림·자막)은 «투명해야» 한다 — 만든 직후 알파를 «잰다». 불투명이면 영상 전체를 덮는다.
  //   🩸 이 자가 없어서 결함이 «리졸브 렌더 뒤 QC»에서야 잡혔다(되돌아갈 곳도 cut 으로 잘못 가리켰다).
  const measureAlpha = typeof ctx.state.alpha_mean === 'function'
    ? ctx.state.alpha_mean as (path: string, at: number) => number | null
    : alphaMean;
  for (const [label, p] of [['스크림', scrim], ['자막', text]] as const) {
    if (!p) continue;
    const a = measureAlpha(p, 1.0);
    if (a === null) return { outcome: 'error', note: `${label} 층 알파를 못 쟀다` };
    if (a > 200) return { outcome: 'error', note: `${label} 층이 «불투명»하다(알파 평균 ${a.toFixed(0)}/255) — 영상 전체를 덮는다` };
  }
  return {
    outcome: 'ok',
    produced: { scrim, grain, text, map: null, leaks: null, cards: null },
    note: `스크림 · 그레인${text ? ' · 자막' : ' · (자막 없음 — 원장에 text 가 없거나 폰트가 없다)'} · 지도/리크/카드는 안 지었다(원장 요구 없음)`,
  };
};

// ── ⑦ cut · extract-cuts-with-handles ─────────────────────────────────────
/**
 * 📏 09-19 sb_cut.py 의 규칙 그대로:
 *   - 핸들은 «전 컷에 똑같이»(기본 15f). 원본이 모자라면 가장자리 프레임을 복제(tpad)해 채운다.
 *   - «초»가 아니라 «프레임»으로 자른다(-frames:v).
 *   - `-bf 0` — B프레임이 편집목록을 만들어 start_time=0.0667 이 됐다.
 *   - `-video_track_timescale 30000` — 15360 은 30fps 경계를 못 담아 0.64프레임이 남았다.
 *   - ⛔ `-avoid_negative_ts make_zero` 를 «쓰지 않는다» — A/B: 그 플래그가 0.64프레임을 «만들었다».
 */
export const extractCutsWithHandles: Recipe = async (ctx) => {
  const sp = ctx.state.shots_json as string | undefined;
  if (!sp) return need('shots_json');
  const s = readJson<Shots>(sp);
  const HB = Number(ctx.state.handles ?? 15);
  const F = s.fps, W = s.width, H = s.height;
  const dir = join(ctx.workdir, 'cuts');
  mkdirSync(dir, { recursive: true });
  const man: HandleManifest = { fps: F, handles: HB, order: [], cuts: {} };
  const paths: string[] = [];
  for (const ch of s.chapters) {
    for (const [i, c] of ch.cuts.entries()) {
      const key = `${ch.id}_${String(i).padStart(2, '0')}`;
      const src = existsSync(c.src) ? c.src : s.src_dir ? join(s.src_dir, c.src) : c.src;
      const body = frames(c.dur, F);
      const headReal = Math.min(HB, Math.floor(c.in * F));
      const headPad = HB - headReal;
      const n = HB + body + HB;
      const inTs = c.in - headReal / F;
      const hasAudio = probeClip(src)?.audio ?? false;
      const dst = join(dir, `${key}.mp4`);
      const args = ['-ss', Math.max(0, inTs).toFixed(3), '-t', (n / F + 0.5).toFixed(3), '-i', src];
      if (!hasAudio) args.push('-f', 'lavfi', '-t', (n / F + 1).toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v:0', '-map', '1:a:0');
      else args.push('-map', '0:v:0', '-map', '0:a:0');
      args.push(
        '-vf', ['setpts=PTS-STARTPTS', `scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, `fps=${F}`,
          `tpad=start=${headPad}:start_mode=clone:stop=120:stop_mode=clone`].join(','),
        '-af', `asetpts=PTS-STARTPTS,adelay=${Math.round((headPad / F) * 1000)}:all=1,apad,atrim=end=${(n / F).toFixed(4)},asetpts=PTS-STARTPTS`,
        '-frames:v', String(n), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-bf', '0',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-video_track_timescale', String(F * 1000), '-muxdelay', '0', '-muxpreload', '0', dst,
      );
      const r = ffmpeg(args, 600_000);
      if (!r.ok) return { outcome: 'error', note: `${key} 컷 실패: ${r.err.slice(-200)}` };
      man.order.push(key);
      man.cuts[key] = { head: HB, body, tail: HB, path: dst, src, in: c.in, dur: c.dur, trans: c.trans };
      paths.push(dst);
    }
  }
  const handles_json = join(dir, 'handles.json');
  writeFileSync(handles_json, JSON.stringify(man, null, 2));
  return { outcome: 'ok', produced: { cuts: paths, handles_json }, note: `컷 ${paths.length}개 · 핸들 ${HB}f` };
};

// ── ⑧ cutgate · frame-exact-gate ──────────────────────────────────────────
/** ⛔ 「초」가 아니라 «프레임»으로 센다 ⊕ start_time ⊕ 핸들. 판정 순서는 09-19 graph_run.py 와 같다. */
export const frameExactGate: Recipe = async (ctx) => {
  const hp = ctx.state.handles_json as string | undefined;
  if (!hp) return need('handles_json');
  const man = readJson<HandleManifest>(hp);
  // ⛔ 컷 0개는 「전부 맞다」가 아니라 «못 쟀다»다(🩸 2026-09-23: 종전엔 `컷 0 · 전부 맞다` 로 pass 했다).
  if (man.order.length === 0) return { outcome: UNOBSERVED, note: '원장에 컷이 0개다 — 잴 것이 없다(통과가 아니다)' };
  const short: string[] = [], editlist: string[] = [], nohandle: string[] = [];
  for (const k of man.order) {
    const m = man.cuts[k]!;
    const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,start_time', '-of', 'json', m.path]);
    let nb = NaN, st = NaN;
    try { const s = (JSON.parse(r.out).streams ?? [])[0] ?? {}; nb = Number(s.nb_read_frames); st = Number(s.start_time); } catch { /* 아래에서 */ }
    if (!Number.isFinite(nb) || !Number.isFinite(st)) return { outcome: UNOBSERVED, note: `${k} 를 못 셌다` };
    m.actual = nb;
    const tail = nb - m.head - m.body;
    if (nb < m.head + m.body) short.push(k);
    if (Math.abs(st) > 1e-6) editlist.push(k);
    if (m.head < 6 || tail < 6) nohandle.push(k);
  }
  const produced = { frames_ok: short.length === 0, editlist_ok: editlist.length === 0, handles_ok: nohandle.length === 0 };
  if (short.length) return { outcome: 'short', produced, note: `프레임 모자람 ${short.length}: ${short.slice(0, 4).join(',')}` };
  if (editlist.length) return { outcome: 'editlist', produced, note: `start_time≠0 ${editlist.length}: ${editlist.slice(0, 4).join(',')}` };
  if (nohandle.length) return { outcome: 'nohandle', produced, note: `핸들 부족 ${nohandle.length}: ${nohandle.slice(0, 4).join(',')}` };
  return { outcome: 'pass', produced, note: `컷 ${man.order.length} · 프레임·start_time·핸들 전부 맞다` };
};

// ── ⑨ audio · body-then-duck ──────────────────────────────────────────────
/**
 * 본편 소리(핸들 «빼고») → 그 소리를 «키»로 음악을 자동 더킹해 «파일에 굽는다».
 * ⛔ 리졸브 API 에 Fairlight 사이드체인 배선이 «없다»(09-19) ⇒ 굽는다.
 * ⛔ loudnorm 을 키에 쓰지 않는다 — 룩어헤드가 신호를 «늦춰» 더킹이 뒤늦게 걸린다. dynaudnorm 은 시간축을 안 민다.
 */
export const bodyThenDuck: Recipe = async (ctx) => {
  const hp = ctx.state.handles_json as string | undefined;
  if (!hp) return need('handles_json');
  const man = readJson<HandleManifest>(hp);
  const dir = join(ctx.workdir, 'audio');
  mkdirSync(dir, { recursive: true });
  const body_wav = join(dir, 'body.wav');
  const ins = man.order.flatMap((k) => ['-i', man.cuts[k]!.path]);
  const parts = man.order.map((k, i) => {
    const m = man.cuts[k]!;
    return `[${i}:a]atrim=start=${(m.head / man.fps).toFixed(4)}:end=${((m.head + m.body) / man.fps).toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`;
  });
  const fc = `${parts.join(';')};${man.order.map((_, i) => `[a${i}]`).join('')}concat=n=${man.order.length}:v=0:a=1[out]`;
  const b = ffmpeg([...ins, '-filter_complex', fc, '-map', '[out]', '-ar', '48000', '-ac', '2', body_wav], 600_000);
  if (!b.ok) return { outcome: 'error', note: `본편 소리 실패: ${b.err.slice(-200)}` };
  const total = man.order.reduce((a, k) => a + man.cuts[k]!.body, 0) / man.fps;
  const music = ctx.state.music as string | undefined;
  if (!music || !existsSync(music)) {
    return { outcome: 'ok', produced: { body_wav, ducked_wav: null }, note: `본편 소리 ${total.toFixed(2)}s · ⚠️ 음악이 없어 더킹은 안 했다(state.music)` };
  }
  const db = Number(ctx.state.music_db ?? -8);
  const fo = Math.max(0, total - 4);
  // ⭐ 선언: duckgate «weak» → audio. «키 조정은 audio 의 일이다».
  //   ⛔ 되돌아왔는데 같은 설정으로 또 구우면 같은 결과로 «예산이 다할 때까지» 돈다.
  //   ⇒ 되돌아올 때마다(= 관문이 이미 한 번 쟀다) 한 단계씩 세게: 문턱 ½ · 비율 +5.
  const round = Number(ctx.state.duck_round ?? 0) + 1;
  const thr = 0.045 / 2 ** (round - 1);
  const ratio = Math.min(20, 9 + 5 * (round - 1));
  const ducked_wav = join(dir, 'music_ducked.wav');
  const fc2 = `[1:a]volume=${db}dB,afade=t=in:st=0:d=2.5,afade=t=out:st=${fo.toFixed(2)}:d=4,aformat=sample_rates=48000:channel_layouts=stereo[mus];` +
    `[0:a]dynaudnorm=f=150:g=15:p=0.9:m=20,aformat=sample_rates=48000:channel_layouts=stereo[key];` +
    `[mus][key]sidechaincompress=threshold=${thr.toFixed(5)}:ratio=${ratio}:attack=8:release=460:makeup=1,apad[duck]`;
  const d = ffmpeg(['-i', body_wav, '-stream_loop', '-1', '-i', music, '-filter_complex', fc2, '-map', '[duck]', '-t', total.toFixed(4), '-ar', '48000', ducked_wav], 600_000);
  if (!d.ok) return { outcome: 'error', note: `더킹 실패: ${d.err.slice(-200)}` };
  return { outcome: 'ok', produced: { body_wav, ducked_wav, duck_round: round }, note: `본편 소리 ${total.toFixed(2)}s · 음악 ${db}dB 더킹 · ${round}회차(문턱 ${thr.toFixed(4)} · 비율 ${ratio})` };
};

/**
 * 0.5초 창마다 RMS(dB) — 한 번의 ffmpeg 로 전 구간을 잰다.
 * ⛔ «못 읽은» 창(값 줄이 없음)만 버린다. `-inf` 는 «디지털 무음»이라는 ***잰 값***이다 — −120dB 로 센다.
 *   🩸 처음엔 −inf 도 버렸다 ⇒ 합성 소재의 «완전 무음» 창이 전부 빠져 「조용 구간 0」이 됐다.
 */
export function windowRms(path: string, win = 0.5): { t: number; db: number }[] {
  const n = Math.round(48000 * win);
  const r = run('ffmpeg', ['-hide_banner', '-i', path, '-ac', '1', '-ar', '48000', '-af',
    `asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'], 600_000);
  const out: { t: number; db: number }[] = [];
  let t: number | null = null;
  for (const line of r.out.split('\n')) {
    const pt = /pts_time:([\d.]+)/.exec(line); if (pt) { t = Number(pt[1]); continue; }
    const v = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (v && t !== null) { out.push({ t, db: v[1] === '-inf' ? -120 : Number(v[1]) }); t = null; }
  }
  return out;
}

// ── ⑩ duckgate · level-based-duck-gate ────────────────────────────────────
/**
 * ⛔ 기대를 «라벨»이 아니라 «그 자리의 실측 레벨»에서 뽑는다 — 말할 때 음악이 «실제로» 내려갔나.
 *
 * 🩸 2026-09-23 실물 주행: 고정 문턱(`silencedetect noise=-35dB`)으로 «조용한 구간»을 찾았더니
 *   실제 영상은 주변 소음이 늘 −35dB 위라 ***「말 1 · 조용 0」*** — 비교 자체가 안 됐다(합성 소재에선 통과했다).
 *   ⇒ 문턱을 «정하지 않는다». 본편 소리의 0.5초 창별 RMS 분포에서 위 30%(말)·아래 30%(조용)를 고른다.
 *   ⛔ 둘의 차가 6dB 미만이면 「말과 조용을 못 가른다」 — 그때는 «못 쟀다»지 «통과»가 아니다.
 */
export const levelBasedDuckGate: Recipe = async (ctx) => {
  const body = ctx.state.body_wav as string | undefined;
  const ducked = ctx.state.ducked_wav as string | null | undefined;
  if (!body) return need('body_wav');
  if (!ducked) return { outcome: UNOBSERVED, note: '더킹된 음악이 없다(음악 미지정) — 더킹을 «잴 것이 없다»' };
  const bw = windowRms(body), mw = windowRms(ducked);
  if (bw.length < 6 || mw.length < 6) return { outcome: UNOBSERVED, produced: { duck_db: null, silent_db: null }, note: `창이 모자란다 — 본편 ${bw.length} · 음악 ${mw.length}` };
  const sorted = [...bw].sort((x, y) => x.db - y.db);
  const k = Math.max(2, Math.floor(sorted.length * 0.3));
  const quiet = sorted.slice(0, k), loud = sorted.slice(-k);
  const spread = loud.reduce((a, x) => a + x.db, 0) / k - quiet.reduce((a, x) => a + x.db, 0) / k;
  if (spread < 6) return { outcome: UNOBSERVED, produced: { duck_db: null, silent_db: null }, note: `본편 소리가 고르다(위·아래 30% 차 ${spread.toFixed(1)}dB < 6) — 말과 조용을 못 가른다` };
  // ⛔ 창은 «번호»로 맞춘다 — 시각 문자열로 맞추면 리샘플러 지연(44.1k→48k)으로 0.50 ↔ 0.51 이 갈려 «한 창도» 안 맞는다(실측).
  const at = new Map(mw.map((w) => [Math.round(w.t / 0.5), w.db]));
  const avg = (ws: { t: number }[]) => { const v = ws.map((w) => at.get(Math.round(w.t / 0.5))).filter((x): x is number => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const duck_db = avg(loud), silent_db = avg(quiet);
  if (duck_db === null || silent_db === null) return { outcome: UNOBSERVED, note: '음악 레벨을 같은 창에서 못 읽었다' };
  const depth = silent_db - duck_db;
  return {
    outcome: depth >= Number(ctx.state.min_duck_db ?? 4) ? 'pass' : 'weak',
    produced: { duck_db: +duck_db.toFixed(1), silent_db: +silent_db.toFixed(1) },
    note: `말할 때 음악 ${duck_db.toFixed(1)}dB · 조용할 때 ${silent_db.toFixed(1)}dB · 깊이 ${depth.toFixed(1)}dB (본편 위·아래 차 ${spread.toFixed(1)}dB · 창 ${k}×2)`,
  };
};

// ── ⑪⑫⑬ 리졸브 — 조립 · 되읽기 · 렌더 ─────────────────────────────────────
/** 헬퍼 경로 — 시험은 `VLOG_RESOLVE_PY` 로 가짜를 준다(리졸브 없이 갈래를 누르려고). */
const RESOLVE_PY = (): string => process.env.VLOG_RESOLVE_PY ?? resolvePath(import.meta.dir, '../../../scripts/video/vlog_resolve.py');

interface PyOut { code: number | null; json: Record<string, unknown> | null; err: string }
function py(args: string[], timeoutMs = 1_900_000): PyOut {
  const r = run(resolvePython()?.path ?? 'python3', [RESOLVE_PY(), ...args], timeoutMs);
  const last = r.out.split('\n').filter(Boolean).pop() ?? '';
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(last) as Record<string, unknown>; } catch { json = null; }
  return { code: r.code, json, err: r.err };
}

/**
 * 「Resolve 에 명령을 낼 수 있나」를 값으로 — true 붙음 · false 못 붙음(앱 꺼짐·외부 스크립팅 꺼짐) · ***null 못 물어봤다***.
 * ⛔ null 을 false 로 접지 않는다 — python3 나 헬퍼가 없으면 「안 떴다」가 아니라 「못 쟀다」다.
 */
export function resolvePing(timeoutMs = 20_000): { attached: boolean | null; version: string | null; why: string | null } {
  const r = py(['ping'], timeoutMs);
  if (r.code === 0 && r.json?.attached === true) return { attached: true, version: String(r.json.version ?? ''), why: null };
  if (r.code === 3) return { attached: false, version: null, why: String(r.json?.why ?? r.err.slice(-200)) };
  return { attached: null, version: null, why: `ping 을 못 물어봤다(code=${String(r.code)}) ${r.err.slice(-160)}` };
}

export const resolveTimeline: Recipe = async (ctx) => {
  const hp = ctx.state.handles_json as string | undefined;
  if (!hp) return need('handles_json');
  const sp = ctx.state.shots_json as string | undefined;
  const man = readJson<HandleManifest>(hp);
  const s = sp && existsSync(sp) ? readJson<Shots>(sp) : undefined;
  const layers = [
    ctx.state.scrim && { name: 'V2 스크림', path: ctx.state.scrim, mode: 'normal', loop: true },
    ctx.state.text && { name: 'V3 자막', path: ctx.state.text, mode: 'normal', loop: false },
    ctx.state.leaks && { name: 'V4 라이트리크', path: ctx.state.leaks, mode: 'screen', loop: false },
    ctx.state.grain && { name: 'V5 그레인', path: ctx.state.grain, mode: 'overlay', opacity: 20, loop: true },
    ctx.state.cards && { name: 'V6 지도카드', path: ctx.state.cards, mode: 'normal', loop: false },
  ].filter(Boolean);
  const spec = {
    project_name: String(ctx.state.project_name ?? 'vlog'), timeline_name: '본편',
    fps: man.fps, width: s?.width ?? 1080, height: s?.height ?? 1920,
    cuts: man.order.map((k) => ({ path: man.cuts[k]!.path, head: man.cuts[k]!.head, body: man.cuts[k]!.body, trans: man.cuts[k]!.trans })),
    layers, music: (ctx.state.ducked_wav as string | null | undefined) ?? null,
  };
  const specPath = join(ctx.workdir, 'resolve_spec.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const r = py(['build', '--spec', specPath]);
  if (r.code === 3) return { outcome: 'app-silent', note: String(r.json?.why ?? 'Resolve 무응답') };
  if (r.code !== 0 || !r.json?.ok) return { outcome: 'error', note: String(r.json?.why ?? r.err.slice(-200)) };
  writeFileSync(join(ctx.workdir, 'resolve_build.json'), JSON.stringify(r.json, null, 2));
  return {
    outcome: 'ok',
    produced: { project: r.json.project, timeline: r.json.timeline },
    note: `Resolve «${r.json.project}» · 컷 ${spec.cuts.length} · 전환 ${r.json.transitions_made} · 층 ${layers.length}${spec.music ? ' · BGM' : ''}`,
  };
};

export const timelineReadback: Recipe = async (ctx) => {
  const project = ctx.state.project as string | undefined, timeline = ctx.state.timeline as string | undefined;
  if (!project || !timeline) return need('timeline');
  const hp = ctx.state.handles_json as string | undefined;
  const man = hp ? readJson<HandleManifest>(hp) : undefined;
  const target = man ? man.order.reduce((a, k) => a + man.cuts[k]!.body, 0) : 0;
  const r = py(['readback', '--project', project, '--timeline', timeline, '--target-frames', String(target)]);
  if (r.code === 3 || !r.json?.ok) return { outcome: UNOBSERVED, note: String(r.json?.why ?? r.err.slice(-200)) };
  const gaps = (r.json.gaps as unknown[]) ?? [], lens = (r.json.transition_lens as number[]) ?? [], end = Number(r.json.end_frame);
  const produced = { gaps, transition_lens: lens, end_frame: end };
  if (gaps.length > 0) return { outcome: 'gap', produced, note: `컷 사이 틈 ${gaps.length}` };
  if (lens.some((x) => x < 6)) return { outcome: 'short-transition', produced, note: `주저앉은 전환 ${lens.filter((x) => x < 6)}` };
  if (end !== target) return { outcome: 'wrong-length', produced, note: `끝 ${end}f ≠ 계획 ${target}f` };
  return { outcome: 'pass', produced, note: `틈 0 · 전환 ${lens.length ? lens.join('/') + 'f' : '없음'} · 끝 ${end}f = 계획` };
};

export const exportMaster: Recipe = async (ctx) => {
  const project = ctx.state.project as string | undefined, timeline = ctx.state.timeline as string | undefined;
  if (!project || !timeline) return need('timeline');
  const out = join(ctx.workdir, 'render');
  const r = py(['render', '--project', project, '--timeline', timeline, '--out-dir', out, '--name', 'master']);
  if (r.code === 3) return { outcome: 'app-silent', note: String(r.json?.why ?? 'Resolve 무응답') };
  if (r.code !== 0 || !r.json?.ok) return { outcome: 'error', note: String(r.json?.why ?? r.err.slice(-200)) };
  return { outcome: 'ok', produced: { master: r.json.master }, note: `Resolve 렌더 ${r.json.secs}s → ${String(r.json.master).split('/').pop()}` };
};

// ── ⑭ qc · render-qc ──────────────────────────────────────────────────────
/** ⭐ 같은 «검정»이라도 원인 노드가 다르다 — 그래서 증상을 «갈라» 낸다(간선이 되돌아갈 곳을 안다). */
export const renderQc: Recipe = async (ctx) => {
  const master = ctx.state.master as string | undefined;
  if (!master || !existsSync(master)) return { outcome: UNOBSERVED, note: 'master 가 없다' };
  const hp = ctx.state.handles_json as string | undefined;
  const man = hp ? readJson<HandleManifest>(hp) : undefined;
  const target = man ? man.order.reduce((a, k) => a + man.cuts[k]!.body, 0) : null;
  const bd = run('ffmpeg', ['-hide_banner', '-i', master, '-vf', 'blackdetect=d=0.03:pix_th=0.10', '-an', '-f', 'null', '-'], 900_000);
  const black_frames = (bd.err.match(/black_start:/g) ?? []).length;
  const cnt = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', master], 900_000);
  // 🩸 2026-09-23 실측: 이 ffprobe 판은 «스트림 그룹» 때문에 같은 수를 «두 줄»로 찍는다(`1415⏎⏎1415`).
  //   통째로 Number() 하면 NaN ⇒ 「못 셌다」로 둔갑했다. ⇒ 첫 «숫자 줄»만 읽는다.
  const nb = Number(cnt.out.split('\n').map((x) => x.trim()).find((x) => /^\d+$/.test(x)) ?? NaN);
  const build = existsSync(join(ctx.workdir, 'resolve_build.json')) ? readJson<{ layers?: { name: string; span: number[] }[] }>(join(ctx.workdir, 'resolve_build.json')) : undefined;
  const missing = (build?.layers ?? []).filter((l) => target !== null && (l.span[0] !== 0 || l.span[1] < target) && !/자막|리크|카드/.test(l.name));
  const produced = { black_frames, layer_hits: (build?.layers?.length ?? 0) - missing.length, sheet_match: target === null ? null : Math.abs(nb - target) <= 1 };
  if (!Number.isFinite(nb)) return { outcome: UNOBSERVED, produced, note: '프레임을 못 셌다' };
  if (black_frames > 0) {
    // ⭐ «검정»의 원인을 가른다 — 그 자리의 «원래 컷»이 밝았는데 결과가 검정이면 ***층이 덮은 것***이다.
    //   🩸 2026-09-23 실물: 불투명 자막 층이 0~47s 전부를 덮었는데, 종전 규칙(«검정 → 컷»)은
    //      멀쩡한 컷으로 되돌아가 «같은 검정»을 예산이 다할 때까지 다시 구웠을 것이다.
    const bs = /black_start:([\d.]+)\s+black_end:([\d.]+)/.exec(bd.err);
    if (bs && man) {
      const mid = (Number(bs[1]) + Number(bs[2])) / 2;
      let acc = 0, hit: HandleEntry | undefined;
      for (const k of man.order) { const e = man.cuts[k]!; const d = e.body / man.fps; if (mid < acc + d) { hit = e; break; } acc += d; }
      const lum = (path: string, at: number): number | null => {
        const r = run('ffmpeg', ['-hide_banner', '-nostats', '-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
        const m = /YAVG=([\d.]+)/.exec(r.err); return m ? Number(m[1]) : null;
      };
      const cutY = hit ? lum(hit.path, hit.head / man.fps + (mid - acc)) : null;
      if (cutY !== null && cutY > 40) {
        return { outcome: 'layer-missing', produced, note: `검정 ${Number(bs[1]).toFixed(2)}~${Number(bs[2]).toFixed(2)}s — 그 자리 원래 컷은 밝다(YAVG ${cutY.toFixed(0)}) ⇒ ***층이 덮었다***` };
      }
    }
    return { outcome: 'blackframe', produced, note: `검정 구간 ${black_frames} — 원래 컷도 어둡다 ⇒ 원인은 «컷»(09-19)` };
  }
  if (missing.length > 0) return { outcome: 'layer-missing', produced, note: `타임라인을 못 덮은 층: ${missing.map((l) => l.name).join(', ')}` };
  if (target !== null && Math.abs(nb - target) > 1) return { outcome: 'sheet-mismatch', produced, note: `렌더 ${nb}f ≠ 원장 ${target}f` };
  return { outcome: 'pass', produced, note: `검정 0 · 층 ${produced.layer_hits} · ${nb}f = 원장` };
};

// ── ⑮ deliver · encode-and-sheet ─────────────────────────────────────────
export const encodeAndSheet: Recipe = async (ctx) => {
  const master = ctx.state.master as string | undefined;
  const sp = ctx.state.shots_json as string | undefined;
  if (!master) return need('master');
  const dir = join(ctx.workdir, 'deliver');
  mkdirSync(dir, { recursive: true });
  const final = join(dir, 'final.mp4');
  const r = ffmpeg(['-i', master, '-c', 'copy', '-movflags', '+faststart', final]);
  if (!r.ok) return { outcome: 'error', note: `납품 인코딩 실패: ${r.err.slice(-200)}` };
  const s = sp && existsSync(sp) ? readJson<Shots>(sp) : undefined;
  let t = 0;
  const rows = (s?.chapters ?? []).map((ch) => {
    const d = ch.cuts.reduce((a, c) => a + Math.round(c.dur * (s!.fps)) / s!.fps, 0);
    const row = `| ${ch.id} | ${t.toFixed(2)}s | ${d.toFixed(2)}s | ${(ch.text ?? ch.title ?? '').replace(/\|/g, '/')} |`;
    t += d; return row;
  });
  const review_sheet = join(dir, 'review_sheet.md');
  writeFileSync(review_sheet, [
    `# 검수표 — ${ctx.state.project ?? 'vlog'}`, '',
    `- 납품: \`${final}\``, `- 원장: \`${sp ?? '-'}\``, `- 인점 시트: \`${ctx.state.contact_sheet ?? '-'}\``,
    `- QC: 검정 ${ctx.state.black_frames ?? '-'} · 층 ${ctx.state.layer_hits ?? '-'} · 원장 일치 ${ctx.state.sheet_match ?? '-'}`,
    `- 더킹: 말할 때 ${ctx.state.duck_db ?? '-'}dB · 조용할 때 ${ctx.state.silent_db ?? '-'}dB`, '',
    '| 장 | 시작 | 길이 | 문구 |', '|---|---|---|---|', ...rows, '',
  ].join('\n'));
  return { outcome: 'ok', produced: { deliverables: [final], review_sheet }, note: `납품 ${final.split('/').pop()} · 검수표` };
};

export const VLOG: Readonly<Record<string, Recipe>> = {
  'probe-sources': probeSources,
  'whisper-korean': whisperKorean,
  'author-shots-json': authorShotsJson,
  'verify-frames': verifyFrames,
  'build-layers': buildLayers,
  'extract-cuts-with-handles': extractCutsWithHandles,
  'frame-exact-gate': frameExactGate,
  'body-then-duck': bodyThenDuck,
  'level-based-duck-gate': levelBasedDuckGate,
  'resolve-timeline': resolveTimeline,
  'timeline-readback': timelineReadback,
  'export-master': exportMaster,
  'render-qc': renderQc,
  'encode-and-sheet': encodeAndSheet,
};
