// PR 리뷰 standing 폴러(L3) 테스트 — 순수 판정 + :memory: db + 주입 gh/trigger.
// 실 gh 호출·실 머지 없이: dedup(이미 처리한 리뷰 재발동 안 함)·봇 skip(무한루프 방지)·
// maxTriggers cap·커서 갱신을 검증한다.
import { describe, test, expect, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  isBotSignal, pickLatestHumanSignal, pickLatestSignal, analyzeSignals, openPrReviewWatchDb, getLastReviewKey, setLastReviewKey,
  runPrReviewWatchCycle, fetchLabeledOpenPrs, fetchLatestSignal, fetchSignalAnalysis, ReviewWatchGhError, mapReviewToInjected, type RunGh,
} from './pr-review-watch.js';
import type { ReviewLoopOpts, ReviewLoopResult } from './review-loop.js';
import { runAutoInitialReview, type AutoInitialReviewerDeps } from '../index.js';

describe('isBotSignal (무한루프 방지)', () => {
  test('봇 계정 → true', () => {
    expect(isBotSignal('github-actions[bot]', '아무 내용')).toBe(true);
  });
  test('review-loop 자동 코멘트 마커(✅) → true (gh 인증 계정이 남겨도 마커로 걸림)', () => {
    expect(isBotSignal('ElanvitalAI', '✅ 리뷰 보강 자동 반영(codex-in-elanous)')).toBe(true);
    expect(isBotSignal('ElanvitalAI', '🔁 ACP 최종심판: REWORK')).toBe(true);
  });
  test('사람 보강 요청(마커 없음) → false', () => {
    expect(isBotSignal('ElanvitalAI', '보강 요청 — 관측성 렌즈로 점검했습니다.')).toBe(false);
  });
  test('renderReview의 FAIL 헤드라인 코멘트 → true', () => {
    expect(isBotSignal('ElanvitalAI', '⛔ 자율 PR 리뷰: FAIL\n- 미배선')).toBe(true);
  });
  test('같은 아이콘으로 시작하는 사람 코멘트는 헤드라인이 아니면 false', () => {
    expect(isBotSignal('alice', '⛔ 이 변경은 위험하니 다시 검토해주세요.')).toBe(false);
  });
  test('review mode는 self-approval만 걸러 인간 아이콘 리뷰를 보존한다', () => {
    expect(isBotSignal('alice', '⚠️ 변경 요청: 경계 조건을 보강하세요.', 'review')).toBe(false);
    expect(isBotSignal('bob', '✅ LGTM, 다만 후속 작업을 남깁니다.', 'review')).toBe(false);
    expect(isBotSignal('ElanvitalAI', '✅ 자동 리뷰 승인(LGTM): 깨끗합니다.', 'review')).toBe(true);
  });
  test('사람 CHANGES_REQUESTED 경고 리뷰는 review mode에서 선택한다', () => {
    const raw = {
      reviews: [{ body: '⚠️ FAIL: 보강이 필요합니다', author: { login: 'ElanvitalAI' }, submittedAt: '2026-07-22T10:00:00Z' }],
    };
    expect(pickLatestHumanSignal(raw)?.key).toBe('2026-07-22T10:00:00Z');
    expect(pickLatestSignal(raw)?.isHuman).toBe(true);
  });
});

describe('pickLatestSignal (최신 신호 선택)', () => {
  test('리뷰/코멘트 중 최신(newest) 1개 · 사람 판정', () => {
    const sig = pickLatestSignal({
      reviews: [{ body: '보강 요청', author: { login: 'ElanvitalAI' }, submittedAt: '2026-07-22T10:00:00Z' }],
      comments: [{ body: '✅ 자동 반영', author: { login: 'ElanvitalAI' }, createdAt: '2026-07-22T09:00:00Z' }],
    });
    // 리뷰(10:00)가 코멘트(09:00)보다 최신 → 리뷰 선택, 사람.
    expect(sig?.key).toBe('2026-07-22T10:00:00Z');
    expect(sig?.isHuman).toBe(true);
  });
  test('최신이 봇 자동 코멘트면 isHuman=false', () => {
    const sig = pickLatestSignal({
      reviews: [{ body: '보강 요청', author: { login: 'ElanvitalAI' }, submittedAt: '2026-07-22T10:00:00Z' }],
      comments: [{ body: '✅ 자동 반영', author: { login: 'ElanvitalAI' }, createdAt: '2026-07-22T11:00:00Z' }],
    });
    expect(sig?.key).toBe('2026-07-22T11:00:00Z');
    expect(sig?.isHuman).toBe(false);
  });
  test('본문 없는 신호 무시 · 아무것도 없으면 null', () => {
    expect(pickLatestSignal({ reviews: [{ body: '  ', submittedAt: 'x' }], comments: [] })).toBeNull();
    expect(pickLatestSignal({})).toBeNull();
  });
});

