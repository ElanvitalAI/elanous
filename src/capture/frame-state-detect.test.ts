// #1 region-rule 화면 상태 감지 — herdr detect/manifest 이식. 순수·합성 프레임.
import { describe, expect, test } from 'bun:test';
import { AGENT_MISSION_STATE_RULES, classifyFrameState, DEFAULT_STATE_RULES, detectAgentFromCmd, GOAL_LOOP_STATE_RULES, reconcileFrameStateWithTurn, UNKNOWN_INPUT_MAX_LINE_LENGTH, UNKNOWN_INPUT_MAX_LINES, type StateRule } from './frame-state-detect.js';

describe('classifyFrameState (기본 규칙셋)', () => {
  test('blocked — yes/no 승인 UI', () => {
    const frame = [
      'Do you want to make this edit?',
      '❯ 1. Yes',
      '  2. No, tell Claude what to do differently',
    ].join('\n');
    const v = classifyFrameState(frame);
    expect(v.state).toBe('blocked');
    expect(v.visible).toBe(true);
  });

  test('blocked — enter to select / esc to cancel', () => {
    const frame = 'Select an option\n> foo\n  bar\nenter to select · esc to cancel';
    expect(classifyFrameState(frame).state).toBe('blocked');
  });

  test('blocked — (y/n) 인라인', () => {
    expect(classifyFrameState('Proceed with deploy? (y/n)').state).toBe('blocked');
  });

  test('working — 스피너 글리프', () => {
    const frame = 'thinking…\n⠹ Working on it';
    expect(classifyFrameState(frame).state).toBe('working');
  });

  test('working — esc to interrupt', () => {
    const frame = '● Running tool\n  (esc to interrupt)';
    expect(classifyFrameState(frame).state).toBe('working');
  });

  test('idle — bare 프롬프트', () => {
    const frame = 'last output line\n❯ ';
    expect(classifyFrameState(frame).state).toBe('idle');
  });

  test('idle 오탐 안 함 — 행중간 > / Markdown 인용 (review must-fix)', () => {
    // 프롬프트 글리프가 행 시작이 아니면 idle 아님(일반 출력·redirect·인용).
    expect(classifyFrameState('build result > next.txt').state).not.toBe('idle');
    expect(classifyFrameState('> a quoted markdown line\n> second line').state).not.toBe('idle');
    expect(classifyFrameState('run cmd > out').state).toBe('unknown');
  });

  test('우선순위 — working 스피너가 idle 프롬프트보다 우선', () => {
    // 프롬프트와 스피너가 공존(스피너=상단, 프롬프트=하단): working 이 priority 90 > idle 50.
    const frame = '⠹ working…\nsome text\n❯ ';
    // bottomLines(4) 에 스피너가 포함되면 working. (스피너가 하단 4줄 안)
    expect(classifyFrameState(frame).state).toBe('working');
  });

  test('MonAD TUI 턴 진행 — Thinking과 Streaming은 프롬프트보다 working 우선', () => {
    const chrome = [
      '────────────────────────────────────────',
      '❯ /command, or type a question',
      '────────────────────────────────────────',
      '📁 src/capture │ main',
    ];
    const activeTurns = [
      '· Streaming Grep (12 tools)…  (1m 1s · ↓ 52 tokens · esc 중단)',
      '✽ Thinking…  (2m 5s · esc 중단)',
      '✽ Thinking…  (1h 2m · esc 중단)',
    ];

    for (const line of activeTurns) {
      const verdict = classifyFrameState([line, ...chrome].join('\n'));
      expect(verdict.state).toBe('working');
      expect(verdict.matchedLabel).toBe('elanous-tui-turn-in-progress');
    }
  });

  test('MonAD TUI 턴 끝 — esc 중단 없는 완료 Streaming은 idle 유지', () => {
    const frame = [
      '✔ Streaming  (2m 5s · ↓ 1 tokens · 🧠 gpt-5.6-terra(medium))',
      '────────────────────────────────────────',
      '❯ /command, or type a question',
      '────────────────────────────────────────',
      '📁 src/capture │ main',
    ].join('\n');
    const verdict = classifyFrameState(frame);

    expect(verdict.state).toBe('idle');
    expect(verdict.matchedLabel).toBe('bare-prompt');
  });

  test('MonAD TUI 턴 진행 문구 — bottom 10줄 밖의 복사 문구는 idle', () => {
    const frame = [
      '사용자가 "(3s · esc 중단)" 을 복사했다',
      ...Array.from({ length: 10 }, (_, index) => `본문 ${index + 1}`),
      '────────────────────────────────────────',
      '❯ /command, or type a question',
      '────────────────────────────────────────',
      '📁 src/capture │ main',
    ].join('\n');
    const verdict = classifyFrameState(frame);

    expect(verdict.state).toBe('idle');
    expect(verdict.matchedLabel).toBe('bare-prompt');
  });

  test('일반 번호목록(커서 없음) → blocked 오탐 안 함 (review must-fix ③)', () => {
    // "1. foo / 2. bar" 는 대화형 선택이 아니므로 blocked 아님.
    expect(classifyFrameState('Options:\n1. apple\n2. banana').state).not.toBe('blocked');
    // 커서 마커가 있으면 blocked.
    expect(classifyFrameState('Pick:\n❯ 1. apple\n  2. banana').state).toBe('blocked');
    expect(classifyFrameState('Pick:\n› 1. apple\n  2. banana').state).toBe('blocked');
  });

  test('unknown — 어떤 규칙도 매치 안 함', () => {
    const v = classifyFrameState('just some plain output\nnothing special here');
    expect(v.state).toBe('unknown');
    expect(v.matchedLabel).toBeNull();
  });

  test('unknown — 분류기가 검사한 하단 정리 라인만 진단으로 노출하고 상한을 지킨다', () => {
    const frame = [
      '상단은 하단 규칙 검사 범위 밖',
      ...Array.from({ length: UNKNOWN_INPUT_MAX_LINES + 2 }, (_, i) => `│  line-${i} ${'x'.repeat(UNKNOWN_INPUT_MAX_LINE_LENGTH + 20)}  │`),
    ].join('\n');
    const v = classifyFrameState(frame);
    expect(v.state).toBe('unknown');
    expect(v.unknownInput).toHaveLength(UNKNOWN_INPUT_MAX_LINES);
    expect(v.unknownInput![0]).toStartWith('line-2 ');
    expect(v.unknownInput!.at(-1)).toStartWith(`line-${UNKNOWN_INPUT_MAX_LINES + 1} `);
    expect(v.unknownInput!.every((line) => [...line].length <= UNKNOWN_INPUT_MAX_LINE_LENGTH)).toBe(true);
  });

  test('매치한 분류는 unknown 진단 입력을 싣지 않는다', () => {
    const v = classifyFrameState('⠹ Working on it');
    expect(v.state).toBe('working');
    expect(v.unknownInput).toBeUndefined();
  });

  test('ANSI/box 스크럽 후 매치(렌더 chrome 무시)', () => {
    const frame = '\x1b[32m┌─────┐\n│ ❯ 1. Yes │\n│   2. No  │\n└─────┘\x1b[0m';
    expect(classifyFrameState(frame).state).toBe('blocked');
  });

  test('evaluated — 매치한 규칙 라벨 노출(explain 축소판)', () => {
    const v = classifyFrameState('Proceed? (y/n)');
    expect(v.evaluated.length).toBeGreaterThan(0);
    expect(v.matchedLabel).toBeTruthy();
  });

  test('주입 규칙셋 — 커스텀 규칙으로 분류', () => {
    const rules: StateRule[] = [
      { state: 'done', priority: 10, region: { kind: 'whole' }, match: { kind: 'contains', text: 'GOAL-COMPLETE' }, label: 'goal-done' },
    ];
    expect(classifyFrameState('… GOAL-COMPLETE', rules).state).toBe('done');
    expect(classifyFrameState('nothing', rules).state).toBe('unknown');
  });

  test('주입 global 정규식 — lastIndex 순서의존 없음(review must-fix ⑤)', () => {
    const rules: StateRule[] = [
      { state: 'working', priority: 10, region: { kind: 'whole' }, match: { kind: 'regex', re: /busy/g }, label: 'g-flag' },
    ];
    // 같은 global regex 로 반복 분류 — lastIndex 리셋 안 하면 두 번째가 false 로 흔들림.
    expect(classifyFrameState('busy', rules).state).toBe('working');
    expect(classifyFrameState('busy', rules).state).toBe('working'); // 결정론
    expect(classifyFrameState('busy', rules).state).toBe('working');
  });
});

