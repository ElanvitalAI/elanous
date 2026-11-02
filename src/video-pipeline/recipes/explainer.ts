import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RunResult } from './ffmpeg.js';
import { UNOBSERVED, type Recipe, type RecipeCtx, type RecipeResult } from './types.js';
import { parseGraphTemplateYaml, type GraphParseIssue, type GraphTemplateSpec } from '../../self-implement/graph-yaml.js';

type CommandRunner = (bin: string, args: readonly string[], timeoutMs: number, cwd?: string) => RunResult;
interface ExplainerDeps { readonly run?: CommandRunner; readonly engineDir?: string; readonly declarationPath?: string }

const ENGINE = resolve(import.meta.dir, '../../../skills/explainer-video/engine');
const LINE_DECLARATION = resolve(import.meta.dir, '../../../graphs/video/explainer-line.yaml');
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

type ExplainerChart = { factId: string; kind: 'bar' | 'line'; title: string; points: { label: string; value: number }[] };

function chartsFrom(value: unknown, facts: readonly unknown[]): ExplainerChart[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const factIds = new Set(facts.flatMap((fact) => fact && typeof fact === 'object' &&
    typeof (fact as { id?: unknown }).id === 'string' ? [(fact as { id: string }).id] : []));
  const charts: ExplainerChart[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as { factId?: unknown; kind?: unknown; title?: unknown; points?: unknown };
    if (typeof row.factId !== 'string' || !factIds.has(row.factId) || seen.has(row.factId) ||
        (row.kind !== 'bar' && row.kind !== 'line') || typeof row.title !== 'string' || !row.title.trim() ||
        !Array.isArray(row.points) || row.points.length < 2 || row.points.length > 8) return null;
    const points: ExplainerChart['points'] = [];
    for (const point of row.points) {
      if (!point || typeof point !== 'object') return null;
      const p = point as { label?: unknown; value?: unknown };
      if (typeof p.label !== 'string' || !p.label.trim() || typeof p.value !== 'number' || !Number.isFinite(p.value)) return null;
      points.push({ label: p.label.trim(), value: p.value });
    }
    seen.add(row.factId);
    charts.push({ factId: row.factId, kind: row.kind, title: row.title.trim(), points });
  }
  return charts;
}

function sourceCaptions(value: unknown): Map<string, { label: string; url: string }> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { id?: unknown; label?: unknown; url?: unknown };
    return typeof row.id === 'string' && typeof row.label === 'string' && typeof row.url === 'string'
      ? [[row.id, { label: row.label, url: row.url }] as const] : [];
  }));
}