describe('pr_review_state 커서', () => {
  test('set → get 왕복', () => {
    const db = openPrReviewWatchDb(':memory:');
    expect(getLastReviewKey(db, '100')).toBeNull();
    setLastReviewKey(db, '100', '2026-07-22T10:00:00Z', 'now');
    expect(getLastReviewKey(db, '100')).toBe('2026-07-22T10:00:00Z');
    db.close();
  });
});

// ── 사이클: gh/trigger 주입으로 실 IO 없이 검증 ──
function mkGh(prs: number[], signals: Record<string, { body: string; author: string; key: string; kind: 'review' | 'comment' }>): RunGh {
  return (args: string[]): string => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify(prs.map(n => ({ number: n })));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = args[2]!;
      const s = signals[pr];
      if (!s) return JSON.stringify({ reviews: [], comments: [] });
      const entry = { body: s.body, author: { login: s.author } };
      return s.kind === 'review'
        ? JSON.stringify({ reviews: [{ ...entry, submittedAt: s.key }], comments: [] })
        : JSON.stringify({ reviews: [], comments: [{ ...entry, createdAt: s.key }] });
    }
    return '[]';
  };
}

function mkTrigger(calls: string[]): (pr: string, opts: ReviewLoopOpts) => Promise<ReviewLoopResult | null> {
  return async (pr) => {
    calls.push(pr);
    return { pr, branch: 'b', verdict: 'reinforce', asks: [], action: 'reworked', detail: 'stub' };
  };
}

