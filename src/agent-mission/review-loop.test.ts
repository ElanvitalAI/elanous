import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as llm from '../llm.js';
import { buildReworkMission, classifyReview, extractAppliedReviewItems, fetchAppliedReviewItemsForBranch, fetchLatestReview, judgeAndFinalize, prepareReviewLoopContext, runReviewLoop, runReworkMission, type LatestReviewSource } from './review-loop.js';
import { buildJudgePrompt, parseJudge, type AcpJudgeResult } from './acp-judge.js';
import { format } from '../agent-substrate/pr-comment-meta.js';
import type { AgentMissionResult, AgentMissionSpec } from './driver.js';

const source = (overrides: Partial<LatestReviewSource> = {}): LatestReviewSource => ({ headRefName: 'fix/review-loop', reviews: [], comments: [], ...overrides });
const comment = (body: string, login = 'ElanvitalAI') => ({ body, author: { login } });
const fetch = (payload: LatestReviewSource) => (args: string[]) => {
  expect(args).toEqual(['pr', 'view', '5550', '--json', 'reviews,comments,headRefName,title,body']);
  return JSON.stringify(payload);
};

function captureFilterObservation(fn: () => unknown): Record<string, unknown> {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    fn();
    const call = log.mock.calls.find(([component, event]) => component === 'review-loop' && event === 'comment-signals-filtered');
    expect(call).toBeDefined();
    return call![2] as Record<string, unknown>;
  } finally { log.mockRestore(); }
}

const reinforcementHeadline = '✅ 리뷰 보강 자동 반영(codex-in-elanous·제1원칙 렌즈):';
const identityHeader = '<!-- elanous-pr-comment v1 role=author -->';

const reviewedSource = () => source({ reviews: [{ body: 'LGTM — please merge', state: 'APPROVED', author: { login: 'reviewer' }, submittedAt: '2026-10-10T00:00:00Z' }] });
const reviewLoopFiles = JSON.stringify({ files: [{ path: 'src/example.ts', additions: 1, deletions: 0 }] });

