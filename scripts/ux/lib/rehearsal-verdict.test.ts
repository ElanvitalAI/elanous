import { expect, test } from 'bun:test';
import { failedApiResponse, judgeRun, judgeScene, worstSceneState, type SceneObservation } from './rehearsal-verdict.js';

const clean = (): SceneObservation => ({ scene: 3, title: '루프 에이전트', hiddenByDemo: false, secs: 20, frames: 10, exceptions: [], failedRequests: [], textLength: 40, leaks: [], sectionsInDom: 6, visibleScene: 3 });

test('clean scene is ok; a hidden demo scene is unverified (not a pass) even with absent content', () => {
  expect(judgeScene(clean())).toMatchObject({ verdict: 'ok', reasons: [] });
  expect(judgeScene({ ...clean(), hiddenByDemo: true, textLength: 0, sectionsInDom: 0, visibleScene: null }).verdict).toBe('unverified');
});

test('each breakage has a Korean reason', () => {
  const cases: Array<[Partial<SceneObservation>, string]> = [
    [{ exceptions: ['boom'] }, '실행 예외'],
    [{ failedRequests: ['http://localhost/v1/trace'] }, 'API 요청 실패'],
    [{ textLength: 39 }, '빈 화면'],
    [{ blankFrames: 1 }, '녹화 프레임 빈 화면'],
    [{ sectionsInDom: 5 }, '언마운트'],
    [{ visibleScene: 4 }, '불일치'],
    [{ leaks: ['token'] }, '누설'],
  ];
  for (const [change, reason] of cases) {
    const result = judgeScene({ ...clean(), ...change });
    expect(result.verdict).toBe('broken');
    expect(result.reasons.some((r) => r.includes(reason))).toBe(true);
  }
  expect(judgeScene({ ...clean(), failedRequests: ['http://localhost/favicon.ico', 'http://localhost/_next/static/app.js'] })).toMatchObject({ verdict: 'ok', reasons: [] });
  expect(judgeScene({ ...clean(), failedRequests: ['/v1/data?token=private'] }).reasons).toEqual(['API 요청 실패 1건']);
});

test('a failed API path keeps its shape but collapses ids', () => {
  expect(failedApiResponse('http://localhost/v1/workflows/runs/0f3a9c1e2b4d5f60?x=1', 404)).toBe('/v1/workflows/runs/:id 404');
  expect(failedApiResponse('http://localhost/v1/harness/runs/run-1a2b3c4d-5e6f-7a8b-9c0d-112233445566', 500)).toBe('/v1/harness/runs/:id 500');
});

test('HTTP 4xx and 5xx API responses count as failures, but assets and successes do not', () => {
  for (const status of [400, 404, 500, 503]) {
    const failed = failedApiResponse('http://localhost/v1/trace?secret=private', status);
    expect(failed).toBe(`/v1/trace ${status}`);
    expect(failed).not.toContain('secret');
    expect(judgeScene({ ...clean(), failedRequests: [failed!] }).verdict).toBe('broken');
  }
  for (const [url, status] of [
    ['http://localhost/v1/trace', 200],
    ['http://localhost/favicon.ico', 404],
    ['http://localhost/_next/static/app.js', 500],
  ] as const) expect(failedApiResponse(url, status)).toBeNull();
});

test('a transient blank or invisible scene remains broken after it recovers', () => {
  const good = { textLength: 40, sectionsInDom: 6, visibleScene: 3 };
  const blank = { textLength: 39, sectionsInDom: 6, visibleScene: 3 };
  const invisible = { textLength: 40, sectionsInDom: 6, visibleScene: null };
  const unmounted = { textLength: 40, sectionsInDom: 5, visibleScene: 3 };
  expect(judgeScene({ ...clean(), ...worstSceneState(3, [good, blank, good]) }).reasons).toContain('빈 화면 (글자 39자)');
  expect(judgeScene({ ...clean(), ...worstSceneState(3, [good, invisible, good]) }).reasons.some((reason) => reason.includes('불일치'))).toBe(true);
  expect(judgeScene({ ...clean(), ...worstSceneState(3, [good, unmounted, good]) }).reasons).toContain('장면 언마운트 (5/6)');
  expect(worstSceneState(3, [good, good])).toEqual(good);
});

test('run verdict counts each status and breaks on any broken scene', () => {
  const ok = judgeScene(clean());
  const broken = judgeScene({ ...clean(), exceptions: ['boom'] });
  const skipped = judgeScene({ ...clean(), scene: 5, hiddenByDemo: true });
  expect(judgeRun([ok, broken, skipped])).toEqual({ verdict: 'broken', ok: 1, broken: 1, unverified: 1, banner: ['⑤ 미검증 — WIZ1 착지 뒤 실물 필요'], scenes: [ok, broken, skipped] });
  expect(judgeRun([ok, skipped]).verdict).toBe('unverified');
  expect(judgeRun([ok]).verdict).toBe('ok');
  expect(judgeRun([ok]).banner).toEqual([]);
});