describe('classifyFrameState (self-implement goal-loop 규칙)', () => {
  test('완주 화면 — 단독 GOAL-COMPLETE가 done', () => {
    const frame = [
      '  \u23FA update_goal({"status":"complete"})',
      '     \u21B3 {"ok":true}',
      '요구된 gate 통과를 확인했습니다.',
      'GOAL-COMPLETE',
      '\u25CF [session abcdef12  openai/gpt-5  100]',
    ].join('\n');
    expect(classifyFrameState(frame, GOAL_LOOP_STATE_RULES).state).toBe('done');
  });

  test('산문 부정문의 GOAL-COMPLETE는 done이 아니다', () => {
    const frame = '따라서 요구된 gate 통과 및 GOAL-COMPLETE를 선언할 수 없습니다.';
    expect(classifyFrameState(frame, GOAL_LOOP_STATE_RULES).state).not.toBe('done');
  });

  test('tool-call과 tool-result는 working', () => {
    expect(classifyFrameState('  \u23FA Bash({"command":"true"})', GOAL_LOOP_STATE_RULES).state).toBe('working');
    expect(classifyFrameState('     \u21B3 command succeeded', GOAL_LOOP_STATE_RULES).state).toBe('working');
  });

  test('비-darwin U+25CF tool-call도 working', () => {
    expect(classifyFrameState('  \u25CF Read({"file_path":"src/a.ts"})', GOAL_LOOP_STATE_RULES).state).toBe('working');
  });

  test('상태줄만 있으면 idle', () => {
    expect(classifyFrameState('\u25CF [session abcdef12  openai/gpt-5  100]', GOAL_LOOP_STATE_RULES).state).toBe('idle');
  });

  test('working과 done 동시 매치면 done 우선', () => {
    const frame = '  \u23FA Bash({"command":"true"})\nGOAL-COMPLETE';
    expect(classifyFrameState(frame, GOAL_LOOP_STATE_RULES).state).toBe('done');
  });

  test('goal-loop 규칙은 DEFAULT_STATE_RULES를 변형하지 않고 접두로 포함', () => {
    expect(DEFAULT_STATE_RULES).toHaveLength(6);
    expect(DEFAULT_STATE_RULES.map((rule) => rule.label)).toEqual([
      'permission-select',
      'select-cancel-prompt',
      'yes-no-inline',
      'spinner-or-interrupt',
      'elanous-tui-turn-in-progress',
      'bare-prompt',
    ]);
    for (const [index, rule] of DEFAULT_STATE_RULES.entries()) {
      expect(GOAL_LOOP_STATE_RULES[index]).toBe(rule);
    }
  });
});