describe('review-loop 분류 실패와 심판 범위 관측', () => {
  test.each([
    ['문자열', 'provider overloaded', 'provider overloaded'],
    ['객체', { provider: 'anthropic', status: 503 }, '{"provider":"anthropic","status":503}'],
    ['Error', new Error('provider overloaded'), 'provider overloaded'],
  ])('LLM 호출이 %s을 던져도 ambiguous verdict와 읽을 수 있는 failure 사유를 남긴다', async (_kind, thrown, expectedReason) => {
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async () => { throw thrown; });
    try {
      await expect(classifyReview('이 리뷰를 분류해라.')).resolves.toEqual({
        verdict: 'ambiguous', asks: [], reason: `분류 오류: ${expectedReason}`, classificationSource: 'llm-call-failure',
      });
    } finally { stream.mockRestore(); }
  });

  test.each([
    ['직렬화와 문자열 변환이 모두 실패하는 null-prototype 순환 객체', (() => {
      const value = Object.create(null) as { self?: unknown };
      value.self = value;
      return value;
    })()],
    ['instanceof의 getPrototypeOf 트랩이 실패하는 Proxy', new Proxy({}, {
      getPrototypeOf: () => { throw new Error('prototype trap'); },
    })],
    ['Error의 message getter가 실패하는 객체', Object.create(Error.prototype, {
      message: { get: () => { throw new Error('message getter'); } },
    })],
    ['문자열 변환 불가 Error message 객체', Object.create(Error.prototype, {
      message: { value: Object.create(null) },
    })],
  ])('%s도 ambiguous 판정과 failure source를 보존한다', async (_label, thrown) => {
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async () => { throw thrown; });
    try {
      await expect(classifyReview('이 리뷰를 분류해라.')).resolves.toEqual({
        verdict: 'ambiguous', asks: [], reason: '분류 오류: [unprintable thrown value]', classificationSource: 'llm-call-failure',
      });
    } finally { stream.mockRestore(); }
  });

  test('실제로 모호한 리뷰는 ambiguous verdict이지만 LLM 호출 실패 source가 아니다', async () => {
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('{"verdict":"ambiguous","asks":[],"reason":"요청이 상충한다"}');
    try {
      await expect(classifyReview('요청이 상충하는 실제 리뷰')).resolves.toEqual({
        verdict: 'ambiguous', asks: [], reason: '요청이 상충한다', classificationSource: 'llm',
      });
    } finally { stream.mockRestore(); }
  });

  const reviewLoopGh = (comments: string[]) => (args: string[]) => {
    if (args[1] === 'view') {
      return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(source()) : reviewLoopFiles;
    }
    if (args[1] === 'comment') comments.push(args[args.indexOf('--body') + 1]!);
    return '';
  };

  test('light clean review of a release PR does not approve or auto-merge', async () => {
    const calls: string[] = [];
    const path = 'graphs/release/loop.yaml';
    const result = await runReviewLoop('5550', {
      runGh: (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'api') return JSON.stringify([[{ filename: path }]]);
        if (args[0] === 'label' && args[1] === 'list') return '[]';
        if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(source()) : reviewLoopFiles;
        return '';
      },
      classify: async () => ({ verdict: 'ok', asks: [], reason: 'clean', classificationSource: 'llm' }),
      autoMergeOnOk: true,
      approve: () => { throw new Error('approval forbidden'); },
    });
    expect(result.action).toBe('parked');
    expect(calls).toContain(`pr comment 5550 --body OP approval required: automatic merge held because this PR changes ${path}.`);
    expect(calls.some((call) => call.startsWith('pr merge'))).toBe(false);
  });

  test.each(['scripts/release-loop/publish.ts', 'graphs/release/loop.yaml', 'src/release-loop/manifest.ts'])(
    'light clean review holds a rename from %s even though the destination is unprotected', async (path) => {
      const calls: string[] = [];
      const result = await runReviewLoop('5550', {
        runGh: (args) => {
          calls.push(args.join(' '));
          if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts', status: 'renamed', previous_filename: path }]]);
          if (args[0] === 'label' && args[1] === 'list') return '[]';
          if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(source()) : reviewLoopFiles;
          return '';
        },
        classify: async () => ({ verdict: 'ok', asks: [], reason: 'clean', classificationSource: 'llm' }),
        autoMergeOnOk: true,
        approve: () => { throw new Error('approval forbidden'); },
      });
      expect(result.action).toBe('parked');
      expect(calls.some((call) => call.startsWith('pr merge'))).toBe(false);
      expect(calls).toContain('pr edit 5550 --add-label elanous:release-path');
      expect(calls).toContain(`pr comment 5550 --body OP approval required: automatic merge held because this PR changes ${path}.`);
    },
  );

  // TA-LAND-MUSTFIX-ZERO — 1차 «ok» 자동 병합 출구: 지적(must-fix)이 남거나 목록을 모르면 승인·병합 없이 parked + 관측.
  //   «모름»은 합성 주입이 아니라 «실제 분류 파서»(classifyReview)에 asks 빠진/깨진 LLM 응답을 넣어 끝까지 돌린다.
  test.each([
    ['must-fix 1', '{"verdict":"ok","asks":["still broken"],"reason":"lgtm but"}', 'review-warn-with-must-fix'],
    ['asks 필드 없음', '{"verdict":"ok","reason":"lgtm"}', 'review-must-fix-unknown'],
    ['asks 가 배열 아님', '{"verdict":"ok","asks":"none","reason":"lgtm"}', 'review-must-fix-unknown'],
    ['asks 에 문자열 아닌 원소', '{"verdict":"ok","asks":[3],"reason":"lgtm"}', 'review-must-fix-unknown'],
  ] as const)('light ok ⊕ %s(실 분류 파서) 는 autoMergeOnOk 여도 승인·병합하지 않는다', async (_label, llmText, reason) => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue(llmText);
    const calls: string[] = [];
    try {
      const result = await runReviewLoop('5550', {
        runGh: (args) => {
          calls.push(args.join(' '));
          if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts' }]]);
          if (args[0] === 'label' && args[1] === 'list') return '[]';
          if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(reviewedSource()) : reviewLoopFiles;
          return '';
        },
        autoMergeOnOk: true,
        approve: () => { throw new Error('approval forbidden'); },
      });
      expect(result.action).toBe('parked');
      expect(result.detail).toContain(reason);
      expect(calls.some((call) => call.startsWith('pr merge'))).toBe(false);
      expect(calls.some((call) => call.startsWith('pr comment 5550') && call.includes(reason))).toBe(true);
      const blocked = log.mock.calls.find(([component, event]) => component === 'review-loop' && event === 'auto-merge-blocked');
      expect(blocked?.[2]).toMatchObject({ pr: '5550', stage: 'initial-ok', reason });
    } finally { stream.mockRestore(); log.mockRestore(); }
  });

  test('light ok ⊕ asks:[] (실 분류 파서) 는 종전대로 승인·자동 병합한다', async () => {
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('{"verdict":"ok","asks":[],"reason":"lgtm"}');
    const calls: string[] = [];
    try {
      const result = await runReviewLoop('5550', {
        runGh: (args) => {
          calls.push(args.join(' '));
          if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts' }]]);
          if (args[0] === 'label' && args[1] === 'list') return '[]';
          if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(reviewedSource()) : reviewLoopFiles;
          return '';
        },
        autoMergeOnOk: true,
        approve: () => {},
        recordReviewOutcome: () => {},
      });
      expect(result.action).toBe('merged');
      expect(calls).toContain('pr merge 5550 --squash');
    } finally { stream.mockRestore(); }
  });

  test('heavy(finalJudge) ok ⊕ must-fix 는 autoMerge 여도 심판으로 가지 않고 parked — 심판 merge 가 1차 must-fix 를 덮지 못한다', async () => {
    const calls: string[] = [];
    const result = await runReviewLoop('5550', {
      runGh: (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts' }]]);
        if (args[0] === 'label' && args[1] === 'list') return '[]';
        if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(reviewedSource()) : reviewLoopFiles;
        return '';
      },
      injectedReview: { verdict: 'ok', asks: ['still broken'] },
      finalJudge: true,
      autoMerge: true,
      approve: () => { throw new Error('approval forbidden'); },
      judge: async () => { throw new Error('judge must not run'); },
    });
    expect(result.action).toBe('parked');
    expect(result.detail).toContain('review-warn-with-must-fix');
    expect(calls.some((call) => call.startsWith('pr merge'))).toBe(false);
  });

  test('heavy: 실 분류(ok·asks []) → 실 심판 파서(merge·asks 없음) 를 runReviewLoop 끝까지 — 병합 0 · parked', async () => {
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('{"verdict":"ok","asks":[],"reason":"lgtm"}');
    const calls: string[] = [];
    try {
      const result = await runReviewLoop('5550', {
        runGh: (args) => {
          calls.push(args.join(' '));
          if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts' }]]);
          if (args[0] === 'label' && args[1] === 'list') return '[]';
          if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(reviewedSource()) : reviewLoopFiles;
          if (args[1] === 'diff') return 'diff';
          return '';
        },
        finalJudge: true,
        autoMerge: true,
        approve: () => { throw new Error('approval forbidden'); },
        recordReviewOutcome: () => { throw new Error('merge outcome forbidden'); },
        judge: async (): Promise<AcpJudgeResult> => parseJudge('{"verdict":"merge","reason":"looks fine"}'),
      });
      expect(result.action).toBe('parked');
      expect(result.detail).toContain('review-must-fix-unknown');
      expect(calls.some((call) => call.startsWith('pr merge'))).toBe(false);
    } finally { stream.mockRestore(); }
  });

  test('heavy ok ⊕ must-fix 라도 autoMergeOnOk 만(autoMerge 아님)이면 관문이 막지 않고 종전대로 심판 → ready-to-merge', async () => {
    let judged = 0;
    const result = await runReviewLoop('5550', {
      runGh: (args) => {
        if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts' }]]);
        if (args[0] === 'label' && args[1] === 'list') return '[]';
        if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(source()) : reviewLoopFiles;
        if (args[1] === 'diff') return 'diff';
        return '';
      },
      injectedReview: { verdict: 'ok', asks: ['still broken'] },
      finalJudge: true,
      autoMergeOnOk: true,
      approve: () => { throw new Error('approval forbidden'); },
      judge: async (): Promise<AcpJudgeResult> => { judged++; return parseJudge('{"verdict":"merge","asks":[],"reason":"fine"}'); },
    });
    expect(judged).toBe(1);
    expect(result.action).toBe('ready-to-merge');
  });

  test('light ok ⊕ must-fix 0 은 종전대로 승인·자동 병합한다', async () => {
    const calls: string[] = [];
    const approved: string[] = [];
    const result = await runReviewLoop('5550', {
      runGh: (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/ordinary.ts' }]]);
        if (args[0] === 'label' && args[1] === 'list') return '[]';
        if (args[1] === 'view') return args.includes('reviews,comments,headRefName,title,body') ? JSON.stringify(source()) : reviewLoopFiles;
        return '';
      },
      injectedReview: { verdict: 'ok', asks: [] },
      autoMergeOnOk: true,
      approve: (pr) => { approved.push(pr); },
      recordReviewOutcome: () => {},
      verifyMerge: false,
    });
    expect(approved).toEqual(['5550']);
    expect(calls).toContain('pr merge 5550 --squash');
    expect(result.action).not.toBe('parked');
  });

  // TA-LAND-MUSTFIX-ZERO — 2차 심판 «merge» 자동 병합 출구: 심판 asks(미해결 지적)가 남거나 목록을 모르면 HITL.
  //   심판 응답은 «실제 심판 파서»(parseJudge — judgeWithAcp 가 쓰는 그것)로 읽는다.
  test.each([
    ['must-fix 1', '{"verdict":"merge","asks":["unresolved"],"reason":"mostly fine"}', 'review-warn-with-must-fix'],
    ['asks 필드 없음', '{"verdict":"merge","reason":"mostly fine"}', 'review-must-fix-unknown'],
    ['asks 에 문자열 아닌 원소', '{"verdict":"merge","asks":[{}],"reason":"mostly fine"}', 'review-must-fix-unknown'],
  ] as const)('2차 심판 merge ⊕ %s(실 심판 파서) 는 autoMerge 여도 승인·병합하지 않는다', async (_label, judgeText, reason) => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const calls: string[] = [];
    try {
      const result = await judgeAndFinalize('100', 'branch', ['ask'], {
        autoMerge: true,
        runGh: (args) => {
          calls.push(args.join(' '));
          if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/example.ts' }]]);
          if (args[1] === 'diff') return 'diff';
          return '';
        },
        approve: () => { throw new Error('approval forbidden'); },
        recordReviewOutcome: () => { throw new Error('merge outcome forbidden'); },
        judge: async (): Promise<AcpJudgeResult> => parseJudge(judgeText),
      }, '', '/tmp', 2, true, 'light', ['src/example.ts']);
      if ('rework' in result) throw new Error('expected final result');
      expect(result.action).toBe('parked');
      expect(result.detail).toContain(reason);
      expect(calls).not.toContain('pr merge 100 --squash');
      expect(calls.some((call) => call.startsWith('pr comment 100') && call.includes(reason))).toBe(true);
      const blocked = log.mock.calls.find(([component, event]) => component === 'review-loop' && event === 'auto-merge-blocked');
      expect(blocked?.[2]).toMatchObject({ pr: '100', stage: 'final-judge', reason, round: 2 });
    } finally { log.mockRestore(); }
  });

  test('runReviewLoop의 classified 관측은 실패 사유와 failure source를 전달한다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const comments: string[] = [];
    try {
      const result = await runReviewLoop('5550', {
        runGh: reviewLoopGh(comments),
        classify: async () => ({ verdict: 'ambiguous', asks: [], reason: '분류 오류: provider overloaded', classificationSource: 'llm-call-failure' }),
      });
      expect(result.action).toBe('parked');
      expect(result.action).not.toBe('clarify');
      expect(comments).toEqual([expect.stringContaining('분류 오류: provider overloaded')]);
      expect(comments[0]).toContain('인프라');
      expect(comments[0]).not.toContain('모호');
      expect(comments[0]).not.toContain('명확한 지적');
      const classified = log.mock.calls.find(([component, event]) => component === 'review-loop' && event === 'classified');
      expect(classified?.[2]).toMatchObject({
        verdict: 'ambiguous', reason: '분류 오류: provider overloaded', classificationSource: 'llm-call-failure',
      });
    } finally { log.mockRestore(); }
  });

  test('실제로 모호한 LLM 판정은 기존 명확화 코멘트와 clarify action을 유지한다', async () => {
    const comments: string[] = [];
    const result = await runReviewLoop('5550', {
      runGh: reviewLoopGh(comments),
      classify: async () => ({ verdict: 'ambiguous', asks: [], reason: '요청이 상충한다', classificationSource: 'llm' }),
    });
    expect(result.action).toBe('clarify');
    expect(comments).toEqual([
      '❓ 리뷰 판정이 모호하다(요청이 상충한다). 명확한 지적(보강/거절)을 남겨주면 자동 반영하겠다.',
    ]);
  });

  test('2차 심판은 전체 diff를 ACP 프롬프트 경로에 넘기고 경계값 절단 범위를 리터럴로 표시한다', async () => {
    for (const totalChars of [24_000, 24_001] as const) {
      const comments: string[] = [];
      const diff = 'x'.repeat(totalChars);
      let receivedDiff = '';
      let prompt = '';
      const result = await judgeAndFinalize('100', 'branch', ['ask'], {
        runGh: (args) => {
          if (args[1] === 'diff') return diff;
          if (args[1] === 'comment') comments.push(args[args.indexOf('--body') + 1]!);
          return '';
        },
        judge: async (input): Promise<AcpJudgeResult> => {
          receivedDiff = input.diff;
          prompt = buildJudgePrompt(input);
          return { verdict: 'merge', asks: [], reason: 'gates passed', raw: '' };
        },
      }, '', '/tmp', 1, false, 'light', []);
      expect('rework' in result).toBe(false);
      if ('rework' in result) throw new Error('expected a final judge result');
      expect(result.action).toBe('ready-to-merge');
      expect(receivedDiff).toBe('x'.repeat(totalChars));
      if (totalChars === 24_000) {
        expect(prompt).not.toContain('… [diff truncated]');
        expect(comments).toEqual([expect.stringContaining('심판 diff 범위: 본 24000자 / 전체 24000자')]);
      } else {
        expect(prompt).toContain('… [diff truncated]');
        expect(comments).toEqual([expect.stringContaining('심판 diff 범위: 본 24000자 / 전체 24001자')]);
      }
    }
  });

  test.each(['scripts/release-loop/publish.ts', 'graphs/release/loop.yaml', 'src/release-loop/manifest.ts'])(
    '2차 심판 자동 병합도 %s 변경 PR은 승인 대기로 보낸다', async (path) => {
      const calls: string[] = [];
      const result = await judgeAndFinalize('100', 'branch', [], {
        autoMerge: true,
        runGh: (args) => {
          calls.push(args.join(' '));
          if (args[0] === 'api') return JSON.stringify([[{ filename: path }]]);
          if (args[0] === 'label' && args[1] === 'list') return '[]';
          return '';
        },
        approve: () => { throw new Error('approval forbidden'); },
        judge: async (): Promise<AcpJudgeResult> => ({ verdict: 'merge', asks: [], reason: 'clean', raw: '' }),
      }, '', '/tmp', 1, false, 'light', [path]);
      expect('rework' in result).toBe(false);
      if ('rework' in result) throw new Error('expected final result');
      expect(result.action).toBe('parked');
      expect(calls).not.toContain('pr merge 100 --squash');
      expect(calls).toContain('pr edit 100 --add-label elanous:release-path');
      expect(calls).toContain(`pr comment 100 --body OP approval required: automatic merge held because this PR changes ${path}.`);
    },
  );

  test.each([
    ['자동 merge', 'merge', true, 'merged'],
    ['거절', 'reject', false, 'parked'],
    ['모호', 'ambiguous', false, 'parked'],
  ] as const)('2차 심판 %s 코멘트도 diff 범위를 그대로 표시한다', async (_label, verdict, autoMerge, action) => {
    const comments: string[] = [];
    const approved: Array<[string, string]> = [];
    const recorded: Array<[string, string, string, readonly string[] | undefined]> = [];
    const result = await judgeAndFinalize('100', 'branch', ['ask'], {
      autoMerge,
      runGh: (args) => {
        if (args[0] === 'api') return JSON.stringify([[{ filename: 'src/example.ts' }]]);
        if (args[1] === 'diff') return 'diff';
        if (args[1] === 'comment') comments.push(args[args.indexOf('--body') + 1]!);
        return '';
      },
      approve: (pr, note) => approved.push([pr, note]),
      recordReviewOutcome: (pr, depth, kind, files) => recorded.push([pr, depth, kind, files]),
      judge: async (): Promise<AcpJudgeResult> => ({ verdict, asks: [], reason: 'gates passed', raw: '' }),
    }, '', '/tmp', 1, false, 'light', ['src/example.ts']);
    expect('rework' in result).toBe(false);
    if ('rework' in result) throw new Error('expected a final judge result');
    expect(result.action).toBe(action);
    expect(comments).toEqual([expect.stringContaining('심판 diff 범위: 본 4자 / 전체 4자')]);
    if (autoMerge) {
      expect(approved).toEqual([['100', '2차 ACP 최종심판 MERGE (round 1)']]);
      expect(recorded).toEqual([['100', 'light', 'merged', ['src/example.ts']]]);
    } else {
      expect(approved).toEqual([]);
      expect(recorded).toEqual([]);
    }
  });
});

