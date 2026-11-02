import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ALL_RECIPES } from '../walk-line.js';
import { BROLL } from './broll.js';
import { CHARACTER } from './character.js';
import { explainerBuild, explainerDeliver, explainerQc, explainerScene, explainerScript, explainerVo, EXPLAINER } from './explainer.js';
// ⚠️ 정적 named import 대신 namespace import: 골이 바꾼 파일을 base 조상 위에서 그대로 돌릴 때
// (reverse verify-by-breaking) 아직 없는 export 로 인해 모듈 로드 SyntaxError 로 죽지 않게 한다.
// base 에서는 아래 `load` 가 undefined → assertion 실패(레드 목격), head 에서는 통과(그린).
import * as explainerLine from './explainer.js';
import { FILM } from './film.js';
import { FREE_LINE } from './free-line.js';
import { HYPERFRAMES } from './hyperframes.js';
import { UPSTREAM } from './upstream.js';
import { VLOG } from './vlog.js';
import type { RunResult } from './ffmpeg.js';
import { UNOBSERVED, type RecipeCtx } from './types.js';

const declaration2 = resolve(import.meta.dir, '../../../graphs/video/explainer-line.yaml');
const example = resolve(import.meta.dir, '../../../skills/explainer-video/examples/elanous-0.2.5/script.json');
const good: RunResult = { ok: true, code: 0, signal: null, err: '', out: '' };
const spawnFailed: RunResult = { ok: false, code: null, signal: null, err: 'ENOENT', out: '' };
const exampleVoKeys = ['i-0', 'c1-0', 'c1-1', 'c1-2', 'c1-3', 'c2-0', 'c2-1', 'c2-2',
  'c3-0', 'c3-1', 'c3-2', 'c4-0', 'c4-1', 'c4-2', 'c5-0', 'c5-1', 'c5-2', 'o-0', 'o-1'];
