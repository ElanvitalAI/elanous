import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, parse, relative, sep } from 'node:path';
import { run, type RunResult } from './ffmpeg.js';
import { UNOBSERVED, type Recipe, type RecipeCtx } from './types.js';

export interface AlignedWord { word: string; start: number; end: number }
export interface BrollSlot { start: number; end: number; prompt: string }
export interface BrollClip extends BrollSlot { path: string }
export type BrollRun = (bin: string, args: readonly string[], timeoutMs: number) => RunResult;
export type BrollAgent = (slot: BrollSlot, options: { signal: AbortSignal; timeoutMs: number }) => Promise<string | null>;

const runner = (ctx: RecipeCtx): BrollRun => typeof ctx.state.broll_run === 'function' ? ctx.state.broll_run as BrollRun : run;
const missing = (key: string) => ({ outcome: UNOBSERVED, note: `계약 입력 '${key}' 가 state 에 없다` });
const positive = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const safeAsset = (path: string, dir: string): boolean => {
  try {
    const root = realpathSync(dir);
    const asset = realpathSync(path);
    return inside(root, asset) && /\.(mp4|mov|webm)$/i.test(asset);
  } catch { return false; }
};
const errorOf = (e: unknown): string => e instanceof Error ? e.message : String(e);
const fingerprint = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const clipRecord = (clips: BrollClip[]) => clips.map(({ path, start, end }) => ({ path: realpathSync(path), start, end }));

/** Compare decoded pixels, not an intended-cut manifest or container metadata. */
const decodedFrame = (path: string, time: number, execute: BrollRun, workdir: string): Buffer | null => {
  const frameDir = mkdtempSync(join(realpathSync(workdir), 'broll-frame-'));
  try {
    const framePath = join(frameDir, 'sample.rgb');
    const r = execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', path,
      '-frames:v', '1', '-vf', 'scale=32:18,format=rgb24', '-f', 'rawvideo', framePath], 30_000);
    if (!r.ok || !safeManifest(framePath, workdir)) return null;
    const frame = readFileSync(framePath);
    return frame.length === 32 * 18 * 3 ? frame : null;
  } finally { rmSync(frameDir, { recursive: true, force: true }); }
};
const pixelDifference = (a: Buffer, b: Buffer): number => {
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference += Math.abs(a[i]! - b[i]!);
  return difference / a.length;
};
const manifestPath = (path: string): string => `${path}.clips.json`;
const safeManifest = (path: string, dir: string): boolean => {
  try { return inside(realpathSync(dir), realpathSync(path)); } catch { return false; }
};
const occupied = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
};

/** Use supplied word timings or Whisper's JSON artifact; stdout is diagnostic text, not alignment data. */
export const brollAlignWords: Recipe = async (ctx) => {
  let words: unknown = ctx.state.aligned_words;
  if (words === undefined) {
    const audio = ctx.state.audio_path;
    if (typeof audio !== 'string' || !existsSync(audio)) return missing('aligned_words or audio_path');
    mkdirSync(ctx.workdir, { recursive: true });
    const workRoot = realpathSync(ctx.workdir);
    const outputDir = join(workRoot, 'broll-alignment');
    mkdirSync(outputDir, { recursive: true });
    if (!inside(workRoot, realpathSync(outputDir))) return { outcome: 'error', note: '정렬 출력 디렉터리가 workdir 밖을 가리킨다' };
    const output = join(outputDir, `${parse(audio).name}.json`);
    if (occupied(output)) {
      let resolved: string;
      try { resolved = realpathSync(output); } catch { return { outcome: UNOBSERVED, note: '정렬 출력 파일이 깨진 심볼릭 링크다' }; }
      if (!inside(workRoot, resolved)) return { outcome: 'error', note: '정렬 출력 파일이 workdir 밖을 가리킨다' };
      rmSync(output);
    }
    const r = runner(ctx)('whisper', [audio, '--output_format', 'json', '--word_timestamps', 'True', '--output_dir', outputDir], 180_000);
    if (!r.ok) return { outcome: 'error', note: `단어 정렬 실패: ${r.err || r.signal || r.code}` };
    try {
      if (!inside(workRoot, realpathSync(output))) return { outcome: 'error', note: '정렬 출력 파일이 workdir 밖을 가리킨다' };
      const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'));
      words = Array.isArray(parsed) ? parsed :
        parsed && typeof parsed === 'object' && 'segments' in parsed && Array.isArray(parsed.segments)
          ? parsed.segments.flatMap((segment: { words?: unknown }) => Array.isArray(segment.words) ? segment.words : [])
            .filter((w: { start?: unknown; end?: unknown }) => w && !(typeof w.start === 'number' && w.start === w.end))
          : parsed;
    } catch { return { outcome: UNOBSERVED, note: '정렬 JSON 파일을 읽을 수 없다' }; }
  }
  if (!Array.isArray(words) || words.length === 0 || !words.every((w) => w && typeof w.word === 'string' && w.word.trim() && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start) ||
    words.some((w, i) => i > 0 && w.start < words[i - 1].end)) {
    return { outcome: UNOBSERVED, note: '시각이 정렬된 유효한 단어가 없다' };
  }
  const aligned_words: AlignedWord[] = words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
  return { outcome: 'ok', produced: { aligned_words, narration_seconds: aligned_words[aligned_words.length - 1]!.end }, note: `정렬 단어 ${aligned_words.length}개` };
};