describe('extractAppliedReviewItems review-context carryover', () => {
  test('keeps the public string array contract while reading identity-header and direct headlines', () => {
    const items: string[] = extractAppliedReviewItems([
      { createdAt: '2026-08-08T01:00:00Z', body: `${identityHeader}\n${reinforcementHeadline}\n- header item` },
      { createdAt: '2026-08-08T02:00:00Z', body: `${reinforcementHeadline}\n- direct item` },
      { createdAt: '2026-08-08T03:00:00Z', body: '표제가 아닌 코멘트\n- ignored item' },
    ]);

    expect(items).toEqual(['direct item', 'header item']);
  });

  test('status details carry applied review items alongside ordinary comments in parent timestamp order', () => {
    const status = `<!-- elanous:run-status -->\n<details>\n<summary>Round history</summary>\n\n${format({ role: 'author', run: 'run-x', round: 0 })}\n${reinforcementHeadline}\n- first\n\n${format({ role: 'author', run: 'run-x', round: 1 })}\n${reinforcementHeadline}\n- second\n</details>`;
    const comments = [
      { createdAt: '2026-08-08T01:00:00Z', body: `${reinforcementHeadline}\n- old` },
      { createdAt: '2026-08-08T02:00:00Z', body: status },
      { createdAt: '2026-08-08T03:00:00Z', body: `${reinforcementHeadline}\n- newest` },
    ];
    expect(extractAppliedReviewItems(comments)).toEqual(['newest', 'first', 'second', 'old']);
    expect(extractAppliedReviewItems([{ createdAt: '2026-08-08T02:00:00Z', body: status.replace('<!-- elanous:run-status -->', 'human') }])).toEqual([]);
  });

  test('reports a recognized headline with no bullets separately from a missing headline', () => {
    const result = fetchAppliedReviewItemsForBranch('feature/review', () => JSON.stringify(source({
      comments: [{ createdAt: '2026-08-08T01:00:00Z', body: `${reinforcementHeadline}\n본문만 있고 불릿 없음`, author: { login: 'ElanvitalAI' } }],
    })));

    expect(result).toEqual({ basePrLocated: true, items: [], headlineComments: 1 });
  });
});

