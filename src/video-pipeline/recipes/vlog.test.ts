// 브이로그 레시피 — 합성 소재로 «실제 ffmpeg» 를 태운다. 리졸브 갈래는 가짜 헬퍼로 누른다.
//
// ⛔ 이 자가 무는 것: 「레시피가 돈다」가 아니라 ***「선언의 간선 이름을 내나」 ⊕ 「관문이 «진짜로» 가르나」***.
//   🩸 2026-09-23: `recipes` 명령이 find-narrative 를 «묶임»으로 셌는데 계약이 달라 걸으면 죽었다.
//   ⇒ 관문(frame-exact · duck)은 «지어낸 음성»으로 빨강이 나는지까지 본다.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, run } from './ffmpeg.js';
import type { RecipeCtx } from './types.js';
import {
  alphaMean, alphaMeanFor, authorShotsJson, bodyThenDuck, buildLayers, extractCutsWithHandles, frameExactGate, levelBasedDuckGate,
  LINE_CHARS, probeSources, resolvePing, resolveTimeline, timelineReadback, VLOG, wrapLines, type HandleManifest,
} from './vlog.js';
import { findNarrative } from './upstream.js';

let root = '';
let src = '';
const ctxOf = (state: Record<string, unknown>, workdir = join(root, 'work')): RecipeCtx => ({ workdir, state, log: () => {} });
const renderToolBin = process.env.ELANOUS_TEST_FFMPEG_DRAW_BIN || 'ffmpeg';
const measureWithRenderTool = alphaMeanFor(renderToolBin);
const filterProbe = run(renderToolBin, ['-hide_banner', '-filters']);
const hasLayerFilters = filterProbe.ok && ['drawtext', 'alphaextract', 'signalstats'].every((filter) =>
  new RegExp(`\\b${filter}\\b`).test(filterProbe.out));

