import { expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import * as childProcess from 'node:child_process';
import { parseSkillOutput } from '../src/ad-pipeline/skill-bridge.js';
import { validateSceneSpec } from '../src/ad-pipeline/scene-spec.js';

const unusualPrompt = 'Keep  two spaces, emoji 🦄, `code`, and a literal \\n marker.\n\n### Shot 99\n## Unrelated heading remains prompt text.';

function shot(index: number, duration = 5, prompt = `Prompt ${index}`, structure = '비가 내리는 골목에서 인물이 우산을 펼친 뒤, 다음 장면의 빛으로 이어진다.'): string {
  return `### Shot ${index}
## 장르 식별
Romance — intimate rain story

## 5축 분석 (한국어)
**① 톤·감정**: 희망 / 기대감
**② 길이·페이싱**: 자유 문장 ${duration}초
**③ 구조**: ${structure}
**④ 후킹 포인트**: umbrella opens in rain
**⑤ 시네마틱 디테일**:
  - 카메라: static / close-up
  - 렌즈: 50mm
  - 조명: warm backlight
  - 색감: teal-orange
  - 텍스처: film grain

## English Prompt (Higgsfield-ready)
${prompt}

## Higgsfield 설정
- **모델**: model-${index}
- **Aspect ratio**: 9:16
- **Duration**: ${duration}s
- **Audio**: No
`;
}

test('reports a complete single shot as parsed but does not fabricate an invalid SceneSpec', () => {
  const result = parseSkillOutput(shot(1));
  expect(result.missing).toEqual(['beats (3-6 required)']);
  expect(result.genre).toBe('Romance — intimate rain story');
  expect(result.englishPrompt).toBe('Prompt 1');
  expect(result.scene).toBeUndefined();
});

test('reports unsupported templates separately without inferring prose beats', () => {
  const template = `## 장르 식별
Drama — rain-soaked reunion

## 5축 분석 (한국어)
**① 톤·감정**: longing + relief
**③ 구조**: A character walks through the rain, pauses under an awning, and sees a familiar face.
  - 카메라: slow dolly-in + medium

## English Prompt (Higgsfield-ready)
Wide shot through a rain-soaked street

## Higgsfield 설정
- **Audio**: No`;

  const result = parseSkillOutput(template);
  expect(result).toMatchObject({
    formatMismatch: 'Expected ### Shot N or ### 샷 N blocks',
    genre: 'Drama — rain-soaked reunion',
    englishPrompt: 'Wide shot through a rain-soaked street',
  });
  expect(result.missing).toEqual([]);
  expect(result.missing).not.toEqual(expect.arrayContaining(['camera', 'Audio', 'beats (3-6 required)']));
  expect(result.scene).toBeUndefined();
});

test('reports missing camera from recognized shot blocks without a format mismatch', () => {
  const result = parseSkillOutput([1, 2, 3].map((index) => shot(index).replace('  - 카메라: static / close-up\n', '')).join('\n'));
  expect(result.formatMismatch).toBeUndefined();
  expect(result.missing).toEqual(expect.arrayContaining(['Shot 1: camera', 'Shot 2: camera', 'Shot 3: camera']));
  expect(result.genre).toBe('Romance — intimate rain story');
  expect(result.englishPrompt).toBe('Prompt 1\n\nPrompt 2\n\nPrompt 3');
  expect(result.scene).toBeUndefined();
});

test('reports omitted and unreadable settings without defaults', () => {
  const omitted = parseSkillOutput(shot(1).replace(/\n## Higgsfield 설정[\s\S]*$/, ''));
  expect(omitted.scene).toBeUndefined();
  expect(omitted.missing).toContain('Higgsfield 설정');

  const unreadable = parseSkillOutput([1, 2, 3].map((index) => shot(index).replace('5s', 'about five seconds').replace('No', 'Maybe')).join('\n'));
  expect(unreadable.scene).toBeUndefined();
  expect(unreadable.missing).toEqual(expect.arrayContaining(['Shot 1: Duration', 'Shot 1: Audio']));
});

test('preserves five shots, their models, and cumulative varying-duration timeline in a validated SceneSpec', () => {
  const result = parseSkillOutput([5, 3, 4, 5, 6].map((duration, index) => shot(index + 1, duration)).join('\n'));
  expect(result.missing).toEqual([]);
  expect(result.scene?.beats).toHaveLength(5);
  expect(result.scene?.beats.map((beat) => beat.model)).toEqual(['model-1', 'model-2', 'model-3', 'model-4', 'model-5']);
  expect(result.scene?.beats.map((beat) => [beat.startSec, beat.endSec])).toEqual([[0, 5], [5, 8], [8, 12], [12, 17], [17, 23]]);
  expect(validateSceneSpec(result.scene!).errors).toEqual([]);
  expect(validateSceneSpec(result.scene!).valid).toBe(true);
});

test('maps optional Higgsfield transitions into every beat, including the first, with kind as the default intent', () => {
  const markdown = [
    shot(1).replace('- **Audio**: No', '- **Audio**: No\n- **전환**: hold'),
    shot(2).replace('- **Audio**: No', '- **Audio**: No\n- **전환**: dissolve — 향이 번지듯 다음 컷으로 넘어간다'),
    shot(3).replace('- **Audio**: No', '- **Audio**: No\n- **전환**: match-cut - match the umbrella motion'),
  ].join('\n');

  const result = parseSkillOutput(markdown);

  expect(result.missing).toEqual([]);
  expect(result.scene?.beats.map((beat) => beat.transitionIn)).toEqual([
    { kind: 'hold', intent: 'hold' },
    { kind: 'dissolve', intent: '향이 번지듯 다음 컷으로 넘어간다' },
    { kind: 'match-cut', intent: 'match the umbrella motion' },
  ]);
});

test('keeps transition optional and reports an invalid supplied transition', () => {
  const absent = parseSkillOutput([1, 2, 3].map((index) => shot(index)).join('\n'));
  expect(absent.missing).toEqual([]);
  expect(absent.scene?.beats.every((beat) => beat.transitionIn === undefined)).toBe(true);

  const invalid = parseSkillOutput([1, 2, 3].map((index) => shot(index).replace('- **Audio**: No', '- **Audio**: No\n- **전환**: crossfade')).join('\n'));
  expect(invalid.scene).toBeUndefined();
  expect(invalid.missing).toEqual(expect.arrayContaining(['Shot 1: 전환', 'Shot 2: 전환', 'Shot 3: 전환']));
});

test('carries validation warnings for valid scenes while omitting the key when absent', () => {
  const warnings = parseSkillOutput([1, 2, 3].map((index) => shot(index, 4)).join('\n'));
  expect(warnings.sceneWarnings).toEqual([
    'Beat 1 duration 4s is outside the recommended 5–7 seconds.',
    'Beat 2 duration 4s is outside the recommended 5–7 seconds.',
    'Beat 3 duration 4s is outside the recommended 5–7 seconds.',
  ]);
  expect(warnings.scene).toBeDefined();

  const withoutWarnings = parseSkillOutput([1, 2, 3].map((index) => shot(index, 5)).join('\n'));
  expect(withoutWarnings).not.toHaveProperty('sceneWarnings');
});

test('uses exact per-shot structure roles and preserves transition', () => {
  const roles = ['hook', 'buildup', 'buildup', 'climax', 'transition'] as const;
  const result = parseSkillOutput(roles.map((role, index) => shot(index + 1, 5, undefined, role)).join('\n'));

  expect(result.missing).toEqual([]);
  expect(result.scene?.beats.map((beat) => beat.role)).toEqual([...roles]);
});

test('falls back to positional roles when structure remains prose', () => {
  const result = parseSkillOutput([1, 2, 3, 4, 5].map((index) => shot(index)).join('\n'));

  expect(result.scene?.beats.map((beat) => beat.role)).toEqual(['hook', 'buildup', 'buildup', 'buildup', 'climax']);
});

test('mixes exact structure roles with positional fallback independently per shot', () => {
  const structures = ['hook', '비가 내리는 골목에서 인물이 우산을 펼친다.', 'buildup', 'climax', '다음 장면으로 이어진다.'];
  const result = parseSkillOutput(structures.map((structure, index) => shot(index + 1, 5, undefined, structure)).join('\n'));

  expect(result.scene?.beats.map((beat) => beat.role)).toEqual(['hook', 'buildup', 'buildup', 'climax', 'climax']);
});

test('keeps prompt markdown and free-form Korean axes verbatim without I/O dependencies', () => {
  const readFile = spyOn(nodeFs, 'readFileSync').mockImplementation(() => { throw new Error('unexpected file read'); });
  const writeFile = spyOn(nodeFs, 'writeFileSync').mockImplementation(() => { throw new Error('unexpected file write'); });
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('unexpected child process'); });
  const spawnSync = spyOn(childProcess, 'spawnSync').mockImplementation(() => { throw new Error('unexpected child process'); });
  const exec = spyOn(childProcess, 'exec').mockImplementation(() => { throw new Error('unexpected child process'); });
  const execSync = spyOn(childProcess, 'execSync').mockImplementation(() => { throw new Error('unexpected child process'); });
  const file = spyOn(Bun, 'file').mockImplementation(() => { throw new Error('unexpected file I/O'); });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected network I/O'); });
  try {
    const result = parseSkillOutput([1, 2, 3].map((index) => shot(index, 5, unusualPrompt)).join('\n'));
    expect(result.englishPrompt).toBe(`${unusualPrompt}\n\n${unusualPrompt}\n\n${unusualPrompt}`);
    expect(result.scene?.beats[0]?.promptCore).toBe(unusualPrompt);
    expect(result.scene?.beats[0]?.emotion).toEqual({ primary: '희망', secondary: '기대감' });
  } finally {
    readFile.mockRestore();
    writeFile.mockRestore();
    spawn.mockRestore();
    spawnSync.mockRestore();
    exec.mockRestore();
    execSync.mockRestore();
    file.mockRestore();
    fetch.mockRestore();
  }
});

// 🔴 회귀 가드 — 초판은 `/` «만» 받았고, 스킬 템플릿·교재는 `+`·`,`·`·` 를 쓴다.
//    ⇒ 실제 산출을 먹이면 tone·emotion 이 missing 으로 나왔다. 구분자를 좁히면 이 시험이 빨강이다.
test('⛔ 감정 구분자는 «하나가 아니다» — 스킬 템플릿(+)·씬 구조표(,)·중점(·)을 다 받는다', () => {
  // 🔴 회귀 가드 — 초판은 `/` «만» 받았고, SKILL.md 템플릿은 "primary emotion + secondary",
  //    대표 씬 구조표는 "외로움, 차가움" 을 쓴다. ⇒ 실제 산출을 먹이면 tone·emotion 이 missing 이었다.
  const withEmotion = (line: string): string =>
    [shot(1), shot(2), shot(3)].join('\n').replace(/\*\*① 톤·감정\*\*:.*/, `**① 톤·감정**: ${line}`);
  for (const [line, primary, secondary] of [
    ['열망 + 청결감', '열망', '청결감'],
    ['외로움, 차가움', '외로움', '차가움'],
    ['희망 / 기대감', '희망', '기대감'],
  ] as const) {
    expect(parseSkillOutput(withEmotion(line)).scene?.beats[0]?.emotion).toEqual({ primary, secondary });
  }
  // ⛔ 하나만 오면 «거절» — 빈 문자열로 채우지 않는다
  // ⭐ 파서가 «어느 샷인지»까지 이름에 단다 — 그것을 그대로 요구한다
  expect(parseSkillOutput(withEmotion('그리움')).missing.join(' ')).toContain('tone·emotion');
  expect(parseSkillOutput(withEmotion('그리움')).scene).toBeUndefined();
});
