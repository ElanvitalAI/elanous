import { describe, expect, test } from 'bun:test';
import { formatAgentWakePrompt } from './agent-wake.js';
import { formatGoalContinuePrompt } from './goal-continue.js';
import {
  classifyInterimReply, countInterimDisplay, createClassicInterimFold, formatInterimFoldLine, internalTurnOriginOfText, planInterimDisplay,
} from './goal-interim.js';
import { formatSeatAutowakePrompt } from './seat-autowake.js';
import { logViewLines, toolFoldBlockRanges } from '../../tui/chat/log-view.js';

const NOT_DONE = '1단계 렌더를 진행했습니다.\n완료 영상 경로는 아직 보고할 수 없습니다 — 아직 못 했습니다.';

describe('goal-interim: internal turn text', () => {
  test('the three internal-turn formatters are recognized by their prefix (drift guard)', () => {
    expect(internalTurnOriginOfText(formatGoalContinuePrompt('하겠습니다'))).toBe('goal-continue');
    expect(internalTurnOriginOfText(formatAgentWakePrompt({ agentName: 'general-purpose', label: 'pr-review', state: 'done' }))).toBe('child-complete');
    expect(internalTurnOriginOfText(formatSeatAutowakePrompt('OPC', 1, 0))).toBe('autowake');
  });

  test('a person\'s text is not an internal turn', () => {
    expect(internalTurnOriginOfText('영상 만들어줘')).toBeNull();
    expect(internalTurnOriginOfText('골 이어가기 해줘')).toBeNull();
  });
});

describe('goal-interim: interim reply verdict', () => {
  test('«not done» paragraph and a bare pledge are interim; a result is final', () => {
    expect(classifyInterimReply(NOT_DONE.split('\n'))).toEqual({ interim: true, reason: 'incomplete', summary: '1단계 렌더를 진행했습니다.' });
    expect(classifyInterimReply(['이어서 렌더를 진행하겠습니다.'])).toMatchObject({ interim: true, reason: 'pledge' });
    expect(classifyInterimReply(['렌더 완료: /tmp/out.mp4'])).toEqual({ interim: false, reason: 'final' });
    expect(classifyInterimReply(['  ✔ 완료', ''])).toEqual({ interim: false, reason: 'no-reply' });
  });

  test('only the last sentence decides — a result reply that mentions «못 했» in the middle is final', () => {
    expect(classifyInterimReply(['X 는 못 했지만 Y 는 끝냈습니다.', '렌더 완료: /tmp/out.mp4 를 만들었습니다.'])).toEqual({ interim: false, reason: 'final' });
    expect(classifyInterimReply(['Y 는 끝냈습니다. 그런데 X 는 아직 못 했습니다.'])).toMatchObject({ interim: true, reason: 'incomplete' });
  });

  test('the fold line is one line and cut to 60 characters', () => {
    expect(formatInterimFoldLine('짧은 첫 줄')).toBe('· 진행 — 짧은 첫 줄 (접힘)');
    const long = formatInterimFoldLine('가'.repeat(100));
    expect(long).toBe(`· 진행 — ${'가'.repeat(60)}… (접힘)`);
  });
});

describe('goal-interim: next plan', () => {
  const ts = '2026-10-22T00:00:00.000Z';
  const msgs = [
    { role: 'user' as const, content: '영상 만들어줘', ts },
    { role: 'assistant' as const, content: NOT_DONE, ts },
    { role: 'user' as const, content: formatGoalContinuePrompt('못 했습니다'), ts },
    { role: 'assistant' as const, content: NOT_DONE.replace('1단계', '2단계'), ts },
  ];

  test('the reply before a continuation folds, the last one stays, the internal input is its origin line', () => {
    const plan = planInterimDisplay(msgs);
    expect(plan.get(1)).toEqual({ kind: 'folded', line: '· 진행 — 1단계 렌더를 진행했습니다. (접힘)' });
    expect(plan.get(2)).toEqual({ kind: 'internal-input', origin: 'goal-continue' });
    expect(plan.has(3)).toBe(false);
    expect(countInterimDisplay(plan)).toEqual({ folded: 1, internal: 1 });
  });

  test('log view: no «나: [골 이어가기]», «not done» once, each step visible', () => {
    const screen = logViewLines(msgs, 100).join('\n');
    expect(screen).not.toContain('나: [골 이어가기]');
    expect(screen).toContain('↻ 자동 재개(goal-continue)');
    expect(screen.split('보고할 수 없습니다').length - 1).toBe(1);
    expect(screen.split('단계 렌더를 진행했습니다').length - 1).toBe(2);
  });

  test('autowake («남은 일») is new work: its input line loses the person header but the reply before it stays', () => {
    const plan = planInterimDisplay([msgs[0]!, msgs[1]!, { role: 'user', content: formatSeatAutowakePrompt('OPC', 1, 0) }, msgs[3]!]);
    expect(plan.get(2)).toEqual({ kind: 'internal-input', origin: 'autowake' });
    expect(plan.has(1)).toBe(false);
  });

  test('a reply before a human turn is not folded', () => {
    const plan = planInterimDisplay([msgs[0]!, msgs[1]!, { role: 'user', content: '다시 해줘' }, msgs[3]!]);
    expect(plan.size).toBe(0);
  });

  test('tool fold ranges still match the rendered lines with the plan applied', () => {
    const tool = { role: 'tool' as const, content: '', ts, toolName: 'Bash', toolResult: Array.from({ length: 30 }, (_, i) => `${i}`).join('\n') };
    const withTool = [...msgs, tool];
    const lines = logViewLines(withTool, 100);
    const [range] = toolFoldBlockRanges(withTool, 100);
    expect(lines[range!.start]).toContain('▸ 도구 Bash');
  });
});

