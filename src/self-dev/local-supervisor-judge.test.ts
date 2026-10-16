/**
 * 로컬 슈퍼바이저 판정부 시험 — 순수성(외부 호출 0 · 결정적 · 입력 불변)과
 * SupervisorStopReason 후보 전 커버 · 진동 분류 · 화면 관측 모양을 검증한다.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  LOCAL_JUDGE_CONVERGENCE_ORDER,
  LOCAL_JUDGE_OSCILLATION_ORDER,
  localSupervisorJudge,
} from './local-supervisor-judge.js';
import { SUPERVISOR_STOP_REASONS, type SupervisorStopReason } from './run-supervisor.js';

/** SUPERVISOR_STOP_REASONS 가 SupervisorStopReason 유니언 전체를 담는다 — 빠진 사유가 있으면 이 줄이 typecheck 에서 터진다. */
const stopReasonArrayCoversUnion: Exclude<SupervisorStopReason, typeof SUPERVISOR_STOP_REASONS[number]> extends never
  ? true
  : never = true;

describe('local-supervisor-judge — 후보 전 커버', () => {
  test('후보 배열이 SupervisorStopReason 유니언 전체를 담는다', () => {
    expect(stopReasonArrayCoversUnion).toBe(true);
  });

  test('SUPERVISOR_STOP_REASONS 의 모든 후보를 단독 후보로 고른다(신호 없으면 호출자 순위)', () => {
    for (const reason of SUPERVISOR_STOP_REASONS) {
      const verdict = localSupervisorJudge({ candidates: [reason] });
      expect(verdict.stopReason).toBe(reason);
      expect(verdict.decisionFragment.action).toBe('stop');
      expect(verdict.decisionFragment.stopReason).toBe(reason);
      expect(verdict.confidence).toBe(0.5);
    }
  });

  test('신호가 없으면 호출자 후보 순위의 첫 후보를 고른다', () => {
    expect(localSupervisorJudge({ candidates: [...SUPERVISOR_STOP_REASONS] }).stopReason).toBe(SUPERVISOR_STOP_REASONS[0]);
    expect(localSupervisorJudge({ candidates: ['no-progress', 'converged'] }).stopReason).toBe('no-progress');
  });

  test('판정은 항상 후보 안에서 · SUPERVISOR_STOP_REASONS 안에서 고른다', () => {
    const candidateSets = [
      ['converged'],
      ['converged', 'no-progress'],
      ['max-rounds'],
      ['human-stopped', 'parent-signals-red'],
      [...SUPERVISOR_STOP_REASONS],
    ] as readonly SupervisorStopReason[][];
    for (const candidates of candidateSets) {
      for (const screen of [
        undefined,
        { screenOutcome: 'complete' as const, screenTail: 'GOAL-COMPLETE', screenSpace: 's' },
        { screenOutcome: 'incomplete' as const },
        { screenOutcome: null },
      ]) {
        const verdict = localSupervisorJudge({ candidates, screen });
        if (verdict.determined) {
          expect(candidates).toContain(verdict.stopReason);
          expect(SUPERVISOR_STOP_REASONS).toContain(verdict.stopReason);
        } else {
          expect(verdict.stopReason).toBeUndefined();
          expect(verdict.decisionFragment.action).toBe('relaunch');
        }
      }
    }
  });
});

