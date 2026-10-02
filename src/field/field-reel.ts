// 한 행사 폴더의 업로드 디바운스와 직렬 렌더. 프로세스 안의 폴더별 단일 실행기.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { listFieldMedia } from './field-media.js';
import { startFieldFeed, type FieldFeedStart } from './field-feed-auto.js';

export interface FieldReelResult { ok: boolean; file?: string; seconds: number; error?: string; feed?: FieldFeedStart }
export type FieldReelRunner = (dir: string, opts: { title: string; sub: string }) => Promise<FieldReelResult>;
export interface FieldReelStatus {
  state: 'waiting' | 'rendering' | 'done' | 'failed';
  items: number;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  seconds?: number;
  file?: string;
  error?: string;
}
export interface FieldReelOptions {
  quietMs?: number;
  title?: string;
  sub?: string;
  runner?: FieldReelRunner;
  onDone?: (result: FieldReelResult) => void | Promise<void>;
  /** 같은 수신자가 앨범 항목마다 예약해도 한 렌더당 한 번만 통지한다. */
  notificationKey?: string;
  /** EV10e — 렌더 성공 뒤 인스타 피드 초안 런을 띄운다(기본 켬 · `false` 나 `ELANOUS_FIELD_FEED_AUTO=0` 이면 끔). */
  autoFeed?: boolean;
  /** 시험용 — 피드 시작을 바꿔 끼운다. */
  startFeed?: (dir: string) => FieldFeedStart;
}

const REEL_FILE = 'reel-9x16.mp4';
interface Job {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  dirty: boolean;
  lastUploadAt: number;
  opts: FieldReelOptions;
  callbacks: Map<string, NonNullable<FieldReelOptions['onDone']>>;
}
const jobs = new Map<string, Job>();

export function fieldReelFile(dir: string): string { return join(dir, 'reel', REEL_FILE); }