describe('fetchLatestReview 자동 상태 댓글 필터', () => {
  test('self-authored status comment is not picked and records filtering facts', () => {
    let result: ReturnType<typeof fetchLatestReview> | undefined;
    const observation = captureFilterObservation(() => { result = fetchLatestReview('5550', fetch(source({ comments: [comment('❓ 리뷰 판정이 모호하다(리뷰 본문 없음).')] }))); });
    expect(result).toEqual({ branch: 'fix/review-loop', body: '', author: 'unknown' });
    expect(observation).toMatchObject({ pr: '5550', commentCount: 1, skippedBotComments: 1, hasExternalSignal: false });
  });

  test('human comment after a self-authored status comment is picked', () => {
    expect(fetchLatestReview('5550', fetch(source({ comments: [comment('❓ 리뷰 판정이 모호하다(리뷰 본문 없음).'), comment('이 부분은 실제 리뷰입니다.', 'reviewer')] })))).toEqual({ branch: 'fix/review-loop', body: '이 부분은 실제 리뷰입니다.', author: 'reviewer' });
  });

  test('human comment before a self-authored status comment remains picked', () => {
    expect(fetchLatestReview('5550', fetch(source({ comments: [comment('이 부분은 실제 리뷰입니다.', 'reviewer'), comment('🔁 ACP Claude Code 2차 최종심판: REWORK')] })))).toEqual({ branch: 'fix/review-loop', body: '이 부분은 실제 리뷰입니다.', author: 'reviewer' });
  });

  test('only self-authored comments yield the existing empty-body path', () => {
    expect(fetchLatestReview('5550', fetch(source({ comments: [comment('⚠️ 보강 rework 미완(라운드 1·증거 미충족: json-parse-fail)'), comment('🛑 ACP Claude Code 2차 최종심판: **AMBIGUOUS** (라운드 1) → 대표 결정 필요.\n사유: json-parse-fail')] })))).toEqual({ branch: 'fix/review-loop', body: '', author: 'unknown' });
  });

  test('reviews retain precedence over comments and count as an external signal', () => {
    let result: ReturnType<typeof fetchLatestReview> | undefined;
    const observation = captureFilterObservation(() => { result = fetchLatestReview('5550', fetch(source({ reviews: [{ body: '리뷰 객체의 수정 요청', state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }], comments: [comment('❓ 리뷰 판정이 모호하다(리뷰 본문 없음).')] }))); });
    expect(result).toEqual({ branch: 'fix/review-loop', body: '리뷰 객체의 수정 요청', author: 'reviewer' });
    expect(observation).toMatchObject({ commentCount: 1, skippedBotComments: 1, hasExternalSignal: true });
  });

  test('human CHANGES_REQUESTED review with a warning headline is selected and not counted as skipped', () => {
    let result: ReturnType<typeof fetchLatestReview> | undefined;
    const observation = captureFilterObservation(() => { result = fetchLatestReview('5550', fetch(source({ reviews: [{ body: '⚠️ 이 부분은 위험합니다', state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] }))); });
    expect(result).toEqual({ branch: 'fix/review-loop', body: '⚠️ 이 부분은 위험합니다', author: 'reviewer' });
    expect(observation).toMatchObject({ reviewCount: 1, skippedBotReviews: 0, hasExternalSignal: true });
  });

  test('human LGTM review with a checkmark headline is selected', () => {
    expect(fetchLatestReview('5550', fetch(source({ reviews: [{ body: '✅ LGTM, 머지해도 됩니다', state: 'APPROVED', author: { login: 'reviewer' } }] })))).toEqual({ branch: 'fix/review-loop', body: '✅ LGTM, 머지해도 됩니다', author: 'reviewer' });
  });

  test('self-authored approval review is skipped and cannot outrank a later human comment', () => {
    let result: ReturnType<typeof fetchLatestReview> | undefined;
    const observation = captureFilterObservation(() => { result = fetchLatestReview('5550', fetch(source({ reviews: [{ body: '✅ 자동 리뷰 승인(LGTM): 모든 점검을 통과했습니다', state: 'APPROVED', author: { login: 'ElanvitalAI' } }], comments: [comment('이 부분은 실제 사람이 남긴 최신 댓글입니다.', 'reviewer')] }))); });
    expect(result).toEqual({ branch: 'fix/review-loop', body: '이 부분은 실제 사람이 남긴 최신 댓글입니다.', author: 'reviewer' });
    expect(observation).toMatchObject({ reviewCount: 1, skippedBotReviews: 1, hasExternalSignal: true });
  });

  test('measured failure sequence cannot feed its status notices back as a review', () => {
    expect(fetchLatestReview('5550', fetch(source({ comments: [comment('❓ 리뷰 판정이 모호하다(리뷰 본문 없음). 명확한 지적(보강/거절)을 남겨주면 자동 반영하겠다.'), comment('🛑 ACP Claude Code 2차 최종심판: **AMBIGUOUS** (라운드 1) → 대표 결정 필요.\n사유: json-parse-fail')] })))).toEqual({ branch: 'fix/review-loop', body: '', author: 'unknown' });
  });
});

describe('review-loop 사람이 제공한 참고 자료', () => {
  test('text와 파일 자료를 기존 리뷰 지적에 추가하고 읽기 실패를 값으로 보존한다', () => {
    const context = prepareReviewLoopContext({
      contextOrder: [
        { kind: 'text', value: '사람의 판단 근거' },
        { kind: 'file', value: 'docs/review.md' },
        { kind: 'file', value: 'missing.md' },
      ],
      readReferencedFile: (path) => path === 'docs/review.md'
        ? { kind: 'ok', contents: '파일 근거' }
        : { kind: 'missing' },
    });
    expect(context.text).toContain('사람의 판단 근거');
    expect(context.text).toContain('파일 근거');
    expect(context.observation).toMatchObject({
      reviewerContextLoaded: 2,
      reviewerContextFailed: 1,
      reviewerContextFailures: [{ path: 'missing.md', kind: 'missing' }],
    });
    const mission = buildReworkMission(['기존 리뷰 지적'], 'review-branch', context.text);
    expect(mission).toContain('기존 리뷰 지적');
    expect(mission).toContain('사람의 판단 근거');
  });

  test('12,000자 예산 초과는 자료를 멈추지 않고 절단 관측으로 남긴다', () => {
    const context = prepareReviewLoopContext({ contextText: ['x'.repeat(12_500)] });
    expect(context.text).toContain('chars omitted from reviewer context item');
    expect(context.observation).toMatchObject({
      reviewerContextLoaded: 1,
      reviewerContextTruncated: true,
      reviewerContextTotalChars: 12_500 + '### provided text\n'.length,
    });
  });

  // ⛔ 「안 잘렸다」와 「관측이 아예 없다」가 같은 모양이면 무인 경로에서 그 차이를 볼 사람이 없다.
  //    (리뷰 should-fix ① · 2026-08-06 — git-control 불변식 ③ 「0」과 「못 셌음」을 다른 값으로)
  test('절단이 «없을 때»도 카운트를 남겨 「관측 없음」과 구분된다', () => {
    const context = prepareReviewLoopContext({ contextText: ['짧은 근거'] });
    expect(context.observation).toMatchObject({
      reviewerContextLoaded: 1,
      reviewerContextTruncated: false,
      reviewerContextOmitted: 0,
      reviewerContextPartiallyIncluded: 0,
      reviewerContextFullyIncluded: 1,
    });
  });
});

// ⭐⭐ 배선 시험 — 「사람이 준 자료가 «최종 심판까지» 갔나」.
//    ⛔ 앞의 테스트들은 buildReworkMission(=rework 경로)만 물어서, 심판 호출부에서 컨텍스트를
//       지워도 통과했다(리뷰 should-fix ②). 이 테스트는 심판 심을 주입해 «그 호출의 인자»를 직접 본다
//       ⇒ judgeAndFinalize 의 `${reviewerContext}` 를 지우면 «실패한다».
describe('review-loop 사람이 제공한 참고 자료 — 최종 심판 경로 배선', () => {
  test('심판 호출의 context 에 rework 지적과 사람 자료가 «둘 다» 실린다', async () => {
    const seen: Array<{ context: string }> = [];
    const context = prepareReviewLoopContext({ contextText: ['사람이 준 판단 근거'] });
    const result = await judgeAndFinalize(
      '100', 'branch', ['리뷰가 낸 지적'],
      // 심판이 rework 를 내면 부작용이 없다(코멘트·머지·승인 경로를 안 탄다).
      {
        // ⛔ runGh 를 주입하지 않으면 이 테스트가 «진짜» `gh pr diff 100` 을 친다(리뷰 should-fix ①).
        runGh: () => 'diff --git a/x b/x',
        judge: async (input): Promise<AcpJudgeResult> => { seen.push({ context: input.context ?? '' }); return { verdict: 'rework', asks: [], reason: '', raw: '' }; },
      },
      context.text, '/tmp', 1, false, 'light', [],
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.context).toContain('리뷰가 낸 지적');
    expect(seen[0]!.context).toContain('사람이 준 판단 근거');
    expect(result).toEqual({ rework: ['리뷰가 낸 지적'] });
  });

  test('심판 백엔드는 CLI → 설정 → 공유 기본값 순으로 전달하고 judge-start에 출처를 남긴다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const cases = [
        [{ judgeBackend: 'cli-backend', configuredJudgeBackend: 'config-backend' }, 'cli-backend', 'cli'],
        [{ configuredJudgeBackend: 'config-backend' }, 'config-backend', 'config'],
        [{}, 'codex', 'default'],
      ] as const;
      for (const [opts, backend, source] of cases) {
        let seenBackend: string | undefined;
        await judgeAndFinalize('100', 'branch', ['ask'], {
          ...opts,
          runGh: () => 'diff --git a/x b/x',
          judge: async (input): Promise<AcpJudgeResult> => {
            seenBackend = input.backend;
            return { verdict: 'rework', asks: [], reason: '', raw: '' };
          },
        }, '', '/tmp', 1, false, 'light', []);
        expect(seenBackend).toBe(backend);
        const start = [...log.mock.calls].reverse().find(([component, event]) => component === 'review-loop' && event === 'judge-start');
        expect(start?.[2]).toMatchObject({ judgeBackend: backend, judgeBackendSource: source });
      }
    } finally { log.mockRestore(); }
  });
});