describe('local-supervisor-judge — 진동 분류', () => {
  test('rework trend=oscillating → review-oscillating 을 고른다', () => {
    const verdict = localSupervisorJudge({
      candidates: ['converged', 'review-oscillating'],
      rework: { runs: 3, trend: 'oscillating', signature: 'mustfix:1', lastReason: '같은 지적 반복' },
    });
    expect(verdict.stopReason).toBe('review-oscillating');
    expect(verdict.oscillating).toBe(true);
    expect(verdict.confidence).toBe(0.8);
    const signals = verdict.signals.join('\n');
    expect(signals).toContain('signal:oscillation');
    expect(signals).toContain('rework:trend=oscillating');
    expect(signals).toContain('rework:signature=mustfix:1');
    expect(signals).toContain('rework:runs=3');
  });

  test('진동 후보가 후보 목록에 없으면 신호만 남기고 첫 후보를 고른다', () => {
    const verdict = localSupervisorJudge({
      candidates: ['converged', 'no-progress'],
      rework: { trend: 'oscillating' },
    });
    expect(verdict.stopReason).toBe('converged');
    expect(verdict.oscillating).toBe(true);
    expect(verdict.signals.join('\n')).toContain('signal:oscillation');
  });

  test('walk 재방문과 현재 signature만으로는 반복 지적을 입증하지 않는다', () => {
    const verdict = localSupervisorJudge({
      candidates: ['no-progress', 'review-oscillating'],
      walk: [
        { node: 'implement', round: 0 },
        { node: 'review', round: 1 },
        { node: 'implement', round: 2 },
      ],
      rework: { runs: 2, trend: 'worsening', signature: 'mustfix:1' },
    });
    expect(verdict.stopReason).toBe('no-progress');
    expect(verdict.oscillating).toBe(false);
    expect(verdict.signals.join('\n')).toContain('walk:repeat:implementx2');
  });

  test('정상적인 다회차 노드 재방문만으로는 진동 판정을 내리지 않는다', () => {
    const walk = [{ node: 'implement', round: 0 }, { node: 'implement', round: 2 }];
    for (const rework of [undefined, { runs: 2, trend: 'improving' as const, signature: 'mustfix:1' }]) {
      const verdict = localSupervisorJudge({ candidates: ['no-progress', 'review-oscillating'], walk, rework });
      expect(verdict.stopReason).toBe('no-progress');
      expect(verdict.oscillating).toBe(false);
      expect(verdict.signals).toContain('walk:repeat:implementx2');
    }
  });

  test('같은 노드라도 같은 회차 반복 · 회차 번호 없는 항목은 진동이 아니다', () => {
    const sameRound = localSupervisorJudge({
      candidates: ['no-progress'],
      walk: [{ node: 'implement', round: 1 }, { node: 'implement', round: 1 }],
    });
    expect(sameRound.oscillating).toBe(false);
    const roundless = localSupervisorJudge({
      candidates: ['no-progress'],
      walk: [{ node: 'implement' }, { node: 'implement' }],
    });
    expect(roundless.oscillating).toBe(false);
  });

  test('improving · worsening 추이는 진동이 아니다', () => {
    for (const trend of ['improving', 'worsening'] as const) {
      const verdict = localSupervisorJudge({
        candidates: ['no-progress', 'review-oscillating'],
        rework: { trend },
      });
      expect(verdict.stopReason).toBe('no-progress');
      expect(verdict.oscillating).toBe(false);
    }
  });

  test('진동 사유 순위 상수 — review-oscillating 이 유일하다', () => {
    expect([...LOCAL_JUDGE_OSCILLATION_ORDER]).toEqual(['review-oscillating']);
  });
});

describe('local-supervisor-judge — 화면 관측 모양', () => {
  test('outcome=complete + GOAL-COMPLETE tail → 수렴 계열 강한 순(deliverable-merged 먼저)', () => {
    const verdict = localSupervisorJudge({
      candidates: ['converged', 'deliverable-merged'],
      screen: { screenOutcome: 'complete', screenTail: '… GOAL-COMPLETE', screenSpace: 'goal-1' },
    });
    expect(verdict.stopReason).toBe('deliverable-merged');
    expect(verdict.confidence).toBe(0.9);
    const signals = verdict.signals.join('\n');
    expect(signals).toContain('screen:complete');
    expect(signals).toContain('screen-tail:GOAL-COMPLETE');
    expect(signals).toContain('screen-space:goal-1');
    expect(signals).toContain('signal:completion');
  });

  test('지난 회차 GOAL-COMPLETE tail만으로 현재 회차의 완료를 인정하지 않는다', () => {
    const candidates = ['no-progress', 'converged'] as const;
    const stale = localSupervisorJudge({ candidates, screen: { screenTail: '지난 회차 GOAL-COMPLETE' } });
    const absent = localSupervisorJudge({ candidates, screen: {} });
    expect(stale.stopReason).toBe('no-progress');
    expect(stale.confidence).toBe(absent.confidence);
    expect(stale.signals).not.toContain('signal:completion');
  });

  test('outcome=complete 이고 tail 에 마커가 없어도 완료 신호다', () => {
    expect(localSupervisorJudge({
      candidates: ['converged'],
      screen: { screenOutcome: 'complete', screenTail: '완료·마커 없음' },
    }).stopReason).toBe('converged');
  });

  test('outcome=incomplete → 수렴 후보를 기각하고 남은 첫 후보를 고른다', () => {
    const verdict = localSupervisorJudge({
      candidates: ['converged', 'no-progress'],
      screen: { screenOutcome: 'incomplete' },
    });
    expect(verdict.stopReason).toBe('no-progress');
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.signals.join('\n')).toContain('screen:incomplete');
  });

  test('명시적 incomplete는 남아 있는 GOAL-COMPLETE tail보다 우선한다', () => {
    const verdict = localSupervisorJudge({
      candidates: ['converged', 'no-progress'],
      screen: { screenOutcome: 'incomplete', screenTail: '이전 회차 GOAL-COMPLETE' },
    });
    expect(verdict.stopReason).toBe('no-progress');
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.signals).toContain('screen:conflict-incomplete-over-tail');
    expect(verdict.signals).not.toContain('signal:completion');
  });

  test('outcome=incomplete 이고 후보가 전부 수렴 계열이면 종료 사유 없이 판단을 돌려준다', () => {
    const verdict = localSupervisorJudge({
      candidates: ['converged'],
      screen: { screenOutcome: 'incomplete' },
    });
    expect(verdict.determined).toBe(false);
    expect(verdict.stopReason).toBeUndefined();
    expect(verdict.decisionFragment.action).toBe('relaunch');
    expect(verdict.decisionFragment.stopReason).toBeUndefined();
    expect(verdict.signals).toContain('signal:undetermined');
    expect(verdict.confidence).toBe(0);
  });

  test('outcome=null · 화면 부재 → 신호 없음 fallback', () => {
    expect(localSupervisorJudge({ candidates: ['needs-human'], screen: { screenOutcome: null } }).stopReason)
      .toBe('needs-human');
    expect(localSupervisorJudge({ candidates: ['needs-human'] }).confidence).toBe(0.5);
  });

  test('수렴 순위 상수 — deliverable-merged 가 앞서고 converged 가 뒤에 온다', () => {
    expect([...LOCAL_JUDGE_CONVERGENCE_ORDER]).toEqual([
      'deliverable-merged',
      'harvestable-awaiting-human',
      'handed-off-to-salvage',
      'converged',
    ]);
  });
});