describe('runPrReviewWatchCycle', () => {
  test('목록 조회 인증 실패는 kind를 관측하고 분류된 오류를 던지며 사이클 실패로 기록한다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const calls: string[] = [];
    const gh: RunGh = () => { throw new Error('HTTP 401: Bad credentials'); };
    try {
      expect(() => fetchLabeledOpenPrs('auto-review', { runGh: gh })).toThrow(ReviewWatchGhError);
      await expect(runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls) })).rejects.toMatchObject({ kind: 'auth' });
      expect(calls).toEqual([]);
      expect(log.mock.calls.find(([, event]) => event === 'list-prs-error')?.[2]).toMatchObject({ label: 'auto-review', kind: 'auth' });
      const failed = log.mock.calls.find(([, event]) => event === 'cycle-failed')?.[2];
      expect(failed).toMatchObject({ label: 'auto-review', error: 'auth' });
      expect(failed).not.toHaveProperty('scanned');
      expect(log.mock.calls.some(([, event]) => event === 'cycle-done')).toBe(false);
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  test('정상적인 빈 목록은 실패가 아니며 기존 cycle-done scanned=0을 남긴다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(fetchLabeledOpenPrs('auto-review', { runGh: mkGh([], {}) })).toEqual([]);
      const out = await runPrReviewWatchCycle({ db, runGh: mkGh([], {}) });
      expect(out).toHaveLength(0);
      expect(out.authErrors).toBe(0);
      expect(log.mock.calls.find(([, event]) => event === 'cycle-done')?.[2]).toMatchObject({ scanned: 0, triggered: 0 });
      expect(log.mock.calls.some(([, event]) => event === 'cycle-failed')).toBe(false);
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  test('한 PR의 신호 조회만 401이면 signal-error로 격리하고 다른 PR은 계속 처리한다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const initialCalls: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const healthy = mkGh([100, 101], { '101': { body: '보강 요청', author: 'reviewer', key: 't1', kind: 'review' } });
    const gh: RunGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '100') throw new Error('HTTP 401: Bad credentials');
      return healthy(args);
    };
    try {
      expect(fetchLatestSignal('100', { runGh: gh })).toBeNull();
      expect(() => fetchSignalAnalysis('100', { runGh: gh })).toThrow(ReviewWatchGhError);
      expect(fetchLatestSignal('101', { runGh: gh })?.key).toBe('t1');
      expect(fetchSignalAnalysis('101', { runGh: gh }).latestHuman?.key).toBe('t1');
      const out = await runPrReviewWatchCycle({
        db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now',
        autoInitialReview: true,
        initialReviewer: async (pr) => { initialCalls.push(pr); return { verdict: 'ok', asks: [] }; },
      });
      expect(out.map(o => ({ pr: o.pr, status: o.status }))).toEqual([
        { pr: '100', status: 'signal-error' }, { pr: '101', status: 'triggered' },
      ]);
      expect(out[0]!.error).toBe('auth');
      expect(out.authErrors).toBe(1);
      expect(calls).toEqual(['101']);
      expect(initialCalls).toEqual([]);
      expect(getLastReviewKey(db, '100')).toBeNull();
      expect(getLastReviewKey(db, '101')).toBe('t1');
      expect(log.mock.calls.find(([, event]) => event === 'signal-error')?.[2]).toMatchObject({ pr: '100', kind: 'auth' });
      expect(log.mock.calls.find(([, event]) => event === 'cycle-done')?.[2]).toMatchObject({ scanned: 2, triggered: 1, authErrors: 1 });
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  test('인증 이외의 PR 신호 조회 실패는 authErrors에 더하지 않고 나머지 PR을 계속 처리한다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const healthy = mkGh([100, 101], { '101': { body: '보강 요청', author: 'reviewer', key: 't1', kind: 'review' } });
    const gh: RunGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '100') throw new Error('HTTP 404: Not Found');
      return healthy(args);
    };
    try {
      const out = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls) });
      expect(out[0]).toEqual({ pr: '100', status: 'signal-error', error: 'not-found' });
      expect(out[1]!.status).toBe('triggered');
      expect(out.authErrors).toBe(0);
      expect(calls).toEqual(['101']);
      expect(getLastReviewKey(db, '100')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('새 사람 리뷰 → 발동 + 커서 갱신', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const gh = mkGh([100], { '100': { body: '보강 요청', author: 'ElanvitalAI', key: 't1', kind: 'review' } });
    const out = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now' });
    expect(calls).toEqual(['100']);
    expect(out[0]!.status).toBe('triggered');
    expect(getLastReviewKey(db, '100')).toBe('t1');
    db.close();
  });

  test('사람 리뷰 발동은 받은 context 옵션을 바꾸지 않고 전달한다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const received: ReviewLoopOpts[] = [];
    const gh = mkGh([100], { '100': { body: '보강 요청', author: 'reviewer', key: 't1', kind: 'review' } });
    const reviewLoopOpts: ReviewLoopOpts = { contextOrder: [{ kind: 'text', value: '사람의 판단 근거' }] };
    await runPrReviewWatchCycle({
      db, runGh: gh, reviewLoopOpts, now: () => 'now',
      trigger: async (_pr, opts) => {
        received.push(opts);
        return { pr: '100', branch: 'b', verdict: 'ok', asks: [], action: 'approved', detail: '' };
      },
    });
    expect(received).toEqual([reviewLoopOpts]);
    db.close();
  });

  test('CLI rework backend는 trigger에 리터럴 값으로 전달되고 config보다 우선한다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const received: ReviewLoopOpts[] = [];
    const gh = mkGh([100], { '100': { body: '보강 요청', author: 'reviewer', key: 't1', kind: 'review' } });
    await runPrReviewWatchCycle({
      db, runGh: gh, now: () => 'now',
      reviewLoopOpts: { reworkBackend: 'claude', configuredReworkBackend: 'gemini' },
      trigger: async (_pr, opts) => {
        received.push(opts);
        return { pr: '100', branch: 'b', verdict: 'ok', asks: [], action: 'approved', detail: '' };
      },
    });
    expect(received).toEqual([{ reworkBackend: 'claude', configuredReworkBackend: 'gemini' }]);
    db.close();
  });

  test('config rework backend만 있으면 trigger에 그대로 전달한다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const received: ReviewLoopOpts[] = [];
    const gh = mkGh([100], { '100': { body: '보강 요청', author: 'reviewer', key: 't1', kind: 'review' } });
    await runPrReviewWatchCycle({
      db, runGh: gh, now: () => 'now',
      reviewLoopOpts: { configuredReworkBackend: 'gemini' },
      trigger: async (_pr, opts) => {
        received.push(opts);
        return { pr: '100', branch: 'b', verdict: 'ok', asks: [], action: 'approved', detail: '' };
      },
    });
    expect(received).toEqual([{ configuredReworkBackend: 'gemini' }]);
    db.close();
  });

  test('PR이 0건이어도 cycle-start에 선택된 rework backend와 출처를 남긴다', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runPrReviewWatchCycle({
        db, runGh: mkGh([], {}),
        reviewLoopOpts: { reworkBackend: 'claude', configuredReworkBackend: 'gemini' },
      });
      const call = log.mock.calls.find(([component, event]) => component === 'review-watch' && event === 'cycle-start');
      expect(call).toBeDefined();
      expect(call![2]).toEqual({
        label: 'auto-review', prs: 0, maxTriggers: 1,
        reworkBackend: 'claude', reworkBackendSource: 'cli',
      });
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  test('같은 리뷰 두 번째 사이클 → dedup(재발동 안 함)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const gh = mkGh([100], { '100': { body: '보강 요청', author: 'ElanvitalAI', key: 't1', kind: 'review' } });
    await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now' });
    const out2 = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now' });
    expect(calls).toEqual(['100']); // 한 번만
    expect(out2[0]!.status).toBe('dedup');
    db.close();
  });

  test('최신이 봇 자동 코멘트 → skip(무한루프 방지)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const gh = mkGh([100], { '100': { body: '✅ 리뷰 보강 자동 반영', author: 'ElanvitalAI', key: 't2', kind: 'comment' } });
    const out = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now' });
    expect(calls).toEqual([]);
    expect(out[0]!.status).toBe('bot');
    db.close();
  });

  test('maxTriggers=1 → 여러 PR 새 리뷰라도 1건만 발동, 나머지 capped', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const gh = mkGh([100, 101], {
      '100': { body: '보강 요청 A', author: 'ElanvitalAI', key: 't1', kind: 'review' },
      '101': { body: '보강 요청 B', author: 'ElanvitalAI', key: 't1', kind: 'review' },
    });
    const out = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now', maxTriggers: 1 });
    expect(calls.length).toBe(1);
    expect(out.filter(o => o.status === 'triggered').length).toBe(1);
    expect(out.filter(o => o.status === 'capped').length).toBe(1);
    // capped PR 은 커서 안 건드림 → 다음 사이클에 발동 가능.
    const cappedPr = out.find(o => o.status === 'capped')!.pr;
    expect(getLastReviewKey(db, cappedPr)).toBeNull();
    db.close();
  });

  test('새 사람 리뷰(새 key) → 재발동', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const calls: string[] = [];
    const gh1 = mkGh([100], { '100': { body: '보강 요청 1차', author: 'ElanvitalAI', key: 't1', kind: 'review' } });
    await runPrReviewWatchCycle({ db, runGh: gh1, trigger: mkTrigger(calls), now: () => 'now' });
    const gh2 = mkGh([100], { '100': { body: '보강 요청 2차', author: 'ElanvitalAI', key: 't2', kind: 'review' } });
    await runPrReviewWatchCycle({ db, runGh: gh2, trigger: mkTrigger(calls), now: () => 'now' });
    expect(calls).toEqual(['100', '100']); // 두 번(새 리뷰마다)
    expect(getLastReviewKey(db, '100')).toBe('t2');
    db.close();
  });
});