/** 요청 경로용 싼 검사 — 파일이 있고 비어 있지 않다. 디코딩 검사는 렌더가 끝날 때 한 번(`isValidFieldReelFile`)만 한다. */
export function hasFieldReelFile(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Publish only a reel with a decodable video frame, not merely valid-looking MP4 boxes.
 *  렌더 완료 때 한 번만 부른다 — 첫 영상 프레임 하나만 읽는다(`-read_intervals %+#1`) · 긴 영상도 출력이 작다. */
export function isValidFieldReelFile(file: string): boolean {
  try {
    if (!hasFieldReelFile(file)) return false;
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_streams', '-show_frames',
      '-show_entries', 'stream=codec_type:frame=media_type', '-of', 'json', file,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })) as {
      streams?: Array<{ codec_type?: string }>;
      frames?: Array<{ media_type?: string }>;
    };
    return probe.streams?.some((stream) => stream.codec_type === 'video') === true
      && probe.frames?.some((frame) => frame.media_type === 'video') === true;
  } catch {
    return false;
  }
}
/** 상태 파일은 `reel/` «밖»에 둔다 — `reel.sh` 가 시작할 때 `reel/` 을 지우므로 안에 두면 렌더 중에 사라진다. */
export function fieldReelStatusPath(dir: string): string { return join(dir, '.reel-status.json'); }
const statusPath = fieldReelStatusPath;
function writeStatus(dir: string, status: Omit<FieldReelStatus, 'updatedAt'>): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.reel-status-${randomUUID()}`);
  try {
    writeFileSync(tmp, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }));
    renameSync(tmp, statusPath(dir));
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function readFieldReelStatus(dir: string): FieldReelStatus | null {
  try { return JSON.parse(readFileSync(statusPath(dir), 'utf8')) as FieldReelStatus; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export const defaultFieldReelRunner: FieldReelRunner = (dir, { title, sub }) => new Promise((finish) => {
  const script = resolve(import.meta.dir, '../../skills/explainer-video/engine/reel.sh');
  const started = Date.now();
  const child = spawn('zsh', [script, dir, '--title', title, '--sub', sub], { stdio: 'ignore' });
  let settled = false;
  const done = (error?: string) => {
    if (settled) return;
    settled = true;
    const file = fieldReelFile(dir);
    const seconds = Math.round((Date.now() - started) / 1000);
    // 디코딩 검사(ffprobe)는 `render()` 한 곳에서만 한다 — 여기선 존재만 본다(리뷰: 검사 두 번 금지).
    finish(error || !hasFieldReelFile(file)
      ? { ok: false, seconds, error: error ?? `invalid or missing MP4 output: ${file}` }
      : { ok: true, file, seconds });
  };
  child.once('error', (err) => done(err.message));
  child.once('close', (code) => done(code === 0 ? undefined : `reel.sh exited ${code ?? 'unknown'}`));
});

function arm(dir: string, job: Job): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    job.timer = undefined;
    if (!job.running) void render(dir, job);
  }, Math.max(0, (job.opts.quietMs ?? 20_000) - (Date.now() - job.lastUploadAt)));
  job.timer.unref?.();
}

async function render(dir: string, job: Job): Promise<void> {
  job.running = true;
  job.dirty = false;
  const items = listFieldMedia(dir).length;
  const startedAt = new Date().toISOString();
  const event = dir.split(/[\\/]/).at(-1)!;
  // 현재 렌더의 수신자 스냅샷. 렌더 중 업로드의 수신자는 다음 렌더로 넘긴다.
  const callbacks = job.callbacks;
  const renderOpts = job.opts;
  job.callbacks = new Map();
  writeStatus(dir, { state: 'rendering', items, startedAt });
  mkdirSync(join(dir, 'reel'), { recursive: true }); // 실행기 계약 — 산출 폴더는 있다(reel.sh 는 스스로 다시 만든다)
  debug.log('field.reel', 'started', { event, items });
  let result: FieldReelResult;
  try {
    const date = new Date();
    const sub = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    let titleLines: string[] = [];
    try { titleLines = readFileSync(join(dir, 'title.txt'), 'utf8').split(/\r?\n/); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    result = await (renderOpts.runner ?? defaultFieldReelRunner)(dir, {
      title: titleLines[0]?.trim() || renderOpts.title || event,
      sub: titleLines[1]?.trim() || renderOpts.sub || sub,
    });
  } catch (err) {
    result = { ok: false, seconds: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.ok && (!result.file || resolve(result.file) !== fieldReelFile(dir) || !isValidFieldReelFile(result.file))) {
    result = { ok: false, seconds: result.seconds, error: 'render output invalid or missing' };
  }
  const finishedAt = new Date().toISOString();
  writeStatus(dir, { state: result.ok ? 'done' : 'failed', items, startedAt, finishedAt,
    seconds: result.seconds, ...(result.ok ? { file: result.file } : { error: result.error ?? 'render failed' }) });
  debug.log('field.reel', result.ok ? 'done' : 'failed', { event, items, seconds: result.seconds });
  if (result.ok) {
    // EV10b: 엔진이 timeline.json 에 남긴 비전 호출 수·성공·«현장 N» 강등·걸린 ms — codex 잔량과 겹치므로 관측한다(OP 10-01).
    try {
      const t = JSON.parse(readFileSync(join(dir, 'reel', 'timeline.json'), 'utf8')) as { vision?: Record<string, unknown>; music?: unknown };
      if (t.vision) debug.log('field.reel', 'vision', { event, ...t.vision, music: t.music === true });
    } catch { debug.log('field.reel', 'vision-unread', { event }); }
  }
  // 뒤이은 업로드로 다시 렌더할 예정이면(dirty) 피드는 그 마지막 렌더 뒤에 한 번만 띄운다.
  if (result.ok && !job.dirty) result = { ...result, feed: (renderOpts.startFeed ?? ((d: string) => startFieldFeed(d, { enabled: renderOpts.autoFeed })))(dir) };
  job.running = false;
  if (job.dirty) {
    writeStatus(dir, { state: 'waiting', items: listFieldMedia(dir).length });
    arm(dir, job);
  } else {
    jobs.delete(dir);
  }
  for (const cb of callbacks.values()) {
    void Promise.resolve().then(() => cb(result)).catch((err) => {
      debug.log('field.reel', 'delivery-failed', { event, error: String(err) });
    });
  }
}

/** 저장 성공 직후 호출한다. quiet 기간의 연속 업로드를 합치고 렌더 중 변경은 뒤이어 다시 렌더한다. */
export function scheduleFieldReel(dir: string, opts: FieldReelOptions = {}): void {
  dir = resolve(dir);
  const event = dir.split(/[\\/]/).at(-1)!;
  let job = jobs.get(dir);
  if (!job) {
    job = { running: false, dirty: false, lastUploadAt: Date.now(), opts, callbacks: new Map() };
    jobs.set(dir, job);
  }
  job.opts = { ...opts, runner: opts.runner ?? job.opts.runner, quietMs: opts.quietMs ?? job.opts.quietMs };
  job.lastUploadAt = Date.now();
  if (opts.onDone) job.callbacks.set(opts.notificationKey ?? 'default', opts.onDone);
  const items = listFieldMedia(dir).length;
  if (job.running) job.dirty = true;
  else {
    writeStatus(dir, { state: 'waiting', items });
    arm(dir, job);
  }
  debug.log('field.reel', 'scheduled', { event, items });
}
