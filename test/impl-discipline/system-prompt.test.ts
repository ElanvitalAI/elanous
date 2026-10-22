import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildImplDisciplineSystemMessages,
  promptForPhase,
} from '../../src/impl-discipline/index.js';
import {
  setPlanModeState, resetPlanModeState, INACTIVE_PLAN_MODE_STATE,
} from '../../src/plan-mode/index.js';

afterEach(() => resetPlanModeState());

describe('promptForPhase', () => {
  test('design-first requires an approved RFC before implementation', () => {
    const body = promptForPhase('design-first');
    expect(body).toContain('RFC.md');
    expect(body).toContain('명시적 승인을 요청');
    expect(body).toContain('승인 전에는 애플리케이션 코드·설정을 만들거나 시험을 실행하지 마세요');
  });

  test('idle returns empty string', () => {
    expect(promptForPhase('idle')).toBe('');
  });

  test('plan-loaded default rendering remains byte-identical', () => {
    expect(promptForPhase('plan-loaded')).toBe(`# 플랜/핸드오프 문서 참조 감지

사용자가 PLAN/HANDOFF/SPEC 문서를 참조했습니다. 구현을 시작하기 전 다음을 지키세요.

1. 먼저 Read 로 문서 전체를 읽으세요 (offset/limit 없이).
2. 2~3줄로 요지(목표·범위·개방된 결정) 를 정리해 사용자에게 제시.
3. 본문을 그대로 복사하거나 위젯/wd-scratch 에 덤프하지 마세요. 요약만 인라인으로 응답.
4. 요지가 이해된 뒤에도 scope 가 3+ 파일이거나 파괴적이면 AskUserQuestion 또는 EnterPlanMode 를 호출.
5. "should I proceed?" 같은 열린 질문 금지 — 확정된 선택지(2~4개) 로 묻거나 plan 을 제출.
6. 사용자 확인이 명확히 있을 때만 Edit/Write 로 진입.`);
  });

  test('plan-loaded body mentions Read tool', () => {
    const body = promptForPhase('plan-loaded');
    expect(body).toContain('Read');
    expect(body).toContain('PLAN/HANDOFF/SPEC');
  });

  test('plan-loaded forbids dumping into widgets/wd-scratch', () => {
    const body = promptForPhase('plan-loaded');
    expect(body).toContain('wd-scratch');
    expect(body).toContain('덤프');
  });

  test('implementation-ready default rendering remains byte-identical even when tools are provided', () => {
    expect(promptForPhase('implementation-ready', {
      enabledTools: [{ id: 'custom-read', kind: 'read', displayName: 'CustomRead' } as never],
    })).toBe(`# 명시적 구현 요청 감지

사용자가 구현을 요청했습니다. **구현 요청 자체가 실행 승인입니다.** 계획을 설명한 뒤 멈추지 말고, 이번 턴 안에서 실제 코드 편집(Edit/Write)까지 진행하세요.

1. **열린 확인 질문 절대 금지.** "구현을 진행하시겠습니까?", "진행해도 될까요?", "이대로 할까요?" 같은 yes/no 되묻기로 턴을 끝내지 마세요 — 이미 요청받았습니다. 바로 실행하세요. (사용자가 같은 요청을 반복했다면 더더욱 재확인 없이 즉시 편집.)
2. 대상이 모호하면 Grep/Glob/Read 로 surface 를 먼저 조사 — 코드가 답할 수 있는 것은 코드에 먼저 물어보세요. 조사는 실행의 일부이지, 실행을 미루는 핑계가 아닙니다.
3. 1~2 파일의 명확한 수정은 Read → Edit 로 즉시 진행. 계획서를 응답으로 내보내지 말고 편집을 수행하세요.
4. scope 가 3+ 파일 또는 파괴적(대량 삭제·되돌리기 어려움)이라 정말 사전 정렬이 필요할 때만: 열린 "할까요?" 대신 **실질 산출물**을 내세요 — EnterPlanMode 로 구체 plan 을 제출하거나, 결정이 갈리는 지점을 AskUserQuestion 으로 **확정 선택지 2~4개**(각 옵션이 실제 구현 방향) 로 제시. 어느 쪽도 단순 승인 요청이어서는 안 됩니다.
5. 커밋은 사용자가 명시적으로 요청할 때만. push/merge 는 절대 자동으로 하지 않음. (단, 커밋 이전의 코드 편집은 위 승인 범위 안이므로 자유롭게 진행.)`);
  });

  test('implementation-ready mentions EnterPlanMode + AskUserQuestion', () => {
    const body = promptForPhase('implementation-ready');
    expect(body).toContain('EnterPlanMode');
    expect(body).toContain('AskUserQuestion');
  });

  test('implementation-ready forbids auto push/merge', () => {
    const body = promptForPhase('implementation-ready');
    expect(body).toContain('push');
  });

  test.each([
    ['an empty tool list', []],
    ['an omitted tool list', undefined],
  ])('native structure with %s omits directives whose required kinds are absent', (_label, enabledTools) => {
    const body = promptForPhase('implementation-ready', {
      nativeStructureEnabled: true,
      enabledTools,
    });
    expect(body).not.toContain('surface 를 먼저 조사');
    expect(body).not.toContain('파일의 명확한 수정');
    expect(body).toContain('EnterPlanMode');
    expect(body).toContain('커밋은 사용자가 명시적으로 요청할 때만');
  });

  test('native structure renders ordered display names and excludes other entries', () => {
    const body = promptForPhase('implementation-ready', {
      nativeStructureEnabled: true,
      enabledTools: [
        { id: 'grep', kind: 'search', displayName: 'Grep' },
        { id: 'glob', kind: 'search', displayName: 'Glob' },
        { id: 'read', kind: 'read', displayName: 'Read' },
        { id: 'edit', kind: 'edit', displayName: 'Edit' },
        { id: 'unknown', kind: 'other', displayName: 'UnknownTool' },
      ] as never,
    });
    expect(body).toContain('Grep/Glob/Read 로 surface 를 먼저 조사');
    expect(body).toContain('Read/Edit 로 즉시 진행');
    expect(body).not.toContain('UnknownTool');
  });

  test('native structure omits edit directives while retaining unrelated ordered directives', () => {
    const body = promptForPhase('plan-loaded', {
      nativeStructureEnabled: true,
      enabledTools: [{ id: 'read', kind: 'read', displayName: 'Read' } as never],
    });
    expect(body).toContain('1. 먼저 Read 로 문서 전체를 읽으세요');
    expect(body).not.toContain('6. 사용자 확인이 명확히 있을 때만');
    expect(body).toContain('2. 2~3줄로 요지');
    expect(body).toContain('5. "should I proceed?"');
  });

  test('native structure keeps duplicate display names and other entries out of directives', () => {
    const body = promptForPhase('implementation-ready', {
      nativeStructureEnabled: true,
      enabledTools: [
        { id: 'grep', kind: 'search', displayName: 'Grep' },
        { id: 'grep-alias', kind: 'search', displayName: 'Grep' },
        { id: 'read', kind: 'read', displayName: 'Read' },
        { id: 'other', kind: 'other', displayName: 'OtherTool' },
      ] as never,
    });
    expect(body).toContain('Grep/Read 로 surface 를 먼저 조사');
    expect(body).not.toContain('Grep/Grep');
    expect(body).not.toContain('OtherTool');
    expect(body).not.toContain('1~2 파일의 명확한 수정');
  });

  test('native structure adds delegate guidance with only enabled delegate display names', () => {
    const withoutDelegate = promptForPhase('implementation-ready', {
      nativeStructureEnabled: true,
      enabledTools: [
        { id: 'read', kind: 'read', displayName: 'Read' },
        { id: 'search', kind: 'search', displayName: 'Grep' },
        { id: 'edit', kind: 'edit', displayName: 'Edit' },
      ] as never,
    });
    const withDelegate = promptForPhase('implementation-ready', {
      nativeStructureEnabled: true,
      enabledTools: [
        { id: 'read', kind: 'read', displayName: 'Read' },
        { id: 'search', kind: 'search', displayName: 'Grep' },
        { id: 'edit', kind: 'edit', displayName: 'Edit' },
        { id: 'persistent-grounding', kind: 'delegate', displayName: 'PersistentGrounding' },
      ] as never,
    });

    expect(withDelegate).not.toBe(withoutDelegate);
    expect(withDelegate).toContain('## 위임 가능한 도구');
    expect(withDelegate).toContain('PersistentGrounding로 위임');
  });

  test('native structure without delegates preserves the prior transformed output', () => {
    const enabledTools = [
      { id: 'read', kind: 'read', displayName: 'Read' },
      { id: 'search', kind: 'search', displayName: 'Grep' },
      { id: 'edit', kind: 'edit', displayName: 'Edit' },
    ] as never;
    const body = promptForPhase('implementation-ready', {
      nativeStructureEnabled: true,
      enabledTools,
    });

    expect(body).toBe(`# 명시적 구현 요청 감지

사용자가 구현을 요청했습니다. **구현 요청 자체가 실행 승인입니다.** 계획을 설명한 뒤 멈추지 말고, 이번 턴 안에서 실제 코드 편집까지 진행하세요.

1. **열린 확인 질문 절대 금지.** "구현을 진행하시겠습니까?", "진행해도 될까요?", "이대로 할까요?" 같은 yes/no 되묻기로 턴을 끝내지 마세요 — 이미 요청받았습니다. 바로 실행하세요. (사용자가 같은 요청을 반복했다면 더더욱 재확인 없이 즉시 편집.)
2. 대상이 모호하면 Grep/Read 로 surface 를 먼저 조사 — 코드가 답할 수 있는 것은 코드에 먼저 물어보세요. 조사는 실행의 일부이지, 실행을 미루는 핑계가 아닙니다.
3. 1~2 파일의 명확한 수정은 Read/Edit 로 즉시 진행. 계획서를 응답으로 내보내지 말고 편집을 수행하세요.
4. scope 가 3+ 파일 또는 파괴적(대량 삭제·되돌리기 어려움)이라 정말 사전 정렬이 필요할 때만: 열린 "할까요?" 대신 **실질 산출물**을 내세요 — EnterPlanMode 로 구체 plan 을 제출하거나, 결정이 갈리는 지점을 AskUserQuestion 으로 **확정 선택지 2~4개**(각 옵션이 실제 구현 방향) 로 제시. 어느 쪽도 단순 승인 요청이어서는 안 됩니다.
5. 커밋은 사용자가 명시적으로 요청할 때만. push/merge 는 절대 자동으로 하지 않음. (단, 커밋 이전의 코드 편집은 위 승인 범위 안이므로 자유롭게 진행.)`);
    expect(body).not.toContain('## 위임 가능한 도구');
  });

  test('native structure false preserves the static implementation-ready prompt even with delegates', () => {
    expect(promptForPhase('implementation-ready', {
      nativeStructureEnabled: false,
      enabledTools: [{ id: 'persistent-grounding', kind: 'delegate', displayName: 'PersistentGrounding' } as never],
    })).toBe(promptForPhase('implementation-ready'));
  });

  test('native structure false preserves the static plan-loaded prompt with tools present', () => {
    expect(promptForPhase('plan-loaded', {
      nativeStructureEnabled: false,
      enabledTools: [],
    })).toBe(promptForPhase('plan-loaded'));
  });
});

