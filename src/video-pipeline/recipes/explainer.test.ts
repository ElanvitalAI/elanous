import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ALL_RECIPES } from '../walk-line.js';
import { BROLL } from './broll.js';
import { CHARACTER } from './character.js';
import { explainerBuild, explainerQc, explainerScript, explainerVo, EXPLAINER } from './explainer.js';
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
  test('가짜 러너로 script → vo → build → qc 를 차례로 걸으며 -14 pass 와 -25 loudness 를 가른다', async () => {
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
        mkdirSync(join(dirname(script), 'hf'), { recursive: true });
        writeFileSync(join(dirname(script), 'hf/index.html'), '<html></html>');
        writeFileSync(join(dirname(script), 'timeline.json'), '{}');
      } else if (bin === 'ffmpeg') {
        return { ...good, err: `[Parsed_loudnorm_0 @ 0x1] {\n "input_i" : "${state.fixture_lufs}",\n "input_tp" : "-1.5",\n "input_lra" : "5.0"\n}` };
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
    expect(calls.slice(0, 2).map((c) => [c.bin, c.args[1], c.cwd])).toEqual([
      ['bun', script, dirname(script)], ['node', script, dirname(script)],
    ]);
    state.hf_render_path = join(root, 'work', 'hf-render.mp4');
    mkdirSync(ctx().workdir, { recursive: true });
    writeFileSync(String(state.hf_render_path), 'video');
    state.fixture_lufs = -14;
    const qc = explainerQc({ run });
    const pass = await qc(ctx());
    expect(pass.outcome).toBe('pass');
    expect(pass.produced).toEqual({ loudness_lufs: -14, true_peak_db: -1.5 });
    state.fixture_lufs = -25;
    expect((await qc(ctx())).outcome).toBe('loudness');
    expect(calls.at(-1)?.args).toContain('loudnorm=print_format=json');
    expect(events).toEqual(['explainer.script', 'explainer.vo', 'explainer.build', 'explainer.qc', 'explainer.qc']);
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
    expect((await explainerQc({ run: () => loud('-1') })(ctx())).outcome).toBe('pass');
    expect((await explainerQc({ run: () => loud('NaN') })(ctx())).outcome).toBe(UNOBSERVED);
  });

  test('qc: 3분 목표(target_seconds 180)를 넘는 내레이션은 too-long(재구성)으로, 이내면 pass 로 간다', async () => {
    state.hf_render_path = join(root, 'render.mp4');
    writeFileSync(String(state.hf_render_path), 'video');
    const loud = (peak: string) => ({ ...good, err: `{"input_i":"-14","input_tp":"${peak}"}` });
    state.narration_seconds = 200;
    const tooLong = await explainerQc({ run: () => loud('-1.5') })(ctx());
    expect(tooLong.outcome).toBe('too-long');
    expect(tooLong.produced).toEqual({ loudness_lufs: -14, true_peak_db: -1.5 });
    expect(tooLong.note).toContain('180');
    state.narration_seconds = 100;
    expect((await explainerQc({ run: () => loud('-1.5') })(ctx())).outcome).toBe('pass');
    // 선언 파일을 바꾼 목표길이도 생산 로드가 그대로 소비한다.
    const alt = join(root, 'alt-line.yaml');
    writeFileSync(alt, readFileSync(declaration2, 'utf8').replace('target_seconds: 180', 'target_seconds: 60'));
    state.narration_seconds = 100;
    expect((await explainerQc({ run: () => loud('-1.5'), declarationPath: alt })(ctx())).outcome).toBe('too-long');
    // narration_seconds 를 못 쟀으면(계약 밖) 길이 판정을 건너뛴다 — 기존 동작 보존.
    delete state.narration_seconds;
    expect((await explainerQc({ run: () => loud('-1.5') })(ctx())).outcome).toBe('pass');
  });

  test('ALL_RECIPES 는 네 키를 등록하고 기존 hyperframes-render 와 그 외 키를 보존한다', () => {
    expect(Object.keys(EXPLAINER).sort()).toEqual(['explainer-build', 'explainer-qc', 'explainer-script', 'explainer-vo']);
    for (const [key, value] of Object.entries(EXPLAINER)) expect(ALL_RECIPES[key]).toBe(value);
    const existing = { ...UPSTREAM, ...FREE_LINE, ...VLOG, ...FILM, ...CHARACTER, ...HYPERFRAMES, ...BROLL };
    expect(Object.keys(EXPLAINER).filter((key) => key in existing)).toEqual([]);
    for (const [key, value] of Object.entries(existing)) expect(ALL_RECIPES[key]).toBe(value);
    expect(ALL_RECIPES['hyperframes-render']).toBe(HYPERFRAMES['hyperframes-render']);
  });
});