export function explainerScript(): Recipe {
  return async (ctx) => {
    let path = scriptPath(ctx);
    if (!path) {
      try { mkdirSync(ctx.workdir, { recursive: true }); }
      catch (error) { return finish(ctx, 'script', { outcome: UNOBSERVED, note: `대본 작업 디렉터리를 만들지 못했다: ${String(error)}` }); }
      path = resolve(ctx.workdir, 'script.json');
      if (!safeOutput(ctx.workdir, path)) return finish(ctx, 'script', { outcome: UNOBSERVED, note: '생성 대본 경로가 workdir 밖을 가리킨다' });
      if (existsSync(path)) return finish(ctx, 'script', { outcome: 'collision', note: `기존 대본을 덮어쓰지 않았다: ${path} — script_path 로 지정하거나 파일을 옮겨라` });
      const briefing = ctx.state.briefing;
      const facts = ctx.state.facts;
      const sources = ctx.state.sources;
      if (!briefing || typeof briefing !== 'object' ||
          (briefing as { confirmed?: unknown }).confirmed !== true ||
          !Array.isArray(facts) || facts.length === 0 ||
          !Array.isArray(sources) || sources.length === 0) {
        return finish(ctx, 'script', { outcome: 'no-facts', note: '확정 브리핑·사실·출처가 없고 script_path 도 없다' });
      }
      const sourceById = new Map(sources.flatMap((source) => {
        if (!source || typeof source !== 'object') return [];
        const row = source as { id?: unknown; label?: unknown; url?: unknown };
        return typeof row.id === 'string' && typeof row.label === 'string' && typeof row.url === 'string'
          ? [[row.id, { label: row.label, url: row.url }] as const] : [];
      }));
      const preparedFacts = facts.flatMap((fact, index) => {
        if (!fact || typeof fact !== 'object') return [];
        const row = fact as { id?: unknown; title?: unknown; text?: unknown; sourceId?: unknown };
        const source = typeof row.sourceId === 'string' ? sourceById.get(row.sourceId) : undefined;
        if (typeof row.text !== 'string' || !row.text.trim() || !source) return [];
        return [{ factId: typeof row.id === 'string' ? row.id : undefined,
          sourceId: typeof row.sourceId === 'string' ? row.sourceId : undefined,
          title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : `근거 ${index + 1}`,
          text: row.text.trim(), source }];
      });
      if (preparedFacts.length !== facts.length) {
        return finish(ctx, 'script', { outcome: 'no-facts', note: '각 사실에 읽을 수 있는 문장과 출처 id·label·url 연결이 필요하다' });
      }
      const memo = briefing as { title?: unknown; summary?: unknown };
      const title = typeof memo.title === 'string' && memo.title.trim() ? memo.title.trim() : '확정 브리핑';
      const summary = typeof memo.summary === 'string' && memo.summary.trim() ? memo.summary.trim() : `${title}의 확인된 근거를 정리합니다.`;
      const generated = {
        title,
        intro: { beats: [{ vo: `${title}. 확인된 근거 ${preparedFacts.length}가지를 정리합니다.`, cap: `${title}: ${preparedFacts.length}가지 확인된 근거` }] },
        chapters: preparedFacts.map((fact) => ({
          factId: fact.factId,
          sourceId: fact.sourceId,
          title: fact.title,
          sub: `출처: ${fact.source.label}`,
          diagram: 'nodes',
          beats: [{ vo: fact.text, cap: fact.text }],
        })),
        outro: { beats: [{ vo: summary, cap: summary }] },
      };
      try {
        writeFileSync(path, JSON.stringify(generated, null, 2));
      } catch (e) { return finish(ctx, 'script', { outcome: UNOBSERVED, note: `확정 브리핑 대본을 저장하지 못했다: ${String(e)}` }); }
    }
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
    let buildInputPath = '';
    try {
      mkdirSync(ctx.workdir, { recursive: true });
      buildInputPath = resolve(mkdtempSync(join(ctx.workdir, '.explainer-build-')), 'script.json');
      if (![hf, resolve(hf, 'assets'), resolve(hf, 'assets/fonts'), resolve(hf, 'assets/vo'), timeline].every((p) => safeOutput(project, p))
        || !safeOutput(ctx.workdir, resolve(ctx.workdir, 'explainer-cache'))
        || !safeOutput(ctx.workdir, buildInputPath)) {
        return finish(ctx, 'build', { outcome: UNOBSERVED, note: '빌드 출력/캐시가 허용된 폴더 밖을 가리킨다' });
      }
    } catch (e) { return finish(ctx, 'build', { outcome: UNOBSERVED, note: `빌드 경로 확인 실패: ${String(e)}` }); }
    try {
      const script = JSON.parse(readFileSync(path, 'utf8')) as { chapters?: unknown };
      if (!Array.isArray(script.chapters)) throw new Error('chapters 배열이 없다');
      const scenePlan = ctx.state.scene_plan;
      const facts = Array.isArray(ctx.state.facts) ? ctx.state.facts : [];
      const chartPlan = chartsFrom(ctx.state.chart_plan, facts);
      if (chartPlan === null) return finish(ctx, 'build', { outcome: 'bad-script', note: 'chart_plan 은 사실 id에 연결된 2~8개 점의 bar/line 차트여야 한다' });
      const charts = new Map(chartPlan.map((chart) => [chart.factId, chart]));
      const captions = sourceCaptions(ctx.state.evidence_captions);
      const scenes = Array.isArray(scenePlan) && scenePlan.length === script.chapters.length ? scenePlan : script.chapters;
      const chapters = script.chapters.map((base, index) => {
        const original = base && typeof base === 'object' ? base as Record<string, unknown> : {};
        const scene = scenes[index] && typeof scenes[index] === 'object' ? scenes[index] as Record<string, unknown> : original;
        const factId = typeof scene.factId === 'string' ? scene.factId : typeof original.factId === 'string' ? original.factId : '';
        const sourceId = typeof scene.sourceId === 'string' ? scene.sourceId : typeof original.sourceId === 'string' ? original.sourceId : '';
        const chart = charts.get(factId);
        const source = captions.get(sourceId);
        const rawBeats = Array.isArray(scene.beats) ? scene.beats : original.beats;
        const beats = Array.isArray(rawBeats) ? rawBeats.map((beat) => {
          if (!source || !beat || typeof beat !== 'object') return beat;
          const row = beat as Record<string, unknown>;
          const citation = ` · Source: ${source.label}`;
          return typeof row.cap === 'string' && !row.cap.includes(citation) ? { ...row, cap: `${row.cap}${citation}` } : beat;
        }) : rawBeats;
        return {
          ...original,
          ...scene,
          diagram: chart ? 'chart' : scene.diagram === 'chart' ? 'nodes' : scene.diagram,
          ...(chart ? { chart } : {}),
          ...(source ? { sub: `출처: ${source.label}`, sourceUrl: source.url } : {}),
          ...(beats === undefined ? {} : { beats }),
        };
      });
      const targetSeconds = loadExplainerLine(deps.declarationPath).targetSeconds;
      writeFileSync(buildInputPath, JSON.stringify({
        ...script,
        chapters,
        ...(targetSeconds === null ? {} : { target_seconds: targetSeconds }),
      }, null, 2));
    } catch (e) { return finish(ctx, 'build', { outcome: 'bad-script', note: `장면·차트·근거 자막을 대본에 연결하지 못했다: ${String(e)}` }); }
    let r: RunResult;
    try { r = runner(deps, ctx)('node', [engine, buildInputPath, project], ENGINE_MS, project); }
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
      const produced: Record<string, number> = { loudness_lufs: loudness, true_peak_db: peak };
      let outcome = loudness >= -16 && loudness <= -12 && peak <= -1 ? 'pass' : 'loudness';
      const plan = loadExplainerLine(deps.declarationPath);
      if (outcome === 'pass' && plan.targetSeconds !== null) {
        let probe: RunResult;
        try {
          probe = runner(deps, ctx)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', resolve(path)], QC_MS, ctx.workdir);
        } catch (e) { return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `ffprobe 길이 측정을 못 불렀다: ${String(e)}` }); }
        if (!probe.ok || unavailable(probe)) {
          return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `ffprobe 길이 측정 실패(code=${probe.code} signal=${probe.signal}): ${probe.err.slice(0, 240)}` });
        }
        let duration = Number(probe.out.trim());
        if (!Number.isFinite(duration)) {
          try {
            const parsed = JSON.parse(probe.out) as { format?: { duration?: unknown } };
            duration = Number(parsed.format?.duration);
          } catch { /* parsed below as an unmeasurable duration */ }
        }
        if (!Number.isFinite(duration) || duration <= 0) {
          return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `ffprobe 길이를 읽지 못했다: ${probe.out.slice(0, 120)}` });
        }
        produced.measured_duration_seconds = duration;
        if (duration < plan.targetSeconds - 0.1) {
          return finish(ctx, 'qc', { outcome: 'too-short', produced,
            note: `실측 영상 ${duration.toFixed(3)}초가 선언 목표 ${plan.targetSeconds}초보다 짧다 — build 로 재구성한다` });
        }
        if (duration > plan.targetSeconds + 0.1) {
          return finish(ctx, 'qc', { outcome: 'too-long', produced,
            note: `실측 영상 ${duration.toFixed(3)}초가 선언 목표 ${plan.targetSeconds}초를 넘는다 — build 로 재구성한다` });
        }
      }
      // ⭐ 브리핑 길이 — qc 생산 경로에서 loadExplainerLine 으로 선언의 target_seconds 를 소비한다.
      // 내레이션이 목표 총 길이를 넘으면 too-long → build(재구성). narration_seconds 를 못 쟀으면 건너뛴다(기존 동작 보존).
      const narrationSeconds = ctx.state.narration_seconds;
      if (outcome === 'pass' && typeof narrationSeconds === 'number' && Number.isFinite(narrationSeconds)) {
        if (plan.targetSeconds !== null && narrationSeconds > plan.targetSeconds) {
          return finish(ctx, 'qc', {
            outcome: 'too-long', produced,
            note: `${Math.round(narrationSeconds)}초 내레이션이 선언 목표 ${plan.targetSeconds}초를 넘는다 — build 로 재구성한다`,
          });
        }
      }
      return finish(ctx, 'qc', { outcome, produced, note: `${loudness} LUFS · ${peak} dBTP` });
    } catch (e) { return finish(ctx, 'qc', { outcome: UNOBSERVED, note: `loudnorm 결과를 못 읽었다: ${String(e)}` }); }
  };
}