describe('mapReviewToInjected — 1차 리뷰 → injectedReview', () => {
  test('fail → reinforce(mustFix), REQUIREMENTS는 재작업 asks에 영향을 주지 않는다', () => {
    const withoutRequirements = mapReviewToInjected({ verdict: 'fail', mustFix: ['x를 고쳐라'], shouldFix: [], reviewed: true });
    const withRequirements = mapReviewToInjected({
      verdict: 'fail', mustFix: ['x를 고쳐라'], shouldFix: [], reviewed: true,
      requirements: ['src/index.ts 의 5930행 주변을 보아야 소비 경로를 판정할 수 있다'],
    });
    expect(withRequirements).toEqual({ verdict: 'reinforce', asks: ['x를 고쳐라'] });
    expect(withRequirements).toEqual(withoutRequirements);
  });
  test('pass → ok', () => {
    expect(mapReviewToInjected({ verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true }))
      .toEqual({ verdict: 'ok', asks: [] });
  });
  test('warn(shouldFix만) → ok(clean·머지 허용)', () => {
    expect(mapReviewToInjected({ verdict: 'warn', mustFix: [], shouldFix: ['개선 권고'], reviewed: true }))
      .toEqual({ verdict: 'ok', asks: [] });
  });
});

describe('자동 초기리뷰어 — 리뷰 없는 라벨 PR', () => {
  test('리뷰 없음 + autoInitialReview → 1차 리뷰 발동(injectedReview 주입)·커서 세팅', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh = mkGh([100], {}); // signals 없음 → fetchLatestSignal null(리뷰 없음)
    const injected: Array<{ verdict: string; asks: string[] } | undefined> = [];
    const trigger = async (_pr: string, opts: { injectedReview?: { verdict: string; asks: string[] } }) => {
      injected.push(opts.injectedReview);
      return { pr: '100', branch: 'b', verdict: 'ok' as const, asks: [], action: 'approved' as const, detail: '' };
    };
    const out = await runPrReviewWatchCycle({
      db, runGh: gh, trigger, now: () => 'now',
      autoInitialReview: true,
      initialReviewer: async () => ({ verdict: 'reinforce', asks: ['보강해라'] }),
    });
    expect(out[0]!.status).toBe('triggered');
    expect(injected[0]).toEqual({ verdict: 'reinforce', asks: ['보강해라'] }); // injectedReview 전달됨
    expect(getLastReviewKey(db, '100')).toBe('initial:now'); // 재초기리뷰 방지 커서
    db.close();
  });

  test('autoInitialReview off → 리뷰 없으면 그냥 none(초기리뷰 안 함)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh = mkGh([100], {});
    const calls: string[] = [];
    const out = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now' });
    expect(out[0]!.status).toBe('none');
    expect(calls).toEqual([]);
    db.close();
  });

  test('초기리뷰어가 null(리뷰 실패) → 발동 안 함·실패 상태와 관측을 남기고 커서는 그대로 둠', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh = mkGh([100], {});
    const calls: string[] = [];
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'review-watch') events.push(event);
    }) as never);
    try {
      const out = await runPrReviewWatchCycle({
        db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now',
        autoInitialReview: true, initialReviewer: async () => null,
      });
      expect(out[0]!.status).toBe('initial-review-failed');
      expect(events).toContain('initial-review-start');
      expect(events).toContain('initial-review-null');
      expect(calls).toEqual([]);
      expect(getLastReviewKey(db, '100')).toBeNull();
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  test('초기리뷰어 예외 → error 상태와 관측만 남기고 null 관측·발동·커서는 보존함', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh = mkGh([100], {});
    const calls: string[] = [];
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'review-watch') events.push(event);
    }) as never);
    try {
      const out = await runPrReviewWatchCycle({
        db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now',
        autoInitialReview: true, initialReviewer: async () => { throw new Error('reviewer unavailable'); },
      });
      expect(out[0]!.status).toBe('initial-review-error');
      expect(events).toContain('initial-review-start');
      expect(events).toContain('initial-review-error');
      expect(events).not.toContain('initial-review-null');
      expect(calls).toEqual([]);
      expect(getLastReviewKey(db, '100')).toBeNull();
    } finally {
      log.mockRestore();
      db.close();
    }
  });

  test('★근본수리: 봇/자기 자동 신호만 있고 사람 리뷰 없음 + autoInitialReview → 1차 리뷰 발동(skip-bot 아님·person-0)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    // self-dev PR: 자기 계정(ElanvitalAI)이 남긴 자동 코멘트(마커) → 봇 신호. 사람 리뷰는 없음.
    //   이전엔 sig 가 존재해 auto-initial 을 스킵하고 skip-bot('bot') 으로 죽어 영영 리뷰 안 됨.
    const gh = mkGh([100], { '100': { body: '✅ 내부 리뷰 자동 반영', author: 'ElanvitalAI', key: 't2', kind: 'comment' } });
    const injected: Array<{ verdict: string; asks: string[] } | undefined> = [];
    const trigger = async (_pr: string, opts: { injectedReview?: { verdict: string; asks: string[] } }) => {
      injected.push(opts.injectedReview);
      return { pr: '100', branch: 'b', verdict: 'ok' as const, asks: [], action: 'approved' as const, detail: '' };
    };
    const out = await runPrReviewWatchCycle({
      db, runGh: gh, trigger, now: () => 'now',
      autoInitialReview: true,
      initialReviewer: async () => ({ verdict: 'reinforce', asks: ['보강해라'] }),
    });
    expect(out[0]!.status).toBe('triggered'); // 근본수리 전엔 'bot' 으로 죽었음
    expect(injected[0]).toEqual({ verdict: 'reinforce', asks: ['보강해라'] });
    expect(getLastReviewKey(db, '100')).toBe('initial:now');
    db.close();
  });

  test('초기리뷰 발동 후 자기 자동 코멘트가 최신이어도 재초기리뷰 안 함(커서 dedup)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh = mkGh([100], { '100': { body: '🔁 rework 자동 반영', author: 'ElanvitalAI', key: 't3', kind: 'comment' } });
    const calls: string[] = [];
    setLastReviewKey(db, '100', 'initial:prev', 'prev'); // 직전 사이클에서 이미 초기리뷰 발동
    const out = await runPrReviewWatchCycle({
      db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now',
      autoInitialReview: true, initialReviewer: async () => ({ verdict: 'reinforce', asks: ['x'] }),
    });
    expect(out[0]!.status).toBe('dedup');
    expect(calls).toEqual([]); // 재발동 안 함
    db.close();
  });

  test('봇 신호 + autoInitialReview off → 기존대로 skip-bot(bot)·회귀 없음', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh = mkGh([100], { '100': { body: '✅ 자동 코멘트', author: 'ElanvitalAI', key: 't2', kind: 'comment' } });
    const calls: string[] = [];
    const out = await runPrReviewWatchCycle({ db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now' });
    expect(out[0]!.status).toBe('bot');
    expect(calls).toEqual([]);
    db.close();
  });

  test('★dead-end 방지(리뷰어 지적): 미처리 사람 리뷰(t1)+최신 봇 코멘트(t2)·커서 비어있음 → 사람 리뷰 발동(봇 무시)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh: RunGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 100 }]);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
        reviews: [{ body: '사람 보강 요청', author: { login: 'human-reviewer' }, submittedAt: 't1' }],
        comments: [{ body: '🔁 rework 자동 반영', author: { login: 'ElanvitalAI' }, createdAt: 't2' }],
      });
      return '[]';
    };
    const calls: string[] = [];
    const out = await runPrReviewWatchCycle({
      db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now',
      autoInitialReview: true, initialReviewer: async () => ({ verdict: 'reinforce', asks: ['x'] }),
    });
    expect(out[0]!.status).toBe('triggered'); // 미처리 사람 리뷰 t1 을 발동(최신 봇 t2 무시)
    expect(out[0]!.reviewKey).toBe('t1');
    expect(calls).toEqual(['100']);
    expect(getLastReviewKey(db, '100')).toBe('t1'); // 사람 신호 키로 커서 갱신
    db.close();
  });

  test('사람 리뷰 처리 완료(t1==cursor) 후 최신 봇 코멘트만 → dedup(재발동 안 함)', async () => {
    const db = openPrReviewWatchDb(':memory:');
    setLastReviewKey(db, '100', 't1', 'prev'); // 사람 리뷰 t1 이미 처리
    const gh: RunGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 100 }]);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
        reviews: [{ body: '사람 보강 요청', author: { login: 'human-reviewer' }, submittedAt: 't1' }],
        comments: [{ body: '🔁 rework 자동 반영', author: { login: 'ElanvitalAI' }, createdAt: 't2' }],
      });
      return '[]';
    };
    const calls: string[] = [];
    const out = await runPrReviewWatchCycle({
      db, runGh: gh, trigger: mkTrigger(calls), now: () => 'now',
      autoInitialReview: true, initialReviewer: async () => ({ verdict: 'reinforce', asks: ['x'] }),
    });
    expect(out[0]!.status).toBe('dedup'); // 사람 리뷰 이미 처리 → 봇 신호는 건너뜀
    expect(calls).toEqual([]);
    db.close();
  });

  test('★무본문 사람 리뷰(APPROVE/REQUEST_CHANGES)도 사람 신호로 인정 → 초기리뷰 아닌 일반 발동', async () => {
    const db = openPrReviewWatchDb(':memory:');
    const gh: RunGh = (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 100 }]);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
        reviews: [{ body: '', author: { login: 'human-reviewer' }, submittedAt: 't1' }], // 무본문 승인/변경요청
        comments: [],
      });
      return '[]';
    };
    const calls: string[] = [];
    let injectedSeen = false;
    const trigger = async (pr: string, opts: { injectedReview?: { verdict: string; asks: string[] } }) => {
      calls.push(pr); if (opts.injectedReview) injectedSeen = true;
      return { pr, branch: 'b', verdict: 'ok' as const, asks: [], action: 'approved' as const, detail: '' };
    };
    const out = await runPrReviewWatchCycle({
      db, runGh: gh, trigger, now: () => 'now',
      autoInitialReview: true, initialReviewer: async () => ({ verdict: 'reinforce', asks: ['x'] }),
    });
    expect(out[0]!.status).toBe('triggered'); // 사람 신호 인정 → 발동
    expect(calls).toEqual(['100']);
    expect(injectedSeen).toBe(false); // 초기리뷰(injectedReview) 아님 — 실제 사람 리뷰 경로
    expect(getLastReviewKey(db, '100')).toBe('t1');
    db.close();
  });
});