// 빈 HOME의 cold ffmpeg 기동은 Bun의 기본 5초 hook 한도를 넘을 수 있다.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vlog-rec-'));
  src = join(root, 'src');
  // 소재 셋 — 둘은 소리(말 대신 «끊어지는» 사인파), 하나는 무음.
  for (const [i, audio] of [[1, true], [2, true], [3, false]] as const) {
    const out = join(src, `clip${i}.mp4`);
    const args = ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=f=440:d=4', '-af', "volume='if(lt(mod(t,2),1),1,0)':eval=frame", '-shortest');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), out);
    mkdirSync(src, { recursive: true });
    const r = ffmpeg(args);
    if (!r.ok) throw new Error(`합성 실패: ${r.err}`);
  }
  const music = ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:d=20', '-af', 'volume=0.5', join(root, 'music.wav')]);
  if (!music.ok) throw new Error(music.err);
}, 60_000);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('vlog 레시피 — 실제 ffmpeg', () => {
  const state: Record<string, unknown> = {};

  it('probe-sources — 소재 셋 · 소리 있음 ⇒ ok', async () => {
    state.source_dir = src;
    const r = await probeSources(ctxOf(state));
    Object.assign(state, r.produced);
    expect(r.outcome).toBe('ok');
    expect((state.clips as unknown[]).length).toBe(3);
    expect(state.has_audio).toBe(true);
  });

  it('author-shots-json — 구조가 없으면 소재 균등 «초안»(그렇다고 말한다)', async () => {
    const r = await authorShotsJson(ctxOf({ ...state, target_w: 320, target_h: 240 }));
    Object.assign(state, r.produced);
    expect(r.outcome).toBe('ok');
    expect(r.note).toContain('초안');
    expect(Number(state.target_dur)).toBeGreaterThan(0);
  });

  it('⭐ extract-cuts-with-handles → frame-exact-gate 는 pass (프레임·start_time·핸들)', async () => {
    const c = await extractCutsWithHandles(ctxOf(state));
    Object.assign(state, c.produced);
    expect(c.outcome).toBe('ok');
    const g = await frameExactGate(ctxOf(state));
    expect(g.outcome).toBe('pass');
  }, 120_000);

  it('⛔ 지어낸 음성 — 핸들을 3프레임으로 적으면 nohandle · 몸통을 부풀리면 short', async () => {
    const hp = state.handles_json as string;
    const man = JSON.parse(readFileSync(hp, 'utf8')) as HandleManifest;
    const k = man.order[0]!;
    const bad1 = join(root, 'h1.json'), bad2 = join(root, 'h2.json');
    writeFileSync(bad1, JSON.stringify({ ...man, cuts: { ...man.cuts, [k]: { ...man.cuts[k]!, head: 3 } } }));
    writeFileSync(bad2, JSON.stringify({ ...man, cuts: { ...man.cuts, [k]: { ...man.cuts[k]!, body: man.cuts[k]!.body + 500 } } }));
    expect((await frameExactGate(ctxOf({ handles_json: bad1 }))).outcome).toBe('nohandle');
    expect((await frameExactGate(ctxOf({ handles_json: bad2 }))).outcome).toBe('short');
  }, 60_000);

  // 🩸 2026-09-23 — 분모 0 이 pass 였다(「못 쟀다」를 «통과»로).
  it('⛔ 지어낸 음성 — 컷이 0개인 원장은 pass 가 아니라 «못 쟀다»', async () => {
    const empty = join(root, 'h0.json');
    writeFileSync(empty, JSON.stringify({ fps: 30, handles: 15, order: [], cuts: {} }));
    expect((await frameExactGate(ctxOf({ handles_json: empty }))).outcome).toBe('unmeasurable');
  });

  it('⭐ body-then-duck → level-based-duck-gate 는 «말할 때 음악이 실제로 내려갔나»를 잰다', async () => {
    const a = await bodyThenDuck(ctxOf({ ...state, music: join(root, 'music.wav') }));
    Object.assign(state, a.produced);
    expect(a.outcome).toBe('ok');
    expect(state.ducked_wav).toBeTruthy();
    const g = await levelBasedDuckGate(ctxOf(state));
    // 📏 실측(2026-09-23): 합성 소재에서 깊이 ≈15dB — 문턱(4dB)보다 한참 위라 «pass» 로 못 박는다.
    expect(g.outcome).toBe('pass');
    expect(Number(g.produced?.duck_db)).toBeLessThan(Number(g.produced?.silent_db));
  }, 120_000);

  it('⛔ 지어낸 음성 — 더킹 «안 한» 음악을 주면 weak (깊이 ≈ 0)', async () => {
    const g = await levelBasedDuckGate(ctxOf({ ...state, ducked_wav: join(root, 'music.wav') }));
    expect(g.outcome).toBe('weak');
  }, 60_000);

  it.skipIf(!hasLayerFilters)('⭐ build-layers — 실물 필터가 있으면 스크림·자막 알파를 잰다', async () => {
    const shots = join(root, 'shots-text.json');
    writeFileSync(shots, JSON.stringify({ fps: 30, width: 320, height: 240, target_dur: 2, chapters: [{ id: 'C01', text: '안녕하세요', cuts: [{ src: '/x', in: 0, dur: 2 }] }] }));
    const font = join(import.meta.dir, '../../../apps/ios/ElanousiOS/ElanousiOS/Fonts/D2Coding-Ver1.3.2-20180524.ttc');
    expect(existsSync(font)).toBe(true);
    const renderCalls: string[][] = [];
    const state: Record<string, unknown> = {
      shots_json: shots,
      font_file: font,
      ffmpeg: (args: readonly string[], timeout?: number) => {
        renderCalls.push([...args]);
        return run(renderToolBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], timeout);
      },
      alpha_mean: measureWithRenderTool,
    };
    const r = await buildLayers(ctxOf(state, join(root, 'lay')));
    expect(renderCalls.length).toBe(3);
    if (r.outcome !== 'ok') throw new Error(r.note ?? 'build-layers failed without a note');
    expect(r.outcome).toBe('ok');
    expect(r.produced?.text).toBeTruthy();
    const textAlpha = measureWithRenderTool(String(r.produced!.text), 1);
    expect(textAlpha).not.toBeNull();
    expect(textAlpha!).toBeLessThan(50);
    // 평균만 낮으면 자막이 아예 없는 투명 프레임도 통과한다. 같은 렌더 도구의 실제 픽셀 최댓값을 잰다.
    const peak = run(renderToolBin, ['-hide_banner', '-nostats', '-ss', '1.00', '-i', String(r.produced!.text), '-frames:v', '1', '-vf', 'alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMAX', '-f', 'null', '-']);
    expect(peak.ok, peak.err).toBe(true);
    const peakAlpha = /YMAX=([\d.]+)/.exec(peak.err);
    expect(peakAlpha, peak.err).not.toBeNull();
    expect(Number(peakAlpha![1])).toBeGreaterThan(0);
    expect(measureWithRenderTool(String(r.produced!.scrim), 0)!).toBeLessThan(200);
  }, 120_000);

  it('build-layers — 주입한 렌더 도구 가용성과 알파 측정 실패를 구별한다', async () => {
    const shots = join(root, 'shots-tool-availability.json');
    writeFileSync(shots, JSON.stringify({ fps: 30, width: 320, height: 240, target_dur: 2, chapters: [{ id: 'C01', text: '안녕하세요', cuts: [{ src: '/x', in: 0, dur: 2 }] }] }));
    const font = join(import.meta.dir, '../../../apps/ios/ElanousiOS/ElanousiOS/Fonts/D2Coding-Ver1.3.2-20180524.ttc');
    const success = { ok: true, code: 0, signal: null, err: '', out: '' };
    const unavailable = { ok: false, code: null, signal: null, err: 'ffmpeg filter unavailable', out: '' };
    const renderCalls: string[][] = [];
    let toolAvailable = false;
    const state = {
      shots_json: shots,
      font_file: font,
      ffmpeg: (args: readonly string[]) => {
        renderCalls.push([...args]);
        return toolAvailable ? success : unavailable;
      },
      alpha_mean: () => 10,
    };
    const missingTool = await buildLayers(ctxOf(state, join(root, 'lay-missing-tool')));
    expect(missingTool.outcome).toBe('error');
    expect(missingTool.note).toContain('ffmpeg filter unavailable');

    toolAvailable = true;
    const availableTool = await buildLayers(ctxOf(state, join(root, 'lay-available-tool')));
    expect(availableTool.outcome).toBe('ok');
    expect(availableTool.produced?.text).toBeTruthy();
    expect(renderCalls.some((args) => args.some((arg) => arg.includes('drawtext=')))).toBe(true);
    const nullMeasurement = await buildLayers(ctxOf({ ...state, alpha_mean: () => null }, join(root, 'lay-null')));
    expect(nullMeasurement.outcome).toBe('error');
    expect(nullMeasurement.note).toContain('알파를 못 쟀다');
  });

  it('⛔ 지어낸 음성 — 알파 자는 «불투명»을 불투명이라고 말한다 (자가 산다)', () => {
    const opaque = join(root, 'opaque.mov');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=64x64:r=30:d=1', '-vf', 'format=argb', '-c:v', 'qtrle', opaque]);
    expect(alphaMean(opaque, 0)!).toBeGreaterThan(200);   // 🩸 이것이 실물에서 영상을 가린 바로 그 모양이다
  });

  it('음악이 없으면 더킹 관문은 «못 쟀다» — 실패가 아니다', async () => {
    const g = await levelBasedDuckGate(ctxOf({ ...state, ducked_wav: null }));
    expect(g.outcome).toBe('unmeasurable');
  });
});