export function explainerScene(): Recipe {
  return async (ctx) => {
    const path = scriptPath(ctx);
    if (!path || !existsSync(path)) return finish(ctx, 'scene', { outcome: UNOBSERVED, note: 'script_path 를 못 읽는다' });
    try {
      const script = JSON.parse(readFileSync(path, 'utf8')) as { chapters?: unknown[] };
      const facts = ctx.state.facts;
      const sources = ctx.state.sources;
      if (!script.chapters?.length) {
        return finish(ctx, 'scene', { outcome: 'no-facts', note: '장면 챕터가 없다' });
      }
      if (!Array.isArray(facts) || facts.length === 0 || !Array.isArray(sources) || sources.length === 0) {
        const hasChartPlan = Object.prototype.hasOwnProperty.call(ctx.state, 'chart_plan');
        if (hasChartPlan && (!Array.isArray(ctx.state.chart_plan) || ctx.state.chart_plan.length > 0)) {
          return finish(ctx, 'scene', { outcome: 'no-facts', note: 'chart_plan 을 연결하려면 facts 와 sources 가 필요하다' });
        }
        return finish(ctx, 'scene', { outcome: 'ok', produced: {
          scene_plan: script.chapters,
          chart_plan: [],
          evidence_captions: [],
        }, note: '기존 script_path 대본을 보존해 장면 계획에 사용했다; 근거 연결 차트는 생략했다' });
      }
      const chartPlan = chartsFrom(ctx.state.chart_plan, facts);
      if (chartPlan === null) return finish(ctx, 'scene', { outcome: 'no-facts', note: 'chart_plan 은 사실 id에 연결된 2~8개 점의 bar/line 차트여야 한다' });
      const charts = new Map(chartPlan.map((chart) => [chart.factId, chart]));
      const scenePlan = script.chapters.map((chapter) => {
        const row = chapter && typeof chapter === 'object' ? chapter as Record<string, unknown> : {};
        const chart = typeof row.factId === 'string' ? charts.get(row.factId) : undefined;
        return { ...row, ...(chart ? { chart, diagram: 'chart' } : {}) };
      });
      return finish(ctx, 'scene', { outcome: 'ok', produced: {
        scene_plan: scenePlan,
        chart_plan: chartPlan,
        evidence_captions: sources,
      } });
    } catch (error) { return finish(ctx, 'scene', { outcome: UNOBSERVED, note: `장면 계획을 읽지 못했다: ${String(error)}` }); }
  };
}

