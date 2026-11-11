// 상호작용 시뮬레이터 계약 — ⛔ 라이브로 «판당 3~5분» 걸리던 시나리오를 즉시 재현한다.
import { describe, test, expect } from 'bun:test';
import { simEscGate, simAgentRegistry } from './interaction.js';
import { TURN_ABORT_TURN_ONLY } from '../turn-abort-scope.js';
import { LONG_SHELL_ESC_CONFIRMATION_MS } from '../esc-abort-gate.js';

describe('simEscGate — ESC 게이트를 «자식 N개» 상태로 즉시 세운다', () => {
  test('short Bash stops immediately, while long Bash/RunShell uses the inline default-N confirmation', async () => {
    const short = simEscGate({ shellTool: 'Bash', shellElapsedMs: LONG_SHELL_ESC_CONFIRMATION_MS - (LONG_SHELL_ESC_CONFIRMATION_MS / LONG_SHELL_ESC_CONFIRMATION_MS) });
    short.esc();
    expect(short.abortCtrl.signal.aborted).toBe(true);
    expect(short.inlineLines).toHaveLength(0);

    const keep = simEscGate({ shellTool: 'RunShell', shellElapsedMs: LONG_SHELL_ESC_CONFIRMATION_MS });
    keep.esc();
    expect(keep.inlineLines.join('\n')).toContain('y/n · 기본 n');
    expect(keep.inlineLines.join('\n')).toContain('Stop the long-running shell command?');
    expect(keep.inlineInput('n')).toBe(true);
    await keep.settle();
    expect(keep.abortCtrl.signal.aborted).toBe(false);

    const stop = simEscGate({ shellTool: 'Bash', shellElapsedMs: LONG_SHELL_ESC_CONFIRMATION_MS, inlineAbortScope: 'turn-only' });
    stop.esc();
    expect(stop.inlineInput('y')).toBe(true);
    await stop.settle();
    expect(stop.abortCtrl.signal.aborted).toBe(true);
    expect(stop.abortReason()).toBe(TURN_ABORT_TURN_ONLY);
  });

  test('자식 0 → ESC 가 즉시 중단한다(모달 없음)', () => {
    const s = simEscGate({ runningChildren: 0 });
    s.esc();
    expect(s.abortCtrl.signal.aborted).toBe(true);
    expect(s.isOpen()).toBe(false);
    expect(s.mounted).toHaveLength(0);
  });

  test('⭐ 자식 ≥1 → 모달이 «뜬다» (라이브에선 이 상태를 잡느라 두 번 놓쳤다)', () => {
    const s = simEscGate({ runningChildren: 3 });
    s.esc();
    expect(s.isOpen()).toBe(true);
    expect(s.mounted).toHaveLength(1);
    expect(s.abortCtrl.signal.aborted).toBe(false);
  });

  test('⭐⭐ `A2` — 두 번째 ESC 가 «중단»한다 (철회가 아니다)', async () => {
    const s = simEscGate({ runningChildren: 2 });
    s.esc();
    s.esc();
    await s.settle();
    expect(s.abortCtrl.signal.aborted).toBe(true);
  });

  test('⭐⭐ `A2` — 모달 위 ESC 키(handleKey 경로)도 중단한다', async () => {
    const s = simEscGate({ runningChildren: 2 });
    s.esc();
    expect(s.key('escape')).toBe(true);
    await s.settle();
    expect(s.abortCtrl.signal.aborted).toBe(true);
  });

  test('`n` 은 철회 — 중단하지 않는다', async () => {
    const s = simEscGate({ runningChildren: 2 });
    s.esc();
    s.key('n');
    await s.settle();
    expect(s.abortCtrl.signal.aborted).toBe(false);
  });

  test('⭐⭐ `R1` — 취소의 «뜻»이 turn-only 다 (자식이 안 죽는 근거)', () => {
    const s = simEscGate({ runningChildren: 0 });
    s.esc();
    expect(s.abortReason()).toBe(TURN_ABORT_TURN_ONLY);
  });

  test('⭐⭐ `R4a` — 중단 «전»에 자식 핸드오프가 불린다 (고아 방지)', () => {
    const s = simEscGate({ runningChildren: 0 });
    s.esc();
    expect(s.handoffCalls).toBe(1);
  });

  test('모달 경로에서도 핸드오프가 «중단할 때만» 불린다', async () => {
    const keep = simEscGate({ runningChildren: 2 });
    keep.esc();
    keep.key('n');
    await keep.settle();
    expect(keep.handoffCalls).toBe(0);      // 철회했으면 넘기지 않는다

    const stop = simEscGate({ runningChildren: 2 });
    stop.esc();
    stop.key('y');
    await stop.settle();
    expect(stop.handoffCalls).toBe(1);      // 중단하면 넘긴다
    expect(stop.abortCtrl.signal.aborted).toBe(true);
  });

  test('등록된 AgentRegistry 자식은 입력창 y/N 확인을 열고 N은 계속, y는 중단한다', async () => {
    const keepRegistry = simAgentRegistry({ foreground: 1 });
    const keep = simEscGate({ agentRegistry: keepRegistry, inlineConfirmation: true });
    keep.esc();
    expect(keep.inlineLines.join('\n')).toContain('y/n · 기본 n');
    expect(keep.inlineInput('n')).toBe(true);
    await keep.settle();
    expect(keep.abortCtrl.signal.aborted).toBe(false);

    const stopRegistry = simAgentRegistry({ foreground: 1 });
    const stop = simEscGate({ agentRegistry: stopRegistry, inlineConfirmation: true });
    stop.esc();
    expect(stop.inlineKey('up')).toBe(true);
    expect(stop.inlineLines.join('\n')).toContain('▸ y. Stop');
    expect(stop.inlineInput('y')).toBe(true);
    await stop.settle();
    await stop.settle();
    expect(stop.abortCtrl.signal.aborted).toBe(true);
  });
});

describe('simAgentRegistry — 자식 상태를 숫자로 세운다', () => {
  test('전경/배경/종료를 섞어 세우고 실제 규칙이 그대로 적용된다', () => {
    const reg = simAgentRegistry({ foreground: 2, background: 1, done: 1 });
    const moved = reg.markBackgroundAllRunning();
    expect(moved).toHaveLength(2);            // 전경 둘만 넘어간다
    expect(reg.markBackgroundAllRunning()).toEqual([]);  // 멱등
  });
});
