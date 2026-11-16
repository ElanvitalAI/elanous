import { describe, expect, test } from 'bun:test';
import { createNextLoopCommand, createNextTuiLoopBranch } from './next-loop-command.js';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../tui/core/registry.js';
import type { InternalTurnGate } from '../tui/input/internal-turn.js';

describe('Next TUI /loop command', () => {
  test('session change releases the old gate before a new loop starts', () => {
    const calls: string[] = [];
    const ticks: Array<() => void> = [];
    let cancelled = 0;
    let gate: InternalTurnGate = {
      startTurnIfIdle: (input: string) => {
        calls.push(`old:${input}`);
        return { opened: true, turnId: 'old-turn' };
      },
    } as unknown as InternalTurnGate;
    const branch = createNextTuiLoopBranch(() => gate, () => {}, {
      schedule(callback) {
        ticks.push(callback);
        return { unsubscribe() { cancelled++; } };
      },
    });

    branch.run('/loop 2s old prompt');
    branch.stop(); // entry.ts calls this after /new and /resume.
    expect(cancelled).toBe(1);
    gate = {
      startTurnIfIdle: (input: string) => {
        calls.push(`new:${input}`);
        return { opened: true, turnId: 'new-turn' };
      },
    } as unknown as InternalTurnGate;
    branch.run('/loop 2s new prompt');
    ticks[0]?.();
    ticks[1]?.();
    expect(calls).toEqual(['new:new prompt']);
    branch.dispose();
    expect(cancelled).toBe(2);
  });

  test('registry route owns the branch, which uses the turn gate and stops at session change', () => {
    const route = resolveNextTuiRoute('/loop 2s check mailbox', NEXT_TUI_INPUT_CONTEXT);
    expect(route?.branchHost).toBe('loop');
    expect(route?.branchModule).toBe('../tui-client/next-loop-command.js');
    let tick: (() => void) | undefined;
    let cancelled = false;
    const calls: string[] = [];
    const gate = { startTurnIfIdle: (input: string) => { calls.push(input); return { opened: true, turnId: 'scheduled-1' }; } } as unknown as InternalTurnGate;
    const branch = createNextTuiLoopBranch(() => gate, () => {}, {
      schedule(callback) { tick = callback; return { unsubscribe() { cancelled = true; } }; },
    });
    expect(branch.run('/loop 2s check mailbox')).toEqual(['↻ /loop 시작 — 2초마다: check mailbox']);
    tick?.();
    expect(calls).toEqual(['check mailbox']);
    branch.stop();
    expect(cancelled).toBe(true);
    tick?.();
    expect(calls).toEqual(['check mailbox']);
    branch.dispose();
  });

  test('fake clock retries while human input owns the turn, then fires once and stops', () => {
    let tick: (() => void) | undefined;
    let unsubscribed = false;
    let humanInputPending = true;
    const calls: Array<{ input: string; opts: { origin: string; reason?: string } }> = [];
    const events: string[] = [];
    const gate = {
      startTurnIfIdle(input: string, opts: { origin: string; reason?: string }) {
        calls.push({ input, opts });
        if (humanInputPending) return { opened: false, reason: 'HumanTyping' };
        return { opened: true, turnId: 'auto-1' };
      },
    } as unknown as InternalTurnGate;
    const command = createNextLoopCommand(gate, (event) => events.push(event), {
      schedule(callback, intervalMs) {
        expect(intervalMs).toBe(2_000);
        tick = callback;
        return { unsubscribe: () => { unsubscribed = true; } };
      },
    });

    expect(command.run('2s check mailbox')).toEqual(['↻ /loop 시작 — 2초마다: check mailbox']);
    tick?.();
    expect(calls).toHaveLength(1);
    expect(events).toEqual(['rejected']);
    humanInputPending = false;
    tick?.();
    expect(calls).toEqual([
      { input: 'check mailbox', opts: { origin: 'scheduled', reason: '/loop' } },
      { input: 'check mailbox', opts: { origin: 'scheduled', reason: '/loop' } },
    ]);
    expect(events).toEqual(['rejected', 'fired']);
    expect(command.run('stop')).toEqual(['⏹ /loop 정지 — 더 이상 발사하지 않습니다']);
    expect(unsubscribed).toBe(true);
    tick?.();
    expect(calls).toHaveLength(2);
    command.dispose();
  });

  test('rejects malformed interval or missing prompt without arming a timer', () => {
    let scheduled = false;
    const gate = { startTurnIfIdle: () => ({ opened: false, reason: 'Disabled' }) } as unknown as InternalTurnGate;
    const command = createNextLoopCommand(gate, () => {}, {
      schedule: () => { scheduled = true; return { unsubscribe() {} }; },
    });
    expect(command.run('500ms prompt')).toEqual(['사용법: /loop <간격> <프롬프트> · /loop stop']);
    expect(command.run('1000000h prompt')).toEqual(['사용법: /loop <간격> <프롬프트> · /loop stop']);
    expect(command.run('1s')).toEqual(['사용법: /loop <간격> <프롬프트> · /loop stop']);
    expect(scheduled).toBe(false);
    expect(command.run('stop')).toEqual(['/loop: 실행 중인 루프가 없습니다']);
  });
});