export function explainerDeliver(): Recipe {
  return async (ctx) => {
    const video = ctx.state.hf_render_path;
    const send = ctx.state.sendTelegramVideo;
    if (typeof video !== 'string' || !existsSync(video)) return finish(ctx, 'deliver', { outcome: UNOBSERVED, note: '렌더 영상 파일이 없다' });
    if (typeof send !== 'function') {
      const chatId = ctx.state.telegram_chat_id;
      if ((typeof chatId === 'string' && chatId.trim().length > 0) || (typeof chatId === 'number' && Number.isFinite(chatId))) {
        return finish(ctx, 'deliver', { outcome: 'no-recipient', note: 'Telegram chat_id 가 지정됐지만 전달 callback이 없다; token·전달 설정을 확인하라' });
      }
      return finish(ctx, 'deliver', {
        outcome: 'ok', produced: { delivery_mode: 'local-artifact', local_artifact_path: video },
        note: '텔레그램 전달 요청이 없어 로컬 산출물만 보존했다; Telegram 도착은 주장하지 않는다',
      });
    }
    try {
      const messageId = await (send as (file: string, briefing: unknown) => Promise<string | number | null>)(video, ctx.state.briefing);
      if (messageId === null) return finish(ctx, 'deliver', { outcome: 'error', note: '텔레그램이 영상 전달을 확인하지 않았다' });
      return finish(ctx, 'deliver', { outcome: 'ok', produced: { delivery_mode: 'telegram', telegram_message_id: messageId } });
    } catch (error) { return finish(ctx, 'deliver', { outcome: 'error', note: `텔레그램 전달 실패: ${String(error)}` }); }
  };
}

