import { describe, expect, test } from 'bun:test';
import { muteConsoleWhileTui } from './tui.js';

describe('TUI-CONSOLE-ERROR-LEAK', () => {
  test('console.error and console.warn never reach the terminal while the TUI owns it, and are restored after', () => {
    let wrote = 0;
    const target = { error: () => { wrote++; }, warn: () => { wrote++; } } as Pick<Console, 'error' | 'warn'>;
    const restore = muteConsoleWhileTui(target);
    target.error('[outbound] 토큰/chat 미설정 — 콘솔 출력');
    target.warn('🔄 Codex account rotated');
    expect(wrote).toBe(0);
    restore();
    target.error('after');
    expect(wrote).toBe(1);
  });
});
