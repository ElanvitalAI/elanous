import { describe, expect, test } from 'bun:test';
import {
  classifyReplyTail,
  createGoalContinue,
  isGoalContinueEnabledByEnv,
  replyLinesOfThisTurn,
  replyTailFromLines,
} from './goal-continue.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';

describe('replyTailFromLines — 화면 줄에서 답 끝 구절', () => {
  test('색 코드·완료·도구·라우팅 줄을 건너 마지막 답 줄을 꺼낸다', () => {
    const lines = [
      '  ❯ 영상 만들어줘',
      '  라우팅: 상시 일',
      '  󰧑 tool: RunShell — result (12 chars)',
      '\x1b[2m  Webhook 노드를 선택했습니다.\x1b[0m',
      '  이제 렌더를 진행하겠습니다.',
      '',
      '  ✔ 완료  (3s · ↓ 40 tokens)',
    ];
    expect(replyTailFromLines(lines)).toBe('Webhook 노드를 선택했습니다. 이제 렌더를 진행하겠습니다.');
  });
  test('답 줄이 없으면 null', () => {
    expect(replyTailFromLines(['  ✔ 완료  (1s)', ''])).toBeNull();
  });
});

describe('classifyReplyTail — 약속만 하고 끝났나', () => {
  test.each([
    ['제가 멈췄습니다. 지금 바로 이어서 완료해야 합니다.', '완료해야 합니다'],
    ['원인은 경로입니다. 렌더를 다시 진행하겠습니다.', '진행하겠습니다'],
    ['다음은 mp4 로 내보낼게요.', '내보낼게요'],
    ["Found it. I'll render the video now.", "I'll render the video now."],
  ])('약속형 %s', (tail, phrase) => {
    const v = classifyReplyTail(tail);
    expect(v.pledge).toBe(true);
    if (v.pledge) expect(v.phrase).toContain(phrase.replace(/[.]$/, '').split(' ').at(-1)!.replace(/[.]$/, ''));
  });
  test.each([
    ['렌더를 진행할까요?'],
    ['어느 노드를 쓸지 선택해 주세요.'],
    ['완료했습니다. 결과는 out.mp4 입니다.'],
    ['네, 알겠습니다.'],
    ['다음 단계는 없습니다.'],
    ['Let me know.'],
    ['Done. Let me know if you want changes.'],
    ['다음 단계로 넘어갈 일은 남지 않았습니다.'],
    ['그렇게 하면 좋겠습니다.'],
    ['원하시면 다음 단계로 진행하겠습니다? 확인 부탁드립니다.'],
  ])('정당한 멈춤 %s', (tail) => {
    expect(classifyReplyTail(tail).pledge).toBe(false);
  });
});

describe('isGoalContinueEnabledByEnv', () => {
  test('기본 켜짐 · 0/off 끔 · 하니스 자식 끔', () => {
    expect(isGoalContinueEnabledByEnv({})).toBe(true);
    expect(isGoalContinueEnabledByEnv({ ELANOUS_TUI_GOAL_CONTINUE: '0' })).toBe(false);
    expect(isGoalContinueEnabledByEnv({ ELANOUS_TUI_GOAL_CONTINUE: 'off' })).toBe(false);
    expect(isGoalContinueEnabledByEnv({ ELANOUS_HARNESS_ROLE: 'child' })).toBe(false);
  });
});

function harness(opts: { result?: StartTurnIfIdleResult; cap?: number } = {}) {
  const calls: Array<{ input: string; opts: StartTurnIfIdleOptions }> = [];
  const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const notices: string[] = [];
  const deferred: Array<() => void> = [];
  let seq = 0;
  const ctl = createGoalContinue({
    startTurnIfIdle: (input, o) => { calls.push({ input, opts: o }); return opts.result ?? { opened: true, turnId: `auto-${++seq}` }; },
    isEnabled: () => true,
    consecutiveCap: opts.cap,
    notify: (l) => notices.push(l),
    defer: (fn) => deferred.push(fn),
    log: (category, event, data) => logs.push({ category, event, data }),
  });
  return { ctl, calls, logs, notices, deferred };
}

