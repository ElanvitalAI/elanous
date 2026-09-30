import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunResult } from './ffmpeg.js';
import { UNOBSERVED, type Recipe, type RecipeCtx, type RecipeResult } from './types.js';

type CommandRunner = (bin: string, args: readonly string[], timeoutMs: number, cwd?: string) => RunResult;
interface ExplainerDeps { readonly run?: CommandRunner; readonly engineDir?: string }

const ENGINE = resolve(import.meta.dir, '../../../skills/explainer-video/engine');
const ENGINE_MS = 600_000;
const QC_MS = 180_000;

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Resolve existing ancestors as well: an output directory may be a symlink before the engine writes into it.
function safeOutput(root: string, candidate: string): boolean {
  const base = realpathSync(root);
  if (!inside(resolve(root), resolve(candidate))) return false;
  // Walk up to the deepest component that exists as a directory entry (lstat, not existsSync):
  // a broken symlink is «there» and must be judged, not skipped as missing.
  let path = resolve(candidate);
  for (;;) {
    let isLink: boolean;
    try { isLink = lstatSync(path).isSymbolicLink(); } catch {
      const parent = dirname(path);
      if (parent === path) return false;
      path = parent;
      continue;
    }
    if (isLink && !existsSync(path)) return false; // broken link — its target could be created outside the project
    return inside(base, realpathSync(path));
  }
}

function finish(ctx: RecipeCtx, name: string, result: RecipeResult): RecipeResult {
  ctx.log(`explainer.${name}`, { outcome: result.outcome, ...result.produced, note: result.note });
  return result;
}

function scriptPath(ctx: RecipeCtx): string | null {
  const value = ctx.state.script_path;
  return typeof value === 'string' && value.trim() ? resolve(value) : null;
}

function enginePath(deps: ExplainerDeps, file: string): string | null {
  const path = resolve(deps.engineDir ?? ENGINE, file);
  return existsSync(path) ? path : null;
}

function runner(deps: ExplainerDeps, ctx: RecipeCtx): CommandRunner {
  if (deps.run) return deps.run;
  return (bin, args, timeoutMs, cwd) => {
    const r = spawnSync(bin, [...args], {
      cwd, timeout: timeoutMs, encoding: 'utf8',
      env: { ...process.env, EXPLAINER_CACHE: resolve(ctx.workdir, 'explainer-cache') },
    });
    return { ok: r.status === 0, code: r.status, signal: r.signal ?? null,
      err: (r.stderr ?? r.error?.message ?? '').trim(), out: (r.stdout ?? '').trim() };
  };
}

function unavailable(r: RunResult): boolean {
  return r.signal === null && r.code === null && !r.ok;
}

function keys(script: unknown): string[] | null {
  if (!script || typeof script !== 'object') return null;
  const s = script as { intro?: { beats?: unknown }; chapters?: unknown; outro?: { beats?: unknown } };
  if (!Array.isArray(s.intro?.beats) || !Array.isArray(s.chapters) || !Array.isArray(s.outro?.beats)) return null;
  const chapters = s.chapters as { beats?: unknown }[];
  if (!chapters.every((c) => c && Array.isArray(c.beats))) return null;
  return [
    ...s.intro.beats.map((_, i) => `i-${i}`),
    ...chapters.flatMap((c, ci) => (c.beats as unknown[]).map((_, i) => `c${ci + 1}-${i}`)),
    ...s.outro.beats.map((_, i) => `o-${i}`),
  ];
}