describe('리졸브 갈래 — 가짜 헬퍼로 누른다', () => {
  const fake = (code: number, json: Record<string, unknown>): string => {
    const p = join(root, `fake-${code}-${Object.keys(json).join('')}.py`);
    writeFileSync(p, `#!/usr/bin/env python3\nimport sys\nprint(${JSON.stringify(JSON.stringify(json))})\nsys.exit(${code})\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const withPy = async <T>(p: string, f: () => Promise<T>): Promise<T> => {
    const prev = process.env.VLOG_RESOLVE_PY; process.env.VLOG_RESOLVE_PY = p;
    try { return await f(); } finally { if (prev === undefined) delete process.env.VLOG_RESOLVE_PY; else process.env.VLOG_RESOLVE_PY = prev; }
  };
  const man = (): string => {
    const p = join(root, 'man.json');
    writeFileSync(p, JSON.stringify({ fps: 30, handles: 15, order: ['A'], cuts: { A: { head: 15, body: 60, tail: 15, path: '/x', src: '/x', in: 0, dur: 2 } } }));
    return p;
  };

  it('⛔ 리졸브에 못 붙으면(종료 3) app-silent — 실패가 아니라 「못 쟀다」쪽', async () => {
    const r = await withPy(fake(3, { ok: false, attached: false, why: '안 떠 있다' }), () => resolveTimeline(ctxOf({ handles_json: man() })));
    expect(r.outcome).toBe('app-silent');
  });

  it('되읽기 — 틈이 있으면 gap · 끝이 다르면 wrong-length · 맞으면 pass', async () => {
    const st = { handles_json: man(), project: 'P', timeline: 'T' };
    expect((await withPy(fake(0, { ok: true, gaps: [['A', 0, 1]], transition_lens: [20], end_frame: 60 }), () => timelineReadback(ctxOf(st)))).outcome).toBe('gap');
    expect((await withPy(fake(0, { ok: true, gaps: [], transition_lens: [20], end_frame: 59 }), () => timelineReadback(ctxOf(st)))).outcome).toBe('wrong-length');
    expect((await withPy(fake(0, { ok: true, gaps: [], transition_lens: [2], end_frame: 60 }), () => timelineReadback(ctxOf(st)))).outcome).toBe('short-transition');
    expect((await withPy(fake(0, { ok: true, gaps: [], transition_lens: [20], end_frame: 60 }), () => timelineReadback(ctxOf(st)))).outcome).toBe('pass');
  });

  // 🩸 film preflight 의 resolve_attached 는 «늘 null» 이었다 — 선언이 약속한 값을 한 번도 안 쟀다.
  it('⭐ ping — 붙음 true · 못 붙음(3) false · ***못 물어봤다 null*** (null 을 false 로 접지 않는다)', async () => {
    expect((await withPy(fake(0, { ok: true, attached: true, version: '21.1' }), async () => resolvePing())).attached).toBe(true);
    expect((await withPy(fake(3, { ok: false, attached: false, why: 'off' }), async () => resolvePing())).attached).toBe(false);
    expect((await withPy(join(root, 'no-such-helper.py'), async () => resolvePing())).attached).toBeNull();
  });
});

describe('find-narrative — 이름 하나 · 계약 둘', () => {
  it('⭐ 전사가 있으면 vlog 계약(arc·peaks·why_filmed)을 낸다', async () => {
    const transcripts = [
      { clip: '/a', segments: [{ start: 0, end: 2, text: '안녕하세요 오늘은 회사에 왔습니다' }, { start: 3, end: 4, text: '네' }] },
      { clip: '/b', segments: [{ start: 1, end: 3, text: '여기가 우리 팀 자리입니다' }] },
    ];
    const r = await findNarrative(ctxOf({ transcripts }));
    expect(r.outcome).toBe('found');
    expect(Object.keys(r.produced ?? {}).sort()).toEqual(['arc', 'peaks', 'why_filmed']);
  });

  it('⛔ 말이 얇으면 thin — 「하이라이트 모음」으로 흘러가지 않는다', async () => {
    const r = await findNarrative(ctxOf({ transcripts: [{ clip: '/a', segments: [{ start: 0, end: 1, text: '음' }] }] }));
    expect(r.outcome).toBe('thin');
  });

  it('✅ 전사가 없으면 종전 계약(beats) 그대로 — video-production 회귀 방어', async () => {
    const r = await findNarrative(ctxOf({ source_files: ['/a', '/b', '/c'] }));
    expect(r.outcome).toBe('found');
    expect(r.produced).toHaveProperty('beats');
  });
});

it('레시피 표 — vlog 선언의 열네 이름이 «전부» 있다', () => {
  const decl = readFileSync(join(import.meta.dir, '../../../graphs/video/vlog-found-footage-pipeline.declaration.yaml'), 'utf8');
  const names = [...new Set([...decl.matchAll(/recipe:\s*([\w-]+)/g)].map((m) => m[1]!))].filter((n) => !n.startsWith('terminal-') && n !== 'find-narrative');
  expect(names.length).toBe(14);
  expect(names.filter((n) => !(n in VLOG))).toEqual([]);
});

it('⭐ 자막 줄 나누기 — 폭을 넘지 않고 두 줄까지 · 넘치면 «…» 로 잘린 사실을 남긴다', () => {
  // 🩸 실물 자막(40자)이 한 줄로 그려져 1080 폭 양옆이 잘렸다.
  const long = '미국이 인디애나주가 농업하고 뭐 되게 농업하는 데가 되게 많나봐요. 여기 농업에 특화된 주라 그래가지고';
  const ls = wrapLines(long, LINE_CHARS, 2);
  expect(ls.length).toBe(2);
  expect(ls.every((l) => l.length <= LINE_CHARS)).toBe(true);
  expect(ls[1]!.endsWith('…')).toBe(true);
  expect(wrapLines('짧은 문장', LINE_CHARS, 2)).toEqual(['짧은 문장']);
});
