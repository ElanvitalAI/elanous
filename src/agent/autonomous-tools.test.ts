// turn 조립기 통일 Phase 1 — 자율tool 조립기 골든룰 스냅샷 가드.
//
// 골든룰: 추출(makeElanousAgentRunTurn 인라인 → autonomous-tools 헬퍼) 전후 spec 이름배열 diff=0.
// 종전 telegram 인라인 조립은 `[delegateSpec, …(nest? []: [SelfImplement, RunDevHarness, SolveMission])]`
// 였다 — 여기서 그 이름배열을 못박아 회귀를 막는다(nest-cap off = 테스트 기본 프로세스).

import { describe, test, expect } from 'bun:test';
import type { DaemonToolDispatchCtx } from '../boot/daemon-tools/types.js';
import { dispatchSelfImplement, type SelfImplementRunner } from '../boot/daemon-tools/self-implement.js';
import {
  buildAutonomousToolSpecs,
  isAutonomousTool,
  AUTONOMOUS_TOOL_NAMES,
  delegateBackendToSlashKey,
  dispatchAutonomousTool,
} from './autonomous-tools.js';

describe('autonomous-tools — Phase 1 골든룰(이름배열 diff=0)', () => {
  test('buildAutonomousToolSpecs 이름배열 = 종전 telegram 인라인 조립(순서 보존)', () => {
    const names = buildAutonomousToolSpecs().map((s) => s.name);
    // nest-cap off(테스트 기본) → delegate + 무거운 3종. 순서=인라인과 동일.
    // ⭐ 2026-08-12 (대표 P4) — `RunDevHarness` 는 «모델 표면에서 내려갔다». 기본이 «없는» 상태다.
    //   ⛔ 지운 것이 아니라 스위치(`tools.runDevHarness.modelSurface`)가 기본 false 인 것이고,
    //     켜면 종전 배열이 그대로 돌아온다 — 그 대칭은 `test/dev-harness-model-surface.test.ts` 가 문다.
    //   ⛔ 그리고 dispatch 경로(CLI·파이프라인)는 이 배열과 «무관»하게 산다.
    expect(names).toEqual(['delegate_code_agent', 'SelfImplement', 'SolveMission']);
  });

  test('AUTONOMOUS_TOOL_NAMES 는 dispatch 라우팅 대상 전체(SelfImplement 별칭 self_implement 포함)', () => {
    // ⛔ 순서는 «라우팅에 안 쓰인다»(isAutonomousTool 은 Set 판정). 이 단언의 뜻은 「집합이 보존되나」다.
    //   📏 2026-08-12 실측: 코드는 delegate → DEV_REQUEST_HARNESS_TOOL_NAMES → RelayShellPrompt 순이라
    //     RelayShellPrompt 가 «끝»이다. 종전 기대값은 그것을 셋째로 적어 두고 «드리프트»해 있었다.
    //   🚨 그런데 그 불일치가 «안 보였다» — 이 파일이 TDZ 로 로드조차 안 됐기 때문이다
    //     (`self-implement-names.ts` 머리말이 그 사건이다). 크래시가 진짜 실패를 가린다.
    expect(AUTONOMOUS_TOOL_NAMES).toEqual([
      'delegate_code_agent',
      'SelfImplement',
      'self_implement',
      'RunDevHarness',
      'SolveMission',
      'RelayShellPrompt',
    ]);
  });

  test('isAutonomousTool — 자율tool 만 true, 코딩코어/앱tool 은 false', () => {
    for (const n of AUTONOMOUS_TOOL_NAMES) expect(isAutonomousTool(n)).toBe(true);
    for (const n of ['Read', 'Bash', 'Edit', 'schedule_manage', 'finance_quote', 'WebSearch']) {
      expect(isAutonomousTool(n)).toBe(false);
    }
  });

  test('delegateBackendToSlashKey — claude/codex/gemini 매핑 + 그 외 null', () => {
    expect(delegateBackendToSlashKey('claude')).toBe('claude');
    expect(delegateBackendToSlashKey('claude-opus')).toBe('claude');
    expect(delegateBackendToSlashKey('codex')).toBe('codex');
    expect(delegateBackendToSlashKey('cx')).toBe('codex');
    expect(delegateBackendToSlashKey('gemini')).toBe('gemini');
    expect(delegateBackendToSlashKey('gem')).toBe('gemini');
    expect(delegateBackendToSlashKey('grok')).toBeNull();
  });

  test('dispatchAutonomousTool — 비-자율tool 이름은 방어적 throw(선분기 계약)', async () => {
    await expect(
      dispatchAutonomousTool('Read', {}, { cwd: process.cwd(), signal: new AbortController().signal }),
    ).rejects.toThrow(/자율tool 이 아님/);
  });

  test('SelfImplement는 사용자 원문을 dispatch 컨텍스트로 전달한다', async () => {
    const userText = '특정 도구를 반드시 사용해 구현해줘';
    let receivedCtx: DaemonToolDispatchCtx | undefined;
    const runner: SelfImplementRunner = async () => ({
      runId: 'run-autonomous-user-text', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
    });

    await dispatchAutonomousTool('SelfImplement', { feature: '요약된 구현 요청' }, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      sessionId: 'session-autonomous-test',
      toolCallId: 'tool-call-autonomous-test',
      userText,
      selfImplementDispatch: async (args, ctx) => {
        receivedCtx = ctx;
        // ⛔⭐ 넷째 인자(authorGoal)를 «반드시» 준다 — 안 주면 기본값이 «진짜 저작기»(LLM · 실측 100~110초)다.
        //   📏 2026-08-12 실측: 그것 때문에 이 테스트가 5초 타임아웃으로 «멈췄고», 돌 때마다 실제 저작이
        //     일어나 골 문서까지 썼다. 이 테스트가 묻는 것은 「userText 가 ctx 로 전달되나」뿐이다.
        //   🚨 그리고 그 사실이 «오래 안 보였다» — 이 파일이 순환 import TDZ 로 로드조차 안 됐기 때문이다
        //     (`boot/daemon-tools/self-implement-names.ts` 머리말이 그 사건).
        return dispatchSelfImplement(args, ctx, runner, async () => ({ path: '/tmp/stub-goal.md' }));
      },
    });

    expect(receivedCtx?.userText).toBe(userText);
    expect(receivedCtx?.sessionId).toBe('session-autonomous-test');
    expect(receivedCtx?.toolCallId).toBe('tool-call-autonomous-test');
  });
});