export function explainerScript(): Recipe {
  return async (ctx) => {
    const path = scriptPath(ctx);
    if (!path) return finish(ctx, 'script', { outcome: 'no-facts', note: 'script_path 가 state 에 없다 — 대본 저작이 필요하다' });
    if (!existsSync(path)) return finish(ctx, 'script', { outcome: 'no-facts', note: `대본이 없다: ${path}` });
    let script: unknown;
    try { script = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { return finish(ctx, 'script', { outcome: UNOBSERVED, note: `대본 읽기 실패: ${String(e)}` }); }
    const chapters = (script as { chapters?: unknown } | null)?.chapters;
    const beatKeys = keys(script);
    const voiced = (beat: unknown): boolean => beat !== null && typeof beat === 'object' &&
      typeof (beat as { vo?: unknown }).vo === 'string' && (beat as { vo: string }).vo.trim().length > 0;
    if (!beatKeys?.length || !Array.isArray(chapters) || chapters.length === 0 ||
        !chapters.some((chapter: { beats: unknown[] }) => chapter.beats.some(voiced)) ||
        ![...(script as { intro: { beats: unknown[] } }).intro.beats,
          ...chapters.flatMap((chapter: { beats: unknown[] }) => chapter.beats),
          ...(script as { outro: { beats: unknown[] } }).outro.beats].every(voiced)) {
      return finish(ctx, 'script', { outcome: 'no-facts', note: 'intro.beats · chapters[] · outro.beats 에 내용이 없거나 구조가 없다' });
    }
    return finish(ctx, 'script', { outcome: 'ok', produced: { script_path: path } });
  };
}

export function explainerVo(deps: ExplainerDeps = {}): Recipe {
  return async (ctx) => {
    const path = scriptPath(ctx);
    if (!path || !existsSync(path)) return finish(ctx, 'vo', { outcome: UNOBSERVED, note: 'script_path 를 못 읽는다' });
    const engine = enginePath(deps, 'vo.ts');
    if (!engine) return finish(ctx, 'vo', { outcome: UNOBSERVED, note: 'skills/explainer-video/engine/vo.ts 가 없다' });
    const project = dirname(path);
    const voDir = resolve(project, 'source/vo');
    try {
      const beatKeys = keys(JSON.parse(readFileSync(path, 'utf8')));
      if (!beatKeys?.length) return finish(ctx, 'vo', { outcome: UNOBSERVED, note: '대본의 VO beat 를 못 읽었다' });
      const outputs = beatKeys.flatMap((key) => [
        resolve(voDir, `${key}.mp3`), resolve(voDir, `${key}.json`),
        resolve(voDir, `${key}.tmp.aiff`), resolve(voDir, `${key}.tmp.mp3`),
      ]);
      if (![voDir, ...outputs].every((p) => safeOutput(project, p))) {
        return finish(ctx, 'vo', { outcome: UNOBSERVED, note: 'VO 출력이 대본 폴더 밖을 가리킨다' });
      }
    } catch (e) { return finish(ctx, 'vo', { outcome: UNOBSERVED, note: `VO 경로 확인 실패: ${String(e)}` }); }
    let r: RunResult;
    try { r = runner(deps, ctx)('bun', [engine, path], ENGINE_MS, project); }
    catch (e) { return finish(ctx, 'vo', { outcome: UNOBSERVED, note: `bun vo.ts 를 못 불렀다: ${String(e)}` }); }
    if (unavailable(r)) return finish(ctx, 'vo', { outcome: UNOBSERVED, note: `bun vo.ts 를 못 불렀다(code=${r.code} signal=${r.signal}): ${r.err}` });
    if (!r.ok) return finish(ctx, 'vo', { outcome: 'error', note: `VO 엔진 실패: ${r.err.slice(0, 240)}` });
    try {
      const script = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const beatKeys = keys(script);
      if (!beatKeys?.length) throw new Error('대본에 VO beat 가 없다');
      let seconds = 0;
      for (const key of beatKeys) {
        const audio = resolve(voDir, `${key}.mp3`);
        const alignment = resolve(voDir, `${key}.json`);
        if (!safeOutput(project, audio) || !safeOutput(project, alignment) || !existsSync(audio)) throw new Error(`${key} VO 파일이 없다`);
        const j = JSON.parse(readFileSync(alignment, 'utf8')) as { alignment?: { character_end_times_seconds?: unknown } };
        const ends = j.alignment?.character_end_times_seconds;
        if (!Array.isArray(ends) || ends.length === 0 || !Number.isFinite(ends.at(-1)) || ends.at(-1) <= 0) throw new Error(`${key} 끝 시각을 못 읽었다`);
        seconds += ends.at(-1) as number;
      }
      return finish(ctx, 'vo', { outcome: 'ok', produced: { vo_dir: voDir, narration_seconds: seconds } });
    } catch (e) { return finish(ctx, 'vo', { outcome: UNOBSERVED, note: `VO 산출을 못 쟀다: ${String(e)}` }); }
  };
}

export function explainerBuild(deps: ExplainerDeps = {}): Recipe {
  return async (ctx) => {
    const path = scriptPath(ctx);
    if (!path || !existsSync(path)) return finish(ctx, 'build', { outcome: UNOBSERVED, note: 'script_path 를 못 읽는다' });
    const engine = enginePath(deps, 'build.mjs');
    if (!engine) return finish(ctx, 'build', { outcome: UNOBSERVED, note: 'skills/explainer-video/engine/build.mjs 가 없다' });
    const project = dirname(path);
    const hf = resolve(project, 'hf');
    const timeline = resolve(project, 'timeline.json');
    try {
      mkdirSync(ctx.workdir, { recursive: true });
      if (![hf, resolve(hf, 'assets'), resolve(hf, 'assets/fonts'), resolve(hf, 'assets/vo'), timeline].every((p) => safeOutput(project, p))
        || !safeOutput(ctx.workdir, resolve(ctx.workdir, 'explainer-cache'))) {
        return finish(ctx, 'build', { outcome: UNOBSERVED, note: '빌드 출력/캐시가 허용된 폴더 밖을 가리킨다' });
      }
    } catch (e) { return finish(ctx, 'build', { outcome: UNOBSERVED, note: `빌드 경로 확인 실패: ${String(e)}` }); }
    let r: RunResult;
    try { r = runner(deps, ctx)('node', [engine, path], ENGINE_MS, project); }
    catch (e) { return finish(ctx, 'build', { outcome: UNOBSERVED, note: `node build.mjs 를 못 불렀다: ${String(e)}` }); }
    if (unavailable(r)) return finish(ctx, 'build', { outcome: UNOBSERVED, note: `node build.mjs 를 못 불렀다(code=${r.code} signal=${r.signal}): ${r.err}` });
    if (!r.ok) {
      const badScript = /unknown diagram|DIAGRAMS\[dia\] is not a function|(?:invalid|missing|unsupported) (?:script|diagram|beat|chapter)/i.test(r.err);
      return finish(ctx, 'build', { outcome: badScript ? 'bad-script' : 'error', note: `빌드 실패: ${r.err.slice(0, 240)}` });
    }
    try {
      if (![resolve(hf, 'index.html'), timeline].every((p) => safeOutput(project, p) && existsSync(p))) {
        return finish(ctx, 'build', { outcome: UNOBSERVED, note: '빌드가 hf/index.html 또는 timeline.json 을 내지 않았다' });
      }
    } catch (e) { return finish(ctx, 'build', { outcome: UNOBSERVED, note: `빌드 산출 확인 실패: ${String(e)}` }); }
    return finish(ctx, 'build', { outcome: 'ok', produced: { hyperframes_project: hf, timeline_path: timeline } });
  };
}

export function explainerQc(deps: ExplainerDeps = {}): Recipe {
  return async (ctx) => {
    const path = ctx.state.hf_render_path;
    if (typeof path !== 'string' || !path || !existsSync(path)) {
      return finish(ctx, 'qc', { outcome: UNOBSERVED, note: 'hf_render_path 를 못 읽는다' });
    }
    let r: RunResult;
    try {
      r = runner(deps, ctx)('ffmpeg', ['-hide_banner', '-nostats', '-i', resolve(path),
        '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], QC_MS, ctx.workdir);
    } catch (e) { return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `ffmpeg 를 못 불렀다: ${String(e)}` }); }
    if (!r.ok) return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `ffmpeg 음량 측정 실패(code=${r.code} signal=${r.signal}): ${r.err.slice(0, 240)}` });
    const block = [...`${r.err}\n${r.out}`.matchAll(/\{[^{}]*"input_i"[^{}]*"input_tp"[^{}]*\}/g)].at(-1)?.[0];
    try {
      if (!block) throw new Error('loudnorm JSON 이 없다');
      const j = JSON.parse(block) as { input_i?: unknown; input_tp?: unknown };
      const loudness = Number(j.input_i);
      const peak = Number(j.input_tp);
      if (j.input_i == null || j.input_tp == null || !Number.isFinite(loudness) || !Number.isFinite(peak)) throw new Error('통합 음량/트루 피크가 비수다');
      const produced = { loudness_lufs: loudness, true_peak_db: peak };
      const outcome = loudness >= -16 && loudness <= -12 && peak <= -1 ? 'pass' : 'loudness';
      return finish(ctx, 'qc', { outcome, produced, note: `${loudness} LUFS · ${peak} dBTP` });
    } catch (e) { return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `loudnorm 결과를 못 읽었다: ${String(e)}` }); }
  };
}

export const EXPLAINER: Readonly<Record<string, Recipe>> = {
  'explainer-script': explainerScript(),
  'explainer-vo': explainerVo(),
  'explainer-build': explainerBuild(),
  'explainer-qc': explainerQc(),
};