describe('analyzeSignals.latestHuman — 트리거 판정 기준(봇 신호 무시)', () => {
  test('무본문 사람 리뷰 → latestHuman 인정', () => {
    expect(analyzeSignals({ reviews: [{ body: '', author: { login: 'alice' }, submittedAt: 't1' }] }).latestHuman?.key).toBe('t1');
  });
  test('봇 계정 무본문 리뷰 → null', () => {
    expect(analyzeSignals({ reviews: [{ body: '', author: { login: 'github-actions[bot]' }, submittedAt: 't1' }] }).latestHuman).toBeNull();
  });
  test('자기 계정 자동마커 코멘트 → null(self-dev 봇 신호)', () => {
    expect(analyzeSignals({ comments: [{ body: '✅ 자동 반영', author: { login: 'ElanvitalAI' }, createdAt: 't1' }] }).latestHuman).toBeNull();
  });
  test('본문 있는 사람 코멘트 → latestHuman 인정', () => {
    expect(analyzeSignals({ comments: [{ body: '이거 고쳐요', author: { login: 'bob' }, createdAt: 't1' }] }).latestHuman?.key).toBe('t1');
  });
  test('무본문 코멘트만 → null(코멘트는 본문 필요)', () => {
    expect(analyzeSignals({ comments: [{ body: '', author: { login: 'bob' }, createdAt: 't1' }] }).latestHuman).toBeNull();
  });
  test('사람 리뷰(t1) + 최신 봇 코멘트(t2) → latestHuman=t1(봇 무시)', () => {
    expect(analyzeSignals({
      reviews: [{ body: '사람', author: { login: 'alice' }, submittedAt: 't1' }],
      comments: [{ body: '🔁 자동', author: { login: 'ElanvitalAI' }, createdAt: 't2' }],
    }).latestHuman?.key).toBe('t1');
  });
  test('자율 FAIL 코멘트는 건너뛰어 뒤의 사람 코멘트를 앞지르지 못한다', () => {
    expect(analyzeSignals({
      comments: [
        { body: '사람 보강 요청', author: { login: 'alice' }, createdAt: 't1' },
        { body: '⛔ 자율 PR 리뷰: FAIL\n- 미배선', author: { login: 'ElanvitalAI' }, createdAt: 't2' },
      ],
    }).latestHuman?.key).toBe('t1');
  });
});

