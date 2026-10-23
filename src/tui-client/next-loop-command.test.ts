import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNextLoopCommand } from './next-loop-command.js';
import type { InternalTurnGate } from '../dashboard/input/internal-turn.js';

describe('Next TUI /loop command', () => {
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

  test('entry tears the timer down on new session, resume, and TUI exit', () => {
    const source = readFileSync(resolve(import.meta.dir, '../tui/entry.ts'), 'utf8');
    expect(source.match(/loopCommand\?\.run\('stop'\)/g)).toHaveLength(2);
    expect(source).toContain('loopCommand?.dispose();');
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