describe('goal-interim: classic fold', () => {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const make = (canFold = true) => createClassicInterimFold({ canFold: () => canFold, log: (_c, event, data) => { logs.push({ event, data }); } });

  test('the previous «not done» reply collapses to one line when a goal-continue turn opens', () => {
    logs.length = 0;
    const fold = make();
    const chat = ['  ↻ 자동 재개(goal-continue)', '  1단계 렌더를 진행했습니다.', '  완료 영상 경로는 아직 보고할 수 없습니다 — 아직 못 했습니다.', '  ✔ 완료'];
    fold.noteTurnEnded(chat, 1);
    chat.push('---');
    expect(fold.foldBeforeInternalTurn(chat, 'goal-continue')).toEqual({ folded: true, reason: 'incomplete' });
    expect(chat).toEqual(['  ↻ 자동 재개(goal-continue)', '  · 진행 — 1단계 렌더를 진행했습니다. (접힘)', '---']);
    expect(logs).toEqual([{ event: 'folded', data: { surface: 'classic', origin: 'goal-continue', reason: 'incomplete', lines: 3 } }]);
  });

  test('tool lines before the reply block stay — only the range from the reply start folds', () => {
    const fold = make();
    const chat = ['  ❯ 영상 만들어줘', '  ⏺ Bash(ls)', '    └ out.mp4 없음', '  1단계를 해 봤습니다.', '  아직 못 했습니다.'];
    fold.noteTurnEnded(chat, 3);
    expect(fold.foldBeforeInternalTurn(chat, 'goal-continue').folded).toBe(true);
    expect(chat).toEqual(['  ❯ 영상 만들어줘', '  ⏺ Bash(ls)', '    └ out.mp4 없음', '  · 진행 — 1단계를 해 봤습니다. (접힘)']);
  });

  test('real order: the «✔ 완료» line is pushed after the snapshot — the reply still folds and the done line stays', () => {
    const fold = make();
    const chat = ['  ❯ 영상 만들어줘', '  1단계 렌더를 진행했습니다.', '  아직 못 했습니다.'];
    fold.noteTurnEnded(chat, 1);
    chat.push('  ✔ 완료  (2s)', '  ⏸ 다른 알림');
    expect(fold.foldBeforeInternalTurn(chat, 'goal-continue')).toEqual({ folded: true, reason: 'incomplete' });
    expect(chat).toEqual(['  ❯ 영상 만들어줘', '  · 진행 — 1단계 렌더를 진행했습니다. (접힘)', '  ✔ 완료  (2s)', '  ⏸ 다른 알림']);
  });

  test('not folded: human turn between · scheduled origin · lines moved · unstable · final reply', () => {
    const reply = ['  아직 못 했습니다.', '  ✔ 완료'];
    const human = make();
    human.noteTurnEnded([...reply], 0);
    human.noteHumanTurn();
    expect(human.foldBeforeInternalTurn([...reply], 'goal-continue').reason).toBe('no-previous-reply');

    const scheduled = make();
    scheduled.noteTurnEnded([...reply], 0);
    expect(scheduled.foldBeforeInternalTurn([...reply], 'scheduled').reason).toBe('not-continuation');

    const autowake = make();
    autowake.noteTurnEnded([...reply], 0);
    expect(autowake.foldBeforeInternalTurn([...reply], 'autowake').reason).toBe('not-continuation');

    const moved = make();
    moved.noteTurnEnded([...reply], 0);
    expect(moved.foldBeforeInternalTurn(['trimmed', ...reply], 'goal-continue').reason).toBe('lines-moved');

    const unstable = make(false);
    unstable.noteTurnEnded([...reply], 0);
    expect(unstable.foldBeforeInternalTurn([...reply], 'goal-continue').reason).toBe('lines-unstable');

    const final = make();
    const done = ['  렌더 완료: /tmp/out.mp4', '  ✔ 완료'];
    final.noteTurnEnded(done, 0);
    const chat = [...done];
    expect(final.foldBeforeInternalTurn(chat, 'child-complete')).toEqual({ folded: false, reason: 'final' });
    expect(chat).toEqual(done);
  });
});