describe('classifyFrameState (agent-mission Claude 규칙)', () => {
  const claudeChrome = [
    '❯ 커밋하고 PR 올려줘',
    '────────────────────────────────────────',
    '⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker',
    '📁 docs/harness │ probe/claude-read… ~2 wt │ Opus 5 (1M) │ CTX 88%',
    '🖥 MacBookProM5 │ ↔ ssh │ ▤ tmux │ ❐ acp',
    '⏵⏵ bypass permissions on (shift+tab to cycle)',
  ];

  test('MISSION-COMPLETE 단독 행은 chrome이 남아도 done, 기본 규칙은 done이 아니다', () => {
    const frame = ['MISSION-COMPLETE', ...claudeChrome].join('\n');
    expect(classifyFrameState(frame, AGENT_MISSION_STATE_RULES).state).toBe('done');
    expect(classifyFrameState(frame, DEFAULT_STATE_RULES).state).not.toBe('done');
  });

  test('chrome 네 줄 위 Claude 프롬프트는 idle, 기본 규칙은 unknown', () => {
    const frame = claudeChrome.join('\n');
    expect(classifyFrameState(frame, AGENT_MISSION_STATE_RULES).state).toBe('idle');
    expect(classifyFrameState(frame, DEFAULT_STATE_RULES).state).toBe('unknown');
  });

  test('산문 속 MISSION-COMPLETE는 done이 아니다', () => {
    expect(classifyFrameState('MISSION-COMPLETE를 선언할 수 없습니다.', AGENT_MISSION_STATE_RULES).state).not.toBe('done');
  });

  test('agent-mission 규칙은 기본 규칙을 보존하고 완료 규칙을 추가한다', () => {
    expect(AGENT_MISSION_STATE_RULES.length).toBeGreaterThan(DEFAULT_STATE_RULES.length);
    for (const [index, rule] of DEFAULT_STATE_RULES.entries()) {
      expect(AGENT_MISSION_STATE_RULES[index]).toBe(rule);
    }
  });
});