/** Equally spaced slots are snapped to actual word boundaries; the density is clips per minute. */
export const brollDensityPlan: Recipe = async (ctx) => {
  const words = ctx.state.aligned_words as AlignedWord[] | undefined;
  if (!Array.isArray(words) || !words.length) return missing('aligned_words');
  const density = positive(ctx.state.density_target);
  if (density === null) return missing('density_target (clips/min)');
  const duration = words[words.length - 1]?.end;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return { outcome: UNOBSERVED, note: '나레이션 길이를 못 쟀다' };
  const count = Math.max(1, Math.ceil(duration * density / 60));
  if (!Number.isSafeInteger(count)) return { outcome: UNOBSERVED, note: '목표 컷 수를 계산할 수 없다' };
  if (words.length < count) return { outcome: UNOBSERVED, note: `목표 ${count}컷 달성 불가: 단어 경계 ${words.length}개` };
  if (!words.every((w, i) => w && typeof w.word === 'string' && w.word.trim() && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start &&
    (i === 0 || w.start >= words[i - 1]!.end))) return { outcome: UNOBSERVED, note: '겹치거나 유효하지 않은 단어 경계로 목표 컷을 배치할 수 없다' };
  const slots: BrollSlot[] = [];
  let from = 0;
  for (let i = 1; i <= count; i++) {
    const remaining = count - i;
    const desired = duration * i / count;
    let to = words.length - remaining;
    if (remaining) {
      for (let j = from + 1; j <= to; j++) {
        if (words[j]!.start >= desired) { to = j; break; }
      }
    }
    const group = words.slice(from, to);
    slots.push({ start: group[0]!.start, end: group[group.length - 1]!.end, prompt: group.map((w) => w.word).join(' ') });
    from = to;
  }
  return { outcome: 'ok', produced: { broll_slots: slots, density_target: density, target_clips: count }, note: `목표 ${count}컷 · 단어 경계에 놓인 ${slots.length}컷` };
};

/** A failing/timed-out agent must not hold up the rest of the line. Only paths below clips_dir are accepted. */
export const brollSelectClips: Recipe = async (ctx) => {
  const slots = ctx.state.broll_slots as BrollSlot[] | undefined;
  if (!Array.isArray(slots)) return missing('broll_slots');
  const agent = ctx.state.broll_agent as BrollAgent | undefined;
  if (typeof agent !== 'function') return missing('broll_agent');
  const dir = ctx.state.clips_dir;
  if (typeof dir !== 'string' || !existsSync(dir)) return missing('clips_dir');
  const timeoutMs = positive(ctx.state.clip_timeout_ms) ?? 30_000;
  const clips: BrollClip[] = [], skipped: { index: number; reason: string }[] = [];
  for (const [index, slot] of slots.entries()) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const selected = await Promise.race([
        Promise.resolve().then(() => agent(slot, { signal: abort.signal, timeoutMs })),
        new Promise<null>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, timeoutMs); }),
      ]);
      if (typeof selected !== 'string' || !safeAsset(selected, dir)) {
        skipped.push({ index, reason: 'clip missing or outside clips_dir' });
      } else clips.push({ ...slot, path: realpathSync(selected) });
    } catch (e) { skipped.push({ index, reason: errorOf(e) }); }
    finally { if (timer) clearTimeout(timer); }
    if (skipped.at(-1)?.index === index) ctx.log('broll.clip-skipped', skipped.at(-1));
  }
  return { outcome: clips.length ? 'ok' : 'empty', produced: { broll_clips: clips, skipped_clips: skipped }, note: `선택 ${clips.length}/${slots.length} · 스킵 ${skipped.length}` };
};