export const EXPLAINER: Readonly<Record<string, Recipe>> = {
  'explainer-script': explainerScript(),
  'explainer-scene': explainerScene(),
  'explainer-deliver': explainerDeliver(),
  'explainer-vo': explainerVo(),
  'explainer-build': explainerBuild(),
  'explainer-qc': explainerQc(),
};

/** ⭐ explainer-line 선언이 이 라인의 영상 계획에 건 목표 총 길이(초). */
export interface ExplainerLinePlan {
  /** 지속 필드 `target_seconds`(초). 선언에 없으면 이 라인은 목표 총 길이를 정하지 않았다(null). */
  readonly targetSeconds: number | null;
  /** 생산 컴파일러(parseGraphTemplateYaml)가 낸 정규형 — 나머지 선언(노드·계약·엣지)은 이것으로 관측한다. */
  readonly template: GraphTemplateSpec | null;
  readonly errors: readonly GraphParseIssue[];
}

/** ⭐ 생산 로드 — 라인 저작본(graphs/video/explainer-line.yaml)을 읽어 영상 계획을 낸다.
 *  컴파일러는 top-level 계획 상수를 정규형에 싣지 않는다 — 지속 필드 `target_seconds` 는 로드에서 직접 읽는다.
 *  ⛔ 던지지 않는다(graph-yaml 계약) · 뿌리는 인자로 덮는다(ENGINE 과 같은 관습). */
export function loadExplainerLine(declarationPath = LINE_DECLARATION): ExplainerLinePlan {
  let source: string;
  try {
    source = readFileSync(declarationPath, 'utf8');
  } catch (error) {
    return {
      targetSeconds: null,
      template: null,
      errors: [{ path: declarationPath, message: `선언 읽기 실패: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const compiled = parseGraphTemplateYaml(source, 'explainer-line.yaml');
  let targetSeconds: number | null = null;
  try {
    const raw: unknown = parseYaml(source);
    const declared = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).target_seconds
      : undefined;
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) targetSeconds = declared;
  } catch {
    // YAML 파싱 실패는 컴파일 결과(errors)가 이미 싣는다 — 로드는 던지지 않는다.
  }
  return { targetSeconds, template: compiled.template ?? null, errors: compiled.errors };
}