describe('detectAgentFromCmd (herdr 프로세스-명 매칭·review must-fix ④)', () => {
  test('codex / claude / gemini / grok / elanous', () => {
    expect(detectAgentFromCmd('codex --yolo')).toBe('codex');
    expect(detectAgentFromCmd('bun x claude --resume abc')).toBe('claude');
    expect(detectAgentFromCmd('gemini chat')).toBe('gemini');
    expect(detectAgentFromCmd('grok-cli')).toBe('grok');
    expect(detectAgentFromCmd('bun bin/elanous.mjs chat --tools')).toBe('elanous');
  });
  test('kind fallback — tui/self = elanous', () => {
    expect(detectAgentFromCmd('some-shell', 'tui')).toBe('elanous');
    expect(detectAgentFromCmd('x', 'self')).toBe('elanous');
  });
  test('미상 → undefined', () => {
    expect(detectAgentFromCmd('vim README.md', 'pty')).toBeUndefined();
    expect(detectAgentFromCmd(undefined)).toBeUndefined();
  });
});

// ⭐ 「신호가 없었다」 ≠ 「신호가 «창 밖»이라 못 봤다」 (2026-08-11 · `MEAS-T57`)
//   실측 근거: 디스크에 남은 실제 미션 화면 76개 중 unknown 50개가 «전부» 화면 어딘가에 프롬프트를
//   갖고 있었다(codex 66% · claude 66% — backend 무관). 축은 region 크기 대 입력 에코 길이다.
describe('unknown 진단 — 본 범위 밖 후보', () => {
  /** agent-mission idle 규칙은 bottomLines 8 을 본다. 그 창 «안»에 프롬프트가 있는 화면. */
  const promptInsideWindow = ['› 무엇을 도와드릴까요', '', '  ~/work/repo'].join('\n');
  /** 같은 프롬프트가 긴 에코에 밀려 하단 8줄 «밖»으로 나간 화면. */
  const promptPushedOut = [
    '› 무엇을 도와드릴까요',
    ...Array.from({ length: 12 }, (_, i) => `  에코 라인 ${i + 1} — 자식이 되받아 출력한 긴 지시문`),
    '',
    '  ~/work/repo',
  ].join('\n');

  test('창 안이면 idle 로 잡히고 진단 필드가 아예 없다', () => {
    const verdict = classifyFrameState(promptInsideWindow, AGENT_MISSION_STATE_RULES);
    expect(verdict.state).toBe('idle');
    expect(verdict.outOfRegionCandidates).toBeUndefined();
  });

  test('창 밖으로 밀리면 unknown 이지만 «밖에 후보가 있었다»고 말한다', () => {
    const verdict = classifyFrameState(promptPushedOut, AGENT_MISSION_STATE_RULES);
    expect(verdict.state).toBe('unknown');
    // ⛔ 재분류하지 않는다 — state 는 unknown 그대로다.
    expect(verdict.outOfRegionCandidates ?? []).toContain('agent-mission-bare-prompt');
  });

  test('두 화면의 산출이 서로 다른 값이다 (모집단 0 아님을 같이 단언)', () => {
    const inside = classifyFrameState(promptInsideWindow, AGENT_MISSION_STATE_RULES);
    const outside = classifyFrameState(promptPushedOut, AGENT_MISSION_STATE_RULES);
    expect(inside.state).not.toBe(outside.state);
    // 모집단이 0이면 「후보 없음」과 구별되지 않으므로, 후보가 «하나 이상»임을 명시한다.
    expect((outside.outOfRegionCandidates ?? []).length).toBeGreaterThan(0);
  });

  test('화면에 아무 신호도 없으면 후보도 «빈 배열»이다 — 「밖에 있었다」와 구별된다', () => {
    const verdict = classifyFrameState(['평범한 산문 한 줄', '두 번째 줄'].join('\n'), AGENT_MISSION_STATE_RULES);
    expect(verdict.state).toBe('unknown');
    expect(verdict.outOfRegionCandidates).toEqual([]);
  });
});