/** FFmpeg receives argv, never a shell string; output is fixed under workdir. */
export const brollRender: Recipe = async (ctx) => {
  const base = ctx.state.base_video;
  const clips = ctx.state.broll_clips as BrollClip[] | undefined;
  if (typeof base !== 'string' || !existsSync(base)) return missing('base_video');
  if (!Array.isArray(clips)) return missing('broll_clips');
  const dir = ctx.state.clips_dir;
  if (typeof dir !== 'string' || !existsSync(dir)) return missing('clips_dir');
  const valid = clips.filter((c) => safeAsset(c.path, dir) && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start);
  if (!valid.length) return { outcome: 'empty', produced: { rendered_path: null }, note: '렌더할 안전한 클립이 없다' };
  mkdirSync(ctx.workdir, { recursive: true });
  const workRoot = realpathSync(ctx.workdir);
  const outputDir = join(workRoot, 'broll');
  mkdirSync(outputDir, { recursive: true });
  if (!inside(workRoot, realpathSync(outputDir))) return { outcome: 'error', note: 'BROLL 출력 디렉터리가 workdir 밖을 가리킨다' };
  const rendered_path = join(outputDir, 'broll.mp4');
  if (occupied(rendered_path)) {
    let resolved: string;
    try { resolved = realpathSync(rendered_path); } catch { return { outcome: 'error', note: 'BROLL 출력 파일이 깨진 심볼릭 링크다' }; }
    if (!inside(workRoot, resolved)) return { outcome: 'error', note: 'BROLL 출력 파일이 workdir 밖을 가리킨다' };
    rmSync(rendered_path);
  }
  const manifest = manifestPath(rendered_path);
  if (occupied(manifest)) {
    let resolved: string;
    try { resolved = realpathSync(manifest); } catch { return { outcome: 'error', note: 'BROLL 클립 기록 파일이 깨진 심볼릭 링크다' }; }
    if (!inside(workRoot, resolved)) return { outcome: 'error', note: 'BROLL 클립 기록 파일이 workdir 밖을 가리킨다' };
    rmSync(manifest);
  }
  const filters: string[] = ['[0:v]setpts=PTS-STARTPTS,scale=1920:1080,setsar=1[v0]'];
  valid.forEach((c, i) => {
    const dur = c.end - c.start;
    filters.push(`[${i + 1}:v]trim=duration=${dur},setpts=PTS-STARTPTS+${c.start}/TB,scale=1920:1080,setsar=1[b${i}]`);
    filters.push(`[v${i}][b${i}]overlay=0:0:eof_action=pass:enable='between(t,${c.start},${c.end})'[v${i + 1}]`);
  });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', base, ...valid.flatMap((c) => ['-i', c.path]), '-filter_complex', filters.join(';'), '-map', `[v${valid.length}]`, '-map', '0:a?', '-c:v', 'libx264', '-c:a', 'copy', '-movflags', '+faststart', rendered_path];
  const r = runner(ctx)('ffmpeg', args, 1_200_000);
  if (!r.ok || !existsSync(rendered_path) || !safeAsset(rendered_path, workRoot)) return { outcome: 'error', note: `BROLL 렌더 실패: ${r.err || r.signal || '안전한 산출 파일 없음'}` };
  writeFileSync(manifest, JSON.stringify({ sha256: await fingerprint(rendered_path), base: realpathSync(base), clips: clipRecord(valid) }));
  return { outcome: 'ok', produced: { rendered_path, rendered_clips: valid.length }, note: `BROLL ${valid.length}컷 · ${basename(rendered_path)}` };
};