describe('buildImplDisciplineSystemMessages — dispatching', () => {
  test('idle text returns []', () => {
    expect(buildImplDisciplineSystemMessages({ text: '뭐야 이게?' }))
      .toEqual([]);
  });

  test('plan-loaded text returns 1 system message with plan-loaded body', () => {
    const msgs = buildImplDisciplineSystemMessages({
      text: 'docs/PLAN-session-m.md 열어봐',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('PLAN/HANDOFF/SPEC');
  });

  test('explicit new-project request dispatches the RFC-first prompt', () => {
    const msgs = buildImplDisciplineSystemMessages({
      text: '새 저장소에서 독서 앱을 만들어줘',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toContain('RFC.md');
    expect(msgs[0]!.content).toContain('명시적 승인을 요청');
  });

  test('implementation-ready text returns 1 system message with impl body', () => {
    const msgs = buildImplDisciplineSystemMessages({
      text: 'login 폼 구현해줘',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('EnterPlanMode');
  });
});

describe('buildImplDisciplineSystemMessages — plan-mode interaction', () => {
  test('plan-mode active returns [] even for plan-loaded text', () => {
    setPlanModeState({
      ...INACTIVE_PLAN_MODE_STATE,
      active: true, sessionId: 's', startedAt: 0, phase: 'explore',
      planFilePath: '/p.md', previousPolicy: { mode: 'ask-edit' },
    });
    expect(buildImplDisciplineSystemMessages({
      text: 'HANDOFF-x.md 따라 진행',
    })).toEqual([]);
  });

  test('plan-mode active returns [] even for implementation-ready text', () => {
    setPlanModeState({
      ...INACTIVE_PLAN_MODE_STATE,
      active: true, sessionId: 's', startedAt: 0, phase: 'explore',
      planFilePath: '/p.md', previousPolicy: { mode: 'ask-edit' },
    });
    expect(buildImplDisciplineSystemMessages({ text: '구현 시작' }))
      .toEqual([]);
  });

  test('plan-mode inactive resumes normal phase dispatch', () => {
    // setPlanModeState + reset — resetPlanModeState runs in afterEach,
    // but double-check that a fresh call sees idle here.
    const msgs = buildImplDisciplineSystemMessages({ text: '구현해' });
    expect(msgs).toHaveLength(1);
  });
});
