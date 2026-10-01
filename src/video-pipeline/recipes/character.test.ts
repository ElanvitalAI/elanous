// 캐릭터 → 영상 레시피 — 합성 소재로 «실제 ffmpeg» 를 태운다.
//
// ⛔ 무는 것: 관문이 «진짜로» 가르나 ⊕ 눈이 봐야 하는 판정은 말해 주지 않으면 «통과하지 않는다» ⊕ 되돌이가 수렴하나.
//   🩸 2026-09-23 실물(NOVA): fullbleed → shots → «같은» 샷 → fullbleed … 예산이 다할 때까지 돌았다.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg } from './ffmpeg.js';
import type { RecipeCtx } from './types.js';
import { animationPrinciplesGate, barSnappedAssemble, CHARACTER, countPanels, directedShots, identityHoldsGate, inkRulerAny, sheetPanelsGate } from './character.js';
import { spawnSync } from 'node:child_process';

let root = '';
const ctxOf = (state: Record<string, unknown>): RecipeCtx => ({ workdir: join(root, 'work'), state, log: () => {} });
const TARGETS = [{ key: '9x16', name: 'reels_9x16', w: 1080, h: 1920, cy: 0.44 }];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'char-rec-'));
  const box = (x: number) => `drawbox=x=${x}:y=200:w=300:h=680:color=black:t=fill`;
  // 턴어라운드 시트 — 밝은 바탕에 인물 «셋».
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:d=1', '-vf', [box(200), box(810), box(1420)].join(','), '-frames:v', '1', join(root, 'sheet3.png')]);
  // ⛔ 지어낸 음성 — 인물 «하나»짜리 시트.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:d=1', '-vf', box(810), '-frames:v', '1', join(root, 'sheet1.png')]);
  // 가운데 1/3 에만 잉크 — 잘라서 된다.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=24:d=2', '-vf', 'drawbox=x=640:y=300:w=640:h=480:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'center.mp4')]);
  // ⛔ 화면 전체에 잉크 — 잘라선 못 키운다.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'wide.mp4')]);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('sheet-panels-gate — 칸을 센다', () => {
  it('✅ 인물 셋이면 3칸 · pass', async () => {
    expect(countPanels(join(root, 'sheet3.png'))).toBe(3);
    expect((await sheetPanelsGate(ctxOf({ sheet_path: join(root, 'sheet3.png') }))).outcome).toBe('pass');
  });
  it('⛔ 지어낸 음성 — 인물 하나면 thin', async () => {
    expect((await sheetPanelsGate(ctxOf({ sheet_path: join(root, 'sheet1.png') }))).outcome).toBe('thin');
  });
  it('파일이 없으면 unreadable — 0 칸이 아니다', async () => {
    expect((await sheetPanelsGate(ctxOf({ sheet_path: join(root, 'nope.png') }))).outcome).toBe('unreadable');
  });
});

describe('⛔ 눈이 봐야 하는 판정 — 말해 주지 않으면 «통과하지 않는다»', () => {
  it('identity: told 없으면 unprobed · 1 이면 holds · 0 이면 drifts', async () => {
    const base = { element_id: 'e1' };
    expect((await identityHoldsGate(ctxOf(base))).outcome).toBe('unprobed');
    expect((await identityHoldsGate(ctxOf({ ...base, told: { identity_holds: 1 } }))).outcome).toBe('holds');
    expect((await identityHoldsGate(ctxOf({ ...base, told: { identity_holds: 0 } }))).outcome).toBe('drifts');
  });
  it('연출: told 없으면 unviewed · 0 이면 flat — 순위 자(shot_variation)만으로는 판정하지 않는다', async () => {
    const base = { shot_paths: [join(root, 'center.mp4')] };
    expect((await animationPrinciplesGate(ctxOf(base))).outcome).toBe('unviewed');
    expect((await animationPrinciplesGate(ctxOf({ ...base, told: { shots_principled: 0 } }))).outcome).toBe('flat');
  });
});