let root: string;
let script: string;
let state: Record<string, unknown>;
let events: string[];
const ctx = (): RecipeCtx => ({ workdir: join(root, 'work'), state, log: (event) => { events.push(event); } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'explainer-'));
  script = join(root, 'project', 'script.json');
  mkdirSync(dirname(script), { recursive: true });
  cpSync(example, script);
  state = { script_path: script };
  events = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('explainer-line', () => {
  test('확정 브리핑 메모 facts·sources를 production script 입력으로 저장한다', async () => {
    state = {
      briefing: { id: 'briefing-1', title: '확정 브리핑', summary: '세 가지 근거를 확인했습니다.', confirmed: true },
      facts: [
        { id: 'fact-1', title: '첫 근거', text: '첫 번째 확인된 사실입니다.', sourceId: 'source-1' },
        { id: 'fact-2', title: '둘째 근거', text: '두 번째 확인된 사실입니다.', sourceId: 'source-2' },
      ],
      sources: [
        { id: 'source-1', label: '공식 자료 A', url: 'https://example.test/a' },
        { id: 'source-2', label: '공식 자료 B', url: 'https://example.test/b' },
      ],
    };

    const result = await explainerScript()(ctx());

    expect(result.outcome).toBe('ok');
    const generatedPath = String(result.produced?.script_path);
    expect(generatedPath).toBe(join(ctx().workdir, 'script.json'));
    const generated = JSON.parse(readFileSync(generatedPath, 'utf8')) as {
      title: string; intro: { beats: { vo: string }[] }; chapters: { title: string; sub: string; beats: { vo: string }[] }[];
      outro: { beats: { vo: string }[] };
    };
    expect(generated.title).toBe('확정 브리핑');
    expect(generated.intro.beats[0]?.vo).toContain('확정 브리핑');
    expect(generated.chapters.map((chapter) => chapter.beats[0]?.vo)).toEqual([
      '첫 번째 확인된 사실입니다.', '두 번째 확인된 사실입니다.',
    ]);
    expect(generated.chapters.map((chapter) => chapter.sub)).toEqual(['출처: 공식 자료 A', '출처: 공식 자료 B']);
    expect(generated.outro.beats[0]?.vo).toBe('세 가지 근거를 확인했습니다.');
  });

  test('Telegram 설정이 없어도 기존 local-artifact delivered 경로를 보존하고 Telegram 도착을 주장하지 않는다', async () => {
    const artifact = join(ctx().workdir, 'hf-render.mp4');
    mkdirSync(ctx().workdir, { recursive: true });
    writeFileSync(artifact, 'mock video bytes');
    state.hf_render_path = artifact;

    const result = await explainerDeliver()(ctx());

    expect(result.outcome).toBe('ok');
    expect(result.produced).toEqual({ delivery_mode: 'local-artifact', local_artifact_path: artifact });
    expect(result.note).toContain('Telegram 도착은 주장하지 않는다');
  });

  test('Telegram chat_id 로 전달을 요청했는데 callback/token 이 없으면 local delivered 로 오인하지 않는다', async () => {
    const artifact = join(ctx().workdir, 'hf-render.mp4');
    mkdirSync(ctx().workdir, { recursive: true });
    writeFileSync(artifact, 'mock video bytes');
    state.hf_render_path = artifact;
    state.telegram_chat_id = 'chat-requested';

    const result = await explainerDeliver()(ctx());

    expect(result.outcome).toBe('no-recipient');
    expect(result.produced).toBeUndefined();
  });

  test('script_path 없이 workdir/script.json 이 이미 있으면 충돌로 멈추고 원본을 보존한다', async () => {
    const target = join(ctx().workdir, 'script.json');
    mkdirSync(ctx().workdir, { recursive: true });
    const original = '{"title":"existing user script"}';
    writeFileSync(target, original);
    state = {
      briefing: { id: 'briefing-1', title: 'new briefing', confirmed: true },
      facts: [{ id: 'fact-1', text: 'known fact', sourceId: 'source-1' }],
      sources: [{ id: 'source-1', label: 'source', url: 'https://example.test/source' }],
    };

    const result = await explainerScript()(ctx());

    expect(result.outcome).toBe('collision');
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  test('기존 script_path 대본은 facts/sources 가 없어도 장면 계획으로 이어진다', async () => {
    const before = JSON.parse(readFileSync(script, 'utf8')) as { chapters: unknown[] };
    state = { script_path: script };

    const result = await explainerScene()(ctx());

    expect(result.outcome).toBe('ok');
    expect(result.produced?.scene_plan).toEqual(before.chapters);
    expect(result.produced?.chart_plan).toEqual([]);
    expect(result.produced?.evidence_captions).toEqual([]);
  });

  test('facts/sources 없이 잘못된 chart_plan 이 지정되면 기존 script 경로를 조용히 성공 처리하지 않는다', async () => {
    state = { script_path: script, chart_plan: { kind: 'bar' } };

    const result = await explainerScene()(ctx());

    expect(result.outcome).toBe('no-facts');
    expect(result.note).toContain('facts 와 sources');
  });

  test('scene chart plan and evidence captions are consumed by the production build input', async () => {
    writeFileSync(script, JSON.stringify({
      title: 'Briefing', intro: { beats: [{ vo: 'Summary', cap: 'Summary' }] },
      chapters: [{ factId: 'fact-1', sourceId: 'source-1', title: 'Revenue', sub: '', diagram: 'nodes', beats: [{ vo: 'Revenue rose', cap: 'Revenue rose' }] }],
      outro: { beats: [{ vo: 'Conclusion', cap: 'Conclusion' }] },
    }));
    state = {
      ...state,
      facts: [{ id: 'fact-1', text: 'Revenue rose', sourceId: 'source-1' }],
      scene_plan: [{ factId: 'fact-1', sourceId: 'source-1', title: 'Revenue', sub: '', diagram: 'chart', beats: [{ vo: 'Revenue rose', cap: 'Revenue rose' }] }],
      chart_plan: [{ factId: 'fact-1', kind: 'bar', title: 'Quarterly revenue', points: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 14 }] }],
      evidence_captions: [{ id: 'source-1', label: 'Annual report', url: 'https://example.test/report' }],
    };
    let renderedInput: Record<string, unknown> | undefined;
    let buildInputPath = '';
    const sourceBefore = readFileSync(script, 'utf8');
    const run = (bin: string, args: readonly string[]): RunResult => {
      expect(bin).toBe('node');
      buildInputPath = String(args[1]);
      renderedInput = JSON.parse(readFileSync(buildInputPath, 'utf8')) as Record<string, unknown>;
      const project = String(args[2]);
      mkdirSync(join(project, 'hf'), { recursive: true });
      writeFileSync(join(project, 'hf/index.html'), '<html></html>');
      writeFileSync(join(project, 'timeline.json'), '{}');
      return good;
    };

    const result = await explainerBuild({ run })(ctx());

    expect(result.outcome).toBe('ok');
    const chapter = (renderedInput?.chapters as Record<string, unknown>[])[0]!;
    expect(chapter.chart).toEqual({ factId: 'fact-1', kind: 'bar', title: 'Quarterly revenue', points: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 14 }] });
    expect(chapter.sub).toContain('Annual report');
    expect((chapter.beats as { cap: string }[])[0]?.cap).toContain('Annual report');
    expect(renderedInput?.target_seconds).toBe(60);
    expect(readFileSync(script, 'utf8')).toBe(sourceBefore);
    delete state.scene_plan;
    await explainerBuild({ run })(ctx());
    const retried = JSON.parse(readFileSync(buildInputPath, 'utf8')) as { chapters: { beats: { cap: string }[] }[] };
    expect(retried.chapters[0]?.beats[0]?.cap.match(/Annual report/g)).toHaveLength(1);
    expect(readFileSync(script, 'utf8')).toBe(sourceBefore);
  });

  test('the existing video engine renders declared chart data and its evidence caption', () => {
    const cache = join(root, 'engine-cache');
    const scriptValue = {
      title: 'Briefing',
      target_seconds: 60,
      intro: { beats: [{ vo: 'Summary', cap: 'Summary' }] },
      chapters: [{ title: 'Revenue', sub: 'Source: Annual report', diagram: 'chart',
        chart: { factId: 'fact-1', kind: 'bar', title: 'Quarterly revenue', points: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 14 }] },
        beats: [{ vo: 'Revenue rose', cap: 'Revenue rose · Source: Annual report' }] }],
      outro: { beats: [{ vo: 'Conclusion', cap: 'Conclusion' }], cta: { links: ['example.test'] } },
    };
    writeFileSync(script, JSON.stringify(scriptValue));
    const voDir = join(dirname(script), 'source', 'vo');
    mkdirSync(voDir, { recursive: true });
    for (const [key, beat] of [['i-0', scriptValue.intro.beats[0]], ['c1-0', scriptValue.chapters[0].beats[0]], ['o-0', scriptValue.outro.beats[0]]] as const) {
      writeFileSync(join(voDir, `${key}.mp3`), 'mock audio');
      const characters = [...beat.vo];
      writeFileSync(join(voDir, `${key}.json`), JSON.stringify({ alignment: {
        characters,
        character_start_times_seconds: characters.map((_, i) => i * 0.05),
        character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.05),
      } }));
    }
    for (const rel of ['fonts/Pretendard-Medium.woff2', 'fonts/Pretendard-Bold.woff2', 'fonts/Pretendard-ExtraBold.woff2',
      'fonts/Pretendard-Black.woff2', 'fonts/GeistMono-Medium.woff2', 'gsap.min.js']) {
      const asset = join(cache, rel);
      mkdirSync(dirname(asset), { recursive: true });
      writeFileSync(asset, 'offline test asset');
    }

    const engine = resolve(import.meta.dir, '../../../skills/explainer-video/engine/build.mjs');
    const result = spawnSync('node', [engine, script], { encoding: 'utf8', env: { ...process.env, EXPLAINER_CACHE: cache }, timeout: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message);
    const html = readFileSync(join(dirname(script), 'hf', 'index.html'), 'utf8');
    expect(html).toContain('data-duration="60"');
    expect(html).toContain('Quarterly revenue');
    expect(html).toContain('data-chart-kind="bar"');
    expect(html).toContain('Q1');
    expect(html).toContain('Q2');
    expect(html).toContain('Source: Annual report');
    scriptValue.chapters[0].chart.kind = 'line';
    writeFileSync(script, JSON.stringify(scriptValue));
    const lineResult = spawnSync('node', [engine, script], { encoding: 'utf8', env: { ...process.env, EXPLAINER_CACHE: cache }, timeout: 30_000 });
    if (lineResult.status !== 0) throw new Error(lineResult.stderr || lineResult.stdout || lineResult.error?.message);
    const lineHtml = readFileSync(join(dirname(script), 'hf', 'index.html'), 'utf8');
    expect(lineHtml).toContain('data-chart-kind="line"');
    expect(lineHtml).toContain('<polyline');
  });

  test('가짜 러너로 script → vo → build → qc 를 차례로 걸으며 -14 pass 와 -25 loudness 를 가른다', async () => {
    const sourceBefore = readFileSync(script, 'utf8');
    const calls: { bin: string; args: readonly string[]; cwd?: string }[] = [];
    const run = (bin: string, args: readonly string[], _ms: number, cwd?: string): RunResult => {
      calls.push({ bin, args, cwd });
      if (bin === 'bun') {
        const dir = join(dirname(script), 'source/vo');
        mkdirSync(dir, { recursive: true });
        for (const key of exampleVoKeys) {
          writeFileSync(join(dir, `${key}.mp3`), 'audio');
          writeFileSync(join(dir, `${key}.json`), JSON.stringify({ alignment: { character_end_times_seconds: [0.25, 1.5] } }));
        }
      } else if (bin === 'node') {
        const project = String(args[2]);
        mkdirSync(join(project, 'hf'), { recursive: true });
        writeFileSync(join(project, 'hf/index.html'), '<html></html>');
        writeFileSync(join(project, 'timeline.json'), '{}');
      } else if (bin === 'ffmpeg') {
        return { ...good, err: `[Parsed_loudnorm_0 @ 0x1] {\n "input_i" : "${state.fixture_lufs}",\n "input_tp" : "-1.5",\n "input_lra" : "5.0"\n}` };
      } else if (bin === 'ffprobe') {
        return { ...good, out: String(state.fixture_duration ?? 60) };
      }
      return good;
    };
    const steps = [explainerScript(), explainerVo({ run }), explainerBuild({ run })];
    for (const step of steps) {
      const result = await step(ctx());
      expect(result.outcome).toBe('ok');
      Object.assign(state, result.produced);
    }
    expect(state.script_path).toBe(script);
    expect(state.vo_dir).toBe(join(dirname(script), 'source/vo'));
    expect(existsSync(String(state.vo_dir))).toBe(true);
    const s = JSON.parse(readFileSync(script, 'utf8')) as { intro: { beats: unknown[] }; chapters: { beats: unknown[] }[]; outro: { beats: unknown[] } };
    const beatCount = s.intro.beats.length + s.outro.beats.length + s.chapters.reduce((n, c) => n + c.beats.length, 0);
    expect(state.narration_seconds).toBe(beatCount * 1.5);
    expect(String(state.hyperframes_project).endsWith('/hf')).toBe(true);
    expect(state.timeline_path).toBe(join(dirname(script), 'timeline.json'));
    expect(calls[0]).toMatchObject({ bin: 'bun', args: [expect.any(String), script], cwd: dirname(script) });
    expect(calls[1]?.bin).toBe('node');
    expect(String(calls[1]?.args[1]).startsWith(join(ctx().workdir, '.explainer-build-'))).toBe(true);
    expect(calls[1]?.args[2]).toBe(dirname(script));
    expect(readFileSync(script, 'utf8')).toBe(sourceBefore);
    state.hf_render_path = join(root, 'work', 'hf-render.mp4');
    mkdirSync(ctx().workdir, { recursive: true });
    writeFileSync(String(state.hf_render_path), 'video');
    state.fixture_lufs = -14;
    state.fixture_duration = 60;
    const qc = explainerQc({ run });
    const pass = await qc(ctx());
    expect(pass.outcome).toBe('pass');
    expect(pass.produced).toEqual({ loudness_lufs: -14, true_peak_db: -1.5, measured_duration_seconds: 60 });
    state.fixture_duration = 12;
    expect((await qc(ctx())).outcome).toBe('too-short');
    state.fixture_duration = 60;
    state.fixture_lufs = -25;
    expect((await qc(ctx())).outcome).toBe('loudness');
    expect(calls.some((c) => c.args.includes('loudnorm=print_format=json'))).toBe(true);
    expect(calls.at(-1)?.bin).toBe('ffmpeg');
    expect(events).toEqual(['explainer.script', 'explainer.vo', 'explainer.build', 'explainer.qc', 'explainer.qc', 'explainer.qc']);
  });

  test('예제 대본을 실제 vo.ts 로 실행한 파일명·정렬 JSON 에서 narration_seconds 를 잰다', async () => {
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    const executables = {
      say: '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; printf audio > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n',
      ffmpeg: '#!/bin/sh\nfor arg do output="$arg"; done\nprintf audio > "$output"\n',
      ffprobe: '#!/bin/sh\nprintf "2.25\\n"\n',
    };
    for (const [name, source] of Object.entries(executables)) {
      const file = join(binDir, name);
      writeFileSync(file, source);
      chmodSync(file, 0o755);
    }
    const engine = resolve(import.meta.dir, '../../../skills/explainer-video/engine/vo.ts');
    const run = (bin: string, args: readonly string[], timeoutMs: number, cwd?: string): RunResult => {
      expect(bin).toBe('bun');
      expect(args).toEqual([engine, script]);
      const r = spawnSync(bin, [...args], {
        cwd, timeout: timeoutMs, encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, ELEVENLABS_API_KEY: '', EXPLAINER_SAY_VOICE: 'TestVoice' },
      });
      return { ok: r.status === 0, code: r.status, signal: r.signal, err: r.stderr || r.error?.message || '', out: r.stdout || '' };
    };
    const result = await explainerVo({ run })(ctx());
    expect(result.outcome).toBe('ok');
    const dir = join(dirname(script), 'source/vo');
    expect(result.produced).toEqual({ vo_dir: dir, narration_seconds: 19 * 2.25 });
    expect(readdirSync(dir).sort()).toEqual(exampleVoKeys.flatMap((key) => [`${key}.json`, `${key}.mp3`]).sort());
    const scriptJson = JSON.parse(readFileSync(script, 'utf8')) as { intro: { beats: { vo: string }[] }; chapters: { beats: { vo: string }[] }[]; outro: { beats: { vo: string }[] } };
    const voiced = [scriptJson.intro.beats[0]!, ...scriptJson.chapters.flatMap((c) => c.beats), ...scriptJson.outro.beats];
    for (const [index, key] of exampleVoKeys.entries()) {
      const j = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as {
        engine: string; hash: string; vo: string;
        alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
      };
      expect(j.engine).toBe('say');
      expect(j.hash).toMatch(/^[a-f0-9]{16}$/);
      expect(j.vo).toBe(voiced[index]!.vo);
      expect(j.alignment.characters.join('')).toBe(j.vo);
      expect(j.alignment.character_end_times_seconds).toHaveLength(j.alignment.characters.length);
      expect(j.alignment.character_end_times_seconds.at(-1)).toBe(2.25);
      expect(j.alignment.character_end_times_seconds.every((end, i) => end >= j.alignment.character_start_times_seconds[i]! && (i === 0 || end >= j.alignment.character_end_times_seconds[i - 1]!))).toBe(true);
      expect(existsSync(join(dir, `${key}.mp3`))).toBe(true);
    }
  });

  test('chapters 가 0 이거나 대본/입력 경로가 없으면 no-facts, 읽기 실패는 UNOBSERVED', async () => {
    const s = JSON.parse(readFileSync(script, 'utf8')) as Record<string, unknown>;
    writeFileSync(script, JSON.stringify({ ...s, chapters: [] }));
    expect((await explainerScript()(ctx())).outcome).toBe('no-facts');
    rmSync(script);
    expect((await explainerScript()(ctx())).outcome).toBe('no-facts');
    state.script_path = undefined;
    expect((await explainerScript()(ctx())).outcome).toBe('no-facts');
    state.script_path = script;
    mkdirSync(script);
    expect((await explainerScript()(ctx())).outcome).toBe(UNOBSERVED);
  });

  test('빈 비트뿐인 chapter 는 첫 노드에서 no-facts, 내용 있는 비트는 ok', async () => {
    const s = JSON.parse(readFileSync(script, 'utf8')) as {
      intro: { beats: { vo: string }[] }; chapters: { beats: { vo: string }[] }[]; outro: { beats: { vo: string }[] };
    };
    for (const chapter of s.chapters) chapter.beats = [];
    writeFileSync(script, JSON.stringify(s));
    expect((await explainerScript()(ctx())).outcome).toBe('no-facts');
    s.intro.beats = [];
    s.outro.beats = [];
    writeFileSync(script, JSON.stringify(s));
    expect((await explainerScript()(ctx())).outcome).toBe('no-facts');
    s.chapters[0]!.beats = [{ vo: '   ' }];
    writeFileSync(script, JSON.stringify(s));
    expect((await explainerScript()(ctx())).outcome).toBe('no-facts');
    s.chapters[0]!.beats = [{ vo: '사실을 설명합니다.' }];
    writeFileSync(script, JSON.stringify(s));
    expect((await explainerScript()(ctx())).outcome).toBe('ok');
  });

  test('엔진 부재와 spawn 실패는 UNOBSERVED · 정상 비정상 종료는 error/bad-script', async () => {
    const missing = join(root, 'missing-engine');
    expect((await explainerVo({ engineDir: missing })(ctx())).outcome).toBe(UNOBSERVED);
    expect((await explainerBuild({ engineDir: missing })(ctx())).note).toContain('build.mjs');
    expect((await explainerVo({ run: () => spawnFailed })(ctx())).outcome).toBe(UNOBSERVED);
    expect((await explainerBuild({ run: () => spawnFailed })(ctx())).outcome).toBe(UNOBSERVED);
    const failure = (err: string): RunResult => ({ ok: false, code: 1, signal: null, err, out: '' });
    expect((await explainerVo({ run: () => failure('say unavailable') })(ctx())).outcome).toBe('error');
    expect((await explainerVo({ run: () => ({ ok: false, code: null, signal: 'SIGTERM', err: 'terminated', out: '' }) })(ctx())).outcome).toBe('error');
    expect((await explainerBuild({ run: () => failure('unknown diagram: test') })(ctx())).outcome).toBe('bad-script');
    expect((await explainerBuild({ run: () => failure('TypeError: DIAGRAMS[dia] is not a function') })(ctx())).outcome).toBe('bad-script');
    expect((await explainerBuild({ run: () => failure('asset HTTP 503') })(ctx())).outcome).toBe('error');
  });

  test('대본 폴더 밖으로 이어지는 VO 경로와 빌드 경로의 symlink 는 엔진 호출 전에 거부한다', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(dirname(script), 'source'));
    let called = 0;
    const run = (): RunResult => { called++; return good; };
    expect((await explainerVo({ run })(ctx())).outcome).toBe(UNOBSERVED);
    rmSync(join(dirname(script), 'source'));
    symlinkSync(outside, join(dirname(script), 'hf'));
    expect((await explainerBuild({ run })(ctx())).outcome).toBe(UNOBSERVED);
    expect(called).toBe(0);
  });

  test('끊어진 symlink 가 대본 폴더 밖을 가리키면 VO 엔진 호출 전에 거부한다', async () => {
    const outside = join(root, 'outside-broken');
    mkdirSync(outside);
    mkdirSync(join(dirname(script), 'source'), { recursive: true });
    symlinkSync(join(outside, 'not-yet'), join(dirname(script), 'source', 'vo'));
    let called = 0;
    const run = (): RunResult => { called++; return good; };
    expect((await explainerVo({ run })(ctx())).outcome).toBe(UNOBSERVED);
    expect(called).toBe(0);
  });

  test('비어 있지 않은 대본의 VO 정렬 끝 시각이 0이면 길이를 측정하지 못한 것이다', async () => {
    const run = (): RunResult => {
      const dir = join(dirname(script), 'source/vo');
      mkdirSync(dir, { recursive: true });
      for (const key of exampleVoKeys) {
        writeFileSync(join(dir, `${key}.mp3`), 'audio');
        writeFileSync(join(dir, `${key}.json`), JSON.stringify({ alignment: { character_end_times_seconds: [0] } }));
      }
      return good;
    };
    const result = await explainerVo({ run })(ctx());
    expect(result.outcome).toBe(UNOBSERVED);
    expect(result.produced).toBeUndefined();
    expect(result.note).toContain('끝 시각');
  });

  test('VO/빌드의 성공 종료만으로 누락 산출을 통과시키지 않는다', async () => {
    expect((await explainerVo({ run: () => good })(ctx())).outcome).toBe(UNOBSERVED);
    expect((await explainerBuild({ run: () => good })(ctx())).outcome).toBe(UNOBSERVED);
  });

  test('qc: ffmpeg spawn 실패/측정 실패/JSON 누락은 통과가 아니고 peak 초과는 loudness', async () => {
    state.hf_render_path = join(root, 'render.mp4');
    writeFileSync(String(state.hf_render_path), 'video');
    expect((await explainerQc({ run: () => spawnFailed })(ctx())).outcome).toBe(UNOBSERVED);
    expect((await explainerQc({ run: () => ({ ...good, ok: false, code: 1 }) })(ctx())).outcome).toBe(UNOBSERVED);
    expect((await explainerQc({ run: () => good })(ctx())).outcome).toBe(UNOBSERVED);
    const loud = (peak: string) => ({ ...good, err: `{"input_i":"-14","input_tp":"${peak}"}` });
    expect((await explainerQc({ run: () => loud('-0.5') })(ctx())).outcome).toBe('loudness');
    expect((await explainerQc({ run: (bin) => bin === 'ffprobe' ? { ...good, out: '60' } : loud('-1') })(ctx())).outcome).toBe('pass');
    expect((await explainerQc({ run: () => loud('NaN') })(ctx())).outcome).toBe(UNOBSERVED);
  });

  test('qc: 60초 목표(target_seconds 60)를 넘는 내레이션은 too-long(재구성)으로, 이내면 pass 로 간다', async () => {
    state.hf_render_path = join(root, 'render.mp4');
    writeFileSync(String(state.hf_render_path), 'video');
    const loud = (peak: string) => ({ ...good, err: `{"input_i":"-14","input_tp":"${peak}"}` });
    const measured = (peak: string) => (bin: string) => bin === 'ffprobe' ? { ...good, out: '60' } : loud(peak);
    state.narration_seconds = 200;
    const tooLong = await explainerQc({ run: measured('-1.5') })(ctx());
    expect(tooLong.outcome).toBe('too-long');
    expect(tooLong.produced).toEqual({ loudness_lufs: -14, true_peak_db: -1.5, measured_duration_seconds: 60 });
    expect(tooLong.note).toContain('60');
    state.narration_seconds = 50;
    expect((await explainerQc({ run: measured('-1.5') })(ctx())).outcome).toBe('pass');
    // 선언 파일을 60→180초로 바꿔도 생산 로드가 새 목표를 소비한다.
    const alt = join(root, 'alt-line.yaml');
    writeFileSync(alt, readFileSync(declaration2, 'utf8').replace('target_seconds: 60', 'target_seconds: 180'));
    state.narration_seconds = 50;
    const alternateTarget = await explainerQc({ run: measured('-1.5'), declarationPath: alt })(ctx());
    expect(alternateTarget.outcome).toBe('too-short');
    expect(alternateTarget.note).toContain('180');
    // narration_seconds 를 못 쟀으면(계약 밖) 길이 판정을 건너뛴다 — 기존 동작 보존.
    delete state.narration_seconds;
    expect((await explainerQc({ run: measured('-1.5') })(ctx())).outcome).toBe('pass');
  });

  test('ALL_RECIPES 는 네 키를 등록하고 기존 hyperframes-render 와 그 외 키를 보존한다', () => {
    expect(Object.keys(EXPLAINER).sort()).toEqual(['explainer-build', 'explainer-deliver', 'explainer-qc', 'explainer-scene', 'explainer-script', 'explainer-vo']);
    for (const [key, value] of Object.entries(EXPLAINER)) expect(ALL_RECIPES[key]).toBe(value);
    const existing = { ...UPSTREAM, ...FREE_LINE, ...VLOG, ...FILM, ...CHARACTER, ...HYPERFRAMES, ...BROLL };
    expect(Object.keys(EXPLAINER).filter((key) => key in existing)).toEqual([]);
    for (const [key, value] of Object.entries(existing)) expect(ALL_RECIPES[key]).toBe(value);
    expect(ALL_RECIPES['hyperframes-render']).toBe(HYPERFRAMES['hyperframes-render']);
  });
});