/** Fail closed if the rendered artifact cannot be measured; enforce actual coverage, not just a successful subprocess. */
export const brollQc: Recipe = async (ctx) => {
  const path = ctx.state.rendered_path;
  const clips = ctx.state.broll_clips as BrollClip[] | undefined;
  const density = positive(ctx.state.density_target);
  if (typeof path !== 'string' || !existsSync(path)) return missing('rendered_path');
  if (!safeAsset(path, ctx.workdir)) return { outcome: 'fail', note: '렌더 산출 경로가 workdir 밖이거나 영상 파일이 아니다' };
  if (!Array.isArray(clips) || density === null) return missing('broll_clips or density_target');
  const manifest = manifestPath(path);
  if (!existsSync(manifest) || !safeManifest(manifest, ctx.workdir)) return { outcome: 'fail', note: '렌더 클립 기록이 없거나 workdir 밖이다' };
  let recorded: unknown;
  try { recorded = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return { outcome: 'fail', note: '렌더 클립 기록을 읽을 수 없다' }; }
  let currentClips: ReturnType<typeof clipRecord>;
  try {
    if (!clips.every((c) => c && typeof c.path === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end))) {
      return { outcome: 'fail', note: '렌더 클립 입력이 유효하지 않다' };
    }
    currentClips = clipRecord(clips);
  } catch { return { outcome: 'fail', note: '렌더 클립 입력 파일을 확인할 수 없다' }; }
  if (!recorded || typeof recorded !== 'object' || !('sha256' in recorded) || recorded.sha256 !== await fingerprint(path) ||
    !('base' in recorded) || typeof recorded.base !== 'string' || !existsSync(recorded.base) ||
    !('clips' in recorded) || !Array.isArray(recorded.clips) || recorded.clips.length === 0 ||
    !recorded.clips.every((c: unknown) => c && typeof c === 'object' && 'path' in c && typeof c.path === 'string' &&
      'start' in c && typeof c.start === 'number' && Number.isFinite(c.start) && c.start >= 0 &&
      'end' in c && typeof c.end === 'number' && Number.isFinite(c.end) && c.end > c.start) ||
    JSON.stringify(recorded.clips) !== JSON.stringify(currentClips) ||
    ctx.state.rendered_clips !== recorded.clips.length) {
    return { outcome: 'fail', note: '렌더 클립 개수·입력 또는 산출물 기록이 일치하지 않는다' };
  }
  const r = runner(ctx)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], 30_000);
  const seconds = Number(r.out.trim());
  if (!r.ok || !Number.isFinite(seconds) || seconds <= 0) return { outcome: UNOBSERVED, note: '렌더 길이를 읽을 수 없다' };
  if (recorded.clips.some((c: { start: number; end: number }) => c.start >= seconds || c.end <= 0)) {
    return { outcome: 'fail', note: '렌더 길이 밖에 놓인 클립은 실제 영상에 나타나지 않는다' };
  }
  const base = recorded.base;
  let actual = 0;
  try {
    for (const clip of recorded.clips as { path: string; start: number; end: number }[]) {
      if (!existsSync(clip.path)) return { outcome: 'fail', note: '렌더 입력 클립이 없다' };
      const offset = Math.min((clip.end - clip.start) / 2, (seconds - clip.start) / 2);
      if (offset <= 0) continue;
      const execute = runner(ctx);
      const rendered = decodedFrame(path, clip.start + offset, execute, ctx.workdir);
      const source = decodedFrame(clip.path, offset, execute, ctx.workdir);
      const background = decodedFrame(base, clip.start + offset, execute, ctx.workdir);
      if (!rendered || !source || !background) return { outcome: UNOBSERVED, note: '실제 컷 프레임을 디코딩할 수 없다' };
      if (pixelDifference(rendered, source) <= 32 && pixelDifference(rendered, background) >= 8) actual++;
    }
  } catch (e) { return { outcome: UNOBSERVED, note: `컷 프레임 확인 실패: ${errorOf(e)}` }; }
  const density_actual = actual * 60 / seconds;
  const produced = { qc_seconds: seconds, density_actual, qc_pass: actual > 0 && density_actual >= density };
  return { outcome: produced.qc_pass ? 'pass' : 'fail', produced, note: `확인된 BROLL ${actual}컷 / ${seconds.toFixed(2)}s · ${density_actual.toFixed(2)}/${density} clips/min` };
};

export const BROLL: Readonly<Record<string, Recipe>> = {
  'broll-align-words': brollAlignWords,
  'broll-density-plan': brollDensityPlan,
  'broll-select-clips': brollSelectClips,
  'broll-render': brollRender,
  'broll-qc': brollQc,
};