function autoInitialReviewHarness(overrides: Partial<AutoInitialReviewerDeps> = {}) {
  const reviewInputs: Array<{ prDiff: string; phaseIntent: string; acceptance?: string }> = [];
  const observations: Array<{ event: string; data: Record<string, unknown> }> = [];
  const lookups: number[] = [];
  const deps: AutoInitialReviewerDeps = {
    reviewPullRequest: async (input) => {
      reviewInputs.push(input);
      return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true };
    },
    reviewDiffBudgetObservation: () => ({}),
    mapReviewToInjected,
    log: (_category, event, data) => { observations.push({ event, data: data ?? {} }); },
    execFileSync: (file, args) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'diff') return 'diff --git a/x b/x\n+ok\n';
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') return 'title';
      return '';
    },
    lookupPrGoalAcceptance: (prNumber) => {
      lookups.push(prNumber);
      return { goalLoaded: false, acceptanceChars: 0 };
    },
    ...overrides,
  };
  return { deps, reviewInputs, observations, lookups };
}

describe('auto-initial-review 골 판정 신호', () => {
  test('유효한 PR 번호는 공용 조회를 재사용하고 acceptance 가 있을 때만 싣는다', async () => {
    const acceptance = '조건 = bun test src/agent-mission/pr-review-watch.test.ts; 관측 = goalLoaded; 기대 = true';
    const lookups: number[] = [];
    const h = autoInitialReviewHarness({
      lookupPrGoalAcceptance: (prNumber) => {
        lookups.push(prNumber);
        return { acceptance, goalLoaded: true, acceptanceChars: acceptance.length };
      },
    });
    const out = await runAutoInitialReview('14092', async () => 'VERDICT: PASS', h.deps);
    expect(out).toEqual({ verdict: 'ok', asks: [] });
    expect(lookups).toEqual([14092]);
    expect(h.reviewInputs).toHaveLength(1);
    expect(h.reviewInputs[0]!.acceptance).toBe(acceptance);
    expect(h.observations.find(e => e.event === 'review.done')!.data).toMatchObject({
      source: 'auto-initial-review',
      goalLoaded: true,
      acceptanceChars: acceptance.length,
    });
  });

  test('원장에 없는 PR 은 골을 지어내지 않고 미적재 상태를 관측한다', async () => {
    const h = autoInitialReviewHarness();
    await runAutoInitialReview('999999', async () => 'VERDICT: PASS', h.deps);
    expect(h.lookups).toEqual([999999]);
    expect(Object.keys(h.reviewInputs[0]!)).not.toContain('acceptance');
    expect(h.reviewInputs[0]!).not.toHaveProperty('acceptance');
    expect(h.observations.find(e => e.event === 'review.done')!.data).toMatchObject({
      goalLoaded: false,
      acceptanceChars: 0,
    });
  });

  test('정수가 아닌 PR 문자열은 조회를 안 하고 acceptance 키를 안 싣는다', async () => {
    const h = autoInitialReviewHarness();
    const out = await runAutoInitialReview('not-a-pr', async () => 'VERDICT: PASS', h.deps);
    expect(out).toEqual({ verdict: 'ok', asks: [] });
    expect(h.lookups).toEqual([]);
    expect(Object.keys(h.reviewInputs[0]!)).not.toContain('acceptance');
    expect(h.reviewInputs[0]!).not.toHaveProperty('acceptance');
    expect(h.observations.find(e => e.event === 'review.done')!.data).toMatchObject({
      goalLoaded: false,
      acceptanceChars: 0,
    });
  });

  test('조회 실패가 감시를 막지 않는다 — 리뷰어는 끝까지 돌고 fail-soft 한다', async () => {
    const h = autoInitialReviewHarness({
      lookupPrGoalAcceptance: () => { throw new Error('ledger lookup failed'); },
    });
    const out = await runAutoInitialReview('5502', async () => 'VERDICT: PASS', h.deps);
    expect(out).toEqual({ verdict: 'ok', asks: [] });
    expect(h.reviewInputs).toHaveLength(1);
    expect(h.reviewInputs[0]!).not.toHaveProperty('acceptance');
    expect(h.observations.find(e => e.event === 'review.done')!.data).toMatchObject({
      goalLoaded: false,
      acceptanceChars: 0,
      reviewed: true,
    });
  });

  test('찾은 경우와 못 찾은 경우 모두 review.done 에 goalLoaded 와 acceptanceChars 가 있다', async () => {
    const loaded = autoInitialReviewHarness({
      lookupPrGoalAcceptance: () => ({ acceptance: '판정', goalLoaded: true, acceptanceChars: 2 }),
    });
    const missing = autoInitialReviewHarness();
    await runAutoInitialReview('1', async () => 'ok', loaded.deps);
    await runAutoInitialReview('2', async () => 'ok', missing.deps);
    for (const h of [loaded, missing]) {
      const payload = h.observations.find(e => e.event === 'review.done')!.data;
      expect(Object.keys(payload)).toEqual(expect.arrayContaining(['goalLoaded', 'acceptanceChars']));
      expect(payload).toHaveProperty('goalLoaded');
      expect(payload).toHaveProperty('acceptanceChars');
    }
  });
});