describe('reconcileFrameStateWithTurn (H10 · 자기보고 턴 우선)', () => {
  test('turn=idle 이면 화면 working(남은 Streaming 줄)은 idle 로 — working 과 idle 이 같이 나가지 않는다', () => {
    const screen = classifyFrameState(['· Streaming…  (5s · esc 중단)', '✔ 완료', '❯ '].join('\n'));
    expect(screen.state).toBe('working');
    expect(reconcileFrameStateWithTurn(screen.state, 'idle')).toEqual({ state: 'idle', source: 'turn', screenState: 'working', overridden: true });
  });

  test('turn=busy 면 working — 화면 idle·unknown·done 을 덮되 blocked·waiting 은 턴 안의 구체 상태로 둔다', () => {
    expect(reconcileFrameStateWithTurn('idle', 'busy')).toEqual({ state: 'working', source: 'turn', screenState: 'idle', overridden: true });
    expect(reconcileFrameStateWithTurn('working', 'busy')).toEqual({ state: 'working', source: 'turn', screenState: 'working', overridden: false });
    expect(reconcileFrameStateWithTurn('unknown', 'busy')).toEqual({ state: 'working', source: 'turn', screenState: 'unknown', overridden: false });
    expect(reconcileFrameStateWithTurn('blocked', 'busy')).toMatchObject({ state: 'blocked', source: 'screen' });
    expect(reconcileFrameStateWithTurn('waiting', 'busy')).toMatchObject({ state: 'waiting', source: 'screen' });
  });

  test('turn=idle 의 blocked·waiting·done 은 화면 값을 둔다 · turn=unknown 이면 화면 그대로', () => {
    expect(reconcileFrameStateWithTurn('blocked', 'idle')).toMatchObject({ state: 'blocked', source: 'screen', overridden: false });
    expect(reconcileFrameStateWithTurn('done', 'idle')).toMatchObject({ state: 'done', source: 'screen' });
    expect(reconcileFrameStateWithTurn('unknown', 'idle')).toEqual({ state: 'idle', source: 'turn', screenState: 'unknown', overridden: false });
    for (const s of ['idle', 'working', 'blocked', 'waiting', 'done', 'unknown'] as const) {
      expect(reconcileFrameStateWithTurn(s, 'unknown')).toEqual({ state: s, source: 'screen', screenState: s, overridden: false });
    }
  });

  test('전수: 턴을 알면 결과는 «working ∧ idle» 모순을 낼 수 없다', () => {
    for (const s of ['idle', 'working', 'blocked', 'waiting', 'done', 'unknown'] as const) {
      expect(reconcileFrameStateWithTurn(s, 'idle').state).not.toBe('working');
      expect(reconcileFrameStateWithTurn(s, 'busy').state).not.toBe('idle');
    }
  });
});