describe('createGoalContinue — 턴 끝 → H2 문', () => {
  test('요청 범위 안의 미완 잔여는 자동 이어가고 tui.proactive continue 를 남긴다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['남은 작업은 자막을 검증하는 일입니다. 아직 확정하지 못했습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    expect(h.calls[0]!.input).toContain('확정하지 못했습니다');
    expect(h.logs.some((l) => l.category === 'tui.proactive' && l.event === 'continue')).toBe(true);
  });

  test('로그인·승인처럼 사람 몫이면 자동 턴을 열지 않고 stop-human 을 남긴다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['남은 작업은 계정 로그인입니다. 로그인해 주세요.'] });
    expect(h.ctl.check().opened).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.category === 'tui.proactive' && l.event === 'stop-human')).toBe(true);

    const implementation = harness();
    implementation.ctl.noteTurnEnded({ lines: ['승인 흐름을 구현하겠습니다.'] });
    expect(implementation.ctl.check().opened).toBe(true);
  });

  test('같은 남은 일 지문이 반복되면 stop-no-progress 로 멈춘다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['남은 작업: 자막 검증을 아직 확정하지 못했습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['남은 작업: 자막 검증을 아직 확정하지 못했습니다.'] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'no-progress' });
    expect(h.logs.some((l) => l.category === 'tui.proactive' && l.event === 'stop-no-progress')).toBe(true);
  });

  test.each(['남은 작업은 없습니다. 모두 완료했습니다.', 'There is no remaining work.'])('완료 부정 답은 자동 이어가기를 열지 않는다: %s', (answer) => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: [answer] });
    expect(h.ctl.check().opened).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  test('요청 범위의 잔여 표시 없는 곁가지 미완 고백만으로는 열지 않는다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['참고로 아직 확인하지 못했습니다.'] });
    expect(h.ctl.check().opened).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  test('약속형 끝이면 goal-continue 로 한 턴 연다 · 관측 opened', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['  이어서 렌더를 진행하겠습니다.', '  ✔ 완료  (2s)'] });
    expect(h.ctl.check()).toEqual({ opened: true, reason: 'pledge-without-result' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.opts.origin).toBe('goal-continue');
    expect(h.calls[0]!.input).toContain('[골 이어가기]');
    expect(h.calls[0]!.input).toContain('진행하겠습니다');
    expect(h.logs.find((l) => l.event === 'decided')?.data.opened).toBe(true);
  });
  test('질문으로 끝난 턴은 열지 않는다(관측 skipped asks-human)', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['  렌더를 시작할까요?'] });
    expect(h.ctl.check().opened).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.logs[0]).toEqual({ category: 'tui.goal-continue', event: 'skipped', data: { reason: 'asks-human', tail: '렌더를 시작할까요?' } });
    expect(h.logs.some((l) => l.category === 'tui.proactive' && l.event === 'stop-human')).toBe(false);
  });
  test('실패한 턴은 열지 않는다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['  진행하겠습니다.'], failed: true });
    expect(h.ctl.check().opened).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
  test('같은 답이 또 오면 1회만 · 연속 상한 3 뒤 멈춤 ⊕ 화면 한 줄 · 사람 턴이면 다시 연다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['  첫째로 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  첫째로 진행하겠습니다.'] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'same-reply' });
    h.ctl.noteTurnEnded({ lines: ['  둘째로 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  셋째로 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  넷째로 진행하겠습니다.'] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'cap' });
    expect(h.notices).toEqual(['⏸ 골 이어가기 상한(3회 연속) — 사람 확인 필요 · 키 하나면 다시 이어간다']);
    expect(h.calls).toHaveLength(3);
    h.ctl.noteHumanTurn();
    h.ctl.noteTurnEnded({ lines: ['  다섯째로 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
  });
  test('문이 HumanTyping 이면 무장을 남기고 미뤘다가 다시 연다', () => {
    let result: StartTurnIfIdleResult = { opened: false, reason: 'HumanTyping', detail: 'quiet-window' };
    const calls: string[] = [];
    const deferred: Array<() => void> = [];
    const ctl = createGoalContinue({
      startTurnIfIdle: (i) => { calls.push(i); return result; },
      isEnabled: () => true, defer: (fn) => deferred.push(fn), log: () => {},
    });
    ctl.noteTurnEnded({ lines: ['  지금 실행하겠습니다.'] });
    expect(ctl.check()).toEqual({ opened: false, reason: 'HumanTyping' });
    expect(deferred).toHaveLength(1);
    result = { opened: true, turnId: 'auto-1' };
    deferred[0]!();
    expect(calls).toHaveLength(2);
  });
  test('wrapPort: 입력칸 마운트(attach)에서 무장돼 있으면 판정한다', () => {
    const h = harness();
    const port = h.ctl.wrapPort({ attach: () => {}, detach: () => {} });
    h.ctl.noteTurnEnded({ lines: ['  바로 확인하겠습니다.'] });
    port.attach(() => true);
    expect(h.deferred).toHaveLength(1);
    h.deferred[0]!();
    expect(h.calls).toHaveLength(1);
  });

  test('A→B→A: 사람 턴 전까지 이미 이어간 답(A)으로는 다시 열지 않는다', () => {
    const h = harness();
    h.ctl.noteTurnEnded({ lines: ['  A 를 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  B 를 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  A 를 진행하겠습니다.'] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'same-reply' });
    expect(h.calls).toHaveLength(2);
  });
  test('키만 치고 보내지 않은 것으로는 상한·지문이 풀리지 않는다(초기화 = noteHumanTurn 뿐)', () => {
    const h = harness({ cap: 1 });
    h.ctl.noteTurnEnded({ lines: ['  하나를 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    // (사람 키 입력이 있었다고 해도 컨트롤러는 키 시각을 보지 않는다)
    h.ctl.noteTurnEnded({ lines: ['  둘을 진행하겠습니다.'] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'cap' });
    h.ctl.noteTurnEnded({ lines: ['  하나를 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(false);
    h.ctl.noteHumanTurn();
    h.ctl.noteTurnEnded({ lines: ['  하나를 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
  });

  test('next: 이번 턴이 만든 답만 — 무응답 턴은 앞 턴의 약속형 답으로 열지 않는다', () => {
    const before = [
      { role: 'user', content: '영상 만들어줘' },
      { role: 'assistant', content: '렌더를 진행하겠습니다.' },
    ];
    // 이번 턴: 사람 글만 저장되고 답이 없음(오류·무응답)
    const after = [...before, { role: 'user', content: '다시' }];
    expect(replyLinesOfThisTurn(after, before.length)).toEqual([]);
    const h = harness();
    h.ctl.noteTurnEnded({ lines: replyLinesOfThisTurn(after, before.length) });
    expect(h.ctl.check().opened).toBe(false);
    expect(h.calls).toHaveLength(0);
    // 이번 턴에 답이 있으면 그것만 본다
    const withReply = [...after, { role: 'assistant', content: '줄1\n지금 실행하겠습니다.' }];
    expect(replyLinesOfThisTurn(withReply, before.length)).toEqual(['줄1', '지금 실행하겠습니다.']);
  });

  test('next: 자동 압축이 있었던 턴은 «마지막 사람 글 뒤» 답으로 판정한다(길이 기준이 줄어도 놓치지 않음)', () => {
    // 압축 전 12개 → 압축 후 [요약, 이번 턴 사람 글, 이번 턴 답] 3개
    const compacted = [
      { role: 'system', content: '요약: 앞 대화' },
      { role: 'user', content: '영상 만들어줘' },
      { role: 'assistant', content: '이어서 렌더를 진행하겠습니다.' },
    ];
    const startBefore = 12;
    expect(replyLinesOfThisTurn(compacted, startBefore)).toEqual([]);
    expect(replyLinesOfThisTurn(compacted, 'after-last-user')).toEqual(['이어서 렌더를 진행하겠습니다.']);
    const h = harness();
    h.ctl.noteTurnEnded({ lines: replyLinesOfThisTurn(compacted, 'after-last-user') });
    expect(h.ctl.check().opened).toBe(true);
    // 압축 턴인데 이번 턴 답이 없으면(사람 글이 마지막) 열지 않는다
    expect(replyLinesOfThisTurn([...compacted, { role: 'user', content: '다시' }], 'after-last-user')).toEqual([]);
  });
});