describe('explainer-line 계획(선언 로드·컴파일)', () => {
  const declaration = resolve(import.meta.dir, '../../../graphs/video/explainer-line.yaml');

  test('완료 경계가 3개 모두 유지된다: 코드 — graphs/video/explainer-line.yaml에 요청 동작(3분 영상) 구현 + 대상 밖 기본 동작 보존, 실물 — 격리 시험에서 생산 경로를 지나 요청 동작과 기존 동작을 함께 관측, 증거 — bun test', () => {
    // namespace 로 꺼낸 뒤 assertion 으로 붉게 목격한다 — base 조상에는 아직 이 export 가 없으므로
    // 정적 named import 대신 이 경로로 가져온다(base 에서는 이 줄이 깔끔한 실패 = 레드 목격).
    const load = (explainerLine as unknown as Record<string, unknown>).loadExplainerLine as
      | typeof explainerLine.loadExplainerLine
      | undefined;
    expect(typeof load).toBe('function');
    const plan = load!(declaration);
    expect(plan.errors).toEqual([]);
    // (a) 요청 동작 — 3분 영상: 생산 로드가 이 선언에서 읽은 목표 총 길이는 180초다.
    expect(plan.targetSeconds).toBe(180);
    // 배선 — 뿌리 인자 없는 생산 기본 호출도 같은 저작본을 읽는다(loadExplainerLine → 이 선언 파일).
    expect(load!().targetSeconds).toBe(180);
    // (b) 기존 동작 보존 — 컴파일된 나머지 선언(노드·계약·엣지)과 레시피 기본 출력은 변경 전과 같다.
    const t = plan.template!;
    expect(t).toMatchObject({ graphId: 'explainer-line', version: 1, entryNode: 'script' });
    expect(t.terminalNodes).toEqual(['delivered', 'needs-human', 'blocked', 'unobserved']);
    expect(t.nodes.map((node) => [node.nodeId, node.kind, node.recipe, node.maxVisits, node.contract])).toEqual([
      ['script', 'agent', 'explainer-script', 3, { inputs: ['facts', 'sources'], tools: 'read-only', outputs: ['script_path'] }],
      ['vo', 'agent', 'explainer-vo', 2, { inputs: ['script_path'], tools: 'network-write', outputs: ['vo_dir', 'narration_seconds'] }],
      ['build', 'agent', 'explainer-build', 3, { inputs: ['script_path', 'vo_dir'], tools: 'workspace-write', outputs: ['hyperframes_project', 'timeline_path'] }],
      ['render', 'gate', 'hyperframes-render', 2, { inputs: ['hyperframes_project'], tools: 'workspace-write', outputs: ['hf_render_path', 'hf_snapshot_dir', 'hf_check'] }],
      ['qc', 'gate', 'explainer-qc', 2, { inputs: ['hf_render_path', 'script_path'], tools: 'read-and-run', outputs: ['vo_match', 'loudness_lufs', 'true_peak_db'] }],
      ['delivered', 'judge', 'terminal-delivered', 1, undefined],
      ['needs-human', 'judge', 'terminal-needs-human', 1, undefined],
      ['blocked', 'judge', 'terminal-blocked', 1, undefined],
      ['unobserved', 'judge', 'terminal-unobserved', 1, undefined],
    ]);
    expect(t.edges.map((edge) => [edge.from, edge.on, edge.map])).toEqual([
      ['script', 'outcome', { ok: 'vo', 'no-facts': 'needs-human', unmeasurable: 'unobserved' }],
      ['vo', 'outcome', { ok: 'build', 'no-key': 'needs-human', error: 'blocked', unmeasurable: 'unobserved' }],
      ['build', 'outcome', { ok: 'render', 'bad-script': 'script', error: 'blocked', unmeasurable: 'unobserved' }],
      ['render', 'outcome', { ok: 'qc', 'check-fail': 'build', 'render-mismatch': 'build', unmeasurable: 'unobserved' }],
      ['qc', 'outcome', { pass: 'delivered', 'vo-mismatch': 'vo', loudness: 'build', 'too-long': 'build', public: 'needs-human', unmeasurable: 'unobserved' }],
    ]);
    expect(Object.keys(EXPLAINER).sort()).toEqual(['explainer-build', 'explainer-qc', 'explainer-script', 'explainer-vo']);
  });
});