describe('ink-ruler — 한 이름 · 두 계약(입력 모양으로 갈린다)', () => {
  it('✅ 잉크가 가운데 1/3 이면 croppable', async () => {
    expect((await inkRulerAny(ctxOf({ shot_paths: [join(root, 'center.mp4')], targets: TARGETS }))).outcome).toBe('croppable');
  }, 60_000);
  it('⛔ 지어낸 음성 — 잉크가 화면 전체면 fullbleed', async () => {
    const r = await inkRulerAny(ctxOf({ shot_paths: [join(root, 'wide.mp4')], targets: TARGETS }));
    expect(r.outcome).toBe('fullbleed');
    expect(r.produced?.fullbleed_cuts).toEqual(['wide']);
  }, 60_000);
  it('그 비율로 «다시 그린» 파일(native)이 있으면 되돌리지 않는다', async () => {
    const r = await inkRulerAny(ctxOf({ shot_paths: [join(root, 'wide.mp4')], targets: TARGETS, native_sources: { wide: { '9x16': join(root, 'wide.mp4') } } }));
    expect(r.outcome).toBe('croppable');
  }, 60_000);
  it('film 모양(plan ⊕ mixed_path)이면 film 갈래로 간다 — fullbleed 를 내지 않는다', async () => {
    const r = await inkRulerAny(ctxOf({ plan: [['BOX', 0, 2]], mixed_path: join(root, 'center.mp4'), shot_sources: { BOX: join(root, 'center.mp4') }, targets: TARGETS }));
    expect(['croppable', 'needs-native']).toContain(r.outcome);
  }, 60_000);
});

describe('⭐ 되돌이 수렴 — fullbleed 로 돌아온 샷 노드는 «같은 샷»을 다시 내지 않는다', () => {
  it('처음엔 ok · 다시 그려야 할 샷이 남아 있으면 error(→ rendered-unedited)', async () => {
    const shot_sources = { s1: join(root, 'wide.mp4') };
    expect((await directedShots(ctxOf({ shot_sources }))).outcome).toBe('ok');
    expect((await directedShots(ctxOf({ shot_sources, fullbleed_cuts: ['wide'] }))).outcome).toBe('error');
  });
});

it('directedShots 는 임시 DB 에서 샷별 참고를 기록하고 DB 부재에도 outcome 을 보존한다', async () => {
  const file = join(root, 'vflow.ndjson');
  const base = { url: 'https://example.test/tracking', model: 'seedance-2-0', category: 'camera', name: 'Tracking', description: '', prompt: 'slow tracking shot', keywords: ['tracking'], author: 'Aster', authorUrl: 'https://example.test/aster' };
  writeFileSync(file, [
    { ...base, spec: { camera: ['tracking'] }, video: { url: 'https://example.test/video.mp4' } },
    { ...base, url: 'https://example.test/orbit', spec: { camera: ['orbit'] }, video: { url: 'https://example.test/orbit.mp4' } },
    base,
  ].map((row) => JSON.stringify(row)).join('\n'));
  const state = { shot_sources: { a: join(root, 'wide.mp4') }, shot_prompts: { a: 'slow tracking shot of a person' }, shot_model: 'seedance', vflow_file: file };
  const result = await directedShots(ctxOf(state));
  expect(result.outcome).toBe('ok');
  expect(result.produced?.shot_references).toEqual({ a: [{
    url: 'https://example.test/tracking', videoUrl: 'https://example.test/video.mp4', model: 'seedance-2-0',
    name: 'Tracking', author: 'Aster', authorUrl: 'https://example.test/aster', camera: ['tracking'],
  }] });
  expect(result.note).toContain('vflow 참고 1샷/1샷');
  const missing = await directedShots(ctxOf({ ...state, vflow_file: join(root, 'missing.ndjson') }));
  expect(missing.outcome).toBe('ok');
  expect(missing.note).toContain('vflow DB 없음');
  expect((await directedShots(ctxOf({ ...state, fullbleed_cuts: ['wide'] }))).outcome).toBe('error');
  const multi = await directedShots(ctxOf({ ...state, shot_prompts: { a: 'tracking orbit shot' } }));
  expect((multi.produced?.shot_references as Record<string, unknown[]>).a).toHaveLength(2);
  const noCamera = await directedShots(ctxOf({ ...state, shot_prompts: { a: 'a person waits' } }));
  expect((noCamera.produced?.shot_references as Record<string, unknown[]>).a).toEqual([]);
});