describe('explainer-line 계획(선언 로드·컴파일)', () => {
  const declaration = resolve(import.meta.dir, '../../../graphs/video/explainer-line.yaml');

  test('완료 경계가 3개 모두 유지된다: 코드 — graphs/video/explainer-line.yaml에 요청 동작(60초 영상) 구현 + 대상 밖 기본 동작 보존, 실물 — 격리 시험에서 생산 경로를 지나 요청 동작과 기존 동작을 함께 관측, 증거 — bun test', () => {
    // namespace 로 꺼낸 뒤 assertion 으로 붉게 목격한다 — base 조상에는 아직 이 export 가 없으므로
    // 정적 named import 대신 이 경로로 가져온다(base 에서는 이 줄이 깔끔한 실패 = 레드 목격).
    const load = (explainerLine as unknown as Record<string, unknown>).loadExplainerLine as
      | typeof explainerLine.loadExplainerLine
      | undefined;
    expect(typeof load).toBe('function');
    const plan = load!(declaration);
    expect(plan.errors).toEqual([]);
    // (a) 요청 동작 — 60초 브리핑 영상: 생산 로드가 이 선언에서 읽은 목표 총 길이는 60초다.
    expect(plan.targetSeconds).toBe(60);
    // 배선 — 뿌리 인자 없는 생산 기본 호출도 같은 저작본을 읽는다(loadExplainerLine → 이 선언 파일).
    expect(load!().targetSeconds).toBe(60);
    // (b) 기존 동작 보존 — 컴파일된 나머지 선언(노드·계약·엣지)과 레시피 기본 출력은 변경 전과 같다.
    const t = plan.template!;
    expect(t).toMatchObject({ graphId: 'explainer-line', version: 1, entryNode: 'script' });
    expect(t.terminalNodes).toEqual(['delivered', 'needs-human', 'blocked', 'unobserved']);
    expect(t.nodes.map((node) => [node.nodeId, node.kind, node.recipe, node.maxVisits, node.contract])).toEqual([
      ['script', 'agent', 'explainer-script', 3, { inputs: ['briefing', 'facts', 'sources'], tools: 'workspace-write', outputs: ['script_path'] }],
      ['scene', 'agent', 'explainer-scene', 2, { inputs: ['script_path', 'facts', 'sources', 'chart_plan'], tools: 'workspace-write', outputs: ['scene_plan', 'chart_plan', 'evidence_captions'] }],
      ['vo', 'agent', 'explainer-vo', 2, { inputs: ['script_path'], tools: 'network-write', outputs: ['vo_dir', 'narration_seconds'] }],
      ['build', 'agent', 'explainer-build', 3, { inputs: ['script_path', 'vo_dir', 'scene_plan', 'chart_plan', 'evidence_captions'], tools: 'workspace-write', outputs: ['hyperframes_project', 'timeline_path'] }],
      ['render', 'gate', 'hyperframes-render', 2, { inputs: ['hyperframes_project'], tools: 'workspace-write', outputs: ['hf_render_path', 'hf_snapshot_dir', 'hf_check'] }],
      ['qc', 'gate', 'explainer-qc', 2, { inputs: ['hf_render_path', 'script_path'], tools: 'read-and-run', outputs: ['vo_match', 'loudness_lufs', 'true_peak_db'] }],
      ['deliver', 'agent', 'explainer-deliver', 1, { inputs: ['hf_render_path', 'briefing'], tools: 'network-write', outputs: ['delivery_mode', 'local_artifact_path', 'telegram_message_id'] }],
      ['delivered', 'judge', 'terminal-delivered', 1, undefined],
      ['needs-human', 'judge', 'terminal-needs-human', 1, undefined],
      ['blocked', 'judge', 'terminal-blocked', 1, undefined],
      ['unobserved', 'judge', 'terminal-unobserved', 1, undefined],
    ]);
    expect(t.edges.map((edge) => [edge.from, edge.on, edge.map])).toEqual([
      ['script', 'outcome', { ok: 'scene', 'no-facts': 'needs-human', collision: 'needs-human', unmeasurable: 'unobserved' }],
      ['scene', 'outcome', { ok: 'vo', 'no-facts': 'needs-human', unmeasurable: 'unobserved' }],
      ['vo', 'outcome', { ok: 'build', 'no-key': 'needs-human', error: 'blocked', unmeasurable: 'unobserved' }],
      ['build', 'outcome', { ok: 'render', 'bad-script': 'script', error: 'blocked', unmeasurable: 'unobserved' }],
      ['render', 'outcome', { ok: 'qc', 'check-fail': 'build', 'render-mismatch': 'build', unmeasurable: 'unobserved' }],
      ['qc', 'outcome', { pass: 'deliver', 'vo-mismatch': 'vo', loudness: 'build', 'too-short': 'build', 'too-long': 'build', public: 'needs-human', unmeasurable: 'unobserved' }],
      ['deliver', 'outcome', { ok: 'delivered', 'no-recipient': 'needs-human', error: 'blocked', unmeasurable: 'unobserved' }],
    ]);
    expect(Object.keys(EXPLAINER).sort()).toEqual(['explainer-build', 'explainer-deliver', 'explainer-qc', 'explainer-scene', 'explainer-script', 'explainer-vo']);
  });
});