// ⭐⭐ rework 백엔드 선택 — 「인자를 준 경우」와 「안 준 경우」가 «다른 값»으로 갈리는지.
//    ⛔ runMission 심을 주입해 «그 미션 호출의 spec.agent» 를 직접 본다 ⇒ runReworkMission 의
//       `agent: resolveBackend(choice.backend)` 를 지우면 이 테스트가 «실패한다»(spec.agent=undefined).
describe('review-loop rework 백엔드 선택', () => {
  const missionResult: AgentMissionResult = {
    ok: true, worktree: '/tmp/wt', branch: 'pr-branch', rounds: 1,
    evidencePath: null, committed: true, usedOmniCrawl: false, detail: 'ok',
  };

  test('rework 백엔드는 인자 → 설정 → 기본값 순으로 고르고 rework-start 에 출처를 남긴다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const cases = [
        [{ reworkBackend: 'claude' }, 'claude', 'cli'],
        [{ configuredReworkBackend: 'gemini' }, 'gemini', 'config'],
        [{}, 'codex', 'default'],
      ] as const;
      const chosen: string[] = [];
      const sources: unknown[] = [];
      for (const [opts, backend, source] of cases) {
        let seenAgent: string | undefined;
        const r = await runReworkMission('100', 'pr-branch', 'pr-branch', ['리뷰 지적'], {
          ...opts,
          runMission: async (spec: AgentMissionSpec): Promise<AgentMissionResult> => { seenAgent = spec.agent?.name; return missionResult; },
        }, '', 1);
        expect(r).toBe(missionResult);
        expect(seenAgent).toBe(backend);
        const start = [...log.mock.calls].reverse().find(([component, event]) => component === 'review-loop' && event === 'rework-start');
        expect(start?.[2]).toMatchObject({ pr: '100', round: 1, reworkBackend: backend, reworkBackendSource: source });
        chosen.push(seenAgent!);
        sources.push((start![2] as Record<string, unknown>).reworkBackendSource);
      }
      // 「인자를 준 경우 ≠ 안 준 경우」를 값으로 못 박는다(모집단 3·서로 다름).
      expect(new Set(chosen).size).toBe(3);
      expect(new Set(sources).size).toBe(3);
    } finally { log.mockRestore(); }
  });

  test('인자를 안 주면 미션 spec 이 지금과 같다(브랜치·base·evidence·라운드·commit)', async () => {
    let seen: AgentMissionSpec | undefined;
    await runReworkMission('100', 'pr-branch', 'rework-branch', ['리뷰 지적'], {
      runMission: async (spec: AgentMissionSpec): Promise<AgentMissionResult> => { seen = spec; return missionResult; },
    }, '\n사람 자료', 2);
    expect(seen).toMatchObject({ branch: 'rework-branch', base: 'pr-branch', evidence: { kind: 'tsc' }, maxRounds: 14, commit: true });
    expect(seen?.agent?.name).toBe('codex');
    expect(seen?.screensDir).toBeUndefined();
    expect(seen?.mission).toContain('리뷰 지적');
    expect(seen?.mission).toContain('사람 자료');
  });

  test('미등록 백엔드는 조용히 codex 로 폴백하지 않고 명시 에러다', async () => {
    let called = false;
    let error: Error | undefined;
    try {
      await runReworkMission('100', 'pr-branch', 'pr-branch', ['ask'], {
        reworkBackend: 'no-such-backend',
        runMission: async (): Promise<AgentMissionResult> => { called = true; return missionResult; },
      }, '', 1);
    } catch (e) { error = e as Error; }
    expect(error?.message).toContain('no-such-backend');
    expect(called).toBe(false);
  });
});