it('directedShots 는 실제 파일이 있는 shot_sources 키만 참고에 연결하고 샷 수에 센다', async () => {
  const file = join(root, 'vflow-source-keys.ndjson');
  writeFileSync(file, JSON.stringify({
    url: 'https://example.test/tracking', model: 'seedance-2-0', category: 'camera',
    name: 'Tracking', description: '', prompt: 'slow tracking shot', keywords: ['tracking'],
    author: 'Aster', authorUrl: 'https://example.test/aster',
    spec: { camera: ['tracking'] }, video: { url: 'https://example.test/tracking.mp4' },
  }));
  const shot_sources = { a: join(root, 'wide.mp4'), c: join(root, 'missing-shot.mp4') };
  const shot_prompts = { b: 'slow tracking shot', c: 'slow tracking shot' };
  const result = await directedShots(ctxOf({ shot_sources, shot_prompts, vflow_file: file }));
  expect(result.outcome).toBe('ok');
  expect(result.produced?.shot_paths).toEqual([join(root, 'wide.mp4')]);
  expect(result.produced?.shot_references).toEqual({});
  expect(result.note).toContain('vflow 참고 0샷/1샷');
  const matched = await directedShots(ctxOf({ shot_sources, shot_prompts: { a: 'slow tracking shot', b: 'slow tracking shot', c: 'slow tracking shot' }, vflow_file: file }));
  expect(Object.keys(matched.produced?.shot_references as Record<string, unknown>)).toEqual(['a']);
  expect((matched.produced?.shot_references as Record<string, unknown[]>).a).toHaveLength(1);
  expect(matched.note).toContain('vflow 참고 1샷/1샷');
});

it('directedShots 는 카메라 용어의 단어 경계를 검사해 ecstatic 안의 static 을 참조하지 않는다', async () => {
  const file = join(root, 'vflow-camera-boundary.ndjson');
  writeFileSync(file, JSON.stringify({
    url: 'https://example.test/static', model: 'seedance-2-0', category: 'camera',
    name: 'Static shot', description: '', prompt: 'static shot', keywords: ['static'],
    author: 'Aster', authorUrl: 'https://example.test/aster',
    spec: { camera: ['static'] }, video: { url: 'https://example.test/static.mp4' },
  }));
  const state = { shot_sources: { a: join(root, 'wide.mp4') }, vflow_file: file };
  const falseMatch = await directedShots(ctxOf({ ...state, shot_prompts: { a: 'ecstatic crowd' } }));
  expect(falseMatch.outcome).toBe('ok');
  expect((falseMatch.produced?.shot_references as Record<string, unknown[]>).a).toEqual([]);
  expect(falseMatch.note).toContain('vflow 참고 0샷/1샷');
  const exactMatch = await directedShots(ctxOf({ ...state, shot_prompts: { a: 'static shot of the crowd' } }));
  expect((exactMatch.produced?.shot_references as Record<string, unknown[]>).a).toHaveLength(1);
});

describe('⭐ 편집이 «다시 그린» 9:16 을 실제로 쓴다 (🩸 2026-09-23: 키가 어긋나 16:9 를 잘라 썼다)', () => {
  const centerRgb = (file: string): number[] => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', file, '-vf', 'crop=2:2:iw/2:ih/2,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    return [...(r.stdout as Buffer)].slice(0, 3);
  };
  const setup = () => {
    const d = join(root, 'edit');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'green.mp4')]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=720x1280:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, 'red_9x16.mp4')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=2', join(root, 'tone.m4a')]);
    return { d, state: { plan: [['s1', 0, 2]], audio: join(root, 'tone.m4a'), fps: 24, targets: TARGETS,
      shot_sources: { s1: join(root, 'green.mp4') }, ink: { green: { L: 0, R: 1920, cx: 960 } } } };
  };
  it('네이티브(파일 이름 키)를 주면 9:16 결과가 «그» 소재다 — 빨강', async () => {
    const { d, state } = setup();
    const r = await barSnappedAssemble({ workdir: d, log: () => {}, state: { ...state, native_sources: { green: { '9x16': join(root, 'red_9x16.mp4') } } } });
    expect(r.outcome).toBe('ok');
    const [R, G] = centerRgb((r.produced!.social_paths as string[])[0]!);
    expect(R).toBeGreaterThan(150); expect(G).toBeLessThan(100);
  }, 120_000);
  it('⛔ 짝 — 네이티브가 없으면 원본을 쓴다 — 초록', async () => {
    const { d, state } = setup();
    const r = await barSnappedAssemble({ workdir: join(d, 'n'), log: () => {}, state });
    expect(r.outcome).toBe('ok');
    const [R, G] = centerRgb((r.produced!.social_paths as string[])[0]!);
    expect(G).toBeGreaterThan(80); expect(R).toBeLessThan(100);
  }, 120_000);
});

it('레시피 표 — character 선언의 열 이름이 «전부» 있다', () => {
  const decl = readFileSync(join(import.meta.dir, '../../../graphs/video/character-video-standard.yaml'), 'utf8');
  const names = [...new Set([...decl.matchAll(/recipe:\s*([\w-]+)/g)].map((m) => m[1]!))].filter((n) => !n.startsWith('terminal-'));
  expect(names.length).toBe(10);
  expect(names.filter((n) => !(n in CHARACTER))).toEqual([]);
});