describe('local-supervisor-judge — 후보 검증', () => {
  test('빈 후보는 판정하지 않는다', () => {
    expect(() => localSupervisorJudge({ candidates: [] })).toThrow();
  });

  test('SUPERVISOR_STOP_REASONS 밖 후보는 거절한다', () => {
    expect(() => localSupervisorJudge({ candidates: ['bogus-reason' as SupervisorStopReason] })).toThrow();
  });
});

describe('local-supervisor-judge — 순수성(외부 호출 0)', () => {
  const source = readFileSync(new URL('./local-supervisor-judge.ts', import.meta.url).pathname, 'utf8');

  test('외부 호출 감시 뒤 동적 import와 실제 판정에서 호출 0', () => {
    const moduleUrl = new URL('./local-supervisor-judge.ts', import.meta.url).href;
    const probe = [
      'const calls = [];',
      'const forbid = (name) => () => { calls.push(name); throw new Error("unexpected external call: " + name); };',
      'globalThis.fetch = forbid("fetch"); Bun.spawn = forbid("Bun.spawn"); Bun.spawnSync = forbid("Bun.spawnSync");',
      'const child = require("node:child_process");',
      'for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[key] = forbid("child." + key);',
      'const http = require("node:http"); const https = require("node:https"); const net = require("node:net");',
      'http.request = forbid("http.request"); http.get = forbid("http.get"); https.request = forbid("https.request"); https.get = forbid("https.get"); net.connect = forbid("net.connect");',
      'require("node:module").syncBuiltinESMExports();',
      `const { localSupervisorJudge } = await import(${JSON.stringify(moduleUrl)});`,
      'const verdict = localSupervisorJudge({ candidates: ["no-progress", "review-oscillating"], rework: { trend: "worsening", runs: 2, signature: "new finding" }, walk: [{ node: "review", round: 1 }, { node: "review", round: 2 }] });',
      'console.log(JSON.stringify({ calls, stopReason: verdict.stopReason, oscillating: verdict.oscillating }));',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ calls: [], stopReason: 'no-progress', oscillating: false });
  });

  test('모듈 소스에 I/O · 외부 호출 · 시계 · 난수가 없다', () => {
    for (const banned of [
      /node:fs/, /node:child_process/, /node:net/, /node:http/, /node:https/, /node:crypto/, /node:dns/,
      /child_process/, /\bfetch\(/, /Bun\.spawn/, /\bexecSync\b/, /\bspawnSync\b/, /\bspawn\b/,
      /Date\.now/, /Math\.random/, /performance\.now/, /process\.env/, /process\.cwd/,
    ]) {
      expect(source).not.toMatch(banned);
    }
  });

  test('실행 값은 경량 run-types에서, 감독 결정 타입만 type-only로 읽는다', () => {
    expect(source).toContain("from './run-types.js'");
    expect(source).toContain("import type { SupervisorDecision } from './run-supervisor.js'");
    expect(source.match(/^import /gm)).toHaveLength(2);
  });

  test('같은 입력 → 같은 판정(결정적)', () => {
    const input = {
      candidates: ['converged', 'review-oscillating', 'no-progress'] as const,
      screen: { screenOutcome: 'complete' as const, screenTail: 'GOAL-COMPLETE', screenSpace: 's1' },
      walk: [{ node: 'implement', round: 0 }, { node: 'implement', round: 1 }],
      rework: { runs: 3, trend: 'oscillating' as const, signature: 'sig' },
    };
    const first = localSupervisorJudge(input);
    const second = localSupervisorJudge(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('입력을 훼손하지 않는다(불변)', () => {
    const input = {
      candidates: ['converged', 'no-progress'] as SupervisorStopReason[],
      screen: { screenOutcome: 'incomplete' as const, screenTail: 'x', screenSpace: 's' },
      walk: [{ node: 'review', round: 1 }],
      rework: { trend: 'worsening' as const, signature: 'sig' },
    };
    const before = structuredClone(input);
    localSupervisorJudge(input);
    expect(input).toEqual(before);
  });
});
